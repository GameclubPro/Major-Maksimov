import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const scale = process.env.MAXIM_TEST_GIVEAWAY_MIGRATION_SCALE;
if (scale !== undefined && scale !== 'large')
  throw new Error('Giveaway migration scale must be absent or large');
const large = scale === 'large';
const native = databaseUrl ? describe : describe.skip;
const root = resolve(__dirname, '../../../..');
const migrationRoot = resolve(root, 'apps/api/prisma/migrations');
const productionSizeBound = 898_768_896;
const targets = [
  {
    name: '20261111011410_index_managed_giveaway_due_start',
    index: 'managed_giveaways_status_starts_at_id_idx',
    column: 'starts_at',
    family: 'start',
  },
  {
    name: '20261111011411_index_managed_giveaway_due_end',
    index: 'managed_giveaways_status_ends_at_id_idx',
    column: 'ends_at',
    family: 'end',
  },
] as const;
type Target = (typeof targets)[number];
type MigrationResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnFailed: boolean;
  p3009: boolean;
  elapsedMs: number;
};
type RunningMigration = {
  child: ChildProcess;
  done: Promise<MigrationResult>;
  result?: MigrationResult;
  terminate: () => void;
};
type Receipt = {
  id: string;
  name: string;
  checksum: string;
  startedAt: Date;
  finishedAt: Date | null;
  rolledBackAt: Date | null;
  steps: number;
};
type IndexState = {
  oid: string;
  name: string;
  schema: string;
  table: string;
  method: string;
  valid: boolean;
  ready: boolean;
  live: boolean;
  unique: boolean;
  primary: boolean;
  keyCount: number;
  attributeCount: number;
  noPredicate: boolean;
  noExpression: boolean;
  options: string;
  keys: string[];
  definition: string;
};
type FixtureSize = {
  rows: number;
  heapBytes: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  toastBytes: number;
};
type DatabaseFixture = {
  control: Client;
  blocker: Client;
  writer: Client;
  blockerPid: number;
  prefix: { tempRoot: string; migrationsPath: string; configPath: string };
  connect: (tag: string) => Promise<Client>;
  launch: (tag: string) => RunningMigration;
  addTarget: (target: Target) => void;
};

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sourceSql = (target: Target) =>
  readFileSync(resolve(migrationRoot, target.name, 'migration.sql'), 'utf8');
const seedId = (row: number) => createHash('md5').update(`giveaway:${row}`).digest('hex');

async function waitFor(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}

function createPrefix() {
  const names = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name < targets[0].name)
    .sort();
  expect(names.length).toBeGreaterThan(0);
  for (const target of targets) expect(sourceSql(target)).toContain('CREATE INDEX CONCURRENTLY');
  const parent = resolve(root, 'apps/api/.migration-prepare');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tempRoot = mkdtempSync(resolve(parent, 'giveaway-native-'));
  try {
    const migrationsPath = resolve(tempRoot, 'migrations');
    mkdirSync(migrationsPath, { mode: 0o700 });
    cpSync(
      resolve(migrationRoot, 'migration_lock.toml'),
      resolve(migrationsPath, 'migration_lock.toml'),
    );
    // FLAG: Only copied disposable prefixes change. Real Prisma deploy creates every
    // receipt; the test never inserts, resolves or repairs migration history.
    for (const name of names)
      cpSync(resolve(migrationRoot, name), resolve(migrationsPath, name), { recursive: true });
    const configPath = resolve(tempRoot, 'prisma.config.ts');
    writeFileSync(
      configPath,
      `import { defineConfig, env } from 'prisma/config';
export default defineConfig({
  schema: ${JSON.stringify(resolve(root, 'apps/api/prisma/schema.prisma'))},
  migrations: { path: ${JSON.stringify(migrationsPath)} },
  datasource: { url: env('DATABASE_URL') },
});
`,
      { mode: 0o600 },
    );
    return { tempRoot, migrationsPath, configPath, names };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function launchPrisma(url: string, configPath: string, tag: string): RunningMigration {
  const address = new URL(url);
  if (
    address.searchParams.has('application_name') ||
    address.searchParams.getAll('options').some((value) => /application_name/iu.test(value))
  )
    throw new Error('Disposable migration URL must have no conflicting session tag');
  // FLAG: Cancellation is restricted to this invocation's exact tagged session in
  // its owned disposable database, never another migration or the parent store.
  const taggedUrl = `${url}${address.search || url.endsWith('?') ? '&' : '?'}application_name=${tag}`;
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      configPath,
    ],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: taggedUrl, TZ: 'UTC' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let timedOut = false;
  let p3009 = false;
  let tail = '';
  const observe = (chunk: Buffer) => {
    const observed = `${tail}${chunk.toString('utf8')}`;
    p3009 ||= observed.includes('P3009');
    tail = observed.slice(-8);
  };
  child.stdout?.on('data', observe);
  child.stderr?.on('data', observe);
  const terminate = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let finish!: (result: MigrationResult) => void;
  const done = new Promise<MigrationResult>((resolveResult) => {
    finish = resolveResult;
  });
  const running: RunningMigration = { child, done, terminate };
  const complete = (code: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean) => {
    if (running.result) return;
    clearTimeout(timer);
    running.result = {
      code,
      signal,
      timedOut,
      spawnFailed,
      p3009,
      elapsedMs: Date.now() - started,
    };
    finish(running.result);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      terminate();
    } catch {
      complete(null, null, true);
    }
  }, 120_000);
  child.once('error', () => complete(null, null, true));
  child.once('close', (code, signal) => complete(code, signal, false));
  return running;
}

async function receipts(client: Client, names: readonly string[]) {
  const result = await client.query<Receipt>(
    `
    SELECT id, migration_name AS name, checksum, started_at AS "startedAt",
      finished_at AS "finishedAt", rolled_back_at AS "rolledBackAt", applied_steps_count AS steps
    FROM public._prisma_migrations WHERE migration_name = ANY($1::text[])
    ORDER BY migration_name, id`,
    [names],
  );
  return result.rows;
}

async function assertApplied(client: Client, target: Target) {
  const rows = await receipts(client, [target.name]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    name: target.name,
    checksum: checksum(sourceSql(target)),
    rolledBackAt: null,
    steps: 1,
  });
  expect(rows[0]!.startedAt).toBeInstanceOf(Date);
  expect(rows[0]!.finishedAt).toBeInstanceOf(Date);
}

async function indexes(client: Client) {
  const result = await client.query<IndexState>(`
    SELECT i.indexrelid::text AS oid, c.relname AS name, n.nspname AS schema,
      t.relname AS table, am.amname AS method, i.indisvalid AS valid,
      i.indisready AS ready, i.indislive AS live, i.indisunique AS unique,
      i.indisprimary AS primary, i.indnkeyatts AS "keyCount", i.indnatts AS "attributeCount",
      i.indpred IS NULL AS "noPredicate", i.indexprs IS NULL AS "noExpression",
      i.indoption::text AS options,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum, position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.position) AS keys,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_am am ON am.oid=c.relam
    WHERE i.indrelid='public.managed_giveaways'::regclass ORDER BY c.relname`);
  return result.rows;
}

function assertTargetIndex(all: IndexState[], target: Target, valid: boolean) {
  const index = all.find((entry) => entry.name === target.index);
  expect(index).toBeDefined();
  expect(index).toMatchObject({
    schema: 'public',
    table: 'managed_giveaways',
    method: 'btree',
    valid,
    live: true,
    unique: false,
    primary: false,
    keyCount: 3,
    attributeCount: 3,
    noPredicate: true,
    noExpression: true,
    options: '0 0 0',
    keys: ['status', target.column, 'id'],
    definition: `CREATE INDEX ${target.index} ON public.managed_giveaways USING btree (status, ${target.column}, id)`,
  });
  if (valid) expect(index!.ready).toBe(true);
  return index!;
}

async function withDatabase(run: (fixture: DatabaseFixture) => Promise<void>) {
  const owner = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 15_000,
    options: '-c statement_timeout=10000 -c timezone=UTC',
  });
  owner.on('error', () => {});
  const database = `giveaway_migration_${randomUUID().replaceAll('-', '')}`;
  const address = new URL(databaseUrl);
  address.pathname = `/${database}`;
  const clients: Client[] = [];
  const children: RunningMigration[] = [];
  const errors: unknown[] = [];
  let prefix: ReturnType<typeof createPrefix> | undefined;
  let created = false;
  let ownerConnected = false;
  const cleanup = async (action: () => unknown | Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    await owner.connect();
    ownerConnected = true;
    await owner.query(`CREATE DATABASE "${database}"`);
    created = true;
    const connect = async (tag: string) => {
      const client = new Client({
        connectionString: address.href,
        application_name: tag,
        connectionTimeoutMillis: 5000,
        query_timeout: 180_000,
        options: '-c statement_timeout=180000 -c lock_timeout=2000 -c timezone=UTC',
      });
      client.on('error', () => {});
      clients.push(client);
      await client.connect();
      return client;
    };
    const control = await connect('giveaway-migration-observer');
    const blocker = await connect('giveaway-migration-blocker');
    const writer = await connect('giveaway-migration-writer');
    const actual = await control.query<{ version: string; timezone: string }>(
      "SELECT version() AS version, current_setting('TimeZone') AS timezone",
    );
    expect(actual.rows[0]!.version).toMatch(/^PostgreSQL 16\./u);
    expect(actual.rows[0]!.timezone).toBe('UTC');
    prefix = createPrefix();
    const selectedPrefix = prefix;
    const launch = (tag: string) => {
      const child = launchPrisma(address.href, selectedPrefix.configPath, tag);
      children.push(child);
      return child;
    };
    expect(await launch(`giveaway-bootstrap-${randomUUID()}`).done).toMatchObject({
      code: 0,
      signal: null,
      timedOut: false,
      spawnFailed: false,
    });
    const prerequisites = await receipts(control, prefix.names);
    expect(prerequisites).toHaveLength(prefix.names.length);
    for (let i = 0; i < prefix.names.length; i++) {
      const name = prefix.names[i]!;
      expect(prerequisites[i]).toMatchObject({
        name,
        checksum: checksum(readFileSync(resolve(migrationRoot, name, 'migration.sql'), 'utf8')),
        rolledBackAt: null,
        steps: 1,
      });
      expect(prerequisites[i]!.finishedAt).toBeInstanceOf(Date);
    }
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid;
    await control.query(
      "INSERT INTO chats(id,title,updated_at) VALUES ('giveaway-migration-fixture','fixture',now())",
    );
    await run({
      control,
      blocker,
      writer,
      blockerPid,
      prefix,
      connect,
      launch,
      addTarget: (target) =>
        cpSync(
          resolve(migrationRoot, target.name),
          resolve(selectedPrefix.migrationsPath, target.name),
          { recursive: true },
        ),
    });
  } catch (error) {
    errors.push(error);
  } finally {
    // FLAG: Preserve the primary failure and attempt every owned cleanup, even if
    // process termination, a disconnected client or another cleanup fails.
    for (const child of children)
      if (
        !child.result ||
        (child.child.pid && child.child.exitCode === null && child.child.signalCode === null)
      ) {
        await cleanup(() => child.terminate());
        await cleanup(async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              child.done,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Owned migration child did not stop')),
                  5000,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        });
      }
    for (const client of clients.reverse()) await cleanup(() => client.end());
    if (created) await cleanup(() => owner.query(`DROP DATABASE "${database}" WITH (FORCE)`));
    if (ownerConnected) await cleanup(() => owner.end());
    if (prefix) await cleanup(() => rmSync(prefix!.tempRoot, { recursive: true, force: true }));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Giveaway migration test or cleanup failed', {
      cause: errors[0],
    });
}

async function seed(client: Client, first: number, last: number) {
  await client.query(
    `INSERT INTO managed_giveaways(
    id,source_chat_id,actor_user_id,title,description,status,starts_at,ends_at,created_at,updated_at)
    SELECT md5('giveaway:'||n::text),'giveaway-migration-fixture','fixture-admin',md5('title:'||n::text),
      md5(n::text||':1')||md5(n::text||':2')||md5(n::text||':3')||
        md5(n::text||':4')||md5(n::text||':5')||md5(n::text||':6'),
      (CASE WHEN n%1000=0 THEN 'SCHEDULED' WHEN n%1000=1 THEN 'ACTIVE'
        WHEN n%1000=2 THEN 'DRAWING' WHEN n%2=0 THEN 'COMPLETED' ELSE 'CANCELED' END)::"ManagedGiveawayStatus",
      TIMESTAMP '2026-01-01 00:00:00'+((n*7919)%10000)*interval '1 second',
      TIMESTAMP '2026-01-02 00:00:00'+((n*3571)%10000)*interval '1 second',
      TIMESTAMP '2025-12-01 00:00:00',TIMESTAMP '2026-01-02 00:00:00'
    FROM generate_series($1::bigint,$2::bigint) n`,
    [first, last],
  );
}

async function size(client: Client): Promise<FixtureSize> {
  const result = await client.query<FixtureSize>(`SELECT
    (SELECT count(*)::int FROM public.managed_giveaways) AS rows,
    pg_relation_size(c.oid)::float8 AS "heapBytes", pg_table_size(c.oid)::float8 AS "tableBytes",
    pg_indexes_size(c.oid)::float8 AS "indexBytes", pg_total_relation_size(c.oid)::float8 AS "totalBytes",
    CASE WHEN c.reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END::float8 AS "toastBytes"
    FROM pg_class c WHERE c.oid='public.managed_giveaways'::regclass`);
  return result.rows[0]!;
}

async function waitForBlockedBuild(f: DatabaseFixture, tag: string, target: Target) {
  let pid: number | undefined;
  await waitFor(async () => {
    const result = await f.control.query<{ pid: number }>(
      `
      SELECT a.pid FROM pg_stat_activity a JOIN pg_stat_progress_create_index p ON p.pid=a.pid
      WHERE a.datname=current_database() AND a.application_name=$1
        AND p.relid='public.managed_giveaways'::regclass AND p.command='CREATE INDEX CONCURRENTLY'
        AND $2::int=ANY(pg_blocking_pids(a.pid))
        AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass($3) AND NOT indisvalid)`,
      [tag, f.blockerPid, `public.${target.index}`],
    );
    expect(result.rows.length).toBeLessThanOrEqual(1);
    pid = result.rows[0]?.pid;
    return pid !== undefined;
  }, 'Exact owned concurrent index build did not wait for its writer');
  return pid!;
}

native('giveaway due indexes through real Prisma migrations', () => {
  beforeAll(() => {
    const address = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) ||
      !address.pathname.includes('race_test') ||
      process.env.DATABASE_URL !== databaseUrl ||
      process.env.TZ !== 'UTC'
    )
      throw new Error(
        'Giveaway migrations require the public disposable local UTC race_test environment',
      );
  });

  it(
    'builds both exact indexes with concurrent writers and keeps genuine receipts and old indexes',
    async () => {
      await withDatabase(async (f) => {
        const seedStarted = Date.now();
        let rows = 0;
        const initialRows = large ? 1_500_000 : 100_000;
        while (rows < initialRows) {
          await seed(f.control, rows + 1, rows + 100_000);
          rows += 100_000;
        }
        let measured = await size(f.control);
        while (large && measured.totalBytes < productionSizeBound && rows < 2_000_000) {
          await seed(f.control, rows + 1, rows + 100_000);
          rows += 100_000;
          measured = await size(f.control);
        }
        expect(measured.rows).toBe(rows);
        expect(measured.heapBytes).toBeGreaterThanOrEqual(rows * 256);
        expect(measured.toastBytes).toBeLessThan(measured.heapBytes / 100);
        expect(measured.totalBytes).toBeGreaterThanOrEqual(
          large ? productionSizeBound : 100_000 * 256,
        );
        await f.control.query('ANALYZE public.managed_giveaways');
        const oldIndexes = await indexes(f.control);
        expect(
          oldIndexes.some((index) => targets.some((target) => target.index === index.name)),
        ).toBe(false);
        expect(oldIndexes.map((index) => index.name)).toEqual(
          expect.arrayContaining([
            'managed_giveaways_status_starts_at_idx',
            'managed_giveaways_status_ends_at_idx',
          ]),
        );
        expect(oldIndexes.every((index) => index.valid && index.ready && index.live)).toBe(true);
        const timings: {
          family: string;
          elapsedMs: number;
          concurrentWrites: number;
          postReleaseWrites: number;
          postReleasePhases: string[];
        }[] = [];
        const seedMs = Date.now() - seedStarted;
        for (const target of targets) {
          const sql = sourceSql(target);
          const createAt = sql.indexOf('CREATE INDEX CONCURRENTLY');
          const resetAt = sql.indexOf('RESET temp_file_limit');
          expect(sql.match(/\bCREATE INDEX CONCURRENTLY\b/gu)).toHaveLength(1);
          expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|IF NOT EXISTS)\b/gu);
          expect(resetAt).toBeGreaterThan(createAt);
          const settingsSql = `SELECT current_setting('lock_timeout') AS lock,
          current_setting('statement_timeout') AS statement, current_setting('maintenance_work_mem') AS memory,
          current_setting('max_parallel_maintenance_workers') AS parallel, current_setting('temp_file_limit') AS temp`;
          const before = (await f.control.query(settingsSql)).rows[0];
          await f.control.query(sql.slice(0, createAt));
          expect((await f.control.query(settingsSql)).rows[0]).toEqual({
            lock: '5s',
            statement: '90s',
            memory: '64MB',
            parallel: '0',
            temp: '512MB',
          });
          await f.control.query(sql.slice(resetAt));
          expect((await f.control.query(settingsSql)).rows[0]).toEqual(before);
          f.addTarget(target);
          await f.blocker.query('BEGIN');
          await f.blocker.query('UPDATE managed_giveaways SET title=$1 WHERE id=$2', [
            'pinned writer',
            seedId(1),
          ]);
          const tag = `giveaway-build-${randomUUID()}`;
          const child = f.launch(tag);
          await waitForBlockedBuild(f, tag, target);
          expect(child.result).toBeUndefined();
          let sequence = 0;
          let concurrentWrites = 0;
          let postReleaseWrites = 0;
          const postReleasePhases = new Set<string>();
          const write = async (afterRelease = false) => {
            sequence++;
            const result = await f.writer.query<{ phase: string | null }>(
              `
            UPDATE managed_giveaways SET title=$1 WHERE id=$2 RETURNING (
              SELECT p.phase FROM pg_stat_activity a JOIN pg_stat_progress_create_index p ON p.pid=a.pid
              WHERE a.datname=current_database() AND a.application_name=$3
                AND p.relid='public.managed_giveaways'::regclass AND p.command='CREATE INDEX CONCURRENTLY'
            ) AS phase`,
              [`concurrent-${target.family}-${sequence}`, seedId(3), tag],
            );
            expect(result.rowCount).toBe(1);
            const phase = result.rows[0]!.phase;
            if (phase !== null) {
              concurrentWrites++;
              if (afterRelease) {
                postReleaseWrites++;
                postReleasePhases.add(phase);
              }
            }
            return phase !== null;
          };
          expect(await write()).toBe(true);
          await f.blocker.query('UPDATE managed_giveaways SET title=$1 WHERE id=$2', [
            'writer committed',
            seedId(2),
          ]);
          await f.blocker.query('COMMIT');
          while (!child.result && sequence < 512) {
            await write(true);
            await delay(5);
          }
          const completed = await child.done;
          expect(completed).toMatchObject({
            code: 0,
            signal: null,
            timedOut: false,
            spawnFailed: false,
          });
          expect(concurrentWrites).toBeGreaterThan(0);
          expect(postReleaseWrites).toBeGreaterThan(0);
          expect(
            (await f.control.query('SELECT title FROM managed_giveaways WHERE id=$1', [seedId(3)]))
              .rows[0]!.title,
          ).toBe(`concurrent-${target.family}-${sequence}`);
          expect(
            (await f.control.query('SELECT title FROM managed_giveaways WHERE id=$1', [seedId(2)]))
              .rows[0]!.title,
          ).toBe('writer committed');
          await assertApplied(f.control, target);
          assertTargetIndex(await indexes(f.control), target, true);
          timings.push({
            family: target.family,
            elapsedMs: completed.elapsedMs,
            concurrentWrites,
            postReleaseWrites,
            postReleasePhases: [...postReleasePhases].sort(),
          });
        }
        const finalIndexes = await indexes(f.control);
        for (const target of targets) assertTargetIndex(finalIndexes, target, true);
        expect(
          finalIndexes.filter((index) => !targets.some((target) => target.index === index.name)),
        ).toEqual(oldIndexes);
        console.info(
          JSON.stringify({
            test: 'giveaway_migration_build',
            scale: large ? 'large' : 'default',
            ...measured,
            seedMs,
            builds: timings,
          }),
        );
      });
    },
    large ? 540_000 : 240_000,
  );

  it('retains the canceled artifact and failed receipt, refuses replay and preserves a foreign observer', async () => {
    await withDatabase(async (f) => {
      await seed(f.control, 1, 3);
      const target = targets[0];
      f.addTarget(target);
      const tag = `giveaway-cancel-${randomUUID()}`;
      const foreign = await f.connect(`${tag}-observer`);
      const foreignPid = (await foreign.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;
      await f.blocker.query('BEGIN');
      await f.blocker.query('UPDATE managed_giveaways SET title=$1 WHERE id=$2', [
        'cancellation pin',
        seedId(1),
      ]);
      const child = f.launch(tag);
      const pid = await waitForBlockedBuild(f, tag, target);
      const canceled = await f.control.query<{ canceled: boolean }>(
        `SELECT pg_cancel_backend(pid) AS canceled
        FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND pid=$2`,
        [tag, pid],
      );
      expect(canceled.rows).toEqual([{ canceled: true }]);
      const result = await child.done;
      expect(result.code).not.toBe(0);
      expect(result).toMatchObject({ signal: null, timedOut: false, spawnFailed: false });
      await f.blocker.query('COMMIT');
      const failedReceipts = await receipts(f.control, [target.name]);
      expect(failedReceipts).toHaveLength(1);
      expect(failedReceipts[0]).toMatchObject({
        name: target.name,
        checksum: checksum(sourceSql(target)),
        finishedAt: null,
        rolledBackAt: null,
        steps: 0,
      });
      expect(failedReceipts[0]!.startedAt).toBeInstanceOf(Date);
      const failedIndex = assertTargetIndex(await indexes(f.control), target, false);
      expect(failedIndex.ready).toBe(false);
      const retry = await f.launch(`giveaway-retry-${randomUUID()}`).done;
      expect(retry.code).not.toBe(0);
      expect(retry).toMatchObject({
        signal: null,
        timedOut: false,
        spawnFailed: false,
        p3009: true,
      });
      expect(await receipts(f.control, [target.name])).toEqual(failedReceipts);
      expect(assertTargetIndex(await indexes(f.control), target, false)).toEqual(failedIndex);
      expect(
        (await foreign.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      ).toBe(foreignPid);
      expect(
        (
          await f.control.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND application_name=$1`,
            [tag],
          )
        ).rows[0]!.count,
      ).toBe(0);
    });
  }, 240_000);
});
