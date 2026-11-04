import { ForbiddenException } from '@nestjs/common';
import {
  createDefaultCommercialAdsPolicy,
  type CommercialAdsPreviewResponse,
} from '@maxim/contracts/settings';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { CommercialAdsPreviewService } from '../moderation/commercial/commercial-ads-preview.service';
import type { RedisCounterService } from '../moderation/redis-counter.service';
import type { ChatModerationFeedItem } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminCommercialAdsService } from './admin-commercial-ads.service';
import { DEFAULT_CHAT_SETTINGS } from './admin.service.support';
import type { ManagedEntitiesService } from './managed-entities.service';

type SettingsRow = Awaited<ReturnType<PrismaService['chatSettings']['findUnique']>>;
type FeedbackFeedRow = Pick<ChatModerationFeedItem, 'id' | 'chatId' | 'ruleCode'>;
const user: AuthUser = { userId: '123456789', username: null, displayName: null };
const unavailable: CommercialAdsPreviewResponse = {
  decision: 'UNAVAILABLE',
  categories: [],
  reason: 'CLASSIFIER_UNAVAILABLE',
};

function harness() {
  const access = {
    assertChatAdminAccess: jest
      .fn<
        ReturnType<ManagedEntitiesService['assertChatAdminAccess']>,
        Parameters<ManagedEntitiesService['assertChatAdminAccess']>
      >()
      .mockResolvedValue(undefined),
  } satisfies Pick<ManagedEntitiesService, 'assertChatAdminAccess'>;
  const classifier = {
    preview: jest
      .fn<
        ReturnType<CommercialAdsPreviewService['preview']>,
        Parameters<CommercialAdsPreviewService['preview']>
      >()
      .mockResolvedValue({ decision: 'KEEP', categories: [], reason: 'NOT_ADVERTISING' }),
  } satisfies Pick<CommercialAdsPreviewService, 'preview'>;
  const redis = {
    incrementWithTtl: jest
      .fn<
        ReturnType<RedisCounterService['incrementWithTtl']>,
        Parameters<RedisCounterService['incrementWithTtl']>
      >()
      .mockResolvedValue(1),
  } satisfies Pick<RedisCounterService, 'incrementWithTtl'>;
  const prisma = {
    chatSettings: {
      findUnique: jest
        .fn<Promise<SettingsRow>, Parameters<PrismaService['chatSettings']['findUnique']>>()
        .mockResolvedValue(null),
    },
    chatModerationFeedItem: {
      findUnique: jest
        .fn<
          Promise<FeedbackFeedRow | null>,
          Parameters<PrismaService['chatModerationFeedItem']['findUnique']>
        >()
        .mockResolvedValue({ id: 'feed-1', chatId: 'chat-1', ruleCode: 'COMMERCIAL_LLM_DELETE' }),
    },
    auditLog: {
      createMany: jest
        .fn<
          Promise<Awaited<ReturnType<PrismaService['auditLog']['createMany']>>>,
          Parameters<PrismaService['auditLog']['createMany']>
        >()
        .mockResolvedValue({ count: 1 }),
    },
  };
  const service = new AdminCommercialAdsService(
    prisma as unknown as PrismaService,
    access as unknown as ManagedEntitiesService,
    classifier as unknown as CommercialAdsPreviewService,
    redis as unknown as RedisCounterService,
  );
  return { service, access, classifier, redis, prisma };
}

describe('AdminCommercialAdsService', () => {
  it('checks exact chat administration before validation, store reads or classifier admission', async () => {
    const h = harness();
    h.access.assertChatAdminAccess.mockRejectedValue(new ForbiddenException('denied'));
    await expect(h.service.preview('chat-1', user, {})).rejects.toMatchObject({ status: 403 });
    await expect(h.service.feedback('chat-1', user, {})).rejects.toMatchObject({ status: 403 });
    expect(h.access.assertChatAdminAccess).toHaveBeenNthCalledWith(1, 'chat-1', user);
    expect(h.access.assertChatAdminAccess).toHaveBeenNthCalledWith(2, 'chat-1', user);
    expect(h.redis.incrementWithTtl).not.toHaveBeenCalled();
    expect(h.prisma.chatSettings.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.chatModerationFeedItem.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.createMany).not.toHaveBeenCalled();
    expect(h.classifier.preview).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { text: ' ', policy: null, enabled: true },
    { text: 'а'.repeat(2501), policy: null, enabled: true },
    { text: 'Сообщение', policy: { version: 999 }, enabled: true },
    { text: 'Сообщение', policy: null, enabled: true, userId: '-1' },
    { text: 'Сообщение', policy: null, enabled: true, publish: true },
  ])('rejects an invalid preview before resource admission: %j', async (body) => {
    const h = harness();
    await expect(h.service.preview('chat-1', user, body)).rejects.toMatchObject({ status: 400 });
    expect(h.redis.incrementWithTtl).not.toHaveBeenCalled();
    expect(h.prisma.chatSettings.findUnique).not.toHaveBeenCalled();
    expect(h.classifier.preview).not.toHaveBeenCalled();
  });

  it('passes the exact draft and optional author to the classifier with stored settings', async () => {
    const h = harness();
    const policy = createDefaultCommercialAdsPolicy();
    policy.categories.SERVICES = 'ALLOW';
    const request = { text: 'Проверяемый текст', policy, enabled: true, userId: '987654321' };
    const stored = {
      ...DEFAULT_CHAT_SETTINGS,
      commercialAdsFilterEnabled: false,
      commercialAdsPolicy: null,
    } as unknown as NonNullable<SettingsRow>;
    h.prisma.chatSettings.findUnique.mockResolvedValue(stored);
    const result: CommercialAdsPreviewResponse = {
      decision: 'KEEP',
      categories: ['SERVICES'],
      reason: 'CATEGORY_ALLOWED',
    };
    h.classifier.preview.mockResolvedValue(result);
    const before = structuredClone(request);
    await expect(h.service.preview('chat-1', user, request)).resolves.toEqual(result);
    expect(h.classifier.preview).toHaveBeenCalledWith(request, stored);
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledWith({ where: { chatId: 'chat-1' } });
    expect(h.redis.incrementWithTtl).toHaveBeenCalledWith(
      `commercial-preview:v1:${user.userId}`,
      60,
    );
    expect(request).toEqual(before);
    expect(stored.commercialAdsPolicy).toBeNull();
    expect(h.prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('checks a missing settings row using the existing defaults without creating one', async () => {
    const h = harness();
    const request = { text: 'Сообщение', policy: null, enabled: false };
    await h.service.preview('chat-1', user, request);
    expect(h.classifier.preview).toHaveBeenCalledWith(request, DEFAULT_CHAT_SETTINGS);
    expect(h.prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('shares a bounded preview quota across chats for the authenticated actor', async () => {
    const h = harness();
    const request = { text: 'Сообщение', policy: null, enabled: true };
    h.redis.incrementWithTtl.mockResolvedValueOnce(8).mockResolvedValueOnce(9);
    await h.service.preview('chat-1', user, request);
    await expect(h.service.preview('chat-2', user, request)).resolves.toEqual(unavailable);
    expect(h.redis.incrementWithTtl.mock.calls).toEqual([
      [`commercial-preview:v1:${user.userId}`, 60],
      [`commercial-preview:v1:${user.userId}`, 60],
    ]);
    expect(h.classifier.preview).toHaveBeenCalledTimes(1);
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(1);
    expect(h.access.assertChatAdminAccess).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable admission separately from a passed check', async () => {
    const h = harness();
    h.redis.incrementWithTtl.mockRejectedValue(new Error('Redis unavailable'));
    await expect(
      h.service.preview('chat-1', user, { text: 'Сообщение', policy: null, enabled: true }),
    ).resolves.toEqual(unavailable);
    expect(h.classifier.preview).not.toHaveBeenCalled();
    expect(h.prisma.chatSettings.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { feedItemId: '' },
    { feedItemId: 'а'.repeat(201) },
    { feedItemId: 'feed-1', train: true },
  ])('rejects invalid feedback without reading or writing evidence: %j', async (body) => {
    const h = harness();
    await expect(h.service.feedback('chat-1', user, body)).rejects.toMatchObject({ status: 400 });
    expect(h.prisma.chatModerationFeedItem.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { id: 'feed-1', chatId: 'chat-2', ruleCode: 'COMMERCIAL_AD' },
    { id: 'feed-1', chatId: 'chat-1', ruleCode: 'RUSSIAN_PROFANITY' },
  ])('rejects missing, foreign or noncommercial feed rows without feedback writes', async (row) => {
    const h = harness();
    h.prisma.chatModerationFeedItem.findUnique.mockResolvedValue(row);
    await expect(
      h.service.feedback('chat-1', user, { feedItemId: 'feed-1' }),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(h.prisma.auditLog.createMany).not.toHaveBeenCalled();
    expect(h.classifier.preview).not.toHaveBeenCalled();
    expect(h.redis.incrementWithTtl).not.toHaveBeenCalled();
  });

  it.each(['COMMERCIAL_AD', 'COMMERCIAL_LLM_DELETE'])(
    'records a bounded administrator report for %s without classifier or settings effects',
    async (ruleCode) => {
      const h = harness();
      h.prisma.chatModerationFeedItem.findUnique.mockResolvedValue({
        id: 'feed-1',
        chatId: 'chat-1',
        ruleCode,
      });
      await expect(h.service.feedback('chat-1', user, { feedItemId: ' feed-1 ' })).resolves.toEqual(
        {
          ok: true,
        },
      );
      await h.service.feedback('chat-1', user, { feedItemId: 'feed-1' });
      const first = h.prisma.auditLog.createMany.mock.calls[0]![0]!;
      expect(first).toMatchObject({
        skipDuplicates: true,
        data: [
          {
            chatId: 'chat-1',
            actorUserId: user.userId,
            action: 'REPORT_COMMERCIAL_AD_ERROR',
            payload: { version: 1, feedItemId: 'feed-1', ruleCode },
          },
        ],
      });
      expect(h.prisma.auditLog.createMany.mock.calls[1]![0]).toEqual(first);
      await h.service.feedback(
        'chat-1',
        { ...user, userId: '111111111' },
        { feedItemId: 'feed-1' },
      );
      expect(h.prisma.auditLog.createMany.mock.calls[2]![0]).not.toEqual(first);
      expect(h.prisma.chatSettings.findUnique).not.toHaveBeenCalled();
      expect(h.classifier.preview).not.toHaveBeenCalled();
      expect(h.redis.incrementWithTtl).not.toHaveBeenCalled();
    },
  );
});
