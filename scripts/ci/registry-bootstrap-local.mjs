#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapPrivatePackage } from './registry-bootstrap.mjs';
import { readRegistryCredential } from './registry-credentials.mjs';
import { packageRepository } from './registry-images.mjs';

const REPOSITORY = 'GameclubPro/Major-Maksimov';
const REPOSITORY_ID = 1168895008;
const OWNER = 'GameclubPro';
const COMPONENTS = new Set(['api', 'miniapp', 'admin', 'eraser']);
const STAGES = new Set([
  'arguments',
  'context',
  'credential',
  'owner-proof',
  'repository-proof',
  'metadata-before',
  'auth',
  'login',
  'seed-setup',
  'seed-build',
  'seed-push',
  'metadata-after',
  'seed-cleanup',
  'auth-cleanup',
  'result',
  'unknown',
]);
const PRIVACY_CODES = new Set([
  'REGISTRY_PACKAGE_UNVERIFIED',
  'REGISTRY_PACKAGE_PUBLIC',
  'REGISTRY_PACKAGE_NOT_PRIVATE',
  'REGISTRY_PACKAGE_UNBOUND',
]);
const CODES = new Set([
  ...PRIVACY_CODES,
  'REGISTRY_CREDENTIAL_INVALID',
  'REFUSED',
  'IDENTITY_UNVERIFIED',
  'DEPENDENCY_FAILED',
  'UNVERIFIED',
  'INTERNAL',
]);

export function parseLocalBootstrapArguments(argv) {
  const options = { apply: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error('Invalid local bootstrap arguments.');
    seen.add(argument);
    if (argument === '--apply') options.apply = true;
    else if (argument === '--component' || argument === '--credential-file') {
      const value = argv[++index];
      if (typeof value !== 'string' || value.startsWith('--'))
        throw new Error('Invalid local bootstrap arguments.');
      options[argument === '--component' ? 'component' : 'credentialFile'] = value;
    } else throw new Error('Invalid local bootstrap arguments.');
  }
  if (!COMPONENTS.has(options.component) || !isAbsolute(options.credentialFile ?? ''))
    throw new Error('Invalid local bootstrap arguments.');
  return options;
}

function diagnosticCode(stage, error) {
  if (PRIVACY_CODES.has(error?.code)) return error.code;
  if (stage === 'credential') return 'REGISTRY_CREDENTIAL_INVALID';
  if (stage === 'arguments' || stage === 'context') return 'REFUSED';
  if (stage === 'owner-proof' || stage === 'repository-proof') return 'IDENTITY_UNVERIFIED';
  if (stage === 'metadata-before' || stage === 'metadata-after') return 'UNVERIFIED';
  if (['login', 'seed-build', 'seed-push'].includes(stage)) return 'DEPENDENCY_FAILED';
  return 'INTERNAL';
}

export function localBootstrapFailureMessage(error) {
  // FLAG: Only fixed diagnostic enums cross the CLI boundary, never credential or dependency content.
  const stage = STAGES.has(error?.stage) ? error.stage : 'unknown';
  const code = CODES.has(error?.code) ? error.code : 'INTERNAL';
  return `Local registry bootstrap stopped (stage=${stage}, code=${code}).\n`;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function removeAuthDirectory(path, removeDirectory, onFailure) {
  try {
    removeDirectory(path, { recursive: true, force: true });
  } catch {
    onFailure();
    throw new Error('Local bootstrap auth cleanup failed.');
  }
}

export async function runLocalBootstrap(
  env = process.env,
  argv = process.argv.slice(2),
  {
    request = fetch,
    execute = execFileSync,
    readCredential = readRegistryCredential,
    removeDirectory = rmSync,
    temporaryRoot = tmpdir(),
  } = {},
) {
  let stage = 'arguments';
  try {
    const options = parseLocalBootstrapArguments(argv);
    stage = 'context';
    if (Object.hasOwn(env, 'GITHUB_ACTIONS'))
      throw new Error('Local provisioning cannot run in GitHub Actions.');
    const expected = {
      repository: REPOSITORY,
      repositoryId: String(REPOSITORY_ID),
      component: options.component,
    };
    const target = packageRepository(expected);
    if (!options.apply) {
      // FLAG: Preview performs no credential reads, subprocesses or network requests.
      return {
        schemaVersion: 1,
        mode: 'PREVIEW',
        component: options.component,
        package: target,
        action: 'CREATE_INERT_PRIVATE_SEED_IF_MISSING',
        writes: false,
        workflowAccess: 'UNVERIFIED',
      };
    }
    stage = 'credential';
    const credential = readCredential(options.credentialFile);
    if (credential.username !== OWNER)
      throw new Error('The namespace owner credential is required.');
    let requests = 0;
    const readApi = async (path) => {
      if (++requests > 4) throw new Error('Local bootstrap API budget exceeded.');
      const response = await request(`https://api.github.com/${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${credential.token}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        if (bytes > 65536) throw new Error('Local bootstrap API response exceeded its bound.');
        chunks.push(chunk);
      }
      let body = null;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        // FLAG: Malformed metadata remains unproved; JSON diagnostics may quote credential content.
      }
      return { status: response.status, body };
    };
    stage = 'owner-proof';
    const user = await readApi('user');
    if (
      user.status !== 200 ||
      !object(user.body) ||
      user.body.login !== OWNER ||
      user.body.type !== 'User' ||
      !Number.isSafeInteger(user.body.id) ||
      user.body.id < 1
    )
      throw new Error('Namespace owner identity remains unproved.');
    stage = 'repository-proof';
    const repository = await readApi(`repos/${REPOSITORY}`);
    if (
      repository.status !== 200 ||
      !object(repository.body) ||
      repository.body.id !== REPOSITORY_ID ||
      repository.body.full_name !== REPOSITORY ||
      repository.body.owner?.id !== user.body.id ||
      repository.body.owner?.login !== OWNER ||
      repository.body.owner?.type !== 'User'
    )
      throw new Error('Source repository ownership remains unproved.');
    stage = 'auth';
    const auth = mkdtempSync(join(temporaryRoot, 'maxim-local-registry-auth-'));
    try {
      chmodSync(auth, 0o700);
      // FLAG: Docker receives only this allowlist. Caller tokens, control auth and user Docker settings are excluded.
      const childEnv = {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        DOCKER_CONFIG: auth,
        DOCKER_BUILDKIT: '1',
      };
      const runDocker = (args, input) =>
        execute('docker', args, {
          env: childEnv,
          input,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      let loggedIn = false;
      const result = await bootstrapPrivatePackage(expected, {
        temporaryRoot,
        onStage(next) {
          stage = STAGES.has(next) ? next : 'unknown';
        },
        getPackage(name) {
          if (name !== target.split('/').at(-1))
            throw new Error('Local bootstrap target identity refused.');
          return readApi(`users/${OWNER}/packages/container/${name}`);
        },
        run(binary, args) {
          if (binary !== 'docker') throw new Error('Local bootstrap dependency refused.');
          if (!loggedIn) {
            const commandStage = stage;
            stage = 'login';
            runDocker(
              ['login', 'ghcr.io', '--username', OWNER, '--password-stdin'],
              credential.token,
            );
            loggedIn = true;
            stage = commandStage;
          }
          return runDocker(args);
        },
      });
      stage = 'result';
      if (!['ALREADY_PRIVATE', 'PRIVATE_SEED_VERIFIED'].includes(result.action))
        throw new Error('Local bootstrap result remains unproved.');
      return {
        schemaVersion: 1,
        mode: 'APPLIED',
        component: options.component,
        package: target,
        action: result.action,
        visibility: 'private',
        workflowAccess: 'UNVERIFIED',
      };
    } finally {
      removeAuthDirectory(auth, removeDirectory, () => {
        stage = 'auth-cleanup';
      });
    }
  } catch (error) {
    const diagnostic = new Error('Local registry bootstrap admission failed.');
    diagnostic.stage = STAGES.has(stage) ? stage : 'unknown';
    diagnostic.code = diagnosticCode(diagnostic.stage, error);
    throw diagnostic;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runLocalBootstrap())}\n`);
  } catch (error) {
    process.stderr.write(localBootstrapFailureMessage(error));
    process.exitCode = 1;
  }
}
