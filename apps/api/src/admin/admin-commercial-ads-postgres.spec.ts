import { randomUUID } from 'node:crypto';
import { chatSummarySchema } from '@maxim/contracts';
import {
  chatSettingsSchema,
  createDefaultCommercialAdsPolicy,
  MAX_BOT_SPEECH_TEXT_LENGTH,
  type ChatSettings,
  type CommercialAdsPolicy,
} from '@maxim/contracts/settings';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { CommercialAdsPreviewService } from '../moderation/commercial/commercial-ads-preview.service';
import type { RedisCounterService } from '../moderation/redis-counter.service';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readChatSettingsSnapshot, saveChatSettings } from './admin-chat-settings';
import { AdminCommercialAdsService } from './admin-commercial-ads.service';
import { applySettingsToAllChats } from './admin-settings-apply';
import type { ManagedEntitiesService } from './managed-entities.service';
import { selectModerationFeedReadModelRows } from './stats-read-model-selectors';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(45_000);

function planNodes(
  value: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) planNodes(child, found);
  } else if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (typeof node['Node Type'] === 'string') found.push(node);
    for (const child of Object.values(node)) planNodes(child, found);
  }
  return found;
}

integration('commercial ad settings and administrator reports with PostgreSQL', () => {
  let db: PrismaClient;
  let service: AdminCommercialAdsService;
  let chatId: string;
  let otherChatId: string;
  let feedbackId: string;
  const user: AuthUser = { userId: '123456789', username: null, displayName: null };
  const access = {
    assertChatAdminAccess: jest.fn<
      ReturnType<ManagedEntitiesService['assertChatAdminAccess']>,
      Parameters<ManagedEntitiesService['assertChatAdminAccess']>
    >(),
  } satisfies Pick<ManagedEntitiesService, 'assertChatAdminAccess'>;
  const classifier = {
    preview: jest.fn<
      ReturnType<CommercialAdsPreviewService['preview']>,
      Parameters<CommercialAdsPreviewService['preview']>
    >(),
  } satisfies Pick<CommercialAdsPreviewService, 'preview'>;
  const redis = {
    incrementWithTtl: jest.fn<
      ReturnType<RedisCounterService['incrementWithTtl']>,
      Parameters<RedisCounterService['incrementWithTtl']>
    >(),
  } satisfies Pick<RedisCounterService, 'incrementWithTtl'>;
  const cache = {
    invalidate: jest.fn<
      ReturnType<ChatContextCacheService['invalidate']>,
      Parameters<ChatContextCacheService['invalidate']>
    >(),
  } satisfies Pick<ChatContextCacheService, 'invalidate'>;
  const resolveAssignment = jest.fn<
    ReturnType<Parameters<typeof saveChatSettings>[0]['resolveBotAssignmentData']>,
    Parameters<Parameters<typeof saveChatSettings>[0]['resolveBotAssignmentData']>
  >();
  const capabilities = jest.fn<
    ReturnType<Parameters<typeof saveChatSettings>[0]['assertBotCapabilities']>,
    Parameters<Parameters<typeof saveChatSettings>[0]['assertBotCapabilities']>
  >();
  const readiness = jest.fn<
    ReturnType<Parameters<typeof saveChatSettings>[0]['refreshExecutionReadiness']>,
    Parameters<Parameters<typeof saveChatSettings>[0]['refreshExecutionReadiness']>
  >();

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable localhost PostgreSQL race_test database required');
    db = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 15_000 });
    await db.$connect();
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    chatId = `commercial-admin-${suffix}`;
    otherChatId = `commercial-admin-other-${suffix}`;
    feedbackId = `commercial-feed-${suffix}`;
    access.assertChatAdminAccess.mockReset().mockResolvedValue(undefined);
    classifier.preview
      .mockReset()
      .mockRejectedValue(new Error('Feedback must not run a classifier'));
    redis.incrementWithTtl
      .mockReset()
      .mockRejectedValue(new Error('Feedback must not consume preview quota'));
    cache.invalidate.mockReset().mockResolvedValue(undefined);
    resolveAssignment.mockReset().mockResolvedValue({});
    capabilities.mockReset().mockResolvedValue(undefined);
    readiness.mockReset().mockResolvedValue(undefined);
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Commercial policy native fixture',
        entityType: 'CHAT',
        settings: {
          create: {
            commercialAdsFilterEnabled: true,
            antiSpamEnabled: true,
            greetingBotMessageText: 'Preserved greeting',
            commentsEnabled: true,
            commentsChatBroadcastsEnabled: true,
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        },
      },
    });
    await db.chat.create({ data: { id: otherChatId, title: 'Other private native fixture' } });
    await db.chatModerationFeedItem.createMany({
      data: [
        {
          id: feedbackId,
          chatId,
          userId: '987654321',
          messageId: 'native-message',
          eventType: 'MESSAGE',
          ruleCode: 'COMMERCIAL_LLM_DELETE',
          action: 'DELETE_MESSAGE',
          maskedExcerpt: 'Private fixture excerpt',
          metadata: { privateEvidence: 'Retained immutable evidence' },
          createdAt: new Date('2026-10-01T12:00:00.000Z'),
        },
        {
          id: `${feedbackId}-other`,
          chatId: otherChatId,
          userId: '987654321',
          eventType: 'MESSAGE',
          ruleCode: 'COMMERCIAL_AD',
          action: 'DELETE_MESSAGE',
          createdAt: new Date('2026-10-01T12:00:00.000Z'),
        },
        {
          id: `${feedbackId}-noncommercial`,
          chatId,
          userId: '987654321',
          eventType: 'MESSAGE',
          ruleCode: 'RUSSIAN_PROFANITY',
          action: 'WARN',
          createdAt: new Date('2026-10-01T12:00:00.000Z'),
        },
      ],
    });
    service = new AdminCommercialAdsService(
      db as PrismaService,
      access as unknown as ManagedEntitiesService,
      classifier as unknown as CommercialAdsPreviewService,
      redis as unknown as RedisCounterService,
    );
  });

  afterEach(async () => {
    if (!db || !chatId) return;
    // FLAG: Fixtures own only these exact disposable chats; feed rows have no Chat FK cascade.
    await db.chatModerationFeedItem.deleteMany({
      where: { chatId: { in: [chatId, otherChatId] } },
    });
    await db.chat.deleteMany({ where: { id: { in: [chatId, otherChatId] } } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function save(
    body: unknown,
    options: { commercialAiDeleteOnly?: boolean } = { commercialAiDeleteOnly: true },
  ): Promise<ChatSettings> {
    return saveChatSettings({
      prisma: db as PrismaService,
      chatContextCache: cache,
      chatId,
      actorUserId: user.userId,
      body,
      source: 'miniapp',
      resolveBotAssignmentData: resolveAssignment,
      assertRequiredSubscriptionSettings: async () => undefined,
      commercialAiDeleteOnly: options.commercialAiDeleteOnly,
      assertBotCapabilities: capabilities,
      refreshExecutionReadiness: readiness,
    });
  }

  async function currentBody(): Promise<ChatSettings> {
    const stored = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    return chatSettingsSchema.parse({
      ...stored,
      settingsRevision: stored.updatedAt.toISOString(),
    });
  }

  function bulkParams(body: ChatSettings, targetChatIds: string[], commercialAiDeleteOnly = true) {
    type Params = Parameters<typeof applySettingsToAllChats>[0];
    return {
      prisma: db as PrismaService,
      chatContextCache: cache,
      sourceChatId: chatId,
      actorUserId: user.userId,
      body,
      source: 'miniapp',
      targetOrSettingKeys: { mode: 'selectedChats', favoriteTypes: [], chatIds: targetChatIds },
      settingKeys: ['commercialAdsPolicy'],
      confirmedTargetChatIds: targetChatIds,
      expectedSourceSettingsRevision: body.settingsRevision,
      normalizeSettings: (settings) => settings,
      resolveTargetChats: async () =>
        targetChatIds.map((id) =>
          chatSummarySchema.parse({
            id,
            title: 'Private bulk fixture',
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
        ),
      resolveBotAssignmentData: async () => ({}),
      assertRequiredSubscriptionSettings: async () => undefined,
      commercialAiDeleteOnly,
      assertBotCapabilities: jest
        .fn<
          ReturnType<Params['assertBotCapabilities']>,
          Parameters<Params['assertBotCapabilities']>
        >()
        .mockResolvedValue(undefined),
      recordConcurrentWriteConflict: jest.fn<
        ReturnType<Params['recordConcurrentWriteConflict']>,
        Parameters<Params['recordConcurrentWriteConflict']>
      >(),
      onPartialApplied: jest
        .fn<ReturnType<Params['onPartialApplied']>, Parameters<Params['onPartialApplied']>>()
        .mockResolvedValue(undefined),
      isRequiredSubscriptionCurrentlyActive: () => false,
      scheduleReadinessRefresh: jest.fn<
        ReturnType<Params['scheduleReadinessRefresh']>,
        Parameters<Params['scheduleReadinessRefresh']>
      >(),
    } satisfies Params;
  }

  it('records one report across concurrent retries and retains separate administrator reports', async () => {
    const before = await db.chatModerationFeedItem.findUniqueOrThrow({ where: { id: feedbackId } });
    const settingsBefore = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.feedback(chatId, user, { feedItemId: feedbackId })),
    );
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ ok: true })));
    let audits = await db.auditLog.findMany({
      where: { chatId, action: 'REPORT_COMMERCIAL_AD_ERROR' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: user.userId,
      payload: { version: 1, feedItemId: feedbackId, ruleCode: 'COMMERCIAL_LLM_DELETE' },
    });
    expect(JSON.stringify(audits[0]!.payload)).not.toContain(before.maskedExcerpt);
    expect(JSON.stringify(audits[0]!.payload)).not.toContain('Retained immutable evidence');
    expect(
      await db.chatModerationFeedItem.findUniqueOrThrow({ where: { id: feedbackId } }),
    ).toEqual(before);
    expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).toEqual(settingsBefore);
    expect(await db.commercialReviewSample.count({ where: { chatId } })).toBe(0);
    await service.feedback(chatId, { ...user, userId: '111111111' }, { feedItemId: feedbackId });
    audits = await db.auditLog.findMany({
      where: { chatId, action: 'REPORT_COMMERCIAL_AD_ERROR' },
    });
    expect(audits).toHaveLength(2);
    expect(classifier.preview).not.toHaveBeenCalled();
    expect(redis.incrementWithTtl).not.toHaveBeenCalled();
    expect(access.assertChatAdminAccess).toHaveBeenCalledTimes(9);
  });

  it('refuses foreign-chat, noncommercial and missing evidence without creating a report', async () => {
    for (const feedItemId of [
      `${feedbackId}-other`,
      `${feedbackId}-noncommercial`,
      `${feedbackId}-missing`,
    ])
      await expect(service.feedback(chatId, user, { feedItemId })).rejects.toMatchObject({
        status: 404,
      });
    expect(
      await db.auditLog.count({ where: { chatId, action: 'REPORT_COMMERCIAL_AD_ERROR' } }),
    ).toBe(0);
    expect(await db.auditLog.count({ where: { chatId: otherChatId } })).toBe(0);
  });

  it('persists explicit category rules and expiry grants, preserves omitted policy and allows explicit null', async () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.SERVICES = 'ALLOW';
    policy.exceptions.push({
      id: randomUUID(),
      userId: '987654321',
      userName: 'Анна',
      categories: ['BUSINESS'],
      expiresAt: '2026-11-10T12:00:00.000Z',
    });
    const saved = await save({ ...(await currentBody()), commercialAdsPolicy: policy });
    const stored = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    expect(saved.commercialAdsPolicy).toEqual(policy);
    expect(stored.commercialAdsPolicy).toEqual(policy);
    expect(saved.settingsRevision).toBe(stored.updatedAt.toISOString());
    expect(stored).toMatchObject({
      antiSpamEnabled: true,
      greetingBotMessageText: 'Preserved greeting',
      commentsEnabled: true,
      commentsChatBroadcastsEnabled: true,
    });
    const olderClientBody: Partial<ChatSettings> = {
      ...(await currentBody()),
      slowModeIntervalSeconds: 60,
    };
    delete olderClientBody.commercialAdsPolicy;
    const olderSave = await save(olderClientBody);
    expect(olderSave.commercialAdsPolicy).toEqual(policy);
    expect(
      (await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).commercialAdsPolicy,
    ).toEqual(policy);
    const cleared = await save({ ...(await currentBody()), commercialAdsPolicy: null });
    expect(cleared.commercialAdsPolicy).toBeNull();
    expect(
      (await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).commercialAdsPolicy,
    ).toBeNull();
    expect(await db.auditLog.count({ where: { chatId, action: 'UPDATE_SETTINGS' } })).toBe(3);
    expect(cache.invalidate).toHaveBeenCalledTimes(3);
  });

  it.each(['configured', 'legacy', 'invalid'] as const)(
    'preserves raw %s commercial policy and activation when unrelated settings need a read repair',
    async (kind) => {
      const policy = createDefaultCommercialAdsPolicy();
      policy.categories.SERVICES = 'ALLOW';
      policy.exceptions.push({
        id: randomUUID(),
        userId: '987654321',
        userName: 'Анна',
        categories: ['BUSINESS'],
        expiresAt: '2099-11-10T12:00:00.000Z',
      });
      const rawPolicy =
        kind === 'configured' ? policy : kind === 'legacy' ? null : { version: 999 };
      await db.chatSettings.update({
        where: { chatId },
        data: {
          greetingBotMessageText: 'x'.repeat(MAX_BOT_SPEECH_TEXT_LENGTH + 1),
          commercialAdsPolicy: rawPolicy ?? Prisma.DbNull,
        },
      });
      const logger = { warn: jest.fn() };

      const snapshot = await readChatSettingsSnapshot({
        prisma: db as PrismaService,
        chatContextCache: cache,
        logger,
        chatId,
      });

      const stored = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
      expect(stored.commercialAdsPolicy).toEqual(rawPolicy);
      expect(stored.commercialAdsFilterEnabled).toBe(true);
      expect(stored.greetingBotMessageText).toBe('');
      expect(snapshot.settings.greetingBotMessageText).toBe('');
      expect(snapshot.settings.commercialAdsPolicy).toEqual(kind === 'configured' ? policy : null);
      expect(snapshot.settings.commercialAdsFilterEnabled).toBe(kind !== 'invalid');
      expect(snapshot.settings.settingsRevision).toBe(stored.updatedAt.toISOString());
      expect(logger.warn).toHaveBeenCalled();
      expect(await db.auditLog.count({ where: { chatId } })).toBe(0);
      expect(classifier.preview).not.toHaveBeenCalled();
      expect(capabilities).not.toHaveBeenCalled();
    },
  );

  it.each([false, undefined])(
    'rejects new personal-sale BLOCK with AI delete-only %s before changing settings or effects',
    async (commercialAiDeleteOnly) => {
      const blocked = createDefaultCommercialAdsPolicy();
      blocked.categories.PERSONAL_SALE = 'BLOCK';
      for (const currentPolicy of [null, createDefaultCommercialAdsPolicy()]) {
        await db.chatSettings.update({
          where: { chatId },
          data: { commercialAdsPolicy: currentPolicy ?? Prisma.DbNull },
        });
        const before = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
        await expect(
          save(
            { ...(await currentBody()), commercialAdsPolicy: blocked },
            { commercialAiDeleteOnly },
          ),
        ).rejects.toMatchObject({
          status: 400,
          message: 'Запрет личных продаж доступен при ИИ-проверке',
        });
        expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).toEqual(before);
      }
      expect(await db.auditLog.count({ where: { chatId } })).toBe(0);
      expect(cache.invalidate).not.toHaveBeenCalled();
      expect(capabilities).not.toHaveBeenCalled();
      expect(readiness).not.toHaveBeenCalled();
    },
  );

  it('preserves a saved personal-sale BLOCK and participant grants during AI downtime', async () => {
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.PERSONAL_SALE = 'BLOCK';
    policy.exceptions.push({
      id: randomUUID(),
      userId: '987654321',
      userName: 'Анна',
      categories: ['PERSONAL_SALE'],
      expiresAt: null,
    });
    await save({ ...(await currentBody()), commercialAdsPolicy: policy });
    const saved = await save(
      { ...(await currentBody()), slowModeIntervalSeconds: 60 },
      { commercialAiDeleteOnly: false },
    );
    expect(saved.commercialAdsPolicy).toEqual(policy);
    expect(
      (await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).commercialAdsPolicy,
    ).toEqual(policy);
    expect(await db.auditLog.count({ where: { chatId, action: 'UPDATE_SETTINGS' } })).toBe(2);
  });

  it('copies category rules while retaining recipient grants and keeping source grants local', async () => {
    const sourcePolicy = createDefaultCommercialAdsPolicy();
    sourcePolicy.categories.SERVICES = 'ALLOW';
    sourcePolicy.exceptions.push({
      id: randomUUID(),
      userId: '987654321',
      userName: 'Анна',
      categories: ['BUSINESS'],
      expiresAt: null,
    });
    const recipientPolicy = createDefaultCommercialAdsPolicy();
    recipientPolicy.exceptions.push({
      id: randomUUID(),
      userId: '111111111',
      userName: 'Иван',
      categories: ['COMMUNITIES'],
      expiresAt: '2099-11-10T12:00:00.000Z',
    });
    await db.chatSettings.update({
      where: { chatId },
      data: { commercialAdsPolicy: sourcePolicy },
    });
    await db.chatSettings.create({
      data: {
        chatId: otherChatId,
        commercialAdsFilterEnabled: true,
        commercialAdsPolicy: recipientPolicy,
        antiSpamEnabled: true,
        commentsEnabled: true,
        commentsChatBroadcastsEnabled: true,
      },
    });
    const params = bulkParams(await currentBody(), [chatId, otherChatId]);

    await expect(applySettingsToAllChats(params)).resolves.toMatchObject({
      sourceChatId: chatId,
      updatedChats: 2,
      appliedChatIds: [chatId, otherChatId],
    });

    expect(
      (await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).commercialAdsPolicy,
    ).toEqual(sourcePolicy);
    const recipient = await db.chatSettings.findUniqueOrThrow({ where: { chatId: otherChatId } });
    expect(recipient.commercialAdsPolicy).toEqual({
      ...sourcePolicy,
      exceptions: recipientPolicy.exceptions,
    });
    expect(recipient).toMatchObject({
      antiSpamEnabled: true,
      commentsEnabled: true,
      commentsChatBroadcastsEnabled: true,
    });
    expect((recipient.commercialAdsPolicy as CommercialAdsPolicy).exceptions).not.toContainEqual(
      sourcePolicy.exceptions[0],
    );
    expect(
      await db.auditLog.count({
        where: { chatId: { in: [chatId, otherChatId] }, action: 'APPLY_SETTINGS_TO_ALL_CHATS' },
      }),
    ).toBe(2);
    expect(cache.invalidate).toHaveBeenCalledWith(chatId);
    expect(cache.invalidate).toHaveBeenCalledWith(otherChatId);
    expect(params.scheduleReadinessRefresh).toHaveBeenCalledTimes(1);
    expect(params.onPartialApplied).not.toHaveBeenCalled();
  });

  it('rejects a new recipient personal-sale BLOCK during bulk apply with AI disabled', async () => {
    const sourcePolicy = createDefaultCommercialAdsPolicy();
    sourcePolicy.categories.PERSONAL_SALE = 'BLOCK';
    await db.chatSettings.update({
      where: { chatId },
      data: { commercialAdsPolicy: sourcePolicy },
    });
    await db.chatSettings.create({
      data: { chatId: otherChatId, commercialAdsPolicy: createDefaultCommercialAdsPolicy() },
    });
    const beforeSource = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const beforeRecipient = await db.chatSettings.findUniqueOrThrow({
      where: { chatId: otherChatId },
    });
    const params = bulkParams(await currentBody(), [otherChatId], false);

    await expect(applySettingsToAllChats(params)).rejects.toMatchObject({
      status: 400,
      message: 'Запрет личных продаж доступен при ИИ-проверке',
    });

    expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).toEqual(beforeSource);
    expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId: otherChatId } })).toEqual(
      beforeRecipient,
    );
    expect(await db.auditLog.count({ where: { chatId: { in: [chatId, otherChatId] } } })).toBe(0);
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(params.scheduleReadinessRefresh).not.toHaveBeenCalled();
    expect(params.onPartialApplied).not.toHaveBeenCalled();
  });

  it('rejects a stale category-policy save before writing settings, audit or cache', async () => {
    const before = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const body = await currentBody();
    await expect(
      save({
        ...body,
        settingsRevision: new Date(before.updatedAt.getTime() - 1).toISOString(),
        commercialAdsPolicy: createDefaultCommercialAdsPolicy(),
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'CHAT_SETTINGS_CONCURRENT_UPDATE' } });
    expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).toEqual(before);
    expect(await db.auditLog.count({ where: { chatId, action: 'UPDATE_SETTINGS' } })).toBe(0);
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('commits only one of two concurrent different category policies at the same revision', async () => {
    const body = await currentBody();
    const first = createDefaultCommercialAdsPolicy();
    const second = createDefaultCommercialAdsPolicy();
    second.categories.SERVICES = 'ALLOW';
    let arrivals = 0;
    let release!: () => void;
    const bothReadOriginal = new Promise<void>((resolve) => {
      release = resolve;
    });
    resolveAssignment.mockImplementation(async () => {
      if (++arrivals === 2) release();
      await bothReadOriginal;
      return {};
    });
    const results = await Promise.allSettled(
      [first, second].map((commercialAdsPolicy) => save({ ...body, commercialAdsPolicy })),
    );
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatchObject({ status: 409 });
    expect(
      (await db.chatSettings.findUniqueOrThrow({ where: { chatId } })).commercialAdsPolicy,
    ).toEqual(successes[0]!.value.commercialAdsPolicy);
    expect(await db.auditLog.count({ where: { chatId, action: 'UPDATE_SETTINGS' } })).toBe(1);
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
  });

  it('filters commercial history before keyset pagination and bounds indexed work behind newer unrelated history', async () => {
    const sourceAt = new Date('2026-10-15T12:00:00.000Z');
    await db.$executeRaw`
      INSERT INTO chat_moderation_feed_items
        (id, chat_id, user_id, event_type, rule_code, action, created_at, user_display_name)
      SELECT ${`${feedbackId}-noise-`} || n, ${chatId}, '987654321', 'MESSAGE',
        'RUSSIAN_PROFANITY', 'DELETE_MESSAGE', ${sourceAt}::timestamp + INTERVAL '10 seconds', 'Fixture'
      FROM generate_series(1, 6000) n
    `;
    for (const rule of ['COMMERCIAL_AD', 'COMMERCIAL_LLM_DELETE'])
      await db.$executeRaw`
        INSERT INTO chat_moderation_feed_items
          (id, chat_id, user_id, event_type, rule_code, action, created_at, user_display_name)
        SELECT ${`${feedbackId}-${rule}-history-`} || n, ${chatId}, '987654321', 'MESSAGE',
          ${rule}, 'DELETE_MESSAGE', ${sourceAt}::timestamp + n * INTERVAL '1 millisecond', 'Fixture'
        FROM generate_series(1, 2000) n
      `;
    const headAt = new Date(sourceAt.getTime() + 4000);
    const heads = Array.from({ length: 8 }, (_, index) => ({
      id: `${feedbackId}-top-${index}`,
      chatId,
      userId: '987654321',
      eventType: 'MESSAGE' as const,
      ruleCode: index % 2 === 0 ? 'COMMERCIAL_AD' : 'COMMERCIAL_LLM_DELETE',
      action: 'DELETE_MESSAGE' as const,
      userDisplayName: 'Fixture',
      createdAt: headAt,
    }));
    await db.chatModerationFeedItem.createMany({ data: heads });
    await db.$executeRawUnsafe('ANALYZE chat_moderation_feed_items');
    const captured: Prisma.Sql[] = [];
    const observed = {
      $queryRaw<T = unknown>(
        query: TemplateStringsArray | Prisma.Sql,
        ...values: unknown[]
      ): Prisma.PrismaPromise<T> {
        const sql = Array.isArray(query)
          ? Prisma.sql(query as TemplateStringsArray, ...values)
          : (query as Prisma.Sql);
        captured.push(sql);
        return db.$queryRaw<T>(sql);
      },
    } satisfies Pick<PrismaService, '$queryRaw'>;
    const params = {
      chatId,
      from: sourceAt,
      to: new Date(sourceAt.getTime() + 20_000),
      filter: 'COMMERCIAL' as const,
      cursor: null,
      limit: 5,
    };
    const first = await selectModerationFeedReadModelRows(observed as PrismaService, params);
    expect(first.map((row) => row.id)).toEqual(
      heads
        .slice(3)
        .reverse()
        .map((row) => row.id),
    );
    const cursor = first.at(-1)!;
    const second = await selectModerationFeedReadModelRows(observed as PrismaService, {
      ...params,
      cursor: { createdAt: cursor.createdAt, id: cursor.id },
    });
    expect(second.slice(0, 3).map((row) => row.id)).toEqual(
      heads
        .slice(0, 3)
        .reverse()
        .map((row) => row.id),
    );
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(10);
    expect(
      [...first, ...second].every((row) =>
        ['COMMERCIAL_AD', 'COMMERCIAL_LLM_DELETE'].includes(row.ruleCode),
      ),
    ).toBe(true);
    for (const query of captured) {
      // FLAG: EXPLAIN ANALYZE is limited to the exact captured SELECT in this disposable fixture.
      const plan = await db.$queryRaw<unknown[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
      );
      const scans = planNodes(plan).filter(
        (node) => node['Relation Name'] === 'chat_moderation_feed_items',
      );
      expect(scans).toHaveLength(2);
      for (const scan of scans) {
        expect(['Index Scan', 'Index Only Scan']).toContain(scan['Node Type']);
        expect(scan['Index Name']).toBe('chat_moderation_feed_items_chat_rule_created_id_idx');
        expect(Number(scan['Actual Rows']) * Number(scan['Actual Loops'])).toBeLessThanOrEqual(5);
        expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
      }
    }
  });
});
