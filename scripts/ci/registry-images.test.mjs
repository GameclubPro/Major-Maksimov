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
  imageIdentity,
  provenanceArguments,
  publishImage,
  trustedBuildContext,
  verifyRegistryImage,
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
const spdx = 'https://spdx.dev/Document';
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
  assert.equal(identity.repository, 'ghcr.io/gameclubpro/major-maksimov-api');
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

function publisher({ visibility = 'private', pulledId = imageId, firstMissing = false } = {}) {
  const calls = [];
  let inspectCount = 0;
  let packageCount = 0;
  const run = (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === 'gh') return firstMissing && packageCount++ === 0 ? null : visibility;
    if (args[0] === 'image' && args[1] === 'inspect')
      return JSON.stringify([{ ...inspection(), Id: ++inspectCount === 3 ? pulledId : imageId }]);
    return '';
  };
  return { run, calls };
}

test('publishing rejects a pre-existing public package before any registry write', () => {
  const { run, calls } = publisher({ visibility: 'public' });
  assert.throws(() => publishImage(record(), expected, run), /private/u);
  assert.ok(!calls.some(([, ...args]) => args[1] === 'push'));
});

test('publication pulls the exact digest and rejects a changed Docker config ID', () => {
  const good = publisher({ firstMissing: true });
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

test('proof-only validates provenance and SBOM without a local Docker daemon', () => {
  const predicates = [];
  const run = (binary, args) => {
    assert.equal(binary, 'gh');
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
    /unavailable/u,
  );
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
