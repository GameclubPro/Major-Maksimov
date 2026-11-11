import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
  type MaxActionDispatchOptions,
  type MaxClientService,
  wasMaxMemberMutationAttempted,
  wasMaxMemberMutationConfirmed,
} from '../max/max-client.service';
import {
  ModerationSanctionStateChangedError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockUnavailableError,
} from '../moderation/moderation-sanction-state-lock.service';
import { AdminService } from './admin.service';
import { ChatEntityType } from '../prisma/prisma-client';
import {
  createAdminServiceFixture,
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
} from './admin-service-test-support';

const ADMIN_ACTOR = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

const VERIFIED_COMMAND_OPTIONS = {
  actorAlreadyVerified: true,
  targetDisplayNameHint: 'Нарушитель',
  allowTargetDisplayNameRemoteLookup: false,
} as const;

function createService(
  prisma: ReturnType<typeof createPrismaMock>,
  maxClient: unknown,
): AdminService {
  return new AdminService(
    prisma as never,
    maxClient as never,
    createChatContextCacheMock() as never,
    createConfigMock() as never,
  );
}

function createBanMaxClient(overrides: Record<string, unknown> = {}): Record<string, jest.Mock> {
  return {
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
    ...overrides,
  } as Record<string, jest.Mock>;
}

function installSanctionStateHarness(service: AdminService) {
  const trace: string[] = [];
  const leaseGuard = {
    assertOwned: jest.fn().mockImplementation(async () => {
      trace.push('guard');
    }),
  };
  const preparedFence = {
    version: 1,
    transitionId: 'transition-1',
    chatId: 'chat-1',
    userId: 'user-1',
    intendedAction: 'BAN',
    operator: 'ADMIN',
    source: 'test',
    invalidatedSanctionEventIds: ['sanction-event-old'],
  };
  const sanctionStateLock = {
    runExclusive: jest
      .fn()
      .mockImplementation(
        async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) =>
          operation(leaseGuard),
      ),
  };
  const sanctionStateFence = {
    prepare: jest.fn().mockImplementation(async (params: Record<string, unknown>) => {
      trace.push('prepare');
      return {
        ...preparedFence,
        chatId: params.chatId,
        userId: params.userId,
        intendedAction: params.intendedAction,
        operator: params.operator,
        source: params.source,
      };
    }),
    commit: jest.fn().mockImplementation(async () => {
      trace.push('commit');
    }),
    markRemoteConfirmedEventMissing: jest.fn().mockImplementation(async () => {
      trace.push('remote-confirmed-event-missing');
    }),
    abort: jest.fn().mockImplementation(async () => {
      trace.push('abort');
    }),
    isSanctionEventInvalidated: jest.fn().mockResolvedValue(false),
  };
  (service as any).injectedModerationSanctionStateLock = sanctionStateLock;
  (service as any).injectedModerationSanctionStateFence = sanctionStateFence;
  return { leaseGuard, sanctionStateFence, sanctionStateLock, trace };
}

describe('duration-only mute release', () => {
  function fixture() {
    const prisma = createPrismaMock();
    const event = {
      id: 'duration-only-mute',
      chatId: 'chat-1',
      userId: 'user-4',
      action: 'MUTE',
      metadata: { muteDurationHours: 2 },
      createdAt: new Date(Date.now() - 3_600_000),
    };
    prisma.moderationEvent.findUnique.mockResolvedValue(event);
    prisma.moderationEvent.findFirst.mockResolvedValue({ id: event.id });
    const service = createService(prisma, {});
    const harness = installSanctionStateHarness(service);
    const run = () =>
      service.applyManualModerationAction(
        'chat-1',
        'user-4',
        ADMIN_ACTOR,
        { action: 'UNMUTE' },
        'group_command',
        { ...VERIFIED_COMMAND_OPTIONS, expectedSanctionEventId: event.id },
      );
    return { prisma, event, harness, run };
  }

  it('releases an active mute using its stored duration and original creation time', async () => {
    const { prisma, event, harness, run } = fixture();

    await expect(run()).resolves.toMatchObject({ ok: true, action: 'UNMUTE', userId: 'user-4' });

    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleCode: 'MANUAL_UNMUTE',
        metadata: expect.objectContaining({ releasedSanctionEventId: event.id }),
      }),
    });
    expect(harness.sanctionStateFence.commit).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'replaced', 'fenced'] as const)(
    'rejects a %s duration-only mute without recording a release',
    async (state) => {
      const { prisma, event, harness, run } = fixture();
      if (state === 'expired') event.createdAt = new Date(Date.now() - 3 * 3_600_000);
      if (state === 'replaced')
        prisma.moderationEvent.findFirst.mockResolvedValue({ id: 'newer-mute' });
      if (state === 'fenced')
        harness.sanctionStateFence.isSanctionEventInvalidated.mockResolvedValue(true);

      await expect(run()).rejects.toBeInstanceOf(ModerationSanctionStateChangedError);

      expect(harness.sanctionStateFence.prepare).not.toHaveBeenCalled();
      expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    },
  );
});

describe('existing sanction-button unban attempt', () => {
  const options = {
    ...VERIFIED_COMMAND_OPTIONS,
    expectedSanctionEventId: 'ban-event-1',
    attemptUnbanWithRemove: true,
  };
  function fixture() {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findUnique.mockResolvedValue({
      id: 'ban-event-1',
      chatId: 'chat-1',
      userId: 'user-4',
      action: 'BAN',
      metadata: {},
      createdAt: new Date('2026-10-01T00:00:00Z'),
    });
    prisma.moderationEvent.findFirst.mockResolvedValue({ id: 'ban-event-1' });
    const mutation = jest.fn();
    const revalidateRoute = jest.fn().mockResolvedValue(undefined);
    const maxClient = createBanMaxClient({
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      clearTerminalBanStateAfterConfirmedUnban: jest.fn(),
      unbanMember: jest.fn(),
      attemptUnbanMember: jest.fn(
        async (_chat: string, _user: string, opts: MaxActionDispatchOptions) => {
          await opts.beforeImmediateMemberMutation!(revalidateRoute);
          mutation();
        },
      ),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const run = () =>
      service.applyManualModerationAction(
        'chat-1',
        'user-4',
        ADMIN_ACTOR,
        { action: 'UNBAN' },
        'group_command',
        options,
      );
    return { prisma, maxClient, service, harness, run, mutation, revalidateRoute };
  }

  it('sends a guarded attempt without releasing the ban or granting exemptions', async () => {
    const { prisma, maxClient, harness, run, mutation, revalidateRoute } = fixture();
    await expect(run()).resolves.toMatchObject({
      message: 'Запрос выполнен. Проверьте вход в чат.',
    });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(revalidateRoute).toHaveBeenCalledTimes(1);
    expect(harness.leaseGuard.assertOwned.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      revalidateRoute.mock.invocationCallOrder[0]!,
    );
    expect(revalidateRoute.mock.invocationCallOrder[0]).toBeLessThan(
      mutation.mock.invocationCallOrder[0]!,
    );
    expect(maxClient.attemptUnbanMember).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expect.objectContaining({
        immediate: true,
        idempotencyKey: 'manual-unban-attempt:ban-event-1',
        beforeImmediateMemberMutation: expect.any(Function),
      }),
    );
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
      expect.objectContaining({ bypassCache: true }),
    );
    expect(harness.sanctionStateFence.prepare).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.clearTerminalBanStateAfterConfirmedUnban).not.toHaveBeenCalled();
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.upsert).not.toHaveBeenCalled();
  });

  it.each(['sanction', 'lease'] as const)(
    'rejects %s authority changed during the unban admission checkpoint',
    async (changed) => {
      const { prisma, maxClient, harness, run, mutation, revalidateRoute } = fixture();
      revalidateRoute.mockImplementation(async () => {
        expect(maxClient.getChatMemberAccess).toHaveBeenCalledTimes(2);
        if (changed === 'sanction')
          prisma.moderationEvent.findFirst.mockResolvedValue({ id: 'new-ban' });
        else
          harness.leaseGuard.assertOwned.mockRejectedValue(
            new ModerationSanctionStateLockLeaseLostError({ chatId: 'chat-1', userId: 'user-4' }),
          );
      });

      await expect(run()).rejects.toBeInstanceOf(
        changed === 'sanction'
          ? ModerationSanctionStateChangedError
          : ModerationSanctionStateLockLeaseLostError,
      );
      expect(revalidateRoute).toHaveBeenCalledTimes(1);
      expect(mutation).not.toHaveBeenCalled();
      expect(maxClient.unbanMember).not.toHaveBeenCalled();
      expect(maxClient.clearTerminalBanStateAfterConfirmedUnban).not.toHaveBeenCalled();
      expect(harness.sanctionStateFence.prepare).not.toHaveBeenCalled();
      expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    },
  );

  it.each(['member lookup', 'preparation lease renewal'] as const)(
    'rejects a selected executor proof superseded during the final %s',
    async (blockedStep) => {
      const { prisma, maxClient, harness, run, mutation, revalidateRoute } = fixture();
      let routeVersion = 1;
      const originalRouteVersion = routeVersion;
      const proofRejected = Object.assign(new Error('Selected member executor proof changed'), {
        code: 'max_action_executor_proof_rejected',
      });
      revalidateRoute.mockImplementation(async () => {
        if (routeVersion !== originalRouteVersion) throw proofRejected;
      });
      let releaseWait!: () => void;
      let reachedWait!: () => void;
      const waiting = new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        reachedWait = resolve;
      });
      let finalTargetReadFinished = false;
      // FLAG: Block the second, fresh target read or its preceding Redis lease
      // check. The captured dispatch proof is valid until that exact final wait.
      maxClient.getChatMemberAccess.mockResolvedValueOnce(null).mockImplementationOnce(async () => {
        if (blockedStep === 'member lookup') {
          reachedWait();
          await waiting;
        }
        finalTargetReadFinished = true;
        return null;
      });
      harness.leaseGuard.assertOwned.mockImplementation(async () => {
        harness.trace.push('guard');
        if (
          blockedStep === 'preparation lease renewal' &&
          maxClient.attemptUnbanMember.mock.calls.length > 0 &&
          !finalTargetReadFinished
        ) {
          reachedWait();
          await waiting;
        }
      });

      const settled = run().then(
        () => null,
        (error: unknown) => error,
      );
      try {
        const outcome = await Promise.race([
          reached.then(() => 'reached'),
          settled.then(() => 'settled'),
        ]);
        expect(outcome).toBe('reached');
        expect(revalidateRoute).not.toHaveBeenCalled();
        expect(mutation).not.toHaveBeenCalled();
        routeVersion += 1;
      } finally {
        releaseWait();
      }
      await expect(settled).resolves.toBe(proofRejected);
      expect(maxClient.getChatMemberAccess).toHaveBeenCalledTimes(2);
      expect(revalidateRoute).toHaveBeenCalledTimes(1);
      expect(harness.leaseGuard.assertOwned.mock.invocationCallOrder.at(-1)).toBeLessThan(
        revalidateRoute.mock.invocationCallOrder[0]!,
      );
      expect(mutation).not.toHaveBeenCalled();
      expect(maxClient.attemptUnbanMember).toHaveBeenCalledTimes(1);
      expect(maxClient.clearTerminalBanStateAfterConfirmedUnban).not.toHaveBeenCalled();
      expect(harness.sanctionStateFence.prepare).not.toHaveBeenCalled();
      expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(prisma.adminGlobalSpammerExemption.upsert).not.toHaveBeenCalled();
    },
  );

  it('does not remove a member who returned while the request was prepared', async () => {
    const { maxClient, run, mutation, harness } = fixture();
    maxClient.getChatMemberAccess
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ userId: 'user-4' });
    await expect(run()).rejects.toBeInstanceOf(ModerationSanctionStateChangedError);
    expect(mutation).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.prepare).not.toHaveBeenCalled();
  });

  it('rejects an old button when the selected sanction changes before HTTP', async () => {
    const { prisma, run, mutation } = fixture();
    prisma.moderationEvent.findFirst
      .mockResolvedValueOnce({ id: 'ban-event-1' })
      .mockResolvedValueOnce({ id: 'new-ban' });
    await expect(run()).rejects.toBeInstanceOf(ModerationSanctionStateChangedError);
    expect(mutation).not.toHaveBeenCalled();
  });

  it('fails closed when fresh absence cannot be verified', async () => {
    const { maxClient, run, mutation } = fixture();
    maxClient.getChatMemberAccess.mockRejectedValue(new Error('lookup unavailable'));
    await expect(run()).rejects.toThrow('lookup unavailable');
    expect(maxClient.attemptUnbanMember).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  it('requires the bot to have member-management rights', async () => {
    const { maxClient, run, mutation } = fixture();
    maxClient.getCurrentChatMemberAccess = jest
      .fn<
        ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
        Parameters<MaxClientService['getCurrentChatMemberAccess']>
      >()
      .mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissionsKnown: true,
        permissions: [],
      });
    await expect(run()).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: 409,
        code: 'BOT_CAPABILITY_REQUIRED',
        operation: 'member_moderation',
        missingPermissions: ['add_remove_members'],
      }),
    });
    expect(maxClient.attemptUnbanMember).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  it('uses confirmed release when the participant is already present', async () => {
    const { maxClient, run, harness, prisma } = fixture();
    maxClient.getChatMemberAccess.mockResolvedValue({
      userId: 'user-4',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    });
    await run();
    expect(maxClient.attemptUnbanMember).not.toHaveBeenCalled();
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(maxClient.clearTerminalBanStateAfterConfirmedUnban).toHaveBeenCalledWith(
      'chat-1',
      'user-4',
    );
    expect(harness.sanctionStateFence.commit).toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ruleCode: 'MANUAL_UNBAN' }) }),
    );
  });
});

describe('channel member bans', () => {
  const options = { ...VERIFIED_COMMAND_OPTIONS, entityType: ChatEntityType.CHANNEL };

  it('records and fences a local ban without chat cleanup, global evidence or channel posts', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient({
      sendMessage: jest.fn(),
      deleteMessage: jest.fn(),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const cleanup = jest.spyOn(service as never, 'resolveManualBanSourceCleanupSummary' as never);
    const fanout = jest.spyOn(service as never, 'resolveManualBanFollowUpSummaries' as never);
    const exemption = jest.spyOn(service as never, 'deleteAdminGlobalSpammerExemption' as never);
    const intelligence = { recordManualBanObservation: jest.fn() };
    Object.assign(service, { globalSpammerIntelligence: intelligence });

    await expect(
      service.applyManualModerationAction(
        'channel-1',
        'user-3',
        ADMIN_ACTOR,
        { action: 'BAN', scope: 'current_chat' },
        'miniapp',
        options,
      ),
    ).resolves.toEqual(expect.objectContaining({ message: 'Бан включён.' }));
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).toHaveBeenCalledWith(
      'channel-1',
      'user-3',
      expect.objectContaining({
        immediate: true,
        beforeImmediateMemberMutation: expect.any(Function),
      }),
    );
    expect(harness.sanctionStateFence.commit).toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatId: 'channel-1',
          userId: 'user-3',
          ruleCode: 'MANUAL_BAN',
          metadata: expect.objectContaining({ scope: 'current_chat' }),
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(fanout).not.toHaveBeenCalled();
    expect(exemption).not.toHaveBeenCalled();
    expect(intelligence.recordManualBanObservation).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'BAN', scope: 'all_chats' },
    { action: 'BAN' },
    { action: 'MUTE', scope: 'current_chat', muteDurationHours: 24 },
  ])('rejects unsupported channel scope or action %j', async (body) => {
    const maxClient = createBanMaxClient();
    const service = createService(createPrismaMock(), maxClient);
    await expect(
      service.applyManualModerationAction(
        'channel-1',
        'user-3',
        ADMIN_ACTOR,
        body,
        'miniapp',
        options,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it.each([
    ['self', 'admin-1', {}],
    [
      'owner',
      'user-3',
      { getChatMemberAccess: jest.fn().mockResolvedValue({ isOwner: true, isAdmin: true }) },
    ],
    [
      'admin',
      'user-3',
      { getChatMemberAccess: jest.fn().mockResolvedValue({ isOwner: false, isAdmin: true }) },
    ],
    ['departed', 'user-3', { getChatMemberAccess: jest.fn().mockResolvedValue(null) }],
    [
      'missing bot permission',
      'user-3',
      {
        getCurrentChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ isOwner: false, isAdmin: true, permissions: ['read_all_messages'] }),
      },
    ],
  ])('rejects %s without a MAX mutation', async (_reason, targetUserId, overrides) => {
    const maxClient = createBanMaxClient(overrides as Record<string, unknown>);
    const service = createService(createPrismaMock(), maxClient);
    installSanctionStateHarness(service);
    await expect(
      service.applyManualModerationAction(
        'channel-1',
        targetUserId as string,
        ADMIN_ACTOR,
        { action: 'BAN', scope: 'current_chat' },
        'miniapp',
        options,
      ),
    ).rejects.toThrow();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('reports removal-only honestly for a channel without a link', async () => {
    const maxClient = createBanMaxClient({
      getChatSnapshot: jest.fn().mockResolvedValue({ isPublic: false, link: null }),
      kickMember: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn(),
    });
    const service = createService(createPrismaMock(), maxClient);
    installSanctionStateHarness(service);
    const result = await service.applyManualModerationAction(
      'channel-1',
      'user-3',
      ADMIN_ACTOR,
      { action: 'BAN', scope: 'current_chat' },
      'miniapp',
      options,
    );
    expect(result.message).toContain('MAX не поддерживает блокировку');
    expect(maxClient.kickMember).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });
});

describe('AdminService sanction state ordering', () => {
  it('coalesces a second group BAN after the first command commits the active sanction', async () => {
    const prisma = createPrismaMock();
    let activeBanEvent: {
      id: string;
      action: string;
      metadata: Record<string, unknown>;
      createdAt: Date;
    } | null = null;
    prisma.moderationEvent.findFirst.mockImplementation(async (args: any) =>
      args?.where?.OR && activeBanEvent ? activeBanEvent : null,
    );
    prisma.moderationEvent.create.mockImplementation(async (args: any) => {
      if (args?.data?.ruleCode === 'MANUAL_BAN') {
        activeBanEvent = {
          id: 'moderation-event-ban-1',
          action: 'BAN',
          metadata: { mode: 'MAX_BLOCK' },
          createdAt: new Date('2026-08-30T13:19:28.966Z'),
        };
        return activeBanEvent;
      }
      return { id: `moderation-event-${prisma.moderationEvent.create.mock.calls.length}` };
    });
    const maxClient = createBanMaxClient({
      getChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'user-3',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValue(null),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    });
    const service = createService(prisma, maxClient);
    const buildJob = (suffix: string) => ({
      kind: 'manual_group_moderation_command' as const,
      jobId: `job-command-ban-${suffix}`,
      sourceChatId: 'chat-1',
      commandBotId: 'bot-1',
      targetUserId: 'user-3',
      targetSenderName: 'Нарушитель',
      targetMessageId: 'mid-target-1',
      commandMessageId: `mid-command-${suffix}`,
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
    });

    await service.processManualModerationFanoutJob(buildJob('first'));
    const secondJob = buildJob('second');
    await service.processManualModerationFanoutJob(secondJob);
    await service.processManualModerationFanoutJob(secondJob);

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).not.toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('не выполнена'),
      expect.anything(),
      expect.anything(),
    );
    await expect(
      prisma.manualModerationFanoutLedgerEntry.count({
        where: { operation: 'COMMAND_SOURCE_BAN', status: 'SUCCEEDED' },
      }),
    ).resolves.toBe(2);
  });

  it('continues all-chat fanout when the source BAN is already active', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findFirst.mockResolvedValue({
      id: 'active-ban-event-1',
      action: 'BAN',
      metadata: { mode: 'MAX_BLOCK' },
      createdAt: new Date('2026-08-30T13:19:28.966Z'),
    });
    const maxClient = createBanMaxClient({
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
    });
    const service = createService(prisma, maxClient);
    const followUp = jest
      .spyOn(service as any, 'resolveManualBanFollowUpSummaries')
      .mockResolvedValue({
        sourceMessageCleanup: {
          candidateCount: 0,
          deletedCount: 0,
          pendingCount: 0,
          failedCount: 0,
        },
        crossChatFanout: {
          removedChatsCount: 0,
          removedChatIds: [],
          skippedChatsCount: 0,
          skippedChatIds: [],
          failedChatsCount: 0,
          failedChatIds: [],
          deletedMessageCount: 0,
          failedMessageDeleteCount: 0,
        },
      });

    await service.applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', {
      ...VERIFIED_COMMAND_OPTIONS,
      fanoutAllChats: true,
      fanoutLedgerJobId: 'job-command-active-ban-all-1',
    });

    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        source: 'group_command',
        rootIntentKey: 'job-command-active-ban-all-1',
      }),
    );
  });

  it('replays a succeeded source BAN without a live moderation route', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);
    const options = {
      ...VERIFIED_COMMAND_OPTIONS,
      fanoutLedgerJobId: 'job-command-ban-replay-1',
    };

    await service.applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', options);
    const routeLookupCount = maxClient.getCurrentChatMemberAccess.mock.calls.length;
    maxClient.getCurrentChatMemberAccess.mockRejectedValue(new Error('MAX route unavailable'));

    await expect(
      service.applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', options),
    ).resolves.toEqual(expect.objectContaining({ message: 'Бан включён.' }));

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(routeLookupCount);
  });

  it('re-applies a remove-only BAN when the participant has rejoined', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findFirst.mockResolvedValue({
      id: 'old-remove-event-1',
      action: 'BAN',
      metadata: { mode: 'MAX_REMOVE_ONLY' },
      createdAt: new Date('2026-08-29T13:19:28.966Z'),
    });
    const kickMember = jest.fn().mockResolvedValue(undefined);
    const maxClient = createBanMaxClient({
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      getChatSnapshot: jest.fn().mockResolvedValue({ isPublic: false, link: null }),
      kickMember,
    });
    const service = createService(prisma, maxClient);

    await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      ADMIN_ACTOR,
      'group_command',
      VERIFIED_COMMAND_OPTIONS,
    );

    expect(kickMember).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('clears retained BAN idempotency after a participant is natively unbanned in MAX', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findFirst.mockResolvedValue({
      id: 'old-block-event-1',
      action: 'BAN',
      metadata: { mode: 'MAX_BLOCK' },
      createdAt: new Date('2026-08-29T13:19:28.966Z'),
    });
    const clearTerminalBanStateAfterConfirmedUnban = jest.fn().mockResolvedValue(undefined);
    const maxClient = createBanMaxClient({
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      clearTerminalBanStateAfterConfirmedUnban,
    });
    const service = createService(prisma, maxClient);

    await service.applyManualSystemBan(
      'chat-1',
      'user-3',
      ADMIN_ACTOR,
      'group_command',
      VERIFIED_COMMAND_OPTIONS,
    );

    expect(clearTerminalBanStateAfterConfirmedUnban).toHaveBeenCalledWith('chat-1', 'user-3');
    expect(clearTerminalBanStateAfterConfirmedUnban.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.banMember.mock.invocationCallOrder[0]!,
    );
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('retries without clearing retained BAN state when the live member probe is unavailable', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findFirst.mockResolvedValue({
      id: 'active-block-event-1',
      action: 'BAN',
      metadata: { mode: 'MAX_BLOCK' },
      createdAt: new Date('2026-08-29T13:19:28.966Z'),
    });
    const clearTerminalBanStateAfterConfirmedUnban = jest.fn().mockResolvedValue(undefined);
    const maxClient = createBanMaxClient({
      getChatMemberAccess: jest.fn().mockRejectedValue(new Error('MAX lookup timeout')),
      clearTerminalBanStateAfterConfirmedUnban,
    });
    const service = createService(prisma, maxClient);

    await expect(
      service.applyManualSystemBan(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        'group_command',
        VERIFIED_COMMAND_OPTIONS,
      ),
    ).rejects.toBeInstanceOf(ModerationSanctionStateLockUnavailableError);

    expect(clearTerminalBanStateAfterConfirmedUnban).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('replays a timed group MUTE with its original expiry and one event', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-30T13:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      const maxClient = {
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'user-3',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        }),
        deleteMessage: jest.fn().mockResolvedValue(undefined),
        sendMessage: jest.fn().mockResolvedValue(undefined),
      };
      const service = createService(prisma, maxClient);
      const options = {
        ...VERIFIED_COMMAND_OPTIONS,
        fanoutLedgerJobId: 'job-command-mute-replay-1',
      };

      await service.applyManualModerationAction(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        { action: 'MUTE', scope: 'current_chat', muteDurationHours: 6 },
        'group_command',
        options,
      );
      const routeLookupCount = maxClient.getCurrentChatMemberAccess.mock.calls.length;
      jest.setSystemTime(new Date('2026-08-30T15:00:00.000Z'));
      await service.applyManualModerationAction(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        { action: 'MUTE', scope: 'current_chat', muteDurationHours: 6 },
        'group_command',
        options,
      );

      const manualMuteCreates = prisma.moderationEvent.create.mock.calls.filter(
        ([args]) => args?.data?.ruleCode === 'MANUAL_MUTE',
      );
      expect(manualMuteCreates).toHaveLength(1);
      expect(manualMuteCreates[0]?.[0]?.data?.metadata).toEqual(
        expect.objectContaining({ muteExpiresAt: '2026-08-30T19:00:00.000Z' }),
      );
      expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(routeLookupCount);
      expect(maxClient.getChatMemberAccess).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats two distinct timed MUTE commands as an intentional extension', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-30T13:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      const maxClient = {
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'user-3',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        }),
      };
      const service = createService(prisma, maxClient);
      const applyMute = (rootIntentKey: string) =>
        service.applyManualModerationAction(
          'chat-1',
          'user-3',
          ADMIN_ACTOR,
          { action: 'MUTE', scope: 'current_chat', muteDurationHours: 6 },
          'group_command',
          { ...VERIFIED_COMMAND_OPTIONS, fanoutLedgerJobId: rootIntentKey },
        );

      await applyMute('job-command-mute-first');
      jest.setSystemTime(new Date('2026-08-30T15:00:00.000Z'));
      await applyMute('job-command-mute-second');

      const manualMuteMetadata = prisma.moderationEvent.create.mock.calls
        .filter(([args]) => args?.data?.ruleCode === 'MANUAL_MUTE')
        .map(([args]) => args.data.metadata);
      expect(manualMuteMetadata).toEqual([
        expect.objectContaining({ muteExpiresAt: '2026-08-30T19:00:00.000Z' }),
        expect.objectContaining({ muteExpiresAt: '2026-08-30T21:00:00.000Z' }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reclaims a stale in-progress source BAN intent through the real command path', async () => {
    const prisma = createPrismaMock();
    await prisma.manualModerationFanoutLedgerEntry.createMany({
      data: [
        {
          operationKey: 'manual_moderation_fanout:v1:COMMAND_SOURCE_BAN:stale-source',
          rootIntentKey: 'job-command-stale-source-1',
          sourceKind: 'group_command',
          operation: 'COMMAND_SOURCE_BAN',
          sourceChatId: 'chat-1',
          targetChatId: 'chat-1',
          targetUserId: 'user-3',
          actorUserId: 'admin-1',
          logicalAction: 'BAN',
          executionMode: 'MAX_BLOCK',
          status: 'IN_PROGRESS',
          attemptCount: 1,
          lockedAt: new Date(Date.now() - 11 * 60 * 1_000),
          lockToken: 'stale-source-token',
          terminal: false,
        },
      ],
      skipDuplicates: true,
    });
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);

    await service.applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', {
      ...VERIFIED_COMMAND_OPTIONS,
      fanoutLedgerJobId: 'job-command-stale-source-1',
    });

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    await expect(
      prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { rootIntentKey: 'job-command-stale-source-1' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'SUCCEEDED',
        attemptCount: 2,
        terminal: true,
      }),
    ]);
  });

  it('retries a source BAN immediately when fence preparation fails after the claim', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);
    const originalPrepare = (service as any).prepareManualSanctionStateFence.bind(service);
    const preparationError = new ModerationSanctionStateLockUnavailableError({
      chatId: 'chat-1',
      userId: 'user-3',
    });
    jest
      .spyOn(service as any, 'prepareManualSanctionStateFence')
      .mockRejectedValueOnce(preparationError)
      .mockImplementation(originalPrepare);
    const options = {
      ...VERIFIED_COMMAND_OPTIONS,
      fanoutLedgerJobId: 'job-command-ban-prepare-retry-1',
    };

    await expect(
      service.applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', options),
    ).rejects.toBe(preparationError);
    await expect(
      service.applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', options),
    ).resolves.toEqual(expect.objectContaining({ ok: true, action: 'BAN' }));

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    await expect(
      prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { rootIntentKey: options.fanoutLedgerJobId },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'SUCCEEDED', attemptCount: 2, terminal: true }),
    ]);
  });

  it('retries a source MUTE immediately when fence preparation fails after the claim', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
    };
    const service = createService(prisma, maxClient);
    const originalPrepare = (service as any).prepareManualSanctionStateFence.bind(service);
    const preparationError = new ModerationSanctionStateLockUnavailableError({
      chatId: 'chat-1',
      userId: 'user-3',
    });
    jest
      .spyOn(service as any, 'prepareManualSanctionStateFence')
      .mockRejectedValueOnce(preparationError)
      .mockImplementation(originalPrepare);
    const options = {
      ...VERIFIED_COMMAND_OPTIONS,
      fanoutLedgerJobId: 'job-command-mute-prepare-retry-1',
    };

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        { action: 'MUTE', scope: 'current_chat', muteDurationHours: 6 },
        'group_command',
        options,
      ),
    ).rejects.toBe(preparationError);
    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        { action: 'MUTE', scope: 'current_chat', muteDurationHours: 6 },
        'group_command',
        options,
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true, action: 'MUTE' }));

    await expect(
      prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { rootIntentKey: options.fanoutLedgerJobId },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'SUCCEEDED', attemptCount: 2, terminal: true }),
    ]);
  });

  it('queues current-chat miniapp ban cleanup when the background queue is available', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ message_id: 'mid-source-1' }]);
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
      'user-3',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      { action: 'BAN', scope: 'current_chat' },
    );

    expect(adminManualFanoutQueue.add).toHaveBeenCalledWith(
      'execute-admin-manual-fanout',
      expect.objectContaining({
        kind: 'manual_ban_source_cleanup',
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        source: 'miniapp',
      }),
      expect.objectContaining({ priority: 20 }),
    );
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            scope: 'current_chat',
            sourceMessageCleanup: expect.objectContaining({
              mode: 'queued',
              candidateCount: 0,
              deletedCount: 0,
            }),
          }),
        }),
      }),
    );
  });

  it('resolves the MAX action route before acquiring the sanction lock', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);
    const resolveBot = jest
      .spyOn(service as any, 'resolveManualModerationActionBotAssignment')
      .mockResolvedValue('bot-1');
    const harness = installSanctionStateHarness(service);

    await service.applyManualModerationAction(
      'chat-1',
      'user-3',
      ADMIN_ACTOR,
      { action: 'BAN', scope: 'current_chat' },
      'group_command',
      VERIFIED_COMMAND_OPTIONS,
    );

    expect(resolveBot).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateLock.runExclusive).toHaveBeenCalledTimes(1);
    expect(resolveBot.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sanctionStateLock.runExclusive.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects a sanction event invalidated by a newer fence before release side effects', async () => {
    const prisma = createPrismaMock();
    const expectedEventCreatedAt = new Date('2026-04-12T10:00:00.000Z');
    prisma.moderationEvent.findUnique.mockResolvedValue({
      id: 'ban-event-old',
      chatId: 'chat-1',
      userId: 'user-4',
      action: 'BAN',
      metadata: {},
      createdAt: expectedEventCreatedAt,
    });
    prisma.moderationEvent.findMany.mockResolvedValue([
      {
        metadata: {
          version: 1,
          transitionId: 'transition-new-ban',
          intendedAction: 'BAN',
          invalidatedSanctionEventIds: ['ban-event-old'],
          phase: 'COMMITTED',
        },
      },
    ]);
    prisma.moderationEvent.findFirst.mockResolvedValue({ id: 'ban-event-old' });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      cancelScheduledUnban: jest.fn(),
      unbanMember: jest.fn(),
    };
    const service = createService(prisma, maxClient);

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-4',
        ADMIN_ACTOR,
        { action: 'UNBAN' },
        'group_command',
        { expectedSanctionEventId: 'ban-event-old' },
      ),
    ).rejects.toBeInstanceOf(ModerationSanctionStateChangedError);

    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.unbanMember).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.upsert).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-4',
          ruleCode: 'SANCTION_STATE_FENCE',
          createdAt: { gte: expectedEventCreatedAt },
        }),
      }),
    );
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
  });

  it('aborts an unban fence when a mocked MAX error has no attempted-mutation marker', async () => {
    const prisma = createPrismaMock();
    const connectionReset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockRejectedValue(connectionReset),
    };
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-4',
        ADMIN_ACTOR,
        { action: 'UNBAN' },
        'group_command',
        VERIFIED_COMMAND_OPTIONS,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(maxClient.unbanMember).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ intendedAction: 'UNBAN' }),
    );
    expect(harness.sanctionStateFence.abort).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.upsert).not.toHaveBeenCalled();
  });

  it('keeps an unban fence prepared when an attempted MAX mutation is ambiguous', async () => {
    const prisma = createPrismaMock();
    const attemptedConnectionReset = markMaxMemberMutationAttempted(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockRejectedValue(attemptedConnectionReset),
    };
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-4',
        ADMIN_ACTOR,
        { action: 'UNBAN' },
        'group_command',
        VERIFIED_COMMAND_OPTIONS,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(maxClient.unbanMember).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ intendedAction: 'UNBAN' }),
    );
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.upsert).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('marks an unban fence remote-confirmed when MAX confirms the mutation before failing', async () => {
    const prisma = createPrismaMock();
    const confirmedError = markMaxMemberMutationConfirmed(
      new Error('terminal ban state cleanup failed'),
    );
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue(null),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      unbanMember: jest.fn().mockRejectedValue(confirmedError),
    };
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);

    await expect(
      service.applyManualModerationAction(
        'chat-1',
        'user-4',
        ADMIN_ACTOR,
        { action: 'UNBAN' },
        'group_command',
        VERIFIED_COMMAND_OPTIONS,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(maxClient.unbanMember).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ intendedAction: 'UNBAN' }),
    );
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(prisma.adminGlobalSpammerExemption.upsert).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('checks the sanction lease around MAX dispatch and event persistence', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    maxClient.cancelScheduledUnban.mockImplementation(async () => {
      harness.trace.push('cancel');
    });
    maxClient.banMember.mockImplementation(async () => {
      harness.trace.push('max');
    });
    prisma.adminGlobalSpammerExemption.deleteMany.mockImplementation(async () => {
      harness.trace.push('exemption');
      return { count: 1 };
    });
    jest
      .spyOn(service as any, 'resolveManualBanSourceCleanupSummary')
      .mockImplementation(async () => {
        harness.trace.push('follow-up');
        return {
          candidateCount: 0,
          deletedCount: 0,
          pendingCount: 0,
          failedCount: 0,
        };
      });
    prisma.moderationEvent.create.mockImplementation(async ({ data }: { data: any }) => {
      if (data.ruleCode === 'MANUAL_BAN') {
        harness.trace.push('event');
      }
      return { id: 'moderation-event-guarded' };
    });

    await service.applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command');

    expect(harness.sanctionStateLock.runExclusive).toHaveBeenCalledWith(
      { chatId: 'chat-1', userId: 'user-3' },
      expect.any(Function),
    );
    expect(harness.sanctionStateFence.prepare).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-3',
      intendedAction: 'BAN',
      operator: 'ADMIN',
      source: 'group_command',
    });
    expect(harness.leaseGuard.assertOwned).toHaveBeenCalledTimes(9);
    expect(harness.trace).toEqual([
      'guard',
      'guard',
      'prepare',
      'guard',
      'cancel',
      'guard',
      'max',
      'guard',
      'exemption',
      'guard',
      'guard',
      'follow-up',
      'guard',
      'event',
      'commit',
      'guard',
    ]);
    expect(harness.sanctionStateFence.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-3',
        intendedAction: 'BAN',
      }),
      'moderation-event-guarded',
    );
  });

  it('aborts a source BAN fence after a pre-dispatch ECONNRESET without an attempted marker', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: 'sanction-event-old',
      action: 'BAN',
    });
    const connectionReset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const maxClient = createBanMaxClient({
      banMember: jest.fn().mockRejectedValue(connectionReset),
    });
    const service = createService(prisma, maxClient);

    await expect(
      service.applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', {
        ...VERIFIED_COMMAND_OPTIONS,
        fanoutLedgerJobId: 'job-source-econnreset-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(
      prisma.moderationEvent.create.mock.calls
        .map(([input]) => input.data)
        .filter((data) => data.ruleCode === 'SANCTION_STATE_FENCE')
        .map((data) => data.metadata.phase),
    ).toEqual(['PREPARED', 'ABORTED']);
    expect(
      await prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'COMMAND_SOURCE_BAN' },
      }),
    ).toEqual([
      expect.objectContaining({
        status: 'FAILED_RETRYABLE',
        terminal: false,
        lockToken: null,
      }),
    ]);
  });

  it('preserves an attempted BAN marker through the BadRequest wrapper', async () => {
    const prisma = createPrismaMock();
    const attemptedConnectionReset = markMaxMemberMutationAttempted(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    const maxClient = createBanMaxClient({
      banMember: jest.fn().mockRejectedValue(attemptedConnectionReset),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);

    const actionError = await service
      .applyManualModerationAction(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        { action: 'BAN' },
        'group_command',
        VERIFIED_COMMAND_OPTIONS,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(actionError).toBeInstanceOf(BadRequestException);
    expect(wasMaxMemberMutationAttempted(actionError)).toBe(true);
    expect((actionError as Error & { cause?: unknown }).cause).toBe(attemptedConnectionReset);
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
  });

  it('preserves an attempted BAN marker through the transient wrapper', async () => {
    const prisma = createPrismaMock();
    const attemptedTimeout = markMaxMemberMutationAttempted(
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
    );
    const maxClient = createBanMaxClient({
      banMember: jest.fn().mockRejectedValue(attemptedTimeout),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);

    const actionError = await service
      .applyManualModerationAction(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        { action: 'BAN' },
        'group_command',
        VERIFIED_COMMAND_OPTIONS,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(actionError).toBeInstanceOf(ServiceUnavailableException);
    expect(wasMaxMemberMutationAttempted(actionError)).toBe(true);
    expect((actionError as Error & { cause?: unknown }).cause).toBe(attemptedTimeout);
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
  });

  it('records a confirmed source BAN dispatch failure as remote-confirmed and ambiguous', async () => {
    const prisma = createPrismaMock();
    const confirmedError = markMaxMemberMutationConfirmed(
      new Error('post-dispatch bookkeeping failed'),
    );
    const maxClient = createBanMaxClient({
      banMember: jest.fn().mockRejectedValue(confirmedError),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);

    const actionError = await service
      .applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', {
        ...VERIFIED_COMMAND_OPTIONS,
        fanoutLedgerJobId: 'job-source-confirmed-1',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(actionError).toBeInstanceOf(BadRequestException);
    expect(wasMaxMemberMutationConfirmed(actionError)).toBe(true);
    expect((actionError as Error & { cause?: unknown }).cause).toBe(confirmedError);
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(
      await prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'COMMAND_SOURCE_BAN' },
      }),
    ).toEqual([
      expect.objectContaining({
        status: 'AMBIGUOUS',
        terminal: true,
        lockToken: null,
      }),
    ]);
  });

  it('keeps an ambiguous source BAN outcome durable and silent across command retries', async () => {
    const prisma = createPrismaMock();
    const timeoutError = markMaxMemberMutationAttempted(
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
    );
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      cancelScheduledUnban: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn().mockRejectedValue(timeoutError),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockRejectedValue(new Error('group notice must remain silent')),
    };
    const service = createService(prisma, maxClient);
    const job = {
      kind: 'manual_group_moderation_command' as const,
      jobId: 'job-command-source-timeout-1',
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

    await expect(service.processManualModerationFanoutJob(job)).resolves.toBeUndefined();
    await expect(service.processManualModerationFanoutJob(job)).resolves.toBeUndefined();

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
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
        metadata: expect.objectContaining({
          outcome: 'UNCERTAIN',
          suppressed: true,
          resultText: expect.stringContaining('итог не удалось надёжно подтвердить'),
        }),
      }),
    ]);
    expect(prisma.manualModerationFanoutLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationKey: expect.stringContaining('COMMAND_SOURCE_BAN'),
        }),
        data: expect.objectContaining({
          status: 'AMBIGUOUS',
          terminal: true,
        }),
      }),
    );
  });

  it('marks timed out queued manual ban fanout ambiguous and does not auto retry it', async () => {
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
    const timeoutError = markMaxMemberMutationAttempted(
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
    );
    const maxClient = createBanMaxClient({
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      banMember: jest.fn().mockRejectedValueOnce(timeoutError).mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    });
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const job = {
      kind: 'manual_ban_fanout' as const,
      jobId: 'job-ban-timeout-1',
      rootIntentKey: 'command-root-timeout-1',
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
          status: 'AMBIGUOUS',
        }),
      }),
    );
  });

  it('rejects stale ledger completion and rolls back its event transaction after lease handoff', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma, {});
    const operationKey = 'manual_moderation_fanout:v1:FANOUT_BAN_MEMBER:lease-handoff';
    const claimParams = {
      operationKey,
      jobId: 'job-lease-handoff',
      rootIntentKey: 'root-lease-handoff',
      sourceKind: 'manual_ban_fanout',
      operation: 'FANOUT_BAN_MEMBER',
      sourceChatId: 'chat-1',
      targetChatId: 'chat-2',
      targetUserId: 'user-3',
      actorUserId: 'admin-1',
      logicalAction: 'BAN',
      botId: 'bot-2',
      executionMode: 'MAX_BLOCK',
      metadata: { owner: 'first' },
    };

    const firstClaim = await (service as any).claimManualModerationFanoutLedgerEntry(claimParams);
    await prisma.manualModerationFanoutLedgerEntry.updateMany({
      where: { operationKey },
      data: { lockedAt: new Date(Date.now() - 11 * 60 * 1_000) },
    });
    const secondClaim = await (service as any).claimManualModerationFanoutLedgerEntry({
      ...claimParams,
      metadata: { owner: 'second' },
    });

    expect(firstClaim).toEqual(
      expect.objectContaining({ claimed: true, lockToken: expect.any(String) }),
    );
    expect(secondClaim).toEqual(
      expect.objectContaining({ claimed: true, lockToken: expect.any(String) }),
    );
    expect(secondClaim.lockToken).not.toBe(firstClaim.lockToken);

    await (service as any).completeManualModerationFanoutLedgerEntry({
      operationKey,
      lockToken: secondClaim.lockToken,
      moderationEventId: 'event-from-current-owner',
      auditLogId: 'audit-from-current-owner',
      metadata: { owner: 'second' },
    });
    const currentOwnerResult = (
      await prisma.manualModerationFanoutLedgerEntry.findMany({ where: { operationKey } })
    )[0];

    await expect(
      (service as any).completeManualModerationFanoutLedgerEntry({
        operationKey,
        lockToken: firstClaim.lockToken,
        status: 'FAILED_TERMINAL',
        moderationEventId: 'event-from-stale-owner',
        auditLogId: 'audit-from-stale-owner',
        metadata: { owner: 'stale' },
      }),
    ).rejects.toBeInstanceOf(ModerationSanctionStateChangedError);

    const stagedEvents: unknown[] = [];
    const stagedAuditLogs: unknown[] = [];
    const committedEvents: unknown[] = [];
    const committedAuditLogs: unknown[] = [];
    prisma.$transaction.mockImplementation(async (input: any) => {
      if (typeof input !== 'function') {
        return Promise.all(input);
      }
      const transactionClient = {
        ...prisma,
        moderationEvent: {
          ...prisma.moderationEvent,
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const event = { id: 'event-from-stale-transaction', ...data };
            stagedEvents.push(event);
            return event;
          }),
        },
        auditLog: {
          ...prisma.auditLog,
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const auditLog = { id: 'audit-from-stale-transaction', ...data };
            stagedAuditLogs.push(auditLog);
            return auditLog;
          }),
        },
      };
      const result = await input(transactionClient);
      committedEvents.push(...stagedEvents);
      committedAuditLogs.push(...stagedAuditLogs);
      return result;
    });

    await expect(
      (service as any).recordManualModerationAction({
        chatId: 'chat-2',
        targetUserId: 'user-3',
        targetDisplayName: 'Нарушитель',
        actorUserId: 'admin-1',
        ruleCode: 'MANUAL_BAN',
        sanctionAction: 'BAN',
        auditAction: 'MANUAL_BAN_MEMBER',
        metadata: { source: 'stale-owner' },
        auditPayload: { source: 'stale-owner' },
        fanoutLedger: {
          operationKey,
          lockToken: firstClaim.lockToken,
          botId: 'bot-2',
          executionMode: 'MAX_BLOCK',
          metadata: { owner: 'stale' },
        },
      }),
    ).rejects.toBeInstanceOf(ModerationSanctionStateChangedError);

    expect(stagedEvents).toHaveLength(1);
    expect(stagedAuditLogs).toHaveLength(1);
    expect(committedEvents).toEqual([]);
    expect(committedAuditLogs).toEqual([]);
    expect(
      await prisma.manualModerationFanoutLedgerEntry.findMany({ where: { operationKey } }),
    ).toEqual([currentOwnerResult]);
    expect(currentOwnerResult).toEqual(
      expect.objectContaining({
        status: 'SUCCEEDED',
        terminal: true,
        lockToken: null,
        moderationEventId: 'event-from-current-owner',
        auditLogId: 'audit-from-current-owner',
        metadata: { owner: 'second' },
      }),
    );
  });

  it('aborts and retries a source BAN when its lease is lost before cancellation', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const leaseLost = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-3',
    });
    let guardCall = 0;
    harness.leaseGuard.assertOwned.mockImplementation(async () => {
      harness.trace.push('guard');
      guardCall += 1;
      if (guardCall === 3) {
        throw leaseLost;
      }
    });

    const actionError = await service
      .applyManualSystemBan('chat-1', 'user-3', ADMIN_ACTOR, 'group_command', {
        ...VERIFIED_COMMAND_OPTIONS,
        fanoutLedgerJobId: 'job-source-lease-lost-1',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(actionError).toBe(leaseLost);
    expect(wasMaxMemberMutationConfirmed(actionError)).toBe(false);

    expect(maxClient.cancelScheduledUnban).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(harness.trace).toEqual(['guard', 'guard', 'prepare', 'guard', 'abort']);
    expect(harness.sanctionStateFence.abort).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
    expect(
      await prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'COMMAND_SOURCE_BAN' },
      }),
    ).toEqual([
      expect.objectContaining({
        status: 'FAILED_RETRYABLE',
        terminal: false,
      }),
    ]);
  });

  it('stops post-BAN effects and records the missing event when the lease is lost after MAX', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient({
      sendMessage: jest.fn().mockResolvedValue(undefined),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const followUp = jest.spyOn(service as any, 'resolveManualBanFollowUpSummaries');
    const leaseLost = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-3',
    });
    let guardCall = 0;
    harness.leaseGuard.assertOwned.mockImplementation(async () => {
      harness.trace.push('guard');
      guardCall += 1;
      if (guardCall === 5) {
        throw leaseLost;
      }
    });

    const actionError = await service
      .applyManualSystemBan(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        'private_command',
        VERIFIED_COMMAND_OPTIONS,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(actionError).toBeInstanceOf(ModerationSanctionStateLockLeaseLostError);
    expect(wasMaxMemberMutationConfirmed(actionError)).toBe(true);

    expect(maxClient.cancelScheduledUnban).toHaveBeenCalledTimes(1);
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(prisma.adminGlobalSpammerExemption.deleteMany).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).toHaveBeenCalledTimes(1);
    expect(harness.trace).toEqual([
      'guard',
      'guard',
      'prepare',
      'guard',
      'guard',
      'guard',
      'remote-confirmed-event-missing',
    ]);
  });

  it('preserves confirmed BAN outcome when the outer lock reports lease loss after return', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const leaseLost = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-3',
    });
    harness.sanctionStateLock.runExclusive.mockImplementation(
      async (
        _subject: unknown,
        operation: (guard: typeof harness.leaseGuard) => Promise<unknown>,
      ) => {
        await operation(harness.leaseGuard);
        throw leaseLost;
      },
    );

    const actionError = await service
      .applyManualSystemBan(
        'chat-1',
        'user-3',
        ADMIN_ACTOR,
        'group_command',
        VERIFIED_COMMAND_OPTIONS,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(actionError).toBe(leaseLost);
    expect(wasMaxMemberMutationConfirmed(actionError)).toBe(true);
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.commit).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
  });

  it('does not apply the super-ban mute fallback after outer post-return lease loss', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const leaseLost = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-1',
    });
    harness.sanctionStateLock.runExclusive.mockImplementation(
      async (
        _subject: unknown,
        operation: (guard: typeof harness.leaseGuard) => Promise<unknown>,
      ) => {
        await operation(harness.leaseGuard);
        throw leaseLost;
      },
    );
    const muteFallback = jest
      .spyOn(service as any, 'applyDeveloperSuperBanPermanentMuteFallback')
      .mockResolvedValue({ affected: true, mode: 'muted' });

    const result = await (service as any).applyDeveloperSuperBanSourceChat({
      job: {
        jobId: 'developer-super-ban-post-return-lease-loss-1',
        sourceChatId: 'chat-1',
        commandBotId: 'bot-1',
        targetUserId: 'user-1',
      },
      actor: ADMIN_ACTOR,
      targetDisplayName: 'Нарушитель',
    });

    expect(result).toEqual({ affected: true, mode: 'removed' });
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(muteFallback).not.toHaveBeenCalled();
    expect(wasMaxMemberMutationConfirmed(leaseLost)).toBe(true);
    expect(harness.sanctionStateFence.commit).toHaveBeenCalledTimes(1);
  });

  it('does not apply the super-ban mute fallback after an ambiguous MAX removal attempt', async () => {
    const prisma = createPrismaMock();
    const attemptedTimeout = markMaxMemberMutationAttempted(
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
    );
    const maxClient = createBanMaxClient({
      banMember: jest.fn().mockRejectedValue(attemptedTimeout),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const muteFallback = jest
      .spyOn(service as any, 'applyDeveloperSuperBanPermanentMuteFallback')
      .mockResolvedValue({ affected: true, mode: 'muted' });

    const result = await (service as any).applyDeveloperSuperBanSourceChat({
      job: {
        jobId: 'developer-super-ban-ambiguous-1',
        sourceChatId: 'chat-1',
        commandBotId: 'bot-1',
        targetUserId: 'user-1',
      },
      actor: ADMIN_ACTOR,
      targetDisplayName: 'Нарушитель',
    });

    expect(result).toEqual({ affected: false, mode: 'failed' });
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(muteFallback).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
  });

  it('does not apply the super-ban mute fallback after an ambiguous BadRequest-wrapped attempt', async () => {
    const prisma = createPrismaMock();
    const attemptedConnectionReset = markMaxMemberMutationAttempted(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    const maxClient = createBanMaxClient({
      banMember: jest.fn().mockRejectedValue(attemptedConnectionReset),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const muteFallback = jest
      .spyOn(service as any, 'applyDeveloperSuperBanPermanentMuteFallback')
      .mockResolvedValue({ affected: true, mode: 'muted' });

    const result = await (service as any).applyDeveloperSuperBanSourceChat({
      job: {
        jobId: 'developer-super-ban-bad-request-1',
        sourceChatId: 'chat-1',
        commandBotId: 'bot-1',
        targetUserId: 'user-1',
      },
      actor: ADMIN_ACTOR,
      targetDisplayName: 'Нарушитель',
    });

    expect(result).toEqual({ affected: false, mode: 'failed' });
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(muteFallback).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
  });

  it('uses the super-ban mute fallback after an unmarked pre-dispatch failure', async () => {
    const prisma = createPrismaMock();
    const connectionReset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const maxClient = createBanMaxClient({
      banMember: jest.fn().mockRejectedValue(connectionReset),
    });
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    const muteFallback = jest
      .spyOn(service as any, 'applyDeveloperSuperBanPermanentMuteFallback')
      .mockResolvedValue({ affected: true, mode: 'muted' });

    const result = await (service as any).applyDeveloperSuperBanSourceChat({
      job: {
        jobId: 'developer-super-ban-pre-dispatch-1',
        sourceChatId: 'chat-1',
        commandBotId: 'bot-1',
        targetUserId: 'user-1',
      },
      actor: ADMIN_ACTOR,
      targetDisplayName: 'Нарушитель',
    });

    expect(result).toEqual({ affected: true, mode: 'muted' });
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(muteFallback).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.abort).toHaveBeenCalledTimes(1);
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
  });

  it('does not apply the super-ban mute fallback after MAX removal is confirmed', async () => {
    const prisma = createPrismaMock();
    const maxClient = createBanMaxClient();
    const service = createService(prisma, maxClient);
    const harness = installSanctionStateHarness(service);
    prisma.moderationEvent.create.mockImplementation(async ({ data }: { data: any }) => {
      if (data.ruleCode === 'MANUAL_BAN') {
        throw new Error('event persistence failed');
      }
      return { id: 'moderation-event-1' };
    });
    const muteFallback = jest
      .spyOn(service as any, 'applyDeveloperSuperBanPermanentMuteFallback')
      .mockResolvedValue({ affected: true, mode: 'muted' });

    const result = await (service as any).applyDeveloperSuperBanSourceChat({
      job: {
        jobId: 'developer-super-ban-confirmed-1',
        sourceChatId: 'chat-1',
        commandBotId: 'bot-1',
        targetUserId: 'user-1',
      },
      actor: ADMIN_ACTOR,
      targetDisplayName: 'Нарушитель',
    });

    expect(result).toEqual({ affected: true, mode: 'removed' });
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(muteFallback).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(harness.sanctionStateFence.markRemoteConfirmedEventMissing).toHaveBeenCalledTimes(1);
  });

  it('does not retry a queued manual ban after MAX succeeds but event persistence fails', async () => {
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
    prisma.moderationEvent.findFirst.mockResolvedValue({
      id: 'ban-event-before-fanout',
      action: 'BAN',
    });
    prisma.moderationEvent.create.mockImplementation(async ({ data }: { data: any }) => {
      if (data.ruleCode === 'MANUAL_BAN') {
        throw new Error('event persistence failed');
      }
      return { id: `fence-event-${data.metadata?.phase ?? 'unknown'}` };
    });
    const maxClient = createBanMaxClient({
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    });
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const params = {
      jobId: 'job-ban-persist-failure-1',
      rootIntentKey: 'command-root-persist-failure-1',
      sourceChatId: 'chat-1',
      targetUserId: 'user-3',
      actor: {
        ...ADMIN_ACTOR,
        chatId: null,
      },
      source: 'group_command' as const,
    };

    const firstResult = await (service as any).applyManualSystemBanFanout(params);
    const replayResult = await (service as any).applyManualSystemBanFanout(params);

    expect(firstResult).toEqual(
      expect.objectContaining({
        removedChatIds: [],
        failedChatIds: ['chat-2'],
        retryableFailedChatIds: [],
      }),
    );
    expect(replayResult).toEqual(
      expect.objectContaining({
        removedChatIds: [],
        failedChatIds: ['chat-2'],
        retryableFailedChatIds: [],
      }),
    );
    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    const moderationEventCreateCalls = prisma.moderationEvent.create.mock.calls.map(
      ([input]) => input.data,
    );
    expect(
      moderationEventCreateCalls.filter((data) => data.ruleCode === 'MANUAL_BAN'),
    ).toHaveLength(1);
    expect(
      moderationEventCreateCalls
        .filter((data) => data.ruleCode === 'SANCTION_STATE_FENCE')
        .map((data) => data.metadata.phase),
    ).toEqual(['PREPARED', 'REMOTE_CONFIRMED_EVENT_MISSING']);
    expect(
      await prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'FANOUT_BAN_MEMBER' },
      }),
    ).toEqual([
      expect.objectContaining({
        status: 'AMBIGUOUS',
        terminal: true,
        lastError: 'event persistence failed',
      }),
    ]);
  });

  it('propagates lease loss from inline source BAN cleanup', async () => {
    const service = createService(createPrismaMock(), {});
    const leaseLost = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-3',
    });
    const leaseGuard = { assertOwned: jest.fn() };
    const cleanup = jest
      .spyOn(service as any, 'deleteRecentTrackedMessagesForManualAction')
      .mockRejectedValue(leaseLost);

    await expect(
      (service as any).runManualBanSourceCleanup('chat-1', 'user-3', 'admin-1', {
        leaseGuard,
      }),
    ).rejects.toBe(leaseLost);

    expect(cleanup).toHaveBeenCalledWith(
      'chat-1',
      'user-3',
      expect.objectContaining({ leaseGuard }),
    );
  });

  it('does not swallow lease loss from inline source MUTE cleanup', async () => {
    const service = createService(createPrismaMock(), {});
    const leaseLost = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-3',
    });
    const leaseGuard = { assertOwned: jest.fn() };
    jest.spyOn(service as any, 'enqueueManualModerationFanout').mockResolvedValue(false);
    jest
      .spyOn(service as any, 'resolveManualModerationActionBotAssignment')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'deleteRecentTrackedMessagesForManualAction')
      .mockRejectedValue(leaseLost);

    await expect(
      (service as any).resolveManualMuteCommandFollowUpSummaries({
        sourceChatId: 'chat-1',
        targetUserId: 'user-3',
        actor: ADMIN_ACTOR,
        muteDurationHours: 6,
        muteExpiresAt: new Date('2026-08-05T00:00:00.000Z'),
        mutePermanent: false,
        source: 'group_command',
        leaseGuard,
      }),
    ).rejects.toBe(leaseLost);
  });
});
