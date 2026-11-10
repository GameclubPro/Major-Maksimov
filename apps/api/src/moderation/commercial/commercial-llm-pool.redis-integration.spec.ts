import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import {
  COMMERCIAL_LLM_COOLDOWN_KEY,
  COMMERCIAL_LLM_LEASE_KEY,
  CommercialLlmShadowLease,
  createCommercialLlmRedis,
} from './commercial-llm-shadow.lease';
import { CommercialLlmPoolServer } from './commercial-llm-pool-server';
import {
  CommercialLlmPoolClient,
  CommercialLlmPoolRoutingStats,
} from './commercial-llm-pool.client';
import { buildCommercialLlmRequest } from './commercial-llm.protocol';
import {
  CommercialLlmPoolMailbox,
  type CommercialLlmPoolReservation,
} from './commercial-llm-pool.mailbox';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  POOL_NODE_IDS,
  POOL_PENDING_KEYS,
  POOL_DISPATCH_PENDING_KEY,
  POOL_ADMISSION_WORKER_KEY,
  commercialLlmPoolJobKey,
  commercialLlmPoolNodeKeys,
  type CommercialLlmPoolNodeId,
} from './commercial-llm-pool.protocol';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
(url ? describe : describe.skip)('commercial pool capacity and attempts on real Redis', () => {
  let redis: Redis;
  let mailbox: CommercialLlmPoolMailbox;
  let sessions: Record<CommercialLlmPoolNodeId, string>;
  const jobs = new Set<string>();
  const nodeKeys = POOL_NODE_IDS.flatMap((id) => Object.values(commercialLlmPoolNodeKeys(id)));
  const body = (nodeId: CommercialLlmPoolNodeId, text = 'Продам свой старый холодильник') =>
    JSON.stringify({
      ...buildCommercialLlmRequest(text),
      model: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity.modelAlias,
    });
  const response = (nodeId: CommercialLlmPoolNodeId) =>
    JSON.stringify({
      model: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity.modelAlias,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"classification":"NOT_COMMERCIAL","reasonCodes":["PERSONAL_SALE"]}',
          },
        },
      ],
    });
  const job = (
    nodeId: CommercialLlmPoolNodeId,
    lifetimeMs = nodeId === 'pc-a-cpu-9b' ? 20_000 : 3000,
  ) => {
    const jobId = randomUUID();
    jobs.add(commercialLlmPoolJobKey(jobId));
    return {
      jobId,
      attempt: 1 as const,
      deadlineAtMs: Date.now() + lifetimeMs,
      body: body(nodeId),
    };
  };
  const ready = async (nodeId: CommercialLlmPoolNodeId) => {
    expect(await mailbox.acquireWorker(nodeId, sessions[nodeId])).toBe(true);
    await mailbox.refreshWorker(nodeId, sessions[nodeId], true);
  };
  const reserved = async (nodeId: CommercialLlmPoolNodeId, request = job(nodeId)) => {
    const value = await mailbox.reserve(nodeId, request);
    expect(value).not.toBeNull();
    return value!;
  };
  const complete = async (value: CommercialLlmPoolReservation) => {
    expect(
      await mailbox.respond(value.nodeId, value.session, value.id, response(value.nodeId)),
    ).toBe(true);
    expect(await mailbox.wait(value)).toMatchObject({ outcome: 'COMPLETE' });
  };
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('disposable loopback Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
  });
  beforeEach(async () => {
    await redis.del(
      ...nodeKeys,
      ...POOL_PENDING_KEYS,
      POOL_DISPATCH_PENDING_KEY,
      POOL_ADMISSION_WORKER_KEY,
      ...jobs,
    );
    jobs.clear();
    mailbox = new CommercialLlmPoolMailbox(redis);
    sessions = {
      'server-9b': randomUUID(),
      'pc-a-4b': randomUUID(),
      'pc-b-9b': randomUUID(),
      'pc-a-cpu-9b': randomUUID(),
    };
  });
  afterAll(async () => {
    await redis.del(
      ...nodeKeys,
      ...POOL_PENDING_KEYS,
      POOL_DISPATCH_PENDING_KEY,
      POOL_ADMISSION_WORKER_KEY,
      ...jobs,
    );
    redis.disconnect();
  });

  it('executes four independent sources concurrently without the old global 9B lease', async () => {
    await Promise.all(POOL_NODE_IDS.map(ready));
    expect(await mailbox.available()).toEqual([...POOL_NODE_IDS]);
    const values = await Promise.all(POOL_NODE_IDS.map((nodeId) => reserved(nodeId)));
    expect(await mailbox.available()).toEqual([]);
    await Promise.all(values.map(complete));
    expect(await mailbox.available()).toEqual([...POOL_NODE_IDS]);
  });

  it('prefers free 9B then uses direct 4B while preserving all three occupied 9B owners', async () => {
    await Promise.all(POOL_NODE_IDS.map(ready));
    await mailbox.refreshWorker('server-9b', sessions['server-9b'], false);
    const routingStats = new CommercialLlmPoolRoutingStats();
    routingStats.recordSuccess('pc-a-4b', 1);
    routingStats.recordSuccess('pc-b-9b', 1000);
    const served: CommercialLlmPoolNodeId[] = [];
    const workerMailbox: Pick<
      CommercialLlmPoolMailbox,
      'available' | 'reserve' | 'wait' | 'release'
    > = {
      available: () => mailbox.available(),
      reserve: (...args) => mailbox.reserve(...args),
      wait: async (reservation, signal) => {
        served.push(reservation.nodeId);
        const reply = JSON.stringify({
          model: COMMERCIAL_LLM_POOL_PROFILES[reservation.nodeId].identity.modelAlias,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '{"classification":"COMMERCIAL","reasonCodes":["SERVICE_OFFER"]}',
              },
            },
          ],
        });
        expect(
          await mailbox.respond(reservation.nodeId, reservation.session, reservation.id, reply),
        ).toBe(true);
        return mailbox.wait(reservation, signal);
      },
      release: (reservation) => mailbox.release(reservation),
    };
    const dispatch = jest.fn<Promise<void>, [CommercialLlmPoolReservation, AbortSignal]>();
    const canStartConsultation = jest.fn<Promise<boolean>, []>();
    const classify = async () => {
      const request = job('pc-a-4b', 20_000);
      return new CommercialLlmPoolClient(workerMailbox, dispatch, {
        jobId: request.jobId,
        deadlineAtMs: request.deadlineAtMs,
        policy: 'direct-4b',
        routingStats,
        primaryFinished: async () => undefined,
        canStartConsultation,
      }).classify('Предлагаем услуги ремонта квартир');
    };
    expect(await classify()).toMatchObject({
      classification: 'COMMERCIAL',
      pool: { nodeId: 'pc-b-9b', route: 'direct', attempts: 1 },
    });

    await mailbox.refreshWorker('server-9b', sessions['server-9b'], true);
    const occupied = await Promise.all(
      (['server-9b', 'pc-b-9b', 'pc-a-cpu-9b'] as const).map((nodeId) =>
        reserved(nodeId, job(nodeId, 20_000)),
      ),
    );
    const foreignKeys = occupied.flatMap((reservation) => [
      ...Object.values(commercialLlmPoolNodeKeys(reservation.nodeId)),
      commercialLlmPoolJobKey(reservation.jobId),
    ]);
    const foreignState = await redis.mget(...foreignKeys);
    expect(await mailbox.available()).toEqual(['pc-a-4b']);
    expect(await classify()).toMatchObject({
      classification: 'COMMERCIAL',
      pool: { nodeId: 'pc-a-4b', route: 'direct', policy: 'direct-4b', attempts: 1 },
    });
    expect(served).toEqual(['pc-b-9b', 'pc-a-4b']);
    expect(canStartConsultation).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await redis.mget(...foreignKeys)).toEqual(foreignState);
    expect(await mailbox.available()).toEqual(['pc-a-4b']);
  });

  it('refuses CPU reservation after a delayed heartbeat read without consuming the direct4B attempt', async () => {
    await ready('pc-a-cpu-9b');
    await ready('pc-a-4b');
    const request = job('pc-a-cpu-9b', 20_000);
    const cpuKeys = commercialLlmPoolNodeKeys('pc-a-cpu-9b');
    expect(request.deadlineAtMs - Date.now()).toBeGreaterThanOrEqual(18_000);
    const hooked = new CommercialLlmPoolMailbox({
      get: redis.get.bind(redis),
      eval: redis.eval.bind(redis),
      mget: (async (...args: Parameters<Redis['mget']>) => {
        const observed = await redis.mget(...args);
        await pause(Math.max(1, request.deadlineAtMs - Date.now() - 18_000 + 25));
        return observed;
      }) as Redis['mget'],
    });
    expect(await hooked.reserve('pc-a-cpu-9b', request)).toBeNull();
    expect(request.deadlineAtMs - Date.now()).toBeLessThan(18_000);
    expect(await redis.mget(cpuKeys.slot, commercialLlmPoolJobKey(request.jobId))).toEqual([
      null,
      null,
    ]);
    const fallback = await mailbox.reserve('pc-a-4b', { ...request, body: body('pc-a-4b') });
    expect(fallback).toMatchObject({
      nodeId: 'pc-a-4b',
      attempt: 1,
      deadlineAtMs: request.deadlineAtMs,
    });
    await complete(fallback!);
  });

  it('one atomic winner reserves a node and losers consume no job attempt', async () => {
    await ready('pc-b-9b');
    const requests = Array.from({ length: 8 }, () => job('pc-b-9b'));
    const results = await Promise.all(
      requests.map((request) => mailbox.reserve('pc-b-9b', request)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    for (let i = 0; i < requests.length; i++) {
      expect(await redis.exists(commercialLlmPoolJobKey(requests[i].jobId))).toBe(
        results[i] ? 1 : 0,
      );
    }
    await complete(results.find(Boolean)!);
  });

  it('a shared job can reserve only one of two otherwise free nodes', async () => {
    await ready('server-9b');
    await ready('pc-b-9b');
    const request = job('server-9b');
    const values = await Promise.all([
      mailbox.reserve('server-9b', request),
      mailbox.reserve('pc-b-9b', request),
    ]);
    expect(values.filter(Boolean)).toHaveLength(1);
    await complete(values.find(Boolean)!);
  });

  it('consultation never waits behind primary FIFO work and expired pending keys stop blocking it', async () => {
    await ready('pc-b-9b');
    await redis.set(POOL_PENDING_KEYS[0], 'bounded-primary', 'PX', 100);
    const request = job('pc-b-9b');
    expect(await mailbox.reserve('pc-b-9b', request, { consultation: true })).toBeNull();
    expect(await redis.exists(commercialLlmPoolJobKey(request.jobId))).toBe(0);
    await pause(130);
    const value = await mailbox.reserve('pc-b-9b', request, { consultation: true });
    expect(value).not.toBeNull();
    await complete(value!);
  });

  it('the final atomic primary priority check closes a read/reserve race', async () => {
    await ready('pc-b-9b');
    const hooked = new CommercialLlmPoolMailbox({
      get: redis.get.bind(redis),
      mget: redis.mget.bind(redis),
      eval: (async (...args: Parameters<Redis['eval']>) => {
        await redis.set(POOL_PENDING_KEYS[1], 'primary-won', 'PX', 3000);
        return redis.eval(...args);
      }) as Redis['eval'],
    });
    expect(await hooked.reserve('pc-b-9b', job('pc-b-9b'), { consultation: true })).toBeNull();
  });

  it('a primary between FIFO take and model dispatch blocks consultation until its reservation wins', async () => {
    await ready('pc-a-4b');
    await ready('pc-b-9b');
    const primary = job('pc-a-4b');
    const consultation = job('pc-b-9b');
    await redis.set(POOL_ADMISSION_WORKER_KEY, 'current-worker', 'PX', 3000);
    await redis.hset(
      POOL_DISPATCH_PENDING_KEY,
      primary.jobId,
      JSON.stringify({
        worker: 'current-worker',
        source: { nonce: primary.jobId, deadlineAtMs: primary.deadlineAtMs },
      }),
    );
    expect(await mailbox.reserve('pc-b-9b', consultation, { consultation: true })).toBeNull();
    const value = await reserved('pc-a-4b', primary);
    expect(await redis.hlen(POOL_DISPATCH_PENDING_KEY)).toBe(0);
    const secondary = await mailbox.reserve('pc-b-9b', consultation, { consultation: true });
    expect(secondary).not.toBeNull();
    await Promise.all([complete(value), complete(secondary!)]);
  });

  it('a lost primary reservation never removes its pending-dispatch marker', async () => {
    await ready('pc-b-9b');
    const busy = await reserved('pc-b-9b');
    const pending = job('pc-b-9b');
    await redis.hset(POOL_DISPATCH_PENDING_KEY, pending.jobId, 'marker');
    expect(await mailbox.reserve('pc-b-9b', pending)).toBeNull();
    expect(await redis.hget(POOL_DISPATCH_PENDING_KEY, pending.jobId)).toBe('marker');
    await complete(busy);
  });

  it('expired, malformed and obsolete-owner dispatch markers cannot permanently block consultations', async () => {
    await ready('pc-b-9b');
    const request = job('pc-b-9b');
    await redis.set(POOL_ADMISSION_WORKER_KEY, 'current-worker', 'PX', 3000);
    await redis.hset(
      POOL_DISPATCH_PENDING_KEY,
      'expired',
      JSON.stringify({
        worker: 'current-worker',
        source: { nonce: 'expired', deadlineAtMs: Date.now() - 1 },
      }),
      'obsolete',
      JSON.stringify({
        worker: 'old-worker',
        source: { nonce: 'obsolete', deadlineAtMs: request.deadlineAtMs },
      }),
      'malformed',
      JSON.stringify({ worker: 'current-worker', source: 1 }),
    );
    const value = await mailbox.reserve('pc-b-9b', request, { consultation: true });
    expect(value).not.toBeNull();
    expect(await redis.hlen(POOL_DISPATCH_PENDING_KEY)).toBe(0);
    await complete(value!);
  });

  it('busy and stale nodes do not advertise capacity; a failed session does not block peers', async () => {
    await ready('pc-a-4b');
    await ready('pc-b-9b');
    await mailbox.refreshWorker('pc-a-4b', sessions['pc-a-4b'], false);
    expect(await mailbox.available()).toEqual(['pc-b-9b']);
    await redis.del(commercialLlmPoolNodeKeys('pc-b-9b').heartbeat);
    expect(await mailbox.available()).toEqual([]);
    expect(await mailbox.reserve('pc-a-4b', job('pc-a-4b'))).toBeNull();
    await mailbox.refreshWorker('pc-b-9b', sessions['pc-b-9b'], true);
    await complete(await reserved('pc-b-9b'));
  });

  it('session loss invalidates its in-flight result and admits one fenced retry on another model', async () => {
    await ready('pc-a-4b');
    await ready('pc-b-9b');
    const request = job('pc-a-4b');
    const first = await reserved('pc-a-4b', request);
    await mailbox.releaseWorker(first.nodeId, first.session);
    expect(await mailbox.wait(first)).toEqual({ outcome: 'UNAVAILABLE' });
    const second = await mailbox.reserve('pc-b-9b', {
      ...request,
      attempt: 2,
      body: body('pc-b-9b'),
    });
    expect(second).not.toBeNull();
    expect(
      await mailbox.respond(first.nodeId, first.session, first.id, response(first.nodeId)),
    ).toBe(false);
    await mailbox.release(first);
    await complete(second!);
    expect(
      await mailbox.reserve('pc-b-9b', { ...request, attempt: 2, body: body('pc-b-9b') }),
    ).toBeNull();
  });

  it('an abandoned computation stays physically occupied until its old answer arrives', async () => {
    await ready('pc-a-4b');
    await ready('pc-b-9b');
    const request = job('pc-a-4b');
    const first = await reserved('pc-a-4b', request);
    await mailbox.release(first);
    expect(await mailbox.available()).toEqual(['pc-b-9b']);
    const second = await mailbox.reserve('pc-b-9b', {
      ...request,
      attempt: 2,
      body: body('pc-b-9b'),
    });
    expect(second).not.toBeNull();
    await complete(second!);
    await mailbox.release(first);
    expect(await redis.exists(commercialLlmPoolNodeKeys('pc-a-4b').slot)).toBe(1);
    expect(
      await mailbox.respond(first.nodeId, first.session, first.id, response(first.nodeId)),
    ).toBe(false);
    expect(await redis.exists(commercialLlmPoolNodeKeys('pc-a-4b').slot)).toBe(0);
  });

  it('retries cannot replace content or renew the original computation deadline', async () => {
    await ready('pc-a-4b');
    await ready('pc-b-9b');
    const request = job('pc-a-4b');
    const first = await reserved('pc-a-4b', request);
    await mailbox.release(first);
    await mailbox.respond(first.nodeId, first.session, first.id, response(first.nodeId));
    expect(await mailbox.reserve('pc-a-4b', { ...request, attempt: 2 })).toBeNull();
    expect(
      await mailbox.reserve('pc-b-9b', {
        ...request,
        attempt: 2,
        body: body('pc-b-9b', 'Другой текст'),
      }),
    ).toBeNull();
    expect(
      await mailbox.reserve('pc-b-9b', {
        ...request,
        attempt: 2,
        deadlineAtMs: request.deadlineAtMs + 100,
        body: body('pc-b-9b'),
      }),
    ).toBeNull();
    await complete(
      (await mailbox.reserve('pc-b-9b', { ...request, attempt: 2, body: body('pc-b-9b') }))!,
    );
  });

  it('only one waiter accepts a response and the terminal job fence survives resource release', async () => {
    await ready('pc-b-9b');
    const value = await reserved('pc-b-9b');
    await mailbox.respond(value.nodeId, value.session, value.id, response(value.nodeId));
    const results = await Promise.all([mailbox.wait(value), mailbox.wait(value)]);
    expect(results.filter((r) => r.outcome === 'COMPLETE')).toHaveLength(1);
    const stored = JSON.parse((await redis.get(commercialLlmPoolJobKey(value.jobId)))!);
    expect(stored.state).toBe('complete');
    expect(await mailbox.reserve(value.nodeId, { ...value, attempt: 2 })).toBeNull();
  });

  it('an obsolete worker cannot clear a newly registered session or its request', async () => {
    await ready('pc-b-9b');
    const first = await reserved('pc-b-9b');
    await redis.pexpire(commercialLlmPoolNodeKeys('pc-b-9b').lease, 1);
    await pause(10);
    sessions['pc-b-9b'] = randomUUID();
    await ready('pc-b-9b');
    const second = await reserved('pc-b-9b');
    await mailbox.releaseWorker('pc-b-9b', first.session);
    await mailbox.release(first);
    expect(await redis.get(commercialLlmPoolNodeKeys('pc-b-9b').lease)).toBe(second.session);
    await complete(second);
  });

  it('does not label an unavailable response store as an invalid model answer', async () => {
    await ready('pc-b-9b');
    const reservation = await reserved('pc-b-9b');
    const read = jest
      .spyOn(redis, 'mget')
      .mockRejectedValueOnce(new Error('private transport detail'));
    try {
      expect(await mailbox.wait(reservation)).toEqual({ outcome: 'UNAVAILABLE' });
    } finally {
      read.mockRestore();
    }
  });

  it('retains only a finite validation reason for a completed but inconsistent model answer', async () => {
    await ready('pc-b-9b');
    const reservation = await reserved('pc-b-9b');
    const body = JSON.stringify({
      model: COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity.modelAlias,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"classification":"COMMERCIAL","reasonCodes":["ORDINARY_DISCUSSION"]}',
          },
        },
      ],
    });
    expect(
      await mailbox.respond(reservation.nodeId, reservation.session, reservation.id, body),
    ).toBe(true);
    expect(await mailbox.wait(reservation)).toEqual({
      outcome: 'FAILED',
      responseIssue: 'decision',
    });
    expect(await redis.exists(commercialLlmPoolNodeKeys('pc-b-9b').slot)).toBe(0);
  });

  it('rejects malformed answers and source-contract drift without classifying failure as negative', async () => {
    await ready('pc-b-9b');
    const request = job('pc-b-9b');
    const value = await reserved('pc-b-9b', request);
    expect(await mailbox.respond(value.nodeId, value.session, value.id, 'null')).toBe(true);
    expect(await mailbox.wait(value)).toEqual({ outcome: 'FAILED', responseIssue: 'envelope' });
    await expect(
      mailbox.reserve('pc-b-9b', {
        ...job('pc-b-9b'),
        body: JSON.stringify({ ...JSON.parse(request.body), tools: [] }),
      }),
    ).rejects.toThrow('pool_request_refused');
    expect(await redis.exists(commercialLlmPoolNodeKeys('pc-b-9b').slot)).toBe(0);
  });

  it('expiry rejects late answers and never extends job or source authority', async () => {
    await ready('pc-b-9b');
    const value = await reserved('pc-b-9b', job('pc-b-9b', 180));
    expect(await mailbox.wait(value)).toEqual({ outcome: 'TIMEOUT' });
    expect(
      await mailbox.respond(value.nodeId, value.session, value.id, response(value.nodeId)),
    ).toBe(false);
    expect(await mailbox.reserve(value.nodeId, { ...value, attempt: 2 })).toBeNull();
  });

  it('external cancellation abandons the attempt and rejects its eventual response', async () => {
    await ready('pc-b-9b');
    const value = await reserved('pc-b-9b');
    const controller = new AbortController();
    controller.abort();
    await expect(mailbox.wait(value, controller.signal)).rejects.toMatchObject({ kind: 'ABORTED' });
    expect(
      await mailbox.respond(value.nodeId, value.session, value.id, response(value.nodeId)),
    ).toBe(false);
    expect(await redis.exists(commercialLlmPoolNodeKeys(value.nodeId).slot)).toBe(0);
  });

  it('releases only an undispatched local-server reservation and retains its attempt fence', async () => {
    await ready('server-9b');
    await ready('pc-b-9b');
    const local = await reserved('server-9b');
    expect(await mailbox.releaseUndispatched(local)).toBe(true);
    expect(await mailbox.releaseUndispatched(local)).toBe(false);
    expect(JSON.parse((await redis.get(commercialLlmPoolJobKey(local.jobId)))!).state).toBe(
      'released',
    );
    expect(await mailbox.available()).toEqual(['server-9b', 'pc-b-9b']);
    const remote = await reserved('pc-b-9b');
    await expect(mailbox.releaseUndispatched(remote)).rejects.toThrow('pool_local_release_refused');
    expect(await redis.exists(commercialLlmPoolNodeKeys('pc-b-9b').slot)).toBe(1);
    const replied = await reserved('server-9b');
    await mailbox.respond(replied.nodeId, replied.session, replied.id, response(replied.nodeId));
    expect(await mailbox.releaseUndispatched(replied)).toBe(false);
    expect(await mailbox.wait(replied)).toMatchObject({ outcome: 'COMPLETE' });
  });
});

(url ? describe : describe.skip)('pool CPU quarantine with real HTTP and Redis', () => {
  let redis: Redis;
  let mailbox: CommercialLlmPoolMailbox;
  let server: CommercialLlmPoolServer;
  let http: Server;
  let endpoint: string;
  let now: number;
  let processing: boolean;
  let completionMode: 'disconnect' | 'complete' | 'invalid-decision' | 'deferred';
  let completeDeferred: (() => void) | undefined;
  let leaseTtlAtPost: number | undefined;
  let slotsMode: 'valid' | 'missing' | 'malformed' | 'timeout';
  let jobKey: string;
  const requests: { path: string; authorization: string | undefined }[] = [];
  const keys = commercialLlmPoolNodeKeys('server-9b');
  const peerKeys = commercialLlmPoolNodeKeys('pc-b-9b');

  const reserve = async () => {
    const reservation = await mailbox.reserve('server-9b', {
      jobId: jobKey.slice(jobKey.lastIndexOf(':') + 1),
      attempt: 1,
      deadlineAtMs: now + 20_000,
      body: JSON.stringify(buildCommercialLlmRequest('Обсуждаем погоду')),
    });
    expect(reservation).not.toBeNull();
    return reservation!;
  };

  const adapter = () => {
    const value = new CommercialLlmPoolServer(redis, mailbox, endpoint, async () => true);
    // FLAG: Isolate capacity observation; unit cases independently verify model capability/identity.
    jest
      .spyOn(value as unknown as { identityMatches(): Promise<boolean> }, 'identityMatches')
      .mockResolvedValue(true);
    return value;
  };

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('disposable loopback Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
  });
  beforeEach(async () => {
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    processing = false;
    completionMode = 'disconnect';
    completeDeferred = undefined;
    leaseTtlAtPost = undefined;
    slotsMode = 'valid';
    requests.length = 0;
    jobKey = commercialLlmPoolJobKey(randomUUID());
    await redis.del(
      ...Object.values(keys),
      ...Object.values(peerKeys),
      COMMERCIAL_LLM_LEASE_KEY,
      COMMERCIAL_LLM_COOLDOWN_KEY,
    );
    http = createServer((request, response) => {
      const path = new URL(request.url!, 'http://fixture').pathname;
      requests.push({ path, authorization: request.headers.authorization });
      response.setHeader('content-type', 'application/json');
      if (path === '/health') {
        // FLAG: b11804 ignores fail_on_no_slot on /health, including while computing.
        response.end('{"status":"ok"}');
      } else if (path === '/slots') {
        if (slotsMode === 'missing') {
          response.statusCode = 501;
          response.end('{"error":"slots disabled"}');
        } else if (slotsMode === 'malformed') {
          response.end('[{"id":0,"n_ctx":4096}]');
        } else if (slotsMode === 'timeout') {
          response.write('[');
        } else {
          response.end(JSON.stringify([{ id: 0, n_ctx: 4096, is_processing: processing }]));
        }
      } else if (path === '/v1/chat/completions' && request.method === 'POST') {
        processing = true;
        request.resume();
        request.on('end', () => {
          void redis.pttl(COMMERCIAL_LLM_LEASE_KEY).then(
            (ttl) => {
              leaseTtlAtPost = ttl;
              if (completionMode === 'disconnect') response.destroy();
              else {
                const complete = () => {
                  if (response.writableEnded || response.destroyed) return;
                  processing = false;
                  response.end(
                    JSON.stringify({
                      model: COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity.modelAlias,
                      choices: [
                        {
                          finish_reason: 'stop',
                          message: {
                            role: 'assistant',
                            content:
                              completionMode === 'invalid-decision'
                                ? '{"classification":"COMMERCIAL","reasonCodes":["ORDINARY_DISCUSSION"]}'
                                : '{"classification":"NOT_COMMERCIAL","reasonCodes":["ORDINARY_DISCUSSION"]}',
                          },
                        },
                      ],
                    }),
                  );
                };
                if (completionMode === 'deferred') completeDeferred = complete;
                else complete();
              }
            },
            () => response.destroy(),
          );
        });
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture address missing');
    endpoint = `http://127.0.0.1:${address.port}`;
    mailbox = new CommercialLlmPoolMailbox(redis);
    server = adapter();
    await server.tick();
  });
  afterEach(async () => {
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    await redis.del(
      ...Object.values(keys),
      ...Object.values(peerKeys),
      COMMERCIAL_LLM_LEASE_KEY,
      COMMERCIAL_LLM_COOLDOWN_KEY,
      jobKey,
    );
    jest.restoreAllMocks();
  });
  afterAll(() => redis.disconnect());

  it('rejects a nearly expired CPU handoff without HTTP or a persistent lease', async () => {
    const reservation = await reserve();
    now = reservation.deadlineAtMs - 25;
    await expect(server.dispatch(reservation)).rejects.toMatchObject({ kind: 'BUSY' });
    expect(requests.some(({ path }) => path === '/v1/chat/completions')).toBe(false);
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBeNull();
    expect(await redis.exists(keys.slot)).toBe(0);
    now += 1_001;
    await server.tick();
    expect(await mailbox.available()).toContain('server-9b');
  });

  it('retains uncertain capacity across idle observations and adapter restart while GPUs remain usable', async () => {
    await expect(server.dispatch(await reserve())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    const token = await redis.get(COMMERCIAL_LLM_LEASE_KEY);
    expect(token).not.toBeNull();
    expect(leaseTtlAtPost).toBe(-1);
    expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
    const health = await fetch(`${endpoint}/health?fail_on_no_slot=1`);
    expect(health.ok).toBe(true);
    await health.body?.cancel();
    now += 1_001;
    await server.tick();
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
    expect(await new CommercialLlmShadowLease(redis).acquire()).toBeNull();
    expect(await mailbox.available()).not.toContain('server-9b');

    for (const mode of ['missing', 'malformed', 'timeout'] as const) {
      slotsMode = mode;
      now += 1_001;
      await server.tick();
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
      expect(JSON.parse((await redis.get(keys.heartbeat))!).ready).toBe(false);
    }
    slotsMode = 'valid';
    processing = false;
    now += 1_001;
    await server.tick();
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
    expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
    expect(JSON.parse((await redis.get(keys.heartbeat))!).ready).toBe(false);
    expect(await redis.exists(COMMERCIAL_LLM_COOLDOWN_KEY)).toBe(1);
    await server.close();
    server = adapter();
    await server.tick();
    expect(JSON.parse((await redis.get(keys.heartbeat))!).ready).toBe(false);
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
    expect(await new CommercialLlmShadowLease(redis).acquire()).toBeNull();
    const peerSession = randomUUID();
    expect(await mailbox.acquireWorker('pc-b-9b', peerSession)).toBe(true);
    await mailbox.refreshWorker('pc-b-9b', peerSession, true);
    expect(await mailbox.available()).toEqual(['pc-b-9b']);
    expect(requests.filter(({ path }) => path === '/health')).toHaveLength(1);
    expect(requests.some(({ path }) => path === '/slots')).toBe(true);
    expect(requests.every(({ authorization }) => authorization === undefined)).toBe(true);
  });

  it('pins before HTTP and releases the exact lease after a complete response', async () => {
    completionMode = 'complete';
    const reservation = await reserve();
    await server.dispatch(reservation);
    expect(leaseTtlAtPost).toBe(-1);
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBeNull();
    expect(await redis.exists(COMMERCIAL_LLM_COOLDOWN_KEY)).toBe(1);
    expect(await mailbox.wait(reservation)).toMatchObject({ outcome: 'COMPLETE' });
  });

  it('expires the original client at twenty seconds while draining CPU HTTP without publishing its late result', async () => {
    jest.spyOn(Date, 'now').mockRestore();
    now = Date.now();
    completionMode = 'deferred';
    let settled = false;
    let dispatchWork: Promise<void> | undefined;
    const respond = jest.spyOn(mailbox, 'respond');
    const heartbeatErrors: unknown[] = [];
    const heartbeat = setInterval(() => {
      void server.tick().catch((error) => heartbeatErrors.push(error));
    }, 500);
    const client = new CommercialLlmPoolClient(
      mailbox,
      (reservation, signal) => {
        dispatchWork = server.dispatch(reservation, signal);
        void dispatchWork.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        return dispatchWork;
      },
      {
        jobId: jobKey.slice(jobKey.lastIndexOf(':') + 1),
        deadlineAtMs: Date.now() + 20_000,
        policy: 'direct-4b',
        primaryFinished: async () => undefined,
        canStartConsultation: async () => false,
      },
    );
    const originalJobKey = jobKey;
    try {
      const startedAt = Date.now();
      await expect(client.classify('Обсуждаем погоду')).rejects.toMatchObject({ kind: 'TIMEOUT' });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(19_900);
      await pause(25);
      expect(completeDeferred).toBeDefined();
      expect(settled).toBe(false);
      expect(leaseTtlAtPost).toBe(-1);
      expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
      expect(await new CommercialLlmShadowLease(redis).acquire()).toBeNull();
      expect(await mailbox.available()).not.toContain('server-9b');
      expect(respond).not.toHaveBeenCalled();
      const peerSession = randomUUID();
      expect(await mailbox.acquireWorker('pc-b-9b', peerSession)).toBe(true);
      await mailbox.refreshWorker('pc-b-9b', peerSession, true);
      expect(await mailbox.available()).toContain('pc-b-9b');

      completeDeferred!();
      await dispatchWork;
      expect(settled).toBe(true);
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBeNull();
      expect(await redis.get(keys.response)).toBeNull();
      expect(respond).not.toHaveBeenCalled();
      expect(await redis.get(originalJobKey)).toBeNull();
      await pause(1_010);
      await server.tick();
      expect(await mailbox.available()).toContain('server-9b');
      completionMode = 'complete';
      now = Date.now();
      jobKey = commercialLlmPoolJobKey(randomUUID());
      const next = await reserve();
      await server.dispatch(next);
      expect(await mailbox.wait(next)).toMatchObject({ outcome: 'COMPLETE' });
      expect(heartbeatErrors).toEqual([]);
    } finally {
      clearInterval(heartbeat);
      completeDeferred?.();
      await dispatchWork?.catch(() => undefined);
      await redis.del(originalJobKey);
    }
  }, 30_000);

  it('rejects an invalid decision, releases only completed physical work and accepts the next request', async () => {
    completionMode = 'invalid-decision';
    const rejected = await reserve();
    await expect(server.dispatch(rejected)).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
      responseIssue: 'decision',
    });
    expect(leaseTtlAtPost).toBe(-1);
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBeNull();
    expect(await redis.get(keys.response)).not.toBeNull();
    expect(JSON.parse((await redis.get(jobKey))!).state).toBe('pending');
    expect(await redis.exists(COMMERCIAL_LLM_COOLDOWN_KEY)).toBe(1);
    await mailbox.release(rejected);
    expect(JSON.parse((await redis.get(jobKey))!).state).toBe('released');
    expect(await redis.get(keys.response)).toBeNull();
    // The fixture advances admission only; the failed source never receives a result or replay.
    await redis.del(COMMERCIAL_LLM_COOLDOWN_KEY);
    // Keep the next source deadline aligned with Redis TIME, not an advanced JS-only clock.
    await new Promise((resolve) => setTimeout(resolve, 1_010));
    now = new Date().getTime();
    await server.tick();
    expect(await mailbox.available()).toContain('server-9b');
    completionMode = 'complete';
    const previousJobKey = jobKey;
    jobKey = commercialLlmPoolJobKey(randomUUID());
    try {
      const next = await reserve();
      await server.dispatch(next);
      expect(await mailbox.wait(next)).toMatchObject({ outcome: 'COMPLETE' });
    } finally {
      await redis.del(previousJobKey);
    }
  });

  it('retains uncertain physical capacity when the separate shutdown signal aborts accepted HTTP', async () => {
    completionMode = 'deferred';
    const shutdown = new AbortController();
    const respond = jest.spyOn(mailbox, 'respond');
    const work = server.dispatch(await reserve(), undefined, shutdown.signal);
    const rejected = expect(work).rejects.toMatchObject({ kind: 'ABORTED' });
    for (let attempt = 0; attempt < 100 && !completeDeferred; attempt += 1) await pause(10);
    expect(completeDeferred).toBeDefined();
    const token = await redis.get(COMMERCIAL_LLM_LEASE_KEY);
    shutdown.abort();
    await rejected;
    await server.close();
    expect(respond).not.toHaveBeenCalled();
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
    expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
    server = adapter();
    await server.tick();
    expect(await mailbox.available()).not.toContain('server-9b');
    expect(await new CommercialLlmShadowLease(redis).acquire()).toBeNull();
  });

  it('does not release a replacement physical owner after an obsolete source finishes draining', async () => {
    completionMode = 'deferred';
    const source = new AbortController();
    const respond = jest.spyOn(mailbox, 'respond');
    const work = server.dispatch(await reserve(), source.signal);
    for (let attempt = 0; attempt < 100 && !completeDeferred; attempt += 1) await pause(10);
    expect(completeDeferred).toBeDefined();
    source.abort();
    const replacement = randomUUID();
    await redis.set(COMMERCIAL_LLM_LEASE_KEY, replacement);
    completeDeferred!();
    await work;
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(replacement);
    expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
    expect(respond).not.toHaveBeenCalled();
  });

  it('cannot retain or release a replacement owner and never posts after losing ownership', async () => {
    const replacement = randomUUID();
    const retain = CommercialLlmShadowLease.prototype.retainUntilReleased;
    jest
      .spyOn(CommercialLlmShadowLease.prototype, 'retainUntilReleased')
      .mockImplementation(async function (this: CommercialLlmShadowLease, token) {
        await redis.set(COMMERCIAL_LLM_LEASE_KEY, replacement, 'PX', 30_000);
        return retain.call(this, token);
      });
    await expect(server.dispatch(await reserve())).rejects.toMatchObject({ kind: 'BUSY' });
    expect(requests.some(({ path }) => path === '/v1/chat/completions')).toBe(false);
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(replacement);
    expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBeGreaterThan(0);
  });

  it('releases pinned capacity after an abort before HTTP handoff', async () => {
    const controller = new AbortController();
    const retain = CommercialLlmShadowLease.prototype.retainUntilReleased;
    jest
      .spyOn(CommercialLlmShadowLease.prototype, 'retainUntilReleased')
      .mockImplementation(async function (this: CommercialLlmShadowLease, token) {
        const held = await retain.call(this, token);
        expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
        controller.abort();
        return held;
      });
    await expect(server.dispatch(await reserve(), controller.signal)).rejects.toMatchObject({
      kind: 'BUSY',
    });
    expect(requests.some(({ path }) => path === '/v1/chat/completions')).toBe(false);
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBeNull();
  });

  it('does not post after a lost retention acknowledgement and releases only its pinned lease', async () => {
    const retain = CommercialLlmShadowLease.prototype.retainUntilReleased;
    let pinnedToken: string | undefined;
    jest
      .spyOn(CommercialLlmShadowLease.prototype, 'retainUntilReleased')
      .mockImplementation(async function (this: CommercialLlmShadowLease, token) {
        expect(await retain.call(this, token)).toBe(true);
        pinnedToken = token;
        expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
        throw new Error('synthetic lost retention acknowledgement');
      });
    const release = jest.spyOn(CommercialLlmShadowLease.prototype, 'release');
    await expect(server.dispatch(await reserve())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(pinnedToken).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(pinnedToken);
    expect(requests.some(({ path }) => path === '/v1/chat/completions')).toBe(false);
    expect(leaseTtlAtPost).toBeUndefined();
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBeNull();
    expect(await redis.exists(keys.slot)).toBe(0);
    expect(await redis.exists(COMMERCIAL_LLM_COOLDOWN_KEY)).toBe(1);
  });

  it('retains a persistent fence after lost retention acknowledgement and failed release', async () => {
    const retain = CommercialLlmShadowLease.prototype.retainUntilReleased;
    let pinnedToken: string | undefined;
    jest
      .spyOn(CommercialLlmShadowLease.prototype, 'retainUntilReleased')
      .mockImplementation(async function (this: CommercialLlmShadowLease, token) {
        expect(await retain.call(this, token)).toBe(true);
        pinnedToken = token;
        expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
        throw new Error('synthetic lost retention acknowledgement');
      });
    const release = jest
      .spyOn(CommercialLlmShadowLease.prototype, 'release')
      .mockRejectedValue(new Error('synthetic release unavailable'));
    await expect(server.dispatch(await reserve())).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(pinnedToken).toBeDefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(pinnedToken);
    expect(requests.some(({ path }) => path === '/v1/chat/completions')).toBe(false);
    expect(leaseTtlAtPost).toBeUndefined();
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(pinnedToken);
    expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
    expect(await redis.exists(keys.slot)).toBe(0);
    await server.close();
    server = adapter();
    await server.tick();
    expect(JSON.parse((await redis.get(keys.heartbeat))!).ready).toBe(false);
    expect(await new CommercialLlmShadowLease(redis).acquire()).toBeNull();
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(pinnedToken);
    expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
  });

  it('does not recreate an absent lease when retaining an obsolete token', async () => {
    expect(await new CommercialLlmShadowLease(redis).retainUntilReleased(randomUUID())).toBe(false);
    expect(await redis.exists(COMMERCIAL_LLM_LEASE_KEY)).toBe(0);
  });
});
