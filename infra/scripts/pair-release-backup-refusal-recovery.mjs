#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, lstat, readFile, readlink, mkdir, chown } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { dirname } from 'node:path';

const execute = promisify(execFile);
const LEGACY_SOURCE = '895cc0cbe10bae80a3379348fc98a355699d20d2';
const ROOT = '/var/lib/major-karavan-release';
const MAJOR = '/var/www/Chat_bot';
const KARAVAN = '/var/www/max-delivery-platform';
const OWNER = `${ROOT}/state/admission.owner`;
const UNIT = 'maxim-postgres-backup.service';
const REFUSAL = 'Refusing PostgreSQL backup while a deployment or maintenance operation is active.';
const LOCKS = [
  `${ROOT}/state/admission.lock`,
  '/var/lib/maxim-deploy/deploy.lock',
  `${KARAVAN}/var/ops/karavan-production-operation.lock`,
];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const requireFact = (value, code) => {
  if (!value) fail(code);
};

export function parseBackupRefusalRecoveryArgs(args) {
  const [mode, ...rest] = args;
  requireFact(['preview', 'apply'].includes(mode) && rest.length === 10, 'invalid_arguments');
  const keys = {
    '--owner-sha256': 'ownerSha256',
    '--initial-state-sha256': 'initialStateSha256',
    '--state-sha256': 'stateSha256',
    '--source-sha': 'sourceSha',
    '--invocation-id': 'invocationId',
  };
  const result = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = keys[rest[index]];
    requireFact(key && result[key] === undefined, 'invalid_arguments');
    result[key] = rest[index + 1];
  }
  requireFact(
    ['ownerSha256', 'initialStateSha256', 'stateSha256'].every((key) =>
      /^[a-f0-9]{64}$/u.test(result[key] ?? ''),
    ) &&
      result.sourceSha === LEGACY_SOURCE &&
      /^[a-f0-9]{32}$/u.test(result.invocationId ?? ''),
    'invalid_identity',
  );
  return result;
}

function parseOwner(bytes) {
  requireFact(bytes.length === 393, 'unexpected_owner_size');
  const entries = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const at = line.indexOf('=');
      requireFact(at > 0, 'invalid_owner');
      return [line.slice(0, at), line.slice(at + 1)];
    });
  const expected = [
    'protocol',
    'token',
    'product',
    'mode',
    'target',
    'pid',
    'start',
    'boot',
    'cwd',
    'fd',
    'inode',
    'initial_state',
    'started_at',
  ];
  requireFact(
    entries.length === expected.length && entries.every(([key], index) => key === expected[index]),
    'invalid_owner',
  );
  const owner = Object.fromEntries(entries);
  requireFact(
    owner.protocol === 'major-karavan-release-v1' &&
      owner.product === 'major' &&
      owner.mode === 'runtime' &&
      owner.target === '' &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(owner.token) &&
      /^[1-9][0-9]*$/u.test(owner.pid) &&
      /^[0-9]+$/u.test(owner.start) &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(owner.boot) &&
      owner.cwd === sha256(MAJOR) &&
      /^[1-9][0-9]{1,5}$/u.test(owner.fd) &&
      /^[0-9]+:[0-9]+$/u.test(owner.inode) &&
      /^[a-f0-9]{64}$/u.test(owner.initial_state) &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(owner.started_at) &&
      Number.isFinite(Date.parse(owner.started_at)) &&
      new Date(owner.started_at).toISOString() === owner.started_at,
    'unexpected_owner_scope',
  );
  return owner;
}

// FLAG: This is only the known root-owned, pre-product-lock backup refusal. It grants
// no recovery authority to a started dump, release, unknown effect or different owner.
export function buildBackupRefusalProof(request, observation) {
  requireFact(request.sourceSha === LEGACY_SOURCE, 'unreviewed_legacy_source');
  requireFact(
    observation.root === true && observation.locksHeld === true,
    'missing_recovery_locks',
  );
  requireFact(
    observation.ownerUid === 0 &&
      observation.ownerMode === 0o600 &&
      observation.ownerLinks === 1 &&
      observation.operatorUid > 0,
    'unexpected_owner_ownership',
  );
  const bytes = Buffer.from(observation.ownerBytes);
  const owner = parseOwner(bytes);
  requireFact(
    sha256(bytes) === request.ownerSha256 && owner.initial_state === request.initialStateSha256,
    'owner_changed',
  );
  requireFact(owner.inode === observation.admissionInode, 'admission_inode_changed');
  requireFact(
    owner.boot === observation.bootId && observation.originalProcessAbsent === true,
    'owner_process_not_proved_dead',
  );
  requireFact(
    observation.noActors === true &&
      observation.legacySourcesMatch === true &&
      observation.unitMatches === true,
    'execution_boundary_unproved',
  );
  const unit = observation.unit;
  const completedExit =
    (unit.ExecMainCode === '0' && unit.ExecMainStatus === '0' && unit.InvocationID === '') ||
    (unit.ExecMainCode === '1' &&
      unit.ExecMainStatus === '75' &&
      unit.InvocationID === request.invocationId);
  requireFact(
    unit.ActiveState === 'inactive' &&
      unit.SubState === 'dead' &&
      unit.MainPID === '0' &&
      unit.Result === 'success' &&
      completedExit &&
      ['', request.invocationId].includes(unit.InvocationID) &&
      unit.DropInPaths === '' &&
      unit.FragmentPath === `/etc/systemd/system/${UNIT}`,
    'backup_service_not_quiescent',
  );
  requireFact(observation.journal.length === 1, 'journal_outcome_incomplete');
  const entry = observation.journal[0];
  const observedAtMs = Number(entry.__REALTIME_TIMESTAMP) / 1000;
  requireFact(
    entry._SYSTEMD_INVOCATION_ID === request.invocationId &&
      entry._SYSTEMD_UNIT === UNIT &&
      entry._PID === owner.pid &&
      entry._UID === '0' &&
      entry._COMM === 'bash' &&
      entry.SYSLOG_IDENTIFIER === 'backup-postgres.sh' &&
      entry._BOOT_ID === owner.boot.replaceAll('-', '') &&
      entry.MESSAGE === REFUSAL &&
      Number.isSafeInteger(Number(entry.__REALTIME_TIMESTAMP)) &&
      observedAtMs >= Date.parse(owner.started_at) &&
      observedAtMs - Date.parse(owner.started_at) <= 5_000,
    'journal_refusal_unproved',
  );
  const snapshot = structuredClone(observation.snapshot);
  requireFact(
    snapshot.schemaVersion === 1 &&
      snapshot.protocol === 'major-karavan-release-v1' &&
      snapshot.major?.checkoutSha === LEGACY_SOURCE &&
      /^[a-f0-9]{40}$/u.test(snapshot.karavan?.checkoutSha ?? ''),
    'current_source_unproved',
  );
  requireFact(sha256(JSON.stringify(snapshot)) === request.stateSha256, 'pair_state_changed');
  snapshot.major.checkoutSha = null;
  snapshot.karavan.checkoutSha = null;
  requireFact(
    sha256(JSON.stringify(snapshot)) === owner.initial_state,
    'original_pair_state_changed',
  );
  return {
    schemaVersion: 1,
    kind: 'root-backup-pre-admission-refusal',
    ownerSha256: request.ownerSha256,
    initialStateSha256: owner.initial_state,
    stateSha256: request.stateSha256,
    sourceSha: LEGACY_SOURCE,
    invocationId: request.invocationId,
    ownerStartedAt: owner.started_at,
    refusalAt: new Date(observedAtMs).toISOString(),
    verification: 'exact_journal_refusal_before_product_admission',
  };
}

async function boundedFile(path, maximum) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    requireFact(
      before.isFile() && before.nlink === 1 && before.size <= maximum,
      'unsafe_input_file',
    );
    const bytes = await fd.readFile();
    const after = await fd.stat();
    const current = await lstat(path);
    requireFact(
      bytes.length <= maximum &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        current.dev === after.dev &&
        current.ino === after.ino &&
        !current.isSymbolicLink(),
      'input_file_changed',
    );
    return { bytes, stat: after };
  } finally {
    await fd.close();
  }
}

async function command(file, args, extra = {}) {
  try {
    return (await execute(file, args, { timeout: 10_000, maxBuffer: 1_048_576, ...extra })).stdout;
  } catch {
    fail('bounded_observation_failed');
  }
}

export async function observeBackupRefusalSourceGit(root, args) {
  // FLAG: Root status reads must never replace the operator's index, even when
  // the caller explicitly inherited optional locks enabled.
  return command('git', ['-c', `safe.directory=${root}`, '-C', root, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

const git = observeBackupRefusalSourceGit;

async function validatePaths() {
  requireFact(process.getuid() === 0, 'root_required');
  const state = await lstat(`${ROOT}/state`);
  requireFact(
    state.isDirectory() &&
      !state.isSymbolicLink() &&
      state.uid > 0 &&
      (state.mode & 0o777) === 0o700,
    'unsafe_state_directory',
  );
  for (const path of ['/var', '/var/lib', ROOT, '/var/lib/maxim-deploy']) {
    const value = await lstat(path);
    requireFact(
      value.isDirectory() && !value.isSymbolicLink() && !(value.mode & 0o022),
      'unsafe_protected_directory',
    );
    if (path === ROOT) requireFact(value.uid === 0, 'unsafe_protocol_owner');
  }
  for (const path of LOCKS) {
    const value = await lstat(path);
    requireFact(
      value.isFile() &&
        !value.isSymbolicLink() &&
        value.nlink === 1 &&
        value.uid === state.uid &&
        (value.mode & 0o777) === 0o600,
      'unsafe_persistent_lock',
    );
  }
  return state;
}

export async function withBackupRefusalLocks(paths, work) {
  // FLAG: Hold all original open descriptions; closing the holder is the only release.
  // Release only by closing the original descriptors.
  const descriptors = [];
  try {
    for (const path of paths)
      descriptors.push(await open(path, constants.O_RDWR | constants.O_NOFOLLOW));
  } catch (error) {
    await Promise.all(descriptors.map((fd) => fd.close()));
    throw error;
  }
  // FLAG: Parent and child retain the SAME open file descriptions. A lost helper
  // cannot drop the fences while the parent is committing the exact archive rename.
  const child = spawn(
    'bash',
    ['-c', 'set -euo pipefail; flock -n 7; flock -n 8; flock -n 9; printf "HELD\\n"; read -r _'],
    {
      stdio: [
        'pipe',
        'pipe',
        'pipe',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        ...descriptors.map((fd) => fd.fd),
      ],
    },
  );
  child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  let timer;
  try {
    const acquired = new Promise((resolve, reject) => {
      let raw = '';
      child.stdout.on('data', (chunk) => {
        raw += chunk.toString();
        if (raw === 'HELD\n') resolve();
        else if (raw.length > 64) reject(new Error('recovery_lock_output_invalid'));
      });
      child.once('exit', () => reject(new Error('recovery_locks_busy')));
      child.once('error', () => reject(new Error('recovery_locks_unavailable')));
      timer = setTimeout(() => reject(new Error('recovery_lock_deadline')), 5_000);
    });
    await acquired;
    clearTimeout(timer);
    const assertLocks = async () => {
      requireFact(
        child.exitCode === null && child.signalCode === null,
        'recovery_lock_holder_lost',
      );
      for (const [index, path] of paths.entries()) {
        const file = await lstat(path);
        const description = await descriptors[index].stat();
        const info = await readFile(`/proc/${process.pid}/fdinfo/${descriptors[index].fd}`, 'utf8');
        requireFact(
          !file.isSymbolicLink() &&
            file.dev === description.dev &&
            file.ino === description.ino &&
            /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF$/mu.test(info),
          'recovery_lock_authority_lost',
        );
      }
      requireFact(
        child.exitCode === null && child.signalCode === null,
        'recovery_lock_holder_lost',
      );
    };
    await assertLocks();
    return await work({ assertLocks, holderPid: child.pid });
  } finally {
    clearTimeout(timer);
    child.stdin.end('done\n');
    const deadline = setTimeout(() => child.kill('SIGTERM'), 2_000);
    await closed;
    clearTimeout(deadline);
    await Promise.all(descriptors.map((fd) => fd.close()));
  }
}

async function noReleaseActors() {
  const pattern =
    '[v]ps-pull-build-up[.]sh|[v]ps-runtime-rollback[.]sh|[v]ps-release-rollback[.]sh|[v]ps-finalize-release-recovery[.]sh|[r]elease-karavan[.]sh|[v]ps-deploy-karavan[.]sh|[v]ps-rollback-karavan[.]sh|[b]ackup-postgres[.]sh|[r]estore-postgres-backup-smoke[.]sh|[d]ocker (compose|buildx).* (infra|karavan|maxim)[^ ]*';
  let output;
  try {
    output = (await execute('pgrep', ['-f', pattern], { timeout: 2_000, maxBuffer: 8192 })).stdout;
  } catch (error) {
    if (error.code === 1) return true;
    fail('actor_observation_failed');
  }
  const pids = output.trim().split('\n');
  requireFact(pids.length <= 256, 'actor_observation_capped');
  for (const pid of pids) {
    requireFact(/^[1-9][0-9]*$/u.test(pid), 'invalid_actor_observation');
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      const cmd = await boundedFile(`/proc/${pid}/cmdline`, 65_536);
      if (
        [MAJOR, KARAVAN].some(
          (root) =>
            cwd === root ||
            cwd.startsWith(`${root}/`) ||
            cmd.bytes
              .toString()
              .split('\0')
              .some((arg) => arg.startsWith(`${root}/`)),
        )
      )
        return false;
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) fail('actor_observation_failed');
    }
  }
  return true;
}

export function matchesBackupRefusalUnit(text) {
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  // FLAG: Pin the observed historical main service, including its direct ExecStart.
  // A newly generated profile service is a different execution boundary.
  const exact = [
    '[Unit]',
    'Description=MAXIM validated PostgreSQL backup',
    'Requires=docker.service',
    'After=docker.service',
    `ConditionPathExists=${MAJOR}/infra/scripts/backup-postgres.sh`,
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${MAJOR}`,
    'EnvironmentFile=-/etc/maxim-postgres-backup.env',
    `ExecStart=${MAJOR}/infra/scripts/backup-postgres.sh`,
    'SuccessExitStatus=75',
    'TimeoutStartSec=18h15m',
    'TimeoutStopSec=1m',
    'KillSignal=SIGTERM',
    'Restart=no',
    'UMask=0077',
    'Nice=10',
    'IOSchedulingClass=best-effort',
    'IOSchedulingPriority=7',
  ];
  return (
    rows.length === exact.length &&
    exact.every((line) => rows.filter((row) => row === line).length === 1)
  );
}

async function observe(request) {
  const state = await validatePaths();
  const owner = await boundedFile(OWNER, 393);
  const parsed = parseOwner(owner.bytes);
  const sourceFiles = [
    [`${ROOT}/admission.sh`, 'infra/scripts/lib/pair-release-admission.sh'],
    [`${ROOT}/state.mjs`, 'infra/scripts/pair-release-state.mjs'],
    [`${MAJOR}/infra/scripts/backup-postgres.sh`, 'infra/scripts/backup-postgres.sh'],
    [`${MAJOR}/infra/scripts/lib/deploy-lock.sh`, 'infra/scripts/lib/deploy-lock.sh'],
    [
      `${MAJOR}/infra/scripts/lib/pair-release-admission.sh`,
      'infra/scripts/lib/pair-release-admission.sh',
    ],
  ];
  let legacySourcesMatch = true;
  for (const [path, source] of sourceFiles) {
    const current = await boundedFile(path, 262_144);
    const original = await git(MAJOR, ['show', `${request.sourceSha}:${source}`]);
    if (sha256(current.bytes) !== sha256(original)) legacySourcesMatch = false;
    if (path.startsWith(ROOT))
      requireFact(
        current.stat.uid === 0 && !(current.stat.mode & 0o022),
        'unsafe_installed_controller',
      );
  }
  const reported = JSON.parse(await command('bash', [`${ROOT}/admission.sh`, 'state']));
  const snapshot = Object.fromEntries(
    Object.entries(reported).filter(
      ([key]) => !['fingerprint', 'admission', 'observedAt'].includes(key),
    ),
  );
  snapshot.major.checkoutSha = (await git(MAJOR, ['rev-parse', '--verify', 'HEAD'])).trim();
  snapshot.karavan.checkoutSha = (await git(KARAVAN, ['rev-parse', '--verify', 'HEAD'])).trim();
  requireFact((await git(MAJOR, ['status', '--porcelain'])).trim() === '', 'major_source_dirty');
  requireFact(
    (await git(KARAVAN, ['status', '--porcelain'])).trim() === '',
    'karavan_source_dirty',
  );
  const properties = [
    'ActiveState',
    'SubState',
    'MainPID',
    'Result',
    'ExecMainCode',
    'ExecMainStatus',
    'InvocationID',
    'DropInPaths',
    'FragmentPath',
  ];
  const rawUnit = await command('systemctl', [
    'show',
    UNIT,
    '--no-pager',
    ...properties.map((key) => `--property=${key}`),
  ]);
  const unit = Object.fromEntries(
    rawUnit
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  const unitFile = await boundedFile(`/etc/systemd/system/${UNIT}`, 16_384);
  requireFact(unitFile.stat.uid === 0 && !(unitFile.stat.mode & 0o022), 'unsafe_systemd_unit');
  const journal = (
    await command(
      'journalctl',
      [`_SYSTEMD_INVOCATION_ID=${request.invocationId}`, '--no-pager', '-n', '3', '-o', 'json'],
      { maxBuffer: 65_536 },
    )
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let originalProcessAbsent = false;
  try {
    await lstat(`/proc/${parsed.pid}`);
  } catch (error) {
    if (error.code === 'ENOENT') originalProcessAbsent = true;
    else throw error;
  }
  const lock = await lstat(LOCKS[0]);
  return {
    root: process.getuid() === 0,
    locksHeld: true,
    ownerBytes: owner.bytes,
    ownerUid: owner.stat.uid,
    ownerMode: owner.stat.mode & 0o777,
    ownerLinks: owner.stat.nlink,
    operatorUid: state.uid,
    admissionInode: `${lock.dev}:${lock.ino}`,
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    originalProcessAbsent,
    noActors: await noReleaseActors(),
    legacySourcesMatch,
    unitMatches: matchesBackupRefusalUnit(unitFile.bytes.toString()),
    unit,
    journal,
    snapshot,
  };
}

async function fsync(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

export async function archiveBackupRefusal({
  ownerPath,
  archiveDirectory,
  operatorUid,
  operatorGid,
  ownerBytes,
  proof,
  assertLocks,
}) {
  // FLAG: Publish durable proof before moving the unchanged original. A partial failure
  // leaves its proof and owner intact; it never removes the persistent admission inode.
  await assertLocks();
  try {
    await mkdir(archiveDirectory, { mode: 0o700 });
    await chown(archiveDirectory, operatorUid, operatorGid);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const directory = await lstat(archiveDirectory);
  requireFact(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      directory.uid === operatorUid &&
      (directory.mode & 0o777) === 0o700,
    'unsafe_recovery_archive',
  );
  await fsync(dirname(archiveDirectory));
  const proofPath = `${archiveDirectory}/${proof.ownerSha256}.proof.json`;
  const archivedOwner = `${archiveDirectory}/${proof.ownerSha256}.owner`;
  try {
    await lstat(archivedOwner);
    fail('recovery_archive_exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const proofBytes = Buffer.from(`${JSON.stringify(proof)}\n`);
  try {
    const file = await open(
      proofPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(proofBytes);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await boundedFile(proofPath, 4096);
    requireFact(
      previous.bytes.equals(proofBytes) &&
        previous.stat.uid === process.getuid() &&
        (previous.stat.mode & 0o777) === 0o600,
      'recovery_proof_conflict',
    );
  }
  await fsync(archiveDirectory);
  const original = await boundedFile(ownerPath, 393);
  requireFact(
    original.bytes.equals(Buffer.from(ownerBytes)) && sha256(original.bytes) === proof.ownerSha256,
    'owner_changed_before_archive',
  );
  requireFact(directory.dev === original.stat.dev, 'recovery_archive_filesystem_changed');
  await assertLocks();
  await command('mv', ['--no-clobber', '--no-target-directory', '--', ownerPath, archivedOwner]);
  const moved = await lstat(archivedOwner);
  requireFact(
    moved.dev === original.stat.dev && moved.ino === original.stat.ino,
    'recovery_archive_identity_changed',
  );
  try {
    await lstat(ownerPath);
    fail('recovery_archive_move_refused');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fsync(archivedOwner);
  await fsync(archiveDirectory);
  await fsync(dirname(ownerPath));
}

export async function recoverBackupRefusal(request, dependencies) {
  const first = await dependencies.observe(request);
  const proof = buildBackupRefusalProof(request, first);
  if (request.mode === 'apply') {
    const next = await dependencies.observe(request);
    requireFact(
      JSON.stringify(buildBackupRefusalProof(request, next)) === JSON.stringify(proof),
      'recovery_evidence_changed',
    );
    await dependencies.archive(next, proof);
  }
  return { ...proof, mode: request.mode, archived: request.mode === 'apply' };
}

async function main() {
  const request = parseBackupRefusalRecoveryArgs(process.argv.slice(2));
  await validatePaths();
  return withBackupRefusalLocks(LOCKS, ({ assertLocks }) =>
    recoverBackupRefusal(request, {
      observe: async () => {
        await assertLocks();
        const observation = await observe(request);
        await assertLocks();
        return observation;
      },
      archive: async (observation, proof) => {
        const state = await lstat(`${ROOT}/state`);
        await archiveBackupRefusal({
          ownerPath: OWNER,
          archiveDirectory: `${ROOT}/state/backup-refusal-recoveries`,
          operatorUid: state.uid,
          operatorGid: state.gid,
          ownerBytes: observation.ownerBytes,
          proof,
          assertLocks,
        });
      },
    }),
  );
}

if (import.meta.main) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: /^[a-z_]+$/u.test(error.message) ? error.message : 'recovery_observation_failed' })}\n`,
      );
      process.exitCode = 1;
    });
}
