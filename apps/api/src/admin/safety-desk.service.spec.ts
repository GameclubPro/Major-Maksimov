import { BadRequestException } from '@nestjs/common';
import {
  ChannelPostSignaturePresentation,
  ChatEntityType,
  VkParsingOwnerProfile,
} from '../prisma/prisma-client';
import { SafetyDeskService } from './safety-desk.service';

function createReviewPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    sourceId: 'source-1',
    chatId: 'channel-1',
    ownerProfile: VkParsingOwnerProfile.PUBLISHER,
    ownerBotId: 'publisher-bot',
    vkOwnerId: -36819802,
    vkPostId: 101,
    vkPublishedAt: new Date('2026-06-27T10:00:00.000Z'),
    text: 'Проверяем публикацию\nhttps://example.com/post',
    textFormat: 'plain',
    manualContentEditedAt: null,
    url: 'https://vk.ru/wall-36819802_101',
    photoUrls: ['https://cdn.example.com/photo.jpg'],
    videoUrls: [],
    linkUrls: ['https://example.com/post'],
    attachments: [],
    attachmentTypes: ['photo'],
    unsupportedAttachments: [],
    hasUnsupportedAttachments: false,
    isAdvertising: false,
    advertisingMarkers: [],
    raw: {},
    contentHash: 'content-hash',
    publishedContentHash: null,
    status: 'NEW',
    publishedMessageId: null,
    publishedUrl: null,
    publishedAtMax: null,
    autoPublishedAt: null,
    autoPublishError: null,
    skippedAt: null,
    skipReason: null,
    lastSeenAt: new Date('2026-06-27T10:00:00.000Z'),
    missingSinceAt: null,
    missingSeenCount: 0,
    lastAvailabilityCheckedAt: null,
    unavailableAt: null,
    publishQueuedAt: null,
    publishScheduledAt: null,
    publishCancelledAt: null,
    publishCancelledByUserId: null,
    publishLockedAt: null,
    publishAttemptCount: 0,
    publishIdempotencyKey: null,
    publishReason: null,
    lastError: null,
    createdAt: new Date('2026-06-27T10:00:00.000Z'),
    updatedAt: new Date('2026-06-27T10:05:00.000Z'),
    chat: {
      title: 'Канал администраторов',
      entityType: ChatEntityType.CHANNEL,
      vkParsingSettings: [],
      channelSettings: null,
    },
    source: {
      id: 'source-1',
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      title: 'Источник MAXIM',
      url: 'https://vk.ru/source',
      status: 'ACTIVE',
      publishMode: 'REVIEW',
    },
    ...overrides,
  };
}

function createDeleteIntent(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'delete-intent-1',
    chatId: 'channel-1',
    messageId: 'message-1',
    subjectUserId: 'user-1',
    entityType: ChatEntityType.CHANNEL,
    originBotId: 'bot-1',
    routingPolicy: 'origin_only',
    messageAuthorKind: 'user',
    status: 'WAITING_CAPABILITY',
    executeAt: new Date(now - 20_000),
    nextAttemptAt: new Date(now - 10_000),
    retryUntilAt: new Date(now + 60_000),
    attemptCount: 2,
    lastBotId: 'bot-1',
    succeededBotId: null,
    lastStatusCode: 403,
    lastErrorCode: 'access.denied',
    lastError: 'Forbidden',
    firstAttemptAt: new Date(now - 18_000),
    lastAttemptAt: new Date(now - 12_000),
    completedAt: null,
    leaseExpiresAt: null,
    deleteDispatchStartedAt: null,
    deleteDispatchStartedBotId: null,
    remoteDeleteSucceededAt: null,
    remoteDeleteSucceededBotId: null,
    createdAt: new Date(now - 30_000),
    updatedAt: new Date(now - 10_000),
    chat: {
      title: 'Канал администраторов',
      entityType: ChatEntityType.CHANNEL,
      routingState: 'READY',
      botMemberships: [
        {
          botId: 'bot-1',
          role: 'PRIMARY',
          permissionsSnapshot: {
            checkedAt: new Date(now - 5_000).toISOString(),
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'write'],
          },
          botAccessState: 'CONFIRMED_ADMIN',
          botAccessCheckedAt: new Date(now - 5_000),
          botAccessExpiresAt: new Date(now + 60_000),
        },
        {
          botId: 'bot-draining',
          role: 'STANDBY',
          permissionsSnapshot: {
            checkedAt: new Date(now - 5_000).toISOString(),
            isAdmin: true,
            isOwner: false,
            permissions: ['read_all_messages', 'delete'],
          },
          botAccessState: 'CONFIRMED_ADMIN',
          botAccessCheckedAt: new Date(now - 5_000),
          botAccessExpiresAt: new Date(now + 60_000),
        },
      ],
    },
    reasons: [
      {
        reasonKey: 'commercial:message-1',
        ruleCode: 'COMMERCIAL',
        userId: 'user-1',
        score: 0.9,
        createdAt: new Date(now - 30_000),
      },
    ],
    ...overrides,
  };
}

function createGiveawayWinnerNotificationDeadEnd(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'winner-notification-1',
    winnerId: 'winner-1',
    status: 'AMBIGUOUS',
    nextAttemptAt: new Date(now - 20_000),
    attemptCount: 2,
    lockedAt: null,
    dispatchedAt: new Date(now - 18_000),
    botId: 'bot-1',
    lastError: 'MAX send timed out',
    ambiguousAt: new Date(now - 15_000),
    createdAt: new Date(now - 30_000),
    updatedAt: new Date(now - 15_000),
    winner: {
      entry: { userId: 'user-1' },
      giveaway: {
        id: 'giveaway-1',
        title: 'Главный приз',
        sourceChatId: 'channel-1',
      },
    },
    ...overrides,
  };
}

function createFixture() {
  const transaction = jest.fn();
  const prisma = {
    $transaction: transaction,
    $queryRaw: jest.fn().mockResolvedValue([]),
    nightModeTransitionReconcileRequest: {
      findUnique: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    vkParsingPost: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    moderationDeleteIntent: {
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
    moderationDeleteIntentReason: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    channelAutoPostAttachMarker: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 0 },
        _min: { replacementSendStartedAt: null, updatedAt: null },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatAutoCommentAttachMarker: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 0 },
        _min: { replacementSendStartedAt: null },
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatRules: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 0 },
        _min: { publishSendStartedAt: null },
      }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    managedGiveawayResultsSync: { findMany: jest.fn().mockResolvedValue([]) },
    managedGiveawayWinnerNotification: {
      findUnique: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const vkPublishService = {
    publishPost: jest.fn().mockResolvedValue({
      queued: 1,
      post: {},
    }),
  };
  const maxBotRegistry = {
    getBotById: jest.fn((botId: string) => ({
      id: botId,
      state: botId === 'bot-draining' ? 'draining' : 'active',
    })),
  };
  const moderationDeleteIntents = {
    rolloutMode: 'canary',
    replacementCleanupRolloutEnabled: true,
    getRolloutForRuleCodes: jest.fn((chatId: string, ruleCodes: readonly string[]) =>
      chatId === 'channel-1' ||
      ruleCodes.includes('CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP')
        ? 'execute'
        : 'observed',
    ),
    resolveEffectiveRoutingPolicy: jest.fn(
      (intent: {
        entityType: string | null;
        messageAuthorKind: string | null;
        routingPolicy: 'delete_capable' | 'origin_first' | 'origin_only';
        replacementCleanup?: boolean;
      }) => {
        if (
          intent.entityType !== 'CHAT' ||
          intent.messageAuthorKind !== 'user' ||
          !intent.replacementCleanup ||
          intent.routingPolicy === 'origin_only'
        ) {
          return 'origin_only';
        }
        return intent.routingPolicy === 'delete_capable' ? 'delete_capable' : 'origin_first';
      },
    ),
    retryTerminalIntent: jest.fn(),
  };
  const service = new SafetyDeskService(
    prisma as never,
    vkPublishService as never,
    maxBotRegistry as never,
    moderationDeleteIntents as never,
    {
      getPublisherScope: () => ({
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
      }),
    } as never,
  );

  return {
    maxBotRegistry,
    moderationDeleteIntents,
    prisma,
    service,
    vkPublishService,
  };
}

describe('SafetyDeskService', () => {
  it('reports bounded delete runtime diagnostics without treating READY routing as capability', async () => {
    const { prisma, service } = createFixture();
    const oldestOpen = new Date(Date.now() - 30_000);
    const oldestDue = new Date(Date.now() - 5_000);
    prisma.moderationDeleteIntent.groupBy.mockResolvedValue([
      { status: 'WAITING_CAPABILITY', _count: { _all: 3 } },
      { status: 'FAILED_TERMINAL', _count: { _all: 1 } },
      { status: 'SUCCEEDED', _count: { _all: 1 } },
    ]);
    prisma.moderationDeleteIntent.aggregate
      .mockResolvedValueOnce({ _count: { _all: 2 }, _min: { nextAttemptAt: oldestDue } })
      .mockResolvedValueOnce({
        _count: { _all: 1 },
        _min: { leaseExpiresAt: new Date(Date.now() - 2_000) },
      })
      .mockResolvedValueOnce({ _min: { createdAt: oldestOpen } });
    const attentionIntent = createDeleteIntent();
    const completedIntent = createDeleteIntent({
      id: 'delete-intent-succeeded',
      status: 'SUCCEEDED',
      completedAt: new Date(Date.now() - 40_000),
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(Date.now() - 41_000),
      remoteDeleteSucceededBotId: 'bot-1',
      updatedAt: new Date(Date.now() - 40_000),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: null,
    });
    prisma.moderationDeleteIntent.findMany
      .mockResolvedValueOnce([attentionIntent])
      .mockResolvedValueOnce([completedIntent]);
    const ambiguousStartedAt = new Date(Date.now() - 45_000);
    const staleClaimCreatedAt = new Date(Date.now() - 2 * 60 * 60_000);
    const staleClaimUpdatedAt = new Date(Date.now() - 11 * 60_000);
    prisma.channelAutoPostAttachMarker.aggregate
      .mockResolvedValueOnce({
        _count: { _all: 2 },
        _min: { replacementSendStartedAt: ambiguousStartedAt },
      })
      .mockResolvedValueOnce({
        _count: { _all: 1 },
        _min: { updatedAt: staleClaimUpdatedAt },
      });
    prisma.chatAutoCommentAttachMarker.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _min: { replacementSendStartedAt: new Date(Date.now() - 20_000) },
    });
    prisma.channelAutoPostAttachMarker.findMany
      .mockResolvedValueOnce([
        {
          id: 'ambiguous-channel-send-1',
          chatId: 'channel-1',
          messageId: 'message-ambiguous-1',
          botId: 'bot-1',
          replacementSendStartedAt: ambiguousStartedAt,
          lastError: '[max.send_ambiguous] request timed out',
          updatedAt: new Date(Date.now() - 10_000),
          chat: { title: 'Канал администраторов' },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'stale-channel-claim-1',
          chatId: 'channel-2',
          messageId: 'message-stale-claim-1',
          botId: 'bot-2',
          lockedAt: null,
          lastError: 'socket hang up',
          createdAt: staleClaimCreatedAt,
          updatedAt: staleClaimUpdatedAt,
          chat: { title: 'Зависший канал' },
        },
      ]);
    const oldestNotificationDeadEndAt = new Date(Date.now() - 60_000);
    prisma.managedGiveawayWinnerNotification.groupBy.mockResolvedValue([
      {
        status: 'AMBIGUOUS',
        _count: { _all: 1 },
        _min: { updatedAt: oldestNotificationDeadEndAt },
      },
      {
        status: 'FAILED_TERMINAL',
        _count: { _all: 2 },
        _min: { updatedAt: new Date(Date.now() - 30_000) },
      },
    ]);
    prisma.managedGiveawayWinnerNotification.findMany.mockResolvedValue([
      createGiveawayWinnerNotificationDeadEnd({
        lastError: `Authorization: Bearer winner-secret {"token":"json-secret"} https://example.test/send?access_token=query-secret ${'x'.repeat(1_200)}`,
      }),
    ]);

    const overdueAt = new Date(Date.now() - 60_000);
    const nextAt = new Date(Date.now() + 60_000);
    prisma.managedGiveawayResultsSync.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({
        giveawayId: `giveaway-${index}`,
        attempts: 2,
        nextAttemptAt: index === 0 ? overdueAt : nextAt,
        leaseUntil: index === 1 ? nextAt : null,
        giveaway: { title: 'Итоги', sourceChatId: 'chat-1', winners: [] },
      })),
    );
    const runtime = await service.getDeleteRuntime();
    expect(runtime.giveawayPendingResults?.hasMore).toBe(true);
    expect(runtime.giveawayPendingResults?.items).toHaveLength(50);
    expect(runtime.giveawayPendingResults?.items.slice(0, 3).map((row) => row.status)).toEqual([
      'DUE',
      'PROCESSING',
      'WAITING',
    ]);
    expect(runtime.giveawayPendingResults?.items[0]?.overdueMs).toBeGreaterThanOrEqual(60_000);

    expect(runtime).toMatchObject({
      rolloutMode: 'canary',
      replacementCleanupEnabled: true,
      summary: {
        total: 5,
        open: 3,
        failed: 1,
        due: { count: 2, oldestAt: oldestDue.toISOString() },
        staleLeases: { count: 1 },
        ambiguousSends: {
          count: 4,
          oldestAt: staleClaimUpdatedAt.toISOString(),
        },
        giveawayWinnerNotificationDeadEnds: {
          count: 3,
          ambiguous: 1,
          failedTerminal: 2,
          oldestAt: oldestNotificationDeadEndAt.toISOString(),
        },
        statusCounts: {
          WAITING_CAPABILITY: 3,
          FAILED_TERMINAL: 1,
          SUCCEEDED: 1,
          ALREADY_ABSENT: 0,
        },
      },
    });
    expect(runtime.items[0]).toMatchObject({
      chatId: 'channel-1',
      routingState: 'READY',
      rollout: 'execute',
      capability: {
        confirmed: false,
        confirmedBotIds: [],
        memberships: [
          {
            botId: 'bot-1',
            botRuntimeState: 'active',
            state: 'explicitly_incapable',
            reason: 'missing_channel_delete_permission',
          },
          {
            botId: 'bot-draining',
            botRuntimeState: 'draining',
            state: 'stale_or_unknown',
            reason: 'bot_not_actionable',
          },
        ],
      },
      reasons: [{ ruleCode: 'COMMERCIAL' }],
    });
    expect(runtime.items.map((item) => item.status)).toEqual(['WAITING_CAPABILITY', 'SUCCEEDED']);
    expect(runtime.items[1]).toMatchObject({ remoteDeleteSucceededBotId: 'bot-1' });
    expect(runtime.items[1]?.remoteDeleteSucceededAt).not.toBeNull();
    expect(runtime.ambiguousSends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'channel_auto_post',
          chatId: 'channel-1',
          messageId: 'message-ambiguous-1',
          botId: 'bot-1',
        }),
        expect.objectContaining({
          source: 'channel_auto_post',
          chatId: 'channel-2',
          messageId: 'message-stale-claim-1',
          botId: 'bot-2',
          startedAt: staleClaimUpdatedAt.toISOString(),
          lastError: expect.stringContaining('Stale channel auto-post claim'),
        }),
      ]),
    );
    expect(runtime.giveawayWinnerNotificationDeadEnds).toEqual([
      expect.objectContaining({
        notificationId: 'winner-notification-1',
        giveawayId: 'giveaway-1',
        giveawayTitle: 'Главный приз',
        sourceChatId: 'channel-1',
        winnerId: 'winner-1',
        userId: 'user-1',
        botId: 'bot-1',
        status: 'AMBIGUOUS',
        attemptCount: 2,
      }),
    ]);
    prisma.managedGiveawayWinnerNotification.findUnique.mockResolvedValueOnce(
      createGiveawayWinnerNotificationDeadEnd({
        id: 'older-than-page',
        lastError: 'secret_token=private',
      }),
    );
    const lookup = await service.getGiveawayNotificationDeadEnd('older-than-page');
    expect(lookup.item?.notificationId).toBe('older-than-page');
    expect(prisma.managedGiveawayWinnerNotification.findUnique.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'older-than-page', status: { in: ['AMBIGUOUS', 'FAILED_TERMINAL'] } },
    });
    await expect(service.getGiveawayNotificationDeadEnd('does-not-exist')).resolves.toEqual({
      item: null,
    });
    expect(runtime.giveawayWinnerNotificationDeadEnds[0]?.lastError).toContain('[redacted]');
    expect(runtime.giveawayWinnerNotificationDeadEnds[0]?.lastError).not.toContain('winner-secret');
    expect(runtime.giveawayWinnerNotificationDeadEnds[0]?.lastError).not.toContain('query-secret');
    expect(runtime.giveawayWinnerNotificationDeadEnds[0]?.lastError).not.toContain('json-secret');
    expect(runtime.giveawayWinnerNotificationDeadEnds[0]?.lastError?.length).toBeLessThanOrEqual(
      1_000,
    );
    expect(prisma.moderationDeleteIntent.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 100,
        select: expect.objectContaining({
          chat: {
            select: expect.objectContaining({
              botMemberships: expect.objectContaining({
                where: { status: 'ACTIVE' },
                take: 20,
              }),
            }),
          },
          reasons: expect.objectContaining({ take: 10 }),
        }),
      }),
    );
    expect(prisma.moderationDeleteIntent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { status: { in: ['SUCCEEDED', 'ALREADY_ABSENT'] } },
        take: 25,
      }),
    );
    expect(prisma.moderationDeleteIntent.aggregate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: ['PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS'],
          },
          OR: expect.arrayContaining([
            expect.objectContaining({
              deleteDispatchStartedAt: { not: null },
              deleteDispatchStartedBotId: { not: null },
            }),
          ]),
        }),
      }),
    );
    expect(prisma.channelAutoPostAttachMarker.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
        }),
      }),
    );
    expect(prisma.channelAutoPostAttachMarker.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_PROGRESS',
          replacementMessageId: null,
          replyMessageId: null,
          OR: expect.arrayContaining([
            expect.objectContaining({
              lockedAt: null,
              updatedAt: { lte: expect.any(Date) },
            }),
          ]),
        }),
        _count: { _all: true },
        _min: { updatedAt: true },
      }),
    );
    expect(prisma.channelAutoPostAttachMarker.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_PROGRESS',
          OR: expect.arrayContaining([
            expect.objectContaining({
              lockedAt: null,
              updatedAt: { lte: expect.any(Date) },
            }),
          ]),
        }),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
    );
    expect(prisma.managedGiveawayWinnerNotification.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { status: { in: ['AMBIGUOUS', 'FAILED_TERMINAL'] } },
      _count: { _all: true },
      _min: { updatedAt: true },
    });
    expect(prisma.managedGiveawayWinnerNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['AMBIGUOUS', 'FAILED_TERMINAL'] } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: expect.objectContaining({
          lastError: true,
          winner: {
            select: {
              entry: { select: { userId: true } },
              giveaway: { select: { id: true, title: true, sourceChatId: true } },
            },
          },
        }),
      }),
    );
  });

  it('derives replacement cleanup survivor routing from the delete-intent service', async () => {
    const { moderationDeleteIntents, prisma, service } = createFixture();
    prisma.moderationDeleteIntent.aggregate
      .mockResolvedValueOnce({ _count: { _all: 0 }, _min: { nextAttemptAt: null } })
      .mockResolvedValueOnce({ _count: { _all: 0 }, _min: { leaseExpiresAt: null } })
      .mockResolvedValueOnce({ _min: { createdAt: null } });
    const base = createDeleteIntent();
    const replacementIntent = createDeleteIntent({
      id: 'replacement-intent-1',
      chatId: 'chat-outside-canary',
      entityType: ChatEntityType.CHAT,
      routingPolicy: 'origin_first',
      messageAuthorKind: 'user',
      chat: {
        ...base.chat,
        title: 'Чат вне canary',
        entityType: ChatEntityType.CHAT,
      },
      reasons: [
        {
          ...base.reasons[0],
          reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
          ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        },
      ],
    });
    prisma.moderationDeleteIntent.findMany
      .mockResolvedValueOnce([replacementIntent])
      .mockResolvedValueOnce([]);
    prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      {
        intentId: 'replacement-intent-1',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      },
    ]);

    const runtime = await service.getDeleteRuntime();

    expect(runtime.items[0]).toMatchObject({
      id: 'replacement-intent-1',
      rollout: 'execute',
      routingPolicy: 'origin_first',
      effectiveRoutingPolicy: 'origin_first',
      crossBotEnabled: true,
    });
    expect(moderationDeleteIntents.resolveEffectiveRoutingPolicy).toHaveBeenCalledWith({
      chatId: 'chat-outside-canary',
      entityType: ChatEntityType.CHAT,
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      replacementCleanup: true,
    });
  });

  it('confirms only executable delete capability from fresh entity-specific snapshots', async () => {
    const { prisma, service } = createFixture();
    const now = Date.now();
    const capable = createDeleteIntent({
      entityType: ChatEntityType.CHAT,
      originBotId: 'bot-chat',
      chat: {
        title: 'Рабочий чат',
        entityType: ChatEntityType.CHAT,
        routingState: 'NO_ELIGIBLE_BOT',
        botMemberships: [
          {
            botId: 'bot-chat',
            role: 'STANDBY',
            permissionsSnapshot: {
              checkedAt: new Date(now - 1_000).toISOString(),
              isAdmin: true,
              isOwner: false,
              permissions: ['read_all_messages', 'write'],
            },
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessCheckedAt: new Date(now - 1_000),
            botAccessExpiresAt: new Date(now + 60_000),
          },
          {
            botId: 'bot-standby',
            role: 'STANDBY',
            permissionsSnapshot: {
              checkedAt: new Date(now - 1_000).toISOString(),
              isAdmin: true,
              isOwner: false,
              permissions: ['write'],
            },
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessCheckedAt: new Date(now - 1_000),
            botAccessExpiresAt: new Date(now + 60_000),
          },
        ],
      },
    });
    prisma.moderationDeleteIntent.aggregate
      .mockResolvedValueOnce({ _count: { _all: 0 }, _min: { nextAttemptAt: null } })
      .mockResolvedValueOnce({ _count: { _all: 0 }, _min: { leaseExpiresAt: null } })
      .mockResolvedValueOnce({ _min: { createdAt: null } });
    prisma.moderationDeleteIntent.findMany
      .mockResolvedValueOnce([capable])
      .mockResolvedValueOnce([]);

    const runtime = await service.getDeleteRuntime();

    expect(runtime.items[0]?.capability).toMatchObject({
      confirmed: true,
      confirmedBotIds: ['bot-chat'],
      memberships: [
        {
          state: 'confirmed_capable',
          reason: 'confirmed',
        },
        {
          state: 'confirmed_capable',
          reason: 'confirmed',
        },
      ],
    });
    expect(runtime.items[0]?.routingState).toBe('NO_ELIGIBLE_BOT');
  });

  it('clears only a stale chat-rules send fence and records the owner action', async () => {
    const { prisma, service } = createFixture();
    const startedAt = new Date(Date.now() - 20 * 60_000);
    prisma.chatRules.findUnique.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      publishOperationId: 'publish-operation-1',
      publishOperationBotId: 'bot-1',
      publishSendStartedAt: startedAt,
    });
    jest.spyOn(service, 'getDeleteRuntime').mockResolvedValue({ generatedAt: 'test' } as never);

    await service.clearAmbiguousSendFence('chat_rules:rules-1', 'owner', {
      expectedOperationId: 'publish-operation-1',
      expectedStartedAt: startedAt.toISOString(),
    });

    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'rules-1',
        publishOperationId: 'publish-operation-1',
        publishSendStartedAt: startedAt,
      },
      data: {
        publishOperationId: null,
        publishOperationBotId: null,
        publishSendStartedAt: null,
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'owner',
        action: 'SAFETY_DESK_CLEAR_AMBIGUOUS_SEND_FENCE',
      }),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not clear a newer ambiguous chat-rules operation from a stale Safety Desk view', async () => {
    const { prisma, service } = createFixture();
    const oldStartedAt = new Date(Date.now() - 30 * 60_000);
    prisma.chatRules.findUnique.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      publishOperationId: 'publish-operation-new',
      publishOperationBotId: 'bot-1',
      publishSendStartedAt: new Date(Date.now() - 20 * 60_000),
    });

    await expect(
      service.clearAmbiguousSendFence('chat_rules:rules-1', 'owner', {
        expectedOperationId: 'publish-operation-old',
        expectedStartedAt: oldStartedAt.toISOString(),
      }),
    ).rejects.toThrow('Состояние публикации изменилось');
    expect(prisma.chatRules.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('retries terminal replacement cleanup outside the global canary with a CAS status', async () => {
    const { moderationDeleteIntents, prisma, service } = createFixture();
    prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      id: 'delete-intent-1',
      chatId: 'outside-chat',
      status: 'EXPIRED',
      updatedAt: new Date('2026-07-16T12:00:00.000Z'),
      attemptCount: 2,
      reasons: [{ ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP' }],
    });
    moderationDeleteIntents.retryTerminalIntent.mockResolvedValue({
      reopened: true,
      intent: { id: 'delete-intent-1', status: 'PENDING' },
    });
    prisma.moderationDeleteIntent.aggregate
      .mockResolvedValueOnce({ _count: { _all: 0 }, _min: { nextAttemptAt: null } })
      .mockResolvedValueOnce({ _count: { _all: 0 }, _min: { leaseExpiresAt: null } })
      .mockResolvedValueOnce({ _min: { createdAt: null } });

    await expect(
      service.retryDeleteIntent('delete-intent-1', 'owner', {
        expectedStatus: 'EXPIRED',
        expectedUpdatedAt: '2026-07-16T12:00:00.000Z',
        expectedAttemptCount: 2,
      }),
    ).resolves.toMatchObject({ rolloutMode: 'canary' });

    expect(moderationDeleteIntents.retryTerminalIntent).toHaveBeenCalledWith(
      'delete-intent-1',
      'EXPIRED',
      { updatedAt: new Date('2026-07-16T12:00:00.000Z'), attemptCount: 2 },
      { actorUserId: 'owner' },
    );
    expect(moderationDeleteIntents.getRolloutForRuleCodes).toHaveBeenCalledWith('outside-chat', [
      'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
    ]);
  });

  it('rejects a terminal delete outside every effective rollout', async () => {
    const { moderationDeleteIntents, prisma, service } = createFixture();
    prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      id: 'delete-intent-1',
      chatId: 'outside-chat',
      status: 'EXPIRED',
      updatedAt: new Date('2026-07-16T12:00:00.000Z'),
      attemptCount: 2,
      reasons: [],
    });

    await expect(
      service.retryDeleteIntent('delete-intent-1', 'owner', {
        expectedStatus: 'EXPIRED',
        expectedUpdatedAt: '2026-07-16T12:00:00.000Z',
        expectedAttemptCount: 2,
      }),
    ).rejects.toThrow('Повтор запрещён вне активного rollout');

    expect(moderationDeleteIntents.retryTerminalIntent).not.toHaveBeenCalled();
  });

  it('reopens a terminal night cleanup for exact guarded execution', async () => {
    const { moderationDeleteIntents, prisma, service } = createFixture();
    prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      id: 'delete-intent-night-1',
      chatId: 'channel-1',
      status: 'FAILED_TERMINAL',
      updatedAt: new Date('2026-07-16T12:00:00.000Z'),
      attemptCount: 1,
      reasons: [{ ruleCode: 'NIGHT_MODE_CLOSE_NOTICE_CLEANUP' }],
    });
    moderationDeleteIntents.retryTerminalIntent.mockResolvedValue({
      reopened: true,
      intent: { id: 'delete-intent-night-1', status: 'PENDING' },
    });
    prisma.moderationDeleteIntent.aggregate
      .mockResolvedValueOnce({ _count: { _all: 0 }, _min: { nextAttemptAt: null } })
      .mockResolvedValueOnce({ _count: { _all: 0 }, _min: { leaseExpiresAt: null } })
      .mockResolvedValueOnce({ _min: { createdAt: null } });

    await expect(
      service.retryDeleteIntent('delete-intent-night-1', 'owner', {
        expectedStatus: 'FAILED_TERMINAL',
        expectedUpdatedAt: '2026-07-16T12:00:00.000Z',
        expectedAttemptCount: 1,
      }),
    ).resolves.toMatchObject({ rolloutMode: 'canary' });

    expect(moderationDeleteIntents.retryTerminalIntent).toHaveBeenCalledWith(
      'delete-intent-night-1',
      'FAILED_TERMINAL',
      { updatedAt: new Date('2026-07-16T12:00:00.000Z'), attemptCount: 1 },
      { actorUserId: 'owner' },
    );
  });

  it('rejects a stale terminal delete retry without dispatching it', async () => {
    const { moderationDeleteIntents, prisma, service } = createFixture();
    prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      id: 'delete-intent-1',
      chatId: 'channel-1',
      status: 'PENDING',
      updatedAt: new Date('2026-07-16T12:00:00.000Z'),
      attemptCount: 3,
      reasons: [],
    });

    await expect(
      service.retryDeleteIntent('delete-intent-1', 'owner', {
        expectedStatus: 'EXPIRED',
        expectedUpdatedAt: '2026-07-16T12:00:00.000Z',
        expectedAttemptCount: 2,
      }),
    ).rejects.toThrow('Состояние удаления изменилось');
    expect(moderationDeleteIntents.retryTerminalIntent).not.toHaveBeenCalled();
  });

  it('builds a visible review queue from real VK review posts', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([createReviewPost()]);

    const queue = await service.getQueue();

    expect(queue.summary.review).toBe(1);
    expect(queue.items[0]).toMatchObject({
      id: 'post-1',
      source: 'VK_REVIEW',
      entityTitle: 'Канал: Канал администраторов',
      author: 'Источник MAXIM',
      text: expect.stringContaining('Проверяем публикацию'),
      domains: ['example.com'],
      photoUrls: ['https://cdn.example.com/photo.jpg'],
      videoUrls: [],
      status: 'REVIEW',
    });
    expect(queue.items[0]?.checks.map((check) => check.label)).toContain(
      'До решения владельца в MAX ничего не отправляется',
    );
    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerProfile: 'PUBLISHER',
          ownerBotId: 'publisher-bot',
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          source: expect.objectContaining({
            ownerProfile: 'PUBLISHER',
            ownerBotId: 'publisher-bot',
          }),
        }),
        include: expect.objectContaining({
          chat: expect.objectContaining({
            select: expect.objectContaining({
              vkParsingSettings: {
                where: {
                  ownerProfile: 'PUBLISHER',
                  ownerBotId: 'publisher-bot',
                },
                take: 1,
              },
            }),
          }),
        }),
      }),
    );
  });

  it('treats VK and MAX links as trusted Safety Desk domains', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        text: 'Проверяем публикацию',
        url: 'https://vk.com/wall-36819802_101',
        linkUrls: [
          'https://vk.ru/club1',
          'https://m.vk.com/wall-1_2',
          'https://max.ru/channel/team',
          'https://dev.max.ru/docs',
        ],
        photoUrls: [],
        videoUrls: [],
      }),
    ]);

    const queue = await service.getQueue();

    expect(queue.items[0]?.domains).toEqual([]);
    expect(queue.items[0]?.checks).toContainEqual({
      label: 'Внешних ссылок нет',
      state: 'PASSED',
    });
    expect(queue.items[0]?.risk).toBe('LOW');
  });

  it('reviews markdown hyperlinks and the configured channel signature in the final preview', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        text: '**Новость** [витрина](https://shop.example/catalog) [Профиль](max://user/42)',
        textFormat: 'markdown',
        photoUrls: [],
        videoUrls: [],
        linkUrls: ['https://fallback.example/a_b'],
        chat: {
          title: 'Канал администраторов',
          entityType: ChatEntityType.CHANNEL,
          vkParsingSettings: [
            {
              stripLinksEnabled: false,
              skipAdsEnabled: false,
              appendChannelLinkEnabled: true,
              channelLinkText: 'Наш канал',
            },
          ],
          channelSettings: {
            postSignatureEnabled: true,
            postSignaturePresentation: ChannelPostSignaturePresentation.SIGNATURE,
            postSignatureText: 'Наш канал',
            postSignatureUrl: 'https://ads.partner.example/contact',
          },
        },
      }),
    ]);

    const queue = await service.getQueue();

    expect(queue.items[0]).toMatchObject({
      textFormat: 'markdown',
      domains: ['ads.partner.example', 'fallback.example', 'shop.example'],
      linkUrls: [
        'https://fallback.example/a_b',
        'https://shop.example/catalog',
        'max://user/42',
        'https://ads.partner.example/contact',
      ],
      risk: 'MEDIUM',
    });
    expect(queue.items[0]?.previewHtml).toBe(
      '<p><strong>Новость</strong> <u>витрина</u> <u>Профиль</u></p><p><u>https://fallback.example/a_b</u></p><p><u>Наш канал</u></p>',
    );
  });

  it('reviews a channel CTA URL without rendering it as a text signature', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        text: 'Новость',
        photoUrls: [],
        videoUrls: [],
        linkUrls: [],
        chat: {
          title: 'Канал администраторов',
          entityType: ChatEntityType.CHANNEL,
          vkParsingSettings: [],
          channelSettings: {
            postSignatureEnabled: true,
            postSignaturePresentation: ChannelPostSignaturePresentation.BUTTON,
            postSignatureText: '📞 Заказать рекламу',
            postSignatureUrl: 'https://ads.partner.example/contact',
          },
        },
      }),
    ]);

    const queue = await service.getQueue();

    expect(queue.items[0]).toMatchObject({
      domains: ['ads.partner.example'],
      linkUrls: ['https://ads.partner.example/contact'],
      previewHtml: '<p>Новость</p>',
    });
  });

  it('renders and approves untouched imported VK strong markup as markdown', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const post = createReviewPost({
      text: '**АРАХИСОВАЯ ПАСТА**',
      textFormat: 'plain',
      manualContentEditedAt: null,
      photoUrls: [],
      linkUrls: [],
    });
    prisma.vkParsingPost.findMany.mockResolvedValue([post]);
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    const queue = await service.getQueue();
    await service.approveItem('post-1', 'maxim', {});

    expect(queue.items[0]).toMatchObject({
      textFormat: 'markdown',
      previewHtml: '<p><strong>АРАХИСОВАЯ ПАСТА</strong></p>',
    });
    expect(vkPublishService.publishPost).toHaveBeenCalledWith(
      'channel-1',
      'post-1',
      'safety-desk-owner',
      expect.objectContaining({
        text: '**АРАХИСОВАЯ ПАСТА**',
        textFormat: 'markdown',
      }),
    );
  });

  it('includes manually entered bare links in Safety Desk risk domains', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        text: 'Проверить https://evil.example/path и risky.example/offer',
        textFormat: 'markdown',
        photoUrls: [],
        videoUrls: [],
        linkUrls: [],
      }),
    ]);

    const queue = await service.getQueue();

    expect(queue.items[0]).toMatchObject({
      domains: ['evil.example', 'risky.example'],
      linkUrls: ['https://evil.example/path', 'https://risky.example/offer'],
      risk: 'MEDIUM',
    });
  });

  it('keeps posts with unsupported attachments out of the owner review queue', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        text: '',
        photoUrls: [],
        linkUrls: [],
        hasUnsupportedAttachments: true,
        unsupportedAttachments: [{ type: 'video', label: 'Видео', count: 1 }],
      }),
    ]);

    const queue = await service.getQueue();

    expect(queue.summary.review).toBe(0);
    expect(queue.summary.blocked).toBe(0);
    expect(queue.items).toEqual([]);
  });

  it('does not expose unsupported-only posts in the owner review queue', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([
      createReviewPost({
        id: 'post-video',
        text: '',
        photoUrls: [],
        linkUrls: [],
        hasUnsupportedAttachments: true,
        unsupportedAttachments: [{ type: 'video', label: 'Видео', count: 1 }],
      }),
      createReviewPost({ id: 'post-text', text: 'Можно проверить' }),
    ]);

    const queue = await service.getQueue();

    expect(queue.items.map((item) => item.id)).toEqual(['post-text']);
    expect(queue.summary.review).toBe(1);
    expect(queue.summary.blocked).toBe(0);
  });

  it('keeps posts with warnings approvable', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValue([createReviewPost({ isAdvertising: true })]);

    const queue = await service.getQueue();

    expect(queue.summary.review).toBe(1);
    expect(queue.summary.blocked).toBe(0);
    expect(queue.items[0]).toMatchObject({
      status: 'REVIEW',
      risk: 'HIGH',
    });
  });

  it('approves a review item through the VK publish path and records audit', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const post = createReviewPost();
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    const result = await service.approveItem('post-1', 'maxim', {});

    expect(vkPublishService.publishPost).toHaveBeenCalledWith(
      'channel-1',
      'post-1',
      'safety-desk-owner',
      {
        text: post.text,
        photoUrls: ['https://cdn.example.com/photo.jpg'],
        videoUrls: [],
        linkUrls: ['https://example.com/post'],
      },
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'channel-1',
          actorUserId: 'maxim',
          action: 'SAFETY_DESK_APPROVE',
          payload: expect.objectContaining({ queued: 1 }),
        }),
      }),
    );
    expect(result.message).toContain('принят в очередь публикации');
    expect(result.message).not.toContain('опубликован');
  });

  it('does not audit approval when the queue intent loses its compare-and-set race', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createReviewPost());
    vkPublishService.publishPost.mockResolvedValueOnce({ queued: 0, post: {} });

    await expect(service.approveItem('post-1', 'maxim', {})).rejects.toThrow(
      'Материал проверки уже обработан или недоступен',
    );

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('preserves markdown format when Safety Desk approves an edited review draft', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const post = createReviewPost({ text: '**Готово**', textFormat: 'markdown' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await service.approveItem('post-1', 'maxim', {});

    expect(vkPublishService.publishPost).toHaveBeenCalledWith(
      'channel-1',
      'post-1',
      'safety-desk-owner',
      expect.objectContaining({
        text: '**Готово**',
        textFormat: 'markdown',
      }),
    );
  });

  it('keeps VK video review posts visible and passes videoUrls to publish', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const post = createReviewPost({
      text: 'Видео на проверку',
      photoUrls: [],
      videoUrls: ['https://vkvd.example/video-720.mp4'],
      linkUrls: [],
      attachmentTypes: ['video'],
    });
    prisma.vkParsingPost.findMany.mockResolvedValue([post]);
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    const queue = await service.getQueue();
    await service.approveItem('post-1', 'maxim', {});

    expect(queue.items[0]).toMatchObject({
      id: 'post-1',
      videoUrls: ['https://vkvd.example/video-720.mp4'],
      status: 'REVIEW',
    });
    expect(vkPublishService.publishPost).toHaveBeenCalledWith(
      'channel-1',
      'post-1',
      'safety-desk-owner',
      {
        text: 'Видео на проверку',
        photoUrls: [],
        videoUrls: ['https://vkvd.example/video-720.mp4'],
        linkUrls: [],
      },
    );
  });

  it('does not approve a blocked review item', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(
      createReviewPost({
        hasUnsupportedAttachments: true,
        unsupportedAttachments: [{ type: 'video', label: 'Видео', count: 1 }],
      }),
    );

    await expect(service.approveItem('post-1', 'maxim', {})).rejects.toThrow(BadRequestException);
    expect(vkPublishService.publishPost).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('approves all review items through the VK publish path', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const postOne = createReviewPost({ id: 'post-1', text: 'Первый пост' });
    const postTwo = createReviewPost({ id: 'post-2', text: 'Второй пост' });
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([postOne, postTwo])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.approveAllReviewItems('maxim', {
      itemIds: [' post-1 ', 'post-1', 'post-2'],
    });

    expect(vkPublishService.publishPost).toHaveBeenCalledTimes(2);
    expect(vkPublishService.publishPost).toHaveBeenNthCalledWith(
      1,
      'channel-1',
      'post-1',
      'safety-desk-owner',
      expect.objectContaining({ text: 'Первый пост' }),
    );
    expect(vkPublishService.publishPost).toHaveBeenNthCalledWith(
      2,
      'channel-1',
      'post-2',
      'safety-desk-owner',
      expect.objectContaining({ text: 'Второй пост' }),
    );
    expect(prisma.vkParsingPost.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['post-1', 'post-2'] } }),
        take: 2,
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(result.message).toContain('Принято в очередь публикации материалов: 2');
    expect(result.message).not.toContain('опубликовано');
    expect(result.queue.summary.review).toBe(0);
  });

  it('rejects bulk approval without an explicit item scope', async () => {
    const { prisma, service, vkPublishService } = createFixture();

    await expect(service.approveAllReviewItems('maxim', {})).rejects.toThrow(BadRequestException);
    await expect(service.approveAllReviewItems('maxim', { itemIds: [] })).rejects.toThrow(
      BadRequestException,
    );

    expect(prisma.vkParsingPost.findMany).not.toHaveBeenCalled();
    expect(vkPublishService.publishPost).not.toHaveBeenCalled();
  });

  it('does not publish items outside the requested bulk approval scope', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([createReviewPost({ id: 'post-2' })]);

    await service.approveAllReviewItems('maxim', { itemIds: ['post-2'] });

    expect(vkPublishService.publishPost).toHaveBeenCalledTimes(1);
    expect(vkPublishService.publishPost).toHaveBeenCalledWith(
      'channel-1',
      'post-2',
      'safety-desk-owner',
      expect.any(Object),
    );
    expect(prisma.vkParsingPost.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['post-2'] } }),
        take: 1,
      }),
    );
  });

  it('skips blocked or stale items inside a scoped bulk approval request', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    const postOne = createReviewPost({ id: 'post-1', text: 'Можно публиковать' });
    const blockedPost = createReviewPost({
      id: 'post-blocked',
      text: 'Медиа конфликт',
      photoUrls: ['https://cdn.example.com/photo.jpg'],
      videoUrls: ['https://vkvd.example/video-720.mp4'],
    });
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([postOne, blockedPost])
      .mockResolvedValueOnce([]);

    const result = await service.approveAllReviewItems('maxim', {
      itemIds: ['post-1', 'post-blocked', 'post-stale'],
    });

    expect(vkPublishService.publishPost).toHaveBeenCalledTimes(1);
    expect(vkPublishService.publishPost).toHaveBeenCalledWith(
      'channel-1',
      'post-1',
      'safety-desk-owner',
      expect.any(Object),
    );
    expect(result.message).toContain('Уже недоступно или заблокировано: 2');
  });

  it('rejects a review item without sending anything to MAX', async () => {
    const { prisma, service, vkPublishService } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createReviewPost());

    const result = await service.rejectItem('post-1', 'maxim', {});

    expect(vkPublishService.publishPost).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        publishCancelledAt: null,
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        source: expect.objectContaining({
          ownerProfile: 'PUBLISHER',
          ownerBotId: 'publisher-bot',
          status: 'ACTIVE',
          publishMode: 'REVIEW',
        }),
      }),
      data: expect.objectContaining({
        publishCancelledAt: expect.any(Date),
        publishCancelledByUserId: 'maxim',
        publishIdempotencyKey: null,
      }),
    });
    expect(result.message).toContain('ничего не отправлено');
  });

  it('treats stale reject decisions as not found without audit side effects', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createReviewPost());
    prisma.vkParsingPost.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.rejectItem('post-1', 'maxim', {})).rejects.toThrow(
      'Материал проверки уже обработан или недоступен',
    );

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not reject a review item while publish is locked', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createReviewPost());
    prisma.vkParsingPost.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.rejectItem('post-1', 'maxim', {})).rejects.toThrow(
      'Материал проверки уже обработан или недоступен',
    );

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        publishLockedAt: null,
      }),
      data: expect.any(Object),
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('treats stale recheck decisions as not found without audit side effects', async () => {
    const { prisma, service } = createFixture();
    const cancelledAt = new Date('2026-06-27T10:06:00.000Z');
    prisma.vkParsingPost.findFirst.mockResolvedValue(
      createReviewPost({ publishCancelledAt: cancelledAt }),
    );
    prisma.vkParsingPost.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.recheckItem('post-1', 'maxim')).rejects.toThrow(
      'Материал проверки уже обработан или недоступен',
    );

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        publishCancelledAt: cancelledAt,
        publishLockedAt: null,
      }),
      data: expect.any(Object),
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('blocks recheck after an ambiguous MAX send from Safety Desk', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(
      createReviewPost({
        status: 'FAILED',
        lastError:
          '[max.send_ambiguous] request timed out. Delivery may have been accepted by MAX.',
      }),
    );

    await expect(service.recheckItem('post-1', 'maxim')).rejects.toThrow(
      'MAX мог уже принять эту публикацию',
    );

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('returns a bounded night-mode runtime view without lease tokens', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');
    const rows = Array.from({ length: 51 }, (_, index) => ({
      chatId: `chat-${index + 1}`,
      chatTitle: `Chat ${index + 1}`,
      entityType: ChatEntityType.CHAT,
      generation: BigInt(index + 1),
      firstRequestedAt: new Date('2026-08-21T09:00:00.000Z'),
      requestedAt: new Date('2026-08-21T09:30:00.000Z'),
      attemptCount: 2,
      lastAttemptAt: new Date('2026-08-21T09:45:00.000Z'),
      lastErrorCode: 'temporary_error',
      lastErrorAt: new Date('2026-08-21T09:45:00.000Z'),
      lastError: 'token=secret https://example.test/path?key=secret',
      leaseExpiresAt: null,
      manualBlockedAt: blockedAt,
      manualBlockedReason: 'Authorization: Bearer secret',
      manualBlockedCategory: index === 0 ? 'no_fresh_access' : ('unsafe_prior_dispatch' as const),
      manualBlockedJobId: `job-${index + 1}`,
      manualBlockedLedgerJobId: index === 0 ? 'ledger-1' : null,
      manualBlockedSessionKey: 'session-1',
      manualBlockedFingerprint: `sha256:${'a'.repeat(64)}`,
      manualBlockedGeneration: BigInt(index + 1),
      manualAcknowledgedAt: null,
      state: 'MANUAL_BLOCKED' as const,
    }));
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          total: 181,
          due: 0,
          deferred: 0,
          leased: 0,
          staleLeases: 0,
          manualBlocked: 181,
          acknowledged: 0,
          oldestDueAt: null,
          oldestStaleLeaseAt: null,
          oldestManualBlockedAt: blockedAt,
        },
      ])
      .mockResolvedValueOnce([
        { category: 'unsafe_prior_dispatch', count: 180 },
        { category: 'no_fresh_access', count: 1 },
      ])
      .mockResolvedValueOnce(rows);

    const result = await service.getNightModeTransitionRuntime('50');

    expect(result.items).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.offset).toBe(50);
    expect(result.nextOffset).toBe(100);
    expect(result.summary).toEqual(
      expect.objectContaining({
        total: 181,
        manualBlocked: 181,
        oldestManualBlockedAt: blockedAt.toISOString(),
        categoryCounts: expect.objectContaining({
          unsafe_prior_dispatch: 180,
          no_fresh_access: 1,
        }),
      }),
    );
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        generation: '1',
        manualBlockedGeneration: '1',
        allowedActions: ['ACKNOWLEDGE', 'RETRY'],
        lastError: expect.stringContaining('[redacted]'),
        manualBlockedReason: expect.stringContaining('[redacted]'),
      }),
    );
    expect(result.items[1]?.allowedActions).toEqual(['ACKNOWLEDGE']);
    expect(result.items.some((item) => 'leaseToken' in item)).toBe(false);
    const summarySql = (prisma.$queryRaw.mock.calls[0]?.[0] as { sql?: string } | undefined)?.sql;
    const categorySql = (prisma.$queryRaw.mock.calls[1]?.[0] as { sql?: string } | undefined)?.sql;
    const itemQuery = prisma.$queryRaw.mock.calls[2]?.[0] as
      | { sql?: string; values?: unknown[] }
      | undefined;
    expect(summarySql).not.toMatch(/\bOFFSET\b/u);
    expect(categorySql).not.toMatch(/\bOFFSET\b/u);
    expect(itemQuery?.sql).toMatch(/LIMIT \?\s+OFFSET \?/u);
    expect(itemQuery?.values?.slice(-2)).toEqual([51, 50]);
  });

  it.each([undefined, '0', '1000'])(
    'accepts the bounded night-mode runtime offset %p',
    async (offsetInput) => {
      const { prisma, service } = createFixture();

      const result = await service.getNightModeTransitionRuntime(offsetInput);

      const itemQuery = prisma.$queryRaw.mock.calls[2]?.[0] as { values?: unknown[] } | undefined;
      const expectedOffset = offsetInput === undefined ? 0 : Number(offsetInput);
      expect(result.offset).toBe(expectedOffset);
      expect(result.nextOffset).toBeNull();
      expect(itemQuery?.values?.slice(-2)).toEqual([51, expectedOffset]);
    },
  );

  it.each(['', '-1', '1.5', '1001', '1e2', ' 1 ', null, ['1']])(
    'rejects the invalid night-mode runtime offset %p before querying',
    async (offsetInput) => {
      const { prisma, service } = createFixture();

      await expect(service.getNightModeTransitionRuntime(offsetInput)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it('shows a newer tombstone generation as live work without operator actions', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          total: 1,
          due: 0,
          deferred: 0,
          leased: 1,
          staleLeases: 0,
          manualBlocked: 0,
          acknowledged: 0,
          oldestDueAt: null,
          oldestStaleLeaseAt: null,
          oldestManualBlockedAt: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          chatId: 'chat-live-repair',
          chatTitle: 'Live repair',
          entityType: ChatEntityType.CHAT,
          generation: 8n,
          firstRequestedAt: new Date('2026-08-21T09:00:00.000Z'),
          requestedAt: new Date('2026-08-21T09:30:00.000Z'),
          attemptCount: 3,
          lastAttemptAt: new Date('2026-08-21T10:01:00.000Z'),
          lastErrorCode: null,
          lastErrorAt: null,
          lastError: null,
          leaseExpiresAt: new Date('2026-08-21T10:05:00.000Z'),
          manualBlockedAt: blockedAt,
          manualBlockedReason: 'preserved exact tombstone',
          manualBlockedCategory: 'unsafe_prior_dispatch',
          manualBlockedJobId: 'blocked-job',
          manualBlockedLedgerJobId: null,
          manualBlockedSessionKey: 'blocked-session',
          manualBlockedFingerprint: `sha256:${'a'.repeat(64)}`,
          manualBlockedGeneration: 7n,
          manualAcknowledgedAt: blockedAt,
          state: 'LEASED',
        },
      ]);

    const result = await service.getNightModeTransitionRuntime();

    expect(result.summary).toEqual(expect.objectContaining({ leased: 1, manualBlocked: 0 }));
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        generation: '8',
        manualBlockedGeneration: '7',
        state: 'LEASED',
        allowedActions: [],
        manualAcknowledgedAt: blockedAt.toISOString(),
        context: expect.objectContaining({ jobId: 'blocked-job' }),
      }),
    );
  });

  it('shows an acknowledged settled tombstone without operator actions', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');
    const acknowledgedAt = new Date('2026-08-21T10:05:00.000Z');
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          total: 1,
          due: 0,
          deferred: 0,
          leased: 0,
          staleLeases: 0,
          manualBlocked: 0,
          acknowledged: 1,
          oldestDueAt: null,
          oldestStaleLeaseAt: null,
          oldestManualBlockedAt: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          chatId: 'chat-acknowledged',
          chatTitle: 'Acknowledged repair',
          entityType: ChatEntityType.CHAT,
          generation: 8n,
          firstRequestedAt: new Date('2026-08-21T09:00:00.000Z'),
          requestedAt: new Date('2026-08-21T09:30:00.000Z'),
          attemptCount: 3,
          lastAttemptAt: new Date('2026-08-21T09:45:00.000Z'),
          lastErrorCode: null,
          lastErrorAt: null,
          lastError: null,
          leaseExpiresAt: null,
          manualBlockedAt: blockedAt,
          manualBlockedReason: 'operator reviewed exact occurrence',
          manualBlockedCategory: 'unsafe_prior_dispatch',
          manualBlockedJobId: 'blocked-job',
          manualBlockedLedgerJobId: null,
          manualBlockedSessionKey: 'blocked-session',
          manualBlockedFingerprint: `sha256:${'a'.repeat(64)}`,
          manualBlockedGeneration: 8n,
          manualAcknowledgedAt: acknowledgedAt,
          state: 'ACKNOWLEDGED',
        },
      ]);

    const result = await service.getNightModeTransitionRuntime();

    expect(result.summary).toEqual(expect.objectContaining({ acknowledged: 1, manualBlocked: 0 }));
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        state: 'ACKNOWLEDGED',
        manualAcknowledgedAt: acknowledgedAt.toISOString(),
        allowedActions: [],
      }),
    );
    const itemSql = (prisma.$queryRaw.mock.calls[2]?.[0] as { sql?: string } | undefined)?.sql;
    expect(itemSql).toMatch(
      /manual_acknowledged_at" IS NOT NULL THEN 5\s+WHEN request\."lease_token"/u,
    );
  });

  it('acknowledges a manual night-mode block with an exact category-aware CAS and audit', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');
    prisma.nightModeTransitionReconcileRequest.findUnique.mockResolvedValue({
      generation: 8n,
      manualBlockedAt: blockedAt,
      manualBlockedCategory: 'unsafe_prior_dispatch',
      manualBlockedFingerprint: `sha256:${'a'.repeat(64)}`,
      manualBlockedGeneration: 8n,
      manualAcknowledgedAt: null,
    });

    await service.acknowledgeNightModeTransitionBlock('chat-1', 'owner', {
      expectedGeneration: '8',
      expectedManualBlockedGeneration: '8',
      expectedManualBlockedAt: blockedAt.toISOString(),
      expectedCategory: 'unsafe_prior_dispatch',
      expectedFingerprint: `sha256:${'a'.repeat(64)}`,
      reason: 'Проверено оператором',
    });

    expect(prisma.nightModeTransitionReconcileRequest.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: 'chat-1',
        generation: 8n,
        manualBlockedGeneration: 8n,
        manualBlockedCategory: 'unsafe_prior_dispatch',
        manualAcknowledgedAt: null,
      }),
      data: expect.objectContaining({
        manualAcknowledgedAt: expect.any(Date),
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    });
    expect(prisma.nightModeTransitionReconcileRequest.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'owner',
        action: 'SAFETY_DESK_ACK_NIGHT_MODE_RECONCILE',
      }),
    });
  });

  it('retries only no-fresh-access blocks by advancing the durable generation', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');
    prisma.nightModeTransitionReconcileRequest.findUnique.mockResolvedValue({
      generation: 8n,
      manualBlockedAt: blockedAt,
      manualBlockedCategory: 'no_fresh_access',
      manualBlockedFingerprint: `sha256:${'a'.repeat(64)}`,
      manualBlockedGeneration: 8n,
      manualAcknowledgedAt: null,
    });

    await service.retryNightModeTransitionBlock('chat-1', 'owner', {
      expectedGeneration: '8',
      expectedManualBlockedGeneration: '8',
      expectedManualBlockedAt: blockedAt.toISOString(),
      expectedCategory: 'no_fresh_access',
      expectedFingerprint: `sha256:${'a'.repeat(64)}`,
      reason: 'Свежий доступ подтверждён',
    });

    expect(prisma.nightModeTransitionReconcileRequest.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: 'chat-1',
        generation: 8n,
        manualAcknowledgedAt: null,
      }),
      data: expect.objectContaining({
        generation: { increment: 1n },
        manualBlockedAt: null,
        manualBlockedCategory: null,
        manualAcknowledgedAt: null,
        leaseToken: null,
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'SAFETY_DESK_RETRY_NIGHT_MODE_RECONCILE',
      }),
    });
  });

  it('rejects unsafe night-mode retries before any transaction or queue action', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');

    await expect(
      service.retryNightModeTransitionBlock('chat-1', 'owner', {
        expectedGeneration: '8',
        expectedManualBlockedGeneration: '7',
        expectedManualBlockedAt: blockedAt.toISOString(),
        expectedCategory: 'unsafe_prior_provenance',
        expectedFingerprint: `sha256:${'a'.repeat(64)}`,
        reason: 'Не повторять автоматически',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.nightModeTransitionReconcileRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a stale night-mode manual CAS without mutation or audit', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');
    prisma.nightModeTransitionReconcileRequest.findUnique.mockResolvedValue({
      generation: 9n,
      manualBlockedAt: blockedAt,
      manualBlockedCategory: 'unsafe_prior_dispatch',
      manualBlockedFingerprint: `sha256:${'a'.repeat(64)}`,
      manualBlockedGeneration: 7n,
      manualAcknowledgedAt: null,
    });

    await expect(
      service.acknowledgeNightModeTransitionBlock('chat-1', 'owner', {
        expectedGeneration: '8',
        expectedManualBlockedGeneration: '7',
        expectedManualBlockedAt: blockedAt.toISOString(),
        expectedCategory: 'unsafe_prior_dispatch',
        expectedFingerprint: `sha256:${'a'.repeat(64)}`,
        reason: 'Устаревшая вкладка',
      }),
    ).rejects.toThrow('Состояние night mode изменилось');

    expect(prisma.nightModeTransitionReconcileRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.nightModeTransitionReconcileRequest.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a repeated acknowledgement without mutation or duplicate audit', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');
    prisma.nightModeTransitionReconcileRequest.findUnique.mockResolvedValue({
      generation: 8n,
      manualBlockedAt: blockedAt,
      manualBlockedCategory: 'unsafe_prior_dispatch',
      manualBlockedFingerprint: `sha256:${'a'.repeat(64)}`,
      manualBlockedGeneration: 8n,
      manualAcknowledgedAt: new Date('2026-08-21T10:05:00.000Z'),
    });

    await expect(
      service.acknowledgeNightModeTransitionBlock('chat-1', 'owner', {
        expectedGeneration: '8',
        expectedManualBlockedGeneration: '8',
        expectedManualBlockedAt: blockedAt.toISOString(),
        expectedCategory: 'unsafe_prior_dispatch',
        expectedFingerprint: `sha256:${'a'.repeat(64)}`,
        reason: 'Повторный клик',
      }),
    ).rejects.toThrow('Состояние night mode изменилось');

    expect(prisma.nightModeTransitionReconcileRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects an acknowledgement that loses the CAS race before writing an audit', async () => {
    const { prisma, service } = createFixture();
    const blockedAt = new Date('2026-08-21T10:00:00.000Z');
    prisma.nightModeTransitionReconcileRequest.findUnique.mockResolvedValue({
      generation: 8n,
      manualBlockedAt: blockedAt,
      manualBlockedCategory: 'unsafe_prior_dispatch',
      manualBlockedFingerprint: `sha256:${'a'.repeat(64)}`,
      manualBlockedGeneration: 8n,
      manualAcknowledgedAt: null,
    });
    prisma.nightModeTransitionReconcileRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.acknowledgeNightModeTransitionBlock('chat-1', 'owner', {
        expectedGeneration: '8',
        expectedManualBlockedGeneration: '8',
        expectedManualBlockedAt: blockedAt.toISOString(),
        expectedCategory: 'unsafe_prior_dispatch',
        expectedFingerprint: `sha256:${'a'.repeat(64)}`,
        reason: 'Проигранная гонка',
      }),
    ).rejects.toThrow('Состояние night mode изменилось');

    expect(prisma.nightModeTransitionReconcileRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
