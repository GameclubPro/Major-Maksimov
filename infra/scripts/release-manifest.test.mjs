import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  archiveReleaseTransition,
  beginReleaseTransition,
  buildReleaseManifest,
  commitReleaseManifest,
  findRecoveryBaseManifest,
  getReleaseComponentHistory,
  pruneOldManifests,
  readCurrentManifest,
  readRecoveryBaseManifest,
  readReleaseManifest,
  validateCompleteReleaseManifest,
} from './release-manifest.mjs';

const sha = (digit) => digit.repeat(40);
const imageId = (digit) => `sha256:${digit.repeat(64)}`;

function component(id, digit) {
  return {
    id,
    sourceSha: sha(digit),
    imageRef: `maxim-${id}:${sha(digit)}`,
    imageId: imageId(digit),
  };
}

function registryComponent() {
  const sourceSha = sha('a');
  const record = {
    schemaVersion: 1,
    component: 'api',
    source: {
      repository: 'GameclubPro/Major-Maksimov',
      repositoryId: '1168895008',
      sha: sourceSha,
      workflow: '.github/workflows/ci.yml',
      workflowRef: 'GameclubPro/Major-Maksimov/.github/workflows/ci.yml@refs/heads/main',
      runnerEnvironment: 'github-hosted',
      event: 'push',
      runId: '123',
      runAttempt: '2',
    },
    image: {
      alias: `maxim-api:${sourceSha}`,
      imageId: imageId('b'),
      platform: 'linux/amd64',
      sizeBytes: 1234,
    },
    registry: {
      repository: 'ghcr.io/gameclubpro/major-maksimov-private-v1-api',
      digest: imageId('c'),
    },
  };
  return {
    id: 'api-shared',
    sourceSha,
    imageRef: record.image.alias,
    imageId: record.image.imageId,
    registryProvenance: {
      schemaVersion: 1,
      record,
      artifact: { id: 456, name: `maxim-registry-api-${sourceSha}-123-2`, digest: imageId('d') },
      verifiedAt: '2026-11-04T03:00:00Z',
    },
  };
}

test('registry manifest metadata keeps registry digest distinct from Docker ID through partial releases', () => {
  const api = registryComponent();
  const first = buildReleaseManifest({
    releaseId: 'registry-first',
    targetSha: api.sourceSha,
    components: [api],
  });
  const next = buildReleaseManifest({
    releaseId: 'registry-static',
    targetSha: sha('e'),
    current: first,
    components: [component('admin-static', 'e')],
  });
  const saved = next.components['api-shared'];
  assert.equal(saved.imageId, imageId('b'));
  assert.equal(saved.registryProvenance.record.registry.digest, imageId('c'));
  assert.equal(saved.registryProvenance.record.source.runAttempt, '2');
  api.registryProvenance.record.source.runAttempt = '9';
  assert.equal(
    saved.registryProvenance.record.source.runAttempt,
    '2',
    'caller mutation changed committed provenance',
  );
});

for (const legacyRepository of [
  'ghcr.io/gameclubpro/major-maksimov-api',
  'ghcr.io/gameclubpro/major-maksimov-release-api',
])
  test(`historical manifest provenance ${legacyRepository} remains readable for rollback`, () => {
    const api = registryComponent();
    api.registryProvenance.record.registry.repository = legacyRepository;
    const stateDir = mkdtempSync(join(tmpdir(), 'maxim-registry-legacy-manifest-'));
    const manifest = buildReleaseManifest({
      releaseId: 'legacy-registry',
      targetSha: api.sourceSha,
      components: [api],
    });
    commitReleaseManifest({ stateDir, manifest });
    const saved = readReleaseManifest(stateDir, 'legacy-registry');
    assert.equal(
      saved.components['api-shared'].registryProvenance.record.registry.repository,
      legacyRepository,
    );
    const next = buildReleaseManifest({
      releaseId: 'new-registry-static',
      targetSha: sha('e'),
      current: saved,
      components: [component('admin-static', 'e')],
    });
    assert.equal(
      next.components['api-shared'].registryProvenance.record.registry.repository,
      legacyRepository,
    );
  });

test('registry provenance must agree with the component alias, source and tested image ID', () => {
  for (const mutate of [
    (value) => {
      value.registryProvenance.record.image.imageId = imageId('f');
    },
    (value) => {
      value.registryProvenance.record.source.sha = sha('e');
    },
    (value) => {
      value.registryProvenance.record.source.runAttempt = '3';
    },
    (value) => {
      value.registryProvenance.record.source.runnerEnvironment = 'self-hosted';
    },
    (value) => {
      value.registryProvenance.record.registry.repository = 'ghcr.io/other/api';
    },
  ]) {
    const api = registryComponent();
    mutate(api);
    assert.throws(
      () =>
        buildReleaseManifest({
          releaseId: 'bad-provenance',
          targetSha: api.sourceSha,
          components: [api],
        }),
      /registry provenance/u,
    );
  }
});

test('atomically records a release and merges partial component updates', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-'));
  const first = buildReleaseManifest({
    releaseId: 'release-1',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    smokes: ['api-live', 'miniapp-major'],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: first });

  const second = buildReleaseManifest({
    releaseId: 'release-2',
    targetSha: sha('b'),
    current: readCurrentManifest(stateDir),
    components: [component('admin-static', 'b')],
    smokes: ['admin-static'],
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: second });

  const current = readCurrentManifest(stateDir);
  assert.equal(current.releaseId, 'release-2');
  assert.equal(current.components['api-shared'].sourceSha, sha('a'));
  assert.equal(current.components['admin-static'].sourceSha, sha('b'));
  assert.equal(readReleaseManifest(stateDir, 'release-1').releaseId, 'release-1');
});

test('does not move current when an existing release id has different content', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-conflict-'));
  const first = buildReleaseManifest({
    releaseId: 'same-id',
    targetSha: sha('a'),
    components: [component('api-shared', 'a')],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: first });
  const before = readFileSync(join(stateDir, 'current.json'), 'utf8');
  const conflict = buildReleaseManifest({
    releaseId: 'same-id',
    targetSha: sha('b'),
    components: [component('api-shared', 'b')],
    createdAt: '2026-01-02T00:00:00.000Z',
  });

  assert.throws(
    () => commitReleaseManifest({ stateDir, manifest: conflict }),
    /different content/u,
  );
  assert.equal(readFileSync(join(stateDir, 'current.json'), 'utf8'), before);
});

test('retains at least five release manifests', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-retain-'));
  for (let index = 0; index < 7; index += 1) {
    const digit = String(index + 1);
    const manifest = buildReleaseManifest({
      releaseId: `release-${index}`,
      targetSha: sha(digit),
      components: [
        component('api-shared', digit),
        component('miniapp-major-static', digit),
        component('admin-static', digit),
      ],
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    });
    commitReleaseManifest({ stateDir, manifest, retain: 5 });
  }
  assert.throws(() => readReleaseManifest(stateDir, 'release-0'), /not found/u);
  assert.equal(readReleaseManifest(stateDir, 'release-6').releaseId, 'release-6');
});

test('static-only churn retains the previous distinct API and admin image manifests', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-component-history-'));
  for (const [index, digit] of ['a', 'b', 'c', 'd', 'e', 'f', '1', '2', '3', '4'].entries()) {
    const manifest = buildReleaseManifest({
      releaseId: `release-${index}`,
      targetSha: sha(digit),
      current: readCurrentManifest(stateDir),
      components:
        index < 2
          ? [
              component('api-shared', digit),
              component('miniapp-major-static', digit),
              component('admin-static', digit),
            ]
          : [component('miniapp-major-static', digit)],
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    });
    commitReleaseManifest({ stateDir, manifest });
  }
  assert.equal(
    readReleaseManifest(stateDir, 'release-0').components['api-shared'].imageId,
    imageId('a'),
  );
  assert.equal(
    readReleaseManifest(stateDir, 'release-9').components['api-shared'].imageId,
    imageId('b'),
  );
  assert.throws(() => readReleaseManifest(stateDir, 'release-1'), /not found/u);
  for (let index = 5; index <= 9; index++)
    assert.equal(readReleaseManifest(stateDir, `release-${index}`).releaseId, `release-${index}`);
});

test('counts physical known image IDs rather than aliases, releases or unknown placeholders', () => {
  const first = buildReleaseManifest({
    releaseId: 'first',
    targetSha: sha('a'),
    components: [component('api-shared', 'a')],
  });
  const alias = buildReleaseManifest({
    releaseId: 'alias',
    targetSha: sha('b'),
    components: [{ ...component('api-shared', 'b'), imageId: imageId('a') }],
  });
  const unknown = buildReleaseManifest({
    releaseId: 'unknown',
    targetSha: 'unknown',
    components: [{ ...component('api-shared', 'c'), imageId: 'unknown' }],
  });
  assert.deepEqual(getReleaseComponentHistory([first, alias, unknown]), [
    { component: 'api-shared', distinctKnownImages: 1, state: 'missing' },
    { component: 'miniapp-major-static', distinctKnownImages: 0, state: 'missing' },
    { component: 'admin-static', distinctKnownImages: 0, state: 'missing' },
  ]);
});

test('preserves all existing manifests when any component lacks known image history', (t) => {
  const warning = t.mock.method(process.stderr, 'write', () => true);
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-history-missing-'));
  for (let index = 0; index < 7; index++) {
    const manifest = buildReleaseManifest({
      releaseId: `release-${index}`,
      targetSha: sha('a'),
      components: [component('api-shared', 'a')],
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    });
    commitReleaseManifest({ stateDir, manifest });
  }
  assert.equal(readReleaseManifest(stateDir, 'release-0').releaseId, 'release-0');
  assert.deepEqual(pruneOldManifests(stateDir), []);
  const output = warning.mock.calls.map(({ arguments: args }) => args[0]).join('');
  assert.match(output, /api-shared: distinct_known_images=1 state=missing/u);
  assert.match(output, /preserved 7 manifests/u);
  assert.doesNotMatch(output, /sha256|release-0|schema.compatib/iu);
});

test('protects an older current release and unresolved journal during retention', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-protected-history-'));
  const manifests = [];
  for (const [index, digit] of ['a', 'b', 'c', 'd', 'e', 'f', '1', '2'].entries()) {
    const manifest = buildReleaseManifest({
      releaseId: `release-${index}`,
      targetSha: sha(digit),
      components: [
        component('api-shared', digit),
        component('miniapp-major-static', digit),
        component('admin-static', digit),
      ],
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    });
    manifests.push(manifest);
    commitReleaseManifest({ stateDir, manifest, retain: 20 });
  }
  writeFileSync(join(stateDir, 'current.json'), JSON.stringify(manifests[0]));
  writeFileSync(
    join(stateDir, 'current.invalid-deploy-20260109T000000Z-1.json'),
    JSON.stringify(manifests[1]),
  );
  assert.deepEqual(pruneOldManifests(stateDir), ['release-2.json']);
  assert.equal(readReleaseManifest(stateDir, 'release-0').releaseId, 'release-0');
  assert.equal(readReleaseManifest(stateDir, 'release-1').releaseId, 'release-1');
});

test('validates every historical manifest before deleting any release', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-history-invalid-'));
  const manifest = buildReleaseManifest({
    releaseId: 'release-valid',
    targetSha: sha('a'),
    components: [component('api-shared', 'a')],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest });
  writeFileSync(join(stateDir, 'releases', 'invalid.json'), JSON.stringify({ schemaVersion: 2 }));
  assert.throws(() => pruneOldManifests(stateDir), /schemaVersion must be 1/u);
  assert.equal(readReleaseManifest(stateDir, 'release-valid').releaseId, 'release-valid');
});

test('preserves all manifests when a journal is legacy or has unknown component metadata', (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  for (const journalKind of ['legacy', 'unknown']) {
    const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-journal-history-'));
    for (const [index, digit] of ['a', 'b', 'c', 'd', 'e', 'f', '1'].entries()) {
      const manifest = buildReleaseManifest({
        releaseId: `release-${index}`,
        targetSha: sha(digit),
        components: [
          component('api-shared', digit),
          component('miniapp-major-static', digit),
          component('admin-static', digit),
        ],
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      });
      commitReleaseManifest({ stateDir, manifest, retain: 20 });
    }
    const current = readCurrentManifest(stateDir);
    const name =
      journalKind === 'legacy'
        ? 'current.invalid-legacy.json'
        : 'current.invalid-deploy-20260108T000000Z-1.json';
    writeFileSync(
      join(stateDir, name),
      JSON.stringify({
        ...current,
        ...(journalKind === 'unknown' ? { targetSha: 'unknown' } : {}),
      }),
    );
    assert.deepEqual(pruneOldManifests(stateDir), []);
    assert.equal(readReleaseManifest(stateDir, 'release-0').releaseId, 'release-0');
  }
});

test('can merge a recovery release from an explicit validated current manifest file', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-recovery-'));
  const recoveryBasePath = join(stateDir, 'current.invalid-runtime-rollback.json');
  const recoveryBase = buildReleaseManifest({
    releaseId: 'release-before-interruption',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  writeFileSync(recoveryBasePath, `${JSON.stringify(recoveryBase)}\n`);

  const nextApi = component('api-shared', 'b');
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'release-manifest.mjs'),
      'commit',
      '--state-dir',
      stateDir,
      '--release-id',
      'runtime-recovery',
      '--target-sha',
      sha('b'),
      '--current-manifest-file',
      recoveryBasePath,
      '--component',
      `${nextApi.id}|${nextApi.sourceSha}|${nextApi.imageRef}|${nextApi.imageId}`,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const current = readCurrentManifest(stateDir);
  assert.equal(current.components['api-shared'].sourceSha, sha('b'));
  assert.equal(current.components['miniapp-major-static'].sourceSha, sha('a'));
  assert.equal(current.components['admin-static'].sourceSha, sha('a'));
});

test('discovers exactly one complete interrupted release manifest', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-discovery-'));
  const candidatePath = join(stateDir, 'current.invalid-deploy-20260815T120000Z-123.json');
  const manifest = buildReleaseManifest({
    releaseId: 'release-before-deploy',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  writeFileSync(candidatePath, `${JSON.stringify(manifest)}\n`);
  writeFileSync(`${candidatePath}.recovered-20260815T121000Z-124`, 'ignored\n');

  assert.equal(findRecoveryBaseManifest(stateDir), candidatePath);

  writeFileSync(
    join(stateDir, 'current.invalid-release-rollback-20260815T122000Z-125.json'),
    `${JSON.stringify(manifest)}\n`,
  );
  assert.throws(
    () => findRecoveryBaseManifest(stateDir),
    /requires exactly one invalid current manifest/u,
  );
});

test('rejects an incomplete recovery base and an unknown completed release', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-invalid-recovery-'));
  const incompletePath = join(stateDir, 'incomplete.json');
  const incomplete = buildReleaseManifest({
    releaseId: 'incomplete-release',
    targetSha: sha('a'),
    components: [component('api-shared', 'a')],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  writeFileSync(incompletePath, `${JSON.stringify(incomplete)}\n`);
  assert.throws(
    () => readRecoveryBaseManifest(incompletePath),
    /missing active component: miniapp-major-static/u,
  );

  const unknown = buildReleaseManifest({
    releaseId: 'inventory-release',
    targetSha: 'unknown',
    components: [
      { ...component('api-shared', 'a'), sourceSha: 'unknown', imageId: 'unknown' },
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  validateCompleteReleaseManifest(unknown, { allowUnknown: true });
  assert.throws(() => validateCompleteReleaseManifest(unknown), /targetSha must be known/u);
});

test('atomically journals current before a release runtime transition', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-transition-'));
  const current = buildReleaseManifest({
    releaseId: 'release-before-transition',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: current });

  const recoveryPath = beginReleaseTransition({
    stateDir,
    kind: 'deploy',
    now: new Date('2026-08-15T12:30:45.000Z'),
    pid: 456,
  });

  assert.equal(recoveryPath, join(stateDir, 'current.invalid-deploy-20260815T123045Z-456.json'));
  assert.equal(existsSync(join(stateDir, 'current.json')), false);
  assert.equal(readRecoveryBaseManifest(recoveryPath).releaseId, current.releaseId);

  commitReleaseManifest({ stateDir, manifest: current });
  assert.throws(
    () =>
      beginReleaseTransition({
        stateDir,
        kind: 'release-rollback-api',
        now: new Date('2026-08-15T12:31:45.000Z'),
        pid: 457,
      }),
    /coexists with 1 unresolved transition journal/u,
  );
});

test('durably archives only a transition journal superseded by a completed current release', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'maxim-release-transition-archive-'));
  const previous = buildReleaseManifest({
    releaseId: 'release-before-archive',
    targetSha: sha('a'),
    components: [
      component('api-shared', 'a'),
      component('miniapp-major-static', 'a'),
      component('admin-static', 'a'),
    ],
    createdAt: '2026-08-15T12:00:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: previous });
  const recoveryPath = beginReleaseTransition({
    stateDir,
    kind: 'deploy',
    now: new Date('2026-08-15T12:30:00.000Z'),
    pid: 100,
  });

  assert.throws(
    () =>
      archiveReleaseTransition({
        stateDir,
        recoveryPath,
        now: new Date('2026-08-15T12:31:00.000Z'),
        pid: 101,
      }),
    /completed current release is required/u,
  );

  const completed = buildReleaseManifest({
    releaseId: 'release-after-archive',
    targetSha: sha('b'),
    current: previous,
    components: [component('api-shared', 'b')],
    createdAt: '2026-08-15T12:32:00.000Z',
  });
  commitReleaseManifest({ stateDir, manifest: completed });
  const archivedPath = archiveReleaseTransition({
    stateDir,
    recoveryPath,
    disposition: 'superseded',
    now: new Date('2026-08-15T12:33:00.000Z'),
    pid: 102,
  });

  assert.equal(archivedPath, `${recoveryPath}.superseded-20260815T123300Z-102`);
  assert.equal(existsSync(recoveryPath), false);
  assert.equal(existsSync(archivedPath), true);
  assert.equal(findRecoveryBaseManifest(stateDir), null);
});

test('fsyncs manifest contents and parent directories around transition renames', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'release-manifest.mjs'), 'utf8');

  assert.match(
    source,
    /syncPath\(currentPath\);\n {2}renameSync\(currentPath, recoveryPath\);\n {2}syncDirectory\(stateDir\);/u,
  );
  assert.match(
    source,
    /syncPath\(resolvedRecoveryPath\);\n {2}renameSync\(resolvedRecoveryPath, archivedPath\);\n {2}syncDirectory\(resolvedStateDir\);/u,
  );
  assert.match(
    source,
    /syncPath\(tempPath\);\n {4}renameSync\(tempPath, path\);\n {4}syncDirectory\(parentDir\);/u,
  );
});
