import { channelSettingsSchema } from '@maxim/contracts';

import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import type { MaxRoutedPublicationRequest } from '../max/max-routed-publication.service';
import {
  AdminChannelSuggestionPublicationRuntime,
  type AdminChannelSuggestionPublicationRuntimeContext,
} from './admin-channel-suggestion-publication-runtime';
import {
  CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
  CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
  type ChannelSuggestionPublicationContextV1,
  withChannelSuggestionPublicationContextDigest,
} from './admin-channel-suggestion-publication-protocol';
import { createPrismaMock, extractSqlText } from './admin-service-test-support';
import {
  readPublisherPreparedDialogContext,
  type PublisherPreparedDialogContext,
} from './publisher-dialog-context.service';

const reviewer = {
  userId: 'admin-1',
  username: 'chief',
  displayName: 'Главный редактор',
  chatTitle: null,
};

function createPublisherDialogContext(
  overrides: Partial<PublisherPreparedDialogContext> = {},
): PublisherPreparedDialogContext {
  return {
    version: 1,
    dialogBotId: 'main-dialog-bot',
    buttons: [
      [
        {
          type: 'link',
          text: 'Комментарии · 0',
          url: 'https://max.ru/main-entry?startapp=comments',
        },
      ],
    ],
    reference: {
      entityType: 'channel',
      threadId: 'publisher-thread-1',
      includeCommentsButton: true,
      includeSuggestButton: false,
      suggestButtonText: null,
      customButtons: [],
      suggestionEntryMode: 'BOT',
      botId: null,
      dialogBotId: 'main-dialog-bot',
    },
    ...overrides,
  };
}

function createVersionedPublishingPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'suggest',
    actorUserId: 'user-1',
    text: 'Проверенная предложка',
    reviewStatus: 'publishing',
    reviewAction: 'publish',
    reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    reviewPublicationLedgerJobId: 'channel-suggestion:publish:v1:suggestion-1',
    reviewClaimToken: 'claim-token-1',
    reviewClaimedAt: '2026-08-20T10:00:00.000Z',
    reviewClaimedByUserId: 'admin-1',
    reviewClaimedByDisplayName: 'Главный редактор',
    ...overrides,
  };
}

function createPersistedContext(
  overrides: Partial<Omit<ChannelSuggestionPublicationContextV1, 'contextDigest'>> = {},
) {
  const base: Omit<ChannelSuggestionPublicationContextV1, 'contextDigest'> = {
    protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    preparedAt: '2026-08-20T10:01:00.000Z',
    messageDigest: 'b'.repeat(64),
    botId: 'bot-1',
    threadId: null,
    buttons: [],
    includeCommentsButton: false,
    includeSuggestButton: false,
    suggestButtonText: null,
    suggestionEntryMode: 'BOT',
    authorAttribution: {
      userId: 'user-1',
      displayName: 'Автор',
      mentionDisplayName: 'Автор',
      username: null,
      profileUrl: null,
    },
  };
  return withChannelSuggestionPublicationContextDigest({
    ...base,
    ...overrides,
  });
}

function createCompletedLedger(
  context: ReturnType<typeof createPersistedContext>,
  bindingOverrides: Record<string, unknown> = {},
) {
  return {
    jobId: 'channel-suggestion:publish:v1:suggestion-1',
    actionType: 'SEND_MESSAGE',
    chatId: 'channel-1',
    sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
    status: 'SUCCEEDED',
    ambiguous: false,
    terminal: true,
    dispatchToken: 'dispatch-token-1',
    dispatchStartedAt: new Date('2026-08-20T10:01:00.000Z'),
    dispatchBotId: context.botId,
    remoteMessageId: 'mid-recovered-1',
    metadata: {
      ledgerContext: {
        suggestionId: 'suggestion-1',
        publicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
        claimToken: 'claim-token-1',
        actorUserId: 'user-1',
        messageDigest: context.messageDigest,
        contextDigest: context.contextDigest,
        ...bindingOverrides,
      },
    },
  };
}

function createHarness(
  options: {
    payload?: Record<string, unknown>;
    ledger?: Record<string, unknown> | null;
    images?: Array<Record<string, unknown>>;
  } = {},
) {
  const prisma = createPrismaMock();
  const payload = options.payload ?? {
    type: 'suggest',
    actorUserId: 'user-1',
    text: 'Проверенная предложка',
    reviewStatus: 'pending',
  };
  prisma.auditLog.findFirst.mockResolvedValue({
    id: 'suggestion-1',
    chatId: 'channel-1',
    actorUserId: 'user-1',
    payload,
  });
  prisma.maxActionLedgerEntry.findUnique.mockResolvedValue(options.ledger ?? null);

  const maxRoutedPublicationService = {
    publish: jest.fn().mockImplementation(async (request: any) => {
      const prepared = await request.prepareAttempt({ botId: 'bot-1', job: {} });
      expect(prepared.options.marketplacePublication).toEqual({
        purpose: 'APPROVED_SUGGESTION',
        entityId: request.entityId,
      });
      await request.beforeSendMutation({
        botId: 'bot-1',
        job: { text: prepared.text, options: prepared.options },
      });
      return {
        messageId: 'mid-1',
        url: 'https://max.ru/chats/channel-1/message/mid-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 1,
      };
    }),
  };
  const maxClient = {
    resolveMessageLink: jest
      .fn()
      .mockResolvedValue('https://max.ru/chats/channel-1/message/mid-recovered-1'),
    sendMessageImmediateWithResolvedLink: jest.fn(),
  };
  const publisherDialogContextService = {
    prepare: jest.fn().mockResolvedValue(createPublisherDialogContext()),
    read: jest.fn((value: unknown, dialogBotId: string) =>
      readPublisherPreparedDialogContext(value, dialogBotId),
    ),
  };
  const context: AdminChannelSuggestionPublicationRuntimeContext = {
    logger: { warn: jest.fn() } as never,
    prisma: prisma as never,
    maxClient: maxClient as never,
    maxRoutedPublicationService: maxRoutedPublicationService as never,
    channelSuggestionImageRuntime: {
      loadStoredImages: jest.fn().mockResolvedValue(options.images ?? []),
    } as never,
    publisherDialogContextService: publisherDialogContextService as never,
    assertChatAdmin: jest.fn().mockResolvedValue(undefined),
    ensureEntityType: jest.fn().mockResolvedValue(undefined),
    resolveChannelSuggestionPublicationBotAssignment: jest.fn().mockResolvedValue({
      botId: 'bot-1',
      routeResolved: true,
      candidateBotIds: ['bot-1', 'bot-2'],
    }),
    resolveDeliveryBotAssignment: jest.fn().mockResolvedValue('bot-1'),
    resolveChannelSuggestionAuthorAttribution: jest.fn().mockResolvedValue({
      userId: 'user-1',
      displayName: 'Автор',
      mentionDisplayName: 'Автор',
      username: null,
      profileUrl: null,
    }),
    resolveChannelSuggestionAttachments: jest
      .fn()
      .mockImplementation(async ({ images }) =>
        images?.[0] ? { imagePayload: images[0].payload ?? { token: 'uploaded-image-token' } } : {},
      ),
    getPublicChannelSettings: jest.fn().mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: false,
        postSuggestionsEnabled: false,
      }),
    ),
    buildChannelDialogButton: jest.fn(),
    syncChannelSuggestionAdminReviewMessages: jest.fn(),
    readObjectPayload: (value) => value as Record<string, unknown>,
    readObjectPayloadOrNull: (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    readLowerString: (value) =>
      typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null,
    readTrimmedString: (value) => (typeof value === 'string' && value.trim() ? value.trim() : null),
    readRawString: (value) => (typeof value === 'string' ? value : null),
    readChannelSuggestionMediaType: (value) =>
      value === 'image' || value === 'video' ? value : null,
    readChannelSuggestionTextMarkup: () => [],
    readStoredChannelSuggestionActor: (actorUserId) => ({ userId: actorUserId }),
    normalizeBroadcastTextFormat: (value) => (value === 'markdown' ? 'markdown' : 'plain'),
    sleep: jest.fn(),
  };

  return {
    context,
    maxClient,
    maxRoutedPublicationService,
    prisma,
    publisherDialogContextService,
    runtime: new AdminChannelSuggestionPublicationRuntime(context),
  };
}

describe('AdminChannelSuggestionPublicationRuntime', () => {
  it('prepares the accepted edited body for Major dispatch instead of the original payload', async () => {
    const { maxRoutedPublicationService, runtime } = createHarness();
    const dispatch = maxRoutedPublicationService.publish.getMockImplementation()!;
    let outgoingText: string | undefined;
    let outgoingFormat: string | undefined;
    maxRoutedPublicationService.publish.mockImplementation(
      async (request: MaxRoutedPublicationRequest) => {
        const prepare = request.prepareAttempt!;
        return dispatch({
          ...request,
          prepareAttempt: async (attempt: Parameters<typeof prepare>[0]) => {
            const prepared = await prepare(attempt);
            outgoingText = prepared.text;
            outgoingFormat = prepared.options?.textFormat;
            return prepared;
          },
        });
      },
    );
    await runtime.review('suggestion-1', reviewer, 'publish', {
      expectedRevision: 0,
      requestId: 'ab4f3c9d-1a5b-4c35-8c60-7f56bf8ec4e4',
      text: '  **Цена** 500 ₽\n\n',
    });
    expect(outgoingText).toContain('&nbsp;&nbsp;<strong>Цена</strong> 500 ₽\n\n');
    expect(outgoingFormat).toBe('html');
    expect(outgoingText).not.toContain('Проверенная предложка');
  });

  it('keeps Major suggestions on the Major route when the Publisher module is enabled', async () => {
    const { context, maxRoutedPublicationService, prisma, publisherDialogContextService, runtime } =
      createHarness();
    (prisma as any).publisherEntitySettings = {
      findUnique: jest.fn().mockResolvedValue({ channelSuggestionsEnabled: true }),
    };
    const enqueue = jest.fn().mockResolvedValue(undefined);
    (context as any).publisherSuggestionPublicationQueue = { enqueue };
    const assertEntityReady = jest.fn();
    (context as any).publisherReadinessService = { assertEntityReady };

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).resolves.toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/mid-1',
    });

    expect(enqueue).not.toHaveBeenCalled();
    expect(assertEntityReady).not.toHaveBeenCalled();
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
    expect(publisherDialogContextService.prepare).not.toHaveBeenCalled();
    const claimSql = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(claimSql).not.toContain('PUBLIK_V1');
  });

  it('publishes a queued suggestion through the immutable Publik route and main dialog bot', async () => {
    const persistedDialogContext = createPublisherDialogContext();
    const payload = createVersionedPublishingPayload({
      reviewDispatchProfile: 'PUBLIK_V1',
      reviewRequiredBotId: 'publisher-bot',
      reviewPolicyRevision: 7,
      reviewDialogBotId: 'main-dialog-bot',
      reviewPublisherDialogContext: persistedDialogContext,
    });
    const { context, maxRoutedPublicationService, prisma, publisherDialogContextService, runtime } =
      createHarness({ payload });
    (context as any).publisherRuntimeBoundaryService = {
      assertDispatchEnabled: jest.fn(),
    };
    (context as any).publisherDispatchHealthService = {
      assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      recordSendSuccess: jest.fn().mockResolvedValue(undefined),
      recordSendFailure: jest.fn().mockResolvedValue('transient'),
    };
    (context as any).publisherReadinessService = {
      assertEntityReady: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        entityType: 'channel',
        requiredBotId: 'publisher-bot',
        policyRevision: 8,
      }),
    };
    (context.getPublicChannelSettings as jest.Mock).mockResolvedValue(
      channelSettingsSchema.parse({ commentsEnabled: true, postSuggestionsEnabled: false }),
    );
    (context.buildChannelDialogButton as jest.Mock).mockReturnValue({
      type: 'link',
      text: 'Комментарии · 0',
      url: 'https://max.ru/main-entry?startapp=comments',
    });
    maxRoutedPublicationService.publish.mockImplementation(async (request: any) => {
      const prepared = await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
      expect(prepared.options.marketplacePublication).toEqual({
        purpose: 'APPROVED_SUGGESTION',
        entityId: request.entityId,
      });
      await request.onDispatchAttempt({ botId: 'publisher-bot', job: prepared });
      await request.beforeSendMutation({ botId: 'publisher-bot', job: prepared });
      return {
        messageId: 'publisher-mid-1',
        url: 'https://max.ru/chats/channel-1/message/publisher-mid-1',
        botId: 'publisher-bot',
        candidateBotIds: ['publisher-bot'],
        routingVersion: null,
      };
    });

    await runtime.processPublisherSuggestionPublicationJob('suggestion-1', 'claim-token-1');

    const request = maxRoutedPublicationService.publish.mock.calls[0]?.[0];
    expect(request).toEqual(
      expect.objectContaining({
        publisherExactBotId: 'publisher-bot',
        requiredBotId: 'publisher-bot',
      }),
    );
    expect(context.buildChannelDialogButton).not.toHaveBeenCalled();
    expect(context.getPublicChannelSettings).not.toHaveBeenCalled();
    expect(publisherDialogContextService.read).toHaveBeenCalledWith(
      persistedDialogContext,
      'main-dialog-bot',
    );
    expect(publisherDialogContextService.prepare).not.toHaveBeenCalled();
    expect(context.publisherDispatchHealthService?.recordSendSuccess).toHaveBeenCalledWith(
      'channel-1',
      expect.any(Date),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            botId: 'publisher-bot',
            dialogBotId: 'main-dialog-bot',
          }),
        }),
      }),
    );
  });

  it.each([
    ['malformed', { buttons: [] }],
    ['wrong version', { ...createPublisherDialogContext(), version: 2 }],
    ['dialog bot mismatch', { ...createPublisherDialogContext(), dialogBotId: 'other-main-bot' }],
  ])(
    'rejects a %s persisted publisher dialog context without rebuilding it',
    async (_label, raw) => {
      const payload = createVersionedPublishingPayload({
        reviewDispatchProfile: 'PUBLIK_V1',
        reviewRequiredBotId: 'publisher-bot',
        reviewPolicyRevision: 7,
        reviewDialogBotId: 'main-dialog-bot',
        reviewPublisherDialogContext: raw,
      });
      const { context, maxRoutedPublicationService, publisherDialogContextService, runtime } =
        createHarness({ payload });

      await expect(
        runtime.processPublisherSuggestionPublicationJob('suggestion-1', 'claim-token-1'),
      ).rejects.toThrow('Сохранённый маршрут Публика повреждён');

      expect(publisherDialogContextService.read).toHaveBeenCalledWith(raw, 'main-dialog-bot');
      expect(publisherDialogContextService.prepare).not.toHaveBeenCalled();
      expect(context.getPublicChannelSettings).not.toHaveBeenCalled();
      expect(context.buildChannelDialogButton).not.toHaveBeenCalled();
      expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    },
  );

  it('does not clear a publisher auth pause from a suggestion ledger replay', async () => {
    const payload = createVersionedPublishingPayload({
      reviewDispatchProfile: 'PUBLIK_V1',
      reviewRequiredBotId: 'publisher-bot',
      reviewPolicyRevision: 7,
      reviewDialogBotId: 'main-dialog-bot',
      reviewPublisherDialogContext: createPublisherDialogContext(),
    });
    const { context, maxRoutedPublicationService, runtime } = createHarness({ payload });
    (context as any).publisherRuntimeBoundaryService = { assertDispatchEnabled: jest.fn() };
    (context as any).publisherDispatchHealthService = {
      assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      recordSendSuccess: jest.fn().mockResolvedValue(undefined),
      recordSendFailure: jest.fn().mockResolvedValue('transient'),
    };
    (context as any).publisherReadinessService = {
      assertEntityReady: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        entityType: 'channel',
        requiredBotId: 'publisher-bot',
        policyRevision: 8,
      }),
    };
    maxRoutedPublicationService.publish.mockImplementation(async (request: any) => {
      await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
      return {
        messageId: 'publisher-mid-replayed',
        url: null,
        botId: 'publisher-bot',
        candidateBotIds: ['publisher-bot'],
        routingVersion: null,
      };
    });

    await runtime.processPublisherSuggestionPublicationJob('suggestion-1', 'claim-token-1');

    expect(context.publisherDispatchHealthService?.recordSendSuccess).not.toHaveBeenCalled();
  });

  it('fails closed before claim or send when routed publication is unavailable', async () => {
    const { context, maxClient, prisma, runtime } = createHarness();
    delete (context as { maxRoutedPublicationService?: unknown }).maxRoutedPublicationService;

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).rejects.toThrow(
      'Сервис безопасной публикации временно недоступен',
    );

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('persists the exact prepared context after the ledger fence and before routed send', async () => {
    const { maxRoutedPublicationService, prisma, runtime } = createHarness();

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).resolves.toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/mid-1',
    });

    const request = maxRoutedPublicationService.publish.mock.calls[0]?.[0];
    expect(request.logicalIdempotencyKey).toBe('channel-suggestion:publish:v1:suggestion-1');
    expect(request.sourceTag).toBe(CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG);
    expect(request.preferredBotId).toBe('bot-1');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    const contextSql = extractSqlText(prisma.$executeRaw.mock.calls[1]?.[0]);
    expect(contextSql).toContain('ledger.dispatch_token IS NOT NULL');
    expect(contextSql).toContain("'reviewPublicationContext'");
    expect(contextSql).toContain('"protocol":"max_action_ledger_v1"');
    const finalizeSql = extractSqlText(prisma.$executeRaw.mock.calls[2]?.[0]);
    expect(finalizeSql).toContain("payload->'reviewPublicationContext'->>'messageDigest'");
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
  });

  it('pins bot-scoped media to the proven token owner', async () => {
    const { maxRoutedPublicationService, prisma, runtime } = createHarness({
      payload: {
        type: 'suggest',
        actorUserId: 'user-1',
        text: 'Видео',
        mediaType: 'video',
        mediaPayload: { token: 'video-token-1' },
        reviewStatus: 'pending',
      },
      images: [{ payload: { token: 'video-token-1' } }],
    });
    prisma.channelSuggestionAdminDelivery.findMany.mockResolvedValue([{ botId: 'bot-1' }] as never);

    await runtime.review('suggestion-1', reviewer, 'publish');

    expect(maxRoutedPublicationService.publish.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ preferredBotId: 'bot-1', requiredBotId: 'bot-1' }),
    );
  });

  it('finalizes a completed ledger without calling routed publication again', async () => {
    const context = createPersistedContext();
    const { maxClient, maxRoutedPublicationService, prisma, runtime } = createHarness({
      payload: createVersionedPublishingPayload({ reviewPublicationContext: context }),
      ledger: createCompletedLedger(context),
    });

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).resolves.toEqual({
      status: 'reviewed',
      reviewStatus: 'published',
      publishedUrl: 'https://max.ru/chats/channel-1/message/mid-recovered-1',
    });

    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith(
      'mid-recovered-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0])).toContain(
      'ledger.remote_message_id',
    );
  });

  it('releases a stale versioned no-ledger claim under lock, then starts one new claim', async () => {
    const payload = createVersionedPublishingPayload({
      reviewClaimedAt: '2026-08-20T00:00:00.000Z',
    });
    const { maxRoutedPublicationService, prisma, runtime } = createHarness({ payload });
    prisma.$queryRaw.mockResolvedValue([{ id: 'suggestion-1', payload }]);

    await runtime.review('suggestion-1', reviewer, 'publish');

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const releaseSql = extractSqlText(prisma.$executeRaw.mock.calls[0]?.[0]);
    expect(releaseSql).toContain('stale versioned pre-dispatch claim recovered');
    const nextClaimSql = extractSqlText(prisma.$executeRaw.mock.calls[1]?.[0]);
    expect(nextClaimSql).toContain("'reviewClaimToken'");
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
  });

  it('does not release a stale claim when the safe-ledger delete loses a fence race', async () => {
    const payload = createVersionedPublishingPayload({
      reviewClaimedAt: '2026-08-20T00:00:00.000Z',
    });
    const safeLedger = {
      jobId: 'channel-suggestion:publish:v1:suggestion-1',
      actionType: 'SEND_MESSAGE',
      chatId: 'channel-1',
      sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      status: 'IN_PROGRESS',
      ambiguous: false,
      terminal: false,
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    };
    const { maxRoutedPublicationService, prisma, runtime } = createHarness({
      payload,
      ledger: safeLedger,
    });
    prisma.$queryRaw.mockResolvedValue([{ id: 'suggestion-1', payload }]);
    prisma.maxActionLedgerEntry.deleteMany.mockResolvedValue({ count: 0 });

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).resolves.toEqual({
      status: 'review_in_progress',
      reviewStatus: 'processing',
      publishedUrl: null,
    });

    expect(prisma.maxActionLedgerEntry.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dispatchToken: null,
          dispatchStartedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
        }),
      }),
    );
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
  });

  it('stops before MAX when the final pre-send context CAS loses the claim race', async () => {
    const { maxRoutedPublicationService, prisma, runtime } = createHarness();
    prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).rejects.toThrow(
      'Состояние предложки изменилось перед отправкой',
    );

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not create auto-attach when the post-send finalization CAS loses', async () => {
    const { context, prisma, runtime } = createHarness();
    (context.getPublicChannelSettings as jest.Mock).mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
        postSuggestionsEnabled: false,
      }),
    );
    (context.buildChannelDialogButton as jest.Mock).mockReturnValue({
      type: 'link',
      text: 'Комментарии · 0',
      url: 'https://max.ru/app/comments',
    });
    prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).resolves.toEqual({
      status: 'review_in_progress',
      reviewStatus: 'processing',
      publishedUrl: null,
    });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('retries a definitive attachment-not-ready 400 with the same ledger key', async () => {
    const { context, maxRoutedPublicationService, prisma, runtime } = createHarness({
      images: [{ base64: 'aW1hZ2U=', mimeType: 'image/jpeg' }],
    });
    const notReady = Object.assign(new Error('attachment.not.ready'), {
      response: { status: 400, data: { code: 'attachment.not.ready' } },
    });
    const runAttempt = async (request: any, result: 'fail' | 'success') => {
      const prepared = await request.prepareAttempt({ botId: 'bot-1', job: {} });
      await request.beforeSendMutation({ botId: 'bot-1', job: prepared });
      if (result === 'fail') {
        throw notReady;
      }
      return {
        messageId: 'mid-after-ready',
        url: null,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 1,
      };
    };
    maxRoutedPublicationService.publish
      .mockImplementationOnce((request: any) => runAttempt(request, 'fail'))
      .mockImplementationOnce((request: any) => runAttempt(request, 'success'));

    await runtime.review('suggestion-1', reviewer, 'publish');

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(2);
    expect(maxRoutedPublicationService.publish.mock.calls[0]?.[0].logicalIdempotencyKey).toBe(
      maxRoutedPublicationService.publish.mock.calls[1]?.[0].logicalIdempotencyKey,
    );
    expect(context.sleep).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
  });

  it('rechecks claimant admin access at the final boundary before persisting context', async () => {
    const { context, maxRoutedPublicationService, prisma, runtime } = createHarness();
    const accessLost = new Error('Пользователь больше не администратор');
    (context.assertChatAdmin as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(accessLost);

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).rejects.toBe(accessLost);

    expect(context.assertChatAdmin).toHaveBeenNthCalledWith(1, 'channel-1', 'admin-1', 'channel');
    expect(context.assertChatAdmin).toHaveBeenNthCalledWith(2, 'channel-1', 'admin-1', 'channel');
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rechecks claimant access again before a retried attachment send', async () => {
    const { context, maxRoutedPublicationService, prisma, runtime } = createHarness({
      images: [{ base64: 'aW1hZ2U=', mimeType: 'image/jpeg' }],
    });
    const notReady = Object.assign(new Error('attachment.not.ready'), {
      response: { status: 400, data: { code: 'attachment.not.ready' } },
    });
    const accessLost = new Error('Права администратора отозваны');
    (context.assertChatAdmin as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(accessLost);
    let httpAttempts = 0;
    const runAttempt = async (request: any, failAfterGuard: boolean) => {
      const prepared = await request.prepareAttempt({ botId: 'bot-1', job: {} });
      await request.beforeSendMutation({ botId: 'bot-1', job: prepared });
      httpAttempts += 1;
      if (failAfterGuard) {
        throw notReady;
      }
      return {
        messageId: 'must-not-send',
        url: null,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 1,
      };
    };
    maxRoutedPublicationService.publish
      .mockImplementationOnce((request: any) => runAttempt(request, true))
      .mockImplementationOnce((request: any) => runAttempt(request, false));

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).rejects.toBe(accessLost);

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(2);
    expect(context.assertChatAdmin).toHaveBeenCalledTimes(3);
    expect(context.sleep).toHaveBeenCalledTimes(1);
    expect(httpAttempts).toBe(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'context digest',
      build: () => {
        const context = createPersistedContext();
        return {
          payload: createVersionedPublishingPayload({
            reviewPublicationContext: { ...context, contextDigest: 'f'.repeat(64) },
          }),
          ledger: createCompletedLedger(context),
        };
      },
    },
    {
      name: 'thread',
      build: () => {
        const context = createPersistedContext();
        return {
          payload: createVersionedPublishingPayload({
            reviewPublicationContext: { ...context, threadId: 'tampered-thread' },
          }),
          ledger: createCompletedLedger(context),
        };
      },
    },
    {
      name: 'buttons',
      build: () => {
        const context = createPersistedContext();
        return {
          payload: createVersionedPublishingPayload({
            reviewPublicationContext: {
              ...context,
              buttons: [[{ type: 'link', text: 'Подмена', url: 'https://max.ru/other' }]],
            },
          }),
          ledger: createCompletedLedger(context),
        };
      },
    },
    {
      name: 'claim token',
      build: () => {
        const context = createPersistedContext();
        return {
          payload: createVersionedPublishingPayload({
            reviewClaimToken: 'tampered-claim',
            reviewPublicationContext: context,
          }),
          ledger: createCompletedLedger(context),
        };
      },
    },
    {
      name: 'immutable actor',
      build: () => {
        const context = createPersistedContext({
          authorAttribution: {
            userId: 'other-user',
            displayName: 'Другой автор',
            mentionDisplayName: 'Другой автор',
            username: null,
            profileUrl: null,
          },
        });
        return {
          payload: createVersionedPublishingPayload({ reviewPublicationContext: context }),
          ledger: createCompletedLedger(context, { actorUserId: 'other-user' }),
        };
      },
    },
  ])('keeps a completed publication with tampered $name manual-only', async ({ build }) => {
    const { payload, ledger } = build();
    const { maxClient, maxRoutedPublicationService, prisma, runtime } = createHarness({
      payload,
      ledger,
    });

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).rejects.toThrow(
      'требует проверки',
    );

    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(maxClient.resolveMessageLink).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'legacy claim',
      payload: {
        type: 'suggest',
        reviewStatus: 'publishing',
        reviewAction: 'publish',
        reviewClaimedAt: '2026-08-17T00:00:00.000Z',
        reviewClaimedByUserId: 'admin-1',
      },
      ledger: null,
    },
    {
      name: 'retained dispatch fence',
      payload: createVersionedPublishingPayload({
        reviewClaimedAt: '2026-08-17T00:00:00.000Z',
      }),
      ledger: {
        jobId: 'channel-suggestion:publish:v1:suggestion-1',
        actionType: 'SEND_MESSAGE',
        chatId: 'channel-1',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
        status: 'IN_PROGRESS',
        ambiguous: false,
        terminal: false,
        dispatchToken: 'dispatch-token-1',
        dispatchStartedAt: new Date('2026-08-17T00:01:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: null,
      },
    },
  ])('keeps $name manual-only without a resend', async ({ payload, ledger }) => {
    const { maxRoutedPublicationService, prisma, runtime } = createHarness({
      payload,
      ledger,
    });

    await expect(runtime.review('suggestion-1', reviewer, 'publish')).rejects.toThrow(
      'требует проверки',
    );

    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('releases its just-failed pre-dispatch claim without making the user wait fifteen minutes', async () => {
    const { context, maxRoutedPublicationService, prisma, runtime } = createHarness();
    const error = new Error('route unavailable');
    (context.resolveChannelSuggestionPublicationBotAssignment as jest.Mock).mockRejectedValue(
      error,
    );
    prisma.$queryRaw.mockImplementation(async () => {
      const claimSql = prisma.$executeRaw.mock.calls[0]?.[0] as { values: unknown[] };
      const [contentPatch, claimedAt, userId, label, token, protocol, jobId] = claimSql.values;
      expect(contentPatch).toBe('{}');
      return [
        {
          id: 'suggestion-1',
          actorUserId: 'user-1',
          payload: createVersionedPublishingPayload({
            reviewClaimedAt: claimedAt,
            reviewClaimedByUserId: userId,
            reviewClaimedByDisplayName: label,
            reviewClaimToken: token,
            reviewPublicationProtocol: protocol,
            reviewPublicationLedgerJobId: jobId,
          }),
        },
      ];
    });
    await expect(runtime.review('suggestion-1', reviewer, 'publish')).rejects.toBe(error);
    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(extractSqlText(prisma.$executeRaw.mock.calls[1]?.[0])).toContain(
      "'reviewStatus', 'pending'",
    );
    expect(extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0])).not.toContain(
      "reviewClaimedAt' <=",
    );
  });

  it.each(['publish', 'cancel'] as const)(
    'does not undo a committed %s when admin card sync fails',
    async (action) => {
      const { context, runtime } = createHarness();
      (context.syncChannelSuggestionAdminReviewMessages as jest.Mock).mockRejectedValue(
        new Error('database unavailable'),
      );
      await expect(runtime.review('suggestion-1', reviewer, action)).resolves.toMatchObject({
        status: 'reviewed',
        reviewStatus: action === 'publish' ? 'published' : 'cancelled',
      });
    },
  );

  it('retries terminal card synchronization without republishing the suggestion', async () => {
    const { context, maxRoutedPublicationService, runtime } = createHarness({
      payload: {
        type: 'suggest',
        reviewStatus: 'published',
        publishedUrl: 'https://max.ru/post',
      },
    });
    await expect(runtime.review('suggestion-1', reviewer, 'publish')).resolves.toMatchObject({
      status: 'already_reviewed',
    });
    expect(context.syncChannelSuggestionAdminReviewMessages).toHaveBeenCalledTimes(1);
    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
  });
});
