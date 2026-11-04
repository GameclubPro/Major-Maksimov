jest.mock('ioredis', () => {
  const store = new Map<string, string>();
  const seed = store.set.bind(store);
  // Fixture writes represent complete cache publications, including their revision proof.
  store.set = (key: string, value: string) => {
    if (key.startsWith('chat:context:v4:')) {
      const chatId = key.slice('chat:context:v4:'.length);
      seed(
        `chat:context:v4-revision:${chatId}`,
        store.get(`chat:context-revision:v1:${chatId}`) ?? '0',
      );
    }
    return seed(key, value);
  };
  const sets = new Map<string, Set<string>>();
  const subscribers = new Set<(channel: string, payload: string) => void>();

  const createInstance = () => {
    const messageHandlers = new Set<(channel: string, payload: string) => void>();
    const instance = {
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      exists: jest.fn().mockImplementation(async (key: string) => (store.has(key) ? 1 : 0)),
      mget: jest
        .fn()
        .mockImplementation(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
      ttl: jest.fn().mockImplementation(async (key: string) => (store.has(key) ? 60 : -2)),
      pttl: jest.fn().mockResolvedValue(-2),
      set: jest.fn().mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        let deleted = 0;
        for (const key of keys) {
          if (store.delete(key)) {
            deleted += 1;
          }
          if (sets.delete(key)) {
            deleted += 1;
          }
        }
        return deleted;
      }),
      sadd: jest.fn().mockImplementation(async (key: string, ...values: string[]) => {
        const current = sets.get(key) ?? new Set<string>();
        let added = 0;
        for (const value of values) {
          if (!current.has(value)) {
            added += 1;
          }
          current.add(value);
        }
        sets.set(key, current);
        return added;
      }),
      smembers: jest
        .fn()
        .mockImplementation(async (key: string) => Array.from(sets.get(key) ?? [])),
      expire: jest
        .fn()
        .mockImplementation(async (key: string) => (store.has(key) || sets.has(key) ? 1 : 0)),
      eval: jest
        .fn()
        .mockImplementation(async (script: string, keyCount: number, ...input: string[]) => {
          const keys = input.slice(0, keyCount);
          const args = input.slice(keyCount);
          const publish = (channel: string, payload: string) => {
            for (const subscriber of subscribers) {
              subscriber(channel, payload);
            }
          };

          if (script.includes('incoming_timestamp')) {
            const incomingTimestamp = Number(args[0]);
            const incomingPriority = Number(args[1]);
            const currentEpoch = store.get(keys[0] ?? '');
            let exactEpochAndState = false;
            if (currentEpoch) {
              const [timestamp, priority] = currentEpoch.split(':').map(Number);
              exactEpochAndState =
                timestamp === incomingTimestamp &&
                priority === incomingPriority &&
                store.get(keys[1] ?? '') === args[3];
              if (
                timestamp > incomingTimestamp ||
                (timestamp === incomingTimestamp && priority > incomingPriority)
              ) {
                return 0;
              }
            }

            const opaqueKeyIndexes = [2, 4, 5, 6, 7, 8, 9];
            let opaqueMutationsAreNoop = true;
            for (let index = 0; index < opaqueKeyIndexes.length; index += 1) {
              const offset = 8 + index * 5;
              const actual = store.get(keys[opaqueKeyIndexes[index] ?? -1] ?? '');
              const matches =
                args[offset] === '1' ? actual === args[offset + 1] : actual === undefined;
              if (!matches) {
                return -1;
              }
              if (args[offset + 2] !== 'keep') {
                opaqueMutationsAreNoop = false;
              }
            }
            const contextRevisionCurrent =
              store.get(keys[15] ?? '') === (store.get(keys[3] ?? '') ?? '0');
            const recentMode = args[43];
            if (
              exactEpochAndState &&
              opaqueMutationsAreNoop &&
              recentMode === 'deny' &&
              !sets.get(keys[10] ?? '')?.has(args[5] ?? '') &&
              !sets.get(keys[11] ?? '')?.has(args[5] ?? '')
            ) {
              store.delete(keys[14] ?? '');
              if (!contextRevisionCurrent) {
                store.delete(keys[2] ?? '');
                store.delete(keys[15] ?? '');
              }
              publish(args[6] ?? '', args[7] ?? '');
              return 2;
            }
            for (let index = 0; index < opaqueKeyIndexes.length; index += 1) {
              const key = keys[opaqueKeyIndexes[index] ?? -1] ?? '';
              const offset = 8 + index * 5;
              if (args[offset + 2] === 'set') {
                store.set(key, args[offset + 3] ?? '');
              } else if (args[offset + 2] === 'delete') {
                store.delete(key);
              }
            }
            store.set(keys[0] ?? '', args[2] ?? '');
            store.set(keys[1] ?? '', args[3] ?? '');
            store.set(keys[3] ?? '', String(Number(store.get(keys[3] ?? '') ?? '0') + 1));
            if (contextRevisionCurrent && store.has(keys[2] ?? '')) {
              store.set(keys[15] ?? '', store.get(keys[3] ?? '')!);
            } else {
              store.delete(keys[2] ?? '');
              store.delete(keys[15] ?? '');
            }
            store.delete(keys[14] ?? '');
            const recentEntityType = args[45];
            if (recentMode === 'grant') {
              const setKey = recentEntityType === 'chat' ? keys[10] : keys[11];
              if (setKey) {
                const users = sets.get(setKey) ?? new Set<string>();
                users.add(args[5] ?? '');
                sets.set(setKey, users);
              }
            } else if (recentMode === 'deny') {
              sets.get(keys[10] ?? '')?.delete(args[5] ?? '');
              sets.get(keys[11] ?? '')?.delete(args[5] ?? '');
            }
            publish(args[6] ?? '', args[7] ?? '');
            return 1;
          }

          if (script.includes('managed_entities_published_snapshot_set_cas')) {
            const actual = store.get(keys[0] ?? '');
            const matches = args[0] === '1' ? actual === args[1] : actual === undefined;
            if (!matches) {
              return 0;
            }
            store.set(keys[0] ?? '', args[2] ?? '');
            return 1;
          }

          if (script.includes('managed_entities_recent_bootstrap_upsert_cas')) {
            const global = store.get(keys[0] ?? '');
            const globalMatches = args[0] === '1' ? global === args[1] : global === undefined;
            if (!globalMatches) {
              return 0;
            }
            if (args[3] === '1') {
              const userScoped = store.get(keys[1] ?? '');
              const userMatches =
                args[4] === '1' ? userScoped === args[5] : userScoped === undefined;
              if (!userMatches) {
                return 0;
              }
            }
            store.set(keys[0] ?? '', args[2] ?? '');
            store.set(keys[2] ?? '', '1');
            if (args[3] === '1') {
              store.set(keys[1] ?? '', args[6] ?? '');
              const users = sets.get(keys[3] ?? '') ?? new Set<string>();
              users.add(args[8] ?? '');
              sets.set(keys[3] ?? '', users);
            }
            return 1;
          }

          if (script.includes('managed_entities_recent_bootstrap_remove_cas')) {
            const actual = store.get(keys[0] ?? '');
            const matches = args[0] === '1' ? actual === args[1] : actual === undefined;
            if (!matches) {
              return 0;
            }
            if (args[2] === 'set') {
              store.set(keys[0] ?? '', args[3] ?? '');
            } else if (args[2] === 'delete') {
              store.delete(keys[0] ?? '');
            }
            if (args[5] === 'global') {
              store.delete(keys[1] ?? '');
            } else {
              sets.get(keys[2] ?? '')?.delete(args[6] ?? '');
            }
            return 1;
          }

          if (script.includes('revision ~= ARGV[1]')) {
            if ((store.get(keys[0] ?? '') ?? '0') !== args[0]) {
              return 0;
            }
            if (keys.slice(4).some((key) => !store.has(key))) return 0;
            store.set(keys[1] ?? '', args[1] ?? '');
            store.set(keys[3] ?? '', args[0] ?? '');
            store.delete(keys[2] ?? '');
            return 1;
          }
          if (script.includes('revision ~= ARGV[2]')) {
            if (
              store.get(keys[0] ?? '') !== args[0] ||
              (store.get(keys[1] ?? '') ?? '0') !== args[1] ||
              store.get(keys[3] ?? '') !== args[1]
            ) {
              return 0;
            }
            store.set(keys[0] ?? '', args[2] ?? '');
            store.set(keys[1] ?? '', String(Number(store.get(keys[1] ?? '') ?? '0') + 1));
            store.set(keys[3] ?? '', store.get(keys[1] ?? '')!);
            store.delete(keys[2] ?? '');
            publish(args[3] ?? '', args[4] ?? '');
            return 1;
          }
          if (
            script.includes("redis.call('INCR', KEYS[1])") &&
            script.includes("redis.call('DEL', KEYS[2], KEYS[3])")
          ) {
            store.set(keys[0] ?? '', String(Number(store.get(keys[0] ?? '') ?? '0') + 1));
            store.delete(keys[1] ?? '');
            store.delete(keys[2] ?? '');
            publish(args[0] ?? '', args[1] ?? '');
            return 1;
          }

          const [currentKey, oppositeKey] = keys;
          const [
            expectedCurrentExists,
            expectedCurrent,
            expectedOppositeExists,
            expectedOpposite,
            nextCurrent,
            oppositeAction,
            nextOpposite,
          ] = args;
          const current = store.get(currentKey);
          const opposite = store.get(oppositeKey);
          const currentMatches =
            expectedCurrentExists === '1' ? current === expectedCurrent : current === undefined;
          const oppositeMatches =
            expectedOppositeExists === '1' ? opposite === expectedOpposite : opposite === undefined;
          if (!currentMatches || !oppositeMatches) {
            return 0;
          }

          store.set(currentKey, nextCurrent);
          if (oppositeAction === 'set') {
            store.set(oppositeKey, nextOpposite);
          } else if (oppositeAction === 'delete') {
            store.delete(oppositeKey);
          }
          return 1;
        }),
      publish: jest.fn().mockImplementation(async (channel: string, payload: string) => {
        for (const subscriber of subscribers) {
          subscriber(channel, payload);
        }
        return subscribers.size;
      }),
      subscribe: jest.fn().mockResolvedValue(1),
      on: jest.fn().mockImplementation((event: string, handler: unknown) => {
        if (event === 'message' && typeof handler === 'function') {
          const messageHandler = handler as (channel: string, payload: string) => void;
          messageHandlers.add(messageHandler);
          subscribers.add(messageHandler);
        }
        return instance;
      }),
      duplicate: jest.fn().mockImplementation(() => createInstance()),
      multi: jest.fn().mockImplementation(() => {
        const operations: Array<[keyof typeof instance, ...unknown[]]> = [];
        const pipeline = {
          set: (key: string, value: string, ...args: unknown[]) => {
            operations.push(['set', key, value, ...args]);
            return pipeline;
          },
          del: (...keys: string[]) => {
            operations.push(['del', ...keys]);
            return pipeline;
          },
          sadd: (key: string, ...values: string[]) => {
            operations.push(['sadd', key, ...values]);
            return pipeline;
          },
          expire: (key: string, ttlSec: number) => {
            operations.push(['expire', key, ttlSec]);
            return pipeline;
          },
          incr: (key: string) => {
            operations.push(['set', key, String(Number(store.get(key) ?? '0') + 1)]);
            return pipeline;
          },
          exec: jest.fn().mockImplementation(async () => {
            const results: Array<[null, unknown]> = [];
            for (const [method, ...args] of operations) {
              results.push([
                null,
                await (instance[method] as (...values: unknown[]) => Promise<unknown>)(...args),
              ]);
            }
            return results;
          }),
        };
        return pipeline;
      }),
      quit: jest.fn().mockImplementation(async () => {
        for (const handler of messageHandlers) {
          subscribers.delete(handler);
        }
        messageHandlers.clear();
      }),
    };

    return instance;
  };

  const RedisMock = Object.assign(
    jest.fn().mockImplementation(() => createInstance()),
    {
      __store: store,
      __sets: sets,
      __subscribers: subscribers,
    },
  );

  return {
    __esModule: true,
    default: RedisMock,
  };
});

import Redis from 'ioredis';
import type { ChatContextLocalCache } from './chat-context-local-cache';
import type { ChatSummary } from '@maxim/contracts';
import type { ChatSettings } from '../prisma/prisma-client';
import {
  ChatContextCacheService,
  type ChatContext,
  type ManagedEntitiesPublishedSnapshot,
} from './chat-context-cache.service';

function buildChatSummary(chatId: string): ChatSummary {
  return {
    id: chatId,
    title: 'Chat title',
    createdAt: '2026-04-04T10:00:00.000Z',
    entityType: 'chat',
    link: null,
    channelOverview: null,
    primaryBotId: null,
    assignedBots: [],
    sharedMode: 'owned',
  };
}

function buildSettings(chatId: string): ChatSettings {
  const now = new Date();
  return {
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
    id: 'settings-1',
    chatId,
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
    duplicateWarnWindowSec: 43200,
    duplicateWarnMaxCount: 2,
    duplicateMuteWindowSec: 86400,
    duplicateMuteMaxCount: 3,
    duplicateMuteDurationHours: 6,
    duplicateBanWindowSec: 172800,
    duplicateBanMaxCount: 4,
    linkPolicy: 'ALLOWLIST_ONLY',
    linkPolicyRevision: 1,
    linkPolicyEffectiveAt: now,
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
    nightModeStartTimeMinutes: 1380,
    nightModeEndTimeMinutes: 480,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: false,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
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
    createdAt: now,
    updatedAt: now,
  };
}

function createConfigMock() {
  return {
    getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  };
}

function getRedisMutationMock(service: ChatContextCacheService): {
  get: jest.Mock;
  mget: jest.Mock;
  eval: jest.Mock;
} {
  return (
    service as unknown as {
      redis: {
        get: jest.Mock;
        mget: jest.Mock;
        eval: jest.Mock;
      };
    }
  ).redis;
}

function getChatContextReadState(service: ChatContextCacheService) {
  return service as unknown as {
    chatContextReadGenerations: Map<string, { invalidated: boolean; readers: number }>;
    chatContextInFlightLoads: Map<string, Promise<ChatContext>>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function buildContextRow(chatId: string, adminUserIds = ['user-1']) {
  return {
    id: chatId,
    title: 'Chat title',
    settings: buildSettings(chatId),
    domains: [],
    admins: adminUserIds.map((userId) => ({ userId })),
    rules: null,
  };
}

describe('ChatContextCacheService', () => {
  const maxBotLinkService = {
    resolveBotRoute: jest.fn().mockResolvedValue({
      purpose: 'default',
      chatId: 'chat-1',
      primaryBotId: '777000_bot',
      botId: '777000_bot',
      candidateBotIds: ['777000_bot'],
      reason: 'chat_primary',
    }),
    resolveBotId: jest.fn().mockResolvedValue('777000_bot'),
    getContextOrDefaultBotId: jest.fn().mockReturnValue('777000_bot'),
    rememberChatBotBinding: jest.fn(),
    forgetChatBotBinding: jest.fn(),
  };

  beforeEach(() => {
    (Redis as unknown as { __store: Map<string, string> }).__store.clear();
    (Redis as unknown as { __sets: Map<string, Set<string>> }).__sets.clear();
    (
      Redis as unknown as { __subscribers: Set<(channel: string, payload: string) => void> }
    ).__subscribers.clear();
    jest.clearAllMocks();
    maxBotLinkService.resolveBotRoute.mockResolvedValue({
      purpose: 'default',
      chatId: 'chat-1',
      primaryBotId: '777000_bot',
      botId: '777000_bot',
      candidateBotIds: ['777000_bot'],
      reason: 'chat_primary',
    });
    maxBotLinkService.resolveBotId.mockResolvedValue('777000_bot');
    maxBotLinkService.getContextOrDefaultBotId.mockReturnValue('777000_bot');
  });

  it('isolates media references from legacy full-context cache readers', () => {
    expect(ChatContextCacheService.cacheKey('chat-1')).toBe('chat:context:v4:chat-1');
    expect(ChatContextCacheService.legacyCacheKey('chat-1')).toBe('chat:context:v3:chat-1');
  });

  it('disables Redis ready check on the pub/sub subscriber connection', () => {
    const prisma = {} as never;

    new ChatContextCacheService(prisma, createConfigMock() as never, maxBotLinkService as never);

    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      duplicate: jest.Mock;
    };
    expect(redisInstance.duplicate).toHaveBeenCalledWith({ enableReadyCheck: false });
  });

  it('loads existing chat context with a single read and caches the result', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [{ domain: 'example.com' }],
          admins: [{ userId: 'user-1' }],
          rules: null,
        }),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0].value as {
      get: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    const context = await service.getChatContext(chatId, 'Chat title');

    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(context).toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
  });

  it('initializes missing chat context with an upsert fallback', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [{ domain: 'example.com' }],
          admins: [{ userId: 'user-1' }],
          rules: null,
        }),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    await expect(service.getChatContext(chatId, 'Chat title')).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });

    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.chat.upsert).toHaveBeenCalledTimes(1);
  });

  it('prefers the unified chat route when initializing a missing chat context row', async () => {
    const chatId = 'chat-2';
    const settings = buildSettings(chatId);
    maxBotLinkService.resolveBotRoute.mockResolvedValueOnce({
      purpose: 'default',
      chatId,
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      candidateBotIds: ['id613002203036_4_bot'],
      reason: 'chat_cache',
    });
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [],
          admins: [],
          rules: null,
        }),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    await service.getChatContext(chatId, 'Chat title');

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'default',
      chatId,
    });
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          botId: 'id613002203036_4_bot',
          primaryBotId: 'id613002203036_4_bot',
        }),
      }),
    );
  });

  it('deduplicates concurrent cold chat context loads', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    let resolveFindUnique!: (value: unknown) => void;
    const findUniquePromise = new Promise((resolve) => {
      resolveFindUnique = resolve;
    });
    const prisma = {
      chat: {
        findUnique: jest.fn().mockReturnValue(findUniquePromise),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
      set: jest.Mock;
    };
    redisInstance.get.mockResolvedValue(null);

    const firstLoad = service.getChatContext(chatId, 'Chat title');
    const secondLoad = service.getChatContext(chatId, 'Chat title');

    resolveFindUnique({
      id: chatId,
      title: 'Chat title',
      settings,
      domains: [{ domain: 'example.com' }],
      admins: [{ userId: 'user-1' }],
      rules: null,
    });

    await expect(firstLoad).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
    await expect(secondLoad).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
    expect(redisInstance.get).toHaveBeenCalledTimes(1);
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
  });

  it('serves repeated chat context reads from the local cache before hitting redis again', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const cachedSettings = JSON.parse(JSON.stringify(settings)) as ChatSettings;
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockResolvedValue([
      JSON.stringify({
        chatId,
        title: 'Chat title',
        settings: cachedSettings,
        domainAllowlist: ['example.com'],
        adminUserIds: ['user-1'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
      '0',
      null,
    ]);

    await expect(service.getChatContext(chatId, 'Chat title')).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings: cachedSettings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
    await expect(service.getChatContext(chatId, 'Chat title')).resolves.toEqual({
      chatId,
      title: 'Chat title',
      settings: cachedSettings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });

    expect(redisInstance.mget).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'refreshes settings at the original local deadline despite continuous reads (title change: %s)',
    async (changeTitle) => {
      let now = 1_000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const chatId = `absolute-context-${changeTitle}`;
      const config = createConfigMock();
      config.get.mockImplementation((key) =>
        key === 'CHAT_CONTEXT_LOCAL_CACHE_TTL_MS' ? 100 : undefined,
      );
      const service = new ChatContextCacheService(
        { chat: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } } as never,
        config as never,
        maxBotLinkService as never,
      );
      const internals = service as unknown as {
        patchChatContextInRedis: (
          chatId: string,
          patch: (current: ChatContext) => ChatContext,
        ) => Promise<void>;
      };
      // Isolate the local title replacement from the ordinary invalidation its Redis patch emits.
      const patch = jest.spyOn(internals, 'patchChatContextInRedis').mockResolvedValue(undefined);
      const store = (Redis as unknown as { __store: Map<string, string> }).__store;
      const publish = (revision: number, title: string) =>
        store.set(
          ChatContextCacheService.cacheKey(chatId),
          JSON.stringify({
            chatId,
            title,
            settings: { ...buildSettings(chatId), stopWordsRevision: revision },
            domainAllowlist: [],
            adminUserIds: [],
            rulesPublishedUrl: null,
            rulesPublishedMessageId: null,
          }),
        );
      try {
        publish(0, 'Original title');
        expect((await service.getChatContext(chatId)).settings.stopWordsRevision).toBe(0);
        // A disconnected subscriber misses this source update and cannot clear its local copy.
        publish(1, changeTitle ? 'New title' : 'Original title');
        for (now = 1_020; now < 1_100; now += 20) {
          const context = await service.getChatContext(
            chatId,
            changeTitle ? 'New title' : undefined,
          );
          expect(context.settings.stopWordsRevision).toBe(0);
          if (changeTitle) expect(context.title).toBe('New title');
        }
        expect((await service.getChatContext(chatId)).settings.stopWordsRevision).toBe(1);
        expect(getRedisMutationMock(service).mget).toHaveBeenCalledTimes(2);
        expect(patch).toHaveBeenCalledTimes(changeTitle ? 1 : 0);
      } finally {
        patch.mockRestore();
        clock.mockRestore();
        await service.onModuleDestroy();
      }
    },
  );

  it('invalidates only the local chat context without issuing a Redis mutation', async () => {
    const chatId = 'chat-local-invalidation';
    const cachedSettings = JSON.parse(JSON.stringify(buildSettings(chatId))) as ChatSettings;
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
      eval: jest.Mock;
    };
    redisInstance.mget.mockResolvedValue([
      JSON.stringify({
        chatId,
        title: 'Local invalidation',
        settings: cachedSettings,
        domainAllowlist: [],
        adminUserIds: ['user-1'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
      '0',
      null,
    ]);

    await service.getChatContext(chatId, 'Local invalidation');
    await service.getChatContext(chatId, 'Local invalidation');
    service.invalidateLocal(chatId);
    await service.getChatContext(chatId, 'Local invalidation');

    expect(redisInstance.mget).toHaveBeenCalledTimes(2);
    expect(redisInstance.eval).not.toHaveBeenCalled();
  });

  it('keeps a maximal standard notice image and full settings locally during hot reads', async () => {
    const chatId = 'max-standard-image';
    const base64 = Buffer.alloc(6_000_000, 1).toString('base64');
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    store.set(
      ChatContextCacheService.cacheKey(chatId),
      JSON.stringify({
        chatId,
        title: 'Maximal standard image',
        settings: {
          ...buildSettings(chatId),
          botSpeechMedia: {
            greetingBotMessageText: { base64, mimeType: 'image/jpeg', fileName: 'notice.jpg' },
          },
        },
        domainAllowlist: ['example.com'],
        adminUserIds: ['user-1'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
    );

    const first = await service.getChatContext(chatId);
    expect(base64.length).toBe(8_000_000);
    expect(first.settings.botSpeechMedia).toEqual({
      greetingBotMessageText: { base64, mimeType: 'image/jpeg', fileName: 'notice.jpg' },
    });
    expect(first.adminUserIds).toEqual(['user-1']);
    expect(first.settings.nightModeTimezone).toBe('Europe/Moscow');
    expect(await service.getChatContext(chatId)).toBe(first);
    expect(await service.getChatContext(chatId)).toBe(first);
    expect(getRedisMutationMock(service).mget).toHaveBeenCalledTimes(1);
    expect(service.getLocalCacheSnapshot()).toMatchObject({
      maxBytes: 128 * 1024 * 1024,
      maxEntryBytes: 128 * 1024 * 1024,
      entries: 1,
      hits: 2,
      misses: 1,
      oversizedSkips: 0,
      capacityEvictions: 0,
    });
    expect(service.getLocalCacheSnapshot().estimatedBytes).toBeGreaterThan(16_000_000);
    expect(service.getLocalCacheSnapshot().estimatedBytes).toBeLessThan(32 * 1024 * 1024);
  });

  it('keeps several standard notice images in full settings hot within the total byte budget', async () => {
    const chatId = 'several-standard-images';
    const media = {
      greetingBotMessageText: {
        base64: Buffer.alloc(6_000_000, 1).toString('base64'),
        mimeType: 'image/jpeg',
        fileName: 'greeting.jpg',
      },
      nightModeBotMessageText: {
        base64: Buffer.alloc(6_000_000, 2).toString('base64'),
        mimeType: 'image/jpeg',
        fileName: 'closed.jpg',
      },
      nightModeOpenMessageText: {
        base64: Buffer.alloc(6_000_000, 3).toString('base64'),
        mimeType: 'image/jpeg',
        fileName: 'opened.jpg',
      },
    };
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    store.set(
      ChatContextCacheService.cacheKey(chatId),
      JSON.stringify({
        chatId,
        title: 'Several standard images',
        settings: { ...buildSettings(chatId), botSpeechMedia: media },
        domainAllowlist: ['example.com'],
        adminUserIds: ['user-1'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
    );

    const first = await service.getChatContext(chatId);
    expect(first.settings.botSpeechMedia).toEqual(media);
    expect(first.adminUserIds).toEqual(['user-1']);
    expect(first.settings.nightModeTimezone).toBe('Europe/Moscow');
    expect(await service.getChatContext(chatId)).toBe(first);
    expect(await service.getChatContext(chatId)).toBe(first);
    expect(getRedisMutationMock(service).mget).toHaveBeenCalledTimes(1);
    const snapshot = service.getLocalCacheSnapshot();
    expect(snapshot).toMatchObject({
      maxBytes: 128 * 1024 * 1024,
      maxEntryBytes: 128 * 1024 * 1024,
      entries: 1,
      hits: 2,
      misses: 1,
      oversizedSkips: 0,
      capacityEvictions: 0,
    });
    expect(snapshot.estimatedBytes).toBeGreaterThan(48_000_000);
    expect(snapshot.estimatedBytes).toBeLessThanOrEqual(snapshot.maxBytes);
  });

  it('falls back to Redis after local LRU eviction while preserving complete media settings', async () => {
    const config = createConfigMock();
    config.get.mockImplementation((key) =>
      key === 'CHAT_CONTEXT_LOCAL_CACHE_MAX_ENTRIES' ? 1 : undefined,
    );
    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    for (const chatId of ['chat-a', 'chat-b']) {
      store.set(
        ChatContextCacheService.cacheKey(chatId),
        JSON.stringify({
          chatId,
          title: 'Cached chat',
          settings: {
            ...buildSettings(chatId),
            botSpeechMedia: {
              greetingBotMessageText: { base64: 'aW1hZ2U=', mimeType: 'image/jpeg' },
            },
          },
          adminUserIds: ['user-1'],
        }),
      );
    }
    await service.getChatContext('chat-a');
    await service.getChatContext('chat-b');
    await expect(service.getChatContext('chat-a')).resolves.toMatchObject({
      adminUserIds: ['user-1'],
      settings: {
        botSpeechMedia: {
          greetingBotMessageText: { base64: 'aW1hZ2U=', mimeType: 'image/jpeg' },
        },
      },
    });
    expect(getRedisMutationMock(service).mget).toHaveBeenCalledTimes(3);
    expect(service.getLocalCacheSnapshot()).toMatchObject({ entries: 1, capacityEvictions: 2 });
  });

  it('returns oversized Redis contexts intact without storing or reserializing them locally', async () => {
    const config = createConfigMock();
    config.get.mockImplementation((key) =>
      key === 'CHAT_CONTEXT_LOCAL_CACHE_MAX_ENTRY_BYTES' ? 1024 : undefined,
    );
    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const media = 'x'.repeat(5000);
    store.set(
      ChatContextCacheService.cacheKey('large-chat'),
      JSON.stringify({
        chatId: 'large-chat',
        title: 'Large chat',
        settings: { botSpeechMedia: media },
      }),
    );
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
      for (let read = 0; read < 2; read += 1) {
        await expect(service.getChatContext('large-chat')).resolves.toMatchObject({
          settings: { botSpeechMedia: media },
        });
      }
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
    expect(getRedisMutationMock(service).mget).toHaveBeenCalledTimes(2);
    expect(service.getLocalCacheSnapshot()).toMatchObject({ entries: 0, estimatedBytes: 0 });
    expect(service.getLocalCacheSnapshot().oversizedSkips).toBeGreaterThan(0);
  });

  it('sweeps cold entries in bounded timer batches and stops its timer on shutdown', async () => {
    jest.useFakeTimers();
    const config = createConfigMock();
    config.get.mockImplementation((key) => {
      if (key === 'CHAT_CONTEXT_LOCAL_CACHE_TTL_MS') return 100;
      if (key === 'CHAT_CONTEXT_LOCAL_CACHE_SWEEP_INTERVAL_MS') return 1000;
      if (key === 'CHAT_CONTEXT_LOCAL_CACHE_SWEEP_BATCH_SIZE') return 1;
      return undefined;
    });
    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    try {
      await service.onModuleInit();
      for (const chatId of ['cold-a', 'cold-b']) {
        store.set(
          ChatContextCacheService.cacheKey(chatId),
          JSON.stringify({ chatId, title: chatId }),
        );
        await service.getChatContext(chatId);
      }
      await jest.advanceTimersByTimeAsync(1000);
      expect(service.getLocalCacheSnapshot()).toMatchObject({ entries: 1, sweepInspected: 1 });
      await jest.advanceTimersByTimeAsync(1000);
      expect(service.getLocalCacheSnapshot()).toMatchObject({ entries: 0, estimatedBytes: 0 });
      await service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('propagates chat context invalidation to other service instances', async () => {
    const chatId = 'chat-1';
    const initialSettings = buildSettings(chatId);
    const updatedSettings = {
      ...buildSettings(chatId),
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: true,
    };
    const prismaReader = {
      chat: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: chatId,
            title: 'Chat title',
            settings: initialSettings,
            domains: [],
            admins: [],
            rules: null,
          })
          .mockResolvedValueOnce({
            id: chatId,
            title: 'Chat title',
            settings: updatedSettings,
            domains: [],
            admins: [],
            rules: null,
          }),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const invalidator = new ChatContextCacheService(
      { chat: {} } as never,
      config as never,
      maxBotLinkService as never,
    );
    const readerBotLinks = {
      ...maxBotLinkService,
      forgetChatBotBinding: jest.fn(),
    };
    const reader = new ChatContextCacheService(
      prismaReader as never,
      config as never,
      readerBotLinks as never,
    );

    await invalidator.onModuleInit();
    await reader.onModuleInit();

    await expect(reader.getChatContext(chatId, 'Chat title')).resolves.toMatchObject({
      chatId,
      settings: expect.objectContaining({
        nightModeForceCloseEnabled: false,
      }),
    });
    await invalidator.invalidate(chatId);
    expect(readerBotLinks.forgetChatBotBinding).toHaveBeenCalledTimes(1);
    expect(readerBotLinks.forgetChatBotBinding).toHaveBeenCalledWith(chatId);
    await expect(reader.getChatContext(chatId, 'Chat title')).resolves.toMatchObject({
      chatId,
      settings: expect.objectContaining({
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: true,
      }),
    });

    expect(prismaReader.chat.findUnique).toHaveBeenCalledTimes(2);

    await invalidator.onModuleDestroy();
    await reader.onModuleDestroy();
  });

  it('patches cached chat titles without invalidating the full chat context', async () => {
    const chatId = 'chat-1';
    const cachedSettings = JSON.parse(JSON.stringify(buildSettings(chatId))) as ChatSettings;
    const prisma = {
      chat: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
      eval: jest.Mock;
      del: jest.Mock;
    };
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    store.set(
      ChatContextCacheService.cacheKey(chatId),
      JSON.stringify({
        chatId,
        title: 'Chat 1',
        settings: cachedSettings,
        domainAllowlist: ['example.com'],
        adminUserIds: ['user-1'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
    );

    await expect(service.getChatContext(chatId, 'Fresh title')).resolves.toEqual({
      chatId,
      title: 'Fresh title',
      settings: cachedSettings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });

    await expect(service.getChatContext(chatId)).resolves.toEqual({
      chatId,
      title: 'Fresh title',
      settings: cachedSettings,
      domainAllowlist: ['example.com'],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });

    expect(prisma.chat.updateMany).toHaveBeenCalledWith({
      where: {
        id: chatId,
        title: {
          not: 'Fresh title',
        },
      },
      data: {
        title: 'Fresh title',
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(redisInstance.eval).toHaveBeenCalledWith(
      expect.stringContaining('revision ~= ARGV[2]'),
      4,
      ChatContextCacheService.cacheKey(chatId),
      ChatContextCacheService.chatContextRevisionKey(chatId),
      ChatContextCacheService.legacyCacheKey(chatId),
      ChatContextCacheService.cachedContextRevisionKey(chatId),
      expect.stringContaining('"title":"Chat 1"'),
      '0',
      expect.stringContaining('"title":"Fresh title"'),
      expect.any(String),
      expect.any(String),
    );
    expect(store.get(ChatContextCacheService.cacheKey(chatId))).toEqual(
      expect.stringContaining('"title":"Fresh title"'),
    );
    expect(redisInstance.del).not.toHaveBeenCalled();
    expect(redisInstance.mget).toHaveBeenCalledTimes(3);
  });

  it('stores admin access decisions in redis with ttl', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
      pttl: jest.Mock;
    };

    await service.setAdminAccess('chat-1', 'user-1', 'granted');
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.adminAccessKey('chat-1', 'user-1'),
      'granted',
      'EX',
      900,
    );

    redisInstance.get.mockResolvedValueOnce('bot_denied');
    await expect(service.getAdminAccess('chat-1', 'user-1')).resolves.toBe('bot_denied');
  });

  it('stores chat admin lookup backoff markers in redis with ttl', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      pttl: jest.Mock;
    };

    await service.activateAdminLookupBackoff(' chat-1 ', 30);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.adminLookupBackoffKey('chat-1'),
      '1',
      'EX',
      30,
    );

    redisInstance.pttl.mockResolvedValueOnce(12_000);
    await expect(service.getAdminLookupBackoffRemainingMs(' chat-1 ')).resolves.toBe(12_000);
    expect(redisInstance.pttl).toHaveBeenCalledWith(
      ChatContextCacheService.adminLookupBackoffKey('chat-1'),
    );
  });

  it('reads admin access decisions in batch with a single redis roundtrip', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockResolvedValueOnce(['granted', '0', null]);

    await expect(
      service.getAdminAccessBatch('chat-1', ['user-1', 'user-2', 'user-3']),
    ).resolves.toEqual(
      new Map([
        ['user-1', 'granted'],
        ['user-2', 'user_denied'],
        ['user-3', null],
      ]),
    );
    expect(redisInstance.mget).toHaveBeenCalledWith(
      ChatContextCacheService.adminAccessKey('chat-1', 'user-1'),
      ChatContextCacheService.adminAccessKey('chat-1', 'user-2'),
      ChatContextCacheService.adminAccessKey('chat-1', 'user-3'),
    );
  });

  it('patches cached chat admins without reloading chat context from prisma', async () => {
    const chatId = 'chat-1';
    const settings = buildSettings(chatId);
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: chatId,
          title: 'Chat title',
          settings,
          domains: [{ domain: 'example.com' }],
          admins: [{ userId: 'user-1' }],
          rules: null,
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        }),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      eval: jest.Mock;
    };

    await service.getChatContext(chatId, 'Chat title');
    await service.rememberChatAdminUser(chatId, 'user-2');

    await expect(service.getChatContext(chatId)).resolves.toEqual(
      expect.objectContaining({
        adminUserIds: ['user-1', 'user-2'],
      }),
    );
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(1);
    expect(redisInstance.eval).toHaveBeenCalledWith(
      expect.stringContaining('revision ~= ARGV[2]'),
      4,
      ChatContextCacheService.cacheKey(chatId),
      ChatContextCacheService.chatContextRevisionKey(chatId),
      ChatContextCacheService.legacyCacheKey(chatId),
      ChatContextCacheService.cachedContextRevisionKey(chatId),
      expect.stringContaining('"user-1"'),
      expect.any(String),
      expect.stringContaining('"user-2"'),
      expect.any(String),
      expect.any(String),
    );
  });

  it('stores and invalidates managed entity header cache entries', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
      del: jest.Mock;
    };

    const header = {
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'chat' as const,
      link: 'https://max.ru/team',
      participantsCount: 42,
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned' as const,
      accessDiagnostics: {
        state: 'ok' as const,
        lastDetectedAt: null,
        lastCheckedAt: null,
        freshUntil: null,
        source: 'unknown' as const,
        activeBotCount: 0,
        lostBots: [],
      },
      viewerAccess: {
        state: 'checking' as const,
        reason: null,
        checkedAt: null,
        canEdit: false,
      },
    };

    await service.setManagedEntityHeader(header);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'chat'),
      JSON.stringify(header),
      'EX',
      3600,
    );

    redisInstance.get.mockResolvedValueOnce(JSON.stringify(header));
    await expect(service.getManagedEntityHeader('chat-1', 'chat')).resolves.toEqual(header);

    await service.invalidateManagedEntityHeader('chat-1');
    expect(redisInstance.del).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'chat'),
      ChatContextCacheService.managedEntityHeaderKey('chat-1', 'channel'),
    );
  });

  it('fails open when managed entity header redis reads stall', async () => {
    jest.useFakeTimers();

    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      get: jest.Mock;
    };
    redisInstance.get.mockImplementationOnce(() => new Promise(() => undefined));

    const pendingHeader = service.getManagedEntityHeader('chat-1', 'channel');
    await jest.advanceTimersByTimeAsync(150);

    await expect(pendingHeader).resolves.toBeNull();
  });

  it('bounds a stalled header batch once for the entire list and rejects foreign cached identities', async () => {
    jest.useFakeTimers();
    const config = { getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379') };
    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redis = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as { mget: jest.Mock };
    const entities = Array.from({ length: 1000 }, (_, index) => ({
      id: `header-${index}`,
      entityType: 'chat' as const,
    }));
    redis.mget.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = service.getManagedEntityHeaders(entities);
    await jest.advanceTimersByTimeAsync(150);
    expect(await pending).toEqual(Array(1000).fill(null));
    expect(redis.mget).toHaveBeenCalledTimes(1);
    redis.mget.mockResolvedValueOnce([
      JSON.stringify({ id: 'foreign', entityType: 'chat' }),
      JSON.stringify({ id: 'header-1', entityType: 'channel' }),
      '{broken',
    ]);
    expect(await service.getManagedEntityHeaders(entities.slice(0, 3))).toEqual([null, null, null]);
  });

  it('stores and reads managed entity bot avatar snapshots', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
      get: jest.fn().mockReturnValue(null),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
    };

    await service.setManagedEntityBotProfile('777000_bot', {
      avatarUrl: 'https://cdn.max.ru/u/777000/avatar.jpg',
    });
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntityBotProfileKey('777000_bot'),
      JSON.stringify({ avatarUrl: 'https://cdn.max.ru/u/777000/avatar.jpg' }),
      'EX',
      6 * 60 * 60,
    );

    redisInstance.get.mockResolvedValueOnce(
      JSON.stringify({ avatarUrl: 'https://cdn.max.ru/u/777000/avatar.jpg' }),
    );

    await expect(service.getManagedEntityBotProfile('777000_bot')).resolves.toEqual({
      avatarUrl: 'https://cdn.max.ru/u/777000/avatar.jpg',
    });
  });

  it('stores managed entity refresh cooldown and backoff markers in redis', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      get: jest.Mock;
      pttl: jest.Mock;
    };

    await service.activateManagedEntitiesRefreshCooldown('user-1', 'channel', 30);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntitiesRefreshCooldownKey('user-1', 'channel'),
      '1',
      'EX',
      30,
    );

    redisInstance.get.mockResolvedValueOnce('1');
    await expect(service.isManagedEntitiesRefreshCooldownActive('user-1', 'channel')).resolves.toBe(
      true,
    );

    await service.activateManagedEntitiesRefreshBackoff('user-1', 'channel', 60);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedEntitiesRefreshBackoffKey('user-1', 'channel'),
      '1',
      'EX',
      60,
    );

    redisInstance.get.mockResolvedValueOnce('1');
    await expect(service.isManagedEntitiesRefreshBackoffActive('user-1', 'channel')).resolves.toBe(
      true,
    );

    redisInstance.pttl.mockResolvedValueOnce(45_000);
    await expect(
      service.getManagedEntitiesRefreshBackoffRemainingMs('user-1', 'channel'),
    ).resolves.toBe(45_000);

    await service.activateManagedRefreshSourceBackoff(15);
    expect((redisInstance as unknown as { eval: jest.Mock }).eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      ChatContextCacheService.managedRefreshSourceBackoffKey(),
      15_000,
    );

    redisInstance.get.mockResolvedValueOnce('1');
    await expect(service.isManagedRefreshSourceBackoffActive()).resolves.toBe(true);

    redisInstance.pttl.mockResolvedValueOnce(12_000);
    await expect(service.getManagedRefreshSourceBackoffRemainingMs()).resolves.toBe(12_000);
  });

  it('stores managed giveaway runner retry state in redis', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };

    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      set: jest.Mock;
      pttl: jest.Mock;
      multi: jest.Mock;
      del: jest.Mock;
    };
    const exec = jest.fn().mockResolvedValue([
      [null, 3],
      [null, 1],
    ]);
    redisInstance.multi.mockReturnValue({
      incr: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec,
    });

    await service.activateManagedGiveawayRunnerBackoff('giveaway-1', 120);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey('giveaway-1'),
      '1',
      'EX',
      120,
    );

    redisInstance.pttl.mockResolvedValueOnce(90_000);
    await expect(service.getManagedGiveawayRunnerBackoffRemainingMs('giveaway-1')).resolves.toBe(
      90_000,
    );

    await service.activateManagedGiveawayRunnerDefer('giveaway-1', 1800);
    expect(redisInstance.set).toHaveBeenCalledWith(
      ChatContextCacheService.managedGiveawayRunnerDeferKey('giveaway-1'),
      '1',
      'EX',
      1800,
    );

    redisInstance.pttl.mockResolvedValueOnce(600_000);
    await expect(service.getManagedGiveawayRunnerDeferRemainingMs('giveaway-1')).resolves.toBe(
      600_000,
    );

    await expect(
      service.incrementManagedGiveawayRunnerFailureCount('giveaway-1', 3600),
    ).resolves.toBe(3);
    expect(redisInstance.multi).toHaveBeenCalled();

    await service.clearManagedGiveawayRunnerRetryCounters('giveaway-1');
    expect(redisInstance.del).toHaveBeenCalledWith(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey('giveaway-1'),
      ChatContextCacheService.managedGiveawayRunnerFailureCountKey('giveaway-1'),
    );

    await service.clearManagedGiveawayRunnerFailureState('giveaway-1');
    expect(redisInstance.del).toHaveBeenCalledWith(
      ChatContextCacheService.managedGiveawayRunnerBackoffKey('giveaway-1'),
      ChatContextCacheService.managedGiveawayRunnerFailureCountKey('giveaway-1'),
      ChatContextCacheService.managedGiveawayRunnerDeferKey('giveaway-1'),
    );
  });

  it('stores and restores managed entities published snapshots', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0].value as {
      eval: jest.Mock;
    };
    const snapshot = {
      version: 'snapshot-v1',
      builtAt: '2026-04-04T10:00:00.000Z',
      lastSyncedAt: '2026-04-04T09:59:00.000Z',
      itemCount: 1,
      itemsHash: 'hash-v1',
      items: [buildChatSummary('chat-1')],
    };

    await expect(
      service.setManagedEntitiesPublishedSnapshot('admin-1', 'chat', snapshot, 3600, {
        expectedVersion: null,
      }),
    ).resolves.toBe(true);
    expect(redisInstance.eval).toHaveBeenCalledWith(
      expect.stringContaining('managed_entities_published_snapshot_set_cas'),
      1,
      'chat:managed-view-snapshot:v1:chat:admin-1',
      '0',
      '',
      JSON.stringify(snapshot),
      '3600',
    );

    await expect(service.getManagedEntitiesPublishedSnapshot('admin-1', 'chat')).resolves.toEqual(
      snapshot,
    );
  });

  it('atomically upserts a visible entity and removes a stale opposite-tab card', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0].value as {
      eval: jest.Mock;
    };
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const currentKey = 'chat:managed-view-snapshot:v1:channel:admin-1';
    const oppositeKey = 'chat:managed-view-snapshot:v1:chat:admin-1';
    const staleSummary = {
      ...buildChatSummary('-100-forwarded'),
      link: 'https://max.ru/old-link',
      avatarUrl: 'https://cdn.max/old-avatar.png',
    };
    store.set(
      oppositeKey,
      JSON.stringify({
        version: 'old-chat-snapshot',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:00.000Z',
        itemCount: 1,
        itemsHash: 'old-hash',
        items: [staleSummary],
      }),
    );
    const baseSummary = buildChatSummary('-100-forwarded');
    const summary = {
      id: baseSummary.id,
      title: 'Новый канал',
      entityType: 'channel' as const,
      createdAt: baseSummary.createdAt,
      avatarUrl: null as string | null,
      channelOverview: baseSummary.channelOverview,
      primaryBotId: baseSummary.primaryBotId,
      assignedBots: baseSummary.assignedBots,
      sharedMode: baseSummary.sharedMode,
    };

    await service.upsertManagedEntityPublishedSnapshot('admin-1', summary, 3600);

    expect(redisInstance.eval).toHaveBeenCalledTimes(1);
    expect(redisInstance.eval.mock.calls[0]?.slice(1, 4)).toEqual([2, currentKey, oppositeKey]);
    expect(store.has(oppositeKey)).toBe(false);
    const stored = JSON.parse(store.get(currentKey) ?? 'null') as ManagedEntitiesPublishedSnapshot;
    expect(stored.version).toMatch(/^handshake:-100-forwarded:[0-9a-f-]+:current$/u);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0]).toEqual(
      expect.objectContaining({
        id: '-100-forwarded',
        title: 'Новый канал',
        link: 'https://max.ru/old-link',
        avatarUrl: null,
        assignedBots: [],
      }),
    );
    expect(Array.isArray(stored.items[0]?.assignedBots)).toBe(true);
    await expect(
      service.getManagedEntitiesPublishedSnapshot('admin-1', 'channel'),
    ).resolves.toEqual(stored);
  });

  it('stores and restores managed entities published diffs', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0].value as {
      get: jest.Mock;
      set: jest.Mock;
    };
    const diff = {
      baseVersion: 'snapshot-v1',
      nextVersion: 'snapshot-v2',
      added: [buildChatSummary('chat-2')],
      updated: [buildChatSummary('chat-3')],
      removedIds: ['chat-1'],
      orderedIds: ['chat-2', 'chat-3'],
      changeCount: 3,
    };

    await service.setManagedEntitiesPublishedDiff('admin-1', 'chat', 'snapshot-v1', diff, 3600);
    expect(redisInstance.set).toHaveBeenCalledWith(
      'chat:managed-view-diff:v1:chat:admin-1:snapshot-v1',
      JSON.stringify(diff),
      'EX',
      3600,
    );

    redisInstance.get.mockResolvedValueOnce(JSON.stringify(diff));
    await expect(
      service.getManagedEntitiesPublishedDiff('admin-1', 'chat', 'snapshot-v1'),
    ).resolves.toEqual(diff);
  });

  it('returns user-scoped recent bootstrap entries before the larger global cache', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const userScoped = {
      ...buildChatSummary('chat-user'),
      title: 'User scoped chat',
    };
    const global = [
      ...Array.from({ length: 25 }, (_, index) => ({
        ...buildChatSummary(`chat-global-${index + 1}`),
        title: `Global chat ${index + 1}`,
      })),
      {
        ...buildChatSummary('chat-user'),
        title: 'Global stale title',
      },
    ];
    store.set(
      ChatContextCacheService.managedEntitiesRecentBootstrapKey('chat'),
      JSON.stringify(global),
    );
    store.set(
      ChatContextCacheService.managedEntitiesRecentBootstrapUserKey('chat', 'admin-1'),
      JSON.stringify([userScoped]),
    );

    await expect(service.getManagedEntitiesRecentBootstrap('chat', ' admin-1 ')).resolves.toEqual([
      expect.objectContaining({
        id: 'chat-user',
        title: 'User scoped chat',
        bootstrapUserIds: ['admin-1'],
      }),
      ...global.slice(0, 25),
    ]);
  });

  it('stores and clears user-scoped recent bootstrap rows by chat id', async () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('redis://127.0.0.1:6379'),
    };
    const service = new ChatContextCacheService(
      {} as never,
      config as never,
      maxBotLinkService as never,
    );

    await service.upsertManagedEntitiesRecentBootstrap(
      buildChatSummary('chat-new'),
      900,
      'admin-1',
    );

    await expect(service.getManagedEntitiesRecentBootstrap('chat', 'admin-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'chat-new',
        bootstrapUserIds: ['admin-1'],
      }),
    ]);

    await service.clearManagedEntitiesRecentBootstrapForChat('chat-new', 'chat');

    await expect(service.getManagedEntitiesRecentBootstrap('chat', 'admin-1')).resolves.toEqual([]);
  });

  it('merges concurrent standalone recent bootstrap upserts for the same user', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await Promise.all([
      service.upsertManagedEntitiesRecentBootstrap(buildChatSummary('chat-a'), 900, 'admin-1'),
      service.upsertManagedEntitiesRecentBootstrap(buildChatSummary('chat-b'), 900, 'admin-1'),
    ]);

    const recent = await service.getManagedEntitiesRecentBootstrap('chat', 'admin-1');
    expect(recent.map((item) => item.id).sort()).toEqual(['chat-a', 'chat-b']);
  });

  it('preserves a concurrent recent bootstrap upsert while removing another item', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    await service.upsertManagedEntitiesRecentBootstrap(
      buildChatSummary('chat-remove'),
      900,
      'admin-1',
    );
    await service.upsertManagedEntitiesRecentBootstrap(
      buildChatSummary('chat-keep'),
      900,
      'admin-1',
    );

    await Promise.all([
      service.clearManagedEntitiesRecentBootstrapForChat('chat-remove', 'chat'),
      service.upsertManagedEntitiesRecentBootstrap(buildChatSummary('chat-new'), 900, 'admin-1'),
    ]);

    const recent = await service.getManagedEntitiesRecentBootstrap('chat', 'admin-1');
    expect(recent.map((item) => item.id).sort()).toEqual(['chat-keep', 'chat-new']);
  });

  it('lets an equal-millisecond removal beat a grant and rejects its delayed replay', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const eventAt = new Date('2026-08-20T10:00:00.123Z');

    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-epoch',
        userId: 'user-1',
        state: 'granted',
        eventAt,
        publishedSummary: buildChatSummary('chat-epoch'),
      }),
    ).resolves.toBe(true);
    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-epoch',
        userId: 'user-1',
        state: 'user_denied',
        eventAt,
      }),
    ).resolves.toBe(true);
    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-epoch',
        userId: 'user-1',
        state: 'granted',
        eventAt,
        publishedSummary: buildChatSummary('chat-epoch'),
      }),
    ).resolves.toBe(false);

    expect(store.get(ChatContextCacheService.adminAccessKey('chat-epoch', 'user-1'))).toBe(
      'user_denied',
    );
    expect(
      store.has(ChatContextCacheService.managedEntitiesPublishedSnapshotKey('user-1', 'chat')),
    ).toBe(false);
  });

  it('fast-rejects a strictly superseded epoch before reading opaque values', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const redis = getRedisMutationMock(service);
    const eventAt = new Date('2026-08-20T10:00:00.000Z');
    const recordMetric = jest.fn();
    const epochKey = ChatContextCacheService.adminAccessEpochKey(
      'chat-precheck-superseded',
      'user-1',
    );
    store.set(epochKey, `${eventAt.getTime() + 1}:1`);

    await expect(
      service.applyAdminAccessEpochMutation(
        {
          chatId: 'chat-precheck-superseded',
          userId: 'user-1',
          state: 'user_denied',
          eventAt,
        },
        { precheckSupersededEpoch: true, recordMetric },
      ),
    ).resolves.toBe(false);

    expect(redis.get).toHaveBeenCalledWith(epochKey);
    expect(redis.mget).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(recordMetric).toHaveBeenCalledWith({
      phase: 'precheck',
      outcome: 'hit',
      durationMs: expect.any(Number),
    });
  });

  it.each([
    { currentPriority: 0, label: 'equal-time grant' },
    { currentPriority: 1, label: 'equal denial repair' },
  ])('does not fast-reject an $label', async ({ currentPriority }) => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const redis = getRedisMutationMock(service);
    const chatId = `chat-precheck-equal-${currentPriority}`;
    const userId = 'user-1';
    const eventAt = new Date('2026-08-20T10:00:00.123Z');
    store.set(
      ChatContextCacheService.adminAccessEpochKey(chatId, userId),
      `${eventAt.getTime()}:${currentPriority}`,
    );
    store.set(ChatContextCacheService.adminAccessKey(chatId, userId), 'granted');
    store.set(
      ChatContextCacheService.cacheKey(chatId),
      JSON.stringify({
        chatId,
        title: 'Equal epoch repair',
        settings: buildSettings(chatId),
        domainAllowlist: [],
        adminUserIds: [userId],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
    );

    await expect(
      service.applyAdminAccessEpochMutation(
        { chatId, userId, state: 'user_denied', eventAt },
        { precheckSupersededEpoch: true },
      ),
    ).resolves.toBe(true);

    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(store.get(ChatContextCacheService.adminAccessKey(chatId, userId))).toBe('user_denied');
    expect(JSON.parse(store.get(ChatContextCacheService.cacheKey(chatId)) ?? 'null')).toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
  });

  it('keeps exact denial replay key-write-free while invalidating local caches', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const redis = getRedisMutationMock(service);
    const chatId = 'chat-exact-epoch-replay';
    const userId = 'user-1';
    const eventAt = new Date('2026-09-02T08:00:00.123Z');
    const revisionKey = ChatContextCacheService.chatContextRevisionKey(chatId);
    const recordMetric = jest.fn();

    await expect(
      service.applyAdminAccessEpochMutation(
        { chatId, userId, state: 'user_denied', eventAt },
        { precheckSupersededEpoch: true },
      ),
    ).resolves.toBe(true);
    const committedRevision = store.get(revisionKey);
    const localCache = (
      service as unknown as {
        localChatContextCache: ChatContextLocalCache;
      }
    ).localChatContextCache;
    localCache.set(chatId, { chatId, adminUserIds: [userId] } as never);
    const remoteInvalidation = jest.fn();
    (
      Redis as unknown as {
        __subscribers: Set<(channel: string, payload: string) => void>;
      }
    ).__subscribers.add(remoteInvalidation);

    await expect(
      service.applyAdminAccessEpochMutation(
        { chatId, userId, state: 'user_denied', eventAt },
        { precheckSupersededEpoch: true, recordMetric },
      ),
    ).resolves.toBe(false);

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(store.get(revisionKey)).toBe(committedRevision);
    expect(localCache.snapshot().entries).toBe(0);
    expect(remoteInvalidation).toHaveBeenCalledWith(
      'chat:context:invalidate:v1',
      JSON.stringify({ chatId }),
    );
    expect(recordMetric.mock.calls.map(([metric]) => metric.outcome)).toEqual([
      'miss',
      'superseded',
    ]);
  });

  it('repairs an equal epoch when the committed access state is missing', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const chatId = 'chat-equal-epoch-missing-state';
    const userId = 'user-1';
    const eventAt = new Date('2026-09-02T08:01:00.123Z');
    store.set(
      ChatContextCacheService.adminAccessEpochKey(chatId, userId),
      `${eventAt.getTime()}:1`,
    );

    await expect(
      service.applyAdminAccessEpochMutation(
        { chatId, userId, state: 'user_denied', eventAt },
        { precheckSupersededEpoch: true },
      ),
    ).resolves.toBe(true);

    expect(store.get(ChatContextCacheService.adminAccessKey(chatId, userId))).toBe('user_denied');
  });

  it('repairs stale derivatives behind an exact denied epoch and state', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const sets = (Redis as unknown as { __sets: Map<string, Set<string>> }).__sets;
    const chatId = 'chat-exact-epoch-stale-derivatives';
    const userId = 'user-1';
    const eventAt = new Date('2026-09-02T08:02:00.123Z');
    store.set(
      ChatContextCacheService.adminAccessEpochKey(chatId, userId),
      `${eventAt.getTime()}:1`,
    );
    store.set(ChatContextCacheService.adminAccessKey(chatId, userId), 'user_denied');
    store.set(
      ChatContextCacheService.cacheKey(chatId),
      JSON.stringify({
        chatId,
        title: 'Stale derivative',
        settings: buildSettings(chatId),
        domainAllowlist: [],
        adminUserIds: [userId],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
    );
    const recentUsersKey = ChatContextCacheService.managedEntitiesRecentBootstrapChatUsersKey(
      chatId,
      'chat',
    );
    sets.set(recentUsersKey, new Set([userId]));

    await expect(
      service.applyAdminAccessEpochMutation(
        { chatId, userId, state: 'user_denied', eventAt },
        { precheckSupersededEpoch: true },
      ),
    ).resolves.toBe(true);

    expect(JSON.parse(store.get(ChatContextCacheService.cacheKey(chatId)) ?? 'null')).toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
    expect(sets.get(recentUsersKey)?.has(userId)).toBe(false);
    expect(store.get(ChatContextCacheService.chatContextRevisionKey(chatId))).toBe('1');
  });

  it.each([
    { label: 'missing', raw: null },
    { label: 'malformed', raw: 'not-an-epoch' },
  ])('falls through the precheck for a $label epoch', async ({ raw }) => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const redis = getRedisMutationMock(service);
    const chatId = `chat-precheck-${raw === null ? 'missing' : 'malformed'}`;
    const userId = 'user-1';
    const eventAt = new Date('2026-08-20T10:00:00.000Z');
    const recordMetric = jest.fn();
    const epochKey = ChatContextCacheService.adminAccessEpochKey(chatId, userId);
    if (raw !== null) {
      store.set(epochKey, raw);
    }

    await expect(
      service.applyAdminAccessEpochMutation(
        { chatId, userId, state: 'user_denied', eventAt },
        { precheckSupersededEpoch: true, recordMetric },
      ),
    ).resolves.toBe(true);

    expect(redis.get).toHaveBeenCalledWith(epochKey);
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(store.get(epochKey)).toBe(`${eventAt.getTime()}:1`);
    expect(recordMetric.mock.calls.map(([metric]) => metric.outcome)).toEqual(['miss', 'applied']);
  });

  it('falls through the precheck when its Redis GET fails', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const redis = getRedisMutationMock(service);
    const recordMetric = jest.fn();
    redis.get.mockRejectedValueOnce(new Error('epoch precheck unavailable'));

    await expect(
      service.applyAdminAccessEpochMutation(
        {
          chatId: 'chat-precheck-error',
          userId: 'user-1',
          state: 'user_denied',
          eventAt: new Date('2026-08-20T10:00:00.000Z'),
        },
        { precheckSupersededEpoch: true, recordMetric },
      ),
    ).resolves.toBe(true);

    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(recordMetric.mock.calls.map(([metric]) => metric.outcome)).toEqual([
      'fail_open',
      'applied',
    ]);
  });

  it('falls through the precheck when its Redis GET does not settle within the read budget', async () => {
    jest.useFakeTimers();
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const redis = getRedisMutationMock(service);
    const recordMetric = jest.fn();
    redis.get.mockReturnValueOnce(new Promise<string | null>(() => undefined));

    try {
      const mutation = service.applyAdminAccessEpochMutation(
        {
          chatId: 'chat-precheck-timeout',
          userId: 'user-1',
          state: 'user_denied',
          eventAt: new Date('2026-08-20T10:00:00.000Z'),
        },
        { precheckSupersededEpoch: true, recordMetric },
      );
      await Promise.resolve();
      expect(redis.mget).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(100);
      await expect(mutation).resolves.toBe(true);
      expect(redis.mget).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(recordMetric.mock.calls.map(([metric]) => metric.outcome)).toEqual([
        'fail_open',
        'applied',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains the Lua race fence when a newer epoch appears after the precheck', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const redis = getRedisMutationMock(service);
    const chatId = 'chat-precheck-race';
    const userId = 'user-1';
    const eventAt = new Date('2026-08-20T10:00:00.000Z');
    const epochKey = ChatContextCacheService.adminAccessEpochKey(chatId, userId);
    const accessKey = ChatContextCacheService.adminAccessKey(chatId, userId);
    const newerEpoch = `${eventAt.getTime() + 1}:0`;
    const recordMetric = jest.fn();
    redis.get.mockImplementationOnce(async () => {
      store.set(epochKey, newerEpoch);
      store.set(accessKey, 'granted');
      return null;
    });

    await expect(
      service.applyAdminAccessEpochMutation(
        { chatId, userId, state: 'user_denied', eventAt },
        { precheckSupersededEpoch: true, recordMetric },
      ),
    ).resolves.toBe(false);

    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(store.get(epochKey)).toBe(newerEpoch);
    expect(store.get(accessKey)).toBe('granted');
    expect(recordMetric.mock.calls.map(([metric]) => metric.outcome)).toEqual([
      'miss',
      'superseded',
    ]);
  });

  it('records Lua conflicts, retries, exhaustion, and failures without identifiers', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const redis = getRedisMutationMock(service);
    const retriedMetrics = jest.fn();
    redis.eval.mockResolvedValueOnce(-1).mockResolvedValueOnce(1);

    await expect(
      service.applyAdminAccessEpochMutation(
        {
          chatId: 'chat-lua-retry',
          userId: 'user-lua-retry',
          state: 'user_denied',
          eventAt: new Date('2026-08-20T10:00:00.000Z'),
        },
        { recordMetric: retriedMetrics },
      ),
    ).resolves.toBe(true);
    expect(retriedMetrics.mock.calls.map(([metric]) => metric.outcome)).toEqual([
      'conflict',
      'retry',
      'applied',
    ]);

    const exhaustedMetrics = jest.fn();
    redis.eval.mockResolvedValue(-1);
    await expect(
      service.applyAdminAccessEpochMutation(
        {
          chatId: 'chat-lua-exhausted',
          userId: 'user-lua-exhausted',
          state: 'user_denied',
          eventAt: new Date('2026-08-20T10:00:00.000Z'),
        },
        { recordMetric: exhaustedMetrics },
      ),
    ).rejects.toThrow('conflicted repeatedly');
    expect(
      exhaustedMetrics.mock.calls.filter(([metric]) => metric.outcome === 'conflict'),
    ).toHaveLength(16);
    expect(
      exhaustedMetrics.mock.calls.filter(([metric]) => metric.outcome === 'retry'),
    ).toHaveLength(15);
    expect(exhaustedMetrics).toHaveBeenLastCalledWith({ phase: 'lua', outcome: 'exhausted' });

    const failedMetrics = jest.fn();
    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(
      service.applyAdminAccessEpochMutation(
        {
          chatId: 'chat-lua-failed',
          userId: 'user-lua-failed',
          state: 'user_denied',
          eventAt: new Date('2026-08-20T10:00:00.000Z'),
        },
        { recordMetric: failedMetrics },
      ),
    ).rejects.toThrow('redis unavailable');
    expect(failedMetrics).toHaveBeenCalledWith({
      phase: 'lua',
      outcome: 'failed',
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(failedMetrics.mock.calls)).not.toMatch(/chat-lua|user-lua/u);
  });

  it('accepts a newer grant after an older removal epoch', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-newer-grant',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
    });
    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-newer-grant',
        userId: 'user-1',
        state: 'granted',
        eventAt: new Date('2026-08-20T10:00:00.001Z'),
      }),
    ).resolves.toBe(true);
    await expect(service.getAdminAccess('chat-newer-grant', 'user-1')).resolves.toBe('granted');
  });

  it('removes only the affected published card under a denial epoch', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const other = buildChatSummary('chat-other');
    await service.setManagedEntitiesPublishedSnapshot(
      'user-1',
      'chat',
      {
        version: 'before-denial',
        builtAt: '2026-08-20T09:00:00.000Z',
        lastSyncedAt: null,
        itemCount: 2,
        itemsHash: 'before-denial',
        items: [buildChatSummary('chat-remove'), other],
      },
      3600,
      { expectedVersion: null },
    );

    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-remove',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
    });

    await expect(service.getManagedEntitiesPublishedSnapshot('user-1', 'chat')).resolves.toEqual(
      expect.objectContaining({ items: [other], itemCount: 1 }),
    );
  });

  it('merges concurrent published grants for different chats of the same user', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await Promise.all([
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-a',
        userId: 'user-1',
        state: 'granted',
        eventAt: new Date('2026-08-20T10:00:00.000Z'),
        publishedSummary: buildChatSummary('chat-a'),
      }),
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-b',
        userId: 'user-1',
        state: 'granted',
        eventAt: new Date('2026-08-20T10:00:00.001Z'),
        publishedSummary: buildChatSummary('chat-b'),
      }),
    ]);

    const snapshot = await service.getManagedEntitiesPublishedSnapshot('user-1', 'chat');
    expect(snapshot?.items.map((item) => item.id).sort()).toEqual(['chat-a', 'chat-b']);
  });

  it('rejects a stale full snapshot rebuild after an item-level grant', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const baseSnapshot: ManagedEntitiesPublishedSnapshot = {
      version: 'full-rebuild-base',
      builtAt: '2026-08-20T09:00:00.000Z',
      lastSyncedAt: null,
      itemCount: 1,
      itemsHash: 'full-rebuild-base',
      items: [buildChatSummary('chat-base')],
    };
    await service.setManagedEntitiesPublishedSnapshot('user-1', 'chat', baseSnapshot, 3600, {
      expectedVersion: null,
    });
    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-concurrent-grant',
      userId: 'user-1',
      state: 'granted',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
      publishedSummary: buildChatSummary('chat-concurrent-grant'),
    });

    await expect(
      service.setManagedEntitiesPublishedSnapshot(
        'user-1',
        'chat',
        {
          ...baseSnapshot,
          version: 'stale-full-rebuild',
          builtAt: '2026-08-20T10:00:01.000Z',
        },
        3600,
        { expectedVersion: baseSnapshot.version },
      ),
    ).resolves.toBe(false);
    const stored = await service.getManagedEntitiesPublishedSnapshot('user-1', 'chat');
    expect(stored?.items.map((item) => item.id).sort()).toEqual([
      'chat-base',
      'chat-concurrent-grant',
    ]);
  });

  it('retains no read generations for idle invalidations delivered through pubsub', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    try {
      await service.onModuleInit();
      const subscriber = (
        service as unknown as { subscriber: { subscribe: jest.Mock; on: jest.Mock } }
      ).subscriber;
      const channel = subscriber.subscribe.mock.calls[0]?.[0] as string;
      const handler = subscriber.on.mock.calls.find(([event]) => event === 'message')?.[1] as (
        channel: string,
        payload: string,
      ) => void;
      for (let index = 0; index < 100_000; index++) {
        handler(channel, JSON.stringify({ chatId: `idle-chat-${index}` }));
      }

      expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);
      expect(getChatContextReadState(service).chatContextInFlightLoads.size).toBe(0);
      expect(service.getLocalCacheSnapshot().entries).toBe(0);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('releases read generations after successful loads, cache hits and rejected loads', async () => {
    const chatId = 'chat-generation-cleanup';
    const row = deferred<ReturnType<typeof buildContextRow>>();
    const started = deferred<void>();
    const prisma = {
      chat: {
        findUnique: jest.fn().mockImplementation(() => {
          started.resolve();
          return row.promise;
        }),
        upsert: jest.fn(),
      },
    };
    const service = new ChatContextCacheService(
      prisma as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const pending = service.getChatContext(chatId);
    await started.promise;
    expect(getChatContextReadState(service).chatContextReadGenerations.get(chatId)?.readers).toBe(
      1,
    );
    row.resolve(buildContextRow(chatId));
    await pending;
    expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);
    await service.getChatContext(chatId);
    expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);

    const failure = new Error('Context read unavailable');
    const failedRow = deferred<ReturnType<typeof buildContextRow>>();
    const failedStarted = deferred<void>();
    prisma.chat.findUnique.mockImplementationOnce(() => {
      failedStarted.resolve();
      return failedRow.promise;
    });
    const failures = Promise.allSettled([
      service.getChatContext('chat-generation-error'),
      service.getChatContext('chat-generation-error'),
    ]);
    await failedStarted.promise;
    expect(
      getChatContextReadState(service).chatContextReadGenerations.get('chat-generation-error')
        ?.readers,
    ).toBe(2);
    failedRow.reject(failure);
    await expect(failures).resolves.toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);
    expect(getChatContextReadState(service).chatContextInFlightLoads.size).toBe(0);
  });

  it('keeps a newer shared load alive when an invalidated coalesced load settles late', async () => {
    const chatId = 'chat-generation-coalescing';
    const oldRow = deferred<ReturnType<typeof buildContextRow>>();
    const newRow = deferred<ReturnType<typeof buildContextRow>>();
    const oldStarted = deferred<void>();
    const newStarted = deferred<void>();
    const prisma = {
      chat: {
        findUnique: jest
          .fn()
          .mockImplementationOnce(() => {
            oldStarted.resolve();
            return oldRow.promise;
          })
          .mockImplementationOnce(() => {
            newStarted.resolve();
            return newRow.promise;
          }),
        upsert: jest.fn(),
      },
    };
    const service = new ChatContextCacheService(
      prisma as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const first = service.getChatContext(chatId);
    const second = service.getChatContext(chatId);
    await oldStarted.promise;
    const retired = getChatContextReadState(service).chatContextReadGenerations.get(chatId);
    expect(retired?.readers).toBe(2);

    service.invalidateLocal(chatId);
    const third = service.getChatContext(chatId);
    await newStarted.promise;
    const current = getChatContextReadState(service).chatContextReadGenerations.get(chatId);
    const newLoad = getChatContextReadState(service).chatContextInFlightLoads.get(chatId);
    expect(retired?.invalidated).toBe(true);
    expect(current).not.toBe(retired);
    oldRow.resolve(buildContextRow(chatId));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(getChatContextReadState(service).chatContextReadGenerations.get(chatId)).toBe(current);
    expect(current?.readers).toBe(3);
    expect(getChatContextReadState(service).chatContextInFlightLoads.get(chatId)).toBe(newLoad);
    expect(getRedisMutationMock(service).eval).not.toHaveBeenCalled();
    newRow.resolve(buildContextRow(chatId, []));
    const contexts = await Promise.all([first, second, third]);
    expect(contexts.every((context) => context.adminUserIds.length === 0)).toBe(true);
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);
    expect(getChatContextReadState(service).chatContextInFlightLoads.size).toBe(0);
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    expect(JSON.parse(store.get(ChatContextCacheService.cacheKey(chatId)) ?? 'null')).toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
  });

  it('never revives a retired generation after newer reads finish and idle invalidations pass', async () => {
    const chatId = 'chat-generation-aba';
    const oldRow = deferred<ReturnType<typeof buildContextRow>>();
    const oldStarted = deferred<void>();
    const prisma = {
      chat: {
        findUnique: jest
          .fn()
          .mockImplementationOnce(() => {
            oldStarted.resolve();
            return oldRow.promise;
          })
          .mockResolvedValue(buildContextRow(chatId, [])),
        upsert: jest.fn(),
      },
    };
    const service = new ChatContextCacheService(
      prisma as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const pending = service.getChatContext(chatId);
    await oldStarted.promise;
    const retired = getChatContextReadState(service).chatContextReadGenerations.get(chatId);
    service.invalidateLocal(chatId);
    await expect(service.getChatContext(chatId)).resolves.toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
    for (let index = 0; index < 10_000; index++) {
      service.invalidateLocal(`unread-chat-${index}`);
    }
    service.invalidateLocal(chatId);
    await service.getChatContext(chatId);
    expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);
    expect(retired?.invalidated).toBe(true);

    oldRow.resolve(buildContextRow(chatId));
    await expect(pending).resolves.toEqual(expect.objectContaining({ adminUserIds: [] }));
    expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    expect(JSON.parse(store.get(ChatContextCacheService.cacheKey(chatId)) ?? 'null')).toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
  });

  it('rechecks the generation after a committed Redis write is invalidated before resuming', async () => {
    const chatId = 'chat-generation-after-write';
    const prisma = {
      chat: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(buildContextRow(chatId))
          .mockResolvedValue(buildContextRow(chatId, [])),
        upsert: jest.fn(),
      },
    };
    const service = new ChatContextCacheService(
      prisma as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const redis = getRedisMutationMock(service);
    const evaluate = redis.eval.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    redis.eval.mockImplementationOnce(async (...args: unknown[]) => {
      const committed = await evaluate(...args);
      await service.invalidate(chatId);
      return committed;
    });

    await expect(service.getChatContext(chatId)).resolves.toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    expect(store.get(ChatContextCacheService.chatContextRevisionKey(chatId))).toBe('1');
    expect(JSON.parse(store.get(ChatContextCacheService.cacheKey(chatId)) ?? 'null')).toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
  });

  it('discards a delayed Redis cache reply from a generation invalidated during the read', async () => {
    const chatId = 'chat-generation-redis-read';
    const prisma = {
      chat: { findUnique: jest.fn().mockResolvedValue(buildContextRow(chatId, [])) },
    };
    const service = new ChatContextCacheService(
      prisma as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const context = {
      chatId,
      title: 'Chat title',
      settings: buildSettings(chatId),
      domainAllowlist: [],
      adminUserIds: [] as string[],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    };
    const reply = deferred<Array<string | null>>();
    const started = deferred<void>();
    const redis = getRedisMutationMock(service);
    redis.mget.mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    });
    const pending = service.getChatContext(chatId);
    await started.promise;
    service.invalidateLocal(chatId);
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    store.set(ChatContextCacheService.cacheKey(chatId), JSON.stringify(context));
    await service.getChatContext(chatId);
    reply.resolve([JSON.stringify({ ...context, adminUserIds: ['user-1'] }), '0', null]);

    const cachedContext = JSON.parse(JSON.stringify(context));
    await expect(pending).resolves.toEqual(cachedContext);
    await expect(service.getChatContext(chatId)).resolves.toEqual(cachedContext);
    expect(redis.eval).not.toHaveBeenCalled();
    expect(getChatContextReadState(service).chatContextReadGenerations.size).toBe(0);
  });

  it('rejects a stale full-context load after an access mutation bumps the revision', async () => {
    let resolveOldRow!: (value: unknown) => void;
    const oldRow = new Promise((resolve) => {
      resolveOldRow = resolve;
    });
    const settings = buildSettings('chat-load-race');
    const staleRow = {
      id: 'chat-load-race',
      title: 'Race chat',
      settings,
      domains: [],
      admins: [{ userId: 'user-1' }],
      rules: null,
      primaryBotId: '777000_bot',
      botId: '777000_bot',
    };
    const freshRow = { ...staleRow, admins: [] };
    const prisma = {
      chat: {
        findUnique: jest.fn().mockReturnValueOnce(oldRow).mockResolvedValue(freshRow),
        upsert: jest.fn(),
      },
    };
    const config = createConfigMock();
    config.get.mockImplementation((key) =>
      key === 'CHAT_CONTEXT_LOCAL_CACHE_MAX_ENTRIES' ? 1 : undefined,
    );
    const service = new ChatContextCacheService(
      prisma as never,
      config as never,
      maxBotLinkService as never,
    );

    const pending = service.getChatContext('chat-load-race');
    await Promise.resolve();
    await Promise.resolve();
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    for (const chatId of ['eviction-a', 'eviction-b']) {
      store.set(
        ChatContextCacheService.cacheKey(chatId),
        JSON.stringify({ chatId, title: chatId }),
      );
      await service.getChatContext(chatId);
    }
    expect(service.getLocalCacheSnapshot().capacityEvictions).toBe(1);
    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-load-race',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
    });
    resolveOldRow(staleRow);

    await expect(pending).resolves.toEqual(expect.objectContaining({ adminUserIds: [] }));
    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
  });

  it('retries a denial when a stale context appears after the initial CAS read', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const contextKey = ChatContextCacheService.cacheKey('chat-missing-context-race');
    const staleContext = {
      chatId: 'chat-missing-context-race',
      title: 'Race chat',
      settings: buildSettings('chat-missing-context-race'),
      domainAllowlist: [],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    };
    const redis = (
      service as unknown as {
        redis: { eval: jest.Mock<Promise<unknown>, unknown[]> };
      }
    ).redis;
    const evaluate = redis.eval.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    redis.eval.mockImplementationOnce((...args: unknown[]) => {
      store.set(contextKey, JSON.stringify(staleContext));
      return evaluate(...args);
    });

    await expect(
      service.applyAdminAccessEpochMutation({
        chatId: 'chat-missing-context-race',
        userId: 'user-1',
        state: 'user_denied',
        eventAt: new Date('2026-08-20T10:00:00.000Z'),
      }),
    ).resolves.toBe(true);

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.get(contextKey) ?? 'null')).toEqual(
      expect.objectContaining({ adminUserIds: [] }),
    );
  });

  it('does not let a delayed title patch restore an admin removed from cached context', async () => {
    const service = new ChatContextCacheService(
      {} as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );
    const store = (Redis as unknown as { __store: Map<string, string> }).__store;
    const staleContext = {
      chatId: 'chat-title-race',
      title: 'Old title',
      settings: buildSettings('chat-title-race'),
      domainAllowlist: [],
      adminUserIds: ['user-1'],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    };
    store.set(ChatContextCacheService.cacheKey('chat-title-race'), JSON.stringify(staleContext));
    await service.applyAdminAccessEpochMutation({
      chatId: 'chat-title-race',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: new Date('2026-08-20T10:00:00.000Z'),
    });

    const internals = service as unknown as {
      acquireChatContextReadGeneration: (chatId: string) => {
        invalidated: boolean;
        readers: number;
      };
      releaseChatContextReadGeneration: (
        chatId: string,
        generation: { invalidated: boolean; readers: number },
      ) => void;
      reconcileCachedChatTitle: (
        chatId: string,
        value: typeof staleContext,
        title: string,
        generation: { invalidated: boolean; readers: number },
      ) => unknown;
    };
    const generation = internals.acquireChatContextReadGeneration('chat-title-race');
    try {
      internals.reconcileCachedChatTitle('chat-title-race', staleContext, 'New title', generation);
    } finally {
      internals.releaseChatContextReadGeneration('chat-title-race', generation);
    }
    await Promise.resolve();
    await Promise.resolve();

    const stored = JSON.parse(
      store.get(ChatContextCacheService.cacheKey('chat-title-race')) ?? 'null',
    ) as { title: string; adminUserIds: string[] };
    expect(stored).toEqual(expect.objectContaining({ title: 'New title', adminUserIds: [] }));
  });
});
