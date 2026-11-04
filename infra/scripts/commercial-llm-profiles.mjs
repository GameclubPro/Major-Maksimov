import { createHash } from 'node:crypto';

const stateDir = '/var/lib/maxim-deploy/commercial-llm';
const modelDir = `${stateDir}/models`;
export const COMMERCIAL_LLM_LEGACY_RUNTIME = Object.freeze({
  schemaVersion: 1,
  service: 'gemma-commercial-shadow',
  alias: 'gemma4-commercial-shadow',
  modelContainerPath: '/models/gemma4.gguf',
  templateMode: 'file',
  imageRef:
    'ghcr.io/ggml-org/llama.cpp@sha256:8badce92ec1860c764ca19c736422e81a12c65d76da57313651a7804bfe6ed40',
  imageId: 'sha256:8badce92ec1860c764ca19c736422e81a12c65d76da57313651a7804bfe6ed40',
  upstreamRevision: 'c7fc5094179bf8a9c73c18593db714f8da41a402',
  upstreamVersion: 'b11804',
  modelSha256: 'a8bdd07a49b895083bb1420bb895ad9ab3e3b8f7d5cc42c7582ca0fa765eede2',
  modelBytes: 17074419072,
  modelManifestSha256: '001e5dafc3c77684c2307ebc6ab8e336e10c9b18eca52acf547d72fc83c3ca8c',
  smokePromptSha256: '2576c4c69ea8cff5ec852e2a28ac9648e10a1be114faffa7499abaaab8450d1f',
  templateSha256: 'ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4',
  templateBytes: 18683,
  licenseSha256: 'a66d4e37329585c918619de71e426057186cb725fbe572e7f28e498077798d52',
  licenseBytes: 11358,
  stateDir,
  modelDir,
  receiptPath: `${stateDir}/current.json`,
  modelPath: `${modelDir}/a8bdd07a49b895083bb1420bb895ad9ab3e3b8f7d5cc42c7582ca0fa765eede2.gguf`,
  templatePath: `${modelDir}/chat_template.jinja`,
  licensePath: `${modelDir}/LICENSE`,
  cpuLimit: 4,
  memoryLimitBytes: 24 * 1024 ** 3,
  pidLimit: 128,
  diskReserveBytes: 10 * 1024 ** 3,
  downloadReserveBytes: 2 * 1024 ** 3,
  minimumAvailableMemoryBytes: 32 * 1024 ** 3,
  downloadRateBytes: 16 * 1024 ** 2,
  downloadDeadlineSeconds: 3600,
});

const qwenArtifact = Object.freeze({
  repository: 'unsloth/Qwen3.5-9B-GGUF',
  revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
  file: 'Qwen3.5-9B-Q5_K_M.gguf',
  bytes: 6577841376,
  sha256: 'dc2a39aef291f91a9116ad214058da0d86eb648743a124bd8c333787c4b9c91c',
});
export const COMMERCIAL_LLM_RUNTIME = Object.freeze({
  ...COMMERCIAL_LLM_LEGACY_RUNTIME,
  alias: 'qwen35-9b-commercial-shadow',
  modelContainerPath: '/models/qwen35-9b.gguf',
  templateMode: 'embedded',
  modelSha256: qwenArtifact.sha256,
  modelBytes: qwenArtifact.bytes,
  modelManifestSha256: createHash('sha256').update(JSON.stringify(qwenArtifact)).digest('hex'),
  smokePromptSha256: '72bbf26f1becc2103002088c0d89383895daf6462d28f4caecd974a242c426bc',
  modelPath: `${modelDir}/${qwenArtifact.sha256}.gguf`,
  cachedModelPath: `${stateDir}/qwen9b-20261024/${qwenArtifact.sha256}.gguf`,
  modelUrl: `https://huggingface.co/${qwenArtifact.repository}/resolve/${qwenArtifact.revision}/${qwenArtifact.file}`,
  templateSha256: '7f0e529032c25183bcd66c7f238da2d377f43be754a94e2725a58c4e16d2ed67',
  templateBytes: 7816,
  templatePath: null,
  licenseSha256: 'bbedc3fda3305820b977265f01b8619d87570a6739de3a5582c3464840f1e57a',
  licenseBytes: 11544,
  licensePath: `${modelDir}/bbedc3fda3305820b977265f01b8619d87570a6739de3a5582c3464840f1e57a.LICENSE`,
  licenseUrl:
    'https://huggingface.co/Qwen/Qwen3.5-9B/raw/c202236235762e1c871ad0ccb60c8ee5ba337b9a/LICENSE',
  cpuLimit: 6,
  memoryLimitBytes: 12 * 1024 ** 3,
  transitionPath: `${stateDir}/qwen35-9b-transition.json`,
});
// FLAG: Historical Gemma/Qwen commands and their completed transition retain no-slots semantics.
// Slot observation is a separate, command-bound generation of the same pinned Qwen model.
export const COMMERCIAL_LLM_SLOTS_RUNTIME = Object.freeze({
  ...COMMERCIAL_LLM_RUNTIME,
  runtimeProfile: 'qwen35-9b-slots-v1',
  slotInspection: true,
  transitionPath: `${stateDir}/qwen35-9b-slots-transition-v1.json`,
});
export function commercialLlmCommand(profile) {
  const command = [
    '--model',
    profile.modelContainerPath,
    '--alias',
    profile.alias,
    '--host',
    '0.0.0.0',
    '--port',
    '8080',
    '--ctx-size',
    '4096',
    '--parallel',
    '1',
    '--threads',
    String(profile.cpuLimit),
    '--threads-batch',
    String(profile.cpuLimit),
    '--threads-http',
    '2',
    '--n-gpu-layers',
    '0',
    '--n-predict',
    '128',
    '--batch-size',
    '128',
    '--ubatch-size',
    '128',
    '--cache-ram',
    '0',
    '--chat-template-file',
    '/models/chat_template.jinja',
    '--chat-template-kwargs',
    '{"enable_thinking":false}',
    '--reasoning',
    'off',
    '--reasoning-budget',
    '0',
    '--no-webui',
    profile.slotInspection === true ? '--slots' : '--no-slots',
    '--no-agent',
    '--no-context-shift',
  ];
  if (profile.templateMode === 'embedded') {
    command.splice(command.indexOf('--chat-template-file'), 2);
    command.push('--jinja');
  }
  return Object.freeze(command);
}

export function commercialLlmCommandSha256(profile) {
  return createHash('sha256')
    .update(JSON.stringify(commercialLlmCommand(profile)))
    .digest('hex');
}

export const COMMERCIAL_LLM_COMMAND = commercialLlmCommand(COMMERCIAL_LLM_RUNTIME);
