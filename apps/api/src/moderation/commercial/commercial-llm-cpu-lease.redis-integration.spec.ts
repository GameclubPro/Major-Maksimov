import { createServer, type Server, type RequestListener } from 'node:http';
import type Redis from 'ioredis';
import {
  CommercialLlmClient,
  CommercialLlmError,
  COMMERCIAL_LLM_RESPONSE_MAX_BYTES,
  type CommercialLlmHttpClassifier,
} from './commercial-llm.client';
import { CommercialLlmCpuLeaseScope } from './commercial-llm-cpu-lease-scope';
import { CommercialLlmBudgetedSecondary } from './commercial-llm-budgeted-secondary';
import { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';
import { COMMERCIAL_LLM_MODEL_ALIAS } from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_COOLDOWN_KEY,
  COMMERCIAL_LLM_LEASE_KEY,
  CommercialLlmShadowLease,
  createCommercialLlmRedis,
} from './commercial-llm-shadow.lease';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const text = 'Соседи, кто знает расписание автобуса?';
const response = JSON.stringify({
  model: COMMERCIAL_LLM_MODEL_ALIAS,
  choices: [
    {
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          classification: 'NOT_COMMERCIAL',
          reasonCodes: ['ORDINARY_DISCUSSION'],
        }),
      },
    },
  ],
});

// FLAG: Disposable loopback Redis/HTTP fixtures only; no inference, MAX clients or effects.
(url ? describe : describe.skip)(
  'legacy CPU uncertainty uses real HTTP lifecycle and Redis leases',
  () => {
    let redis: Redis;
    let lease: CommercialLlmShadowLease;
    const servers: Server[] = [];
    const serve = async (handler: RequestListener) => {
      const server = createServer(handler);
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('loopback fixture missing');
      return new CommercialLlmClient({ endpoint: `http://127.0.0.1:${address.port}` });
    };
    beforeAll(async () => {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
        throw new Error('disposable loopback Redis required');
      redis = createCommercialLlmRedis(url);
      await redis.connect();
      lease = new CommercialLlmShadowLease(redis);
    });
    beforeEach(async () => {
      await redis.del(COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY);
    });
    afterEach(async () => {
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await redis.del(COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY);
    });
    afterAll(() => redis?.disconnect());

    it.each(['scheduler', 'negative-audit'] as const)(
      '%s keeps a persistent exact-token fence after an accepted POST is aborted',
      async (route) => {
        let accepted!: () => void;
        const seen = new Promise<void>((resolve) => {
          accepted = resolve;
        });
        const client = await serve((request) => {
          request.resume();
          accepted();
        });
        const controller = new AbortController();
        const work =
          route === 'scheduler'
            ? new CommercialLlmSecondaryScheduler(lease, client).classifyWithin(
                text,
                Date.now() + 20_000,
                controller.signal,
              )
            : new CommercialLlmBudgetedSecondary(lease, client).classify(text, controller.signal);
        const rejected = expect(work).rejects.toMatchObject({ kind: 'ABORTED' });
        await seen;
        const token = await redis.get(COMMERCIAL_LLM_LEASE_KEY);
        expect(token).not.toBeNull();
        expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
        controller.abort();
        await rejected;
        expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
        expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
        await redis.del(COMMERCIAL_LLM_COOLDOWN_KEY);
        expect(await lease.acquire()).toBeNull();
      },
    );

    it.each(['http-error', 'invalid', 'oversized'] as const)(
      'does not interpret %s as proof of physical completion',
      async (failure) => {
        const client = await serve((request, reply) => {
          request.resume();
          reply.writeHead(failure === 'http-error' ? 503 : 200, {
            'content-type': 'application/json',
          });
          reply.end(
            failure === 'oversized' ? 'x'.repeat(COMMERCIAL_LLM_RESPONSE_MAX_BYTES + 1) : '{}',
          );
        });
        await expect(
          new CommercialLlmBudgetedSecondary(lease, client).classify(text),
        ).rejects.toBeInstanceOf(Error);
        expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
        expect(await redis.pttl(COMMERCIAL_LLM_COOLDOWN_KEY)).toBeGreaterThan(0);
      },
    );

    it('rejects a completed result after source revocation but releases its physical token', async () => {
      let current = true;
      const client = await serve((request, reply) => {
        request.resume();
        current = false;
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(response);
      });
      await expect(
        new CommercialLlmBudgetedSecondary(lease, client).classify(
          text,
          undefined,
          async () => current,
        ),
      ).rejects.toMatchObject({ kind: 'ABORTED' });
      expect(await redis.exists(COMMERCIAL_LLM_LEASE_KEY)).toBe(0);
      expect(await redis.pttl(COMMERCIAL_LLM_COOLDOWN_KEY)).toBeGreaterThan(0);
    });

    it.each(['retention', 'revocation', 'replacement'] as const)(
      'never sends HTTP after pre-dispatch %s fails',
      async (gate) => {
        let posts = 0;
        const client = await serve((request, reply) => {
          posts++;
          request.resume();
          reply.end(response);
        });
        const token = (await lease.acquire())!;
        const scope = new CommercialLlmCpuLeaseScope(
          {
            owns: lease.owns.bind(lease),
            release: lease.release.bind(lease),
            retainUntilReleased: async (owned) =>
              gate === 'retention' ? false : lease.retainUntilReleased(owned),
          },
          token,
        );
        const classify = scope.classifier(client).classify(text, undefined, async () => {
          if (gate === 'replacement') await redis.set(COMMERCIAL_LLM_LEASE_KEY, 'successor');
          return gate !== 'revocation';
        });
        await expect(classify).rejects.toMatchObject({ kind: 'ABORTED' });
        await scope.finish();
        expect(posts).toBe(0);
        expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(
          gate === 'replacement' ? 'successor' : null,
        );
      },
    );

    it('never deletes a successor token when a completed request loses ownership', async () => {
      const client = await serve(async (request, reply) => {
        request.resume();
        await redis.set(COMMERCIAL_LLM_LEASE_KEY, 'successor');
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(response);
      });
      await expect(
        new CommercialLlmBudgetedSecondary(lease, client).classify(text),
      ).rejects.toMatchObject({ kind: 'ABORTED' });
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe('successor');
    });

    it('a late validated HTTP completion after caller rejection cannot delete a successor', async () => {
      const client = await serve((request, reply) => {
        request.resume();
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(response);
      });
      let deliverCompletion: (() => void) | undefined;
      // FLAG: Delay only delivery of the genuine client's validated completion hook.
      // The adapter models an outer caller already rejected by its deadline race.
      const delayedClient: CommercialLlmHttpClassifier = {
        classifyWithLifecycle: async (excerpt, signal, lifecycle) => {
          await client.classifyWithLifecycle(excerpt, signal, {
            ...lifecycle,
            completed: () => {
              deliverCompletion = lifecycle.completed;
            },
          });
          throw new CommercialLlmError('ABORTED');
        },
      };
      const token = (await lease.acquire())!;
      const scope = new CommercialLlmCpuLeaseScope(lease, token);
      await expect(scope.classifier(delayedClient).classify(text)).rejects.toMatchObject({
        kind: 'ABORTED',
      });
      await scope.finish();
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(token);
      expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
      await redis.set(COMMERCIAL_LLM_LEASE_KEY, 'successor');
      expect(deliverCompletion).toBeDefined();
      deliverCompletion!();
      // finish now waits for the late hook's exact-token release to settle.
      await scope.finish();
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe('successor');
    });

    it('finishing while persistent pinning is pending prevents a later HTTP handoff', async () => {
      let posts = 0;
      const client = await serve((request, reply) => {
        posts++;
        request.resume();
        reply.end(response);
      });
      let pinned!: () => void;
      let resumePin!: () => void;
      const pinObserved = new Promise<void>((resolve) => {
        pinned = resolve;
      });
      const pinGate = new Promise<void>((resolve) => {
        resumePin = resolve;
      });
      const token = (await lease.acquire())!;
      const scope = new CommercialLlmCpuLeaseScope(
        {
          owns: lease.owns.bind(lease),
          release: lease.release.bind(lease),
          retainUntilReleased: async (owned) => {
            const retained = await lease.retainUntilReleased(owned);
            pinned();
            await pinGate;
            return retained;
          },
        },
        token,
      );
      const work = scope.classifier(client).classify(text);
      const rejected = expect(work).rejects.toMatchObject({ kind: 'ABORTED' });
      await pinObserved;
      expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
      await scope.finish();
      resumePin();
      await rejected;
      expect(posts).toBe(0);
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBeNull();
    });

    it('finishing between resolved pre-dispatch validation and fetch still prevents the POST', async () => {
      let posts = 0;
      const client = await serve((request, reply) => {
        posts++;
        request.resume();
        reply.end(response);
      });
      const token = (await lease.acquire())!;
      const scope = new CommercialLlmCpuLeaseScope(lease, token);
      const finishingClient: CommercialLlmHttpClassifier = {
        classifyWithLifecycle: (excerpt, signal, lifecycle) =>
          client.classifyWithLifecycle(excerpt, signal, {
            ...lifecycle,
            beforeDispatch: async () => {
              await lifecycle.beforeDispatch();
              await scope.finish();
            },
          }),
      };
      await expect(scope.classifier(finishingClient).classify(text)).rejects.toMatchObject({
        kind: 'ABORTED',
      });
      expect(posts).toBe(0);
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBeNull();
    });
  },
);
