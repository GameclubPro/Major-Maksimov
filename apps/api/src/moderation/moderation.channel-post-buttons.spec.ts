import type { MaxUpdate } from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import { ChannelPostSignatureService } from '../admin/channel-post-signature.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxApiInternalRateLimitError, type MaxClientService } from '../max/max-client.service';
import {
  markMaxPreDispatchGuardRejected,
  MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
  usesMaxFinalAuthorityCheckpoint,
} from '../max/max-action-pre-dispatch-guard';
import { ModerationService } from './moderation.service';
import { ChannelPostDemandRuntime } from './channel-post-demand-runtime';

async function prepareLockedEditText(
  ...[_chatId, _messageId, text, options]: Parameters<MaxClientService['editMessageInlineKeyboard']>
) {
  return options?.prepareMessageText?.({ body: { text, format: options.textFormat } });
}

function expectChannelAutoPostOptions(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({
    trafficClass: 'background',
    actionHealthLane: 'background',
    sourceTag: 'channel_auto_post',
    ...overrides,
  });
}

function createRuntimeBotChannelPostUpdate(): MaxUpdate {
  return {
    updateId: 'upd-channel-1',
    type: 'message_created',
    message: {
      messageId: 'mid-channel-1',
      chatId: 'channel-1',
      senderId: '777000',
      senderName: 'Бот',
      text: 'Новый пост в канале',
      createdAt: new Date('2026-03-06T15:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
        },
        sender: {
          user_id: '777000',
          is_bot: true,
        },
      },
    },
  };
}

function createChannelPostUpdateWithoutSender(): MaxUpdate {
  return {
    updateId: 'upd-channel-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'mid-channel-no-sender-1',
      chatId: 'channel-1',
      senderId: '',
      senderName: '',
      text: 'Новый пост без senderId',
      createdAt: new Date('2026-03-06T15:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
        },
        timestamp: 1772810100000,
        body: {
          mid: 'mid-channel-no-sender-1',
          text: 'Новый пост без senderId',
        },
      },
    },
  };
}

function createForwardedChannelPostUpdate(senderId = ''): MaxUpdate {
  return {
    updateId: senderId ? 'upd-channel-forward-admin-1' : 'upd-channel-forward-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'mid-channel-forward-no-sender-1',
      chatId: 'channel-1',
      senderId,
      senderName: senderId ? 'Админ' : '',
      text: 'Пересланный пост',
      createdAt: new Date('2026-03-06T15:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
        },
        timestamp: 1772810100000,
        ...(senderId
          ? {
              sender: {
                user_id: senderId,
                is_bot: false,
              },
            }
          : {}),
        body: {
          mid: 'mid-channel-forward-no-sender-1',
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            text: 'Пересланный пост',
          },
        },
      },
    },
  };
}

function createRichForwardedChannelPostUpdate(): MaxUpdate {
  const sourceText = '🔥MAX Docs\n\nВторой абзац';
  return {
    updateId: 'upd-channel-forward-rich-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'mid-channel-forward-rich-no-sender-1',
      chatId: 'channel-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text: sourceText,
      createdAt: new Date('2026-03-06T15:10:00.000Z').toISOString(),
    },
    raw: {
      message: {
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
        },
        timestamp: 1772810100000,
        sender: {
          user_id: 'admin-1',
          is_bot: false,
        },
        body: {
          mid: 'mid-channel-forward-rich-no-sender-1',
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            text: sourceText,
            markup: [
              {
                from: 2,
                type: 'strong',
                length: 8,
              },
              {
                from: 2,
                type: 'underline',
                length: 8,
              },
            ],
          },
        },
      },
    },
  };
}

function createConfigMock(overrides: Partial<Record<string, string | number | boolean>> = {}) {
  return {
    get: jest.fn((key: string) => {
      if (key in overrides) {
        return overrides[key];
      }
      if (key === 'MAX_BOT_TOKEN') {
        return 'test-max-bot-token';
      }
      if (key === 'MAX_BOT_ID') {
        return '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru';
      }
      return undefined;
    }),
  };
}

function createAdminServiceMock() {
  return {
    buildChannelSuggestionStartPayload: jest.fn(
      (chatId: string, threadId: string) => `cds-${chatId}-${threadId}`,
    ),
  };
}

function createChannelMutationGuardMaxClientMock() {
  return {
    getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'channel' }),
    getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
      userId: '777000',
      isAdmin: true,
      isOwner: false,
      permissions: ['write', 'edit_message', 'delete_message'],
    }),
    getChatMemberAccess: jest.fn().mockResolvedValue({
      userId: 'admin-1',
      isAdmin: true,
      isOwner: false,
      permissions: [],
    }),
  };
}

function createChannelMutationGuardPrismaMock() {
  return {
    chat: {
      findUnique: jest.fn().mockResolvedValue({ entityType: 'CHANNEL' }),
    },
  };
}

function createChannelAutoPostAttachMarkerMock() {
  const rows = new Map<string, Record<string, any>>();
  const buildKey = (chatId: string, messageId: string) => `${chatId}:${messageId}`;
  const delegate = {
    findUnique: jest.fn(async ({ where }: any) => {
      const identity = where.chatId_messageId;
      return rows.get(buildKey(identity.chatId, identity.messageId)) ?? null;
    }),
    createMany: jest.fn(async ({ data }: any) => {
      const input = data[0];
      const key = buildKey(input.chatId, input.messageId);
      if (rows.has(key)) {
        return { count: 0 };
      }
      rows.set(key, {
        ...input,
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        publishedUrl: null,
        originalDeleted: false,
        cleanupIntentId: null,
      });
      return { count: 1 };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const key = buildKey(where.chatId, where.messageId);
      const row = rows.get(key);
      if (!row) {
        return { count: 0 };
      }
      for (const field of [
        'status',
        'lockToken',
        'botId',
        'linkType',
        'deliveryMode',
        'replacementMessageId',
        'replyMessageId',
        'replacementSendStartedAt',
        'publishedUrl',
        'originalDeleted',
        'cleanupIntentId',
      ]) {
        if (Object.prototype.hasOwnProperty.call(where, field) && row[field] !== where[field]) {
          return { count: 0 };
        }
      }
      if (where.lockedAt?.gte && !(row.lockedAt >= where.lockedAt.gte)) return { count: 0 };
      rows.set(key, { ...row, ...data });
      return { count: 1 };
    }),
  };

  return { delegate, rows };
}

function configureChannelAutoPostScanRoute(service: ModerationService): void {
  const fixture = service as unknown as { maxBotLinkService?: Partial<MaxBotLinkService> };
  fixture.maxBotLinkService = {
    ...fixture.maxBotLinkService,
    resolveBotIdForCapability: jest
      .fn<
        ReturnType<MaxBotLinkService['resolveBotIdForCapability']>,
        Parameters<MaxBotLinkService['resolveBotIdForCapability']>
      >()
      .mockResolvedValue('777000_bot'),
  };
}

function configureDefaultChannelAutoPostEditRoute(service: ModerationService): void {
  (
    service as unknown as {
      maxBotLinkService: unknown;
    }
  ).maxBotLinkService = {
    isKnownBotUserId: jest.fn((userId: string) =>
      ['777000', '777000_bot'].includes(userId.trim().toLowerCase()),
    ),
    resolveBotRoutes: jest.fn((request: { purpose?: string; chatId?: string; action?: string }) =>
      Promise.resolve(
        request.purpose === 'moderation_action' && request.action === 'edit_message'
          ? {
              purpose: 'moderation_action',
              chatId: request.chatId ?? 'channel-1',
              primaryBotId: '777000_bot',
              botId: '777000_bot',
              candidateBotIds: ['777000_bot'],
              quarantinedCandidateBotIds: [],
              reason: 'primary_confirmed',
              action: 'edit_message',
            }
          : null,
      ),
    ),
    getExecutableBotById: jest.fn((botId: string) =>
      botId === '777000_bot' ? { id: botId, contactId: '777000' } : null,
    ),
    resolveContactIdSync: jest.fn((botId?: string | null) =>
      botId === '777000_bot' ? '777000' : null,
    ),
  };
}

function configureDefaultChannelAutoPostDeleteRoute(service: ModerationService): void {
  (
    service as unknown as {
      maxBotLinkService: unknown;
    }
  ).maxBotLinkService = {
    resolveDeleteMessageBotRoute: jest.fn((request: { chatId?: string }) =>
      Promise.resolve({
        purpose: 'moderation_action',
        chatId: request.chatId ?? 'channel-1',
        primaryBotId: '777000_bot',
        botId: '777000_bot',
        candidateBotIds: ['777000_bot'],
        reason: 'primary_confirmed',
        action: 'delete_message',
      }),
    ),
    getExecutableBotById: jest.fn((botId: string) =>
      botId === '777000_bot' ? { id: botId, contactId: '777000' } : null,
    ),
  };
}

describe('ModerationService channel auto post buttons', () => {
  beforeEach(() =>
    jest.spyOn(ChannelPostDemandRuntime.prototype, 'selectChannels').mockResolvedValue([]),
  );
  afterEach(() => jest.restoreAllMocks());
  it.each(['new', 'forward', 'old', 'revoked-before-edit'] as const)(
    'uses only an in-place edit for a marketplace-only %s post',
    async (scenario) => {
      const marker = createChannelAutoPostAttachMarkerMock();
      const prisma = {
        ...createChannelMutationGuardPrismaMock(),
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'channel-1',
            title: 'Channel',
            entityType: 'CHANNEL',
            channelSettings: {
              commentsEnabled: false,
              postSuggestionsEnabled: false,
              postSignatureEnabled: false,
              quickButtonsEnabled: false,
              updatedAt: new Date('2026-03-06T15:00:00Z'),
            },
            admins: [],
          }),
        },
        channelAutoPostAttachMarker: marker.delegate,
        auditLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      };
      const maxClient = {
        ...createChannelMutationGuardMaxClientMock(),
        getMarketplaceChannelPostActivation: jest
          .fn()
          .mockResolvedValue(
            new Date(scenario === 'old' ? '2026-03-06T16:00:00Z' : '2026-03-06T15:00:00Z'),
          ),
        getChatAdminIds: jest.fn().mockResolvedValue([]),
        editMessageInlineKeyboard: jest.fn().mockResolvedValue(scenario !== 'revoked-before-edit'),
        sendMessageCopyWithInlineKeyboard: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
      };
      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        createConfigMock() as never,
      );
      configureDefaultChannelAutoPostEditRoute(service);
      const update =
        scenario === 'forward'
          ? createForwardedChannelPostUpdate()
          : createChannelPostUpdateWithoutSender();
      await service.handleUpdate(update);
      if (scenario === 'old') expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
      else
        expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
          'channel-1',
          update.message!.messageId,
          scenario === 'forward' ? null : update.message!.text,
          expect.objectContaining({
            marketplaceChannelPost: {
              entityId: 'channel-1',
              sourceAt: update.message!.createdAt,
              only: true,
            },
            requireAllAttachmentsPreserved: true,
          }),
          expect.anything(),
        );
      expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      if (scenario === 'revoked-before-edit') expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );
  it.each(['webhook', 'poll'] as const)(
    'hands off a genuine first-edit route rejection without delivery or scan advancement: %s',
    async (source) => {
      const marker = createChannelAutoPostAttachMarkerMock();
      const prisma = {
        ...createChannelMutationGuardPrismaMock(),
        channelAutoPostAttachMarker: marker.delegate,
        auditLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      };
      const rejection = markMaxPreDispatchGuardRejected(
        Object.assign(new Error('MAX action executor proof changed during quota wait'), {
          code: 'max_action_executor_proof_rejected',
        }),
        MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
      );
      const maxClient = {
        ...createChannelMutationGuardMaxClientMock(),
        editMessageInlineKeyboard: jest.fn().mockRejectedValue(rejection),
      };
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        createConfigMock() as never,
        undefined,
        undefined,
        createAdminServiceMock() as never,
      );
      configureDefaultChannelAutoPostEditRoute(service);
      const input = {
        chatId: 'channel-1',
        messageId: 'deferred-edit',
        text: 'Post',
        linkType: null,
        managedChannel: { channelSettings: { commentsEnabled: true }, adminUserIds: [] },
        source,
        senderId: null,
        senderAdminVerified: false,
        allowSenderlessEngagement: true,
      };
      await expect((service as any).tryAutoAttachChannelMessageButtons(input)).resolves.toBe(
        'in_progress',
      );
      expect(marker.rows.get('channel-1:deferred-edit')).toMatchObject({
        status: 'IN_PROGRESS',
        deliveryMode: 'edit_message',
        lockToken: null,
        lockedAt: null,
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        lastError: 'Channel edit deferred before dispatch: max_action_executor_proof_rejected',
      });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
      maxClient.editMessageInlineKeyboard.mockImplementation(
        async (_chat, _message, _text, options) => {
          await options.beforeEditMutation();
        },
      );
      await expect(
        (service as any).tryAutoAttachChannelMessageButtons({ ...input, source: 'poll' }),
      ).resolves.toBe('attached');
      expect(marker.rows.get('channel-1:deferred-edit')).toMatchObject({ status: 'SUCCEEDED' });
    },
  );

  it.each([
    'forged',
    'other_guard',
    'ambiguous',
    'lost_lease',
    'expired_lease',
    'persistence_failed',
    'forward',
    'quick_buttons',
  ] as const)('does not complete a channel edit handoff with %s evidence', async (failure) => {
    const marker = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: marker.delegate,
      auditLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    let rejection: unknown = Object.assign(
      new Error(failure === 'ambiguous' ? 'timeout' : 'route changed'),
      {
        code:
          failure === 'other_guard'
            ? MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE
            : 'max_action_executor_proof_rejected',
      },
    );
    if (failure !== 'forged')
      rejection = markMaxPreDispatchGuardRejected(
        rejection,
        MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
      );
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn(async () => {
        const row = marker.rows.get('channel-1:rejected-edit')!;
        if (failure === 'lost_lease') row.lockToken = 'another-owner';
        if (failure === 'expired_lease') row.lockedAt = new Date(Date.now() - 121_000);
        if (failure === 'persistence_failed')
          marker.delegate.updateMany.mockRejectedValueOnce(new Error('DB unavailable'));
        throw rejection;
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    configureDefaultChannelAutoPostEditRoute(service);
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'rejected-edit',
        text: 'Post',
        linkType: failure === 'forward' ? 'forward' : null,
        ...(failure === 'quick_buttons' ? { quickButtons: { buttons: [], text: 'Post' } } : {}),
        managedChannel: { channelSettings: { commentsEnabled: true }, adminUserIds: [] },
        source: 'webhook',
        senderId: null,
        senderAdminVerified: false,
        allowSenderlessEngagement: true,
      }),
    ).rejects.toThrow();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(marker.rows.get('channel-1:rejected-edit')?.lastError).not.toBe(
      'Channel edit deferred before dispatch: max_action_executor_proof_rejected',
    );
  });

  it.each(['webhook', 'poll'])(
    'skips an exactly held senderless %s source before marker or route work',
    async (source) => {
      const isMessageHeld = jest.fn().mockResolvedValue(true);
      const claimChannelAutoPost = jest.fn();
      const resolveAutoAttachBotId = jest.fn();
      const editMessageInlineKeyboard = jest.fn();
      const service = Object.assign(Object.create(ModerationService.prototype), {
        legacyHolds: { isMessageHeld },
        replacementAttachMarkerStore: { claimChannelAutoPost },
        resolveAutoAttachBotId,
        maxClient: { editMessageInlineKeyboard },
      });
      expect(
        await service.tryAutoAttachChannelMessageButtons({
          chatId: '-held-channel',
          messageId: 'held-message',
          text: null,
          linkType: null,
          managedChannel: { channelSettings: {}, adminUserIds: [] },
          source,
          senderId: null,
          senderAdminVerified: false,
          allowSenderlessEngagement: true,
        }),
      ).toBe('skipped');
      expect(isMessageHeld).toHaveBeenCalledWith('-held-channel', 'held-message');
      expect(claimChannelAutoPost).not.toHaveBeenCalled();
      expect(resolveAutoAttachBotId).not.toHaveBeenCalled();
      expect(editMessageInlineKeyboard).not.toHaveBeenCalled();
    },
  );
  it.each([
    { text: 'Post "Read"="https://example.com"', expectedText: 'Post ' },
    { text: 'Post\nRead = https://example.com', expectedText: 'Post\n' },
    { text: 'Post\nRead =\nhttps://example.com', expectedText: 'Post\n' },
  ])('converts channel templates and respects the toggle (%#)', async ({ text, expectedText }) => {
    const settings = {
      quickButtonsEnabled: true,
      commentsEnabled: false,
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: 'Suggest',
      updatedAt: new Date('2026-03-01T00:00:00Z'),
    };
    const marker = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
      channelAutoPostAttachMarker: marker.delegate,
      auditLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageCopyWithInlineKeyboard: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    configureDefaultChannelAutoPostEditRoute(service);
    const update = createChannelPostUpdateWithoutSender();
    (update.raw as any).message.body.text = text;
    const context = { channelSettings: settings, adminUserIds: ['admin-1'] };
    await (service as any).handleChannelUpdate(update, context);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      update.message!.messageId,
      expectedText,
      expect.objectContaining({
        textFormat: 'html',
        expectedSourceText: text,
        requireAllAttachmentsPreserved: true,
        mergeExistingInlineKeyboard: true,
        buttons: [[{ type: 'link', text: 'Read', url: 'https://example.com/' }]],
      }),
      expectChannelAutoPostOptions(),
    );
    const options = (maxClient.editMessageInlineKeyboard.mock.calls as any)[0][3];
    await expect(options.beforeEditMutation()).resolves.toBeUndefined();
    expect(usesMaxFinalAuthorityCheckpoint(options.beforeEditMutation)).toBe(true);
    const beforeFinalAuthority = jest.fn(async () => {
      settings.quickButtonsEnabled = false;
    });
    await expect(options.beforeEditMutation(beforeFinalAuthority)).rejects.toThrow('disabled');
    expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
    settings.quickButtonsEnabled = true;
    await (service as any).handleChannelUpdate(update, context);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    settings.quickButtonsEnabled = false;
    await expect(options.beforeEditMutation()).rejects.toThrow('disabled');
    maxClient.editMessageInlineKeyboard.mockClear();
    await (service as any).handleChannelUpdate(update, context);
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    settings.quickButtonsEnabled = true;
    settings.updatedAt = new Date('2026-03-07T00:00:00Z');
    update.message!.messageId = 'old-post-before-toggle';
    await (service as any).handleChannelUpdate(update, context);
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('auto-attaches fresh runtime-bot and admin-authored channel posts', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsEntryMode: 'BOT',
            postSuggestionsButtonText: 'Прислать новость',
            commentsEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createRuntimeBotChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '💬 Комментарии · 0',
              url: expect.stringContaining('https://max.ru/777000_bot?startapp='),
            }),
          ],
          [
            expect.objectContaining({
              type: 'link',
              text: 'Прислать новость',
              url: expect.stringContaining('https://max.ru/777000_bot?start='),
            }),
          ],
        ],
      }),
      expectChannelAutoPostOptions(),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'channel-1',
          actorUserId: '777000',
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
          payload: expect.objectContaining({
            messageId: 'mid-channel-1',
            publishedUrl: 'https://max.ru/chats/channel-1/message/mid-channel-1',
            suggestButtonText: 'Прислать новость',
            text: 'Новый пост в канале',
          }),
        }),
      }),
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3]).not.toHaveProperty(
      'appendNewInlineKeyboardRows',
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();

    const manualAdminPost = createRuntimeBotChannelPostUpdate();
    manualAdminPost.updateId = 'upd-channel-human-admin-1';
    manualAdminPost.message!.messageId = 'mid-channel-human-admin-1';
    manualAdminPost.message!.senderId = 'admin-1';
    (manualAdminPost.raw as any).message.sender = {
      user_id: 'admin-1',
      is_bot: false,
    };
    await service.handleUpdate(manualAdminPost);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);

    maxClient.editMessageInlineKeyboard.mockClear();
    prisma.auditLog.create.mockClear();
    const existingThreadId = '12345678-1234-4123-8123-123456789abc';
    const existingToken = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: existingThreadId, s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    const existingButtonsUpdate = createRuntimeBotChannelPostUpdate();
    existingButtonsUpdate.updateId = 'upd-channel-existing-buttons';
    existingButtonsUpdate.message!.messageId = 'mid-channel-existing-buttons';
    (existingButtonsUpdate.raw as any).message.body = {
      mid: 'mid-channel-existing-buttons',
      text: 'Пост с готовыми кнопками',
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                {
                  type: 'link',
                  text: 'Комментарии',
                  url: `https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=${existingToken}`,
                },
              ],
              [
                {
                  type: 'link',
                  text: 'Прислать новость',
                  url: `https://max.ru/777000_bot?start=cds-channel-1.${existingThreadId.replaceAll(
                    '-',
                    '',
                  )}.${'a'.repeat(24)}`,
                },
              ],
            ],
          },
        },
      ],
    };

    await service.handleUpdate(existingButtonsUpdate);

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('opens channel suggestions in the mini app when admins select mini app mode', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsEntryMode: 'MINIAPP',
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createRuntimeBotChannelPostUpdate());

    const options = maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3];
    const suggestButton = options?.buttons?.[1]?.[0];
    expect(suggestButton).toMatchObject({
      type: 'link',
      text: '📰 Предложить пост',
    });
    expect(suggestButton?.url).toContain('https://max.ru/777000_bot?startapp=');
    expect(new URL(suggestButton.url).searchParams.get('startapp')).toBeTruthy();
    expect(new URL(suggestButton.url).searchParams.get('start')).toBeNull();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            suggestionEntryMode: 'MINIAPP',
          }),
        }),
      }),
    );
  });

  it('does not auto-attach comments when channel settings are auto-created with fresh defaults', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: null,
          admins: [],
        }),
        update: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
          },
          admins: [
            {
              userId: 'admin-1',
            },
          ],
        }),
      },
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );

    await service.handleUpdate(createRuntimeBotChannelPostUpdate());

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'channel-1' },
        data: expect.objectContaining({
          channelSettings: {
            upsert: {
              update: {},
              create: {
                commentsEnabled: false,
              },
            },
          },
        }),
      }),
    );
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('auto-attaches configured buttons to a senderless post through the fresh channel edit route', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
          },
          admins: [],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeEditMutation?: () => Promise<void> },
        ) => {
          await options.beforeEditMutation?.();
        },
      ),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createChannelPostUpdateWithoutSender());

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
      botId: '777000_bot',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('channel-1', {
      botId: '777000_bot',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-no-sender-1',
      'Новый пост без senderId',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
            }),
          ],
        ],
      }),
      expectChannelAutoPostOptions({ botId: '777000_bot' }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'system',
        payload: expect.objectContaining({
          includeCommentsButton: false,
          includeSuggestButton: true,
        }),
      }),
    });
  });

  it('keeps senderless legacy recovery blocked before resolving an edit route', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    configureDefaultChannelAutoPostEditRoute(service);
    const resolveMutationBot = jest.spyOn(service as any, 'resolveAutoAttachMutationBotId');

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-legacy-recovery-no-sender-1',
        text: null,
        textFormat: null,
        linkType: null,
        existingDialogButtonKinds: [],
        existingDialogThreadId: null,
        managedChannel: {
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            postSignatureEnabled: false,
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: null,
        senderAdminVerified: false,
        allowSenderlessEngagement: false,
      }),
    ).resolves.toBe('skipped');

    expect(resolveMutationBot).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(['', 'admin-1', 'source-author-1'])(
    'attaches forward buttons in place with an edit-only bot and sender %j',
    async (senderId) => {
      const prisma = {
        ...createChannelMutationGuardPrismaMock(),
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'channel-1',
            title: 'Ищу модель | Ростов',
            entityType: 'CHANNEL',
            channelSettings: {
              postSuggestionsEnabled: true,
              postSuggestionsButtonText: 'Предложить пост',
              commentsEnabled: true,
            },
            admins: [],
          }),
        },
        auditLog: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(undefined),
        },
      };
      const ruleEngine = {
        detect: jest.fn(),
      };
      const sanctionService = {
        resolveAction: jest.fn(),
      };
      const maxClient = {
        ...createChannelMutationGuardMaxClientMock(),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          isAdmin: true,
          isOwner: false,
          permissions: ['edit_message'],
        }),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
        sendMessageCopyWithInlineKeyboard: jest.fn().mockResolvedValue({
          messageId: 'mid-forward-copy-1',
          url: 'https://max.ru/chats/channel-1/message/1001',
        }),
        sendMessageReplyWithInlineKeyboard: jest.fn().mockResolvedValue(undefined),
        deleteMessage: jest.fn().mockResolvedValue(undefined),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const adminService = createAdminServiceMock();

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
        undefined,
        undefined,
        createConfigMock() as never,
        undefined,
        undefined,
        adminService as never,
      );

      configureDefaultChannelAutoPostEditRoute(service);
      await service.handleUpdate(createForwardedChannelPostUpdate(senderId));

      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
        'channel-1',
        'mid-channel-forward-no-sender-1',
        null,
        expect.objectContaining({
          buttons: [
            [expect.objectContaining({ text: '💬 Комментарии · 0' })],
            [expect.objectContaining({ text: 'Предложить пост' })],
          ],
          requireAllAttachmentsPreserved: true,
          mergeExistingInlineKeyboard: true,
          beforeEditMutation: expect.any(Function),
        }),
        expectChannelAutoPostOptions(),
      );
      await (maxClient.editMessageInlineKeyboard.mock.calls[0] as any)[3].beforeEditMutation();
      expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
      expect(maxClient.sendMessageReplyWithInlineKeyboard).not.toHaveBeenCalled();
      expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payload: expect.objectContaining({ deliveryMode: 'edit_message', linkType: 'forward' }),
          }),
        }),
      );
    },
  );

  it('rechecks the entity immediately before publishing a forwarded post copy', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ entityType: 'CHANNEL' })
          .mockResolvedValueOnce({ entityType: 'CHAT' }),
      },
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    let maxPostStarted = false;
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      sendMessageCopyWithInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeSend?: () => Promise<void> },
        ) => {
          await options.beforeSend?.();
          maxPostStarted = true;
          return { messageId: 'must-not-be-created', url: null };
        },
      ),
      deleteMessage: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostDeleteRoute(service);
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-forward-race-1',
        text: 'Пересланный пост',
        linkType: 'forward',
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: 'admin-1',
        senderAdminVerified: true,
      }),
    ).resolves.toBe('skipped');

    expect(prisma.chat.findUnique).toHaveBeenCalledTimes(2);
    expect(maxPostStarted).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(markerMock.rows.get('channel-1:mid-channel-forward-race-1')).toMatchObject({
      status: 'SKIPPED',
      replacementSendStartedAt: null,
      replacementMessageId: null,
      originalDeleted: false,
    });
  });

  it('does not publish a forwarded copy when fresh MAX metadata classifies the target as a chat', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    let maxPostStarted = false;
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'chat' }),
      sendMessageCopyWithInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeSend?: () => Promise<void> },
        ) => {
          await options.beforeSend?.();
          maxPostStarted = true;
          return { messageId: 'must-not-be-created', url: null };
        },
      ),
      deleteMessage: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostDeleteRoute(service);
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-forward-remote-chat-1',
        text: 'Пересланный пост',
        linkType: 'forward',
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: 'admin-1',
        senderAdminVerified: true,
      }),
    ).resolves.toBe('skipped');

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
      botId: '777000_bot',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(maxPostStarted).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not publish a forwarded copy when the sender is no longer a MAX admin', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    let maxPostStarted = false;
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'admin-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      sendMessageCopyWithInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeSend?: () => Promise<void> },
        ) => {
          await options.beforeSend?.();
          maxPostStarted = true;
          return { messageId: 'must-not-be-created', url: null };
        },
      ),
      deleteMessage: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostDeleteRoute(service);
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-forward-demoted-admin-1',
        text: 'Пересланный пост',
        linkType: 'forward',
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: 'admin-1',
        senderAdminVerified: true,
      }),
    ).resolves.toBe('skipped');

    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('channel-1', 'admin-1', {
      botId: '777000_bot',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxPostStarted).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not publish a forwarded copy when the route bot lacks live channel delete access', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    let maxPostStarted = false;
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: '777000',
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'delete_message'],
        })
        .mockResolvedValueOnce({
          userId: '777000',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        }),
      sendMessageCopyWithInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeSend?: () => Promise<void> },
        ) => {
          await options.beforeSend?.();
          maxPostStarted = true;
          return { messageId: 'must-not-be-created', url: null };
        },
      ),
      deleteMessage: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    configureDefaultChannelAutoPostDeleteRoute(service);

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-forward-no-live-delete-1',
        text: 'Пересланный пост',
        linkType: 'forward',
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: 'admin-1',
        senderAdminVerified: true,
      }),
    ).resolves.toBe('skipped');

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('channel-1', {
      botId: '777000_bot',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxPostStarted).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(markerMock.rows.get('channel-1:mid-channel-forward-no-live-delete-1')).toMatchObject({
      status: 'SKIPPED',
      replacementSendStartedAt: null,
      replacementMessageId: null,
      originalDeleted: false,
    });
  });

  it('uses fresh MAX entity and sender checks before both forward copy and cleanup', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      sendMessageCopyWithInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeSend?: () => Promise<void> },
        ) => {
          await options.beforeSend?.();
          return {
            messageId: 'mid-channel-forward-safe-copy-1',
            url: 'https://max.ru/chats/channel-1/message/mid-channel-forward-safe-copy-1',
          };
        },
      ),
      deleteMessage: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          options: { beforeImmediateDeleteMutation?: () => Promise<void> },
        ) => {
          await options.beforeImmediateDeleteMutation?.();
        },
      ),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostDeleteRoute(service);
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-forward-safe-1',
        text: 'Пересланный пост',
        linkType: 'forward',
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: 'admin-1',
        senderAdminVerified: true,
      }),
    ).resolves.toBe('attached');

    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
      botId: '777000_bot',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('channel-1', {
      botId: '777000_bot',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('channel-1', 'admin-1', {
      botId: '777000_bot',
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      timeoutMs: 2_000,
    });
    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('does not edit a post when fresh MAX metadata classifies the target as a chat', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    let maxEditStarted = false;
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'chat' }),
      editMessageInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeEditMutation?: () => Promise<void> },
        ) => {
          try {
            await options.beforeEditMutation?.();
          } catch (error: unknown) {
            throw markMaxPreDispatchGuardRejected(error, MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE);
          }
          maxEditStarted = true;
        },
      ),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-edit-remote-chat-1',
        text: 'Пост',
        linkType: null,
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: '777000',
        senderAdminVerified: false,
        requiredAuthorUserId: '777000',
      }),
    ).resolves.toBe('skipped');

    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(maxEditStarted).toBe(false);
    expect(markerMock.rows.get('channel-1:mid-channel-edit-remote-chat-1')).toMatchObject({
      status: 'SKIPPED',
      replacementMessageId: null,
      originalDeleted: false,
    });
  });

  it('skips an edit before marker claim when the route bot lacks live edit access', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '777000',
        isAdmin: true,
        isOwner: false,
        permissions: ['write', 'delete_message'],
      }),
      editMessageInlineKeyboard: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-edit-no-live-access-1',
        text: 'Пост',
        linkType: null,
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: [],
        },
        source: 'poll',
        senderId: '777000',
        senderAdminVerified: false,
        requiredAuthorUserId: '777000',
      }),
    ).resolves.toBe('skipped');

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(markerMock.delegate.findUnique).not.toHaveBeenCalled();
    expect(markerMock.delegate.createMany).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('rechecks live edit access in the final callback before editing a channel post', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    let maxEditStarted = false;
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: '777000',
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'edit_message'],
        })
        .mockResolvedValueOnce({
          userId: '777000',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        }),
      editMessageInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeEditMutation?: () => Promise<void> },
        ) => {
          try {
            await options.beforeEditMutation?.();
          } catch (error: unknown) {
            throw markMaxPreDispatchGuardRejected(error, MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE);
          }
          maxEditStarted = true;
        },
      ),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-edit-access-race-1',
        text: 'Пост',
        linkType: null,
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: [],
        },
        source: 'poll',
        senderId: '777000',
        senderAdminVerified: false,
        requiredAuthorUserId: '777000',
      }),
    ).resolves.toBe('skipped');

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxEditStarted).toBe(false);
    expect(markerMock.rows.get('channel-1:mid-channel-edit-access-race-1')).toMatchObject({
      status: 'SKIPPED',
      replacementMessageId: null,
      originalDeleted: false,
    });
  });

  it('allows an ordinary channel edit without requiring a bot-author match', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    configureDefaultChannelAutoPostEditRoute(service);

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-edit-missing-author-1',
        text: 'Пост',
        linkType: null,
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: [],
        },
        source: 'poll',
        senderId: 'admin-1',
      }),
    ).resolves.toBe('attached');

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
  });

  it('leaves forwarded rich text untouched while attaching buttons', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: 'Предложить пост',
            commentsEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageCopyWithInlineKeyboard: jest.fn().mockResolvedValue({
        messageId: 'mid-forward-rich-copy-1',
        url: 'https://max.ru/chats/channel-1/message/1003',
      }),
      sendMessageReplyWithInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createRichForwardedChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-rich-no-sender-1',
      null,
      expect.objectContaining({
        textFormat: 'html',
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [expect.objectContaining({ text: 'Предложить пост' })],
        ],
      }),
      expectChannelAutoPostOptions(),
    );
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('auto-attaches comments and suggestions when both features are enabled', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createRuntimeBotChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [expect.objectContaining({ text: '📰 Предложить пост' })],
        ],
      }),
      expectChannelAutoPostOptions(),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            includeCommentsButton: true,
            includeSuggestButton: true,
          }),
        }),
      }),
    );
  });

  it('preserves the forward after rejected keyboard edits without publishing a replacement', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockRejectedValue({
        response: { status: 400 },
        message: 'cannot edit forwarded message',
      }),
      sendMessageCopyWithInlineKeyboard: jest.fn().mockRejectedValue({
        response: {
          status: 400,
        },
        message: 'cannot replace forwarded message',
      }),
      sendMessageImmediateWithResolvedLink: jest.fn(),
      sendMessageReplyWithInlineKeyboard: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createForwardedChannelPostUpdate('admin-1'));

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(maxClient.sendMessageReplyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED',
          payload: expect.objectContaining({
            deliveryMode: 'edit_message',
            linkType: 'forward',
            reason: 'terminal_delivery_failure',
            status: 400,
          }),
        }),
      }),
    );
  });

  it('does not use a scan bot when the forward delete route has no candidates', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: 'CHANNEL' }),
      },
      channelAutoPostAttachMarker: {
        findUnique: jest.fn(),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      sendMessageCopyWithInlineKeyboard: jest.fn().mockRejectedValue({
        response: {
          status: 400,
        },
        message: 'cannot replace forwarded message',
      }),
      sendMessageReplyWithInlineKeyboard: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const maxBotLinkService = {
      resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'primary-bot',
        botId: null,
        candidateBotIds: [],
        quarantinedCandidateBotIds: [],
        reason: 'no_confirmed_candidate',
        action: 'delete_message',
      }),
      resolveBotIdForCapability: jest.fn().mockResolvedValue('scan-bot-2'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string) => `https://max.ru/entry-bot?startapp=${startParam}`,
        ),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-forward-multi-1',
      text: 'Пересланный пост',
      textFormat: null,
      linkType: 'forward',
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-03-06T15:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsEntryMode: 'MINIAPP',
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: 'admin-1',
      senderAdminVerified: true,
    });

    expect(maxBotLinkService.resolveDeleteMessageBotRoute).toHaveBeenCalledWith({
      chatId: 'channel-1',
      expectedEntityType: 'CHANNEL',
      requireFreshSnapshot: true,
    });
    expect(maxBotLinkService.resolveBotIdForCapability).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageReplyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.channelAutoPostAttachMarker.findUnique).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('selects the first executable forward route with both delete and write access', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getCurrentChatMemberAccess: jest.fn(async (_chatId: string, options: { botId: string }) => ({
        userId: options.botId,
        isAdmin: true,
        isOwner: false,
        permissions:
          options.botId === 'writable-delete-bot'
            ? ['write', 'delete_message']
            : ['delete_message'],
      })),
      sendMessageCopyWithInlineKeyboard: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          _text: string,
          options: { beforeSend?: () => Promise<void> },
        ) => {
          await options.beforeSend?.();
          return {
            messageId: 'mid-channel-forward-writable-copy-1',
            url: 'https://max.ru/chats/channel-1/message/mid-channel-forward-writable-copy-1',
          };
        },
      ),
      deleteMessage: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          options: { beforeImmediateDeleteMutation?: () => Promise<void> },
        ) => {
          await options.beforeImmediateDeleteMutation?.();
        },
      ),
    };
    const adminService = createAdminServiceMock();
    const maxBotLinkService = {
      resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'delete-only-bot',
        botId: 'delete-only-bot',
        candidateBotIds: ['delete-only-bot', 'writable-delete-bot'],
        reason: 'primary_confirmed',
        action: 'delete_message',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId, contactId: botId })),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-forward-writable-1',
        text: 'Пересланный пост',
        linkType: 'forward',
        managedChannel: {
          channelSettings: {
            commentsEnabled: false,
            postSuggestionsEnabled: true,
            postSuggestionsEntryMode: 'BOT',
            postSuggestionsButtonText: 'Предложить пост',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: 'admin-1',
        senderAdminVerified: true,
      }),
    ).resolves.toBe('attached');

    expect(maxClient.getCurrentChatMemberAccess.mock.calls.map((call) => call[1].botId)).toEqual([
      'delete-only-bot',
      'writable-delete-bot',
      'writable-delete-bot',
      'writable-delete-bot',
    ]);
    expect(adminService.buildChannelSuggestionStartPayload).toHaveBeenCalledWith(
      'channel-1',
      expect.any(String),
      'writable-delete-bot',
    );
    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-writable-1',
      'Пересланный пост',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              url: expect.stringContaining('https://max.ru/writable-delete-bot?start='),
            }),
          ],
        ],
      }),
      expectChannelAutoPostOptions({ botId: 'writable-delete-bot' }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-writable-1',
      expect.objectContaining({ botId: 'writable-delete-bot' }),
    );
    expect(markerMock.rows.get('channel-1:mid-channel-forward-writable-1')).toMatchObject({
      botId: 'writable-delete-bot',
      replacementMessageId: 'mid-channel-forward-writable-copy-1',
      originalDeleted: true,
    });
  });

  it('skips a forwarded replacement before marker claim when every route is delete-only', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: markerMock.delegate,
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getCurrentChatMemberAccess: jest.fn(async (_chatId: string, options: { botId: string }) => ({
        userId: options.botId,
        isAdmin: true,
        isOwner: false,
        permissions: ['delete_message'],
      })),
      sendMessageCopyWithInlineKeyboard: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const maxBotLinkService = {
      resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'delete-only-bot-1',
        botId: 'delete-only-bot-1',
        candidateBotIds: ['delete-only-bot-1', 'delete-only-bot-2'],
        reason: 'primary_confirmed',
        action: 'delete_message',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId, contactId: botId })),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-forward-delete-only-1',
        text: 'Пересланный пост',
        linkType: 'forward',
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: 'admin-1',
        senderAdminVerified: true,
      }),
    ).resolves.toBe('skipped');

    expect(maxClient.getCurrentChatMemberAccess.mock.calls.map((call) => call[1].botId)).toEqual([
      'delete-only-bot-1',
      'delete-only-bot-2',
    ]);
    expect(markerMock.delegate.findUnique).not.toHaveBeenCalled();
    expect(markerMock.delegate.createMany).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('treats a channel owner with delete access as inherently able to publish', async () => {
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'owner-bot',
        isAdmin: true,
        isOwner: true,
        permissions: ['delete_message'],
      }),
    };
    const maxBotLinkService = {
      resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue({
        candidateBotIds: ['owner-bot'],
      }),
      getExecutableBotById: jest.fn().mockReturnValue({
        id: 'owner-bot',
        contactId: 'owner-bot',
      }),
    };
    const service = new ModerationService(
      createChannelMutationGuardPrismaMock() as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      (service as any).resolveAutoAttachMutationBotId({
        chatId: 'channel-1',
        action: 'delete_message',
      }),
    ).resolves.toEqual({ botId: 'owner-bot', requiredAuthorVerified: true });
  });

  it('does not auto-attach when comments and suggestions are disabled', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
          },
          admins: [],
        }),
      },
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );

    await service.handleUpdate(createRuntimeBotChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('appends the configured signature to a bot-authored channel post without engagement buttons', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Наука и Факты',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
            commentsEnabled: false,
            postSignatureEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn(prepareLockedEditText),
    };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: 'Новый пост в канале\n\n<a href="https://max.ru/science">Наука и Факты</a>',
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createRuntimeBotChannelPostUpdate());

    expect(channelPostSignatureService.preparePostText).toHaveBeenCalledWith(
      'channel-1',
      { text: 'Новый пост в канале' },
      {
        botId: '777000_bot',
        entityType: 'channel',
        trafficClass: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [],
        prepareMessageText: expect.any(Function),
        preserveExistingInlineKeyboard: true,
      }),
      expectChannelAutoPostOptions(),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          messageId: 'mid-channel-1',
          signatureApplied: true,
          includeCommentsButton: false,
          includeSuggestButton: false,
        }),
      }),
    });
  });

  it('appends the configured signature to an admin-authored channel post', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Наука и Факты',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
            commentsEnabled: false,
            postSignatureEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn(prepareLockedEditText),
    };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: 'Новый пост в канале\n\n<a href="https://max.ru/science">Наука и Факты</a>',
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;
    configureDefaultChannelAutoPostEditRoute(service);

    const update = createRuntimeBotChannelPostUpdate();
    update.updateId = 'upd-channel-admin-signature-1';
    update.message!.messageId = 'mid-channel-admin-signature-1';
    update.message!.senderId = 'admin-1';
    (update.raw as any).message.sender = { user_id: 'admin-1', is_bot: false };
    await service.handleUpdate(update);

    expect(channelPostSignatureService.preparePostText).toHaveBeenCalledWith(
      'channel-1',
      { text: 'Новый пост в канале' },
      {
        botId: '777000_bot',
        entityType: 'channel',
        trafficClass: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-admin-signature-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [],
        prepareMessageText: expect.any(Function),
        preserveExistingInlineKeyboard: true,
      }),
      expectChannelAutoPostOptions(),
    );
  });

  it('repairs a signature and adds configured buttons when MAX omits sender metadata', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Наука и Факты',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: 'Предложить пост',
            commentsEnabled: true,
            postSignatureEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn(prepareLockedEditText),
    };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: 'Новый пост без senderId\n\n<a href="https://max.ru/science">Наука и Факты</a>',
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;
    configureDefaultChannelAutoPostEditRoute(service);

    await service.handleUpdate(createChannelPostUpdateWithoutSender());

    expect(channelPostSignatureService.preparePostText).toHaveBeenCalledWith(
      'channel-1',
      { text: 'Новый пост без senderId' },
      {
        botId: '777000_bot',
        entityType: 'channel',
        trafficClass: 'background',
        sourceTag: 'channel_auto_post',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-no-sender-1',
      'Новый пост без senderId',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [expect.objectContaining({ text: 'Предложить пост' })],
        ],
        prepareMessageText: expect.any(Function),
      }),
      expectChannelAutoPostOptions(),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        actorUserId: 'system',
        payload: expect.objectContaining({
          signatureApplied: true,
          includeCommentsButton: true,
          includeSuggestButton: true,
        }),
      }),
    });
  });

  it('adds the channel CTA after comments and freezes the managed keyboard for counters', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: '<b>Пост</b>',
        textFormat: 'html',
        signatureApplied: false,
      }),
      buildPostButton: jest.fn().mockResolvedValue({
        type: 'link',
        text: '📞 Заказать рекламу',
        url: 'https://ads.example/contact',
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;
    configureDefaultChannelAutoPostEditRoute(service);

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-combined-1',
      text: '**Пост**',
      textFormat: 'markdown',
      linkType: null,
      managedChannel: {
        channelSettings: {
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
          postSignatureEnabled: true,
        },
        adminUserIds: ['admin-1'],
      },
      source: 'webhook',
      senderId: '777000',
      requiredAuthorUserId: '777000',
    });

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-combined-1',
      '**Пост**',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [
            {
              type: 'link',
              text: '📞 Заказать рекламу',
              url: 'https://ads.example/contact',
            },
          ],
        ],
        textFormat: 'markdown',
      }),
      expectChannelAutoPostOptions(),
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3]).not.toHaveProperty(
      'preserveExistingInlineKeyboard',
    );
    await expect(
      maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3].prepareMessageText({
        body: { text: 'Updated by the author after the webhook' },
      }),
    ).resolves.toBeNull();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          buttonRows: [
            [expect.objectContaining({ text: '💬 Комментарии · 0' })],
            [
              {
                type: 'link',
                text: '📞 Заказать рекламу',
                url: 'https://ads.example/contact',
              },
            ],
          ],
          commentsButton: {
            rowIndex: 0,
            columnIndex: 0,
            baseText: '💬 Комментарии',
          },
          signatureApplied: false,
        }),
      }),
    });
  });

  it('releases the claimed marker when preparing a CTA fails transiently', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    const error = new Error('Temporary link lookup failure');
    (service as any).channelPostSignatureService = {
      buildPostButton: jest.fn().mockRejectedValue(error),
    };
    configureDefaultChannelAutoPostEditRoute(service);
    const release = jest.spyOn(
      (service as any).replacementAttachMarkerStore,
      'releaseChannelAutoPost',
    );
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'cta-failure',
        text: 'Post',
        linkType: null,
        managedChannel: {
          channelSettings: {
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            postSignatureEnabled: true,
            postSignaturePresentation: 'BUTTON',
          },
          adminUserIds: [],
        },
        source: 'webhook',
        senderId: '777000',
      }),
    ).rejects.toBe(error);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'cta-failure' }));
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('does not duplicate a signature after an ambiguous successful edit is retried', async () => {
    const marker = createChannelAutoPostAttachMarkerMock();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelAutoPostAttachMarker: marker.delegate,
      channelSettings: {
        findUnique: jest.fn().mockResolvedValue({
          postSignatureEnabled: true,
          postSignatureText: 'Наука и Факты',
        }),
      },
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: 'CHANNEL' }),
      },
      channelAudienceSnapshot: {
        findFirst: jest.fn().mockResolvedValue({ link: 'https://max.ru/science' }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ambiguousEditError = new Error('MAX edit response timed out');
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest
        .fn(prepareLockedEditText)
        .mockRejectedValueOnce(ambiguousEditError),
    };
    const channelPostSignatureService = new ChannelPostSignatureService(
      prisma as never,
      maxClient as never,
      {} as never,
    );
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;
    configureDefaultChannelAutoPostEditRoute(service);
    const params = {
      chatId: 'channel-1',
      messageId: 'mid-signature-timeout-1',
      linkType: null,
      managedChannel: {
        channelSettings: {
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
          postSignatureEnabled: true,
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '777000',
      requiredAuthorUserId: '777000',
    } as const;

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        ...params,
        text: 'Пост',
      }),
    ).rejects.toBe(ambiguousEditError);
    expect(marker.rows.get('channel-1:mid-signature-timeout-1')).toMatchObject({
      status: 'IN_PROGRESS',
      deliveryMode: 'edit_message',
      lockToken: null,
      lockedAt: null,
    });

    const prepareFreshText =
      maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3]?.prepareMessageText;
    if (!prepareFreshText) throw new Error('Expected locked text preparation');
    await expect(
      prepareFreshText({
        body: {
          text: 'Updated post',
          markup: [{ type: 'strong', from: 0, length: 7 }],
        },
      }),
    ).resolves.toMatchObject({
      text: '<strong>Updated</strong> post\n\n<a href="https://max.ru/science">Наука и Факты</a>',
      textFormat: 'html',
      signatureApplied: true,
    });
    await expect(
      prepareFreshText({
        body: {
          text: 'Post\n\nНаука и Факты',
          markup: [
            {
              type: 'link',
              from: 6,
              length: 'Наука и Факты'.length,
              url: 'https://max.ru/science',
            },
          ],
        },
      }),
    ).resolves.toBeNull();
    await expect(prepareFreshText(null)).rejects.toThrow('snapshot is unavailable');

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        ...params,
        text: 'Пост\n\n<a href="https://max.ru/science">Наука и Факты</a>',
        textFormat: 'html',
      }),
    ).resolves.toBe('attached');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
    expect(marker.rows.get('channel-1:mid-signature-timeout-1')).toMatchObject({
      status: 'SUCCEEDED',
      deliveryMode: 'edit_message',
    });
    await expect(maxClient.editMessageInlineKeyboard.mock.results[1]!.value).resolves.toBeNull();
  });

  it('terminally skips a local signature validation failure', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn(prepareLockedEditText),
    };
    const channelPostSignatureService = {
      preparePostText: jest
        .fn()
        .mockRejectedValue(new BadRequestException('Текст вместе с подписью слишком длинный.')),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;
    configureDefaultChannelAutoPostEditRoute(service);

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-signature-too-long-1',
        text: 'Пост',
        linkType: null,
        managedChannel: {
          channelSettings: {
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
            postSignatureEnabled: true,
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: '777000',
        requiredAuthorUserId: '777000',
      }),
    ).resolves.toBe('skipped');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED',
        payload: expect.objectContaining({
          messageId: 'mid-signature-too-long-1',
          status: 400,
        }),
      }),
    });
  });

  it('auto-attaches the comments button when comments are enabled', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createRuntimeBotChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0' })]],
      }),
      expectChannelAutoPostOptions(),
    );
  });

  it('auto-attaches the suggestion button when suggestions are enabled', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: false,
          },
          admins: [{ userId: 'admin-1' }],
        }),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    await service.handleUpdate(createRuntimeBotChannelPostUpdate());

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
              url: expect.stringContaining('https://max.ru/777000_bot?start='),
            }),
          ],
        ],
      }),
      expectChannelAutoPostOptions(),
    );
  });

  it('uses the existing comments thread and explicit edit bot when poll repair adds suggestions', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoutes: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'scan-bot-2',
        botId: 'scan-bot-2',
        candidateBotIds: ['scan-bot-2'],
        quarantinedCandidateBotIds: [],
        reason: 'primary_confirmed',
        action: 'edit_message',
      }),
      getExecutableBotById: jest.fn((botId: string) =>
        botId === 'scan-bot-2' ? { id: botId, contactId: '777000' } : null,
      ),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-1',
      text: 'Новый пост в канале',
      linkType: null,
      existingDialogButtonKinds: ['comments'],
      existingDialogThreadId: 'existing-thread',
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-03-06T15:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          postSuggestionsEntryMode: 'BOT',
          postSuggestionsButtonText: 'Прислать новость',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '777000',
      requiredAuthorUserId: '777000',
    });

    expect(maxBotLinkService.resolveBotRoutes).toHaveBeenCalledWith({
      purpose: 'moderation_action',
      chatId: 'channel-1',
      action: 'edit_message',
      fallbackToPrimary: true,
    });
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-1',
      'Новый пост в канале',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: '💬 Комментарии · 0',
            }),
          ],
          [
            expect.objectContaining({
              type: 'link',
              text: 'Прислать новость',
              url: expect.stringContaining(
                'https://max.ru/scan-bot-2?start=cds-channel-1-existing-thread',
              ),
            }),
          ],
        ],
      }),
      expect.objectContaining({
        botId: 'scan-bot-2',
        trafficClass: 'background',
        actionHealthLane: 'background',
      }),
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3]).not.toHaveProperty(
      'appendNewInlineKeyboardRows',
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            threadId: 'existing-thread',
            includeCommentsButton: true,
            includeSuggestButton: true,
            suggestButtonText: 'Прислать новость',
          }),
        }),
      }),
    );

    await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-channel-complete-1',
      text: 'Уже готовый пост',
      linkType: null,
      existingDialogButtonKinds: ['comments', 'suggest'],
      existingDialogThreadId: 'existing-thread',
      managedChannel: {
        channelSettings: {
          updatedAt: new Date('2026-03-06T15:00:00.000Z'),
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          postSuggestionsEntryMode: 'BOT',
          postSuggestionsButtonText: 'Прислать новость',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '777000',
      requiredAuthorUserId: '777000',
    });

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
  });

  it('polls channel posts and attaches buttons even without webhook delivery', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1772810100000,
          sender: {
            user_id: '777000',
          },
          body: {
            mid: 'mid-polled-1',
            text: 'Пост из канала',
            attachments: [],
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(1, {
      select: {
        chatId: true,
        quickButtonsEnabled: true,
        postSignatureEnabled: true,
        commentsEnabled: true,
        postSuggestionsEnabled: true,
      },
      orderBy: { chatId: 'asc' },
      take: 64,
    });
    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        chatId: {
          in: ['channel-1'],
        },
        chat: {
          entityType: 'CHANNEL',
        },
      },
      include: {
        chat: {
          select: {
            admins: {
              select: {
                userId: true,
              },
            },
          },
        },
      },
    });
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
      botId: '777000_bot',
    });
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-polled-1',
      'Пост из канала',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [
            expect.objectContaining({
              type: 'link',
              text: '📰 Предложить пост',
              url: expect.stringContaining('https://max.ru/777000_bot?start='),
            }),
          ],
        ],
        debugContext: {
          screen: 'channel-auto-post',
          action: 'scan-attach-buttons',
        },
      }),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: '777000_bot',
      },
    );
  });

  it('does not scan a stale CHAT candidate that fails the defensive channel reload', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'chat-1', commentsEnabled: true }])
          .mockResolvedValueOnce([]),
      },
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn(),
      editMessageInlineKeyboard: jest.fn(),
      sendMessageCopyWithInlineKeyboard: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );

    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(prisma.channelSettings.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          chatId: { in: ['chat-1'] },
          chat: { entityType: 'CHANNEL' },
        },
      }),
    );
    expect(maxClient.listMessages).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('treats polling as a repair sweep and skips scans right after a webhook-seen channel post', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-06T15:10:00.000Z'));

    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'channel-1',
          title: 'Ищу модель | Ростов',
          entityType: 'CHANNEL',
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
          },
          admins: [],
        }),
      },
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      listMessages: jest.fn().mockResolvedValue([]),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock({
        CHANNEL_AUTO_POST_REPAIR_SWEEP_MS: 60_000,
      }) as never,
      undefined,
      undefined,
      adminService as never,
    );

    await service.handleUpdate(createRuntimeBotChannelPostUpdate());
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).not.toHaveBeenCalled();

    jest.setSystemTime(new Date('2026-03-06T15:11:01.000Z'));
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).toHaveBeenCalledTimes(1);
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
      botId: '777000_bot',
    });
  });

  it('retries a rejected merged edit with preservation on both attempts and keeps the signature', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest
        .fn(prepareLockedEditText)
        .mockImplementationOnce(async (...args) => {
          await prepareLockedEditText(...args);
          throw { response: { status: 200 }, message: 'Error on message edit' };
        })
        .mockImplementationOnce(prepareLockedEditText),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: '<b>Пост</b>\n\n<a href="https://max.ru/science">Наука и Факты</a>',
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;
    configureDefaultChannelAutoPostEditRoute(service);

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-replacement-edit-1',
        text: '**Пост**',
        textFormat: 'markdown',
        linkType: null,
        existingDialogButtonKinds: ['comments'],
        existingDialogThreadId: 'manual-thread',
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: true,
            postSuggestionsEntryMode: 'BOT',
            postSuggestionsButtonText: '📰 Предложить пост',
            postSignatureEnabled: true,
          },
          adminUserIds: ['admin-1'],
        },
        source: 'webhook',
        senderId: '777000',
        requiredAuthorUserId: '777000',
      }),
    ).resolves.toBe('attached');

    expect(channelPostSignatureService.preparePostText).toHaveBeenCalledTimes(2);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      1,
      'channel-1',
      'mid-channel-replacement-edit-1',
      '**Пост**',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [expect.objectContaining({ text: '📰 Предложить пост' })],
        ],
        textFormat: 'markdown',
        mergeExistingInlineKeyboard: true,
        requireAllAttachmentsPreserved: true,
        preserveExistingChannelDialogButtons: true,
      }),
      expectChannelAutoPostOptions(),
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3]).not.toHaveProperty(
      'appendNewInlineKeyboardRows',
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      2,
      'channel-1',
      'mid-channel-replacement-edit-1',
      '**Пост**',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [expect.objectContaining({ text: '📰 Предложить пост' })],
        ],
        textFormat: 'markdown',
      }),
      expectChannelAutoPostOptions(),
    );
    const replacementOptions = maxClient.editMessageInlineKeyboard.mock.calls[1]?.[3];
    expect(replacementOptions).toMatchObject({
      appendNewInlineKeyboardRows: true,
      mergeExistingInlineKeyboard: true,
      requireAllAttachmentsPreserved: true,
      preserveExistingChannelDialogButtons: true,
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: '777000',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          messageId: 'mid-channel-replacement-edit-1',
          threadId: 'manual-thread',
          includeCommentsButton: true,
          includeSuggestButton: true,
          signatureApplied: true,
          deliveryMode: 'edit_message',
        }),
      }),
    });
  });

  it('terminally skips after both keyboard edit strategies fail and never retries or replies', async () => {
    const markerMock = createChannelAutoPostAttachMarkerMock();
    const terminalEditError = {
      response: { status: 200 },
      message: 'Error on message edit',
    };
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
      channelAutoPostAttachMarker: markerMock.delegate,
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn(
        async (...args: Parameters<MaxClientService['editMessageInlineKeyboard']>) => {
          await prepareLockedEditText(...args);
          throw terminalEditError;
        },
      ),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: 'Пост\n\n<a href="https://max.ru/science">Наука и Факты</a>',
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;
    configureDefaultChannelAutoPostEditRoute(service);
    const input = {
      chatId: 'channel-1',
      messageId: 'mid-channel-terminal-edit-1',
      text: 'Пост',
      textFormat: null,
      linkType: null,
      existingDialogThreadId: 'terminal-thread',
      managedChannel: {
        channelSettings: {
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          postSuggestionsEntryMode: 'BOT',
          postSuggestionsButtonText: 'Предложить пост',
          postSignatureEnabled: true,
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '777000',
      requiredAuthorUserId: '777000',
    } as const;

    await expect((service as any).tryAutoAttachChannelMessageButtons(input)).resolves.toBe(
      'skipped',
    );
    await expect((service as any).tryAutoAttachChannelMessageButtons(input)).resolves.toBe(
      'skipped',
    );

    expect(channelPostSignatureService.preparePostText).toHaveBeenCalledTimes(2);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        mergeExistingInlineKeyboard: true,
      }),
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3]).not.toHaveProperty(
      'appendNewInlineKeyboardRows',
    );
    const replacementOptions = maxClient.editMessageInlineKeyboard.mock.calls[1]?.[3];
    expect(replacementOptions).toMatchObject({
      appendNewInlineKeyboardRows: true,
      mergeExistingInlineKeyboard: true,
      requireAllAttachmentsPreserved: true,
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(markerMock.rows.get('channel-1:mid-channel-terminal-edit-1')).toMatchObject({
      status: 'SKIPPED',
      deliveryMode: 'edit_message',
      replacementMessageId: null,
      replyMessageId: null,
      replacementSendStartedAt: null,
      lastStatusCode: 200,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED',
        payload: expect.objectContaining({
          messageId: 'mid-channel-terminal-edit-1',
          deliveryMode: 'edit_message',
          terminalEditAttemptExhausted: true,
          status: 200,
          error: 'Error on message edit',
        }),
      }),
    });
  });

  it('keeps an ambiguous channel edit retryable without sending a reply', async () => {
    const editError = Object.assign(new Error('channel edit timed out'), {
      response: { status: 408 },
    });
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(editError),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    configureDefaultChannelAutoPostEditRoute(service);

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-channel-ambiguous-edit-1',
        text: 'Публикация',
        textFormat: null,
        linkType: null,
        managedChannel: {
          channelSettings: {
            commentsEnabled: true,
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
          },
          adminUserIds: ['admin-1'],
        },
        source: 'poll',
        senderId: '777000',
        requiredAuthorUserId: '777000',
      }),
    ).rejects.toBe(editError);

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('edits forwarded posts with numeric unrecognized senders during polling', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [
                {
                  userId: '195714583',
                },
              ],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1772810100000,
          sender: {
            user_id: 195_714_584,
          },
          body: {
            mid: 'mid-polled-non-admin-1',
            text: '',
            attachments: [],
          },
          link: {
            type: 'forward',
            message: { text: 'Пост не админа' },
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageCopyWithInlineKeyboard: jest.fn(),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-polled-non-admin-1',
      null,
      expect.objectContaining({ requireAllAttachmentsPreserved: true }),
      expectChannelAutoPostOptions(),
    );
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect((service as any).channelAutoPostScanState.get('channel-1')).toMatchObject({
      latestTimestampMs: 1772810100000,
      latestMessageIdsAtTimestamp: ['mid-polled-non-admin-1'],
    });
  });

  it('does not mutate an anonymous polled forward without an edit route', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: { admins: [{ userId: 'admin-1' }] },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([
        {
          id: 'mid-polled-forward-unknown-1',
          timestamp: 1772810100000,
          body: { text: '', attachments: [] },
          link: {
            type: 'forward',
            message: { text: 'Пересланный пост без автора' },
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn(),
      sendMessageCopyWithInlineKeyboard: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
    );
    const resolveMutationBot = jest.spyOn(service as any, 'resolveAutoAttachMutationBotId');
    const claimMarker = jest.spyOn(
      (service as any).replacementAttachMarkerStore,
      'claimChannelAutoPost',
    );

    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(resolveMutationBot).toHaveBeenCalledWith({
      chatId: 'channel-1',
      action: 'edit_message',
    });
    expect(claimMarker).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect((service as any).channelAutoPostScanState.get('channel-1')).toMatchObject({
      latestTimestampMs: 1772810100000,
      latestMessageIdsAtTimestamp: ['mid-polled-forward-unknown-1'],
    });
  });

  it.each([null, 'forward'])(
    'auto-attaches configured buttons to senderless %j posts from the normal poll scan',
    async (linkType) => {
      const prisma = {
        ...createChannelMutationGuardPrismaMock(),
        channelSettings: {
          findMany: jest.fn().mockResolvedValue([
            {
              chatId: 'channel-1',
              postSuggestionsEnabled: true,
              postSuggestionsButtonText: '📰 Предложить пост',
              commentsEnabled: false,
              updatedAt: new Date('2026-03-06T15:00:00.000Z'),
              chat: {
                admins: [
                  {
                    userId: 'admin-1',
                  },
                ],
              },
            },
          ]),
        },
        auditLog: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(undefined),
        },
      };
      const ruleEngine = {
        detect: jest.fn(),
      };
      const sanctionService = {
        resolveAction: jest.fn(),
      };
      const maxClient = {
        ...createChannelMutationGuardMaxClientMock(),
        listMessages: jest.fn().mockResolvedValue([
          {
            timestamp: 1772810100000,
            body: {
              mid: 'mid-polled-unknown-author-1',
              text: 'Пост без sender metadata',
              attachments: [],
            },
            link: { type: linkType },
          },
        ]),
        editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
        getChatAdminIds: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const adminService = createAdminServiceMock();

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
        undefined,
        undefined,
        createConfigMock() as never,
        undefined,
        undefined,
        adminService as never,
      );

      configureDefaultChannelAutoPostEditRoute(service);
      configureChannelAutoPostScanRoute(service);
      await (service as any).processChannelAutoPostButtons();

      expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('channel-1', {
        botId: '777000_bot',
        bypassCache: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        timeoutMs: 2_000,
      });
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
        'channel-1',
        'mid-polled-unknown-author-1',
        linkType === 'forward' ? null : 'Пост без sender metadata',
        expect.objectContaining({
          buttons: [[expect.objectContaining({ text: '📰 Предложить пост' })]],
        }),
        expectChannelAutoPostOptions({ botId: '777000_bot' }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: 'system',
          payload: expect.objectContaining({
            includeCommentsButton: false,
            includeSuggestButton: true,
            source: 'poll',
          }),
        }),
      });
    },
  );

  it('routes forwarded channel replacement and cleanup through a delete-capable bot', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: 'CHANNEL' }),
      },
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            postSuggestionsEnabled: false,
            postSuggestionsButtonText: '',
            commentsEnabled: false,
            postSignatureEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [
                {
                  userId: '195714583',
                },
              ],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([
        {
          id: 'mid-polled-forward-1',
          timestamp: 1772810100000,
          sender: {
            user_id: 195_714_583,
          },
          body: {
            text: '',
            attachments: [{ type: 'inline_keyboard', payload: { buttons: [] } }],
          },
          link: {
            type: 'forward',
            message: {
              text: 'Пересланный пост',
            },
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageCopyWithInlineKeyboard: jest.fn().mockResolvedValue({
        messageId: 'mid-polled-forward-copy-1',
        url: 'https://max.ru/chats/channel-1/message/1002',
      }),
      sendMessageReplyWithInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: 'Пересланный пост\n\n<a href="https://max.ru/science">Наука и Факты</a>',
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const maxBotLinkService = {
      resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'primary-bot',
        botId: 'delete-capable-bot',
        candidateBotIds: ['delete-capable-bot'],
        quarantinedCandidateBotIds: [],
        reason: 'alternate_confirmed',
        action: 'delete_message',
      }),
      getExecutableBotById: jest.fn((botId: string) =>
        botId === 'delete-capable-bot' ? { id: botId, contactId: '900001' } : null,
      ),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
      undefined,
      maxBotLinkService as never,
    );
    (service as any).channelPostSignatureService = channelPostSignatureService;

    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageReplyWithInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-polled-forward-1',
      'Пересланный пост\n\n<a href="https://max.ru/science">Наука и Факты</a>',
      expect.objectContaining({
        buttons: [],
        textFormat: 'html',
        preserveExistingInlineKeyboard: true,
      }),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: 'delete-capable-bot',
      },
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'channel-1',
      'mid-polled-forward-1',
      expect.objectContaining({
        immediate: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        timeoutMs: 2_000,
        botId: 'delete-capable-bot',
        beforeImmediateDeleteMutation: expect.any(Function),
      }),
    );
    expect(maxBotLinkService.resolveDeleteMessageBotRoute).toHaveBeenCalledWith({
      chatId: 'channel-1',
      expectedEntityType: 'CHANNEL',
      requireFreshSnapshot: true,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: '195714583',
        }),
      }),
    );
  });

  it.each([
    { error: new Error('MAX API global rate limit exceeded'), isolated: false },
    {
      error: new MaxApiInternalRateLimitError('MAX rate limit', 60_000, 'role_class'),
      isolated: false,
    },
    {
      error: new MaxApiInternalRateLimitError('MAX rate limit', 60_000, 'unknown'),
      isolated: false,
    },
    { error: new MaxApiInternalRateLimitError('token admission', 60_000, 'bot'), isolated: true },
    {
      error: new MaxApiInternalRateLimitError('cooldown', 60_000, 'external_cooldown'),
      isolated: true,
    },
    ...[403, 404].map((status) => ({
      error: Object.assign(new Error('Request failed'), {
        response: { status, data: { message: 'Request failed' } },
      }),
      isolated: true,
    })),
  ])('isolates channel-local failures and scoped waits: $isolated', async ({ error, isolated }) => {
    jest.useFakeTimers({ advanceTimers: true }).setSystemTime(new Date('2026-03-30T02:00:00.000Z'));
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [],
            },
          },
          {
            chatId: 'channel-2',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest
        .fn<
          ReturnType<MaxClientService['listMessages']>,
          Parameters<MaxClientService['listMessages']>
        >()
        .mockImplementation(async (chatId) => {
          if (chatId === 'channel-1') throw error;
          return [];
        }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).toHaveBeenCalledTimes(isolated ? 2 : 1);
    expect(prisma.channelSettings.findMany).toHaveBeenCalledTimes(isolated ? 3 : 2);
    if (isolated)
      expect(maxClient.listMessages).toHaveBeenNthCalledWith(2, 'channel-2', expect.anything());
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-1', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
      botId: '777000_bot',
    });
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('applies idle backoff to channel polling when no new posts appear', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T02:00:00.000Z'));

    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1774810100000,
          sender: {
            user_id: '777000',
          },
          body: {
            mid: 'mid-polled-idle-1',
            text: 'Пост из канала',
            attachments: [],
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock({
        CHANNEL_AUTO_POST_SCAN_INTERVAL_MS: 30_000,
        CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS: 120_000,
      }) as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();
    jest.advanceTimersByTime(30_000);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();
    jest.advanceTimersByTime(30_000);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();
    jest.advanceTimersByTime(30_000);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).toHaveBeenCalledTimes(3);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
  });

  it('skips not-yet-due channels when selecting the next polling batch', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T02:30:00.000Z'));

    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-skip',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [{ userId: 'admin-1' }],
            },
          },
          {
            chatId: 'channel-due',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [{ userId: 'admin-1' }],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock({
        CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS: 2,
      }) as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    (service as any).channelAutoPostScanState.set('channel-skip', {
      latestTimestampMs: 0,
      latestMessageIdsAtTimestamp: [],
      idleStreak: 4,
      nextScanAtMs: Date.now() + 60_000,
    });

    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.listMessages).toHaveBeenCalledTimes(1);
    expect(maxClient.listMessages).toHaveBeenCalledWith('channel-due', {
      count: 10,
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
      botId: '777000_bot',
    });
  });

  it('limits background auto-attach work per channel scan and catches up gradually', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T03:00:00.000Z'));

    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
            updatedAt: new Date('2026-03-06T15:00:00.000Z'),
            chat: {
              admins: [
                {
                  userId: 'admin-1',
                },
              ],
            },
          },
        ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1774810000000,
          sender: { user_id: '777000' },
          body: { mid: 'mid-polled-batch-1', text: 'Пост 1', attachments: [] },
        },
        {
          timestamp: 1774810001000,
          sender: { user_id: '777000' },
          body: { mid: 'mid-polled-batch-2', text: 'Пост 2', attachments: [] },
        },
        {
          timestamp: 1774810002000,
          sender: { user_id: '777000' },
          body: { mid: 'mid-polled-batch-3', text: 'Пост 3', attachments: [] },
        },
        {
          timestamp: 1774810003000,
          sender: { user_id: '777000' },
          body: { mid: 'mid-polled-batch-4', text: 'Пост 4', attachments: [] },
        },
      ]),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = createAdminServiceMock();

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock({
        CHANNEL_AUTO_POST_SCAN_INTERVAL_MS: 30_000,
        CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN: 2,
      }) as never,
      undefined,
      undefined,
      adminService as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();
    jest.advanceTimersByTime(30_000);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(4);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      1,
      'channel-1',
      'mid-polled-batch-1',
      'Пост 1',
      expect.any(Object),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: '777000_bot',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      2,
      'channel-1',
      'mid-polled-batch-2',
      'Пост 2',
      expect.any(Object),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: '777000_bot',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      3,
      'channel-1',
      'mid-polled-batch-3',
      'Пост 3',
      expect.any(Object),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: '777000_bot',
      },
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenNthCalledWith(
      4,
      'channel-1',
      'mid-polled-batch-4',
      'Пост 4',
      expect.any(Object),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: '777000_bot',
      },
    );
  });

  it('pauses channel polling while the shared system mode is degraded', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn(),
      },
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn(),
      editMessageInlineKeyboard: jest.fn(),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag 20.0s',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 20,
        action: {
          windowSec: 60,
          total: 100,
          success: 95,
          failure: 5,
          critical: 0,
          errorRate: 0.05,
          criticalRate: 0,
        },
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      systemModeService as never,
      createConfigMock() as never,
    );

    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
    expect(prisma.channelSettings.findMany).not.toHaveBeenCalled();
    expect(maxClient.listMessages).not.toHaveBeenCalled();
  });

  it('does not pause channel polling during recovery window without active pressure', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      auditLog: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn(),
      editMessageInlineKeyboard: jest.fn(),
      getChatAdminIds: jest.fn(),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn().mockResolvedValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'recovery window in progress',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 0,
        action: {
          windowSec: 60,
          total: 100,
          success: 100,
          failure: 0,
          critical: 0,
          errorRate: 0,
          criticalRate: 0,
        },
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      systemModeService as never,
      createConfigMock() as never,
    );

    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(systemModeService.getEffectiveSnapshot).toHaveBeenCalled();
    expect(prisma.channelSettings.findMany).toHaveBeenCalled();
  });

  it('routes ordinary auto-attach edits through an edit-capable bot', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoutes: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'primary-bot',
        botId: 'edit-capable-bot',
        candidateBotIds: ['edit-capable-bot'],
        quarantinedCandidateBotIds: [],
        reason: 'alternate_confirmed',
        action: 'edit_message',
      }),
      getExecutableBotById: jest.fn((botId: string) =>
        botId === 'edit-capable-bot' ? { id: botId, contactId: '222000' } : null,
      ),
      resolveContactIdSync: jest.fn().mockReturnValue('222000'),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await (
      service as unknown as {
        tryAutoAttachChannelMessageButtons: (params: {
          chatId: string;
          messageId: string;
          text: string | null;
          linkType: string | null;
          managedChannel: {
            channelSettings: {
              postSuggestionsEnabled: true;
              postSuggestionsButtonText: string;
              commentsEnabled: true;
            };
            adminUserIds: string[];
          };
          source: 'poll';
          senderId: string | null;
          requiredAuthorUserId?: string | null;
        }) => Promise<void>;
      }
    ).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-poll-1',
      text: 'Пост из фонового сканирования',
      linkType: null,
      managedChannel: {
        channelSettings: {
          postSuggestionsEnabled: true,
          postSuggestionsButtonText: '📰 Предложить пост',
          commentsEnabled: true,
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '222000',
      requiredAuthorUserId: '222000',
    });

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-poll-1',
      'Пост из фонового сканирования',
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'channel_auto_post',
        botId: 'edit-capable-bot',
      },
    );
    expect(maxBotLinkService.resolveBotRoutes).toHaveBeenCalledWith({
      purpose: 'moderation_action',
      chatId: 'channel-1',
      action: 'edit_message',
      fallbackToPrimary: true,
    });

    maxClient.editMessageInlineKeyboard.mockClear();
    maxBotLinkService.getExecutableBotById.mockClear();
    maxBotLinkService.resolveContactIdSync.mockClear();
    maxBotLinkService.resolveBotRoutes.mockResolvedValueOnce({
      purpose: 'moderation_action',
      chatId: 'channel-1',
      primaryBotId: 'primary-bot',
      botId: '222000_bot',
      candidateBotIds: ['222000_bot'],
      quarantinedCandidateBotIds: [],
      reason: 'stale_snapshot',
      action: 'edit_message',
    });
    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-poll-stale-bot-1',
        text: 'Пост entry-бота со stale route',
        linkType: null,
        managedChannel: {
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
          },
          adminUserIds: [],
        },
        source: 'poll',
        senderId: '222000',
        requiredAuthorUserId: '222000',
      }),
    ).resolves.toBe('skipped');
    expect(maxBotLinkService.getExecutableBotById).toHaveBeenCalledWith('222000_bot');
    expect(maxBotLinkService.resolveContactIdSync).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();

    await expect(
      (service as any).tryAutoAttachChannelMessageButtons({
        chatId: 'channel-1',
        messageId: 'mid-poll-other-bot-1',
        text: 'Пост другого бота',
        linkType: null,
        managedChannel: {
          channelSettings: {
            postSuggestionsEnabled: true,
            postSuggestionsButtonText: '📰 Предложить пост',
            commentsEnabled: true,
          },
          adminUserIds: [],
        },
        source: 'poll',
        senderId: '333000',
        requiredAuthorUserId: '333000',
      }),
    ).resolves.toBe('attached');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
  });

  it('records a proven predispatch limiter failure and does not advance the scan cursor', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T03:00:00.000Z'));

    const transientError = Object.assign(new Error('MAX API background rate limit exceeded'), {
      code: 'MAX_API_INTERNAL_RATE_LIMIT',
      preDispatch: true,
    });
    const markerRows = new Map<string, any>();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'channel-1', commentsEnabled: true }])
          .mockResolvedValueOnce([
            {
              chatId: 'channel-1',
              commentsEnabled: true,
              postSuggestionsEnabled: false,
              postSuggestionsButtonText: '',
              updatedAt: new Date('2026-03-06T15:00:00.000Z'),
              chat: {
                admins: [{ userId: 'admin-1' }],
              },
            },
          ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
      channelAutoPostAttachMarker: {
        findUnique: jest.fn(({ where }: any) => {
          const key = `${where.chatId_messageId.chatId}:${where.chatId_messageId.messageId}`;
          return Promise.resolve(markerRows.get(key) ?? null);
        }),
        create: jest.fn(({ data }: any) => {
          markerRows.set(`${data.chatId}:${data.messageId}`, { ...data });
          return Promise.resolve(data);
        }),
        updateMany: jest.fn(({ where, data }: any) => {
          const key = `${where.chatId}:${where.messageId}`;
          const row = markerRows.get(key);
          if (!row || row.lockToken !== where.lockToken) {
            return Promise.resolve({ count: 0 });
          }
          markerRows.set(key, { ...row, ...data });
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1772810100000,
          sender: { user_id: '777000' },
          body: {
            mid: 'mid-retry-1',
            text: 'Пост',
            attachments: [],
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(transientError),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock({
        CHANNEL_AUTO_POST_SCAN_INTERVAL_MS: 30_000,
        CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS: 30_000,
      }) as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    configureDefaultChannelAutoPostEditRoute(service);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(
      (service as any).channelAutoPostScanState.get('channel-1').latestMessageIdsAtTimestamp,
    ).toEqual([]);
    expect(markerRows.get('channel-1:mid-retry-1')).toEqual(
      expect.objectContaining({
        status: 'IN_PROGRESS',
        lockToken: null,
        lockedAt: null,
        lastStatusCode: null,
        lastError:
          '[channel-auto-post:pre-dispatch:v1][MAX_API_INTERNAL_RATE_LIMIT] MAX API background rate limit exceeded',
      }),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('uses the durable auto-attach marker to avoid concurrent duplicate side effects', async () => {
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      channelAutoPostAttachMarker: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'IN_PROGRESS',
          lockedAt: new Date(),
        }),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    configureDefaultChannelAutoPostEditRoute(service);

    const result = await (service as any).tryAutoAttachChannelMessageButtons({
      chatId: 'channel-1',
      messageId: 'mid-in-progress-1',
      text: 'Пост',
      linkType: null,
      managedChannel: {
        channelSettings: {
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '777000',
      requiredAuthorUserId: '777000',
    });

    expect(result).toBe('in_progress');
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('claims channel auto-post markers with skipDuplicates to avoid unique constraint noise', async () => {
    const markerDelegate = {
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const service = new ModerationService(
      {
        auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
        channelAutoPostAttachMarker: markerDelegate,
      } as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      { editMessageInlineKeyboard: jest.fn() } as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    await expect(
      (service as any).replacementAttachMarkerStore.claimChannelAutoPost({
        chatId: 'channel-1',
        messageId: 'mid-post-race',
        source: 'webhook',
        botId: 'bot-1',
        linkType: 'comments',
      }),
    ).resolves.toEqual({ status: 'claimed', lockToken: expect.any(String) });
    await expect(
      (service as any).replacementAttachMarkerStore.claimChannelAutoPost({
        chatId: 'channel-1',
        messageId: 'mid-post-race',
        source: 'webhook',
        botId: 'bot-1',
        linkType: 'comments',
      }),
    ).resolves.toEqual({ status: 'in_progress' });

    expect(markerDelegate.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: 'channel-1',
          messageId: 'mid-post-race',
          status: 'IN_PROGRESS',
          source: 'webhook',
          botId: 'bot-1',
          linkType: 'comments',
        }),
      ],
      skipDuplicates: true,
    });
    expect(markerDelegate.create).not.toHaveBeenCalled();
  });

  it('attempts the next post while retaining an in-progress auto-attach marker', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T03:00:00.000Z'));

    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      channelSettings: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'channel-1', commentsEnabled: true }])
          .mockResolvedValueOnce([
            {
              chatId: 'channel-1',
              commentsEnabled: true,
              postSuggestionsEnabled: false,
              postSuggestionsButtonText: '',
              updatedAt: new Date('2026-03-06T15:00:00.000Z'),
              chat: {
                admins: [{ userId: 'admin-1' }],
              },
            },
          ]),
      },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      channelAutoPostAttachMarker: {
        findUnique: jest.fn(({ where }: any) => {
          const messageId = where.chatId_messageId.messageId;
          return Promise.resolve(
            messageId === 'mid-locked-1'
              ? {
                  status: 'IN_PROGRESS',
                  lockedAt: new Date('2026-03-30T02:59:30.000Z'),
                }
              : null,
          );
        }),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      listMessages: jest.fn().mockResolvedValue([
        {
          timestamp: 1772810100000,
          sender: { user_id: '777000' },
          body: {
            mid: 'mid-locked-1',
            text: 'Занятый пост',
            attachments: [],
          },
        },
        {
          timestamp: 1772810160000,
          sender: { user_id: '777000' },
          body: {
            mid: 'mid-next-1',
            text: 'Следующий пост',
            attachments: [],
          },
        },
      ]),
      editMessageInlineKeyboard: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock({
        CHANNEL_AUTO_POST_SCAN_INTERVAL_MS: 30_000,
      }) as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    configureDefaultChannelAutoPostEditRoute(service);
    configureChannelAutoPostScanRoute(service);
    await (service as any).processChannelAutoPostButtons();

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-next-1',
      'Следующий пост',
      expect.any(Object),
      expectChannelAutoPostOptions(),
    );
    expect(prisma.channelAutoPostAttachMarker.updateMany.mock.calls).not.toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            where: expect.objectContaining({ messageId: 'mid-locked-1' }),
          }),
        ],
      ]),
    );
    expect(prisma.channelAutoPostAttachMarker.findUnique).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          chatId_messageId: {
            chatId: 'channel-1',
            messageId: 'mid-locked-1',
          },
        },
      }),
    );
    expect(
      (service as any).channelAutoPostScanState.get('channel-1').latestMessageIdsAtTimestamp,
    ).toEqual([]);
  });

  it('completes the durable marker and does not retry when audit persistence fails', async () => {
    const markerRows = new Map<string, any>();
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(new Error('audit unavailable')),
      },
      channelAutoPostAttachMarker: {
        findUnique: jest.fn(({ where }: any) => {
          const key = `${where.chatId_messageId.chatId}:${where.chatId_messageId.messageId}`;
          return Promise.resolve(markerRows.get(key) ?? null);
        }),
        create: jest.fn(({ data }: any) => {
          markerRows.set(`${data.chatId}:${data.messageId}`, { ...data });
          return Promise.resolve(data);
        }),
        updateMany: jest.fn(({ where, data }: any) => {
          const key = `${where.chatId}:${where.messageId}`;
          const row = markerRows.get(key);
          if (!row || row.lockToken !== where.lockToken) {
            return Promise.resolve({ count: 0 });
          }
          markerRows.set(key, { ...row, ...data });
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );
    configureDefaultChannelAutoPostEditRoute(service);

    const request = {
      chatId: 'channel-1',
      messageId: 'mid-audit-failure-1',
      text: 'Пост',
      linkType: null,
      managedChannel: {
        channelSettings: {
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: '777000',
      requiredAuthorUserId: '777000',
    };

    await expect((service as any).tryAutoAttachChannelMessageButtons(request)).resolves.toBe(
      'attached',
    );
    await expect((service as any).tryAutoAttachChannelMessageButtons(request)).resolves.toBe(
      'skipped',
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(markerRows.get('channel-1:mid-audit-failure-1')).toEqual(
      expect.objectContaining({
        status: 'SUCCEEDED',
        lockToken: null,
        lockedAt: null,
      }),
    );
  });

  it.each([
    {
      label: 'the send-start fence',
      replacementMessageId: null,
      replacementSendStartedAt: new Date('2026-03-30T02:00:00.000Z'),
    },
    {
      label: 'a persisted replacement id',
      replacementMessageId: 'mid-copy-from-crashed-worker',
      replacementSendStartedAt: null,
    },
  ])('does not reclaim a stale channel replacement marker with $label', async (markerState) => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      auditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      channelAutoPostAttachMarker: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'IN_PROGRESS',
          lockedAt: new Date('2026-03-30T02:00:00.000Z'),
          ...markerState,
        }),
        createMany: jest.fn(),
        updateMany,
      },
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      sendMessageCopyWithInlineKeyboard: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    await expect(
      (service as any).replacementAttachMarkerStore.claimChannelAutoPost({
        chatId: 'channel-1',
        messageId: 'mid-stale-replacement-fence',
        source: 'poll',
        botId: 'bot-1',
        linkType: 'forward',
      }),
    ).resolves.toEqual({ status: 'in_progress' });

    expect(updateMany).not.toHaveBeenCalled();
    expect(maxClient.sendMessageCopyWithInlineKeyboard).not.toHaveBeenCalled();
  });

  it('requires ownership when persisting the channel replacement send fence', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const service = new ModerationService(
      {
        channelAutoPostAttachMarker: { updateMany },
      } as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
    );

    await expect(
      (service as any).replacementAttachMarkerStore.recordChannelReplacementSendStarted({
        chatId: 'channel-1',
        messageId: 'mid-lost-lock',
        lockToken: 'lost-lock',
      }),
    ).rejects.toThrow('Failed to persist the channel auto-post replacement send fence');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lockToken: 'lost-lock',
          replacementMessageId: null,
          replacementSendStartedAt: null,
        }),
      }),
    );
  });

  it('retains a delivered channel copy when its first marker finalization loses ownership', async () => {
    let row: Record<string, any> | null = null;
    let rejectFirstDeliveredMarker = true;
    const markerDelegate = {
      findUnique: jest.fn().mockImplementation(async () => row),
      createMany: jest.fn().mockImplementation(async ({ data }: any) => {
        row = {
          ...data[0],
          replacementMessageId: null,
          replacementSendStartedAt: null,
          publishedUrl: null,
          originalDeleted: false,
        };
        return { count: 1 };
      }),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (!row || row.lockToken !== where.lockToken || row.status !== where.status) {
          return { count: 0 };
        }
        if (where.replacementMessageId === null && row.replacementMessageId !== null) {
          return { count: 0 };
        }
        if (where.replacementSendStartedAt === null && row.replacementSendStartedAt !== null) {
          return { count: 0 };
        }
        if (data.replacementMessageId && rejectFirstDeliveredMarker) {
          rejectFirstDeliveredMarker = false;
          return { count: 0 };
        }
        row = { ...row, ...data };
        return { count: 1 };
      }),
    };
    const prisma = {
      ...createChannelMutationGuardPrismaMock(),
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: 'CHANNEL' }),
      },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      channelAutoPostAttachMarker: markerDelegate,
    };
    const maxClient = {
      ...createChannelMutationGuardMaxClientMock(),
      sendMessageCopyWithInlineKeyboard: jest.fn().mockImplementation(async (...args: any[]) => {
        await args[3]?.beforeSend?.();
        return {
          messageId: 'mid-delivered-copy',
          url: 'https://max.ru/chats/channel-1/message/mid-delivered-copy',
        };
      }),
    };
    const maxBotLinkService = {
      resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
        action: 'delete_message',
      }),
      getExecutableBotById: jest.fn((botId: string) =>
        botId === 'bot-1' ? { id: botId, contactId: '777000' } : null,
      ),
      resolveBotIdForCapability: jest.fn().mockResolvedValue('bot-1'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation((value: string) => `https://max.ru/bot-1?startapp=${value}`),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      createConfigMock() as never,
      undefined,
      undefined,
      createAdminServiceMock() as never,
      undefined,
      maxBotLinkService as never,
    );
    const input = {
      chatId: 'channel-1',
      messageId: 'mid-forward-marker-failure',
      text: 'Пересланный пост',
      textFormat: null,
      linkType: 'forward',
      managedChannel: {
        channelSettings: {
          updatedAt: new Date(),
          commentsEnabled: true,
          postSuggestionsEnabled: false,
          postSuggestionsEntryMode: 'MINIAPP',
          postSuggestionsButtonText: '',
        },
        adminUserIds: ['admin-1'],
      },
      source: 'poll',
      senderId: 'admin-1',
      senderAdminVerified: true,
    } as const;

    await expect((service as any).tryAutoAttachChannelMessageButtons(input)).resolves.toBe(
      'attached',
    );
    await expect((service as any).tryAutoAttachChannelMessageButtons(input)).resolves.toBe(
      'skipped',
    );

    expect(maxClient.sendMessageCopyWithInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      status: 'SUCCEEDED',
      replacementMessageId: 'mid-delivered-copy',
      replacementSendStartedAt: null,
      originalDeleted: false,
      lastError: expect.stringContaining('marker persistence failed'),
    });
  });
});
