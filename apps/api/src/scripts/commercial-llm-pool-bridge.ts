import { randomUUID } from 'node:crypto';
import { commercialLlmWorkerHelloMatches } from '../moderation/commercial/commercial-llm.protocol';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { CommercialLlmPoolMailbox } from '../moderation/commercial/commercial-llm-pool.mailbox';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import {
  COMMERCIAL_LLM_POOL_FRAME_BYTES,
  COMMERCIAL_LLM_POOL_FRAMES_PER_MINUTE,
  COMMERCIAL_LLM_POOL_HEARTBEAT_MS,
  COMMERCIAL_LLM_POOL_PROFILES,
  COMMERCIAL_LLM_POOL_RESPONSE_BYTES,
  type CommercialLlmPoolBridgeNodeId,
} from '../moderation/commercial/commercial-llm-pool.protocol';

// FLAG: This argument comes from the reviewed host command/SSH identity binding. Hello can
// attest that fixed node, never select a different node or claim the internal server adapter.
export async function commercialLlmPoolBridge(
  trustedNodeId: CommercialLlmPoolBridgeNodeId,
): Promise<void> {
  if (
    !['pc-a-4b', 'pc-b-9b', 'pc-a-cpu-9b'].includes(trustedNodeId) ||
    process.env.APP_SERVICE_NAME !== 'api-moderation-background' ||
    process.env.COMMERCIAL_LLM_POOL_WORKERS_ENABLED !== 'true' ||
    !process.env.REDIS_URL
  )
    throw new Error('pool_bridge_role_refused');
  const redis = createCommercialLlmRedis(process.env.REDIS_URL);
  const mailbox = new CommercialLlmPoolMailbox(redis);
  const session = randomUUID();
  const controller = new AbortController();
  const startedAt = Date.now();
  const sessionEnd = startedAt + 30 * 60_000;
  const identity = COMMERCIAL_LLM_POOL_PROFILES[trustedNodeId].identity;
  let hello = false;
  let ready = false;
  let lastReadyAt = 0;
  let sentId: string | null = null;
  let receivedInWindow = 0;
  let windowAt = startedAt;
  let receive: Promise<void> | null = null;
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  process.stdout.on('error', abort);
  const send = async (value: unknown) => {
    const frame = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(frame) > COMMERCIAL_LLM_POOL_FRAME_BYTES)
      throw new Error('pool_frame_refused');
    if (!process.stdout.write(frame))
      await once(process.stdout, 'drain', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
      });
  };
  try {
    await redis.connect();
    if (!(await mailbox.acquireWorker(trustedNodeId, session)))
      throw new Error('pool_already_connected');
    receive = (async () => {
      let pending = Buffer.alloc(0);
      for await (const chunk of process.stdin) {
        pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          if (newline + 1 > COMMERCIAL_LLM_POOL_FRAME_BYTES) throw new Error('pool_frame_refused');
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (Date.now() - windowAt >= 60_000) {
            windowAt = Date.now();
            receivedInWindow = 0;
          }
          if (++receivedInWindow > COMMERCIAL_LLM_POOL_FRAMES_PER_MINUTE)
            throw new Error('pool_rate_refused');
          const parsed: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(line),
          );
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('pool_frame_refused');
          const frame = parsed as Record<string, unknown>;
          if (!hello) {
            if (
              frame.type !== 'hello' ||
              Object.keys(frame).length !== 3 ||
              frame.nodeId !== trustedNodeId ||
              !commercialLlmWorkerHelloMatches(identity, frame.identity)
            )
              throw new Error('pool_identity_refused');
            hello = true;
            await send({ type: 'hello', nodeId: trustedNodeId, identity: frame.identity });
          } else if (
            frame.type === 'ready' &&
            Object.keys(frame).length === 2 &&
            typeof frame.ready === 'boolean'
          ) {
            ready = frame.ready;
            lastReadyAt = Date.now();
          } else if (
            frame.type === 'response' &&
            Object.keys(frame).length === 3 &&
            typeof frame.id === 'string' &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(frame.id) &&
            typeof frame.body === 'string' &&
            Buffer.byteLength(frame.body) <= COMMERCIAL_LLM_POOL_RESPONSE_BYTES
          ) {
            await mailbox.respond(trustedNodeId, session, frame.id, frame.body);
          } else throw new Error('pool_frame_refused');
        }
        if (pending.length >= COMMERCIAL_LLM_POOL_FRAME_BYTES)
          throw new Error('pool_frame_refused');
      }
      if (pending.length) throw new Error('pool_frame_refused');
    })();
    void receive.then(abort, abort);
    while (!controller.signal.aborted && Date.now() < sessionEnd) {
      if (!hello && Date.now() - startedAt > 10_000) throw new Error('pool_handshake_deadline');
      if (hello && Date.now() - (lastReadyAt || startedAt) > 10_000)
        throw new Error('pool_heartbeat_deadline');
      // FLAG: Busy peers renew liveness, never capacity. No heartbeat is advertised before hello.
      if (hello) {
        const healthy = ready && Date.now() - lastReadyAt < COMMERCIAL_LLM_POOL_HEARTBEAT_MS;
        const request = await mailbox.refreshWorker(trustedNodeId, session, healthy);
        if (request && request.id !== sentId) {
          sentId = request.id;
          await send({
            type: 'request',
            id: request.id,
            body: request.body,
            timeoutMs: request.remainingMs,
          });
        }
      }
      await pause(100, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  } finally {
    controller.abort();
    process.stdin.destroy();
    await receive?.catch(() => undefined);
    await mailbox.releaseWorker(trustedNodeId, session).catch(() => undefined);
    redis.disconnect();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    process.stdout.removeListener('error', abort);
  }
}

if (require.main === module) {
  const [nodeId, ...extra] = process.argv.slice(2);
  if (extra.length || (nodeId !== 'pc-a-4b' && nodeId !== 'pc-b-9b' && nodeId !== 'pc-a-cpu-9b')) {
    process.stderr.write('pool_bridge_node_required\n');
    process.exitCode = 1;
  } else {
    commercialLlmPoolBridge(nodeId).catch(() => {
      process.stderr.write('pool_bridge_unavailable\n');
      process.exitCode = 1;
    });
  }
}
