import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  WORKSTATION_IDENTITY as identity,
  WORKSTATION_HTTP,
  WORKSTATION_FRAME_BYTES,
} from './commercial-llm-workstation-profile.mjs';

export class WorkstationFrames {
  pending = Buffer.alloc(0);
  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > WORKSTATION_FRAME_BYTES) throw new Error('frame_limit');
    const frames = [];
    let at;
    while ((at = this.pending.indexOf(10)) >= 0) {
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(this.pending.subarray(0, at)),
      );
      this.pending = this.pending.subarray(at + 1);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('frame_shape');
      frames.push(value);
    }
    return frames;
  }
  finish() {
    if (this.pending.length) throw new Error('incomplete_frame');
  }
}
export async function workstationJson(
  path,
  key,
  { body, signal, maximumBytes = 16384, fetchImpl = fetch, endpoint = WORKSTATION_HTTP } = {},
) {
  if (![WORKSTATION_HTTP, 'http://127.0.0.1:18085'].includes(endpoint))
    throw new Error('model_endpoint_refused');
  const response = await fetchImpl(new URL(path, endpoint), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body }),
    signal,
    redirect: 'error',
  });
  if (
    !response.ok ||
    !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error('model_http');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximumBytes) throw new Error('model_output_limit');
      chunks.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function attestWorkstationModel(key, signal) {
  const props = await workstationJson('/props', key, { signal, maximumBytes: 65536 });
  if (
    typeof props.chat_template !== 'string' ||
    createHash('sha256').update(props.chat_template).digest('hex') !==
      identity.chatTemplateSha256 ||
    props.total_slots !== 1
  )
    throw new Error('model_identity');
}
export function validateWorkstationRequest(value) {
  if (
    value.type !== 'request' ||
    Object.keys(value).length !== 4 ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9-]{36}$/u.test(value.id) ||
    typeof value.body !== 'string' ||
    Buffer.byteLength(value.body) > 32768 ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1 ||
    value.timeoutMs > 3000
  )
    throw new Error('request_shape');
  const body = JSON.parse(value.body);
  if (
    body.model !== identity.modelAlias ||
    body.max_tokens !== 128 ||
    body.stream !== false ||
    body.temperature !== 0 ||
    !Array.isArray(body.messages) ||
    body.messages.length !== 2 ||
    body.messages[0]?.role !== 'system' ||
    body.messages[1]?.role !== 'user' ||
    body.tools !== undefined
  )
    throw new Error('request_budget');
  return value;
}

// FLAG: SSH has one in-flight request. A failed/timed-out inference ends the session and recycles the owned model.
export async function workstationSession(
  ssh,
  key,
  { signal, onStatus = () => {}, infer = workstationJson } = {},
) {
  const controller = new AbortController();
  const sessionSignal = AbortSignal.any([
    controller.signal,
    ...(signal ? [signal] : []),
    AbortSignal.timeout(31 * 60_000),
  ]);
  let hello = false,
    busy = false,
    failed = false,
    inflight;
  const send = async (value) => {
    if (sessionSignal.aborted) throw new Error('session_stopped');
    if (!ssh.stdin.write(JSON.stringify(value) + '\n'))
      await once(ssh.stdin, 'drain', {
        signal: AbortSignal.any([sessionSignal, AbortSignal.timeout(1000)]),
      });
  };
  ssh.stdin.on('error', () => controller.abort());
  ssh.once('error', () => controller.abort());
  ssh.once('close', () => controller.abort());
  const abort = () => {
    ssh.stdin.destroy();
    ssh.stdout.destroy();
    ssh.kill('SIGTERM');
  };
  sessionSignal.addEventListener('abort', abort, { once: true });
  const heartbeat = (async () => {
    while (!sessionSignal.aborted) {
      if (hello) await send({ type: 'ready', ready: !busy });
      await pause(1500, undefined, { signal: sessionSignal });
    }
  })();
  void heartbeat.catch(() => controller.abort());
  const handshakeTimer = setTimeout(() => {
    if (!hello) controller.abort();
  }, 10_000);
  try {
    await send({ type: 'hello', identity });
    const decoder = new WorkstationFrames();
    for await (const chunk of ssh.stdout) {
      for (const frame of decoder.push(chunk)) {
        if (!hello) {
          if (
            frame.type !== 'hello' ||
            Object.keys(frame).length !== 2 ||
            JSON.stringify(frame.identity) !== JSON.stringify(identity)
          )
            throw new Error('bridge_identity');
          hello = true;
          clearTimeout(handshakeTimer);
          onStatus('connected');
          await send({ type: 'ready', ready: true });
          continue;
        }
        const request = validateWorkstationRequest(frame);
        if (busy) throw new Error('concurrent_request');
        busy = true;
        await send({ type: 'ready', ready: false });
        inflight = (async () => {
          const response = await infer('/v1/chat/completions', key, {
            body: request.body,
            signal: AbortSignal.any([sessionSignal, AbortSignal.timeout(request.timeoutMs)]),
          });
          const body = JSON.stringify(response);
          if (Buffer.byteLength(body) > 16384) throw new Error('model_output_limit');
          await send({ type: 'response', id: request.id, body });
          busy = false;
          await send({ type: 'ready', ready: true });
          onStatus('classified');
        })();
        void inflight.catch(() => {
          failed = true;
          controller.abort();
        });
      }
    }
    decoder.finish();
  } finally {
    clearTimeout(handshakeTimer);
    controller.abort();
    abort();
    await heartbeat.catch(() => undefined);
    await inflight?.catch(() => undefined);
    sessionSignal.removeEventListener('abort', abort);
    onStatus('disconnected');
  }
  if (failed || busy) throw new Error('model_recycle_required');
}
