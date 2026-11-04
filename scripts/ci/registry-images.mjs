#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureGitHubCli } from './github-cli.mjs';

export const IMAGE_ALIASES = Object.freeze({
  api: 'maxim-api',
  miniapp: 'maxim-miniapp-major',
  admin: 'maxim-admin',
  eraser: 'maxim-eraser',
});
export const IMAGE_WORKFLOW = '.github/workflows/ci.yml';
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const POSITIVE_ID = /^[1-9][0-9]*$/u;
const TRUSTED_EVENTS = ['push', 'workflow_dispatch'];

export function isOpaqueGitHubCredential(value) {
  // FLAG: This is a transport bound, not a provider token format or proof of access.
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[^\x21-\x7E]/u.test(value)
  );
}

const INSPECTION_REASONS = new Set([
  'INSPECTION_MISSING',
  'INSPECTION_JSON_INVALID',
  'INSPECTION_CARDINALITY',
  'IMAGE_ID_INVALID',
  'OS_MISMATCH',
  'ARCHITECTURE_MISMATCH',
  'SOURCE_REVISION_MISMATCH',
  'RELEASE_PROTECTION_MISMATCH',
  'SIZE_INVALID',
  'IMAGE_ID_MISMATCH',
  'SIZE_MISMATCH',
]);

export class ImageInspectionError extends Error {
  constructor(reason) {
    const fixedReason = INSPECTION_REASONS.has(reason) ? reason : 'UNKNOWN';
    // FLAG: Never render actual/expected image fields or attach raw Docker/JSON errors.
    super(
      `Image ID, platform or immutable source validation refused (code=IMAGE_INSPECTION_REFUSED, reason=${fixedReason}).`,
    );
    this.code = 'IMAGE_INSPECTION_REFUSED';
    this.reason = fixedReason;
  }
}

export function parseImageInspection(output) {
  let records;
  try {
    if (typeof output !== 'string') throw new Error();
    records = JSON.parse(output);
  } catch {
    throw new ImageInspectionError('INSPECTION_JSON_INVALID');
  }
  if (!Array.isArray(records) || records.length !== 1)
    throw new ImageInspectionError('INSPECTION_CARDINALITY');
  return records[0];
}

export function packageRepository({ repository, component }) {
  if (!REPOSITORY.test(repository ?? '') || !Object.hasOwn(IMAGE_ALIASES, component)) {
    throw new Error('Expected an exact repository and supported image component.');
  }
  return `ghcr.io/${repository.toLowerCase()}-private-v1-${component}`;
}

export function imageIdentity({ repository, sha, component }) {
  const registryRepository = packageRepository({ repository, component });
  if (!SHA.test(sha ?? ''))
    throw new Error('Expected an exact repository, source SHA and supported image component.');
  return {
    alias: `${IMAGE_ALIASES[component]}:${sha}`,
    repository: registryRepository,
  };
}

export function trustedBuildContext(env) {
  imageIdentity({
    repository: env.GITHUB_REPOSITORY,
    sha: env.GITHUB_SHA,
    component: env.MAXIM_IMAGE_COMPONENT,
  });
  if (
    !TRUSTED_EVENTS.includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_WORKFLOW_REF !== `${env.GITHUB_REPOSITORY}/${IMAGE_WORKFLOW}@refs/heads/main` ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !POSITIVE_ID.test(env.GITHUB_REPOSITORY_ID ?? '') ||
    !POSITIVE_ID.test(env.GITHUB_RUN_ID ?? '') ||
    !POSITIVE_ID.test(env.GITHUB_RUN_ATTEMPT ?? '')
  ) {
    throw new Error(
      'Image publication requires the exact trusted main workflow on a GitHub-hosted runner.',
    );
  }
  return {
    repository: env.GITHUB_REPOSITORY,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    sha: env.GITHUB_SHA,
    workflow: IMAGE_WORKFLOW,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    runnerEnvironment: env.RUNNER_ENVIRONMENT,
    event: env.GITHUB_EVENT_NAME,
  };
}

export function assertImageInspection(inspection, { sha, imageId, sizeBytes }) {
  if (!inspection) throw new ImageInspectionError('INSPECTION_MISSING');
  if (!DIGEST.test(inspection.Id ?? '')) throw new ImageInspectionError('IMAGE_ID_INVALID');
  if (inspection.Os !== 'linux') throw new ImageInspectionError('OS_MISMATCH');
  if (inspection.Architecture !== 'amd64') throw new ImageInspectionError('ARCHITECTURE_MISMATCH');
  if (inspection.Config?.Labels?.['org.opencontainers.image.revision'] !== sha)
    throw new ImageInspectionError('SOURCE_REVISION_MISMATCH');
  if (inspection.Config?.Labels?.['com.maxim.release-protected'] !== 'true')
    throw new ImageInspectionError('RELEASE_PROTECTION_MISMATCH');
  if (
    !Number.isSafeInteger(inspection.Size) ||
    inspection.Size <= 0 ||
    inspection.Size > 64 * 1024 ** 3
  )
    throw new ImageInspectionError('SIZE_INVALID');
  if (imageId !== undefined && inspection.Id !== imageId)
    throw new ImageInspectionError('IMAGE_ID_MISMATCH');
  if (sizeBytes !== undefined && inspection.Size !== sizeBytes)
    throw new ImageInspectionError('SIZE_MISMATCH');
  return inspection.Id;
}

export function assertImageRecord(record, expected) {
  const identity = imageIdentity(expected);
  if (
    record?.schemaVersion !== 1 ||
    record.component !== expected.component ||
    record.source?.repository !== expected.repository ||
    record.source.sha !== expected.sha ||
    record.source.workflow !== IMAGE_WORKFLOW ||
    record.source.workflowRef !== `${expected.repository}/${IMAGE_WORKFLOW}@refs/heads/main` ||
    record.source.runnerEnvironment !== 'github-hosted' ||
    !POSITIVE_ID.test(record.source.repositoryId ?? '') ||
    !TRUSTED_EVENTS.includes(record.source.event) ||
    !POSITIVE_ID.test(record.source.runId ?? '') ||
    !POSITIVE_ID.test(record.source.runAttempt ?? '') ||
    !DIGEST.test(record.image?.imageId ?? '') ||
    record.image.alias !== identity.alias ||
    !Number.isSafeInteger(record.image.sizeBytes) ||
    record.image.sizeBytes <= 0 ||
    record.image.sizeBytes > 64 * 1024 ** 3 ||
    record.image.platform !== 'linux/amd64'
  ) {
    throw new Error('Image record is not bound to the requested component and trusted source.');
  }
  if (
    expected.runId !== undefined &&
    (record.source.runId !== expected.runId || record.source.runAttempt !== expected.runAttempt)
  ) {
    throw new Error(
      'Image archive belongs to a different workflow run or attempt; rerun the complete workflow.',
    );
  }
  if (
    (expected.repositoryId !== undefined && record.source.repositoryId !== expected.repositoryId) ||
    (expected.event !== undefined && record.source.event !== expected.event)
  ) {
    throw new Error('Image archive has different repository or trigger identity.');
  }
  return identity;
}

export function assertRegistryRecord(record, expected) {
  const identity = assertImageRecord(record, expected);
  if (
    record.registry?.repository !== identity.repository ||
    !DIGEST.test(record.registry.digest ?? '')
  ) {
    throw new Error('Registry digest or repository does not match the requested image.');
  }
  return `${identity.repository}@${record.registry.digest}`;
}

export function provenanceArguments(record, expected, predicateType) {
  const reference = assertRegistryRecord(record, expected);
  return [
    'attestation',
    'verify',
    `oci://${reference}`,
    '--repo',
    expected.repository,
    '--signer-workflow',
    `${expected.repository}/${IMAGE_WORKFLOW}`,
    '--signer-digest',
    expected.sha,
    '--source-ref',
    'refs/heads/main',
    '--source-digest',
    expected.sha,
    '--cert-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    '--deny-self-hosted-runners',
    '--predicate-type',
    predicateType,
    '--format',
    'json',
  ];
}

export function assertVerifiedAttestation(results, record, expected, predicateType) {
  assertRegistryRecord(record, expected);
  const repositoryUri = `https://github.com/${expected.repository}`;
  // FLAG: The certificate's OIDC claims bind the invocation. User-controlled predicate metadata cannot prove its run/attempt.
  const valid =
    Array.isArray(results) &&
    results.some(({ verificationResult: result } = {}) => {
      const certificate = result?.signature?.certificate;
      const statement = result?.statement;
      return (
        certificate?.issuer === 'https://token.actions.githubusercontent.com' &&
        certificate.sourceRepositoryURI === repositoryUri &&
        certificate.sourceRepositoryIdentifier === expected.repositoryId &&
        certificate.sourceRepositoryDigest === expected.sha &&
        certificate.sourceRepositoryRef === 'refs/heads/main' &&
        certificate.buildSignerURI === `${repositoryUri}/${IMAGE_WORKFLOW}@refs/heads/main` &&
        certificate.buildSignerDigest === expected.sha &&
        certificate.runnerEnvironment === 'github-hosted' &&
        certificate.buildTrigger === record.source.event &&
        certificate.runInvocationURI ===
          `${repositoryUri}/actions/runs/${record.source.runId}/attempts/${record.source.runAttempt}` &&
        Array.isArray(result.verifiedTimestamps) &&
        result.verifiedTimestamps.length > 0 &&
        statement?.predicateType === predicateType &&
        Array.isArray(statement.subject) &&
        statement.subject.some(
          (subject) =>
            subject.name === record.registry.repository &&
            subject.digest?.sha256 === record.registry.digest.slice(7),
        )
      );
    });
  if (!valid)
    throw new Error(
      'Verified attestation does not bind the exact repository, workflow, runner, subject and run attempt.',
    );
}

function readRecord(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new Error('Invalid image record file.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeRecord(path, record) {
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function execute(binary, args, { env = process.env, input } = {}) {
  const executable = binary === 'gh' ? ensureGitHubCli(env) : binary;
  const result = spawnSync(executable, args, {
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
  });
  if (result.status !== 0) {
    // FLAG: Login credentials are supplied only through stdin; never render subprocess input or environment.
    throw new Error(
      `${binary} ${args[0]} failed (${result.status ?? result.error?.code ?? result.signal}).`,
    );
  }
  return result.stdout.trim();
}

export class RegistryPrivacyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function privacyFailure(code) {
  const messages = {
    REGISTRY_PACKAGE_UNVERIFIED:
      'Cannot verify private image package metadata. An administrator must bootstrap a private package, link the source repository and grant this workflow package access before publication. Missing packages and denied or unavailable API responses block publication.',
    REGISTRY_PACKAGE_PUBLIC:
      'Image package is public. Publication is blocked; an administrator must prepare a new private package and review the namespace migration. Existing public packages cannot be made private.',
    REGISTRY_PACKAGE_NOT_PRIVATE:
      'Image package is not private. Publication is blocked until an administrator prepares a private package with repository workflow access.',
    REGISTRY_PACKAGE_UNBOUND:
      'Private image package is not linked to the exact source repository. An administrator must verify the package repository binding and workflow access before publication.',
  };
  throw new RegistryPrivacyError(code, messages[code]);
}

export function verifyPrivatePackage(expected, run = execute) {
  const packageName = packageRepository(expected).split('/').at(-1);
  const packagePath = `users/${expected.repository.split('/')[0]}/packages/container/${packageName}`;
  let metadata;
  try {
    const response = run('gh', [
      'api',
      packagePath,
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
    ]);
    if (typeof response !== 'string' || Buffer.byteLength(response) > 65536) throw new Error();
    metadata = JSON.parse(response);
  } catch {
    privacyFailure('REGISTRY_PACKAGE_UNVERIFIED');
  }
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    metadata.name !== packageName ||
    metadata.package_type !== 'container' ||
    !['private', 'public', 'internal'].includes(metadata.visibility)
  ) {
    privacyFailure('REGISTRY_PACKAGE_UNVERIFIED');
  }
  if (metadata.visibility === 'public') privacyFailure('REGISTRY_PACKAGE_PUBLIC');
  if (metadata.visibility !== 'private') privacyFailure('REGISTRY_PACKAGE_NOT_PRIVATE');
  if (
    !POSITIVE_ID.test(expected.repositoryId ?? '') ||
    !Number.isSafeInteger(metadata.repository?.id) ||
    metadata.repository.id < 1 ||
    String(metadata.repository.id) !== expected.repositoryId ||
    metadata.repository.full_name !== expected.repository
  )
    privacyFailure('REGISTRY_PACKAGE_UNBOUND');
  return metadata;
}

function inspect(run, ref) {
  return parseImageInspection(run('docker', ['image', 'inspect', ref]));
}

export function publishImage(record, expected, run = execute) {
  const identity = assertImageRecord(record, expected);
  assertImageInspection(inspect(run, identity.alias), {
    sha: expected.sha,
    imageId: record.image.imageId,
    sizeBytes: record.image.sizeBytes,
  });
  // FLAG: A 404, denied lookup or malformed metadata never authorizes first publication.
  // Existing private visibility and exact repository binding must be proved before any tag or push.
  verifyPrivatePackage(expected, run);
  const tag = `${identity.repository}:${expected.sha}`;
  run('docker', ['image', 'tag', identity.alias, tag]);
  run('docker', ['image', 'push', tag]);
  verifyPrivatePackage(expected, run);
  const digests = inspect(run, tag).RepoDigests;
  const matches = Array.isArray(digests)
    ? [...new Set(digests.filter((value) => value.startsWith(`${identity.repository}@`)))]
    : [];
  if (matches.length !== 1 || !DIGEST.test(matches[0].split('@')[1]))
    throw new Error('Registry did not return one exact image digest.');
  const reference = matches[0];
  // FLAG: Pull the registry subject and compare its Docker config ID with the smoke-tested image.
  // A registry manifest digest and a Docker image ID are different identities and must never be substituted.
  run('docker', ['image', 'pull', '--platform', 'linux/amd64', reference]);
  assertImageInspection(inspect(run, reference), {
    sha: expected.sha,
    imageId: record.image.imageId,
    sizeBytes: record.image.sizeBytes,
  });
  return {
    ...record,
    registry: { repository: identity.repository, digest: reference.split('@')[1] },
  };
}

export function verifyRegistryImage(record, expected, run = execute, { proofOnly = false } = {}) {
  const reference = assertRegistryRecord(record, expected);
  const repositoryId =
    expected.repositoryId ?? run('gh', ['api', `repos/${expected.repository}`, '--jq', '.id']);
  if (!POSITIVE_ID.test(repositoryId ?? '') || record.source.repositoryId !== repositoryId)
    throw new Error('Repository identity changed.');
  // FLAG: Valid historical signatures cannot authorize an image whose package is public now.
  verifyPrivatePackage({ ...expected, repositoryId }, run);
  for (const predicate of ['https://slsa.dev/provenance/v1', 'https://spdx.dev/Document']) {
    const results = JSON.parse(run('gh', provenanceArguments(record, expected, predicate)));
    assertVerifiedAttestation(results, record, { ...expected, repositoryId }, predicate);
  }
  if (!proofOnly) {
    run('docker', ['image', 'pull', '--platform', 'linux/amd64', reference]);
    assertImageInspection(inspect(run, reference), {
      sha: expected.sha,
      imageId: record.image.imageId,
      sizeBytes: record.image.sizeBytes,
    });
  }
  return reference;
}

function withRegistryLogin(env, action) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || execute('gh', ['auth', 'token'], { env });
  if (!isOpaqueGitHubCredential(token))
    throw new Error('A bounded registry credential is required.');
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ghcr-'));
  chmodSync(directory, 0o700);
  const childEnv = { ...env, GH_TOKEN: token, DOCKER_CONFIG: directory };
  try {
    const run = (binary, args, options = {}) =>
      execute(binary, args, { ...options, env: childEnv });
    const username = env.GITHUB_ACTOR || run('gh', ['api', 'user', '--jq', '.login']);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/u.test(username ?? ''))
      throw new Error('Invalid registry account.');
    // A private Docker config also authenticates gh's OCI client without requiring a local daemon.
    writeRecord(join(directory, 'config.json'), {
      auths: { 'ghcr.io': { auth: Buffer.from(`${username}:${token}`).toString('base64') } },
    });
    return action(run);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runRegistryImages(command, env = process.env) {
  if (command === 'record') {
    const source = trustedBuildContext(env);
    const component = env.MAXIM_IMAGE_COMPONENT;
    const identity = imageIdentity({ ...source, component });
    const inspection = inspect(execute, identity.alias);
    const imageId = assertImageInspection(inspection, source);
    writeRecord('maxim-image-record.json', {
      schemaVersion: 1,
      component,
      source,
      image: {
        alias: identity.alias,
        imageId,
        sizeBytes: inspection.Size,
        platform: 'linux/amd64',
      },
    });
  } else if (command === 'publish') {
    const source = trustedBuildContext(env);
    const expected = { ...source, component: env.MAXIM_IMAGE_COMPONENT };
    const record = readRecord('maxim-image-record.json');
    const published = withRegistryLogin(env, (run) => publishImage(record, expected, run));
    writeRecord(`registry-record-${expected.component}.json`, published);
    if (env.GITHUB_OUTPUT)
      appendFileSync(
        env.GITHUB_OUTPUT,
        `repository=${published.registry.repository}\ndigest=${published.registry.digest}\n`,
      );
  } else if (command === 'verify' || command === 'verify-proof') {
    const expected = env.MAXIM_RELEASE_SHA
      ? {
          repository: env.MAXIM_RELEASE_REPOSITORY,
          sha: env.MAXIM_RELEASE_SHA,
          component: env.MAXIM_IMAGE_COMPONENT,
        }
      : { ...trustedBuildContext(env), component: env.MAXIM_IMAGE_COMPONENT };
    const record = readRecord(
      env.MAXIM_IMAGE_RECORD_PATH || `registry-record-${expected.component}.json`,
    );
    assertRegistryRecord(record, expected);
    if (env.MAXIM_RELEASE_SHA) {
      execute(
        process.execPath,
        [
          'scripts/ci/assert-green.mjs',
          expected.sha,
          '--purpose',
          'production',
          '--run-id',
          record.source.runId,
          '--run-attempt',
          record.source.runAttempt,
        ],
        { env },
      );
    }
    withRegistryLogin(env, (run) =>
      verifyRegistryImage(record, expected, run, { proofOnly: command === 'verify-proof' }),
    );
    process.stdout.write(
      `Verified registry ${command === 'verify-proof' ? 'provenance and SBOM' : 'provenance, SBOM and tested image ID'} for ${record.image.alias}.\n`,
    );
  } else throw new Error('Expected record, publish, verify or verify-proof.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runRegistryImages(process.argv[2]);
  } catch (error) {
    process.stderr.write(`Registry image gate: ${error.message}\n`);
    process.exitCode = 1;
  }
}
