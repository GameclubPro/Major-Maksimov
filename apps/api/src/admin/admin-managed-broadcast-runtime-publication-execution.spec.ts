import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import {
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationDeliveryVerificationSource,
  PublicationDispatchProfile,
  PublicationScheduleMode,
  PublicationScheduleStatus,
  type Prisma,
  type Publication,
  type PublicationTarget,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminManagedBroadcastPublicationVerification } from './admin-managed-broadcast-publication-verification';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import type {
  AdminManagedBroadcastMediaRuntime,
  ManagedBroadcastExecutionMedia,
} from './admin-managed-broadcast-media-runtime';
import { PUBLIK_LEDGER_DISPATCH_MARKER } from './admin-managed-broadcast-ledger-recovery';
import type { ManagedBroadcastCommentDialogReference } from './admin-managed-broadcast-ledger';
import { cancelManagedBroadcastTargetDeliveries } from './admin-managed-broadcast-target-failure';
import { PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE } from './publication-access-loss-recovery';
import { PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE } from './admin.service.support';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';
import { PublisherDeliveryDeferredError } from './publisher-managed-broadcast-dispatch';
import {
  markMaxPreDispatchGuardRejected,
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
} from '../max/max-action-pre-dispatch-guard';
import { MaxApiInternalRateLimitError, type MaxPublishedMessage } from '../max/max-client.service';
import type { MaxRoutedPublicationService } from '../max/max-routed-publication.service';
import type { PublisherPublicationSelectionStore } from './publisher-publication-temporal-selection';

const AUTOMATED_VERIFICATION_DUE_AT = new Date('2026-07-25T08:00:15.000Z');

const EXPECTED_OCCURRENCE_RESULT_SELECT = {
  status: true,
  sentCount: true,
  cycleCount: true,
  nextSendAt: true,
} as const satisfies Prisma.ManagedBroadcastSelect;

const EXPECTED_FINALIZER_DELIVERY_SELECT = {
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

type SelectedOccurrence = Prisma.ManagedBroadcastGetPayload<{
  select: typeof EXPECTED_OCCURRENCE_RESULT_SELECT;
}>;
type SelectedFinalizerDelivery = Prisma.ManagedBroadcastDeliveryGetPayload<{
  select: typeof EXPECTED_FINALIZER_DELIVERY_SELECT;
}>;

const occurrenceProjectionSeam = (runtime: AdminManagedBroadcastRuntime) => ({
  process: runtime['processManagedBroadcastOccurrence'].bind(runtime),
  read: runtime['readManagedBroadcastOccurrenceResult'].bind(runtime),
  finalize: runtime['finalizeManagedBroadcastOccurrence'].bind(runtime),
});
type FinalizerRow = Parameters<ReturnType<typeof occurrenceProjectionSeam>['finalize']>[0];
type FinalizerOptions = Parameters<ReturnType<typeof occurrenceProjectionSeam>['finalize']>[5];

function createFullFinalizerRow(overrides: Partial<FinalizerRow> = {}): FinalizerRow {
  return {
    id: 'broadcast-1',
    sourceChatId: 'chat-source',
    entityType: 'CHAT',
    actorUserId: 'admin-1',
    text: 'Projection finalizer fixture',
    textFormat: 'plain',
    applyToAllChats: false,
    targetChatIds: [],
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Open',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    mediaType: null,
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
    scheduleMode: 'calendar',
    scheduleTimezone: 'UTC',
    nextSendAt: new Date('2026-07-12T10:00:00.000Z'),
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    sentCount: 0,
    status: ManagedBroadcastStatus.ACTIVE,
    lastError: null,
    lockedAt: null,
    lockToken: null,
    publicationOccurrenceId: 'occurrence-1',
    publicationContentRevisionId: 'content-1',
    dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
    requiredBotId: 'publisher-bot',
    createdAt: new Date('2026-07-12T09:00:00.000Z'),
    updatedAt: new Date('2026-07-12T09:00:00.000Z'),
    ...overrides,
  } satisfies FinalizerRow;
}

function selectedFinalizerDelivery(
  targetChatId: string,
  overrides: Partial<Omit<SelectedFinalizerDelivery, 'targetChatId'>> = {},
): SelectedFinalizerDelivery {
  return {
    targetChatId,
    status: overrides.status ?? ManagedBroadcastDeliveryStatus.PENDING,
    lastErrorCode: overrides.lastErrorCode ?? null,
    dispatchBlockerCode: overrides.dispatchBlockerCode ?? null,
    dispatchBlockedAt: overrides.dispatchBlockedAt ?? null,
    nextAttemptAt: overrides.nextAttemptAt ?? null,
    sentAt: overrides.sentAt ?? null,
    remoteMessageId: overrides.remoteMessageId ?? null,
    remoteMessageVerifiedAt: overrides.remoteMessageVerifiedAt ?? null,
    remoteMessageVerificationAttemptCount: overrides.remoteMessageVerificationAttemptCount ?? 0,
    remoteMessageVerificationAbsentCount: overrides.remoteMessageVerificationAbsentCount ?? 0,
    remoteMessageVerificationPresentCount: overrides.remoteMessageVerificationPresentCount ?? 0,
    remoteMessageVerificationAttemptedAt: overrides.remoteMessageVerificationAttemptedAt ?? null,
    remoteMessageVerificationNextAt: overrides.remoteMessageVerificationNextAt ?? null,
    remoteMessageVerificationSource: overrides.remoteMessageVerificationSource ?? null,
  };
}

function selectedOccurrenceReader(broadcastId: string, current: SelectedOccurrence | null) {
  type Delegate = PrismaService['managedBroadcast'];
  const query = {
    where: { id: broadcastId },
    select: EXPECTED_OCCURRENCE_RESULT_SELECT,
  } as const satisfies Prisma.Args<Delegate, 'findUnique'>;
  type Result = Prisma.Result<Delegate, typeof query, 'findUnique'>;
  const findUnique = jest.fn(async (args: typeof query): Promise<Result> => {
    expect(args).toEqual(query);
    if (current)
      expect(Object.keys(current)).toEqual(Object.keys(EXPECTED_OCCURRENCE_RESULT_SELECT));
    return current;
  });
  return { findUnique, query };
}

function selectedFinalizerReader(
  broadcastId: string,
  deliveries: SelectedFinalizerDelivery[],
  occurrenceIndex = 1,
) {
  type Delegate = PrismaService['managedBroadcastDelivery'];
  const query = {
    where: { broadcastId, occurrenceIndex },
    select: EXPECTED_FINALIZER_DELIVERY_SELECT,
  } as const satisfies Prisma.Args<Delegate, 'findMany'>;
  type Result = Prisma.Result<Delegate, typeof query, 'findMany'>;
  const findMany = jest.fn(async (args: typeof query): Promise<Result> => {
    expect(args).toEqual(query);
    for (const delivery of deliveries)
      expect(Object.keys(delivery)).toEqual(Object.keys(EXPECTED_FINALIZER_DELIVERY_SELECT));
    return deliveries;
  });
  return { findMany, query };
}

function createProjectedFinalizerHarness(
  deliveries: SelectedFinalizerDelivery[],
  {
    row = createFullFinalizerRow(),
    current = null,
    updateCount = 1,
  }: { row?: FinalizerRow; current?: SelectedOccurrence | null; updateCount?: number } = {},
) {
  const deliveryReader = selectedFinalizerReader(row.id, deliveries);
  const occurrenceReader = selectedOccurrenceReader(row.id, current);
  const updateMany = jest.fn(
    async (_args: Prisma.ManagedBroadcastUpdateManyArgs): Promise<Prisma.BatchPayload> => ({
      count: updateCount,
    }),
  );
  const occurrenceUpdateMany = jest.fn(
    async (
      _args: Prisma.ManagedBroadcastOccurrenceUpdateManyArgs,
    ): Promise<Prisma.BatchPayload> => ({
      count: 1,
    }),
  );
  const reservationDeleteMany = jest.fn(
    async (
      _args: Prisma.ManagedBroadcastCalendarReservationDeleteManyArgs,
    ): Promise<Prisma.BatchPayload> => ({
      count: 1,
    }),
  );
  const publish = jest.fn(
    async (..._args: Parameters<MaxRoutedPublicationService['publish']>): Promise<never> => {
      throw new Error('Finalization must not dispatch a message');
    },
  );
  const runtime = new AdminManagedBroadcastRuntime({
    prisma: {
      managedBroadcast: { findUnique: occurrenceReader.findUnique, updateMany },
      managedBroadcastDelivery: { findMany: deliveryReader.findMany },
      managedBroadcastOccurrence: { updateMany: occurrenceUpdateMany },
      managedBroadcastCalendarReservation: { deleteMany: reservationDeleteMany },
    },
    maxRoutedPublicationService: { publish },
  } as never);
  return {
    runtime,
    row,
    ...occurrenceProjectionSeam(runtime),
    updateMany,
    occurrenceUpdateMany,
    reservationDeleteMany,
    publish,
    deliveryReader,
    occurrenceReader,
  };
}

function publicationMediaRuntime(
  runtime: AdminManagedBroadcastRuntime,
): AdminManagedBroadcastMediaRuntime {
  return Reflect.get(runtime, 'mediaRuntime') as AdminManagedBroadcastMediaRuntime;
}

function createExecutionMedia(
  row?: Pick<
    Parameters<AdminManagedBroadcastMediaRuntime['loadManagedBroadcastExecutionMedia']>[0],
    'publicationContentRevisionId' | 'actorUserId'
  >,
  mimeTypes: readonly string[] = [],
): ManagedBroadcastExecutionMedia {
  return {
    requestMedia: {
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      images: [],
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
    },
    ...(row?.publicationContentRevisionId
      ? {
          publicationSource: {
            contentRevisionId: row.publicationContentRevisionId,
            actorUserId: row.actorUserId,
            assets: mimeTypes.map((mimeType, index) => ({
              id: `immutable-asset-${index}`,
              actorUserId: row.actorUserId,
              sha256: 'a'.repeat(64),
              sizeBytes: 1,
              mimeType,
              fileName: 'private-file',
              durablePayload: null,
            })),
          },
        }
      : {}),
  };
}

const createPublicationEnvelopeRow = () => ({
  id: 'broadcast-access-check',
  sourceChatId: 'chat-source',
  entityType: 'CHAT',
  actorUserId: 'admin-1',
  applyToAllChats: false,
  targetChatIds: ['chat-target'],
  scheduleMode: 'calendar',
  nextSendAt: new Date('2026-07-12T10:00:00.000Z'),
  cycleCount: 1,
  sentCount: 0,
  status: ManagedBroadcastStatus.ACTIVE,
  publicationOccurrenceId: 'occurrence-access-check',
  publicationContentRevisionId: 'content-access-check',
});

function createPublicationPrismaSendFailureHarness(
  error: Error | null,
  dispatchStarted: boolean,
  dispatchProfile: PublicationDispatchProfile = PublicationDispatchProfile.PUBLIK_V1,
) {
  const row = {
    ...createPublicationEnvelopeRow(),
    id: 'broadcast-prisma-failure',
    text: 'Publication',
    textFormat: 'plain',
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Open',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    mediaType: null,
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
    scheduleTimezone: 'Europe/Moscow',
    cycleEnabled: false,
    cycleEveryHours: 1,
    dispatchProfile,
    requiredBotId: 'publisher-bot',
    publicationOccurrenceId: 'occurrence-prisma-failure',
    publicationContentRevisionId: 'content-prisma-failure',
  };
  const delivery = {
    id: 'delivery-prisma-failure',
    broadcastId: row.id,
    occurrenceIndex: 1,
    targetChatId: 'chat-target',
    botId: null,
    status: ManagedBroadcastDeliveryStatus.PENDING as ManagedBroadcastDeliveryStatus,
    attemptCount: 0,
    remoteMessageId: null,
    lastErrorCode: null,
    lastError: null,
    sentAt: null,
    lockedAt: null,
    lockToken: null,
    dispatchProfile,
    requiredBotId: 'publisher-bot',
    dialogBotId: 'publisher-bot',
    publisherDialogContext: null,
    updatedAt: new Date('2026-09-04T11:59:00.000Z'),
  };
  const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const recoveryBroadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const recoveryDeliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const recoveryDeliveryCount = jest.fn().mockResolvedValue(0);
  const recoveryTx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: row.id }]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    managedBroadcast: { updateMany: recoveryBroadcastUpdateMany },
    managedBroadcastDelivery: {
      updateMany: recoveryDeliveryUpdateMany,
      count: recoveryDeliveryCount,
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const transaction = jest.fn(async (callback) => callback(recoveryTx));
  const publish = jest.fn(
    async (request: any): Promise<MaxPublishedMessage & { botId: string }> => {
      if (dispatchStarted) {
        const context = { botId: 'publisher-bot', job: {} };
        await request.onDispatchAttempt?.(context);
        await request.beforeSendMutation?.(context);
      }
      if (error) {
        throw error;
      }
      return {
        botId: 'publisher-bot',
        messageId: 'mid-known-after-dispatch',
        url: null,
      };
    },
  );
  const resolveMessageLink = jest.fn().mockResolvedValue(null);
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const logger = { log: jest.fn(), warn: jest.fn() };
  const runtime = new AdminManagedBroadcastRuntime(
    {
      prisma: {
        $transaction: transaction,
        auditLog: { create: auditLogCreate },
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
        },
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([delivery]),
          updateMany: deliveryUpdateMany,
        },
      },
      maxClient: { resolveMessageLink },
      maxRoutedPublicationService: { publish },
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      logger,
    } as never,
    dispatchProfile,
  );
  jest
    .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
    .mockResolvedValue(true);
  jest
    .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
    .mockResolvedValue(undefined);
  jest
    .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
    .mockResolvedValue(false);
  jest
    .spyOn((runtime as any).publisherDispatch, 'ensureRuntimeBoundary')
    .mockResolvedValue({ ready: true });
  jest
    .spyOn((runtime as any).publisherDispatch, 'ensureActorAdminAccess')
    .mockResolvedValue({ ready: true });
  jest.spyOn((runtime as any).publisherDispatch, 'deferUnreadyBeforeClaim').mockResolvedValue(null);
  jest
    .spyOn((runtime as any).publisherDispatch, 'assertDeliveryReady')
    .mockResolvedValue(undefined);
  jest.spyOn((runtime as any).publisherDispatch, 'recordFailure').mockResolvedValue('transient');
  jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
    targetMode: 'selected',
    targetChatIds: ['chat-target'],
  });
  jest.spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows').mockResolvedValue([delivery]);
  jest
    .spyOn(publicationMediaRuntime(runtime), 'loadManagedBroadcastExecutionMedia')
    .mockResolvedValue(createExecutionMedia(row));
  jest.spyOn((runtime as any).mediaRuntime, 'resolveManagedBroadcastMedia').mockResolvedValue({});
  jest.spyOn((runtime as any).messageRuntime, 'buildMessage').mockResolvedValue({
    messageText: 'Publication',
    messageOptions: undefined,
    commentDialogReference: null,
  });
  jest
    .spyOn((runtime as any).publicationVerification, 'verifyAfterSend')
    .mockResolvedValue(new Set());
  jest
    .spyOn(runtime as any, 'loadManagedBroadcastLedgerCommentDialogContext')
    .mockResolvedValue({ found: false, reference: null });
  jest
    .spyOn(runtime as any, 'heartbeatManagedBroadcastProcessingLock')
    .mockResolvedValue(undefined);
  jest.spyOn(runtime as any, 'resolveManagedBroadcastSendRetryDelayMs').mockReturnValue(null);
  jest
    .spyOn(runtime as any, 'resolveManagedBroadcastTransientQuarantineMessage')
    .mockResolvedValue(null);
  jest.spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence').mockResolvedValue({
    status: ManagedBroadcastStatus.FAILED,
    currentOccurrence: 1,
    sentChatIds: [],
    failedChatIds: ['chat-target'],
    pendingChatIds: [],
    canRetry: true,
    firstSendError: error,
    nextSendAt: null,
  });

  return {
    runtime,
    row,
    delivery,
    publish,
    transaction,
    broadcastUpdateMany,
    deliveryUpdateMany,
    recoveryBroadcastUpdateMany,
    recoveryDeliveryUpdateMany,
    recoveryDeliveryCount,
    resolveMessageLink,
    auditLogCreate,
    logger,
  };
}

function createPublicationDialogReceiptHarness(options?: {
  includeCommentsButton?: boolean;
  includeSuggestButton?: boolean;
  url?: string | null;
}) {
  const harness = createPublicationPrismaSendFailureHarness(null, false);
  const commentDialogReference: ManagedBroadcastCommentDialogReference = {
    entityType: 'chat',
    threadId: 'thread-publik',
    includeCommentsButton: options?.includeCommentsButton ?? true,
    includeSuggestButton: options?.includeSuggestButton ?? false,
    suggestButtonText: null,
    customButtons: [],
    suggestionEntryMode: null,
    botId: 'publisher-bot',
    dialogBotId: 'publisher-bot',
  };
  jest.spyOn((harness.runtime as any).messageRuntime, 'buildMessage').mockResolvedValue({
    messageText: 'Publication',
    messageOptions: undefined,
    commentDialogReference,
  });
  const recordDialogReference = jest.spyOn(
    (harness.runtime as any).messageRuntime,
    'recordDialogReference',
  );
  harness.publish.mockImplementation(async (request: any) => {
    await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
    return {
      botId: 'publisher-bot',
      messageId: 'mid-known-after-dispatch',
      url: options?.url ?? null,
    };
  });
  return { ...harness, commentDialogReference, recordDialogReference };
}

describe('AdminManagedBroadcastRuntime publication execution guard', () => {
  it('leaves the final outcome to stored receipts when an unknown-error CAS loses', async () => {
    const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const h = createPublicationPrismaSendFailureHarness(error, true);
    h.deliveryUpdateMany.mockImplementation(async (args) => ({
      count: args.data.status === ManagedBroadcastDeliveryStatus.AMBIGUOUS ? 0 : 1,
    }));
    await (h.runtime as any).processManagedBroadcastOccurrence(h.row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect((h.runtime as any).finalizeManagedBroadcastOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ id: h.row.id }),
      1,
      [],
      [],
      null,
      expect.any(Object),
    );
    expect((h.runtime as any).publisherDispatch.recordFailure).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it.each([0, 5])(
    'preserves an unknown SEND after %i earlier attempts without legacy quarantine',
    async (priorAttempts) => {
      const error = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ETIMEDOUT' });
      const h = createPublicationPrismaSendFailureHarness(error, true);
      h.delivery.attemptCount = priorAttempts;
      const quarantine = jest
        .spyOn(h.runtime as any, 'resolveManagedBroadcastTransientQuarantineMessage')
        .mockResolvedValue('Legacy attempt threshold reached');
      await (h.runtime as any).processManagedBroadcastOccurrence(h.row.id, 'deadline', new Date(), [
        ManagedBroadcastStatus.ACTIVE,
      ]);
      expect(h.publish).toHaveBeenCalledTimes(1);
      expect(quarantine).not.toHaveBeenCalled();
      expect(h.deliveryUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: h.delivery.id,
            status: ManagedBroadcastDeliveryStatus.SENDING,
            remoteMessageId: null,
          }),
          data: expect.objectContaining({
            status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
            lockToken: null,
          }),
        }),
      );
      expect(
        h.deliveryUpdateMany.mock.calls.some(
          ([q]) => q.data.status === ManagedBroadcastDeliveryStatus.CANCELED,
        ),
      ).toBe(false);
    },
  );

  it.each([
    [403, 'Forbidden', ManagedBroadcastDeliveryStatus.FAILED],
    [404, 'Chat not found', ManagedBroadcastDeliveryStatus.FAILED],
    [503, 'Chat not accessible', ManagedBroadcastDeliveryStatus.AMBIGUOUS],
  ] as const)(
    'does not manufacture target cancellation from HTTP %i text',
    async (status, message, expected) => {
      const error = Object.assign(new Error(message), { response: { status, data: { message } } });
      const h = createPublicationPrismaSendFailureHarness(error, true);
      await (h.runtime as any).processManagedBroadcastOccurrence(h.row.id, 'deadline', new Date(), [
        ManagedBroadcastStatus.ACTIVE,
      ]);
      expect(h.publish).toHaveBeenCalledTimes(1);
      expect(h.deliveryUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: expected }),
        }),
      );
      expect(
        h.deliveryUpdateMany.mock.calls.some(
          ([q]) => q.data.status === ManagedBroadcastDeliveryStatus.CANCELED,
        ),
      ).toBe(false);
    },
  );

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    {
      profile: PublicationDispatchProfile.PUBLIK_V1,
      reason: 'deadline',
      trafficClass: 'interactive',
    },
    {
      profile: PublicationDispatchProfile.PUBLIK_V1,
      reason: 'immediate',
      trafficClass: 'interactive',
    },
    {
      profile: PublicationDispatchProfile.PUBLIK_V1,
      reason: 'manual_retry',
      trafficClass: 'interactive',
    },
    {
      profile: PublicationDispatchProfile.PUBLIK_V1,
      reason: 'scheduled',
      trafficClass: 'background',
    },
    {
      profile: PublicationDispatchProfile.PUBLIK_V1,
      reason: 'startup',
      trafficClass: 'background',
    },
    {
      profile: PublicationDispatchProfile.LEGACY_ROUTED,
      reason: 'deadline',
      trafficClass: 'background',
    },
  ] as const)(
    'uses $trafficClass admission for a $profile $reason SEND',
    async ({ profile, reason, trafficClass }) => {
      const { runtime, row, publish } = createPublicationPrismaSendFailureHarness(
        null,
        false,
        profile,
      );
      await occurrenceProjectionSeam(runtime).process(row.id, reason, new Date(), [
        ManagedBroadcastStatus.ACTIVE,
      ]);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({ trafficClass, sourceTag: 'managed_broadcast' }),
      );
    },
  );

  it('uses canonical execution media once per exact bot and passes it into media-only send preparation', async () => {
    const { runtime, row, publish } = createPublicationPrismaSendFailureHarness(null, false);
    row.text = '';
    const execution = createExecutionMedia(row, ['image/jpeg']);
    jest
      .spyOn(publicationMediaRuntime(runtime), 'loadManagedBroadcastExecutionMedia')
      .mockResolvedValue(execution);
    const media = { imagePayload: { token: 'canonical-image' } };
    const resolve = jest
      .spyOn(publicationMediaRuntime(runtime), 'resolveManagedBroadcastExecutionMedia')
      .mockResolvedValue(media);
    const legacyResolve = jest.spyOn((runtime as any).mediaRuntime, 'resolveManagedBroadcastMedia');
    const build = jest.spyOn((runtime as any).messageRuntime, 'buildMessage').mockResolvedValue({
      messageText: ' ',
      messageOptions: media,
      commentDialogReference: null,
    });
    publish.mockImplementation(async (request: any) => {
      const first = await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
      const second = await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
      expect(first.text).toBe(' ');
      const expected = {
        ...media,
        marketplacePublication: { purpose: 'PUBLICATION', entityId: request.entityId },
      };
      expect(first.options).toEqual(expected);
      expect(second.options).toEqual(expected);
      return { botId: 'publisher-bot', messageId: 'mid-media-only', url: null };
    });
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        publisherExactBotId: 'publisher-bot',
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'managed_broadcast',
      }),
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe(execution);
    expect(resolve.mock.calls[0]?.[5]).toBe('publisher-bot');
    expect(resolve.mock.calls[0]?.[6]).toEqual({
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'managed_broadcast',
    });
    expect(legacyResolve).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[0]?.[4]).toBe(media);
  });

  it.each([
    ['image/jpeg', 'image'],
    ['video/mp4', 'video'],
  ])(
    'observes frozen %s media with empty canonical row and request fields',
    async (mimeType, media) => {
      const { runtime, row, logger, publish } = createPublicationPrismaSendFailureHarness(
        null,
        false,
      );
      const execution = createExecutionMedia(row, [mimeType]);
      const load = jest
        .spyOn(publicationMediaRuntime(runtime), 'loadManagedBroadcastExecutionMedia')
        .mockResolvedValue(execution);
      expect(row).toMatchObject({ imageEnabled: false, mediaType: null });
      expect(execution.requestMedia).toMatchObject({
        imageEnabled: false,
        images: [],
        mediaType: null,
      });
      await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
        ManagedBroadcastStatus.ACTIVE,
      ]);
      const observations = logger.log.mock.calls.map(([event]) => event);
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: 'initial_recipient_claim', media }),
          expect.objectContaining({ outcome: 'max_acknowledgement_observed', media }),
          expect.objectContaining({ outcome: 'receipt_persisted', media }),
          expect.objectContaining({ stage: 'ledger_observed_to_recipient', media }),
        ]),
      );
      expect(load).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps binary preparation errors marked before message dispatch', async () => {
    const { runtime, row, publish } = createPublicationPrismaSendFailureHarness(null, false);
    const error = new Error('Immutable media is no longer available');
    jest
      .spyOn((runtime as any).mediaRuntime, 'resolveManagedBroadcastExecutionMedia')
      .mockRejectedValue(error);
    publish.mockImplementation(async (request: any) => {
      await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
      throw new Error('Message dispatch must not start after preparation failure');
    });
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(
      (error as Error & { managedBroadcastSendStarted?: boolean }).managedBroadcastSendStarted,
    ).toBe(false);
    expect((runtime as any).messageRuntime.buildMessage).not.toHaveBeenCalled();
  });

  it('observes a receipt only after a winning persistence CAS using the original occurrence clock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-30T10:00:12Z'));
    const { runtime, row, logger, deliveryUpdateMany } = createPublicationPrismaSendFailureHarness(
      null,
      false,
    );
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockImplementation(async (_row, _index, _claim, _stale, onTiming) => {
        if (typeof onTiming === 'function') {
          onTiming(new Date('2026-09-30T10:00:00Z'), {
            mode: 'ONCE',
            intentCreatedAt: new Date('2026-09-30T09:00:00Z'),
          });
        }
        return true;
      });
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    const observations = logger.log.mock.calls.filter(
      ([event]) => event.metric === 'publication_delivery_v1',
    );
    expect(observations.map(([event]) => event.outcome)).toEqual([
      'max_acknowledgement_observed',
      'receipt_persisted',
    ]);
    expect(observations[0]![0]).toMatchObject({ durationMs: 12_000 });
    expect(observations[1]![0]).toMatchObject({
      scope: 'delivery',
      outcome: 'receipt_persisted',
      mode: 'ONCE',
      durationMs: 12_000,
    });
    expect(JSON.stringify(observations)).not.toContain(row.id);
    expect(logger.log.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'publication_wait_v1',
          stage: 'initial_recipient_claim',
          durationMs: 12_000,
        }),
        expect.objectContaining({
          metric: 'publication_wait_v1',
          stage: 'observed_acknowledgement_to_receipt',
          durationMs: 0,
        }),
      ]),
    );
    logger.log.mockClear();
    deliveryUpdateMany.mockImplementation(async ({ data }: any) => ({
      count: data.status === 'SENT' ? 0 : 1,
    }));
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(
      logger.log.mock.calls
        .filter(([event]) => event.metric === 'publication_delivery_v1')
        .map(([event]) => event.outcome),
    ).toEqual(['max_acknowledgement_observed']);
    expect(logger.log.mock.calls.map(([event]) => event)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'observed_acknowledgement_to_receipt' }),
      ]),
    );
    logger.log.mockClear();
    deliveryUpdateMany.mockResolvedValue({ count: 0 });
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(
      logger.log.mock.calls.filter(([event]) => event.metric === 'publication_wait_v1'),
    ).toEqual([]);
  });

  it('opts an ordinary Publik send out of optional message link hydration', async () => {
    const { runtime, row, publish, resolveMessageLink } = createPublicationPrismaSendFailureHarness(
      null,
      false,
    );
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        publisherExactBotId: 'publisher-bot',
        hydrateMessageUrl: false,
      }),
    );
    expect(resolveMessageLink).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'deadline', trafficClass: 'background', fallback: false, suggestions: false },
    { reason: 'deadline', trafficClass: 'background', fallback: true, suggestions: false },
    { reason: 'immediate', trafficClass: 'interactive', fallback: false, suggestions: true },
  ])(
    'hydrates a dialog link after the winning $reason receipt CAS (fallback=$fallback)',
    async ({ reason, trafficClass, fallback, suggestions }) => {
      const {
        runtime,
        row,
        deliveryUpdateMany,
        resolveMessageLink,
        recordDialogReference,
        commentDialogReference,
        auditLogCreate,
      } = createPublicationDialogReceiptHarness({
        includeCommentsButton: !suggestions,
        includeSuggestButton: suggestions,
      });
      const events: string[] = [];
      let receiptWrites = 0;
      deliveryUpdateMany.mockImplementation(async ({ data }: any) => {
        if (data.status === ManagedBroadcastDeliveryStatus.SENT) {
          receiptWrites += 1;
          if (fallback && receiptWrites === 1) {
            events.push('receipt_write_failed');
            throw new Error('temporary receipt write failure');
          }
          events.push('receipt_persisted');
        }
        return { count: 1 };
      });
      resolveMessageLink.mockImplementation(async () => {
        events.push('link_lookup');
        expect(events.at(-2)).toBe('receipt_persisted');
        return 'https://max.ru/channel/mid-known-after-dispatch';
      });
      auditLogCreate.mockImplementation(async () => {
        events.push('reference_recorded');
        return {};
      });

      await (runtime as any).processManagedBroadcastOccurrence(row.id, reason, new Date(), [
        ManagedBroadcastStatus.ACTIVE,
      ]);

      expect(events).toEqual([
        ...(fallback ? ['receipt_write_failed'] : []),
        'receipt_persisted',
        'link_lookup',
        'reference_recorded',
      ]);
      expect(resolveMessageLink).toHaveBeenCalledWith('mid-known-after-dispatch', {
        botId: 'publisher-bot',
        trafficClass,
        actionHealthLane: trafficClass,
        sourceTag: 'managed_broadcast',
      });
      expect(recordDialogReference).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'mid-known-after-dispatch',
          publishedUrl: null,
          publishedUrlRequestOptions: {
            botId: 'publisher-bot',
            trafficClass,
            actionHealthLane: trafficClass,
            sourceTag: 'managed_broadcast',
          },
          reference: commentDialogReference,
        }),
      );
      expect(auditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payload: expect.objectContaining({
              publishedUrl: 'https://max.ru/channel/mid-known-after-dispatch',
            }),
          }),
        }),
      );
    },
  );

  it.each([false, true])(
    'skips optional dialog lookup after a lost receipt CAS (fallback=%s)',
    async (fallback) => {
      const { runtime, row, deliveryUpdateMany, resolveMessageLink, recordDialogReference } =
        createPublicationDialogReceiptHarness();
      let receiptWrites = 0;
      deliveryUpdateMany.mockImplementation(async ({ data }: any) => {
        if (data.status !== ManagedBroadcastDeliveryStatus.SENT) return { count: 1 };
        receiptWrites += 1;
        if (fallback && receiptWrites === 1) throw new Error('temporary receipt write failure');
        return { count: 0 };
      });

      await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
        ManagedBroadcastStatus.ACTIVE,
      ]);

      expect(receiptWrites).toBe(fallback ? 2 : 1);
      expect(resolveMessageLink).not.toHaveBeenCalled();
      expect(recordDialogReference).not.toHaveBeenCalled();
    },
  );

  it('keeps a direct MAX URL without a dialog lookup', async () => {
    const { runtime, row, resolveMessageLink, recordDialogReference } =
      createPublicationDialogReceiptHarness({
        url: 'https://max.ru/channel/direct-receipt',
      });

    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);

    expect(resolveMessageLink).not.toHaveBeenCalled();
    expect(recordDialogReference).toHaveBeenCalledWith(
      expect.objectContaining({ publishedUrl: 'https://max.ru/channel/direct-receipt' }),
    );
  });

  it('skips hydration for a reference with neither comments nor suggestions enabled', async () => {
    const { runtime, row, resolveMessageLink } = createPublicationDialogReceiptHarness({
      includeCommentsButton: false,
      includeSuggestButton: false,
    });

    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);

    expect(resolveMessageLink).not.toHaveBeenCalled();
  });

  it('records a null dialog link after an optional lookup error without changing its receipt', async () => {
    const {
      runtime,
      row,
      logger,
      deliveryUpdateMany,
      resolveMessageLink,
      recordDialogReference,
      auditLogCreate,
    } = createPublicationDialogReceiptHarness();
    resolveMessageLink.mockRejectedValue(new Error('temporary link lookup failure'));

    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);

    expect(recordDialogReference).toHaveBeenCalledWith(
      expect.objectContaining({ publishedUrl: null }),
    );
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    expect(auditLogCreate.mock.calls[0]![0].data.payload).not.toHaveProperty('publishedUrl');
    expect(
      deliveryUpdateMany.mock.calls.filter(
        ([query]) => query.data?.status === ManagedBroadcastDeliveryStatus.SENT,
      ),
    ).toHaveLength(1);
    expect(
      deliveryUpdateMany.mock.calls.some(
        ([query]) => query.data?.status === ManagedBroadcastDeliveryStatus.FAILED,
      ),
    ).toBe(false);
    expect(
      logger.log.mock.calls
        .filter(([event]) => event.metric === 'publication_delivery_v1')
        .map(([event]) => event.outcome),
    ).toEqual(['max_acknowledgement_observed', 'receipt_persisted']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'temporary link lookup failure' }),
      'Managed broadcast comment dialog link lookup failed after persisted send receipt',
    );
  });

  it('undoes its first claim when the final permission guard rejects after route selection', async () => {
    const { runtime, row, publish, deliveryUpdateMany } = createPublicationPrismaSendFailureHarness(
      null,
      false,
    );
    const denied = new PublisherDeliveryDeferredError('bot_access_expired');
    jest
      .spyOn((runtime as any).publisherDispatch, 'assertDeliveryReady')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(denied);
    const externalSend = jest.fn();
    publish.mockImplementation(async (request: any) => {
      const context = { botId: 'publisher-bot', job: {} };
      await request.prepareAttempt(context);
      await request.onDispatchAttempt(context);
      try {
        await request.beforeSendMutation(context);
      } catch (error) {
        throw markMaxPreDispatchGuardRejected(error, MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE);
      }
      return externalSend();
    });
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(externalSend).not.toHaveBeenCalled();
    expect(denied).toMatchObject({ managedBroadcastSendStarted: false });
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'SENDING', lockToken: expect.any(String) }),
        data: expect.objectContaining({ status: 'PENDING', attemptCount: { decrement: 1 } }),
      }),
    );
  });

  it('keeps the first claim unattempted until the final scheduled-window guard passes', async () => {
    const { runtime, row, publish, recoveryDeliveryUpdateMany } =
      createPublicationPrismaSendFailureHarness(null, false);
    let windowExpired = false;
    const observedClaims: Array<{ attemptCount: number; sendAttemptStarted: boolean }> = [];
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockImplementation(async (...args: unknown[]) => {
        const claim = args[2] as { attemptCount: number; sendAttemptStarted: boolean } | undefined;
        if (windowExpired && claim) {
          observedClaims.push({ ...claim });
          return claim.sendAttemptStarted;
        }
        return true;
      });
    const externalSend = jest.fn();
    publish.mockImplementation(async (request: any) => {
      const context = { botId: 'publisher-bot', job: {} };
      await request.prepareAttempt(context);
      await request.onDispatchAttempt(context);
      windowExpired = true;
      await request.beforeSendMutation(context);
      return externalSend();
    });
    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date(),
      [ManagedBroadcastStatus.ACTIVE],
    );
    expect(observedClaims).toEqual([
      expect.objectContaining({ attemptCount: 0, sendAttemptStarted: false }),
    ]);
    expect(externalSend).not.toHaveBeenCalled();
    expect(result.status).toBe(ManagedBroadcastStatus.CANCELED);
    expect(recoveryDeliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELED' }) }),
    );
  });

  it('retains a real earlier attempt when a later inline retry fails its final permission guard', async () => {
    const { runtime, row, publish, deliveryUpdateMany } = createPublicationPrismaSendFailureHarness(
      null,
      false,
    );
    const denied = new PublisherDeliveryDeferredError('bot_access_expired');
    jest
      .spyOn((runtime as any).publisherDispatch, 'assertDeliveryReady')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(denied);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastSendRetryDelayMs').mockReturnValueOnce(0);
    const externalSend = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('attachment.not.ready'), { response: { status: 400 } }),
      );
    publish.mockImplementation(async (request: any) => {
      const context = { botId: 'publisher-bot', job: {} };
      await request.prepareAttempt(context);
      await request.onDispatchAttempt(context);
      try {
        await request.beforeSendMutation(context);
      } catch (error) {
        throw markMaxPreDispatchGuardRejected(error, MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE);
      }
      return externalSend();
    });
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(externalSend).toHaveBeenCalledTimes(1);
    const deferred = deliveryUpdateMany.mock.calls.find(
      ([query]) => query.data.status === 'PENDING',
    );
    expect(deferred?.[0].data).not.toHaveProperty('attemptCount');
    expect(denied).toMatchObject({ managedBroadcastSendStarted: false });
  });

  it.each(['deadline', 'immediate'])(
    'durably defers a %s HTTP 429 without an inline retry before Retry-After',
    async (reason) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-30T10:00:30Z'));
      const error = Object.assign(new Error('Too many requests'), {
        response: { status: 429, headers: { 'retry-after': '7200' } },
      });
      const { runtime, row, publish, recoveryDeliveryUpdateMany } =
        createPublicationPrismaSendFailureHarness(error, true);
      const inlineDelay = jest
        .spyOn(runtime as any, 'resolveManagedBroadcastSendRetryDelayMs')
        .mockReturnValue(0);
      const processing = (runtime as any).processManagedBroadcastOccurrence(
        row.id,
        reason,
        new Date(),
        [ManagedBroadcastStatus.ACTIVE],
      );
      await jest.runAllTimersAsync();
      const result = await processing;
      expect(publish).toHaveBeenCalledTimes(1);
      expect(inlineDelay).not.toHaveBeenCalled();
      const write = recoveryDeliveryUpdateMany.mock.calls.find(
        ([query]) => query.data.waitReason === 'max_rate_limit',
      );
      expect(write?.[0].data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        Date.now() + 7_200_000,
      );
      expect(write?.[0].data).toMatchObject({
        status: 'PENDING',
        rateLimitDeferralCount: { increment: 1 },
      });
      expect((runtime as any).finalizeManagedBroadcastOccurrence).toHaveBeenCalledWith(
        expect.any(Object),
        1,
        expect.any(Array),
        expect.any(Array),
        null,
        expect.objectContaining({ pendingNotBefore: write?.[0].data.nextAttemptAt }),
      );
      expect(result).toBeDefined();
    },
  );

  it.each([
    ManagedBroadcastDeliveryStatus.SENT,
    ManagedBroadcastDeliveryStatus.AMBIGUOUS,
    ManagedBroadcastDeliveryStatus.CANCELED,
    ManagedBroadcastDeliveryStatus.FAILED,
  ])(
    'rolls up a terminal %s Publik delivery without actor access or media preparation',
    async (status) => {
      const { runtime, delivery, row, publish } = createPublicationPrismaSendFailureHarness(
        null,
        false,
      );
      delivery.status = status;
      const loadMedia = jest.spyOn(
        publicationMediaRuntime(runtime),
        'loadManagedBroadcastExecutionMedia',
      );
      loadMedia.mockRejectedValue(new Error('Media no longer available'));
      const actorAccess = jest.spyOn((runtime as any).publisherDispatch, 'ensureActorAdminAccess');
      actorAccess.mockRejectedValue(new Error('Expired access must not block receipt recovery'));
      await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
        ManagedBroadcastStatus.ACTIVE,
      ]);
      expect(actorAccess).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(loadMedia).not.toHaveBeenCalled();
      expect((runtime as any).finalizeManagedBroadcastOccurrence).toHaveBeenCalledTimes(1);
    },
  );

  it('checks only the pending recipients after partial delivery', async () => {
    const { runtime, delivery, row } = createPublicationPrismaSendFailureHarness(null, false);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: ['chat-sent', 'chat-target'],
    });
    jest.spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows').mockResolvedValue([
      {
        ...delivery,
        id: 'sent',
        targetChatId: 'chat-sent',
        status: ManagedBroadcastDeliveryStatus.SENT,
      },
      delivery,
    ]);
    const actorAccess = jest.spyOn((runtime as any).publisherDispatch, 'deferUnreadyBeforeClaim');
    await (runtime as any).processManagedBroadcastOccurrence(row.id, 'deadline', new Date(), [
      ManagedBroadcastStatus.ACTIVE,
    ]);
    expect(actorAccess).toHaveBeenCalledTimes(1);
    expect(actorAccess).toHaveBeenCalledWith(row, delivery, 'publisher-bot', {
      kind: 'publication',
      occurrenceId: row.publicationOccurrenceId,
      contentRevisionId: row.publicationContentRevisionId,
      actorUserId: 'admin-1',
      entityType: 'chat',
    });
  });

  it.each(['P2024', 'P2028'])(
    'releases its exact ACTIVE envelope lease when the post-claim read fails with Prisma %s',
    async (code) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
      const error = Object.assign(new Error(`${code} transient database failure`), { code });
      const broadcastUpdateMany = jest
        .fn()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      const deliveryUpdateMany = jest.fn();
      const publish = jest.fn();
      const logger = { warn: jest.fn() };
      const runtime = new AdminManagedBroadcastRuntime(
        {
          prisma: {
            managedBroadcast: {
              updateMany: broadcastUpdateMany,
              findUnique: jest.fn().mockRejectedValue(error),
            },
            managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
          },
          maxRoutedPublicationService: { publish },
          logger,
        } as never,
        PublicationDispatchProfile.PUBLIK_V1,
      );

      await expect(
        (runtime as any).processManagedBroadcastOccurrence(
          'broadcast-1',
          'deadline',
          new Date('2026-09-04T11:55:00.000Z'),
          [ManagedBroadcastStatus.ACTIVE],
          undefined,
          undefined,
          undefined,
          true,
        ),
      ).rejects.toBe(error);

      expect(broadcastUpdateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            id: 'broadcast-1',
            publicationOccurrenceId: { not: null },
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            status: ManagedBroadcastStatus.ACTIVE,
            lockToken: expect.any(String),
          },
          data: {
            nextSendAt: new Date('2026-09-04T12:00:01.000Z'),
            lockedAt: null,
            lockToken: null,
            lastError: null,
          },
        }),
      );
      expect(deliveryUpdateMany).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(
        broadcastUpdateMany.mock.calls.some(
          ([query]) => query.data?.status === ManagedBroadcastStatus.FAILED,
        ),
      ).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ retryAt: '2026-09-04T12:00:01.000Z' }),
        expect.any(String),
      );
    },
  );

  it.each(['P2024', 'P2028'])(
    'requeues the exact attempt-zero delivery and rethrows Prisma %s before MAX dispatch',
    async (code) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
      const error = Object.assign(new Error(`${code} transient database failure`), { code });
      const harness = createPublicationPrismaSendFailureHarness(error, false);

      await expect(
        (harness.runtime as any).processManagedBroadcastOccurrence(
          harness.row.id,
          'deadline',
          new Date('2026-09-04T11:55:00.000Z'),
          [ManagedBroadcastStatus.ACTIVE],
          undefined,
          undefined,
          undefined,
          true,
        ),
      ).rejects.toBe(error);

      expect(harness.publish).toHaveBeenCalledTimes(1);
      expect(harness.recoveryDeliveryUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: harness.delivery.id,
            status: ManagedBroadcastDeliveryStatus.SENDING,
            attemptCount: 1,
            remoteMessageId: null,
            lockToken: expect.any(String),
          }),
          data: expect.objectContaining({
            status: ManagedBroadcastDeliveryStatus.PENDING,
            attemptCount: { decrement: 1 },
            botId: null,
            lockedAt: null,
            lockToken: null,
          }),
        }),
      );
      expect(harness.recoveryDeliveryCount).not.toHaveBeenCalled();
      expect(harness.recoveryBroadcastUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: harness.row.id,
            status: ManagedBroadcastStatus.ACTIVE,
            lockToken: expect.any(String),
          }),
          data: expect.objectContaining({
            nextSendAt: new Date('2026-09-04T12:00:01.000Z'),
            lockedAt: null,
            lockToken: null,
          }),
        }),
      );
      expect(
        harness.deliveryUpdateMany.mock.calls.some(
          ([query]) => query.data?.status === ManagedBroadcastDeliveryStatus.FAILED,
        ),
      ).toBe(false);
      expect(
        harness.broadcastUpdateMany.mock.calls.some(
          ([query]) => query.data?.status === ManagedBroadcastStatus.FAILED,
        ),
      ).toBe(false);
    },
  );

  it('marks a transient Prisma error ambiguous once MAX dispatch was attempted', async () => {
    const error = Object.assign(new Error('P2024 after dispatch attempt'), { code: 'P2024' });
    const harness = createPublicationPrismaSendFailureHarness(error, true);

    await expect(
      (harness.runtime as any).processManagedBroadcastOccurrence(
        harness.row.id,
        'deadline',
        new Date('2026-09-04T11:55:00.000Z'),
        [ManagedBroadcastStatus.ACTIVE],
        undefined,
        undefined,
        undefined,
        true,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: ManagedBroadcastStatus.FAILED }));

    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.recoveryDeliveryUpdateMany).not.toHaveBeenCalled();
    expect(harness.deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: harness.delivery.id }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
    expect(
      harness.deliveryUpdateMany.mock.calls.some(
        ([query]) => query.data?.status === ManagedBroadcastDeliveryStatus.PENDING,
      ),
    ).toBe(false);
  });

  it('keeps transient Prisma failures on the legacy non-publication delivery path', async () => {
    const error = Object.assign(new Error('P2024 before legacy MAX dispatch'), { code: 'P2024' });
    const harness = createPublicationPrismaSendFailureHarness(error, false);
    (harness.row as any).publicationOccurrenceId = null;
    (harness.row as any).publicationContentRevisionId = null;
    (harness.row as any).dispatchProfile = PublicationDispatchProfile.LEGACY_ROUTED;
    (harness.row as any).requiredBotId = null;
    (harness.delivery as any).dispatchProfile = PublicationDispatchProfile.LEGACY_ROUTED;
    (harness.delivery as any).requiredBotId = null;
    (harness.runtime as any).publicationExecutorProfile = PublicationDispatchProfile.LEGACY_ROUTED;

    await expect(
      (harness.runtime as any).processManagedBroadcastOccurrence(
        harness.row.id,
        'scheduled',
        new Date('2026-09-04T11:55:00.000Z'),
        [ManagedBroadcastStatus.ACTIVE],
      ),
    ).resolves.toEqual(expect.objectContaining({ status: ManagedBroadcastStatus.FAILED }));

    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: harness.delivery.id,
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lockToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.FAILED,
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
  });

  it('releases the exact envelope lease when occurrence finalization hits transient Prisma failure', async () => {
    const error = Object.assign(new Error('P2024 during occurrence finalization'), {
      code: 'P2024',
    });
    const harness = createPublicationPrismaSendFailureHarness(
      new Error('MAX dispatch must not run'),
      false,
    );
    const alreadySentDelivery = {
      ...harness.delivery,
      status: ManagedBroadcastDeliveryStatus.SENT,
      attemptCount: 1,
      remoteMessageId: 'mid-already-sent',
      sentAt: new Date('2026-09-04T11:59:30.000Z'),
    };
    (harness.runtime as any).ensureManagedBroadcastDeliveryRows.mockResolvedValue([
      alreadySentDelivery,
    ]);
    (harness.runtime as any).finalizeManagedBroadcastOccurrence.mockRejectedValue(error);

    await expect(
      (harness.runtime as any).processManagedBroadcastOccurrence(
        harness.row.id,
        'deadline',
        new Date('2026-09-04T11:55:00.000Z'),
        [ManagedBroadcastStatus.ACTIVE],
        undefined,
        undefined,
        undefined,
        true,
      ),
    ).rejects.toBe(error);

    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.recoveryDeliveryUpdateMany).not.toHaveBeenCalled();
    expect(harness.recoveryBroadcastUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: harness.row.id,
          publicationOccurrenceId: harness.row.publicationOccurrenceId,
          status: ManagedBroadcastStatus.ACTIVE,
          lockToken: expect.any(String),
        }),
        data: expect.objectContaining({
          lockedAt: null,
          lockToken: null,
          lastError: null,
        }),
      }),
    );
    expect(
      harness.broadcastUpdateMany.mock.calls.some(
        ([query]) => query.data?.status === ManagedBroadcastStatus.FAILED,
      ),
    ).toBe(false);
  });

  it('preserves a terminal publication status when automatic finalization hits transient Prisma failure', async () => {
    const error = Object.assign(new Error('P2024 during terminal occurrence finalization'), {
      code: 'P2024',
    });
    const harness = createPublicationPrismaSendFailureHarness(
      new Error('MAX dispatch must not run'),
      false,
    );
    (harness.row as any).status = ManagedBroadcastStatus.PARTIAL;
    (harness.delivery as any).status = ManagedBroadcastDeliveryStatus.FAILED;
    (harness.delivery as any).lastError = 'Reviewed terminal delivery failure';
    (harness.runtime as any).finalizeManagedBroadcastOccurrence.mockRejectedValue(error);

    await expect(
      (harness.runtime as any).processManagedBroadcastOccurrence(
        harness.row.id,
        'deadline',
        new Date('2026-09-04T11:55:00.000Z'),
        [ManagedBroadcastStatus.PARTIAL],
        undefined,
        undefined,
        undefined,
        true,
      ),
    ).rejects.toBe(error);

    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.broadcastUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: harness.row.id,
        publicationOccurrenceId: harness.row.publicationOccurrenceId,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        status: ManagedBroadcastStatus.PARTIAL,
        lockToken: expect.any(String),
      },
      data: { lockedAt: null, lockToken: null },
    });
    expect(
      harness.broadcastUpdateMany.mock.calls.some(
        ([query]) => query.data?.status === ManagedBroadcastStatus.FAILED,
      ),
    ).toBe(false);
  });

  it('releases the ACTIVE envelope if known-response recovery finalization also hits Prisma failure', async () => {
    const persistenceError = Object.assign(new Error('P2024 after the known MAX response'), {
      code: 'P2024',
    });
    const finalizationError = Object.assign(new Error('P2028 during recovery finalization'), {
      code: 'P2028',
    });
    const harness = createPublicationPrismaSendFailureHarness(null, true);
    (harness.runtime as any).publicationVerification.persistResponseTargetMismatch = jest
      .fn()
      .mockRejectedValue(persistenceError);
    (harness.runtime as any).finalizeManagedBroadcastOccurrence.mockRejectedValue(
      finalizationError,
    );

    await expect(
      (harness.runtime as any).processManagedBroadcastOccurrence(
        harness.row.id,
        'deadline',
        new Date('2026-09-04T11:55:00.000Z'),
        [ManagedBroadcastStatus.ACTIVE],
        undefined,
        undefined,
        undefined,
        true,
      ),
    ).rejects.toBe(finalizationError);

    expect(harness.publish).toHaveBeenCalledTimes(1);
    expect(harness.deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: harness.delivery.id,
          lockToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.SENT,
          remoteMessageId: 'mid-known-after-dispatch',
          lockedAt: null,
          lockToken: null,
        }),
      }),
    );
    expect(harness.broadcastUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: harness.row.id,
          publicationOccurrenceId: { not: null },
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          status: ManagedBroadcastStatus.ACTIVE,
          lockToken: expect.any(String),
        }),
        data: expect.objectContaining({ lockedAt: null, lockToken: null }),
      }),
    );
    expect(
      harness.deliveryUpdateMany.mock.calls.some(
        ([query]) => query.data?.status === ManagedBroadcastDeliveryStatus.PENDING,
      ),
    ).toBe(false);
  });

  it('persists a structured access-loss code for the current and future target deliveries', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = { managedBroadcastDelivery: { updateMany } };

    await cancelManagedBroadcastTargetDeliveries(prisma as never, 'broadcast-1', 1, {
      targetChatId: 'chat-1',
      currentDeliveryId: 'delivery-1',
      currentDeliveryLockToken: 'delivery-lock-1',
      lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
      lastError: 'chat.denied',
    });

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'delivery-1',
          lockToken: 'delivery-lock-1',
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
        }),
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          broadcastId: 'broadcast-1',
          targetChatId: 'chat-1',
          occurrenceIndex: { gte: 2 },
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
        }),
      }),
    );
  });

  it('persists a MAX send response for another chat as ambiguous', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: { managedBroadcastDelivery: { updateMany } },
      logger: { warn: jest.fn() },
    } as never);
    const sentMessage = {
      messageId: 'mid-1',
      url: null,
      chatId: 'chat-other',
    };

    expect(verification.findResponseTargetMismatch('chat-expected', sentMessage)).toContain(
      'chat-other вместо chat-expected',
    );
    await expect(
      verification.persistResponseTargetMismatch({
        broadcastId: 'broadcast-1',
        occurrenceIndex: 1,
        delivery: { id: 'delivery-1', targetChatId: 'chat-expected' },
        deliveryLockToken: 'lock-1',
        resolvedBotId: 'bot-1',
        sentMessage,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          remoteMessageId: 'mid-1',
        }),
      }),
    );
    expect(
      verification.findResponseTargetMismatch('chat-expected', {
        messageId: 'mid-2',
        url: null,
        chatId: 'chat-expected',
      }),
    ).toBeNull();
  });

  it('keeps the first present observation provisional until the stability window', async () => {
    const delivery = {
      id: 'delivery-verify',
      targetChatId: 'chat-1',
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-verify',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 0,
      remoteMessageVerificationPresentCount: 0,
      remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([delivery]),
          updateMany,
        },
      },
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-verify', presence: 'present' }]),
      },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 0,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
          remoteMessageVerificationLastError: null,
          remoteMessageVerificationSource: null,
        }),
        data: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 1,
          remoteMessageVerificationPresentCount: 1,
          remoteMessageVerificationNextAt: expect.any(Date),
          remoteMessageVerificationSource: null,
          remoteMessageVerifiedAt: null,
        }),
      }),
    );
  });

  it('keeps untouched legacy SENT deliveries out of automatic exact lookup', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'delivery-legacy',
        targetChatId: 'chat-legacy',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-11T08:00:00.000Z'),
        remoteMessageId: 'mid-legacy',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: null,
        remoteMessageVerificationLastError: null,
        remoteMessageVerificationSource: null,
      },
    ]);
    const getExactMessagePresences = jest.fn();
    const updateMany = jest.fn();
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: { managedBroadcastDelivery: { findMany, updateMany } },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-legacy', publicationOccurrenceId: 'occurrence-legacy' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                { remoteMessageVerificationNextAt: { not: null } },
                { remoteMessageVerificationAttemptCount: { gt: 0 } },
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(getExactMessagePresences).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('skips a stale priority delivery after its half-open route has already closed', async () => {
    const budget = { remaining: 2 };
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'selected-delivery',
        broadcastId: 'broadcast-priority',
        occurrenceIndex: 1,
        targetChatId: 'chat-priority',
        botId: 'bot-priority',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: 'mid-priority',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 1,
        remoteMessageVerificationAbsentCount: 1,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: new Date('2026-07-25T08:00:15.000Z'),
        remoteMessageVerificationNextAt: new Date('2026-07-25T08:00:30.000Z'),
        remoteMessageVerificationLastError: null,
        remoteMessageVerificationSource: null,
      },
    ]);
    const getExactMessagePresences = jest.fn();
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: { findMany, updateMany: jest.fn() },
        chatBotMembership: { findMany: jest.fn().mockResolvedValue([]) },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        {
          id: 'broadcast-priority',
          publicationOccurrenceId: 'occurrence-priority',
        } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
        budget,
        ['selected-delivery'],
      ),
    ).resolves.toEqual(new Set());

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['selected-delivery'] } }),
      }),
    );
    expect(budget.remaining).toBe(2);
    expect(getExactMessagePresences).not.toHaveBeenCalled();
  });

  it('confirms a second present observation after the stability window', async () => {
    const sentAt = new Date('2026-07-25T08:00:00.000Z');
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const routeUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executeRaw = jest.fn().mockResolvedValue(1);
    const prisma: any = {
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'delivery-verify',
            targetChatId: 'chat-1',
            botId: 'bot-1',
            status: ManagedBroadcastDeliveryStatus.SENT,
            sentAt,
            remoteMessageId: 'mid-verify',
            remoteMessageVerifiedAt: null,
            remoteMessageVerificationAttemptCount: 1,
            remoteMessageVerificationPresentCount: 1,
          },
        ]),
        updateMany,
      },
      chatBotMembership: { updateMany: routeUpdateMany },
      managedBroadcast: { updateMany: broadcastUpdateMany },
      $executeRaw: executeRaw,
    };
    prisma.$transaction = jest.fn(async (callback) => callback(prisma));
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma,
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-verify', presence: 'present' }]),
      },
      logger: { warn: jest.fn() },
    } as never);

    await verification.verifyAfterSend(
      { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
      1,
      { trafficClass: 'background', sourceTag: 'managed_broadcast' },
      jest.fn().mockResolvedValue(undefined),
    );

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 1,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 1,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
          remoteMessageVerificationSource: null,
        }),
        data: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 2,
          remoteMessageVerificationPresentCount: 2,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationSource: PublicationDeliveryVerificationSource.AUTOMATED_STABLE,
          remoteMessageVerifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(routeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: 'chat-1', botId: 'bot-1' }),
        data: expect.objectContaining({
          sendRouteFailureCount: 0,
          sendRouteQuarantinedUntil: null,
          sendRouteLastSuccessAt: sentAt,
        }),
      }),
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(broadcastUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deliveries: {
            some: expect.objectContaining({ targetChatId: 'chat-1' }),
          },
        }),
        data: { nextSendAt: expect.any(Date) },
      }),
    );
  });

  it('marks repeated stable exact absence ambiguous without quarantining its route', async () => {
    const delivery = {
      id: 'delivery-verify',
      targetChatId: 'chat-1',
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-verify',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 2,
      remoteMessageVerificationAbsentCount: 2,
      remoteMessageVerificationPresentCount: 0,
    };
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const routeUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transaction = jest.fn(async (callback) => callback(prisma));
    const prisma: any = {
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue([delivery]),
        updateMany: deliveryUpdateMany,
      },
      chatBotMembership: { updateMany: routeUpdateMany },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    prisma.$transaction = transaction;
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma,
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-verify', presence: 'absent' }]),
      },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set(['chat-1']));

    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 2,
          remoteMessageVerificationAbsentCount: 2,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          remoteMessageVerificationAttemptCount: 3,
          remoteMessageVerificationAbsentCount: 3,
          remoteMessageVerificationNextAt: null,
          lastError: expect.stringContaining('Нужна ручная проверка'),
        }),
      }),
    );
    const terminalData = deliveryUpdateMany.mock.calls[0]?.[0]?.data;
    expect(terminalData).not.toHaveProperty('remoteMessageId');
    expect(terminalData).not.toHaveProperty('sentAt');
    expect(transaction).not.toHaveBeenCalled();
    expect(routeUpdateMany).not.toHaveBeenCalled();
  });

  it('rolls back a stable verification transition when route-health persistence fails', async () => {
    const delivery = {
      id: 'delivery-verify',
      targetChatId: 'chat-1',
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-verify',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 1,
      remoteMessageVerificationAbsentCount: 0,
      remoteMessageVerificationPresentCount: 1,
    };
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const persistenceError = new Error('route-health write failed');
    const rollback = jest.fn();
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
      chatBotMembership: { updateMany: jest.fn().mockRejectedValue(persistenceError) },
    };
    const transaction = jest.fn(async (callback) => {
      try {
        return await callback(tx);
      } catch (error: unknown) {
        rollback();
        throw error;
      }
    });
    const logger = { warn: jest.fn() };
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        $transaction: transaction,
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([delivery]),
          updateMany: deliveryUpdateMany,
        },
      },
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([{ chatId: 'chat-1', messageId: 'mid-verify', presence: 'present' }]),
      },
      logger,
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: persistenceError.message }),
      'Managed publication verification was deferred after a persistence failure',
    );
  });

  it('bounds inconclusive verification as ambiguous', async () => {
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-verify',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-25T08:00:00.000Z'),
              remoteMessageId: 'mid-verify',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationAttemptCount: 5,
              remoteMessageVerificationAbsentCount: 0,
              remoteMessageVerificationPresentCount: 0,
            },
          ]),
          updateMany: deliveryUpdateMany,
        },
      },
      maxClient: {
        getExactMessagePresences: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            messageId: 'mid-verify',
            error: new Error('MAX API request failed with HTTP 503'),
          },
        ]),
      },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set(['chat-1']));
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 5,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: null,
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          remoteMessageVerificationAttemptCount: 6,
        }),
      }),
    );
  });

  it('persists bounded retry state for an entire bot batch after a transient lookup failure', async () => {
    const deliveries = ['mid-1', 'mid-2'].map((remoteMessageId, index) => ({
      id: `delivery-${index + 1}`,
      targetChatId: `chat-${index + 1}`,
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId,
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
    }));
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const getExactMessagePresences = jest.fn().mockResolvedValue(
      deliveries.map((delivery) => ({
        chatId: delivery.targetChatId,
        messageId: delivery.remoteMessageId,
        error: new Error('MAX API request failed with HTTP 503'),
      })),
    );
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue(deliveries),
          updateMany,
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          remoteMessageVerificationAttemptCount: 1,
          remoteMessageVerificationNextAt: expect.any(Date),
          remoteMessageVerificationLastError: expect.stringContaining('503'),
        }),
      }),
    );
  });

  it('does not attribute one chat verification result to another target with the same message id', async () => {
    const deliveries = [
      {
        id: 'delivery-1',
        targetChatId: 'chat-1',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: 'mid-shared',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      },
      {
        id: 'delivery-2',
        targetChatId: 'chat-2',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:01.000Z'),
        remoteMessageId: 'mid-shared',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      },
    ];
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue(deliveries),
          updateMany,
        },
      },
      maxClient: {
        getExactMessagePresences: jest.fn().mockResolvedValue([
          { chatId: 'chat-1', messageId: 'mid-shared', presence: 'present' },
          {
            chatId: 'chat-2',
            messageId: 'mid-shared',
            error: new Error('MAX returned another recipient'),
          },
        ]),
      },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'delivery-1' }) }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'delivery-2' }) }),
    );
  });

  it('batches ready publication verification by bot', async () => {
    const deliveries = [
      {
        id: 'delivery-1',
        targetChatId: 'chat-1',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: 'mid-1',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      },
      {
        id: 'delivery-2',
        targetChatId: 'chat-2',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:01.000Z'),
        remoteMessageId: 'mid-2',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      },
      {
        id: 'delivery-3',
        targetChatId: 'chat-3',
        botId: 'bot-2',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:02.000Z'),
        remoteMessageId: 'mid-3',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      },
    ];
    const getExactMessagePresences = jest
      .fn()
      .mockImplementation(async (requests: Array<{ chatId: string; messageId: string }>) =>
        requests.map((request) => ({ ...request, presence: 'present' })),
      );
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue(deliveries),
          updateMany,
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(getExactMessagePresences).toHaveBeenCalledTimes(2);
    expect(getExactMessagePresences).toHaveBeenNthCalledWith(
      1,
      [
        { chatId: 'chat-1', messageId: 'mid-1' },
        { chatId: 'chat-2', messageId: 'mid-2' },
      ],
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(getExactMessagePresences).toHaveBeenNthCalledWith(
      2,
      [{ chatId: 'chat-3', messageId: 'mid-3' }],
      expect.objectContaining({ botId: 'bot-2' }),
    );
    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  it('defers verification when the delivery has no recorded bot route', async () => {
    const delivery = {
      id: 'delivery-without-bot',
      targetChatId: 'chat-1',
      botId: null,
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-1',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 0,
      remoteMessageVerificationAbsentCount: 0,
      remoteMessageVerificationPresentCount: 0,
      remoteMessageVerificationAttemptedAt: null,
      remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      remoteMessageVerificationLastError: null,
    };
    const getExactMessagePresences = jest.fn();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([delivery]),
          updateMany,
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());

    expect(getExactMessagePresences).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationLastError: expect.stringContaining('no recorded bot route'),
        }),
      }),
    );
  });

  it('bounds each persisted publication verification batch', async () => {
    const deliveries = Array.from(
      { length: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE + 1 },
      (_, index) => ({
        id: `delivery-${index + 1}`,
        targetChatId: `chat-${index + 1}`,
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date(`2026-07-25T08:00:${String(index).padStart(2, '0')}.000Z`),
        remoteMessageId: `mid-${index + 1}`,
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
        remoteMessageVerificationLastError: null,
      }),
    );
    const findMany = jest.fn(async ({ take }: { take: number }) => deliveries.slice(0, take));
    const getExactMessagePresences = jest
      .fn()
      .mockImplementation(async (requests: Array<{ chatId: string; messageId: string }>) =>
        requests.map((request) => ({ ...request, presence: 'present' })),
      );
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: { managedBroadcastDelivery: { findMany, updateMany } },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await verification.verifyAfterSend(
      { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
      1,
      { trafficClass: 'background', sourceTag: 'managed_broadcast' },
      jest.fn().mockResolvedValue(undefined),
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE }),
    );
    const requestedCount = getExactMessagePresences.mock.calls.reduce(
      (count, [requests]) => count + requests.length,
      0,
    );
    expect(requestedCount).toBe(PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE);
    expect(updateMany).toHaveBeenCalledTimes(PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE);
  });

  it('shares one verification budget across multiple publication envelopes', async () => {
    const makeDeliveries = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-delivery-${index + 1}`,
        targetChatId: `${prefix}-chat-${index + 1}`,
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-25T08:00:00.000Z'),
        remoteMessageId: `${prefix}-mid-${index + 1}`,
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
        remoteMessageVerificationLastError: null,
      }));
    const batches = [makeDeliveries('first', 30), makeDeliveries('second', 30)];
    const requestedTake: number[] = [];
    const findMany = jest.fn(async ({ take }: { take: number }) => {
      requestedTake.push(take);
      return (batches.shift() ?? []).slice(0, take);
    });
    const getExactMessagePresences = jest.fn(
      async (requests: Array<{ chatId: string; messageId: string }>) =>
        requests.map((request) => ({ ...request, presence: 'present' as const })),
    );
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany,
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);
    const budget = { remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE };

    await verification.verifyAfterSend(
      { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
      1,
      { trafficClass: 'background', sourceTag: 'managed_broadcast' },
      jest.fn().mockResolvedValue(undefined),
      budget,
    );
    await verification.verifyAfterSend(
      { id: 'broadcast-2', publicationOccurrenceId: 'occurrence-2' } as never,
      1,
      { trafficClass: 'background', sourceTag: 'managed_broadcast' },
      jest.fn().mockResolvedValue(undefined),
      budget,
    );

    expect(requestedTake).toEqual([PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE, 20]);
    expect(budget.remaining).toBe(0);
    expect(
      getExactMessagePresences.mock.calls.reduce((total, [requests]) => total + requests.length, 0),
    ).toBe(PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE);
  });

  it('defers a verification persistence failure without failing the publication envelope', async () => {
    const persistenceError = new Error('database write unavailable');
    const logger = { warn: jest.fn() };
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-db-error',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-25T08:00:00.000Z'),
              remoteMessageId: 'mid-db-error',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationAttemptCount: 0,
              remoteMessageVerificationAbsentCount: 0,
              remoteMessageVerificationPresentCount: 0,
              remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
            },
          ]),
          updateMany: jest.fn().mockRejectedValue(persistenceError),
        },
      },
      maxClient: {
        getExactMessagePresences: jest
          .fn()
          .mockResolvedValue([
            { chatId: 'chat-1', messageId: 'mid-db-error', presence: 'present' },
          ]),
      },
      logger,
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'database write unavailable' }),
      'Managed publication verification was deferred after a persistence failure',
    );
  });

  it('still propagates a publication lease heartbeat failure from verification', async () => {
    const heartbeatError = new Error('publication lease lost');
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-heartbeat',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-25T08:00:00.000Z'),
              remoteMessageId: 'mid-heartbeat',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
            },
          ]),
        },
      },
      maxClient: { getExactMessagePresences: jest.fn() },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockRejectedValue(heartbeatError),
      ),
    ).rejects.toBe(heartbeatError);
  });

  it('does not overwrite a concurrent verification observation from a stale snapshot', async () => {
    const persistedDelivery: Record<string, any> = {
      id: 'delivery-race',
      targetChatId: 'chat-1',
      botId: 'bot-1',
      status: ManagedBroadcastDeliveryStatus.SENT,
      sentAt: new Date('2026-07-25T08:00:00.000Z'),
      remoteMessageId: 'mid-race',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 0,
      remoteMessageVerificationAbsentCount: 0,
      remoteMessageVerificationPresentCount: 0,
      remoteMessageVerificationAttemptedAt: null,
      remoteMessageVerificationNextAt: AUTOMATED_VERIFICATION_DUE_AT,
      remoteMessageVerificationLastError: null,
    };
    let verificationReadCount = 0;
    let releaseVerificationReads!: () => void;
    const verificationReadsReady = new Promise<void>((resolve) => {
      releaseVerificationReads = resolve;
    });
    const findMany = jest.fn(async () => {
      const snapshot = { ...persistedDelivery };
      verificationReadCount += 1;
      if (verificationReadCount === 2) {
        releaseVerificationReads();
      }
      await verificationReadsReady;
      return [snapshot];
    });
    let maxLookupCount = 0;
    let releaseStaleLookup!: () => void;
    const firstObservationPersisted = new Promise<void>((resolve) => {
      releaseStaleLookup = resolve;
    });
    const getExactMessagePresences = jest.fn(async () => {
      maxLookupCount += 1;
      if (maxLookupCount === 1) {
        return [{ chatId: 'chat-1', messageId: 'mid-race', presence: 'present' }];
      }
      await firstObservationPersisted;
      return [{ chatId: 'chat-1', messageId: 'mid-race', presence: 'absent' }];
    });
    const verificationStateFields = [
      'remoteMessageVerificationAttemptCount',
      'remoteMessageVerificationAbsentCount',
      'remoteMessageVerificationPresentCount',
      'remoteMessageVerificationAttemptedAt',
      'remoteMessageVerificationNextAt',
      'remoteMessageVerificationLastError',
    ] as const;
    const normalizeCasValue = (value: unknown): unknown =>
      value instanceof Date ? value.getTime() : value;
    const updateMany = jest.fn(async ({ where, data }: Record<string, any>) => {
      const matchesSnapshot =
        where.id === persistedDelivery.id &&
        where.status === persistedDelivery.status &&
        where.remoteMessageId === persistedDelivery.remoteMessageId &&
        where.remoteMessageVerifiedAt === persistedDelivery.remoteMessageVerifiedAt &&
        verificationStateFields.every(
          (field) =>
            normalizeCasValue(where[field]) === normalizeCasValue(persistedDelivery[field]),
        );
      if (!matchesSnapshot) {
        return { count: 0 };
      }
      Object.assign(persistedDelivery, data);
      releaseStaleLookup();
      return { count: 1 };
    });
    const logger = { warn: jest.fn() };
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: { managedBroadcastDelivery: { findMany, updateMany } },
      maxClient: { getExactMessagePresences },
      logger,
    } as never);
    const verify = () =>
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      );

    await expect(Promise.all([verify(), verify()])).resolves.toEqual([new Set(), new Set()]);

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(persistedDelivery).toEqual(
      expect.objectContaining({
        remoteMessageVerificationAttemptCount: 1,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 1,
        remoteMessageVerificationLastError: null,
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not wait inside the delivery loop for a recently sent publication', async () => {
    const getExactMessagePresences = jest.fn();
    const updateMany = jest.fn();
    const onProgress = jest.fn().mockResolvedValue(undefined);
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-recent',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date(),
              remoteMessageId: 'mid-recent',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: new Date(Date.now() + 15_000),
            },
          ]),
          updateMany,
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        onProgress,
      ),
    ).resolves.toEqual(new Set());

    expect(getExactMessagePresences).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('skips a verification attempt until its persisted retry time is due', async () => {
    const nextVerificationAt = new Date(Date.now() + 60_000);
    const getExactMessagePresences = jest.fn();
    const updateMany = jest.fn();
    const verification = new AdminManagedBroadcastPublicationVerification({
      prisma: {
        managedBroadcastDelivery: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-deferred',
              targetChatId: 'chat-1',
              botId: 'bot-1',
              status: ManagedBroadcastDeliveryStatus.SENT,
              sentAt: new Date('2026-07-25T08:00:00.000Z'),
              remoteMessageId: 'mid-deferred',
              remoteMessageVerifiedAt: null,
              remoteMessageVerificationNextAt: nextVerificationAt,
            },
          ]),
          updateMany,
        },
      },
      maxClient: { getExactMessagePresences },
      logger: { warn: jest.fn() },
    } as never);

    await expect(
      verification.verifyAfterSend(
        { id: 'broadcast-1', publicationOccurrenceId: 'occurrence-1' } as never,
        1,
        { trafficClass: 'background', sourceTag: 'managed_broadcast' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual(new Set());
    expect(getExactMessagePresences).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('restores publication attribution when recovering missing delivery rows', async () => {
    const recoveredDelivery = {
      id: 'delivery-recovered',
      broadcastId: 'broadcast-1',
      occurrenceIndex: 1,
      targetChatId: 'chat-1',
      status: ManagedBroadcastDeliveryStatus.PENDING,
      publicationOccurrenceId: 'occurrence-1',
      contentRevisionId: 'content-1',
    };
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([recoveredDelivery]);
    const prisma = {
      managedBroadcastDelivery: {
        count: jest.fn().mockResolvedValue(0),
        createMany,
        findMany,
      },
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    await expect(
      (runtime as any).ensureManagedBroadcastDeliveryRows(
        {
          id: 'broadcast-1',
          cycleCount: 1,
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-1',
        },
        1,
        ['chat-1'],
        [],
      ),
    ).resolves.toEqual([recoveredDelivery]);

    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          targetChatId: 'chat-1',
          status: ManagedBroadcastDeliveryStatus.PENDING,
          publicationOccurrenceId: 'occurrence-1',
          contentRevisionId: 'content-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('runs priority half-open verification without sending a pending sibling', async () => {
    const now = new Date('2026-08-07T15:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const sentAt = new Date('2026-08-07T14:49:00.000Z');
      const row = {
        id: 'half-open-broadcast',
        sourceChatId: 'source-chat',
        entityType: 'CHANNEL',
        actorUserId: 'admin-1',
        text: 'Publication',
        textFormat: 'plain',
        applyToAllChats: false,
        targetChatIds: ['half-open-chat', 'pending-chat'],
        buttons: [],
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Open',
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        mediaType: null,
        mediaPayload: null,
        mediaMimeType: '',
        mediaFileName: '',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Europe/Moscow',
        nextSendAt: new Date('2026-08-07T20:47:00.000Z'),
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
        sentCount: 0,
        status: ManagedBroadcastStatus.ACTIVE,
        lastError: null,
        lockedAt: null,
        lockToken: null,
        publicationOccurrenceId: 'occurrence-1',
        publicationContentRevisionId: 'content-1',
      };
      const sentDelivery = {
        id: 'sent-delivery',
        broadcastId: row.id,
        occurrenceIndex: 1,
        targetChatId: 'half-open-chat',
        botId: 'bot-1',
        status: ManagedBroadcastDeliveryStatus.SENT,
        attemptCount: 1,
        remoteMessageId: 'message-1',
        remoteMessageVerifiedAt: null,
        remoteMessageVerificationAttemptCount: 0,
        remoteMessageVerificationAbsentCount: 0,
        remoteMessageVerificationPresentCount: 0,
        remoteMessageVerificationAttemptedAt: null,
        remoteMessageVerificationNextAt: new Date('2026-08-07T14:49:15.000Z'),
        remoteMessageVerificationLastError: null,
        remoteMessageVerificationSource: null,
        legacySentWithoutRemoteId: false,
        lastErrorCode: null,
        lastError: null,
        sentAt,
        lockedAt: null,
        lockToken: null,
      };
      const pendingDelivery = {
        ...sentDelivery,
        id: 'pending-delivery',
        targetChatId: 'pending-chat',
        botId: null,
        status: ManagedBroadcastDeliveryStatus.PENDING,
        attemptCount: 0,
        remoteMessageId: null,
        remoteMessageVerificationNextAt: null,
        sentAt: null,
      };
      const olderSentSibling = {
        ...sentDelivery,
        id: 'older-sent-delivery',
        targetChatId: 'older-chat',
        remoteMessageId: 'older-message',
        sentAt: new Date('2026-08-07T14:40:00.000Z'),
      };
      const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const deliveryFindMany = jest
        .fn()
        .mockImplementation(async ({ where }: any) =>
          where.status === ManagedBroadcastDeliveryStatus.SENT
            ? [olderSentSibling, sentDelivery]
            : [sentDelivery, pendingDelivery],
        );
      const publish = jest.fn();
      const getExactMessagePresences = jest.fn().mockResolvedValue([
        {
          chatId: sentDelivery.targetChatId,
          messageId: sentDelivery.remoteMessageId,
          presence: 'present',
        },
      ]);
      const verificationBudget = { remaining: 4 };
      const runtime = new AdminManagedBroadcastRuntime({
        prisma: {
          $queryRaw: jest.fn().mockResolvedValue([{ id: row.id, deliveryId: sentDelivery.id }]),
          managedBroadcast: {
            updateMany: broadcastUpdateMany,
            findUnique: jest.fn().mockResolvedValue(row),
            findMany: jest.fn().mockResolvedValue([]),
          },
          managedBroadcastDelivery: {
            findMany: deliveryFindMany,
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          chatBotMembership: {
            findMany: jest.fn().mockResolvedValue([
              {
                chatId: sentDelivery.targetChatId,
                botId: sentDelivery.botId,
                sendRouteLastFailureAt: new Date('2026-08-07T14:48:00.000Z'),
              },
            ]),
          },
          managedBroadcastOccurrence: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        },
        maxClient: { getExactMessagePresences },
        maxRoutedPublicationService: { publish },
        logger: { log: jest.fn(), warn: jest.fn() },
      } as never);
      const targetResolutionSpy = jest.spyOn(
        runtime as any,
        'resolveManagedBroadcastTargetsFromRow',
      );
      const mediaSpy = jest.spyOn(
        publicationMediaRuntime(runtime),
        'loadManagedBroadcastExecutionMedia',
      );
      const sendSpy = jest.spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId');

      const result = await runtime.processDueImmediatePublicationBroadcasts(verificationBudget);

      expect(result).toBe(verificationBudget);
      expect(verificationBudget.remaining).toBe(3);
      expect(getExactMessagePresences).toHaveBeenCalledWith(
        [{ chatId: 'half-open-chat', messageId: 'message-1' }],
        expect.objectContaining({
          botId: 'bot-1',
          trafficClass: 'background',
          sourceTag: 'managed_broadcast',
        }),
      );
      expect(deliveryFindMany.mock.calls[0]?.[0]?.where.id).toEqual({
        in: [sentDelivery.id],
      });
      expect(broadcastUpdateMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('nextSendAt');
      expect(targetResolutionSpy).not.toHaveBeenCalled();
      expect(mediaSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(deliveryFindMany).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers priority verification infrastructure errors without failing the envelope', async () => {
    const row = {
      id: 'half-open-broadcast',
      sourceChatId: 'source-chat',
      nextSendAt: new Date('2026-08-07T20:47:00.000Z'),
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      publicationOccurrenceId: 'occurrence-1',
      publicationContentRevisionId: 'content-1',
    };
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const publish = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $queryRaw: jest.fn().mockResolvedValue([{ id: row.id, deliveryId: 'selected-delivery' }]),
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
          findMany: jest.fn().mockResolvedValue([]),
        },
        managedBroadcastDelivery: {
          findMany: jest.fn().mockRejectedValue(new Error('database unavailable')),
        },
      },
      maxRoutedPublicationService: { publish },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    await expect(
      runtime.processDueImmediatePublicationBroadcasts({ remaining: 2 }),
    ).resolves.toEqual({ remaining: 2 });

    expect(broadcastUpdateMany).toHaveBeenCalledTimes(2);
    expect(broadcastUpdateMany.mock.calls[1]?.[0]?.data).toEqual({
      lockedAt: null,
      lockToken: null,
    });
    expect(
      broadcastUpdateMany.mock.calls.some(
        ([request]) => request.data?.status === ManagedBroadcastStatus.FAILED,
      ),
    ).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not select priority verifications after the shared exact-read budget is exhausted', async () => {
    const queryRaw = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $queryRaw: queryRaw,
        managedBroadcast: { findMany: jest.fn().mockResolvedValue([]) },
      },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);

    await expect(
      runtime.processDueImmediatePublicationBroadcasts({ remaining: 0 }),
    ).resolves.toEqual({ remaining: 0 });

    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('continues the immediate pass when priority verification selection fails', async () => {
    const immediateFindMany = jest.fn().mockResolvedValue([]);
    const warn = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $queryRaw: jest.fn().mockRejectedValue(new Error('priority selector unavailable')),
        managedBroadcast: { findMany: immediateFindMany },
      },
      logger: { log: jest.fn(), warn },
    } as never);

    await expect(runtime.processDueImmediatePublicationBroadcasts()).resolves.toEqual({
      remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
    });

    expect(immediateFindMany).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      { err: 'priority selector unavailable' },
      'Priority half-open publication verification was deferred',
    );
  });

  it('only unlocks when a selected delivery belongs to an occurrence that already advanced', async () => {
    const futureNextSendAt = new Date('2026-08-08T12:00:00.000Z');
    const row = {
      id: 'advanced-broadcast',
      sourceChatId: 'source-chat',
      nextSendAt: futureNextSendAt,
      cycleCount: 2,
      sentCount: 1,
      status: ManagedBroadcastStatus.ACTIVE,
      publicationOccurrenceId: 'occurrence-2',
      publicationContentRevisionId: 'content-2',
    };
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryFindMany = jest.fn().mockResolvedValue([]);
    const publish = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        $queryRaw: jest
          .fn()
          .mockResolvedValue([{ id: row.id, deliveryId: 'occurrence-1-delivery' }]),
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
          findMany: jest.fn().mockResolvedValue([]),
        },
        managedBroadcastDelivery: { findMany: deliveryFindMany },
      },
      maxRoutedPublicationService: { publish },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    await runtime.processDueImmediatePublicationBroadcasts({ remaining: 2 });

    expect(deliveryFindMany).toHaveBeenCalledTimes(1);
    expect(deliveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          occurrenceIndex: 2,
          id: { in: ['occurrence-1-delivery'] },
        }),
      }),
    );
    expect(broadcastUpdateMany.mock.calls[1]?.[0]?.data).toEqual({
      lockedAt: null,
      lockToken: null,
    });
    expect(
      broadcastUpdateMany.mock.calls.some(([request]) => request.data?.nextSendAt !== undefined),
    ).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['immediate', 'deadline'] as const)(
    'yields a slow Publisher %s sweep between durable attempts',
    async (lane) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-27T10:00:00Z'));
      try {
        const selectionStore: PublisherPublicationSelectionStore = {
          $transaction: async (read) =>
            read({
              $queryRaw: jest
                .fn()
                .mockResolvedValueOnce([{ seq: 'off', bitmap: 'off', sort: 'off', jit: 'off' }])
                .mockResolvedValue([{ id: 'first' }, { id: 'second' }]),
            }),
        };
        const runtime = new AdminManagedBroadcastRuntime(
          {
            prisma: {
              ...selectionStore,
              $queryRaw: jest.fn().mockResolvedValue([{ id: 'first' }, { id: 'second' }]),
              managedBroadcast: {
                findMany: jest.fn().mockResolvedValue([{ id: 'first' }, { id: 'second' }]),
              },
            },
            logger: { log: jest.fn(), warn: jest.fn() },
          } as never,
          PublicationDispatchProfile.PUBLIK_V1,
        );
        const process = jest
          .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
          .mockImplementation(async () => {
            jest.setSystemTime(Date.now() + 6_000);
          });
        if (lane === 'immediate') await runtime.processDueImmediatePublicationBroadcasts();
        else await runtime.processDueDeadlinePublicationBroadcasts();
        expect(process).toHaveBeenCalledTimes(1);
        expect(process.mock.calls[0]?.[0]).toBe('first');
        if (lane === 'immediate') expect(process.mock.calls[0]?.[6]).toBe(4);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('delivers exact due NOW envelopes through the explicit immediate entry point', async () => {
    const managedBroadcast = {
      findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-now' }]),
    };
    const context = {
      prisma: { managedBroadcast },
      logger: { log: jest.fn(), warn: jest.fn() },
    };
    const runtime = new AdminManagedBroadcastRuntime(context as never);
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await runtime.processDueImmediatePublicationBroadcasts();

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith(
      'broadcast-now',
      'immediate',
      expect.any(Date),
      [
        ManagedBroadcastStatus.ACTIVE,
        ManagedBroadcastStatus.PARTIAL,
        ManagedBroadcastStatus.FAILED,
      ],
      undefined,
      { remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE },
      undefined,
    );
    expect(managedBroadcast.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 10,
        where: expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          publicationOccurrence: {
            is: { schedule: { is: { mode: { in: [PublicationScheduleMode.NOW] } } } },
          },
          deliveries: {
            some: {
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.PENDING,
                  ManagedBroadcastDeliveryStatus.SENDING,
                ],
              },
            },
          },
        }),
      }),
    );
    expect(managedBroadcast.findMany).toHaveBeenCalledTimes(3);
  });

  it('drains a targeted NOW envelope in bounded quanta behind a full older global page', async () => {
    const globalBacklog = Array.from({ length: 10 }, (_, index) => ({
      id: `older-broadcast-${index + 1}`,
    }));
    let targetedSelectionPass = 0;
    const managedBroadcast = {
      findMany: jest.fn(async (request: any) => {
        if (request.where?.publicationOccurrence?.is?.publicationId !== 'publication-target') {
          return globalBacklog;
        }
        targetedSelectionPass += 1;
        return targetedSelectionPass <= 2 ? [{ id: 'broadcast-target' }] : [];
      }),
    };
    const runtime = new AdminManagedBroadcastRuntime(
      {
        prisma: { managedBroadcast },
        logger: { log: jest.fn(), warn: jest.fn() },
      } as never,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValueOnce({
        status: ManagedBroadcastStatus.ACTIVE,
        currentOccurrence: 1,
        sentChatIds: ['chat-1', 'chat-2', 'chat-3', 'chat-4'],
        failedChatIds: [],
        pendingChatIds: ['chat-5'],
        canRetry: false,
        firstSendError: null,
        nextSendAt: new Date(),
      })
      .mockResolvedValueOnce({
        status: ManagedBroadcastStatus.COMPLETED,
        currentOccurrence: 1,
        sentChatIds: ['chat-5'],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: null,
      });

    await runtime.processTargetedImmediatePublicationBroadcasts(
      'publication-target',
      'occurrence-target',
    );

    expect(processSpy).toHaveBeenCalledTimes(2);
    for (const call of processSpy.mock.calls) {
      expect(call).toEqual([
        'broadcast-target',
        'immediate',
        expect.any(Date),
        [ManagedBroadcastStatus.ACTIVE],
        undefined,
        { remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE },
        4,
        true,
      ]);
    }
    expect(managedBroadcast.findMany).toHaveBeenCalledTimes(3);
    for (const [request] of managedBroadcast.findMany.mock.calls) {
      expect(request.where.publicationOccurrence.is).toEqual(
        expect.objectContaining({
          id: 'occurrence-target',
          publicationId: 'publication-target',
        }),
      );
    }
    expect(processSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/^older-broadcast-/u),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('bypasses a full older deadline page for an exact retry occurrence', async () => {
    const olderDeadlineBacklog = Array.from({ length: 25 }, (_, index) => ({
      id: `older-deadline-${index + 1}`,
    }));
    let targetedSelectionPass = 0;
    const managedBroadcast = {
      findMany: jest.fn(async (request: any) => {
        if (request.where?.publicationOccurrence?.is?.publicationId !== 'publication-target') {
          return olderDeadlineBacklog;
        }
        targetedSelectionPass += 1;
        return targetedSelectionPass === 1 ? [{ id: 'broadcast-target' }] : [];
      }),
    };
    const runtime = new AdminManagedBroadcastRuntime(
      {
        prisma: { managedBroadcast },
        logger: { log: jest.fn(), warn: jest.fn() },
      } as never,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue({
        status: ManagedBroadcastStatus.COMPLETED,
        currentOccurrence: 1,
        sentChatIds: ['chat-1'],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: null,
      });

    await runtime.processTargetedDeadlinePublicationBroadcasts(
      'publication-target',
      'occurrence-target',
    );

    expect(processSpy).toHaveBeenCalledWith(
      'broadcast-target',
      'deadline',
      expect.any(Date),
      [ManagedBroadcastStatus.ACTIVE],
      undefined,
      { remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE },
      4,
      true,
    );
    expect(managedBroadcast.findMany).toHaveBeenCalledTimes(2);
    expect(managedBroadcast.findMany.mock.calls[0]?.[0]?.where.publicationOccurrence.is).toEqual(
      expect.objectContaining({
        id: 'occurrence-target',
        publicationId: 'publication-target',
        schedule: {
          is: {
            status: PublicationScheduleStatus.ACTIVE,
            mode: {
              in: [
                PublicationScheduleMode.ONCE,
                PublicationScheduleMode.SLOTS,
                PublicationScheduleMode.RECURRENCE,
              ],
            },
          },
        },
      }),
    );
    expect(processSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/^older-deadline-/u),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('delivers exact due scheduled publication envelopes through the deadline entry point', async () => {
    const managedBroadcast = {
      findMany: jest.fn().mockResolvedValue([{ id: 'broadcast-once' }]),
    };
    const context = {
      prisma: { managedBroadcast },
      logger: { log: jest.fn(), warn: jest.fn() },
    };
    const runtime = new AdminManagedBroadcastRuntime(context as never);
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await runtime.processDueDeadlinePublicationBroadcasts(7);

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith(
      'broadcast-once',
      'deadline',
      expect.any(Date),
      [
        ManagedBroadcastStatus.ACTIVE,
        ManagedBroadcastStatus.PARTIAL,
        ManagedBroadcastStatus.FAILED,
      ],
      undefined,
      { remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE },
    );
    expect(managedBroadcast.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        take: 7,
        where: expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          publicationOccurrence: {
            is: {
              schedule: {
                is: {
                  mode: {
                    in: [
                      PublicationScheduleMode.ONCE,
                      PublicationScheduleMode.SLOTS,
                      PublicationScheduleMode.RECURRENCE,
                    ],
                  },
                },
              },
            },
          },
          deliveries: {
            some: {
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.PENDING,
                  ManagedBroadcastDeliveryStatus.SENDING,
                ],
              },
            },
          },
        }),
      }),
    );
    expect(managedBroadcast.findMany).toHaveBeenCalledTimes(3);
  });

  it('keeps publication envelopes out of the legacy runner entry point', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: { managedBroadcast: { findMany } },
      backgroundRuntimeGovernorService: {
        decide: jest.fn().mockResolvedValue({
          action: 'run',
          reason: 'background headroom available',
          retryAfterMs: 0,
        }),
      },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    const immediateSpy = jest.spyOn(runtime, 'processDueImmediatePublicationBroadcasts');
    const deadlineSpy = jest.spyOn(runtime, 'processDueDeadlinePublicationBroadcasts');

    await runtime.processDueManagedBroadcasts('scheduled');

    expect(immediateSpy).not.toHaveBeenCalled();
    expect(deadlineSpy).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(
      findMany.mock.calls.every(([query]) => query.where?.publicationOccurrenceId === null),
    ).toBe(true);
  });

  it('does not revisit a due legacy broadcast within the same runner invocation', async () => {
    const findMany = jest.fn().mockImplementation(async ({ where }: any) => {
      if (where?.status === ManagedBroadcastStatus.ACTIVE) {
        return where.id?.notIn?.includes('broadcast-1') ? [] : [{ id: 'broadcast-1' }];
      }
      return [];
    });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: { managedBroadcast: { findMany } },
      backgroundRuntimeGovernorService: {
        decide: jest.fn().mockResolvedValue({
          action: 'run',
          reason: 'background headroom available',
          retryAfterMs: 0,
        }),
      },
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    const processSpy = jest
      .spyOn(runtime as any, 'processManagedBroadcastOccurrence')
      .mockResolvedValue(undefined);

    await runtime.processDueManagedBroadcasts('scheduled');

    expect(findMany).toHaveBeenCalledTimes(4);
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('broadcast-1', 'scheduled', expect.any(Date), [
      ManagedBroadcastStatus.ACTIVE,
      ManagedBroadcastStatus.PARTIAL,
      ManagedBroadcastStatus.FAILED,
    ]);
    const activeQueries = findMany.mock.calls
      .map(([query]) => query)
      .filter((query) => query.where?.status === ManagedBroadcastStatus.ACTIVE);
    expect(activeQueries).toHaveLength(2);
    expect(activeQueries[0]?.where?.id).toBeUndefined();
    expect(activeQueries[1]?.where?.id).toEqual({ notIn: ['broadcast-1'] });
    expect(activeQueries.every((query) => query.where?.publicationOccurrenceId === null)).toBe(
      true,
    );
    const retryQueries = findMany.mock.calls
      .map(([query]) => query)
      .filter((query) => Array.isArray(query.where?.status?.in));
    expect(retryQueries).toHaveLength(2);
    expect(retryQueries.every((query) => query.where?.publicationOccurrenceId === null)).toBe(true);
  });

  it('checks that a publication envelope is active before revalidating target access', async () => {
    const row = createPublicationEnvelopeRow();
    const assertManagedEntityAdminAccess = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue(row),
        },
      },
      assertManagedEntityAdminAccess,
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    const executionActive = jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(false);

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(executionActive).toHaveBeenCalledTimes(1);
    expect(assertManagedEntityAdminAccess).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.CANCELED,
        canRetry: false,
        nextSendAt: null,
      }),
    );
  });

  it('terminally fails a publication envelope when target admin access is denied', async () => {
    const row = createPublicationEnvelopeRow();
    const accessError = new ForbiddenException(
      'Пользователь больше не является администратором чата.',
    );
    const assertManagedEntityAdminAccess = jest.fn().mockRejectedValue(accessError);
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const occurrenceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const reservationDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
        },
        managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
        managedBroadcastCalendarReservation: { deleteMany: reservationDeleteMany },
        managedBroadcastOccurrence: { updateMany: occurrenceUpdateMany },
      },
      assertManagedEntityAdminAccess,
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    const executionActive = jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    const reconcile = jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(executionActive.mock.invocationCallOrder[0]).toBeLessThan(
      assertManagedEntityAdminAccess.mock.invocationCallOrder[0]!,
    );
    expect(assertManagedEntityAdminAccess).toHaveBeenCalledWith('chat-target', 'admin-1', 'chat');
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      assertManagedEntityAdminAccess.mock.invocationCallOrder[0]!,
    );
    expect(broadcastUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          status: ManagedBroadcastStatus.FAILED,
          lastError: accessError.message,
          nextSendAt: null,
          lockedAt: null,
          lockToken: null,
        },
      }),
    );
    expect(deliveryUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        broadcastId: row.id,
        occurrenceIndex: 1,
        status: {
          in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
        },
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.CANCELED,
        lockedAt: null,
        lockToken: null,
        lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
        lastError: accessError.message,
      },
    });
    expect(deliveryUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ occurrenceIndex: { gt: 1 } }),
        data: expect.objectContaining({ status: ManagedBroadcastDeliveryStatus.CANCELED }),
      }),
    );
    expect(occurrenceUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { broadcastId: row.id, occurrenceIndex: 1 },
      data: { status: ManagedBroadcastStatus.FAILED },
    });
    expect(occurrenceUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { broadcastId: row.id, occurrenceIndex: { gt: 1 } },
      data: { status: ManagedBroadcastStatus.CANCELED },
    });
    expect(reservationDeleteMany).toHaveBeenCalledWith({
      where: { broadcastId: row.id, occurrenceIndex: { gte: 1 } },
    });
    expect(
      deliveryUpdateMany.mock.calls.some(([query]) =>
        query.where.status.in.some(
          (status: ManagedBroadcastDeliveryStatus) =>
            status === ManagedBroadcastDeliveryStatus.SENDING ||
            status === ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        ),
      ),
    ).toBe(false);
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.FAILED,
        pendingChatIds: [],
        canRetry: false,
        firstSendError: accessError,
        nextSendAt: null,
      }),
    );
  });

  it('does not classify a downstream forbidden error as target access loss', async () => {
    const row = createPublicationEnvelopeRow();
    const downstreamError = new ForbiddenException('Вложение недоступно.');
    const assertManagedEntityAdminAccess = jest.fn().mockResolvedValue(undefined);
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdateMany = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
        },
        managedBroadcastDelivery: {
          findMany: jest.fn().mockRejectedValue(downstreamError),
          updateMany: deliveryUpdateMany,
        },
      },
      assertManagedEntityAdminAccess,
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(assertManagedEntityAdminAccess).toHaveBeenCalledTimes(1);
    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(broadcastUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          status: ManagedBroadcastStatus.FAILED,
          lastError: downstreamError.message,
          lockedAt: null,
          lockToken: null,
        },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.FAILED,
        firstSendError: downstreamError,
        nextSendAt: row.nextSendAt,
      }),
    );
  });

  it('keeps a publication envelope retryable when target access cannot be checked temporarily', async () => {
    const row = createPublicationEnvelopeRow();
    const accessError = new ServiceUnavailableException(
      'Не удалось проверить права администратора в MAX. Повторите попытку.',
    );
    const assertManagedEntityAdminAccess = jest.fn().mockRejectedValue(accessError);
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdateMany = jest.fn();
    const occurrenceUpdateMany = jest.fn();
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          findUnique: jest.fn().mockResolvedValue(row),
        },
        managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
        managedBroadcastOccurrence: { updateMany: occurrenceUpdateMany },
      },
      assertManagedEntityAdminAccess,
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(broadcastUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          status: ManagedBroadcastStatus.FAILED,
          lastError: accessError.message,
          lockedAt: null,
          lockToken: null,
        },
      }),
    );
    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(occurrenceUpdateMany).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.FAILED,
        canRetry: true,
        firstSendError: accessError,
        nextSendAt: row.nextSendAt,
      }),
    );
  });

  it('limits one automatic publication envelope pass to four deliveries', async () => {
    const nextSendAt = new Date('2026-07-12T10:00:00.000Z');
    const row = {
      id: 'broadcast-deadline',
      sourceChatId: 'chat-source',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Publication',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1', 'chat-2', 'chat-3', 'chat-4', 'chat-5'],
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Open',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      publicationOccurrenceId: 'occurrence-1',
      publicationContentRevisionId: 'content-1',
    };
    const deliveries = row.targetChatIds.map((targetChatId, index) => ({
      id: `delivery-${index + 1}`,
      broadcastId: row.id,
      occurrenceIndex: 1,
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
      lockedAt: null,
      lockToken: null,
    }));
    const prisma = {
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(row),
      },
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue(deliveries),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma,
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: row.targetChatIds,
    });
    jest.spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows').mockResolvedValue(deliveries);
    jest
      .spyOn(publicationMediaRuntime(runtime), 'loadManagedBroadcastExecutionMedia')
      .mockResolvedValue(createExecutionMedia());
    jest.spyOn((runtime as any).mediaRuntime, 'resolveManagedBroadcastMedia').mockResolvedValue({});
    jest.spyOn(runtime as any, 'resolveDeliveryBotAssignment').mockResolvedValue('bot-1');
    jest.spyOn((runtime as any).messageRuntime, 'buildMessage').mockResolvedValue({
      messageText: 'Publication',
      messageOptions: {},
      commentDialogReference: null,
    });
    jest
      .spyOn(runtime as any, 'heartbeatManagedBroadcastProcessingLock')
      .mockResolvedValue(undefined);
    jest
      .spyOn((runtime as any).messageRuntime, 'recordDialogReference')
      .mockResolvedValue(undefined);
    jest
      .spyOn((runtime as any).publicationVerification, 'persistResponseTargetMismatch')
      .mockResolvedValue(null);
    jest
      .spyOn((runtime as any).publicationVerification, 'verifyAfterSend')
      .mockResolvedValue(new Set());
    const sendSpy = jest
      .spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId')
      .mockImplementation(async (...args: unknown[]) => ({
        messageId: `message-${String(args[0])}`,
        url: null,
      }));
    const finalizeSpy = jest
      .spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence')
      .mockResolvedValue({
        status: ManagedBroadcastStatus.ACTIVE,
        currentOccurrence: 1,
        sentChatIds: row.targetChatIds.slice(0, 4),
        failedChatIds: [],
        pendingChatIds: ['chat-5'],
        canRetry: false,
        firstSendError: null,
        nextSendAt,
      });

    await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(sendSpy).toHaveBeenCalledTimes(4);
    expect(sendSpy.mock.calls.map((call) => call[0])).toEqual([
      'chat-1',
      'chat-2',
      'chat-3',
      'chat-4',
    ]);
    expect(sendSpy.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({ trafficClass: 'background', sourceTag: 'managed_broadcast' }),
    );
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([ManagedBroadcastStatus.PARTIAL, ManagedBroadcastStatus.FAILED])(
    'keeps a mixed %s NOW envelope verification-only during automatic recovery',
    async (status) => {
      const nextSendAt = new Date('2026-09-01T10:00:00.000Z');
      const pendingDeliveries = Array.from({ length: 98 }, (_, index) => ({
        id: `delivery-pending-${index + 1}`,
        targetChatId: `chat-${index + 2}`,
        status: ManagedBroadcastDeliveryStatus.PENDING,
        attemptCount: 0,
      }));
      const deliveries = [
        {
          id: 'delivery-sent',
          targetChatId: 'chat-1',
          status: ManagedBroadcastDeliveryStatus.SENT,
          attemptCount: 1,
          remoteMessageId: 'message-1',
          remoteMessageVerifiedAt: null,
          remoteMessageVerificationNextAt: new Date('2026-09-01T10:00:15.000Z'),
          remoteMessageVerificationAttemptedAt: null,
          remoteMessageVerificationSource: null,
          remoteMessageVerificationAttemptCount: 0,
          remoteMessageVerificationAbsentCount: 0,
          remoteMessageVerificationPresentCount: 0,
        },
        ...pendingDeliveries,
      ];
      const targetChatIds = deliveries.map((delivery) => delivery.targetChatId);
      const row = {
        ...createPublicationEnvelopeRow(),
        id: `broadcast-${status.toLowerCase()}`,
        targetChatIds,
        nextSendAt,
        status,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: 'publisher-bot',
      };
      const publish = jest.fn();
      const managedBroadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const deliveryUpdateMany = jest.fn();
      const runtime = new AdminManagedBroadcastRuntime(
        {
          prisma: {
            managedBroadcast: {
              updateMany: managedBroadcastUpdateMany,
              findUnique: jest.fn().mockResolvedValue(row),
            },
            managedBroadcastDelivery: {
              findMany: jest.fn().mockResolvedValue(deliveries),
              updateMany: deliveryUpdateMany,
            },
          },
          maxRoutedPublicationService: { publish },
          logger: { log: jest.fn(), warn: jest.fn() },
        } as never,
        PublicationDispatchProfile.PUBLIK_V1,
      );
      jest
        .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
        .mockResolvedValue(true);
      jest
        .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
        .mockResolvedValue(undefined);
      jest
        .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
        .mockResolvedValue(false);
      jest
        .spyOn((runtime as any).publisherDispatch, 'ensureRuntimeBoundary')
        .mockResolvedValue({ ready: true });
      jest
        .spyOn((runtime as any).publisherDispatch, 'ensureActorAdminAccess')
        .mockResolvedValue({ ready: true });
      jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
        targetMode: 'selected',
        targetChatIds,
      });
      const ensureDeliveryRows = jest.spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows');
      const loadMedia = jest.spyOn(
        publicationMediaRuntime(runtime),
        'loadManagedBroadcastExecutionMedia',
      );
      jest
        .spyOn((runtime as any).publicationVerification, 'verifyAfterSend')
        .mockResolvedValue(new Set());
      const finalize = jest.spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence');

      const result = await (runtime as any).processManagedBroadcastOccurrence(
        row.id,
        'immediate',
        new Date('2026-09-01T09:55:00.000Z'),
        [
          ManagedBroadcastStatus.ACTIVE,
          ManagedBroadcastStatus.PARTIAL,
          ManagedBroadcastStatus.FAILED,
        ],
      );

      expect(result).toMatchObject({
        status,
        pendingChatIds: pendingDeliveries.map((delivery) => delivery.targetChatId),
        canRetry: true,
      });
      expect(publish).not.toHaveBeenCalled();
      expect(deliveryUpdateMany).not.toHaveBeenCalled();
      expect(ensureDeliveryRows).not.toHaveBeenCalled();
      expect(loadMedia).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      expect(
        managedBroadcastUpdateMany.mock.calls.some(
          ([request]) => request.data?.status === ManagedBroadcastStatus.ACTIVE,
        ),
      ).toBe(false);
      expect(managedBroadcastUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lockedAt: null, lockToken: null } }),
      );
    },
  );

  it.each(['deadline', 'immediate'])(
    'persists a subsecond local capacity wait in the %s lane',
    async (reason) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-12T10:00:30Z'));
      const error = new MaxApiInternalRateLimitError('capacity', 250);
      const f = createPublicationPrismaSendFailureHarness(error, false);
      await (f.runtime as any).processManagedBroadcastOccurrence(f.row.id, reason, new Date(), [
        ManagedBroadcastStatus.ACTIVE,
      ]);
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect(f.recoveryDeliveryUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'SENDING',
            lockToken: expect.any(String),
            attemptCount: 1,
            remoteMessageId: null,
            sentAt: null,
          }),
          data: expect.objectContaining({
            status: 'PENDING',
            nextAttemptAt: new Date('2026-07-12T10:00:30.250Z'),
            waitReason: 'local_capacity',
            attemptCount: { decrement: 1 },
          }),
        }),
      );
      expect((f.runtime as any).finalizeManagedBroadcastOccurrence).toHaveBeenCalledWith(
        expect.any(Object),
        1,
        expect.any(Array),
        expect.any(Array),
        null,
        expect.objectContaining({ pendingNotBefore: new Date('2026-07-12T10:00:30.250Z') }),
      );
    },
  );

  it('sends PUBLIK_V1 through its ledger-fenced exact bot without routed failover', async () => {
    const nextSendAt = new Date('2026-08-26T10:00:00.000Z');
    const row = {
      id: 'broadcast-publik',
      sourceChatId: 'chat-1',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Publication',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1'],
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Open',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      publicationOccurrenceId: 'occurrence-publik',
      publicationContentRevisionId: 'content-publik',
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
    };
    const commentDialogReference = {
      entityType: 'chat' as const,
      threadId: 'thread-publik',
      includeCommentsButton: true,
      includeSuggestButton: false,
      suggestButtonText: null,
      customButtons: [],
      suggestionEntryMode: null,
      botId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
    };
    const publisherDialogContext = {
      version: 1,
      dialogBotId: 'publisher-bot',
      buttons: [[{ type: 'link', text: 'Comments', url: 'https://max.ru/app' }]],
      reference: commentDialogReference,
    };
    const delivery = {
      id: 'delivery-publik',
      broadcastId: row.id,
      occurrenceIndex: 1,
      targetChatId: 'chat-1',
      botId: null,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
      lockedAt: null,
      lockToken: null,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publisherDialogContext,
    };
    const publish = jest.fn();
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const managedBroadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const publicationOccurrenceUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const assertEntityReady = jest.fn().mockResolvedValue({
      chatId: 'chat-1',
      entityType: 'chat',
      requiredBotId: 'publisher-bot',
      policyRevision: 1,
    });
    const assertDispatchAllowed = jest.fn().mockResolvedValue(undefined);
    const recordSendSuccess = jest.fn().mockResolvedValue(undefined);
    const logger = { log: jest.fn(), warn: jest.fn() };
    const actorAccessFindMany = jest.fn().mockResolvedValue([
      {
        chatId: 'chat-1',
        userId: 'admin-1',
        botId: 'publisher-bot',
        state: ManagedEntityAccessState.GRANTED,
        userRole: ManagedEntityAccessRole.ADMIN,
        checkedAt: new Date('2026-08-27T09:59:00.000Z'),
        expiresAt: new Date('2099-08-27T10:14:00.000Z'),
      },
    ]);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: row.id }]),
      managedBroadcast: { updateMany: managedBroadcastUpdateMany },
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
      $executeRaw: jest.fn().mockResolvedValue(1),
      publicationOccurrence: { updateMany: publicationOccurrenceUpdateMany },
    };
    const runtime = new AdminManagedBroadcastRuntime(
      {
        prisma: {
          $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
          managedBroadcast: {
            updateMany: managedBroadcastUpdateMany,
            findUnique: jest.fn().mockResolvedValue(row),
          },
          managedBroadcastDelivery: {
            findMany: jest.fn().mockResolvedValue([delivery]),
            updateMany: deliveryUpdateMany,
          },
          managedEntityAccessEdge: { findMany: actorAccessFindMany },
          publicationOccurrence: {
            findUnique: jest.fn().mockResolvedValue({
              contentRevisionId: row.publicationContentRevisionId,
              dispatchProfile: 'PUBLIK_V1',
              requiredBotId: 'publisher-bot',
              status: 'IN_PROGRESS',
              scheduleRevision: 1,
              deliveryDeadlineAt: null,
              retryAuthorizedAt: null,
              retryExpiresAt: null,
              publication: {
                lifecycle: 'ACTIVE',
                dispatchProfile: 'PUBLIK_V1',
                requiredBotId: 'publisher-bot',
                targets: [{ canceledAt: null }],
              } satisfies Pick<Publication, 'lifecycle' | 'dispatchProfile' | 'requiredBotId'> & {
                targets: Pick<PublicationTarget, 'canceledAt'>[];
              },
              schedule: { status: 'ACTIVE', revision: 1 },
            }),
          },
        },
        maxRoutedPublicationService: { publish },
        publisherRuntimeBoundaryService: { assertDispatchEnabled: jest.fn() },
        publisherReadinessService: {
          assertEntityReady,
        },
        publisherDispatchHealthService: {
          assertDispatchAllowed,
          recordSendSuccess,
          recordSendFailure: jest.fn().mockResolvedValue('transient'),
        },
        assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
        logger,
      } as never,
      PublicationDispatchProfile.PUBLIK_V1,
    );
    const executionActive = jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockImplementation(async (...args: unknown[]) => {
        const onOccurrenceScheduledAt = args[4] as ((scheduledAt: Date) => void) | undefined;
        onOccurrenceScheduledAt?.(nextSendAt);
        return true;
      });
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);
    jest
      .spyOn((runtime as any).publisherDispatch, 'ensureRuntimeBoundary')
      .mockResolvedValue({ ready: true });
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: ['chat-1'],
    });
    jest.spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows').mockResolvedValue([delivery]);
    jest
      .spyOn(publicationMediaRuntime(runtime), 'loadManagedBroadcastExecutionMedia')
      .mockResolvedValue(createExecutionMedia());
    jest.spyOn((runtime as any).mediaRuntime, 'resolveManagedBroadcastMedia').mockResolvedValue({});
    jest
      .spyOn((runtime as any).publicationVerification, 'verifyAfterSend')
      .mockResolvedValue(new Set());
    jest
      .spyOn((runtime as any).publicationVerification, 'persistResponseTargetMismatch')
      .mockResolvedValue(null);
    jest
      .spyOn(runtime as any, 'heartbeatManagedBroadcastProcessingLock')
      .mockResolvedValue(undefined);
    const buildMessage = jest
      .spyOn((runtime as any).messageRuntime, 'buildMessage')
      .mockResolvedValue({
        messageText: 'Publication',
        messageOptions: undefined,
        commentDialogReference,
      });
    const send = jest
      .spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId')
      .mockResolvedValue({ messageId: 'mid-publik', url: null, chatId: 'chat-1' });
    jest
      .spyOn((runtime as any).messageRuntime, 'recordDialogReference')
      .mockResolvedValue(undefined);
    jest.spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence').mockResolvedValue({
      status: ManagedBroadcastStatus.COMPLETED,
      currentOccurrence: 1,
      sentChatIds: ['chat-1'],
      failedChatIds: [],
      pendingChatIds: [],
      canRetry: false,
      firstSendError: null,
      nextSendAt: null,
    });
    let preparedLedgerContext: unknown;
    let readinessCallsBeforeMutation = 0;
    let readinessCallsAfterMutation = 0;
    let executionChecksBeforeMutation = 0;
    let executionChecksAfterMutation = 0;
    publish.mockImplementation(async (request: any) => {
      const context = { botId: 'publisher-bot', job: {} };
      const prepared = await request.prepareAttempt(context);
      preparedLedgerContext = prepared.ledgerContext;
      await request.onDispatchAttempt(context);
      readinessCallsBeforeMutation = assertEntityReady.mock.calls.length;
      executionChecksBeforeMutation = executionActive.mock.calls.length;
      await request.beforeSendMutation(context);
      readinessCallsAfterMutation = assertEntityReady.mock.calls.length;
      executionChecksAfterMutation = executionActive.mock.calls.length;
      return {
        messageId: 'mid-publik',
        url: null,
        chatId: 'chat-1',
        botId: 'publisher-bot',
        candidateBotIds: ['publisher-bot'],
        routingVersion: null,
      };
    });

    await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'deadline',
      new Date('2026-08-26T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        publisherExactBotId: 'publisher-bot',
        logicalIdempotencyKey:
          'managed-broadcast:send:broadcast-publik:occurrence:1:target:chat-1:content:publication-content-publik',
      }),
    );
    expect(actorAccessFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: { in: ['chat-1'] },
          userId: 'admin-1',
          botId: 'publisher-bot',
          state: ManagedEntityAccessState.GRANTED,
          userRole: {
            in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN],
          },
        }),
      }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(buildMessage).toHaveBeenCalledWith(
      'chat-1',
      'chat',
      expect.any(Object),
      'Publication',
      {},
      'publisher-bot',
      'publisher-bot',
      { value: publisherDialogContext, required: true },
    );
    expect(preparedLedgerContext).toEqual({
      managedBroadcast: { commentDialogReference },
    });
    expect(readinessCallsAfterMutation).toBe(readinessCallsBeforeMutation + 1);
    expect(executionChecksAfterMutation).toBe(executionChecksBeforeMutation + 1);
    expect(assertDispatchAllowed).toHaveBeenCalledTimes(assertEntityReady.mock.calls.length);
    expect(recordSendSuccess).toHaveBeenCalledWith('chat-1', expect.any(Date));
    expect(logger.log).toHaveBeenCalledWith(
      {
        broadcastId: 'broadcast-publik',
        publicationOccurrenceId: 'occurrence-publik',
        scheduledAt: nextSendAt.toISOString(),
        claimedAt: expect.any(String),
        lagMs: expect.any(Number),
      },
      'Publik publication deadline delivery claimed',
    );
    const deadlineClaim = logger.log.mock.calls.find(
      ([, message]) => message === 'Publik publication deadline delivery claimed',
    )?.[0];
    expect(deadlineClaim?.lagMs).toBeGreaterThanOrEqual(0);
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
        }),
      }),
    );
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
        }),
        data: expect.objectContaining({
          botId: 'publisher-bot',
          dialogBotId: 'publisher-bot',
        }),
      }),
    );
  });

  it('rotates an unfinished deadline envelope behind older due work', async () => {
    const now = new Date('2026-07-12T10:05:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const harness = createProjectedFinalizerHarness([
      selectedFinalizerDelivery('chat-1', { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS }),
      selectedFinalizerDelivery('chat-2'),
    ]);
    const result = await harness.finalize(harness.row, 1, [], [], null);

    expect(harness.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ManagedBroadcastStatus.ACTIVE, nextSendAt: now }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.ACTIVE,
        failedChatIds: ['chat-1'],
        pendingChatIds: ['chat-2'],
        nextSendAt: now,
      }),
    );
    expect(harness.deliveryReader.findMany).toHaveBeenCalledTimes(1);
  });

  it('preserves the earliest route retry when every pending target is quarantined', async () => {
    const now = new Date('2026-07-12T10:05:00.000Z');
    const retryAt = new Date('2026-07-12T16:05:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const harness = createProjectedFinalizerHarness(
      ['chat-1', 'chat-2'].map((targetChatId) =>
        selectedFinalizerDelivery(targetChatId, {
          lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
        }),
      ),
      { row: createFullFinalizerRow({ nextSendAt: now }) },
    );
    const result = await harness.finalize(harness.row, 1, [], [], null, {
      pendingNotBefore: retryAt,
    });

    expect(harness.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          nextSendAt: retryAt,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.ACTIVE,
        pendingChatIds: ['chat-1', 'chat-2'],
        nextSendAt: retryAt,
      }),
    );
  });

  it('schedules an unverified publication at its persisted verification retry time', async () => {
    const now = new Date('2026-07-12T10:05:00.000Z');
    const nextVerificationAt = new Date('2026-07-12T10:15:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const harness = createProjectedFinalizerHarness([
      selectedFinalizerDelivery('chat-1', {
        status: ManagedBroadcastDeliveryStatus.SENT,
        sentAt: new Date('2026-07-12T10:00:00.000Z'),
        remoteMessageId: 'mid-1',
        remoteMessageVerificationNextAt: nextVerificationAt,
      }),
    ]);
    const result = await harness.finalize(harness.row, 1, [], [], null);

    expect(harness.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.ACTIVE,
          nextSendAt: nextVerificationAt,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.ACTIVE,
        pendingChatIds: [],
        nextSendAt: nextVerificationAt,
      }),
    );
  });

  it('does not keep an envelope active for untouched legacy SENT verification state', async () => {
    const harness = createProjectedFinalizerHarness(
      [
        selectedFinalizerDelivery('chat-legacy', {
          status: ManagedBroadcastDeliveryStatus.SENT,
          sentAt: new Date('2026-07-11T10:00:00.000Z'),
          remoteMessageId: 'mid-legacy',
        }),
      ],
      { row: createFullFinalizerRow({ id: 'broadcast-legacy' }) },
    );
    const result = await harness.finalize(harness.row, 1, [], [], null);

    expect(harness.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.COMPLETED,
          nextSendAt: null,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.COMPLETED,
        sentChatIds: ['chat-legacy'],
        nextSendAt: null,
      }),
    );
    expect(harness.reservationDeleteMany).toHaveBeenCalledTimes(1);
    expect(harness.occurrenceUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('finalizes an ambiguous NOW recovery envelope without dispatching it again', async () => {
    const nextSendAt = new Date('2026-07-12T10:00:00.000Z');
    const row = {
      id: 'broadcast-now',
      sourceChatId: 'chat-1',
      entityType: 'CHAT',
      actorUserId: 'admin-1',
      text: 'Publication',
      textFormat: 'plain',
      applyToAllChats: false,
      targetChatIds: ['chat-1'],
      buttons: [],
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Open',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      mediaType: null,
      mediaPayload: null,
      mediaMimeType: '',
      mediaFileName: '',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      nextSendAt,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
      sentCount: 0,
      status: ManagedBroadcastStatus.ACTIVE,
      lastError: null,
      lockedAt: null,
      lockToken: null,
      publicationOccurrenceId: 'occurrence-1',
      publicationContentRevisionId: 'content-1',
    };
    const ambiguousDelivery = {
      id: 'delivery-1',
      broadcastId: row.id,
      occurrenceIndex: 1,
      targetChatId: 'chat-1',
      status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      attemptCount: 1,
      remoteMessageId: null,
      lastError: 'timeout',
      sentAt: null,
      lockedAt: null,
      lockToken: null,
    };
    const prisma = {
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(row),
      },
      managedBroadcastDelivery: {
        findMany: jest.fn().mockResolvedValue([ambiguousDelivery]),
      },
    };
    const runtime = new AdminManagedBroadcastRuntime({
      prisma,
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      logger: { log: jest.fn(), warn: jest.fn() },
    } as never);
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastPublicationExecutionActive')
      .mockResolvedValue(true);
    jest
      .spyOn(runtime as any, 'reconcileStaleManagedBroadcastDeliveries')
      .mockResolvedValue(undefined);
    jest
      .spyOn(runtime as any, 'deferManagedBroadcastOccurrenceWithFreshSendingDeliveries')
      .mockResolvedValue(false);
    jest.spyOn(runtime as any, 'resolveManagedBroadcastTargetsFromRow').mockReturnValue({
      targetMode: 'selected',
      targetChatIds: ['chat-1'],
    });
    jest
      .spyOn(runtime as any, 'ensureManagedBroadcastDeliveryRows')
      .mockResolvedValue([ambiguousDelivery]);
    jest
      .spyOn(publicationMediaRuntime(runtime), 'loadManagedBroadcastExecutionMedia')
      .mockResolvedValue(createExecutionMedia());
    const finalizeSpy = jest
      .spyOn(runtime as any, 'finalizeManagedBroadcastOccurrence')
      .mockResolvedValue({
        status: ManagedBroadcastStatus.FAILED,
        currentOccurrence: 1,
        sentChatIds: [],
        failedChatIds: ['chat-1'],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt,
      });
    const sendSpy = jest
      .spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId')
      .mockResolvedValue({ messageId: 'duplicate', url: null });

    const result = await (runtime as any).processManagedBroadcastOccurrence(
      row.id,
      'immediate',
      new Date('2026-07-12T09:55:00.000Z'),
      [ManagedBroadcastStatus.ACTIVE],
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).toHaveBeenCalledWith(row, 1, [], [], null, expect.any(Object));
    expect(result).toEqual(expect.objectContaining({ status: ManagedBroadcastStatus.FAILED }));
  });

  it('recovers a pre-deploy routed send that crashed before delivery persistence', async () => {
    const deliveryLockedAt = new Date('2026-07-12T09:55:00.000Z');
    const completedAt = new Date('2026-07-12T09:55:01.000Z');
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const ledgerFindMany = jest.fn().mockResolvedValue([
      {
        jobId:
          'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:publication-content-1',
        remoteMessageId: 'mid-after-crash',
        dispatchToken: 'dispatch-1',
        dispatchStartedAt: completedAt,
        dispatchBotId: 'bot-1',
        lastAttemptAt: completedAt,
        ambiguous: false,
        terminal: true,
        lastError: null,
        completedAt,
        metadata: null,
      },
    ]);
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'broadcast-1',
            actorUserId: 'admin-1',
            text: 'Publication',
            publicationContentRevisionId: 'content-1',
          }),
        },
        managedBroadcastDelivery: {
          updateMany: deliveryUpdateMany,
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'delivery-1',
              targetChatId: 'chat-1',
              botId: null,
              attemptCount: 2,
              lockedAt: deliveryLockedAt,
            },
          ]),
        },
        maxActionLedgerEntry: { findMany: ledgerFindMany },
      },
      maxRoutedPublicationService: {},
    } as never);
    const sendSpy = jest.spyOn(runtime as any, 'sendManagedBroadcastMessageImmediateWithId');

    await (runtime as any).reconcileStaleManagedBroadcastDeliveries(
      'broadcast-1',
      1,
      new Date('2026-07-12T10:00:00.000Z'),
    );

    expect(ledgerFindMany).toHaveBeenCalledWith({
      where: {
        jobId: {
          in: [
            'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:publication-content-1:attempt:2',
            'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:publication-content-1',
          ],
        },
      },
      select: expect.any(Object),
    });
    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'delivery-1',
          status: ManagedBroadcastDeliveryStatus.SENDING,
          remoteMessageId: null,
        }),
        data: expect.objectContaining({
          status: ManagedBroadcastDeliveryStatus.SENT,
          botId: 'bot-1',
          remoteMessageId: 'mid-after-crash',
          sentAt: completedAt,
          remoteMessageVerificationNextAt: new Date(completedAt.getTime() + 15_000),
        }),
      }),
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('fails closed before the legacy direct broadcast path can run in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const runtime = new AdminManagedBroadcastRuntime({} as never);

    try {
      await expect(
        (runtime as any).sendManagedBroadcastViaQueue(
          'chat-1',
          { userId: 'admin-1' },
          {},
          'chat',
          'miniapp',
        ),
      ).rejects.toThrow('Legacy direct managed broadcast dispatch is disabled in production');
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it.each([PublicationLifecycle.PAUSED, PublicationLifecycle.CANCELED])(
    'deletes an unattempted envelope safely when its publication becomes %s',
    async (lifecycle) => {
      const broadcastUpdateMany = jest.fn().mockResolvedValueOnce({ count: 1 });
      const broadcastDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = {
        managedBroadcastDelivery: {
          count: jest.fn().mockResolvedValue(0),
          updateMany: deliveryUpdateMany,
        },
        managedBroadcastCalendarReservation: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        managedBroadcast: {
          updateMany: broadcastUpdateMany,
          deleteMany: broadcastDeleteMany,
        },
      };
      const prisma = {
        publicationOccurrence: {
          findUnique: jest.fn().mockResolvedValue({
            status: PublicationOccurrenceStatus.IN_PROGRESS,
            scheduleRevision: 2,
            contentRevisionId: 'content-1',
            publication: { lifecycle },
            schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
          }),
        },
        $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      };
      const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

      await expect(
        (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
          {
            id: 'broadcast-1',
            publicationOccurrenceId: 'occurrence-1',
            publicationContentRevisionId: 'content-1',
            sentCount: 0,
            lockToken: 'lease-1',
          },
          1,
        ),
      ).resolves.toBe(false);

      expect(deliveryUpdateMany).toHaveBeenCalledWith({
        where: {
          broadcastId: 'broadcast-1',
          occurrenceIndex: 1,
          status: {
            in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
          },
        },
        data: {
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lockedAt: null,
          lockToken: null,
          lastError: 'Публикация остановлена до отправки.',
        },
      });
      expect(broadcastUpdateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'broadcast-1', lockToken: 'lease-1' },
        data: { lockedAt: expect.any(Date) },
      });
      expect(broadcastDeleteMany).toHaveBeenCalledWith({
        where: {
          id: 'broadcast-1',
          lockToken: 'lease-1',
          sentCount: 0,
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
      });
      expect(broadcastUpdateMany).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an in-flight delivery when its publication is stopped', async () => {
    const broadcastUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const deliveryUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      managedBroadcastDelivery: {
        updateMany: deliveryUpdateMany,
        count: jest.fn().mockResolvedValue(1),
      },
      managedBroadcastCalendarReservation: { deleteMany: jest.fn() },
      managedBroadcast: { updateMany: broadcastUpdateMany, deleteMany: jest.fn() },
    };
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          publication: { lifecycle: PublicationLifecycle.PAUSED },
          schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    await expect(
      (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
        {
          id: 'broadcast-1',
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-1',
          sentCount: 0,
          lockToken: 'lease-current',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(deliveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
          },
        }),
      }),
    );
    expect(broadcastUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'broadcast-1', lockToken: 'lease-current' },
      data: { lockedAt: null, lockToken: null },
    });
    expect(tx.managedBroadcastCalendarReservation.deleteMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.deleteMany).not.toHaveBeenCalled();
  });

  it('retains an attempted envelope for audit when safe deletion is rejected', async () => {
    const broadcastUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const tx = {
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        updateMany: broadcastUpdateMany,
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          publication: { lifecycle: PublicationLifecycle.PAUSED },
          schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    await expect(
      (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
        {
          id: 'broadcast-1',
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-1',
          sentCount: 0,
          lockToken: 'lease-current',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(tx.managedBroadcast.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'broadcast-1',
          lockToken: 'lease-current',
          deliveries: { none: expect.any(Object) },
        }),
      }),
    );
    expect(broadcastUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'broadcast-1', lockToken: 'lease-current' },
        data: expect.objectContaining({ status: ManagedBroadcastStatus.CANCELED }),
      }),
    );
  });

  it('does not mutate deliveries after losing the publication envelope lease', async () => {
    const deliveryUpdateMany = jest.fn();
    const tx = {
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany, count: jest.fn() },
      managedBroadcastCalendarReservation: { deleteMany: jest.fn() },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn(),
      },
    };
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-1',
          publication: { lifecycle: PublicationLifecycle.PAUSED },
          schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    await expect(
      (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
        {
          id: 'broadcast-1',
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-1',
          sentCount: 0,
          lockToken: 'lease-stale',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.count).not.toHaveBeenCalled();
    expect(tx.managedBroadcastCalendarReservation.deleteMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.deleteMany).not.toHaveBeenCalled();
  });

  it('releases a stale worker after content edit without resetting a newer SENDING delivery', async () => {
    const deliveryUpdateMany = jest.fn();
    const broadcastUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      publicationOccurrence: {
        findUnique: jest.fn().mockResolvedValue({
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          scheduleRevision: 2,
          contentRevisionId: 'content-new',
          publication: { lifecycle: PublicationLifecycle.ACTIVE },
          schedule: { revision: 2, status: PublicationScheduleStatus.ACTIVE },
        }),
      },
      managedBroadcastDelivery: { updateMany: deliveryUpdateMany },
      managedBroadcast: { updateMany: broadcastUpdateMany },
      $transaction: jest.fn(),
    };
    const runtime = new AdminManagedBroadcastRuntime({ prisma } as never);

    await expect(
      (runtime as any).ensureManagedBroadcastPublicationExecutionActive(
        {
          id: 'broadcast-1',
          publicationOccurrenceId: 'occurrence-1',
          publicationContentRevisionId: 'content-old',
          sentCount: 0,
          lockToken: 'lease-1',
        },
        1,
      ),
    ).resolves.toBe(false);

    expect(deliveryUpdateMany).not.toHaveBeenCalled();
    expect(broadcastUpdateMany).toHaveBeenCalledWith({
      where: { id: 'broadcast-1', lockToken: 'lease-1' },
      data: { lockedAt: null, lockToken: null },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'all canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.FAILED,
      expectedSentChatIds: [],
      expectedFailedChatIds: ['chat-1', 'chat-2'],
      expectedCanRetry: false,
    },
    {
      label: 'sent and canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.SENT, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.PARTIAL,
      expectedSentChatIds: ['chat-1'],
      expectedFailedChatIds: ['chat-2'],
      expectedCanRetry: false,
    },
    {
      label: 'failed and canceled',
      deliveries: [
        { status: ManagedBroadcastDeliveryStatus.FAILED, targetChatId: 'chat-1' },
        { status: ManagedBroadcastDeliveryStatus.CANCELED, targetChatId: 'chat-2' },
      ],
      expectedStatus: ManagedBroadcastStatus.FAILED,
      expectedSentChatIds: [],
      expectedFailedChatIds: ['chat-1', 'chat-2'],
      expectedCanRetry: true,
    },
    {
      label: 'ambiguous only',
      deliveries: [{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS, targetChatId: 'chat-1' }],
      expectedStatus: ManagedBroadcastStatus.FAILED,
      expectedSentChatIds: [],
      expectedFailedChatIds: ['chat-1'],
      expectedCanRetry: false,
    },
  ])(
    'treats $label deliveries as terminal undelivered with retry based only on real failures',
    async ({
      deliveries,
      expectedStatus,
      expectedSentChatIds,
      expectedFailedChatIds,
      expectedCanRetry,
    }) => {
      const harness = createProjectedFinalizerHarness(
        deliveries.map(({ targetChatId, status }) =>
          selectedFinalizerDelivery(targetChatId, { status }),
        ),
      );
      const result = await harness.finalize(harness.row, 1, [], [], null);

      expect(result).toEqual(
        expect.objectContaining({
          status: expectedStatus,
          sentChatIds: expectedSentChatIds,
          failedChatIds: expectedFailedChatIds,
          pendingChatIds: [],
          canRetry: expectedCanRetry,
        }),
      );
      expect(harness.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: expectedStatus }),
        }),
      );
      expect(harness.updateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty('sentCount');
      expect(harness.occurrenceUpdateMany).toHaveBeenCalledWith({
        where: { broadcastId: 'broadcast-1', occurrenceIndex: 1 },
        data: { status: expectedStatus },
      });
    },
  );

  it('keeps legacy canceled-target completion semantics while reporting the blocked targets', async () => {
    const harness = createProjectedFinalizerHarness(
      [selectedFinalizerDelivery('chat-1', { status: ManagedBroadcastDeliveryStatus.CANCELED })],
      {
        row: createFullFinalizerRow({
          id: 'broadcast-legacy',
          scheduleMode: 'legacy',
          publicationOccurrenceId: null,
        }),
      },
    );
    const result = await harness.finalize(harness.row, 1, [], [], null);

    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.COMPLETED,
        sentChatIds: [],
        failedChatIds: ['chat-1'],
        canRetry: false,
      }),
    );
    expect(harness.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedBroadcastStatus.COMPLETED,
          sentCount: 1,
        }),
      }),
    );
  });

  it('does not expose retry after a concurrent broadcast cancellation wins finalization', async () => {
    const reader = selectedOccurrenceReader('broadcast-1', {
      status: ManagedBroadcastStatus.CANCELED,
      sentCount: 0,
      cycleCount: 1,
      nextSendAt: null,
    });
    const runtime = new AdminManagedBroadcastRuntime({
      prisma: {
        managedBroadcast: { findUnique: reader.findUnique },
      },
    } as never);

    const result = await occurrenceProjectionSeam(runtime).read(
      'broadcast-1',
      [],
      ['chat-1'],
      [],
      null,
      true,
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: ManagedBroadcastStatus.CANCELED,
        canRetry: false,
      }),
    );
  });
});

describe('AdminManagedBroadcastRuntime read projections', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([null, ...Object.values(ManagedBroadcastStatus)])(
    'returns only the current E4 result after a failed claim with status %s',
    async (status) => {
      const now = new Date('2026-10-18T12:00:00.000Z');
      const nextSendAt = new Date('2026-10-18T12:05:00.000Z');
      jest.useFakeTimers().setSystemTime(now);
      const reader = selectedOccurrenceReader(
        'broadcast-projection-claim',
        status === null ? null : { status, sentCount: 8, cycleCount: 3, nextSendAt },
      );
      const updateMany = jest.fn(
        async (_args: Prisma.ManagedBroadcastUpdateManyArgs): Promise<Prisma.BatchPayload> => ({
          count: 0,
        }),
      );
      const publish = jest.fn(
        async (..._args: Parameters<MaxRoutedPublicationService['publish']>): Promise<never> => {
          throw new Error('A failed claim must not dispatch a message');
        },
      );
      const runtime = new AdminManagedBroadcastRuntime(
        {
          prisma: { managedBroadcast: { updateMany, findUnique: reader.findUnique } },
          maxRoutedPublicationService: { publish },
        } as never,
        PublicationDispatchProfile.PUBLIK_V1,
      );
      const prepare = jest.spyOn(runtime['publisherDispatch'], 'ensureRuntimeBoundary');
      const staleLockBefore = new Date(now.getTime() - 60_000);
      const result = await occurrenceProjectionSeam(runtime).process(
        'broadcast-projection-claim',
        'immediate',
        staleLockBefore,
        [ManagedBroadcastStatus.ACTIVE],
      );

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'broadcast-projection-claim',
          status: { in: [ManagedBroadcastStatus.ACTIVE] },
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          nextSendAt: { lte: now },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        },
        data: { lockedAt: now, lockToken: expect.any(String) },
      });
      expect(reader.findUnique).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        status: status ?? ManagedBroadcastStatus.FAILED,
        currentOccurrence: status === null ? 1 : 3,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: [],
        canRetry: false,
        firstSendError: null,
        nextSendAt: status === null ? null : nextSendAt,
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it.each(
    [null, ...Object.values(ManagedBroadcastStatus)].flatMap((status) =>
      [undefined, true, false].map((override) => ({ status, override })),
    ),
  )(
    'preserves E4 fallback status=$status override=$override and result references',
    async ({ status, override }) => {
      const nextSendAt = new Date('2026-10-18T12:05:00.000Z');
      const reader = selectedOccurrenceReader(
        'broadcast-projection-result',
        status === null ? null : { status, sentCount: -2, cycleCount: 0, nextSendAt },
      );
      const runtime = new AdminManagedBroadcastRuntime({
        prisma: { managedBroadcast: { findUnique: reader.findUnique } },
      } as never);
      const sentChatIds = ['sent-b', 'sent-a'];
      const failedChatIds = ['failed-b', 'failed-a'];
      const pendingChatIds = ['pending-b', 'pending-a'];
      const firstSendError = new Error('Preserved attempt failure');
      const result = await occurrenceProjectionSeam(runtime).read(
        'broadcast-projection-result',
        sentChatIds,
        failedChatIds,
        pendingChatIds,
        firstSendError,
        override,
      );
      const currentCanRetry =
        status === ManagedBroadcastStatus.PARTIAL || status === ManagedBroadcastStatus.FAILED;

      expect(reader.findUnique).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(status ?? ManagedBroadcastStatus.FAILED);
      expect(result.currentOccurrence).toBe(1);
      expect(result.canRetry).toBe(override === false ? false : currentCanRetry);
      expect(result.nextSendAt).toBe(status === null ? null : nextSendAt);
      expect(result.sentChatIds).toBe(sentChatIds);
      expect(result.failedChatIds).toBe(failedChatIds);
      expect(result.pendingChatIds).toBe(pendingChatIds);
      expect(result.firstSendError).toBe(firstSendError);
    },
  );

  it.each([
    { marker: 'attempt count', state: { remoteMessageVerificationAttemptCount: 1 } },
    { marker: 'absent count', state: { remoteMessageVerificationAbsentCount: 1 } },
    { marker: 'present count', state: { remoteMessageVerificationPresentCount: 1 } },
    {
      marker: 'attempted at',
      state: { remoteMessageVerificationAttemptedAt: new Date('2026-07-12T10:00:00.000Z') },
    },
    {
      marker: 'next at',
      state: { remoteMessageVerificationNextAt: new Date('2026-07-12T10:15:00.000Z') },
    },
    {
      marker: 'source',
      state: {
        remoteMessageVerificationSource: PublicationDeliveryVerificationSource.AUTOMATED_STABLE,
      },
    },
  ] satisfies { marker: string; state: Partial<SelectedFinalizerDelivery> }[])(
    'retains D15 verification enrollment from independent $marker',
    async ({ state }) => {
      const now = new Date('2026-07-12T10:05:00.000Z');
      jest.useFakeTimers().setSystemTime(now);
      const harness = createProjectedFinalizerHarness([
        selectedFinalizerDelivery('chat-enrolled', {
          status: ManagedBroadcastDeliveryStatus.SENT,
          remoteMessageId: 'mid-enrolled',
          sentAt: new Date('2026-07-12T10:00:00.000Z'),
          ...state,
        }),
      ]);
      const result = await harness.finalize(harness.row, 1, [], [], null);

      expect(result.status).toBe(ManagedBroadcastStatus.ACTIVE);
      expect(result.sentChatIds).toEqual(['chat-enrolled']);
      expect(result.canRetry).toBe(false);
      expect(result.nextSendAt).toEqual(state.remoteMessageVerificationNextAt ?? now);
      expect(harness.reservationDeleteMany).not.toHaveBeenCalled();
      expect(harness.publish).not.toHaveBeenCalled();
    },
  );

  it.each([ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.SENDING])(
    'keeps D15 %s retry time and wakes at the original deadline',
    async (status) => {
      const now = new Date('2026-07-12T10:05:00.000Z');
      const retryAt = new Date('2026-07-12T10:30:00.000Z');
      const deadlineAt = new Date('2026-07-12T10:10:00.000Z');
      jest.useFakeTimers().setSystemTime(now);
      const harness = createProjectedFinalizerHarness([
        selectedFinalizerDelivery('chat-waiting', { status, nextAttemptAt: retryAt }),
      ]);
      const result = await harness.finalize(harness.row, 1, [], [], null, {
        pendingNotBefore: retryAt,
        deadlineAt,
      });

      expect(result.nextSendAt).toEqual(new Date(deadlineAt.getTime() + 1));
      expect(result.pendingChatIds).toEqual(['chat-waiting']);
      expect(result.canRetry).toBe(false);
      expect(harness.deliveryReader.findMany).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves D15 category order and first-occurrence failure deduplication', async () => {
    const harness = createProjectedFinalizerHarness([
      selectedFinalizerDelivery('pending-b'),
      selectedFinalizerDelivery('failed-b', { status: ManagedBroadcastDeliveryStatus.FAILED }),
      selectedFinalizerDelivery('sent-b', { status: ManagedBroadcastDeliveryStatus.SENT }),
      selectedFinalizerDelivery('canceled-b', { status: ManagedBroadcastDeliveryStatus.CANCELED }),
      selectedFinalizerDelivery('sending-a', { status: ManagedBroadcastDeliveryStatus.SENDING }),
      selectedFinalizerDelivery('ambiguous-b', {
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      }),
      selectedFinalizerDelivery('sent-a', { status: ManagedBroadcastDeliveryStatus.SENT }),
      selectedFinalizerDelivery('failed-a', { status: ManagedBroadcastDeliveryStatus.FAILED }),
      selectedFinalizerDelivery('ambiguous-a', {
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      }),
      selectedFinalizerDelivery('canceled-a', { status: ManagedBroadcastDeliveryStatus.CANCELED }),
    ]);
    const result = await harness.finalize(
      harness.row,
      1,
      [],
      ['ambiguous-b', 'supplied', 'failed-a', 'supplied'],
      null,
    );

    expect(result.sentChatIds).toEqual(['sent-b', 'sent-a']);
    expect(result.pendingChatIds).toEqual(['pending-b', 'sending-a']);
    expect(result.failedChatIds).toEqual([
      'failed-b',
      'failed-a',
      'ambiguous-b',
      'ambiguous-a',
      'canceled-b',
      'canceled-a',
      'supplied',
    ]);
    expect(result.status).toBe(ManagedBroadcastStatus.ACTIVE);
    expect(result.canRetry).toBe(false);
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('uses E4 without a finalizer write after recipient lease ownership is lost', async () => {
    const current: SelectedOccurrence = {
      status: ManagedBroadcastStatus.CANCELED,
      sentCount: 1,
      cycleCount: 2,
      nextSendAt: null,
    };
    const harness = createProjectedFinalizerHarness(
      [
        selectedFinalizerDelivery('chat-pending'),
        selectedFinalizerDelivery('chat-ambiguous', {
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        }),
      ],
      { current },
    );
    const options = {
      lease: {
        lockedAt: new Date('2026-07-12T10:05:00.000Z'),
        lockToken: 'old-lease',
        lastHeartbeatAt: new Date('2026-07-12T10:05:00.000Z'),
      },
    } satisfies FinalizerOptions;
    const prepare = jest
      .spyOn(harness.runtime['publisherDispatch'], 'prepareRecipientFinalization')
      .mockResolvedValue({ leaseOwned: false, hasImmediatelyReadyPendingDelivery: false });
    const result = await harness.finalize(harness.row, 1, ['supplied-sent'], [], null, options);

    expect(prepare).toHaveBeenCalledWith(harness.row, options.lease, [
      selectedFinalizerDelivery('chat-pending'),
    ]);
    expect(result).toMatchObject({
      status: ManagedBroadcastStatus.CANCELED,
      currentOccurrence: 2,
      sentChatIds: ['supplied-sent'],
      failedChatIds: ['chat-ambiguous'],
      pendingChatIds: ['chat-pending'],
      canRetry: false,
    });
    expect(harness.occurrenceReader.findUnique).toHaveBeenCalledTimes(1);
    expect(harness.updateMany).not.toHaveBeenCalled();
    expect(harness.occurrenceUpdateMany).not.toHaveBeenCalled();
    expect(harness.reservationDeleteMany).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it.each([
    { branch: 'pending', status: ManagedBroadcastDeliveryStatus.PENDING, expectedRetry: false },
    { branch: 'failure', status: ManagedBroadcastDeliveryStatus.FAILED, expectedRetry: true },
    { branch: 'completion', status: ManagedBroadcastDeliveryStatus.SENT, expectedRetry: false },
  ])(
    'uses E4 and preserves the winning owner after the $branch finalizer CAS loses',
    async ({ status, expectedRetry }) => {
      const nextSendAt = new Date('2026-07-12T10:30:00.000Z');
      const harness = createProjectedFinalizerHarness(
        [selectedFinalizerDelivery('chat-target', { status })],
        {
          current: {
            status: ManagedBroadcastStatus.PARTIAL,
            sentCount: 1,
            cycleCount: 2,
            nextSendAt,
          },
          updateCount: 0,
        },
      );
      const options = {
        lease: {
          lockedAt: new Date('2026-07-12T10:05:00.000Z'),
          lockToken: 'old-lease',
          lastHeartbeatAt: new Date('2026-07-12T10:05:00.000Z'),
        },
      } satisfies FinalizerOptions;
      jest
        .spyOn(harness.runtime['publisherDispatch'], 'prepareRecipientFinalization')
        .mockResolvedValue({ leaseOwned: true, hasImmediatelyReadyPendingDelivery: true });
      const result = await harness.finalize(harness.row, 1, [], [], null, options);

      expect(harness.updateMany).toHaveBeenCalledTimes(1);
      expect(harness.updateMany).toHaveBeenCalledWith({
        where: {
          id: harness.row.id,
          lockedAt: options.lease.lockedAt,
          lockToken: options.lease.lockToken,
          status: {
            in: [
              ManagedBroadcastStatus.ACTIVE,
              ManagedBroadcastStatus.PARTIAL,
              ManagedBroadcastStatus.FAILED,
            ],
          },
        },
        data: expect.any(Object),
      });
      expect(result.status).toBe(ManagedBroadcastStatus.PARTIAL);
      expect(result.currentOccurrence).toBe(2);
      expect(result.nextSendAt).toBe(nextSendAt);
      expect(result.canRetry).toBe(expectedRetry);
      expect(result.sentChatIds).toEqual(
        status === ManagedBroadcastDeliveryStatus.SENT ? ['chat-target'] : [],
      );
      expect(result.failedChatIds).toEqual(
        status === ManagedBroadcastDeliveryStatus.FAILED ? ['chat-target'] : [],
      );
      expect(result.pendingChatIds).toEqual(
        status === ManagedBroadcastDeliveryStatus.PENDING ? ['chat-target'] : [],
      );
      expect(harness.occurrenceReader.findUnique).toHaveBeenCalledTimes(1);
      expect(harness.occurrenceUpdateMany).not.toHaveBeenCalled();
      expect(harness.reservationDeleteMany).not.toHaveBeenCalled();
      expect(harness.publish).not.toHaveBeenCalled();
    },
  );
});
