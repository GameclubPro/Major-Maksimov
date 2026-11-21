import assert from 'node:assert/strict';
import test from 'node:test';
import { GREEN_WORKFLOWS, REPOSITORY, REPOSITORY_ID } from '../../ci/green-workflow-proof.mjs';
import { watchSelectedCI, readWatchOptions } from '../watch-ci.mjs';

const sha = 'a'.repeat(40);
const options = readWatchOptions([
  '--sha',
  sha,
  '--ci-run',
  '42',
  '--codeql-run',
  '43',
  '--timeout-sec',
  '60',
]);
function run(id, patch = {}) {
  const workflow = GREEN_WORKFLOWS[id - 42];
  return {
    id,
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
    head_repository: { id: REPOSITORY_ID, full_name: REPOSITORY },
    workflow_id: workflow.id,
    path: workflow.path,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    ...patch,
  };
}
const proofs = GREEN_WORKFLOWS.map((workflow, i) => ({
  sha,
  workflowId: workflow.id,
  runId: 42 + i,
  runAttempt: 1,
}));

test('requires the selected SHA and distinct handpicked run IDs', () => {
  for (const args of [
    [],
    ['--sha', 'main'],
    ['--sha', sha, '--ci-run', '1', '--codeql-run', '1'],
    ['--sha', sha, '--ci-run', '1', '--codeql-run', '2', '--timeout-sec', '3601'],
  ])
    assert.throws(() => readWatchOptions(args));
});

test('observes both runs concurrently, reports changes and confirms the exact checks', async () => {
  let tick = 0;
  const events = [];
  const reads = [];
  await watchSelectedCI(
    { ...options, timeoutMs: 180000 },
    {
      now: () => tick,
      wait: async (ms) => {
        tick += ms;
      },
      emit: (event) => events.push(event),
      readRun: async (id) => {
        reads.push(id);
        await new Promise((resolve) => setImmediate(resolve));
        if (id === 42) assert.equal(reads.at(-1), 43);
        return run(
          id,
          tick < 90000 && id === 42 ? { status: 'in_progress', conclusion: null } : {},
        );
      },
      prove: () => proofs,
    },
  );
  assert.deepEqual(
    events.map((e) => e.event),
    ['watch_started', 'workflows', 'workflows', 'verified'],
  );
  assert.deepEqual(reads, [42, 43, 42, 43, 42, 43]);
});

test('timeouts, wrong SHA, a changed attempt and terminal failure never report verified', async () => {
  const common = {
    emit: () => {},
    now: () => 0,
    wait: async () => assert.fail('unexpected wait'),
    prove: () => proofs,
  };
  for (const patch of [
    { head_sha: 'b'.repeat(40) },
    { event: 'schedule' },
    { status: 'completed', conclusion: 'cancelled' },
    { workflow_id: 1 },
  ]) {
    await assert.rejects(
      watchSelectedCI(options, { ...common, readRun: async (id) => run(id, patch) }),
    );
  }
  await assert.rejects(
    watchSelectedCI(options, { ...common, readRun: async (id) => run(id, { run_attempt: 2 }) }),
    /different runs or attempts/u,
  );
  let t = 0;
  await assert.rejects(
    watchSelectedCI(options, {
      ...common,
      now: () => t,
      wait: async (ms) => {
        t += ms;
      },
      readRun: async (id) => run(id, { status: 'queued', conclusion: null }),
    }),
    /Timed out.*Last complete observation/u,
  );
  assert.equal(t, 60000);
});
