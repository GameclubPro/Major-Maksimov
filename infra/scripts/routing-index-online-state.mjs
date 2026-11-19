import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  readRoutingIndexSource,
  ROUTING_INDEX_TARGET,
} from '../../scripts/agent/routing-index-online-target.mjs';
import { OUTCOME_COHORT_TARGETS } from '../../scripts/agent/outcome-cohort-online-targets.mjs';
import {
  GIVEAWAY_DEFERRAL_MIGRATIONS,
  routingIndexStateSql,
  verifyGiveawayDeferralState,
  verifyRoutingIndexState,
} from '../../scripts/agent/routing-index-catalog.mjs';
import { runOutcomeCohortCommand } from './outcome-cohort-online-state.mjs';

export { routingIndexStateSql, verifyRoutingIndexState };

const fail = (code) => {
  throw new Error(`ROUTING_INDEX_${code}`);
};

const migrationPath = 'apps/api/prisma/migrations';
const routingService = 'apps/api/src/webhook/webhook-routing.service.ts';
const retiredMigration = '20261103120000_index_webhook_chat_queue_head';
const compatibilityMarker =
  '// FLAG: Routing uses the existing ordered chat head index without the optional queue index.';

export function readReleaseRoutingSource(root, sha) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? '')) fail('TARGET_INVALID');
  const git = (args, input) =>
    execFileSync('git', ['--no-replace-objects', ...args], {
      cwd: root,
      input,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  if (git(['cat-file', '-t', sha]).toString().trim() !== 'commit') fail('TARGET_INVALID');
  const tree = git([
    'ls-tree',
    '--full-tree',
    '-r',
    '-z',
    sha,
    '--',
    migrationPath,
    routingService,
  ]).toString();
  const migrations = [];
  let serviceOid;
  for (const entry of tree.split('\0').filter(Boolean)) {
    const match = /^100644 blob ([a-f0-9]{40})\t([^\n]+)$/u.exec(entry);
    if (!match) fail('TARGET_SOURCE_INVALID');
    const [, oid, path] = match;
    if (path === routingService) serviceOid = oid;
    else if (path === migrationPath + '/migration_lock.toml') continue;
    else {
      const name = /^apps\/api\/prisma\/migrations\/(\d{14}_[a-z0-9_]+)\/migration\.sql$/u.exec(
        path,
      )?.[1];
      if (!name || name === retiredMigration) fail('TARGET_SOURCE_INVALID');
      migrations.push({ name, oid });
    }
  }
  if (!serviceOid || !migrations.length || migrations.length > 4032) fail('TARGET_SOURCE_INVALID');
  if (!migrations.some(({ name }) => name === ROUTING_INDEX_TARGET.migration)) {
    // FLAG: A release deleting the migration must not impersonate a pre-routing release.
    if (
      migrations.some(({ name }) => name > ROUTING_INDEX_TARGET.migration) ||
      git([
        'log',
        '-1',
        '--full-history',
        '--format=%H',
        sha,
        '--',
        migrationPath + '/' + ROUTING_INDEX_TARGET.migration,
        migrationPath + '/' + retiredMigration,
      ]).length
    )
      fail('TARGET_SOURCE_INVALID');
    return { state: 'not_in_target' };
  }
  // FLAG: Read only the immutable blobs named by the target, including on rollback
  // from a different controller checkout. Each batch frame includes its object ID and size.
  const blobs = [...migrations.map(({ oid }) => oid), serviceOid];
  const data = git(['cat-file', '--batch'], blobs.join('\n') + '\n');
  let offset = 0;
  const readBlob = (oid) => {
    const end = data.indexOf(10, offset);
    if (end < offset) fail('TARGET_SOURCE_INVALID');
    const [id, type, size] = data.toString('ascii', offset, end).split(' ');
    if (id !== oid || type !== 'blob' || !/^[1-9]\d{0,6}$/u.test(size))
      fail('TARGET_SOURCE_INVALID');
    const next = end + 1 + Number(size);
    if (data[next] !== 10) fail('TARGET_SOURCE_INVALID');
    offset = next + 1;
    return data.subarray(end + 1, next);
  };
  const source = migrations.map(({ name, oid }) => ({
    name,
    checksum: createHash('sha256').update(readBlob(oid)).digest('hex'),
  }));
  const supportsOrdered = readBlob(serviceOid)
    .toString()
    .split('\n')
    .some((line) => line.trim() === compatibilityMarker);
  if (offset !== data.length) fail('TARGET_SOURCE_INVALID');
  for (const target of [...OUTCOME_COHORT_TARGETS, ROUTING_INDEX_TARGET])
    if (source.find(({ name }) => name === target.migration)?.checksum !== target.checksum)
      fail('TARGET_SOURCE_INVALID');
  return { source, supportsOrdered };
}

async function readSnapshot(composeArgs, run) {
  try {
    const result = await run(
      'docker',
      [
        'compose',
        ...composeArgs,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'maxim',
        '-d',
        'maxim',
        '-Atq',
      ],
      { input: routingIndexStateSql },
    );
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    if (/^ROUTING_INDEX_[A-Z_]+$/u.test(error?.message ?? '')) throw error;
    fail('STATE_UNAVAILABLE');
  }
}

async function validateCompose(composeArgs) {
  const { validateMultibotComposeArgs } = await import('./multibot-prepare-capacity.mjs');
  validateMultibotComposeArgs(composeArgs);
}

export async function readRoutingIndexState(
  composeArgs,
  { root = process.cwd(), run = runOutcomeCohortCommand } = {},
) {
  await validateCompose(composeArgs);
  const source = readRoutingIndexSource(root);
  return verifyRoutingIndexState(await readSnapshot(composeArgs, run), source);
}

export function verifyReleaseRoutingState(snapshot, { source, supportsOrdered }) {
  const { state } = verifyRoutingIndexState(snapshot, source);
  if (
    state === 'prepare_routing' &&
    supportsOrdered === true &&
    snapshot.orderedIndex?.present === true &&
    snapshot.orderedIndex.exact === true
  ) {
    if (source.at(-1)?.name === ROUTING_INDEX_TARGET.migration) return 'compatible_pending';
    if (source.at(-1)?.name === GIVEAWAY_DEFERRAL_MIGRATIONS.at(-1).name)
      return verifyGiveawayDeferralState(snapshot, source).state;
  }
  return state;
}

export async function readReleaseRoutingState(
  sha,
  composeArgs,
  { root = process.cwd(), run = runOutcomeCohortCommand } = {},
) {
  await validateCompose(composeArgs);
  const release = readReleaseRoutingSource(root, sha);
  if (release.state === 'not_in_target') return release.state;
  return verifyReleaseRoutingState(await readSnapshot(composeArgs, run), release);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'release-state') {
      const [sha, ...compose] = args;
      console.log(await readReleaseRoutingState(sha, compose));
    } else if (mode === 'assert') {
      const state = await readRoutingIndexState(args);
      if (state.state !== 'already_applied') fail('PREPARATION_INCOMPLETE');
      console.log(JSON.stringify({ stage: 'routing_index_assert', state: state.state }));
    } else fail('ARGUMENTS_INVALID');
  } catch {
    console.error('ROUTING_INDEX_ASSERT_FAILED');
    process.exitCode = 1;
  }
}
