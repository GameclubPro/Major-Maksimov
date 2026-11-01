import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import {
  CommercialLlmPoolAdmissionMailbox,
  COMMERCIAL_LLM_POOL_ADMISSION_KEYS as keys,
  COMMERCIAL_LLM_POOL_ACTIVE_LIMIT,
  COMMERCIAL_LLM_POOL_PENDING_ACCOUNTING_KEYS as accountingKeys,
} from './commercial-llm-pool-admission.mailbox';
import {
  CommercialLlmEnforcementMailbox,
  COMMERCIAL_LLM_ENFORCEMENT_KEYS as legacyKeys,
  commercialLlmProofKey,
} from './commercial-llm-enforcement.mailbox';
import {
  buildCommercialLlmOffer,
  COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
  COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
  type CommercialLlmRequest,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';

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
const text = 'Мастерская принимает заказы на ремонт мебели. Работаем по договору.';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const shiftedSource = (source: CommercialLlmSource, eventAtMs: number): CommercialLlmSource => ({
  ...source,
  eventAtMs,
  deadlineAtMs: eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
  origin: { ...source.origin, sourceEventAtMs: eventAtMs },
});
const url = process.env.MAXIM_TEST_REDIS_URL ?? '';

(url ? describe : describe.skip)('three-node admission ownership on disposable real Redis', () => {
  let redis: Redis;
  let mailbox: CommercialLlmPoolAdmissionMailbox;
  let worker: string;
  const proofKeys = new Set<string>();
  const remember = (source: CommercialLlmSource) => {
    proofKeys.add(commercialLlmProofKey(source));
    return source;
  };
  const offer = (chatId: string = randomUUID(), messageId: string = randomUUID()) => {
    const now = Date.now();
    const value = buildCommercialLlmOffer(
      {
        chatId,
        messageId,
        userId: 'synthetic-user',
        originBotId: 'synthetic-bot',
        text,
        eventAt: new Date(now).toISOString(),
        origin: {
          sourceWebhookEventId: randomUUID(),
          sourceReceivingBotId: 'synthetic-bot',
          sourceExecutionBotId: 'synthetic-bot',
          sourceEventAtMs: now,
          sourceEvidenceVersion: 1,
        },
        settings,
      },
      now,
      'confirm-positive',
    );
    if (!value) throw new Error('Synthetic pool offer was not created');
    remember(value.source);
    return value;
  };
  const ready = async (owner = worker) => {
    expect(await mailbox.heartbeat(owner)).toBe(true);
    expect(await mailbox.advertise(owner)).toBe(true);
  };
  const activate = async (input = offer()) => {
    await ready();
    expect(await mailbox.offerDetailed(input)).toBe('accepted');
    const taken = await mailbox.take(worker);
    if (!taken) throw new Error('Expected source admission');
    return taken;
  };
  const activeValues = async () => Object.values(await redis.hgetall(keys.active));

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Disposable loopback Redis required');
    redis = createCommercialLlmRedis(url);
    await redis.connect();
    mailbox = new CommercialLlmPoolAdmissionMailbox(redis);
  });
  beforeEach(async () => {
    await redis.del(
      ...Object.values(keys),
      ...Object.values(accountingKeys),
      ...Object.values(legacyKeys),
      ...proofKeys,
    );
    proofKeys.clear();
    worker = randomUUID();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await redis.del(
      ...Object.values(keys),
      ...Object.values(accountingKeys),
      ...Object.values(legacyKeys),
      ...proofKeys,
    );
    redis.disconnect();
  });

  it('uses separate pool admission keys while preserving compatible exact-source proof keys', async () => {
    const previous = new Set<string>(Object.values(legacyKeys));
    expect(Object.values(keys).some((key) => previous.has(key))).toBe(false);
    const legacy = new CommercialLlmEnforcementMailbox(redis);
    const legacyWorker = randomUUID();
    expect(await legacy.heartbeat(legacyWorker)).toBe(true);
    await ready();
    expect(await redis.get(legacyKeys.worker)).toBe(legacyWorker);
    expect(await redis.get(keys.worker)).toBe(worker);
    expect(await mailbox.offerDetailed(offer())).toBe('accepted');
    expect(await redis.exists(legacyKeys.slot, legacyKeys.slotNext)).toBe(0);
  });

  it('admits three independent active primaries and exactly two pending burst inputs', async () => {
    const first = await activate(offer('active-a'));
    const second = await activate(offer('active-b'));
    const third = await activate(offer('active-c'));
    expect(await redis.hlen(keys.active)).toBe(COMMERCIAL_LLM_POOL_ACTIVE_LIMIT);
    expect(await redis.hlen(keys.primary)).toBe(3);
    await ready();
    const burst = Array.from({ length: 30 }, (_, index) => offer(`burst-${index}`));
    const results = await Promise.all(burst.map((value) => mailbox.offerDetailed(value)));
    expect(results.filter((result) => result === 'accepted')).toHaveLength(2);
    expect(results.filter((result) => result === 'buffer_full')).toHaveLength(28);
    const headRaw = (await redis.get(keys.slot))!;
    const tailRaw = (await redis.get(keys.slotNext))!;
    const headExpiry = await redis.pexpiretime(keys.slot);
    const tailExpiry = await redis.pexpiretime(keys.slotNext);
    const headMetadata = JSON.parse((await redis.get(accountingKeys.slot))!);
    const tailMetadata = JSON.parse((await redis.get(accountingKeys.slotNext))!);
    expect(headMetadata).toEqual({
      version: 1,
      worker,
      rawSha1: createHash('sha1').update(headRaw).digest('hex'),
      expiresAtMs: headExpiry,
    });
    expect(tailMetadata.expiresAtMs).toBe(tailExpiry);
    expect(await redis.pttl(accountingKeys.slot)).toBe(-1);
    expect(await redis.pttl(accountingKeys.slotNext)).toBe(-1);
    expect(headExpiry).toBe(JSON.parse(headRaw).submittedAtMs + COMMERCIAL_LLM_PENDING_MAX_AGE_MS);
    expect(tailExpiry).toBe(JSON.parse(tailRaw).submittedAtMs + COMMERCIAL_LLM_PENDING_MAX_AGE_MS);
    await mailbox.advertise(worker);
    expect(await mailbox.offerDetailed(offer('overflow-after-heartbeat'))).toBe('buffer_full');
    expect(
      (await Promise.all(Array.from({ length: 12 }, () => mailbox.take(worker)))).every(
        (x) => x === null,
      ),
    ).toBe(true);
    expect(await redis.get(keys.slot)).toBe(headRaw);
    expect(await redis.get(keys.slotNext)).toBe(tailRaw);
    expect(await redis.pexpiretime(keys.slot)).toBe(headExpiry);
    expect(await redis.pexpiretime(keys.slotNext)).toBe(tailExpiry);
    expect(new Set(await activeValues())).toEqual(new Set([first.raw, second.raw, third.raw]));
  });

  it('promotes FIFO without renewing a tail and does not let later arrivals overtake it', async () => {
    const active = [
      await activate(offer('a')),
      await activate(offer('b')),
      await activate(offer('c')),
    ];
    await ready();
    expect(await mailbox.offerDetailed(offer('head'))).toBe('accepted');
    expect(await mailbox.offerDetailed(offer('tail'))).toBe('accepted');
    const headRaw = (await redis.get(keys.slot))!;
    const tailRaw = (await redis.get(keys.slotNext))!;
    const tailExpiry = await redis.pexpiretime(keys.slotNext);
    await mailbox.finish(active[0].raw, worker);
    const first = await mailbox.take(worker);
    expect(first?.raw).toBe(headRaw);
    expect(await redis.get(keys.slot)).toBe(tailRaw);
    expect(await redis.exists(keys.slotNext)).toBe(0);
    expect(await redis.pexpiretime(keys.slot)).toBe(tailExpiry);
    await ready();
    const later = offer('later');
    expect(await mailbox.offerDetailed(later)).toBe('accepted');
    const laterRaw = (await redis.get(keys.slotNext))!;
    await mailbox.finish(active[1].raw, worker);
    expect((await mailbox.take(worker))?.raw).toBe(tailRaw);
    expect(await redis.get(keys.slot)).toBe(laterRaw);
    expect(await redis.hlen(keys.active)).toBe(3);
    expect(await mailbox.owns(active[2].raw)).toBe(true);
  });

  it('concurrent takes accept one exact head once and leave the successor eligible', async () => {
    await ready();
    const head = offer('head'),
      tail = offer('tail');
    expect(await mailbox.offerDetailed(head)).toBe('accepted');
    expect(await mailbox.offerDetailed(tail)).toBe('accepted');
    const headRaw = (await redis.get(keys.slot))!;
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => mailbox.take(worker)));
    const accepted = outcomes.filter((value): value is NonNullable<typeof value> => value !== null);
    expect(accepted.filter((value) => value.raw === headRaw)).toHaveLength(1);
    expect(new Set(accepted.map((value) => value.raw)).size).toBe(accepted.length);
    expect(accepted.length).toBeLessThanOrEqual(2);
    while (await mailbox.take(worker)) {
      /* Drain only the finite pending pair. */
    }
    expect(await redis.hlen(keys.active)).toBe(2);
    expect(await redis.exists(keys.slot, keys.slotNext)).toBe(0);
  });

  it('releases only the primary role while retaining source ownership through consultation', async () => {
    const first = await activate(offer('same-chat'));
    expect(await mailbox.offerDetailed(offer('same-chat'))).toBe('chat_busy');
    expect(await mailbox.claimSecondary(first.raw, worker)).toBe(false);
    expect(await mailbox.releasePrimary(first.raw, worker)).toBe(true);
    expect(await mailbox.releasePrimary(first.raw, worker)).toBe(false);
    expect(await mailbox.owns(first.raw)).toBe(true);
    expect(await mailbox.claimSecondary(first.raw, worker)).toBe(true);
    const second = await activate(offer('same-chat'));
    expect(await redis.hget(keys.primary, digest('same-chat'))).toBe(second.raw);
    expect(await redis.hget(keys.secondary, digest('same-chat'))).toBe(first.raw);
    expect(await mailbox.offerDetailed(offer('same-chat'))).toBe('chat_busy');
    await mailbox.finish(first.raw, worker);
    expect(await mailbox.owns(first.raw)).toBe(false);
    expect(await mailbox.owns(second.raw)).toBe(true);
    expect(await redis.hget(keys.primary, digest('same-chat'))).toBe(second.raw);
    expect(await redis.hexists(keys.secondary, digest('same-chat'))).toBe(0);
  });

  it('caps a chat at two active sources and one consultation while other chats progress', async () => {
    const first = await activate(offer('same-chat'));
    await mailbox.releasePrimary(first.raw, worker);
    expect(await mailbox.claimSecondary(first.raw, worker)).toBe(true);
    const second = await activate(offer('same-chat'));
    expect(await mailbox.releasePrimary(second.raw, worker)).toBe(true);
    expect(await mailbox.claimSecondary(second.raw, worker)).toBe(false);
    expect(await mailbox.offerDetailed(offer('same-chat'))).toBe('chat_busy');
    const independent = await activate(offer('independent-chat'));
    expect(await mailbox.owns(independent.raw)).toBe(true);
    expect(await redis.hlen(keys.active)).toBe(3);
    expect(await mailbox.releaseSecondary(first.raw, randomUUID())).toBe(false);
    expect(await mailbox.releaseSecondary(first.raw, worker)).toBe(true);
    expect(await mailbox.owns(first.raw)).toBe(true);
    expect(await mailbox.claimSecondary(second.raw, worker)).toBe(true);
    await mailbox.finish(first.raw, worker);
    expect(await redis.hget(keys.secondary, digest('same-chat'))).toBe(second.raw);
  });

  it('rejects same-message nonce changes both pending and active after primary release', async () => {
    await ready();
    const input = offer('dedupe-chat', 'one-message');
    expect(await mailbox.offerDetailed(input)).toBe('accepted');
    const altered = { ...input, source: remember({ ...input.source, nonce: randomUUID() }) };
    expect(await mailbox.offerDetailed(altered)).toBe('chat_busy');
    const active = (await mailbox.take(worker))!;
    expect(await mailbox.releasePrimary(active.raw, worker)).toBe(true);
    expect(await mailbox.offerDetailed(altered)).toBe('chat_busy');
    expect(await mailbox.offerDetailed(offer('dedupe-chat', 'different-message'))).toBe('accepted');
    expect(await mailbox.owns(active.raw)).toBe(true);
  });

  it('withdraws readiness and fences a stale advertised worker before publishing input', async () => {
    expect(await mailbox.offerDetailed(offer())).toBe('not_ready');
    await ready();
    const head = offer('preserved-head');
    expect(await mailbox.offerDetailed(head)).toBe('accepted');
    const raw = await redis.get(keys.slot);
    await mailbox.withdraw(worker);
    expect(await mailbox.offerDetailed(offer())).toBe('not_ready');
    expect(await redis.get(keys.slot)).toBe(raw);
    await redis.set(keys.ready, randomUUID(), 'PX', 2000);
    expect(await mailbox.offerDetailed(offer())).toBe('worker_changed');
    expect(await redis.get(keys.slot)).toBe(raw);
    expect(await redis.exists(keys.slotNext)).toBe(0);
  });

  it('new worker cannot adopt old pending or active authority and stale cleanup cannot touch its successor', async () => {
    const old = await activate(offer('old-active'));
    const oldWorker = worker;
    await mailbox.releasePrimary(old.raw, worker);
    expect(await mailbox.claimSecondary(old.raw, worker)).toBe(true);
    expect(await mailbox.offerDetailed(offer('old-pending'))).toBe('accepted');
    await redis.pexpire(keys.worker, 1);
    await pause(10);
    worker = randomUUID();
    await ready();
    expect(await mailbox.owns(old.raw)).toBe(false);
    expect(await mailbox.prove(old.raw, old.request.source)).toBe(false);
    expect(await mailbox.take(worker)).toBeNull();
    expect(await mailbox.readObservations()).toMatchObject({ foreign_worker: 1 });
    expect(await redis.exists(accountingKeys.slot, accountingKeys.slotNext)).toBe(0);
    const successor = await activate(offer('old-active'));
    await mailbox.withdraw(oldWorker);
    await mailbox.finish(old.raw, oldWorker);
    expect(await mailbox.releasePrimary(old.raw, oldWorker)).toBe(false);
    expect(await mailbox.claimSecondary(old.raw, oldWorker)).toBe(false);
    expect(await mailbox.releaseSecondary(old.raw, oldWorker)).toBe(false);
    expect(await mailbox.take(oldWorker)).toBeNull();
    expect(await redis.get(keys.ready)).toBe(worker);
    expect(await mailbox.owns(successor.raw)).toBe(true);
    expect(await redis.hget(keys.primary, digest('old-active'))).toBe(successor.raw);
  });

  it('discards stale or malformed head by exact CAS and preserves the tail deadline', async () => {
    await ready();
    expect(await mailbox.offerDetailed(offer('head'))).toBe('accepted');
    expect(await mailbox.offerDetailed(offer('tail'))).toBe('accepted');
    const head = JSON.parse((await redis.get(keys.slot))!) as CommercialLlmRequest;
    const tailRaw = (await redis.get(keys.slotNext))!;
    const tailExpiry = await redis.pexpiretime(keys.slotNext);
    await redis.set(
      keys.slot,
      JSON.stringify({ ...head, submittedAtMs: Date.now() - 3001 }),
      'KEEPTTL',
    );
    expect(await mailbox.take(worker)).toBeNull();
    expect(await redis.get(keys.slot)).toBe(tailRaw);
    expect(await redis.pexpiretime(keys.slot)).toBe(tailExpiry);
    expect(await mailbox.readObservations()).toMatchObject({ pending_expired: 1 });
    await redis.set(keys.slot, '{malformed', 'KEEPTTL');
    expect(await mailbox.take(worker)).toBeNull();
    expect(await mailbox.readObservations()).toMatchObject({
      pending_expired: 1,
      invalid_pending: 1,
    });
    expect(await redis.hlen(keys.active)).toBe(0);
  });

  it('accounts natural pending TTL expiry once across restarted concurrent pollers without replay or active revocation', async () => {
    const active = [
      await activate(offer('a')),
      await activate(offer('b')),
      await activate(offer('c')),
    ];
    await ready();
    const head = offer('expires-head'),
      tail = offer('expires-tail');
    expect(await mailbox.offerDetailed(head)).toBe('accepted');
    expect(await mailbox.offerDetailed(tail)).toBe('accepted');
    const headMarker = await redis.get(accountingKeys.slot);
    const tailMarker = await redis.get(accountingKeys.slotNext);
    expect(headMarker).not.toContain(head.excerpt);
    expect(tailMarker).not.toContain(tail.excerpt);
    expect(await mailbox.readObservations()).toEqual({});
    await pause(COMMERCIAL_LLM_PENDING_MAX_AGE_MS + 80);
    expect(await mailbox.heartbeat(worker)).toBe(true);
    expect(await redis.exists(keys.slot, keys.slotNext)).toBe(0);
    const restarted = new CommercialLlmPoolAdmissionMailbox(redis);
    const pollers = Array.from({ length: 8 }, () =>
      new CommercialLlmPoolAdmissionMailbox(redis).readObservations(),
    );
    for (const observation of await Promise.all(pollers))
      expect(observation).toEqual({ pending_expired: 2 });
    expect(await restarted.take(worker)).toBeNull();
    expect(await redis.exists(accountingKeys.slot, accountingKeys.slotNext)).toBe(0);
    expect(await restarted.readObservations()).toEqual({ pending_expired: 2 });
    expect(await mailbox.hasProof(head.source)).toBe(false);
    expect(await mailbox.hasProof(tail.source)).toBe(false);
    for (const item of active) expect(await mailbox.owns(item.raw)).toBe(true);
    expect(await redis.hlen(keys.active)).toBe(3);
    expect(await redis.exists(keys.slot, keys.slotNext)).toBe(0);
  });

  it('accounts an expired head before refill and promotes the original tail metadata without renewing its deadline', async () => {
    await ready();
    expect(await mailbox.offerDetailed(offer('expired-head'))).toBe('accepted');
    await pause(1000);
    expect(await mailbox.offerDetailed(offer('live-tail'))).toBe('accepted');
    const tailRaw = (await redis.get(keys.slotNext))!;
    const tailMarker = await redis.get(accountingKeys.slotNext);
    const tailExpiry = await redis.pexpiretime(keys.slotNext);
    await pause(Math.max(0, await redis.pttl(keys.slot)) + 80);
    await ready();
    expect(await mailbox.offerDetailed(offer('replacement'))).toBe('accepted');
    expect(await redis.get(keys.slot)).toBe(tailRaw);
    expect(await redis.get(accountingKeys.slot)).toBe(tailMarker);
    expect(await redis.pexpiretime(keys.slot)).toBe(tailExpiry);
    expect(await mailbox.readObservations()).toEqual({ pending_expired: 1 });
    const taken = await mailbox.take(worker);
    expect(taken?.raw).toBe(tailRaw);
    expect(await mailbox.readObservations()).toEqual({ pending_expired: 1 });
    expect((await mailbox.take(worker))?.request.source.chatId).toBe('replacement');
    expect(await redis.exists(accountingKeys.slot, accountingKeys.slotNext)).toBe(0);
  });

  it('counts a worker-generation discard once and never assigns its marker to the successor', async () => {
    await ready();
    expect(await mailbox.offerDetailed(offer('old-worker'))).toBe('accepted');
    const originalMarker = await redis.get(accountingKeys.slot);
    await redis.pexpire(keys.worker, 1);
    await pause(10);
    worker = randomUUID();
    await ready();
    expect(await redis.get(accountingKeys.slot)).toBe(originalMarker);
    expect(await mailbox.readObservations()).toEqual({});
    expect(await mailbox.take(worker)).toBeNull();
    expect(await mailbox.readObservations()).toEqual({ foreign_worker: 1 });
    expect(await redis.exists(accountingKeys.slot)).toBe(0);
    const successor = await activate(offer('new-worker'));
    expect(await mailbox.owns(successor.raw)).toBe(true);
    expect(await mailbox.readObservations()).toEqual({ foreign_worker: 1 });
  });

  it('keeps old-worker admissions untracked rather than inventing expiry after their consumer removes the payload', async () => {
    await ready();
    await redis.del(accountingKeys.ready);
    expect(await mailbox.offerDetailed(offer('old-consumer'))).toBe('accepted');
    expect(await redis.exists(accountingKeys.slot, accountingKeys.slotNext)).toBe(0);
    await redis.del(keys.slot);
    expect(await mailbox.readObservations()).toEqual({});
    expect(await mailbox.take(worker)).toBeNull();
    expect(await mailbox.readObservations()).toEqual({});
  });

  it('accepts untracked old-producer input without manufacturing a historical expiry', async () => {
    await ready();
    const legacy = offer('old-producer');
    const raw = JSON.stringify({ ...legacy, worker, submittedAtMs: Date.now() });
    await redis.set(keys.slot, raw, 'PX', COMMERCIAL_LLM_PENDING_MAX_AGE_MS);
    expect(await mailbox.readObservations()).toEqual({});
    expect((await mailbox.take(worker))?.raw).toBe(raw);
    expect(await mailbox.readObservations()).toEqual({});
    expect(await redis.exists(accountingKeys.slot, accountingKeys.slotNext)).toBe(0);
  });

  it.each([
    { name: 'malformed JSON', value: '{malformed' },
    { name: 'oversized metadata', value: 'x'.repeat(513) },
    { name: 'invalid fields', value: JSON.stringify({ version: 1, expiresAtMs: 0 }) },
  ])('does not turn $name into a terminal count or source authority', async ({ value }) => {
    await ready();
    expect(await mailbox.offerDetailed(offer('preserved-source'))).toBe('accepted');
    const raw = await redis.get(keys.slot);
    await redis.set(accountingKeys.slot, value);
    expect(await mailbox.readObservations()).toEqual({});
    expect(await redis.get(keys.slot)).toBe(raw);
    expect(await redis.hlen(keys.active)).toBe(0);
    expect((await mailbox.take(worker))?.raw).toBe(raw);
    expect(await mailbox.readObservations()).toEqual({});
  });

  it('ignores a malformed metadata Redis type without altering its pending source', async () => {
    await ready();
    expect(await mailbox.offerDetailed(offer('preserved-source'))).toBe('accepted');
    const raw = await redis.get(keys.slot);
    await redis.del(accountingKeys.slot);
    await redis.hset(accountingKeys.slot, 'invalid', 'metadata');
    expect(await mailbox.readObservations()).toEqual({});
    expect(await redis.get(keys.slot)).toBe(raw);
    expect((await mailbox.take(worker))?.raw).toBe(raw);
    expect(await mailbox.readObservations()).toEqual({});
  });

  it('settles a tracked expired generation without deleting a later untracked occupant of the same slot', async () => {
    await ready();
    expect(await mailbox.offerDetailed(offer('older-tracked-source'))).toBe('accepted');
    const marker = JSON.parse((await redis.get(accountingKeys.slot))!) as {
      expiresAtMs: number;
    };
    await redis.set(
      accountingKeys.slot,
      JSON.stringify({ ...marker, expiresAtMs: Date.now() - 1 }),
    );
    const successor = offer('new-untracked-source');
    const raw = JSON.stringify({ ...successor, worker, submittedAtMs: Date.now() });
    await redis.set(keys.slot, raw, 'PX', COMMERCIAL_LLM_PENDING_MAX_AGE_MS);
    expect(await mailbox.readObservations()).toEqual({ pending_expired: 1 });
    expect(await redis.get(keys.slot)).toBe(raw);
    expect((await mailbox.take(worker))?.raw).toBe(raw);
    expect(await mailbox.readObservations()).toEqual({ pending_expired: 1 });
  });

  it('prunes an expired source and its role claims without revoking a different live source', async () => {
    const expired = await activate(offer('expired-chat'));
    expect(await mailbox.releasePrimary(expired.raw, worker)).toBe(true);
    expect(await mailbox.claimSecondary(expired.raw, worker)).toBe(true);
    const live = await activate(offer('live-chat'));
    const oldSource = shiftedSource(
      expired.request.source,
      Date.now() - COMMERCIAL_LLM_EFFECT_MAX_AGE_MS - 1,
    );
    const expiredRaw = JSON.stringify({ ...expired.request, source: oldSource });
    await redis.hdel(keys.active, digest(expired.raw));
    await redis.hset(keys.active, digest(expiredRaw), expiredRaw);
    await redis.hset(keys.secondary, digest('expired-chat'), expiredRaw);
    expect(await mailbox.offerDetailed(offer('replacement-chat'))).toBe('accepted');
    expect(await redis.hexists(keys.active, digest(expiredRaw))).toBe(0);
    expect(await redis.hexists(keys.secondary, digest('expired-chat'))).toBe(0);
    expect(await mailbox.owns(live.raw)).toBe(true);
    expect(await redis.hget(keys.primary, digest('live-chat'))).toBe(live.raw);
  });

  it('binds inherited proofs to exact active source and worker without renewing original expiry', async () => {
    const active = await activate(offer('proof-chat'));
    expect(await mailbox.releasePrimary(active.raw, worker)).toBe(true);
    expect(await mailbox.claimSecondary(active.raw, worker)).toBe(true);
    const changedSource = remember({ ...active.request.source, nonce: randomUUID() });
    const changedRaw = JSON.stringify({
      ...active.request,
      excerpt: active.request.excerpt + ' changed',
    });
    expect(await mailbox.owns(changedRaw)).toBe(false);
    expect(await mailbox.prove(changedRaw, active.request.source)).toBe(false);
    expect(await mailbox.prove(active.raw, changedSource)).toBe(false);
    expect(await mailbox.prove(active.raw, active.request.source)).toBe(true);
    const proofKey = commercialLlmProofKey(active.request.source);
    expect(await redis.pexpiretime(proofKey)).toBe(active.request.source.deadlineAtMs);
    expect(await mailbox.prove(active.raw, active.request.source)).toBe(true);
    expect(await redis.pexpiretime(proofKey)).toBe(active.request.source.deadlineAtMs);
    expect(await new CommercialLlmEnforcementMailbox(redis).hasProof(active.request.source)).toBe(
      true,
    );
    await mailbox.finish(active.raw, worker);
    expect(await mailbox.owns(active.raw)).toBe(false);
    expect(await mailbox.prove(active.raw, active.request.source)).toBe(false);
    expect(await mailbox.hasProof(active.request.source)).toBe(true);
    expect(await mailbox.hasProof(changedSource)).toBe(false);
  });

  it('Redis time rejects an expired proof even when the caller clock is behind', async () => {
    const input = offer();
    const now = Date.now();
    const source = remember(
      shiftedSource(input.source, now - COMMERCIAL_LLM_EFFECT_MAX_AGE_MS - 10),
    );
    const raw = JSON.stringify({
      source,
      excerpt: input.excerpt,
      submittedAtMs: now - 1000,
      worker,
    });
    await ready();
    await redis.hset(keys.active, digest(raw), raw);
    jest.spyOn(Date, 'now').mockReturnValue(now - 1000);
    expect(await mailbox.prove(raw, source)).toBe(false);
    expect(await redis.exists(commercialLlmProofKey(source))).toBe(0);
  });

  it('refuses expired, stale, and legacy sources without admitting model work', async () => {
    await ready();
    const input = offer();
    expect(
      await mailbox.offerDetailed({
        ...input,
        source: shiftedSource(input.source, Date.now() - 60001),
      }),
    ).toBe('source_expired');
    expect(
      await mailbox.offerDetailed({
        ...input,
        source: shiftedSource(input.source, Date.now() - 10001),
      }),
    ).toBe('source_stale');
    const legacyNow = Date.now();
    const legacy = buildCommercialLlmOffer(
      {
        chatId: 'legacy',
        messageId: randomUUID(),
        userId: 'user',
        originBotId: 'bot',
        text,
        eventAt: new Date(legacyNow).toISOString(),
        settings,
        origin: {
          sourceWebhookEventId: randomUUID(),
          sourceReceivingBotId: 'bot',
          sourceExecutionBotId: 'bot',
          sourceEventAtMs: legacyNow,
          sourceEvidenceVersion: 1,
        },
      },
      legacyNow,
    );
    if (!legacy) throw new Error('Synthetic legacy source was not created');
    expect(await mailbox.offerDetailed(legacy)).toBe('source_expired');
    expect(await redis.exists(keys.slot, keys.slotNext)).toBe(0);
    expect(await redis.hlen(keys.active)).toBe(0);
  });
});
