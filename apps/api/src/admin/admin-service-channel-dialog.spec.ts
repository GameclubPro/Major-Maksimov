import { createHmac } from 'node:crypto';
import { channelSettingsSchema } from '@maxim/contracts';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { resolveChannelSuggestionMediaPublicationBotId } from './admin-channel-suggestion-media-route';
import { AdminService } from './admin.service';
import {
  createAdminServiceFixture,
  AdminServicePrivateAccess,
  createAdminMaxBotLinkMock,
  createPrismaMock,
  extractSqlText,
  createConfigMock,
  createChatContextCacheMock,
  decodeBase64UrlJson,
  readDialogButtonToken,
  publishCommentsDialogToken as publishCommentsDialogTokenFromPreparedSettings,
  publishSuggestDialogToken as publishSuggestDialogTokenFromPreparedSettings,
} from './admin-service-test-support';

function mockChannelEngagementSettings(
  prisma: ReturnType<typeof createPrismaMock>,
  overrides: Record<string, unknown> = {},
): void {
  prisma.channelSettings.upsert.mockResolvedValueOnce({
    chatId: 'channel-1',
    ...channelSettingsSchema.parse({
      commentsEnabled: true,
      postSuggestionsEnabled: true,
    }),
    engagementPublishedMessageId: null,
    engagementPublishedBotId: null,
    engagementPublishedThreadId: null,
    engagementPublishedAt: null,
    ...overrides,
  });
}

async function publishCommentsDialogToken(
  ...args: Parameters<typeof publishCommentsDialogTokenFromPreparedSettings>
) {
  const prisma = (args[0] as unknown as { prisma: ReturnType<typeof createPrismaMock> }).prisma;
  mockChannelEngagementSettings(prisma, {
    commentsEnabled: true,
    postSuggestionsEnabled: false,
  });
  return publishCommentsDialogTokenFromPreparedSettings(...args);
}

async function publishSuggestDialogToken(
  ...args: Parameters<typeof publishSuggestDialogTokenFromPreparedSettings>
) {
  const prisma = (args[0] as unknown as { prisma: ReturnType<typeof createPrismaMock> }).prisma;
  mockChannelEngagementSettings(prisma, {
    commentsEnabled: false,
    postSuggestionsEnabled: true,
  });
  return publishSuggestDialogTokenFromPreparedSettings(...args);
}

function attachSuggestionPublicationRoute(
  service: AdminService,
  maxClient: {
    sendMessageImmediateWithResolvedLink: jest.Mock;
  },
) {
  const publish = jest.fn().mockImplementation(async (request: any) => {
    const botId = request.requiredBotId ?? request.preferredBotId ?? '777000_bot';
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: request.entityId,
      botId,
      idempotencyKey: request.logicalIdempotencyKey,
    };
    const prepared = await request.prepareAttempt({ botId, job });
    await request.beforeSendMutation({ botId, job: { ...job, ...prepared } });
    const sent = await maxClient.sendMessageImmediateWithResolvedLink(
      request.entityId,
      prepared.text,
      prepared.options,
      {
        botId,
        trafficClass: request.trafficClass,
        actionHealthLane: request.actionHealthLane,
        sourceTag: request.sourceTag,
        timeoutMs: request.timeoutMs,
        ignoreFailureMetricStatuses: request.ignoreFailureMetricStatuses,
      },
    );
    return {
      ...sent,
      botId,
      candidateBotIds: [botId],
      routingVersion: null,
    };
  });
  (service as any).maxRoutedPublicationService = { publish };
  return publish;
}

function readSqlJsonPatch(mock: jest.Mock, requiredKey: string): Record<string, unknown> {
  for (const call of mock.mock.calls.slice().reverse()) {
    const values = (call[0] as { values?: unknown[] } | undefined)?.values ?? [];
    for (const value of values) {
      if (typeof value !== 'string' || !value.trim().startsWith('{')) {
        continue;
      }
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(parsed, requiredKey)) {
          return parsed;
        }
      } catch {
        // Other SQL string parameters are not JSON patches.
      }
    }
  }
  throw new Error(`SQL JSON patch with key ${requiredKey} was not found`);
}

describe('AdminService.publishChannelEngagementMessage', () => {
  it('publishes channel buttons as MAX deep links with a dedicated post thread', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    mockChannelEngagementSettings(prisma);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    const commentsButton = options.buttons?.[0]?.[0];
    const suggestButton = options.buttons?.[1]?.[0];

    expect(options.buttons).toHaveLength(2);
    expect(options.buttons?.[0]).toHaveLength(1);
    expect(options.buttons?.[1]).toHaveLength(1);
    expect(commentsButton).toMatchObject({
      type: 'link',
      text: 'Комментарии · 0',
    });
    expect(suggestButton).toMatchObject({
      type: 'link',
      text: 'Предложить пост',
    });
    expect(commentsButton.url).toContain('https://max.ru/777000_bot?startapp=');
    expect(suggestButton.url).toContain('https://max.ru/777000_bot?start=');

    const suggestStartParam = new URL(suggestButton.url).searchParams.get('start');
    expect(suggestStartParam).toMatch(/^cds-/u);

    const parsedSuggestion = service.parseChannelSuggestionStartPayload(suggestStartParam);
    expect(parsedSuggestion).toMatchObject({
      chatId: 'channel-1',
      token: expect.stringMatching(/^cdt-/u),
    });
    const commentsToken = decodeBase64UrlJson<{ d: string; s: string }>(
      readDialogButtonToken(commentsButton).slice(4),
    );
    const suggestToken = decodeBase64UrlJson<{ d: string; s: string }>(
      parsedSuggestion!.token.slice(4),
    );

    expect(commentsToken.d).toBe(suggestToken.d);
    expect(commentsToken.s).not.toBe(suggestToken.s);

    const publishAuditPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      messageId?: unknown;
      threadId?: unknown;
    };
    expect(publishAuditPayload.messageId).toBe('mid-channel-engagement-1');
    expect(publishAuditPayload.threadId).toBe(commentsToken.d);
    expect(prisma.channelSettings.update).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      data: {
        engagementPublishedMessageId: 'mid-channel-engagement-1',
        engagementPublishedBotId: '777000_bot',
        engagementPublishedThreadId: commentsToken.d,
        engagementPublishedAt: expect.any(Date),
      },
    });
  });

  it('publishes channel suggestion buttons as mini app links when mini app mode is selected', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    mockChannelEngagementSettings(prisma, { postSuggestionsEntryMode: 'MINIAPP' });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-miniapp-1', url: null }),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    const suggestButton = options.buttons?.[1]?.[0];
    expect(suggestButton).toMatchObject({
      type: 'link',
      text: 'Предложить пост',
    });
    expect(suggestButton.url).toContain('https://max.ru/777000_bot?startapp=');
    expect(new URL(suggestButton.url).searchParams.get('startapp')).toBeTruthy();
    expect(new URL(suggestButton.url).searchParams.get('start')).toBeNull();

    const publishAuditPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      suggestionEntryMode?: unknown;
      suggestUrl?: unknown;
    };
    expect(publishAuditPayload.suggestionEntryMode).toBe('MINIAPP');
    expect(String(publishAuditPayload.suggestUrl)).toContain('?startapp=');
  });

  it('ignores legacy button flags and derives rows from channel feature toggles', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    mockChannelEngagementSettings(prisma, {
      commentsEnabled: true,
      postSuggestionsEnabled: false,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-2', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
        includeCommentsButton: false,
        includeSuggestButton: true,
      },
    );

    const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    expect(options.buttons).toHaveLength(1);
    expect(options.buttons?.[0]).toHaveLength(1);
    expect(options.buttons?.[0]?.[0]).toMatchObject({
      type: 'link',
      text: 'Комментарии · 0',
    });
  });

  it('accepts compact suggestion launch payloads signed with the previous bot token', () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const previousToken = 'test-max-bot-token-previous';

    const legacyService = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock({ token: previousToken }) as never,
    );
    const service = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock({ previousToken }) as never,
    );

    const startPayload = (
      legacyService as unknown as {
        buildChannelSuggestionStartPayload: (chatId: string, threadId: string) => string;
      }
    ).buildChannelSuggestionStartPayload('channel-1', '12345678-1234-1234-9234-1234567890ab');

    expect(service.parseChannelSuggestionStartPayload(startPayload)).toMatchObject({
      chatId: 'channel-1',
      token: expect.stringMatching(/^cdt-/u),
    });
  });

  it('returns a bot redirect url for channel suggestion dialog tokens', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        postSuggestionsEnabled: true,
      }),
    );

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const token = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'suggest',
      '12345678-1234-1234-9234-1234567890ab',
    );

    const result = await service.getChannelSuggestionRedirect('channel-1', token);

    expect(result.title).toBeNull();
    expect(result.url).toMatch(/^https:\/\/max\.ru\/777000_bot\?start=/u);

    const startPayload = new URL(result.url).searchParams.get('start');
    expect(service.parseChannelSuggestionStartPayload(startPayload)).toEqual({
      chatId: 'channel-1',
      token,
    });
  });

  it('routes channel suggestion redirect urls through the channel bot assignment', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        postSuggestionsEnabled: true,
      }),
    );
    const maxBotLinkService = {
      getBotTokenSync: jest.fn((botId?: string | null) =>
        botId?.trim() === 'channel-bot-2' ? 'token-bot-2' : 'test-max-bot-token',
      ),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token', 'token-bot-2']),
      buildBotStartUrlSync: jest.fn((startPayload: string, botId?: string | null) => {
        const targetBotId = botId?.trim() || '777000_bot';
        return `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(
          startPayload,
        )}`;
      }),
    };

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    jest.spyOn(service as any, 'resolveBotAssignment').mockResolvedValue('channel-bot-2');

    const threadId = '12345678-1234-1234-9234-1234567890ab';
    const token = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('channel', 'channel-1', 'suggest', threadId);

    const result = await service.getChannelSuggestionRedirect('channel-1', token);

    expect(result.url).toMatch(/^https:\/\/max\.ru\/channel-bot-2\?start=/u);
    const startPayload = new URL(result.url).searchParams.get('start') ?? '';
    const expectedSignature = createHmac('sha256', 'token-bot-2')
      .update(`suggest-start:channel-1:${threadId}`)
      .digest('hex')
      .slice(0, 24);
    expect(startPayload).toContain(expectedSignature);
    expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
      'channel-bot-2',
    );
  });

  it('rejects publishing when all engagement buttons are disabled', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-3', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.publishChannelEngagementMessage(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Нажмите кнопку ниже.',
          commentsButtonText: 'Комментарии',
          suggestButtonText: 'Предложить пост',
        },
      ),
    ).rejects.toThrow('Включите комментарии или предложения постов в настройках канала.');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('stores and queries dialog messages inside the thread encoded in the button token', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    mockChannelEngagementSettings(prisma, {
      commentsEnabled: true,
      postSuggestionsEnabled: false,
    });
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'message-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-4', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Нажмите кнопку ниже.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    const commentsButton = options.buttons?.[0]?.[0];
    const commentsToken = readDialogButtonToken(commentsButton);
    const commentsTokenPayload = decodeBase64UrlJson<{ d: string }>(commentsToken.slice(4));

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Первый комментарий',
      },
    );

    await service.getChannelDialog(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    const commentAuditPayload = prisma.auditLog.create.mock.calls[1]?.[0]?.data?.payload as {
      threadId?: unknown;
    };
    expect(commentAuditPayload.threadId).toBe(commentsTokenPayload.d);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          action: 'CHANNEL_DIALOG_COMMENT',
          payload: {
            path: ['threadId'],
            equals: commentsTokenPayload.d,
          },
        }),
      }),
    );
  });

  it('loads channel dialog admin accents from the persisted allowlist without remote MAX reads', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-comment-user-1',
        actorUserId: 'user-2',
        payload: {
          type: 'comments',
          text: 'Обычный комментарий',
          authorDisplayName: 'Марина',
        },
        createdAt: new Date('2026-03-20T09:05:00.000Z'),
      },
      {
        id: 'channel-comment-admin-1',
        actorUserId: 'admin-1',
        payload: {
          type: 'comments',
          text: 'Комментарий администратора',
          authorDisplayName: 'Александр',
        },
        createdAt: new Date('2026-03-20T09:00:00.000Z'),
      },
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ userId: 'admin-1' }]);

    const maxClient = {
      getChatAdminIds: jest.fn(),
      getChatMemberProfiles: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-fast-open',
    ) as string;

    const result = await service.getChannelDialog(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(result.messages[0]).toMatchObject({
      authorUserId: 'admin-1',
      isAdmin: true,
      avatarUrl: null,
    });
    expect(result.messages[1]).toMatchObject({
      authorUserId: 'user-2',
      isAdmin: false,
      avatarUrl: null,
    });
  });

  it('lists compact suggestion image metadata without hydrating stored image assets', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        postSuggestionsEnabled: true,
      }),
    );
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-suggestion-compact-image-1',
        actorUserId: 'user-1',
        payload: {
          type: 'suggest',
          text: 'Предложение с фотографией',
          authorDisplayName: 'Пользователь',
          delivered: false,
          reviewStatus: 'pending',
          hasImage: true,
          imageStorageVersion: 1,
          imageCount: 2,
          imageFileNames: ['suggestion.jpg', 'second.png'],
          suggestionDelivery: {
            state: 'partially_delivered',
            deliveredCount: 1,
            targetCount: 3,
            pendingCount: 0,
            unreachableCount: 2,
          },
        },
        createdAt: new Date('2026-03-20T09:10:00.000Z'),
      },
    ]);

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const suggestionToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'suggest',
      'channel-thread-compact-image',
    ) as string;

    const result = await service.getChannelDialog(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'suggest',
      suggestionToken,
    );

    expect(prisma.channelSuggestionImageAsset.findMany).not.toHaveBeenCalled();
    expect(result.messages[0]).toMatchObject({
      id: 'channel-suggestion-compact-image-1',
      hasImage: true,
      imageCount: 2,
      imageFileName: 'suggestion.jpg',
      imageFileNames: ['suggestion.jpg', 'second.png'],
    });
    expect(result.messages[0]?.suggestionDelivery).toEqual({
      state: 'partially_delivered',
      deliveredCount: 0,
      targetCount: 0,
      pendingCount: 0,
      unreachableCount: 0,
    });
  });

  it('stores a reply preview snapshot when posting a channel comment reply', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-root-1',
      payload: {
        text: 'Исходный комментарий для ответа',
        authorDisplayName: 'Марина',
      },
    });
    prisma.auditLog.create.mockResolvedValue({
      id: 'comment-reply-1',
      actorUserId: 'user-2',
      payload: {},
      createdAt: new Date('2026-03-20T10:15:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('channel', 'channel-1', 'comments', 'channel-thread-reply') as string;

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-2',
        username: 'user2',
        displayName: 'Ольга',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Отвечаю на исходный комментарий',
        replyToMessageId: 'comment-root-1',
      },
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            replyTo: {
              messageId: 'comment-root-1',
              authorDisplayName: 'Марина',
              text: 'Исходный комментарий для ответа',
            },
          }),
        }),
      }),
    );
    expect(result.message.replyTo).toEqual({
      messageId: 'comment-root-1',
      authorDisplayName: 'Марина',
      text: 'Исходный комментарий для ответа',
    });
    expect(result.message.replyToMessageId).toBe('comment-root-1');
  });

  it('toggles channel comment reactions and returns reactedByMe for the current user', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-1',
      actorUserId: 'user-9',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-reactions',
        text: 'Комментарий с реакциями',
        authorDisplayName: 'Марина',
        reactions: [{ emoji: '👍', userIds: ['user-2'] }],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'comment-1',
      actorUserId: 'user-9',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-reactions',
        text: 'Комментарий с реакциями',
        authorDisplayName: 'Марина',
        reactions: [{ emoji: '👍', userIds: ['user-2', 'user-1'] }],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-reactions',
    ) as string;

    const result = await service.toggleChannelDialogReaction(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'comment-1',
      {
        token: commentsToken,
        emoji: '👍',
      },
    );

    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'comment-1',
        },
        data: expect.objectContaining({
          payload: expect.objectContaining({
            reactions: [{ emoji: '👍', userIds: ['user-2', 'user-1'] }],
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      message: {
        id: 'comment-1',
        reactionGroups: [{ emoji: '👍', count: 2, reactedByMe: true }],
      },
    });
  });

  it('keeps admin marker on a channel comment after reaction toggle', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-admin-1',
      actorUserId: 'admin-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-admin-reactions',
        text: 'Админский комментарий',
        authorDisplayName: 'Александр',
        reactions: [{ emoji: '👍', userIds: ['user-2'] }],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'comment-admin-1',
      actorUserId: 'admin-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-admin-reactions',
        text: 'Админский комментарий',
        authorDisplayName: 'Александр',
        reactions: [{ emoji: '👍', userIds: ['user-2', 'user-3'] }],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-admin-reactions',
    ) as string;

    const result = await service.toggleChannelDialogReaction(
      'channel-1',
      {
        userId: 'user-3',
        username: 'user3',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'comment-admin-1',
      {
        token: commentsToken,
        emoji: '👍',
      },
    );

    expect(result.message).toMatchObject({
      id: 'comment-admin-1',
      isAdmin: true,
      reactionGroups: [{ emoji: '👍', count: 2, reactedByMe: true }],
    });
  });

  it('keeps only one active reaction per user when switching channel comment reactions', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-2',
      actorUserId: 'user-9',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-reactions',
        text: 'Комментарий со сменой реакции',
        authorDisplayName: 'Марина',
        reactions: [
          { emoji: '👍', userIds: ['user-2', 'user-1'] },
          { emoji: '🔥', userIds: ['user-3'] },
        ],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'comment-2',
      actorUserId: 'user-9',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-reactions',
        text: 'Комментарий со сменой реакции',
        authorDisplayName: 'Марина',
        reactions: [
          { emoji: '👍', userIds: ['user-2'] },
          { emoji: '🔥', userIds: ['user-3'] },
          { emoji: '❤️', userIds: ['user-1'] },
        ],
      },
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-reactions',
    ) as string;

    const result = await service.toggleChannelDialogReaction(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'comment-2',
      {
        token: commentsToken,
        emoji: '❤️',
      },
    );

    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'comment-2',
        },
        data: expect.objectContaining({
          payload: expect.objectContaining({
            reactions: expect.arrayContaining([
              { emoji: '👍', userIds: ['user-2'] },
              { emoji: '🔥', userIds: ['user-3'] },
              { emoji: '❤️', userIds: ['user-1'] },
            ]),
          }),
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.message.reactionGroups).toEqual(
      expect.arrayContaining([
        { emoji: '👍', count: 1, reactedByMe: false },
        { emoji: '🔥', count: 1, reactedByMe: false },
        { emoji: '❤️', count: 1, reactedByMe: true },
      ]),
    );
  });

  it('allows the author to edit a channel comment and returns edit capabilities', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-edit-1',
      actorUserId: 'user-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-edit',
        text: 'Старый текст',
        authorDisplayName: 'Пользователь',
        reactions: [{ emoji: '👍', userIds: ['user-2'] }],
      },
      createdAt: new Date('2026-03-21T10:00:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'comment-edit-1',
      actorUserId: 'user-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-edit',
        text: 'Обновлённый текст',
        editedAt: '2026-03-21T10:05:00.000Z',
        authorDisplayName: 'Пользователь',
        reactions: [{ emoji: '👍', userIds: ['user-2'] }],
      },
      createdAt: new Date('2026-03-21T10:00:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('channel', 'channel-1', 'comments', 'channel-thread-edit') as string;

    const result = await service.updateChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'comment-edit-1',
      {
        token: commentsToken,
        text: 'Обновлённый текст',
      },
    );

    expect(prisma.auditLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'comment-edit-1',
        },
        data: expect.objectContaining({
          payload: expect.objectContaining({
            text: 'Обновлённый текст',
            editedAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      message: {
        id: 'comment-edit-1',
        text: 'Обновлённый текст',
        editedAt: '2026-03-21T10:05:00.000Z',
        canEdit: true,
        canDelete: true,
        canDeleteAsAdmin: false,
      },
    });
  });

  it('rejects editing another user channel comment', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-edit-foreign-1',
      actorUserId: 'user-2',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-edit-foreign',
        text: 'Чужой комментарий',
      },
      createdAt: new Date('2026-03-21T10:00:00.000Z'),
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-edit-foreign',
    ) as string;

    await expect(
      service.updateChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        'comment-edit-foreign-1',
        {
          token: commentsToken,
          text: 'Пытаюсь изменить чужой комментарий',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('allows an admin to delete another user channel comment', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'comment-delete-admin-1',
      actorUserId: 'user-2',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-delete-admin',
        text: 'Чужой комментарий',
      },
      createdAt: new Date('2026-03-21T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-delete-admin',
    ) as string;

    const result = await service.deleteChannelDialogMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: 'admin1',
        displayName: 'Админ',
        chatTitle: null,
      },
      'comments',
      'comment-delete-admin-1',
      {
        token: commentsToken,
      },
    );

    expect(prisma.auditLog.delete).toHaveBeenCalledWith({
      where: {
        id: 'comment-delete-admin-1',
      },
    });
    expect(result).toEqual({
      ok: true,
      deletedMessageId: 'comment-delete-admin-1',
    });
  });

  it('updates the published channel comments button counter after a new comment', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(4);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-engagement-ref-1',
        action: 'PUBLISH_CHANNEL_ENGAGEMENT',
        payload: {
          messageId: 'mid-channel-engagement-99',
          threadId: 'channel-thread-counter',
          botId: 'channel-bot-2',
          commentsButtonText: 'Комментарии',
          includeCommentsButton: true,
          includeSuggestButton: true,
          suggestButtonText: 'Предложить пост',
          customButtons: [{ text: 'Заказать рекламу', url: 'https://max.ru/advertiser' }],
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-count-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();
    const maxBotLinkService = {
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string) =>
            `https://max.ru/entry-bot?startapp=${encodeURIComponent(startParam)}`,
        ),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || '777000_bot')}?startapp=${encodeURIComponent(startParam)}`,
        ),
      buildBotStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startPayload: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || '777000_bot')}?start=${encodeURIComponent(startPayload)}`,
        ),
      resolveContactIdSync: jest.fn((botId?: string | null) =>
        botId === 'channel-bot-2' ? '990002' : null,
      ),
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotId: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-counter',
    ) as string;

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Новый комментарий в канале',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-engagement-99',
      null,
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: 'Комментарии · 4', type: 'link' })],
          [expect.objectContaining({ text: 'Предложить пост' })],
          [
            {
              type: 'link',
              text: 'Заказать рекламу',
              url: 'https://max.ru/advertiser',
            },
          ],
        ],
        mergeExistingInlineKeyboard: true,
      }),
      { botId: 'channel-bot-2' },
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[3]).not.toHaveProperty(
      'appendNewInlineKeyboardRows',
    );
    expect(maxBotLinkService.resolveContactIdSync).toHaveBeenCalledWith('channel-bot-2');
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    const [, , , keyboardOptions] = maxClient.editMessageInlineKeyboard.mock.calls[0] ?? [];
    const commentsButton = keyboardOptions?.buttons?.[0]?.[0] as { url?: string } | undefined;
    expect(commentsButton).toMatchObject({
      url: expect.stringContaining('https://max.ru/entry-bot?startapp='),
    });
  });

  it('leaves suggestion-only keyboards untouched after a comment', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(4);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-auto-suggest-ref-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          messageId: 'mid-channel-auto-suggest-99',
          threadId: 'channel-thread-counter',
          includeCommentsButton: false,
          includeSuggestButton: true,
          suggestButtonText: 'Предложить пост',
          customButtons: [
            { text: 'Заказать рекламу', url: 'https://max.ru/advertiser' },
            { text: 'Прайс', url: 'https://max.ru/pricelist' },
          ],
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-count-2',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-counter',
    ) as string;

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Новый комментарий в канале',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('refreshes auto-attached channel buttons on the bot copy instead of the original forwarded post', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(5);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-auto-forward-ref-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          messageId: 'mid-channel-forward-original-1',
          replacementMessageId: 'mid-channel-forward-copy-1',
          deliveryMode: 'replace_with_bot_message',
          threadId: 'channel-thread-forward-counter',
          includeCommentsButton: true,
          includeSuggestButton: true,
          suggestButtonText: 'Предложить пост',
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-count-forward-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T09:06:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-forward-counter',
    ) as string;

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Комментарий под пересланным постом',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-copy-1',
      null,
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 5', type: 'link' })],
          [expect.objectContaining({ text: 'Предложить пост' })],
        ],
      }),
    );
  });

  it('refreshes auto-attached channel buttons on the reply fallback message', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(6);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-auto-forward-reply-ref-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: {
          messageId: 'mid-channel-forward-original-2',
          replyMessageId: 'mid-channel-forward-reply-2',
          deliveryMode: 'reply_message',
          threadId: 'channel-thread-forward-reply-counter',
          includeCommentsButton: true,
          includeSuggestButton: false,
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-count-forward-2',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T09:07:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-forward-reply-counter',
    ) as string;

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Комментарий под fallback reply',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-channel-forward-reply-2',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 6', type: 'link' })]],
      }),
    );
  });

  it('accepts a mini app suggestion from a thread-scoped button and still delivers it to admins in the bot', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
      postSuggestionsEntryMode: 'MINIAPP',
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Есть идея для следующего поста',
        delivered: false,
        deliveredToUserId: null,
        source: 'miniapp_dialog',
      },
      createdAt: new Date('2026-03-10T12:10:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Есть идея для следующего поста',
        delivered: true,
        deliveredToUserId: 'admin-1',
        source: 'miniapp_dialog',
      },
      createdAt: new Date('2026-03-10T12:10:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-5', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const maxBotLinkService = {
      ...createAdminMaxBotLinkMock(),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || '777000_bot')}?startapp=${encodeURIComponent(startParam)}`,
        ),
      buildBotStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startPayload: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || '777000_bot')}?start=${encodeURIComponent(startPayload)}`,
        ),
      resolveContactIdSync: jest.fn((botId?: string | null) =>
        botId === 'channel-bot-2' ? '990002' : null,
      ),
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotId: jest.fn().mockResolvedValue(undefined),
      resolveBotIdForCapability: jest.fn().mockResolvedValue(undefined),
      bindDiscoveredChatBots: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);
    const suggestTokenPayload = decodeBase64UrlJson<{ d: string }>(suggestToken.slice(4));

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'suggest',
      {
        token: suggestToken,
        text: 'Есть идея для следующего поста',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      message: {
        type: 'suggest',
        text: 'Есть идея для следующего поста',
      },
    });
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('Новая предложка'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      expect.objectContaining({
        botId: '777000_bot',
        trafficClass: 'background',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CHANNEL_DIALOG_SUGGESTION',
          payload: expect.objectContaining({
            threadId: suggestTokenPayload.d,
            source: 'miniapp_dialog',
          }),
        }),
      }),
    );
  });

  it('accepts a photo-only suggestion from the mini app and returns pending review metadata', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-image-only-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: '',
        delivered: false,
        deliveredToUserId: null,
        reviewStatus: 'pending',
        hasImage: true,
        imageFileName: 'suggestion.webp',
        source: 'miniapp_dialog',
      },
      createdAt: new Date('2026-03-25T09:10:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-image-only-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: '',
        delivered: true,
        deliveredToUserId: 'admin-1',
        reviewStatus: 'pending',
        hasImage: true,
        imageFileName: 'suggestion.webp',
        source: 'miniapp_dialog',
      },
      createdAt: new Date('2026-03-25T09:10:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-6', url: null }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-suggest-miniapp-1' }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-2', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'suggest',
      {
        token: suggestToken,
        text: '',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        imageMimeType: 'image/png',
        imageFileName: 'suggestion.webp',
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'suggestion.webp',
      'image/png',
      expect.objectContaining({
        botId: '777000_bot',
        sourceTag: 'suggestion_delivery',
        timeoutMs: 12_000,
        trafficClass: 'background',
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      message: {
        id: 'suggestion-image-only-1',
        type: 'suggest',
        text: '',
        delivered: true,
        reviewStatus: 'pending',
        hasImage: true,
        imageFileName: 'suggestion.webp',
      },
    });
  });

  it('does not duplicate mini app suggestion images when the payload contains an attachment mirror', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-image-dedupe-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: '',
        delivered: false,
        deliveredToUserId: null,
        reviewStatus: 'pending',
        hasImage: true,
        imageCount: 1,
        imageFileName: 'suggestion.webp',
        imageFileNames: ['suggestion.webp'],
        source: 'miniapp_dialog',
      },
      createdAt: new Date('2026-03-25T09:11:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-image-dedupe-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: '',
        delivered: true,
        deliveredToUserId: 'admin-1',
        reviewStatus: 'pending',
        hasImage: true,
        imageCount: 1,
        imageFileName: 'suggestion.webp',
        imageFileNames: ['suggestion.webp'],
        source: 'miniapp_dialog',
      },
      createdAt: new Date('2026-03-25T09:11:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-6b', url: null }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-suggest-miniapp-1' }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-2b', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);
    const image = {
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      fileName: 'suggestion.webp',
    };

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'suggest',
      {
        token: suggestToken,
        text: '',
        images: [image],
        attachments: [{ type: 'image', ...image }],
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            imageCount: 1,
            imageFileNames: ['suggestion.png'],
            imageStorageVersion: 1,
          }),
        }),
      }),
    );
    const stored = prisma.auditLog.create.mock.calls[1]?.[0]?.data;
    expect(stored.payload.images).toBeUndefined();
    expect(stored.payload.imageBase64).toBeUndefined();
    expect(stored.channelSuggestionImageAssets.create).toEqual([
      expect.objectContaining({ position: 0, bytes: expect.any(Uint8Array), sizeBytes: 68 }),
    ]);
    expect(result.message).toMatchObject({
      id: 'suggestion-image-dedupe-1',
      type: 'suggest',
      hasImage: true,
      imageCount: 1,
    });
  });

  it('queues mini app suggestions for async admin delivery when the queue is available', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-queued-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        threadId: null,
        text: 'Отложенная предложка',
        authorDisplayName: 'Пользователь',
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        source: 'miniapp_dialog',
        reviewStatus: 'pending',
        hasImage: false,
        hasVideo: false,
      },
      createdAt: new Date('2026-03-25T09:15:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-queue-1', url: null }),
      sendMessageImmediateWithId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const adminSuggestionDeliveryQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      adminSuggestionDeliveryQueue as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'suggest',
      {
        token: suggestToken,
        text: 'Отложенная предложка',
      },
    );

    expect(adminSuggestionDeliveryQueue.add).toHaveBeenCalledWith(
      'deliver-channel-suggestion',
      {
        auditLogId: 'suggestion-queued-1',
      },
      expect.objectContaining({
        jobId: 'channel-suggestion-delivery__suggestion-queued-1',
        attempts: 8,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      message: {
        id: 'suggestion-queued-1',
        type: 'suggest',
        text: 'Отложенная предложка',
        delivered: false,
        reviewStatus: 'pending',
      },
    });
  });

  it('recovers stale pending suggestion delivery by retrying the failed BullMQ job', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ id: 'suggestion-stale-queued-1' }]);
    const failedJob = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const adminSuggestionDeliveryQueue = {
      getJob: jest.fn().mockResolvedValue(failedJob),
      add: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      { getChatAdminIds: jest.fn() } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      adminSuggestionDeliveryQueue as never,
    );

    await expect(service.recoverStaleChannelSuggestionDeliveries()).resolves.toBe(1);

    expect(adminSuggestionDeliveryQueue.getJob).toHaveBeenCalledWith(
      'channel-suggestion-delivery__suggestion-stale-queued-1',
    );
    expect(failedJob.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(adminSuggestionDeliveryQueue.add).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'delayed', 'active'])(
    'does not count an already %s suggestion delivery job as recovered',
    async (state) => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([{ id: 'suggestion-already-scheduled-1' }]);
      const existingJob = {
        getState: jest.fn().mockResolvedValue(state),
        retry: jest.fn(),
      };
      const adminSuggestionDeliveryQueue = {
        getJob: jest.fn().mockResolvedValue(existingJob),
        add: jest.fn(),
      };

      const service = new AdminService(
        prisma as never,
        { getChatAdminIds: jest.fn() } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        adminSuggestionDeliveryQueue as never,
      );

      await expect(service.recoverStaleChannelSuggestionDeliveries()).resolves.toBe(0);
      expect(existingJob.retry).not.toHaveBeenCalled();
      expect(adminSuggestionDeliveryQueue.add).not.toHaveBeenCalled();
    },
  );

  it('includes recoverable attempted delivery failures in stale suggestion recovery', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'suggestion-recoverable-delivery-failure-1' }]);
    const adminSuggestionDeliveryQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      { getChatAdminIds: jest.fn() } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      adminSuggestionDeliveryQueue as never,
    );

    await expect(service.recoverStaleChannelSuggestionDeliveries()).resolves.toBe(1);

    const recoverySql = extractSqlText(prisma.$queryRaw.mock.calls[1]?.[0]);
    expect(recoverySql).toContain('channel_suggestion_admin_deliveries');
    expect(recoverySql).toContain("payload->'deliveryFailures'");
    expect(recoverySql).toContain("delivery_failure.value->>'recoverable' = 'true'");
    expect(recoverySql).toContain("payload->>'deliveryJobLastFailedAt'");
    expect(recoverySql).toContain("payload->>'deliveryJobRecoverable' = 'true'");
    expect(recoverySql).toContain('GROUP BY audit.id, audit.created_at');
    expect(recoverySql).toContain('ORDER BY MIN(');
    expect(recoverySql).toContain('delivery.updated_at');
    expect(adminSuggestionDeliveryQueue.add).toHaveBeenCalledWith(
      'deliver-channel-suggestion',
      { auditLogId: 'suggestion-recoverable-delivery-failure-1' },
      expect.objectContaining({
        jobId: 'channel-suggestion-delivery__suggestion-recoverable-delivery-failure-1',
      }),
    );
  });

  it('records recoverable suggestion delivery job failures without closing the pending delivery', async () => {
    const prisma = createPrismaMock();
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-timeout-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        text: 'Зависшая предложка',
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        reviewStatus: 'pending',
      },
    });

    const service = new AdminService(
      prisma as never,
      { getChatAdminIds: jest.fn() } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.recordChannelSuggestionDeliveryJobFailure(
      'suggestion-timeout-1',
      new Error('timeout exceeded when trying to connect'),
      {
        final: true,
        attemptsMade: 8,
        maxAttempts: 8,
      },
    );

    const failureSql = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    const failurePatch = readSqlJsonPatch(prisma.$executeRaw, 'deliveryJobLastError');
    expect(failureSql).toContain("audit.payload->>'reviewStatus'");
    expect(failureSql).toContain('NOT EXISTS');
    expect(failureSql).toContain('channel_suggestion_admin_deliveries');
    expect(failureSql).toContain("'deliveryJobFailureCount'");
    expect(failurePatch).toEqual(
      expect.objectContaining({
        delivered: false,
        deliveryJobRecoverable: true,
        deliveryJobLastError: expect.objectContaining({
          recoverable: true,
          final: true,
          attemptsMade: 8,
          maxAttempts: 8,
        }),
      }),
    );
    expect(failurePatch.deliveryAttemptedAt).toBeUndefined();
    expect(failurePatch.deliveryFailures).toBeUndefined();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('marks terminal suggestion delivery job failures as attempted so recovery does not loop forever', async () => {
    const prisma = createPrismaMock();
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-terminal-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        text: 'Недоступная предложка',
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        reviewStatus: 'pending',
      },
    });

    const service = new AdminService(
      prisma as never,
      { getChatAdminIds: jest.fn() } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.recordChannelSuggestionDeliveryJobFailure(
      'suggestion-terminal-1',
      {
        response: {
          status: 403,
          data: {
            code: 'access.denied',
            message: 'access denied',
          },
        },
      },
      {
        final: true,
        attemptsMade: 8,
        maxAttempts: 8,
      },
    );

    const failurePatch = readSqlJsonPatch(prisma.$executeRaw, 'deliveryJobLastError');
    expect(failurePatch).toEqual(
      expect.objectContaining({
        delivered: false,
        deliveryAttemptedAt: expect.any(String),
        deliveryJobRecoverable: false,
        suggestionDelivery: {
          state: 'uncertain',
          deliveredCount: 0,
          targetCount: 0,
          pendingCount: 0,
          unreachableCount: 0,
        },
        deliveryFailures: [
          expect.objectContaining({
            adminUserId: 'delivery_job',
            status: 403,
            code: 'access.denied',
            terminal: true,
            message: 'access denied',
          }),
        ],
      }),
    );
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('retries attempted suggestion delivery when every admin send failed transiently', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-transient-attempt-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Повторить доставку',
        textFormat: 'plain',
        textMarkup: [],
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        deliveryAttemptedAt: '2026-03-10T12:00:00.000Z',
        deliveryFailures: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            status: 429,
            code: 'rate.limit',
            terminal: false,
            recoverable: true,
            message: 'rate limit exceeded',
          },
        ],
        source: 'private_bot',
        reviewStatus: 'pending',
        hasImage: false,
        imageCount: 0,
        hasVideo: false,
        images: [],
      },
      createdAt: new Date('2026-03-10T12:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-recovered-1', url: null }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-transient-attempt-1');

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('Повторить доставку'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        trafficClass: 'background',
      }),
    );
    expect(readSqlJsonPatch(prisma.$queryRaw, 'deliveryAttemptedAt')).toEqual(
      expect.objectContaining({
        delivered: true,
        deliveredToUserId: 'admin-1',
        deliveries: [
          expect.objectContaining({
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-suggestion-recovered-1',
          }),
        ],
      }),
    );
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('drops mismatched stored author identity during suggestion delivery recovery', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-mismatched-author-1',
      chatId: 'channel-1',
      actorUserId: 'canonical-user',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'payload-user',
        authorDisplayName: 'Чужой пользователь',
        authorUsername: 'payload-user',
        authorProfileUrl: 'https://max.ru/payload-user',
        text: 'Проверить автора',
        reviewStatus: 'pending',
        delivered: false,
        deliveries: [],
      },
      createdAt: new Date('2026-03-10T12:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-canonical-author-1', url: null }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-mismatched-author-1');

    const deliveredText = maxClient.sendMessageImmediateWithId.mock.calls[0]?.[1];
    expect(deliveredText).toContain('Отправитель: canonical-user');
    expect(deliveredText).not.toContain('Чужой пользователь');
    expect(deliveredText).not.toContain('payload-user');
    expect(deliveredText).not.toContain('https://max.ru/payload-user');
  });

  it('claims durable suggestion admin delivery rows before sending', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-ledger-claim-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Проверить ledger',
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        source: 'private_bot',
        reviewStatus: 'pending',
        hasImage: false,
        imageCount: 0,
        hasVideo: false,
        images: [],
      },
      createdAt: new Date('2026-03-10T12:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async () => {
        const rows = await prisma.channelSuggestionAdminDelivery.findMany({
          where: { auditLogId: 'suggestion-ledger-claim-1' },
        });
        expect(rows).toEqual([
          expect.objectContaining({
            adminUserId: 'admin-1',
            status: 'SENDING',
            attemptCount: 1,
            remoteMessageId: null,
            lockToken: expect.any(String),
          }),
        ]);
        return { messageId: 'mid-suggestion-ledger-1', url: null };
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-ledger-claim-1');

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-ledger-claim-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        adminUserId: 'admin-1',
        status: 'SENT',
        attemptCount: 1,
        remoteMessageId: 'mid-suggestion-ledger-1',
        privateChatId: '555001',
      }),
    ]);
  });

  it('does not resend successful suggestion admin deliveries when retrying remaining admins', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-ledger-retry-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Повторить оставшимся',
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        source: 'private_bot',
        reviewStatus: 'pending',
        hasImage: false,
        imageCount: 0,
        hasVideo: false,
        images: [],
      },
      createdAt: new Date('2026-03-10T12:00:00.000Z'),
    });

    const rateLimitError = {
      response: {
        status: 503,
        data: {
          code: 'temporarily.unavailable',
          message: 'temporarily unavailable',
        },
      },
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1', 'admin-2']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValueOnce({ messageId: 'mid-suggestion-admin-1', url: null })
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ messageId: 'mid-suggestion-admin-2', url: null }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-ledger-retry-1');
    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-ledger-retry-1' },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adminUserId: 'admin-1',
          status: 'SENT',
          remoteMessageId: 'mid-suggestion-admin-1',
          attemptCount: 1,
        }),
        expect.objectContaining({
          adminUserId: 'admin-2',
          status: 'FAILED',
          attemptCount: 1,
          terminal: false,
        }),
      ]),
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-ledger-retry-1');

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(3);
    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-ledger-retry-1' },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adminUserId: 'admin-1',
          status: 'SENT',
          remoteMessageId: 'mid-suggestion-admin-1',
          attemptCount: 1,
        }),
        expect.objectContaining({
          adminUserId: 'admin-2',
          status: 'SENT',
          remoteMessageId: 'mid-suggestion-admin-2',
          attemptCount: 2,
        }),
      ]),
    );
  });

  it('marks timed out suggestion admin sends ambiguous and does not auto retry them', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-ledger-timeout-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Не дублировать таймаут',
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        source: 'private_bot',
        reviewStatus: 'pending',
        hasImage: false,
        imageCount: 0,
        hasVideo: false,
        images: [],
      },
      createdAt: new Date('2026-03-10T12:00:00.000Z'),
    });
    const timeoutError = Object.assign(new Error('timeout of 5000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn(
        async (_chatId: string, _text: string, options?: { beforeSend?: () => Promise<void> }) => {
          await options?.beforeSend?.();
          throw timeoutError;
        },
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-ledger-timeout-1');

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-ledger-timeout-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        adminUserId: 'admin-1',
        status: 'AMBIGUOUS',
        attemptCount: 1,
        remoteMessageId: null,
        terminal: false,
      }),
    ]);

    maxClient.getChatAdminIds.mockClear();
    await service.processChannelSuggestionDeliveryJob('suggestion-ledger-timeout-1');

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
  });

  it('does not retry attempted suggestion delivery when failures are terminal', async () => {
    const prisma = createPrismaMock();
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-terminal-attempt-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        text: 'Не гонять по кругу',
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        deliveryAttemptedAt: '2026-03-10T12:00:00.000Z',
        deliveryFailures: [
          {
            adminUserId: 'admin-1',
            privateChatId: null,
            status: 403,
            code: 'access.denied',
            terminal: true,
            recoverable: false,
            message: 'access denied',
          },
        ],
        reviewStatus: 'pending',
      },
      createdAt: new Date('2026-03-10T12:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn(),
      sendMessageImmediateWithId: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-terminal-attempt-1');

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it('marks bot-submitted suggestions with private_bot source', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-2',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:11:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-6', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-2', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: 'Предложка через бота',
      },
    );

    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CHANNEL_DIALOG_SUGGESTION',
          payload: expect.objectContaining({
            source: 'private_bot',
          }),
        }),
      }),
    );
  });

  it('delivers bot-submitted suggestions with restored MAX markup to admins', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-rich-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:11:30.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-6b', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-rich-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);
    const sourceText = '🔥MAX Docs\n\nВторой абзац';
    const expectedHtml =
      '🔥<a href="https://dev.max.ru/docs-api"><strong>MAX Docs</strong></a>\n\nВторой абзац';

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: sourceText,
        textMarkup: [
          {
            from: 2,
            length: 8,
            type: 'strong',
          },
          {
            from: 2,
            length: 8,
            type: 'link',
            url: 'https://dev.max.ru/docs-api',
          },
        ],
      },
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining(expectedHtml),
      expect.objectContaining({
        textFormat: 'html',
      }),
      expect.objectContaining({
        trafficClass: 'background',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            source: 'private_bot',
            text: sourceText,
            textMarkup: [
              expect.objectContaining({
                from: 2,
                length: 8,
                type: 'strong',
              }),
              expect.objectContaining({
                from: 2,
                length: 8,
                type: 'link',
                url: 'https://dev.max.ru/docs-api',
              }),
            ],
          }),
        }),
      }),
    );
  });

  it('keeps MAX markup when queued bot suggestions are later delivered to admins', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-rich-queued-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:11:45.000Z'),
    });
    (prisma.auditLog as any).findUnique = jest.fn().mockResolvedValue({
      id: 'suggestion-rich-queued-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: '\n🔥MAX Docs\n\nВторой абзац',
        textFormat: 'plain',
        textMarkup: [
          {
            from: 3,
            length: 8,
            type: 'strong',
          },
          {
            from: 3,
            length: 8,
            type: 'link',
            url: 'https://dev.max.ru/docs-api',
          },
        ],
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        source: 'private_bot',
        reviewStatus: 'pending',
        hasImage: false,
        imageCount: 0,
        hasVideo: false,
        images: [],
      },
      createdAt: new Date('2026-03-10T12:11:45.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-6c', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-rich-queued-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const adminSuggestionDeliveryQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      adminSuggestionDeliveryQueue as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);
    const sourceText = '\n🔥MAX Docs\n\nВторой абзац';
    const expectedHtml =
      '\n🔥<a href="https://dev.max.ru/docs-api"><strong>MAX Docs</strong></a>\n\nВторой абзац';

    const result = await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: sourceText,
        textMarkup: [
          {
            from: 3,
            length: 8,
            type: 'strong',
          },
          {
            from: 3,
            length: 8,
            type: 'link',
            url: 'https://dev.max.ru/docs-api',
          },
        ],
      },
    );

    expect(result).toEqual({
      ok: true,
      delivered: false,
      queued: true,
    });
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();

    await service.processChannelSuggestionDeliveryJob('suggestion-rich-queued-1');

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining(expectedHtml),
      expect.objectContaining({
        textFormat: 'html',
      }),
      expect.objectContaining({
        trafficClass: 'background',
      }),
    );
  });

  it('delivers Publisher suggestions through the exact current bot after a bot rotation', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'publisher-channel-1',
      title: 'Канал Публика',
      entityType: 'CHANNEL',
    });
    (prisma as any).managedEntityAccessEdge = {
      findMany: jest.fn().mockResolvedValue([{ userId: 'publisher-admin-1' }]),
    };
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '700001' }]);
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'publisher-suggestion-delivery-1',
      chatId: 'publisher-channel-1',
      actorUserId: 'subscriber-1',
      action: 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'subscriber-1',
        authorDisplayName: 'Подписчик',
        text: 'Новая публикация',
        textFormat: 'plain',
        delivered: false,
        deliveredToUserIds: [],
        deliveries: [],
        reviewStatus: 'pending',
        hasImage: false,
        imageCount: 0,
      },
      createdAt: new Date('2026-09-01T18:00:00.000Z'),
    });
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'publisher-suggestion-delivery-1',
          adminUserId: 'publisher-admin-1',
          botKey: 'publisher:retired-publisher-bot',
          botId: 'retired-publisher-bot',
          status: 'FAILED',
          terminal: true,
          lastStatusCode: 404,
          lastErrorCode: 'suggestion.delivery.no_reachable_dialog',
        },
      ],
    });

    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({ userId: 'publisher-bot-user' }),
      getChatAdminIds: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['publisher-admin-1', { isAdmin: true, isOwner: false }]])),
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (_chatId, _text, options) => {
        await options.beforeSend();
        return { messageId: 'publisher-card-mid-1', chatId: '700001', url: null };
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).publisherReadinessService = {
      assertEntityReady: jest.fn().mockResolvedValue({
        chatId: 'publisher-channel-1',
        entityType: 'channel',
        requiredBotId: 'publisher-bot',
        policyRevision: 1,
      }),
    };

    await service.processPublisherSuggestionAdminDeliveryJob(
      'publisher-suggestion-delivery-1',
      'publisher-bot',
    );

    expect((prisma as any).managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'publisher-channel-1',
          botId: 'publisher-bot',
          entityType: 'CHANNEL',
          state: 'GRANTED',
          userRole: { in: ['OWNER', 'ADMIN'] },
        }),
      }),
    );
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'publisher-channel-1',
      ['publisher-admin-1'],
      expect.objectContaining({ botId: 'publisher-bot', bypassCache: true }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '700001',
      expect.stringContaining('Новая предложка'),
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: '📰 В публикацию',
              payload: 'psa:v1:publish:publisher-suggestion-delivery-1',
            }),
            expect.objectContaining({
              text: '✖️ Отклонить',
              payload: 'psa:v1:cancel:publisher-suggestion-delivery-1',
            }),
          ],
        ],
      }),
      expect.objectContaining({
        botId: 'publisher-bot',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      }),
    );
    const ledger = await prisma.channelSuggestionAdminDelivery.findMany({
      where: {
        auditLogId: 'publisher-suggestion-delivery-1',
        botKey: 'publisher:publisher-bot',
      },
    });
    expect(ledger).toEqual([
      expect.objectContaining({
        adminUserId: 'publisher-admin-1',
        botKey: 'publisher:publisher-bot',
        botId: 'publisher-bot',
        privateChatId: '700001',
        remoteMessageId: 'publisher-card-mid-1',
        status: 'SENT',
      }),
    ]);
    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({
        where: {
          auditLogId: 'publisher-suggestion-delivery-1',
          botKey: 'publisher:retired-publisher-bot',
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: true,
        botId: 'retired-publisher-bot',
      }),
    ]);
  });

  it('retries transient Publisher card sync and renders a drafted card as terminal', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'publisher-channel-1',
      title: 'Канал Публика',
      entityType: 'CHANNEL',
    });
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'publisher-suggestion-drafted-1',
      chatId: 'publisher-channel-1',
      payload: {
        type: 'suggest',
        actorUserId: 'subscriber-1',
        authorDisplayName: 'Подписчик',
        text: 'Текст черновика',
        textFormat: 'plain',
        reviewStatus: 'drafted',
        reviewedByDisplayName: 'Администратор',
      },
    });
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'publisher-suggestion-drafted-1',
          adminUserId: 'publisher-admin-1',
          botKey: 'publisher:publisher-bot',
          botId: 'publisher-bot',
          privateChatId: '700001',
          status: 'SENT',
          remoteMessageId: 'publisher-card-mid-1',
          sentAt: new Date('2026-09-01T18:00:00.000Z'),
        },
      ],
    });
    const transientError = new Error('connection reset while editing message');
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(transientError),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.syncPublisherSuggestionAdminReviewMessages(
        'publisher-suggestion-drafted-1',
        'publisher-bot',
      ),
    ).rejects.toBe(transientError);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '700001',
      'publisher-card-mid-1',
      expect.stringContaining('Предложка перенесена в черновик'),
      expect.objectContaining({ buttons: [] }),
      { botId: 'publisher-bot' },
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[2]).toContain(
      'Отправитель: [Подписчик](max://user/subscriber-1)',
    );
  });

  it('renders Publisher publication creation and fences a card finalized during sync', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'publisher-channel-1',
      title: 'Канал Публика',
      entityType: 'CHANNEL',
    });
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'publisher-suggestion-published-1',
      chatId: 'publisher-channel-1',
      payload: {
        type: 'suggest',
        actorUserId: 'subscriber-1',
        authorDisplayName: 'Подписчик',
        text: 'Текст публикации',
        textFormat: 'plain',
        reviewStatus: 'published',
        reviewedByDisplayName: 'Администратор',
      },
    });
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'publisher-suggestion-published-1',
          adminUserId: 'publisher-admin-1',
          botKey: 'publisher:publisher-bot',
          botId: 'publisher-bot',
          privateChatId: '700001',
          status: 'SENT',
          remoteMessageId: 'publisher-card-mid-1',
          sentAt: new Date('2026-09-01T18:00:00.000Z'),
        },
      ],
    });
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockImplementation(async () => {
        await prisma.channelSuggestionAdminDelivery.createMany({
          data: [
            {
              auditLogId: 'publisher-suggestion-published-1',
              adminUserId: 'publisher-admin-2',
              botKey: 'publisher:publisher-bot',
              botId: 'publisher-bot',
              privateChatId: '700002',
              status: 'SENT',
              remoteMessageId: 'publisher-card-mid-2',
              sentAt: new Date('2026-09-01T18:01:00.000Z'),
            },
          ],
        });
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.syncPublisherSuggestionAdminReviewMessages(
      'publisher-suggestion-published-1',
      'publisher-bot',
    );

    const editedText = maxClient.editMessageInlineKeyboard.mock.calls[0]?.[2] as string;
    expect(editedText).toContain('Предложка передана в публикацию');
    expect(editedText).toContain('Решение принял: Администратор');
    expect(editedText).toContain('Отправитель: [Подписчик](max://user/subscriber-1)');
    expect(editedText).not.toContain('Предложка опубликована');
    const markerQuery = prisma.$executeRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
      values?: unknown[];
    };
    expect(extractSqlText(markerQuery)).toContain('publisherAdminCardSyncKey');
    expect(extractSqlText(markerQuery)).toContain('SELECT COUNT(*)');
    expect(markerQuery.values).toContain(1);
    await expect(
      prisma.channelSuggestionAdminDelivery.findMany({
        where: {
          auditLogId: 'publisher-suggestion-published-1',
          botKey: 'publisher:publisher-bot',
          status: 'SENT',
        },
      }),
    ).resolves.toHaveLength(2);
    const markerPatch = markerQuery.values?.find(
      (value): value is string =>
        typeof value === 'string' && value.includes('"publisherAdminCardSyncKey"'),
    );
    expect(JSON.parse(markerPatch ?? '{}')).toEqual(
      expect.objectContaining({
        publisherAdminCardSyncKey: expect.stringMatching(/^v1:/u),
        publisherAdminCardSyncedCount: 1,
        publisherAdminCardSyncedAt: expect.any(String),
      }),
    );
  });

  it('prefers stored relation image bytes when a queued suggestion is delivered', async () => {
    const prisma = createPrismaMock();
    const relationBytes = Buffer.from('relation-image-bytes');
    const legacyBase64 = Buffer.from('legacy-image-bytes').toString('base64');
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-relation-image-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Фото из relation',
        delivered: false,
        deliveredToUserIds: [],
        deliveries: [],
        reviewStatus: 'pending',
        hasImage: true,
        imageCount: 1,
        images: [
          {
            base64: legacyBase64,
            mimeType: 'image/jpeg',
            fileName: 'legacy.jpg',
          },
        ],
      },
      createdAt: new Date('2026-03-10T12:11:45.000Z'),
    });
    prisma.channelSuggestionImageAsset.findMany.mockResolvedValue([
      {
        position: 0,
        bytes: relationBytes,
        durablePayload: null,
        mimeType: 'image/png',
        fileName: 'relation.png',
        sizeBytes: relationBytes.length,
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'relation-upload-1' }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-relation-image-1', url: null }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-relation-image-1');

    expect(prisma.channelSuggestionImageAsset.findMany).toHaveBeenCalledWith({
      where: { auditLogId: 'suggestion-relation-image-1' },
      orderBy: { position: 'asc' },
      take: 11,
      select: {
        position: true,
        bytes: true,
        durablePayload: true,
        mimeType: true,
        fileName: true,
        sizeBytes: true,
      },
    });
    const uploadedBytes = maxClient.uploadImage.mock.calls[0]?.[0] as Buffer;
    expect(uploadedBytes.equals(relationBytes)).toBe(true);
    expect(uploadedBytes.equals(Buffer.from(legacyBase64, 'base64'))).toBe(false);
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'relation.png',
      'image/png',
      expect.objectContaining({ sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('Фото из relation'),
      expect.objectContaining({ imagePayload: { token: 'relation-upload-1' } }),
      expect.objectContaining({ trafficClass: 'background' }),
    );
    const deliveryPatch = readSqlJsonPatch(prisma.$queryRaw, 'deliveryAttemptedAt');
    expect(deliveryPatch.images).toBeUndefined();
    expect(extractSqlText(prisma.$queryRaw.mock.calls.at(-1)?.[0])).toContain(
      'audit.payload::jsonb',
    );
  });

  it('falls back to the complete legacy image set when relation rows are partial', async () => {
    const prisma = createPrismaMock();
    const relationBytes = Buffer.from('partial-relation-image');
    const legacyBytes = [Buffer.from('legacy-image-one'), Buffer.from('legacy-image-two')];
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-partial-relation-images-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Два фото из legacy',
        delivered: false,
        deliveredToUserIds: [],
        deliveries: [],
        reviewStatus: 'pending',
        hasImage: true,
        imageCount: 2,
        images: legacyBytes.map((bytes, index) => ({
          base64: bytes.toString('base64'),
          mimeType: 'image/jpeg',
          fileName: `legacy-${index + 1}.jpg`,
        })),
      },
      createdAt: new Date('2026-03-10T12:11:45.000Z'),
    });
    prisma.channelSuggestionImageAsset.findMany.mockResolvedValue([
      {
        position: 0,
        bytes: relationBytes,
        durablePayload: null,
        mimeType: 'image/png',
        fileName: 'partial-relation.png',
        sizeBytes: relationBytes.length,
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest
        .fn()
        .mockResolvedValueOnce({ token: 'legacy-upload-1' })
        .mockResolvedValueOnce({ token: 'legacy-upload-2' }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-partial-relation-1', url: null }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processChannelSuggestionDeliveryJob('suggestion-partial-relation-images-1');

    expect(maxClient.uploadImage).toHaveBeenCalledTimes(2);
    expect((maxClient.uploadImage.mock.calls[0]?.[0] as Buffer).equals(legacyBytes[0])).toBe(true);
    expect((maxClient.uploadImage.mock.calls[1]?.[0] as Buffer).equals(legacyBytes[1])).toBe(true);
    expect(
      maxClient.uploadImage.mock.calls.some(([bytes]) => (bytes as Buffer).equals(relationBytes)),
    ).toBe(false);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('Два фото из legacy'),
      expect.objectContaining({
        attachments: [
          { type: 'image', payload: { token: 'legacy-upload-1' } },
          { type: 'image', payload: { token: 'legacy-upload-2' } },
        ],
      }),
      expect.objectContaining({ trafficClass: 'background' }),
    );
  });

  it('fails closed when compact relation storage is marked but its rows are missing', async () => {
    const prisma = createPrismaMock();
    prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-missing-relation-image-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Фото из relation',
        delivered: false,
        deliveredToUserIds: [],
        deliveries: [],
        reviewStatus: 'pending',
        hasImage: true,
        imageCount: 1,
        imageStorageVersion: 1,
      },
      createdAt: new Date('2026-03-10T12:11:45.000Z'),
    });

    const maxClient = {
      uploadImage: jest.fn(),
      sendMessageImmediateWithId: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.processChannelSuggestionDeliveryJob('suggestion-missing-relation-image-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('rejects a suggestion when the per-user daily limit is reached', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: true,
      postSuggestionsDailyLimit: 2,
    });
    prisma.auditLog.count.mockResolvedValue(2);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-8', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'suggest',
        {
          token: suggestToken,
          text: 'Ещё одна идея',
        },
      ),
    ).rejects.toThrow('Лимит предложек для этого канала исчерпан: 2 за последние 24 часа.');

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('delivers bot-submitted suggestions with photo to admins as an image message', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-3',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:12:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-7', url: null }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-suggest-1' }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-3', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: '',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        imageMimeType: 'image/png',
        imageFileName: 'suggestion.png',
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'suggestion.png',
      'image/png',
      expect.objectContaining({
        botId: '777000_bot',
        sourceTag: 'suggestion_delivery',
        timeoutMs: 12_000,
        trafficClass: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('[Пользователь](https://max.ru/user1)'),
      expect.objectContaining({
        imagePayload: { token: 'upload-suggest-1' },
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({ text: '📰 В публикацию', type: 'callback' }),
            expect.objectContaining({ text: '✖️ Отклонить', type: 'callback' }),
          ],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: '777000_bot',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            source: 'private_bot',
            hasImage: true,
            imageCount: 1,
            imageFileNames: ['suggestion.png'],
            imageStorageVersion: 1,
          }),
        }),
      }),
    );
  });

  it('keeps recoverable suggestion photo upload errors retriable for the delivery worker', async () => {
    const prisma = createPrismaMock();
    const recoverableUploadError = {
      response: {
        status: 500,
        data: {
          code: 'internal.error',
          message: 'temporary upload failure',
        },
      },
    };
    const maxClient = {
      uploadImage: jest.fn().mockRejectedValue(recoverableUploadError),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).uploadChannelSuggestionImage({
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        imageMimeType: 'image/png',
        imageFileName: 'suggestion.png',
      }),
    ).rejects.toBe(recoverableUploadError);
  });

  it('delivers bot-submitted multi-photo suggestions to admins as image attachments', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-multi-photo-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:12:15.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-7b', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-suggestion-admin-3b', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: 'Подборка фото',
        images: [
          {
            payload: { token: 'uploaded-image-1' },
            mimeType: 'image/png',
            fileName: 'suggestion-1.png',
          },
          {
            payload: { token: 'uploaded-image-2' },
            mimeType: 'image/jpeg',
            fileName: 'suggestion-2.jpg',
          },
        ],
      },
      { mediaBotId: '777000_bot' },
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('[Пользователь](https://max.ru/user1)'),
      expect.objectContaining({
        attachments: [
          { type: 'image', payload: { token: 'uploaded-image-1' } },
          { type: 'image', payload: { token: 'uploaded-image-2' } },
        ],
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({ text: '📰 В публикацию', type: 'callback' }),
            expect.objectContaining({ text: '✖️ Отклонить', type: 'callback' }),
          ],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: '777000_bot',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            source: 'private_bot',
            hasImage: true,
            imageCount: 2,
            imageFileNames: ['suggestion-1.png', 'suggestion-2.jpg'],
            imageStorageVersion: 1,
          }),
        }),
      }),
    );
  });

  it('delivers bot-submitted video suggestions to admins with attachment retry', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        recipient_chat_id: '555001',
      },
    ]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-video-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-10T12:12:30.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-7', url: null }),
      sendMessageImmediateWithId: jest
        .fn()
        .mockRejectedValueOnce({
          response: {
            status: 400,
            data: {
              code: 'attachment.not.ready',
            },
          },
        })
        .mockResolvedValueOnce({ messageId: 'mid-suggestion-admin-video-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    const suggestToken = await publishSuggestDialogToken(service, maxClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: '',
        mediaType: 'video',
        mediaPayload: { token: 'uploaded-video-1' },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'suggestion.mp4',
      },
      { mediaBotId: '777000_bot' },
    );

    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenLastCalledWith(
      '555001',
      expect.stringContaining('[Пользователь](https://max.ru/user1)'),
      expect.objectContaining({
        attachments: [{ type: 'video', payload: { token: 'uploaded-video-1' } }],
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({ text: '📰 В публикацию', type: 'callback' }),
            expect.objectContaining({ text: '✖️ Отклонить', type: 'callback' }),
          ],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: '777000_bot',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            source: 'private_bot',
            hasVideo: true,
            mediaType: 'video',
            mediaMimeType: 'video/mp4',
            mediaFileName: 'suggestion.mp4',
            mediaPayload: { token: 'uploaded-video-1' },
          }),
        }),
      }),
    );
  });

  it('skips bot numeric admin id from chat members/me when MAX_BOT_CONTACT_ID is not configured', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '165176099' }]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-bot-filter-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-25T06:30:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-bot-filter-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Предложка',
        delivered: true,
        deliveredToUserId: '98315271',
        source: 'private_bot',
      },
      createdAt: new Date('2026-03-25T06:30:00.000Z'),
    });

    const tokenPublisherClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-bot-filter', url: null }),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['214634783', '98315271']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '214634783',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-suggestion-human-admin-1',
        url: null,
        chatId: '165176099',
      }),
      sendMessageImmediateToUser: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-max-bot-token';
        }
        throw new Error(`Missing key: ${key}`);
      }),
      get: jest.fn((key: string) => {
        if (key === 'APP_BASE_URL') {
          return 'https://major-maksimov.ru';
        }
        if (key === 'MAX_BOT_ID') {
          return 'id613002203036_bot';
        }
        if (key === 'MAX_BOT_CONTACT_ID') {
          return null;
        }
        return null;
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      config as never,
    );

    const tokenPublisher = createAdminServiceFixture(
      prisma as never,
      tokenPublisherClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(tokenPublisher, tokenPublisherClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: 'Предложка',
      },
    );

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '165176099',
      expect.stringContaining('[Пользователь](https://max.ru/user1)'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: 'id613002203036_bot',
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
    expect(readSqlJsonPatch(prisma.$queryRaw, 'deliveryAttemptedAt')).toEqual(
      expect.objectContaining({
        deliveredToUserId: '98315271',
        deliveredToUserIds: ['98315271'],
        deliveries: [
          expect.objectContaining({
            adminUserId: '98315271',
            privateChatId: '165176099',
            messageId: 'mid-suggestion-human-admin-1',
          }),
        ],
      }),
    );
  });

  it('filters every bot user id from multi-bot channel suggestion delivery even without explicit contact ids', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      primaryBotId: 'id613002203036_4_bot',
      botId: 'id613002203036_4_bot',
      botMemberships: [
        {
          botId: 'id613002203036_4_bot',
        },
        {
          botId: 'id613002203036_bot',
        },
      ],
    });
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '165176099' }]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['209468578', '214634783', '98315271']),
      getChatAdminMembers: jest.fn().mockResolvedValue([
        { userId: '209468578', isBot: true },
        { userId: '214634783', isBot: true },
        { userId: '98315271', isBot: false },
      ]),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => {
          if (options?.botId === 'id613002203036_4_bot') {
            return {
              userId: '214634783',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            };
          }

          if (options?.botId === 'id613002203036_bot') {
            return {
              userId: '209468578',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            };
          }

          return {
            userId: '214634783',
            isAdmin: true,
            isOwner: false,
            permissions: [],
          };
        }),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-suggestion-human-admin-1',
        url: null,
        chatId: '165176099',
      }),
      sendMessageImmediateToUser: jest.fn(),
    };
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-max-bot-token';
        }
        throw new Error(`Missing key: ${key}`);
      }),
      get: jest.fn((key: string) => {
        if (key === 'APP_BASE_URL') {
          return 'https://major-maksimov.ru';
        }
        if (key === 'MAX_BOT_ID') {
          return 'id613002203036_bot';
        }
        if (key === 'MAX_BOT_CONTACT_ID') {
          return null;
        }
        return null;
      }),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) =>
        typeof botId === 'string' && botId.trim().length > 0 ? { id: botId.trim() } : null,
      ),
      getDefaultBot: jest.fn().mockReturnValue({ id: 'id613002203036_bot' }),
      getEntryBot: jest.fn().mockReturnValue({ id: 'id613002203036_bot' }),
      getOperationalBots: jest
        .fn()
        .mockReturnValue([{ id: 'id613002203036_bot' }, { id: 'id613002203036_4_bot' }]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      config as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    const delivery = await (service as any).deliverSuggestionToAdminPrivates(
      'suggestion-multi-bot-filter-1',
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        avatarUrl: null,
      },
      {
        text: 'Предложка',
      },
    );

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
      }),
    );
    expect(maxClient.getChatAdminMembers).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      }),
    );
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        botId: 'id613002203036_bot',
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '165176099',
      expect.stringContaining('[Пользователь](https://max.ru/user1)'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        trafficClass: 'background',
        botId: 'id613002203036_bot',
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({
      delivered: true,
      deliveredToUserId: '98315271',
      deliveredToUserIds: ['98315271'],
      deliveries: [
        expect.objectContaining({
          adminUserId: '98315271',
          privateChatId: '165176099',
          messageId: 'mid-suggestion-human-admin-1',
        }),
      ],
    });
  });

  it('does not blind-send by user id when the known admin private chat is stale', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '555001' }]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-stale-private-chat-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-25T06:30:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-stale-private-chat-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Предложка',
        delivered: true,
        deliveredToUserId: '98315271',
        source: 'private_bot',
      },
      createdAt: new Date('2026-03-25T06:30:00.000Z'),
    });

    const tokenPublisherClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-stale-private-chat', url: null }),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['98315271']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '777000',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      sendMessageImmediateWithId: jest.fn(
        async (_chatId: string, _text: string, options?: { beforeSend?: () => Promise<void> }) => {
          await options?.beforeSend?.();
          throw {
            response: {
              status: 404,
              data: {
                message: 'chat not found',
              },
            },
          };
        },
      ),
      sendMessageImmediateToUser: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const tokenPublisher = createAdminServiceFixture(
      prisma as never,
      tokenPublisherClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(tokenPublisher, tokenPublisherClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: 'Предложка',
      },
    );

    const privateChatLookupSql = prisma.$queryRaw.mock.calls
      .map((call) => extractSqlText(call))
      .find((sqlText) => sqlText.includes('FROM webhook_events'));
    expect(privateChatLookupSql).toContain("normalized_payload->'message'->>'senderId'");
    expect(privateChatLookupSql).toContain("normalized_payload->'message'->>'chatId'");
    expect(privateChatLookupSql).toContain("normalized_payload->>'type'");
    expect(privateChatLookupSql).toContain('created_at >=');
    expect(privateChatLookupSql).toContain('bot_id =');
    expect(privateChatLookupSql).not.toContain('DISTINCT ON');
    expect(privateChatLookupSql).not.toContain('raw_payload');
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '555001',
      expect.stringContaining('[Пользователь](https://max.ru/user1)'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        trafficClass: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
    expect(readSqlJsonPatch(prisma.$queryRaw, 'deliveryAttemptedAt')).toEqual(
      expect.objectContaining({
        delivered: false,
        deliveries: [],
        deliveryFailures: [
          expect.objectContaining({
            adminUserId: '98315271',
            privateChatId: '555001',
            status: 404,
            code: 'suggestion.delivery.dialog_unavailable',
            terminal: true,
          }),
        ],
      }),
    );
  });

  it('records unavailable admin private suggestion delivery without warning or failure metrics', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-unavailable-private-chat-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Предложка',
        delivered: false,
        deliveredToUserId: null,
        source: 'private_bot',
      },
      createdAt: new Date('2026-03-25T06:33:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-unavailable-private-chat-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-25T06:33:00.000Z'),
    });

    const tokenPublisherClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-engagement-unavailable-private-chat',
        url: null,
      }),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['98315271']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '777000',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      sendMessageImmediateWithId: jest.fn(),
      sendMessageImmediateToUser: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);

    const tokenPublisher = createAdminServiceFixture(
      prisma as never,
      tokenPublisherClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(tokenPublisher, tokenPublisherClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: 'Предложка',
      },
    );

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestionId: 'suggestion-unavailable-private-chat-1',
        chatId: 'channel-1',
        adminUserId: '98315271',
        privateChatId: null,
        status: 404,
        code: 'suggestion.delivery.no_reachable_dialog',
      }),
      'Skipped suggestion delivery to unavailable admin private chat',
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      'Failed to deliver suggestion to admin private chat',
    );
    expect(readSqlJsonPatch(prisma.$queryRaw, 'deliveryAttemptedAt')).toEqual(
      expect.objectContaining({
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        deliveries: [],
        deliveryAttemptedAt: expect.any(String),
        deliveryFailures: [
          expect.objectContaining({
            adminUserId: '98315271',
            privateChatId: null,
            status: 404,
            code: 'suggestion.delivery.no_reachable_dialog',
            terminal: true,
            message: 'admin has not started an actionable suggestion delivery bot',
          }),
        ],
      }),
    );
  });

  it('routes admin private suggestion delivery through the resolved delivery bot when assist bot differs', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSuggestionsEnabled: false,
    });
    prisma.$queryRaw.mockResolvedValue([{ recipient_chat_id: '777001' }]);
    prisma.auditLog.create.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: 'suggestion-entry-bot-delivery-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-25T06:35:00.000Z'),
    });
    prisma.auditLog.update.mockResolvedValue({
      id: 'suggestion-entry-bot-delivery-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        text: 'Предложка',
        delivered: true,
        deliveredToUserId: '98315271',
        source: 'private_bot',
      },
      createdAt: new Date('2026-03-25T06:35:00.000Z'),
    });

    const tokenPublisherClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-entry-bot', url: null }),
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['98315271']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '888000',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'entry-bot-upload-1' }),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-suggestion-entry-bot-1',
        url: null,
        chatId: '777001',
      }),
      sendMessageImmediateToUser: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const maxBotLinkService = {
      ...createAdminMaxBotLinkMock(),
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      getEntryBotId: jest.fn().mockReturnValue('777000_bot'),
      getContextOrDefaultBotId: jest.fn().mockReturnValue('888000_bot'),
      isKnownBotUserId: jest.fn().mockReturnValue(false),
      resolveContactIdSync: jest.fn().mockReturnValue(null),
      resolveBotIdForCapability: jest.fn().mockResolvedValue('888000_bot'),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    const tokenPublisher = createAdminServiceFixture(
      prisma as never,
      tokenPublisherClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const suggestToken = await publishSuggestDialogToken(tokenPublisher, tokenPublisherClient);

    await service.createChannelSuggestionFromBot(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      {
        token: suggestToken,
        text: 'Предложка',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        imageMimeType: 'image/png',
        imageFileName: 'entry-bot-suggestion.png',
      },
    );

    expect(maxBotLinkService.resolveBotIdForCapability).toHaveBeenCalledWith({
      chatId: 'channel-1',
      capability: 'suggestion_delivery',
    });
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'entry-bot-suggestion.png',
      'image/png',
      expect.objectContaining({
        botId: '888000_bot',
        sourceTag: 'suggestion_delivery',
        timeoutMs: 12_000,
        trafficClass: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '777001',
      expect.stringContaining('[Пользователь](https://max.ru/user1)'),
      expect.objectContaining({
        imagePayload: { token: 'entry-bot-upload-1' },
        textFormat: 'markdown',
      }),
      expect.objectContaining({
        botId: '888000_bot',
        trafficClass: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
  });

  it('publishes a reviewed suggestion and removes admin review buttons', async () => {
    const sourceThreadId = '11111111-1111-4111-8111-111111111111';
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonText: '📰 Предложить пост',
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Готовый пост для канала',
        threadId: sourceThreadId,
        reviewStatus: 'pending',
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-1',
            botId: 'private-bot-2',
          },
        ],
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-post-1',
        url: 'https://max.ru/chats/channel-1/message/100',
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const maxBotLinkService = {
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string) =>
            `https://max.ru/entry-bot?startapp=${encodeURIComponent(startParam)}`,
        ),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startParam: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || '777000_bot')}?startapp=${encodeURIComponent(startParam)}`,
        ),
      buildBotStartUrlSync: jest
        .fn()
        .mockImplementation(
          (startPayload: string, botId?: string | null) =>
            `https://max.ru/${encodeURIComponent(botId?.trim() || '777000_bot')}?start=${encodeURIComponent(startPayload)}`,
        ),
      resolveContactIdSync: jest.fn((botId?: string | null) =>
        botId === 'channel-bot-2' ? '990002' : null,
      ),
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotId: jest.fn().mockResolvedValue(undefined),
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'channel-bot-2',
        botId: 'channel-bot-2',
        candidateBotIds: ['channel-bot-2'],
        reason: 'primary_confirmed',
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    attachSuggestionPublicationRoute(service, maxClient);

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-1',
      {
        userId: 'admin-1',
        username: 'chief',
        displayName: 'Главный редактор',
        chatTitle: null,
      },
      'publish',
    );

    expect(result).toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/100',
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'От подписчика [Пользователь](max://user/user-1)\n\nГотовый пост для канала',
      expect.objectContaining({
        textFormat: 'markdown',
        buttons: [
          [
            expect.objectContaining({
              text: '💬 Комментарии · 0',
              type: 'link',
              url: expect.stringContaining('https://max.ru/entry-bot?startapp='),
            }),
          ],
          [
            expect.objectContaining({
              text: '📰 Предложить пост',
              type: 'link',
              url: expect.stringContaining('start='),
            }),
          ],
        ],
      }),
      expect.objectContaining({
        botId: 'channel-bot-2',
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        timeoutMs: 10_000,
      }),
    );
    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.resolveContactIdSync).toHaveBeenCalledWith('channel-bot-2');
    expect(maxBotLinkService.getBotTokenSync).toHaveBeenCalledWith('channel-bot-2');
    expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
      'channel-bot-2',
    );
    const [, , publishedOptions] =
      maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
    const commentsButton = publishedOptions?.buttons?.[0]?.[0] as
      | { url?: string; webApp?: string }
      | undefined;
    const suggestButton = publishedOptions?.buttons?.[1]?.[0] as { url?: string } | undefined;
    expect(commentsButton?.url).toContain('https://max.ru/entry-bot?startapp=');
    expect(suggestButton?.url).toContain('https://max.ru/channel-bot-2?start=');
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    const suggestStartParam = suggestButton?.url
      ? new URL(suggestButton.url).searchParams.get('start')
      : null;
    const commentsToken = decodeBase64UrlJson<{ d: string }>(
      readDialogButtonToken(commentsButton).slice(4),
    );
    const parsedSuggestion = service.parseChannelSuggestionStartPayload(suggestStartParam);
    const suggestToken = decodeBase64UrlJson<{ d: string }>(parsedSuggestion!.token.slice(4));
    const autoAttachPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      messageId?: unknown;
      threadId?: unknown;
      includeCommentsButton?: unknown;
      includeSuggestButton?: unknown;
      source?: unknown;
      suggestButtonText?: unknown;
    };
    const publishedThreadId =
      typeof autoAttachPayload.threadId === 'string' ? autoAttachPayload.threadId : '';

    expect(publishedThreadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(publishedThreadId).not.toBe(sourceThreadId);
    expect(commentsToken.d).toBe(publishedThreadId);
    expect(suggestToken.d).toBe(publishedThreadId);
    expect(prisma.$executeRaw).toHaveBeenCalledWith(expect.any(Object));
    const claimSql = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(claimSql).toContain('UPDATE audit_logs');
    expect(claimSql).toContain("payload->>'reviewStatus'");
    expect(claimSql).toContain("'reviewClaimedAt',");
    expect(claimSql).toContain("'reviewClaimedByUserId',");
    expect(claimSql).toContain("'reviewClaimToken',");
    expect(claimSql).toContain("'reviewAction',");
    expect(claimSql).toContain("'reviewPublicationProtocol',");
    expect(claimSql).toContain('channel-suggestion:publish:v1:suggestion-review-1');
    expect(claimSql.match(/::text/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    const finalizeSql = extractSqlText(prisma.$executeRaw.mock.calls[2]?.[0]);
    expect(finalizeSql).toContain("'reviewStatus', 'published'");
    expect(finalizeSql).toContain("payload->>'reviewClaimToken'");
    expect(finalizeSql).toContain("payload->'reviewPublicationContext'->>'messageDigest'");
    expect(finalizeSql).toContain('mid-channel-post-1');
    expect(finalizeSql).toContain('https://max.ru/chats/channel-1/message/100');
    expect(prisma.auditLog.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'channel-1',
          actorUserId: 'admin-1',
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
          payload: expect.objectContaining({
            messageId: 'mid-channel-post-1',
            threadId: publishedThreadId,
            includeCommentsButton: true,
            includeSuggestButton: true,
            source: 'suggestion_review',
            botId: 'channel-bot-2',
            suggestButtonText: '📰 Предложить пост',
          }),
        }),
      }),
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '555001',
      'mid-admin-review-1',
      expect.stringContaining('**Контент публикации**'),
      {
        buttons: [
          [
            {
              text: 'Открыть пост',
              type: 'link',
              url: 'https://max.ru/chats/channel-1/message/100',
            },
          ],
        ],
        textFormat: 'markdown',
      },
      { botId: 'private-bot-2' },
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[2]).toContain(
      'Пост: [Открыть пост](https://max.ru/chats/channel-1/message/100)',
    );
  });

  it('keeps a versioned claim when the authoritative send route is empty', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-no-route-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Пост без исполняемого маршрута',
        reviewStatus: 'pending',
      },
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const maxBotLinkService = createAdminMaxBotLinkMock({
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'channel-bot-2',
        botId: null,
        candidateBotIds: [],
        reason: null,
      }),
      resolveBotIdForSend: jest.fn().mockResolvedValue('legacy-default-bot'),
    });
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    attachSuggestionPublicationRoute(service, maxClient);
    const loadStoredImages = jest.spyOn(
      (service as any).channelSuggestionImageRuntime,
      'loadStoredImages',
    );
    const resolveAttachments = jest.spyOn(service as any, 'resolveChannelSuggestionAttachments');

    await expect(
      service.reviewChannelSuggestionByAdmin(
        'suggestion-review-no-route-1',
        {
          userId: 'admin-1',
          username: 'chief',
          displayName: 'Главный редактор',
          chatTitle: null,
        },
        'publish',
      ),
    ).rejects.toThrow(
      'Не найден бот MAX с подтвержденным правом публиковать сообщения в этом канале.',
    );

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(loadStoredImages).not.toHaveBeenCalled();
    expect(resolveAttachments).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0])).toContain(
      "'reviewPublicationLedgerJobId',",
    );
    expect(prisma.auditLog.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the legacy suggestion delivery fallback when no route resolver is available', async () => {
    const prisma = createPrismaMock();
    const resolveBotIdForSend = jest.fn().mockResolvedValue('legacy-channel-bot');
    const maxBotLinkService = createAdminMaxBotLinkMock({
      resolveBotRoute: undefined,
      resolveBotIdForSend,
    });
    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      (service as any).resolveChannelSuggestionPublicationBotAssignment('channel-1'),
    ).resolves.toEqual({
      botId: 'legacy-channel-bot',
      routeResolved: false,
      candidateBotIds: [],
    });
    expect(resolveBotIdForSend).toHaveBeenCalledWith({ chatId: 'channel-1' });
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  describe('reviewed suggestion media token routing', () => {
    const reviewer = {
      userId: 'admin-1',
      username: 'chief',
      displayName: 'Главный редактор',
      chatTitle: null,
    };

    async function seedDeliveryRows(
      prisma: ReturnType<typeof createPrismaMock>,
      rows: Array<{
        adminUserId: string;
        botId: string | null;
        status: 'SENT' | 'FAILED' | 'AMBIGUOUS';
      }>,
      suggestionId = 'suggestion-media-route-1',
    ): Promise<void> {
      await prisma.channelSuggestionAdminDelivery.createMany({
        data: rows.map((row, index) => ({
          auditLogId: suggestionId,
          adminUserId: row.adminUserId,
          botKey: row.botId ?? `default-${index}`,
          botId: row.botId,
          status: row.status,
        })),
        skipDuplicates: true,
      });
    }

    it('deduplicates repeated SENT bot evidence and selects that current route candidate', async () => {
      const loadSentDeliveryBotIds = jest.fn().mockResolvedValue(['media-bot', 'media-bot']);

      await expect(
        resolveChannelSuggestionMediaPublicationBotId({
          payload: { mediaPayload: { token: 'video-token-1' } },
          images: [],
          assignment: {
            botId: 'primary-bot',
            routeResolved: true,
            candidateBotIds: ['primary-bot', 'media-bot'],
          },
          loadSentDeliveryBotIds,
        }),
      ).resolves.toBe('media-bot');
      expect(loadSentDeliveryBotIds).toHaveBeenCalledTimes(1);
    });

    it('uses token evidence from relation-backed images', async () => {
      await expect(
        resolveChannelSuggestionMediaPublicationBotId({
          payload: {},
          images: [{ payload: { token: 'relation-image-token-1' } }],
          assignment: {
            botId: 'primary-bot',
            routeResolved: true,
            candidateBotIds: ['primary-bot', 'relation-media-bot'],
          },
          loadSentDeliveryBotIds: async () => ['relation-media-bot'],
        }),
      ).resolves.toBe('relation-media-bot');
    });

    it.each([
      {
        name: 'only null delivery evidence',
        deliveryBotIds: [null],
        candidates: ['primary-bot'],
      },
      {
        name: 'multiple distinct SENT bots',
        deliveryBotIds: ['media-bot-1', 'media-bot-2'],
        candidates: ['primary-bot', 'media-bot-1', 'media-bot-2'],
      },
      {
        name: 'a SENT bot excluded from the executable route',
        deliveryBotIds: ['quarantined-bot'],
        candidates: ['primary-bot'],
      },
    ])('fails closed for $name', async ({ deliveryBotIds, candidates }) => {
      await expect(
        resolveChannelSuggestionMediaPublicationBotId({
          payload: { mediaPayload: { token: 'video-token-1' } },
          images: [],
          assignment: {
            botId: 'primary-bot',
            routeResolved: true,
            candidateBotIds: candidates,
          },
          loadSentDeliveryBotIds: async () => deliveryBotIds,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails token media closed without a modern route resolver', async () => {
      const loadSentDeliveryBotIds = jest.fn();

      await expect(
        resolveChannelSuggestionMediaPublicationBotId({
          payload: { mediaPayload: { token: 'video-token-1' } },
          images: [],
          assignment: {
            botId: 'legacy-bot',
            routeResolved: false,
            candidateBotIds: [],
          },
          loadSentDeliveryBotIds,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(loadSentDeliveryBotIds).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'text-only content',
        payload: { text: 'Обычная предложка' },
        images: [],
      },
      {
        name: 'base64 image content',
        payload: { text: 'Фото' },
        images: [{ base64: 'aW1hZ2U=', mimeType: 'image/jpeg', fileName: 'photo.jpg' }],
      },
    ])('keeps the ordinary route for $name', async ({ payload, images }) => {
      const loadSentDeliveryBotIds = jest.fn();

      await expect(
        resolveChannelSuggestionMediaPublicationBotId({
          payload,
          images,
          assignment: {
            botId: 'legacy-or-primary-bot',
            routeResolved: false,
            candidateBotIds: [],
          },
          loadSentDeliveryBotIds,
        }),
      ).resolves.toBe('legacy-or-primary-bot');
      expect(loadSentDeliveryBotIds).not.toHaveBeenCalled();
    });

    async function createTokenReviewHarness(
      candidateBotIds: string[],
      deliveryBotId: string,
      routeBotId: string | null = candidateBotIds[0] ?? null,
    ) {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'channel-1',
        title: 'Новости MAX',
        entityType: 'CHANNEL',
      });
      prisma.channelSettings.findUnique.mockResolvedValue(
        channelSettingsSchema.parse({
          commentsEnabled: true,
          postSuggestionsEnabled: true,
        }),
      );
      prisma.auditLog.findFirst.mockResolvedValue({
        id: 'suggestion-media-route-1',
        chatId: 'channel-1',
        actorUserId: 'user-1',
        payload: {
          type: 'suggest',
          actorUserId: 'user-1',
          authorDisplayName: 'Пользователь',
          text: 'Видео для канала',
          mediaType: 'video',
          mediaPayload: { token: 'video-token-1' },
          mediaMimeType: 'video/mp4',
          reviewStatus: 'pending',
        },
      });
      await seedDeliveryRows(prisma, [
        { adminUserId: 'admin-1', botId: deliveryBotId, status: 'SENT' },
      ]);
      const getChatMemberProfiles = jest.fn().mockResolvedValue(new Map());
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatMemberProfiles,
        getChatSnapshot: jest.fn().mockResolvedValue({
          chatId: 'channel-1',
          title: 'Новости MAX',
          participantsCount: 1200,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/channels/news-max',
          lastEventAt: '2026-03-10T12:00:00.000Z',
          entityType: 'channel',
        }),
        sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
          messageId: 'mid-media-route-post-1',
          url: 'https://max.ru/chats/channel-1/message/media-route-1',
        }),
        editMessageInlineKeyboard: jest.fn(),
      };
      const resolveBotRoute = jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: routeBotId,
        botId: routeBotId,
        candidateBotIds,
        reason: candidateBotIds.length > 0 ? 'primary_confirmed' : null,
      });
      const maxBotLinkService = createAdminMaxBotLinkMock({
        resolveBotRoute,
      });
      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );
      attachSuggestionPublicationRoute(service, maxClient);

      return {
        getChatMemberProfiles,
        maxBotLinkService,
        maxClient,
        prisma,
        resolveBotRoute,
        service,
      };
    }

    it('uses the proven media bot for attribution, buttons, publication, and audit', async () => {
      const {
        getChatMemberProfiles,
        maxBotLinkService,
        maxClient,
        prisma,
        resolveBotRoute,
        service,
      } = await createTokenReviewHarness(['primary-bot', 'media-bot'], 'media-bot');

      await expect(
        service.reviewChannelSuggestionByAdmin('suggestion-media-route-1', reviewer, 'publish'),
      ).resolves.toMatchObject({
        status: 'reviewed',
        reviewStatus: 'published',
      });

      expect(
        resolveBotRoute.mock.calls.filter(([request]) => request.purpose === 'send_message'),
      ).toHaveLength(1);
      expect(prisma.channelSuggestionAdminDelivery.findMany).toHaveBeenCalledWith({
        where: {
          auditLogId: 'suggestion-media-route-1',
          status: 'SENT',
        },
        select: { botId: true },
      });
      expect(getChatMemberProfiles).toHaveBeenCalledWith(
        'channel-1',
        ['user-1'],
        expect.objectContaining({ botId: 'media-bot' }),
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        expect.stringContaining('Видео для канала'),
        expect.objectContaining({
          attachments: [{ type: 'video', payload: { token: 'video-token-1' } }],
        }),
        expect.objectContaining({ botId: 'media-bot' }),
      );
      expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
        expect.any(String),
        'media-bot',
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
            payload: expect.objectContaining({ botId: 'media-bot' }),
          }),
        }),
      );
    });

    it('keeps the versioned claim when the proven media bot is not routable', async () => {
      const { maxClient, prisma, resolveBotRoute, service } = await createTokenReviewHarness(
        ['primary-bot'],
        'media-bot',
      );
      const loadStoredImages = jest.spyOn(
        (service as any).channelSuggestionImageRuntime,
        'loadStoredImages',
      );
      const resolveAttachments = jest.spyOn(service as any, 'resolveChannelSuggestionAttachments');

      await expect(
        service.reviewChannelSuggestionByAdmin('suggestion-media-route-1', reviewer, 'publish'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(
        resolveBotRoute.mock.calls.filter(([request]) => request.purpose === 'send_message'),
      ).toHaveLength(1);
      expect(loadStoredImages).toHaveBeenCalledTimes(1);
      expect(resolveAttachments).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.updateMany).not.toHaveBeenCalled();
    });

    it('does not restore a route bot that the executable candidate fence excludes', async () => {
      const { maxClient, prisma, service } = await createTokenReviewHarness(
        ['primary-bot'],
        'quarantined-media-bot',
        'quarantined-media-bot',
      );

      await expect(
        service.reviewChannelSuggestionByAdmin('suggestion-media-route-1', reviewer, 'publish'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('reviewed suggestion author attribution', () => {
    type RemoteAuthorProfile = {
      displayName: string | null;
      username: string | null;
      profileUrl: string | null;
    };

    function createAuthorReviewHarness(options: {
      actorUserId?: string;
      payload?: Record<string, unknown>;
      remoteProfile?: RemoteAuthorProfile | null;
      remoteError?: Error;
      localDisplayName?: string | null;
    }) {
      const actorUserId = options.actorUserId ?? '214634783';
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'channel-1',
        title: 'Новости MAX',
        entityType: 'CHANNEL',
      });
      prisma.channelSettings.findUnique.mockResolvedValue(
        channelSettingsSchema.parse({
          commentsEnabled: false,
          postSuggestionsEnabled: false,
        }),
      );
      prisma.auditLog.findFirst.mockResolvedValue({
        id: 'suggestion-author-review-1',
        chatId: 'channel-1',
        actorUserId,
        payload: {
          type: 'suggest',
          actorUserId,
          authorDisplayName: 'Старое имя',
          text: 'Текст предложки',
          reviewStatus: 'pending',
          ...options.payload,
        },
      });
      prisma.$queryRaw.mockResolvedValue(
        options.localDisplayName
          ? [{ user_id: actorUserId, sender_name: options.localDisplayName }]
          : [],
      );

      const remoteProfiles = options.remoteProfile
        ? new Map([
            [
              actorUserId,
              {
                userId: actorUserId,
                avatarUrl: null,
                ...options.remoteProfile,
              },
            ],
          ])
        : new Map();
      const getChatMemberProfiles = options.remoteError
        ? jest.fn().mockRejectedValue(options.remoteError)
        : jest.fn().mockResolvedValue(remoteProfiles);
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatMemberProfiles,
        getChatSnapshot: jest.fn().mockResolvedValue({
          chatId: 'channel-1',
          title: 'Новости MAX',
          participantsCount: 1200,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/channels/news-max',
          lastEventAt: '2026-03-10T12:00:00.000Z',
          entityType: 'channel',
        }),
        sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
          messageId: 'mid-channel-author-post-1',
          url: 'https://max.ru/chats/channel-1/message/author-1',
        }),
        editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      attachSuggestionPublicationRoute(service, maxClient);
      jest
        .spyOn(service as any, 'resolveChannelSuggestionPublicationBotAssignment')
        .mockResolvedValue({
          botId: 'channel-bot-author',
          routeResolved: true,
          candidateBotIds: ['channel-bot-author'],
        });
      jest
        .spyOn(service as any, 'resolveDeliveryBotAssignment')
        .mockResolvedValue('channel-bot-author');

      return { actorUserId, getChatMemberProfiles, maxClient, prisma, service };
    }

    const reviewer = {
      userId: 'admin-1',
      username: 'chief',
      displayName: 'Главный редактор',
      chatTitle: null,
    };

    it('uses the canonical audit actor and a fresh full MAX name on the same bot route', async () => {
      const actorUserId = '214634783';
      const { getChatMemberProfiles, maxClient, prisma, service } = createAuthorReviewHarness({
        actorUserId,
        payload: {
          actorUserId: 'payload-spoofed-user',
          authorDisplayName: 'Анна',
          authorUsername: 'stale-anna',
          deliveries: [
            {
              adminUserId: 'admin-1',
              privateChatId: '555001',
              messageId: 'mid-admin-author-review-1',
              botId: 'private-bot-2',
            },
          ],
        },
        remoteProfile: {
          displayName: 'Анна Каренина',
          username: null,
          profileUrl: null,
        },
      });

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'publish',
      );

      expect(getChatMemberProfiles).toHaveBeenCalledWith(
        'channel-1',
        [actorUserId],
        expect.objectContaining({
          botId: 'channel-bot-author',
          trafficClass: 'interactive',
          actionHealthLane: 'interactive',
          sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        }),
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        `От подписчика [Анна Каренина](max://user/${actorUserId})\n\nТекст предложки`,
        expect.objectContaining({ textFormat: 'markdown' }),
        expect.objectContaining({ botId: 'channel-bot-author' }),
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[1]).not.toContain(
        'https://max.ru/stale-anna',
      );
      const finalizeSql = extractSqlText(prisma.$executeRaw.mock.calls.at(-1)?.[0]);
      expect(finalizeSql).toContain(actorUserId);
      expect(finalizeSql).toContain('Анна Каренина');
      expect(finalizeSql).toContain("'authorMentionDisplayName'");
      expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[2]).toContain(
        `[Анна Каренина](max://user/${actorUserId})`,
      );
    });

    it('drops conflicting payload profile fallbacks when the canonical lookup fails', async () => {
      const actorUserId = '214634787';
      const { maxClient, prisma, service } = createAuthorReviewHarness({
        actorUserId,
        payload: {
          actorUserId: 'payload-spoofed-user',
          authorDisplayName: 'Чужое имя',
          authorMentionDisplayName: 'Чужое имя',
          authorUsername: 'payload-spoofed-user',
          authorProfileUrl: 'https://max.ru/payload-spoofed-user',
          authorAvatarUrl: 'https://example.com/spoofed.jpg',
        },
        remoteError: new Error('MAX profile lookup unavailable'),
        localDisplayName: 'Канонический автор',
      });

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'publish',
      );

      const publishedText = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[1];
      expect(publishedText).toBe(
        `От подписчика [Канонический автор](max://user/${actorUserId})\n\nТекст предложки`,
      );
      expect(publishedText).not.toContain('payload-spoofed-user');
      const finalizeSql = extractSqlText(prisma.$executeRaw.mock.calls.at(-1)?.[0]);
      expect(finalizeSql).toContain(actorUserId);
      expect(finalizeSql).toContain('Канонический автор');
      expect(finalizeSql).toContain("'authorAvatarUrl', null");
    });

    it('refreshes author attribution when a suggestion is rejected', async () => {
      const { actorUserId, getChatMemberProfiles, maxClient, prisma, service } =
        createAuthorReviewHarness({
          payload: {
            authorDisplayName: 'Старое имя',
            deliveries: [
              {
                adminUserId: 'admin-1',
                privateChatId: '555001',
                messageId: 'mid-admin-author-review-cancel-1',
                botId: 'private-bot-2',
              },
            ],
          },
          remoteProfile: {
            displayName: 'Новое Полное Имя',
            username: 'current-author',
            profileUrl: null,
          },
        });

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'cancel',
      );

      expect(getChatMemberProfiles).toHaveBeenCalledWith(
        'channel-1',
        [actorUserId],
        expect.objectContaining({
          botId: 'channel-bot-author',
          trafficClass: 'interactive',
        }),
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[2]).toContain(
        '[Новое Полное Имя](https://max.ru/current-author)',
      );
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const cancellationSql = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
      expect(cancellationSql).toContain("'reviewStatus', 'cancelled'");
      expect(cancellationSql).toContain('Новое Полное Имя');
      expect(cancellationSql).toContain('https://max.ru/current-author');
      expect(cancellationSql).not.toContain("'reviewClaimToken',");
    });

    it('uses relation media before legacy payload without copying it into audit JSON', async () => {
      const { maxClient, prisma, service } = createAuthorReviewHarness({
        payload: {
          text: 'Фото с места события',
          imageCount: 2,
          images: [
            { payload: { token: 'legacy-author-photo-1' }, mimeType: 'image/jpeg' },
            { payload: { token: 'legacy-author-photo-2' }, mimeType: 'image/jpeg' },
          ],
        },
        remoteProfile: {
          displayName: 'Анна [QA]',
          username: 'anna',
          profileUrl: 'https://max.ru/anna-profile',
        },
      });
      await prisma.channelSuggestionAdminDelivery.createMany({
        data: [
          {
            auditLogId: 'suggestion-author-review-1',
            adminUserId: 'admin-1',
            botKey: 'channel-bot-author',
            botId: 'channel-bot-author',
            status: 'SENT',
          },
        ],
        skipDuplicates: true,
      });
      prisma.channelSuggestionImageAsset.findMany.mockResolvedValue([
        {
          position: 0,
          bytes: null,
          durablePayload: { token: 'relation-author-photo-1' },
          mimeType: 'image/jpeg',
          fileName: 'relation-1.jpg',
          sizeBytes: null,
        },
        {
          position: 1,
          bytes: null,
          durablePayload: { token: 'relation-author-photo-2' },
          mimeType: 'image/jpeg',
          fileName: 'relation-2.jpg',
          sizeBytes: null,
        },
      ]);

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'publish',
      );

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        'От подписчика [Анна \\[QA\\]](https://max.ru/anna-profile)\n\nФото с места события',
        expect.objectContaining({
          textFormat: 'markdown',
          attachments: [
            { type: 'image', payload: { token: 'relation-author-photo-1' } },
            { type: 'image', payload: { token: 'relation-author-photo-2' } },
          ],
        }),
        expect.objectContaining({ botId: 'channel-bot-author' }),
      );
      const finalizeSql = extractSqlText(prisma.$executeRaw.mock.calls.at(-1)?.[0]);
      expect(finalizeSql).toContain('SET payload =');
      expect(finalizeSql).not.toContain("'images',");
    });

    it('uses and escapes a direct MAX profile URL in HTML publications', async () => {
      const { maxClient, service } = createAuthorReviewHarness({
        payload: {
          text: '**Важный пост**',
          textFormat: 'markdown',
        },
        remoteProfile: {
          displayName: 'Анна & <Редактор>',
          username: 'anna',
          profileUrl: 'https://max.ru/anna-profile',
        },
      });

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'publish',
      );

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        'От подписчика <a href="https://max.ru/anna-profile">Анна &amp; &lt;Редактор&gt;</a>\n\n<strong>Важный пост</strong>',
        expect.objectContaining({ textFormat: 'html' }),
        expect.objectContaining({ botId: 'channel-bot-author' }),
      );
    });

    it('uses a fresh full MAX name for max:// links in HTML publications', async () => {
      const actorUserId = '214634786';
      const { maxClient, service } = createAuthorReviewHarness({
        actorUserId,
        payload: {
          text: '**Важный пост**',
          textFormat: 'markdown',
        },
        remoteProfile: {
          displayName: 'Анна & <Редактор>',
          username: null,
          profileUrl: null,
        },
      });

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'publish',
      );

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        `От подписчика <a href="max://user/${actorUserId}">Анна &amp; &lt;Редактор&gt;</a>\n\n<strong>Важный пост</strong>`,
        expect.objectContaining({ textFormat: 'html' }),
        expect.objectContaining({ botId: 'channel-bot-author' }),
      );
    });

    it.each([
      {
        source: 'local profile history',
        localDisplayName: 'Локальное полное имя',
        storedDisplayName: 'Старое имя',
        expectedDisplayName: 'Локальное полное имя',
      },
      {
        source: 'signed stored profile',
        localDisplayName: null,
        storedDisplayName: 'Сохраненное полное имя',
        expectedDisplayName: 'Сохраненное полное имя',
      },
    ])('falls back to $source when the remote profile lookup fails', async (testCase) => {
      const actorUserId = '214634784';
      const { getChatMemberProfiles, maxClient, service } = createAuthorReviewHarness({
        actorUserId,
        payload: {
          authorDisplayName: testCase.storedDisplayName,
        },
        remoteError: new Error('MAX profile lookup unavailable'),
        localDisplayName: testCase.localDisplayName,
      });

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'publish',
      );

      expect(getChatMemberProfiles).toHaveBeenCalledTimes(1);
      const publishedText = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[1];
      expect(publishedText).toBe(
        `От подписчика [${testCase.expectedDisplayName}](max://user/${actorUserId})\n\nТекст предложки`,
      );
    });

    it.each([
      {
        source: 'username only',
        payload: { authorDisplayName: null, authorUsername: 'reader-only' },
        expectedAttribution: '[@reader-only](https://max.ru/reader-only)',
        expectLink: true,
      },
      {
        source: 'user id only',
        payload: { authorDisplayName: null, authorUsername: null },
        expectedAttribution: '214634785',
        expectLink: false,
      },
    ])('does not create a false max:// mention from $source', async (testCase) => {
      const actorUserId = '214634785';
      const { maxClient, service } = createAuthorReviewHarness({
        actorUserId,
        payload: testCase.payload,
      });

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'publish',
      );

      const publishedText = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[1];
      expect(publishedText).toBe(
        `От подписчика ${testCase.expectedAttribution}\n\nТекст предложки`,
      );
      expect(publishedText).not.toContain('max://user/');
      if (!testCase.expectLink) {
        expect(publishedText).not.toContain('](');
      }
    });

    it('escapes a legacy MAX profile URL before embedding it in Markdown', async () => {
      const actorUserId = '214634788';
      const { maxClient, service } = createAuthorReviewHarness({
        actorUserId,
        payload: {
          authorDisplayName: null,
          authorUsername: null,
          authorProfileUrl: 'https://max.ru/foo)%20[x](https://evil.example',
        },
      });

      await service.reviewChannelSuggestionByAdmin(
        'suggestion-author-review-1',
        reviewer,
        'publish',
      );

      const publishedText = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[1];
      expect(publishedText).toBe(
        `От подписчика [${actorUserId}](https://max.ru/foo%29%20%5Bx%5D%28https://evil.example)\n\nТекст предложки`,
      );
      expect(publishedText).not.toContain('](https://evil.example');
    });
  });

  it('does not publish a channel suggestion when another admin already claimed review', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.auditLog.findFirst
      .mockResolvedValueOnce({
        id: 'suggestion-review-race-1',
        chatId: 'channel-1',
        actorUserId: 'user-1',
        payload: {
          type: 'suggest',
          actorUserId: 'user-1',
          authorDisplayName: 'Пользователь',
          text: 'Пост уже забирает другой админ',
          threadId: 'race-thread-1',
          reviewStatus: 'pending',
        },
      })
      .mockResolvedValueOnce({
        payload: {
          type: 'suggest',
          reviewStatus: 'publishing',
          reviewClaimedByUserId: 'admin-2',
        },
      });
    prisma.$executeRaw.mockResolvedValueOnce(0);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      sendMessageImmediateWithResolvedLink: jest.fn(),
      editMessageInlineKeyboard: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    attachSuggestionPublicationRoute(service, maxClient);

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-race-1',
      {
        userId: 'admin-1',
        username: 'chief',
        displayName: 'Главный редактор',
        chatTitle: null,
      },
      'publish',
    );

    expect(result).toEqual({
      status: 'review_in_progress',
      reviewStatus: 'processing',
      publishedUrl: null,
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.auditLog.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'times out',
      Object.assign(new Error('timeout of 12000ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    ],
    ['resets the connection', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['breaks the pipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
    [
      'returns HTTP 503',
      Object.assign(new Error('Service unavailable'), { response: { status: 503 } }),
    ],
    ['returns no message id', new Error('Ambiguous MAX send response is missing message id')],
  ])(
    'keeps the review claim when channel suggestion publish %s ambiguously',
    async (_, sendError) => {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'channel-1',
        title: 'Новости MAX',
        entityType: 'CHANNEL',
      });
      prisma.channelSettings.findUnique.mockResolvedValue(
        channelSettingsSchema.parse({
          commentsEnabled: false,
          postSuggestionsEnabled: false,
        }),
      );
      prisma.auditLog.findFirst.mockResolvedValue({
        id: 'suggestion-review-timeout-1',
        chatId: 'channel-1',
        actorUserId: 'user-1',
        payload: {
          type: 'suggest',
          actorUserId: 'user-1',
          authorDisplayName: 'Пользователь',
          text: 'Пост мог быть принят MAX',
          reviewStatus: 'pending',
        },
      });
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatSnapshot: jest.fn().mockResolvedValue({
          chatId: 'channel-1',
          title: 'Новости MAX',
          participantsCount: 1200,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/channels/news-max',
          lastEventAt: '2026-03-10T12:00:00.000Z',
          entityType: 'channel',
        }),
        sendMessageImmediateWithResolvedLink: jest.fn().mockRejectedValue(sendError),
        editMessageInlineKeyboard: jest.fn(),
      };
      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      attachSuggestionPublicationRoute(service, maxClient);

      await expect(
        service.reviewChannelSuggestionByAdmin(
          'suggestion-review-timeout-1',
          {
            userId: 'admin-1',
            username: 'chief',
            displayName: 'Главный редактор',
            chatTitle: null,
          },
          'publish',
        ),
      ).rejects.toBe(sendError);

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(prisma.auditLog.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it('keeps the versioned claim when a definitive publish error is returned', async () => {
    const prisma = createPrismaMock();
    prisma.$executeRaw.mockResolvedValueOnce(1);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: false,
        postSuggestionsEnabled: false,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-error-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: 'Публикация упадет',
        reviewStatus: 'pending',
      },
    });
    const publishError = new Error('MAX rejected publish');
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      sendMessageImmediateWithResolvedLink: jest.fn().mockRejectedValue(publishError),
      editMessageInlineKeyboard: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    attachSuggestionPublicationRoute(service, maxClient);

    await expect(
      service.reviewChannelSuggestionByAdmin(
        'suggestion-review-error-1',
        {
          userId: 'admin-1',
          username: 'chief',
          displayName: 'Главный редактор',
          chatTitle: null,
        },
        'publish',
      ),
    ).rejects.toBe(publishError);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    const claimSql = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(claimSql).toContain("'reviewClaimToken',");
    expect(claimSql).not.toContain("'reviewClaimReleasedAt',");
    expect(prisma.auditLog.updateMany).not.toHaveBeenCalled();
  });

  it('publishes a reviewed suggestion with restored MAX markup without flattening paragraphs', async () => {
    const sourceThreadId = '12121212-1212-4121-8121-121212121212';
    const sourceText = '🔥MAX Docs\n\nВторой абзац';
    const expectedHtml =
      '🔥<a href="https://dev.max.ru/docs-api"><strong>MAX Docs</strong></a>\n\nВторой абзац';
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonText: '📰 Предложить пост',
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-rich-1',
      chatId: 'channel-1',
      actorUserId: 'user-1',
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        authorDisplayName: 'Пользователь',
        text: sourceText,
        textMarkup: [
          {
            from: 2,
            length: 8,
            type: 'strong',
          },
          {
            from: 2,
            length: 8,
            type: 'link',
            url: 'https://dev.max.ru/docs-api',
          },
        ],
        threadId: sourceThreadId,
        reviewStatus: 'pending',
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-rich-1',
            botId: 'private-bot-2',
          },
        ],
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-post-rich-1',
        url: 'https://max.ru/chats/channel-1/message/1001',
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    attachSuggestionPublicationRoute(service, maxClient);
    jest
      .spyOn(service as any, 'resolveChannelSuggestionPublicationBotAssignment')
      .mockResolvedValue({
        botId: 'channel-bot-2',
        routeResolved: true,
        candidateBotIds: ['channel-bot-2'],
      });

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-rich-1',
      {
        userId: 'admin-1',
        username: 'chief',
        displayName: 'Главный редактор',
        chatTitle: null,
      },
      'publish',
    );

    expect(result).toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/1001',
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      `От подписчика <a href="max://user/user-1">Пользователь</a>\n\n${expectedHtml}`,
      expect.objectContaining({
        textFormat: 'html',
      }),
      expect.objectContaining({
        botId: 'channel-bot-2',
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        timeoutMs: 10_000,
      }),
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '555001',
      'mid-admin-review-rich-1',
      expect.stringContaining(expectedHtml),
      {
        buttons: [
          [
            {
              text: 'Открыть пост',
              type: 'link',
              url: 'https://max.ru/chats/channel-1/message/1001',
            },
          ],
        ],
        textFormat: 'html',
      },
      { botId: 'private-bot-2' },
    );
    expect(maxClient.editMessageInlineKeyboard.mock.calls[0]?.[2]).toContain(
      'Пост: <a href="https://max.ru/chats/channel-1/message/1001">Открыть пост</a>',
    );
  });

  it('publishes a reviewed photo suggestion with engagement buttons', async () => {
    const sourceThreadId = '22222222-2222-4222-8222-222222222222';
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonText: 'Предложить пост',
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-photo-1',
      chatId: 'channel-1',
      actorUserId: 'user-9',
      payload: {
        type: 'suggest',
        actorUserId: 'user-9',
        authorDisplayName: 'Фотограф',
        text: 'Фото с подписью',
        threadId: sourceThreadId,
        reviewStatus: 'pending',
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        imageMimeType: 'image/png',
        imageFileName: 'suggestion.png',
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-photo-1',
          },
        ],
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      uploadImage: jest.fn().mockResolvedValue({ token: 'uploaded-photo-1' }),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-photo-post-1',
        url: 'https://max.ru/chats/channel-1/message/101',
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    attachSuggestionPublicationRoute(service, maxClient);
    jest
      .spyOn(service as any, 'resolveChannelSuggestionPublicationBotAssignment')
      .mockResolvedValue({
        botId: 'channel-bot-2',
        routeResolved: true,
        candidateBotIds: ['channel-bot-2'],
      });

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-photo-1',
      {
        userId: 'admin-1',
        username: 'chief',
        displayName: 'Главный редактор',
        chatTitle: null,
      },
      'publish',
    );

    expect(result).toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/101',
    });
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'suggestion.png',
      'image/png',
      expect.objectContaining({
        botId: 'channel-bot-2',
        sourceTag: 'suggestion_delivery',
        timeoutMs: 12_000,
        trafficClass: 'background',
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'От подписчика [Фотограф](max://user/user-9)\n\nФото с подписью',
      expect.objectContaining({
        textFormat: 'markdown',
        imagePayload: { token: 'uploaded-photo-1' },
        buttons: [
          [
            expect.objectContaining({
              text: '💬 Комментарии · 0',
            }),
          ],
          [
            expect.objectContaining({
              text: 'Предложить пост',
            }),
          ],
        ],
      }),
      expect.objectContaining({
        botId: 'channel-bot-2',
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        timeoutMs: 10_000,
      }),
    );
    const autoAttachPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      threadId?: unknown;
    };
    const publishedThreadId =
      typeof autoAttachPayload.threadId === 'string' ? autoAttachPayload.threadId : '';

    expect(publishedThreadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(publishedThreadId).not.toBe(sourceThreadId);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
          payload: expect.objectContaining({
            messageId: 'mid-channel-photo-post-1',
            threadId: publishedThreadId,
            includeCommentsButton: true,
            includeSuggestButton: true,
            botId: 'channel-bot-2',
          }),
        }),
      }),
    );
  });

  it('publishes a reviewed multi-photo suggestion with engagement buttons', async () => {
    const sourceThreadId = '23232323-2323-4232-8232-232323232323';
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonText: 'Предложить пост',
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-multi-photo-1',
      chatId: 'channel-1',
      actorUserId: 'user-9',
      payload: {
        type: 'suggest',
        actorUserId: 'user-9',
        authorDisplayName: 'Фотограф',
        text: 'Фото с места события',
        threadId: sourceThreadId,
        reviewStatus: 'pending',
        imageCount: 2,
        imageFileNames: ['suggestion-1.png', 'suggestion-2.jpg'],
        images: [
          {
            payload: { token: 'uploaded-photo-1' },
            mimeType: 'image/png',
            fileName: 'suggestion-1.png',
          },
          {
            payload: { token: 'uploaded-photo-2' },
            mimeType: 'image/jpeg',
            fileName: 'suggestion-2.jpg',
          },
        ],
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-multi-photo-1',
          },
        ],
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-multi-photo-post-1',
        url: 'https://max.ru/chats/channel-1/message/1011',
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    attachSuggestionPublicationRoute(service, maxClient);
    jest
      .spyOn(service as any, 'resolveChannelSuggestionPublicationBotAssignment')
      .mockResolvedValue({
        botId: 'channel-bot-2',
        routeResolved: true,
        candidateBotIds: ['channel-bot-2'],
      });
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'suggestion-review-multi-photo-1',
          adminUserId: 'admin-1',
          botKey: 'channel-bot-2',
          botId: 'channel-bot-2',
          status: 'SENT',
        },
      ],
      skipDuplicates: true,
    });

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-multi-photo-1',
      {
        userId: 'admin-1',
        username: 'chief',
        displayName: 'Главный редактор',
        chatTitle: null,
      },
      'publish',
    );

    expect(result).toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/1011',
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'От подписчика [Фотограф](max://user/user-9)\n\nФото с места события',
      expect.objectContaining({
        textFormat: 'markdown',
        attachments: [
          { type: 'image', payload: { token: 'uploaded-photo-1' } },
          { type: 'image', payload: { token: 'uploaded-photo-2' } },
        ],
        buttons: [
          [
            expect.objectContaining({
              text: '💬 Комментарии · 0',
            }),
          ],
          [
            expect.objectContaining({
              text: 'Предложить пост',
            }),
          ],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        timeoutMs: 10_000,
      }),
    );
    const autoAttachPayload = prisma.auditLog.create.mock.calls[0]?.[0]?.data?.payload as {
      threadId?: unknown;
    };
    const publishedThreadId =
      typeof autoAttachPayload.threadId === 'string' ? autoAttachPayload.threadId : '';

    expect(publishedThreadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(publishedThreadId).not.toBe(sourceThreadId);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
          payload: expect.objectContaining({
            messageId: 'mid-channel-multi-photo-post-1',
            threadId: publishedThreadId,
            includeCommentsButton: true,
            includeSuggestButton: true,
          }),
        }),
      }),
    );
  });

  it('publishes a reviewed video suggestion with retry when attachment is not ready', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSuggestionsButtonText: 'Предложить пост',
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'suggestion-review-video-1',
      chatId: 'channel-1',
      actorUserId: 'user-9',
      payload: {
        type: 'suggest',
        actorUserId: 'user-9',
        authorDisplayName: 'Видеограф',
        text: 'Видео с подписью',
        threadId: '33333333-3333-4333-8333-333333333333',
        reviewStatus: 'pending',
        mediaType: 'video',
        mediaPayload: {
          token: 'video-upload-1',
        },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'suggestion.mp4',
        deliveries: [
          {
            adminUserId: 'admin-1',
            privateChatId: '555001',
            messageId: 'mid-admin-review-video-1',
          },
        ],
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Новости MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channels/news-max',
        lastEventAt: '2026-03-10T12:00:00.000Z',
        entityType: 'channel',
      }),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockRejectedValueOnce({
          response: {
            status: 400,
            data: {
              code: 'attachment.not.ready',
            },
          },
        })
        .mockResolvedValueOnce({
          messageId: 'mid-channel-video-post-1',
          url: 'https://max.ru/chats/channel-1/message/102',
        }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    attachSuggestionPublicationRoute(service, maxClient);
    jest
      .spyOn(service as any, 'resolveChannelSuggestionPublicationBotAssignment')
      .mockResolvedValue({
        botId: 'channel-bot-2',
        routeResolved: true,
        candidateBotIds: ['channel-bot-2'],
      });
    await prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'suggestion-review-video-1',
          adminUserId: 'admin-1',
          botKey: 'channel-bot-2',
          botId: 'channel-bot-2',
          status: 'SENT',
        },
      ],
      skipDuplicates: true,
    });
    const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    const result = await service.reviewChannelSuggestionByAdmin(
      'suggestion-review-video-1',
      {
        userId: 'admin-1',
        username: 'chief',
        displayName: 'Главный редактор',
        chatTitle: null,
      },
      'publish',
    );

    expect(result).toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/102',
    });
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenLastCalledWith(
      'channel-1',
      'От подписчика [Видеограф](max://user/user-9)\n\nВидео с подписью',
      expect.objectContaining({
        textFormat: 'markdown',
        attachments: [{ type: 'video', payload: { token: 'video-upload-1' } }],
        buttons: [
          [
            expect.objectContaining({
              text: '💬 Комментарии · 0',
            }),
          ],
          [
            expect.objectContaining({
              text: 'Предложить пост',
            }),
          ],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        timeoutMs: 10_000,
      }),
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '555001',
      'mid-admin-review-video-1',
      expect.stringContaining('**Контент публикации**'),
      {
        buttons: [
          [
            {
              text: 'Открыть пост',
              type: 'link',
              url: 'https://max.ru/chats/channel-1/message/102',
            },
          ],
        ],
        textFormat: 'markdown',
      },
      { botId: '777000_bot' },
    );
  });

  it('updates the existing published engagement post instead of creating a new one', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      postSuggestionsEntryMode: 'BOT',
      engagementPublishedMessageId: 'mid-existing-engagement-1',
      engagementPublishedThreadId: 'thread-existing-1',
      engagementPublishedAt: new Date('2026-03-10T12:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'delete'],
      }),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-new-engagement-1', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Обновленный текст публикации.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-existing-engagement-1',
      'Обновленный текст публикации.',
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        timeoutMs: 10_000,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      chatId: 'channel-1',
      sent: true,
      messageId: 'mid-existing-engagement-1',
      updatedExisting: true,
      publishedAt: '2026-03-10T12:00:00.000Z',
    });
  });

  it('edits channel engagement with the stored author bot and stores the new bot after recreate', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      engagementPublishedMessageId: 'mid-existing-engagement-1',
      engagementPublishedBotId: 'channel-bot-2',
      engagementPublishedThreadId: 'thread-existing-1',
      engagementPublishedAt: new Date('2026-03-10T12:00:00.000Z'),
      postSuggestionsEntryMode: 'BOT',
    });

    const recreateError = {
      response: {
        status: 403,
        data: { message: "message can't be edited" },
      },
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(recreateError),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-new-engagement-1', url: null }),
    };
    const maxBotLinkService = createAdminMaxBotLinkMock({
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'channel-bot-2',
        botId: 'channel-bot-5',
        candidateBotIds: ['channel-bot-5', 'channel-bot-2'],
        reason: 'alternate_confirmed',
      }),
      resolveBotIdForSend: jest.fn().mockResolvedValue('channel-bot-2'),
      resolveBotId: jest.fn().mockResolvedValue('channel-bot-2'),
    });

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    const result = await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Обновленный текст публикации.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-existing-engagement-1',
      'Обновленный текст публикации.',
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      expect.objectContaining({
        botId: 'channel-bot-2',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Обновленный текст публикации.',
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      expect.objectContaining({
        botId: 'channel-bot-5',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      }),
    );
    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(prisma.channelSettings.update).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      data: {
        engagementPublishedMessageId: 'mid-new-engagement-1',
        engagementPublishedBotId: 'channel-bot-5',
        engagementPublishedThreadId: 'thread-existing-1',
        engagementPublishedAt: expect.any(Date),
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          messageId: 'mid-new-engagement-1',
          recreatedFromMessageId: 'mid-existing-engagement-1',
          botId: 'channel-bot-5',
        }),
      }),
    });
    expect(result).toMatchObject({
      messageId: 'mid-new-engagement-1',
      updatedExisting: false,
    });
  });

  it('edits legacy channel engagement through a delete-capable route instead of a write-only send bot', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      engagementPublishedMessageId: 'mid-legacy-engagement-1',
      engagementPublishedBotId: null,
      engagementPublishedThreadId: 'thread-legacy-1',
      engagementPublishedAt: new Date('2026-03-10T12:00:00.000Z'),
      postSuggestionsEntryMode: 'BOT',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const maxBotLinkService = createAdminMaxBotLinkMock({
      resolveBotRoute: jest.fn().mockImplementation(async (request: { purpose: string }) => {
        if (request.purpose === 'moderation_action') {
          return {
            purpose: 'moderation_action',
            chatId: 'channel-1',
            primaryBotId: 'write-only-bot',
            botId: 'edit-delete-standby-bot',
            candidateBotIds: ['edit-delete-standby-bot'],
            reason: 'alternate_confirmed',
            action: 'delete_message',
          };
        }

        return {
          purpose: 'send_message',
          chatId: 'channel-1',
          primaryBotId: 'write-only-bot',
          botId: 'write-only-bot',
          candidateBotIds: ['write-only-bot'],
          reason: 'primary_confirmed',
        };
      }),
      resolveBotIdForSend: jest.fn().mockResolvedValue('write-only-bot'),
      resolveBotId: jest.fn().mockResolvedValue('write-only-bot'),
    });

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    const result = await service.publishChannelEngagementMessage(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Обновленный текст legacy-поста.',
        commentsButtonText: 'Комментарии',
        suggestButtonText: 'Предложить пост',
      },
    );

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'moderation_action',
      chatId: 'channel-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'mid-legacy-engagement-1',
      'Обновленный текст legacy-поста.',
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      expect.objectContaining({
        botId: 'edit-delete-standby-bot',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.channelSettings.update).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      data: {
        engagementPublishedMessageId: 'mid-legacy-engagement-1',
        engagementPublishedBotId: 'edit-delete-standby-bot',
        engagementPublishedThreadId: 'thread-legacy-1',
        engagementPublishedAt: new Date('2026-03-10T12:00:00.000Z'),
      },
    });
    expect(result).toMatchObject({
      messageId: 'mid-legacy-engagement-1',
      updatedExisting: true,
    });
  });

  it('does not edit legacy channel engagement through the default bot when no edit route is executable', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      engagementPublishedMessageId: 'mid-legacy-engagement-denied-1',
      engagementPublishedBotId: null,
      engagementPublishedThreadId: 'thread-legacy-denied-1',
      engagementPublishedAt: new Date('2026-03-10T12:00:00.000Z'),
      postSuggestionsEntryMode: 'BOT',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn(),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const maxBotLinkService = createAdminMaxBotLinkMock({
      resolveBotRoute: jest.fn().mockImplementation(async (request: { purpose: string }) => {
        if (request.purpose === 'moderation_action') {
          return {
            purpose: 'moderation_action',
            chatId: 'channel-1',
            primaryBotId: 'write-only-bot',
            botId: null,
            candidateBotIds: [],
            reason: null,
            action: 'delete_message',
          };
        }

        return {
          purpose: 'send_message',
          chatId: 'channel-1',
          primaryBotId: 'write-only-bot',
          botId: 'write-only-bot',
          candidateBotIds: ['write-only-bot'],
          reason: 'primary_confirmed',
        };
      }),
      resolveBotIdForSend: jest.fn().mockResolvedValue('write-only-bot'),
      resolveBotId: jest.fn().mockResolvedValue('write-only-bot'),
    });

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.publishChannelEngagementMessage(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Этот legacy-пост нельзя безопасно обновить.',
          commentsButtonText: 'Комментарии',
          suggestButtonText: 'Предложить пост',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'moderation_action',
      chatId: 'channel-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('rejects empty channel comments without attachments and stores uploaded attachments', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-attachment-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T10:12:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-9', url: null }),
      uploadImage: jest.fn().mockResolvedValue({
        token: 'comment-image-1',
        url: 'https://cdn.max.ru/comment-image-1.png',
        width: 960,
        height: 720,
      }),
      uploadFile: jest.fn().mockResolvedValue({
        token: 'comment-file-1',
        url: 'https://cdn.max.ru/comment-file-1.pdf',
        file_name: 'minutes.pdf',
        mime_type: 'application/pdf',
        size: 123_000,
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        {
          token: commentsToken,
          text: '   ',
        },
      ),
    ).rejects.toThrow('Введите текст комментария или добавьте вложение.');

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: '',
        attachments: [
          {
            type: 'image',
            base64: 'YQ==',
            mimeType: 'image/png',
            fileName: 'comment.png',
          },
          {
            type: 'file',
            base64: 'Yg==',
            mimeType: 'application/pdf',
            fileName: 'minutes.pdf',
          },
        ],
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from('a'),
      'comment.png',
      'image/png',
      { botId: '777000_bot' },
    );
    expect(maxClient.uploadFile).toHaveBeenCalledWith(
      Buffer.from('b'),
      'minutes.pdf',
      'application/pdf',
      { botId: '777000_bot' },
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            text: '',
            attachments: [
              expect.objectContaining({
                kind: 'image',
                fileName: 'comment.png',
                mimeType: 'image/png',
                payload: expect.objectContaining({
                  token: 'comment-image-1',
                  url: 'https://cdn.max.ru/comment-image-1.png',
                }),
              }),
              expect.objectContaining({
                kind: 'file',
                fileName: 'minutes.pdf',
                mimeType: 'application/pdf',
                payload: expect.objectContaining({
                  token: 'comment-file-1',
                  url: 'https://cdn.max.ru/comment-file-1.pdf',
                }),
              }),
            ],
          }),
        }),
      }),
    );
    expect(result.message.attachments).toEqual([
      expect.objectContaining({
        kind: 'image',
        fileName: 'comment.png',
        mimeType: 'image/png',
        url: 'https://cdn.max.ru/comment-image-1.png',
      }),
      expect.objectContaining({
        kind: 'file',
        fileName: 'minutes.pdf',
        mimeType: 'application/pdf',
        url: 'https://cdn.max.ru/comment-file-1.pdf',
      }),
    ]);
  });

  it('keeps an inline preview for channel comment photos when MAX upload payload has no direct url', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-photo-preview-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T10:14:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-10', url: null }),
      uploadImage: jest.fn().mockResolvedValue({
        photos: {
          thumb: {
            token: 'comment-image-preview-1',
          },
        },
      }),
      uploadFile: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: '',
        attachments: [
          {
            type: 'image',
            base64: 'YQ==',
            mimeType: 'image/png',
            fileName: 'camera-shot.png',
            width: 720,
            height: 1280,
          },
        ],
      },
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                kind: 'image',
                mimeType: 'image/png',
                fileName: 'camera-shot.png',
                previewBase64: 'YQ==',
                width: 720,
                height: 1280,
              }),
            ],
          }),
        }),
      }),
    );
    expect(result.message.attachments).toEqual([
      expect.objectContaining({
        kind: 'image',
        url: null,
        previewUrl: 'data:image/png;base64,YQ==',
        width: 720,
        height: 1280,
      }),
    ]);
  });

  it('uploads image-like file attachments in channel comments as photos', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-image-file-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T10:14:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-10', url: null }),
      uploadImage: jest.fn().mockResolvedValue({
        token: 'comment-image-file-1',
        url: 'https://cdn.max.ru/gallery-shot.jpg',
      }),
      uploadFile: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    const result = await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: '',
        attachments: [
          {
            type: 'file',
            base64: 'YQ==',
            mimeType: 'image/jpeg',
            fileName: 'gallery-shot.jpg',
          },
        ],
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from('a'),
      'gallery-shot.jpg',
      'image/jpeg',
      { botId: '777000_bot' },
    );
    expect(maxClient.uploadFile).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                kind: 'image',
                mimeType: 'image/jpeg',
                fileName: 'gallery-shot.jpg',
              }),
            ],
          }),
        }),
      }),
    );
    expect(result.message.attachments).toEqual([
      expect.objectContaining({
        kind: 'image',
        mimeType: 'image/jpeg',
        fileName: 'gallery-shot.jpg',
        url: 'https://cdn.max.ru/gallery-shot.jpg',
      }),
    ]);
  });

  it('rejects channel comment photos in formats unsupported by MAX uploads', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-11', url: null }),
      uploadImage: jest.fn(),
      uploadFile: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        {
          token: commentsToken,
          text: '',
          attachments: [
            {
              type: 'image',
              base64: 'YQ==',
              mimeType: 'image/webp',
              fileName: 'camera-shot.webp',
            },
          ],
        },
      ),
    ).rejects.toThrow(
      'MAX пока не принимает этот формат фото. Используйте JPG, PNG, GIF, TIFF, BMP или HEIC.',
    );

    expect(maxClient.uploadImage).not.toHaveBeenCalled();
  });

  it('returns persisted inline previews for channel comment photos without remote urls', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-comment-with-preview-1',
        actorUserId: 'user-2',
        payload: {
          type: 'comments',
          text: '',
          authorDisplayName: 'Марина',
          attachments: [
            {
              kind: 'image',
              mimeType: 'image/webp',
              fileName: 'camera-shot.webp',
              width: 720,
              height: 1280,
              previewBase64: 'YQ==',
              payload: {
                photos: {
                  thumb: {
                    token: 'comment-image-preview-1',
                  },
                },
              },
            },
          ],
        },
        createdAt: new Date('2026-03-20T09:00:00.000Z'),
      },
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn(),
        getChatMemberProfiles: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-preview',
    ) as string;

    const result = await service.getChannelDialog(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    expect(result.messages[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: 'image',
        url: null,
        previewUrl: 'data:image/webp;base64,YQ==',
        width: 720,
        height: 1280,
      }),
    ]);
  });

  it('normalizes persisted image file attachments in channel comments back to photos', async () => {
    const prisma = createPrismaMock();
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'channel-comment-image-file-persisted-1',
        actorUserId: 'user-2',
        payload: {
          type: 'comments',
          text: '',
          authorDisplayName: 'Марина',
          attachments: [
            {
              kind: 'file',
              mimeType: 'image/jpeg',
              fileName: 'gallery-shot.jpg',
              payload: {
                url: 'https://cdn.max.ru/gallery-shot.jpg',
              },
            },
          ],
        },
        createdAt: new Date('2026-03-20T09:00:00.000Z'),
      },
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn(),
        getChatMemberProfiles: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken(
      'channel',
      'channel-1',
      'comments',
      'channel-thread-preview',
    ) as string;

    const result = await service.getChannelDialog(
      'channel-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    expect(result.messages[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: 'image',
        mimeType: 'image/jpeg',
        fileName: 'gallery-shot.jpg',
        url: 'https://cdn.max.ru/gallery-shot.jpg',
        previewUrl: 'https://cdn.max.ru/gallery-shot.jpg',
      }),
    ]);
  });

  it('rejects channel comments with links when moderation blocks links', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        commentsModerationEnabled: true,
        commentsBlockLinksEnabled: true,
        commentsAntiSpamEnabled: false,
        commentsLimitTwoInRowEnabled: false,
      }),
    );
    prisma.auditLog.create.mockResolvedValueOnce(undefined);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-5', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        {
          token: commentsToken,
          text: 'Вот ссылка https://example.com',
        },
      ),
    ).rejects.toThrow('Ссылки в комментариях отключены.');

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a third consecutive comment when the limit is enabled', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        commentsModerationEnabled: true,
        commentsBlockLinksEnabled: false,
        commentsAntiSpamEnabled: false,
        commentsLimitTwoInRowEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValueOnce(undefined);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([
        {
          id: 'comment-2',
          actorUserId: 'user-1',
          payload: {
            text: 'Второй комментарий',
          },
          createdAt: new Date('2026-03-10T10:01:00.000Z'),
        },
        {
          id: 'comment-1',
          actorUserId: 'user-1',
          payload: {
            text: 'Первый комментарий',
          },
          createdAt: new Date('2026-03-10T10:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-engagement-7', url: null }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const commentsToken = await publishCommentsDialogToken(service, maxClient);

    await expect(
      service.createChannelDialogMessage(
        'channel-1',
        {
          userId: 'user-1',
          username: 'user1',
          displayName: 'Пользователь',
          chatTitle: null,
        },
        'comments',
        {
          token: commentsToken,
          text: 'Третий комментарий',
        },
      ),
    ).rejects.toThrow('Нельзя оставлять больше двух комментариев подряд.');

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
