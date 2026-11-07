import {
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  COMMERCIAL_LLM_MODEL_ALIAS,
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
} from './commercial-llm.protocol';
import { COMMERCIAL_LLM_WORKSTATION_IDENTITY } from './commercial-llm-workstation.protocol';

export const LEGACY_POOL_NODE_IDS = ['server-9b', 'pc-a-4b', 'pc-b-9b'] as const;
export const POOL_NODE_IDS = [...LEGACY_POOL_NODE_IDS, 'pc-a-cpu-9b'] as const;
export type CommercialLlmPoolNodeId = (typeof POOL_NODE_IDS)[number];
export type CommercialLlmPoolBridgeNodeId = Exclude<CommercialLlmPoolNodeId, 'server-9b'>;
export const COMMERCIAL_LLM_POOL_PROTOCOL_VERSION = 2;
export const COMMERCIAL_LLM_POOL_LEASE_MS = 10_000;
export const COMMERCIAL_LLM_POOL_HEARTBEAT_MS = 6_000;
export const COMMERCIAL_LLM_POOL_TIMEOUT_MS = 20_000;
export const COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS = 6_000;
// FLAG: Closed fixtures after the production primer took up to 15.5s under local QA load.
// Retain 18s of the original budget for PC CPU admission; this is not a p95 guarantee.
export const COMMERCIAL_LLM_POOL_PC_CPU_MIN_REMAINING_MS = 18_000;
export const COMMERCIAL_LLM_POOL_FRAME_BYTES = 64 * 1024;
export const COMMERCIAL_LLM_POOL_REQUEST_BYTES = 32 * 1024;
export const COMMERCIAL_LLM_POOL_RESPONSE_BYTES = 16 * 1024;
export const COMMERCIAL_LLM_POOL_FRAMES_PER_MINUTE = 512;
export const POOL_PENDING_KEYS = [
  'commercial-llm-enforcement:pool-v2:slot',
  'commercial-llm-enforcement:pool-v2:slot-next',
] as const;
export const POOL_DISPATCH_PENDING_KEY = 'commercial-llm-enforcement:pool-v2:dispatch-pending';
export const POOL_ADMISSION_WORKER_KEY = 'commercial-llm-enforcement:pool-v2:worker';

export type CommercialLlmPoolIdentity = Readonly<{
  protocolVersion: 2;
  modelAlias: string;
  modelSha256: string;
  promptSha256: string;
  chatTemplateSha256: string;
  runtimeVersion: string;
  runtimeImageSha256?: string;
  runtimeArtifactSha256?: string;
  runtimeSupportSha256?: string;
}>;
export type CommercialLlmPoolProfile = Readonly<{
  nodeId: CommercialLlmPoolNodeId;
  model: '4b' | '9b';
  transport: 'http' | 'bridge';
  identity: CommercialLlmPoolIdentity;
}>;

const serverIdentity: CommercialLlmPoolIdentity = Object.freeze({
  protocolVersion: 2,
  modelAlias: COMMERCIAL_LLM_MODEL_ALIAS,
  modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
  promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
  chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  runtimeVersion: COMMERCIAL_LLM_RUNTIME_VERSION,
  runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
});
const pc4bIdentity: CommercialLlmPoolIdentity = Object.freeze({
  ...COMMERCIAL_LLM_WORKSTATION_IDENTITY,
  protocolVersion: 2,
});
const pc9bIdentity: CommercialLlmPoolIdentity = Object.freeze({
  ...pc4bIdentity,
  modelAlias: COMMERCIAL_LLM_MODEL_ALIAS,
  modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
  promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
  chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
});

// FLAG: Freeze the original serialized three-profile shape and order for retained v2/v3 sources.
// New node names are server-owned capabilities; a hello cannot select another profile.
export const LEGACY_COMMERCIAL_LLM_POOL_PROFILES: Readonly<
  Record<(typeof LEGACY_POOL_NODE_IDS)[number], CommercialLlmPoolProfile>
> = Object.freeze({
  'server-9b': Object.freeze({
    nodeId: 'server-9b',
    model: '9b',
    transport: 'http',
    identity: serverIdentity,
  }),
  'pc-a-4b': Object.freeze({
    nodeId: 'pc-a-4b',
    model: '4b',
    transport: 'bridge',
    identity: pc4bIdentity,
  }),
  'pc-b-9b': Object.freeze({
    nodeId: 'pc-b-9b',
    model: '9b',
    transport: 'bridge',
    identity: pc9bIdentity,
  }),
});

// FLAG: The reviewed workstation binary also supports CPU-only execution. The CPU bridge
// has its own node fences; its launcher enforces zero GPU layers and a separate endpoint.
const pcCpu9bIdentity: CommercialLlmPoolIdentity = Object.freeze({
  protocolVersion: 2,
  modelAlias: COMMERCIAL_LLM_MODEL_ALIAS,
  modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
  promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
  chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  runtimeVersion: COMMERCIAL_LLM_WORKSTATION_IDENTITY.runtimeVersion,
  runtimeArtifactSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.runtimeArtifactSha256,
  runtimeSupportSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.runtimeSupportSha256,
});
export const COMMERCIAL_LLM_POOL_PROFILES: Readonly<
  Record<CommercialLlmPoolNodeId, CommercialLlmPoolProfile>
> = Object.freeze({
  ...LEGACY_COMMERCIAL_LLM_POOL_PROFILES,
  'pc-a-cpu-9b': Object.freeze({
    nodeId: 'pc-a-cpu-9b',
    model: '9b',
    transport: 'bridge',
    identity: pcCpu9bIdentity,
  }),
});
export function commercialLlmPoolMinRemainingMs(nodeId: CommercialLlmPoolNodeId): number {
  if (nodeId === 'server-9b') return COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS;
  return nodeId === 'pc-a-cpu-9b' ? COMMERCIAL_LLM_POOL_PC_CPU_MIN_REMAINING_MS : 0;
}

export function isCommercialLlmPoolNodeId(value: unknown): value is CommercialLlmPoolNodeId {
  return typeof value === 'string' && POOL_NODE_IDS.some((nodeId) => nodeId === value);
}

export function commercialLlmPoolIdentityMatches(
  nodeId: CommercialLlmPoolNodeId,
  value: unknown,
): value is CommercialLlmPoolIdentity {
  if (
    !isCommercialLlmPoolNodeId(nodeId) ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return false;
  const record = value as Record<string, unknown>;
  const identity = COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity;
  return (
    Object.keys(record).length === Object.keys(identity).length &&
    Object.entries(identity).every(([key, expected]) => record[key] === expected)
  );
}

export function commercialLlmPoolNodeKeys(nodeId: CommercialLlmPoolNodeId) {
  if (!isCommercialLlmPoolNodeId(nodeId)) throw new Error('pool_node_refused');
  const prefix = `commercial-llm-pool:v2:node:${nodeId}`;
  return {
    lease: `${prefix}:lease`,
    heartbeat: `${prefix}:heartbeat`,
    slot: `${prefix}:slot`,
    response: `${prefix}:response`,
  } as const;
}

export function commercialLlmPoolJobKey(jobId: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(jobId))
    throw new Error('pool_job_refused');
  return `commercial-llm-pool:v2:job:${jobId}`;
}
