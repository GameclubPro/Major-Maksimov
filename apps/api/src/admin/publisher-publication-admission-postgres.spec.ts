import { MAX_API_SOURCE_TAGS, MaxApiInternalRateLimitError } from '../max/max-client.service';
import type {
  MaxRoutedPublicationAttemptContext,
  MaxRoutedPublicationRequest,
  MaxRoutedPublicationResult,
} from '../max/max-routed-publication.service';
import { PublicationService } from './publication.service';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublisherDeliveryDeferredError } from './publisher-managed-broadcast-dispatch';
import { randomUUID } from 'node:crypto';
import {
  PrismaClient,
  createPrismaAdapter,
  Prisma,
  type ManagedBroadcastDelivery,
} from '../prisma/prisma-client';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import { PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE } from './publication-dispatch-issue';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';
import { buildClearResolvedPublisherRecipientBlockerQuery } from './publisher-publication-recipient-admission';
import {
  selectNextPendingPublisherPublicationDeadline,
  selectPublicationManagedBroadcastDueBatch,
} from './admin-managed-broadcast-due-selection';
import type { PublisherTemporalSelectionRollout } from './publisher-publication-temporal-enrollment';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(90_000);

const EXPECTED_NATIVE_OCCURRENCE_RESULT_SELECT = {
  status: true,
  sentCount: true,
  cycleCount: true,
  nextSendAt: true,
} as const satisfies Prisma.ManagedBroadcastSelect;
const EXPECTED_NATIVE_FINALIZER_DELIVERY_SELECT = {
  targetChatId: true,
  status: true,
  lastErrorCode: true,
  dispatchBlockerCode: true,
  dispatchBlockedAt: true,
  nextAttemptAt: true,
  sentAt: true,
  remoteMessageId: true,
  remoteMessageVerifiedAt: true,
  remoteMessageVerificationAttemptCount: true,
  remoteMessageVerificationAbsentCount: true,
  remoteMessageVerificationPresentCount: true,
  remoteMessageVerificationAttemptedAt: true,
  remoteMessageVerificationNextAt: true,
  remoteMessageVerificationSource: true,
} as const satisfies Prisma.ManagedBroadcastDeliverySelect;
const nativeProjectionSeam = (runtime: AdminManagedBroadcastRuntime) => ({
  process: runtime['processManagedBroadcastOccurrence'].bind(runtime),
  finalize: runtime['finalizeManagedBroadcastOccurrence'].bind(runtime),
});
type NativeFinalizerRow = Parameters<ReturnType<typeof nativeProjectionSeam>['finalize']>[0];
type NativeFinalizerOptions = Parameters<ReturnType<typeof nativeProjectionSeam>['finalize']>[5];

function projectionGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

integration('Publisher bounded recipient admission on PostgreSQL', () => {
  let db: PrismaClient;
  let competingDb: PrismaClient;
  let chatIds: string[] = [];
  let publicationId: string;
  let ownedPublicationIds: string[] = [];
  let broadcastId: string;
  let occurrenceId: string;
  let actorId: string;
  let runtime: AdminManagedBroadcastRuntime;
  let admission: jest.SpyInstance;
  let temporalSelectionQueryCount = 0;
  const botId = `publisher-admission-${randomUUID()}`;
  const requestActorAccessRefresh = jest.fn().mockResolvedValue(undefined);
  const remoteSend = jest.fn();
  const admittedSends: MaxRoutedPublicationRequest[] = [];
  const runtimeLogger = { warn: jest.fn(), log: jest.fn() };
  const unavailableTargets = new Set<string>();
  const prepareContext = jest.fn(async ({ dialogBotId }: { dialogBotId: string }) => ({
    version: 1,
    dialogBotId,
    buttons: [],
    reference: null,
  }));
  let beforeMutation: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    const client = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
      log: [{ emit: 'event', level: 'query' }],
    });
    client.$on('query', (event) => {
      if (event.query.includes('raw_execution_candidates')) temporalSelectionQueryCount += 1;
    });
    db = client;
    await db.$connect();
    competingDb = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 1, statement_timeout: 10_000 }),
    });
    await competingDb.$connect();
    expect(await db.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone')).toEqual([
      { TimeZone: 'UTC' },
    ]);
  });
  beforeEach(() => {
    requestActorAccessRefresh.mockClear();
    remoteSend.mockClear();
    admittedSends.length = 0;
    runtimeLogger.log.mockClear();
    runtimeLogger.warn.mockClear();
    prepareContext.mockClear();
    unavailableTargets.clear();
    beforeMutation = undefined;
    temporalSelectionQueryCount = 0;
    publicationId = '';
    ownedPublicationIds = [];
  });
  afterEach(async () => {
    if (ownedPublicationIds.length > 0) {
      await db.publicationOccurrence.deleteMany({
        where: { publicationId: { in: ownedPublicationIds } },
      });
      await db.publication.deleteMany({ where: { id: { in: ownedPublicationIds } } });
    }
    for (let offset = 0; offset < chatIds.length; offset += 1_000)
      await db.chat.deleteMany({ where: { id: { in: chatIds.slice(offset, offset + 1_000) } } });
    chatIds = [];
  });
  afterAll(async () => {
    try {
      await competingDb?.$disconnect();
    } finally {
      await db?.$disconnect();
    }
  });

  async function seedProjectionFinalizerSentinels(row: NativeFinalizerRow) {
    await db.managedBroadcastCalendarReservation.create({
      data: {
        broadcastId,
        sourceChatId: chatIds[0]!,
        occurrenceIndex: 1,
        targetChatId: chatIds[0]!,
        scheduledAt: row.nextSendAt!,
      },
    });
    return {
      reservations: await db.managedBroadcastCalendarReservation.findMany({
        where: { broadcastId },
      }),
      occurrences: await db.managedBroadcastOccurrence.findMany({ where: { broadcastId } }),
    };
  }

  async function expectProjectionFinalizerSentinels(
    before: Awaited<ReturnType<typeof seedProjectionFinalizerSentinels>>,
  ) {
    expect(
      await db.managedBroadcastCalendarReservation.findMany({ where: { broadcastId } }),
    ).toEqual(before.reservations);
    expect(await db.managedBroadcastOccurrence.findMany({ where: { broadcastId } })).toEqual(
      before.occurrences,
    );
  }

  function createRuntime(
    publisherTemporalSelectionRollout: PublisherTemporalSelectionRollout = 'off',
    withRealReadiness = false,
  ) {
    const entityReadiness = withRealReadiness
      ? new PublisherReadinessService(
          db as never,
          { read: async () => ({ dispatchEnabled: true }) } as never,
          { get: (key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? botId : true) } as never,
        )
      : null;
    const result = new AdminManagedBroadcastRuntime(
      {
        prisma: db,
        publisherTemporalSelectionRollout,
        logger: runtimeLogger,
        publisherRuntimeBoundaryService: { assertDispatchEnabled: () => undefined },
        publisherDispatchHealthService: {
          assertDispatchAllowed: async () => undefined,
          recordSendSuccess: async () => undefined,
        },
        publisherReadinessService: {
          assertEntityReady: async (chatId: string) => {
            if (unavailableTargets.has(chatId))
              throw new PublisherDeliveryDeferredError('bot_not_admin');
            if (entityReadiness) return entityReadiness.assertEntityReady(chatId, 'publication');
            return { requiredBotId: botId, entityType: 'chat' };
          },
          requestActorAccessRefresh,
        },
        publisherDialogContextService: { prepare: prepareContext },
        maxRoutedPublicationService: {
          publish: async (
            request: MaxRoutedPublicationRequest,
          ): Promise<MaxRoutedPublicationResult> => {
            expect(request.publisherExactBotId).toBe(botId);
            if (
              !request.prepareAttempt ||
              !request.onDispatchAttempt ||
              !request.beforeSendMutation
            )
              throw new Error('Publisher SEND requires preparation, dispatch and final guards');
            const context: MaxRoutedPublicationAttemptContext = {
              botId,
              job: {
                actionType: 'SEND_MESSAGE',
                chatId: request.entityId,
                botId,
                trafficClass: request.trafficClass,
                actionHealthLane: request.actionHealthLane,
                sourceTag: request.sourceTag,
                attempt: 1,
                idempotencyKey: request.logicalIdempotencyKey,
                createdAt: new Date().toISOString(),
              },
            };
            await request.prepareAttempt(context);
            await request.onDispatchAttempt(context);
            await beforeMutation?.();
            await request.beforeSendMutation(context);
            admittedSends.push(request);
            remoteSend(request.entityId);
            return {
              messageId: `synthetic-${request.entityId}`,
              botId,
              url: null,
              candidateBotIds: [botId],
              routingVersion: null,
            };
          },
        },
      } as never,
      'PUBLIK_V1',
    );
    // FLAG: Keep SQL claims, receipt persistence, admission and final authority guards real.
    // Only media rendering, optional URL hydration and the synthetic MAX response are replaced.
    jest
      .spyOn((result as any).mediaRuntime, 'loadManagedBroadcastExecutionMedia')
      .mockResolvedValue({ requestMedia: {} });
    jest
      .spyOn((result as any).mediaRuntime, 'resolveManagedBroadcastExecutionMedia')
      .mockResolvedValue({});
    jest.spyOn((result as any).messageRuntime, 'buildMessage').mockResolvedValue({
      messageText: 'Synthetic admission fixture',
      messageOptions: undefined,
      commentDialogReference: null,
    });
    jest
      .spyOn((result as any).messageRuntime, 'recordDialogReference')
      .mockResolvedValue(undefined);
    jest
      .spyOn((result as any).publicationVerification, 'verifyAfterSend')
      .mockResolvedValue(new Set());
    admission = jest.spyOn((result as any).publisherDispatch, 'deferUnreadyBeforeClaim');
    return result;
  }

  async function fixture(
    size: number,
    blockedHead = 0,
    { temporalNow = false }: { temporalNow?: boolean } = {},
  ) {
    const prefix = `admission-${randomUUID()}`;
    actorId = `${prefix}-actor`;
    const numericTargetBase =
      BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 10)}`) * 1_000_000n;
    chatIds = Array.from({ length: size }, (_, index) =>
      temporalNow
        ? `-${numericTargetBase + BigInt(index) + 1n}`
        : `${prefix}-${String(index).padStart(5, '0')}`,
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
    for (let offset = 0; offset < size; offset += 1_000) {
      const chats = chatIds.slice(offset, offset + 1_000);
      await db.chat.createMany({
        data: chats.map((id) => ({ id, title: 'Synthetic admission fixture' })),
      });
      await db.publisherEntityBinding.createMany({
        data: chats.map(
          (chatId): Prisma.PublisherEntityBindingCreateManyInput => ({
            chatId,
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessCheckedAt: now,
            botAccessExpiresAt: expiresAt,
          }),
        ),
      });
      await db.managedEntityAccessEdge.createMany({
        data: chats.map((chatId, index): Prisma.ManagedEntityAccessEdgeCreateManyInput => {
          const position = offset + index;
          return {
            chatId,
            userId: actorId,
            botId,
            entityType: 'CHAT',
            state: position < blockedHead ? 'USER_DENIED' : 'GRANTED',
            userRole: 'ADMIN',
            botRole: 'ADMIN',
            checkedAt: position < blockedHead ? new Date(now.getTime() - 20 * 60_000) : now,
            expiresAt,
            source: 'publisher_targeted_user_access',
            sourceVersion: `${prefix}-proof-${position}`,
          };
        }),
      });
    }
    const publication = await db.publication.create({
      data: {
        actorUserId: actorId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        ...(temporalNow
          ? {
              audienceMode: 'SNAPSHOT',
              targets: {
                create: chatIds.map((targetChatId, position) => ({
                  targetChatId,
                  entityType: 'CHAT' as const,
                  position,
                })),
              },
            }
          : {}),
        schedule: {
          create: {
            mode: temporalNow ? 'NOW' : 'ONCE',
            status: 'ACTIVE',
            rule: temporalNow
              ? { mode: 'now', timezone: 'Europe/Moscow' }
              : {
                  mode: 'once',
                  timezone: 'Europe/Moscow',
                  at: now.toISOString(),
                  replaceConflicts: false,
                },
          },
        },
        contentRevisions: { create: { revision: 1, text: 'Synthetic admission fixture' } },
      },
      include: { schedule: true, contentRevisions: true },
    });
    publicationId = publication.id;
    ownedPublicationIds.push(publication.id);
    const revision = publication.contentRevisions[0]!.id;
    const occurrence = await db.publicationOccurrence.create({
      data: {
        publicationId,
        scheduleId: publication.schedule!.id,
        contentRevisionId: revision,
        scheduleRevision: 1,
        scheduledAt: now,
        status: 'IN_PROGRESS',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        ...(temporalNow ? { deliveryDeadlineAt: expiresAt } : {}),
      },
    });
    occurrenceId = occurrence.id;
    const broadcast = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatIds[0]!,
        actorUserId: actorId,
        text: 'Synthetic admission fixture',
        targetChatIds: chatIds,
        buttons: [],
        publicationOccurrenceId: occurrenceId,
        publicationContentRevisionId: revision,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        nextSendAt: now,
        scheduleMode: 'calendar',
        occurrences: {
          create: { sourceChatId: chatIds[0]!, occurrenceIndex: 1, scheduledAt: now },
        },
      },
    });
    broadcastId = broadcast.id;
    for (let offset = 0; offset < size; offset += 1_000)
      await db.managedBroadcastDelivery.createMany({
        data: chatIds.slice(offset, offset + 1_000).map(
          (targetChatId): Prisma.ManagedBroadcastDeliveryCreateManyInput => ({
            broadcastId,
            targetChatId,
            occurrenceIndex: 1,
            publicationOccurrenceId: occurrenceId,
            contentRevisionId: revision,
            dispatchProfile: 'PUBLIK_V1',
            requiredBotId: botId,
            dialogBotId: botId,
            publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [] },
            publicationPolicyRevision: 0,
          }),
        ),
      });
    runtime = createRuntime(temporalNow ? '100' : 'off');
  }

  async function olderWaitingPublication(
    mode: 'NOW' | 'ONCE' | 'SLOTS' | 'RECURRENCE' = 'NOW',
    wait: 'capacity' | 'blocker' = 'capacity',
  ): Promise<string> {
    const scheduledAt = new Date(Date.now() - 60_000);
    const publication = await db.publication.create({
      data: {
        actorUserId: actorId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        audienceMode: 'SNAPSHOT',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        targets: { create: { targetChatId: chatIds[0]!, entityType: 'CHAT', position: 0 } },
        schedule: {
          create: { mode, status: 'ACTIVE', rule: { mode: 'now', timezone: 'UTC' } },
        },
        contentRevisions: { create: { revision: 1, text: 'Synthetic future-wait fixture' } },
      },
      include: { schedule: true, contentRevisions: true },
    });
    ownedPublicationIds.push(publication.id);
    const revision = publication.contentRevisions[0]!.id;
    const occurrence = await db.publicationOccurrence.create({
      data: {
        publicationId: publication.id,
        scheduleId: publication.schedule!.id,
        contentRevisionId: revision,
        scheduleRevision: 1,
        scheduledAt,
        status: 'IN_PROGRESS',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        deliveryDeadlineAt: new Date(Date.now() + 86_400_000),
      },
    });
    const waiting = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatIds[0]!,
        actorUserId: actorId,
        targetChatIds: [chatIds[0]!],
        buttons: [],
        publicationOccurrenceId: occurrence.id,
        publicationContentRevisionId: revision,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        nextSendAt: scheduledAt,
        scheduleMode: 'calendar',
        occurrences: {
          create: { sourceChatId: chatIds[0]!, occurrenceIndex: 1, scheduledAt },
        },
        deliveries: {
          create: {
            targetChatId: chatIds[0]!,
            occurrenceIndex: 1,
            publicationOccurrenceId: occurrence.id,
            contentRevisionId: revision,
            dispatchProfile: 'PUBLIK_V1',
            requiredBotId: botId,
            dialogBotId: botId,
            publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [] },
            publicationPolicyRevision: 0,
            ...(wait === 'capacity'
              ? { nextAttemptAt: new Date(Date.now() + 60_000) }
              : { dispatchBlockerCode: 'bot_not_admin', dispatchBlockedAt: new Date() }),
          },
        },
      },
    });
    return waiting.id;
  }

  async function run() {
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { nextSendAt: new Date(Date.now() - 1) },
    });
    return (
      runtime as unknown as {
        processManagedBroadcastOccurrence(...args: unknown[]): Promise<unknown>;
      }
    ).processManagedBroadcastOccurrence(
      broadcastId,
      'deadline',
      new Date(Date.now() - 5 * 60_000),
      ['ACTIVE'],
    );
  }

  it('retains old bot and administrator grants and sends without refreshing rights', async () => {
    await fixture(2);
    await db.managedEntityAccessEdge.updateMany({
      where: { botId, userId: actorId },
      data: { checkedAt: new Date(0), expiresAt: new Date(0) },
    });
    await run();
    expect(remoteSend).toHaveBeenCalledTimes(2);
    expect(requestActorAccessRefresh).not.toHaveBeenCalled();
    const edges = await db.managedEntityAccessEdge.findMany({ where: { botId, userId: actorId } });
    expect(
      edges.every(
        (edge) => edge.state === 'GRANTED' && +edge.checkedAt === 0 && +edge.expiresAt! === 0,
      ),
    ).toBe(true);
  });

  it('persists per-recipient capacity wait across restart and progresses independent recipients', async () => {
    await fixture(2);
    let first = true;
    beforeMutation = async () => {
      if (first) {
        first = false;
        throw new MaxApiInternalRateLimitError('capacity', 30_000);
      }
    };
    await run();
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual([chatIds[1]]);
    const waiting = await db.managedBroadcastDelivery.findFirstOrThrow({
      where: { broadcastId, targetChatId: chatIds[0] },
    });
    expect(waiting).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      capacityDeferralCount: 1,
      waitReason: 'local_capacity',
      remoteMessageId: null,
    });
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    runtime = createRuntime();
    await run();
    expect(remoteSend).toHaveBeenCalledTimes(1);
    // Receipt verification may wake the envelope sooner; it must not bypass the recipient bound.
    const persisted = await db.managedBroadcastDelivery.findUniqueOrThrow({
      where: { id: waiting.id },
    });
    expect(persisted.nextAttemptAt).toEqual(waiting.nextAttemptAt);
    expect(persisted.attemptCount).toBe(0);
    await db.managedBroadcastDelivery.update({
      where: { id: waiting.id },
      data: { nextAttemptAt: new Date(Date.now() - 1) },
    });
    await run();
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual([chatIds[1], chatIds[0]]);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: waiting.id } }),
    ).toMatchObject({ status: 'SENT', attemptCount: 1, waitReason: null, nextAttemptAt: null });
  });

  async function acceptFiniteEntityIntent(mode: 'NOW' | 'ONCE' | 'SLOTS' | 'RECURRENCE') {
    await db.publicationSchedule.updateMany({ where: { publicationId }, data: { mode } });
    const deadline = new Date(Date.now() + 86_400_000);
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { deliveryDeadlineAt: deadline },
    });
    await db.publisherEntityBinding.updateMany({
      where: { publisherBotId: botId, chatId: { in: chatIds } },
      data: {
        permissionsSnapshot: {
          isAdmin: true,
          isOwner: false,
          permissionsKnown: true,
          permissions: ['write'],
        },
      },
    });
    runtime = createRuntime('off', true);
    return deadline;
  }

  it.each(['ONCE', 'SLOTS', 'RECURRENCE'] as const)(
    'sends ready %s work beyond 25 waiting envelopes through real selection, claim and receipt persistence',
    async (mode) => {
      await fixture(1);
      await acceptFiniteEntityIntent(mode);
      const waitingIds: string[] = [];
      for (let index = 0; index < 25; index += 1)
        waitingIds.push(await olderWaitingPublication(mode, index % 2 ? 'blocker' : 'capacity'));
      const before = await db.managedBroadcastDelivery.findMany({
        where: { broadcastId: { in: waitingIds } },
        orderBy: { id: 'asc' },
      });
      const process = jest.spyOn(runtime as any, 'processManagedBroadcastOccurrence');
      await runtime.processDueDeadlinePublicationBroadcasts();
      expect(process.mock.calls[0]?.[0]).toBe(broadcastId);
      expect(remoteSend.mock.calls).toEqual([[chatIds[0]]]);
      expect(requestActorAccessRefresh).not.toHaveBeenCalled();
      expect(
        await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
      ).toMatchObject({
        status: 'SENT',
        attemptCount: 1,
        remoteMessageId: `synthetic-${chatIds[0]}`,
        botId,
      });
      expect(
        await db.managedBroadcastDelivery.findMany({
          where: { broadcastId: { in: waitingIds } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
    },
  );

  it.each(['NOW', 'ONCE', 'SLOTS', 'RECURRENCE'] as const)(
    'delivers accepted finite %s intent independently of the former author and keeps its deadline',
    async (mode) => {
      await fixture(1);
      const deadline = await acceptFiniteEntityIntent(mode);
      await db.managedEntityAccessEdge.updateMany({
        where: { chatId: chatIds[0], userId: actorId, botId },
        data: { state: 'USER_DENIED' },
      });
      beforeMutation = async () => {
        expect(
          await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
        ).toMatchObject({
          status: 'SENDING',
          attemptCount: 1,
          requiredBotId: botId,
          botId,
          remoteMessageId: null,
        });
        await db.managedEntityAccessEdge.deleteMany({
          where: { chatId: chatIds[0], userId: actorId, botId },
        });
      };
      if (mode === 'NOW') await runtime.processDueImmediatePublicationBroadcasts();
      else await runtime.processDueDeadlinePublicationBroadcasts();
      expect(remoteSend).toHaveBeenCalledTimes(1);
      expect(admittedSends).toEqual([
        expect.objectContaining({
          entityId: chatIds[0],
          trafficClass: 'interactive',
          actionHealthLane: mode === 'NOW' ? 'interactive' : 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
          publisherExactBotId: botId,
          hydrateMessageUrl: false,
        }),
      ]);
      expect(requestActorAccessRefresh).not.toHaveBeenCalled();
      expect(
        await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
      ).toMatchObject({
        status: 'SENT',
        attemptCount: 1,
      });
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
      ).toMatchObject({
        deliveryDeadlineAt: deadline,
        retryAuthorizedAt: null,
        retryExpiresAt: null,
      });
    },
  );

  it.each(['bot', 'policy', 'deadline'] as const)(
    'retains the final %s guard for accepted entity intent after a real SQL claim',
    async (change) => {
      await fixture(1);
      await acceptFiniteEntityIntent('SLOTS');
      beforeMutation = async () => {
        if (change === 'bot')
          await db.publisherEntityBinding.updateMany({
            where: { chatId: chatIds[0], publisherBotId: botId },
            data: { botAccessState: 'LOST' },
          });
        if (change === 'policy')
          await db.managedEntityPublicationPolicy.upsert({
            where: { chatId: chatIds[0]! },
            create: { chatId: chatIds[0]!, publikEnabled: false },
            update: { publikEnabled: false },
          });
        if (change === 'deadline')
          await db.publicationOccurrence.update({
            where: { id: occurrenceId },
            data: { deliveryDeadlineAt: new Date(Date.now() - 1) },
          });
      };
      await run();
      expect(admission).toHaveBeenCalledTimes(1);
      expect(remoteSend).not.toHaveBeenCalled();
      if (change === 'deadline') {
        expect(
          await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
        ).toMatchObject({
          status: 'FAILED',
          dispatchBlockerCode: 'PUBLISHER_MISSED_WINDOW_REVIEW',
        });
        expect(
          await db.managedBroadcastDelivery.count({
            where: { broadcastId, status: { in: ['PENDING', 'SENDING'] } },
          }),
        ).toBe(0);
        return;
      }
      expect(
        await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
      ).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        remoteMessageId: null,
      });
    },
  );

  it('does not activate a 53-day-old indefinite NOW intent through entity authority', async () => {
    await fixture(1, 1);
    await db.publicationSchedule.updateMany({ where: { publicationId }, data: { mode: 'NOW' } });
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: {
        scheduledAt: new Date(Date.now() - 53 * 86_400_000),
        deliveryDeadlineAt: null,
        retryAuthorizedAt: null,
        retryExpiresAt: null,
      },
    });
    await run();
    expect(remoteSend).not.toHaveBeenCalled();
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
    ).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
    });
  });

  it('expires new intent before a long rate-limit retry without sending or renewing its deadline', async () => {
    await fixture(1);
    const deadline = new Date(Date.now() + 60_000);
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { deliveryDeadlineAt: deadline },
    });
    beforeMutation = async () => {
      throw Object.assign(new Error('MAX rate limit'), {
        response: { status: 429, headers: { 'retry-after': '7200' } },
      });
    };
    await run();
    expect(remoteSend).not.toHaveBeenCalled();
    const waiting = await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } });
    expect(waiting.status).toBe('PENDING');
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(deadline.getTime());
    expect(
      (await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } })).nextSendAt,
    ).toEqual(new Date(deadline.getTime() + 1));
    // Move only the persisted author deadline to reproduce expiry after worker restart.
    const expired = new Date(Date.now() - 1);
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { deliveryDeadlineAt: expired },
    });
    beforeMutation = undefined;
    runtime = createRuntime();
    await run();
    expect(remoteSend).not.toHaveBeenCalled();
    const terminal = await db.managedBroadcastDelivery.findUniqueOrThrow({
      where: { id: waiting.id },
    });
    expect(terminal.status).toBe('FAILED');
    expect(terminal.lastErrorCode).toBe('PUBLISHER_MISSED_WINDOW_REVIEW');
    expect(terminal.remoteMessageId).toBeNull();
    expect(
      (await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }))
        .deliveryDeadlineAt,
    ).toEqual(expired);
  });

  it.each([100, 1000])(
    'materializes %s targets and recovers one unavailable target without resending receipts',
    async (size) => {
      await fixture(size);
      await db.managedBroadcast.delete({ where: { id: broadcastId } });
      await db.publicationOccurrence.update({
        where: { id: occurrenceId },
        data: { status: 'SCHEDULED', legacyBroadcastId: null },
      });
      const occurrence = await db.publicationOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
        include: { contentRevision: true, publication: true, schedule: true },
      });
      const routing = new PublicationPublisherRoutingService(
        db as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await (PublicationService.prototype as any).createOccurrenceExecution.call(
        {
          prisma: db,
          publisherRouting: routing,
          lockPublicationCalendar: (tx: Prisma.TransactionClient) =>
            tx.$executeRaw(
              Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))`,
            ),
        },
        occurrence,
        chatIds.map((chatId) => ({
          chatId,
          entityType: 'chat',
          title: chatId,
          avatarUrl: null,
          link: null,
        })),
        occurrence.schedule.rule,
      );
      const broadcast = await db.managedBroadcast.findFirstOrThrow({
        where: { publicationOccurrenceId: occurrenceId },
      });
      broadcastId = broadcast.id;
      expect(await db.managedBroadcastDelivery.count({ where: { broadcastId } })).toBe(size);
      expect(prepareContext).not.toHaveBeenCalled();
      unavailableTargets.add(chatIds[0]!);
      runtime = createRuntime();
      for (let page = 0; page < Math.ceil(size / 4) + 1; page++) await run();
      expect(remoteSend).toHaveBeenCalledTimes(size - 1);
      expect(prepareContext).toHaveBeenCalledTimes(size - 1);
      expect(
        await db.managedBroadcastDelivery.findFirstOrThrow({
          where: { broadcastId, targetChatId: chatIds[0]! },
        }),
      ).toMatchObject({ status: 'PENDING', attemptCount: 0, dispatchBlockerCode: 'bot_not_admin' });
      unavailableTargets.clear();
      await db.managedBroadcastDelivery.updateMany({
        where: { broadcastId, status: 'PENDING' },
        data: { dispatchBlockedAt: new Date(Date.now() - 61_000) },
      });
      runtime = createRuntime();
      await run();
      expect(remoteSend).toHaveBeenCalledTimes(size);
      expect(new Set(remoteSend.mock.calls.map((call) => call[0])).size).toBe(size);
      expect(
        await db.managedBroadcastDelivery.count({
          where: { broadcastId, status: 'SENT', attemptCount: 1 },
        }),
      ).toBe(size);
    },
  );

  it('enforces the pending-to-prepared transition in SQL and never claims an unprepared target', async () => {
    await fixture(1);
    const previous = await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } });
    await db.managedBroadcastDelivery.delete({ where: { id: previous.id } });
    const pending = {
      version: 0,
      preparation: 'pending',
      chatId: chatIds[0]!,
      entityType: 'chat',
      dialogBotId: botId,
      customButtons: [],
    };
    const delivery = await db.managedBroadcastDelivery.create({
      data: {
        broadcastId,
        occurrenceIndex: 1,
        targetChatId: chatIds[0]!,
        publicationOccurrenceId: occurrenceId,
        contentRevisionId: previous.contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        dialogBotId: botId,
        publicationPolicyRevision: 0,
        publisherDialogContext: pending,
      },
    });
    await expect(
      db.managedBroadcastDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SENDING', attemptCount: 1 },
      }),
    ).rejects.toThrow('prepared_context_check');
    await expect(
      db.managedBroadcastDelivery.update({
        where: { id: delivery.id },
        data: { publisherDialogContext: { ...pending, chatId: 'wrong' } },
      }),
    ).rejects.toThrow('immutable');
    const prepared = { version: 1, dialogBotId: botId, buttons: [], reference: null };
    await db.managedBroadcastDelivery.update({
      where: { id: delivery.id },
      data: { publisherDialogContext: prepared },
    });
    await expect(
      db.managedBroadcastDelivery.update({
        where: { id: delivery.id },
        data: { publisherDialogContext: pending },
      }),
    ).rejects.toThrow('immutable');
    expect(remoteSend).not.toHaveBeenCalled();
  });

  it('bounds probes to four and sends fresh recipients behind stale/denied heads in a 10,004-chat audience', async () => {
    await fixture(10_004, 4);
    await run();
    expect(admission.mock.calls.map((call) => call[1].targetChatId)).toEqual(chatIds.slice(0, 4));
    expect(requestActorAccessRefresh).toHaveBeenCalledTimes(4);
    expect(remoteSend).not.toHaveBeenCalled();
    const blocked = await db.managedBroadcastDelivery.findMany({
      where: { broadcastId, targetChatId: { in: chatIds.slice(0, 4) } },
    });
    expect(blocked).toHaveLength(4);
    expect(
      blocked.every(
        (delivery) =>
          delivery.status === 'PENDING' &&
          delivery.attemptCount === 0 &&
          delivery.dispatchBlockerCode === PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
      ),
    ).toBe(true);
    runtime = createRuntime();
    await run();
    expect(admission.mock.calls.map((call) => call[1].targetChatId)).toEqual(chatIds.slice(4, 8));
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual(chatIds.slice(4, 8));
    expect(
      await db.managedBroadcastDelivery.count({
        where: { broadcastId, status: 'SENT', attemptCount: 1 },
      }),
    ).toBe(4);
    expect(
      await db.managedBroadcastDelivery.count({ where: { broadcastId, status: 'SENDING' } }),
    ).toBe(0);
    expect(
      await db.managedBroadcastDelivery.count({
        where: { broadcastId, status: 'PENDING', attemptCount: 0 },
      }),
    ).toBe(10_000);
    expect(
      await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } }),
    ).toMatchObject({ status: 'ACTIVE', lockedAt: null, lockToken: null });
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE });
    await db.$executeRawUnsafe('ANALYZE managed_broadcast_deliveries');
    const indexedProbe = async () => {
      const plan = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: unknown }> }>>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        ${buildClearResolvedPublisherRecipientBlockerQuery(occurrenceId, new Date())}
      `);
      const serialized = JSON.stringify(plan);
      expect(serialized).toContain('managed_broadcast_deliveries_pub_pending_blocker_idx');
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
      };
      visit(plan[0]!['QUERY PLAN'][0]!.Plan as Record<string, unknown>);
      const probe = nodes.find(
        (node) => node['Index Name'] === 'managed_broadcast_deliveries_pub_pending_blocker_idx',
      )!;
      expect(Number(probe['Actual Rows'])).toBeLessThanOrEqual(1);
      expect(Number(probe['Actual Loops'])).toBeLessThanOrEqual(1);
      expect(Number(probe['Rows Removed by Filter'] ?? 0)).toBe(0);
    };
    await indexedProbe();
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE });
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId, dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE },
      data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
    });
    await db.$executeRawUnsafe('ANALYZE managed_broadcast_deliveries');
    await indexedProbe();
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ dispatchBlockerCode: null, dispatchBlockedAt: null });
  });

  it('continues recovered author batches promptly and renews denial cooldown without resending receipts', async () => {
    await fixture(12);
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId },
      data: {
        dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
        dispatchBlockedAt: new Date(Date.now() - 61_000),
      },
    });
    await db.managedEntityAccessEdge.updateMany({
      where: { botId, userId: actorId, chatId: { in: chatIds.slice(8) } },
      data: { state: 'USER_DENIED' },
    });
    for (let batch = 0; batch < 3; batch += 1) {
      expect(await selectNextPendingPublisherPublicationDeadline(db as never)).toMatchObject({
        id: broadcastId,
      });
      await run();
    }
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual(chatIds.slice(0, 8));
    expect(requestActorAccessRefresh).toHaveBeenCalledTimes(4);
    expect(await selectNextPendingPublisherPublicationDeadline(db as never)).toBeNull();
    const deliveries = await db.managedBroadcastDelivery.findMany({ where: { broadcastId } });
    expect(
      deliveries.filter((delivery) => delivery.status === 'SENT' && delivery.attemptCount === 1),
    ).toHaveLength(8);
    expect(
      deliveries.filter((delivery) => delivery.status === 'PENDING' && delivery.attemptCount === 0),
    ).toHaveLength(4);
    // A safety poll during the renewed cooldown neither repeats sends nor probes denied authors.
    await run();
    expect(remoteSend).toHaveBeenCalledTimes(8);
    expect(requestActorAccessRefresh).toHaveBeenCalledTimes(4);
  });

  it('recovers a quarantined recipient after healthy recipients while another author remains denied', async () => {
    await fixture(6);
    await db.managedEntityAccessEdge.updateMany({
      where: { botId, userId: actorId, chatId: chatIds[0] },
      data: { state: 'USER_DENIED' },
    });
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId, targetChatId: chatIds[5] },
      data: {
        lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
        updatedAt: new Date(Date.now() - 15 * 60_000),
      },
    });
    await run();
    expect(admission.mock.calls.map((call) => call[1].targetChatId)).toEqual(chatIds.slice(0, 4));
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual(chatIds.slice(1, 4));
    runtime = createRuntime();
    await run();
    expect(admission.mock.calls.map((call) => call[1].targetChatId)).toEqual(chatIds.slice(4, 6));
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual(chatIds.slice(1, 6));
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({
        where: { broadcastId, targetChatId: chatIds[0] },
      }),
    ).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
    });
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({
        where: { broadcastId, targetChatId: chatIds[5] },
      }),
    ).toMatchObject({ status: 'SENT', attemptCount: 1, lastErrorCode: null });
  });

  it('retains the final author guard when MAX revokes authority after admission, without consuming an HTTP attempt', async () => {
    await fixture(1);
    beforeMutation = async () => {
      await db.managedEntityAccessEdge.updateMany({
        where: { chatId: chatIds[0], userId: actorId, botId },
        data: { state: 'USER_DENIED' },
      });
    };
    await run();
    expect(admission).toHaveBeenCalledTimes(1);
    expect(remoteSend).not.toHaveBeenCalled();
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
    ).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
      remoteMessageId: null,
    });
    expect(
      (
        await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } })
      ).nextSendAt!.getTime(),
    ).toBeGreaterThan(Date.now() + 50_000);
  });

  it.each(['revoked_bot', 'canceled_publication'] as const)(
    'preserves the final %s guard after a changed temporal selection and a real SQL claim',
    async (change) => {
      await fixture(1, 0, { temporalNow: true });
      await acceptFiniteEntityIntent('NOW');
      runtime = createRuntime('100', true);
      const waitingId = await olderWaitingPublication();
      const baseline = await selectPublicationManagedBroadcastDueBatch(
        db,
        ['NOW'],
        10,
        'PUBLIK_V1',
        'off',
      );
      expect(baseline.dueRows).toEqual([{ id: waitingId }, { id: broadcastId }]);
      let claimedBeforeGuard: Pick<
        ManagedBroadcastDelivery,
        'status' | 'attemptCount' | 'lockedAt' | 'lockToken' | 'remoteMessageId' | 'sentAt'
      > | null = null;
      const mutateBeforeFinalGuard = jest.fn(async () => {
        claimedBeforeGuard = await db.managedBroadcastDelivery.findFirstOrThrow({
          where: { broadcastId },
          select: {
            status: true,
            attemptCount: true,
            lockedAt: true,
            lockToken: true,
            remoteMessageId: true,
            sentAt: true,
          },
        });
        if (change === 'revoked_bot') {
          await db.publisherEntityBinding.updateMany({
            where: { chatId: chatIds[0], publisherBotId: botId },
            data: { botAccessState: 'LOST' },
          });
        } else {
          await db.publication.update({
            where: { id: publicationId },
            data: { lifecycle: 'CANCELED' },
          });
        }
      });
      beforeMutation = mutateBeforeFinalGuard;

      // FLAG: Use the public global selector and real SQL claim. Revoke only after the
      // owning attempt is prepared, before its final effect guard. The ready publication
      // moves ahead of a real future wait; no MAX request is made on either path.
      await runtime.processDueImmediatePublicationBroadcasts();

      expect(temporalSelectionQueryCount).toBe(1);
      expect(runtimeLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: 'publication_temporal_selection_v1',
          rollout: '100',
          candidates: 2,
          enrolled: 2,
          preferredReturned: 1,
          excludedWaiting: 1,
          fallbackReintroduced: 1,
          comparisonBatches: 1,
          changedDecisionBatches: 1,
          changedPositions: 2,
          newlySelected: 0,
          displaced: 0,
        }),
      );
      expect(admission).toHaveBeenCalledTimes(1);
      expect(mutateBeforeFinalGuard).toHaveBeenCalledTimes(1);
      expect(claimedBeforeGuard).toMatchObject({
        status: 'SENDING',
        attemptCount: 1,
        lockedAt: expect.any(Date),
        lockToken: expect.any(String),
        remoteMessageId: null,
        sentAt: null,
      });
      expect(remoteSend).not.toHaveBeenCalled();
      expect(
        await db.managedBroadcastDelivery.findFirstOrThrow({
          where: { broadcastId: waitingId },
        }),
      ).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        lockedAt: null,
        lockToken: null,
        remoteMessageId: null,
      });
      expect(
        await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
      ).toMatchObject({
        status: change === 'revoked_bot' ? 'PENDING' : 'CANCELED',
        attemptCount: 0,
        lockedAt: null,
        lockToken: null,
        remoteMessageId: null,
        sentAt: null,
        dispatchBlockerCode: change === 'revoked_bot' ? 'bot_not_admin' : null,
      });
      expect(
        (await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).lifecycle,
      ).toBe(change === 'revoked_bot' ? 'ACTIVE' : 'CANCELED');
    },
  );

  it('recovers receipts with expired authority before admission and stops remaining recipients after cancellation', async () => {
    await fixture(6, 6);
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId, targetChatId: chatIds[0] },
      data: {
        status: 'SENDING',
        remoteMessageId: 'synthetic-crash-receipt',
        lockedAt: new Date(Date.now() - 10 * 60_000),
        attemptCount: 1,
      },
    });
    await run();
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({
        where: { broadcastId, targetChatId: chatIds[0] },
      }),
    ).toMatchObject({
      status: 'SENT',
      remoteMessageId: 'synthetic-crash-receipt',
      attemptCount: 1,
    });
    expect(admission).toHaveBeenCalledTimes(4);
    await db.publication.update({ where: { id: publicationId }, data: { lifecycle: 'CANCELED' } });
    admission.mockClear();
    await run();
    expect(admission).not.toHaveBeenCalled();
    expect(remoteSend).not.toHaveBeenCalled();
    expect(
      await db.managedBroadcastDelivery.count({ where: { broadcastId, status: 'SENT' } }),
    ).toBe(1);
    expect(
      await db.managedBroadcastDelivery.count({ where: { broadcastId, status: 'CANCELED' } }),
    ).toBe(5);
  });

  it('clears the shared recipient signal after recovery while preserving explicit retry authorization', async () => {
    await fixture(4, 4);
    const retryAuthorizedAt = new Date();
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: {
        dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
        dispatchBlockedAt: new Date(Date.now() - 120_000),
        retryAuthorizedAt,
      },
    });
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId },
      data: {
        dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
        dispatchBlockedAt: new Date(Date.now() - 120_000),
      },
    });
    await db.managedEntityAccessEdge.updateMany({
      where: { botId, userId: actorId },
      data: { state: 'GRANTED', checkedAt: new Date() },
    });
    await run();
    expect(remoteSend).toHaveBeenCalledTimes(4);
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ dispatchBlockerCode: null, dispatchBlockedAt: null, retryAuthorizedAt });
    for (const dispatchBlockerCode of [
      'PUBLISHER_EXPLICIT_RETRY',
      'PUBLISHER_MISSED_WINDOW_REVIEW',
    ]) {
      await db.publicationOccurrence.update({
        where: { id: occurrenceId },
        data: { dispatchBlockerCode, dispatchBlockedAt: retryAuthorizedAt },
      });
      await db.$executeRaw(
        buildClearResolvedPublisherRecipientBlockerQuery(occurrenceId, new Date()),
      );
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
      ).toMatchObject({
        dispatchBlockerCode,
        dispatchBlockedAt: retryAuthorizedAt,
        retryAuthorizedAt,
      });
    }
  });

  it('reads the native E4 fallback without preparing or sending after a competing claim', async () => {
    await fixture(1);
    const lockedAt = new Date();
    const owner = await competingDb.managedBroadcast.update({
      where: { id: broadcastId },
      data: { lockedAt, lockToken: 'projection-native-current-owner' },
    });
    const envelopeReader = jest.spyOn(db.managedBroadcast, 'findUnique');
    const deliveryReader = jest.spyOn(db.managedBroadcastDelivery, 'findMany');
    try {
      const result = await nativeProjectionSeam(runtime).process(
        broadcastId,
        'deadline',
        new Date(lockedAt.getTime() - 60_000),
        ['ACTIVE'],
      );
      expect(envelopeReader.mock.calls).toEqual([
        [
          {
            where: { id: broadcastId },
            select: EXPECTED_NATIVE_OCCURRENCE_RESULT_SELECT,
          },
        ],
      ]);
      expect(deliveryReader).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 'ACTIVE',
        currentOccurrence: 1,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: owner.nextSendAt,
      });
    } finally {
      envelopeReader.mockRestore();
      deliveryReader.mockRestore();
    }
    expect(await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } })).toEqual(
      owner,
    );
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
    ).toMatchObject({ status: 'PENDING', attemptCount: 0, remoteMessageId: null });
    expect(prepareContext).not.toHaveBeenCalled();
    expect(remoteSend).not.toHaveBeenCalled();
  });

  it.each(['recipient', 'runtime'] as const)(
    'checks the %s cleanup lease without rewriting the envelope heap or updatedAt',
    async (cleanup) => {
      await fixture(1);
      const lockedAt = new Date();
      const row = await db.managedBroadcast.update({
        where: { id: broadcastId },
        data: {
          lockedAt,
          lockToken: 'lease-check-owner',
          updatedAt: new Date(lockedAt.getTime() - 60_000),
        },
      });
      const readHeap = () => db.$queryRaw`
        SELECT xmin::text, ctid::text, updated_at
        FROM managed_broadcasts WHERE id = ${broadcastId}
      `;
      const before = await readHeap();
      const dispatch = runtime['publisherDispatch'];
      const lease = { lockedAt, lockToken: 'lease-check-owner' };
      const result =
        cleanup === 'recipient'
          ? await dispatch.clearResolvedRecipientBlocker(row, lease)
          : await dispatch.ensureRuntimeBoundary(row, 1, lease);

      expect(result).toEqual(cleanup === 'recipient' ? true : { ready: true });
      expect(await readHeap()).toEqual(before);
      expect(await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } })).toEqual(
        row,
      );
      expect(remoteSend).not.toHaveBeenCalled();
    },
  );

  it.each(['recipient', 'runtime'] as const)(
    'rechecks the %s cleanup lease after waiting for a competing owner',
    async (cleanup) => {
      await fixture(1);
      const lockedAt = new Date();
      const row = await db.managedBroadcast.update({
        where: { id: broadcastId },
        data: { lockedAt, lockToken: 'lease-check-before-takeover' },
      });
      const occurrenceBefore = await db.publicationOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
      });
      const deliveriesBefore = await db.managedBroadcastDelivery.findMany({
        where: { broadcastId },
      });
      const entered = projectionGate();
      const release = projectionGate();
      let blockingPid = 0;
      const takeover = competingDb.$transaction(async (tx) => {
        const [owner] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid FROM managed_broadcasts
          WHERE id = ${broadcastId} FOR NO KEY UPDATE
        `;
        blockingPid = owner!.pid;
        entered.resolve();
        await release.promise;
        return tx.managedBroadcast.update({
          where: { id: broadcastId },
          data: { lockedAt: new Date(lockedAt.getTime() + 1), lockToken: 'lease-check-winner' },
        });
      });
      await entered.promise;
      const dispatch = runtime['publisherDispatch'];
      const lease = { lockedAt, lockToken: 'lease-check-before-takeover' };
      const pending =
        cleanup === 'recipient'
          ? dispatch.clearResolvedRecipientBlocker(row, lease)
          : dispatch.ensureRuntimeBoundary(row, 1, lease);
      try {
        const deadline = Date.now() + 3_000;
        let observedWait = false;
        while (Date.now() < deadline && !observedWait) {
          const [sample] = await db.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type = 'Lock'
                AND ${blockingPid} = ANY(pg_blocking_pids(pid))
                AND query LIKE '%storage:publisher_envelope_lease_check%'
            ) AS blocked
          `;
          observedWait = sample!.blocked;
          if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observedWait).toBe(true);
        release.resolve();
        const winner = await takeover;
        expect(await pending).toEqual(
          cleanup === 'recipient' ? false : { ready: false, leaseLost: true, retryAt: null },
        );
        expect(await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } })).toEqual(
          winner,
        );
        expect(
          await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
        ).toEqual(occurrenceBefore);
        expect(await db.managedBroadcastDelivery.findMany({ where: { broadcastId } })).toEqual(
          deliveriesBefore,
        );
        expect(remoteSend).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([takeover, pending]);
      }
    },
  );

  it('keeps the envelope lease probe bounded beside retained broadcast history', async () => {
    await fixture(1);
    const slotIntervalMs = 2 * 3_600_000;
    const latestSlotMs = Math.floor(Date.now() / slotIntervalMs) * slotIntervalMs;
    const history = await db.publication.create({
      data: {
        actorUserId: actorId,
        requestId: randomUUID(),
        lifecycle: 'CANCELED',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        schedule: {
          create: {
            mode: 'RECURRENCE',
            status: 'CANCELED',
            timezone: 'UTC',
            rule: {
              mode: 'recurrence',
              timezone: 'UTC',
              frequency: 'daily',
              interval: 1,
              weekdays: [],
              times: Array.from(
                { length: 12 },
                (_, index) => `${String(index * 2).padStart(2, '0')}:00`,
              ),
              startsAt: new Date(latestSlotMs - 4_096 * slotIntervalMs).toISOString(),
              endsAt: new Date(latestSlotMs).toISOString(),
              maxOccurrences: null,
              replaceConflicts: false,
            },
          },
        },
        contentRevisions: {
          create: { revision: 1, text: 'Synthetic retained lease-probe history' },
        },
      },
      include: { schedule: true, contentRevisions: true },
    });
    ownedPublicationIds.push(history.id);
    const historySlots = Array.from({ length: 4_096 }, (_, index) => ({
      id: randomUUID(),
      scheduledAt: new Date(latestSlotMs - (index + 1) * slotIntervalMs),
    }));
    await db.publicationOccurrence.createMany({
      data: historySlots.map((slot) => ({
        ...slot,
        publicationId: history.id,
        scheduleId: history.schedule!.id,
        scheduleRevision: 1,
        contentRevisionId: history.contentRevisions[0]!.id,
        status: 'CANCELED' as const,
        dispatchProfile: 'PUBLIK_V1' as const,
        requiredBotId: botId,
      })),
    });
    await db.managedBroadcast.createMany({
      data: historySlots.map((slot) => ({
        sourceChatId: chatIds[0]!,
        actorUserId: actorId,
        text: 'Synthetic retained lease-probe history',
        targetChatIds: [],
        buttons: [],
        status: 'CANCELED' as const,
        publicationOccurrenceId: slot.id,
        publicationContentRevisionId: history.contentRevisions[0]!.id,
        dispatchProfile: 'PUBLIK_V1' as const,
        requiredBotId: botId,
      })),
    });
    await db.$executeRaw`ANALYZE managed_broadcasts`;
    const lockedAt = new Date();
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { lockedAt, lockToken: 'lease-check-plan' },
    });
    const query = jest.spyOn(db, '$queryRaw');
    let statement: Prisma.Sql;
    try {
      expect(
        await runtime['publisherDispatch']['lockOwnedBroadcastLease'](db, broadcastId, {
          lockedAt,
          lockToken: 'lease-check-plan',
        }),
      ).toBe(true);
      statement = query.mock.calls[0]![0] as Prisma.Sql;
    } finally {
      query.mockRestore();
    }
    type PlanNode = {
      'Node Type': string;
      'Actual Rows': number;
      'Shared Hit Blocks'?: number;
      'Shared Read Blocks'?: number;
      Plans?: PlanNode[];
    };
    const [result] = await db.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
      ...statement.values,
    );
    const plan = result!['QUERY PLAN'][0]!.Plan;
    const nodes: PlanNode[] = [];
    const walk = (node: PlanNode) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan);
    expect(nodes.some((node) => node['Node Type'] === 'Index Scan')).toBe(true);
    expect(nodes.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
    expect(plan['Actual Rows']).toBe(1);
    expect((plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0)).toBeLessThan(20);
  });

  it('retains native D15 receipts and E4 state when the recipient finalizer lease is lost', async () => {
    await fixture(2);
    const lockedAt = new Date();
    const row = await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { lockedAt, lockToken: 'projection-native-old-owner' },
    });
    const options = {
      lease: { lockedAt, lockToken: 'projection-native-old-owner', lastHeartbeatAt: lockedAt },
    } satisfies NativeFinalizerOptions;
    const receipt = await db.managedBroadcastDelivery.findFirstOrThrow({
      where: { broadcastId, targetChatId: chatIds[0] },
    });
    await db.managedBroadcastDelivery.update({
      where: { id: receipt.id },
      data: {
        status: 'SENT',
        remoteMessageId: 'projection-native-retained-receipt',
        sentAt: lockedAt,
        botId,
        attemptCount: 1,
      },
    });
    const before = await seedProjectionFinalizerSentinels(row);
    const winner = await competingDb.managedBroadcast.update({
      where: { id: broadcastId },
      data: {
        lockedAt: new Date(lockedAt.getTime() + 1),
        lockToken: 'projection-native-new-owner',
      },
    });
    const envelopeReader = jest.spyOn(db.managedBroadcast, 'findUnique');
    const deliveryReader = jest.spyOn(db.managedBroadcastDelivery, 'findMany');
    try {
      const result = await nativeProjectionSeam(runtime).finalize(
        row,
        1,
        [chatIds[0]!],
        [],
        null,
        options,
      );
      expect(deliveryReader.mock.calls).toEqual([
        [
          {
            where: { broadcastId, occurrenceIndex: 1 },
            select: EXPECTED_NATIVE_FINALIZER_DELIVERY_SELECT,
          },
        ],
      ]);
      expect(envelopeReader.mock.calls).toEqual([
        [
          {
            where: { id: broadcastId },
            select: EXPECTED_NATIVE_OCCURRENCE_RESULT_SELECT,
          },
        ],
      ]);
      expect(result).toMatchObject({
        status: 'ACTIVE',
        sentChatIds: [chatIds[0]],
        pendingChatIds: [chatIds[1]],
        canRetry: false,
        nextSendAt: winner.nextSendAt,
      });
    } finally {
      envelopeReader.mockRestore();
      deliveryReader.mockRestore();
    }
    expect(await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } })).toEqual(
      winner,
    );
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: receipt.id } }),
    ).toMatchObject({
      status: 'SENT',
      remoteMessageId: 'projection-native-retained-receipt',
      attemptCount: 1,
      botId,
    });
    await expectProjectionFinalizerSentinels(before);
    expect(remoteSend).not.toHaveBeenCalled();
  });

  it.each([
    { branch: 'pending', status: 'PENDING' },
    { branch: 'failure', status: 'FAILED' },
    { branch: 'completion', status: 'SENT' },
  ] satisfies { branch: string; status: ManagedBroadcastDelivery['status'] }[])(
    'retains native E4/D15 and canceled winner after the $branch finalizer CAS loses',
    async ({ status }) => {
      await fixture(1);
      const lockedAt = new Date();
      const row = await db.managedBroadcast.update({
        where: { id: broadcastId },
        data: { lockedAt, lockToken: 'projection-native-cas-owner' },
      });
      await db.managedBroadcastDelivery.updateMany({
        where: { broadcastId },
        data: {
          status,
          ...(status === 'SENT'
            ? {
                remoteMessageId: 'projection-native-cas-receipt',
                sentAt: lockedAt,
                botId,
                attemptCount: 1,
              }
            : {}),
        },
      });
      const before = await seedProjectionFinalizerSentinels(row);
      const options = {
        lease: { lockedAt, lockToken: 'projection-native-cas-owner', lastHeartbeatAt: lockedAt },
      } satisfies NativeFinalizerOptions;
      const entered = projectionGate();
      const release = projectionGate();
      const dispatch = runtime['publisherDispatch'];
      const prepare = dispatch.prepareRecipientFinalization.bind(dispatch);
      // FLAG: Gate after the actual lease-check transaction commits. The independent
      // client then wins before the unchanged finalizer CAS; no SQL outcome is mocked.
      const prepareGate = jest
        .spyOn(dispatch, 'prepareRecipientFinalization')
        .mockImplementation(
          async (...args: Parameters<typeof prepare>): ReturnType<typeof prepare> => {
            const result = await prepare(...args);
            expect(result.leaseOwned).toBe(true);
            entered.resolve();
            await release.promise;
            return result;
          },
        );
      const envelopeReader = jest.spyOn(db.managedBroadcast, 'findUnique');
      const deliveryReader = jest.spyOn(db.managedBroadcastDelivery, 'findMany');
      const pending = nativeProjectionSeam(runtime).finalize(row, 1, [], [], null, options);
      let winner: NativeFinalizerRow | undefined;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('Finalizer returned before the native CAS gate');
          }),
        ]);
        winner = await competingDb.managedBroadcast.update({
          where: { id: broadcastId },
          data: {
            status: 'CANCELED',
            lockedAt: new Date(lockedAt.getTime() + 1),
            lockToken: 'projection-native-canceled-owner',
            sentCount: 1,
            cycleCount: 2,
            nextSendAt: null,
            lastError: 'Winning native cancellation',
          },
        });
        release.resolve();
        const result = await pending;
        expect(deliveryReader.mock.calls).toEqual([
          [
            {
              where: { broadcastId, occurrenceIndex: 1 },
              select: EXPECTED_NATIVE_FINALIZER_DELIVERY_SELECT,
            },
          ],
        ]);
        expect(envelopeReader.mock.calls).toEqual([
          [
            {
              where: { id: broadcastId },
              select: EXPECTED_NATIVE_OCCURRENCE_RESULT_SELECT,
            },
          ],
        ]);
        expect(result).toMatchObject({
          status: 'CANCELED',
          currentOccurrence: 2,
          canRetry: false,
          nextSendAt: null,
        });
        expect(result.sentChatIds).toEqual(status === 'SENT' ? [chatIds[0]] : []);
        expect(result.failedChatIds).toEqual(status === 'FAILED' ? [chatIds[0]] : []);
        expect(result.pendingChatIds).toEqual(status === 'PENDING' ? [chatIds[0]] : []);
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        prepareGate.mockRestore();
        envelopeReader.mockRestore();
        deliveryReader.mockRestore();
      }
      expect(winner).toBeDefined();
      expect(await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } })).toEqual(
        winner,
      );
      await expectProjectionFinalizerSentinels(before);
      if (status === 'SENT')
        expect(
          await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
        ).toMatchObject({
          status: 'SENT',
          remoteMessageId: 'projection-native-cas-receipt',
          attemptCount: 1,
          botId,
        });
      expect(remoteSend).not.toHaveBeenCalled();
    },
  );
});
