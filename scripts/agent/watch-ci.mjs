import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  GREEN_WORKFLOWS,
  REPOSITORY,
  REPOSITORY_ID,
  createGitHubClient,
  proveGreenWorkflows,
} from '../ci/green-workflow-proof.mjs';

const runCommand = promisify(execFile);
const intervalMs = 45_000;
function positiveId(value) {
  const id = Number(value);
  if (!/^[1-9]\d*$/u.test(value ?? '') || !Number.isSafeInteger(id))
    throw new Error('Expected a positive numeric GitHub run ID.');
  return id;
}

export function readWatchOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      sha: { type: 'string' },
      'ci-run': { type: 'string' },
      'codeql-run': { type: 'string' },
      review: { type: 'boolean' },
      'timeout-sec': { type: 'string', default: '1800' },
    },
  });
  if (!/^[a-f0-9]{40}$/u.test(values.sha ?? ''))
    throw new Error('Supply the full 40-character --sha.');
  const timeout = Number(values['timeout-sec']);
  if (!Number.isInteger(timeout) || timeout < 60 || timeout > 3600)
    throw new Error('--timeout-sec must be between 60 and 3600.');
  const ids = [positiveId(values['ci-run']), positiveId(values['codeql-run'])];
  if (ids[0] === ids[1]) throw new Error('CI and CodeQL must have distinct run IDs.');
  return {
    sha: values.sha,
    ids,
    purpose: values.review ? 'review' : 'production',
    timeoutMs: timeout * 1000,
  };
}

async function getRun(id, deadline) {
  const timeout = Math.min(15_000, deadline - Date.now());
  if (timeout <= 0) throw new Error('Observation deadline reached.');
  try {
    const { stdout } = await runCommand(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        `repos/${REPOSITORY}/actions/runs/${id}`,
      ],
      { timeout, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
    );
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Could not read GitHub run ${id}.`);
  }
}

function validateRun(run, id, sha, workflow, purpose) {
  const trustedMain =
    run?.event === 'push' &&
    run.head_branch === 'main' &&
    run.head_repository?.id === REPOSITORY_ID &&
    run.head_repository?.full_name === REPOSITORY;
  const trustedReview =
    purpose === 'review' &&
    run?.event === 'pull_request' &&
    typeof run.head_branch === 'string' &&
    run.head_branch.length > 0;
  if (
    !(trustedMain || trustedReview) ||
    run.id !== id ||
    run.head_sha !== sha ||
    run.workflow_id !== workflow.id ||
    run.path !== workflow.path ||
    run.repository?.id !== REPOSITORY_ID ||
    run.repository?.full_name !== REPOSITORY ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1
  )
    throw new Error(`Run ${id} does not match the requested commit, workflow and event. `);
  if (
    !['queued', 'requested', 'pending', 'waiting', 'in_progress', 'completed'].includes(run.status)
  )
    throw new Error(`GitHub returned an unknown status for run ${id}.`);
  return {
    check: workflow.check,
    runId: id,
    attempt: run.run_attempt,
    status: run.status,
    conclusion: run.conclusion ?? null,
  };
}

function verify(options, deadline) {
  return proveGreenWorkflows({
    github: createGitHubClient({ deadlineMs: Math.max(1, deadline - Date.now()), maxCalls: 40 }),
    sha: options.sha,
    purpose: options.purpose,
  });
}

export async function watchSelectedCI(
  options,
  {
    readRun = getRun,
    prove = verify,
    now = Date.now,
    wait = sleep,
    emit = (event) => process.stdout.write(JSON.stringify(event) + '\n'),
  } = {},
) {
  const start = now();
  const deadline = start + options.timeoutMs;
  let lastObserved;
  let lastFingerprint;
  emit({
    event: 'watch_started',
    sha: options.sha,
    runIds: options.ids,
    purpose: options.purpose,
    deadline: new Date(deadline).toISOString(),
  });
  while (now() < deadline) {
    const runs = await Promise.all(options.ids.map((id) => readRun(id, deadline)));
    const statuses = runs.map((run, i) =>
      validateRun(run, options.ids[i], options.sha, GREEN_WORKFLOWS[i], options.purpose),
    );
    if (now() >= deadline) break;
    lastObserved = new Date(now()).toISOString();
    const fingerprint = JSON.stringify(statuses);
    if (fingerprint !== lastFingerprint) {
      emit({ event: 'workflows', sha: options.sha, observedAt: lastObserved, statuses });
      lastFingerprint = fingerprint;
    }
    const failed = statuses.find(
      (run) => run.status === 'completed' && run.conclusion !== 'success',
    );
    if (failed)
      throw new Error(
        `${failed.check}, run ${failed.runId} attempt ${failed.attempt}, ended with ${failed.conclusion ?? 'an unknown conclusion'}.`,
      );
    if (statuses.every((run) => run.status === 'completed')) {
      const proof = await prove(options, deadline);
      if (now() >= deadline) break;
      if (
        proof.length !== statuses.length ||
        !statuses.every(
          ({ runId, attempt }, i) =>
            proof[i].sha === options.sha &&
            proof[i].workflowId === GREEN_WORKFLOWS[i].id &&
            proof[i].runId === runId &&
            proof[i].runAttempt === attempt,
        )
      )
        throw new Error(
          'The current gate proofs refer to different runs or attempts. Select their current IDs.',
        );
      emit({
        event: 'verified',
        sha: options.sha,
        checks: proof.map(({ workflowId, runId, runAttempt, jobId, checkId }) => ({
          workflowId,
          runId,
          runAttempt,
          jobId,
          checkId,
        })),
      });
      return;
    }
    await wait(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
  throw new Error(
    `Timed out watching ${options.sha}. Last complete observation: ${lastObserved ?? 'none'}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await watchSelectedCI(readWatchOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}
