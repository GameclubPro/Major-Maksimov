import {
  ROUTING_INDEX_TARGET,
  verifyRoutingIndexDatabaseUrl,
} from '../../scripts/agent/routing-index-online-target.mjs';
import { verifyMultibotOnlineClientConfiguration } from './multibot-online-client.mjs';
import {
  parseCapacityFilesystem,
  validateMultibotComposeArgs,
} from './multibot-prepare-capacity.mjs';
import { OUTCOME_COHORT_MINIMUM_FREE_BYTES } from './outcome-cohort-prepare-capacity.mjs';
import { runOutcomeCohortCommand } from './outcome-cohort-online-state.mjs';
import { readReleaseRoutingState, readRoutingIndexState } from './routing-index-online-state.mjs';

const fail = (code) => {
  throw new Error(`ROUTING_INDEX_${code}`);
};
const spammerProjectionTarget = Object.freeze({
  selector: 'spammer_projection',
  table: 'spammer_observations',
  tableCeilingBytes: 3 * 1024 ** 3,
  estimateBytesPerRow: 256,
  tempBytes: 256 * 1024 ** 2,
});

function capacitySql(target) {
  return `BEGIN READ ONLY;
SET LOCAL statement_timeout = '2500ms';
SET LOCAL lock_timeout = '250ms';
SET LOCAL max_parallel_workers_per_gather = 0;
SELECT json_build_object('tableBytes',pg_table_size(parent.oid),'approxRows',parent.reltuples,
 'exact',COALESCE(parent.relkind='r' AND parent.relpersistence='p' AND parent.reltablespace=0
   AND NOT parent.relhassubclass AND NOT parent.relispartition
   AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid=parent.oid OR i.inhparent=parent.oid),false),
 'maxWalBytes',pg_size_bytes(current_setting('max_wal_size')),
 'dataDirectory',current_setting('data_directory'), 'tempTablespaces',current_setting('temp_tablespaces'),
 'defaultLayout',dattablespace=1663 AND current_setting('default_tablespace')='')
FROM pg_database LEFT JOIN pg_class parent ON parent.oid=to_regclass('public.${target.table}')
WHERE datname=current_database();
COMMIT;`;
}

export const routingIndexCapacitySql = capacitySql(ROUTING_INDEX_TARGET);

export function assessRoutingIndexPrepareCapacity(metadata, filesystems) {
  return assessCapacity(metadata, filesystems, ROUTING_INDEX_TARGET);
}

function assessCapacity(metadata, filesystems, target) {
  if (
    !metadata?.defaultLayout ||
    metadata.tempTablespaces !== '' ||
    metadata.exact !== true ||
    !Number.isSafeInteger(metadata.tableBytes) ||
    metadata.tableBytes < 0 ||
    !Number.isFinite(metadata.approxRows) ||
    metadata.approxRows < 0 ||
    !Number.isSafeInteger(metadata.maxWalBytes) ||
    metadata.maxWalBytes < 0
  )
    fail('CAPACITY_METADATA_INVALID');
  if (metadata.tableBytes > target.tableCeilingBytes) fail('TABLE_SCOPE_EXCEEDED');
  const indexBytes = Math.ceil(
    Math.max(metadata.tableBytes, metadata.approxRows * target.estimateBytesPerRow),
  );
  const budgets = {
    data: indexBytes,
    temp: target.tempBytes,
    wal: Math.max(indexBytes * 2, metadata.maxWalBytes * 2),
    docker: 0,
  };
  if (!Object.values(budgets).every(Number.isSafeInteger)) fail('CAPACITY_METADATA_INVALID');
  const devices = new Map();
  for (const role of ['data', 'temp', 'wal', 'docker']) {
    const fs = filesystems[role];
    if (
      !fs?.device ||
      !fs.mount ||
      !Number.isSafeInteger(fs.availableBytes) ||
      fs.availableBytes < 0
    )
      fail('FILESYSTEM_INVALID');
    const device = devices.get(fs.device) ?? {
      ...fs,
      roles: [],
      requiredBytes: OUTCOME_COHORT_MINIMUM_FREE_BYTES,
    };
    device.availableBytes = Math.min(device.availableBytes, fs.availableBytes);
    device.roles.push(role);
    device.requiredBytes += budgets[role];
    if (!Number.isSafeInteger(device.requiredBytes)) fail('CAPACITY_METADATA_INVALID');
    devices.set(fs.device, device);
  }
  return {
    estimates: [
      {
        selector: target.selector,
        indexBytes,
        tempBytes: budgets.temp,
        tableBytes: metadata.tableBytes,
      },
    ],
    budgets,
    minimumFreeBytes: OUTCOME_COHORT_MINIMUM_FREE_BYTES,
    devices: [...devices.values()].map((device) => ({
      ...device,
      sufficient: device.availableBytes >= device.requiredBytes,
    })),
  };
}

export function checkRoutingIndexPrepareCapacity(composeArgs, options) {
  return checkCapacity(composeArgs, ROUTING_INDEX_TARGET, readRoutingIndexState, options);
}

export function validateSpammerReleaseIdentity(sha, env) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? '') || sha !== env.MAXIM_EXPECTED_DEPLOY_SHA)
    fail('TARGET_INVALID');
}

export async function readSpammerProjectionPrepareState(sha, composeArgs, options = {}) {
  validateSpammerReleaseIdentity(sha, options.env ?? process.env);
  const release = await (options.readReleaseState ?? readReleaseRoutingState)(sha, composeArgs, {
    root: options.root,
    run: options.run,
    requireSpammerDeferral: true,
  });
  if (release === 'compatible_pending') return { state: 'already_applied', pending: [] };
  if (release === 'prepare_spammer_deferral')
    return { state: 'prepare_spammer_deferral', pending: [spammerProjectionTarget.selector] };
  fail('STATE_INVALID');
}

export function checkSpammerProjectionPrepareCapacity(sha, composeArgs, options = {}) {
  validateSpammerReleaseIdentity(sha, options.env ?? process.env);
  return checkCapacity(
    composeArgs,
    spammerProjectionTarget,
    (args, stateOptions) =>
      readSpammerProjectionPrepareState(sha, args, { ...options, ...stateOptions }),
    options,
  );
}

async function checkCapacity(
  composeArgs,
  target,
  readState,
  { run = runOutcomeCohortCommand, state, root = process.cwd(), env = process.env } = {},
) {
  validateMultibotComposeArgs(composeArgs);
  try {
    const config = await run('docker', ['compose', ...composeArgs, 'config', '--format', 'json']);
    const checked = verifyMultibotOnlineClientConfiguration(
      JSON.parse(config.stdout),
      composeArgs,
      env.MAXIM_EXPECTED_DEPLOY_SHA,
    );
    verifyRoutingIndexDatabaseUrl(checked.databaseUrl);
  } catch (error) {
    if (/^ROUTING_INDEX_[A-Z_]+$/u.test(error?.message ?? '')) throw error;
    fail('CLIENT_CONFIGURATION_INVALID');
  }
  const current = state ?? (await readState(composeArgs, { root, run }));
  if (current.state === 'already_applied') return { state: current, skipped: true };
  if (
    current.state !==
      (target === ROUTING_INDEX_TARGET ? 'prepare_routing' : 'prepare_spammer_deferral') ||
    current.pending?.length !== 1 ||
    current.pending[0] !== target.selector
  )
    fail('STATE_INVALID');
  try {
    const pg = ['compose', ...composeArgs, 'exec', '-T', 'postgres'];
    const result = await run(
      'docker',
      [...pg, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'maxim', '-d', 'maxim', '-Atq'],
      { input: capacitySql(target) },
    );
    const metadata = JSON.parse(result.stdout.trim());
    if (typeof metadata.dataDirectory !== 'string' || !metadata.dataDirectory.startsWith('/'))
      fail('FILESYSTEM_INVALID');
    const wal = (
      await run('docker', [
        ...pg,
        'sh',
        '-c',
        'readlink -f "$1/pg_wal"',
        'routing-wal',
        metadata.dataDirectory,
      ])
    ).stdout.trim();
    if (!wal.startsWith('/')) fail('FILESYSTEM_INVALID');
    const data = parseCapacityFilesystem(
      (await run('docker', [...pg, 'df', '-Pk', metadata.dataDirectory])).stdout,
    );
    const walFs = parseCapacityFilesystem((await run('docker', [...pg, 'df', '-Pk', wal])).stdout);
    const docker = parseCapacityFilesystem((await run('df', ['-Pk', '/var/lib/docker'])).stdout);
    const capacity = assessCapacity(
      metadata,
      {
        data,
        temp: data,
        wal: walFs,
        docker,
      },
      target,
    );
    if (capacity.devices.some((device) => !device.sufficient)) fail('CAPACITY_INSUFFICIENT');
    return {
      ...capacity,
      state: current,
      skipped: false,
      monitorPaths: { data: metadata.dataDirectory, wal, docker: '/var/lib/docker' },
    };
  } catch (error) {
    if (/^ROUTING_INDEX_[A-Z_]+$/u.test(error?.message ?? '')) throw error;
    fail('CAPACITY_UNAVAILABLE');
  }
}
