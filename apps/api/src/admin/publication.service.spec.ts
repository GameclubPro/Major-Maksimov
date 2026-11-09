import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationAudienceMode,
  PublicationAudienceSelection,
  PublicationContentFormat,
  PublicationDeliveryVerificationSource,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import {
  DEFAULT_PUBLICATION_LATE_POLICY,
  MAX_PUBLICATION_EXPLICIT_SLOTS,
  type PublicationScheduleInput,
} from '@maxim/contracts/publication';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { PublicationOccurrenceRollupNoopRollout } from './publication-occurrence-rollup-noop';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { buildMaxActionNoExecutableRouteMessage } from '../max/max-action-dispatch-error';
import { validateMaxMediaUploadPayload } from '../max/max-media-upload-validation';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import {
  type PreparedPublicationContentRevision,
  PublicationContentService,
} from './publication-content.service';
import {
  PUBLICATION_DELIVERY_PRESENTATION_INCLUDE,
  PublicationPresenterService,
} from './publication-presenter.service';
import {
  LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE,
  PublicationPublisherRoutingService,
} from './publication-publisher-routing.service';
import { PublicationService } from './publication.service';
import { publicationAdminAccessWhere, publicationAdminScope } from './publication-admin-access';
import {
  LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
  LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
} from './publication-legacy-automated-absence';
import { syncPublicationBroadcastAfterDeliveryResolution } from './publication-execution-recovery';
import {
  PUBLICATION_MAX_VIDEO_BYTES,
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
} from './publication-video-media';
import { TINY_VALID_MP4 } from '../../test/fixtures/max-media';

function createService(
  prismaOverrides: Record<string, unknown> = {},
  rollupMode: PublicationOccurrenceRollupNoopRollout = 'off',
) {
  const prisma = {
    managedBroadcastDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
    managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...prismaOverrides,
  };
  const contentService = new PublicationContentService(
    prisma as never,
    {
      validateMediaUploadPayload: validateMaxMediaUploadPayload,
    } as never,
  );
  const presenter = new PublicationPresenterService(prisma as never);
  const managedEntitiesService = {
    listChats: jest.fn().mockResolvedValue([
      {
        id: 'chat-1',
        entityType: 'chat',
        title: 'Чат 1',
        avatarUrl: null,
        link: null,
      },
    ]),
    listChannels: jest.fn().mockResolvedValue([
      {
        id: 'channel-1',
        entityType: 'channel',
        title: 'Канал 1',
        avatarUrl: null,
        link: null,
      },
    ]),
    assertChatAdminAccess: jest.fn().mockResolvedValue(undefined),
    assertChannelAdminAccess: jest.fn().mockResolvedValue(undefined),
  };
  const publisherTargets = [
    {
      chatId: 'chat-1',
      entityType: 'chat' as const,
      title: 'Чат 1',
      avatarUrl: null,
      link: null,
    },
    {
      chatId: 'channel-1',
      entityType: 'channel' as const,
      title: 'Канал 1',
      avatarUrl: null,
      link: null,
    },
  ];
  const publisherPolicyService = {
    resolvePublicationTargets: jest.fn(
      async (
        _user: unknown,
        requested?: readonly { chatId: string; entityType: 'chat' | 'channel' }[],
      ) => {
        if (!requested) {
          return publisherTargets;
        }
        return requested.map((target) => {
          const resolved = publisherTargets.find(
            (candidate) =>
              candidate.chatId === target.chatId && candidate.entityType === target.entityType,
          );
          if (!resolved) {
            throw new BadRequestException('Publisher target unavailable');
          }
          return resolved;
        });
      },
    ),
  };
  const audienceRouting = new PublicationPublisherRoutingService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    managedEntitiesService as never,
    publisherPolicyService as never,
  );
  const publisherRouting = {
    resolveScheduledTargets: jest.fn(audienceRouting.resolveScheduledTargets.bind(audienceRouting)),
    resolveAudienceTargets: jest.fn(audienceRouting.resolveAudienceTargets.bind(audienceRouting)),
    resolvePersistedTargets: jest.fn(audienceRouting.resolvePersistedTargets.bind(audienceRouting)),
    requireNewRoute: jest.fn().mockReturnValue({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
    }),
    assertTargetsReady: jest.fn().mockImplementation(async (targets: any[]) =>
      targets.map((target) => ({
        ...target,
        requiredBotId: 'publisher-bot',
        policyRevision: 1,
      })),
    ),
    blockedRetryBefore: jest.fn((now: Date) => new Date(now.getTime() - 60_000)),
    deferOccurrenceIfBlocked: jest.fn().mockResolvedValue(false),
    prepareOccurrenceRoute: jest.fn().mockImplementation(async (_profile, _botId, targets) => ({
      broadcastData: {
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: 'publisher-bot',
      },
      deliveryDataByChatId: new Map(
        targets.map((target: any) => [
          target.chatId,
          {
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: 'publisher-bot',
            dialogBotId: 'primary-bot',
            publisherDialogContext: {
              version: 1,
              dialogBotId: 'primary-bot',
              buttons: [],
              reference: null,
            },
            publicationPolicyRevision: 1,
          },
        ]),
      ),
    })),
  };
  const publisherPublicationWakeupQueue = {
    enqueueAfterCommittedMutation: jest.fn().mockResolvedValue(undefined),
    enqueueResolution: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PublicationService(
    prisma as never,
    contentService,
    presenter,
    managedEntitiesService as never,
    {} as never,
    {} as never,
    {} as never,
    publisherRouting as never,
    publisherPublicationWakeupQueue as never,
    new ConfigService({ PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: rollupMode }),
  );
  return {
    contentService,
    presenter,
    service,
    prisma,
    managedEntitiesService,
    publisherPolicyService,
    publisherRouting,
    publisherPublicationWakeupQueue,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return (Array.isArray(strings) ? strings.join('?') : String(query)).replace(/\s+/gu, ' ').trim();
}

function extractSqlValues(query: unknown): readonly unknown[] {
  return (query as { values?: readonly unknown[] } | null)?.values ?? [];
}

function createPublicationUpdateTransaction() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    publication: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    publicationTarget: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    publicationSchedule: {
      update: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    publicationOccurrence: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn(),
    },
    managedBroadcast: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    managedBroadcastDelivery: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    publicationMutationRecord: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

function createPublicationScheduleRepairFixture() {
  const tx = {
    ...createPublicationUpdateTransaction(),
    managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const publication = {
    id: 'publication-repair',
    actorUserId: 'user-1',
    version: 3,
    lifecycle: PublicationLifecycle.ACTIVE as PublicationLifecycle,
    title: 'Stopped recurrence',
    audienceSelection: PublicationAudienceSelection.SELECTED,
    audienceMode: PublicationAudienceMode.SNAPSHOT,
    canonicalContentRevisionId: 'content-old',
    canonicalContentRevision: { id: 'content-old' },
    dispatchProfile: PublicationDispatchProfile.PUBLIK_V1 as PublicationDispatchProfile,
    requiredBotId: 'publisher-bot',
    targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
    schedule: {
      id: 'schedule-repair',
      revision: 4,
      status: PublicationScheduleStatus.ERROR as PublicationScheduleStatus,
      lastError: 'Recurring preparation failed',
      rule: {
        mode: 'recurrence',
        timezone: 'Europe/Moscow',
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        times: ['18:00'],
        startsAt: '2026-07-09T09:00:00.000Z',
        endsAt: null as string | null,
        maxOccurrences: null as number | null,
        replaceConflicts: false,
      },
    },
  };
  tx.publicationOccurrence.findMany.mockImplementation(
    async (query: { where: { publicationId: unknown } }) =>
      query.where.publicationId === publication.id ? [{ id: 'occurrence-stale' }] : [],
  );
  tx.managedBroadcast.findMany.mockResolvedValue([]);
  tx.publicationSchedule.update.mockResolvedValue({ id: publication.schedule.id });
  const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
  const fixture = createService({
    publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    publication: { findFirst: jest.fn().mockResolvedValue(publication) },
    publicationOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: transaction,
  });
  jest
    .spyOn(fixture.contentService, 'persistPreparedContentRevision')
    .mockResolvedValue({ id: 'content-new' } as never);
  jest.spyOn(fixture.service, 'get').mockResolvedValue({ id: publication.id } as never);
  return { ...fixture, publication, transaction, tx };
}

function createOriginalRetryService(
  tx: Record<string, unknown>,
  occurrenceStatus: PublicationOccurrenceStatus = PublicationOccurrenceStatus.FAILED,
) {
  const failedDeliveryCount = jest.fn().mockResolvedValue(1);
  const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
  const { service, managedEntitiesService } = createService({
    publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    publication: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'publication-1',
        version: 7,
        lifecycle: PublicationLifecycle.ERROR,
        canonicalContentRevisionId: 'content-latest',
        targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      }),
    },
    publicationOccurrence: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'occurrence-1',
        publicationId: 'publication-1',
        scheduleId: 'schedule-1',
        scheduleRevision: 5,
        contentRevisionId: 'content-original',
        contentRevision: { revision: 1 },
        status: occurrenceStatus,
        legacyBroadcastId: 'broadcast-1',
        schedule: { id: 'schedule-1', mode: PublicationScheduleMode.ONCE },
        legacyBroadcasts: [{ id: 'broadcast-1' }],
        _count: { deliveries: 1, legacyBroadcasts: 1 },
      }),
    },
    managedBroadcastDelivery: { count: failedDeliveryCount },
    $transaction: transaction,
  });
  jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);
  return { service, transaction, failedDeliveryCount, managedEntitiesService };
}

describe('PublicationService', () => {
  it.each(['bot_access_expired', 'bot_access_unconfirmed'] as const)(
    'rejects %s before either create or update prepares content, writes, or dispatches',
    async (blocker) => {
      const transaction = jest.fn();
      const { service, contentService, publisherRouting, publisherPublicationWakeupQueue } =
        createService({
          publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
          publication: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'draft-1',
              actorUserId: 'user-1',
              version: 2,
              lifecycle: PublicationLifecycle.DRAFT,
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              requiredBotId: 'publisher-bot',
              audienceSelection: 'SELECTED',
              audienceMode: 'SNAPSHOT',
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
              schedule: null,
            }),
          },
          $transaction: transaction,
        });
      const error = new PublisherSetupRequiredException(['chat-1'], blocker);
      publisherRouting.assertTargetsReady.mockRejectedValue(error);
      const prepare = jest.spyOn(contentService, 'prepareContentRevision');
      const actor = { userId: 'user-1', username: null, displayName: null };
      const content = { text: 'Текст', textFormat: 'plain', buttons: [], media: [] };
      const schedule = { mode: 'now', timezone: 'Europe/Moscow' };
      await expect(
        service.create(actor, {
          requestId: 'stale-access-create',
          title: 'Пост',
          content,
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          intent: 'publish',
          schedule,
        }),
      ).rejects.toBe(error);
      await expect(
        service.update('draft-1', actor, {
          requestId: 'stale-access-update',
          expectedRevision: 2,
          content,
          intent: 'publish',
          schedule,
        }),
      ).rejects.toBe(error);
      expect(prepare).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(publisherPublicationWakeupQueue.enqueueAfterCommittedMutation).not.toHaveBeenCalled();
    },
  );

  it('materializes and dispatches NOW publications and rolls up state while background work is paused', async () => {
    const { service } = createService();
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'pause',
        reason: 'user-facing queue lag 12.0s',
        retryAfterMs: 60_000,
      }),
    };
    const verificationBudget = { remaining: 50 };
    const managedBroadcastService = {
      processDueImmediatePublicationBroadcasts: jest.fn().mockResolvedValue(verificationBudget),
      processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).backgroundRuntimeGovernorService = backgroundRuntimeGovernorService;
    (service as any).managedBroadcastService = managedBroadcastService;
    const normalizeSpy = jest
      .spyOn(service as any, 'normalizeStalePublicationOccurrences')
      .mockResolvedValue(undefined);
    const reconcileOrphansSpy = jest
      .spyOn(service as any, 'reconcileOrphanedPublicationOccurrences')
      .mockResolvedValue(undefined);
    const reconcileSpy = jest
      .spyOn(service as any, 'reconcileActiveRecurrenceSchedules')
      .mockResolvedValue(undefined);
    const dispatchSpy = jest
      .spyOn(service as any, 'dispatchScheduledOccurrences')
      .mockResolvedValue(undefined);
    const materializeSpy = jest
      .spyOn(service as any, 'materializeRecurringSchedules')
      .mockResolvedValue(undefined);
    const rollupOccurrencesSpy = jest
      .spyOn(service as any, 'rollupActiveOccurrences')
      .mockResolvedValue(undefined);
    const rollupPublicationsSpy = jest
      .spyOn(service as any, 'rollupPublicationLifecycles')
      .mockResolvedValue(undefined);

    await service.processDuePublications('scheduled');

    expect(normalizeSpy).toHaveBeenCalledWith(200);
    expect(reconcileOrphansSpy).toHaveBeenCalledWith(200);
    expect(reconcileSpy).toHaveBeenCalledWith(200);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenNthCalledWith(1, 50, [PublicationScheduleMode.NOW]);
    expect(managedBroadcastService.processDueImmediatePublicationBroadcasts).not.toHaveBeenCalled();
    expect(managedBroadcastService.processDueDeadlinePublicationBroadcasts).not.toHaveBeenCalled();
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'publication-materializer',
      publicationMetadataOnly: true,
      sourceTag: 'managed_broadcast',
      allowRecoveryWindowRun: true,
      allowMaxApiCapacitySlowPath: true,
      allowQueueBacklogSlowPath: true,
    });
    expect(materializeSpy).not.toHaveBeenCalled();
    expect(rollupOccurrencesSpy).toHaveBeenCalledTimes(1);
    expect(rollupPublicationsSpy).toHaveBeenCalledTimes(1);
    expect(normalizeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileOrphansSpy.mock.invocationCallOrder[0],
    );
    expect(reconcileOrphansSpy.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchSpy.mock.invocationCallOrder[0],
    );
    expect(rollupOccurrencesSpy.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundRuntimeGovernorService.decide.mock.invocationCallOrder[0],
    );
    expect(rollupPublicationsSpy.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundRuntimeGovernorService.decide.mock.invocationCallOrder[0],
    );
  });

  it('bounds deadline materialization and delivery when the background governor is slow', async () => {
    const { service } = createService();
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockResolvedValue({
        action: 'slow',
        reason: 'MAX API capacity is constrained',
        retryAfterMs: 15_000,
      }),
    };
    const verificationBudget = { remaining: 50 };
    const managedBroadcastService = {
      processDueImmediatePublicationBroadcasts: jest.fn().mockResolvedValue(verificationBudget),
      processDueDeadlinePublicationBroadcasts: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).backgroundRuntimeGovernorService = backgroundRuntimeGovernorService;
    (service as any).managedBroadcastService = managedBroadcastService;
    jest.spyOn(service as any, 'normalizeStalePublicationOccurrences').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'reconcileOrphanedPublicationOccurrences')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'reconcileActiveRecurrenceSchedules').mockResolvedValue(undefined);
    const dispatchSpy = jest
      .spyOn(service as any, 'dispatchScheduledOccurrences')
      .mockResolvedValue(undefined);
    const materializeSpy = jest
      .spyOn(service as any, 'materializeRecurringSchedules')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'rollupActiveOccurrences').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'rollupPublicationLifecycles').mockResolvedValue(undefined);

    await service.processDuePublications('scheduled');

    expect(dispatchSpy).toHaveBeenNthCalledWith(1, 50, [PublicationScheduleMode.NOW]);
    expect(dispatchSpy).toHaveBeenNthCalledWith(2, 2, [
      PublicationScheduleMode.ONCE,
      PublicationScheduleMode.SLOTS,
      PublicationScheduleMode.RECURRENCE,
    ]);
    expect(dispatchSpy).toHaveBeenNthCalledWith(3, 2, [
      PublicationScheduleMode.ONCE,
      PublicationScheduleMode.SLOTS,
      PublicationScheduleMode.RECURRENCE,
    ]);
    expect(managedBroadcastService.processDueImmediatePublicationBroadcasts).not.toHaveBeenCalled();
    expect(managedBroadcastService.processDueDeadlinePublicationBroadcasts).not.toHaveBeenCalled();
    expect(materializeSpy).toHaveBeenCalledWith(2);
  });

  it('rechecks stale and untouched execution after locking envelopes during reconciliation', async () => {
    const now = new Date('2026-07-10T09:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'paused-past' }, { id: 'old-revision' }])
          .mockResolvedValueOnce([]),
        $executeRaw: jest.fn().mockResolvedValue(2),
      };
      const { service } = createService({
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      await (
        service as unknown as {
          normalizeStalePublicationOccurrences(limit: number): Promise<void>;
        }
      ).normalizeStalePublicationOccurrences(500);

      const selection = extractSqlText(tx.$queryRaw.mock.calls[0]?.[0]);
      const locked = extractSqlText(tx.$queryRaw.mock.calls[1]?.[0]);
      const update = extractSqlText(tx.$executeRaw.mock.calls[1]?.[0]);
      expect(extractSqlValues(tx.$queryRaw.mock.calls[0]?.[0])).toEqual([now, 200]);
      expect(selection).toContain('po."schedule_revision" <> ps."revision"');
      expect(selection).toContain('d."remote_message_id" IS NOT NULL');
      expect(selection).toContain('d."attempt_count" > 0');
      expect(selection).toContain('\'SENT\'::"ManagedBroadcastDeliveryStatus"');
      expect(selection).toContain('envelope."lock_token" IS NOT NULL');
      expect(selection).toMatch(/ORDER BY po\."scheduled_at" ASC, po\."id" ASC LIMIT \?$/u);
      expect(locked).toContain('FOR NO KEY UPDATE');
      expect(locked).not.toContain('updated_at');
      expect(update).toContain('po."schedule_revision" <> ps."revision"');
      expect(update).toContain('d."remote_message_id" IS NOT NULL');
      expect(update).toContain('envelope."lock_token" IS NOT NULL');
      expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        tx.$executeRaw.mock.invocationCallOrder[1]!,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('atomically reconciles old in-progress occurrences without execution envelopes', async () => {
    const now = new Date('2026-07-26T18:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const queryRaw = jest.fn().mockResolvedValue([
        { id: 'stale-revision', status: PublicationOccurrenceStatus.CANCELED },
        { id: 'current-error', status: PublicationOccurrenceStatus.FAILED },
      ]);
      const { service } = createService({ $queryRaw: queryRaw });
      const warn = jest.fn();
      (service as any).logger.warn = warn;

      await (service as any).reconcileOrphanedPublicationOccurrences(500);

      const query = queryRaw.mock.calls[0]?.[0];
      const selectionSql = extractSqlText(query);
      expect(extractSqlValues(query)).toEqual([new Date(now.getTime() - 5 * 60_000), 200]);
      expect(selectionSql).toContain(
        'WHERE po."status" = \'IN_PROGRESS\'::"PublicationOccurrenceStatus" AND po."scheduled_at" < ?',
      );
      expect(selectionSql).toContain('po."schedule_revision" <> ps."revision"');
      expect(selectionSql).toContain(
        '\'PAUSED\'::"PublicationScheduleStatus", \'COMPLETED\'::"PublicationScheduleStatus", \'CANCELED\'::"PublicationScheduleStatus"',
      );
      expect(selectionSql).toContain(
        'THEN \'CANCELED\'::"PublicationOccurrenceStatus" ELSE \'FAILED\'::"PublicationOccurrenceStatus"',
      );
      expect(selectionSql).toContain('po."legacy_broadcast_id" IS NULL');
      expect(selectionSql).toContain(
        'FROM "managed_broadcasts" AS mb WHERE mb."publication_occurrence_id" = po."id"',
      );
      expect(selectionSql).toContain(
        'FROM "managed_broadcast_deliveries" AS d WHERE d."publication_occurrence_id" = po."id"',
      );
      expect(selectionSql).toContain('LIMIT ? FOR UPDATE OF po SKIP LOCKED');
      expect(selectionSql).toContain(
        'UPDATE "publication_occurrences" AS po SET "status" = candidate."next_status"',
      );
      expect(selectionSql).not.toContain('\'SCHEDULED\'::"PublicationOccurrenceStatus"');
      expect(warn).toHaveBeenCalledWith(
        {
          recovered: 2,
          canceled: 1,
          failed: 1,
          cutoff: new Date(now.getTime() - 5 * 60_000).toISOString(),
        },
        'Reconciled publication occurrences without execution envelopes',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips orphan reconciliation for an invalid batch limit', async () => {
    const { service, prisma } = createService();

    await (service as any).reconcileOrphanedPublicationOccurrences(0);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('accelerates recurrence materialization when the current horizon has no future occurrence', async () => {
    const now = new Date('2026-07-10T09:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const scheduledRefreshAt = new Date(now.getTime() + 6 * 60 * 60_000);
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const { service } = createService({
        publicationSchedule: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'schedule-1',
              publicationId: 'publication-1',
              revision: 3,
              nextMaterializeAt: scheduledRefreshAt,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['10:00'],
                startsAt: '2026-07-01T09:00:00.000Z',
                endsAt: null,
                maxOccurrences: null,
                replaceConflicts: false,
              },
              occurrences: [],
            },
          ]),
          updateMany,
        },
        publicationOccurrence: {
          count: jest.fn().mockResolvedValue(0),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      });

      await (service as any).reconcileActiveRecurrenceSchedules(200);

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'schedule-1',
          revision: 3,
          status: PublicationScheduleStatus.ACTIVE,
          nextMaterializeAt: scheduledRefreshAt,
          publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
        },
        data: { nextMaterializeAt: now },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns occupied calendar slots only for the selected publication targets', async () => {
    const scheduledAt = new Date('2026-07-12T09:00:00.000Z');
    const occurrenceFindMany = jest.fn().mockResolvedValue([
      {
        scheduledAt,
        publication: {
          targets: [
            { entityType: ChatEntityType.CHAT, targetChatId: 'chat-1' },
            { entityType: ChatEntityType.CHANNEL, targetChatId: 'channel-1' },
          ],
        },
      },
    ]);
    const { service, prisma } = createService({
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            entityType: ChatEntityType.CHAT,
            targetChatId: 'chat-1',
            scheduledAt,
            broadcast: { publicationOccurrence: null },
          },
        ]),
      },
      publicationOccurrence: {
        findMany: occurrenceFindMany,
      },
    });
    jest.spyOn(service as any, 'resolveAudienceTargets').mockResolvedValue([
      {
        chatId: 'chat-1',
        entityType: 'chat',
        title: 'Чат',
        avatarUrl: null,
        link: null,
      },
      {
        chatId: 'channel-1',
        entityType: 'channel',
        title: 'Канал',
        avatarUrl: null,
        link: null,
      },
    ]);

    const result = await service.getCalendarAvailability({ userId: 'user-1' } as never, {
      audience: {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: [
          { chatId: 'chat-1', entityType: 'chat' },
          { chatId: 'channel-1', entityType: 'channel' },
        ],
      },
      from: '2026-07-11T00:00:00.000Z',
      to: '2026-07-31T23:59:59.999Z',
    });

    expect(result).toEqual({
      from: '2026-07-11T00:00:00.000Z',
      to: '2026-07-31T23:59:59.999Z',
      slots: [{ scheduledAt: scheduledAt.toISOString(), targetCount: 2 }],
    });
    expect(prisma.managedBroadcastCalendarReservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduledAt: { gte: expect.any(Date), lte: expect.any(Date) },
          broadcast: {
            is: expect.objectContaining({ dispatchProfile: PublicationDispatchProfile.PUBLIK_V1 }),
          },
        }),
      }),
    );
    expect(occurrenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          publication: {
            is: expect.objectContaining({ dispatchProfile: PublicationDispatchProfile.PUBLIK_V1 }),
          },
        }),
      }),
    );
  });

  it('ignores retired Major reservations and occurrences in availability and scheduling conflicts', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const legacyReservation = {
      broadcastId: 'major-broadcast',
      entityType: ChatEntityType.CHAT,
      targetChatId: 'chat-1',
      scheduledAt: slot,
      broadcast: { publicationOccurrence: { publicationId: 'major-publication' } },
    };
    const legacyOccurrence = {
      id: 'major-occurrence',
      publicationId: 'major-publication',
      scheduleId: 'major-schedule',
      scheduleRevision: 1,
      scheduledAt: slot,
      schedule: { revision: 1 },
      publication: {
        actorUserId: 'other-admin',
        targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      },
    };
    const occurrenceFindMany = jest.fn(async ({ where }) =>
      where.publication?.is?.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? []
        : [legacyOccurrence],
    );
    const { service, prisma } = createService({
      managedBroadcastCalendarReservation: {
        findMany: jest.fn(async ({ where }) =>
          where.broadcast?.is?.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
            ? []
            : [legacyReservation],
        ),
      },
      publicationOccurrence: {
        findMany: occurrenceFindMany,
      },
    });
    const targets = [{ chatId: 'chat-1', entityType: 'chat' }];

    await expect(
      service.getCalendarAvailability({ userId: 'user-1' } as never, {
        audience: { selection: 'SELECTED', mode: 'SNAPSHOT', targets },
        from: '2026-07-11T00:00:00.000Z',
        to: '2026-07-31T23:59:59.999Z',
      }),
    ).resolves.toMatchObject({ slots: [] });
    await expect(
      (service as any).assertCalendarAvailability(
        targets,
        [slot],
        { mode: 'once', timezone: 'UTC', at: slot.toISOString(), replaceConflicts: false },
        'user-1',
      ),
    ).resolves.toBeUndefined();
    const tx = { ...prisma, $executeRaw: jest.fn().mockResolvedValue(1) };
    await expect(
      (service as any).reservePublicationCalendar(
        tx,
        targets,
        [slot],
        { mode: 'once', timezone: 'UTC', at: slot.toISOString(), replaceConflicts: false },
        'new-publication',
        'user-1',
      ),
    ).resolves.toBeUndefined();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.managedBroadcastCalendarReservation.findMany).toHaveBeenCalledTimes(3);
    expect(occurrenceFindMany).toHaveBeenCalledTimes(3);
  });

  it('anchors recurrence and accepts exact-minute local times', () => {
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');

    expect(
      (service as any).normalizeSchedule(
        {
          mode: 'recurrence',
          timezone: 'Europe/Moscow',
          frequency: 'daily',
          interval: 1,
          weekdays: [],
          times: ['12:30'],
          startsAt: null,
          endsAt: null,
          maxOccurrences: null,
          replaceConflicts: false,
        },
        now,
      ),
    ).toEqual(
      expect.objectContaining({
        startsAt: now.toISOString(),
        times: ['12:30'],
      }),
    );

    expect(
      (service as any).normalizeSchedule(
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-10T12:15:00.000+03:00',
          replaceConflicts: false,
        },
        now,
      ),
    ).toEqual(expect.objectContaining({ at: '2026-07-10T12:15:00.000+03:00' }));
  });

  it('returns a bad request for an unknown IANA timezone', () => {
    const { service } = createService();
    const normalize = () =>
      (service as any).normalizeSchedule(
        {
          mode: 'once',
          timezone: 'Mars/Olympus',
          at: '2026-07-10T12:30:00.000+03:00',
          replaceConflicts: false,
        },
        new Date('2026-07-10T09:00:00.000Z'),
      );

    expect(normalize).toThrow(BadRequestException);
    try {
      normalize();
    } catch (error: unknown) {
      expect((error as BadRequestException).getStatus()).toBe(400);
    }
  });

  it('rejects once and slot timestamps with non-zero seconds', () => {
    const { service } = createService();

    expect(() =>
      (service as any).normalizeSchedule(
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-10T12:30:01.000+03:00',
          replaceConflicts: false,
        },
        new Date('2026-07-10T09:00:00.000Z'),
      ),
    ).toThrow('без секунд');
  });

  it('rejects a bounded recurrence with no possible future occurrence', () => {
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');
    const schedule = {
      mode: 'recurrence',
      timezone: 'UTC',
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      times: ['12:00'],
      startsAt: now.toISOString(),
      endsAt: '2026-07-10T10:00:00.000Z',
      maxOccurrences: null,
      replaceConflicts: false,
    } as const;

    expect(() => (service as any).assertPublishableSchedule(schedule, [], now)).toThrow(
      BadRequestException,
    );
    try {
      (service as any).assertPublishableSchedule(schedule, [], now);
    } catch (error: unknown) {
      expect((error as BadRequestException).getResponse()).toEqual({
        code: 'PUBLICATION_SCHEDULE_EMPTY',
        message: 'Расписание не содержит ни одного будущего запуска.',
      });
    }
  });

  it('schedules far-future recurrence materialization when its first slot enters the horizon', () => {
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');
    const firstSlot = new Date('2026-09-10T10:00:00.000Z');
    const schedule = {
      mode: 'recurrence',
      timezone: 'UTC',
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      times: ['10:00'],
      startsAt: '2026-09-10T09:00:00.000Z',
      endsAt: null,
      maxOccurrences: null,
      replaceConflicts: false,
    } as const;

    expect(
      (service as any).resolveInitialRecurrenceMaterializeAt(schedule, [], false, now),
    ).toEqual(new Date(firstSlot.getTime() - 14 * 24 * 60 * 60_000));
  });

  it('finishes content preparation before opening a create transaction', async () => {
    const tx = {
      publication: {
        create: jest.fn().mockResolvedValue({ id: 'publication-create' }),
        update: jest.fn().mockResolvedValue({}),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const { service, contentService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: transaction,
    });
    const preparationStarted = createDeferred<void>();
    const preparation = createDeferred<PreparedPublicationContentRevision>();
    const prepareSpy = jest
      .spyOn(contentService, 'prepareContentRevision')
      .mockImplementation(() => {
        preparationStarted.resolve(undefined);
        return preparation.promise;
      });
    jest
      .spyOn(contentService, 'persistPreparedContentRevision')
      .mockResolvedValue({ id: 'content-create' } as never);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-create' } as never);

    const createPromise = service.create(
      { userId: 'user-1', username: null, displayName: null },
      {
        requestId: 'create_prepare_001',
        title: 'Черновик',
        content: { text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'chat-1', entityType: 'chat' }],
        },
        schedule: null,
        intent: 'draft',
      },
    );

    await preparationStarted.promise;
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.publication.create).not.toHaveBeenCalled();

    preparation.resolve({ text: 'Текст', textFormat: 'plain', buttons: [], assets: [] });
    await expect(createPromise).resolves.toEqual({ id: 'publication-create' });
    expect(tx.publication.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
        }),
      }),
    );
    expect(prepareSpy.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0],
    );
  });

  it('enqueues the Publisher wakeup only after the create transaction commits', async () => {
    const tx = {
      publication: {
        create: jest.fn().mockResolvedValue({ id: 'publication-committed' }),
        update: jest.fn().mockResolvedValue({}),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const { service, contentService, publisherPublicationWakeupQueue } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: transaction,
    });
    jest
      .spyOn(contentService, 'persistPreparedContentRevision')
      .mockResolvedValue({ id: 'content-committed' } as never);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-committed' } as never);
    await expect(
      service.create(
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'create_committed_001',
          title: 'Черновик',
          content: { text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          schedule: null,
          intent: 'draft',
        },
      ),
    ).resolves.toEqual({ id: 'publication-committed' });

    expect(tx.publicationMutationRecord.create).toHaveBeenCalledTimes(1);
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(
      publisherPublicationWakeupQueue.enqueueAfterCommittedMutation.mock.invocationCallOrder[0]!,
    );
    expect(publisherPublicationWakeupQueue.enqueueAfterCommittedMutation).toHaveBeenCalledWith({
      publicationId: 'publication-committed',
      mutationRequestId: 'create_committed_001',
      reason: 'create',
    });
  });

  it('re-ensures the same Publisher wakeup on an idempotent create replay', async () => {
    const request = {
      requestId: 'create_replay_001',
      title: 'Черновик',
      content: { text: 'Текст', textFormat: 'plain' as const, buttons: [], media: [] },
      audience: {
        selection: 'SELECTED' as const,
        mode: 'SNAPSHOT' as const,
        targets: [{ chatId: 'chat-1', entityType: 'chat' as const }],
      },
      schedule: null,
      intent: 'draft' as const,
    };
    const { service, publisherPublicationWakeupQueue } = createService({
      publicationMutationRecord: {
        findUnique: jest.fn().mockImplementation(async (query) => ({
          publicationId: 'publication-replayed',
          requestHash: (service as any).hashMutationRequest(request),
          query,
        })),
      },
    });
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-replayed' } as never);

    await service.create({ userId: 'user-1', username: null, displayName: null }, request);

    expect(publisherPublicationWakeupQueue.enqueueAfterCommittedMutation).toHaveBeenCalledWith({
      publicationId: 'publication-replayed',
      mutationRequestId: 'create_replay_001',
      reason: 'create',
    });
  });

  it('persists all 300 accepted explicit schedule slots as publication occurrences', async () => {
    const now = new Date('2026-08-28T14:30:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const occurrenceCreateMany = jest.fn().mockResolvedValue({
        count: MAX_PUBLICATION_EXPLICIT_SLOTS,
      });
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publication: {
          create: jest.fn().mockResolvedValue({ id: 'publication-300-slots' }),
          update: jest.fn().mockResolvedValue({}),
        },
        publicationSchedule: {
          create: jest.fn().mockResolvedValue({ id: 'schedule-300-slots', revision: 1 }),
        },
        publicationOccurrence: {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: occurrenceCreateMany,
        },
        managedBroadcastCalendarReservation: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
      };
      const { service, contentService } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publicationOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest
        .spyOn(contentService, 'persistPreparedContentRevision')
        .mockResolvedValue({ id: 'content-300-slots' } as never);
      jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-300-slots' } as never);
      const slots = Array.from({ length: MAX_PUBLICATION_EXPLICIT_SLOTS }, (_, index) =>
        new Date(now.getTime() + (index + 1) * 30 * 60_000).toISOString(),
      );

      await service.create(
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'create_300_slots_001',
          title: 'Расписание на 300 отправок',
          content: { text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          schedule: {
            mode: 'slots',
            timezone: 'Europe/Moscow',
            slots,
            replaceConflicts: false,
          },
          intent: 'publish',
        },
      );

      expect(occurrenceCreateMany).toHaveBeenCalledTimes(1);
      const [createManyInput] = occurrenceCreateMany.mock.calls[0] as unknown as [
        { data: Array<{ scheduledAt: Date }> },
      ];
      const persistedSlots = createManyInput.data;
      expect(persistedSlots).toHaveLength(MAX_PUBLICATION_EXPLICIT_SLOTS);
      expect(
        new Set(persistedSlots.map((row: { scheduledAt: Date }) => row.scheduledAt.getTime())).size,
      ).toBe(MAX_PUBLICATION_EXPLICIT_SLOTS);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a new publication root when the publisher bot is not configured', async () => {
    const { service, contentService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    (service as any).publisherRouting.requireNewRoute.mockImplementation(() => {
      throw new ConflictException({ code: 'PUBLISHER_SETUP_REQUIRED' });
    });
    const prepare = jest.spyOn(contentService, 'prepareContentRevision');

    await expect(
      service.create(
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'create_missing_publisher_001',
          title: 'Черновик',
          content: { text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          schedule: null,
          intent: 'draft',
        },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'PUBLISHER_SETUP_REQUIRED',
      },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('finishes content preparation before the update transaction takes the calendar lock', async () => {
    const tx = createPublicationUpdateTransaction();
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const { service, contentService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-prepare-update',
          actorUserId: 'user-1',
          version: 2,
          lifecycle: PublicationLifecycle.DRAFT,
          title: 'Черновик',
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          canonicalContentRevisionId: 'content-old',
          canonicalContentRevision: { id: 'content-old' },
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
          schedule: null,
        }),
      },
      $transaction: transaction,
    });
    const preparationStarted = createDeferred<void>();
    const preparation = createDeferred<PreparedPublicationContentRevision>();
    const prepareSpy = jest
      .spyOn(contentService, 'prepareContentRevision')
      .mockImplementation(() => {
        preparationStarted.resolve(undefined);
        return preparation.promise;
      });
    jest
      .spyOn(contentService, 'persistPreparedContentRevision')
      .mockResolvedValue({ id: 'content-new' } as never);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-prepare-update' } as never);

    const updatePromise = service.update(
      'publication-prepare-update',
      { userId: 'user-1', username: null, displayName: null },
      {
        requestId: 'update_prepare_001',
        expectedRevision: 2,
        content: { text: 'Новый текст', textFormat: 'plain', buttons: [], media: [] },
        intent: 'draft',
      },
    );

    await preparationStarted.promise;
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();

    preparation.resolve({ text: 'Новый текст', textFormat: 'plain', buttons: [], assets: [] });
    await expect(updatePromise).resolves.toEqual({ id: 'publication-prepare-update' });
    expect(prepareSpy.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0],
    );
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0],
    );
  });

  it('rejects activation of a migrated legacy draft before creating dispatch work', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T09:00:00.000Z'));
    try {
      const transaction = jest.fn();
      const { contentService, publisherRouting, service } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'legacy-draft',
            actorUserId: 'user-1',
            version: 3,
            lifecycle: PublicationLifecycle.DRAFT,
            title: 'Старый черновик',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-legacy-draft',
            canonicalContentRevision: { id: 'content-legacy-draft' },
            dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
            requiredBotId: null,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: {
              id: 'legacy-draft-schedule',
              revision: 2,
              status: PublicationScheduleStatus.DRAFT,
              rule: {
                mode: 'once',
                timezone: 'Europe/Moscow',
                at: '2026-08-27T12:00:00.000+03:00',
                replaceConflicts: false,
              },
            },
          }),
        },
        $transaction: transaction,
      });
      const prepareContent = jest.spyOn(contentService, 'prepareContentRevision');

      await expect(
        service.update(
          'legacy-draft',
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: 'legacy-draft-activate-001',
            expectedRevision: 3,
            schedule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: '2026-08-27T12:00:00.000+03:00',
              replaceConflicts: false,
            },
            intent: 'publish',
          },
        ),
      ).rejects.toMatchObject({
        response: { code: LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE },
      });

      expect(publisherRouting.assertTargetsReady).not.toHaveBeenCalled();
      expect(prepareContent).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects rescheduling and editing a migrated legacy publication before persistence', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T09:00:00.000Z'));
    try {
      const transaction = jest.fn();
      const { contentService, publisherRouting, service } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'legacy-scheduled',
            actorUserId: 'user-1',
            version: 5,
            lifecycle: PublicationLifecycle.ACTIVE,
            title: 'Старый план',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-legacy-scheduled',
            canonicalContentRevision: { id: 'content-legacy-scheduled' },
            dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
            requiredBotId: null,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: {
              id: 'legacy-active-schedule',
              revision: 4,
              status: PublicationScheduleStatus.ACTIVE,
              rule: {
                mode: 'once',
                timezone: 'Europe/Moscow',
                at: '2026-08-27T12:00:00.000+03:00',
                replaceConflicts: false,
              },
            },
          }),
        },
        $transaction: transaction,
      });
      const prepareContent = jest.spyOn(contentService, 'prepareContentRevision');

      await expect(
        service.update(
          'legacy-scheduled',
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: 'legacy-reschedule-edit-001',
            expectedRevision: 5,
            title: 'Новый план',
            content: { text: 'Новый текст', textFormat: 'plain', buttons: [], media: [] },
            schedule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: '2026-08-28T12:00:00.000+03:00',
              replaceConflicts: false,
            },
            intent: 'publish',
          },
        ),
      ).rejects.toMatchObject({
        response: { code: LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE },
      });

      expect(publisherRouting.assertTargetsReady).not.toHaveBeenCalled();
      expect(prepareContent).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a content-only edit of materialized legacy work without mutating its intent', async () => {
    const transaction = jest.fn();
    const { contentService, service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'legacy-materialized',
          actorUserId: 'user-1',
          version: 6,
          lifecycle: PublicationLifecycle.ACTIVE,
          title: 'Старый план',
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          canonicalContentRevisionId: 'content-legacy-materialized',
          canonicalContentRevision: { id: 'content-legacy-materialized' },
          dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
          requiredBotId: null,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
          schedule: {
            id: 'legacy-materialized-schedule',
            revision: 4,
            status: PublicationScheduleStatus.ACTIVE,
            rule: { mode: 'now', timezone: 'Europe/Moscow' },
          },
        }),
      },
      $transaction: transaction,
    });
    const prepareContent = jest.spyOn(contentService, 'prepareContentRevision');

    await expect(
      service.update(
        'legacy-materialized',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'legacy-content-edit-001',
          expectedRevision: 6,
          content: { text: 'Подмененный текст', textFormat: 'plain', buttons: [], media: [] },
          schedule: { mode: 'now', timezone: 'Europe/Moscow' },
          intent: 'publish',
        },
      ),
    ).rejects.toMatchObject({
      response: { code: LEGACY_PUBLICATION_EXECUTION_IMMUTABLE_CODE },
    });

    expect(prepareContent).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('updates an already materialized NOW occurrence without rebuilding its schedule', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:05.000Z'));
    try {
      const tx = createPublicationUpdateTransaction();
      const { service, contentService } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-now',
            actorUserId: 'user-1',
            version: 3,
            lifecycle: PublicationLifecycle.ACTIVE,
            title: 'Старый заголовок',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-old',
            canonicalContentRevision: { id: 'content-old' },
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: 'publisher-bot',
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: {
              id: 'schedule-now',
              revision: 4,
              status: PublicationScheduleStatus.ACTIVE,
              rule: { mode: 'now', timezone: 'Europe/Moscow' },
            },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest
        .spyOn(contentService, 'persistPreparedContentRevision')
        .mockResolvedValue({ id: 'content-new' } as never);
      jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-now' } as never);

      await service.update(
        'publication-now',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-now-001',
          expectedRevision: 3,
          title: 'Новый заголовок',
          content: {
            text: 'Новый текст',
            textFormat: 'plain',
            buttons: [],
            media: [],
          },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          schedule: { mode: 'now', timezone: 'Europe/Moscow' },
          intent: 'publish',
        },
      );

      expect(tx.publicationTarget.deleteMany).not.toHaveBeenCalled();
      expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
      expect(tx.publicationSchedule.create).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.findMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
        where: {
          publicationId: 'publication-now',
          scheduleId: 'schedule-now',
          scheduleRevision: 4,
          status: PublicationOccurrenceStatus.SCHEDULED,
        },
        data: { contentRevisionId: 'content-new' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    { lifecycle: PublicationLifecycle.ACTIVE, edit: 'title' },
    { lifecycle: PublicationLifecycle.ACTIVE, edit: 'content' },
    { lifecycle: PublicationLifecycle.ERROR, edit: 'content' },
    { lifecycle: PublicationLifecycle.ERROR, edit: 'title' },
  ] as const)(
    'rebuilds an errored Publisher recurrence on explicit publish and equal schedule save ($lifecycle, $edit)',
    async ({ lifecycle, edit }) => {
      const now = new Date('2026-07-10T09:00:00.000Z');
      jest.useFakeTimers().setSystemTime(now);
      try {
        const { service, tx, publication, publisherRouting, contentService } =
          createPublicationScheduleRepairFixture();
        publication.lifecycle = lifecycle;

        await service.update(
          publication.id,
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: `repair-${lifecycle}-${edit}`,
            expectedRevision: publication.version,
            ...(edit === 'title'
              ? { title: 'Updated title' }
              : { content: { text: 'Updated text', textFormat: 'plain', buttons: [], media: [] } }),
            schedule: { ...publication.schedule.rule },
            intent: 'publish',
          },
        );

        expect(publisherRouting.assertTargetsReady).toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ chatId: 'chat-1' })]),
          'publisher-bot',
        );
        expect(tx.publication.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ lifecycle, version: publication.version }),
            data: expect.objectContaining({ lifecycle: PublicationLifecycle.ACTIVE }),
          }),
        );
        expect(tx.publicationSchedule.update).toHaveBeenCalledWith({
          where: { publicationId: publication.id },
          data: expect.objectContaining({
            revision: 5,
            status: PublicationScheduleStatus.ACTIVE,
            lastError: null,
            lastMaterializedAt: now,
            nextMaterializeAt: expect.any(Date),
          }),
          select: { id: true },
        });
        const created = tx.publicationOccurrence.createMany.mock.calls[0]?.[0].data as {
          publicationId: string;
          scheduleId: string;
          scheduleRevision: number;
          scheduledAt: Date;
          contentRevisionId: string;
        }[];
        expect(created.length).toBeGreaterThan(0);
        expect(created[0]?.scheduledAt).toEqual(new Date('2026-07-10T15:00:00.000Z'));
        for (const occurrence of created) {
          expect(occurrence).toMatchObject({
            publicationId: publication.id,
            scheduleId: publication.schedule.id,
            scheduleRevision: 5,
            contentRevisionId: edit === 'content' ? 'content-new' : 'content-old',
          });
          expect(occurrence.scheduledAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
        }
        expect(tx.publicationOccurrence.findMany).toHaveBeenCalledWith({
          where: {
            publicationId: publication.id,
            OR: [
              { status: PublicationOccurrenceStatus.SCHEDULED },
              { status: PublicationOccurrenceStatus.IN_PROGRESS, scheduledAt: { gte: now } },
            ],
            deliveries: {
              none: {
                OR: expect.arrayContaining([
                  { attemptCount: { gt: 0 } },
                  { lockedAt: { not: null } },
                  {
                    status: {
                      in: expect.arrayContaining([
                        ManagedBroadcastDeliveryStatus.SENDING,
                        ManagedBroadcastDeliveryStatus.SENT,
                        ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                      ]),
                    },
                  },
                ]),
              },
            },
          },
          select: { id: true },
        });
        expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
          where: {
            id: { in: ['occurrence-stale'] },
            deliveries: { none: expect.any(Object) },
          },
          data: { status: PublicationOccurrenceStatus.CANCELED },
        });
        expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
        expect(contentService.persistPreparedContentRevision).toHaveBeenCalledTimes(
          edit === 'content' ? 1 : 0,
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([PublicationLifecycle.ACTIVE, PublicationLifecycle.ERROR])(
    'keeps an errored schedule stopped on an equal-rule PATCH without publish intent (%s)',
    async (lifecycle) => {
      const { service, tx, publication, contentService } = createPublicationScheduleRepairFixture();
      publication.lifecycle = lifecycle;

      await service.update(
        publication.id,
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: `preserve-omitted-intent-${lifecycle}`,
          expectedRevision: publication.version,
          title: 'Updated title',
          content: { text: 'Updated text', textFormat: 'plain', buttons: [], media: [] },
          schedule: { ...publication.schedule.rule },
        },
      );

      expect(tx.publication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lifecycle: PublicationLifecycle.ERROR,
            title: 'Updated title',
          }),
        }),
      );
      expect(contentService.persistPreparedContentRevision).toHaveBeenCalledTimes(1);
      expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.findMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
        where: {
          publicationId: publication.id,
          scheduleId: publication.schedule.id,
          scheduleRevision: publication.schedule.revision,
          status: PublicationOccurrenceStatus.SCHEDULED,
        },
        data: { contentRevisionId: 'content-new' },
      });
    },
  );

  it.each([
    { lifecycle: PublicationLifecycle.ACTIVE, edit: 'title', intent: undefined },
    { lifecycle: PublicationLifecycle.ACTIVE, edit: 'content', intent: 'publish' },
    { lifecycle: PublicationLifecycle.ERROR, edit: 'content', intent: undefined },
    { lifecycle: PublicationLifecycle.ERROR, edit: 'title', intent: 'publish' },
  ] as const)(
    'preserves an errored recurrence on a $lifecycle $edit edit without a schedule command',
    async ({ lifecycle, edit, intent }) => {
      const { service, tx, publication, contentService } = createPublicationScheduleRepairFixture();
      publication.lifecycle = lifecycle;
      publication.schedule.rule.maxOccurrences = 3;

      await service.update(
        publication.id,
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: `preserve-error-${lifecycle}-${edit}`,
          expectedRevision: publication.version,
          ...(edit === 'title'
            ? { title: 'Updated title' }
            : { content: { text: 'Updated text', textFormat: 'plain', buttons: [], media: [] } }),
          ...(intent ? { intent } : {}),
        },
      );

      expect(tx.publication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lifecycle: PublicationLifecycle.ERROR }),
        }),
      );
      expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.findMany).not.toHaveBeenCalled();
      expect(contentService.persistPreparedContentRevision).toHaveBeenCalledTimes(
        edit === 'content' ? 1 : 0,
      );
    },
  );

  it.each(['title', 'content'] as const)(
    'keeps an ambiguous NOW publication stopped on an equivalent schedule %s edit',
    async (edit) => {
      const { service, tx, publication } = createPublicationScheduleRepairFixture();
      publication.lifecycle = PublicationLifecycle.ERROR;
      publication.schedule.rule.mode = 'now';

      await service.update(
        publication.id,
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: `preserve-ambiguous-now-${edit}`,
          expectedRevision: publication.version,
          ...(edit === 'title'
            ? { title: 'Updated title' }
            : { content: { text: 'Updated text', textFormat: 'plain', buttons: [], media: [] } }),
          schedule: { mode: 'now', timezone: 'Europe/Moscow' },
          intent: 'publish',
        },
      );

      expect(tx.publication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lifecycle: PublicationLifecycle.ERROR }),
        }),
      );
      expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.findMany).not.toHaveBeenCalled();
      if (edit === 'content') {
        expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              publicationOccurrence: {
                is: {
                  publicationId: publication.id,
                  scheduleId: publication.schedule.id,
                  scheduleRevision: publication.schedule.revision,
                  status: PublicationOccurrenceStatus.SCHEDULED,
                },
              },
              status: ManagedBroadcastDeliveryStatus.PENDING,
            }),
          }),
        );
      } else {
        expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      scenario: 'DRAFT Publisher without an intent command',
      lifecycle: PublicationLifecycle.DRAFT,
      status: PublicationScheduleStatus.DRAFT,
      profile: PublicationDispatchProfile.PUBLIK_V1,
    },
    {
      scenario: 'healthy ACTIVE Publisher',
      lifecycle: PublicationLifecycle.ACTIVE,
      status: PublicationScheduleStatus.ACTIVE,
      profile: PublicationDispatchProfile.PUBLIK_V1,
    },
    {
      scenario: 'PAUSED Publisher with an errored schedule',
      lifecycle: PublicationLifecycle.PAUSED,
      status: PublicationScheduleStatus.ERROR,
      profile: PublicationDispatchProfile.PUBLIK_V1,
    },
    {
      scenario: 'retired legacy publication with an errored schedule',
      lifecycle: PublicationLifecycle.ACTIVE,
      status: PublicationScheduleStatus.ERROR,
      profile: PublicationDispatchProfile.LEGACY_ROUTED,
    },
  ])(
    'preserves the schedule on a title-only $scenario edit',
    async ({ lifecycle, status, profile }) => {
      const { service, tx, publication, publisherRouting } =
        createPublicationScheduleRepairFixture();
      publication.lifecycle = lifecycle;
      publication.dispatchProfile = profile;
      publication.schedule.status = status;

      await service.update(
        publication.id,
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'preserve-schedule-title',
          expectedRevision: publication.version,
          title: 'Title',
        },
      );

      expect(tx.publication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lifecycle }) }),
      );
      expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.findMany).not.toHaveBeenCalled();
      if (
        profile === PublicationDispatchProfile.LEGACY_ROUTED ||
        lifecycle === PublicationLifecycle.DRAFT
      ) {
        expect(publisherRouting.assertTargetsReady).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['past end date', 'bounded recurrence'] as const)(
    'rejects unsafe same-rule recurrence recovery before persistence (%s)',
    async (reason) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
      try {
        const { service, tx, publication, transaction, contentService } =
          createPublicationScheduleRepairFixture();
        publication.lifecycle = PublicationLifecycle.ERROR;
        if (reason === 'past end date') {
          publication.schedule.rule.endsAt = '2026-07-09T21:00:00.000Z';
        } else {
          publication.schedule.rule.maxOccurrences = 3;
        }
        const prepare = jest.spyOn(contentService, 'prepareContentRevision');

        const update = service.update(
          publication.id,
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: 'repair-exhausted-recurrence',
            expectedRevision: publication.version,
            content: { text: 'Updated text', textFormat: 'plain', buttons: [], media: [] },
            schedule: { ...publication.schedule.rule },
            intent: 'publish',
          },
        );
        if (reason === 'past end date') {
          await expect(update).rejects.toMatchObject({
            response: { code: 'PUBLICATION_SCHEDULE_EMPTY' },
          });
        } else {
          await expect(update).rejects.toThrow(
            'Для перезапуска серии с лимитом задайте новое расписание.',
          );
        }

        expect(prepare).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
        expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
        expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(['audience', 'schedule'] as const)(
    'preserves an explicitly changed %s rebuild for a bounded errored recurrence',
    async (change) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
      try {
        const { service, tx, publication } = createPublicationScheduleRepairFixture();
        publication.schedule.rule.maxOccurrences = 3;

        await service.update(
          publication.id,
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: `repair-changed-${change}`,
            expectedRevision: publication.version,
            schedule: {
              ...publication.schedule.rule,
              ...(change === 'schedule' ? { times: ['19:00'] } : {}),
            },
            ...(change === 'audience'
              ? {
                  audience: {
                    selection: 'SELECTED',
                    mode: 'SNAPSHOT',
                    targets: [{ chatId: 'channel-1', entityType: 'channel' }],
                  },
                }
              : {}),
            intent: 'publish',
          },
        );

        expect(tx.publicationSchedule.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              revision: 5,
              status: PublicationScheduleStatus.ACTIVE,
            }),
          }),
        );
        expect(tx.publicationOccurrence.createMany.mock.calls[0]?.[0].data).toHaveLength(3);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(['stale request', 'concurrent mutation'] as const)(
    'does not reactivate an errored schedule on a revision conflict (%s)',
    async (scenario) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
      try {
        const { service, tx, publication, transaction } = createPublicationScheduleRepairFixture();
        publication.lifecycle = PublicationLifecycle.ERROR;
        tx.publication.updateMany.mockResolvedValue({ count: 0 });

        await expect(
          service.update(
            publication.id,
            { userId: 'user-1', username: null, displayName: null },
            {
              requestId: 'repair-revision-conflict',
              expectedRevision: publication.version - (scenario === 'stale request' ? 1 : 0),
              title: 'Title',
              schedule: { ...publication.schedule.rule },
              intent: 'publish',
            },
          ),
        ).rejects.toMatchObject({ response: { code: 'PUBLICATION_REVISION_CONFLICT' } });

        expect(transaction).toHaveBeenCalledTimes(scenario === 'stale request' ? 0 : 1);
        expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
        expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
        expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
        expect(tx.publicationMutationRecord.create).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('rejects an update when a cached target fails live admin verification', async () => {
    const transaction = jest.fn();
    const { service, managedEntitiesService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-revoked',
          actorUserId: 'user-1',
          version: 2,
          lifecycle: PublicationLifecycle.ACTIVE,
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          schedule: null,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
        }),
      },
      $transaction: transaction,
    });
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ForbiddenException('Пользователь не является администратором чата.'),
    );

    await expect(
      service.update(
        'publication-revoked',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-revoked-001',
          expectedRevision: 2,
          title: 'Новый заголовок',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(managedEntitiesService.listChats).toHaveBeenCalledTimes(1);
    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects an audience replacement before canceling work for a revoked persisted target', async () => {
    const tx = createPublicationUpdateTransaction();
    tx.publicationOccurrence.findMany.mockResolvedValue([]);
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const { service, managedEntitiesService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-replace-revoked',
          actorUserId: 'user-1',
          version: 2,
          lifecycle: PublicationLifecycle.DRAFT,
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          canonicalContentRevisionId: 'content-2',
          canonicalContentRevision: { id: 'content-2' },
          schedule: null,
          targets: [{ targetChatId: 'chat-revoked', entityType: ChatEntityType.CHAT, position: 0 }],
        }),
      },
      $transaction: transaction,
    });
    const listChats = jest.fn().mockResolvedValue([
      {
        id: 'chat-revoked',
        entityType: 'chat',
        title: 'Старый чат',
        avatarUrl: null,
        link: null,
      },
    ]);
    const listChannels = jest.fn().mockResolvedValue([
      {
        id: 'channel-1',
        entityType: 'channel',
        title: 'Канал 1',
        avatarUrl: null,
        link: null,
      },
    ]);
    const assertChatAdminAccess = jest
      .fn()
      .mockRejectedValue(new ForbiddenException('Пользователь не является администратором чата.'));
    const assertChannelAdminAccess = jest.fn().mockResolvedValue(undefined);
    managedEntitiesService.listChats.mockImplementation(listChats);
    managedEntitiesService.listChannels.mockImplementation(listChannels);
    managedEntitiesService.assertChatAdminAccess.mockImplementation(assertChatAdminAccess);
    managedEntitiesService.assertChannelAdminAccess.mockImplementation(assertChannelAdminAccess);

    await expect(
      service.update(
        'publication-replace-revoked',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-remove-revoked-001',
          expectedRevision: 2,
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'channel-1', entityType: 'channel' }],
          },
          intent: 'draft',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(listChats).toHaveBeenCalledTimes(1);
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(assertChatAdminAccess).toHaveBeenCalledWith(
      'chat-revoked',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(assertChannelAdminAccess).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.publicationTarget.deleteMany).not.toHaveBeenCalled();
    expect(tx.publicationTarget.createMany).not.toHaveBeenCalled();
  });

  it('allows an imported empty-target draft to select its first audience', async () => {
    const tx = createPublicationUpdateTransaction();
    tx.publicationOccurrence.findMany.mockResolvedValue([]);
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const { service, publisherRouting } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'imported-draft',
          actorUserId: 'user-1',
          version: 1,
          lifecycle: PublicationLifecycle.DRAFT,
          title: '',
          audienceSelection: PublicationAudienceSelection.SELECTED,
          audienceMode: PublicationAudienceMode.SNAPSHOT,
          canonicalContentRevisionId: 'content-1',
          canonicalContentRevision: { id: 'content-1' },
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
          schedule: null,
          targets: [],
        }),
      },
      $transaction: transaction,
    });
    publisherRouting.resolvePersistedTargets.mockRejectedValue(
      new Error('empty imported targets must not be resolved before replacement'),
    );
    publisherRouting.resolveAudienceTargets.mockResolvedValue([
      { chatId: 'chat-1', entityType: 'chat', title: 'Чат 1', avatarUrl: null, link: null },
    ]);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'imported-draft' } as never);

    await expect(
      service.update(
        'imported-draft',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'imported-draft-update-001',
          expectedRevision: 1,
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          intent: 'draft',
        },
      ),
    ).resolves.toEqual({ id: 'imported-draft' });

    expect(publisherRouting.resolvePersistedTargets).not.toHaveBeenCalled();
    expect(publisherRouting.resolveAudienceTargets).toHaveBeenCalledTimes(1);
    expect(tx.publicationTarget.createMany).toHaveBeenCalledWith({
      data: [
        {
          publicationId: 'imported-draft',
          targetChatId: 'chat-1',
          entityType: ChatEntityType.CHAT,
          position: 0,
          canceledAt: null,
        },
      ],
    });
  });

  it('fails closed before content preparation and persistence on a transient live access error', async () => {
    const transaction = jest.fn();
    const { service, contentService, managedEntitiesService, publisherPolicyService } =
      createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: transaction,
      });
    publisherPolicyService.resolvePublicationTargets.mockRejectedValue(
      new ServiceUnavailableException('Не удалось проверить права администратора в MAX.'),
    );
    const prepareContent = jest.spyOn(contentService, 'prepareContentRevision');

    await expect(
      service.create(
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'create-access-transient-001',
          title: 'Черновик',
          content: { text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          schedule: null,
          intent: 'draft',
        },
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(publisherPolicyService.resolvePublicationTargets).toHaveBeenCalledTimes(1);
    expect(managedEntitiesService.assertChatAdminAccess).not.toHaveBeenCalled();
    expect(prepareContent).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('keeps a finite recurrence revision and occurrence count on a semantic no-op edit', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const tx = createPublicationUpdateTransaction();
      const persistedRule = {
        mode: 'recurrence',
        timezone: 'Europe/Moscow',
        frequency: 'weekly',
        interval: 1,
        weekdays: [1, 5],
        times: ['10:00', '18:00'],
        startsAt: '2026-07-10T09:00:00.000Z',
        endsAt: null,
        maxOccurrences: 3,
        replaceConflicts: false,
      };
      const { service, contentService } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-recurrence',
            actorUserId: 'user-1',
            version: 6,
            lifecycle: PublicationLifecycle.ACTIVE,
            title: 'Повтор',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-6',
            canonicalContentRevision: { id: 'content-6' },
            targets: [
              { targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 },
              {
                targetChatId: 'channel-1',
                entityType: ChatEntityType.CHANNEL,
                position: 1,
              },
            ],
            schedule: {
              id: 'schedule-recurrence',
              revision: 7,
              status: PublicationScheduleStatus.ACTIVE,
              rule: persistedRule,
            },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest
        .spyOn(contentService, 'persistPreparedContentRevision')
        .mockResolvedValue({ id: 'content-7' } as never);
      jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-recurrence' } as never);

      await service.update(
        'publication-recurrence',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-recurrence-001',
          expectedRevision: 6,
          title: 'Повтор с новым текстом',
          content: {
            text: 'Обновлённый текст',
            textFormat: 'plain',
            buttons: [],
            media: [],
          },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [
              { chatId: 'channel-1', entityType: 'channel' },
              { chatId: 'chat-1', entityType: 'chat' },
            ],
          },
          schedule: {
            ...persistedRule,
            weekdays: [5, 1],
            times: ['18:00', '10:00'],
            startsAt: '2026-07-10T12:00:00.000+03:00',
          },
          intent: 'publish',
        },
      );

      expect(tx.publicationTarget.deleteMany).not.toHaveBeenCalled();
      expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.findMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
        where: {
          publicationId: 'publication-recurrence',
          scheduleId: 'schedule-recurrence',
          scheduleRevision: 7,
          status: PublicationOccurrenceStatus.SCHEDULED,
        },
        data: { contentRevisionId: 'content-7' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  describe('scheduled update late policy', () => {
    const now = new Date('2026-07-10T09:00:00.000Z');
    const legacyRule: PublicationScheduleInput = {
      mode: 'once',
      timezone: 'UTC',
      at: '2026-07-10T09:30:00.000Z',
      replaceConflicts: false,
    };
    const schedules: PublicationScheduleInput[] = [
      { ...legacyRule, at: '2026-07-10T10:00:00.000Z' },
      {
        mode: 'slots',
        timezone: 'UTC',
        slots: ['2026-07-10T10:00:00.000Z', '2026-07-11T10:00:00.000Z'],
        replaceConflicts: false,
      },
      {
        mode: 'recurrence',
        timezone: 'UTC',
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        times: ['10:00'],
        startsAt: '2026-07-10T09:00:00.000Z',
        endsAt: null,
        maxOccurrences: 2,
        replaceConflicts: false,
      },
    ];

    function fixture(
      previous: PublicationScheduleInput | null,
      scheduleStatus: PublicationScheduleStatus = PublicationScheduleStatus.ACTIVE,
    ) {
      const tx = {
        ...createPublicationUpdateTransaction(),
        managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      };
      tx.publicationOccurrence.findMany.mockResolvedValue([]);
      tx.publicationSchedule.create.mockResolvedValue({ id: 'policy-schedule', revision: 1 });
      tx.publicationSchedule.update.mockResolvedValue({ id: 'policy-schedule' });
      const result = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publicationOccurrence: { findMany: jest.fn().mockResolvedValue([]) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'policy-publication',
            actorUserId: 'user-1',
            version: 2,
            lifecycle:
              previous && scheduleStatus !== PublicationScheduleStatus.DRAFT
                ? PublicationLifecycle.ACTIVE
                : PublicationLifecycle.DRAFT,
            title: 'Scheduled post',
            audienceSelection: PublicationAudienceSelection.SELECTED,
            audienceMode: PublicationAudienceMode.SNAPSHOT,
            canonicalContentRevisionId: 'policy-content',
            canonicalContentRevision: { id: 'policy-content' },
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: 'publisher-bot',
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: previous
              ? {
                  id: 'policy-schedule',
                  revision: 1,
                  status: scheduleStatus,
                  rule: previous,
                }
              : null,
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest.spyOn(result.service, 'get').mockResolvedValue({ id: 'policy-publication' } as never);
      return { ...result, tx };
    }

    beforeEach(() => jest.useFakeTimers().setSystemTime(now));
    afterEach(() => jest.useRealTimers());

    it.each(
      schedules.flatMap((schedule) =>
        [
          { previous: null, source: 'draft activation', status: PublicationScheduleStatus.DRAFT },
          {
            previous: legacyRule,
            source: 'saved draft activation',
            status: PublicationScheduleStatus.DRAFT,
          },
          {
            previous: legacyRule,
            source: 'replacement',
            status: PublicationScheduleStatus.ACTIVE,
          },
        ].map((entry) => ({
          mode: schedule.mode,
          schedule,
          ...entry,
        })),
      ),
    )('defaults $mode $source to a durable 24-hour recovery window', async (entry) => {
      const { service, tx } = fixture(entry.previous, entry.status);
      await service.update(
        'policy-publication',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'schedule-policy-default-001',
          expectedRevision: 2,
          intent: 'publish',
          schedule: entry.schedule,
        },
      );
      const persist = entry.previous
        ? tx.publicationSchedule.update
        : tx.publicationSchedule.create;
      expect(persist).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rule: expect.objectContaining({ latePolicy: DEFAULT_PUBLICATION_LATE_POLICY }),
          }),
        }),
      );
      const [write] = tx.publicationOccurrence.createMany.mock.calls[0] as [
        { data: Array<{ scheduledAt: Date; deliveryDeadlineAt: Date }> },
      ];
      expect(write.data.length).toBeGreaterThan(0);
      for (const occurrence of write.data) {
        expect(occurrence.deliveryDeadlineAt.getTime() - occurrence.scheduledAt.getTime()).toBe(
          24 * 60 * 60_000,
        );
      }
    });

    it.each([
      ['legacy', legacyRule],
      ['modern', { ...legacyRule, latePolicy: DEFAULT_PUBLICATION_LATE_POLICY }],
    ] as const)(
      'preserves the saved %s policy when the unchanged request omits it',
      async (_name, previous) => {
        const { service, tx } = fixture(previous);
        await service.update(
          'policy-publication',
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: 'schedule-policy-preserve-001',
            expectedRevision: 2,
            intent: 'publish',
            title: 'Updated title',
            schedule: legacyRule,
          },
        );
        expect(tx.publicationSchedule.update).not.toHaveBeenCalled();
        expect(tx.publicationSchedule.create).not.toHaveBeenCalled();
        expect(tx.publicationOccurrence.createMany).not.toHaveBeenCalled();
        expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
      },
    );

    it('honors an explicitly supplied policy while activating a draft', async () => {
      const { service, tx } = fixture(null);
      const policy = { mode: 'strict', maxDelayMinutes: 30, catchUp: 'all' } as const;
      await service.update(
        'policy-publication',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'schedule-policy-explicit-001',
          expectedRevision: 2,
          intent: 'publish',
          schedule: { ...legacyRule, latePolicy: policy },
        },
      );
      expect(tx.publicationSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rule: expect.objectContaining({ latePolicy: policy }),
          }),
        }),
      );
      expect(tx.publicationOccurrence.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            scheduledAt: new Date(legacyRule.at),
            deliveryDeadlineAt: new Date('2026-07-10T10:00:00.000Z'),
          }),
        ],
        skipDuplicates: true,
      });
    });

    it.each([
      {
        name: 'strict',
        savedPolicy: { mode: 'strict', maxDelayMinutes: 30, catchUp: 'all' },
        expectedPolicy: { mode: 'strict', maxDelayMinutes: 30, catchUp: 'all' },
      },
      {
        name: 'modern',
        savedPolicy: DEFAULT_PUBLICATION_LATE_POLICY,
        expectedPolicy: DEFAULT_PUBLICATION_LATE_POLICY,
      },
      {
        name: 'legacy default',
        savedPolicy: undefined,
        expectedPolicy: DEFAULT_PUBLICATION_LATE_POLICY,
      },
    ] as const)(
      'applies the saved draft $name policy when its activation request omits it',
      async ({ savedPolicy, expectedPolicy }) => {
        const { service, tx } = fixture(
          { ...legacyRule, ...(savedPolicy ? { latePolicy: savedPolicy } : {}) },
          PublicationScheduleStatus.DRAFT,
        );
        await service.update(
          'policy-publication',
          { userId: 'user-1', username: null, displayName: null },
          {
            requestId: 'schedule-policy-saved-draft-001',
            expectedRevision: 2,
            intent: 'publish',
            schedule: legacyRule,
          },
        );
        expect(tx.publicationSchedule.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: PublicationScheduleStatus.ACTIVE,
              rule: expect.objectContaining({ latePolicy: expectedPolicy }),
            }),
          }),
        );
        expect(tx.publicationOccurrence.createMany).toHaveBeenCalledWith({
          data: [
            expect.objectContaining({
              deliveryDeadlineAt: new Date(
                new Date(legacyRule.at).getTime() + expectedPolicy.maxDelayMinutes * 60_000,
              ),
            }),
          ],
          skipDuplicates: true,
        });
      },
    );
  });

  it('keeps the schedule and execution linkage when an active publication becomes a draft', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const tx = {
        ...createPublicationUpdateTransaction(),
        managedBroadcastCalendarReservation: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        managedBroadcastDelivery: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      tx.publicationOccurrence.findMany.mockResolvedValue([{ id: 'occurrence-future' }]);
      tx.managedBroadcast.findMany.mockResolvedValue([{ id: 'broadcast-future' }]);
      tx.managedBroadcast.updateMany.mockResolvedValue({ count: 1 });
      const deleteBroadcasts = jest.fn();
      Object.assign(tx.managedBroadcast, { deleteMany: deleteBroadcasts });
      const { service } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-active',
            actorUserId: 'user-1',
            version: 4,
            lifecycle: PublicationLifecycle.ACTIVE,
            title: 'Запланированный пост',
            audienceSelection: 'SELECTED',
            audienceMode: 'SNAPSHOT',
            canonicalContentRevisionId: 'content-4',
            canonicalContentRevision: { id: 'content-4' },
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
            schedule: {
              id: 'schedule-active',
              revision: 3,
              status: PublicationScheduleStatus.ACTIVE,
              rule: {
                mode: 'once',
                timezone: 'Europe/Moscow',
                at: '2026-07-12T12:00:00.000+03:00',
                replaceConflicts: false,
              },
            },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-active' } as never);

      await service.update(
        'publication-active',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-draft-001',
          expectedRevision: 4,
          schedule: null,
          intent: 'draft',
        },
      );

      expect(tx.publication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lifecycle: PublicationLifecycle.DRAFT }),
        }),
      );
      expect(tx.publicationSchedule.update).toHaveBeenCalledWith({
        where: { publicationId: 'publication-active' },
        data: {
          revision: { increment: 1 },
          status: PublicationScheduleStatus.DRAFT,
          nextMaterializeAt: null,
          lastError: null,
        },
      });
      expect(tx.publicationSchedule.deleteMany).not.toHaveBeenCalled();
      expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['occurrence-future'] },
          deliveries: {
            none: {
              OR: [
                { attemptCount: { gt: 0 } },
                { lockedAt: { not: null } },
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.SENT,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
              ],
            },
          },
        },
        data: { status: PublicationOccurrenceStatus.CANCELED },
      });
      expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['broadcast-future'] },
          status: {
            in: [
              ManagedBroadcastStatus.ACTIVE,
              ManagedBroadcastStatus.PARTIAL,
              ManagedBroadcastStatus.FAILED,
            ],
          },
          lockedAt: null,
          lockToken: null,
          deliveries: {
            none: {
              OR: [
                { attemptCount: { gt: 0 } },
                { lockedAt: { not: null } },
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.SENT,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
              ],
            },
          },
        },
        data: {
          status: ManagedBroadcastStatus.CANCELED,
          nextSendAt: null,
          lockedAt: null,
          lockToken: null,
        },
      });
      expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
        where: {
          publicationOccurrenceId: { in: ['occurrence-future'] },
          status: {
            in: [
              ManagedBroadcastStatus.ACTIVE,
              ManagedBroadcastStatus.PARTIAL,
              ManagedBroadcastStatus.FAILED,
            ],
          },
        },
        select: { id: true, lockedAt: true, lockToken: true },
      });
      expect(tx.managedBroadcast.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty(
        'publicationOccurrenceId',
      );
      expect(deleteBroadcasts).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a schedule update while a future publication envelope is preclaimed', async () => {
    const tx = createPublicationUpdateTransaction();
    tx.publicationOccurrence.findMany.mockResolvedValue([{ id: 'occurrence-future' }]);
    tx.managedBroadcast.findMany.mockResolvedValue([
      {
        id: 'broadcast-future',
        lockedAt: new Date('2026-07-10T09:00:00.000Z'),
        lockToken: 'update-execution-lease',
      },
    ]);
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-update-lease',
          actorUserId: 'user-1',
          version: 4,
          lifecycle: PublicationLifecycle.ACTIVE,
          title: 'Запланированный пост',
          audienceSelection: 'SELECTED',
          audienceMode: 'SNAPSHOT',
          canonicalContentRevisionId: 'content-4',
          canonicalContentRevision: { id: 'content-4' },
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT, position: 0 }],
          schedule: {
            id: 'schedule-active',
            revision: 3,
            status: PublicationScheduleStatus.ACTIVE,
            rule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: '2026-07-12T12:00:00.000+03:00',
              replaceConflicts: false,
            },
          },
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await expect(
      service.update(
        'publication-update-lease',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'update-lease-001',
          expectedRevision: 4,
          schedule: null,
          intent: 'draft',
        },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Публикация уже начала отправку. Проверьте доставки отдельно.',
      },
    });

    expect(tx.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel'] as const)(
    'rejects %s while a future publication envelope is preclaimed',
    async (action) => {
      const updateBroadcasts = jest.fn();
      const deleteBroadcasts = jest.fn();
      const updateSchedule = jest.fn();
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: jest.fn().mockResolvedValue([]),
        publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        publicationOccurrence: {
          findMany: jest.fn().mockResolvedValue([{ id: 'occurrence-future' }]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        managedBroadcast: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'broadcast-future',
              lockedAt: new Date('2026-07-10T09:00:00.000Z'),
              lockToken: `${action}-execution-lease`,
            },
          ]),
          updateMany: updateBroadcasts,
          deleteMany: deleteBroadcasts,
        },
        publicationSchedule: { updateMany: updateSchedule },
        publicationMutationRecord: { create: jest.fn() },
      };
      const { service } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-action-lease',
            actorUserId: 'user-1',
            version: 3,
            lifecycle: PublicationLifecycle.ACTIVE,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });

      await expect(
        service[action](
          'publication-action-lease',
          { userId: 'user-1', username: null, displayName: null },
          { requestId: `${action}-lease-001`, expectedRevision: 3 },
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
          message: 'Публикация уже начала отправку. Проверьте доставки отдельно.',
        },
      });

      expect(updateBroadcasts).not.toHaveBeenCalled();
      expect(deleteBroadcasts).not.toHaveBeenCalled();
      expect(updateSchedule).not.toHaveBeenCalled();
      expect(tx.publicationMutationRecord.create).not.toHaveBeenCalled();
    },
  );

  it.each(['now', 'once'] as const)(
    'reclaims retired Major slots before creating chat and channel execution envelopes (%s)',
    async (mode) => {
      const managedBroadcastCreate = jest
        .fn()
        .mockResolvedValueOnce({ id: 'broadcast-chat' })
        .mockResolvedValueOnce({ id: 'broadcast-channel' });
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        managedBroadcast: {
          count: jest.fn().mockResolvedValue(0),
          create: managedBroadcastCreate,
          updateMany: jest.fn(),
        },
        managedBroadcastOccurrence: { create: jest.fn().mockResolvedValue({}) },
        managedBroadcastDelivery: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          updateMany: jest.fn(),
        },
        managedBroadcastCalendarReservation: {
          findMany: jest.fn().mockResolvedValue([]),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          deleteMany: jest.fn(),
        },
        publicationOccurrence: {
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const { service } = createService({
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      const occurrence = {
        id: 'occurrence-1',
        publicationId: 'publication-1',
        scheduleId: 'schedule-1',
        contentRevisionId: 'content-1',
        scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
        legacyBroadcastId: null,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: 'publisher-bot',
        dispatchBlockerCode: mode === 'once' ? 'PUBLISHER_EXPLICIT_RETRY' : null,
        dispatchBlockedAt: mode === 'once' ? new Date('2026-07-10T12:00:00Z') : null,
        schedule: { timezone: 'Europe/Moscow' },
        contentRevision: {
          text: 'Проверка',
          textFormat: PublicationContentFormat.PLAIN,
          buttons: [{ text: 'Открыть', url: 'https://max.ru/example', row: 0 }],
        },
        publication: { actorUserId: 'user-1' },
      };

      await (service as any).createOccurrenceExecution(
        occurrence,
        [
          {
            chatId: 'chat-1',
            entityType: 'chat',
            title: 'Чат',
            avatarUrl: null,
            link: null,
          },
          {
            chatId: 'channel-1',
            entityType: 'channel',
            title: 'Канал',
            avatarUrl: null,
            link: null,
          },
        ],
        mode === 'now'
          ? { mode, timezone: 'Europe/Moscow' }
          : {
              mode,
              timezone: 'Europe/Moscow',
              at: occurrence.scheduledAt.toISOString(),
              replaceConflicts: false,
            },
      );

      expect(managedBroadcastCreate).toHaveBeenCalledTimes(2);
      expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            retryAuthorizedAt: occurrence.dispatchBlockedAt,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
          }),
          where: expect.objectContaining({
            retryAuthorizedAt: null,
            dispatchBlockerCode: occurrence.dispatchBlockerCode,
            dispatchBlockedAt: occurrence.dispatchBlockedAt,
          }),
        }),
      );
      expect(managedBroadcastCreate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: ChatEntityType.CHAT,
            publicationOccurrenceId: 'occurrence-1',
            publicationContentRevisionId: 'content-1',
            targetChatIds: ['chat-1'],
          }),
        }),
      );
      expect(managedBroadcastCreate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: ChatEntityType.CHANNEL,
            publicationOccurrenceId: 'occurrence-1',
            targetChatIds: ['channel-1'],
          }),
        }),
      );
      expect(tx.managedBroadcastDelivery.createMany).toHaveBeenCalledTimes(2);
      expect(tx.managedBroadcastDelivery.createMany).toHaveBeenNthCalledWith(1, {
        data: [
          expect.objectContaining({
            broadcastId: 'broadcast-chat',
            targetChatId: 'chat-1',
            publicationOccurrenceId: 'occurrence-1',
          }),
        ],
      });
      expect(tx.managedBroadcastDelivery.createMany).toHaveBeenNthCalledWith(2, {
        data: [
          expect.objectContaining({
            broadcastId: 'broadcast-channel',
            targetChatId: 'channel-1',
            publicationOccurrenceId: 'occurrence-1',
            occurrenceIndex: 1,
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: 'publisher-bot',
            dialogBotId: 'primary-bot',
            publicationPolicyRevision: 1,
          }),
        ],
      });
      expect(tx.managedBroadcastCalendarReservation.deleteMany).toHaveBeenCalledTimes(2);
      for (const [index, entityType, targetChatId] of [
        [0, ChatEntityType.CHAT, 'chat-1'],
        [1, ChatEntityType.CHANNEL, 'channel-1'],
      ] as const) {
        expect(tx.managedBroadcastCalendarReservation.deleteMany).toHaveBeenNthCalledWith(
          index + 1,
          {
            where: {
              entityType,
              targetChatId: { in: [targetChatId] },
              scheduledAt: occurrence.scheduledAt,
              broadcast: { is: { dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED } },
            },
          },
        );
        const releasedAt =
          tx.managedBroadcastCalendarReservation.deleteMany.mock.invocationCallOrder[index];
        expect(releasedAt).toBeGreaterThan(tx.$executeRaw.mock.invocationCallOrder[0]);
        expect(releasedAt).toBeLessThan(
          tx.managedBroadcastCalendarReservation.findMany.mock.invocationCallOrder[index],
        );
        expect(releasedAt).toBeLessThan(
          tx.managedBroadcastCalendarReservation.createMany.mock.invocationCallOrder[index],
        );
      }
      expect(tx.managedBroadcast.updateMany).not.toHaveBeenCalled();
      expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    { claimed: 0, existing: 0, publisherConflict: false },
    { claimed: 1, existing: 1, publisherConflict: false },
    { claimed: 1, existing: 0, publisherConflict: true },
  ])('preserves publication execution fences when reclaiming slots: %j', async (scenario) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publicationOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: scenario.claimed }),
        update: jest.fn().mockResolvedValue({}),
      },
      managedBroadcast: {
        count: jest.fn().mockResolvedValue(scenario.existing),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([{ broadcastId: 'other-admin-publik-broadcast' }]),
        createMany: jest.fn(),
      },
    };
    const { service } = createService({
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    const execute = (service as any).createOccurrenceExecution(
      {
        id: 'occurrence-1',
        scheduleRevision: 1,
        contentRevisionId: 'content-1',
        scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: 'publisher-bot',
        contentRevision: { buttons: [] },
        publication: { actorUserId: 'user-1' },
      },
      [{ chatId: 'chat-1', entityType: 'chat' }],
      {
        mode: 'once',
        timezone: 'UTC',
        at: '2026-07-12T09:00:00.000Z',
        replaceConflicts: false,
      },
    );

    if (scenario.publisherConflict) {
      await expect(execute).rejects.toBeInstanceOf(ConflictException);
      expect(tx.managedBroadcastCalendarReservation.deleteMany).toHaveBeenCalledWith({
        where: {
          entityType: ChatEntityType.CHAT,
          targetChatId: { in: ['chat-1'] },
          scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
          broadcast: { is: { dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED } },
        },
      });
    } else {
      await expect(execute).resolves.toBeUndefined();
      expect(tx.managedBroadcastCalendarReservation.deleteMany).not.toHaveBeenCalled();
      expect(tx.managedBroadcastCalendarReservation.findMany).not.toHaveBeenCalled();
    }
    expect(tx.managedBroadcast.create).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastCalendarReservation.createMany).not.toHaveBeenCalled();
  });

  it('keeps an unready Publik occurrence scheduled with a bounded blocker', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = jest.fn();
    const occurrence = {
      id: 'occurrence-blocked',
      publicationId: 'publication-blocked',
      scheduleId: 'schedule-blocked',
      scheduleRevision: 1,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      schedule: {
        id: 'schedule-blocked',
        mode: PublicationScheduleMode.NOW,
        revision: 1,
        rule: { mode: 'now', timezone: 'Europe/Moscow' },
      },
      contentRevision: {},
      publication: { targets: [] },
    };
    const { publisherRouting, service } = createService({
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([occurrence]),
        updateMany,
      },
      $transaction: transaction,
    });
    publisherRouting.deferOccurrenceIfBlocked.mockResolvedValue(true);
    jest.spyOn(service as any, 'resolveOccurrenceTargets').mockResolvedValue([
      {
        chatId: 'chat-1',
        entityType: 'chat',
        title: 'Чат',
        avatarUrl: null,
        link: null,
      },
    ]);
    jest
      .spyOn(service as any, 'createOccurrenceExecution')
      .mockRejectedValue(new PublisherSetupRequiredException(['chat-1'], 'policy_disabled'));

    await (service as any).dispatchScheduledOccurrences(1, [PublicationScheduleMode.NOW]);

    expect(publisherRouting.deferOccurrenceIfBlocked).toHaveBeenCalledWith(
      occurrence,
      expect.objectContaining({ blockerCode: 'policy_disabled' }),
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('scopes an ordinary Publisher wake to recent current Publik occurrences', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const findMany = jest.fn().mockResolvedValue([]);
      const { service } = createService({ publicationOccurrence: { findMany } });

      await service.processPublisherPublicationWake(' publication-1 ', {
        allowPastScheduled: false,
      });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            publicationId: 'publication-1',
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            status: PublicationOccurrenceStatus.SCHEDULED,
            scheduledAt: {
              gte: new Date('2026-09-04T09:55:00.000Z'),
              lte: new Date('2026-09-04T10:05:00.000Z'),
            },
            publication: {
              is: {
                lifecycle: PublicationLifecycle.ACTIVE,
                dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              },
            },
            schedule: {
              is: {
                status: PublicationScheduleStatus.ACTIVE,
                mode: {
                  in: [
                    PublicationScheduleMode.NOW,
                    PublicationScheduleMode.ONCE,
                    PublicationScheduleMode.SLOTS,
                    PublicationScheduleMode.RECURRENCE,
                  ],
                },
              },
            },
            legacyBroadcasts: { none: {} },
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows only an exact explicitly retried Publisher occurrence past the grace window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const findMany = jest.fn().mockResolvedValue([]);
      const { service } = createService({ publicationOccurrence: { findMany } });

      await service.processPublisherPublicationWake('publication-1', {
        allowPastScheduled: true,
        occurrenceId: ' occurrence-retried ',
      });

      const query = findMany.mock.calls[0]![0];
      expect(query.where).toEqual(
        expect.objectContaining({
          id: 'occurrence-retried',
          publicationId: 'publication-1',
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          scheduledAt: { lte: new Date('2026-09-04T10:05:00.000Z') },
        }),
      );
      expect(query.where.scheduledAt).not.toHaveProperty('gte');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['off', 'test'] as const)(
    'rolls an ambiguous delivery up in %s mode without making it retryable',
    async (mode) => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const observedAt = new Date('2026-07-10T10:01:00.000Z');
      const sqlRead: jest.MockedFunction<PrismaService['$queryRaw']> = jest.fn();
      const fullRead = jest.fn().mockResolvedValue({
        id: 'occurrence-1',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
        scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
        legacyBroadcasts: [
          {
            status: ManagedBroadcastStatus.FAILED,
            deliveries: [{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS }],
          },
        ],
      });
      const { presenter, service } = createService(
        {
          $queryRaw: sqlRead,
          publicationOccurrence: {
            findUnique: fullRead,
            updateMany,
          },
        },
        mode,
      );

      await (service as any).rollupOccurrence('occurrence-1');
      expect(sqlRead).not.toHaveBeenCalled();
      expect(fullRead).toHaveBeenCalledTimes(1);

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'occurrence-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
        },
        data: { status: PublicationOccurrenceStatus.AMBIGUOUS },
      });
      expect(
        presenter.buildDeliveryStats([{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS }]),
      ).toEqual({
        total: 1,
        pending: 0,
        sent: 0,
        failed: 0,
        ambiguous: 1,
        canceled: 0,
      });
    },
  );

  it('rolls a terminal canceled envelope with only sent deliveries up as sent', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-canceled-envelope',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.CANCELED,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-1',
                  lastErrorCode: null,
                  lastError: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-canceled-envelope');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-canceled-envelope',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.SENT },
    });
  });

  it('rolls a stale active envelope with untouched sent deliveries up as sent', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-active-pristine',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-1',
                  lastErrorCode: null,
                  lastError: null,
                  remoteMessageId: 'legacy-message',
                  remoteMessageVerifiedAt: null,
                  remoteMessageVerificationAttemptCount: 0,
                  remoteMessageVerificationAbsentCount: 0,
                  remoteMessageVerificationPresentCount: 0,
                  remoteMessageVerificationAttemptedAt: null,
                  remoteMessageVerificationNextAt: null,
                  remoteMessageVerificationSource: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-active-pristine');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-active-pristine',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.SENT },
    });
  });

  it('keeps armed verification in progress while its envelope can still execute', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-active-verification',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: new Date('2026-07-10T10:01:00.000Z'),
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-1',
                  lastErrorCode: null,
                  lastError: null,
                  remoteMessageId: 'new-message',
                  remoteMessageVerifiedAt: null,
                  remoteMessageVerificationAttemptCount: 0,
                  remoteMessageVerificationAbsentCount: 0,
                  remoteMessageVerificationPresentCount: 0,
                  remoteMessageVerificationAttemptedAt: null,
                  remoteMessageVerificationNextAt: new Date('2026-07-10T10:01:15.000Z'),
                  remoteMessageVerificationSource: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-active-verification');

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('marks stopped envelopes with armed verification as ambiguous for manual review', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-stopped-verification',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.CANCELED,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-1',
                  lastErrorCode: null,
                  lastError: null,
                  remoteMessageId: 'new-message',
                  remoteMessageVerifiedAt: null,
                  remoteMessageVerificationAttemptCount: 0,
                  remoteMessageVerificationAbsentCount: 0,
                  remoteMessageVerificationPresentCount: 0,
                  remoteMessageVerificationAttemptedAt: null,
                  remoteMessageVerificationNextAt: new Date('2026-07-10T10:01:15.000Z'),
                  remoteMessageVerificationSource: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-stopped-verification');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-stopped-verification',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.AMBIGUOUS },
    });
  });

  it('keeps an occurrence in progress while an active envelope has ambiguous and pending targets', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: new Date('2026-07-10T10:01:00.000Z'),
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
                { status: ManagedBroadcastDeliveryStatus.PENDING },
              ],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-1');

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not overwrite a retried occurrence from a stale rollup snapshot', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const observedAt = new Date('2026-07-10T10:01:00.000Z');
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.FAILED,
              deliveries: [{ status: ManagedBroadcastDeliveryStatus.FAILED }],
            },
          ],
        }),
        updateMany,
      },
    });

    await (service as any).rollupOccurrence('occurrence-1');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-1',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.FAILED },
    });
  });

  it('pauses future slots after a pre-dispatch no-route failure', async () => {
    const observedAt = new Date('2026-07-27T15:00:00.000Z');
    const occurrenceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const publicationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const scheduleUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publicationOccurrence: {
        count: jest.fn().mockResolvedValue(2),
        updateMany: occurrenceUpdateMany,
      },
      publicationSchedule: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'schedule-1',
          revision: 4,
          status: PublicationScheduleStatus.ACTIVE,
          nextMaterializeAt: null,
        }),
        updateMany: scheduleUpdateMany,
      },
      publicationTarget: { count: jest.fn().mockResolvedValue(1) },
      publication: { updateMany: publicationUpdateMany },
      managedBroadcast: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-no-route',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-27T14:59:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.FAILED,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.FAILED,
                  targetChatId: 'chat-no-route',
                  lastError: buildMaxActionNoExecutableRouteMessage(
                    'SEND_MESSAGE',
                    'chat-no-route',
                  ),
                },
              ],
            },
          ],
        }),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await (service as any).rollupOccurrence('occurrence-no-route');

    expect(occurrenceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PublicationOccurrenceStatus.FAILED } }),
    );
    expect(publicationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'publication-1',
        lifecycle: PublicationLifecycle.ACTIVE,
        targets: { some: { targetChatId: 'chat-no-route' } },
      },
      data: { lifecycle: PublicationLifecycle.PAUSED },
    });
    expect(scheduleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publicationId: 'publication-1',
          id: 'schedule-1',
          revision: 4,
          status: PublicationScheduleStatus.ACTIVE,
        },
        data: expect.objectContaining({
          status: PublicationScheduleStatus.PAUSED,
          nextMaterializeAt: null,
          lastError: expect.stringContaining('права администратора'),
        }),
      }),
    );
  });

  it('does not pause healthy targets after one target loses its route', async () => {
    const observedAt = new Date('2026-07-27T15:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = jest.fn();
    const { service } = createService({
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-partial-route',
          publicationId: 'publication-1',
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          updatedAt: observedAt,
          scheduleRevision: 4,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2026-07-27T14:59:00.000Z'),
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.PARTIAL,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.FAILED,
                  targetChatId: 'chat-no-route',
                  lastError: buildMaxActionNoExecutableRouteMessage(
                    'SEND_MESSAGE',
                    'chat-no-route',
                  ),
                },
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  targetChatId: 'chat-healthy',
                  lastError: null,
                },
              ],
            },
          ],
        }),
        updateMany,
      },
      $transaction: transaction,
    });

    await (service as any).rollupOccurrence('occurrence-partial-route');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-partial-route',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        updatedAt: observedAt,
        scheduleRevision: 4,
        contentRevisionId: 'content-1',
      },
      data: { status: PublicationOccurrenceStatus.PARTIAL },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rolls up active and ambiguous occurrences so completed rows cannot starve the batch', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = createService({ publicationOccurrence: { findMany } });

    await (service as any).rollupActiveOccurrences();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: {
            in: [
              PublicationOccurrenceStatus.SCHEDULED,
              PublicationOccurrenceStatus.IN_PROGRESS,
              PublicationOccurrenceStatus.AMBIGUOUS,
            ],
          },
          legacyBroadcasts: { some: { deliveries: { some: {} } } },
        },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
        take: 200,
        select: { id: true, scheduledAt: true },
      }),
    );
  });

  it('persists a non-empty MIME type for contract-valid video input', async () => {
    const assetUpsert = jest.fn().mockResolvedValue({ id: 'asset-1' });
    const tx = {
      publicationContentRevision: {
        create: jest.fn().mockResolvedValue({ id: 'content-1' }),
      },
      publicationAsset: { upsert: assetUpsert },
      publicationContentAsset: { create: jest.fn().mockResolvedValue({}) },
    };
    const { contentService } = createService();

    const prepared = await contentService.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        {
          type: 'video',
          payload: { token: 'video-1' },
          base64: '',
          mimeType: '',
          fileName: '',
        },
      ],
    });
    await contentService.persistPreparedContentRevision(tx, 'publication-1', 2, prepared, 'user-1');

    expect(assetUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ mimeType: 'application/octet-stream' }),
      }),
    );
    expect(tx.publicationContentRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revision: 2 }),
      }),
    );
  });

  it('stores an uploaded video as bounded bytes and builds a trusted test upload marker', async () => {
    const videoBytes = TINY_VALID_MP4;
    const assetUpsert = jest.fn().mockResolvedValue({ id: 'asset-video' });
    const tx = {
      publicationContentRevision: {
        create: jest.fn().mockResolvedValue({ id: 'content-video' }),
      },
      publicationAsset: { upsert: assetUpsert },
      publicationContentAsset: { create: jest.fn().mockResolvedValue({}) },
    };
    const { contentService } = createService();
    const content = {
      text: '',
      textFormat: 'plain' as const,
      buttons: [],
      media: [
        {
          type: 'video' as const,
          payload: null,
          base64: videoBytes.toString('base64'),
          mimeType: 'video/mp4',
          fileName: 'clip.mp4',
        },
      ],
    };

    const prepared = await contentService.prepareContentRevision(content);
    await contentService.persistPreparedContentRevision(tx, 'publication-1', 3, prepared, 'user-1');

    expect(assetUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          mimeType: 'video/mp4',
          sizeBytes: videoBytes.length,
          bytes: videoBytes,
          durablePayload: Prisma.DbNull,
        }),
      }),
    );
    await expect(
      contentService.buildLegacyTestPayload(
        {
          requestId: 'request-video-1',
          content,
          sourceTarget: { chatId: 'chat-1', entityType: 'chat' },
        },
        'user-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        mediaType: 'video',
        mediaPayload: {
          [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: videoBytes.toString('base64'),
        },
        mediaMimeType: 'video/mp4',
        mediaFileName: 'clip.mp4',
      }),
    );
  });

  it('rejects raw video above the public 24 MB byte limit', async () => {
    const { contentService } = createService();
    const oversized = Buffer.alloc(PUBLICATION_MAX_VIDEO_BYTES + 1).toString('base64');

    await expect(
      contentService.buildLegacyTestPayload(
        {
          requestId: 'request-video-too-large',
          content: {
            text: '',
            textFormat: 'plain',
            buttons: [],
            media: [
              {
                type: 'video',
                payload: null,
                base64: oversized,
                mimeType: 'video/mp4',
                fileName: 'large.mp4',
              },
            ],
          },
          sourceTarget: { chatId: 'chat-1', entityType: 'chat' },
        },
        'user-1',
      ),
    ).rejects.toThrow('Видео слишком большое. Максимум 24 МБ.');
  });

  it('turns only an actor-owned byte-backed video reference into an internal asset marker', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'asset-video-owned',
        bytes: Buffer.from('saved-video'),
        durablePayload: null,
        mimeType: 'video/mp4',
        fileName: 'saved.mp4',
      })
      .mockResolvedValueOnce(null);
    const { contentService } = createService({ publicationAsset: { findFirst } });
    const request = {
      requestId: 'request-video-ref',
      content: {
        text: '',
        textFormat: 'plain' as const,
        buttons: [],
        media: [{ type: 'video-ref' as const, assetId: 'asset-video-owned' }],
      },
      sourceTarget: { chatId: 'chat-1', entityType: 'chat' as const },
    };

    await expect(contentService.buildLegacyTestPayload(request, 'user-1')).resolves.toEqual(
      expect.objectContaining({
        mediaType: 'video',
        mediaPayload: { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-video-owned' },
      }),
    );
    await expect(contentService.buildLegacyTestPayload(request, 'user-2')).rejects.toThrow(
      'Медиа публикации больше недоступно.',
    );
    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'asset-video-owned',
          OR: expect.arrayContaining([expect.objectContaining({ actorUserId: 'user-2' })]),
        }),
      }),
    );
  });

  it('rejects internal video markers supplied through a public video payload', async () => {
    const { contentService } = createService();

    await expect(
      contentService.buildLegacyTestPayload(
        {
          requestId: 'request-forged-video-marker',
          content: {
            text: '',
            textFormat: 'plain',
            buttons: [],
            media: [
              {
                type: 'video',
                payload: { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-from-another-user' },
                base64: '',
                mimeType: 'video/mp4',
                fileName: 'forged.mp4',
              },
            ],
          },
          sourceTarget: { chatId: 'chat-1', entityType: 'chat' },
        },
        'user-1',
      ),
    ).rejects.toThrow('Сохранённое видео больше недоступно.');
  });

  it('presents stopped dispatch without changing delivery evidence or sent post-actions', async () => {
    const future = new Date('2026-11-01T12:00:00.000Z');
    type PresentationRow = Prisma.ManagedBroadcastDeliveryGetPayload<{
      include: typeof PUBLICATION_DELIVERY_PRESENTATION_INCLUDE;
    }>;
    const parents: Pick<
      PresentationRow,
      'broadcast' | 'publicationOccurrence' | 'contentRevision'
    > = {
      broadcast: { entityType: ChatEntityType.CHAT, status: ManagedBroadcastStatus.ACTIVE },
      publicationOccurrence: {
        id: 'occurrence-1',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        deliveryDeadlineAt: future,
        retryExpiresAt: null,
        publication: { canonicalContentRevisionId: 'content-1' },
      },
      contentRevision: { id: 'content-1', revision: 1, postPublish: null },
    };
    type DeliveryEvidenceRow = Pick<
      PresentationRow,
      | keyof typeof parents
      | 'id'
      | 'targetChatId'
      | 'status'
      | 'attemptCount'
      | 'remoteMessageId'
      | 'sentAt'
      | 'lastError'
      | 'nextAttemptAt'
      | 'waitReason'
      | 'firstDeferredAt'
      | 'pinStatus'
      | 'deleteStatus'
      | 'deleteAt'
    >;
    const delivery = (
      id: string,
      status: ManagedBroadcastDeliveryStatus,
      occurrenceStatus: PublicationOccurrenceStatus,
      broadcastStatus: ManagedBroadcastStatus = ManagedBroadcastStatus.ACTIVE,
    ): DeliveryEvidenceRow => ({
      ...parents,
      id,
      targetChatId: 'chat-1',
      status,
      broadcast: { ...parents.broadcast, status: broadcastStatus },
      publicationOccurrence: { ...parents.publicationOccurrence!, status: occurrenceStatus },
      attemptCount: 2,
      remoteMessageId: status === ManagedBroadcastDeliveryStatus.SENT ? 'confirmed-message' : null,
      sentAt:
        status === ManagedBroadcastDeliveryStatus.SENT ? new Date('2026-10-20T12:00:00Z') : null,
      lastError: 'Retained evidence',
      nextAttemptAt: future,
      waitReason: 'local_capacity',
      firstDeferredAt: new Date('2026-10-20T11:00:00Z'),
      pinStatus: 'DONE',
      deleteStatus: 'PENDING',
      deleteAt: future,
    });
    const rows = [
      delivery(
        'stopped-pending',
        ManagedBroadcastDeliveryStatus.PENDING,
        PublicationOccurrenceStatus.CANCELED,
      ),
      delivery(
        'stopped-envelope',
        ManagedBroadcastDeliveryStatus.PENDING,
        PublicationOccurrenceStatus.SENT,
        ManagedBroadcastStatus.CANCELED,
      ),
      delivery(
        'stopped-sending',
        ManagedBroadcastDeliveryStatus.SENDING,
        PublicationOccurrenceStatus.IN_PROGRESS,
        ManagedBroadcastStatus.CANCELED,
      ),
      delivery(
        'stopped-ambiguous',
        ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        PublicationOccurrenceStatus.CANCELED,
      ),
      delivery(
        'active-pending',
        ManagedBroadcastDeliveryStatus.PENDING,
        PublicationOccurrenceStatus.SCHEDULED,
      ),
      delivery(
        'stopped-sent',
        ManagedBroadcastDeliveryStatus.SENT,
        PublicationOccurrenceStatus.SENT,
        ManagedBroadcastStatus.CANCELED,
      ),
    ];
    const { service } = createService({
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 1,
          lifecycle: PublicationLifecycle.ACTIVE,
        }),
      },
      managedBroadcastDelivery: { findMany: jest.fn().mockResolvedValue(rows) },
      chat: { findMany: jest.fn().mockResolvedValue([{ id: 'chat-1', title: 'Чат' }]) },
    });

    const page = await service.listDeliveries('publication-1', { userId: 'user-1' } as never, {});
    expect(
      page.items.map(({ id, status, dispatchStopped }) => ({ id, status, dispatchStopped })),
    ).toEqual([
      { id: 'stopped-pending', status: 'PENDING', dispatchStopped: true },
      { id: 'stopped-envelope', status: 'PENDING', dispatchStopped: true },
      { id: 'stopped-sending', status: 'SENDING', dispatchStopped: true },
      { id: 'stopped-ambiguous', status: 'AMBIGUOUS', dispatchStopped: true },
      { id: 'active-pending', status: 'PENDING', dispatchStopped: false },
      { id: 'stopped-sent', status: 'SENT', dispatchStopped: true },
    ]);
    expect(
      page.items.every((item) => item.attemptCount === 2 && item.lastError === 'Retained evidence'),
    ).toBe(true);
    expect(page.items[0]).toMatchObject({
      nextAttemptAt: future.toISOString(),
      waitReason: 'local_capacity',
      firstDeferredAt: '2026-10-20T11:00:00.000Z',
      deadlineAt: future.toISOString(),
      remoteMessageId: null,
    });
    expect(page.items[5]).toMatchObject({
      remoteMessageId: 'confirmed-message',
      sentAt: '2026-10-20T12:00:00.000Z',
      postActions: {
        pinStatus: 'DONE',
        deleteStatus: 'PENDING',
        deleteAt: future.toISOString(),
        allowedActions: ['reschedule_delete', 'cancel_delete'],
      },
    });
  });

  it('aggregates grouped delivery counts without expanding them into rows', async () => {
    const { presenter } = createService({
      $queryRaw: jest.fn().mockResolvedValue([
        {
          status: ManagedBroadcastDeliveryStatus.SENT,
          count: 1_000_000n,
        },
        {
          status: ManagedBroadcastDeliveryStatus.SENDING,
          count: 7n,
        },
      ]),
    });

    await expect(presenter.loadDeliveryStats('publication-1')).resolves.toEqual({
      total: 1_000_007,
      pending: 7,
      sent: 1_000_000,
      failed: 0,
      ambiguous: 0,
      canceled: 0,
    });
  });

  it('maps the earliest scheduled occurrence as the next publication time', async () => {
    const { presenter } = createService({
      managedBroadcastDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
    });

    const summary = await presenter.mapPublicationSummary({
      id: 'publication-1',
      title: 'Публикация',
      lifecycle: PublicationLifecycle.ACTIVE,
      version: 1,
      canonicalContentRevision: { text: 'Текст', assets: [] },
      targets: [],
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      schedule: {
        rule: {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-11T12:00:00.000+03:00',
          replaceConflicts: false,
        },
        status: PublicationScheduleStatus.ACTIVE,
        revision: 1,
        lastError: null,
      },
      occurrences: [
        {
          status: PublicationOccurrenceStatus.SENT,
          scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
        },
        {
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduledAt: new Date('2026-07-11T09:00:00.000Z'),
        },
        {
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduledAt: new Date('2026-07-10T09:00:00.000Z'),
        },
      ],
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });

    expect(summary.schedule?.nextOccurrenceAt).toBe('2026-07-10T09:00:00.000Z');
  });

  it('loads the nearest scheduled occurrence independently from limited history', async () => {
    const detailsRow = { id: 'publication-1', occurrences: [] };
    const publicationFindFirst = jest.fn().mockResolvedValue(detailsRow);
    const occurrenceFindFirst = jest.fn().mockResolvedValue({
      scheduledAt: new Date('2026-07-10T09:00:00.000Z'),
    });
    const occurrenceFindMany = jest.fn().mockResolvedValue([]);
    const { presenter } = createService({
      publication: { findFirst: publicationFindFirst },
      publicationOccurrence: {
        findFirst: occurrenceFindFirst,
        findMany: occurrenceFindMany,
      },
    });

    await expect(presenter.loadPublicationDetailsRow('publication-1', 'user-1')).resolves.toEqual({
      ...detailsRow,
      nextOccurrenceAt: new Date('2026-07-10T09:00:00.000Z'),
      dispatchIssue: null,
      deliveryStats: {
        total: 0,
        pending: 0,
        sent: 0,
        failed: 0,
        ambiguous: 0,
        canceled: 0,
      },
      actionableDeliveryStats: {
        total: 0,
        pending: 0,
        dispatchPending: 0,
        sent: 0,
        failed: 0,
        ambiguous: 0,
        canceled: 0,
      },
    });
    expect(occurrenceFindFirst).toHaveBeenCalledWith({
      where: {
        publicationId: 'publication-1',
        status: PublicationOccurrenceStatus.SCHEDULED,
      },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    });
  });

  it('keeps every unresolved occurrence beyond the recent history limit without duplicates', async () => {
    const recentOccurrences = Array.from({ length: 50 }, (_, index) => ({
      id: `recent-${String(index).padStart(2, '0')}`,
      scheduledAt: new Date(Date.UTC(2026, 6, 31 - index)),
      status: index === 10 ? PublicationOccurrenceStatus.FAILED : PublicationOccurrenceStatus.SENT,
      deliveries: [],
    }));
    const unresolvedInsideRecent = recentOccurrences[10]!;
    const unresolvedOutsideRecent = {
      id: 'unresolved-outside-recent',
      scheduledAt: new Date('2025-12-01T09:00:00.000Z'),
      status: PublicationOccurrenceStatus.AMBIGUOUS,
      deliveries: [{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS }],
    };
    const sameTimeA = {
      id: 'unresolved-a',
      scheduledAt: new Date('2026-08-01T09:00:00.000Z'),
      status: PublicationOccurrenceStatus.IN_PROGRESS,
      deliveries: [{ status: ManagedBroadcastDeliveryStatus.PENDING }],
    };
    const sameTimeB = { ...sameTimeA, id: 'unresolved-b' };
    const publicationFindFirst = jest.fn().mockResolvedValue({
      id: 'publication-1',
      occurrences: recentOccurrences,
    });
    const occurrenceFindMany = jest
      .fn()
      .mockResolvedValue([sameTimeB, sameTimeA, unresolvedInsideRecent, unresolvedOutsideRecent]);
    const { presenter } = createService({
      publication: { findFirst: publicationFindFirst },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: occurrenceFindMany,
      },
    });

    const result = await presenter.loadPublicationDetailsRow('publication-1', 'user-1');

    expect(result?.occurrences).toHaveLength(53);
    expect(result?.occurrences.slice(0, 2).map((occurrence) => occurrence.id)).toEqual([
      'unresolved-b',
      'unresolved-a',
    ]);
    expect(result?.occurrences.at(-1)?.id).toBe('unresolved-outside-recent');
    expect(
      result?.occurrences.filter((occurrence) => occurrence.id === unresolvedInsideRecent.id),
    ).toHaveLength(1);
    expect(publicationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          occurrences: expect.objectContaining({
            orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
            take: 50,
          }),
        }),
      }),
    );
    expect(occurrenceFindMany).toHaveBeenCalledWith({
      where: {
        publicationId: 'publication-1',
        status: {
          in: [
            PublicationOccurrenceStatus.SCHEDULED,
            PublicationOccurrenceStatus.IN_PROGRESS,
            PublicationOccurrenceStatus.FAILED,
            PublicationOccurrenceStatus.PARTIAL,
            PublicationOccurrenceStatus.AMBIGUOUS,
          ],
        },
      },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        scheduleId: true,
        scheduleRevision: true,
        contentRevisionId: true,
        legacyBroadcastId: true,
        scheduledAt: true,
        status: true,
        contentRevision: { select: { revision: true } },
        _count: { select: { legacyBroadcasts: true } },
        dispatchFirstBlockedAt: true,
        dispatchBlockedAt: true,
      },
    });
  });

  it('does not create an execution envelope when the occurrence content revision changed', async () => {
    const managedBroadcastCount = jest.fn();
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publicationOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      managedBroadcast: { count: managedBroadcastCount },
    };
    const { service } = createService({
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await (service as any).createOccurrenceExecution(
      {
        id: 'occurrence-stale-content',
        publicationId: 'publication-1',
        scheduleId: 'schedule-1',
        scheduleRevision: 3,
        contentRevisionId: 'content-old',
        scheduledAt: new Date('2026-07-10T10:00:00.000Z'),
        legacyBroadcastId: null,
        schedule: { timezone: 'Europe/Moscow' },
        contentRevision: {
          text: 'Старый текст',
          textFormat: PublicationContentFormat.PLAIN,
          buttons: [],
        },
        publication: { actorUserId: 'user-1' },
      },
      [
        {
          chatId: 'chat-1',
          entityType: 'chat',
          title: 'Чат',
          avatarUrl: null,
          link: null,
        },
      ],
      { mode: 'now', timezone: 'Europe/Moscow' },
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'occurrence-stale-content',
          scheduleRevision: 3,
          contentRevisionId: 'content-old',
        }),
      }),
    );
    expect(managedBroadcastCount).not.toHaveBeenCalled();
  });

  it('cancels stale schedule revisions before they can starve the dispatcher batch', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = createService({
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'occurrence-old-revision',
            scheduleRevision: 2,
            schedule: { revision: 3 },
          },
        ]),
        updateMany,
      },
    });

    await (service as any).dispatchScheduledOccurrences(1);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-old-revision',
        scheduleRevision: 2,
        status: PublicationOccurrenceStatus.SCHEDULED,
        deliveries: {
          none: {
            status: {
              in: [
                ManagedBroadcastDeliveryStatus.SENDING,
                ManagedBroadcastDeliveryStatus.AMBIGUOUS,
              ],
            },
          },
        },
      },
      data: { status: PublicationOccurrenceStatus.CANCELED },
    });
  });

  it('fails closed when a background occurrence target is no longer administered', async () => {
    const { service, managedEntitiesService } = createService();
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ForbiddenException('Пользователь не является администратором чата.'),
    );

    await expect(
      (service as any).resolveOccurrenceTargets({
        actorUserId: 'user-1',
        audienceMode: 'SNAPSHOT',
        audienceSelection: 'SELECTED',
        targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('defers background dispatch without terminal mutations on a transient access outage', async () => {
    const scheduleUpdate = jest.fn();
    const occurrenceUpdate = jest.fn();
    const publicationUpdate = jest.fn();
    const transaction = jest.fn();
    const { service, managedEntitiesService } = createService({
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'occurrence-access-transient',
            publicationId: 'publication-access-transient',
            scheduleId: 'schedule-access-transient',
            scheduleRevision: 3,
            contentRevisionId: 'content-1',
            scheduledAt: new Date('2026-07-10T09:00:00.000Z'),
            schedule: {
              mode: PublicationScheduleMode.NOW,
              revision: 3,
              rule: { mode: 'now', timezone: 'UTC' },
            },
            publication: {
              actorUserId: 'user-1',
              audienceMode: PublicationAudienceMode.SNAPSHOT,
              audienceSelection: PublicationAudienceSelection.SELECTED,
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
            },
          },
        ]),
        updateMany: occurrenceUpdate,
      },
      publicationSchedule: { updateMany: scheduleUpdate },
      publication: { updateMany: publicationUpdate },
      $transaction: transaction,
    });
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ServiceUnavailableException('Не удалось проверить права администратора в MAX.'),
    );
    const createExecution = jest.spyOn(service as any, 'createOccurrenceExecution');
    (service as any).logger.warn = jest.fn();

    await (service as any).dispatchScheduledOccurrences(1);

    expect(createExecution).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect(occurrenceUpdate).not.toHaveBeenCalled();
    expect(publicationUpdate).not.toHaveBeenCalled();
  });

  it('defers recurrence materialization without terminal mutations on a transient access outage', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const scheduleUpdate = jest.fn();
      const publicationUpdate = jest.fn();
      const occurrenceCreate = jest.fn();
      const transaction = jest.fn(async (callback) =>
        callback({
          $executeRaw: jest.fn().mockResolvedValue(1),
          publicationSchedule: { updateMany: scheduleUpdate },
        }),
      );
      const { service, managedEntitiesService } = createService({
        publicationSchedule: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'schedule-access-transient',
              publicationId: 'publication-access-transient',
              revision: 4,
              nextMaterializeAt: new Date('2026-07-10T08:59:00Z'),
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['10:00'],
                startsAt: '2026-07-10T09:00:00.000Z',
                endsAt: null,
                maxOccurrences: 1,
                replaceConflicts: false,
              },
              publication: {
                id: 'publication-access-transient',
                version: 3,
                actorUserId: 'user-1',
                audienceMode: PublicationAudienceMode.SNAPSHOT,
                audienceSelection: PublicationAudienceSelection.SELECTED,
                canonicalContentRevisionId: 'content-1',
                targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
              },
            },
          ]),
          updateMany: scheduleUpdate,
        },
        publicationOccurrence: {
          findFirst: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
          createMany: occurrenceCreate,
        },
        publication: { updateMany: publicationUpdate },
        $transaction: transaction,
      });
      managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
        new ServiceUnavailableException('Не удалось проверить права администратора в MAX.'),
      );
      (service as any).logger.warn = jest.fn();

      await (service as any).materializeRecurringSchedules(1);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(scheduleUpdate).toHaveBeenCalledWith({
        where: {
          id: 'schedule-access-transient',
          revision: 4,
          status: PublicationScheduleStatus.ACTIVE,
          nextMaterializeAt: new Date('2026-07-10T08:59:00Z'),
          publication: { is: { lifecycle: PublicationLifecycle.ACTIVE, version: 3 } },
        },
        data: {
          nextMaterializeAt: expect.any(Date),
          lastError: 'PUBLICATION_PREPARATION_TRANSIENT',
        },
      });
      expect(publicationUpdate).not.toHaveBeenCalled();
      expect(occurrenceCreate).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not materialize recurrence slots after a stale schedule claim', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const createMany = jest.fn();
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publicationSchedule: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        publicationOccurrence: { createMany },
      };
      const { service } = createService({
        publicationSchedule: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'schedule-1',
              publicationId: 'publication-1',
              revision: 4,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['10:00'],
                startsAt: '2026-07-10T09:00:00.000Z',
                endsAt: null,
                maxOccurrences: null,
                replaceConflicts: false,
              },
              publication: {
                id: 'publication-1',
                actorUserId: 'user-1',
                audienceMode: 'SNAPSHOT',
                audienceSelection: 'SELECTED',
                canonicalContentRevisionId: 'content-1',
                targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
              },
            },
          ]),
        },
        publicationOccurrence: {
          findFirst: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
        },
        chat: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'chat-1', title: 'Чат', entityType: ChatEntityType.CHAT }]),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });

      await (service as any).materializeRecurringSchedules(1);

      expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'schedule-1',
            revision: 4,
            status: PublicationScheduleStatus.ACTIVE,
          }),
        }),
      );
      expect(createMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('materializes recurrence slots with the canonical content refreshed under the lock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const createMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publication: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ canonicalContentRevisionId: 'content-current' }),
        },
        publicationSchedule: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        publicationOccurrence: { createMany },
      };
      const { service } = createService({
        publicationSchedule: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'schedule-1',
              publicationId: 'publication-1',
              revision: 4,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['10:00'],
                startsAt: '2026-07-10T09:00:00.000Z',
                endsAt: null,
                maxOccurrences: 1,
                replaceConflicts: false,
              },
              publication: {
                id: 'publication-1',
                actorUserId: 'user-1',
                audienceMode: 'SNAPSHOT',
                audienceSelection: 'SELECTED',
                canonicalContentRevisionId: 'content-stale',
                dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
                requiredBotId: null,
                targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
              },
            },
          ]),
        },
        publicationOccurrence: {
          findFirst: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
        },
        chat: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'chat-1', title: 'Чат', entityType: ChatEntityType.CHAT }]),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });
      jest.spyOn(service as any, 'reservePublicationCalendar').mockResolvedValue(undefined);

      await (service as any).materializeRecurringSchedules(1);

      expect(tx.publication.findUnique).toHaveBeenCalledWith({
        where: { id: 'publication-1' },
        select: { canonicalContentRevisionId: true },
      });
      expect(createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            publicationId: 'publication-1',
            scheduleRevision: 4,
            contentRevisionId: 'content-current',
            dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
            requiredBotId: null,
          }),
        ],
        skipDuplicates: true,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reactivates the exact failed schedule revision before retrying deliveries', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 7,
          lifecycle: PublicationLifecycle.ERROR,
          canonicalContentRevisionId: 'content-latest',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
          contentRevisionId: 'content-original',
          contentRevision: { revision: 1 },
          status: PublicationOccurrenceStatus.FAILED,
          schedule: { id: 'schedule-1', mode: PublicationScheduleMode.RECURRENCE },
          legacyBroadcasts: [{ id: 'broadcast-1' }],
        }),
      },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.retryOccurrence(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      { requestId: 'retry-001' },
    );

    expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'schedule-1',
        revision: 5,
        status: { in: [PublicationScheduleStatus.ACTIVE, PublicationScheduleStatus.ERROR] },
        publication: { is: { id: 'publication-1', lifecycle: PublicationLifecycle.ACTIVE } },
      },
      data: {
        status: PublicationScheduleStatus.ACTIVE,
        nextMaterializeAt: expect.any(Date),
        lastError: null,
      },
    });
    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.FAILED }),
            {
              status: ManagedBroadcastDeliveryStatus.PENDING,
              attemptCount: 0,
              remoteMessageId: null,
              sentAt: null,
              lockedAt: null,
              lockToken: null,
            },
          ]),
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          botId: null,
          remoteMessageId: null,
          remoteMessageVerifiedAt: null,
          remoteMessageVerificationAttemptCount: 0,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
          remoteMessageVerificationSource: null,
          legacySentWithoutRemoteId: false,
          sentAt: null,
        }),
      }),
    );
  });

  it('reactivates a failed execution envelope with 99 untouched pending deliveries', async () => {
    const resetDeliveries = jest.fn().mockResolvedValue({ count: 99 });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcastDelivery: { updateMany: resetDeliveries },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service, failedDeliveryCount } = createOriginalRetryService(tx);
    failedDeliveryCount.mockResolvedValue(99);

    await service.retryOccurrence(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      { requestId: 'retry-99-pending' },
    );

    const untouchedPendingWhere = {
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      sentAt: null,
      lockedAt: null,
      lockToken: null,
    };
    expect(failedDeliveryCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        publicationOccurrenceId: 'occurrence-1',
        OR: expect.arrayContaining([untouchedPendingWhere]),
      }),
    });
    expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        publicationOccurrenceId: 'occurrence-1',
        status: {
          in: [ManagedBroadcastStatus.PARTIAL, ManagedBroadcastStatus.FAILED],
        },
        deliveries: {
          some: expect.objectContaining({
            publicationOccurrenceId: 'occurrence-1',
            OR: expect.arrayContaining([untouchedPendingWhere]),
          }),
        },
      }),
      select: { id: true },
    });
    expect(tx.managedBroadcast.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [ManagedBroadcastStatus.PARTIAL, ManagedBroadcastStatus.FAILED],
          },
          deliveries: expect.objectContaining({
            none: expect.objectContaining({
              OR: expect.arrayContaining([
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
                {
                  status: ManagedBroadcastDeliveryStatus.PENDING,
                  OR: [
                    { attemptCount: { not: 0 } },
                    { remoteMessageId: { not: null } },
                    { sentAt: { not: null } },
                    { lockedAt: { not: null } },
                    { lockToken: { not: null } },
                  ],
                },
              ]),
            }),
          }),
        }),
      }),
    );
    expect(resetDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          publicationOccurrenceId: 'occurrence-1',
          broadcastId: { in: ['broadcast-1'] },
          OR: expect.arrayContaining([untouchedPendingWhere]),
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          dispatchBlockerCode: null,
          dispatchBlockedAt: null,
        }),
      }),
    );
    expect(tx.managedBroadcast.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [ManagedBroadcastStatus.PARTIAL, ManagedBroadcastStatus.FAILED],
          },
        }),
        data: expect.objectContaining({ status: ManagedBroadcastStatus.ACTIVE }),
      }),
    );
  });

  it('requeues a failed occurrence without an execution envelope only after an explicit retry', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcast: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: { updateMany: jest.fn() },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 7,
          lifecycle: PublicationLifecycle.ERROR,
          canonicalContentRevisionId: 'content-current',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-orphan',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
          contentRevisionId: 'content-current',
          contentRevision: { revision: 7 },
          status: PublicationOccurrenceStatus.FAILED,
          legacyBroadcastId: null,
          schedule: { id: 'schedule-1', mode: PublicationScheduleMode.ONCE },
          _count: { deliveries: 0, legacyBroadcasts: 0 },
        }),
      },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.retryOccurrence(
      'publication-1',
      'occurrence-orphan',
      { userId: 'user-1', username: null, displayName: null },
      { requestId: 'retry-orphan-001' },
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-orphan',
        publicationId: 'publication-1',
        scheduleRevision: 5,
        status: PublicationOccurrenceStatus.FAILED,
        legacyBroadcastId: null,
        legacyBroadcasts: { none: {} },
        deliveries: { none: {} },
        contentRevisionId: 'content-current',
      },
      data: {
        status: PublicationOccurrenceStatus.SCHEDULED,
        dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
        dispatchBlockedAt: expect.any(Date),
        retryAuthorizedAt: expect.any(Date),
        retryExpiresAt: expect.any(Date),
      },
    });
    expect(tx.managedBroadcast.findMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
    expect(tx.publicationMutationRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'user-1',
        requestId: 'retry-orphan-001',
        publicationId: 'publication-1',
      }),
    });
  });

  it('does not requeue a delivery-less failure when an execution envelope still exists', async () => {
    const tx = { $executeRaw: jest.fn() };
    const { service, transaction, failedDeliveryCount } = createOriginalRetryService(tx);
    failedDeliveryCount.mockResolvedValue(0);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-non-orphan-001' },
      ),
    ).rejects.toThrow('Нет доставок, которые можно безопасно повторить');

    expect(failedDeliveryCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        publicationOccurrenceId: 'occurrence-1',
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: ManagedBroadcastDeliveryStatus.FAILED,
            OR: expect.arrayContaining([
              { remoteMessageVerificationLastError: null },
              { lastError: null },
              { lastError: { not: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR } },
            ]),
          }),
          expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.PENDING }),
        ]),
      }),
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rebinds only failed and untouched pending targets when retrying the latest revision', async () => {
    const persistedDeliveries: Array<{
      id: string;
      broadcastId: string;
      publicationOccurrenceId: string;
      status: ManagedBroadcastDeliveryStatus;
      contentRevisionId: string;
    }> = [
      {
        id: 'delivery-failed',
        broadcastId: 'broadcast-failed',
        publicationOccurrenceId: 'occurrence-1',
        status: ManagedBroadcastDeliveryStatus.FAILED,
        contentRevisionId: 'content-original',
      },
      {
        id: 'delivery-sent',
        broadcastId: 'broadcast-failed',
        publicationOccurrenceId: 'occurrence-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        contentRevisionId: 'content-original',
      },
      {
        id: 'delivery-pending',
        broadcastId: 'broadcast-failed',
        publicationOccurrenceId: 'occurrence-1',
        status: ManagedBroadcastDeliveryStatus.PENDING,
        contentRevisionId: 'content-original',
      },
      {
        id: 'delivery-ambiguous',
        broadcastId: 'broadcast-ambiguous',
        publicationOccurrenceId: 'occurrence-1',
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        contentRevisionId: 'content-original',
      },
    ];
    const updateDeliveries = jest.fn().mockImplementation(
      async ({
        where,
        data,
      }: {
        where: {
          publicationOccurrenceId: string;
          broadcastId: { in: string[] };
          OR: Array<{ status: ManagedBroadcastDeliveryStatus }>;
        };
        data: Partial<(typeof persistedDeliveries)[number]>;
      }) => {
        let count = 0;
        for (const delivery of persistedDeliveries) {
          if (
            delivery.publicationOccurrenceId !== where.publicationOccurrenceId ||
            !where.broadcastId.in.includes(delivery.broadcastId) ||
            !where.OR.some((candidate) => candidate.status === delivery.status)
          ) {
            continue;
          }
          Object.assign(delivery, data);
          count += 1;
        }
        return { count };
      },
    );
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcastDelivery: { updateMany: updateDeliveries },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-failed' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const deliveryCount = jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 8,
          lifecycle: PublicationLifecycle.ERROR,
          canonicalContentRevisionId: 'content-latest',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      publicationContentRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'content-latest',
          revision: 8,
          text: 'Актуальный текст',
          textFormat: PublicationContentFormat.MARKDOWN,
          buttons: [{ text: 'Открыть', url: 'https://example.com' }],
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
          contentRevisionId: 'content-original',
          contentRevision: { revision: 7 },
          status: PublicationOccurrenceStatus.PARTIAL,
          schedule: { id: 'schedule-1', mode: PublicationScheduleMode.ONCE },
          legacyBroadcasts: [
            { id: 'broadcast-failed' },
            { id: 'broadcast-sent' },
            { id: 'broadcast-ambiguous' },
          ],
        }),
      },
      managedBroadcastDelivery: { count: deliveryCount },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.retryOccurrence(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      {
        requestId: 'retry-latest-001',
        contentMode: 'latest',
        expectedPublicationVersion: 8,
        expectedContentRevision: 8,
      },
    );

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contentRevisionId: 'content-original' }),
        data: expect.objectContaining({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          contentRevisionId: 'content-latest',
        }),
      }),
    );
    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          broadcastId: { in: ['broadcast-failed'] },
          OR: expect.arrayContaining([
            expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.FAILED }),
            expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.PENDING }),
          ]),
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.PENDING,
          contentRevisionId: 'content-latest',
        }),
      }),
    );
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['broadcast-failed'] } }),
        data: expect.objectContaining({
          text: 'Актуальный текст',
          textFormat: 'markdown',
          publicationContentRevisionId: 'content-latest',
        }),
      }),
    );
    expect(persistedDeliveries).toEqual([
      expect.objectContaining({
        id: 'delivery-failed',
        status: ManagedBroadcastDeliveryStatus.PENDING,
        contentRevisionId: 'content-latest',
      }),
      expect.objectContaining({
        id: 'delivery-sent',
        status: ManagedBroadcastDeliveryStatus.SENT,
        contentRevisionId: 'content-original',
      }),
      expect.objectContaining({
        id: 'delivery-pending',
        status: ManagedBroadcastDeliveryStatus.PENDING,
        contentRevisionId: 'content-latest',
      }),
      expect.objectContaining({
        id: 'delivery-ambiguous',
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        contentRevisionId: 'content-original',
      }),
    ]);
    expect(tx.managedBroadcast.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['broadcast-failed'] },
          lockedAt: null,
          lockToken: null,
          status: {
            in: [ManagedBroadcastStatus.PARTIAL, ManagedBroadcastStatus.FAILED],
          },
          deliveries: expect.objectContaining({
            some: expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.FAILED }),
                expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.PENDING }),
              ]),
            }),
            none: expect.objectContaining({
              OR: expect.arrayContaining([
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
                expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.PENDING }),
              ]),
            }),
          }),
        }),
        data: {
          lockedAt: expect.any(Date),
          lockToken: expect.stringMatching(/^publication-retry:/),
        },
      }),
    );
    expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
      where: {
        publicationOccurrenceId: 'occurrence-1',
        status: {
          in: [ManagedBroadcastStatus.PARTIAL, ManagedBroadcastStatus.FAILED],
        },
        deliveries: {
          some: expect.objectContaining({
            publicationOccurrenceId: 'occurrence-1',
            OR: expect.arrayContaining([
              expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.FAILED }),
              expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.PENDING }),
            ]),
          }),
        },
      },
      select: { id: true },
    });
    expect(tx.managedBroadcast.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['broadcast-failed'] },
          lockToken: expect.stringMatching(/^publication-retry:/),
        }),
        data: expect.objectContaining({ lockedAt: null, lockToken: null }),
      }),
    );
  });

  it('rolls back an original retry when any failed envelope already has a worker lease', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcast: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'broadcast-free' }, { id: 'broadcast-worker-owned' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publication: { updateMany: jest.fn() },
      publicationSchedule: { updateMany: jest.fn() },
      publicationOccurrence: { updateMany: jest.fn() },
      managedBroadcastDelivery: { updateMany: jest.fn() },
    };
    const { service } = createOriginalRetryService(tx);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-worker-owned' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lockedAt: null,
          lockToken: null,
          deliveries: expect.objectContaining({
            none: expect.objectContaining({
              OR: expect.arrayContaining([
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
                expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.PENDING }),
              ]),
            }),
          }),
        }),
      }),
    );
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back when a worker lease appears between envelope selection and CAS claim', async () => {
    let envelopesSelected = false;
    const findMany = jest.fn().mockImplementation(async () => {
      envelopesSelected = true;
      return [{ id: 'broadcast-1' }];
    });
    const claimBroadcast = jest.fn().mockImplementation(async () => {
      expect(envelopesSelected).toBe(true);
      return { count: 0 };
    });
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcast: { findMany, updateMany: claimBroadcast },
      publication: { updateMany: jest.fn() },
      publicationSchedule: { updateMany: jest.fn() },
      publicationOccurrence: { updateMany: jest.fn() },
      managedBroadcastDelivery: { updateMany: jest.fn() },
    };
    const { service } = createOriginalRetryService(tx);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-raced-lease' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(findMany.mock.invocationCallOrder[0]).toBeLessThan(
      claimBroadcast.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks the retryable occurrence status inside the transaction', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      managedBroadcastDelivery: { updateMany: jest.fn() },
    };
    const { service } = createOriginalRetryService(tx);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-occurrence-race' },
      ),
    ).rejects.toThrow('Запуск публикации уже изменён');

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [PublicationOccurrenceStatus.FAILED, PublicationOccurrenceStatus.PARTIAL],
          },
        }),
      }),
    );
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    PublicationOccurrenceStatus.CANCELED,
    PublicationOccurrenceStatus.SENT,
    PublicationOccurrenceStatus.IN_PROGRESS,
  ])('rejects a %s occurrence before starting a retry transaction', async (status) => {
    const tx = { $executeRaw: jest.fn() };
    const { service, transaction, failedDeliveryCount } = createOriginalRetryService(tx, status);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: `retry-invalid-${status.toLowerCase()}` },
      ),
    ).rejects.toThrow('Этот запуск больше нельзя повторить');

    expect(failedDeliveryCount).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects retry for an ambiguous post-send occurrence before counting failed deliveries', async () => {
    const tx = { $executeRaw: jest.fn() };
    const { service, transaction, failedDeliveryCount } = createOriginalRetryService(
      tx,
      PublicationOccurrenceStatus.AMBIGUOUS,
    );

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-ambiguous-post-send' },
      ),
    ).rejects.toThrow('Этот запуск больше нельзя повторить');

    expect(failedDeliveryCount).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not retry when the exact schedule revision is paused or terminal', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      publicationOccurrence: { updateMany: jest.fn() },
      managedBroadcastDelivery: { updateMany: jest.fn() },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 7,
          lifecycle: PublicationLifecycle.ERROR,
          canonicalContentRevisionId: 'content-latest',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 5,
          contentRevisionId: 'content-original',
          contentRevision: { revision: 1 },
          status: PublicationOccurrenceStatus.FAILED,
          schedule: { id: 'schedule-1', mode: PublicationScheduleMode.ONCE },
          legacyBroadcasts: [{ id: 'broadcast-1' }],
        }),
      },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-002' },
      ),
    ).rejects.toThrow('Расписание публикации изменилось или остановлено');
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a delivery retry when access to a persisted target was revoked', async () => {
    const tx = { $executeRaw: jest.fn() };
    const { service, transaction, failedDeliveryCount, managedEntitiesService } =
      createOriginalRetryService(tx);
    managedEntitiesService.listChats.mockResolvedValue([]);
    managedEntitiesService.listChannels.mockResolvedValue([]);

    await expect(
      service.retryOccurrence(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-revoked-001' },
      ),
    ).rejects.toThrow('больше недоступны');
    expect(failedDeliveryCount).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['pause', PublicationLifecycle.DRAFT],
    ['resume', PublicationLifecycle.ACTIVE],
    ['cancel', PublicationLifecycle.COMPLETED],
  ] as const)('rejects invalid %s transition from %s', async (action, lifecycle) => {
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({ id: 'publication-1', version: 1, lifecycle }),
      },
    });

    await expect(
      service[action](
        'publication-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: `action-${action}`, expectedRevision: 1 },
      ),
    ).rejects.toThrow();
  });

  it('rejects resume before mutation when live access to a persisted target is revoked', async () => {
    const transaction = jest.fn();
    const { service, managedEntitiesService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 1,
          lifecycle: PublicationLifecycle.PAUSED,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      $transaction: transaction,
    });
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ForbiddenException('Пользователь не является администратором чата.'),
    );

    await expect(
      service.resume(
        'publication-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'resume-revoked-001', expectedRevision: 1 },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel'] as const)(
    'allows %s to reach the stop transaction without live target access',
    async (action) => {
      const transactionStarted = new Error('stop transaction started');
      const transaction = jest.fn().mockRejectedValue(transactionStarted);
      const { service, managedEntitiesService } = createService({
        publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-1',
            version: 1,
            lifecycle: PublicationLifecycle.ACTIVE,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          }),
        },
        $transaction: transaction,
      });
      managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
        new ForbiddenException('Пользователь не является администратором чата.'),
      );

      await expect(
        service[action](
          'publication-1',
          { userId: 'user-1', username: null, displayName: null },
          { requestId: `${action}-revoked-001`, expectedRevision: 1 },
        ),
      ).rejects.toBe(transactionStarted);

      expect(managedEntitiesService.assertChatAdminAccess).not.toHaveBeenCalled();
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('removes only unsent canceled envelopes from future scheduled occurrences before resume', async () => {
    const tx = {
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([{ id: 'occurrence-1' }]),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');

    await (service as any).restoreAccessLossPausedOccurrences(
      tx,
      'publication-1',
      'schedule-1',
      3,
      now,
    );

    expect(tx.publicationOccurrence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          publicationId: 'publication-1',
          scheduleId: 'schedule-1',
          scheduleRevision: 3,
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduledAt: { gte: now },
          deliveries: {
            none: {
              OR: [
                { attemptCount: { gt: 0 } },
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.SENT,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
              ],
            },
          },
        }),
      }),
    );
    expect(tx.managedBroadcast.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['broadcast-1'] } },
    });
  });

  it('marks an ambiguous delivery sent, completes its broadcast, and rolls state up before get', async () => {
    const tx = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ status: ManagedBroadcastDeliveryStatus.SENT }]),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { findUnique: jest.fn().mockResolvedValue(null) },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service, publisherPublicationWakeupQueue } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 2,
          lifecycle: PublicationLifecycle.ERROR,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'delivery-1',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          sentAt: null,
          remoteMessageId: 'mid-manual-confirmed',
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    const rollupOccurrence = jest
      .spyOn(service as any, 'rollupOccurrence')
      .mockResolvedValue(undefined);
    const rollupLifecycle = jest
      .spyOn(service as any, 'rollupPublicationLifecycle')
      .mockResolvedValue(undefined);
    const get = jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.resolveAmbiguousDelivery(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      { requestId: 'resolve-001', deliveryId: 'delivery-1', resolution: 'mark_sent' },
    );

    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.SENT,
          remoteMessageVerificationAttemptCount: 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationSource: PublicationDeliveryVerificationSource.MANUAL_CONFIRMED,
          remoteMessageVerifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.COMPLETED,
          sentCount: 1,
          nextSendAt: null,
        }),
      }),
    );
    expect(rollupOccurrence).toHaveBeenCalledWith('occurrence-1');
    expect(rollupLifecycle).toHaveBeenCalledWith('publication-1');
    expect(rollupLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      get.mock.invocationCallOrder[0],
    );
    expect(publisherPublicationWakeupQueue.enqueueResolution).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
      'resolve-001',
    );
  });

  it('retains the manual CAS and repairs a failed rollup probe on replay without redoing the mutation', async () => {
    const occurrenceUpdatedAt = new Date('2026-09-04T09:00:00.000Z');
    const tx = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { status: ManagedBroadcastDeliveryStatus.SENT },
            { status: ManagedBroadcastDeliveryStatus.PENDING },
          ]),
      },
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          status: PublicationOccurrenceStatus.AMBIGUOUS,
          updatedAt: occurrenceUpdatedAt,
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2020-09-04T08:00:00.000Z'),
          publication: { lifecycle: PublicationLifecycle.ERROR },
          schedule: { revision: 2, status: PublicationScheduleStatus.ERROR },
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  remoteMessageId: 'mid-manual-confirmed',
                  remoteMessageVerifiedAt: new Date('2026-09-04T09:00:00.000Z'),
                },
                {
                  status: ManagedBroadcastDeliveryStatus.PENDING,
                  remoteMessageId: null,
                  remoteMessageVerifiedAt: null,
                },
              ],
            },
          ],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const findMutation = jest.fn().mockResolvedValueOnce(null);
    const transaction = jest.fn((callback: (client: typeof tx) => unknown) => callback(tx));
    const rollupFailure = new Error('rollup probe unavailable');
    const rollupProbe: jest.MockedFunction<PrismaService['$queryRaw']> = jest.fn();
    rollupProbe.mockRejectedValueOnce(rollupFailure).mockResolvedValueOnce([
      {
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        scheduledAt: new Date('2020-09-04T08:00:00.000Z'),
        enrolled: true,
        hasSending: false,
        hasActivePending: true,
      },
    ]);
    const fullOccurrenceReader = jest.fn();
    const { service, publisherPublicationWakeupQueue } = createService(
      {
        $queryRaw: rollupProbe,
        publicationOccurrence: { findUnique: fullOccurrenceReader },
        publicationMutationRecord: { findUnique: findMutation },
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-1',
            version: 2,
            lifecycle: PublicationLifecycle.ERROR,
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          }),
        },
        managedBroadcastDelivery: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'delivery-1',
            broadcastId: 'broadcast-1',
            occurrenceIndex: 1,
            status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
            sentAt: null,
            remoteMessageId: 'mid-manual-confirmed',
          }),
        },
        $transaction: transaction,
      },
      '100',
    );
    const rollupLifecycle = jest
      .spyOn(service as any, 'rollupPublicationLifecycle')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);
    const request = {
      requestId: 'resolve-replay',
      deliveryId: 'delivery-1',
      resolution: 'mark_sent',
    } as const;
    const user = { userId: 'user-1', username: null, displayName: null };
    findMutation.mockResolvedValueOnce({
      publicationId: 'publication-1',
      requestHash: (service as any).hashMutationRequest({
        publicationId: 'publication-1',
        occurrenceId: 'occurrence-1',
        ...request,
      }),
    });

    await expect(
      service.resolveAmbiguousDelivery('publication-1', 'occurrence-1', user, request),
    ).rejects.toBe(rollupFailure);
    await expect(
      service.resolveAmbiguousDelivery('publication-1', 'occurrence-1', user, request),
    ).resolves.toEqual({ id: 'publication-1' });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(extractSqlText(tx.$executeRaw.mock.calls[0]?.[0])).toContain(
      "pg_advisory_xact_lock(hashtext('publication-calendar'))",
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.managedBroadcastDelivery.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ManagedBroadcastStatus.ACTIVE }),
      }),
    );
    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'occurrence-1',
        publicationId: 'publication-1',
        status: PublicationOccurrenceStatus.AMBIGUOUS,
        updatedAt: occurrenceUpdatedAt,
        scheduleId: 'schedule-1',
        scheduleRevision: 2,
        contentRevisionId: 'content-1',
        publication: { is: { lifecycle: PublicationLifecycle.ERROR } },
        schedule: {
          is: { revision: 2, status: PublicationScheduleStatus.ERROR },
        },
      },
      data: { status: PublicationOccurrenceStatus.IN_PROGRESS },
    });
    expect(tx.publicationOccurrence.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.publicationMutationRecord.create.mock.invocationCallOrder[0]!,
    );
    expect(tx.publication.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'publication-1',
        lifecycle: PublicationLifecycle.ERROR,
        schedule: {
          is: {
            id: 'schedule-1',
            revision: 2,
            status: PublicationScheduleStatus.ERROR,
          },
        },
      },
      data: { lifecycle: PublicationLifecycle.ACTIVE },
    });
    expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'schedule-1',
        publicationId: 'publication-1',
        revision: 2,
        status: PublicationScheduleStatus.ERROR,
        publication: {
          is: { id: 'publication-1', lifecycle: PublicationLifecycle.ACTIVE },
        },
      },
      data: { status: PublicationScheduleStatus.ACTIVE, lastError: null },
    });
    expect(rollupProbe).toHaveBeenCalledTimes(2);
    expect(fullOccurrenceReader).not.toHaveBeenCalled();
    expect(rollupLifecycle).toHaveBeenCalledTimes(1);
    expect(publisherPublicationWakeupQueue.enqueueResolution).toHaveBeenCalledWith(
      'publication-1',
      'occurrence-1',
      'resolve-replay',
    );
    expect(tx.publicationSchedule.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      publisherPublicationWakeupQueue.enqueueResolution.mock.invocationCallOrder[0]!,
    );
  });

  it('aborts a stale occurrence CAS before the mutation record or resolution wake', async () => {
    const occurrenceUpdatedAt = new Date('2026-09-04T09:00:00.000Z');
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { status: ManagedBroadcastDeliveryStatus.SENT },
            { status: ManagedBroadcastDeliveryStatus.PENDING },
          ]),
      },
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publication: { updateMany: jest.fn() },
      publicationSchedule: { updateMany: jest.fn() },
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'occurrence-1',
          publicationId: 'publication-1',
          status: PublicationOccurrenceStatus.AMBIGUOUS,
          updatedAt: occurrenceUpdatedAt,
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          scheduledAt: new Date('2020-09-04T08:00:00.000Z'),
          publication: { lifecycle: PublicationLifecycle.ERROR },
          schedule: { revision: 2, status: PublicationScheduleStatus.ERROR },
          legacyBroadcasts: [
            {
              status: ManagedBroadcastStatus.ACTIVE,
              deliveries: [
                {
                  status: ManagedBroadcastDeliveryStatus.PENDING,
                  remoteMessageId: null,
                  remoteMessageVerifiedAt: null,
                },
              ],
            },
          ],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      publicationMutationRecord: { create: jest.fn() },
    };
    const { service, publisherPublicationWakeupQueue } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 2,
          lifecycle: PublicationLifecycle.ERROR,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'delivery-1',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          sentAt: null,
          remoteMessageId: 'mid-manual-confirmed',
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    const rollupOccurrence = jest.spyOn(service as any, 'rollupOccurrence');

    await expect(
      service.resolveAmbiguousDelivery(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'resolve-stale-cas',
          deliveryId: 'delivery-1',
          resolution: 'mark_sent',
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.managedBroadcastDelivery.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
    expect(tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
    expect(tx.publicationMutationRecord.create).not.toHaveBeenCalled();
    expect(rollupOccurrence).not.toHaveBeenCalled();
    expect(publisherPublicationWakeupQueue.enqueueResolution).not.toHaveBeenCalled();
  });

  it('allows manual resolution of a legacy automated-absence FAILED delivery', async () => {
    const tx = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ status: ManagedBroadcastDeliveryStatus.SENT }]),
      },
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { findUnique: jest.fn().mockResolvedValue(null) },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 2,
          lifecycle: PublicationLifecycle.ERROR,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'delivery-legacy-absence',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: ManagedBroadcastDeliveryStatus.FAILED,
          remoteMessageId: 'remote-message',
          remoteMessageVerifiedAt: null,
          remoteMessageVerificationAttemptCount: 3,
          remoteMessageVerificationAbsentCount: 3,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: new Date('2026-07-25T08:05:00.000Z'),
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
          remoteMessageVerificationSource: null,
          legacySentWithoutRemoteId: false,
          lastErrorCode: null,
          lastError: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
          sentAt: new Date('2026-07-25T08:00:00.000Z'),
          lockedAt: null,
          lockToken: null,
          publicationOccurrenceId: 'occurrence-1',
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    jest.spyOn(service as any, 'rollupOccurrence').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'rollupPublicationLifecycle').mockResolvedValue(undefined);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.resolveAmbiguousDelivery(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      {
        requestId: 'resolve-legacy-absence',
        deliveryId: 'delivery-legacy-absence',
        resolution: 'mark_sent',
      },
    );

    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'delivery-legacy-absence',
          status: ManagedBroadcastDeliveryStatus.FAILED,
          remoteMessageVerificationAbsentCount: { gte: 3 },
          lastError: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.SENT,
          remoteMessageVerificationSource: PublicationDeliveryVerificationSource.MANUAL_CONFIRMED,
        }),
      }),
    );
  });

  it('marks an ambiguous post-send delivery failed only after explicit resolution', async () => {
    const tx = {
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ status: ManagedBroadcastDeliveryStatus.FAILED }]),
      },
      managedBroadcast: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { findUnique: jest.fn().mockResolvedValue(null) },
      publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    };
    const sentAt = new Date('2026-07-25T08:00:00.000Z');
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 2,
          lifecycle: PublicationLifecycle.ERROR,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'delivery-1',
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          sentAt,
          remoteMessageId: 'mid-manual-rejected',
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });
    const rollupOccurrence = jest
      .spyOn(service as any, 'rollupOccurrence')
      .mockResolvedValue(undefined);
    const rollupLifecycle = jest
      .spyOn(service as any, 'rollupPublicationLifecycle')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'get').mockResolvedValue({ id: 'publication-1' } as never);

    await service.resolveAmbiguousDelivery(
      'publication-1',
      'occurrence-1',
      { userId: 'user-1', username: null, displayName: null },
      { requestId: 'resolve-mark-failed', deliveryId: 'delivery-1', resolution: 'mark_failed' },
    );

    expect(tx.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
      data: {
        status: ManagedBroadcastDeliveryStatus.FAILED,
        lastErrorCode: null,
        lastError: 'Администратор подтвердил, что сообщение не было опубликовано.',
      },
    });
    const resolutionData = tx.managedBroadcastDelivery.updateMany.mock.calls[0]?.[0]?.data;
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'user-1',
          action: 'PUBLICATION_DELIVERY_RESOLVED',
          payload: expect.objectContaining({
            deliveryId: 'delivery-1',
            resolution: 'mark_failed',
            hadRemoteMessageId: true,
          }),
        }),
      }),
    );
    expect(resolutionData).not.toHaveProperty('remoteMessageId');
    expect(resolutionData).not.toHaveProperty('sentAt');
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ManagedBroadcastStatus.FAILED }),
      }),
    );
    expect(rollupOccurrence).toHaveBeenCalledWith('occurrence-1');
    expect(rollupLifecycle).toHaveBeenCalledWith('publication-1');
  });

  it('rejects ambiguous-delivery resolution before reading or mutating delivery state', async () => {
    const transaction = jest.fn();
    const findDelivery = jest.fn();
    const { service, managedEntitiesService } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 2,
          lifecycle: PublicationLifecycle.ERROR,
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
      managedBroadcastDelivery: { findFirst: findDelivery },
      $transaction: transaction,
    });
    managedEntitiesService.assertChatAdminAccess.mockRejectedValue(
      new ForbiddenException('Пользователь не является администратором чата.'),
    );

    await expect(
      service.resolveAmbiguousDelivery(
        'publication-1',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        {
          requestId: 'resolve-revoked-001',
          deliveryId: 'delivery-1',
          resolution: 'mark_failed',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(findDelivery).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('reactivates a broadcast when ambiguous resolution leaves pending fanout targets', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });

    await syncPublicationBroadcastAfterDeliveryResolution(
      {
        managedBroadcastDelivery: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { status: ManagedBroadcastDeliveryStatus.SENT },
              { status: ManagedBroadcastDeliveryStatus.PENDING },
            ]),
        },
        managedBroadcast: { updateMany },
      },
      'broadcast-1',
      1,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-1', status: { not: ManagedBroadcastStatus.CANCELED } },
      data: {
        status: ManagedBroadcastStatus.ACTIVE,
        nextSendAt: expect.any(Date),
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
  });

  it('keeps a resolved broadcast active while another sent target still needs verification', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const nextVerificationAt = new Date(Date.now() + 60_000);

    await syncPublicationBroadcastAfterDeliveryResolution(
      {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date(),
              remoteMessageId: null,
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: null,
            },
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date(),
              remoteMessageId: 'message-unverified',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: nextVerificationAt,
            },
          ]),
        },
        managedBroadcast: { updateMany },
      },
      'broadcast-1',
      1,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-1', status: { not: ManagedBroadcastStatus.CANCELED } },
      data: {
        status: ManagedBroadcastStatus.ACTIVE,
        nextSendAt: nextVerificationAt,
        lockedAt: null,
        lockToken: null,
        lastError: null,
      },
    });
  });

  it('does not reactivate a resolved broadcast for untouched legacy SENT verification state', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });

    await syncPublicationBroadcastAfterDeliveryResolution(
      {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-11T10:00:00.000Z'),
              remoteMessageId: 'message-legacy',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationAttemptCount: 0,
              remoteMessageVerificationAbsentCount: 0,
              remoteMessageVerificationPresentCount: 0,
              remoteMessageVerificationAttemptedAt: null,
              remoteMessageVerificationNextAt: null,
              remoteMessageVerificationSource: null,
            },
          ]),
        },
        managedBroadcast: { updateMany },
        managedBroadcastCalendarReservation: { deleteMany: jest.fn() },
        managedBroadcastOccurrence: { updateMany: jest.fn() },
      },
      'broadcast-legacy',
      1,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-legacy', status: { not: ManagedBroadcastStatus.CANCELED } },
      data: expect.objectContaining({
        status: ManagedBroadcastStatus.COMPLETED,
        sentCount: 1,
        nextSendAt: null,
      }),
    });
  });

  it.each([
    [
      [{ status: PublicationOccurrenceStatus.SENT, _count: { _all: 1 } }],
      PublicationScheduleStatus.ERROR,
      PublicationLifecycle.COMPLETED,
      PublicationScheduleStatus.COMPLETED,
      'sent current revision',
    ],
    [
      [],
      PublicationScheduleStatus.ACTIVE,
      PublicationLifecycle.COMPLETED,
      PublicationScheduleStatus.COMPLETED,
      'empty exhausted current revision',
    ],
    [
      [],
      PublicationScheduleStatus.ERROR,
      PublicationLifecycle.ERROR,
      PublicationScheduleStatus.ERROR,
      'empty failed schedule',
    ],
  ] as const)(
    'rolls lifecycle up for %s (%s)',
    async (grouped, scheduleStatus, expectedLifecycle, expectedScheduleStatus, _label) => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        publicationOccurrence: { count: jest.fn().mockResolvedValue(0) },
        publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const groupBy = jest.fn().mockResolvedValue(grouped);
      const { service } = createService({
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-1',
            lifecycle: PublicationLifecycle.ERROR,
            schedule: {
              id: 'schedule-1',
              revision: 6,
              status: scheduleStatus,
              nextMaterializeAt: null,
            },
          }),
        },
        publicationOccurrence: { groupBy },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });

      await (service as any).rollupPublicationLifecycle('publication-1');

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            publicationId: 'publication-1',
            scheduleId: 'schedule-1',
            scheduleRevision: 6,
          },
        }),
      );
      if (
        expectedLifecycle === PublicationLifecycle.ERROR &&
        expectedScheduleStatus === PublicationScheduleStatus.ERROR
      ) {
        expect(tx.publication.updateMany).not.toHaveBeenCalled();
        expect(tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
      } else {
        expect(tx.publication.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              occurrences: {
                none: {
                  scheduleId: 'schedule-1',
                  scheduleRevision: 6,
                  status: {
                    in: [
                      PublicationOccurrenceStatus.SCHEDULED,
                      PublicationOccurrenceStatus.IN_PROGRESS,
                    ],
                  },
                },
              },
            }),
            data: { lifecycle: expectedLifecycle },
          }),
        );
        expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: { status: expectedScheduleStatus } }),
        );
      }
    },
  );

  it('marks an empty active recurrence as an error instead of completing it as 0/0', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    try {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        publicationOccurrence: { count: jest.fn().mockResolvedValue(0) },
        publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const { service } = createService({
        publication: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'publication-empty',
            lifecycle: PublicationLifecycle.ACTIVE,
            schedule: {
              id: 'schedule-empty',
              revision: 1,
              mode: PublicationScheduleMode.RECURRENCE,
              status: PublicationScheduleStatus.ACTIVE,
              nextMaterializeAt: null,
              rule: {
                mode: 'recurrence',
                timezone: 'UTC',
                frequency: 'daily',
                interval: 1,
                weekdays: [],
                times: ['12:00'],
                startsAt: '2026-07-10T09:00:00.000Z',
                endsAt: '2026-07-10T10:00:00.000Z',
                maxOccurrences: null,
                replaceConflicts: false,
              },
            },
          }),
        },
        publicationOccurrence: {
          groupBy: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      });

      await (service as any).rollupPublicationLifecycle('publication-empty');

      expect(tx.publication.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lifecycle: PublicationLifecycle.ERROR } }),
      );
      expect(tx.publicationSchedule.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: PublicationScheduleStatus.ERROR,
            lastError: 'Расписание не содержит ни одного будущего запуска.',
          },
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves lifecycle active when a retry starts after the rollup aggregate read', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      publication: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      publicationOccurrence: { count: jest.fn().mockResolvedValue(1) },
      publicationSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const { service } = createService({
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          lifecycle: PublicationLifecycle.ACTIVE,
          schedule: {
            id: 'schedule-1',
            revision: 6,
            status: PublicationScheduleStatus.ACTIVE,
            nextMaterializeAt: null,
          },
        }),
      },
      publicationOccurrence: {
        groupBy: jest
          .fn()
          .mockResolvedValue([{ status: PublicationOccurrenceStatus.FAILED, _count: { _all: 1 } }]),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    });

    await (service as any).rollupPublicationLifecycle('publication-1');

    expect(tx.publicationOccurrence.count).toHaveBeenCalledWith({
      where: {
        publicationId: 'publication-1',
        scheduleId: 'schedule-1',
        scheduleRevision: 6,
        status: {
          in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
        },
      },
    });
    expect(tx.publication.updateMany).not.toHaveBeenCalled();
    expect(tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('selects lifecycle rollups only when no occurrence is still scheduled or in progress', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = createService({ publication: { findMany } });

    await (service as any).rollupPublicationLifecycles();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { lifecycle: PublicationLifecycle.ACTIVE },
            {
              lifecycle: PublicationLifecycle.ERROR,
              occurrences: {
                some: {
                  status: {
                    in: [PublicationOccurrenceStatus.SENT, PublicationOccurrenceStatus.CANCELED],
                  },
                },
                none: {
                  status: {
                    in: [
                      PublicationOccurrenceStatus.FAILED,
                      PublicationOccurrenceStatus.PARTIAL,
                      PublicationOccurrenceStatus.AMBIGUOUS,
                    ],
                  },
                },
              },
            },
          ],
          schedule: { is: { nextMaterializeAt: null } },
          occurrences: {
            none: {
              status: {
                in: [
                  PublicationOccurrenceStatus.SCHEDULED,
                  PublicationOccurrenceStatus.IN_PROGRESS,
                ],
              },
            },
          },
        },
      }),
    );
  });

  it('detects conflicts with current-revision publication occurrences before envelopes exist', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const { service } = createService({
      managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'old-occurrence',
            publicationId: 'old-publication',
            scheduleId: 'old-schedule',
            scheduleRevision: 2,
            scheduledAt: slot,
            schedule: { revision: 2 },
            publication: {
              actorUserId: 'user-1',
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
            },
          },
        ]),
      },
    });

    await expect(
      (service as any).assertCalendarAvailability(
        [
          {
            chatId: 'chat-1',
            entityType: 'chat',
            title: 'Чат',
            avatarUrl: null,
            link: null,
          },
        ],
        [slot],
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-12T12:00:00.000+03:00',
          replaceConflicts: false,
        },
        'user-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_SCHEDULE_CONFLICT' }),
    });
  });

  it('replaces only fully covered publication occurrences under the calendar lock', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const conflict = {
      id: 'old-occurrence',
      publicationId: 'old-publication',
      scheduleId: 'old-schedule',
      scheduleRevision: 2,
      scheduledAt: slot,
      schedule: { revision: 2 },
      publication: {
        actorUserId: 'user-1',
        targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      },
    };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([conflict]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
    };
    const { service } = createService();

    await (service as any).reservePublicationCalendar(
      tx,
      [
        {
          chatId: 'chat-1',
          entityType: 'chat',
          title: 'Чат',
          avatarUrl: null,
          link: null,
        },
      ],
      [slot],
      {
        mode: 'once',
        timezone: 'Europe/Moscow',
        at: '2026-07-12T12:00:00.000+03:00',
        replaceConflicts: true,
      },
      'new-publication',
      'user-1',
    );

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PublicationOccurrenceStatus.CANCELED } }),
    );
  });

  it('requires manual review when replacement does not cover all old occurrence targets', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'old-occurrence',
            publicationId: 'old-publication',
            scheduleId: 'old-schedule',
            scheduleRevision: 2,
            scheduledAt: slot,
            schedule: { revision: 2 },
            publication: {
              actorUserId: 'user-1',
              targets: [
                { targetChatId: 'chat-1', entityType: ChatEntityType.CHAT },
                { targetChatId: 'channel-1', entityType: ChatEntityType.CHANNEL },
              ],
            },
          },
        ]),
        updateMany: jest.fn(),
      },
    };
    const { service } = createService();

    await expect(
      (service as any).reservePublicationCalendar(
        tx,
        [
          {
            chatId: 'chat-1',
            entityType: 'chat',
            title: 'Чат',
            avatarUrl: null,
            link: null,
          },
        ],
        [slot],
        {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: '2026-07-12T12:00:00.000+03:00',
          replaceConflicts: true,
        },
        'new-publication',
        'user-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it("allows replacing another creator's unattempted occurrence within the authorized target set", async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastCalendarReservation: { findMany: jest.fn().mockResolvedValue([]) },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'other-owner-occurrence',
            publicationId: 'other-owner-publication',
            scheduleId: 'other-owner-schedule',
            scheduleRevision: 2,
            scheduledAt: slot,
            schedule: { revision: 2 },
            publication: {
              actorUserId: 'user-2',
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
            },
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
    };
    const { service } = createService();

    await (service as any).reservePublicationCalendar(
      tx,
      [
        {
          chatId: 'chat-1',
          entityType: 'chat',
          title: 'Чат',
          avatarUrl: null,
          link: null,
        },
      ],
      [slot],
      {
        mode: 'once',
        timezone: 'Europe/Moscow',
        at: '2026-07-12T12:00:00.000+03:00',
        replaceConflicts: true,
      },
      'new-publication',
      'user-1',
    );
    expect(tx.managedBroadcastDelivery.count).toHaveBeenCalled();
    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PublicationOccurrenceStatus.CANCELED } }),
    );
  });

  it('rejects replacement after any conflicting publication delivery attempt', async () => {
    const tx = {
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(1) },
      publicationOccurrence: { updateMany: jest.fn() },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingPublicationOccurrences(tx, [
        {
          id: 'old-occurrence',
          publicationId: 'old-publication',
          scheduleId: 'old-schedule',
          scheduleRevision: 2,
          scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
          schedule: { revision: 2 },
          publication: {
            actorUserId: 'user-1',
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          },
        },
      ]),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(tx.publicationOccurrence.updateMany).not.toHaveBeenCalled();
  });

  it('rejects replacement for a preclaimed publication execution envelope', async () => {
    const lockedAt = new Date('2026-07-12T08:59:59.000Z');
    const updateOccurrences = jest.fn();
    const updateBroadcasts = jest.fn();
    const tx = {
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'publication-broadcast',
            lockedAt,
            lockToken: 'publication-execution-lease',
          },
        ]),
        updateMany: updateBroadcasts,
      },
      publicationOccurrence: { updateMany: updateOccurrences },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingPublicationOccurrences(tx, [
        {
          id: 'old-occurrence',
          publicationId: 'old-publication',
          scheduleId: 'old-schedule',
          scheduleRevision: 2,
          scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
          schedule: { revision: 2 },
          publication: {
            actorUserId: 'user-1',
            targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
          },
        },
      ]),
    ).rejects.toMatchObject({
      response: {
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Конфликтующая публикация уже начала отправку. Проверьте её отдельно.',
      },
    });

    expect(tx.managedBroadcast.findMany).toHaveBeenCalledWith({
      where: {
        publicationOccurrenceId: { in: ['old-occurrence'] },
        status: {
          in: [
            ManagedBroadcastStatus.ACTIVE,
            ManagedBroadcastStatus.PARTIAL,
            ManagedBroadcastStatus.FAILED,
          ],
        },
      },
      select: { id: true, lockedAt: true, lockToken: true },
    });
    expect(updateOccurrences).not.toHaveBeenCalled();
    expect(updateBroadcasts).not.toHaveBeenCalled();
  });

  it('does not double-cancel a publication conflict represented by its reservation', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const reservationFindMany = jest.fn().mockResolvedValue([
      {
        broadcastId: 'publication-broadcast',
        entityType: ChatEntityType.CHAT,
        targetChatId: 'chat-1',
        scheduledAt: slot,
      },
    ]);
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastCalendarReservation: {
        findMany: reservationFindMany,
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationOccurrence: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'old-occurrence',
            publicationId: 'old-publication',
            scheduleId: 'old-schedule',
            scheduleRevision: 2,
            scheduledAt: slot,
            schedule: { revision: 2 },
            publication: {
              actorUserId: 'user-1',
              targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
            },
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'publication-broadcast' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const { service } = createService();

    await (service as any).reservePublicationCalendar(
      tx,
      [
        {
          chatId: 'chat-1',
          entityType: 'chat',
          title: 'Чат',
          avatarUrl: null,
          link: null,
        },
      ],
      [slot],
      {
        mode: 'once',
        timezone: 'Europe/Moscow',
        at: '2026-07-12T12:00:00.000+03:00',
        replaceConflicts: true,
      },
      'new-publication',
      'user-1',
    );

    expect(reservationFindMany).toHaveBeenCalledTimes(1);
    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledTimes(1);
  });

  it('cancels a mixed occurrence only after every execution envelope is canceled', async () => {
    const tx = {
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            broadcastId: 'broadcast-chat',
            entityType: ChatEntityType.CHAT,
            targetChatId: 'chat-1',
            scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
          },
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationOccurrence: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const { service } = createService();

    await (service as any).cancelConflictingBroadcasts(tx, ['broadcast-chat'], {
      entityType: ChatEntityType.CHAT,
      scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
      targetChatIds: ['chat-1'],
      actorUserId: 'user-1',
    });

    expect(tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        legacyBroadcasts: {
          some: { id: { in: ['broadcast-chat'] } },
          every: { status: ManagedBroadcastStatus.CANCELED },
        },
      },
      data: { status: PublicationOccurrenceStatus.CANCELED },
    });
  });

  it('does not replace a legacy broadcast after delivery started or a lock is active', async () => {
    const reservationFindMany = jest.fn();
    const tx = {
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(1) },
      managedBroadcast: { findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-1' }]) },
      managedBroadcastCalendarReservation: { findMany: reservationFindMany },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingBroadcasts(tx, ['broadcast-1'], {
        entityType: ChatEntityType.CHAT,
        scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
        targetChatIds: ['chat-1'],
        actorUserId: 'user-1',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(reservationFindMany).not.toHaveBeenCalled();
  });

  it("requires manual review before replacing another owner's legacy broadcast", async () => {
    const reservationFindMany = jest.fn();
    const updateBroadcasts = jest.fn();
    const tx = {
      managedBroadcastDelivery: { count: jest.fn().mockResolvedValue(0) },
      managedBroadcast: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'broadcast-other-owner', actorUserId: 'user-2' }]),
        updateMany: updateBroadcasts,
      },
      managedBroadcastCalendarReservation: { findMany: reservationFindMany },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingBroadcasts(tx, ['broadcast-other-owner'], {
        entityType: ChatEntityType.CHAT,
        scheduledAt: new Date('2026-07-12T09:00:00.000Z'),
        targetChatIds: ['chat-1'],
        actorUserId: 'user-1',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(reservationFindMany).not.toHaveBeenCalled();
    expect(updateBroadcasts).not.toHaveBeenCalled();
  });

  it('returns a controlled conflict when a legacy broadcast is claimed after replacement preflight', async () => {
    const slot = new Date('2026-07-12T09:00:00.000Z');
    const deleteReservations = jest.fn();
    const updateDeliveries = jest.fn();
    const tx = {
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: updateDeliveries,
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      managedBroadcastCalendarReservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            broadcastId: 'broadcast-1',
            entityType: ChatEntityType.CHAT,
            targetChatId: 'chat-1',
            scheduledAt: slot,
          },
        ]),
        deleteMany: deleteReservations,
      },
      publicationOccurrence: { updateMany: jest.fn() },
    };
    const { service } = createService();

    await expect(
      (service as any).cancelConflictingBroadcasts(tx, ['broadcast-1'], {
        entityType: ChatEntityType.CHAT,
        scheduledAt: slot,
        targetChatIds: ['chat-1'],
        actorUserId: 'user-1',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' }),
    });
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          actorUserId: 'user-1',
          sentCount: 0,
          lockedAt: null,
          lockToken: null,
          deliveries: {
            none: {
              OR: expect.arrayContaining([
                { attemptCount: { gt: 0 } },
                { lockedAt: { not: null } },
                {
                  status: {
                    in: [
                      ManagedBroadcastDeliveryStatus.SENDING,
                      ManagedBroadcastDeliveryStatus.SENT,
                      ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                    ],
                  },
                },
              ]),
            },
          },
        }),
      }),
    );
    expect(deleteReservations).not.toHaveBeenCalled();
    expect(updateDeliveries).not.toHaveBeenCalled();
  });

  it('keeps both entity types in mixed target previews limited to six items', async () => {
    const { presenter } = createService({
      managedBroadcastDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
    });
    const targets = [
      ...Array.from({ length: 6 }, (_, index) => ({
        targetChatId: `chat-${index + 1}`,
        entityType: ChatEntityType.CHAT,
        chat: { title: `Чат ${index + 1}` },
      })),
      {
        targetChatId: 'channel-1',
        entityType: ChatEntityType.CHANNEL,
        chat: { title: 'Канал' },
      },
    ];

    const summary = await presenter.mapPublicationSummary({
      id: 'publication-mixed',
      title: 'Mixed',
      lifecycle: PublicationLifecycle.ACTIVE,
      version: 1,
      canonicalContentRevision: { text: 'Текст', assets: [] },
      targets,
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      schedule: null,
      occurrences: [],
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });

    expect(summary.targetPreviews).toHaveLength(6);
    expect(summary.targetPreviews.map((target) => target.entityType)).toEqual(
      expect.arrayContaining(['chat', 'channel']),
    );
    expect(summary.targetOverflowCount).toBe(1);
  });

  it('marks maxOccurrences=1 recurrence exhausted after its initial slot', () => {
    const { service } = createService();
    const now = new Date('2026-07-10T09:00:00.000Z');

    expect(
      (service as any).isInitialRecurrenceExhausted(
        {
          mode: 'recurrence',
          timezone: 'UTC',
          frequency: 'daily',
          interval: 1,
          weekdays: [],
          times: ['10:00'],
          startsAt: now.toISOString(),
          endsAt: null,
          maxOccurrences: 1,
          replaceConflicts: false,
        },
        [new Date('2026-07-10T10:00:00.000Z')],
        now,
      ),
    ).toBe(true);
  });

  it('resolves PUBLIK_V1 audiences from Publisher-owned scope without Major discovery', async () => {
    const { managedEntitiesService, publisherPolicyService, service } = createService();
    const user = { userId: 'user-1', username: null, displayName: null };

    const targets = await (service as any).resolveAudienceTargets(
      user,
      {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: [{ chatId: 'channel-1', entityType: 'channel' }],
      },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(targets).toEqual([
      expect.objectContaining({ chatId: 'channel-1', entityType: 'channel' }),
    ]);
    expect(publisherPolicyService.resolvePublicationTargets).toHaveBeenCalledWith(user, [
      { chatId: 'channel-1', entityType: 'channel' },
    ]);
    expect(managedEntitiesService.listChats).not.toHaveBeenCalled();
    expect(managedEntitiesService.listChannels).not.toHaveBeenCalled();
    expect(managedEntitiesService.assertChatAdminAccess).not.toHaveBeenCalled();
    expect(managedEntitiesService.assertChannelAdminAccess).not.toHaveBeenCalled();
  });

  it('scopes publication management to exact Publisher administrator grants', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { service } = createService({ publication: { findFirst } });

    await expect(
      (service as any).assertPublicationOwner(
        'publication-1',
        'user-1',
        PublicationDispatchProfile.PUBLIK_V1,
      ),
    ).rejects.toThrow('Публикация не найдена.');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'publication-1',
          ...publicationAdminAccessWhere(
            publicationAdminScope('user-1', 'publisher-bot'),
            PublicationDispatchProfile.PUBLIK_V1,
            'manage',
          ),
        },
      }),
    );
  });

  it('rejects legacy-profile calendar work before resolving any Major audience', async () => {
    const { managedEntitiesService, publisherPolicyService, service } = createService();

    await expect(
      service.getCalendarAvailability(
        { userId: 'user-1' } as never,
        {
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: 'chat-1', entityType: 'chat' }],
          },
          from: '2026-07-11T00:00:00.000Z',
          to: '2026-07-31T23:59:59.999Z',
        },
        PublicationDispatchProfile.LEGACY_ROUTED,
      ),
    ).rejects.toThrow('Новые публикации создаются только через Публик.');
    expect(publisherPolicyService.resolvePublicationTargets).not.toHaveBeenCalled();
    expect(managedEntitiesService.assertChatAdminAccess).not.toHaveBeenCalled();
  });

  it('keeps LEGACY_ROUTED occurrence authorization on Major while PUBLIK_V1 uses Publisher', async () => {
    const { managedEntitiesService, publisherPolicyService, service } = createService();
    const publication = {
      actorUserId: 'user-1',
      audienceMode: PublicationAudienceMode.SNAPSHOT,
      audienceSelection: PublicationAudienceSelection.SELECTED,
      targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
    };

    await (service as any).resolveOccurrenceTargets({
      ...publication,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
    });
    expect(publisherPolicyService.resolvePublicationTargets).not.toHaveBeenCalled();
    expect(managedEntitiesService.listChats).not.toHaveBeenCalled();

    await (service as any).resolveOccurrenceTargets({
      ...publication,
      dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
    });
    expect(managedEntitiesService.listChats).toHaveBeenCalledTimes(1);
    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledTimes(1);
    expect(publisherPolicyService.resolvePublicationTargets).not.toHaveBeenCalled();
  });

  it('authorizes a PUBLIK_V1 retry through its persisted dispatch profile', async () => {
    const authorizationError = new Error('publisher authorization stopped retry');
    const { service } = createService({
      publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-publik-retry',
          version: 1,
          lifecycle: PublicationLifecycle.ERROR,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
          canonicalContentRevisionId: 'content-1',
          targets: [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
        }),
      },
    });
    const resolvePersisted = jest
      .spyOn(service as any, 'resolvePersistedPublicationTargets')
      .mockRejectedValue(authorizationError);

    await expect(
      service.retryOccurrence(
        'publication-publik-retry',
        'occurrence-1',
        { userId: 'user-1', username: null, displayName: null },
        { requestId: 'retry-publik-auth-001' },
      ),
    ).rejects.toBe(authorizationError);
    expect(resolvePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      [{ targetChatId: 'chat-1', entityType: ChatEntityType.CHAT }],
      PublicationDispatchProfile.PUBLIK_V1,
    );
  });

  it('resolves an expanded ALL audience above the former 500 target limit', async () => {
    const { managedEntitiesService, service } = createService();
    managedEntitiesService.listChats.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => ({
        id: `chat-${index}`,
        entityType: 'chat',
        title: `Чат ${index}`,
        avatarUrl: null,
        link: null,
      })),
    );
    managedEntitiesService.listChannels.mockResolvedValue([]);

    await expect(
      (service as any).resolveAudienceTargets(
        { userId: 'user-1', username: null, displayName: null },
        { selection: 'ALL_CHATS', mode: 'DYNAMIC', targets: [] },
      ),
    ).resolves.toHaveLength(501);
  });

  it('bounds live audience access verification concurrency', async () => {
    const { service, managedEntitiesService } = createService();
    managedEntitiesService.listChats.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `chat-${index}`,
        entityType: 'chat',
        title: `Чат ${index}`,
        avatarUrl: null,
        link: null,
      })),
    );
    managedEntitiesService.listChannels.mockResolvedValue([]);
    let activeChecks = 0;
    let maxActiveChecks = 0;
    managedEntitiesService.assertChatAdminAccess.mockImplementation(async () => {
      activeChecks += 1;
      maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeChecks -= 1;
    });

    await (service as any).resolveAudienceTargets(
      { userId: 'user-1', username: null, displayName: null },
      { selection: 'ALL_CHATS', mode: 'DYNAMIC', targets: [] },
    );

    expect(managedEntitiesService.assertChatAdminAccess).toHaveBeenCalledTimes(8);
    expect(maxActiveChecks).toBe(4);
  });
});
