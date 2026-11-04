import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GREEN_WORKFLOWS,
  REPOSITORY,
  listComplete,
  proveGreenWorkflow,
  proveGreenWorkflows,
} from './green-workflow-proof.mjs';
import { githubEvidence, workflowRun } from './test/github-evidence-fixture.mjs';

const sha = 'a'.repeat(40);
const workflow = GREEN_WORKFLOWS[0];
const prove = (runs, options = {}) =>
  proveGreenWorkflow({ github: githubEvidence({ runs }), sha, workflow, ...options });

test('production proves both exact workflow jobs and their check provenance', () => {
  const runs = GREEN_WORKFLOWS.map((entry) => workflowRun(sha, { workflow: entry }));
  const proofs = proveGreenWorkflows({ github: githubEvidence({ runs }), sha });
  assert.deepEqual(
    proofs.map((proof) => proof.workflowId),
    GREEN_WORKFLOWS.map((entry) => entry.id),
  );
  assert.deepEqual(
    proofs.map((proof) => proof.check.name),
    ['Required', 'Analyze JavaScript and TypeScript'],
  );
  assert.equal(proofs[0].runAttempt, 1);
  assert.equal(proofs[0].ref, 'refs/heads/main');
});

test('production refuses PR/manual runs while review permits a proven PR workflow', () => {
  for (const event of ['pull_request', 'workflow_dispatch', 'pull_request_target', 'schedule']) {
    const entry = workflowRun(sha, { event });
    assert.throws(() => prove([entry]), /no trusted workflow/u, event);
    if (event === 'pull_request') assert.equal(prove([entry], { purpose: 'review' }).event, event);
  }
});

test('a newer failed, cancelled or queued main run blocks an older green main run', () => {
  for (const [status, conclusion] of [
    ['completed', 'failure'],
    ['completed', 'cancelled'],
    ['queued', null],
  ]) {
    const older = workflowRun(sha, { id: 100 });
    const newer = workflowRun(sha, { id: 101, status, conclusion });
    assert.throws(() => prove([older, newer]), /not successful/u);
  }
});

test('repository, workflow, source, exact job and check substitutions fail closed', () => {
  const mutations = [
    (entry) => {
      entry.run.repository.id += 1;
    },
    (entry) => {
      entry.run.repository.full_name = 'attacker/Major-Maksimov';
    },
    (entry) => {
      entry.run.head_repository.id += 1;
    },
    (entry) => {
      entry.run.workflow_id += 1;
    },
    (entry) => {
      entry.run.path = '.github/workflows/lookalike.yml';
    },
    (entry) => {
      entry.run.head_branch = 'feature';
    },
    (entry) => {
      entry.run.head_sha = 'b'.repeat(40);
    },
    (entry) => {
      entry.jobs[0].head_sha = 'b'.repeat(40);
    },
    (entry) => {
      entry.jobs[0].run_attempt += 1;
    },
    (entry) => {
      entry.jobs[0].run_id += 1;
    },
    (entry) => {
      entry.jobs[0].check_run_url = 'https://api.github.com/repos/attacker/repo/check-runs/2';
    },
    (entry) => {
      entry.jobs.push({ ...entry.jobs[0], id: entry.jobs[0].id + 1 });
    },
    (entry) => {
      entry.checks[0].app.id = 1;
    },
    (entry) => {
      entry.checks[0].check_suite.id += 1;
    },
    (entry) => {
      entry.checks[0].head_sha = 'b'.repeat(40);
    },
    (entry) => {
      entry.checks[0].details_url = `https://github.com/${REPOSITORY}/actions/runs/1/job/2`;
    },
    (entry) => {
      entry.checks[0].conclusion = 'skipped';
    },
  ];
  for (const mutate of mutations) {
    const entry = workflowRun(sha);
    mutate(entry);
    assert.throws(() => prove([entry]), undefined, mutate.toString());
  }
});

test('full pagination finds a newer non-green run and never truncates check history', () => {
  const runs = Array.from({ length: 101 }, (_, index) => workflowRun(sha, { id: index + 1 }));
  runs.at(-1).run.conclusion = 'failure';
  assert.throws(() => prove(runs), /not successful/u);
  const entry = workflowRun(sha);
  const correct = entry.checks[0];
  entry.checks = Array.from({ length: 100 }, (_, index) => ({
    ...correct,
    id: index + 1,
    name: 'Other',
  }));
  entry.checks.push(correct);
  const client = githubEvidence({ runs: [entry] });
  assert.equal(proveGreenWorkflow({ github: client, sha, workflow }).checkId, correct.id);
  assert.ok(
    client.calls.some((endpoint) => endpoint.includes('check-runs') && endpoint.endsWith('page=2')),
  );
});

test('incomplete, changing, duplicated or exhausted pagination is an evidence gap', () => {
  for (const response of [
    { workflow_runs: [] },
    { total_count: 2, workflow_runs: [{ id: 1 }] },
    { total_count: 2, workflow_runs: [{ id: 1 }, { id: 1 }] },
    { total_count: 0, workflow_runs: [{ id: 1 }] },
  ])
    assert.throws(() => listComplete({ json: () => response }, 'endpoint', 'workflow_runs'));
  let count = 0;
  assert.throws(
    () =>
      listComplete(
        {
          json: () => ({
            total_count: ++count === 1 ? 101 : 102,
            workflow_runs: Array.from({ length: count === 1 ? 100 : 2 }, (_, index) => ({
              id: 100 * (count - 1) + index,
            })),
          }),
        },
        'endpoint',
        'workflow_runs',
      ),
    /changed during pagination/u,
  );
  assert.throws(
    () =>
      listComplete(
        {
          json: () => ({
            total_count: 101,
            workflow_runs: Array.from({ length: 100 }, (_, id) => ({ id })),
          }),
        },
        'endpoint',
        'workflow_runs',
        { maxPages: 1 },
      ),
    /limit/u,
  );
});

test('a rerun starting while evidence is read invalidates the earlier success', () => {
  const entry = workflowRun(sha);
  const client = githubEvidence({ runs: [entry] });
  const request = client.json;
  let reads = 0;
  client.json = (endpoint) => {
    const result = request(endpoint);
    if (endpoint.endsWith(`/actions/runs/${entry.run.id}`) && ++reads === 2) {
      result.run_attempt = 2;
      result.status = 'in_progress';
      result.conclusion = null;
    }
    return result;
  };
  assert.throws(() => proveGreenWorkflow({ github: client, sha, workflow }), /not successful/u);
});

test('publication binds manual main CI to its current successful attempt and cannot replace production gates', () => {
  const entry = workflowRun(sha, { event: 'workflow_dispatch', id: 900, attempt: 2 });
  const options = { purpose: 'publication', expectedRun: { id: 900, attempt: 2 } };
  assert.equal(prove([entry], options).event, 'workflow_dispatch');
  assert.throws(
    () => prove([entry], { ...options, expectedRun: { id: 900, attempt: 1 } }),
    /attempt differs/u,
  );
  entry.run.conclusion = 'failure';
  assert.throws(() => prove([entry], options), /not successful/u);
  assert.throws(() => prove([entry], { purpose: 'publication' }), /bound CI run/u);
  assert.throws(
    () =>
      proveGreenWorkflows({
        github: githubEvidence({ runs: [entry] }),
        sha,
        purpose: 'publication',
      }),
    /production gates/u,
  );
});
