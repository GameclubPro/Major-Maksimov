import { ConfigService } from '@nestjs/config';
import { chatSettingsSchema } from '@maxim/contracts';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { RuleEngineService } from './rule-engine.service';
import type { ChatSettings } from '../prisma/prisma-client';
import { isRedisCounterPreDispatchUnavailable, RedisCounterService } from './redis-counter.service';
import { CommercialAdDetector } from './commercial';
import { buildMessageCountQuotaKeys } from './message-count-quota';
import {
  ANTI_SPAM_BURST_LIMIT,
  ANTI_SPAM_BURST_WINDOW_SEC,
  RuleEngineMessageLimitsDetector,
  type MessageLimitStateObservation,
} from './rule-engine-message-limits.detector';

const url = process.env.MAXIM_TEST_REDIS_URL ?? '';
const local = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

(local ? describe : describe.skip)('media cooldown Redis integration', () => {
  let redis: RedisCounterService;
  let inspector: Redis;
  let detector: RuleEngineMessageLimitsDetector;
  let chatId: string;
  let settings: ChatSettings;
  let now: number;

  beforeEach(async () => {
    redis = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
    inspector = new Redis(url);
    detector = new RuleEngineMessageLimitsDetector(redis);
    chatId = randomUUID();
    // FLAG: Establish both real connections before measuring the rule's operation budget.
    await Promise.all([inspector.ping(), redis.getString(`media-cooldown:${chatId}:ready`)]);
    now = Date.now();
    settings = {
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 1,
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 1,
      updatedAt: new Date(now - 86_400_000),
    } as ChatSettings;
  });

  afterEach(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await inspector.scan(cursor, 'MATCH', `*${chatId}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length) await inspector.del(...keys);
    } while (cursor !== '0');
    await inspector.quit();
    await redis.onModuleDestroy();
  });

  const observe = (messageId: string, eventTimestampMs: number, overrides = {}) => {
    const input = {
      chatId,
      userId: 'user',
      messageId,
      eventTimestampMs,
      settings,
      hasStickerAttachment: true,
      ...overrides,
    };
    return detector.detectMediaCooldownLimits(input);
  };

  const burstWindowKey = () =>
    `message:anti-spam-burst:v2:${chatId}:user:${ANTI_SPAM_BURST_LIMIT}:${ANTI_SPAM_BURST_WINDOW_SEC}`;

  const nativeClient = (service: RedisCounterService): Redis => {
    const client: unknown = Reflect.get(service, 'redis');
    if (!(client instanceof Redis)) throw new Error('Expected a real ioredis counter client');
    return client;
  };
  const stateRules = [
    'anti-spam-burst',
    'message-count-limit',
    'photo-cooldown',
    'sticker-cooldown',
  ] as const;
  const runStateRule = (
    target: RuleEngineMessageLimitsDetector,
    rule: MessageLimitStateObservation['rule'],
  ) => {
    const input = {
      chatId,
      userId: 'user',
      messageId: 'admission-boundary',
      eventTimestampMs: now,
      settings: {
        ...settings,
        antiSpamEnabled: true,
        messageCountLimitEnabled: true,
        messageCountLimitMessages: 1,
        messageCountLimitWindowHours: 1,
      },
    };
    if (rule === 'anti-spam-burst') return target.detectAntiSpamBurstLimit(input);
    if (rule === 'message-count-limit') return target.detectMessageCountLimit(input);
    return target.detectMediaCooldownLimits({
      ...input,
      hasPhotoAttachment: rule === 'photo-cooldown',
      hasStickerAttachment: rule === 'sticker-cooldown',
    });
  };

  it.each(stateRules)(
    'refuses disconnected %s before dispatch with one observation and no writes',
    async (rule) => {
      const unavailable = new RedisCounterService(new ConfigService({ REDIS_URL: url }));
      const client = nativeClient(unavailable);
      try {
        await unavailable.getString(`media-cooldown:${chatId}:isolated-ready`);
        const ended = once(client, 'end');
        client.disconnect();
        await ended;
        expect(client.status).toBe('end');
        const get = jest.spyOn(client, 'get');
        const evalCommand = jest.spyOn(client, 'eval');
        const claim = jest.spyOn(unavailable, 'claimEventCooldown');
        const membership = jest.spyOn(unavailable, 'replaceRevisionedSetMembershipsBeforeDeadline');
        const quota = jest.spyOn(unavailable, 'claimMessageCountQuota');
        const observations: MessageLimitStateObservation[] = [];
        const isolatedDetector = new RuleEngineMessageLimitsDetector(unavailable, (value) => {
          observations.push(value);
        });
        expect(await runStateRule(isolatedDetector, rule)).toEqual(
          rule.endsWith('cooldown') ? [] : null,
        );
        expect(observations).toEqual([{ rule, reason: 'pre_dispatch_unavailable' }]);
        expect(get).not.toHaveBeenCalled();
        expect(evalCommand).not.toHaveBeenCalled();
        const claimParams = claim.mock.calls[0]?.[0];
        const memberParams = membership.mock.calls[0]?.[0];
        const quotaKeys =
          quota.mock.calls[0]?.[0] && buildMessageCountQuotaKeys(quota.mock.calls[0]![0]);
        const keys = claimParams
          ? [claimParams.key, claimParams.memberKey]
          : quotaKeys
            ? [quotaKeys.historyKey, quotaKeys.decisionKey]
            : [memberParams!.stateKey, ...memberParams!.membershipKeys];
        expect(await inspector.exists(...keys)).toBe(0);
        expect(
          claim.mock.calls.length + membership.mock.calls.length + quota.mock.calls.length,
        ).toBe(1);
      } finally {
        client.disconnect();
      }
    },
  );

  it.each(stateRules)(
    'preserves committed %s state and the original lost EVAL response',
    async (rule) => {
      const client = nativeClient(redis);
      const original = client.eval.bind(client);
      const error = new Error('Committed EVAL response lost');
      const evalCommand = jest.spyOn(client, 'eval').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw error;
      });
      const claim = jest.spyOn(redis, 'claimEventCooldown');
      const membership = jest.spyOn(redis, 'replaceRevisionedSetMembershipsBeforeDeadline');
      const quota = jest.spyOn(redis, 'claimMessageCountQuota');
      const observations: MessageLimitStateObservation[] = [];
      const target = new RuleEngineMessageLimitsDetector(redis, (value) => {
        observations.push(value);
      });
      try {
        await expect(runStateRule(target, rule)).rejects.toBe(error);
        expect(isRedisCounterPreDispatchUnavailable(error)).toBe(false);
        expect(observations).toEqual([]);
        expect(evalCommand).toHaveBeenCalledTimes(1);
        expect(
          claim.mock.calls.length + membership.mock.calls.length + quota.mock.calls.length,
        ).toBe(1);
        const claimParams = claim.mock.calls[0]?.[0];
        if (claimParams) {
          expect(await inspector.get(claimParams.key)).toBe(String(now));
          expect(JSON.parse((await inspector.get(claimParams.memberKey))!)).toEqual({
            timestamp: now,
            result: 1,
          });
          expect(await inspector.pttl(claimParams.key)).toBeGreaterThan(0);
          expect(await inspector.pttl(claimParams.memberKey)).toBeGreaterThan(0);
        } else if (quota.mock.calls.length) {
          const keys = buildMessageCountQuotaKeys(quota.mock.calls[0]![0]);
          expect(await inspector.zrange(keys.historyKey, 0, -1, 'WITHSCORES')).toEqual([
            keys.member,
            String(now),
          ]);
          expect(JSON.parse((await inspector.get(keys.decisionKey))!)).toMatchObject({
            version: 3,
            result: 1,
            timestamp: now,
          });
          expect(await inspector.pttl(keys.historyKey)).toBeGreaterThan(0);
          expect(await inspector.pttl(keys.decisionKey)).toBeGreaterThan(0);
        } else {
          const params = membership.mock.calls[0]![0];
          const key = params.membershipKeys[0]!;
          expect(await inspector.zcard(key)).toBe(1);
          expect(await inspector.zscore(key, params.member)).toBe(String(now));
          expect(JSON.parse((await inspector.get(params.stateKey))!)).toMatchObject({
            revision: now,
            memberships: [{ key, count: 1 }],
          });
          expect(await inspector.pttl(key)).toBeGreaterThan(0);
          expect(await inspector.pttl(params.stateKey)).toBeGreaterThan(0);
        }
      } finally {
        evalCommand.mockRestore();
        claim.mockRestore();
        membership.mockRestore();
        quota.mockRestore();
      }
    },
  );

  it.each(stateRules)(
    'observes a committed %s deadline once even when its late response rejects',
    async (rule) => {
      const client = nativeClient(redis);
      const original = client.eval.bind(client);
      let releaseResponse!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let finishResponse!: () => void;
      const done = new Promise<void>((resolve) => {
        finishResponse = resolve;
      });
      let committed = false;
      const response = jest.spyOn(client, 'eval').mockImplementationOnce(async (...args) => {
        try {
          await original(...args);
          committed = true;
          await barrier;
          throw new Error('Late committed response lost');
        } finally {
          finishResponse();
        }
      });
      const observations: MessageLimitStateObservation[] = [];
      const target = new RuleEngineMessageLimitsDetector(redis, (value) => {
        observations.push(value);
      });
      const detection = runStateRule(target, rule);
      try {
        expect(await detection).toEqual(rule.endsWith('cooldown') ? [] : null);
        expect(committed).toBe(true);
        expect(observations).toEqual([{ rule, reason: 'deadline' }]);
        expect(response).toHaveBeenCalledTimes(1);
        const args = response.mock.calls[0]!;
        const keys = args.slice(2, 2 + Number(args[1])).map(String);
        expect(await inspector.exists(...keys)).toBe(keys.length);
        const values = await Promise.all(
          keys.map(async (key) => ({
            type: await inspector.type(key),
            dump: await inspector.dump(key),
            ttl: await inspector.pttl(key),
          })),
        );
        expect(values.every((value) => value.ttl > 0)).toBe(true);
        releaseResponse();
        await done;
        await Promise.resolve();
        expect(observations).toEqual([{ rule, reason: 'deadline' }]);
        expect(response).toHaveBeenCalledTimes(1);
        for (const [index, key] of keys.entries()) {
          expect(await inspector.type(key)).toBe(values[index]!.type);
          expect(await inspector.dump(key)).toEqual(values[index]!.dump);
          expect(await inspector.pttl(key)).toBeGreaterThan(0);
          expect(await inspector.pttl(key)).toBeLessThanOrEqual(values[index]!.ttl);
        }
      } finally {
        releaseResponse();
        await Promise.allSettled([detection, ...(response.mock.calls.length ? [done] : [])]);
        response.mockRestore();
      }
    },
  );

  it.each(['photo', 'sticker'] as const)(
    'enforces %s cooldown alongside review-only commercial telemetry without recounting a replay',
    async (kind) => {
      const engine = new RuleEngineService(redis);
      const config = {
        ...chatSettingsSchema.parse({
          commercialAdsFilterEnabled: true,
          antiDuplicateEnabled: false,
          antiSpamEnabled: false,
        }),
        ...settings,
      } as ChatSettings;
      const detect = (messageId: string, at: number) =>
        engine.detect({
          chatId,
          userId: 'user',
          messageId,
          duplicateStateEventType: 'message_created',
          duplicateStateEventTimestampMs: at,
          text: 'Водитель Абакан-Аскиз-ст. Аскиза 11.40-12.00 +7 900 000 00 00 с места до места завтра',
          settings: config,
          domainAllowlist: [],
          hasPhotoAttachment: kind === 'photo',
          hasStickerAttachment: kind === 'sticker',
        });
      const code = kind === 'photo' ? 'PHOTO_RATE_LIMIT' : 'STICKER_RATE_LIMIT';
      const first = await detect('review-original', now - 1_000);
      expect(first.violations).toEqual([
        expect.objectContaining({
          ruleCode: 'COMMERCIAL_AD',
          metadata: expect.objectContaining({
            actionBand: 'REVIEW_ONLY',
            actionable: false,
            recordable: false,
          }),
        }),
      ]);
      for (let replay = 0; replay < 2; replay += 1) {
        const repeat = await detect('review-repeat', now);
        expect(repeat.violations.map((violation) => violation.ruleCode)).toEqual([
          'COMMERCIAL_AD',
          code,
        ]);
      }
      const originalReplay = await detect('review-original', now - 1_000);
      expect(originalReplay.violations.some((violation) => violation.ruleCode === code)).toBe(
        false,
      );
    },
  );

  it.each([
    ['photo', 'WARN', true, true],
    ['sticker', 'WARN', true, true],
    ['photo', 'recordable', false, true],
    ['sticker', 'recordable', false, true],
  ] as const)(
    'preserves %s cooldown for the next eligible message after a commercial %s owner',
    async (kind, _label, actionable, recordable) => {
      const engine = new RuleEngineService(redis);
      const config = {
        ...chatSettingsSchema.parse({
          commercialAdsFilterEnabled: true,
          antiDuplicateEnabled: false,
          antiSpamEnabled: false,
        }),
        ...settings,
      } as ChatSettings;
      const detect = (messageId: string) =>
        engine.detect({
          chatId,
          userId: 'user',
          messageId,
          duplicateStateEventType: 'message_created',
          duplicateStateEventTimestampMs: now,
          text: 'Водитель Абакан-Аскиз-ст. Аскиза 11.40-12.00 +7 900 000 00 00 с места до места завтра',
          settings: config,
          domainAllowlist: [],
          hasPhotoAttachment: kind === 'photo',
          hasStickerAttachment: kind === 'sticker',
        });
      const detectCommercial = CommercialAdDetector.prototype.detect;
      const commercial = jest
        .spyOn(CommercialAdDetector.prototype, 'detect')
        .mockImplementation(function (this: CommercialAdDetector, input) {
          const result = detectCommercial.call(this, input);
          if (!result) throw new Error('Expected commercial classifier fixture');
          return { ...result, actionBand: 'WARN', actionable, recordable };
        });
      try {
        const blocked = await detect('competing-owner');
        expect(blocked.violations).toEqual([
          expect.objectContaining({
            ruleCode: 'COMMERCIAL_AD',
            metadata: expect.objectContaining({ actionable, recordable }),
          }),
        ]);
      } finally {
        commercial.mockRestore();
      }
      expect((await detect('first-eligible')).violations).toHaveLength(1);
      expect((await detect('second-eligible')).violations.map((v) => v.ruleCode)).toEqual([
        'COMMERCIAL_AD',
        kind === 'photo' ? 'PHOTO_RATE_LIMIT' : 'STICKER_RATE_LIMIT',
      ]);
    },
  );

  it('replays the original violation without counting delivery twice or accusing the original', async () => {
    expect(await observe('first', now - 1000)).toEqual([]);
    expect(await observe('repeat', now)).toEqual([
      expect.objectContaining({ ruleCode: 'STICKER_RATE_LIMIT' }),
    ]);
    expect(await observe('repeat', now)).toEqual([
      expect.objectContaining({ ruleCode: 'STICKER_RATE_LIMIT' }),
    ]);
    expect(await observe('first', now - 1000)).toEqual([]);
  });

  it.each([
    ['sticker', 60_000, {}],
    ['photo', 3_600_000, { hasStickerAttachment: false, hasPhotoAttachment: true }],
  ])(
    'permits %s exactly at its event-time boundary despite processing delay',
    async (_, windowMs, flags) => {
      const start = now - windowMs + 30_000;
      expect(await observe('first', start, flags)).toEqual([]);
      expect(await observe('too-early', start + windowMs - 1, flags)).toHaveLength(1);
      expect(await observe('boundary', start + windowMs, flags)).toEqual([]);
      expect(await observe('too-early', start + windowMs - 1, flags)).toHaveLength(1);
    },
  );

  it('does not restart the cooldown when an unrelated setting is saved', async () => {
    await observe('first', now - 1000);
    settings = { ...settings, updatedAt: new Date(now), greetingEnabled: true };
    expect(await observe('second', now)).toEqual([
      expect.objectContaining({ ruleCode: 'STICKER_RATE_LIMIT' }),
    ]);
  });

  it('does not extend the interval after a rejected attempt', async () => {
    await observe('first', now - 30_000);
    expect(await observe('blocked', now)).toHaveLength(1);
    expect(await observe('next', now + 30_000)).toEqual([]);
  });

  it('does not sanction a late original or move the accepted timestamp backwards', async () => {
    await observe('newer', now - 1000);
    expect(await observe('late-original', now - 2000)).toEqual([]);
    expect(await observe('next', now)).toHaveLength(1);
  });

  it('skips expired or untrusted future events without consuming the interval', async () => {
    expect(await observe('expired', now - 61_000)).toEqual([]);
    expect(await observe('future', now + 120_000)).toEqual([]);
    expect(await observe('valid', now)).toEqual([]);
  });

  it('does not count a message without a trusted timestamp', async () => {
    expect(await observe('unknown', now, { eventTimestampMs: undefined })).toEqual([]);
    expect(await observe('valid', now)).toEqual([]);
  });

  it('never mutates Redis when the command misses its absolute deadline', async () => {
    const key = `cooldown-test:${chatId}`;
    const memberKey = `${key}:member`;
    expect(
      await redis.claimEventCooldown({
        key,
        memberKey,
        eventTimestampMs: now,
        windowSeconds: 60,
        deadlineAtMs: now - 1,
      }),
    ).toBe('deadline_exceeded');
    expect(await inspector.mget(key, memberKey)).toEqual([null, null]);
  });

  it('lets the Redis clock reject an expired burst deadline without late membership writes', async () => {
    const key = `burst-deadline:${chatId}`;
    const stateKey = `${key}:state`;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now - 2000);
    try {
      // FLAG: The application clock passes both prechecks; the real Redis Lua guard owns expiry.
      expect(
        await redis.replaceRevisionedSetMembershipsBeforeDeadline({
          stateKey,
          member: 'member',
          revision: now - 1000,
          membershipKeys: [key],
          windowSeconds: ANTI_SPAM_BURST_WINDOW_SEC,
          ttlSeconds: 60,
          deadlineAtMs: now - 1,
        }),
      ).toEqual({ kind: 'deadline_exceeded' });
    } finally {
      clock.mockRestore();
    }
    expect(await inspector.exists(key, stateKey)).toBe(0);
  });

  it('propagates a lost response and recovers the same decision on retry', async () => {
    await observe('first', now - 1000);
    const original = redis.claimEventCooldown.bind(redis);
    jest.spyOn(redis, 'claimEventCooldown').mockImplementationOnce(async (params) => {
      await original(params);
      throw new Error('response lost');
    });
    await expect(observe('repeat', now)).rejects.toThrow('response lost');
    expect(await observe('repeat', now)).toHaveLength(1);
  });

  it('admits only one concurrent message and keeps chat and author scopes separate', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => observe(`message-${index}`, now)),
    );
    expect(results.filter((result) => result.length === 0)).toHaveLength(1);
    expect(await observe('other-author', now, { userId: 'other' })).toEqual([]);
    expect(await observe('other-chat', now, { chatId: `${chatId}-other` })).toEqual([]);
  });

  it('does not ban on six messages when the first is outside the six-second window', async () => {
    const config = { ...settings, antiSpamEnabled: true };
    for (let index = 0; index < 6; index++) {
      const input = {
        chatId,
        userId: 'user',
        messageId: `burst-${index}`,
        settings: config,
        eventTimestampMs: now - 5500 + (index === 5 ? 6000 : index * 1000),
      };
      expect(await detector.detectAntiSpamBurstLimit(input)).toBeNull();
    }
  });

  it('replays the sixth-message burst decision without accusing the first message', async () => {
    const config = { ...settings, antiSpamEnabled: true };
    const input = (index: number) => ({
      chatId,
      userId: 'user',
      messageId: `burst-${index}`,
      settings: config,
      eventTimestampMs: now - 1000 + index,
    });
    for (let index = 0; index < 5; index++) {
      expect(await detector.detectAntiSpamBurstLimit(input(index))).toBeNull();
    }
    const sixth = input(5);
    expect(await detector.detectAntiSpamBurstLimit(sixth)).toMatchObject({
      ruleCode: 'MESSAGE_RATE_LIMIT',
    });
    expect(await inspector.zcard(burstWindowKey())).toBe(6);
    expect(await detector.detectAntiSpamBurstLimit(sixth)).toMatchObject({
      ruleCode: 'MESSAGE_RATE_LIMIT',
    });
    expect(await detector.detectAntiSpamBurstLimit(input(0))).toBeNull();
    expect(await inspector.zcard(burstWindowKey())).toBe(6);
  });

  it.each(['burst', 'count'] as const)(
    'keeps independent moderation after a committed %s response misses its deadline',
    async (kind) => {
      const config = {
        ...settings,
        antiSpamEnabled: kind === 'burst',
        messageCountLimitEnabled: kind === 'count',
        messageCountLimitMessages: 1,
        messageCountLimitWindowHours: 1,
        messageLimitsBlockedWords: ['спаммаркер'],
        messageLimitsBlockedDomains: [],
        phoneNumbersEnabled: true,
      };
      const input = (index: number) => ({
        chatId,
        userId: 'user',
        messageId: `limit-${index}`,
        settings: config,
        eventTimestampMs: now - 1000 + index,
      });
      const threshold = kind === 'burst' ? ANTI_SPAM_BURST_LIMIT : 1;
      for (let index = 0; index < threshold; index++) {
        expect(
          await (kind === 'burst'
            ? detector.detectAntiSpamBurstLimit(input(index))
            : detector.detectMessageCountLimit(input(index))),
        ).toBeNull();
      }
      const client = nativeClient(redis);
      const original = client.eval.bind(client);
      let releaseResponse!: () => void;
      const responseBarrier = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let nativeResult: unknown;
      let finishResponse!: () => void;
      const responseDone = new Promise<void>((resolve) => {
        finishResponse = resolve;
      });
      const response = jest.spyOn(client, 'eval').mockImplementationOnce(async (...args) => {
        try {
          nativeResult = await original(...args);
          await responseBarrier;
          return nativeResult;
        } finally {
          finishResponse();
        }
      });
      const engine = new RuleEngineService(redis);
      const current = input(threshold);
      const detection = engine.detect({
        ...current,
        text: 'тут спаммаркер внутри',
        domainAllowlist: [],
        duplicateStateEventTimestampMs: current.eventTimestampMs,
      });
      try {
        const result = await detection;
        expect(nativeResult).toEqual(
          kind === 'count' ? [2, current.eventTimestampMs, ''] : [1, threshold + 1],
        );
        expect(result.violations.map((violation) => violation.ruleCode)).toEqual([
          'MESSAGE_BLOCKED_WORD',
        ]);
        expect(response).toHaveBeenCalledTimes(1);
        const key =
          kind === 'count' ? `message:count-limit:v3:${chatId}:user:admitted` : burstWindowKey();
        expect(await inspector.zcard(key)).toBe(kind === 'count' ? 1 : threshold + 1);
        releaseResponse();
        await responseDone;
        expect(result.violations.map((violation) => violation.ruleCode)).toEqual([
          'MESSAGE_BLOCKED_WORD',
        ]);
        expect(response).toHaveBeenCalledTimes(1);
      } finally {
        releaseResponse();
        await Promise.allSettled([
          detection,
          ...(response.mock.calls.length ? [responseDone] : []),
        ]);
        response.mockRestore();
      }
    },
  );

  it('completes the engine when a committed cooldown response arrives after its deadline', async () => {
    await observe('first', now - 1000);
    const original = redis.claimEventCooldown.bind(redis);
    let releaseResponse!: () => void;
    const responseBarrier = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let nativeResult!: Awaited<ReturnType<typeof original>>;
    let finishResponse!: () => void;
    const responseDone = new Promise<void>((resolve) => {
      finishResponse = resolve;
    });
    const response = jest
      .spyOn(redis, 'claimEventCooldown')
      .mockImplementationOnce(async (params) => {
        try {
          nativeResult = await original(params);
          await responseBarrier;
          return nativeResult;
        } finally {
          finishResponse();
        }
      });
    const detection = new RuleEngineService(redis).detect({
      chatId,
      userId: 'user',
      messageId: 'repeat',
      duplicateStateEventTimestampMs: now,
      text: '',
      domainAllowlist: [],
      hasStickerAttachment: true,
      settings: {
        ...settings,
        messageLimitsBlockedWords: [],
        messageLimitsBlockedDomains: [],
        phoneNumbersEnabled: true,
      },
    });
    try {
      const result = await detection;
      expect(nativeResult).toBe('blocked');
      expect(result.violations).toEqual([]);
      expect(response).toHaveBeenCalledTimes(1);
      releaseResponse();
      await responseDone;
      expect(result.violations).toEqual([]);
      expect(response).toHaveBeenCalledTimes(1);
    } finally {
      releaseResponse();
      await Promise.allSettled([detection, ...(response.mock.calls.length ? [responseDone] : [])]);
      response.mockRestore();
    }
  });

  it('keeps the absolute cooldown write deadline after the local detector returns', async () => {
    const original = redis.claimEventCooldown.bind(redis);
    let releaseCommand!: () => void;
    const commandBarrier = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    let nativeResult!: Awaited<ReturnType<typeof original>>;
    let finishCommand!: () => void;
    const commandDone = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    const command = jest
      .spyOn(redis, 'claimEventCooldown')
      .mockImplementationOnce(async (params) => {
        try {
          await commandBarrier;
          nativeResult = await original(params);
          return nativeResult;
        } finally {
          finishCommand();
        }
      });
    try {
      await expect(observe('late-command', now)).resolves.toEqual([]);
      expect(command).toHaveBeenCalledTimes(1);
      const params = command.mock.calls[0]![0];
      let clockTimeout: ReturnType<typeof setTimeout> | undefined;
      const clockDeadline = new Promise<never>((_, reject) => {
        clockTimeout = setTimeout(
          () =>
            reject(new Error('Redis TIME did not reach the captured cooldown deadline within 2s')),
          2_000,
        );
      });
      try {
        // FLAG: Local timer completion does not prove Redis's absolute clock passed the deadline.
        // Release the unchanged command only after observing expiry on the clock that guards SET.
        for (;;) {
          const [seconds, microseconds] = await Promise.race([inspector.time(), clockDeadline]);
          const redisNowMs = Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
          if (redisNowMs >= params.deadlineAtMs) break;
          await Promise.race([
            new Promise<void>((resolve) =>
              setTimeout(resolve, Math.min(10, Math.max(1, params.deadlineAtMs - redisNowMs))),
            ),
            clockDeadline,
          ]);
        }
      } finally {
        clearTimeout(clockTimeout);
      }
      releaseCommand();
      await commandDone;
      expect(nativeResult).toBe('deadline_exceeded');
      expect(await inspector.exists(params.key, params.memberKey)).toBe(0);
    } finally {
      releaseCommand();
      await commandDone;
      command.mockRestore();
    }
  });

  it('counts only chronological predecessors for delayed burst deliveries', async () => {
    const config = { ...settings, antiSpamEnabled: true };
    for (let index = 5; index >= 0; index--) {
      const input = {
        chatId,
        userId: 'user',
        messageId: `burst-${index}`,
        settings: config,
        eventTimestampMs: now - 1000 + index,
      };
      expect(await detector.detectAntiSpamBurstLimit(input)).toBeNull();
    }
  });

  it('replays a message-count violation and admits the exact hourly boundary', async () => {
    const config = {
      ...settings,
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 1,
      messageCountLimitWindowHours: 1,
    };
    const input = (messageId: string, eventTimestampMs: number) => ({
      chatId,
      userId: 'user',
      messageId,
      eventTimestampMs,
      settings: config,
    });
    const first = input('first', now - 3_599_000);
    const second = input('second', now - 1000);
    expect(await detector.detectMessageCountLimit(first)).toBeNull();
    expect(await detector.detectMessageCountLimit(second)).toMatchObject({
      ruleCode: 'MESSAGE_COUNT_LIMIT',
    });
    expect(await detector.detectMessageCountLimit(second)).toMatchObject({
      ruleCode: 'MESSAGE_COUNT_LIMIT',
    });
    expect(await detector.detectMessageCountLimit(input('boundary', now + 2000))).toBeNull();
  });

  it.each([undefined, false])(
    'never spends stateful quota on edits when the caller passes skip=%s',
    async (skipStatefulMessageLimits) => {
      const config = {
        ...chatSettingsSchema.parse({}),
        antiSpamEnabled: true,
        antiDuplicateEnabled: false,
        messageCountLimitEnabled: true,
        messageCountLimitMessages: 2,
        messageCountLimitWindowHours: 1,
        photoMessageCooldownEnabled: true,
        photoMessageCooldownHours: 1,
        stickerMessageCooldownEnabled: true,
        stickerMessageCooldownMinutes: 1,
      } as unknown as ChatSettings;
      const engine = new RuleEngineService(redis);
      const detect = (
        messageId: string,
        eventTimestampMs: number,
        edit = false,
        withMedia = false,
      ) =>
        engine.detect({
          chatId,
          userId: 'user',
          messageId,
          duplicateStateEventType: edit ? 'message_edited' : 'message_created',
          duplicateStateEventTimestampMs: eventTimestampMs,
          text: 'Продам личный стол',
          settings: config,
          domainAllowlist: [],
          ...(edit ? { skipStatefulMessageLimits } : {}),
          ...(withMedia ? { hasPhotoAttachment: true, hasStickerAttachment: true } : {}),
        });
      expect((await detect('first', now - 4000)).violations).toEqual([]);
      const key = `message:count-limit:v3:${chatId}:user:admitted`;
      const original = await inspector.zrange(key, 0, -1, 'WITHSCORES');
      const memberships = jest.spyOn(redis, 'replaceRevisionedSetMembershipsBeforeDeadline');
      const quota = jest.spyOn(redis, 'claimMessageCountQuota');
      const cooldown = jest.spyOn(redis, 'claimEventCooldown');
      try {
        for (let i = 0; i < 6; i++) {
          expect((await detect('first', now - 3000 + i, true, i % 2 === 0)).violations).toEqual([]);
        }
        expect(memberships).not.toHaveBeenCalled();
        expect(quota).not.toHaveBeenCalled();
        expect(cooldown).not.toHaveBeenCalled();
        expect(await inspector.zrange(key, 0, -1, 'WITHSCORES')).toEqual(original);
      } finally {
        memberships.mockRestore();
        quota.mockRestore();
        cooldown.mockRestore();
      }
      expect((await detect('second', now - 2000)).violations).toEqual([]);
      expect((await detect('third', now - 1000)).violations).toEqual([
        expect.objectContaining({ ruleCode: 'MESSAGE_COUNT_LIMIT' }),
      ]);
    },
  );
});
