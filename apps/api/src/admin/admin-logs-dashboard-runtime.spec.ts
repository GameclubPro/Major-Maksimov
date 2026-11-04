import { AdminLogsDashboardRuntime } from './admin-logs-dashboard-runtime';
import type { PrismaService } from '../prisma/prisma.service';
import { commercialAdsFeedbackId } from './commercial-ads-feedback';

describe('event feed cache freshness', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-18T12:00:00Z')));
  afterEach(() => jest.useRealTimers());

  function fixture() {
    const context = {
      prisma: {
        $queryRaw: jest.fn().mockResolvedValue([]),
        auditLog: {
          findMany: jest
            .fn<Promise<Array<{ id: string }>>, Parameters<PrismaService['auditLog']['findMany']>>()
            .mockResolvedValue([]),
        },
      },
      moderationFeedPageCache: new Map(),
      membershipActivityFeedPageCache: new Map(),
      assertReadOnlyChatAdmin: jest.fn().mockResolvedValue(undefined),
      ensureEntityType: jest.fn().mockResolvedValue(undefined),
      resolveUserProfiles: jest.fn().mockResolvedValue(new Map()),
      toIsoString: (value: string) => new Date(value).toISOString(),
      buildProfileMentionHandoffUrl: jest.fn().mockReturnValue(null),
    };
    const runtime = new AdminLogsDashboardRuntime(context as never);
    const actor = { userId: 'admin', username: null, displayName: null, chatTitle: null };
    return { context, runtime, actor };
  }

  it('reads each actor feedback after the shared page and refreshes acknowledgement on cache hits', async () => {
    const { context, runtime, actor } = fixture();
    context.prisma.$queryRaw.mockResolvedValue([
      {
        id: 'feed-1',
        userId: '123',
        userDisplayName: 'Анна',
        ruleCode: 'COMMERCIAL_AD',
        action: 'DELETE_MESSAGE',
        createdAt: new Date('2026-09-18T11:59:00Z'),
        maskedExcerpt: 'Объявление',
        metadata: { commercialCategories: ['SERVICES'] },
      },
    ]);
    const first = await runtime.getChatModerationFeed('chat', actor, { filter: 'COMMERCIAL' });
    expect(first.items[0]?.metadata?.commercialFeedbackReported).toBe(false);

    context.prisma.auditLog.findMany.mockResolvedValueOnce([
      { id: commercialAdsFeedbackId('chat', actor.userId, 'feed-1') },
    ]);
    const reported = await runtime.getChatModerationFeed('chat', actor, { filter: 'COMMERCIAL' });
    expect(reported.items[0]?.metadata?.commercialFeedbackReported).toBe(true);

    const secondActor = { ...actor, userId: 'another-admin' };
    const other = await runtime.getChatModerationFeed('chat', secondActor, {
      filter: 'COMMERCIAL',
    });
    expect(other.items[0]?.metadata?.commercialFeedbackReported).toBe(false);
    expect(first.items[0]?.metadata?.commercialFeedbackReported).toBe(false);
    expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(context.prisma.auditLog.findMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: [commercialAdsFeedbackId('chat', secondActor.userId, 'feed-1')] },
        chatId: 'chat',
        actorUserId: secondActor.userId,
        action: 'REPORT_COMMERCIAL_AD_ERROR',
      },
      select: { id: true },
    });
    expect(context.assertReadOnlyChatAdmin).toHaveBeenCalledTimes(3);
  });

  it.each(['getChatModerationFeed', 'getChatActivityFeed', 'getChannelActivityFeed'] as const)(
    '%s revalidates only the head after five seconds and still authorizes cache hits',
    async (method) => {
      const { context, runtime, actor } = fixture();
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: '2026-09-18T11:00:00Z', id: 'older' }),
      ).toString('base64url');
      await runtime[method]('chat', actor, {});
      await runtime[method]('chat', actor, { cursor });
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(4_999);
      await runtime[method]('chat', actor, {});
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(1);
      await runtime[method]('chat', actor, {});
      await runtime[method]('chat', actor, { cursor });
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect(context.assertReadOnlyChatAdmin).toHaveBeenCalledTimes(5);
      jest.advanceTimersByTime(25_000);
      await runtime[method]('chat', actor, { cursor });
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(4);
    },
  );

  it.each(['getChatModerationFeed', 'getChatActivityFeed'] as const)(
    '%s coalesces simultaneous reads and evicts rejected work',
    async (method) => {
      const { context, runtime, actor } = fixture();
      context.prisma.$queryRaw.mockRejectedValueOnce(new Error('transient read failure'));
      const failed = await Promise.allSettled([
        runtime[method]('chat', actor, {}),
        runtime[method]('chat', actor, {}),
      ]);
      expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(1);
      await runtime[method]('chat', actor, {});
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(2);
      context.assertReadOnlyChatAdmin.mockRejectedValueOnce(new Error('access revoked'));
      await expect(runtime[method]('chat', actor, {})).rejects.toThrow('access revoked');
      expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { chatId: 'other', range: '7d', filter: 'COMMERCIAL' },
    { chatId: 'chat', range: '30d', filter: 'COMMERCIAL' },
    { chatId: 'chat', range: '7d', filter: 'ALL' },
    {},
  ])('rejects commercial cursors outside the selected scope: %j', async (scope) => {
    const { context, runtime, actor } = fixture();
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: '2026-09-18T11:00:00Z',
        id: 'older',
        ...scope,
      }),
    ).toString('base64url');
    await expect(
      runtime.getChatModerationFeed('chat', actor, {
        filter: 'COMMERCIAL',
        range: '7d',
        cursor,
      }),
    ).rejects.toThrow('Обновите журнал');
    expect(context.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('accepts a commercial cursor only in its exact chat, range and filter', async () => {
    const { context, runtime, actor } = fixture();
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: '2026-09-18T11:00:00Z',
        id: 'older',
        chatId: 'chat',
        range: '7d',
        filter: 'COMMERCIAL',
      }),
    ).toString('base64url');
    await expect(
      runtime.getChatModerationFeed('chat', actor, {
        filter: 'COMMERCIAL',
        range: '7d',
        cursor,
      }),
    ).resolves.toEqual({ items: [], hasMore: false, nextCursor: null });
    expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
