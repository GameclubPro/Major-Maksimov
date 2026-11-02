#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createOutcomeCohortOnlineClientLauncher } from './multibot-online-client.mjs';
import {
  createMultibotRuntimeGuard,
  readMultibotRuntimePressure,
} from './multibot-runtime-pressure.mjs';
import {
  installMultibotOutputFence,
  readMultibotMigrationFilesystems,
  stopOwnedMigration,
  waitForMultibotTick,
} from './multibot-online-supervisor.mjs';
import { validateMultibotComposeArgs } from './multibot-prepare-capacity.mjs';
import {
  checkOutcomeCohortPrepareCapacity,
  OUTCOME_COHORT_MINIMUM_FREE_BYTES,
} from './outcome-cohort-prepare-capacity.mjs';
import { readOutcomeCohortState, runOutcomeCohortCommand } from './outcome-cohort-online-state.mjs';

export const OUTCOME_COHORT_TOTAL_MS = 3_000_000;
export const OUTCOME_COHORT_CLEANUP_RESERVE_MS = 60_000;
export const OUTCOME_COHORT_ADMISSION_MS = 120_000;
const signalsList = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const fail = (code) => {
  throw new Error(`OUTCOME_COHORT_${code}`);
};

export function outcomeCohortFailureCode(error) {
  return /^(?:OUTCOME_COHORT|MULTIBOT_PREPARE)_[A-Z_]+$/u.test(error?.message ?? '')
    ? error.message
    : 'OUTCOME_COHORT_PREPARATION_FAILED';
}

export async function prepareOutcomeCohortIndexes(
  composeArgs,
  {
    root = process.cwd(),
    env = process.env,
    now = Date.now,
    signals = process,
    run = runOutcomeCohortCommand,
    readState = readOutcomeCohortState,
    checkCapacity = checkOutcomeCohortPrepareCapacity,
    readFilesystems = readMultibotMigrationFilesystems,
    checkRuntime = readMultibotRuntimePressure,
    createLauncher = createOutcomeCohortOnlineClientLauncher,
    stop = stopOwnedMigration,
    waitForTick = waitForMultibotTick,
    onProgress = () => {},
    stage = 'outcome_cohort_prepare',
    failureCode = outcomeCohortFailureCode,
  } = {},
) {
  validateMultibotComposeArgs(composeArgs);
  const startedAt = now();
  const deadlineAt = startedAt + OUTCOME_COHORT_TOTAL_MS;
  const workDeadlineAt = deadlineAt - OUTCOME_COHORT_CLEANUP_RESERVE_MS;
  const attempt = randomUUID();
  let interrupted = false,
    previousNow = startedAt;
  let applicationName = null,
    selector = null,
    child,
    attempted = false,
    preparationUnconfirmed = false,
    cleanupStarted = false;
  let lastStorageAt = null,
    lastRuntimeAt = null,
    nextRuntimeAt = 0;
  let imageId = null;
  const interrupt = () => {
    interrupted = true;
  };
  for (const signal of signalsList) signals.on(signal, interrupt);
  const guard = createMultibotRuntimeGuard({ now });
  const active = () => {
    const at = now();
    if (!Number.isSafeInteger(at) || at < previousNow) fail('CLOCK_INVALID');
    previousNow = at;
    if (interrupted) fail('INTERRUPTED');
    if (at >= workDeadlineAt) fail('DEADLINE_EXHAUSTED');
  };
  const boundedRun = (command, args, options = {}) => {
    active();
    return run(command, args, {
      ...options,
      timeout: Math.min(options.timeout ?? 10_000, workDeadlineAt - now()),
    });
  };
  const cleanupRun = (command, args, options = {}) => {
    const remaining = deadlineAt - now();
    if (remaining <= 0) fail('CLEANUP_UNCONFIRMED');
    return run(command, args, {
      ...options,
      timeout: Math.min(options.timeout ?? 3000, remaining),
    });
  };
  const progress = (phase, extra = {}) =>
    onProgress({
      stage,
      phase,
      attempt,
      sourceSha: /^[a-f0-9]{40}$/u.test(env.MAXIM_EXPECTED_DEPLOY_SHA ?? '')
        ? env.MAXIM_EXPECTED_DEPLOY_SHA
        : null,
      imageId,
      selector,
      applicationName,
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(deadlineAt).toISOString(),
      lastStorageAt: lastStorageAt === null ? null : new Date(lastStorageAt).toISOString(),
      lastRuntimeAt: lastRuntimeAt === null ? null : new Date(lastRuntimeAt).toISOString(),
      ...extra,
    });
  const cleanup = async () => {
    if (!attempted) return;
    if (cleanupStarted) fail('CLEANUP_UNCONFIRMED');
    cleanupStarted = true;
    progress('cleanup');
    await stop(composeArgs, child, applicationName, applicationName, { run: cleanupRun });
    if (preparationUnconfirmed || now() > deadlineAt) fail('CLEANUP_UNCONFIRMED');
    attempted = false;
    progress('cleanup_confirmed');
  };
  const runtime = async (phase) => {
    active();
    if (lastRuntimeAt !== null && now() - lastRuntimeAt > 30_000) fail('RUNTIME_SAMPLE_GAP');
    const sample = await checkRuntime({ run: boundedRun, now });
    active();
    if (lastRuntimeAt !== null && now() - lastRuntimeAt > 30_000) fail('RUNTIME_SAMPLE_GAP');
    guard[phase](sample);
    lastRuntimeAt = now();
    nextRuntimeAt = lastRuntimeAt + 10_000;
  };
  const storage = async (initial) => {
    active();
    if (lastStorageAt !== null && now() - lastStorageAt > 10_000) fail('STORAGE_SAMPLE_GAP');
    const devices = await readFilesystems(composeArgs, initial, boundedRun);
    active();
    if (lastStorageAt !== null && now() - lastStorageAt > 10_000) fail('STORAGE_SAMPLE_GAP');
    if (
      !Array.isArray(devices) ||
      !devices.length ||
      devices.some(
        (device) =>
          !Number.isSafeInteger(device.availableBytes) ||
          device.availableBytes < OUTCOME_COHORT_MINIMUM_FREE_BYTES,
      )
    )
      fail('RESERVE_EXHAUSTED');
    lastStorageAt = now();
  };
  try {
    active();
    progress('state');
    let state = await readState(composeArgs, { root, run: boundedRun });
    active();
    if (state.state === 'already_applied') {
      progress('already_applied');
      return { state: 'already_applied' };
    }
    for (const next of state.pending) {
      selector = next;
      applicationName = `maxim-online-${randomUUID()}`;
      child = undefined;
      cleanupStarted = false;
      let initial = await checkCapacity(composeArgs, { root, run: boundedRun });
      active();
      if (initial.skipped || initial.state.pending[0] !== selector) fail('STATE_CHANGED');
      lastStorageAt = null;
      lastRuntimeAt = null;
      const admissionStartedAt = now();
      progress('admission');
      await storage(initial);
      await runtime('admit');
      while (now() - admissionStartedAt < OUTCOME_COHORT_ADMISSION_MS) {
        await waitForTick(
          new Promise(() => {}),
          Math.min(2000, OUTCOME_COHORT_ADMISSION_MS - (now() - admissionStartedAt)),
        );
        await storage(initial);
        if (now() >= nextRuntimeAt) await runtime('admit');
        progress('admission_sample');
      }
      await runtime('admit');
      // Container creation is still pre-DDL. Recheck full reserve, identity and runtime after
      // it completes; no pending Docker create can outlive the cleanup owner unnoticed.
      progress('client_create');
      const launcher = await createLauncher(composeArgs, selector, { env, run: boundedRun });
      imageId = launcher.identity?.imageId ?? null;
      active();
      attempted = true;
      preparationUnconfirmed = true;
      await launcher.prepare(applicationName);
      preparationUnconfirmed = false;
      active();
      const refreshed = await checkCapacity(composeArgs, { root, run: boundedRun });
      active();
      if (refreshed.skipped || refreshed.state.pending[0] !== selector) fail('STATE_CHANGED');
      lastStorageAt = null;
      lastRuntimeAt = null;
      await storage(initial);
      await runtime('admit');
      initial = refreshed;
      progress('work');
      child = launcher.start(applicationName);
      let result;
      const done = new Promise((resolve) => {
        const finish = (value) => {
          if (!result) {
            result = value;
            resolve();
          }
        };
        child.once('error', () => finish({ error: true }));
        child.once('exit', (code, signal) => finish({ code, signal }));
      });
      while (!result) {
        await waitForTick(done, 2000);
        active();
        if (result) break;
        await storage(initial);
        if (now() >= nextRuntimeAt) await runtime('observe');
        progress('work_sample');
      }
      active();
      progress('client_exit', { exitCode: result.code ?? null, signal: result.signal ?? null });
      if (result.error || result.signal || result.code !== 0) fail('PRISMA_DEPLOY_FAILED');
      await cleanup();
      active();
      state = await readState(composeArgs, { root, run: boundedRun });
      active();
      if (state.pending.includes(selector)) fail('PREPARATION_INCOMPLETE');
      lastStorageAt = null;
      lastRuntimeAt = null;
      await storage(initial);
      await runtime('finish');
      progress('target_verified');
    }
    if (state.state !== 'already_applied') fail('PREPARATION_INCOMPLETE');
    progress('complete');
    return { state: 'already_applied' };
  } catch (error) {
    let failure = failureCode(error);
    try {
      await cleanup();
    } catch {
      failure = failureCode(new Error('OUTCOME_COHORT_CLEANUP_UNCONFIRMED'));
    }
    progress('failed', { code: failure });
    throw new Error(failure);
  } finally {
    for (const signal of signalsList) signals.off(signal, interrupt);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const uninstall = installMultibotOutputFence();
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'preflight') {
      const result = await checkOutcomeCohortPrepareCapacity(args);
      console.log(JSON.stringify({ stage: 'outcome_cohort_preflight', ...result }));
    } else if (mode === 'prepare') {
      await prepareOutcomeCohortIndexes(args, {
        onProgress: (event) => console.log(JSON.stringify(event)),
      });
    } else fail('ARGUMENTS_INVALID');
  } catch (error) {
    console.error(
      `${outcomeCohortFailureCode(error)}; old roles remain live; receipts and indexes preserved.`,
    );
    process.exitCode = 1;
  } finally {
    uninstall();
  }
}
