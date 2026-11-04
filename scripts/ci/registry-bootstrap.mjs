#!/usr/bin/env node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  imageIdentity,
  isOpaqueGitHubCredential,
  packageRepository,
  verifyPrivatePackage,
} from './registry-images.mjs';

export const BOOTSTRAP_WORKFLOW = '.github/workflows/registry-bootstrap.yml';
const REPOSITORY = 'GameclubPro/Major-Maksimov';
const REPOSITORY_ID = '1168895008';
const STAGES = new Set([
  'arguments',
  'context',
  'credential-shape',
  'auth',
  'login',
  'metadata-before',
  'seed-setup',
  'seed-build',
  'seed-push',
  'metadata-after',
  'seed-cleanup',
  'receipt',
  'auth-cleanup',
  'unknown',
]);
const PRIVACY_CODES = new Set([
  'REGISTRY_PACKAGE_UNVERIFIED',
  'REGISTRY_PACKAGE_PUBLIC',
  'REGISTRY_PACKAGE_NOT_PRIVATE',
  'REGISTRY_PACKAGE_UNBOUND',
]);
const CODES = new Set([...PRIVACY_CODES, 'REFUSED', 'DEPENDENCY_FAILED', 'UNVERIFIED', 'INTERNAL']);

function diagnosticCode(stage, error) {
  if (PRIVACY_CODES.has(error?.code)) return error.code;
  if (['arguments', 'context', 'credential-shape'].includes(stage)) return 'REFUSED';
  if (['login', 'seed-build', 'seed-push'].includes(stage)) return 'DEPENDENCY_FAILED';
  if (['metadata-before', 'metadata-after'].includes(stage)) return 'UNVERIFIED';
  return 'INTERNAL';
}

export function bootstrapFailureMessage(error) {
  // FLAG: Diagnostics render only fixed enums, never dependency messages or caller-supplied values.
  const stage = STAGES.has(error?.stage) ? error.stage : 'unknown';
  const code = CODES.has(error?.code) ? error.code : 'INTERNAL';
  const reason =
    code === 'REGISTRY_PACKAGE_PUBLIC'
      ? ': package is public; provision reviewed private targets locally'
      : '; private package admission did not pass';
  return `Registry bootstrap stopped${reason} (stage=${stage}, code=${code}).\n`;
}

function removeTemporaryDirectory(directory, onStage, stage) {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    // FLAG: Successful cleanup preserves the failed operation's stage; cleanup failure keeps its existing precedence.
    onStage(stage);
    throw error;
  }
}

export function bootstrapContext(env) {
  const expected = {
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    sha: env.GITHUB_SHA,
    component: env.MAXIM_IMAGE_COMPONENT,
  };
  imageIdentity(expected);
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${BOOTSTRAP_WORKFLOW}@refs/heads/main` ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? '')
  ) {
    throw new Error(
      'Registry bootstrap requires its explicit trusted main workflow on a GitHub-hosted runner.',
    );
  }
  return expected;
}

export function seedDockerfile() {
  // FLAG: Bootstrap may send only this inert scratch config. It never reads the source checkout,
  // uses an application archive, copies files, runs code or tags a source-SHA/runtime alias.
  return `FROM scratch\nLABEL org.opencontainers.image.source="https://github.com/${REPOSITORY}"\nLABEL com.maxim.registry-bootstrap="private-seed-v1"\n`;
}

function verifiedMetadata(expected, response) {
  if (response?.status !== 200)
    throw new Error(
      'Private bootstrap package metadata remains unavailable; application publication is blocked.',
    );
  verifyPrivatePackage(expected, () => JSON.stringify(response.body));
}

export async function bootstrapPrivatePackage(
  expected,
  { getPackage, run, temporaryRoot = tmpdir(), onStage = () => {} },
) {
  const identity = { repository: packageRepository(expected) };
  onStage('metadata-before');
  const before = await getPackage(identity.repository.split('/').at(-1));
  if (before?.status === 200) {
    verifiedMetadata(expected, before);
    return {
      schemaVersion: 1,
      component: expected.component,
      package: identity.repository,
      action: 'ALREADY_PRIVATE',
      visibility: 'private',
    };
  }
  if (before?.status !== 404)
    throw new Error(
      'Bootstrap metadata lookup was denied or unavailable; no registry write is permitted.',
    );
  onStage('seed-setup');
  const directory = mkdtempSync(join(temporaryRoot, 'maxim-inert-registry-seed-'));
  chmodSync(directory, 0o700);
  const reference = `${identity.repository}:bootstrap-private-v1`;
  try {
    writeFileSync(join(directory, 'Dockerfile'), seedDockerfile(), { flag: 'wx', mode: 0o600 });
    onStage('seed-build');
    run('docker', ['build', '--no-cache', '--network=none', '--tag', reference, directory]);
    onStage('seed-push');
    run('docker', ['image', 'push', reference]);
    // FLAG: A seed is never a release image. Even a successful push authorizes no application
    // publication until full private metadata and exact repository binding are proved afterward.
    onStage('metadata-after');
    verifiedMetadata(expected, await getPackage(identity.repository.split('/').at(-1)));
    return {
      schemaVersion: 1,
      component: expected.component,
      package: identity.repository,
      action: 'PRIVATE_SEED_VERIFIED',
      visibility: 'private',
    };
  } finally {
    removeTemporaryDirectory(directory, onStage, 'seed-cleanup');
  }
}

async function executeBootstrap(
  env,
  argv,
  { request = fetch, writeReceipt = writeFileSync },
  onStage,
) {
  if (argv.length)
    throw new Error('Registry access verification accepts no command-line overrides.');
  onStage('context');
  const expected = bootstrapContext(env);
  onStage('credential-shape');
  const token = env.GH_TOKEN;
  if (!isOpaqueGitHubCredential(token))
    throw new Error('The isolated workflow package credential is required.');
  // FLAG: GITHUB_TOKEN created packages inherit a public workflow repository's
  // visibility. This workflow only proves access to already-private packages;
  // even a 404 must never trigger Docker login, seed creation or a registry write.
  onStage('metadata-before');
  const repository = packageRepository(expected);
  const packageName = repository.split('/').at(-1);
  const response = await request(
    `https://api.github.com/users/GameclubPro/packages/container/${packageName}`,
    {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('Package metadata response exceeded its bound.');
    chunks.push(chunk);
  }
  let body = null;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    /* Invalid metadata cannot prove access. */
  }
  verifiedMetadata(expected, { status: response.status, body });
  const result = {
    schemaVersion: 1,
    component: expected.component,
    package: repository,
    action: 'WORKFLOW_ACCESS_VERIFIED',
    visibility: 'private',
  };
  onStage('receipt');
  writeReceipt(
    `registry-bootstrap-${expected.component}.json`,
    `${JSON.stringify({ ...result, sourceSha: expected.sha, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT })}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return result;
}

export async function runBootstrap(
  env = process.env,
  argv = process.argv.slice(2),
  dependencies = {},
) {
  let stage = 'arguments';
  try {
    return await executeBootstrap(env, argv, dependencies, (next) => {
      stage = next;
    });
  } catch (error) {
    const diagnostic = new Error('Registry bootstrap admission failed.');
    diagnostic.stage = STAGES.has(stage) ? stage : 'unknown';
    diagnostic.code = diagnosticCode(diagnostic.stage, error);
    throw diagnostic;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runBootstrap())}\n`);
  } catch (error) {
    // FLAG: Never print a fetch error, Docker response, token or caller-supplied content.
    process.stderr.write(bootstrapFailureMessage(error));
    process.exitCode = 1;
  }
}
