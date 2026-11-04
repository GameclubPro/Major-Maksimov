import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CI_LANES, ciOutputs, createCiPlan, verifyCiResults } from './impact.mjs';
import { REPOSITORY, REPOSITORY_ID } from './green-workflow-proof.mjs';

const cli = fileURLToPath(new URL('./impact.mjs', import.meta.url));
const workflow = parse(
  readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
);

async function repository(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'maxim-ci-impact-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  let revision = 0;
  const commit = (paths) => {
    for (const path of paths) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), `fixture revision ${++revision}\n`);
    }
    git('add', '-A');
    git('commit', '--no-verify', '-m', `fixture ${revision}`);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci-fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(cwd, 'empty-hooks'));
    git('config', 'core.hooksPath', join(cwd, 'empty-hooks'));
    const base = commit(['README.md']);
    await run({ cwd, git, commit, base });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const planningContext = (sha, event = 'pull_request') => ({
  repository: REPOSITORY,
  repositoryId: REPOSITORY_ID,
  sha,
  event,
  ref: event === 'pull_request' ? 'refs/pull/1/merge' : 'refs/heads/main',
  runId: 100,
  runAttempt: 1,
});
const planFor = (options) =>
  createCiPlan({ ...options, context: planningContext(options.sha, options.eventName) });
const rangePlan = (cwd, base, head) =>
  planFor({
    cwd,
    eventName: 'pull_request',
    event: { pull_request: { base: { sha: base }, head: { sha: head } } },
    sha: head,
  });
const validationLanes = CI_LANES.filter((lane) => lane !== 'registry');
const selected = (plan) => CI_LANES.filter((lane) => plan.lanes[lane]);
const results = (plan) => ({
  impact: { result: 'success', outputs: ciOutputs(plan) },
  ...Object.fromEntries(
    CI_LANES.map((lane) => [lane, { result: plan.lanes[lane] ? 'success' : 'skipped' }]),
  ),
});

test('miniapp-only Git changes select its browser validation and exact production image', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const head = commit(['apps/miniapp/src/pages/networks-page.tsx']);
    const plan = await rangePlan(cwd, base, head);
    assert.equal(plan.mode, 'scoped');
    assert.deepEqual(selected(plan), ['static', 'miniapp', 'docker']);
    assert.deepEqual(JSON.parse(ciOutputs(plan).docker_matrix).include, [
      {
        component: 'miniapp',
        dockerfile: 'apps/miniapp/Dockerfile',
        image_repository: 'maxim-miniapp-major',
        vite_api_base: 'https://major-maksimov.ru/api/v1',
      },
    ]);
    assert.doesNotThrow(() => verifyCiResults(plan, results(plan)));
  });
});

test('test-only and documentation changes do not build unrelated runtime images', async () => {
  for (const [path, expected] of [
    ['apps/miniapp/test/network-statistics.test.ts', ['static', 'miniapp']],
    ['apps/admin/test/settings.test.ts', ['static', 'admin']],
    ['packages/contracts/test/network.test.ts', ['static', 'contracts']],
    ['apps/api/AGENTS.md', ['static']],
  ]) {
    await repository(async ({ cwd, base, commit }) => {
      const plan = await rangePlan(cwd, base, commit([path]));
      assert.deepEqual(selected(plan), expected, path);
      assert.deepEqual(JSON.parse(ciOutputs(plan).docker_matrix), { include: [] });
    });
  }
});

test('API changes retain every native shard, Redis flow, benchmark and API image', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const plan = await rangePlan(
      cwd,
      base,
      commit(['apps/api/src/admin/network-settings.service.ts']),
    );
    assert.deepEqual(selected(plan), [
      'static',
      'api',
      'postgres-races',
      'commercial-benchmark',
      'docker',
    ]);
    assert.deepEqual(plan.dockerComponents, ['api']);
  });
});

test('reviewed local agent tools need Static without unrelated application suites or images', async () => {
  for (const path of [
    'scripts/agent/context.mjs',
    'scripts/agent/doctor.mjs',
    'scripts/agent/focused.mjs',
    'scripts/agent/task-worktree.mjs',
    'scripts/agent/test/context.test.mjs',
    'scripts/agent/test/focused.test.mjs',
    'scripts/agent/test/task-worktree.test.mjs',
    'scripts/check-docs.mjs',
    'scripts/check-docs.test.mjs',
  ]) {
    await repository(async ({ cwd, base, commit }) => {
      const plan = await rangePlan(cwd, base, commit([path, 'docs/README.md']));
      assert.deepEqual(selected(plan), ['static'], path);
      assert.deepEqual(plan.dockerComponents, []);
      assert.doesNotThrow(() => verifyCiResults(plan, results(plan)));
    });
  }
});

test('a local tool exception never hides shared callers, new tools or a rename into runtime', async () => {
  for (const path of [
    'scripts/agent/verify.mjs',
    'scripts/agent/verification-command.mjs',
    'scripts/agent/preflight.mjs',
    'scripts/agent/new-tool.mjs',
    'scripts/agent/test/new-tool.test.mjs',
    'scripts/agent/context.mjs.backup',
    'scripts/with-file-lock.mjs',
  ]) {
    await repository(async ({ cwd, base, commit }) => {
      const plan = await rangePlan(cwd, base, commit(['scripts/agent/context.mjs', path]));
      assert.deepEqual(selected(plan), validationLanes, path);
    });
  }
  await repository(async ({ cwd, commit, git }) => {
    const base = commit(['scripts/agent/context.mjs', 'apps/api/src/existing.ts']);
    git('mv', 'scripts/agent/context.mjs', 'apps/api/src/new-runtime.ts');
    const plan = await rangePlan(cwd, base, commit([]));
    assert.equal(plan.lanes.api, true);
    assert.equal(plan.lanes['postgres-races'], true);
    assert.deepEqual(plan.dockerComponents, ['api']);
  });
});

test('shared contracts, tooling, dependency inputs and unknown paths retain full coverage', async () => {
  for (const path of [
    'packages/contracts/src/networks.ts',
    '.github/workflows/ci.yml',
    'scripts/ci/impact.mjs',
    'config/change-impact.json',
    'infra/scripts/vps-connect.sh',
    'package-lock.json',
    'unknown/source.ts',
  ]) {
    await repository(async ({ cwd, base, commit }) => {
      const plan = await rangePlan(cwd, base, commit([path]));
      assert.deepEqual(selected(plan), validationLanes, path);
      assert.deepEqual(plan.dockerComponents, ['eraser', 'api', 'miniapp', 'admin']);
    });
  }
});

test('a multi-commit range and a cross-component rename include every affected boundary', async () => {
  await repository(async ({ cwd, base, commit, git }) => {
    commit(['apps/api/src/feature.ts']);
    const head = commit(['apps/miniapp/src/feature.ts']);
    const plan = await rangePlan(cwd, base, head);
    assert.equal(plan.lanes.api, true);
    assert.equal(plan.lanes.miniapp, true);
    git('mv', 'apps/api/src/feature.ts', 'apps/miniapp/src/renamed.ts');
    const renamed = commit([]);
    const renamePlan = await rangePlan(cwd, head, renamed);
    assert.equal(renamePlan.lanes.api, true);
    assert.equal(renamePlan.lanes.miniapp, true);
    assert.deepEqual(renamePlan.dockerComponents, ['api', 'miniapp']);
  });
});

test('PR merge checkout compares its recorded base and verifies the requested head', async () => {
  await repository(async ({ cwd, commit, git }) => {
    git('switch', '-c', 'feature');
    const requestedHead = commit(['apps/miniapp/src/feature.ts']);
    git('switch', 'main');
    const base = commit(['apps/api/src/base-change.ts']);
    git('merge', '--no-ff', 'feature', '-m', 'PR merge fixture');
    const sha = git('rev-parse', 'HEAD');
    const plan = await planFor({
      cwd,
      sha,
      eventName: 'pull_request',
      event: {
        pull_request: { base: { sha: base }, head: { sha: requestedHead } },
      },
    });
    assert.deepEqual(selected(plan), ['static', 'miniapp', 'docker']);
    await assert.rejects(
      planFor({
        cwd,
        sha,
        eventName: 'pull_request',
        event: {
          pull_request: { base: { sha: base }, head: { sha: 'a'.repeat(40) } },
        },
      }),
      /pull request head/u,
    );
  });
});

test('missing bases, rewritten history, manual and scheduled events run all lanes', async () => {
  await repository(async ({ cwd, base, commit, git }) => {
    const sha = commit(['apps/miniapp/src/feature.ts']);
    for (const before of ['0'.repeat(40), 'b'.repeat(40), undefined]) {
      assert.deepEqual(selected(await rangePlan(cwd, before, sha)), validationLanes);
    }
    git('switch', '-c', 'unrelated', base);
    const unrelated = commit(['docs/unrelated.md']);
    git('switch', 'main');
    assert.deepEqual(selected(await rangePlan(cwd, unrelated, sha)), validationLanes);
    for (const eventName of ['schedule', 'workflow_dispatch', 'unsupported']) {
      assert.deepEqual(
        selected(await planFor({ cwd, sha, eventName, event: {} })),
        eventName === 'workflow_dispatch' ? CI_LANES : validationLanes,
      );
    }
    await assert.rejects(
      planFor({ cwd, sha: base, eventName: 'push', event: {} }),
      /exact event SHA/u,
    );
    await assert.rejects(
      planFor({ cwd, sha, eventName: 'push', event: { before: base, after: base } }),
      /disagree/u,
    );
  });
});

test('Required rejects failed classification, selected skips, cancellation and a missing image', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const plan = await rangePlan(cwd, base, commit(['apps/miniapp/src/feature.ts']));
    for (const lane of ['static', 'miniapp', 'docker', 'impact']) {
      for (const state of ['failure', 'cancelled', 'skipped', 'neutral', undefined]) {
        const needs = results(plan);
        needs[lane].result = state;
        assert.throws(() => verifyCiResults(plan, needs), undefined, `${lane}: ${state}`);
      }
    }
    for (const alter of [
      (needs) => {
        delete needs.api;
      },
      (needs) => {
        needs.api.result = 'success';
      },
      (needs) => {
        needs.impact.outputs.api = 'false\nminiapp=false';
      },
      (needs) => {
        needs.impact.outputs.plan = '{}';
      },
      (needs) => {
        needs.impact.outputs.docker_matrix = '{"include":[]}';
      },
    ]) {
      const needs = results(plan);
      alter(needs);
      assert.throws(() => verifyCiResults(plan, needs));
    }
  });
});

test('real CLI emits bounded job outputs and independently rejects a substituted result plan', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const sha = commit(['apps/miniapp/src/feature.ts']);
    const eventPath = join(cwd, 'event.json');
    const outputPath = join(cwd, 'outputs');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { base: { sha: base }, head: { sha } } }),
    );
    const env = {
      ...process.env,
      GITHUB_SHA: sha,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
      GITHUB_RUN_ID: '100',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_REF: 'refs/pull/1/merge',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
    };
    const run = (command, extra = {}) =>
      spawnSync(process.execPath, [cli, command], {
        cwd,
        env: { ...env, ...extra },
        encoding: 'utf8',
      });
    const planned = run('plan');
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    const outputs = Object.fromEntries(
      readFileSync(outputPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    assert.deepEqual(outputs, ciOutputs(plan));
    const needs = results(plan);
    const accepted = run('verify', { CI_NEEDS: JSON.stringify(needs) });
    assert.equal(accepted.status, 0, accepted.stderr);
    needs.impact.outputs.miniapp = 'false';
    needs.miniapp.result = 'skipped';
    const rejected = run('verify', { CI_NEEDS: JSON.stringify(needs) });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /independently computed plan/u);
  });
});

test('workflow consumes the verified plan without weakening individual lane steps', () => {
  const { jobs } = workflow;
  assert.deepEqual([...jobs.required.needs].sort(), ['impact', ...CI_LANES].sort());
  assert.equal(jobs.static.needs, 'impact');
  assert.equal(jobs.static.if, undefined);
  for (const lane of CI_LANES.filter((name) => !['static', 'registry'].includes(name))) {
    assert.equal(jobs[lane].needs, 'impact');
    assert.equal(jobs[lane].if, `needs.impact.outputs.${lane.replaceAll('-', '_')} == 'true'`);
  }
  assert.deepEqual([...jobs.registry.needs].sort(), ['docker', 'impact']);
  assert.equal(jobs.registry.if, "needs.impact.outputs.registry == 'true'");
  assert.equal(jobs.impact.permissions.actions, 'read');
  assert.equal(jobs.required.permissions.actions, 'read');
  assert.equal(jobs.docker.strategy.matrix, '${{ fromJSON(needs.impact.outputs.docker_matrix) }}');
  assert.equal(jobs.impact.steps[0].with['fetch-depth'], 0);
  assert.equal(jobs.required.steps[0].with['fetch-depth'], 0);
  assert.equal(jobs.required.if, 'always()');
  assert.equal(jobs.impact['timeout-minutes'], 3);
  assert.equal(jobs.required['timeout-minutes'], 3);
  const gate = jobs.required.steps.find((step) => step.run);
  assert.equal(gate.run, 'node scripts/ci/impact.mjs verify');
  assert.equal(gate.env.CI_NEEDS, '${{ toJSON(needs) }}');
});

test('Lastik runtime selects its independent validation, stores and image', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const plan = await rangePlan(cwd, base, commit(['apps/eraser/src/worker.ts']));
    assert.deepEqual(selected(plan), ['static', 'eraser', 'docker']);
    assert.deepEqual(plan.dockerComponents, ['eraser']);
    assert.doesNotThrow(() => verifyCiResults(plan, results(plan)));
  });
});
