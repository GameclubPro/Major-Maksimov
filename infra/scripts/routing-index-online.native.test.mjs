import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRoutingIndexMigrationPrefix } from '../../scripts/agent/routing-index-online-prepare.mjs';
import {
  readRoutingIndexSource,
  ROUTING_INDEX_TARGET,
} from '../../scripts/agent/routing-index-online-target.mjs';
import { routingIndexStateSql, verifyRoutingIndexState } from './routing-index-online-state.mjs';

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
      assert.equal(verifyRoutingIndexState(await snapshot(), source).state, 'prepare_routing');
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
