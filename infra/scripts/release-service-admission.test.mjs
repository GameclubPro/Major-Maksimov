import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReleaseManifest } from './release-manifest.mjs';
import { requestHash } from './release-operation-store.mjs';
import {
  assertServicePolicy,
  evaluateAdmission,
  evaluateRecovery,
  evaluateResult,
  readServiceCredential,
  verifyRequestEvidence,
} from './release-service-admission.mjs';
import { privateBytes, writePrivateJson, sha256 } from './release-service-boundary.mjs';
import { GREEN_WORKFLOWS } from '../../scripts/ci/green-workflow-proof.mjs';
import {
  githubEvidence,
  workflowRun,
  jsonZip,
} from '../../scripts/ci/test/github-evidence-fixture.mjs';
import { registryArtifactName } from './registry-preload-host.mjs';

const sha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const now = Date.parse('2026-11-04T05:00:00Z');

function fixture() {
  const ci = workflowRun(sha, { id: 100 });
  const codeql = workflowRun(sha, { id: 101, workflow: GREEN_WORKFLOWS[1] });
  const record = {
    schemaVersion: 1,
    component: 'admin',
    source: {
      repository: 'GameclubPro/Major-Maksimov',
      repositoryId: '1168895008',
      sha,
      workflow: '.github/workflows/ci.yml',
      workflowRef: 'GameclubPro/Major-Maksimov/.github/workflows/ci.yml@refs/heads/main',
      runId: '100',
      runAttempt: '1',
      runnerEnvironment: 'github-hosted',
      event: 'push',
    },
    image: {
      alias: `maxim-admin:${sha}`,
      imageId: `sha256:${'c'.repeat(64)}`,
      sizeBytes: 1234,
      platform: 'linux/amd64',
    },
    registry: {
      repository: 'ghcr.io/gameclubpro/major-maksimov-private-v1-admin',
      digest: `sha256:${'d'.repeat(64)}`,
    },
  };
  const archive = jsonZip('registry-record-admin.json', record);
  const artifact = {
    id: 501,
    name: registryArtifactName(record),
    digest: `sha256:${sha256(archive)}`,
    expired: false,
    size_in_bytes: archive.length,
    workflow_run: {
      id: 100,
      head_sha: sha,
      head_branch: 'main',
      repository_id: 1168895008,
      head_repository_id: 1168895008,
    },
  };
  const proof = {
    record,
    artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest },
    verifiedAt: new Date(now).toISOString(),
  };
  const request = {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: sha,
    expectedManifestSha256: 'e'.repeat(64),
    trigger: 'operator',
    images: [proof],
  };
  const previousManifest = buildReleaseManifest({
    releaseId: 'before',
    targetSha: oldSha,
    createdAt: new Date(now - 86400_000).toISOString(),
    components: ['api-shared', 'miniapp-major-static', 'admin-static'].map((id) => ({
      id,
      sourceSha: oldSha,
      imageRef: `old-${id}:${oldSha}`,
      imageId: `sha256:${'f'.repeat(64)}`,
    })),
  });
  const context = {
    schemaVersion: 1,
    id: request.id,
    requestHash: requestHash(request),
    sourceSha: sha,
    preparedAt: new Date(now).toISOString(),
    manifestSha256: request.expectedManifestSha256,
    previousManifest,
    envSha256: '1'.repeat(64),
    components: ['admin-static'],
    images: [{ schemaVersion: 1, ...proof }],
  };
  const github = githubEvidence({ runs: [ci, codeql], artifacts: [{ artifact, archive }] });
  const originalJson = github.json;
  github.json = (endpoint) =>
    endpoint.endsWith('/git/ref/heads/main') ? { object: { sha } } : originalJson(endpoint);
  return { request, context, github, ci, codeql, artifact, archive };
}

function input(value) {
  return {
    request: value.request,
    hash: requestHash(value.request),
    context: value.context,
    plan: { components: ['admin-static'] },
    manifest: {
      sha256: value.request.expectedManifestSha256,
      manifest: value.context.previousManifest,
    },
    envHash: value.context.envSha256,
    now,
  };
}

test('service evidence reads private opaque credentials without imposing a provider token format', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-admission-credential-'));
  const path = join(root, 'credential.json');
  try {
    for (const token of [
      'synthetic+credential/with=punctuation!?',
      `synthetic_${'x'.repeat(320)}+`,
      'x',
    ]) {
      const credential = { username: 'GameclubPro', token };
      fs.writeFileSync(path, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
      const before = fs.readFileSync(path);
      assert.deepEqual(readServiceCredential(path, { floor: root }), credential);
      assert.deepEqual(fs.readFileSync(path), before);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('service credential refusal preserves protected file boundaries and redacts untrusted contents', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-admission-credential-'));
  const path = join(root, 'credential.json');
  const valid = { username: 'GameclubPro', token: 'synthetic+credential/with=punctuation!?' };
  const unavailable = (file = path) =>
    assert.throws(() => readServiceCredential(file, { floor: root }), {
      code: 'CREDENTIAL_UNAVAILABLE',
      message: 'Release service CREDENTIAL_UNAVAILABLE.',
    });
  try {
    unavailable();
    for (const content of [
      '',
      '{"token":"sensitive malformed fixture',
      'null',
      '[]',
      JSON.stringify({ ...valid, extra: 'untrusted field' }),
      JSON.stringify({ ...valid, username: ' GameclubPro' }),
      JSON.stringify({ ...valid, token: '' }),
      JSON.stringify({ ...valid, token: 'sensitive fixture with whitespace' }),
      JSON.stringify({ ...valid, token: 'sensitive\nfixture' }),
      JSON.stringify({ ...valid, token: 'sensitive\u0000fixture' }),
      JSON.stringify({ ...valid, token: 'sensitiveéfixture' }),
      JSON.stringify({ ...valid, token: 'x'.repeat(4097) }),
      Buffer.from([0xff, 0xfe]),
    ]) {
      fs.writeFileSync(path, content, { mode: 0o600 });
      unavailable();
    }
    fs.writeFileSync(path, JSON.stringify(valid));
    fs.chmodSync(path, 0o640);
    unavailable();
    fs.chmodSync(path, 0o600);
    const linked = join(root, 'linked.json');
    fs.linkSync(path, linked);
    unavailable();
    fs.unlinkSync(linked);
    fs.symlinkSync(path, linked);
    unavailable(linked);
    fs.unlinkSync(linked);
    const child = join(root, 'private');
    fs.mkdirSync(child, { mode: 0o700 });
    const childCredential = join(child, 'credential.json');
    fs.writeFileSync(childCredential, JSON.stringify(valid), { mode: 0o600 });
    fs.chmodSync(child, 0o770);
    unavailable(childCredential);
    fs.chmodSync(child, 0o700);
    const alias = join(root, 'alias');
    fs.symlinkSync(child, alias);
    unavailable(join(alias, 'credential.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh server evidence binds actual checks, current main, exact artifact and verified image', () => {
  const value = fixture();
  const calls = [];
  const images = verifyRequestEvidence(value.request, {
    github: value.github,
    now,
    verifyImage: (...args) => calls.push(args),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], value.request.images[0].record);
  assert.equal(images[0].schemaVersion, 1);
  assert.equal(images[0].verifiedAt, new Date(now).toISOString());
});

test('untrusted submitted records, moved main and failed signature never pass server admission', () => {
  const value = fixture();
  const changed = structuredClone(value.request);
  changed.images[0].record.image.imageId = `sha256:${'2'.repeat(64)}`;
  assert.throws(
    () =>
      verifyRequestEvidence(changed, {
        github: value.github,
        verifyImage: () => assert.fail('must not verify forged record'),
      }),
    { code: 'IMAGE_EVIDENCE_CHANGED' },
  );
  const moved = {
    ...value.github,
    json: (endpoint) =>
      endpoint.endsWith('/git/ref/heads/main')
        ? { object: { sha: oldSha } }
        : value.github.json(endpoint),
  };
  assert.throws(() =>
    verifyRequestEvidence(value.request, {
      github: moved,
      verifyImage: () => assert.fail('moved main'),
    }),
  );
  assert.throws(
    () =>
      verifyRequestEvidence(value.request, {
        github: value.github,
        verifyImage: () => {
          throw new Error('bad signature');
        },
      }),
    /bad signature/u,
  );
});

test('admission checks frozen request, environment, manifest, image coverage and freshness together', () => {
  const value = fixture();
  assert.equal(evaluateAdmission(input(value)), value.context);
  for (const patch of [
    { hash: '0'.repeat(64) },
    { envHash: '0'.repeat(64) },
    { now: now + 16 * 60_000 },
    { now: now - 121_000 },
    { plan: { components: ['api-shared', 'admin-static'] } },
    { manifest: { sha256: '0'.repeat(64), manifest: value.context.previousManifest } },
    { context: { ...value.context, images: [] } },
    { context: { ...value.context, images: [...value.context.images, value.context.images[0]] } },
    { context: { ...value.context, sourceSha: oldSha } },
  ])
    assert.throws(() => evaluateAdmission({ ...input(value), ...patch }));
});

test('operator trigger obeys durable pause and cannot enable automatic releases', () => {
  const { request } = fixture();
  assert.throws(() => assertServicePolicy({ paused: true, autoEnabled: true }, request), {
    code: 'SERVICE_PAUSED',
  });
  assertServicePolicy({ paused: false, autoEnabled: false }, request);
  assert.throws(
    () =>
      assertServicePolicy(
        { paused: false, autoEnabled: false },
        { ...request, trigger: 'automatic' },
      ),
    { code: 'AUTOMATIC_DISABLED' },
  );
  assert.throws(() => assertServicePolicy({}, request));
});

function finalManifest(value) {
  const proof = value.context.images[0];
  return buildReleaseManifest({
    current: value.context.previousManifest,
    releaseId: 'after',
    targetSha: sha,
    createdAt: new Date(now + 60_000).toISOString(),
    smokes: ['admin-static'],
    components: [
      {
        id: 'admin-static',
        sourceSha: sha,
        imageRef: proof.record.image.alias,
        imageId: proof.record.image.imageId,
        registryProvenance: proof,
      },
    ],
  });
}

test('result requires a new exact manifest, provenance, strict smoke and unchanged inherited roles', () => {
  const value = fixture();
  assert.deepEqual(evaluateResult({ ...value, manifest: finalManifest(value) }), {
    unchanged: false,
  });
  for (const mutate of [
    (m) => {
      m.smokes = [];
    },
    (m) => {
      m.targetSha = oldSha;
    },
    (m) => {
      m.releaseId = 'before';
    },
    (m) => {
      m.createdAt = new Date(now - 1).toISOString();
    },
    (m) => {
      m.components['api-shared'].imageId = `sha256:${'0'.repeat(64)}`;
    },
    (m) => {
      m.components['admin-static'].registryProvenance.record.registry.digest =
        `sha256:${'0'.repeat(64)}`;
    },
    (m) => {
      delete m.components['admin-static'];
    },
    (m) => {
      m.emergencyReason = 'bypass';
    },
  ]) {
    const manifest = structuredClone(finalManifest(value));
    mutate(manifest);
    assert.throws(() => evaluateResult({ ...value, manifest }));
  }
});

test('a static result preserves a previously installed eraser component and rejects its disappearance', () => {
  const value = fixture();
  value.context.previousManifest = buildReleaseManifest({
    current: value.context.previousManifest,
    releaseId: 'before-with-eraser',
    targetSha: oldSha,
    createdAt: value.context.previousManifest.createdAt,
    components: [
      {
        id: 'eraser',
        sourceSha: oldSha,
        imageRef: `maxim-eraser:${oldSha}`,
        imageId: `sha256:${'9'.repeat(64)}`,
      },
    ],
  });
  const manifest = structuredClone(finalManifest(value));
  assert.deepEqual(manifest.components.eraser, value.context.previousManifest.components.eraser);
  assert.deepEqual(evaluateResult({ ...value, manifest }), { unchanged: false });
  delete manifest.components.eraser;
  assert.throws(() => evaluateResult({ ...value, manifest }), { code: 'FINAL_COMPONENT_MISSING' });
});

test('no-op outcome proves the complete manifest stayed exactly unchanged', () => {
  const value = fixture();
  value.context.components = [];
  value.context.images = [];
  assert.deepEqual(evaluateResult({ ...value, manifest: value.context.previousManifest }), {
    unchanged: true,
  });
  assert.throws(() => evaluateResult({ ...value, manifest: finalManifest(fixture()) }));
});

test('private context persistence refuses replacement, unsafe ancestry and linked files', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-admission-'));
  try {
    fs.chmodSync(root, 0o700);
    const path = join(root, 'context.json');
    writePrivateJson(path, { id: 'frozen' }, { floor: root, exclusive: true });
    assert.deepEqual(JSON.parse(privateBytes(path, { floor: root })), { id: 'frozen' });
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    assert.throws(() => writePrivateJson(path, {}, { floor: root, exclusive: true }), {
      code: 'EXISTING_CONTEXT',
    });
    const link = join(root, 'link');
    fs.symlinkSync(path, link);
    assert.throws(() => privateBytes(link, { floor: root }));
    const hard = join(root, 'hard');
    fs.linkSync(path, hard);
    assert.throws(() => privateBytes(hard, { floor: root }));
    fs.unlinkSync(hard);
    fs.chmodSync(root, 0o777);
    assert.throws(() => privateBytes(path, { floor: root }), { code: 'UNSAFE_DIRECTORY' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function recoveryManifest(manifest) {
  return { sha256: sha256(`${JSON.stringify(manifest)}\n`), manifest };
}

function recoveryFixture({ unchanged = false } = {}) {
  const record = {
    schemaVersion: 1,
    component: 'admin',
    source: {
      repository: 'GameclubPro/Major-Maksimov',
      repositoryId: '1168895008',
      sha,
      workflow: '.github/workflows/ci.yml',
      workflowRef: 'GameclubPro/Major-Maksimov/.github/workflows/ci.yml@refs/heads/main',
      runId: '100',
      runAttempt: '1',
      runnerEnvironment: 'github-hosted',
      event: 'push',
    },
    image: {
      alias: `maxim-admin:${sha}`,
      imageId: `sha256:${'c'.repeat(64)}`,
      sizeBytes: 1234,
      platform: 'linux/amd64',
    },
    registry: {
      repository: 'ghcr.io/gameclubpro/major-maksimov-private-v1-admin',
      digest: `sha256:${'d'.repeat(64)}`,
    },
  };
  const proof = {
    record,
    artifact: { id: 501, name: registryArtifactName(record), digest: `sha256:${'2'.repeat(64)}` },
    verifiedAt: new Date(now).toISOString(),
  };
  const previousManifest = buildReleaseManifest({
    releaseId: 'before',
    targetSha: oldSha,
    createdAt: new Date(now - 86400_000).toISOString(),
    components: ['api-shared', 'miniapp-major-static', 'admin-static'].map((id) => ({
      id,
      sourceSha: oldSha,
      imageRef: `old-${id}:${oldSha}`,
      imageId: `sha256:${'f'.repeat(64)}`,
    })),
  });
  const request = {
    schemaVersion: 1,
    id: randomUUID(),
    sourceSha: sha,
    expectedManifestSha256: recoveryManifest(previousManifest).sha256,
    trigger: 'operator',
    images: unchanged ? [] : [proof],
  };
  const hash = requestHash(request);
  const context = {
    schemaVersion: 1,
    id: request.id,
    requestHash: hash,
    sourceSha: sha,
    preparedAt: new Date(now).toISOString(),
    manifestSha256: request.expectedManifestSha256,
    previousManifest,
    envSha256: '1'.repeat(64),
    components: unchanged ? [] : ['admin-static'],
    images: unchanged ? [] : [{ schemaVersion: 1, ...proof }],
  };
  const summary = {
    state: 'NEEDS_REVIEW',
    resolution: null,
    requestHash: hash,
    sourceSha: sha,
    executor: {
      pid: 42,
      sourceSha: sha,
      startedAt: new Date(now).toISOString(),
      bootId: '12345678-1234-1234-1234-123456789abc',
      startTicks: '12345',
    },
  };
  const manifest = recoveryManifest(
    unchanged ? previousManifest : finalManifest({ request, context }),
  );
  return { request, hash, context, summary, manifest, expectedManifestSha256: manifest.sha256 };
}

test('recovery proves the frozen final release without readmitting or replaying its runtime', () => {
  const value = recoveryFixture();
  assert.equal(evaluateRecovery(value), 'RECOVERED');
  assert.equal(value.summary.state, 'NEEDS_REVIEW');
  assert.equal(value.summary.resolution, null);
  assert.deepEqual(value.manifest.manifest, finalManifest(value));
});

test('recovery proves an unchanged operation only with the exact original manifest bytes hash', () => {
  const value = recoveryFixture({ unchanged: true });
  assert.equal(evaluateRecovery(value), 'UNCHANGED');
  const changedHash = '0'.repeat(64);
  assert.throws(
    () =>
      evaluateRecovery({
        ...value,
        manifest: { ...value.manifest, sha256: changedHash },
        expectedManifestSha256: changedHash,
      }),
    { code: 'RECOVERY_UNPROVED' },
  );
});

test('recovery refuses a resolved or active operation and mismatched request, executor or manifest identity', () => {
  const value = recoveryFixture();
  for (const patch of [
    { summary: { ...value.summary, state: 'EXECUTING' } },
    { summary: { ...value.summary, resolution: { kind: 'RECOVERED' } } },
    { summary: { ...value.summary, requestHash: '0'.repeat(64) } },
    { summary: { ...value.summary, sourceSha: oldSha } },
    { summary: { ...value.summary, executor: null } },
    { summary: { ...value.summary, executor: { ...value.summary.executor, sourceSha: oldSha } } },
    { hash: '0'.repeat(64) },
    { expectedManifestSha256: '0'.repeat(64) },
    { expectedManifestSha256: 'unknown' },
    { manifest: { ...value.manifest, sha256: '0'.repeat(64) } },
  ])
    assert.throws(() => evaluateRecovery({ ...value, ...patch }), { code: 'RECOVERY_UNPROVED' });
});

test('recovery needs the original context and exact admission bindings', () => {
  const value = recoveryFixture();
  for (const context of [
    undefined,
    null,
    {},
    { ...value.context, id: randomUUID() },
    { ...value.context, requestHash: '0'.repeat(64) },
    { ...value.context, sourceSha: oldSha },
    { ...value.context, manifestSha256: '0'.repeat(64) },
    { ...value.context, preparedAt: 'unknown' },
    { ...value.context, images: [] },
    { ...value.context, previousManifest: null },
  ])
    assert.throws(() => evaluateRecovery({ ...value, context }));
});

test('recovery rejects a nonfinal manifest, missing strict smokes or drift in changed and inherited images', () => {
  const value = recoveryFixture();
  for (const mutate of [
    (manifest) => {
      Object.assign(manifest, structuredClone(value.context.previousManifest));
    },
    (manifest) => {
      manifest.smokes = [];
    },
    (manifest) => {
      manifest.releaseId = value.context.previousManifest.releaseId;
    },
    (manifest) => {
      manifest.targetSha = oldSha;
    },
    (manifest) => {
      manifest.components['admin-static'].imageId = `sha256:${'0'.repeat(64)}`;
    },
    (manifest) => {
      manifest.components['admin-static'].registryProvenance.record.registry.digest =
        `sha256:${'0'.repeat(64)}`;
    },
    (manifest) => {
      manifest.components['api-shared'].sourceSha = sha;
    },
    (manifest) => {
      delete manifest.components['miniapp-major-static'];
    },
  ]) {
    const changed = structuredClone(value.manifest.manifest);
    mutate(changed);
    const manifest = recoveryManifest(changed);
    assert.throws(() =>
      evaluateRecovery({ ...value, manifest, expectedManifestSha256: manifest.sha256 }),
    );
  }
});
