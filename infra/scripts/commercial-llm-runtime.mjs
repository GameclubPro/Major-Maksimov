#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCurrentManifest, validateCompleteReleaseManifest } from './release-manifest.mjs';
import { WORKSTATION_IDENTITY } from './commercial-llm-workstation-profile.mjs';
import { poolProfile } from './commercial-llm-pool-profile.mjs';
import { recoverCommercialLlmCpuQuarantine } from './commercial-llm-cpu-recovery.mjs';
import { assertCommercialLlmCpuControllerIdentity } from './commercial-llm-cpu-controller-identity.mjs';

import {
  COMMERCIAL_LLM_RUNTIME,
  COMMERCIAL_LLM_LEGACY_RUNTIME,
  COMMERCIAL_LLM_SLOTS_RUNTIME,
  COMMERCIAL_LLM_COMMAND,
  commercialLlmCommand,
  commercialLlmCommandSha256,
} from './commercial-llm-profiles.mjs';
export {
  COMMERCIAL_LLM_RUNTIME,
  COMMERCIAL_LLM_LEGACY_RUNTIME,
  COMMERCIAL_LLM_SLOTS_RUNTIME,
  COMMERCIAL_LLM_COMMAND,
};
const pin = COMMERCIAL_LLM_RUNTIME;
const slotsPin = COMMERCIAL_LLM_SLOTS_RUNTIME;
const { stateDir, modelDir } = pin;
const composeArgs = [
  'compose',
  '--env-file',
  '.env',
  '-p',
  'infra',
  '-f',
  'infra/docker-compose.yml',
];
const safeSha = /^[0-9a-f]{40}$/u;
let capacityPaths = [];

function run(file, args, { timeout = 30000, input, maxBuffer = 1024 * 1024 } = {}) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`commercial_llm_command_failed:${file}`);
  }
}

function emit(stage, details = {}) {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, stage, ...details })}\n`,
  );
}

function assertSafeFile(path, { maximumBytes = Infinity, exactBytes } = {}) {
  const value = lstatSync(path);
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1 ||
    value.uid !== process.getuid() ||
    (value.mode & 0o022) !== 0 ||
    value.size > maximumBytes ||
    (exactBytes !== undefined && value.size !== exactBytes)
  ) {
    throw new Error('commercial_llm_unsafe_file');
  }
  return value;
}

function ensureDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o750 });
  const value = lstatSync(path);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== process.getuid() ||
    (value.mode & 0o022) !== 0
  ) {
    throw new Error('commercial_llm_unsafe_directory');
  }
}

function atomicWrite(path, contents, mode = 0o600) {
  if (existsSync(path)) assertSafeFile(path, { maximumBytes: 1024 * 1024 });
  const tempPath = `${path}.new-${process.pid}`;
  const fd = openSync(tempPath, 'wx', mode);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, path);
  const parent = openSync(dirname(path), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function patchCommercialLlmEnvironment(source, enabled) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024) {
    throw new Error('commercial_llm_environment_refused');
  }
  const pattern = /^(?:[ \t]*)(?:export[ \t]+)?COMMERCIAL_LLM_SHADOW_ENABLED[ \t]*=.*$/gmu;
  const matches = [...source.matchAll(pattern)];
  if (matches.length > 1) throw new Error('commercial_llm_duplicate_environment_flag');
  const line = `COMMERCIAL_LLM_SHADOW_ENABLED=${enabled ? 'true' : 'false'}`;
  if (matches.length === 1) return source.replace(pattern, line);
  return `${source}${source.endsWith('\n') || source.length === 0 ? '' : '\n'}${line}\n`;
}

export function commercialLlmReceiptProfile(receipt) {
  if (receipt?.runtimeProfile === undefined && receipt?.commandSha256 === undefined) return pin;
  if (
    receipt?.runtimeProfile === slotsPin.runtimeProfile &&
    receipt.commandSha256 === commercialLlmCommandSha256(slotsPin)
  )
    return slotsPin;
  throw new Error('commercial_llm_receipt_refused');
}

export function assertCommercialLlmReceipt(
  receipt,
  profile = commercialLlmReceiptProfile(receipt),
) {
  if (
    receipt?.schemaVersion !== 1 ||
    !safeSha.test(receipt.sourceSha ?? '') ||
    !Number.isFinite(Date.parse(receipt.installedAt ?? '')) ||
    !/^[0-9a-f]{64}$/u.test(receipt.containerId ?? '') ||
    !['installed', 'stopped'].includes(receipt.state) ||
    receipt.imageRef !== profile.imageRef ||
    receipt.imageId !== profile.imageId ||
    receipt.modelSha256 !== profile.modelSha256 ||
    receipt.modelBytes !== profile.modelBytes ||
    receipt.modelManifestSha256 !== profile.modelManifestSha256 ||
    receipt.templateSha256 !== profile.templateSha256 ||
    receipt.licenseSha256 !== profile.licenseSha256 ||
    receipt.upstreamRevision !== profile.upstreamRevision ||
    receipt.upstreamVersion !== profile.upstreamVersion ||
    receipt.cpuLimit !== profile.cpuLimit ||
    receipt.memoryLimitBytes !== profile.memoryLimitBytes ||
    receipt.contextTokens !== 4096 ||
    receipt.parallelRequests !== 1 ||
    receipt.generationThreads !== profile.cpuLimit ||
    receipt.reasoning !== false ||
    receipt.smoke !== 'closed-synthetic-json-v1' ||
    (profile.slotInspection === true
      ? receipt.runtimeProfile !== profile.runtimeProfile ||
        receipt.commandSha256 !== commercialLlmCommandSha256(profile)
      : receipt.runtimeProfile !== undefined || receipt.commandSha256 !== undefined)
  ) {
    throw new Error('commercial_llm_receipt_refused');
  }
  return receipt;
}

export function commercialLlmContainerProfile(container) {
  const command = JSON.stringify(container?.Config?.Cmd);
  for (const profile of [pin, slotsPin])
    if (command === JSON.stringify(commercialLlmCommand(profile))) return profile;
  throw new Error('commercial_llm_runtime_attestation_refused');
}

// FLAG: Production Docker 29 identifies this image by its OCI manifest, not its config blob.
export function assertCommercialLlmImage(image) {
  if (
    image?.Id !== pin.imageId ||
    image.Descriptor?.digest !== pin.imageId ||
    image.Descriptor?.mediaType !== 'application/vnd.oci.image.manifest.v1+json' ||
    image.Architecture !== 'amd64' ||
    image.Os !== 'linux' ||
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(pin.imageRef) ||
    image.Config?.Labels?.['org.opencontainers.image.revision'] !== pin.upstreamRevision ||
    image.Config?.Labels?.['org.opencontainers.image.version'] !== pin.upstreamVersion
  ) {
    throw new Error('commercial_llm_image_pin_refused');
  }
  return image.Id;
}

export function assertCommercialLlmContainer(
  container,
  {
    requireHealthy = true,
    requireRunning = true,
    profile = commercialLlmContainerProfile(container),
  } = {},
) {
  const config = container?.Config;
  const host = container?.HostConfig;
  const labels = config?.Labels;
  const networks = Object.keys(container?.NetworkSettings?.Networks ?? {});
  const mounts = container?.Mounts;
  const command = config?.Cmd;
  const tmpfs = Object.entries(host?.Tmpfs ?? {});
  const tmpfsOptions = new Map();
  const tmpfsValid =
    tmpfs.length === 1 &&
    tmpfs[0][0] === '/tmp' &&
    typeof tmpfs[0][1] === 'string' &&
    tmpfs[0][1].split(',').every((part) => {
      if (part === 'rw') return true;
      const separator = part.indexOf('=');
      if (separator < 1 || tmpfsOptions.has(part.slice(0, separator))) return false;
      tmpfsOptions.set(part.slice(0, separator), part.slice(separator + 1));
      return true;
    }) &&
    tmpfsOptions.size === 4 &&
    ['64m', '67108864'].includes(tmpfsOptions.get('size')) &&
    tmpfsOptions.get('mode') === '1777' &&
    tmpfsOptions.get('uid') === '1000' &&
    tmpfsOptions.get('gid') === '1000';
  const mountsExact =
    Array.isArray(mounts) &&
    mounts.length === (profile.templateMode === 'file' ? 2 : 1) &&
    [
      [profile.modelPath, profile.modelContainerPath],
      ...(profile.templateMode === 'file'
        ? [[profile.templatePath, '/models/chat_template.jinja']]
        : []),
    ].every(([source, target]) =>
      mounts.some(
        (mount) =>
          mount.Type === 'bind' &&
          mount.Source === source &&
          mount.Destination === target &&
          mount.RW === false,
      ),
    );
  // FLAG: The model is an isolated shadow auxiliary, never an API identity or a store client.
  if (
    !/^[0-9a-f]{64}$/u.test(container?.Id ?? '') ||
    container.Image !== profile.imageId ||
    config?.Image !== profile.imageRef ||
    config?.User !== '1000:1000' ||
    JSON.stringify(config?.Entrypoint) !== '["/app/llama-server"]' ||
    JSON.stringify([...(config?.Env ?? [])].sort()) !==
      JSON.stringify(
        [
          'LLAMA_ARG_HOST=0.0.0.0',
          'LLAMA_ARG_PORT=8080',
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ].sort(),
      ) ||
    labels?.['com.docker.compose.project'] !== 'infra' ||
    labels?.['com.docker.compose.service'] !== profile.service ||
    labels?.['com.maxim.commercial-llm-shadow'] !== 'true' ||
    labels?.['com.maxim.commercial-llm-model-sha256'] !== profile.modelSha256 ||
    (requireRunning && container.State?.Running !== true) ||
    (requireHealthy && container.State?.Health?.Status !== 'healthy') ||
    host?.ReadonlyRootfs !== true ||
    host?.Init !== true ||
    host?.NanoCpus !== profile.cpuLimit * 1e9 ||
    host?.CpuShares !== 128 ||
    host?.Memory !== profile.memoryLimitBytes ||
    host?.MemorySwap !== profile.memoryLimitBytes ||
    host?.PidsLimit !== profile.pidLimit ||
    JSON.stringify(host?.CapDrop) !== '["ALL"]' ||
    !host?.SecurityOpt?.includes('no-new-privileges:true') ||
    !tmpfsValid ||
    Object.keys(host?.PortBindings ?? {}).length !== 0 ||
    host?.Privileged === true ||
    networks.length !== 1 ||
    networks[0] !== 'infra_commercial_llm_internal' ||
    !mountsExact ||
    JSON.stringify(command) !== JSON.stringify(commercialLlmCommand(profile))
  ) {
    throw new Error('commercial_llm_runtime_attestation_refused');
  }
  return container.Id;
}

function sourceAdmission(expectedSha) {
  if (!safeSha.test(expectedSha ?? '')) throw new Error('commercial_llm_exact_source_required');
  if (run('git', ['rev-parse', 'HEAD']) !== expectedSha) {
    throw new Error('commercial_llm_source_mismatch');
  }
  if (run('git', ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error('commercial_llm_dirty_source');
  }
  // FLAG: A valid ordinary release is required; installing an optional model cannot adopt recovery.
  run('node', ['infra/scripts/release-manifest.mjs', 'validate-current']);
  validateCompleteReleaseManifest(readCurrentManifest('/var/lib/maxim-deploy'));
}

export function checkCommercialLlmCapacity({ paths, availableMemoryBytes, needsDownload }) {
  const artifactBytes = needsDownload ? pin.modelBytes + pin.templateBytes + pin.licenseBytes : 0;
  const required = pin.diskReserveBytes + pin.downloadReserveBytes + artifactBytes;
  if (
    !Array.isArray(paths) ||
    paths.length < 2 ||
    paths.some(
      ({ availableBytes }) => !Number.isFinite(availableBytes) || availableBytes < required,
    )
  ) {
    throw new Error('commercial_llm_disk_reserve_refused');
  }
  if (
    !Number.isFinite(availableMemoryBytes) ||
    availableMemoryBytes < pin.minimumAvailableMemoryBytes
  ) {
    throw new Error('commercial_llm_memory_reserve_refused');
  }
  return { artifactBytes, requiredFreeBytes: required, availableMemoryBytes };
}

function capacity(needsDownload) {
  const dockerRoot = run('docker', ['info', '--format', '{{.DockerRootDir}}']);
  capacityPaths = [modelDir, dockerRoot];
  const paths = capacityPaths.map((path) => {
    const data = statfsSync(path);
    return { availableBytes: Number(data.bavail) * Number(data.bsize) };
  });
  const match = /^MemAvailable:\s+(\d+) kB$/mu.exec(readFileSync('/proc/meminfo', 'utf8'));
  return checkCommercialLlmCapacity({
    paths,
    availableMemoryBytes: Number(match?.[1] ?? NaN) * 1024,
    needsDownload,
  });
}

function inspectContainer({ requireHealthy = true, requireRunning = true, profile } = {}) {
  const ids = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
  if (!/^[0-9a-f]{64}$/u.test(ids)) throw new Error('commercial_llm_singleton_required');
  const rows = JSON.parse(run('docker', ['inspect', ids]));
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('commercial_llm_singleton_required');
  assertCommercialLlmContainer(rows[0], { requireHealthy, requireRunning, profile });
  const network = JSON.parse(
    run('docker', ['network', 'inspect', 'infra_commercial_llm_internal']),
  );
  if (network.length !== 1 || network[0]?.Internal !== true) {
    throw new Error('commercial_llm_internal_network_required');
  }
  const allowed = new Set([pin.service, 'api-moderation-background']);
  for (const id of Object.keys(network[0].Containers ?? {})) {
    const peer = JSON.parse(run('docker', ['inspect', id]));
    const labels = peer[0]?.Config?.Labels;
    if (
      peer.length !== 1 ||
      labels?.['com.docker.compose.project'] !== 'infra' ||
      !allowed.has(labels?.['com.docker.compose.service'])
    ) {
      throw new Error('commercial_llm_unexpected_network_peer');
    }
  }
  return rows[0];
}

function receiptPresent() {
  return lstatSync(pin.receiptPath, { throwIfNoEntry: false }) !== undefined;
}

function readReceipt() {
  assertSafeFile(pin.receiptPath, { maximumBytes: 16384 });
  return assertCommercialLlmReceipt(JSON.parse(readFileSync(pin.receiptPath, 'utf8')));
}

async function checksum(path, sha256, bytes) {
  const before = assertSafeFile(path, { exactBytes: bytes });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal: AbortSignal.timeout(120000) }))
    hash.update(chunk);
  const after = assertSafeFile(path, { exactBytes: bytes });
  if (
    hash.digest('hex') !== sha256 ||
    ['ino', 'dev', 'mtimeMs', 'ctimeMs', 'size'].some((key) => before[key] !== after[key])
  ) {
    throw new Error('commercial_llm_artifact_checksum_refused');
  }
}

async function longCommand(file, args, { stage, timeoutMs, artifactPath } = {}) {
  const started = Date.now();
  emit(stage, { event: 'started', deadline: new Date(started + timeoutMs).toISOString() });
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    let killTimer;
    let timedOut = false;
    let observationError;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    const heartbeat = setInterval(() => {
      try {
        let downloadedBytes = null;
        if (artifactPath) downloadedBytes = statSync(artifactPath).size;
        for (const path of capacityPaths) {
          const fs = statfsSync(path);
          if (
            Number(fs.bavail) * Number(fs.bsize) <
            pin.diskReserveBytes + pin.downloadReserveBytes
          ) {
            throw new Error('commercial_llm_disk_floor_crossed');
          }
        }
        emit(stage, {
          event: 'heartbeat',
          childPid: child.pid,
          elapsedSeconds: Math.floor((Date.now() - started) / 1000),
          downloadedBytes,
        });
      } catch {
        observationError = new Error(`commercial_llm_${stage}_observation_or_disk_floor_failed`);
        emit(stage, { event: 'observation_missing_or_disk_floor_refused', childPid: child.pid });
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }
    }, 30000);
    const finish = (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(heartbeat);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.once('error', () => finish(new Error(`commercial_llm_${stage}_spawn_failed`)));
    child.once('exit', (code) =>
      finish(
        observationError || timedOut || code !== 0
          ? (observationError ??
              new Error(`commercial_llm_${stage}_${timedOut ? 'deadline' : `exit_${code}`}`))
          : null,
      ),
    );
  });
  emit(stage, { event: 'completed', elapsedSeconds: Math.floor((Date.now() - started) / 1000) });
}

async function downloadArtifact({ path, url, sha256, bytes, stage }) {
  if (existsSync(path)) {
    await checksum(path, sha256, bytes);
    emit(stage, { event: 'checksum_verified', bytes });
    return;
  }
  const partial = `${path}.partial`;
  if (existsSync(partial)) {
    const prior = assertSafeFile(partial, { maximumBytes: bytes });
    if (prior.size === bytes) {
      await checksum(partial, sha256, bytes);
      chmodSync(partial, 0o444);
      renameSync(partial, path);
      emit(stage, { event: 'complete_partial_checksum_verified', bytes });
      return;
    }
  }
  await longCommand(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--connect-timeout',
      '15',
      '--max-time',
      String(pin.downloadDeadlineSeconds),
      '--speed-limit',
      '65536',
      '--speed-time',
      '120',
      '--limit-rate',
      String(pin.downloadRateBytes),
      '--continue-at',
      '-',
      '--output',
      partial,
      url,
      '--max-filesize',
      String(bytes),
    ],
    { stage, timeoutMs: pin.downloadDeadlineSeconds * 1000 + 10000, artifactPath: partial },
  );
  await checksum(partial, sha256, bytes);
  chmodSync(partial, 0o444);
  renameSync(partial, path);
  emit(stage, { event: 'checksum_verified', bytes });
}

export function commercialLlmSyntheticRequest() {
  return {
    model: pin.alias,
    messages: [
      {
        role: 'system',
        content: 'Классифицируй сообщение. Обычное приветствие не является коммерческой рекламой.',
      },
      { role: 'user', content: 'Доброе утро, соседи!' },
    ],
    temperature: 0,
    max_tokens: 96,
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'commercial_shadow_closed_probe',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            classification: { type: 'string', enum: ['NOT_COMMERCIAL'] },
            reasonCodes: {
              type: 'array',
              items: { type: 'string', enum: ['ORDINARY_DISCUSSION'] },
              minItems: 1,
              maxItems: 1,
            },
          },
          required: ['classification', 'reasonCodes'],
          additionalProperties: false,
        },
      },
    },
  };
}

export function validateCommercialLlmSyntheticResponse(response) {
  const choice = response?.choices?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason !== 'stop' || typeof content !== 'string' || content.length > 1024) {
    throw new Error('commercial_llm_synthetic_smoke_refused');
  }
  const result = JSON.parse(content);
  if (
    Object.keys(result).sort().join(',') !== 'classification,reasonCodes' ||
    result.classification !== 'NOT_COMMERCIAL' ||
    JSON.stringify(result.reasonCodes) !== '["ORDINARY_DISCUSSION"]'
  ) {
    throw new Error('commercial_llm_synthetic_smoke_refused');
  }
}

export function parseCommercialLlmModelJson(source) {
  try {
    return JSON.parse(source);
  } catch {
    // FLAG: JSON syntax errors can quote private slot fields; CLI errors must never retain them.
    throw new Error('commercial_llm_model_json_refused');
  }
}

function smoke(expectedContainerId) {
  const container = inspectContainer();
  const profile = commercialLlmContainerProfile(container);
  if (expectedContainerId && container.Id !== expectedContainerId) {
    throw new Error('commercial_llm_generation_changed');
  }
  const readModelJson = (path) =>
    parseCommercialLlmModelJson(
      run(
        'docker',
        [
          'exec',
          container.Id,
          'curl',
          '--fail',
          '--silent',
          '--max-time',
          '5',
          '--max-filesize',
          '65536',
          `http://127.0.0.1:8080${path}`,
        ],
        { maxBuffer: 65536 },
      ),
    );
  const props = readModelJson('/props');
  assertCommercialLlmTemplate(props);
  if (profile.slotInspection === true && (props.endpoint_slots !== true || props.total_slots !== 1))
    throw new Error('commercial_llm_slots_capability_refused');
  const response = run(
    'docker',
    [
      'exec',
      '-i',
      container.Id,
      'curl',
      '--fail',
      '--silent',
      '--max-time',
      '120',
      '--max-filesize',
      '16384',
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
      'http://127.0.0.1:8080/v1/chat/completions',
    ],
    { input: JSON.stringify(commercialLlmSyntheticRequest()), timeout: 125000, maxBuffer: 16384 },
  );
  validateCommercialLlmSyntheticResponse(JSON.parse(response));
  if (profile.slotInspection === true) assertCommercialLlmIdleSlots(readModelJson('/slots'));
  if (inspectContainer({ profile }).Id !== container.Id)
    throw new Error('commercial_llm_generation_changed');
  emit('smoke', {
    result: 'closed-synthetic-json-v1',
    containerId: container.Id,
    modelSha256: pin.modelSha256,
  });
  return container;
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function validateCommercialLlmClientSmokeResponse(response) {
  const expectedCases = [
    { name: 'commercial-service', classification: 'COMMERCIAL' },
    { name: 'personal-used-item', classification: 'NOT_COMMERCIAL' },
  ];
  if (
    !hasExactKeys(response, [
      'ok',
      'casesPassed',
      'casesTotal',
      'modelSha256',
      'promptSha256',
      'cases',
    ]) ||
    response.ok !== true ||
    response.casesPassed !== 2 ||
    response.casesTotal !== 2 ||
    response.modelSha256 !== pin.modelSha256 ||
    response.promptSha256 !== pin.smokePromptSha256 ||
    !Array.isArray(response.cases) ||
    response.cases.length !== expectedCases.length ||
    !response.cases.every(
      (current, index) =>
        hasExactKeys(current, ['name', 'classification', 'durationMs']) &&
        current.name === expectedCases[index].name &&
        current.classification === expectedCases[index].classification &&
        Number.isFinite(current.durationMs) &&
        current.durationMs >= 0 &&
        current.durationMs <= 60000,
    )
  ) {
    throw new Error('commercial_llm_client_smoke_refused');
  }
  return {
    ok: true,
    casesPassed: 2,
    casesTotal: 2,
    modelSha256: pin.modelSha256,
    promptSha256: pin.smokePromptSha256,
    cases: response.cases.map(({ name, classification, durationMs }) => ({
      name,
      classification,
      durationMs,
    })),
  };
}

export function assertCommercialLlmApiClient(client, { service, imageId, requireRunning = true }) {
  const role = { 'api-admin': 'admin', 'api-moderation-background': 'moderation' }[service];
  if (
    !role ||
    !/^sha256:[0-9a-f]{64}$/u.test(imageId ?? '') ||
    !/^[0-9a-f]{64}$/u.test(client?.Id ?? '') ||
    client.Image !== imageId ||
    (requireRunning && client.State?.Running !== true) ||
    typeof client.State?.Running !== 'boolean' ||
    client.Config?.Labels?.['com.maxim.release-protected'] !== 'true' ||
    client.Config?.Labels?.['com.docker.compose.project'] !== 'infra' ||
    client.Config?.Labels?.['com.docker.compose.service'] !== service ||
    !Array.isArray(client.Config?.Env) ||
    client.Config.Env.some((value) => typeof value !== 'string') ||
    JSON.stringify(client.Config.Env.filter((value) => value.startsWith('APP_ROLE='))) !==
      JSON.stringify([`APP_ROLE=${role}`]) ||
    JSON.stringify(client.Config.Env.filter((value) => value.startsWith('APP_SERVICE_NAME='))) !==
      JSON.stringify([`APP_SERVICE_NAME=${service}`])
  ) {
    throw new Error('commercial_llm_client_identity_refused');
  }
  return client;
}

function inspectReleaseApiClient(service, { requireRunning = true } = {}) {
  run('node', ['infra/scripts/release-manifest.mjs', 'validate-current']);
  const manifest = readCurrentManifest('/var/lib/maxim-deploy');
  validateCompleteReleaseManifest(manifest);
  const imageId = manifest.components['api-shared'].imageId;
  const id = run('docker', [...composeArgs, 'ps', '-a', '-q', service]);
  if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error('commercial_llm_client_singleton_required');
  const rows = JSON.parse(run('docker', ['inspect', id]));
  if (rows.length !== 1) throw new Error('commercial_llm_client_singleton_required');
  return assertCommercialLlmApiClient(rows[0], { service, imageId, requireRunning });
}

function inspectBackgroundClient() {
  return inspectReleaseApiClient('api-moderation-background').Id;
}

const clientSmokeFailureStages = {
  ENVIRONMENT_INVALID: 'environment',
  REDIS_UNAVAILABLE: 'redis',
  ADMISSION_BLOCKED: 'admission',
  LEASE_LOST: 'ownership',
  LEASE_RELEASE_UNAVAILABLE: 'ownership',
  DEADLINE_EXCEEDED: 'ownership',
  MODEL_TIMEOUT: 'classification',
  MODEL_ABORTED: 'classification',
  MODEL_HTTP_ERROR: 'classification',
  MODEL_INVALID_RESPONSE: 'classification',
  MODEL_RESPONSE_TOO_LARGE: 'classification',
  MODEL_UNAVAILABLE: 'classification',
  UNEXPECTED_CLASSIFICATION: 'classification',
};

export function validateCommercialLlmClientSmokeFailure(value) {
  const withAdmission = value?.code === 'ADMISSION_BLOCKED';
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'ok',
      'stage',
      'code',
      ...(withAdmission ? ['admission'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    value.ok !== false ||
    typeof value.code !== 'string' ||
    !Object.hasOwn(clientSmokeFailureStages, value.code) ||
    value.stage !== clientSmokeFailureStages[value.code]
  )
    throw new Error('commercial_llm_client_smoke_diagnostic_refused');
  const result = { schemaVersion: 1, ok: false, stage: value.stage, code: value.code };
  if (withAdmission) {
    const observation = value.admission;
    if (
      !hasExactKeys(observation, ['observedAt', 'leaseState', 'cooldownState']) ||
      typeof observation.observedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(observation.observedAt) ||
      !Number.isFinite(Date.parse(observation.observedAt)) ||
      !['MISSING', 'HELD_EXPIRING', 'HELD_PERSISTENT', 'INVALID', 'UNAVAILABLE'].includes(
        observation.leaseState,
      ) ||
      !['MISSING', 'ACTIVE', 'INVALID', 'UNAVAILABLE'].includes(observation.cooldownState)
    )
      throw new Error('commercial_llm_client_smoke_diagnostic_refused');
    result.admission = {
      observedAt: observation.observedAt,
      leaseState: observation.leaseState,
      cooldownState: observation.cooldownState,
    };
  }
  return result;
}

class CommercialLlmClientSmokeFailure extends Error {
  constructor(diagnostic) {
    super(`commercial_llm_client_smoke_failed:${diagnostic.stage}:${diagnostic.code}`);
    this.diagnostic = diagnostic;
  }
}

export function executeCommercialLlmClientSmoke(execImpl = execFileSync) {
  const maximumBytes = 16384;
  const failure = (code) => ({ schemaVersion: 1, ok: false, stage: 'process', code });
  let output;
  try {
    output = execImpl(
      'docker',
      [
        ...composeArgs,
        'exec',
        '-T',
        'api-moderation-background',
        'node',
        'apps/api/dist/apps/api/src/scripts/commercial-llm-shadow-smoke.js',
      ],
      {
        timeout: 140000,
        maxBuffer: maximumBytes,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    // FLAG: Child stderr may include connection strings or source-bearing exceptions. Decode
    // only a bounded exact JSON diagnostic; never forward command, buffers or arbitrary errors.
    let diagnostic;
    const candidates = ['ETIMEDOUT', 'ENOBUFS'].includes(error?.code)
      ? []
      : [error?.stdout, error?.stderr];
    for (const candidate of candidates) {
      if (
        !(typeof candidate === 'string' || Buffer.isBuffer(candidate)) ||
        Buffer.byteLength(candidate) > maximumBytes
      )
        continue;
      try {
        diagnostic = validateCommercialLlmClientSmokeFailure(JSON.parse(candidate.toString()));
        break;
      } catch {
        /* FLAG: Unstructured legacy errors and arbitrary output remain private. */
      }
    }
    throw new CommercialLlmClientSmokeFailure(
      diagnostic ?? failure(error?.code === 'ETIMEDOUT' ? 'PROCESS_TIMEOUT' : 'PROCESS_FAILED'),
    );
  }
  try {
    if (
      !(typeof output === 'string' || Buffer.isBuffer(output)) ||
      Buffer.byteLength(output) > maximumBytes
    )
      throw new Error('invalid_output');
    return validateCommercialLlmClientSmokeResponse(JSON.parse(output.toString()));
  } catch {
    throw new CommercialLlmClientSmokeFailure(failure('INVALID_OUTPUT'));
  }
}

function checkClient() {
  inspectBackgroundClient();
  inspectContainer();
  try {
    emit('check_client', executeCommercialLlmClientSmoke());
  } catch (error) {
    if (error instanceof CommercialLlmClientSmokeFailure) emit('check_client', error.diagnostic);
    throw error;
  }
}

export function commercialLlmWorkstationBridgeCommand(nodeId) {
  if (nodeId === undefined)
    return ['node', 'apps/api/dist/apps/api/src/scripts/commercial-llm-workstation-bridge.js'];
  poolProfile(nodeId);
  return ['node', 'apps/api/dist/apps/api/src/scripts/commercial-llm-pool-bridge.js', nodeId];
}

// FLAG: Each bounded SSH bridge enters the exact attested API image. Node selection is closed;
// no deployment lock, model port, database client or MAX client is added by this host command.
async function workstationBridge(nodeId) {
  const command = commercialLlmWorkstationBridgeCommand(nodeId);
  const id = inspectBackgroundClient();
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', id, ...command], {
      stdio: 'inherit',
      timeout: 31 * 60_000,
      killSignal: 'SIGTERM',
    });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.once('error', () => reject(new Error('workstation_bridge_unavailable')));
    child.once('close', (code) => {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      if (code === 0) resolve();
      else reject(new Error('workstation_bridge_unavailable'));
    });
  });
}

function checkWorkstation(expectPrimary) {
  const id = inspectBackgroundClient();
  const response = JSON.parse(
    run(
      'docker',
      ['exec', '-i', id, 'node', '-', expectPrimary ? '--expect-primary' : '--expect-offline'],
      {
        input: readFileSync(
          new URL('./commercial-llm-workstation-smoke.cjs', import.meta.url),
          'utf8',
        ),
        timeout: 115000,
        maxBuffer: 16384,
      },
    ),
  );
  emit('check_workstation', validateWorkstationSmokeResponse(response, expectPrimary));
}

export function validateWorkstationSmokeResponse(response, expectPrimary) {
  if (
    !hasExactKeys(response, [
      'ok',
      'casesPassed',
      'casesTotal',
      'expectPrimary',
      'cascadeVersion',
      'cases',
    ]) ||
    response.ok !== true ||
    response.casesPassed !== 2 ||
    response.casesTotal !== 2 ||
    response.expectPrimary !== expectPrimary ||
    response.cascadeVersion !== 'commercial-qwen4b9b-shadow-v1' ||
    !Array.isArray(response.cases) ||
    response.cases.length !== 2
  )
    throw new Error('workstation_smoke_refused');
  const expected = [
    {
      name: 'personal-used-item',
      classification: 'NOT_COMMERCIAL',
      route: expectPrimary ? 'primary' : 'secondary_unavailable',
    },
    {
      name: 'commercial-service',
      classification: 'COMMERCIAL',
      route: expectPrimary ? 'secondary_commercial' : 'secondary_unavailable',
    },
  ];
  for (let i = 0; i < expected.length; i++) {
    const item = response.cases[i];
    if (
      !hasExactKeys(item, [
        'name',
        'classification',
        'route',
        'modelAlias',
        'modelSha256',
        'promptSha256',
        'durationMs',
        'primaryDurationMs',
        'secondaryDurationMs',
      ]) ||
      item.modelAlias !==
        (expectPrimary && i === 0 ? WORKSTATION_IDENTITY.modelAlias : pin.alias) ||
      ![item.primaryDurationMs, item.secondaryDurationMs].every(
        (value) => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 80000),
      ) ||
      !Object.entries(expected[i]).every(([key, value]) => item[key] === value) ||
      item.promptSha256 !== pin.smokePromptSha256 ||
      item.modelSha256 !==
        (expectPrimary && i === 0 ? WORKSTATION_IDENTITY.modelSha256 : pin.modelSha256) ||
      !Number.isSafeInteger(item.durationMs) ||
      item.durationMs < 0 ||
      item.durationMs > 80000
    )
      throw new Error('workstation_smoke_refused');
  }
  return {
    ok: true,
    casesPassed: 2,
    casesTotal: 2,
    expectPrimary,
    cascadeVersion: response.cascadeVersion,
    cases: response.cases.map(
      ({
        name,
        classification,
        route,
        modelAlias,
        modelSha256,
        promptSha256,
        durationMs,
        primaryDurationMs,
        secondaryDurationMs,
      }) => ({
        name,
        classification,
        route,
        modelAlias,
        modelSha256,
        promptSha256,
        durationMs,
        primaryDurationMs,
        secondaryDurationMs,
      }),
    ),
  };
}

function buildReceipt(sourceSha, containerId, profile = pin) {
  const receipt = {
    schemaVersion: 1,
    sourceSha,
    installedAt: new Date().toISOString(),
    state: 'installed',
    containerId,
    imageRef: pin.imageRef,
    imageId: pin.imageId,
    modelSha256: pin.modelSha256,
    modelBytes: pin.modelBytes,
    modelManifestSha256: pin.modelManifestSha256,
    templateSha256: pin.templateSha256,
    licenseSha256: pin.licenseSha256,
    upstreamRevision: pin.upstreamRevision,
    upstreamVersion: pin.upstreamVersion,
    cpuLimit: pin.cpuLimit,
    memoryLimitBytes: pin.memoryLimitBytes,
    contextTokens: 4096,
    parallelRequests: 1,
    generationThreads: pin.cpuLimit,
    reasoning: false,
    smoke: 'closed-synthetic-json-v1',
    ...(profile.slotInspection === true
      ? {
          runtimeProfile: profile.runtimeProfile,
          commandSha256: commercialLlmCommandSha256(profile),
        }
      : {}),
  };
  assertCommercialLlmReceipt(receipt, profile);
  return receipt;
}

async function install(sourceSha) {
  ensureDirectory(stateDir);
  ensureDirectory(modelDir);
  const existing = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
  if (existing) {
    await reconcileCommercialLlmGeneration({
      operation: 'install',
      sourceSha,
      receipt: receiptPresent() ? readReceipt() : undefined,
      io: runtimeIo,
    });
    return;
  }
  if (receiptPresent()) {
    readReceipt();
    throw new Error('commercial_llm_recorded_generation_missing');
  }
  await prepareTargetArtifacts();
  await longCommand('docker', ['pull', '--platform', 'linux/amd64', pin.imageRef], {
    stage: 'image_pull',
    timeoutMs: 900000,
  });
  const image = JSON.parse(run('docker', ['image', 'inspect', pin.imageRef]));
  if (!Array.isArray(image) || image.length !== 1) {
    throw new Error('commercial_llm_image_pin_refused');
  }
  assertCommercialLlmImage(image[0]);
  emit('capacity', capacity(false));
  createPinnedContainer(slotsPin);
  const created = inspectContainer({
    profile: slotsPin,
    requireHealthy: false,
    requireRunning: false,
  });
  await waitUntilReady(created.Id);
  const container = smoke(created.Id);
  assertCommercialLlmContainer(container, { profile: slotsPin });
  const receipt = buildReceipt(sourceSha, container.Id, slotsPin);
  atomicWrite(pin.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  emit('install', { result: 'installed', ...receipt });
}

async function waitUntilReady(expectedContainerId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const container = inspectContainer({ requireHealthy: false, requireRunning: false });
    if (expectedContainerId && container.Id !== expectedContainerId) {
      throw new Error('commercial_llm_generation_changed');
    }
    if (container.State?.Running === true && container.State?.Health?.Status === 'healthy') return;
    emit('model_readiness', { event: 'waiting', deadline: new Date(deadline).toISOString() });
    await new Promise((done) => setTimeout(done, 10000));
  }
  throw new Error('commercial_llm_readiness_deadline');
}

async function verifyPinnedArtifacts(profile = pin) {
  await checksum(profile.modelPath, profile.modelSha256, profile.modelBytes);
  if (profile.templateMode === 'file')
    await checksum(profile.templatePath, profile.templateSha256, profile.templateBytes);
  await checksum(profile.licensePath, profile.licenseSha256, profile.licenseBytes);
}

async function prepareTargetArtifacts() {
  emit('capacity', capacity(!existsSync(pin.modelPath)));
  if (!existsSync(pin.modelPath) && existsSync(pin.cachedModelPath)) {
    await checksum(pin.cachedModelPath, pin.modelSha256, pin.modelBytes);
    const partial = `${pin.modelPath}.partial`;
    if (!existsSync(partial)) {
      copyFileSync(pin.cachedModelPath, partial);
      chmodSync(partial, 0o444);
    }
  }
  await downloadArtifact({
    path: pin.modelPath,
    sha256: pin.modelSha256,
    bytes: pin.modelBytes,
    stage: 'model_download',
    url: pin.modelUrl,
  });
  await downloadArtifact({
    path: pin.licensePath,
    sha256: pin.licenseSha256,
    bytes: pin.licenseBytes,
    stage: 'license_download',
    url: pin.licenseUrl,
  });
  await verifyPinnedArtifacts();
  emit('capacity', capacity(false));
}

export function assertCommercialLlmTemplate(props) {
  const template = props?.chat_template;
  if (
    typeof template !== 'string' ||
    Buffer.byteLength(template) !== pin.templateBytes ||
    createHash('sha256').update(template).digest('hex') !== pin.templateSha256
  ) {
    throw new Error('commercial_llm_template_identity_refused');
  }
}

export function assertCommercialLlmIdleSlots(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0]?.id !== 0 ||
    value[0]?.n_ctx !== 4096 ||
    value[0]?.is_processing !== false
  )
    throw new Error('commercial_llm_idle_slots_unproved');
  return value;
}

// FLAG: Recovery may adopt only a positively attested generation with all pinned artifacts.
// A present invalid receipt must never be interpreted as an interrupted unrecorded install.
export async function reconcileCommercialLlmGeneration({ operation, sourceSha, receipt, io }) {
  if (!['install', 'stop'].includes(operation) || !safeSha.test(sourceSha ?? '')) {
    throw new Error('commercial_llm_generation_operation_refused');
  }
  if (receipt !== undefined) assertCommercialLlmReceipt(receipt);
  const before = await io.inspect();
  const profile = receipt
    ? commercialLlmReceiptProfile(receipt)
    : commercialLlmContainerProfile(before);
  assertCommercialLlmContainer(before, { profile, requireHealthy: false, requireRunning: false });
  if (receipt && receipt.containerId !== before.Id) {
    throw new Error('commercial_llm_existing_runtime_receipt_mismatch');
  }
  await io.verifyArtifacts();
  const inspectSameGeneration = async (requireHealthy = false) => {
    const current = await io.inspect();
    assertCommercialLlmContainer(current, {
      profile,
      requireHealthy,
      requireRunning: requireHealthy,
    });
    if (current.Id !== before.Id) throw new Error('commercial_llm_generation_changed');
    return current;
  };
  let current = await inspectSameGeneration();
  if (operation === 'stop') {
    await io.stop(before.Id);
    current = await inspectSameGeneration();
    if (current.State?.Running !== false) throw new Error('commercial_llm_stop_readback_refused');
    if (receipt) {
      await io.record({ ...receipt, state: 'stopped', stoppedAt: new Date().toISOString() });
    }
    const outcome = {
      result: receipt ? 'stopped' : 'unrecorded_generation_stopped',
      containerId: before.Id,
      retainedArtifacts: true,
      successReceiptWritten: false,
      runtimeActivation: 'api_shadow_flag_requires_separate_disable_and_deploy',
    };
    io.emit('stop', outcome);
    return outcome;
  }
  const restarting = current.State?.Running !== true;
  if (restarting) {
    await io.capacity();
    await io.start(before.Id);
  }
  await io.waitReady(before.Id);
  const smoked = await io.smoke(before.Id);
  if (smoked?.Id !== before.Id) throw new Error('commercial_llm_generation_changed');
  await inspectSameGeneration(true);
  const nextReceipt = receipt
    ? { ...receipt, state: 'installed', validatedAt: new Date().toISOString() }
    : buildReceipt(sourceSha, before.Id, profile);
  assertCommercialLlmReceipt(nextReceipt, profile);
  await io.record(nextReceipt);
  const outcome = {
    result: receipt ? 'already_installed' : 'recovered_unrecorded_generation',
    sourceSha: nextReceipt.sourceSha,
    containerId: before.Id,
    successReceiptWritten: true,
  };
  io.emit('install', outcome);
  return outcome;
}

const runtimeIo = {
  inspect: () => inspectContainer({ requireHealthy: false, requireRunning: false }),
  verifyArtifacts: verifyPinnedArtifacts,
  capacity: () => emit('capacity', capacity(false)),
  start: (id) => run('docker', ['start', id], { timeout: 60000 }),
  stop: (id) => run('docker', ['stop', '--time', '30', id], { timeout: 40000 }),
  waitReady: waitUntilReady,
  smoke,
  record: (receipt) => atomicWrite(pin.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`),
  emit,
};

export function commercialLlmCreationOverride(profile) {
  if (profile !== pin && profile !== slotsPin)
    throw new Error('commercial_llm_creation_profile_refused');
  return JSON.stringify({
    services: { [pin.service]: { command: commercialLlmCommand(profile) } },
  });
}

function createPinnedContainer(profile) {
  // FLAG: Only named install/upgrade operations may enable slots. The historical Compose
  // baseline and replacement retain no-slots; only fixed commands enter this private override.
  run(
    'docker',
    [
      ...composeArgs,
      '-f',
      '-',
      '--profile',
      'commercial-llm',
      'up',
      '-d',
      '--no-deps',
      '--no-build',
      '--pull',
      'never',
      pin.service,
    ],
    { input: commercialLlmCreationOverride(profile), timeout: 60000 },
  );
}

export function assertCommercialLlmTransition(value, sourceSha) {
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== 'gemma4-to-qwen35-9b-v1' ||
    value.sourceSha !== sourceSha ||
    !safeSha.test(sourceSha ?? '') ||
    value.targetModelSha256 !== pin.modelSha256 ||
    !['prepared', 'started', 'complete'].includes(value.phase) ||
    !Number.isFinite(Date.parse(value.startedAt ?? '')) ||
    (value.targetContainerId !== null && !/^[0-9a-f]{64}$/u.test(value.targetContainerId ?? '')) ||
    (value.phase !== 'prepared' && value.targetContainerId === null)
  )
    throw new Error('commercial_llm_transition_refused');
  assertCommercialLlmReceipt(value.previousReceipt, COMMERCIAL_LLM_LEGACY_RUNTIME);
  return value;
}

// FLAG: Replacement stops only the captured, fully attested old generation before creating one
// target. The durable journal keeps its receipt; interruption never licenses an unrelated removal.
export async function replaceCommercialLlmGeneration({ sourceSha, receipt, transition, io }) {
  if (!safeSha.test(sourceSha ?? '')) throw new Error('commercial_llm_exact_source_required');
  let journal = transition;
  if (journal !== undefined) assertCommercialLlmTransition(journal, sourceSha);
  else assertCommercialLlmReceipt(receipt, COMMERCIAL_LLM_LEGACY_RUNTIME);

  const previous = journal?.previousReceipt ?? receipt;
  const currentIsTarget = receipt?.modelSha256 === pin.modelSha256;
  assertCommercialLlmReceipt(receipt, currentIsTarget ? pin : COMMERCIAL_LLM_LEGACY_RUNTIME);
  if (!currentIsTarget && JSON.stringify(receipt) !== JSON.stringify(previous))
    throw new Error('commercial_llm_transition_receipt_drift');
  if (currentIsTarget && (!journal || journal.targetContainerId !== receipt.containerId))
    throw new Error('commercial_llm_transition_receipt_drift');

  const attest = (container) => {
    if (!container) return null;
    const legacy =
      container.Config?.Labels?.['com.maxim.commercial-llm-model-sha256'] ===
      COMMERCIAL_LLM_LEGACY_RUNTIME.modelSha256;
    assertCommercialLlmContainer(container, {
      profile: legacy ? COMMERCIAL_LLM_LEGACY_RUNTIME : pin,
      requireHealthy: false,
      requireRunning: false,
    });
    if (
      legacy &&
      (container.Id !== previous.containerId || journal?.targetContainerId || currentIsTarget)
    )
      throw new Error('commercial_llm_generation_changed');
    if (
      !legacy &&
      (!journal || (journal.targetContainerId && container.Id !== journal.targetContainerId))
    )
      throw new Error('commercial_llm_generation_changed');
    return legacy ? 'legacy' : 'target';
  };
  let observed = await io.inspect();
  let kind = attest(observed);
  if (!journal && kind !== 'legacy') throw new Error('commercial_llm_recorded_generation_missing');
  if (journal?.targetContainerId && kind !== 'target')
    throw new Error('commercial_llm_recorded_generation_missing');
  if (journal?.phase === 'complete') {
    if (!currentIsTarget || receipt.state !== 'installed')
      throw new Error('commercial_llm_transition_receipt_drift');
    assertCommercialLlmContainer(observed, { profile: pin });
    return { result: 'already_replaced', containerId: observed.Id };
  }
  await io.prepare();
  if (!journal) {
    journal = {
      schemaVersion: 1,
      kind: 'gemma4-to-qwen35-9b-v1',
      sourceSha,
      targetModelSha256: pin.modelSha256,
      phase: 'prepared',
      startedAt: new Date().toISOString(),
      previousReceipt: previous,
      targetContainerId: null,
    };
    await io.recordTransition(journal);
  }
  const capturedId = observed?.Id;
  observed = await io.inspect();
  kind = attest(observed);
  if (observed?.Id !== capturedId) throw new Error('commercial_llm_generation_changed');
  if (kind === 'legacy') {
    await io.stop(observed.Id);
    observed = await io.inspect();
    if (attest(observed) !== 'legacy' || observed.State?.Running !== false)
      throw new Error('commercial_llm_stop_readback_refused');
    await io.remove(observed.Id);
    observed = await io.inspect();
    if (observed) throw new Error('commercial_llm_generation_changed');
  }
  if (!observed) {
    await io.create();
    observed = await io.inspect();
    if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  }
  if (!journal.targetContainerId) {
    journal = { ...journal, phase: 'started', targetContainerId: observed.Id };
    await io.recordTransition(journal);
  }
  const targetId = journal.targetContainerId;
  observed = await io.inspect();
  if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  if (!observed.State.Running) await io.start(targetId);
  await io.waitReady(targetId);
  const smoked = await io.smoke(targetId);
  if (smoked?.Id !== targetId) throw new Error('commercial_llm_generation_changed');
  observed = await io.inspect();
  if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  assertCommercialLlmContainer(observed, { profile: pin });
  const nextReceipt = currentIsTarget ? receipt : buildReceipt(sourceSha, targetId);
  await io.record(nextReceipt);
  await io.recordTransition({
    ...journal,
    phase: 'complete',
    completedAt: new Date().toISOString(),
  });
  return { result: 'replaced', containerId: targetId, retainedPreviousArtifacts: true };
}

async function replace(sourceSha) {
  ensureDirectory(stateDir);
  ensureDirectory(modelDir);
  assertSafeFile(pin.receiptPath, { maximumBytes: 16384 });
  const receipt = JSON.parse(readFileSync(pin.receiptPath, 'utf8'));
  let transition;
  if (lstatSync(pin.transitionPath, { throwIfNoEntry: false }) !== undefined) {
    assertSafeFile(pin.transitionPath, { maximumBytes: 32768 });
    transition = JSON.parse(readFileSync(pin.transitionPath, 'utf8'));
  }
  const outcome = await replaceCommercialLlmGeneration({
    sourceSha,
    receipt,
    transition,
    io: {
      ...runtimeIo,
      inspect: () => {
        const ids = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
        if (!ids) return null;
        if (!/^[0-9a-f]{64}$/u.test(ids)) throw new Error('commercial_llm_singleton_required');
        const rows = JSON.parse(run('docker', ['inspect', ids]));
        if (rows.length !== 1) throw new Error('commercial_llm_singleton_required');
        const profile =
          rows[0].Config?.Labels?.['com.maxim.commercial-llm-model-sha256'] ===
          COMMERCIAL_LLM_LEGACY_RUNTIME.modelSha256
            ? COMMERCIAL_LLM_LEGACY_RUNTIME
            : pin;
        const verified = inspectContainer({
          requireHealthy: false,
          requireRunning: false,
          profile,
        });
        if (verified.Id !== ids) throw new Error('commercial_llm_generation_changed');
        return verified;
      },
      prepare: async () => {
        await verifyPinnedArtifacts(COMMERCIAL_LLM_LEGACY_RUNTIME);
        await prepareTargetArtifacts();
        const images = JSON.parse(run('docker', ['image', 'inspect', pin.imageRef]));
        if (images.length !== 1) throw new Error('commercial_llm_image_pin_refused');
        assertCommercialLlmImage(images[0]);
      },
      remove: (id) => run('docker', ['rm', id]),
      create: () => createPinnedContainer(pin),
      recordTransition: (value) => {
        assertCommercialLlmTransition(value, sourceSha);
        atomicWrite(pin.transitionPath, `${JSON.stringify(value, null, 2)}\n`);
      },
    },
  });
  emit('replace', outcome);
}

export function assertCommercialLlmSlotsTransition(value, sourceSha) {
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== 'qwen35-9b-slots-v1' ||
    !safeSha.test(sourceSha ?? '') ||
    value.sourceSha !== sourceSha ||
    value.previousCommandSha256 !== commercialLlmCommandSha256(pin) ||
    value.targetCommandSha256 !== commercialLlmCommandSha256(slotsPin) ||
    value.targetModelSha256 !== pin.modelSha256 ||
    !['prepared', 'started', 'complete'].includes(value.phase) ||
    !Number.isFinite(Date.parse(value.startedAt ?? '')) ||
    (value.targetContainerId !== null && !/^[0-9a-f]{64}$/u.test(value.targetContainerId ?? '')) ||
    (value.phase === 'prepared'
      ? value.targetContainerId !== null
      : value.targetContainerId === null) ||
    (value.phase === 'complete' && !Number.isFinite(Date.parse(value.completedAt ?? '')))
  )
    throw new Error('commercial_llm_slots_transition_refused');
  assertCommercialLlmReceipt(value.previousReceipt, pin);
  if (value.previousReceipt.containerId === value.targetContainerId)
    throw new Error('commercial_llm_slots_transition_refused');
  return value;
}

// FLAG: The same model hash cannot distinguish these generations. Both commands, the original
// receipt and the captured container IDs bind this separate journal; the Gemma journal is retained.
export async function upgradeCommercialLlmSlots({
  sourceSha,
  receipt,
  transition,
  previousTransition,
  io,
  apply = false,
}) {
  if (!safeSha.test(sourceSha ?? '')) throw new Error('commercial_llm_exact_source_required');
  let journal = transition;
  if (journal !== undefined) assertCommercialLlmSlotsTransition(journal, sourceSha);
  else assertCommercialLlmReceipt(receipt, pin);
  const previous = journal?.previousReceipt ?? receipt;
  const currentIsTarget = commercialLlmReceiptProfile(receipt) === slotsPin;
  assertCommercialLlmReceipt(receipt, currentIsTarget ? slotsPin : pin);
  if (
    (!currentIsTarget && JSON.stringify(receipt) !== JSON.stringify(previous)) ||
    (currentIsTarget &&
      (!journal ||
        journal.targetContainerId !== receipt.containerId ||
        receipt.sourceSha !== sourceSha))
  )
    throw new Error('commercial_llm_transition_receipt_drift');
  if (previousTransition !== undefined) {
    assertCommercialLlmTransition(previousTransition, previousTransition.sourceSha);
    if (
      previousTransition.phase !== 'complete' ||
      previousTransition.sourceSha !== previous.sourceSha ||
      previousTransition.targetContainerId !== previous.containerId
    )
      throw new Error('commercial_llm_predecessor_transition_unsettled');
  }
  const attest = (container) => {
    if (!container) return null;
    const profile = commercialLlmContainerProfile(container);
    assertCommercialLlmContainer(container, {
      profile,
      requireHealthy: false,
      requireRunning: false,
    });
    if (
      profile === pin &&
      (container.Id !== previous.containerId || journal?.targetContainerId || currentIsTarget)
    )
      throw new Error('commercial_llm_generation_changed');
    if (
      profile === slotsPin &&
      (!journal ||
        container.Id === previous.containerId ||
        (journal.targetContainerId && container.Id !== journal.targetContainerId))
    )
      throw new Error('commercial_llm_generation_changed');
    return profile === pin ? 'previous' : 'target';
  };
  let observed = await io.inspect();
  let kind = attest(observed);
  if (!journal && kind !== 'previous')
    throw new Error('commercial_llm_recorded_generation_missing');
  if (journal?.targetContainerId && kind !== 'target')
    throw new Error('commercial_llm_recorded_generation_missing');
  if (journal?.phase === 'complete') {
    if (!currentIsTarget || receipt.state !== 'installed')
      throw new Error('commercial_llm_transition_receipt_drift');
    assertCommercialLlmContainer(observed, { profile: slotsPin });
    return {
      result: 'already_upgraded',
      containerId: observed.Id,
      runtimeProfile: slotsPin.runtimeProfile,
    };
  }
  if (!apply)
    return {
      result: 'preview',
      operation: 'upgrade-slots',
      sourceSha,
      phase: journal?.phase ?? 'not_started',
      previousContainerId: previous.containerId,
      currentContainerId: observed?.Id ?? null,
      previousCommandSha256: commercialLlmCommandSha256(pin),
      targetCommandSha256: commercialLlmCommandSha256(slotsPin),
      targetRuntimeProfile: slotsPin.runtimeProfile,
    };
  await io.prepare();
  if (!journal) {
    journal = {
      schemaVersion: 1,
      kind: 'qwen35-9b-slots-v1',
      sourceSha,
      previousCommandSha256: commercialLlmCommandSha256(pin),
      targetCommandSha256: commercialLlmCommandSha256(slotsPin),
      targetModelSha256: pin.modelSha256,
      previousReceipt: previous,
      phase: 'prepared',
      startedAt: new Date().toISOString(),
      targetContainerId: null,
    };
    await io.recordTransition(journal);
  }
  const capturedId = observed?.Id;
  observed = await io.inspect();
  kind = attest(observed);
  if (observed?.Id !== capturedId) throw new Error('commercial_llm_generation_changed');
  if (kind === 'previous') {
    await io.stop(observed.Id);
    observed = await io.inspect();
    if (attest(observed) !== 'previous' || observed.State?.Running !== false)
      throw new Error('commercial_llm_stop_readback_refused');
    await io.remove(observed.Id);
    observed = await io.inspect();
    if (observed) throw new Error('commercial_llm_generation_changed');
  }
  if (!observed) {
    await io.create();
    observed = await io.inspect();
    if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  }
  if (!journal.targetContainerId) {
    journal = { ...journal, phase: 'started', targetContainerId: observed.Id };
    await io.recordTransition(journal);
  }
  const targetId = journal.targetContainerId;
  observed = await io.inspect();
  if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  if (!observed.State.Running) await io.start(targetId);
  await io.waitReady(targetId);
  const smoked = await io.smoke(targetId);
  if (smoked?.Id !== targetId) throw new Error('commercial_llm_generation_changed');
  observed = await io.inspect();
  if (attest(observed) !== 'target') throw new Error('commercial_llm_target_missing');
  assertCommercialLlmContainer(observed, { profile: slotsPin });
  const nextReceipt = currentIsTarget ? receipt : buildReceipt(sourceSha, targetId, slotsPin);
  await io.record(nextReceipt);
  await io.recordTransition({
    ...journal,
    phase: 'complete',
    completedAt: new Date().toISOString(),
  });
  return { result: 'upgraded', containerId: targetId, runtimeProfile: slotsPin.runtimeProfile };
}

async function upgradeSlots(sourceSha, apply) {
  const readJournal = (path) => {
    if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
    assertSafeFile(path, { maximumBytes: 32768 });
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const outcome = await upgradeCommercialLlmSlots({
    sourceSha,
    receipt: readReceipt(),
    transition: readJournal(slotsPin.transitionPath),
    previousTransition: readJournal(pin.transitionPath),
    apply,
    io: {
      ...runtimeIo,
      inspect: () => {
        const ids = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
        if (!ids) return null;
        const observed = inspectContainer({ requireHealthy: false, requireRunning: false });
        if (observed.Id !== ids) throw new Error('commercial_llm_generation_changed');
        return observed;
      },
      prepare: async () => {
        await verifyPinnedArtifacts();
        emit('capacity', capacity(false));
        const images = JSON.parse(run('docker', ['image', 'inspect', pin.imageRef]));
        if (images.length !== 1) throw new Error('commercial_llm_image_pin_refused');
        assertCommercialLlmImage(images[0]);
      },
      remove: (id) => run('docker', ['rm', id]),
      create: () => createPinnedContainer(slotsPin),
      recordTransition: (value) => {
        assertCommercialLlmSlotsTransition(value, sourceSha);
        atomicWrite(slotsPin.transitionPath, `${JSON.stringify(value, null, 2)}\n`);
      },
    },
  });
  emit('upgrade_slots', outcome);
}

function status() {
  if (!receiptPresent()) {
    const existing = run('docker', [...composeArgs, 'ps', '-a', '-q', pin.service]);
    emit('status', { installed: false, unrecordedContainerPresent: existing !== '' });
    if (existing) throw new Error('commercial_llm_unrecorded_runtime');
    return;
  }
  const receipt = readReceipt();
  const container = inspectContainer({
    profile: commercialLlmReceiptProfile(receipt),
    requireHealthy: receipt.state === 'installed',
    requireRunning: receipt.state === 'installed',
  });
  if (container.Id !== receipt.containerId) throw new Error('commercial_llm_receipt_runtime_drift');
  if (receipt.state === 'stopped') {
    if (container.State?.Running !== false)
      throw new Error('commercial_llm_stopped_receipt_runtime_drift');
    emit('status', receipt);
    return;
  }
  emit('status', {
    ...receipt,
    running: true,
    healthy: true,
    restartCount: container.RestartCount,
    cpuLimit: pin.cpuLimit,
    memoryLimitBytes: pin.memoryLimitBytes,
  });
}

function cpuRecoveryGeneration(container) {
  return {
    id: container.Id,
    imageId: container.Image,
    startedAt: container.State.StartedAt,
    restartCount: container.RestartCount,
    running: container.State.Running,
  };
}

export async function waitCommercialLlmCpuDispatcherReady(
  generation,
  {
    inspect = () => inspectReleaseApiClient('api-moderation-background'),
    now = Date.now,
    pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    progress = () => {},
  } = {},
) {
  const deadline = now() + 180000;
  let observedAt = null;
  while (now() < deadline) {
    const client = inspect();
    if (now() >= deadline) break;
    assertCommercialLlmApiClient(client, {
      service: 'api-moderation-background',
      imageId: generation.imageId,
    });
    const observed = cpuRecoveryGeneration(client);
    if (
      client.State.Status !== 'running' ||
      client.State.Paused !== false ||
      client.State.Restarting !== false ||
      client.State.Dead !== false ||
      ['id', 'imageId', 'startedAt', 'restartCount'].some(
        (key) => observed[key] !== generation[key],
      )
    )
      throw new Error('commercial_llm_cpu_recovery_generation_drift');
    // FLAG: This role is headless and has no Docker healthcheck. Its maintained role
    // readiness is the attested running generation, stable across independent reads.
    // Functional CPU work and admission losses require the separate acceptance window.
    if (observedAt !== null && now() - observedAt >= 5000) {
      if (now() >= deadline) break;
      return;
    }
    observedAt ??= now();
    progress(new Date(deadline).toISOString());
    await pause(5000);
  }
  throw new Error('commercial_llm_cpu_recovery_dispatcher_readiness_deadline');
}

async function recoverCpuQuarantine(sourceSha, operationId, expectedPlanSha256) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      operationId ?? '',
    )
  )
    throw new Error('commercial_llm_cpu_recovery_identity_invalid');
  const journalPath = `${stateDir}/cpu-recovery-${operationId}.json`;
  const readJournal = () => {
    if (!existsSync(journalPath)) return undefined;
    assertSafeFile(journalPath, { maximumBytes: 32768 });
    return parseCommercialLlmModelJson(readFileSync(journalPath, 'utf8'));
  };
  const snapshot = () => {
    sourceAdmission(sourceSha);
    const receipt = readReceipt();
    if (receipt.state !== 'installed' || commercialLlmReceiptProfile(receipt) !== slotsPin)
      throw new Error('commercial_llm_cpu_recovery_installed_slots_required');
    const model = inspectContainer({
      profile: slotsPin,
      requireHealthy: false,
      requireRunning: false,
    });
    if (model.Id !== receipt.containerId)
      throw new Error('commercial_llm_cpu_recovery_model_receipt_drift');
    return {
      model: cpuRecoveryGeneration(model),
      dispatcher: cpuRecoveryGeneration(
        inspectReleaseApiClient('api-moderation-background', { requireRunning: false }),
      ),
    };
  };
  const leaseCommand = (operation, fingerprint) => {
    const admin = inspectReleaseApiClient('api-admin');
    const helperPath = 'infra/scripts/commercial-llm-cpu-lease.cjs';
    assertSafeFile(helperPath, { maximumBytes: 32768 });
    const result = parseCommercialLlmModelJson(
      run(
        'docker',
        [
          'exec',
          '-i',
          admin.Id,
          'node',
          '-',
          operation,
          operationId,
          ...(fingerprint ? [fingerprint] : []),
        ],
        {
          input: readFileSync(helperPath, 'utf8'),
          timeout: 5000,
          maxBuffer: 8192,
        },
      ),
    );
    if (result.schemaVersion !== 1 || result.operationId !== operationId)
      throw new Error('commercial_llm_cpu_recovery_lease_observation_invalid');
    return result.state === 'held_persistent'
      ? { state: 'held', fingerprint: result.fingerprint, ttlMs: result.leaseTtlMs }
      : { state: result.state, fingerprint: result.fingerprint };
  };
  const stop = (role, expected) => {
    const before = snapshot()[role];
    if (['id', 'imageId', 'startedAt', 'restartCount'].some((key) => before[key] !== expected[key]))
      throw new Error('commercial_llm_cpu_recovery_generation_drift');
    run('docker', ['stop', '--time', '30', expected.id], { timeout: 40000 });
  };
  const start = (role, expected) => {
    const before = snapshot()[role];
    if (
      before.running ||
      ['id', 'imageId', 'startedAt', 'restartCount'].some((key) => before[key] !== expected[key])
    )
      throw new Error('commercial_llm_cpu_recovery_generation_drift');
    run('docker', ['start', expected.id], { timeout: 60000 });
  };
  const existing = readJournal();
  const planSourceSha = assertCommercialLlmCpuControllerIdentity({
    controllerSha: sourceSha,
    journal: existing,
    repositoryRoot: process.cwd(),
  });
  const requireOriginalControllerForMutation = () => {
    // FLAG: Compatible old-source tail completion may attest and journal readiness only.
    // It cannot start/stop a process or perform another lease CAS, even after later drift.
    if (planSourceSha !== sourceSha)
      throw new Error('commercial_llm_cpu_recovery_late_resume_mutation_refused');
  };
  if (expectedPlanSha256 && existing?.phase !== 'complete') {
    // FLAG: These existing floors and pinned artifacts apply before either captured process stops.
    // Recovery changes no image, model weights, source proof, cooldown or other Redis key.
    emit('capacity', capacity(false));
    await verifyPinnedArtifacts(slotsPin);
  }
  const result = await recoverCommercialLlmCpuQuarantine({
    sourceSha: planSourceSha,
    operationId,
    expectedPlanSha256,
    apply: expectedPlanSha256 !== undefined,
    io: {
      snapshot,
      readJournal,
      writeJournal: (journal) => {
        atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
        emit('cpu_recovery_progress', { operationId, phase: journal.phase });
      },
      leaseStatus: () => leaseCommand('observe'),
      releaseLease: (_operationId, fingerprint) => {
        requireOriginalControllerForMutation();
        // FLAG: Reattest both original stopped generations immediately before the exact CAS.
        // An idle slot or a missing key is never proof that this operation released its lease.
        const journal = readJournal();
        const current = snapshot();
        for (const role of ['model', 'dispatcher']) {
          if (
            current[role].running ||
            ['id', 'imageId', 'startedAt', 'restartCount'].some(
              (key) => current[role][key] !== journal.plan[role][key],
            )
          )
            throw new Error('commercial_llm_cpu_recovery_generation_drift');
        }
        const released = leaseCommand('release', fingerprint);
        if (released.state !== 'released_receipt' || released.fingerprint !== fingerprint)
          throw new Error('commercial_llm_cpu_recovery_release_unproved');
      },
      stopDispatcher: (generation) => {
        requireOriginalControllerForMutation();
        return stop('dispatcher', generation);
      },
      stopModel: (generation) => {
        requireOriginalControllerForMutation();
        return stop('model', generation);
      },
      startModel: (generation) => {
        requireOriginalControllerForMutation();
        return start('model', generation);
      },
      startDispatcher: (generation) => {
        requireOriginalControllerForMutation();
        return start('dispatcher', generation);
      },
      waitModelReady: async (generation) => {
        await waitUntilReady(generation.id);
        smoke(generation.id);
      },
      waitDispatcherReady: (generation) =>
        waitCommercialLlmCpuDispatcherReady(generation, {
          progress: (deadline) =>
            emit('cpu_recovery_readiness', {
              operationId,
              component: 'dispatcher',
              deadline,
            }),
        }),
    },
  });
  emit('cpu_quarantine_recovery', { ...result, controllerSha: sourceSha });
}

async function cli(argv) {
  const [operation = 'status', ...args] = argv;
  if (operation === 'recover-cpu-quarantine') {
    if (
      !(
        args.length === 1 ||
        (args.length === 3 && args[1] === '--apply' && /^[0-9a-f]{64}$/u.test(args[2]))
      )
    )
      throw new Error(
        'Usage: commercial-llm recover-cpu-quarantine <operation-uuid> [--apply <preview-sha256>]',
      );
    const sourceSha = process.env.MAXIM_EXPECTED_DEPLOY_SHA;
    sourceAdmission(sourceSha);
    return recoverCpuQuarantine(sourceSha, args[0], args[2]);
  }
  if (operation === 'workstation-pool-bridge') {
    if (args.length !== 1) throw new Error('Usage: workstation-pool-bridge pc-a-4b|pc-b-9b');
    return workstationBridge(args[0]);
  }
  if (
    ![
      'install',
      'replace',
      'upgrade-slots',
      'status',
      'stop',
      'enable',
      'disable',
      'smoke',
      'check-client',
      'workstation-bridge',
      'check-workstation',
      'check-workstation-offline',
    ].includes(operation) ||
    args.some((arg) => arg !== '--apply') ||
    args.length > 1 ||
    ([
      'status',
      'smoke',
      'check-client',
      'workstation-bridge',
      'check-workstation',
      'check-workstation-offline',
    ].includes(operation) &&
      args.length)
  ) {
    throw new Error(
      'Usage: commercial-llm install|replace|upgrade-slots|enable|disable|stop [--apply] | status | smoke | check-client',
    );
  }
  if (operation === 'status') return status();
  if (operation === 'smoke') return smoke();
  if (operation === 'check-client') return checkClient();
  if (operation === 'workstation-bridge') return workstationBridge();
  if (operation === 'check-workstation') return checkWorkstation(true);
  if (operation === 'check-workstation-offline') return checkWorkstation(false);
  const sourceSha = process.env.MAXIM_EXPECTED_DEPLOY_SHA;
  sourceAdmission(sourceSha);
  if (operation === 'upgrade-slots') return upgradeSlots(sourceSha, args.includes('--apply'));
  if (!args.includes('--apply')) {
    emit('preview', {
      operation,
      sourceSha,
      imageRef: pin.imageRef,
      modelSha256: pin.modelSha256,
      modelBytes: pin.modelBytes,
      cpuLimit: pin.cpuLimit,
      memoryLimitBytes: pin.memoryLimitBytes,
    });
    return;
  }
  if (operation === 'install') return install(sourceSha);
  if (operation === 'replace') return replace(sourceSha);
  if (operation === 'enable' || operation === 'disable') {
    if (operation === 'enable') {
      const receipt = readReceipt();
      const container = inspectContainer({ profile: commercialLlmReceiptProfile(receipt) });
      if (receipt.state !== 'installed' || receipt.containerId !== container.Id)
        throw new Error('commercial_llm_enable_receipt_refused');
      smoke();
    }
    assertSafeFile('.env', { maximumBytes: 1024 * 1024 });
    atomicWrite(
      '.env',
      patchCommercialLlmEnvironment(readFileSync('.env', 'utf8'), operation === 'enable'),
    );
    emit(operation, {
      result: 'environment_staged',
      enabled: operation === 'enable',
      runtimeActivation: 'requires_normal_api_deploy',
    });
    return;
  }
  await reconcileCommercialLlmGeneration({
    operation: 'stop',
    sourceSha,
    receipt: receiptPresent() ? readReceipt() : undefined,
    io: runtimeIo,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
