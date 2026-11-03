import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../../../../', import.meta.url)),
  require = createRequire(root + '/package.json'),
  pg = require('pg'),
  { Redis } = require('ioredis');
const { Store } = await import(root + '/apps/eraser/src/store.ts');
const { updatePolicy } = await import(root + '/apps/eraser/test/support/policy-proof.ts');
const { migrate } = await import(root + '/apps/eraser/src/migrate.ts');
const { CleanupRuntime } = await import(root + '/apps/eraser/src/runtime.ts');
const { DurableRateLimit } = await import(root + '/apps/eraser/src/rate-limit.ts');
const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
if (
  url.hostname !== '127.0.0.1' ||
  !/^\/(maxim_race_test_[a-f0-9]+|eraser_test)$/.test(url.pathname)
)
  throw Error('Disposable wrapper required');
const coordinator = new pg.Pool({ connectionString: url.toString(), max: 1 });
const sourceName = 'eraser_source_' + randomUUID().replaceAll('-', '');
const sourceUrl = new URL(url);
sourceUrl.pathname = '/' + sourceName;
const admin = new pg.Pool({ connectionString: sourceUrl.toString(), max: 1 });
const restoreName = 'eraser_restore_' + randomUUID().replaceAll('-', '');
const restoredUrl = new URL(url);
restoredUrl.pathname = '/' + restoreName;
const pool = new pg.Pool({
  connectionString: restoredUrl.toString(),
  max: 4,
  options: '-c timezone=UTC',
});
const temp = await mkdtemp(join(tmpdir(), 'eraser-synthetic-recovery-'));
const prefix = 'eraser:restore:' + randomUUID();
const redis = new Redis(process.env.MAXIM_TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
let runtime;
let restored = false;
let sourceCreated = false;
function command(name, args, db) {
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: db,
  };
  const executable = existsSync('/usr/lib/postgresql/16/bin/' + name)
    ? '/usr/lib/postgresql/16/bin/' + name
    : name;
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  assert.match(version.stdout, /PostgreSQL\) 16\./, 'PostgreSQL16 client is required');
  const r = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, name + ' failed in disposable rehearsal');
}
try {
  await coordinator.query('CREATE DATABASE ' + sourceName);
  sourceCreated = true;
  await migrate(admin);
  const source = new Store(admin, true);
  await source.bootstrap('-1', 24, {
    sourceRevision: 1,
    protectedMessageIds: ['protected'],
    protectedBotIds: [],
    holdMessageIds: [],
    completeThrough: new Date().toISOString(),
  });
  await updatePolicy(source, '-1', {
    enabled: true,
    hours: 24,
    expectedRevision: 0,
    operationId: randomUUID(),
    actorUserId: '10',
  });
  await admin.query(
    "UPDATE eraser_policies SET history_complete=true,safety_next_at=now()+interval '6 hours',connection_status='connected'",
  );
  for (const [id, state] of [
    ['safe', 'pending'],
    ['protected', 'pending'],
    ['unknown', 'uncertain'],
    ['inflight', 'dispatching'],
    ['manual', 'review'],
  ])
    await admin.query(
      "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state,dispatch_id,attempt_count) VALUES('-1',$1,'10',false,$2,'live',$3,$4,$5)",
      [
        id,
        Date.now() - 2 * 86400000,
        state,
        ['uncertain', 'dispatching'].includes(state) ? randomUUID() : null,
        ['uncertain', 'dispatching'].includes(state) ? 1 : 0,
      ],
    );
  await source.ingest({}, 'future-receipt', {
    chatId: '-1',
    messageId: 'future',
    authorId: '10',
    isBot: false,
    sourceMs: Date.now(),
  });
  await new DurableRateLimit(admin, '123').extend(600000);
  const unknown = (
    await admin.query(
      "SELECT message_id,state,dispatch_id,attempt_count FROM eraser_candidates WHERE state IN ('uncertain','dispatching','review') ORDER BY message_id",
    )
  ).rows;
  const future = (await admin.query('SELECT * FROM eraser_future_hours')).rows;
  const cooldown = (await admin.query('SELECT * FROM eraser_rate_limits')).rows;
  const start = Date.now();
  command(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', '--file', join(temp, 'synthetic.dump')],
    sourceName,
  );
  await coordinator.query('CREATE DATABASE ' + restoreName);
  restored = true;
  command(
    'pg_restore',
    [
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      restoreName,
      join(temp, 'synthetic.dump'),
    ],
    restoreName,
  );
  assert.deepEqual((await pool.query('SELECT * FROM eraser_future_hours')).rows, future);
  assert.deepEqual((await pool.query('SELECT * FROM eraser_rate_limits')).rows, cooldown);
  assert.ok((await new DurableRateLimit(pool, '123').remainingMs()) > 500000);
  const calls = [];
  const max = {
    rights: async () => {},
    actorRights: async () => {},
    pin: async () => null,
    page: async () => [],
    presence: async () => {
      throw Error('Unknown effect cannot trigger a read');
    },
    remove: async (_chat, id, guard) => {
      await guard();
      assert.equal(id, 'safe');
      calls.push(id);
    },
  };
  runtime = new CleanupRuntime(
    new Store(pool, true),
    max,
    { enabled: true, redisUrl: process.env.MAXIM_TEST_REDIS_URL },
    prefix,
  );
  await runtime.start();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const rows = (
      await pool.query(
        "SELECT message_id,state FROM eraser_candidates WHERE message_id IN ('safe','protected')",
      )
    ).rows;
    if (
      rows.some((row) => row.message_id === 'safe' && row.state === 'deleted') &&
      rows.some((row) => row.message_id === 'protected' && row.state === 'protected')
    )
      break;
    await delay(100);
  }
  await runtime.close();
  runtime = undefined;
  assert.deepEqual(calls, ['safe']);
  assert.equal(
    (await pool.query("SELECT state FROM eraser_candidates WHERE message_id='safe'")).rows[0].state,
    'deleted',
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT message_id,state,dispatch_id,attempt_count FROM eraser_candidates WHERE state IN ('uncertain','dispatching','review') ORDER BY message_id",
      )
    ).rows,
    unknown,
  );
  assert.equal(
    (await pool.query("SELECT state FROM eraser_candidates WHERE message_id='protected'")).rows[0]
      .state,
    'protected',
  );
  const invariantSql = spawnSync(
    process.execPath,
    [join(root, 'infra/scripts/eraser-restore-invariants.mjs'), '--sql'],
    { encoding: 'utf8' },
  );
  assert.equal(invariantSql.status, 0);
  const invariant = async () => Object.values((await pool.query(invariantSql.stdout)).rows[0])[0];
  assert.equal(await invariant(), 1);
  const migration = (
    await pool.query('SELECT name,digest FROM eraser_migrations ORDER BY name LIMIT 1')
  ).rows[0];
  await pool.query('UPDATE eraser_migrations SET digest=$1 WHERE name=$2', [
    '0'.repeat(64),
    migration.name,
  ]);
  assert.equal(await invariant(), 0, 'changed migration digest is rejected');
  await pool.query('UPDATE eraser_migrations SET digest=$1 WHERE name=$2', [
    migration.digest,
    migration.name,
  ]);
  await pool.query('DROP INDEX eraser_candidates_purge_idx');
  assert.equal(await invariant(), 0, 'missing critical index is rejected');
  console.log(
    JSON.stringify({
      kind: 'isolated_synthetic_dump_restore',
      elapsedMs: Date.now() - start,
      journalsPreserved: unknown.length,
      protectionPreserved: true,
      cooldownPreserved: true,
      futureSchedulePreserved: true,
      freshRedisQueueReconstructed: true,
      fakeDeleteCount: calls.length,
      externalRequests: 0,
      limitation:
        'Synthetic snapshot only. Does not authorize replay after recovery from an old production snapshot or prove remote encrypted-copy recovery.',
    }),
  );
} finally {
  if (runtime) await runtime.close();
  await pool.end();
  if (restored) await coordinator.query('DROP DATABASE ' + restoreName);
  await admin.end();
  if (sourceCreated) await coordinator.query('DROP DATABASE ' + sourceName);
  await coordinator.end();
  const keys = await redis.keys(prefix + '*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
  await rm(temp, { recursive: true, force: true });
}
