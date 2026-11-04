import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GREEN_WORKFLOWS, REPOSITORY } from './green-workflow-proof.mjs';
import { githubEvidence, workflowRun } from './test/github-evidence-fixture.mjs';

import {
  assertCommitHasGreenCi,
  assertGreenCheckRuns,
  parseCiArguments,
  findLatestRequiredCheck,
  GITHUB_ACTIONS_APP_ID,
  parseGitHubRepository,
  PRODUCTION_REQUIRED_CHECK,
  PRODUCTION_REQUIRED_CHECKS,
} from './assert-green.mjs';

const exactSha = 'a'.repeat(40);

function checkRun(name, overrides = {}) {
  return {
    id: 1,
    name,
    head_sha: exactSha,
    app: { id: GITHUB_ACTIONS_APP_ID },
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:01:00Z',
    ...overrides,
  };
}

test('pins the production aggregate and CodeQL checks to GitHub Actions', () => {
  assert.equal(PRODUCTION_REQUIRED_CHECK, 'Required');
  assert.deepEqual(PRODUCTION_REQUIRED_CHECKS, [
    { name: 'Required', appId: GITHUB_ACTIONS_APP_ID },
    { name: 'Analyze JavaScript and TypeScript', appId: GITHUB_ACTIONS_APP_ID },
  ]);
});

test('parses SSH and HTTPS GitHub remotes', () => {
  assert.equal(parseGitHubRepository('git@github.com:GameclubPro/MAXIM.git'), 'GameclubPro/MAXIM');
  assert.equal(
    parseGitHubRepository('https://github.com/GameclubPro/MAXIM.git'),
    'GameclubPro/MAXIM',
  );
});

test('requires exact completed successful aggregate and CodeQL checks', () => {
  const runs = [checkRun('Required'), checkRun('Analyze JavaScript and TypeScript', { id: 2 })];
  assert.equal(
    findLatestRequiredCheck(runs, exactSha, PRODUCTION_REQUIRED_CHECKS[1]).name,
    'Analyze JavaScript and TypeScript',
  );
  assert.deepEqual(
    assertGreenCheckRuns({ check_runs: runs }, exactSha).map((run) => run.name),
    ['Required', 'Analyze JavaScript and TypeScript'],
  );
});

test('rejects missing CodeQL and checks from the wrong app or commit', () => {
  assert.throws(
    () => assertGreenCheckRuns({ check_runs: [checkRun('Required')] }, exactSha),
    /Analyze JavaScript and TypeScript.*not found/u,
  );
  assert.throws(
    () =>
      assertGreenCheckRuns(
        {
          check_runs: [
            checkRun('Required'),
            checkRun('Analyze JavaScript and TypeScript', { app: { id: 1 } }),
          ],
        },
        exactSha,
      ),
    /app=1/u,
  );
  assert.throws(
    () =>
      assertGreenCheckRuns(
        {
          check_runs: [
            checkRun('Required'),
            checkRun('Analyze JavaScript and TypeScript', { head_sha: 'b'.repeat(40) }),
          ],
        },
        exactSha,
      ),
    /head=b+/u,
  );
});

test('rejects every non-success terminal or pending state', () => {
  for (const [status, conclusion] of [
    ['in_progress', null],
    ['completed', 'failure'],
    ['completed', 'cancelled'],
    ['completed', 'skipped'],
  ]) {
    assert.throws(
      () =>
        assertGreenCheckRuns(
          {
            check_runs: [
              checkRun('Required'),
              checkRun('Analyze JavaScript and TypeScript', { status, conclusion }),
            ],
          },
          exactSha,
        ),
      new RegExp(`${status}/${conclusion ?? 'pending'}`, 'u'),
    );
  }
});

test('a newer failed rerun overrides an older successful check', () => {
  const codeql = 'Analyze JavaScript and TypeScript';
  assert.throws(
    () =>
      assertGreenCheckRuns(
        {
          check_runs: [
            checkRun('Required'),
            checkRun(codeql, { id: 2 }),
            checkRun(codeql, {
              id: 3,
              status: 'completed',
              conclusion: 'failure',
              started_at: '2026-01-02T00:00:00Z',
            }),
          ],
        },
        exactSha,
      ),
    /completed\/failure/u,
  );
});

test('a newer queued rerun without started_at overrides an older success', () => {
  const codeql = 'Analyze JavaScript and TypeScript';
  assert.throws(
    () =>
      assertGreenCheckRuns(
        {
          check_runs: [
            checkRun('Required'),
            checkRun(codeql, { id: 10 }),
            checkRun(codeql, {
              id: 11,
              status: 'queued',
              conclusion: null,
              started_at: null,
              completed_at: null,
            }),
          ],
        },
        exactSha,
      ),
    /queued\/pending/u,
  );
});

test('CLI parses explicit production and paired publication run identity', () => {
  assert.deepEqual(
    parseCiArguments(
      ['abc', '--purpose', 'production', '--run-id', '123', '--run-attempt', '2'],
      {},
    ),
    { sha: 'abc', purpose: 'production', expectedCiRun: { id: 123, attempt: 2 } },
  );
  assert.deepEqual(parseCiArguments([], {}), { sha: 'HEAD', purpose: 'review' });
  assert.deepEqual(parseCiArguments(['HEAD'], { MAXIM_CI_PURPOSE: 'production' }), {
    sha: 'HEAD',
    purpose: 'production',
  });
  for (const args of [
    ['--purpose'],
    ['--purpose', 'anything'],
    ['--run-id', '123'],
    ['--run-attempt', '1'],
    ['--run-id', '123', '--run-attempt', '1'],
    ['--purpose', 'production', '--run-id', 'NaN', '--run-attempt', '1'],
    ['HEAD', 'extra'],
    ['--unknown'],
  ]) {
    assert.throws(() => parseCiArguments(args, {}));
  }
});

test('operational gate binds production checks and publication run without borrowing an old attempt', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'maxim-ci-green-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', '/dev/null');
    git('remote', 'add', 'origin', `https://github.com/${REPOSITORY}.git`);
    writeFileSync(join(cwd, 'README.md'), 'fixture');
    git('add', 'README.md');
    git('commit', '--no-verify', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    const runs = GREEN_WORKFLOWS.map((workflow, index) =>
      workflowRun(sha, { workflow, id: 100 + index }),
    );
    const publication = workflowRun(sha, { id: 200, attempt: 2, event: 'workflow_dispatch' });
    const options = { cwd, sha, purpose: 'production', expectedCiRun: { id: 200, attempt: 2 } };
    const good = () => githubEvidence({ runs: [...runs, publication] });
    const result = assertCommitHasGreenCi({ ...options, github: good() });
    assert.equal(result.publication.runId, 200);
    assert.equal(result.proofs[0].runId, 100);
    assert.throws(
      () => assertCommitHasGreenCi({ ...options, purpose: 'review', github: good() }),
      /independent production gates/u,
    );
    assert.throws(
      () =>
        assertCommitHasGreenCi({
          ...options,
          expectedCiRun: { id: 200, attempt: 1 },
          github: good(),
        }),
      /attempt differs/u,
    );
    publication.run.conclusion = 'failure';
    assert.throws(() => assertCommitHasGreenCi({ ...options, github: good() }), /not successful/u);
    publication.run.conclusion = 'success';
    runs[0].run.conclusion = 'failure';
    assert.throws(() => assertCommitHasGreenCi({ ...options, github: good() }), /not successful/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
