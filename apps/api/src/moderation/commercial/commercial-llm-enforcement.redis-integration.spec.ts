import {
  CommercialLlmEnforcementService,
  routeCommercialAiViolations,
} from './commercial-llm-enforcement.service';
import { withCanonicalWebhookOrigin } from '../webhook-effect-origin-context';
import {
  withCommercialLlmEffectOrigin,
  readCommercialLlmEffectOrigin,
} from './commercial-llm-effect-origin';
import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCommercialLlmRedis,
  CommercialLlmShadowLease,
  COMMERCIAL_LLM_LEASE_KEY,
  COMMERCIAL_LLM_COOLDOWN_KEY,
} from './commercial-llm-shadow.lease';
import {
  CommercialLlmEnforcementMailbox,
  COMMERCIAL_LLM_ENFORCEMENT_KEYS as keys,
  COMMERCIAL_LLM_ACTIVE_LIMIT,
  COMMERCIAL_LLM_CHAT_ACTIVE_LIMIT,
  commercialLlmProofKey,
  type CommercialLlmAdmissionResult,
} from './commercial-llm-enforcement.mailbox';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import { CommercialLlmBudgetedSecondary } from './commercial-llm-budgeted-secondary';
import { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';
import { CommercialLlmError, type CommercialLlmHttpClassifier } from './commercial-llm.client';
import { CommercialLlmCascadeClient } from './commercial-llm-cascade.client';
import {
  buildCommercialLlmOffer,
  commercialLlmMayDelete,
  commercialLlmSourceKey,
  COMMERCIAL_LLM_DELETE_RULE_CODE,
  type CommercialLlmRequest,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';
import { CommercialLlmDeleteGuardService } from './commercial-llm-delete-guard.service';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
  type CommercialLlmClassifier,
} from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_CASCADE_VERSION,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
} from './commercial-llm-workstation.protocol';
import type { ModerationDeleteIntentService } from '../moderation-delete-intent.service';

const settings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
  textFiltersWarnEnabled: true,
  textFiltersMuteEnabled: true,
  textFiltersBanEnabled: true,
  textFiltersMuteDurationHours: 1,
  textFiltersBotMessageEnabled: true,
};
const positive: CommercialLlmObservationResult = {
  classification: 'COMMERCIAL',
  reasonCodes: ['COMMERCIAL_OFFER'],
  modelAlias: 'qwen35-9b-commercial-shadow',
  modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
  promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
  runtimeVersion: COMMERCIAL_LLM_RUNTIME_VERSION,
  runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
  durationMs: 25,
  cascade: {
    version: COMMERCIAL_LLM_CASCADE_VERSION,
    route: 'secondary_unsure',
    primaryClassification: 'UNSURE',
    primaryModelSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelSha256,
  },
};
const text =
  'Мастерская принимает заказы на ремонт квартир. Работаем по договору, запись на замер.';
const httpClient = (client: CommercialLlmClassifier): CommercialLlmHttpClassifier => ({
  classifyWithLifecycle: async (excerpt, signal, lifecycle) => {
    await lifecycle.beforeDispatch();
    lifecycle.dispatched();
    const value = await client.classify(excerpt, signal);
    lifecycle.completed();
    return value;
  },
});
const origin = (eventAtMs: number, bot = 'bot') => ({
  sourceWebhookEventId: randomUUID(),
  sourceReceivingBotId: bot,
  sourceExecutionBotId: bot,
  sourceEventAtMs: eventAtMs,
  sourceEvidenceVersion: 1 as const,
});
const offer = (chatId = 'chat') => {
  const now = Date.now();
  return buildCommercialLlmOffer({
    chatId,
    messageId: randomUUID(),
    userId: 'user',
    originBotId: 'bot',
    text,
    eventAt: new Date(now).toISOString(),
    origin: origin(now),
    settings,
  })!;
};
const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const nextPendingKey = 'commercial-llm-enforcement:v3:slot-next';
const previousPendingKey = 'commercial-llm-enforcement:v2:slot';
(url ? describe : describe.skip)(
  'commercial AI bounded pipeline admission and fresh deletion on real Redis',
  () => {
    let redis: Redis;
    let mailbox: CommercialLlmEnforcementMailbox;
    let worker: string;
    const proofs: string[] = [];
    beforeAll(async () => {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
        throw new Error('Disposable loopback Redis required');
      redis = createCommercialLlmRedis(url);
      await redis.connect();
      mailbox = new CommercialLlmEnforcementMailbox(redis);
    });
    beforeEach(async () => {
      await redis.del(
        ...Object.values(keys),
        nextPendingKey,
        previousPendingKey,
        COMMERCIAL_LLM_LEASE_KEY,
        COMMERCIAL_LLM_COOLDOWN_KEY,
        ...proofs,
      );
      worker = randomUUID();
    });
    afterAll(async () => {
      await redis.del(
        ...Object.values(keys),
        nextPendingKey,
        previousPendingKey,
        COMMERCIAL_LLM_LEASE_KEY,
        COMMERCIAL_LLM_COOLDOWN_KEY,
        ...proofs,
      );
      redis.disconnect();
    });
    async function ready() {
      expect(await mailbox.heartbeat(worker)).toBe(true);
      expect(await mailbox.advertise(worker)).toBe(true);
    }
    function processor(
      classify: CommercialLlmClassifier['classify'] = async () => positive,
      mayRun = async () => true,
    ) {
      const ensureIntent = jest
        .fn<
          ReturnType<ModerationDeleteIntentService['ensureIntent']>,
          Parameters<ModerationDeleteIntentService['ensureIntent']>
        >()
        .mockResolvedValue({ intentId: 'intent', rollout: 'execute', status: 'PENDING' });
      return {
        ensureIntent,
        process: new CommercialLlmEnforcementProcessor(
          mailbox,
          { classify },
          { ensureIntent },
          mayRun,
        ),
      };
    }
    async function activate(input: ReturnType<typeof offer>) {
      await ready();
      expect(await mailbox.offerDetailed(input)).toBe('accepted');
      await redis.del(keys.cooldown);
      const item = await mailbox.take(worker);
      if (!item) throw new Error('Expected bounded primary admission');
      return item;
    }
    it('seeds the exact original request before admission without changing wire or clocks', async () => {
      await ready();
      const source = offer();
      let captured:
        | Parameters<NonNullable<Parameters<typeof mailbox.offerDetailed>[1]>>[0]
        | undefined;
      expect(
        await mailbox.offerDetailed(source, async (request) => {
          captured = request;
          expect(await redis.get(keys.slot)).toBeNull();
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }),
      ).toBe('accepted');
      const stored = JSON.parse((await redis.get(keys.slot))!);
      expect(stored).toEqual(captured);
      expect(Object.keys(stored).sort()).toEqual(['excerpt', 'source', 'submittedAtMs', 'worker']);
      expect(stored.source).toEqual(source.source);
      expect(await redis.pexpiretime(keys.slot)).toBe(source.source.deadlineAtMs);
    });
    it('contains a failed optional pre-admission observer and keeps ordinary admission', async () => {
      await ready();
      expect(
        await mailbox.offerDetailed(offer(), async () => {
          throw new Error('isolated optional evidence failure');
        }),
      ).toBe('accepted');
      expect(await redis.get(keys.slot)).not.toBeNull();
    });
    describe('burst pending', () => {
      async function headWithCapacity() {
        const active = await activate(offer('active-server-chat'));
        expect(await mailbox.releasePrimary(active.raw, worker)).toBe(true);
        const head = offer('burst-head-chat');
        expect(await mailbox.offerDetailed(head)).toBe('accepted');
        const raw = (await redis.get(keys.slot))!;
        await redis.set(keys.cooldown, '1', 'PX', 200);
        return { active, head, raw };
      }

      it('retains one eligible burst pending tail under concurrent offers without renewing clocks', async () => {
        const { active, raw } = await headWithCapacity();
        const readyExpiry = await redis.pexpiretime(keys.ready);
        const headExpiry = await redis.pexpiretime(keys.slot);
        const tails = Array.from({ length: 50 }, (_, index) => offer(`tail-${index}`));
        const results = await Promise.all(tails.map((input) => mailbox.offerDetailed(input)));
        expect(results.filter((result) => result === 'accepted')).toHaveLength(1);
        expect(results.filter((result) => result === 'buffer_full')).toHaveLength(49);
        const accepted = tails[results.indexOf('accepted')]!;
        const tail = JSON.parse((await redis.get(nextPendingKey))!) as CommercialLlmRequest;
        expect(tail.source).toEqual(accepted.source);
        expect(await redis.get(keys.slot)).toBe(raw);
        expect(await redis.pexpiretime(keys.slot)).toBe(headExpiry);
        expect(await redis.pexpiretime(nextPendingKey)).toBe(accepted.source.deadlineAtMs);
        expect(await redis.pexpiretime(keys.ready)).toBe(readyExpiry);
        expect(await mailbox.offerDetailed(offer(accepted.source.chatId))).toBe('chat_busy');
        expect(
          await mailbox.offerDetailed({
            ...accepted,
            source: { ...accepted.source, nonce: randomUUID() },
          }),
        ).toBe('chat_busy');
        expect(await redis.exists(keys.primary)).toBe(0);
        expect(await redis.hlen(keys.active)).toBe(1);
        expect(await mailbox.owns(active.raw)).toBe(true);
        await redis.set(keys.cooldown, '1', 'PX', 2_000);
        expect(await mailbox.take(worker)).toBeNull();
        expect(await mailbox.hasProof(accepted.source)).toBe(false);
      });

      it('promotes the burst pending tail atomically in FIFO order without renewing its expiry', async () => {
        const { active, head } = await headWithCapacity();
        const tail = offer('burst-tail-chat');
        expect(await mailbox.offerDetailed(tail)).toBe('accepted');
        const tailRaw = (await redis.get(nextPendingKey))!;
        const tailExpiry = await redis.pexpiretime(nextPendingKey);
        await redis.del(keys.cooldown);
        const first = (await mailbox.take(worker))!;
        expect(first.request.source).toEqual(head.source);
        expect(await redis.get(keys.slot)).toBe(tailRaw);
        expect(await redis.pexpiretime(keys.slot)).toBe(tailExpiry);
        expect(await redis.exists(nextPendingKey)).toBe(0);
        expect(await mailbox.offerDetailed(offer('late-arrival'))).toBe('buffer_full');
        expect(await redis.get(keys.slot)).toBe(tailRaw);
        expect(await mailbox.owns(active.raw)).toBe(true);
        expect(await mailbox.owns(first.raw)).toBe(true);
        expect(await mailbox.releasePrimary(first.raw, worker)).toBe(true);
        await redis.del(keys.cooldown);
        const second = (await mailbox.take(worker))!;
        expect(second.raw).toBe(tailRaw);
        expect(second.request.source).toEqual(tail.source);
        expect(await redis.hlen(keys.active)).toBe(COMMERCIAL_LLM_ACTIVE_LIMIT);
        expect(await redis.exists(keys.slot, nextPendingKey)).toBe(0);
      });

      it('starts both burst pending sources within their original three seconds through the real two-second interval', async () => {
        const { active } = await headWithCapacity();
        expect(await mailbox.claimSecondary(active.raw, worker)).toBe(true);
        const lease = new CommercialLlmShadowLease(redis);
        const serverToken = await lease.acquire();
        expect(serverToken).not.toBeNull();
        try {
          const headRaw = (await redis.get(keys.slot))!;
          const headRequest = JSON.parse(headRaw) as CommercialLlmRequest;
          const tail = offer('timed-tail-chat');
          expect(await mailbox.offerDetailed(tail)).toBe('accepted');
          const tailRaw = (await redis.get(nextPendingKey))!;
          const tailRequest = JSON.parse(tailRaw) as CommercialLlmRequest;
          let first: Awaited<ReturnType<CommercialLlmEnforcementMailbox['take']>> = null;
          while (!first && Date.now() - headRequest.submittedAtMs <= 3_000) {
            first = await mailbox.take(worker);
            if (!first) await new Promise((resolve) => setTimeout(resolve, 250));
          }
          expect(first?.raw).toBe(headRaw);
          expect(Date.now() - headRequest.submittedAtMs).toBeLessThanOrEqual(3_000);
          const nextPrimaryStartAt = await redis.pexpiretime(keys.cooldown);
          expect(nextPrimaryStartAt - Date.now()).toBeGreaterThan(1_500);
          expect(await mailbox.releasePrimary(first!.raw, worker)).toBe(true);
          expect(await mailbox.take(worker)).toBeNull();
          let second: Awaited<ReturnType<CommercialLlmEnforcementMailbox['take']>> = null;
          while (!second && Date.now() - tailRequest.submittedAtMs <= 3_000) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            second = await mailbox.take(worker);
          }
          const secondStartedAt = Date.now();
          expect(second?.raw).toBe(tailRaw);
          expect(secondStartedAt).toBeGreaterThanOrEqual(nextPrimaryStartAt);
          expect(secondStartedAt - tailRequest.submittedAtMs).toBeLessThanOrEqual(3_000);
          expect(await redis.get(keys.primary)).toBe(tailRaw);
          expect(await redis.hlen(keys.active)).toBe(COMMERCIAL_LLM_ACTIVE_LIMIT);
          expect(await mailbox.owns(active.raw)).toBe(true);
          expect(await mailbox.owns(first!.raw)).toBe(true);
          expect(await lease.owns(serverToken!)).toBe(true);
          expect(Object.values(await redis.hgetall(keys.secondary))).toEqual([active.raw]);
          expect(await mailbox.hasProof(tail.source)).toBe(false);
        } finally {
          if (serverToken) await lease.release(serverToken);
        }
      });

      it('expires the original burst tail without inference while a slow head retains primary and server fences', async () => {
        const { active } = await headWithCapacity();
        expect(await mailbox.claimSecondary(active.raw, worker)).toBe(true);
        const lease = new CommercialLlmShadowLease(redis);
        const serverToken = await lease.acquire();
        expect(serverToken).not.toBeNull();
        try {
          const tail = offer('expired-tail-chat');
          expect(await mailbox.offerDetailed(tail)).toBe('accepted');
          const expired = JSON.parse((await redis.get(nextPendingKey))!) as CommercialLlmRequest;
          expired.submittedAtMs = Date.now() - 3_001;
          await redis.set(nextPendingKey, JSON.stringify(expired), 'PX', 50_000);
          await redis.del(keys.cooldown);
          const busyHead = (await mailbox.take(worker))!;
          expect(busyHead).not.toBeNull();
          const cooldownExpiry = await redis.pexpiretime(keys.cooldown);
          const classify = jest
            .fn<
              ReturnType<CommercialLlmClassifier['classify']>,
              Parameters<CommercialLlmClassifier['classify']>
            >()
            .mockResolvedValue(positive);
          const h = processor(classify);
          expect(await h.process.run(worker, new AbortController().signal)).toEqual({
            outcome: 'idle',
          });
          expect(await h.process.run(worker, new AbortController().signal)).toEqual({
            outcome: 'idle',
          });
          expect(classify).not.toHaveBeenCalled();
          expect(h.ensureIntent).not.toHaveBeenCalled();
          expect(await mailbox.readObservations()).toEqual({ pending_expired: 1 });
          expect(await redis.exists(keys.slot, nextPendingKey)).toBe(0);
          expect(await redis.get(keys.primary)).toBe(busyHead.raw);
          expect(await redis.pexpiretime(keys.cooldown)).toBe(cooldownExpiry);
          expect(await redis.hlen(keys.active)).toBe(2);
          expect(await mailbox.owns(active.raw)).toBe(true);
          expect(await mailbox.owns(busyHead.raw)).toBe(true);
          expect(await lease.owns(serverToken!)).toBe(true);
          expect(Object.values(await redis.hgetall(keys.secondary))).toEqual([active.raw]);
          expect(await mailbox.hasProof(tail.source)).toBe(false);
        } finally {
          if (serverToken) await lease.release(serverToken);
        }
      });

      it('discards an expired burst pending head once and preserves the promoted tail admission', async () => {
        const { active, raw } = await headWithCapacity();
        const tail = offer('burst-tail-chat');
        expect(await mailbox.offerDetailed(tail)).toBe('accepted');
        const tailRaw = (await redis.get(nextPendingKey))!;
        const tailExpiry = await redis.pexpiretime(nextPendingKey);
        const old = JSON.parse(raw) as CommercialLlmRequest;
        old.submittedAtMs -= 3_001;
        await redis.set(keys.slot, JSON.stringify(old), 'PX', 50_000);
        await redis.set(keys.cooldown, '1', 'PX', 5_000);
        const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        try {
          expect(await Promise.all(Array.from({ length: 20 }, () => mailbox.take(worker)))).toEqual(
            Array(20).fill(null),
          );
          expect(await mailbox.readObservations()).toEqual({ pending_expired: 1 });
          expect(logs.mock.calls.map(([value]) => value)).toEqual([
            expect.objectContaining({ outcome: 'pending_expired', traceId: old.source.nonce }),
          ]);
        } finally {
          logs.mockRestore();
        }
        expect(await redis.get(keys.slot)).toBe(tailRaw);
        expect(await redis.pexpiretime(keys.slot)).toBe(tailExpiry);
        expect(await redis.exists(nextPendingKey)).toBe(0);
        expect(await mailbox.owns(active.raw)).toBe(true);
        expect(await redis.exists(keys.primary)).toBe(0);
      });

      it.each(['empty', 'malformed', 'foreign', 'expired', 'nearly_expired', 'future'] as const)(
        'refuses append behind a %s burst pending head without promoting or discarding it',
        async (mode) => {
          const { raw } = await headWithCapacity();
          const head = JSON.parse(raw) as CommercialLlmRequest;
          if (mode === 'foreign') head.worker = randomUUID();
          if (mode === 'expired') head.submittedAtMs -= 3_001;
          if (mode === 'nearly_expired') head.submittedAtMs = Date.now() - 2_900;
          if (mode === 'future') head.submittedAtMs = Date.now() + 2_000;
          const retained =
            mode === 'empty'
              ? ''
              : mode === 'malformed'
                ? '{"excerpt":"private invalid head"}'
                : JSON.stringify(head);
          await redis.set(keys.slot, retained, 'PX', 50_000);
          expect(await mailbox.offerDetailed(offer('burst-tail-chat'))).toBe('buffer_full');
          expect(await redis.get(keys.slot)).toBe(retained);
          expect(await redis.exists(nextPendingKey)).toBe(0);
          expect(await mailbox.readObservations()).toEqual({});
        },
      );

      it.each([
        'primary',
        'cooldown',
        'unexpiring_cooldown',
        'active_capacity',
        'same_chat',
      ] as const)(
        'refuses burst pending append for %s while retaining both source and model fences',
        async (mode) => {
          const { active, head, raw } = await headWithCapacity();
          if (mode === 'primary') await redis.set(keys.primary, active.raw, 'PX', 5_000);
          if (mode === 'cooldown') await redis.set(keys.cooldown, '1', 'PX', 1_000);
          if (mode === 'unexpiring_cooldown') await redis.set(keys.cooldown, '1');
          if (mode === 'active_capacity') {
            const extra = JSON.stringify({
              ...offer('other-active'),
              worker,
              submittedAtMs: Date.now(),
            });
            await redis.hset(keys.active, createHash('sha256').update(extra).digest('hex'), extra);
          }
          expect(
            await mailbox.offerDetailed(offer(mode === 'same_chat' ? head.source.chatId : 'tail')),
          ).toBe(mode === 'same_chat' ? 'chat_busy' : 'buffer_full');
          expect(await redis.get(keys.slot)).toBe(raw);
          expect(await redis.exists(nextPendingKey)).toBe(0);
          expect(await mailbox.owns(active.raw)).toBe(true);
        },
      );

      it('rejects append after the validated burst pending head changes before its CAS', async () => {
        await headWithCapacity();
        const snapshot = await redis.mget(keys.ready, keys.slot);
        const successor = JSON.stringify({
          ...offer('successor-head'),
          worker,
          submittedAtMs: Date.now(),
        });
        const read = jest.spyOn(redis, 'mget').mockImplementationOnce(async () => {
          await redis.set(keys.slot, successor, 'PX', 50_000);
          return snapshot;
        });
        try {
          expect(await mailbox.offerDetailed(offer('burst-tail-chat'))).toBe('buffer_full');
          expect(read).toHaveBeenCalled();
        } finally {
          read.mockRestore();
        }
        expect(await redis.get(keys.slot)).toBe(successor);
        expect(await redis.exists(nextPendingKey)).toBe(0);
      });

      it.each(['worker', 'readiness'] as const)(
        'refuses burst pending append when %s changes after its snapshot',
        async (mode) => {
          const { raw } = await headWithCapacity();
          const snapshot = await redis.mget(keys.ready, keys.slot);
          const read = jest.spyOn(redis, 'mget').mockImplementationOnce(async () => {
            await redis.set(
              mode === 'worker' ? keys.worker : keys.ready,
              randomUUID(),
              'PX',
              5_000,
            );
            return snapshot;
          });
          try {
            expect(await mailbox.offerDetailed(offer('burst-tail-chat'))).toBe('worker_changed');
          } finally {
            read.mockRestore();
          }
          expect(await redis.get(keys.slot)).toBe(raw);
          expect(await redis.exists(nextPendingKey)).toBe(0);
        },
      );

      it.each(['malformed', 'foreign', 'expired'] as const)(
        'discards a promoted %s burst pending tail exactly once while preserving independent proof',
        async (mode) => {
          const { active } = await headWithCapacity();
          proofs.push(commercialLlmProofKey(active.request.source));
          expect(await mailbox.prove(active.raw, active.request.source)).toBe(true);
          const tail = offer('bad-tail-chat');
          expect(await mailbox.offerDetailed(tail)).toBe('accepted');
          const pending = JSON.parse((await redis.get(nextPendingKey))!) as CommercialLlmRequest;
          if (mode === 'foreign') pending.worker = randomUUID();
          if (mode === 'expired') pending.submittedAtMs -= 3_001;
          const invalidRaw =
            mode === 'malformed' ? '{"excerpt":"private invalid tail"}' : JSON.stringify(pending);
          await redis.set(nextPendingKey, invalidRaw, 'PX', 50_000);
          await redis.del(keys.cooldown);
          const busyHead = (await mailbox.take(worker))!;
          expect(busyHead).not.toBeNull();
          expect(await redis.get(keys.slot)).toBe(invalidRaw);
          await redis.set(keys.cooldown, '1', 'PX', 5_000);
          const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
          try {
            expect(
              await Promise.all(Array.from({ length: 20 }, () => mailbox.take(worker))),
            ).toEqual(Array(20).fill(null));
            const reason =
              mode === 'malformed'
                ? 'invalid_pending'
                : mode === 'foreign'
                  ? 'foreign_worker'
                  : 'pending_expired';
            expect(await mailbox.readObservations()).toEqual({ [reason]: 1 });
            expect(logs).toHaveBeenCalledTimes(1);
            expect(logs.mock.calls[0]![0]).toMatchObject({ outcome: reason });
          } finally {
            logs.mockRestore();
          }
          expect(await redis.exists(keys.slot, nextPendingKey)).toBe(0);
          expect(await redis.get(keys.primary)).toBe(busyHead.raw);
          expect(await mailbox.owns(busyHead.raw)).toBe(true);
          expect(await mailbox.owns(active.raw)).toBe(true);
          expect(await mailbox.hasProof(active.request.source)).toBe(true);
          expect(await mailbox.hasProof(tail.source)).toBe(false);
        },
      );

      it.each(['foreign', 'expired'] as const)(
        'rejects an orphan %s burst pending tail under the current worker without inference',
        async (mode) => {
          await ready();
          const input = offer('orphan-tail');
          const raw = JSON.stringify({
            ...input,
            worker: mode === 'foreign' ? randomUUID() : worker,
            submittedAtMs: Date.now() - (mode === 'expired' ? 3_001 : 0),
          });
          await redis.set(nextPendingKey, raw, 'PX', 5_000);
          expect(await mailbox.take(randomUUID())).toBeNull();
          expect(await redis.get(nextPendingKey)).toBe(raw);
          expect(await redis.exists(keys.slot)).toBe(0);
          expect(await mailbox.take(worker)).toBeNull();
          expect(await redis.exists(keys.slot, nextPendingKey, keys.primary)).toBe(0);
          expect(await redis.hlen(keys.active)).toBe(0);
          expect(await mailbox.hasProof(input.source)).toBe(false);
          expect(await mailbox.readObservations()).toEqual({
            [mode === 'foreign' ? 'foreign_worker' : 'pending_expired']: 1,
          });
        },
      );

      it('versions only burst pending slots while preserving shared coordination and proof keys', async () => {
        expect(keys.slot).toBe('commercial-llm-enforcement:v3:slot');
        expect(Object.values(keys)).toContain(nextPendingKey);
        expect(keys.worker).toBe('commercial-llm-enforcement:v2:worker');
        expect(keys.ready).toBe('commercial-llm-enforcement:v2:ready');
        expect(keys.active).toBe('commercial-llm-enforcement:v2:active');
        expect(keys.primary).toBe('commercial-llm-enforcement:v2:primary');
        expect(keys.secondary).toBe('commercial-llm-enforcement:v2:secondary');
        expect(keys.cooldown).toBe('commercial-llm-enforcement:v2:primary-cooldown');
        expect(keys.metrics).toBe('commercial-llm-enforcement:v2:metrics');
        expect(keys.status).toBe('commercial-llm-enforcement:v1:status');
        await ready();
        const previous = JSON.stringify({
          ...offer('old-reader-chat'),
          worker,
          submittedAtMs: Date.now(),
        });
        await redis.set(previousPendingKey, previous, 'PX', 5_000);
        const current = offer('current-reader-chat');
        expect(await mailbox.offerDetailed(current)).toBe('accepted');
        expect((await mailbox.take(worker))!.request.source).toEqual(current.source);
        expect(await redis.get(previousPendingKey)).toBe(previous);
        expect(commercialLlmProofKey(current.source)).toMatch(
          /^commercial-llm-enforcement:v1:proof:/u,
        );
      });
    });
    it('offline refuses and simultaneous offers retain exactly one pending source', async () => {
      expect(await mailbox.offerDetailed(offer())).toBe('no_worker');
      await ready();
      expect(
        (await Promise.all(Array.from({ length: 50 }, () => mailbox.offer(offer())))).filter(
          Boolean,
        ),
      ).toHaveLength(1);
      expect(await mailbox.advertise(worker)).toBe(true);
      expect(await mailbox.heartbeat(randomUUID())).toBe(false);
      expect(await mailbox.take(randomUUID())).toBeNull();
      expect(await redis.exists(keys.slot)).toBe(1);
      expect(await redis.hlen(keys.active)).toBe(0);
      expect(await redis.exists(keys.primary, keys.cooldown)).toBe(0);
    });
    it('accepts a next chat after take without another readiness advertisement', async () => {
      await ready();
      const first = offer('running-chat');
      expect(await mailbox.offerDetailed(first)).toBe('accepted');
      const active = (await mailbox.take(worker))!;
      expect(active).not.toBeNull();
      const second = offer('next-chat');
      expect(await mailbox.offerDetailed(second)).toBe('accepted');
      expect(await redis.get(keys.ready)).toBe(worker);
      expect(await mailbox.offerDetailed(offer('running-chat'))).toBe('chat_busy');
      expect(await mailbox.offerDetailed(offer('next-chat'))).toBe('chat_busy');
      expect(await mailbox.offerDetailed(offer('third-chat'))).toBe('buffer_full');
      const pending = await redis.get(keys.slot);
      expect(JSON.parse(pending!).source).toEqual(second.source);
      expect(await redis.get(keys.primary)).toBe(active.raw);
      expect(await mailbox.take(worker)).toBeNull();
      expect(await redis.get(keys.slot)).toBe(pending);
      expect(await mailbox.releasePrimary(active.raw, worker)).toBe(true);
      expect(await mailbox.take(worker)).toBeNull();
      expect(await redis.get(keys.slot)).toBe(pending);
      expect(await mailbox.owns(active.raw)).toBe(true);
    });
    it('retains exactly one pending source under concurrent offers after take', async () => {
      await ready();
      expect(await mailbox.offerDetailed(offer('running-chat'))).toBe('accepted');
      const active = (await mailbox.take(worker))!;
      expect(active).not.toBeNull();
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          mailbox.offerDetailed(offer(`next-chat-${index}`)),
        ),
      );
      expect(results.filter((result) => result === 'accepted')).toHaveLength(1);
      expect(results.filter((result) => result === 'buffer_full')).toHaveLength(49);
      expect(await redis.exists(keys.slot)).toBe(1);
      expect(await redis.hlen(keys.active)).toBe(1);
      expect(await redis.get(keys.primary)).toBe(active.raw);
      expect(await mailbox.take(worker)).toBeNull();
    });
    it('preserves the readiness expiry and source deadline across consecutive admissions', async () => {
      await ready();
      const readyExpiry = await redis.pexpiretime(keys.ready);
      expect(readyExpiry).toBeGreaterThan(Date.now());
      expect(await redis.pttl(keys.ready)).toBeLessThanOrEqual(2_500);
      expect(await mailbox.offerDetailed(offer('running-chat'))).toBe('accepted');
      expect(await mailbox.take(worker)).not.toBeNull();
      const next = offer('next-chat');
      expect(await mailbox.offerDetailed(next)).toBe('accepted');
      expect(await redis.pexpiretime(keys.ready)).toBe(readyExpiry);
      expect(await redis.pexpiretime(keys.slot)).toBe(next.source.deadlineAtMs);
      expect(JSON.parse((await redis.get(keys.slot))!).source).toEqual(next.source);
    });
    it.each(['expiry', 'withdrawal'] as const)(
      'refuses another admission after readiness %s with the worker still alive',
      async (mode) => {
        await ready();
        expect(await mailbox.offerDetailed(offer('running-chat'))).toBe('accepted');
        const active = (await mailbox.take(worker))!;
        expect(active).not.toBeNull();
        await mailbox.withdraw(randomUUID());
        expect(await redis.get(keys.ready)).toBe(worker);
        if (mode === 'expiry') await redis.pexpireat(keys.ready, Date.now() - 1);
        else await mailbox.withdraw(worker);
        expect(await mailbox.ownsWorker(worker)).toBe(true);
        expect(await mailbox.offerDetailed(offer('next-chat'))).toBe('not_ready');
        expect(await redis.exists(keys.slot)).toBe(0);
        expect(await redis.get(keys.primary)).toBe(active.raw);
        expect(await mailbox.owns(active.raw)).toBe(true);
      },
    );
    it.each(['missing', 'changed'] as const)(
      'refuses retained readiness when the worker generation is %s',
      async (mode) => {
        await ready();
        expect(await mailbox.offerDetailed(offer('running-chat'))).toBe('accepted');
        const active = (await mailbox.take(worker))!;
        expect(active).not.toBeNull();
        if (mode === 'missing') await redis.del(keys.worker);
        else await redis.set(keys.worker, randomUUID(), 'PX', 5000);
        expect(await redis.get(keys.ready)).toBe(worker);
        expect(await mailbox.offerDetailed(offer('next-chat'))).toBe(
          mode === 'missing' ? 'no_worker' : 'worker_changed',
        );
        expect(await redis.exists(keys.slot)).toBe(0);
        expect(await redis.get(keys.primary)).toBe(active.raw);
        expect(await mailbox.releasePrimary(active.raw, worker)).toBe(false);
      },
    );
    it('buffers another chat during primary work and acquires its cooldown only at actual start', async () => {
      await ready();
      const first = offer('first-chat');
      expect(await mailbox.offerDetailed(first)).toBe('accepted');
      const active = (await mailbox.take(worker))!;
      expect(active).not.toBeNull();
      expect(await redis.pttl(keys.cooldown)).toBeGreaterThan(1_000);
      expect(await mailbox.advertise(worker)).toBe(true);
      expect(await mailbox.offerDetailed(offer('first-chat'))).toBe('chat_busy');
      const second = offer('second-chat');
      expect(await mailbox.offerDetailed(second)).toBe('accepted');
      expect(await mailbox.offerDetailed(offer('third-chat'))).toBe('buffer_full');
      const pendingRaw = await redis.get(keys.slot);
      expect(await mailbox.take(worker)).toBeNull();
      expect(await redis.get(keys.slot)).toBe(pendingRaw);
      expect(await mailbox.releasePrimary(active.raw, worker)).toBe(true);
      expect(await mailbox.take(worker)).toBeNull();
      expect(await redis.get(keys.slot)).toBe(pendingRaw);
      await redis.del(keys.cooldown);
      const next = (await mailbox.take(worker))!;
      expect(next.request.source).toEqual(second.source);
      expect(await mailbox.owns(active.raw)).toBe(true);
      expect(await mailbox.owns(next.raw)).toBe(true);
      expect(await redis.hlen(keys.active)).toBe(2);
      await mailbox.finish(active.raw, worker);
      expect(await redis.get(keys.primary)).toBe(next.raw);
      expect(await mailbox.owns(next.raw)).toBe(true);
    });
    it.each(['independent-chat', 'slow-server-chat'])(
      'completes a next source in %s while the first independently awaits server confirmation',
      async (nextChat) => {
        await ready();
        const first = offer('slow-server-chat');
        const second = offer(nextChat);
        proofs.push(commercialLlmProofKey(first.source));
        expect(await mailbox.offer(first)).toBe(true);
        let serverStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          serverStarted = resolve;
        });
        let serverFinish!: (result: CommercialLlmObservationResult) => void;
        const result = new Promise<CommercialLlmObservationResult>((resolve) => {
          serverFinish = resolve;
        });
        const slow = processor();
        const firstProcessor = new CommercialLlmEnforcementProcessor(
          mailbox,
          ({ raw }) =>
            new CommercialLlmCascadeClient(
              { classify: async () => ({ outcome: 'COMPLETE', result: positive }) },
              {
                classify: async () => {
                  serverStarted();
                  return result;
                },
              },
              async () => true,
              () => false,
              async () => {
                await mailbox.releasePrimary(raw, worker);
              },
            ),
          { ensureIntent: slow.ensureIntent },
          async () => true,
        );
        const running = firstProcessor.run(worker, new AbortController().signal);
        try {
          await started;
          expect(await redis.exists(keys.primary)).toBe(0);
          expect(await redis.hlen(keys.active)).toBe(1);
          await ready();
          expect(await mailbox.offer(second)).toBe(true);
          await redis.del(keys.cooldown);
          const independent = processor(async () => ({
            ...positive,
            classification: 'NOT_COMMERCIAL',
            reasonCodes: ['ORDINARY_DISCUSSION'],
          }));
          expect(await independent.process.run(worker, new AbortController().signal)).toMatchObject(
            {
              outcome: 'kept',
            },
          );
          expect(independent.ensureIntent).not.toHaveBeenCalled();
          expect(slow.ensureIntent).not.toHaveBeenCalled();
          expect(await redis.hlen(keys.active)).toBe(1);
        } finally {
          serverFinish(positive);
          await running;
        }
        expect(await running).toMatchObject({ outcome: 'delete_registered' });
        expect(slow.ensureIntent).toHaveBeenCalledTimes(1);
        expect(await mailbox.hasProof(first.source)).toBe(true);
        expect(await redis.hlen(keys.active)).toBe(0);
      },
    );
    it('admits only one next message of a confirming chat and preserves the global bound', async () => {
      expect(COMMERCIAL_LLM_CHAT_ACTIVE_LIMIT).toBe(2);
      const first = await activate(offer('same-chat'));
      expect(await mailbox.claimSecondary(first.raw, worker)).toBe(false);
      expect(await mailbox.releasePrimary(first.raw, worker)).toBe(true);
      expect(await mailbox.claimSecondary(first.raw, worker)).toBe(true);
      const duplicate = {
        ...first.request,
        source: { ...first.request.source, nonce: randomUUID() },
      };
      expect(await mailbox.offerDetailed(duplicate)).toBe('chat_busy');
      const candidates = Array.from({ length: 50 }, () => offer('same-chat'));
      const outcomes = await Promise.all(candidates.map((input) => mailbox.offerDetailed(input)));
      expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'chat_busy')).toHaveLength(49);
      await redis.del(keys.cooldown);
      const second = (await mailbox.take(worker))!;
      expect(second).not.toBeNull();
      expect(second.request.source.messageId).not.toBe(first.request.source.messageId);
      expect(await mailbox.releasePrimary(second.raw, worker)).toBe(true);
      expect(await mailbox.offerDetailed(offer('same-chat'))).toBe('chat_busy');
      const independent = await activate(offer('independent-chat'));
      expect(await redis.hlen(keys.active)).toBe(COMMERCIAL_LLM_ACTIVE_LIMIT);
      expect(await mailbox.owns(first.raw)).toBe(true);
      expect(await mailbox.owns(second.raw)).toBe(true);
      expect(await mailbox.owns(independent.raw)).toBe(true);
      expect(await mailbox.offerDetailed(offer('fourth-chat'))).toBe('active_limit');
      expect(await redis.hlen(keys.secondary)).toBe(1);
    });
    it.each(['duplicate_message', 'chat_limit'] as const)(
      'rechecks %s inside the pending-to-active CAS',
      async (mode) => {
        const first = await activate(offer('same-chat'));
        expect(await mailbox.releasePrimary(first.raw, worker)).toBe(true);
        if (mode === 'chat_limit') {
          const second = await activate(offer('same-chat'));
          expect(await mailbox.releasePrimary(second.raw, worker)).toBe(true);
        }
        const input = offer('same-chat');
        if (mode === 'duplicate_message') input.source.messageId = first.request.source.messageId;
        const raw = JSON.stringify({ ...input, worker, submittedAtMs: Date.now() });
        await redis.set(keys.slot, raw, 'PX', 3000);
        await redis.del(keys.cooldown);
        const before = await redis.hgetall(keys.active);
        expect(await mailbox.take(worker)).toBeNull();
        expect(await redis.get(keys.slot)).toBe(raw);
        expect(await redis.hgetall(keys.active)).toEqual(before);
        expect(await redis.exists(keys.primary)).toBe(0);
        expect(await mailbox.owns(first.raw)).toBe(true);
      },
    );
    it('reserves a chat for one server turn across races, reconnects and obsolete cleanup', async () => {
      const first = await activate(offer('same-chat'));
      expect(await mailbox.releasePrimary(first.raw, worker)).toBe(true);
      const claims = await Promise.all(
        Array.from({ length: 50 }, () => mailbox.claimSecondary(first.raw, worker)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      const second = await activate(offer('same-chat'));
      expect(await mailbox.releasePrimary(second.raw, worker)).toBe(true);
      expect(await mailbox.claimSecondary(second.raw, worker)).toBe(false);
      const reconnectedRedis = createCommercialLlmRedis(url);
      try {
        await reconnectedRedis.connect();
        const reconnected = new CommercialLlmEnforcementMailbox(reconnectedRedis);
        expect(await reconnected.claimSecondary(second.raw, worker)).toBe(false);
      } finally {
        reconnectedRedis.disconnect();
      }
      expect(await mailbox.releaseSecondary(first.raw, randomUUID())).toBe(false);
      const independent = await activate(offer('independent-chat'));
      expect(await mailbox.releasePrimary(independent.raw, worker)).toBe(true);
      expect(await mailbox.claimSecondary(independent.raw, worker)).toBe(true);
      const reservations = await redis.hgetall(keys.secondary);
      expect(Object.keys(reservations)).toHaveLength(2);
      expect(Object.keys(reservations).every((field) => /^[a-f0-9]{64}$/u.test(field))).toBe(true);
      expect(Object.values(reservations).sort()).toEqual([first.raw, independent.raw].sort());
      expect(await redis.pexpiretime(keys.secondary)).toBe(
        Math.max(first.request.source.deadlineAtMs, independent.request.source.deadlineAtMs),
      );
      expect(await mailbox.releaseSecondary(first.raw, worker)).toBe(true);
      expect(await mailbox.owns(first.raw)).toBe(true);
      expect(await mailbox.claimSecondary(second.raw, worker)).toBe(true);
      expect(await mailbox.releaseSecondary(first.raw, worker)).toBe(false);
      await mailbox.finish(first.raw, worker);
      expect(Object.values(await redis.hgetall(keys.secondary)).sort()).toEqual(
        [second.raw, independent.raw].sort(),
      );
      expect(await mailbox.owns(second.raw)).toBe(true);
      expect(await mailbox.owns(independent.raw)).toBe(true);
      expect(await mailbox.claimSecondary(first.raw, worker)).toBe(false);
      expect(await mailbox.hasProof(first.request.source)).toBe(false);
    });
    it('keeps the server waiting slot available for another chat while the first chat confirms', async () => {
      const first = await activate(offer('same-chat'));
      expect(await mailbox.releasePrimary(first.raw, worker)).toBe(true);
      let serverStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        serverStarted = resolve;
      });
      let serverFinish!: (value: CommercialLlmObservationResult) => void;
      const completion = new Promise<CommercialLlmObservationResult>((resolve) => {
        serverFinish = resolve;
      });
      let waiterStarted!: () => void;
      const waitingStarted = new Promise<void>((resolve) => {
        waiterStarted = resolve;
      });
      const client = {
        classify: jest
          .fn<
            ReturnType<CommercialLlmClassifier['classify']>,
            Parameters<CommercialLlmClassifier['classify']>
          >()
          .mockImplementationOnce(async () => {
            serverStarted();
            return completion;
          })
          .mockResolvedValue(positive),
      } satisfies CommercialLlmClassifier;
      const scheduler = new CommercialLlmSecondaryScheduler(
        new CommercialLlmShadowLease(redis),
        httpClient(client),
      );
      const controller = new AbortController();
      const confirm = async (
        item: NonNullable<Awaited<ReturnType<CommercialLlmEnforcementMailbox['take']>>>,
      ) => {
        if (!(await mailbox.claimSecondary(item.raw, worker))) throw new CommercialLlmError('BUSY');
        try {
          return await scheduler.classifyWithin(
            item.request.excerpt,
            Date.now() + 20_000,
            controller.signal,
            () => mailbox.owns(item.raw),
            (state) => {
              if (state === 'waiting') waiterStarted();
            },
          );
        } finally {
          await mailbox.releaseSecondary(item.raw, worker);
        }
      };
      const running = confirm(first);
      let waiting: Promise<CommercialLlmObservationResult> | undefined;
      try {
        await started;
        const serverOwner = await redis.get(COMMERCIAL_LLM_LEASE_KEY);
        expect(serverOwner).not.toBeNull();
        const cooldownExpiry = await redis.pexpiretime(COMMERCIAL_LLM_COOLDOWN_KEY);
        expect(await redis.pttl(COMMERCIAL_LLM_COOLDOWN_KEY)).toBeGreaterThan(8_000);
        const second = await activate(offer('same-chat'));
        expect(await mailbox.releasePrimary(second.raw, worker)).toBe(true);
        await expect(confirm(second)).rejects.toMatchObject({ kind: 'BUSY' });
        expect(client.classify).toHaveBeenCalledTimes(1);
        expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(serverOwner);
        expect(await redis.pexpiretime(COMMERCIAL_LLM_COOLDOWN_KEY)).toBe(cooldownExpiry);
        const independent = await activate(offer('independent-chat'));
        expect(await mailbox.releasePrimary(independent.raw, worker)).toBe(true);
        waiting = confirm(independent);
        await waitingStarted;
        expect(client.classify).toHaveBeenCalledTimes(1);
        expect(await redis.hlen(keys.secondary)).toBe(2);
        serverFinish(positive);
        await expect(running).resolves.toEqual(positive);
        expect(await redis.pexpiretime(COMMERCIAL_LLM_COOLDOWN_KEY)).toBe(cooldownExpiry);
        await redis.pexpireat(COMMERCIAL_LLM_COOLDOWN_KEY, Date.now() - 1);
        await expect(waiting).resolves.toEqual(positive);
        expect(client.classify).toHaveBeenCalledTimes(2);
        expect(await redis.pttl(COMMERCIAL_LLM_COOLDOWN_KEY)).toBeGreaterThan(8_000);
        expect(await redis.exists(COMMERCIAL_LLM_LEASE_KEY, keys.secondary)).toBe(0);
        expect(await mailbox.owns(first.raw)).toBe(true);
        expect(await mailbox.owns(second.raw)).toBe(true);
        expect(await mailbox.owns(independent.raw)).toBe(true);
      } finally {
        controller.abort();
        serverFinish(positive);
        await Promise.allSettled(waiting ? [running, waiting] : [running]);
      }
    });
    it('reclaims only obsolete server reservations after a worker generation changes', async () => {
      const previousWorker = worker;
      const previous = await activate(offer('same-chat'));
      expect(await mailbox.releasePrimary(previous.raw, worker)).toBe(true);
      expect(await mailbox.claimSecondary(previous.raw, worker)).toBe(true);
      await redis.del(keys.worker);
      worker = randomUUID();
      const current = await activate(offer('same-chat'));
      expect(await mailbox.releasePrimary(current.raw, worker)).toBe(true);
      expect(await mailbox.claimSecondary(current.raw, worker)).toBe(true);
      expect(await mailbox.releaseSecondary(previous.raw, previousWorker)).toBe(false);
      await mailbox.finish(previous.raw, previousWorker);
      expect(Object.values(await redis.hgetall(keys.secondary))).toEqual([current.raw]);
      expect(await mailbox.owns(current.raw)).toBe(true);
      expect(await mailbox.releaseSecondary(current.raw, worker)).toBe(true);
      expect(await mailbox.owns(current.raw)).toBe(true);
    });
    it('fails closed on an overfull server-reservation hash without deleting its evidence', async () => {
      const item = await activate(offer());
      expect(await mailbox.releasePrimary(item.raw, worker)).toBe(true);
      const unexpected = Object.fromEntries(
        Array.from({ length: COMMERCIAL_LLM_ACTIVE_LIMIT + 1 }, (_, index) => [
          String(index),
          item.raw,
        ]),
      );
      await redis.hset(keys.secondary, unexpected);
      expect(await mailbox.claimSecondary(item.raw, worker)).toBe(false);
      expect(await redis.hgetall(keys.secondary)).toEqual(unexpected);
      expect(await mailbox.owns(item.raw)).toBe(true);
    });
    it('caps active authority at three sources and retains hash-only entry identities', async () => {
      for (let index = 0; index < COMMERCIAL_LLM_ACTIVE_LIMIT; index += 1) {
        await ready();
        expect(await mailbox.offer(offer(`bounded-chat-${index}`))).toBe(true);
        await redis.del(keys.cooldown);
        const item = (await mailbox.take(worker))!;
        expect(item).not.toBeNull();
        expect(await mailbox.releasePrimary(item.raw, worker)).toBe(true);
      }
      expect(await redis.hlen(keys.active)).toBe(COMMERCIAL_LLM_ACTIVE_LIMIT);
      expect((await redis.hkeys(keys.active)).every((field) => /^[a-f0-9]{64}$/u.test(field))).toBe(
        true,
      );
      expect(await mailbox.advertise(worker)).toBe(false);
      expect(await mailbox.offerDetailed(offer('fourth-chat'))).toBe('active_limit');
      expect(await redis.exists(keys.slot)).toBe(0);
    });
    it('records expired and malformed pending work without exposing or renewing its source', async () => {
      const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        await ready();
        const input = offer();
        expect(await mailbox.offer(input)).toBe(true);
        const pending = JSON.parse((await redis.get(keys.slot))!) as { submittedAtMs: number };
        pending.submittedAtMs -= 3_001;
        await redis.set(keys.slot, JSON.stringify(pending), 'PX', 50_000);
        expect(await Promise.all(Array.from({ length: 20 }, () => mailbox.take(worker)))).toEqual(
          Array(20).fill(null),
        );
        expect(await redis.hlen(keys.active)).toBe(0);
        expect(await mailbox.hasProof(input.source)).toBe(false);
        const forgedTrace = randomUUID();
        await redis.set(
          keys.slot,
          JSON.stringify({ excerpt: 'private diagnostic source', source: { nonce: forgedTrace } }),
          'PX',
          5000,
        );
        expect(await mailbox.take(worker)).toBeNull();
        expect(await mailbox.readObservations()).toEqual({
          pending_expired: 1,
          invalid_pending: 1,
        });
        const observations = await redis.hgetall(keys.metrics);
        expect(Object.keys(observations).sort()).toEqual(['invalid_pending', 'pending_expired']);
        expect(JSON.stringify(observations)).not.toContain('private diagnostic source');
        expect(await redis.exists(keys.slot, keys.primary)).toBe(0);
        const terminal = logs.mock.calls.map(([value]) => value);
        expect(terminal).toEqual([
          {
            stage: 'commercial-ai',
            schemaVersion: 2,
            mode: 'ENFORCE',
            outcome: 'pending_expired',
            traceId: input.source.nonce,
            admittedAtMs: pending.submittedAtMs,
            admissionWindowStartAt: new Date(
              Math.floor(pending.submittedAtMs / 60_000) * 60_000,
            ).toISOString(),
          },
          { stage: 'commercial-ai', schemaVersion: 2, mode: 'ENFORCE', outcome: 'invalid_pending' },
        ]);
        expect(JSON.stringify(terminal)).not.toContain(input.source.messageId);
        expect(JSON.stringify(terminal)).not.toContain(forgedTrace);
        expect(JSON.stringify(terminal)).not.toContain('private diagnostic source');
        await mailbox.take(worker);
        expect(logs).toHaveBeenCalledTimes(2);
      } finally {
        logs.mockRestore();
      }
    });
    it('records the successful Redis expiry CAS once when its clock passes the earlier local check', async () => {
      const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      let localClock: jest.SpyInstance | null = null;
      try {
        await ready();
        const input = offer();
        expect(await mailbox.offer(input)).toBe(true);
        const pending = JSON.parse((await redis.get(keys.slot))!) as { submittedAtMs: number };
        pending.submittedAtMs -= 3_001;
        await redis.set(keys.slot, JSON.stringify(pending), 'PX', 50_000);
        localClock = jest.spyOn(Date, 'now').mockReturnValue(pending.submittedAtMs);
        expect(await Promise.all([mailbox.take(worker), mailbox.take(worker)])).toEqual([
          null,
          null,
        ]);
        expect(await mailbox.readObservations()).toEqual({ pending_expired: 1 });
        expect(logs).toHaveBeenCalledTimes(1);
        expect(logs.mock.calls[0]![0]).toMatchObject({
          stage: 'commercial-ai',
          outcome: 'pending_expired',
          traceId: input.source.nonce,
          admittedAtMs: pending.submittedAtMs,
        });
        expect(await redis.hlen(keys.active)).toBe(0);
        expect(await redis.exists(keys.slot, keys.primary)).toBe(0);
      } finally {
        localClock?.mockRestore();
        logs.mockRestore();
      }
    });
    it('keeps issued v1 proofs while binding new proofs to their exact active source', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      expect(commercialLlmProofKey(input.source)).toMatch(/^commercial-llm-enforcement:v1:proof:/u);
      expect(keys.slot).toMatch(/^commercial-llm-enforcement:v3:/u);
      await redis.set(
        commercialLlmProofKey(input.source),
        JSON.stringify(input.source),
        'PX',
        5000,
      );
      expect(await mailbox.hasProof(input.source)).toBe(true);
      await redis.del(commercialLlmProofKey(input.source));
      expect(await mailbox.offer(input)).toBe(true);
      const item = (await mailbox.take(worker))!;
      const foreignSource = offer('foreign-chat').source;
      expect(await mailbox.prove(item.raw, foreignSource)).toBe(false);
      expect(await mailbox.prove(item.raw, input.source)).toBe(true);
      expect(await redis.pttl(commercialLlmProofKey(input.source))).toBeLessThanOrEqual(
        input.source.deadlineAtMs - Date.now() + 100,
      );
      expect(await mailbox.owns('invalid json')).toBe(false);
      await expect(mailbox.finish('invalid json')).resolves.toBeUndefined();
    });
    it.each([false, true])(
      'keeps a primary negative while server capacity is occupied (audit=%s)',
      async (audit) => {
        const serverOwner = randomUUID();
        await redis.set(COMMERCIAL_LLM_LEASE_KEY, serverOwner, 'PX', 120_000);
        await redis.set(COMMERCIAL_LLM_COOLDOWN_KEY, '1', 'PX', 10_000);
        const classifySecondary = jest.fn<
          ReturnType<CommercialLlmClassifier['classify']>,
          Parameters<CommercialLlmClassifier['classify']>
        >();
        const secondary = new CommercialLlmBudgetedSecondary(
          new CommercialLlmShadowLease(redis),
          httpClient({
            classify: classifySecondary,
          }),
        );
        const cascade = new CommercialLlmCascadeClient(
          {
            classify: async () => ({
              outcome: 'COMPLETE',
              result: {
                ...positive,
                ...COMMERCIAL_LLM_WORKSTATION_IDENTITY,
                classification: 'NOT_COMMERCIAL',
                reasonCodes: ['ORDINARY_DISCUSSION'],
              },
            }),
          },
          secondary,
          async () => true,
          () => audit,
        );
        await ready();
        expect(await mailbox.offer(offer())).toBe(true);
        const h = processor(cascade.classify.bind(cascade));
        expect(await h.process.run(worker, new AbortController().signal)).toMatchObject({
          outcome: 'kept',
          route: 'primary',
          classification: 'NOT_COMMERCIAL',
          ...(audit ? { auditOutcome: 'capacity_skipped' } : {}),
        });
        expect(classifySecondary).not.toHaveBeenCalled();
        expect(h.ensureIntent).not.toHaveBeenCalled();
        expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(serverOwner);
        expect(await redis.exists(keys.slot)).toBe(0);
        expect(await redis.pttl(keys.cooldown)).toBeGreaterThan(1_000);
        expect(await mailbox.advertise(worker)).toBe(true);
      },
    );
    it('skips a positive without waiting or authorizing deletion when server capacity is occupied', async () => {
      const serverOwner = randomUUID();
      await redis.set(COMMERCIAL_LLM_LEASE_KEY, serverOwner, 'PX', 120_000);
      const classifySecondary = jest.fn<
        ReturnType<CommercialLlmClassifier['classify']>,
        Parameters<CommercialLlmClassifier['classify']>
      >();
      const cascade = new CommercialLlmCascadeClient(
        { classify: async () => ({ outcome: 'COMPLETE', result: positive }) },
        new CommercialLlmBudgetedSecondary(
          new CommercialLlmShadowLease(redis),
          httpClient({
            classify: classifySecondary,
          }),
        ),
        async () => true,
        () => false,
      );
      await ready();
      const input = offer();
      expect(await mailbox.offer(input)).toBe(true);
      const h = processor(cascade.classify.bind(cascade));
      expect(await h.process.run(worker, new AbortController().signal)).toMatchObject({
        outcome: 'secondary_capacity_skipped',
        failureKind: 'BUSY',
      });
      expect(classifySecondary).not.toHaveBeenCalled();
      expect(h.ensureIntent).not.toHaveBeenCalled();
      expect(await mailbox.hasProof(input.source)).toBe(false);
      expect(await redis.exists(keys.slot)).toBe(0);
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(serverOwner);
    });
    it('retains the cooldown after success and persistently fences a dispatched unknown failure', async () => {
      const classify = jest
        .fn<
          ReturnType<CommercialLlmClassifier['classify']>,
          Parameters<CommercialLlmClassifier['classify']>
        >()
        .mockResolvedValue(positive);
      const secondary = new CommercialLlmBudgetedSecondary(
        new CommercialLlmShadowLease(redis),
        httpClient({
          classify,
        }),
      );
      await expect(secondary.classify(text)).resolves.toBe(positive);
      expect(await redis.exists(COMMERCIAL_LLM_LEASE_KEY)).toBe(0);
      expect(await redis.pttl(COMMERCIAL_LLM_COOLDOWN_KEY)).toBeGreaterThan(9_000);
      await expect(secondary.classify(text)).rejects.toMatchObject({ kind: 'BUSY' });
      expect(classify).toHaveBeenCalledTimes(1);
      await redis.del(COMMERCIAL_LLM_COOLDOWN_KEY);
      classify.mockImplementationOnce(async () => {
        throw new Error('offline');
      });
      await expect(secondary.classify(text)).rejects.toThrow('offline');
      expect(await redis.pttl(COMMERCIAL_LLM_LEASE_KEY)).toBe(-1);
      await redis.del(COMMERCIAL_LLM_COOLDOWN_KEY);
      await expect(secondary.classify(text)).rejects.toMatchObject({ kind: 'BUSY' });
      expect(classify).toHaveBeenCalledTimes(2);
    });
    it('rejects a result after source revocation or lease replacement, preserving a successor', async () => {
      const successor = randomUUID();
      const secondary = new CommercialLlmBudgetedSecondary(
        new CommercialLlmShadowLease(redis),
        httpClient({
          classify: async () => {
            await redis.set(COMMERCIAL_LLM_LEASE_KEY, successor, 'PX', 120_000);
            return positive;
          },
        }),
      );
      await expect(secondary.classify(text)).rejects.toMatchObject({ kind: 'ABORTED' });
      expect(await redis.get(COMMERCIAL_LLM_LEASE_KEY)).toBe(successor);
      await redis.del(COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY);
      let current = true;
      const revoked = new CommercialLlmBudgetedSecondary(
        new CommercialLlmShadowLease(redis),
        httpClient({
          classify: async () => {
            current = false;
            return positive;
          },
        }),
      );
      await expect(revoked.classify(text, undefined, async () => current)).rejects.toMatchObject({
        kind: 'ABORTED',
      });
      expect(await redis.exists(COMMERCIAL_LLM_LEASE_KEY)).toBe(0);
    });
    it('server confirmation registers exactly one bound delete; no model work is retried', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      expect(await mailbox.offer(input)).toBe(true);
      const h = processor();
      expect(await h.process.run(worker, new AbortController().signal)).toMatchObject({
        outcome: 'delete_registered',
      });
      expect(h.ensureIntent).toHaveBeenCalledTimes(1);
      expect(h.ensureIntent.mock.calls[0]![0]).toMatchObject({
        ruleCode: COMMERCIAL_LLM_DELETE_RULE_CODE,
        chatId: input.source.chatId,
        messageId: input.source.messageId,
        retryUntilAt: new Date(input.source.deadlineAtMs),
        event: { metadata: { commercialLlmSource: input.source } },
      });
      expect(await mailbox.hasProof(input.source)).toBe(true);
      expect(await redis.exists(keys.slot)).toBe(0);
      await h.process.run(worker, new AbortController().signal);
      expect(h.ensureIntent).toHaveBeenCalledTimes(1);
    });
    it.each([
      'negative',
      'unsure',
      'failure',
      'pressure',
      'aborted',
      'wrong-model',
      'disagreement',
    ])('%s leaves the message and frees the slot', async (mode) => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      await mailbox.offer(input);
      const controller = new AbortController();
      if (mode === 'aborted') controller.abort();
      const h = processor(
        async () => {
          if (mode === 'failure') throw new Error('synthetic failure');
          if (mode === 'negative')
            return {
              ...positive,
              classification: 'NOT_COMMERCIAL',
              reasonCodes: ['PERSONAL_SALE'],
            };
          if (mode === 'unsure')
            return { ...positive, classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] };
          if (mode === 'wrong-model') return { ...positive, modelSha256: '0'.repeat(64) };
          if (mode === 'disagreement')
            return {
              ...positive,
              cascade: { ...positive.cascade!, primaryClassification: 'NOT_COMMERCIAL' },
            };
          return positive;
        },
        async () => mode !== 'pressure',
      );
      await h.process.run(worker, controller.signal);
      expect(h.ensureIntent).not.toHaveBeenCalled();
      expect(await mailbox.hasProof(input.source)).toBe(false);
      expect(await redis.exists(keys.slot)).toBe(0);
    });
    it('lost ownership and a late old answer cannot authorize a new request', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      await mailbox.offer(input);
      const h = processor(async () => {
        await redis.set(keys.worker, randomUUID(), 'PX', 5000);
        return positive;
      });
      expect(await h.process.run(worker, new AbortController().signal)).toMatchObject({
        outcome: 'source_expired',
      });
      expect(h.ensureIntent).not.toHaveBeenCalled();
      expect(await mailbox.hasProof(input.source)).toBe(false);
    });
    it('obsolete workers cannot prove or clean active authority and retain an unfinished primary fence', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      expect(await mailbox.offer(input)).toBe(true);
      const old = (await mailbox.take(worker))!;
      const previousWorker = worker;
      worker = randomUUID();
      await redis.set(keys.worker, worker, 'PX', 5000);
      expect(await mailbox.owns(old.raw)).toBe(false);
      expect(await mailbox.prove(old.raw, input.source)).toBe(false);
      expect(await mailbox.releasePrimary(old.raw, previousWorker)).toBe(false);
      await mailbox.finish(old.raw, previousWorker);
      expect(await redis.get(keys.primary)).toBe(old.raw);
      await ready();
      expect(await mailbox.offer(offer('successor-chat'))).toBe(true);
      const pending = await redis.get(keys.slot);
      expect(await mailbox.take(worker)).toBeNull();
      expect(await redis.get(keys.slot)).toBe(pending);
      const successor = JSON.stringify({
        ...offer('later-chat'),
        worker,
        submittedAtMs: Date.now(),
      });
      const successorKey = createHash('sha256').update(successor).digest('hex');
      await redis.hset(keys.active, successorKey, successor);
      await redis.set(keys.primary, successor, 'PX', 5000);
      await mailbox.finish(old.raw, previousWorker);
      expect(await redis.get(keys.primary)).toBe(successor);
      expect(await mailbox.owns(successor)).toBe(true);
    });
    it('a reader that loses ownership cannot discard or promote successor pending slots', async () => {
      await ready();
      const successor = randomUUID();
      const input = offer();
      const raw = JSON.stringify({ ...input, worker: successor, submittedAtMs: Date.now() });
      const tail = JSON.stringify({
        ...offer('successor-tail'),
        worker: successor,
        submittedAtMs: Date.now(),
      });
      const owns = jest.spyOn(mailbox, 'ownsWorker').mockImplementationOnce(async () => {
        await redis.set(keys.worker, successor, 'PX', 5000);
        await redis.set(keys.slot, raw, 'PX', 5000);
        await redis.set(nextPendingKey, tail, 'PX', 5000);
        return true;
      });
      try {
        expect(await mailbox.take(worker)).toBeNull();
      } finally {
        owns.mockRestore();
      }
      expect(await redis.get(keys.slot)).toBe(raw);
      expect(await redis.get(nextPendingKey)).toBe(tail);
      expect(await mailbox.take(successor)).toMatchObject({ raw });
      expect(await redis.get(keys.slot)).toBe(tail);
      expect(await redis.exists(nextPendingKey)).toBe(0);
    });
    it('late admission preserves readiness and does not renew an old event', async () => {
      await ready();
      const input = offer();
      input.source.eventAtMs -= 11_000;
      input.source.origin.sourceEventAtMs -= 11_000;
      input.source.deadlineAtMs -= 11_000;
      expect(await mailbox.offerDetailed(input)).toBe('source_stale');
      expect(await redis.get(keys.ready)).toBe(worker);
      expect(await redis.exists(keys.slot)).toBe(0);
    });
    it('a new worker discards an unstarted stale slot instead of replaying it', async () => {
      const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        await ready();
        const input = offer();
        await mailbox.offer(input);
        await redis.del(keys.worker);
        worker = randomUUID();
        expect(await mailbox.heartbeat(worker)).toBe(true);
        const h = processor();
        await h.process.run(worker, new AbortController().signal);
        expect(h.ensureIntent).not.toHaveBeenCalled();
        expect(await redis.exists(keys.slot)).toBe(0);
        expect(await mailbox.readObservations()).toEqual({ foreign_worker: 1 });
        expect(logs).toHaveBeenCalledTimes(1);
        expect(logs.mock.calls[0]![0]).toMatchObject({
          stage: 'commercial-ai',
          outcome: 'foreign_worker',
          traceId: input.source.nonce,
        });
      } finally {
        logs.mockRestore();
      }
    });
    it('an expired inference source has no proof or delete even if the model returns positive', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      await mailbox.offer(input);
      const h = processor(async () => {
        await redis.del(keys.active);
        return positive;
      });
      await h.process.run(worker, new AbortController().signal);
      expect(h.ensureIntent).not.toHaveBeenCalled();
      expect(await mailbox.hasProof(input.source)).toBe(false);
    });
    it('rechecks actual source, settings and immunity against the real stored proof', async () => {
      await ready();
      const input = offer();
      proofs.push(commercialLlmProofKey(input.source));
      await mailbox.offer(input);
      await processor().process.run(worker, new AbortController().signal);
      let currentText = text;
      let enabled = true;
      let immune = false;
      const currentSettings = {
        ...settings,
        chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
      };
      const max = {
        getChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ userId: 'user', isAdmin: false, isOwner: false }),
        getExactMessageRow: jest.fn().mockImplementation(async () => ({
          body: { mid: input.source.messageId, text: currentText },
          sender: { user_id: 'user' },
          recipient: { chat_id: 'chat', chat_type: 'chat' },
          timestamp: Date.now(),
        })),
      };
      const guard = new CommercialLlmDeleteGuardService(
        {
          chatSettings: { findUnique: jest.fn().mockImplementation(async () => currentSettings) },
        } as never,
        max as never,
        { isKnownBotUserId: () => false } as never,
        { consumeForMessage: async () => (immune ? 'granted' : 'not_granted') } as never,
        new ConfigService({}),
        {
          enabled: () => enabled,
          hasProof: (source: CommercialLlmSource) => mailbox.hasProof(source),
        } as never,
      );
      const params = {
        chatId: 'chat',
        messageId: input.source.messageId,
        subjectUserId: 'user',
        botId: 'bot',
        reasons: [
          {
            ruleCode: COMMERCIAL_LLM_DELETE_RULE_CODE,
            reasonKey: `${COMMERCIAL_LLM_DELETE_RULE_CODE}:${commercialLlmSourceKey(input.source)}`,
            metadata: { commercialLlmSource: input.source },
          },
        ],
      };
      await expect(guard.authorize(params)).resolves.toMatchObject({
        deadlineAtMs: input.source.deadlineAtMs,
      });
      for (const change of [
        () => {
          currentText = 'Обычный разговор';
        },
        () => {
          currentText = text;
          enabled = false;
        },
        () => {
          enabled = true;
          immune = true;
        },
        () => {
          immune = false;
          currentSettings.commercialAdsFilterEnabled = false;
        },
      ]) {
        change();
        await expect(guard.authorize(params)).rejects.toMatchObject({
          code: 'commercial_ai_delete_no_longer_authorized',
        });
      }
      currentSettings.commercialAdsFilterEnabled = true;
      max.getExactMessageRow.mockImplementation(async () => {
        currentSettings.textFiltersBanEnabled = false;
        return {
          body: { mid: input.source.messageId, text },
          sender: { user_id: 'user' },
          recipient: { chat_id: 'chat', chat_type: 'chat' },
          timestamp: Date.now(),
        };
      });
      await expect(guard.authorize(params)).rejects.toMatchObject({
        code: 'commercial_ai_delete_no_longer_authorized',
      });
    });
  },
);

describe('commercial AI source/protocol admission', () => {
  it('accepts only a fresh complete enabled source', () => {
    const now = Date.now();
    const input = {
      chatId: 'c',
      messageId: 'm',
      userId: 'u',
      originBotId: 'b',
      text,
      eventAt: new Date(now).toISOString(),
      origin: origin(now, 'b'),
      settings,
    };
    expect(buildCommercialLlmOffer(input)).not.toBeNull();
    expect(buildCommercialLlmOffer({ ...input, text: 'x'.repeat(2501) })).toBeNull();
    expect(
      buildCommercialLlmOffer({ ...input, eventAt: new Date(Date.now() - 11_000).toISOString() }),
    ).toBeNull();
    expect(buildCommercialLlmOffer({ ...input, originBotId: undefined })).toBeNull();
    expect(
      buildCommercialLlmOffer({
        ...input,
        settings: { ...settings, commercialAdsFilterEnabled: false },
      }),
    ).toBeNull();
  });
  it('does not admit mismatched origin or attribute another rule, target or settled child', async () => {
    const input = offer();
    expect(
      buildCommercialLlmOffer({
        chatId: 'chat',
        messageId: 'm',
        userId: 'user',
        originBotId: 'wrong',
        text,
        eventAt: new Date(input.source.eventAtMs).toISOString(),
        settings,
        origin: input.source.origin,
      }),
    ).toBeNull();
    let after!: () => ReturnType<typeof readCommercialLlmEffectOrigin>;
    await withCommercialLlmEffectOrigin(
      input.source,
      async () => true,
      async () => {
        expect(
          readCommercialLlmEffectOrigin(
            input.source.chatId,
            input.source.messageId,
            COMMERCIAL_LLM_DELETE_RULE_CODE,
          )?.sourceWebhookEventId,
        ).toBe(input.source.origin.sourceWebhookEventId);
        expect(
          readCommercialLlmEffectOrigin(
            input.source.chatId,
            input.source.messageId,
            'COMMERCIAL_AD_DELETE',
          ),
        ).toBeNull();
        expect(
          readCommercialLlmEffectOrigin(
            'another',
            input.source.messageId,
            COMMERCIAL_LLM_DELETE_RULE_CODE,
          ),
        ).toBeNull();
        // Async resource captures the actual child context and runs after its settlement.
        const resource = new (await import('node:async_hooks')).AsyncResource('late-ai-child');
        after = () =>
          resource.runInAsyncScope(() =>
            readCommercialLlmEffectOrigin(
              input.source.chatId,
              input.source.messageId,
              COMMERCIAL_LLM_DELETE_RULE_CODE,
            ),
          );
      },
    );
    expect(after()).toBeNull();
    await expect(
      withCommercialLlmEffectOrigin(
        input.source,
        async () => false,
        async () => undefined,
      ),
    ).rejects.toThrow();
  });
  it('captures only active canonical authority and returns without awaiting admission', async () => {
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    let release!: (outcome: CommercialLlmAdmissionResult) => void;
    const admission = new Promise<CommercialLlmAdmissionResult>((resolve) => {
      release = resolve;
    });
    const submit = jest
      .fn<
        ReturnType<CommercialLlmEnforcementMailbox['offerDetailed']>,
        Parameters<CommercialLlmEnforcementMailbox['offerDetailed']>
      >()
      .mockReturnValue(admission);
    const mailboxDouble: Pick<CommercialLlmEnforcementMailbox, 'offerDetailed'> = {
      offerDetailed: submit,
    };
    jest
      .spyOn(service, 'mailbox')
      .mockResolvedValue(mailboxDouble as CommercialLlmEnforcementMailbox);
    const now = Date.now();
    const input = {
      chatId: 'chat',
      messageId: 'message',
      userId: 'user',
      originBotId: 'bot',
      text,
      eventAt: new Date(now).toISOString(),
      settings,
    };
    service.offer(input);
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
    await withCanonicalWebhookOrigin(
      {
        webhookEvent: { id: 'receipt', botId: 'bot' },
        activeBotId: 'executor',
        update: {
          updateId: 'u',
          botId: 'bot',
          type: 'message_created',
          eventTimestampSource: 'payload',
          raw: { timestamp: now },
          message: {
            chatId: 'chat',
            messageId: 'message',
            senderId: 'user',
            text,
            createdAt: new Date(now).toISOString(),
          },
        },
      },
      async () => {
        service.offer(input);
        service.offer(input);
      },
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0].source).toMatchObject({
      originBotId: 'executor',
      origin: { sourceWebhookEventId: 'receipt' },
    });
    release('not_ready');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const violations = [
      { ruleCode: 'LINK_BLOCKED' },
      { ruleCode: 'COMMERCIAL_AD' },
      { ruleCode: 'PROFANITY' },
    ] as never;
    expect(routeCommercialAiViolations(violations, true).map((v) => v.ruleCode)).toEqual([
      'LINK_BLOCKED',
      'PROFANITY',
    ]);
    service.onModuleDestroy();
  });
  it('neither primary-only positives nor changed protocol identities grant delete authority', () => {
    expect(commercialLlmMayDelete(positive)).toBe(true);
    expect(
      commercialLlmMayDelete({ ...positive, cascade: { ...positive.cascade!, route: 'primary' } }),
    ).toBe(false);
    expect(commercialLlmMayDelete({ ...positive, promptSha256: '0'.repeat(64) })).toBe(false);
  });
});
