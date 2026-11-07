import {
  WORKSTATION_ARTIFACTS,
  WORKSTATION_IDENTITY,
  workstationModelArgs,
} from './commercial-llm-workstation-profile.mjs';
import { COMMERCIAL_LLM_RUNTIME } from './commercial-llm-profiles.mjs';

export const POOL_NODE_IDS = Object.freeze(['pc-a-4b', 'pc-b-9b', 'pc-a-cpu-9b']);
export const POOL_HTTP = 'http://127.0.0.1:18084';
export const POOL_MAX_REQUEST_MS = 20_000;
export const POOL_FRAME_BYTES = 64 * 1024;
export const POOL_REQUEST_BYTES = 32 * 1024;
export const POOL_RESPONSE_BYTES = 16 * 1024;
export const POOL_SESSION_FRAMES_PER_MINUTE = 512;

const profiles = Object.freeze({
  'pc-a-4b': Object.freeze({
    nodeId: 'pc-a-4b',
    device: 'cuda',
    http: POOL_HTTP,
    identity: Object.freeze({ ...WORKSTATION_IDENTITY, protocolVersion: 2 }),
    artifacts: WORKSTATION_ARTIFACTS,
  }),
  'pc-b-9b': Object.freeze({
    nodeId: 'pc-b-9b',
    device: 'cuda',
    http: POOL_HTTP,
    identity: Object.freeze({
      ...WORKSTATION_IDENTITY,
      protocolVersion: 2,
      modelAlias: COMMERCIAL_LLM_RUNTIME.alias,
      modelSha256: COMMERCIAL_LLM_RUNTIME.modelSha256,
      promptSha256: COMMERCIAL_LLM_RUNTIME.smokePromptSha256,
      chatTemplateSha256: COMMERCIAL_LLM_RUNTIME.templateSha256,
    }),
    artifacts: Object.freeze([
      Object.freeze({
        name: 'Qwen3.5-9B-Q5_K_M.gguf',
        bytes: COMMERCIAL_LLM_RUNTIME.modelBytes,
        sha256: COMMERCIAL_LLM_RUNTIME.modelSha256,
      }),
      ...WORKSTATION_ARTIFACTS.slice(1),
    ]),
  }),
  'pc-a-cpu-9b': Object.freeze({
    nodeId: 'pc-a-cpu-9b',
    device: 'cpu',
    http: 'http://127.0.0.1:18085',
    threads: 6,
    identity: Object.freeze({
      ...WORKSTATION_IDENTITY,
      protocolVersion: 2,
      modelAlias: COMMERCIAL_LLM_RUNTIME.alias,
      modelSha256: COMMERCIAL_LLM_RUNTIME.modelSha256,
      promptSha256: COMMERCIAL_LLM_RUNTIME.smokePromptSha256,
      chatTemplateSha256: COMMERCIAL_LLM_RUNTIME.templateSha256,
    }),
    artifacts: Object.freeze([
      Object.freeze({
        name: 'Qwen3.5-9B-Q5_K_M.gguf',
        bytes: COMMERCIAL_LLM_RUNTIME.modelBytes,
        sha256: COMMERCIAL_LLM_RUNTIME.modelSha256,
      }),
      ...WORKSTATION_ARTIFACTS.slice(1),
    ]),
  }),
});

export function poolProfile(nodeId) {
  if (!POOL_NODE_IDS.includes(nodeId)) throw new Error('pool_node_refused');
  return profiles[nodeId];
}

export function poolIdentityMatches(nodeId, value) {
  const expected = poolProfile(nodeId).identity;
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, pinned]) => value[name] === pinned)
  );
}

export function poolModelArgs(nodeId, root, keyFile) {
  const profile = poolProfile(nodeId);
  const args = workstationModelArgs(root, keyFile);
  args[args.indexOf('--model') + 1] = `${root}/${profile.artifacts[0].name}`;
  args[args.indexOf('--alias') + 1] = profile.identity.modelAlias;
  args[args.indexOf('--port') + 1] = new URL(profile.http).port;
  if (profile.device === 'cpu') {
    // FLAG: The additional CPU worker has its own port and cannot consume the 4B GPU slot.
    args[args.indexOf('--n-gpu-layers') + 1] = '0';
    args[args.indexOf('--threads') + 1] = String(profile.threads);
    args[args.indexOf('--threads-batch') + 1] = String(profile.threads);
  }
  return args.map((value) => (value === '--no-slots' ? '--slots' : value));
}

export function poolSshArgs(nodeId, alias = 'maxim-vps') {
  poolProfile(nodeId);
  if (typeof alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(alias))
    throw new Error('pool_ssh_alias_refused');
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ClearAllForwardings=yes',
    alias,
    `cd /var/www/Chat_bot && exec bash ./infra/scripts/vps-commercial-llm.sh workstation-pool-bridge ${nodeId}`,
  ];
}

export function poolReconnectDelay(attempt, random = Math.random) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('pool_retry_refused');
  const cap = Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4));
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('pool_jitter_refused');
  return Math.floor(cap / 2 + (cap / 2) * sample);
}
