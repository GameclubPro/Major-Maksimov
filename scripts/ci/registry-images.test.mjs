import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { assertPinnedGhBinary, GH_CLI_PIN } from './github-cli.mjs';
import {
  assertImageInspection,
  assertImageRecord,
  assertRegistryRecord,
  assertVerifiedAttestation,
  execute,
  imageIdentity,
  isOpaqueGitHubCredential,
  parseImageInspection,
  packageRepository,
  provenanceArguments,
  publishImage,
  trustedBuildContext,
  verifyRegistryImage,
  verifyPrivatePackage,
} from './registry-images.mjs';

const sha = 'a'.repeat(40);
const repository = 'GameclubPro/Major-Maksimov';
const expected = {
  repository,
  repositoryId: '1168895008',
  sha,
  component: 'api',
  runId: '123',
  runAttempt: '2',
  event: 'push',
};
const identity = imageIdentity(expected);
const imageId = `sha256:${'b'.repeat(64)}`;
const digest = `sha256:${'c'.repeat(64)}`;
const sizeBytes = 128 * 1024 ** 2;
const inspection = () => ({
  Id: imageId,
  Os: 'linux',
  Architecture: 'amd64',
  Size: sizeBytes,
  Config: {
    Labels: { 'org.opencontainers.image.revision': sha, 'com.maxim.release-protected': 'true' },
  },
  RepoDigests: [`${identity.repository}@${digest}`],
});
const record = () => ({
  schemaVersion: 1,
  component: 'api',
  source: {
    ...expected,
    workflow: '.github/workflows/ci.yml',
    workflowRef: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
    runnerEnvironment: 'github-hosted',
  },
  image: { alias: identity.alias, imageId, sizeBytes, platform: 'linux/amd64' },
  registry: { repository: identity.repository, digest },
});
const environment = () => ({
  GITHUB_REPOSITORY: repository,
  GITHUB_REPOSITORY_ID: expected.repositoryId,
  GITHUB_SHA: sha,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_RUN_ID: expected.runId,
  GITHUB_RUN_ATTEMPT: expected.runAttempt,
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
  RUNNER_ENVIRONMENT: 'github-hosted',
  MAXIM_IMAGE_COMPONENT: 'api',
});
const provenance = 'https://slsa.dev/provenance/v1';
const spdx = 'https://spdx.dev/Document/v2.3';
const attestation = (predicate = provenance) => [
  {
    verificationResult: {
      signature: {
        certificate: {
          issuer: 'https://token.actions.githubusercontent.com',
          sourceRepositoryURI: `https://github.com/${repository}`,
          sourceRepositoryIdentifier: expected.repositoryId,
          sourceRepositoryDigest: sha,
          sourceRepositoryRef: 'refs/heads/main',
          buildSignerURI: `https://github.com/${repository}/.github/workflows/ci.yml@refs/heads/main`,
          buildSignerDigest: sha,
          runnerEnvironment: 'github-hosted',
          buildTrigger: 'push',
          runInvocationURI: `https://github.com/${repository}/actions/runs/123/attempts/2`,
        },
      },
      verifiedTimestamps: [{ time: '2026-11-04T02:00:00Z' }],
      statement: {
        predicateType: predicate,
        subject: [{ name: identity.repository, digest: { sha256: digest.slice(7) } }],
      },
    },
  },
];

test('only exact main workflow on an allowed runner and trigger may publish images', () => {
  assert.equal(trustedBuildContext(environment()).sha, sha);
  assert.equal(
    trustedBuildContext({ ...environment(), GITHUB_EVENT_NAME: 'workflow_dispatch' }).event,
    'workflow_dispatch',
  );
  for (const delta of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_EVENT_NAME: 'schedule' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_WORKFLOW_SHA: 'd'.repeat(40) },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@refs/heads/main` },
    { GITHUB_REPOSITORY_ID: '' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_RUN_ID: '123\n' },
  ])
    assert.throws(() => trustedBuildContext({ ...environment(), ...delta }));
});

test('image identity never accepts a short SHA, injected path or unsupported component', () => {
  assert.equal(identity.repository, 'ghcr.io/gameclubpro/major-maksimov-private-v1-api');
  for (const delta of [
    { sha: sha.slice(0, 12) },
    { sha: `${sha}\n` },
    { repository: '../owner/repo' },
    { repository: `${repository};echo leak` },
    { component: 'postgres' },
  ]) {
    assert.throws(() => imageIdentity({ ...expected, ...delta }));
  }
});

test('package metadata identity needs no fabricated source SHA and cannot produce a runtime alias', () => {
  assert.equal(packageRepository({ repository, component: 'api' }), identity.repository);
  assert.throws(() => imageIdentity({ repository, component: 'api' }));
  assert.throws(() => packageRepository({ repository, component: 'postgres' }));
  assert.throws(() => packageRepository({ repository: '../injected/repo', component: 'api' }));
});

test('the smoke-tested Docker ID and registry manifest digest remain separate', () => {
  assert.notEqual(imageId, digest);
  assert.equal(assertRegistryRecord(record(), expected), `${identity.repository}@${digest}`);
  assert.equal(assertImageInspection(inspection(), { sha, imageId, sizeBytes }), imageId);
  assert.throws(() => assertImageInspection(inspection(), { sha, imageId: digest }));
  for (const delta of [
    { Architecture: 'arm64' },
    { Os: 'windows' },
    { Size: 0 },
    { Size: Number.MAX_SAFE_INTEGER },
    { Config: { Labels: { 'org.opencontainers.image.revision': sha } } },
  ]) {
    assert.throws(() => assertImageInspection({ ...inspection(), ...delta }, { sha, imageId }));
  }
  assert.throws(() => assertImageInspection(inspection(), { sha, sizeBytes: sizeBytes - 1 }));
});

test('opaque package credentials use a transport budget, without a provider format or normalization', () => {
  for (const token of [
    'x',
    'x'.repeat(256),
    'x'.repeat(4096),
    '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  ])
    assert.equal(isOpaqueGitHubCredential(token), true);
  for (const token of [
    undefined,
    null,
    false,
    42,
    {},
    '',
    'x'.repeat(4097),
    ' x',
    'x ',
    'x y',
    'x\n',
    'x\r',
    'x\t',
    'x\0',
    'x\x1f',
    'x\x7f',
    'xé',
    'x\u200b',
  ])
    assert.equal(isOpaqueGitHubCredential(token), false);
});

test('image inspection refusals identify the failed comparison without rendering image content', () => {
  const marker = 'private-inspection-content';
  for (const [value, wanted, reason] of [
    [null, {}, 'INSPECTION_MISSING'],
    [{ ...inspection(), Id: marker }, {}, 'IMAGE_ID_INVALID'],
    [{ ...inspection(), Os: marker }, {}, 'OS_MISMATCH'],
    [{ ...inspection(), Architecture: marker }, {}, 'ARCHITECTURE_MISMATCH'],
    [
      { ...inspection(), Config: { Labels: { 'org.opencontainers.image.revision': marker } } },
      {},
      'SOURCE_REVISION_MISMATCH',
    ],
    [{ ...inspection(), Config: null }, {}, 'SOURCE_REVISION_MISMATCH'],
    [
      {
        ...inspection(),
        Config: {
          Labels: {
            'org.opencontainers.image.revision': sha,
            'com.maxim.release-protected': marker,
          },
        },
      },
      {},
      'RELEASE_PROTECTION_MISMATCH',
    ],
    ...[0, -1, 1.5, '128', null, 64 * 1024 ** 3 + 1].map((Size) => [
      { ...inspection(), Size },
      {},
      'SIZE_INVALID',
    ]),
    [inspection(), { imageId: digest }, 'IMAGE_ID_MISMATCH'],
    [inspection(), { sizeBytes: sizeBytes - 1 }, 'SIZE_MISMATCH'],
  ]) {
    assert.throws(
      () => assertImageInspection(value, { sha, ...wanted }),
      (error) => {
        assert.equal(error.code, 'IMAGE_INSPECTION_REFUSED');
        assert.equal(error.reason, reason);
        assert.equal(error.cause, undefined);
        assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(marker), false);
        return true;
      },
    );
  }
  assert.equal(assertImageInspection({ ...inspection(), Size: 64 * 1024 ** 3 }, { sha }), imageId);
});

test('malformed Docker inspections never expose raw stdout and block all registry writes', () => {
  const marker = 'private-docker-response';
  for (const [output, reason] of [
    [`{"${marker}"`, 'INSPECTION_JSON_INVALID'],
    [JSON.stringify({ [marker]: 'value' }), 'INSPECTION_CARDINALITY'],
    ['[]', 'INSPECTION_CARDINALITY'],
    [JSON.stringify([inspection(), inspection()]), 'INSPECTION_CARDINALITY'],
  ]) {
    assert.throws(() => parseImageInspection(output), { code: 'IMAGE_INSPECTION_REFUSED', reason });
    let inspections = 0;
    assert.throws(
      () =>
        publishImage(record(), expected, (binary, args) => {
          inspections++;
          assert.equal(binary, 'docker');
          assert.deepEqual(args, ['image', 'inspect', identity.alias]);
          return output;
        }),
      (error) => {
        assert.equal(error.reason, reason);
        assert.equal(error.cause, undefined);
        assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(marker), false);
        return true;
      },
    );
    assert.equal(inspections, 1);
  }
});

test('image archives cannot be reused across attempts, sources, repositories or triggers', () => {
  assert.doesNotThrow(() => assertImageRecord(record(), expected));
  for (const delta of [
    { sha: 'd'.repeat(40) },
    { runAttempt: '1' },
    { runId: '122' },
    { repositoryId: '8' },
    { event: 'workflow_dispatch' },
    { component: 'admin' },
  ]) {
    assert.throws(() => assertImageRecord(record(), { ...expected, ...delta }));
  }
  const invalid = record();
  invalid.registry.repository = 'ghcr.io/other/repo';
  assert.throws(() => assertRegistryRecord(invalid, expected));
  invalid.registry.repository = identity.repository;
  invalid.image.sizeBytes = -1;
  assert.throws(() => assertRegistryRecord(invalid, expected));
});

test('legacy public registry records cannot authorize a release in the new private namespace', () => {
  for (const retired of [
    'ghcr.io/gameclubpro/major-maksimov-api',
    'ghcr.io/gameclubpro/major-maksimov-release-api',
  ]) {
    const legacy = record();
    legacy.registry.repository = retired;
    assert.throws(() => assertRegistryRecord(legacy, expected), /Registry digest or repository/u);
    assert.throws(
      () =>
        verifyRegistryImage(legacy, expected, () => {
          assert.fail('legacy record reached external verifier');
        }),
      /Registry digest or repository/u,
    );
    assert.equal(record().image.alias, `maxim-api:${sha}`);
  }
});

test('the pinned verifier accepts the observed signed SPDX 2.3 publication', () => {
  const observed = JSON.parse(
    readFileSync(new URL('./test/registry-verified-attestations.fixture.json', import.meta.url)),
  );
  const observedIdentity = imageIdentity(observed.expected);
  // FLAG: The projected fixture exercises the verified metadata boundary; it does not prove a Docker image ID.
  const observedRecord = {
    ...record(),
    component: observed.expected.component,
    source: {
      ...observed.expected,
      workflow: '.github/workflows/ci.yml',
      workflowRef: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      runnerEnvironment: 'github-hosted',
    },
    image: { ...record().image, alias: observedIdentity.alias },
    registry: observed.registry,
  };
  const predicates = [];
  const reference = verifyRegistryImage(
    observedRecord,
    observed.expected,
    (binary, args) => {
      assert.equal(binary, 'gh');
      if (args[0] === 'api') {
        return JSON.stringify(packageMetadata({ name: 'major-maksimov-private-v1-eraser' }));
      }
      assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
      const predicate = args[args.indexOf('--predicate-type') + 1];
      predicates.push(predicate);
      return JSON.stringify(
        predicate === provenance ? observed.verifications.provenance : observed.verifications.sbom,
      );
    },
    { proofOnly: true },
  );
  assert.equal(reference, `${observed.registry.repository}@${observed.registry.digest}`);
  assert.deepEqual(predicates, [provenance, 'https://spdx.dev/Document/v2.3']);
  for (const wrongType of [
    'https://spdx.dev/Document',
    'https://spdx.dev/Document/v2.2',
    'https://spdx.dev/Document/v2.3/other',
  ]) {
    const wrong = structuredClone(observed.verifications.sbom);
    wrong[0].verificationResult.statement.predicateType = wrongType;
    assert.throws(() => assertVerifiedAttestation(wrong, observedRecord, observed.expected, spdx));
  }
});

test('each required OIDC certificate claim is checked after cryptographic verification', () => {
  assert.doesNotThrow(() =>
    assertVerifiedAttestation(attestation(), record(), expected, provenance),
  );
  for (const [field, wrong] of Object.entries({
    issuer: 'https://evil.example',
    sourceRepositoryURI: 'https://github.com/other/repo',
    sourceRepositoryIdentifier: '9',
    sourceRepositoryDigest: 'd'.repeat(40),
    sourceRepositoryRef: 'refs/pull/1/merge',
    buildSignerURI: `https://github.com/${repository}/.github/workflows/other.yml@refs/heads/main`,
    buildSignerDigest: 'e'.repeat(40),
    runnerEnvironment: 'self-hosted',
    buildTrigger: 'pull_request',
    runInvocationURI: `https://github.com/${repository}/actions/runs/123/attempts/1`,
  })) {
    const bad = attestation();
    bad[0].verificationResult.signature.certificate[field] = wrong;
    assert.throws(
      () => assertVerifiedAttestation(bad, record(), expected, provenance),
      undefined,
      field,
    );
  }
});

test('predicate invocation metadata cannot substitute for signed certificate claims', () => {
  const bad = attestation();
  delete bad[0].verificationResult.signature.certificate.runInvocationURI;
  bad[0].verificationResult.statement.predicate = {
    runId: '123',
    runAttempt: '2',
    runnerEnvironment: 'github-hosted',
  };
  assert.throws(() => assertVerifiedAttestation(bad, record(), expected, provenance));
  const wrongSubject = attestation();
  wrongSubject[0].verificationResult.statement.subject[0].digest.sha256 = 'd'.repeat(64);
  assert.throws(() => assertVerifiedAttestation(wrongSubject, record(), expected, provenance));
  const noTime = attestation();
  noTime[0].verificationResult.verifiedTimestamps = [];
  assert.throws(() => assertVerifiedAttestation(noTime, record(), expected, provenance));
  assert.throws(() => assertVerifiedAttestation(attestation(spdx), record(), expected, provenance));
});

test('manual preparation must have its own signed manual invocation', () => {
  const manual = record();
  manual.source.event = 'workflow_dispatch';
  assert.throws(() =>
    assertVerifiedAttestation(
      attestation(),
      manual,
      { ...expected, event: 'workflow_dispatch' },
      provenance,
    ),
  );
  const valid = attestation();
  valid[0].verificationResult.signature.certificate.buildTrigger = 'workflow_dispatch';
  assert.doesNotThrow(() =>
    assertVerifiedAttestation(
      valid,
      manual,
      { ...expected, event: 'workflow_dispatch' },
      provenance,
    ),
  );
});

test('verifier command pins source, signer, issuer and runner policy', () => {
  const args = provenanceArguments(record(), expected, provenance);
  assert.ok(args.includes('--deny-self-hosted-runners'));
  assert.equal(args[args.indexOf('--source-digest') + 1], sha);
  assert.equal(args[args.indexOf('--signer-digest') + 1], sha);
  assert.equal(args[args.indexOf('--source-ref') + 1], 'refs/heads/main');
  assert.equal(args[2], `oci://${identity.repository}@${digest}`);
});

function packageMetadata(patch = {}) {
  return {
    name: 'major-maksimov-private-v1-api',
    package_type: 'container',
    visibility: 'private',
    repository: { id: Number(expected.repositoryId), full_name: repository },
    ...patch,
  };
}

function publisher({
  visibility = 'private',
  pulledId = imageId,
  firstMissing = false,
  metadata,
  afterMetadata,
} = {}) {
  const calls = [];
  let inspectCount = 0;
  let packageCount = 0;
  const run = (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === 'gh') {
      const first = packageCount++ === 0;
      if (firstMissing && first) return null;
      return JSON.stringify(
        first
          ? (metadata ?? packageMetadata({ visibility }))
          : (afterMetadata ?? metadata ?? packageMetadata({ visibility })),
      );
    }
    if (args[0] === 'image' && args[1] === 'inspect')
      return JSON.stringify([{ ...inspection(), Id: ++inspectCount === 3 ? pulledId : imageId }]);
    return '';
  };
  return { run, calls };
}

test('publishing rejects a pre-existing public package before any registry write', () => {
  const { run, calls } = publisher({ visibility: 'public' });
  assert.throws(() => publishImage(record(), expected, run), /private/u);
  assert.ok(!calls.some(([, ...args]) => ['push', 'tag'].includes(args[1])));
});

test('publication pulls the exact digest and rejects a changed Docker config ID', () => {
  const good = publisher();
  assert.equal(publishImage(record(), expected, good.run).registry.digest, digest);
  assert.ok(
    good.calls.some(
      ([binary, ...args]) =>
        binary === 'docker' &&
        args.join(' ') === `image pull --platform linux/amd64 ${identity.repository}@${digest}`,
    ),
  );
  const bad = publisher({ pulledId: `sha256:${'d'.repeat(64)}` });
  assert.throws(() => publishImage(record(), expected, bad.run), /Image ID/u);
});

test('missing first package is never permission to tag or publish an image', () => {
  const missing = publisher({ firstMissing: true });
  assert.throws(
    () => publishImage(record(), expected, missing.run),
    (error) => error.code === 'REGISTRY_PACKAGE_UNVERIFIED',
  );
  assert.ok(
    !missing.calls.some(
      ([binary, ...args]) => binary === 'docker' && ['tag', 'push'].includes(args[1]),
    ),
  );
});

test('private package requires typed metadata and exact source repository binding', () => {
  assert.deepEqual(
    verifyPrivatePackage(expected, () => JSON.stringify(packageMetadata())),
    packageMetadata(),
  );
  for (const metadata of [
    null,
    [],
    {},
    { visibility: 'private' },
    packageMetadata({ name: 'different-package' }),
    packageMetadata({ package_type: 'npm' }),
    packageMetadata({ visibility: '' }),
    packageMetadata({ visibility: false }),
  ]) {
    assert.throws(
      () => verifyPrivatePackage(expected, () => JSON.stringify(metadata)),
      (error) => error.code === 'REGISTRY_PACKAGE_UNVERIFIED',
    );
  }
  for (const binding of [
    undefined,
    null,
    {},
    { id: Number(expected.repositoryId), full_name: 'other/repository' },
    { id: 42, full_name: repository },
    { id: expected.repositoryId, full_name: repository },
  ]) {
    const invalid = publisher({ metadata: packageMetadata({ repository: binding }) });
    assert.throws(
      () => publishImage(record(), expected, invalid.run),
      (error) => error.code === 'REGISTRY_PACKAGE_UNBOUND',
    );
    assert.ok(
      !invalid.calls.some(
        ([binary, ...args]) => binary === 'docker' && ['tag', 'push'].includes(args[1]),
      ),
    );
  }
});

test('privacy is rechecked after publication before any digest or attestation receipt', () => {
  for (const visibility of ['public', 'internal', '']) {
    const changed = publisher({ afterMetadata: packageMetadata({ visibility }) });
    assert.throws(() => publishImage(record(), expected, changed.run));
    assert.ok(changed.calls.some(([binary, ...args]) => binary === 'docker' && args[1] === 'push'));
    assert.ok(
      !changed.calls.some(([binary, ...args]) => binary === 'docker' && args[1] === 'pull'),
    );
  }
});

test('actual process transport denies 403, 404, public and malformed package responses before all registry writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-package-transport-'));
  const script = join(directory, 'transport.cjs');
  const callsFile = join(directory, 'calls.jsonl');
  writeFileSync(
    script,
    `
    const fs=require('node:fs');
    const [binary,...args]=process.argv.slice(2);
    fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify([binary,...args])+'\\n');
    if(binary==='gh') {
      if(['403','404'].includes(process.env.TEST_MODE)) {
        process.stderr.write('private remote detail HTTP '+process.env.TEST_MODE+'\\n');
        process.exit(1);
      }
      if(process.env.TEST_MODE==='empty') process.exit(0);
      if(process.env.TEST_MODE==='malformed') { process.stdout.write('{bad private response'); process.exit(0); }
      const metadata=JSON.parse(process.env.TEST_METADATA);
      if(process.env.TEST_MODE==='public') metadata.visibility='public';
      if(process.env.TEST_MODE==='unbound') metadata.repository.id=42;
      process.stdout.write(JSON.stringify(metadata));
    } else if(binary==='docker' && args[0]==='image' && args[1]==='inspect') {
      process.stdout.write(process.env.TEST_INSPECTION);
    }
  `,
    { mode: 0o600 },
  );
  try {
    for (const [mode, code] of [
      ['403', 'REGISTRY_PACKAGE_UNVERIFIED'],
      ['404', 'REGISTRY_PACKAGE_UNVERIFIED'],
      ['empty', 'REGISTRY_PACKAGE_UNVERIFIED'],
      ['malformed', 'REGISTRY_PACKAGE_UNVERIFIED'],
      ['public', 'REGISTRY_PACKAGE_PUBLIC'],
      ['unbound', 'REGISTRY_PACKAGE_UNBOUND'],
    ]) {
      writeFileSync(callsFile, '', { mode: 0o600 });
      const env = {
        TEST_CALLS: callsFile,
        TEST_MODE: mode,
        TEST_METADATA: JSON.stringify(packageMetadata()),
        TEST_INSPECTION: JSON.stringify([inspection()]),
      };
      const transport = (binary, args) =>
        execute(process.execPath, [script, binary, ...args], { env });
      assert.throws(
        () => publishImage(record(), expected, transport),
        (error) => {
          assert.equal(error.code, code);
          assert.ok(!error.message.includes('private remote detail'));
          assert.ok(!error.message.includes('bad private response'));
          return true;
        },
      );
      const calls = readFileSync(callsFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(calls.filter(([binary]) => binary === 'gh').length, 1);
      assert.ok(
        !calls.some(
          ([binary, ...args]) => binary === 'docker' && ['tag', 'push'].includes(args[1]),
        ),
        mode,
      );
      const lookup = calls.find(([binary]) => binary === 'gh');
      assert.equal(lookup[2], 'users/GameclubPro/packages/container/major-maksimov-private-v1-api');
      assert.ok(!lookup.includes('--jq'));
    }
    writeFileSync(callsFile, '', { mode: 0o600 });
    const env = {
      TEST_CALLS: callsFile,
      TEST_MODE: 'private',
      TEST_METADATA: JSON.stringify(packageMetadata()),
      TEST_INSPECTION: JSON.stringify([inspection()]),
    };
    const transport = (binary, args) =>
      execute(process.execPath, [script, binary, ...args], { env });
    assert.equal(publishImage(record(), expected, transport).registry.digest, digest);
    const calls = readFileSync(callsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const firstLookup = calls.findIndex(([binary]) => binary === 'gh');
    const tag = calls.findIndex(([binary, ...args]) => binary === 'docker' && args[1] === 'tag');
    const push = calls.findIndex(([binary, ...args]) => binary === 'docker' && args[1] === 'push');
    assert.ok(firstLookup >= 0 && tag > firstLookup && push > tag);
    assert.equal(calls.filter(([binary]) => binary === 'gh').length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('proof-only validates provenance and SBOM without a local Docker daemon', () => {
  const predicates = [];
  const run = (binary, args) => {
    assert.equal(binary, 'gh');
    if (args[0] === 'api') return JSON.stringify(packageMetadata());
    const predicate = args[args.indexOf('--predicate-type') + 1];
    predicates.push(predicate);
    return JSON.stringify(attestation(predicate));
  };
  assert.equal(
    verifyRegistryImage(record(), expected, run, { proofOnly: true }),
    `${identity.repository}@${digest}`,
  );
  assert.deepEqual(predicates, [provenance, spdx]);
  assert.throws(
    () =>
      verifyRegistryImage(
        record(),
        expected,
        () => {
          throw new Error('registry unavailable');
        },
        { proofOnly: true },
      ),
    (error) => error.code === 'REGISTRY_PACKAGE_UNVERIFIED',
  );
});

test('previously signed image cannot be consumed after its package becomes public or unreadable', () => {
  for (const response of [JSON.stringify(packageMetadata({ visibility: 'public' })), '', 'null']) {
    const calls = [];
    assert.throws(() =>
      verifyRegistryImage(
        record(),
        expected,
        (binary, args) => {
          calls.push([binary, ...args]);
          assert.equal(binary, 'gh');
          assert.equal(args[0], 'api');
          return response;
        },
        { proofOnly: true },
      ),
    );
    assert.equal(calls.length, 1);
  }
});

test('CLI pin rejects corrupted binaries and symlinks before execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxim-gh-pin-test-'));
  try {
    const path = join(dir, 'gh');
    writeFileSync(path, '#!/bin/sh\necho forged\n');
    assert.throws(() => assertPinnedGhBinary(path), /reviewed/u);
    const link = join(dir, 'link');
    symlinkSync(path, link);
    assert.throws(() => assertPinnedGhBinary(link), /reviewed/u);
    assert.match(GH_CLI_PIN.archiveSha256, /^[a-f0-9]{64}$/u);
    assert.notEqual(GH_CLI_PIN.binarySha256, GH_CLI_PIN.archiveSha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow grants signing and registry permissions only after image smokes', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.registry.needs, ['impact', 'docker']);
  assert.deepEqual(workflow.jobs.registry.permissions, {
    contents: 'read',
    actions: 'read',
    packages: 'write',
    'id-token': 'write',
    attestations: 'write',
  });
  assert.ok(workflow.jobs.required.needs.includes('registry'));
  assert.equal(workflow.jobs.registry.if, "needs.impact.outputs.registry == 'true'");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.equal(job['continue-on-error'], undefined, id);
    if (id !== 'registry') {
      assert.equal(job.permissions?.packages, undefined, id);
      assert.equal(job.permissions?.['id-token'], undefined, id);
    }
  }
  const steps = workflow.jobs.registry.steps;
  const verify = steps.findIndex(
    (step) => step.run === 'node scripts/ci/registry-images.mjs verify',
  );
  const receipt = steps.findIndex((step) => step.name === 'Upload the immutable registry receipt');
  assert.ok(verify >= 0 && receipt > verify);
  assert.equal(steps[receipt].with.path, 'registry-record-${{ matrix.component }}.json');
  assert.equal(
    steps
      .find((step) => step.name === 'Load the exact smoke-tested image')
      .run.includes('docker build'),
    false,
  );
  assert.equal(
    workflow.jobs.docker.steps.find((step) => step.name === 'Package immutable production image')
      .if,
    "needs.impact.outputs.registry == 'true'",
  );
});

test('CodeQL keeps analysis, alert gate and weekly database upload', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/codeql.yml', import.meta.url), 'utf8'),
  );
  const steps = workflow.jobs.analyze.steps;
  assert.equal(
    steps.find((step) => step.name === 'Analyze').with['upload-database'],
    "${{ github.event_name == 'schedule' }}",
  );
  assert.equal(
    steps.find((step) => step.name === 'Reject open high-severity alerts').if,
    undefined,
  );
  assert.equal(workflow.permissions['security-events'], 'write');
});
