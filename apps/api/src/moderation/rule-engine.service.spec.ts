import { LinkPolicy, type ChatSettings } from '../prisma/prisma-client';
import { createDefaultCommercialAdsPolicy, stopWordsPolicySchema } from '@maxim/contracts/settings';
import {
  RULE_COVERAGE_COUNTERS,
  RULE_COVERAGE_FAMILIES,
  type RuleCoverageFamily,
  type RuleCoverageSnapshot,
} from './rule-engine-observation';
import {
  COMMERCIAL_REAL_WORLD_NEGATIVE_CASES,
  COMMERCIAL_REAL_WORLD_POSITIVE_CASES,
} from './commercial-real-world.fixture';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import { PROFANITY_EXACT_VARIANT_COUNT, TARGETED_INSULT_VARIANT_COUNT } from './profanity-lexicon';
import { DUPLICATE_STATE_BUDGET_MS } from './rule-engine-duplicate-detector';
import { RuleEngineService } from './rule-engine.service';
import { RedisCounterService } from './redis-counter.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import type Redis from 'ioredis';

class MockRedisCounterService {
  private readonly counters = new Map<string, number>();
  private readonly members = new Set<string>();
  private readonly revisionedStates = new Map<
    string,
    { revision: number; membershipKeys: string[]; countSnapshots: Map<string, number> }
  >();
  private readonly membershipSets = new Map<string, Map<string, number>>();

  async incrementWithTtl(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async incrementOncePerMemberWithTtl(
    counterKey: string,
    memberKey: string,
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
      count: await this.incrementWithTtl(counterKey),
    };
  }

  async replaceRevisionedSetMembershipsBeforeDeadline(
    params: Parameters<RedisCounterService['replaceRevisionedSetMembershipsBeforeDeadline']>[0],
  ): ReturnType<RedisCounterService['replaceRevisionedSetMembershipsBeforeDeadline']> {
    const current = this.revisionedStates.get(params.stateKey);
    if (current && params.revision < current.revision) {
      return { kind: 'stale' as const };
    }
    if (current && params.revision === current.revision) {
      const sameKeys =
        current.membershipKeys.length === params.membershipKeys.length &&
        current.membershipKeys.every((key) => params.membershipKeys.includes(key));
      if (!sameKeys) {
        return { kind: 'stale' as const };
      }
      return {
        kind: 'replayed' as const,
        counts: params.membershipKeys.map((key) => current.countSnapshots.get(key) ?? 0),
      };
    }

    for (const key of current?.membershipKeys ?? []) {
      const membership = this.membershipSets.get(key);
      membership?.delete(params.member);
      if (membership?.size === 0) {
        this.membershipSets.delete(key);
      }
    }
    for (const key of params.membershipKeys) {
      const membership = this.membershipSets.get(key) ?? new Map<string, number>();
      membership.set(params.member, params.revision);
      this.membershipSets.set(key, membership);
    }
    const windowMs = params.windowSeconds * 1_000;
    const cutoffMs = params.revision - windowMs;
    const futureCutoffMs = params.revision + windowMs;
    const countSnapshots = new Map(
      params.membershipKeys.map((key) => {
        const timestamps = Array.from(this.membershipSets.get(key)?.values() ?? [])
          .filter((timestampMs) => timestampMs > cutoffMs && timestampMs < futureCutoffMs)
          .sort((left, right) => left - right);
        let left = 0;
        let maximum = 0;
        for (let right = 0; right < timestamps.length; right += 1) {
          while ((timestamps[right] ?? 0) - (timestamps[left] ?? 0) >= windowMs) {
            left += 1;
          }
          maximum = Math.max(maximum, right - left + 1);
        }
        return [key, maximum];
      }),
    );
    this.revisionedStates.set(params.stateKey, {
      revision: params.revision,
      membershipKeys: [...params.membershipKeys],
      countSnapshots,
    });
    return {
      kind: 'applied' as const,
      counts: params.membershipKeys.map((key) => countSnapshots.get(key) ?? 0),
    };
  }
}

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const base: ChatSettings = {
    reportsEnabled: false,
    reportsThreshold: 3,
    reportsAliases: [],
    reportsDeleteMode: 'MESSAGE',
    reportsMuteEnabled: false,
    reportsMuteDurationHours: 1,
    reportsRevision: 0,
    slowModeEnabled: false,
    slowModeIntervalSeconds: 30,
    mediaMessageCooldownEnabled: false,
    mediaMessageCooldownSeconds: 30,
    stickerMessagesEnabled: true,
    trafficPolicyRevision: 0,
    trafficPolicyEffectiveAt: new Date(0),
    id: '1',
    chatId: 'chat-1',
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicatePolicyRevision: 0,
    duplicateHistoryRevision: 0,
    duplicateCompareMode: 'MESSAGE',
    duplicatePhotoEnabled: false,
    duplicatePhotoMatchPreset: 'SAME_IMAGE',
    duplicatePhotoScope: 'SAME_AUTHOR',
    duplicateDetectionPreset: 'STANDARD',
    duplicateIgnoreLinksEnabled: false,
    duplicateIgnorePhonesEnabled: false,
    duplicateNearMatchEnabled: false,
    duplicateWindowMode: 'INTERVAL',
    duplicateStartTimeMinutes: 540,
    duplicateEndTimeMinutes: 1080,
    duplicateTimezone: 'Europe/Moscow',
    duplicateWarnWindowSec: 12 * 60 * 60,
    duplicateWarnMaxCount: 2,
    duplicateMuteWindowSec: 24 * 60 * 60,
    duplicateMuteMaxCount: 3,
    duplicateMuteDurationHours: 6,
    duplicateBanWindowSec: 48 * 60 * 60,
    duplicateBanMaxCount: 4,
    linkPolicy: LinkPolicy.ALLOWLIST_ONLY,
    linkRulesPolicy: null,
    linkPolicyRevision: 1,
    linkPolicyEffectiveAt: new Date(),
    linkEscalationWindowHours: 24,
    linkWarnMaxCount: 2,
    linkMuteMaxCount: 3,
    linkBanMaxCount: 4,
    botSpeechStyle: null,
    botSpeechMedia: {},
    greetingEnabled: false,
    greetingBotMessageEnabled: true,
    greetingDeleteBotMessageEnabled: false,
    greetingDeleteBotMessageDelayMinutes: 2,
    greetingBotMessageText: '',
    greetingBotButtonEnabled: false,
    greetingBotButtonUrl: '',
    greetingBotButtonText: 'Открыть',
    greetingBotButtons: [],
    greetingRulesButtonEnabled: false,
    karavanStorefrontEnabled: false,
    karavanStorefrontAdminsOnly: false,
    karavanStorefrontMessageText: '',
    karavanStorefrontOpenButtonText: '',
    karavanStorefrontCatalogButtonText: '',
    karavanStorefrontCreateButtonText: '',
    deleteBotMessagesEnabled: true,
    deleteBotMessagesDelayMinutes: 2,
    removeBotsFromGroupEnabled: false,
    deleteSpammersEnabled: false,

    antiSpamEnabled: true,
    messageCountLimitEnabled: false,
    messageCountLimitMessages: 5,
    messageCountLimitWindowHours: 1,
    maxMessageLengthEnabled: false,
    maxMessageLength: 1500,
    photoMessageCooldownEnabled: false,
    photoMessageCooldownHours: 1,
    stickerMessageCooldownEnabled: false,
    stickerMessageCooldownMinutes: 5,
    photoMessagesEnabled: true,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    forwardedMessagesEnabled: true,
    phoneNumbersEnabled: true,
    phoneNumbersBotMessageEnabled: false,
    phoneNumbersBotMessageText: '',
    phoneNumbersWarnEnabled: false,
    phoneNumbersMuteEnabled: false,
    phoneNumbersMuteDurationHours: 6,
    phoneNumbersBanEnabled: false,
    phoneNumbersEscalationWindowHours: 12,
    phoneNumbersWarnMaxCount: 2,
    phoneNumbersMuteMaxCount: 3,
    phoneNumbersBanMaxCount: 4,
    phoneNumbersAdminContactButtonEnabled: false,
    phoneNumbersAdminContactButtonUrl: '',
    messageLimitsBlockedWords: [],
    stopWordsPolicy: null,
    stopWordsMedia: null,
    stopWordsRevision: 0,
    messageLimitsBlockedDomains: [],
    messageLimitsImageTextScanEnabled: false,
    messageLimitsBotMessageEnabled: false,
    messageLimitsBotMessageText: '',
    messageLimitsWarnEnabled: false,
    messageLimitsWarnMessageText: '',
    messageLimitsBanEnabled: false,
    messageLimitsMuteEnabled: false,
    messageLimitsMuteDurationHours: 6,
    messageLimitsAdminContactButtonEnabled: false,
    messageLimitsAdminContactButtonUrl: '',
    messageLimitsBotButtonEnabled: false,
    messageLimitsBotButtonUrl: '',
    messageLimitsBotButtonText: 'Открыть',
    messageLimitsBotButtons: [],
    russianProfanityFilterEnabled: true,
    profanitySensitivity: 'BALANCED',
    commercialAdsFilterEnabled: false,
    commercialAdsPolicy: null,
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    profanityBotMessageEnabled: false,
    profanityWarnEnabled: false,
    profanityBanEnabled: false,
    profanityMuteEnabled: false,
    profanityMuteDurationHours: 6,
    profanityAdminContactButtonEnabled: false,
    profanityAdminContactButtonUrl: '',
    textFiltersBotMessageEnabled: false,
    textFiltersBotMessageText: '',
    profanityBotMessageText: '',
    textFiltersWarnEnabled: false,
    textFiltersWarnMessageText: '',
    profanityWarnMessageText: '',
    textFiltersBanEnabled: false,
    textFiltersMuteEnabled: false,
    textFiltersMuteDurationHours: 6,
    textFiltersAdminContactButtonEnabled: false,
    textFiltersAdminContactButtonUrl: '',
    textFiltersBotButtonEnabled: false,
    textFiltersBotButtonUrl: '',
    textFiltersBotButtonText: 'Открыть',
    textFiltersBotButtons: [],
    textFiltersRulesButtonEnabled: false,
    nightModeEnabled: false,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: false,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageDeleteOnFirstMessageEnabled: false,
    nightModeOpenMessageText: '',
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: 'Открыть',
    nightModeBotButtons: [],
    nightModeRulesButtonEnabled: false,
    nightModeForceCloseEnabled: false,
    nightModeForceCloseForever: false,
    nightModeForceCloseHours: 8,
    nightModeForceCloseDays: 0,
    nightModeForceCloseUntil: '',
    requiredSubscriptionEnabled: false,
    requiredSubscriptionChannelIds: [],
    requiredSubscriptionBotMessageEnabled: true,
    requiredSubscriptionBotMessageText: '',
    requiredSubscriptionButtonText: '',
    requiredSubscriptionAdminContactButtonEnabled: false,
    requiredSubscriptionAdminContactButtonUrl: '',
    requiredSubscriptionWarnEnabled: false,
    requiredSubscriptionWarnMessageText: '',
    requiredSubscriptionBanEnabled: false,
    requiredSubscriptionMuteEnabled: false,
    requiredSubscriptionMuteDurationHours: 6,
    requiredSubscriptionDurationDays: 7,
    requiredSubscriptionExpiresAt: '',
    invitationAccessEnabled: false,
    invitationAccessRequiredCount: 1,
    invitationAccessBotMessageEnabled: true,
    invitationAccessBotMessageText: '',
    invitationAccessAdminContactButtonEnabled: false,
    invitationAccessAdminContactButtonUrl: '',
    invitationAccessWarnEnabled: false,
    invitationAccessWarnMessageText: '',
    invitationAccessBanEnabled: false,
    invitationAccessMuteEnabled: false,
    invitationAccessMuteDurationHours: 6,
    commentsEnabled: false,
    commentsAdminsEnabled: true,
    commentsAllEnabled: false,
    commentsChatBroadcastsEnabled: false,
    linkBotMessageEnabled: true,
    linkBotMessageText: '',
    linkWarnEnabled: false,
    linkWarnMessageText: '',
    linkBanEnabled: false,
    linkMuteEnabled: false,
    linkMuteDurationHours: 6,
    linkAdminContactButtonEnabled: false,
    linkAdminContactButtonUrl: '',
    linkBotButtonEnabled: false,
    linkBotButtonUrl: '',
    linkBotButtonText: 'Открыть',
    linkBotButtons: [],
    linkRulesButtonEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateBotMessageText: '',
    duplicateAdminContactButtonEnabled: false,
    duplicateAdminContactButtonUrl: '',
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
    duplicateBotButtons: [],
    duplicateRulesButtonEnabled: false,
    messageLimitsRulesButtonEnabled: false,
    rulesAttachViolationsEnabled: true,
    adminBanCommandName: 'бан',
    adminBanAllCommandName: 'Бан!',
    adminMuteCommandName: 'мут',
    adminPermanentMuteCommandName: 'мут 88',
    adminRulesCommandName: 'правило',
    adminSilenceCommandName: 'тишина',
    adminOpenChatCommandName: 'тишина выкл',
    adminMuteCommandAliases: 'мут, мьют, мью, mute',
    adminRulesCommandAliases: 'правило, правила, rule, rules',
    muteDurationHours: 6,
    warnThreshold: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    ...base,
    ...overrides,
  };
}

const DUPLICATE_SPAM_TEXT = 'продам курс по маркетингу пишите в личные сообщения сегодня скидка';

function duplicateNavigationTarget(url: string): NavigationTargetEvidence {
  return {
    kind: 'external_url',
    target: url,
    normalizedTarget: new URL(url).toString(),
    enforceable: true,
    origins: [],
  };
}

const COMMERCIAL_SENSITIVITY_PROFILES = {
  soft: {
    commercialAdsSensitivity: 'BALANCED' as const,
    commercialAdsWarnThreshold: 60,
    commercialAdsDeleteThreshold: 82,
  },
  balanced: {
    commercialAdsSensitivity: 'BALANCED' as const,
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
  },
  strict: {
    commercialAdsSensitivity: 'STRICT' as const,
    commercialAdsWarnThreshold: 38,
    commercialAdsDeleteThreshold: 55,
  },
};

function createRuleEngine(): RuleEngineService {
  return new RuleEngineService(new MockRedisCounterService() as never);
}

type BlockedWordDetectorInternals = {
  buildMessageLimitsBlockedWordPattern(value: string): RegExp;
  normalizeMessageLimitsBlockedWordToken(value: string): string | null;
  resolveMessageLimitsBlockedWordList(values: readonly string[]): unknown;
};

function getBlockedWordDetector(service: RuleEngineService): BlockedWordDetectorInternals {
  return (
    service as unknown as {
      messageLimitsDetector: { blockedWordDetector: BlockedWordDetectorInternals };
    }
  ).messageLimitsDetector.blockedWordDetector;
}

async function detectCommercialViolation(
  service: RuleEngineService,
  text: string,
  overrides: Partial<ChatSettings> = {},
  options: {
    commercialCampaignContext?: CommercialCampaignContext | null;
  } = {},
) {
  const result = await service.detect({
    chatId: 'chat-1',
    userId: 'u-1',
    text,
    settings: buildSettings({
      commercialAdsFilterEnabled: true,
      ...overrides,
    }),
    domainAllowlist: [],
    commercialCampaignContext: options.commercialCampaignContext,
  });

  return result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
}

describe('RuleEngineService', () => {
  it.each(['anti-spam-burst', 'message-count-limit'] as const)(
    'reports %s unavailable state while continuing independent blocked-word detection',
    async (rule) => {
      const diagnostics = {
        recordHotPathStageOutcome: jest
          .fn<
            ReturnType<RuntimeDiagnosticsService['recordHotPathStageOutcome']>,
            Parameters<RuntimeDiagnosticsService['recordHotPathStageOutcome']>
          >()
          .mockResolvedValue(undefined),
        recordHotPathProfile: jest
          .fn<
            ReturnType<RuntimeDiagnosticsService['recordHotPathProfile']>,
            Parameters<RuntimeDiagnosticsService['recordHotPathProfile']>
          >()
          .mockResolvedValue(undefined),
      } satisfies Pick<
        RuntimeDiagnosticsService,
        'recordHotPathStageOutcome' | 'recordHotPathProfile'
      >;
      const diagnosticsService = Object.assign(
        Object.create(RuntimeDiagnosticsService.prototype) as RuntimeDiagnosticsService,
        diagnostics,
      );
      const input = {
        chatId: 'chat-1',
        userId: 'u-1',
        messageId: 'message-1',
        duplicateStateEventTimestampMs: Date.now(),
        text: 'спаммаркер',
        domainAllowlist: [],
        settings: buildSettings({
          antiDuplicateEnabled: false,
          antiSpamEnabled: rule === 'anti-spam-burst',
          messageCountLimitEnabled: rule === 'message-count-limit',
          messageLimitsBlockedWords: ['спаммаркер'],
        }),
      };
      const counters = new MockRedisCounterService();
      jest
        .spyOn(counters, 'replaceRevisionedSetMembershipsBeforeDeadline')
        .mockResolvedValue({ kind: 'deadline_exceeded' });
      const timedOut = new RuleEngineService(
        counters as unknown as RedisCounterService,
        diagnosticsService,
      );
      const result = await timedOut.detect(input);
      expect(result.violations.map((value) => value.ruleCode)).toEqual(['MESSAGE_BLOCKED_WORD']);
      expect(diagnostics.recordHotPathStageOutcome.mock.calls).toEqual([
        [
          {
            stage: `rule-engine.${rule}`,
            outcome: 'timeout',
            failOpen: true,
          },
        ],
      ]);
      diagnostics.recordHotPathStageOutcome.mockClear();

      const unavailableRedis = {
        status: 'end',
        get: jest.fn<ReturnType<Redis['get']>, Parameters<Redis['get']>>(),
        eval: jest.fn<ReturnType<Redis['eval']>, []>(),
      } satisfies Pick<Redis, 'status' | 'get' | 'eval'>;
      const refusedCounters = Object.create(RedisCounterService.prototype) as RedisCounterService;
      Object.defineProperty(refusedCounters, 'redis', { value: unavailableRedis });
      const refused = new RuleEngineService(refusedCounters, diagnosticsService);
      const afterRefusal = await refused.detect({ ...input, messageId: 'message-2' });
      expect(afterRefusal.violations.map((value) => value.ruleCode)).toEqual([
        'MESSAGE_BLOCKED_WORD',
      ]);
      expect(unavailableRedis.get).not.toHaveBeenCalled();
      expect(unavailableRedis.eval).not.toHaveBeenCalled();
      expect(diagnostics.recordHotPathStageOutcome.mock.calls).toEqual([
        [
          {
            stage: `rule-engine.${rule}`,
            outcome: 'skip',
            failOpen: true,
          },
        ],
      ]);
    },
  );

  it('retains the legacy labelled-number signal for duplicate admission', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    for (const [index, text] of ['ИНН 9991234567', 'Артикул 89991234567'].entries()) {
      const input = {
        chatId: 'chat-1',
        userId: 'u-1',
        messageId: `label-${index}`,
        duplicateStateEventTimestampMs: Date.now() + index,
        text,
        domainAllowlist: [],
        settings: buildSettings({
          antiSpamEnabled: false,
          phoneNumbersEnabled: true,
          duplicateWarnMaxCount: 1,
          duplicateBotMessageEnabled: false,
          duplicateMuteEnabled: false,
          duplicateBanEnabled: false,
        }),
      };
      const first = await service.detect(input);
      const next = await service.detect({
        ...input,
        messageId: `label-${index}-next`,
        duplicateStateEventTimestampMs: input.duplicateStateEventTimestampMs + 1,
      });
      expect(first.duplicateDecision).toBeUndefined();
      expect(next.duplicateDecision).toMatchObject({ action: 'WARN', threshold: 1 });
      expect(next.violations.some((value) => value.ruleCode === 'PHONE_NUMBER_BLOCKED')).toBe(
        false,
      );
    }
  });

  it('ships with 2000+ exact profanity and insult variants', () => {
    expect(PROFANITY_EXACT_VARIANT_COUNT).toBeGreaterThanOrEqual(2000);
  });

  it('ships with a targeted-insult lexicon for ambiguous user-directed abuse', () => {
    expect(TARGETED_INSULT_VARIANT_COUNT).toBeGreaterThanOrEqual(250);
  });

  it('detects profanity and blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты блять иди на http://bad.com',
      settings: buildSettings(),
      domainAllowlist: ['https://example.com'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it.each([
    ['transport only', '', {}, []],
    ['profanity', ' блять', {}, ['PROFANITY']],
    [
      'blocked word',
      ' фиалка',
      { messageLimitsBlockedWords: ['фиалка'] },
      ['MESSAGE_BLOCKED_WORD'],
    ],
    ['blocked phone', '', { phoneNumbersEnabled: false }, ['PHONE_NUMBER_BLOCKED']],
  ])(
    'keeps ambiguous-transport review telemetry alongside %s detection',
    async (_label, suffix, overrides, additionalRuleCodes) => {
      const service = createRuleEngine();
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: `Водитель Абакан-Аскиз-ст. Аскиза 11.40-12.00 +7 900 000 00 00 с места до места завтра${suffix}`,
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          ...overrides,
        }),
        domainAllowlist: [],
      });
      const commercial = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');

      expect(commercial?.metadata).toEqual(
        expect.objectContaining({
          actionBand: 'REVIEW_ONLY',
          actionable: false,
          recordable: false,
          matchedSignals: expect.arrayContaining(['review-only:transport-door-to-door-operator']),
        }),
      );
      for (const ruleCode of additionalRuleCodes) {
        expect(result.violations.some((item) => item.ruleCode === ruleCode)).toBe(true);
      }
    },
  );

  it('propagates a bounded duplicate-state timeout so the webhook retries', async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const redisCounter = {
      replaceRevisionedSetMembershipsBeforeDeadline: jest
        .fn()
        .mockImplementation(() => new Promise<never>(() => undefined)),
    };
    const service = new RuleEngineService(redisCounter as never);
    const resultPromise = service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      messageId: 'message-1',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_000,
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings({
        antiDuplicateEnabled: true,
        antiSpamEnabled: false,
        commercialAdsFilterEnabled: false,
        duplicateBotMessageEnabled: false,
      }),
      domainAllowlist: [],
    });
    const rejected = expect(resultPromise).rejects.toMatchObject({
      code: 'DUPLICATE_STATE_BUDGET_EXCEEDED',
      retryable: true,
    });

    await jest.advanceTimersByTimeAsync(DUPLICATE_STATE_BUDGET_MS);

    await rejected;
    expect(redisCounter.replaceRevisionedSetMembershipsBeforeDeadline).toHaveBeenCalledTimes(1);
    consoleWarnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('fails open when anti-spam burst lookup stalls', async () => {
    jest.useFakeTimers();
    try {
      const redisCounter = {
        incrementWithTtl: jest.fn().mockImplementation(
          () =>
            new Promise<number>(() => {
              // Intentionally never resolves.
            }),
        ),
      };
      const service = new RuleEngineService(redisCounter as never);
      const resultPromise = service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: '',
        settings: buildSettings({
          antiDuplicateEnabled: false,
          antiSpamEnabled: true,
          commercialAdsFilterEnabled: false,
        }),
        domainAllowlist: [],
      });

      await jest.advanceTimersByTimeAsync(150);
      const result = await resultPromise;

      expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_RATE_LIMIT')).toBe(false);
      expect(redisCounter.incrementWithTtl).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('logs inner slow-stage breakdown with delta timings', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dateNowSpy = jest.spyOn(Date, 'now');
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    let now = 10_000;
    dateNowSpy.mockImplementation(() => now);
    jest.spyOn(service as any, 'detectProfanity').mockImplementation(() => {
      now += 3_400;
      return null;
    });

    try {
      await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'обычное длинное сообщение без ссылок и без нарушений',
        settings: buildSettings({
          antiDuplicateEnabled: true,
          commercialAdsFilterEnabled: false,
        }),
        domainAllowlist: [],
      });

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(consoleWarnSpy.mock.calls[0]?.[0] ?? '{}'));
      expect(payload.msg).toBe('Slow rule-engine detect completed close to the hot-path deadline');
      expect(payload.chatId).toBe('chat-1');
      expect(payload.latestStage).toBe('media-cooldowns');
      expect(payload.stageDurations.profanity).toBe(3400);
      expect(payload.stageTimelineMs.profanity).toBeGreaterThanOrEqual(3400);
      expect(payload.stageDurations['duplicate-state']).toBe(0);
      expect(payload.stageDurations['media-cooldowns']).toBe(0);
    } finally {
      consoleWarnSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
  });

  it('allows only exact allowlisted links in ALLOWLIST_ONLY mode', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const allowed = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/channel/news',
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news'],
    });
    const blocked = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/channel/another',
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news'],
    });

    expect(allowed.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
    expect(blocked.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('normalizes legacy allowlist entries to canonical full-link matching', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/old/path?x=1',
      settings: buildSettings(),
      domainAllowlist: ['max.ru/old/path?x=1'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('allows exact allowlisted links wrapped in trailing punctuation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри [https://max.ru/channel/news]:',
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('still blocks a MAX media URL when it is not removed as forwarded media metadata', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const inviteUrl = 'https://max.ru/join/allowed-forwarded-invite';
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: `${inviteUrl} https://i.oneme.ru/i?r=text-only-forwarded-url`,
      settings: buildSettings(),
      domainAllowlist: [inviteUrl],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('allows any path on an allowlisted domain rule', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const allowed = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://docs.max.ru/mini-apps/start?from=chat',
      settings: buildSettings(),
      domainAllowlist: ['domain:docs.max.ru'],
    });
    const allowedSubdomain = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://sub.docs.max.ru/mini-apps/start',
      settings: buildSettings(),
      domainAllowlist: ['domain:docs.max.ru'],
    });
    const blocked = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://bad-docs.max.ru/mini-apps/start',
      settings: buildSettings(),
      domainAllowlist: ['domain:docs.max.ru'],
    });

    expect(allowed.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
    expect(allowedSubdomain.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(
      false,
    );
    expect(blocked.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('does not broaden a www domain rule to its parent domain', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://ozon.ru/product/123',
      settings: buildSettings({
        messageLimitsBlockedDomains: ['ozon.ru'],
      }),
      domainAllowlist: ['domain:www.ozon.ru'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_DOMAIN')).toBe(true);
  });

  it('does not apply blocked-domain limits to links covered by a domain allowlist rule', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://sub.docs.max.ru/mini-apps/start',
      settings: buildSettings({
        messageLimitsBlockedDomains: ['docs.max.ru'],
      }),
      domainAllowlist: ['domain:docs.max.ru'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_DOMAIN')).toBe(
      false,
    );
  });

  it('does not apply blocked-domain limits to an exact allowlisted link', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      messageLimitsBlockedDomains: ['docs.max.ru'],
    });
    const domainAllowlist = ['https://docs.max.ru/mini-apps/start?from=chat'];

    const allowed = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://docs.max.ru/mini-apps/start?from=chat',
      settings,
      domainAllowlist,
    });
    const blockedOtherPath = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://docs.max.ru/mini-apps/other',
      settings,
      domainAllowlist,
    });

    expect(allowed.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
    expect(allowed.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_DOMAIN')).toBe(
      false,
    );
    expect(blockedOtherPath.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
    expect(
      blockedOtherPath.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_DOMAIN'),
    ).toBe(true);
  });

  it('keeps exact links on vk.com and vk.ru distinct', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://vk.ru/studia_svetlana_armavir',
      settings: buildSettings(),
      domainAllowlist: ['https://vk.com/studia_svetlana_armavir'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('detects blocked links with unicode domains', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'вакансии https://центр-занятости-иркутск38.рф',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('detects bare MAX invite links without scheme', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'вступай max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObUh',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('blocks bare domains in ALLOWLIST_ONLY mode', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'подробнее на bad.com',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('blocks bare unicode domains in ALLOWLIST_ONLY mode', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'каталог мебельтюмень.рф',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('does not treat dotted russian words as blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам кузов Нивы.Весь перевареный, документы есть',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not treat dotted addresses as blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'х.Тверской ул.Первомайская,34',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not treat decimal values as blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Завтра доставка после 18.00 Куплю 30 шт.',
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not treat numbered cultivar list items as blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: [
        'Доброе утро!',
        '2.Humako Inches',
        '5.Dn-Bora Bora',
        '8.Dn- Цвет Сакуры',
        'тел.89883218131',
      ].join('\n'),
      settings: buildSettings({
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not shorten an exact allowlist URL at encoded whitespace', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
      settings: buildSettings(),
      domainAllowlist: [
        'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU%20MAX%20%D0%BF%D0%BE%D0%B7%D0%B2%D0%BE%D0%BB%D1%8F%D0%B5%D1%82%20%D0%BE%D1%82%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D1%8F%D1%82%D1%8C',
      ],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('ignores bare branded domains when an exact allowlisted URL is present', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'https://ura.news/news/1053075490 Читайте на URA.RU',
      settings: buildSettings(),
      domainAllowlist: ['https://ura.news/news/1053075490'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('ignores a preceding bare branded domain when the same message has an exact allowlisted URL', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Читайте на URA.RU https://ura.news/news/1053075490',
      settings: buildSettings(),
      domainAllowlist: ['https://ura.news/news/1053075490'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('blocks bare domains that are not backed by an allowlisted URL in the same message', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Читайте на URA.RU',
      settings: buildSettings(),
      domainAllowlist: ['https://ura.news/news/1053075490'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('does not detect PROFANITY when russian profanity filter is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты сука',
      settings: buildSettings({ russianProfanityFilterEnabled: false }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('detects PROFANITY in obfuscated russian mat with separators', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'да ты х*у_й какой-то',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY in core mat forms with common prefixes', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'мне похуй, ты меня заебал',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for common russian insults without mat roots', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты идиот и мразь',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for common abusive russian words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'сука, вы мудачье, гандоны и ублюдки',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for targeted ambiguous russian insults', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = [
      'ты полный дурак',
      'вы все бараны',
      'ты реально даун',
      'этот псих пишет опять',
      'додик, уйди из чата',
      'ty durak',
      'ты кретин',
      'ну ты кретин',
      'какой же ты кретин',
      'кретин, уйди из чата',
    ];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings({ profanitySensitivity: 'STRICT' }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('does not detect PROFANITY for numeric size and horsepower notation from production logs', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = [
      '✅Обувь Р. 36/37. За всё 500. Ост. Больница КТ.',
      '36/37р',
      '36-37р, цена 800р, новые',
      'Бензопила, мощность 3.6 л.с.',
      'Мотор 36 л.с., бензин.',
      'Продам бензопилу -6.10 лошадиных силы.',
    ];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
    }
  });

  it('keeps numeric-looking abuse blocked outside safe notation contexts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты 36л конечно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('does not detect PROFANITY for first-person mild self-deprecation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Получается я тоже кретин 😁',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('detects PROFANITY for third-person targeted russian insults', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = [
      'он полный баран и лошара',
      'она просто крыса, не верьте ей',
      'они настоящие козлы',
    ];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings({ profanitySensitivity: 'STRICT' }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('does not detect PROFANITY for safe exception words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'подстрахуй меня, это педикюр и сукно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for ambiguous insults in non-abusive russian contexts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = [
      'Вы продаете барана или только петухов?',
      'Фонд помогает семьям, где есть ребенок с синдромом Дауна.',
      'Психолог объяснил, как поддержать аутиста в школе.',
      'Он аутист, ему нужна спокойная среда и понятные инструкции.',
      'Она алкоголик в ремиссии, семья ищет группу поддержки.',
      'Он психиатр, а не псих, прием ведет по записи.',
      'В редакторе выбран жирный шрифт для заголовка.',
      'На ферме овцы, козлы, петухи и свиньи.',
      'Книга Идиот Достоевского есть в школьной программе.',
      'Конченный файл выгрузки помечен как завершенный, документы готовы.',
    ];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
    }
  });

  it('does not detect PROFANITY for canine context around "сука" in pet ads', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Чита. Срочно отдаётся собака, охранница. Сука, крупная. Стерилизованная, привитая. Привезу.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for canine context around derived female-dog forms', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Питомник продает щенка: сучка с родословной, привита, паспорт есть.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for production ad reach typo "за суки" in metric context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Размещение в канале: подписчиков 3800, охват 1к+- за суки, CPM 650.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for livestock context around "скотина" in farm posts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ферма продаёт КРС: скотина на выпасе, коровы и бычки привиты, есть телята.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for livestock sales copy with "скотина" in neutral farm context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Принимаем заказы на свежую говядину. Скотина с частного хозяйства, выращена на натуральном откорме, без химии.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for parasite context around "гнида"', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Мошка начинается в мае, эта гнида хоть и маленькая, но после её укусов всё чешется.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in neutral words that contain "ебе" fragment', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Доставлю щебень и песок тебе до подъезда',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in neutral words with "ебл" fragment', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Важно потреблять воду и поддерживать режим',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in neutral words with "дебилитац" fragment', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'После травмы началась длительная дебилитация организма',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in url paths that start with latin "eb"', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Фото здесь https://disk.yandex.ru/d/EBjA4MZie9N5YA',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in pure latin acronyms like EBD', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам Форд Фокус 3, комплектация EBD и ABS',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in neutral age labels with standalone digits', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Подходит взрослым и детям от 6 лет',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY in safe mixed latin/cyrillic russian words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Cпил дepевьев c вывозом, быстро и безопасно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for Hyundai car ads with mixed latin/cyrillic text', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Срочная продажа от собственника. Прeкpaсный, удобный и функциoнальный автомобиль. Hyundai Santa Fe 2010г. Подробности по телефону.',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for latin product names like XUPING', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ювелирная бижутерия XUPING, медицинский сплав, серьги и браслеты в наличии',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for surname-like forms such as "Гандонова"', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Вот не даст точно, Гандонова сегодня опять шутит',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('detects PROFANITY for added high-confidence abusive russian words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты падла, мудозвон и засранец',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for added vulgar and insulting families', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'опять эти залупы, шалавы и стервы',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('still detects PROFANITY for explicit "е*бать" form', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Е*бать, ну и новость',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for transliterated added abusive nouns', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'nu ty padla i mudozvon, a oni shalavy',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY when russian mat is split into short spaced tokens', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ну ты б л я т ь конечно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY when russian insult is split into short spaced tokens', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ну ты с у к а конечно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY when longer russian insults are split into letters or chunks', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = ['д о л б о е б', 'у б л ю д о к', 'деб и л', 'пидо рас', 'бл я ть'];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('detects PROFANITY when mat is split by punctuation, emoji, or latin chunks', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = [
      'б . л . я . т . ь, хватит уже',
      'п . и . з . д . @ чату',
      'p i z d a v etom chate',
      'b l y @ t, ostanovis',
      'h u y tebe, a ne dostup',
    ];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('detects PROFANITY for additional high-confidence vulgar forms', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = ['да ну нахер это всё', 'полная херня в чате', 'епта, опять началось'];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('still detects PROFANITY in digit-obfuscated russian mat token', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ну ты 6лять конечно',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY in mixed-script and leetspeak mat obfuscations', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = ['бл@ть', 'бл9ть', 'пuзда', 'хуu', 'мр@зь', 'p1zda', 'pizd@'];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
    }
  });

  it('detects PROFANITY in latin transliteration of russian mat roots', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'zaebal uzhe etot spam',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('still detects PROFANITY for transliterated xuy-family forms', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'mne pohuy na etot spam',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for transliterated russian insults from the exact lexicon', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'nu ty pidor i mudak',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for narrow typo spellings and colloquial misspellings', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ну ты сцука, дибил и далбаеп',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for narrow transliterated typo spellings', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'nu ty pedor i mudag',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('detects PROFANITY for expanded high-confidence abusive lexicon families', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты полный лошара, быдло и тупорылый недоумок',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('does not detect PROFANITY for safe names like Pedro', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Педро и Pedro пришли на тренировку вовремя',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for safe words near expanded insult roots', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Хамлет, Hamlet, лохматый пес и dermatology курс приехали на выставку',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('does not detect PROFANITY for safe words around newly covered roots', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const samples = [
      'Херсонская область упоминается в новости без оценок.',
      'Гаврилов подтвердил запись на прием.',
      'В английском примере her book starts the sentence.',
      'Код заявки ПЗДЦ-2026 оставьте в таблице.',
    ];

    for (const text of samples) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings(),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
    }
  });

  it('detects PROFANITY for lexicon-only productive insult variants', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ты пидорнутый мудачина, это дебилизм',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(true);
  });

  it('does not detect PROFANITY for surnames and names with profanity-like prefixes', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сукачев, Sukarno, Пидоренко и Pidorenko приехали на регистрацию',
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PROFANITY')).toBe(false);
  });

  it('detects COMMERCIAL_AD when russian ad markers are present', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам курс, скидка 50%, пишите в лс, цена 3000 руб',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it.each(['ALLOW', 'BLOCK'] as const)(
    'applies the explicit %s services rule while preserving independent blocked-word detection',
    async (action) => {
      const policy = createDefaultCommercialAdsPolicy();
      policy.categories.SERVICES = action;
      const result = await createRuleEngine().detect({
        chatId: 'chat-1',
        userId: '10000007',
        text: 'Ремонтируем стиральные машины. Выезд ежедневно, гарантия. Принимаем заказы, запись по телефону +7 900 000 10 42.',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsPolicy: policy,
          messageLimitsBlockedWords: ['гарантия'],
        }),
        domainAllowlist: [],
      });
      const commercial = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
      expect(commercial?.metadata).toMatchObject({
        commercialAdsCategories: ['SERVICES'],
        commercialAdsPolicyReason: action === 'ALLOW' ? 'CATEGORY_ALLOWED' : 'BLOCKED_CATEGORY',
        messageDisposition: action === 'ALLOW' ? 'KEEP' : 'DELETE',
        actionable: action === 'BLOCK',
      });
      if (action === 'ALLOW') {
        expect(commercial?.metadata).toMatchObject({
          actionBand: 'REVIEW_ONLY',
          recordable: false,
        });
      }
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            metadata: expect.objectContaining({ blockedWord: 'гарантия' }),
          }),
        ]),
      );
    },
  );

  it('classifies COMMERCIAL_AD as HIGH with price and contact combo', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам курс, скидка 20%, цена 3000 руб, звоните и пишите в лс https://t.me/example',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).toBe('HIGH');
  });

  it('does not detect COMMERCIAL_AD for promo mention without sale context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Скидка? кто подскажет, где посмотреть',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('keeps borderline commercial copy below detection on soft sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Скидка на курс, пишите в лс',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 60,
        commercialAdsDeleteThreshold: 82,
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('catches the same borderline commercial copy on strict sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Скидка на курс, пишите в лс',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
        commercialAdsWarnThreshold: 40,
        commercialAdsDeleteThreshold: 58,
      }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.decisionBand).toBe('HIGH');
  });

  it('detects COMMERCIAL_AD with +7 phone and records phone signal', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам курс, звоните +7 (999) 123-45-67',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toContain('contact:phone');
  });

  it('detects commercial beauty ad when salon promo context is present', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Салон маникюра: акция недели, запись открыта, пишите в директ',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('does not detect COMMERCIAL_AD for private sale without promo context', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам кофемашину, пишите в лс',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('does not detect COMMERCIAL_AD for private sale with marketplace link and self-pickup', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам галоши, самовывоз, авито: https://www.avito.ru/item123',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('detects explicit service ad with phone on balanced sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Услуги сантехника, звоните +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects direct service ad with phone on strict sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Услуги сантехника, звоните +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects service ad with channel link on balanced sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Запись на маникюр, подробности в канале https://t.me/beauty_room',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects private service ad with phone on strict sensitivity when service intent is explicit', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Запись на маникюр по телефону +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects buyout ad from real logs with phone numbers', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Выкупаем старую зерноочистительную технику в любом состоянии. +79271992333 +79603324233',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects commercial group invite from real logs with max link', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Приглашаю в свою группу Цветовод. Где можно покупать, продавать обмениваться цветами и опытом. Группа в MAX https://max.ru/join/RNzP5wpdj-U1n8shWC1R0M8hj50MyRIAiIcYsJ5BVu8',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects bare MAX group promotion without relying on campaign repetition', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Доброго времени суток! Присоединяйтесь к нашей группе. Купи-Продай Родино. Будем рады каждому участнику! https://max.ru/join/Obusdfb6l0Bn6CdmZnOUPpcZiLrclx6r44s7FcAprEo',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['group:группа', 'group-promo:присоединяйтесь', 'deal-channel:link']),
    );
  });

  it('detects recruitment ad with salary and contact', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Вакансия: доход от 5000 в смену, отклики в тг',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('classifies restaurant team search copy from production audit as recruitment', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Новый большой бар открывает набор сотрудников. Ищем ярких людей: официанты, хостес, менеджеры, бармены. Ставка 5000 за смену, контакт для связи +7 900 000 00 23 https://t.me/hr_bar',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.primarySubtype).toBe('RECRUITMENT');
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['recruitment:набор', 'recruitment:ищет-команду']),
    );
  });

  it('does not detect COMMERCIAL_AD for private sale with phone only', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам детскую коляску, звоните +7 (999) 123-45-67',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('does not detect private kit sale from real logs just because it says набор', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'ПРОДАМ набор инструментов. 89029673914',
    );

    expect(violation).toBeUndefined();
  });

  it('does not detect bobrovaya stream ad from real logs by confusing it with eyebrow services', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'БОБРОВАЯ СТРУЯ 🦫 БАРСУЧИЙ ЖИР 🦡 Тел.89179343764',
    );

    expect(violation).toBeUndefined();
    expect(
      service.hasCommercialSpamMarkers('БОБРОВАЯ СТРУЯ 🦫 БАРСУЧИЙ ЖИР 🦡 Тел.89179343764'),
    ).toBe(false);
  });

  it('does not detect private property listing from real logs when store mention is just area context', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Продается 2х комнатная квартира п 41.8 кв. м. По адресу: Самарская обл., Волжский р-н, п. Придорожный. Квартира на первом этаже, теплая, индивидуальное отопление. В поселке есть магазин. Поселок тихий. Звонить 89608477286',
    );

    expect(violation).toBeUndefined();
  });

  it('does not detect private baby gear listing with phone on strict sensitivity', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продам детскую коляску, звоните +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('detects commercial baby goods retail when stock and delivery context are present', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Продаем детские коляски, новые модели в наличии, доставка по городу, цены от 12000 руб, звоните +7 (999) 123-45-67',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    const violation = result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['intent:продаем', 'promo:доставк', 'contact:phone']),
    );
  });

  it('does not detect COMMERCIAL_AD for non-sales request without contacts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ищу мастера, кто подскажет по ремонту?',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('does not detect household request for master from real logs even with phone callback details', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Нужен мастер собрать, навесть кухню 2 метра. Врезать мойку. Писать в личку либо по телефону 8 912 433 93 18.',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it('does not detect personal experience question with promo words and reply CTA', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Здравствуйте, кому нибудь предлагали скидку или займ при покупке квартиры? Если да, то напишите мне в личку пожалуйста',
      {
        commercialAdsSensitivity: 'BALANCED',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('does not detect request for service specialist from real logs when user is looking for help', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Ищу мастера по маникюра в Южном. можно кто на дому принимает тоже, отзовитесь в личку пожалуйста',
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'STRICT',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
  });

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect recommendation request for store with site link on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Подскажите хороший магазин дверей, кто заказывал? Вот сайт https://dveri.example.ru',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect recommendation request for salon channel on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Посоветуйте салон маникюра, пожалуйста. Нашла этот канал https://t.me/nailsalon',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect recommendation request for specialist with found phone on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Кто знает хорошего электрика? Нашла номер 8 912 000 00 00, это нормальный мастер?',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect website developer recommendation request on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Подскажите разработчика сайтов, кто делал лендинг и сколько примерно стоит?',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect household search for brigade even with reply CTA on %s sensitivity',
    async (sensitivity) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'Ищу бригаду на ремонт, писать в личку',
        settings: buildSettings({
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: sensitivity,
        }),
        domainAllowlist: [],
      });

      expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(false);
    },
  );

  it('detects strict service ad from production-style phone log', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      '8-993-126-15-74 откачка септика 5 кубов. Выезжаем по Вашему звонку !',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'contact:phone',
        'service-specialty:септик',
        'service-specialty:откачк',
        'combo:strict-phone+self-promo',
      ]),
    );
  });

  it('does not detect private vehicle sale with price and phone from production-style log', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Продам Опель Цена 70000 Звонить 89237272466',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('does not detect private vehicle listing when car interior says salon', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Тойота королла 2000, 1,5. Собственник! 500к Торг. Машина в хорошем состоянии. Коробка и двигатель в норме, салон хороший, по всем вопросам по телефону 89247509666',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('does not detect private pet rehome post just because delivery and phone are present', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Щеночки мальчик и 2 девочки ищут дом. Им 1,5 месяца. Будут средние, уличное содержание +7-914-471-68-90. Доставка',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('does not detect rideshare free seats as channel placement', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Еду в город, есть свободные места, могу забрать с адреса. Водитель 89828862767',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
    expect(
      service.hasCommercialSpamMarkers(
        'Еду в город, есть свободные места, могу забрать с адреса. Водитель 89828862767',
      ),
    ).toBe(false);
  });

  it('detects commercial digital service ads with prices in private messages', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Разработка сайтов и чат-ботов для бизнеса. Портфолио и цены в лс.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'service-specialty:разработк',
        'service-specialty:digital-service',
        'contact:в лс',
      ]),
    );
  });

  it.each([
    'Ремонт квартир, звоните 8 999 123 45 67',
    'Электрик, звоните 8 999 123 45 67',
    'Маникюр, пишите в личку',
    'Клининг квартир, whatsapp 8 999 123 45 67',
    'Настрою рекламу и сделаю лендинг, цены в лс',
  ])('detects bare service ad on balanced sensitivity: %s', async (text) => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text,
      settings: buildSettings({
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: 'BALANCED',
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('keeps fast commercial marker helper aligned for recommendation requests', () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    expect(
      service.hasCommercialSpamMarkers(
        'Подскажите хороший магазин дверей, кто заказывал? Вот сайт https://dveri.example.ru',
      ),
    ).toBe(false);
  });

  it('keeps fast commercial marker helper aligned for bare service ads', () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    expect(service.hasCommercialSpamMarkers('Электрик, звоните 8 999 123 45 67')).toBe(true);
  });

  it('does not detect job-seeking resume style message from real moderation logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Ищу вахту Охрана 15/15 зп от 6500 смена. 6 разряд водительское удостоверение категория В. все справки имеются предложение пишите в Личные Сообщения!',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('detects commercial audience growth invite from real moderation logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Чат для поиска подписчиков и клиентов для ваших проектов. https://max.ru/join/9_D9-tNFZkd1Nfrp9BuYpKnOdAFes0A5V_AHqn-94rQ',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['group:чат', 'audience:клиент', 'deal-channel:link']),
    );
  });

  it('detects channel placement ad from enabled 2026 logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      '💥💥💥 Каналы на трафике. Перелива нет. Взрослая МЦА аудитория. 2500р 1/48. При покупке во всех каналах скидка 7700р. Пишите в MAX.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'channel-placement:каналы на трафике',
        'channel-placement:1/48',
        'transaction:price',
      ]),
    );
    expect(violation?.metadata?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(violation?.metadata?.reviewRecommended).toBe(false);
  });

  it('detects broker real-estate ad with commission and showing signals from enabled logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'ЖК Отражение. Тип квартиры: Евро 2к. Площадь 36 м². Отделка: ремонт мебель техника. Квартира на ключах. Показ 24/7. Ваша комиссия сверху. Цена 6 300 000 ₽. Звоните прямо сейчас: +7-952-523-48-42.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'property-agent:на-ключах',
        'property-agent:показ-247',
        'property-agent:комиссия-сверху',
      ]),
    );
    expect(violation?.metadata?.primarySubtype).toBe('PROPERTY_AGENT');
    expect(violation?.metadata?.reviewRecommended).toBe(false);
  });

  it('does not detect owner rental listing from real logs even with repair and phone', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Сдаётся уютная 2х комнатная квартира в районе Мкк г. Ялуторовска. В квартире хороший ремонт. Имеется застекленный балкон. Вся мебель и техника в наличии. Сдаётся на длительный срок, ответственным арендаторам. +7 900 000 00 00.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('detects house repair and lifting service from real logs after property-noise tuning', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Участником сво и пенсионерам скидка 35%. Подъем домов и бань, ремонт и строительство. Поднятие зданий и сооружений. Замена нижних венцов. Строительство беседок, террас, веранд и пристроек. Устройство и ремонт фундаментов, отмосток. Звоните +7 900 000 00 00.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'promo:скидк',
        'service-specialty:подъем-домов',
        'service-specialty:ремонт-фундаментов',
      ]),
    );
  });

  it('detects promo goods sale with samovyvoz when service and deal signals are strong', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Распродажа! Пена монтажная под пистолет 65л. Лето. 800 грамм, по 350 р. Самовывоз ул. Республиканская 32. ЭкономСтрой ДВ. +7 909 853 90 88.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['promo:распродаж', 'service-specialty:монтаж', 'transaction:price']),
    );
  });

  it('detects broker real-estate ad when your commission is implied by your markup', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Однушка Российский. Ремонт мебель техника. 43 кв, 4/7 этаж без лифта. Разбивка. Ваши сверху, любой заклад. Виктория +7 918 254 32 84.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['property-agent:комиссия-сверху']),
    );
  });

  it('does not add marketplace ozon signal for ozonation service ads', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Мытье окон, балконов, уборка любых помещений, химчистка ковролина, мягкой мебели, озонирование помещений для избавления от запахов. 89649606739.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).not.toEqual(
      expect.arrayContaining(['business:озон', 'business:ozon']),
    );
  });

  it('does not add club group signal for strawberry promotions from real logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Распродажа. Рассада клубники Клери 20 руб за штуку, Азия 20 руб за штуку. В наличии много сортов. Отправка по всей России. Сдек, Яндекс, пятерочка 89002600000.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).not.toEqual(expect.arrayContaining(['group:клуб']));
  });

  it('boosts a borderline service ad when the same sender repeats it across chats', async () => {
    const service = createRuleEngine();
    const text = 'Электрик, звоните 8 999 123 45 67';
    const withoutCampaign = await detectCommercialViolation(service, text, {
      ...COMMERCIAL_SENSITIVITY_PROFILES.soft,
    });
    const withCampaign = await detectCommercialViolation(
      service,
      text,
      {
        ...COMMERCIAL_SENSITIVITY_PROFILES.soft,
      },
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 4,
          sameTextDistinctChatCount: 3,
          repeatedPhoneDistinctChatCount: 3,
          repeatedLinkDistinctChatCount: 0,
        },
      },
    );

    expect(withoutCampaign).toBeUndefined();
    expect(withCampaign).toBeDefined();
    expect(withCampaign?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'campaign:cross-chat-text',
        'campaign:sender-multi-chat',
        'combo:campaign+self-promo',
      ]),
    );
    expect(withCampaign?.metadata?.primarySubtype).toBe('SERVICES');
    expect(withCampaign?.metadata?.reviewRecommended).toBe(true);
    expect(withCampaign?.metadata?.reviewReasons).toEqual(
      expect.arrayContaining(['campaign-dependent']),
    );
  });

  it('does not let campaign repetition override a private owner rental listing', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Сдаётся уютная 2х комнатная квартира в районе Мкк г. Ялуторовска. В квартире хороший ремонт. Имеется застекленный балкон. Вся мебель и техника в наличии. Сдаётся на длительный срок, ответственным арендаторам. +7 900 000 00 00.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 5,
          sameTextDistinctChatCount: 4,
          repeatedPhoneDistinctChatCount: 4,
          repeatedLinkDistinctChatCount: 0,
        },
      },
    );

    expect(violation).toBeUndefined();
  });

  it('does not let campaign repetition override a private apartment sale phrased as "продаю"', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Продаю, недорого 3х комнатную квартиру в селе Подлужном вопросы только по телефону +7 900 000 00 21',
      {
        commercialAdsSensitivity: 'STRICT',
      },
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 5,
          sameTextDistinctChatCount: 4,
          repeatedPhoneDistinctChatCount: 4,
          repeatedLinkDistinctChatCount: 0,
        },
      },
    );

    expect(violation).toBeUndefined();
  });

  it('does not treat a short low-quantity private item listing as retail inventory', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Фитолампа для комнатных растений, в наличии 2 шт, по 500 р каждая. +7 900 000 00 22',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  it('does not let campaign repetition override wellness diary content without direct deal evidence', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Завтра быстрый и вкусный завтрак: огурец, зелень, сыр, яйцо, греческий йогурт. После завтрака коллаген. Сегодня снова записи по самочувствию и питанию, курс привычек идет спокойно.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 5,
          sameTextDistinctChatCount: 4,
          repeatedPhoneDistinctChatCount: 0,
          repeatedLinkDistinctChatCount: 0,
        },
      },
    );

    expect(violation).toBeUndefined();
  });

  it('detects self-promotional craft offer from real logs when contact is in personal messages and phone', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Кому нужно сделать иконостас, пишите в личные сообщения +79253552639 Отправлю в любой населённый пункт Большая просьба поделится объявлением! Сохраняйте номер телефона!',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'intent:кому нужно сделать',
        'contact:пишите в личные сообщения',
        'contact:phone',
      ]),
    );
  });

  it('detects product catalog ad from real moderation logs', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Диваны на прямую от производителя. Самые доступные цены у нас. Пишите скинем каталог. Есть доставка по региону. Оплата при получении.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'business:каталог',
        'promo:доставк',
        'transaction:keywords',
        'combo:promo+deal',
        'combo:business+deal',
      ]),
    );
  });

  it('detects commercial MAX chat directory ads without treating "коммерции" as real estate', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      [
        'Чаты Max: Чат Пиар MAX, Взаимная подписка MAX, Чат коммерции NO LIMITS, Доска объявлений MAX.',
        'Каналы в Max: Взаимная подписка без отписок + реакции.',
        'https://max.ru/join/UzimHdYPoOS_Es3ll3chlhI4fanZOoZEn6smVqR_C2E',
      ].join(' '),
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['channel-placement:взаимная подписка', 'deal-channel:link']),
    );
    expect(violation?.metadata?.matchedSignals).not.toEqual(
      expect.arrayContaining(['property-commercial:commercial-space']),
    );
  });

  it('detects vakhata recruitment ads with salary ranges and application links', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'ВАХТА - выезд через 1-3 дня. Ферма с коровами, легкая работа, 3400-3600 ₽ за смену от 45 смен, питание и проживание, покупаем билет до 7000 ₽. Запись тут https://vk.ru/wall1086491776_1223',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.primarySubtype).toBe('RECRUITMENT');
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'recruitment:вахт',
        'recruitment:вахта-условия',
        'deal-channel:link',
      ]),
    );
  });

  it('detects paid MAX group promo and directory posts from recent audit misses', async () => {
    const service = createRuleEngine();
    const paidPromo = await detectCommercialViolation(
      service,
      'Реклама вашей группы. Рассылка. Стоимость 50р. Фотоотчёт. Все вопросы в личные сообщения.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const directory = await detectCommercialViolation(
      service,
      'ГРУППЫ В МАХ: 1) Барахолка Тюмень https://max.ru/join/abc 2) Московский тракт https://max.ru/join/def',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(paidPromo).toBeDefined();
    expect(paidPromo?.metadata?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(paidPromo?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['channel-placement:paid-group-promo', 'transaction:price']),
    );
    expect(directory).toBeDefined();
    expect(directory?.metadata?.primarySubtype).toBe('CHANNEL_PLACEMENT');
    expect(directory?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['channel-placement:max-group-directory', 'deal-channel:link']),
    );
  });

  it('detects developer new-build property lead ads without reopening private owner listings', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Двухкомнатная квартира с первым взносом всего 350 000 р. Актуальные предложения по новостройкам города. Все цены от застройщика без дополнительных комиссий. Строительство с ремонтом. 89000000000',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.primarySubtype).toBe('PROPERTY_AGENT');
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['property-agent:новостройки-от-застройщика', 'contact:phone']),
    );
  });

  it('detects commercial chat-bot monetization and bulk leadgen promos', async () => {
    const service = createRuleEngine();
    const botPromo = await detectCommercialViolation(
      service,
      'Админы MAX, ваш чат приносит деньги? Спамер кидает рекламу, бот удаляет сообщение и показывает: оплатить размещение. Подробнее https://max.ru/join/abc',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const leadgenPromo = await detectCommercialViolation(
      service,
      'Отправьте 200 сообщений и забудьте про поиск клиентов. 40-60 заявок каждый день, теплая база в подарок. Узнай больше тут https://max.ru/join/abc',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(botPromo).toBeDefined();
    expect(botPromo?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:chat-bot-monetization', 'deal-channel:link']),
    );
    expect(leadgenPromo).toBeDefined();
    expect(leadgenPromo?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:bulk-client-leadgen', 'deal-channel:link']),
    );
  });

  it('detects paid raffle posts with payment and prize mechanics', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Денежный лот: выбираете номер и оплачиваете его. Счастливчиков выберет генератор случайных чисел. В игре 16 билетов по 350 рублей, призы 1500 рублей и 1000 рублей.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:paid-raffle', 'transaction:price']),
    );
  });

  it('detects recruitment ads with role/pay conditions and contract-service copy', async () => {
    const service = createRuleEngine();
    const restaurant = await detectCommercialViolation(
      service,
      'СРОЧНО ПОВАРА сезон/постоянка. Ресторан премиум класса. Повар х/ц и г/ц, ставка от 5800 р. до 8000 р. График 2/2, звоните или пишите в MAX +79217822898.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const contract = await detectCommercialViolation(
      service,
      'Добровольцы СВО. Самые высокие выплаты и льготы от государства. Официальный контракт с Минобороны РФ, водитель C,D,E, оператор БПЛА. ЗП от 210000р, телефон 89000000000.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const jobChannel = await detectCommercialViolation(
      service,
      'МАХ канал. Есть работа: https://max.ru/join/job1 ИШ ЖУМУШ РАБОТА: https://max.ru/join/job2',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(restaurant).toBeDefined();
    expect(restaurant?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['recruitment:роль-условия', 'contact:phone']),
    );
    expect(contract).toBeDefined();
    expect(contract?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['recruitment:контрактная-служба', 'contact:phone']),
    );
    expect(jobChannel).toBeDefined();
    expect(jobChannel?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['recruitment:есть-работа', 'deal-channel:link']),
    );
  });

  it('detects malformed chat directories and bank card leadgen from audit misses', async () => {
    const service = createRuleEngine();
    const directory = await detectCommercialViolation(
      service,
      'Чаты 1 женский чат https://max.ru/join/a 2 доска объявлений https://max.ru/join/b 3 взаимосылочная https://max.ru/join/c',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const bank = await detectCommercialViolation(
      service,
      'Привет, это Альфа-Банк. Дарим 500 ₽ за оформление Альфа-Стикера по ссылке: https://alfa.me/example. Карта собирает кэшбэк.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(directory).toBeDefined();
    expect(directory?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['channel-placement:numbered-chat-directory', 'deal-channel:link']),
    );
    expect(bank).toBeDefined();
    expect(bank?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:bank-card-leadgen', 'deal-channel:link']),
    );
  });

  it('detects commercial service ads for windows and stone carpet coatings', async () => {
    const service = createRuleEngine();
    const windows = await detectCommercialViolation(
      service,
      'Новые окна - новая атмосфера в вашем доме. Пластиковые окна, бесплатный выезд на замер, индивидуальный подбор под ваш бюджет, аккуратный монтаж. Телефон 89000000000.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const coating = await detectCommercialViolation(
      service,
      'Каменный ковер - бесшовное покрытие для любого пространства. Подходит для бассейнов, террас и гаражей, служит 30-50 лет. Звоните 89000000000.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(windows).toBeDefined();
    expect(windows?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['service-specialty:пластиковые-окна', 'contact:phone']),
    );
    expect(coating).toBeDefined();
    expect(coating?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['service-specialty:каменный-ковер', 'contact:phone']),
    );
  });

  it('detects multi-object realtor catalog listings while keeping private property protected', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Губернский, студия 24 м2, этаж 22/22, ремонт, мебель, техника, цена 4000. Губернский 1 к квартира, площадь 45 м2, этаж 21/22, ремонт, мебель, техника, цена 6050. Телефон 89000000000.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.primarySubtype).toBe('PROPERTY_AGENT');
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['property-agent:витрина-объектов', 'contact:phone']),
    );
  });

  it('detects marketplace review work and paid posting tasks from audit misses', async () => {
    const service = createRuleEngine();
    const marketplace = await detectCommercialViolation(
      service,
      'Последний набор до конца месяца Озон, ВБ, ЯМ, Авито, Али, СберМегаМаркет - срочно ищем модераторов. Условия: с телефона 2-3 часа в день, 3500-4500₽ ежедневно. Нужно 25-30 отзывов. Места ограничены, пиши под пост https://vk.ru/wall1086491776_1223',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const paidReviews = await detectCommercialViolation(
      service,
      'Не спам! Ищу 15 человек, написать пару постов и отзывов. Гарантированная оплата 3000₽, за срочность доплата 500₽. За подробностями пиши ВК https://vk.me/join/example',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(marketplace).toBeDefined();
    expect(marketplace?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:marketplace-seller', 'recruitment:marketplace-review-work']),
    );
    expect(paidReviews).toBeDefined();
    expect(paidReviews?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:paid-review-task', 'recruitment:marketplace-review-work']),
    );
  });

  it('detects remaining high-risk service and buyout audit misses', async () => {
    const service = createRuleEngine();
    const buyout = await detectCommercialViolation(
      service,
      'Куплю цифровые фотоаппараты и видеокамеры +79886169021',
      {
        commercialAdsSensitivity: 'STRICT',
      },
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 8,
          sameTextDistinctChatCount: 8,
          repeatedPhoneDistinctChatCount: 8,
          repeatedLinkDistinctChatCount: 0,
        },
      },
    );
    const tarot = await detectCommercialViolation(
      service,
      'Здравствуйте, бабушка Раиса! +7 950 910-44-78. Таролог с опытом, успевайте записаться на полный расклад. Помогу в любой ситуации, защищу от сглаза и открою денежный канал.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const gridConnection = await detectCommercialViolation(
      service,
      'Помогу с подачей документов и оформлении заявки на технологическое присоединение к электрическим сетям, заключении договора с сетевой компанией. Консультация по телефону 89000000000.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(buyout).toBeDefined();
    expect(buyout?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['buyout:used-electronics-buyout', 'contact:phone']),
    );
    expect(tarot).toBeDefined();
    expect(tarot?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:paid-esoteric-service', 'contact:phone']),
    );
    expect(gridConnection).toBeDefined();
    expect(gridConnection?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['intent:помогу-с-оформлением', 'service-specialty:техприсоединение']),
    );
  });

  it('detects casino, app-directory, and mass invite-link promotions from audit misses', async () => {
    const service = createRuleEngine();
    const casino = await detectCommercialViolation(
      service,
      'Maxbetslots - легенда рунета! 200+ крутых игр, депозит от 100 рублей, сочные бонусы для каждого игрока. https://win4land.com/l/694ffce9da4aef374e093b42',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const appDirectory = await detectCommercialViolation(
      service,
      'https://apps.apple.com/kg/app/id6749191108 РАБОТА, КВАРТИРА, КУПЛЯ ПРОДАЖА, МЕДИЦИНСКИЙ ЦЕНТР - все это скачайте у нас на сайте. https://play.google.com/store/apps/details?id=com.kgmoskva.kgmoskva',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );
    const invite = await detectCommercialViolation(
      service,
      'Присоединяйся к чату по ссылке: https://max.ru/join/AdJRlxIPyq1o8G8uvTHLnFcGSh-vTA7pWvFrUVpM1cU https://i.oneme.ru/i?r=BTGBPUwtwgYUeoFhO7rESmr8y-UPa60DSTFrUYWDN4AkIKVPQDN2Rt7SGDf0beLbl-E',
      {
        commercialAdsSensitivity: 'STRICT',
      },
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 1,
          sameTextDistinctChatCount: 1,
          repeatedPhoneDistinctChatCount: 0,
          repeatedLinkDistinctChatCount: 3,
        },
      },
    );

    expect(casino).toBeDefined();
    expect(casino?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:casino-slot-promo', 'risk:casino-landing-link']),
    );
    expect(appDirectory).toBeDefined();
    expect(appDirectory?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:app-store-directory-promo', 'risk:app-store-directory-link']),
    );
    expect(invite).toBeDefined();
    expect(invite?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['channel-placement:mass-invite-link', 'deal-channel:link']),
    );
  });

  it('keeps repeated private property and pet rehome listings clear', async () => {
    const service = createRuleEngine();
    const campaignContext = {
      senderDistinctChatCount: 4,
      sameTextDistinctChatCount: 4,
      repeatedPhoneDistinctChatCount: 4,
      repeatedLinkDistinctChatCount: 0,
    };
    const ownerProperty = await detectCommercialViolation(
      service,
      'Краснодар. Продам новый дом с центральным газом. Я один собственник. Полная стоимость в договоре, дом оформлен. Без обременений. Ипотека без удорожания. Цена 9900000. Телефон 89000000000.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
      { commercialCampaignContext: campaignContext },
    );
    const petRehome = await detectCommercialViolation(
      service,
      'Возьмите красавчика себе. Умненький, будет средненький. В дар самым любящим хозяевам. Может жить как в доме, так и в будочке. Привезем. 89501448852.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
      { commercialCampaignContext: campaignContext },
    );

    expect(ownerProperty).toBeUndefined();
    expect(petRehome).toBeUndefined();
  });

  it('records unicode-safe price, transactional, urgency, and quantity signals', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Продам картофель, срочно, 10 шт, цена 3000 руб, доставка и оплата при получении.',
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'intent:продам',
        'transaction:price',
        'transaction:keywords',
        'booster:urgency',
        'booster:quantity',
      ]),
    );
  });

  it('detects betting and casino referral promos with registration bonus links', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Фрибеты и ставки на спорт, забирайте бонус за регистрацию в нашем канале https://max.ru/join/bet-club',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:betting-gambling', 'deal-channel:link']),
    );
  });

  it('detects crypto and investment leadgen with direct-message CTA', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Крипта и трейдинг: бесплатный разбор портфеля, доходность от 20%, пишите в личку.',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'risk:crypto-investment',
        'risk:lead-magnet',
        'contact:пишите в лич',
      ]),
    );
  });

  it('detects loan leadgen with fast approval and application link', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Займ до зарплаты, одобрение за 5 минут, заявка по ссылке https://example.ru/apply',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining(['risk:loan-leadgen', 'deal-channel:link']),
    );
  });

  it('detects marketplace seller promotion and referral offers', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Реферальная ссылка для селлеров WB: продвижение карточек, бонус после регистрации https://t.me/wb_growth',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeDefined();
    expect(violation?.metadata?.matchedSignals).toEqual(
      expect.arrayContaining([
        'risk:marketplace-seller',
        'risk:referral-offer',
        'deal-channel:link',
      ]),
    );
  });

  it.each(['BALANCED', 'STRICT'] as const)(
    'does not detect financial advice request with a reference link on %s sensitivity',
    async (sensitivity) => {
      const service = createRuleEngine();
      const violation = await detectCommercialViolation(
        service,
        'Подскажите, нормальные ли ставки по кредиту? Вот калькулятор https://bank.example/calc',
        {
          commercialAdsSensitivity: sensitivity,
        },
      );

      expect(violation).toBeUndefined();
    },
  );

  it('does not detect casual crypto discussion without deal channel or contact', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'Обсуждали крипту и инвестиции без ссылок, кто как хранит портфель в 2026 году?',
      {
        commercialAdsSensitivity: 'STRICT',
      },
    );

    expect(violation).toBeUndefined();
  });

  describe('commercial real-world benchmark', () => {
    it.each(COMMERCIAL_REAL_WORLD_POSITIVE_CASES)(
      'detects $label',
      async ({
        text,
        expectedSubtype,
        reviewRecommended,
        expectedSignals,
        overrides,
        requireClassifier,
        campaignContext,
      }) => {
        const service = createRuleEngine();
        const violation = await detectCommercialViolation(service, text, overrides, {
          commercialCampaignContext: campaignContext,
        });

        expect(violation).toBeDefined();
        expect(violation?.metadata?.primarySubtype).toBe(expectedSubtype);
        if (typeof reviewRecommended === 'boolean') {
          expect(violation?.metadata?.reviewRecommended).toBe(reviewRecommended);
        }
        if (requireClassifier) {
          expect(violation?.metadata?.classifierVersion).toBeDefined();
          expect(violation?.metadata?.commercialProbability).toEqual(expect.any(Number));
          expect(violation?.metadata?.reviewProbability).toEqual(expect.any(Number));
        }
        expect(violation?.metadata?.matchedSignals).toEqual(
          expect.arrayContaining(expectedSignals),
        );
      },
    );

    it.each(COMMERCIAL_REAL_WORLD_NEGATIVE_CASES)('skips $label', async ({ text, overrides }) => {
      const service = createRuleEngine();
      const violation = await detectCommercialViolation(service, text, overrides);

      expect(violation).toBeUndefined();
    });
  });

  describe('commercial sensitivity matrix', () => {
    const cases = [
      {
        label: 'bare service ad',
        text: 'Маникюр, пишите в личку',
        expected: {
          soft: 'MEDIUM',
          balanced: 'HIGH',
          strict: 'HIGH',
        },
      },
      {
        label: 'consultation leadgen',
        text: 'Бесплатная консультация, пишите в личку',
        expected: {
          soft: 'MEDIUM',
          balanced: 'HIGH',
          strict: 'HIGH',
        },
      },
      {
        label: 'audience growth chat promo',
        text: 'Чат для поиска подписчиков и клиентов для ваших проектов. https://max.ru/join/9_D9-tNFZkd1Nfrp9BuYpKnOdAFes0A5V_AHqn-94rQ',
        expected: {
          soft: null,
          balanced: 'MEDIUM',
          strict: 'HIGH',
        },
      },
      {
        label: 'catalog delivery product ad',
        text: 'Диваны на прямую от производителя. Самые доступные цены у нас. Пишите скинем каталог. Есть доставка по региону. Оплата при получении.',
        expected: {
          soft: 'HIGH',
          balanced: 'HIGH',
          strict: 'HIGH',
        },
      },
      {
        label: 'job-seeking resume post',
        text: 'Ищу вахту Охрана 15/15 зп от 6500 смена. 6 разряд водительское удостоверение категория В. все справки имеются предложение пишите в Личные Сообщения!',
        expected: {
          soft: null,
          balanced: null,
          strict: null,
        },
      },
      {
        label: 'recommendation request with site',
        text: 'Подскажите хороший магазин дверей, кто заказывал? Вот сайт https://dveri.example.ru',
        expected: {
          soft: null,
          balanced: null,
          strict: null,
        },
      },
      {
        label: 'free consultation with direct phone',
        text: 'Запись на бесплатную консультацию +79621548190.',
        expected: {
          soft: null,
          balanced: 'HIGH',
          strict: 'HIGH',
        },
      },
    ] as const;

    const profileSettings = {
      soft: COMMERCIAL_SENSITIVITY_PROFILES.soft,
      balanced: COMMERCIAL_SENSITIVITY_PROFILES.balanced,
      strict: COMMERCIAL_SENSITIVITY_PROFILES.strict,
    } as const;

    for (const [profileName, settings] of Object.entries(profileSettings)) {
      it.each(cases)(
        `applies ${profileName} profile correctly for $label`,
        async ({ text, expected }) => {
          const service = createRuleEngine();
          const violation = await detectCommercialViolation(service, text, settings);
          const expectedBand = expected[profileName as keyof typeof expected];

          if (expectedBand === null) {
            expect(violation).toBeUndefined();
            return;
          }

          expect(violation).toBeDefined();
          expect(violation?.metadata?.decisionBand).toBe(expectedBand);
        },
      );
    }
  });

  it('detects COMMERCIAL_AD with mixed latin/cyrillic obfuscation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Pr0dam курс, скидка 30%, пишите в тeлeграм, цена 5000 руб',
      settings: buildSettings({ commercialAdsFilterEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'COMMERCIAL_AD')).toBe(true);
  });

  it('detects MESSAGE_TOO_LONG when effective length exceeds limit', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'short text',
      settings: buildSettings({ maxMessageLengthEnabled: true, maxMessageLength: 50 }),
      domainAllowlist: [],
      effectiveLength: 120,
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_TOO_LONG')).toBe(true);
  });

  it('detects MESSAGE_COUNT_LIMIT after exceeding configured message window', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 2,
      messageCountLimitWindowHours: 3,
    });

    const first = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'первое сообщение',
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'второе сообщение',
      settings,
      domainAllowlist: [],
    });

    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'третье сообщение',
      settings,
      domainAllowlist: [],
    });

    expect(first.violations.some((item) => item.ruleCode === 'MESSAGE_COUNT_LIMIT')).toBe(false);
    expect(second.violations.some((item) => item.ruleCode === 'MESSAGE_COUNT_LIMIT')).toBe(false);
    expect(third.violations.some((item) => item.ruleCode === 'MESSAGE_COUNT_LIMIT')).toBe(true);
  });

  it('detects MESSAGE_BLOCKED_WORD for configured stop words', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сегодня обсуждаем казино и ставки.',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино', 'ставки'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'казино' }),
        }),
      ]),
    );
  });

  it.each([
    ['доход\n\nбез вложений'],
    ['доход\u2029без вложений'],
    ['доход\fбез вложений'],
    ['доход', 'без вложений'],
  ])(
    'keeps legacy matching inside supplied source paragraphs %j',
    async (...stopWordsTextSegments) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'доход без вложений',
        stopWordsTextSegments,
        settings: buildSettings({ messageLimitsBlockedWords: ['доходбезвложений'] }),
        domainAllowlist: [],
      });
      expect(result.violations.some((hit) => hit.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
    },
  );

  it('detects MESSAGE_BLOCKED_DOMAIN for configured forbidden domains', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Бонусы тут: https://promo.casino.example/path',
      settings: buildSettings({ messageLimitsBlockedDomains: ['casino.example'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
          metadata: expect.objectContaining({
            blockedDomain: 'casino.example',
            matchedDomain: 'promo.casino.example',
          }),
        }),
      ]),
    );
  });

  it('does not detect MESSAGE_BLOCKED_DOMAIN inside unrelated domains', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Новости тут: https://notcasino.example/path',
      settings: buildSettings({ messageLimitsBlockedDomains: ['casino.example'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_DOMAIN')).toBe(
      false,
    );
  });

  it('detects MESSAGE_BLOCKED_DOMAIN when link policy only alerts', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Бонусы тут: https://casino.example/landing',
      settings: buildSettings({
        linkPolicy: LinkPolicy.ALERT_ONLY,
        messageLimitsBlockedDomains: ['casino.example'],
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
          metadata: expect.objectContaining({
            blockedDomain: 'casino.example',
            matchedDomain: 'casino.example',
          }),
        }),
      ]),
    );
  });

  it('detects MESSAGE_BLOCKED_WORD for common word endings of a configured stop word', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Сегодня обсуждаем ставки и букмекеров.',
      settings: buildSettings({ messageLimitsBlockedWords: ['ставка', 'букмекер'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'ставка' }),
        }),
      ]),
    );
  });

  it.each(['по', 'как', 'это', 'где', 'есть', 'какой', 'какая', 'вашу'])(
    'detects frequent Russian stop word "%s" when configured by an admin',
    async (blockedWord) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: `Проверка: ${blockedWord} здесь.`,
        settings: buildSettings({ messageLimitsBlockedWords: [blockedWord] }),
        domainAllowlist: [],
      });

      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            metadata: expect.objectContaining({ blockedWord }),
          }),
        ]),
      );
    },
  );

  it('keeps short configured stop words on exact token boundaries', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Такой материал и погодный вопрос не должны совпадать.',
      settings: buildSettings({ messageLimitsBlockedWords: ['как', 'мат', 'где'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it.each([
    ['ставка', 'Обсуждаем ставки сегодня.'],
    ['рассылка', 'Началась массовая рассылка.'],
    ['таро', 'Записали расклад таро.'],
    ['подработка', 'Нужна удаленная подработка вечером.'],
  ])(
    'keeps meaningful blocked word "%s" active alongside frequent words',
    async (blockedWord, text) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text,
        settings: buildSettings({
          messageLimitsBlockedWords: [
            'по',
            'как',
            'это',
            'где',
            'есть',
            'какой',
            'какая',
            'вашу',
            blockedWord,
          ],
        }),
        domainAllowlist: [],
      });

      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            metadata: expect.objectContaining({ blockedWord }),
          }),
        ]),
      );
    },
  );

  it('keeps short configured stop words on exact matching to reduce false positives', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({ messageLimitsBlockedWords: ['мат'] });

    const exact = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Такой мат в чате запрещен.',
      settings,
      domainAllowlist: [],
    });
    const inflected = await service.detect({
      chatId: 'chat-1',
      userId: 'u-2',
      text: 'Материалы для ремонта привезут вечером, матрасы завтра.',
      settings,
      domainAllowlist: [],
    });

    expect(exact.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'мат', matchKind: 'pattern' }),
        }),
      ]),
    );
    expect(inflected.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(
      false,
    );
  });

  it('detects high-signal compound stop words across spaces and punctuation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      messageLimitsBlockedWords: [
        'заработокбезвложений',
        'p2pсвязка',
        'арендааккаунта',
        'раскладтаро',
      ],
    });

    await expect(
      service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: 'В канале обещают заработок без вложений.',
        settings,
        domainAllowlist: [],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        violations: expect.arrayContaining([
          expect.objectContaining({
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            metadata: expect.objectContaining({ blockedWord: 'заработокбезвложений' }),
          }),
        ]),
      }),
    );

    await expect(
      service.detect({
        chatId: 'chat-1',
        userId: 'u-2',
        text: 'Есть новая p2p-связка и аренда аккаунта.',
        settings,
        domainAllowlist: [],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        violations: expect.arrayContaining([
          expect.objectContaining({
            ruleCode: 'MESSAGE_BLOCKED_WORD',
          }),
        ]),
      }),
    );
  });

  it('keeps high-signal compound stop words from matching neutral broad terms', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text:
        'Ставки по кредиту снизились, биржа труда обновила вакансию, ' +
        'сигнал светофора сломан, а расклад сил изменился.',
      settings: buildSettings({
        messageLimitsBlockedWords: [
          'ставкинаспорт',
          'криптосигнал',
          'заработокбезвложений',
          'раскладтаро',
          'арендааккаунта',
        ],
      }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('does not detect MESSAGE_BLOCKED_WORD inside larger word', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Тут только казиношка без совпадения по целому слову.',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('keeps vowel-final blocked words on exact matching to avoid unrelated false positives', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Для склада нужна тара и паллеты.',
      settings: buildSettings({ messageLimitsBlockedWords: ['таро'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('avoids compiling blocked-word regexes for repeated non-matching detects on the same settings list', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const blockedWordDetector = getBlockedWordDetector(service);
    const buildPatternSpy = jest.spyOn(blockedWordDetector, 'buildMessageLimitsBlockedWordPattern');
    const settings = buildSettings({
      messageLimitsBlockedWords: ['крипта', 'казино', 'ставки'],
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'обычное сообщение без совпадений',
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ещё одно обычное сообщение',
      settings,
      domainAllowlist: [],
    });

    expect(buildPatternSpy).toHaveBeenCalledTimes(0);
  });

  it('reuses normalized blocked-word lists across cloned settings payloads', () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const blockedWordDetector = getBlockedWordDetector(service);
    const normalizeTokenSpy = jest.spyOn(
      blockedWordDetector,
      'normalizeMessageLimitsBlockedWordToken',
    );

    const first = blockedWordDetector.resolveMessageLimitsBlockedWordList(['крипта', 'казино']);
    const second = blockedWordDetector.resolveMessageLimitsBlockedWordList(['крипта', 'казино']);

    expect(second).toBe(first);
    expect(normalizeTokenSpy).toHaveBeenCalledTimes(2);
  });

  it('compiles regexes only for blocked words that survive the compact-text prefilter', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const blockedWordDetector = getBlockedWordDetector(service);
    const buildPatternSpy = jest.spyOn(blockedWordDetector, 'buildMessageLimitsBlockedWordPattern');

    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Обход через к@3и-н0 тоже должен ловиться.',
      settings: buildSettings({ messageLimitsBlockedWords: ['крипта', 'казино', 'ставки'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'казино' }),
        }),
      ]),
    );
    expect(buildPatternSpy).toHaveBeenCalledTimes(1);
  });

  it('does not normalize malformed configured blocked words into a different token', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Комбинация ив сама по себе не должна ловиться.',
      settings: buildSettings({ messageLimitsBlockedWords: ['и/в'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('detects MESSAGE_BLOCKED_WORD with special characters and digits', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Обход через к@3и-н0 тоже должен ловиться.',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'казино' }),
        }),
      ]),
    );
  });

  it('detects MESSAGE_BLOCKED_WORD for latin-configured short marketplace aliases', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Пишите по ВБ, там выложила карточки.',
      settings: buildSettings({ messageLimitsBlockedWords: ['wb'] }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          metadata: expect.objectContaining({ blockedWord: 'вб' }),
        }),
      ]),
    );
  });

  it('does not detect MESSAGE_BLOCKED_WORD inside urls', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Линк: https://k-a-z-1-n-0.ru/join',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино'] }),
      domainAllowlist: ['https://k-a-z-1-n-0.ru/join'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('does not detect MESSAGE_BLOCKED_WORD inside product codes and article-like tokens', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Артикул CASINO-2026 и код STAVKA-XL оставьте в заявке.',
      settings: buildSettings({ messageLimitsBlockedWords: ['казино', 'ставка'] }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(false);
  });

  it('detects PHONE_NUMBER_BLOCKED when phone numbers are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Звоните: +7 (900) 000-00-01',
      settings: buildSettings({ phoneNumbersEnabled: false }),
      domainAllowlist: [],
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'PHONE_NUMBER_BLOCKED',
          metadata: expect.objectContaining({ phoneCount: 1 }),
        }),
      ]),
    );
  });

  it('allows phone numbers while the phone toggle is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'Звоните: +7 (900) 000-00-01',
      settings: buildSettings({ phoneNumbersEnabled: true }),
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'PHONE_NUMBER_BLOCKED')).toBe(false);
  });

  it('detects VIDEO_BLOCKED when video messages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ videoMessagesEnabled: false }),
      domainAllowlist: [],
      hasVideoAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'VIDEO_BLOCKED')).toBe(true);
  });

  it('detects PHOTO_BLOCKED when photo messages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ photoMessagesEnabled: false }),
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'PHOTO_BLOCKED')).toBe(true);
  });

  it('detects FILE_BLOCKED when file messages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ fileMessagesEnabled: false }),
      domainAllowlist: [],
      hasFileAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'FILE_BLOCKED')).toBe(true);
  });

  it('detects VOICE_BLOCKED when voice messages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ voiceMessagesEnabled: false }),
      domainAllowlist: [],
      hasVoiceAttachment: true,
    });

    expect(result.violations.some((item) => item.ruleCode === 'VOICE_BLOCKED')).toBe(true);
  });

  it('detects FORWARDED_MESSAGE_BLOCKED when forwarded messages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ forwardedMessagesEnabled: false }),
      domainAllowlist: [],
      hasForwardedMessage: true,
    });

    expect(result.violations).toEqual([
      expect.objectContaining({ ruleCode: 'FORWARDED_MESSAGE_BLOCKED' }),
    ]);
  });

  it('detects PHOTO_RATE_LIMIT from second photo when cooldown is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
    });

    const first = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(first.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(false);
    expect(second.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(true);
  });

  it('uses the trusted webhook timestamp for idempotent media cooldown checks', async () => {
    const claimEventCooldown = jest.fn().mockResolvedValue('blocked');
    const service = new RuleEngineService({ claimEventCooldown } as never);
    const eventTimestampMs = Date.now() - 1000;
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      messageId: 'photo-1',
      duplicateStateEventTimestampMs: eventTimestampMs,
      text: '',
      settings: buildSettings({
        antiDuplicateEnabled: false,
        antiSpamEnabled: false,
        photoMessageCooldownEnabled: true,
      }),
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });
    expect(claimEventCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ eventTimestampMs, windowSeconds: 3600 }),
    );
    expect(result.violations).toEqual([expect.objectContaining({ ruleCode: 'PHOTO_RATE_LIMIT' })]);
  });

  it('detects STICKER_RATE_LIMIT from second sticker when cooldown is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 5,
    });

    const first = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    expect(first.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT')).toBe(false);
    expect(second.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT')).toBe(true);
  });

  it('resets photo cooldown state when photo cooldown settings change', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const initialSettings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 12,
      updatedAt: new Date('2026-04-11T09:00:00.000Z'),
    });
    const updatedSettings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 1,
      updatedAt: new Date('2026-04-11T10:00:00.000Z'),
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: initialSettings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    const firstAfterSettingsChange = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: updatedSettings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });
    const secondAfterSettingsChange = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: updatedSettings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(
      firstAfterSettingsChange.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT'),
    ).toBe(false);
    expect(
      secondAfterSettingsChange.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT'),
    ).toBe(true);
  });

  it('does not spend photo cooldown on a message blocked by another violation', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
      messageLimitsBlockedWords: ['казино'],
    });

    const blockedAttempt = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'казино',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });
    const firstCleanAttempt = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'фото без нарушений',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });
    const secondCleanAttempt = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'ещё одно фото без нарушений',
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });

    expect(blockedAttempt.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(
      true,
    );
    expect(blockedAttempt.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(
      false,
    );
    expect(firstCleanAttempt.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(
      false,
    );
    expect(secondCleanAttempt.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(
      true,
    );
  });

  it('resets sticker cooldown state when sticker cooldown settings change', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const initialSettings = buildSettings({
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 10,
      updatedAt: new Date('2026-04-11T09:00:00.000Z'),
    });
    const updatedSettings = buildSettings({
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 5,
      updatedAt: new Date('2026-04-11T10:00:00.000Z'),
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: initialSettings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    const firstAfterSettingsChange = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: updatedSettings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });
    const secondAfterSettingsChange = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: updatedSettings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    expect(
      firstAfterSettingsChange.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT'),
    ).toBe(false);
    expect(
      secondAfterSettingsChange.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT'),
    ).toBe(true);
  });

  it('does not trigger PHOTO_RATE_LIMIT for sticker-only attachments', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 2,
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 5,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });
    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings,
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    expect(second.violations.some((item) => item.ruleCode === 'PHOTO_RATE_LIMIT')).toBe(false);
    expect(second.violations.some((item) => item.ruleCode === 'STICKER_RATE_LIMIT')).toBe(true);
  });

  it('does not emit legacy FLOOD violation', async () => {
    const enabledService = new RuleEngineService(new MockRedisCounterService() as never);
    const disabledService = new RuleEngineService(new MockRedisCounterService() as never);

    let enabledResult = await enabledService.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ antiSpamEnabled: true }),
      domainAllowlist: [],
    });
    for (let index = 0; index < 5; index += 1) {
      enabledResult = await enabledService.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: '',
        settings: buildSettings({ antiSpamEnabled: true }),
        domainAllowlist: [],
      });
    }

    let disabledResult = await disabledService.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ antiSpamEnabled: false }),
      domainAllowlist: [],
    });
    for (let index = 0; index < 5; index += 1) {
      disabledResult = await disabledService.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: '',
        settings: buildSettings({ antiSpamEnabled: false }),
        domainAllowlist: [],
      });
    }

    expect(enabledResult.violations.some((item) => item.ruleCode === 'FLOOD')).toBe(false);
    expect(disabledResult.violations.some((item) => item.ruleCode === 'FLOOD')).toBe(false);
    expect(enabledResult.violations.some((item) => item.ruleCode === 'MESSAGE_RATE_LIMIT')).toBe(
      true,
    );
    expect(disabledResult.violations.some((item) => item.ruleCode === 'MESSAGE_RATE_LIMIT')).toBe(
      false,
    );
  });

  it.each([
    ['photo', { hasPhotoAttachment: true }],
    ['video', { hasVideoAttachment: true }],
    ['file', { hasFileAttachment: true }],
    ['voice', { hasVoiceAttachment: true }],
    ['media batch marker', { hasMediaBatch: true }],
  ])(
    'does not trigger built-in anti-spam burst for %s attachments or batches',
    async (_kind, flags) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      let result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: '',
        settings: buildSettings({ antiSpamEnabled: true }),
        domainAllowlist: [],
        ...flags,
      });

      for (let index = 0; index < 5; index += 1) {
        result = await service.detect({
          chatId: 'chat-1',
          userId: 'u-1',
          text: '',
          settings: buildSettings({ antiSpamEnabled: true }),
          domainAllowlist: [],
          ...flags,
        });
      }

      expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_RATE_LIMIT')).toBe(false);
    },
  );

  it('triggers the built-in anti-spam burst for sticker attachments', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    let result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: '',
      settings: buildSettings({ antiSpamEnabled: true }),
      domainAllowlist: [],
      hasStickerAttachment: true,
    });

    for (let index = 0; index < 5; index += 1) {
      result = await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        text: '',
        settings: buildSettings({ antiSpamEnabled: true }),
        domainAllowlist: [],
        hasStickerAttachment: true,
      });
    }

    expect(result.violations.some((item) => item.ruleCode === 'MESSAGE_RATE_LIMIT')).toBe(true);
  });

  it('allows one duplicate, then escalates to WARN/MUTE/BAN in sequence', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });
    const fourth = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });
    const fifth = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(third.duplicateDecision?.action).toBe('WARN');
    expect(third.duplicateDecision?.windowSec).toBe(12 * 60 * 60);
    expect(fourth.duplicateDecision?.action).toBe('MUTE');
    expect(fourth.duplicateDecision?.windowSec).toBe(12 * 60 * 60);
    expect(fifth.duplicateDecision?.action).toBe('BAN');
    expect(fifth.duplicateDecision?.windowSec).toBe(12 * 60 * 60);
  });

  it('starts with explanation when duplicate bot message stage is enabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({ duplicateBotMessageEnabled: true });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit?.count).toBe(1);
    expect(second.duplicateDecision).toBeUndefined();
    expect(third.duplicateDecision?.action).toBe('WARN');
  });

  it('can warn on the first duplicate when no duplicates are allowed', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: true,
      duplicateMuteMaxCount: 2,
      duplicateBanEnabled: true,
      duplicateBanMaxCount: 3,
    });

    const first = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });
    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(first.duplicateDecision).toBeUndefined();
    expect(second.duplicateDecision?.action).toBe('WARN');
    expect(second.duplicateDecision?.threshold).toBe(1);
  });

  it('does not count repeated delivery of the same message id as a duplicate', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });

    const firstDelivery = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      messageId: 'mid-1',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_000,
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });
    const redelivery = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      messageId: 'mid-1',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_000,
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });
    const nextMessage = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      messageId: 'mid-2',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_001,
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(firstDelivery.duplicateDecision).toBeUndefined();
    expect(redelivery.duplicateDecision).toBeUndefined();
    expect(redelivery.duplicateHit).toBeUndefined();
    expect(nextMessage.duplicateDecision?.action).toBe('WARN');
    expect(nextMessage.duplicateDecision?.threshold).toBe(1);
  });

  it('writes a duplicate tombstone for transferable edits while other stateful limits stay skipped', async () => {
    const replaceRevisionedSetMembershipsBeforeDeadline = jest
      .fn()
      .mockResolvedValue({ kind: 'applied', counts: [] });
    const incrementOncePerMemberWithTtl = jest
      .fn()
      .mockResolvedValue({ inserted: true, count: 99 });
    const service = new RuleEngineService({
      replaceRevisionedSetMembershipsBeforeDeadline,
      incrementOncePerMemberWithTtl,
    } as never);

    await expect(
      service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        messageId: 'mid-1',
        duplicateStateEventType: 'message_edited',
        duplicateStateEventTimestampMs: 1_800_000_000_000,
        text: DUPLICATE_SPAM_TEXT,
        settings: buildSettings({
          antiSpamEnabled: true,
          messageCountLimitEnabled: true,
          photoMessageCooldownEnabled: true,
        }),
        domainAllowlist: [],
        hasPhotoAttachment: true,
        skipStatefulMessageLimits: true,
      }),
    ).resolves.toMatchObject({ violations: [] });

    expect(replaceRevisionedSetMembershipsBeforeDeadline).toHaveBeenCalledTimes(1);
    expect(replaceRevisionedSetMembershipsBeforeDeadline).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 1_800_000_000_000,
        membershipKeys: [],
      }),
    );
    expect(incrementOncePerMemberWithTtl).not.toHaveBeenCalled();
  });

  it('clears an edited message fingerprint when another rule rejects its new text', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      antiSpamEnabled: false,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      messageLimitsBlockedWords: ['запрещено'],
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      messageId: 'mid-1',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_000,
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });
    const rejectedEdit = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      messageId: 'mid-1',
      duplicateStateEventType: 'message_edited',
      duplicateStateEventTimestampMs: 1_800_000_000_100,
      text: 'запрещено',
      settings,
      domainAllowlist: [],
      skipStatefulMessageLimits: true,
    });
    const firstReplacement = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      messageId: 'mid-2',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_200,
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(rejectedEdit.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(
      true,
    );
    expect(rejectedEdit.duplicateHit).toBeUndefined();
    expect(firstReplacement.duplicateHit).toBeUndefined();
    expect(firstReplacement.duplicateDecision).toBeUndefined();
  });

  it.each(['message_created', 'message_edited'] as const)(
    'does not mutate duplicate state for %s without a trusted event timestamp',
    async (duplicateStateEventType) => {
      const replaceRevisionedSetMembershipsBeforeDeadline = jest.fn();
      const service = new RuleEngineService({
        replaceRevisionedSetMembershipsBeforeDeadline,
      } as never);

      await service.detect({
        chatId: 'chat-1',
        userId: 'u-1',
        messageId: 'mid-1',
        duplicateStateEventType,
        text: DUPLICATE_SPAM_TEXT,
        settings: buildSettings({ antiSpamEnabled: false }),
        domainAllowlist: [],
        skipStatefulMessageLimits: duplicateStateEventType === 'message_edited',
      });

      expect(replaceRevisionedSetMembershipsBeforeDeadline).not.toHaveBeenCalled();
    },
  );

  it('falls back to MUTE when BAN stage is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const localSettings = buildSettings({
      duplicateBanEnabled: false,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: localSettings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: localSettings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: localSettings,
      domainAllowlist: [],
    });
    const fourth = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: localSettings,
      domainAllowlist: [],
    });

    expect(fourth.duplicateDecision?.action).toBe('MUTE');
  });

  it('tracks duplicate counters per user, not across the whole chat', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const user1Second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const user2First = await service.detect({
      chatId: 'chat-1',
      userId: 'user-2',
      text: DUPLICATE_SPAM_TEXT,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(user1Second.duplicateHit).toBeUndefined();
    expect(user1Second.duplicateDecision).toBeUndefined();
    expect(user2First.duplicateDecision).toBeUndefined();
  });

  it('returns a deletion hit when all optional duplicate stages are disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      duplicateWarnMaxCount: 1,
      duplicateMuteMaxCount: 1,
      duplicateBanMaxCount: 1,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toEqual(
      expect.objectContaining({
        count: 1,
        fingerprintType: 'exact',
      }),
    );
    expect(second.duplicateDecision).toBeUndefined();
  });

  it('does not process duplicate moderation when anti-duplicate toggle is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({ antiDuplicateEnabled: false });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
  });

  it('does not track duplicates for messages with only allowlisted exact links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const text = 'https://ura.news/news/1053075490 Читайте на URA.RU';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: ['https://ura.news/news/1053075490'],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: ['https://ura.news/news/1053075490'],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(second.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('tracks duplicates for long repeated messages with allowlisted links when body text is substantial', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const text =
      'Подробно разбираю ситуацию по заявке: сроки сдвинулись, новые условия уже согласованы, финальный статус и контакты оставляю ниже https://max.ru/channel/news/post-1';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news/post-1'],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: ['https://max.ru/channel/news/post-1'],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(second.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('does not track duplicates for repeated messages with blocked links', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const text = 'смотри https://example.com/news это важно';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: buildSettings(),
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(second.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('does not track duplicates for repeated messages blocked by message limits', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      messageLimitsBlockedWords: ['скидка'],
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: DUPLICATE_SPAM_TEXT,
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toBeUndefined();
    expect(second.duplicateDecision).toBeUndefined();
    expect(second.violations.some((item) => item.ruleCode === 'MESSAGE_BLOCKED_WORD')).toBe(true);
  });

  it('tracks exact STANDARD duplicates with phone numbers without matching a changed number', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'STANDARD',
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      duplicateWarnMaxCount: 1,
    });
    const text =
      'Повторяемое объявление с подробным описанием услуги, условиями записи, временем встречи и телефоном +7 (999) 123-45-67';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings,
      domainAllowlist: [],
    });

    const changedPhone = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: text.replace('123-45-67', '765-43-21'),
      settings,
      domainAllowlist: [],
    });
    const exactRepeat = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings,
      domainAllowlist: [],
    });

    expect(changedPhone.duplicateHit).toBeUndefined();
    expect(changedPhone.duplicateDecision).toBeUndefined();
    expect(exactRepeat.duplicateHit).toEqual(
      expect.objectContaining({
        count: 1,
        fingerprintType: 'exact',
      }),
    );
    expect(exactRepeat.duplicateDecision).toBeUndefined();
  });

  it('tracks exact STANDARD duplicates with the same link without matching a changed link', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      linkPolicy: LinkPolicy.ALERT_ONLY,
      duplicateDetectionPreset: 'STANDARD',
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      duplicateWarnMaxCount: 1,
    });
    const textBase =
      'Подробная инструкция для участников встречи сохранена здесь, проверьте детали и подтвердите участие';
    const text = `${textBase} https://example.com/one`;

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings,
      domainAllowlist: [],
    });
    const changedLink = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: `${textBase} https://example.com/two`,
      settings,
      domainAllowlist: [],
    });
    const exactRepeat = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings,
      domainAllowlist: [],
    });

    expect(changedLink.duplicateHit).toBeUndefined();
    expect(changedLink.duplicateDecision).toBeUndefined();
    expect(exactRepeat.duplicateHit).toEqual(
      expect.objectContaining({
        count: 1,
        fingerprintType: 'exact',
      }),
    );
    expect(exactRepeat.duplicateDecision).toBeUndefined();
    expect(exactRepeat.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('keeps standard duplicate detection exact when links change', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      linkPolicy: LinkPolicy.ALERT_ONLY,
      duplicateDetectionPreset: 'STANDARD',
    });
    const textBase =
      'Подробная инструкция для участников встречи сохранена здесь, проверьте детали и подтвердите участие';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: `${textBase} https://example.com/one`,
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: `${textBase} https://example.com/two`,
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: `${textBase} https://example.com/three`,
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateHit).toBeUndefined();
    expect(third.duplicateDecision).toBeUndefined();
    expect(third.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('detects the same link as a custom duplicate regardless of surrounding text', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      linkPolicy: LinkPolicy.ALERT_ONLY,
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnoreLinksEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Первое объявление: все детали тут https://example.com/sale?id=15',
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Совсем другой текст, но ссылка та же https://example.com/sale?id=15',
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Еще одна подводка вокруг той же ссылки https://example.com/sale?id=15',
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateDecision).toEqual(
      expect.objectContaining({
        action: 'WARN',
        fingerprintType: 'link',
      }),
    );
    expect(third.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('keeps custom link matching off when the link toggle is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      linkPolicy: LinkPolicy.ALERT_ONLY,
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnoreLinksEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Первое объявление: все детали тут https://example.com/sale?id=15',
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Совсем другой текст, но ссылка та же https://example.com/sale?id=15',
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Еще одна подводка вокруг той же ссылки https://example.com/sale?id=15',
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateHit).toBeUndefined();
    expect(third.duplicateDecision).toBeUndefined();
  });

  it('detects the same phone as a custom duplicate regardless of surrounding text', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnorePhonesEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Первое сообщение с телефоном +7 (999) 123-45-67',
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Другой текст и тот же телефон 8 999 123 45 67',
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Третья вариация с телефоном 999-123-45-67',
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateDecision).toEqual(
      expect.objectContaining({
        action: 'WARN',
        fingerprintType: 'phone',
      }),
    );
  });

  it('keeps custom phone matching off when the phone toggle is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnorePhonesEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Первое сообщение с телефоном +7 (999) 123-45-67',
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Другой текст и тот же телефон 8 999 123 45 67',
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Третья вариация с телефоном 999-123-45-67',
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateHit).toBeUndefined();
    expect(third.duplicateDecision).toBeUndefined();
  });

  it('preserves generic number labels as CUSTOM content instead of phone evidence', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnorePhonesEnabled: true,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });
    for (const text of [
      'Первое сообщение с номером +7 (999) 123-45-67',
      'Документ с номером +7 (999) 123-45-67 подтверждён',
      'Оборудование с номером +7 (999) 123-45-67 доступно',
    ]) {
      const result = await service.detect({
        chatId: 'chat-1',
        userId: 'user-1',
        text,
        settings,
        domainAllowlist: [],
      });
      expect(result.duplicateHit).toBeUndefined();
      expect(result.duplicateDecision).toBeUndefined();
    }
  });

  it('still evaluates exact custom content when phone matching is disabled', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'CUSTOM',
      duplicateIgnorePhonesEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });
    const text =
      'Повторяемое объявление с подробным описанием услуги, условиями записи, временем встречи и телефоном +7 (999) 123-45-67';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateDecision).toEqual(
      expect.objectContaining({
        action: 'WARN',
        fingerprintType: 'exact',
      }),
    );
  });

  it('detects strict duplicates when links and phones are rotated', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      linkPolicy: LinkPolicy.ALERT_ONLY,
      duplicateDetectionPreset: 'STRICT',
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });
    const textBase =
      'Подробная инструкция для участников встречи сохранена здесь, проверьте детали и подтвердите участие';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: `${textBase} https://example.com/one связь +7 (900) 111-22-33`,
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: `${textBase} https://example.com/two связь +7 (900) 222-33-44`,
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: `${textBase} https://example.com/three связь +7 (900) 333-44-55`,
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateDecision).toEqual(
      expect.objectContaining({
        action: 'WARN',
        fingerprintType: 'content',
      }),
    );
    expect(third.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });

  it('keeps different semantic punctuation distinct in strict comparisons', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'STRICT',
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });
    const first =
      'Пожалуйста проверьте расписание встречи завтра утром команда собирается возле главного входа';
    const second =
      'Пожалуйста, проверьте расписание встречи завтра утром! Команда собирается возле главного входа';
    const third =
      'Пожалуйста: проверьте расписание встречи завтра утром. Команда собирается возле главного входа.';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: first,
      settings,
      domainAllowlist: [],
    });
    const secondResult = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: second,
      settings,
      domainAllowlist: [],
    });
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: third,
      settings,
      domainAllowlist: [],
    });

    expect(secondResult.duplicateHit).toBeUndefined();
    expect(secondResult.duplicateDecision).toBeUndefined();
    expect(result.duplicateHit).toBeUndefined();
    expect(result.duplicateDecision).toBeUndefined();
  });

  it('detects strict near duplicates when punctuation positions stay the same', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      duplicateDetectionPreset: 'STRICT',
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });
    const texts = [
      'Пожалуйста, проверьте расписание встречи завтра утром! Команда собирается возле главного входа.',
      'ПОЖАЛУЙСТА , ПРОВЕРЬТЕ РАСПИСАНИЕ ВСТРЕЧИ ЗАВТРА УТРОМ ! КОМАНДА СОБИРАЕТСЯ ВОЗЛЕ ГЛАВНОГО ВХОДА .',
      'Пожалуйста , проверьте расписание встречи завтра утром! Команда собирается возле главного входа .',
    ];
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: texts[0],
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: texts[1],
      settings,
      domainAllowlist: [],
    });
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: texts[2],
      settings,
      domainAllowlist: [],
    });
    expect(result.duplicateDecision).toEqual(
      expect.objectContaining({
        action: 'WARN',
        fingerprintType: 'near',
      }),
    );
  });

  it('does not moderate repeated short everyday text', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({ antiSpamEnabled: false });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'short-1',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_000,
      text: 'ок',
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'short-2',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_001,
      text: 'ок',
      settings,
      domainAllowlist: [],
    });
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'short-3',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_002,
      text: 'ок',
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateHit).toBeUndefined();
    expect(third.duplicateDecision).toBeUndefined();
  });

  it('still tracks short repeated text when it contains a high-signal link', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      antiSpamEnabled: false,
      linkPolicy: LinkPolicy.ALERT_ONLY,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
    });

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'сюда https://example.com/sale',
      settings,
      domainAllowlist: [],
    });
    const second = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'сюда https://example.com/sale',
      settings,
      domainAllowlist: [],
    });

    expect(second.duplicateHit).toMatchObject({ count: 1, fingerprintType: 'exact' });
  });

  it.each([
    'hasPhotoAttachment',
    'hasVideoAttachment',
    'hasFileAttachment',
    'hasVoiceAttachment',
    'hasMediaBatch',
    'hasForwardedMessage',
  ] as const)(
    'does not treat repeated captions on transferable content as text duplicates: %s',
    async (flag) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const settings = buildSettings({ antiSpamEnabled: false, duplicateWarnMaxCount: 1 });
      const text =
        'Команда завтра утром принимает новые заявки возле главного входа после общей встречи';
      let result;

      for (let index = 0; index < 3; index += 1) {
        result = await service.detect({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: `transferable-${flag}-${index}`,
          duplicateStateEventType: 'message_created',
          duplicateStateEventTimestampMs: 1_800_000_000_000 + index,
          text,
          settings,
          domainAllowlist: [],
          [flag]: true,
        });
      }

      expect(result?.duplicateHit).toBeUndefined();
      expect(result?.duplicateDecision).toBeUndefined();
    },
  );

  it('clears prior text history when an edit adds transferable content', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({ antiSpamEnabled: false, duplicateWarnMaxCount: 1 });
    const text =
      'Команда завтра утром принимает новые заявки возле главного входа после общей встречи';

    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'edited-transferable',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_000,
      text,
      settings,
      domainAllowlist: [],
    });
    await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'edited-transferable',
      duplicateStateEventType: 'message_edited',
      duplicateStateEventTimestampMs: 1_800_000_000_001,
      text,
      settings,
      domainAllowlist: [],
      hasPhotoAttachment: true,
    });
    const next = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'text-after-transferable-edit',
      duplicateStateEventType: 'message_created',
      duplicateStateEventTimestampMs: 1_800_000_000_002,
      text,
      settings,
      domainAllowlist: [],
    });

    expect(next.duplicateHit).toBeUndefined();
    expect(next.duplicateDecision).toBeUndefined();
  });

  it('treats structured link targets as part of an exact message', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      antiSpamEnabled: false,
      linkPolicy: LinkPolicy.ALERT_ONLY,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      duplicateWarnMaxCount: 1,
    });
    const detect = (messageId: string, target: string) =>
      service.detect({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId,
        duplicateStateEventType: 'message_created',
        duplicateStateEventTimestampMs: 1_800_000_000_000 + Number(messageId.slice(-1)),
        text: 'Подробнее',
        settings,
        domainAllowlist: [],
        navigationTargets: [duplicateNavigationTarget(target)],
      });

    const first = await detect('message-1', 'https://example.com/one');
    const second = await detect('message-2', 'https://example.com/two');

    expect(first.duplicateHit).toBeUndefined();
    expect(second.duplicateHit).toBeUndefined();
    await expect(detect('message-3', 'https://example.com/two')).resolves.toMatchObject({
      duplicateHit: { count: 1, fingerprintType: 'exact' },
    });
  });

  it.each([
    '',
    '   ',
    '...',
    '👍',
    '/start',
    '  /help@major_bot  ',
    '/start broadcast_handoff',
    '/START@major_bot pm2_chat-user_deadbeef',
    `/start ${'a'.repeat(128)}`,
  ])('does not track empty, non-semantic, or service-like text %p', async (text) => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({ antiSpamEnabled: false });
    let lastResult;

    for (let index = 0; index < 4; index += 1) {
      lastResult = await service.detect({
        chatId: 'chat-1',
        userId: 'user-1',
        text,
        settings,
        domainAllowlist: [],
      });
    }

    expect(lastResult?.duplicateHit).toBeUndefined();
    expect(lastResult?.duplicateDecision).toBeUndefined();
  });

  it.each([
    '/x длинный повторяемый спам',
    '/sale Срочно купите товар со скидкой',
    '/unknown payload',
    '/start payload с пробелами',
    '/start payload!',
    `/start ${'a'.repeat(129)}`,
  ])(
    'tracks repeated slash-prefixed text that is not a valid service command: %p',
    async (text) => {
      const service = new RuleEngineService(new MockRedisCounterService() as never);
      const settings = buildSettings({ antiSpamEnabled: false });
      let lastResult;

      for (let index = 0; index < 3; index += 1) {
        lastResult = await service.detect({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: `slash-${index}`,
          duplicateStateEventType: 'message_created',
          duplicateStateEventTimestampMs: 1_800_000_000_000 + index,
          text,
          settings,
          domainAllowlist: [],
        });
      }

      expect(lastResult?.duplicateHit).toMatchObject({ count: 2, fingerprintType: 'exact' });
      expect(lastResult?.duplicateDecision).toMatchObject({
        action: 'WARN',
        fingerprintType: 'exact',
      });
    },
  );

  it('does not fuzzy-match insufficient STRICT text when only its link changes', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const settings = buildSettings({
      antiSpamEnabled: false,
      linkPolicy: LinkPolicy.ALERT_ONLY,
      duplicateDetectionPreset: 'STRICT',
    });

    for (const suffix of ['one', 'two']) {
      await service.detect({
        chatId: 'chat-1',
        userId: 'user-1',
        text: `ок https://example.com/${suffix}`,
        settings,
        domainAllowlist: [],
      });
    }
    const third = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ок https://example.com/three',
      settings,
      domainAllowlist: [],
    });

    expect(third.duplicateHit).toBeUndefined();
    expect(third.duplicateDecision).toBeUndefined();
  });

  it('blocks any links when link policy is BLOCKLIST_ONLY', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://example.com/news',
      settings: {
        ...buildSettings(),
        linkPolicy: LinkPolicy.BLOCKLIST_ONLY,
      },
      domainAllowlist: ['https://example.com/news'],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(true);
  });

  it('does not block links when link policy is ALERT_ONLY', async () => {
    const service = new RuleEngineService(new MockRedisCounterService() as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'u-1',
      text: 'смотри https://bad.com',
      settings: {
        ...buildSettings(),
        linkPolicy: LinkPolicy.ALERT_ONLY,
      },
      domainAllowlist: [],
    });

    expect(result.violations.some((item) => item.ruleCode === 'LINK_BLOCKED')).toBe(false);
  });
});

describe('RuleEngineService invocation coverage', () => {
  function input(
    overrides: Partial<ChatSettings> = {},
  ): Parameters<RuleEngineService['detect']>[0] {
    return {
      chatId: 'coverage-chat',
      userId: 'coverage-user',
      text: 'Обычное сообщение',
      settings: buildSettings({
        antiSpamEnabled: false,
        antiDuplicateEnabled: false,
        russianProfanityFilterEnabled: false,
        linkPolicy: LinkPolicy.ALERT_ONLY,
        ...overrides,
      }),
      domainAllowlist: [],
    };
  }

  function harness(counters = new MockRedisCounterService() as unknown as RedisCounterService) {
    const diagnostics = {
      recordHotPathStageOutcome: jest
        .fn<
          ReturnType<RuntimeDiagnosticsService['recordHotPathStageOutcome']>,
          Parameters<RuntimeDiagnosticsService['recordHotPathStageOutcome']>
        >()
        .mockResolvedValue(undefined),
      recordHotPathProfile: jest
        .fn<
          ReturnType<RuntimeDiagnosticsService['recordHotPathProfile']>,
          Parameters<RuntimeDiagnosticsService['recordHotPathProfile']>
        >()
        .mockResolvedValue(undefined),
    } satisfies Pick<
      RuntimeDiagnosticsService,
      'recordHotPathStageOutcome' | 'recordHotPathProfile'
    >;
    const sink = Object.assign(
      Object.create(RuntimeDiagnosticsService.prototype) as RuntimeDiagnosticsService,
      diagnostics,
    );
    const service = new RuleEngineService(counters, sink);
    const profile = () => diagnostics.recordHotPathProfile.mock.calls.at(-1)?.[0].snapshot;
    const coverage = (family: RuleCoverageFamily) => {
      const snapshot = profile()?.ruleCoverage as RuleCoverageSnapshot;
      expect(snapshot.rows).toHaveLength(RULE_COVERAGE_FAMILIES.length);
      const row = snapshot.rows[RULE_COVERAGE_FAMILIES.indexOf(family)]!;
      return Object.fromEntries(
        RULE_COVERAGE_COUNTERS.map((counter, index) => [counter, row[index]]),
      );
    };
    return { service, diagnostics, coverage, profile };
  }

  afterEach(() => jest.restoreAllMocks());

  it('records disabled rules once and reports shared stop-word/media clocks separately', async () => {
    const run = harness();
    await expect(run.service.detect(input())).resolves.toEqual({ violations: [] });
    for (const family of RULE_COVERAGE_FAMILIES) {
      expect(run.coverage(family)).toMatchObject({
        configured: 0,
        eligible: 0,
        evaluated: 0,
        skippedDisabled: 1,
        errors: 0,
        interrupted: 0,
      });
    }
    expect(run.diagnostics.recordHotPathProfile).toHaveBeenCalledTimes(1);
    expect(run.profile()?.stageDurations).toMatchObject({
      'rule-engine.stop-words-policy': expect.any(Number),
      'rule-engine.media-cooldowns': expect.any(Number),
      'rule-engine.phone-numbers': expect.any(Number),
    });
    expect(run.profile()?.stageDurations).not.toHaveProperty(['rule-engine.blocked-words']);
    expect(run.profile()?.stageDurations).not.toHaveProperty(['rule-engine.blocked-domains']);
  });

  it('distinguishes report, state and content skips while retaining independent limits', async () => {
    const run = harness();
    const request = input({
      russianProfanityFilterEnabled: true,
      commercialAdsFilterEnabled: true,
      phoneNumbersEnabled: false,
      antiSpamEnabled: true,
      messageCountLimitEnabled: true,
      maxMessageLengthEnabled: true,
      maxMessageLength: 2,
      photoMessageCooldownEnabled: true,
    });
    await run.service.detect({
      ...request,
      skipContentFiltersForReport: true,
      skipStatefulMessageLimits: true,
    });
    for (const family of ['profanity', 'commercial-ad', 'phone-numbers'] as const) {
      expect(run.coverage(family)).toMatchObject({
        configured: 1,
        eligible: 0,
        evaluated: 0,
        skippedContent: 1,
      });
    }
    for (const family of ['anti-spam-burst', 'message-count-limit', 'photo-cooldown'] as const) {
      expect(run.coverage(family)).toMatchObject({ configured: 1, evaluated: 0, skippedState: 1 });
    }
    expect(run.coverage('message-length')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 1,
      matched: 1,
    });

    await run.service.detect(
      input({ photoMessageCooldownEnabled: true, messageLimitsBlockedDomains: ['example.com'] }),
    );
    expect(run.coverage('photo-cooldown')).toMatchObject({
      configured: 1,
      eligible: 0,
      skippedContent: 1,
    });
    expect(run.coverage('blocked-domains')).toMatchObject({
      configured: 1,
      eligible: 0,
      skippedContent: 1,
    });
  });

  it.each(['legacy', 'modern'] as const)(
    'counts %s overlapping word/domain matches once across source segments',
    async (mode) => {
      const run = harness();
      const request = input({
        messageLimitsBlockedWords: ['спаммаркер'],
        messageLimitsBlockedDomains: ['example.com'],
        ...(mode === 'modern'
          ? {
              stopWordsPolicy: stopWordsPolicySchema.parse({
                enabled: true,
                rules: [
                  {
                    id: 'word-1',
                    kind: 'WORD',
                    value: 'спаммаркер',
                    enabled: true,
                    matchMode: 'EXACT',
                  },
                ],
                domains: ['example.com'],
              }),
            }
          : {}),
      });
      const result = await run.service.detect({
        ...request,
        text: 'спаммаркер https://example.com/путь',
        stopWordsTextSegments: [
          'Обычное сообщение',
          'спаммаркер',
          'спаммаркер https://example.com/путь',
        ],
      });
      expect(result.violations.map((value) => value.ruleCode)).toEqual([
        'MESSAGE_BLOCKED_WORD',
        'MESSAGE_BLOCKED_DOMAIN',
      ]);
      for (const family of ['blocked-words', 'blocked-domains'] as const) {
        expect(run.coverage(family)).toMatchObject({
          configured: 1,
          eligible: 1,
          evaluated: 1,
          matched: 1,
          errors: 0,
          interrupted: 0,
        });
      }
    },
  );

  it('does not turn malformed modern policies or stale counter state into valid nonmatches', async () => {
    const counters = new MockRedisCounterService();
    jest
      .spyOn(counters, 'replaceRevisionedSetMembershipsBeforeDeadline')
      .mockResolvedValue({ kind: 'stale' });
    const run = harness(counters as unknown as RedisCounterService);
    await run.service.detect({
      ...input({
        antiSpamEnabled: true,
        messageLimitsBlockedWords: ['спаммаркер'],
        stopWordsPolicy: { version: 999 },
        linkRulesPolicy: { version: 999 },
      }),
      messageId: 'stale-message',
      duplicateStateEventTimestampMs: Date.now(),
      text: 'спаммаркер https://example.com',
    });
    expect(run.coverage('anti-spam-burst')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 0,
      matched: 0,
      skippedState: 1,
    });
    expect(run.coverage('links')).toMatchObject({ eligible: 0, evaluated: 0, skippedState: 1 });
    expect(run.coverage('blocked-words')).toMatchObject({
      eligible: 0,
      evaluated: 0,
      matched: 0,
      skippedState: 1,
    });
  });

  it('records an expired counter lookup while continuing the next independent match', async () => {
    const counters = new MockRedisCounterService();
    jest
      .spyOn(counters, 'replaceRevisionedSetMembershipsBeforeDeadline')
      .mockResolvedValue({ kind: 'deadline_exceeded' });
    const run = harness(counters as unknown as RedisCounterService);
    const result = await run.service.detect({
      ...input({ antiSpamEnabled: true, messageLimitsBlockedWords: ['спаммаркер'] }),
      text: 'спаммаркер',
      messageId: 'expired-lookup',
      duplicateStateEventTimestampMs: Date.now(),
    });
    expect(result.violations.map((value) => value.ruleCode)).toEqual(['MESSAGE_BLOCKED_WORD']);
    expect(run.coverage('anti-spam-burst')).toMatchObject({
      eligible: 1,
      evaluated: 0,
      expired: 1,
      errors: 0,
    });
    expect(run.coverage('blocked-words')).toMatchObject({ evaluated: 1, matched: 1 });
  });

  it('preserves the original unknown-write error and emits completed, active and unreached observations once', async () => {
    const original = new Error('Unknown Redis write outcome');
    const counters = new MockRedisCounterService();
    jest.spyOn(counters, 'incrementWithTtl').mockRejectedValue(original);
    const run = harness(counters as unknown as RedisCounterService);
    await expect(
      run.service.detect(
        input({ antiSpamEnabled: true, maxMessageLengthEnabled: true, maxMessageLength: 2 }),
      ),
    ).rejects.toBe(original);
    expect(run.diagnostics.recordHotPathProfile).toHaveBeenCalledTimes(1);
    expect(run.coverage('message-length')).toMatchObject({ evaluated: 1, matched: 1, errors: 0 });
    expect(run.coverage('anti-spam-burst')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 0,
      errors: 1,
      interrupted: 0,
    });
    for (const family of [
      'message-count-limit',
      'blocked-words',
      'blocked-domains',
      'photo-cooldown',
      'sticker-cooldown',
    ] as const) {
      expect(run.coverage(family)).toMatchObject({
        configured: 0,
        evaluated: 0,
        errors: 0,
        interrupted: 1,
      });
    }
    expect(run.profile()?.stageDurations).toHaveProperty(['rule-engine.anti-spam-burst']);
    expect(run.profile()?.stageDurations).not.toHaveProperty(['rule-engine.phone-numbers']);
  });

  it.each(['synchronous', 'rejected'] as const)(
    'keeps detection results and original errors when the profile sink fails (%s)',
    async (mode) => {
      const run = harness();
      const diagnosticError = new Error('Diagnostic transport unavailable');
      if (mode === 'synchronous')
        run.diagnostics.recordHotPathProfile.mockImplementation(() => {
          throw diagnosticError;
        });
      else run.diagnostics.recordHotPathProfile.mockRejectedValue(diagnosticError);
      await expect(run.service.detect(input())).resolves.toEqual({ violations: [] });
      const original = new Error('Original detector failure');
      jest.spyOn(run.service, 'detectProfanityForSettings').mockImplementation(() => {
        throw original;
      });
      await expect(run.service.detect(input({ russianProfanityFilterEnabled: true }))).rejects.toBe(
        original,
      );
      expect(run.diagnostics.recordHotPathProfile).toHaveBeenCalledTimes(2);
      await Promise.resolve();
    },
  );

  it('records traffic fail-open errors and continues when its diagnostic callback also throws', async () => {
    const counters = Object.assign(
      Object.create(RedisCounterService.prototype) as RedisCounterService,
      {
        claimEventCooldown: jest
          .fn<
            ReturnType<RedisCounterService['claimEventCooldown']>,
            Parameters<RedisCounterService['claimEventCooldown']>
          >()
          .mockRejectedValue(new Error('Traffic state unavailable')),
      },
    );
    const run = harness(counters);
    run.diagnostics.recordHotPathStageOutcome.mockImplementation(() => {
      throw new Error('Diagnostic failure');
    });
    await expect(
      run.service.detect({
        ...input({ slowModeEnabled: true }),
        messageId: 'traffic-message',
        duplicateStateEventType: 'message_created',
        duplicateStateEventTimestampMs: Date.now(),
      }),
    ).resolves.toEqual({ violations: [] });
    expect(run.coverage('traffic-protection')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 0,
      errors: 1,
      interrupted: 0,
    });
    expect(run.coverage('duplicate-state')).toMatchObject({ skippedDisabled: 1, interrupted: 0 });
    expect(run.coverage('sticker-cooldown')).toMatchObject({ skippedDisabled: 1, interrupted: 0 });
  });

  it('reads modern report-skip configuration once without dispatching the matcher', async () => {
    const run = harness();
    const request = input({
      stopWordsPolicy: stopWordsPolicySchema.parse({
        enabled: true,
        rules: [
          { id: 'word-1', kind: 'WORD', value: 'спаммаркер', enabled: true, matchMode: 'EXACT' },
        ],
        domains: ['example.com'],
      }),
    });
    await expect(
      run.service.detect({
        ...request,
        text: 'спаммаркер https://example.com',
        skipContentFiltersForReport: true,
      }),
    ).resolves.toEqual({ violations: [] });
    for (const family of ['blocked-words', 'blocked-domains'] as const) {
      expect(run.coverage(family)).toMatchObject({
        configured: 1,
        eligible: 0,
        evaluated: 0,
        skippedContent: 1,
      });
    }
    await run.service.detect({ ...request, text: '' });
    // Modern eligibility is dispatch of the configured matcher, including an empty source.
    for (const family of ['blocked-words', 'blocked-domains'] as const) {
      expect(run.coverage(family)).toMatchObject({
        configured: 1,
        eligible: 1,
        evaluated: 1,
        matched: 0,
        skippedContent: 0,
      });
    }
  });

  it('uses the actual enforceable navigation boundary for modern link eligibility', async () => {
    const run = harness();
    await run.service.detect({
      ...input({ linkRulesPolicy: { version: 1, mode: 'DENY_ALL', rules: [] } }),
      navigationTargets: [
        {
          kind: 'external_url',
          target: 'https://example.com',
          normalizedTarget: 'https://example.com',
          enforceable: false,
          origins: [],
        },
      ],
    });
    expect(run.coverage('links')).toMatchObject({
      configured: 1,
      eligible: 0,
      evaluated: 0,
      skippedContent: 1,
    });
  });

  it.each(['blocked', 'stale', 'deadline_exceeded'] as const)(
    'keeps photo/sticker cooldown outcome %s distinct from a valid nonmatch',
    async (outcome) => {
      const claimEventCooldown = jest
        .fn<
          ReturnType<RedisCounterService['claimEventCooldown']>,
          Parameters<RedisCounterService['claimEventCooldown']>
        >()
        .mockResolvedValue(outcome);
      const counters = Object.assign(
        Object.create(RedisCounterService.prototype) as RedisCounterService,
        { claimEventCooldown },
      );
      const run = harness(counters);
      const result = await run.service.detect({
        ...input({ photoMessageCooldownEnabled: true, stickerMessageCooldownEnabled: true }),
        messageId: 'media-message',
        duplicateStateEventTimestampMs: Date.now(),
        hasPhotoAttachment: true,
        hasStickerAttachment: true,
      });
      expect(result.violations.map((value) => value.ruleCode)).toEqual(
        outcome === 'blocked' ? ['PHOTO_RATE_LIMIT', 'STICKER_RATE_LIMIT'] : [],
      );
      for (const family of ['photo-cooldown', 'sticker-cooldown'] as const) {
        expect(run.coverage(family)).toMatchObject({
          configured: 1,
          eligible: 1,
          evaluated: +(outcome === 'blocked'),
          matched: +(outcome === 'blocked'),
          skippedState: +(outcome === 'stale'),
          expired: +(outcome === 'deadline_exceeded'),
          errors: 0,
        });
      }
      expect(claimEventCooldown).toHaveBeenCalledTimes(2);
    },
  );

  it('marks a failed photo lookup active and the unvisited sticker family interrupted', async () => {
    const original = new Error('Unknown photo cooldown write');
    const claimEventCooldown = jest
      .fn<
        ReturnType<RedisCounterService['claimEventCooldown']>,
        Parameters<RedisCounterService['claimEventCooldown']>
      >()
      .mockRejectedValue(original);
    const run = harness(
      Object.assign(Object.create(RedisCounterService.prototype) as RedisCounterService, {
        claimEventCooldown,
      }),
    );
    await expect(
      run.service.detect({
        ...input({ photoMessageCooldownEnabled: true, stickerMessageCooldownEnabled: true }),
        messageId: 'media-error',
        duplicateStateEventTimestampMs: Date.now(),
        hasPhotoAttachment: true,
        hasStickerAttachment: true,
      }),
    ).rejects.toBe(original);
    expect(run.coverage('photo-cooldown')).toMatchObject({
      configured: 1,
      eligible: 1,
      errors: 1,
      interrupted: 0,
    });
    expect(run.coverage('sticker-cooldown')).toMatchObject({
      configured: 0,
      errors: 0,
      interrupted: 1,
    });
  });

  it.each(['stale', 'error'] as const)(
    'retains a valid traffic candidate before a later %s result',
    async (second) => {
      const claimEventCooldown = jest
        .fn<
          ReturnType<RedisCounterService['claimEventCooldown']>,
          Parameters<RedisCounterService['claimEventCooldown']>
        >()
        .mockResolvedValueOnce('allowed');
      if (second === 'stale') claimEventCooldown.mockResolvedValueOnce('stale');
      else
        claimEventCooldown.mockRejectedValueOnce(new Error('Second traffic candidate unavailable'));
      const run = harness(
        Object.assign(Object.create(RedisCounterService.prototype) as RedisCounterService, {
          claimEventCooldown,
        }),
      );
      await expect(
        run.service.detect({
          ...input({ slowModeEnabled: true, mediaMessageCooldownEnabled: true }),
          messageId: 'traffic-partial',
          duplicateStateEventTimestampMs: Date.now(),
          duplicateStateEventType: 'message_created',
          hasPhotoAttachment: true,
        }),
      ).resolves.toEqual({ violations: [] });
      expect(run.coverage('traffic-protection')).toMatchObject({
        configured: 1,
        eligible: 1,
        evaluated: 1,
        matched: 0,
        skippedState: 0,
        errors: +(second === 'error'),
      });
    },
  );

  it('keeps a stale duplicate revision unavailable instead of counting a successful nonmatch', async () => {
    const counters = new MockRedisCounterService();
    jest
      .spyOn(counters, 'replaceRevisionedSetMembershipsBeforeDeadline')
      .mockResolvedValue({ kind: 'stale' });
    const run = harness(counters as unknown as RedisCounterService);
    await expect(
      run.service.detect({
        ...input({ antiDuplicateEnabled: true }),
        messageId: 'duplicate-edit',
        duplicateStateEventType: 'message_edited',
        duplicateStateEventTimestampMs: Date.now(),
      }),
    ).resolves.toEqual({ violations: [] });
    expect(run.coverage('duplicate-state')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 0,
      matched: 0,
      skippedState: 1,
    });
  });

  it('does not rewrite the closed observation when timed-out duplicate state completes late', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      let resolveMutation!: (
        value: Awaited<
          ReturnType<RedisCounterService['replaceRevisionedSetMembershipsBeforeDeadline']>
        >,
      ) => void;
      const mutation = new Promise<
        Awaited<ReturnType<RedisCounterService['replaceRevisionedSetMembershipsBeforeDeadline']>>
      >((resolve) => {
        resolveMutation = resolve;
      });
      const counters = new MockRedisCounterService();
      jest
        .spyOn(counters, 'replaceRevisionedSetMembershipsBeforeDeadline')
        .mockReturnValue(mutation);
      const run = harness(counters as unknown as RedisCounterService);
      const detection = run.service
        .detect({
          ...input({ antiDuplicateEnabled: true }),
          messageId: 'duplicate-late',
          duplicateStateEventType: 'message_edited',
          duplicateStateEventTimestampMs: Date.now(),
        })
        .catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(DUPLICATE_STATE_BUDGET_MS);
      expect(await detection).toMatchObject({ code: 'DUPLICATE_STATE_BUDGET_EXCEEDED' });
      const before = run.profile()?.ruleCoverage;
      expect(run.coverage('duplicate-state')).toMatchObject({ errors: 1, evaluated: 0 });
      resolveMutation({ kind: 'applied', counts: [] });
      await Promise.resolve();
      await Promise.resolve();
      expect(run.diagnostics.recordHotPathProfile).toHaveBeenCalledTimes(1);
      expect(run.profile()?.ruleCoverage).toEqual(before);
      expect(run.coverage('duplicate-state')).toMatchObject({ errors: 1, evaluated: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not count standalone guard rechecks as canonical engine evaluations', () => {
    const run = harness();
    run.service.detectProfanityForSettings('блять', input().settings);
    expect(run.diagnostics.recordHotPathProfile).not.toHaveBeenCalled();
  });
});
