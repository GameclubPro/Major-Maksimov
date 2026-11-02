#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMultibotPrepareEnvironment } from './multibot-online-prepare.mjs';
import {
  readRoutingIndexSource,
  ROUTING_INDEX_TARGET,
  verifyRoutingIndexDatabaseUrl,
} from './routing-index-online-target.mjs';
import {
  routingIndexStateSql,
  verifyRoutingIndexState,
} from '../../infra/scripts/routing-index-online-state.mjs';

export function createRoutingIndexMigrationPrefix(root) {
  const source = readRoutingIndexSource(root);
  const migrationNames = source
    .filter(({ name }) => name <= ROUTING_INDEX_TARGET.migration)
    .map(({ name }) => name);
  const workspaceTemp = resolve(root, 'apps/api/.migration-prepare');
  mkdirSync(workspaceTemp, { recursive: true, mode: 0o700 });
  const tempRoot = mkdtempSync(resolve(workspaceTemp, 'routing-'));
  try {
    const migrationsPath = resolve(tempRoot, 'migrations');
    mkdirSync(migrationsPath, { mode: 0o700 });
    const directory = resolve(root, 'apps/api/prisma/migrations');
    cpSync(
      resolve(directory, 'migration_lock.toml'),
      resolve(migrationsPath, 'migration_lock.toml'),
    );
    for (const name of migrationNames)
      cpSync(resolve(directory, name), resolve(migrationsPath, name), { recursive: true });
    const configPath = resolve(tempRoot, 'prisma.config.ts');
    writeFileSync(
      configPath,
      `import { defineConfig, env } from 'prisma/config';
export default defineConfig({
  schema: ${JSON.stringify(resolve(root, 'apps/api/prisma/schema.prisma'))},
  migrations: { path: ${JSON.stringify(migrationsPath)} },
  datasource: { url: env('DATABASE_URL') },
});\n`,
      { mode: 0o600 },
    );
    return { tempRoot, configPath, migrationNames };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readState(databaseUrl, source) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    options: '-c statement_timeout=2500 -c lock_timeout=250 -c timezone=UTC',
  });
  try {
    await client.connect();
    const results = await client.query(routingIndexStateSql);
    const rows = (Array.isArray(results) ? results : [results]).flatMap((result) => result.rows);
    return verifyRoutingIndexState(rows[0]?.json_build_object, source);
  } finally {
    await client.end();
  }
}

export async function runRoutingIndexOnlinePrepare({
  root = process.cwd(),
  env = process.env,
  inspect = readState,
  runPrisma = spawnSync,
} = {}) {
  if (!env.DATABASE_URL?.trim() || !env.MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME)
    throw new Error('ROUTING_INDEX_TAGGED_DATABASE_REQUIRED');
  verifyRoutingIndexDatabaseUrl(env.DATABASE_URL);
  if (Object.hasOwn(env, 'PGOPTIONS')) throw new Error('ROUTING_INDEX_DATABASE_OPTIONS_BLOCKED');
  const prepareEnv = createMultibotPrepareEnvironment(env);
  const source = readRoutingIndexSource(root);
  const before = await inspect(prepareEnv.DATABASE_URL, source);
  if (before.state === 'already_applied') return { state: 'already_applied' };
  if (before.pending.length !== 1 || before.pending[0] !== 'routing')
    throw new Error('ROUTING_INDEX_STATE_INVALID');
  const prefix = createRoutingIndexMigrationPrefix(root);
  try {
    const result = runPrisma(
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
        env: prepareEnv,
        stdio: 'ignore',
        timeout: ROUTING_INDEX_TARGET.statementMs + 30_000,
      },
    );
    if (result.error || result.signal || result.status !== 0)
      throw new Error('ROUTING_INDEX_PRISMA_DEPLOY_FAILED');
    const after = await inspect(prepareEnv.DATABASE_URL, source);
    if (after.state !== 'already_applied') throw new Error('ROUTING_INDEX_PREPARATION_INCOMPLETE');
    return { state: 'applied' };
  } finally {
    rmSync(prefix.tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (process.argv.length !== 2) throw new Error('ROUTING_INDEX_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await runRoutingIndexOnlinePrepare()));
  } catch {
    console.error('ROUTING_INDEX_PREPARATION_FAILED; receipts and indexes preserved.');
    process.exitCode = 1;
  }
}
