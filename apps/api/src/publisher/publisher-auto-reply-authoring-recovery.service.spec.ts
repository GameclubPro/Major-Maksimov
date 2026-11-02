import { type Prisma, PublisherAutoReplyAuthoringState } from '../prisma/prisma-client';
import { PublisherAutoReplyAuthoringRecoveryService } from './publisher-auto-reply-authoring-recovery.service';
import type { PublisherAutoReplyAuthoringQueueService } from './publisher-auto-reply-authoring.queue';

describe('PublisherAutoReplyAuthoringRecoveryService', () => {
  it('requeues live PROCESSING, SAVING, and pending notification work', async () => {
    const now = new Date('2026-08-29T12:10:15.000Z');
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'processing-1' }])
      .mockResolvedValueOnce([{ id: 'saving-1', callbackId: 'callback-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'notification-1', notificationKind: 'ready', callbackId: 'callback-2' },
        { id: 'unknown-notification', notificationKind: 'future_kind', callbackId: null },
      ])
      .mockResolvedValueOnce([]);
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findMany,
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    const queue = {
      enqueueProcessContent: jest.fn().mockResolvedValue(undefined),
      enqueueActivation: jest.fn().mockResolvedValue(undefined),
      enqueueNotification: jest.fn().mockResolvedValue(undefined),
    };
    const privateFlows = { releaseExpired: jest.fn().mockResolvedValue(0) };
    const backgroundWork = {
      runExclusive: jest.fn((_name: string, operation: () => Promise<void>) => operation()),
    };
    const service = new PublisherAutoReplyAuthoringRecoveryService(
      prisma as never,
      queue as never,
      privateFlows as never,
      backgroundWork as never,
      { dispatchEnabled: true } as never,
    );

    await expect(service.recoverOnce(now)).resolves.toBeUndefined();

    expect(findMany.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          state: PublisherAutoReplyAuthoringState.PROCESSING,
          expiresAt: { gt: now },
          OR: expect.arrayContaining([{ lockedAt: null }]),
        }),
      }),
    );
    expect(findMany.mock.calls[3]?.[0]).toEqual(
      expect.objectContaining({
        where: {
          state: PublisherAutoReplyAuthoringState.SAVING,
          expiresAt: { gt: now },
        },
      }),
    );
    expect(findMany.mock.calls[4]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          notificationClaimRevision: { not: null },
        }),
      }),
    );
    expect(queue.enqueueProcessContent).toHaveBeenCalledWith('processing-1', now);
    expect(queue.enqueueActivation).toHaveBeenCalledWith({
      sessionId: 'saving-1',
      callbackId: 'callback-1',
      requestedAt: now,
    });
    expect(queue.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(queue.enqueueNotification).toHaveBeenCalledWith({
      sessionId: 'notification-1',
      notification: 'ready',
      callbackId: 'callback-2',
      dedupeKey: `recovery-ready-${Math.floor(now.getTime() / 30_000)}`,
      requestedAt: now,
    });
    expect(privateFlows.releaseExpired).toHaveBeenCalledWith(now);
    expect(backgroundWork.runExclusive).toHaveBeenCalledWith(
      'auto_reply_authoring_recovery',
      expect.any(Function),
    );
  });

  it('marks a stale superseded send ambiguous without clearing the newer notification', async () => {
    const now = new Date('2026-08-29T12:10:15.000Z');
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'session-1',
          notificationRevision: 8,
          notificationClaimRevision: 7,
          notificationLockToken: 'old-lock',
        },
      ])
      .mockResolvedValueOnce([{ id: 'session-1', notificationKind: 'ready', callbackId: null }])
      .mockResolvedValueOnce([]);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: { findMany, updateMany, deleteMany: jest.fn() },
    };
    const queue = {
      enqueueProcessContent: jest.fn(),
      enqueueActivation: jest.fn(),
      enqueueNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PublisherAutoReplyAuthoringRecoveryService(
      prisma as never,
      queue as never,
      { releaseExpired: jest.fn().mockResolvedValue(0) } as never,
      { runExclusive: jest.fn((_lane: string, run: () => Promise<void>) => run()) } as never,
      { dispatchEnabled: true } as never,
    );

    await service.recoverOnce(now);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-1',
        notificationRevision: 8,
        notificationClaimRevision: 7,
        notificationLockToken: 'old-lock',
        notificationDispatchStartedAt: { not: null },
      },
      data: {
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationClaimRevision: null,
        notificationDispatchStartedAt: null,
        notificationLastAmbiguousRevision: 7,
      },
    });
    expect(queue.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', notification: 'ready' }),
    );
  });

  it('settles an unchanged stale revision without requeueing its uncertain notification', async () => {
    const now = new Date('2026-08-29T12:10:15.000Z');
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'session-1',
          notificationRevision: 7,
          notificationClaimRevision: 7,
          notificationLockToken: 'old-lock',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const updateMany = jest
      .fn<Promise<Prisma.BatchPayload>, [Prisma.PublisherAutoReplyAuthoringSessionUpdateManyArgs]>()
      .mockResolvedValue({ count: 1 });
    const queue = {
      enqueueProcessContent: jest
        .fn<
          ReturnType<PublisherAutoReplyAuthoringQueueService['enqueueProcessContent']>,
          Parameters<PublisherAutoReplyAuthoringQueueService['enqueueProcessContent']>
        >()
        .mockResolvedValue(undefined),
      enqueueActivation: jest
        .fn<
          ReturnType<PublisherAutoReplyAuthoringQueueService['enqueueActivation']>,
          Parameters<PublisherAutoReplyAuthoringQueueService['enqueueActivation']>
        >()
        .mockResolvedValue(undefined),
      enqueueNotification: jest
        .fn<
          ReturnType<PublisherAutoReplyAuthoringQueueService['enqueueNotification']>,
          Parameters<PublisherAutoReplyAuthoringQueueService['enqueueNotification']>
        >()
        .mockResolvedValue(undefined),
    } satisfies Pick<
      PublisherAutoReplyAuthoringQueueService,
      'enqueueProcessContent' | 'enqueueActivation' | 'enqueueNotification'
    >;
    const service = new PublisherAutoReplyAuthoringRecoveryService(
      {
        publisherAutoReplyAuthoringSession: { findMany, updateMany, deleteMany: jest.fn() },
      } as never,
      queue as never,
      { releaseExpired: jest.fn().mockResolvedValue(0) } as never,
      { runExclusive: jest.fn((_lane: string, run: () => Promise<void>) => run()) } as never,
      { dispatchEnabled: true } as never,
    );

    await service.recoverOnce(now);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-1',
        notificationRevision: 7,
        notificationClaimRevision: 7,
        notificationLockToken: 'old-lock',
        notificationDispatchStartedAt: { not: null },
      },
      data: {
        notificationPending: false,
        notificationKind: null,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationClaimRevision: null,
        notificationDispatchStartedAt: null,
        notificationLastAmbiguousRevision: 7,
      },
    });
    expect(queue.enqueueNotification).not.toHaveBeenCalled();
  });

  it('garbage-collects only archived drafts and now-unreferenced assets before session expiry', async () => {
    const now = new Date('2026-08-29T12:10:15.000Z');
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'terminal-session' }]);
    const ruleDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const assetDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const sessionDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      publisherAutoReplyRule: { deleteMany: ruleDeleteMany },
      publisherAutoReplyAsset: { deleteMany: assetDeleteMany },
      publisherAutoReplyAuthoringSession: { deleteMany: sessionDeleteMany },
    };
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findMany,
        updateMany: jest.fn(),
        deleteMany: sessionDeleteMany,
      },
      publisherAutoReplyRule: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'draft-rule',
            contentRevisions: [{ assets: [{ assetId: 'asset-1' }, { assetId: 'asset-1' }] }],
          },
        ]),
      },
      $transaction: jest.fn((run: (client: typeof tx) => Promise<void>) => run(tx)),
    };
    const service = new PublisherAutoReplyAuthoringRecoveryService(
      prisma as never,
      {
        enqueueProcessContent: jest.fn(),
        enqueueActivation: jest.fn(),
        enqueueNotification: jest.fn(),
      } as never,
      { releaseExpired: jest.fn().mockResolvedValue(0) } as never,
      { runExclusive: jest.fn((_lane: string, run: () => Promise<void>) => run()) } as never,
      { dispatchEnabled: true } as never,
    );

    await service.recoverOnce(now);

    expect(ruleDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['draft-rule'] },
        authoringSessionId: { in: ['terminal-session'] },
        archivedAt: { not: null },
        enabled: false,
      },
    });
    expect(assetDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['asset-1'] }, contentLinks: { none: {} } },
    });
    expect(sessionDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['terminal-session'] } }),
      }),
    );
  });
});
