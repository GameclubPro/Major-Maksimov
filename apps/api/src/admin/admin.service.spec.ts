import {
  channelSettingsSchema,
  chatRulesSchema,
  chatSettingsSchema,
  managedBroadcastDetailsSchema,
  managedBroadcastSummarySchema,
  type ChatSummary,
} from '@maxim/contracts';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  type ChatRules as PersistedChatRules,
} from '../prisma/prisma-client';
import { buildDuplicateUserPattern } from '../moderation/duplicate-state';
import { buildDeveloperForcedGlobalSpammerCacheKey } from '../moderation/developer-forced-global-spammer-cache';
import { buildActiveMuteStateKey } from '../moderation/moderation-state.util';
import { buildCompactProfileMentionStartPayload } from '../max/max-deep-link.util';
import type { MaxClientService } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { Queue } from 'bullmq';
import type { AdminManualFanoutJob } from './admin-manual-fanout.queue';
import { AdminService } from './admin.service';
import { createGroupCommandPermitFixture } from '../common/group-command-authority.spec-support';
import { resolveAdminManagedEntitiesRefreshJitterMs } from './admin-managed-entities-refresh.queue';
import {
  selectLogsDashboardMembershipSummary,
  selectLogsDashboardModerationSummary,
} from './logs-dashboard-rollups';
import {
  AdminServicePrivateAccess,
  createChatSummaryFixture,
  createAssignedBotFixture,
  createManagedEntityHeaderFixture,
  expectChatRulesReadOptions,
  expectChatRulesSendOptions,
  expectChatRulesDeleteOptions,
  createAdminMaxBotLinkMock,
  createAdminServiceFixture,
  createPrismaMock,
  wireManagedBroadcastDeliveryStore,
  wireManagedBroadcastOccurrenceStore,
  extractSqlText,
  createDecimalLike,
  createConfigMock,
  createChatContextCacheMock,
  flushAsyncTasks,
  createDeferred,
  createLocalManagedEntityRow,
  decodeBase64UrlJson,
  readButtonUrl,
  readDialogButtonToken,
} from './admin-service-test-support';
import { moderationReleaseMessageOptions } from './moderation-release-test.util';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';

const TINY_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z';
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const MINIMAL_MP4_HEADER = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const MAX_UNSUPPORTED_IMAGE_MESSAGE =
  'Формат изображения не поддерживается MAX. Используйте JPG, PNG, GIF, TIFF, BMP или HEIC.';

function createRevokedTargetAdminMemberFixture() {
  return jest
    .fn<
      ReturnType<MaxClientService['getChatMembersAccess']>,
      Parameters<MaxClientService['getChatMembersAccess']>
    >()
    .mockImplementation(
      async (chatId, userIds) =>
        new Map(
          userIds.map((userId) => {
            const isBot = userId === '777000';
            const isAdmin = isBot || (userId === 'admin-1' && chatId !== 'chat-revoked');
            return [
              userId,
              {
                userId,
                isBot,
                isAdmin,
                isOwner: false,
                permissions: [],
                explicitPrivilegeEvidence: isAdmin,
                explicitNonPrivilegeEvidence: !isAdmin,
              },
            ];
          }),
        ),
    );
}

function createManualFanoutBotConfigFixture() {
  const config = createConfigMock();
  const readConfig = config.get.getMockImplementation()!;
  config.get.mockImplementation((key: string) =>
    key === 'MAX_BOTS_JSON'
      ? JSON.stringify([
          {
            id: 'bot-1',
            contactId: '777001',
            token: 'test-max-bot-token-1',
            webhookSecretPath: 'test-webhook-path-1',
            webhookHeaderSecret: 'test-webhook-header-1',
            state: 'active',
          },
          {
            id: 'bot-2',
            contactId: '777002',
            token: 'test-max-bot-token-2',
            webhookSecretPath: 'test-webhook-path-2',
            webhookHeaderSecret: 'test-webhook-header-2',
            state: 'active',
          },
        ])
      : readConfig(key),
  );
  return config;
}

function createManualFanoutBotLinkFixture() {
  const resolveBotRoute = jest.fn<
    ReturnType<MaxBotLinkService['resolveBotRoute']>,
    Parameters<MaxBotLinkService['resolveBotRoute']>
  >(async (request) => {
    const botId = request.chatId === 'chat-2' ? 'bot-2' : 'bot-1';
    const route = {
      chatId: request.chatId ?? null,
      primaryBotId: botId,
      botId,
      candidateBotIds: [botId],
      reason: 'primary_confirmed' as const,
    };
    if (request.purpose === 'moderation_action') {
      return { ...route, purpose: request.purpose, action: request.action };
    }
    if (request.purpose === 'capability') {
      return { ...route, purpose: request.purpose, capability: request.capability };
    }
    if (request.purpose === 'send_message') {
      return { ...route, purpose: request.purpose };
    }
    return { ...route, purpose: request.purpose };
  });
  return {
    ...createAdminMaxBotLinkMock(),
    resolveBotRoute,
    resolveBotRoutes: resolveBotRoute,
  };
}

function broadcastRuntime(service: AdminService): any {
  return (service as any).managedBroadcastRuntime;
}

async function waitForPendingFakeTimer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (jest.getTimerCount() > 0) return;
    await Promise.resolve();
  }
  throw new Error('Expected the retry timer to be scheduled.');
}

function expectImmediateMemberMutationOptions(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({
    immediate: true,
    beforeImmediateMemberMutation: expect.any(Function),
    ...overrides,
  });
}

const channelPublicationTextOptions = {
  textFormat: 'html',
  marketplacePublication: { purpose: 'PUBLICATION', entityId: 'channel-1' },
};

describe('AdminService rules publication confirmations', () => {
  it('describes an existing-post edit accurately in the private confirmation', async () => {
    const maxClient = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    const service = new AdminService(
      createPrismaMock() as never,
      maxClient as never,
      {} as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'resolvePrivateDeliveryBotId').mockReturnValue('personal-bot');
    jest.spyOn(service as any, 'resolvePrivateDialogChatId').mockResolvedValue('123');
    await service.sendPublishedChatRulesPrivateConfirmation(
      { userId: 'admin-1' } as never,
      'https://max.ru/c/-123/rules',
      'updated',
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '123',
      '✅ Правила обновлены в прежнем сообщении. Новое сообщение в группу не отправлялось.\nhttps://max.ru/c/-123/rules',
      undefined,
      expect.objectContaining({ botId: 'personal-bot' }),
    );
  });
});

describe('AdminService dialog admin fallback reads', () => {
  it('routes dialog admin id lookups through background action health lane', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('Request failed with status code 403'), {
          response: {
            status: 403,
            data: {
              code: 'chat.denied',
              message: 'Request failed with status code 403',
            },
          },
        }),
      ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    await expect((service as any).readDialogAdminUserIds('chat-1')).resolves.toEqual(new Set());

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('uses the chat-bound bot for dialog admin fallback reads when one is assigned', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
      buildBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildEntryBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
    };

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

    await expect((service as any).readDialogAdminUserIds('chat-1')).resolves.toEqual(new Set());

    expect(maxBotLinkService.resolveBotIdForCapability).toHaveBeenCalledWith({
      chatId: 'chat-1',
      capability: 'access_prewarm',
    });
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
      botId: 'id613002203036_4_bot',
    });
  });
});
describe('AdminService.getLogsDashboard', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps membership edge ranges outside complete rollup buckets', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ joined_users: '4', left_users: '1' }])
        .mockResolvedValueOnce([{ joined_users: '2', left_users: '1' }]),
    };

    const summary = await selectLogsDashboardMembershipSummary(
      prisma as never,
      'chat-1',
      new Date('2026-03-01T12:15:30.000Z'),
      new Date('2026-03-02T12:45:00.000Z'),
    );

    expect(summary).toEqual({ joinedUsers: 6, leftUsers: 2 });
    const edgeSqlText = extractSqlText(prisma.$queryRaw.mock.calls[1]);
    expect(edgeSqlText).toContain('FROM chat_membership_activity_feed_items');
    expect(edgeSqlText).toContain('UNION ALL');
    expect(edgeSqlText).toContain('COUNT(*) FILTER (WHERE event_type =');
  });

  it('keeps moderation edge ranges outside complete rollup buckets', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            warn: '3',
            deleteMessage: '2',
            mute: '1',
            ban: '1',
            unmute: '0',
            unban: '0',
            affectedUsers: 0,
          },
        ])
        .mockResolvedValueOnce([
          {
            warn: '1',
            deleteMessage: '1',
            mute: '0',
            ban: '0',
            unmute: '1',
            unban: '1',
            affectedUsers: 0,
          },
        ])
        .mockResolvedValueOnce([{ affected_users: '5' }]),
    };

    const summary = await selectLogsDashboardModerationSummary(
      prisma as never,
      'chat-1',
      new Date('2026-03-01T12:15:30.000Z'),
      new Date('2026-03-02T12:45:00.000Z'),
    );

    expect(summary).toEqual({
      warn: 4,
      deleteMessage: 3,
      mute: 1,
      ban: 1,
      unmute: 1,
      unban: 1,
      affectedUsers: 5,
    });
    const edgeSqlText = extractSqlText(prisma.$queryRaw.mock.calls[1]);
    expect(edgeSqlText).toContain('WITH moderation_edge_rows AS');
    expect(edgeSqlText).toContain('FROM moderation_events');
    expect(edgeSqlText).toContain('UNION ALL');
    expect(edgeSqlText).not.toContain('AND NOT');

    const affectedSqlText = extractSqlText(prisma.$queryRaw.mock.calls[2]);
    expect(affectedSqlText).toContain('chat_moderation_affected_user_hours');
    expect(affectedSqlText).toContain('FROM moderation_events');
    expect(affectedSqlText).toContain('UNION');
    expect(affectedSqlText).not.toContain('AND NOT');
  });

  it('returns membership and violations summary for selected chat', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ joined_users: '5', left_users: '2' }])
      .mockResolvedValueOnce([{ joined_users: '0', left_users: '0' }])
      .mockResolvedValueOnce([
        {
          warn: '3',
          deleteMessage: '4',
          mute: '1',
          ban: '2',
          unmute: '1',
          unban: '1',
          affectedUsers: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          warn: '0',
          deleteMessage: '0',
          mute: '0',
          ban: '0',
          unmute: '0',
          unban: '0',
          affectedUsers: 0,
        },
      ])
      .mockResolvedValueOnce([{ affected_users: '2' }])
      .mockResolvedValueOnce([
        {
          id: 'evt-1',
          action: 'WARN',
          ruleCode: 'PROFANITY',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T09:00:00.000Z'),
          maskedExcerpt: '***',
          metadata: { reason: 'Profanity detected' },
          userDisplayName: 'Алексей',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
        {
          id: 'evt-2',
          action: 'BAN',
          ruleCode: 'LINK_BLOCKED',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T08:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
          userDisplayName: 'Мария',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
        {
          id: 'evt-3',
          action: 'NONE',
          ruleCode: 'MANUAL_UNBAN',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T07:00:00.000Z'),
          maskedExcerpt: null,
          metadata: { reason: 'Ручной разбан участника через miniapp' },
          userDisplayName: 'Мария',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'wh-3',
          created_at: new Date('2026-03-02T10:00:00.000Z'),
          event_type: 'user_added',
          user_id: 'user-3',
          sender_name: 'Ирина',
        },
        {
          id: 'wh-2',
          created_at: new Date('2026-03-02T09:30:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-2',
          sender_name: 'Мария',
        },
      ]);
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              displayName: 'Алексей',
              username: 'aleksey',
              avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
            },
          ],
          [
            'user-2',
            {
              userId: 'user-2',
              displayName: 'Мария',
              username: 'maria',
              avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
            },
          ],
          [
            'user-3',
            {
              userId: 'user-3',
              displayName: 'Ирина',
              username: 'irina',
              avatarUrl: 'https://cdn.max.ru/u/3/avatar-full.jpg',
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
      getManagedEntityHeader: jest.fn().mockResolvedValue(
        createManagedEntityHeaderFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          entityType: 'chat',
          participantsCount: 1584,
        }),
      ),
    };
    const maxBotLinkService = {
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
      getBotTokenSync: jest.fn((botId?: string | null) =>
        botId?.trim() === 'channel-bot-2' ? 'test-channel-bot-token' : 'test-max-bot-token',
      ),
      getValidationTokens: jest
        .fn()
        .mockReturnValue(['test-max-bot-token', 'test-channel-bot-token']),
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

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d' },
    );

    expect(result.chat).toEqual({
      id: 'chat-1',
      title: 'Команда MAX',
      participantsCount: 1584,
      avatarUrl: null,
    });
    expect(result.membership).toEqual({ joinedUsers: 5, leftUsers: 2, netUsers: 3 });
    expect(result.violationsSummary).toEqual({
      warn: 3,
      deleteMessage: 4,
      mute: 1,
      ban: 2,
      unmute: 1,
      unban: 1,
      affectedUsers: 2,
      total: 12,
    });
    expect(result.violations).toHaveLength(3);
    expect(result.violations[0]?.userDisplayName).toBe('Алексей');
    expect(result.violations[0]?.avatarUrl).toBeNull();
    expect(result.violations[0]?.profileUrl).toBeNull();
    expect(result.violations[0]?.profileHandoffUrl).toEqual(
      expect.stringContaining('https://max.ru/777000_bot?start=pm'),
    );
    expect(result.violations[1]?.userDisplayName).toBe('Мария');
    expect(result.violations[1]?.avatarUrl).toBeNull();
    expect(result.violations[1]?.profileUrl).toBeNull();
    expect(result.violations[1]?.profileHandoffUrl).toEqual(
      expect.stringContaining('https://max.ru/777000_bot?start=pm'),
    );
    expect(result.violations[2]?.ruleCode).toBe('MANUAL_UNBAN');
    expect(result.moderationFeed).toEqual({
      items: result.violations,
      hasMore: false,
      nextCursor: null,
    });
    expect(result.activityFeed).toEqual({
      items: [
        {
          id: 'wh-3',
          type: 'joined',
          userId: 'user-3',
          userDisplayName: 'Ирина',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm'),
          createdAt: '2026-03-02T10:00:00.000Z',
        },
        {
          id: 'wh-2',
          type: 'left',
          userId: 'user-2',
          userDisplayName: 'Мария',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm'),
          createdAt: '2026-03-02T09:30:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    const querySqlTexts = prisma.$queryRaw.mock.calls.map((call) => extractSqlText(call));
    const membershipRollupSqlText =
      querySqlTexts.find((sqlText) => sqlText.includes('chat_membership_activity_rollups')) ?? '';
    expect(membershipRollupSqlText).toContain('chat_membership_activity_rollups');
    const membershipEdgeSummarySqlText =
      querySqlTexts.find(
        (sqlText) =>
          sqlText.includes('membership_edge_rows') &&
          sqlText.includes('COUNT(*) FILTER (WHERE event_type ='),
      ) ?? '';
    expect(membershipEdgeSummarySqlText).toContain('membership_edge_rows');
    const moderationRollupSqlText =
      querySqlTexts.find((sqlText) => sqlText.includes('chat_moderation_stats_rollups')) ?? '';
    expect(moderationRollupSqlText).toContain('chat_moderation_stats_rollups');
    expect(moderationRollupSqlText).not.toContain('affected_user_ids');
    const affectedSqlText =
      querySqlTexts.find((sqlText) => sqlText.includes('chat_moderation_affected_user_hours')) ??
      '';
    expect(affectedSqlText).toContain('chat_moderation_affected_user_hours');
    const moderationFeedSqlText =
      querySqlTexts.find((sqlText) => sqlText.includes('FROM chat_moderation_feed_items feed')) ??
      '';
    expect(moderationFeedSqlText).toContain('FROM chat_moderation_feed_items feed');
    const activitySqlText =
      querySqlTexts.find(
        (sqlText) =>
          sqlText.includes('FROM chat_membership_activity_feed_items') &&
          sqlText.includes('ORDER BY feed.event_at'),
      ) ?? '';
    expect(activitySqlText).toContain('FROM chat_membership_activity_feed_items');
    expect(activitySqlText).toContain('ORDER BY feed.event_at');

    expect(prisma.moderationEvent.groupBy).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
  });

  it('uses 24h period boundaries when range=24h', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ joined_users: '0', left_users: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          warn: '0',
          deleteMessage: '0',
          mute: '0',
          ban: '0',
          unmute: '0',
          unban: '0',
          affectedUsers: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          warn: '0',
          deleteMessage: '0',
          mute: '0',
          ban: '0',
          unmute: '0',
          unban: '0',
          affectedUsers: 0,
        },
      ])
      .mockResolvedValueOnce([{ affected_users: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const maxBotLinkService = {
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
      getBotTokenSync: jest.fn((botId?: string | null) =>
        botId?.trim() === 'channel-bot-2' ? 'test-channel-bot-token' : 'test-max-bot-token',
      ),
      getValidationTokens: jest
        .fn()
        .mockReturnValue(['test-max-bot-token', 'test-channel-bot-token']),
      resolveBotId: jest.fn().mockResolvedValue(undefined),
      resolveBotIdForCapability: jest.fn().mockResolvedValue(undefined),
      bindDiscoveredChatBots: jest.fn().mockResolvedValue(undefined),
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

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '24h' },
    );

    expect(result.period.range).toBe('24h');
    expect(result.period.from).toBe('2026-03-01T12:00:00.000Z');
    expect(result.period.to).toBe('2026-03-02T12:00:00.000Z');

    expect(prisma.moderationEvent.groupBy).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
    const moderationEdgeSqlText =
      prisma.$queryRaw.mock.calls
        .map((call) => extractSqlText(call))
        .find((sqlText) => sqlText.includes('WITH moderation_edge_rows AS')) ?? '';
    expect(moderationEdgeSqlText).toContain('FROM moderation_events');
    expect(moderationEdgeSqlText).toContain('created_at >=');
    expect(moderationEdgeSqlText).not.toContain('AND NOT');
  });

  it('skips non-requested preview feeds to keep dashboard responses lighter', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([]);

    const service = new AdminService(
      prisma as never,
      { getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']) } as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const result = await service.getLogsDashboard(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        range: '24h',
        includeActivityPreview: false,
        includeModerationPreview: false,
      },
    );

    expect(result.violations).toEqual([]);
    expect(result.moderationFeed).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(result.activityFeed).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.groupBy).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
  });

  it('reuses a short-lived cached dashboard response for identical requests', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ joined_users: '1', left_users: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          warn: '0',
          deleteMessage: '0',
          mute: '0',
          ban: '0',
          unmute: '0',
          unban: '0',
          affectedUsers: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          warn: '0',
          deleteMessage: '0',
          mute: '0',
          ban: '0',
          unmute: '0',
          unban: '0',
          affectedUsers: 0,
        },
      ])
      .mockResolvedValueOnce([{ affected_users: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.moderationEvent.groupBy.mockResolvedValueOnce([]);

    const service = new AdminService(
      prisma as never,
      { getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']) } as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const first = await service.getLogsDashboard('chat-1', actor, { range: '24h' });
    const second = await service.getLogsDashboard('chat-1', actor, { range: '24h' });

    expect(second).toEqual(first);
    expect(prisma.moderationEvent.groupBy).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(7);
  });

  it('keeps dashboard and moderation feed profile resolution on the local fast path', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          warn: '0',
          deleteMessage: '0',
          mute: '0',
          ban: '2',
          unmute: '0',
          unban: '0',
          affectedUsers: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          warn: '0',
          deleteMessage: '0',
          mute: '0',
          ban: '0',
          unmute: '0',
          unban: '0',
          affectedUsers: 0,
        },
      ])
      .mockResolvedValueOnce([{ affected_users: '2' }])
      .mockResolvedValueOnce([
        {
          id: 'evt-ban-2',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T11:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
          userDisplayName: 'Мария',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
          userDisplayName: 'Алексей',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'evt-ban-2',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T11:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
          userDisplayName: 'Мария',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          maskedExcerpt: null,
          metadata: null,
          userDisplayName: 'Алексей',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
      ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              displayName: 'Алексей',
              username: 'aleksey',
              avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
            },
          ],
          [
            'user-2',
            {
              userId: 'user-2',
              displayName: 'Мария',
              username: 'maria',
              avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
            },
          ],
        ]),
      ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    await service.getLogsDashboard('chat-1', actor, {
      range: '24h',
      includeActivityPreview: false,
      includeModerationPreview: true,
    });
    const moderationFeed = await service.getChatModerationFeed('chat-1', actor, {
      range: '24h',
      filter: 'ALL',
      limit: 50,
    });

    expect(moderationFeed.items).toHaveLength(2);
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.groupBy).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
  });
});

describe('AdminService.getChatActivityFeed', () => {
  it('respects filter, limit, cursor and falls back to resolved names without remote profile lookup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'wh-left-2',
          created_at: new Date('2026-03-02T11:00:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-5',
          sender_name: null,
        },
        {
          id: 'wh-left-1',
          created_at: new Date('2026-03-02T10:00:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-4',
          sender_name: 'Мария',
        },
      ])
      .mockResolvedValueOnce([{ user_id: 'user-5', sender_name: 'Игорь' }])
      .mockResolvedValueOnce([
        {
          id: 'wh-left-1',
          created_at: new Date('2026-03-02T10:00:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-4',
          sender_name: 'Мария',
        },
      ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-4',
            {
              userId: 'user-4',
              displayName: 'Мария',
              username: 'maria',
              avatarUrl: 'https://cdn.max.ru/u/4/avatar-full.jpg',
            },
          ],
          [
            'user-5',
            {
              userId: 'user-5',
              displayName: 'Игорь',
              username: null,
              avatarUrl: 'https://cdn.max.ru/u/5/avatar-full.jpg',
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const maxBotLinkService = {
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

    const firstPage = await service.getChatActivityFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'left', limit: 1 },
    );

    expect(firstPage.items).toEqual([
      {
        id: 'wh-left-2',
        type: 'left',
        userId: 'user-5',
        userDisplayName: 'Игорь',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
        createdAt: '2026-03-02T11:00:00.000Z',
      },
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await service.getChatActivityFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'left', limit: 1, cursor: firstPage.nextCursor ?? undefined },
    );

    expect(secondPage).toEqual({
      items: [
        {
          id: 'wh-left-1',
          type: 'left',
          userId: 'user-4',
          userDisplayName: 'Мария',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-02T10:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();

    const activitySqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(activitySqlText).toContain('FROM chat_membership_activity_feed_items');
    expect(activitySqlText).toContain('ORDER BY feed.event_at');
  });

  it('reads membership snapshot names inline without a second local-history query', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        id: 'wh-left-snapshot',
        created_at: new Date('2026-03-02T11:00:00.000Z'),
        event_type: 'user_removed',
        user_id: 'user-5',
        sender_name: 'Игорь из snapshot',
      },
    ]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.getChatActivityFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'left', limit: 20 },
    );

    expect(result.items[0]?.userDisplayName).toBe('Игорь из snapshot');
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const activitySqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(activitySqlText).toContain('FROM chat_user_display_names AS snapshot');
    expect(activitySqlText).toContain('snapshot.chat_id = feed.chat_id');
    expect(activitySqlText).toContain('snapshot.user_id = feed.user_id');
  });

  it('rechecks cached granted access before reading channel activity feeds', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'wh-channel-join-1',
        created_at: new Date('2026-03-02T11:00:00.000Z'),
        event_type: 'user_added',
        user_id: 'user-1',
        sender_name: 'Участник канала',
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
      getChatMemberProfiles: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.getChannelActivityFeed(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { range: '7d', filter: 'all', limit: 20 },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('deduplicates membership events produced by different bots for the same user and timestamp', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'wh-join-canonical',
          created_at: new Date('2026-03-02T11:00:00.000Z'),
          event_type: 'user_added',
          user_id: 'user-7',
          sender_name: 'Наталья',
        },
      ])
      .mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const result = await service.getChatActivityFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'joined', limit: 20 },
    );

    expect(result).toEqual({
      items: [
        {
          id: 'wh-join-canonical',
          type: 'joined',
          userId: 'user-7',
          userDisplayName: 'Наталья',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-02T11:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });
});

describe('AdminService.getChatModerationFeed', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('paginates filtered moderation events and keeps local display names on the fast path', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'evt-ban-3',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-3',
          createdAt: new Date('2026-03-02T11:00:00.000Z'),
          maskedExcerpt: null,
          metadata: { permanent: true },
          userDisplayName: 'Анна',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
        {
          id: 'evt-ban-2',
          action: 'BAN',
          ruleCode: 'LINK_BLOCKED',
          userId: 'user-2',
          createdAt: new Date('2026-03-02T10:30:00.000Z'),
          maskedExcerpt: '***',
          metadata: null,
          userDisplayName: 'Мария',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'DUPLICATE_BAN',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T09:00:00.000Z'),
          maskedExcerpt: null,
          metadata: { duplicateCount: 4 },
          userDisplayName: 'Игорь',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'DUPLICATE_BAN',
          userId: 'user-1',
          createdAt: new Date('2026-03-02T09:00:00.000Z'),
          maskedExcerpt: null,
          metadata: { duplicateCount: 4 },
          userDisplayName: 'Игорь',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
        },
      ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest
        .fn()
        .mockResolvedValueOnce(
          new Map([
            [
              'user-3',
              {
                userId: 'user-3',
                displayName: 'Анна',
                username: 'anna',
                avatarUrl: 'https://cdn.max.ru/u/3/avatar-full.jpg',
              },
            ],
            [
              'user-2',
              {
                userId: 'user-2',
                displayName: 'Мария',
                username: 'maria',
                avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
              },
            ],
          ]),
        )
        .mockResolvedValueOnce(
          new Map([
            [
              'user-1',
              {
                userId: 'user-1',
                displayName: 'Игорь',
                username: null,
                avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
              },
            ],
          ]),
        ),
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

    const firstPage = await service.getChatModerationFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'BAN', limit: 2 },
    );

    expect(firstPage.items).toEqual([
      {
        id: 'evt-ban-3',
        action: 'BAN',
        ruleCode: 'MANUAL_BAN',
        userId: 'user-3',
        userDisplayName: 'Анна',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
        createdAt: '2026-03-02T11:00:00.000Z',
        maskedExcerpt: null,
        metadata: { permanent: true },
      },
      {
        id: 'evt-ban-2',
        action: 'BAN',
        ruleCode: 'LINK_BLOCKED',
        userId: 'user-2',
        userDisplayName: 'Мария',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
        createdAt: '2026-03-02T10:30:00.000Z',
        maskedExcerpt: '***',
        metadata: null,
      },
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await service.getChatModerationFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'BAN', limit: 2, cursor: firstPage.nextCursor ?? undefined },
    );

    expect(secondPage).toEqual({
      items: [
        {
          id: 'evt-ban-1',
          action: 'BAN',
          ruleCode: 'DUPLICATE_BAN',
          userId: 'user-1',
          userDisplayName: 'Игорь',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-02T09:00:00.000Z',
          maskedExcerpt: null,
          metadata: { duplicateCount: 4 },
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();

    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
    const firstSqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]);
    expect(firstSqlText).toContain('FROM chat_moderation_feed_items feed');
    expect(firstSqlText).toContain("feed.action IN ('BAN', 'KICK')");
    expect(firstSqlText).toContain('ORDER BY feed.created_at DESC, feed.id DESC');

    const secondSqlText = extractSqlText(prisma.$queryRaw.mock.calls[1]);
    expect(secondSqlText).toContain('(feed.created_at, feed.id) < (');
  });

  it('reads moderation snapshot names inline without loading MAX member profiles', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        id: 'evt-ban-local-name',
        action: 'BAN',
        ruleCode: 'MANUAL_BAN',
        userId: 'user-4',
        createdAt: new Date('2026-03-02T11:15:00.000Z'),
        maskedExcerpt: null,
        metadata: null,
        userDisplayName: 'Людмила',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.getChatModerationFeed(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { range: '7d', filter: 'BAN', limit: 50 },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'evt-ban-local-name',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-4',
          userDisplayName: 'Людмила',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-02T11:15:00.000Z',
          maskedExcerpt: null,
          metadata: null,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const moderationFeedSql = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(moderationFeedSql).toContain('FROM chat_user_display_names AS snapshot');
    expect(moderationFeedSql).toContain('snapshot.chat_id = feed.chat_id');
    expect(moderationFeedSql).toContain('snapshot.user_id = feed.user_id');
  });

  it('prefers stored target display names from moderation event metadata when profile lookup is empty', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-02T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'evt-ban-4',
        action: 'BAN',
        ruleCode: 'MANUAL_BAN',
        userId: 'user-4',
        createdAt: new Date('2026-03-02T11:15:00.000Z'),
        maskedExcerpt: null,
        metadata: {
          permanent: true,
          targetDisplayName: 'Людмила',
        },
        userDisplayName: null,
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.getChatModerationFeed(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', filter: 'BAN', limit: 50 },
    );

    expect(result).toEqual({
      items: [
        {
          id: 'evt-ban-4',
          action: 'BAN',
          ruleCode: 'MANUAL_BAN',
          userId: 'user-4',
          userDisplayName: 'Людмила',
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-02T11:15:00.000Z',
          maskedExcerpt: null,
          metadata: {
            permanent: true,
            targetDisplayName: 'Людмила',
          },
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
  });
});

describe('AdminService.applyManualModerationAction', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('refuses to manually moderate configured runtime bots', async () => {
    const service = Object.create(AdminService.prototype) as any;
    service.maxBotRegistry = {
      isKnownBotUserId: jest.fn().mockReturnValue(true),
    };

    await expect(
      service.assertTargetUserCanBeModerated('chat-1', '613002203036_5', 'BAN'),
    ).rejects.toThrow(BadRequestException);
  });

  it('records manual mute without removing the participant from chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };
    const redisCounter = {
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'MUTE', muteDurationHours: 6 },
    );

    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-2',
          ruleCode: 'MANUAL_MUTE',
          action: 'MUTE',
          operator: 'ADMIN',
          metadata: expect.objectContaining({
            muteDurationHours: 6,
            muteExpiresAt: expect.any(String),
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          actorUserId: 'admin-1',
          action: 'MANUAL_MUTE_MEMBER',
        }),
      }),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-1', 'user-2'),
      expect.any(String),
      expect.any(Number),
    );
    const cachedMuteState = JSON.parse(redisCounter.setStringWithTtl.mock.calls[0]?.[1]);
    expect(cachedMuteState).toEqual(
      expect.objectContaining({
        durationHours: 6,
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'MUTE',
      userId: 'user-2',
      muteDurationHours: 6,
      muteExpiresAt: expect.any(String),
      message: 'Мут включён на 6 ч.',
    });
  });

  it('stores resolved target display name in manual moderation metadata', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'user-2', sender_name: 'Мария' }]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'MUTE', muteDurationHours: 6 },
    );

    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            targetDisplayName: 'Мария',
          }),
        }),
      }),
    );
  });

  it('keeps miniapp manual ban scoped to the current chat when requested', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN', scope: 'current_chat' },
    );

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalledWith('chat-2', 'user-3', {
      trafficClass: 'background',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: '777000_bot',
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          metadata: expect.objectContaining({
            source: 'miniapp',
            scope: 'current_chat',
            sourceMessageCleanup: expect.objectContaining({
              candidateCount: 1,
              deletedCount: 1,
            }),
            crossChatFanout: expect.objectContaining({
              removedChatsCount: 0,
              removedChatIds: [],
            }),
          }),
        }),
      }),
    );
  });

  it('queues miniapp manual mute fanout when all chats are requested', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
    );

    await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'MUTE', muteDurationHours: 6, scope: 'all_chats' },
    );

    expect(adminManualFanoutQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_mute_fanout',
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        cleanupSourceChatMessages: true,
        muteDurationHours: 6,
        source: 'miniapp',
      }),
      expect.objectContaining({
        priority: 20,
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          metadata: expect.objectContaining({
            source: 'miniapp',
            scope: 'all_chats',
            crossChatMuteFanout: expect.objectContaining({
              mode: 'queued',
            }),
          }),
        }),
      }),
    );
  });

  it('keeps timed manual mute from command scoped to the source chat', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'MUTE', muteDurationHours: 6 },
      'group_command',
    );

    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalledWith(
      'chat-2',
      'user-2',
      expect.anything(),
    );
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-2',
          ruleCode: 'MANUAL_MUTE',
          action: 'MUTE',
          metadata: expect.objectContaining({
            scope: 'current_chat',
            muteDurationHours: 6,
          }),
        }),
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.not.objectContaining({
            sourceMessageCleanup: expect.anything(),
            crossChatMuteFanout: expect.anything(),
          }),
        }),
      }),
    );
    expect(
      prisma.moderationEvent.create.mock.calls.some(
        (call: readonly [Record<string, unknown>]) =>
          (call[0] as { data?: { chatId?: string } }).data?.chatId === 'chat-2',
      ),
    ).toBe(false);
    expect(result).toEqual({
      ok: true,
      action: 'MUTE',
      userId: 'user-2',
      muteDurationHours: 6,
      muteExpiresAt: expect.any(String),
      message: 'Мут включён на 6 ч.',
    });
  });

  it('keeps permanent manual mute from command scoped to the source chat', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'MUTE', mutePermanent: true },
      'group_command',
    );

    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalledWith(
      'chat-2',
      'user-2',
      expect.anything(),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-2',
          ruleCode: 'MANUAL_MUTE',
          action: 'MUTE',
          metadata: expect.objectContaining({
            scope: 'current_chat',
            mutePermanent: true,
            muteDurationHours: null,
            muteExpiresAt: null,
          }),
        }),
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.not.objectContaining({
            sourceMessageCleanup: expect.anything(),
            crossChatMuteFanout: expect.anything(),
          }),
        }),
      }),
    );
    expect(
      prisma.moderationEvent.create.mock.calls.some(
        (call: readonly [Record<string, unknown>]) =>
          (call[0] as { data?: { chatId?: string } }).data?.chatId === 'chat-2',
      ),
    ).toBe(false);
    expect(result).toEqual({
      ok: true,
      action: 'MUTE',
      userId: 'user-2',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Мут включён без срока.',
    });
  });

  it('applies permanent manual ban without scheduling auto-unban', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN' },
    );

    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3');
    expect(prisma.adminGlobalSpammerExemption.deleteMany).toHaveBeenCalledWith({
      where: {
        adminUserId: 'admin-1',
        userId: 'user-3',
      },
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-3',
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
          operator: 'ADMIN',
          metadata: expect.objectContaining({
            mode: 'MAX_BLOCK',
            permanent: true,
          }),
        }),
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Для участника [Пользователь](max://user/user-3) включён бан.',
      moderationReleaseMessageOptions('UNBAN', 'moderation-event-1', 'chat-1'),
      { immediate: true },
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Бан включён.',
    });
  });

  it('routes manual ban through an action-capable standby bot', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => {
          const botId = (options as { botId?: string } | undefined)?.botId ?? 'primary-bot';
          return {
            userId: botId,
            isAdmin: true,
            isOwner: false,
            permissions: botId === 'standby-bot' ? ['add_remove_members'] : ['read_all_messages'],
          };
        }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'primary-bot',
          botId: 'primary-bot',
          candidateBotIds: ['primary-bot', 'standby-bot'],
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'primary-bot' }, { id: 'standby-bot' }]),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

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
      maxBotRegistry as never,
    );

    await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN' },
    );

    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expect.objectContaining({
        botId: 'standby-bot',
      }),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3', {
      botId: 'standby-bot',
    });
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions({ botId: 'standby-bot' }),
    );
  });

  it('routes manual mute through a delete-capable standby bot', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => {
          const botId = (options as { botId?: string } | undefined)?.botId ?? 'primary-bot';
          return {
            userId: botId,
            isAdmin: true,
            isOwner: false,
            permissions:
              botId === 'standby-bot' ? ['read_all_messages', 'write'] : ['read_all_messages'],
          };
        }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'primary-bot',
          botId: 'primary-bot',
          candidateBotIds: ['primary-bot', 'standby-bot'],
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'primary-bot' }, { id: 'standby-bot' }]),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

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
      maxBotRegistry as never,
    );

    await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'MUTE', muteDurationHours: 6 },
    );

    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-2',
      expect.objectContaining({
        botId: 'standby-bot',
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-2',
          ruleCode: 'MANUAL_MUTE',
          action: 'MUTE',
        }),
      }),
    );
  });

  it('rejects manual mute when MAX omits confirmed chat delete capability', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'primary-bot',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'primary-bot',
          botId: 'primary-bot',
          candidateBotIds: ['primary-bot'],
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'primary-bot' }]),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

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
      maxBotRegistry as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-2',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'MUTE', muteDurationHours: 6 },
      ),
    ).rejects.toThrow('Не найден бот MAX с подтвержденным правом выполнить действие модерации');

    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('rejects manual ban when no live-verified bot has add_remove_members', async () => {
    const prisma = createPrismaMock();
    const candidateBotIds = ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6'];
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => ({
          userId: options?.botId ?? 'bot-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages'],
        })),
      getChatMemberAccess: jest.fn(),
      banMember: jest.fn(),
      kickMember: jest.fn(),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds,
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue(candidateBotIds.map((id) => ({ id }))),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

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
      maxBotRegistry as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-3',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'BAN' },
      ),
    ).rejects.toThrow('Не найден бот MAX с подтвержденным правом выполнить действие модерации');

    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('continues manual ban candidate probing until the sixth bot has add_remove_members', async () => {
    const prisma = createPrismaMock();
    const candidateBotIds = ['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6'];
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => {
          const botId = options?.botId ?? 'bot-1';
          return {
            userId: botId,
            isAdmin: true,
            isOwner: false,
            permissions: botId === 'bot-6' ? ['add_remove_members'] : ['read_all_messages'],
          };
        }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds,
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue(candidateBotIds.map((id) => ({ id }))),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

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
      maxBotRegistry as never,
    );

    await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN' },
    );

    const probedBotIds = maxClient.getCurrentChatMemberAccess.mock.calls
      .map((call) => (call[1] as { botId?: string } | undefined)?.botId)
      .filter((botId): botId is string => Boolean(botId));
    expect(probedBotIds.slice(0, 6)).toEqual(candidateBotIds);
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expect.objectContaining({ botId: 'bot-6' }),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3', {
      botId: 'bot-6',
    });
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions({ botId: 'bot-6' }),
    );
  });

  it('routes manual unban through a member-moderation-capable standby bot', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => {
          const botId = options?.botId ?? 'primary-bot';
          return {
            userId: botId,
            isAdmin: true,
            isOwner: false,
            permissions: botId === 'standby-bot' ? ['add_remove_members'] : ['read_all_messages'],
          };
        }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'primary-bot',
          botId: 'primary-bot',
          candidateBotIds: ['primary-bot', 'standby-bot'],
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'primary-bot' }, { id: 'standby-bot' }]),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

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
      maxBotRegistry as never,
    );

    await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNBAN' },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3', {
      botId: 'standby-bot',
    });
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expect.objectContaining({
        botId: 'standby-bot',
      }),
    );
    expect(maxClient.unbanMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions({ botId: 'standby-bot' }),
    );
  });

  it('does not fall back to the first manual moderation bot after transient access lookup failure', async () => {
    const prisma = createPrismaMock();
    const timeoutError = Object.assign(new Error('timeout of 5000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockRejectedValue(timeoutError),
      getChatMemberAccess: jest.fn(),
      banMember: jest.fn(),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoutes: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_soft',
        action: 'moderate_member',
      }),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

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
      maxBotRegistry as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-3',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'BAN' },
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('rejects manual mute when the selected bot is not a chat admin', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'primary-bot',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      getChatMemberAccess: jest.fn(),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'primary-bot',
          botId: 'primary-bot',
          candidateBotIds: ['primary-bot'],
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'primary-bot' }]),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

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
      maxBotRegistry as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-2',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'MUTE', muteDurationHours: 6 },
      ),
    ).rejects.toThrow('Не найден бот MAX с подтвержденным правом выполнить действие модерации');

    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('fans out miniapp manual ban after source chat cleanup and removes recent messages from the last 24 hours', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }, { message_id: 'mid-source-2' }])
      .mockResolvedValueOnce([{ message_id: 'mid-fanout-1' }]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN' },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3', {
      botId: '777000_bot',
    });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-2', 'user-3', {
      botId: '777000_bot',
    });
    expect(maxClient.banMember).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.banMember).toHaveBeenNthCalledWith(
      2,
      'chat-2',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(1, 'chat-1', 'mid-source-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: '777000_bot',
    });
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(2, 'chat-1', 'mid-source-2', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: '777000_bot',
    });
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(3, 'chat-2', 'mid-fanout-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: '777000_bot',
    });
    expect(maxClient.banMember.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.deleteMessage.mock.invocationCallOrder[0],
    );
    expect(maxClient.deleteMessage.mock.invocationCallOrder[1]).toBeLessThan(
      maxClient.banMember.mock.invocationCallOrder[1],
    );
    const recentMessageCleanupSqlTexts = prisma.$queryRaw.mock.calls
      .map((call) => extractSqlText(call))
      .filter(
        (sqlText) =>
          sqlText.includes('SELECT message_id') && sqlText.includes('FROM webhook_events'),
      );
    expect(recentMessageCleanupSqlTexts).toHaveLength(2);
    for (const sqlText of recentMessageCleanupSqlTexts) {
      expect(sqlText).toContain("normalized_payload->'message'->>'senderId'");
      expect(sqlText).toContain("normalized_payload->'message'->>'chatId'");
      expect(sqlText).toContain(
        "NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') IS NOT NULL",
      );
    }
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-3',
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
          metadata: expect.objectContaining({
            source: 'miniapp',
            sourceMessageCleanup: {
              candidateCount: 2,
              deletedCount: 2,
              pendingCount: 0,
              failedCount: 0,
            },
            crossChatFanout: expect.objectContaining({
              removedChatsCount: 1,
              removedChatIds: ['chat-2'],
              deletedMessageCount: 1,
              failedMessageDeleteCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Бан включён.',
    });
  });

  it('queues miniapp manual ban cleanup and fanout when the background queue is available', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN' },
    );

    expect(adminManualFanoutQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_ban_fanout',
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        source: 'miniapp',
      }),
      expect.objectContaining({
        priority: 20,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
      }),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            sourceMessageCleanup: expect.objectContaining({
              mode: 'queued',
              candidateCount: 0,
              deletedCount: 0,
            }),
            crossChatFanout: expect.objectContaining({
              mode: 'queued',
              removedChatsCount: 0,
              removedChatIds: [],
              deletedMessageCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'BAN',
        userId: 'user-3',
        message: 'Бан включён.',
      }),
    );
  });

  it('falls back to removal-only permanent manual ban for closed chats without link', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Закрытый чат',
        participantsCount: 6,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'chat',
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn(),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN' },
    );

    expect(maxClient.kickMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            mode: 'MAX_REMOVE_ONLY',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Участник удалён из чата.',
    });
  });

  it('returns clear error when bot lacks add_remove_members for manual ban', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['change_chat_info'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      banMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-3',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'BAN' },
      ),
    ).rejects.toThrow(
      'В правах бота нет управления участниками (add_remove_members), поэтому бан недоступен.',
    );

    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('returns clear error when manual ban target is no longer in chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      banMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-3',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'BAN' },
      ),
    ).rejects.toThrow('Участник уже вышел из чата или был удалён.');

    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('still applies manual ban when cancelling a stale auto-unban fails', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockRejectedValue({
        response: { data: { message: 'Не удалось заменить старый авторазбан.' } },
      }),
      banMember: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const globalSpammerIntelligence = {
      recordManualBanObservation: jest.fn().mockResolvedValue({ outcome: 'candidate' }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as unknown as { globalSpammerIntelligence: unknown }).globalSpammerIntelligence =
      globalSpammerIntelligence;

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-rollback',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN' },
    );

    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-rollback',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(globalSpammerIntelligence.recordManualBanObservation).toHaveBeenCalledWith({
      targetUserId: 'user-rollback',
      chatId: 'chat-1',
      actorUserId: 'admin-1',
      source: 'miniapp',
      executionMode: 'MAX_BLOCK',
    });
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-rollback',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Бан включён.',
    });
  });

  it('cancels pending auto-unban before manual unban and records the action', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const redisCounter = {
      deleteKeysByPattern: jest.fn().mockResolvedValue(4),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };
    const globalSpammerIntelligence = {
      recordLocalAdminDecision: jest.fn().mockResolvedValue({ ok: true }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
    );
    (service as unknown as { globalSpammerIntelligence: unknown }).globalSpammerIntelligence =
      globalSpammerIntelligence;

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-4',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNBAN' },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4');
    expect(maxClient.unbanMember).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expectImmediateMemberMutationOptions(),
    );
    expect(redisCounter.deleteKeysByPattern).toHaveBeenCalledWith(
      buildDuplicateUserPattern('chat-1', 'user-4'),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-1', 'user-4'),
      '0',
      expect.any(Number),
    );
    expect(prisma.adminGlobalSpammerExemption.upsert).toHaveBeenCalledWith({
      where: {
        adminUserId_userId: {
          adminUserId: 'admin-1',
          userId: 'user-4',
        },
      },
      create: {
        adminUserId: 'admin-1',
        userId: 'user-4',
        sourceChatId: 'chat-1',
        decision: 'ALLOW',
        reason: 'MANUAL_UNBAN',
      },
      update: {
        sourceChatId: 'chat-1',
        decision: 'ALLOW',
        reason: 'MANUAL_UNBAN',
      },
    });
    expect(globalSpammerIntelligence.recordLocalAdminDecision).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-4',
      reviewerUserId: 'admin-1',
      decision: 'ALLOW',
      reason: 'MANUAL_UNBAN',
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-4',
          ruleCode: 'MANUAL_UNBAN',
          action: 'NONE',
          operator: 'ADMIN',
          metadata: expect.objectContaining({
            mode: 'MAX_UNBLOCK',
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'MANUAL_UNBAN_MEMBER',
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'UNBAN',
      userId: 'user-4',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Блокировка снята, участник возвращён в чат.',
    });
  });

  it('uses the resolved chat bot for manual unban in multi-bot chats', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).resolveBotAssignmentRouteAware = jest
      .fn()
      .mockResolvedValue({ botId: 'bot-2', routeResolved: true });

    await service.applyManualModerationAction(
      'chat-1',
      'user-4',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNBAN' },
    );

    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expect.objectContaining({
        botId: 'bot-2',
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        botId: 'bot-2',
        bypassCache: true,
      }),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4', {
      botId: 'bot-2',
    });
    expect(maxClient.unbanMember).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expectImmediateMemberMutationOptions({ botId: 'bot-2' }),
    );
  });

  it('repairs missing chat bot assignment before manual unban', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({ primaryBotId: null, botId: null });
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockRejectedValueOnce({
          response: { status: 403, data: { code: 'chat.denied', message: 'not in chat' } },
        })
        .mockResolvedValueOnce({
          userId: 'bot-2-user',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        })
        .mockResolvedValueOnce({
          userId: 'bot-2-user',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      bindChatToBot: jest.fn().mockResolvedValue('bot-2'),
      resolveBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => {
        if (!botId) {
          return null;
        }
        return { id: botId };
      }),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };

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
      maxBotRegistry as never,
    );
    (service as any).prepareManualModerationTarget = jest.fn().mockResolvedValue('user-4');

    await service.applyManualModerationAction(
      'chat-1',
      'user-4',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNBAN' },
    );

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'critical',
        botId: 'bot-1',
        bypassCache: true,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'critical',
        botId: 'bot-2',
        bypassCache: true,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'CHAT',
      botId: 'bot-2',
    });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4', {
      botId: 'bot-2',
    });
    expect(maxClient.unbanMember).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expectImmediateMemberMutationOptions({ botId: 'bot-2' }),
    );
  });

  it('rebinds manual unban to another actionable bot when persisted bot lost admin access', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({ primaryBotId: 'bot-1', botId: 'bot-1' });
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockRejectedValueOnce({
          response: { status: 403, data: { code: 'chat.denied', message: 'not in chat' } },
        })
        .mockResolvedValueOnce({
          userId: 'bot-2-user',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        })
        .mockResolvedValueOnce({
          userId: 'bot-2-user',
          isAdmin: true,
          isOwner: false,
          permissions: ['add_remove_members'],
        }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      bindChatToBot: jest.fn().mockResolvedValue('bot-2'),
      resolveBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => {
        if (!botId) {
          return null;
        }
        return { id: botId };
      }),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };

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
      maxBotRegistry as never,
    );
    (service as any).prepareManualModerationTarget = jest.fn().mockResolvedValue('user-4');

    await service.applyManualModerationAction(
      'chat-1',
      'user-4',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNBAN' },
    );

    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'critical',
        botId: 'bot-1',
        bypassCache: true,
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'critical',
        botId: 'bot-2',
        bypassCache: true,
      }),
    );
    expect(maxBotLinkService.bindChatToBot).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'CHAT',
      botId: 'bot-2',
    });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4', {
      botId: 'bot-2',
    });
    expect(maxClient.unbanMember).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expectImmediateMemberMutationOptions({ botId: 'bot-2' }),
    );
  });

  it('prefers the multi-bot read route over a stale persisted bot assignment', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({ primaryBotId: 'bot-1', botId: 'bot-1' });
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'read',
        chatId: 'chat-1',
        primaryBotId: 'bot-2',
        botId: 'bot-2',
        candidateBotIds: ['bot-2'],
        reason: 'alternate_confirmed',
      }),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
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
      maxBotRegistry as never,
    );

    await expect((service as any).resolveChatBotIdForRead('chat-1')).resolves.toBe('bot-2');

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'read',
      chatId: 'chat-1',
    });
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('does not fall back to a persisted read bot when the route resolver has no safe bot', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({ primaryBotId: 'dormant-bot', botId: 'dormant-bot' });
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'read',
        chatId: 'chat-1',
        primaryBotId: null,
        botId: null,
        candidateBotIds: [],
        reason: null,
      }),
      resolveBotIdForRead: jest.fn().mockResolvedValue('dormant-bot'),
      resolveBotId: jest.fn().mockResolvedValue('dormant-bot'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
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
      maxBotRegistry as never,
    );

    await expect((service as any).resolveChatBotIdForRead('chat-1')).resolves.toBeUndefined();

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'read',
      chatId: 'chat-1',
    });
    expect(maxBotLinkService.resolveBotIdForRead).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('uses the channel send route for engagement publication actions', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'bot-1'],
        reason: 'alternate_confirmed',
      }),
      bindChatToBot: jest.fn().mockResolvedValue('bot-2'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'bot-1' }, { id: 'bot-2' }]),
    };
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
      maxBotRegistry as never,
    );

    await expect(service.resolveChannelEngagementActionBotId('channel-1')).resolves.toBe('bot-2');

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not fall back to a persisted send bot when the send route has no executable bot', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      primaryBotId: 'draining-bot',
      botId: 'draining-bot',
    });
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: null,
        botId: null,
        candidateBotIds: [],
        reason: null,
      }),
      resolveBotIdForSend: jest.fn().mockResolvedValue('draining-bot'),
      resolveBotId: jest.fn().mockResolvedValue('draining-bot'),
      bindChatToBot: jest.fn().mockResolvedValue('draining-bot'),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue([{ id: 'draining-bot' }]),
    };
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
      maxBotRegistry as never,
    );

    await expect(service.resolveChannelEngagementActionBotId('channel-1')).resolves.toBeUndefined();

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindChatToBot).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('releases active block without re-adding a member who is already in chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-4',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn(),
      clearTerminalBanStateAfterConfirmedUnban: jest.fn().mockResolvedValue(undefined),
    };
    const redisCounter = {
      deleteKeysByPattern: jest.fn().mockResolvedValue(2),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-4',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'UNBAN' },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4');
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(maxClient.clearTerminalBanStateAfterConfirmedUnban).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
    );
    expect(redisCounter.deleteKeysByPattern).toHaveBeenCalledWith(
      buildDuplicateUserPattern('chat-1', 'user-4'),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-1', 'user-4'),
      '0',
      expect.any(Number),
    );
    expect(prisma.adminGlobalSpammerExemption.upsert).toHaveBeenCalledWith({
      where: {
        adminUserId_userId: {
          adminUserId: 'admin-1',
          userId: 'user-4',
        },
      },
      create: {
        adminUserId: 'admin-1',
        userId: 'user-4',
        sourceChatId: 'chat-1',
        decision: 'ALLOW',
        reason: 'MANUAL_UNBAN',
      },
      update: {
        sourceChatId: 'chat-1',
        decision: 'ALLOW',
        reason: 'MANUAL_UNBAN',
      },
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            mode: 'ALREADY_PRESENT',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'UNBAN',
      userId: 'user-4',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Блокировка снята. Участник уже в чате, добавлять его повторно не понадобилось.',
    });
  });

  it('returns clear error when bot lacks add_remove_members for manual unban', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['change_chat_info'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-4',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'UNBAN' },
      ),
    ).rejects.toThrow(
      'В правах бота нет управления участниками (add_remove_members), поэтому снять блокировку нельзя.',
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4');
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
  });

  it('returns a clearer fallback when MAX rejects manual unban without details', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockRejectedValue(new Error('Request failed with status code 400')),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-4',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { action: 'UNBAN' },
      ),
    ).rejects.toThrow(
      'Участника не удалось вернуть в чат: MAX отклонил действие. Проверьте тип чата, статус участника и права бота.',
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-4');
    expect(maxClient.unbanMember).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expectImmediateMemberMutationOptions(),
    );
  });
});

describe('AdminService.applyManualSystemBan', () => {
  it('applies a permanent MAX ban without auto-unban scheduling for command flows', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'group_command',
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3');
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.deleteMany).toHaveBeenCalledWith({
      where: {
        adminUserId: 'admin-1',
        userId: 'user-3',
      },
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-3',
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
          metadata: expect.objectContaining({
            source: 'group_command',
            mode: 'MAX_BLOCK',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Бан включён.',
    });
  });

  it('queues local group command ban cleanup instead of blocking the command result', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
    );
    jest
      .spyOn(service as any, 'resolveManualModerationActionBotAssignment')
      .mockResolvedValue('bot-1');

    const result = await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'group_command',
      {
        preferredBotId: 'bot-1',
        targetDisplayNameHint: 'Нарушитель',
        allowTargetDisplayNameRemoteLookup: false,
      },
    );

    expect(adminManualFanoutQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_ban_source_cleanup',
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        source: 'group_command',
        botId: 'bot-1',
      }),
      expect.objectContaining({
        priority: 20,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
      }),
    );
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            recentMessageCleanup: expect.objectContaining({
              mode: 'queued',
              candidateCount: 0,
              deletedCount: 0,
            }),
            crossChatFanout: expect.objectContaining({
              removedChatsCount: 0,
              deletedMessageCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'BAN',
        userId: 'user-3',
        message: 'Бан включён.',
      }),
    );
  });

  it('falls back to removal-only system ban for closed chats without link', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Закрытый чат',
        participantsCount: 6,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'chat',
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'group_command',
    );

    expect(maxClient.kickMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            mode: 'MAX_REMOVE_ONLY',
          }),
        }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      action: 'BAN',
      userId: 'user-3',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Участник удалён из чата.',
    });
  });

  it('deletes recent tracked messages and removes the member from other managed chats of the admin', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }, { message_id: 'mid-source-2' }])
      .mockResolvedValueOnce([{ message_id: 'mid-fanout-1' }]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'group_command',
      { fanoutAllChats: true },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3', {
      botId: '777000_bot',
    });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-2', 'user-3', {
      botId: '777000_bot',
    });
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('chat-2', 'user-3', {
      trafficClass: 'background',
      botId: '777000_bot',
      bypassCache: true,
    });
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-2',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: '777000_bot',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-2', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: '777000_bot',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-2', 'mid-fanout-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: '777000_bot',
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            recentMessageCleanup: {
              candidateCount: 2,
              deletedCount: 2,
              pendingCount: 0,
              failedCount: 0,
            },
            crossChatFanout: expect.objectContaining({
              removedChatsCount: 1,
              removedChatIds: ['chat-2'],
              deletedMessageCount: 1,
              failedMessageDeleteCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'BAN',
        userId: 'user-3',
      }),
    );
    expect(result.message).toBe('Бан включён.');
  });

  it('uses the resolved chat bot for manual ban fanout in multi-bot chats', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }])
      .mockResolvedValueOnce([{ message_id: 'mid-fanout-1' }]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1-user',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createManualFanoutBotConfigFixture() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      createManualFanoutBotLinkFixture() as never,
    );

    await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'group_command',
      { fanoutAllChats: true },
    );

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-1', 'user-3', {
      botId: 'bot-1',
    });
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledWith('chat-2', 'user-3', {
      botId: 'bot-2',
    });
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('chat-2', 'user-3', {
      trafficClass: 'background',
      botId: 'bot-2',
      bypassCache: true,
    });
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions({ botId: 'bot-1' }),
    );
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-2',
      'user-3',
      expectImmediateMemberMutationOptions({ botId: 'bot-2' }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: 'bot-1',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-2', 'mid-fanout-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: 'bot-2',
    });
  });

  it('keeps group command manual mute scoped to the source chat when background queue is available', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
    );

    const result = await service.applyManualModerationAction(
      'chat-1',
      'user-2',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'MUTE', muteDurationHours: 6 },
      'group_command',
    );

    expect(adminManualFanoutQueue.add).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          metadata: expect.objectContaining({
            scope: 'current_chat',
          }),
        }),
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.not.objectContaining({
            sourceMessageCleanup: expect.anything(),
            crossChatMuteFanout: expect.anything(),
          }),
        }),
      }),
    );
    expect(
      prisma.moderationEvent.create.mock.calls.some(
        (call: readonly [Record<string, unknown>]) =>
          (call[0] as { data?: { chatId?: string } }).data?.chatId === 'chat-2',
      ),
    ).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      action: 'MUTE',
      userId: 'user-2',
      muteDurationHours: 6,
      muteExpiresAt: expect.any(String),
      message: 'Мут включён на 6 ч.',
    });
  });

  it('queues the primary group command action before leaving the moderation hot path', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<Queue<AdminManualFanoutJob>, 'add' | 'getJob'>;
    const adminManualCommandQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<Queue<AdminManualFanoutJob>, 'add'>;

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
    );
    Reflect.set(service, 'adminManualCommandQueue', adminManualCommandQueue);

    const queued = await service.enqueueManualGroupModerationCommand({
      sourceChatId: 'chat-1',
      commandBotId: 'bot-2',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: 'Админ',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'MUTE',
      muteDurationHours: 6,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(queued).toBe(true);
    expect(adminManualCommandQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_group_moderation_command',
        sourceChatId: 'chat-1',
        commandBotId: 'bot-2',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-target-1',
        commandMessageId: 'mid-command-1',
        action: 'MUTE',
        fanoutAllChats: false,
        muteDurationHours: 6,
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
        actor: expect.objectContaining({
          userId: 'admin-1',
          chatId: 'chat-1',
        }),
      }),
      expect.objectContaining({
        priority: 1,
        attempts: 5,
        removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
        removeOnFail: false,
      }),
    );
    expect(adminManualFanoutQueue.getJob).toHaveBeenCalledWith(
      expect.stringMatching(/^manual_group_moderation_command__/u),
    );
    expect(adminManualFanoutQueue.add).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('queues all-chats group ban commands with the fanout marker', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<Queue<AdminManualFanoutJob>, 'add' | 'getJob'>;
    const adminManualCommandQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<Queue<AdminManualFanoutJob>, 'add'>;

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
    );
    Reflect.set(service, 'adminManualCommandQueue', adminManualCommandQueue);

    const queued = await service.enqueueManualGroupModerationCommand({
      sourceChatId: 'chat-1',
      commandBotId: 'bot-2',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: 'Админ',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN',
      fanoutAllChats: true,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(queued).toBe(true);
    expect(adminManualCommandQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_group_moderation_command',
        sourceChatId: 'chat-1',
        commandBotId: 'bot-2',
        targetUserId: 'user-2',
        action: 'BAN',
        fanoutAllChats: true,
      }),
      expect.objectContaining({
        priority: 1,
      }),
    );
    expect(adminManualFanoutQueue.add).not.toHaveBeenCalled();
  });

  it('queues developer super ban commands with the highest group-command priority', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
    };
    const adminSuperBanQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      adminSuperBanQueue as never,
    );

    const queued = await service.enqueueDeveloperSuperBanCommand({
      sourceChatId: 'chat-1',
      commandBotId: 'bot-2',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: '98315271',
        username: null,
        displayName: 'Разработчик',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(queued).toBe(true);
    expect(adminSuperBanQueue.add).toHaveBeenCalledWith(
      'execute-admin-super-ban',
      expect.objectContaining({
        kind: 'developer_super_ban',
        sourceChatId: 'chat-1',
        commandBotId: 'bot-2',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-target-1',
        commandMessageId: 'mid-command-1',
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
        actor: expect.objectContaining({
          userId: '98315271',
          chatId: 'chat-1',
        }),
      }),
      expect.objectContaining({
        priority: 1,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
      }),
    );
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not replay irreversible super-ban work when cleanup intent intake fails', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const ensureAndAttempt = jest.fn().mockRejectedValue(new Error('intent database unavailable'));
    (service as any).moderationDeleteIntentService = {
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureAndAttempt,
    };
    jest
      .spyOn(service as any, 'resolveManualGroupCommandCleanupBotId')
      .mockResolvedValue('command-bot');
    const recordBlacklist = jest.spyOn(
      service as any,
      'recordDeveloperForcedGlobalBlacklistForJob',
    );
    const applySourceBan = jest.spyOn(service as any, 'applyDeveloperSuperBanSourceChat');

    await expect(
      service.processDeveloperSuperBanJob({
        kind: 'developer_super_ban',
        jobId: 'developer-super-ban-cleanup-intake-failure',
        sourceChatId: 'chat-1',
        commandBotId: 'command-bot',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-target-1',
        commandMessageId: 'mid-command-1',
        actor: {
          userId: '98315271',
          username: null,
          displayName: 'Разработчик',
          chatId: 'chat-1',
          chatTitle: 'Chat 1',
        },
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
      }),
    ).rejects.toThrow('intent database unavailable');

    expect(ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'mid-target-1',
        ruleCode: 'MANUAL_GROUP_COMMAND_TARGET_MESSAGE_CLEANUP',
      }),
    );
    expect(recordBlacklist).not.toHaveBeenCalled();
    expect(applySourceBan).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('records developer super ban blacklist and skips managed-chat fanout', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ message_id: 'mid-source-2' }])
      .mockResolvedValueOnce([{ active_membership_count: '16232' }]);
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn(),
      kickMember: jest.fn(),
    };
    const redisCounter = {
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };
    const globalSpammerIntelligence = {
      recordDeveloperForcedGlobalBlacklist: jest.fn().mockResolvedValue({ outcome: 'registry' }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
    );
    (service as unknown as { globalSpammerIntelligence: unknown }).globalSpammerIntelligence =
      globalSpammerIntelligence;

    const applyManualModerationAction = jest
      .spyOn(service, 'applyManualModerationAction')
      .mockResolvedValue({
        ok: true,
        action: 'BAN',
        userId: 'user-2',
        muteDurationHours: null,
        muteExpiresAt: null,
        message: 'Бан включён.',
      });
    const assertBotCanManageMembers = jest.spyOn(service as any, 'assertBotCanManageMembers');
    const assertBotCanDeleteMessages = jest.spyOn(service as any, 'assertBotCanDeleteMessages');
    const resolveManualFanoutTargetState = jest.spyOn(
      service as any,
      'resolveManualFanoutTargetState',
    );

    await service.processDeveloperSuperBanJob({
      kind: 'developer_super_ban',
      jobId: 'developer-super-ban-job-1',
      sourceChatId: 'chat-1',
      commandBotId: 'command-bot',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: '98315271',
        username: null,
        displayName: 'Разработчик',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(globalSpammerIntelligence.recordDeveloperForcedGlobalBlacklist).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        actorUserId: '98315271',
        chatId: 'chat-1',
        messageId: 'mid-target-1',
        userLabel: 'Нарушитель',
        reason: 'По решению разработчика бота за нарушение правил',
      }),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerCacheKey('user-2'),
      '1',
      expect.any(Number),
    );
    expect(applyManualModerationAction).toHaveBeenCalledWith(
      'chat-1',
      'user-2',
      expect.objectContaining({
        userId: '98315271',
        chatId: 'chat-1',
      }),
      { action: 'BAN' },
      'group_command',
      expect.objectContaining({
        actorAlreadyVerified: true,
        preferredBotId: 'command-bot',
        targetDisplayNameHint: 'Нарушитель',
        allowTargetDisplayNameRemoteLookup: false,
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-target-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'command-bot',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-command-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'command-bot',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-2', {
      immediate: true,
    });
    expect(prisma.chat.count).not.toHaveBeenCalled();
    expect(prisma.managedBotChatCatalog.findMany).not.toHaveBeenCalled();
    const activeMembershipCountSqlText =
      prisma.$queryRaw.mock.calls
        .map((call) => extractSqlText(call[0]))
        .find((text) => text.includes('active_membership_count')) ?? '';
    expect(activeMembershipCountSqlText).toContain('COUNT(*)');
    expect(activeMembershipCountSqlText).toContain('FROM chat_bot_memberships');
    expect(activeMembershipCountSqlText).toContain('JOIN chats');
    expect(activeMembershipCountSqlText).toContain('membership.status');
    expect(activeMembershipCountSqlText).not.toContain('managed_bot_chat_catalog');
    expect(activeMembershipCountSqlText).not.toContain('bot_id =');
    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(assertBotCanManageMembers).not.toHaveBeenCalled();
    expect(assertBotCanDeleteMessages).not.toHaveBeenCalled();
    expect(resolveManualFanoutTargetState).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses a delete-capable bot for developer super ban command cleanup after action reroute', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([{ active_membership_count: 7 }]);
    const candidateBotIds = ['command-bot', 'bot-3', 'bot-4', 'bot-5', 'bot-6'];
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => {
          const botId = options?.botId ?? 'command-bot';
          return {
            userId: botId,
            isAdmin: botId !== 'command-bot',
            isOwner: false,
            permissions: botId === 'bot-6' ? ['read_all_messages', 'write'] : ['read_all_messages'],
          };
        }),
    };
    const redisCounter = {
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };
    const globalSpammerIntelligence = {
      recordDeveloperForcedGlobalBlacklist: jest.fn().mockResolvedValue({ outcome: 'registry' }),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoute: jest.fn().mockImplementation(async (request: { chatId: string }) => ({
        purpose: 'send_message',
        chatId: request.chatId,
        primaryBotId: 'command-bot',
        botId: 'bot-5',
        candidateBotIds: ['bot-5'],
        reason: 'alternate_confirmed',
      })),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'command-bot',
          botId: 'command-bot',
          candidateBotIds,
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue(candidateBotIds.map((id) => ({ id }))),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotRegistry as never,
    );
    (service as unknown as { globalSpammerIntelligence: unknown }).globalSpammerIntelligence =
      globalSpammerIntelligence;
    jest
      .spyOn(service as any, 'applyDeveloperSuperBanSourceChat')
      .mockResolvedValue({ affected: true, mode: 'removed' });
    jest.spyOn(service as any, 'runManualBanSourceCleanup').mockResolvedValue({
      candidateMessageIds: [],
      deletedMessageIds: [],
      failedMessageIds: [],
    });

    await service.processDeveloperSuperBanJob({
      kind: 'developer_super_ban',
      jobId: 'developer-super-ban-job-cleanup-bot',
      sourceChatId: 'chat-1',
      commandBotId: 'command-bot',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: '98315271',
        username: null,
        displayName: 'Разработчик',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    const probedBotIds = maxClient.getCurrentChatMemberAccess.mock.calls
      .map((call) => (call[1] as { botId?: string } | undefined)?.botId)
      .filter((botId): botId is string => Boolean(botId));
    expect(Array.from(new Set(probedBotIds))).toEqual(candidateBotIds);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-target-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'bot-6',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-command-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'bot-6',
    });
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('records source-chat no-rights fallback without inspecting managed-chat fanout', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([{ active_membership_count: 3 }]);
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn(),
      kickMember: jest.fn(),
    };
    const redisCounter = {
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };
    const globalSpammerIntelligence = {
      recordDeveloperForcedGlobalBlacklist: jest.fn().mockResolvedValue({ outcome: 'registry' }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      redisCounter as never,
    );
    (service as unknown as { globalSpammerIntelligence: unknown }).globalSpammerIntelligence =
      globalSpammerIntelligence;

    jest.spyOn(service, 'applyManualModerationAction').mockRejectedValue(new Error('no ban'));
    jest
      .spyOn(service as any, 'resolveManualModerationActionBotAssignment')
      .mockResolvedValue('delete-bot');
    const assertBotCanManageMembers = jest.spyOn(service as any, 'assertBotCanManageMembers');
    jest
      .spyOn(service as any, 'assertBotCanDeleteMessages')
      .mockRejectedValue(new Error('no delete'));
    const resolveManualFanoutTargetState = jest.spyOn(
      service as any,
      'resolveManualFanoutTargetState',
    );

    await service.processDeveloperSuperBanJob({
      kind: 'developer_super_ban',
      jobId: 'developer-super-ban-job-2',
      sourceChatId: 'chat-1',
      commandBotId: 'command-bot',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: '98315271',
        username: null,
        displayName: 'Разработчик',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(globalSpammerIntelligence.recordDeveloperForcedGlobalBlacklist).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        actorUserId: '98315271',
        chatId: 'chat-1',
        messageId: 'mid-target-1',
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-2',
          ruleCode: 'SUPER_BAN_NO_RIGHTS',
          action: 'NONE',
          metadata: expect.objectContaining({
            superBan: true,
            noRights: true,
            fanout: false,
            fallbackReason: 'SOURCE_SYSTEM_BAN_FAILED',
          }),
        }),
      }),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerCacheKey('user-2'),
      '1',
      expect.any(Number),
    );
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-2', 'user-2'),
      expect.any(String),
      expect.any(Number),
    );
    expect(prisma.managedBotChatCatalog.findMany).not.toHaveBeenCalled();
    expect(prisma.chat.count).not.toHaveBeenCalled();
    const activeMembershipCountSqlText =
      prisma.$queryRaw.mock.calls
        .map((call) => extractSqlText(call[0]))
        .find((text) => text.includes('active_membership_count')) ?? '';
    expect(activeMembershipCountSqlText).toContain('COUNT(*)');
    expect(activeMembershipCountSqlText).toContain('FROM chat_bot_memberships');
    expect(activeMembershipCountSqlText).toContain('JOIN chats');
    expect(activeMembershipCountSqlText).not.toContain('managed_bot_chat_catalog');
    expect(activeMembershipCountSqlText).not.toContain('bot_id =');
    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(assertBotCanManageMembers).not.toHaveBeenCalled();
    expect(resolveManualFanoutTargetState).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses the sum of active bot memberships for developer super ban coverage without an unbound group notice', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ active_membership_count: 12n }]);
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn(),
      kickMember: jest.fn(),
    };
    const redisCounter = {
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };
    const globalSpammerIntelligence = {
      recordDeveloperForcedGlobalBlacklist: jest.fn().mockResolvedValue({ outcome: 'registry' }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: 'command-bot' }) as never,
      undefined,
      redisCounter as never,
    );
    (service as unknown as { globalSpammerIntelligence: unknown }).globalSpammerIntelligence =
      globalSpammerIntelligence;

    jest.spyOn(service, 'applyManualModerationAction').mockResolvedValue({
      ok: true,
      action: 'BAN',
      userId: 'user-2',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Бан включён.',
    });

    await service.processDeveloperSuperBanJob({
      kind: 'developer_super_ban',
      jobId: 'developer-super-ban-job-catalog-total',
      sourceChatId: 'chat-1',
      commandBotId: 'command-bot',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: '98315271',
        username: null,
        displayName: 'Разработчик',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(prisma.managedBotChatCatalog.findMany).not.toHaveBeenCalled();
    expect(prisma.chat.count).not.toHaveBeenCalled();
    const activeMembershipCountSqlText =
      prisma.$queryRaw.mock.calls
        .map((call) => extractSqlText(call[0]))
        .find((text) => text.includes('active_membership_count')) ?? '';
    expect(activeMembershipCountSqlText).toContain('COUNT(*)');
    expect(activeMembershipCountSqlText).toContain('FROM chat_bot_memberships');
    expect(activeMembershipCountSqlText).toContain('JOIN chats');
    expect(activeMembershipCountSqlText).not.toContain('managed_bot_chat_catalog');
    expect(activeMembershipCountSqlText).not.toContain('bot_id');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('processes queued primary group ban commands outside the webhook hot path', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockImplementation(async (_chatId, _targetUserId, _actor, _source, options) => {
        options?.onModerationEventRecorded?.('moderation-event-1');
        return {
          ok: true,
          action: 'BAN',
          userId: 'user-2',
          muteDurationHours: null,
          muteExpiresAt: null,
          message: 'Бан включён.',
        };
      });

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId: 'job-command-1',
      sourceChatId: 'chat-1',
      commandBotId: 'bot-2',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN',
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(service.applyManualSystemBan).toHaveBeenCalledWith(
      'chat-1',
      'user-2',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      }),
      'group_command',
      {
        actorAlreadyVerified: true,
        preferredBotId: 'bot-2',
        targetDisplayNameHint: 'Нарушитель',
        allowTargetDisplayNameRemoteLookup: false,
        fanoutAllChats: false,
        fanoutLedgerJobId: 'job-command-1',
        onAlreadyApplied: expect.any(Function),
        onModerationEventRecorded: expect.any(Function),
      },
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-target-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'bot-2',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-command-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'bot-2',
    });
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Для участника [Нарушитель](max://user/user-2) включён бан.',
      moderationReleaseMessageOptions('UNBAN', 'moderation-event-1', 'chat-1'),
      {
        immediate: true,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
        autoDeleteDelayMs: 3 * 60 * 1000,
        beforeImmediateSendMutation: expect.any(Function),
        ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
        botId: 'bot-2',
        idempotencyKey: expect.stringContaining('COMMAND_NOTICE_OUTCOME'),
      },
    );
  });

  it('accepts pending durable group-command cleanup without issuing a second direct delete', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };
    const deleteIntents = {
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'pending',
        confirmed: false,
        intentId: 'intent-command-1',
        status: 'RETRYABLE',
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;

    await (service as any).deleteManualGroupCommandMessage('chat-1', 'mid-command-1', {
      botId: 'bot-2',
      originBotId: 'bot-1',
      actorUserId: 'admin-1',
    });

    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'mid-command-1',
      reasonKey: 'manual_group_command_message_cleanup',
      ruleCode: 'MANUAL_GROUP_COMMAND_MESSAGE_CLEANUP',
      subjectUserId: 'admin-1',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      originBotId: 'bot-1',
      routingPolicy: 'origin_first',
      event: {
        userId: 'admin-1',
        eventType: null,
        metadata: {
          source: 'admin_manual_action',
          cleanupKind: 'group_command',
          messageRole: 'command',
        },
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('falls back to the legacy direct delete after recording a shadow intent', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };
    const deleteIntents = {
      getRolloutForRule: jest.fn().mockReturnValue('observed'),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'observed',
        confirmed: false,
        intentId: 'intent-target-1',
        status: 'OBSERVED',
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;

    await (service as any).deleteManualGroupCommandTargetMessage(
      {
        sourceChatId: 'chat-1',
        commandBotId: 'origin-bot',
        targetUserId: 'user-2',
        targetMessageId: 'mid-target-1',
      },
      { botId: 'delete-bot' },
    );

    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'mid-target-1',
        subjectUserId: 'user-2',
        originBotId: 'origin-bot',
        reasonKey: 'manual_group_command_target_message_cleanup',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-target-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'delete-bot',
    });
  });

  it('propagates execute-rollout intent persistence failures to the queue worker', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
    };
    const deleteIntents = {
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureAndAttempt: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await expect(
      (service as any).deleteManualGroupCommandMessage('chat-1', 'mid-command-1'),
    ).rejects.toThrow('database unavailable');

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('reports waiting durable recent-message cleanup as pending, not deleted', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ message_id: 'mid-recent-1' }]);
    const maxClient = {
      deleteMessage: jest.fn(),
    };
    const deleteIntents = {
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'waiting_capability',
        confirmed: false,
        intentId: 'intent-recent-1',
        status: 'WAITING_CAPABILITY',
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;

    await expect(
      (service as any).deleteRecentTrackedMessagesForManualAction('chat-1', 'user-2', {
        botId: 'origin-bot',
      }),
    ).resolves.toEqual({
      candidateMessageIds: ['mid-recent-1'],
      deletedMessageIds: [],
      pendingMessageIds: ['mid-recent-1'],
      failedMessageIds: [],
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectUserId: 'user-2',
        originBotId: 'origin-bot',
        routingPolicy: 'origin_first',
      }),
    );
  });

  it('uses entity-specific strict permissions in manual delete assertions', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'bot-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        })
        .mockResolvedValueOnce({
          userId: 'bot-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'delete'],
        }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).assertBotCanDeleteMessages('channel-1', 'bot-1', ChatEntityType.CHANNEL),
    ).rejects.toThrow('право delete');
    await expect(
      (service as any).assertBotCanDeleteMessages('channel-1', 'bot-1', ChatEntityType.CHANNEL),
    ).resolves.toBeUndefined();
  });

  it('uses a delete-capable bot for queued group command message cleanup after action reroute', async () => {
    const prisma = createPrismaMock();
    const candidateBotIds = ['bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6'];
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, options?: { botId?: string }) => {
          const botId = options?.botId ?? 'bot-2';
          return {
            userId: botId,
            isAdmin: botId !== 'bot-2',
            isOwner: false,
            permissions: botId === 'bot-6' ? ['read_all_messages', 'write'] : ['read_all_messages'],
          };
        }),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn().mockReturnValue('test-max-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token']),
      resolveBotRoute: jest.fn().mockImplementation(async (request: { chatId: string }) => ({
        purpose: 'send_message',
        chatId: request.chatId,
        primaryBotId: 'bot-2',
        botId: 'bot-5',
        candidateBotIds: ['bot-5'],
        reason: 'alternate_confirmed',
      })),
      resolveBotRoutes: jest
        .fn()
        .mockImplementation(async (request: { chatId: string; action: string }) => ({
          purpose: 'moderation_action',
          chatId: request.chatId,
          primaryBotId: 'bot-2',
          botId: 'bot-2',
          candidateBotIds,
          reason: 'primary_soft',
          action: request.action,
        })),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId?: string | null) => (botId ? { id: botId } : null)),
      getActionableBots: jest.fn().mockReturnValue(candidateBotIds.map((id) => ({ id }))),
      getDiscoveryBots: jest.fn().mockReturnValue([]),
    };
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
      maxBotRegistry as never,
    );
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockImplementation(async (_chatId, _targetUserId, _actor, _source, options) => {
        options?.onModerationEventRecorded?.('moderation-event-1');
        return {
          ok: true,
          action: 'BAN',
          userId: 'user-2',
          muteDurationHours: null,
          muteExpiresAt: null,
          message: 'Бан включён.',
        };
      });

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId: 'job-command-1',
      sourceChatId: 'chat-1',
      commandBotId: 'bot-2',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN',
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    const probedBotIds = maxClient.getCurrentChatMemberAccess.mock.calls
      .map((call) => (call[1] as { botId?: string } | undefined)?.botId)
      .filter((botId): botId is string => Boolean(botId));
    expect(Array.from(new Set(probedBotIds))).toEqual(candidateBotIds);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-target-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'bot-6',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-command-1', {
      immediate: true,
      trafficClass: 'interactive',
      botId: 'bot-6',
    });
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Для участника [Нарушитель](max://user/user-2) включён бан.',
      moderationReleaseMessageOptions('UNBAN', 'moderation-event-1', 'chat-1'),
      expect.objectContaining({
        immediate: true,
        botId: 'bot-5',
      }),
    );
  });

  it('reports queued group ban commands as removal when MAX cannot block the chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockImplementation(async (_chatId, _targetUserId, _actor, _source, options) => {
        options?.onModerationEventRecorded?.('moderation-event-1');
        return {
          ok: true,
          action: 'BAN',
          userId: 'user-2',
          muteDurationHours: null,
          muteExpiresAt: null,
          message: 'Участник удалён из чата.',
        };
      });

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId: 'job-command-1',
      sourceChatId: 'chat-1',
      commandBotId: 'bot-2',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN',
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Участник [Нарушитель](max://user/user-2) удалён из чата.',
      moderationReleaseMessageOptions('UNBAN', 'moderation-event-1', 'chat-1'),
      expect.objectContaining({
        immediate: true,
        trafficClass: 'interactive',
        botId: 'bot-2',
      }),
    );
  });

  it('stores queued group command failures without a public notice', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockImplementation(async (request: { chatId: string }) => ({
        purpose: 'send_message',
        chatId: request.chatId,
        primaryBotId: 'bot-2',
        botId: 'bot-5',
        candidateBotIds: ['bot-5'],
        reason: 'alternate_confirmed',
      })),
    };

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
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockRejectedValue(
        new BadRequestException('Нельзя применять это действие к своему аккаунту.'),
      );

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId: 'job-command-1',
      sourceChatId: 'chat-1',
      commandBotId: 'bot-2',
      targetUserId: 'admin-1',
      targetSenderName: 'Админ',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN',
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(
      await prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'COMMAND_NOTICE_OUTCOME' },
      }),
    ).toEqual([
      expect.objectContaining({
        status: 'SUCCEEDED',
        terminal: true,
        remoteMessageId: null,
        actorUserId: 'admin-1',
        targetUserId: 'admin-1',
        botId: 'bot-5',
        metadata: expect.objectContaining({
          outcome: 'FAILURE',
          suppressed: true,
          resultText:
            'Команда «бан» не выполнена: Нельзя применять это действие к своему аккаунту.',
        }),
      }),
    ]);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('retries transient queued group moderation failures without sending an error notice', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service, 'applyManualSystemBan')
      .mockRejectedValue(new Error('MAX API critical rate limit exceeded'));

    await expect(
      service.processManualModerationFanoutJob({
        kind: 'manual_group_moderation_command',
        jobId: 'job-command-1',
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-target-1',
        commandMessageId: 'mid-command-1',
        actor: {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-1',
          chatTitle: 'Chat 1',
        },
        action: 'BAN',
        muteDurationHours: null,
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
      }),
    ).rejects.toThrow('MAX API critical rate limit exceeded');

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('processes queued primary group permanent mute commands outside the webhook hot path', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service, 'applyManualModerationAction')
      .mockImplementation(async (_chatId, _targetUserId, _actor, _body, _source, options) => {
        options?.onModerationEventRecorded?.('moderation-event-1');
        return {
          ok: true,
          action: 'MUTE',
          userId: 'user-2',
          muteDurationHours: null,
          muteExpiresAt: null,
          message: 'Мут включён без срока.',
        };
      });

    await service.processManualModerationFanoutJob({
      kind: 'manual_group_moderation_command',
      jobId: 'job-command-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'MUTE',
      muteDurationHours: null,
      mutePermanent: true,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    });

    expect(service.applyManualModerationAction).toHaveBeenCalledWith(
      'chat-1',
      'user-2',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      }),
      {
        action: 'MUTE',
        mutePermanent: true,
        scope: 'current_chat',
      },
      'group_command',
      {
        actorAlreadyVerified: true,
        preferredBotId: null,
        targetDisplayNameHint: 'Нарушитель',
        allowTargetDisplayNameRemoteLookup: false,
        fanoutAllChats: false,
        fanoutLedgerJobId: 'job-command-1',
        onAlreadyApplied: expect.any(Function),
        onModerationEventRecorded: expect.any(Function),
      },
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-target-1', {
      immediate: true,
      trafficClass: 'interactive',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-command-1', {
      immediate: true,
      trafficClass: 'interactive',
    });
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Мут включён без срока.\nУчастник: [Нарушитель](max://user/user-2)',
      moderationReleaseMessageOptions('UNMUTE', 'moderation-event-1', 'chat-1'),
      {
        immediate: true,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
        autoDeleteDelayMs: 3 * 60 * 1000,
        beforeImmediateSendMutation: expect.any(Function),
        ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
        idempotencyKey: expect.stringContaining('COMMAND_NOTICE_OUTCOME'),
      },
    );
  });

  it('deletes source chat messages during queued manual mute fanout processing', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'resolveManualActionBotAssignment').mockResolvedValue('bot-1');

    await service.processManualModerationFanoutJob({
      kind: 'manual_mute_fanout',
      jobId: 'job-mute-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      cleanupSourceChatMessages: true,
      botId: 'stored-cleanup-bot',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: null,
        chatTitle: null,
      },
      muteDurationHours: 6,
      muteExpiresAt: '2026-04-08T22:18:25.418Z',
      source: 'group_command',
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      botId: 'stored-cleanup-bot',
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-2',
          ruleCode: 'MANUAL_MUTE',
        }),
      }),
    );
  });

  it('rejects queued fanout before cleanup or ledger claims when a target admin was revoked', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-revoked',
        chat: {
          id: 'chat-revoked',
          title: 'Бывшая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const maxClient = {
      getChatMembersAccess: createRevokedTargetAdminMemberFixture(),
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) =>
          chatId === 'chat-revoked' ? [] : ['admin-1'],
        ),
      banMember: jest.fn(),
      kickMember: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.processManualModerationFanoutJob({
        kind: 'manual_ban_fanout',
        jobId: 'job-revoked-target',
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        actor: {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: null,
          chatTitle: null,
        },
        source: 'group_command',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-revoked',
      expect.arrayContaining(['admin-1']),
      expect.objectContaining({ bypassCache: true }),
    );

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.manualModerationFanoutLedgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.manualModerationFanoutLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('queues manual ban fanout for group commands when background queue is available', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([
      { message_id: 'mid-source-1' },
      { message_id: 'mid-source-2' },
    ]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };
    const adminManualFanoutQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      adminManualFanoutQueue as never,
    );

    const result = await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'group_command',
      { fanoutAllChats: true },
    );

    expect(adminManualFanoutQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_ban_fanout',
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        source: 'group_command',
      }),
      expect.objectContaining({
        priority: 20,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      }),
    );
    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            recentMessageCleanup: expect.objectContaining({
              mode: 'queued',
              candidateCount: 0,
              deletedCount: 0,
            }),
            crossChatFanout: expect.objectContaining({
              mode: 'queued',
              removedChatsCount: 0,
              removedChatIds: [],
              deletedMessageCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: 'BAN',
        userId: 'user-3',
      }),
    );
    expect(result.message).toBe('Бан включён.');
  });

  it('deletes source chat messages during queued manual ban fanout processing', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ message_id: 'mid-source-1' }, { message_id: 'mid-source-2' }])
      .mockResolvedValueOnce([{ message_id: 'mid-fanout-1' }]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createManualFanoutBotConfigFixture() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      createManualFanoutBotLinkFixture() as never,
    );

    await service.processManualModerationFanoutJob({
      kind: 'manual_ban_fanout',
      jobId: 'job-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-3',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: null,
        chatTitle: null,
      },
      source: 'group_command',
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      botId: 'bot-1',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-2', {
      immediate: true,
      botId: 'bot-1',
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-2', 'mid-fanout-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
      botId: 'bot-2',
    });
  });

  it('continues queued ban fanout after a chat has no eligible bot route', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Недоступная группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
      {
        userId: 'admin-1',
        chatId: 'chat-3',
        chat: {
          id: 'chat-3',
          title: 'Доступная группа',
          createdAt: new Date('2026-03-03T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-3',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members', 'read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'resolveManualModerationActionBotAssignment')
      .mockImplementation(async (...args: unknown[]) => {
        const [chatId, action] = args as [string, string];
        if (chatId === 'chat-2' && action === 'moderate_member') {
          throw new ForbiddenException(
            'Не найден бот MAX с подтвержденным правом выполнить действие модерации в этом чате.',
          );
        }
        return chatId === 'chat-3' ? 'bot-3' : 'bot-1';
      });

    await expect(
      service.processManualModerationFanoutJob({
        kind: 'manual_ban_fanout',
        jobId: 'job-partial-route-1',
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        actor: {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: null,
          chatTitle: null,
        },
        source: 'miniapp',
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-3',
      'user-3',
      expectImmediateMemberMutationOptions({ botId: 'bot-3' }),
    );
    await expect(
      prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'FANOUT_BAN_MEMBER' },
      }),
    ).resolves.toEqual([expect.objectContaining({ targetChatId: 'chat-3', status: 'SUCCEEDED' })]);
  });

  it('does not repeat a succeeded queued manual ban fanout target on replay', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const job = {
      kind: 'manual_ban_fanout' as const,
      jobId: 'job-ban-replay-1',
      rootIntentKey: 'command-root-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-3',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: null,
        chatTitle: null,
      },
      source: 'group_command' as const,
    };

    await service.processManualModerationFanoutJob(job);
    await service.processManualModerationFanoutJob(job);

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(prisma.manualModerationFanoutLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationKey: expect.stringContaining('FANOUT_BAN_MEMBER'),
        }),
        data: expect.objectContaining({
          status: 'SUCCEEDED',
        }),
      }),
    );
  });

  it('reclaims stale in-progress manual fanout ledger entries instead of making them ambiguous', async () => {
    const prisma = createPrismaMock();
    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const operationKey = 'manual_moderation_fanout:v1:FANOUT_MUTE_RECORD:test-stale';
    const params = {
      operationKey,
      jobId: 'job-stale-1',
      rootIntentKey: 'root-stale-1',
      sourceKind: 'manual_mute_fanout',
      operation: 'FANOUT_MUTE_RECORD',
      sourceChatId: 'chat-1',
      targetChatId: 'chat-2',
      targetUserId: 'user-2',
      actorUserId: 'admin-1',
      logicalAction: 'MUTE',
      botId: 'bot-2',
      metadata: { source: 'group_command' },
    };

    const firstClaim = await (service as any).claimManualModerationFanoutLedgerEntry(params);
    await prisma.manualModerationFanoutLedgerEntry.updateMany({
      where: { operationKey },
      data: {
        lockedAt: new Date(Date.now() - 11 * 60 * 1000),
      },
    });
    const secondClaim = await (service as any).claimManualModerationFanoutLedgerEntry(params);
    const rows = await prisma.manualModerationFanoutLedgerEntry.findMany({
      where: { operationKey },
    });

    expect(firstClaim.claimed).toBe(true);
    expect(secondClaim.claimed).toBe(true);
    expect(secondClaim.lockToken).not.toEqual(firstClaim.lockToken);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: 'IN_PROGRESS',
        attemptCount: 2,
        terminal: false,
        lockToken: secondClaim.lockToken,
      }),
    );
  });

  it('throws queued manual mute fanout jobs when a target failure is retryable', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'bot-2',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        })
        .mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.processManualModerationFanoutJob({
        kind: 'manual_mute_fanout',
        jobId: 'job-mute-retryable-1',
        rootIntentKey: 'command-root-mute-retryable-1',
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        cleanupSourceChatMessages: false,
        actor: {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: null,
          chatTitle: null,
        },
        muteDurationHours: 6,
        muteExpiresAt: '2026-04-08T22:18:25.418Z',
        mutePermanent: false,
        source: 'group_command',
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.manualModerationFanoutLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationKey: expect.stringContaining('FANOUT_MUTE_RECORD'),
        }),
        data: expect.objectContaining({
          status: 'FAILED_RETRYABLE',
        }),
      }),
    );
  });

  it('does not duplicate manual mute fanout records on replay', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        userId: 'admin-1',
        chatId: 'chat-2',
        chat: {
          id: 'chat-2',
          title: 'Вторая группа',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const job = {
      kind: 'manual_mute_fanout' as const,
      jobId: 'job-mute-replay-1',
      rootIntentKey: 'command-root-mute-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-2',
      cleanupSourceChatMessages: false,
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: null,
        chatTitle: null,
      },
      muteDurationHours: 6,
      muteExpiresAt: '2026-04-08T22:18:25.418Z',
      mutePermanent: false,
      source: 'group_command' as const,
    };

    await service.processManualModerationFanoutJob(job);
    await service.processManualModerationFanoutJob(job);

    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.manualModerationFanoutLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationKey: expect.stringContaining('FANOUT_MUTE_RECORD'),
        }),
        data: expect.objectContaining({
          status: 'SUCCEEDED',
        }),
      }),
    );
  });

  it('does not send duplicate queued group command success notices on replay', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'applyManualSystemBan').mockResolvedValue({
      ok: true,
      action: 'BAN',
      userId: 'user-2',
      muteDurationHours: null,
      muteExpiresAt: null,
      message: 'Бан включён.',
    });

    const job = {
      kind: 'manual_group_moderation_command' as const,
      jobId: 'job-command-notice-1',
      sourceChatId: 'chat-1',
      commandBotId: 'bot-2',
      targetUserId: 'user-2',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: 'mid-command-1',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
      },
      action: 'BAN' as const,
      muteDurationHours: null,
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 3,
    };

    await service.processManualModerationFanoutJob(job);
    await service.processManualModerationFanoutJob(job);

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.manualModerationFanoutLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationKey: expect.stringContaining('COMMAND_NOTICE_OUTCOME'),
        }),
        data: expect.objectContaining({
          status: 'SUCCEEDED',
        }),
      }),
    );
  });

  it('processes queued local manual ban cleanup without running cross-chat fanout', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([{ message_id: 'mid-source-1' }]);
    const maxClient = {
      getChatMemberAccess: jest.fn(),
      cancelScheduledUnban: jest.fn(),
      banMember: jest.fn(),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await service.processManualModerationFanoutJob({
      kind: 'manual_ban_source_cleanup',
      jobId: 'job-cleanup-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-3',
      actor: {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: null,
        chatTitle: null,
      },
      source: 'group_command',
      botId: 'bot-1',
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'mid-source-1', {
      immediate: true,
      botId: 'bot-1',
    });
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('still bans permanently when cancelling a stale scheduled unban fails', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockRejectedValue(new Error('redis timeout')),
      banMember: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.applyManualSystemBan(
        'chat-1',
        'user-3',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'private_command',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        message: 'Бан включён.',
      }),
    );

    expect(maxClient.banMember).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expectImmediateMemberMutationOptions(),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Для участника [Пользователь](max://user/user-3) включён бан.',
      moderationReleaseMessageOptions('UNBAN', 'moderation-event-1', 'chat-1'),
      { immediate: true },
    );
  });
});

describe('AdminService.listChannels', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns channel overview summary for each managed channel', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        createdAt: '2026-03-02T10:00:00.000Z',
      }),
      createLocalManagedEntityRow({
        chatId: 'channel-2',
        title: 'Обновления MAX',
        entityType: 'channel',
        createdAt: '2026-03-01T10:00:00.000Z',
      }),
    ]);
    prisma.chat.upsert.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: where.id === 'channel-1' ? 'Новости MAX' : 'Обновления MAX',
      createdAt: new Date(
        where.id === 'channel-1' ? '2026-03-02T10:00:00.000Z' : '2026-03-01T10:00:00.000Z',
      ),
      entityType: 'CHANNEL',
    }));
    prisma.channelSettings.findMany.mockResolvedValue([
      {
        chatId: 'channel-1',
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        commentsModerationEnabled: true,
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const discovered = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
      {
        respectCooldown: false,
        fullScan: true,
      },
    );
    const result = await (service as any).hydrateManagedEntities(discovered.items);

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 2,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
      }),
      createChatSummaryFixture({
        id: 'channel-2',
        title: 'Обновления MAX',
        createdAt: '2026-03-01T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);
    expect(prisma.channelSettings.findMany).toHaveBeenCalledWith({
      where: {
        chatId: {
          in: ['channel-1', 'channel-2'],
        },
      },
      select: {
        chatId: true,
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        commentsModerationEnabled: true,
      },
    });
  });

  it('checks admin access only for matching channel candidates during channel discovery', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        createdAt: '2026-03-02T11:00:00.000Z',
      }),
      createLocalManagedEntityRow({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        createdAt: '2026-03-02T10:00:00.000Z',
      }),
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const discovered = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
      {
        respectCooldown: false,
        fullScan: true,
      },
    );

    await expect((service as any).hydrateManagedEntities(discovered.items)).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
  });

  it('uses allowlist cache by default and skips remote MAX discovery', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([
      {
        chatId: 'channel-1',
        commentsEnabled: false,
        postSuggestionsEnabled: true,
        commentsModerationEnabled: false,
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.listChannels({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 1,
          commentsEnabled: false,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: false,
        },
      }),
    ]);
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('filters cached home entities through strict access edges when the edge table is available', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Подтверждённый канал',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
      {
        chat: {
          id: 'channel-2',
          title: 'Устаревший канал',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);
    (prisma as any).managedEntityAccessEdge = {
      findMany: jest.fn().mockResolvedValue([{ chatId: 'channel-1', botId: '777000_bot' }]),
    };

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Подтверждённый канал',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);
    expect((prisma as any).managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'admin-1',
          chatId: { in: ['channel-1', 'channel-2'] },
          OR: [
            { state: 'USER_DENIED' },
            {
              state: 'GRANTED',
              OR: [
                { expiresAt: { gt: new Date('2026-05-14T09:00:00.000Z') } },
                {
                  expiresAt: null,
                  checkedAt: { gt: new Date('2026-05-07T09:00:00.000Z') },
                },
              ],
            },
          ],
        }),
      }),
    );
  });

  it('filters fresh home access edges without an active bot membership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'channel-active',
            title: 'Живой канал',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHANNEL',
            primaryBotId: '777000_bot',
            botId: '777000_bot',
          },
        },
        {
          chat: {
            id: 'channel-stale',
            title: 'Канал без membership',
            createdAt: new Date('2026-03-01T10:00:00.000Z'),
            entityType: 'CHANNEL',
            primaryBotId: '777000_bot',
            botId: '777000_bot',
          },
        },
      ]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).chatBotMembership = {
        findMany: jest.fn().mockResolvedValue([{ chatId: 'channel-active', botId: '777000_bot' }]),
      };
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest.fn().mockResolvedValue([
          { chatId: 'channel-active', botId: '777000_bot' },
          { chatId: 'channel-stale', botId: '777000_bot' },
        ]),
      };

      const service = new AdminService(
        prisma as never,
        {} as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'channel-active',
          title: 'Живой канал',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        }),
      ]);
      expect((prisma as any).chatBotMembership.findMany).toHaveBeenCalledWith({
        where: {
          chatId: {
            in: ['channel-active', 'channel-stale'],
          },
          botId: {
            in: ['777000_bot'],
          },
          status: ChatBotMembershipStatus.ACTIVE,
        },
        select: {
          chatId: true,
          botId: true,
        },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('hides a managed entity when USER_DENIED is newer than an active grant', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'channel-revoked',
            title: 'Отозванный канал',
            createdAt: new Date('2026-03-01T10:00:00.000Z'),
            entityType: 'CHANNEL',
            primaryBotId: 'bot-primary',
            botId: 'bot-primary',
          },
        },
      ]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).chatBotMembership = {
        findMany: jest
          .fn()
          .mockResolvedValue([{ chatId: 'channel-revoked', botId: 'bot-primary' }]),
      };
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-revoked',
            botId: 'bot-primary',
            state: 'GRANTED',
            checkedAt: new Date('2026-05-14T08:50:00.000Z'),
            expiresAt: new Date('2026-05-14T10:00:00.000Z'),
          },
          {
            chatId: 'channel-revoked',
            botId: 'bot-secondary',
            state: 'USER_DENIED',
            checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            expiresAt: null,
          },
        ]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };

      const service = new AdminService(
        prisma as never,
        {} as never,
        createChatContextCacheMock() as never,
        createConfigMock({ botId: 'bot-primary' }) as never,
      );

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);
      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps missing allowlist access edges hidden while queuing roster validation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany
        .mockResolvedValueOnce([
          {
            chat: {
              id: 'channel-1',
              title: 'Подтверждённый канал',
              createdAt: new Date('2026-03-02T10:00:00.000Z'),
              entityType: 'CHANNEL',
              primaryBotId: '777000_bot',
              botId: '777000_bot',
            },
          },
          {
            chat: {
              id: 'channel-2',
              title: 'Канал без свежего edge',
              createdAt: new Date('2026-03-01T10:00:00.000Z'),
              entityType: 'CHANNEL',
              primaryBotId: '777000_bot',
              botId: '777000_bot',
            },
          },
        ])
        .mockResolvedValueOnce([
          { chatId: 'channel-2', createdAt: new Date('2026-05-14T08:59:00.000Z') },
        ]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest.fn().mockResolvedValue([{ chatId: 'channel-1', botId: '777000_bot' }]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const rosterSync = {
        scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
      };

      const service = new AdminService(
        prisma as never,
        {} as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      (service as any).maxChatAdminRosterSyncService = rosterSync;

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'channel-1',
          title: 'Подтверждённый канал',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        }),
      ]);

      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
        chatId: 'channel-2',
        botIds: ['777000_bot'],
        title: 'Канал без свежего edge',
        entityType: 'channel',
        source: 'admin_access_validation',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps legacy allowlist channels hidden until the runtime bot validates them', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany
        .mockResolvedValueOnce([
          {
            chat: {
              id: 'channel-legacy',
              title: 'Старый канал без botId',
              createdAt: new Date('2026-03-01T10:00:00.000Z'),
              entityType: 'CHANNEL',
              primaryBotId: null,
              botId: null,
            },
          },
        ])
        .mockResolvedValueOnce([
          { chatId: 'channel-legacy', createdAt: new Date('2026-05-14T08:59:00.000Z') },
        ]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      (prisma as any).chatBotMembership = {
        findMany: jest.fn().mockResolvedValue([]),
      };
      const rosterSync = {
        scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
      };

      const service = new AdminService(
        prisma as never,
        {} as never,
        createChatContextCacheMock() as never,
        createConfigMock({ botId: '777000_bot' }) as never,
      );
      (service as any).maxChatAdminRosterSyncService = rosterSync;

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      expect(prisma.chatAdminAllowlist.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            chat: expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  primaryBotId: null,
                  botId: null,
                  botMemberships: { none: {} },
                }),
              ]),
            }),
          }),
        }),
      );
      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect((prisma as any).chatBotMembership.findMany).toHaveBeenCalledWith({
        where: {
          chatId: {
            in: ['channel-legacy'],
          },
          botId: {
            in: ['777000_bot'],
          },
          status: ChatBotMembershipStatus.ACTIVE,
        },
        select: {
          chatId: true,
          botId: true,
        },
      });
      expect(rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
        chatId: 'channel-legacy',
        botIds: ['777000_bot'],
        title: 'Старый канал без botId',
        entityType: 'channel',
        source: 'admin_access_validation',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('queues every allowlisted channel missing a fresh access edge without exposing it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      const channels = Array.from({ length: 15 }, (_, index) => {
        const channelNumber = index + 1;
        const createdDay = String(20 - index).padStart(2, '0');
        return {
          chat: {
            id: `channel-${String(channelNumber).padStart(2, '0')}`,
            title: `Канал ${channelNumber}`,
            createdAt: new Date(`2026-03-${createdDay}T10:00:00.000Z`),
            entityType: 'CHANNEL',
            primaryBotId: '777000_bot',
            botId: '777000_bot',
          },
        };
      });
      prisma.chatAdminAllowlist.findMany.mockResolvedValueOnce(channels).mockResolvedValueOnce(
        channels.map(({ chat }) => ({
          chatId: chat.id,
          createdAt: new Date('2026-05-14T08:59:00.000Z'),
        })),
      );
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const rosterSync = {
        scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
      };

      const service = new AdminService(
        prisma as never,
        {} as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      (service as any).maxChatAdminRosterSyncService = rosterSync;

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledTimes(channels.length);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps allowlisted channels without access edges out of a published snapshot response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      const cachedChannel = {
        chat: {
          id: 'channel-1',
          title: 'Канал из snapshot',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        },
      };
      const missingChannel = {
        chat: {
          id: 'channel-2',
          title: 'Канал вне snapshot',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHANNEL',
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        },
      };
      prisma.chatAdminAllowlist.findMany
        .mockResolvedValueOnce([cachedChannel, missingChannel])
        .mockResolvedValueOnce([
          { chatId: 'channel-2', createdAt: new Date('2026-05-14T08:59:00.000Z') },
        ]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'channel-1', botId: '777000_bot' }])
          .mockResolvedValueOnce([{ chatId: 'channel-1', botId: '777000_bot' }])
          .mockResolvedValueOnce([]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
          version: 'snapshot-v1',
          builtAt: '2026-04-04T10:00:00.000Z',
          lastSyncedAt: '2026-04-04T09:59:30.000Z',
          itemCount: 1,
          itemsHash: 'hash-v1',
          items: [
            createChatSummaryFixture({
              id: 'channel-1',
              title: 'Канал из snapshot',
              createdAt: '2026-03-02T10:00:00.000Z',
              entityType: 'channel',
              primaryBotId: '777000_bot',
            }),
          ],
        }),
      });
      const rosterSync = {
        scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
      };

      const service = new AdminService(
        prisma as never,
        {} as never,
        chatContextCache as never,
        createConfigMock() as never,
      );
      (service as any).maxChatAdminRosterSyncService = rosterSync;
      const rebuildSpy = jest
        .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
        .mockImplementation(() => undefined);

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'channel-1',
          title: 'Канал из snapshot',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          primaryBotId: '777000_bot',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        }),
      ]);

      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
      expect(rebuildSpy).not.toHaveBeenCalled();
      expect(rosterSync.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('queues another active runtime bot without granting an allowlisted channel inline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany
        .mockResolvedValueOnce([
          {
            chat: {
              id: 'channel-shared',
              title: 'Канал у второго бота',
              createdAt: new Date('2026-03-01T10:00:00.000Z'),
              entityType: 'CHANNEL',
              primaryBotId: '777000_bot',
              botId: '777000_bot',
            },
          },
        ])
        .mockResolvedValueOnce([
          { chatId: 'channel-shared', createdAt: new Date('2026-05-14T08:55:00.000Z') },
        ]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).chatBotMembership = {
        findMany: jest.fn().mockResolvedValue([{ chatId: 'channel-shared', botId: '888000_bot' }]),
      };
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              chatId: 'channel-shared',
              botId: '777000_bot',
              state: 'BOT_DENIED',
              deniedReason: 'bot_denied',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            },
          ]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const rosterSync = {
        scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
      };

      const service = new AdminService(
        prisma as never,
        {} as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      (service as any).managedEntitiesRuntimeBotIds = new Set(['777000_bot', '888000_bot']);
      (service as any).maxChatAdminRosterSyncService = rosterSync;

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      expect((prisma as any).chatBotMembership.findMany).toHaveBeenCalledWith({
        where: {
          chatId: {
            in: ['channel-shared'],
          },
          botId: {
            in: ['777000_bot', '888000_bot'],
          },
          status: ChatBotMembershipStatus.ACTIVE,
        },
        select: {
          chatId: true,
          botId: true,
        },
      });
      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
        chatId: 'channel-shared',
        botIds: expect.arrayContaining(['777000_bot', '888000_bot']),
        title: 'Канал у второго бота',
        entityType: 'channel',
        source: 'admin_access_validation',
      });
      expect(rosterSync.scheduleChatAdminRosterSync.mock.calls[0]?.[0].botIds).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('merges fresh GRANTED access-edge channels missing from a published snapshot response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValueOnce([]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'channel-1', botId: '777000_bot' }])
          .mockResolvedValueOnce([
            {
              chatId: 'channel-2',
              botId: '777000_bot',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
              chat: {
                id: 'channel-2',
                title: 'Канал только из edge',
                createdAt: new Date('2026-03-01T10:00:00.000Z'),
                entityType: 'CHANNEL',
                primaryBotId: '777000_bot',
                botId: '777000_bot',
              },
            },
          ])
          .mockResolvedValue([
            {
              chatId: 'channel-2',
              botId: '777000_bot',
              state: 'GRANTED',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            },
          ]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      (prisma as any).chatBotMembership = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'channel-1', botId: '777000_bot' }])
          .mockResolvedValueOnce([{ chatId: 'channel-2', botId: '777000_bot' }])
          .mockResolvedValue([{ chatId: 'channel-2', botId: '777000_bot' }]),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
          version: 'snapshot-v1',
          builtAt: '2026-04-04T10:00:00.000Z',
          lastSyncedAt: '2026-04-04T09:59:30.000Z',
          itemCount: 1,
          itemsHash: 'hash-v1',
          items: [
            createChatSummaryFixture({
              id: 'channel-1',
              title: 'Канал из snapshot',
              createdAt: '2026-03-02T10:00:00.000Z',
              entityType: 'channel',
              primaryBotId: '777000_bot',
            }),
          ],
        }),
      });

      const service = new AdminService(
        prisma as never,
        {} as never,
        chatContextCache as never,
        createConfigMock() as never,
      );
      const rebuildSpy = jest
        .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
        .mockImplementation(() => undefined);

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'channel-1',
          title: 'Канал из snapshot',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          primaryBotId: '777000_bot',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        }),
        createChatSummaryFixture({
          id: 'channel-2',
          title: 'Канал только из edge',
          createdAt: '2026-03-01T10:00:00.000Z',
          entityType: 'channel',
          primaryBotId: '777000_bot',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        }),
      ]);

      expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
      expect(rebuildSpy).toHaveBeenCalledWith('admin-1', 'channel');
      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    {
      label: 'USER_DENIED',
      deniedRow: {
        state: 'USER_DENIED' as const,
        deniedReason: 'user_not_admin',
      },
    },
    {
      label: 'chat_not_found',
      deniedRow: {
        state: 'BOT_DENIED' as const,
        deniedReason: 'chat_not_found',
      },
    },
    {
      label: 'bot_removed',
      deniedRow: {
        state: 'BOT_DENIED' as const,
        deniedReason: 'bot_removed',
      },
    },
  ])(
    'does not repair allowlist access edges over terminal $label denial',
    async ({ deniedRow }) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
      try {
        const prisma = createPrismaMock();
        prisma.chatAdminAllowlist.findMany
          .mockResolvedValueOnce([
            {
              chat: {
                id: 'channel-terminal',
                title: 'Терминально снятый канал',
                createdAt: new Date('2026-03-01T10:00:00.000Z'),
                entityType: 'CHANNEL',
                primaryBotId: '777000_bot',
                botId: '777000_bot',
              },
            },
          ])
          .mockResolvedValueOnce([
            { chatId: 'channel-terminal', createdAt: new Date('2026-05-14T08:55:00.000Z') },
          ]);
        prisma.channelSettings.findMany.mockResolvedValue([]);
        (prisma as any).chatBotMembership = {
          findMany: jest
            .fn()
            .mockResolvedValue([{ chatId: 'channel-terminal', botId: '888000_bot' }]),
        };
        (prisma as any).managedEntityAccessEdge = {
          findMany: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              {
                chatId: 'channel-terminal',
                botId: '777000_bot',
                checkedAt: new Date('2026-05-14T08:59:00.000Z'),
                ...deniedRow,
              },
            ]),
          upsert: jest.fn().mockResolvedValue(undefined),
        };

        const service = new AdminService(
          prisma as never,
          {} as never,
          createChatContextCacheMock() as never,
          createConfigMock() as never,
        );
        (service as any).managedEntitiesRuntimeBotIds = new Set(['777000_bot', '888000_bot']);

        await expect(
          service.listChannels({
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          }),
        ).resolves.toEqual([]);

        expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('does not patch a published snapshot from an unverified allowlist row', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      const snapshotChannel = {
        chat: {
          id: 'channel-snapshot',
          title: 'Канал из snapshot',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        },
      };
      const repairedChannel = {
        chat: {
          id: 'channel-repaired',
          title: 'Канал после repair',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHANNEL',
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        },
      };
      prisma.chatAdminAllowlist.findMany
        .mockResolvedValueOnce([snapshotChannel, repairedChannel])
        .mockResolvedValueOnce([
          { chatId: 'channel-repaired', createdAt: new Date('2026-05-14T08:55:00.000Z') },
        ]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).chatBotMembership = {
        findMany: jest
          .fn()
          .mockImplementation(async (args: { where?: { chatId?: { in?: string[] } } }) => {
            const chatIds = args.where?.chatId?.in ?? [];
            return [
              chatIds.includes('channel-snapshot')
                ? { chatId: 'channel-snapshot', botId: '777000_bot' }
                : null,
              chatIds.includes('channel-repaired')
                ? { chatId: 'channel-repaired', botId: '888000_bot' }
                : null,
            ].filter(Boolean);
          }),
      };
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'channel-snapshot', botId: '777000_bot' }])
          .mockResolvedValueOnce([{ chatId: 'channel-snapshot', botId: '777000_bot' }])
          .mockResolvedValueOnce([
            {
              chatId: 'channel-repaired',
              botId: '777000_bot',
              state: 'BOT_DENIED',
              deniedReason: 'bot_denied',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            },
          ]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getAdminAccess: jest
          .fn()
          .mockImplementation(async (chatId: string) =>
            chatId === 'channel-repaired' ? 'bot_denied' : null,
          ),
        getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
          version: 'snapshot-v1',
          builtAt: '2026-04-04T10:00:00.000Z',
          lastSyncedAt: '2026-04-04T09:59:30.000Z',
          itemCount: 1,
          itemsHash: 'hash-v1',
          items: [
            createChatSummaryFixture({
              id: 'channel-snapshot',
              title: 'Канал из snapshot',
              createdAt: '2026-03-02T10:00:00.000Z',
              entityType: 'channel',
              primaryBotId: '777000_bot',
            }),
          ],
        }),
      });

      const service = new AdminService(
        prisma as never,
        {} as never,
        chatContextCache as never,
        createConfigMock() as never,
      );
      (service as any).managedEntitiesRuntimeBotIds = new Set(['777000_bot', '888000_bot']);

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'channel-snapshot',
          title: 'Канал из snapshot',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          primaryBotId: '777000_bot',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        }),
      ]);

      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not repair allowlist access edges over fresh denied edge states', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany
        .mockResolvedValueOnce([
          {
            chat: {
              id: 'channel-denied',
              title: 'Снятый канал',
              createdAt: new Date('2026-03-01T10:00:00.000Z'),
              entityType: 'CHANNEL',
              primaryBotId: '777000_bot',
              botId: '777000_bot',
            },
          },
        ])
        .mockResolvedValueOnce([
          { chatId: 'channel-denied', createdAt: new Date('2026-05-14T08:55:00.000Z') },
        ]);
      prisma.channelSettings.findMany.mockResolvedValue([]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              chatId: 'channel-denied',
              botId: '777000_bot',
              state: 'BOT_DENIED',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            },
          ]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const rosterSync = {
        scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
      };

      const service = new AdminService(
        prisma as never,
        {} as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      (service as any).maxChatAdminRosterSyncService = rosterSync;

      await expect(
        service.listChannels({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
        chatId: 'channel-denied',
        botIds: ['777000_bot'],
        title: 'Снятый канал',
        entityType: 'channel',
        source: 'admin_access_validation',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not block default channel load on live snapshot hydration', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'channel-1',
          title: 'Кэш канала',
          lastEventTime: 100,
          entityType: 'channel',
          link: null,
          avatarUrl: null,
        },
      ]),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        title: 'Кэш канала',
        participantsCount: 321,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/channel-1',
        lastEventAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        avatarUrl: 'https://i.oneme.ru/channel-1.webp',
      }),
      getChatAdminIds: jest.fn(),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntityHeader).not.toHaveBeenCalled();
  });

  it('persists a presentable remote managed-entity title while priming headers', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).primeManagedEntityHeaders(
      [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Chat chat-1',
          createdAt: '2026-04-05T00:20:07.272Z',
          entityType: 'chat',
          primaryBotId: 'id613002203036_bot',
        }),
      ],
      [
        {
          chatId: 'chat-1',
          title: 'Продукция для общепита | РФ',
          entityType: 'chat',
          link: 'https://max.ru/chat-1',
          avatarUrl: 'https://i.oneme.ru/chat-1.webp',
          lastEventTime: 1,
        },
      ],
    );

    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { title: 'Продукция для общепита | РФ' },
    });
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chat-1',
        title: 'Продукция для общепита | РФ',
        entityType: 'chat',
        link: 'https://max.ru/chat-1',
        participantsCount: null,
        avatarUrl: 'https://i.oneme.ru/chat-1.webp',
        primaryBotId: 'id613002203036_bot',
      }),
    );
  });

  it('revalidates cached channels during refresh and checks admin for current scan window candidates', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-2',
        title: 'Новый канал',
        entityType: 'channel',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.chat.upsert.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: where.id === 'channel-1' ? 'Кэш канала' : 'Новый канал',
      createdAt:
        where.id === 'channel-1'
          ? new Date('2026-03-02T10:00:00.000Z')
          : new Date('2026-03-03T10:00:00.000Z'),
      entityType: 'CHANNEL',
    }));
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('user_denied'),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const discovered = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
      {
        respectCooldown: false,
        fullScan: true,
      },
    );

    await expect((service as any).hydrateManagedEntities(discovered.items)).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-2',
        title: 'Новый канал',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'channel-2',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
  });

  it('auto-discovers local channel candidates on default load when allowlist cache is empty', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:00:00.000Z'));

    const prisma = createPrismaMock();
    const cachedChannel = {
      chat: {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: new Date('2026-03-02T10:00:00.000Z'),
        entityType: 'CHANNEL',
      },
    };
    let allowlistRows: (typeof cachedChannel)[] = [];
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.chatAdminAllowlist.findMany.mockImplementation(async () => allowlistRows);
    prisma.chatAdminAllowlist.upsert.mockImplementation(async () => {
      allowlistRows = [cachedChannel];
      return undefined;
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createLocalManagedEntityRow({
          chatId: 'channel-1',
          title: 'Новости MAX',
          entityType: 'channel',
          createdAt: '2026-03-02T10:00:00.000Z',
        }),
      ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      {
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      },
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(chatContextCache.activateManagedEntitiesRefreshCooldown).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      45,
    );
  });

  it('falls back to cached channels and backs off refresh after MAX API throttling', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'remote-channel-1',
        title: 'Удалённый канал',
        entityType: 'channel',
      }),
    ]);
    prisma.chatAdminAllowlist.findMany.mockImplementation(async (args?: { where?: unknown }) => {
      const where = args?.where as { chatId?: string } | undefined;
      if (where?.chatId === 'remote-channel-1') {
        return [];
      }

      return [
        {
          chat: {
            id: 'cached-channel-1',
            title: 'Кэш канала',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHANNEL',
          },
        },
      ];
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 429,
          data: {
            code: 'rate.limit',
            message: 'MAX API global rate limit exceeded',
          },
        },
      }),
    };

    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'cached-channel-1',
        title: 'Кэш канала',
        entityType: 'channel',
        link: null,
        participantsCount: null,
        avatarUrl: 'https://i.oneme.ru/cached-channel-1.webp',
      }),
    });
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const discovered = await (service as any).runManagedEntitiesLocalDiscovery(
      user,
      'channel',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
      {
        respectCooldown: false,
        fullScan: true,
        includeRefreshState: true,
      },
    );

    expect(discovered.items).toEqual([]);
    await expect((service as any).hydrateManagedEntities(discovered.items)).resolves.toEqual([]);

    await expect((service as any).hydrateManagedEntities(discovered.items)).resolves.toEqual([]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(chatContextCache.activateManagedEntitiesRefreshBackoff).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      60,
    );
  });

  it('reuses cached header avatar on default channel load', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Новости MAX',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {};
    const storedHeader = {
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'channel',
      link: 'https://max.ru/news',
      participantsCount: null,
      avatarUrl: 'https://i.oneme.ru/news.webp',
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockImplementation(async () => storedHeader),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    await expect(service.listChannels(user)).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Новости MAX',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        link: 'https://max.ru/news',
        avatarUrl: 'https://i.oneme.ru/news.webp',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(chatContextCache.getManagedEntityHeader).toHaveBeenCalledWith('channel-1', 'channel');
  });

  it('returns cached channels immediately while managed refresh continues in the background', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    let resolveRefresh!: (value: {
      items: [];
      refresh: {
        complete: boolean;
        cursor: number | null;
        backoffActive: boolean;
        nextPollAfterMs: number;
      };
    }) => void;
    const discoverSpy = jest
      .spyOn(service as any, 'discoverManagedEntitiesFromLocalCatalog')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve as typeof resolveRefresh;
          }) as any,
      );

    await expect(
      service.listChannelsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'channel',
          link: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        },
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });

    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      0,
      60 * 60,
    );

    resolveRefresh({
      items: [],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
      },
    });
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  });

  it('clears stale cached channels when a local refresh revalidates and loses admin access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Устаревший канал',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('user_denied'),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).discoverManagedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual({
      items: [],
      refresh: null,
    });
  });

  it('marks local managed channels refresh complete after checking local candidates', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-121',
        title: 'Финальный канал',
        entityType: 'channel',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-121',
      title: 'Финальный канал',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock({});
    const maxClient = {
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) =>
          chatId === 'channel-121' ? ['admin-1'] : [],
        ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
        {
          respectCooldown: false,
          fullScan: true,
          includeRefreshState: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'channel-121',
          title: 'Финальный канал',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'channel',
          link: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
          channelOverview: {
            enabledScenariosCount: 0,
            commentsEnabled: false,
            postSuggestionsEnabled: false,
            commentsModerationEnabled: false,
          },
        },
      ],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
        processedCandidates: 1,
        totalCandidates: 1,
        progressPercent: 100,
        lastSyncedAt: expect.any(String),
        manualRefreshBlockedReason: 'recent_sync',
        manualRefreshRetryAfterMs: expect.any(Number),
      },
    });

    expect(chatContextCache.setManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntitiesLastSyncedAt).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      expect.any(String),
      30 * 24 * 60 * 60,
    );
  });

  it('completes local managed channels refresh inside the bounded candidate window', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: 41 }, (_, index) =>
        createLocalManagedEntityRow({
          chatId: `channel-${index + 1}`,
          title: `Канал ${index + 1}`,
          entityType: 'channel',
          createdAt: `2026-03-${String((index % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
        }),
      ),
    );
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.chat.upsert.mockImplementation(
      async ({ where, create }: { where: { id: string }; create: { title: string } }) => ({
        id: where.id,
        title: create.title,
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
        entityType: 'CHANNEL',
      }),
    );
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshCooldownKey = (service as any).buildManagedEntitiesRefreshCooldownKey(
      'admin-1',
      'channel',
    );

    const result = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      refreshCooldownKey,
      {
        respectCooldown: false,
        fullScan: true,
        includeRefreshState: true,
      },
    );

    expect(result.items).toHaveLength(41);
    expect(result.refresh).toEqual({
      complete: true,
      cursor: -1,
      backoffActive: false,
      nextPollAfterMs: 0,
      processedCandidates: 41,
      totalCandidates: 41,
      progressPercent: 100,
      lastSyncedAt: expect.any(String),
      manualRefreshBlockedReason: 'recent_sync',
      manualRefreshRetryAfterMs: expect.any(Number),
    });
    expect(chatContextCache.setManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'channel',
    );
    expect(chatContextCache.setManagedEntitiesLastSyncedAt).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      expect.any(String),
      30 * 24 * 60 * 60,
    );
  });

  it('returns refresh backoff metadata when managed channels sync is throttled', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'remote-channel-1',
        title: 'Новый канал',
        entityType: 'channel',
      }),
    ]);
    prisma.chatAdminAllowlist.findMany.mockImplementation(async (args?: { where?: unknown }) => {
      const where = args?.where as { chatId?: string } | undefined;
      if (where?.chatId === 'remote-channel-1') {
        return [];
      }

      return [
        {
          chat: {
            id: 'cached-channel-1',
            title: 'Кэш канала',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHANNEL',
          },
        },
      ];
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest
        .fn()
        .mockRejectedValue(
          new Error('MAX API managed_refresh source limit exceeded for bot id613002203036_bot'),
        ),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshCooldownKey = (service as any).buildManagedEntitiesRefreshCooldownKey(
      'admin-1',
      'channel',
    );

    const result = await (service as any).runManagedEntitiesLocalDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      refreshCooldownKey,
      {
        respectCooldown: false,
        fullScan: true,
        includeRefreshState: true,
      },
    );

    expect(result).toEqual({
      items: [],
      refresh: {
        complete: false,
        cursor: null,
        backoffActive: true,
        nextPollAfterMs: expect.any(Number),
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'backoff',
        manualRefreshRetryAfterMs: expect.any(Number),
      },
    });
    expect(result.refresh.nextPollAfterMs).toBeGreaterThan(0);
    expect(result.refresh.nextPollAfterMs).toBeLessThanOrEqual(60_000);

    expect(chatContextCache.activateManagedEntitiesRefreshBackoff).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      60,
    );
  });

  it('rechecks stale denied admin cache during explicit chat refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHAT',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('user_denied'),
    });
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'chat'),
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: null,
    });

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
  });

  it('limits a single explicit refresh pass to the configured full refresh window', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-cached',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: create.title ?? where.id,
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
        entityType: create.entityType ?? 'CHAT',
      }),
    );

    const uncachedRemoteChats = Array.from({ length: 101 }, (_, index) => ({
      chatId: `chat-${index + 1}`,
      title: index === 100 ? 'Хвостовой чат' : `Чат ${index + 1}`,
      lastEventTime: 300 - index,
      entityType: 'chat' as const,
      link: null,
    }));

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-cached',
          title: 'Кэшированный чат',
          lastEventTime: 500,
          entityType: 'chat',
          link: null,
        },
        ...uncachedRemoteChats,
      ]),
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) => (chatId === 'chat-101' ? ['admin-1'] : [])),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-cached',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalledWith('chat-101', {
      trafficClass: 'interactive',
    });
  });

  it('prioritizes locally observed chats when starting an explicitly remote diagnostic scan', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-priority',
        title: 'Приоритетный чат',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => ({
          chatId: `chat-${index + 1}`,
          title: `Чат ${index + 1}`,
          lastEventTime: 500 - index,
          entityType: 'chat' as const,
          link: null,
        })),
      ),
    };

    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    jest
      .spyOn(service as any, 'resolveUserAndBotAdminAccess')
      .mockImplementation(async (...args: unknown[]) => {
        const chatId = args[0] as string;
        return chatId === 'chat-priority'
          ? { status: 'granted', probeStartedAt: new Date('2026-03-03T09:59:00.000Z') }
          : { status: 'user_denied' };
      });
    jest
      .spyOn(service as any, 'persistManagedEntityAccessBestEffort')
      .mockImplementation(async (...args: unknown[]) => {
        const params = args[0] as {
          chatId: string;
          title: string;
          entityType: 'chat';
        };

        return createChatSummaryFixture({
          id: params.chatId,
          title: params.title,
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: params.entityType,
        });
      });

    const result = await (service as any).runManagedEntitiesDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'chat',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'chat'),
      {
        fullScan: true,
        includeRefreshState: true,
        bypassRemoteCache: false,
        revalidateCachedChats: false,
        resetRefreshCursor: false,
        throwOnFailure: true,
        allowRemoteListBotChats: true,
      },
    );

    expect(result.items).toEqual([
      createChatSummaryFixture({
        id: 'chat-priority',
        title: 'Приоритетный чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
    expect(result.refresh).toEqual({
      complete: false,
      cursor: 6,
      backoffActive: false,
      nextPollAfterMs: 1500,
      processedCandidates: 6,
      totalCandidates: 26,
      progressPercent: 23,
      lastSyncedAt: null,
      manualRefreshBlockedReason: 'in_progress',
      manualRefreshRetryAfterMs: 1500,
    });
    await expect(
      chatContextCache.getManagedEntitiesDiscoverySnapshot('admin-1', 'chat'),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: 'chat-priority',
          title: 'Приоритетный чат',
        }),
      ]),
    );
    await expect(
      chatContextCache.getManagedEntitiesDiscoverySnapshot('admin-1', 'chat'),
    ).resolves.toEqual([
      expect.objectContaining({
        chatId: 'chat-priority',
        title: 'Приоритетный чат',
      }),
      ...Array.from({ length: 25 }, (_, index) =>
        expect.objectContaining({
          chatId: `chat-${index + 1}`,
          title: `Чат ${index + 1}`,
        }),
      ),
    ]);
  });

  it('prunes cached managed entities missing from an explicitly remote revalidation', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-keep',
          title: 'Активный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
          primaryBotId: 'main-bot',
          botId: 'main-bot',
        },
      },
      {
        chat: {
          id: 'chat-missing',
          title: 'Бот больше не админ',
          createdAt: new Date('2026-03-02T09:00:00.000Z'),
          entityType: 'CHAT',
          primaryBotId: 'main-bot',
          botId: 'main-bot',
        },
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-keep',
          title: 'Активный чат',
          lastEventTime: 500,
          entityType: 'chat' as const,
          link: null,
          botId: 'main-bot',
          botIds: ['main-bot'],
        },
      ]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'granted',
      probeStartedAt: new Date('2026-03-02T09:59:00.000Z'),
    });
    jest.spyOn(service as any, 'persistManagedEntityAccessBestEffort').mockResolvedValue(
      createChatSummaryFixture({
        id: 'chat-keep',
        title: 'Активный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        primaryBotId: 'main-bot',
      }),
    );

    const result = await (service as any).runManagedEntitiesDiscovery(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'chat',
      (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'chat'),
      {
        fullScan: false,
        includeRefreshState: true,
        bypassRemoteCache: true,
        revalidateCachedChats: true,
        resetRefreshCursor: false,
        throwOnFailure: true,
        allowRemoteListBotChats: true,
      },
    );

    expect(result.items.map((item: ChatSummary) => item.id)).toEqual(['chat-keep']);
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-missing',
        userId: 'admin-1',
      },
    });
  });

  it('re-runs local discovery on repeated explicit refreshes even during success cooldown', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-24T00:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
      }),
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        user,
        'channel',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([expect.objectContaining({ id: 'channel-1' })]),
      }),
    );
    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        user,
        'channel',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'channel'),
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([expect.objectContaining({ id: 'channel-1' })]),
      }),
    );

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(chatContextCache.activateManagedEntitiesRefreshCooldown).toHaveBeenCalledWith(
      'admin-1',
      'channel',
      45,
    );
  });

  it('shares one in-flight channel discovery across parallel refresh requests', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
      }),
    ]);
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      createdAt: new Date('2026-03-02T10:00:00.000Z'),
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findMany.mockResolvedValue([]);

    let releaseDiscovery: (() => void) | undefined;
    const discoveryPromise = new Promise((resolve) => {
      releaseDiscovery = () =>
        resolve({
          items: [
            createChatSummaryFixture({
              id: 'channel-1',
              title: 'Новости MAX',
              createdAt: '2026-03-02T10:00:00.000Z',
              entityType: 'channel',
            }),
          ],
          refresh: null,
        });
    });

    const maxClient = {
      getChatAdminIds: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const user = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const runDiscoverySpy = jest
      .spyOn(service as any, 'runManagedEntitiesDiscovery')
      .mockImplementation(() => discoveryPromise);

    const first = (service as any).discoverManagedEntities(user, 'channel', {
      respectCooldown: false,
      fullScan: true,
    });
    const second = (service as any).discoverManagedEntities(user, 'channel', {
      respectCooldown: false,
      fullScan: true,
    });

    if (!releaseDiscovery) {
      throw new Error('releaseDiscovery was not initialized');
    }
    releaseDiscovery();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'channel-1', entityType: 'channel' })],
      }),
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'channel-1', entityType: 'channel' })],
      }),
    ]);

    expect(runDiscoverySpy).toHaveBeenCalledTimes(1);
  });

  it('does not let one user backoff block another user refresh', async () => {
    const prisma = createPrismaMock();
    const scopedBackoff = new Set<string>();
    scopedBackoff.add('admin-1:channel');
    const chatContextCache = createChatContextCacheMock({
      isManagedEntitiesRefreshBackoffActive: jest
        .fn()
        .mockImplementation(async (userId: string, entityType: string) =>
          scopedBackoff.has(`${userId}:${entityType}`),
        ),
    });

    const maxClient = {};

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const runDiscoverySpy = jest
      .spyOn(service as any, 'runManagedEntitiesDiscovery')
      .mockResolvedValue({
        items: [
          createChatSummaryFixture({
            id: 'channel-1',
            title: 'Новости MAX',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'channel',
          }),
        ],
        refresh: null,
      });

    await expect(
      (service as any).discoverManagedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
        {
          respectCooldown: false,
          fullScan: true,
          includeRefreshState: true,
        },
      ),
    ).resolves.toEqual({
      items: [],
      refresh: expect.objectContaining({
        backoffActive: true,
      }),
    });

    await expect(
      (service as any).discoverManagedEntities(
        {
          userId: 'admin-2',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'channel-1', entityType: 'channel' })],
      }),
    );

    expect(runDiscoverySpy).toHaveBeenCalledTimes(1);
  });
});

describe('AdminService.listChats', () => {
  it('filters published snapshot chats to the current runtime bot scope', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 3,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-owned',
            title: 'Чат Модерации',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
          createChatSummaryFixture({
            id: 'chat-foreign',
            title: 'Чужой чат',
            createdAt: '2026-04-02T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: 'foreign_bot',
          }),
          createChatSummaryFixture({
            id: 'chat-legacy',
            title: 'Старый чат без bot scope',
            createdAt: '2026-04-01T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    const rebuildSpy = jest
      .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
      .mockImplementation(() => undefined);

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-owned',
        title: 'Чат Модерации',
        createdAt: '2026-04-03T10:00:00.000Z',
        entityType: 'chat',
        primaryBotId: '777000_bot',
      }),
    ]);
    expect(rebuildSpy).toHaveBeenCalledWith('admin-1', 'chat');
  });

  it('keeps allowlisted chats without a fresh access edge out of a published snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValueOnce([
        {
          chat: {
            id: 'chat-1',
            title: 'Чат из snapshot',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHAT',
            primaryBotId: '777000_bot',
            botId: '777000_bot',
          },
        },
        {
          chat: {
            id: 'chat-2',
            title: 'Чат вне snapshot',
            createdAt: new Date('2026-03-01T10:00:00.000Z'),
            entityType: 'CHAT',
            primaryBotId: '777000_bot',
            botId: '777000_bot',
          },
        },
      ]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'chat-1', botId: '777000_bot' }])
          .mockResolvedValueOnce([]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
          version: 'snapshot-v1',
          builtAt: '2026-04-04T10:00:00.000Z',
          lastSyncedAt: '2026-04-04T09:59:30.000Z',
          itemCount: 1,
          itemsHash: 'hash-v1',
          items: [
            createChatSummaryFixture({
              id: 'chat-1',
              title: 'Чат из snapshot',
              createdAt: '2026-03-02T10:00:00.000Z',
              entityType: 'chat',
              primaryBotId: '777000_bot',
            }),
          ],
        }),
      });

      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
      );
      const rebuildSpy = jest
        .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
        .mockImplementation(() => undefined);

      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Чат из snapshot',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
      ]);

      expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
      expect(rebuildSpy).not.toHaveBeenCalled();
      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('merges fresh GRANTED access-edge chats missing from a published snapshot response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValueOnce([]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'chat-1', botId: '777000_bot' }])
          .mockResolvedValueOnce([
            {
              chatId: 'chat-2',
              botId: '777000_bot',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
              chat: {
                id: 'chat-2',
                title: 'Чат только из edge',
                createdAt: new Date('2026-03-01T10:00:00.000Z'),
                entityType: 'CHAT',
                primaryBotId: '777000_bot',
                botId: '777000_bot',
              },
            },
          ])
          .mockResolvedValue([
            {
              chatId: 'chat-2',
              botId: '777000_bot',
              state: 'GRANTED',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            },
          ]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      (prisma as any).chatBotMembership = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'chat-1', botId: '777000_bot' }])
          .mockResolvedValueOnce([{ chatId: 'chat-2', botId: '777000_bot' }])
          .mockResolvedValue([{ chatId: 'chat-2', botId: '777000_bot' }]),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
          version: 'snapshot-v1',
          builtAt: '2026-04-04T10:00:00.000Z',
          lastSyncedAt: '2026-04-04T09:59:30.000Z',
          itemCount: 1,
          itemsHash: 'hash-v1',
          items: [
            createChatSummaryFixture({
              id: 'chat-1',
              title: 'Чат из snapshot',
              createdAt: '2026-03-02T10:00:00.000Z',
              entityType: 'chat',
              primaryBotId: '777000_bot',
            }),
          ],
        }),
      });

      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
      );
      const rebuildSpy = jest
        .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
        .mockImplementation(() => undefined);

      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Чат из snapshot',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Чат только из edge',
          createdAt: '2026-03-01T10:00:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
      ]);

      expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
      expect(rebuildSpy).toHaveBeenCalledWith('admin-1', 'chat');
      expect((prisma as any).managedEntityAccessEdge.upsert).not.toHaveBeenCalled();
      expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not re-add a fresh-edge chat after a newer USER_DENIED edge', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      const grantedAt = new Date('2026-05-14T08:50:00.000Z');
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              chatId: 'chat-revoked',
              botId: 'bot-primary',
              checkedAt: grantedAt,
              chat: {
                id: 'chat-revoked',
                title: 'Бывший чат',
                createdAt: new Date('2026-03-01T10:00:00.000Z'),
                entityType: 'CHAT',
                primaryBotId: 'bot-primary',
                botId: 'bot-primary',
              },
            },
          ])
          .mockResolvedValueOnce([
            {
              chatId: 'chat-revoked',
              botId: 'bot-primary',
              state: 'GRANTED',
              checkedAt: grantedAt,
            },
            {
              chatId: 'chat-revoked',
              botId: 'bot-secondary',
              state: 'USER_DENIED',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            },
          ]),
      };
      (prisma as any).chatBotMembership = {
        findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-revoked', botId: 'bot-primary' }]),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
          version: 'snapshot-v1',
          builtAt: '2026-04-04T10:00:00.000Z',
          lastSyncedAt: '2026-04-04T09:59:30.000Z',
          itemCount: 0,
          itemsHash: 'hash-v1',
          items: [],
        }),
      });
      const service = new AdminService(
        prisma as never,
        { listBotChats: jest.fn() } as never,
        chatContextCache as never,
        createConfigMock({ botId: 'bot-primary' }) as never,
      );
      (service as any).managedEntitiesRuntimeBotIds = new Set(['bot-primary', 'bot-secondary']);

      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      expect((prisma as any).managedEntityAccessEdge.findMany).toHaveBeenCalledTimes(2);
      expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not merge access-edge chats without an active bot membership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValueOnce([]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest.fn().mockResolvedValueOnce([
          {
            chatId: 'chat-edge',
            botId: '777000_bot',
            checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            chat: {
              id: 'chat-edge',
              title: 'Нет active membership',
              createdAt: new Date('2026-03-01T10:00:00.000Z'),
              entityType: 'CHAT',
              primaryBotId: '777000_bot',
              botId: '777000_bot',
            },
          },
        ]),
      };
      (prisma as any).chatBotMembership = {
        findMany: jest.fn().mockResolvedValueOnce([]),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
          version: 'snapshot-v1',
          builtAt: '2026-04-04T10:00:00.000Z',
          lastSyncedAt: '2026-04-04T09:59:30.000Z',
          itemCount: 0,
          itemsHash: 'hash-v1',
          items: [],
        }),
      });

      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
      );

      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('excludes dormant configured bots from the managed entity runtime scope', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 2,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-active',
            title: 'Новый бот',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: 'active-bot',
          }),
          createChatSummaryFixture({
            id: 'chat-dormant',
            title: 'Старый бот',
            createdAt: '2026-04-02T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: 'dormant-bot',
          }),
        ],
      }),
    });
    const maxBotRegistry = {
      getOperationalBots: jest.fn().mockReturnValue([{ id: 'active-bot', state: 'active' }]),
      getAllBots: jest.fn().mockReturnValue([
        { id: 'active-bot', state: 'active' },
        { id: 'dormant-bot', state: 'dormant' },
      ]),
      getBotById: jest.fn((botId: string | null | undefined) => {
        if (botId === 'active-bot') {
          return { id: 'active-bot', state: 'active' };
        }
        if (botId === 'dormant-bot') {
          return { id: 'dormant-bot', state: 'dormant' };
        }
        return null;
      }),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: 'active-bot' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.map((chat) => chat.id)).toEqual(['chat-active']);
    expect(maxBotRegistry.getOperationalBots).toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chat: expect.objectContaining({
            OR: expect.arrayContaining([
              { primaryBotId: { in: ['active-bot'] } },
              { botId: { in: ['active-bot'] } },
            ]),
          }),
        }),
      }),
    );
    expect(JSON.stringify(prisma.chatAdminAllowlist.findMany.mock.calls)).not.toContain(
      'dormant-bot',
    );
  });

  it('keeps published snapshot chats visible through an active assigned bot when primary is stale', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 3,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-standby-visible',
            title: 'Чат со старым primary',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: 'dormant-bot',
            assignedBots: [
              createAssignedBotFixture({
                botId: 'active-bot',
                role: 'standby',
                lifecycleState: 'active',
              }),
            ],
            sharedMode: 'shared-standby',
          }),
          createChatSummaryFixture({
            id: 'chat-foreign-hidden',
            title: 'Чужой чат',
            createdAt: '2026-04-02T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: 'foreign-bot',
            assignedBots: [
              createAssignedBotFixture({
                botId: 'foreign-bot',
                role: 'primary',
                lifecycleState: 'active',
              }),
            ],
          }),
          createChatSummaryFixture({
            id: 'chat-dormant-hidden',
            title: 'Только старый бот',
            createdAt: '2026-04-01T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: 'dormant-bot',
          }),
        ],
      }),
    });
    const maxBotRegistry = {
      getOperationalBots: jest.fn().mockReturnValue([{ id: 'active-bot', state: 'active' }]),
      getAllBots: jest.fn().mockReturnValue([
        { id: 'active-bot', state: 'active' },
        { id: 'dormant-bot', state: 'dormant' },
        { id: 'foreign-bot', state: 'active' },
      ]),
      getBotById: jest.fn((botId: string | null | undefined) => {
        if (botId === 'active-bot') {
          return { id: 'active-bot', state: 'active' };
        }
        if (botId === 'dormant-bot') {
          return { id: 'dormant-bot', state: 'dormant' };
        }
        if (botId === 'foreign-bot') {
          return { id: 'foreign-bot', state: 'active' };
        }
        return null;
      }),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: 'active-bot' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.map((chat) => chat.id)).toEqual(['chat-standby-visible']);
    expect(result[0]?.primaryBotId).toBe('dormant-bot');
    expect(result[0]?.assignedBots.map((bot) => bot.botId)).toEqual(['active-bot']);
  });

  it('excludes dormant persisted bot memberships from remote admin access candidates', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValueOnce({
      primaryBotId: 'dormant-bot',
      botId: null,
      botMemberships: [{ botId: 'dormant-bot' }, { botId: 'active-bot' }],
    });
    const maxBotRegistry = {
      getOperationalBots: jest.fn().mockReturnValue([{ id: 'active-bot', state: 'active' }]),
      getAllBots: jest.fn().mockReturnValue([
        { id: 'active-bot', state: 'active' },
        { id: 'dormant-bot', state: 'dormant' },
      ]),
      getDiscoveryBots: jest.fn().mockReturnValue([{ id: 'active-bot', state: 'active' }]),
      getBotById: jest.fn((botId: string | null | undefined) => {
        if (botId === 'active-bot') {
          return { id: 'active-bot', state: 'active' };
        }
        if (botId === 'dormant-bot') {
          return { id: 'dormant-bot', state: 'dormant' };
        }
        return null;
      }),
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: 'active-bot' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    await expect((service as any).resolveCandidateBotIdsForChat('chat-1')).resolves.toEqual([
      'active-bot',
    ]);
    expect(JSON.stringify(maxBotRegistry.getBotById.mock.calls)).toContain('dormant-bot');
  });

  it('filters cached denied chats out of published snapshot responses and patches the snapshot', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-keep',
          title: 'Живой чат',
          createdAt: new Date('2026-04-03T10:00:00.000Z'),
          entityType: 'CHAT',
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockImplementation(async (chatId: string) => {
        return chatId === 'chat-stale' ? 'user_denied' : null;
      }),
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 2,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-keep',
            title: 'Живой чат',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
          createChatSummaryFixture({
            id: 'chat-stale',
            title: 'Старый чат',
            createdAt: '2026-04-02T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-keep',
        title: 'Живой чат',
        createdAt: '2026-04-03T10:00:00.000Z',
        entityType: 'chat',
        primaryBotId: '777000_bot',
      }),
    ]);
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [
          expect.objectContaining({
            id: 'chat-keep',
            title: 'Живой чат',
          }),
        ],
      }),
      expect.any(Number),
      { expectedVersion: 'snapshot-v1' },
    );
    expect(chatContextCache.setManagedEntitiesPublishedDiff).not.toHaveBeenCalled();
  });

  it('keeps fresh access-edge chats visible when legacy cache says bot_denied', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-bot-denied',
          title: 'Свежий edge через другого бота',
          createdAt: new Date('2026-04-03T10:00:00.000Z'),
          entityType: 'CHAT',
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-bot-denied') {
          return 'bot_denied';
        }
        if (chatId === 'chat-user-denied') {
          return 'user_denied';
        }
        return null;
      }),
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 2,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-bot-denied',
            title: 'Свежий edge через другого бота',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
          createChatSummaryFixture({
            id: 'chat-user-denied',
            title: 'Пользователь больше не админ',
            createdAt: '2026-04-02T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest
          .fn()
          .mockImplementation(async (chatId: string) =>
            chatId === 'chat-bot-denied' ? ['admin-1'] : [],
          ),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });
    await flushAsyncTasks();

    expect(result.map((item) => item.id)).toEqual(['chat-bot-denied']);
    expect(chatContextCache.getAdminAccess).toHaveBeenCalledWith('chat-bot-denied', 'admin-1');
    expect(chatContextCache.getAdminAccess).toHaveBeenCalledWith('chat-user-denied', 'admin-1');
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [expect.objectContaining({ id: 'chat-bot-denied' })],
      }),
      expect.any(Number),
      { expectedVersion: 'snapshot-v1' },
    );
    expect(chatContextCache.setManagedEntitiesPublishedDiff).not.toHaveBeenCalled();
  });

  it('returns the published snapshot during refresh requests instead of a partial in-progress list', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Из snapshot',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshState = {
      complete: false,
      cursor: 20,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 1500,
      processedCandidates: 20,
      totalCandidates: 100,
      progressPercent: 20,
      lastSyncedAt: null,
      manualRefreshBlockedReason: 'in_progress' as const,
      manualRefreshRetryAfterMs: 1500,
    };
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesBoundedRefresh')
      .mockResolvedValue(refreshState);

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        refresh: true,
      },
    );

    expect(result).toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Из snapshot',
          createdAt: '2026-04-03T10:00:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
      ],
      refresh: refreshState,
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
    });
  });

  it('overlays globally refreshed headers onto published snapshot responses', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Живое название',
        entityType: 'chat',
        link: 'https://max.ru/chat-1',
        participantsCount: 42,
        avatarUrl: 'https://cdn.max.ru/chat-1.webp',
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
      }),
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Старое название',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Живое название',
        createdAt: '2026-04-03T10:00:00.000Z',
        entityType: 'chat',
        link: 'https://max.ru/chat-1',
        avatarUrl: 'https://cdn.max.ru/chat-1.webp',
        primaryBotId: '777000_bot',
      }),
    ]);
  });

  it('returns a noop diff when refresh already targets the current published snapshot version', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Из snapshot',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshState = {
      complete: false,
      cursor: 20,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 1500,
      processedCandidates: 20,
      totalCandidates: 100,
      progressPercent: 20,
      lastSyncedAt: null,
      manualRefreshBlockedReason: 'in_progress' as const,
      manualRefreshRetryAfterMs: 1500,
    };
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesBoundedRefresh')
      .mockResolvedValue(refreshState);

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        refresh: true,
        sinceVersion: 'snapshot-v1',
      },
    );

    expect(result).toEqual({
      items: [],
      refresh: refreshState,
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
      diff: {
        mode: 'noop',
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v1',
      },
    });
    expect(chatContextCache.getManagedEntitiesPublishedDiff).not.toHaveBeenCalled();
  });

  it('returns a patch diff when the client asks for the previous published snapshot version', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v2',
        items: [
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-04T10:04:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
      }),
      getManagedEntitiesPublishedDiff: jest.fn().mockResolvedValue({
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v2',
        added: [
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-04T10:04:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
        updated: [],
        removedIds: [],
        orderedIds: ['chat-2'],
        changeCount: 1,
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const refreshState = {
      complete: false,
      cursor: 8,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 1500,
      processedCandidates: 8,
      totalCandidates: 20,
      progressPercent: 40,
      lastSyncedAt: null,
      manualRefreshBlockedReason: null,
      manualRefreshRetryAfterMs: null,
    };
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesBoundedRefresh')
      .mockResolvedValue(refreshState);

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        refresh: true,
        sinceVersion: 'snapshot-v1',
      },
    );

    expect(result).toEqual({
      items: [],
      refresh: refreshState,
      snapshot: {
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
      diff: {
        mode: 'patch',
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v2',
        added: [
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-04T10:04:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
        updated: [],
        removedIds: [],
        orderedIds: ['chat-2'],
      },
    });
  });

  it('returns a full merged refresh response when lightweight bootstrap finds a chat outside the published snapshot', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v2',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Старый чат',
            createdAt: '2026-04-04T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
      getManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue([
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Новый чат',
          createdAt: '2026-04-04T10:04:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
      ]),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );
    const refreshState = {
      complete: false,
      cursor: 8,
      backoffActive: false,
      userVisibleComplete: true,
      nextPollAfterMs: 1500,
      processedCandidates: 8,
      totalCandidates: 20,
      progressPercent: 40,
      lastSyncedAt: null,
      manualRefreshBlockedReason: null,
      manualRefreshRetryAfterMs: null,
    };
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesBoundedRefresh')
      .mockResolvedValue(refreshState);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: where.id === 'chat-2' ? 'Новый чат' : 'Старый чат',
      entityType: 'CHAT',
    }));
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt:
          where.id === 'chat-2'
            ? new Date('2026-04-04T10:04:00.000Z')
            : new Date('2026-04-04T10:00:00.000Z'),
      }),
    );

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        refresh: true,
        sinceVersion: 'snapshot-v1',
      },
    );

    expect(result).toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Новый чат',
          createdAt: '2026-04-04T10:04:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: refreshState,
      snapshot: {
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
    });
    expect(chatContextCache.getManagedEntitiesPublishedDiff).not.toHaveBeenCalled();
  });

  it('rebuilds the published snapshot from allowlist data when no full refresh is in progress', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(null),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
      expect.any(Number),
      { expectedVersion: null },
    );
  });

  it('retries a raced published snapshot rebuild and emits only the committed diff', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-final',
          title: 'Актуальный чат',
          createdAt: new Date('2026-04-04T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const firstSnapshot = {
      version: 'snapshot-v1',
      builtAt: '2026-04-04T09:00:00.000Z',
      lastSyncedAt: null,
      itemCount: 1,
      itemsHash: 'hash-v1',
      items: [
        createChatSummaryFixture({
          id: 'chat-final',
          title: 'Старая версия до гонки',
          createdAt: '2026-04-04T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
    };
    const concurrentSnapshot = {
      version: 'snapshot-v2',
      builtAt: '2026-04-04T09:30:00.000Z',
      lastSyncedAt: null,
      itemCount: 1,
      itemsHash: 'hash-v2',
      items: [
        createChatSummaryFixture({
          id: 'chat-final',
          title: 'Конкурентная старая версия',
          createdAt: '2026-04-04T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest
        .fn()
        .mockResolvedValueOnce(firstSnapshot)
        .mockResolvedValueOnce(concurrentSnapshot),
      setManagedEntitiesPublishedSnapshot: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const service = new AdminService(
      prisma as never,
      { listBotChats: jest.fn() } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.getManagedEntitiesPublishedSnapshot).toHaveBeenCalledTimes(2);
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledTimes(2);
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenNthCalledWith(
      1,
      'admin-1',
      'chat',
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'chat-final' })],
      }),
      expect.any(Number),
      { expectedVersion: 'snapshot-v1' },
    );
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenNthCalledWith(
      2,
      'admin-1',
      'chat',
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'chat-final' })],
      }),
      expect.any(Number),
      { expectedVersion: 'snapshot-v2' },
    );
    const committedSnapshot = chatContextCache.setManagedEntitiesPublishedSnapshot.mock.calls[1][2];
    expect(chatContextCache.setManagedEntitiesPublishedDiff).toHaveBeenCalledTimes(1);
    expect(chatContextCache.setManagedEntitiesPublishedDiff).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      'snapshot-v2',
      expect.objectContaining({
        baseVersion: 'snapshot-v2',
        nextVersion: committedSnapshot.version,
        added: [],
        updated: [expect.objectContaining({ id: 'chat-final', title: 'Актуальный чат' })],
        removedIds: [],
      }),
      expect.any(Number),
    );
  });

  it('rebuilds the published snapshot from allowlist and edge-only fresh access edges', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-allowlist',
            title: 'Чат из allowlist',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHAT',
            primaryBotId: '777000_bot',
            botId: '777000_bot',
          },
        },
      ]);
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'chat-allowlist', botId: '777000_bot' }])
          .mockResolvedValueOnce([
            {
              chatId: 'chat-edge',
              botId: '777000_bot',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
              chat: {
                id: 'chat-edge',
                title: 'Чат только из edge',
                createdAt: new Date('2026-03-01T10:00:00.000Z'),
                entityType: 'CHAT',
                primaryBotId: '777000_bot',
                botId: '777000_bot',
              },
            },
          ])
          .mockResolvedValue([
            {
              chatId: 'chat-edge',
              botId: '777000_bot',
              state: 'GRANTED',
              checkedAt: new Date('2026-05-14T08:59:00.000Z'),
            },
          ]),
      };
      (prisma as any).chatBotMembership = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ chatId: 'chat-allowlist', botId: '777000_bot' }])
          .mockResolvedValueOnce([{ chatId: 'chat-edge', botId: '777000_bot' }])
          .mockResolvedValue([{ chatId: 'chat-edge', botId: '777000_bot' }]),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
        getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(null),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
      );

      await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

      expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
        'admin-1',
        'chat',
        expect.objectContaining({
          itemCount: 2,
          items: [
            expect.objectContaining({ id: 'chat-allowlist' }),
            expect.objectContaining({ id: 'chat-edge' }),
          ],
        }),
        expect.any(Number),
        { expectedVersion: null },
      );
      expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('publishes the first snapshot even while a full refresh cursor is still in progress', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Тнк',
          createdAt: new Date('2026-04-05T00:20:07.272Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(20),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        itemCount: 1,
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Тнк',
            createdAt: '2026-04-05T00:20:07.272Z',
            entityType: 'chat',
          }),
        ],
      }),
      expect.any(Number),
      { expectedVersion: null },
    );
  });

  it('updates an existing published snapshot while a full refresh cursor is still in progress', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Первый чат',
          createdAt: new Date('2026-04-05T00:20:07.272Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-2',
          title: 'Новый чат',
          createdAt: new Date('2026-04-05T00:21:07.272Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-05T00:22:00.000Z',
        lastSyncedAt: null,
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Первый чат',
            createdAt: '2026-04-05T00:20:07.272Z',
            entityType: 'chat',
          }),
        ],
      }),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(20),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        itemCount: 2,
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Первый чат',
            createdAt: '2026-04-05T00:20:07.272Z',
            entityType: 'chat',
          }),
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-05T00:21:07.272Z',
            entityType: 'chat',
          }),
        ],
      }),
      expect.any(Number),
      { expectedVersion: 'snapshot-v1' },
    );
  });

  it('keeps the persisted chat title when the managed-entity header cache only has a fallback title', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Мер',
          createdAt: new Date('2026-04-05T00:36:52.557Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue(null),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(null),
      getManagedEntityHeader: jest.fn().mockResolvedValue(
        createManagedEntityHeaderFixture({
          id: 'chat-1',
          title: 'Chat chat-1',
          entityType: 'chat',
        }),
      ),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.objectContaining({
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Мер',
            createdAt: '2026-04-05T00:36:52.557Z',
            entityType: 'chat',
          }),
        ],
      }),
      expect.any(Number),
      { expectedVersion: null },
    );
  });

  it('stores a small published snapshot patch when rebuild publishes a new version', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Обновленный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-04T09:00:00.000Z',
        lastSyncedAt: '2026-04-04T08:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Старый чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(null),
      getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-04T10:00:00.000Z'),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await (service as any).rebuildManagedEntitiesPublishedSnapshot('admin-1', 'chat');

    expect(chatContextCache.setManagedEntitiesPublishedDiff).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      'snapshot-v1',
      expect.objectContaining({
        baseVersion: 'snapshot-v1',
        nextVersion: expect.any(String),
        updated: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Обновленный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
        added: [],
        removedIds: [],
        orderedIds: ['chat-1'],
        changeCount: 1,
      }),
      expect.any(Number),
    );
  });

  it('isolates cached allowlist chats to bots configured in the current runtime', async () => {
    const prisma = createPrismaMock();
    const allowlistRows = [
      {
        chat: {
          id: 'chat-owned',
          title: 'Чат Модерации',
          createdAt: new Date('2026-03-04T10:00:00.000Z'),
          entityType: 'CHAT' as const,
          primaryBotId: '777000_bot',
          botId: '777000_bot',
        },
      },
      {
        chat: {
          id: 'chat-foreign',
          title: 'Чужой чат',
          createdAt: new Date('2026-03-03T10:00:00.000Z'),
          entityType: 'CHAT' as const,
          primaryBotId: 'foreign_bot',
          botId: 'foreign_bot',
        },
      },
    ];
    prisma.chatAdminAllowlist.findMany.mockImplementation(
      async (args?: {
        where?: {
          chat?: {
            entityType?: 'CHAT' | 'CHANNEL';
            OR?: Array<
              | { primaryBotId?: { in?: string[] } }
              | { botId?: { in?: string[] } }
              | { botMemberships?: { some?: { botId?: { in?: string[] } } } }
            >;
          };
        };
      }) => {
        const where = args?.where;
        const runtimeBotIds = new Set(
          (where?.chat?.OR ?? []).flatMap((item) => {
            if ('primaryBotId' in item && Array.isArray(item.primaryBotId?.in)) {
              return item.primaryBotId.in;
            }
            if ('botId' in item && Array.isArray(item.botId?.in)) {
              return item.botId.in;
            }
            if ('botMemberships' in item && Array.isArray(item.botMemberships?.some?.botId?.in)) {
              return item.botMemberships.some.botId.in;
            }
            return [];
          }),
        );

        return allowlistRows.filter((row) => {
          if (where?.chat?.entityType && row.chat.entityType !== where.chat.entityType) {
            return false;
          }
          if (runtimeBotIds.size === 0) {
            return true;
          }

          return [row.chat.primaryBotId, row.chat.botId].some(
            (botId) => typeof botId === 'string' && runtimeBotIds.has(botId),
          );
        });
      },
    );

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-owned',
        title: 'Чат Модерации',
        createdAt: '2026-03-04T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(prisma.chatAdminAllowlist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chat: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                primaryBotId: { in: ['777000_bot'] },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it('bootstraps recent bot_added chats into the default chats list without remote discovery', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Новый чат',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Новый чат',
          is_channel: 'false',
        },
      ]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      return {
        id: where.id,
        title: where.id === 'chat-2' ? 'Новый чат' : 'Кэшированный чат',
        entityType: 'CHAT',
      };
    });
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt:
          where.id === 'chat-2'
            ? new Date('2026-03-03T10:00:00.000Z')
            : new Date('2026-03-02T10:00:00.000Z'),
      }),
    );

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatTitle: jest.fn().mockResolvedValue('Новый чат'),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Новый чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-2',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
    expect(maxClient.getChatTitle).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId: {
            chatId: 'chat-2',
            userId: 'admin-1',
          },
        },
      }),
    );
  });

  it('bootstraps recent bot_added chats from the inline recent bootstrap cache before webhook read models persist', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: 'Новый чат',
      entityType: 'CHAT',
    }));
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt: new Date('2026-04-03T10:00:00.000Z'),
      }),
    );

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock({
        getManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue([
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ]),
      }) as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Новый чат',
        createdAt: '2026-04-03T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('scans recent bot_added chats globally in addition to user-scoped candidates', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn().mockResolvedValue([]),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    const userScopedQueryCall = prisma.$queryRaw.mock.calls[0] ?? [];
    const globalQueryCall = prisma.$queryRaw.mock.calls[1] ?? [];
    expect(userScopedQueryCall).toContain('admin-1');
    expect(globalQueryCall).not.toContain('admin-1');
  });

  it('bootstraps a user-scoped bot_added chat even when the global recent scan is empty', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Моя новая группа',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      return {
        id: where.id,
        title: where.id === 'chat-2' ? 'Моя новая группа' : where.id,
        entityType: 'CHAT',
      };
    });
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Моя новая группа',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('hides a fresh user-scoped bot_added chat until bot admin rights are confirmed', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: '',
          is_channel: 'false',
          last_event_at: new Date().toISOString(),
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: 'Перепел',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-19T21:07:43.203Z'),
      primaryBotId: '777000_4_bot',
      botId: '777000_4_bot',
    }));

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('hides a fresh inline recent-cache bot_added chat before admin rights are confirmed', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: 'Перепел inline',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-20T09:00:00.000Z'),
      primaryBotId: '777000_4_bot',
      botId: '777000_4_bot',
    }));

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock({
        getManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue([
          {
            ...createChatSummaryFixture({
              id: 'chat-inline-1',
              title: 'Chat chat-inline-1',
              createdAt: new Date('2026-04-20T09:00:00.000Z').toISOString(),
              entityType: 'chat',
              primaryBotId: '777000_4_bot',
            }),
            bootstrapUserIds: ['admin-1'],
          },
        ]),
      }) as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);
  });

  it('does not show a user-scoped recent bot_added row over a global inline cache hit until access is confirmed', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-priority-1',
          chat_title: '',
          is_channel: 'false',
          last_event_at: new Date('2026-04-20T10:00:00.000Z').toISOString(),
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      title: 'Приоритетный чат',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-20T10:00:00.000Z'),
      primaryBotId: '777000_4_bot',
      botId: '777000_4_bot',
    }));

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock({
        getManagedEntitiesRecentBootstrap: jest.fn().mockResolvedValue([
          createChatSummaryFixture({
            id: 'chat-priority-1',
            title: 'Глобальный кэш',
            createdAt: new Date('2026-04-20T09:59:00.000Z').toISOString(),
            entityType: 'chat',
            primaryBotId: '777000_4_bot',
          }),
        ]),
      }) as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);
  });

  it('schedules a published snapshot rebuild when recent bot_added bootstrap finds a chat missing from the snapshot', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Моя новая группа',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);

    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesPublishedSnapshot: jest.fn().mockResolvedValue({
        version: 'snapshot-v1',
        builtAt: '2026-04-05T10:00:00.000Z',
        lastSyncedAt: '2026-04-05T09:59:30.000Z',
        itemCount: 1,
        itemsHash: 'hash-v1',
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Старый чат',
            createdAt: '2026-04-04T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const chat = createChatSummaryFixture({
      id: 'chat-2',
      title: 'Моя новая группа',
      createdAt: '2026-04-05T10:00:00.000Z',
      entityType: 'chat',
    });
    jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'granted',
      source: 'remote',
      probeStartedAt: new Date('2026-04-05T09:59:00.000Z'),
    });
    jest.spyOn(service as any, 'persistManagedEntityAccessBestEffort').mockResolvedValue(chat);
    const rebuildSpy = jest
      .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([chat]);

    await flushAsyncTasks();

    expect(rebuildSpy).toHaveBeenCalledWith('admin-1', 'chat');
  });

  it('caps lightweight recent bot_added admin checks on empty default chat lists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, index) => ({
        chat_id: `chat-${index + 1}`,
        chat_title: `Чат ${index + 1}`,
        is_channel: 'false',
      })),
    );

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn().mockResolvedValue([]),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(8);
    expect(maxClient.getChatAdminIds).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 350,
      }),
    );
  });

  it('caps lightweight recent bot_added bootstrap by total elapsed time on empty default chat lists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        chat_id: 'chat-1',
        chat_title: 'Чат 1',
        is_channel: 'false',
      },
      {
        chat_id: 'chat-2',
        chat_title: 'Чат 2',
        is_channel: 'false',
      },
      {
        chat_id: 'chat-3',
        chat_title: 'Чат 3',
        is_channel: 'false',
      },
    ]);

    let currentNowMs = 0;
    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn().mockImplementation(async () => {
        currentNowMs = 2_600;
        return [];
      }),
      getChatTitle: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentNowMs);

    try {
      jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
        items: [],
        refresh: null,
      });

      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([]);

      expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
      expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'managed_refresh',
          timeoutMs: 350,
        }),
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('does not remote-scan empty default chat lists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
      getChatAdminIds: jest.fn().mockResolvedValue([]),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
  });

  it('does not bootstrap stale recent bot_added chats when MAX denies current admin access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-2',
          chat_title: 'Битый чат',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Method is available only for chat administrator',
          },
        },
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-2',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('keeps listChats alive when deny-path allowlist pruning hits a saturated Prisma pool', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.chatAdminAllowlist.deleteMany.mockRejectedValueOnce({ code: 'P2024' });
    prisma.$queryRaw.mockResolvedValue([
      {
        chat_id: 'chat-2',
        chat_title: 'Новый чат',
        is_channel: 'false',
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Method is available only for chat administrator',
          },
        },
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    await flushAsyncTasks();

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-2',
        userId: { in: ['admin-1', 'idadmin-1'] },
      },
    });
  });

  it('keeps listChats alive when the allowlist read hits a saturated Prisma pool', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany
      .mockRejectedValueOnce({ code: 'P2024' })
      .mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn().mockResolvedValue([]),
      getChatAdminIds: jest.fn(),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);
  });

  it('reuses the last successful managed chat snapshot when a later allowlist read exceeds the response budget', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      const slowAllowlistRead = createDeferred<
        Array<{
          chat: { id: string; title: string; createdAt: Date; entityType: 'CHAT' };
        }>
      >();
      prisma.chatAdminAllowlist.findMany
        .mockResolvedValueOnce([
          {
            chat: {
              id: 'chat-1',
              title: 'Команда MAX',
              createdAt: new Date('2026-03-01T00:00:00.000Z'),
              entityType: 'CHAT',
            },
          },
        ])
        .mockImplementationOnce(async () => slowAllowlistRead.promise);

      const maxClient = {
        listBotChats: jest.fn().mockResolvedValue([]),
        getChatAdminIds: jest.fn(),
        getChatTitle: jest.fn(),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );

      jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);

      await expect(
        service.listChats({
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        }),
      ).resolves.toEqual([
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: '2026-03-01T00:00:00.000Z',
          entityType: 'chat',
        }),
      ]);

      await jest.advanceTimersByTimeAsync(2_100);

      const responsePromise = service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(300);

      await expect(responsePromise).resolves.toEqual([
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: '2026-03-01T00:00:00.000Z',
          entityType: 'chat',
        }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('revalidates cached chats with stale negative admin cache on default load', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Актуальный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-2',
          title: 'Устаревший чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-2') {
          return 'bot_denied';
        }

        return null;
      }),
    });
    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Method is available only for chat administrator',
          },
        },
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Актуальный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-2',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
  });

  it('proactively hides cached fallback-title chats when MAX says the bot lost access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: '-72545334298631',
          title: 'Chat -72545334298631',
          createdAt: new Date('2026-03-24T19:35:33.379Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-1',
          title: 'Рабочий чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === '-72545334298631') {
          throw {
            response: {
              status: 403,
              data: {
                code: 'chat.denied',
                message: 'Bot is not a chat member',
              },
            },
          };
        }

        return ['admin-1'];
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Рабочий чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-72545334298631',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 300,
      }),
    );

    await flushAsyncTasks();

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '-72545334298631',
        userId: { in: ['admin-1', 'idadmin-1'] },
      },
    });
  });

  it('removes cached private direct dialogs from allowlist on default load', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: '152517912',
          title: 'Chat 152517912',
          createdAt: new Date('2026-02-28T01:20:52.139Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-1',
          title: 'Рабочий чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn(),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Рабочий чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'admin-1',
        chatId: {
          in: ['152517912'],
        },
      },
    });
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
  });

  it('ignores private direct dialogs returned by the local discovery catalog', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: '152517912',
        title: 'Личка с ботом',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
      createLocalManagedEntityRow({
        chatId: 'chat-1',
        title: 'Рабочий чат',
        entityType: 'chat',
        createdAt: '2026-03-03T09:00:00.000Z',
      }),
    ]);
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
        (service as any).buildManagedEntitiesRefreshCooldownKey('admin-1', 'chat'),
        {
          respectCooldown: false,
          fullScan: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Рабочий чат',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: null,
    });

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId: {
            chatId: 'chat-1',
            userId: 'admin-1',
          },
        },
      }),
    );
  });

  it('does not bootstrap a private direct dialog into managed chats', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatEditableAdminIds: jest.fn(),
      getChatAdminIds: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.listChats({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: 'Личка с ботом',
    });

    expect(result).toEqual([]);
    expect(maxClient.getChatEditableAdminIds).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('warms the allowlist from priority local candidates on a cold default load without blocking the response', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-priority',
        title: 'Приоритетный чат',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);

    const maxChatAdminRosterSyncService = {
      scheduleDiscoverySnapshotSync: jest.fn().mockReturnValue(createDeferred<void>().promise),
    };

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);
    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatId: 'chat-launch',
        chatTitle: 'Лонч-чат',
        chatType: 'chat',
      }),
    ).resolves.toEqual([]);

    expect(maxChatAdminRosterSyncService.scheduleDiscoverySnapshotSync).toHaveBeenCalledWith([
      expect.objectContaining({
        chatId: 'chat-priority',
        title: 'Приоритетный чат',
        entityType: 'chat',
      }),
    ]);
  });

  it('uses bounded local warmup on a cold default load without queueing a full refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);
    const responseWarmupSpy = jest
      .spyOn(service as any, 'startManagedEntitiesResponseWarmup')
      .mockResolvedValue({
        items: [],
        refresh: null,
      });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    await flushAsyncTasks();

    expect(responseWarmupSpy).toHaveBeenCalledWith(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'chat',
      { includeRefreshState: false },
    );
    expect(managedEntitiesRefreshQueue.getJob).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
  });

  it('does not initialize a refresh cursor when cold default warmup fails', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const chatContextCache = createChatContextCacheMock();
    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockRejectedValue(new Error('queue unavailable')),
    };

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);
    jest.spyOn(service as any, 'startManagedEntitiesResponseWarmup').mockResolvedValue({
      items: [],
      refresh: null,
    });

    await expect(
      service.listChats({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([]);

    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(chatContextCache.setManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.getJob).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
  });

  it('reuses a cached chat avatar from stored header during refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      getChatSnapshot: jest.fn(),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Кэшированный чат',
        entityType: 'chat',
        link: null,
        participantsCount: 87,
        avatarUrl: 'https://i.oneme.ru/chat-1.webp',
      }),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Кэшированный чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
        avatarUrl: 'https://i.oneme.ru/chat-1.webp',
      }),
    ]);

    expect(chatContextCache.getManagedEntityHeader).toHaveBeenCalledWith('chat-1', 'chat');
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('keeps recent bot_added chats visible when starting a forced refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Недавно добавленный чат 1',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-3',
        title: 'Недавно добавленный чат 2',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-2',
          chatTitle: 'Текущий чат',
        },
        {
          refresh: true,
          bypassRemoteCache: true,
          resetRefreshCursor: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Недавно добавленный чат 1',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
        }),
        createChatSummaryFixture({
          id: 'chat-3',
          title: 'Недавно добавленный чат 2',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
        }),
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-01T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });

    expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      expect.objectContaining({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: true,
        resetRefreshCursor: true,
        createdAt: expect.any(String),
      }),
      expect.objectContaining({
        jobId: 'managed-entities-refresh__chat__admin-1',
      }),
    );
  });

  it('keeps lightweight bootstrap chats visible during a regular refresh before the first published snapshot exists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Недавно добавленный чат 1',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-3',
        title: 'Недавно добавленный чат 2',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-2',
          chatTitle: 'Текущий чат',
        },
        {
          refresh: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Недавно добавленный чат 1',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
        }),
        createChatSummaryFixture({
          id: 'chat-3',
          title: 'Недавно добавленный чат 2',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
        }),
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-01T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });

    expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      expect.objectContaining({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
        createdAt: expect.any(String),
      }),
      expect.objectContaining({
        jobId: 'managed-entities-refresh__chat__admin-1',
      }),
    );
  });

  it('does not wait for a slow recent bot_added bootstrap before returning a refresh response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: new Date('2026-03-01T10:00:00.000Z'),
            entityType: 'CHAT',
          },
        },
      ]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      const recentBootstrap = createDeferred<ChatSummary[]>();
      jest
        .spyOn(service as any, 'bootstrapRecentBotAddedEntities')
        .mockReturnValue(recentBootstrap.promise);

      const responsePromise = service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-2',
          chatTitle: 'Текущий чат',
        },
        {
          refresh: true,
          bypassRemoteCache: true,
          resetRefreshCursor: true,
        },
      );

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(responsePromise).resolves.toEqual({
        items: [
          createChatSummaryFixture({
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-01T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
        refresh: {
          complete: false,
          cursor: 0,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 1500,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: null,
          lastSyncedAt: null,
          manualRefreshBlockedReason: 'in_progress',
          manualRefreshRetryAfterMs: 1500,
        },
      });

      recentBootstrap.resolve([
        createChatSummaryFixture({
          id: 'chat-3',
          title: 'Недавно добавленный чат',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
        }),
      ]);
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps refresh responses alive when the allowlist read hits a saturated Prisma pool', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany
      .mockRejectedValueOnce({ code: 'P2024' })
      .mockResolvedValue([]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn().mockResolvedValue([]),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([]);

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
          bypassRemoteCache: true,
          resetRefreshCursor: true,
        },
      ),
    ).resolves.toEqual({
      items: [],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: false,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });
  });

  it('revalidates suspicious cached chats in refresh responses before returning them', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: '-72545334298631',
          title: 'Chat -72545334298631',
          createdAt: new Date('2026-03-24T19:35:33.379Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-1',
          title: 'Рабочий чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === '-72545334298631') {
          throw {
            response: {
              status: 404,
              data: {
                code: 'chat.not.found',
                message: 'Chat -72545334298631 not found',
              },
            },
          };
        }

        return ['admin-1'];
      }),
      getChatTitle: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    jest.spyOn(service as any, 'scheduleManagedEntitiesBoundedRefresh').mockResolvedValue({
      complete: false,
      cursor: 0,
      backoffActive: false,
      nextPollAfterMs: 1_500,
    });

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
        },
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Рабочий чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      '-72545334298631',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 300,
      }),
    );
  });

  it('does not wait for an uncached runtime governor decision before returning a refresh response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: new Date('2026-03-01T10:00:00.000Z'),
            entityType: 'CHAT',
          },
        },
      ]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const backgroundRuntimeGovernorService = {
        peekDecision: jest.fn().mockReturnValue(null),
        decide: jest.fn().mockReturnValue(createDeferred<never>().promise),
      };
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
        undefined,
        backgroundRuntimeGovernorService as never,
      );

      const responsePromise = service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
        },
      );

      const outcomePromise = Promise.race([
        responsePromise.then((value) => ({
          kind: 'resolved' as const,
          value,
        })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => {
            resolve({ kind: 'timeout' });
          }, 100);
        }),
      ]);

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);

      await expect(outcomePromise).resolves.toEqual({
        kind: 'resolved',
        value: {
          items: [
            createChatSummaryFixture({
              id: 'chat-1',
              title: 'Кэшированный чат',
              createdAt: '2026-03-01T10:00:00.000Z',
              entityType: 'chat',
            }),
          ],
          refresh: {
            complete: false,
            cursor: 0,
            backoffActive: false,
            userVisibleComplete: true,
            nextPollAfterMs: 1500,
            processedCandidates: null,
            totalCandidates: null,
            progressPercent: null,
            lastSyncedAt: null,
            manualRefreshBlockedReason: 'in_progress',
            manualRefreshRetryAfterMs: 1500,
          },
        },
      });

      expect(backgroundRuntimeGovernorService.peekDecision).toHaveBeenCalledWith({
        component: 'admin-managed-refresh',
        sourceTag: 'managed_refresh',
        allowRecoveryWindowRun: false,
        allowQueueLagSlowPathBelowSec: undefined,
      });
      expect(backgroundRuntimeGovernorService.decide).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('still defers a reset-cursor managed refresh on schedule when the governor reports slow pressure', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const backgroundRuntimeGovernorService = {
      peekDecision: jest.fn().mockImplementation((params: { allowRecoveryWindowRun?: boolean }) =>
        params.allowRecoveryWindowRun
          ? {
              action: 'slow',
              reason: 'background share 60.0%',
              retryAfterMs: 20_000,
            }
          : {
              action: 'pause',
              reason: 'recovery window in progress',
              retryAfterMs: 60_000,
            },
      ),
      decide: jest.fn(),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
      undefined,
      backgroundRuntimeGovernorService as never,
    );

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
          resetRefreshCursor: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-01T10:00:00.000Z',
          entityType: 'chat',
        }),
      ],
      refresh: {
        complete: false,
        cursor: null,
        backoffActive: true,
        userVisibleComplete: true,
        nextPollAfterMs: 20_000,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'backoff',
        manualRefreshRetryAfterMs: 20_000,
      },
    });

    expect(backgroundRuntimeGovernorService.peekDecision).toHaveBeenCalledWith({
      component: 'admin-managed-refresh',
      sourceTag: 'managed_refresh',
      allowRecoveryWindowRun: true,
      allowQueueLagSlowPathBelowSec: 30,
    });
    expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
  });

  it('reprioritizes a waiting managed refresh job when the user polls an already-started chat refresh', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const existingJob = {
      data: {
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: true,
      },
      opts: {},
      getState: jest.fn().mockResolvedValue('waiting'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(existingJob),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          refresh: true,
          includeRefreshState: true,
        } as never,
      ),
    ).resolves.toMatchObject({
      refresh: expect.objectContaining({
        cursor: 0,
        manualRefreshBlockedReason: 'in_progress',
      }),
    });

    expect(existingJob.remove).toHaveBeenCalledTimes(1);
    expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      expect.objectContaining({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: true,
        createdAt: expect.any(String),
      }),
      expect.objectContaining({
        jobId: 'managed-entities-refresh__chat__admin-1',
        priority: 2,
      }),
    );
  });

  it('does not wait for a slow managed discovery warmup before returning a forced refresh response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      const warmupDiscovery = createDeferred<{
        items: ChatSummary[];
        refresh: null;
      }>();
      jest
        .spyOn(service as any, 'discoverManagedEntities')
        .mockReturnValue(warmupDiscovery.promise);
      jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([
        createChatSummaryFixture({
          id: 'chat-2',
          title: 'Недавно добавленный чат',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
        }),
      ]);

      const responsePromise = service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatId: 'chat-2',
          chatTitle: 'Текущий чат',
        },
        {
          refresh: true,
          bypassRemoteCache: true,
          resetRefreshCursor: true,
        },
      );

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_500);

      await expect(responsePromise).resolves.toEqual({
        items: [
          createChatSummaryFixture({
            id: 'chat-2',
            title: 'Недавно добавленный чат',
            createdAt: '2026-03-03T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
        refresh: {
          complete: false,
          cursor: 0,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 1500,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: null,
          lastSyncedAt: null,
          manualRefreshBlockedReason: 'in_progress',
          manualRefreshRetryAfterMs: 1500,
        },
      });

      warmupDiscovery.resolve({
        items: [
          createChatSummaryFixture({
            id: 'chat-3',
            title: 'Найденный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
          }),
        ],
        refresh: null,
      });
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not overwrite a presentable title during recent bot_added bootstrap', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValueOnce({
      title: 'Устойчивое имя чата',
    });
    prisma.chat.upsert.mockResolvedValueOnce({
      id: 'chat-launch',
      title: 'Устойчивое имя чата',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue(null),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue([]),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
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
    jest.spyOn(service as any, 'resolveBotAssignment').mockResolvedValue(undefined);

    await expect(
      (service as any).persistManagedEntityAccessBestEffort({
        chatId: 'chat-launch',
        userId: 'admin-1',
        title: 'Лонч-тайтл',
        entityType: 'chat',
        source: 'recent_bot_added_bootstrap',
        probeStartedAt: new Date('2026-03-03T09:59:00.000Z'),
      }),
    ).resolves.toMatchObject({
      id: 'chat-launch',
      title: 'Устойчивое имя чата',
      entityType: 'chat',
    });

    const upsertArgs = prisma.chat.upsert.mock.calls[0][0];
    expect(upsertArgs.update).not.toHaveProperty('title');
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-launch',
        title: 'Устойчивое имя чата',
      }),
    );
  });

  it('writes an expiry on granted managed entity access edges', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      (prisma as any).managedEntityAccessEdge = {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AdminService(
        prisma as never,
        {} as never,
        createChatContextCacheMock() as never,
        createConfigMock({ botId: '777000_bot' }) as never,
      );

      await (service as any).upsertManagedEntityAccessEdge({
        chatId: 'chat-1',
        userId: 'admin-1',
        botId: '777000_bot',
        entityType: 'chat',
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        source: 'remote_admin_access',
      });

      expect((prisma as any).managedEntityAccessEdge.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            expiresAt: new Date('2026-05-17T09:00:00.000Z'),
          }),
          update: expect.objectContaining({
            expiresAt: new Date('2026-05-17T09:00:00.000Z'),
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not overwrite a presentable title during local discovery when the candidate title is fallback', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValueOnce({
      id: 'chat-launch',
      title: 'Устойчивое имя чата',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue(null),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue([]),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
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
    jest.spyOn(service as any, 'resolveBotAssignment').mockResolvedValue(undefined);

    await expect(
      (service as any).persistManagedEntityAccessBestEffort({
        chatId: 'chat-launch',
        userId: 'admin-1',
        title: 'Chat chat-launch',
        entityType: 'chat',
        source: 'local_discovery',
        probeStartedAt: new Date('2026-03-03T09:59:00.000Z'),
      }),
    ).resolves.toMatchObject({
      id: 'chat-launch',
      title: 'Устойчивое имя чата',
      entityType: 'chat',
    });

    const upsertArgs = prisma.chat.upsert.mock.calls[0][0];
    expect(upsertArgs.update).not.toHaveProperty('title');
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-launch',
        title: 'Устойчивое имя чата',
      }),
    );
  });

  it('replaces a fallback title during recent bot_added bootstrap when MAX provides a presentable title', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValueOnce({
      title: 'Chat chat-launch',
    });
    prisma.chat.upsert.mockResolvedValueOnce({
      id: 'chat-launch',
      title: 'Новый title из MAX',
      entityType: 'CHAT',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const maxBotLinkService = {
      bindDiscoveredChatBots: jest.fn().mockResolvedValue(null),
      getBotTokenSync: jest.fn().mockReturnValue('test-bot-token'),
      getValidationTokens: jest.fn().mockReturnValue([]),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
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
    jest.spyOn(service as any, 'resolveBotAssignment').mockResolvedValue('stale-discovery-bot');

    await expect(
      (service as any).persistManagedEntityAccessBestEffort({
        chatId: 'chat-launch',
        userId: 'admin-1',
        title: 'Новый title из MAX',
        entityType: 'chat',
        source: 'recent_bot_added_bootstrap',
        probeStartedAt: new Date('2026-03-03T09:59:00.000Z'),
      }),
    ).resolves.toMatchObject({
      id: 'chat-launch',
      title: 'Новый title из MAX',
      entityType: 'chat',
    });

    const upsertArgs = prisma.chat.upsert.mock.calls[0][0];
    expect(upsertArgs.create).toMatchObject({
      botId: 'stale-discovery-bot',
      primaryBotId: 'stale-discovery-bot',
    });
    expect(upsertArgs.update).toMatchObject({
      title: 'Новый title из MAX',
      entityType: 'CHAT',
    });
    expect(upsertArgs.update).not.toHaveProperty('botId');
    expect(upsertArgs.update).not.toHaveProperty('primaryBotId');
    expect(maxBotLinkService.bindDiscoveredChatBots).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-launch',
        title: 'Новый title из MAX',
        primaryBotId: 'stale-discovery-bot',
      }),
    );
  });

  it('returns cached chats immediately while managed refresh continues in the background', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatAdminIds: jest.fn(),
    };
    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    let resolveRefresh!: (value: {
      items: [];
      refresh: {
        complete: boolean;
        cursor: number | null;
        backoffActive: boolean;
        nextPollAfterMs: number;
      };
    }) => void;
    const discoverSpy = jest
      .spyOn(service as any, 'discoverManagedEntitiesFromLocalCatalog')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve as typeof resolveRefresh;
          }) as any,
      );

    const result = await service.listChatsWithRefreshState(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { refresh: true },
    );

    expect(result).toEqual({
      items: [
        {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });
    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      0,
      60 * 60,
    );

    resolveRefresh({
      items: [],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
      },
    });
    await flushAsyncTasks();
  });

  it('skips auto managed refresh scheduling while the cached list is still fresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:05:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHAT',
          },
        },
      ]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T18:00:00.000Z'),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      await expect(
        service.listChatsWithRefreshState(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { refresh: true },
        ),
      ).resolves.toEqual({
        items: [
          {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
            link: null,
            channelOverview: null,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
          },
        ],
        refresh: {
          complete: true,
          cursor: -1,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 0,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: 100,
          lastSyncedAt: '2026-04-01T18:00:00.000Z',
          manualRefreshBlockedReason: null,
          manualRefreshRetryAfterMs: null,
        },
      });

      expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('still queues managed refresh when bypassing remote cache even if the cached list is fresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:05:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHAT',
          },
        },
      ]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T18:00:00.000Z'),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      await expect(
        service.listChatsWithRefreshState(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { refresh: true, bypassRemoteCache: true },
        ),
      ).resolves.toEqual({
        items: [
          {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
            link: null,
            channelOverview: null,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
          },
        ],
        refresh: {
          complete: false,
          cursor: 0,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 1500,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: null,
          lastSyncedAt: null,
          manualRefreshBlockedReason: 'in_progress',
          manualRefreshRetryAfterMs: 1500,
        },
      });

      expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
        'refresh-managed-entities',
        expect.objectContaining({
          userId: 'admin-1',
          entityType: 'chat',
          bypassRemoteCache: true,
          resetRefreshCursor: false,
          createdAt: expect.any(String),
        }),
        expect.objectContaining({
          jobId: 'managed-entities-refresh__chat__admin-1',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips repeated forced managed refresh clicks while the last successful sync is still recent', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:05:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHAT',
          },
        },
      ]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T18:04:45.000Z'),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      await expect(
        service.listChatsWithRefreshState(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { refresh: true, bypassRemoteCache: true },
        ),
      ).resolves.toEqual({
        items: [
          {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
            link: null,
            channelOverview: null,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
          },
        ],
        refresh: {
          complete: true,
          cursor: -1,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 0,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: 100,
          lastSyncedAt: '2026-04-01T18:04:45.000Z',
          manualRefreshBlockedReason: 'recent_sync',
          manualRefreshRetryAfterMs: 15_000,
        },
      });

      expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
      expect(chatContextCache.setManagedEntitiesRefreshCursor).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('forces a managed refresh restart when reset cursor is requested even if the last sync is still fresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:05:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chatAdminAllowlist.findMany.mockResolvedValue([
        {
          chat: {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: new Date('2026-03-02T10:00:00.000Z'),
            entityType: 'CHAT',
          },
        },
      ]);

      const managedEntitiesRefreshQueue = {
        getJob: jest.fn().mockResolvedValue(null),
        add: jest.fn().mockResolvedValue(undefined),
      };
      const chatContextCache = createChatContextCacheMock({
        getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T18:04:45.000Z'),
      });
      const service = new AdminService(
        prisma as never,
        {
          listBotChats: jest.fn(),
          getChatAdminIds: jest.fn(),
        } as never,
        chatContextCache as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntitiesRefreshQueue as never,
      );

      await expect(
        service.listChatsWithRefreshState(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { refresh: true, resetRefreshCursor: true },
        ),
      ).resolves.toEqual({
        items: [
          {
            id: 'chat-1',
            title: 'Кэшированный чат',
            createdAt: '2026-03-02T10:00:00.000Z',
            entityType: 'chat',
            link: null,
            channelOverview: null,
            primaryBotId: null,
            assignedBots: [],
            sharedMode: 'owned',
          },
        ],
        refresh: {
          complete: false,
          cursor: 0,
          backoffActive: false,
          userVisibleComplete: true,
          nextPollAfterMs: 1500,
          processedCandidates: null,
          totalCandidates: null,
          progressPercent: null,
          lastSyncedAt: null,
          manualRefreshBlockedReason: 'in_progress',
          manualRefreshRetryAfterMs: 1500,
        },
      });

      expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
        'refresh-managed-entities',
        expect.objectContaining({
          userId: 'admin-1',
          entityType: 'chat',
          bypassRemoteCache: false,
          resetRefreshCursor: true,
          createdAt: expect.any(String),
        }),
        expect.objectContaining({
          jobId: 'managed-entities-refresh__chat__admin-1',
        }),
      );
      expect(chatContextCache.setManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
        'admin-1',
        'chat',
        0,
        60 * 60,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns fresh local candidates on demand without listing every bot chat', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-stale',
          title: 'Старый чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-fresh',
        title: 'Живой чат',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    const maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { fresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'chat-fresh',
        title: 'Живой чат',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
      },
      {
        id: 'chat-stale',
        title: 'Старый чат',
        createdAt: '2026-03-01T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
      },
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-fresh', {
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'managed_refresh',
      timeoutMs: 1000,
    });
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalledWith('chat-stale', expect.anything());
  });

  it('prioritizes local user-specific candidates during fresh managed chat discovery', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-target',
        title: 'Локальный приоритет',
        entityType: 'chat',
        createdAt: '2026-03-03T10:00:00.000Z',
      }),
    ]);
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    const maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
      getChatAdminIds: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-target') {
          return ['admin-1'];
        }
        return [];
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { fresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'chat-target',
        title: 'Локальный приоритет',
        createdAt: '2026-03-03T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
      },
    ]);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-target', {
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'managed_refresh',
      timeoutMs: 1000,
    });
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('returns transient fresh chats without backoff when persistence hits a saturated Prisma pool', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([
        createLocalManagedEntityRow({
          chatId: 'chat-fresh',
          title: 'Живой чат',
          entityType: 'chat',
          createdAt: '2026-03-03T10:00:00.000Z',
        }),
      ]);
      const chatContextCache = createChatContextCacheMock();
      const maxClient = {
        listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        chatContextCache as never,
        createConfigMock() as never,
      );

      jest.spyOn(service as any, 'publishRemoteAdminAccessEpoch').mockResolvedValue(true);
      jest.spyOn(service as any, 'bootstrapRecentBotAddedEntities').mockResolvedValue([
        createChatSummaryFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: '2026-03-01T00:00:00.000Z',
          entityType: 'chat',
        }),
      ]);
      jest
        .spyOn(service as any, 'upsertUserChatAccess')
        .mockRejectedValueOnce({ code: 'P2024', message: 'pool timeout' });

      await expect(
        service.listChats(
          {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          },
          { fresh: true },
        ),
      ).resolves.toEqual([
        {
          id: 'chat-1',
          title: 'Команда MAX',
          createdAt: '2026-03-01T00:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
        {
          id: 'chat-fresh',
          title: 'Живой чат',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ]);

      expect(chatContextCache.activateManagedEntitiesRefreshBackoff).not.toHaveBeenCalled();
      expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
      expect(maxClient.listBotChats).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not reuse an untimed admin access lookup for a timed managed refresh check', async () => {
    const prisma = createPrismaMock();
    const firstLookup = createDeferred<string[]>();
    const secondLookup = createDeferred<string[]>();
    const maxClient = {
      getChatAdminIds: jest
        .fn()
        .mockImplementationOnce(() => firstLookup.promise)
        .mockImplementationOnce(() => secondLookup.promise),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const first = (service as any).resolveUserAndBotAdminAccess('chat-1', 'admin-1');
    await flushAsyncTasks();

    const second = (service as any).resolveUserAndBotAdminAccess('chat-1', 'admin-1', {
      trafficClass: 'interactive',
      timeoutMs: 1000,
    });
    await flushAsyncTasks();

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatAdminIds).toHaveBeenNthCalledWith(1, 'chat-1', {
      actionHealthLane: 'background',
    });
    expect(maxClient.getChatAdminIds).toHaveBeenNthCalledWith(2, 'chat-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      timeoutMs: 1000,
    });

    secondLookup.resolve(['admin-1']);
    firstLookup.resolve(['admin-1']);

    await expect(second).resolves.toEqual(
      expect.objectContaining({
        status: 'granted',
        source: 'remote',
      }),
    );
    await expect(first).resolves.toEqual(
      expect.objectContaining({
        status: 'granted',
        source: 'remote',
      }),
    );
  });

  it('limits foreground fresh local candidate checks to ten chats', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) =>
        createLocalManagedEntityRow({
          chatId: `chat-fg-${index + 1}`,
          title: `Foreground ${index + 1}`,
          entityType: 'chat',
          createdAt: `2026-03-03T10:${String(index).padStart(2, '0')}:00.000Z`,
        }),
      ),
    );
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    const maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.listChats(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { fresh: true },
    );

    expect(result).toHaveLength(10);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(10);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-fg-1', expect.any(Object));
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-fg-10', expect.any(Object));
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalledWith('chat-fg-11', expect.any(Object));
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
  });

  it('checks uncached managed discovery candidates with the bot that found them', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue(null);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock({ botId: 'bot-1' }) as never,
    );

    await expect(
      (service as any).resolveUserAndBotAdminAccess('channel-old', 'admin-1', {
        bypassNegativeCache: true,
        allowPersistedFallback: false,
        entityType: 'channel',
        candidateBotIds: ['bot-2'],
        trafficClass: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 1200,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'granted',
        source: 'remote',
      }),
    );

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('channel-old', {
      actionHealthLane: 'background',
      botId: 'bot-2',
      sourceTag: 'managed_refresh',
      timeoutMs: 1200,
      trafficClass: 'background',
    });
  });

  it('queues a durable managed entities refresh when refresh is requested and a queue is available', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
    );

    const discoverSpy = jest.spyOn(service as never, 'discoverManagedEntities');

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    });

    expect(discoverSpy).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      expect.objectContaining({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
        createdAt: expect.any(String),
      }),
      expect.objectContaining({
        jobId: 'managed-entities-refresh__chat__admin-1',
        delay: resolveAdminManagedEntitiesRefreshJitterMs(
          'managed-entities-refresh__chat__admin-1',
          'enqueue',
        ),
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      }),
    );
  });

  it('pauses managed entities refresh scheduling while the shared system mode is degraded', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const managedEntitiesRefreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(undefined),
    };
    const degradedSnapshot = {
      mode: 'degrade',
      source: 'auto',
      reason: 'queue lag 18.0s',
      updatedAt: new Date().toISOString(),
      manualMode: null,
      queueLagSec: 18,
      action: {
        windowSec: 60,
        total: 180,
        success: 168,
        failure: 12,
        critical: 0,
        errorRate: 0.066,
        criticalRate: 0,
      },
    };
    const systemModeService = {
      peekCachedSnapshot: jest.fn().mockReturnValue(degradedSnapshot),
      getEffectiveSnapshot: jest.fn().mockResolvedValue(degradedSnapshot),
    };

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      managedEntitiesRefreshQueue as never,
      systemModeService as never,
    );

    await expect(
      service.listChatsWithRefreshState(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { refresh: true },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'chat-1',
          title: 'Кэшированный чат',
          createdAt: '2026-03-02T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: {
        complete: false,
        cursor: null,
        backoffActive: true,
        userVisibleComplete: true,
        nextPollAfterMs: 15_000,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'backoff',
        manualRefreshRetryAfterMs: 15_000,
      },
    });

    expect(systemModeService.peekCachedSnapshot).toHaveBeenCalled();
    expect(systemModeService.getEffectiveSnapshot).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.add).not.toHaveBeenCalled();
    expect(managedEntitiesRefreshQueue.getJob).not.toHaveBeenCalled();
  });

  it('returns a continuation delay when a managed refresh background job needs more chunks', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const discoverSpy = jest
      .spyOn(service as any, 'discoverManagedEntitiesFromLocalCatalog')
      .mockResolvedValue({
        items: [],
        refresh: {
          complete: false,
          cursor: 20,
          backoffActive: false,
          nextPollAfterMs: 1500,
        },
      });
    const repairSpy = jest
      .spyOn(service as any, 'repairManagedEntitiesAllowlistAfterFullRefresh')
      .mockResolvedValue(undefined);

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      }),
    ).resolves.toEqual({
      continueAfterMs: 1500,
    });

    expect(discoverSpy).toHaveBeenCalledTimes(1);
    expect(discoverSpy).toHaveBeenCalledWith(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'chat',
      expect.objectContaining({
        respectCooldown: false,
        fullScan: true,
        includeRefreshState: true,
      }),
    );
    expect(repairSpy).not.toHaveBeenCalled();
  });

  it('limits a bounded managed refresh background job to fifty local candidates', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: 55 }, (_, index) =>
        createLocalManagedEntityRow({
          chatId: `chat-bg-${index + 1}`,
          title: `Background ${index + 1}`,
          entityType: 'chat',
          createdAt: `2026-03-03T11:${String(index % 60).padStart(2, '0')}:00.000Z`,
        }),
      ),
    );
    prisma.chat.upsert.mockImplementation(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { title?: string; entityType?: string };
        update: { title?: string; entityType?: string };
      }) => ({
        id: where.id,
        title: update.title ?? create.title ?? where.id,
        entityType: update.entityType ?? create.entityType ?? 'CHAT',
        createdAt: new Date('2026-03-03T11:00:00.000Z'),
      }),
    );
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      }),
    ).resolves.toBeNull();

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(50);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-bg-1', expect.any(Object));
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-bg-50', expect.any(Object));
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalledWith('chat-bg-51', expect.any(Object));
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRefreshCursor).toHaveBeenCalledWith(
      'admin-1',
      'chat',
    );
  });

  it('rebuilds the published snapshot without destructive allowlist repair when a bounded refresh completes', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const verifiedItems = [
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Живой чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
    ];
    jest.spyOn(service as any, 'discoverManagedEntitiesFromLocalCatalog').mockResolvedValue({
      items: verifiedItems,
      fullScanCandidateIds: ['chat-1'],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
      },
    });
    const repairSpy = jest
      .spyOn(service as any, 'repairManagedEntitiesAllowlistAfterFullRefresh')
      .mockResolvedValue(undefined);
    const rebuildSpy = jest
      .spyOn(service as any, 'rebuildManagedEntitiesPublishedSnapshot')
      .mockResolvedValue(undefined);

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      }),
    ).resolves.toBeNull();

    expect(repairSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).toHaveBeenCalledWith('admin-1', 'chat');
  });

  it('removes allowlist rows missing from a completed full refresh before rebuilding the snapshot', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-keep',
          title: 'Живой чат',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-drop',
          title: 'Старый чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-denied',
          title: 'Бот больше не админ',
          createdAt: new Date('2026-03-01T09:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
      {
        chat: {
          id: 'chat-unknown',
          title: 'Временная ошибка проверки',
          createdAt: new Date('2026-03-01T08:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockImplementation(async (chatId: string) => {
        return chatId === 'chat-denied' ? 'bot_denied' : null;
      }),
    });
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const verifiedItems = [
      createChatSummaryFixture({
        id: 'chat-keep',
        title: 'Живой чат',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-denied',
        title: 'Бот больше не админ',
        createdAt: '2026-03-01T09:00:00.000Z',
        entityType: 'chat',
      }),
    ];

    await (service as any).repairManagedEntitiesAllowlistAfterFullRefresh(
      'admin-1',
      'chat',
      verifiedItems,
      ['chat-keep', 'chat-denied', 'chat-unknown'],
    );

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-drop',
        userId: 'admin-1',
      },
    });
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-denied',
        userId: 'admin-1',
      },
    });
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalledWith({
      where: {
        chatId: 'chat-keep',
        userId: 'admin-1',
      },
    });
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalledWith({
      where: {
        chatId: 'chat-unknown',
        userId: 'admin-1',
      },
    });
  });

  it('removes a pruned allowlist chat from the published snapshot immediately', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    await chatContextCache.setManagedEntitiesPublishedSnapshot('admin-1', 'chat', {
      version: 'snapshot-v1',
      builtAt: '2026-04-04T10:00:00.000Z',
      lastSyncedAt: '2026-04-04T09:59:30.000Z',
      itemCount: 2,
      itemsHash: 'hash-v1',
      items: [
        createChatSummaryFixture({
          id: 'chat-keep',
          title: 'Живой чат',
          createdAt: '2026-04-03T10:00:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
        createChatSummaryFixture({
          id: 'chat-stale',
          title: 'Старый чат',
          createdAt: '2026-04-02T10:00:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
      ],
    });
    chatContextCache.setManagedEntitiesPublishedSnapshot.mockClear();
    chatContextCache.setManagedEntitiesPublishedDiff.mockClear();
    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock({ botId: '777000_bot' }) as never,
    );

    await (service as any).prunePersistedChatAccess('chat-stale', 'admin-1');

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-stale',
        userId: 'admin-1',
      },
    });
    await expect(
      chatContextCache.getManagedEntitiesPublishedSnapshot('admin-1', 'chat'),
    ).resolves.toEqual(
      expect.objectContaining({
        itemCount: 1,
        items: [
          createChatSummaryFixture({
            id: 'chat-keep',
            title: 'Живой чат',
            createdAt: '2026-04-03T10:00:00.000Z',
            entityType: 'chat',
            primaryBotId: '777000_bot',
          }),
        ],
      }),
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-stale',
      userId: 'admin-1',
      state: 'user_denied',
      eventAt: expect.any(Date),
    });
    expect(chatContextCache.setManagedEntitiesPublishedDiff).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).not.toHaveBeenCalled();
  });

  it('defers a reset-cursor managed refresh background job when the governor reports slow pressure', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        decide: jest
          .fn()
          .mockImplementation(async (params: { allowRecoveryWindowRun?: boolean }) =>
            params.allowRecoveryWindowRun
              ? {
                  action: 'slow',
                  reason: 'background share 60.0%',
                  retryAfterMs: 20_000,
                }
              : {
                  action: 'pause',
                  reason: 'recovery window in progress',
                  retryAfterMs: 60_000,
                },
          ),
      } as never,
    );

    const discoverSpy = jest.spyOn(service as any, 'discoverManagedEntitiesFromLocalCatalog');

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: false,
        resetRefreshCursor: true,
      }),
    ).resolves.toEqual({
      continueAfterMs: 20_000,
    });

    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('allows a user-triggered managed refresh job to ignore a soft queue-lag pause below the slow-path ceiling', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        decide: jest.fn().mockResolvedValue({
          action: 'pause',
          reason: 'user-facing queue lag 19.5s',
          retryAfterMs: 60_000,
        }),
      } as never,
    );

    const discoverSpy = jest
      .spyOn(service as any, 'discoverManagedEntitiesFromLocalCatalog')
      .mockResolvedValue({
        items: [],
        refresh: {
          complete: false,
          cursor: 20,
          backoffActive: false,
          nextPollAfterMs: 1500,
        },
      });

    await expect(
      service.processManagedEntitiesRefreshJob({
        userId: 'admin-1',
        entityType: 'chat',
        bypassRemoteCache: true,
        resetRefreshCursor: true,
      }),
    ).resolves.toEqual({
      continueAfterMs: 1500,
    });

    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it('uses background traffic for local full-scan admin checks', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      createLocalManagedEntityRow({
        chatId: 'chat-local-1',
        title: 'Локальный чат',
        entityType: 'chat',
      }),
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([]);

    const service = new AdminService(
      prisma as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const accessSpy = jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'granted',
      source: 'remote',
      probeStartedAt: new Date('2026-03-03T09:59:00.000Z'),
    });
    jest.spyOn(service as any, 'upsertUserChatAccess').mockResolvedValue({
      id: 'chat-local-1',
      title: 'Локальный чат',
      createdAt: new Date('2026-03-03T10:00:00.000Z'),
      entityType: 'CHAT',
    });

    await expect(
      (service as any).runManagedEntitiesLocalDiscovery(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
        'managed-refresh-cooldown:test',
        {
          fullScan: true,
          includeRefreshState: true,
        },
      ),
    ).resolves.toEqual({
      items: [
        {
          id: 'chat-local-1',
          title: 'Локальный чат',
          createdAt: '2026-03-03T10:00:00.000Z',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: {
        complete: true,
        cursor: -1,
        backoffActive: false,
        nextPollAfterMs: 0,
        processedCandidates: 1,
        totalCandidates: 1,
        progressPercent: 100,
        lastSyncedAt: expect.any(String),
        manualRefreshBlockedReason: 'recent_sync',
        manualRefreshRetryAfterMs: expect.any(Number),
      },
    });

    expect(accessSpy).toHaveBeenCalledWith(
      'chat-local-1',
      'admin-1',
      expect.objectContaining({
        bypassNegativeCache: true,
        trafficClass: 'background',
      }),
    );
    expect((service as any).chatContextCache.setManagedEntitiesLastSyncedAt).toHaveBeenCalledWith(
      'admin-1',
      'chat',
      expect.any(String),
      30 * 24 * 60 * 60,
    );
  });

  it('reports refresh progress from the cached discovery snapshot and last sync timestamp', async () => {
    const chatContextCache = createChatContextCacheMock({
      getManagedEntitiesRefreshCursor: jest.fn().mockResolvedValue(20),
      getManagedEntitiesDiscoverySnapshot: jest.fn().mockResolvedValue(
        Array.from({ length: 50 }, (_, index) => ({
          chatId: `chat-${index + 1}`,
          title: `Чат ${index + 1}`,
          lastEventTime: 100 - index,
          entityType: 'chat',
          link: null,
        })),
      ),
      getManagedEntitiesLastSyncedAt: jest.fn().mockResolvedValue('2026-04-01T16:00:00.000Z'),
    });
    const service = new AdminService(
      createPrismaMock() as never,
      {
        listBotChats: jest.fn(),
        getChatAdminIds: jest.fn(),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).readManagedEntitiesRefreshState('admin-1', 'chat'),
    ).resolves.toEqual({
      complete: false,
      cursor: 20,
      backoffActive: false,
      nextPollAfterMs: 1500,
      processedCandidates: 20,
      totalCandidates: 50,
      progressPercent: 40,
      lastSyncedAt: '2026-04-01T16:00:00.000Z',
      manualRefreshBlockedReason: 'in_progress',
      manualRefreshRetryAfterMs: 1500,
    });
  });

  it('keeps cached chats during a fresh load without listing every bot chat', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-1',
          title: 'Уже не мой чат',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const maxClient = {
      listBotChats: jest.fn().mockRejectedValue(new Error('remote list must stay unused')),
      getChatAdminIds: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChats(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { fresh: true },
      ),
    ).resolves.toEqual([
      {
        id: 'chat-1',
        title: 'Уже не мой чат',
        createdAt: '2026-03-01T10:00:00.000Z',
        entityType: 'chat',
        link: null,
        channelOverview: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
      },
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
  });

  it('skips recent bot-added chats when only fallback titles are available', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        chat_id: 'chat-fallback',
        chat_title: null,
        is_channel: 'false',
      },
    ]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Chat chat-fallback',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'chat-fallback',
        title: 'Chat chat-fallback',
        entityType: 'chat',
        link: null,
        participantsCount: null,
        avatarUrl: null,
      }),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([]);

    expect(prisma.chat.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('bootstraps a user-scoped recent bot_added chat even when MAX omits chatTitle', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-fallback',
          chat_title: null,
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Chat chat-fallback',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-fallback',
      title: 'Chat chat-fallback',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-05T00:10:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-fallback',
        title: 'Chat chat-fallback',
        createdAt: '2026-04-05T00:10:00.000Z',
        entityType: 'chat',
      }),
    ]);

    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId: {
            chatId: 'chat-fallback',
            userId: 'admin-1',
          },
        },
      }),
    );
  });

  it('schedules a full roster sync after user-scoped recent bot_added access is confirmed', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'channel-late-admin',
          chat_title: 'Поздний канал',
          is_channel: 'true',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Поздний канал',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-late-admin',
      title: 'Поздний канал',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-04-05T00:10:00.000Z'),
      primaryBotId: null,
      botId: null,
    });
    const rosterSync = {
      scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
    };
    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      rosterSync as never,
    );

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'channel',
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-late-admin',
        title: 'Поздний канал',
        createdAt: '2026-04-05T00:10:00.000Z',
        entityType: 'channel',
      }),
    ]);

    expect(rosterSync.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: 'channel-late-admin',
      entityType: 'channel',
      source: 'admin_access_validation',
      retryUntilMs: null,
    });
  });

  it('re-arms a user-scoped recent bot_added fast lane when bot admin rights are still propagating', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-fresh',
          chat_title: 'Пре',
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const accessSpy = jest.spyOn(service as any, 'resolveUserAndBotAdminAccess').mockResolvedValue({
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
    });
    const fastLaneSpy = jest
      .spyOn(service as any, 'scheduleUserScopedRecentBotAddedFastLane')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([]);

    expect(accessSpy).toHaveBeenCalledWith(
      'chat-fresh',
      'admin-1',
      expect.objectContaining({
        bypassNegativeCache: true,
        trafficClass: 'background',
      }),
    );
    expect(fastLaneSpy).toHaveBeenCalledWith({
      chatId: 'chat-fresh',
      entityType: 'chat',
      title: 'Пре',
      userId: 'admin-1',
      reason: 'bot_not_admin',
    });
  });

  it('hydrates a user-scoped recent bot_added chat title immediately from MAX snapshot when available', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          chat_id: 'chat-fallback',
          chat_title: null,
          is_channel: 'false',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Chat chat-fallback',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-fallback',
      title: 'Chat chat-fallback',
      entityType: 'CHAT',
      createdAt: new Date('2026-04-05T00:10:00.000Z'),
      primaryBotId: null,
      botId: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-fallback',
        title: 'Рак',
        participantsCount: 17,
        status: 'active',
        isPublic: false,
        link: 'https://max.ru/chat-fallback',
        lastEventAt: null,
        entityType: 'chat',
        avatarUrl: 'https://i.oneme.ru/chat-fallback.webp',
      }),
    };
    const chatContextCache = createChatContextCacheMock();
    await chatContextCache.setManagedEntitiesPublishedSnapshot(
      'admin-1',
      'chat',
      {
        version: 'snapshot-old',
        builtAt: '2026-04-05T00:09:00.000Z',
        lastSyncedAt: null,
        itemCount: 1,
        itemsHash: 'hash-old',
        items: [
          createChatSummaryFixture({
            id: 'chat-fallback',
            title: 'Chat chat-fallback',
            createdAt: '2026-04-05T00:10:00.000Z',
            entityType: 'chat',
          }),
        ],
      },
      3600,
    );
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats')
      .mockImplementation(() => undefined);
    const schedulePublishedSnapshotRebuildSpy = jest
      .spyOn(service as any, 'scheduleManagedEntitiesPublishedSnapshotRebuild')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'chat-fallback',
        title: 'Рак',
        createdAt: '2026-04-05T00:10:00.000Z',
        entityType: 'chat',
        link: 'https://max.ru/chat-fallback',
        avatarUrl: 'https://i.oneme.ru/chat-fallback.webp',
      }),
    ]);

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'chat-fallback',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
        timeoutMs: 350,
        bypassCache: true,
      }),
    );
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-fallback' },
      data: { title: 'Рак' },
    });
    expect(chatContextCache.setManagedEntityHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chat-fallback',
        title: 'Рак',
        entityType: 'chat',
        link: 'https://max.ru/chat-fallback',
        participantsCount: 17,
        avatarUrl: 'https://i.oneme.ru/chat-fallback.webp',
      }),
    );
    await expect(
      chatContextCache.getManagedEntitiesPublishedSnapshot('admin-1', 'chat'),
    ).resolves.toEqual(
      expect.objectContaining({
        itemCount: 1,
        items: [
          expect.objectContaining({
            id: 'chat-fallback',
            title: 'Рак',
            link: 'https://max.ru/chat-fallback',
            avatarUrl: 'https://i.oneme.ru/chat-fallback.webp',
          }),
        ],
      }),
    );
    expect(schedulePublishedSnapshotRebuildSpy).toHaveBeenCalledWith('admin-1', 'chat');
  });

  it('repairs a stale persisted chat entity type when MAX confirms the id is a channel', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHAT',
    });
    const maxClient = {
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: '-100501',
        title: 'Приватный канал MAX',
        participantsCount: 8,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: null,
        entityType: 'channel',
        avatarUrl: null,
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'resolveBotAssignment').mockResolvedValue('777000_bot');
    const upsertSpy = jest.spyOn(service as any, 'upsertUserChatAccess').mockResolvedValue({
      id: '-100501',
      title: 'Приватный канал MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-04-21T10:20:00.000Z'),
      primaryBotId: '777000_bot',
      botId: '777000_bot',
    });

    await expect((service as any).ensureEntityType('-100501', 'admin-1', 'channel')).resolves.toBe(
      undefined,
    );

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      '-100501',
      expect.objectContaining({
        botId: '777000_bot',
        trafficClass: 'interactive',
      }),
    );
    expect(upsertSpy).toHaveBeenCalledWith('-100501', 'admin-1', 'Приватный канал MAX', 'channel', {
      updateEntityType: true,
      titleUpdateMode: 'fallback_only',
      preferredBotId: '777000_bot',
    });
  });

  it('keeps recent bot-added bootstrap alive when unsupported-chat pruning hits a saturated Prisma pool', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([
      {
        chat_id: '152517912',
        chat_title: 'Личка с ботом',
        is_channel: 'false',
      },
    ]);
    prisma.chatAdminAllowlist.deleteMany.mockRejectedValueOnce({ code: 'P2024' });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn(),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).bootstrapRecentBotAddedEntities(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        'chat',
      ),
    ).resolves.toEqual([]);

    await flushAsyncTasks();

    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: '152517912',
        userId: 'admin-1',
      },
    });
  });

  it('does not call live MAX hydration for cached default managed lists', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      listBotChats: jest.fn(),
      getChatSnapshot: jest.fn(),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue({
        id: 'channel-1',
        title: 'Кэш канала',
        entityType: 'channel',
        link: null,
        participantsCount: null,
        avatarUrl: 'https://i.oneme.ru/channel-1.webp',
      }),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        avatarUrl: 'https://i.oneme.ru/channel-1.webp',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('returns a cached stale channel header when interactive MAX snapshot refresh times out', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Кэш канала',
      entityType: 'CHANNEL',
    });

    const cachedHeader = {
      id: 'channel-1',
      title: 'Кэш канала',
      entityType: 'channel' as const,
      link: null,
      participantsCount: null,
      avatarUrl: 'https://i.oneme.ru/channel-1.webp',
    };
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue(cachedHeader),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.getChannelHeader('channel-1', {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual({
      ...cachedHeader,
      primaryBotId: null,
      assignedBots: [],
      sharedMode: 'owned',
    });

    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('routes admin profile hydration through background action health lane', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    (service as any).resolveUserDisplayNames = jest.fn().mockResolvedValue(new Map());

    await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1']);

    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['user-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('prefers the access assist bot for background profile hydration', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
    };
    const maxBotLinkService = {
      resolveBotIdForCapability: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
      buildEntryBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
    };
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

    (service as any).resolveUserDisplayNames = jest.fn().mockResolvedValue(new Map());

    await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1']);

    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['user-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: [403, 404],
      botId: 'id613002203036_4_bot',
    });
  });

  it('keeps resolved profile cache entries scoped to the routed bot', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn((botId?: string | null) =>
        botId?.trim() ? `token:${botId.trim()}` : 'token:default',
      ),
      getValidationTokens: jest.fn().mockReturnValue(['token:bot-1', 'token:bot-2']),
      buildBotStartUrlSync: jest.fn((startPayload: string, botId?: string | null) => {
        const targetBotId = botId?.trim() || '777000_bot';
        return `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(
          startPayload,
        )}`;
      }),
    };
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

    (service as any).resolveUserDisplayNames = jest.fn().mockResolvedValue(new Map());
    (service as any).resolveBackgroundReadBotAssignment = jest
      .fn()
      .mockResolvedValueOnce('bot-1')
      .mockResolvedValueOnce('bot-2');

    const first = await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1']);
    const second = await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1']);

    expect(first.get('user-1')?.profileHandoffUrl).toContain('https://max.ru/bot-1?start=');
    expect(second.get('user-1')?.profileHandoffUrl).toContain('https://max.ru/bot-2?start=');
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMemberProfiles).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      ['user-1'],
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(maxClient.getChatMemberProfiles).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      ['user-1'],
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('keeps local-only resolved profile handoffs scoped to the routed bot', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
    };
    const maxBotLinkService = {
      getBotTokenSync: jest.fn((botId?: string | null) =>
        botId?.trim() ? `token:${botId.trim()}` : 'token:default',
      ),
      getValidationTokens: jest.fn().mockReturnValue(['token:bot-2']),
      buildBotStartUrlSync: jest.fn((startPayload: string, botId?: string | null) => {
        const targetBotId = botId?.trim() || '777000_bot';
        return `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(
          startPayload,
        )}`;
      }),
    };
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

    (service as any).resolveUserDisplayNames = jest
      .fn()
      .mockResolvedValue(new Map([['user-1', 'User One']]));
    (service as any).resolveBackgroundReadBotAssignment = jest.fn().mockResolvedValue('bot-2');

    const profiles = await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1'], {
      allowRemoteLookup: false,
    });

    expect(profiles.get('user-1')?.profileHandoffUrl).toContain('https://max.ru/bot-2?start=');
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
      'bot-2',
    );
  });

  it('does not let a remote profile cache hide a newer local display-name snapshot', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              displayName: 'Старое удалённое имя',
              username: null,
              avatarUrl: null,
              profileUrl: null,
            },
          ],
        ]),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const resolveLocalNames = jest
      .fn()
      .mockResolvedValueOnce(new Map<string, string>())
      .mockResolvedValueOnce(new Map([['user-1', 'Новое локальное имя']]));
    (service as any).resolveUserDisplayNames = resolveLocalNames;

    await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1']);
    const localProfiles = await (service as any).resolveUserProfiles('chat-1', 'chat', ['user-1'], {
      allowRemoteLookup: false,
    });

    expect(localProfiles.get('user-1')?.displayName).toBe('Новое локальное имя');
    expect(resolveLocalNames).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledTimes(1);
  });

  it('returns cached navigation without an in-process MAX header walk', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'channel-1',
          title: 'Кэш канала',
          createdAt: new Date('2026-03-02T10:00:00.000Z'),
          entityType: 'CHANNEL',
        },
      },
    ]);
    prisma.channelSettings.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatSnapshot: jest
        .fn()
        .mockRejectedValue(new Error('MAX API background rate limit exceeded')),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue(null),
    });

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.listChannels({
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).resolves.toEqual([
      createChatSummaryFixture({
        id: 'channel-1',
        title: 'Кэш канала',
        createdAt: '2026-03-02T10:00:00.000Z',
        entityType: 'channel',
        channelOverview: {
          enabledScenariosCount: 0,
          commentsEnabled: false,
          postSuggestionsEnabled: false,
          commentsModerationEnabled: false,
        },
      }),
    ]);

    await flushAsyncTasks();

    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.activateManagedEntitiesRefreshBackoff).not.toHaveBeenCalled();
  });

  it('admits at most eight first-screen metadata tasks for older clients', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const readForUser = jest.fn().mockResolvedValue({ items: [] });
    (service as any).entityPresentation = { readForUser };
    (service as any).scheduleManagedEntityHeaderHydration(
      'admin-1',
      'channel',
      Array.from({ length: 1000 }, (_, index) =>
        createChatSummaryFixture({
          id: `channel-${index}`,
          title: 'Канал',
          createdAt: new Date(0).toISOString(),
          entityType: 'channel',
        }),
      ),
    );
    await flushAsyncTasks();
    expect(readForUser).toHaveBeenCalledTimes(1);
    expect(readForUser.mock.calls[0][1].entityIds).toHaveLength(8);
  });

  it('hydrates assigned bot avatars for managed entity headers and caches fresh misses', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      {
        id: 'chat-1',
        botId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        botMemberships: [
          {
            botId: 'id613002203036_bot',
            role: 'PRIMARY',
            status: 'ACTIVE',
            capabilities: [],
            permissionsSnapshot: null,
          },
          {
            botId: 'id613002203036_4_bot',
            role: 'STANDBY',
            status: 'ACTIVE',
            capabilities: [],
            permissionsSnapshot: null,
          },
        ],
      },
    ]);

    const maxClient = {
      getOwnProfile: jest.fn().mockResolvedValue({
        userId: '214634783',
        avatarUrl: 'https://cdn.max.ru/u/214634783/avatar.jpg',
      }),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityBotProfile: jest
        .fn()
        .mockImplementation(async (botId: string) =>
          botId === 'id613002203036_bot'
            ? { avatarUrl: 'https://cdn.max.ru/u/613002203036/avatar.jpg' }
            : null,
        ),
    });
    const maxBotRegistry = {
      getBotById: jest.fn((botId) =>
        ['id613002203036_bot', 'id613002203036_4_bot'].includes(botId) ? { id: botId } : null,
      ),
      getAllBots: jest.fn().mockReturnValue([
        {
          id: 'id613002203036_bot',
          label: 'MAXIM',
          state: 'active',
          speechPersona: 'male',
          characterName: 'Майор Максимов',
        },
        {
          id: 'id613002203036_4_bot',
          label: 'MAXIM 2',
          state: 'active',
          speechPersona: 'female',
          characterName: 'Майор Максимова',
        },
      ]),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'id613002203036_bot' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    const result = await (service as any).attachManagedEntityHeaderBotAssignments(
      createManagedEntityHeaderFixture({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        primaryBotId: 'id613002203036_bot',
      }),
    );

    expect(result.assignedBots).toEqual([
      {
        botId: 'id613002203036_bot',
        label: 'MAXIM',
        role: 'primary',
        membershipStatus: 'active',
        lifecycleState: 'active',
        speechPersona: 'male',
        characterName: 'Майор Максимов',
        avatarUrl: 'https://cdn.max.ru/u/613002203036/avatar.jpg',
        capabilities: [],
        permissionsSummary: null,
      },
      {
        botId: 'id613002203036_4_bot',
        label: 'MAXIM 2',
        role: 'standby',
        membershipStatus: 'active',
        lifecycleState: 'active',
        speechPersona: 'female',
        characterName: 'Майор Максимова',
        avatarUrl: 'https://cdn.max.ru/u/214634783/avatar.jpg',
        capabilities: [],
        permissionsSummary: null,
      },
    ]);
    expect(maxClient.getOwnProfile).toHaveBeenCalledWith({
      botId: 'id613002203036_4_bot',
      trafficClass: 'interactive',
      timeoutMs: 2500,
      sourceTag: 'settings_bot_profile',
    });
    expect(chatContextCache.setManagedEntityBotProfile).toHaveBeenCalledWith(
      'id613002203036_4_bot',
      {
        avatarUrl: 'https://cdn.max.ru/u/214634783/avatar.jpg',
      },
    );
  });

  it('does not fetch remote avatars for dormant assigned bots', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findMany.mockResolvedValue([
      {
        id: 'chat-1',
        botId: 'active-bot',
        primaryBotId: 'active-bot',
        botMemberships: [
          {
            botId: 'active-bot',
            role: 'PRIMARY',
            status: 'ACTIVE',
            capabilities: [],
            permissionsSnapshot: null,
          },
          {
            botId: 'dormant-bot',
            role: 'STANDBY',
            status: 'REMOVED',
            capabilities: [],
            permissionsSnapshot: null,
          },
        ],
      },
    ]);
    const maxClient = {
      getOwnProfile: jest.fn().mockResolvedValue({
        userId: 'active-bot',
        avatarUrl: 'https://cdn.max.ru/u/active/avatar.jpg',
      }),
    };
    const chatContextCache = createChatContextCacheMock();
    const maxBotRegistry = {
      getOperationalBots: jest.fn().mockReturnValue([{ id: 'active-bot', state: 'active' }]),
      getAllBots: jest.fn().mockReturnValue([
        {
          id: 'active-bot',
          label: 'Active',
          state: 'active',
          speechPersona: 'male',
        },
        {
          id: 'dormant-bot',
          label: 'Dormant',
          state: 'dormant',
          speechPersona: 'female',
        },
      ]),
      getBotById: jest.fn((botId: string | null | undefined) => {
        if (botId === 'active-bot') {
          return { id: 'active-bot', state: 'active' };
        }
        if (botId === 'dormant-bot') {
          return { id: 'dormant-bot', state: 'dormant' };
        }
        return null;
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'active-bot' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    const result = await (service as any).attachManagedEntityHeaderBotAssignments(
      createManagedEntityHeaderFixture({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        primaryBotId: 'active-bot',
      }),
    );

    expect(result.assignedBots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          botId: 'dormant-bot',
          lifecycleState: 'dormant',
          membershipStatus: 'removed',
          avatarUrl: null,
        }),
      ]),
    );
    expect(maxClient.getOwnProfile).toHaveBeenCalledTimes(1);
    expect(maxClient.getOwnProfile).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'active-bot' }),
    );
    expect(maxClient.getOwnProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'dormant-bot' }),
    );
  });
});

describe('AdminService settings screen endpoints', () => {
  it('aggregates chat settings screen data in one response', async () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const settings = chatSettingsSchema.parse({
      linkPolicy: 'BLOCKLIST_ONLY',
      greetingEnabled: true,
    });
    const rules = chatRulesSchema.parse({
      text: 'Правила чата',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
    });

    const getSettingsSpy = jest.spyOn(service, 'getSettings').mockResolvedValue(settings);
    const getRulesSpy = jest.spyOn(service, 'getRules').mockResolvedValue(rules);
    const getChatHeaderSpy = jest.spyOn(service, 'getChatHeader').mockResolvedValue(
      createManagedEntityHeaderFixture({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        participantsCount: 128,
      }),
    );
    const getDomainAllowlistDetailsSpy = jest
      .spyOn(service, 'getDomainAllowlistDetails')
      .mockResolvedValue([
        {
          domain: 'https://example.com',
          normalizedValue: 'https://example.com',
          matchType: 'EXACT',
          removeAfterAt: null,
        },
      ]);
    const listManagedBroadcastsSpy = jest
      .spyOn(service, 'listManagedBroadcasts')
      .mockResolvedValue([]);
    const assertChatAdminSpy = jest.spyOn(service, 'assertChatAdmin').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'ensureEntityType').mockResolvedValue(undefined);

    const result = await service.getChatSettingsScreen('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual({
      settings,
      reportsAvailable: false,
      duplicatePhotoModerationMode: 'OBSERVE',
      duplicateMessageModerationMode: 'OFF',
      commercialPhotoModerationMode: 'UNKNOWN',
      rules,
      header: createManagedEntityHeaderFixture({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'chat',
        participantsCount: 128,
      }),
      botSpeechPreviewProfile: null,
      requiredSubscriptionChannels: [],
      domains: [
        {
          domain: 'https://example.com',
          normalizedValue: 'https://example.com',
          matchType: 'EXACT',
          removeAfterAt: null,
        },
      ],
      managedBroadcasts: [],
    });
    expect(getSettingsSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true, skipEntityCheck: true },
    );
    expect(getRulesSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true, skipEntityCheck: true },
    );
    expect(getChatHeaderSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true, skipEntityCheck: true },
    );
    expect(getDomainAllowlistDetailsSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true },
    );
    expect(listManagedBroadcastsSpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { skipAdminCheck: true, skipEntityCheck: true },
    );
    expect(assertChatAdminSpy).toHaveBeenCalledWith('chat-1', 'admin-1', 'chat', {
      syncPersistedAccess: false,
      trafficClass: 'interactive',
      timeoutMs: 1_500,
      allowPersistedFallback: false,
      bypassPositiveCache: true,
      protectHumanAdministrator: true,
    });
  });

  it('routes section apply-to-all through partial settings keys', async () => {
    const prisma = createPrismaMock();
    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const settings = chatSettingsSchema.parse({
      linkPolicy: 'BLOCKLIST_ONLY',
      greetingEnabled: true,
    });

    jest.spyOn(service, 'getSettings').mockResolvedValue(settings);
    const applySpy = jest.spyOn(service as any, 'applySettingsToAllChats').mockResolvedValue({
      sourceChatId: 'chat-1',
      updatedChats: 2,
      appliedChatIds: ['chat-1', 'chat-2'],
    });

    const result = await service.applySettingsSectionToAllChats(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { section: 'links', target: { mode: 'all', favoriteTypes: [], chatIds: [] } },
    );

    expect(applySpy).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      settings,
      'miniapp',
      { mode: 'all', favoriteTypes: [], chatIds: [] },
      expect.arrayContaining(['linkPolicy', 'linkBotMessageEnabled', 'linkBotButtonText']),
      ['linkBotMessageText', 'linkWarnMessageText'],
    );
    expect(result).toEqual({
      section: 'links',
      targetMode: 'all',
      favoriteTypes: [],
      sourceChatId: 'chat-1',
      updatedChats: 2,
      appliedChatIds: ['chat-1', 'chat-2'],
    });

    const limitsResult = await service.applySettingsSectionToAllChats(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { section: 'limits', target: { mode: 'all', favoriteTypes: [], chatIds: [] } },
    );

    expect(applySpy).toHaveBeenLastCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      settings,
      'miniapp',
      { mode: 'all', favoriteTypes: [], chatIds: [] },
      expect.arrayContaining([
        'antiSpamEnabled',
        'deleteSpammersEnabled',
        'messageLimitsBotMessageEnabled',
        'phoneNumbersEnabled',
      ]),
      ['messageLimitsBotMessageText', 'messageLimitsWarnMessageText'],
    );
    const limitsSettingKeys = applySpy.mock.calls.at(-1)?.[5] as string[];
    expect(limitsSettingKeys).toContain('deleteSpammersEnabled');
    expect(limitsSettingKeys).not.toContain('phoneNumbersEscalationWindowHours');
    expect(limitsSettingKeys).not.toContain('messageLimitsBlockedWords');
    expect(limitsSettingKeys).not.toContain('messageLimitsBlockedDomains');
    expect(limitsResult.section).toBe('limits');

    const sourcePolicy = stopWordsPolicySchema.parse({
      enabled: true,
      rules: [{ id: 'source-rule', kind: 'WORD', value: 'casino' }],
    });
    prisma.chat.upsert.mockResolvedValueOnce({
      id: 'chat-1',
      settings: {
        ...settings,
        stopWordsPolicy: sourcePolicy,
        stopWordsRevision: 0,
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    } as never);
    jest.spyOn(service as any, 'assertManagedEntityReadAccess').mockResolvedValue(undefined);
    jest.spyOn(service, 'resolveChatSettingsReadBotAssignmentData').mockResolvedValue({});

    const stopWordsResult = await service.applySettingsSectionToAllChats(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        section: 'stopWords',
        expectedSourceRevision: 0,
        target: { mode: 'all', favoriteTypes: [], chatIds: [] },
      },
    );

    expect(applySpy).toHaveBeenLastCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'admin-1' }),
      expect.objectContaining({ stopWordsPolicy: sourcePolicy, stopWordsRevision: 0 }),
      'miniapp',
      { mode: 'all', favoriteTypes: [], chatIds: [] },
      ['stopWordsPolicy'],
      [],
    );
    expect(stopWordsResult.section).toBe('stopWords');
  });

  it('syncs allowlist entries when applying links section to all chats', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const removeAfterAt = new Date(Date.now() + 86_400_000);
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      {
        domain: 'domain:max.ru',
        removeAfterAt: null,
      },
      {
        domain: 'https://max.ru/join/srAq1j6jwW-enxSWrppR16_AC_NZpAA3oy-gyVPgGCsl',
        removeAfterAt,
      },
    ]);

    const service = createAdminServiceFixture(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    jest.spyOn(service, 'getSettings').mockResolvedValue(
      chatSettingsSchema.parse({
        linkPolicy: 'ALLOWLIST_ONLY',
      }),
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Регион 2',
        entityType: 'chat',
        createdAt: '2026-03-02T00:00:00.000Z',
      }),
    ]);
    jest.spyOn(service, 'assertChatSettingsBotCapabilities').mockResolvedValue(undefined);

    await service.applySettingsSectionToAllChats(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { section: 'links', target: { mode: 'all', favoriteTypes: [], chatIds: [] } },
    );

    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-2',
      },
    });
    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-2',
          domain: 'domain:max.ru',
        },
      },
      create: {
        chatId: 'chat-2',
        domain: 'domain:max.ru',
        removeAfterAt: null,
      },
      update: {
        removeAfterAt: null,
      },
    });
    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-2',
          domain: 'https://max.ru/join/srAq1j6jwW-enxSWrppR16_AC_NZpAA3oy-gyVPgGCsl',
        },
      },
      create: {
        chatId: 'chat-2',
        domain: 'https://max.ru/join/srAq1j6jwW-enxSWrppR16_AC_NZpAA3oy-gyVPgGCsl',
        removeAfterAt,
      },
      update: {
        removeAfterAt,
      },
    });
  });

  it('rejects settings fanout before settings writes when a target admin was revoked', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMembersAccess: createRevokedTargetAdminMemberFixture(),
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) =>
          chatId === 'chat-revoked' ? [] : ['admin-1'],
        ),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-revoked',
        title: 'Бывшая группа',
        entityType: 'chat',
        createdAt: '2026-03-02T00:00:00.000Z',
      }),
    ]);

    await expect(
      service.applySettingsToAllChats(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        chatSettingsSchema.parse({ antiSpamEnabled: false }),
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-revoked',
      expect.arrayContaining(['admin-1']),
      expect.objectContaining({ bypassCache: true }),
    );

    expect(
      prisma.chat.upsert.mock.calls.every(([args]) => args?.update?.settings === undefined),
    ).toBe(true);
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith({
      where: { chatId_userId: { chatId: 'chat-1', userId: 'admin-1' } },
      create: { chatId: 'chat-1', userId: 'admin-1' },
      update: {},
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('AdminService.getChannelStats', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('invalidates cached channel stats entries for the refreshed channel only', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const helpers = service['channelStatsRuntime'] as unknown as {
      buildChannelStatsResponseCacheKey: (
        chatId: string,
        userId: string,
        query: { range: '7d'; includeActivityPreview: boolean },
      ) => string;
      invalidateChannelStatsResponseCache: (chatId: string) => void;
      channelStatsResponseCache: Map<string, { expiresAtMs: number; promise: Promise<unknown> }>;
    };
    const channelOneKey = helpers.buildChannelStatsResponseCacheKey('channel-1', 'admin-a', {
      range: '7d',
      includeActivityPreview: false,
    });
    const channelTwoKey = helpers.buildChannelStatsResponseCacheKey('channel-2', 'admin-a', {
      range: '7d',
      includeActivityPreview: false,
    });
    helpers.channelStatsResponseCache.set(channelOneKey, {
      expiresAtMs: Date.now() + 30_000,
      promise: Promise.resolve({}),
    });
    helpers.channelStatsResponseCache.set(channelTwoKey, {
      expiresAtMs: Date.now() + 30_000,
      promise: Promise.resolve({}),
    });

    helpers.invalidateChannelStatsResponseCache('channel-1');

    expect(helpers.channelStatsResponseCache.has(channelOneKey)).toBe(false);
    expect(helpers.channelStatsResponseCache.has(channelTwoKey)).toBe(true);
  });

  it('rechecks cached granted access before building channel stats', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const buildResponseSpy = jest.spyOn(
      service['channelStatsRuntime'],
      'buildChannelStatsResponse',
    );

    await expect(
      service.getChannelStats(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { range: '7d' },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(buildResponseSpy).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('places views chart points by publication bucket', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildAverageViewsSeriesFromPostMetrics: (
        bucketStarts: Date[],
        postViewMetrics: Array<{
          post: {
            id: string;
            publishedAt: Date;
            latestViews: number;
          };
          viewsDelta: number;
          viewDeltas: Array<{
            capturedAt: Date;
            viewsDelta: number;
          }>;
        }>,
        bucket: 'hour' | 'day',
      ) => Array<{ at: string; posts: number; views: number }>;
    };

    const series = statsHelpers.buildAverageViewsSeriesFromPostMetrics(
      [new Date('2026-03-07T09:00:00.000Z'), new Date('2026-03-07T10:00:00.000Z')],
      [
        {
          post: {
            id: 'post-1',
            publishedAt: new Date('2026-03-07T09:20:00.000Z'),
            latestViews: 45,
          },
          viewsDelta: 45,
          viewDeltas: [
            {
              capturedAt: new Date('2026-03-07T09:10:00.000Z'),
              viewsDelta: 45,
            },
          ],
        },
        {
          post: {
            id: 'post-2',
            publishedAt: new Date('2026-03-07T10:40:00.000Z'),
            latestViews: 75,
          },
          viewsDelta: 75,
          viewDeltas: [
            {
              capturedAt: new Date('2026-03-07T10:05:00.000Z'),
              viewsDelta: 75,
            },
          ],
        },
      ],
      'hour',
    );

    expect(series).toEqual([
      {
        at: '2026-03-07T09:00:00.000Z',
        posts: 1,
        views: 45,
      },
      {
        at: '2026-03-07T10:00:00.000Z',
        posts: 1,
        views: 75,
      },
    ]);
  });

  it('builds the views chart as average views per post, not a summed bucket total', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildAverageViewsSeriesFromPostMetrics: (
        bucketStarts: Date[],
        postViewMetrics: Array<{
          post: {
            id: string;
            publishedAt: Date;
            latestViews: number;
          };
          viewsDelta: number;
          viewDeltas: Array<{
            capturedAt: Date;
            viewsDelta: number;
          }>;
        }>,
        bucket: 'hour' | 'day',
      ) => Array<{ at: string; posts: number; views: number }>;
    };

    const series = statsHelpers.buildAverageViewsSeriesFromPostMetrics(
      [new Date('2026-03-06T21:00:00.000Z')],
      [
        {
          post: {
            id: 'post-1',
            publishedAt: new Date('2026-03-07T09:20:00.000Z'),
            latestViews: 100,
          },
          viewsDelta: 100,
          viewDeltas: [
            {
              capturedAt: new Date('2026-03-07T11:20:00.000Z'),
              viewsDelta: 100,
            },
          ],
        },
        {
          post: {
            id: 'post-2',
            publishedAt: new Date('2026-03-07T10:15:00.000Z'),
            latestViews: 300,
          },
          viewsDelta: 300,
          viewDeltas: [
            {
              capturedAt: new Date('2026-03-07T11:25:00.000Z'),
              viewsDelta: 300,
            },
          ],
        },
      ],
      'day',
    );

    expect(series).toEqual([
      {
        at: '2026-03-06T21:00:00.000Z',
        posts: 2,
        views: 200,
      },
    ]);
  });

  it('counts each post once per views chart bucket', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildAverageViewsSeriesFromPostMetrics: (
        bucketStarts: Date[],
        postViewMetrics: Array<{
          post: {
            id: string;
            publishedAt: Date;
            latestViews: number;
          };
          viewsDelta: number;
          viewDeltas: Array<{
            capturedAt: Date;
            viewsDelta: number;
          }>;
        }>,
        bucket: 'hour' | 'day',
      ) => Array<{ at: string; posts: number; views: number }>;
    };

    const series = statsHelpers.buildAverageViewsSeriesFromPostMetrics(
      [new Date('2026-03-07T10:00:00.000Z')],
      [
        {
          post: {
            id: 'post-1',
            publishedAt: new Date('2026-03-07T10:20:00.000Z'),
            latestViews: 150,
          },
          viewsDelta: 150,
          viewDeltas: [
            {
              capturedAt: new Date('2026-03-07T10:05:00.000Z'),
              viewsDelta: 100,
            },
            {
              capturedAt: new Date('2026-03-07T10:40:00.000Z'),
              viewsDelta: 50,
            },
          ],
        },
        {
          post: {
            id: 'post-2',
            publishedAt: new Date('2026-03-07T10:45:00.000Z'),
            latestViews: 50,
          },
          viewsDelta: 50,
          viewDeltas: [
            {
              capturedAt: new Date('2026-03-07T10:20:00.000Z'),
              viewsDelta: 50,
            },
          ],
        },
      ],
      'hour',
    );

    expect(series).toEqual([
      {
        at: '2026-03-07T10:00:00.000Z',
        posts: 2,
        views: 100,
      },
    ]);
  });

  it('keeps view chart points in the publication bucket when views are observed later', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildAverageViewsSeriesFromPostMetrics: (
        bucketStarts: Date[],
        postViewMetrics: Array<{
          post: {
            id: string;
            publishedAt: Date;
            latestViews: number;
          };
          viewsDelta: number;
          viewDeltas: Array<{
            capturedAt: Date;
            viewsDelta: number;
          }>;
        }>,
        bucket: 'hour' | 'day',
      ) => Array<{ at: string; posts: number; views: number }>;
    };

    const series = statsHelpers.buildAverageViewsSeriesFromPostMetrics(
      [new Date('2026-06-11T21:00:00.000Z'), new Date('2026-06-17T21:00:00.000Z')],
      [
        {
          post: {
            id: 'post-1',
            publishedAt: new Date('2026-06-12T09:20:00.000Z'),
            latestViews: 900,
          },
          viewsDelta: 900,
          viewDeltas: [
            {
              capturedAt: new Date('2026-06-18T11:00:00.000Z'),
              viewsDelta: 900,
            },
          ],
        },
      ],
      'day',
    );

    expect(series).toEqual([
      {
        at: '2026-06-11T21:00:00.000Z',
        posts: 1,
        views: 900,
      },
      {
        at: '2026-06-17T21:00:00.000Z',
        posts: 0,
        views: 0,
      },
    ]);
  });

  it('marks empty hourly views buckets as gaps instead of real zero-view posts', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildAverageViewsSeriesFromPostMetrics: (
        bucketStarts: Date[],
        postViewMetrics: Array<{
          post: {
            id: string;
            publishedAt: Date;
            latestViews: number;
          };
          viewsDelta: number;
          viewDeltas: Array<{
            capturedAt: Date;
            viewsDelta: number;
          }>;
        }>,
        bucket: 'hour' | 'day',
      ) => Array<{ at: string; posts: number; views: number }>;
    };

    const series = statsHelpers.buildAverageViewsSeriesFromPostMetrics(
      [
        new Date('2026-06-19T10:00:00.000Z'),
        new Date('2026-06-19T11:00:00.000Z'),
        new Date('2026-06-19T12:00:00.000Z'),
      ],
      [
        {
          post: {
            id: 'post-1',
            publishedAt: new Date('2026-06-19T10:10:00.000Z'),
            latestViews: 500,
          },
          viewsDelta: 500,
          viewDeltas: [],
        },
        {
          post: {
            id: 'post-2',
            publishedAt: new Date('2026-06-19T12:20:00.000Z'),
            latestViews: 650,
          },
          viewsDelta: 650,
          viewDeltas: [],
        },
      ],
      'hour',
    );

    expect(series).toEqual([
      {
        at: '2026-06-19T10:00:00.000Z',
        posts: 1,
        views: 500,
      },
      {
        at: '2026-06-19T11:00:00.000Z',
        posts: 0,
        views: 0,
      },
      {
        at: '2026-06-19T12:00:00.000Z',
        posts: 1,
        views: 650,
      },
    ]);
  });

  it('uses membership flow as the visible daily growth when rows exist', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildChannelStatsDailySummary: (
        audienceSnapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
        currentParticipants: number | null,
        now: Date,
        membershipRows?: Array<{
          bucket_start: Date | string;
          joined_users: unknown;
          left_users: unknown;
        }>,
        membershipCoverageFrom?: Date | null,
      ) => Array<{
        date: string;
        subscribers: number | null;
        delta: number | null;
        joined?: number | null;
        left?: number | null;
      }>;
    };

    const daily = statsHelpers.buildChannelStatsDailySummary(
      [
        {
          capturedAt: new Date('2026-03-05T10:00:00.000Z'),
          participantsCount: 100,
        },
        {
          capturedAt: new Date('2026-03-06T10:00:00.000Z'),
          participantsCount: 101,
        },
      ],
      104,
      new Date('2026-03-07T12:00:00.000Z'),
      [
        {
          bucket_start: new Date('2026-03-06T10:00:00.000Z'),
          joined_users: '4',
          left_users: '2',
        },
        {
          bucket_start: new Date('2026-03-07T10:00:00.000Z'),
          joined_users: '3',
          left_users: '1',
        },
      ],
      new Date('2026-02-20T00:00:00.000Z'),
    );

    expect(daily.find((row) => row.date === '2026-03-06')).toEqual({
      date: '2026-03-06',
      subscribers: 102,
      delta: 2,
      joined: 4,
      left: 2,
      source: 'flow',
      confidence: 'medium',
    });
    expect(daily.at(-1)).toEqual({
      date: '2026-03-07',
      subscribers: 104,
      delta: 2,
      joined: 3,
      left: 1,
      source: 'flow',
      confidence: 'medium',
    });
  });

  it('stops carrying participant counts after the audience freshness cutoff', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildParticipantSeries: (
        bucketStarts: Date[],
        bucket: 'hour' | 'day',
        initialParticipantsCount: number | null,
        snapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
        options?: { carryForwardUntil?: Date | null },
      ) => Array<{ at: string; participantsCount: number | null }>;
    };

    const series = statsHelpers.buildParticipantSeries(
      [
        new Date('2026-03-07T11:00:00.000Z'),
        new Date('2026-03-07T12:00:00.000Z'),
        new Date('2026-03-07T14:00:00.000Z'),
      ],
      'hour',
      null,
      [
        {
          capturedAt: new Date('2026-03-07T11:19:00.000Z'),
          participantsCount: 4100,
        },
      ],
      { carryForwardUntil: new Date('2026-03-07T13:19:00.000Z') },
    );

    expect(series).toEqual([
      {
        at: '2026-03-07T11:00:00.000Z',
        participantsCount: 4100,
        source: 'snapshot',
        confidence: 'high',
      },
      {
        at: '2026-03-07T12:00:00.000Z',
        participantsCount: 4100,
        source: 'snapshot',
        confidence: 'low',
      },
      {
        at: '2026-03-07T14:00:00.000Z',
        participantsCount: null,
        source: 'unavailable',
        confidence: 'low',
      },
    ]);
  });

  it('keeps snapshot daily growth when membership flow coverage is incomplete', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildChannelStatsDailySummary: (
        audienceSnapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
        currentParticipants: number | null,
        now: Date,
        membershipRows?: Array<{
          bucket_start: Date | string;
          joined_users: unknown;
          left_users: unknown;
        }>,
        membershipCoverageFrom?: Date | null,
      ) => Array<{
        date: string;
        subscribers: number | null;
        delta: number | null;
        joined?: number | null;
        left?: number | null;
      }>;
    };

    const daily = statsHelpers.buildChannelStatsDailySummary(
      [
        {
          capturedAt: new Date('2026-03-05T10:00:00.000Z'),
          participantsCount: 100,
        },
        {
          capturedAt: new Date('2026-03-06T10:00:00.000Z'),
          participantsCount: 101,
        },
      ],
      104,
      new Date('2026-03-07T12:00:00.000Z'),
      [
        {
          bucket_start: new Date('2026-03-06T10:00:00.000Z'),
          joined_users: '150',
          left_users: '0',
        },
      ],
      null,
    );

    expect(daily.find((row) => row.date === '2026-03-06')).toEqual({
      date: '2026-03-06',
      subscribers: 101,
      delta: 1,
      joined: 150,
      left: 0,
      source: 'snapshot',
      confidence: 'high',
    });
  });

  it('does not expose carried snapshot totals as exact daily audience history', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildChannelStatsDailySummary: (
        audienceSnapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
        currentParticipants: number | null,
        now: Date,
        membershipRows?: Array<{
          bucket_start: Date | string;
          joined_users: unknown;
          left_users: unknown;
        }>,
        membershipCoverageFrom?: Date | null,
      ) => Array<{
        date: string;
        subscribers: number | null;
        delta: number | null;
        joined?: number | null;
        left?: number | null;
        source?: string;
        confidence?: string;
      }>;
    };

    const daily = statsHelpers.buildChannelStatsDailySummary(
      [
        {
          capturedAt: new Date('2026-06-22T12:59:16.557Z'),
          participantsCount: 129,
        },
        {
          capturedAt: new Date('2026-07-02T08:26:26.411Z'),
          participantsCount: 274,
        },
        {
          capturedAt: new Date('2026-07-05T18:32:49.779Z'),
          participantsCount: 477,
        },
      ],
      477,
      new Date('2026-07-05T18:40:00.000Z'),
      [
        {
          bucket_start: new Date('2026-07-01T21:00:00.000Z'),
          joined_users: '96',
          left_users: '0',
        },
        {
          bucket_start: new Date('2026-07-02T21:00:00.000Z'),
          joined_users: '44',
          left_users: '5',
        },
        {
          bucket_start: new Date('2026-07-03T21:00:00.000Z'),
          joined_users: '71',
          left_users: '3',
        },
        {
          bucket_start: new Date('2026-07-04T21:00:00.000Z'),
          joined_users: '43',
          left_users: '0',
        },
      ],
      null,
    );

    expect(daily.find((row) => row.date === '2026-07-02')).toEqual({
      date: '2026-07-02',
      subscribers: 274,
      delta: null,
      joined: 96,
      left: 0,
      source: 'snapshot',
      confidence: 'high',
    });
    expect(daily.find((row) => row.date === '2026-07-03')).toEqual({
      date: '2026-07-03',
      subscribers: null,
      delta: null,
      joined: 44,
      left: 5,
      source: 'unavailable',
      confidence: 'low',
    });
    expect(daily.find((row) => row.date === '2026-07-04')).toEqual({
      date: '2026-07-04',
      subscribers: null,
      delta: null,
      joined: 71,
      left: 3,
      source: 'unavailable',
      confidence: 'low',
    });
    expect(daily.find((row) => row.date === '2026-07-05')).toEqual({
      date: '2026-07-05',
      subscribers: 477,
      delta: null,
      joined: 43,
      left: 0,
      source: 'snapshot',
      confidence: 'high',
    });
  });

  it('does not turn an unbaselined membership import burst into audience growth history', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildChannelStatsDailySummary: (
        audienceSnapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
        currentParticipants: number | null,
        now: Date,
        membershipRows?: Array<{
          bucket_start: Date | string;
          joined_users: unknown;
          left_users: unknown;
        }>,
        membershipCoverageFrom?: Date | null,
      ) => Array<{
        date: string;
        subscribers: number | null;
        delta: number | null;
        joined?: number | null;
        left?: number | null;
      }>;
    };

    const daily = statsHelpers.buildChannelStatsDailySummary(
      [
        {
          capturedAt: new Date('2026-03-07T12:00:00.000Z'),
          participantsCount: 250,
        },
      ],
      250,
      new Date('2026-03-07T12:00:00.000Z'),
      [
        {
          bucket_start: new Date('2026-03-07T00:00:00.000Z'),
          joined_users: '250',
          left_users: '0',
        },
      ],
      new Date('2026-02-20T00:00:00.000Z'),
    );

    expect(daily.find((row) => row.date === '2026-03-06')).toEqual({
      date: '2026-03-06',
      subscribers: null,
      delta: null,
      joined: null,
      left: null,
      source: 'unavailable',
      confidence: 'low',
    });
    expect(daily.at(-1)).toEqual({
      date: '2026-03-07',
      subscribers: 250,
      delta: null,
      joined: 250,
      left: 0,
      source: 'snapshot',
      confidence: 'high',
    });
  });

  it('keeps snapshot daily growth when membership flow rows are unavailable', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const statsHelpers = service as unknown as {
      buildChannelStatsDailySummary: (
        audienceSnapshots: Array<{ capturedAt: Date; participantsCount: number | null }>,
        currentParticipants: number | null,
        now: Date,
        membershipRows?: Array<{
          bucket_start: Date | string;
          joined_users: unknown;
          left_users: unknown;
        }>,
        membershipCoverageFrom?: Date | null,
      ) => Array<{
        date: string;
        subscribers: number | null;
        delta: number | null;
        joined?: number | null;
        left?: number | null;
      }>;
    };

    const daily = statsHelpers.buildChannelStatsDailySummary(
      [
        {
          capturedAt: new Date('2026-03-05T10:00:00.000Z'),
          participantsCount: 100,
        },
        {
          capturedAt: new Date('2026-03-06T10:00:00.000Z'),
          participantsCount: 101,
        },
      ],
      104,
      new Date('2026-03-07T12:00:00.000Z'),
      [],
      null,
    );

    expect(daily.find((row) => row.date === '2026-03-06')).toEqual({
      date: '2026-03-06',
      subscribers: 101,
      delta: 1,
      joined: null,
      left: null,
      source: 'snapshot',
      confidence: 'high',
    });
    expect(daily.at(-1)).toEqual({
      date: '2026-03-07',
      subscribers: 104,
      delta: 3,
      joined: null,
      left: null,
      source: 'snapshot',
      confidence: 'high',
    });
  });

  it('returns stored channel stats without reading settings or waiting for post previews', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          posts_with_buttons: '2',
          comments: '4',
          suggestions: '3',
          comment_authors: '2',
          suggestion_authors: '2',
          suggestions_delivered: '2',
          suggestions_failed: '1',
          last_bot_activity_at: new Date('2026-03-07T11:25:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-03-02T21:00:00.000Z'),
          joined_users: createDecimalLike(1),
          left_users: createDecimalLike(0),
        },
        {
          bucket_start: new Date('2026-03-03T21:00:00.000Z'),
          joined_users: createDecimalLike(1),
          left_users: createDecimalLike(0),
        },
        {
          bucket_start: new Date('2026-03-04T21:00:00.000Z'),
          joined_users: createDecimalLike(0),
          left_users: createDecimalLike(1),
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-03-02T21:00:00.000Z'),
          posts: createDecimalLike(1),
          views_delta: createDecimalLike(150),
          reactions: createDecimalLike(5),
        },
        {
          bucket_start: new Date('2026-03-05T21:00:00.000Z'),
          posts: createDecimalLike(1),
          views_delta: createDecimalLike(260),
          reactions: createDecimalLike(7),
        },
      ])
      .mockResolvedValueOnce([
        {
          channel_post_id: 'post-2',
          published_at: new Date('2026-03-06T14:00:00.000Z'),
          captured_at: new Date('2026-03-07T11:00:00.000Z'),
          snapshot_id: 'snap-2',
          views: '260',
          reactions_total: '7',
        },
        {
          channel_post_id: 'post-3',
          published_at: new Date('2026-03-06T10:00:00.000Z'),
          captured_at: new Date('2026-03-06T11:00:00.000Z'),
          snapshot_id: 'snap-3',
          views: '140',
          reactions_total: '2',
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-03-05T10:00:00.000Z'),
          joined_users: createDecimalLike(1),
          left_users: createDecimalLike(0),
        },
        {
          bucket_start: new Date('2026-03-07T10:00:00.000Z'),
          joined_users: createDecimalLike(1),
          left_users: createDecimalLike(1),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'wh-ch-3',
          created_at: new Date('2026-03-07T11:40:00.000Z'),
          event_type: 'user_added',
          user_id: 'user-10',
          sender_name: 'Андрей',
        },
        {
          id: 'wh-ch-2',
          created_at: new Date('2026-03-07T10:15:00.000Z'),
          event_type: 'user_removed',
          user_id: 'user-11',
          sender_name: 'Елена',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.channelAudienceSnapshot.findFirst
      .mockResolvedValueOnce({
        chatId: 'channel-1',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
        capturedAt: new Date('2026-03-07T11:56:00.000Z'),
      })
      .mockResolvedValueOnce({
        capturedAt: new Date('2026-03-01T08:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        participantsCount: 1210,
      })
      .mockResolvedValueOnce({
        participantsCount: 1180,
      });
    prisma.channelAudienceSnapshot.findMany
      .mockResolvedValueOnce([
        {
          capturedAt: new Date('2026-03-03T10:00:00.000Z'),
          participantsCount: 1220,
        },
        {
          capturedAt: new Date('2026-03-06T10:00:00.000Z'),
          participantsCount: 1240,
        },
      ])
      .mockResolvedValueOnce([
        {
          capturedAt: new Date('2026-02-19T10:00:00.000Z'),
          participantsCount: 1200,
        },
        {
          capturedAt: new Date('2026-02-28T10:00:00.000Z'),
          participantsCount: 1215,
        },
        {
          capturedAt: new Date('2026-03-06T10:00:00.000Z'),
          participantsCount: 1230,
        },
      ])
      .mockResolvedValueOnce([
        {
          capturedAt: new Date('2026-02-24T10:00:00.000Z'),
          participantsCount: 1190,
        },
        {
          capturedAt: new Date('2026-02-27T10:00:00.000Z'),
          participantsCount: 1210,
        },
      ]);
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      id: 'sync-1',
      chatId: 'channel-1',
      viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
      membershipCoverageFrom: new Date('2026-02-28T08:00:00.000Z'),
      lastAudienceSyncAt: new Date('2026-03-07T11:56:00.000Z'),
      lastViewsSyncAt: new Date('2026-03-07T11:56:00.000Z'),
      lastOpportunisticSyncAt: null,
      createdAt: new Date('2026-02-28T08:00:00.000Z'),
      updatedAt: new Date('2026-03-07T11:56:00.000Z'),
    });
    const channelPosts = [
      {
        id: 'post-1',
        messageId: 'mid-1',
        publishedAt: new Date('2026-03-03T07:00:00.000Z'),
        url: 'https://max.ru/news/post-1',
        previewUrl: null,
        latestViews: 150,
        latestReactionsTotal: 5,
        latestReactions: [
          { emoji: '🔥', count: 3 },
          { emoji: '👍', count: 2 },
        ],
        latestSnapshotAt: new Date('2026-03-07T11:00:00.000Z'),
      },
      {
        id: 'post-2',
        messageId: 'mid-2',
        publishedAt: new Date('2026-03-06T14:00:00.000Z'),
        url: 'https://max.ru/news/post-2',
        previewUrl: 'https://cdn.max.ru/news/post-2.jpg',
        latestViews: 260,
        latestReactionsTotal: 7,
        latestReactions: [
          { emoji: '🔥', count: 4 },
          { emoji: '❤️', count: 3 },
        ],
        latestSnapshotAt: new Date('2026-03-07T11:00:00.000Z'),
      },
    ];
    const summaryPosts = [
      channelPosts[1]!,
      {
        id: 'post-3',
        messageId: 'mid-3',
        publishedAt: new Date('2026-03-06T10:00:00.000Z'),
        url: 'https://max.ru/news/post-3',
        previewUrl: null,
        latestViews: 140,
        latestReactionsTotal: 2,
        latestReactions: [{ emoji: '👍', count: 2 }],
        latestSnapshotAt: new Date('2026-03-06T11:00:00.000Z'),
      },
    ];
    prisma.channelPost.findMany
      .mockResolvedValueOnce(channelPosts)
      .mockResolvedValueOnce(summaryPosts)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.channelPostViewSnapshot.findMany.mockResolvedValue([
      {
        channelPostId: 'post-1',
        views: 100,
        reactionsTotal: 3,
        capturedAt: new Date('2026-03-03T08:00:00.000Z'),
      },
      {
        channelPostId: 'post-1',
        views: 150,
        reactionsTotal: 5,
        capturedAt: new Date('2026-03-07T11:00:00.000Z'),
      },
      {
        channelPostId: 'post-2',
        views: 260,
        reactionsTotal: 7,
        capturedAt: new Date('2026-03-07T11:00:00.000Z'),
      },
    ]);
    prisma.channelPost.findFirst.mockResolvedValue({ id: 'post-1' });

    const stalledSnapshot =
      createDeferred<Awaited<ReturnType<MaxClientService['getMessageSnapshot']>>>();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn(),
      getMessageSnapshot: jest
        .fn<
          ReturnType<MaxClientService['getMessageSnapshot']>,
          Parameters<MaxClientService['getMessageSnapshot']>
        >()
        .mockReturnValue(stalledSnapshot.promise),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-10',
            {
              userId: 'user-10',
              displayName: 'Андрей',
              username: 'andrey',
              avatarUrl: 'https://cdn.max.ru/u/10/avatar-full.jpg',
            },
          ],
          [
            'user-11',
            {
              userId: 'user-11',
              displayName: 'Елена',
              username: null,
              avatarUrl: 'https://cdn.max.ru/u/11/avatar-full.jpg',
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const channelStatsCollector = {
      syncChannelIfStale: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      channelStatsCollector as never,
    );

    const result = await service.getChannelStats(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d' },
    );

    expect(maxClient.getMessageSnapshot).not.toHaveBeenCalled();

    expect(result.channel).toEqual({
      id: 'channel-1',
      title: 'Новости MAX',
      participantsCount: 1240,
      status: 'active',
      isPublic: true,
      link: 'https://max.ru/news',
      lastEventAt: '2026-03-07T11:55:00.000Z',
      avatarUrl: null,
    });
    expect(result.period).toEqual({
      range: '7d',
      from: '2026-02-28T12:00:00.000Z',
      to: '2026-03-07T12:00:00.000Z',
      bucket: 'day',
    });
    expect(result.official.audience).toEqual({
      joined: 2,
      left: 1,
      net: 1,
    });
    expect(result.official.content).toEqual({
      posts: 2,
      views: 410,
      reactions: 12,
      topReactions: [
        { emoji: '🔥', count: 7 },
        { emoji: '❤️', count: 3 },
        { emoji: '👍', count: 2 },
      ],
      topPosts: [
        {
          messageId: 'mid-2',
          publishedAt: '2026-03-06T14:00:00.000Z',
          url: 'https://max.ru/news/post-2',
          previewUrl: 'https://cdn.max.ru/news/post-2.jpg',
          viewsDelta: 260,
        },
        {
          messageId: 'mid-1',
          publishedAt: '2026-03-03T07:00:00.000Z',
          url: 'https://max.ru/news/post-1',
          previewUrl: null,
          viewsDelta: 150,
        },
      ],
      lastPublishedAt: '2026-03-06T14:00:00.000Z',
    });
    expect(result.summary).toEqual({
      subscribers: {
        current: 1240,
        todayDelta: 0,
        todayJoined: 1,
        todayLeft: 1,
        weekDelta: 1,
        sixteenDaysDelta: null,
      },
      views: {
        perPost: 260,
        last24h: 260,
        last48h: 200,
        er24: 2.69,
      },
      reach: expect.objectContaining({
        coverage24h: 'unavailable',
        coverage48h: 'unavailable',
        method: 'post-age-cohort',
      }),
      daily: expect.any(Array),
    });
    expect(result.summary.daily.at(-1)).toEqual({
      date: '2026-03-07',
      subscribers: 1240,
      delta: 0,
      joined: 1,
      left: 1,
      source: 'flow',
      confidence: 'medium',
    });
    expect(result.secondary).toEqual({
      postsWithButtons: 2,
      comments: 4,
      suggestions: 3,
      commentAuthors: 2,
      suggestionAuthors: 2,
      suggestionsDelivered: 2,
      suggestionsFailed: 1,
      lastBotActivityAt: '2026-03-07T11:25:00.000Z',
    });
    expect(result.meta).toEqual({
      maxSnapshotAvailable: true,
      viewsAvailable: true,
      churnAvailable: true,
      officialCoverageFrom: '2026-02-28T08:00:00.000Z',
      refreshQueued: false,
    });
    expect(result.activityFeed).toEqual({
      items: [
        {
          id: 'wh-ch-3',
          type: 'joined',
          userId: 'user-10',
          userDisplayName: 'Андрей',
          avatarUrl: 'https://cdn.max.ru/u/10/avatar-full.jpg',
          profileUrl: 'https://max.ru/andrey',
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-07T11:40:00.000Z',
        },
        {
          id: 'wh-ch-2',
          type: 'left',
          userId: 'user-11',
          userDisplayName: 'Елена',
          avatarUrl: 'https://cdn.max.ru/u/11/avatar-full.jpg',
          profileUrl: null,
          profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
          createdAt: '2026-03-07T10:15:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(result.official.series.participants).toHaveLength(8);
    expect(result.official.series.membership).toHaveLength(8);
    expect(result.official.series.views).toHaveLength(8);
    expect(result.comparison.period).toEqual({
      from: '2026-02-21T12:00:00.000Z',
      to: '2026-02-28T11:59:59.999Z',
    });
    expect(result.comparison.series?.participants).toHaveLength(8);
    expect(result.comparison.series?.membership).toHaveLength(8);
    expect(result.comparison.series?.views).toHaveLength(8);
    expect(result.comparison.series?.participants[0]).toEqual({
      at: '2026-02-20T21:00:00.000Z',
      participantsCount: 1180,
      source: 'snapshot',
      confidence: 'low',
    });
    expect(channelStatsCollector.syncChannelIfStale).not.toHaveBeenCalled();

    const statsSqlText = extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(statsSqlText).toContain('COUNT(DISTINCT CASE');
    expect(statsSqlText).toContain("payload->>'threadId'");
    expect(statsSqlText).toContain("payload->>'delivered' = 'true'");
    expect(statsSqlText).toContain("payload->>'delivered' = 'false'");
    const membershipSqlText = extractSqlText(prisma.$queryRaw.mock.calls[1]);
    expect(membershipSqlText).toContain('channel_stats_bucket_rollups');
    expect(membershipSqlText).toContain('chat_membership_activity_feed_items');
    expect(membershipSqlText).toContain("bucket_start + INTERVAL '3 hours'");
    expect(membershipSqlText).toContain('ORDER BY bucket_start ASC');
    const contentSqlText = extractSqlText(prisma.$queryRaw.mock.calls[2]);
    expect(contentSqlText).toContain('channel_stats_bucket_rollups');
    expect(contentSqlText).toContain("bucket_start + INTERVAL '3 hours'");
    expect(contentSqlText).not.toContain('channel_post_view_snapshots');
    expect(contentSqlText).not.toContain('ORDER BY first_snapshot.captured_at ASC');
  });

  it('returns cached channel stats immediately and refreshes stale MAX data in background', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          posts_with_buttons: '0',
          comments: '0',
          suggestions: '0',
          comment_authors: '0',
          suggestion_authors: '0',
          suggestions_delivered: '0',
          suggestions_failed: '0',
          last_bot_activity_at: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.channelAudienceSnapshot.findFirst
      .mockResolvedValueOnce({
        chatId: 'channel-1',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: new Date('2026-03-07T07:55:00.000Z'),
        capturedAt: new Date('2026-03-07T07:56:00.000Z'),
      })
      .mockResolvedValueOnce({
        capturedAt: new Date('2026-03-01T08:00:00.000Z'),
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        participantsCount: 1240,
      });
    prisma.channelAudienceSnapshot.findMany.mockResolvedValue([]);
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      id: 'sync-1',
      chatId: 'channel-1',
      viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
      membershipCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
      lastAudienceSyncAt: new Date('2026-03-07T07:56:00.000Z'),
      lastViewsSyncAt: new Date('2026-03-07T07:56:00.000Z'),
      lastOpportunisticSyncAt: null,
      createdAt: new Date('2026-03-01T08:00:00.000Z'),
      updatedAt: new Date('2026-03-07T07:56:00.000Z'),
    });
    prisma.channelPost.findMany.mockResolvedValue([]);
    prisma.channelPost.findFirst.mockResolvedValue(null);

    const refreshDeferred = createDeferred<void>();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const channelStatsCollector = {
      syncChannelIfStale: jest.fn().mockReturnValue(refreshDeferred.promise),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      channelStatsCollector as never,
    );

    let resolvedResult: Awaited<ReturnType<AdminService['getChannelStats']>> | null = null;
    const resultPromise = service
      .getChannelStats(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { range: '7d', includeActivityPreview: false },
      )
      .then((result) => {
        resolvedResult = result;
        return result;
      });
    const race = await Promise.race([
      resultPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    refreshDeferred.resolve(undefined);
    const result = resolvedResult ?? (await resultPromise);
    expect(race).toBe('resolved');
    expect(result.meta.refreshQueued).toBe(true);
    expect(result.channel.participantsCount).toBeNull();
    expect(result.summary.subscribers.current).toBeNull();
    expect(result.official.series.participants).toHaveLength(8);
    expect(
      result.official.series.participants.every((point) => point.participantsCount === null),
    ).toBe(true);
    expect(result.activityFeed).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(channelStatsCollector.syncChannelIfStale).toHaveBeenCalledWith('channel-1', {
      staleMs: 7200000,
      reason: 'stats_endpoint',
    });

    await flushAsyncTasks();
  });

  it('refreshes stale channel audience before building the stats response when it fits the response budget', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'channel-1',
        title: 'Авторынок',
        entityType: 'CHANNEL',
      });
      prisma.channelAudienceSnapshot.findFirst
        .mockResolvedValueOnce({
          chatId: 'channel-1',
          participantsCount: 4099,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/autorunok',
          lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
          capturedAt: new Date('2026-03-07T12:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          capturedAt: new Date('2026-03-01T08:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          participantsCount: 4008,
        });
      prisma.channelAudienceSnapshot.findMany.mockResolvedValue([
        {
          capturedAt: new Date('2026-03-07T12:00:00.000Z'),
          participantsCount: 4099,
        },
      ]);
      prisma.channelStatsSyncState.findUnique.mockResolvedValue({
        id: 'sync-1',
        chatId: 'channel-1',
        viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
        membershipCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        lastOpportunisticSyncAt: new Date('2026-03-07T12:00:00.000Z'),
        createdAt: new Date('2026-03-01T08:00:00.000Z'),
        updatedAt: new Date('2026-03-07T12:00:00.000Z'),
      });
      prisma.channelPost.findMany.mockResolvedValue([]);
      prisma.channelPost.findFirst.mockResolvedValue(null);

      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatSnapshot: jest.fn(),
      };
      const chatContextCache = {
        invalidate: jest.fn(),
      };
      const channelStatsCollector = {
        syncAudienceSnapshotIfStale: jest.fn().mockResolvedValue({
          audienceSynced: true,
          throttled: false,
          syncedAt: new Date('2026-03-07T12:00:00.000Z'),
        }),
        syncChannelIfStale: jest.fn().mockResolvedValue(undefined),
      };

      const service = new AdminService(
        prisma as never,
        maxClient as never,
        chatContextCache as never,
        createConfigMock() as never,
        channelStatsCollector as never,
      );

      const result = await service.getChannelStats(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { range: '7d', includeActivityPreview: false, mode: 'overview' },
      );

      expect(channelStatsCollector.syncAudienceSnapshotIfStale).toHaveBeenCalledWith('channel-1', {
        staleMs: 7200000,
        reason: 'stats_endpoint',
        markOpportunistic: true,
      });
      expect(
        channelStatsCollector.syncAudienceSnapshotIfStale.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.channelAudienceSnapshot.findFirst.mock.invocationCallOrder[0]);
      expect(result.channel.participantsCount).toBe(4099);
      expect(result.summary.subscribers.current).toBe(4099);
      expect(result.official.series.participants.at(-1)?.participantsCount).toBe(4099);
      expect(result.meta.refreshQueued).toBe(false);
      expect(channelStatsCollector.syncChannelIfStale).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('serves overview channel stats without unbounded post or snapshot scans', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-03-06T21:00:00.000Z'),
          joined_users: '5',
          left_users: '2',
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-03-06T21:00:00.000Z'),
          posts: '3',
          views_delta: '900',
          reactions: '30',
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-03-07T10:00:00.000Z'),
          posts: '2',
          views_delta: '640',
          reactions: '18',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.channelAudienceSnapshot.findFirst
      .mockResolvedValueOnce({
        chatId: 'channel-1',
        participantsCount: 1240,
        status: 'active',
        isPublic: true,
        link: 'https://max.ru/news',
        lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
        capturedAt: new Date('2026-03-07T11:56:00.000Z'),
      })
      .mockResolvedValueOnce({
        capturedAt: new Date('2026-03-01T08:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        participantsCount: 1237,
      });
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      id: 'sync-1',
      chatId: 'channel-1',
      viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
      membershipCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
      lastAudienceSyncAt: new Date('2026-03-07T11:56:00.000Z'),
      lastViewsSyncAt: new Date('2026-03-07T11:56:00.000Z'),
      lastOpportunisticSyncAt: null,
      createdAt: new Date('2026-03-01T08:00:00.000Z'),
      updatedAt: new Date('2026-03-07T11:56:00.000Z'),
    });
    prisma.channelPost.findFirst.mockResolvedValue({ id: 'post-1' });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatSnapshot: jest.fn(),
      } as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const result = await service.getChannelStats(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '7d', includeActivityPreview: false, mode: 'overview' },
    );

    expect(result.official.content).toMatchObject({
      posts: 3,
      views: 900,
      reactions: 30,
      topPosts: [],
      topReactions: [],
    });
    expect(result.comparison.series).toBeUndefined();
    expect(prisma.channelPost.findMany).toHaveBeenCalledTimes(2);
    for (const [query] of prisma.channelPost.findMany.mock.calls) {
      expect(query).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            chatId: 'channel-1',
            publishedAt: expect.objectContaining({
              gte: new Date('2026-02-05T12:00:00.000Z'),
            }),
          }),
          take: 30,
        }),
      );
    }
    const querySqlTexts = prisma.$queryRaw.mock.calls.map((call) => extractSqlText(call));
    expect(querySqlTexts.join('\n')).not.toContain('audit_logs');
    expect(querySqlTexts.join('\n')).not.toContain('channel_post_view_snapshots');
  });

  it.each([
    ['24h', '2026-03-06T12:00:00.000Z', 'hour'],
    ['30d', '2026-02-05T12:00:00.000Z', 'day'],
  ] as const)(
    'uses %s boundaries for official channel stats period',
    async (range, expectedFrom, expectedBucket) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'channel-1',
        title: 'Новости MAX',
        entityType: 'CHANNEL',
      });
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            posts_with_buttons: '0',
            comments: '0',
            suggestions: '0',
            comment_authors: '0',
            suggestion_authors: '0',
            suggestions_delivered: '0',
            suggestions_failed: '0',
            last_bot_activity_at: null,
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      prisma.channelAudienceSnapshot.findFirst
        .mockResolvedValueOnce({
          chatId: 'channel-1',
          participantsCount: 1240,
          status: 'active',
          isPublic: true,
          link: 'https://max.ru/news',
          lastEventAt: new Date('2026-03-07T11:55:00.000Z'),
          capturedAt: new Date('2026-03-07T11:56:00.000Z'),
        })
        .mockResolvedValueOnce({
          capturedAt: new Date('2026-03-01T08:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          participantsCount: 1240,
        });
      prisma.channelStatsSyncState.findUnique.mockResolvedValue({
        id: 'sync-1',
        chatId: 'channel-1',
        viewsCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
        membershipCoverageFrom: new Date('2026-03-01T08:00:00.000Z'),
        lastAudienceSyncAt: new Date('2026-03-07T11:56:00.000Z'),
        lastViewsSyncAt: new Date('2026-03-07T11:56:00.000Z'),
        lastOpportunisticSyncAt: null,
        createdAt: new Date('2026-03-01T08:00:00.000Z'),
        updatedAt: new Date('2026-03-07T11:56:00.000Z'),
      });

      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatSnapshot: jest.fn(),
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

      const result = await service.getChannelStats(
        'channel-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { range, includeActivityPreview: false },
      );

      expect(result.period.range).toBe(range);
      expect(result.period.from).toBe(expectedFrom);
      expect(result.period.to).toBe('2026-03-07T12:00:00.000Z');
      expect(result.period.bucket).toBe(expectedBucket);
      const querySqlTexts = prisma.$queryRaw.mock.calls.map((call) => extractSqlText(call));
      expect(
        querySqlTexts.some((sqlText) =>
          expectedBucket === 'day'
            ? sqlText.includes("INTERVAL '3 hours'")
            : sqlText.includes(`date_trunc('${expectedBucket}',`),
        ),
      ).toBe(true);
    },
  );

  it('returns partial official stats when cached MAX snapshot is missing and fallback request fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-07T12:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          posts_with_buttons: '1',
          comments: '0',
          suggestions: '1',
          comment_authors: '0',
          suggestion_authors: '1',
          suggestions_delivered: '0',
          suggestions_failed: '1',
          last_bot_activity_at: new Date('2026-03-07T09:30:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-03-07T09:00:00.000Z'),
          joined_users: '1',
          left_users: '0',
        },
      ])
      .mockResolvedValueOnce([
        {
          bucket_start: new Date('2026-03-07T09:00:00.000Z'),
          posts: '1',
          views_delta: '0',
          reactions: '0',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'wh-missing-1',
          created_at: new Date('2026-03-07T09:30:00.000Z'),
          event_type: 'user_added',
          user_id: 'user-42',
          sender_name: null,
        },
      ])
      .mockResolvedValueOnce([{ user_id: 'user-42', sender_name: 'Павел' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.channelAudienceSnapshot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.channelStatsSyncState.findUnique.mockResolvedValue({
      id: 'sync-1',
      chatId: 'channel-1',
      viewsCoverageFrom: new Date('2026-03-06T12:00:00.000Z'),
      membershipCoverageFrom: null,
      lastAudienceSyncAt: null,
      lastViewsSyncAt: new Date('2026-03-07T09:00:00.000Z'),
      lastOpportunisticSyncAt: null,
      createdAt: new Date('2026-03-06T12:00:00.000Z'),
      updatedAt: new Date('2026-03-07T09:00:00.000Z'),
    });
    prisma.channelPost.findMany.mockResolvedValue([
      {
        id: 'post-1',
        messageId: 'mid-1',
        publishedAt: new Date('2026-03-07T09:00:00.000Z'),
        url: null,
        previewUrl: null,
        latestViews: 44,
        latestReactionsTotal: 0,
        latestReactions: null,
        latestSnapshotAt: null,
      },
    ]);
    prisma.channelPost.findFirst.mockResolvedValue({ id: 'post-1' });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatSnapshot: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-42',
            {
              userId: 'user-42',
              displayName: 'Павел',
              username: 'pavel',
              avatarUrl: 'https://cdn.max.ru/u/42/avatar-full.jpg',
            },
          ],
        ]),
      ),
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

    const result = await service.getChannelStats(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { range: '24h' },
    );

    expect(result.channel).toEqual({
      id: 'channel-1',
      title: 'Новости MAX',
      participantsCount: null,
      status: null,
      isPublic: null,
      link: null,
      lastEventAt: null,
      avatarUrl: null,
    });
    expect(result.official.audience).toEqual({
      joined: 1,
      left: 0,
      net: 1,
    });
    expect(result.official.content).toEqual({
      posts: 1,
      views: 44,
      reactions: 0,
      topReactions: [],
      topPosts: [
        {
          messageId: 'mid-1',
          publishedAt: '2026-03-07T09:00:00.000Z',
          url: null,
          previewUrl: null,
          viewsDelta: 44,
        },
      ],
      lastPublishedAt: '2026-03-07T09:00:00.000Z',
    });
    expect(result.secondary.suggestionsFailed).toBe(1);
    expect(result.secondary.lastBotActivityAt).toBe('2026-03-07T09:30:00.000Z');
    expect(result.meta.maxSnapshotAvailable).toBe(false);
    expect(result.meta.churnAvailable).toBe(false);
    expect(result.activityFeed.items[0]).toEqual({
      id: 'wh-missing-1',
      type: 'joined',
      userId: 'user-42',
      userDisplayName: 'Павел',
      avatarUrl: 'https://cdn.max.ru/u/42/avatar-full.jpg',
      profileUrl: 'https://max.ru/pavel',
      profileHandoffUrl: expect.stringContaining('https://max.ru/777000_bot?start=pm2_'),
      createdAt: '2026-03-07T09:30:00.000Z',
    });
  });
});

describe('AdminService.getChatParticipantsPage', () => {
  it('returns a paginated chat roster with avatars, roles and profile handoff links', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
      });
      prisma.chatSettings.findUnique.mockResolvedValue({
        nightModeTimezone: 'Europe/Moscow',
      });
      prisma.moderationEvent.groupBy.mockResolvedValue([
        {
          userId: 'owner-1',
          _count: { _all: 3 },
        },
      ]);
      prisma.chatParticipantModerationImmunity.findMany.mockResolvedValue([
        {
          id: 'immunity-1',
          chatId: 'chat-1',
          userId: 'owner-1',
          expiresAt: new Date('2026-04-16T12:00:00.000Z'),
          dailyViolationLimit: 5,
          dailyViolationUsage: 2,
          usageDateKey: '2026-04-15',
          createdByUserId: 'admin-1',
          updatedByUserId: 'admin-1',
          createdAt: new Date('2026-04-15T10:00:00.000Z'),
          updatedAt: new Date('2026-04-15T10:00:00.000Z'),
        },
        {
          id: 'immunity-2',
          chatId: 'chat-1',
          userId: 'member-1',
          expiresAt: null,
          dailyViolationLimit: null,
          dailyViolationUsage: 0,
          usageDateKey: null,
          createdByUserId: 'admin-1',
          updatedByUserId: 'admin-1',
          createdAt: new Date('2026-04-15T10:00:00.000Z'),
          updatedAt: new Date('2026-04-15T10:00:00.000Z'),
        },
      ]);

      const chatContextCache = createChatContextCacheMock();
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatMembersPage: jest.fn().mockResolvedValue({
          items: [
            {
              userId: 'owner-1',
              displayName: 'Александра',
              username: 'alexandra',
              avatarUrl: 'https://cdn.max.ru/u/owner-1/avatar-full.jpg',
              profileUrl: null,
              role: 'owner',
              isBot: false,
            },
            {
              userId: 'member-1',
              displayName: 'Олег',
              username: 'oleg',
              avatarUrl: null,
              profileUrl: null,
              role: 'member',
              isBot: false,
            },
            {
              userId: 'id613002203036_bot',
              displayName: 'MAXIM',
              username: 'id613002203036_bot',
              avatarUrl: 'https://cdn.max.ru/u/maxim/avatar-full.jpg',
              profileUrl: 'https://max.ru/maxim-helper',
              role: 'admin',
              isBot: true,
            },
          ],
          nextMarker: 'page-2',
        }),
        getChatSnapshot: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Команда MAX',
          participantsCount: 1584,
          status: 'active',
          isPublic: false,
          link: null,
          lastEventAt: '2026-04-14T10:00:00.000Z',
          entityType: 'chat',
          avatarUrl: 'https://cdn.max.ru/chats/chat-1/avatar.jpg',
        }),
      };
      const maxBotLinkService = {
        getBotTokenSync: jest.fn((botId?: string | null) =>
          botId?.trim() ? `token:${botId.trim()}` : 'token:default',
        ),
        buildBotStartUrlSync: jest.fn((startPayload: string, botId?: string | null) => {
          const targetBotId = botId?.trim() || '777000_bot';
          return `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(
            startPayload,
          )}`;
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
      (service as any).resolveBackgroundReadBotAssignment = jest.fn().mockResolvedValue('bot-2');

      const result = await service.getChatParticipantsPage(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { limit: 3, range: '24h' },
      );

      expect(maxClient.getChatMembersPage).toHaveBeenCalledWith(
        'chat-1',
        {
          limit: 3,
          marker: null,
        },
        expect.objectContaining({
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          botId: 'bot-2',
        }),
      );
      expect(maxBotLinkService.getBotTokenSync).toHaveBeenCalledWith('bot-2');
      expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
        expect.any(String),
        'bot-2',
      );
      expect(prisma.moderationEvent.groupBy).toHaveBeenCalledWith({
        by: ['userId'],
        where: {
          chatId: 'chat-1',
          userId: { in: ['owner-1', 'member-1', 'id613002203036_bot'] },
          createdAt: {
            gte: expect.any(Date),
            lte: expect.any(Date),
          },
          action: {
            in: ['WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN'],
          },
        },
        _count: { _all: true },
      });
      expect(prisma.chatParticipantModerationImmunity.findMany).toHaveBeenCalledWith({
        where: {
          chatId: 'chat-1',
          userId: { in: ['owner-1', 'member-1', 'id613002203036_bot'] },
          OR: [{ expiresAt: { gt: expect.any(Date) } }, { expiresAt: null }],
        },
      });
      expect(result).toEqual({
        items: [
          {
            userId: 'owner-1',
            userDisplayName: 'Александра',
            username: 'alexandra',
            avatarUrl: 'https://cdn.max.ru/u/owner-1/avatar-full.jpg',
            profileUrl: 'https://max.ru/alexandra',
            profileHandoffUrl: expect.stringContaining('https://max.ru/bot-2?start='),
            lastMaxActivityAt: null,
            activityCheckedAt: null,
            violationCount: 3,
            immunity: {
              mode: 'limited',
              expiresAt: '2026-04-16T12:00:00.000Z',
              dailyViolationLimit: 5,
              usedViolatingMessagesToday: 2,
              remainingViolatingMessagesToday: 3,
            },
            role: 'owner',
            isBot: false,
          },
          {
            userId: 'member-1',
            userDisplayName: 'Олег',
            username: 'oleg',
            avatarUrl: null,
            profileUrl: 'https://max.ru/oleg',
            profileHandoffUrl: expect.stringContaining('https://max.ru/bot-2?start='),
            lastMaxActivityAt: null,
            activityCheckedAt: null,
            violationCount: 0,
            immunity: {
              mode: 'always',
              expiresAt: null,
              dailyViolationLimit: null,
              usedViolatingMessagesToday: 0,
              remainingViolatingMessagesToday: null,
            },
            role: 'member',
            isBot: false,
          },
          {
            userId: 'id613002203036_bot',
            userDisplayName: 'MAXIM',
            username: 'id613002203036_bot',
            avatarUrl: 'https://cdn.max.ru/u/maxim/avatar-full.jpg',
            profileUrl: 'https://max.ru/maxim-helper',
            profileHandoffUrl: expect.stringContaining('https://max.ru/bot-2?start='),
            lastMaxActivityAt: null,
            activityCheckedAt: null,
            violationCount: 0,
            immunity: null,
            role: 'admin',
            isBot: true,
          },
        ],
        totalCount: 1584,
        hasMore: true,
        nextCursor: 'page-2',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('searches participants across MAX roster pages', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });
    prisma.chatSettings.findUnique.mockResolvedValue({
      nightModeTimezone: 'Europe/Moscow',
    });
    prisma.moderationEvent.groupBy.mockResolvedValue([]);
    prisma.chatParticipantModerationImmunity.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMembersPage: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, query: { marker?: string | null; limit?: number }) => {
            if (query.marker === 'page-2') {
              return {
                items: [
                  {
                    userId: 'user-2',
                    displayName: 'Сергей Иванов',
                    username: 'ivanov',
                    avatarUrl: null,
                    profileUrl: null,
                    role: 'member',
                    isBot: false,
                  },
                ],
                nextMarker: null,
              };
            }

            return {
              items: [
                {
                  userId: 'user-1',
                  displayName: 'Мария Петрова',
                  username: 'petrova',
                  avatarUrl: null,
                  profileUrl: null,
                  role: 'member',
                  isBot: false,
                },
              ],
              nextMarker: 'page-2',
            };
          },
        ),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Команда MAX',
        participantsCount: 2,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: '2026-04-14T10:00:00.000Z',
        entityType: 'chat',
        avatarUrl: null,
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.getChatParticipantsPage(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { limit: 10, range: '7d', search: 'иванов' },
    );

    expect(maxClient.getChatMembersPage).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      {
        limit: 100,
        marker: null,
      },
      expect.objectContaining({
        trafficClass: 'interactive',
      }),
    );
    expect(maxClient.getChatMembersPage).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      {
        limit: 100,
        marker: 'page-2',
      },
      expect.objectContaining({
        trafficClass: 'interactive',
      }),
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        userId: 'user-2',
        userDisplayName: 'Сергей Иванов',
        username: 'ivanov',
      }),
    ]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('continues participant search from the same MAX page when a page has extra matches', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });
    prisma.moderationEvent.groupBy.mockResolvedValue([]);
    prisma.chatParticipantModerationImmunity.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMembersPage: jest.fn().mockResolvedValue({
        items: [
          {
            userId: 'user-1',
            displayName: 'Иван Первый',
            username: 'ivan-one',
            avatarUrl: null,
            profileUrl: null,
            role: 'member',
            isBot: false,
          },
          {
            userId: 'user-2',
            displayName: 'Иван Второй',
            username: 'ivan-two',
            avatarUrl: null,
            profileUrl: null,
            role: 'member',
            isBot: false,
          },
        ],
        nextMarker: null,
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Команда MAX',
        participantsCount: 2,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: '2026-04-14T10:00:00.000Z',
        entityType: 'chat',
        avatarUrl: null,
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const firstPage = await service.getChatParticipantsPage('chat-1', actor, {
      limit: 1,
      range: '7d',
      search: 'иван',
    });
    const secondPage = await service.getChatParticipantsPage('chat-1', actor, {
      limit: 1,
      range: '7d',
      search: 'иван',
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(firstPage.items).toEqual([
      expect.objectContaining({
        userId: 'user-1',
      }),
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.items).toEqual([
      expect.objectContaining({
        userId: 'user-2',
      }),
    ]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('returns partial participant search pages before scanning the whole MAX roster', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });
    prisma.moderationEvent.groupBy.mockResolvedValue([]);
    prisma.chatParticipantModerationImmunity.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMembersPage: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, query: { marker?: string | null; limit?: number }) => {
            const marker = query.marker ?? null;
            if (marker === 'page-4') {
              return {
                items: [
                  {
                    userId: 'user-target',
                    displayName: 'Целевой Участник',
                    username: 'target',
                    avatarUrl: null,
                    profileUrl: null,
                    role: 'member',
                    isBot: false,
                  },
                ],
                nextMarker: null,
              };
            }

            return {
              items: [
                {
                  userId: `user-${marker ?? 'page-1'}`,
                  displayName: 'Другой пользователь',
                  username: 'other',
                  avatarUrl: null,
                  profileUrl: null,
                  role: 'member',
                  isBot: false,
                },
              ],
              nextMarker:
                marker === 'page-3' ? 'page-4' : marker === 'page-2' ? 'page-3' : 'page-2',
            };
          },
        ),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Команда MAX',
        participantsCount: 4,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: '2026-04-14T10:00:00.000Z',
        entityType: 'chat',
        avatarUrl: null,
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const firstPage = await service.getChatParticipantsPage('chat-1', actor, {
      limit: 10,
      range: '7d',
      search: 'целевой',
    });
    const secondPage = await service.getChatParticipantsPage('chat-1', actor, {
      limit: 10,
      range: '7d',
      search: 'целевой',
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(maxClient.getChatMembersPage).toHaveBeenCalledTimes(4);
    expect(firstPage.items).toEqual([]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.items).toEqual([
      expect.objectContaining({
        userId: 'user-target',
      }),
    ]);
    expect(secondPage.hasMore).toBe(false);
  });

  it('returns a structured 503 when participant search is throttled by MAX', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });
    prisma.chatSettings.findUnique.mockResolvedValue({
      nightModeTimezone: 'Europe/Moscow',
    });
    prisma.moderationEvent.groupBy.mockResolvedValue([]);
    prisma.chatParticipantModerationImmunity.findMany.mockResolvedValue([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMembersPage: jest
        .fn()
        .mockRejectedValue(
          new Error('MAX API per-chat rate limit exceeded for bot id613002203036_bot chat chat-1'),
        ),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Команда MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: '2026-04-14T10:00:00.000Z',
        entityType: 'chat',
        avatarUrl: null,
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const error = await service
      .getChatParticipantsPage(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { limit: 10, range: '7d', search: 'тимо' },
      )
      .catch((cause: unknown) => cause);

    expect(maxClient.getChatMembersPage).toHaveBeenCalledWith(
      'chat-1',
      {
        limit: 100,
        marker: null,
      },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'participant_search',
        timeoutMs: 700,
      }),
    );
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'MAX_CHAT_PARTICIPANTS_TEMPORARILY_UNAVAILABLE',
      retryAfterMs: 5_000,
    });
  });

  it('returns a structured 503 when participant search times out against MAX', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });
    prisma.chatSettings.findUnique.mockResolvedValue({
      nightModeTimezone: 'Europe/Moscow',
    });
    prisma.moderationEvent.groupBy.mockResolvedValue([]);
    prisma.chatParticipantModerationImmunity.findMany.mockResolvedValue([]);

    const timeoutError = Object.assign(new Error('timeout of 700ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMembersPage: jest.fn().mockRejectedValue(timeoutError),
      getChatSnapshot: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Команда MAX',
        participantsCount: 1200,
        status: 'active',
        isPublic: false,
        link: null,
        lastEventAt: '2026-04-14T10:00:00.000Z',
        entityType: 'chat',
        avatarUrl: null,
      }),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const accessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    (service as any).managedEntityAccessLossService = accessLossService;

    const error = await service
      .getChatParticipantsPage(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { limit: 10, range: '7d', search: 'тимо' },
      )
      .catch((cause: unknown) => cause);

    expect(maxClient.getChatMembersPage).toHaveBeenCalledWith(
      'chat-1',
      {
        limit: 100,
        marker: null,
      },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'participant_search',
        timeoutMs: 700,
      }),
    );
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'MAX_CHAT_PARTICIPANTS_TEMPORARILY_UNAVAILABLE',
      retryAfterMs: 5_000,
    });
    expect(accessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('upserts participant immunity and returns a compact summary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
      });
      prisma.chatSettings.findUnique.mockResolvedValue({
        nightModeTimezone: 'Europe/Moscow',
      });
      prisma.chatParticipantModerationImmunity.upsert.mockResolvedValue({
        id: 'immunity-1',
        chatId: 'chat-1',
        userId: 'user-1',
        expiresAt: new Date('2026-05-15T09:00:00.000Z'),
        dailyViolationLimit: 4,
        dailyViolationUsage: 0,
        usageDateKey: '2026-04-15',
        createdByUserId: 'admin-1',
        updatedByUserId: 'admin-1',
        createdAt: new Date('2026-04-15T09:00:00.000Z'),
        updatedAt: new Date('2026-04-15T09:00:00.000Z'),
      });

      const service = new AdminService(
        prisma as never,
        {
          getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );

      const result = await service.updateChatParticipantImmunity(
        'chat-1',
        'user-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          durationHours: 720,
          dailyViolationLimit: 4,
        },
      );

      expect(prisma.chatParticipantModerationImmunity.upsert).toHaveBeenCalledWith({
        where: {
          chatId_userId: {
            chatId: 'chat-1',
            userId: 'user-1',
          },
        },
        create: {
          chatId: 'chat-1',
          userId: 'user-1',
          expiresAt: new Date('2026-05-15T09:00:00.000Z'),
          dailyViolationLimit: 4,
          dailyViolationUsage: 0,
          usageDateKey: '2026-04-15',
          createdByUserId: 'admin-1',
          updatedByUserId: 'admin-1',
        },
        update: {
          expiresAt: new Date('2026-05-15T09:00:00.000Z'),
          dailyViolationLimit: 4,
          dailyViolationUsage: 0,
          usageDateKey: '2026-04-15',
          updatedByUserId: 'admin-1',
        },
      });
      expect(result).toEqual({
        immunity: {
          mode: 'limited',
          expiresAt: '2026-05-15T09:00:00.000Z',
          dailyViolationLimit: 4,
          usedViolatingMessagesToday: 0,
          remainingViolatingMessagesToday: 4,
        },
        message: 'Иммунитет обновлён.',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('upserts full participant protection without duration or daily limit', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
      });
      prisma.chatSettings.findUnique.mockResolvedValue({
        nightModeTimezone: 'Europe/Moscow',
      });
      prisma.chatParticipantModerationImmunity.upsert.mockResolvedValue({
        id: 'immunity-1',
        chatId: 'chat-1',
        userId: 'user-1',
        expiresAt: null,
        dailyViolationLimit: null,
        dailyViolationUsage: 0,
        usageDateKey: null,
        createdByUserId: 'admin-1',
        updatedByUserId: 'admin-1',
        createdAt: new Date('2026-04-15T09:00:00.000Z'),
        updatedAt: new Date('2026-04-15T09:00:00.000Z'),
      });

      const service = new AdminService(
        prisma as never,
        {
          getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
          getChatMemberAccess: jest.fn().mockResolvedValue({
            userId: 'user-1',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          }),
        } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );

      const result = await service.updateChatParticipantImmunity(
        'chat-1',
        'user-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          mode: 'always',
        },
      );

      expect(prisma.chatParticipantModerationImmunity.upsert).toHaveBeenCalledWith({
        where: {
          chatId_userId: {
            chatId: 'chat-1',
            userId: 'user-1',
          },
        },
        create: {
          chatId: 'chat-1',
          userId: 'user-1',
          expiresAt: null,
          dailyViolationLimit: null,
          dailyViolationUsage: 0,
          usageDateKey: null,
          createdByUserId: 'admin-1',
          updatedByUserId: 'admin-1',
        },
        update: {
          expiresAt: null,
          dailyViolationLimit: null,
          dailyViolationUsage: 0,
          usageDateKey: null,
          updatedByUserId: 'admin-1',
        },
      });
      expect(result).toEqual({
        immunity: {
          mode: 'always',
          expiresAt: null,
          dailyViolationLimit: null,
          usedViolatingMessagesToday: 0,
          remainingViolatingMessagesToday: null,
        },
        message: 'Иммунитет обновлён.',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('checks participant immunity target through the resolved chat bot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T09:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chat.findUnique.mockResolvedValue({
        id: 'chat-1',
        title: 'Команда MAX',
        entityType: 'CHAT',
      });
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'user-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        }),
      };
      const service = new AdminService(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      (service as any).resolveBackgroundReadBotAssignment = jest.fn().mockResolvedValue('bot-2');

      await service.updateChatParticipantImmunity(
        'chat-1',
        'user-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          durationHours: 24,
          dailyViolationLimit: 3,
        },
      );

      expect((service as any).resolveBackgroundReadBotAssignment).toHaveBeenCalledWith('chat-1');
      expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
        'chat-1',
        'user-1',
        expect.objectContaining({
          botId: 'bot-2',
        }),
      );
      expect(prisma.chatParticipantModerationImmunity.upsert).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects participant immunity shorter than one day', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    let thrown: unknown;
    try {
      await service.updateChatParticipantImmunity(
        'chat-1',
        'user-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          durationHours: 12,
          dailyViolationLimit: 4,
        },
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      durationHours: {
        _errors: ['Срок должен быть от 1 до 30 дней.'],
      },
    });
  });

  it('rejects full participant protection with duration or daily limit', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    let thrown: unknown;
    try {
      await service.updateChatParticipantImmunity(
        'chat-1',
        'user-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          mode: 'always',
          durationHours: 24,
          dailyViolationLimit: 4,
        },
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      durationHours: {
        _errors: ['Для режима «Всегда» срок не нужен.'],
      },
      dailyViolationLimit: {
        _errors: ['Для режима «Всегда» лимит не нужен.'],
      },
    });
    expect(prisma.chatParticipantModerationImmunity.upsert).not.toHaveBeenCalled();
  });

  it('rejects participant immunity for chat admins', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'user-2',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        }),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    let thrown: unknown;
    try {
      await service.updateChatParticipantImmunity(
        'chat-1',
        'user-2',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          enabled: true,
          durationHours: 24,
          dailyViolationLimit: 3,
        },
      );
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toBe(
      'Иммунитет можно выдать только обычному участнику.',
    );
    expect(prisma.chatParticipantModerationImmunity.upsert).not.toHaveBeenCalled();
  });

  it('removes participant immunity', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const service = new AdminService(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await service.updateChatParticipantImmunity(
      'chat-1',
      'user-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        enabled: false,
      },
    );

    expect(prisma.chatParticipantModerationImmunity.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'user-1',
      },
    });
    expect(result).toEqual({
      immunity: null,
      message: 'Иммунитет снят.',
    });
  });

  it('removes only explicitly unavailable ordinary members during cleanup', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMembersPage: jest.fn().mockResolvedValue({
        items: [
          {
            userId: 'ordinary-1',
            displayName: 'Обычный участник',
            username: null,
            avatarUrl: null,
            profileUrl: null,
            role: 'member',
            isBot: false,
            unavailableReason: null,
          },
          {
            userId: 'deleted-1',
            displayName: 'MAX account',
            username: null,
            avatarUrl: null,
            profileUrl: null,
            role: 'member',
            isBot: false,
            unavailableReason: 'deleted',
          },
          {
            userId: 'admin-2',
            displayName: 'Админ',
            username: null,
            avatarUrl: null,
            profileUrl: null,
            role: 'admin',
            isBot: false,
            unavailableReason: 'blocked',
          },
          {
            userId: 'helper-bot',
            displayName: 'Helper',
            username: 'helper_bot',
            avatarUrl: null,
            profileUrl: null,
            role: 'member',
            isBot: true,
            unavailableReason: 'blocked',
          },
        ],
        nextMarker: null,
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'deleted-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      kickMember: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'resolveParticipantCleanupBotAssignment').mockResolvedValue('bot-2');

    const result = await service.cleanupUnavailableChatParticipants(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {},
    );

    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      scannedCount: 4,
      matchedCount: 3,
      removedCount: 1,
      skippedCount: 2,
      failedCount: 0,
    });
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'deleted-1',
      expect.objectContaining({
        botId: 'bot-2',
        bypassCache: true,
      }),
    );
    expect(maxClient.kickMember).toHaveBeenCalledWith(
      'chat-1',
      'deleted-1',
      expect.objectContaining({
        immediate: true,
        botId: 'bot-2',
        sourceTag: 'participant_cleanup',
      }),
    );
    expect(maxClient.kickMember).toHaveBeenCalledTimes(1);
  });

  it('does not clean unavailable participants through a read/default bot when no cleanup bot is resolved', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
      primaryBotId: 'read-bot',
      botId: 'read-bot',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn(),
      getChatMembersPage: jest.fn(),
      getChatMemberAccess: jest.fn(),
      kickMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'resolveParticipantCleanupBotAssignment').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'resolveBackgroundReadBotAssignment').mockResolvedValue('read-bot');

    await expect(
      service.cleanupUnavailableChatParticipants(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {},
      ),
    ).rejects.toThrow('Не найден бот MAX с подтвержденным правом удалять участников');

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersPage).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });

  it('does not remove suspicious-looking participants without an explicit MAX account flag', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMembersPage: jest.fn().mockResolvedValue({
        items: [
          {
            userId: 'ordinary-1',
            displayName: 'Удалённый аккаунт',
            username: null,
            avatarUrl: null,
            profileUrl: null,
            role: 'member',
            isBot: false,
            unavailableReason: null,
          },
        ],
        nextMarker: null,
      }),
      getChatMemberAccess: jest.fn(),
      kickMember: jest.fn(),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'resolveParticipantCleanupBotAssignment').mockResolvedValue('bot-2');

    const result = await service.cleanupUnavailableChatParticipants(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {},
    );

    expect(result).toMatchObject({
      ok: true,
      scannedCount: 1,
      matchedCount: 0,
      removedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });
});

describe('AdminService.updateChannelSettings', () => {
  it('creates fresh channel settings with comments disabled by default', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'CHANNEL',
      channelSettings: {
        chatId: 'channel-1',
        ...channelSettingsSchema.parse({ commentsEnabled: false }),
      },
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
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

    const result = await service.getChannelSettings('channel-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.commentsEnabled).toBe(false);
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          channelSettings: {
            create: expect.objectContaining({
              commentsEnabled: false,
            }),
          },
        }),
        update: expect.objectContaining({
          channelSettings: {
            upsert: expect.objectContaining({
              create: expect.objectContaining({
                commentsEnabled: false,
              }),
            }),
          },
        }),
      }),
    );
  });

  it('does not probe manual-action bot access while reading channel settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      entityType: 'CHANNEL',
      primaryBotId: 'id613002203036_bot',
      botId: null,
      botMemberships: [],
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'CHANNEL',
      channelSettings: {
        chatId: 'channel-1',
        ...channelSettingsSchema.parse({ commentsEnabled: false }),
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    await service.getChannelSettings('channel-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('stores channel feature toggles used by publication buttons', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
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

    const result = await service.updateChannelSettings(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        revision: 0,
        commentsEnabled: true,
        postSuggestionsEnabled: true,
      },
    );

    expect(result).toMatchObject({ commentsEnabled: true, postSuggestionsEnabled: true });
    expect(prisma.chat.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'channel-1' },
        update: expect.objectContaining({
          entityType: 'CHANNEL',
        }),
      }),
    );
    expect(prisma.channelSettings.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'channel-1',
          commentsEnabled: true,
          postSuggestionsEnabled: true,
        }),
      }),
    );
  });

  it('invalidates channel context cache and refreshes bot access snapshots after channel settings update', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      entityType: 'CHANNEL',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = createChatContextCacheMock();
    const maxBotExecutionPlanner = {
      refreshChatBotCapabilitySnapshots: jest.fn().mockResolvedValue(undefined),
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
      undefined,
      undefined,
      maxBotExecutionPlanner as never,
    );

    await service.updateChannelSettings(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        revision: 0,
        commentsEnabled: true,
      },
    );

    expect(chatContextCache.invalidate).toHaveBeenCalledWith('channel-1');
    expect(maxBotExecutionPlanner.refreshChatBotCapabilitySnapshots).toHaveBeenCalledWith({
      chatId: 'channel-1',
      entityType: 'channel',
    });
  });
});

describe('AdminService allowlist normalization', () => {
  it('returns deduplicated canonical links', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValue([
      { domain: 'max.ru/news', removeAfterAt: null },
      { domain: 'https://max.ru/news', removeAfterAt: null },
      { domain: 'https://vk.com/studia_svetlana_armavir', removeAfterAt: null },
      { domain: 'https://vk.ru/studia_svetlana_armavir', removeAfterAt: null },
      { domain: 'example.org', removeAfterAt: null },
      { domain: 'https://EXAMPLE.org/', removeAfterAt: null },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
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

    const result = await service.getDomainAllowlist('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual([
      'https://example.org',
      'https://max.ru/news',
      'https://vk.com/studia_svetlana_armavir',
      'https://vk.ru/studia_svetlana_armavir',
    ]);
  });

  it('preserves distinct exact hosts when adding a link', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      { domain: 'https://vk.ru/studia_svetlana_armavir' },
      { domain: 'another.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://vk.com/studia_svetlana_armavir',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'https://vk.com/studia_svetlana_armavir',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'https://vk.com/studia_svetlana_armavir',
      },
      update: {
        removeAfterAt: null,
      },
    });
    expect(prisma.domainAllowlist.deleteMany).not.toHaveBeenCalled();
  });

  it('canonicalizes legacy link rows when adding a link', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      { domain: 'max.ru/news' },
      { domain: 'another.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://max.ru/news',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'https://max.ru/news',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'https://max.ru/news',
      },
      update: {
        removeAfterAt: null,
      },
    });
    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: {
          in: ['max.ru/news'],
        },
      },
    });
  });

  it('extracts exact link from pasted allowlist text', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain:
          'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU: MAX позволяет отправлять любые виды сообщений',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
      },
      update: {
        removeAfterAt: null,
      },
    });
  });

  it('stores domain-wide rules separately from exact links', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      { domain: 'domain:docs.max.ru' },
      { domain: 'https://max.ru/news' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://docs.max.ru/mini-apps/start',
        matchType: 'DOMAIN',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'domain:docs.max.ru',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'domain:docs.max.ru',
      },
      update: {
        removeAfterAt: null,
      },
    });
  });

  it('infers a host-only allowlist input as a domain rule when match type is omitted', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'docs.max.ru',
      },
    );

    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'domain:docs.max.ru',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'domain:docs.max.ru',
      },
      update: {
        removeAfterAt: null,
      },
    });
  });

  it('preserves a distinct exact allowlist URL containing encoded whitespace', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValueOnce([
      {
        domain:
          'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU%20MAX%20%D0%BF%D0%BE%D0%B7%D0%B2%D0%BE%D0%BB%D1%8F%D0%B5%D1%82%20%D0%BE%D1%82%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D1%8F%D1%82%D1%8C',
      },
      { domain: 'another.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.addDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        domain: 'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
      },
    );

    expect(prisma.domainAllowlist.deleteMany).not.toHaveBeenCalled();
    expect(prisma.domainAllowlist.upsert).toHaveBeenCalledWith({
      where: {
        chatId_domain: {
          chatId: 'chat-1',
          domain: 'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
        },
      },
      create: {
        chatId: 'chat-1',
        domain: 'https://max.ru/join/s-ue_EUH76fg0xkakyGtIbD4dfKhHyPStoqI3oK-ObU',
      },
      update: {
        removeAfterAt: null,
      },
    });
  });

  it('removes canonical and legacy rows by normalized link', async () => {
    const prisma = createPrismaMock();
    prisma.domainAllowlist.findMany.mockResolvedValue([
      { domain: 'https://max.ru/news?x=1' },
      { domain: 'max.ru/news?x=1' },
      { domain: 'example.org' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.removeDomain(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'https://max.ru/news?x=1',
    );

    expect(prisma.domainAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        domain: {
          in: ['https://max.ru/news?x=1', 'max.ru/news?x=1'],
        },
      },
    });
  });
});

describe('AdminService.sendBroadcast', () => {
  async function createRoutedManagedBroadcastRecoveryHarness() {
    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Ledger recovery message',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        mediaType: null,
        mediaPayload: null,
        mediaMimeType: '',
        mediaFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Worker interrupted',
        lockedAt: null,
        lockToken: null,
        publicationContentRevisionId: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          id: 'delivery-before-recreate',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENDING',
          lockedAt: new Date('2026-03-03T09:50:00.000Z'),
          lockToken: 'stale-lock',
        },
      ],
    });
    const ledgerFindMany = jest.fn().mockResolvedValue([]);
    (prisma as any).maxActionLedgerEntry = {
      findMany: ledgerFindMany,
      findUnique: jest.fn().mockResolvedValue(null),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      { getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']) } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).maxRoutedPublicationService = { publish: jest.fn() };
    const runtime = broadcastRuntime(service);
    const broadcast = await prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } });
    const actionKey = runtime.buildManagedBroadcastDeliveryActionKey(broadcast, 1, 'chat-1');

    return { actionKey, broadcast, deliveries, ledgerFindMany, prisma, runtime, service };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('falls back to cached allowlist when mass broadcast scan is throttled', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-2',
          title: 'Чат 2',
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(
        service as unknown as {
          listManagedEntitiesDetailed: (...args: unknown[]) => Promise<unknown>;
        },
        'listManagedEntitiesDetailed',
      )
      .mockRejectedValueOnce(new Error('MAX API global rate limit exceeded'));

    const result = await service.listChatsForMassBroadcast(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { discoveryMode: 'full' },
    );

    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('uses cached mass chat targets by default without remote full discovery', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-2',
          title: 'Чат 2',
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const discoverySpy = jest.spyOn(
      service as unknown as {
        discoverManagedEntities: (...args: unknown[]) => Promise<unknown>;
      },
      'discoverManagedEntities',
    );

    const result = await service.listChatsForMassBroadcast({
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(discoverySpy).not.toHaveBeenCalled();
    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('stops the explicit legacy mass chat scan when refresh cursor makes no progress', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-2',
          title: 'Чат 2',
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          entityType: 'CHAT',
        },
      },
    ]);

    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const discoverySpy = jest
      .spyOn(
        service as unknown as {
          discoverManagedEntities: (...args: unknown[]) => Promise<unknown>;
        },
        'discoverManagedEntities',
      )
      .mockResolvedValue({
        items: [],
        refresh: {
          complete: false,
          cursor: null,
          backoffActive: false,
          nextPollAfterMs: 1500,
        },
      });

    const result = await service.listChatsForMassBroadcast(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { discoveryMode: 'full' },
    );

    expect(discoverySpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
  });

  it('uses cached targets for foreground mass settings lookup and leaves full refresh to the queue', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      {
        chat: {
          id: 'chat-allowlist',
          title: 'Чат из allowlist',
          createdAt: new Date('2026-03-02T00:00:00.000Z'),
          entityType: 'CHAT',
          primaryBotId: '777000_bot',
        },
      },
    ]);
    const chatContextCache = createChatContextCacheMock();
    await chatContextCache.setManagedEntitiesPublishedSnapshot('admin-1', 'chat', {
      version: 'snapshot-v1',
      builtAt: '2026-04-20T10:00:00.000Z',
      lastSyncedAt: '2026-04-20T09:59:00.000Z',
      itemCount: 1,
      itemsHash: 'hash-v1',
      items: [
        createChatSummaryFixture({
          id: 'chat-snapshot',
          title: 'Чат из snapshot',
          createdAt: '2026-03-01T00:00:00.000Z',
          entityType: 'chat',
          primaryBotId: '777000_bot',
        }),
      ],
    });
    const refreshQueue = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue({}),
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      refreshQueue as never,
    );
    const discoverySpy = jest.spyOn(service as any, 'discoverManagedEntities');

    const result = await service.listChatsForMassBroadcast(
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { discoveryMode: 'cached-first' },
    );

    expect(discoverySpy).not.toHaveBeenCalled();
    expect(result.map((chat) => chat.id)).toEqual(['chat-snapshot', 'chat-allowlist']);
    await flushAsyncTasks();
    expect(refreshQueue.add).toHaveBeenCalledWith(
      'refresh-managed-entities',
      expect.objectContaining({
        userId: 'admin-1',
        entityType: 'chat',
      }),
      expect.any(Object),
    );
  });

  it('rejects a selected broadcast target before creating a schedule when access was revoked', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMembersAccess: createRevokedTargetAdminMemberFixture(),
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) =>
          chatId === 'chat-revoked' ? [] : ['admin-1'],
        ),
      sendMessageImmediateWithId: jest.fn(),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-revoked',
        title: 'Бывшая группа',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await expect(
      broadcastRuntime(service).sendBroadcast(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Новый автопостинг',
          textFormat: 'plain',
          targetMode: 'selected',
          targetChatIds: ['chat-revoked'],
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
          scheduleMode: 'calendar',
          scheduleTimezone: 'Europe/Moscow',
          scheduledSlots: ['2026-03-03T12:00:00.000Z'],
          sendAt: null,
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-revoked',
      expect.arrayContaining(['admin-1']),
      expect.objectContaining({ bypassCache: true }),
    );

    expect(prisma.managedBroadcast.create).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastIdempotencyRecord.create).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastDelivery.createMany).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('rejects a revoked calendar target before reading reservations', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatMembersAccess: createRevokedTargetAdminMemberFixture(),
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) =>
          chatId === 'chat-revoked' ? [] : ['admin-1'],
        ),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-revoked',
        title: 'Бывшая группа',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await expect(
      service.getManagedBroadcastCalendar(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        { targetChatIds: 'chat-revoked' },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-revoked',
      expect.arrayContaining(['admin-1']),
      expect.objectContaining({ bypassCache: true }),
    );

    expect(prisma.managedBroadcastCalendarReservation.findMany).not.toHaveBeenCalled();
  });

  it('fails a scheduled occurrence before delivery or media work when target access was revoked', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));
    const prisma = createPrismaMock();
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-revoked',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Отложенный пост',
        textFormat: 'plain',
        targetChatIds: ['chat-1', 'chat-revoked'],
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        status: 'ACTIVE',
      },
    });
    const maxClient = {
      getChatMembersAccess: createRevokedTargetAdminMemberFixture(),
      getChatAdminIds: jest
        .fn()
        .mockImplementation(async (chatId: string) =>
          chatId === 'chat-revoked' ? [] : ['admin-1'],
        ),
      sendMessageImmediateWithId: jest.fn(),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const runtime = broadcastRuntime(service);
    const loadMediaSpy = jest.spyOn(
      (runtime as any).mediaRuntime,
      'loadManagedBroadcastRequestMedia',
    );

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      'broadcast-revoked',
      'scheduled',
      new Date('2026-03-03T09:55:00.000Z'),
      ['ACTIVE'],
    );

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-revoked',
      expect.arrayContaining(['admin-1']),
      expect.objectContaining({ bypassCache: true }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.nextSendAt).toBeNull();
    expect(prisma.managedBroadcastDelivery.findMany).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastDelivery.createMany).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        broadcastId: 'broadcast-revoked',
        occurrenceIndex: 1,
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: expect.objectContaining({
        status: 'CANCELED',
        lastErrorCode: 'PUBLICATION_DELIVERY_ACCESS_LOST',
      }),
    });
    expect(loadMediaSpy).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('keeps retryable managed broadcasts moving even when active backlog is present', async () => {
    const prisma = createPrismaMock();
    let activeCalls = 0;
    let retryableCalls = 0;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({ where }: { where?: { status?: string | { in?: string[] } } }) => {
        if (where?.status === 'ACTIVE') {
          activeCalls += 1;
          return activeCalls === 1
            ? Array.from({ length: 10 }, (_, index) => ({
                id: `active-${index + 1}`,
              }))
            : [];
        }

        const statusFilter = where?.status as { in?: string[] } | undefined;
        if (Array.isArray(statusFilter?.in) && statusFilter.in.includes('FAILED')) {
          retryableCalls += 1;
          return retryableCalls === 1 ? [{ id: 'recovery-1' }] : [];
        }

        return [];
      },
    );

    const service = new AdminService(
      prisma as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const runtime = broadcastRuntime(service);
    const processSpy = jest
      .spyOn(runtime, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await service.processDueManagedBroadcasts('scheduled');

    expect(processSpy).toHaveBeenCalledTimes(10);
    expect(processSpy).toHaveBeenNthCalledWith(1, 'active-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
    expect(processSpy).toHaveBeenNthCalledWith(9, 'active-9', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
    expect(processSpy).toHaveBeenNthCalledWith(10, 'recovery-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
  });

  it('picks failed and partial managed broadcasts after the automatic retry backoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    let retryableCalls = 0;
    let retryableWhere: Record<string, unknown> | null = null;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({ where }: { where?: { status?: string | { in?: string[] } } }) => {
        if (where?.status === 'ACTIVE') {
          return [];
        }

        const statusFilter = where?.status as { in?: string[] } | undefined;
        if (Array.isArray(statusFilter?.in) && statusFilter.in.includes('FAILED')) {
          retryableCalls += 1;
          retryableWhere = where as Record<string, unknown>;
          return retryableCalls === 1 ? [{ id: 'broadcast-1' }] : [];
        }

        return [];
      },
    );

    const service = new AdminService(
      prisma as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const runtime = broadcastRuntime(service);
    const processSpy = jest
      .spyOn(runtime, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await service.processDueManagedBroadcasts('scheduled');

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('broadcast-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
    expect(retryableWhere).not.toHaveProperty('NOT');
  });

  it('picks timed out failed managed broadcasts for scheduled automatic retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    let retryableCalls = 0;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({ where }: { where?: { status?: string | { in?: string[] }; deliveries?: any } }) => {
        if (where?.status === 'ACTIVE') {
          return [];
        }

        const statusFilter = where?.status as { in?: string[] } | undefined;
        if (Array.isArray(statusFilter?.in) && statusFilter.in.includes('FAILED')) {
          retryableCalls += 1;
          const retryableFailures = where?.deliveries?.some?.OR ?? [];
          const includesTimeout = retryableFailures.some(
            (branch: any) => branch?.lastError?.contains === 'timeout',
          );
          return retryableCalls === 1 && includesTimeout ? [{ id: 'broadcast-1' }] : [];
        }

        return [];
      },
    );

    const service = new AdminService(
      prisma as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const runtime = broadcastRuntime(service);
    const processSpy = jest
      .spyOn(runtime, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await service.processDueManagedBroadcasts('scheduled');

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('broadcast-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
  });

  it('pauses legacy managed broadcasts before querying due work under runtime pressure', async () => {
    const prisma = createPrismaMock();
    prisma.managedBroadcast.findMany.mockResolvedValue([]);
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'pause',
        reason: 'user-facing queue lag 3.5s',
        retryAfterMs: 60_000,
      }),
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    const runtime = broadcastRuntime(service);
    const processSpy = jest
      .spyOn(runtime, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await service.processDueManagedBroadcasts('scheduled');

    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'managed-broadcast',
      sourceTag: 'managed_broadcast',
      allowMaxApiCapacitySlowPath: true,
    });
    expect(prisma.managedBroadcast.findMany).not.toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();
  });

  it('does a small single pass for due managed broadcasts when the governor asks to slow down', async () => {
    const prisma = createPrismaMock();
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({ where }: { where?: { status?: string | { in?: string[] } } }) => {
        if (where?.status === 'ACTIVE') {
          return Array.from({ length: 10 }, (_, index) => ({
            id: `active-${index + 1}`,
          }));
        }

        const statusFilter = where?.status as { in?: string[] } | undefined;
        if (Array.isArray(statusFilter?.in) && statusFilter.in.includes('FAILED')) {
          return [{ id: 'recovery-1' }];
        }

        return [];
      },
    );
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'background share 60.0%',
        retryAfterMs: 20_000,
      }),
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernorService as never,
    );
    const runtime = broadcastRuntime(service);
    const processSpy = jest
      .spyOn(runtime, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await service.processDueManagedBroadcasts('scheduled');

    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy).toHaveBeenNthCalledWith(1, 'active-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
    expect(processSpy).toHaveBeenNthCalledWith(2, 'recovery-1', 'scheduled', expect.any(Date), [
      'ACTIVE',
      'PARTIAL',
      'FAILED',
    ]);
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledTimes(1);
  });

  it('stores future chat broadcast in managed schedules', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
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

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: true,
        imageBase64: TINY_JPEG_BASE64,
        imageMimeType: 'image/jpeg',
        imageFileName: 'photo.jpg',
        sendAt: '2026-03-03T11:00:00.000Z',
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.create).toHaveBeenCalledTimes(1);
    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceChatId: 'chat-1',
          imageEnabled: true,
          imageMimeType: 'image/jpeg',
          imageFileName: 'photo.jpg',
          nextSendAt: new Date('2026-03-03T11:00:00.000Z'),
          cycleEnabled: false,
          cycleCount: 1,
          sentCount: 0,
        }),
      }),
    );
    expect(result.sendAt).toBe('2026-03-03T11:00:00.000Z');
    expect(result.nextSendAt).toBe('2026-03-03T11:00:00.000Z');
    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.sentChats).toBe(0);
    expect(result.failedChats).toBe(0);
  });

  it('does not resolve mass targets for a current chat broadcast', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-broadcast-1', url: null }),
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
    const massTargetsSpy = jest
      .spyOn(service, 'listChatsForMassBroadcast')
      .mockRejectedValue(new Error('mass target lookup should not run'));

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Локальное объявление',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['chat-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(massTargetsSpy).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      'Локальное объявление',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(result.targetChats).toBe(1);
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(0);
  });

  it('routes immediate channel broadcasts through durable delivery rows before sending', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async () => {
        expect(deliveries).toEqual([
          expect.objectContaining({
            broadcastId: 'broadcast-1',
            occurrenceIndex: 1,
            targetChatId: 'channel-1',
            botId: 'channel-bot-2',
            status: 'SENDING',
            attemptCount: 1,
            remoteMessageId: null,
          }),
        ]);
        return {
          messageId: 'mid-channel-broadcast-1',
          url: 'https://max.ru/channels/channel-1/message/mid-channel-broadcast-1',
        };
      }),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'resolveDeliveryBotAssignment').mockResolvedValue('channel-bot-2');

    const result = await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        requestId: 'channel_req_1',
        text: 'Пост в канал',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['channel-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'channel-1',
      'Пост в канал',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'channel-1' } },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
        botId: 'channel-bot-2',
      }),
    );
    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceChatId: 'channel-1',
          entityType: 'CHANNEL',
          targetChatIds: ['channel-1'],
          nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
          cycleEnabled: false,
          cycleCount: 1,
          sentCount: 0,
        }),
      }),
    );
    expect(prisma.managedBroadcastDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'channel-1',
          status: 'PENDING',
        }),
      ],
    });
    expect(prisma.managedBroadcastDelivery.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.sendMessageImmediateWithId.mock.invocationCallOrder[0],
    );
    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(0);
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENT',
        botId: 'channel-bot-2',
        attemptCount: 1,
        remoteMessageId: 'mid-channel-broadcast-1',
        legacySentWithoutRemoteId: false,
        lastError: null,
      }),
    );
    expect(prisma.managedBroadcastIdempotencyRecord.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'broadcast-idempotency-1' },
        data: expect.objectContaining({
          broadcastId: 'broadcast-1',
          result: expect.objectContaining({
            scheduleId: 'broadcast-1',
            sentChats: 1,
            failedChats: 0,
          }),
        }),
      }),
    );
  });

  it('does not retry ambiguous immediate channel broadcast timeouts', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    const timeoutError = Object.assign(new Error('timeout of 5000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockRejectedValue(timeoutError),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Пост в канал',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['channel-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.sentChats).toBe(0);
    expect(result.failedChats).toBe(1);
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'AMBIGUOUS',
        attemptCount: 1,
        remoteMessageId: null,
        lastError: 'timeout of 5000ms exceeded',
      }),
    );
  });

  it('replays immediate channel broadcast request ids without sending again', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    wireManagedBroadcastDeliveryStore(prisma);
    const cachedResult = {
      sourceChatId: 'channel-1',
      targetChats: 1,
      sentChats: 1,
      failedChats: 0,
      sentChatIds: ['channel-1'],
      failedChatIds: [],
      sentChatPreviews: [],
      failedChatPreviews: [],
      sentChatOverflowCount: 0,
      failedChatOverflowCount: 0,
      scheduleMode: 'legacy',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [],
      sendAt: null,
      nextSendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
      scheduleId: 'broadcast-1',
      scheduledOccurrences: 0,
    };
    prisma.managedBroadcastIdempotencyRecord.create.mockImplementationOnce(
      async ({ data }: { data: Record<string, unknown> }) => {
        prisma.managedBroadcastIdempotencyRecord.findUnique.mockResolvedValueOnce({
          id: 'broadcast-idempotency-1',
          requestId: 'channel_req_1',
          requestHash: data.requestHash,
          sourceChatId: 'channel-1',
          entityType: 'CHANNEL',
          actorUserId: 'admin-1',
          source: 'miniapp',
          broadcastId: 'broadcast-1',
          result: cachedResult,
          createdAt: new Date('2026-03-03T10:00:00.000Z'),
          updatedAt: new Date('2026-03-03T10:00:00.000Z'),
        });
        throw { code: 'P2002' };
      },
    );
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn(),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        requestId: 'channel_req_1',
        text: 'Пост в канал',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['channel-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result).toEqual(cachedResult);
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.create).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastDelivery.createMany).not.toHaveBeenCalled();
  });

  it('records chat broadcast comments button target after immediate delivery', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chatSettings.upsert.mockResolvedValue({
      chatId: 'chat-1',
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: true,
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-comments-1',
        url: 'https://max.ru/chats/chat-1/message/mid-chat-comments-1',
      }),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Объявление с обсуждением',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['chat-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.sentChats).toBe(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      'Объявление с обсуждением',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 0' })]],
      }),
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'AUTO_ATTACH_CHAT_COMMENTS',
        payload: expect.objectContaining({
          messageId: 'mid-chat-comments-1',
          threadId: expect.any(String),
          source: 'managed_broadcast',
          managedBroadcastSource: 'immediate',
          text: 'Объявление с обсуждением',
          publishedUrl: 'https://max.ru/chats/chat-1/message/mid-chat-comments-1',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
        }),
      }),
    });
  });

  it('overwrites conflicting calendar slots from an older broadcast', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const conflictBroadcast = {
      id: 'broadcast-conflict',
      sourceChatId: 'chat-1',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Старый автопостинг',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1'],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt: new Date('2026-03-03T12:00:00.000Z'),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 2,
      sentCount: 0,
      status: 'ACTIVE',
      lastError: null,
      lockedAt: null,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    };
    const originalManagedBroadcastUpdate = prisma.managedBroadcast.update;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({ where }: { where?: { id?: { in?: string[] } } }) =>
        where?.id?.in?.includes(conflictBroadcast.id) ? [conflictBroadcast] : [],
    );
    prisma.managedBroadcast.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (where.id === conflictBroadcast.id) {
          Object.assign(conflictBroadcast, data);
          return conflictBroadcast;
        }

        return originalManagedBroadcastUpdate({
          where,
          data,
        } as never);
      },
    );

    const occurrences = wireManagedBroadcastOccurrenceStore(prisma, [
      {
        id: 'occurrence-conflict-1',
        broadcastId: 'broadcast-conflict',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        occurrenceIndex: 1,
        scheduledAt: new Date('2026-03-03T12:00:00.000Z'),
        status: 'ACTIVE',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
      {
        id: 'occurrence-conflict-2',
        broadcastId: 'broadcast-conflict',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        occurrenceIndex: 2,
        scheduledAt: new Date('2026-03-03T13:00:00.000Z'),
        status: 'ACTIVE',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
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

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Новый автопостинг',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        replaceConflictingSlots: true,
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.scheduledSlots).toEqual(['2026-03-03T12:00:00.000Z']);
    expect(conflictBroadcast.nextSendAt).toEqual(new Date('2026-03-03T13:00:00.000Z'));
    expect(conflictBroadcast.cycleCount).toBe(1);
    expect(occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 1,
          scheduledAt: new Date('2026-03-03T13:00:00.000Z'),
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          scheduledAt: new Date('2026-03-03T12:00:00.000Z'),
        }),
      ]),
    );
    expect(
      occurrences.some(
        (occurrence) =>
          occurrence.broadcastId === 'broadcast-conflict' &&
          occurrence.scheduledAt.getTime() === new Date('2026-03-03T12:00:00.000Z').getTime(),
      ),
    ).toBe(false);
  });

  it('preserves the current partial calendar occurrence when overwriting a future slot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    const conflictBroadcast = {
      id: 'broadcast-conflict',
      sourceChatId: 'chat-1',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Старый автопостинг',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1', 'chat-2'],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt: new Date('2026-03-03T12:00:00.000Z'),
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 3,
      sentCount: 0,
      status: 'PARTIAL',
      lastError: 'Одна доставка не прошла.',
      lockedAt: null,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    };
    const originalManagedBroadcastUpdate = prisma.managedBroadcast.update;
    prisma.managedBroadcast.findMany.mockImplementation(
      async ({ where }: { where?: { id?: { in?: string[] } } }) =>
        where?.id?.in?.includes(conflictBroadcast.id) ? [conflictBroadcast] : [],
    );
    prisma.managedBroadcast.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (where.id === conflictBroadcast.id) {
          Object.assign(conflictBroadcast, data);
          return conflictBroadcast;
        }

        return originalManagedBroadcastUpdate({
          where,
          data,
        } as never);
      },
    );

    const occurrences = wireManagedBroadcastOccurrenceStore(prisma, [
      {
        id: 'occurrence-conflict-1',
        broadcastId: 'broadcast-conflict',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        occurrenceIndex: 1,
        scheduledAt: new Date('2026-03-03T12:00:00.000Z'),
        status: 'PARTIAL',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
      {
        id: 'occurrence-conflict-2',
        broadcastId: 'broadcast-conflict',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        occurrenceIndex: 2,
        scheduledAt: new Date('2026-03-03T13:00:00.000Z'),
        status: 'ACTIVE',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
      {
        id: 'occurrence-conflict-3',
        broadcastId: 'broadcast-conflict',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        occurrenceIndex: 3,
        scheduledAt: new Date('2026-03-03T14:00:00.000Z'),
        status: 'ACTIVE',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENT',
        },
        {
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'FAILED',
        },
        {
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });
    deliveries[0].sentAt = new Date('2026-03-03T12:00:30.000Z');
    deliveries[0].remoteMessageId = 'mid-preserved';
    deliveries[1].lastError = 'MAX send failed';

    const service = createAdminServiceFixture(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        sendMessage: jest.fn(),
      } as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Новый автопостинг',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-03T13:00:00.000Z'],
        replaceConflictingSlots: true,
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.scheduleId).toBe('broadcast-1');
    expect(conflictBroadcast).toEqual(
      expect.objectContaining({
        nextSendAt: new Date('2026-03-03T12:00:00.000Z'),
        cycleCount: 2,
        status: 'ACTIVE',
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENT',
          remoteMessageId: 'mid-preserved',
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'FAILED',
          lastError: 'MAX send failed',
        }),
      ]),
    );
    expect(
      deliveries.some(
        (delivery) => delivery.broadcastId === 'broadcast-conflict' && delivery.occurrenceIndex > 2,
      ),
    ).toBe(false);
    expect(occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 1,
          scheduledAt: new Date('2026-03-03T12:00:00.000Z'),
          status: 'PARTIAL',
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-conflict',
          occurrenceIndex: 2,
          scheduledAt: new Date('2026-03-03T14:00:00.000Z'),
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          scheduledAt: new Date('2026-03-03T13:00:00.000Z'),
        }),
      ]),
    );
  });

  it('rejects calendar slots already occupied in a selected target chat', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const slot = new Date('2026-03-03T12:00:00.000Z');
    prisma.managedBroadcastCalendarReservation.findMany.mockResolvedValue([
      {
        broadcastId: 'broadcast-target-conflict',
        scheduledAt: slot,
        targetChatId: 'chat-2',
      },
    ]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
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
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await expect(
      broadcastRuntime(service).sendBroadcast(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Новый автопостинг',
          textFormat: 'plain',
          targetMode: 'selected',
          targetChatIds: ['chat-2'],
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
          scheduleMode: 'calendar',
          scheduleTimezone: 'Europe/Moscow',
          scheduledSlots: ['2026-03-03T12:00:00.000Z'],
          replaceConflictingSlots: true,
          sendAt: null,
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BROADCAST_TARGET_SLOT_CONFLICT',
        conflicts: ['2026-03-03T12:00:00.000Z'],
        targetChatIds: ['chat-2'],
      }),
    });
    expect(prisma.managedBroadcastOccurrence.createMany).not.toHaveBeenCalled();
  });

  it('returns only calendar slots that overlap the requested target chats', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.managedBroadcastCalendarReservation.findMany.mockImplementation(async ({ where }) => {
      const targetFilter = (where as { targetChatId?: { in?: string[] } } | undefined)
        ?.targetChatId;
      const targetIds = Array.isArray(targetFilter?.in) ? targetFilter.in : [];
      return [
        {
          broadcastId: 'broadcast-overlap',
          occurrenceIndex: 1,
          scheduledAt: new Date('2026-03-03T12:00:00.000Z'),
          targetChatId: 'chat-2',
          broadcast: {
            id: 'broadcast-overlap',
            sourceChatId: 'chat-1',
            entityType: 'CHAT',
            text: 'Пост в выбранный чат',
            mediaType: null,
            mediaPayload: null,
            imageEnabled: false,
            imageBase64: '',
            imageMimeType: '',
            imageFileName: '',
            targetChatIds: ['chat-2', 'chat-3'],
            applyToAllChats: false,
            status: 'ACTIVE',
          },
        },
        {
          broadcastId: 'broadcast-other',
          occurrenceIndex: 1,
          scheduledAt: new Date('2026-03-03T13:00:00.000Z'),
          targetChatId: 'chat-3',
          broadcast: {
            id: 'broadcast-other',
            sourceChatId: 'chat-1',
            entityType: 'CHAT',
            text: 'Пост в другой чат',
            mediaType: null,
            mediaPayload: null,
            imageEnabled: false,
            imageBase64: '',
            imageMimeType: '',
            imageFileName: '',
            targetChatIds: ['chat-3'],
            applyToAllChats: false,
            status: 'ACTIVE',
          },
        },
      ].filter((row) => targetIds.length === 0 || targetIds.includes(row.targetChatId));
    });
    prisma.chat.findMany.mockResolvedValue([
      { id: 'chat-2', title: 'Чат 2', entityType: 'CHAT' },
      { id: 'chat-3', title: 'Чат 3', entityType: 'CHAT' },
    ]);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
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
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-3',
        title: 'Чат 3',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    const result = await service.getManagedBroadcastCalendar(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        from: '2026-03-03T00:00:00.000Z',
        to: '2026-03-04T00:00:00.000Z',
        targetChatIds: 'chat-2',
      },
    );

    expect(result.targetChatIds).toEqual(['chat-2']);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toEqual(
      expect.objectContaining({
        broadcastId: 'broadcast-overlap',
        scheduledAt: '2026-03-03T12:00:00.000Z',
        hasTargetOverlap: true,
        overlapChatIds: ['chat-2'],
        targetChats: 2,
      }),
    );
    expect(result.slots[0]?.targetPreviews.map((preview) => preview.title)).toEqual([
      'Чат 2',
      'Чат 3',
    ]);
  });

  it('sends first cycle immediately and stores remaining launches', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-broadcast-1', url: null }),
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

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: true,
        cycleEveryHours: 2,
        cycleCount: 3,
      },
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
          cycleEnabled: true,
          cycleEveryHours: 2,
          cycleCount: 3,
          sentCount: 0,
        }),
      }),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        nextSendAt: new Date('2026-03-03T12:00:00.000Z'),
        sentCount: 1,
        status: 'ACTIVE',
      }),
    );
    expect(result.cycleEveryHours).toBe(2);
    expect(result.cycleCount).toBe(3);
    expect(result.nextSendAt).toBe('2026-03-03T12:00:00.000Z');
    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.scheduledOccurrences).toBe(2);
  });

  it('stores partial immediate failures for retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-2') {
          throw new Error('MAX send failed');
        }
        return { messageId: `mid-${chatId}`, url: null };
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
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Чат 1',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.scheduleId).toBe('broadcast-1');
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(1);
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'PARTIAL',
      }),
    );
  });

  it('retries managed broadcast sends after transient MAX API throttling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValueOnce({ messageId: 'mid-chat-1', url: null })
        .mockRejectedValueOnce(new Error('MAX API global rate limit exceeded'))
        .mockResolvedValueOnce({ messageId: 'mid-chat-2', url: null }),
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
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    const sendPromise = broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    await jest.runAllTimersAsync();
    const result = await sendPromise;

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(3);
    expect(result.sentChats).toBe(2);
    expect(result.failedChats).toBe(0);
  });

  it('refreshes the direct broadcast access epoch before every internal MAX retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const retryError = new Error('MAX API global rate limit exceeded');
    const terminalError = Object.assign(new Error('chat denied'), {
      response: {
        status: 403,
        data: { code: 'chat.denied', message: 'chat denied' },
      },
    });
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementationOnce(async () => {
          jest.setSystemTime(new Date('2026-03-03T10:00:05.000Z'));
          throw retryError;
        })
        .mockRejectedValueOnce(terminalError),
    };
    const service = new AdminService(
      createPrismaMock() as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const runtime = broadcastRuntime(service);
    jest
      .spyOn(runtime, 'resolveManagedBroadcastSendRetryDelayMs')
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(null);
    const attemptEpochs: Date[] = [];

    const sendPromise = runtime.sendManagedBroadcastMessageImmediateWithId(
      'chat-1',
      'Напоминание',
      undefined,
      'bot-1',
      undefined,
      undefined,
      (startedAt: Date) => attemptEpochs.push(startedAt),
    );
    const sendExpectation = expect(sendPromise).rejects.toBe(terminalError);
    await waitForPendingFakeTimer();
    await jest.advanceTimersByTimeAsync(1);

    await sendExpectation;
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(attemptEpochs).toHaveLength(2);
    expect(attemptEpochs[1].getTime()).toBeGreaterThan(attemptEpochs[0].getTime());
  });

  it.each([
    {
      label: 'transport timeout',
      error: Object.assign(new Error('timeout of 5000ms exceeded'), {
        code: 'ECONNABORTED',
      }),
      expectedLastError: 'timeout of 5000ms exceeded',
    },
    {
      label: 'HTTP 503 response',
      error: Object.assign(new Error('service unavailable'), {
        response: {
          status: 503,
          data: { message: 'service unavailable' },
        },
      }),
      expectedLastError: 'service unavailable',
    },
  ])(
    'does not immediately retry ambiguous managed broadcast $label',
    async ({ error, expectedLastError }) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

      const prisma = createPrismaMock();
      const deliveries = wireManagedBroadcastDeliveryStore(prisma);
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        sendMessageImmediateWithId: jest.fn().mockRejectedValue(error),
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

      const result = await broadcastRuntime(service).sendBroadcast(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Напоминание',
          textFormat: 'plain',
          targetMode: 'current',
          targetChatIds: ['chat-1'],
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
          sendAt: null,
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
      );

      expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
      expect(result.failedChats).toBe(1);
      expect(deliveries[0]).toEqual(
        expect.objectContaining({
          status: 'AMBIGUOUS',
          attemptCount: 1,
          lastError: expectedLastError,
        }),
      );
    },
  );

  it('retries a managed broadcast with the promoted survivor and keeps future occurrences', async () => {
    const maxSendAttemptStartedAt = new Date('2026-03-03T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(maxSendAttemptStartedAt);

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    const denied = Object.assign(new Error('chat denied'), {
      response: {
        status: 403,
        data: { code: 'chat.denied', message: 'chat denied' },
      },
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (
            _chatId: string,
            _text: string,
            _options: unknown,
            requestOptions: { botId?: string },
          ) => {
            if (requestOptions.botId === 'bot-1') {
              throw denied;
            }
            return { messageId: 'mid-survivor', url: null };
          },
        ),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'resolveDeliveryBotAssignment').mockResolvedValue('bot-1');
    const accessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: {
          chatId: 'chat-1',
          botId: 'bot-1',
          nextOwnerBotId: 'bot-2',
          updatedAccessEdges: 1,
          cleanup: {
            nightModeJobsCleared: false,
            canceledBroadcasts: null,
            canceledBroadcastDeliveries: null,
            canceledBroadcastOccurrences: null,
            clearedVkPublishPosts: null,
            pausedVkSources: null,
            removedRosterSyncJobs: null,
          },
        },
      }),
    };
    (service as any).managedEntityAccessLossService = accessLossService;

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['chat-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: true,
        cycleEveryHours: 2,
        cycleCount: 2,
      },
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({ botId: 'bot-2' }),
    );
    expect(accessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      entityType: 'CHAT',
      source: 'managed_broadcast:delivery',
      operation: 'send',
      error: denied,
      lifecycleEventAt: maxSendAttemptStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    expect(result.sentChats).toBe(1);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          status: 'SENT',
          botId: 'bot-2',
          remoteMessageId: 'mid-survivor',
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          status: 'PENDING',
        }),
      ]),
    );
    expect(deliveries.find((delivery) => delivery.occurrenceIndex === 2)?.status).not.toBe(
      'CANCELED',
    );
  });

  it('does not automatically retry ambiguous timed out managed broadcast deliveries on scheduled runs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'timeout of 5000ms exceeded',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'AMBIGUOUS',
        },
      ],
    });
    deliveries[0].status = 'AMBIGUOUS';
    deliveries[0].attemptCount = 1;
    deliveries[0].lastError = 'timeout of 5000ms exceeded';
    deliveries[0].updatedAt = new Date('2026-03-03T10:00:00.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-1-retry',
        url: null,
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

    const processPromise = (
      service as any
    ).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );
    await jest.runAllTimersAsync();
    const result = await processPromise;

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'AMBIGUOUS',
        remoteMessageId: null,
        lastError: 'timeout of 5000ms exceeded',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        sentChatIds: [],
        failedChatIds: ['chat-1'],
        pendingChatIds: [],
        canRetry: false,
      }),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'FAILED',
        sentCount: 0,
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );
    await expect(
      broadcastRuntime(service).retryManagedBroadcast('chat-1', 'broadcast-1', {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).rejects.toThrow('неоднозначные доставки');
  });

  it('automatically retries failed timed out managed broadcast deliveries on scheduled runs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'timeout of 5000ms exceeded',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'FAILED',
          attemptCount: 1,
          lastError: 'timeout of 5000ms exceeded',
          updatedAt: new Date('2026-03-03T10:00:00.000Z'),
        },
      ],
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-1-retry',
        url: null,
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const prepared = await request.prepareAttempt({ botId: 'retry-bot', job: {} });
        request.onDispatchAttempt({ botId: 'retry-bot', job: { ...prepared } });
        return {
          messageId: 'mid-chat-1-retry',
          url: null,
          botId: 'retry-bot',
          candidateBotIds: ['retry-bot'],
          routingVersion: 1,
        };
      }),
    };
    (service as any).maxRoutedPublicationService = maxRoutedPublicationService;

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'chat-1',
        logicalIdempotencyKey: expect.stringMatching(
          /^managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:legacy-[a-f0-9]{32}:attempt:2$/u,
        ),
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'COMPLETED',
        sentChatIds: ['chat-1'],
        failedChatIds: [],
        nextSendAt: null,
      }),
    );
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENT',
        attemptCount: 2,
        remoteMessageId: 'mid-chat-1-retry',
        lastError: null,
      }),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'COMPLETED',
        sentCount: 1,
        nextSendAt: null,
        lastError: null,
      }),
    );
  });

  it('retries failed managed broadcast deliveries without touching ambiguous ones', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:15:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Есть неотправленные и неоднозначные доставки.',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'FAILED',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'AMBIGUOUS',
        },
      ],
    });
    deliveries[0].status = 'FAILED';
    deliveries[0].attemptCount = 1;
    deliveries[0].lastError = 'MAX send failed';
    deliveries[1].status = 'AMBIGUOUS';
    deliveries[1].attemptCount = 1;
    deliveries[1].lastError = 'timeout of 5000ms exceeded';
    deliveries[1].updatedAt = new Date('2026-03-03T10:00:00.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-1-retry',
        url: null,
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).retryManagedBroadcast('chat-1', 'broadcast-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'PARTIAL',
        deliveredChats: 1,
        failedChats: 1,
        pendingChats: 0,
        canRetry: false,
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetChatId: 'chat-1',
          status: 'SENT',
          remoteMessageId: 'mid-chat-1-retry',
          lastError: null,
        }),
        expect.objectContaining({
          targetChatId: 'chat-2',
          status: 'AMBIGUOUS',
          remoteMessageId: null,
          lastError: 'timeout of 5000ms exceeded',
        }),
      ]),
    );
  });

  it('processes pending managed broadcast deliveries before finalizing mixed failed occurrences', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Не удалось отправить в 1 чат(ов).',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'FAILED',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
      ],
    });
    deliveries[0].status = 'FAILED';
    deliveries[0].attemptCount = 1;
    deliveries[0].lastError = 'MAX send failed';
    deliveries[0].updatedAt = new Date('2026-03-03T10:00:00.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-2',
        url: null,
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

    const processPromise = (
      service as any
    ).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );
    await jest.runAllTimersAsync();
    const result = await processPromise;

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-2',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-2' } },
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'PARTIAL',
        sentChatIds: ['chat-2'],
        failedChatIds: ['chat-1'],
        pendingChatIds: [],
        canRetry: true,
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetChatId: 'chat-1',
          status: 'FAILED',
          lastError: 'MAX send failed',
        }),
        expect.objectContaining({
          targetChatId: 'chat-2',
          status: 'SENT',
          remoteMessageId: 'mid-chat-2',
        }),
      ]),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'PARTIAL',
        sentCount: 0,
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );
  });

  it('recovers legacy managed broadcasts that have no delivery rows', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: [],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-1',
        url: null,
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

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(deliveries).toEqual([
      expect.objectContaining({
        broadcastId: 'broadcast-1',
        occurrenceIndex: 1,
        targetChatId: 'chat-1',
        status: 'SENT',
        remoteMessageId: 'mid-chat-1',
      }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'COMPLETED',
        sentChatIds: ['chat-1'],
        failedChatIds: [],
      }),
    );
  });

  it('recovers managed broadcasts with partially missing delivery rows without duplicating targets', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2', 'chat-3'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 2,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'SENT',
          remoteMessageId: 'mid-chat-2',
          sentAt: new Date('2026-03-03T10:00:00.000Z'),
        },
      ],
    });
    deliveries[0].remoteMessageId = 'mid-chat-2';
    deliveries[0].sentAt = new Date('2026-03-03T10:00:00.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValueOnce({
          messageId: 'mid-chat-1',
          url: null,
        })
        .mockResolvedValueOnce({
          messageId: 'mid-chat-3',
          url: null,
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

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      2,
      'chat-3',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-3' } },
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'managed_broadcast',
      }),
    );
    const currentDeliveries = deliveries.filter((delivery) => delivery.occurrenceIndex === 1);
    const futureDeliveries = deliveries.filter((delivery) => delivery.occurrenceIndex === 2);
    expect(deliveries).toHaveLength(6);
    expect(prisma.managedBroadcastDelivery.createMany).toHaveBeenLastCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ occurrenceIndex: 1, targetChatId: 'chat-1' }),
        expect.objectContaining({ occurrenceIndex: 1, targetChatId: 'chat-3' }),
        expect.objectContaining({ occurrenceIndex: 2, targetChatId: 'chat-1' }),
        expect.objectContaining({ occurrenceIndex: 2, targetChatId: 'chat-2' }),
        expect.objectContaining({ occurrenceIndex: 2, targetChatId: 'chat-3' }),
      ]),
      skipDuplicates: true,
    });
    expect(currentDeliveries).toHaveLength(3);
    expect(currentDeliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENT',
          remoteMessageId: 'mid-chat-1',
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'SENT',
          remoteMessageId: 'mid-chat-2',
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-3',
          status: 'SENT',
          remoteMessageId: 'mid-chat-3',
        }),
      ]),
    );
    expect(new Set(currentDeliveries.map((delivery) => delivery.targetChatId))).toEqual(
      new Set(['chat-1', 'chat-2', 'chat-3']),
    );
    expect(futureDeliveries).toHaveLength(3);
    expect(futureDeliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'PENDING',
        }),
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-3',
          status: 'PENDING',
        }),
      ]),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        sentChatIds: ['chat-1', 'chat-3'],
        failedChatIds: [],
      }),
    );
  });

  it('drops permanently unavailable targets from future managed broadcast deliveries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Chat closed',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENT',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'FAILED',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
      ],
    });
    deliveries[0].status = 'SENT';
    deliveries[0].remoteMessageId = 'mid-chat-1';
    deliveries[0].sentAt = new Date('2026-03-03T10:00:00.000Z');
    deliveries[1].status = 'FAILED';
    deliveries[1].attemptCount = 1;
    deliveries[1].lastError = 'Chat -72491481331058 not found';
    deliveries[1].updatedAt = new Date('2026-03-03T10:00:00.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn(),
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

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        sentChatIds: ['chat-1'],
        failedChatIds: ['chat-2'],
        canRetry: false,
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: 'Chat -72491481331058 not found',
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: 'Chat -72491481331058 not found',
        }),
        expect.objectContaining({
          occurrenceIndex: 3,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: 'Chat -72491481331058 not found',
        }),
      ]),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        sentCount: 1,
        nextSendAt: new Date('2026-03-03T11:00:00.000Z'),
        lastError: null,
      }),
    );
  });

  it('quarantines chronically timing out targets from current and future managed broadcast deliveries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'timeout of 5000ms exceeded',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENT',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'FAILED',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-2',
          status: 'PENDING',
        },
      ],
    });
    deliveries[0].status = 'SENT';
    deliveries[0].remoteMessageId = 'mid-chat-1';
    deliveries[0].sentAt = new Date('2026-03-03T10:00:00.000Z');
    deliveries[1].status = 'FAILED';
    deliveries[1].attemptCount = 6;
    deliveries[1].lastError = 'timeout of 5000ms exceeded';
    deliveries[1].updatedAt = new Date('2026-03-03T10:00:00.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn(),
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

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        sentChatIds: ['chat-1'],
        failedChatIds: ['chat-2'],
        canRetry: false,
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: expect.stringContaining(
            'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки',
          ),
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: expect.stringContaining(
            'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки',
          ),
        }),
        expect.objectContaining({
          occurrenceIndex: 3,
          targetChatId: 'chat-2',
          status: 'CANCELED',
          lastError: expect.stringContaining(
            'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки',
          ),
        }),
      ]),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        sentCount: 1,
        nextSendAt: new Date('2026-03-03T11:00:00.000Z'),
        lastError: null,
      }),
    );
  });

  it('reports blocked and quarantined deliveries in managed broadcast snapshots', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const snapshot = (
      service as any
    ).managedBroadcastRuntime.createManagedBroadcastDeliverySnapshot(
      {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'PARTIAL',
        lastError: 'timeout of 5000ms exceeded',
        lockedAt: null,
        createdAt: new Date('2026-03-03T10:00:00.000Z'),
        updatedAt: new Date('2026-03-03T10:00:00.000Z'),
      },
      [
        {
          status: 'SENT',
          lastError: null,
        },
        {
          status: 'FAILED',
          lastError: 'timeout of 5000ms exceeded',
        },
        {
          status: 'FAILED',
          lastError: 'unexpected failure',
        },
        {
          status: 'CANCELED',
          lastError: 'Chat closed',
        },
        {
          status: 'CANCELED',
          lastError:
            'Чат временно исключен из оставшихся доставок после повторяющихся ошибок отправки: 6 неудачных попыток. Последняя ошибка: timeout of 5000ms exceeded',
        },
        {
          status: 'PENDING',
          lastError: null,
        },
      ],
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        currentOccurrence: 1,
        deliveredChats: 1,
        failedChats: 2,
        pendingChats: 1,
        blockedChats: 2,
        canRetry: true,
        failureBreakdown: {
          transient: 1,
          permanentTarget: 1,
          quarantined: 1,
          unknown: 1,
        },
      }),
    );
  });

  it('derives target mode for managed broadcast summary and details from persisted rows', async () => {
    const prisma = createPrismaMock();
    const service = new AdminService(
      prisma as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const baseRow = await prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } });

    expect(baseRow).not.toBeNull();

    const currentSnapshot = (
      service as any
    ).managedBroadcastRuntime.createManagedBroadcastDeliverySnapshot(baseRow, []);
    const currentSummary = (service as any).managedBroadcastRuntime.mapManagedBroadcastSummary(
      baseRow,
      currentSnapshot,
      [],
    );
    const currentDetails = (service as any).managedBroadcastRuntime.mapManagedBroadcastDetails(
      baseRow,
      currentSnapshot,
      [],
    );

    expect(currentSummary.targetMode).toBe('current');
    expect(currentDetails.targetMode).toBe('current');

    const selectedRow = {
      ...baseRow!,
      applyToAllChats: false,
      targetChatIds: ['chat-2'],
    };
    const selectedSnapshot = (
      service as any
    ).managedBroadcastRuntime.createManagedBroadcastDeliverySnapshot(selectedRow, []);
    const selectedSummary = (service as any).managedBroadcastRuntime.mapManagedBroadcastSummary(
      selectedRow,
      selectedSnapshot,
      [],
    );
    const selectedDetails = (service as any).managedBroadcastRuntime.mapManagedBroadcastDetails(
      selectedRow,
      selectedSnapshot,
      [],
    );

    expect(selectedSummary.targetMode).toBe('selected');
    expect(selectedDetails.targetMode).toBe('selected');
    expect(selectedDetails.targetChatIds).toEqual(['chat-2']);

    const allRow = {
      ...baseRow!,
      applyToAllChats: true,
      targetChatIds: ['chat-1', 'chat-2'],
    };
    const allSnapshot = (
      service as any
    ).managedBroadcastRuntime.createManagedBroadcastDeliverySnapshot(allRow, []);
    const allSummary = (service as any).managedBroadcastRuntime.mapManagedBroadcastSummary(
      allRow,
      allSnapshot,
      [],
    );
    const allDetails = (service as any).managedBroadcastRuntime.mapManagedBroadcastDetails(
      allRow,
      allSnapshot,
      [],
    );

    expect(allSummary.targetMode).toBe('all');
    expect(allDetails.targetMode).toBe('all');

    const videoRow = {
      ...baseRow!,
      mediaType: 'video',
      mediaPayload: { token: 'video-token-1' },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'announce.mp4',
    };
    const videoSnapshot = (
      service as any
    ).managedBroadcastRuntime.createManagedBroadcastDeliverySnapshot(videoRow, []);
    const videoSummary = (service as any).managedBroadcastRuntime.mapManagedBroadcastSummary(
      videoRow,
      videoSnapshot,
      [],
    );
    const videoDetails = (service as any).managedBroadcastRuntime.mapManagedBroadcastDetails(
      videoRow,
      videoSnapshot,
      [],
    );

    expect(videoSummary.hasVideo).toBe(true);
    expect(videoDetails.mediaType).toBe('video');
    expect(videoDetails.mediaPayload).toEqual({ token: 'video-token-1' });
    expect(videoDetails.mediaMimeType).toBe('video/mp4');
    expect(videoDetails.mediaFileName).toBe('announce.mp4');
  });

  it('normalizes legacy managed broadcasts with zero cycle count for response contracts', async () => {
    const prisma = createPrismaMock();
    const service = new AdminService(
      prisma as never,
      {} as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const baseRow = await prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } });
    expect(baseRow).not.toBeNull();

    const legacyRow = {
      ...baseRow!,
      status: 'COMPLETED',
      cycleCount: 0,
      sentCount: 0,
    };
    const snapshot = (
      service as any
    ).managedBroadcastRuntime.createManagedBroadcastDeliverySnapshot(legacyRow, []);
    const summary = (service as any).managedBroadcastRuntime.mapManagedBroadcastSummary(
      legacyRow,
      snapshot,
      [],
    );
    const details = (service as any).managedBroadcastRuntime.mapManagedBroadcastDetails(
      legacyRow,
      snapshot,
      [],
    );

    expect(summary.cycleCount).toBe(1);
    expect(details.cycleCount).toBe(1);
    expect(managedBroadcastSummarySchema.parse(summary).cycleCount).toBe(1);
    expect(managedBroadcastDetailsSchema.parse(details).cycleCount).toBe(1);
  });

  it('keeps selected target mode when updating a scheduled broadcast', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    wireManagedBroadcastOccurrenceStore(prisma, [
      {
        id: 'occurrence-1',
        broadcastId: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        occurrenceIndex: 1,
        scheduledAt: new Date('2026-03-03T12:00:00.000Z'),
        status: 'ACTIVE',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    ]);
    await prisma.managedBroadcast.update({
      where: { id: 'broadcast-1' },
      data: {
        nextSendAt: new Date('2026-03-03T12:00:00.000Z'),
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'ACTIVE',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
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
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    const result = await broadcastRuntime(service).updateManagedBroadcast(
      'chat-1',
      'broadcast-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Обновлённый автопостинг',
        textFormat: 'plain',
        targetMode: 'selected',
        targetChatIds: ['chat-2'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'broadcast-1' }),
        data: expect.objectContaining({
          applyToAllChats: false,
          targetChatIds: ['chat-2'],
        }),
      }),
    );
    expect(result.targetMode).toBe('selected');
    expect(result.targetChatIds).toEqual(['chat-2']);
  });

  it('stops future managed broadcast deliveries after an invalid image processing error', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: true,
        imageBase64: MINIMAL_MP4_HEADER.toString('base64'),
        imageMimeType: 'application/octet-stream',
        imageFileName: 'bad.png',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn(),
      sendMessageImmediateWithId: jest.fn(),
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

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );

    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        canRetry: true,
        nextSendAt: null,
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          status: 'FAILED',
          lastError: MAX_UNSUPPORTED_IMAGE_MESSAGE,
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          status: 'CANCELED',
          lastError: MAX_UNSUPPORTED_IMAGE_MESSAGE,
        }),
        expect.objectContaining({
          occurrenceIndex: 3,
          status: 'CANCELED',
          lastError: MAX_UNSUPPORTED_IMAGE_MESSAGE,
        }),
      ]),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'FAILED',
        nextSendAt: null,
        lastError: MAX_UNSUPPORTED_IMAGE_MESSAGE,
      }),
    );
  });

  it('keeps future managed broadcast deliveries retryable after exhausted transient image upload failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: true,
        imageBase64: TINY_PNG_BASE64,
        imageMimeType: 'image/png',
        imageFileName: 'bad.png',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: true,
        cycleEveryHours: 1,
        cycleCount: 3,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Не удалось отправить в 1 чат(ов).',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'FAILED',
          attemptCount: 1,
          lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 2,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 3,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        attemptCount: 1,
        lastError: 'Не удалось загрузить фото. Попробуйте другое изображение.',
      }),
    );

    const uploadStarted = createDeferred<void>();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockImplementation(async () => {
        uploadStarted.resolve();
        throw { response: { status: 429, data: { message: 'rate limit exceeded' } } };
      }),
      sendMessageImmediateWithId: jest.fn(),
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

    const processPromise = (
      service as any
    ).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE', 'PARTIAL', 'FAILED'],
    );
    await uploadStarted.promise;
    await waitForPendingFakeTimer();
    await jest.runAllTimersAsync();
    const result = await processPromise;

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        canRetry: true,
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        failedChatIds: ['chat-1'],
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          occurrenceIndex: 1,
          status: 'FAILED',
          attemptCount: 2,
          lastError: 'Не удалось загрузить фото: rate limit exceeded',
        }),
        expect.objectContaining({
          occurrenceIndex: 2,
          status: 'PENDING',
          lastError: null,
        }),
        expect.objectContaining({
          occurrenceIndex: 3,
          status: 'PENDING',
          lastError: null,
        }),
      ]),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'FAILED',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        lastError: 'Не удалось загрузить фото: rate limit exceeded',
      }),
    );
  });

  it('finalizes a managed broadcast when fallback sent persistence succeeds after state sync failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });

    let failFirstSentUpdate = true;
    prisma.managedBroadcastDelivery.updateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where?: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (failFirstSentUpdate && data.status === 'SENT' && where?.id === deliveries[0]?.id) {
          failFirstSentUpdate = false;
          throw new Error('db sync failed');
        }

        let count = 0;
        for (const delivery of deliveries) {
          if (typeof where?.id === 'string' && delivery.id !== where.id) {
            continue;
          }
          if (typeof where?.status === 'string' && delivery.status !== where.status) {
            continue;
          }
          if (typeof where?.lockToken === 'string' && delivery.lockToken !== where.lockToken) {
            continue;
          }

          count += 1;
          if (typeof data.status === 'string') {
            delivery.status = data.status;
          }
          if ('lockedAt' in data) {
            delivery.lockedAt = (data.lockedAt as Date | null) ?? null;
          }
          if ('lockToken' in data) {
            delivery.lockToken = (data.lockToken as string | null) ?? null;
          }
          if ('lastError' in data) {
            delivery.lastError = (data.lastError as string | null) ?? null;
          }
          if ('remoteMessageId' in data) {
            delivery.remoteMessageId = (data.remoteMessageId as string | null) ?? null;
          }
          if ('sentAt' in data) {
            delivery.sentAt = (data.sentAt as Date | null) ?? null;
          }
          if ('legacySentWithoutRemoteId' in data) {
            delivery.legacySentWithoutRemoteId = Boolean(data.legacySentWithoutRemoteId);
          }
          if (
            data.attemptCount &&
            typeof data.attemptCount === 'object' &&
            'increment' in data.attemptCount
          ) {
            delivery.attemptCount += Number((data.attemptCount as { increment: number }).increment);
          }
        }
        return { count };
      },
    );

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-1',
        url: null,
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:55:00.000Z'),
      ['ACTIVE'],
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.sentChatIds).toEqual(['chat-1']);
    expect(result.failedChatIds).toEqual([]);
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENT',
        remoteMessageId: 'mid-chat-1',
        lastError: null,
      }),
    );
    await expect(
      prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'COMPLETED',
        nextSendAt: null,
        lastError: null,
      }),
    );
  });

  it('retries failed deliveries and completes the broadcast', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    let shouldFailSecondChat = true;
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'chat-2' && shouldFailSecondChat) {
          throw new Error('MAX send failed');
        }
        return {
          messageId: `mid-${chatId}-${shouldFailSecondChat ? 'first' : 'retry'}`,
          url: null,
        };
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
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-1',
        title: 'Чат 1',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    shouldFailSecondChat = false;
    const result = await broadcastRuntime(service).retryManagedBroadcast('chat-1', 'broadcast-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.failedChats).toBe(0);
    expect(result.deliveredChats).toBe(2);
    expect(result.canRetry).toBe(false);
  });

  it('blocks cancellation while a fresh managed broadcast send is in flight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });

    const serviceRef: { current?: AdminService } = {};
    let cancelError: unknown = null;
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async () => {
        try {
          await serviceRef.current!.cancelManagedBroadcast('chat-1', 'broadcast-1', {
            userId: 'admin-1',
            username: null,
            displayName: null,
            chatTitle: null,
          });
        } catch (error: unknown) {
          cancelError = error;
        }
        return { messageId: 'mid-chat-1', url: null };
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
    serviceRef.current = service;

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:59:00.000Z'),
      ['ACTIVE'],
    );
    const current = await prisma.managedBroadcast.findUnique({
      where: { id: 'broadcast-1' },
    });

    expect(cancelError).toMatchObject({
      message: 'Автопостинг сейчас отправляется. Дождитесь завершения текущей попытки.',
    });
    expect(result.status).toBe('COMPLETED');
    expect(current).toEqual(
      expect.objectContaining({
        id: 'broadcast-1',
        status: 'COMPLETED',
        nextSendAt: null,
        lockedAt: null,
      }),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: 'SENT',
          remoteMessageId: 'mid-chat-1',
        }),
      ]),
    );
  });

  it('heartbeats the broadcast lock during long sequential fanout', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Длинная рассылка',
        textFormat: 'plain',
        applyToAllChats: true,
        targetChatIds: ['chat-1', 'chat-2', 'chat-3'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: ['chat-1', 'chat-2', 'chat-3'].map((targetChatId) => ({
        broadcastId: 'broadcast-1',
        occurrenceIndex: 1,
        targetChatId,
        status: 'PENDING',
      })),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (chatId: string) => {
        jest.setSystemTime(new Date(Date.now() + 61_000));
        return { messageId: `mid-${chatId}`, url: null };
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:55:00.000Z'),
      ['ACTIVE'],
    );
    const heartbeatInstants = prisma.managedBroadcast.updateMany.mock.calls
      .map(([arg]) => (arg as { data?: { lockedAt?: unknown } }).data?.lockedAt)
      .filter((value): value is Date => value instanceof Date)
      .map((value) => value.toISOString());

    expect(result.status).toBe('COMPLETED');
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(3);
    expect(heartbeatInstants).toEqual(
      expect.arrayContaining(['2026-03-03T10:01:01.000Z', '2026-03-03T10:02:02.000Z']),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetChatId: 'chat-1', status: 'SENT', attemptCount: 1 }),
        expect.objectContaining({ targetChatId: 'chat-2', status: 'SENT', attemptCount: 1 }),
        expect.objectContaining({ targetChatId: 'chat-3', status: 'SENT', attemptCount: 1 }),
      ]),
    );
  });

  it('heartbeats the broadcast lock while retrying scheduled media uploads', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Фото',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: true,
        imageBase64: TINY_PNG_BASE64,
        imageMimeType: 'image/png',
        imageFileName: 'image.png',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });

    const uploadStarted = createDeferred<void>();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest
        .fn()
        .mockImplementationOnce(async () => {
          uploadStarted.resolve();
          jest.setSystemTime(new Date(Date.now() + 61_000));
          throw { response: { status: 429, data: { message: 'rate limit exceeded' } } };
        })
        .mockImplementationOnce(async () => {
          jest.setSystemTime(new Date(Date.now() + 61_000));
          return { token: 'image-token-1' };
        }),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-image-1',
        url: null,
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    const processPromise = (
      service as any
    ).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:55:00.000Z'),
      ['ACTIVE'],
    );
    await uploadStarted.promise;
    await waitForPendingFakeTimer();
    await jest.runOnlyPendingTimersAsync();
    const result = await processPromise;
    const heartbeatInstants = prisma.managedBroadcast.updateMany.mock.calls
      .map(([arg]) => (arg as { data?: { lockedAt?: unknown } }).data?.lockedAt)
      .filter((value): value is Date => value instanceof Date)
      .map((value) => value.toISOString());

    expect(result.status).toBe('COMPLETED');
    expect(maxClient.uploadImage).toHaveBeenCalledTimes(2);
    expect(heartbeatInstants).toEqual(
      expect.arrayContaining(['2026-03-03T10:01:01.000Z', '2026-03-03T10:02:03.000Z']),
    );
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENT',
        remoteMessageId: 'mid-image-1',
        lockedAt: null,
      }),
    );
  });

  it('does not let a stale worker finalize after another owner takes the broadcast lock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 2,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async () => {
        const row = await prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } });
        await prisma.managedBroadcast.update({
          where: { id: 'broadcast-1' },
          data: {
            ...row,
            lockedAt: new Date('2026-03-03T10:10:00.000Z'),
            status: 'ACTIVE',
            nextSendAt: new Date('2026-03-03T10:10:00.000Z'),
          },
        });
        return { messageId: 'mid-stale-owner', url: null };
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:55:00.000Z'),
      ['ACTIVE'],
    );
    const current = await prisma.managedBroadcast.findUnique({
      where: { id: 'broadcast-1' },
    });

    expect(result.status).toBe('ACTIVE');
    expect(current).toEqual(
      expect.objectContaining({
        status: 'ACTIVE',
        sentCount: 0,
        nextSendAt: new Date('2026-03-03T10:10:00.000Z'),
        lockedAt: new Date('2026-03-03T10:10:00.000Z'),
      }),
    );
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENT',
        remoteMessageId: 'mid-stale-owner',
      }),
    );
  });

  it('uses cached-first managed chat targets for mass broadcast', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (chatId: string) => ({
        messageId: `mid-${chatId}`,
        url: null,
      })),
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
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };
    const massTargetsSpy = jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    const result = await broadcastRuntime(service).sendBroadcast('chat-1', actor, {
      text: 'Напоминание',
      textFormat: 'plain',
      applyToAllChats: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    });

    expect(massTargetsSpy).toHaveBeenCalledWith(actor, { discoveryMode: 'cached-first' });
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      2,
      'chat-2',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-2' } },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(result.targetChats).toBe(2);
    expect(result.sentChats).toBe(2);
    expect(result.failedChats).toBe(0);
    expect(result.scheduleId).toBe('broadcast-1');
  });

  it('stores the selected author bot id on each managed broadcast delivery', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockImplementation(async (chatId: string) => ({
        messageId: `mid-${chatId}`,
        url: null,
      })),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-3',
        title: 'Чат 3',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);
    jest
      .spyOn(service as any, 'resolveDeliveryBotAssignment')
      .mockImplementation(async (chatId: unknown) => {
        const normalizedChatId = String(chatId);
        const botIdsByChatId: Record<string, string> = {
          'chat-1': 'bot-1',
          'chat-2': 'bot-3',
          'chat-3': 'bot-6',
        };
        return botIdsByChatId[normalizedChatId];
      });

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.sentChats).toBe(3);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetChatId: 'chat-1',
          botId: 'bot-1',
          status: 'SENT',
          remoteMessageId: 'mid-chat-1',
        }),
        expect.objectContaining({
          targetChatId: 'chat-2',
          botId: 'bot-3',
          status: 'SENT',
          remoteMessageId: 'mid-chat-2',
        }),
        expect.objectContaining({
          targetChatId: 'chat-3',
          botId: 'bot-6',
          status: 'SENT',
          remoteMessageId: 'mid-chat-3',
        }),
      ]),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      2,
      'chat-2',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-2' } },
      expect.objectContaining({ botId: 'bot-3' }),
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      3,
      'chat-3',
      'Напоминание',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-3' } },
      expect.objectContaining({ botId: 'bot-6' }),
    );
  });

  it('routes managed broadcast delivery through the active alternate instead of a stale primary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      primaryBotId: 'draining-primary-bot',
      botId: 'draining-primary-bot',
    });
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-broadcast-active-alternate-1',
        url: null,
      }),
    };
    const maxBotLinkService = createAdminMaxBotLinkMock({
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'draining-primary-bot',
        botId: 'active-alternate-bot',
        candidateBotIds: ['active-alternate-bot'],
        reason: 'alternate_confirmed',
      }),
      resolveBotIdForSend: jest.fn().mockResolvedValue('draining-primary-bot'),
      resolveBotId: jest.fn().mockResolvedValue('draining-primary-bot'),
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

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Маршрут через активного бота',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['chat-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.sentChats).toBe(1);
    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'chat-1',
    });
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      'Маршрут через активного бота',
      { marketplacePublication: { purpose: 'PUBLICATION', entityId: 'chat-1' } },
      expect.objectContaining({
        botId: 'active-alternate-bot',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        targetChatId: 'chat-1',
        botId: 'active-alternate-bot',
        status: 'SENT',
        remoteMessageId: 'mid-broadcast-active-alternate-1',
      }),
    );
  });

  it('dispatches managed broadcasts through the routed publication ledger with a bot-independent key', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn(),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const prepared = await request.prepareAttempt({ botId: 'dispatch-bot-2', job: {} });
        request.onDispatchAttempt({ botId: 'dispatch-bot-2', job: { ...prepared } });
        return {
          messageId: 'mid-routed-broadcast-1',
          url: 'https://max.ru/chats/chat-1/messages/mid-routed-broadcast-1',
          botId: 'dispatch-bot-2',
          candidateBotIds: ['route-bot-1', 'dispatch-bot-2'],
          routingVersion: 12,
        };
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    (service as any).maxRoutedPublicationService = maxRoutedPublicationService;

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Durable routed broadcast',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['chat-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.sentChats).toBe(1);
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'chat-1',
        logicalIdempotencyKey: expect.stringMatching(
          /^managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:legacy-/u,
        ),
        text: 'Durable routed broadcast',
        trafficClass: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    const logicalIdempotencyKey = maxRoutedPublicationService.publish.mock.calls[0]?.[0]
      .logicalIdempotencyKey as string;
    expect(logicalIdempotencyKey).not.toContain('dispatch-bot-2');
    expect(logicalIdempotencyKey).not.toContain(deliveries[0]?.id ?? 'delivery-id');
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        targetChatId: 'chat-1',
        botId: 'dispatch-bot-2',
        status: 'SENT',
        remoteMessageId: 'mid-routed-broadcast-1',
      }),
    );
  });

  it('fails closed in production when the routed publication service is unavailable', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prisma = createPrismaMock();
      wireManagedBroadcastDeliveryStore(prisma);
      const maxClient = {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        sendMessageImmediateWithId: jest.fn(),
      };
      const service = createAdminServiceFixture(
        prisma as never,
        maxClient as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );

      await broadcastRuntime(service).sendBroadcast(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Production route fence',
          textFormat: 'plain',
          targetMode: 'current',
          targetChatIds: ['chat-1'],
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
          sendAt: null,
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
      );

      expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
      await expect(
        prisma.managedBroadcast.findUnique({ where: { id: 'broadcast-1' } }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'FAILED',
          lastError: 'Routed MAX publication service is required for production managed broadcasts',
        }),
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('sends a chat broadcast only to selected chats and dedupes target ids', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
      clearManagedEntitiesRefreshCursor: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
      createChatSummaryFixture({
        id: 'chat-3',
        title: 'Чат 3',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Точный охват',
        textFormat: 'plain',
        targetMode: 'selected',
        targetChatIds: ['chat-2', 'chat-2', 'chat-3'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          applyToAllChats: false,
          targetChatIds: ['chat-2', 'chat-3'],
        }),
      }),
    );
    expect(result.targetChats).toBe(2);
    expect(result.sentChats).toBe(0);
    expect(result.failedChats).toBe(0);
    expect(result.scheduleId).toBe('broadcast-1');
  });

  it('rejects selected chat broadcasts with unavailable target ids', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
      clearManagedEntitiesRefreshCursor: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'listChatsForMassBroadcast').mockResolvedValue([
      createChatSummaryFixture({
        id: 'chat-2',
        title: 'Чат 2',
        createdAt: '2026-03-01T00:00:00.000Z',
        entityType: 'chat',
      }),
    ]);

    await expect(
      broadcastRuntime(service).sendBroadcast(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Точный охват',
          textFormat: 'plain',
          targetMode: 'selected',
          targetChatIds: ['chat-404'],
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
          sendAt: null,
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
      ),
    ).rejects.toThrow('Некоторые выбранные чаты больше недоступны. Откройте список заново.');

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('finalizes interrupted deliveries with stored message ids without duplicate resend', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Процесс оборвался после отправки.',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENDING',
        },
      ],
    });
    deliveries[0].status = 'SENDING';
    deliveries[0].remoteMessageId = 'mid-broadcast-1';
    deliveries[0].sentAt = new Date('2026-03-03T10:00:00.000Z');
    deliveries[0].lockedAt = new Date('2026-03-03T09:54:30.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn(),
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

    const result = await broadcastRuntime(service).retryManagedBroadcast('chat-1', 'broadcast-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(result.status).toBe('COMPLETED');
    expect(result.deliveredChats).toBe(1);
    expect(result.failedChats).toBe(0);
    expect(result.pendingChats).toBe(0);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'RETRY_BROADCAST_SCHEDULE',
        payload: expect.objectContaining({
          broadcastId: 'broadcast-1',
          reconciledWithoutResend: true,
        }),
      }),
    });
  });

  it('keeps the routed managed-broadcast SEND key stable after delivery row recreation', async () => {
    const { actionKey, broadcast, runtime } = await createRoutedManagedBroadcastRecoveryHarness();

    const recreatedDelivery = {
      id: 'delivery-after-recreate',
      targetChatId: 'chat-1',
    };
    const recreatedActionKey = runtime.buildManagedBroadcastDeliveryActionKey(
      broadcast,
      1,
      recreatedDelivery.targetChatId,
    );
    const editedContentKey = runtime.buildManagedBroadcastDeliveryActionKey(
      { ...broadcast, text: 'Changed content' },
      1,
      recreatedDelivery.targetChatId,
    );

    expect(recreatedActionKey).toBe(actionKey);
    expect(recreatedActionKey).not.toContain('delivery-before-recreate');
    expect(recreatedActionKey).not.toContain(recreatedDelivery.id);
    expect(editedContentKey).not.toBe(actionKey);
  });

  it('refuses calendar overwrite when it would discard a protected delivery', async () => {
    const { deliveries, prisma, runtime } = await createRoutedManagedBroadcastRecoveryHarness();

    await expect(
      runtime.assertManagedBroadcastCalendarDeliveriesCanBeDiscarded(prisma, 'broadcast-1', 1),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BROADCAST_SLOT_DELIVERY_PROTECTED' }),
    });
    expect(deliveries[0]?.status).toBe('SENDING');
  });

  it('returns stale routed SENDING delivery to PENDING when no dispatch ledger exists', async () => {
    const { deliveries, runtime } = await createRoutedManagedBroadcastRecoveryHarness();

    await runtime.reconcileRoutedManagedBroadcastSendingDeliveries('broadcast-1', 1);

    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'PENDING',
        remoteMessageId: null,
        lockedAt: null,
        lockToken: null,
      }),
    );
  });

  it('quarantines stale routed SENDING delivery with an unresolved dispatch claim', async () => {
    const { actionKey, deliveries, ledgerFindMany, runtime } =
      await createRoutedManagedBroadcastRecoveryHarness();
    ledgerFindMany.mockResolvedValue([
      {
        jobId: actionKey,
        remoteMessageId: null,
        dispatchToken: 'dispatch-token-1',
        dispatchStartedAt: new Date('2026-03-03T09:50:30.000Z'),
        dispatchBotId: 'bot-2',
        ambiguous: false,
        terminal: false,
        lastError: null,
        completedAt: null,
        metadata: null,
      },
    ]);

    await runtime.reconcileRoutedManagedBroadcastSendingDeliveries('broadcast-1', 1);

    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'AMBIGUOUS',
        remoteMessageId: null,
        lockedAt: null,
        lockToken: null,
      }),
    );
  });

  it('blocks broadcast edits when stale recovery finds an unresolved routed SEND', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));
    const { actionKey, deliveries, ledgerFindMany, prisma, service } =
      await createRoutedManagedBroadcastRecoveryHarness();
    ledgerFindMany.mockResolvedValue([
      {
        jobId: actionKey,
        remoteMessageId: null,
        dispatchToken: 'dispatch-token-1',
        dispatchStartedAt: new Date('2026-03-03T09:50:30.000Z'),
        dispatchBotId: 'bot-2',
        ambiguous: false,
        terminal: false,
        lastError: null,
        completedAt: null,
        metadata: null,
      },
    ]);

    await expect(
      broadcastRuntime(service).updateManagedBroadcast(
        'chat-1',
        'broadcast-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Edited content',
          textFormat: 'plain',
          targetMode: 'current',
          targetChatIds: ['chat-1'],
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
          sendAt: '2026-03-03T12:00:00.000Z',
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
      ),
    ).rejects.toThrow('имеет незавершённую или неоднозначную доставку');

    expect(deliveries[0]?.status).toBe('AMBIGUOUS');
    expect(prisma.managedBroadcastDelivery.deleteMany).not.toHaveBeenCalled();
  });

  it('hydrates stale routed SENDING delivery from a completed ledger without resend', async () => {
    const { actionKey, deliveries, ledgerFindMany, prisma, runtime } =
      await createRoutedManagedBroadcastRecoveryHarness();
    ledgerFindMany.mockResolvedValue([
      {
        jobId: actionKey,
        remoteMessageId: 'mid-ledger-recovered-1',
        dispatchToken: 'dispatch-token-1',
        dispatchStartedAt: new Date('2026-03-03T09:50:30.000Z'),
        dispatchBotId: 'bot-3',
        ambiguous: false,
        terminal: true,
        lastError: null,
        completedAt: new Date('2026-03-03T09:50:31.000Z'),
        metadata: {
          ledgerContext: {
            managedBroadcast: {
              commentDialogReference: {
                entityType: 'chat',
                threadId: 'thread-ledger-1',
                includeCommentsButton: true,
                includeSuggestButton: false,
                suggestButtonText: null,
                customButtons: [{ text: 'Открыть прайс', url: 'https://max.ru/pricelist' }],
                suggestionEntryMode: null,
                botId: 'bot-3',
              },
            },
          },
        },
      },
    ]);

    await runtime.reconcileRoutedManagedBroadcastSendingDeliveries('broadcast-1', 1);

    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENT',
        botId: 'bot-3',
        remoteMessageId: 'mid-ledger-recovered-1',
        sentAt: new Date('2026-03-03T09:50:31.000Z'),
        lockedAt: null,
        lockToken: null,
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'AUTO_ATTACH_CHAT_COMMENTS',
        payload: expect.objectContaining({
          messageId: 'mid-ledger-recovered-1',
          threadId: 'thread-ledger-1',
          botId: 'bot-3',
          managedBroadcastSource: 'ledger_recovery',
          customButtons: [{ text: 'Открыть прайс', url: 'https://max.ru/pricelist' }],
        }),
      }),
    });
  });

  it('keeps a sent scheduled delivery finalized when comment audit recording fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    prisma.chatSettings.upsert.mockResolvedValue({
      chatId: 'chat-1',
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: true,
    });
    prisma.auditLog.create.mockRejectedValueOnce(new Error('audit is temporarily unavailable'));
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Объявление с обсуждением',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'ACTIVE',
        lastError: null,
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'PENDING',
        },
      ],
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-comments-1',
        url: 'https://max.ru/chats/chat-1/message/mid-chat-comments-1',
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await (service as any).managedBroadcastRuntime.processManagedBroadcastOccurrence(
      'broadcast-1',
      'scheduled',
      new Date('2026-03-03T09:55:00.000Z'),
      ['ACTIVE'],
    );

    expect(result.status).toBe('COMPLETED');
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENT',
        sentAt: new Date('2026-03-03T10:00:00.000Z'),
        remoteMessageId: 'mid-chat-comments-1',
        lockedAt: null,
        lastError: null,
      }),
    );
  });

  it('blocks manual retry while a managed broadcast delivery is freshly in flight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    const deliveries = wireManagedBroadcastDeliveryStore(prisma);
    await prisma.managedBroadcast.create({
      data: {
        id: 'broadcast-1',
        sourceChatId: 'chat-1',
        entityType: 'CHAT',
        actorUserId: 'admin-1',
        text: 'Напоминание',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['chat-1'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'legacy',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-03-03T10:00:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: 'FAILED',
        lastError: 'Процесс отправки ещё идёт.',
        lockedAt: null,
      },
    });
    await prisma.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: 'SENDING',
        },
      ],
    });
    deliveries[0].status = 'SENDING';
    deliveries[0].remoteMessageId = null;
    deliveries[0].lockedAt = new Date('2026-03-03T09:59:30.000Z');

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn(),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    await expect(
      broadcastRuntime(service).retryManagedBroadcast('chat-1', 'broadcast-1', {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      }),
    ).rejects.toThrow('Автопостинг сейчас отправляется. Дождитесь завершения текущей попытки.');

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(deliveries[0]).toEqual(
      expect.objectContaining({
        status: 'SENDING',
        lockedAt: new Date('2026-03-03T09:59:30.000Z'),
      }),
    );
  });

  it('retries calendar slot reservation when another broadcast takes the slot concurrently', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.managedBroadcastOccurrence.createMany
      .mockRejectedValueOnce({
        code: 'P2002',
        meta: {
          target: 'managed_broadcast_occurrences_slot_key',
        },
      })
      .mockResolvedValue({ count: 1 });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
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

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Календарный автопостинг',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(prisma.managedBroadcastOccurrence.createMany).toHaveBeenCalledTimes(2);
    expect(result.scheduledSlots).toEqual(['2026-03-03T12:00:00.000Z']);
  });

  it('releases stale idempotency claims before accepting a repeated managed broadcast request', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:10:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.managedBroadcastIdempotencyRecord.create.mockImplementationOnce(
      async ({ data }: { data: Record<string, unknown> }) => {
        prisma.managedBroadcastIdempotencyRecord.findUnique.mockResolvedValueOnce({
          id: 'broadcast-idempotency-1',
          requestId: 'repeat123',
          requestHash: data.requestHash,
          sourceChatId: 'chat-1',
          entityType: 'CHAT',
          actorUserId: 'admin-1',
          source: 'miniapp',
          broadcastId: null,
          result: null,
          createdAt: new Date('2026-03-03T10:00:00.000Z'),
          updatedAt: new Date('2026-03-03T10:00:00.000Z'),
        });
        throw { code: 'P2002' };
      },
    );
    prisma.managedBroadcastIdempotencyRecord.create.mockImplementationOnce(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'broadcast-idempotency-2',
        ...data,
        broadcastId: null,
        result: null,
        createdAt: new Date('2026-03-03T10:10:00.000Z'),
        updatedAt: new Date('2026-03-03T10:10:00.000Z'),
      }),
    );
    prisma.managedBroadcastIdempotencyRecord.deleteMany.mockResolvedValueOnce({ count: 1 });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-1',
        url: null,
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        requestId: 'repeat123',
        text: 'Напоминание',
        textFormat: 'plain',
        targetMode: 'current',
        targetChatIds: ['chat-1'],
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.sentChats).toBe(1);
    expect(prisma.managedBroadcastIdempotencyRecord.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'broadcast-idempotency-1',
          broadcastId: null,
          updatedAt: { lte: new Date('2026-03-03T10:05:00.000Z') },
        }),
      }),
    );
    expect(prisma.managedBroadcastIdempotencyRecord.create).toHaveBeenCalledTimes(2);
  });

  it('adds the system comments button for chat broadcasts when the broadcast toggle is enabled', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.upsert.mockResolvedValue({
      chatId: 'chat-1',
      commentsEnabled: true,
      commentsAdminsEnabled: false,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: true,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const buttons = await (
      service as unknown as Pick<AdminServicePrivateAccess, 'resolveBroadcastButtons'>
    ).resolveBroadcastButtons('chat-1', 'chat', {
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      includeCustomButton: false,
      customButtonText: '',
      customButtonUrl: '',
    });

    const commentsButton = buttons[0]?.[0];
    expect(buttons).toMatchObject([[{ text: '💬 Комментарии · 0', type: 'link' }]]);
    expect(readButtonUrl(commentsButton)).toContain('https://max.ru/777000_bot?startapp=');
    const commentsToken = readDialogButtonToken(commentsButton);
    const commentsTokenPayload = decodeBase64UrlJson<{ d: string }>(commentsToken.slice(4));

    expect(commentsTokenPayload.d).toBeTruthy();
  });

  it.each([
    [false, false, []],
    [true, false, ['💬 Комментарии · 0']],
    [false, true, ['Предложить пост']],
    [true, true, ['💬 Комментарии · 0', 'Предложить пост']],
  ] as const)(
    'derives channel system buttons from comments=%s and suggestions=%s',
    async (commentsEnabled, postSuggestionsEnabled, expectedButtonTexts) => {
      const prisma = createPrismaMock();
      prisma.channelSettings.upsert.mockResolvedValue({
        chatId: 'channel-1',
        postSuggestionsEnabled,
        postSuggestionsEntryMode: 'BOT',
        postSuggestionsButtonText: 'Предложить пост',
        commentsEnabled,
      });

      const service = new AdminService(
        prisma as never,
        { getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']) } as never,
        createChatContextCacheMock() as never,
        createConfigMock() as never,
      );
      const options = {
        includeCustomButton: false,
        customButtonText: '',
        customButtonUrl: '',
      };

      const buttons = await (
        service as unknown as Pick<AdminServicePrivateAccess, 'resolveBroadcastButtons'>
      ).resolveBroadcastButtons('channel-1', 'channel', options);

      expect(buttons.map((row) => row[0]?.text)).toEqual(expectedButtonTexts);
    },
  );

  it('stores and queries chat dialog messages inside the thread encoded in the button token', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.upsert.mockResolvedValue({
      chatId: 'chat-1',
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: false,
      commentsChatBroadcastsEnabled: false,
    });
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: false,
        commentsChatBroadcastsEnabled: false,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const threadId = 'chat-thread-1';
    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', threadId) as string;
    const commentsTokenPayload = decodeBase64UrlJson<{ d: string }>(commentsToken.slice(4));

    await service.createChatDialogMessage(
      'chat-1',
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

    await service.getChatDialog(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    const commentAuditCall = prisma.auditLog.create.mock.calls.find(
      (call) => call?.[0]?.data?.action === 'CHANNEL_DIALOG_COMMENT',
    );
    const commentAuditPayload = commentAuditCall?.[0]?.data?.payload as { threadId?: unknown };
    expect(commentAuditPayload.threadId).toBe(commentsTokenPayload.d);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          action: 'CHANNEL_DIALOG_COMMENT',
          payload: {
            path: ['threadId'],
            equals: commentsTokenPayload.d,
          },
        }),
      }),
    );
  });

  it('updates the chat comments button counter after a new comment', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: false,
      }),
    );
    prisma.auditLog.count.mockResolvedValue(7);
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'chat-comments-ref-1',
        action: 'AUTO_ATTACH_CHAT_COMMENTS',
        payload: {
          threadId: 'chat-thread-counter',
          messageId: 'mid-admin-post-7',
          deliveryMode: 'reply_message',
          replyMessageId: 'mid-bot-reply-7',
        },
      },
    ]);
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-counter-1',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-20T08:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
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
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-counter') as string;

    await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Комментарий в чате',
      },
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'mid-bot-reply-7',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: '💬 Комментарии · 7', type: 'link' })]],
      }),
    );
  });

  it('accepts chat dialog tokens signed with the previous bot token', () => {
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

    const commentsToken = (
      legacyService as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-legacy') as string;
    const threadId = (
      service as unknown as Pick<AdminServicePrivateAccess, 'resolveChatDialogThreadId'>
    ).resolveChatDialogThreadId('chat-1', 'comments', commentsToken) as string | null;

    expect(threadId).toBe('chat-thread-legacy');
  });

  it('keeps avatar url on new chat comments and skips remote avatar hydration during dialog reads', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-2',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:05:00.000Z'),
    });
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'chat-comment-old-1',
        actorUserId: 'user-2',
        payload: {
          type: 'comments',
          text: 'Старый комментарий',
          authorDisplayName: 'Марина',
        },
        createdAt: new Date('2026-03-06T07:50:00.000Z'),
      },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-2',
            {
              userId: 'user-2',
              displayName: 'Марина',
              avatarUrl: 'https://cdn.max.ru/u/2/avatar-full.jpg',
            },
          ],
        ]),
      ),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const threadId = 'chat-thread-avatars';
    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', threadId) as string;

    const created = await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        avatarUrl: 'https://cdn.max.ru/u/1/photo.jpg',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Новый комментарий',
      },
    );

    const loaded = await service.getChatDialog(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    const commentAuditCall = prisma.auditLog.create.mock.calls.find(
      (call) => call?.[0]?.data?.action === 'CHANNEL_DIALOG_COMMENT',
    );
    expect(commentAuditCall?.[0]?.data?.payload).toEqual(
      expect.objectContaining({
        authorAvatarUrl: 'https://cdn.max.ru/u/1/photo.jpg',
      }),
    );
    expect(created.message.avatarUrl).toBe('https://cdn.max.ru/u/1/photo.jpg');
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(loaded.messages[0]).toMatchObject({
      authorUserId: 'user-2',
      avatarUrl: null,
    });
  });

  it('marks admin authors in chat dialog responses and immediate create results', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-admin-created',
      actorUserId: 'user-1',
      payload: {},
      createdAt: new Date('2026-03-06T08:05:00.000Z'),
    });
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'chat-comment-user-2',
        actorUserId: 'user-2',
        payload: {
          type: 'comments',
          text: 'Обычный комментарий',
          authorDisplayName: 'Марина',
        },
        createdAt: new Date('2026-03-06T07:59:00.000Z'),
      },
      {
        id: 'chat-comment-admin-1',
        actorUserId: 'admin-1',
        payload: {
          type: 'comments',
          text: 'Комментарий администратора',
          authorDisplayName: 'Александр',
        },
        createdAt: new Date('2026-03-06T07:54:00.000Z'),
      },
    ]);
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([
      { userId: 'admin-1' },
      { userId: 'user-1' },
    ]);

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1', 'user-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(new Map()),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = createChatContextCacheMock();

    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const threadId = 'chat-thread-admin-accent';
    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', threadId) as string;

    const created = await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Админ Алексей',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Комментарий от администратора',
      },
    );

    const loaded = await service.getChatDialog(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Админ Алексей',
        chatTitle: null,
      },
      'comments',
      commentsToken,
    );

    expect(created.message.isAdmin).toBe(true);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
    expect(loaded.messages[0]).toMatchObject({
      authorUserId: 'admin-1',
      isAdmin: true,
    });
    expect(loaded.messages[1]).toMatchObject({
      authorUserId: 'user-2',
      isAdmin: false,
    });
  });

  it('stores chat dialog notification mode for the current thread', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.dialogNotificationSubscription.findUnique.mockResolvedValue({
      mode: 'ALL',
      explicit: true,
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
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-notify-settings') as string;

    const result = await service.updateChatDialogNotifications(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        mode: 'all',
      },
    );

    expect(prisma.dialogNotificationSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType_chatId_threadId_userId: {
            entityType: 'CHAT',
            chatId: 'chat-1',
            threadId: 'chat-thread-notify-settings',
            userId: 'user-1',
          },
        },
        create: expect.objectContaining({
          entityType: 'CHAT',
          chatId: 'chat-1',
          threadId: 'chat-thread-notify-settings',
          userId: 'user-1',
          mode: 'ALL',
        }),
        update: {
          mode: 'ALL',
          explicit: true,
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      notificationSettings: expect.objectContaining({
        mode: 'all',
        canUseAll: true,
        scope: 'thread',
        thread: {
          mode: 'all',
          explicit: true,
        },
      }),
    });
  });

  it('stores channel-wide dialog notification mode outside the current thread', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.dialogNotificationPreference.findUnique.mockImplementation(async (args: any) =>
      args?.where?.userId_entityType_scope_targetKey?.scope === 'CHANNEL'
        ? {
            mode: 'ALL',
          }
        : null,
    );

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
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-channel-notify') as string;

    const result = await service.updateChatDialogNotifications(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        mode: 'all',
        scope: 'channel',
      },
    );

    expect(prisma.dialogNotificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_entityType_scope_targetKey: {
            userId: 'user-1',
            entityType: 'CHAT',
            scope: 'CHANNEL',
            targetKey: 'chat-1',
          },
        },
        create: expect.objectContaining({
          userId: 'user-1',
          entityType: 'CHAT',
          scope: 'CHANNEL',
          targetKey: 'chat-1',
          chatId: 'chat-1',
          mode: 'ALL',
        }),
        update: {
          chatId: 'chat-1',
          mode: 'ALL',
        },
      }),
    );
    expect(prisma.dialogNotificationSubscription.upsert).not.toHaveBeenCalled();
    expect(result.notificationSettings).toEqual(
      expect.objectContaining({
        mode: 'all',
        scope: 'channel',
        channel: {
          mode: 'all',
          explicit: true,
        },
      }),
    );
  });

  it('stores channel-wide reply-only dialog notifications', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.dialogNotificationPreference.findUnique.mockImplementation(async (args: any) =>
      args?.where?.userId_entityType_scope_targetKey?.scope === 'CHANNEL'
        ? {
            mode: 'REPLIES',
          }
        : null,
    );

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
      'chat',
      'chat-1',
      'comments',
      'chat-thread-channel-reply-notify',
    ) as string;

    const result = await service.updateChatDialogNotifications(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        mode: 'replies',
        scope: 'channel',
      },
    );

    expect(prisma.dialogNotificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_entityType_scope_targetKey: {
            userId: 'user-1',
            entityType: 'CHAT',
            scope: 'CHANNEL',
            targetKey: 'chat-1',
          },
        },
        create: expect.objectContaining({
          userId: 'user-1',
          entityType: 'CHAT',
          scope: 'CHANNEL',
          targetKey: 'chat-1',
          chatId: 'chat-1',
          mode: 'REPLIES',
        }),
        update: {
          chatId: 'chat-1',
          mode: 'REPLIES',
        },
      }),
    );
    expect(prisma.dialogNotificationSubscription.upsert).not.toHaveBeenCalled();
    expect(result.notificationSettings).toEqual(
      expect.objectContaining({
        mode: 'replies',
        scope: 'channel',
        channel: {
          mode: 'replies',
          explicit: true,
        },
      }),
    );
  });

  it('sends private notifications for comment replies and preserves explicit off subscriptions', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'chat-comment-parent-1',
      actorUserId: 'user-1',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-notify-replies',
        text: 'Первый комментарий',
        authorDisplayName: 'Марина',
      },
      createdAt: new Date('2026-03-06T08:00:00.000Z'),
    });
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-reply-1',
      actorUserId: 'user-2',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-notify-replies',
        text: 'Ответ с <тегом>',
        authorDisplayName: 'Иван',
      },
      createdAt: new Date('2026-03-06T08:05:00.000Z'),
    });
    prisma.dialogNotificationSubscription.findMany.mockResolvedValue([
      {
        userId: 'user-1',
        mode: 'REPLIES',
        explicit: true,
      },
      {
        userId: 'user-3',
        mode: 'ALL',
        explicit: true,
      },
      {
        userId: 'user-4',
        mode: 'OFF',
        explicit: true,
      },
      {
        userId: 'user-2',
        mode: 'ALL',
        explicit: true,
      },
    ]);
    prisma.auditLog.findMany.mockImplementation(async (args: any) => {
      if (args?.take === 5) {
        return [
          {
            action: 'AUTO_ATTACH_CHAT_COMMENTS',
            payload: {
              threadId: 'chat-thread-notify-replies',
              text: 'Первая строка поста <важно>\nВторая строка поста',
              publishedUrl: 'https://max.ru/chats/chat-1/message/bot-copy-1',
              deliveryMode: 'replace_with_bot_message',
              replacementMessageId: 'mid-bot-copy-1',
            },
          },
        ];
      }

      return [];
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateToUser: jest.fn().mockResolvedValue({
        messageId: 'private-notification-1',
        url: null,
      }),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue(
        createManagedEntityHeaderFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          entityType: 'chat',
          link: 'https://max.ru/chats/chat-1#comments',
        }),
      ),
    });
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-notify-replies') as string;

    await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-2',
        username: 'ivan',
        displayName: 'Иван <script>',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Ответ с <тегом>',
        replyToMessageId: 'chat-comment-parent-1',
      },
    );
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(prisma.dialogNotificationSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: 'user-2',
          mode: 'REPLIES',
        }),
        update: {},
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'user-1',
      expect.stringContaining('Вам ответили в комментариях'),
      expect.objectContaining({
        textFormat: 'html',
        buttons: [
          [expect.objectContaining({ text: 'Открыть комментарии' })],
          [
            expect.objectContaining({
              text: 'Открыть пост',
              url: 'https://max.ru/chats/chat-1/message/bot-copy-1',
            }),
          ],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'background',
        sourceTag: 'comment_notification',
        botId: '777000_bot',
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'user-3',
      expect.stringContaining('Новый комментарий в обсуждении'),
      expect.any(Object),
      expect.any(Object),
    );
    const [replyUserId, replyText, replyOptions] =
      maxClient.sendMessageImmediateToUser.mock.calls[0] ?? [];
    expect(replyUserId).toBe('user-1');
    expect(replyText).toContain('Чат: <a href="https://max.ru/chats/chat-1">Команда MAX</a>');
    expect(replyText).toContain('Пост: Первая строка поста &lt;важно&gt;');
    expect(replyText).toContain('<a href="max://user/user-2">Иван &lt;script&gt;</a>');
    expect(replyText).toContain('Комментарий: Ответ с &lt;тегом&gt;');
    expect(replyText).not.toContain('<a href="https://max.ru/777000_bot?startapp=');
    expect(replyText).not.toContain('>Открыть комментарии</a>');
    expect(replyText).not.toContain('>Открыть пост</a>');
    expect(replyOptions.buttons[0][0].url).toContain('https://max.ru/777000_bot?startapp=');
    expect(replyOptions.buttons[1][0].url).toBe('https://max.ru/chats/chat-1/message/bot-copy-1');
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalledWith(
      'user-2',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalledWith(
      'user-4',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('sends channel and all-channel comment notifications with narrow off overrides', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-global-1',
      actorUserId: 'author-1',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-global-notify',
        text: 'Глобальный комментарий',
        authorDisplayName: 'Автор',
      },
      createdAt: new Date('2026-03-06T08:05:00.000Z'),
    });
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'chat-comment-global-parent-1',
      actorUserId: 'global-replies-user',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-global-notify',
        text: 'Родительский комментарий',
      },
      createdAt: new Date('2026-03-06T08:00:00.000Z'),
    });
    prisma.dialogNotificationSubscription.findMany.mockResolvedValue([
      {
        userId: 'global-user',
        mode: 'REPLIES',
        explicit: false,
      },
      {
        userId: 'thread-off-user',
        mode: 'OFF',
        explicit: true,
      },
    ]);
    prisma.dialogNotificationPreference.findMany.mockImplementation(async (args: any) => {
      const scope = args?.where?.scope;
      if (scope === 'CHANNEL') {
        return [
          {
            userId: 'channel-user',
            mode: 'ALL',
          },
          {
            userId: 'channel-off-user',
            mode: 'OFF',
          },
          {
            userId: 'thread-off-user',
            mode: 'ALL',
          },
        ];
      }
      if (scope === 'ALL_CHANNELS') {
        return [
          {
            userId: 'global-user',
            mode: 'ALL',
          },
          {
            userId: 'channel-off-user',
            mode: 'ALL',
          },
          {
            userId: 'global-no-access-user',
            mode: 'ALL',
          },
          {
            userId: 'global-replies-user',
            mode: 'REPLIES',
          },
          {
            userId: 'global-replies-no-access-user',
            mode: 'REPLIES',
          },
        ];
      }
      return [];
    });
    (prisma as any).managedEntityAccessEdge = {
      findMany: jest.fn().mockResolvedValue([
        {
          userId: 'global-user',
          chatId: 'chat-1',
          botId: '777000_bot',
        },
        {
          userId: 'global-replies-user',
          chatId: 'chat-1',
          botId: '777000_bot',
        },
      ]),
    };
    (prisma as any).chatBotMembership = {
      findMany: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-1',
          botId: '777000_bot',
        },
      ]),
    };

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateToUser: jest.fn().mockResolvedValue({
        messageId: 'private-notification-1',
        url: null,
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-global-notify') as string;

    await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'author-1',
        username: 'author',
        displayName: 'Автор',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Глобальный комментарий',
        replyToMessageId: 'chat-comment-global-parent-1',
      },
    );
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledTimes(3);
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'channel-user',
      expect.stringContaining('Новый комментарий в обсуждении'),
      expect.any(Object),
      expect.any(Object),
    );
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'global-user',
      expect.stringContaining('Новый комментарий в обсуждении'),
      expect.any(Object),
      expect.any(Object),
    );
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'global-replies-user',
      expect.stringContaining('Вам ответили в комментариях'),
      expect.any(Object),
      expect.any(Object),
    );
    for (const blockedUserId of [
      'author-1',
      'thread-off-user',
      'channel-off-user',
      'global-no-access-user',
      'global-replies-no-access-user',
    ]) {
      expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalledWith(
        blockedUserId,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    }
  });

  it('lets global off override implicit reply auto-follow subscriptions', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'chat-comment-parent-global-off-1',
      actorUserId: 'reply-target-user',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-global-off',
        text: 'Родительский комментарий',
      },
      createdAt: new Date('2026-03-06T08:00:00.000Z'),
    });
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-global-off-reply-1',
      actorUserId: 'reply-author',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-global-off',
        text: 'Ответ',
        authorDisplayName: 'Автор',
      },
      createdAt: new Date('2026-03-06T08:05:00.000Z'),
    });
    prisma.dialogNotificationSubscription.findMany.mockResolvedValue([
      {
        userId: 'reply-target-user',
        mode: 'REPLIES',
        explicit: false,
      },
    ]);
    prisma.dialogNotificationPreference.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.scope !== 'ALL_CHANNELS') {
        return [];
      }
      return [
        {
          userId: 'reply-target-user',
          mode: 'OFF',
        },
      ];
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateToUser: jest.fn().mockResolvedValue({
        messageId: 'private-notification-1',
        url: null,
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-global-off') as string;

    await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'reply-author',
        username: 'author',
        displayName: 'Автор',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Ответ',
        replyToMessageId: 'chat-comment-parent-global-off-1',
      },
    );
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(prisma.dialogNotificationPreference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scope: 'ALL_CHANNELS',
          OR: [{ mode: 'ALL' }, { userId: 'reply-target-user' }],
        }),
      }),
    );
    expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
  });

  it('uses fallback reply messages for comment notification post buttons', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.create.mockResolvedValue({
      id: 'chat-comment-fallback-1',
      actorUserId: 'user-2',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-reply-fallback',
        text: 'Комментарий',
        authorDisplayName: 'Иван',
      },
      createdAt: new Date('2026-03-06T09:05:00.000Z'),
    });
    prisma.dialogNotificationSubscription.findMany.mockResolvedValue([
      {
        userId: 'user-1',
        mode: 'ALL',
      },
    ]);
    prisma.auditLog.findMany.mockImplementation(async (args: any) => {
      if (args?.take === 5) {
        return [
          {
            action: 'AUTO_ATTACH_CHAT_COMMENTS',
            payload: {
              threadId: 'chat-thread-reply-fallback',
              messageId: 'mid-original-post',
              replyMessageId: 'mid-fallback-reply',
              deliveryMode: 'reply_message',
            },
          },
        ];
      }

      return [];
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest
        .fn()
        .mockImplementation(async (messageId: string) =>
          messageId === 'mid-fallback-reply'
            ? 'https://max.ru/chats/chat-1/message/fallback-reply'
            : null,
        ),
      getMessageTextAsMarkdown: jest.fn().mockResolvedValue('Исходный пост\nВторая строка'),
      sendMessageImmediateToUser: jest.fn().mockResolvedValue({
        messageId: 'private-notification-1',
        url: null,
      }),
    };
    const chatContextCache = createChatContextCacheMock({
      getManagedEntityHeader: jest.fn().mockResolvedValue(
        createManagedEntityHeaderFixture({
          id: 'chat-1',
          title: 'Команда MAX',
          entityType: 'chat',
          link: 'https://max.ru/chats/chat-1',
        }),
      ),
    });
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    const commentsToken = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildEntityDialogToken'>
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-reply-fallback') as string;

    await service.createChatDialogMessage(
      'chat-1',
      {
        userId: 'user-2',
        username: 'ivan',
        displayName: 'Иван',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Комментарий',
      },
    );
    await flushAsyncTasks();
    await flushAsyncTasks();

    expect(maxClient.resolveMessageLink).toHaveBeenNthCalledWith(
      1,
      'mid-original-post',
      expect.objectContaining({
        sourceTag: 'comment_notification',
      }),
    );
    expect(maxClient.resolveMessageLink).toHaveBeenNthCalledWith(
      2,
      'mid-fallback-reply',
      expect.objectContaining({
        sourceTag: 'comment_notification',
      }),
    );
    expect(maxClient.getMessageTextAsMarkdown).toHaveBeenCalledWith(
      'mid-original-post',
      expect.objectContaining({
        sourceTag: 'comment_notification',
      }),
    );
    const [, notificationText, notificationOptions] =
      maxClient.sendMessageImmediateToUser.mock.calls[0] ?? [];
    expect(notificationText).toContain('Пост: Исходный пост');
    expect(notificationOptions.buttons[1][0]).toMatchObject({
      text: 'Открыть пост',
      url: 'https://max.ru/chats/chat-1/message/fallback-reply',
    });
  });

  it('uses a deterministic channel post link when MAX cannot resolve edited auto-attach links', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Еуг',
      entityType: 'CHANNEL',
    });
    prisma.channelSettings.findUnique.mockResolvedValue(
      channelSettingsSchema.parse({
        commentsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'channel-comment-parent-1',
      actorUserId: 'user-1',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-edited-post',
        text: 'Первый комментарий',
        authorDisplayName: 'Марина',
      },
      createdAt: new Date('2026-03-06T10:00:00.000Z'),
    });
    prisma.auditLog.create.mockResolvedValue({
      id: 'channel-comment-reply-1',
      actorUserId: 'user-2',
      payload: {
        type: 'comments',
        threadId: 'channel-thread-edited-post',
        text: 'Ответ',
        authorDisplayName: 'Иван',
      },
      createdAt: new Date('2026-03-06T10:05:00.000Z'),
    });
    prisma.dialogNotificationSubscription.findMany.mockResolvedValue([
      {
        userId: 'user-1',
        mode: 'REPLIES',
      },
    ]);
    prisma.auditLog.findMany.mockImplementation(async (args: any) => {
      if (args?.take === 5) {
        return [
          {
            action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
            payload: {
              threadId: 'channel-thread-edited-post',
              messageId: 'mid.ffffbcd63f2177f9019e85148a7a738f',
              deliveryMode: 'edit_message',
              includeCommentsButton: true,
              includeSuggestButton: true,
            },
          },
        ];
      }

      return [];
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
      getMessageTextAsMarkdown: jest.fn().mockResolvedValue(null),
      sendMessageImmediateToUser: jest.fn().mockResolvedValue({
        messageId: 'private-notification-1',
        url: null,
      }),
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
      'channel-thread-edited-post',
    ) as string;

    await service.createChannelDialogMessage(
      'channel-1',
      {
        userId: 'user-2',
        username: 'ivan',
        displayName: 'Иван',
        chatTitle: null,
      },
      'comments',
      {
        token: commentsToken,
        text: 'Ответ',
        replyToMessageId: 'channel-comment-parent-1',
      },
    );
    await flushAsyncTasks();
    await flushAsyncTasks();

    const fallbackUrl =
      'https://max.ru/chats/channel-1/message/mid.ffffbcd63f2177f9019e85148a7a738f';
    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith(
      'mid.ffffbcd63f2177f9019e85148a7a738f',
      expect.objectContaining({
        sourceTag: 'comment_notification',
      }),
    );
    const [, notificationText, notificationOptions] =
      maxClient.sendMessageImmediateToUser.mock.calls[0] ?? [];
    expect(notificationText).toContain(`Пост: <a href="${fallbackUrl}">Открыть пост</a>`);
    expect(notificationOptions.buttons[1][0]).toMatchObject({
      text: 'Открыть пост',
      url: fallbackUrl,
    });
  });

  it('renders linked channel titles in private comment notifications', () => {
    const service = new AdminService(
      createPrismaMock() as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const text = (
      service as unknown as Pick<AdminServicePrivateAccess, 'buildCommentDialogNotificationText'>
    ).buildCommentDialogNotificationText({
      kind: 'all',
      entityType: 'channel',
      entityTitle: 'Новости <MAX>',
      entityLink: 'https://max.ru/channels/news-max?ref=bot',
      authorUserId: 'user-2',
      authorDisplayName: 'Иван',
      preview: 'Комментарий',
      postPreview: null,
      dialogUrl: 'https://max.ru/777000_bot?startapp=comments',
      postUrl: null,
    });

    expect(text).toContain(
      'Канал: <a href="https://max.ru/channels/news-max?ref=bot">Новости &lt;MAX&gt;</a>',
    );
  });

  it('allows the author to delete their own chat comment', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue(
      chatSettingsSchema.parse({
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      }),
    );
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'chat-comment-delete-1',
      actorUserId: 'user-1',
      payload: {
        type: 'comments',
        threadId: 'chat-thread-delete',
        text: 'Комментарий для удаления',
      },
      createdAt: new Date('2026-03-21T11:00:00.000Z'),
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
    ).buildEntityDialogToken('chat', 'chat-1', 'comments', 'chat-thread-delete') as string;

    const result = await service.deleteChatDialogMessage(
      'chat-1',
      {
        userId: 'user-1',
        username: 'user1',
        displayName: 'Пользователь',
        chatTitle: null,
      },
      'comments',
      'chat-comment-delete-1',
      {
        token: commentsToken,
      },
    );

    expect(prisma.auditLog.delete).toHaveBeenCalledWith({
      where: {
        id: 'chat-comment-delete-1',
      },
    });
    expect(result).toEqual({
      ok: true,
      deletedMessageId: 'chat-comment-delete-1',
    });
  });
});

describe('AdminService.sendChannelBroadcast', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends immediate broadcast to channel with button and image', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: 'Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-image-1',
        url: 'https://max.ru/chats/channel-1/message/mid-channel-image-1',
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

    const result = await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Префикс **Новый выпуск\n\nВторая строка**',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: true,
        buttonUrl: 'https://max.ru/channel/maxim',
        buttonText: 'Открыть выпуск',
        imageEnabled: true,
        imageBase64: TINY_JPEG_BASE64,
        imageMimeType: 'image/jpeg',
        imageFileName: 'cover.jpg',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'cover.jpg',
      'image/jpeg',
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'channel-1',
      'Префикс <strong>Новый выпуск</strong>\n\n<strong>Вторая строка</strong>',
      {
        marketplacePublication: { purpose: 'PUBLICATION', entityId: 'channel-1' },
        textFormat: 'html',
        buttons: [[{ text: 'Открыть выпуск', type: 'link', url: 'https://max.ru/channel/maxim' }]],
        imagePayload: { token: 'upload-token-channel-1' },
      },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(0);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'SCHEDULE_BROADCAST',
        payload: expect.objectContaining({
          entityType: 'channel',
          applyToAllChats: false,
          broadcastId: 'broadcast-1',
          sentCount: 1,
        }),
      }),
    });
  });

  it('records channel broadcast comments button target after immediate delivery', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsEntryMode: 'MINIAPP',
      postSuggestionsButtonText: 'Предложить пост',
      commentsEnabled: true,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-comments-1',
        url: 'https://max.ru/chats/channel-1/message/mid-channel-comments-1',
      }),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Пост с обсуждением',
        textFormat: 'plain',
        applyToAllChats: false,
        buttons: [{ text: 'Заказать рекламу', url: 'https://max.ru/advertiser' }],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.sentChats).toBe(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'channel-1',
      'Пост с обсуждением',
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: '💬 Комментарии · 0' })],
          [{ type: 'link', text: 'Заказать рекламу', url: 'https://max.ru/advertiser' }],
        ],
      }),
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          messageId: 'mid-channel-comments-1',
          threadId: expect.any(String),
          includeCommentsButton: true,
          includeSuggestButton: false,
          suggestionEntryMode: 'MINIAPP',
          source: 'managed_broadcast',
          managedBroadcastSource: 'immediate',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          text: 'Пост с обсуждением',
          publishedUrl: 'https://max.ru/chats/channel-1/message/mid-channel-comments-1',
          customButtons: [{ text: 'Заказать рекламу', url: 'https://max.ru/advertiser' }],
        }),
      }),
    });
  });

  it('sends immediate channel broadcast with image gallery attachments', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: 'Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest
        .fn()
        .mockResolvedValueOnce({ token: 'upload-token-gallery-1' })
        .mockResolvedValueOnce({ token: 'upload-token-gallery-2' }),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-gallery-1',
        url: 'https://max.ru/chats/channel-1/message/mid-channel-gallery-1',
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Галерея недели',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        images: [
          {
            base64: TINY_JPEG_BASE64,
            mimeType: 'image/jpeg',
            fileName: 'gallery-1.jpg',
          },
          {
            base64: TINY_PNG_BASE64,
            mimeType: 'image/png',
            fileName: 'gallery-2.png',
          },
        ],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.uploadImage).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'channel-1',
      'Галерея недели',
      {
        marketplacePublication: { purpose: 'PUBLICATION', entityId: 'channel-1' },
        attachments: [
          {
            type: 'image',
            payload: { token: 'upload-token-gallery-1' },
          },
          {
            type: 'image',
            payload: { token: 'upload-token-gallery-2' },
          },
        ],
      },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(0);
  });

  it('sends immediate broadcast to channel with a video attachment', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: 'Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-video-1',
        url: 'https://max.ru/chats/channel-1/message/mid-channel-video-1',
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        mediaType: 'video',
        mediaPayload: { token: 'video-token-1' },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'announce.mp4',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'channel-1',
      ' ',
      {
        marketplacePublication: { purpose: 'PUBLICATION', entityId: 'channel-1' },
        attachments: [{ type: 'video', payload: { token: 'video-token-1' } }],
      },
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(result.sentChats).toBe(1);
    expect(result.failedChats).toBe(0);
  });

  it('preserves markdown formatting when channel broadcast has no button', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-markdown-1',
        url: null,
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

    await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Новый выпуск** уже в [канале](https://max.ru/channel/maxim).\n\n  Второй абзац с  отступом',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'channel-1',
      '<strong>Новый выпуск</strong> уже в <a href="https://max.ru/channel/maxim">канале</a>.\n\n&nbsp;&nbsp;Второй абзац с&nbsp;&nbsp;отступом',
      channelPublicationTextOptions,
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
  });

  it('renders escaped markdown punctuation as literal text in channel broadcasts', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-escaped-markdown-1',
        url: null,
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

    await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Анонс** C\\+\\+ \\[beta\\] \\(v2\\) \\_raw\\_',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'channel-1',
      '<strong>Анонс</strong> C++ [beta] (v2) _raw_',
      channelPublicationTextOptions,
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
  });

  it('stores scheduled broadcast text without trimming surrounding whitespace', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-03T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    wireManagedBroadcastOccurrenceStore(prisma, []);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
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

    await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '\n  **Новый автопостинг**\n\n  Второй абзац с  пробелом\n',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        text: '\n  **Новый автопостинг**\n\n  Второй абзац с  пробелом\n',
      }),
    });
  });

  it('publishes nested bold italic underline links in channel broadcasts', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-nested-markdown-1',
        url: null,
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

    await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'channel-1',
      '<a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a>',
      channelPublicationTextOptions,
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
  });

  it('publishes channel broadcast with system comments button in the first message', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: true,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValue({ messageId: 'mid-channel-system-comments-1', url: null }),
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
    jest.spyOn(service as any, 'resolveDeliveryBotAssignment').mockResolvedValue('channel-bot-2');

    await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Новый выпуск** уже в канале.',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    const [, messageText, options, dispatch] = maxClient.sendMessageImmediateWithId.mock.calls[0];
    expect(messageText).toBe('<strong>Новый выпуск</strong> уже в канале.');
    expect(dispatch).toEqual(
      expect.objectContaining({
        botId: 'channel-bot-2',
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(options).toMatchObject({
      textFormat: 'html',
      buttons: [
        [
          expect.objectContaining({
            text: '💬 Комментарии · 0',
            type: 'link',
            url: expect.stringContaining('https://max.ru/entry-bot?startapp='),
          }),
        ],
      ],
    });
    expect(String(options.buttons[0][0].url ?? '')).toContain('https://max.ru/entry-bot?startapp=');
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveContactIdSync).toHaveBeenCalledWith('channel-bot-2');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          messageId: 'mid-channel-system-comments-1',
          threadId: expect.any(String),
          includeCommentsButton: true,
          includeSuggestButton: false,
          source: 'managed_broadcast',
          managedBroadcastSource: 'immediate',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          botId: 'channel-bot-2',
        }),
      }),
    });
  });

  it('publishes channel broadcast with system suggestion button in the first message', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: true,
      postSuggestionsEntryMode: 'BOT',
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      uploadImage: jest.fn().mockResolvedValue({ token: 'upload-token-channel-1' }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-system-suggest-1',
        url: 'https://max.ru/chats/channel-1/message/mid-channel-system-suggest-1',
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

    await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Новый выпуск** уже в канале.',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    const [, messageText, options, dispatch] = maxClient.sendMessageImmediateWithId.mock.calls[0];
    expect(messageText).toBe('<strong>Новый выпуск</strong> уже в канале.');
    expect(dispatch).toEqual(
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(options).toMatchObject({
      textFormat: 'html',
      buttons: [[expect.objectContaining({ text: '📰 Предложить пост', type: 'link' })]],
    });
    const suggestStartParam = new URL(String(options.buttons[0][0].url ?? '')).searchParams.get(
      'start',
    );
    expect(suggestStartParam).toMatch(/^cds-/u);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        payload: expect.objectContaining({
          messageId: 'mid-channel-system-suggest-1',
          threadId: expect.any(String),
          includeCommentsButton: false,
          includeSuggestButton: true,
          suggestionEntryMode: 'BOT',
          suggestButtonText: '📰 Предложить пост',
          source: 'managed_broadcast',
          managedBroadcastSource: 'immediate',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          publishedUrl: 'https://max.ru/chats/channel-1/message/mid-channel-system-suggest-1',
        }),
      }),
    });
  });

  it('does not publish channel broadcast system buttons when both feature toggles are off', async () => {
    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'channel-1',
      title: 'Новости MAX',
      entityType: 'CHANNEL',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    prisma.channelSettings.upsert.mockResolvedValue({
      chatId: 'channel-1',
      postSuggestionsEnabled: false,
      postSuggestionsButtonText: '📰 Предложить пост',
      commentsEnabled: false,
      engagementPublishedMessageId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'mid-channel-no-system-buttons-1',
        url: null,
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await broadcastRuntime(service).sendChannelBroadcast(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: '**Новый выпуск** уже в канале.',
        textFormat: 'markdown',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: '',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    const [, , options] = maxClient.sendMessageImmediateWithId.mock.calls[0];
    expect(options).toEqual(channelPublicationTextOptions);
    expect(prisma.auditLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT',
        }),
      }),
    );
  });

  it('treats past slots from today as already sent for calendar broadcast scheduling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-18T18:30:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
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

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Ночной выпуск',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-18T07:00:00.000Z', '2026-03-18T20:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 2,
      },
    );

    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sentCount: 1,
          cycleCount: 2,
          nextSendAt: new Date('2026-03-18T20:00:00.000Z'),
          status: 'ACTIVE',
        }),
      }),
    );
    expect(prisma.managedBroadcastDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ occurrenceIndex: 2, targetChatId: 'chat-1' })],
      }),
    );
    expect(prisma.managedBroadcastOccurrence.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            occurrenceIndex: 2,
            scheduledAt: new Date('2026-03-18T20:00:00.000Z'),
          }),
        ],
      }),
    );
    expect(result.scheduledSlots).toEqual(['2026-03-18T20:00:00.000Z']);
    expect(result.scheduledOccurrences).toBe(1);
  });

  it('rejects calendar slots that are less than 30 seconds away', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-18T18:29:40.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
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
      broadcastRuntime(service).sendBroadcast(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          text: 'Слишком близкий слот',
          textFormat: 'plain',
          applyToAllChats: false,
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: 'Открыть',
          imageEnabled: false,
          imageBase64: '',
          imageMimeType: '',
          imageFileName: '',
          scheduleMode: 'calendar',
          scheduleTimezone: 'Europe/Moscow',
          scheduledSlots: ['2026-03-18T18:30:00.000Z'],
          sendAt: null,
          cycleEnabled: false,
          cycleEveryHours: 1,
          cycleCount: 1,
        },
      ),
    ).rejects.toThrow('Ближайший слот должен быть минимум через 30 секунд.');

    expect(prisma.managedBroadcast.create).not.toHaveBeenCalled();
  });

  it('validates calendar slots against local timezone step instead of UTC minutes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-18T10:00:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const service = createAdminServiceFixture(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        sendMessage: jest.fn(),
      } as never,
      { invalidate: jest.fn() } as never,
      createConfigMock() as never,
    );

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Полчасовой часовой пояс',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Asia/Kathmandu',
        scheduledSlots: ['2026-03-18T12:45:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      },
    );

    expect(result.scheduledSlots).toEqual(['2026-03-18T12:45:00.000Z']);
    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduleTimezone: 'Asia/Kathmandu',
          nextSendAt: new Date('2026-03-18T12:45:00.000Z'),
        }),
      }),
    );
  });

  it('rejects invalid calendar timezones and off-step slots', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-18T10:00:00.000Z'));

    const buildService = () =>
      createAdminServiceFixture(
        createPrismaMock() as never,
        {
          getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
          sendMessage: jest.fn(),
        } as never,
        { invalidate: jest.fn() } as never,
        createConfigMock() as never,
      );
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };
    const basePayload = {
      text: 'Некорректный слот',
      textFormat: 'plain' as const,
      applyToAllChats: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      scheduleMode: 'calendar' as const,
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };

    await expect(
      broadcastRuntime(buildService()).sendBroadcast('chat-1', actor, {
        ...basePayload,
        scheduleTimezone: 'Mars/Olympus',
        scheduledSlots: ['2026-03-18T12:00:00.000Z'],
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        scheduleTimezone: expect.objectContaining({
          _errors: expect.arrayContaining(['Некорректный часовой пояс.']),
        }),
      }),
    });

    await expect(
      broadcastRuntime(buildService()).sendBroadcast('chat-1', actor, {
        ...basePayload,
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-18T12:15:00.000Z'],
      }),
    ).rejects.toThrow('Слоты должны быть кратны 30 минутам.');
  });

  it('completes a calendar broadcast immediately when all selected slots for today are already past', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-18T18:30:00.000Z'));

    const prisma = createPrismaMock();
    wireManagedBroadcastDeliveryStore(prisma);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
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

    const result = await broadcastRuntime(service).sendBroadcast(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Поздний автопостинг',
        textFormat: 'plain',
        applyToAllChats: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        scheduledSlots: ['2026-03-18T07:00:00.000Z', '2026-03-18T15:00:00.000Z'],
        sendAt: null,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 2,
      },
    );

    expect(prisma.managedBroadcast.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sentCount: 2,
          cycleCount: 2,
          nextSendAt: null,
          status: 'COMPLETED',
        }),
      }),
    );
    expect(prisma.managedBroadcastOccurrence.createMany).not.toHaveBeenCalled();
    expect(result.scheduledSlots).toEqual([]);
    expect(result.nextSendAt).toBeNull();
    expect(result.scheduledOccurrences).toBe(0);
  });
});

describe('AdminService chat rules', () => {
  it('returns persisted chat rules draft with published metadata', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/123',
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn(),
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

    const result = await service.getRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result).toEqual({
      revision: '2026-03-09T10:00:00.000Z',
      text: 'Пишите по теме.',
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
      publishedMessageId: 'mid-rules-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/123',
      publishedAt: '2026-03-09T10:00:00.000Z',
    });
  });

  it('recovers and persists published rules url by message id when it is missing', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Пишите по теме.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-9',
      publishedUrl: null,
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/999'),
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

    const result = await service.getRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith(
      'mid-rules-9',
      expectChatRulesReadOptions(),
    );
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: {
        publishedUrl: 'https://max.ru/chats/chat-1/message/999',
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(result.publishedUrl).toBe('https://max.ru/chats/chat-1/message/999');
  });

  it('adopts an existing chat message as the published rules post and enables rules button in violations', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:00:00.000Z'),
    });
    prisma.chatRules.update.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '1. Без спама.\n2. Без ссылок.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-source-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/321',
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/321'),
      getMessageTextAsMarkdown: jest.fn().mockResolvedValue('1. Без спама.\n2. Без ссылок.'),
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
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('rules-author-bot');

    const result = await service.adoptChatRulesFromMessage(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        sourceMessageId: 'mid-rules-source-1',
        sourceMessageUrl: null,
        text: '1. Без спама.\n2. Без ссылок.',
      },
      'group_command',
      createGroupCommandPermitFixture({ executionBotId: 'rules-author-bot' }),
    );
    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith('mid-rules-source-1');
    expect(maxClient.getMessageTextAsMarkdown).toHaveBeenCalledWith('mid-rules-source-1');
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        text: '1. Без спама.\n2. Без ссылок.',
        textFormat: 'markdown',
        autoTextEnabled: false,
        publishedMessageId: 'mid-rules-source-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/321',
        publishedBotId: 'rules-author-bot',
      }),
    });
    const rulesChatUpsert = prisma.chat.upsert.mock.calls.find(
      ([args]) =>
        args?.where?.id === 'chat-1' &&
        args?.update?.settings?.upsert?.update?.rulesAttachViolationsEnabled === true,
    )?.[0];
    expect(rulesChatUpsert?.update).toEqual(
      expect.objectContaining({
        settings: {
          upsert: {
            update: {
              rulesAttachViolationsEnabled: true,
            },
            create: {
              rulesAttachViolationsEnabled: true,
            },
          },
        },
      }),
    );
    expect(rulesChatUpsert?.update).not.toHaveProperty('botId');
    expect(rulesChatUpsert?.update).not.toHaveProperty('primaryBotId');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'ADOPT_CHAT_RULES_MESSAGE',
        payload: expect.objectContaining({
          messageId: 'mid-rules-source-1',
          url: 'https://max.ru/chats/chat-1/message/321',
          copiedText: true,
          rulesAttachViolationsEnabled: true,
          botId: 'rules-author-bot',
          source: 'group_command',
        }),
      }),
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(result).toEqual({
      revision: '2026-03-09T10:00:00.000Z',
      text: '1. Без спама.\n2. Без ссылок.',
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
      publishedMessageId: 'mid-rules-source-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/321',
      publishedAt: '2026-03-09T10:00:00.000Z',
    });
  });

  it('recovers MAX rich-text formatting when adopting rules from an existing message', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:00:00.000Z'),
    });
    prisma.chatRules.update.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-source-2',
      publishedUrl: 'https://max.ru/chats/chat-1/message/654',
      publishedAt: new Date('2026-03-09T10:00:00.000Z'),
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T10:00:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/654'),
      getMessageTextAsMarkdown: jest
        .fn()
        .mockResolvedValue('🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)'),
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

    await service.adoptChatRulesFromMessage(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        sourceMessageId: 'mid-rules-source-2',
        sourceMessageUrl: null,
        text: 'MAX Docs',
      },
      'group_command',
      createGroupCommandPermitFixture(),
    );
    expect(prisma.chatRules.update).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      data: expect.objectContaining({
        text: '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
        textFormat: 'markdown',
        autoTextEnabled: false,
        publishedMessageId: 'mid-rules-source-2',
        publishedUrl: 'https://max.ru/chats/chat-1/message/654',
      }),
    });
  });

  it('saves draft and publishes new rules post with persisted link', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert
      .mockResolvedValueOnce({
        id: 'rules-1',
        chatId: 'chat-1',
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-09T09:00:00.000Z'),
        updatedAt: new Date('2026-03-09T09:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'rules-1',
        chatId: 'chat-1',
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: true,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
        createdAt: new Date('2026-03-09T09:00:00.000Z'),
        updatedAt: new Date('2026-03-09T09:05:00.000Z'),
      });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-2',
        url: 'https://max.ru/chats/chat-1/message/456',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
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

    const savedDraft = await service.updateRules(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        text: 'Опубликуйте только по теме.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: true,
      },
    );

    expect(savedDraft.text).toBe('Опубликуйте только по теме.');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'UPDATE_CHAT_RULES',
        payload: expect.objectContaining({
          buttonEnabled: false,
          source: 'miniapp',
        }),
      }),
    });

    const published = await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Опубликуйте только по теме.',
      {
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'RULES',
        },
      },
      expectChatRulesSendOptions(),
    );
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', publishOperationId: expect.any(String) },
      data: expect.objectContaining({
        publishedMessageId: 'mid-rules-2',
        publishedUrl: 'https://max.ru/chats/chat-1/message/456',
        publishedAt: expect.any(Date),
      }),
    });
    expect(published).toEqual({
      chatId: 'chat-1',
      messageId: 'mid-rules-2',
      operation: 'created',
      url: 'https://max.ru/chats/chat-1/message/456',
      publishedAt: expect.any(String),
    });
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      '✅ Правила опубликованы.\nhttps://max.ru/chats/chat-1/message/456',
      undefined,
      expect.objectContaining({
        immediate: true,
        botId: '777000_bot',
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'chat-1',
          action: 'PUBLISH_CHAT_RULES',
          payload: expect.objectContaining({
            source: 'miniapp',
          }),
        }),
      }),
    );
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
  });

  it('publishes rules with autofilled text when the stored draft is empty', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-auto-1',
        url: 'https://max.ru/chats/chat-1/message/601',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
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
    jest
      .spyOn(service, 'getSettings')
      .mockResolvedValue(chatSettingsSchema.parse({ russianProfanityFilterEnabled: true }));

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Пожалуйста, без мата и грубой лексики.'),
      {
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'RULES',
        },
      },
      expectChatRulesSendOptions(),
    );
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', publishOperationId: expect.any(String) },
      data: expect.objectContaining({
        text: expect.stringContaining('Пожалуйста, без мата и грубой лексики.'),
        publishedMessageId: 'mid-rules-auto-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/601',
        publishedAt: expect.any(Date),
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'PUBLISH_CHAT_RULES',
        payload: expect.objectContaining({
          autofilledTextApplied: true,
          source: 'miniapp',
        }),
      }),
    });
  });

  it('publishes rules even when MAX does not return a direct post link', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила без прямой ссылки.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-3',
        url: null,
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
      uploadImage: jest.fn(),
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

    const published = await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', publishOperationId: expect.any(String) },
      data: expect.objectContaining({
        publishedMessageId: 'mid-rules-3',
        publishedUrl: null,
        publishedAt: expect.any(Date),
      }),
    });
    expect(published).toEqual({
      chatId: 'chat-1',
      messageId: 'mid-rules-3',
      operation: 'created',
      url: null,
      publishedAt: expect.any(String),
    });
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      '✅ Правила опубликованы.',
      undefined,
      expect.objectContaining({
        immediate: true,
        botId: '777000_bot',
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила без прямой ссылки.',
      {
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'RULES',
        },
        textFormat: 'html',
      },
      expectChatRulesSendOptions(),
    );
  });

  it('publishes rules with nested formatting, spaces and paragraphs intact', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: '🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)\n\n~~Зачеркнутый~~\n\n  Второй абзац с  пробелами',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-rich-1',
        url: 'https://max.ru/chats/chat-1/message/654',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
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

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      '🔥<a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a>\n\n<s>Зачеркнутый</s>\n\n&nbsp;&nbsp;Второй абзац с&nbsp;&nbsp;пробелами',
      {
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'RULES',
        },
        textFormat: 'html',
      },
      expectChatRulesSendOptions(),
    );
  });

  it('publishes rules with a custom post button from mini app settings', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила с кнопкой.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/help/rules',
      buttonText: 'Подробнее',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-5',
        url: 'https://max.ru/chats/chat-1/message/505',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
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
    jest.spyOn(service as any, 'resolveManualActionBotAssignment').mockResolvedValue('chat-bot-2');

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила с кнопкой.',
      {
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'RULES',
        },
        textFormat: 'html',
        buttons: [[{ text: 'Подробнее', type: 'link', url: 'https://max.ru/help/rules' }]],
      },
      expectChatRulesSendOptions({ botId: 'chat-bot-2' }),
    );
  });

  it('publishes rules with a dedicated admin contact text link', async () => {
    const prisma = createPrismaMock();
    const adminContactStartPayload = buildCompactProfileMentionStartPayload(
      { chatId: 'chat-1', entityType: 'chat', userId: 'admin-1' },
      'test-max-bot-token',
    );
    const adminContactButtonUrl = `https://max.ru/id613002203036_bot?start=${adminContactStartPayload}&profile_label=${encodeURIComponent('Админ')}`;
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила со связью.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      adminContactButtonEnabled: true,
      adminContactButtonUrl,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-contact-1',
        url: 'https://max.ru/chats/chat-1/message/507',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
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

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила со связью.\n\nСвязь с админом: <a href="max://user/admin-1">Админ</a>',
      {
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'RULES',
        },
        textFormat: 'html',
      },
      expectChatRulesSendOptions(),
    );
  });

  it('publishes rules with a direct admin contact link for old unlabeled handoff urls', async () => {
    const prisma = createPrismaMock();
    const adminContactStartPayload = buildCompactProfileMentionStartPayload(
      { chatId: 'chat-1', entityType: 'chat', userId: 'admin-1' },
      'test-max-bot-token',
    );
    const adminContactButtonUrl = `https://max.ru/id613002203036_bot?start=${adminContactStartPayload}`;
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила со старой связью.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      adminContactButtonEnabled: true,
      adminContactButtonUrl,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatMemberProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'admin-1',
            {
              userId: 'admin-1',
              displayName: 'Админ',
              username: null,
              avatarUrl: null,
              profileUrl: null,
            },
          ],
        ]),
      ),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-contact-2',
        url: 'https://max.ru/chats/chat-1/message/508',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
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

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.getChatMemberProfiles).toHaveBeenCalledWith('chat-1', ['admin-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила со старой связью.\n\nСвязь с админом: <a href="max://user/admin-1">Админ</a>',
      {
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'RULES',
        },
        textFormat: 'html',
      },
      expectChatRulesSendOptions(),
    );
  });

  it('publishes rules with multiple custom post buttons grouped into rows', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила с набором кнопок.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttons: [
        { text: 'Канал', url: 'https://max.ru/channel/maxim' },
        { text: 'Чат', url: 'https://max.ru/chat/team' },
        { text: 'Профиль', url: 'https://max.ru/profile/maxim' },
        { text: 'Сайт', url: 'https://example.com/rules' },
      ],
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/channel/maxim',
      buttonText: 'Канал',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T09:05:00.000Z'),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-grid-1',
        url: 'https://max.ru/chats/chat-1/message/706',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
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
    jest.spyOn(service as any, 'resolveManualActionBotAssignment').mockResolvedValue('chat-bot-2');

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Правила с набором кнопок.',
      {
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'RULES',
        },
        textFormat: 'html',
        buttons: [
          [
            { text: 'Канал', type: 'link', url: 'https://max.ru/channel/maxim' },
            { text: 'Чат', type: 'link', url: 'https://max.ru/chat/team' },
            { text: 'Профиль', type: 'link', url: 'https://max.ru/profile/maxim' },
          ],
          [{ text: 'Сайт', type: 'link', url: 'https://example.com/rules' }],
        ],
      },
      expectChatRulesSendOptions({ botId: 'chat-bot-2' }),
    );
  });

  it('records durable cleanup for the previous rules post after a successful republish', async () => {
    const prisma = createPrismaMock();
    prisma.chatRules.upsert.mockResolvedValue({
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Обновлённые правила.',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: false,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
      publishedMessageId: 'mid-rules-old-1',
      publishedBotId: 'old-rules-bot',
      publishedUrl: 'https://max.ru/chats/chat-1/message/101',
      publishedAt: new Date('2026-03-09T08:00:00.000Z'),
      createdAt: new Date('2026-03-09T07:00:00.000Z'),
      updatedAt: new Date('2026-03-09T08:00:00.000Z'),
    });

    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-new-2',
        url: 'https://max.ru/chats/chat-1/message/202',
      }),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const deleteChatRulesMessage = jest.fn().mockResolvedValue('accepted');

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    (service as any).manualMessageCleanupService = { deleteChatRulesMessage };
    jest.spyOn(service as any, 'resolveManualActionBotAssignment').mockResolvedValue('chat-bot-2');

    await service.publishRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: '152517912',
      chatTitle: null,
    });

    expect(deleteChatRulesMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'mid-rules-old-1',
      botId: 'old-rules-bot',
      cleanupKind: 'republish_previous',
      source: 'miniapp',
      actorUserId: 'admin-1',
      directOptions: expectChatRulesDeleteOptions({ botId: 'old-rules-bot' }),
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', publishOperationId: expect.any(String) },
      data: expect.objectContaining({
        publishedMessageId: 'mid-rules-new-2',
        publishedBotId: 'chat-bot-2',
        publishedUrl: 'https://max.ru/chats/chat-1/message/202',
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'PUBLISH_CHAT_RULES',
        payload: expect.objectContaining({
          replacedPreviousPost: true,
          source: 'miniapp',
        }),
      }),
    });
  });

  it('records private bot as the rules source in audit log payloads', async () => {
    const prisma = createPrismaMock();
    const storedRules: PersistedChatRules = {
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила от бота',
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
      publishedMessageId: 'mid-rules-7',
      publishedBotId: null,
      publishedUrl: 'https://max.ru/chats/chat-1/message/777',
      publishedAt: new Date('2026-03-09T11:00:00.000Z'),
      publishOperationId: null,
      publishOperationBotId: null,
      publishSendStartedAt: null,
      pendingCleanupMessageId: null,
      pendingCleanupBotId: null,
      pendingCleanupIntentId: null,
      pendingCleanupKind: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T11:00:00.000Z'),
    };
    prisma.chatRules.upsert.mockResolvedValue(storedRules);
    const clearedRules: PersistedChatRules = {
      ...storedRules,
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      updatedAt: new Date('2026-03-09T11:05:00.000Z'),
    };
    prisma.chatRules.findUnique.mockResolvedValue(clearedRules);

    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn(),
      uploadImage: jest.fn(),
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'mid-rules-7',
        url: 'https://max.ru/chats/chat-1/message/777',
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn(),
    };
    const actor = {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await service.updateRules(
      'chat-1',
      actor,
      {
        text: 'Правила от бота',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
      },
      'private_bot',
    );
    await service.publishRules('chat-1', actor, 'private_bot');
    const reset = await service.resetPublishedRules('chat-1', actor, 'private_bot');

    expect(reset).toMatchObject({
      revision: clearedRules.updatedAt.toISOString(),
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
    });

    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UPDATE_CHAT_RULES',
          payload: expect.objectContaining({
            buttonEnabled: false,
            source: 'private_bot',
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'PUBLISH_CHAT_RULES',
          payload: expect.objectContaining({
            buttonEnabled: false,
            source: 'private_bot',
          }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'RESET_CHAT_RULES_PUBLICATION',
          payload: expect.objectContaining({ source: 'private_bot' }),
        }),
      }),
    );
  });

  it('resets published rules and deletes the existing MAX post', async () => {
    const prisma = createPrismaMock();
    const storedRules: PersistedChatRules = {
      id: 'rules-1',
      chatId: 'chat-1',
      text: 'Правила чата',
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
      publishedMessageId: 'mid-rules-4',
      publishedBotId: 'rules-author-bot',
      publishedUrl: 'https://max.ru/chats/chat-1/message/654',
      publishedAt: new Date('2026-03-09T11:00:00.000Z'),
      publishOperationId: null,
      publishOperationBotId: null,
      publishSendStartedAt: null,
      pendingCleanupMessageId: null,
      pendingCleanupBotId: null,
      pendingCleanupIntentId: null,
      pendingCleanupKind: null,
      createdAt: new Date('2026-03-09T09:00:00.000Z'),
      updatedAt: new Date('2026-03-09T11:00:00.000Z'),
    };
    prisma.chatRules.upsert.mockResolvedValue(storedRules);
    const clearedRules: PersistedChatRules = {
      ...storedRules,
      publishedMessageId: null,
      publishedBotId: null,
      publishedUrl: null,
      publishedAt: null,
      updatedAt: new Date('2026-03-09T11:05:00.000Z'),
    };
    prisma.chatRules.findUnique.mockResolvedValue(clearedRules);

    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      resolveMessageLink: jest.fn(),
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
    jest.spyOn(service as any, 'resolveManualActionBotAssignment').mockResolvedValue('chat-bot-2');

    const result = await service.resetPublishedRules('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'mid-rules-4',
      expectChatRulesDeleteOptions({ botId: 'rules-author-bot' }),
    );
    expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          publishedMessageId: 'mid-rules-4',
          pendingCleanupMessageId: null,
        }),
        data: expect.objectContaining({
          pendingCleanupMessageId: 'mid-rules-4',
          pendingCleanupKind: 'reset_current',
        }),
      }),
    );
    expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          chatId: 'chat-1',
          publishedMessageId: 'mid-rules-4',
          publishedBotId: 'rules-author-bot',
          publishOperationId: null,
          publishSendStartedAt: null,
          pendingCleanupMessageId: 'mid-rules-4',
          pendingCleanupBotId: 'rules-author-bot',
          pendingCleanupKind: 'reset_current',
        },
        data: expect.objectContaining({
          publishedMessageId: null,
          pendingCleanupMessageId: null,
          pendingCleanupKind: null,
        }),
      }),
    );
    expect(result).toEqual({
      revision: clearedRules.updatedAt.toISOString(),
      text: 'Правила чата',
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
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        action: 'RESET_CHAT_RULES_PUBLICATION',
        payload: expect.objectContaining({
          source: 'miniapp',
        }),
      }),
    });
  });
});
