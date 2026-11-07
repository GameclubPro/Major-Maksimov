import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  WorkstationFrames as PoolFrames,
  workstationJson,
} from './commercial-llm-workstation-worker.mjs';
import {
  poolProfile,
  poolIdentityMatches,
  POOL_MAX_REQUEST_MS,
  POOL_REQUEST_BYTES,
  POOL_RESPONSE_BYTES,
  POOL_SESSION_FRAMES_PER_MINUTE,
} from './commercial-llm-pool-profile.mjs';
export { PoolFrames };

export function poolJson(path, key, { nodeId = 'pc-b-9b', ...options } = {}) {
  return workstationJson(path, key, { ...options, endpoint: poolProfile(nodeId).http });
}

export class PoolSessionError extends Error {
  constructor(kind, recycleModel) {
    super(kind);
    this.name = 'PoolSessionError';
    this.recycleModel = recycleModel;
  }
}

// FLAG: Slot payloads can include private prompts; return only validated occupancy, never raw data.
export async function poolModelIsIdle(
  key,
  signal,
  { readJson = poolJson, nodeId = 'pc-b-9b' } = {},
) {
  const slots = await readJson('/slots', key, { signal, maximumBytes: 65536, nodeId });
  if (
    !Array.isArray(slots) ||
    slots.length !== 1 ||
    !slots[0] ||
    typeof slots[0] !== 'object' ||
    Array.isArray(slots[0]) ||
    slots[0].id !== 0 ||
    slots[0].n_ctx !== 4096 ||
    typeof slots[0].is_processing !== 'boolean'
  )
    throw new Error('pool_model_slots');
  return !slots[0].is_processing;
}

export async function attestPoolModel(nodeId, key, signal, { readJson = poolJson } = {}) {
  const profile = poolProfile(nodeId);
  const props = await readJson('/props', key, { signal, maximumBytes: 65536, nodeId });
  if (props?.endpoint_slots !== true) throw new Error('pool_model_slots_disabled');
  if (
    typeof props.chat_template !== 'string' ||
    createHash('sha256').update(props.chat_template).digest('hex') !==
      profile.identity.chatTemplateSha256 ||
    props.total_slots !== 1
  )
    throw new Error('pool_model_identity');
  const models = await readJson('/v1/models', key, { signal, nodeId });
  if (
    !Array.isArray(models.data) ||
    models.data.length !== 1 ||
    models.data[0]?.id !== profile.identity.modelAlias
  )
    throw new Error('pool_model_alias');
  if (!(await poolModelIsIdle(key, signal, { readJson, nodeId })))
    throw new Error('pool_model_busy');
}

export function validatePoolRequest(nodeId, value) {
  const profile = poolProfile(nodeId);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.type !== 'request' ||
    Object.keys(value).length !== 4 ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.id) ||
    typeof value.body !== 'string' ||
    Buffer.byteLength(value.body) > POOL_REQUEST_BYTES ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1 ||
    value.timeoutMs > POOL_MAX_REQUEST_MS
  )
    throw new Error('pool_request_shape');
  const body = JSON.parse(value.body);
  const allowed = new Set([
    'model',
    'messages',
    'temperature',
    'seed',
    'cache_prompt',
    'max_tokens',
    'stream',
    'response_format',
  ]);
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.has(key)) ||
    body.model !== profile.identity.modelAlias ||
    body.max_tokens !== 128 ||
    body.stream !== false ||
    body.temperature !== 0 ||
    body.seed !== 0 ||
    body.cache_prompt !== true ||
    body.response_format?.type !== 'json_schema' ||
    body.response_format?.json_schema?.strict !== true ||
    !Array.isArray(body.messages) ||
    body.messages.length !== 2 ||
    body.messages[0]?.role !== 'system' ||
    body.messages[1]?.role !== 'user' ||
    body.messages.some(
      (message) =>
        typeof message.content !== 'string' ||
        !message.content ||
        Object.keys(message).length !== 2,
    )
  )
    throw new Error('pool_request_budget');
  return value;
}

// FLAG: A lost session aborts its sole computation. No stale request is retained or replayed locally.
export async function poolSession(
  ssh,
  nodeId,
  key,
  { signal, onStatus = () => {}, infer = poolJson } = {},
) {
  const identity = poolProfile(nodeId).identity;
  const controller = new AbortController();
  const sessionSignal = AbortSignal.any([
    controller.signal,
    ...(signal ? [signal] : []),
    AbortSignal.timeout(31 * 60_000),
  ]);
  let hello = false,
    busy = false,
    failed = false,
    inflight,
    received = 0,
    windowAt = Date.now(),
    failure;
  const send = async (value) => {
    if (sessionSignal.aborted) throw new Error('pool_session_stopped');
    if (!ssh.stdin.write(JSON.stringify(value) + '\n'))
      await once(ssh.stdin, 'drain', {
        signal: AbortSignal.any([sessionSignal, AbortSignal.timeout(1000)]),
      });
  };
  const stop = () => controller.abort();
  const abort = () => {
    ssh.stdin.destroy();
    ssh.stdout.destroy();
    ssh.kill('SIGTERM');
  };
  ssh.stdin.on('error', stop);
  ssh.once('error', stop);
  ssh.once('close', stop);
  sessionSignal.addEventListener('abort', abort, { once: true });
  const heartbeat = (async () => {
    while (!sessionSignal.aborted) {
      if (hello) await send({ type: 'ready', ready: !busy });
      await pause(1500, undefined, { signal: sessionSignal });
    }
  })();
  void heartbeat.catch(stop);
  const handshakeTimer = setTimeout(() => {
    if (!hello) stop();
  }, 10_000);
  try {
    await send({ type: 'hello', nodeId, identity });
    const decoder = new PoolFrames();
    for await (const chunk of ssh.stdout) {
      for (const frame of decoder.push(chunk)) {
        if (Date.now() - windowAt >= 60_000) {
          received = 0;
          windowAt = Date.now();
        }
        if (++received > POOL_SESSION_FRAMES_PER_MINUTE) throw new Error('pool_frame_rate');
        if (!hello) {
          if (
            frame.type !== 'hello' ||
            Object.keys(frame).length !== 3 ||
            frame.nodeId !== nodeId ||
            !poolIdentityMatches(nodeId, frame.identity)
          )
            throw new Error('pool_bridge_identity');
          hello = true;
          clearTimeout(handshakeTimer);
          onStatus('connected');
          await send({ type: 'ready', ready: true });
          continue;
        }
        const request = validatePoolRequest(nodeId, frame);
        if (busy) throw new Error('pool_concurrent_request');
        busy = true;
        await send({ type: 'ready', ready: false });
        inflight = (async () => {
          const requestSignal = AbortSignal.any([
            sessionSignal,
            AbortSignal.timeout(request.timeoutMs),
          ]);
          const response = await infer('/v1/chat/completions', key, {
            body: request.body,
            signal: requestSignal,
            nodeId,
          });
          requestSignal.throwIfAborted();
          const body = JSON.stringify(response);
          if (Buffer.byteLength(body) > POOL_RESPONSE_BYTES)
            throw new Error('pool_model_output_limit');
          await send({ type: 'response', id: request.id, body });
          busy = false;
          await send({ type: 'ready', ready: true });
          onStatus('classified');
        })();
        void inflight.catch(() => {
          failed = true;
          stop();
        });
      }
    }
    decoder.finish();
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(handshakeTimer);
    controller.abort();
    abort();
    await heartbeat.catch(() => undefined);
    await inflight?.catch(() => undefined);
    sessionSignal.removeEventListener('abort', abort);
    ssh.stdin.removeListener('error', stop);
    ssh.removeListener('error', stop);
    ssh.removeListener('close', stop);
    onStatus('disconnected');
  }
  if (failure || failed || busy) {
    const known = new Set([
      'pool_bridge_identity',
      'pool_concurrent_request',
      'pool_frame_rate',
      'pool_request_shape',
      'pool_request_budget',
    ]);
    const kind = known.has(failure?.message)
      ? failure.message
      : failed || busy
        ? 'pool_model_recycle_required'
        : 'pool_transport_unavailable';
    throw new PoolSessionError(kind, failed || busy);
  }
}
