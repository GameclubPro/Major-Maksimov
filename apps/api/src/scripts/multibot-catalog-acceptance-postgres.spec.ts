import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CatalogExpectedEvent, evaluateCatalogOutcomes } from './multibot-catalog-acceptance';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;

type CatalogCliOutput = {
  transport: string;
  tokenQuota: { perTokenRps: number; globalBurst: number };
  fixtureTopology: { processes: number; outboxSelection: string; nativeMedia: boolean };
  reports: Array<{
    status: string;
    correctnessStatus: string;
    logicalMessages: number;
    receipts: number;
    unexpectedDeletions: number;
    unexpectedMutations: number;
    wrongExecutorEffects: number;
    finalPendingReceipts: number;
    finalPendingActions: number;
    remoteDeletes: number;
    manifest: { events: CatalogExpectedEvent[] };
    outcomeAcceptance: ReturnType<typeof evaluateCatalogOutcomes>;
  }>;
};

describeStores('native multibot catalog CLI proof collection', () => {
  it('confirms both DELETE and KEEP in hot and quiet cohorts through real stores', async () => {
    const postgres = new URL(databaseUrl);
    const redis = new URL(redisUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(postgres.hostname) ||
      !postgres.pathname.includes('race_test') ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname)
    )
      throw new Error(
        'Catalog CLI regression requires disposable local PostgreSQL race_test and Redis',
      );

    const directory = await mkdtemp(join(tmpdir(), 'maxim-catalog-acceptance-'));
    const output = join(directory, 'report.json');
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let deadlineExpired = false;
    let diagnostics = '';
    try {
      // FLAG: Public Jest validation already owns codegen and its lock. Run the CLI
      // directly here; a nested public npm wrapper would wait on that same lock.
      // Pass only disposable store URLs, never inherited MAX credentials or env files.
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve(__dirname, 'loadtest-multibot-catalog.ts'),
          '--chats=10',
          '--bots=3',
          '--messages=30',
          '--rate=5',
          '--routing=fixed',
          '--enqueue=production',
          '--topology=single',
          '--profiles=mixed',
          '--quota=25',
          '--violations=50',
          `--output=${output}`,
        ],
        {
          cwd: resolve(__dirname, '../..'),
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            TZ: 'UTC',
            MAXIM_TEST_POSTGRES_URL: databaseUrl,
            MAXIM_TEST_REDIS_URL: redisUrl,
            PRISMA_PG_POOL_MAX: '24',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout?.resume();
      child.stderr?.on('data', (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-8192);
      });
      const running = child;
      closed = new Promise((resolveExit, reject) => {
        running.once('error', reject);
        running.once('close', (code, signal) => resolveExit({ code, signal }));
      });
      timer = setTimeout(() => {
        deadlineExpired = true;
        running.kill('SIGKILL');
      }, 90_000);
      const exit = await closed;
      clearTimeout(timer);
      if (deadlineExpired || exit.code !== 0 || exit.signal !== null)
        throw new Error(
          `Catalog CLI failed: deadlineExpired=${deadlineExpired}, code=${exit.code}, signal=${exit.signal}\n${diagnostics}`,
        );

      const result = JSON.parse(await readFile(output, 'utf8')) as CatalogCliOutput;
      expect(result.transport).toContain('local simulated MAX');
      expect(result.transport).toContain('no external requests');
      expect(result.tokenQuota).toEqual({ perTokenRps: 25, globalBurst: 0 });
      expect(result.fixtureTopology).toMatchObject({
        processes: 1,
        outboxSelection: 'production enqueueBatch',
        nativeMedia: false,
      });
      expect(result.reports).toHaveLength(1);
      const report = result.reports[0]!;
      expect(report).toMatchObject({
        status: 'passed',
        correctnessStatus: 'passed',
        logicalMessages: 30,
        receipts: 90,
        unexpectedDeletions: 0,
        unexpectedMutations: 0,
        wrongExecutorEffects: 0,
        finalPendingReceipts: 0,
        finalPendingActions: 0,
      });
      expect(report.manifest.events).toHaveLength(30);
      expect(report.outcomeAcceptance).toMatchObject({
        status: 'passed',
        correctnessStatus: 'passed',
      });
      for (const name of ['hot', 'quiet'] as const) {
        const expected = report.manifest.events.filter((event) => event.cohort === name);
        const deletes = expected.filter((event) => event.decision === 'DELETE').length;
        const keeps = expected.filter((event) => event.decision === 'KEEP').length;
        expect(deletes).toBeGreaterThan(0);
        expect(keeps).toBeGreaterThan(0);
        const cohort = report.outcomeAcceptance.cohorts.find((entry) => entry.cohort === name);
        expect(cohort).toMatchObject({
          expectedEvents: expected.length,
          submittedEvents: expected.length,
          expectedDeletes: deletes,
          expectedKeeps: keeps,
          confirmedDeletes: deletes,
          confirmedKeeps: keeps,
          expectedReceipts: expected.length * 3,
          observedReceipts: expected.length * 3,
          incompleteEvents: 0,
          missingReceipts: 0,
          duplicateMirrorReceipts: 0,
          unexpectedMirrorReceipts: 0,
          invalidIngressEvents: 0,
          quarantinedReceipts: 0,
          expiredReceipts: 0,
          failedReceipts: 0,
          unfinishedReceipts: 0,
          unknownEffectEvents: 0,
          wrongExecutorEvents: 0,
          wrongTargetEvents: 0,
          duplicateEffectEvents: 0,
          unexpectedDeleteEvents: 0,
          outcomeLatency: {
            expectedSamples: expected.length,
            samples: expected.length,
            invalidClocks: 0,
            complete: true,
          },
          deleteLatency: {
            expectedSamples: deletes,
            samples: deletes,
            invalidClocks: 0,
            complete: true,
          },
        });
      }
      expect(report.remoteDeletes).toBe(
        report.manifest.events.filter((event) => event.decision === 'DELETE').length,
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
