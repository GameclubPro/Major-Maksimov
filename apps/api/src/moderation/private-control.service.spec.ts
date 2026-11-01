import duplicateRulesCases from '../../../../packages/contracts/test/fixtures/duplicate-rules.json';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  channelSettingsSchema,
  chatSettingsSchema,
  chatSettingsScreenResponseSchema,
  MAX_BOT_SPEECH_TEXT_LENGTH,
  MAX_CHAT_RULES_TEXT_LENGTH,
  type ChatRules,
  type ManagedGiveawayDetails,
  type ManagedGiveawayWinner,
  type MaxUpdate,
} from '@maxim/contracts';
import type { AdminService } from '../admin/admin.service';
import {
  USER_AGREEMENT_SHORT_NOTICE,
  USER_AGREEMENT_START_NOTICE,
} from '../common/user-agreement-notice';
import {
  buildCompactProfileMentionStartPayload,
  parseCompactGiveawayHandoffStartPayload,
  parseCompactProfileMentionStartPayload,
} from '../max/max-deep-link.util';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from '../max/max-media-upload-validation';
import { WebhookParser } from '../webhook/webhook.parser';
import { createDefaultPrivateControlSession } from './private-control-session-normalizer';
import { PrivateControlService } from './private-control.service';

function extractSqlValues(query: unknown): unknown[] {
  if (!query || typeof query !== 'object' || !('values' in query)) {
    return [];
  }

  const values = (query as { values?: unknown }).values;
  if (!Array.isArray(values)) {
    return [];
  }

  return values.flatMap((value) => [value, ...extractSqlValues(value)]);
}

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function decodeStartAppRoute(url: string): string | null {
  const startParam = new URL(url).searchParams.get('startapp');
  if (!startParam?.startsWith('mr-')) {
    return null;
  }

  const encodedPayload = startParam.slice(3);
  const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const payload = JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8')) as {
    v?: number;
    k?: string;
    r?: string;
  };

  return payload.v === 1 && payload.k === 'route' && typeof payload.r === 'string'
    ? payload.r
    : null;
}

function createPrivateTextUpdate(text: string, options: { botId?: string } = {}): MaxUpdate {
  return {
    updateId: `upd-text-${Date.now()}`,
    ...(options.botId ? { botId: options.botId } : {}),
    type: 'message_created',
    message: {
      messageId: `msg-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          text,
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateForwardedModerationUpdate(
  text = 'бан',
  options: { sourceChatId?: number; sourceChatTitle?: string } = {},
): MaxUpdate {
  const sourceChatId = options.sourceChatId ?? -70000000000001;
  const sourceChatTitle = options.sourceChatTitle ?? 'Тестовый чат 1';
  return {
    updateId: `upd-forwarded-ban-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-forwarded-ban-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          text,
          forwarded_message: {
            sender: {
              user_id: 'user-77',
              name: 'Нарушитель',
            },
            recipient: {
              chat_id: sourceChatId,
              title: sourceChatTitle,
            },
            body: {
              text: 'Сомнительное сообщение',
            },
          },
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateForwardedRulesUpdate(text = 'правила'): MaxUpdate {
  return {
    updateId: `upd-forwarded-rules-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-forwarded-rules-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          text,
          forwarded_message: {
            recipient: {
              chat_id: -70000000000001,
              title: 'Тестовый чат 1',
            },
            body: {
              mid: 'mid-rules-source-1',
              text: '1. Без спама.\n2. Без ссылок.',
            },
          },
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateFormattedTextUpdate(
  text: string,
  markup: Array<{
    type:
      | 'emphasized'
      | 'heading'
      | 'link'
      | 'monospaced'
      | 'strikethrough'
      | 'strong'
      | 'underline'
      | 'user_mention';
    from: number;
    length: number;
    url?: string;
    user_link?: string;
  }>,
): MaxUpdate {
  return {
    updateId: `upd-formatted-text-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-formatted-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          text,
          markup,
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivatePureForwardUpdate(params: {
  text: string;
  markup?: Array<Record<string, unknown>>;
  botId?: string;
}): MaxUpdate {
  return new WebhookParser().parse(
    {
      update_type: 'message_created',
      timestamp: '2026-08-30T10:00:00.000Z',
      message: {
        sender: { user_id: 195714583, name: 'Тестовый пользователь' },
        recipient: { chat_id: 152517912, chat_type: 'dialog' },
        body: null,
        link: {
          type: 'forward',
          chat_id: -70000000000001,
          message: {
            mid: `mid-pure-forward-${Date.now()}`,
            text: params.text,
            ...(params.markup ? { markup: params.markup } : {}),
          },
        },
      },
    },
    { botId: params.botId ?? '777000_bot' },
  );
}

function countMessageOffsetUnits(value: string): number {
  return value.length;
}

function messageOffsetIndexOf(source: string, value: string): number {
  return source.indexOf(value);
}

function createPrivatePhotoUpdate(
  options: { text?: string; photoIds?: string[]; botId?: string } = {},
): MaxUpdate {
  const text = options.text ?? '';
  const photoIds = options.photoIds && options.photoIds.length > 0 ? options.photoIds : ['photo-1'];

  return {
    updateId: `upd-photo-${Date.now()}`,
    ...(options.botId ? { botId: options.botId } : {}),
    type: 'message_created',
    message: {
      messageId: `msg-photo-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          ...(text ? { text } : {}),
          attachments: photoIds.map((photoId, index) => ({
            type: 'image',
            payload: {
              url: `https://example.test/broadcast-photo-${index + 1}.jpg`,
              photo_id: photoId,
            },
          })),
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateTextAndPhotoUpdate(text: string): MaxUpdate {
  return createPrivatePhotoUpdate({
    text,
    photoIds: ['rules-photo-1'],
  });
}

function createPrivateFileUpdate(
  fileName = 'photo-as-file.png',
  url = 'https://example.test/photo-as-file.png',
): MaxUpdate {
  return {
    updateId: `upd-file-${Date.now()}`,
    type: 'message_created',
    message: {
      messageId: `msg-file-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          attachments: [
            {
              type: 'file',
              size: 12345,
              filename: fileName,
              payload: {
                url,
                token: 'file-token-1',
                fileId: 'file-1',
              },
            },
          ],
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateImageFileUpdate(): MaxUpdate {
  return createPrivateFileUpdate();
}

function createPrivateVideoUpdate(
  options: string | { text?: string; botId?: string; includeToken?: boolean } = '',
): MaxUpdate {
  const text = typeof options === 'string' ? options : (options.text ?? '');
  const botId = typeof options === 'string' ? undefined : options.botId;
  const includeToken = typeof options === 'string' ? true : options.includeToken !== false;
  return {
    updateId: `upd-video-${Date.now()}`,
    ...(botId ? { botId } : {}),
    type: 'message_created',
    message: {
      messageId: `msg-video-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          ...(text ? { text } : {}),
          attachments: [
            {
              type: 'video',
              payload: {
                url: 'https://example.test/channel-suggestion-video.mp4',
                ...(includeToken ? { token: 'incoming-video-token' } : {}),
                video_id: 'video-1',
                file_name: 'channel-suggestion-video.mp4',
                mime_type: 'video/mp4',
              },
            },
          ],
        },
        sender: {
          user_id: 'user-1',
          name: 'Тестовый пользователь',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateCallbackUpdate(
  payload: string,
  options: {
    userId?: string;
    displayName?: string;
    messageId?: string;
    botId?: string;
  } = {},
): MaxUpdate {
  const userId = options.userId ?? 'user-1';
  const displayName = options.displayName ?? 'Тестовый пользователь';
  return {
    updateId: `upd-cb-${Date.now()}`,
    ...(options.botId ? { botId: options.botId } : {}),
    type: 'message_callback',
    message: {
      messageId: options.messageId ?? `msg-cb-${Date.now()}`,
      chatId: '152517912',
      senderId: '613002203036',
      senderName: 'Майор Максимов',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-1',
        payload,
        user: {
          user_id: userId,
          name: displayName,
        },
      },
      message: {
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createBotStartedPrivateUpdate(
  startPayload = 'broadcast_handoff',
  options: { botId?: string } = {},
): MaxUpdate {
  return {
    updateId: `upd-bot-started-${Date.now()}`,
    ...(options.botId ? { botId: options.botId } : {}),
    type: 'bot_started',
    message: {
      messageId: `bot-started-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      start_payload: startPayload,
      user: {
        user_id: 'user-1',
        name: 'Тестовый пользователь',
      },
      chat: {
        chat_id: 152517912,
        type: 'dialog',
      },
    },
  };
}

function createBotStartedGiveawayClaimUpdate(): MaxUpdate {
  return {
    updateId: `upd-bot-started-giveaway-${Date.now()}`,
    type: 'bot_started',
    message: {
      messageId: `bot-started-giveaway-${Date.now()}`,
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      start_payload: 'ggc-test-payload',
      user: {
        user_id: 'user-1',
        name: 'Тестовый пользователь',
      },
      chat: {
        chat_id: 152517912,
        type: 'dialog',
      },
    },
  };
}

const defaultSettings = chatSettingsSchema.parse({});
const defaultChannelSettings = channelSettingsSchema.parse({});
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);

function createRules(overrides: Partial<ChatRules> = {}): ChatRules {
  return {
    text: '',
    textFormat: 'markdown',
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    autoTextEnabled: false,
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
    adminContactButtonEnabled: false,
    adminContactButtonUrl: '',
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
    ...overrides,
  };
}

function createGiveawayWinner(
  overrides: Partial<ManagedGiveawayWinner> = {},
): ManagedGiveawayWinner {
  return {
    id: 'winner-1',
    prizeId: 'prize-1',
    prizePosition: 1,
    prizeTitle: 'Подписка MAX',
    prizeDisplayTitle: 'Подписка MAX',
    entryId: 'entry-1',
    userId: 'user-1',
    displayName: 'Тестовый пользователь',
    status: 'SELECTED',
    selectedAt: new Date().toISOString(),
    claimDeadlineAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    claimedAt: null,
    deliveredAt: null,
    expiredAt: null,
    rerolledAt: null,
    ...overrides,
  };
}

function createGiveaway(overrides: Partial<ManagedGiveawayDetails> = {}): ManagedGiveawayDetails {
  return {
    id: 'giveaway-1',
    sourceChatId: '-70000000000001',
    entityType: 'chat',
    title: 'Весенний розыгрыш',
    description: 'Разыгрываем подписку.',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    claimHours: 24,
    requiredChannelIds: [],
    publicationMessageId: 'msg-1',
    publicationUrl: 'https://max.ru/chats/chat-1/message/1',
    resultsMessageId: null,
    resultsUrl: null,
    status: 'ACTIVE',
    hasImage: false,
    entriesCount: 12,
    verifiedEntriesCount: 10,
    pendingEntriesCount: 2,
    winnersCount: 0,
    startsAt: null,
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    publishedAt: new Date().toISOString(),
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prizes: [
      {
        id: 'prize-1',
        position: 1,
        title: 'Подписка MAX',
        displayTitle: 'Подписка MAX',
      },
    ],
    winners: [],
    ...overrides,
  };
}

function createHarness(
  overrides: {
    settings?: typeof defaultSettings;
    channelSettings?: typeof defaultChannelSettings;
    adminService?: Record<string, unknown>;
    manualModerationService?: Record<string, unknown>;
    adminSettingsService?: Record<string, unknown>;
    managedBroadcastService?: Record<string, unknown> | null;
    managedGiveaway?: ManagedGiveawayDetails | null;
    rules?: ChatRules;
    maxBotLinkService?: Record<string, unknown>;
    adminDialogLinkService?: Record<string, unknown>;
    supportRequestsService?: Record<string, unknown>;
    karavanStorefrontAllowlistService?: Record<string, unknown>;
    prisma?: Record<string, unknown>;
    managedEntityHandshakeService?: Record<string, unknown>;
    legacyHolds?: Record<string, unknown>;
  } = {},
) {
  const chats = [
    {
      id: '-70000000000001',
      title: 'Тестовый чат 1',
      createdAt: new Date().toISOString(),
      entityType: 'chat' as const,
    },
  ];
  const channels = [
    {
      id: '-80000000000001',
      title: 'Тестовый канал 1',
      createdAt: new Date().toISOString(),
      entityType: 'channel' as const,
    },
  ];

  let previewMessageCounter = 0;
  let imageUploadCounter = 0;
  let videoUploadCounter = 0;
  const maxClient = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    sendCustomMessageImmediateWithResolvedLink: jest.fn().mockImplementation(async () => {
      previewMessageCounter += 1;
      return { messageId: `msg-preview-${previewMessageCounter}`, url: null };
    }),
    sendMessageCopyWithInlineKeyboard: jest
      .fn()
      .mockResolvedValue({ messageId: 'msg-preview-1', url: null }),
    sendCustomMessageImmediate: jest.fn().mockResolvedValue({ message_id: 'msg-custom-1' }),
    sendMessageImmediateToUser: jest
      .fn()
      .mockResolvedValue({ messageId: 'msg-private-1', url: null }),
    uploadImage: jest.fn().mockImplementation(async () => {
      imageUploadCounter += 1;
      return { token: `upload-token-${imageUploadCounter}` };
    }),
    uploadVideo: jest.fn().mockImplementation(async () => {
      videoUploadCounter += 1;
      return { token: `upload-video-token-${videoUploadCounter}` };
    }),
    editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    answerCallback: jest.fn().mockResolvedValue(undefined),
    getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
  };

  let currentRules = overrides.rules ?? createRules();

  const adminService = {
    listManagedEntities: jest.fn().mockImplementation(async (_actor, entityType = 'all') => {
      if (entityType === 'channel') {
        return channels;
      }
      if (entityType === 'chat') {
        return chats;
      }
      return [...chats, ...channels];
    }),
    listChats: jest.fn().mockResolvedValue(chats),
    listChatsForMassBroadcast: jest.fn().mockResolvedValue(chats),
    getChatHeader: jest.fn().mockResolvedValue({ id: chats[0].id, title: chats[0].title }),
    getChannelHeader: jest.fn().mockResolvedValue({ id: channels[0].id, title: channels[0].title }),
    getSettings: jest.fn().mockResolvedValue(overrides.settings ?? defaultSettings),
    getChatSettingsScreen: jest.fn().mockImplementation(async () => ({
      settings: overrides.settings ?? defaultSettings,
      rules: currentRules,
      header: { id: chats[0].id, title: chats[0].title },
      requiredSubscriptionChannels: [],
      domains: [],
      managedBroadcasts: [],
    })),
    updateSettings: jest.fn().mockResolvedValue(overrides.settings ?? defaultSettings),
    applySettingsToAllChats: jest.fn().mockResolvedValue({
      sourceChatId: chats[0].id,
      updatedChats: 1,
      appliedChatIds: [chats[0].id],
    }),
    getDomainAllowlistDetails: jest.fn().mockResolvedValue([]),
    addDomain: jest.fn().mockResolvedValue(undefined),
    removeDomain: jest.fn().mockResolvedValue(undefined),
    scheduleDomainRemoval: jest.fn().mockResolvedValue(undefined),
    getRules: jest.fn().mockImplementation(async () => currentRules),
    updateRules: jest.fn().mockImplementation(async (_chatId, _actor, payload) => {
      currentRules = createRules({
        ...currentRules,
        text: payload.text,
        imageBase64: payload.imageBase64,
        imageMimeType: payload.imageMimeType,
        imageFileName: payload.imageFileName,
        autoTextEnabled: payload.autoTextEnabled,
        buttonEnabled: payload.buttonEnabled ?? currentRules.buttonEnabled,
        buttonUrl: payload.buttonUrl ?? currentRules.buttonUrl,
        buttonText: payload.buttonText ?? currentRules.buttonText,
        adminContactButtonEnabled:
          payload.adminContactButtonEnabled ?? currentRules.adminContactButtonEnabled,
        adminContactButtonUrl: payload.adminContactButtonUrl ?? currentRules.adminContactButtonUrl,
      });
      return currentRules;
    }),
    publishRules: jest.fn().mockImplementation(async () => {
      currentRules = createRules({
        ...currentRules,
        publishedMessageId: 'mid-rules-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/1',
        publishedAt: new Date().toISOString(),
      });
      return {
        chatId: chats[0].id,
        messageId: currentRules.publishedMessageId!,
        url: currentRules.publishedUrl,
        publishedAt: currentRules.publishedAt!,
      };
    }),
    resetPublishedRules: jest.fn().mockImplementation(async () => {
      currentRules = createRules({
        ...currentRules,
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      return currentRules;
    }),
    sendBroadcast: jest.fn().mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
    sendChannelBroadcast: jest
      .fn()
      .mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
    getEvents: jest.fn().mockResolvedValue([]),
    getLogsDashboard: jest.fn().mockResolvedValue({
      chat: { id: 'chat-1', title: 'Команда MAX', participantsCount: null, avatarUrl: null },
      period: {
        range: '7d',
        from: new Date('2026-03-01T00:00:00.000Z').toISOString(),
        to: new Date('2026-03-08T00:00:00.000Z').toISOString(),
      },
      membership: { joinedUsers: 0, leftUsers: 0, netUsers: 0 },
      violationsSummary: {
        warn: 0,
        deleteMessage: 0,
        mute: 0,
        ban: 0,
        unmute: 0,
        unban: 0,
        affectedUsers: 0,
        total: 0,
      },
      violations: [],
      moderationFeed: { items: [], hasMore: false, nextCursor: null },
      activityFeed: { items: [], hasMore: false, nextCursor: null },
    }),
    getChannelSettings: jest
      .fn()
      .mockResolvedValue(overrides.channelSettings ?? defaultChannelSettings),
    getPublicChannelSuggestionIntroText: jest
      .fn()
      .mockResolvedValue((overrides.channelSettings ?? defaultChannelSettings).postSuggestionsText),
    getPublicChannelSuggestionTarget: jest.fn().mockResolvedValue({
      title: channels[0].title,
      link: 'https://max.ru/channels/testovyj-kanal',
    }),
    updateChannelSettings: jest
      .fn()
      .mockResolvedValue(overrides.channelSettings ?? defaultChannelSettings),
    createChannelSuggestionFromBot: jest.fn().mockResolvedValue({
      ok: true,
      delivered: true,
      deliveredToUserId: 'admin-1',
      queued: false,
    }),
    reviewChannelSuggestionByAdmin: jest.fn().mockResolvedValue({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/777',
    }),
    publishChannelEngagementMessage: jest.fn().mockResolvedValue(undefined),
    assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    ...overrides.adminService,
  };
  const managedBroadcastService =
    overrides.managedBroadcastService === null
      ? undefined
      : {
          sendBroadcast: jest.fn((...args: Parameters<typeof adminService.sendBroadcast>) =>
            adminService.sendBroadcast(...args),
          ),
          sendChannelBroadcast: jest.fn(
            (...args: Parameters<typeof adminService.sendChannelBroadcast>) =>
              adminService.sendChannelBroadcast(...args),
          ),
          ...(overrides.managedBroadcastService ?? {}),
        };
  const manualModerationService = {
    adoptChatRulesFromMessage: jest
      .fn()
      .mockImplementation(async (_chatId, _actor, payload: Record<string, unknown>) => {
        currentRules = createRules({
          ...currentRules,
          ...(typeof payload.text === 'string' && payload.text.trim()
            ? {
                text: payload.text,
                autoTextEnabled: false,
              }
            : {}),
          publishedMessageId:
            typeof payload.sourceMessageId === 'string' && payload.sourceMessageId.trim()
              ? payload.sourceMessageId
              : null,
          publishedUrl:
            typeof payload.sourceMessageUrl === 'string' && payload.sourceMessageUrl.trim()
              ? payload.sourceMessageUrl
              : 'https://max.ru/chats/chat-1/message/321',
          publishedAt: new Date().toISOString(),
        });
        return currentRules;
      }),
    applyManualModerationAction: jest.fn().mockResolvedValue({ success: true, message: 'Готово' }),
    applyManualSystemBan: jest.fn().mockResolvedValue({
      ok: true,
      action: 'BAN',
      userId: 'user-77',
      muteDurationHours: null,
      unbanScheduledAt: null,
      message: 'Бан включён.',
    }),
    ...overrides.manualModerationService,
  };
  const adminDialogLinkService = {
    parseChannelSuggestionStartPayload: jest.fn((payload: string | null) => {
      if (!payload?.startsWith('cds-')) {
        return null;
      }

      const separatorIndex = payload.indexOf(':');
      if (separatorIndex <= 4) {
        return null;
      }

      const chatId = payload.slice(4, separatorIndex).trim();
      const token = payload.slice(separatorIndex + 1).trim();
      if (!chatId || !token) {
        return null;
      }

      return { chatId, token };
    }),
    ...overrides.adminDialogLinkService,
  };
  const adminSettingsService = {
    updateRules: adminService.updateRules,
    ...overrides.adminSettingsService,
  };

  let currentGiveaway =
    overrides.managedGiveaway === undefined ? createGiveaway() : overrides.managedGiveaway;
  const giveawayStore = new Map<string, ManagedGiveawayDetails>();
  if (currentGiveaway) {
    giveawayStore.set(currentGiveaway.id, currentGiveaway);
  }

  const saveGiveaway = (giveaway: ManagedGiveawayDetails) => {
    giveawayStore.set(giveaway.id, giveaway);
    if (
      giveaway.status === 'DRAFT' ||
      giveaway.status === 'SCHEDULED' ||
      giveaway.status === 'ACTIVE' ||
      giveaway.status === 'DRAWING'
    ) {
      currentGiveaway = giveaway;
    } else if (currentGiveaway?.id === giveaway.id) {
      currentGiveaway = null;
    }
    return giveaway;
  };

  const managedGiveawayService = {
    parseClaimStartPayload: jest.fn((payload: string | null) =>
      payload === 'ggc-test-payload'
        ? {
            giveawayId: 'giveaway-1',
            winnerId: 'winner-1',
          }
        : null,
    ),
    getGiveawayClaimContext: jest.fn().mockResolvedValue({
      giveaway: createGiveaway({
        status: 'COMPLETED',
        winnersCount: 1,
      }),
      winner: createGiveawayWinner({
        status: 'CLAIMED',
        claimDeadlineAt: null,
        claimedAt: new Date().toISOString(),
      }),
    }),
    claimGiveaway: jest.fn().mockResolvedValue({
      ok: true,
      winner: createGiveawayWinner({
        status: 'CLAIMED',
        claimedAt: new Date().toISOString(),
      }),
    }),
    getManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      return giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId });
    }),
    getCurrentManagedGiveawayForEntity: jest.fn().mockImplementation(async () => currentGiveaway),
    createManagedGiveaway: jest.fn().mockImplementation(async (_chatId, _actor, payload) => {
      const created = createGiveaway({
        id: 'giveaway-draft-1',
        title: payload.title,
        description: payload.description,
        imageEnabled: payload.imageEnabled,
        imageBase64: payload.imageBase64,
        imageMimeType: payload.imageMimeType,
        imageFileName: payload.imageFileName,
        claimHours: payload.claimHours,
        startsAt: payload.startsAt,
        endsAt: payload.endsAt,
        prizes: payload.prizes.map(
          (prize: { position: number; title: string; displayTitle?: string }) => ({
            id: `prize-${prize.position}`,
            position: prize.position,
            title: prize.title,
            displayTitle: prize.displayTitle ?? prize.title,
          }),
        ),
        status: 'DRAFT',
        publicationMessageId: null,
        publicationUrl: null,
        publishedAt: null,
        winners: [],
        winnersCount: 0,
        entriesCount: 0,
        verifiedEntriesCount: 0,
        pendingEntriesCount: 0,
      });
      return saveGiveaway(created);
    }),
    updateManagedGiveaway: jest
      .fn()
      .mockImplementation(async (_chatId, giveawayId, _actor, payload) => {
        const existing =
          giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'DRAFT' });
        const updated = createGiveaway({
          ...existing,
          title: payload.title,
          description: payload.description,
          imageEnabled: payload.imageEnabled,
          imageBase64: payload.imageBase64,
          imageMimeType: payload.imageMimeType,
          imageFileName: payload.imageFileName,
          claimHours: payload.claimHours,
          startsAt: payload.startsAt,
          endsAt: payload.endsAt,
          hasImage: payload.imageEnabled,
          prizes: payload.prizes.map(
            (prize: { position: number; title: string; displayTitle?: string }) => ({
              id: `prize-${prize.position}`,
              position: prize.position,
              title: prize.title,
              displayTitle: prize.displayTitle ?? prize.title,
            }),
          ),
          status: 'DRAFT',
          updatedAt: new Date().toISOString(),
        });
        return saveGiveaway(updated);
      }),
    getGiveawaySettingsMiniappUrl: jest
      .fn()
      .mockReturnValue(
        'https://major-maksimov.ru/app/chat/-70000000000001/settings?focus=giveaway',
      ),
    getGiveawayPublicMiniappUrl: jest
      .fn()
      .mockReturnValue('https://major-maksimov.ru/app/giveaways/giveaway-1'),
    publishManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing =
        giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'DRAFT' });
      return saveGiveaway(
        createGiveaway({
          ...existing,
          status: 'ACTIVE',
          publicationMessageId: 'msg-1',
          publicationUrl: 'https://max.ru/chats/chat-1/message/1',
          publishedAt: new Date().toISOString(),
        }),
      );
    }),
    closeManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing = giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId });
      return saveGiveaway(
        createGiveaway({
          ...existing,
          status: 'COMPLETED',
          winnersCount: 1,
        }),
      );
    }),
    rerollManagedGiveawayWinner: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing =
        giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'COMPLETED' });
      return saveGiveaway(
        createGiveaway({
          ...existing,
          status: 'COMPLETED',
          winnersCount: 1,
          winners: [
            createGiveawayWinner({
              id: 'winner-2',
              userId: 'user-2',
              displayName: 'Новый победитель',
            }),
          ],
        }),
      );
    }),
    markManagedGiveawayWinnerDelivered: jest
      .fn()
      .mockImplementation(async (_chatId, giveawayId) => {
        const existing =
          giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId, status: 'COMPLETED' });
        return saveGiveaway(
          createGiveaway({
            ...existing,
            status: 'COMPLETED',
            winnersCount: 1,
            winners: [
              createGiveawayWinner({ status: 'DELIVERED', deliveredAt: new Date().toISOString() }),
            ],
          }),
        );
      }),
    cancelManagedGiveaway: jest.fn().mockImplementation(async (_chatId, giveawayId) => {
      const existing = giveawayStore.get(giveawayId) ?? createGiveaway({ id: giveawayId });
      return saveGiveaway(createGiveaway({ ...existing, status: 'CANCELED' }));
    }),
  };
  const redisStrings = new Map<string, string>();
  const redisCounter = {
    getString: jest.fn(async (key: string) => redisStrings.get(key) ?? null),
    setStringWithTtl: jest.fn(async (key: string, value: string) => {
      redisStrings.set(key, value);
    }),
    deleteKey: jest.fn(async (key: string) => (redisStrings.delete(key) ? 1 : 0)),
    acquireLock: jest.fn().mockResolvedValue('private-session-migration-lock'),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  };
  const supportRequestsService = {
    createRequest: jest.fn().mockResolvedValue({ id: 'support-request-1' }),
    ...(overrides.supportRequestsService ?? {}),
  };
  const karavanStorefrontAllowlistService = {
    upsert: jest.fn().mockResolvedValue({}),
    ...(overrides.karavanStorefrontAllowlistService ?? {}),
  };
  const prisma = overrides.prisma
    ? {
        $executeRaw: jest.fn().mockResolvedValue(undefined),
        ...overrides.prisma,
      }
    : undefined;

  const service = new PrivateControlService(
    maxClient as never,
    adminService as never,
    adminSettingsService as never,
    manualModerationService as never,
    managedGiveawayService as never,
    redisCounter as never,
    {
      get: jest.fn((key: string) => {
        if (key === 'MAX_BOT_ID') {
          return '777000_bot';
        }
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-token';
        }
        if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
          return undefined;
        }
        if (key === 'APP_BASE_URL') {
          return 'https://major-maksimov.ru';
        }
        return undefined;
      }),
    } as never,
    overrides.maxBotLinkService as never,
    managedBroadcastService as never,
    adminDialogLinkService as never,
    supportRequestsService as never,
    prisma as never,
    overrides.managedEntityHandshakeService as never,
    karavanStorefrontAllowlistService as never,
    overrides.legacyHolds as never,
  );

  return {
    service,
    maxClient,
    adminService,
    manualModerationService,
    adminSettingsService,
    adminDialogLinkService,
    managedBroadcastService,
    managedGiveawayService,
    supportRequestsService,
    karavanStorefrontAllowlistService,
    prisma,
    redisCounter,
    chats,
    channels,
  };
}

function getLastSentText(maxClient: { sendMessage: jest.Mock }): string {
  const call = maxClient.sendMessage.mock.calls.at(-1);
  return call ? String(call[1]) : '';
}

function getLastEditedText(maxClient: { answerCallback: jest.Mock }): string {
  const call = maxClient.answerCallback.mock.calls.at(-1);
  return call?.[2]?.text ? String(call[2].text) : '';
}

function getLastEditedButtons(maxClient: { answerCallback: jest.Mock }) {
  const call = maxClient.answerCallback.mock.calls.at(-1);
  return (call?.[2]?.options?.buttons ?? []) as Array<Array<unknown>>;
}

function getLastUiText(maxClient: { sendMessage: jest.Mock; answerCallback: jest.Mock }): string {
  return getLastSentText(maxClient) || getLastEditedText(maxClient);
}

function getLastButtons(maxClient: { sendMessage: jest.Mock; answerCallback: jest.Mock }) {
  const sendButtons = maxClient.sendMessage.mock.calls.at(-1)?.[2]?.buttons;
  if (sendButtons) {
    return sendButtons as Array<Array<unknown>>;
  }

  const callbackButtons = maxClient.answerCallback.mock.calls.at(-1)?.[2]?.options?.buttons;
  return (callbackButtons ?? []) as Array<Array<unknown>>;
}

function getLastCustomMessagePayload(maxClient: {
  sendCustomMessageImmediateWithResolvedLink: jest.Mock;
}) {
  return (maxClient.sendCustomMessageImmediateWithResolvedLink.mock.calls.at(-1)?.[1] ?? null) as {
    text?: string;
    attachments?: Array<Record<string, unknown>>;
  } | null;
}

function getLastCustomMessageButtons(maxClient: {
  sendCustomMessageImmediateWithResolvedLink: jest.Mock;
}) {
  const attachments = getLastCustomMessagePayload(maxClient)?.attachments ?? [];
  const keyboard = attachments.find((attachment) => attachment?.type === 'inline_keyboard') as
    | {
        payload?: {
          buttons?: Array<Array<unknown>>;
        };
      }
    | undefined;

  return (keyboard?.payload?.buttons ?? []) as Array<Array<unknown>>;
}

function getLastCustomMessageAttachments(maxClient: {
  sendCustomMessageImmediateWithResolvedLink: jest.Mock;
}) {
  return (getLastCustomMessagePayload(maxClient)?.attachments ?? []) as Array<
    Record<string, unknown>
  >;
}

function getLastSendOptions(maxClient: { sendMessage: jest.Mock }) {
  const call = maxClient.sendMessage.mock.calls.at(-1);
  return (call?.[2] ?? null) as Record<string, unknown> | null;
}

function extractStartPayload(url: string): string {
  const parsed = new URL(url);
  return parsed.searchParams.get('start') ?? '';
}

function encodeChannelSuggestionStartPayload(chatId: string, token: string): string {
  return `cds-${chatId}:${token}`;
}

function mockImageFetch(buffer: Buffer = TINY_PNG, mimeType = 'image/png') {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? mimeType : null),
    },
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  });
  const originalFetch = global.fetch;
  Object.defineProperty(global, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchMock,
  });

  return {
    fetchMock,
    restore() {
      Object.defineProperty(global, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    },
  };
}

describe('PrivateControlService', () => {
  it('renders the launcher home for plain text in private dialog', async () => {
    const { service, maxClient, adminService } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('привет'));

    expect(getLastUiText(maxClient)).toContain('**Майор Максимов**');
    expect(getLastUiText(maxClient)).toContain(
      'Настройки модерации чатов и каналов доступны в приложении.',
    );
    expect(getLastUiText(maxClient)).toContain('Посты и автопостинг теперь в боте Публик.');
    expect(
      getLastButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).toEqual(['📱 Приложение', '🆘 Поддержка', 'Сообщить о проблеме', 'Открыть бота Публик']);
    expect(getLastButtons(maxClient).map((row) => row.length)).toEqual([1, 1, 1, 1]);
    expect(adminService.listManagedEntities).not.toHaveBeenCalled();
  });

  it('accepts a problem report from the greeting button and saves it for the admin desk', async () => {
    const { service, maxClient, supportRequestsService } = createHarness();
    const fetchMock = mockImageFetch();

    try {
      await service.handleUpdate(
        createPrivateCallbackUpdate('pc2|support_report', { botId: '888000_bot' }),
      );

      expect(getLastEditedText(maxClient)).toContain('Сообщить о проблеме');
      expect(getLastEditedText(maxClient)).toContain('Опишите проблему одним сообщением');

      await service.handleUpdate(
        createPrivatePhotoUpdate({
          text: 'Не открывается экран настроек',
          botId: '888000_bot',
        }),
      );

      expect(maxClient.uploadImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        'support-request-photo-1.png',
        'image/png',
        { botId: '888000_bot' },
      );
      expect(supportRequestsService.createRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: '888000_bot',
          privateChatId: '152517912',
          userId: 'user-1',
          userName: 'Тестовый пользователь',
          text: 'Не открывается экран настроек',
          attachments: [
            expect.objectContaining({
              type: 'image',
              url: 'https://example.test/broadcast-photo-1.jpg',
              payload: { token: 'upload-token-1' },
            }),
          ],
        }),
      );
      expect(getLastSentText(maxClient)).toContain('Обращение передано');
    } finally {
      fetchMock.restore();
    }
  });

  it('renders the launcher home with female persona copy for the active bot', async () => {
    const { service, maxClient } = createHarness({
      maxBotLinkService: {
        getBotTokenSync: jest.fn().mockReturnValue('test-token'),
        getValidationTokens: jest.fn().mockReturnValue(['test-token']),
        getEntryBotId: jest.fn().mockReturnValue('888000_bot'),
        getContextOrDefaultBotId: jest.fn().mockReturnValue('888000_bot'),
        getResolvedBotSync: jest.fn().mockReturnValue({
          id: '888000_bot',
          characterName: 'Майор Максимова',
          label: 'Майор Максимова',
          speechPersona: 'female',
        }),
        buildMiniappStartUrlSync: jest
          .fn()
          .mockImplementation(
            (startParam: string) =>
              `https://max.ru/888000_bot?startapp=${encodeURIComponent(startParam)}`,
          ),
        buildEntryMiniappStartUrlSync: jest
          .fn()
          .mockImplementation(
            (startParam: string) =>
              `https://max.ru/888000_bot?startapp=${encodeURIComponent(startParam)}`,
          ),
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        resolveContactIdSync: jest.fn().mockReturnValue(null),
      },
    });

    await service.handleUpdate(createPrivateTextUpdate('привет'));

    expect(getLastUiText(maxClient)).toContain('**Майор Максимова**');
    expect(getLastUiText(maxClient)).toContain('Посты и автопостинг теперь в боте Публик.');
  });

  it('shows the one-time launcher intro only on the first plain bot start', async () => {
    const { service, maxClient } = createHarness();

    await service.handleBotStarted(createBotStartedPrivateUpdate(''));

    expect(getLastSentText(maxClient)).toContain('**Майор Максимов на связи.**');
    expect(getLastSentText(maxClient)).toContain(
      'Я помогаю администраторам держать чаты и каналы в порядке: фильтрую спам, опасные ссылки, мат, дубли сообщений и другие нарушения.',
    );
    expect(getLastSentText(maxClient)).not.toContain('розыгрыш');
    expect(getLastSentText(maxClient)).toContain(USER_AGREEMENT_START_NOTICE);
    expect(getLastSendOptions(maxClient)?.textFormat).toBe('markdown');
    expect(getLastSentText(maxClient)).toContain('Если понадобится помощь, техподдержка ниже.');
    expect(
      getLastButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).toEqual(['📱 Приложение', '🆘 Техпомощь', 'Сообщить о проблеме']);
    expect(getLastButtons(maxClient).map((row) => row.length)).toEqual([1, 1, 1]);

    await service.handleBotStarted(createBotStartedPrivateUpdate(''));

    expect(getLastSentText(maxClient)).toContain('**Майор Максимов**');
    expect(getLastSentText(maxClient)).toContain(
      'Настройки модерации чатов и каналов доступны в приложении.',
    );
    expect(getLastSentText(maxClient)).toContain(USER_AGREEMENT_SHORT_NOTICE);
    expect(getLastSentText(maxClient)).not.toContain('Техподдержка ниже.');
  });

  it('renders the one-time launcher intro with Rex third-person copy', async () => {
    const { service, maxClient } = createHarness({
      maxBotLinkService: {
        getBotTokenSync: jest.fn().mockReturnValue('test-token'),
        getValidationTokens: jest.fn().mockReturnValue(['test-token']),
        getEntryBotId: jest.fn().mockReturnValue('999000_bot'),
        getContextOrDefaultBotId: jest.fn().mockReturnValue('999000_bot'),
        getResolvedBotSync: jest.fn().mockReturnValue({
          id: '999000_bot',
          characterName: 'Рэкс',
          label: 'Рэкс',
          speechPersona: 'neutral',
        }),
        buildMiniappStartUrlSync: jest
          .fn()
          .mockImplementation(
            (startParam: string) =>
              `https://max.ru/999000_bot?startapp=${encodeURIComponent(startParam)}`,
          ),
        buildEntryMiniappStartUrlSync: jest
          .fn()
          .mockImplementation(
            (startParam: string) =>
              `https://max.ru/999000_bot?startapp=${encodeURIComponent(startParam)}`,
          ),
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        resolveContactIdSync: jest.fn().mockReturnValue(null),
      },
    });

    await service.handleBotStarted(createBotStartedPrivateUpdate(''));

    expect(getLastSentText(maxClient)).toContain('**Рэкс на посту.**');
    expect(getLastSentText(maxClient)).toContain(
      'Помогает администраторам держать чаты и каналы в порядке: замечает спам, опасные ссылки, мат, дубли сообщений и другие нарушения.',
    );
    expect(getLastSentText(maxClient)).toContain(USER_AGREEMENT_START_NOTICE);
    expect(getLastSentText(maxClient)).not.toContain('Рэкс на связи');
    expect(getLastSentText(maxClient)).not.toContain('Я помогаю');
    expect(getLastSentText(maxClient)).not.toContain('розыгрыш');
  });

  it('fails open when private dialog delivery hits a terminal MAX error', async () => {
    const { service, maxClient, adminService } = createHarness();
    maxClient.sendMessage.mockRejectedValueOnce(
      createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
    );

    await expect(service.handleUpdate(createPrivateTextUpdate('привет'))).resolves.toBeUndefined();

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        immediate: true,
        ignoreFailureMetricStatuses: [403, 404],
        timeoutMs: 2500,
      }),
    );
    expect(adminService.listManagedEntities).not.toHaveBeenCalled();
  });

  it('routes private direct responses through the incoming runtime bot', async () => {
    const { service, maxClient } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('привет', { botId: '888000_bot' }));

    expect(maxClient.sendMessage).toHaveBeenLastCalledWith(
      '152517912',
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        immediate: true,
        botId: '888000_bot',
      }),
    );
  });

  it('keeps private responses on the active bot while opening the mini app through the entry bot', async () => {
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-token']),
      getEntryBotId: jest.fn().mockReturnValue('777000_bot'),
      getContextOrDefaultBotId: jest.fn().mockReturnValue('888000_bot'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || '888000_bot')}?startapp=${encodeURIComponent(startParam)}`,
        ),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string) =>
            `https://max.ru/777000_bot?startapp=${encodeURIComponent(startParam)}`,
        ),
      getResolvedBotSync: jest.fn().mockReturnValue({
        id: '888000_bot',
        characterName: 'Майор Максимов',
        label: 'Майор Максимов',
        speechPersona: 'male',
      }),
      isKnownBotUserId: jest.fn().mockReturnValue(false),
      resolveContactIdSync: jest.fn().mockReturnValue(null),
    };
    const { service, maxClient, adminService } = createHarness({
      maxBotLinkService,
    });

    await service.handleUpdate(createPrivateTextUpdate('привет'));

    expect(getLastUiText(maxClient)).toContain('**Майор Максимов**');
    const buttons = getLastButtons(maxClient).flat();
    expect(buttons).toHaveLength(4);
    expect(buttons[0]).toEqual(
      expect.objectContaining({
        text: '📱 Приложение',
        type: 'link',
        url: expect.stringContaining('https://max.ru/777000_bot?startapp='),
      }),
    );
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    expect(adminService.listManagedEntities).not.toHaveBeenCalled();
  });

  it('keeps entity refresh in mini app instead of opening inline picker', async () => {
    const staleChats = [
      {
        id: '-70000000000001',
        title: 'Тестовый чат 1',
        createdAt: new Date('2026-03-15T17:00:00.000Z').toISOString(),
        entityType: 'chat' as const,
      },
    ];
    const freshChats = [
      ...staleChats,
      {
        id: '-70000000000002',
        title: 'Новый чат',
        createdAt: new Date('2026-03-15T17:05:00.000Z').toISOString(),
        entityType: 'chat' as const,
      },
    ];
    const listManagedEntities = jest
      .fn()
      .mockImplementation(async (_actor, entityType = 'all', options?: { refresh?: boolean }) => {
        if (entityType === 'channel') {
          return [];
        }
        if (entityType === 'chat') {
          return options?.refresh === true ? freshChats : staleChats;
        }
        return options?.refresh === true ? freshChats : staleChats;
      });
    const { service, maxClient } = createHarness({
      adminService: {
        listManagedEntities,
        listChats: jest.fn().mockResolvedValue(freshChats),
      },
    });

    await service.handleUpdate(createPrivateTextUpdate('меню'));

    expect(getLastUiText(maxClient)).toContain(
      'Настройки модерации чатов и каналов доступны в приложении.',
    );

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|chat_refresh'));

    expect(listManagedEntities).not.toHaveBeenCalled();
    expect(getLastEditedText(maxClient)).toContain(
      'Список чатов и каналов обновляется в приложении.',
    );
    const buttonTexts = getLastEditedButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toEqual([
      '📱 Приложение',
      '🆘 Поддержка',
      'Сообщить о проблеме',
      'Открыть бота Публик',
    ]);
  });

  describe('private legacy moderation warning', () => {
    const heldWarning =
      'Автоматическая модерация для некоторых участников этого чата и их глобальная репутация приостановлены до проверки доказательств прежних действий. Восстановление прав ботов не снимает ограничение.';
    const unavailableWarning =
      'Статус ограничений автоматической модерации временно недоступен. Повторите запрос.';

    it('waits for admin authorization before reading or disclosing the selected chat status', async () => {
      let authorize!: () => void;
      let signalAuthStarted!: () => void;
      const authorization = new Promise<void>((resolve) => {
        authorize = resolve;
      });
      const authStarted = new Promise<void>((resolve) => {
        signalAuthStarted = resolve;
      });
      const assertManagedEntityAdminAccess = jest.fn().mockImplementation(async () => {
        signalAuthStarted();
        await authorization;
      });
      const hasChatHolds = jest.fn().mockResolvedValue(true);
      const { service, maxClient, chats } = createHarness({
        adminService: { assertManagedEntityAdminAccess },
        legacyHolds: { hasChatHolds },
      });

      const handling = service.handleUpdate(
        createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`),
      );
      await authStarted;

      try {
        expect(assertManagedEntityAdminAccess).toHaveBeenCalledWith(chats[0].id, 'user-1', 'chat');
        expect(hasChatHolds).not.toHaveBeenCalled();
        expect(maxClient.answerCallback).not.toHaveBeenCalled();
        expect(maxClient.sendMessage).not.toHaveBeenCalled();
      } finally {
        authorize();
        await handling;
      }

      expect(hasChatHolds).toHaveBeenCalledTimes(1);
      expect(hasChatHolds).toHaveBeenCalledWith(chats[0].id);
      expect(getLastEditedText(maxClient)).toContain(heldWarning);
    });

    it.each([
      ['denied', new ForbiddenException('Administrator access denied')],
      ['timeout', new ServiceUnavailableException('Administrator lookup timeout')],
    ])('does not read or disclose hold status after %s authorization', async (_case, error) => {
      const assertManagedEntityAdminAccess = jest.fn().mockRejectedValue(error);
      const hasChatHolds = jest.fn().mockResolvedValue(true);
      const { service, maxClient, chats } = createHarness({
        adminService: { assertManagedEntityAdminAccess },
        legacyHolds: { hasChatHolds },
      });

      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));

      expect(assertManagedEntityAdminAccess).toHaveBeenCalledWith(chats[0].id, 'user-1', 'chat');
      expect(hasChatHolds).not.toHaveBeenCalled();
      expect(getLastUiText(maxClient)).toContain('Что-то пошло не так.');
      expect(getLastUiText(maxClient)).not.toContain(heldWarning);
      expect(getLastUiText(maxClient)).not.toContain(unavailableWarning);
      expect(maxClient.answerCallback).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        '152517912',
        expect.any(String),
        undefined,
        expect.any(Object),
      );
    });

    it('reports an unavailable status without claiming that moderation is unrestricted', async () => {
      const hasChatHolds = jest.fn().mockRejectedValue(new Error('SQL status backend unavailable'));
      const { service, maxClient, adminService, chats } = createHarness({
        legacyHolds: { hasChatHolds },
      });

      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));

      expect(adminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
        chats[0].id,
        'user-1',
        'chat',
      );
      expect(hasChatHolds).toHaveBeenCalledWith(chats[0].id);
      expect(getLastEditedText(maxClient)).toContain(unavailableWarning);
      expect(getLastEditedText(maxClient)).not.toContain(heldWarning);
      expect(getLastEditedText(maxClient)).not.toContain('SQL status backend unavailable');
      expect(getLastEditedText(maxClient)).toContain('Настройки перенесены в mini app');
    });

    it('delivers an advisory warning only to the requesting private dialog after callback fallback', async () => {
      const hasChatHolds = jest.fn().mockResolvedValue(true);
      const { service, maxClient, chats } = createHarness({ legacyHolds: { hasChatHolds } });
      maxClient.answerCallback.mockRejectedValueOnce(new Error('Callback edit unavailable'));

      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));

      expect(getLastSentText(maxClient)).toContain(heldWarning);
      expect(getLastSentText(maxClient)).toContain(
        'Команды этих участников в группе тоже приостановлены. Управление настройками чата через личный диалог бота остаётся доступным.',
      );
      expect(getLastSentText(maxClient)).not.toContain('user-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        '152517912',
        expect.stringContaining(heldWarning),
        expect.any(Object),
        expect.objectContaining({ immediate: true }),
      );
      expect(
        maxClient.answerCallback.mock.calls.every(
          (call) => call[3]?.rateLimitEntityId === '152517912',
        ),
      ).toBe(true);
      expect(maxClient.sendCustomMessageImmediate).not.toHaveBeenCalled();
      expect(maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
    });

    it('omits the advisory when the authorized chat has no holds', async () => {
      const hasChatHolds = jest.fn().mockResolvedValue(false);
      const { service, maxClient, chats } = createHarness({ legacyHolds: { hasChatHolds } });

      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));

      expect(hasChatHolds).toHaveBeenCalledWith(chats[0].id);
      expect(getLastEditedText(maxClient)).toContain('Настройки перенесены в mini app');
      expect(getLastEditedText(maxClient)).not.toContain(heldWarning);
      expect(getLastEditedText(maxClient)).not.toContain(unavailableWarning);
    });

    it('rechecks authorization and status for each explicit selected chat response', async () => {
      const hasChatHolds = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const { service, maxClient, adminService, chats } = createHarness({
        legacyHolds: { hasChatHolds },
      });

      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      expect(getLastEditedText(maxClient)).toContain(heldWarning);
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));

      expect(adminService.assertManagedEntityAdminAccess).toHaveBeenCalledTimes(2);
      expect(hasChatHolds).toHaveBeenCalledTimes(2);
      expect(getLastEditedText(maxClient)).not.toContain(heldWarning);
      expect(getLastEditedText(maxClient)).not.toContain(unavailableWarning);
    });

    it('does not inspect moderation holds for a selected channel', async () => {
      const hasChatHolds = jest.fn().mockResolvedValue(true);
      const { service, maxClient, adminService, channels } = createHarness({
        legacyHolds: { hasChatHolds },
      });

      await service.handleUpdate(
        createPrivateCallbackUpdate(`pc2|chat_select|channel|${channels[0].id}`),
      );

      expect(hasChatHolds).not.toHaveBeenCalled();
      expect(adminService.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
      expect(getLastEditedText(maxClient)).not.toContain(heldWarning);
      expect(getLastEditedText(maxClient)).not.toContain(unavailableWarning);
    });

    it('does not inspect a previously selected chat when returning to the private home', async () => {
      const hasChatHolds = jest.fn().mockResolvedValue(true);
      const { service, maxClient, adminService, chats } = createHarness({
        legacyHolds: { hasChatHolds },
      });
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      hasChatHolds.mockClear();
      adminService.assertManagedEntityAdminAccess.mockClear();

      await service.handleUpdate(createPrivateCallbackUpdate('pc2|home'));

      expect(hasChatHolds).not.toHaveBeenCalled();
      expect(adminService.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
      expect(getLastEditedText(maxClient)).toContain('**Майор Максимов**');
      expect(getLastEditedText(maxClient)).not.toContain(heldWarning);
      expect(getLastEditedText(maxClient)).not.toContain(unavailableWarning);
    });

    it('does not inspect holds for the private activity screen of a selected chat', async () => {
      const hasChatHolds = jest.fn().mockResolvedValue(true);
      const { service, maxClient, adminService, chats } = createHarness({
        legacyHolds: { hasChatHolds },
      });
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      hasChatHolds.mockClear();
      adminService.assertManagedEntityAdminAccess.mockClear();

      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_logs'));

      expect(hasChatHolds).not.toHaveBeenCalled();
      expect(adminService.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
      expect(getLastEditedText(maxClient)).toContain('Активность открывается в mini app');
      expect(getLastEditedText(maxClient)).not.toContain(heldWarning);
      expect(getLastEditedText(maxClient)).not.toContain(unavailableWarning);
    });

    it('does not inspect holds when settings are requested without a selected chat', async () => {
      const hasChatHolds = jest.fn().mockResolvedValue(true);
      const { service, maxClient, adminService } = createHarness({ legacyHolds: { hasChatHolds } });

      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));

      expect(hasChatHolds).not.toHaveBeenCalled();
      expect(adminService.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
      expect(getLastEditedText(maxClient)).not.toContain(heldWarning);
      expect(getLastEditedText(maxClient)).not.toContain(unavailableWarning);
    });

    it('ignores a group callback without reading status or publishing a warning', async () => {
      const hasChatHolds = jest.fn().mockResolvedValue(true);
      const { service, maxClient, adminService, chats } = createHarness({
        legacyHolds: { hasChatHolds },
      });
      const privateUpdate = createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`);
      const groupUpdate: MaxUpdate = {
        ...privateUpdate,
        message: { ...privateUpdate.message!, chatId: chats[0].id },
        raw: {
          update_type: 'message_callback',
          callback: {
            callback_id: 'callback-group',
            payload: `pc2|chat_select|${chats[0].id}`,
            user: { user_id: 'user-1', name: 'Тестовый пользователь' },
          },
          message: { recipient: { chat_id: Number(chats[0].id), chat_type: 'chat' } },
        },
      };

      await service.handleUpdate(groupUpdate);

      expect(hasChatHolds).not.toHaveBeenCalled();
      expect(adminService.assertManagedEntityAdminAccess).not.toHaveBeenCalled();
      expect(maxClient.answerCallback).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.sendCustomMessageImmediate).not.toHaveBeenCalled();
      expect(maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    });
  });

  it('does not expose sticker-from-photo action in the private bot navigation', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('меню'));
    expect(
      getLastButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).not.toContain('Стикер из фото');

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    expect(
      getLastButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).not.toContain('Стикер из фото');
  });

  it('does not hijack a plain photo when no content input is active', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivatePhotoUpdate());

    expect(maxClient.sendCustomMessageImmediate).not.toHaveBeenCalled();
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(getLastUiText(maxClient)).toContain('**Майор Максимов**');
  });

  it('redirects settings callbacks to mini app instead of editing inline', async () => {
    const { service, maxClient, adminService, chats } = createHarness({
      settings: {
        ...defaultSettings,
        greetingEnabled: false,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|toggle|greeting|greetingEnabled'));

    expect(getLastEditedText(maxClient)).toContain('Настройки перенесены в mini app');
    expect(getLastEditedText(maxClient)).toContain('inline-кнопками');
    expect(
      getLastEditedButtons(maxClient)
        .flat()
        .map((button) => String((button as { text?: string }).text ?? '')),
    ).toContain('📱 Открыть в приложении');
    expect(adminService.updateSettings).not.toHaveBeenCalled();
  });

  it('treats /legacy and /modern as aliases for the current interface', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateTextUpdate('/legacy'));
    await service.handleUpdate(createPrivateTextUpdate('/modern'));

    const sentMessages = maxClient.sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentMessages.some((text) => text.includes('**Майор Максимов**'))).toBe(true);
    expect(sentMessages.some((text) => text.includes('классический вид'))).toBe(false);
  });

  it('routes pure forwarded recovery through the durable worker path before private session handling', async () => {
    const managedEntityHandshakeService = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };
    const { service, maxClient, redisCounter } = createHarness({
      managedEntityHandshakeService,
    });
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp: '2026-08-01T10:00:00.000Z',
        message: {
          sender: {
            user_id: 195714583,
            name: 'Тестовый пользователь',
          },
          recipient: {
            chat_id: 152517912,
            chat_type: 'dialog',
          },
          body: null,
          link: {
            type: 'forward',
            chat_id: -70000000000001,
            message: {
              mid: 'mid-forwarded-source-1',
              text: 'Пост из исходного канала',
            },
          },
        },
      },
      { botId: '777000_bot' },
    );

    await expect(service.handleUpdate(update)).resolves.toBeUndefined();

    expect(update.message?.messageId).toBe(`message_created:${update.updateId}`);
    expect(managedEntityHandshakeService.handleWebhookUpdate).toHaveBeenCalledWith(update);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendCustomMessageImmediate).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(redisCounter.getString).toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
    expect(redisCounter.deleteKey).not.toHaveBeenCalled();
    expect(redisCounter.acquireLock).toHaveBeenCalled();
    expect(redisCounter.releaseLock).toHaveBeenCalled();
  });

  it('fails open to forwarded entity recovery when private session loading fails', async () => {
    const managedEntityHandshakeService = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };
    const { service, maxClient, redisCounter } = createHarness({
      managedEntityHandshakeService,
    });
    redisCounter.getString.mockRejectedValue(new Error('redis unavailable'));
    const update = createPrivatePureForwardUpdate({ text: 'Пост из исходного канала' });

    await expect(service.handleUpdate(update)).resolves.toBeUndefined();

    expect(managedEntityHandshakeService.handleWebhookUpdate).toHaveBeenCalledWith(update);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('bounds private session loading before forwarded entity recovery', async () => {
    jest.useFakeTimers();
    try {
      const managedEntityHandshakeService = {
        handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
      };
      const { service, maxClient, redisCounter } = createHarness({
        managedEntityHandshakeService,
      });
      redisCounter.getString.mockImplementation(() => new Promise(() => undefined));
      const update = createPrivatePureForwardUpdate({ text: 'Пост из исходного канала' });

      const handling = service.handleUpdate(update);
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(handling).resolves.toBeUndefined();

      expect(managedEntityHandshakeService.handleWebhookUpdate).toHaveBeenCalledWith(update);
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bans a forwarded sender from private chat with the permanent ban command', async () => {
    const { service, manualModerationService, maxClient, chats } = createHarness({
      settings: {
        ...defaultSettings,
        muteDurationHours: 12,
      },
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate());

    expect(manualModerationService.applyManualSystemBan).toHaveBeenCalledWith(
      chats[0].id,
      'user-77',
      expect.objectContaining({
        userId: 'user-1',
        chatId: '152517912',
      }),
      'private_command',
    );
    expect(manualModerationService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Бан включён для: Нарушитель (user-77)');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
  });

  it('binds a forwarded rules message from private chat to moderation buttons', async () => {
    const { service, manualModerationService, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateForwardedRulesUpdate());

    expect(manualModerationService.adoptChatRulesFromMessage).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({
        userId: 'user-1',
        chatId: '152517912',
      }),
      {
        sourceMessageId: 'mid-rules-source-1',
        sourceMessageUrl: null,
        text: '1. Без спама.\n2. Без ссылок.',
      },
      'private_command',
    );
    expect(getLastSentText(maxClient)).toContain('Правила привязаны к сообщению.');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Кнопка «Правила» в нарушениях включена.');
  });

  it('mutes a forwarded sender from private chat for 6 hours by default', async () => {
    const { service, manualModerationService, maxClient, chats } = createHarness();
    manualModerationService.applyManualModerationAction.mockResolvedValueOnce({
      ok: true,
      action: 'MUTE',
      userId: 'user-77',
      muteDurationHours: 6,
      muteExpiresAt: '2026-03-26T12:00:00.000Z',
      message: 'Мут включён на 6 ч.',
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate('мут'));

    expect(manualModerationService.applyManualModerationAction).toHaveBeenCalledWith(
      chats[0].id,
      'user-77',
      expect.objectContaining({
        userId: 'user-1',
        chatId: '152517912',
      }),
      {
        action: 'MUTE',
        muteDurationHours: 6,
      },
      'private_command',
    );
    expect(manualModerationService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Мут включён на 6 ч.');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Участник: Нарушитель (user-77)');
  });

  it('mutes a forwarded sender from private chat for the requested number of hours', async () => {
    const { service, manualModerationService, maxClient, chats } = createHarness();
    manualModerationService.applyManualModerationAction.mockResolvedValueOnce({
      ok: true,
      action: 'MUTE',
      userId: 'user-77',
      muteDurationHours: 12,
      muteExpiresAt: '2026-03-26T18:00:00.000Z',
      message: 'Мут включён на 12 ч.',
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate('мут 12'));

    expect(manualModerationService.applyManualModerationAction).toHaveBeenCalledWith(
      chats[0].id,
      'user-77',
      expect.objectContaining({
        userId: 'user-1',
        chatId: '152517912',
      }),
      {
        action: 'MUTE',
        muteDurationHours: 12,
      },
      'private_command',
    );
    expect(manualModerationService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Мут включён на 12 ч.');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Участник: Нарушитель (user-77)');
  });

  it('treats private forwarded mute command duration 88 as a permanent mute', async () => {
    const { service, manualModerationService, maxClient, chats } = createHarness();
    manualModerationService.applyManualModerationAction.mockResolvedValueOnce({
      ok: true,
      action: 'MUTE',
      userId: 'user-77',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Мут включён без срока.',
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate('мут 88'));

    expect(manualModerationService.applyManualModerationAction).toHaveBeenCalledWith(
      chats[0].id,
      'user-77',
      expect.objectContaining({
        userId: 'user-1',
        chatId: '152517912',
      }),
      {
        action: 'MUTE',
        mutePermanent: true,
      },
      'private_command',
    );
    expect(manualModerationService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Мут включён без срока.');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain('Участник: Нарушитель (user-77)');
  });

  it('rejects explicit duration in the forwarded ban command', async () => {
    const { service, manualModerationService, maxClient } = createHarness({
      settings: {
        ...defaultSettings,
        muteDurationHours: 6,
      },
    });

    await service.handleUpdate(createPrivateForwardedModerationUpdate('бан 24'));

    expect(manualModerationService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain(
      'Команда «бан» применяется без срока. Отправьте её без длительности.',
    );
  });

  it('handles stale legacy callback payload and refreshes current screen', async () => {
    const { service, maxClient } = createHarness();

    await service.handleUpdate(
      createPrivateCallbackUpdate('private_menu:chats', { botId: '888000_bot' }),
    );

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      expect.stringContaining('Кнопки устарели'),
      expect.objectContaining({
        text: expect.any(String),
      }),
      expect.objectContaining({
        ignoreFailureMetricStatuses: [400, 404],
        timeoutMs: 1500,
        botId: '888000_bot',
      }),
    );
  });

  it('acknowledges slow private callbacks and continues them in background', async () => {
    const { service, maxClient } = createHarness();

    (
      service as unknown as { privateCallbackInlineBudgetMs: number }
    ).privateCallbackInlineBudgetMs = 1;
    maxClient.answerCallback
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockResolvedValueOnce(undefined);

    await service.handleUpdate(
      createPrivateCallbackUpdate('private_menu:chats', { botId: '888000_bot' }),
    );

    expect(maxClient.answerCallback).toHaveBeenCalledTimes(2);
    expect(maxClient.answerCallback).toHaveBeenNthCalledWith(
      2,
      'callback-1',
      'Обрабатываю команду...',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        timeoutMs: 800,
        botId: '888000_bot',
        rateLimitEntityId: '152517912',
      },
    );
  });

  it('redirects stale numeric settings callbacks to mini app', async () => {
    const { service, maxClient, adminService, chats } = createHarness({
      settings: {
        ...defaultSettings,
        duplicateWarnMaxCount: 2,
        muteDurationHours: 6,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|duplicates'));
    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|set_number_preset|duplicates|duplicateWarnMaxCount|5'),
    );
    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|step_number|duplicates|muteDurationHours|1'),
    );

    expect(getLastEditedText(maxClient)).toContain('Настройки перенесены в mini app');
    expect(adminService.updateSettings).not.toHaveBeenCalled();
  });

  it('redirects search callbacks to mini app', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_search'));

    expect(getLastEditedText(maxClient)).toContain('Настройки перенесены в mini app');
    expect(getLastEditedText(maxClient)).toContain('rich-сценарии');
  });

  it('opens the rules screen from chat home', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Соблюдайте **правила** чата.',
        autoTextEnabled: true,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    const sentBeforeOpenRules = maxClient.sendMessage.mock.calls.length;
    const callbackAnswersBeforeOpenRules = maxClient.answerCallback.mock.calls.length;
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(sentBeforeOpenRules + 1);
    expect(maxClient.answerCallback).toHaveBeenCalledTimes(callbackAnswersBeforeOpenRules + 1);
    expect(maxClient.answerCallback.mock.calls.at(-1)?.[2]).toBeUndefined();
    expect(maxClient.answerCallback.mock.calls.at(-1)?.[3]).toEqual({
      ignoreFailureMetricStatuses: [400, 404],
      timeoutMs: 800,
      rateLimitEntityId: '152517912',
    });

    expect(getLastUiText(maxClient)).toContain('Правила');
    expect(getLastUiText(maxClient)).toContain('Соблюдайте **правила** чата.');
    expect(getLastUiText(maxClient)).not.toContain(
      'Здесь меняется только текст и фото. Кнопки поста и кнопка «Правила» остаются в mini app.',
    );

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('Собрать из настроек 🤖');
    expect(buttonTexts).toContain('✏️ Изменить текст');
    expect(buttonTexts).toContain('✍️ Добавить фото');
    expect(buttonTexts).toContain('🚀 Опубликовать');
    expect(buttonTexts.some((text) => text.startsWith('📱 В прилож'))).toBe(true);
    expect(buttonTexts).not.toContain('Сбросить публикацию');
    expect(buttonTexts).not.toContain('✅ Кнопка "Правила" в нарушениях');
    expect(buttonTexts).not.toContain('↩️ Назад');
    expect(getLastSendOptions(maxClient)?.textFormat).toBe('markdown');

    const miniappButton = getLastButtons(maxClient)
      .flat()
      .find((button) =>
        String((button as { text?: string }).text ?? '').startsWith('📱 В прилож'),
      ) as
      | {
          type?: string;
          url?: string;
        }
      | undefined;

    expect(miniappButton).toMatchObject({
      type: 'link',
    });
    expect(String(miniappButton?.url ?? '')).toContain('https://max.ru/777000_bot?startapp=');
    expect(decodeStartAppRoute(String(miniappButton?.url ?? ''))).toBe(
      `/chat/${encodeURIComponent(chats[0].id)}/settings?focus=rules&handoff=1`,
    );
  });

  it('shows stored manual rules text in bot when autofill is disabled', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Старый текст правил.',
        autoTextEnabled: false,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));

    expect(getLastUiText(maxClient)).toContain('Правила');
    expect(getLastUiText(maxClient)).toContain('Старый текст правил.');

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('Собрать из настроек 🤖');
    expect(buttonTexts).toContain('✏️ Изменить текст');
  });

  it('shows the assemble-from-settings button when rules text is empty', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: '',
        autoTextEnabled: false,
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('Собрать из настроек 🤖');
  });

  it('builds rules text from current settings in the private bot', async () => {
    const generatedSettings = {
      ...chatSettingsSchema.parse({
        linkPolicy: 'BLOCKLIST_ONLY',
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
        russianProfanityFilterEnabled: true,
        maxMessageLengthEnabled: true,
        maxMessageLength: 500,
        messageLimitsBlockedWords: ['спам', 'капс'],
        photoMessagesEnabled: false,
        videoMessagesEnabled: false,
        phoneNumbersEnabled: false,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeTimezone: 'Europe/Moscow',
      }),
      thematicCodewordEnabled: true,
      thematicCodeword: 'Секрет',
      thematicFiltersWarnEnabled: true,
      thematicFiltersMuteEnabled: true,
      thematicFiltersBanEnabled: true,
    };
    const { service, adminSettingsService, maxClient, chats } = createHarness({
      settings: generatedSettings,
      rules: createRules({
        text: 'Текущий текст правил.',
        autoTextEnabled: false,
        imageBase64: TINY_PNG.toString('base64'),
        imageMimeType: 'image/png',
        imageFileName: 'rules.png',
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/help',
        buttonText: 'Подробнее',
        adminContactButtonEnabled: true,
        adminContactButtonUrl: 'https://max.ru/admin',
      }),
      adminService: {
        getChatSettingsScreen: jest.fn().mockResolvedValue({
          settings: generatedSettings,
          rules: createRules({
            text: 'Текущий текст правил.',
            autoTextEnabled: false,
            imageBase64: TINY_PNG.toString('base64'),
            imageMimeType: 'image/png',
            imageFileName: 'rules.png',
            buttonEnabled: true,
            buttonUrl: 'https://max.ru/help',
            buttonText: 'Подробнее',
            adminContactButtonEnabled: true,
            adminContactButtonUrl: 'https://max.ru/admin',
          }),
          header: { id: '-70000000000001', title: 'Тестовый чат 1' },
          requiredSubscriptionChannels: [
            {
              id: 'channel-1',
              title: 'Новости MAX',
              createdAt: new Date().toISOString(),
              entityType: 'channel',
            },
            {
              id: 'channel-2',
              title: 'Клуб MAX',
              createdAt: new Date().toISOString(),
              entityType: 'channel',
            },
          ],
          domains: [],
          managedBroadcasts: [],
        }),
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_autofill'));

    const updatePayload = adminSettingsService.updateRules.mock.calls.at(-1)?.[2];
    expect(updatePayload).toMatchObject({
      imageMimeType: 'image/png',
      imageFileName: 'rules.png',
      autoTextEnabled: true,
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/help',
      buttonText: 'Подробнее',
      adminContactButtonEnabled: true,
      adminContactButtonUrl: 'https://max.ru/admin',
    });
    expect(String(updatePayload?.text ?? '')).toContain('Правила чата:');
    expect(String(updatePayload?.text ?? '')).toContain(
      'Пожалуйста, не отправляйте ссылки: бот их удаляет.',
    );
    expect(String(updatePayload?.text ?? '')).toContain(
      'Чтобы писать в чат, сначала подпишитесь на: Новости MAX, Клуб MAX.',
    );
    expect(String(updatePayload?.text ?? '')).toContain('Пожалуйста, без мата и грубой лексики.');
    expect(String(updatePayload?.text ?? '')).toContain(
      'Старайтесь писать короче: до 500 символов в одном сообщении.',
    );
    expect(String(updatePayload?.text ?? '')).not.toContain('спам, капс');
    expect(String(updatePayload?.text ?? '')).toContain('Фото сюда отправлять нельзя.');
    expect(String(updatePayload?.text ?? '')).toContain('Видео сюда отправлять нельзя.');
    expect(String(updatePayload?.text ?? '')).toContain(
      'Ночью чат работает тише: ограничения действуют с 23:00 до 08:00.',
    );
    expect(String(updatePayload?.text ?? '')).not.toContain('Europe/Moscow');
    expect(String(updatePayload?.text ?? '')).not.toContain('Секрет');
    expect(getLastUiText(maxClient)).toContain(
      'Пожалуйста, не отправляйте ссылки: бот их удаляет.',
    );
    expect(String(updatePayload?.text ?? '')).toContain(
      'Телефонные номера в сообщениях запрещены.',
    );
    expect(getLastUiText(maxClient)).toContain('Текст собран из текущих настроек.');
  });

  it.each([
    ['OBSERVE', false],
    ['DELETE_ONLY', false],
    ['FULL', true],
  ] as const)(
    'keeps private rules duplicate wording aligned with %s photo policy',
    async (duplicatePhotoModerationMode, expectPhoto) => {
      const generatedSettings = chatSettingsSchema.parse({
        antiDuplicateEnabled: true,
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnoreLinksEnabled: true,
        duplicatePhotoEnabled: true,
        duplicateWarnEnabled: true,
      });
      const rules = createRules();
      const { service, adminSettingsService, chats } = createHarness({
        settings: generatedSettings,
        rules,
        adminService: {
          getChatSettingsScreen: jest.fn().mockResolvedValue({
            settings: generatedSettings,
            rules,
            duplicatePhotoModerationMode,
            header: { id: '-70000000000001', title: 'Тестовый чат 1' },
            requiredSubscriptionChannels: [],
            domains: [],
            managedBroadcasts: [],
          }),
        },
      });

      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_autofill'));

      const text = String(adminSettingsService.updateRules.mock.calls.at(-1)?.[2]?.text ?? '');
      expect(text).toContain('одинаковые сообщения');
      expect(text).toContain('одни и те же ссылки');
      expect(text.includes('Одинаковые картинки')).toBe(expectPhoto);
    },
  );

  it.each(duplicateRulesCases)('private rules parity: $name', async (fixture) => {
    const settings = chatSettingsSchema.parse(fixture.settings);
    const rules = createRules({ text: 'Правила администратора', autoTextEnabled: false });
    const { service, adminSettingsService, chats } = createHarness({
      settings,
      rules,
      adminService: {
        getChatSettingsScreen: jest.fn().mockResolvedValue({
          settings,
          rules,
          duplicatePhotoModerationMode: fixture.photoMode,
          header: { id: '-70000000000001', title: 'Тестовый чат' },
          requiredSubscriptionChannels: [],
          domains: [],
          managedBroadcasts: [],
        }),
      },
    });
    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    expect(adminSettingsService.updateRules).not.toHaveBeenCalled();
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_autofill'));
    const payload = adminSettingsService.updateRules.mock.calls.at(-1)?.[2];
    expect(payload.autoTextEnabled).toBe(true);
    expect(
      String(payload.text)
        .split('\n')
        .map((line) => line.replace(/^\d+\. /u, ''))
        .filter((line) =>
          /^(Повторы учитываются |Антидубль |Не отправляйте |Одинаковые картинки)/u.test(line),
        ),
    ).toEqual(fixture.expected);
  });

  it('builds rules text for alert-only links and anti-spam defaults in the private bot', async () => {
    const generatedSettings = chatSettingsSchema.parse({
      linkPolicy: 'ALERT_ONLY',
      antiSpamEnabled: true,
      antiDuplicateEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      russianProfanityFilterEnabled: false,
      commercialAdsFilterEnabled: false,
      messageCountLimitEnabled: false,
      maxMessageLengthEnabled: false,
      photoMessageCooldownEnabled: false,
      stickerMessageCooldownEnabled: false,
      videoMessagesEnabled: true,
      fileMessagesEnabled: true,
      voiceMessagesEnabled: true,
      nightModeEnabled: false,
    });
    const { service, adminSettingsService, chats } = createHarness({
      settings: generatedSettings,
      rules: createRules({
        text: '',
        autoTextEnabled: false,
      }),
      adminService: {
        getChatSettingsScreen: jest.fn().mockResolvedValue({
          settings: generatedSettings,
          rules: createRules({
            text: '',
            autoTextEnabled: false,
          }),
          header: { id: '-70000000000001', title: 'Тестовый чат 1' },
          requiredSubscriptionChannels: [],
          domains: [],
          managedBroadcasts: [],
        }),
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_autofill'));

    const updatePayload = adminSettingsService.updateRules.mock.calls.at(-1)?.[2];
    expect(String(updatePayload?.text ?? '')).toContain(
      'Ссылки бот проверяет, но не удаляет автоматически.',
    );
    expect(String(updatePayload?.text ?? '')).toContain('Пожалуйста, не флудите и не спамьте.');
    expect(String(updatePayload?.text ?? '')).not.toContain('За повторные нарушения бот может');
  });

  describe('private rules autofill generation boundaries', () => {
    type SettingsScreen = Awaited<ReturnType<AdminService['getChatSettingsScreen']>>;

    function createSettingsScreen(
      settings: SettingsScreen['settings'],
      channelTitle?: string,
    ): SettingsScreen {
      return chatSettingsScreenResponseSchema.parse({
        settings,
        rules: createRules({ text: 'Сохранённые правила.' }),
        header: {
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          entityType: 'chat',
          link: null,
          participantsCount: null,
        },
        requiredSubscriptionChannels:
          channelTitle === undefined
            ? []
            : [
                {
                  id: 'channel-1',
                  title: channelTitle,
                  entityType: 'channel',
                  link: null,
                  participantsCount: null,
                },
              ],
        domains: [],
      });
    }

    async function prepareAutofill(screen: SettingsScreen) {
      const getChatSettingsScreen: jest.MockedFunction<AdminService['getChatSettingsScreen']> =
        jest.fn();
      getChatSettingsScreen.mockResolvedValue(screen);
      const harness = createHarness({
        settings: screen.settings,
        rules: screen.rules,
        adminService: { getChatSettingsScreen },
      });

      await harness.service.handleUpdate(
        createPrivateCallbackUpdate(`pc2|chat_select|${harness.chats[0].id}`),
      );
      await harness.service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
      getChatSettingsScreen.mockClear();
      harness.adminSettingsService.updateRules.mockClear();
      harness.adminService.publishRules.mockClear();
      harness.maxClient.sendMessage.mockClear();
      harness.maxClient.answerCallback.mockClear();

      return { ...harness, getChatSettingsScreen };
    }

    it('rejects private rules autofill with no items from a malformed settings response', async () => {
      const screen = createSettingsScreen(chatSettingsSchema.parse({}));
      // Valid link policies always yield an item; only this malformed upstream fixture omits it.
      Reflect.deleteProperty(screen.settings, 'linkPolicy');
      const { service, adminSettingsService, adminService, maxClient, getChatSettingsScreen } =
        await prepareAutofill(screen);

      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_autofill'));

      expect(getChatSettingsScreen).toHaveBeenCalledTimes(1);
      expect(adminSettingsService.updateRules).not.toHaveBeenCalled();
      expect(adminService.publishRules).not.toHaveBeenCalled();
      expect(getLastSentText(maxClient)).toBe(
        'Нет активных настроек, из которых можно собрать правила.',
      );
    });

    it('rejects an oversized first private rules item from a malformed settings response', async () => {
      const screen = createSettingsScreen(
        chatSettingsSchema.parse({
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
          antiSpamEnabled: true,
        }),
        'Я'.repeat(MAX_CHAT_RULES_TEXT_LENGTH),
      );
      // Missing upstream policy makes subscription the first item, before a later short spam rule.
      Reflect.deleteProperty(screen.settings, 'linkPolicy');
      const { service, adminSettingsService, adminService, maxClient, getChatSettingsScreen } =
        await prepareAutofill(screen);

      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_autofill'));

      expect(getChatSettingsScreen).toHaveBeenCalledTimes(1);
      expect(adminSettingsService.updateRules).not.toHaveBeenCalled();
      expect(adminService.publishRules).not.toHaveBeenCalled();
      expect(getLastSentText(maxClient)).toBe(
        'Не удалось собрать короткий текст правил из текущих настроек.',
      );
    });

    it.each([false, true])(
      'keeps exactly 4000 UTF-16 units in private rules autofill (trailing item: %s)',
      async (antiSpamEnabled) => {
        const prefix =
          'Правила чата:\n\n1. Ссылки бот проверяет, но не удаляет автоматически.\n2. Чтобы писать в чат, сначала подпишитесь на: ';
        const suffix = '.';
        const emoji = '😀';
        const title =
          emoji +
          'Я'.repeat(MAX_CHAT_RULES_TEXT_LENGTH - prefix.length - suffix.length - emoji.length);
        const expectedText = `${prefix}${title}${suffix}`;
        const screen = createSettingsScreen(
          chatSettingsSchema.parse({
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['channel-1'],
            antiSpamEnabled,
          }),
          title,
        );
        const { service, chats, adminSettingsService, adminService, getChatSettingsScreen } =
          await prepareAutofill(screen);

        await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_autofill'));

        expect(expectedText).toHaveLength(MAX_CHAT_RULES_TEXT_LENGTH);
        expect(Array.from(expectedText)).toHaveLength(MAX_CHAT_RULES_TEXT_LENGTH - 1);
        expect(getChatSettingsScreen).toHaveBeenCalledTimes(1);
        expect(adminSettingsService.updateRules).toHaveBeenCalledTimes(1);
        expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
          chats[0].id,
          expect.objectContaining({ userId: 'user-1' }),
          expect.objectContaining({
            text: expectedText,
            textFormat: 'plain',
            autoTextEnabled: true,
          }),
          'private_bot',
        );
        expect(getChatSettingsScreen.mock.invocationCallOrder[0]).toBeLessThan(
          adminSettingsService.updateRules.mock.invocationCallOrder[0],
        );
        expect(adminService.publishRules).not.toHaveBeenCalled();
      },
    );
  });

  it('hands off chat rules from miniapp into private bot rules flow', async () => {
    const { service, adminSettingsService, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Правила из handoff.',
        autoTextEnabled: true,
      }),
    });
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    const result = await service.handoffRulesFromMiniapp(chats[0].id, actor);
    expect(result.botUrl).toBe('https://max.ru/777000_bot?start=rules_handoff');

    await service.handleBotStarted(createBotStartedPrivateUpdate('rules_handoff'));

    expect(getLastSentText(maxClient)).toContain('Правила');
    expect(getLastSentText(maxClient)).toContain('Правила из handoff.');
    expect(getLastSentText(maxClient)).toContain('Отправьте новый текст одним сообщением.');

    await service.handleUpdate(createPrivateTextUpdate('Новая версия из handoff'));

    expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Новая версия из handoff',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
  });

  it.each(
    (['rules', 'giveaway', 'profile'] as const).flatMap((flow) =>
      (['fresh', 'migrated', 'known'] as const).map((route) => ({ flow, route })),
    ),
  )(
    'keeps a $flow handoff in the launch bot for a $route private route',
    async ({ flow, route }) => {
      const botId = '888000_bot';
      const tokenA = 'token-a';
      const tokenB = 'token-b';
      const maxBotLinkService = {
        getBotTokenSync: jest.fn((id?: string | null) => (id === botId ? tokenB : tokenA)),
        getValidationTokens: jest.fn(() => [tokenA, tokenB]),
        isKnownBotUserId: jest.fn().mockReturnValue(false),
        getContextOrDefaultBotId: jest.fn().mockReturnValue(botId),
        getResolvedBotSync: jest.fn().mockReturnValue({
          id: botId,
          characterName: 'Майор Максимов',
          speechPersona: 'male',
        }),
        resolveContactIdSync: jest.fn().mockReturnValue(null),
        buildBotStartUrlSync: jest.fn(
          (payload: string, id?: string | null) =>
            `https://max.ru/${id || '777000_bot'}?start=${encodeURIComponent(payload)}`,
        ),
      };
      const { service, maxClient, redisCounter, adminSettingsService, chats } = createHarness({
        maxBotLinkService,
      });
      const actor = {
        userId: 'user-1',
        launchBotId: botId,
        username: null,
        displayName: 'Тестовый пользователь',
      };
      if (route === 'migrated') {
        const legacy = createDefaultPrivateControlSession();
        legacy.lastPrivateChatId = '252517912';
        legacy.lastPrivateBotId = '777000_bot';
        legacy.lastRulesHandoffDeliveredChatId = '252517912';
        legacy.lastRulesHandoffDeliveredAt = Date.now();
        await redisCounter.setStringWithTtl('private-ui:v2:user-1', JSON.stringify(legacy));
      } else if (route === 'known') {
        await service.handleBotStarted(createBotStartedPrivateUpdate('', { botId }));
        maxClient.sendMessage.mockClear();
      }

      const result =
        flow === 'rules'
          ? await service.handoffRulesFromMiniapp(chats[0].id, actor)
          : flow === 'giveaway'
            ? await service.handoffGiveawayFromMiniapp(
                chats[0].id,
                actor,
                { giveawayId: 'giveaway-1' },
                'chat',
              )
            : await service.handoffProfileMentionFromMiniapp(
                chats[0].id,
                actor,
                '42',
                { displayName: 'Юлия' },
                'chat',
              );
      const payload = extractStartPayload(result.botUrl);
      expect(new URL(result.botUrl).pathname).toBe(`/${botId}`);
      if (flow === 'giveaway') {
        expect(parseCompactGiveawayHandoffStartPayload(payload, [tokenB])).toEqual({
          chatId: chats[0].id,
          entityType: 'chat',
          giveawayId: 'giveaway-1',
        });
        expect(parseCompactGiveawayHandoffStartPayload(payload, [tokenA])).toBeNull();
      } else if (flow === 'profile') {
        expect(parseCompactProfileMentionStartPayload(payload, [tokenB])).toEqual({
          chatId: chats[0].id,
          entityType: 'chat',
          userId: '42',
        });
        expect(parseCompactProfileMentionStartPayload(payload, [tokenA])).toBeNull();
      } else {
        expect(payload).toBe('rules_handoff');
      }
      if (route !== 'known') expect(maxClient.sendMessage).not.toHaveBeenCalled();
      const persisted = JSON.parse(
        (await redisCounter.getString('private-ui:v2:888000_bot:user-1'))!,
      );
      if (flow === 'rules') expect(persisted.pendingInput).toEqual({ kind: 'rules_text' });
      if (flow === 'giveaway') expect(persisted.managedGiveawayId).toBe('giveaway-1');
      if (flow === 'profile') expect(persisted.pendingProfileMentionUserId).toBe('42');
      if (route === 'migrated') {
        expect(persisted.lastPrivateChatId).toBeNull();
        expect(persisted.lastRulesHandoffDeliveredChatId).toBeNull();
      }

      await service.handleBotStarted(createBotStartedPrivateUpdate(payload, { botId }));
      expect(maxClient.sendMessage.mock.calls).not.toHaveLength(0);
      expect(maxClient.sendMessage.mock.calls.every(([chatId]) => chatId === '152517912')).toBe(
        true,
      );
      expect(maxClient.sendMessage.mock.calls.every((call) => call[3]?.botId === botId)).toBe(true);
      if (flow === 'rules') {
        await service.handleUpdate(createPrivateTextUpdate('Правила через бота B', { botId }));
        expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
          chats[0].id,
          expect.objectContaining({ userId: actor.userId }),
          expect.objectContaining({ text: 'Правила через бота B' }),
          'private_bot',
        );
      }
    },
  );

  it('uses a forwarded formatted post for an active rules editor before entity recovery', async () => {
    const managedEntityHandshakeService = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };
    const { service, adminSettingsService, chats } = createHarness({
      managedEntityHandshakeService,
      rules: createRules({
        adminContactButtonEnabled: true,
        adminContactButtonUrl: 'https://max.ru/admin',
      }),
    });
    const actor = {
      userId: '195714583',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: '152517912',
      chatTitle: 'Личный чат',
      launchBotId: '777000_bot',
    };
    await service.handoffRulesFromMiniapp(chats[0].id, actor);

    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp: '2026-08-30T10:00:00.000Z',
        message: {
          sender: { user_id: 195714583, name: 'Тестовый пользователь' },
          recipient: { chat_id: 152517912, chat_type: 'dialog' },
          body: null,
          link: {
            type: 'forward',
            chat_id: -70000000000001,
            message: {
              mid: 'mid-formatted-rules-source-1',
              text: '🔥MAX Docs',
              markup: [
                { type: 'strong', from: 2, length: 8 },
                {
                  type: 'link',
                  from: 2,
                  length: 8,
                  url: 'https://dev.max.ru/docs-api',
                },
              ],
            },
          },
        },
      },
      { botId: '777000_bot' },
    );

    await service.handleUpdate(update);

    expect(managedEntityHandshakeService.handleWebhookUpdate).not.toHaveBeenCalled();
    expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: '195714583' }),
      expect.objectContaining({
        text: '🔥[**MAX Docs**](https://dev.max.ru/docs-api)',
        autoTextEnabled: false,
        adminContactButtonEnabled: true,
        adminContactButtonUrl: 'https://max.ru/admin',
      }),
      'private_bot',
    );
  });

  it('imports forwarded MAX markup for an active bot-speech text setting', async () => {
    const managedEntityHandshakeService = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };
    const { service, adminService, redisCounter, chats } = createHarness({
      managedEntityHandshakeService,
    });
    const session = createDefaultPrivateControlSession();
    session.selectedChatId = chats[0].id;
    session.selectedEntityType = 'chat';
    session.screen = 'section';
    session.section = 'greeting';
    session.pendingInput = {
      kind: 'set_field',
      section: 'greeting',
      key: 'greetingBotMessageText',
      type: 'text',
    };
    await redisCounter.setStringWithTtl('private-ui:v2:195714583', JSON.stringify(session));
    const update = createPrivatePureForwardUpdate({
      text: '🔥MAX Docs',
      markup: [
        { type: 'strong', from: 2, length: 8 },
        {
          type: 'link',
          from: 2,
          length: 8,
          url: 'https://dev.max.ru/docs-api',
        },
      ],
    });

    await service.handleUpdate(update);

    expect(managedEntityHandshakeService.handleWebhookUpdate).not.toHaveBeenCalled();
    expect(adminService.updateSettings).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: '195714583' }),
      expect.objectContaining({
        greetingBotMessageText: '🔥[**MAX Docs**](https://dev.max.ru/docs-api)',
      }),
      'private_bot',
    );
  });

  it('falls back to visible bot-speech text when imported markup exceeds the contract limit', async () => {
    const managedEntityHandshakeService = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };
    const { service, adminService, redisCounter, chats } = createHarness({
      managedEntityHandshakeService,
    });
    const session = createDefaultPrivateControlSession();
    session.selectedChatId = chats[0].id;
    session.selectedEntityType = 'chat';
    session.screen = 'section';
    session.section = 'greeting';
    session.pendingInput = {
      kind: 'set_field',
      section: 'greeting',
      key: 'greetingBotMessageText',
      type: 'text',
    };
    await redisCounter.setStringWithTtl('private-ui:v2:195714583', JSON.stringify(session));
    const sourceText = 'A'.repeat(MAX_BOT_SPEECH_TEXT_LENGTH);
    const update = createPrivatePureForwardUpdate({
      text: sourceText,
      markup: [{ type: 'strong', from: 0, length: sourceText.length }],
    });

    await service.handleUpdate(update);

    expect(managedEntityHandshakeService.handleWebhookUpdate).not.toHaveBeenCalled();
    expect(adminService.updateSettings).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: '195714583' }),
      expect.objectContaining({ greetingBotMessageText: sourceText }),
      'private_bot',
    );
  });

  it.each([
    {
      name: 'a non bot-speech text field',
      screen: 'section' as const,
      key: 'greetingBotButtonText' as const,
    },
    {
      name: 'a stale bot-speech editor screen',
      screen: 'home' as const,
      key: 'greetingBotMessageText' as const,
    },
  ])('keeps forwarded recovery priority for $name', async ({ screen, key }) => {
    const managedEntityHandshakeService = {
      handleWebhookUpdate: jest.fn().mockResolvedValue('connected'),
    };
    const { service, adminService, redisCounter, chats } = createHarness({
      managedEntityHandshakeService,
    });
    const session = createDefaultPrivateControlSession();
    session.selectedChatId = chats[0].id;
    session.selectedEntityType = 'chat';
    session.screen = screen;
    session.section = 'greeting';
    session.pendingInput = {
      kind: 'set_field',
      section: 'greeting',
      key,
      type: 'text',
    };
    await redisCounter.setStringWithTtl('private-ui:v2:195714583', JSON.stringify(session));
    const update = createPrivatePureForwardUpdate({
      text: 'Форматированный текст',
      markup: [{ type: 'strong', from: 0, length: 21 }],
    });

    await service.handleUpdate(update);

    expect(managedEntityHandshakeService.handleWebhookUpdate).toHaveBeenCalledWith(update);
    expect(adminService.updateSettings).not.toHaveBeenCalled();
  });

  it('updates rules text only after choosing the text button', async () => {
    const { service, adminSettingsService, chats } = createHarness({
      rules: createRules({
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/help',
        buttonText: 'Подробнее',
      }),
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
    await service.handleUpdate(createPrivateTextUpdate('Новый текст правил'));

    expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Новый текст правил',
        textFormat: 'plain',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/help',
        buttonText: 'Подробнее',
      }),
      'private_bot',
    );
  });

  it('preserves incoming MAX text markup when saving rules from private bot', async () => {
    const { service, adminSettingsService, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate('Жирный текст правил', [
        {
          type: 'strong',
          from: 0,
          length: 6,
        },
      ]),
    );

    expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: '**Жирный** текст правил',
        textFormat: 'markdown',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
  });

  it('falls back to visible rules text when markup would exceed the rules limit', async () => {
    const { service, adminSettingsService, chats } = createHarness();
    const sourceText = 'A'.repeat(MAX_CHAT_RULES_TEXT_LENGTH);

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate(sourceText, [
        {
          type: 'strong',
          from: 0,
          length: sourceText.length,
        },
      ]),
    );

    expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: sourceText,
        textFormat: 'plain',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
  });

  it('stores max-length formatted rules while rendering a markup-safe private preview', async () => {
    const { service, adminSettingsService, maxClient, chats } = createHarness();
    const sourceText = 'A'.repeat(MAX_CHAT_RULES_TEXT_LENGTH - 4);
    const storedText = `**${sourceText}**`;

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate(sourceText, [
        {
          type: 'strong',
          from: 0,
          length: sourceText.length,
        },
      ]),
    );

    const updatePayload = adminSettingsService.updateRules.mock.calls.at(-1)?.[2];
    expect(updatePayload?.text).toBe(storedText);
    expect(updatePayload?.textFormat).toBe('markdown');
    expect(String(updatePayload?.text ?? '')).toHaveLength(MAX_CHAT_RULES_TEXT_LENGTH);

    const preview = getLastUiText(maxClient);
    expect(preview.length).toBeLessThanOrEqual(4_000);
    expect(preview).toContain('Показан фрагмент. Полный текст сохранён.');
    expect(preview).not.toContain(storedText);
    expect(preview.match(/\*\*/gu)).toHaveLength(2);
    expect(getLastSendOptions(maxClient)?.textFormat).toBe('markdown');
  });

  it('keeps raw auto-detected urls intact when saving rules text with emoji prefixes', async () => {
    const { service, adminSettingsService, chats } = createHarness();
    const firstUrl = 'https://t.me/glavnyy_admin';
    const secondUrl = 'https://wa.me/79362615370';
    const thirdUrl = 'https://linku.su/ekp4z9j';
    const sourceText = `🔗 ${firstUrl}\n📱 ${secondUrl}\nMAX: ${thirdUrl}`;
    const firstUrlFrom = messageOffsetIndexOf(sourceText, firstUrl);
    const secondUrlFrom = messageOffsetIndexOf(sourceText, secondUrl);
    const thirdUrlFrom = messageOffsetIndexOf(sourceText, thirdUrl);

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate(sourceText, [
        {
          type: 'link',
          from: firstUrlFrom,
          length: countMessageOffsetUnits(firstUrl),
          url: firstUrl,
        },
        {
          type: 'link',
          from: secondUrlFrom,
          length: countMessageOffsetUnits(secondUrl),
          url: secondUrl,
        },
        {
          type: 'link',
          from: thirdUrlFrom,
          length: countMessageOffsetUnits(thirdUrl),
          url: thirdUrl,
        },
      ]),
    );

    expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: sourceText,
        textFormat: 'plain',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
  });

  it('preserves formatted links after emoji prefixes when saving rules from private bot', async () => {
    const { service, adminSettingsService, chats } = createHarness();
    const sourceText = '🔥MAX Docs';
    const prefixLength = countMessageOffsetUnits('🔥');
    const labelLength = countMessageOffsetUnits('MAX Docs');

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
    await service.handleUpdate(
      createPrivateFormattedTextUpdate(sourceText, [
        {
          type: 'strong',
          from: prefixLength,
          length: labelLength,
        },
        {
          type: 'emphasized',
          from: prefixLength,
          length: labelLength,
        },
        {
          type: 'underline',
          from: prefixLength,
          length: labelLength,
        },
        {
          type: 'link',
          from: prefixLength,
          length: labelLength,
          url: 'https://dev.max.ru/docs-api',
        },
      ]),
    );

    expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
        textFormat: 'markdown',
        autoTextEnabled: false,
      }),
      'private_bot',
    );
  });

  it('does not autosave rules content without an explicit input button', async () => {
    const { service, adminSettingsService, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateTextUpdate('Новый текст правил'));

    expect(adminSettingsService.updateRules).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain(
      'Сначала нажмите «Изменить текст» или «Добавить фото»',
    );
  });

  it('keeps the user on the rules screen after pressing the text button', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));

    expect(getLastUiText(maxClient)).toContain('Правила');
    expect(getLastUiText(maxClient)).toContain('Отправьте новый текст одним сообщением.');

    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('✏️ Изменить текст');
    expect(buttonTexts).toContain('✍️ Добавить фото');
  });

  it('updates rules photo from image and image-file messages in private bot', async () => {
    const { service, adminSettingsService, chats } = createHarness({
      rules: createRules({
        text: 'Правила с фото.',
        autoTextEnabled: true,
        adminContactButtonEnabled: true,
        adminContactButtonUrl: 'https://max.ru/admin',
      }),
    });
    const { restore } = mockImageFetch(TINY_PNG, 'image/png');

    try {
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|photo'));
      await service.handleUpdate(createPrivatePhotoUpdate());
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|photo'));
      await service.handleUpdate(createPrivateImageFileUpdate());

      expect(adminSettingsService.updateRules).toHaveBeenNthCalledWith(
        1,
        chats[0].id,
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          text: 'Правила с фото.',
          imageMimeType: 'image/png',
          imageFileName: expect.stringContaining('private-rules-photo-1'),
          autoTextEnabled: true,
          adminContactButtonEnabled: true,
          adminContactButtonUrl: 'https://max.ru/admin',
        }),
        'private_bot',
      );
      expect(adminSettingsService.updateRules).toHaveBeenNthCalledWith(
        2,
        chats[0].id,
        expect.objectContaining({ userId: 'user-1' }),
        expect.objectContaining({
          text: 'Правила с фото.',
          imageMimeType: 'image/png',
          imageFileName: 'photo-as-file.png',
          autoTextEnabled: true,
          adminContactButtonEnabled: true,
          adminContactButtonUrl: 'https://max.ru/admin',
        }),
        'private_bot',
      );
    } finally {
      restore();
    }
  });

  it('rejects mixed text and photo when text mode is selected', async () => {
    const { service, adminSettingsService, maxClient, chats } = createHarness();
    const { restore } = mockImageFetch(TINY_PNG, 'image/jpeg');

    try {
      await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
      await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_input_prompt|text'));
      await service.handleUpdate(createPrivateTextAndPhotoUpdate('Правила + фото'));

      expect(adminSettingsService.updateRules).not.toHaveBeenCalled();
      expect(getLastSentText(maxClient)).toContain(
        'Для текста правил отправьте только текст без вложений.',
      );
    } finally {
      restore();
    }
  });

  it('supports rules photo cleanup and redirects advanced rules toggles to mini app', async () => {
    const { service, adminService, adminSettingsService, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Правила чата',
        autoTextEnabled: true,
        imageBase64: TINY_PNG.toString('base64'),
        imageMimeType: 'image/png',
        imageFileName: 'rules.png',
        adminContactButtonEnabled: true,
        adminContactButtonUrl: 'https://max.ru/admin',
      }),
      settings: {
        ...defaultSettings,
        rulesAttachViolationsEnabled: false,
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_clear_photo'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_toggle_attach'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_publish'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_reset_publication'));

    expect(adminSettingsService.updateRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        text: 'Правила чата',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: true,
        adminContactButtonEnabled: true,
        adminContactButtonUrl: 'https://max.ru/admin',
      }),
      'private_bot',
    );
    expect(adminService.updateSettings).not.toHaveBeenCalled();
    expect(adminService.publishRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      'private_bot',
      'new_message',
    );
    expect(adminService.resetPublishedRules).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      'private_bot',
    );
    expect(getLastUiText(maxClient)).toContain('Публикация правил сброшена.');
  });

  it('does not announce publication when the rules service returns no receipt', async () => {
    const { service, maxClient, chats } = createHarness({
      adminService: { publishRules: jest.fn().mockResolvedValue(undefined) },
    });
    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_publish'));
    expect(getLastSentText(maxClient)).toContain('Не удалось подтвердить публикацию правил.');
  });

  it('surfaces publish error when rules text is empty', async () => {
    const { service, maxClient, chats } = createHarness({
      adminService: {
        publishRules: jest
          .fn()
          .mockRejectedValue(new BadRequestException('Сначала заполните текст правил.')),
      },
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_rules'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|rules_publish'));

    expect(getLastSentText(maxClient)).toContain('Сначала заполните текст правил.');
  });

  it('builds channel engagement requests without request-level button selectors', () => {
    const channelSettings = {
      ...defaultChannelSettings,
      commentsEnabled: true,
      postSuggestionsEnabled: false,
      engagementMessageText: 'Оставьте комментарий к публикации.',
      postSuggestionsButtonText: 'Предложить новость',
    };
    const { service } = createHarness({ channelSettings });
    const request = (
      service as unknown as {
        buildChannelEngagementPublishRequest(
          settings: typeof defaultChannelSettings,
        ): Record<string, unknown>;
      }
    ).buildChannelEngagementPublishRequest(channelSettings);

    expect(request).toEqual({
      text: 'Оставьте комментарий к публикации.',
      commentsButtonText: '💬 Комментарии',
      suggestButtonText: 'Предложить новость',
    });
  });

  it('rejects channel engagement requests when both feature toggles are off', () => {
    const { service } = createHarness();
    const buildRequest = () =>
      (
        service as unknown as {
          buildChannelEngagementPublishRequest(
            settings: typeof defaultChannelSettings,
          ): Record<string, unknown>;
        }
      ).buildChannelEngagementPublishRequest(defaultChannelSettings);

    expect(buildRequest).toThrow(
      'Включите комментарии или предложения постов в настройках канала.',
    );
  });

  it.each([
    'open_broadcast',
    'broadcast_input_prompt|text',
    'broadcast_input_prompt|photo',
    'broadcast_send',
    'broadcast_toggle|cycle_enabled',
    'broadcast_view|advanced',
    'broadcast_clear_content',
    'broadcast_clear_timer',
    'broadcast_clear_photo',
  ])('redirects retired callback %s to Publik without publishing', async (action) => {
    const { service, maxClient, adminService, managedBroadcastService } = createHarness();
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|' + action));
    expect(getLastEditedText(maxClient)).toBe('Посты и автопостинг теперь в Публике.');
    expect(getLastEditedButtons(maxClient).flat()).toContainEqual({
      type: 'link',
      text: 'Открыть бота Публик',
      url: 'https://max.ru/se14088825_bot',
    });
    expect(adminService.sendBroadcast).not.toHaveBeenCalled();
    expect(adminService.sendChannelBroadcast).not.toHaveBeenCalled();
    expect(managedBroadcastService!.sendBroadcast).not.toHaveBeenCalled();
    expect(managedBroadcastService!.sendChannelBroadcast).not.toHaveBeenCalled();
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.uploadVideo).not.toHaveBeenCalled();
  });

  it('redirects the retired broadcast start payload without restoring a draft', async () => {
    const { service, maxClient, adminService } = createHarness();
    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    expect(getLastSentText(maxClient)).toBe('Посты и автопостинг теперь в Публике.');
    expect(getLastButtons(maxClient).flat()).toContainEqual({
      type: 'link',
      text: 'Открыть бота Публик',
      url: 'https://max.ru/se14088825_bot',
    });
    expect(adminService.sendBroadcast).not.toHaveBeenCalled();
  });

  it('never restores the broadcast editor from persisted Back navigation', async () => {
    const { service, maxClient, adminService, chats } = createHarness();
    const session = createDefaultPrivateControlSession();
    session.screen = 'rules';
    session.selectedChatId = chats[0].id;
    session.lastScreenStack = [JSON.stringify({ screen: 'broadcast', selectedEntityType: 'chat' })];
    await (
      service as unknown as { saveSession(userId: string, value: unknown): Promise<void> }
    ).saveSession('user-1', session);
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|back'));
    expect(getLastEditedText(maxClient)).toBe('Посты и автопостинг теперь в Публике.');
    expect(adminService.sendBroadcast).not.toHaveBeenCalled();
    expect(adminService.sendChannelBroadcast).not.toHaveBeenCalled();
  });

  it('does not capture content or confirm a send from a persisted retired session', async () => {
    for (const update of [
      createPrivateTextUpdate('Новый пост'),
      createPrivateCallbackUpdate('pc2|mass_confirm'),
    ]) {
      const { service, maxClient, adminService } = createHarness();
      const session = createDefaultPrivateControlSession();
      session.screen = 'broadcast';
      session.pendingInput = { kind: 'broadcast_content' };
      await (
        service as unknown as { saveSession(userId: string, value: unknown): Promise<void> }
      ).saveSession('user-1', session);
      await service.handleUpdate(update);
      expect(getLastUiText(maxClient)).toBe('Посты и автопостинг теперь в Публике.');
      expect(adminService.sendBroadcast).not.toHaveBeenCalled();
      expect(adminService.sendChannelBroadcast).not.toHaveBeenCalled();
    }
  });

  it('opens channel suggestion callback intro through the callback bot', async () => {
    const { service, maxClient, channels } = createHarness();

    await expect(
      service.openChannelSuggestionFromCallback({
        userId: 'user-1',
        chatId: channels[0].id,
        token: 'cdt-suggest-token-1',
        botId: ' bot-channel-1 ',
      }),
    ).resolves.toBe(true);

    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'user-1',
      expect.stringContaining('📰 Предложка'),
      expect.any(Object),
      { botId: 'bot-channel-1' },
    );
  });

  it('builds a composed preview with edit, send and return buttons for channel suggestions', async () => {
    const { service, adminService, maxClient, channels } = createHarness({
      channelSettings: {
        ...defaultChannelSettings,
        postSuggestionsText: 'Пришлите готовый текст, город и ссылку на источник.',
      },
    });
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-1');

    await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload));

    expect(getLastSentText(maxClient)).toContain('📰 Предложка');
    expect(getLastSentText(maxClient)).toContain(
      'Пришлите готовый текст, город и ссылку на источник.',
    );
    expect(getLastSentText(maxClient)).toContain('⬇️ Пришлите следующим сообщением');
    const introButtons = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(introButtons).toContain('✍️ Добавить контент');
    expect(introButtons).toContain('↩️ Вернуться в канал');
    expect(introButtons).toHaveLength(2);

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|suggestion_compose|${channels[0].id}|cdt-suggest-token-1`),
    );

    expect(getLastEditedText(maxClient)).toContain('✍️ Добавьте контент');
    expect(getLastEditedText(maxClient)).toContain(
      '⬇️ Пришлите следующим сообщением текст, фото, видео или подпись к медиа.',
    );
    expect(getLastEditedText(maxClient)).toContain('Можно отправить несколько сообщений подряд');
    expect(getLastEditedText(maxClient)).toContain('Фото будут добавляться в одну предложку');

    await service.handleUpdate(createPrivateTextUpdate('Текст для публикации'));

    expect(adminService.createChannelSuggestionFromBot).not.toHaveBeenCalled();
    expect(maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      '152517912',
      expect.objectContaining({
        text: 'Текст для публикации',
        attachments: expect.arrayContaining([
          expect.objectContaining({
            type: 'inline_keyboard',
          }),
        ]),
      }),
    );
    const previewButtons = getLastCustomMessageButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(previewButtons).toContain('✏️ Исправить');
    expect(previewButtons).toContain('📨 Отправить');
    expect(previewButtons).toContain('↩️ Вернуться в канал');
    expect(
      getLastCustomMessageButtons(maxClient).map((row) =>
        row.map((button) => String((button as { text?: string }).text ?? '')),
      ),
    ).toEqual([['✏️ Исправить'], ['📨 Отправить'], ['↩️ Вернуться в канал']]);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|suggestion_send'));

    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      {
        token: 'cdt-suggest-token-1',
        text: 'Текст для публикации',
      },
      { mediaBotId: null },
    );
    expect(getLastEditedText(maxClient)).toContain('✅ Материал отправлен');
    expect(getLastEditedText(maxClient)).toContain(
      'Бот передал материал редакторам канала на проверку.',
    );
    expect(getLastEditedText(maxClient)).toContain(
      'Дополнить уже отправленную предложку нельзя: для правок отправьте новую.',
    );
    const completionButtons = getLastEditedButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(completionButtons).toContain('📰 Предложить ещё');
    expect(completionButtons).toContain('↩️ Вернуться в канал');

    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|suggestion_again|${channels[0].id}|cdt-suggest-token-1`),
    );

    expect(getLastEditedText(maxClient)).toContain('📰 Предложка');
  });

  it('shows a queue confirmation instead of a fake delivery failure when suggestion delivery is deferred', async () => {
    const { service, adminService, maxClient, channels } = createHarness({
      adminService: {
        createChannelSuggestionFromBot: jest.fn().mockResolvedValue({
          ok: true,
          delivered: false,
          deliveredToUserId: null,
          queued: true,
        }),
      },
    });
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-q');

    await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload));
    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|suggestion_compose|${channels[0].id}|cdt-suggest-token-q`),
    );
    await service.handleUpdate(createPrivateTextUpdate('Текст для очереди'));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|suggestion_send'));

    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        token: 'cdt-suggest-token-q',
        text: 'Текст для очереди',
      }),
      { mediaBotId: null },
    );
    expect(getLastEditedText(maxClient)).toContain('⏳ Материал принят');
    expect(getLastEditedText(maxClient)).toContain(
      'Материал принят и поставлен в очередь доставки редакторам канала.',
    );
    expect(getLastEditedText(maxClient)).not.toContain(
      'Сейчас не удалось сразу доставить материал редакторам канала.',
    );
  });

  it('clears suggestion preview buttons through the callback bot before editing', async () => {
    const { service, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(
      channels[0].id,
      'cdt-suggest-token-edit-bot',
    );
    await service.handleBotStarted(
      createBotStartedPrivateUpdate(startPayload, { botId: '888000_bot' }),
    );
    await service.handleUpdate(createPrivateTextUpdate('Исправить текст', { botId: '888000_bot' }));
    maxClient.editMessageInlineKeyboard.mockClear();

    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|suggestion_edit', { botId: '888000_bot' }),
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '152517912',
      expect.any(String),
      null,
      { buttons: [] },
      { botId: '888000_bot' },
    );
  });

  it('preserves MAX body markup in suggestion preview and admin delivery payload', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-6');
    const sourceText = '🔥MAX Docs\n\nВторой абзац';
    const renderedHtml =
      '🔥<a href="https://dev.max.ru/docs-api"><strong>MAX Docs</strong></a>\n\nВторой абзац';
    const label = 'MAX Docs';
    const from = messageOffsetIndexOf(sourceText, label);
    const length = countMessageOffsetUnits(label);

    await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload));
    await service.handleUpdate(
      createPrivateCallbackUpdate(`pc2|suggestion_compose|${channels[0].id}|cdt-suggest-token-6`),
    );
    await service.handleUpdate(
      createPrivateFormattedTextUpdate(sourceText, [
        {
          from,
          length,
          type: 'strong',
        },
        {
          from,
          length,
          type: 'link',
          url: 'https://dev.max.ru/docs-api',
        },
      ]),
    );

    expect(maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenLastCalledWith(
      '152517912',
      expect.objectContaining({
        text: renderedHtml,
        textFormat: 'html',
      }),
    );

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|suggestion_send'));

    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        token: 'cdt-suggest-token-6',
        text: sourceText,
        textMarkup: [
          expect.objectContaining({
            from,
            length,
            type: 'strong',
          }),
          expect.objectContaining({
            from,
            length,
            type: 'link',
            url: 'https://dev.max.ru/docs-api',
          }),
        ],
      }),
      { mediaBotId: null },
    );
  });

  it('accumulates suggestion photos in preview and keeps them when text changes', async () => {
    const { service, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-4');
    const imageMock = mockImageFetch();

    try {
      await service.handleBotStarted(
        createBotStartedPrivateUpdate(startPayload, { botId: '888000_bot' }),
      );
      await service.handleUpdate(createPrivatePhotoUpdate({ botId: '888000_bot' }));

      let previewPayload = getLastCustomMessagePayload(maxClient);
      expect(previewPayload?.text).toBeUndefined();
      expect(getLastCustomMessageAttachments(maxClient)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-1' },
          }),
          expect.objectContaining({
            type: 'inline_keyboard',
          }),
        ]),
      );

      await service.handleUpdate(
        createPrivatePhotoUpdate({
          photoIds: ['photo-2', 'photo-3'],
          botId: '888000_bot',
        }),
      );

      previewPayload = getLastCustomMessagePayload(maxClient);
      expect(previewPayload?.text).toBeUndefined();
      expect(getLastCustomMessageAttachments(maxClient)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-1' },
          }),
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-2' },
          }),
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-3' },
          }),
        ]),
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
        '152517912',
        'msg-preview-1',
        null,
        { buttons: [] },
        { botId: '888000_bot' },
      );

      await service.handleUpdate(
        createPrivateTextUpdate('Подпись к фото', { botId: '888000_bot' }),
      );

      previewPayload = getLastCustomMessagePayload(maxClient);
      expect(previewPayload?.text).toBe('Подпись к фото');
      expect(getLastCustomMessageAttachments(maxClient)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-1' },
          }),
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-2' },
          }),
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-3' },
          }),
        ]),
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
        '152517912',
        'msg-preview-2',
        null,
        { buttons: [] },
        { botId: '888000_bot' },
      );

      await service.handleUpdate(
        createPrivateTextUpdate('Обновлённая подпись', { botId: '888000_bot' }),
      );

      previewPayload = getLastCustomMessagePayload(maxClient);
      expect(previewPayload?.text).toBe('Обновлённая подпись');
      expect(getLastCustomMessageAttachments(maxClient)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-1' },
          }),
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-2' },
          }),
          expect.objectContaining({
            type: 'image',
            payload: { token: 'upload-token-3' },
          }),
        ]),
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
        '152517912',
        'msg-preview-3',
        null,
        { buttons: [] },
        { botId: '888000_bot' },
      );
    } finally {
      imageMock.restore();
    }
  });

  it('accepts a photo-only suggestion in the bot flow after explicit send', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-2');
    const imageMock = mockImageFetch();

    try {
      await service.handleBotStarted(
        createBotStartedPrivateUpdate(startPayload, { botId: '888000_bot' }),
      );
      await service.handleUpdate(createPrivatePhotoUpdate({ botId: '888000_bot' }));
      await service.handleUpdate(
        createPrivateCallbackUpdate('pc2|suggestion_send', { botId: '888000_bot' }),
      );
    } finally {
      imageMock.restore();
    }

    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        token: 'cdt-suggest-token-2',
        text: '',
        images: [
          expect.objectContaining({
            payload: { token: 'upload-token-1' },
            mimeType: expect.stringMatching(/^image\//),
            fileName: expect.stringContaining('channel-suggestion'),
          }),
        ],
      }),
      { mediaBotId: '888000_bot' },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '152517912',
      expect.any(String),
      null,
      { buttons: [] },
      { botId: '888000_bot' },
    );
    expect(getLastEditedText(maxClient)).toContain('✅ Материал отправлен');
  });

  it('shows a user-facing media validation error while composing a suggestion', async () => {
    const { service, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-7');
    const imageMock = mockImageFetch();
    const validationError = new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
    );
    maxClient.uploadImage.mockRejectedValueOnce(validationError);

    try {
      await service.handleBotStarted(
        createBotStartedPrivateUpdate(startPayload, { botId: '888000_bot' }),
      );
      await service.handleUpdate(createPrivatePhotoUpdate({ botId: '888000_bot' }));
    } finally {
      imageMock.restore();
    }

    expect(getLastSentText(maxClient)).toContain(validationError.publicMessage);
    expect(getLastSentText(maxClient)).not.toContain('Что-то пошло не так');
  });

  it('sends several suggestion photos from the bot as one album payload', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-5');
    const imageMock = mockImageFetch();

    try {
      await service.handleBotStarted(
        createBotStartedPrivateUpdate(startPayload, { botId: '888000_bot' }),
      );
      await service.handleUpdate(
        createPrivatePhotoUpdate({
          photoIds: ['photo-10', 'photo-11'],
          botId: '888000_bot',
        }),
      );
      await service.handleUpdate(
        createPrivatePhotoUpdate({ photoIds: ['photo-12'], botId: '888000_bot' }),
      );
      await service.handleUpdate(
        createPrivateCallbackUpdate('pc2|suggestion_send', { botId: '888000_bot' }),
      );
    } finally {
      imageMock.restore();
    }

    expect(getLastCustomMessageAttachments(maxClient)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', payload: { token: 'upload-token-1' } }),
        expect.objectContaining({ type: 'image', payload: { token: 'upload-token-2' } }),
        expect.objectContaining({ type: 'image', payload: { token: 'upload-token-3' } }),
      ]),
    );
    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        token: 'cdt-suggest-token-5',
        text: '',
        images: [
          expect.objectContaining({ payload: { token: 'upload-token-1' } }),
          expect.objectContaining({ payload: { token: 'upload-token-2' } }),
          expect.objectContaining({ payload: { token: 'upload-token-3' } }),
        ],
      }),
      { mediaBotId: '888000_bot' },
    );
    expect(getLastEditedText(maxClient)).toContain('✅ Материал отправлен');
  });

  it('rejects a migrated media draft before uploading through a different bot', async () => {
    const { service, adminService, maxClient, redisCounter, channels } = createHarness();
    const session = createDefaultPrivateControlSession();
    session.pendingInput = {
      kind: 'channel_suggestion',
      chatId: channels[0].id,
      token: 'cdt-suggest-token-mixed-bots',
    };
    session.suggestionDraft = {
      chatId: channels[0].id,
      token: 'cdt-suggest-token-mixed-bots',
      text: '',
      textFormat: 'plain',
      textMarkup: [],
      images: [
        {
          kind: 'image',
          mimeType: 'image/png',
          fileName: 'original.png',
          payload: { token: 'source-bot-token' },
        },
      ],
      video: null,
      mediaBotId: '888000_bot',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      sourceMessageId: 'source-message',
      previewMessageId: null,
    };
    await redisCounter.setStringWithTtl('private-ui:v2:user-1', JSON.stringify(session));
    const imageMock = mockImageFetch();

    try {
      await service.handleUpdate(createPrivatePhotoUpdate({ botId: '777000_bot' }));
    } finally {
      imageMock.restore();
    }

    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(adminService.createChannelSuggestionFromBot).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Медиа этой предложки загружено другим ботом');
  });

  it('rejects a migrated token draft before a cross-bot text edit can render its preview', async () => {
    const { service, maxClient, redisCounter, channels } = createHarness();
    const session = createDefaultPrivateControlSession();
    session.pendingInput = {
      kind: 'channel_suggestion',
      chatId: channels[0].id,
      token: 'cdt-suggest-token-migrated-text',
    };
    session.suggestionDraft = {
      chatId: channels[0].id,
      token: 'cdt-suggest-token-migrated-text',
      text: '',
      textFormat: 'plain',
      textMarkup: [],
      images: [],
      video: {
        kind: 'video',
        mimeType: 'video/mp4',
        fileName: 'source.mp4',
        payload: { token: 'source-video-token' },
      },
      mediaBotId: '888000_bot',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      sourceMessageId: 'source-message',
      previewMessageId: null,
    };
    await redisCounter.setStringWithTtl('private-ui:v2:user-1', JSON.stringify(session));

    await service.handleUpdate(createPrivateTextUpdate('Новая подпись', { botId: '777000_bot' }));

    expect(maxClient.sendCustomMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(getLastSentText(maxClient)).toContain('Медиа этой предложки загружено другим ботом');
  });

  it('uploads downloaded suggestion video through the incoming private bot', async () => {
    const { service, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-6');
    const videoBuffer = Buffer.from('video-binary');
    const videoFetch = mockImageFetch(videoBuffer, 'video/mp4');

    try {
      await service.handleBotStarted(
        createBotStartedPrivateUpdate(startPayload, { botId: '888000_bot' }),
      );
      await service.handleUpdate(
        createPrivateVideoUpdate({ botId: '888000_bot', includeToken: false }),
      );
    } finally {
      videoFetch.restore();
    }

    expect(maxClient.uploadVideo).toHaveBeenCalledWith(
      videoBuffer,
      'channel-suggestion-video.mp4',
      'video/mp4',
      { botId: '888000_bot' },
    );
    expect(maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      '152517912',
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({
            type: 'video',
            payload: { token: 'upload-video-token-1' },
          }),
        ]),
      }),
      { botId: '888000_bot' },
    );
  });

  it('accepts a video-only suggestion in the bot flow after explicit send', async () => {
    const { service, adminService, maxClient, channels } = createHarness();
    const startPayload = encodeChannelSuggestionStartPayload(channels[0].id, 'cdt-suggest-token-3');
    const videoBuffer = Buffer.from('video-binary');
    const originalFetch = global.fetch;

    Object.defineProperty(global, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'video/mp4' : null),
        },
        arrayBuffer: async () =>
          videoBuffer.buffer.slice(
            videoBuffer.byteOffset,
            videoBuffer.byteOffset + videoBuffer.byteLength,
          ),
      }),
    });

    try {
      await service.handleBotStarted(
        createBotStartedPrivateUpdate(startPayload, { botId: '888000_bot' }),
      );
      await service.handleUpdate(createPrivateVideoUpdate({ botId: '888000_bot' }));
      await service.handleUpdate(
        createPrivateCallbackUpdate('pc2|suggestion_send', { botId: '888000_bot' }),
      );
    } finally {
      Object.defineProperty(global, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }

    expect(maxClient.uploadVideo).not.toHaveBeenCalled();
    expect(adminService.createChannelSuggestionFromBot).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        token: 'cdt-suggest-token-3',
        text: '',
        mediaType: 'video',
        mediaPayload: { token: 'incoming-video-token' },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'channel-suggestion-video.mp4',
      }),
      { mediaBotId: '888000_bot' },
    );
    expect(maxClient.sendCustomMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      '152517912',
      expect.objectContaining({
        attachments: expect.arrayContaining([
          expect.objectContaining({
            type: 'video',
            payload: { token: 'incoming-video-token' },
          }),
          expect.objectContaining({
            type: 'inline_keyboard',
          }),
        ]),
      }),
      { botId: '888000_bot' },
    );
    expect(getLastEditedText(maxClient)).toContain('✅ Материал отправлен');
  });

  it('routes admin review callbacks to publish or cancel the suggestion', async () => {
    const { service, adminService, maxClient } = createHarness({
      adminService: {
        reviewChannelSuggestionByAdmin: jest.fn().mockResolvedValue({
          status: 'reviewed',
          reviewStatus: 'published',
          publishedUrl: 'https://max.ru/chats/channel-1/message/999',
        }),
      },
    });

    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|suggestion_review_publish|suggestion-42', {
        userId: 'admin-1',
        displayName: 'Главный редактор',
      }),
    );

    expect(adminService.reviewChannelSuggestionByAdmin).toHaveBeenCalledWith(
      'suggestion-42',
      expect.objectContaining({
        userId: 'admin-1',
        displayName: 'Главный редактор',
      }),
      'publish',
    );
    expect(getLastEditedText(maxClient)).toContain('Предложка опубликована');
    expect(getLastEditedText(maxClient)).toContain(
      'Пост: [Открыть пост](https://max.ru/chats/channel-1/message/999)',
    );
    expect(getLastEditedButtons(maxClient)).toEqual([
      [
        {
          text: 'Открыть пост',
          type: 'link',
          url: 'https://max.ru/chats/channel-1/message/999',
        },
      ],
    ]);
  });

  it('uses the full callback user name instead of a legacy short name', async () => {
    const { service, adminService } = createHarness({
      adminService: {
        reviewChannelSuggestionByAdmin: jest.fn().mockResolvedValue({
          status: 'reviewed',
          reviewStatus: 'published',
          publishedUrl: null,
        }),
      },
    });
    const update = createPrivateCallbackUpdate('pc2|suggestion_review_publish|suggestion-42', {
      userId: 'admin-1',
      displayName: 'Иван',
    });
    const callback = (update.raw as { callback: { user: Record<string, unknown> } }).callback;
    callback.user.first_name = 'Иван';
    callback.user.last_name = 'Петров';

    await service.handleUpdate(update);

    expect(adminService.reviewChannelSuggestionByAdmin).toHaveBeenCalledWith(
      'suggestion-42',
      expect.objectContaining({
        userId: 'admin-1',
        displayName: 'Иван Петров',
      }),
      'publish',
    );
  });

  it('shows a processing state when another admin already claimed a suggestion review', async () => {
    const { service, adminService, maxClient } = createHarness({
      adminService: {
        reviewChannelSuggestionByAdmin: jest.fn().mockResolvedValue({
          status: 'review_in_progress',
          reviewStatus: 'processing',
          publishedUrl: null,
        }),
      },
    });

    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|suggestion_review_publish|suggestion-42', {
        userId: 'admin-1',
        displayName: 'Главный редактор',
      }),
    );

    expect(adminService.reviewChannelSuggestionByAdmin).toHaveBeenCalledWith(
      'suggestion-42',
      expect.objectContaining({
        userId: 'admin-1',
      }),
      'publish',
    );
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      expect.any(String),
      'Предложка обрабатывается. Результат пока не подтверждён.',
      undefined,
      expect.any(Object),
    );
    expect(getLastEditedText(maxClient)).toBe('');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not expose raw MAX transport errors from suggestion review callbacks', async () => {
    const { service, maxClient } = createHarness({
      adminService: {
        reviewChannelSuggestionByAdmin: jest
          .fn()
          .mockRejectedValue(createMaxApiError(403, 'Request failed with status code 403')),
      },
    });

    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|suggestion_review_cancel|suggestion-42', {
        userId: 'admin-1',
        displayName: 'Главный редактор',
      }),
    );

    expect(getLastSentText(maxClient)).toContain(
      'Проверьте, что вы и бот по-прежнему администраторы канала',
    );
    expect(getLastSentText(maxClient)).not.toContain('Request failed with status code 403');
  });

  it('hands off Karavan allowlist, accepts one forwarded user, and grants a selected duration', async () => {
    const { service, maxClient, karavanStorefrontAllowlistService } = createHarness();
    const actor = {
      userId: 'user-1',
      launchBotId: '777000_bot',
      username: null,
      displayName: 'Тестовый пользователь',
    };

    const handoff = await service.handoffKaravanStorefrontAllowlistFromMiniapp(
      '-70000000000001',
      actor,
    );
    const startPayload = extractStartPayload(handoff.botUrl);
    expect(startPayload).toMatch(/^ka2-/u);

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(startPayload, { botId: '777000_bot' }),
    );
    const forwardPrompt = getLastSentText(maxClient);
    expect(forwardPrompt).toContain(
      'Перешлите сообщение пользователя, которому хотите выдать доступ.',
    );
    expect(forwardPrompt).toContain('Чат: Тестовый чат 1');
    expect(forwardPrompt).toContain('Сообщение можно переслать из любого чата.');
    expect(forwardPrompt).not.toContain('-70000000000001');
    expect(forwardPrompt).not.toContain('Идентификатор пользователя вручную');

    await service.handleUpdate({
      ...createPrivateForwardedModerationUpdate('', {
        sourceChatId: -90000000000001,
        sourceChatTitle: 'Другой источник',
      }),
      botId: '777000_bot',
    });
    const durationButton = getLastButtons(maxClient)
      .flat()
      .find(
        (button) =>
          typeof (button as { payload?: unknown })?.payload === 'string' &&
          String((button as { payload: string }).payload).endsWith('|1d'),
      ) as { payload?: string } | undefined;
    expect(durationButton?.payload).toBeTruthy();
    expect(getLastSentText(maxClient)).toContain('Срок разрешения');
    expect(getLastSentText(maxClient)).toContain('Чат: Тестовый чат 1');
    expect(getLastSentText(maxClient)).not.toContain('ID:');

    await service.handleUpdate(
      createPrivateCallbackUpdate(durationButton!.payload!, { botId: '777000_bot' }),
    );
    expect(karavanStorefrontAllowlistService.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-70000000000001',
        userId: 'user-77',
        createdByUserId: 'user-1',
        sourceMessageId: null,
        expiresAt: expect.any(Date),
      }),
    );
    const grantedText = getLastEditedText(maxClient);
    expect(grantedText).toContain('Доступ разрешён');
    expect(grantedText).toContain('Чат: Тестовый чат 1');
    expect(grantedText).not.toContain('-70000000000001');
  });

  it('shows a concise retry prompt for a typed user id instead of technical validation text', async () => {
    const { service, maxClient } = createHarness();
    const actor = {
      userId: 'user-1',
      launchBotId: '777000_bot',
      username: null,
      displayName: 'Тестовый пользователь',
    };

    const handoff = await service.handoffKaravanStorefrontAllowlistFromMiniapp(
      '-70000000000001',
      actor,
    );
    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(handoff.botUrl), {
        botId: '777000_bot',
      }),
    );

    await service.handleUpdate({
      ...createPrivateTextUpdate('123456789'),
      botId: '777000_bot',
    });

    const retryText = getLastSentText(maxClient);
    expect(retryText).toContain(
      'Не удалось определить пользователя. Перешлите сообщение пользователя, которому хотите выдать доступ.',
    );
    expect(retryText).toContain('Чат: Тестовый чат 1');
    expect(retryText).not.toContain('Идентификатор пользователя вручную');
    expect(retryText).not.toContain('123456789');
  });

  it('hands off giveaway from miniapp into a mini app return screen in private bot', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    const result = await service.handoffGiveawayFromMiniapp(
      chats[0].id,
      actor,
      {
        giveawayId: 'giveaway-1',
      },
      'chat',
    );

    expect(result.botUrl).toContain('https://max.ru/777000_bot?start=');
    expect(extractStartPayload(result.botUrl).length).toBeLessThanOrEqual(128);

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(managedGiveawayService.getManagedGiveaway).toHaveBeenCalledWith(
      chats[0].id,
      'giveaway-1',
      expect.objectContaining({ userId: 'user-1' }),
      'chat',
    );
    expect(getLastSentText(maxClient)).toContain('Розыгрыши перенесены в mini app');
    expect(getLastSentText(maxClient)).toContain(`Чат: ${chats[0].title}`);
    expect(getLastSentText(maxClient)).toContain(
      'Черновики, публикация, итоги и reroll розыгрышей теперь доступны только в приложении.',
    );
    const buttonTexts = getLastButtons(maxClient)
      .flat()
      .map((button) => String((button as { text?: string }).text ?? ''));
    expect(buttonTexts).toContain('📱 Открыть в приложении');
    expect(buttonTexts).toContain('↩️ Назад');
    expect(buttonTexts).toContain('🆘 Поддержка');

    const launchButton = getLastButtons(maxClient)
      .flat()
      .find(
        (button) => String((button as { text?: string }).text ?? '') === '📱 Открыть в приложении',
      ) as { url?: string } | undefined;
    expect(decodeStartAppRoute(String(launchButton?.url ?? ''))).toBe(
      `/chat/${encodeURIComponent(chats[0].id)}/settings?focus=giveaway&handoff=1`,
    );
  });

  it('hands off chat member profile from miniapp and sends an html mention in private chat', async () => {
    const { service, maxClient, adminService, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };
    maxClient.getChatMemberProfiles.mockResolvedValue(
      new Map([['user-42', { displayName: 'Юлия Максимова' }]]),
    );

    const result = await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-42',
      {
        displayName: 'Юлия',
      },
      'chat',
    );

    expect(adminService.getChatHeader).toHaveBeenCalledWith(
      chats[0].id,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith(chats[0].id, ['user-42']);
    expect(result.botUrl).toContain('https://max.ru/777000_bot?start=');
    expect(extractStartPayload(result.botUrl).length).toBeLessThanOrEqual(128);

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(getLastSentText(maxClient)).toContain('<strong>Профиль пользователя</strong>\n');
    expect(getLastSentText(maxClient)).toContain('<a href="max://user/user-42">Юлия Максимова</a>');
    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'html',
      }),
    );
  });

  it('resolves profile mention handoff names through the header primary bot', async () => {
    const { service, maxClient, chats } = createHarness({
      adminService: {
        getChatHeader: jest.fn().mockResolvedValue({
          id: '-70000000000001',
          title: 'Тестовый чат 1',
          entityType: 'chat',
          link: null,
          participantsCount: null,
          primaryBotId: '888000_bot',
          assignedBots: [],
        }),
      },
    });
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };
    maxClient.getChatMemberProfiles.mockResolvedValue(
      new Map([['user-42', { displayName: 'Юлия Максимова' }]]),
    );

    await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-42',
      {
        displayName: 'Юлия',
      },
      'chat',
    );

    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith(chats[0].id, ['user-42'], {
      botId: '888000_bot',
    });
  });

  it('persists a MAX-resolved profile handoff name for later local statistics reads', async () => {
    const { service, maxClient, chats, prisma } = createHarness({ prisma: {} });
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };
    maxClient.getChatMemberProfiles.mockResolvedValue(
      new Map([['user-42', { displayName: 'Юлия Максимова' }]]),
    );

    await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-42',
      { displayName: 'Участник' },
      'chat',
    );

    const executeRaw = prisma?.$executeRaw as jest.Mock | undefined;
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(extractSqlValues(executeRaw?.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining([chats[0].id, 'user-42', 'Юлия Максимова', 'profile_handoff']),
    );
  });

  it('falls back to the provided profile name when MAX member profile lookup is empty', async () => {
    const { service, maxClient, adminService, channels } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: channels[0].id,
      chatTitle: channels[0].title,
    };

    const result = await service.handoffProfileMentionFromMiniapp(
      channels[0].id,
      actor,
      'user-99',
      {
        displayName: 'Без username',
      },
      'channel',
    );

    expect(adminService.getChannelHeader).toHaveBeenCalledWith(
      channels[0].id,
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(result.botUrl).toContain('https://max.ru/777000_bot?start=');
    expect(extractStartPayload(result.botUrl).length).toBeLessThanOrEqual(128);

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(getLastSentText(maxClient)).toContain('<a href="max://user/user-99">Без username</a>');
  });

  it('uses a local display name snapshot when a compact handoff targets a former member', async () => {
    const findUnique = jest.fn().mockResolvedValue({ displayName: 'Анна Ушедшая' });
    const { service, maxClient, chats } = createHarness({
      prisma: {
        chatUserDisplayName: {
          findUnique,
        },
      },
    });
    const startPayload = buildCompactProfileMentionStartPayload(
      {
        chatId: chats[0].id,
        entityType: 'chat',
        userId: 'user-removed',
      },
      'test-token',
    );
    expect(startPayload).not.toBeNull();

    await service.handleBotStarted(createBotStartedPrivateUpdate(startPayload!));

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        chatId_userId: {
          chatId: chats[0].id,
          userId: 'user-removed',
        },
      },
      select: {
        displayName: true,
      },
    });
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith(chats[0].id, ['user-removed']);
    expect(getLastSentText(maxClient)).toContain(
      '<a href="max://user/user-removed">Анна Ушедшая</a>',
    );
  });

  it('proactively delivers profile mention handoff into a known private chat and skips duplicate bot_started reply', async () => {
    const { service, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    maxClient.sendMessage.mockClear();

    const result = await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-77',
      {
        displayName: 'Мария',
      },
      'chat',
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(getLastSentText(maxClient)).toContain('<a href="max://user/user-77">Мария</a>');

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty bot_started right after proactive profile mention delivery', async () => {
    const { service, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    maxClient.sendMessage.mockClear();

    await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-88',
      {
        displayName: 'Анна',
      },
      'chat',
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    maxClient.sendMessage.mockClear();

    await service.handleBotStarted(createBotStartedPrivateUpdate(''));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).not.toHaveBeenCalled();
  });

  it('escapes profile mention display name in html handoff text', async () => {
    const { service, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    const result = await service.handoffProfileMentionFromMiniapp(
      chats[0].id,
      actor,
      'user-55',
      {
        displayName: 'Анна <Admin> & Co',
      },
      'chat',
    );

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(getLastSentText(maxClient)).toContain(
      '<a href="max://user/user-55">Анна &lt;Admin&gt; &amp; Co</a>',
    );
    expect(getLastSendOptions(maxClient)).toEqual(
      expect.objectContaining({
        textFormat: 'html',
      }),
    );
  });

  it('proactively delivers giveaway handoff screen into a known private chat and skips duplicate bot_started reply', async () => {
    const { service, maxClient, chats } = createHarness();
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    maxClient.sendMessage.mockClear();

    const result = await service.handoffGiveawayFromMiniapp(
      chats[0].id,
      actor,
      {
        giveawayId: 'giveaway-1',
      },
      'chat',
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Розыгрыши перенесены в mini app'),
      expect.anything(),
      expect.objectContaining({ immediate: true, timeoutMs: 2500 }),
    );

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('proactively delivers rules handoff into a known private chat and skips duplicate bot_started reply', async () => {
    const { service, maxClient, chats } = createHarness({
      rules: createRules({
        text: 'Правила для быстрой правки.',
        autoTextEnabled: true,
      }),
    });
    const actor = {
      userId: 'user-1',
      username: null,
      displayName: 'Тестовый пользователь',
      chatId: chats[0].id,
      chatTitle: chats[0].title,
    };

    await service.handleBotStarted(createBotStartedPrivateUpdate('broadcast_handoff'));
    maxClient.sendMessage.mockClear();

    const result = await service.handoffRulesFromMiniapp(chats[0].id, actor);

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(getLastSentText(maxClient)).toContain('Правила');
    expect(getLastSentText(maxClient)).toContain('Правила для быстрой правки.');
    expect(getLastSentText(maxClient)).toContain('Отправьте новый текст одним сообщением.');

    await service.handleBotStarted(
      createBotStartedPrivateUpdate(extractStartPayload(result.botUrl)),
    );

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('redirects giveaway callbacks to mini app instead of mutating private drafts', async () => {
    const { service, maxClient, chats, managedGiveawayService } = createHarness({
      managedGiveaway: null,
    });

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_giveaway'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_create'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_input_prompt|title'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_reroll|winner-1'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|giveaway_deliver|winner-1'));
    expect(getLastEditedText(maxClient)).toContain('Розыгрыши перенесены в mini app');

    expect(managedGiveawayService.getCurrentManagedGiveawayForEntity).not.toHaveBeenCalled();
    expect(managedGiveawayService.createManagedGiveaway).not.toHaveBeenCalled();
    expect(managedGiveawayService.updateManagedGiveaway).not.toHaveBeenCalled();
    expect(managedGiveawayService.rerollManagedGiveawayWinner).not.toHaveBeenCalled();
    expect(managedGiveawayService.markManagedGiveawayWinnerDelivered).not.toHaveBeenCalled();

    const launchButton = getLastEditedButtons(maxClient)
      .flat()
      .find(
        (button) => String((button as { text?: string }).text ?? '') === '📱 Открыть в приложении',
      ) as { url?: string } | undefined;
    expect(decodeStartAppRoute(String(launchButton?.url ?? ''))).toBe(
      `/chat/${encodeURIComponent(chats[0].id)}/settings?focus=giveaway&handoff=1`,
    );
  });

  it('renders giveaway winner notice on bot_started deep link without confirmation CTA', async () => {
    const { service, maxClient, managedGiveawayService } = createHarness();

    await service.handleBotStarted(createBotStartedGiveawayClaimUpdate());
    expect(managedGiveawayService.parseClaimStartPayload).toHaveBeenCalledWith('ggc-test-payload');
    expect(
      getLastButtons(maxClient)
        .flat()
        .some(
          (button) =>
            typeof button === 'object' &&
            button !== null &&
            'text' in button &&
            button.text === 'Открыть розыгрыш',
        ),
    ).toBe(false);
    expect(
      getLastButtons(maxClient)
        .flat()
        .some(
          (button) =>
            typeof button === 'object' &&
            button !== null &&
            'text' in button &&
            button.text === 'Подтвердить приз',
        ),
    ).toBe(false);
    expect(getLastUiText(maxClient)).toContain('Победитель зафиксирован');
    expect(managedGiveawayService.claimGiveaway).not.toHaveBeenCalled();
  });

  it('confirms a selected giveaway winner from the private deep link flow', async () => {
    const { service, maxClient, managedGiveawayService } = createHarness();
    const selectedClaim = {
      giveaway: createGiveaway({
        status: 'COMPLETED',
        winnersCount: 1,
        winners: [createGiveawayWinner({ status: 'SELECTED' })],
      }),
      winner: createGiveawayWinner({ status: 'SELECTED' }),
    };
    const confirmedClaim = {
      giveaway: createGiveaway({
        status: 'COMPLETED',
        winnersCount: 1,
        winners: [
          createGiveawayWinner({
            status: 'CLAIMED',
            claimedAt: new Date().toISOString(),
          }),
        ],
      }),
      winner: createGiveawayWinner({
        status: 'CLAIMED',
        claimedAt: new Date().toISOString(),
      }),
    };
    managedGiveawayService.getGiveawayClaimContext
      .mockResolvedValueOnce(selectedClaim)
      .mockResolvedValueOnce(selectedClaim)
      .mockResolvedValueOnce(confirmedClaim);

    await service.handleBotStarted(createBotStartedGiveawayClaimUpdate());
    expect(
      getLastButtons(maxClient)
        .flat()
        .some(
          (button) =>
            typeof button === 'object' &&
            button !== null &&
            'text' in button &&
            button.text === 'Подтвердить приз',
        ),
    ).toBe(true);

    await service.handleUpdate(
      createPrivateCallbackUpdate('pc2|giveaway_claim_confirm|giveaway-1|winner-1'),
    );

    expect(managedGiveawayService.claimGiveaway).toHaveBeenCalledWith(
      'giveaway-1',
      expect.objectContaining({ userId: 'user-1' }),
      'private_claim',
    );
    expect(getLastEditedText(maxClient)).toContain('Приз подтверждён');
    expect(
      getLastEditedButtons(maxClient)
        .flat()
        .some(
          (button) =>
            typeof button === 'object' &&
            button !== null &&
            'text' in button &&
            button.text === 'Подтвердить приз',
        ),
    ).toBe(false);
  });

  it('keeps key private screens under a safe inline-button count', async () => {
    const { service, maxClient, chats } = createHarness();

    await service.handleUpdate(createPrivateTextUpdate('меню'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate(`pc2|chat_select|${chats[0].id}`));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_settings_hub'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(20);

    await service.handleUpdate(createPrivateCallbackUpdate('pc2|open_section|duplicates'));
    expect(getLastButtons(maxClient).flat().length).toBeLessThanOrEqual(40);
  });
});
