import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  PublicationDispatchProfile,
  type Prisma,
} from '../prisma/prisma-client';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import { ensureManagedBroadcastActorAccessBeforeExecution } from './admin-managed-broadcast-authorization';

const user = { userId: 'user-1', username: null, displayName: null };

function createRuntime(prisma: Record<string, unknown>) {
  const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);
  jest.spyOn(runtime as any, 'assertManagedEntityReadAccess').mockResolvedValue(undefined);
  jest.spyOn(runtime as any, 'assertManagedEntityAdminAccess').mockResolvedValue(undefined);
  return runtime;
}

describe('AdminManagedBroadcastRuntime publication boundary', () => {
  it.each(['get', 'update', 'cancel', 'retry'] as const)(
    'keeps publication envelopes out of legacy %s',
    async (operation) => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const runtime = createRuntime({ managedBroadcast: { findFirst } });

      const result =
        operation === 'get'
          ? runtime.getManagedBroadcast('chat-1', 'broadcast-1', user)
          : operation === 'update'
            ? runtime.updateManagedBroadcast('chat-1', 'broadcast-1', user, {})
            : operation === 'cancel'
              ? runtime.cancelManagedBroadcast('chat-1', 'broadcast-1', user)
              : runtime.retryManagedBroadcast('chat-1', 'broadcast-1', user);

      await expect(result).rejects.toThrow();
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ publicationOccurrenceId: null }),
        }),
      );
    },
  );

  it('filters publication envelopes from legacy list queries', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const runtime = createRuntime({ managedBroadcast: { findMany } });

    await expect(runtime.listManagedBroadcasts('chat-1', user)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const call of findMany.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ publicationOccurrenceId: null }),
        }),
      );
    }
  });

  it('filters publication envelopes from legacy calendar reservations', async () => {
    const reservationFindMany = jest.fn().mockResolvedValue([]);
    const runtime = createRuntime({
      managedBroadcastCalendarReservation: { findMany: reservationFindMany },
      chat: { findMany: jest.fn().mockResolvedValue([]) },
      managedBotChatCatalog: { findMany: jest.fn().mockResolvedValue([]) },
    });

    await expect(
      runtime.getChannelManagedBroadcastCalendar('channel-1', user, {}),
    ).resolves.toEqual(expect.objectContaining({ slots: [] }));
    expect(reservationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcast: { is: { publicationOccurrenceId: null } },
        }),
      }),
    );
  });

  it('does not overwrite publication-linked legacy occurrence rows', async () => {
    const occurrenceFindMany = jest.fn().mockResolvedValue([]);
    const runtime = createRuntime({});

    await (runtime as any).overwriteManagedBroadcastCalendarSlots(
      { managedBroadcastOccurrence: { findMany: occurrenceFindMany } },
      {
        sourceChatId: 'chat-1',
        entityType: ChatEntityType.CHAT,
        slots: [new Date('2026-07-12T09:00:00.000Z')],
        excludeBroadcastId: null,
        allowOverwrite: true,
      },
    );

    expect(occurrenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcast: { is: { publicationOccurrenceId: null } },
        }),
      }),
    );
  });

  it('returns a controlled conflict instead of overwriting a publication reservation', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const createMany = jest.fn();
    const executeRaw = jest.fn().mockResolvedValue(1);
    const runtime = createRuntime({});
    const tx = {
      $executeRaw: executeRaw,
      managedBroadcastOccurrence: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany,
      },
      publicationOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            broadcastId: 'publication-broadcast',
            scheduledAt: slot,
            targetChatId: 'chat-1',
          },
        ]),
        createMany: jest.fn(),
      },
    };

    await expect(
      (runtime as any).createManagedBroadcastOccurrencesWithOverwrite(tx, {
        broadcastId: 'legacy-broadcast',
        sourceChatId: 'chat-1',
        entityType: ChatEntityType.CHAT,
        fromOccurrenceIndex: 1,
        slots: [slot],
        targetChatIds: ['chat-1'],
        excludeBroadcastId: null,
        allowOverwrite: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BROADCAST_TARGET_SLOT_CONFLICT' }),
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('reserves unmaterialized Publication occurrences against legacy scheduling', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const createMany = jest.fn();
    const runtime = createRuntime({});
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastOccurrence: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany,
      },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            scheduledAt: slot,
            scheduleRevision: 3,
            schedule: { revision: 3 },
            publication: { targets: [{ targetChatId: 'chat-1' }] },
          },
        ]),
      },
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn(),
      },
    };

    await expect(
      (runtime as any).createManagedBroadcastOccurrencesWithOverwrite(tx, {
        broadcastId: 'legacy-broadcast',
        sourceChatId: 'chat-1',
        entityType: ChatEntityType.CHAT,
        fromOccurrenceIndex: 1,
        slots: [slot],
        targetChatIds: ['chat-1'],
        excludeBroadcastId: null,
        allowOverwrite: true,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BROADCAST_TARGET_SLOT_CONFLICT' }),
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('uses the persisted Publisher-signed keyboard without rebuilding it in publisher runtime', async () => {
    const resolveBroadcastButtonContext = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {},
      resolveBroadcastButtonContext,
    } as never);
    const signedButton = {
      type: 'link',
      text: 'Предложить пост',
      url: 'https://max.ru/publisher-bot?startapp=signed-publisher-context',
    };

    const message = await (runtime as any).messageRuntime.buildMessage(
      'channel-1',
      'channel',
      {
        textFormat: 'plain',
        buttons: [],
        buttonEnabled: false,
        buttonText: '',
        buttonUrl: '',
      },
      'Публикация',
      {},
      'publisher-bot',
      'publisher-bot',
      {
        value: {
          version: 1,
          dialogBotId: 'publisher-bot',
          buttons: [[signedButton]],
          reference: null,
        },
        required: true,
      },
    );

    expect(resolveBroadcastButtonContext).not.toHaveBeenCalled();
    expect(message.messageOptions?.buttons).toEqual([[signedButton]]);
  });

  it('does not apply Major channel signatures to Publisher deliveries', async () => {
    const preparePostText = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {},
      resolveBroadcastButtonContext: jest.fn(),
      channelPostSignatureService: { preparePostText },
    } as never);

    const message = await (runtime as any).messageRuntime.buildMessage(
      'channel-1',
      'channel',
      {
        textFormat: 'plain',
        buttons: [],
        buttonEnabled: false,
        buttonText: '',
        buttonUrl: '',
      },
      'Текст Публика',
      {},
      'publisher-bot',
      'publisher-bot',
      {
        value: {
          version: 1,
          dialogBotId: 'publisher-bot',
          buttons: [],
          reference: null,
        },
        required: true,
      },
    );

    expect(preparePostText).not.toHaveBeenCalled();
    expect(message.messageText).toBe('Текст Публика');
  });

  it('rechecks Publisher actor access only through exact Publisher edges', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ chatId: 'chat-publisher-only' }, { chatId: 'chat-shared' }]);
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: { managedEntityAccessEdge: { findMany } },
    } as never);

    await expect(
      (runtime as any).publisherDispatch.assertActorAdminAccess({
        targetChatIds: ['chat-publisher-only', 'chat-shared'],
        actorUserId: 'admin-1',
        entityType: 'chat',
        requiredBotId: 'publisher-bot',
      }),
    ).resolves.toBeUndefined();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: { in: ['chat-publisher-only', 'chat-shared'] },
          userId: 'admin-1',
          botId: 'publisher-bot',
          chat: expect.objectContaining({
            publisherBinding: expect.any(Object),
          }),
        }),
      }),
    );
  });

  it('defers Publisher execution when any exact Publisher access edge is missing', async () => {
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedEntityAccessEdge: {
          findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-1' }]),
        },
      },
    } as never);

    await expect(
      (runtime as any).publisherDispatch.assertActorAdminAccess({
        targetChatIds: ['chat-1', 'chat-2'],
        actorUserId: 'admin-1',
        entityType: 'chat',
        requiredBotId: 'publisher-bot',
      }),
    ).rejects.toMatchObject({ blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED' });
  });

  it('clears only the exact Publisher actor-access blocker after access returns', async () => {
    const broadcastUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const leaseQuery = jest.fn(async (_query: Prisma.Sql) => [{ id: 'broadcast-publik' }]);
    const occurrenceUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdate = jest.fn().mockResolvedValue({ count: 2 });
    const tx = {
      $queryRaw: leaseQuery,
      managedBroadcast: { updateMany: broadcastUpdate },
      $executeRaw: occurrenceUpdate,
      publicationOccurrence: { updateMany: occurrenceUpdate },
      managedBroadcastDelivery: { updateMany: deliveryUpdate },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedEntityAccessEdge: {
          findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-1' }, { chatId: 'chat-2' }]),
        },
        $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
      },
    } as never);

    await expect(
      (runtime as any).publisherDispatch.ensureActorAdminAccess({
        row: {
          id: 'broadcast-publik',
          publicationOccurrenceId: 'occurrence-publik',
          requiredBotId: 'publisher-bot',
        },
        occurrenceIndex: 1,
        lease: { lockedAt: new Date('2026-08-27T10:00:00.000Z'), lockToken: 'lease-1' },
        targetChatIds: ['chat-1', 'chat-2'],
        actorUserId: 'admin-1',
        entityType: 'chat',
        requiredBotId: 'publisher-bot',
      }),
    ).resolves.toEqual({ ready: true });

    expect(leaseQuery).toHaveBeenCalledTimes(1);
    expect(leaseQuery.mock.calls[0]![0].values).toEqual([
      'broadcast-publik',
      new Date('2026-08-27T10:00:00.000Z'),
      'lease-1',
    ]);
    expect(leaseQuery.mock.calls[0]![0].text).toContain('FOR NO KEY UPDATE');
    expect(broadcastUpdate).not.toHaveBeenCalled();
    const blockerWrite = occurrenceUpdate.mock.calls[0][0];
    expect(blockerWrite.values).toEqual([
      'PUBLISHER_EXPLICIT_RETRY',
      null,
      null,
      expect.any(Date),
      'occurrence-publik',
      'PUBLISHER_ACTOR_ACCESS_REQUIRED',
    ]);
    expect(blockerWrite.strings.join('?')).toContain('AND "dispatch_blocker_code" = ?');
    expect(deliveryUpdate).toHaveBeenCalledWith({
      where: {
        broadcastId: 'broadcast-publik',
        occurrenceIndex: 1,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        status: ManagedBroadcastDeliveryStatus.PENDING,
        dispatchBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      },
      data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
    });
  });

  it('requests missing actor access without treating the queued refresh as authorization', async () => {
    const requestActorAccessRefresh = jest.fn().mockResolvedValue(undefined);
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedEntityAccessEdge: {
          findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-ready' }]),
        },
      },
      publisherReadinessService: { requestActorAccessRefresh },
      logger: { warn: jest.fn() },
    } as never);
    await expect(
      (runtime as any).publisherDispatch.assertActorAdminAccess({
        targetChatIds: ['chat-ready', 'chat-stale'],
        actorUserId: 'author',
        entityType: 'chat',
        requiredBotId: 'publik',
      }),
    ).rejects.toMatchObject({ blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED' });
    expect(requestActorAccessRefresh).toHaveBeenCalledWith(
      [{ chatId: 'chat-stale', entityType: 'chat' }],
      'author',
      'publik',
    );
  });

  it('does not write actor blockers when the managed broadcast lease is already lost', async () => {
    const broadcastUpdate = jest.fn().mockResolvedValue({ count: 0 });
    const occurrenceUpdate = jest.fn();
    const deliveryUpdate = jest.fn();
    const tx = {
      managedBroadcast: { updateMany: broadcastUpdate },
      publicationOccurrence: { updateMany: occurrenceUpdate },
      managedBroadcastDelivery: { updateMany: deliveryUpdate },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedEntityAccessEdge: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
      },
      logger: { warn: jest.fn() },
    } as never);
    const lockedAt = new Date('2026-08-27T10:00:00.000Z');

    await expect(
      (runtime as any).publisherDispatch.ensureActorAdminAccess({
        row: {
          id: 'broadcast-publik',
          publicationOccurrenceId: 'occurrence-publik',
          requiredBotId: 'publisher-bot',
        },
        occurrenceIndex: 1,
        lease: { lockedAt, lockToken: 'lost-lease' },
        targetChatIds: ['chat-1'],
        actorUserId: 'admin-1',
        entityType: 'chat',
        requiredBotId: 'publisher-bot',
      }),
    ).resolves.toEqual({ ready: false, leaseLost: true, retryAt: null });

    expect(broadcastUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lockedAt, lockToken: 'lost-lease' }),
      }),
    );
    expect(occurrenceUpdate).not.toHaveBeenCalled();
    expect(deliveryUpdate).not.toHaveBeenCalled();
  });

  it('does not clear recovered actor blockers after its cleanup lease is lost', async () => {
    const broadcastUpdate = jest.fn().mockResolvedValue({ count: 0 });
    const leaseQuery = jest.fn(async (_query: Prisma.Sql) => [] as Array<{ id: string }>);
    const occurrenceUpdate = jest.fn();
    const deliveryUpdate = jest.fn();
    const tx = {
      $queryRaw: leaseQuery,
      managedBroadcast: { updateMany: broadcastUpdate },
      publicationOccurrence: { updateMany: occurrenceUpdate },
      managedBroadcastDelivery: { updateMany: deliveryUpdate },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedEntityAccessEdge: {
          findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-1' }]),
        },
        $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
      },
    } as never);

    await expect(
      (runtime as any).publisherDispatch.ensureActorAdminAccess({
        row: {
          id: 'broadcast-publik',
          publicationOccurrenceId: 'occurrence-publik',
          requiredBotId: 'publisher-bot',
        },
        occurrenceIndex: 1,
        lease: {
          lockedAt: new Date('2026-08-27T10:00:00.000Z'),
          lockToken: 'stale-cleanup-lease',
        },
        targetChatIds: ['chat-1'],
        actorUserId: 'admin-1',
        entityType: 'chat',
        requiredBotId: 'publisher-bot',
      }),
    ).resolves.toEqual({ ready: false, leaseLost: true, retryAt: null });

    expect(leaseQuery).toHaveBeenCalledTimes(1);
    expect(leaseQuery.mock.calls[0]![0].values).toEqual([
      'broadcast-publik',
      new Date('2026-08-27T10:00:00.000Z'),
      'stale-cleanup-lease',
    ]);
    expect(broadcastUpdate).not.toHaveBeenCalled();
    expect(occurrenceUpdate).not.toHaveBeenCalled();
    expect(deliveryUpdate).not.toHaveBeenCalled();
  });

  it('returns the persisted outcome when actor-access deferral loses its lease', async () => {
    const persisted = {
      status: 'ACTIVE',
      currentOccurrence: 1,
      sentChatIds: [],
      failedChatIds: [],
      pendingChatIds: ['chat-1'],
      canRetry: false,
      firstSendError: null,
      nextSendAt: null,
    };
    const readLostLeaseResult = jest.fn().mockResolvedValue(persisted);

    await expect(
      ensureManagedBroadcastActorAccessBeforeExecution({
        context: {} as never,
        prisma: {} as never,
        logger: {} as never,
        publisherDispatch: {
          ensureActorAdminAccess: jest
            .fn()
            .mockResolvedValue({ ready: false, leaseLost: true, retryAt: null }),
        } as never,
        row: { id: 'broadcast-publik', actorUserId: 'admin-1' } as never,
        occurrenceIndex: 1,
        lease: { lockedAt: new Date('2026-08-27T10:00:00.000Z'), lockToken: 'lost' },
        targetChatIds: ['chat-1'],
        entityType: 'chat',
        requiredPublisherBotId: 'publisher-bot',
        readLostLeaseResult,
      }),
    ).resolves.toBe(persisted);
    expect(readLostLeaseResult).toHaveBeenCalledTimes(1);
  });

  it('leaves Publik deliveries pending when the publisher runtime boundary is disabled', async () => {
    const publicationOccurrenceUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const broadcastUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: publicationOccurrenceUpdate,
      publicationOccurrence: { updateMany: publicationOccurrenceUpdate },
      managedBroadcastDelivery: { updateMany: deliveryUpdate },
      managedBroadcast: { updateMany: broadcastUpdate },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: { $transaction: (callback: (client: typeof tx) => unknown) => callback(tx) },
      publisherRuntimeBoundaryService: {
        assertDispatchEnabled: () => {
          throw new Error('disabled');
        },
      },
      logger: { warn: jest.fn() },
    } as never);

    const result = await (runtime as any).publisherDispatch.ensureRuntimeBoundary(
      {
        id: 'broadcast-publik',
        publicationOccurrenceId: 'occurrence-publik',
      },
      1,
      { lockToken: 'broadcast-lock', lockedAt: new Date(), lastHeartbeatAt: new Date() },
    );

    expect(result).toEqual({ ready: false, retryAt: expect.any(Date) });
    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        }),
        data: expect.objectContaining({
          dispatchBlockerCode: 'PUBLISHER_RUNTIME_UNAVAILABLE',
        }),
      }),
    );
    expect(broadcastUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
  });

  it('serializes publisher blocker cleanup writes within the two-connection pool', async () => {
    let releaseOccurrence!: () => void;
    const occurrenceGate = new Promise<{ count: number }>((resolve) => {
      releaseOccurrence = () => resolve({ count: 1 });
    });
    const occurrenceUpdate = jest.fn().mockReturnValue(occurrenceGate);
    const deliveryUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'broadcast-publik' }]),
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $executeRaw: occurrenceUpdate,
      publicationOccurrence: { updateMany: occurrenceUpdate },
      managedBroadcastDelivery: { updateMany: deliveryUpdate },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
      },
      publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
    } as never);

    const boundary = (runtime as any).publisherDispatch.ensureRuntimeBoundary(
      { id: 'broadcast-publik', publicationOccurrenceId: 'occurrence-publik' },
      1,
      { lockedAt: new Date('2026-08-27T10:00:00.000Z'), lockToken: 'broadcast-lock' },
    );
    while (occurrenceUpdate.mock.calls.length === 0) await Promise.resolve();

    expect(deliveryUpdate).not.toHaveBeenCalled();
    releaseOccurrence();
    await expect(boundary).resolves.toEqual({ ready: true });
    expect(deliveryUpdate).toHaveBeenCalledTimes(1);
  });

  it('serializes claimed-delivery and occurrence deferral writes', async () => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<{ count: number }>((resolve) => {
      releaseDelivery = () => resolve({ count: 1 });
    });
    const deliveryUpdate = jest.fn().mockReturnValue(deliveryGate);
    const occurrenceUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $executeRaw: occurrenceUpdate,
        publicationOccurrence: { updateMany: occurrenceUpdate },
        managedBroadcastDelivery: { updateMany: deliveryUpdate },
      },
    } as never);

    const deferral = (runtime as any).publisherDispatch.deferClaimed({
      row: {
        id: 'broadcast-publik',
        publicationOccurrenceId: 'occurrence-publik',
        requiredBotId: 'publisher-bot',
      },
      delivery: { id: 'delivery-publik', targetChatId: 'chat-1' },
      deliveryLockToken: 'delivery-lock',
      blockerCode: 'PUBLISHER_RUNTIME_UNAVAILABLE',
    });
    while (deliveryUpdate.mock.calls.length === 0) await Promise.resolve();

    expect(occurrenceUpdate).not.toHaveBeenCalled();
    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          lastErrorCode: null,
        }),
      }),
    );
    releaseDelivery();
    await expect(deferral).resolves.toBeInstanceOf(Date);
    expect(occurrenceUpdate).toHaveBeenCalledTimes(1);
  });

  it('blocks an individual pending delivery when its policy is toggled off before claim', async () => {
    const deliveryUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcastDelivery: { updateMany: deliveryUpdate },
      },
      publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
      publisherDispatchHealthService: {
        assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      },
      publisherReadinessService: {
        assertEntityReady: jest
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('disabled'), { blockerCode: 'policy_disabled' }),
          ),
      },
    } as never);

    const retryAt = await (runtime as any).publisherDispatch.deferUnreadyBeforeClaim(
      { id: 'broadcast-publik', publicationOccurrenceId: null },
      { id: 'delivery-publik', targetChatId: 'chat-1' },
      'publisher-bot',
      { kind: 'legacy_actor', actorUserId: 'author', entityType: 'chat' },
    );

    expect(retryAt).toEqual(expect.any(Date));
    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          requiredBotId: 'publisher-bot',
        }),
        data: {
          dispatchBlockerCode: 'policy_disabled',
          dispatchBlockedAt: expect.any(Date),
        },
      }),
    );
  });
});
