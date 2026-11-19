import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GIVEAWAY_DEFERRAL_MIGRATIONS,
  verifyGiveawayDeferralState,
} from '../../scripts/agent/routing-index-catalog.mjs';
import { createRoutingIndexMigrationPrefix } from '../../scripts/agent/routing-index-online-prepare.mjs';
import {
  readRoutingIndexSource,
  ROUTING_INDEX_TARGET,
} from '../../scripts/agent/routing-index-online-target.mjs';
import {
  routingIndexStateSql,
  verifyReleaseRoutingState,
  verifyRoutingIndexState,
} from './routing-index-online-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const source = readRoutingIndexSource(root);
const outcome = (result) =>
  result.find((part) => part.rows?.[0]?.json_build_object)?.rows[0].json_build_object;
const routingChildEnv = (databaseUrl) => {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: `maxim-online-${randomUUID()}`,
  };
  delete env.PGOPTIONS;
  return env;
};

test(
  'real Prisma prefix and PostgreSQL expression catalog remain fail closed',
  { skip: !nativeUrl, timeout: 240_000 },
  async () => {
    const base = new URL(nativeUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) &&
        base.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const observer = new pg.Client({ connectionString: nativeUrl });
    await observer.connect();
    const database = `routing_ci_${randomUUID().replaceAll('-', '')}`;
    const own = new URL(nativeUrl);
    own.pathname = `/${database}`;
    let db, prefix, writer, builder, buildPromise;
    try {
      await observer.query(`CREATE DATABASE "${database}"`);
      db = new pg.Client({ connectionString: own.href });
      await db.connect();
      prefix = createRoutingIndexMigrationPrefix(root);
      rmSync(resolve(prefix.tempRoot, 'migrations', ROUTING_INDEX_TARGET.migration), {
        recursive: true,
      });
      const bootstrap = spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
          '--config',
          prefix.configPath,
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: own.href },
          stdio: 'ignore',
          timeout: 120_000,
        },
      );
      assert.equal(bootstrap.status, 0, 'Real prerequisite migrations must complete');
      rmSync(prefix.tempRoot, { recursive: true, force: true });
      prefix = undefined;
      const snapshot = async () => outcome(await db.query(routingIndexStateSql));
      const pending = await snapshot();
      const selected = {
        source: source.filter((entry) => entry.name <= ROUTING_INDEX_TARGET.migration),
        supportsOrdered: true,
      };
      assert.equal(verifyRoutingIndexState(pending, source).state, 'prepare_routing');
      assert.equal(verifyReleaseRoutingState(pending, selected), 'compatible_pending');
      const giveawayMigration = '20261119043000_add_managed_giveaway_draft_revision';
      const withGiveaway = source.filter((entry) => entry.name <= giveawayMigration);
      assert.equal(withGiveaway.at(-1)?.name, giveawayMigration);
      assert.equal(
        verifyReleaseRoutingState(pending, { source: withGiveaway, supportsOrdered: true }),
        'prepare_routing',
      );
      const { definition } = (
        await db.query(
          "SELECT pg_get_indexdef('public.webhook_events_ordered_chat_head_idx'::regclass) AS definition",
        )
      ).rows[0];
      await db.query(
        'ALTER INDEX public.webhook_events_ordered_chat_head_idx RENAME TO fixture_preserved_ordered_idx',
      );
      assert.equal(verifyReleaseRoutingState(await snapshot(), selected), 'prepare_routing');
      for (const drifted of [
        definition.replace('created_at, id)', 'id, created_at)'),
        definition.replace('message_edited', 'different_event'),
        definition.replace(/chatId/gu, 'otherChat'),
      ]) {
        assert.notEqual(drifted, definition);
        await db.query(drifted);
        assert.equal(verifyReleaseRoutingState(await snapshot(), selected), 'prepare_routing');
        await db.query('DROP INDEX public.webhook_events_ordered_chat_head_idx');
      }
      await db.query(
        'ALTER INDEX public.fixture_preserved_ordered_idx RENAME TO webhook_events_ordered_chat_head_idx',
      );
      const seedReceipt = async ({ name, checksum, finished = true, rolledBack = false }) => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO public._prisma_migrations
          (id,checksum,migration_name,started_at,finished_at,rolled_back_at,applied_steps_count)
          VALUES ($1,$2,$3,now(),CASE WHEN $4::boolean THEN now() END,
            CASE WHEN $5::boolean THEN now() END,0)`,
          [id, checksum, name, finished, rolledBack],
        );
        return id;
      };
      const known = source[0];
      for (const receipt of [
        {
          name: ROUTING_INDEX_TARGET.migration,
          checksum: ROUTING_INDEX_TARGET.checksum,
          finished: false,
        },
        { name: 'foreign_receipt', checksum: 'f'.repeat(64) },
        { name: known.name, checksum: known.checksum },
        { name: 'foreign_receipt', checksum: 'f'.repeat(64), rolledBack: true },
        {
          name: ROUTING_INDEX_TARGET.migration,
          checksum: ROUTING_INDEX_TARGET.checksum,
          rolledBack: true,
        },
      ]) {
        const id = await seedReceipt(receipt);
        const bad = await snapshot();
        assert.throws(() => verifyRoutingIndexState(bad, source), /RECEIPT_BLOCKED/u);
        await db.query('DELETE FROM public._prisma_migrations WHERE id=$1', [id]);
      }
      const historicalRetry = await seedReceipt({
        name: known.name,
        checksum: known.checksum,
        rolledBack: true,
      });
      assert.equal(verifyRoutingIndexState(await snapshot(), source).state, 'prepare_routing');
      await db.query('DELETE FROM public._prisma_migrations WHERE id=$1', [historicalRetry]);

      const recoveredId = randomUUID();
      const recoveredName = '20260621120000_optimize_spammer_review';
      const recoveredChecksum = '456919e50cecb0b00a54d65ccb346598f9781498c446179e483ea99cf2e93c95';
      const recovered = await db.query(
        `INSERT INTO public._prisma_migrations
          (id,checksum,migration_name,started_at,finished_at,rolled_back_at,applied_steps_count)
          SELECT $1,$2,migration_name,started_at - interval '2 minutes',NULL,
            started_at - interval '1 minute',0
          FROM public._prisma_migrations
          WHERE migration_name=$3 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        [recoveredId, recoveredChecksum, recoveredName],
      );
      assert.equal(recovered.rowCount, 1);
      assert.equal(verifyRoutingIndexState(await snapshot(), source).state, 'prepare_routing');

      writer = new pg.Client({ connectionString: own.href });
      builder = new pg.Client({
        connectionString: own.href,
        application_name: 'routing-foreign-builder',
      });
      await writer.connect();
      await builder.connect();
      await writer.query('BEGIN; LOCK TABLE public.webhook_events IN ROW EXCLUSIVE MODE');
      buildPromise = builder.query(
        'CREATE INDEX CONCURRENTLY routing_foreign_builder_idx ON public.webhook_events(created_at)',
      );
      const deadline = Date.now() + 8000;
      let building;
      while (Date.now() < deadline) {
        building = await snapshot();
        if (building.builders.length) break;
        await delay(25);
      }
      assert.ok(building.builders.length, 'Competing builder must be visible');
      assert.throws(() => verifyRoutingIndexState(building, source), /STATE_INVALID/u);
      await writer.query('COMMIT');
      await buildPromise;
      buildPromise = undefined;
      await db.query('DROP INDEX public.routing_foreign_builder_idx');
      const applied = spawnSync(
        process.execPath,
        [resolve(root, 'scripts/agent/routing-index-online-prepare.mjs')],
        {
          cwd: root,
          env: routingChildEnv(own.href),
          stdio: 'ignore',
          timeout: 60_000,
        },
      );
      assert.equal(applied.status, 0, 'Real routing migration must complete');
      const completed = await snapshot();
      assert.equal(verifyRoutingIndexState(completed, source).state, 'already_applied');
      const historical = completed.receipts.find((row) => row.id === recoveredId);
      assert.equal(historical?.checksum, recoveredChecksum);
      assert.equal(historical.rolled_back, true);
      assert.equal(historical.steps, 0);
      const receipt = completed.receipts.find((row) => row.name === ROUTING_INDEX_TARGET.migration);
      assert.equal(receipt?.steps, 1, 'Prisma deploy records one applied step on PostgreSQL 16');
      await db.query('UPDATE public._prisma_migrations SET applied_steps_count=0 WHERE id=$1', [
        receipt.id,
      ]);
      const incomplete = await snapshot();
      assert.throws(() => verifyRoutingIndexState(incomplete, source), /RECEIPT_BLOCKED/u);
      await db.query('UPDATE public._prisma_migrations SET applied_steps_count=1 WHERE id=$1', [
        receipt.id,
      ]);
      const reentry = spawnSync(
        process.execPath,
        [resolve(root, 'scripts/agent/routing-index-online-prepare.mjs')],
        {
          cwd: root,
          env: routingChildEnv(own.href),
          stdio: 'ignore',
          timeout: 60_000,
        },
      );
      assert.equal(reentry.status, 0);
      assert.deepEqual(await snapshot(), completed);
      await db.query('DROP INDEX public.webhook_events_chat_queue_head_idx');
      let drift = await snapshot();
      assert.throws(() => verifyRoutingIndexState(drift, source), /INDEX_BLOCKED/u);
      await db.query(
        'CREATE INDEX webhook_events_chat_queue_head_idx ON public.webhook_events(queue_name,created_at,id)',
      );
      drift = await snapshot();
      assert.throws(() => verifyRoutingIndexState(drift, source), /INDEX_BLOCKED/u);
    } finally {
      if (prefix) rmSync(prefix.tempRoot, { recursive: true, force: true });
      if (writer) {
        try {
          await writer.query('ROLLBACK');
        } catch {
          // FLAG: Continue closing owned clients and dropping the disposable database.
        }
      }
      if (buildPromise) {
        try {
          await buildPromise;
        } catch {
          // FLAG: Build rejection is expected in fault cases; still release every fixture client.
        }
      }
      await builder?.end();
      await writer?.end();
      await db?.end();
      await observer.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await observer.end();
    }
  },
);

for (const scenario of ['fresh', 'resume', 'failed']) {
  test(
    `fixed giveaway migration runner with genuine Prisma receipts: ${scenario}`,
    { skip: !nativeUrl, timeout: 240_000 },
    async (t) => {
      const base = new URL(nativeUrl);
      assert.ok(
        ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) &&
          base.pathname.includes('race_test'),
      );
      const [first, second] = GIVEAWAY_DEFERRAL_MIGRATIONS;
      // FLAG: The one-off deferral only accepts the release ending at these exact migrations.
      // Exercise that release from real immutable SQL even after newer migrations are committed.
      const releaseRoot = mkdtempSync(resolve(tmpdir(), 'routing-giveaway-release-'));
      t.after(() => rmSync(releaseRoot, { recursive: true, force: true }));
      const files = resolve(root, 'apps/api/prisma');
      const fixture = resolve(releaseRoot, 'apps/api/prisma');
      mkdirSync(resolve(fixture, 'migrations'), { recursive: true });
      symlinkSync(resolve(root, 'node_modules'), resolve(releaseRoot, 'node_modules'), 'junction');
      cpSync(resolve(files, 'schema.prisma'), resolve(fixture, 'schema.prisma'));
      cpSync(
        resolve(files, 'migrations/migration_lock.toml'),
        resolve(fixture, 'migrations/migration_lock.toml'),
      );
      for (const { name } of source.filter(({ name }) => name <= second.name)) {
        cpSync(resolve(files, 'migrations', name), resolve(fixture, 'migrations', name), {
          recursive: true,
        });
      }
      const releaseSource = readRoutingIndexSource(releaseRoot);
      const { default: pg } = await import('pg');
      const admin = new pg.Client({ connectionString: nativeUrl });
      const database = `giveaway_routing_ci_${randomUUID().replaceAll('-', '')}`;
      const own = new URL(nativeUrl);
      own.pathname = `/${database}`;
      const db = new pg.Client({ connectionString: own.href });
      const snapshot = async () => outcome(await db.query(routingIndexStateSql));
      const runner = (...args) => {
        const env = routingChildEnv(own.href);
        if (args[0] === '--giveaway-deferral') delete env.MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME;
        return spawnSync(
          process.execPath,
          [resolve(root, 'scripts/agent/routing-index-online-prepare.mjs'), ...args],
          { cwd: releaseRoot, env, encoding: 'utf8', timeout: 90_000 },
        );
      };
      let prefix;
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
        await db.connect();
        prefix = createRoutingIndexMigrationPrefix(releaseRoot);
        const basePath = resolve(prefix.tempRoot, 'migrations');
        rmSync(resolve(basePath, ROUTING_INDEX_TARGET.migration), {
          recursive: true,
        });
        if (scenario === 'resume') {
          cpSync(
            resolve(root, 'apps/api/prisma/migrations', first.name),
            resolve(basePath, first.name),
            { recursive: true },
          );
        }
        const bootstrap = spawnSync(
          process.execPath,
          [
            resolve(root, 'node_modules/prisma/build/index.js'),
            'migrate',
            'deploy',
            '--config',
            prefix.configPath,
          ],
          {
            cwd: root,
            env: routingChildEnv(own.href),
            stdio: 'ignore',
            timeout: 120_000,
          },
        );
        assert.equal(bootstrap.status, 0, 'Prisma prerequisite history');
        const before = await snapshot();
        if (source.length > releaseSource.length) {
          assert.throws(
            () => verifyGiveawayDeferralState(before, source),
            /GIVEAWAY_DEFERRAL_SOURCE_INVALID/u,
          );
        }
        assert.equal(
          verifyGiveawayDeferralState(before, releaseSource).pending.length,
          scenario === 'resume' ? 1 : 2,
        );
        if (scenario === 'failed') {
          await db.query(`CREATE FUNCTION fixture_block_ddl() RETURNS event_trigger LANGUAGE plpgsql AS
          'BEGIN RAISE EXCEPTION ''fixture rejection''; END';
          CREATE EVENT TRIGGER fixture_reject_new_table ON ddl_command_start WHEN TAG IN ('CREATE TABLE')
          EXECUTE FUNCTION fixture_block_ddl()`);
        }
        const result = runner('--giveaway-deferral');
        const after = await snapshot();
        const receipts = after.receipts.filter(
          (entry) => entry.name === first.name || entry.name === second.name,
        );
        assert.equal(receipts.length, 2);
        assert.ok(
          receipts.some(
            (row) => row.name === first.name && row.checksum === first.checksum && row.finished,
          ),
        );
        assert.equal(after.index.present, false);
        assert.ok(after.orderedIndex.exact);
        assert.ok(!after.receipts.some((row) => row.name === ROUTING_INDEX_TARGET.migration));
        if (scenario === 'failed') {
          assert.equal(result.status, 1);
          assert.ok(
            receipts.some(
              (row) =>
                row.name === second.name &&
                !row.finished &&
                !row.rolled_back &&
                row.checksum === second.checksum,
            ),
          );
          await db.query('DROP EVENT TRIGGER fixture_reject_new_table');
          assert.equal(runner('--giveaway-deferral').status, 1);
          assert.deepEqual(await snapshot(), after);
          return;
        }
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).state, 'compatible_pending');
        assert.deepEqual(verifyGiveawayDeferralState(after, releaseSource).pending, []);
        assert.equal(runner('--giveaway-deferral').status, 0);
        assert.deepEqual(await snapshot(), after);
        const schema = await db.query(
          `SELECT draft_revision, archived_at FROM managed_giveaways LIMIT 0`,
        );
        assert.equal(schema.fields.length, 2);
        assert.equal(
          (await db.query('SELECT count(*)::int AS count FROM managed_giveaway_results_sync'))
            .rows[0].count,
          0,
        );
        if (scenario === 'resume') {
          await db.query('ALTER TABLE managed_giveaways ALTER COLUMN draft_revision SET DEFAULT 2');
          assert.equal(runner('--giveaway-deferral').status, 1);
          await db.query('ALTER TABLE managed_giveaways ALTER COLUMN draft_revision SET DEFAULT 1');
          await db.query(
            'ALTER INDEX managed_giveaway_results_sync_due_idx RENAME TO fixture_hidden_due_idx',
          );
          assert.equal(runner('--giveaway-deferral').status, 1);
          assert.deepEqual((await snapshot()).receipts, after.receipts);
        }
        if (scenario === 'fresh') {
          const ordinary = runner();
          assert.equal(ordinary.status, 0, ordinary.stderr);
          assert.equal(
            verifyRoutingIndexState(await snapshot(), releaseSource).state,
            'already_applied',
          );
        }
      } finally {
        if (prefix) rmSync(prefix.tempRoot, { recursive: true, force: true });
        await db.end();
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.end();
      }
    },
  );
}

test(
  'interrupted routing migration retains its failed receipt and invalid index and never retries',
  { skip: !nativeUrl, timeout: 240_000 },
  async () => {
    const base = new URL(nativeUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) &&
        base.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const observer = new pg.Client({ connectionString: nativeUrl });
    await observer.connect();
    const database = `routing_abort_${randomUUID().replaceAll('-', '')}`;
    const own = new URL(nativeUrl);
    own.pathname = `/${database}`;
    let db, writer, foreign, prefix, child, done;
    try {
      await observer.query(`CREATE DATABASE "${database}"`);
      db = new pg.Client({ connectionString: own.href });
      writer = new pg.Client({ connectionString: own.href });
      foreign = new pg.Client({
        connectionString: own.href,
        application_name: 'routing-foreign-observer',
      });
      await db.connect();
      await writer.connect();
      await foreign.connect();
      const foreignPid = (await foreign.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      prefix = createRoutingIndexMigrationPrefix(root);
      rmSync(resolve(prefix.tempRoot, 'migrations', ROUTING_INDEX_TARGET.migration), {
        recursive: true,
      });
      const bootstrap = spawnSync(
        process.execPath,
        [
          resolve(root, 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
          '--config',
          prefix.configPath,
        ],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: own.href },
          stdio: 'ignore',
          timeout: 120_000,
        },
      );
      assert.equal(bootstrap.status, 0);
      rmSync(prefix.tempRoot, { recursive: true, force: true });
      prefix = undefined;
      await writer.query('BEGIN; LOCK TABLE public.webhook_events IN ROW EXCLUSIVE MODE');
      const tag = `maxim-online-${randomUUID()}`;
      child = spawn(
        process.execPath,
        [resolve(root, 'scripts/agent/routing-index-online-prepare.mjs')],
        {
          cwd: root,
          env: { ...routingChildEnv(own.href), MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: tag },
          stdio: 'ignore',
        },
      );
      done = new Promise((resolveDone, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolveDone({ code, signal }));
      });
      const deadline = Date.now() + 8000;
      let invalid = false;
      while (Date.now() < deadline) {
        invalid = (
          await db.query(`SELECT EXISTS(SELECT 1 FROM pg_index
          WHERE indexrelid=to_regclass('public.webhook_events_chat_queue_head_idx') AND NOT indisvalid) AS present`)
        ).rows[0].present;
        if (invalid) break;
        await delay(25);
      }
      assert.equal(invalid, true, 'Concurrent index must enter its invalid build phase');
      const canceled = await db.query(
        `SELECT pg_cancel_backend(pid) AS canceled FROM pg_stat_activity
        WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid()`,
        [tag],
      );
      assert.ok(canceled.rows.some((row) => row.canceled));
      const result = await done;
      child = undefined;
      assert.equal(result.code, 1);
      await writer.query('COMMIT');
      const snapshot = async () => outcome(await db.query(routingIndexStateSql));
      const failed = await snapshot();
      const receipt = failed.receipts.find((row) => row.name === ROUTING_INDEX_TARGET.migration);
      assert.equal(receipt.checksum, ROUTING_INDEX_TARGET.checksum);
      assert.equal(receipt.finished, false);
      assert.equal(receipt.rolled_back, false);
      assert.equal(failed.index.present, true);
      assert.equal(failed.index.exact, false);
      assert.throws(() => verifyRoutingIndexState(failed, source), /RECEIPT_BLOCKED/u);
      const retry = spawnSync(
        process.execPath,
        [resolve(root, 'scripts/agent/routing-index-online-prepare.mjs')],
        {
          cwd: root,
          env: routingChildEnv(own.href),
          stdio: 'ignore',
          timeout: 60_000,
        },
      );
      assert.equal(retry.status, 1);
      assert.deepEqual(await snapshot(), failed);
      assert.equal((await foreign.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, foreignPid);
    } finally {
      if (child) {
        child.kill('SIGKILL');
        try {
          await done;
        } catch {
          // FLAG: Killing the owned child may reject its promise; database teardown must continue.
        }
      }
      if (prefix) rmSync(prefix.tempRoot, { recursive: true, force: true });
      if (writer) {
        try {
          await writer.query('ROLLBACK');
        } catch {
          // FLAG: Continue closing owned clients and dropping the disposable database.
        }
      }
      await foreign?.end();
      await writer?.end();
      await db?.end();
      await observer.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await observer.end();
    }
  },
);
