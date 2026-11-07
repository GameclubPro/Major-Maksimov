#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');

export function parseArgs(args) {
  const separator = args.indexOf('--');
  if (
    separator < 0 ||
    !args[separator + 1] ||
    args.slice(0, separator).some((x) => !['--migrate', '--profile=split-load'].includes(x)) ||
    new Set(args.slice(0, separator)).size !== separator
  ) {
    throw new Error(
      'Usage: node scripts/agent/with-test-stores.mjs [--migrate] [--profile=split-load] -- <command> [args...]',
    );
  }
  return {
    migrate: args.slice(0, separator).includes('--migrate'),
    ...(args.slice(0, separator).includes('--profile=split-load') ? { profile: 'split-load' } : {}),
    command: args.slice(separator + 1),
  };
}

export async function startTestStoreCommand(options, { run, start, log = console.log }) {
  if (options.migrate) {
    await run('npm', ['run', 'prisma:migrate:deploy', '--workspace', '@maxim/api']);
    try {
      await run('npm', ['run', 'prisma:check:drift', '--workspace', '@maxim/api']);
    } catch {
      // FLAG: Prisma failures can contain private connection credentials. Expose
      // a fixed stage failure while the owned-store finally still performs cleanup.
      throw new Error('TEST_STORE_SCHEMA_DRIFT_CHECK_FAILED: requested command was not started.');
    }
    log('[test-stores] Migrated PostgreSQL matches the reviewed Prisma drift baseline.');
  }
  return start(options.command[0], options.command.slice(1));
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export async function withTestStores(options) {
  if (options.profile !== undefined && options.profile !== 'split-load')
    throw new Error('Unknown disposable store profile');
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    throw new Error(
      'Use a non-root Linux/macOS shell (WSL on Windows) with PostgreSQL 16 and Redis 7 on PATH.',
    );
  }
  const directory = await mkdtemp(join(tmpdir(), 'maxim-test-stores-'));
  const children = new Set();
  let interrupted = 0;
  let commandChild;
  let postgres;
  let redis;
  const env = { ...process.env, TZ: 'UTC', PGOPTIONS: '-c timezone=UTC' };
  const start = (command, args, childEnv = env, inherit = false) => {
    if (interrupted) throw new Error('Local test run interrupted');
    const child = spawn(command, args, {
      cwd: root,
      env: childEnv,
      detached: true,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
        output = (output + chunk).slice(-16_384);
      });
    }
    child.done = new Promise((done) => {
      child.once('error', () =>
        done({ code: 1, output: `${command} unavailable; check PATH and native libraries.` }),
      );
      child.once('close', (code, signal) => {
        children.delete(child);
        done({ code: code ?? (signal ? 1 : 0), output });
      });
    });
    return child;
  };
  const run = async (command, args, childEnv = env) => {
    const result = await start(command, args, childEnv).done;
    if (result.code) throw new Error(`${command} failed: ${result.output}`);
    return result.output;
  };
  const signalGroup = (child, signal) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const onInterrupt = (signal) => {
    interrupted = signal === 'SIGINT' ? 130 : 143;
    // FLAG: Only process groups created by this invocation are signalled, never stored PIDs.
    for (const child of children) signalGroup(child, child === postgres ? 'SIGINT' : 'SIGTERM');
  };
  const onInt = () => onInterrupt('SIGINT');
  const onTerm = () => onInterrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    for (const [tool, pattern] of [
      ['postgres', /PostgreSQL\) 16\./u],
      ['redis-server', /v=7\./u],
    ]) {
      if (!pattern.test(await run(tool, ['--version'])))
        throw new Error(`${tool}: expected CI-compatible PostgreSQL 16 / Redis 7`);
    }
    const postgresPort = await freePort();
    let redisPort = await freePort();
    while (redisPort === postgresPort) redisPort = await freePort();
    const password = randomBytes(24).toString('hex');
    const database = `maxim_race_test_${randomBytes(8).toString('hex')}`;
    const passwordFile = join(directory, 'password');
    await writeFile(passwordFile, password, { mode: 0o600 });
    await run('initdb', [
      '-D',
      join(directory, 'postgres'),
      '-U',
      'maxim_agent',
      '--encoding=UTF8',
      '--locale=C',
      '--auth-local=trust',
      '--auth-host=scram-sha-256',
      `--pwfile=${passwordFile}`,
    ]);
    postgres = start('postgres', [
      '-D',
      join(directory, 'postgres'),
      '-h',
      '127.0.0.1',
      '-p',
      String(postgresPort),
      '-k',
      directory,
      '-c',
      'timezone=UTC',
      '-c',
      // The isolated split fixture uses the real per-role pool caps (56 total).
      // Ordinary tests retain their smaller budget; this never changes a live DB.
      `max_connections=${options.profile === 'split-load' ? 100 : 40}`,
      '-c',
      'shared_buffers=64MB',
    ]);
    const redisConfig = join(directory, 'redis.conf');
    await writeFile(
      redisConfig,
      // FLAG: Existing real-store fixtures construct Redis connections from host/port only.
      // Match CI's local Redis contract; never expose this disposable instance off loopback.
      `bind 127.0.0.1\nport ${redisPort}\nprotected-mode yes\nunixsocket ${join(directory, 'redis.sock')}\nunixsocketperm 700\nsave ""\nappendonly no\ndaemonize no\n`,
      { mode: 0o600 },
    );
    redis = start('redis-server', [redisConfig]);
    const pgEnv = {
      ...env,
      PGHOST: directory,
      PGPORT: String(postgresPort),
      PGUSER: 'maxim_agent',
      PGDATABASE: 'postgres',
      PGPASSWORD: password,
    };
    const redisEnv = { ...env };
    delete redisEnv.REDISCLI_AUTH;
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline && !interrupted) {
      for (const child of [postgres, redis]) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Local store exited: ${(await child.done).output}`);
      }
      const pg = await start('pg_isready', ['-q', '-t', '1'], pgEnv).done;
      const ping = await start('redis-cli', ['-s', join(directory, 'redis.sock'), 'PING'], redisEnv)
        .done;
      if (!pg.code && !ping.code && ping.output.trim() === 'PONG') {
        ready = true;
        break;
      }
      await delay(100);
    }
    if (!ready) throw new Error('Local stores did not become ready within 20 seconds');
    const redisIdentity = await run(
      'redis-cli',
      ['-s', join(directory, 'redis.sock'), 'INFO', 'server'],
      redisEnv,
    );
    if (!redisIdentity.split(/\r?\n/u).includes(`process_id:${redis.pid}`)) {
      throw new Error('Disposable Redis process identity mismatch');
    }
    await run('createdb', [database], pgEnv);
    const timezone = await run('psql', ['-X', '-A', '-t', '-c', 'SHOW TimeZone'], {
      ...pgEnv,
      PGDATABASE: database,
    });
    if (timezone.trim() !== 'UTC') throw new Error('Disposable PostgreSQL must use UTC');
    // FLAG: Always replace inherited production/test URLs. This invocation owns a new empty
    // database, private credentials, loopback listeners and no pre-existing Redis data.
    const postgresUrl = `postgresql://maxim_agent:${password}@127.0.0.1:${postgresPort}/${database}?schema=public`;
    const redisUrl = `redis://127.0.0.1:${redisPort}/0`;
    Object.assign(env, {
      DATABASE_URL: postgresUrl,
      CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL: postgresUrl,
      MAXIM_TEST_POSTGRES_URL: postgresUrl,
      REDIS_URL: redisUrl,
      MAXIM_TEST_REDIS_URL: redisUrl,
    });
    console.log(
      '[test-stores] Private PostgreSQL 16 (UTC) and Redis 7 ready; URLs remain in child environment.',
    );
    commandChild = await startTestStoreCommand(options, {
      run,
      start: (command, args) => start(command, args, env, true),
    });
    const result = await commandChild.done;
    return interrupted || result.code;
  } finally {
    for (const child of children) signalGroup(child, child === postgres ? 'SIGINT' : 'SIGTERM');
    const allClosed = Promise.all([...children].map((child) => child.done));
    const timeout = setTimeout(() => {
      for (const child of children) signalGroup(child, 'SIGKILL');
    }, 10_000);
    try {
      await allClosed;
    } finally {
      clearTimeout(timeout);
    }
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    await rm(directory, { recursive: true, force: true });
    console.log('[test-stores] Owned processes stopped and temporary stores removed.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await withTestStores(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
