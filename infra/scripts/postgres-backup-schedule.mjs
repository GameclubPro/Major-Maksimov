#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath, rename, readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BACKUP_SCHEDULE_VERSION = 1;
export const ADMISSION_DELAYS_MS = [900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000];
export const ADMISSION_DEADLINE_MS = 12 * 3_600_000;
const phases = new Set([
  'waiting',
  'producing',
  'replication_pending',
  'replicating',
  'needs_review',
  'overdue',
  'verified',
  'closed',
]);
const transient = new Set([
  'backup_lock_busy',
  'pair_lock_busy',
  'product_lock_busy',
  'readiness_not_ready',
]);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const revision = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const remote = /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_/-]+$/;
const root = resolve(import.meta.dirname, '../..');
function sourceGitArgs(sourceRoot, args) {
  // FLAG: Root systemd has no operator Git trust. Admit only this checkout for
  // this read; never persist global trust or weaken ordinary-user ownership checks.
  return process.getuid() === 0 ? ['-c', `safe.directory=${sourceRoot}`, ...args] : args;
}
function requireFact(value, message) {
  if (!value) throw new Error(message);
}
function profileCheck(profile) {
  requireFact(['maxim', 'eraser'].includes(profile), 'Invalid backup profile');
}
export function archiveGenerationMs(name, profile) {
  profileCheck(profile);
  const match = new RegExp(
    `^${profile}_(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z\\.dump$`,
  ).exec(name ?? '');
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const value = Date.parse(iso);
  return Number.isFinite(value) && new Date(value).toISOString() === iso ? value : null;
}
async function regular(path, maxBytes = 16_384) {
  const stat = await lstat(path);
  requireFact(
    stat.isFile() &&
      stat.nlink === 1 &&
      stat.size <= maxBytes &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0,
    'Unsafe backup state file',
  );
  return stat;
}
export async function readPrivateJson(path) {
  try {
    await regular(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireFact(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.size <= 16_384 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0,
      'Unsafe backup state file',
    );
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}
export async function writePrivateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(resolve(path, '..'), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function prepareScheduleDirectory(directory) {
  requireFact(
    directory === resolve(directory) && (await realpath(directory)) === directory,
    'Invalid backup directory',
  );
  const stateDirectory = join(directory, '.scheduler-v1');
  await mkdir(stateDirectory, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(stateDirectory);
  requireFact(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0,
    'Unsafe backup state directory',
  );
  const lockPath = join(stateDirectory, 'lock');
  const lock = await open(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  await lock.close();
  await regular(lockPath, 0);
  return stateDirectory;
}
export function validateState(value, profile) {
  if (value === null) return null;
  requireFact(
    value?.schemaVersion === 1 &&
      value.profile === profile &&
      uuid.test(value.operationId) &&
      phases.has(value.phase) &&
      revision.test(value.sourceSha ?? '') &&
      Number.isSafeInteger(value.requestedAt) &&
      Number.isSafeInteger(value.deadlineAt) &&
      value.deadlineAt === value.requestedAt + ADMISSION_DEADLINE_MS &&
      Number.isSafeInteger(value.nextAttemptAt) &&
      Number.isSafeInteger(value.attempts) &&
      value.attempts >= 0 &&
      value.attempts <= 6 &&
      Number.isSafeInteger(value.replicationAttempts) &&
      value.replicationAttempts >= 0 &&
      value.replicationAttempts <= 3 &&
      remote.test(value.destination ?? '') &&
      hash.test(value.destinationHash) &&
      createHash('sha256').update(value.destination).digest('hex') === value.destinationHash &&
      (value.attemptId === null || uuid.test(value.attemptId ?? '')),
    'Invalid backup schedule state',
  );
  if (value.archive)
    requireFact(
      archiveGenerationMs(value.archive.name, profile) !== null &&
        hash.test(value.archive.sha256) &&
        Number.isSafeInteger(value.archive.bytes) &&
        value.archive.bytes > 0,
      'Invalid scheduled archive',
    );
  if (['replication_pending', 'replicating', 'verified'].includes(value.phase))
    requireFact(value.archive, 'Missing scheduled archive');
  return value;
}
function validateResult(value, state) {
  if (!value || value.operationId !== state.operationId || value.attemptId !== state.attemptId)
    return null;
  requireFact(
    value.schemaVersion === 1 &&
      value.profile === state.profile &&
      ['admission', 'deferred', 'producing', 'local_complete'].includes(value.phase),
    'Invalid producer result',
  );
  if (value.phase === 'deferred')
    requireFact(transient.has(value.reason), 'Invalid admission refusal');
  if (value.archiveName)
    requireFact(
      archiveGenerationMs(value.archiveName, state.profile) !== null,
      'Invalid producer archive name',
    );
  if (value.phase === 'local_complete')
    requireFact(
      value.archiveName &&
        hash.test(value.sha256) &&
        Number.isSafeInteger(value.bytes) &&
        value.bytes > 0,
      'Invalid completed archive',
    );
  return value;
}
export async function verifyScheduledArchive(directory, archive, profile) {
  requireFact(
    archiveGenerationMs(archive.name, profile) !== null && hash.test(archive.sha256),
    'Invalid scheduled archive',
  );
  const path = join(directory, archive.name);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireFact(
      stat.isFile() && stat.nlink === 1 && stat.size === archive.bytes,
      'Scheduled archive changed',
    );
    // The replication helper owns the single full checksum pass inside its deadline.
  } finally {
    await file.close();
  }
  const checksum = await open(`${path}.sha256`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await checksum.stat();
    requireFact(stat.isFile() && stat.nlink === 1 && stat.size <= 256, 'Unsafe archive checksum');
    requireFact(
      (await checksum.readFile('utf8')).trimEnd() === `${archive.sha256}  ${archive.name}`,
      'Scheduled archive checksum changed',
    );
  } finally {
    await checksum.close();
  }
  return path;
}
async function verifiedReceipt(directory, state, now) {
  const path = join(directory, `${state.archive.name}.remote-verified.json`);
  const value = await readPrivateJson(path);
  if (!value) return false;
  requireFact(
    value.schemaVersion === 1 &&
      (value.profile === state.profile ||
        (state.profile === 'maxim' && value.profile === undefined)) &&
      value.dump === state.archive.name &&
      value.dumpSha256 === state.archive.sha256 &&
      hash.test(value.cipherSha256) &&
      value.verification === 'full_ciphertext_readback' &&
      Number.isFinite(Date.parse(value.verifiedAt)) &&
      Date.parse(value.verifiedAt) >= archiveGenerationMs(value.dump, state.profile) - 60_000 &&
      Date.parse(value.verifiedAt) <= now + 60_000 &&
      value.remoteObject === `${state.destination}/${state.archive.name}.${value.cipherSha256}.age`,
    'Invalid exact replication receipt',
  );
  return true;
}

function scheduleObservation(state, profile) {
  return {
    schemaVersion: 1,
    profile,
    operationId: state?.operationId ?? null,
    phase: state?.phase ?? 'idle',
    attempts: state?.attempts ?? 0,
    reason: state?.reason ?? null,
    nextAttemptAt: state?.nextAttemptAt ?? null,
    archive: state?.archive?.name ?? null,
    updatedAt: state?.updatedAt ?? null,
    lastExitCode: state?.lastExitCode ?? null,
    process: state?.process
      ? Object.fromEntries(
          ['pid', 'startedAt', 'heartbeatAt', 'deadlineAt'].map((field) => [
            field,
            Number.isSafeInteger(state.process[field]) ? state.process[field] : null,
          ]),
        )
      : null,
  };
}

// FLAG: One durable request owns admission retries. A started/unknown dump never replays;
// only a complete exact archive result may continue to replication after interruption.
export async function runSchedule({
  mode,
  profile,
  directory,
  destination,
  destinationHash,
  expectedOperationId,
  run,
  now = Date.now,
  sourceSha,
}) {
  profileCheck(profile);
  if (mode === 'status') {
    // FLAG: Atomic state replacement permits observation during an active child;
    // status never prepares directories, reconciles evidence or starts work.
    return scheduleObservation(
      validateState(await readPrivateJson(join(directory, '.scheduler-v1/state.json')), profile),
      profile,
    );
  }
  const stateDirectory = await prepareScheduleDirectory(directory);
  const path = join(stateDirectory, 'state.json');
  const resultPath = join(stateDirectory, 'producer-result.json');
  let state = validateState(await readPrivateJson(path), profile);
  const save = async () => {
    state.updatedAt = now();
    await writePrivateJson(path, state);
  };
  const result = () => scheduleObservation(state, profile);
  if (mode === 'close') {
    requireFact(
      state &&
        state.operationId === expectedOperationId &&
        ['needs_review', 'overdue'].includes(state.phase),
      'Exact failed operation required',
    );
    state.phase = 'closed';
    state.reason = 'operator_closed';
    await save();
    return result();
  }
  if (mode === 'resume-replication') {
    requireFact(
      state &&
        state.operationId === expectedOperationId &&
        state.archive &&
        ['needs_review', 'replication_pending', 'replicating'].includes(state.phase),
      'Exact replication operation required',
    );
    requireFact(
      state.destinationHash === destinationHash && state.replicationAttempts < 3,
      'Replication target or budget changed',
    );
    state.phase = 'replication_pending';
    await save();
  } else if (mode === 'request' && (!state || ['verified', 'closed'].includes(state.phase))) {
    requireFact(revision.test(sourceSha ?? ''), 'Invalid backup source revision');
    const requestedAt = now();
    state = {
      schemaVersion: 1,
      profile,
      operationId: randomUUID(),
      attemptId: null,
      sourceSha,
      phase: 'waiting',
      requestedAt,
      deadlineAt: requestedAt + ADMISSION_DEADLINE_MS,
      nextAttemptAt: requestedAt,
      attempts: 0,
      replicationAttempts: 0,
      destination,
      destinationHash,
      archive: null,
      reason: null,
    };
    await save();
  }
  if (!state) return result();
  requireFact(state.destinationHash === destinationHash, 'Scheduled destination changed');
  if (state.phase === 'producing') {
    let receipt;
    try {
      receipt = validateResult(await readPrivateJson(resultPath), state);
    } catch {
      state.phase = 'needs_review';
      state.reason = 'producer_evidence_invalid';
      await save();
      return result();
    }
    if (receipt?.phase === 'local_complete') {
      state.archive = { name: receipt.archiveName, sha256: receipt.sha256, bytes: receipt.bytes };
      state.phase = 'replication_pending';
      state.reason = null;
    } else {
      state.phase = 'needs_review';
      state.reason = 'producer_interrupted';
    }
    await save();
  }
  if (state.phase === 'replicating') {
    try {
      state.phase = (await verifiedReceipt(directory, state, now())) ? 'verified' : 'needs_review';
      state.reason = state.phase === 'verified' ? null : 'replication_interrupted';
    } catch {
      state.phase = 'needs_review';
      state.reason = 'replication_evidence_invalid';
    }
    await save();
  }
  if (state.phase === 'waiting') {
    // FLAG: Admission retries never silently switch producer code after a checkout update.
    if (sourceSha !== state.sourceSha) {
      state.phase = 'needs_review';
      state.reason = 'producer_source_changed';
      await save();
      return result();
    }
    if (now() >= state.deadlineAt || state.attempts >= 6) {
      state.phase = 'overdue';
      state.reason = 'admission_budget_exhausted';
      await save();
      return result();
    }
    if (now() < state.nextAttemptAt) return result();
    state.phase = 'producing';
    state.attemptId = randomUUID();
    state.attempts++;
    state.reason = null;
    state.lastAttemptAt = now();
    await save();
    const outcome = await run('produce', {
      resultPath,
      operationId: state.operationId,
      attemptId: state.attemptId,
      sourceSha: state.sourceSha,
      onProgress: async (observation) => {
        state.process = observation;
        await save();
      },
    });
    state.lastExitCode = outcome.code;
    let receipt;
    try {
      receipt = validateResult(await readPrivateJson(resultPath), state);
    } catch {
      state.phase = 'needs_review';
      state.reason = 'producer_evidence_invalid';
      await save();
      return result();
    }
    if (outcome.code === 75 && receipt?.phase === 'deferred') {
      state.phase = 'waiting';
      state.reason = receipt.reason;
      state.nextAttemptAt = Math.min(
        state.deadlineAt,
        now() + (ADMISSION_DELAYS_MS[state.attempts - 1] ?? ADMISSION_DEADLINE_MS),
      );
      if (state.attempts >= 6 || now() >= state.deadlineAt) {
        state.phase = 'overdue';
        state.reason = 'admission_budget_exhausted';
      }
      await save();
      return result();
    }
    if (receipt?.phase === 'local_complete')
      state.archive = { name: receipt.archiveName, sha256: receipt.sha256, bytes: receipt.bytes };
    if (outcome.code !== 0 || receipt?.phase !== 'local_complete') {
      state.phase = 'needs_review';
      state.reason = 'producer_failed_or_unknown';
      await save();
      return result();
    }
    state.phase = 'replication_pending';
    await save();
  }
  if (state.phase === 'replication_pending') {
    if (state.replicationAttempts >= 3) {
      state.phase = 'needs_review';
      state.reason = 'replication_budget_exhausted';
      await save();
      return result();
    }
    let archivePath;
    try {
      archivePath = await verifyScheduledArchive(directory, state.archive, profile);
      if (await verifiedReceipt(directory, state, now())) {
        state.phase = 'verified';
        state.reason = null;
        await save();
        return result();
      }
    } catch {
      state.phase = 'needs_review';
      state.reason = 'archive_or_replication_evidence_invalid';
      await save();
      return result();
    }
    state.phase = 'replicating';
    state.replicationAttempts++;
    state.lastAttemptAt = now();
    await save();
    const outcome = await run('replicate', {
      archivePath,
      expectedSha256: state.archive.sha256,
      operationId: state.operationId,
      sourceSha: state.sourceSha,
      onProgress: async (observation) => {
        state.process = observation;
        await save();
      },
    });
    state.lastExitCode = outcome.code;
    try {
      state.phase =
        outcome.code === 0 && (await verifiedReceipt(directory, state, now()))
          ? 'verified'
          : 'needs_review';
      state.reason = state.phase === 'verified' ? null : 'replication_failed_or_unknown';
    } catch {
      state.phase = 'needs_review';
      state.reason = 'replication_evidence_invalid';
    }
    await save();
  }
  return result();
}

export async function replicationSnapshot(directory, operationId, sourceSha, sourceRoot = root) {
  requireFact(
    uuid.test(operationId) && /^[a-f0-9]{40}$/.test(sourceSha),
    'Invalid tool snapshot identity',
  );
  const snapshot = join(directory, '.scheduler-v1', 'replication-tools');
  for (const child of ['', '/infra', '/infra/scripts', '/infra/scripts/lib']) {
    const path = snapshot + child;
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(path);
    requireFact(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0,
      'Unsafe replication snapshot',
    );
  }
  const files = [
    'infra/scripts/replicate-postgres-backup.sh',
    'infra/scripts/lib/postgres-backup-profile.sh',
  ];
  const manifestPath = join(snapshot, 'manifest.json');
  const manifest = await readPrivateJson(manifestPath);
  if (
    manifest?.schemaVersion === 1 &&
    manifest.operationId === operationId &&
    manifest.sourceSha === sourceSha
  ) {
    for (const file of files) {
      await regular(join(snapshot, file), 65_536);
      requireFact(
        createHash('sha256')
          .update(await readFile(join(snapshot, file)))
          .digest('hex') === manifest.hashes?.[file],
        'Replication snapshot changed',
      );
    }
  } else {
    const hashes = {};
    for (const file of files) {
      const bytes = execFileSync(
        'git',
        sourceGitArgs(sourceRoot, ['show', `${sourceSha}:${file}`]),
        {
          cwd: sourceRoot,
          maxBuffer: 65_536,
        },
      );
      const target = join(snapshot, file);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const output = await open(temporary, 'wx', 0o600);
      try {
        await output.writeFile(bytes);
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporary, target);
      hashes[file] = createHash('sha256').update(bytes).digest('hex');
    }
    await writePrivateJson(manifestPath, { schemaVersion: 1, operationId, sourceSha, hashes });
  }
  return join(snapshot, files[0]);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const profile = process.env.MAXIM_BACKUP_PROFILE ?? 'maxim';
  profileCheck(profile);
  const base = process.env.MAXIM_BACKUP_DIR;
  requireFact(base && base === resolve(base), 'Set an absolute MAXIM_BACKUP_DIR');
  const directory = profile === 'eraser' ? join(base, 'eraser') : base;
  if (mode === 'status') {
    requireFact(args.length === 0, 'Invalid arguments');
    const result = await runSchedule({ mode, profile, directory });
    process.stdout.write(JSON.stringify({ metric: 'backup_schedule_v1', ...result }) + '\n');
    return;
  }
  if (mode === 'capability') {
    requireFact(args.length === 0, 'Invalid arguments');
    return;
  }
  if (mode === 'prepare') {
    requireFact(args.length === 0, 'Invalid arguments');
    process.stdout.write((await prepareScheduleDirectory(directory)) + '\n');
    return;
  }
  if (mode === 'producer-result') {
    const operationId = process.env.MAXIM_BACKUP_OPERATION_ID;
    const resultPath = process.env.MAXIM_BACKUP_RESULT_FILE;
    const attemptId = process.env.MAXIM_BACKUP_ATTEMPT_ID;
    const stateDirectory = await prepareScheduleDirectory(directory);
    requireFact(
      uuid.test(operationId ?? '') && resultPath === join(stateDirectory, 'producer-result.json'),
      'Invalid producer receipt destination',
    );
    const state = validateState(await readPrivateJson(join(stateDirectory, 'state.json')), profile);
    requireFact(
      state?.operationId === operationId &&
        state.attemptId === attemptId &&
        state.phase === 'producing',
      'Producer operation changed',
    );
    const [phase, detail, sha256, bytes] = args;
    const receipt = {
      schemaVersion: 1,
      profile,
      operationId,
      attemptId,
      phase,
      ...(phase === 'deferred' ? { reason: detail } : detail ? { archiveName: detail } : {}),
      ...(phase === 'local_complete' ? { sha256, bytes: Number(bytes) } : {}),
    };
    validateResult(receipt, state);
    await writePrivateJson(resultPath, receipt);
    return;
  }
  if (mode === 'retention-pin') {
    requireFact(args.length === 0, 'Invalid arguments');
    // FLAG: Direct manual producers also preserve the exact unfinished scheduled archive.
    const state = validateState(
      await readPrivateJson(join(directory, '.scheduler-v1/state.json')),
      profile,
    );
    if (!state || ['verified', 'closed'].includes(state.phase)) return;
    const receipt = validateResult(
      await readPrivateJson(join(directory, '.scheduler-v1/producer-result.json')),
      state,
    );
    const name = state.archive?.name ?? receipt?.archiveName;
    if (name) process.stdout.write(name + '\n');
    return;
  }
  requireFact(
    ['request', 'tick', 'resume-replication', 'close'].includes(mode) &&
      args.length === (['resume-replication', 'close'].includes(mode) ? 1 : 0),
    'Invalid scheduler command',
  );
  requireFact(process.env.MAXIM_BACKUP_SCHEDULE_LOCKED === '1', 'Use postgres-backup-schedule.sh');
  const stateDirectory = await prepareScheduleDirectory(directory);
  const lock = await stat(join(stateDirectory, 'lock'));
  const descriptor = await stat('/proc/self/fd/9');
  requireFact(
    lock.dev === descriptor.dev &&
      lock.ino === descriptor.ino &&
      /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(
        await readFile('/proc/self/fdinfo/9', 'utf8'),
      ),
    'Missing coordinator lock',
  );
  requireFact(
    process.env.MAXIM_BACKUP_REPLICATION_REQUIRED === '1' && process.env.MAXIM_BACKUP_REMOTE_PREFIX,
    'Scheduled backups require independent replication',
  );
  const prefix = process.env.MAXIM_BACKUP_REMOTE_PREFIX.replace(/\/+$/, '');
  const destination = profile === 'eraser' ? `${prefix}/eraser` : prefix;
  requireFact(remote.test(destination), 'Invalid backup destination');
  const destinationHash = createHash('sha256').update(destination).digest('hex');
  const sourceSha = execFileSync('git', sourceGitArgs(root, ['rev-parse', 'HEAD']), {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const run = async (kind, options) => {
    // FLAG: Replication outlives the deploy lock. Snapshot its shell inputs at the
    // exact request source before the producer runs; retries use those immutable bytes.
    const replica = await replicationSnapshot(directory, options.operationId, options.sourceSha);
    const script = kind === 'produce' ? join(root, 'infra/scripts/backup-postgres.sh') : replica;
    const child = spawn(
      'timeout',
      [
        '--signal=TERM',
        '--kill-after=60s',
        kind === 'produce' ? '44100s' : '21720s',
        'bash',
        script,
        ...(kind === 'produce' ? [] : [options.archivePath]),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ...(kind === 'produce'
            ? {
                MAXIM_BACKUP_REPLICATION_REQUIRED: '0',
                MAXIM_BACKUP_SOURCE_SHA: options.sourceSha,
                MAXIM_BACKUP_OPERATION_ID: options.operationId,
                MAXIM_BACKUP_ATTEMPT_ID: options.attemptId,
                MAXIM_BACKUP_RESULT_FILE: options.resultPath,
              }
            : { MAXIM_BACKUP_EXPECTED_SHA256: options.expectedSha256 }),
        },
        stdio: [
          'ignore',
          'inherit',
          'inherit',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          9,
        ],
      },
    );
    let progress = Promise.resolve();
    let progressError;
    const startedAt = Date.now();
    const heartbeat = () => {
      progress = progress
        .then(() =>
          options.onProgress({
            pid: child.pid ?? null,
            startedAt,
            heartbeatAt: Date.now(),
            deadlineAt: startedAt + (kind === 'produce' ? 44_100_000 : 21_720_000),
          }),
        )
        .catch((error) => {
          progressError ??= error;
          child.kill('SIGTERM');
        });
    };
    heartbeat();
    const timer = setInterval(heartbeat, 30_000);
    const outcome = await new Promise((done) => {
      child.once('error', () => done({ code: null }));
      child.once('close', (code) => done({ code }));
    });
    clearInterval(timer);
    await progress;
    if (progressError) throw progressError;
    return outcome;
  };
  const result = await runSchedule({
    mode,
    profile,
    directory,
    destination,
    destinationHash,
    expectedOperationId: args[0],
    sourceSha,
    run,
  });
  process.stdout.write(JSON.stringify({ metric: 'backup_schedule_v1', ...result }) + '\n');
  if (['needs_review', 'overdue'].includes(result.phase)) process.exitCode = 1;
  else if (result.phase === 'waiting') process.exitCode = 75;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch(() => {
    console.error('Backup schedule refused: inspect private state and service journal.');
    process.exitCode = 1;
  });
