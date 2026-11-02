import {
  PublisherDeliveryDeferredError,
  PublisherManagedBroadcastDispatch,
} from './publisher-managed-broadcast-dispatch';

describe('Publisher pre-dispatch claim deferral', () => {
  it('keeps shared blocker cleanup fenced by the exact envelope lease', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const executeRaw = jest.fn();
    const service = new PublisherManagedBroadcastDispatch(
      {
        prisma: {
          $transaction: async (run: (tx: unknown) => unknown) =>
            run({
              managedBroadcast: { updateMany },
              $executeRaw: executeRaw,
            }),
        },
      } as never,
      {} as never,
    );
    const lease = { lockedAt: new Date(), lockToken: 'old-lease' };
    expect(
      await service.clearResolvedRecipientBlocker(
        { id: 'broadcast', publicationOccurrenceId: 'occurrence', requiredBotId: 'publik' },
        lease,
      ),
    ).toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'broadcast',
          lockedAt: lease.lockedAt,
          lockToken: lease.lockToken,
        }),
      }),
    );
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('rechecks author authority at the final send boundary after a valid bot route', async () => {
    const requestActorAccessRefresh = jest.fn().mockResolvedValue(undefined);
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PublisherManagedBroadcastDispatch(
      {
        prisma: { managedEntityAccessEdge: { findMany } },
        publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
        publisherDispatchHealthService: { assertDispatchAllowed: jest.fn() },
        publisherReadinessService: {
          assertEntityReady: jest.fn().mockResolvedValue({
            requiredBotId: 'publik',
            entityType: 'channel',
          }),
          requestActorAccessRefresh,
        },
      } as never,
      {} as never,
    );
    await expect(
      service.assertDeliveryReady('chat', 'publik', {
        kind: 'legacy_actor',
        actorUserId: 'actor',
        entityType: 'channel',
      }),
    ).rejects.toBeInstanceOf(PublisherDeliveryDeferredError);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      chatId: { in: ['chat'] },
      userId: 'actor',
      botId: 'publik',
      entityType: 'CHANNEL',
      state: 'GRANTED',
      userRole: { in: ['OWNER', 'ADMIN'] },
    });
    expect(requestActorAccessRefresh).toHaveBeenCalledWith(
      [{ chatId: 'chat', entityType: 'channel' }],
      'actor',
      'publik',
    );
  });

  function acceptedHarness() {
    const occurrence = {
      contentRevisionId: 'content',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: 'publik',
      status: 'IN_PROGRESS',
      scheduleRevision: 1,
      deliveryDeadlineAt: new Date(Date.now() + 86_400_000) as Date | null,
      retryAuthorizedAt: null,
      retryExpiresAt: null,
      publication: {
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publik',
        targets: [{ canceledAt: null as Date | null }],
      },
      schedule: { status: 'ACTIVE', revision: 1 },
    };
    const findMany = jest.fn().mockResolvedValue([]);
    const requestActorAccessRefresh = jest.fn();
    const service = new PublisherManagedBroadcastDispatch(
      {
        prisma: {
          publicationOccurrence: { findUnique: jest.fn(async () => occurrence) },
          managedEntityAccessEdge: { findMany },
        },
        publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
        publisherDispatchHealthService: { assertDispatchAllowed: jest.fn() },
        publisherReadinessService: {
          assertEntityReady: jest
            .fn()
            .mockResolvedValue({ requiredBotId: 'publik', entityType: 'channel' }),
          requestActorAccessRefresh,
        },
      } as never,
      {} as never,
    );
    const authority = {
      kind: 'publication',
      occurrenceId: 'occurrence',
      contentRevisionId: 'content',
      actorUserId: 'former-admin',
      entityType: 'channel',
    } as const satisfies Parameters<PublisherManagedBroadcastDispatch['assertDeliveryReady']>[2];
    return { service, occurrence, findMany, requestActorAccessRefresh, authority };
  }

  it('executes finite accepted entity intent without its former author grant or a refresh', async () => {
    const f = acceptedHarness();
    await expect(
      f.service.assertDeliveryReady('channel', 'publik', f.authority),
    ).resolves.toBeUndefined();
    expect(f.findMany).not.toHaveBeenCalled();
    expect(f.requestActorAccessRefresh).not.toHaveBeenCalled();
  });

  it('retains the author fence for old indefinite intent', async () => {
    const f = acceptedHarness();
    f.occurrence.deliveryDeadlineAt = null;
    await expect(
      f.service.assertDeliveryReady('channel', 'publik', f.authority),
    ).rejects.toMatchObject({
      blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
    });
    expect(f.findMany).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'refuses a canceled recipient before SEND, legacy intent=%s',
    async (legacy) => {
      const f = acceptedHarness();
      if (legacy) f.occurrence.deliveryDeadlineAt = null;
      f.occurrence.publication.targets[0]!.canceledAt = new Date();
      await expect(
        f.service.assertDeliveryReady('channel', 'publik', f.authority),
      ).rejects.toMatchObject({ blockerCode: 'PUBLISHER_TARGET_CANCELED' });
      expect(f.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'preserves existing authority when no saved target exists, legacy intent=%s',
    async (legacy) => {
      const f = acceptedHarness();
      f.occurrence.publication.targets = [];
      if (legacy) {
        f.occurrence.deliveryDeadlineAt = null;
        await expect(
          f.service.assertDeliveryReady('channel', 'publik', f.authority),
        ).rejects.toMatchObject({ blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED' });
        expect(f.findMany).toHaveBeenCalledTimes(1);
      } else {
        await expect(
          f.service.assertDeliveryReady('channel', 'publik', f.authority),
        ).resolves.toBeUndefined();
        expect(f.findMany).not.toHaveBeenCalled();
      }
    },
  );

  it('never falls back to author authority after finite intent expires', async () => {
    const f = acceptedHarness();
    f.occurrence.deliveryDeadlineAt = new Date(Date.now() - 1);
    await expect(
      f.service.assertDeliveryReady('channel', 'publik', f.authority),
    ).rejects.toMatchObject({
      blockerCode: 'PUBLISHER_MISSED_WINDOW_REVIEW',
    });
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it.each(['content', 'schedule', 'bot', 'lifecycle', 'entity'] as const)(
    'rejects changed %s proof at the final boundary',
    async (change) => {
      const f = acceptedHarness();
      if (change === 'content') f.occurrence.contentRevisionId = 'changed';
      if (change === 'schedule') f.occurrence.schedule.revision = 2;
      if (change === 'bot') f.occurrence.requiredBotId = 'other';
      if (change === 'lifecycle') f.occurrence.publication.lifecycle = 'CANCELED';
      const authority =
        change === 'entity' ? { ...f.authority, entityType: 'chat' as const } : f.authority;
      await expect(
        f.service.assertDeliveryReady('channel', 'publik', authority),
      ).rejects.toBeInstanceOf(PublisherDeliveryDeferredError);
      expect(f.findMany).not.toHaveBeenCalled();
    },
  );

  it.each([false, true, undefined])(
    'preserves actual attempts with sendAttemptStarted=%s',
    async (sendAttemptStarted) => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const service = new PublisherManagedBroadcastDispatch(
        { prisma: { managedBroadcastDelivery: { updateMany } } } as never,
        {} as never,
      );
      await service.deferClaimed({
        row: { id: 'broadcast', publicationOccurrenceId: null, requiredBotId: 'publik' },
        delivery: {
          id: 'delivery',
          targetChatId: 'chat',
          dialogBotId: 'publik',
          contentRevisionId: 'content',
        },
        deliveryLockToken: 'exact-lock',
        blockerCode: 'bot_access_expired',
        sendAttemptStarted,
      });
      const write = updateMany.mock.calls[0][0];
      expect(write.where).toMatchObject({
        id: 'delivery',
        status: 'SENDING',
        lockToken: 'exact-lock',
        requiredBotId: 'publik',
      });
      expect(write.data).toMatchObject({ status: 'PENDING', lockToken: null });
      if (sendAttemptStarted === false) {
        expect(write.where.attemptCount).toEqual({ gt: 0 });
        expect(write.data.attemptCount).toEqual({ decrement: 1 });
      } else {
        expect(write.where).not.toHaveProperty('attemptCount');
        expect(write.data).not.toHaveProperty('attemptCount');
      }
    },
  );
});
