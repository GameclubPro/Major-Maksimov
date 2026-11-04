import { execFileSync } from 'node:child_process';

export const REPOSITORY = 'GameclubPro/Major-Maksimov';
export const REPOSITORY_ID = 1168895008;
export const GITHUB_ACTIONS_APP_ID = 15368;
export const GREEN_WORKFLOWS = Object.freeze([
  Object.freeze({ id: 239705081, path: '.github/workflows/ci.yml', check: 'Required' }),
  Object.freeze({
    id: 315747026,
    path: '.github/workflows/codeql.yml',
    check: 'Analyze JavaScript and TypeScript',
  }),
]);

export class UnprovedWorkflowError extends Error {}

// FLAG: Exhausted pagination or an unavailable observation is an evidence gap,
// never permission to reuse an older green run. No success filter belongs here.
export function createGitHubClient({
  cwd = process.cwd(),
  deadlineMs = 90000,
  maxCalls = 160,
} = {}) {
  const deadline = Date.now() + deadlineMs;
  let calls = 0;
  const request = (endpoint, binary = false) => {
    if (++calls > maxCalls || Date.now() >= deadline) {
      throw new Error('GitHub evidence collection exceeded its bounded budget.');
    }
    const output = execFileSync('gh', ['api', '--method', 'GET', endpoint], {
      cwd,
      encoding: binary ? undefined : 'utf8',
      maxBuffer: binary ? 1024 * 1024 : 8 * 1024 * 1024,
      timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return binary ? output : JSON.parse(output);
  };
  return { json: (endpoint) => request(endpoint), binary: (endpoint) => request(endpoint, true) };
}

export function listComplete(github, endpoint, key, { maxPages = 10 } = {}) {
  const items = [];
  let expected;
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = github.json(
      `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    if (!Array.isArray(payload?.[key]) || !Number.isSafeInteger(payload.total_count)) {
      throw new Error(`Incomplete GitHub ${key} pagination metadata.`);
    }
    if (expected !== undefined && payload.total_count !== expected) {
      throw new Error(`GitHub ${key} changed during pagination.`);
    }
    expected = payload.total_count;
    const batch = payload[key];
    if (batch.length > 100 || batch.some((item) => !Number.isSafeInteger(item.id))) {
      throw new Error(`Invalid GitHub ${key} page.`);
    }
    items.push(...batch);
    if (new Set(items.map(({ id }) => id)).size !== items.length || items.length > expected) {
      throw new Error(`Duplicate or inconsistent GitHub ${key} page.`);
    }
    if (items.length === expected) return items;
    if (batch.length < 100) throw new Error(`Missing GitHub ${key} page.`);
  }
  throw new Error(`GitHub ${key} pagination limit reached.`);
}

function eligibleRun(run, sha, workflow, purpose) {
  if (
    run.head_sha !== sha ||
    run.workflow_id !== workflow.id ||
    run.path !== workflow.path ||
    run.repository?.full_name !== REPOSITORY ||
    run.repository?.id !== REPOSITORY_ID
  )
    return false;
  const main =
    (run.event === 'push' || (purpose === 'publication' && run.event === 'workflow_dispatch')) &&
    run.head_branch === 'main' &&
    run.head_repository?.id === REPOSITORY_ID &&
    run.head_repository?.full_name === REPOSITORY;
  return (
    main ||
    (purpose === 'review' &&
      run.event === 'pull_request' &&
      typeof run.head_branch === 'string' &&
      run.head_branch.length > 0)
  );
}

function latestRun(github, sha, workflow, purpose) {
  const runs = listComplete(
    github,
    `repos/${REPOSITORY}/actions/workflows/${workflow.id}/runs?head_sha=${sha}`,
    'workflow_runs',
  );
  return runs
    .filter((run) => eligibleRun(run, sha, workflow, purpose))
    .sort((left, right) => right.id - left.id)[0];
}

function sameCurrentRun(actual, expected, sha, workflow, purpose) {
  if (
    !eligibleRun(actual, sha, workflow, purpose) ||
    actual.id !== expected.id ||
    actual.run_attempt !== expected.run_attempt ||
    actual.check_suite_id !== expected.check_suite_id ||
    actual.status !== 'completed' ||
    actual.conclusion !== 'success'
  ) {
    throw new UnprovedWorkflowError(
      `${workflow.check}: latest workflow run/attempt is not successful.`,
    );
  }
}

export function proveGreenWorkflow({ github, sha, workflow, purpose = 'production', expectedRun }) {
  if (
    !/^[a-f0-9]{40}$/u.test(sha ?? '') ||
    !GREEN_WORKFLOWS.some(
      (entry) =>
        entry.id === workflow?.id && entry.path === workflow.path && entry.check === workflow.check,
    )
  ) {
    throw new Error('Expected the exact source SHA and an approved workflow identity.');
  }
  if (!['production', 'review', 'publication'].includes(purpose))
    throw new Error('Unknown CI proof purpose.');
  if (
    purpose === 'publication' &&
    (workflow.id !== GREEN_WORKFLOWS[0].id ||
      !Number.isSafeInteger(expectedRun?.id) ||
      expectedRun.id < 1 ||
      !Number.isSafeInteger(expectedRun?.attempt) ||
      expectedRun.attempt < 1)
  ) {
    throw new Error('Publication proof requires a bound CI run and attempt.');
  }
  if (expectedRun && purpose !== 'publication')
    throw new Error('Bound CI invocations require publication purpose.');
  const selected = expectedRun
    ? github.json(`repos/${REPOSITORY}/actions/runs/${expectedRun.id}`)
    : latestRun(github, sha, workflow, purpose);
  if (
    expectedRun &&
    (selected.id !== expectedRun.id || selected.run_attempt !== expectedRun.attempt)
  ) {
    throw new UnprovedWorkflowError(
      'Publication run attempt differs from the immutable image record.',
    );
  }
  if (!selected)
    throw new UnprovedWorkflowError(`${workflow.check}: no trusted workflow run for ${sha}.`);
  const run = github.json(`repos/${REPOSITORY}/actions/runs/${selected.id}`);
  if (
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !Number.isSafeInteger(run.check_suite_id)
  )
    throw new Error('Invalid workflow attempt identity.');
  sameCurrentRun(run, selected, sha, workflow, purpose);
  const jobs = listComplete(
    github,
    `repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    'jobs',
  );
  const named = jobs.filter((job) => job.name === workflow.check);
  if (named.length !== 1)
    throw new UnprovedWorkflowError(
      `${workflow.check}: expected one exact job in the current attempt.`,
    );
  const job = named[0];
  const checkUrl = new RegExp(
    `^https://api\\.github\\.com/repos/${REPOSITORY}/check-runs/([0-9]+)$`,
    'u',
  );
  const checkId = Number(job.check_run_url?.match(checkUrl)?.[1]);
  if (
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    job.head_sha !== sha ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    !Number.isSafeInteger(checkId)
  ) {
    throw new UnprovedWorkflowError(`${workflow.check}: current attempt job is not successful.`);
  }
  const checks = listComplete(
    github,
    `repos/${REPOSITORY}/check-suites/${run.check_suite_id}/check-runs?filter=all`,
    'check_runs',
  );
  const matching = checks.filter((check) => check.id === checkId);
  const check = matching[0];
  if (
    matching.length !== 1 ||
    check.name !== workflow.check ||
    check.head_sha !== sha ||
    check.app?.id !== GITHUB_ACTIONS_APP_ID ||
    check.check_suite?.id !== run.check_suite_id ||
    check.status !== 'completed' ||
    check.conclusion !== 'success' ||
    check.details_url !== `https://github.com/${REPOSITORY}/actions/runs/${run.id}/job/${job.id}`
  ) {
    throw new UnprovedWorkflowError(
      `${workflow.check}: check provenance does not match the workflow job.`,
    );
  }
  // FLAG: Reruns can begin while jobs/checks are being read. Observe the current attempt
  // and latest run again; completion time must not select an older green run.
  sameCurrentRun(
    github.json(`repos/${REPOSITORY}/actions/runs/${run.id}`),
    run,
    sha,
    workflow,
    purpose,
  );
  if (!expectedRun) {
    const latest = latestRun(github, sha, workflow, purpose);
    if (!latest) throw new UnprovedWorkflowError(`${workflow.check}: latest workflow disappeared.`);
    sameCurrentRun(latest, run, sha, workflow, purpose);
  }
  return {
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    sha,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    runId: run.id,
    runAttempt: run.run_attempt,
    checkSuiteId: run.check_suite_id,
    jobId: job.id,
    checkId,
    event: run.event,
    ref: ['push', 'workflow_dispatch'].includes(run.event)
      ? 'refs/heads/main'
      : `refs/heads/${run.head_branch}`,
    check,
  };
}

export function workflowIdentity(proof) {
  const identity = { ...proof };
  delete identity.check;
  return identity;
}

export function proveGreenWorkflows({ github, sha, purpose = 'production' }) {
  if (!['production', 'review'].includes(purpose))
    throw new Error('Paired production gates require push-main or review evidence.');
  return GREEN_WORKFLOWS.map((workflow) => proveGreenWorkflow({ github, sha, workflow, purpose }));
}
