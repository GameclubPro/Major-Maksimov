import { randomUUID } from 'node:crypto';
import { ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublicationContentInput } from '@maxim/contracts/publication';
import {
  MaxActionLedgerStatus,
  PrismaClient,
  createPrismaAdapter,
  type Prisma,
} from '../prisma/prisma-client';
import { PublicationService } from './publication.service';
import { rollupPublicationOccurrence } from './publication-occurrence-rollup';
import { ensureManagedBroadcastPublicationExecutionActive } from './publication-execution-recovery';
import { PublicationContentService } from './publication-content.service';
import type { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import {
  PUBLIK_LEDGER_DISPATCH_MARKER,
  reconcileRoutedManagedBroadcastSendingDeliveries,
} from './admin-managed-broadcast-ledger-recovery';
import { buildManagedBroadcastDeliveryActionKey } from './admin-managed-broadcast-reconciliation';
import { AdminManagedBroadcastMediaRuntime } from './admin-managed-broadcast-media-runtime';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import type { PrismaService } from '../prisma/prisma.service';
import { createPublicationExecutionObserver } from './publication-delivery-timing';
import {
  createPendingPublicationContext,
  preparePendingPublicationContext,
} from './publication-target-preparation';
import { PublisherDialogContextService } from './publisher-dialog-context.service';
import { AdminManagedBroadcastMessageRuntime } from './admin-managed-broadcast-message-runtime';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

integration('Publication content freeze and immutable recovery on PostgreSQL', () => {
  let db: PrismaClient;
  let service: PublicationService;
  let chatId: string;
  let publicationId: string;
  let occurrenceId: string;
  let broadcastId: string;
  let deliveryId: string;
  let contentRevisionId: string;
  const botId = `publication-freeze-${randomUUID()}`;
  const user = () => ({ userId: chatId, username: null, displayName: null });
  const oldContent: PublicationContentInput = {
    text: 'Synthetic immutable publication',
    textFormat: 'plain',
    buttons: [],
    media: [],
    postPublish: { pin: 'silent', deleteAfterMinutes: 10 },
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 5, statement_timeout: 10_000 }),
    });
    await db.$connect();
    expect(await db.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone')).toEqual([
      { TimeZone: 'UTC' },
    ]);
  });

  function createService(prisma: PrismaClient = db) {
    const publisherRouting = {
      requireNewRoute: () => ({ dispatchProfile: 'PUBLIK_V1', requiredBotId: botId }),
      resolvePersistedTargets: async () => [
        { chatId, entityType: 'chat', title: 'Synthetic', avatarUrl: null, link: null },
      ],
      assertTargetsReady: async (targets) =>
        targets.map((target) => ({ ...target, requiredBotId: botId, policyRevision: 0 })),
    } satisfies Pick<
      PublicationPublisherRoutingService,
      'requireNewRoute' | 'resolvePersistedTargets' | 'assertTargetsReady'
    >;
    const result = new PublicationService(
      prisma as never,
      new PublicationContentService(prisma as never, {} as never),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      publisherRouting as never,
      { enqueueAfterCommittedMutation: async () => undefined } as never,
      new ConfigService({ PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: 'off' }),
    );
    jest.spyOn(result, 'get').mockResolvedValue({ id: publicationId } as never);
    return result;
  }

  beforeEach(async () => {
    chatId = `publication-freeze-${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Synthetic publication freeze fixture' } });
    await db.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId: chatId,
        botId,
        entityType: 'CHAT',
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        source: 'publication_content_freeze_test',
      },
    });
    const scheduledAt = new Date(Date.now() + 60_000);
    const publication = await db.publication.create({
      data: {
        actorUserId: chatId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        targets: { create: { targetChatId: chatId, entityType: 'CHAT', position: 0 } },
        schedule: {
          create: {
            mode: 'ONCE',
            status: 'ACTIVE',
            rule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: scheduledAt.toISOString(),
              replaceConflicts: false,
            },
          },
        },
        contentRevisions: {
          create: { revision: 1, text: oldContent.text, postPublish: oldContent.postPublish },
        },
      },
      include: { schedule: true, contentRevisions: true },
    });
    publicationId = publication.id;
    contentRevisionId = publication.contentRevisions[0]!.id;
    await db.publication.update({
      where: { id: publicationId },
      data: { canonicalContentRevisionId: contentRevisionId },
    });
    const occurrence = await db.publicationOccurrence.create({
      data: {
        publicationId,
        scheduleId: publication.schedule!.id,
        scheduleRevision: 1,
        contentRevisionId,
        scheduledAt,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
      },
    });
    occurrenceId = occurrence.id;
    const broadcast = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatId,
        actorUserId: chatId,
        text: oldContent.text,
        targetChatIds: [chatId],
        buttons: [],
        publicationOccurrenceId: occurrenceId,
        publicationContentRevisionId: contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        nextSendAt: scheduledAt,
        deliveries: {
          create: {
            occurrenceIndex: 1,
            targetChatId: chatId,
            publicationOccurrenceId: occurrenceId,
            contentRevisionId,
            dispatchProfile: 'PUBLIK_V1',
            requiredBotId: botId,
            dialogBotId: botId,
            publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [] },
            publicationPolicyRevision: 0,
            pinStatus: 'PENDING',
            deleteStatus: 'PENDING',
          },
        },
      },
      include: { deliveries: true },
    });
    broadcastId = broadcast.id;
    deliveryId = broadcast.deliveries[0]!.id;
    service = createService();
  });

  afterEach(async () => {
    await db.maxActionLedgerEntry.deleteMany({ where: { chatId } });
    await db.publicationOccurrence.deleteMany({ where: { publicationId } });
    await db.publication.delete({ where: { id: publicationId } });
    await db.publicationAsset.deleteMany({ where: { actorUserId: chatId } });
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  const normalize = (selectedService: PublicationService = service, limit = 200) =>
    (
      selectedService as unknown as {
        normalizeStalePublicationOccurrences(limit: number): Promise<void>;
      }
    ).normalizeStalePublicationOccurrences(limit);

  async function makePreparedOccurrenceStale() {
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { scheduledAt: new Date(Date.now() - 60_000) },
    });
    await db.publicationSchedule.update({
      where: { publicationId },
      data: { revision: { increment: 1 } },
    });
  }

  it('preserves a saved SENT receipt across schedule replacement before occurrence rollup', async () => {
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENT',
        attemptCount: 1,
        remoteMessageId: 'synthetic-normalizer-receipt',
        sentAt: new Date(),
        remoteMessageVerifiedAt: new Date(),
        botId,
      },
    });
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { status: 'COMPLETED', sentCount: 1 },
    });
    await makePreparedOccurrenceStale();
    await normalize();
    await rollupPublicationOccurrence(db as unknown as PrismaService, occurrenceId);
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ status: 'SENT', scheduleRevision: 1 });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'SENT',
      remoteMessageId: 'synthetic-normalizer-receipt',
      attemptCount: 1,
    });
  });

  it.each(['pause', 'resume'] as const)(
    'preserves an elapsed SENT receipt during %s before its occurrence rollup',
    async (action) => {
      await db.publicationOccurrence.update({
        where: { id: occurrenceId },
        data: { scheduledAt: new Date(Date.now() - 60_000) },
      });
      await db.managedBroadcastDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SENT',
          attemptCount: 1,
          remoteMessageId: `synthetic-${action}-receipt`,
          sentAt: new Date(),
          remoteMessageVerifiedAt: new Date(),
          botId,
        },
      });
      if (action === 'resume') {
        await db.publication.update({
          where: { id: publicationId },
          data: { lifecycle: 'PAUSED' },
        });
        await db.publicationSchedule.update({
          where: { publicationId },
          data: { status: 'PAUSED' },
        });
      }
      await service[action](
        publicationId,
        user(),
        { requestId: randomUUID(), expectedRevision: 1 },
        'PUBLIK_V1',
      );
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
      ).toMatchObject({ status: 'SCHEDULED' });
      await rollupPublicationOccurrence(db as unknown as PrismaService, occurrenceId);
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
      ).toMatchObject({ status: 'SENT' });
    },
  );

  it.each([
    {
      status: 'SENDING',
      attemptCount: 1,
      lockedAt: new Date(),
      lockToken: 'protected-claim',
    },
    { status: 'AMBIGUOUS', attemptCount: 1 },
    { status: 'FAILED', attemptCount: 1 },
    { status: 'FAILED', attemptCount: 0, remoteMessageId: 'retained-receipt' },
    { status: 'FAILED', attemptCount: 0, legacySentWithoutRemoteId: true },
    { status: 'PENDING', attemptCount: 0, lockToken: 'protected-token' },
  ] satisfies Array<Prisma.ManagedBroadcastDeliveryUpdateInput>)(
    'preserves protected execution evidence %# during stale normalization',
    async (data) => {
      await db.managedBroadcastDelivery.update({ where: { id: deliveryId }, data });
      await makePreparedOccurrenceStale();
      await normalize();
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
      ).toMatchObject({ status: 'SCHEDULED' });
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
      ).toMatchObject(data);
    },
  );

  it.each(['claim', 'receipt'] as const)(
    'retains a concurrent %s committed after selection while envelope locking waits',
    async (outcome) => {
      await makePreparedOccurrenceStale();
      const workerReady = gate();
      const releaseWorker = gate();
      const cleanupReachedLock = gate();
      const worker = db.$transaction(async (tx) => {
        await tx.managedBroadcast.update({
          where: { id: broadcastId },
          data: { lockedAt: new Date(), lockToken: 'concurrent-cleanup-worker' },
        });
        await tx.managedBroadcastDelivery.update({
          where: { id: deliveryId },
          data:
            outcome === 'receipt'
              ? {
                  status: 'SENT',
                  attemptCount: 1,
                  remoteMessageId: 'concurrent-cleanup-receipt',
                  sentAt: new Date(),
                }
              : {
                  status: 'SENDING',
                  attemptCount: 1,
                  lockedAt: new Date(),
                  lockToken: 'concurrent-delivery-claim',
                },
        });
        workerReady.resolve();
        await releaseWorker.promise;
      });
      await workerReady.promise;
      const observedDb = new Proxy(db, {
        get(target, key) {
          if (key !== '$transaction') return Reflect.get(target, key);
          return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            target.$transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(client, field) {
                    if (field !== '$queryRaw') return Reflect.get(client, field);
                    return (query: Prisma.Sql) => {
                      if (query.sql.includes('SELECT envelope."id"')) cleanupReachedLock.resolve();
                      return client.$queryRaw(query);
                    };
                  },
                }),
              ),
            );
        },
      });
      const cleaning = normalize(createService(observedDb));
      try {
        await Promise.race([
          cleanupReachedLock.promise,
          cleaning.then(() => {
            throw new Error('Cleanup completed without acquiring the selected envelope lock');
          }),
        ]);
      } finally {
        releaseWorker.resolve();
      }
      await Promise.all([worker, cleaning]);
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
      ).toMatchObject({ status: 'SCHEDULED' });
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
      ).toMatchObject({ status: outcome === 'receipt' ? 'SENT' : 'SENDING', attemptCount: 1 });
    },
  );

  it('cancels an untouched stale occurrence without rewriting its envelope lease heap', async () => {
    await makePreparedOccurrenceStale();
    const before = await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });
    await normalize();
    const after = await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.lockToken).toBeNull();
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ status: 'CANCELED' });
    expect(
      await ensureManagedBroadcastPublicationExecutionActive({
        prisma: db as unknown as PrismaService,
        row: after,
        occurrenceIndex: 1,
      }),
    ).toBe(false);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ attemptCount: 0, remoteMessageId: null });
  });

  it('preserves a mixed SENT and PENDING audience instead of canceling the whole stale date', async () => {
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENT',
        attemptCount: 1,
        remoteMessageId: 'mixed-recipient-receipt',
        sentAt: new Date(),
      },
    });
    const pending = await db.managedBroadcastDelivery.create({
      data: {
        broadcastId,
        occurrenceIndex: 1,
        targetChatId: `synthetic-other-${randomUUID()}`,
        publicationOccurrenceId: occurrenceId,
        contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        dialogBotId: botId,
        publicationPolicyRevision: 0,
        publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [] },
      },
    });
    await makePreparedOccurrenceStale();
    await normalize();
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ status: 'SCHEDULED' });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ status: 'SENT', remoteMessageId: 'mixed-recipient-receipt' });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: pending.id } }),
    ).toMatchObject({ status: 'PENDING', attemptCount: 0 });
  });

  it('keeps historical CANCELED occurrences terminal instead of replaying them from a receipt', async () => {
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { status: 'CANCELED' },
    });
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENT',
        attemptCount: 1,
        remoteMessageId: 'historical-receipt',
        sentAt: new Date(),
      },
    });
    await normalize();
    await rollupPublicationOccurrence(db as unknown as PrismaService, occurrenceId);
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ status: 'CANCELED' });
  });

  it.each([
    { mime: null, durable: false, expected: 'none' },
    { mime: 'image/png', durable: false, expected: 'image' },
    { mime: 'video/mp4', durable: false, expected: 'video' },
    { mime: 'application/octet-stream', durable: false, expected: 'unknown' },
    { mime: 'application/octet-stream', durable: true, expected: 'video' },
  ])(
    'observes $expected from the persisted frozen revision ($mime, durable=$durable)',
    async ({ mime, durable, expected }) => {
      if (mime) {
        await db.publicationAsset.create({
          data: {
            actorUserId: chatId,
            sha256: 'a'.repeat(64),
            mimeType: mime,
            sizeBytes: 10,
            bytes: durable ? null : Buffer.alloc(10),
            ...(durable ? { durablePayload: { token: 'synthetic-retained-video' } } : {}),
            contentLinks: { create: { contentRevisionId, position: 0 } },
          },
        });
      }
      // FLAG: A newer revision must not relabel an already frozen execution envelope.
      const newer = await db.publicationContentRevision.create({
        data: { publicationId, revision: 2, text: 'Synthetic later text-only content' },
      });
      await db.publication.update({
        where: { id: publicationId },
        data: { canonicalContentRevisionId: newer.id },
      });
      const unavailable = (): never => {
        throw new Error('Media metadata observation must not call MAX or authorization helpers');
      };
      const context = {
        publisherTemporalSelectionRollout: 'off',
        prisma: db as PrismaService,
        logger: new Logger('FrozenRevisionObservationTest'),
        get maxClient(): AdminManagedBroadcastRuntimeContext['maxClient'] {
          return unavailable();
        },
        resolveSystemModeSnapshot: unavailable,
        resolveDeliveryBotAssignment: unavailable,
        resolvePrivateDeliveryBotId: unavailable,
        resolvePrivateDialogChatId: unavailable,
        listChatsForMassBroadcast: unavailable,
        assertManagedEntityAdminAccess: unavailable,
        assertManagedEntityReadAccess: unavailable,
        resolveBroadcastButtonContext: unavailable,
      } satisfies AdminManagedBroadcastRuntimeContext;
      const runtime = new AdminManagedBroadcastMediaRuntime(context);
      const row = await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });
      expect(row).toMatchObject({
        imageEnabled: false,
        mediaType: null,
        publicationContentRevisionId: contentRevisionId,
      });
      const log = jest.fn<void, [Record<string, unknown>, string]>();
      const observer = createPublicationExecutionObserver({ log }, row, true);
      expect(observer.dimensions.media).toBe('unknown');
      const executionMedia = await runtime.loadManagedBroadcastExecutionMedia(row);
      expect(executionMedia.requestMedia).toMatchObject({
        imageEnabled: false,
        mediaType: null,
        images: [],
      });
      expect(executionMedia.publicationSource).toMatchObject({
        contentRevisionId,
        actorUserId: chatId,
      });
      for (const asset of executionMedia.publicationSource!.assets)
        expect(asset).not.toHaveProperty('bytes');
      observer.observeExecutionMedia(executionMedia);
      observer.onOccurrenceScheduledAt(row.createdAt, {
        mode: 'NOW',
        intentCreatedAt: row.createdAt,
      });
      observer.observeClaim({ attemptCount: 0 });
      observer.observeAcknowledgement();
      observer.observeReceipt();
      const observations = log.mock.calls.map(([event]) => event);
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every((observation) => observation.media === expected)).toBe(true);
      expect(observations).toContainEqual(
        expect.objectContaining({
          metric: 'publication_wait_v1',
          stage: 'initial_recipient_claim',
          media: expected,
        }),
      );
      expect(observations).toContainEqual(
        expect.objectContaining({ outcome: 'receipt_persisted', media: expected }),
      );
    },
  );

  const update = (selected = service, content: PublicationContentInput = oldContent) =>
    selected.update(
      publicationId,
      user(),
      {
        requestId: `freeze_${randomUUID()}`,
        expectedRevision: 1,
        content,
      },
      'PUBLIK_V1',
    );

  const oldButton = { text: 'Old offer', url: 'https://example.com/old', row: 0 };
  const newButton = { text: 'New offer', url: 'https://example.com/new', row: 0 };
  function dialogPreparation() {
    return {
      prisma: db as never,
      publisherDialogContextService: new PublisherDialogContextService(
        db as never,
        {
          buildChatDialogButton: () => ({
            type: 'callback',
            text: 'Комментарии',
            payload: 'synthetic-comments',
          }),
        } as never,
      ),
    };
  }
  async function seedInitialKeyboard(version: 0 | 1, buttons: (typeof oldButton)[]) {
    // FLAG: Fixture construction precedes every effect; the service edit under test still
    // executes its real bulk UPDATE and PostgreSQL route trigger without a SQL double.
    await db.publicationContentRevision.update({
      where: { id: contentRevisionId },
      data: { buttons },
    });
    const initial = await db.managedBroadcastDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    await db.managedBroadcastDelivery.delete({ where: { id: deliveryId } });
    await db.managedBroadcastDelivery.create({
      data: {
        ...initial,
        publisherDialogContext: createPendingPublicationContext(
          { chatId, entityType: 'chat' },
          botId,
          buttons,
        ),
      },
    });
    await db.publisherEntitySettings.upsert({
      where: { chatId },
      create: { chatId, chatCommentsEnabled: true, chatCommentsPostsEnabled: true },
      update: { chatCommentsEnabled: true, chatCommentsPostsEnabled: true },
    });
    if (version === 1) {
      const delivery = await db.managedBroadcastDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      await preparePendingPublicationContext(dialogPreparation(), delivery, botId);
    }
  }
  async function assertCurrentMessageButtons(buttons: (typeof oldButton)[]) {
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { status: 'IN_PROGRESS' },
    });
    const delivery = await db.managedBroadcastDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    await preparePendingPublicationContext(dialogPreparation(), delivery, botId);
    const row = await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });
    const message = await new AdminManagedBroadcastMessageRuntime(
      {
        resolveBroadcastButtonContext: async () => {
          throw new Error('Unexpected legacy button fallback');
        },
      } as never,
      new Logger('PublicationKeyboardTest'),
    ).buildMessage(chatId, 'chat', row as never, row.text, {} as never, botId, botId, {
      value: delivery.publisherDialogContext,
      required: true,
    });
    const custom =
      message.messageOptions?.buttons?.flat().filter((button) => button.type === 'link') ?? [];
    expect(custom).toEqual(buttons.map(({ text, url }) => ({ type: 'link', text, url })));
    expect(message.commentDialogReference).toMatchObject({
      customButtons: buttons.map(({ text, url }) => ({ text, url })),
      dialogBotId: botId,
      includeCommentsButton: true,
    });
    expect(message.messageOptions?.buttons?.flat()).toContainEqual(
      expect.objectContaining({ type: 'callback', payload: 'synthetic-comments' }),
    );
  }

  it.each(
    ([0, 1] as const).flatMap((version) => [
      { version, action: 'add', before: [], after: [newButton] },
      { version, action: 'change', before: [oldButton], after: [newButton] },
      { version, action: 'remove', before: [oldButton], after: [] },
    ]),
  )(
    'reprepares $action buttons from v$version through the real edit transaction',
    async ({ version, before, after }) => {
      await seedInitialKeyboard(version, before);
      await update(service, { ...oldContent, buttons: after });
      const delivery = await db.managedBroadcastDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(delivery).toMatchObject({
        attemptCount: 0,
        publisherDialogContext: {
          version: 0,
          preparationRevision: 2,
          customButtons: after,
          contentRevisionId: delivery.contentRevisionId,
        },
      });
      await expect(
        db.managedBroadcastDelivery.update({
          where: { id: deliveryId },
          data: { status: 'SENDING', attemptCount: 1 },
        }),
      ).rejects.toThrow();
      await assertCurrentMessageButtons(after);
    },
  );

  it('does not reuse a new preflight winner under a losing legacy content snapshot', async () => {
    await seedInitialKeyboard(0, [oldButton]);
    const stale = await db.managedBroadcastDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const started = gate();
    const release = gate();
    const preparation = dialogPreparation();
    const originalPrepare = preparation.publisherDialogContextService.prepare.bind(
      preparation.publisherDialogContextService,
    );
    jest
      .spyOn(preparation.publisherDialogContextService, 'prepare')
      .mockImplementation(async (input) => {
        const prepared = await originalPrepare(input);
        started.resolve();
        await release.promise;
        return prepared;
      });
    const losing = preparePendingPublicationContext(preparation, stale, botId);
    await started.promise;
    await update(service, { ...oldContent, buttons: [newButton] });
    await assertCurrentMessageButtons([newButton]);
    const rejection = expect(losing).rejects.toThrow('fence');
    release.resolve();
    await rejection;
    expect(stale.contentRevisionId).toBe(contentRevisionId);
    expect(stale.publisherDialogContext).toMatchObject({ version: 0 });
  });

  it.each(['latest', 'original', 'latest-manual'] as const)(
    'preserves attempts and history during %s retry',
    async (mode) => {
      await seedInitialKeyboard(1, [oldButton]);
      const original = await db.managedBroadcastDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      const row = await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });
      const actionKey = buildManagedBroadcastDeliveryActionKey(row, 1, chatId);
      const retainedLedger = await db.maxActionLedgerEntry.create({
        data: {
          jobId: actionKey,
          actionType: 'SEND_MESSAGE',
          chatId,
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          terminal: true,
          dispatchBotId: botId,
          completedAt: new Date(),
        },
      });
      await db.managedBroadcastDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          attemptCount: 3,
          capacityDeferralCount: 7,
          rateLimitDeferralCount: 9,
          ...(mode === 'latest-manual'
            ? {
                remoteMessageId: 'reviewed-absent',
                sentAt: new Date(),
                lastError: 'Администратор подтвердил, что сообщение не было опубликовано.',
              }
            : {}),
        },
      });
      const sentSibling = await db.managedBroadcastDelivery.create({
        data: {
          broadcastId,
          occurrenceIndex: 1,
          targetChatId: `${chatId}-sent`,
          publicationOccurrenceId: occurrenceId,
          contentRevisionId,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: botId,
          dialogBotId: botId,
          publicationPolicyRevision: 0,
          status: 'SENT',
          attemptCount: 1,
          remoteMessageId: 'retained-sibling',
          sentAt: new Date(),
          publisherDialogContext: original.publisherDialogContext as Prisma.InputJsonValue,
        },
      });
      const ambiguousEnvelope = await db.managedBroadcast.create({
        data: {
          sourceChatId: chatId,
          actorUserId: chatId,
          text: oldContent.text,
          buttons: [],
          entityType: 'CHANNEL',
          status: 'FAILED',
          targetChatIds: [`${chatId}-ambiguous`],
          publicationOccurrenceId: occurrenceId,
          publicationContentRevisionId: contentRevisionId,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: botId,
          deliveries: {
            create: {
              occurrenceIndex: 1,
              targetChatId: `${chatId}-ambiguous`,
              publicationOccurrenceId: occurrenceId,
              contentRevisionId,
              dispatchProfile: 'PUBLIK_V1',
              requiredBotId: botId,
              dialogBotId: botId,
              publicationPolicyRevision: 0,
              status: 'AMBIGUOUS',
              attemptCount: 1,
              publisherDialogContext: original.publisherDialogContext as Prisma.InputJsonValue,
            },
          },
        },
        include: { deliveries: true },
      });
      const ambiguousSibling = ambiguousEnvelope.deliveries[0]!;
      await db.managedBroadcast.update({ where: { id: broadcastId }, data: { status: 'PARTIAL' } });
      await db.publicationOccurrence.update({
        where: { id: occurrenceId },
        data: { status: 'PARTIAL' },
      });
      const latest = await db.publicationContentRevision.create({
        data: { publicationId, revision: 2, text: oldContent.text, buttons: [newButton] },
      });
      await db.publication.update({
        where: { id: publicationId },
        data: { canonicalContentRevisionId: latest.id },
      });
      await service.retryOccurrence(
        publicationId,
        occurrenceId,
        user(),
        {
          requestId: `retry_${randomUUID()}`,
          contentMode: mode === 'original' ? 'original' : 'latest',
          ...(mode === 'original'
            ? {}
            : { expectedPublicationVersion: 1, expectedContentRevision: 2 }),
        },
        'PUBLIK_V1',
      );
      const retried = await db.managedBroadcastDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      expect(retried).toMatchObject({
        status: 'PENDING',
        attemptCount: 3,
        capacityDeferralCount: 7,
        rateLimitDeferralCount: 9,
        remoteMessageId: null,
        sentAt: null,
      });
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: sentSibling.id } }),
      ).toEqual(sentSibling);
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: ambiguousSibling.id } }),
      ).toEqual(ambiguousSibling);
      expect(await db.maxActionLedgerEntry.findUnique({ where: { jobId: actionKey } })).toEqual(
        retainedLedger,
      );
      if (mode === 'original') {
        expect(retried.publisherDialogContext).toEqual(original.publisherDialogContext);
        expect(retried.contentRevisionId).toBe(contentRevisionId);
      } else {
        expect(retried.publisherDialogContext).toMatchObject({
          version: 0,
          preparationRevision: 2,
          contentRevisionId: latest.id,
        });
        await db.publicationOccurrence.update({
          where: { id: occurrenceId },
          data:
            mode === 'latest'
              ? { dispatchBlockerCode: null, dispatchBlockedAt: null }
              : { dispatchBlockerCode: 'PUBLISHER_BOT_NOT_ADMIN' },
        });
        await assertCurrentMessageButtons([newButton]);
        expect(
          (await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }))
            .attemptCount,
        ).toBe(3);
      }
    },
  );

  it('cancels expired attempted intent and renews the exact same-content retry authority', async () => {
    await seedInitialKeyboard(1, [oldButton]);
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: { status: 'FAILED', attemptCount: 3 },
    });
    await db.managedBroadcast.update({ where: { id: broadcastId }, data: { status: 'FAILED' } });
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { status: 'FAILED' },
    });
    const latest = await db.publicationContentRevision.create({
      data: { publicationId, revision: 2, text: oldContent.text, buttons: [newButton] },
    });
    await db.publication.update({
      where: { id: publicationId },
      data: { canonicalContentRevisionId: latest.id },
    });
    await service.retryOccurrence(
      publicationId,
      occurrenceId,
      user(),
      {
        requestId: `retry_${randomUUID()}`,
        contentMode: 'latest',
        expectedPublicationVersion: 1,
        expectedContentRevision: 2,
      },
      'PUBLIK_V1',
    );
    const pending = await db.managedBroadcastDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: {
        retryAuthorizedAt: new Date(Date.now() - 120_000),
        retryExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    await expect(
      preparePendingPublicationContext(dialogPreparation(), pending, botId),
    ).rejects.toThrow('fence');
    await expect(
      db.managedBroadcastDelivery.update({
        where: { id: deliveryId },
        data: {
          publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [], reference: null },
        },
      }),
    ).rejects.toThrow('immutable');
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: { status: 'CANCELED' },
    });
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: { status: 'FAILED' },
    });
    await db.managedBroadcast.update({ where: { id: broadcastId }, data: { status: 'FAILED' } });
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { status: 'FAILED' },
    });
    await service.retryOccurrence(
      publicationId,
      occurrenceId,
      user(),
      { requestId: `renew_${randomUUID()}`, contentMode: 'original' },
      'PUBLIK_V1',
    );
    const renewed = await db.managedBroadcastDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const occurrence = await db.publicationOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
    });
    expect(renewed).toMatchObject({
      attemptCount: 3,
      contentRevisionId: latest.id,
      publisherDialogContext: {
        version: 0,
        retryAuthorizedAtMs: occurrence.retryAuthorizedAt!.getTime(),
        retryExpiresAtMs: occurrence.retryExpiresAt!.getTime(),
      },
    });
    await assertCurrentMessageButtons([newButton]);
  });

  async function prepareCalendarReservation(
    at = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000),
  ) {
    await db.publicationSchedule.update({
      where: { publicationId },
      data: {
        rule: { mode: 'once', timezone: 'UTC', at: at.toISOString(), replaceConflicts: false },
      },
    });
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { scheduledAt: at },
    });
    await db.managedBroadcast.update({ where: { id: broadcastId }, data: { nextSendAt: at } });
    await db.managedBroadcastCalendarReservation.create({
      data: {
        broadcastId,
        sourceChatId: chatId,
        targetChatId: chatId,
        occurrenceIndex: 1,
        scheduledAt: at,
      },
    });
    return at;
  }

  it('edits a prepared schedule without conflicting with its own retained slot', async () => {
    const at = await prepareCalendarReservation();
    const later = new Date(at.getTime() + 60_000);
    await expect(
      service.update(
        publicationId,
        user(),
        {
          requestId: `calendar_${randomUUID()}`,
          expectedRevision: 1,
          schedule: {
            mode: 'slots',
            timezone: 'UTC',
            slots: [at.toISOString(), later.toISOString()],
            replaceConflicts: false,
          },
          intent: 'publish',
        },
        'PUBLIK_V1',
      ),
    ).resolves.toMatchObject({ id: publicationId });
    expect(
      await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({
      revision: 2,
      mode: 'SLOTS',
    });
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({
      status: 'CANCELED',
    });
    expect(
      await db.publicationOccurrence.findMany({
        where: { publicationId, scheduleRevision: 2 },
        orderBy: { scheduledAt: 'asc' },
        select: { scheduledAt: true, status: true },
      }),
    ).toEqual([
      { scheduledAt: at, status: 'SCHEDULED' },
      { scheduledAt: later, status: 'SCHEDULED' },
    ]);
    expect(await db.managedBroadcastCalendarReservation.count({ where: { broadcastId } })).toBe(0);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'CANCELED',
      attemptCount: 0,
      remoteMessageId: null,
    });
  });

  it("retains another publication's prepared calendar conflict", async () => {
    const at = await prepareCalendarReservation();
    await expect(
      (
        service as unknown as {
          assertCalendarAvailability(
            targets: Array<{ chatId: string; entityType: 'chat' }>,
            slots: Date[],
            schedule: unknown,
            actorUserId: string,
            excludePublicationId: string,
          ): Promise<void>;
        }
      ).assertCalendarAvailability(
        [{ chatId, entityType: 'chat' }],
        [at],
        { mode: 'once', timezone: 'UTC', at: at.toISOString(), replaceConflicts: false },
        chatId,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ response: { code: 'PUBLICATION_SCHEDULE_CONFLICT' } });
    expect(await db.managedBroadcastCalendarReservation.count({ where: { broadcastId } })).toBe(1);
  });

  it.each(
    (['SENDING', 'SENT', 'AMBIGUOUS'] as const).flatMap((status) =>
      [false, true].map((replaceConflicts) => ({ status, replaceConflicts })),
    ),
  )(
    'refuses a retained $status slot even with replaceConflicts=$replaceConflicts',
    async ({ status, replaceConflicts }) => {
      const at = await prepareCalendarReservation(
        new Date(Math.floor((Date.now() - 60_000) / 60_000) * 60_000),
      );
      await db.publicationOccurrence.update({
        where: { id: occurrenceId },
        data: { status: status === 'SENT' ? 'SENT' : 'IN_PROGRESS' },
      });
      await db.managedBroadcastDelivery.update({
        where: { id: deliveryId },
        data: {
          status,
          attemptCount: 1,
          botId,
          lockedAt: status === 'SENDING' ? new Date() : null,
          lockToken: status === 'SENDING' ? 'synthetic-retained-claim' : null,
          remoteMessageId: status === 'SENT' ? 'synthetic-confirmed-message' : null,
          sentAt: status === 'SENT' ? new Date() : null,
        },
      });
      if (status === 'SENT') {
        await db.managedBroadcastCalendarReservation.deleteMany({ where: { broadcastId } });
        await db.managedBroadcast.update({
          where: { id: broadcastId },
          data: { status: 'COMPLETED', sentCount: 1, nextSendAt: null },
        });
      }
      const evidence = await db.managedBroadcastDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      await expect(
        service.update(
          publicationId,
          user(),
          {
            requestId: `retained_${randomUUID()}`,
            expectedRevision: 1,
            schedule: {
              mode: 'slots',
              timezone: 'UTC',
              slots: [at.toISOString(), new Date(at.getTime() + 600_000).toISOString()],
              replaceConflicts,
            },
            intent: 'publish',
          },
          'PUBLIK_V1',
        ),
      ).rejects.toMatchObject({
        response: { code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' },
      });
      expect(
        await db.publication.findUniqueOrThrow({ where: { id: publicationId } }),
      ).toMatchObject({ version: 1 });
      expect(
        await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } }),
      ).toMatchObject({ revision: 1 });
      expect(await db.publicationOccurrence.count({ where: { publicationId } })).toBe(1);
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
      ).toEqual(evidence);
    },
  );

  it("preserves a paused parent's prior-revision receipt after its reservation was released", async () => {
    const at = await prepareCalendarReservation(
      new Date(Math.floor((Date.now() - 60_000) / 60_000) * 60_000),
    );
    await db.publication.update({ where: { id: publicationId }, data: { lifecycle: 'PAUSED' } });
    await db.publicationSchedule.update({
      where: { publicationId },
      data: { status: 'PAUSED', revision: 2 },
    });
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { status: 'SENT' },
    });
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENT',
        attemptCount: 1,
        botId,
        remoteMessageId: 'synthetic-paused-receipt',
        sentAt: new Date(),
      },
    });
    await db.managedBroadcastCalendarReservation.deleteMany({ where: { broadcastId } });
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { status: 'COMPLETED', sentCount: 1, nextSendAt: null },
    });
    await expect(
      service.update(
        publicationId,
        user(),
        {
          requestId: `paused_${randomUUID()}`,
          expectedRevision: 1,
          schedule: {
            mode: 'slots',
            timezone: 'UTC',
            slots: [at.toISOString()],
            replaceConflicts: true,
          },
          intent: 'publish',
        },
        'PUBLIK_V1',
      ),
    ).rejects.toMatchObject({ response: { code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' } });
    expect(await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).toMatchObject({
      lifecycle: 'PAUSED',
      version: 1,
    });
    expect(
      await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ revision: 2, status: 'PAUSED' });
    expect(await db.publicationOccurrence.count({ where: { publicationId } })).toBe(1);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'SENT',
      attemptCount: 1,
      remoteMessageId: 'synthetic-paused-receipt',
    });
  });

  it('replaces an elapsed retained slot only when its in-progress envelope is untouched', async () => {
    const at = await prepareCalendarReservation(
      new Date(Math.floor((Date.now() - 60_000) / 60_000) * 60_000),
    );
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: { status: 'IN_PROGRESS' },
    });
    await expect(
      service.update(
        publicationId,
        user(),
        {
          requestId: `untouched_${randomUUID()}`,
          expectedRevision: 1,
          schedule: {
            mode: 'slots',
            timezone: 'UTC',
            slots: [at.toISOString()],
            replaceConflicts: false,
          },
          intent: 'publish',
        },
        'PUBLIK_V1',
      ),
    ).resolves.toMatchObject({ id: publicationId });
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ status: 'CANCELED' });
    expect(await db.managedBroadcastCalendarReservation.count({ where: { broadcastId } })).toBe(0);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ status: 'CANCELED', attemptCount: 0, remoteMessageId: null });
    expect(
      await db.publicationOccurrence.count({
        where: { publicationId, scheduleRevision: 2, scheduledAt: at, status: 'SCHEDULED' },
      }),
    ).toBe(1);
  });

  it('rechecks a retained slot claimed after preflight and rolls back the new schedule', async () => {
    const at = await prepareCalendarReservation();
    let claimed = false;
    const racingDb = new Proxy(db, {
      get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key);
        return async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          await db.managedBroadcastDelivery.update({
            where: { id: deliveryId },
            data: {
              status: 'SENDING',
              attemptCount: 1,
              lockedAt: new Date(),
              lockToken: 'synthetic-preflight-race',
            },
          });
          claimed = true;
          return target.$transaction(run);
        };
      },
    });
    await expect(
      createService(racingDb).update(
        publicationId,
        user(),
        {
          requestId: `calendar_race_${randomUUID()}`,
          expectedRevision: 1,
          schedule: {
            mode: 'slots',
            timezone: 'UTC',
            slots: [at.toISOString(), new Date(at.getTime() + 60_000).toISOString()],
            replaceConflicts: true,
          },
          intent: 'publish',
        },
        'PUBLIK_V1',
      ),
    ).rejects.toMatchObject({ response: { code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' } });
    expect(claimed).toBe(true);
    expect(await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).toMatchObject({
      version: 1,
    });
    expect(
      await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } }),
    ).toMatchObject({ revision: 1 });
    expect(await db.publicationOccurrence.count({ where: { publicationId } })).toBe(1);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ status: 'SENDING', attemptCount: 1, lockToken: 'synthetic-preflight-race' });
  });

  function interceptEnvelopeUpdate(hook: (run: () => Promise<unknown>) => Promise<unknown>) {
    return new Proxy(db, {
      get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(
            (tx) =>
              callback(
                new Proxy(tx, {
                  get(client, field) {
                    if (field !== 'managedBroadcast') return Reflect.get(client, field);
                    return new Proxy(client.managedBroadcast, {
                      get(delegate, method) {
                        if (method !== 'updateMany') return Reflect.get(delegate, method);
                        return (args: Parameters<typeof delegate.updateMany>[0]) =>
                          hook(() => delegate.updateMany(args));
                      },
                    });
                  },
                }),
              ),
            { timeout: 15_000 },
          );
      },
    });
  }

  it('rejects an identical-content save after an envelope claim and preserves its post-actions', async () => {
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { lockedAt: new Date(), lockToken: 'synthetic-worker' },
    });
    await expect(update()).rejects.toBeInstanceOf(ConflictException);
    expect(await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).toMatchObject({
      version: 1,
      canonicalContentRevisionId: contentRevisionId,
    });
    expect(await db.publicationContentRevision.count({ where: { publicationId } })).toBe(1);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'PENDING',
      contentRevisionId,
      pinStatus: 'PENDING',
      deleteStatus: 'PENDING',
    });
  });

  it('rolls the entire edit back when a worker claim commits after the edit reads an unleased envelope', async () => {
    const claimed = gate();
    const release = gate();
    const editReachedUpdate = gate();
    const worker = db.$transaction(async (tx) => {
      await tx.managedBroadcast.updateMany({
        where: { id: broadcastId, lockedAt: null },
        data: { lockedAt: new Date(), lockToken: 'concurrent-worker' },
      });
      claimed.resolve();
      await release.promise;
    });
    await claimed.promise;
    const editingService = createService(
      interceptEnvelopeUpdate(async (run) => {
        editReachedUpdate.resolve();
        return run();
      }),
    );
    const edit = update(editingService);
    const rejected = expect(edit).rejects.toBeInstanceOf(ConflictException);
    try {
      await editReachedUpdate.promise;
    } finally {
      release.resolve();
    }
    await worker;
    await rejected;
    expect(await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).toMatchObject({
      version: 1,
      canonicalContentRevisionId: contentRevisionId,
    });
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ contentRevisionId });
    expect(
      await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } }),
    ).toMatchObject({
      publicationContentRevisionId: contentRevisionId,
      lockToken: 'concurrent-worker',
    });
  });

  it('lets a later worker claim only the committed new envelope, delivery revision and post-action policy', async () => {
    const frozen = gate();
    const release = gate();
    const editingService = createService(
      interceptEnvelopeUpdate(async (run) => {
        const result = await run();
        frozen.resolve();
        await release.promise;
        return result;
      }),
    );
    const edit = update(editingService, {
      ...oldContent,
      text: 'New synthetic content',
      postPublish: { pin: 'none', deleteAfterMinutes: null },
    });
    await frozen.promise;
    const worker = db.managedBroadcast.updateMany({
      where: { id: broadcastId, lockedAt: null },
      data: { lockedAt: new Date(), lockToken: 'after-edit-worker' },
    });
    release.resolve();
    await edit;
    expect((await worker).count).toBe(1);
    const publication = await db.publication.findUniqueOrThrow({ where: { id: publicationId } });
    expect(publication.canonicalContentRevisionId).not.toBe(contentRevisionId);
    expect(
      await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } }),
    ).toMatchObject({
      text: 'New synthetic content',
      publicationContentRevisionId: publication.canonicalContentRevisionId,
      lockToken: 'after-edit-worker',
    });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      contentRevisionId: publication.canonicalContentRevisionId,
      pinStatus: 'NONE',
      deleteStatus: 'NONE',
      postActionsNextAt: null,
    });
  });

  it('recovers an old immutable receipt after a historical envelope revision change, including after cancellation', async () => {
    const original = await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });
    const actionKey = buildManagedBroadcastDeliveryActionKey(original, 1, chatId);
    const newRevision = await db.publicationContentRevision.create({
      data: { publicationId, revision: 2, text: 'Changed envelope content' },
    });
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { publicationContentRevisionId: newRevision.id, text: newRevision.text },
    });
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENDING',
        attemptCount: 1,
        lockedAt: new Date(),
        lockToken: 'lost-worker',
        lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
      },
    });
    await db.maxActionLedgerEntry.create({
      data: {
        jobId: actionKey,
        actionType: 'SEND_MESSAGE',
        chatId,
        status: 'SUCCEEDED',
        terminal: true,
        dispatchBotId: botId,
        remoteMessageId: 'synthetic-old-receipt',
        completedAt: new Date(),
        metadata: { ledgerContext: { managedBroadcast: { commentDialogReference: null } } },
      },
    });
    await service.cancel(
      publicationId,
      user(),
      { requestId: `cancel_${randomUUID()}`, expectedRevision: 1 },
      'PUBLIK_V1',
    );
    const recordDialogReference = jest.fn();
    await reconcileRoutedManagedBroadcastSendingDeliveries({
      prisma: db as never,
      messageRuntime: { recordDialogReference },
      broadcastId,
      occurrenceIndex: 1,
    });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'SENT',
      attemptCount: 1,
      contentRevisionId,
      remoteMessageId: 'synthetic-old-receipt',
      botId,
      pinStatus: 'PENDING',
      deleteStatus: 'PENDING',
    });
    expect(recordDialogReference).toHaveBeenCalledWith(
      expect.objectContaining({ text: oldContent.text, messageId: 'synthetic-old-receipt' }),
    );
  });

  it('quarantines a Publication delivery with missing immutable revision instead of creating a new send key', async () => {
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENDING',
        attemptCount: 1,
        contentRevisionId: null,
        lockedAt: new Date(),
        lockToken: 'lost-worker',
        lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
      },
    });
    await reconcileRoutedManagedBroadcastSendingDeliveries({
      prisma: db as never,
      messageRuntime: { recordDialogReference: jest.fn() },
      broadcastId,
      occurrenceIndex: 1,
    });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ status: 'AMBIGUOUS', attemptCount: 1, contentRevisionId: null });
  });
});
