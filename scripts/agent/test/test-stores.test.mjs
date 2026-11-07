import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseArgs, startTestStoreCommand } from '../with-test-stores.mjs';

const root = resolve(import.meta.dirname, '../../..');
const runner = resolve(root, 'scripts/agent/with-test-stores.mjs');

test('store runner rejects a missing child command and unknown setup options', () => {
  for (const args of [
    [],
    ['--'],
    ['npm', 'test'],
    ['--remote', '--', 'npm', 'test'],
    ['--profile=production', '--', 'node'],
    ['--profile=split-load', '--profile=split-load', '--', 'node'],
  ]) {
    assert.throws(() => parseArgs(args), /Usage/u);
  }
  assert.deepEqual(parseArgs(['--migrate', '--', 'npm', 'test', '--', 'fixture']), {
    migrate: true,
    command: ['npm', 'test', '--', 'fixture'],
  });
  assert.deepEqual(parseArgs(['--migrate', '--profile=split-load', '--', 'node', 'fixture']), {
    migrate: true,
    profile: 'split-load',
    command: ['node', 'fixture'],
  });
});

test('migrated commands wait for deployment and baseline parity before starting the child', async () => {
  const deployment = Promise.withResolvers();
  const parity = Promise.withResolvers();
  const events = [];
  const child = { done: Promise.resolve({ code: 7 }) };
  const requested = ['node', '-e', 'process.exitCode = 7'];
  const pending = startTestStoreCommand(
    { migrate: true, command: requested },
    {
      run: async (command, args) => {
        assert.equal(command, 'npm');
        assert.deepEqual(args.slice(2), ['--workspace', '@maxim/api']);
        events.push(args[1]);
        await (args[1] === 'prisma:migrate:deploy' ? deployment.promise : parity.promise);
      },
      start: (command, args) => {
        events.push('child');
        assert.deepEqual([command, ...args], requested);
        return child;
      },
      log: (message) => events.push(message),
    },
  );
  assert.deepEqual(events, ['prisma:migrate:deploy']);
  deployment.resolve();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(events, ['prisma:migrate:deploy', 'prisma:check:drift']);
  parity.resolve();
  assert.equal(await pending, child);
  assert.deepEqual(events, [
    'prisma:migrate:deploy',
    'prisma:check:drift',
    '[test-stores] Migrated PostgreSQL matches the reviewed Prisma drift baseline.',
    'child',
  ]);
});

test('setup failures cannot start a requested command and drift diagnostics stay private', async () => {
  const privateOutput = 'postgresql://private-user:PRIVATE_PASSWORD@127.0.0.1/private_database';
  for (const failingScript of ['prisma:migrate:deploy', 'prisma:check:drift']) {
    const events = [];
    const failure = new Error(privateOutput);
    Object.assign(failure, { stdout: privateOutput, stderr: privateOutput, env: privateOutput });
    await assert.rejects(
      startTestStoreCommand(
        { migrate: true, command: ['node', '-e', 'throw new Error("Must never run")'] },
        {
          run: async (_command, args) => {
            events.push(args[1]);
            if (args[1] === failingScript) throw failure;
          },
          start: () => assert.fail('Child must not start after a setup failure'),
          log: () => assert.fail('Failed drift must not be reported as accepted'),
        },
      ),
      (error) => {
        if (failingScript === 'prisma:migrate:deploy') return error === failure;
        assert.equal(
          error.message,
          'TEST_STORE_SCHEMA_DRIFT_CHECK_FAILED: requested command was not started.',
        );
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(String(error), /PRIVATE_PASSWORD|postgresql:\/\//u);
        return true;
      },
    );
    assert.deepEqual(
      events,
      failingScript === 'prisma:migrate:deploy'
        ? ['prisma:migrate:deploy']
        : ['prisma:migrate:deploy', 'prisma:check:drift'],
    );
  }
});

test('unmigrated commands keep the empty-store path and skip database parity', async () => {
  const child = {};
  assert.equal(
    await startTestStoreCommand(
      { migrate: false, command: ['node', '--version'] },
      {
        run: () => assert.fail('Unmigrated stores must not run Prisma setup'),
        start: (command, args) => {
          assert.equal(command, 'node');
          assert.deepEqual(args, ['--version']);
          return child;
        },
        log: () => assert.fail('Unmigrated stores must not report migration parity'),
      },
    ),
    child,
  );
});

const realStores = process.env.MAXIM_AGENT_TEST_STORES === '1';
const childSource = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {Client} = require('pg');
const Redis = require('ioredis');
(async () => {
  const pgUrl = new URL(process.env.DATABASE_URL);
  const redisUrl = new URL(process.env.REDIS_URL);
  assert.equal(pgUrl.hostname, '127.0.0.1');
  assert.equal(redisUrl.hostname, '127.0.0.1');
  assert.match(pgUrl.pathname, /race_test/);
  assert.equal(process.env.DATABASE_URL, process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL);
  assert.equal(process.env.DATABASE_URL, process.env.MAXIM_TEST_POSTGRES_URL);
  assert.equal(process.env.REDIS_URL, process.env.MAXIM_TEST_REDIS_URL);
  assert.equal(process.env.TZ, 'UTC');
  const pg = new Client({connectionString: process.env.DATABASE_URL});
  // Existing integration fixtures intentionally use CI-compatible host/port connections.
  const redis = new Redis({host: redisUrl.hostname, port: Number(redisUrl.port)});
  try {
    await pg.connect();
    assert.equal((await pg.query('SHOW TimeZone')).rows[0].TimeZone, 'UTC');
    assert.equal((await pg.query('SHOW max_connections')).rows[0].max_connections,
      process.env.MAXIM_STORE_TEST_HOLD === '1' ? '100' : '40');
    assert.equal((await pg.query('SELECT count(*) FROM pg_tables WHERE schemaname=\'public\'')).rows[0].count, '0');
    assert.equal(await redis.dbsize(), 0);
    await pg.query('CREATE TABLE fixture(value integer)');
    await pg.query('INSERT INTO fixture VALUES(42)');
    assert.equal((await pg.query('SELECT value FROM fixture')).rows[0].value, 42);
    await redis.set('fixture', 'ok');
    assert.equal(await redis.get('fixture'), 'ok');
    const directory = path.dirname((await pg.query('SHOW data_directory')).rows[0].data_directory);
    fs.writeFileSync(process.env.MAXIM_STORE_TEST_RESULT, JSON.stringify({
      directory, postgresPort: Number(pgUrl.port), redisPort: Number(redisUrl.port)
    }));
  } finally { await pg.end(); redis.disconnect(); }
  if (process.env.MAXIM_STORE_TEST_HOLD === '1') setInterval(() => {}, 1000);
  else process.exitCode = 7;
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

for (const hold of [false, true]) {
  test(
    `real stores override remote URLs and clean up after ${hold ? 'SIGTERM' : 'command failure'}`,
    {
      skip: !realStores,
      timeout: 60_000,
    },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-store-runner-test-'));
      const resultPath = join(directory, 'result.json');
      const child = spawn(
        process.execPath,
        [
          runner,
          ...(hold ? ['--profile=split-load'] : []),
          '--',
          process.execPath,
          '-e',
          childSource,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            DATABASE_URL: 'postgresql://invalid.invalid/never',
            REDIS_URL: 'redis://invalid.invalid',
            CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: 'postgresql://invalid.invalid/never',
            MAXIM_TEST_POSTGRES_URL: 'postgresql://invalid.invalid/never',
            MAXIM_TEST_REDIS_URL: 'redis://invalid.invalid',
            MAXIM_STORE_TEST_RESULT: resultPath,
            MAXIM_STORE_TEST_HOLD: hold ? '1' : '0',
            TZ: 'Europe/Moscow',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const done = new Promise((resolve) => child.once('close', (code) => resolve(code)));
      try {
        if (hold) {
          const deadline = Date.now() + 40_000;
          while (!existsSync(resultPath) && child.exitCode === null && Date.now() < deadline)
            await delay(50);
          assert.ok(existsSync(resultPath), output);
          child.kill('SIGTERM');
        }
        assert.equal(await done, hold ? 143 : 7, output);
        const info = JSON.parse(await readFile(resultPath, 'utf8'));
        assert.equal(existsSync(info.directory), false, 'temporary data must be removed');
        assert.equal(await portOpen(info.postgresPort), false, 'PostgreSQL must be stopped');
        assert.equal(await portOpen(info.redisPort), false, 'Redis must be stopped');
        assert.match(output, /Owned processes stopped/u);
        assert.doesNotMatch(output, /postgresql:\/\//u, 'credentials/URLs must not be printed');
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await done;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

const migratedChildSource = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {Client} = require('pg');
(async () => {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /race_test/);
  assert.equal(process.env.DATABASE_URL, process.env.MAXIM_TEST_POSTGRES_URL);
  const pg = new Client({connectionString: process.env.DATABASE_URL});
  try {
    await pg.connect();
    assert.equal((await pg.query('SHOW TimeZone')).rows[0].TimeZone, 'UTC');
    assert(Number((await pg.query('SELECT count(*) FROM _prisma_migrations')).rows[0].count) > 0);
    const directory = path.dirname((await pg.query('SHOW data_directory')).rows[0].data_directory);
    const redisUrl = new URL(process.env.REDIS_URL);
    fs.writeFileSync(process.env.MAXIM_STORE_TEST_RESULT, JSON.stringify({
      directory, postgresPort: Number(url.port), redisPort: Number(redisUrl.port)
    }), {mode: 0o600});
    fs.writeFileSync(process.env.MAXIM_STORE_TEST_CHILD_MARKER, 'accepted', {mode: 0o600});
  } finally { await pg.end(); }
})().catch(() => { console.error('MIGRATED_STORE_CHILD_FAILED'); process.exitCode = 1; });
`;

const driftNpmShim = String.raw`#!/usr/bin/env node
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {Client} = require(path.join(process.env.MAXIM_STORE_TEST_REPO, 'node_modules/pg'));
(async () => {
  const args = process.argv.slice(2);
  const result = spawnSync('npm', args, {
    env: {...process.env, PATH: process.env.MAXIM_STORE_TEST_ORIGINAL_PATH},
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024
  });
  if (args[1] === 'prisma:check:drift') {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Migrated PostgreSQL schema differs from the committed known-drift baseline/);
    assert.match(result.stderr, /chat_admin_allowlist_chat_id_fkey/);
    fs.writeFileSync(process.env.MAXIM_STORE_TEST_REJECTION_PROOF, 'public-checker-fk-mismatch', {mode: 0o600});
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    // Test privacy only after proving that the public checker found the real FK drift.
    process.stderr.write(process.env.DATABASE_URL + '\n' + new URL(process.env.DATABASE_URL).password);
    process.exitCode = 1;
    return;
  }
  if (result.error || result.status !== 0) {
    console.error('MIGRATION_FIXTURE_COMMAND_FAILED');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (args[1] !== 'prisma:migrate:deploy') return;
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /race_test/);
  const pg = new Client({connectionString: process.env.DATABASE_URL});
  try {
    await pg.connect();
    const query = "SELECT confupdtype FROM pg_constraint WHERE conrelid='public.chat_admin_allowlist'::regclass AND conname='chat_admin_allowlist_chat_id_fkey'";
    assert.equal((await pg.query(query)).rows[0].confupdtype, 'c');
    await pg.query('BEGIN');
    await pg.query('ALTER TABLE public.chat_admin_allowlist DROP CONSTRAINT chat_admin_allowlist_chat_id_fkey');
    await pg.query('ALTER TABLE public.chat_admin_allowlist ADD CONSTRAINT chat_admin_allowlist_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE ON UPDATE NO ACTION');
    await pg.query('COMMIT');
    assert.equal((await pg.query(query)).rows[0].confupdtype, 'a');
    const directory = path.dirname((await pg.query('SHOW data_directory')).rows[0].data_directory);
    const redisUrl = new URL(process.env.REDIS_URL);
    fs.writeFileSync(process.env.MAXIM_STORE_TEST_RESULT, JSON.stringify({
      directory, postgresPort: Number(url.port), redisPort: Number(redisUrl.port)
    }), {mode: 0o600});
  } finally { await pg.end(); }
})().catch(() => { console.error('DRIFT_FIXTURE_FAILED'); process.exitCode = 1; });
`;

for (const drift of [false, true]) {
  test(
    `real migrated stores ${drift ? 'reject changed FK semantics before the child' : 'accept the public baseline before the child'} and clean up`,
    { skip: !realStores, timeout: 120_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-store-parity-test-'));
      const resultPath = join(directory, 'result.json');
      const markerPath = join(directory, 'child-marker');
      const rejectionProofPath = join(directory, 'rejection-proof');
      if (drift) {
        await writeFile(join(directory, 'npm'), driftNpmShim);
        await chmod(join(directory, 'npm'), 0o700);
      }
      const child = spawn(
        process.execPath,
        [runner, '--migrate', '--', process.execPath, '-e', migratedChildSource],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: drift ? `${directory}:${process.env.PATH}` : process.env.PATH,
            DATABASE_URL: 'postgresql://invalid.invalid/never',
            MAXIM_STORE_TEST_REPO: root,
            MAXIM_STORE_TEST_ORIGINAL_PATH: process.env.PATH,
            MAXIM_STORE_TEST_RESULT: resultPath,
            MAXIM_STORE_TEST_CHILD_MARKER: markerPath,
            MAXIM_STORE_TEST_REJECTION_PROOF: rejectionProofPath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const done = new Promise((resolve) => child.once('close', (code) => resolve(code)));
      try {
        assert.equal(await done, drift ? 1 : 0, output);
        assert.equal(existsSync(markerPath), !drift, 'drift must reject before starting the child');
        assert.equal(
          existsSync(resultPath),
          true,
          'the real migration/catalog fixture must finish',
        );
        const info = JSON.parse(await readFile(resultPath, 'utf8'));
        assert.equal(existsSync(info.directory), false, 'temporary data must be removed');
        assert.equal(await portOpen(info.postgresPort), false, 'PostgreSQL must be stopped');
        assert.equal(await portOpen(info.redisPort), false, 'Redis must be stopped');
        assert.match(output, /Owned processes stopped/u);
        assert.doesNotMatch(
          output,
          /postgresql:\/\//u,
          'captured Prisma failures must stay private',
        );
        if (drift) {
          assert.equal(await readFile(rejectionProofPath, 'utf8'), 'public-checker-fk-mismatch');
          assert.match(output, /TEST_STORE_SCHEMA_DRIFT_CHECK_FAILED/u);
          assert.doesNotMatch(output, /Migrated PostgreSQL matches/u);
        } else {
          assert.match(output, /Migrated PostgreSQL matches the reviewed Prisma drift baseline/u);
        }
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await done;
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
