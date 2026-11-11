import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { chatSummarySchema } from '@maxim/contracts';
import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { MaxActionLedgerService } from './max-action-ledger.service';
import { buildMaxActionIdempotencyKey } from './max-action-idempotency';
import { MaxApiInternalRateLimitError, type MaxActionJob } from './max-client.service';
import { normalizeMaxApiRateLimitServiceScope } from './max-api-metrics-key.util';
import {
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
  wasMaxPreDispatchGuardRejected,
} from './max-action-pre-dispatch-guard';
import { wasMaxMemberMutationAttempted } from './max-member-error.util';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { ModerationSanctionStateLockService } from '../moderation/moderation-sanction-state-lock.service';
import { MaxActionLedgerWatchdogService } from '../system/max-action-ledger-watchdog.service';
import { AdminService } from '../admin/admin.service';
import { BotCapabilityCheckUnavailableException } from '../admin/bot-capability-required.error';
import type { AdminManualModerationRuntimeContext } from '../admin/admin-manual-moderation-runtime-context';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../webhook/webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const stores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

function fixtureAdmissionFailureKeys(botId: string): string[] {
  return [
    `maxapi:gcra:v1:bot:${botId}:all:cooldown`,
    `maxapi:circuit:v1:${botId}:failures`,
    `maxapi:circuit:v1:${botId}:open-until`,
    `maxapi:circuit:v1:${botId}:half-open-probe`,
  ];
}

type ManualBanFanout = Pick<AdminManualModerationRuntimeContext, 'applyManualSystemBanFanout'>;
type ManualBanFanoutInput = Parameters<ManualBanFanout['applyManualSystemBanFanout']>[0];

async function withManualModeration<T>(
  s: MultibotHarness,
  operation: (admin: AdminService, counters: RedisCounterService) => Promise<T>,
): Promise<T> {
  s.config.set('MAX_BOT_TOKEN', s.bots[0]!.token);
  const counters = new RedisCounterService(s.config);
  let admin: AdminService | undefined;
  try {
    admin = new AdminService(
      s.prisma as never,
      s.max,
      s.cache,
      s.config,
      undefined,
      counters,
      undefined,
      undefined,
      s.links,
      s.registry as never,
    );
    return await operation(admin, counters);
  } finally {
    await admin?.onModuleDestroy();
    await counters.onModuleDestroy();
  }
}

async function runManualActionAfterLockWait(
  s: MultibotHarness,
  chatId: string,
  action: (admin: AdminService) => ReturnType<AdminService['applyManualModerationAction']>,
  whileWaiting: () => Promise<void>,
) {
  let signalAcquired!: () => void;
  let releaseLock!: () => void;
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const blocker = new ModerationSanctionStateLockService(s.counters).runExclusive(
    { chatId, userId: 'fixture-user' },
    async () => {
      signalAcquired();
      await held;
    },
  );
  try {
    await Promise.race([acquired, blocker]);
    return await withManualModeration(s, async (admin, counters) => {
      let signalWaiting!: () => void;
      const waiting = new Promise<void>((resolve) => {
        signalWaiting = resolve;
      });
      const acquireLock = counters.acquireLockBeforeDeadline.bind(counters);
      const acquisition = jest
        .spyOn(counters, 'acquireLockBeforeDeadline')
        .mockImplementation(async (...args) => {
          const result = await acquireLock(...args);
          if (result.kind === 'busy') signalWaiting();
          return result;
        });
      const outcome = action(admin).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      try {
        await Promise.race([
          waiting,
          outcome.then(() => {
            throw new Error('Manual BAN completed before sanction lock contention');
          }),
        ]);
        await whileWaiting();
        releaseLock();
        await blocker;
        return await outcome;
      } finally {
        releaseLock();
        await blocker;
        await outcome;
        acquisition.mockRestore();
      }
    });
  } finally {
    releaseLock();
    await blocker;
  }
}

function applyChannelBan(admin: AdminService, chatId: string, preferredBotId?: string) {
  return admin.applyManualModerationAction(
    chatId,
    'fixture-user',
    { userId: 'fixture-admin', username: null, displayName: null, chatTitle: null },
    { action: 'BAN', scope: 'current_chat' },
    'miniapp',
    {
      actorAlreadyVerified: true,
      entityType: ChatEntityType.CHANNEL,
      targetDisplayNameHint: 'Fixture user',
      allowTargetDisplayNameRemoteLookup: false,
      ...(preferredBotId ? { preferredBotId } : {}),
    },
  );
}

async function withManualBanFanout(
  s: MultibotHarness,
  chatId: string,
  operation: (fanout: ManualBanFanout, params: ManualBanFanoutInput) => Promise<void>,
): Promise<void> {
  s.config.set('MAX_BOT_TOKEN', s.bots[0]!.token);
  const counters = new RedisCounterService(s.config);
  let admin: AdminService | undefined;
  try {
    admin = new AdminService(
      s.prisma as never,
      s.max,
      s.cache,
      s.config,
      undefined,
      counters,
      undefined,
      undefined,
      s.links,
    );
    await operation(admin as unknown as ManualBanFanout, {
      jobId: `native-reban-${randomUUID()}`,
      sourceChatId: chatId,
      targetUserId: 'fixture-user',
      actor: { userId: 'fixture-admin', username: null, displayName: null, chatTitle: null },
      targetChats: [
        chatSummarySchema.parse({
          id: chatId,
          title: 'Fixture',
          createdAt: new Date().toISOString(),
        }),
      ],
    });
  } finally {
    await admin?.onModuleDestroy();
    await counters.onModuleDestroy();
  }
}

stores('shared production member identity on PostgreSQL/Redis/BullMQ', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    const owned = h;
    h = undefined;
    try {
      // FLAG: These serial local fixtures reuse exact bot ids. Retain no failure history
      // from their simulated attempted timeouts in the next fixture's admission state.
      if (owned)
        await owned.redis.del(...owned.bots.flatMap((bot) => fixtureAdmissionFailureKeys(bot.id)));
    } finally {
      await owned?.dispose();
    }
  });
  async function fixture(bots = 4, entityType: ChatEntityType = ChatEntityType.CHAT) {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' });
    if (entityType === ChatEntityType.CHANNEL)
      for (const bot of h.bots)
        h.setBotPermissions(bot.id, ['read_all_messages', 'delete', 'add_remove_members']);
    const [chatId] = await h.seedCatalog(1, {}, entityType);
    return { s: h, chatId: chatId! };
  }
  function job(
    chatId: string,
    botId: string,
    actionType: 'BAN_MEMBER' | 'KICK_MEMBER' | 'TRY_UNBAN_MEMBER' = 'BAN_MEMBER',
  ): MaxActionJob {
    return {
      actionType,
      chatId,
      userId: 'fixture-user',
      botId,
      idempotencyKey: `member-${randomUUID()}`,
      attempt: 1,
      createdAt: new Date().toISOString(),
    };
  }

  it.each(['candidate', 'preferred'] as const)(
    'uses fresh manual channel rights evidence despite a cached member-management denial via %s selection',
    async (selection) => {
      const { s, chatId } = await fixture(1, ChatEntityType.CHANNEL);
      const botId = s.bots[0]!.id;
      s.setBotPermissions(botId, ['read_all_messages', 'delete']);
      const cached = await s.max.getCurrentChatMemberAccess(chatId, { botId });
      expect(cached.permissions).not.toContain('add_remove_members');
      s.setBotPermissions(botId, ['read_all_messages', 'delete', 'add_remove_members']);
      const ownMemberReads = () =>
        s.requests.filter(
          (call) => call.method === 'get' && call.path === `/chats/${chatId}/members/me`,
        );
      const readsBeforeAction = ownMemberReads().length;

      await withManualModeration(s, async (admin) => {
        await expect(
          applyChannelBan(admin, chatId, selection === 'preferred' ? botId : undefined),
        ).resolves.toMatchObject({
          message: 'Бан включён.',
        });
      });

      expect(s.effects).toMatchObject([
        { method: 'delete', path: `/chats/${chatId}/members`, botId, params: { block: true } },
      ]);
      expect(ownMemberReads()).toHaveLength(readsBeforeAction + 1);
      expect(await s.max.getCurrentChatMemberAccess(chatId, { botId })).toMatchObject({
        permissions: cached.permissions,
      });
      expect(ownMemberReads()).toHaveLength(readsBeforeAction + 1);
      expect(
        await s.prisma.moderationEvent.count({ where: { chatId, ruleCode: 'MANUAL_BAN' } }),
      ).toBe(1);
    },
  );

  it('rejects fresh manual channel rights denial despite cached member-management permission', async () => {
    const { s, chatId } = await fixture(1, ChatEntityType.CHANNEL);
    const botId = s.bots[0]!.id;
    const cached = await s.max.getCurrentChatMemberAccess(chatId, { botId });
    expect(cached.permissions).toContain('add_remove_members');
    s.setBotPermissions(botId, ['read_all_messages', 'delete']);

    await withManualModeration(s, async (admin) => {
      const error: unknown = await applyChannelBan(admin, chatId).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(BotCapabilityCheckUnavailableException);
      if (!(error instanceof BotCapabilityCheckUnavailableException)) throw error;
      expect(error.getResponse()).toMatchObject({
        statusCode: 503,
        code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
        operation: 'member_moderation',
      });
      expect(error.getResponse()).not.toHaveProperty('missingPermissions');
    });

    expect(s.effects).toEqual([]);
    expect(
      s.requests.filter(
        (call) => call.method === 'delete' && call.path === `/chats/${chatId}/members`,
      ),
    ).toEqual([]);
    expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
    expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(0);
  });

  it('rejects manual channel rights evidence revoked while waiting for the real sanction lock', async () => {
    const { s, chatId } = await fixture(1, ChatEntityType.CHANNEL);
    const botId = s.bots[0]!.id;
    await s.max.getCurrentChatMemberAccess(chatId, { botId });
    const banMember = s.max.banMember.bind(s.max);
    let dispatchRejection: unknown;
    const mutation = jest.spyOn(s.max, 'banMember').mockImplementation(async (...args) => {
      try {
        return await banMember(...args);
      } catch (error: unknown) {
        dispatchRejection = error;
        throw error;
      }
    });
    try {
      const outcome = await runManualActionAfterLockWait(
        s,
        chatId,
        (admin) => applyChannelBan(admin, chatId),
        () => s.demote(chatId, botId),
      );
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: expect.any(Error),
      });
      expect(dispatchRejection).toMatchObject({ code: 'max_action_executor_proof_rejected' });
    } finally {
      mutation.mockRestore();
    }

    expect(s.effects).toEqual([]);
    expect(
      s.requests.filter(
        (call) => call.method === 'delete' && call.path === `/chats/${chatId}/members`,
      ),
    ).toEqual([]);
    expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
    expect(
      await s.prisma.maxActionLedgerEntry.count({ where: { chatId, status: 'SUCCEEDED' } }),
    ).toBe(0);
  });

  it('rejects former-participant local ban after manual chat rights are revoked during sanction lock wait', async () => {
    const { s, chatId } = await fixture(1);
    const botId = s.bots[0]!.id;
    s.setChatMemberAbsent(chatId, 'fixture-user', true);
    const canonicalKey = `${chatId}:fixture-user`;
    await s.prisma.chatMembershipActivityFeedItem.create({
      data: {
        canonicalKey,
        sourceEventId: randomUUID(),
        botId,
        chatId,
        userId: 'fixture-user',
        eventType: 'user_removed',
        eventAt: new Date(),
        sourceCreatedAt: new Date(),
      },
    });
    try {
      expect(
        await s.max.getChatMemberAccess(chatId, 'fixture-user', { botId, bypassCache: true }),
      ).toBeNull();
      expect(
        await s.links.getFreshChatBotExecutionProof({ chatId, botId, purpose: 'moderate_member' }),
      ).not.toBeNull();

      const outcome = await runManualActionAfterLockWait(
        s,
        chatId,
        (admin) =>
          admin.applyManualModerationAction(
            chatId,
            'fixture-user',
            { userId: 'fixture-admin', username: null, displayName: null, chatTitle: null },
            { action: 'BAN', scope: 'current_chat' },
            'miniapp',
            {
              actorAlreadyVerified: true,
              entityType: ChatEntityType.CHAT,
              targetDisplayNameHint: 'Fixture user',
              allowTargetDisplayNameRemoteLookup: false,
            },
          ),
        async () => {
          const permissions = ['read_all_messages', 'write'];
          s.setBotPermissions(botId, permissions);
          expect(
            await s.links.recordBotAccessProbe({
              chatId,
              botId,
              access: { isAdmin: true, isOwner: false, permissionsKnown: true, permissions },
              checkedAt: new Date(),
              source: 'fixture-member-management-revoked',
              allowMembershipRecovery: false,
            }),
          ).toBe(true);
          await s.cache.invalidate(chatId);
          expect(
            await s.links.getFreshChatBotExecutionProof({
              chatId,
              botId,
              purpose: 'moderate_member',
            }),
          ).toBeNull();
          expect(
            await s.links.getFreshChatBotExecutionProof({
              chatId,
              botId,
              purpose: 'delete_message',
            }),
          ).not.toBeNull();
        },
      );

      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: expect.any(BotCapabilityCheckUnavailableException),
      });
      if (
        outcome.status !== 'rejected' ||
        !(outcome.reason instanceof BotCapabilityCheckUnavailableException)
      )
        throw new Error('Expected unavailable current member authority');
      expect(outcome.reason.getResponse()).toMatchObject({
        statusCode: 503,
        code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
        operation: 'member_moderation',
      });
      expect(outcome.reason.getResponse()).not.toHaveProperty('missingPermissions');
      expect(s.effects).toEqual([]);
      expect(
        s.requests.filter(
          (call) => call.method === 'delete' && call.path === `/chats/${chatId}/members`,
        ),
      ).toEqual([]);
      expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(0);
    } finally {
      await s.prisma.chatMembershipActivityFeedItem.deleteMany({ where: { canonicalKey } });
    }
  });

  it.each(
    [1, 4, 9, 3, 6, 12].flatMap((bots) =>
      (['BAN_MEMBER', 'KICK_MEMBER'] as const).map((actionType) => ({ bots, actionType })),
    ),
  )(
    'does not repeat an unknown $actionType with $bots bots through real moderation wrappers',
    async ({ bots, actionType }) => {
      const { s, chatId } = await fixture(bots);
      const moderation = s.moderation as unknown as {
        banMemberImmediatelyWithResult(chatId: string, userId: string): Promise<{ ok: boolean }>;
        kickMemberImmediately(chatId: string, userId: string): Promise<boolean>;
      };
      const execute = async () =>
        actionType === 'BAN_MEMBER'
          ? (await moderation.banMemberImmediatelyWithResult(chatId, 'fixture-user')).ok
          : moderation.kickMemberImmediately(chatId, 'fixture-user');
      s.ambiguousNextMemberMutation();
      await expect(execute()).rejects.toThrow(`Ambiguous MAX ${actionType} transport failure`);
      for (const bot of s.bots.slice(0, bots === 1 ? 1 : -1)) await s.demote(chatId, bot.id);
      if (bots === 1) expect(await execute()).toBe(false);
      else
        await expect(execute()).rejects.toThrow(
          actionType === 'BAN_MEMBER'
            ? 'no longer executable (AMBIGUOUS)'
            : 'Retained member action requires settlement',
        );
      const effects = s.effects.filter(
        (item) => item.method === 'delete' && item.path === `/chats/${chatId}/members`,
      );
      expect(effects).toHaveLength(1);
      const rows = await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'AMBIGUOUS', ambiguous: true, attemptCount: 1 });
    },
  );

  it('atomically claims one member operation across independently constructed ledger services', async () => {
    const { s, chatId } = await fixture();
    const first = job(chatId, s.bots[0]!.id, 'BAN_MEMBER');
    const second = job(chatId, s.bots[3]!.id, 'KICK_MEMBER');
    const outcomes = await Promise.allSettled([
      new MaxActionLedgerService(s.prisma as never).recordStarted(first),
      new MaxActionLedgerService(s.prisma as never).recordStarted(second),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(
      await s.prisma.maxActionLedgerEntry.count({ where: { chatId, status: 'IN_PROGRESS' } }),
    ).toBe(1);
  });

  it.each(['IN_PROGRESS', 'AMBIGUOUS', 'SUCCEEDED'] as const)(
    'fences retained legacy bot-scoped BAN with %s under a new identity',
    async (status) => {
      const { s, chatId } = await fixture();
      const prior = job(chatId, s.bots[0]!.id);
      await s.prisma.maxActionLedgerEntry.create({
        data: {
          jobId: prior.idempotencyKey,
          actionType: 'BAN_MEMBER',
          chatId,
          userId: prior.userId,
          botId: prior.botId,
          status,
          ambiguous: status === 'AMBIGUOUS',
          terminal: status !== 'IN_PROGRESS',
          attemptCount: 1,
          firstAttemptAt: new Date(),
          lastAttemptAt: new Date(),
        },
      });
      await expect(
        s.max.banMember(chatId, 'fixture-user', { botId: s.bots[3]!.id, immediate: true }),
      ).rejects.toThrow('Retained member action requires settlement');
      expect(s.effects).toHaveLength(0);
      expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(1);
    },
  );

  it('allows a fresh ban only after confirmed unban clears the old terminal BAN evidence', async () => {
    const { s, chatId } = await fixture();
    await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[0]!.id, immediate: true });
    await expect(
      s.max.banMember(chatId, 'fixture-user', { botId: s.bots[3]!.id, immediate: true }),
    ).rejects.toThrow('no longer executable');
    // FLAG: MAX retired API restoration; this fixture models confirmed external unban.
    await s.max.clearTerminalBanStateAfterConfirmedUnban(chatId, 'fixture-user');
    await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[3]!.id, immediate: true });
    expect(s.effects.filter((item) => item.params?.block === true)).toHaveLength(2);
  });

  it('reapplies manual ban fanout after a fresh native-unban membership confirmation', async () => {
    const { s, chatId } = await fixture();
    await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[0]!.id, immediate: true });
    // FLAG: The synthetic MAX member endpoint now confirms the participant is present;
    // PostgreSQL retains the successful earlier BAN as after an external native unban.
    const memberProbe = jest.spyOn(s.max, 'getChatMemberAccess');
    try {
      await withManualBanFanout(s, chatId, async (fanout, params) => {
        await expect(fanout.applyManualSystemBanFanout(params)).resolves.toMatchObject({
          removedChatIds: [chatId],
          failedChatIds: [],
        });
        await expect(fanout.applyManualSystemBanFanout(params)).resolves.toMatchObject({
          removedChatIds: [chatId],
          failedChatIds: [],
        });
        expect(memberProbe).toHaveBeenCalledTimes(1);
        expect(memberProbe).toHaveBeenCalledWith(
          chatId,
          'fixture-user',
          expect.objectContaining({ bypassCache: true, botId: s.bots[0]!.id }),
        );
        expect(s.effects.filter((item) => item.params?.block === true)).toHaveLength(2);
      });
    } finally {
      memberProbe.mockRestore();
    }
  });

  it.each(['absent', 'protected', 'unavailable'] as const)(
    'preserves the successful BAN when fresh fanout membership is %s',
    async (state) => {
      const { s, chatId } = await fixture();
      await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[0]!.id, immediate: true });
      const before = await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } });
      const memberProbe = jest.spyOn(s.max, 'getChatMemberAccess');
      if (state === 'absent') memberProbe.mockResolvedValue(null);
      else if (state === 'unavailable')
        memberProbe.mockRejectedValue(new Error('Member read unavailable'));
      else s.allowAdminUser('fixture-user');
      try {
        await withManualBanFanout(s, chatId, async (fanout, params) => {
          const result = await fanout.applyManualSystemBanFanout(params);
          expect(result.removedChatIds).toEqual([]);
          expect(result.skippedChatIds).toEqual(state === 'unavailable' ? [] : [chatId]);
          expect(result.retryableFailedChatIds).toEqual(state === 'unavailable' ? [chatId] : []);
          expect(await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } })).toEqual(
            before,
          );
          expect(s.effects.filter((item) => item.params?.block === true)).toHaveLength(1);
        });
      } finally {
        memberProbe.mockRestore();
      }
    },
  );

  it.each(['IN_PROGRESS', 'AMBIGUOUS'] as const)(
    'retains attempted %s BAN evidence after a fresh member confirmation',
    async (status) => {
      const { s, chatId } = await fixture();
      const prior = job(chatId, s.bots[0]!.id);
      await s.prisma.maxActionLedgerEntry.create({
        data: {
          jobId: prior.idempotencyKey,
          actionType: 'BAN_MEMBER',
          chatId,
          userId: prior.userId,
          botId: prior.botId,
          status,
          ambiguous: status === 'AMBIGUOUS',
          terminal: status !== 'IN_PROGRESS',
          attemptCount: 1,
          firstAttemptAt: new Date(),
          lastAttemptAt: new Date(),
        },
      });
      const before = await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } });
      await withManualBanFanout(s, chatId, async (fanout, params) => {
        await expect(fanout.applyManualSystemBanFanout(params)).resolves.toMatchObject({
          removedChatIds: [],
          failedChatIds: [chatId],
        });
        expect(await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } })).toEqual(before);
        expect(s.effects).toHaveLength(0);
      });
    },
  );

  it.each([0, 1])('retains a BAN completed %s ms after the confirmation cutoff', async (offset) => {
    const { s, chatId } = await fixture();
    await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[0]!.id, immediate: true });
    const before = await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } });
    const completedAt = before[0]!.completedAt!;
    await s.max.clearTerminalBanStateAfterConfirmedUnban(
      chatId,
      'fixture-user',
      new Date(completedAt.getTime() - offset),
    );
    expect(await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } })).toEqual(before);
    await expect(
      s.max.banMember(chatId, 'fixture-user', { botId: s.bots[3]!.id, immediate: true }),
    ).rejects.toThrow('no longer executable');
    expect(s.effects.filter((item) => item.params?.block === true)).toHaveLength(1);
  });

  it.each(
    [
      { name: 'confirmed success', status: 'SUCCEEDED', cleared: true },
      { name: 'confirmed skip', status: 'SKIPPED', cleared: true },
      {
        name: 'definitive terminal access rejection',
        status: 'FAILED_TERMINAL',
        lastStatusCode: 403,
        lastErrorCode: 'access.denied',
        cleared: true,
      },
      {
        name: 'definitive HTTP404 rejection',
        status: 'FAILED_TERMINAL',
        lastStatusCode: 404,
        lastErrorCode: 'max_http_404',
        cleared: true,
      },
      {
        name: 'definitive null-status chat-not-found rejection',
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'chat.not.found',
        cleared: true,
      },
      {
        name: 'documented HTTP200 already-deleted rejection',
        status: 'FAILED_TERMINAL',
        lastStatusCode: 200,
        lastErrorCode: 'max_member_already_deleted',
        cleared: true,
      },
      {
        name: 'documented HTTP200 insufficient-rights rejection',
        status: 'FAILED_TERMINAL',
        lastStatusCode: 200,
        lastErrorCode: 'max_member_insufficient_rights',
        cleared: true,
      },
      {
        name: 'documented HTTP200 combined member rejection',
        status: 'FAILED_TERMINAL',
        lastStatusCode: 200,
        lastErrorCode: 'max_member_already_deleted_or_insufficient_rights',
        cleared: true,
      },
      {
        name: 'generic HTTP200 attempted failure',
        status: 'FAILED_TERMINAL',
        lastStatusCode: 200,
        lastErrorCode: 'max_ban_member_failed',
        cleared: false,
      },
      {
        name: 'exhausted certified pre-dispatch rejection',
        status: 'FAILED_RETRYABLE',
        lastErrorCode: MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
        cleared: true,
      },
      {
        name: 'exhausted unattempted failure',
        status: 'FAILED_RETRYABLE',
        unattempted: true,
        cleared: true,
      },
      {
        name: 'generic attempted retryable failure',
        status: 'FAILED_RETRYABLE',
        lastErrorCode: 'server.failure',
        cleared: false,
      },
      {
        name: 'watchdog definitive null-status rejection',
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'ledger.watchdog.retry_orphan_non_retryable',
        cleared: true,
      },
      {
        name: 'watchdog definitive HTTP200 rejection',
        status: 'FAILED_TERMINAL',
        lastStatusCode: 200,
        lastErrorCode: 'ledger.watchdog.retry_orphan_non_retryable',
        cleared: true,
      },
      {
        name: 'watchdog expired attempted failure',
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'ledger.watchdog.retry_orphan_expired',
        cleared: false,
      },
      {
        name: 'watchdog unattempted orphan',
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'ledger.watchdog.pre_dispatch_orphan',
        unattempted: true,
        cleared: true,
      },
      {
        name: 'watchdog orphan with retained attempt evidence',
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'ledger.watchdog.pre_dispatch_orphan',
        cleared: false,
      },
      {
        name: 'zero-attempt failure with retained dispatch evidence',
        status: 'FAILED_TERMINAL',
        unattempted: true,
        dispatched: true,
        cleared: false,
      },
      { name: 'ambiguous success flag', status: 'SUCCEEDED', ambiguous: true, cleared: false },
      {
        name: 'unproved attempted terminal failure',
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'server.failure',
        cleared: false,
      },
      { name: 'ambiguous effect', status: 'AMBIGUOUS', ambiguous: true, cleared: false },
      { name: 'ambiguous status without its flag', status: 'AMBIGUOUS', cleared: false },
      { name: 'unfinished attempt', status: 'IN_PROGRESS', terminal: false, cleared: false },
    ].flatMap((item) => {
      const statuses = item.status.startsWith('FAILED_')
        ? ['FAILED_TERMINAL', 'FAILED_RETRYABLE']
        : [item.status];
      return statuses.flatMap((status) =>
        (['legacy', 'cutoff'] as const).map((mode) => ({
          ...item,
          mode,
          status: status as Prisma.MaxActionLedgerEntryUncheckedCreateInput['status'],
          cleared:
            mode === 'cutoff' ? status === 'SUCCEEDED' && item.ambiguous !== true : item.cleared,
        })),
      );
    }),
  )('reconciles $name ($status) through the $mode confirmed-unban contract', async (item) => {
    const { s, chatId } = await fixture();
    const jobId = buildMaxActionIdempotencyKey('logical', ['BAN_MEMBER', chatId, 'fixture-user']);
    const attemptedAt = new Date(Date.now() - 5_000);
    const before = await s.prisma.maxActionLedgerEntry.create({
      data: {
        jobId,
        actionType: 'BAN_MEMBER',
        chatId,
        userId: 'fixture-user',
        botId: s.bots[0]!.id,
        status: item.status,
        ambiguous: item.ambiguous ?? false,
        terminal: item.terminal ?? true,
        attemptCount: item.unattempted ? 0 : 1,
        firstAttemptAt: item.unattempted ? null : attemptedAt,
        lastAttemptAt: item.unattempted ? null : attemptedAt,
        completedAt: item.terminal === false ? null : attemptedAt,
        dispatchStartedAt: item.dispatched ? attemptedAt : null,
        lastErrorCode: item.lastErrorCode ?? null,
        lastStatusCode: item.lastStatusCode ?? null,
      },
    });
    await expect(
      s.max.banMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[0]!.id }),
    ).rejects.toThrow('no longer executable');
    if (item.mode === 'cutoff') {
      await s.max.clearTerminalBanStateAfterConfirmedUnban(chatId, 'fixture-user', new Date());
    } else {
      await s.max.clearTerminalBanStateAfterConfirmedUnban(chatId, 'fixture-user');
    }
    if (item.cleared) {
      expect(await s.prisma.maxActionLedgerEntry.findUnique({ where: { jobId } })).toBeNull();
      await s.max.banMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[3]!.id });
      expect(s.effects.filter((effect) => effect.params?.block === true)).toHaveLength(1);
    } else {
      expect(await s.prisma.maxActionLedgerEntry.findUnique({ where: { jobId } })).toEqual(before);
      await expect(
        s.max.banMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[3]!.id }),
      ).rejects.toThrow('no longer executable');
      expect(s.effects).toHaveLength(0);
    }
  });

  it('allows one guarded attempt after a confirmed BAN and keeps its evidence', async () => {
    const { s, chatId } = await fixture();
    await s.max.banMember(chatId, 'fixture-user', { botId: s.bots[0]!.id, immediate: true });
    const beforeImmediateMemberMutation = jest.fn().mockResolvedValue(undefined);
    const attemptOptions = {
      botId: s.bots[3]!.id,
      immediate: true,
      idempotencyKey: 'selected-sanction',
      beforeImmediateMemberMutation,
    };
    await s.max.attemptUnbanMember(chatId, 'fixture-user', attemptOptions);
    await expect(
      s.max.attemptUnbanMember(chatId, 'fixture-user', { ...attemptOptions, botId: s.bots[1]!.id }),
    ).rejects.toThrow('no longer executable');
    expect(beforeImmediateMemberMutation).toHaveBeenCalledTimes(1);
    const rows = await s.prisma.maxActionLedgerEntry.findMany({ where: { chatId } });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionType: 'BAN_MEMBER', status: 'SUCCEEDED' }),
        expect.objectContaining({
          actionType: 'TRY_UNBAN_MEMBER',
          status: 'SUCCEEDED',
          attemptCount: 1,
        }),
      ]),
    );
    const effects = s.effects.filter((item) => item.path === `/chats/${chatId}/members`);
    expect(effects.map((item) => item.params?.block)).toEqual([true, false]);
    await expect(
      s.max.kickMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[2]!.id }),
    ).rejects.toThrow('Retained member action requires settlement');
  });

  it.each(['IN_PROGRESS', 'AMBIGUOUS'] as const)(
    'does not attempt unban after a BAN with %s effects',
    async (status) => {
      const { s, chatId } = await fixture();
      const prior = job(chatId, s.bots[0]!.id);
      await s.prisma.maxActionLedgerEntry.create({
        data: {
          jobId: prior.idempotencyKey,
          actionType: prior.actionType,
          chatId,
          userId: prior.userId,
          status,
          ambiguous: status === 'AMBIGUOUS',
          terminal: status === 'AMBIGUOUS',
          attemptCount: 1,
        },
      });
      await expect(
        s.max.attemptUnbanMember(chatId, 'fixture-user', {
          immediate: true,
          botId: s.bots[3]!.id,
          idempotencyKey: 'selected-sanction',
          beforeImmediateMemberMutation: async () => {},
        }),
      ).rejects.toThrow('Retained member action requires settlement');
      expect(s.effects).toHaveLength(0);
    },
  );

  it('fences an ambiguous attempt across identities and later member operations', async () => {
    const { s, chatId } = await fixture();
    await s.max.banMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[0]!.id });
    const opts = {
      immediate: true,
      botId: s.bots[3]!.id,
      idempotencyKey: 'selected-sanction',
      beforeImmediateMemberMutation: async () => {},
    };
    s.ambiguousNextMemberMutation();
    await expect(s.max.attemptUnbanMember(chatId, 'fixture-user', opts)).rejects.toThrow(
      'Ambiguous MAX TRY_UNBAN_MEMBER',
    );
    await expect(s.max.attemptUnbanMember(chatId, 'fixture-user', opts)).rejects.toThrow(
      'no longer executable',
    );
    await expect(
      s.max.attemptUnbanMember(chatId, 'fixture-user', {
        ...opts,
        idempotencyKey: 'another-sanction',
      }),
    ).rejects.toThrow('Retained member action requires settlement');
    // Model a later externally confirmed return; an unknown attempt remains crash-fenced.
    await s.max.clearTerminalBanStateAfterConfirmedUnban(chatId, 'fixture-user');
    await expect(
      s.max.banMember(chatId, 'fixture-user', { immediate: true, botId: s.bots[1]!.id }),
    ).rejects.toThrow('Retained member action requires settlement');
    expect(s.effects.filter((item) => item.method === 'delete')).toHaveLength(2);
    expect(
      await s.prisma.maxActionLedgerEntry.findFirst({
        where: { chatId, actionType: 'TRY_UNBAN_MEMBER' },
      }),
    ).toMatchObject({ status: 'AMBIGUOUS', ambiguous: true, attemptCount: 1 });
  });

  it.each([true, false])(
    'bounds member-effect lookup independently of terminal history (block completed BAN: %s)',
    async (blockCompletedBan) => {
      const { s, chatId } = await fixture();
      await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO max_action_ledger (id, job_id, action_type, chat_id, user_id, status, terminal, updated_at)
      SELECT ${`${chatId}-history-`} || i, ${`${chatId}-history-job-`} || i,
        'KICK_MEMBER', ${chatId}, 'fixture-user', 'SUCCEEDED'::"MaxActionLedgerStatus", TRUE, CURRENT_TIMESTAMP
      FROM generate_series(1, 20000) AS i
    `);
      await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO max_action_ledger (id, job_id, action_type, chat_id, user_id, status, terminal, updated_at)
      SELECT ${`${chatId}-attempt-history-`} || i, ${`${chatId}-attempt-history-job-`} || i,
        'TRY_UNBAN_MEMBER', ${chatId}, 'fixture-user', 'SUCCEEDED'::"MaxActionLedgerStatus", TRUE, CURRENT_TIMESTAMP
      FROM generate_series(1, 20000) AS i
    `);
      const prior = job(chatId, s.bots[0]!.id);
      await s.ledger.recordStarted(prior);
      await s.prisma.$executeRaw`ANALYZE max_action_ledger`;
      const plans = await s.prisma.$queryRaw<
        Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
      >(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT job_id FROM max_action_ledger
      WHERE chat_id = ${chatId} AND user_id = 'fixture-user' AND job_id <> 'a-new-identity'
        AND action_type IN ('BAN_MEMBER', 'KICK_MEMBER', 'TRY_UNBAN_MEMBER')
        AND (status = 'IN_PROGRESS'::"MaxActionLedgerStatus" OR ambiguous = TRUE
          OR (${blockCompletedBan} AND action_type = 'BAN_MEMBER' AND status = 'SUCCEEDED'::"MaxActionLedgerStatus")) LIMIT 1
    `);
      const serialized = JSON.stringify(plans);
      expect(serialized).toContain('max_action_ledger_member_attempt_fence_idx');
      const walk = (node: Record<string, unknown>): void => {
        if (node['Relation Name'] === 'max_action_ledger') {
          expect(
            Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0),
          ).toBeLessThanOrEqual(2);
        }
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
      };
      walk(plans[0]!['QUERY PLAN'][0]!.Plan);
    },
  );
});

stores('native final member guard ledger watchdog', () => {
  const watchdogKeys = [
    'system:max-action-ledger:watchdog:lock:v1',
    'system:max-action-ledger:watchdog:status:v1',
    'system:max-action-ledger:watchdog:cursor:v1',
  ] as const;
  let h: MultibotHarness | undefined;
  let watchdog: MaxActionLedgerWatchdogService | undefined;
  let watchdogPrisma: PrismaService | undefined;
  let watchdogCounter: RedisCounterService | undefined;
  let actionQueue: Queue<MaxActionJob> | undefined;
  let actionEvents: QueueEvents | undefined;
  let actionWorker: Worker<MaxActionJob> | undefined;
  let ownsWatchdogKeys = false;
  let seededRoleTatKey: string | undefined;

  afterEach(async () => {
    const errors: unknown[] = [];
    const cleanup = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error: unknown) {
        errors.push(error);
      }
    };
    await cleanup(() => watchdog?.onModuleDestroy());
    await cleanup(() => actionWorker?.close());
    await cleanup(() => actionEvents?.close());
    const ownedQueue = actionQueue;
    if (ownedQueue) {
      await cleanup(() => ownedQueue.obliterate({ force: true }));
      await cleanup(() => ownedQueue.close());
    }
    const ownedHarness = h;
    if (ownedHarness && ownsWatchdogKeys) {
      await cleanup(async () => {
        // FLAG: A completed run must release its own lock; never erase a retained lock to pass.
        expect(await ownedHarness.redis.get(watchdogKeys[0])).toBeNull();
        await ownedHarness.redis.del(...watchdogKeys);
      });
    }
    const ownedRoleTatKey = seededRoleTatKey;
    if (ownedHarness && ownedRoleTatKey)
      await cleanup(() => ownedHarness.redis.del(ownedRoleTatKey));
    if (ownedHarness)
      await cleanup(() =>
        ownedHarness.redis.del(
          ...ownedHarness.bots.flatMap((bot) => fixtureAdmissionFailureKeys(bot.id)),
        ),
      );
    await cleanup(() => watchdogCounter?.onModuleDestroy());
    await cleanup(() => watchdogPrisma?.onModuleDestroy());
    await cleanup(() => ownedHarness?.dispose());
    watchdog = undefined;
    watchdogPrisma = undefined;
    watchdogCounter = undefined;
    actionQueue = undefined;
    actionEvents = undefined;
    actionWorker = undefined;
    h = undefined;
    ownsWatchdogKeys = false;
    seededRoleTatKey = undefined;
    jest.restoreAllMocks();
    if (errors.length > 0)
      throw new AggregateError(errors, 'Native member watchdog cleanup failed');
  });

  async function createNativeWatchdog() {
    const previousPoolMax = process.env.PRISMA_PG_POOL_MAX;
    try {
      process.env.PRISMA_PG_POOL_MAX = '2';
      watchdogPrisma = new PrismaService();
    } finally {
      if (previousPoolMax === undefined) delete process.env.PRISMA_PG_POOL_MAX;
      else process.env.PRISMA_PG_POOL_MAX = previousPoolMax;
    }
    await watchdogPrisma.onModuleInit();
    watchdogCounter = new RedisCounterService(new ConfigService({ REDIS_URL: redisUrl }));
    const localRedis = new URL(redisUrl);
    actionQueue = new Queue<MaxActionJob>(`member-watchdog-${randomUUID()}`, {
      connection: {
        host: localRedis.hostname.replace(/^\[|\]$/gu, ''),
        port: Number(localRedis.port || 6379),
        ...(localRedis.username ? { username: decodeURIComponent(localRedis.username) } : {}),
        ...(localRedis.password ? { password: decodeURIComponent(localRedis.password) } : {}),
        db: Number(localRedis.pathname.slice(1) || 0),
      },
    });
    await actionQueue.waitUntilReady();
    const previousRole = process.env.APP_ROLE;
    try {
      process.env.APP_ROLE = 'action';
      watchdog = new MaxActionLedgerWatchdogService(
        watchdogPrisma,
        watchdogCounter,
        actionQueue,
        undefined,
        undefined,
        undefined,
        new ConfigService({ MAX_ACTION_LEDGER_WATCHDOG_MODE: 'on' }),
      );
    } finally {
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
    }
    return { queue: actionQueue, watchdog };
  }

  it.each(
    [
      {
        name: 'documented HTTP200 rejection',
        lastStatusCode: 200,
        lastErrorCode: 'max_member_insufficient_rights',
        lastError: 'User already deleted or bot has insufficient rights',
        definitive: true,
      },
      {
        name: 'null-status chat-not-found rejection',
        lastStatusCode: null,
        lastErrorCode: 'chat.not.found',
        lastError: 'Chat not found',
        definitive: true,
      },
      {
        name: 'generic attempted HTTP200 failure',
        lastStatusCode: 200,
        lastErrorCode: 'max_ban_member_failed',
        lastError: 'Generic member failure',
        definitive: false,
      },
    ].flatMap((item) => (['legacy', 'cutoff'] as const).map((mode) => ({ ...item, mode }))),
  )('preserves actual watchdog proof for $name in $mode confirmed-unban mode', async (item) => {
    const s = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' });
    h = s;
    expect(await s.redis.exists(...watchdogKeys)).toBe(0);
    ownsWatchdogKeys = true;
    const [chatId] = await s.seedCatalog(1);
    const userId = 'fixture-user';
    const jobId = buildMaxActionIdempotencyKey('logical', ['BAN_MEMBER', chatId!, userId]);
    const agedAt = new Date(Date.now() - 6 * 60_000);
    await s.prisma.maxActionLedgerEntry.create({
      data: {
        jobId,
        actionType: 'BAN_MEMBER',
        chatId: chatId!,
        userId,
        botId: s.bots[0]!.id,
        status: 'FAILED_RETRYABLE',
        ambiguous: false,
        terminal: false,
        attemptCount: 1,
        firstAttemptAt: agedAt,
        lastAttemptAt: agedAt,
        updatedAt: agedAt,
        lastStatusCode: item.lastStatusCode,
        lastErrorCode: item.lastErrorCode,
        lastError: item.lastError,
      },
    });
    const native = await createNativeWatchdog();
    await native.watchdog.runNow();
    const settled = await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId } });
    expect(settled).toMatchObject({
      status: item.definitive ? 'FAILED_TERMINAL' : 'AMBIGUOUS',
      ambiguous: !item.definitive,
      terminal: true,
      lastStatusCode: item.lastStatusCode,
      lastErrorCode: item.definitive
        ? 'ledger.watchdog.retry_orphan_non_retryable'
        : 'ledger.watchdog.ambiguous',
    });
    if (item.mode === 'cutoff') {
      await s.max.clearTerminalBanStateAfterConfirmedUnban(chatId!, userId, new Date());
    } else {
      await s.max.clearTerminalBanStateAfterConfirmedUnban(chatId!, userId);
    }
    if (item.definitive && item.mode === 'legacy') {
      expect(await s.prisma.maxActionLedgerEntry.findUnique({ where: { jobId } })).toBeNull();
      await s.max.banMember(chatId!, userId, { immediate: true, botId: s.bots[0]!.id });
      expect(s.effects.filter((effect) => effect.params?.block === true)).toHaveLength(1);
    } else {
      expect(await s.prisma.maxActionLedgerEntry.findUnique({ where: { jobId } })).toEqual(settled);
      await expect(
        s.max.banMember(chatId!, userId, { immediate: true, botId: s.bots[0]!.id }),
      ).rejects.toThrow('no longer executable');
      expect(s.effects).toHaveLength(0);
    }
    expect((await native.watchdog.getSnapshot()).lastRequeuedCount).toBe(0);
  });

  it.each(
    (['BAN_MEMBER', 'KICK_MEMBER'] as const).flatMap((actionType) =>
      (['role_class_quota', 'proof404'] as const).flatMap((guard) =>
        (['missing', 'retained_failed'] as const).map((jobState) => ({
          actionType,
          guard,
          jobState,
        })),
      ),
    ),
  )(
    'defers genuine $actionType $guard evidence with $jobState BullMQ ownership without another mutation',
    async ({ actionType, guard, jobState }) => {
      expect(process.env.DATABASE_URL?.trim()).toBe(databaseUrl);
      const s = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' });
      h = s;
      expect(await s.redis.exists(...watchdogKeys)).toBe(0);
      ownsWatchdogKeys = true;
      const [seededChatId] = await s.seedCatalog(1);
      const chatId = seededChatId!;
      const bot = s.bots[0]!;
      const userId = 'fixture-user';
      const rawKey = `guard-watchdog-${randomUUID()}`;
      const jobId = s.max.getExplicitActionJobId(actionType, rawKey);
      const failureKeys = fixtureAdmissionFailureKeys(bot.id);
      expect(await s.redis.mget(...failureKeys)).toEqual(failureKeys.map(() => null));
      const proofRequest = { chatId, botId: bot.id, purpose: 'moderate_member' as const };
      expect(await s.links.getFreshChatBotExecutionProof(proofRequest)).not.toBeNull();

      if (guard === 'role_class_quota') {
        const serviceScope = normalizeMaxApiRateLimitServiceScope(s.config.get('APP_SERVICE_NAME'));
        expect(serviceScope).toBe('api-moderation');
        const roleTatKey = `maxapi:gcra:v1:service:${serviceScope}:bot:${bot.id}:class:critical`;
        const [seconds, microseconds] = await s.redis.time();
        const redisNowMs = Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
        await s.redis.set(roleTatKey, String(redisNowMs + 60_000), 'PX', 120_000);
        seededRoleTatKey = roleTatKey;
      } else {
        const membership = await s.prisma.chatBotMembership.update({
          where: { chatId_botId: { chatId, botId: bot.id } },
          data: { botAccessCheckedAt: null, botAccessSource: null },
        });
        expect(membership).toMatchObject({ status: 'ACTIVE', botAccessState: 'CONFIRMED_ADMIN' });
        expect(await s.links.getFreshChatBotExecutionProof(proofRequest)).toBeNull();
        expect(
          await s.links.isChatBotExecutionActivationRequired(chatId, bot.id, 'moderate_member'),
        ).toBe(false);
        s.setOwnMemberProbe(bot.id, 'not_found');
      }

      const recordFailed = jest.spyOn(s.ledger, 'recordFailed');
      const options = {
        botId: bot.id,
        immediate: true,
        idempotencyKey: rawKey,
        trafficClass: 'critical' as const,
        actionHealthLane: 'critical' as const,
        timeoutMs: 1,
      };
      let failure: unknown;
      try {
        if (actionType === 'BAN_MEMBER') await s.max.banMember(chatId, userId, options);
        else await s.max.kickMember(chatId, userId, options);
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(wasMaxPreDispatchGuardRejected(failure)).toBe(true);
      expect(wasMaxMemberMutationAttempted(failure)).toBe(false);
      if (guard === 'role_class_quota') {
        expect(failure).toBeInstanceOf(MaxApiInternalRateLimitError);
        if (!(failure instanceof MaxApiInternalRateLimitError))
          throw new Error('Expected the real role-class limiter rejection');
        expect(failure.limitScope).toBe('role_class');
        expect(failure.retryAfterMs).toBeGreaterThan(0);
      } else {
        expect(failure).toMatchObject({
          code: 'max_action_executor_proof_rejected',
          response: { status: 404, data: { code: 'fixture.lookup.not_found' } },
        });
      }
      const ownMemberRequests = () =>
        s.requests.filter(
          (request) => request.method === 'get' && request.path === `/chats/${chatId}/members/me`,
        );
      const memberMutations = () =>
        s.requests.filter(
          (request) => request.method === 'delete' && request.path === `/chats/${chatId}/members`,
        );
      expect(ownMemberRequests()).toHaveLength(guard === 'proof404' ? 1 : 0);
      expect(memberMutations()).toHaveLength(0);
      expect(s.effects).toHaveLength(0);
      expect(recordFailed).toHaveBeenCalledTimes(1);
      const [capturedJob, capturedFailure] = recordFailed.mock.calls[0]!;
      expect(capturedJob).toMatchObject({
        actionType,
        chatId,
        userId,
        botId: bot.id,
        idempotencyKey: jobId,
        attempt: 1,
      });
      expect(capturedFailure).toBe(failure);
      const writtenRow = await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({
        where: { jobId },
      });
      expect(writtenRow).toMatchObject({
        jobId,
        actionType,
        chatId,
        userId,
        botId: bot.id,
        status: 'FAILED_RETRYABLE',
        ambiguous: false,
        terminal: false,
        attemptCount: 1,
        lastErrorCode: MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
        lastStatusCode: guard === 'proof404' ? 404 : null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });
      await expect(s.ledger.assertCanExecute(capturedJob)).resolves.toBeUndefined();
      const agedAt = new Date(Date.now() - 6 * 60_000);
      const agedRow = await s.prisma.maxActionLedgerEntry.update({
        where: { jobId },
        data: { updatedAt: agedAt },
      });
      expect(agedRow).toEqual({ ...writtenRow, updatedAt: agedAt });

      const native = await createNativeWatchdog();
      expect(await native.queue.getJob(jobId)).toBeUndefined();
      if (jobState === 'retained_failed') {
        actionEvents = new QueueEvents(native.queue.name, { connection: { url: redisUrl } });
        await actionEvents.waitUntilReady();
        const workerCalls = jest.fn(async () => {
          throw new Error('Native guard fixture retained failure');
        });
        actionWorker = new Worker<MaxActionJob>(native.queue.name, workerCalls, {
          connection: { url: redisUrl },
        });
        await actionWorker.waitUntilReady();
        // FLAG: This worker creates only a genuine retained failed BullMQ state. It cannot
        // execute MAX or rewrite the real pre-dispatch ledger outcome captured above.
        const retained = await native.queue.add('execute-max-action', capturedJob, {
          jobId,
          attempts: 1,
          removeOnFail: false,
        });
        await expect(retained.waitUntilFinished(actionEvents, 10_000)).rejects.toThrow(
          'Native guard fixture retained failure',
        );
        await actionWorker.close();
        actionWorker = undefined;
        expect(workerCalls).toHaveBeenCalledTimes(1);
        const observedJob = await native.queue.getJob(jobId);
        expect(observedJob).toBeDefined();
        expect(observedJob?.id).toBe(jobId);
        expect(observedJob?.data).toEqual(capturedJob);
        expect(await observedJob?.getState()).toBe('failed');
        expect(observedJob?.attemptsMade).toBe(1);
        expect(await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId } })).toEqual(
          agedRow,
        );
      }
      const queueAdd = jest.spyOn(native.queue, 'add');
      const jobRetry = jest.spyOn(Job.prototype, 'retry');
      await native.watchdog.runNow();
      const snapshot = await native.watchdog.getSnapshot();
      expect(snapshot).toMatchObject({ activeOnThisRole: true, mode: 'on', lastError: null });
      expect(snapshot.lastSuccessAt).toEqual(expect.any(String));
      const observedRow = await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({
        where: { jobId },
      });
      // FLAG: A genuine no-dispatch writer outcome must survive maintenance unchanged. This
      // asserts the intended invariant, including on the unfixed watchdog baseline.
      expect({
        row: observedRow,
        scanned: snapshot.lastScannedCount,
        deferred: snapshot.lastDeferredCount,
        reconciled: snapshot.lastReconciledCount,
        quarantined: snapshot.lastQuarantinedCount,
        terminalFailed: snapshot.lastTerminalFailedCount,
        requeued: snapshot.lastRequeuedCount,
        queueAdds: queueAdd.mock.calls.length,
        jobRetries: jobRetry.mock.calls.length,
        ownMemberRequests: ownMemberRequests().length,
        memberMutations: memberMutations().length,
        effects: s.effects.length,
      }).toEqual({
        row: agedRow,
        scanned: 1,
        deferred: 1,
        reconciled: 0,
        quarantined: 0,
        terminalFailed: 0,
        requeued: 0,
        queueAdds: 0,
        jobRetries: 0,
        ownMemberRequests: guard === 'proof404' ? 1 : 0,
        memberMutations: 0,
        effects: 0,
      });
      await expect(s.ledger.assertCanExecute(capturedJob)).resolves.toBeUndefined();
      if (jobState === 'retained_failed') {
        const retained = await native.queue.getJob(jobId);
        expect(await retained?.getState()).toBe('failed');
        expect(retained?.attemptsMade).toBe(1);
        expect(retained?.data).toEqual(capturedJob);
      }
    },
  );

  it.each(
    (['BAN_MEMBER', 'KICK_MEMBER'] as const).flatMap((actionType) =>
      (['acknowledged', 'attempted_timeout'] as const).map((outcome) => ({ actionType, outcome })),
    ),
  )(
    'preserves public $actionType $outcome evidence and its single effect through watchdog inspection',
    async ({ actionType, outcome }) => {
      expect(process.env.DATABASE_URL?.trim()).toBe(databaseUrl);
      const s = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' });
      h = s;
      expect(await s.redis.exists(...watchdogKeys)).toBe(0);
      ownsWatchdogKeys = true;
      const [seededChatId] = await s.seedCatalog(1);
      const chatId = seededChatId!;
      const bot = s.bots[0]!;
      const userId = 'fixture-user';
      const rawKey = `terminal-watchdog-${randomUUID()}`;
      const jobId = s.max.getExplicitActionJobId(actionType, rawKey);
      const recordStarted = jest.spyOn(s.ledger, 'recordStarted');
      const recordSucceeded = jest.spyOn(s.ledger, 'recordSucceeded');
      const recordFailed = jest.spyOn(s.ledger, 'recordFailed');
      const options = {
        botId: bot.id,
        immediate: true,
        idempotencyKey: rawKey,
        trafficClass: 'critical' as const,
        actionHealthLane: 'critical' as const,
      };
      const execute = () =>
        actionType === 'BAN_MEMBER'
          ? s.max.banMember(chatId, userId, options)
          : s.max.kickMember(chatId, userId, options);
      if (outcome === 'attempted_timeout') s.ambiguousNextMemberMutation();
      let failure: unknown;
      try {
        await execute();
      } catch (error: unknown) {
        failure = error;
      }
      if (outcome === 'attempted_timeout') {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toMatchObject({
          message: expect.stringContaining(`Ambiguous MAX ${actionType} transport failure`),
        });
        expect(wasMaxMemberMutationAttempted(failure)).toBe(true);
        expect(wasMaxPreDispatchGuardRejected(failure)).toBe(false);
        expect(recordFailed).toHaveBeenCalledTimes(1);
        expect(recordFailed.mock.calls[0]?.[1]).toBe(failure);
        expect(recordSucceeded).not.toHaveBeenCalled();
      } else {
        expect(failure).toBeUndefined();
        expect(recordSucceeded).toHaveBeenCalledTimes(1);
        expect(recordFailed).not.toHaveBeenCalled();
      }
      expect(recordStarted).toHaveBeenCalledTimes(1);
      const [capturedJob] = recordStarted.mock.calls[0]!;
      expect(capturedJob).toMatchObject({
        actionType,
        chatId,
        userId,
        botId: bot.id,
        idempotencyKey: jobId,
      });
      const writtenRow = await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({
        where: { jobId },
      });
      expect(writtenRow).toMatchObject({
        jobId,
        actionType,
        chatId,
        userId,
        botId: bot.id,
        status: outcome === 'acknowledged' ? 'SUCCEEDED' : 'AMBIGUOUS',
        ambiguous: outcome === 'attempted_timeout',
        terminal: true,
        attemptCount: 1,
      });
      expect(writtenRow.lastErrorCode).not.toBe(MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE);
      const agedAt = new Date(Date.now() - 6 * 60_000);
      const agedRow = await s.prisma.maxActionLedgerEntry.update({
        where: { jobId },
        data: { updatedAt: agedAt },
      });
      expect(agedRow).toEqual({ ...writtenRow, updatedAt: agedAt });

      const native = await createNativeWatchdog();
      expect(await native.queue.getJob(jobId)).toBeUndefined();
      const queueAdd = jest.spyOn(native.queue, 'add');
      const jobRetry = jest.spyOn(Job.prototype, 'retry');
      await native.watchdog.runNow();
      const snapshot = await native.watchdog.getSnapshot();
      expect(snapshot).toMatchObject({
        activeOnThisRole: true,
        mode: 'on',
        lastError: null,
        lastScannedCount: 0,
        lastDeferredCount: 0,
        lastReconciledCount: 0,
        lastQuarantinedCount: 0,
        lastTerminalFailedCount: 0,
        lastRequeuedCount: 0,
      });
      expect(snapshot.lastSuccessAt).toEqual(expect.any(String));
      expect(await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId } })).toEqual(
        agedRow,
      );
      await expect(s.ledger.assertCanExecute(capturedJob)).rejects.toThrow('no longer executable');
      await expect(execute()).rejects.toThrow('no longer executable');
      expect(queueAdd).not.toHaveBeenCalled();
      expect(jobRetry).not.toHaveBeenCalled();
      expect(
        s.requests.filter(
          (request) => request.method === 'delete' && request.path === `/chats/${chatId}/members`,
        ),
      ).toHaveLength(1);
      expect(s.effects).toHaveLength(1);
      expect(s.effects[0]).toMatchObject({
        method: 'delete',
        path: `/chats/${chatId}/members`,
        botId: bot.id,
      });
      expect(await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId } })).toEqual(
        agedRow,
      );
    },
  );
});
