import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
  extractSqlText,
} from './admin-service-test-support';

const actor = {
  userId: 'author-1',
  username: 'author',
  displayName: 'Автор',
  avatarUrl: null,
};

function sqlValues(query: unknown): unknown[] {
  return query && typeof query === 'object' && 'values' in query
    ? ((query as { values?: unknown[] }).values ?? [])
    : [];
}

function createRoutingHarness(params: {
  routeLookup: (botId: string) => string | null;
  adminIds?: string[];
  memberAccess?: Map<
    string,
    { userId: string; isAdmin: boolean; isOwner: boolean; permissions: string[] }
  >;
  memberAccessError?: unknown;
  send?: (
    chatId: string,
    options: Record<string, unknown>,
    dispatch: Record<string, unknown>,
  ) => Promise<unknown>;
  uploadImage?: (...args: unknown[]) => Promise<Record<string, unknown>>;
  queue?: Record<string, unknown>;
  query?: (sql: string, values: unknown[]) => unknown[] | Promise<unknown[]> | undefined;
}) {
  const prisma = createPrismaMock();
  prisma.chat.findUnique.mockResolvedValue({
    id: 'channel-1',
    title: 'Новости MAX',
    entityType: 'CHANNEL',
  });
  prisma.$queryRaw.mockImplementation(async (query: unknown) => {
    const sql = extractSqlText(query);
    const customResult = await params.query?.(sql, sqlValues(query));
    if (customResult !== undefined) {
      if (sql.includes('UPDATE channel_suggestion_admin_deliveries target')) {
        for (const row of customResult) {
          const id =
            row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
              ? (row as { id: string }).id
              : '';
          if (!id) continue;
          await prisma.channelSuggestionAdminDelivery.updateMany({
            where: { id, status: 'FAILED', terminal: true },
            data: {
              status: 'PENDING',
              privateChatId: null,
              remoteMessageId: null,
              sentAt: null,
              lockedAt: null,
              lockToken: null,
              lastError: null,
              lastStatusCode: null,
              lastErrorCode: null,
              terminal: false,
            },
          });
        }
      }
      return customResult;
    }
    if (sql.includes('FROM webhook_events') && sql.includes('created_at >=')) {
      const botId = sqlValues(query).find(
        (value) => typeof value === 'string' && value.endsWith('-bot'),
      );
      const privateChatId = typeof botId === 'string' ? params.routeLookup(botId) : null;
      return privateChatId ? [{ recipient_chat_id: privateChatId }] : [];
    }
    return [];
  });

  const sendMessageImmediateWithId = jest.fn(
    async (
      chatId: string,
      _text: string,
      options: Record<string, unknown>,
      dispatch: Record<string, unknown>,
    ) => {
      const beforeSend = options.beforeSend;
      if (typeof beforeSend === 'function') await beforeSend();
      return params.send
        ? params.send(chatId, options, dispatch)
        : { messageId: `message-${chatId}`, chatId, url: null };
    },
  );
  const memberAccess = new Map<
    string,
    { userId: string; isAdmin: boolean; isOwner: boolean; permissions: string[] }
  >(
    (params.adminIds ?? ['admin-1']).map(
      (userId) => [userId, { userId, isAdmin: true, isOwner: false, permissions: [] }] as const,
    ),
  );
  for (const [userId, access] of params.memberAccess ?? []) memberAccess.set(userId, access);
  const maxClient = {
    getChatAdminIds: jest.fn().mockResolvedValue(params.adminIds ?? ['admin-1']),
    getChatMembersAccess: params.memberAccessError
      ? jest.fn().mockRejectedValue(params.memberAccessError)
      : jest.fn().mockResolvedValue(memberAccess),
    sendMessageImmediateWithId,
    sendMessageImmediateToUser: jest.fn(),
    uploadImage: jest.fn(
      params.uploadImage ??
        (async () => ({ token: `upload-${Math.random().toString(16).slice(2)}` })),
    ),
  };
  const bots = ['assist-bot', 'alternate-bot', 'third-bot', 'source-bot'];
  const maxBotRegistry = {
    getBotById: jest.fn((botId?: string | null) =>
      botId && bots.includes(botId) ? { id: botId } : null,
    ),
    getDefaultBot: jest.fn().mockReturnValue({ id: 'assist-bot' }),
    getEntryBot: jest.fn().mockReturnValue({ id: 'assist-bot' }),
    getOperationalBots: jest.fn().mockReturnValue(bots.map((id) => ({ id }))),
    getActionableBots: jest.fn().mockReturnValue(bots.map((id) => ({ id }))),
  };
  const service = new AdminService(
    prisma as never,
    maxClient as never,
    createChatContextCacheMock() as never,
    createConfigMock() as never,
    undefined,
    undefined,
    undefined,
    params.queue as never,
    undefined,
    maxBotRegistry as never,
  );
  jest.spyOn(service as any, 'resolveAssistBotAssignment').mockResolvedValue('assist-bot');
  jest.spyOn(service as any, 'resolveKnownBotUserIdsForChat').mockResolvedValue(new Set());
  jest.spyOn(service as any, 'resolveChannelTitle').mockResolvedValue('Новости MAX');
  jest.spyOn(service as any, 'resolveChannelSuggestionAuthorAttribution').mockResolvedValue({
    userId: actor.userId,
    displayName: actor.displayName,
    mentionDisplayName: actor.displayName,
    username: actor.username,
    profileUrl: 'https://max.ru/author',
  });
  return { maxBotRegistry, maxClient, prisma, service };
}

describe('AdminService channel suggestion delivery routing', () => {
  it('binds initial buttons to the same content snapshot even after another edit', async () => {
    const harness = createRoutingHarness({ routeLookup: () => 'private-admin' });
    harness.prisma.auditLog.findUnique.mockResolvedValue({
      payload: { text: 'Other edit', reviewContentRevision: 8 },
    });
    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'snapshot-1',
      'channel-1',
      actor,
      { text: 'Shown snapshot' },
      undefined,
      7,
    );
    expect(harness.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'private-admin',
      expect.stringContaining('Shown snapshot'),
      expect.objectContaining({
        buttons: expect.arrayContaining([
          [expect.objectContaining({ payload: 'sr1|publish|snapshot-1|7|0' })],
        ]),
      }),
      expect.any(Object),
    );
  });

  it('uses a known active alternate when the preferred bot has no admin dialog', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'alternate-bot' ? 'private-alternate' : null),
    });

    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-direct-alternate-1',
      'channel-1',
      actor,
      { text: 'Текст предложки' },
    );

    expect(harness.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'private-alternate',
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ botId: 'alternate-bot' }),
    );
    expect(harness.maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
  });

  it('releases a stale primary route, prepares the alternate outside its lease, and persists it', async () => {
    const sentChats: string[] = [];
    const harness = createRoutingHarness({
      routeLookup: (botId) =>
        botId === 'assist-bot'
          ? 'private-assist'
          : botId === 'alternate-bot'
            ? 'private-alternate'
            : null,
      send: async (chatId) => {
        sentChats.push(chatId);
        if (chatId === 'private-assist') {
          throw { response: { status: 404, data: { code: 'dialog.not.found' } } };
        }
        return { messageId: 'message-alternate', chatId, url: null };
      },
    });

    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-alternate-1',
      'channel-1',
      actor,
      { text: 'Текст предложки' },
    );

    expect(sentChats).toEqual(['private-assist', 'private-alternate']);
    expect(harness.maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-alternate-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        adminUserId: 'admin-1',
        botId: 'alternate-bot',
        privateChatId: 'private-alternate',
        status: 'SENT',
        remoteMessageId: 'message-alternate',
      }),
    ]);
  });

  it('keeps a ten-image row PENDING during prep and uploads only for the first selected bot', async () => {
    let releaseFirstUpload!: (value: Record<string, unknown>) => void;
    const firstUpload = new Promise<Record<string, unknown>>((resolve) => {
      releaseFirstUpload = resolve;
    });
    let uploadCount = 0;
    const harness = createRoutingHarness({
      routeLookup: (botId) => `private-${botId}`,
      uploadImage: async () => {
        uploadCount += 1;
        return uploadCount === 1 ? firstUpload : { token: `upload-${uploadCount}` };
      },
    });
    const delivery = (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-images-1',
      'channel-1',
      actor,
      {
        text: '',
        images: Array.from({ length: 10 }, (_, index) => ({
          base64: Buffer.from(`image-${index}`).toString('base64'),
          mimeType: 'image/png',
          fileName: `image-${index}.png`,
        })),
      },
    );
    while (harness.maxClient.uploadImage.mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-images-1' },
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'PENDING', attemptCount: 0 })]);
    releaseFirstUpload({ token: 'upload-1' });
    await delivery;

    expect(harness.maxClient.uploadImage).toHaveBeenCalledTimes(10);
    expect(
      new Set(
        (harness.maxClient.uploadImage.mock.calls as unknown[][]).map(
          (call) => (call[3] as { botId?: string } | undefined)?.botId,
        ),
      ),
    ).toEqual(new Set(['assist-bot']));
  });

  it('uses the trusted source bot for token media even when channel assist differs', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'source-bot' ? 'private-source' : null),
    });

    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-source-bot-1',
      'channel-1',
      actor,
      {
        text: '',
        mediaType: 'video',
        mediaPayload: { token: 'source-video-token' },
        mediaBotId: 'source-bot',
      },
    );

    expect(harness.maxClient.uploadImage).not.toHaveBeenCalled();
    expect(harness.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'private-source',
      expect.any(String),
      expect.objectContaining({
        attachments: [{ type: 'video', payload: { token: 'source-video-token' } }],
      }),
      expect.objectContaining({ botId: 'source-bot' }),
    );
  });

  it('recovers one recent route-v1 terminal row through the scheduled queue and worker', async () => {
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'alternate-bot' ? 'private-alternate' : null),
      queue,
      query: (sql) => {
        if (sql.includes('WITH ranked_admin_suggestions')) {
          return [{ id: 'suggestion-route-v1-1' }];
        }
        if (sql.includes('SELECT audit.id')) return [];
        if (sql.includes('delivery.id IN')) return [{ id: 'legacy-terminal-row' }];
        return undefined;
      },
    });
    harness.prisma.auditLog.findUnique.mockResolvedValue({
      id: 'suggestion-route-v1-1',
      chatId: 'channel-1',
      actorUserId: actor.userId,
      action: 'CHANNEL_DIALOG_SUGGESTION',
      payload: {
        type: 'suggest',
        text: 'Старая недоставленная предложка',
        reviewStatus: 'pending',
        delivered: false,
        deliveries: [],
        images: [],
        imageCount: 0,
      },
      createdAt: new Date(),
    });
    await harness.prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          id: 'legacy-terminal-row',
          auditLogId: 'suggestion-route-v1-1',
          adminUserId: 'admin-1',
          botKey: 'old-preferred-bot',
          botId: 'assist-bot',
          status: 'FAILED',
          terminal: true,
          lastStatusCode: 404,
          lastErrorCode: 'dialog.not.found',
          lastError: 'dialog not found',
        },
      ],
      skipDuplicates: true,
    });

    await expect(harness.service.recoverStaleChannelSuggestionDeliveries()).resolves.toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      'deliver-channel-suggestion',
      { auditLogId: 'suggestion-route-v1-1' },
      expect.any(Object),
    );
    await harness.service.processChannelSuggestionDeliveryJob('suggestion-route-v1-1');

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-route-v1-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'legacy-terminal-row',
        status: 'SENT',
        botId: 'alternate-bot',
        privateChatId: 'private-alternate',
      }),
    ]);
  });

  it('queues stale dispatch-started rows for snapshot sync without making them sendable', async () => {
    const queue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const harness = createRoutingHarness({ routeLookup: () => null, queue });
    await harness.prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'suggestion-stale-dispatch-1',
          adminUserId: 'admin-1',
          botKey: '__default__',
          status: 'SENDING',
          lockedAt: new Date('2026-08-01T10:00:00.000Z'),
          lockToken: 'stale-lock',
          lastErrorCode: 'suggestion.delivery.dispatch_started',
        },
      ],
      skipDuplicates: true,
    });

    await expect(harness.service.recoverStaleChannelSuggestionDeliveries(12)).resolves.toBe(1);

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-stale-dispatch-1' },
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'AMBIGUOUS' })]);
    expect(queue.add).toHaveBeenCalledWith(
      'deliver-channel-suggestion',
      { auditLogId: 'suggestion-stale-dispatch-1' },
      expect.any(Object),
    );
    expect(harness.prisma.channelSuggestionAdminDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 12 }),
    );
  });

  it('does not create or dispatch another bot-key row when the editor already has SENT evidence', async () => {
    const harness = createRoutingHarness({ routeLookup: () => 'private-current' });
    await harness.prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'suggestion-sent-sibling-1',
          adminUserId: 'admin-1',
          botKey: 'old-preferred-bot',
          botId: 'alternate-bot',
          privateChatId: 'private-old',
          status: 'SENT',
          remoteMessageId: 'already-sent',
          sentAt: new Date(),
        },
        {
          auditLogId: 'suggestion-sent-sibling-1',
          adminUserId: 'admin-1',
          botKey: 'failed-sibling-bot',
          botId: 'assist-bot',
          status: 'FAILED',
          terminal: false,
          lastStatusCode: 503,
          lastError: 'temporary',
        },
      ],
      skipDuplicates: true,
    });

    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-sent-sibling-1',
      'channel-1',
      actor,
      { text: 'Не отправлять повторно' },
    );

    expect(harness.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-sent-sibling-1' },
      }),
    ).resolves.toHaveLength(2);
  });

  it('uses one stable logical row when concurrent workers resolve different preferred bots', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) =>
        botId === 'assist-bot' || botId === 'alternate-bot' ? `private-${botId}` : null,
    });
    const resolveAssistBotAssignment = (harness.service as any)
      .resolveAssistBotAssignment as jest.Mock;
    resolveAssistBotAssignment
      .mockReset()
      .mockResolvedValueOnce('assist-bot')
      .mockResolvedValueOnce('alternate-bot');

    await Promise.all([
      (harness.service as any).deliverSuggestionToAdminPrivates(
        'suggestion-stable-key-1',
        'channel-1',
        actor,
        { text: 'Одна доставка' },
      ),
      (harness.service as any).deliverSuggestionToAdminPrivates(
        'suggestion-stable-key-1',
        'channel-1',
        actor,
        { text: 'Одна доставка' },
      ),
    ]);

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-stable-key-1' },
      }),
    ).resolves.toEqual([expect.objectContaining({ botKey: '__default__', status: 'SENT' })]);
    expect(harness.maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
  });

  it('terminalizes a removed editor only after fresh roster and targeted access confirmation', async () => {
    const harness = createRoutingHarness({
      routeLookup: () => null,
      adminIds: [],
      memberAccess: new Map([
        [
          'removed-admin',
          {
            userId: 'removed-admin',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          },
        ],
      ]),
    });
    await harness.prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'suggestion-empty-roster-1',
          adminUserId: 'removed-admin',
          botKey: '__default__',
          status: 'PENDING',
        },
      ],
      skipDuplicates: true,
    });

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-empty-roster-1',
      'channel-1',
      actor,
      { text: 'Редактор удален' },
    );

    expect(harness.maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({ bypassCache: true, botId: 'assist-bot' }),
    );
    expect(harness.maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-1',
      ['removed-admin'],
      expect.objectContaining({ bypassCache: true, botId: 'assist-bot' }),
    );
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-empty-roster-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: true,
        lastErrorCode: 'suggestion.delivery.editor_removed',
      }),
    ]);
    expect(result.suggestionDelivery.state).toBe('no_reachable_editor');
  });

  it('keeps a missing editor retryable when targeted access cannot confirm removal', async () => {
    const harness = createRoutingHarness({
      routeLookup: () => null,
      adminIds: [],
      memberAccessError: new Error('temporary targeted roster timeout'),
    });
    await harness.prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'suggestion-unconfirmed-roster-1',
          adminUserId: 'possibly-current-admin',
          botKey: '__default__',
          status: 'PENDING',
        },
      ],
      skipDuplicates: true,
    });

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-unconfirmed-roster-1',
      'channel-1',
      actor,
      { text: 'Не закрывать без подтверждения' },
    );

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-unconfirmed-roster-1' },
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'PENDING', terminal: false })]);
    expect(result.suggestionDelivery.state).toBe('queued');
  });

  it('keeps a fresh empty roster recoverable when no prior editor row exists', async () => {
    const harness = createRoutingHarness({ routeLookup: () => null, adminIds: [] });

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-new-empty-roster-1',
      'channel-1',
      actor,
      { text: 'Не потерять при пустом roster' },
    );

    expect(result).toEqual(
      expect.objectContaining({
        delivered: false,
        suggestionDelivery: expect.objectContaining({ state: 'queued', targetCount: 0 }),
        deliveryFailures: [
          expect.objectContaining({
            adminUserId: 'delivery_job',
            code: 'suggestion.delivery.roster_empty',
            terminal: false,
            recoverable: true,
          }),
        ],
      }),
    );
  });

  it('closes a removed editor while delivering to a current editor', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-current' : null),
      adminIds: ['current-admin'],
      memberAccess: new Map([
        [
          'removed-admin',
          {
            userId: 'removed-admin',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          },
        ],
      ]),
    });
    await harness.prisma.channelSuggestionAdminDelivery.createMany({
      data: [
        {
          auditLogId: 'suggestion-roster-change-1',
          adminUserId: 'removed-admin',
          botKey: '__default__',
          status: 'PENDING',
        },
        {
          auditLogId: 'suggestion-roster-change-1',
          adminUserId: 'current-admin',
          botKey: '__default__',
          status: 'PENDING',
        },
      ],
      skipDuplicates: true,
    });

    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-roster-change-1',
      'channel-1',
      actor,
      { text: 'Актуальный состав' },
    );

    const rows = await harness.prisma.channelSuggestionAdminDelivery.findMany({
      where: { auditLogId: 'suggestion-roster-change-1' },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adminUserId: 'removed-admin',
          status: 'FAILED',
          lastErrorCode: 'suggestion.delivery.editor_removed',
        }),
        expect.objectContaining({ adminUserId: 'current-admin', status: 'SENT' }),
      ]),
    );
  });

  it('persists transient media preparation failures as retryable FAILED rows', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
      uploadImage: async () => {
        throw new Error('temporary connection failure');
      },
    });

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-transient-prep-1',
      'channel-1',
      actor,
      {
        text: '',
        images: [{ base64: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
      },
    );

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-transient-prep-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: false,
        attemptCount: 1,
        lastErrorCode: 'suggestion.delivery.preclaim_failed',
      }),
    ]);
    expect(result.suggestionDelivery.state).toBe('queued');
  });

  it('keeps permanent preclaim HTTP failures uncertain instead of blaming the editor dialog', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
      uploadImage: async () => {
        throw {
          response: {
            status: 404,
            data: { code: 'attachment.not.found', message: 'upload target not found' },
          },
        };
      },
    });

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-permanent-prep-1',
      'channel-1',
      actor,
      {
        text: '',
        images: [{ base64: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
      },
    );

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-permanent-prep-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: true,
        lastStatusCode: 404,
        lastErrorCode: 'suggestion.delivery.preclaim_failed',
      }),
    ]);
    expect(result.suggestionDelivery.state).toBe('uncertain');
  });

  it('tries the next bot when route-scoped media preparation fails on the first bot', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) =>
        botId === 'assist-bot' || botId === 'alternate-bot' ? `private-${botId}` : null,
      uploadImage: async (...args) => {
        const botId = (args[3] as { botId?: string } | undefined)?.botId;
        if (botId === 'assist-bot') {
          throw { response: { status: 403, data: { code: 'access.denied' } } };
        }
        return { token: `upload-${botId}` };
      },
    });

    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-prep-alternate-1',
      'channel-1',
      actor,
      {
        text: '',
        images: [{ base64: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
      },
    );

    expect(harness.maxClient.uploadImage).toHaveBeenCalledTimes(2);
    expect(harness.maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'private-alternate-bot',
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ botId: 'alternate-bot' }),
    );
  });

  it('fails closed when an editor loses access during delayed media preparation', async () => {
    let releaseUpload!: () => void;
    const uploadBlocked = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let httpSends = 0;
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
      uploadImage: async () => {
        await uploadBlocked;
        return { token: 'prepared-image' };
      },
      send: async () => {
        httpSends += 1;
        return { messageId: 'must-not-send', url: null };
      },
    });
    const delivery = (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-editor-removed-during-prep-1',
      'channel-1',
      actor,
      {
        text: '',
        images: [{ base64: Buffer.from('image').toString('base64'), mimeType: 'image/png' }],
      },
    );
    while (harness.maxClient.uploadImage.mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    harness.maxClient.getChatMembersAccess.mockResolvedValue(
      new Map([
        ['admin-1', { userId: 'admin-1', isAdmin: false, isOwner: false, permissions: [] }],
      ]),
    );
    releaseUpload();

    const result = await delivery;

    expect(httpSends).toBe(0);
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-editor-removed-during-prep-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: true,
        lastErrorCode: 'suggestion.delivery.editor_removed',
      }),
    ]);
    expect(result.suggestionDelivery.state).toBe('no_reachable_editor');
  });

  it('durably classifies permanent shared content preparation failures', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
    });
    (harness.service as any).resolveChannelTitle.mockRejectedValueOnce(
      new Error('invalid channel title payload'),
    );

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-shared-prep-1',
      'channel-1',
      actor,
      { text: 'Не удалось подготовить' },
    );

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-shared-prep-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: true,
        lastErrorCode: 'suggestion.delivery.preclaim_failed',
      }),
    ]);
    expect(result.suggestionDelivery.state).toBe('uncertain');
    expect(harness.maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('recovers automatically after an empty actionable fleet becomes available', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
    });
    harness.maxBotRegistry.getActionableBots
      .mockReturnValueOnce([])
      .mockReturnValue([
        { id: 'assist-bot' },
        { id: 'alternate-bot' },
        { id: 'third-bot' },
        { id: 'source-bot' },
      ]);

    const first = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-fleet-recovery-1',
      'channel-1',
      actor,
      { text: 'Дождаться рабочего бота' },
    );
    expect(first.suggestionDelivery.state).toBe('queued');
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-fleet-recovery-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: false,
        lastErrorCode: 'suggestion.delivery.no_actionable_bot',
      }),
    ]);

    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-fleet-recovery-1',
      'channel-1',
      actor,
      { text: 'Дождаться рабочего бота' },
    );
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-fleet-recovery-1' },
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'SENT' })]);
  });

  it('does not mark a lease-renewal timeout ambiguous after a definitive retry', async () => {
    let sendAttempts = 0;
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
      send: async () => {
        sendAttempts += 1;
        throw { response: { status: 429, data: { code: 'rate.limit' } } };
      },
    });
    jest.spyOn(harness.service as any, 'sleep').mockResolvedValue(undefined);
    const updateMany = harness.prisma.channelSuggestionAdminDelivery.updateMany as jest.Mock;
    const originalUpdateMany = updateMany.getMockImplementation()!;
    let dispatchStarts = 0;
    updateMany.mockImplementation(async (args: { data?: { lastErrorCode?: string } }) => {
      if (args.data?.lastErrorCode === 'suggestion.delivery.dispatch_started') {
        dispatchStarts += 1;
        if (dispatchStarts === 2) {
          throw new Error('database timeout while renewing delivery lease');
        }
      }
      return originalUpdateMany(args);
    });

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-renewal-timeout-1',
      'channel-1',
      actor,
      { text: 'Не считать отправленным' },
    );

    expect(sendAttempts).toBe(1);
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-renewal-timeout-1' },
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'FAILED', terminal: false })]);
    expect(result.suggestionDelivery.state).toBe('queued');
  });

  it('persists a confirmed MAX send without another HTTP attempt after a DB finalization error', async () => {
    let httpSends = 0;
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
      send: async () => {
        httpSends += 1;
        return { messageId: 'confirmed-message-1', chatId: 'private-assist', url: null };
      },
    });
    const updateMany = harness.prisma.channelSuggestionAdminDelivery.updateMany as jest.Mock;
    const originalUpdateMany = updateMany.getMockImplementation()!;
    let failedStrictFinalize = false;
    updateMany.mockImplementation(
      async (args: { where?: { lockToken?: string }; data?: { status?: string } }) => {
        if (!failedStrictFinalize && args.where?.lockToken && args.data?.status === 'SENT') {
          failedStrictFinalize = true;
          throw Object.assign(new Error('database connection lost after MAX response'), {
            code: 'P1001',
          });
        }
        return originalUpdateMany(args);
      },
    );

    await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-finalize-recovery-1',
      'channel-1',
      actor,
      { text: 'Отправить один раз' },
    );

    expect(httpSends).toBe(1);
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-finalize-recovery-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'SENT',
        remoteMessageId: 'confirmed-message-1',
      }),
    ]);
  });

  it('keeps a confirmed send fenced until stale recovery when every DB finalize write fails', async () => {
    let httpSends = 0;
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
      send: async () => {
        httpSends += 1;
        return { messageId: 'confirmed-message-2', chatId: 'private-assist', url: null };
      },
    });
    const updateMany = harness.prisma.channelSuggestionAdminDelivery.updateMany as jest.Mock;
    const originalUpdateMany = updateMany.getMockImplementation()!;
    updateMany.mockImplementation(async (args: { data?: { status?: string } }) => {
      if (args.data?.status === 'SENT') {
        throw Object.assign(new Error('database unavailable after MAX response'), {
          code: 'P1001',
        });
      }
      return originalUpdateMany(args);
    });

    await expect(
      (harness.service as any).deliverSuggestionToAdminPrivates(
        'suggestion-finalize-fenced-1',
        'channel-1',
        actor,
        { text: 'Не дублировать подтвержденную отправку' },
      ),
    ).rejects.toMatchObject({ code: 'P1001' });

    expect(httpSends).toBe(1);
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-finalize-fenced-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'SENDING',
        lastErrorCode: 'suggestion.delivery.dispatch_started',
      }),
    ]);

    await (harness.service as any).reconcileStaleChannelSuggestionAdminDeliveries(
      'suggestion-finalize-fenced-1',
      new Date(Date.now() + 60_000),
    );
    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-finalize-fenced-1' },
      }),
    ).resolves.toEqual([expect.objectContaining({ status: 'AMBIGUOUS' })]);
    expect(httpSends).toBe(1);
  });

  it('keeps exhausted attachment-not-ready sends retryable instead of changing dialogs', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
      send: async () => {
        throw {
          response: {
            status: 404,
            data: { code: 'attachment.not.ready', message: 'attachment.not.ready' },
          },
        };
      },
    });
    jest.spyOn(harness.service as any, 'sleep').mockResolvedValue(undefined);

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-attachment-retry-1',
      'channel-1',
      actor,
      { text: 'Повторить вложение' },
    );

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-attachment-retry-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'FAILED',
        terminal: false,
        lastErrorCode: 'attachment.not.ready',
      }),
    ]);
    expect(result.suggestionDelivery.state).toBe('queued');
  });

  it('keeps an exhausted definitive 429 send retryable rather than ambiguous', async () => {
    const harness = createRoutingHarness({
      routeLookup: (botId) => (botId === 'assist-bot' ? 'private-assist' : null),
      send: async () => {
        throw { response: { status: 429, data: { code: 'rate.limit' } } };
      },
    });
    jest.spyOn(harness.service as any, 'sleep').mockResolvedValue(undefined);

    const result = await (harness.service as any).deliverSuggestionToAdminPrivates(
      'suggestion-definitive-429-1',
      'channel-1',
      actor,
      { text: 'Повторить после лимита' },
    );

    await expect(
      harness.prisma.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: 'suggestion-definitive-429-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'FAILED', terminal: false, lastStatusCode: 429 }),
    ]);
    expect(result.suggestionDelivery.state).toBe('queued');
  });
});
