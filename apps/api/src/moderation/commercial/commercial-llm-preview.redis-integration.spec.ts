import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import {
  CommercialLlmPreviewMailbox,
  COMMERCIAL_LLM_PREVIEW_KEYS as keys,
} from './commercial-llm-preview.mailbox';
import { processCommercialLlmPreview } from './commercial-llm-preview.processor';
import { COMMERCIAL_LLM_ENFORCEMENT_KEYS as legacy } from './commercial-llm-enforcement.mailbox';
import { COMMERCIAL_LLM_POOL_ADMISSION_KEYS as pool } from './commercial-llm-pool-admission.mailbox';
import {
  createCommercialLlmRedis,
  CommercialLlmShadowLease,
  COMMERCIAL_LLM_LEASE_KEY,
  COMMERCIAL_LLM_COOLDOWN_KEY,
} from './commercial-llm-shadow.lease';
import { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';
import { CommercialLlmClient, type CommercialLlmHttpClassifier } from './commercial-llm.client';
import { COMMERCIAL_LLM_POOL_PROFILES } from './commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const text = 'Соседи, кто знает расписание автобуса?';
const result: CommercialLlmObservationResult = {
  ...COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity,
  classification: 'NOT_COMMERCIAL',
  reasonCodes: ['ORDINARY_DISCUSSION'],
  policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
  durationMs: 1,
};
const busyKeys = [legacy, pool].flatMap((entry) => [
  entry.slot,
  entry.slotNext,
  entry.active,
  entry.primary,
  entry.secondary,
]);

// FLAG: Disposable Redis only. No real model, source, sanction or MAX client is admitted.
(url ? describe : describe.skip)('preview handoff across admin and the sole CPU dispatcher', () => {
  let redis: Redis;
  let mailbox: CommercialLlmPreviewMailbox;
  let worker: string;
  const secondary = {
    classifyAudit: jest.fn<
      ReturnType<CommercialLlmSecondaryScheduler['classifyAudit']>,
      Parameters<CommercialLlmSecondaryScheduler['classifyAudit']>
    >(),
  };
  const cleanup = [
    ...Object.values(keys).filter((key) => !key.endsWith(':')),
    ...busyKeys,
    legacy.worker,
    pool.worker,
    COMMERCIAL_LLM_LEASE_KEY,
    COMMERCIAL_LLM_COOLDOWN_KEY,
  ];
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Disposable Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
    mailbox = new CommercialLlmPreviewMailbox(redis);
  });
  beforeEach(async () => {
    await redis.del(...cleanup);
    worker = randomUUID();
    await redis.set(pool.worker, worker, 'PX', 30_000);
    await mailbox.advertise(worker);
    secondary.classifyAudit.mockReset().mockResolvedValue(result);
  });
  afterEach(async () => {
    await redis.del(...cleanup);
  });
  afterAll(() => redis?.disconnect());
  const submit = () => {
    const response = mailbox.classify(text);
    // Install a rejection observer immediately, including when testing races.
    const settled = response.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return { response, settled };
  };
  const take = async () => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const task = await mailbox.take(worker);
      if (task) return task;
      await pause(5);
    }
    throw new Error('Preview request missing');
  };

  it('admits one request and returns only its pinned result after ready expiry', async () => {
    const first = submit();
    const task = await take();
    await expect(mailbox.classify(text)).rejects.toMatchObject({ kind: 'BUSY' });
    await redis.del(keys.ready);
    await processCommercialLlmPreview(
      mailbox,
      task,
      secondary,
      async () => true,
      new AbortController().signal,
    );
    await expect(first.response).resolves.toEqual(result);
    expect(await redis.exists(keys.request, keys.claim, keys.result + task.request.id)).toBe(0);
    expect(await redis.exists(...busyKeys)).toBe(0);
  });

  it.each([...busyKeys, COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY])(
    'yields admission to %s',
    async (key) => {
      await redis.set(key, 'occupied', 'PX', 1000);
      await expect(mailbox.classify(text)).rejects.toMatchObject({ kind: 'BUSY' });
      expect(await redis.exists(keys.request, keys.claim)).toBe(0);
    },
  );

  it.each([legacy.slot, pool.active])(
    'rechecks moderation priority before claim and dispatch: %s',
    async (key) => {
      const first = submit();
      // Wait for submit without claiming it.
      while (!(await redis.exists(keys.request))) await pause(5);
      await redis.set(key, 'occupied', 'PX', 1000);
      expect(await mailbox.take(worker)).toBeNull();
      await redis.del(key);
      const task = await take();
      await redis.set(key, 'occupied', 'PX', 1000);
      await processCommercialLlmPreview(
        mailbox,
        task,
        secondary,
        async () => true,
        new AbortController().signal,
      );
      expect(secondary.classifyAudit).not.toHaveBeenCalled();
      expect(await first.settled).toHaveProperty('error');
    },
  );

  it('fences a replaced worker and never accepts its readiness or claim', async () => {
    const first = submit();
    const task = await take();
    await redis.set(pool.worker, randomUUID(), 'PX', 30_000);
    await mailbox.withdraw(worker);
    await mailbox.advertise(worker);
    expect(await redis.get(keys.ready)).toBeNull();
    expect(await mailbox.current(task.raw, task.request)).toBe(false);
    expect(await mailbox.take(worker)).toBeNull();
    await mailbox.finish(task.raw, task.request, null);
    expect(await first.settled).toHaveProperty('error');
  });

  it('cleans its completed claim after cancellation without clearing the physical lease', async () => {
    const first = submit();
    const task = await take();
    await redis.del(keys.request, keys.ready);
    await redis.set(COMMERCIAL_LLM_LEASE_KEY, 'uncertain');
    await mailbox.finish(task.raw, task.request, result);
    expect(await redis.exists(keys.claim, keys.result + task.request.id)).toBe(0);
    expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe('uncertain');
    expect(await first.settled).toHaveProperty('error');
  });

  it('cannot publish an old response or remove a newer request/claim', async () => {
    const first = submit();
    const task = await take();
    const next = { ...task.request, id: randomUUID() };
    const raw = JSON.stringify(next);
    await redis.set(keys.request, raw, 'PX', 1000);
    await redis.set(keys.claim, next.id, 'PX', 1000);
    await mailbox.finish(task.raw, task.request, result);
    expect(await redis.get(keys.request)).toBe(raw);
    expect(await redis.get(keys.claim)).toBe(next.id);
    expect(await redis.exists(keys.result + task.request.id)).toBe(0);
    await redis.del(keys.ready);
    expect(await first.settled).toHaveProperty('error');
  });

  it('rejects malformed requests and a shutdown before model dispatch', async () => {
    await redis.set(keys.request, '{broken', 'PX', 1000);
    expect(await mailbox.take(worker)).toBeNull();
    await redis.del(keys.request);
    const first = submit();
    const task = await take();
    const shutdown = new AbortController();
    shutdown.abort();
    await processCommercialLlmPreview(mailbox, task, secondary, async () => true, shutdown.signal);
    expect(secondary.classifyAudit).not.toHaveBeenCalled();
    expect(await first.settled).toHaveProperty('error');
  });

  it('refuses a nearly expired CPU request before leasing or HTTP dispatch', async () => {
    const client = new CommercialLlmClient({ endpoint: 'http://127.0.0.1:1' });
    const dispatch = jest.spyOn(client, 'classifyWithLifecycle');
    const scheduler = new CommercialLlmSecondaryScheduler(
      new CommercialLlmShadowLease(redis),
      client,
    );
    await expect(
      scheduler.classifyAudit(text, undefined, undefined, Date.now() + 5999),
    ).rejects.toMatchObject({ kind: 'ABORTED' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await redis.exists(COMMERCIAL_LLM_LEASE_KEY)).toBe(0);
  });

  it.each(['governor', 'after-before-dispatch'] as const)(
    'rechecks the original budget after %s without HTTP or quarantine',
    async (stage) => {
      const first = submit();
      const task = await take();
      const actualNow = Date.now.bind(Date);
      let offset = 0;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => actualNow() + offset);
      const fetch = jest.spyOn(globalThis, 'fetch');
      const client = new CommercialLlmClient({ endpoint: 'http://127.0.0.1:1' });
      const delayed: CommercialLlmHttpClassifier = {
        classifyWithLifecycle: (excerpt, signal, lifecycle) =>
          client.classifyWithLifecycle(excerpt, signal, {
            ...lifecycle,
            beforeDispatch: async () => {
              await lifecycle.beforeDispatch();
              if (stage === 'after-before-dispatch')
                offset = task.request.deadlineAtMs - actualNow() - 5999;
            },
          }),
      };
      const scheduler = new CommercialLlmSecondaryScheduler(
        new CommercialLlmShadowLease(redis),
        delayed,
      );
      try {
        await processCommercialLlmPreview(
          mailbox,
          task,
          scheduler,
          async () => {
            if (stage === 'governor' && (await redis.exists(COMMERCIAL_LLM_LEASE_KEY)))
              offset = task.request.deadlineAtMs - actualNow() - 5999;
            return true;
          },
          new AbortController().signal,
        );
        expect(await first.settled).toHaveProperty('error');
        expect(fetch).not.toHaveBeenCalled();
        expect(await redis.exists(COMMERCIAL_LLM_LEASE_KEY, keys.request, keys.claim)).toBe(0);
      } finally {
        clock.mockRestore();
        fetch.mockRestore();
      }
    },
  );

  it('retains the exact persistent CPU fence after an accepted HTTP request is interrupted', async () => {
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const server = createServer((request) => {
      request.resume();
      accept();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback fixture missing');
    const shutdown = new AbortController();
    try {
      const first = submit();
      const task = await take();
      const lease = new CommercialLlmShadowLease(redis);
      const scheduler = new CommercialLlmSecondaryScheduler(
        lease,
        new CommercialLlmClient({ endpoint: `http://127.0.0.1:${address.port}` }),
      );
      const work = processCommercialLlmPreview(
        mailbox,
        task,
        scheduler,
        async () => true,
        shutdown.signal,
      );
      await accepted;
      const token = await redis.get(COMMERCIAL_LLM_LEASE_KEY);
      expect(token).not.toBeNull();
      expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
      shutdown.abort();
      await work;
      expect(await first.settled).toHaveProperty('error');
      expect(await redis.exists(keys.request, keys.claim, keys.result + task.request.id)).toBe(0);
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
      expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
      await redis.del(COMMERCIAL_LLM_COOLDOWN_KEY);
      expect(await lease.acquire()).toBeNull();
    } finally {
      shutdown.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
