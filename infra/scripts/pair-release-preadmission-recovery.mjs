#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, lstat, readFile, readlink, mkdir, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify, types } from 'node:util';
import { once } from 'node:events';
import { dirname, join, parse } from 'node:path';
import { createRequire } from 'node:module';

export const PREADMISSION_SOURCE = '4345d1210212ab26c9c892badc8b16e67cb918bc';
export const PREADMISSION_CONTRACT = Object.freeze({
  ownerSha256: '26cb8346bc18f328df52a466f26bb0ce17e6a9ee125ca05f2a33b2c1a5096af4',
  ownerStartedAt: '2026-11-09T07:56:17.713Z',
  operationChangedAt: '2026-11-09T07:56:18.638Z',
  contextSha256: 'b29f3dc0a752889609c56623df2d12c6e08ddd57c825ff3d0565ff6c64ab04e7',
  queueControlSha256: 'bfcc4a968cb5e427ba4f2f1bcad9060224b3812f398dd3036911af127c10abe9',
  coldSha256: '72c3217112020ff4b20d7939dea50a8cd76bfce7bbc4eb8c0dd8edbfc4054b6d',
  markerSha256: 'fbb65106029bfb56e42cf5df74977e8d0793fac2ff9d05cc956f485a8d187ac3',
  backlogSha256: 'b21bffd51958b2aeb5e00c5bf8a28d3bef9af478f9504f0c0aab598bfafdb3ce',
});
export const PREADMISSION_SERVICES = Object.freeze([
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
  'ocr-native-sandbox',
  'photo-native-sandbox',
]);
const ROOT = '/var/lib/major-karavan-release';
const MAJOR = '/var/www/Chat_bot';
const KARAVAN = '/var/www/max-delivery-platform';
const STATE = '/var/lib/maxim-deploy';
const OWNER = `${ROOT}/state/admission.owner`;
const PRIVATE = `${STATE}/legacy-cold-private`;
const LOCKS = [
  `${ROOT}/state/admission.lock`,
  `${STATE}/deploy.lock`,
  `${KARAVAN}/var/ops/karavan-production-operation.lock`,
];
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const SOURCE = /^[a-f0-9]{40}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const execute = promisify(execFile);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const requireFact = (fact, code) => {
  if (!fact) fail(code);
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const started = Date.parse(PREADMISSION_CONTRACT.ownerStartedAt);
const changed = Date.parse(PREADMISSION_CONTRACT.operationChangedAt);
const validDate = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,9}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const canonicalDigest = (value) => digest(JSON.stringify(canonical(value)));

const SHADOW_SERVICE = 'gemma-commercial-shadow';
const SHADOW_NAME = '/infra-gemma-commercial-shadow-1';
const SHADOW_NETWORK = 'infra_commercial_llm_internal';
const SHADOW_PROFILE = 'qwen35-9b-slots-v1';
const SHADOW_IMAGE = 'sha256:8badce92ec1860c764ca19c736422e81a12c65d76da57313651a7804bfe6ed40';
const SHADOW_MODEL = 'dc2a39aef291f91a9116ad214058da0d86eb648743a124bd8c333787c4b9c91c';
const SHADOW_COMMAND = 'ab089ab1c6bc2720eb9414110d4eb8248e9b3687fe211401eabea5d18f43e898';
// FLAG: Only these seven historical 4345 blobs and nine literal import edges may
// supply the pure shadow guards. Import verified memory, never reopened checkout paths.
const shadowGraph = [
  [
    'release-manifest.mjs',
    24579,
    '0d552d61088c74aafd001063a900042e124774da17f4564b189f6101eebb5c2d',
    [],
  ],
  [
    'commercial-llm-workstation-profile.mjs',
    2400,
    'ea78495881193d96ec1dd636125a75beaee96e42596d126b5bed4a83ff3bf29d',
    [],
  ],
  [
    'commercial-llm-profiles.mjs',
    4950,
    '604d3457ad07f87a8f2d6635fe2117df1f2267ccad6bfceb0d0b67fb68758fae',
    [],
  ],
  [
    'commercial-llm-cpu-recovery.mjs',
    13017,
    'f8ba29b00114d2608acb5b9a4d16d38bb73fd678f949f4d1e3a02e39ab9ead96',
    [],
  ],
  [
    'commercial-llm-cpu-controller-identity.mjs',
    3652,
    'd75433d47c4e6a7d9349c92fa7dc09ab02999b488948fbded2de19d0e27e7592',
    ['commercial-llm-cpu-recovery.mjs'],
  ],
  [
    'commercial-llm-pool-profile.mjs',
    4538,
    'b3040adb42e3f62879cfcf5c5e23609c3e36850272c687b4fc1cc8572560419b',
    ['commercial-llm-workstation-profile.mjs', 'commercial-llm-profiles.mjs'],
  ],
  [
    'commercial-llm-runtime.mjs',
    72002,
    '80bf5e81a2a19606c261faad5eac82bc6b57f5350681e5f7548366f268e44ec4',
    [
      'release-manifest.mjs',
      'commercial-llm-workstation-profile.mjs',
      'commercial-llm-pool-profile.mjs',
      'commercial-llm-cpu-recovery.mjs',
      'commercial-llm-cpu-controller-identity.mjs',
      'commercial-llm-profiles.mjs',
    ],
  ],
];
const shadowEnvironment = [
  'LLAMA_ARG_HOST=0.0.0.0',
  'LLAMA_ARG_PORT=8080',
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
];
const shadowMounts = [
  {
    type: 'bind',
    source: `/var/lib/maxim-deploy/commercial-llm/models/${SHADOW_MODEL}.gguf`,
    destination: '/models/qwen35-9b.gguf',
    readOnly: true,
  },
];
const shadowConfiguration = Object.freeze({
  user: '1000:1000',
  entrypointSha256: digest(JSON.stringify(['/app/llama-server'])),
  environmentSha256: digest(JSON.stringify([...shadowEnvironment].sort())),
  commandSha256: SHADOW_COMMAND,
  mountsSha256: canonicalDigest(shadowMounts),
  readonlyRootfs: true,
  init: true,
  nanoCpus: 6e9,
  cpuShares: 128,
  memory: 12 * 1024 ** 3,
  memorySwap: 12 * 1024 ** 3,
  pidsLimit: 128,
  capDropAll: true,
  capAddCount: 0,
  devicesCount: 0,
  deviceRequestsCount: 0,
  deviceCgroupRulesCount: 0,
  volumesFromCount: 0,
  privileged: false,
  pidMode: '',
  ipcMode: 'private',
  utsMode: '',
  usernsMode: '',
  networkMode: SHADOW_NETWORK,
  securityOptSha256: digest(JSON.stringify(['no-new-privileges:true'])),
  tmpfsSha256: canonicalDigest({
    path: '/tmp',
    sizeBytes: 64 * 1024 ** 2,
    mode: '1777',
    uid: '1000',
    gid: '1000',
  }),
  publishedPortCount: 0,
  mountCount: 1,
});
function dataRecord(value, code) {
  requireFact(
    record(value) &&
      !types.isProxy(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    code,
  );
  return value;
}
function dataField(value, key, code = 'shadow_projection_unproved') {
  dataRecord(value, code);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  requireFact(descriptor && Object.hasOwn(descriptor, 'value'), code);
  return descriptor.value;
}
const shadowHash = (value) => typeof value === 'string' && HASH.test(value);
function denseArray(value, maximum, code) {
  requireFact(Array.isArray(value) && value.length <= maximum, code);
  for (let index = 0; index < value.length; index++) requireFact(Object.hasOwn(value, index), code);
  return value;
}

export async function loadPreadmissionShadowRuntime(sources) {
  const code = 'shadow_source_unproved';
  dataRecord(sources, code);
  requireFact(Reflect.ownKeys(sources).length === shadowGraph.length, code);
  const copies = new Map();
  // FLAG: Verify the complete closed graph before importing any of its modules.
  for (const [name, size, hash] of shadowGraph) {
    const source = dataField(sources, `infra/scripts/${name}`, code);
    const bytes = dataField(source, 'bytes', code);
    requireFact(
      Buffer.isBuffer(bytes) &&
        bytes.length === size &&
        dataField(source, 'uid', code) === process.getuid() &&
        dataField(source, 'gid', code) === process.getgid() &&
        [0o644, 0o664].includes(dataField(source, 'mode', code)) &&
        dataField(source, 'links', code) === 1,
      code,
    );
    const copy = Buffer.from(bytes);
    requireFact(digest(copy) === hash, code);
    copies.set(name, copy);
  }
  const urls = new Map();
  for (const [name, , , dependencies] of shadowGraph) {
    let text = copies.get(name).toString('utf8');
    for (const dependency of dependencies) {
      const token = `'./${dependency}'`;
      requireFact(text.split(token).length === 2 && urls.has(dependency), code);
      text = text.replace(token, `'${urls.get(dependency)}'`);
    }
    const url = `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
    requireFact(url.length <= 1024 * 1024, code);
    urls.set(name, url);
  }
  const runtime = await import(urls.get('commercial-llm-runtime.mjs'));
  return Object.freeze({
    COMMERCIAL_LLM_SLOTS_RUNTIME: runtime.COMMERCIAL_LLM_SLOTS_RUNTIME,
    assertCommercialLlmContainer: runtime.assertCommercialLlmContainer,
    assertCommercialLlmImage: runtime.assertCommercialLlmImage,
    assertCommercialLlmApiClient: runtime.assertCommercialLlmApiClient,
  });
}

function shadowCandidates(rows) {
  return rows.filter(
    (row) =>
      row.Name === SHADOW_NAME ||
      row.Config?.Labels?.['com.docker.compose.service'] === SHADOW_SERVICE,
  );
}
function rawShadowConfiguration(container) {
  const code = 'shadow_runtime_unproved';
  const config = container.Config;
  const host = container.HostConfig;
  requireFact(record(config) && record(host), code);
  const strings = (value) => {
    denseArray(value, 64, code);
    requireFact(
      value.every((entry) => typeof entry === 'string'),
      code,
    );
    return value;
  };
  const emptyCount = (value) => {
    requireFact(value === null || (Array.isArray(value) && value.length === 0), code);
    return 0;
  };
  const mounts = denseArray(container.Mounts, 2, code).map((mount) => ({
    type: mount.Type,
    source: mount.Source,
    destination: mount.Destination,
    readOnly: mount.RW === false,
  }));
  const tmpfs = Object.entries(host.Tmpfs ?? {});
  requireFact(
    tmpfs.length === 1 && tmpfs[0][0] === '/tmp' && typeof tmpfs[0][1] === 'string',
    code,
  );
  const options = {};
  for (const option of tmpfs[0][1].split(',')) {
    if (option === 'rw') continue;
    const split = option.indexOf('=');
    requireFact(split > 0 && !Object.hasOwn(options, option.slice(0, split)), code);
    options[option.slice(0, split)] = option.slice(split + 1);
  }
  requireFact(
    Object.keys(options).length === 4 &&
      ['size', 'mode', 'uid', 'gid'].every((key) => Object.hasOwn(options, key)),
    code,
  );
  const projected = {
    user: config.User,
    entrypointSha256: digest(JSON.stringify(strings(config.Entrypoint))),
    environmentSha256: digest(JSON.stringify([...strings(config.Env)].sort())),
    commandSha256: digest(JSON.stringify(strings(config.Cmd))),
    mountsSha256: canonicalDigest(mounts),
    readonlyRootfs: host.ReadonlyRootfs,
    init: host.Init,
    nanoCpus: host.NanoCpus,
    cpuShares: host.CpuShares,
    memory: host.Memory,
    memorySwap: host.MemorySwap,
    pidsLimit: host.PidsLimit,
    capDropAll: JSON.stringify(strings(host.CapDrop)) === '["ALL"]',
    capAddCount: emptyCount(host.CapAdd),
    devicesCount: emptyCount(host.Devices),
    deviceRequestsCount: emptyCount(host.DeviceRequests),
    deviceCgroupRulesCount: emptyCount(host.DeviceCgroupRules),
    volumesFromCount: emptyCount(host.VolumesFrom),
    privileged: host.Privileged,
    pidMode: host.PidMode,
    ipcMode: host.IpcMode,
    utsMode: host.UTSMode,
    usernsMode: host.UsernsMode,
    networkMode: host.NetworkMode,
    securityOptSha256: digest(JSON.stringify(strings(host.SecurityOpt))),
    tmpfsSha256: canonicalDigest({
      path: '/tmp',
      sizeBytes: ['64m', '67108864'].includes(options.size) ? 64 * 1024 ** 2 : null,
      mode: options.mode,
      uid: options.uid,
      gid: options.gid,
    }),
    publishedPortCount: Object.keys(host.PortBindings ?? {}).length,
    mountCount: mounts.length,
  };
  for (const [key, expected] of Object.entries(shadowConfiguration))
    requireFact(typeof projected[key] === typeof expected && projected[key] === expected, code);
  return projected;
}

// FLAG: This is a finite configuration attestation for the already-running Slots
// auxiliary. It proves no model request, receipt, semantic outcome or recovery effect.
function projectPreadmissionShadow(value, { imageId, background } = {}) {
  if (value === null) return null;
  const code = 'shadow_projection_unproved';
  const field = (key) => dataField(value, key, code);
  const configuration = dataField(value, 'configuration', code);
  const projectedConfiguration = {};
  for (const [key, expected] of Object.entries(shadowConfiguration)) {
    const actual = dataField(configuration, key, code);
    requireFact(typeof actual === typeof expected && actual === expected, code);
    projectedConfiguration[key] = actual;
  }
  const configurationSha256 = canonicalDigest(projectedConfiguration);
  requireFact(field('configurationSha256') === configurationSha256, code);
  const network = dataField(value, 'network', code);
  const projectedNetwork = {};
  for (const [key, expected] of Object.entries({
    name: SHADOW_NETWORK,
    internal: true,
    driver: 'bridge',
    scope: 'local',
    project: 'infra',
    composeNetwork: 'commercial_llm_internal',
    clientServiceName: 'api-moderation-background',
    peerCount: 2,
  })) {
    const actual = dataField(network, key, code);
    requireFact(typeof actual === typeof expected && actual === expected, code);
    projectedNetwork[key] = actual;
  }
  for (const key of [
    'networkSha256',
    'modelEndpointSha256',
    'clientContainerSha256',
    'clientEndpointSha256',
  ]) {
    const actual = dataField(network, key, code);
    requireFact(shadowHash(actual), code);
    projectedNetwork[key] = actual;
  }
  const clientImageId = dataField(network, 'clientImageId', code);
  requireFact(
    typeof clientImageId === 'string' &&
      IMAGE.test(clientImageId) &&
      clientImageId === imageId &&
      projectedNetwork.modelEndpointSha256 !== projectedNetwork.clientEndpointSha256 &&
      (!background || projectedNetwork.clientContainerSha256 === background.containerSha256),
    code,
  );
  projectedNetwork.clientImageId = clientImageId;
  requireFact(
    field('schemaVersion') === 1 &&
      field('serviceName') === SHADOW_SERVICE &&
      field('runtimeProfile') === SHADOW_PROFILE &&
      field('imageId') === SHADOW_IMAGE &&
      field('modelSha256') === SHADOW_MODEL &&
      field('commandSha256') === SHADOW_COMMAND &&
      shadowHash(field('containerSha256')) &&
      field('containerSha256') !== projectedNetwork.clientContainerSha256 &&
      field('running') === true &&
      field('healthy') === true &&
      validDate(field('createdAt')) &&
      Date.parse(field('createdAt')) < started &&
      validDate(field('startedAt')) &&
      Date.parse(field('startedAt')) < started &&
      Date.parse(field('createdAt')) <= Date.parse(field('startedAt')) &&
      Number.isSafeInteger(field('restartCount')) &&
      field('restartCount') >= 0,
    code,
  );
  return {
    schemaVersion: 1,
    serviceName: SHADOW_SERVICE,
    runtimeProfile: SHADOW_PROFILE,
    containerSha256: field('containerSha256'),
    imageId: SHADOW_IMAGE,
    modelSha256: SHADOW_MODEL,
    commandSha256: SHADOW_COMMAND,
    createdAt: field('createdAt'),
    startedAt: field('startedAt'),
    restartCount: field('restartCount'),
    running: true,
    healthy: true,
    configuration: projectedConfiguration,
    configurationSha256,
    network: projectedNetwork,
  };
}

export function inspectPreadmissionShadow(rows, { imageId, image, network, runtime }) {
  const code = 'shadow_runtime_unproved';
  denseArray(rows, 128, code);
  requireFact(
    rows.every((row) => record(row) && shadowHash(row.Id)) &&
      new Set(rows.map((row) => row.Id)).size === rows.length,
    code,
  );
  const candidates = shadowCandidates(rows);
  if (candidates.length === 0) return null;
  requireFact(candidates.length === 1, code);
  const model = candidates[0];
  const clientRows = rows.filter(
    (row) =>
      row.Name === '/infra-api-moderation-background-1' ||
      (row.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
        row.Config?.Labels?.['com.docker.compose.service'] === 'api-moderation-background'),
  );
  requireFact(
    clientRows.length === 1 &&
      model.Name === SHADOW_NAME &&
      model.Config?.Labels?.['com.docker.compose.oneoff'] === 'False' &&
      model.State?.Status === 'running' &&
      model.State.Running === true &&
      model.State.Paused === false &&
      model.State.Restarting === false &&
      model.State.Dead === false &&
      runtime?.COMMERCIAL_LLM_SLOTS_RUNTIME?.runtimeProfile === SHADOW_PROFILE &&
      typeof runtime.assertCommercialLlmContainer === 'function' &&
      typeof runtime.assertCommercialLlmImage === 'function' &&
      typeof runtime.assertCommercialLlmApiClient === 'function',
    code,
  );
  const client = clientRows[0];
  requireFact(client.Name === '/infra-api-moderation-background-1', code);
  runtime.assertCommercialLlmContainer(model, { profile: runtime.COMMERCIAL_LLM_SLOTS_RUNTIME });
  runtime.assertCommercialLlmImage(image);
  runtime.assertCommercialLlmApiClient(client, { service: 'api-moderation-background', imageId });
  const configuration = rawShadowConfiguration(model);
  const netCode = 'shadow_network_unproved';
  const modelEndpoint = model.NetworkSettings?.Networks?.[SHADOW_NETWORK];
  const clientEndpoint = client.NetworkSettings?.Networks?.[SHADOW_NETWORK];
  const peers = Object.entries(network?.Containers ?? {});
  requireFact(
    network?.Name === SHADOW_NETWORK &&
      shadowHash(network.Id) &&
      network.Internal === true &&
      network.Driver === 'bridge' &&
      network.Scope === 'local' &&
      network.Labels?.['com.docker.compose.project'] === 'infra' &&
      network.Labels?.['com.docker.compose.network'] === 'commercial_llm_internal' &&
      modelEndpoint?.NetworkID === network.Id &&
      clientEndpoint?.NetworkID === network.Id &&
      shadowHash(modelEndpoint?.EndpointID) &&
      shadowHash(clientEndpoint?.EndpointID) &&
      peers.length === 2 &&
      peers.every(
        ([id, peer]) =>
          (id === model.Id &&
            peer?.Name === SHADOW_NAME.slice(1) &&
            peer.EndpointID === modelEndpoint.EndpointID) ||
          (id === client.Id &&
            peer?.Name === client.Name.slice(1) &&
            peer.EndpointID === clientEndpoint.EndpointID),
      ),
    netCode,
  );
  return projectPreadmissionShadow(
    {
      schemaVersion: 1,
      serviceName: SHADOW_SERVICE,
      runtimeProfile: SHADOW_PROFILE,
      containerSha256: digest(model.Id),
      imageId: model.Image,
      modelSha256: SHADOW_MODEL,
      commandSha256: configuration.commandSha256,
      createdAt: model.Created,
      startedAt: model.State.StartedAt,
      restartCount: model.RestartCount,
      running: model.State.Running,
      healthy: model.State.Health.Status === 'healthy',
      configuration,
      configurationSha256: canonicalDigest(configuration),
      network: {
        name: network.Name,
        networkSha256: digest(network.Id),
        internal: network.Internal,
        driver: network.Driver,
        scope: network.Scope,
        project: network.Labels['com.docker.compose.project'],
        composeNetwork: network.Labels['com.docker.compose.network'],
        modelEndpointSha256: digest(modelEndpoint.EndpointID),
        clientServiceName: 'api-moderation-background',
        clientContainerSha256: digest(client.Id),
        clientImageId: client.Image,
        clientEndpointSha256: digest(clientEndpoint.EndpointID),
        peerCount: peers.length,
      },
    },
    { imageId },
  );
}

function bindPreadmissionShadow(rows, shadow, imageId) {
  const candidates = shadowCandidates(rows);
  if (shadow === null) {
    requireFact(candidates.length === 0, 'unexpected_maxim_container');
    return null;
  }
  const projected = projectPreadmissionShadow(shadow, { imageId });
  const model = candidates[0];
  const client = rows.find(
    (row) =>
      row.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
      row.Config.Labels['com.docker.compose.service'] === 'api-moderation-background',
  );
  const modelEndpoint = model?.NetworkSettings?.Networks?.[SHADOW_NETWORK];
  const clientEndpoint = client?.NetworkSettings?.Networks?.[SHADOW_NETWORK];
  requireFact(
    candidates.length === 1 &&
      model?.Name === SHADOW_NAME &&
      model.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
      model.Config.Labels['com.docker.compose.service'] === SHADOW_SERVICE &&
      model.Config.Labels['com.docker.compose.oneoff'] === 'False' &&
      model.Config.Labels['com.maxim.commercial-llm-shadow'] === 'true' &&
      model.Config.Labels['com.maxim.commercial-llm-model-sha256'] === SHADOW_MODEL &&
      model.Config.Image === `ghcr.io/ggml-org/llama.cpp@${SHADOW_IMAGE}` &&
      Object.keys(model.NetworkSettings?.Networks ?? {}).length === 1 &&
      digest(model.Id) === projected.containerSha256 &&
      model.Image === projected.imageId &&
      model.Created === projected.createdAt &&
      model.State?.StartedAt === projected.startedAt &&
      model.RestartCount === projected.restartCount &&
      model.State.Running === true &&
      model.State.Status === 'running' &&
      model.State.Paused === false &&
      model.State.Restarting === false &&
      model.State.Dead === false &&
      model.State.Health?.Status === 'healthy' &&
      canonicalDigest(rawShadowConfiguration(model)) === projected.configurationSha256 &&
      client &&
      digest(client.Id) === projected.network.clientContainerSha256 &&
      client.Image === projected.network.clientImageId &&
      client.Config?.Labels?.['com.maxim.release-protected'] === 'true' &&
      environmentField(client.Config?.Env, 'APP_ROLE') === 'moderation' &&
      environmentField(client.Config?.Env, 'APP_SERVICE_NAME') === 'api-moderation-background' &&
      shadowHash(modelEndpoint?.NetworkID) &&
      shadowHash(clientEndpoint?.NetworkID) &&
      digest(modelEndpoint.NetworkID) === projected.network.networkSha256 &&
      digest(clientEndpoint.NetworkID) === projected.network.networkSha256 &&
      shadowHash(modelEndpoint?.EndpointID) &&
      shadowHash(clientEndpoint?.EndpointID) &&
      digest(modelEndpoint.EndpointID) === projected.network.modelEndpointSha256 &&
      digest(clientEndpoint.EndpointID) === projected.network.clientEndpointSha256,
    'shadow_runtime_binding_unproved',
  );
  return projected;
}

export function parsePreadmissionRecoveryArgs(args) {
  const [mode, ...rest] = args;
  requireFact(
    ['preview', 'apply'].includes(mode) && rest.length === (mode === 'apply' ? 10 : 8),
    'invalid_arguments',
  );
  const fields = {
    '--owner-sha256': 'ownerSha256',
    '--state-sha256': 'stateSha256',
    '--source-sha': 'sourceSha',
    '--operation-id': 'operationId',
    '--proof-sha256': 'proofSha256',
  };
  const result = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = fields[rest[index]];
    requireFact(
      key && result[key] === undefined && typeof rest[index + 1] === 'string',
      'invalid_arguments',
    );
    result[key] = rest[index + 1];
  }
  requireFact(
    result.ownerSha256 === PREADMISSION_CONTRACT.ownerSha256 &&
      HASH.test(result.stateSha256 ?? '') &&
      result.sourceSha === PREADMISSION_SOURCE &&
      UUID.test(result.operationId ?? '') &&
      (mode === 'apply' ? HASH.test(result.proofSha256 ?? '') : result.proofSha256 === undefined),
    'invalid_identity',
  );
  return result;
}

export function parsePreadmissionOwner(bytes) {
  requireFact(
    Buffer.isBuffer(bytes) && bytes.length > 256 && bytes.length <= 2048 && !bytes.includes(0),
    'invalid_owner',
  );
  const text = bytes.toString('utf8');
  requireFact(
    text.endsWith('\n') && !text.endsWith('\n\n') && !text.includes('\r'),
    'invalid_owner',
  );
  const keys = [
    'protocol',
    'token',
    'product',
    'mode',
    'target',
    'pid',
    'start',
    'boot',
    'cwd',
    'fd',
    'inode',
    'initial_state',
    'started_at',
  ];
  const lines = text.slice(0, -1).split('\n');
  requireFact(lines.length === keys.length, 'invalid_owner');
  const fields = {};
  for (const [index, line] of lines.entries()) {
    requireFact(line.startsWith(`${keys[index]}=`), 'invalid_owner');
    fields[keys[index]] = line.slice(keys[index].length + 1);
  }
  requireFact(
    UUID.test(fields.token) &&
      /^[1-9][0-9]{0,9}$/u.test(fields.pid) &&
      /^[0-9]{1,20}$/u.test(fields.start) &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(fields.boot) &&
      /^[1-9][0-9]{0,5}$/u.test(fields.fd),
    'invalid_owner_identity',
  );
  validateOwnerScope(fields);
  return fields;
}

function validateOwnerScope(owner) {
  requireFact(
    owner?.protocol === 'major-karavan-release-v1' &&
      owner.product === 'major' &&
      owner.mode === 'runtime' &&
      owner.target === PREADMISSION_SOURCE &&
      owner.cwd === digest(MAJOR) &&
      /^[0-9]+:[0-9]+$/u.test(owner.inode ?? '') &&
      HASH.test(owner.initial_state ?? '') &&
      owner.started_at === PREADMISSION_CONTRACT.ownerStartedAt,
    'unexpected_owner_scope',
  );
}

function privateMetadata(value, uid, code) {
  requireFact(
    record(value) &&
      value.uid === uid &&
      value.mode === 0o600 &&
      value.links === 1 &&
      HASH.test(value.sha256 ?? '') &&
      Number.isFinite(value.mtimeMs) &&
      Number.isFinite(value.ctimeMs),
    code,
  );
}

function validateContext(value) {
  requireFact(
    exactKeys(value, [
      'version',
      'protocol',
      'selection',
      'publisherBotId',
      'networkId',
      'queueControlSha256',
    ]) &&
      value.version === 1 &&
      value.protocol === 'source-abandonment-v1' &&
      ID.test(value.publisherBotId ?? '') &&
      HASH.test(value.networkId ?? '') &&
      value.queueControlSha256 === PREADMISSION_CONTRACT.queueControlSha256,
    'private_context_unproved',
  );
  const selection = value.selection;
  requireFact(
    exactKeys(selection, ['ownerWebhookEventIds', 'majorBotIds', 'protocol', 'abandonBefore']) &&
      selection.protocol === value.protocol &&
      validDate(selection.abandonBefore) &&
      Date.parse(selection.abandonBefore) <= started,
    'private_selection_unproved',
  );
  for (const [key, maximum] of [
    ['ownerWebhookEventIds', 8],
    ['majorBotIds', 100],
  ]) {
    const values = selection[key];
    requireFact(
      Array.isArray(values) &&
        values.length > 0 &&
        values.length <= maximum &&
        values.every((id) => typeof id === 'string' && ID.test(id)) &&
        new Set(values).size === values.length &&
        JSON.stringify(values) === JSON.stringify([...values].sort()),
      'private_selection_unproved',
    );
  }
  requireFact(!selection.majorBotIds.includes(value.publisherBotId), 'private_catalog_unproved');
  return value;
}

export function inspectPreadmissionContext(bytes) {
  requireFact(Buffer.byteLength(bytes) <= 64 * 1024, 'private_context_budget');
  const value = validateContext(JSON.parse(Buffer.from(bytes).toString('utf8')));
  return {
    version: 1,
    protocol: value.protocol,
    selectionSha256: canonicalDigest(value.selection),
    networkSha256: digest(value.networkId),
    majorCatalogSha256: canonicalDigest(value.selection.majorBotIds),
    publisherCatalogSha256: canonicalDigest({ publisherBotId: value.publisherBotId }),
    queueControlSha256: value.queueControlSha256,
    ownerCount: value.selection.ownerWebhookEventIds.length,
    majorCount: value.selection.majorBotIds.length,
  };
}

const fleetKeys = [
  'expectedRoleCount',
  'observedRoleCount',
  'singletonRoleCount',
  'runningRoleCount',
  'identityRoleCount',
  'exactImageRoleCount',
];
function requireFleet(fleet) {
  requireFact(
    fleet?.available === true &&
      fleetKeys.every((key) => fleet[key] === 14) &&
      [
        'duplicateContainerCount',
        'unexpectedApiContainerCount',
        'unexpectedMainContainerCount',
        'unexpectedScaleContainerCount',
        'unexpectedManualContainerCount',
      ].every((key) => fleet[key] === 0),
    'native_runtime_boundary_unproved',
  );
}
function environmentField(environment, key) {
  requireFact(
    Array.isArray(environment) &&
      environment.length <= 512 &&
      environment.every((line) => typeof line === 'string' && Buffer.byteLength(line) <= 32 * 1024),
    'runtime_environment_unproved',
  );
  const matches = environment.filter((line) => line.startsWith(`${key}=`));
  requireFact(matches.length <= 1, 'ambiguous_runtime_environment');
  return matches[0]?.slice(key.length + 1);
}
function historicalEnvironmentRefusal(environment) {
  const field = (key) => environmentField(environment, key);
  const database = field('DATABASE_URL');
  const redis = field('REDIS_URL');
  const urlText = field('ERASER_CONTROL_URL');
  const token = field('ERASER_CONTROL_TOKEN');
  requireFact(
    typeof database === 'string' &&
      /^\S+$/u.test(database) &&
      typeof redis === 'string' &&
      /^\S+$/u.test(redis) &&
      typeof token === 'string' &&
      /^\S{32,512}$/u.test(token) &&
      typeof urlText === 'string' &&
      !/[\r\0]/u.test(`${database}${redis}${token}${urlText}`),
    'historical_environment_refusal_unproved',
  );
  let url;
  try {
    url = new URL(urlText);
  } catch {
    fail('historical_environment_refusal_unproved');
  }
  requireFact(
    url.origin === 'http://eraser:3000' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'historical_environment_refusal_unproved',
  );
  // FLAG: Exact 4345 host emits this four-key capture. Its client rejects the
  // control pair before discovering or creating any Docker recovery client.
  const captured = `DATABASE_URL=${database}\nREDIS_URL=${redis}\nERASER_CONTROL_URL=${urlText}\nERASER_CONTROL_TOKEN=${token}\n`;
  const lines = captured.trimEnd().split('\n');
  const keys = lines.map((line) => line.slice(0, line.indexOf('=')));
  const rejectedByHistoricalClient = keys.some(
    (key) => !['DATABASE_URL', 'REDIS_URL'].includes(key),
  );
  requireFact(rejectedByHistoricalClient, 'historical_environment_refusal_unproved');
  return true;
}

// FLAG: This reads immutable configuration only. No raw environment, catalog or
// source-event identity leaves the observer; proof retains hashes and generations.
export function inspectPreadmissionRuntime(rows, { imageId, context, fleet, shadow = null }) {
  requireFact(
    Array.isArray(rows) &&
      rows.length > 0 &&
      rows.length <= 128 &&
      new Set(rows.map((row) => row.Id)).size === rows.length &&
      rows.every((row) => HASH.test(row.Id ?? '')) &&
      IMAGE.test(imageId ?? ''),
    'runtime_inventory_unproved',
  );
  requireFleet(fleet);
  validateContext(context);
  const shadowEvidence = bindPreadmissionShadow(rows, shadow, imageId);
  const extras = new Set([
    'postgres',
    'redis',
    'eraser-postgres',
    'eraser-redis',
    'eraser',
    'miniapp-static',
    'miniapp-major-static',
    'admin-static',
  ]);
  const seen = new Set();
  for (const row of rows) {
    const labels = row.Config?.Labels ?? {};
    requireFact(
      !Object.keys(labels).some((key) =>
        /(?:legacy-recovery-client|source-abandonment.*client|cold.*client)/u.test(key),
      ) && !/^\/?maxim-(?:legacy|source|cold).*recover/u.test(row.Name ?? ''),
      'recovery_client_present',
    );
    if (labels['com.docker.compose.project'] === 'infra') {
      const service = labels['com.docker.compose.service'];
      requireFact(
        ([...PREADMISSION_SERVICES, ...extras].includes(service) ||
          (service === SHADOW_SERVICE &&
            shadowEvidence !== null &&
            digest(row.Id) === shadowEvidence.containerSha256)) &&
          row.Name === `/infra-${service}-1` &&
          labels['com.docker.compose.oneoff'] !== 'True' &&
          !seen.has(service),
        'unexpected_maxim_container',
      );
      seen.add(service);
    }
  }
  const services = PREADMISSION_SERVICES.map((serviceName) => {
    const matches = rows.filter(
      (row) =>
        row.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
        row.Config.Labels['com.docker.compose.service'] === serviceName,
    );
    const row = matches[0];
    requireFact(
      matches.length === 1 &&
        row.Image === imageId &&
        row.Config.Image === `maxim-api:${PREADMISSION_SOURCE}` &&
        row.Config.Labels['org.opencontainers.image.revision'] === PREADMISSION_SOURCE &&
        row.State?.Status === 'running' &&
        row.State.Running === true &&
        row.State.Paused === false &&
        row.State.Restarting === false &&
        row.State.Dead === false &&
        row.HostConfig?.RestartPolicy?.Name === 'unless-stopped' &&
        validDate(row.Created) &&
        validDate(row.State.StartedAt) &&
        Date.parse(row.Created) < started &&
        Number.isSafeInteger(row.RestartCount) &&
        row.RestartCount >= 0,
      'runtime_generation_unproved',
    );
    // FLAG: OCR is a networkless, secretless UDS auxiliary, positively reviewed by
    // the pinned fleet boundary. Its current restart is recorded, not attributed.
    // API and photo continuity remain required; no runtime was restored by this tool.
    requireFact(
      serviceName === 'ocr-native-sandbox' || Date.parse(row.State.StartedAt) < started,
      'runtime_continuity_unproved',
    );
    const native = !serviceName.startsWith('api-');
    requireFact(!native || row.State.Health?.Status === 'healthy', 'native_runtime_unhealthy');
    return {
      serviceName,
      containerSha256: digest(row.Id),
      imageId: row.Image,
      createdAt: row.Created,
      startedAt: row.State.StartedAt,
      running: true,
      healthy: native ? true : null,
      restartCount: row.RestartCount,
    };
  });
  const admin = rows.find(
    (row) =>
      row.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
      row.Config.Labels['com.docker.compose.service'] === 'api-admin',
  );
  const publisher = rows.find(
    (row) =>
      row.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
      row.Config.Labels['com.docker.compose.service'] === 'api-publisher',
  );
  const env = (row, key) => environmentField(row.Config.Env, key);
  const extra = JSON.parse(env(admin, 'MAX_BOTS_JSON') || '[]');
  requireFact(Array.isArray(extra) && extra.length <= 99, 'runtime_catalog_unproved');
  const majorBotIds = [env(admin, 'MAX_BOT_ID'), ...extra.map((entry) => entry?.id)]
    .map((id) => (typeof id === 'string' ? id.trim() : null))
    .sort();
  const publisherBotId = env(admin, 'MAX_PUBLISHER_BOT_ID');
  requireFact(
    majorBotIds.every((id) => typeof id === 'string' && ID.test(id)) &&
      new Set(majorBotIds).size === majorBotIds.length &&
      ID.test(publisherBotId ?? '') &&
      !majorBotIds.includes(publisherBotId) &&
      env(publisher, 'MAX_PUBLISHER_BOT_ID') === publisherBotId &&
      env(publisher, 'MAX_BOT_ID') === publisherBotId &&
      env(publisher, 'APP_ROLE') === 'publisher' &&
      canonicalDigest(majorBotIds) === canonicalDigest(context.selection.majorBotIds) &&
      publisherBotId === context.publisherBotId,
    'runtime_catalog_unproved',
  );
  const networkId = admin.NetworkSettings?.Networks?.infra_default?.NetworkID;
  requireFact(
    networkId === context.networkId && HASH.test(networkId ?? ''),
    'runtime_network_unproved',
  );
  return {
    imageId,
    services,
    shadow: shadowEvidence,
    noRecoveryClients: true,
    // FLAG: This census covers unexpected API/native producers in the pinned classifier.
    unexpectedCount: 0,
    nativeBoundaryReviewed: true,
    environmentRefusalProved: historicalEnvironmentRefusal(admin.Config.Env),
    networkSha256: digest(networkId),
    majorCatalogSha256: canonicalDigest(majorBotIds),
    publisherCatalogSha256: canonicalDigest({ publisherBotId }),
  };
}

function projectHistoricalSiblingFiles(
  value,
  operatorUid,
  ownerStartedAtMs = started,
  code = 'historical_sibling_metadata_unproved',
) {
  requireFact(Array.isArray(value) && value.length <= 256, code);
  let previousName = '';
  const projection = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    requireFact(record(entry), code);
    const { nameSha256, kind, uid, mode, nlink, size, dev, ino, mtimeMs, ctimeMs } = entry;
    requireFact(
      typeof nameSha256 === 'string' &&
        HASH.test(nameSha256) &&
        nameSha256 > previousName &&
        kind === 'regular' &&
        uid === operatorUid &&
        mode === 0o600 &&
        nlink === 1 &&
        Number.isSafeInteger(size) &&
        size >= 0 &&
        size <= 64 * 1024 &&
        Number.isSafeInteger(dev) &&
        dev >= 0 &&
        Number.isSafeInteger(ino) &&
        ino >= 0 &&
        Number.isFinite(mtimeMs) &&
        Number.isFinite(ctimeMs) &&
        mtimeMs <= ctimeMs &&
        ctimeMs < ownerStartedAtMs,
      code,
    );
    previousName = nameSha256;
    projection.push({ nameSha256, kind, uid, mode, nlink, size, dev, ino, mtimeMs, ctimeMs });
  }
  return projection;
}

// FLAG: This historical exception only archives the retained admission owner. The
// exact source barrier, unchanged journal bytes and directory ctime prove that the
// controller did not cross durable admission; no child exit or business recovery
// is inferred from an absent file, queue age, HTTP response or process disappearance.
export function buildPreadmissionProof(request, observation) {
  requireFact(
    request.sourceSha === PREADMISSION_SOURCE &&
      request.ownerSha256 === PREADMISSION_CONTRACT.ownerSha256 &&
      UUID.test(request.operationId ?? '') &&
      HASH.test(request.stateSha256 ?? ''),
    'unreviewed_preadmission_scope',
  );
  requireFact(
    observation.locksHeld === true &&
      Number.isSafeInteger(observation.operatorUid) &&
      observation.operatorUid >= 0,
    'missing_recovery_locks',
  );
  const ownerFile = observation.owner;
  privateMetadata(ownerFile, observation.operatorUid, 'unsafe_owner');
  requireFact(ownerFile.sha256 === request.ownerSha256, 'owner_changed');
  const owner = ownerFile.fields;
  validateOwnerScope(owner);
  requireFact(owner.inode === observation.admissionInode, 'admission_inode_changed');
  requireFact(
    owner.boot === observation.bootId && observation.process?.present === false,
    'owner_process_not_proved_dead',
  );
  requireFact(observation.noActors === true, 'active_recovery_actor');
  const source = observation.source;
  requireFact(
    source?.majorSha === PREADMISSION_SOURCE &&
      SOURCE.test(source.karavanSha ?? '') &&
      source.majorClean === true &&
      source.karavanClean === true &&
      source.installedMatch === true &&
      record(source.hashes) &&
      Object.keys(source.hashes).length > 0 &&
      Object.values(source.hashes).every((value) => HASH.test(value)) &&
      source.hashes.queueControl === PREADMISSION_CONTRACT.queueControlSha256,
    'exact_source_unproved',
  );
  const snapshot = observation.snapshot;
  requireFact(
    snapshot?.schemaVersion === 1 &&
      snapshot.protocol === 'major-karavan-release-v1' &&
      snapshot.major?.checkoutSha === source.majorSha &&
      snapshot.major?.targetSha === PREADMISSION_SOURCE &&
      snapshot.karavan?.checkoutSha === source.karavanSha &&
      HASH.test(snapshot.major.manifestSha256 ?? '') &&
      HASH.test(snapshot.karavan.manifestSha256 ?? ''),
    'pair_manifest_unproved',
  );
  requireFact(
    observation.fingerprint === request.stateSha256 &&
      digest(JSON.stringify(snapshot)) === request.stateSha256 &&
      owner.initial_state === request.stateSha256,
    'pair_state_changed',
  );
  const operation = observation.operation;
  const directory = operation?.directory;
  requireFact(
    operation?.idSha256 === digest(request.operationId) &&
      operation.uniqueWindowDirectory === true &&
      directory?.uid === observation.operatorUid &&
      directory.mode === 0o700 &&
      Math.trunc(directory.ctimeMs) === changed &&
      Math.trunc(directory.mtimeMs) === changed &&
      JSON.stringify([...operation.entries].sort()) ===
        JSON.stringify(['context.json', 'queue-control.cjs']),
    'preadmission_directory_changed',
  );
  for (const [key, expected] of [
    ['context', PREADMISSION_CONTRACT.contextSha256],
    ['queueControl', PREADMISSION_CONTRACT.queueControlSha256],
  ]) {
    const artifact = operation[key];
    privateMetadata(artifact, observation.operatorUid, 'unsafe_private_artifact');
    requireFact(
      artifact.sha256 === expected &&
        artifact.mtimeMs >= started &&
        artifact.ctimeMs >= started &&
        artifact.mtimeMs <= started + 10_000 &&
        artifact.ctimeMs <= started + 10_000 &&
        artifact.ctimeMs <= directory.ctimeMs &&
        artifact.mtimeMs <= directory.mtimeMs,
      'preadmission_artifact_changed',
    );
  }
  // FLAG: Revalidate explicit metadata here; a supplied opaque digest never
  // authenticates sibling safety. Contents stay unread and names stay hashed.
  const historicalSiblingFiles = projectHistoricalSiblingFiles(
    operation.historicalSiblingFiles,
    observation.operatorUid,
  );
  const context = operation.contextFacts;
  requireFact(
    context?.version === 1 &&
      context.protocol === 'source-abandonment-v1' &&
      ['selectionSha256', 'networkSha256', 'majorCatalogSha256', 'publisherCatalogSha256'].every(
        (key) => HASH.test(context[key] ?? ''),
      ) &&
      context.queueControlSha256 === PREADMISSION_CONTRACT.queueControlSha256 &&
      Number.isSafeInteger(context.ownerCount) &&
      context.ownerCount >= 1 &&
      context.ownerCount <= 8 &&
      Number.isSafeInteger(context.majorCount) &&
      context.majorCount >= 1 &&
      context.majorCount <= 100,
    'private_context_unproved',
  );
  for (const [key, expected] of [
    ['cold', PREADMISSION_CONTRACT.coldSha256],
    ['marker', PREADMISSION_CONTRACT.markerSha256],
    ['backlog', PREADMISSION_CONTRACT.backlogSha256],
  ]) {
    const journal = observation.journals?.[key];
    privateMetadata(journal, observation.operatorUid, 'unsafe_prior_journal');
    requireFact(
      journal.sha256 === expected &&
        journal.mtimeMs < started &&
        journal.ctimeMs < started &&
        (key === 'marker' || journal.phase === 'COMPLETE'),
      'prior_journal_changed',
    );
  }
  requireFact(
    observation.journals.predrainAbsent === true && observation.journals.sessionAbsent === true,
    'active_maintenance_journal',
  );
  const runtime = observation.runtime;
  const apiComponent = snapshot.major.components?.filter(
    (component) => component.id === 'api-shared',
  );
  requireFact(
    apiComponent?.length === 1 &&
      apiComponent[0].sourceSha === PREADMISSION_SOURCE &&
      IMAGE.test(apiComponent[0].imageId ?? '') &&
      runtime?.imageId === apiComponent[0].imageId &&
      runtime.noRecoveryClients === true &&
      runtime.unexpectedCount === 0 &&
      runtime.nativeBoundaryReviewed === true &&
      runtime.environmentRefusalProved === true,
    'runtime_boundary_unproved',
  );
  requireFact(
    ['networkSha256', 'majorCatalogSha256', 'publisherCatalogSha256'].every(
      (key) => runtime[key] === context[key],
    ),
    'runtime_context_changed',
  );
  requireFact(
    Array.isArray(runtime.services) &&
      runtime.services.length === PREADMISSION_SERVICES.length &&
      new Set(runtime.services.map((service) => service.serviceName)).size ===
        PREADMISSION_SERVICES.length &&
      new Set(runtime.services.map((service) => service.containerSha256)).size ===
        PREADMISSION_SERVICES.length &&
      runtime.services.every(
        (service) =>
          PREADMISSION_SERVICES.includes(service.serviceName) &&
          HASH.test(service.containerSha256 ?? '') &&
          service.imageId === runtime.imageId &&
          service.running === true &&
          validDate(service.createdAt) &&
          Date.parse(service.createdAt) < started &&
          validDate(service.startedAt) &&
          (service.serviceName === 'ocr-native-sandbox' ||
            Date.parse(service.startedAt) < started) &&
          (service.serviceName.startsWith('api-') || service.healthy === true) &&
          Number.isSafeInteger(service.restartCount) &&
          service.restartCount >= 0,
      ),
    'runtime_generation_changed',
  );
  requireFact(
    runtime.queueFence?.queueCount === 24 &&
      runtime.queueFence.pausedCount === 0 &&
      runtime.queueFence.ownerPresent === false,
    'queue_fence_not_released',
  );
  const shadow = projectPreadmissionShadow(
    Object.hasOwn(runtime, 'shadow') ? dataField(runtime, 'shadow') : null,
    {
      imageId: runtime.imageId,
      background: runtime.services.find(
        (service) => service.serviceName === 'api-moderation-background',
      ),
    },
  );
  if (shadow !== null)
    for (const [name, , hash] of shadowGraph)
      requireFact(source.hashes[`infra/scripts/${name}`] === hash, 'shadow_source_unproved');
  const safeMetadata = ({ sha256, dev, ino, mtimeMs, ctimeMs }) => ({
    sha256,
    dev,
    ino,
    mtimeMs,
    ctimeMs,
  });
  return {
    version: 1,
    kind: 'pair-release-historical-preadmission-recovery',
    verification: 'historical_durable_preadmission_boundary',
    ownerSha256: request.ownerSha256,
    sourceSha: PREADMISSION_SOURCE,
    stateSha256: request.stateSha256,
    ownerStartedAt: owner.started_at,
    operationSha256: operation.idSha256,
    historicalSiblingFiles: {
      count: historicalSiblingFiles.length,
      sha256: canonicalDigest(historicalSiblingFiles),
    },
    ownerIdentity: safeMetadata(ownerFile),
    admissionInode: observation.admissionInode,
    sourceHashes: Object.fromEntries(
      Object.entries(source.hashes).sort(([left], [right]) => left.localeCompare(right)),
    ),
    operationDirectory: {
      dev: directory.dev,
      ino: directory.ino,
      mtimeMs: directory.mtimeMs,
      ctimeMs: directory.ctimeMs,
    },
    artifacts: {
      context: safeMetadata(operation.context),
      queueControl: safeMetadata(operation.queueControl),
    },
    context: {
      version: 1,
      protocol: context.protocol,
      selectionSha256: context.selectionSha256,
      networkSha256: context.networkSha256,
      majorCatalogSha256: context.majorCatalogSha256,
      publisherCatalogSha256: context.publisherCatalogSha256,
      queueControlSha256: context.queueControlSha256,
      ownerCount: context.ownerCount,
      majorCount: context.majorCount,
    },
    priorJournals: Object.fromEntries(
      ['cold', 'marker', 'backlog'].map((key) => [key, safeMetadata(observation.journals[key])]),
    ),
    runtime: {
      imageId: runtime.imageId,
      shadow,
      services: runtime.services
        .map(
          ({
            serviceName,
            containerSha256,
            imageId,
            createdAt,
            startedAt,
            running,
            healthy,
            restartCount,
          }) => ({
            serviceName,
            containerSha256,
            imageId,
            createdAt,
            startedAt,
            running,
            healthy,
            restartCount,
          }),
        )
        .sort((left, right) => left.serviceName.localeCompare(right.serviceName)),
      nativeBoundaryReviewed: true,
      environmentRefusalProved: true,
      queueFence: { queueCount: 24, pausedCount: 0, ownerPresent: false },
    },
    runtimeMutation: false,
  };
}

async function boundedFile(path, maximum) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    requireFact(
      before.isFile() && before.nlink === 1 && before.size >= 0 && before.size <= maximum,
      'unsafe_input_file',
    );
    const bytes = await fd.readFile();
    const after = await fd.stat();
    const current = await lstat(path);
    requireFact(
      bytes.length === before.size &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.uid === after.uid &&
        before.mode === after.mode &&
        before.nlink === after.nlink &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === after.dev &&
        current.ino === after.ino &&
        current.mode === after.mode &&
        current.uid === after.uid &&
        current.nlink === 1 &&
        current.mtimeMs === after.mtimeMs &&
        current.ctimeMs === after.ctimeMs,
      'input_file_changed',
    );
    return { bytes, stat: after };
  } finally {
    await fd.close();
  }
}
async function boundedShadowSourceFile(path, size) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    requireFact(
      before.isFile() && before.nlink === 1 && before.size === size,
      'shadow_source_unproved',
    );
    const bytes = Buffer.alloc(size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await fd.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await fd.stat();
    const current = await lstat(path);
    const keys = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'];
    requireFact(
      length === size &&
        current.isFile() &&
        !current.isSymbolicLink() &&
        keys.every((key) => before[key] === after[key] && before[key] === current[key]),
      'shadow_source_changed',
    );
    return { bytes: bytes.subarray(0, length), stat: after };
  } finally {
    await fd.close();
  }
}
function metadata(file) {
  const { stat, bytes } = file;
  return {
    sha256: digest(bytes),
    uid: stat.uid,
    mode: stat.mode & 0o777,
    links: stat.nlink,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}
async function command(file, args, extra = {}) {
  try {
    const { input, ...options } = extra;
    const pending = execute(file, args, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      ...options,
    });
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(input);
    return (await pending).stdout;
  } catch {
    fail('bounded_observation_failed');
  }
}
function gitEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}
export async function observePreadmissionSourceGit(root, args) {
  requireFact([MAJOR, KARAVAN].includes(root), 'unreviewed_source_path');
  return command(
    'git',
    ['--no-replace-objects', '-c', `safe.directory=${root}`, '-C', root, ...args],
    { env: gitEnvironment() },
  );
}
const git = observePreadmissionSourceGit;

async function ancestors(path, allowRootSticky = false) {
  const parts = path.slice(parse(path).root.length).split('/').filter(Boolean);
  let current = parse(path).root;
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current);
    requireFact(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (!(stat.mode & 0o022) ||
          (allowRootSticky && stat.uid === 0 && Boolean(stat.mode & 0o1000))),
      'unsafe_recovery_path',
    );
  }
}
async function validatePaths() {
  const uid = process.getuid();
  requireFact(Number.isSafeInteger(uid) && uid > 0, 'ordinary_operator_required');
  for (const path of [dirname(OWNER), STATE, PRIVATE, dirname(LOCKS[2]), MAJOR, KARAVAN])
    await ancestors(path);
  const state = await lstat(dirname(OWNER));
  requireFact(state.uid === uid && (state.mode & 0o777) === 0o700, 'unsafe_state_directory');
  const root = await lstat(ROOT);
  requireFact(root.uid === 0, 'unsafe_protocol_owner');
  const runtimeState = await lstat(STATE);
  requireFact(
    [0, uid].includes(runtimeState.uid) && !(runtimeState.mode & 0o022),
    'unsafe_runtime_state_directory',
  );
  const privateRoot = await lstat(PRIVATE);
  requireFact(
    privateRoot.uid === uid && (privateRoot.mode & 0o777) === 0o700,
    'unsafe_private_directory',
  );
  for (const path of LOCKS) {
    const stat = await lstat(path);
    requireFact(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.uid === uid &&
        (stat.mode & 0o777) === 0o600,
      'unsafe_persistent_lock',
    );
  }
  return state;
}

export async function withPreadmissionLocks(paths, work) {
  requireFact(paths.length === 3 && new Set(paths).size === 3, 'invalid_recovery_locks');
  const descriptors = [];
  const uid = process.getuid();
  let child;
  let closed;
  let timer;
  try {
    for (const path of paths) {
      const fd = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      descriptors.push(fd);
      const stat = await fd.stat();
      requireFact(
        stat.isFile() && stat.nlink === 1 && stat.uid === uid && (stat.mode & 0o777) === 0o600,
        'unsafe_persistent_lock',
      );
    }
    // FLAG: Parent and helper retain the SAME open descriptions. Never unlock or
    // unlink a persistent lock, including when acquisition of a later lock fails.
    child = spawn(
      'bash',
      ['-c', 'set -euo pipefail; flock -n 7; flock -n 8; flock -n 9; printf "HELD\\n"; read -r _'],
      {
        stdio: [
          'pipe',
          'pipe',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          ...descriptors.map((fd) => fd.fd),
        ],
      },
    );
    child.stdin.on('error', () => {});
    closed = once(child, 'close');
    await new Promise((resolve, reject) => {
      let raw = '';
      child.stdout.on('data', (chunk) => {
        raw += chunk.toString();
        if (raw === 'HELD\n') resolve();
        else if (raw.length > 64) reject(new Error('recovery_lock_output_invalid'));
      });
      child.once('exit', () => reject(new Error('recovery_locks_busy')));
      child.once('error', () => reject(new Error('recovery_locks_unavailable')));
      timer = setTimeout(() => reject(new Error('recovery_lock_deadline')), 5000);
    });
    clearTimeout(timer);
    const assertLocks = async () => {
      requireFact(
        child.exitCode === null && child.signalCode === null,
        'recovery_lock_holder_lost',
      );
      for (const [index, path] of paths.entries()) {
        const file = await lstat(path);
        const description = await descriptors[index].stat();
        const info = await readFile(`/proc/${process.pid}/fdinfo/${descriptors[index].fd}`, 'utf8');
        requireFact(
          file.isFile() &&
            !file.isSymbolicLink() &&
            file.uid === uid &&
            file.nlink === 1 &&
            (file.mode & 0o777) === 0o600 &&
            description.isFile() &&
            description.uid === uid &&
            description.nlink === 1 &&
            (description.mode & 0o777) === 0o600 &&
            file.dev === description.dev &&
            file.ino === description.ino &&
            /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF$/mu.test(info),
          'recovery_lock_authority_lost',
        );
      }
      requireFact(
        child.exitCode === null && child.signalCode === null,
        'recovery_lock_holder_lost',
      );
    };
    await assertLocks();
    return await work({ assertLocks, holderPid: child.pid });
  } finally {
    clearTimeout(timer);
    if (child) {
      child.stdin.end('done\n');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        await closed;
      } finally {
        clearTimeout(deadline);
      }
    }
    await Promise.all(descriptors.map((fd) => fd.close()));
  }
}

async function noActors() {
  const pattern =
    '[v]ps-(pull-build-up|runtime-rollback|release-rollback|finalize-release-recovery|deploy-karavan|rollback-karavan|source-abandonment|legacy-cold-recovery|backlog-cancellation)[.]sh|[r]elease-karavan[.]sh|[b]ackup-postgres[.]sh|[r]estore-postgres-backup-smoke[.]sh|[l]egacy-cold-(host|client|recovery|runtime)|[s]ource-abandonment-(host|session|corrective|predrain|abort)|[m]ultibot-(legacy-cold-recovery|source-abandonment)|[b]acklog-cancellation.*(host|controller)|[d]ocker (compose|buildx).* (infra|karavan|maxim)[^ ]*';
  let output;
  try {
    output = (await execute('pgrep', ['-f', pattern], { timeout: 2000, maxBuffer: 8192 })).stdout;
  } catch (error) {
    if (error.code === 1) return true;
    fail('actor_observation_failed');
  }
  const pids = output.trim().split('\n');
  requireFact(pids.length <= 256, 'actor_observation_capped');
  for (const pid of pids) {
    requireFact(/^[1-9][0-9]*$/u.test(pid), 'actor_observation_failed');
    if (Number(pid) === process.pid) continue;
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      const raw = await readFile(`/proc/${pid}/cmdline`);
      requireFact(raw.length <= 65536, 'actor_observation_capped');
      const args = raw.toString('utf8').split('\0');
      if (
        [MAJOR, KARAVAN].some(
          (root) =>
            cwd === root ||
            cwd.startsWith(`${root}/`) ||
            args.some((arg) => arg.startsWith(`${root}/`)),
        ) ||
        args.some((arg) => /(?:legacy-cold|source-abandonment|backlog-cancellation)/u.test(arg))
      )
        return false;
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) fail('actor_observation_failed');
    }
  }
  return true;
}

async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}
// FLAG: The session journal owns a directory containing journal.json and marker.json.
// Any entry at its real path, including a link or unknown file, retains the fence.
export async function observePreadmissionMaintenanceBoundary(stateDirectory = STATE) {
  const predrainAbsent = await absent(join(stateDirectory, 'queue-predrain-pending.json'));
  const sessionAbsent = await absent(join(stateDirectory, 'source-abandonment-session'));
  requireFact(predrainAbsent && sessionAbsent, 'active_maintenance_journal');
  return { predrainAbsent, sessionAbsent };
}

async function boundedEntries(path) {
  const directory = await opendir(path);
  const result = [];
  try {
    for (let entry = await directory.read(); entry !== null; entry = await directory.read()) {
      result.push(entry.name);
      requireFact(result.length <= 256, 'private_directory_budget');
    }
  } finally {
    await directory.close();
  }
  return result.sort();
}
export async function observePreadmissionSiblings(
  privateDirectory,
  operationId,
  { ownerStartedAtMs = started, operatorUid = process.getuid() } = {},
) {
  requireFact(
    Number.isFinite(ownerStartedAtMs) && Number.isSafeInteger(operatorUid) && operatorUid >= 0,
    'unsafe_sibling_private_directory',
  );
  const siblings = await boundedEntries(privateDirectory);
  const candidates = [];
  const historicalFiles = [];
  for (const name of siblings) {
    const stat = await lstat(join(privateDirectory, name));
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      requireFact(
        stat.uid === operatorUid && (stat.mode & 0o777) === 0o700,
        'unsafe_sibling_private_directory',
      );
      if (stat.ctimeMs >= ownerStartedAtMs && stat.ctimeMs <= ownerStartedAtMs + 10_000)
        candidates.push(name);
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      // FLAG: Historical sibling files are opaque and inert to this operation.
      // Read metadata only; any later write changes ctime and refuses recovery.
      const file = {
        nameSha256: digest(name),
        kind: 'regular',
        uid: stat.uid,
        mode: stat.mode & 0o7777,
        nlink: stat.nlink,
        size: stat.size,
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      };
      historicalFiles.push(
        ...projectHistoricalSiblingFiles(
          [file],
          operatorUid,
          ownerStartedAtMs,
          'unsafe_historical_sibling_file',
        ),
      );
    } else fail('unsafe_sibling_private_directory');
  }
  historicalFiles.sort((left, right) => left.nameSha256.localeCompare(right.nameSha256));
  return {
    uniqueWindowDirectory: candidates.length === 1 && candidates[0] === operationId,
    historicalSiblingFiles: historicalFiles,
  };
}

async function operationObservation(request) {
  const path = join(PRIVATE, request.operationId);
  await ancestors(path);
  const before = await lstat(path);
  requireFact(
    before.uid === process.getuid() && (before.mode & 0o777) === 0o700,
    'unsafe_operation_directory',
  );
  const entries = await boundedEntries(path);
  requireFact(
    JSON.stringify(entries) === JSON.stringify(['context.json', 'queue-control.cjs']),
    'unexpected_private_artifact',
  );
  const context = await boundedFile(join(path, 'context.json'), 65536);
  const queueControl = await boundedFile(join(path, 'queue-control.cjs'), 65536);
  const siblingObservation = await observePreadmissionSiblings(PRIVATE, request.operationId);
  const after = await lstat(path);
  requireFact(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs,
    'private_directory_changed',
  );
  return {
    rawContext: validateContext(JSON.parse(context.bytes.toString('utf8'))),
    publicObservation: {
      idSha256: digest(request.operationId),
      directory: {
        uid: after.uid,
        mode: after.mode & 0o777,
        dev: after.dev,
        ino: after.ino,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
      },
      entries,
      ...siblingObservation,
      context: metadata(context),
      queueControl: metadata(queueControl),
      contextFacts: inspectPreadmissionContext(context.bytes),
    },
  };
}
async function sourceObservation(request) {
  const majorSha = (await git(MAJOR, ['rev-parse', '--verify', 'HEAD'])).trim();
  const karavanSha = (await git(KARAVAN, ['rev-parse', '--verify', 'HEAD'])).trim();
  requireFact(majorSha === request.sourceSha && SOURCE.test(karavanSha), 'exact_source_unproved');
  const majorClean =
    (await git(MAJOR, ['status', '--porcelain', '--untracked-files=normal'])).trim() === '';
  const karavanClean =
    (await git(KARAVAN, ['status', '--porcelain', '--untracked-files=normal'])).trim() === '';
  requireFact(majorClean && karavanClean, 'exact_source_unproved');
  const files = {
    host: 'infra/scripts/legacy-cold-host.mjs',
    client: 'infra/scripts/legacy-cold-client.mjs',
    journal: 'infra/scripts/legacy-cold-journal.mjs',
    protocol: 'infra/scripts/legacy-cold-protocol.mjs',
    storeAdapter: 'infra/scripts/legacy-cold-store-adapter.mjs',
    sourceHost: 'infra/scripts/source-abandonment-host.mjs',
    sourceSessionJournal: 'infra/scripts/source-abandonment-session-journal.mjs',
    sourceWrapper: 'infra/scripts/vps-source-abandonment.sh',
    deployLock: 'infra/scripts/lib/deploy-lock.sh',
    maintenanceGuard: 'infra/scripts/lib/legacy-cold-maintenance.sh',
    runtime: 'infra/scripts/legacy-cold-runtime.mjs',
    smokes: 'infra/scripts/legacy-cold-smokes.mjs',
    queueControl: 'infra/scripts/webhook-queue-rollout-control.cjs',
    fleet: 'infra/scripts/monitor-capacity-probe.cjs',
    photoBoundary: 'infra/scripts/photo-native-runtime-boundary.cjs',
    readiness: 'infra/scripts/monitor-ready-status.cjs',
    admission: 'infra/scripts/lib/pair-release-admission.sh',
    reporter: 'infra/scripts/pair-release-state.mjs',
  };
  const hashes = {};
  for (const [key, relative] of Object.entries(files)) {
    const path = join(MAJOR, relative);
    await ancestors(dirname(path));
    const current = await boundedFile(path, 512 * 1024);
    const original = await git(MAJOR, ['show', `${request.sourceSha}:${relative}`]);
    requireFact(digest(current.bytes) === digest(original), 'source_bytes_changed');
    hashes[key] = digest(current.bytes);
    if (['admission', 'reporter'].includes(key)) {
      const installed = await boundedFile(
        `${ROOT}/${key === 'admission' ? 'admission.sh' : 'state.mjs'}`,
        262144,
      );
      requireFact(
        installed.stat.uid === 0 &&
          !(installed.stat.mode & 0o022) &&
          digest(installed.bytes) === hashes[key],
        'installed_controller_changed',
      );
    }
  }
  const shadowSources = {};
  for (const [name, size, hash] of shadowGraph) {
    const relative = `infra/scripts/${name}`;
    const path = join(MAJOR, relative);
    await ancestors(dirname(path));
    const current = await boundedShadowSourceFile(path, size);
    const original = await git(MAJOR, [
      'show',
      '--no-ext-diff',
      '--no-textconv',
      `${request.sourceSha}:${relative}`,
    ]);
    requireFact(
      Buffer.byteLength(original) === size &&
        digest(original) === hash &&
        digest(current.bytes) === hash,
      'shadow_source_unproved',
    );
    hashes[relative] = hash;
    shadowSources[relative] = {
      bytes: current.bytes,
      uid: current.stat.uid,
      gid: current.stat.gid,
      mode: current.stat.mode & 0o7777,
      links: current.stat.nlink,
    };
  }
  return {
    majorSha,
    karavanSha,
    majorClean,
    karavanClean,
    installedMatch: true,
    hashes,
    shadowSources,
  };
}

async function observe(request) {
  await validatePaths();
  const original = await boundedFile(OWNER, 2048);
  const owner = parsePreadmissionOwner(original.bytes);
  const { shadowSources, ...source } = await sourceObservation(request);
  const reported = JSON.parse(
    await command('bash', [`${ROOT}/admission.sh`, 'state'], { env: gitEnvironment() }),
  );
  const snapshot = Object.fromEntries(
    Object.entries(reported).filter(
      ([key]) => !['fingerprint', 'admission', 'observedAt'].includes(key),
    ),
  );
  let processState = { present: false };
  try {
    const stat = await readFile(`/proc/${owner.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    processState = { present: true, startTicks: fields[19], state: fields[0] };
  } catch (error) {
    if (error.code !== 'ENOENT') fail('owner_process_observation_failed');
  }
  const operation = await operationObservation(request);
  const journals = {};
  for (const [key, name, maximum] of [
    ['cold', 'legacy-cold-maintenance.json', 128 * 1024],
    ['marker', 'legacy-cold-identity.json', 16384],
    ['backlog', 'backlog-cancellation.json', 65536],
  ]) {
    const file = await boundedFile(join(STATE, name), maximum);
    const parsed = JSON.parse(file.bytes.toString('utf8'));
    journals[key] = { ...metadata(file), ...(key === 'marker' ? {} : { phase: parsed.phase }) };
  }
  Object.assign(journals, await observePreadmissionMaintenanceBoundary());
  const list = (await command('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'])).trim();
  const ids = list ? list.split(/\s+/u) : [];
  requireFact(
    ids.length > 0 &&
      ids.length <= 128 &&
      ids.every((id) => HASH.test(id)) &&
      new Set(ids).size === ids.length,
    'runtime_inventory_unproved',
  );
  const rows = JSON.parse(
    await command('docker', ['inspect', ...ids], { maxBuffer: 16 * 1024 * 1024 }),
  );
  requireFact(
    Array.isArray(rows) && rows.length === ids.length && rows.every((row) => ids.includes(row.Id)),
    'runtime_inventory_unproved',
  );
  const api = snapshot.major?.components?.find((component) => component.id === 'api-shared');
  requireFact(
    api?.sourceSha === PREADMISSION_SOURCE && IMAGE.test(api.imageId ?? ''),
    'pair_manifest_unproved',
  );
  // FLAG: The reviewed pinned capacity parser is read-only (Docker inspect + pure
  // boundary checks). Reuse the real native isolation contract, without SQL or
  // readiness/action probes. Its entire dependency source was checked above.
  const require = createRequire(`${MAJOR}/package.json`);
  const fleet = require(`${MAJOR}/infra/scripts/monitor-capacity-probe.cjs`);
  const fleetEvidence = fleet.summarizeApiFleet(
    PREADMISSION_SERVICES.filter((service) => service.startsWith('api-')),
    {
      sourceSha: PREADMISSION_SOURCE,
      imageId: api.imageId,
      imageRef: `maxim-api:${PREADMISSION_SOURCE}`,
    },
    fleet.parseApiFleetInspection(JSON.stringify(rows)),
    'ocr-native-sandbox,photo-native-sandbox',
  );
  let shadow = null;
  if (shadowCandidates(rows).length > 0) {
    const shadowRuntime = await loadPreadmissionShadowRuntime(shadowSources);
    const images = JSON.parse(await command('docker', ['image', 'inspect', SHADOW_IMAGE]));
    const networks = JSON.parse(await command('docker', ['network', 'inspect', SHADOW_NETWORK]));
    requireFact(
      Array.isArray(images) &&
        images.length === 1 &&
        Array.isArray(networks) &&
        networks.length === 1,
      'shadow_runtime_unproved',
    );
    shadow = inspectPreadmissionShadow(rows, {
      imageId: api.imageId,
      image: images[0],
      network: networks[0],
      runtime: shadowRuntime,
    });
  }
  const runtime = inspectPreadmissionRuntime(rows, {
    imageId: api.imageId,
    context: operation.rawContext,
    fleet: fleetEvidence,
    shadow,
  });
  const network = JSON.parse(
    await command('docker', ['network', 'inspect', operation.rawContext.networkId], {
      maxBuffer: 1024 * 1024,
    }),
  );
  requireFact(
    network.length === 1 &&
      network[0].Id === operation.rawContext.networkId &&
      network[0].Name === 'infra_default' &&
      network[0].Labels?.['com.docker.compose.project'] === 'infra',
    'runtime_network_unproved',
  );
  const admin = rows.find(
    (row) =>
      row.Config?.Labels?.['com.docker.compose.project'] === 'infra' &&
      row.Config.Labels['com.docker.compose.service'] === 'api-admin',
  );
  const queueSource = await boundedFile(
    `${MAJOR}/infra/scripts/webhook-queue-rollout-control.cjs`,
    65536,
  );
  requireFact(
    digest(queueSource.bytes) === PREADMISSION_CONTRACT.queueControlSha256,
    'queue_source_changed',
  );
  // The literal status operation contains no writes, queue pauses or owner cleanup.
  runtime.queueFence = JSON.parse(
    await command('docker', ['exec', '-i', admin.Id, 'node', '-', 'status'], {
      input: queueSource.bytes,
      maxBuffer: 65536,
    }),
  );
  const lock = await lstat(LOCKS[0]);
  return {
    operatorUid: process.getuid(),
    locksHeld: true,
    owner: { ...metadata(original), fields: owner },
    ownerBytes: original.bytes,
    admissionInode: `${lock.dev}:${lock.ino}`,
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    process: processState,
    noActors: await noActors(),
    source,
    snapshot,
    fingerprint: reported.fingerprint,
    operation: operation.publicObservation,
    journals,
    runtime,
  };
}

async function fsync(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export async function archivePreadmission({
  ownerPath,
  archiveDirectory,
  operatorUid,
  ownerBytes,
  ownerIdentity,
  proof,
  assertLocks,
  reobserve,
}) {
  await assertLocks();
  await ancestors(dirname(archiveDirectory), true);
  try {
    await mkdir(archiveDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const directory = await lstat(archiveDirectory);
  requireFact(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      directory.uid === operatorUid &&
      (directory.mode & 0o777) === 0o700,
    'unsafe_recovery_archive',
  );
  await fsync(dirname(archiveDirectory));
  const archivedOwner = join(archiveDirectory, `${proof.ownerSha256}.owner`);
  const proofPath = join(archiveDirectory, `${proof.ownerSha256}.proof.json`);
  requireFact(await absent(archivedOwner), 'recovery_archive_exists');
  const proofBytes = Buffer.from(`${JSON.stringify(proof)}\n`);
  try {
    const file = await open(
      proofPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(proofBytes);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await boundedFile(proofPath, 64 * 1024);
    requireFact(
      previous.bytes.equals(proofBytes) &&
        previous.stat.uid === operatorUid &&
        (previous.stat.mode & 0o777) === 0o600,
      'recovery_proof_conflict',
    );
  }
  await fsync(archiveDirectory);
  // FLAG: Durable proof precedes the final full re-observation and unchanged-inode
  // move. Failure retains the original owner and all persistent lock files.
  if (reobserve) await reobserve();
  const original = await boundedFile(ownerPath, 2048);
  requireFact(
    original.bytes.equals(Buffer.from(ownerBytes)) &&
      digest(original.bytes) === proof.ownerSha256 &&
      original.stat.uid === operatorUid &&
      (original.stat.mode & 0o777) === 0o600 &&
      original.stat.nlink === 1 &&
      ['dev', 'ino', 'uid'].every((key) => original.stat[key] === ownerIdentity[key]),
    'owner_changed_before_archive',
  );
  requireFact(directory.dev === original.stat.dev, 'recovery_archive_filesystem_changed');
  await assertLocks();
  await command('mv', ['--no-clobber', '--no-target-directory', '--', ownerPath, archivedOwner]);
  const moved = await boundedFile(archivedOwner, 2048);
  requireFact(
    moved.stat.dev === original.stat.dev &&
      moved.stat.ino === original.stat.ino &&
      moved.bytes.equals(original.bytes) &&
      (await absent(ownerPath)),
    'recovery_archive_identity_changed',
  );
  await fsync(archivedOwner);
  await fsync(archiveDirectory);
  await fsync(dirname(ownerPath));
}

export async function recoverPreadmission(request, dependencies) {
  const first = await dependencies.observe(request);
  const proof = buildPreadmissionProof(request, first);
  const proofSha256 = digest(JSON.stringify(proof));
  if (request.mode === 'apply') {
    requireFact(request.proofSha256 === proofSha256, 'preview_proof_changed');
    const next = await dependencies.observe(request);
    requireFact(
      digest(JSON.stringify(buildPreadmissionProof(request, next))) === proofSha256,
      'recovery_evidence_changed',
    );
    await dependencies.archive(next, proof);
  } else requireFact(request.mode === 'preview', 'invalid_arguments');
  return {
    ...proof,
    proofSha256,
    mode: request.mode,
    archived: request.mode === 'apply',
    runtimeMutation: false,
  };
}
async function main() {
  const request = parsePreadmissionRecoveryArgs(process.argv.slice(2));
  await validatePaths();
  return withPreadmissionLocks(LOCKS, ({ assertLocks }) => {
    const fresh = async () => {
      await assertLocks();
      const value = await observe(request);
      await assertLocks();
      return value;
    };
    return recoverPreadmission(request, {
      observe: fresh,
      archive: (observation, proof) =>
        archivePreadmission({
          ownerPath: OWNER,
          archiveDirectory: `${ROOT}/state/preadmission-refusal-recoveries`,
          operatorUid: process.getuid(),
          ownerBytes: observation.ownerBytes,
          ownerIdentity: observation.owner,
          proof,
          assertLocks,
          reobserve: async () =>
            requireFact(
              digest(JSON.stringify(buildPreadmissionProof(request, await fresh()))) ===
                digest(JSON.stringify(proof)),
              'recovery_evidence_changed',
            ),
        }),
    });
  });
}
if (import.meta.main) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const code = /^[a-z_]+$/u.test(error.message ?? '')
        ? error.message
        : 'preadmission_observation_failed';
      process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
      process.exitCode = 1;
    });
}
