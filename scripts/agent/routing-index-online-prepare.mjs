#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMultibotPrepareEnvironment } from './multibot-online-prepare.mjs';
import {
  readRoutingIndexSource,
  ROUTING_INDEX_TARGET,
  verifyRoutingIndexDatabaseUrl,
} from './routing-index-online-target.mjs';
import {
  GIVEAWAY_DEFERRAL_MIGRATIONS,
  PUBLISHER_DEFERRAL_MIGRATIONS,
  SPAMMER_DEFERRAL_MIGRATIONS,
  verifyPublisherDeferralState,
  verifySpammerDeferralState,
  routingIndexStateSql,
  verifyGiveawayDeferralState,
  verifyRoutingIndexState,
} from './routing-index-catalog.mjs';

export function createRoutingIndexMigrationPrefix(root) {
  const source = readRoutingIndexSource(root);
  return createMigrationDirectory(
    root,
    source.filter(({ name }) => name <= ROUTING_INDEX_TARGET.migration),
  );
}

function createMigrationDirectory(root, migrations) {
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
    for (const { name, checksum } of migrations) {
      const sql = readFileSync(resolve(directory, name, 'migration.sql'));
      if (createHash('sha256').update(sql).digest('hex') !== checksum)
        throw new Error('ROUTING_INDEX_SOURCE_CHECKSUM_MISMATCH');
      mkdirSync(resolve(migrationsPath, name), { mode: 0o700 });
      writeFileSync(resolve(migrationsPath, name, 'migration.sql'), sql, { mode: 0o600 });
    }
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
    return { tempRoot, configPath, migrationNames: migrations.map(({ name }) => name) };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function createSpammerDeferralPrismaEnvironment(env) {
  // FLAG: Caller-provided session options are rejected before adding these fixed limits.
  // Prisma forwards the URL's options to PostgreSQL; PGOPTIONS does not reach its migration session.
  const database = new URL(env.DATABASE_URL);
  database.searchParams.set(
    'options',
    '-c lock_timeout=5s -c statement_timeout=45s -c temp_file_limit=256MB ' +
      '-c maintenance_work_mem=64MB -c max_parallel_maintenance_workers=0',
  );
  return { ...env, DATABASE_URL: database.toString() };
}

async function readState(databaseUrl, source, verify = verifyRoutingIndexState) {
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
    return verify(rows[0]?.json_build_object, source);
  } finally {
    await client.end();
  }
}

export async function runRoutingIndexOnlinePrepare({
  root = process.cwd(),
  env = process.env,
  inspect = readState,
  runPrisma = spawnSync,
  giveawayDeferral = false,
  publisherDeferral = false,
  spammerDeferral = false,
} = {}) {
  if ([giveawayDeferral, publisherDeferral, spammerDeferral].filter(Boolean).length > 1)
    throw new Error('ROUTING_INDEX_ARGUMENTS_INVALID');
  const deferral = giveawayDeferral || publisherDeferral || spammerDeferral;
  if (
    !env.DATABASE_URL?.trim() ||
    ((!deferral || spammerDeferral) && !env.MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME)
  )
    throw new Error('ROUTING_INDEX_TAGGED_DATABASE_REQUIRED');
  verifyRoutingIndexDatabaseUrl(env.DATABASE_URL);
  if (Object.hasOwn(env, 'PGOPTIONS')) throw new Error('ROUTING_INDEX_DATABASE_OPTIONS_BLOCKED');
  const prepareEnv = createMultibotPrepareEnvironment(
    deferral && !spammerDeferral
      ? { ...env, MAXIM_MULTIBOT_PREPARE_APPLICATION_NAME: `maxim-online-${randomUUID()}` }
      : env,
  );
  const source = readRoutingIndexSource(root);
  const verify = spammerDeferral
    ? verifySpammerDeferralState
    : publisherDeferral
      ? verifyPublisherDeferralState
      : giveawayDeferral
        ? verifyGiveawayDeferralState
        : verifyRoutingIndexState;
  const complete = deferral ? 'compatible_pending' : 'already_applied';
  const before = await inspect(prepareEnv.DATABASE_URL, source, verify);
  if (before.state === complete) return { state: complete };
  const expected = spammerDeferral
    ? 'prepare_spammer_deferral'
    : publisherDeferral
      ? 'prepare_publisher_deferral'
      : giveawayDeferral
        ? 'prepare_giveaway_deferral'
        : 'prepare_routing';
  if (
    before.state !== expected ||
    (!deferral && (before.pending.length !== 1 || before.pending[0] !== 'routing'))
  )
    throw new Error('ROUTING_INDEX_STATE_INVALID');
  // FLAG: The deferral path gives Prisma the verified historical prefix and exactly the pinned additive tail.
  const migrations = deferral
    ? [
        ...source.filter(({ name }) => name < ROUTING_INDEX_TARGET.migration),
        ...(publisherDeferral || spammerDeferral
          ? PUBLISHER_DEFERRAL_MIGRATIONS
          : GIVEAWAY_DEFERRAL_MIGRATIONS),
        ...(spammerDeferral ? SPAMMER_DEFERRAL_MIGRATIONS : []),
      ]
    : source.filter(({ name }) => name <= ROUTING_INDEX_TARGET.migration);
  const prefix = createMigrationDirectory(root, migrations);
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
        env: spammerDeferral ? createSpammerDeferralPrismaEnvironment(prepareEnv) : prepareEnv,
        stdio: 'ignore',
        timeout: deferral ? 60_000 : ROUTING_INDEX_TARGET.statementMs + 30_000,
      },
    );
    if (result.error || result.signal || result.status !== 0)
      throw new Error('ROUTING_INDEX_PRISMA_DEPLOY_FAILED');
    const after = await inspect(prepareEnv.DATABASE_URL, readRoutingIndexSource(root), verify);
    if (after.state !== complete) throw new Error('ROUTING_INDEX_PREPARATION_INCOMPLETE');
    return { state: deferral ? complete : 'applied' };
  } finally {
    rmSync(prefix.tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const giveawayDeferral = process.argv.length === 3 && process.argv[2] === '--giveaway-deferral';
    const publisherDeferral =
      process.argv.length === 3 && process.argv[2] === '--publisher-deferral';
    const spammerDeferral = process.argv.length === 3 && process.argv[2] === '--spammer-deferral';
    if (process.argv.length !== 2 && !giveawayDeferral && !publisherDeferral && !spammerDeferral)
      throw new Error('ROUTING_INDEX_ARGUMENTS_INVALID');
    console.log(
      JSON.stringify(
        await runRoutingIndexOnlinePrepare({
          giveawayDeferral,
          publisherDeferral,
          spammerDeferral,
        }),
      ),
    );
  } catch {
    console.error('ROUTING_INDEX_PREPARATION_FAILED; receipts and indexes preserved.');
    process.exitCode = 1;
  }
}
