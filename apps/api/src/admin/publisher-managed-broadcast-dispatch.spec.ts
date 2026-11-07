import {
  PublisherDeliveryDeferredError,
  PublisherManagedBroadcastDispatch,
} from './publisher-managed-broadcast-dispatch';
import type { Prisma } from '../prisma/prisma-client';

describe('Publisher pre-dispatch claim deferral', () => {
  it('keeps shared blocker cleanup fenced by the exact envelope lease', async () => {
    const queryRaw = jest.fn(async (_query: Prisma.Sql) => [] as Array<{ id: string }>);
    const executeRaw = jest.fn();
    const service = new PublisherManagedBroadcastDispatch(
      {
        prisma: {
          $transaction: async (run: (tx: unknown) => unknown) =>
            run({
              $queryRaw: queryRaw,
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
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const query = queryRaw.mock.calls[0]![0];
    expect(query.values).toEqual(['broadcast', lease.lockedAt, lease.lockToken]);
    expect(query.text).toContain('"dispatch_profile" = \'PUBLIK_V1\'');
    for (const status of ['ACTIVE', 'PARTIAL', 'FAILED'])
      expect(query.text).toContain(`'${status}'::"ManagedBroadcastStatus"`);
    expect(query.text).toContain('"locked_at" = $2');
    expect(query.text).toContain('"lock_token" = $3');
    expect(query.text).toContain('FOR NO KEY UPDATE');
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('refuses runtime blocker cleanup after the exact envelope lease is lost', async () => {
    const queryRaw = jest.fn(async (_query: Prisma.Sql) => [] as Array<{ id: string }>);
    const executeRaw = jest.fn();
    const deliveryUpdate = jest.fn();
    const service = new PublisherManagedBroadcastDispatch(
      {
        prisma: {
          $transaction: async (run: (tx: unknown) => unknown) =>
            run({
              $queryRaw: queryRaw,
              $executeRaw: executeRaw,
              managedBroadcastDelivery: { updateMany: deliveryUpdate },
            }),
        },
        publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
      } as never,
      {} as never,
    );
    await expect(
      service.ensureRuntimeBoundary(
        { id: 'broadcast', publicationOccurrenceId: 'occurrence', requiredBotId: 'publik' },
        1,
        { lockedAt: new Date(), lockToken: 'old-lease' },
      ),
    ).resolves.toEqual({ ready: false, leaseLost: true, retryAt: null });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled();
    expect(deliveryUpdate).not.toHaveBeenCalled();
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
