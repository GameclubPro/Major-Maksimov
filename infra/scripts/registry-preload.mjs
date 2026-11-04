#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createGitHubClient,
  GREEN_WORKFLOWS,
  listComplete,
  proveGreenWorkflow,
  proveGreenWorkflows,
} from '../../scripts/ci/green-workflow-proof.mjs';
import { readSingleJsonZip } from '../../scripts/ci/main-baseline.mjs';
import { assertRegistryRecord } from '../../scripts/ci/registry-images.mjs';
import {
  registryArtifactName,
  RELEASE_REPOSITORY,
  RELEASE_REPOSITORY_ID,
} from './registry-preload-host.mjs';

export class MissingRegistryImageError extends Error {}
const workflow = GREEN_WORKFLOWS[0];
const SHA = /^[a-f0-9]{40}$/u;

export function trustedPublicationRun(run, sha) {
  return (
    run.workflow_id === workflow.id &&
    run.path === workflow.path &&
    run.head_sha === sha &&
    run.head_branch === 'main' &&
    ['push', 'workflow_dispatch'].includes(run.event) &&
    run.repository?.full_name === RELEASE_REPOSITORY &&
    String(run.repository?.id) === RELEASE_REPOSITORY_ID &&
    run.head_repository?.full_name === RELEASE_REPOSITORY &&
    String(run.head_repository?.id) === RELEASE_REPOSITORY_ID &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0
  );
}

export function findRegistryArtifact({ github, sha, component }) {
  if (!SHA.test(sha ?? '') || !['api', 'miniapp', 'admin', 'eraser'].includes(component))
    throw new Error('Expected an exact image component and source SHA.');
  proveGreenWorkflows({ github, sha, purpose: 'production' });
  const runs = listComplete(
    github,
    `repos/${RELEASE_REPOSITORY}/actions/workflows/${workflow.id}/runs?head_sha=${sha}`,
    'workflow_runs',
  )
    .filter((run) => trustedPublicationRun(run, sha))
    .sort((left, right) => right.id - left.id);
  for (const candidate of runs) {
    const recordIdentity = {
      component,
      source: { sha, runId: String(candidate.id), runAttempt: String(candidate.run_attempt) },
    };
    const name = registryArtifactName(recordIdentity);
    const artifacts = listComplete(
      github,
      `repos/${RELEASE_REPOSITORY}/actions/runs/${candidate.id}/artifacts`,
      'artifacts',
    );
    const matches = artifacts.filter((artifact) => artifact.name === name);
    if (matches.length > 1) throw new Error('Duplicate immutable registry record artifacts.');
    if (!matches.length || matches[0].expired) continue;
    const artifact = matches[0];
    // FLAG: A record from a previous attempt cannot borrow a later green Required result.
    proveGreenWorkflow({
      github,
      sha,
      workflow,
      purpose: 'publication',
      expectedRun: { id: candidate.id, attempt: candidate.run_attempt },
    });
    if (
      artifact.workflow_run?.id !== candidate.id ||
      artifact.workflow_run?.head_sha !== sha ||
      artifact.workflow_run?.head_branch !== 'main' ||
      String(artifact.workflow_run?.repository_id) !== RELEASE_REPOSITORY_ID ||
      String(artifact.workflow_run?.head_repository_id) !== RELEASE_REPOSITORY_ID ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '') ||
      artifact.size_in_bytes > 1024 * 1024
    ) {
      throw new Error('Registry record artifact is not bound to the trusted main invocation.');
    }
    const archive = github.binary(
      `repos/${RELEASE_REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    );
    if (`sha256:${createHash('sha256').update(archive).digest('hex')}` !== artifact.digest)
      throw new Error('Registry artifact checksum mismatch.');
    const record = readSingleJsonZip(archive, `registry-record-${component}.json`);
    assertRegistryRecord(record, {
      repository: RELEASE_REPOSITORY,
      sha,
      component,
      runId: String(candidate.id),
      runAttempt: String(candidate.run_attempt),
    });
    if (record.source.event !== candidate.event)
      throw new Error('Registry record trigger differs from the publication workflow.');
    return { record, artifact: { id: artifact.id, name, digest: artifact.digest } };
  }
  throw new MissingRegistryImageError(
    `No current-attempt registry record for ${component}@${sha}; prepare the exact current main in CI before deployment.`,
  );
}

export function assertCurrentMain(github, sha) {
  if (github.json(`repos/${RELEASE_REPOSITORY}/git/ref/heads/main`)?.object?.sha !== sha) {
    throw new Error(
      'The release candidate is no longer the exact remote main; replan before preparing or changing runtime.',
    );
  }
}

function writePreparation(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  const directory = openSync(resolve(path, '..'), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function parseImagePreparationPlan(output, sha) {
  if (!SHA.test(sha ?? '') || typeof output !== 'string' || Buffer.byteLength(output) > 1024 * 1024)
    throw new Error('Invalid image preparation plan output.');
  const lines = output.split('\n').filter((line) => line.startsWith('MAXIM_IMAGE_PLAN='));
  if (lines.length !== 1) throw new Error('Expected exactly one complete image preparation plan.');
  const value = JSON.parse(lines[0].slice('MAXIM_IMAGE_PLAN='.length));
  const allowed = ['api-shared', 'miniapp-major-static', 'admin-static', 'eraser'];
  if (
    value.schemaVersion !== 1 ||
    value.sourceSha !== sha ||
    !Array.isArray(value.components) ||
    value.components.length > 4 ||
    value.components.some((component) => !allowed.includes(component)) ||
    new Set(value.components).size !== value.components.length
  )
    throw new Error(
      'Image preparation plan source or components differ from the selected release.',
    );
  return value.components;
}

// One durable correlation ID is reused after an interrupted dispatch or observer.
// An unknown dispatch result is looked up by that ID, never submitted again.
export async function prepareMissingImages({
  github,
  sha,
  directory = join(homedir(), '.local/state/maxim-release-preparation'),
  dispatch = (id) =>
    execFileSync(
      'gh',
      [
        'workflow',
        'run',
        'ci.yml',
        '--repo',
        RELEASE_REPOSITORY,
        '--ref',
        'main',
        '--field',
        `release_preparation_id=${id}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 },
    ),
  now = Date.now,
  pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  progress = (value) => process.stderr.write(`${value}\n`),
}) {
  assertCurrentMain(github, sha);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.mode & 0o077 ||
    directoryStat.uid !== process.getuid()
  ) {
    throw new Error('Unsafe local release preparation state directory.');
  }
  const path = join(directory, `${sha}.json`);
  let state;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid() ||
      stat.size > 4096
    )
      throw new Error('Unsafe release preparation state.');
    state = JSON.parse(readFileSync(path, 'utf8'));
    if (
      state.sha !== sha ||
      !/^[a-f0-9-]{36}$/u.test(state.id ?? '') ||
      !Number.isFinite(state.startedAt)
    )
      throw new Error('Invalid release preparation identity.');
  } else {
    state = {
      schemaVersion: 1,
      sha,
      id: randomUUID(),
      startedAt: now(),
      deadline: now() + 45 * 60_000,
      dispatch: 'unknown',
      status: 'dispatch_unknown',
      runId: null,
      heartbeatAt: new Date(now()).toISOString(),
      lastSuccessfulObservationAt: null,
      lastError: null,
    };
    // Exclusive creation prevents concurrent callers from launching two preparations.
    const descriptor = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    // FLAG: Persist the directory entry as well as the request bytes before any external dispatch.
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    try {
      dispatch(state.id);
      state.dispatch = 'accepted';
    } catch {
      state.dispatch = 'unknown';
    }
    writePreparation(path, state);
  }
  const deadline = state.deadline ?? state.startedAt + 45 * 60_000;
  let lastProgress = 0;
  while (now() < deadline) {
    let runs;
    try {
      assertCurrentMain(github, sha);
      runs = listComplete(
        github,
        `repos/${RELEASE_REPOSITORY}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=workflow_dispatch`,
        'workflow_runs',
      );
      state.heartbeatAt = new Date(now()).toISOString();
      state.lastSuccessfulObservationAt = state.heartbeatAt;
      state.lastError = null;
    } catch (error) {
      state.heartbeatAt = new Date(now()).toISOString();
      state.status = 'observation_missing';
      state.lastError = 'GitHub observation failed or candidate changed; runtime was not started.';
      writePreparation(path, state);
      throw error;
    }
    const matching = runs.filter(
      (candidate) =>
        trustedPublicationRun(candidate, sha) &&
        candidate.event === 'workflow_dispatch' &&
        candidate.display_title === `MAXIM image preparation ${state.id}`,
    );
    if (matching.length > 1)
      throw new Error('Ambiguous release preparation correlation; inspect the saved operation.');
    if (matching.length === 1) {
      const candidate = matching[0];
      if (state.runId && state.runId !== candidate.id)
        throw new Error('Release preparation invocation changed.');
      state.runId = candidate.id;
      state.runAttempt = candidate.run_attempt;
      state.status = `${candidate.status}/${candidate.conclusion ?? 'pending'}`;
      writePreparation(path, state);
      if (candidate.status === 'completed') {
        if (candidate.conclusion !== 'success')
          throw new Error(
            `Image preparation ${candidate.id}/${candidate.run_attempt} ended ${candidate.conclusion}; no deployment was started.`,
          );
        assertCurrentMain(github, sha);
        proveGreenWorkflow({
          github,
          sha,
          workflow,
          purpose: 'publication',
          expectedRun: { id: candidate.id, attempt: candidate.run_attempt },
        });
        return state;
      }
    } else {
      state.status = 'invocation_not_observed';
      writePreparation(path, state);
    }
    if (now() - lastProgress >= 30000) {
      progress(
        `Waiting for image preparation ${state.id}: run=${state.runId ?? 'not yet observed'}, deadline=${new Date(deadline).toISOString()}.`,
      );
      lastProgress = now();
    }
    await pause(10000);
    // A fresh client has a bounded per-observation budget; one client cannot outlive its 90s collection deadline.
    if (github.fresh) github = github.fresh();
  }
  state.heartbeatAt = new Date(now()).toISOString();
  state.status = 'observation_deadline';
  state.lastError =
    'Observation deadline reached; saved invocation must be resumed without another dispatch.';
  writePreparation(path, state);
  throw new Error(
    `Image preparation observation deadline reached; saved operation ${state.id}, run ${state.runId ?? 'unknown'}. Resume this operation instead of dispatching again.`,
  );
}

function credentialFailure() {
  const error = new Error(
    'Invalid private GHCR evidence credential file. Provide a private 0600 regular file with a valid username and read:packages token.',
  );
  error.code = 'REGISTRY_CREDENTIAL_INVALID';
  throw error;
}

export function proofCredentialFile(env = process.env, userDirectory = homedir()) {
  if (Object.hasOwn(env, 'MAXIM_GHCR_READ_CREDENTIAL_FILE')) {
    if (
      typeof env.MAXIM_GHCR_READ_CREDENTIAL_FILE !== 'string' ||
      !env.MAXIM_GHCR_READ_CREDENTIAL_FILE.trim()
    )
      credentialFailure();
    return env.MAXIM_GHCR_READ_CREDENTIAL_FILE;
  }
  const path = join(userDirectory, '.config/maxim-delivery/ghcr-read.json');
  try {
    lstatSync(path);
    return path;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    credentialFailure();
  }
}

function readProofCredential(path) {
  let descriptor;
  try {
    if (typeof path !== 'string' || !path) credentialFailure();
    const before = lstatSync(path);
    const safe = (stat) =>
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600 &&
      [0, process.getuid()].includes(stat.uid) &&
      stat.size > 0 &&
      stat.size <= 4096;
    if (!safe(before)) credentialFailure();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !safe(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      credentialFailure();
    const buffer = Buffer.alloc(opened.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes !== opened.size) credentialFailure();
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)),
    );
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'token,username' ||
      typeof value.username !== 'string' ||
      value.username.trim() !== value.username ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(value.username) ||
      typeof value.token !== 'string' ||
      value.token.length < 20 ||
      value.token.length > 255 ||
      /[^A-Za-z0-9_]/u.test(value.token)
    )
      credentialFailure();
    return value;
  } catch {
    credentialFailure();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function verifyPreloadProof(
  value,
  { sha, component, execute = execFileSync, credentialFile = proofCredentialFile() },
) {
  const credential = credentialFile === null ? null : readProofCredential(credentialFile);
  const proofEnv = { ...process.env };
  if (credential !== null) {
    // FLAG: The registry evidence child receives the narrow package credential only;
    // the caller's GitHub control client and its environment retain their own identity.
    delete proofEnv.GITHUB_TOKEN;
    delete proofEnv.GH_ENTERPRISE_TOKEN;
    delete proofEnv.GITHUB_ENTERPRISE_TOKEN;
    proofEnv.GH_TOKEN = credential.token;
    proofEnv.GITHUB_ACTOR = credential.username;
  }
  const directory = mkdtempSync(join(tmpdir(), 'maxim-registry-proof-'));
  try {
    const path = join(directory, 'record.json');
    writeFileSync(path, `${JSON.stringify(value.record)}\n`, { mode: 0o600 });
    try {
      execute(process.execPath, ['scripts/ci/registry-images.mjs', 'verify-proof'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5 * 60_000,
        env: {
          ...proofEnv,
          MAXIM_RELEASE_REPOSITORY: RELEASE_REPOSITORY,
          MAXIM_RELEASE_SHA: sha,
          MAXIM_IMAGE_COMPONENT: component,
          MAXIM_IMAGE_RECORD_PATH: path,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      const error = new Error(
        'Private registry proof verification failed. Check package visibility, credential access and exact image evidence.',
      );
      error.code = 'REGISTRY_PROOF_FAILED';
      throw error;
    }
    return { schemaVersion: 1, ...value, verifiedAt: new Date().toISOString() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [component, sha, option] = process.argv.slice(2);
    if (component === 'plan') {
      // FLAG: Decode only after the complete pipe is buffered, preserving the operational stdin invariant.
      const components = parseImagePreparationPlan(readFileSync(0).toString('utf8'), sha);
      if (components.length) process.stdout.write(`${components.join('\n')}\n`);
      process.exitCode = 0;
    } else {
      if (option && option !== '--prepare-missing')
        throw new Error('Expected component SHA [--prepare-missing].');
      const fresh = () => ({ ...createGitHubClient(), fresh });
      let github = fresh();
      let value;
      try {
        value = findRegistryArtifact({ github, sha, component });
      } catch (error) {
        if (!(error instanceof MissingRegistryImageError) || option !== '--prepare-missing')
          throw error;
        await prepareMissingImages({ github: fresh(), sha });
        github = fresh();
        value = findRegistryArtifact({ github, sha, component });
      }
      process.stdout.write(`${JSON.stringify(verifyPreloadProof(value, { sha, component }))}\n`);
    }
  } catch (error) {
    process.stderr.write(`Registry delivery: ${error.message}\n`);
    process.exitCode = 1;
  }
}
