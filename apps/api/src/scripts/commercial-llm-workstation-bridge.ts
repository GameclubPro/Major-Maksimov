import { randomUUID } from 'node:crypto';
import { commercialLlmWorkerHelloMatches } from '../moderation/commercial/commercial-llm.protocol';
import { setTimeout as pause } from 'node:timers/promises';
import { once } from 'node:events';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import { CommercialLlmWorkstationMailbox } from '../moderation/commercial/commercial-llm-workstation.mailbox';
import { CommercialLlmPoolMailbox } from '../moderation/commercial/commercial-llm-pool.mailbox';
import { COMMERCIAL_LLM_POOL_FRAMES_PER_MINUTE } from '../moderation/commercial/commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS,
  COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES,
  COMMERCIAL_LLM_WORKSTATION_HEARTBEAT_MS,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
} from '../moderation/commercial/commercial-llm-workstation.protocol';

// FLAG: Thirty starts emit 90 control frames, plus 40 periodic readiness frames and hello.
// The finite 160-frame budget includes 29 frames of delivery headroom; model admission is separate.
const WORKSTATION_INBOUND_FRAMES_PER_MINUTE = 160;

// FLAG: SSH stdio carries sanitized, expiring observations only; no DB or MAX client is loaded.
export async function commercialLlmWorkstationBridge(): Promise<void> {
  const poolMode = process.env.COMMERCIAL_LLM_POOL_ENABLED === 'true';
  if (
    process.env.APP_SERVICE_NAME !== 'api-moderation-background' ||
    (poolMode
      ? process.env.COMMERCIAL_LLM_POOL_WORKERS_ENABLED !== 'true'
      : process.env.COMMERCIAL_LLM_SHADOW_ENABLED !== 'true') ||
    !process.env.REDIS_URL
  )
    throw new Error('workstation_role_refused');
  const redis = createCommercialLlmRedis(process.env.REDIS_URL);
  // FLAG: The existing first-PC key/command keeps its v1 wire identity. Only its server-side
  // mailbox changes, and the authenticated command can claim only the immutable pc-a-4b slot.
  // Exactly one namespace is used; a v2 first-PC worker competes for this same physical lease.
  const mailbox = poolMode
    ? (() => {
        const pool = new CommercialLlmPoolMailbox(redis);
        return {
          acquireWorker: (session: string) => pool.acquireWorker('pc-a-4b', session),
          refreshWorker: (session: string, ready: boolean) =>
            pool.refreshWorker('pc-a-4b', session, ready),
          respond: (session: string, id: string, body: string) =>
            pool.respond('pc-a-4b', session, id, body),
          releaseWorker: (session: string) => pool.releaseWorker('pc-a-4b', session),
        };
      })()
    : new CommercialLlmWorkstationMailbox(redis);
  const frameBudget = poolMode
    ? COMMERCIAL_LLM_POOL_FRAMES_PER_MINUTE
    : WORKSTATION_INBOUND_FRAMES_PER_MINUTE;
  const owner = randomUUID(),
    controller = new AbortController();
  let hello = false,
    ready = false,
    lastReadyAt = 0,
    sentId: string | null = null;
  let receivedInWindow = 0,
    windowAt = Date.now();
  const sessionEnd = Date.now() + 30 * 60_000;
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  process.stdout.on('error', abort);
  const send = async (value: unknown) => {
    const frame = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(frame) > COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES)
      throw new Error('workstation_frame_refused');
    if (!process.stdout.write(frame))
      await once(process.stdout, 'drain', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
      });
  };
  let receive: Promise<void> | null = null;
  try {
    await redis.connect();
    if (!(await mailbox.acquireWorker(owner))) throw new Error('workstation_already_connected');
    receive = (async () => {
      let pending = Buffer.alloc(0);
      for await (const chunk of process.stdin) {
        pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (!poolMode && pending.length > COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES)
          throw new Error('workstation_frame_refused');
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          if (poolMode && newline + 1 > COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES)
            throw new Error('workstation_frame_refused');
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (Date.now() - windowAt >= 60_000) {
            windowAt = Date.now();
            receivedInWindow = 0;
          }
          if (++receivedInWindow > frameBudget) throw new Error('workstation_rate_refused');
          const message: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(line),
          );
          if (!message || typeof message !== 'object' || Array.isArray(message))
            throw new Error('workstation_frame_refused');
          const value = message as Record<string, unknown>;
          if (!hello) {
            if (
              value.type !== 'hello' ||
              Object.keys(value).length !== 2 ||
              !commercialLlmWorkerHelloMatches(COMMERCIAL_LLM_WORKSTATION_IDENTITY, value.identity)
            )
              throw new Error('workstation_identity_refused');
            hello = true;
            await send({ type: 'hello', identity: value.identity });
          } else if (
            value.type === 'ready' &&
            typeof value.ready === 'boolean' &&
            Object.keys(value).length === 2
          ) {
            ready = value.ready;
            lastReadyAt = Date.now();
          } else if (
            value.type === 'response' &&
            typeof value.id === 'string' &&
            /^[a-f0-9-]{36}$/u.test(value.id) &&
            typeof value.body === 'string' &&
            Object.keys(value).length === 3
          ) {
            await mailbox.respond(owner, value.id, value.body);
          } else if (
            value.type === 'failed' &&
            typeof value.id === 'string' &&
            /^[a-f0-9-]{36}$/u.test(value.id) &&
            Object.keys(value).length === 2
          ) {
            // FLAG: A v1 failed frame is transport failure, never a fabricated model completion.
            // End the pool session so its exact in-flight attempt can fail over immediately.
            if (poolMode) throw new Error('workstation_computation_failed');
            if (value.id === sentId) {
              ready = false;
              lastReadyAt = Date.now();
            }
            await mailbox.respond(owner, value.id, 'null');
          } else throw new Error('workstation_frame_refused');
        }
        if (poolMode && pending.length >= COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES)
          throw new Error('workstation_frame_refused');
      }
      if (pending.length) throw new Error('workstation_frame_refused');
    })();
    // FLAG: Consume receiver failure immediately; the session and its private lease end together.
    void receive.then(abort, abort);
    const handshakeDeadline = Date.now() + 10_000;
    while (!controller.signal.aborted && Date.now() < sessionEnd) {
      if (!hello && Date.now() > handshakeDeadline)
        throw new Error('workstation_handshake_deadline');
      if (hello && Date.now() - (lastReadyAt || handshakeDeadline - 10_000) > 10_000)
        throw new Error('workstation_heartbeat_deadline');
      const healthy =
        hello && ready && Date.now() - lastReadyAt < COMMERCIAL_LLM_WORKSTATION_HEARTBEAT_MS;
      // FLAG: A silent/stale v1 handshake cannot renew a pool lease or advertise its identity.
      const request = !poolMode || hello ? await mailbox.refreshWorker(owner, healthy) : null;
      if (request && request.id !== sentId) {
        sentId = request.id;
        await send({
          type: 'request',
          id: request.id,
          body: request.body,
          timeoutMs: poolMode
            ? Math.min(COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS, request.remainingMs)
            : request.remainingMs,
        });
      }
      await pause(poolMode ? 100 : 250, undefined, { signal: controller.signal }).catch(
        () => undefined,
      );
    }
  } finally {
    controller.abort();
    process.stdin.destroy();
    await receive?.catch(() => undefined);
    await mailbox.releaseWorker(owner).catch(() => undefined);
    redis.disconnect();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    process.stdout.removeListener('error', abort);
  }
}

if (require.main === module) {
  commercialLlmWorkstationBridge().catch(() => {
    process.stderr.write('workstation_bridge_unavailable\n');
    process.exitCode = 1;
  });
}
