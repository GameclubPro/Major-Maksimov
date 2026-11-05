import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createCiPlan } from './impact.mjs';
import { GREEN_WORKFLOWS, REPOSITORY, REPOSITORY_ID } from './green-workflow-proof.mjs';
import {
  baselinePolicy,
  ciContext,
  createMainGreenCertificate,
  evidenceDigest,
  readCertificateZip,
  readSingleJsonZip,
  validateFrozenBaseline,
} from './main-baseline.mjs';
import {
  certificateArtifact,
  githubEvidence,
  jsonZip,
  workflowRun,
} from './test/github-evidence-fixture.mjs';

const POLICY_PATHS = [
  '.github/workflows/ci.yml',
  '.github/workflows/codeql.yml',
  'scripts/ci/impact.mjs',
  'scripts/ci/main-baseline.mjs',
  'scripts/ci/green-workflow-proof.mjs',
  'scripts/agent/impact-config.mjs',
  'scripts/agent/impact-plan.mjs',
  'config/change-impact.json',
];
const context = (sha, runId = 700, runAttempt = 1, event = 'push') => ({
  repository: REPOSITORY,
  repositoryId: REPOSITORY_ID,
  sha,
  event,
  ref: 'refs/heads/main',
  runId,
  runAttempt,
});

async function repository(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'maxim-main-baseline-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let revision = 0;
  const commit = (paths) => {
    for (const path of paths) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), `fixture ${++revision}\n`);
    }
    git('add', '-A');
    git('commit', '--no-verify', '-m', `fixture ${revision}`);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(cwd, 'empty-hooks'));
    git('config', 'core.hooksPath', join(cwd, 'empty-hooks'));
    const base = commit([...POLICY_PATHS, 'README.md']);
    await run({ cwd, git, commit, base });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function greenBase(cwd, base, { policy = baselinePolicy({ cwd, sha: base }), id = 100 } = {}) {
  const runs = GREEN_WORKFLOWS.map((workflow, index) =>
    workflowRun(base, { workflow, id: id + index }),
  );
  const certificate = createMainGreenCertificate({
    mode: 'full',
    staticInfra: true,
    baselineProof: { context: context(base, id), policy },
  });
  return {
    runs,
    certificate,
    artifact: certificateArtifact(runs[0], certificate, 50000 + id),
    policy,
  };
}

const mainPlan = (cwd, sha, before, github, extra = {}) =>
  createCiPlan({
    cwd,
    sha,
    eventName: 'push',
    event: { before, after: sha },
    context: context(sha),
    github,
    ...extra,
  });

test('a red runtime commit followed by docs still selects runtime against the proven green ancestor', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const runtime = commit(['apps/api/src/changed.ts']);
    const sha = commit(['docs/followup.md']);
    const good = greenBase(cwd, base);
    const red = workflowRun(runtime, { id: 200, conclusion: 'failure' });
    const github = githubEvidence({ runs: [...good.runs, red], artifacts: [good.artifact] });
    const plan = await mainPlan(cwd, sha, runtime, github);
    assert.equal(plan.base, base);
    assert.equal(plan.mode, 'scoped');
    assert.equal(plan.lanes.api, true);
    assert.equal(plan.lanes['postgres-races'], true);
    assert.equal(plan.lanes.registry, true);
    assert.deepEqual(plan.dockerComponents, ['api']);
    assert.equal(plan.baselineProof.evidence.length, 2);
    assert.equal(plan.baselineProof.certificate.artifactId, good.artifact.artifact.id);
  });
});

test('Required validates its frozen baseline when a closer run becomes green out of order', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const runtime = commit(['apps/api/src/changed.ts']);
    const sha = commit(['docs/followup.md']);
    const good = greenBase(cwd, base);
    const github = githubEvidence({ runs: good.runs, artifacts: [good.artifact] });
    const plan = await mainPlan(cwd, sha, runtime, github);
    const later = greenBase(cwd, runtime, { id: 200 });
    const fresh = githubEvidence({
      runs: [...good.runs, ...later.runs],
      artifacts: [good.artifact, later.artifact],
    });
    const verified = await mainPlan(cwd, sha, runtime, fresh, { frozenProof: plan.baselineProof });
    assert.deepEqual(verified, plan);
    const discoveredAgain = await mainPlan(cwd, sha, runtime, fresh);
    assert.equal(discoveredAgain.base, runtime);
    assert.equal(discoveredAgain.lanes.api, false);
  });
});

test('a compatible green baseline preserves scoped host infrastructure coverage through docs follow-ups', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const host = commit(['infra/scripts/vps-runtime-rollback.sh']);
    const sha = commit(['docs/followup.md']);
    const good = greenBase(cwd, base);
    const github = githubEvidence({ runs: good.runs, artifacts: [good.artifact] });
    const plan = await mainPlan(cwd, sha, host, github);
    assert.equal(plan.base, base);
    assert.equal(plan.mode, 'scoped');
    assert.equal(plan.staticInfra, true);
    assert.deepEqual(
      Object.entries(plan.lanes)
        .filter(([, enabled]) => enabled)
        .map(([lane]) => lane),
      ['static'],
    );
    assert.deepEqual(plan.dockerComponents, []);
    const verified = await mainPlan(cwd, sha, host, github, { frozenProof: plan.baselineProof });
    assert.deepEqual(verified, plan);
  });
});

test('policy bootstrap, missing certificates and unavailable GitHub evidence retain full validation', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const sha = commit(['docs/followup.md']);
    const good = greenBase(cwd, base);
    for (const github of [
      githubEvidence(),
      githubEvidence({ runs: good.runs }),
      {
        json: () => {
          throw new Error('rate limit');
        },
      },
    ]) {
      const plan = await mainPlan(cwd, sha, base, github);
      assert.equal(plan.mode, 'full');
      assert.equal(plan.staticInfra, true);
      assert.deepEqual(plan.dockerComponents, ['eraser', 'api', 'miniapp', 'admin']);
      assert.equal(plan.baselineProof.base, null);
    }
    const changed = commit(['scripts/ci/impact.mjs']);
    const plan = await mainPlan(
      cwd,
      changed,
      sha,
      githubEvidence({ runs: good.runs, artifacts: [good.artifact] }),
    );
    assert.equal(plan.mode, 'full');
    assert.equal(plan.staticInfra, true);
    assert.equal(plan.baselineProof.base, null);
  });
});

test('first-parent ancestry excludes a successful side-branch commit', async () => {
  await repository(async ({ cwd, base, commit, git }) => {
    git('switch', '-c', 'side');
    const side = commit(['docs/side.md']);
    const sideGreen = greenBase(cwd, side, { id: 200 });
    git('switch', 'main');
    const runtime = commit(['apps/api/src/changed.ts']);
    git('merge', '--no-ff', 'side', '-m', 'main merge');
    const sha = git('rev-parse', 'HEAD');
    const good = greenBase(cwd, base);
    const plan = await mainPlan(
      cwd,
      sha,
      runtime,
      githubEvidence({
        runs: [...good.runs, ...sideGreen.runs],
        artifacts: [good.artifact, sideGreen.artifact],
      }),
    );
    assert.equal(plan.base, base);
    assert.equal(plan.lanes.api, true);
  });
});

test('frozen context, policy, evidence, artifact and attempt substitutions are rejected', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const sha = commit(['docs/followup.md']);
    const good = greenBase(cwd, base);
    const github = githubEvidence({ runs: good.runs, artifacts: [good.artifact] });
    const plan = await mainPlan(cwd, sha, base, github);
    for (const mutate of [
      (proof) => {
        proof.context.runAttempt += 1;
      },
      (proof) => {
        proof.context.runId += 1;
      },
      (proof) => {
        proof.policy.fingerprint = 'b'.repeat(64);
      },
      (proof) => {
        proof.evidence[0].runId += 1;
      },
      (proof) => {
        proof.evidence[0].checkId += 1;
      },
      (proof) => {
        proof.certificate.artifactId += 1;
      },
      (proof) => {
        proof.base = sha;
      },
    ]) {
      const proof = structuredClone(plan.baselineProof);
      mutate(proof);
      const body = { ...proof };
      delete body.digest;
      proof.digest = evidenceDigest(body);
      assert.throws(() =>
        validateFrozenBaseline({ proof, cwd, context: context(sha), policy: good.policy, github }),
      );
    }
    await assert.rejects(
      mainPlan(cwd, sha, base, github, {
        context: context(sha, 700, 2),
        frozenProof: plan.baselineProof,
      }),
      /rerun all jobs/u,
    );
  });
});

test('artifact expiry, duplicates, source drift and corrupt content cannot authorize a baseline', async () => {
  await repository(async ({ cwd, base, commit }) => {
    const sha = commit(['docs/followup.md']);
    for (const mutate of [
      (items) => {
        items[0].artifact.expired = true;
      },
      (items) => {
        items.push({ ...items[0], artifact: { ...items[0].artifact, id: 50001 } });
      },
      (items) => {
        items[0].artifact.workflow_run.head_sha = 'b'.repeat(40);
      },
      (items) => {
        items[0].artifact.digest = `sha256:${'b'.repeat(64)}`;
      },
      (items) => {
        items[0].archive = jsonZip('../main-green.json', {});
        delete items[0].artifact.digest;
      },
    ]) {
      const good = greenBase(cwd, base);
      const artifacts = [good.artifact];
      mutate(artifacts);
      const plan = await mainPlan(cwd, sha, base, githubEvidence({ runs: good.runs, artifacts }));
      assert.equal(plan.mode, 'full');
    }
  });
});

test('manual preparation publishes only from main and cannot produce a baseline certificate', async () => {
  await repository(async ({ cwd, base }) => {
    for (const [eventName, ref, registry] of [
      ['workflow_dispatch', 'refs/heads/main', true],
      ['workflow_dispatch', 'refs/heads/feature', false],
      ['schedule', 'refs/heads/main', false],
    ]) {
      const plan = await createCiPlan({
        cwd,
        sha: base,
        eventName,
        event: {},
        context: { ...context(base, 700, 1, eventName), ref },
      });
      assert.equal(plan.mode, 'full');
      assert.equal(plan.lanes.registry, registry);
      assert.equal(createMainGreenCertificate(plan), null);
    }
  });
});

test('certificate creation binds exact source, run attempt, policy and complete plan digest', () => {
  const policy = { id: 'policy', fingerprint: 'a'.repeat(64) };
  const plan = {
    mode: 'full',
    staticInfra: true,
    baselineProof: { context: context('a'.repeat(40)), policy },
  };
  const certificate = createMainGreenCertificate(plan);
  assert.equal(certificate.planDigest, evidenceDigest(plan));
  assert.notEqual(certificate.planDigest, evidenceDigest({ ...plan, staticInfra: false }));
  assert.equal(certificate.context.runAttempt, 1);
  assert.deepEqual(certificate.policy, policy);
  assert.equal(
    createMainGreenCertificate({
      ...plan,
      baselineProof: {
        ...plan.baselineProof,
        context: context('a'.repeat(40), 700, 1, 'pull_request'),
      },
    }),
    null,
  );
});

test('bounded JSON artifact reader handles store/deflate and rejects paths, extra files and oversized input', () => {
  const value = { schemaVersion: 1, example: 'Привет' };
  for (const method of [0, 8])
    assert.deepEqual(readCertificateZip(jsonZip('main-green.json', value, { method })), value);
  assert.deepEqual(
    readSingleJsonZip(jsonZip('registry-record-api.json', value), 'registry-record-api.json'),
    value,
  );
  for (const archive of [
    Buffer.alloc(1),
    Buffer.alloc(1024 * 1024 + 1),
    jsonZip('../main-green.json', value),
    jsonZip('other.json', value),
    jsonZip('main-green.json', { huge: 'x'.repeat(70000) }),
  ])
    assert.throws(() => readCertificateZip(archive));
  const multiple = jsonZip('main-green.json', value);
  multiple.writeUInt16LE(2, multiple.length - 22 + 10);
  assert.throws(() => readCertificateZip(multiple));
  assert.throws(() => readSingleJsonZip(jsonZip('main-green.json', value), '../main-green.json'));
});

test('CI context rejects another repository or missing current workflow identity', () => {
  const env = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '100',
    GITHUB_RUN_ATTEMPT: '1',
  };
  assert.equal(ciContext(env, {}).runId, 100);
  for (const overrides of [
    { GITHUB_REPOSITORY: 'attacker/repo' },
    { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_RUN_ATTEMPT: '' },
    { GITHUB_REF: '' },
  ])
    assert.throws(() => ciContext({ ...env, ...overrides }, {}));
});
