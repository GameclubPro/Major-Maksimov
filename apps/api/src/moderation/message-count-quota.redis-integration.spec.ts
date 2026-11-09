import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RedisCounterService } from './redis-counter.service';
import {
  buildMessageCountQuotaKeys,
  MESSAGE_COUNT_QUOTA_MAX_WINDOW_SECONDS,
  MESSAGE_COUNT_QUOTA_RETENTION_SECONDS,
  type MessageCountQuotaInput,
} from './message-count-quota';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

(local ? describe : describe.skip)('admitted message quota on native Redis', () => {
  let counter: RedisCounterService;
  let inspector: Redis;
  let chatId: string;
  let now: number;
  const cleanup = new Set<string>();

  beforeEach(async () => {
    counter = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    inspector = new Redis(url);
    chatId = randomUUID();
    // FLAG: Connection setup is outside the production detector's short state budget.
    await Promise.all([inspector.ping(), counter.getString(`quota:${chatId}:ready`)]);
    now = Date.now();
  });

  afterEach(async () => {
    if (cleanup.size) await inspector.del(...cleanup);
    cleanup.clear();
    await Promise.all([inspector.quit(), counter.onModuleDestroy()]);
  });

  const input = (messageId: string, overrides: Partial<MessageCountQuotaInput> = {}) => ({
    chatId,
    userId: 'user',
    messageId,
    eventTimestampMs: now - 1000,
    maxMessages: 1,
    windowSeconds: 3600,
    deadlineAtMs: Date.now() + 5000,
    requireReadyBeforeDispatch: true,
    ...overrides,
  });
  const register = (params: MessageCountQuotaInput) => {
    const keys = buildMessageCountQuotaKeys(params);
    cleanup.add(keys.historyKey);
    cleanup.add(keys.decisionKey);
    if (keys.publicationKey) cleanup.add(keys.publicationKey);
    return keys;
  };
  const claim = (messageId: string, overrides: Partial<MessageCountQuotaInput> = {}) => {
    const params = input(messageId, overrides);
    register(params);
    return counter.claimMessageCountQuota(params);
  };

  it('never extends the wait with rejected attempts or their replays', async () => {
    const firstAt = now - 3_590_000;
    expect(await claim('first', { eventTimestampMs: firstAt })).toMatchObject({ kind: 'allowed' });
    const keys = register(input('excess'));
    const historyTtl = await inspector.pttl(keys.historyKey);
    expect(historyTtl).toBeGreaterThan((MESSAGE_COUNT_QUOTA_RETENTION_SECONDS - 10) * 1000);
    expect(await claim('excess')).toMatchObject({ kind: 'blocked', replayed: false });
    const decision = await inspector.get(keys.decisionKey);
    const decisionTtl = await inspector.pttl(keys.decisionKey);
    expect(await claim('excess')).toMatchObject({ kind: 'blocked', replayed: true });
    expect(await inspector.get(keys.decisionKey)).toBe(decision);
    expect(await inspector.pttl(keys.decisionKey)).toBeLessThanOrEqual(decisionTtl);
    expect(await inspector.pttl(keys.historyKey)).toBeLessThanOrEqual(historyTtl);
    expect(await inspector.zcard(keys.historyKey)).toBe(1);
    expect(await claim('exact-boundary', { eventTimestampMs: firstAt + 3_600_000 })).toMatchObject({
      kind: 'allowed',
    });
    expect(await claim('first', { eventTimestampMs: firstAt })).toMatchObject({
      kind: 'allowed',
      replayed: true,
      eventTimestampMs: firstAt,
    });
    expect(await inspector.zcard(keys.historyKey)).toBe(2);
  });

  it('atomically admits only the configured quota across concurrent clients and scopes', async () => {
    const other = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    try {
      await other.getString(`quota:${chatId}:other-ready`);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const params = input(`concurrent-${i}`, { maxMessages: 3 });
          register(params);
          return (i % 2 ? counter : other).claimMessageCountQuota(params);
        }),
      );
      expect(results.filter((result) => result.kind === 'allowed')).toHaveLength(3);
      expect(results.filter((result) => result.kind === 'blocked')).toHaveLength(17);
      const keys = register(input('concurrent-0'));
      expect(await inspector.zcard(keys.historyKey)).toBe(3);
      const replayed = await Promise.all(
        results.map((_, i) => claim(`concurrent-${i}`, { maxMessages: 3 })),
      );
      expect(replayed.map((result) => result.kind)).toEqual(results.map((result) => result.kind));
      expect(await inspector.zcard(keys.historyKey)).toBe(3);
      expect(await claim('other-author', { userId: 'other' })).toMatchObject({ kind: 'allowed' });
      expect(await claim('other-chat', { chatId: `${chatId}-other` })).toMatchObject({
        kind: 'allowed',
      });
    } finally {
      await other.onModuleDestroy();
    }
  });

  it('keeps one history through threshold changes without rebinding rejected decisions', async () => {
    expect(await claim('first', { maxMessages: 2 })).toMatchObject({ kind: 'allowed' });
    expect(await claim('second', { maxMessages: 2 })).toMatchObject({ kind: 'allowed' });
    expect(await claim('blocked', { maxMessages: 2 })).toMatchObject({ kind: 'blocked' });
    expect(await claim('blocked', { maxMessages: 3 })).toEqual({ kind: 'stale' });
    expect(await claim('first', { maxMessages: 1 })).toMatchObject({
      kind: 'allowed',
      replayed: true,
    });
    expect(await claim('third', { maxMessages: 3 })).toMatchObject({ kind: 'allowed' });
    expect(await claim('after-return', { maxMessages: 2 })).toMatchObject({ kind: 'blocked' });
    expect(await inspector.zcard(register(input('first')).historyKey)).toBe(3);
  });

  it('retains admitted publications when the selected window grows', async () => {
    expect(
      await claim('old', { windowSeconds: 10_800, eventTimestampMs: now - 7_200_000 }),
    ).toMatchObject({ kind: 'allowed' });
    expect(await claim('recent', { windowSeconds: 3600 })).toMatchObject({ kind: 'allowed' });
    expect(await claim('expanded', { windowSeconds: 10_800 })).toMatchObject({ kind: 'blocked' });
    const keys = register(input('expanded'));
    expect(await inspector.zcard(keys.historyKey)).toBe(2);
    expect(await inspector.pttl(keys.historyKey)).toBeGreaterThan(
      (MESSAGE_COUNT_QUOTA_RETENTION_SECONDS - 10) * 1000,
    );
  });

  it('shares one immutable allowance for verified album constituents', async () => {
    const publicationId = 'verified-album';
    const anchor = now - 1000;
    expect(await claim('piece-a', { publicationId, eventTimestampMs: anchor })).toMatchObject({
      kind: 'allowed',
      replayed: false,
    });
    const keys = register(input('piece-a', { publicationId }));
    const original = await inspector.zrange(keys.historyKey, 0, -1, 'WITHSCORES');
    const ttl = await inspector.pttl(keys.decisionKey);
    expect(await claim('piece-b', { publicationId, eventTimestampMs: anchor + 100 })).toMatchObject(
      { kind: 'allowed', replayed: true, eventTimestampMs: anchor, publicationId },
    );
    expect(await inspector.zrange(keys.historyKey, 0, -1, 'WITHSCORES')).toEqual(original);
    expect(await inspector.pttl(keys.decisionKey)).toBeLessThanOrEqual(ttl);
    expect(await claim('next-publication')).toMatchObject({ kind: 'blocked' });
    expect(await claim('same-name', { userId: 'other', publicationId })).toMatchObject({
      kind: 'allowed',
      replayed: false,
    });
  });

  it('shares an allowance with an earlier album part delivered after its later part', async () => {
    const publicationId = 'reverse-delivery';
    const anchor = now - 1000;
    expect(await claim('later-part', { publicationId, eventTimestampMs: anchor })).toMatchObject({
      kind: 'allowed',
      publicationId,
    });
    const keys = register(input('earlier-part', { publicationId }));
    expect(
      await claim('earlier-part', { publicationId, eventTimestampMs: anchor - 100 }),
    ).toMatchObject({ kind: 'allowed', replayed: true, eventTimestampMs: anchor, publicationId });
    expect(
      await claim('earlier-part', {
        eventTimestampMs: anchor - 100,
        publicationId: 'changed-alias',
      }),
    ).toMatchObject({ kind: 'allowed', replayed: true, eventTimestampMs: anchor, publicationId });
    expect(await inspector.zcard(keys.historyKey)).toBe(1);
    expect(await claim('next-publication')).toMatchObject({ kind: 'blocked' });
  });

  it('counts a fresh MID with an expired album alias while preserving the original MID receipt', async () => {
    const publicationId = 'reused-alias';
    const params = input('original-part', { publicationId, maxMessages: 2 });
    const keys = register(params);
    expect(await counter.claimMessageCountQuota(params)).toMatchObject({
      kind: 'allowed',
      publicationId,
    });
    const anchor = now - 300_001;
    // FLAG: Model elapsed cluster time without a five-minute native-test sleep.
    const own = JSON.parse((await inspector.get(keys.decisionKey))!);
    const group = JSON.parse((await inspector.get(keys.publicationKey!))!);
    await inspector.set(
      keys.decisionKey,
      JSON.stringify({ ...own, timestamp: anchor, messageTimestamp: anchor }),
      'EX',
      3600,
    );
    await inspector.set(
      keys.publicationKey!,
      JSON.stringify({ ...group, timestamp: anchor }),
      'EX',
      3600,
    );
    await inspector.zadd(keys.historyKey, anchor, keys.publicationMember!);
    const originalReceipts = await inspector.mget(keys.decisionKey, keys.publicationKey!);
    const originalTtl = await inspector.pttl(keys.publicationKey!);
    for (const alias of [undefined, publicationId, 'changed-alias']) {
      expect(
        await claim('original-part', {
          publicationId: alias,
          eventTimestampMs: anchor,
          maxMessages: 2,
        }),
      ).toMatchObject({ kind: 'allowed', replayed: true, eventTimestampMs: anchor, publicationId });
    }
    expect(await claim('fresh-part', { publicationId, maxMessages: 2 })).toEqual({
      kind: 'allowed',
      replayed: false,
      eventTimestampMs: now - 1000,
    });
    expect(await claim('third-part', { publicationId, maxMessages: 2 })).toEqual({
      kind: 'blocked',
      replayed: false,
      eventTimestampMs: now - 1000,
    });
    expect(await inspector.zcard(keys.historyKey)).toBe(2);
    expect(await inspector.mget(keys.decisionKey, keys.publicationKey!)).toEqual(originalReceipts);
    expect(await inspector.pttl(keys.publicationKey!)).toBeLessThanOrEqual(originalTtl);
  });

  it.each(['allowed', 'blocked'] as const)(
    'retires an irrelevant retained album member after receipt expiry before a fresh %s claim',
    async (kind) => {
      if (kind === 'blocked') {
        await claim('quota-filler', { eventTimestampMs: now - 2000, maxMessages: 2 });
      }
      const publicationId = 'alias-after-retention';
      const first = input('expired-generation', {
        publicationId,
        eventTimestampMs: now + 30_000,
        maxMessages: 2,
      });
      const keys = register(first);
      expect(await counter.claimMessageCountQuota(first)).toMatchObject({ kind: 'allowed' });
      // FLAG: Model receipt expiry plus a shared-history renewal. Accepted future skew can keep
      // this 48-hour-old score inside physical retention after the old receipts expire.
      const irrelevantAt = now - MESSAGE_COUNT_QUOTA_MAX_WINDOW_SECONDS * 2 * 1000;
      await inspector.zadd(keys.historyKey, irrelevantAt, keys.publicationMember!);
      await inspector.pexpire(keys.historyKey, MESSAGE_COUNT_QUOTA_RETENTION_SECONDS * 1000);
      await inspector.pexpireat(keys.decisionKey, 1);
      await inspector.pexpireat(keys.publicationKey!, 1);
      expect(await inspector.exists(keys.decisionKey, keys.publicationKey!)).toBe(0);
      expect(await inspector.zscore(keys.historyKey, keys.publicationMember!)).toBe(
        String(irrelevantAt),
      );
      expect(await claim('fresh-generation', { publicationId })).toEqual({
        kind,
        replayed: false,
        eventTimestampMs: now - 1000,
        publicationId,
      });
      expect(await inspector.zcard(keys.historyKey)).toBe(1);
      expect(await inspector.zscore(keys.historyKey, keys.publicationMember!)).toBe(
        kind === 'allowed' ? String(now - 1000) : null,
      );
      expect(await claim('fresh-generation', { publicationId })).toMatchObject({
        kind,
        replayed: true,
        publicationId,
      });
      expect(await claim('fresh-constituent', { publicationId })).toMatchObject({
        kind,
        replayed: true,
        publicationId,
      });
    },
  );

  it('shares album refusal without later pieces renewing its authority', async () => {
    await claim('first', { eventTimestampMs: now - 2000 });
    const publicationId = 'blocked-album';
    expect(await claim('piece-a', { publicationId })).toMatchObject({
      kind: 'blocked',
      replayed: false,
    });
    expect(await claim('piece-b', { publicationId, eventTimestampMs: now - 500 })).toMatchObject({
      kind: 'blocked',
      replayed: true,
      eventTimestampMs: now - 1000,
    });
    expect(await claim('older-piece', { publicationId, eventTimestampMs: now - 1500 })).toEqual({
      kind: 'stale',
    });
    const keys = register(input('piece-a', { publicationId }));
    const own = JSON.parse((await inspector.get(keys.decisionKey))!);
    const group = JSON.parse((await inspector.get(keys.publicationKey!))!);
    const secondKeys = register(input('piece-b', { publicationId }));
    const second = JSON.parse((await inspector.get(secondKeys.decisionKey))!);
    const expiredAnchor = now - 300_001;
    // FLAG: Represent a retained receipt after its original five-minute action window elapsed.
    await inspector.set(
      keys.decisionKey,
      JSON.stringify({ ...own, timestamp: expiredAnchor, messageTimestamp: expiredAnchor }),
      'EX',
      3600,
    );
    await inspector.set(
      keys.publicationKey!,
      JSON.stringify({ ...group, timestamp: expiredAnchor }),
      'EX',
      3600,
    );
    await inspector.set(
      secondKeys.decisionKey,
      JSON.stringify({ ...second, timestamp: expiredAnchor }),
      'EX',
      3600,
    );
    const retained = await inspector.mget(keys.decisionKey, keys.publicationKey!);
    expect(await claim('piece-a', { publicationId, eventTimestampMs: expiredAnchor })).toEqual({
      kind: 'stale',
    });
    expect(await claim('piece-b', { publicationId, eventTimestampMs: now - 500 })).toEqual({
      kind: 'stale',
    });
    expect(await claim('late-piece', { publicationId })).toEqual({
      kind: 'blocked',
      replayed: false,
      eventTimestampMs: now - 1000,
    });
    expect(await inspector.mget(keys.decisionKey, keys.publicationKey!)).toEqual(retained);
    expect(await inspector.zcard(keys.historyKey)).toBe(1);
  });

  it('never moves an existing physical MID to a different group or a standalone claim', async () => {
    const publicationId = 'original-alias';
    expect(await claim('same-mid', { publicationId })).toMatchObject({
      kind: 'allowed',
      publicationId,
    });
    for (const alias of [undefined, 'another-alias']) {
      expect(await claim('same-mid', { publicationId: alias })).toEqual({
        kind: 'allowed',
        replayed: true,
        eventTimestampMs: now - 1000,
        publicationId,
      });
    }
    const other = register(input('same-mid', { publicationId: 'another-alias' }));
    expect(await inspector.exists(other.publicationKey!)).toBe(0);
    expect(await inspector.zcard(other.historyKey)).toBe(1);
    expect(await claim('independent-mid')).toMatchObject({ kind: 'blocked' });
  });

  it('never retroactively punishes an original when predecessors arrive later', async () => {
    expect(await claim('newer', { eventTimestampMs: now - 100 })).toMatchObject({
      kind: 'allowed',
    });
    expect(await claim('older', { eventTimestampMs: now - 200 })).toMatchObject({
      kind: 'allowed',
    });
    expect(await claim('newer', { eventTimestampMs: now - 100 })).toMatchObject({
      kind: 'allowed',
      replayed: true,
    });
    expect(await claim('newer', { eventTimestampMs: now - 50 })).toEqual({ kind: 'stale' });
    expect(await claim('next', { eventTimestampMs: now })).toMatchObject({ kind: 'blocked' });
  });

  it('starts a separate admitted history without importing or modifying v2 attempts', async () => {
    const legacy = `message:count-limit:v2:${chatId}:user:1:1`;
    cleanup.add(legacy);
    await inspector.zadd(legacy, now - 1000, 'attempt-one', now - 500, 'attempt-two');
    const before = await inspector.dump(legacy);
    expect(await claim('first-v3')).toMatchObject({ kind: 'allowed' });
    expect(await inspector.dump(legacy)).toEqual(before);
    expect(await inspector.zcard(register(input('first-v3')).historyKey)).toBe(1);
  });

  it.each([
    {
      label: 'absolute deadline',
      overrides: () => ({ deadlineAtMs: Date.now() - 1 }),
      kind: 'deadline_exceeded',
    },
    {
      label: 'expired event',
      overrides: () => ({ eventTimestampMs: now - 3_600_000 }),
      kind: 'stale',
    },
    {
      label: 'untrusted future',
      overrides: () => ({ eventTimestampMs: now + 120_000 }),
      kind: 'stale',
    },
  ])('keeps Redis unchanged for $label', async ({ overrides, kind }) => {
    const params = input('no-write', overrides());
    const keys = register(params);
    expect(await counter.claimMessageCountQuota(params)).toEqual({ kind });
    expect(await inspector.exists(keys.historyKey, keys.decisionKey)).toBe(0);
  });

  it.each(['history-type', 'receipt-type', 'receipt-json', 'missing-history', 'missing-receipt'])(
    'refuses corrupt %s without inventing an admission',
    async (fault) => {
      const params = input('corrupt');
      const keys = register(params);
      if (fault.startsWith('missing-')) {
        await counter.claimMessageCountQuota(params);
        await inspector.del(fault === 'missing-history' ? keys.historyKey : keys.decisionKey);
      } else if (fault === 'history-type') {
        await inspector.set(keys.historyKey, 'corrupt');
      } else if (fault === 'receipt-type') {
        await inspector.hset(keys.decisionKey, 'corrupt', 'value');
      } else {
        await inspector.set(keys.decisionKey, '{}');
      }
      const before = await Promise.all([
        inspector.dump(keys.historyKey),
        inspector.dump(keys.decisionKey),
      ]);
      await expect(counter.claimMessageCountQuota(params)).rejects.toThrow(/quota/i);
      expect(
        await Promise.all([inspector.dump(keys.historyKey), inspector.dump(keys.decisionKey)]),
      ).toEqual(before);
    },
  );

  it.each(['publication-type', 'publication-json', 'publication-history', 'publication-receipt'])(
    'refuses corrupt %s before creating the new physical MID receipt',
    async (fault) => {
      const publicationId = 'corrupt-album';
      const first = input('first-part', { publicationId });
      const keys = register(first);
      await counter.claimMessageCountQuota(first);
      const next = input('next-part', { publicationId });
      const nextKeys = register(next);
      if (fault === 'publication-type') {
        await inspector.del(keys.publicationKey!);
        await inspector.hset(keys.publicationKey!, 'corrupt', 'value');
      } else if (fault === 'publication-json') {
        await inspector.set(keys.publicationKey!, '{}');
      } else if (fault === 'publication-receipt') {
        await inspector.del(keys.publicationKey!);
      } else {
        await inspector.del(keys.historyKey);
      }
      const observed = [keys.historyKey, keys.publicationKey!, nextKeys.decisionKey];
      const before = await Promise.all(observed.map((key) => inspector.dump(key)));
      await expect(counter.claimMessageCountQuota(next)).rejects.toThrow(/quota/i);
      expect(await Promise.all(observed.map((key) => inspector.dump(key)))).toEqual(before);
    },
  );
});
