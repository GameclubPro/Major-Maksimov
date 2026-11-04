import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GREEN_WORKFLOWS } from '../../scripts/ci/green-workflow-proof.mjs';
import {
  githubEvidence,
  jsonZip,
  workflowRun,
} from '../../scripts/ci/test/github-evidence-fixture.mjs';
import {
  findRegistryArtifact,
  MissingRegistryImageError,
  parseImagePreparationPlan,
  prepareMissingImages,
  verifyPreloadProof,
} from './registry-preload.mjs';
import { registryArtifactName } from './registry-preload-host.mjs';

const sha = 'a'.repeat(40);

function fixture({ dispatch = false, runAttempt = 1, codeqlConclusion = 'success' } = {}) {
  const push = workflowRun(sha, { id: 100 });
  const codeql = workflowRun(sha, {
    id: 101,
    workflow: GREEN_WORKFLOWS[1],
    conclusion: codeqlConclusion,
  });
  const publication = dispatch
    ? workflowRun(sha, { id: 102, attempt: runAttempt, event: 'workflow_dispatch' })
    : push;
  const record = {
    schemaVersion: 1,
    component: 'api',
    source: {
      repository: 'GameclubPro/Major-Maksimov',
      repositoryId: '1168895008',
      sha,
      workflow: '.github/workflows/ci.yml',
      workflowRef: 'GameclubPro/Major-Maksimov/.github/workflows/ci.yml@refs/heads/main',
      runId: String(publication.run.id),
      runAttempt: String(publication.run.run_attempt),
      runnerEnvironment: 'github-hosted',
      event: publication.run.event,
    },
    image: {
      alias: `maxim-api:${sha}`,
      imageId: `sha256:${'b'.repeat(64)}`,
      platform: 'linux/amd64',
      sizeBytes: 1234,
    },
    registry: {
      repository: 'ghcr.io/gameclubpro/major-maksimov-api',
      digest: `sha256:${'c'.repeat(64)}`,
    },
  };
  const archive = jsonZip('registry-record-api.json', record);
  const artifact = {
    id: 501,
    name: registryArtifactName(record),
    expired: false,
    digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
    size_in_bytes: archive.length,
    workflow_run: {
      id: publication.run.id,
      head_sha: sha,
      head_branch: 'main',
      repository_id: 1168895008,
      head_repository_id: 1168895008,
    },
  };
  const artifactValue = { artifact, archive };
  const runs = [...new Set([push, codeql, publication])];
  return {
    push,
    codeql,
    publication,
    record,
    artifact,
    artifactValue,
    runs,
    github: githubEvidence({ runs, artifacts: [artifactValue] }),
  };
}

test('selects the checksummed single record from an exact successful main invocation', () => {
  const value = fixture();
  const result = findRegistryArtifact({ github: value.github, sha, component: 'api' });
  assert.deepEqual(result.record, value.record);
  assert.equal(result.artifact.id, 501);
  assert.ok(value.github.calls.some((path) => path.includes('/attempts/1/jobs')));
  assert.ok(value.github.calls.some((path) => path.includes('/check-suites/')));
});

test('a manual image preparation needs its own green Required plus separate push-main and CodeQL gates', () => {
  const value = fixture({ dispatch: true, runAttempt: 2 });
  const result = findRegistryArtifact({ github: value.github, sha, component: 'api' });
  assert.equal(result.record.source.runId, '102');
  assert.equal(result.record.source.event, 'workflow_dispatch');
  assert.ok(value.github.calls.some((path) => path.includes('/runs/102/attempts/2/jobs')));
  for (const failure of ['codeql', 'push', 'publication']) {
    const broken = fixture({ dispatch: true });
    const target = { codeql: broken.codeql, push: broken.push, publication: broken.publication }[
      failure
    ];
    target.run.conclusion = 'failure';
    target.jobs[0].conclusion = 'failure';
    target.checks[0].conclusion = 'failure';
    assert.throws(
      () => findRegistryArtifact({ github: broken.github, sha, component: 'api' }),
      /not successful/u,
    );
  }
});

test('failed reruns cannot reuse a previous-attempt image record', () => {
  const value = fixture({ dispatch: true });
  value.publication.run.run_attempt = 2;
  value.publication.run.conclusion = 'failure';
  assert.throws(
    () => findRegistryArtifact({ github: value.github, sha, component: 'api' }),
    MissingRegistryImageError,
  );
});

test('record digest mismatch, wrong file, wrong trigger and ambiguous artifacts fail closed', () => {
  for (const change of [
    (value) => {
      value.artifact.digest = `sha256:${'f'.repeat(64)}`;
    },
    (value) => {
      value.artifactValue.archive = jsonZip('../record.json', value.record);
      value.artifact.digest = `sha256:${createHash('sha256').update(value.artifactValue.archive).digest('hex')}`;
    },
    (value) => {
      value.record.source.event = 'workflow_dispatch';
      value.artifactValue.archive = jsonZip('registry-record-api.json', value.record);
      value.artifact.digest = `sha256:${createHash('sha256').update(value.artifactValue.archive).digest('hex')}`;
    },
    (value) => {
      value.artifact.workflow_run.head_repository_id = 99;
    },
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => findRegistryArtifact({ github: value.github, sha, component: 'api' }));
  }
});

test('missing component images require explicit CI preparation and never select another component', () => {
  const value = fixture();
  assert.throws(
    () => findRegistryArtifact({ github: value.github, sha, component: 'admin' }),
    MissingRegistryImageError,
  );
});

test('proof verification supplies the exact record to the pinned registry gate and removes its temporary file', () => {
  const value = fixture();
  let savedPath;
  const proof = verifyPreloadProof(
    { record: value.record, artifact: value.artifact },
    {
      sha,
      component: 'api',
      execute(binary, args, options) {
        assert.equal(binary, process.execPath);
        assert.deepEqual(args, ['scripts/ci/registry-images.mjs', 'verify-proof']);
        savedPath = options.env.MAXIM_IMAGE_RECORD_PATH;
        assert.deepEqual(JSON.parse(readFileSync(savedPath, 'utf8')), value.record);
        assert.equal(options.env.MAXIM_RELEASE_SHA, sha);
        assert.equal(options.env.MAXIM_IMAGE_COMPONENT, 'api');
      },
    },
  );
  assert.equal(proof.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(proof.verifiedAt)));
  assert.throws(() => readFileSync(savedPath));
});

test('an interrupted dispatch is correlated and resumed without launching another CI run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-prepare-test-'));
  const value = fixture({ dispatch: true });
  let clock = 100000;
  let dispatches = 0;
  let correlation;
  const originalJson = value.github.json;
  const github = {
    ...value.github,
    json(path) {
      if (path.endsWith('/git/ref/heads/main')) return { object: { sha } };
      if (path.includes('/actions/workflows/')) {
        value.publication.run.display_title = `MAXIM image preparation ${correlation}`;
      }
      return originalJson(path);
    },
  };
  try {
    const options = {
      github,
      sha,
      directory,
      now: () => clock,
      pause: async () => {
        clock += 10000;
      },
      progress: () => {},
      dispatch(id) {
        dispatches += 1;
        correlation = id;
        throw new Error('transport ended after accepted request');
      },
    };
    const first = await prepareMissingImages(options);
    const second = await prepareMissingImages(options);
    assert.equal(first.id, second.id);
    assert.equal(first.runId, 102);
    assert.equal(dispatches, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('advancing main refuses image preparation before any dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-prepare-stale-'));
  let dispatches = 0;
  try {
    await assert.rejects(
      prepareMissingImages({
        github: { json: () => ({ object: { sha: 'd'.repeat(40) } }) },
        sha,
        directory,
        dispatch: () => {
          dispatches += 1;
        },
      }),
      /no longer/u,
    );
    assert.equal(dispatches, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('machine plans bind cumulative selected components to the exact pinned SHA', () => {
  const line = (value) => `plan diagnostics\nMAXIM_IMAGE_PLAN=${JSON.stringify(value)}\n`;
  const plan = { schemaVersion: 1, sourceSha: sha, components: ['api-shared', 'admin-static'] };
  assert.deepEqual(parseImagePreparationPlan(line(plan), sha), plan.components);
  for (const output of [
    line({ ...plan, sourceSha: 'b'.repeat(40) }),
    line({ ...plan, components: ['postgres'] }),
    line({ ...plan, components: ['api-shared', 'api-shared'] }),
    line(plan) + line(plan),
    '',
  ])
    assert.throws(() => parseImagePreparationPlan(output, sha));
});

test('corrupt saved dispatch state blocks preparation without sending another request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-prepare-corrupt-'));
  let dispatches = 0;
  try {
    writeFileSync(join(directory, `${sha}.json`), '{"id":', { mode: 0o600 });
    await assert.rejects(
      prepareMissingImages({
        github: { json: () => ({ object: { sha } }) },
        sha,
        directory,
        dispatch: () => {
          dispatches += 1;
        },
      }),
    );
    assert.equal(dispatches, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
