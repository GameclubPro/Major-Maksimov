import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORT_MODEL } from './support-llm-profile.mjs';

const apiProfile = {
  endpoint: 'https://5x2.gptclaudegemini.xyz',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  protocol: 'chat-completions',
  // Application budgets, not claims about the provider's model context or prices.
  inputBytes: 24000,
  outputTokens: 4096,
};
export const SUPPORT_API_PROFILE = Object.freeze({
  ...apiProfile,
  sha256: createHash('sha256').update(JSON.stringify(apiProfile)).digest('hex'),
});

function privateFile(path, limit) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
    stat.size > limit
  )
    throw new Error('support_provider_private_file');
  return readFileSync(path, 'utf8');
}

export function readSupportProvider(root) {
  const state = join(root, 'service');
  const path = join(state, 'provider.json');
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { backend: 'cpu', model: SUPPORT_MODEL.alias, keyPath: join(state, 'api-key') };
  }
  let value;
  const content = privateFile(path, 512);
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('support_provider_config');
  }
  if (value?.version !== 1 || value.backend !== 'api' || Object.keys(value).length !== 2)
    throw new Error('support_provider_config');
  return {
    backend: 'api',
    model: SUPPORT_API_PROFILE.model,
    apiProfileSha256: SUPPORT_API_PROFILE.sha256,
    keyPath: join(state, 'provider-api-key'),
  };
}

export function readSupportProviderKey(provider) {
  const key = privateFile(provider.keyPath, 1024).trim();
  const valid =
    provider.backend === 'api'
      ? /^[A-Za-z0-9._-]{20,512}$/u.test(key)
      : /^[a-f0-9]{64}$/u.test(key);
  if (!valid) throw new Error('support_provider_key');
  return key;
}

export async function supportApiJson(path, key, signal, fetchImpl = fetch, payload) {
  // FLAG: Only the owner's pinned HTTPS provider receives this credential. No redirects,
  // automatic retries, raw provider errors or fallback inference can escape this boundary.
  if (!['/v1/models', '/v1/chat/completions'].includes(path))
    throw new Error('support_provider_path');
  signal?.throwIfAborted();
  const response = await fetchImpl(new URL(path, SUPPORT_API_PROFILE.endpoint), {
    method: payload === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (
    !response.ok ||
    !response.body ||
    !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
  ) {
    await response.body?.cancel();
    throw new Error(`support_provider_http_${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 128 * 1024) throw new Error('support_provider_output_limit');
      chunks.push(item.value);
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new Error('support_provider_json');
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function attestSupportApi(key, signal, fetchImpl = fetch) {
  const body = await supportApiJson('/v1/models', key, signal, fetchImpl);
  if (
    !Array.isArray(body?.data) ||
    body.data.length > 512 ||
    !body.data.some((model) => model?.id === SUPPORT_API_PROFILE.model)
  )
    throw new Error('support_provider_model');
}
