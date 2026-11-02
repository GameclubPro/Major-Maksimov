import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, type Logger } from '@nestjs/common';
import {
  createPrismaAdapter,
  createPrismaClient,
  PrismaClient,
  type Prisma,
} from '../prisma/prisma-client';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { ModerationSanctionStateFenceService } from '../moderation/moderation-sanction-state-fence.service';
import {
  ModerationSanctionStateChangedError,
  type ModerationSanctionStateLockService,
} from '../moderation/moderation-sanction-state-lock.service';
import { readActiveLocalChatBan } from '../moderation/local-chat-ban';
import type { AdminManualModerationRuntimeContext } from './admin-manual-moderation-runtime-context';
import { AdminService } from './admin.service';
import { ChatSanctionsService } from './chat-sanctions.service';
import { createChatContextCacheMock, createConfigMock } from './admin-service-test-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type AdminTestBoundary = Pick<
  AdminManualModerationRuntimeContext,
  'deleteRecentTrackedMessagesForManualAction' | 'applyManualSystemBanFanout'
> & {
  logger: Logger;
  moderationSanctionStateLock: ModerationSanctionStateLockService;
};

type LocalBanPlanNode = {
  Plans?: LocalBanPlanNode[];
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
};

native('former participant sanctions on PostgreSQL and Redis', () => {
  let prisma: PrismaClient;
  let counters: RedisCounterService;
  let admin: AdminService;
  let boundary: AdminTestBoundary;
  let fence: ModerationSanctionStateFenceService;
  const chatId = `former-sanctions-${randomUUID()}`;
  const extraChatIds: string[] = [];
  const actor = { userId: 'admin', username: null, displayName: null, chatTitle: null };
  const options = {
    actorAlreadyVerified: true,
    targetDisplayNameHint: 'Участник',
    allowTargetDisplayNameRemoteLookup: false,
  };
  const max = {
    getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
      userId: 'bot',
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write', 'add_remove_members'],
    }),
    getChatMemberAccess: jest.fn().mockResolvedValue(null),
    banMember: jest.fn(),
    kickMember: jest.fn(),
    unbanMember: jest.fn(),
    attemptUnbanMember: jest.fn(),
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Former participant sanctions require disposable local stores');
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
    await prisma.chat.create({ data: { id: chatId, title: 'Former participant sanctions' } });
    counters = new RedisCounterService(new ConfigService({ REDIS_URL: redisUrl }));
    admin = new AdminService(
      prisma as never,
      max as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      counters,
    );
    boundary = admin as unknown as AdminTestBoundary;
    fence = new ModerationSanctionStateFenceService(prisma as never);
  });
  beforeEach(() => {
    max.getChatMemberAccess.mockReset().mockResolvedValue(null);
    for (const method of [max.banMember, max.kickMember, max.unbanMember, max.attemptUnbanMember])
      method.mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await admin?.onModuleDestroy();
    await counters?.onModuleDestroy();
    if (!prisma) return;
    const ownedChats = [chatId, ...extraChatIds];
    await prisma.chatMembershipActivityFeedItem.deleteMany({
      where: { chatId: { in: ownedChats } },
    });
    await prisma.chatModerationFeedItem.deleteMany({ where: { chatId: { in: ownedChats } } });
    await prisma.chat.deleteMany({ where: { id: { in: ownedChats } } });
    await prisma.$disconnect();
  });

  async function former(userId: string) {
    await prisma.chatMembershipActivityFeedItem.create({
      data: {
        canonicalKey: `${chatId}:${userId}`,
        sourceEventId: randomUUID(),
        chatId,
        userId,
        eventType: 'user_removed',
        eventAt: new Date(),
        sourceCreatedAt: new Date(),
      },
    });
  }

  function expectNoNativeMutation() {
    for (const method of [max.banMember, max.kickMember, max.unbanMember, max.attemptUnbanMember])
      expect(method).not.toHaveBeenCalled();
  }

  it('stores an absent member ban and releases it without any native mutation, including the button path', async () => {
    await former('banned');
    await expect(
      admin.applyManualModerationAction(
        chatId,
        'banned',
        actor,
        { action: 'BAN', scope: 'current_chat' },
        'miniapp',
        options,
      ),
    ).resolves.toMatchObject({ action: 'BAN', ok: true });
    const active = await readActiveLocalChatBan(prisma as never, fence, chatId, 'banned');
    expect(active).not.toBeNull();
    const page = await new ChatSanctionsService(prisma as never, fence).getPage(
      chatId,
      actor.userId,
      { userId: 'banned' },
    );
    expect(page.items[0]).toMatchObject({
      id: active!.id,
      banOnRejoin: true,
      releaseAction: 'UNBAN',
    });
    // FLAG: The callback supplies the experimental native-unban option. A local
    // release must take precedence even if the person has already returned.
    max.getChatMemberAccess.mockResolvedValueOnce({ userId: 'banned', isAdmin: false } as never);
    await expect(
      admin.applyManualModerationAction(
        chatId,
        'banned',
        actor,
        { action: 'UNBAN' },
        'group_command',
        { ...options, expectedSanctionEventId: active!.id, attemptUnbanWithRemove: true },
      ),
    ).resolves.toMatchObject({ action: 'UNBAN', message: 'Бан снят.' });
    expect(await readActiveLocalChatBan(prisma as never, fence, chatId, 'banned')).toBeNull();
    expectNoNativeMutation();
  });

  it.each([false, true])(
    'rejects a prepared local-ban transition before native unban (expected event: %s)',
    async (withExpectedEvent) => {
      const userId = `prepared-${withExpectedEvent}`;
      await former(userId);
      await admin.applyManualModerationAction(
        chatId,
        userId,
        actor,
        { action: 'BAN', scope: 'current_chat' },
        'miniapp',
        options,
      );
      const active = await readActiveLocalChatBan(prisma as never, fence, chatId, userId);
      expect(active).not.toBeNull();
      const prepared = await boundary.moderationSanctionStateLock.runExclusive(
        { chatId, userId },
        async (lease) => {
          await lease.assertOwned();
          return fence.prepare({
            chatId,
            userId,
            intendedAction: 'UNBAN',
            operator: 'ADMIN',
            source: 'native-test',
          });
        },
      );
      try {
        await expect(
          admin.applyManualModerationAction(
            chatId,
            userId,
            actor,
            { action: 'UNBAN' },
            'group_command',
            {
              ...options,
              attemptUnbanWithRemove: true,
              ...(withExpectedEvent ? { expectedSanctionEventId: active!.id } : {}),
            },
          ),
        ).rejects.toBeInstanceOf(ModerationSanctionStateChangedError);
        expect(
          await prisma.moderationEvent.count({
            where: { chatId, userId, ruleCode: 'MANUAL_UNBAN' },
          }),
        ).toBe(0);
        expect(
          await fence.isSanctionEventInvalidated({
            chatId,
            userId,
            sanctionEventId: active!.id,
            eventCreatedAt: active!.createdAt,
          }),
        ).toBe(true);
        expectNoNativeMutation();
      } finally {
        await boundary.moderationSanctionStateLock.runExclusive({ chatId, userId }, () =>
          fence.abort(prepared),
        );
      }
      expect(await readActiveLocalChatBan(prisma as never, fence, chatId, userId)).toMatchObject({
        id: active!.id,
      });
    },
  );

  it.each([false, true])(
    'rejects local release if the ban is replaced after its snapshot (expected event: %s)',
    async (withExpectedEvent) => {
      const userId = `replacement-${withExpectedEvent}`;
      await former(userId);
      await admin.applyManualModerationAction(
        chatId,
        userId,
        actor,
        { action: 'BAN', scope: 'current_chat' },
        'miniapp',
        options,
      );
      const original = await readActiveLocalChatBan(prisma as never, fence, chatId, userId);
      expect(original).not.toBeNull();
      const snapshotRead = deferred();
      const acquireReleaseLock = deferred();
      const lock = boundary.moderationSanctionStateLock;
      const runExclusive = lock.runExclusive.bind(lock);
      // FLAG: Pause only before lock acquisition. Both the replacement and the
      // stale release still acquire the real Redis sanction lock and read SQL.
      const waitForReplacement: ModerationSanctionStateLockService['runExclusive'] = async (
        subject,
        operation,
        lockOptions,
      ) => {
        snapshotRead.resolve();
        await acquireReleaseLock.promise;
        return runExclusive(subject, operation, lockOptions);
      };
      const lockSpy = jest.spyOn(lock, 'runExclusive').mockImplementationOnce(waitForReplacement);
      const releasing = admin
        .applyManualModerationAction(chatId, userId, actor, { action: 'UNBAN' }, 'group_command', {
          ...options,
          attemptUnbanWithRemove: true,
          ...(withExpectedEvent ? { expectedSanctionEventId: original!.id } : {}),
        })
        .catch((error: unknown) => error);
      let releaseOutcome: unknown;
      let replacementId: string | undefined;
      try {
        await Promise.race([
          snapshotRead.promise,
          releasing.then(() => {
            throw new Error('Local release finished before reaching the sanction lock');
          }),
        ]);
        await admin.applyManualModerationAction(
          chatId,
          userId,
          actor,
          { action: 'BAN', scope: 'current_chat' },
          'miniapp',
          options,
        );
        const replacement = await readActiveLocalChatBan(prisma as never, fence, chatId, userId);
        expect(replacement).not.toBeNull();
        expect(replacement!.id).not.toBe(original!.id);
        replacementId = replacement!.id;
      } finally {
        acquireReleaseLock.resolve();
        releaseOutcome = await releasing;
        lockSpy.mockRestore();
      }
      expect(releaseOutcome).toBeInstanceOf(ModerationSanctionStateChangedError);
      expect(await readActiveLocalChatBan(prisma as never, fence, chatId, userId)).toMatchObject({
        id: replacementId,
      });
      expect(
        await prisma.moderationEvent.count({
          where: { chatId, userId, ruleCode: 'MANUAL_UNBAN' },
        }),
      ).toBe(0);
      expectNoNativeMutation();
    },
  );

  it.each(['default', 'all_chats'] as const)(
    'persists the local ban when the fanout queue is unavailable and inline followups fail (%s scope)',
    async (scope) => {
      const userId = `followup-failure-${scope}`;
      await former(userId);
      const cleanup = jest
        .spyOn(boundary, 'deleteRecentTrackedMessagesForManualAction')
        .mockRejectedValueOnce(new Error('message cleanup unavailable'));
      const fanout = jest
        .spyOn(boundary, 'applyManualSystemBanFanout')
        .mockRejectedValueOnce(new Error('cross-chat fanout unavailable'));
      const warn = jest.spyOn(boundary.logger, 'warn').mockImplementation(() => {});
      await expect(
        admin.applyManualModerationAction(
          chatId,
          userId,
          actor,
          { action: 'BAN', ...(scope === 'all_chats' ? { scope } : {}) },
          'miniapp',
          options,
        ),
      ).resolves.toMatchObject({
        action: 'BAN',
        ok: true,
        message: 'Бан при возвращении включён.',
      });
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(fanout).toHaveBeenCalledWith(
        expect.objectContaining({ sourceChatId: chatId, targetUserId: userId, actor }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ targetUserId: userId, err: 'message cleanup unavailable' }),
        'Failed to run recent message cleanup after manual system ban',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ targetUserId: userId, err: 'cross-chat fanout unavailable' }),
        'Failed to run manual system ban fanout after source chat ban',
      );
      const active = await readActiveLocalChatBan(prisma as never, fence, chatId, userId);
      expect(active).not.toBeNull();
      const event = await prisma.moderationEvent.findUniqueOrThrow({ where: { id: active!.id } });
      expect(event.metadata).toMatchObject({
        mode: 'LOCAL_REJOIN',
        scope: 'all_chats',
        sourceMessageCleanup: {
          candidateCount: 0,
          deletedCount: 0,
          pendingCount: 0,
          failedCount: 0,
        },
        crossChatFanout: { removedChatsCount: 0, removedChatIds: [] },
      });
      expectNoNativeMutation();
    },
  );

  it('retains confirmed, pending and failed followup outcomes in the local ban journal', async () => {
    const userId = 'followup-partial';
    await former(userId);
    jest.spyOn(boundary, 'deleteRecentTrackedMessagesForManualAction').mockResolvedValueOnce({
      candidateMessageIds: ['deleted-message', 'pending-message', 'failed-message'],
      deletedMessageIds: ['deleted-message'],
      pendingMessageIds: ['pending-message'],
      failedMessageIds: ['failed-message'],
    });
    jest.spyOn(boundary, 'applyManualSystemBanFanout').mockResolvedValueOnce({
      removedChatIds: ['confirmed-chat'],
      skippedChatIds: ['skipped-chat'],
      failedChatIds: ['failed-chat'],
      deletedMessageCount: 2,
      failedMessageDeleteCount: 1,
    });
    await expect(
      admin.applyManualModerationAction(
        chatId,
        userId,
        actor,
        { action: 'BAN', scope: 'all_chats' },
        'miniapp',
        options,
      ),
    ).resolves.toMatchObject({ action: 'BAN', ok: true });
    const active = await readActiveLocalChatBan(prisma as never, fence, chatId, userId);
    expect(active).not.toBeNull();
    const event = await prisma.moderationEvent.findUniqueOrThrow({ where: { id: active!.id } });
    expect(event.metadata).toMatchObject({
      mode: 'LOCAL_REJOIN',
      scope: 'all_chats',
      sourceMessageCleanup: {
        candidateCount: 3,
        deletedCount: 1,
        pendingCount: 1,
        failedCount: 1,
      },
      crossChatFanout: {
        removedChatsCount: 1,
        removedChatIds: ['confirmed-chat'],
        skippedChatsCount: 1,
        skippedChatIds: ['skipped-chat'],
        failedChatsCount: 1,
        failedChatIds: ['failed-chat'],
        deletedMessageCount: 2,
        failedMessageDeleteCount: 1,
      },
    });
    expectNoNativeMutation();
  });

  it('stores a former member mute with expiry from assignment, then releases it while absent', async () => {
    await former('muted');
    const started = Date.now();
    await admin.applyManualModerationAction(
      chatId,
      'muted',
      actor,
      { action: 'MUTE', scope: 'current_chat', muteDurationHours: 6 },
      'miniapp',
      options,
    );
    const event = await prisma.moderationEvent.findFirstOrThrow({
      where: { chatId, userId: 'muted', action: 'MUTE' },
    });
    const expiry = Date.parse((event.metadata as { muteExpiresAt: string }).muteExpiresAt);
    expect(expiry).toBeGreaterThanOrEqual(started + 6 * 3_600_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 6 * 3_600_000);
    await admin.applyManualModerationAction(
      chatId,
      'muted',
      actor,
      { action: 'UNMUTE' },
      'miniapp',
      { ...options, expectedSanctionEventId: event.id },
    );
    const page = await new ChatSanctionsService(prisma as never, fence).getPage(
      chatId,
      actor.userId,
      { userId: 'muted', status: 'archive' },
    );
    expect(page.items[0]).toMatchObject({ id: event.id, status: 'released' });
  });

  it('rejects absent identities without chat history and preserves transient lookup failures', async () => {
    await expect(
      admin.applyManualModerationAction(
        chatId,
        'unrelated',
        actor,
        { action: 'BAN', scope: 'current_chat' },
        'miniapp',
        options,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    max.getChatMemberAccess.mockRejectedValueOnce(new Error('lookup unavailable'));
    await expect(
      admin.applyManualModerationAction(
        chatId,
        'unrelated',
        actor,
        { action: 'MUTE', muteDurationHours: 6 },
        'miniapp',
        options,
      ),
    ).rejects.toThrow();
    expect(
      await prisma.moderationEvent.count({
        where: { chatId, userId: 'unrelated', action: { in: ['BAN', 'MUTE'] } },
      }),
    ).toBe(0);
  });

  it('bounds actual local-ban state and fence queries under retained history and chat/user skew', async () => {
    const prefix = `${chatId}-plan`;
    const otherChatId = `${prefix}-other-chat`;
    extraChatIds.push(otherChatId);
    await prisma.chat.create({ data: { id: otherChatId, title: 'Local ban plan isolation' } });
    const bannedUserId = `${prefix}-banned`;
    const ordinaryUserId = `${prefix}-ordinary`;
    const releasedUserId = `${prefix}-released`;
    const activeEventId = `${prefix}-active-ban`;
    const now = new Date();
    const old = new Date(now.getTime() - 180 * 24 * 3_600_000);
    await prisma.moderationEvent.createMany({
      data: [
        {
          id: activeEventId,
          chatId,
          userId: bannedUserId,
          eventType: 'MEMBER_ACTION',
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
          operator: 'ADMIN',
          metadata: { mode: 'LOCAL_REJOIN', permanent: true },
          createdAt: old,
        },
        {
          id: `${prefix}-released-ban`,
          chatId,
          userId: releasedUserId,
          eventType: 'MEMBER_ACTION',
          ruleCode: 'MANUAL_BAN',
          action: 'BAN',
          operator: 'ADMIN',
          metadata: { mode: 'LOCAL_REJOIN', permanent: true },
          createdAt: old,
        },
        {
          id: `${prefix}-release`,
          chatId,
          userId: releasedUserId,
          eventType: 'MEMBER_ACTION',
          ruleCode: 'MANUAL_UNBAN',
          action: 'NONE',
          operator: 'ADMIN',
          createdAt: now,
        },
      ],
    });
    // FLAG: Both ordinary target history and unrelated same-chat fences are
    // newer than the ban. LIMIT alone must not hide scanning that retained history.
    expect(
      await prisma.$executeRaw`
      INSERT INTO moderation_events
        (id, chat_id, user_id, event_type, rule_code, action, operator, metadata, created_at)
      SELECT ${prefix} || '-history-' || kind || '-' || n,
        CASE WHEN kind = 4 THEN ${otherChatId} ELSE ${chatId} END,
        CASE kind
          WHEN 1 THEN ${bannedUserId}
          WHEN 2 THEN ${ordinaryUserId}
          WHEN 3 THEN ${prefix} || '-other-user-' || n
          WHEN 4 THEN ${bannedUserId}
          ELSE ${prefix} || '-fence-user-' || n
        END,
        'SYSTEM'::"EventType",
        CASE
          WHEN kind IN (1, 2) THEN 'PROFANITY'
          WHEN kind = 3 THEN 'MANUAL_MUTE'
          WHEN kind = 4 THEN 'MANUAL_BAN'
          ELSE 'SANCTION_STATE_FENCE'
        END,
        (CASE
          WHEN kind IN (1, 2) THEN 'WARN'
          WHEN kind = 3 THEN 'MUTE'
          WHEN kind = 4 THEN 'BAN'
          ELSE 'NONE'
        END)::"SanctionAction",
        'ADMIN'::"Operator",
        CASE
          WHEN kind = 3 THEN '{"mutePermanent":true}'::jsonb
          WHEN kind = 4 THEN '{"mode":"MAX_BLOCK"}'::jsonb
          WHEN kind = 5 THEN jsonb_build_object(
            'version', 1, 'transitionId', ${prefix} || '-transition-' || n,
            'intendedAction', 'UNBAN', 'phase', 'PREPARED',
            'invalidatedSanctionEventIds', jsonb_build_array(${prefix} || '-other-ban-' || n)
          )
          ELSE '{}'::jsonb
        END,
        ${now}::timestamp - (n % 3600) * interval '1 second'
      FROM generate_series(1, 5) AS categories(kind)
      CROSS JOIN generate_series(1, 4000) AS history(n)
    `,
    ).toBe(20_000);
    await prisma.$executeRaw`ANALYZE moderation_events`;

    const observed = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 1, statement_timeout: 10_000 }),
      log: [{ emit: 'event', level: 'query' }],
    });
    const queries: Prisma.QueryEvent[] = [];
    observed.$on('query', (event) => queries.push(event));
    try {
      const observedFence = new ModerationSanctionStateFenceService(observed as never);
      await expect(
        readActiveLocalChatBan(observed as never, observedFence, chatId, bannedUserId),
      ).resolves.toMatchObject({ id: activeEventId });
      await expect(
        readActiveLocalChatBan(observed as never, observedFence, chatId, ordinaryUserId),
      ).resolves.toBeNull();
      await expect(
        readActiveLocalChatBan(observed as never, observedFence, chatId, releasedUserId),
      ).resolves.toBeNull();
      const reads = queries.filter(
        (event) =>
          event.query.trimStart().startsWith('SELECT') &&
          event.query.includes('"moderation_events"'),
      );
      expect(reads).toHaveLength(4);
      expect(reads.filter((event) => event.params.includes('SANCTION_STATE_FENCE'))).toHaveLength(
        1,
      );
      const visit = (node: LocalBanPlanNode): LocalBanPlanNode[] => [
        node,
        ...(node.Plans ?? []).flatMap(visit),
      ];
      for (const event of reads) {
        // FLAG: EXPLAIN ANALYZE executes only the exact captured SELECT in this
        // disposable localhost race_test database; no planner switches are forced.
        const plan = await observed.$queryRawUnsafe<
          Array<{ 'QUERY PLAN': Array<{ Plan: LocalBanPlanNode }> }>
        >(
          `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${event.query}`,
          ...(JSON.parse(event.params) as unknown[]),
        );
        const root = plan[0]!['QUERY PLAN'][0]!.Plan;
        const nodes = visit(root);
        const scans = nodes.filter((node) => node['Node Type'].includes('Scan'));
        try {
          expect(scans.length).toBeGreaterThan(0);
          expect(nodes.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
          expect(root['Actual Rows']).toBeLessThanOrEqual(1);
          for (const scan of scans) {
            const examined =
              (scan['Actual Rows'] +
                (scan['Rows Removed by Filter'] ?? 0) +
                (scan['Rows Removed by Index Recheck'] ?? 0)) *
              scan['Actual Loops'];
            expect(examined).toBeLessThanOrEqual(8);
          }
          expect(
            (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
          ).toBeLessThanOrEqual(64);
          if (!event.params.includes('SANCTION_STATE_FENCE')) {
            const stateIndex = nodes.find(
              (node) => node['Index Name'] === 'moderation_events_sanction_user_state_idx',
            );
            expect(stateIndex).toBeDefined();
            expect(stateIndex!['Index Cond']).toContain('chat_id');
            expect(stateIndex!['Index Cond']).toContain('user_id');
          } else {
            const fenceIndex = nodes.find(
              (node) => node['Index Name'] === 'moderation_events_sanction_user_fence_idx',
            );
            expect(fenceIndex).toBeDefined();
            expect(fenceIndex!['Index Cond']).toContain('chat_id');
            expect(fenceIndex!['Index Cond']).toContain('user_id');
          }
        } catch (cause) {
          throw new Error(`Local-ban lookup exceeded work bounds: ${JSON.stringify(plan)}`, {
            cause,
          });
        }
      }
    } finally {
      await observed.$disconnect();
    }
  }, 60_000);
});
