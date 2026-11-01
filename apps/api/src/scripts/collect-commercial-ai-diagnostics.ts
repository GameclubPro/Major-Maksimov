import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { config as loadEnv } from 'dotenv';
import { createPrismaClient, type Prisma } from '../prisma/prisma-client';
import { resolveCommercialAuditPrismaPoolConfig } from './commercial-audit-scan-window';
import { withCommercialAuditRunLock } from './commercial-audit-run-lock.util';
import {
  analyzeCommercialAiQualityEvidence,
  commercialAiQualityEvidenceSchema,
} from './commercial-ai-quality-report';
import {
  AI_DIAGNOSTIC_BYTE_CAP,
  AI_DIAGNOSTIC_DEADLINE_MS,
  buildAiDiagnosticExplainSql,
  buildAiDiagnosticPageSql,
  buildAiOwnReceiptSql,
  collectAiDiagnosticEvidence,
  commercialAiDiagnosticOptionsSchema,
  type AiDiagnosticOptions,
  type AiDiagnosticProgress,
  type AiDiagnosticRow,
  type AiOwnReceiptRow,
} from './commercial-ai-diagnostic-export';

export function readAiDiagnosticArguments(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      'output-dir': { type: 'string' },
      'page-size': { type: 'string' },
      'max-rows': { type: 'string' },
      'max-bytes': { type: 'string' },
      explain: { type: 'boolean', default: false },
    },
  });
  const integer = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/u.test(value)) throw new Error('Invalid bounded diagnostic argument');
    return Number(value);
  };
  if (!values['output-dir'] || !isAbsolute(values['output-dir']))
    throw new Error('An absolute new private output directory is required');
  const options = commercialAiDiagnosticOptionsSchema.parse({
    since: values.since,
    until: values.until,
    pageSize: integer(values['page-size'], 100),
    maxRows: integer(values['max-rows'], 5000),
    maxBytes: integer(values['max-bytes'], AI_DIAGNOSTIC_BYTE_CAP),
  });
  return { options, outputDir: resolve(values['output-dir']), explain: values.explain === true };
}

export function assertAiDiagnosticAdminRole(
  env: Partial<Pick<NodeJS.ProcessEnv, 'APP_ROLE' | 'APP_SERVICE_NAME'>>,
) {
  if (!env.APP_ROLE && !env.APP_SERVICE_NAME) return;
  if (env.APP_ROLE !== 'admin' || env.APP_SERVICE_NAME !== 'api-admin')
    throw new Error('Private diagnostic collection requires the admin role and api-admin service');
}

// FLAG: Resolve the actual source/runtime module layout; cwd cannot establish an output boundary.
export async function findAiDiagnosticWorkspace(moduleDirectory = __dirname): Promise<string> {
  const moduleReal = await realpath(moduleDirectory);
  for (const layout of [
    ['apps', 'api', 'dist', 'apps', 'api', 'src', 'scripts'],
    ['apps', 'api', 'src', 'scripts'],
  ]) {
    const root = resolve(moduleReal, ...layout.map(() => '..'));
    if (relative(root, moduleReal) !== layout.join(sep)) continue;
    try {
      const names = await Promise.all(
        ['apps/api/package.json', 'packages/contracts/package.json'].map(async (path) => {
          const file = resolve(root, path);
          if ((await realpath(file)) !== file) return null;
          return (JSON.parse(await readFile(file, 'utf8')) as { name?: unknown }).name;
        }),
      );
      if (names[0] === '@maxim/api' && names[1] === '@maxim/contracts') return root;
    } catch {
      /* Missing workspace markers fail closed. */
    }
  }
  throw new Error('Diagnostic workspace identity is unavailable');
}

export async function createAiDiagnosticDirectory(outputDir: string, repositoryRoot: string) {
  if (!isAbsolute(outputDir)) throw new Error('Private diagnostic path must be absolute');
  const parent = await realpath(dirname(outputDir));
  const root = await realpath(repositoryRoot);
  const child = relative(root, parent);
  if (!child || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child)))
    throw new Error('Private diagnostics must remain outside the workspace');
  for (let current = parent; ; current = dirname(current)) {
    try {
      await lstat(join(current, '.git'));
      throw new Error('Private diagnostics must remain outside Git');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) break;
  }
  const destination = join(parent, basename(outputDir));
  await mkdir(destination, { mode: 0o700 });
  const info = await lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error('Private diagnostic directory permissions are invalid');
  return destination;
}

type OutputState = {
  handle: FileHandle;
  hash: ReturnType<typeof createHash>;
  bytes: number;
  records: number;
};

export async function writeAiDiagnosticPlans(params: {
  options: AiDiagnosticOptions;
  outputDir: string;
  repositoryRoot: string;
  explain(sql: Prisma.Sql): Promise<unknown>;
  assertHeld(): void;
  now?(): number;
}) {
  const options = commercialAiDiagnosticOptionsSchema.parse(params.options);
  const now = params.now ?? Date.now;
  const started = now(),
    deadline = started + AI_DIAGNOSTIC_DEADLINE_MS;
  if (Date.parse(options.until) > started)
    throw new Error('Diagnostic window must already be closed');
  const destination = await createAiDiagnosticDirectory(params.outputDir, params.repositoryRoot);
  const statePath = join(destination, 'run-state.json');
  const planPath = join(destination, 'query-plans.private.json');
  let lastSuccessfulSampleAt: string | null = null;
  const state = (status: string) =>
    `${JSON.stringify({ status, mode: 'PLAIN_EXPLAIN', startedAt: new Date(started).toISOString(), heartbeatAt: new Date(now()).toISOString(), lastSuccessfulSampleAt, sourceRowsRead: 0 })}\n`;
  await writeFile(statePath, state('RUNNING'), { flag: 'wx', mode: 0o600 });
  try {
    const plans: { name: string; plan: unknown }[] = [];
    for (const template of buildAiDiagnosticExplainSql(options)) {
      params.assertHeld();
      if (now() >= deadline) throw new Error('Diagnostic plan deadline exceeded');
      plans.push({ name: template.name, plan: await params.explain(template.sql) });
      params.assertHeld();
      lastSuccessfulSampleAt = new Date(now()).toISOString();
      await writeFile(statePath, state('RUNNING'), { flag: 'w', mode: 0o600 });
    }
    const result = {
      schemaVersion: 'commercial-ai-diagnostic-plans/v1',
      mode: 'PLAIN_EXPLAIN',
      since: options.since,
      until: options.until,
      sourceRowsRead: 0,
      actualSourceIdentifiersUsed: false,
      receiptTemplateUsesSyntheticPlaceholders: true,
      plans,
    };
    const text = `${JSON.stringify(result, null, 2)}\n`;
    const finalState = state('COMPLETE');
    if (
      Buffer.byteLength(text) + Buffer.byteLength(finalState) > options.maxBytes ||
      now() >= deadline
    )
      throw new Error('Diagnostic plan budget exceeded');
    await writeFile(`${planPath}.partial`, text, { flag: 'wx', mode: 0o600 });
    params.assertHeld();
    await rename(`${planPath}.partial`, planPath);
    await writeFile(statePath, finalState, { flag: 'w', mode: 0o600 });
    return result;
  } catch {
    for (const path of [planPath, `${planPath}.partial`])
      try {
        await unlink(path);
      } catch {
        /* Owned run only. */
      }
    await writeFile(statePath, state('FAILED'), { flag: 'w', mode: 0o600 });
    throw new Error('Private diagnostic plan collection failed');
  }
}

export async function writeAiDiagnosticCollection(params: {
  options: AiDiagnosticOptions;
  outputDir: string;
  repositoryRoot: string;
  loadPage: Parameters<typeof collectAiDiagnosticEvidence>[1]['loadPage'];
  loadOwnReceipts: Parameters<typeof collectAiDiagnosticEvidence>[1]['loadOwnReceipts'];
  assertHeld(): void;
  now?(): number;
}) {
  const options = commercialAiDiagnosticOptionsSchema.parse(params.options);
  if (Date.parse(options.until) > (params.now ?? Date.now)())
    throw new Error('Diagnostic window must already be closed');
  const destination = await createAiDiagnosticDirectory(params.outputDir, params.repositoryRoot);
  const names = {
    sources: 'blind-sources.jsonl',
    linkage: 'linkage.private.jsonl',
    receipts: 'own-receipts.private.jsonl',
  };
  const outputs = new Map<keyof typeof names, OutputState>();
  const created: string[] = [];
  const progressPath = join(destination, 'run-state.json');
  const progressState: { latest: Partial<AiDiagnosticProgress> } = { latest: {} };
  const create = async (name: string, text: string) => {
    const path = join(destination, `${name}.partial`);
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
    created.push(path);
    return {
      path,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(text),
    };
  };
  try {
    for (const kind of Object.keys(names) as (keyof typeof names)[]) {
      const path = join(destination, `${names[kind]}.partial`);
      const handle = await open(path, 'wx', 0o600);
      created.push(path);
      outputs.set(kind, { handle, hash: createHash('sha256'), bytes: 0, records: 0 });
    }
    const result = await collectAiDiagnosticEvidence(params.options, {
      loadPage: params.loadPage,
      loadOwnReceipts: params.loadOwnReceipts,
      assertHeld: params.assertHeld,
      ...(params.now ? { now: params.now } : {}),
      async append(kind, value) {
        params.assertHeld();
        const output = outputs.get(kind)!;
        const line = `${JSON.stringify(value)}\n`;
        await output.handle.writeFile(line, 'utf8');
        output.hash.update(line, 'utf8');
        output.bytes += Buffer.byteLength(line);
        output.records++;
      },
      async progress(value) {
        progressState.latest = value;
        const text = `${JSON.stringify({ status: 'RUNNING', ...value })}\n`;
        await writeFile(progressPath, text, {
          flag: created.includes(progressPath) ? 'w' : 'wx',
          mode: 0o600,
        });
        if (!created.includes(progressPath)) created.push(progressPath);
      },
    });
    const evidence = commercialAiQualityEvidenceSchema.parse(result.evidence);
    const report = analyzeCommercialAiQualityEvidence(evidence);
    const evidenceFile = await create('evidence.private.json', `${JSON.stringify(evidence)}\n`);
    const reportFile = await create('report.private.json', `${JSON.stringify(report, null, 2)}\n`);
    const files: Record<string, { sha256: string; bytes: number; records?: number }> = {};
    for (const [kind, output] of outputs) {
      await output.handle.sync();
      await output.handle.close();
      files[names[kind]] = {
        sha256: output.hash.digest('hex'),
        bytes: output.bytes,
        records: output.records,
      };
    }
    files['evidence.private.json'] = { sha256: evidenceFile.sha256, bytes: evidenceFile.bytes };
    files['report.private.json'] = { sha256: reportFile.sha256, bytes: reportFile.bytes };
    const finalState = `${JSON.stringify({ status: result.manifest.stop, ...progressState.latest, finishedAt: result.manifest.finishedAt })}\n`;
    files['run-state.json'] = {
      sha256: createHash('sha256').update(finalState, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(finalState),
    };
    const manifest = {
      ...result.manifest,
      files,
      payloadBytes: result.manifest.bytes,
      bytes: 0,
      maxBytes: params.options.maxBytes,
      byteCapIncludesAllPublishedFiles: true,
      sourceTextAndPredictionsStoredSeparately: true,
      blindReferencesMustFreezeBeforeOpeningPredictionFiles: true,
      ownReceiptsAreDiagnosticDatabaseProofs: true,
      ownReceiptFile: names.receipts,
    };
    const dataBytes = Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
    let manifestText = '';
    for (let iteration = 0; iteration < 8; iteration++) {
      manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      const total = dataBytes + Buffer.byteLength(manifestText);
      if (manifest.bytes === total) break;
      manifest.bytes = total;
    }
    manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    if (
      dataBytes + Buffer.byteLength(manifestText) !== manifest.bytes ||
      manifest.bytes > params.options.maxBytes
    )
      throw new Error('Private diagnostic artifact byte cap exceeded');
    await create('manifest.private.json', manifestText);
    params.assertHeld();
    // FLAG: Publish only after all bounded reads, privacy checks, hashes and lock checks succeed.
    for (const path of created.filter((path) => path.endsWith('.partial')))
      await rename(path, path.slice(0, -'.partial'.length));
    await writeFile(progressPath, finalState, { flag: 'w', mode: 0o600 });
    return manifest;
  } catch {
    for (const output of outputs.values()) {
      try {
        await output.handle.close();
      } catch {
        /* Already closed. */
      }
    }
    // Files belong only to this newly created run. Failed collections publish no source/prediction pack.
    for (const path of created.filter((path) => path !== progressPath)) {
      for (const candidate of [
        path,
        path.endsWith('.partial') ? path.slice(0, -'.partial'.length) : path,
      ])
        try {
          await unlink(candidate);
        } catch {
          /* Preserve a generic failed state if cleanup is incomplete. */
        }
    }
    try {
      await writeFile(
        progressPath,
        `${JSON.stringify({ status: 'FAILED', ...progressState.latest })}\n`,
        {
          flag: created.includes(progressPath) ? 'w' : 'wx',
          mode: 0o600,
        },
      );
    } catch {
      /* Do not disclose private errors. */
    }
    throw new Error(
      'Private diagnostic collection failed; source and prediction packs were not published',
    );
  }
}

export async function runAiDiagnosticCollector(argv: readonly string[]) {
  const { options, outputDir, explain } = readAiDiagnosticArguments(argv);
  if (Date.parse(options.until) > Date.now())
    throw new Error('Diagnostic window must already be closed');
  loadEnv({ quiet: true });
  loadEnv({ path: resolve(__dirname, '../../../../.env'), override: false, quiet: true });
  assertAiDiagnosticAdminRole(process.env);
  const repositoryRoot = await findAiDiagnosticWorkspace();
  const prisma = createPrismaClient(undefined, resolveCommercialAuditPrismaPoolConfig());
  try {
    return await withCommercialAuditRunLock(async (lock) => {
      const read = <Row>(sql: Parameters<typeof prisma.$queryRaw>[0]) =>
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
            await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
            return tx.$queryRaw<Row[]>(sql);
          },
          { timeout: 15_000 },
        );
      if (explain) {
        const result = await writeAiDiagnosticPlans({
          options,
          outputDir,
          repositoryRoot,
          assertHeld: () => lock.assertHeld(),
          explain: (sql) => read<unknown>(sql),
        });
        process.stdout.write(
          'Diagnostic query plans saved; source rows read: 0; collection not executed.\n',
        );
        return result;
      }
      const manifest = await writeAiDiagnosticCollection({
        options,
        outputDir,
        repositoryRoot,
        assertHeld: () => lock.assertHeld(),
        loadPage: (page) => read<AiDiagnosticRow>(buildAiDiagnosticPageSql(page)),
        loadOwnReceipts: (requests) => read<AiOwnReceiptRow>(buildAiOwnReceiptSql(requests)),
      });
      process.stdout.write(
        `Diagnostic captured rows: ${manifest.capturedRows}; complete: ${manifest.complete}; own database receipts: ${manifest.ownReceiptsVerified}; human labels: 0; promotion: false\n`,
      );
      return manifest;
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  runAiDiagnosticCollector(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      'Commercial AI private collection failed; verify bounded arguments and private output location.\n',
    );
    process.exitCode = 1;
  });
