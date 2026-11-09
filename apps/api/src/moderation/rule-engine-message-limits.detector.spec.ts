import type { ChatSettings } from '../prisma/prisma-client';
import type { RedisCounterService } from './redis-counter.service';
import {
  RuleEngineMessageLimitsDetector,
  type MessageLimitStateObservation,
  extractDetectedPhoneNumbers,
  stripDetectedPhoneNumbers,
} from './rule-engine-message-limits.detector';

class MockRedisCounterService implements Pick<
  RedisCounterService,
  | 'incrementWithTtl'
  | 'claimEventCooldown'
  | 'claimMessageCountQuota'
  | 'replaceRevisionedSetMembershipsBeforeDeadline'
> {
  readonly calls: Array<{ key: string; ttlSec: number }> = [];
  readonly quotaCalls: Parameters<RedisCounterService['claimMessageCountQuota']>[0][] = [];
  private readonly counters = new Map<string, number>();
  private readonly members = new Set<string>();
  private readonly cooldownResults = new Map<string, 'allowed' | 'blocked'>();
  private readonly windowResults = new Map<string, number>();
  private readonly quotaDecisions = new Map<
    string,
    {
      kind: 'allowed' | 'blocked';
      eventTimestampMs: number;
      policy: string;
      publicationId?: string;
      messageTimestamp: number;
    }
  >();
  private readonly quotaPublications = new Map<
    string,
    { kind: 'allowed' | 'blocked'; eventTimestampMs: number; policy: string; publicationId: string }
  >();

  async claimMessageCountQuota(
    input: Parameters<RedisCounterService['claimMessageCountQuota']>[0],
  ): ReturnType<RedisCounterService['claimMessageCountQuota']> {
    this.quotaCalls.push(input);
    const scope = JSON.stringify([input.chatId, input.userId]);
    const key = JSON.stringify([scope, input.messageId]);
    const policy = `${input.maxMessages}:${input.windowSeconds}`;
    const saved = this.quotaDecisions.get(key);
    if (saved) {
      if (saved.messageTimestamp !== input.eventTimestampMs) return { kind: 'stale' };
      if (saved.kind === 'blocked' && saved.policy !== policy) return { kind: 'stale' };
      return {
        kind: saved.kind,
        eventTimestampMs: saved.eventTimestampMs,
        replayed: true,
        ...(saved.publicationId ? { publicationId: saved.publicationId } : {}),
      };
    }
    const publicationKey = input.publicationId && JSON.stringify([scope, input.publicationId]);
    const publication = publicationKey ? this.quotaPublications.get(publicationKey) : undefined;
    if (
      publication &&
      Math.abs(input.eventTimestampMs - publication.eventTimestampMs) < 300_000 &&
      Date.now() < publication.eventTimestampMs + 300_000
    ) {
      if (publication.kind === 'blocked' && input.eventTimestampMs < publication.eventTimestampMs) {
        return { kind: 'stale' };
      }
      if (publication.kind === 'blocked' && publication.policy !== policy) return { kind: 'stale' };
      this.quotaDecisions.set(key, { ...publication, messageTimestamp: input.eventTimestampMs });
      return { ...publication, replayed: true };
    }
    const count = this.counters.get(scope) ?? 0;
    const kind = count < input.maxMessages ? 'allowed' : 'blocked';
    if (kind === 'allowed') this.counters.set(scope, count + 1);
    const decision: {
      kind: 'allowed' | 'blocked';
      eventTimestampMs: number;
      policy: string;
      publicationId?: string;
    } = {
      kind,
      eventTimestampMs: input.eventTimestampMs,
      policy,
      ...(!publication && publicationKey && Date.now() < input.eventTimestampMs + 300_000
        ? { publicationId: input.publicationId! }
        : {}),
    };
    this.quotaDecisions.set(key, { ...decision, messageTimestamp: input.eventTimestampMs });
    if (publicationKey && decision.publicationId) {
      this.quotaPublications.set(publicationKey, {
        ...decision,
        publicationId: decision.publicationId,
      });
    }
    return { ...decision, replayed: false };
  }

  async replaceRevisionedSetMembershipsBeforeDeadline(
    params: Parameters<RedisCounterService['replaceRevisionedSetMembershipsBeforeDeadline']>[0],
  ): ReturnType<RedisCounterService['replaceRevisionedSetMembershipsBeforeDeadline']> {
    const replay = this.windowResults.get(params.stateKey);
    if (replay !== undefined) return { kind: 'replayed', counts: [replay] };
    const count = await this.incrementWithTtl(params.membershipKeys[0]!, params.ttlSeconds);
    this.windowResults.set(params.stateKey, count);
    return { kind: 'applied', counts: [count] };
  }

  async claimEventCooldown(
    params: Parameters<RedisCounterService['claimEventCooldown']>[0],
  ): ReturnType<RedisCounterService['claimEventCooldown']> {
    const replay = this.cooldownResults.get(params.memberKey);
    if (replay) return replay;
    const count = await this.incrementWithTtl(params.key, params.windowSeconds);
    const result = count > 1 ? 'blocked' : 'allowed';
    this.cooldownResults.set(params.memberKey, result);
    return result;
  }

  async incrementWithTtl(key: string, ttlSec: number): Promise<number> {
    this.calls.push({ key, ttlSec });
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async incrementOncePerMemberWithTtl(
    counterKey: string,
    memberKey: string,
    ttlSec: number,
  ): Promise<{ inserted: boolean; count: number }> {
    if (this.members.has(memberKey)) {
      return {
        inserted: false,
        count: this.counters.get(counterKey) ?? 0,
      };
    }

    this.members.add(memberKey);
    return {
      inserted: true,
      count: await this.incrementWithTtl(counterKey, ttlSec),
    };
  }
}

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    maxMessageLengthEnabled: false,
    maxMessageLength: 1500,
    antiSpamEnabled: true,
    messageCountLimitEnabled: false,
    messageCountLimitMessages: 5,
    messageCountLimitWindowHours: 1,
    messageLimitsBlockedWords: [],
    messageLimitsBlockedDomains: [],
    photoMessagesEnabled: true,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    forwardedMessagesEnabled: true,
    phoneNumbersEnabled: true,
    photoMessageCooldownEnabled: false,
    photoMessageCooldownHours: 1,
    stickerMessageCooldownEnabled: false,
    stickerMessageCooldownMinutes: 5,
    updatedAt: new Date('2026-05-14T00:00:00.000Z'),
    ...overrides,
  } as ChatSettings;
}

describe('RuleEngineMessageLimitsDetector', () => {
  it.each(['', ' ', '\t\n'])(
    'never writes state for an explicitly empty message ID %j',
    async (messageId) => {
      const counters = new MockRedisCounterService();
      const detector = new RuleEngineMessageLimitsDetector(counters);
      const input = {
        chatId: 'chat',
        userId: 'user',
        messageId,
        eventTimestampMs: Date.now(),
        settings: buildSettings({
          messageCountLimitEnabled: true,
          photoMessageCooldownEnabled: true,
          stickerMessageCooldownEnabled: true,
        }),
      };
      expect(await detector.detectAntiSpamBurstLimit(input)).toBeNull();
      expect(await detector.detectMessageCountLimit(input)).toBeNull();
      expect(
        await detector.detectMediaCooldownLimits({
          ...input,
          hasPhotoAttachment: true,
          hasStickerAttachment: true,
        }),
      ).toEqual([]);
      expect(counters.calls).toEqual([]);
    },
  );

  it.each([
    ['anti-spam-burst', 120],
    ['message-count-limit', 250],
    ['photo-cooldown', 250],
    ['sticker-cooldown', 250],
  ] as const)('observes each %s deadline once, including late failure', async (rule, budget) => {
    jest.useFakeTimers();
    const counters = new MockRedisCounterService();
    const observe = jest.fn<void, [MessageLimitStateObservation]>();
    const detector = new RuleEngineMessageLimitsDetector(counters, observe);
    const input = {
      chatId: 'chat',
      userId: 'user',
      messageId: 'message',
      eventTimestampMs: Date.now(),
      settings: buildSettings({
        messageCountLimitEnabled: true,
        photoMessageCooldownEnabled: true,
        stickerMessageCooldownEnabled: true,
      }),
      hasPhotoAttachment: rule === 'photo-cooldown',
      hasStickerAttachment: rule === 'sticker-cooldown',
    };
    const call = () =>
      rule === 'anti-spam-burst'
        ? detector.detectAntiSpamBurstLimit(input)
        : rule === 'message-count-limit'
          ? detector.detectMessageCountLimit(input)
          : detector.detectMediaCooldownLimits(input);
    const isCount = rule === 'anti-spam-burst' || rule === 'message-count-limit';
    const state =
      rule === 'message-count-limit'
        ? jest
            .spyOn(counters, 'claimMessageCountQuota')
            .mockResolvedValue({ kind: 'deadline_exceeded' })
        : isCount
          ? jest
              .spyOn(counters, 'replaceRevisionedSetMembershipsBeforeDeadline')
              .mockResolvedValue({ kind: 'deadline_exceeded' })
          : jest.spyOn(counters, 'claimEventCooldown').mockResolvedValue('deadline_exceeded');
    try {
      await expect(call()).resolves.toEqual(isCount ? null : []);
      expect(observe.mock.calls).toEqual([[{ rule, reason: 'deadline' }]]);
      observe.mockClear();
      let rejectLate!: (error: Error) => void;
      state.mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectLate = reject;
          }),
      );
      const pending = call();
      await jest.advanceTimersByTimeAsync(budget);
      await expect(pending).resolves.toEqual(isCount ? null : []);
      rejectLate(new Error('late counter response'));
      await jest.advanceTimersByTimeAsync(0);
      expect(observe.mock.calls).toEqual([[{ rule, reason: 'deadline' }]]);
      expect(state).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
      state.mockRestore();
    }
  });

  it.each(['throw', 'reject', 'hang'] as const)(
    'isolates an observer that can %s',
    async (mode) => {
      const counters = new MockRedisCounterService();
      jest
        .spyOn(counters, 'replaceRevisionedSetMembershipsBeforeDeadline')
        .mockResolvedValue({ kind: 'deadline_exceeded' });
      const detector = new RuleEngineMessageLimitsDetector(counters, () => {
        if (mode === 'throw') throw new Error('diagnostics unavailable');
        if (mode === 'reject') return Promise.reject(new Error('diagnostics unavailable'));
        return new Promise<void>(() => {});
      });
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat',
          userId: 'user',
          messageId: 'message',
          eventTimestampMs: Date.now(),
          settings: buildSettings(),
        }),
      ).resolves.toBeNull();
    },
  );

  it('does not report disabled, invalid, stale or successful checks as unavailable', async () => {
    const counters = new MockRedisCounterService();
    const observe = jest.fn<void, [MessageLimitStateObservation]>();
    const detector = new RuleEngineMessageLimitsDetector(counters, observe);
    for (const input of [
      { eventTimestampMs: Date.now(), settings: buildSettings({ antiSpamEnabled: false }) },
      { eventTimestampMs: NaN, settings: buildSettings() },
      { eventTimestampMs: Date.now() - 86_400_000, settings: buildSettings() },
      { eventTimestampMs: Date.now(), settings: buildSettings() },
    ]) {
      await detector.detectAntiSpamBurstLimit({
        chatId: 'chat',
        userId: 'user',
        messageId: 'message',
        ...input,
      });
    }
    expect(observe).not.toHaveBeenCalled();
  });

  it('observes the legacy burst deadline without repeating the count', async () => {
    jest.useFakeTimers();
    const counters = new MockRedisCounterService();
    const count = jest
      .spyOn(counters, 'incrementWithTtl')
      .mockImplementation(() => new Promise<number>(() => {}));
    const observe = jest.fn<void, [MessageLimitStateObservation]>();
    const detector = new RuleEngineMessageLimitsDetector(counters, observe);
    try {
      const input = {
        chatId: 'chat',
        userId: 'user',
        settings: buildSettings({ messageCountLimitEnabled: true }),
      };
      const pending = detector.detectAntiSpamBurstLimit(input);
      await jest.advanceTimersByTimeAsync(120);
      await expect(pending).resolves.toBeNull();
      expect(observe.mock.calls).toEqual([
        [
          {
            rule: 'anti-spam-burst',
            reason: 'deadline',
          },
        ],
      ]);
      expect(count).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not accept a forged no-dispatch error as an unavailable-state decision', async () => {
    const counters = new MockRedisCounterService();
    const error = Object.assign(new Error('Redis counter unavailable before dispatch'), {
      name: 'RedisCounterPreDispatchUnavailable',
      preDispatch: true,
      code: 'REDIS_COUNTER_PRE_DISPATCH_UNAVAILABLE',
    });
    jest.spyOn(counters, 'replaceRevisionedSetMembershipsBeforeDeadline').mockRejectedValue(error);
    const observe = jest.fn<void, [MessageLimitStateObservation]>();
    const detector = new RuleEngineMessageLimitsDetector(counters, observe);
    await expect(
      detector.detectAntiSpamBurstLimit({
        chatId: 'chat',
        userId: 'user',
        messageId: 'message',
        eventTimestampMs: Date.now(),
        settings: buildSettings(),
      }),
    ).rejects.toBe(error);
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    ['8 (999) 123-45-67 8 (999) 111-22-33', 2],
    ['ИНН 9991234567', 0],
    ['Артикул 89991234567', 0],
    ['https://example.com/orders/79991234567', 0],
    ['ИНН 9991234567, телефон +7 999 111-22-33', 1],
  ])('uses the approved blocking policy for %s', (text, count) => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService());
    const result = detector.detectPhoneNumberLimit({
      text,
      settings: buildSettings({ phoneNumbersEnabled: false }),
    });
    expect(result?.metadata?.phoneCount ?? 0).toBe(count);
    expect(
      detector.detectPhoneNumberLimit({
        text,
        settings: buildSettings({ phoneNumbersEnabled: true }),
      }),
    ).toBeNull();
  });

  it.each(['burst', 'count', 'cooldown'] as const)(
    'skips only an unknown %s decision on Redis or local deadline expiry',
    async (kind) => {
      const redisCounter = new MockRedisCounterService();
      const detector = new RuleEngineMessageLimitsDetector(redisCounter);
      const input = {
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        eventTimestampMs: Date.now(),
        settings: buildSettings({
          messageCountLimitEnabled: true,
          stickerMessageCooldownEnabled: true,
        }),
        hasStickerAttachment: true,
      };
      const call = () =>
        kind === 'burst'
          ? detector.detectAntiSpamBurstLimit(input)
          : kind === 'count'
            ? detector.detectMessageCountLimit(input)
            : detector.detectMediaCooldownLimits(input);
      const method =
        kind === 'cooldown'
          ? 'claimEventCooldown'
          : kind === 'count'
            ? 'claimMessageCountQuota'
            : 'replaceRevisionedSetMembershipsBeforeDeadline';
      const expired = kind === 'cooldown' ? 'deadline_exceeded' : { kind: 'deadline_exceeded' };
      const state = jest.spyOn(redisCounter, method).mockResolvedValue(expired as never);
      const expected = kind === 'cooldown' ? [] : null;
      try {
        await expect(call()).resolves.toEqual(expected);
        state.mockImplementationOnce(() => new Promise<never>(() => {}));
        jest.useFakeTimers();
        const pending = call();
        await jest.advanceTimersByTimeAsync(kind === 'burst' ? 120 : 250);
        await expect(pending).resolves.toEqual(expected);
        expect(state).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
        state.mockRestore();
      }
    },
  );

  it.each(['count', 'cooldown'] as const)('preserves nondeadline %s errors', async (kind) => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter);
    const error = new Error('Redis response failed');
    const method = kind === 'cooldown' ? 'claimEventCooldown' : 'claimMessageCountQuota';
    const state = jest.spyOn(redisCounter, method).mockRejectedValue(error);
    const input = {
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      eventTimestampMs: Date.now(),
      settings: buildSettings({
        messageCountLimitEnabled: true,
        stickerMessageCooldownEnabled: true,
      }),
      hasStickerAttachment: true,
    };
    try {
      await expect(
        kind === 'cooldown'
          ? detector.detectMediaCooldownLimits(input)
          : detector.detectMessageCountLimit(input),
      ).rejects.toBe(error);
      expect(state).toHaveBeenCalledTimes(1);
    } finally {
      state.mockRestore();
    }
  });

  it('strips recognized phones while preserving adjacent labels and non-phone numbers', () => {
    const numeric = 'Available 22.09.2026, price 123456789, packages 100-200-300';
    expect(stripDetectedPhoneNumbers(numeric)).toBe(numeric);
    expect(stripDetectedPhoneNumbers('code A+7 (999) 123-45-67 today')).toBe('code A  today');
    expect(stripDetectedPhoneNumbers('whatsapp 4951234567')).toBe('whatsapp  ');
    expect(stripDetectedPhoneNumbers('8 999 123 45 67')).toBe(' ');
  });
  it('detects text length, blocked words, and disabled attachment kinds', () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService());
    const settings = buildSettings({
      maxMessageLengthEnabled: true,
      maxMessageLength: 10,
      messageLimitsBlockedWords: ['спаммаркер'],
      photoMessagesEnabled: false,
      videoMessagesEnabled: false,
      fileMessagesEnabled: false,
      voiceMessagesEnabled: false,
      phoneNumbersEnabled: false,
    });

    expect(
      detector.detectMessageLengthLimit({
        measuredLength: 11,
        settings,
      })?.ruleCode,
    ).toBe('MESSAGE_TOO_LONG');
    expect(
      detector.detectBlockedWordLimit({
        text: 'тут спаммаркер внутри',
        settings,
      })?.ruleCode,
    ).toBe('MESSAGE_BLOCKED_WORD');
    expect(
      detector.detectPhoneNumberLimit({
        text: 'Связь: +7 900 000 00 01',
        settings,
      })?.ruleCode,
    ).toBe('PHONE_NUMBER_BLOCKED');
    expect(
      detector.detectAttachmentLimits({
        settings,
        hasPhotoAttachment: true,
        hasVideoAttachment: true,
        hasFileAttachment: true,
        hasVoiceAttachment: true,
      }),
    ).toEqual([
      expect.objectContaining({ ruleCode: 'PHOTO_BLOCKED' }),
      expect.objectContaining({ ruleCode: 'VIDEO_BLOCKED' }),
      expect.objectContaining({ ruleCode: 'FILE_BLOCKED' }),
      expect.objectContaining({ ruleCode: 'VOICE_BLOCKED' }),
    ]);
  });

  it('blocks forwarded messages only when they are disabled', () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService());

    expect(
      detector.detectAttachmentLimits({
        settings: buildSettings({ forwardedMessagesEnabled: false }),
        hasForwardedMessage: true,
      }),
    ).toEqual([
      expect.objectContaining({
        ruleCode: 'FORWARDED_MESSAGE_BLOCKED',
        reason: 'Forwarded messages are disabled by chat settings',
      }),
    ]);
    expect(
      detector.detectAttachmentLimits({
        settings: buildSettings({ forwardedMessagesEnabled: true }),
        hasForwardedMessage: true,
      }),
    ).toEqual([]);
  });

  it('allows forwards from legacy cached settings that predate the flag', () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService());
    const legacySettings: Partial<ChatSettings> = { ...buildSettings() };
    delete legacySettings.forwardedMessagesEnabled;

    expect(
      detector.detectAttachmentLimits({
        settings: legacySettings as ChatSettings,
        hasForwardedMessage: true,
      }),
    ).toEqual([]);
  });

  it('detects blocked domains on exact hosts and subdomains', () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService());
    const settings = buildSettings({
      messageLimitsBlockedDomains: ['casino.example'],
    });

    expect(
      detector.detectBlockedDomainLimit({
        text: 'Бонусы тут: https://promo.casino.example/path',
        settings,
      }),
    ).toEqual(
      expect.objectContaining({
        ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
        metadata: {
          blockedDomain: 'casino.example',
          matchedDomain: 'promo.casino.example',
          matchedLink: 'https://promo.casino.example/path',
        },
      }),
    );
    expect(
      detector.detectBlockedDomainLimit({
        text: 'Нейтральный домен: https://notcasino.example/path',
        settings,
      }),
    ).toBeNull();
  });

  it('extracts formatted and contextual phone numbers without duplicates', () => {
    expect(
      extractDetectedPhoneNumbers('Связь: +7 (900) 123-45-67, запасной телефон 8 900 123 45 67'),
    ).toEqual(['79001234567']);
    expect(extractDetectedPhoneNumbers('телефон офиса 495 123 45 67')).toEqual(['4951234567']);
  });

  it('does not treat dates and numeric ranges as phones', () => {
    expect(
      extractDetectedPhoneNumbers(
        'Периоды 2024-2025-2026 и 12.05.2026 не контакты, диапазон 100-200-300 тоже.',
      ),
    ).toEqual([]);
  });

  it('uses clamped message-count windows and thresholds', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter);
    const settings = buildSettings({
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 99,
      messageCountLimitWindowHours: 99,
    });

    for (let index = 0; index < 10; index += 1) {
      await expect(
        detector.detectMessageCountLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: `message-${index}`,
          eventTimestampMs: Date.now(),
          settings,
        }),
      ).resolves.toBeNull();
    }

    await expect(
      detector.detectMessageCountLimit({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'excess',
        eventTimestampMs: Date.now(),
        settings,
      }),
    ).resolves.toEqual(expect.objectContaining({ ruleCode: 'MESSAGE_COUNT_LIMIT' }));
    expect(redisCounter.quotaCalls[0]).toMatchObject({
      chatId: 'chat-1',
      userId: 'user-1',
      maxMessages: 10,
      windowSeconds: 24 * 60 * 60,
    });
    expect(redisCounter.calls).toEqual([]);
  });

  it.each([undefined, '', ' ', '\t'])(
    'never uses a compatibility quota for missing identity %j',
    async (messageId) => {
      const counters = new MockRedisCounterService();
      const detector = new RuleEngineMessageLimitsDetector(counters);
      expect(
        await detector.detectMessageCountLimit({
          chatId: 'chat',
          userId: 'user',
          messageId,
          eventTimestampMs: Date.now(),
          settings: buildSettings({ messageCountLimitEnabled: true }),
        }),
      ).toBeNull();
      expect(counters.quotaCalls).toEqual([]);
      expect(counters.calls).toEqual([]);
    },
  );

  it('binds an excess album to the original quota decision and forwards verified identity', async () => {
    const counters = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(counters);
    const eventTimestampMs = Date.now() - 1000;
    const settings = buildSettings({
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 1,
    });
    const input = { chatId: 'chat', userId: 'user', eventTimestampMs, settings };
    expect(await detector.detectMessageCountLimit({ ...input, messageId: 'first' })).toBeNull();
    expect(
      await detector.detectMessageCountLimit({
        ...input,
        messageId: 'album-first',
        publicationId: 'verified-group',
      }),
    ).toMatchObject({
      ruleCode: 'MESSAGE_COUNT_LIMIT',
      metadata: {
        quotaPolicyVersion: 3,
        quotaPublicationId: 'verified-group',
        quotaAnchorTimestampMs: eventTimestampMs,
        quotaDecisionReplayed: false,
      },
    });
    expect(
      await detector.detectMessageCountLimit({
        ...input,
        eventTimestampMs: eventTimestampMs + 1,
        messageId: 'album-second',
        publicationId: 'verified-group',
      }),
    ).toMatchObject({
      metadata: { quotaAnchorTimestampMs: eventTimestampMs, quotaDecisionReplayed: true },
    });
  });

  it.each([undefined, 'original-group'])(
    'uses only the actual quota publication %j in enforcement metadata',
    async (publicationId) => {
      const counters = new MockRedisCounterService();
      const detector = new RuleEngineMessageLimitsDetector(counters);
      jest.spyOn(counters, 'claimMessageCountQuota').mockResolvedValue({
        kind: 'blocked',
        replayed: false,
        eventTimestampMs: Date.now(),
        ...(publicationId ? { publicationId } : {}),
      });
      const violation = await detector.detectMessageCountLimit({
        chatId: 'chat',
        userId: 'user',
        messageId: 'fresh-message',
        publicationId: 'reused-requested-alias',
        eventTimestampMs: Date.now(),
        settings: buildSettings({ messageCountLimitEnabled: true }),
      });
      expect(violation?.ruleCode).toBe('MESSAGE_COUNT_LIMIT');
      if (publicationId) expect(violation?.metadata?.quotaPublicationId).toBe(publicationId);
      else expect(violation?.metadata).not.toHaveProperty('quotaPublicationId');
    },
  );

  it('enforces the built-in anti-spam burst window', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter);
    const settings = buildSettings({ antiSpamEnabled: true });

    for (let index = 0; index < 5; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
        }),
      ).resolves.toBeNull();
    }

    await expect(
      detector.detectAntiSpamBurstLimit({
        chatId: 'chat-1',
        userId: 'user-1',
        settings,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ruleCode: 'MESSAGE_RATE_LIMIT',
        metadata: expect.objectContaining({
          count: 6,
          maxMessages: 5,
          windowSec: 6,
        }),
      }),
    );
    expect(redisCounter.calls[0]).toEqual({
      key: 'message:anti-spam-burst:v2:chat-1:user-1:5:6:legacy',
      ttlSec: 6,
    });
  });

  it('does not count repeated delivery of the same message id toward anti-spam burst', async () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService());
    const settings = buildSettings({ antiSpamEnabled: true });

    for (let index = 0; index < 6; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'mid-1',
          eventTimestampMs: Date.now(),
          settings,
        }),
      ).resolves.toBeNull();
    }

    await expect(
      detector.detectAntiSpamBurstLimit({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-2',
        eventTimestampMs: Date.now(),
        settings,
      }),
    ).resolves.toBeNull();
  });

  it('does not count repeated delivery of the same message id toward message count limit', async () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService());
    const settings = buildSettings({
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 1,
      messageCountLimitWindowHours: 1,
    });

    await expect(
      detector.detectMessageCountLimit({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-1',
        eventTimestampMs: Date.now(),
        settings,
      }),
    ).resolves.toBeNull();
    await expect(
      detector.detectMessageCountLimit({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-1',
        eventTimestampMs: Date.now(),
        settings,
      }),
    ).resolves.toBeNull();
    await expect(
      detector.detectMessageCountLimit({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-2',
        eventTimestampMs: Date.now(),
        settings,
      }),
    ).resolves.toEqual(expect.objectContaining({ ruleCode: 'MESSAGE_COUNT_LIMIT' }));
  });

  it('skips the built-in anti-spam burst window when disabled', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter);
    const settings = buildSettings({ antiSpamEnabled: false });

    for (let index = 0; index < 6; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
        }),
      ).resolves.toBeNull();
    }

    expect(redisCounter.calls).toEqual([]);
  });

  it('skips the built-in anti-spam burst window for forwarded messages', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter);
    const settings = buildSettings({ antiSpamEnabled: true });

    for (let index = 0; index < 6; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
          skipAntiSpamBurstLimit: true,
        }),
      ).resolves.toBeNull();
    }

    expect(redisCounter.calls).toEqual([]);
  });

  it('skips the built-in anti-spam burst window for media attachments and batches', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter);
    const settings = buildSettings({ antiSpamEnabled: true });

    for (let index = 0; index < 6; index += 1) {
      await expect(
        detector.detectAntiSpamBurstLimit({
          chatId: 'chat-1',
          userId: 'user-1',
          settings,
          hasExcludedAttachment: true,
        }),
      ).resolves.toBeNull();
    }

    expect(redisCounter.calls).toEqual([]);
  });

  it('preserves media cooldown state after unrelated settings updates', async () => {
    const redisCounter = new MockRedisCounterService();
    const detector = new RuleEngineMessageLimitsDetector(redisCounter);
    const firstSettings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
      updatedAt: new Date('2026-05-14T00:00:00.000Z'),
    });
    const secondSettings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
      updatedAt: new Date('2026-05-14T01:00:00.000Z'),
    });

    await expect(
      detector.detectMediaCooldownLimits({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-1',
        eventTimestampMs: Date.now(),
        settings: firstSettings,
        hasPhotoAttachment: true,
      }),
    ).resolves.toEqual([]);
    await expect(
      detector.detectMediaCooldownLimits({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-2',
        eventTimestampMs: Date.now(),
        settings: firstSettings,
        hasPhotoAttachment: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ ruleCode: 'PHOTO_RATE_LIMIT' })]);
    await expect(
      detector.detectMediaCooldownLimits({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-3',
        eventTimestampMs: Date.now(),
        settings: secondSettings,
        hasPhotoAttachment: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ ruleCode: 'PHOTO_RATE_LIMIT' })]);
  });

  it('does not count repeated delivery of the same message id toward media cooldown', async () => {
    const detector = new RuleEngineMessageLimitsDetector(new MockRedisCounterService());
    const settings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 1,
    });

    await expect(
      detector.detectMediaCooldownLimits({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-1',
        eventTimestampMs: Date.now(),
        settings,
        hasPhotoAttachment: true,
      }),
    ).resolves.toEqual([]);
    await expect(
      detector.detectMediaCooldownLimits({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'mid-1',
        eventTimestampMs: Date.now(),
        settings,
        hasPhotoAttachment: true,
      }),
    ).resolves.toEqual([]);
  });
});
