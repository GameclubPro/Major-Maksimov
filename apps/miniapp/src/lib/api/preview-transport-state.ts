import {
  channelSettingsSchema,
  chatRulesSchema,
  chatSettingsSchema,
  domainAllowlistEntrySchema,
  managedAutopostPayloadSchema,
  managedBroadcastDetailsSchema,
  managedGiveawayDetailsSchema,
  type ChatParticipantItem,
  type ChannelDialogMessage,
  type ChannelDialogNotificationMode,
  type ChannelDialogNotificationScope,
  type ChannelDialogType,
  type ChannelPostSignatureSettings,
  type ChannelSettings,
  type ChatRules,
  type ChatSettings,
  type ChatSummary,
  type DomainAllowlistEntry,
  type GlobalSpammerReviewCandidate,
  type LogsDashboardResponse,
  type ManagedBroadcastDetails,
  type ManagedAutopostHubRuleDetails,
  type ManagedEntityAccessDiagnostics,
  type ManagedEntityFavoriteLabelOverrides,
  type ManagedGiveawayDetails,
  type Me,
  type MembershipActivityItem,
  type VkParsingFeed,
} from '@maxim/contracts';
import type { KaravanStorefrontAllowlistEntry } from '@maxim/contracts/karavan-storefront';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import {
  managedPollDetailsSchema,
  type ManagedPollDetails,
  type ManagedPollVoter,
} from '@maxim/contracts/poll';
import { type PublicationDelivery, type PublicationDetails } from '@maxim/contracts/publication';
import {
  publisherPostImportSessionSchema,
  type PublisherPostImportSession,
  type PublisherPostImportStatus,
} from '@maxim/contracts/publisher';
import {
  PREVIEW_CHANNEL_ID,
  PREVIEW_CHANNEL_TITLE,
  PREVIEW_CHAT_ID,
  PREVIEW_CHAT_TITLE,
} from '../design-preview';
import { buildPreviewAutopostRule } from './preview-transport-autoposts';
import { buildPreviewDialogMessage } from './preview-transport-dialog';
import {
  createActivityItems,
  createChatViolations,
  createParticipantsItems,
} from './preview-transport-events';
import { createPreviewSpammerReviewCandidates } from './preview-transport-events-fixtures';
import {
  readPreviewClock,
  systemPreviewClock,
  type PreviewApiTransportOptions,
  type PreviewClock,
} from './preview-transport-runtime';
import {
  buildPreviewPublicationDetails,
  createPreviewPublications,
} from './preview-transport-publications';
import {
  addDays,
  addHours,
  buildPreviewAvatarDataUrl,
  buildPreviewProfileHandoffUrl,
  buildPreviewProfileUrl,
} from './preview-transport-shared';
import {
  PREVIEW_PRIMARY_BOT_ID,
  buildPreviewAccessDiagnostics,
  createPreviewChatSummary,
  readPreviewRouteSearch,
} from './preview-transport-system';
import { createPreviewVkParsingFeed } from './preview-transport-vk';

export type PreviewState = {
  networksScenario: string;
  retentionScenario: string;
  stopWordsWriteError: 'network' | 'conflict' | 'review' | null;
  stopWordsStorageStatus: 'valid' | 'legacy' | 'invalid';
  advertisingPilot: boolean;
  marketplacePilot: boolean;
  marketplaceOwner: boolean;
  marketplacePublished: boolean;
  marketplaceReadiness: 'ready' | 'delayed' | 'unavailable';
  clock: PreviewClock;
  me: Me;
  systemModeSelection: 'auto' | 'normal' | 'degrade';
  favoriteLabelsInitialized: boolean;
  favoriteLabels: ManagedEntityFavoriteLabelOverrides;
  favoriteLabelsRevision: number | null;
  chats: ChatSummary[];
  channels: ChatSummary[];
  chatDialogs: Record<ChannelDialogType, PreviewDialogBucket>;
  channelDialogs: Record<ChannelDialogType, PreviewDialogBucket>;
  chatDialogThreads: PreviewDialogThreadBuckets;
  channelDialogThreads: PreviewDialogThreadBuckets;
  chatHeaderParticipantsCount: number;
  chatSettings: ChatSettings;
  reportsAvailable: boolean;
  reportsScenario?: string;
  chatRules: ChatRules;
  rulesPublicationSequence?: number;
  chatDomains: DomainAllowlistEntry[];
  chatKaravanStorefrontAllowlist: KaravanStorefrontAllowlistEntry[];
  chatBroadcasts: ManagedBroadcastDetails[];
  chatPolls: ManagedPollDetails[];
  chatPollVoters: ManagedPollVoter[];
  channelBroadcasts: ManagedBroadcastDetails[];
  autopostRules: ManagedAutopostHubRuleDetails[];
  publications: PublicationDetails[];
  publicationDeliveries: PublicationDelivery[];
  chatGiveaways: ManagedGiveawayDetails[];
  chatParticipants: ChatParticipantItem[];
  chatActivity: MembershipActivityItem[];
  chatViolations: LogsDashboardResponse['violations'];
  spammerReviewCandidates: GlobalSpammerReviewCandidate[];
  channelHeaderParticipantsCount: number;
  channelSettings: ChannelSettings;
  channelPostSignature: ChannelPostSignatureSettings;
  channelPolls: ManagedPollDetails[];
  channelPollVoters: ManagedPollVoter[];
  channelGiveaways: ManagedGiveawayDetails[];
  channelActivity: MembershipActivityItem[];
  chatVkParsing: VkParsingFeed;
  channelVkParsing: VkParsingFeed;
  chatPrimaryBotId: string | null;
  channelPrimaryBotId: string | null;
  chatPartnerAssistEnabled: boolean;
  channelPartnerAssistEnabled: boolean;
  accessDiagnostics: ManagedEntityAccessDiagnostics | null;
  settingsScreenError: 'auth-expired' | 'access-denied' | null;
  moderationActionDelayMs: 0 | 800;
  publisherEntitiesVariant: 'mixed' | 'channel-only' | 'large' | 'empty' | 'error';
  publisherPolicyVariant: 'normal' | 'setup' | 'permission' | 'error' | 'stale';
  publicationVideoUploadVariant: 'ready' | 'failed';
  publisherPostImportVariant: 'none' | PublisherPostImportStatus;
  publisherPostImportSession: PublisherPostImportSession | null;
};

export type PreviewDialogBucket = {
  introText: string | null;
  messages: ChannelDialogMessage[];
  notificationMode?: ChannelDialogNotificationMode;
  notificationScope?: ChannelDialogNotificationScope;
  threadNotificationMode?: ChannelDialogNotificationMode;
  threadNotificationExplicit?: boolean;
  channelNotificationMode?: ChannelDialogNotificationMode;
  channelNotificationExplicit?: boolean;
  allChannelsNotificationMode?: ChannelDialogNotificationMode;
  allChannelsNotificationExplicit?: boolean;
};

export type PreviewDialogThreadBuckets = Partial<
  Record<ChannelDialogType, Record<string, PreviewDialogBucket>>
>;

export function createInitialState(search: string, clock: PreviewClock): PreviewState {
  const now = readPreviewClock(clock);
  const searchParams = new URLSearchParams(search);
  const publisherProfile = searchParams.get('profile') === 'publisher';
  const publisherState = searchParams.get('publisherState');
  const publisherPolicyState = searchParams.get('publisherPolicyState');
  const publisherPostImportState = searchParams.get('publisherImport');
  const channelPostSignatureState = searchParams.get('channelPostSignature');
  const publisherPostImportVariant: PreviewState['publisherPostImportVariant'] =
    publisherPostImportState === 'waiting' ||
    publisherPostImportState === 'processing' ||
    publisherPostImportState === 'ready' ||
    publisherPostImportState === 'failed' ||
    publisherPostImportState === 'canceled' ||
    publisherPostImportState === 'expired'
      ? publisherPostImportState
      : 'none';
  const chatSettings = chatSettingsSchema.parse({
    settingsRevision: new Date(now).toISOString(),
    reportsEnabled: searchParams.get('reportsOptIn') === '1',
    greetingEnabled: false,
    greetingBotMessageEnabled: false,
    greetingDeleteBotMessageEnabled: false,
    greetingDeleteBotMessageDelayMinutes: 2,
    greetingBotMessageText: 'Добро пожаловать в чат. Ознакомьтесь с правилами и пишите по делу.',
    greetingRulesButtonEnabled: false,
    linkPolicy: 'ALLOWLIST_ONLY',
    antiSpamEnabled: true,
    deleteSpammersEnabled: true,
    russianProfanityFilterEnabled: true,
    profanitySensitivity: 'BALANCED',
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED',
    profanityWarnEnabled: true,
    textFiltersWarnEnabled: true,
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicatePhotoEnabled: false,
    nightModeEnabled: true,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: 'Ночью чат закрыт. Напишите утром.',
    messageLimitsBlockedWords: ['казино', 'ставки', 'скидка'],
    messageLimitsBlockedDomains: ['casino.example', 'promo.example'],
    stopWordsRevision: 1,
    stopWordsPolicy: stopWordsPolicySchema.parse({
      enabled: true,
      rules: ['казино', 'ставки', 'скидка'].map((value, index) => ({
        id: 'preview-' + index,
        kind: 'WORD',
        value,
      })),
      domains: ['casino.example', 'promo.example'],
      ...(searchParams.get('stopWordsSize') === 'max'
        ? {
            rules: Array.from({ length: 999 }, (_, index) => ({
              id: 'max-' + index,
              kind: 'WORD',
              value: index === 0 ? 'Д'.repeat(160) : 'маркер' + index,
            })),
            domains: Array.from({ length: 300 }, (_, index) => 'site' + index + '.example'),
          }
        : {}),
    }),
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: [PREVIEW_CHANNEL_ID, 'preview-channel-2'],
    requiredSubscriptionBotMessageEnabled: true,
    requiredSubscriptionBotMessageText:
      'Для сообщений в этом чате нужна подписка на {channels}. Подпишитесь и отправьте сообщение ещё раз. Статус: {message_status}.',
    requiredSubscriptionWarnEnabled: true,
    requiredSubscriptionBanEnabled: true,
    requiredSubscriptionMuteEnabled: true,
    duplicateMuteDurationHours: 24,
    linkMuteDurationHours: 24,
    messageLimitsMuteDurationHours: 12,
    profanityMuteDurationHours: 6,
    requiredSubscriptionMuteDurationHours: 24,
    textFiltersMuteDurationHours: 24,
    commentsEnabled: true,
    commentsAdminsEnabled: true,
    commentsAllEnabled: false,
    commentsChatBroadcastsEnabled: true,
    muteDurationHours: 12,
    warnThreshold: 2,
  });
  const chatRules = chatRulesSchema.parse({
    text: '1. Без рекламы.\n2. Без токсичности.\n3. Без повторов.\n4. Уважайте соседей.',
    autoTextEnabled: true,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    publishedMessageId: 'rules-preview-1',
    publishedUrl: 'https://max.ru/community/rules-preview',
    publishedAt: addHours(now, -26).toISOString(),
  });
  const chatDomains = [
    domainAllowlistEntrySchema.parse({
      domain: 'https://maxim.play-team.ru',
      target: 'https://maxim.play-team.ru',
      normalizedValue: 'https://maxim.play-team.ru',
      matchType: 'EXACT',
      kind: 'WEB_EXACT',
      removeAfterAt: null,
    }),
    domainAllowlistEntrySchema.parse({
      domain: 'docs.max.ru',
      target: 'docs.max.ru',
      normalizedValue: 'domain:docs.max.ru',
      matchType: 'DOMAIN',
      kind: 'WEB_DOMAIN',
      removeAfterAt: addDays(now, 2).toISOString(),
    }),
  ];
  const chatKaravanStorefrontAllowlist: KaravanStorefrontAllowlistEntry[] = [
    {
      id: 'karavan-entry-preview-1',
      chatId: PREVIEW_CHAT_ID,
      userId: 'preview-storefront-user-1',
      displayName: 'Марина Волкова',
      expiresAt: addDays(now, 30).toISOString(),
      createdByUserId: 'preview-admin',
      sourceMessageId: 'preview-forwarded-message-1',
      createdAt: addDays(now, -2).toISOString(),
      updatedAt: addDays(now, -2).toISOString(),
    },
  ];
  const chatBroadcasts = [
    managedBroadcastDetailsSchema.parse({
      id: 'broadcast-preview-1',
      status: 'ACTIVE',
      text: 'Напоминаем: в субботу уборка двора в 11:00. Приходите с перчатками.',
      textFormat: 'plain',
      targetMode: 'current',
      applyToAllChats: false,
      targetChatIds: [PREVIEW_CHAT_ID],
      buttons: [
        {
          text: 'Подробности',
          url: 'https://maxim.play-team.ru/help',
        },
      ],
      buttonEnabled: true,
      buttonUrl: 'https://maxim.play-team.ru/help',
      buttonText: 'Подробности',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        addHours(now, 18).toISOString(),
        addDays(now, 1).toISOString(),
        addDays(now, 2).toISOString(),
      ],
      nextSendAt: addHours(now, 18).toISOString(),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 3,
      sentCount: 1,
      currentOccurrence: 2,
      deliveredChats: 1,
      failedChats: 0,
      pendingChats: 0,
      blockedChats: 0,
      failureBreakdown: {
        transient: 0,
        permanentTarget: 0,
        quarantined: 0,
        unknown: 0,
      },
      canRetry: false,
      remainingCount: 2,
      createdAt: addHours(now, -36).toISOString(),
      updatedAt: addHours(now, -3).toISOString(),
      lastError: null,
    }),
  ];
  chatBroadcasts.push(
    managedBroadcastDetailsSchema.parse({
      ...chatBroadcasts[0],
      id: 'broadcast-preview-completed',
      status: 'COMPLETED',
      text: 'Итоги весеннего субботника: двор убран, инвентарь возвращён в управляющую компанию.',
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      scheduledSlots: [addDays(now, -8).toISOString()],
      nextSendAt: null,
      cycleCount: 1,
      sentCount: 1,
      currentOccurrence: 1,
      deliveredChats: 1,
      remainingCount: 0,
      createdAt: addDays(now, -10).toISOString(),
      updatedAt: addDays(now, -8).toISOString(),
    }),
  );
  const chatGiveaways = [
    managedGiveawayDetailsSchema.parse({
      draftRevision: 1,
      id: 'giveaway-chat-1',
      title: 'Субботний розыгрыш двора',
      status: 'DRAFT',
      hasImage: false,
      entriesCount: 0,
      verifiedEntriesCount: 0,
      pendingEntriesCount: 0,
      winnersCount: 10,
      startsAt: null,
      endsAt: addHours(now, 30).toISOString(),
      publishedAt: null,
      completedAt: null,
      publicationUrl: null,
      resultsUrl: null,
      createdAt: addDays(now, -4).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      sourceChatId: PREVIEW_CHAT_ID,
      entityType: 'chat',
      description:
        'Полностью пользовательский текст публикации из чат-бота. Без шаблонных дописок.',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      claimHours: 48,
      requiredChannelIds: [PREVIEW_CHANNEL_ID],
      publicationMessageId: null,
      resultsMessageId: null,
      prizes: Array.from({ length: 10 }, (_, index) => ({
        id: `prize-chat-${index + 1}`,
        position: index + 1,
        title: `Прикормка ${index + 1}`,
        displayTitle: 'Прикормка',
      })),
      winners: [],
    }),
  ];
  const channelSettings = channelSettingsSchema.parse({
    revision: 0,
    commentsEnabled: true,
    commentsModerationEnabled: true,
    commentsBlockLinksEnabled: true,
    commentsAntiSpamEnabled: true,
    commentsLimitTwoInRowEnabled: true,
    postSuggestionsEnabled: true,
    postSuggestionsText: 'Пришлите идею поста или важную новость для соседей.',
    postSuggestionsDailyLimit: 4,
    postSuggestionsEntryMode: 'MINIAPP',
    postSuggestionsButtonEnabled: true,
    postSuggestionsButtonText: 'Предложить пост',
    postSuggestionsButtonUrl: 'https://maxim.play-team.ru/suggest',
    engagementMessageText: 'Есть идея или обратная связь? Выберите действие ниже.',
  });
  const channelPostSignature: ChannelPostSignatureSettings = {
    customButtonsEnabled: false,
    customButtons: [],
    revision: 0,
    enabled: channelPostSignatureState === 'button',
    presentation: channelPostSignatureState === 'button' ? 'button' : 'signature',
    text: channelPostSignatureState === 'button' ? '📞 Заказать рекламу' : 'Подписаться на канал',
    url: channelPostSignatureState === 'button' ? 'https://example.test/advertising' : '',
  };
  const channelPolls = [
    managedPollDetailsSchema.parse({
      id: 'poll-channel-active',
      channelId: PREVIEW_CHANNEL_ID,
      question: '**Какой формат встреч** добавить в августе?',
      questionFormat: 'markdown',
      images: [],
      imageCount: 0,
      status: 'ACTIVE',
      visibility: 'OPEN',
      totalVotes: 24,
      options: [
        { id: 'poll-active-option-1', position: 0, text: 'Лекции', votes: 10, percent: 42 },
        { id: 'poll-active-option-2', position: 1, text: 'Практикумы', votes: 8, percent: 33 },
        { id: 'poll-active-option-3', position: 2, text: 'Экскурсии', votes: 6, percent: 25 },
      ],
      publicationPending: false,
      publicationNeedsReview: false,
      renderRepairNeeded: false,
      publicationUrl: 'https://max.ru/channels/yuzhnoe-news',
      publicationMessageId: 'poll-preview-message-active',
      publishedAt: addHours(now, -8).toISOString(),
      closedAt: null,
      createdAt: addHours(now, -10).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      lastError: null,
      lastRenderError: null,
    }),
    managedPollDetailsSchema.parse({
      id: 'poll-channel-closed',
      channelId: PREVIEW_CHANNEL_ID,
      question: 'Какая тема для подборки полезнее?',
      questionFormat: 'plain',
      images: [],
      imageCount: 0,
      status: 'CLOSED',
      visibility: 'ANONYMOUS',
      totalVotes: 61,
      options: [
        { id: 'poll-closed-option-1', position: 0, text: 'События района', votes: 31, percent: 51 },
        {
          id: 'poll-closed-option-2',
          position: 1,
          text: 'Городские сервисы',
          votes: 18,
          percent: 29,
        },
        {
          id: 'poll-closed-option-3',
          position: 2,
          text: 'Истории соседей',
          votes: 12,
          percent: 20,
        },
      ],
      publicationPending: false,
      publicationNeedsReview: false,
      renderRepairNeeded: true,
      publicationUrl: 'https://max.ru/channels/yuzhnoe-news',
      publicationMessageId: 'poll-preview-message-closed',
      publishedAt: addDays(now, -7).toISOString(),
      closedAt: addDays(now, -5).toISOString(),
      createdAt: addDays(now, -8).toISOString(),
      updatedAt: addDays(now, -5).toISOString(),
      lastError: null,
      lastRenderError: 'Preview render repair required',
    }),
  ];
  const channelPollVoters = [
    ['poll-voter-1', 'poll-active-option-1', 'Анна Петрова', 'anna_pet'],
    ['poll-voter-2', 'poll-active-option-1', 'Максим Орлов', 'max_orlov'],
    ['poll-voter-3', 'poll-active-option-2', 'Елена', 'elena_city'],
    ['poll-voter-4', 'poll-active-option-2', 'Илья Соколов', 'ilya_s'],
    ['poll-voter-5', 'poll-active-option-3', 'Марина Волкова', 'marina_v'],
  ].map(([id, optionId, displayName, username], index) => ({
    id: id ?? `poll-voter-${index + 1}`,
    pollId: 'poll-channel-active',
    optionId: optionId ?? 'poll-active-option-1',
    userId: `preview-poll-user-${index + 1}`,
    displayName: displayName ?? null,
    username: username ?? null,
    votedAt: addHours(now, -(index + 1)).toISOString(),
    updatedAt: addHours(now, -(index + 1)).toISOString(),
  })) satisfies ManagedPollVoter[];
  const chatPolls = channelPolls.map((poll) =>
    managedPollDetailsSchema.parse({
      ...poll,
      id: poll.id.replace('poll-channel-', 'poll-chat-'),
      channelId: PREVIEW_CHAT_ID,
      publicationUrl: poll.publicationUrl ? 'https://max.ru/chats/preview-chat' : null,
    }),
  );
  const chatPollVoters = channelPollVoters.map((voter) => ({
    ...voter,
    id: voter.id.replace('poll-voter-', 'chat-poll-voter-'),
    pollId: voter.pollId.replace('poll-channel-', 'poll-chat-'),
  }));
  const channelGiveaways = [
    managedGiveawayDetailsSchema.parse({
      draftRevision: 1,
      id: 'giveaway-channel-1',
      title: 'Розыгрыш мерча',
      status: 'SCHEDULED',
      hasImage: false,
      entriesCount: 0,
      verifiedEntriesCount: 0,
      pendingEntriesCount: 0,
      winnersCount: 1,
      startsAt: addHours(now, 12).toISOString(),
      endsAt: addDays(now, 4).toISOString(),
      publishedAt: null,
      completedAt: null,
      publicationUrl: null,
      resultsUrl: null,
      createdAt: addDays(now, -2).toISOString(),
      updatedAt: addHours(now, -4).toISOString(),
      sourceChatId: PREVIEW_CHANNEL_ID,
      entityType: 'channel',
      description: 'Тестовый розыгрыш среди подписчиков канала.',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      claimHours: 24,
      requiredChannelIds: [PREVIEW_CHANNEL_ID],
      publicationMessageId: null,
      resultsMessageId: null,
      prizes: [
        {
          id: 'prize-channel-1',
          position: 1,
          title: 'Фирменная кружка',
          displayTitle: 'Фирменная кружка',
        },
      ],
      winners: [],
    }),
  ];
  const channelBroadcasts = [
    managedBroadcastDetailsSchema.parse({
      id: 'broadcast-channel-1',
      status: 'ACTIVE',
      text: 'Сегодня публикуем подборку событий района. Проверьте расписание и переходите в канал.',
      textFormat: 'markdown',
      targetMode: 'current',
      applyToAllChats: false,
      targetChatIds: [PREVIEW_CHANNEL_ID],
      buttons: [
        {
          text: 'Открыть канал',
          url: 'https://max.ru/channels/yuzhnoe-news',
        },
      ],
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/channels/yuzhnoe-news',
      buttonText: 'Открыть канал',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        addHours(now, 10).toISOString(),
        addHours(now, 14).toISOString(),
        addHours(now, 19).toISOString(),
        addDays(now, 1).toISOString(),
      ],
      nextSendAt: addHours(now, 10).toISOString(),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 4,
      sentCount: 0,
      currentOccurrence: 1,
      deliveredChats: 0,
      failedChats: 0,
      pendingChats: 1,
      blockedChats: 0,
      failureBreakdown: {
        transient: 0,
        permanentTarget: 0,
        quarantined: 0,
        unknown: 0,
      },
      canRetry: false,
      remainingCount: 4,
      createdAt: addHours(now, -20).toISOString(),
      updatedAt: addHours(now, -1).toISOString(),
      lastError: null,
    }),
  ];
  const chatVkParsing = createPreviewVkParsingFeed(PREVIEW_CHAT_ID, now);
  const channelVkParsing = createPreviewVkParsingFeed(PREVIEW_CHANNEL_ID, now);
  const chatDialogs: Record<ChannelDialogType, PreviewDialogBucket> = {
    comments: {
      introText: '',
      messages: [
        buildPreviewDialogMessage({
          id: 'chat-comments-1',
          type: 'comments',
          text: 'Сделал компактную парковку для самокатов у 3-го подъезда. Проверьте, не мешает ли проходу.',
          authorUserId: 'preview-admin-2',
          authorDisplayName: 'Александр',
          avatarUrl: buildPreviewAvatarDataUrl('Александр', '#4d94ff', '#2b64dd'),
          createdAt: addHours(now, -5.2).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-2',
          type: 'comments',
          text: 'Смотрится аккуратно. Если добавить отражатель со стороны дорожки, вечером будет безопаснее.',
          authorUserId: 'preview-user-8',
          authorDisplayName: 'Марина Орлова',
          avatarUrl: buildPreviewAvatarDataUrl('Марина Орлова', '#3cc58b', '#0f9f70'),
          createdAt: addHours(now, -4.8).toISOString(),
          reactionGroups: [
            { emoji: '👍', count: 3, reactedByMe: false },
            { emoji: '🔥', count: 1, reactedByMe: false },
          ],
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-3',
          type: 'comments',
          text: 'Поддерживаю. Утром с коляской стало свободнее, раньше самокаты лежали прямо у перил.',
          authorUserId: 'preview-user-4',
          authorDisplayName: 'Наталья',
          avatarUrl: buildPreviewAvatarDataUrl('Наталья', '#6aa8ff', '#3b7ef0'),
          createdAt: addHours(now, -4.5).toISOString(),
          reactionGroups: [{ emoji: '👀', count: 2, reactedByMe: true }],
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-attachment-1',
          type: 'comments',
          text: '',
          authorUserId: 'preview-user-7',
          authorDisplayName: 'Ольга',
          avatarUrl: buildPreviewAvatarDataUrl('Ольга', '#f1a44b', '#ea7b4b'),
          createdAt: addHours(now, -4.2).toISOString(),
          attachments: [
            {
              kind: 'file',
              url: 'https://example.test/protokol-sobraniya.pdf',
              previewUrl: 'https://example.test/protokol-sobraniya.pdf',
              fileName: 'protokol-sobraniya.pdf',
              mimeType: 'application/pdf',
              size: 184_000,
            },
          ],
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-4',
          type: 'comments',
          text: 'Добавлю светоотражающую ленту и перенесу стойку на полметра ближе к клумбе.',
          authorUserId: 'preview-admin-2',
          authorDisplayName: 'Александр',
          avatarUrl: buildPreviewAvatarDataUrl('Александр', '#4d94ff', '#2b64dd'),
          createdAt: addHours(now, -4.1).toISOString(),
          replyToMessageId: 'chat-comments-2',
          replyTo: {
            messageId: 'chat-comments-2',
            authorDisplayName: 'Марина Орлова',
            text: 'Смотрится аккуратно. Если добавить отражатель со стороны дорожки, вечером будет безопаснее.',
          },
        }),
        buildPreviewDialogMessage({
          id: 'chat-comments-5',
          type: 'comments',
          text: 'Отлично. Тогда оставим тестом на неделю и посмотрим, как поведёт себя поток вечером.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -3.9).toISOString(),
          reactionGroups: [{ emoji: '❤️', count: 4, reactedByMe: false }],
        }),
      ],
    },
    suggest: {
      introText:
        'Идеи для постов приходят тихо: участник отправляет карточку, редактор видит её в своей очереди.\n\nДобавьте короткий контекст, фото или видео, чтобы редактору было проще быстро принять решение.',
      messages: [
        buildPreviewDialogMessage({
          id: 'chat-suggest-1',
          type: 'suggest',
          text: 'Можно сделать короткий пост про новые контейнеры для батареек у офиса управляющей компании.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -7.2).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'pending',
        }),
        buildPreviewDialogMessage({
          id: 'chat-suggest-2',
          type: 'suggest',
          text: '',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -2.9).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'published',
          publishedUrl: 'https://max.ru/chats/preview-chat/message/220',
          hasImage: true,
          imageFileName: 'containers.webp',
        }),
      ],
    },
  };
  const channelDialogs: Record<ChannelDialogType, PreviewDialogBucket> = {
    comments: {
      introText: '',
      messages: [
        buildPreviewDialogMessage({
          id: 'channel-comments-1',
          type: 'comments',
          text: 'Спасибо за карту отключений. Наконец-то видно точный интервал по улице Сиреневой.',
          authorUserId: 'preview-user-11',
          authorDisplayName: 'Татьяна',
          avatarUrl: buildPreviewAvatarDataUrl('Татьяна', '#f1a44b', '#ea7b4b'),
          createdAt: addHours(now, -10.5).toISOString(),
        }),
        buildPreviewDialogMessage({
          id: 'channel-comments-2',
          type: 'comments',
          text: 'Если добавите следующий апдейт про развоз воды, закрепите его в начале треда.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -9.8).toISOString(),
          reactionGroups: [{ emoji: '👍', count: 6, reactedByMe: true }],
        }),
        buildPreviewDialogMessage({
          id: 'channel-comments-3',
          type: 'comments',
          text: 'Прикладываю кадр с перекрёстка, чтобы было понятнее, где образуется пробка.',
          authorUserId: 'preview-user-12',
          authorDisplayName: 'Ирина',
          avatarUrl: buildPreviewAvatarDataUrl('Ирина', '#6aa8ff', '#3b7ef0'),
          createdAt: addHours(now, -9.2).toISOString(),
          attachments: [
            {
              kind: 'image',
              url: buildPreviewAvatarDataUrl('Фото', '#dbe9ff', '#aacbff'),
              previewUrl: buildPreviewAvatarDataUrl('Фото', '#dbe9ff', '#aacbff'),
              fileName: 'traffic-photo.webp',
              mimeType: 'image/webp',
              size: 248_000,
              width: 1200,
              height: 900,
            },
          ],
        }),
      ],
    },
    suggest: {
      introText:
        'Только события нашего города с датой, адресом и контактами.\n\nБез дублей, запрещённых товаров и скрытой рекламы.',
      messages: [
        buildPreviewDialogMessage({
          id: 'channel-suggest-1',
          type: 'suggest',
          text: 'Подборка ярмарок выходного дня отлично зайдёт на воскресенье утром.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -6.4).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'pending',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-2',
          type: 'suggest',
          text: 'Сделайте пост про вечерний маркет у набережной, люди всё ещё спрашивают время работы.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -3.1).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'published',
          publishedUrl: 'https://max.ru/chats/preview-channel/message/318',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-3',
          type: 'suggest',
          text: '',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -1.4).toISOString(),
          delivered: false,
          deliveredToUserId: null,
          suggestionDelivery: {
            state: 'no_reachable_editor',
            deliveredCount: 0,
            targetCount: 0,
            pendingCount: 0,
            unreachableCount: 0,
          },
          reviewStatus: 'pending',
          hasImage: true,
          imageFileName: 'market-evening.webp',
        }),
        buildPreviewDialogMessage({
          id: 'channel-suggest-4',
          type: 'suggest',
          text: 'Можно собрать подборку новых кофеен у метро, но без цен это сейчас сыровато.',
          authorUserId: 'preview-admin',
          authorDisplayName: 'Алексей',
          avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
          createdAt: addHours(now, -0.8).toISOString(),
          delivered: true,
          deliveredToUserId: 'preview-admin-2',
          reviewStatus: 'cancelled',
        }),
      ],
    },
  };

  const state: PreviewState = {
    networksScenario: searchParams.get('networksScenario') ?? 'normal',
    retentionScenario: searchParams.get('retentionScenario') ?? 'normal',
    stopWordsWriteError:
      searchParams.get('stopWordsWriteError') === 'network'
        ? 'network'
        : searchParams.get('stopWordsWriteError') === 'conflict'
          ? 'conflict'
          : searchParams.get('stopWordsWriteError') === 'review'
            ? 'review'
            : null,
    stopWordsStorageStatus:
      searchParams.get('stopWordsStorage') === 'invalid'
        ? 'invalid'
        : searchParams.get('stopWordsStorage') === 'legacy'
          ? 'legacy'
          : 'valid',
    advertisingPilot: !publisherProfile && searchParams.get('advertisingPilot') === '1',
    marketplacePilot: searchParams.get('marketplacePilot') === '1',
    marketplaceOwner: searchParams.get('marketplaceOwner') !== '0',
    marketplacePublished:
      searchParams.get('marketplacePublished') === '1' ||
      searchParams.get('marketplaceOwner') === '0',
    marketplaceReadiness:
      searchParams.get('marketplaceReady') === 'delayed'
        ? 'delayed'
        : searchParams.get('marketplaceReady') === '0'
          ? 'unavailable'
          : 'ready',
    clock,
    me: {
      userId: 'preview-admin',
      username: 'designer',
      displayName: 'Алексей',
      avatarUrl: buildPreviewAvatarDataUrl('Алексей', '#7db8ff', '#4d89ff'),
      profileUrl: buildPreviewProfileUrl('designer'),
      profileHandoffUrl: buildPreviewProfileHandoffUrl('preview-admin'),
      botDialogUrl: publisherProfile
        ? 'https://max.ru/se14088825_bot'
        : searchParams.get('previewBot') === 'maximova'
          ? 'https://max.ru/id613070470872_5_bot'
          : searchParams.get('previewBot') === 'rex'
            ? 'https://max.ru/id613070470872_6_bot'
            : 'https://max.ru/id613070470872_9_bot',
      canAccessSystem: !publisherProfile,
      networksEnabled: !publisherProfile && searchParams.get('networks') === '1',
      profile: publisherProfile ? 'publisher' : 'moderation',
      capabilities: publisherProfile
        ? ['publisher_workspace', 'publisher_entities', 'chat_comments', 'publisher_policy_write']
        : ['moderation_workspace'],
      homeRoute: '/',
    },
    systemModeSelection: 'auto',
    favoriteLabelsInitialized: true,
    favoriteLabels: {},
    favoriteLabelsRevision: 1,
    chats: [
      createPreviewChatSummary(
        {
          id: PREVIEW_CHAT_ID,
          title: PREVIEW_CHAT_TITLE,
          createdAt: addDays(now, -280).toISOString(),
          entityType: 'chat',
          link: null,
          avatarUrl: buildPreviewAvatarDataUrl(PREVIEW_CHAT_TITLE, '#20b7aa', '#117e87'),
          channelOverview: null,
          favoriteTypes: ['important'],
        },
        clock,
      ),
      createPreviewChatSummary(
        {
          id: 'preview-chat-2',
          title: 'Клуб соседей',
          createdAt: addDays(now, -120).toISOString(),
          entityType: 'chat',
          link: null,
          avatarUrl: buildPreviewAvatarDataUrl('Клуб соседей', '#6a8cff', '#4b55dd'),
          channelOverview: null,
          favoriteTypes: ['broadcast'],
        },
        clock,
      ),
    ],
    channels: [
      createPreviewChatSummary(
        {
          id: PREVIEW_CHANNEL_ID,
          title: PREVIEW_CHANNEL_TITLE,
          createdAt: addDays(now, -250).toISOString(),
          entityType: 'channel',
          link: 'https://max.ru/channels/yuzhnoe-news',
          avatarUrl: buildPreviewAvatarDataUrl(PREVIEW_CHANNEL_TITLE, '#4f69ff', '#2d3fd5'),
          channelOverview: {
            enabledScenariosCount: 2,
            commentsEnabled: true,
            postSuggestionsEnabled: true,
            commentsModerationEnabled: true,
          },
          favoriteTypes: ['service'],
        },
        clock,
      ),
      createPreviewChatSummary(
        {
          id: 'preview-channel-2',
          title: 'Афиша района',
          createdAt: addDays(now, -90).toISOString(),
          entityType: 'channel',
          link: 'https://max.ru/channels/afisha',
          avatarUrl: buildPreviewAvatarDataUrl('Афиша района', '#7d56f6', '#5c2fd6'),
          channelOverview: {
            enabledScenariosCount: 1,
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        },
        clock,
      ),
    ],
    chatHeaderParticipantsCount: 1_584,
    chatDialogs,
    chatDialogThreads: {},
    chatSettings,
    reportsAvailable: searchParams.get('reportsAvailability') !== 'paused',
    reportsScenario: searchParams.get('reportsScenario') ?? undefined,
    chatRules,
    chatDomains,
    chatKaravanStorefrontAllowlist,
    chatBroadcasts,
    autopostRules: [],
    publications: [],
    publicationDeliveries: [],
    chatGiveaways,
    chatParticipants: createParticipantsItems('chat-roster', 48, clock),
    chatActivity: createActivityItems(
      'chat-activity',
      ['Ольга Бойко', 'Юлия', 'Андрей Фёдоров', 'Марина', 'Александр', 'Наталья'],
      now,
      [
        0.3, 1.2, 2.8, 4.1, 6.7, 8.9, 10.5, 12.4, 14.3, 18.8, 23.5, 26.2, 31.7, 36.1, 44.2, 55.6,
        63.4, 78.5, 92.1, 110.4, 136.2, 158.7, 175.9, 212.8, 250.3, 310.1, 420.6, 560.8,
      ],
    ),
    chatViolations: createChatViolations(now),
    spammerReviewCandidates: createPreviewSpammerReviewCandidates(now),
    chatVkParsing,
    chatPolls,
    chatPollVoters,
    channelHeaderParticipantsCount: 9_240,
    channelDialogs,
    channelDialogThreads: {},
    channelSettings,
    channelPostSignature,
    channelPolls,
    channelPollVoters,
    channelBroadcasts,
    channelGiveaways,
    channelActivity: createActivityItems(
      'channel-activity',
      ['Владимир', 'Татьяна', 'Ирина', 'Дмитрий', 'Елена', 'Максим'],
      addHours(now, -1),
      [
        0.6, 1.4, 2.2, 3.8, 5.6, 7.3, 9.1, 11.8, 13.4, 17.7, 21.2, 26.5, 33.9, 40.2, 47.8, 58.1,
        70.3, 88.4, 112.6, 138.8, 166.2, 199.1, 240.5, 296.2, 352.7, 490.4,
      ],
    ),
    channelVkParsing,
    chatPrimaryBotId: PREVIEW_PRIMARY_BOT_ID,
    channelPrimaryBotId: PREVIEW_PRIMARY_BOT_ID,
    chatPartnerAssistEnabled: false,
    channelPartnerAssistEnabled: false,
    accessDiagnostics: buildPreviewAccessDiagnostics(search),
    settingsScreenError: resolvePreviewSettingsScreenError(search),
    moderationActionDelayMs: searchParams.get('moderationState') === 'slow' ? 800 : 0,
    publisherEntitiesVariant:
      publisherState === 'channel-only' ||
      publisherState === 'large' ||
      publisherState === 'empty' ||
      publisherState === 'error'
        ? publisherState
        : 'mixed',
    publisherPolicyVariant:
      publisherPolicyState === 'setup' ||
      publisherPolicyState === 'permission' ||
      publisherPolicyState === 'error' ||
      publisherPolicyState === 'stale'
        ? publisherPolicyState
        : 'normal',
    publisherPostImportVariant,
    publicationVideoUploadVariant:
      searchParams.get('videoUploadState') === 'failed' ? 'failed' : 'ready',
    publisherPostImportSession: null,
  };

  state.autopostRules = [
    buildPreviewAutopostRule(state, {
      id: 'autopost-preview-soil',
      sourceChatId: PREVIEW_CHAT_ID,
      entityType: 'chat',
      title: 'Грунты',
      payload: managedAutopostPayloadSchema.parse({
        text: 'Проверенные грунты из садового чата: лёгкий универсальный и смесь для рассады.',
        textFormat: 'markdown',
        targetMode: 'current',
        targetChatIds: [PREVIEW_CHAT_ID],
        applyToAllChats: false,
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: [addHours(now, 18).toISOString(), addDays(now, 2).toISOString()],
      }),
      createdAt: addDays(now, -3).toISOString(),
      updatedAt: addHours(now, -3).toISOString(),
    }),
    buildPreviewAutopostRule(state, {
      id: 'autopost-preview-products',
      sourceChatId: PREVIEW_CHANNEL_ID,
      entityType: 'channel',
      title: 'Продукты',
      payload: managedAutopostPayloadSchema.parse({
        text: 'Продукты, которые беру домой сама: список на неделю и короткие заметки по качеству.',
        textFormat: 'markdown',
        targetMode: 'current',
        targetChatIds: [PREVIEW_CHANNEL_ID],
        applyToAllChats: false,
        buttons: [{ text: 'Список', url: 'https://maxim.play-team.ru/products' }],
        buttonEnabled: true,
        buttonUrl: 'https://maxim.play-team.ru/products',
        buttonText: 'Список',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: [addHours(now, 9).toISOString(), addDays(now, 1).toISOString()],
      }),
      createdAt: addDays(now, -4).toISOString(),
      updatedAt: addHours(now, -2).toISOString(),
    }),
    buildPreviewAutopostRule(state, {
      id: 'autopost-preview-completed',
      sourceChatId: PREVIEW_CHAT_ID,
      entityType: 'chat',
      title: 'Зимние объявления',
      status: 'COMPLETED',
      payload: managedAutopostPayloadSchema.parse({
        text: 'Архив объявлений об уборке снега и временных ограничениях парковки.',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: [PREVIEW_CHAT_ID],
        applyToAllChats: false,
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: [addDays(now, -30).toISOString()],
      }),
      createdAt: addDays(now, -45).toISOString(),
      updatedAt: addDays(now, -30).toISOString(),
    }),
  ];

  const publicationFixtures = createPreviewPublications(state, now);
  state.publications = publicationFixtures.publications;
  state.publicationDeliveries = publicationFixtures.deliveries;

  const publicationWindowState = new URLSearchParams(search).get('publicationWindow');
  if (
    publicationWindowState === 'stopped-pending' ||
    publicationWindowState === 'stopped-sending' ||
    publicationWindowState === 'stopped-ambiguous'
  ) {
    const publication = state.publications.find(
      (item) => item.id === 'publication-access-required',
    );
    const occurrence = publication?.occurrences[0];
    const target = publication?.targetPreviews[0];
    if (publication && occurrence && target) {
      const status =
        publicationWindowState === 'stopped-pending'
          ? 'PENDING'
          : publicationWindowState === 'stopped-sending'
            ? 'SENDING'
            : 'AMBIGUOUS';
      const pending = status === 'AMBIGUOUS' ? 0 : 1;
      const stats = {
        total: 1,
        pending,
        sent: 0,
        failed: 0,
        ambiguous: status === 'AMBIGUOUS' ? 1 : 0,
        canceled: 0,
      };
      publication.dispatchIssue = null;
      occurrence.dispatchIssue = null;
      occurrence.dispatchBlockedSince = null;
      occurrence.dispatchCheckedAt = null;
      occurrence.status = 'CANCELED';
      occurrence.canRetry = false;
      occurrence.delivery = stats;
      publication.delivery = stats;
      publication.actionableDelivery = { ...stats, dispatchPending: 0 };
      state.publicationDeliveries.push({
        id: `${occurrence.id}-${publicationWindowState}`,
        occurrenceId: occurrence.id,
        target,
        status,
        dispatchStopped: true,
        attemptCount: 1,
        remoteMessageId: null,
        lastError: null,
        sentAt: null,
        waitReason: 'max_rate_limit',
        firstDeferredAt: now.toISOString(),
        nextAttemptAt: new Date(now.getTime() + 30_000).toISOString(),
        deadlineAt: addDays(now, 1).toISOString(),
      });
    }
  }
  if (publicationWindowState === 'capacity') {
    const publication = state.publications.find(
      (item) => item.id === 'publication-access-required',
    );
    const occurrence = publication?.occurrences[0];
    const target = publication?.targetPreviews[0];
    if (publication && occurrence && target) {
      publication.dispatchIssue = null;
      occurrence.dispatchIssue = null;
      occurrence.dispatchBlockedSince = null;
      occurrence.dispatchCheckedAt = null;
      occurrence.status = 'IN_PROGRESS';
      const stats = { ...publication.delivery, total: 1, pending: 1 };
      occurrence.delivery = stats;
      publication.delivery = stats;
      publication.actionableDelivery = stats;
      state.publicationDeliveries.push({
        id: `${occurrence.id}-capacity`,
        occurrenceId: occurrence.id,
        target,
        status: 'PENDING',
        attemptCount: 1,
        remoteMessageId: null,
        lastError: null,
        sentAt: null,
        waitReason: 'max_rate_limit',
        firstDeferredAt: now.toISOString(),
        nextAttemptAt: new Date(now.getTime() + 30_000).toISOString(),
        deadlineAt: addDays(now, 1).toISOString(),
      });
    }
  }

  if (publicationWindowState === 'missed' || publicationWindowState === 'missed-future') {
    const publication = state.publications.find(
      (item) => item.id === 'publication-access-required',
    );
    if (publication) {
      const missedAt = addHours(now, -4).toISOString();
      const nextAt = addDays(now, 1).toISOString();
      const scheduleBase = {
        status: 'ACTIVE' as const,
        timezone: 'Europe/Moscow',
        revision: 1,
        lastError: null,
        replaceConflicts: false,
      };
      publication.schedule =
        publicationWindowState === 'missed-future'
          ? { ...scheduleBase, mode: 'slots', slots: [missedAt, nextAt], nextOccurrenceAt: nextAt }
          : { ...scheduleBase, mode: 'once', at: missedAt, nextOccurrenceAt: null };
      publication.dispatchIssue = 'target_setup_required';
      publication.requiresScheduleDecision = true;
      for (const occurrence of publication.occurrences) {
        occurrence.scheduledAt = missedAt;
        occurrence.status = 'FAILED';
        occurrence.dispatchIssue = 'target_setup_required';
        occurrence.requiresScheduleDecision = true;
        occurrence.canRetry = true;
      }
      const missedOccurrence = publication.occurrences[0];
      if (publicationWindowState === 'missed-future' && missedOccurrence) {
        publication.occurrences.unshift({
          ...missedOccurrence,
          id: `${publication.id}-future-occurrence`,
          scheduledAt: nextAt,
          status: 'SCHEDULED',
          dispatchIssue: null,
          requiresScheduleDecision: false,
          dispatchBlockedSince: null,
          dispatchCheckedAt: null,
          canRetry: false,
        });
      }
    }
  }

  if (publicationWindowState === 'schedule-error') {
    const publication = state.publications.find(
      (item) => item.id === 'publication-access-required',
    );
    if (publication) {
      const scheduledAt = addDays(now, -1).toISOString();
      publication.schedule = {
        mode: 'recurrence',
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        times: ['12:00'],
        startsAt: scheduledAt,
        endsAt: null,
        maxOccurrences: null,
        replaceConflicts: false,
        status: 'ERROR',
        timezone: 'Europe/Moscow',
        revision: 1,
        nextOccurrenceAt: scheduledAt,
        lastError: 'PUBLISHER_RUNTIME_UNAVAILABLE token=preview-only',
      };
      publication.lifecycle = 'ACTIVE';
      publication.dispatchIssue = null;
      publication.requiresScheduleDecision = false;
      for (const occurrence of publication.occurrences) {
        occurrence.scheduledAt = scheduledAt;
        occurrence.status = 'SCHEDULED';
        occurrence.dispatchIssue = null;
        occurrence.requiresScheduleDecision = false;
        occurrence.dispatchBlockedSince = null;
        occurrence.dispatchCheckedAt = null;
        occurrence.canRetry = false;
      }
    }
  }

  if (publicationWindowState === 'retry-once') {
    const publication = state.publications.find(
      (item) => item.id === 'publication-access-required',
    );
    const occurrence = publication?.occurrences[0];
    const target = publication?.targets[0];
    if (publication && occurrence && target) {
      const scheduledAt = addDays(now, -1).toISOString();
      publication.schedule = {
        mode: 'once',
        at: scheduledAt,
        status: 'ERROR',
        timezone: 'Europe/Moscow',
        revision: 1,
        nextOccurrenceAt: null,
        lastError: 'Сообщение не отправлено.',
        replaceConflicts: false,
      };
      publication.lifecycle = 'ERROR';
      publication.audienceSelection = 'ALL_CHANNELS';
      publication.audienceMode = 'DYNAMIC';
      publication.dispatchIssue = null;
      occurrence.scheduledAt = scheduledAt;
      occurrence.status = 'FAILED';
      occurrence.dispatchIssue = null;
      occurrence.dispatchBlockedSince = null;
      occurrence.dispatchCheckedAt = null;
      occurrence.canRetry = true;
      state.publicationDeliveries.push({
        id: `${occurrence.id}-delivery-retry`,
        occurrenceId: occurrence.id,
        target,
        status: 'FAILED',
        contentRevision: 1,
        usesLatestContent: true,
        attemptCount: 1,
        remoteMessageId: null,
        lastError: 'Сообщение не отправлено.',
        sentAt: null,
      });
    }
  }

  if (publisherPostImportVariant === 'ready') {
    const imported = buildPreviewPublicationDetails(
      state,
      {
        title: 'Черновик',
        content: {
          text: 'В субботу встречаемся в парке. Начало в 12:00.',
          textFormat: 'plain',
          buttons: [],
          media: [
            {
              type: 'image',
              base64:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              mimeType: 'image/png',
              fileName: 'park.png',
            },
          ],
        },
        audience: { selection: 'ALL_MANAGED', mode: 'SNAPSHOT', targets: [] },
        schedule: null,
        intent: 'draft',
      },
      {
        id: 'publication-imported-draft',
        now,
        createdAt: addHours(now, -1).toISOString(),
        updatedAt: addHours(now, -1).toISOString(),
      },
    );
    state.publications = [imported.publication, ...state.publications];
  }

  if (publisherPostImportVariant !== 'none') {
    state.publisherPostImportSession = publisherPostImportSessionSchema.parse({
      id: 'preview-import-session-123456',
      status: publisherPostImportVariant,
      expiresAt: addHours(now, 1).toISOString(),
      publicationId: publisherPostImportVariant === 'ready' ? 'publication-imported-draft' : null,
      botUrl:
        publisherPostImportVariant === 'waiting'
          ? 'https://max.ru/se14088825_bot?start=pi_preview_import_token_123456'
          : null,
      failureCode: publisherPostImportVariant === 'failed' ? 'unsupported_content' : null,
      omissions: publisherPostImportVariant === 'ready' ? ['buttons_not_imported'] : [],
    });
  }

  return state;
}

function resolvePreviewSettingsScreenError(search: string): PreviewState['settingsScreenError'] {
  const value = new URLSearchParams(search).get('settingsError');
  return value === 'auth-expired' || value === 'access-denied' ? value : null;
}

export function createPreviewState(options: PreviewApiTransportOptions): PreviewState {
  return createInitialState(
    options.search ?? readPreviewRouteSearch(),
    options.clock ?? systemPreviewClock,
  );
}

export { readPreviewClock };
