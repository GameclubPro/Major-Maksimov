#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OperationStore, requestHash } from './release-operation-store.mjs';
import { readPolicy } from './release-service-policy.mjs';
import { assertExecutorStopped } from './release-service-recovery.mjs';
import { assertReleaseLocks } from './release-service-locks.mjs';
import { validateCompleteReleaseManifest } from './release-manifest.mjs';
import {
  assertCurrentMain,
  findRegistryArtifact,
  parseImagePreparationPlan,
} from './registry-preload.mjs';
import { preloadRegistryImage, verifyPreloadedImage } from './registry-preload-host.mjs';
import { proveGreenWorkflows } from '../../scripts/ci/green-workflow-proof.mjs';
import { assertImageInspection, verifyRegistryImage } from '../../scripts/ci/registry-images.mjs';
import { readRegistryCredential } from '../../scripts/ci/registry-credentials.mjs';
import { ensureGitHubCli } from '../../scripts/ci/github-cli.mjs';
import {
  RELEASE_PATHS,
  UUID,
  HASH,
  COMPONENTS,
  cleanEnvironment,
  assertDirectory,
  privateBytes,
  writePrivateJson,
  stableJson,
  sha256,
  refuse,
} from './release-service-boundary.mjs';

const MAX_CONTEXT_AGE = 15 * 60_000;
const equal = (a, b) => stableJson(a) === stableJson(b);

function execute(binary, args, options = {}) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 4 * 1024 ** 2,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnvironment(),
      ...options,
    });
  } catch {
    refuse('DEPENDENCY_UNPROVED');
  }
}

function identity(id, hash, paths = RELEASE_PATHS) {
  if (!UUID.test(id ?? '') || !HASH.test(hash ?? '')) refuse('INVALID_IDENTITY');
  const directory = join(paths.executors, id);
  const root = join(directory, 'source');
  const store = new OperationStore({ directory: join(paths.state, 'operations') });
  const request = store.readRequest(id);
  if (requestHash(request) !== hash) refuse('REQUEST_CONFLICT');
  return { id, hash, directory, root, request, summary: store.get(id) };
}

function manifestSnapshot(paths = RELEASE_PATHS) {
  const path = join(paths.manifestState, 'current.json');
  const stat = fs.lstatSync(path);
  assertDirectory(dirname(path));
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.mode & 0o022 ||
    ![0, process.getuid()].includes(stat.uid) ||
    stat.size > 1024 ** 2
  )
    refuse('MANIFEST_UNPROVED');
  const bytes = fs.readFileSync(path);
  const manifest = validateCompleteReleaseManifest(JSON.parse(bytes));
  return { sha256: sha256(bytes), manifest };
}

export function assertServicePolicy(policy, request) {
  if (policy.paused !== false) refuse('SERVICE_PAUSED');
  if (request.trigger === 'automatic' && policy.autoEnabled !== true) refuse('AUTOMATIC_DISABLED');
}

function assertPolicy(request, paths = RELEASE_PATHS) {
  assertServicePolicy(readPolicy({ directory: paths.state }), request);
}

export function assertServiceOrigin(origin) {
  if (
    ![
      'https://github.com/GameclubPro/Major-Maksimov.git',
      'git@github.com:GameclubPro/Major-Maksimov.git',
      'ssh://git@github.com/GameclubPro/Major-Maksimov.git',
      'ssh://git@ssh.github.com:443/GameclubPro/Major-Maksimov.git',
    ].includes(origin)
  )
    refuse('GIT_ORIGIN_UNPROVED');
}

// FLAG: Public requests are claims. Only fresh server-collected metadata and verified signatures
// may authorize a pull or the later READY boundary. The operator's control token is never used.
export function verifyRequestEvidence(request, { github, verifyImage, now = Date.now() }) {
  requireCurrentMain(github, request.sourceSha);
  proveGreenWorkflows({ github, sha: request.sourceSha, purpose: 'production' });
  const images = [];
  for (const supplied of request.images) {
    const found = findRegistryArtifact({
      github,
      sha: request.sourceSha,
      component: supplied.record.component,
    });
    if (!equal(found.record, supplied.record) || !equal(found.artifact, supplied.artifact))
      refuse('IMAGE_EVIDENCE_CHANGED');
    verifyImage(found.record, {
      repository: 'GameclubPro/Major-Maksimov',
      sha: request.sourceSha,
      component: found.record.component,
    });
    images.push({ schemaVersion: 1, ...found, verifiedAt: new Date(now).toISOString() });
  }
  return images;
}

function requireCurrentMain(github, sha) {
  const current = github.json('repos/GameclubPro/Major-Maksimov/git/ref/heads/main')?.object?.sha;
  if (!/^[a-f0-9]{40}$/u.test(current ?? '')) refuse('MAIN_UNPROVED');
  if (current !== sha) refuse('SUPERSEDED');
  assertCurrentMain(github, sha);
}

export function readServiceCredential(path = RELEASE_PATHS.credential, { floor = '/' } = {}) {
  try {
    assertDirectory(dirname(path), { floor });
    return readRegistryCredential(path);
  } catch {
    refuse('CREDENTIAL_UNAVAILABLE');
  }
}

function withEvidence(action) {
  const credential = readServiceCredential();
  const config = fs.mkdtempSync('/var/lib/maxim-release/evidence-');
  try {
    fs.chmodSync(config, 0o700);
    const env = {
      ...cleanEnvironment(),
      GH_TOKEN: credential.token,
      GH_CONFIG_DIR: config,
      DOCKER_CONFIG: config,
    };
    writePrivateJson(join(config, 'config.json'), {
      auths: {
        'ghcr.io': {
          auth: Buffer.from(`${credential.username}:${credential.token}`).toString('base64'),
        },
      },
    });
    const gh = ensureGitHubCli(env);
    let calls = 0;
    const deadline = Date.now() + 8 * 60_000;
    const run = (binary, args) => {
      if (++calls > 256 || Date.now() >= deadline) refuse('EVIDENCE_BUDGET');
      return execute(binary === 'gh' ? gh : binary, args, {
        env,
        timeout: Math.min(60_000, Math.max(1, deadline - Date.now())),
      }).trim();
    };
    const github = {
      json: (endpoint) => JSON.parse(run('gh', ['api', '--method', 'GET', endpoint])),
      binary: (endpoint) => {
        if (++calls > 256 || Date.now() >= deadline) refuse('EVIDENCE_BUDGET');
        return execute(gh, ['api', '--method', 'GET', endpoint], {
          env,
          encoding: undefined,
          timeout: Math.min(15000, Math.max(1, deadline - Date.now())),
          maxBuffer: 1024 ** 2,
        });
      },
    };
    return action({
      github,
      verifyImage: (record, expected) =>
        verifyRegistryImage(record, expected, run, { proofOnly: true }),
    });
  } finally {
    fs.rmSync(config, { recursive: true, force: true });
  }
}

export function evaluateAdmission({
  request,
  hash,
  context,
  plan,
  manifest,
  envHash,
  now = Date.now(),
}) {
  if (
    requestHash(request) !== hash ||
    context.schemaVersion !== 1 ||
    context.id !== request.id ||
    context.requestHash !== hash ||
    context.sourceSha !== request.sourceSha
  )
    refuse('CONTEXT_CONFLICT');
  const age = now - Date.parse(context.preparedAt);
  if (!Number.isFinite(age) || age < -120_000 || age > MAX_CONTEXT_AGE) refuse('CONTEXT_EXPIRED');
  if (
    context.envSha256 !== envHash ||
    context.manifestSha256 !== manifest.sha256 ||
    request.expectedManifestSha256 !== manifest.sha256 ||
    !equal(context.previousManifest, manifest.manifest)
  )
    refuse('SNAPSHOT_CHANGED');
  if (!equal(context.components, plan.components)) refuse('COMPONENT_PLAN_CHANGED');
  if (!Array.isArray(context.images) || !Array.isArray(context.components))
    refuse('INVALID_CONTEXT');
  for (const component of context.components) {
    const proof = context.images.find((image) => COMPONENTS[image.record.component] === component);
    if (
      !proof ||
      !request.images.some(
        (image) => equal(image.record, proof.record) && equal(image.artifact, proof.artifact),
      )
    )
      refuse('IMAGE_COVERAGE_MISSING');
  }
  if (
    context.images.length !== context.components.length ||
    request.images.length !== context.components.length
  )
    refuse('IMAGE_COVERAGE_EXCESS');
  return context;
}

function readContext(operation) {
  return JSON.parse(privateBytes(join(operation.directory, 'context.json')));
}
function readEnvironment(path) {
  return privateBytes(join(path, '.env'));
}
function assertLocked() {
  assertReleaseLocks();
}

function verifySource(root, sha) {
  assertDirectory(root);
  const git = (args) =>
    execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root }).trim();
  if (
    git(['rev-parse', '--verify', 'HEAD']) !== sha ||
    git(['status', '--porcelain', '--untracked-files=no'])
  )
    refuse('EXECUTOR_SOURCE_CHANGED');
  try {
    execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], {
      cwd: root,
      env: cleanEnvironment(),
      stdio: 'ignore',
    });
  } catch (error) {
    if (error.status === 1) return;
    refuse('EXECUTOR_SOURCE_CHANGED');
  }
  refuse('EXECUTOR_NOT_DETACHED');
}

function snapshot(operation) {
  assertLocked();
  assertPolicy(operation.request);
  if (operation.summary.state !== 'ADMITTING') refuse('STALE_STATE');
  const controller = RELEASE_PATHS.controller;
  if (
    execute('git', ['rev-parse', 'HEAD'], { cwd: controller }).trim() !==
      operation.request.sourceSha ||
    execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: controller }).trim()
  )
    refuse('CONTROLLER_CHANGED');
  const manifest = manifestSnapshot();
  if (operation.request.expectedManifestSha256 !== manifest.sha256) refuse('SNAPSHOT_CHANGED');
  const env = readEnvironment(controller);
  assertDirectory(RELEASE_PATHS.executors);
  fs.mkdirSync(operation.directory, { mode: 0o700 });
  // FLAG: No hardlinks, shared writable objects, Git hooks, submodules or user worktree are reused.
  execute('git', [
    '-c',
    'core.hooksPath=/dev/null',
    'clone',
    '--no-hardlinks',
    '--no-checkout',
    controller,
    operation.root,
  ]);
  execute(
    'git',
    ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', operation.request.sourceSha],
    { cwd: operation.root },
  );
  fs.writeFileSync(join(operation.root, '.env'), env, { flag: 'wx', mode: 0o600 });
  verifySource(operation.root, operation.request.sourceSha);
  const marker = fs.readFileSync(
    join(operation.root, 'infra/scripts/lib/durable-release-executor.sh'),
    'utf8',
  );
  if (!marker.includes('MAXIM_DURABLE_RELEASE_EXECUTOR_PROTOCOL=maxim-durable-release-executor-v1'))
    refuse('EXECUTOR_PROTOCOL_UNAVAILABLE');
  const output = fs.readFileSync(0).toString('utf8');
  const plan = { components: parseImagePreparationPlan(output, operation.request.sourceSha) };
  const images = withEvidence((evidence) => verifyRequestEvidence(operation.request, evidence));
  const context = {
    schemaVersion: 1,
    id: operation.id,
    requestHash: operation.hash,
    sourceSha: operation.request.sourceSha,
    preparedAt: new Date().toISOString(),
    manifestSha256: manifest.sha256,
    previousManifest: manifest.manifest,
    envSha256: sha256(env),
    components: plan.components,
    images,
  };
  evaluateAdmission({
    request: operation.request,
    hash: operation.hash,
    context,
    plan,
    manifest,
    envHash: sha256(env),
  });
  for (const proof of images)
    preloadRegistryImage(proof, {
      sha: operation.request.sourceSha,
      component: proof.record.component,
    });
  writePrivateJson(join(operation.directory, 'context.json'), context, { exclusive: true });
}

function admit(operation, root, input) {
  assertLocked();
  if (root !== operation.root || operation.summary.state !== 'ADMITTING')
    refuse('EXECUTOR_CONFLICT');
  verifySource(root, operation.request.sourceSha);
  assertPolicy(operation.request);
  if (input.length > 8192 || !/^MAXIM_IMAGE_PLAN=[^\r\n]+\n$/u.test(input))
    refuse('INVALID_COMPONENT_PLAN');
  const plan = { components: parseImagePreparationPlan(input, operation.request.sourceSha) };
  const context = readContext(operation);
  evaluateAdmission({
    request: operation.request,
    hash: operation.hash,
    context,
    plan,
    manifest: manifestSnapshot(),
    envHash: sha256(readEnvironment(RELEASE_PATHS.controller)),
  });
  if (sha256(readEnvironment(root)) !== context.envSha256) refuse('EXECUTOR_ENV_CHANGED');
  withEvidence(({ github, verifyImage }) => {
    requireCurrentMain(github, operation.request.sourceSha);
    proveGreenWorkflows({ github, sha: operation.request.sourceSha, purpose: 'production' });
    for (const proof of context.images) {
      const current = findRegistryArtifact({
        github,
        sha: operation.request.sourceSha,
        component: proof.record.component,
      });
      if (!equal(current.record, proof.record) || !equal(current.artifact, proof.artifact))
        refuse('IMAGE_EVIDENCE_CHANGED');
      verifyImage(proof.record, {
        repository: 'GameclubPro/Major-Maksimov',
        sha: operation.request.sourceSha,
        component: proof.record.component,
      });
      const image = JSON.parse(execute('docker', ['image', 'inspect', proof.record.image.alias]));
      if (!Array.isArray(image) || image.length !== 1) refuse('IMAGE_UNPROVED');
      assertImageInspection(image[0], {
        sha: operation.request.sourceSha,
        imageId: proof.record.image.imageId,
        sizeBytes: proof.record.image.sizeBytes,
      });
      const receipt = verifyPreloadedImage({
        component: COMPONENTS[proof.record.component],
        sha: operation.request.sourceSha,
        imageRef: proof.record.image.alias,
        imageId: proof.record.image.imageId,
      });
      if (!equal(receipt.record, proof.record) || !equal(receipt.artifact, proof.artifact))
        refuse('IMAGE_RECEIPT_CHANGED');
    }
  });
  fs.writeSync(
    3,
    `${JSON.stringify({ schemaVersion: 1, event: 'READY', id: operation.id, requestHash: operation.hash })}\n`,
  );
}

const requiredSmokes = {
  'api-shared': [
    'api-local-live',
    'api-local-ready',
    'api-admin-live',
    'api-admin-ready',
    'api-public-live',
    'api-photo-native-sandbox-isolation',
    'api-photo-native-sandbox-uds',
    'api-ocr-native-sandbox-isolation',
    'api-ocr-native-sandbox-uds',
  ],
  'miniapp-major-static': ['miniapp-major-static'],
  'admin-static': ['admin-static'],
  eraser: ['eraser-exact-source-ready'],
};

export function evaluateResult({ request, context, manifest }) {
  validateCompleteReleaseManifest(manifest);
  if (!context.components.length) {
    if (!equal(manifest, context.previousManifest)) refuse('NOOP_MANIFEST_CHANGED');
    return { unchanged: true };
  }
  if (
    manifest.targetSha !== request.sourceSha ||
    manifest.releaseId === context.previousManifest.releaseId ||
    Date.parse(manifest.createdAt) < Date.parse(context.preparedAt) ||
    manifest.emergencyReason
  )
    refuse('FINAL_MANIFEST_UNPROVED');
  const expectedComponents = [
    ...new Set([...Object.keys(context.previousManifest.components), ...context.components]),
  ].sort();
  if (!equal(Object.keys(manifest.components).sort(), expectedComponents))
    refuse('FINAL_COMPONENT_MISSING');
  for (const [component, installed] of Object.entries(manifest.components)) {
    if (!context.components.includes(component)) {
      if (!equal(installed, context.previousManifest.components[component]))
        refuse('INHERITED_COMPONENT_CHANGED');
      continue;
    }
    const proof = context.images.find((image) => COMPONENTS[image.record.component] === component);
    if (
      !proof ||
      installed.sourceSha !== request.sourceSha ||
      installed.imageRef !== proof.record.image.alias ||
      installed.imageId !== proof.record.image.imageId ||
      !equal(installed.registryProvenance?.record, proof.record) ||
      !equal(installed.registryProvenance?.artifact, proof.artifact)
    )
      refuse('FINAL_IMAGE_UNPROVED');
    if (!requiredSmokes[component].every((smoke) => manifest.smokes?.includes(smoke)))
      refuse('FINAL_SMOKES_UNPROVED');
  }
  for (const component of context.components)
    if (!manifest.components[component]) refuse('FINAL_COMPONENT_MISSING');
  return { unchanged: false };
}

function verifyRuntime(root, manifest) {
  // FLAG: The committed strict-smoke receipt is necessary but zero exit alone is insufficient.
  // Read every active application role back from Docker while the shared lock excludes releases.
  const containers = execute('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    'label=com.docker.compose.project=infra',
  ])
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (
    !containers.length ||
    containers.length > 64 ||
    containers.some((id) => !/^[a-f0-9]{12,64}$/u.test(id))
  )
    refuse('RUNTIME_UNPROVED');
  const inspected = JSON.parse(execute('docker', ['inspect', ...containers]));
  const topology = execute('bash', [
    '-c',
    'source "$1/infra/scripts/lib/deploy-topology.sh"; printf "%s\\n" "${MAXIM_PRODUCTION_API_SERVICES[@]}"',
    'maxim-release-readback',
    root,
  ])
    .trim()
    .split('\n');
  const services = {
    'api-shared': [...topology, 'ocr-native-sandbox', 'photo-native-sandbox'],
    'miniapp-major-static': ['miniapp-major-static'],
    'admin-static': ['admin-static'],
    eraser: ['eraser'],
  };
  for (const [component, expected] of Object.entries(manifest.components)) {
    for (const service of services[component]) {
      const matches = inspected.filter(
        (container) => container.Config?.Labels?.['com.docker.compose.service'] === service,
      );
      if (
        matches.length !== 1 ||
        matches[0].Image !== expected.imageId ||
        matches[0].State?.Status !== 'running' ||
        (matches[0].State.Health && matches[0].State.Health.Status !== 'healthy')
      )
        refuse('RUNTIME_IDENTITY_UNPROVED');
    }
  }
  return inspected
    .map((container) => ({
      id: container.Id,
      service: container.Config?.Labels?.['com.docker.compose.service'],
      imageId: container.Image,
      status: container.State?.Status,
      health: container.State?.Health?.Status ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function result(operation) {
  assertLocked();
  if (operation.summary.state !== 'EXECUTING') refuse('STALE_STATE');
  const context = readContext(operation);
  const { manifest } = manifestSnapshot();
  evaluateResult({ request: operation.request, context, manifest });
  verifySource(operation.root, operation.request.sourceSha);
  verifyRuntime(operation.root, manifest);
  writePrivateJson(
    join(operation.directory, 'result.json'),
    {
      schemaVersion: 1,
      id: operation.id,
      requestHash: operation.hash,
      checkedAt: new Date().toISOString(),
      manifestSha256: manifestSnapshot().sha256,
      releaseId: manifest.releaseId,
    },
    { exclusive: true },
  );
}

export function evaluateRecovery({
  request,
  hash,
  summary,
  context,
  manifest,
  expectedManifestSha256,
}) {
  if (
    summary.state !== 'NEEDS_REVIEW' ||
    summary.resolution !== null ||
    summary.requestHash !== hash ||
    summary.sourceSha !== request.sourceSha ||
    !summary.executor ||
    summary.executor.sourceSha !== request.sourceSha ||
    !HASH.test(expectedManifestSha256 ?? '') ||
    expectedManifestSha256 !== manifest.sha256
  )
    refuse('RECOVERY_UNPROVED');
  // FLAG: Recovery may happen after a newer main. It proves the already accepted
  // frozen context and installed result; it never re-authorizes runtime or repeats effects.
  evaluateAdmission({
    request,
    hash,
    context,
    plan: { components: context.components },
    manifest: { sha256: request.expectedManifestSha256, manifest: context.previousManifest },
    envHash: context.envSha256,
    now: Date.parse(context.preparedAt),
  });
  const { unchanged } = evaluateResult({ request, context, manifest: manifest.manifest });
  if (unchanged && manifest.sha256 !== request.expectedManifestSha256) refuse('RECOVERY_UNPROVED');
  return unchanged ? 'UNCHANGED' : 'RECOVERED';
}

function reconcile(operation, expectedManifestSha256) {
  assertLocked();
  const contextBytes = privateBytes(join(operation.directory, 'context.json'));
  const context = JSON.parse(contextBytes);
  const manifest = manifestSnapshot();
  const kind = evaluateRecovery({
    ...operation,
    summary: operation.summary,
    context,
    manifest,
    expectedManifestSha256,
  });
  const stopped = assertExecutorStopped(operation.summary.executor);
  verifySource(operation.root, operation.request.sourceSha);
  if (sha256(readEnvironment(operation.root)) !== context.envSha256) refuse('EXECUTOR_ENV_CHANGED');
  const runtime = verifyRuntime(operation.root, manifest.manifest);
  if (manifestSnapshot().sha256 !== manifest.sha256) refuse('SNAPSHOT_CHANGED');
  const evidence = {
    schemaVersion: 1,
    id: operation.id,
    requestHash: operation.hash,
    sourceSha: operation.request.sourceSha,
    checkedAt: new Date().toISOString(),
    kind,
    contextSha256: sha256(contextBytes),
    manifestSha256: manifest.sha256,
    executor: operation.summary.executor,
    stopped,
    runtime,
  };
  const evidencePath = join(operation.directory, `recovery-${randomUUID()}.json`);
  writePrivateJson(evidencePath, evidence, { exclusive: true });
  const evidenceSha256 = sha256(privateBytes(evidencePath));
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, kind, evidenceSha256, manifestSha256: manifest.sha256 })}\n`,
  );
}

export function runAdmission(argv) {
  const [command, id, hash, root, ...extra] = argv;
  if (
    extra.length ||
    !['preflight', 'snapshot', 'admit', 'result', 'reconcile'].includes(command) ||
    (command === 'admit'
      ? !root
      : command === 'reconcile'
        ? !HASH.test(root ?? '')
        : root !== undefined)
  )
    refuse('INVALID_COMMAND');
  const operation = identity(id, hash);
  if (command === 'preflight') {
    assertPolicy(operation.request);
    if (operation.summary.state !== 'ADMITTING') refuse('STALE_STATE');
    const origin = execute('git', ['remote', 'get-url', 'origin'], {
      cwd: RELEASE_PATHS.controller,
    }).trim();
    assertServiceOrigin(origin);
    if (origin !== 'https://github.com/GameclubPro/Major-Maksimov.git') {
      privateBytes('/etc/maxim-deploy/git-read-key', { maxBytes: 16384 });
      privateBytes('/etc/maxim-deploy/git-known-hosts', { maxBytes: 65536 });
    }
    withEvidence((evidence) => verifyRequestEvidence(operation.request, evidence));
  } else if (command === 'snapshot') snapshot(operation);
  else if (command === 'admit') admit(operation, root, fs.readFileSync(0).toString('utf8'));
  else if (command === 'result') result(operation);
  else reconcile(operation, root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runAdmission(process.argv.slice(2));
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code ?? '')
      ? error.code
      : 'ADMISSION_UNPROVED';
    // FLAG: This helper never mutates runtime. Only a complete correlated refusal is retry evidence.
    const provedRefusal = new Set([
      'SUPERSEDED',
      'MAIN_UNPROVED',
      'SERVICE_PAUSED',
      'AUTOMATIC_DISABLED',
      'SNAPSHOT_CHANGED',
      'CONTEXT_CONFLICT',
      'CONTEXT_EXPIRED',
      'COMPONENT_PLAN_CHANGED',
      'IMAGE_COVERAGE_MISSING',
      'IMAGE_COVERAGE_EXCESS',
      'IMAGE_EVIDENCE_CHANGED',
      'EXECUTOR_ENV_CHANGED',
      'EXECUTOR_SOURCE_CHANGED',
      'EXECUTOR_NOT_DETACHED',
      'CREDENTIAL_UNAVAILABLE',
      'IMAGE_RECEIPT_CHANGED',
      'INVALID_COMPONENT_PLAN',
      'CONTROLLER_CHANGED',
      'EXECUTOR_PROTOCOL_UNAVAILABLE',
    ]);
    const safe = provedRefusal.has(code) && process.argv[2] !== 'result';
    if (safe && UUID.test(process.argv[3] ?? '') && HASH.test(process.argv[4] ?? '')) {
      try {
        fs.writeSync(
          3,
          `${JSON.stringify({ schemaVersion: 1, event: 'SAFE_REFUSAL', id: process.argv[3], requestHash: process.argv[4], reasonCode: code })}\n`,
        );
      } catch {
        /* no trusted control channel */
      }
    }
    process.stderr.write(`Release admission: ${code}.\n`);
    process.exitCode = safe ? 86 : 70;
  }
}
