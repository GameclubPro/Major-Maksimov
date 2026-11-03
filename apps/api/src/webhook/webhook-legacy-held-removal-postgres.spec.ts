import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import { buildGroupCommandKey } from '../common/group-command-key';
import { GroupCommandAuthorityService } from '../common/group-command-authority.service';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import { Prisma, type WebhookEvent } from '../prisma/prisma-client';
import {
  PublisherAutoReplyEnqueuePendingError,
  PublisherAutoReplyProducerService,
} from '../publisher/publisher-auto-reply-producer.service';
import {
  PUBLISHER_AUTO_REPLY_SOURCE_FENCE_TESTING,
  PublisherAutoReplySourceFenceService,
  PublisherAutoReplySourceReceiptHeldError,
} from '../publisher/publisher-auto-reply-source-fence.service';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import {
  buildLegacyRecoveryPreviewDigest,
  createLegacyColdCertificate,
  inspectLegacyRecoveryCandidate,
  installAndSealLegacyRecoveryBatch,
  installLegacyRecoveryBatch,
  legacySnapshotDigest,
  type LegacyRecoveryCandidate,
} from './webhook-legacy-cold-install';
import { legacyReceiptSourceDigest } from './webhook-legacy-receipt-disposition';
import type { WebhookLegacyHoldService } from './webhook-legacy-hold.service';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { tryLockWebhookSemanticClaimFences } from './webhook-semantic-claim-fence';
import { WebhookParser } from './webhook.parser';
import { WebhookService } from './webhook.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
const heldRetry = 'Webhook preparation deferred: Legacy scope installation is not sealed';

// FLAG: Installation helpers below run only in disposable native stores. They create
// test evidence, never a production recovery path. Runtime admission, claims, receipt
// proofs, queue selection and simulated moderation use their real implementations.
native('native post-seal held message removal without replay', () => {
  jest.setTimeout(60_000);
  let h: MultibotHarness | undefined;
  let cutoff: Date;
  let chatId: string;
  const certificates: string[] = [];
  const extraClaims: string[] = [];
  const publisherRules: string[] = [];
  const previousOffline = process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;

  beforeAll(() => {
    for (const [value, database] of [
      [databaseUrl, true],
      [redisUrl, false],
    ] as const) {
      const url = new URL(value);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        (database && !url.pathname.includes('race_test'))
      )
        throw new Error('Held-removal regressions require disposable loopback stores');
    }
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
  });

  beforeEach(async () => {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' });
    await h.pause();
    Object.assign(h.ingress, {
      rawPayloadSampleRate: 1,
      messageRetention: new MessageRetentionStore(h.prisma as never, h.config, h.legacyHolds),
    });
    const [identity] = await h.prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
    expect(process.env.TZ).toBe('UTC');
    cutoff = (
      await h.prisma.$queryRaw<Array<{ at: Date }>>`
      SELECT finished_at AS at FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC LIMIT 1`
    )[0]!.at;
    chatId = (await h.seedCatalog(1, { maxMessageLengthEnabled: false }))[0]!;
  });

  afterEach(async () => {
    const s = h;
    h = undefined;
    if (!s) return;
    const ownedCertificates = certificates.splice(0);
    const ownedClaims = extraClaims.splice(0);
    const ownedRules = publisherRules.splice(0);
    try {
      // FLAG: Only the guarded disposable race database permits evidence teardown.
      // Keep replica mode transaction-local and delete only this fixture's exact IDs;
      // the permanent production guards remain enabled throughout all assertions.
      await s.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
        await tx.publisherAutoReplyDelivery.deleteMany({
          where: { ruleId: { in: ownedRules } },
        });
        await tx.publisherAutoReplyRule.updateMany({
          where: { id: { in: ownedRules } },
          data: { currentContentRevisionId: null },
        });
        await tx.publisherAutoReplyRule.deleteMany({ where: { id: { in: ownedRules } } });
        await tx.webhookExecutionClaim.deleteMany({
          where: { OR: [{ id: { in: ownedClaims } }, { webhookEventId: { in: s.receiptIds } }] },
        });
        await tx.webhookEvent.deleteMany({ where: { id: { in: s.receiptIds } } });
        await tx.webhookLegacyReceiptDisposition.deleteMany({
          where: { receiptId: { in: s.receiptIds } },
        });
        for (const certificateId of ownedCertificates) {
          await tx.webhookLegacyMaterializationCursor.deleteMany({ where: { certificateId } });
          await tx.webhookLegacySealedAuthority.deleteMany({ where: { certificateId } });
          await tx.webhookLegacyChildHold.deleteMany({ where: { certificateId } });
          await tx.webhookLegacyRecovery.deleteMany({ where: { certificateId } });
          await tx.webhookLegacyQuiescenceCertificate.deleteMany({ where: { id: certificateId } });
        }
      });
    } finally {
      jest.restoreAllMocks();
      await s.dispose();
    }
  });

  afterAll(() => {
    if (previousOffline === undefined) delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    else process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = previousOffline;
  });

  function state() {
    if (!h) throw new Error('Native fixture is not initialized');
    return h;
  }

  async function corruptFixture(work: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    // FLAG: Defense-in-depth fixtures deliberately model corrupted retained evidence.
    // This superuser operation is restricted by the suite's loopback/race_test guards;
    // transaction-local replica mode cannot escape to the runtime or next assertion.
    await state().prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
      await work(tx);
    });
  }

  async function store(update: MaxUpdate) {
    const s = state();
    const result = await s.ingress.storeReceipt(update, null);
    expect(result.duplicate).toBe(false);
    expect(result.webhookEventId).toBeTruthy();
    s.receiptIds.push(result.webhookEventId!);
    return s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: result.webhookEventId! } });
  }

  async function owner(userId = `held-actor-${randomUUID()}`, ownerChatId = chatId) {
    const s = state();
    const at = cutoff.getTime() - 5_000;
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        update_id: randomUUID(),
        timestamp: at,
        message: {
          sender: { user_id: userId, name: 'Native fixture', is_bot: false },
          recipient: { chat_id: ownerChatId, chat_type: 'chat' },
          timestamp: at,
          body: { mid: randomUUID(), text: 'Original ordinary source' },
        },
      },
      { botId: s.bots[0]!.id },
    );
    const receipt = await store(update);
    const saved = await s.prisma.webhookEvent.update({
      where: { id: receipt.id },
      data: {
        status: 'FAILED',
        createdAt: new Date(at + 1_000),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    await s.prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: saved.semanticKey!,
        webhookEventId: saved.id,
        enforced: false,
        createdAt: saved.createdAt,
      },
    });
    const candidate = await inspectLegacyRecoveryCandidate(
      s.prisma,
      saved.id,
      s.bots.map((b) => b.id),
    );
    expect(candidate).not.toBeNull();
    return candidate!;
  }

  async function seal(candidates: LegacyRecoveryCandidate[], sealed = true) {
    const s = state();
    const sourceSha = 'b'.repeat(40);
    const imageId = `sha256:${'a'.repeat(64)}`;
    const certificate = await createLegacyColdCertificate(s.prisma, {
      version: 1,
      sourceSha,
      imageId,
      transitionJournalSha256: 'c'.repeat(64),
      previewSha256: buildLegacyRecoveryPreviewDigest(candidates, []),
      queueFenceNonce: 'disposable-held-removal-fixture',
      roleSnapshots: RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all').map(
        (serviceName) => ({
          serviceName,
          containerId: legacySnapshotDigest(serviceName),
          sourceSha,
          imageId,
          stopped: true,
        }),
      ),
    });
    certificates.push(certificate.id);
    if (sealed) {
      await installAndSealLegacyRecoveryBatch(s.prisma, certificate.id, candidates, []);
    } else await installLegacyRecoveryBatch(s.prisma, certificate.id, candidates, []);
    // Distinct receipt and seal clocks avoid truncating native SQL microseconds to equality.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return s.prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
      where: { id: certificate.id },
    });
  }

  function removal(source: LegacyRecoveryCandidate, rawPatch: Record<string, unknown> = {}) {
    return new WebhookParser().parse(
      {
        update_type: 'message_removed',
        update_id: randomUUID(),
        timestamp: Date.now(),
        chat_id: source.source.chatId,
        message_id: source.source.messageId,
        user_id: source.source.userId,
        ...rawPatch,
      },
      { botId: state().bots[0]!.id },
    );
  }

  function heldImage(source: LegacyRecoveryCandidate, text?: string) {
    const at = Date.now();
    return new WebhookParser().parse(
      {
        update_type: 'message_created',
        update_id: randomUUID(),
        timestamp: at,
        message: {
          sender: { user_id: source.source.userId, is_bot: false },
          recipient: { chat_id: source.source.chatId, chat_type: 'chat' },
          timestamp: at,
          body: {
            mid: randomUUID(),
            ...(text === undefined ? {} : { text }),
            attachments: [
              { type: 'image', payload: { photo_id: 42, url: 'https://i.oneme.ru/fixture' } },
            ],
          },
        },
      },
      { botId: state().bots[0]!.id },
    );
  }

  function memberRemoval(source: LegacyRecoveryCandidate) {
    return new WebhookParser().parse(
      {
        update_type: 'user_removed',
        update_id: randomUUID(),
        timestamp: Date.now(),
        chat_id: source.source.chatId,
        user: { user_id: source.source.userId, name: 'Removed member', is_bot: false },
        admin_id: 'independent-removal-actor',
      },
      { botId: state().bots[0]!.id },
    );
  }

  it('recovers a pristine held user_removed only after preserving membership denial', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    Object.assign(s.ingress, { chatContextCache: s.cache, membershipLookupService: s.membership });
    const checkedAt = new Date(Date.now() - 1_000);
    await s.prisma.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId: source.source.userId,
        botId: s.bots[0]!.id,
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        checkedAt,
      },
    });
    await s.prisma.chatAdminAllowlist.create({ data: { chatId, userId: source.source.userId } });
    await s.prisma.managedEntityAdminMember.create({
      data: { chatId, userId: source.source.userId, observedByBotId: s.bots[0]!.id, checkedAt },
    });
    const update = memberRemoval(source);
    const before = await stage(update, { errorMessage: heldRetry });
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const invalidate = jest.spyOn(s.membership, 'invalidateMemberships');
    expect(await s.ingress.preparePersistedWebhookEvent(before.id)).toMatchObject({
      canonical: false,
      prepared: false,
      enforced: true,
    });
    const after = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({
      status: 'NO_REPLAY_HELD',
      processedAt: null,
      errorMessage: heldRetry,
    });
    expect(after.normalizedPayload).toEqual(before.normalizedPayload);
    expect(after.rawPayload).toEqual(before.rawPayload);
    expect(
      await s.prisma.managedEntityAccessEdge.findFirstOrThrow({
        where: { chatId, userId: source.source.userId },
      }),
    ).toMatchObject({ state: 'USER_DENIED', source: 'webhook_user_removed' });
    expect(
      await s.prisma.managedEntityAdminMember.count({
        where: { chatId, userId: source.source.userId },
      }),
    ).toBe(0);
    expect(
      await s.prisma.chatAdminAllowlist.count({ where: { chatId, userId: source.source.userId } }),
    ).toBe(0);
    expect(
      await s.prisma.chatMembershipActivityEvent.count({
        where: { chatId, userId: source.source.userId, eventType: 'user_removed' },
      }),
    ).toBe(1);
    expect(invalidate).toHaveBeenCalledWith(chatId, [source.source.userId]);
    await s.ingress.preparePersistedWebhookEvent(before.id);
    await s.moderation.processWebhookEvent(before.id);
    expect(handler).not.toHaveBeenCalled();
    expect(
      await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: before.id } }),
    ).toBe(0);
    expect(await s.legacyHolds.isGlobalUserHeld(source.source.userId)).toBe(true);
    expect(
      await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: source.claim.id } }),
    ).toEqual(source.claim);
    expect(s.requests).toEqual([]);
    expect(s.effects).toEqual([]);
  });

  it.each(['member cache', 'access epoch'] as const)(
    'retries held user_removed after %s failure and a fresh preparation process',
    async (failure) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      Object.assign(s.ingress, {
        chatContextCache: s.cache,
        membershipLookupService: s.membership,
      });
      const update = memberRemoval(source);
      const receipt = await stage(update, { errorMessage: heldRetry });
      const failing =
        failure === 'member cache'
          ? jest
              .spyOn(s.membership, 'invalidateMemberships')
              .mockRejectedValueOnce(new Error('synthetic cache outage'))
          : jest
              .spyOn(s.cache, 'applyAdminAccessEpochMutation')
              .mockRejectedValueOnce(new Error('synthetic epoch outage'));
      await expect(s.ingress.preparePersistedWebhookEvent(receipt.id)).rejects.toThrow(
        'Legacy scope installation is not sealed',
      );
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
        receipt,
      );
      expect(
        await s.prisma.webhookLegacyReceiptDisposition.count({ where: { receiptId: receipt.id } }),
      ).toBe(0);
      failing.mockRestore();
      const restarted = new WebhookService(s.prisma as never, s.config, s.links);
      Object.assign(restarted, {
        legacyHolds: s.legacyHolds,
        chatContextCache: s.cache,
        membershipLookupService: s.membership,
      });
      try {
        await expect(restarted.preparePersistedWebhookEvent(receipt.id)).resolves.toMatchObject({
          canonical: false,
          prepared: false,
        });
      } finally {
        await restarted.onModuleDestroy();
      }
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } }),
      ).toMatchObject({ status: 'NO_REPLAY_HELD' });
      expect(
        await s.prisma.chatMembershipActivityEvent.count({
          where: { chatId, userId: source.source.userId, eventType: 'user_removed' },
        }),
      ).toBe(1);
      expect(s.requests).toEqual([]);
      expect(s.effects).toEqual([]);
    },
  );

  it.each(['missing key', 'publisher key', 'nullable official fields', 'channel'] as const)(
    'handles held membership removal with %s through real preparation',
    async (variant) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      Object.assign(s.ingress, {
        chatContextCache: s.cache,
        membershipLookupService: s.membership,
      });
      let update = memberRemoval(source);
      if (variant === 'nullable official fields' || variant === 'channel') {
        update = new WebhookParser().parse(
          {
            ...update.raw,
            admin_id: null,
            is_channel: variant === 'channel',
            user: {
              user_id: source.source.userId,
              is_bot: false,
              first_name: 'Member',
              last_name: null,
              username: null,
              name: null,
            },
          },
          { botId: update.botId },
        );
      }
      const receipt =
        variant === 'channel'
          ? await store(update)
          : await stage(update, {
              rawPayload: {},
              errorMessage: heldRetry,
              ...(variant === 'missing key' ? { semanticKey: null } : {}),
              ...(variant === 'publisher key'
                ? { semanticKey: buildWebhookReceiptSemanticKey(update, update.botId!) }
                : {}),
            });
      await expect(s.ingress.preparePersistedWebhookEvent(receipt.id)).resolves.toMatchObject({
        canonical: false,
        prepared: false,
      });
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } }),
      ).toMatchObject({ status: 'NO_REPLAY_HELD', semanticKey: receipt.semanticKey });
      expect(s.effects).toEqual([]);
      expect(s.requests).toEqual([]);
    },
  );

  it('preserves a newer grant when a held membership removal is observed late', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    Object.assign(s.ingress, { chatContextCache: s.cache, membershipLookupService: s.membership });
    const update = memberRemoval(source);
    const receipt = await stage(update);
    const edge = await s.prisma.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId: source.source.userId,
        botId: s.bots[0]!.id,
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        checkedAt: new Date(Date.now() + 1_000),
      },
    });
    await s.ingress.preparePersistedWebhookEvent(receipt.id);
    expect(
      await s.prisma.managedEntityAccessEdge.findUniqueOrThrow({
        where: { chatId_userId_botId: { chatId, userId: edge.userId, botId: edge.botId } },
      }),
    ).toEqual(edge);
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } }),
    ).toMatchObject({ status: 'NO_REPLAY_HELD' });
  });

  it.each([
    'prepared claim',
    'canonical alias',
    'command alias',
    'publisher journal',
    'queued',
    'unknown source',
    'future clock',
    'unsealed',
  ] as const)('does not observe or close held user_removed with %s', async (variant) => {
    const s = state();
    const source = await owner();
    await seal([source], variant !== 'unsealed');
    let update = memberRemoval(source);
    if (variant === 'unknown source' || variant === 'future clock')
      update = new WebhookParser().parse(
        {
          ...update.raw,
          ...(variant === 'unknown source'
            ? { unknown: true }
            : { timestamp: Date.now() + 60_000 }),
        },
        { botId: update.botId },
      );
    const receipt = await stage(update, {
      semanticKey: null,
      ...(variant === 'queued' ? { enqueueAttempts: 1, queueName: 'webhook' } : {}),
    });
    if (['prepared claim', 'canonical alias', 'command alias'].includes(variant)) {
      const claim = await s.prisma.webhookExecutionClaim.create({
        data: {
          kind: variant === 'command alias' ? 'COMMAND' : 'EXECUTION',
          semanticKey:
            variant === 'command alias'
              ? buildGroupCommandKey(chatId, update.message!.messageId)
              : buildWebhookSemanticEventKey(update)!,
          webhookEventId: variant === 'prepared claim' ? receipt.id : source.owner.id,
          enforced: true,
          ...(variant === 'prepared claim' ? { status: 'READY', preparedAt: new Date() } : {}),
        },
      });
      extraClaims.push(claim.id);
    }
    if (variant === 'publisher journal') await publisherDelivery(update, source);
    expect(await s.legacyHolds.readHeldMembershipRemoval(receipt.id)).toBeNull();
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
      receipt,
    );
    expect(
      await s.prisma.webhookLegacyReceiptDisposition.count({ where: { receiptId: receipt.id } }),
    ).toBe(0);
  });

  it('rechecks a claim admitted between membership observation and receipt closure', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const update = memberRemoval(source);
    const receipt = await stage(update);
    const observation = await s.legacyHolds.readHeldMembershipRemoval(receipt.id);
    expect(observation).not.toBeNull();
    const claim = await s.prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: buildWebhookSemanticEventKey(update)!,
        webhookEventId: receipt.id,
        enforced: true,
      },
    });
    extraClaims.push(claim.id);
    expect(
      await s.legacyHolds.finishObservedMembershipRemoval(receipt.id, observation!.sourceDigest),
    ).toBe(false);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
      receipt,
    );
    expect(
      await s.prisma.webhookLegacyReceiptDisposition.count({ where: { receiptId: receipt.id } }),
    ).toBe(0);
  });

  type HeldForwardShape =
    | 'passive'
    | 'outer-link'
    | 'linked-link'
    | 'both-links'
    | 'share-links'
    | 'share-no-markup';

  function heldFormattedForward(
    source: LegacyRecoveryCandidate,
    copied: boolean,
    shape: HeldForwardShape = 'passive',
  ) {
    const at = Date.now();
    const markup =
      shape === 'passive'
        ? [{ type: 'emphasized', from: 0, length: 6 }]
        : [{ type: 'link', from: 0, length: 6, url: 'https://example.com/held-source' }];
    const outerMarkup = shape !== 'linked-link' && shape !== 'share-no-markup';
    const linkedMarkup = shape !== 'outer-link' && shape !== 'share-no-markup';
    return new WebhookParser().parse(
      {
        update_type: 'message_created',
        update_id: randomUUID(),
        timestamp: at,
        message: {
          sender: { user_id: source.source.userId, is_bot: false },
          recipient: { chat_id: source.source.chatId, chat_type: 'chat' },
          timestamp: at,
          body: {
            mid: randomUUID(),
            text: copied ? '' : 'Outer caption',
            ...(outerMarkup ? { markup } : {}),
          },
          link: {
            type: 'forward',
            chat_id: -222,
            sender: { user_id: 'quoted-author', is_bot: false },
            message: {
              mid: randomUUID(),
              text: 'Quoted caption',
              ...(linkedMarkup ? { markup: structuredClone(markup) } : {}),
              attachments: shape.startsWith('share-')
                ? [
                    {
                      type: 'share',
                      payload: { url: 'https://example.com/preview', token: 'native-share-token' },
                      title: 'Fixture preview',
                      description: 'Passive source preview',
                      image_url: 'https://example.com/preview.png',
                    },
                  ]
                : [{ type: 'image', payload: { photo_id: 42, url: 'https://i.oneme.ru/fixture' } }],
            },
          },
        },
      },
      { botId: state().bots[0]!.id },
    );
  }

  function heldRaceUpdate(
    source: LegacyRecoveryCandidate,
    eventKind: 'removal' | 'message' | 'share-no-markup',
  ) {
    if (eventKind === 'message') return heldImage(source);
    if (eventKind === 'share-no-markup')
      return heldFormattedForward(source, false, 'share-no-markup');
    return removal(source);
  }

  // FLAG: Refusal fixtures seed the same pristine persisted envelope as ingress,
  // then deliberately corrupt exactly one boundary before the real SQL classifier.
  // Success through actual storeReceipt is tested independently below.
  async function stage(
    update: MaxUpdate,
    data: Partial<Prisma.WebhookEventUncheckedCreateInput> = {},
  ) {
    const s = state();
    const receipt = await s.prisma.webhookEvent.create({
      data: {
        dedupKey: `${update.botId}:${update.updateId}`,
        botId: update.botId,
        semanticKey: buildWebhookSemanticEventKey(update),
        rawPayload: update.raw as Prisma.InputJsonValue,
        normalizedPayload: update as unknown as Prisma.InputJsonValue,
        ...data,
      },
    });
    s.receiptIds.push(receipt.id);
    return receipt;
  }

  async function blocked(receipt: WebhookEvent) {
    const s = state();
    const claims = await s.prisma.webhookExecutionClaim.findMany({ orderBy: { id: 'asc' } });
    expect(await s.legacyHolds.materializeReceipt(receipt.id)).toBe('BLOCKED_UNKNOWN');
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
      receipt,
    );
    expect(
      await s.prisma.webhookLegacyReceiptDisposition.count({ where: { receiptId: receipt.id } }),
    ).toBe(0);
    expect(await s.prisma.webhookExecutionClaim.findMany({ orderBy: { id: 'asc' } })).toEqual(
      claims,
    );
    expect(s.effects).toEqual([]);
  }

  async function publisherDelivery(update: MaxUpdate, source: LegacyRecoveryCandidate) {
    const s = state();
    const rule = await s.prisma.publisherAutoReplyRule.create({
      data: {
        chatId,
        phrase: 'прайс',
        normalizedPhrase: 'прайс',
        version: 3,
        cooldownSeconds: 30,
        createdByUserId: 'synthetic-admin',
        updatedByUserId: 'synthetic-admin',
        contentRevisions: {
          create: {
            revision: 1,
            text: 'Synthetic auto-reply',
            createdByUserId: 'synthetic-admin',
          },
        },
      },
      include: { contentRevisions: true },
    });
    publisherRules.push(rule.id);
    const revisionId = rule.contentRevisions[0]!.id;
    await s.prisma.publisherAutoReplyRule.update({
      where: { id: rule.id },
      data: { currentContentRevisionId: revisionId },
    });
    return s.prisma.publisherAutoReplyDelivery.create({
      data: {
        chatId,
        ruleId: rule.id,
        contentRevisionId: revisionId,
        publisherBotId: update.botId!,
        sourceMessageId: update.message!.messageId,
        sourceUserId: source.source.userId,
        sourceWebhookEventId: source.owner.id,
        matchedRuleVersion: 3,
        matchedNormalizedPhrase: 'прайс',
        autoReplyConfigRevision: 7,
        publisherSettingsRevision: 4,
        publicationPolicyRevision: 2,
        dueAt: new Date(Date.now() - 1_000),
      },
    });
  }

  it.each(
    (
      [
        { shape: 'passive', copied: false },
        { shape: 'passive', copied: true },
        { shape: 'outer-link', copied: false },
        { shape: 'linked-link', copied: false },
        { shape: 'both-links', copied: true },
        { shape: 'share-links', copied: false },
        { shape: 'share-links', copied: true },
        { shape: 'share-no-markup', copied: false },
        { shape: 'share-no-markup', copied: true },
      ] satisfies Array<{ shape: HeldForwardShape; copied: boolean }>
    ).flatMap((scenario) => [false, true].map((deferred) => ({ ...scenario, deferred }))),
  )(
    'settles held $shape forward without execution (copied=$copied, deferred=$deferred)',
    async ({ shape, copied, deferred }) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const update = heldFormattedForward(source, copied, shape);
      const history = jest.spyOn(s.history, 'remove');
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const before = deferred
        ? await stage(update, { errorMessage: heldRetry, executionDeadlineAt: new Date(0) })
        : undefined;
      if (before)
        expect(await s.legacyHolds.materializeReceipt(before.id)).toBe('APPLIED_WITH_PROOF');
      const receipt = before
        ? await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: before.id } })
        : await store(update);
      expect(receipt.status).toBe('NO_REPLAY_HELD');
      const proof = await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: receipt.legacyDispositionId! },
      });
      expect(proof).toMatchObject({
        receiptId: receipt.id,
        originalStatus: 'RECEIVED',
        scopeKind: 'POST_SEAL_MEMBER',
        reason: 'NO_REPLAY_HELD',
      });
      expect(receipt.rawPayload).toEqual(update.raw);
      expect(receipt.normalizedPayload).toEqual(update);
      expect(receipt.errorMessage).toBe(deferred ? heldRetry : null);
      expect(receipt.processedAt).toBeNull();
      expect(receipt.executionDeadlineAt).not.toBeNull();
      expect(proof.originalSnapshot).toMatchObject({
        version: 1,
        receipt: {
          id: receipt.id,
          status: 'RECEIVED',
          errorMessage: receipt.errorMessage,
          executionDeadlineAt: receipt.executionDeadlineAt!.toISOString(),
        },
        rawPayloadDigest: legacySnapshotDigest(update.raw),
        normalizedPayloadDigest: legacySnapshotDigest(update),
        claims: [],
      });
      if (before)
        expect(receipt).toEqual({
          ...before,
          status: 'NO_REPLAY_HELD',
          legacyDispositionId: proof.id,
          legacyDispositionReceiptId: before.id,
        });
      expect(proof.sourceDigest).toBe(legacyReceiptSourceDigest(receipt, proof.originalStatus));
      expect(await s.legacyHolds.materializeReceipt(receipt.id)).toBe('ALREADY_APPLIED_SAME_PROOF');
      expect(await s.ingress.preparePersistedWebhookEvent(receipt.id)).toMatchObject({
        canonical: false,
        prepared: false,
      });
      expect(await s.canonical.prepareExecution(receipt.id, update.botId!)).toBeNull();
      await s.moderation.processWebhookEvent(receipt.id);
      expect(history).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(
        await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: receipt.id } }),
      ).toBe(0);
      expect(s.requests).toEqual([]);
      expect(s.effects).toEqual([]);
      const next = await store(
        removal(source, { message_id: randomUUID(), user_id: 'next-actor' }),
      );
      await s.ingress.preparePersistedWebhookEvent(next.id);
      await s.prisma.webhookEvent.update({ where: { id: next.id }, data: { status: 'QUEUED' } });
      await s.moderation.processWebhookEvent(next.id);
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: next.id } }),
      ).toMatchObject({ status: 'PROCESSED' });
      expect(await s.legacyHolds.isGlobalUserHeld(source.source.userId)).toBe(true);
      expect(await s.legacyHolds.isMessageHeld(source.source.chatId, source.source.messageId)).toBe(
        true,
      );
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: source.claim.id } }),
      ).toEqual(source.claim);
    },
  );

  it.each([
    'attempted',
    'queue name',
    'raw sample',
    'unsealed',
    'authority digest',
    'linked claim',
    'canonical claim',
    'publisher claim',
    'command claim',
    'delivery journal',
  ])('keeps a fresh formatted held forward fenced with %s', async (fault) => {
    const s = state();
    const source = await owner();
    const certificate = await seal([source], fault !== 'unsealed');
    const update = heldFormattedForward(source, true);
    if (fault === 'authority digest')
      await corruptFixture((tx) =>
        tx.webhookLegacySealedAuthority.update({
          where: { certificateId: certificate.id },
          data: { attestationDigest: 'f'.repeat(64) },
        }),
      );
    const receipt = await stage(update, {
      ...(fault === 'attempted' ? { enqueueAttempts: 1 } : {}),
      ...(fault === 'queue name' ? { queueName: 'existing-queue' } : {}),
      ...(fault === 'raw sample' ? { rawPayload: { ...update.raw, unknownField: true } } : {}),
    });
    if (fault.endsWith('claim')) {
      const semanticKey =
        fault === 'canonical claim'
          ? buildWebhookSemanticEventKey(update)!
          : fault === 'publisher claim'
            ? buildWebhookReceiptSemanticKey(update, update.botId!)!
            : fault === 'command claim'
              ? buildGroupCommandKey(chatId, update.message!.messageId)
              : randomUUID();
      const claim = await s.prisma.webhookExecutionClaim.create({
        data: {
          kind: 'INDEPENDENT_RETAINED_KIND',
          semanticKey,
          ...(fault === 'linked claim' ? { webhookEventId: receipt.id } : {}),
        },
      });
      extraClaims.push(claim.id);
    }
    if (fault === 'delivery journal') await publisherDelivery(update, source);
    await blocked(receipt);
  });

  it.each(
    [
      { eventKind: 'image', deferred: true },
      { eventKind: 'share-no-markup', deferred: false },
      { eventKind: 'share-no-markup', deferred: true },
    ].flatMap((scenario) =>
      [
        'QUEUED',
        'attempted',
        'queue name',
        'processed',
        'other error',
        'command',
        'raw sample',
        'normalized text',
        'old source',
        'unsealed',
        'authority digest',
        'linked claim',
        'canonical claim',
        'publisher claim',
        'command claim',
        'delivery journal',
      ].map((fault) => ({ ...scenario, fault })),
    ),
  )(
    'keeps the held $eventKind fenced with $fault (deferred=$deferred)',
    async ({ eventKind, deferred, fault }) => {
      const s = state();
      const source = await owner();
      const certificate = await seal([source], fault !== 'unsealed');
      let update =
        eventKind === 'image'
          ? heldImage(source, fault === 'command' ? '/ban' : undefined)
          : heldFormattedForward(source, false, 'share-no-markup');
      if (eventKind === 'share-no-markup' && fault === 'command') {
        const raw = structuredClone(update.raw) as { message: { body: { text: string } } };
        raw.message.body.text = '/ban';
        update = new WebhookParser().parse(raw, { botId: update.botId! });
      }
      if (fault === 'normalized text') update.message!.text = 'mismatched text';
      if (fault === 'old source')
        (update.raw as Record<string, unknown>).timestamp = certificate.sealedAt!.getTime() - 1;
      if (fault === 'authority digest')
        await corruptFixture((tx) =>
          tx.webhookLegacySealedAuthority.update({
            where: { certificateId: certificate.id },
            data: { attestationDigest: 'f'.repeat(64) },
          }),
        );
      const receipt = await stage(update, {
        ...(deferred ? { errorMessage: heldRetry } : {}),
        ...(fault === 'QUEUED' ? { status: 'QUEUED' } : {}),
        ...(fault === 'attempted' ? { enqueueAttempts: 1 } : {}),
        ...(fault === 'queue name' ? { queueName: 'existing-queue' } : {}),
        ...(fault === 'processed' ? { processedAt: new Date() } : {}),
        ...(fault === 'other error' ? { errorMessage: 'Unproved earlier error' } : {}),
        ...(fault === 'raw sample' ? { rawPayload: { ...update.raw, unknownField: true } } : {}),
      });
      if (fault.endsWith('claim')) {
        const semanticKey =
          fault === 'canonical claim'
            ? buildWebhookSemanticEventKey(update)!
            : fault === 'publisher claim'
              ? buildWebhookReceiptSemanticKey(update, update.botId!)!
              : fault === 'command claim'
                ? buildGroupCommandKey(chatId, update.message!.messageId)
                : randomUUID();
        const claim = await s.prisma.webhookExecutionClaim.create({
          data: {
            kind: 'INDEPENDENT_RETAINED_KIND',
            semanticKey,
            ...(fault === 'linked claim' ? { webhookEventId: receipt.id } : {}),
          },
        });
        extraClaims.push(claim.id);
      }
      if (fault === 'delivery journal') await publisherDelivery(update, source);
      await blocked(receipt);
      expect(await s.legacyHolds.isGlobalUserHeld(source.source.userId)).toBe(true);
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: source.claim.id } }),
      ).toEqual(source.claim);
      expect(s.requests).toEqual([]);
    },
  );

  it.each(
    (
      ['outer-link', 'linked-link', 'both-links', 'share-links', 'share-no-markup'] as const
    ).flatMap((shape) => [false, true].map((deferred) => ({ shape, deferred }))),
  )('keeps edited $shape forwards fenced (deferred=$deferred)', async ({ shape, deferred }) => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const original = heldFormattedForward(source, shape === 'both-links', shape);
    const update = new WebhookParser().parse(
      { ...original.raw, update_type: 'message_edited' },
      { botId: original.botId! },
    );
    const receipt = deferred
      ? await stage(update, { errorMessage: heldRetry })
      : await store(update);
    expect(receipt.status).toBe('RECEIVED');
    await blocked(receipt);
    expect(await s.legacyHolds.isGlobalUserHeld(source.source.userId)).toBe(true);
    expect(
      await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: source.claim.id } }),
    ).toEqual(source.claim);
    expect(s.requests).toEqual([]);
  });

  it.each([false, true])(
    'keeps a no-markup SHARE fenced when another matching scope is unsealed (deferred=%s)',
    async (deferred) => {
      const s = state();
      const source = await owner();
      const other = await owner(source.source.userId);
      await seal([source]);
      await seal([other], false);
      const update = heldFormattedForward(source, false, 'share-no-markup');
      const receipt = deferred
        ? await stage(update, { errorMessage: heldRetry })
        : await store(update);
      expect(receipt.status).toBe('RECEIVED');
      await blocked(receipt);
      for (const held of [source, other]) {
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: held.claim.id } }),
        ).toEqual(held.claim);
        expect(await s.legacyHolds.isMessageHeld(held.source.chatId, held.source.messageId)).toBe(
          true,
        );
      }
      expect(await s.legacyHolds.isGlobalUserHeld(source.source.userId)).toBe(true);
      expect(s.requests).toEqual([]);
    },
  );

  it('settles a captionless held image at ingress and allows independent same-chat work', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const held = await store(heldImage(source));
    expect(held.status).toBe('NO_REPLAY_HELD');
    const next = await store(
      removal(source, { message_id: randomUUID(), user_id: 'independent-actor' }),
    );
    await s.ingress.preparePersistedWebhookEvent(next.id);
    await s.prisma.webhookEvent.update({ where: { id: next.id }, data: { status: 'QUEUED' } });
    await s.moderation.processWebhookEvent(next.id);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject(
      { status: 'PROCESSED' },
    );
    expect(await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: held.id } })).toBe(
      0,
    );
    expect(
      await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: source.claim.id } }),
    ).toEqual(source.claim);
    expect(s.effects).toEqual([]);
  });

  it.each([undefined, false] as const)(
    'holds genuine official removal at ingress without history effects (is_channel=%s)',
    async (isChannel) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const update = removal(source, isChannel === undefined ? {} : { is_channel: isChannel });
      expect(update.message?.entityType).toBe(isChannel === false ? 'chat' : undefined);
      const history = jest.spyOn(s.history, 'remove');
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const receipt = await store(update);
      expect(receipt.status).toBe('NO_REPLAY_HELD');
      const proof = await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: receipt.legacyDispositionId! },
      });
      expect(proof).toMatchObject({
        receiptId: receipt.id,
        reason: 'NO_REPLAY_HELD',
        originalStatus: 'RECEIVED',
        scopeKind: 'POST_SEAL_MEMBER',
      });
      expect(receipt.legacyDispositionReceiptId).toBe(receipt.id);
      expect(proof.sourceDigest).toBe(legacyReceiptSourceDigest(receipt, proof.originalStatus));
      expect(await s.legacyHolds.materializeReceipt(receipt.id)).toBe('ALREADY_APPLIED_SAME_PROOF');
      expect(await s.ingress.preparePersistedWebhookEvent(receipt.id)).toMatchObject({
        canonical: false,
        prepared: false,
      });
      expect(await s.canonical.prepareExecution(receipt.id, update.botId!)).toBeNull();
      await s.moderation.processWebhookEvent(receipt.id);
      expect(history).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(
        await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: receipt.id } }),
      ).toBe(0);
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: source.claim.id } }),
      ).toEqual(source.claim);
      expect(await s.legacyHolds.isMessageHeld(source.source.chatId, source.source.messageId)).toBe(
        true,
      );
      expect(await s.legacyHolds.isGlobalUserHeld(source.source.userId)).toBe(true);
      expect(s.requests).toEqual([]);
      expect(s.effects).toEqual([]);
    },
  );

  it.each([false, true])(
    'preserves saved deferral, original digest and same proof (empty raw sample=%s)',
    async (emptyRaw) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const update = removal(source);
      const before = await stage(update, {
        errorMessage: heldRetry,
        nextEnqueueAt: new Date(Date.now() + 30_000),
        ...(emptyRaw ? { rawPayload: {} } : {}),
      });
      expect(await s.legacyHolds.materializeReceipt(before.id)).toBe('APPLIED_WITH_PROOF');
      const after = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: before.id } });
      const proof = await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: after.legacyDispositionId! },
      });
      expect(after).toEqual({
        ...before,
        status: 'NO_REPLAY_HELD',
        legacyDispositionId: proof.id,
        legacyDispositionReceiptId: before.id,
      });
      expect(proof.sourceDigest).toBe(legacyReceiptSourceDigest(before));
      expect(proof.originalSnapshot).toMatchObject({
        version: 1,
        receipt: { id: before.id, status: 'RECEIVED', errorMessage: heldRetry },
        rawPayloadDigest: legacySnapshotDigest(before.rawPayload),
        normalizedPayloadDigest: legacySnapshotDigest(before.normalizedPayload),
        claims: [],
      });
      expect(await s.legacyHolds.materializeReceipt(before.id)).toBe('ALREADY_APPLIED_SAME_PROOF');
      expect(
        await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
          where: { id: proof.id },
        }),
      ).toEqual(proof);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: before.id } })).toEqual(
        after,
      );
    },
  );

  it.each(['missing', 'publisher'] as const)(
    'recognizes the %s stored semantic key without rewriting it',
    async (namespace) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const update = removal(source);
      const semanticKey =
        namespace === 'missing' ? null : buildWebhookReceiptSemanticKey(update, update.botId!);
      const before = await stage(update, { semanticKey });
      expect(await s.legacyHolds.materializeReceipt(before.id)).toBe('APPLIED_WITH_PROOF');
      const after = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: before.id } });
      expect(after).toMatchObject({ status: 'NO_REPLAY_HELD', semanticKey });
      expect(
        await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: before.id } }),
      ).toBe(0);
    },
  );

  it('allows a following same-chat ordinary removal to finish without replaying a held removal', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const history = jest.spyOn(s.history, 'remove');
    const held = await store(removal(source));
    expect(held.status).toBe('NO_REPLAY_HELD');
    const nextUpdate = removal(source, {
      message_id: randomUUID(),
      user_id: `independent-${randomUUID()}`,
    });
    const next = await store(nextUpdate);
    const heads = await (
      s.outbox as unknown as {
        findOrderedWebhookHeadsForChats(ids: string[]): Promise<Map<string, { id: string }>>;
      }
    ).findOrderedWebhookHeadsForChats([chatId]);
    expect(heads.get(chatId)?.id).not.toBe(held.id);
    await s.ingress.preparePersistedWebhookEvent(next.id);
    await s.prisma.webhookEvent.update({ where: { id: next.id }, data: { status: 'QUEUED' } });
    await s.moderation.processWebhookEvent(next.id);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject(
      { status: 'PROCESSED' },
    );
    expect(
      await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: next.id, kind: 'EXECUTION' },
      }),
    ).toMatchObject({
      status: 'COMPLETED',
      commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
    });
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith(chatId, nextUpdate.message!.messageId);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: held.id } })).toEqual(held);
    expect(s.requests).toEqual([]);
    expect(s.effects).toEqual([]);
  });

  it.each([
    'bot',
    'chat',
    'message',
    'actor',
    'raw sample',
    'normalized field',
    'dedup key',
  ] as const)(
    'refuses altered %s identity without changing the receipt or any claim',
    async (fault) => {
      const source = await owner();
      await seal([source]);
      const update = removal(source);
      if (fault === 'chat') update.message!.chatId = '-999001';
      if (fault === 'message') update.message!.messageId = randomUUID();
      if (fault === 'actor') update.message!.senderId = 'different-actor';
      if (fault === 'normalized field')
        (update as unknown as Record<string, unknown>).unknownExecution = true;
      await blocked(
        await stage(update, {
          ...(fault === 'bot' ? { botId: state().bots[1]!.id } : {}),
          ...(fault === 'dedup key' ? { dedupKey: randomUUID() } : {}),
          ...(fault === 'raw sample'
            ? { rawPayload: { ...update.raw, message_id: 'different-sampled-message' } }
            : {}),
        }),
      );
    },
  );

  it('refuses a coherent normalized rewrite away from the original sampled held source', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const original = removal(source);
    const otherChatId = (await s.seedCatalog(1, { maxMessageLengthEnabled: false }))[0]!;
    const rewritten = new WebhookParser().parse(
      {
        ...original.raw,
        chat_id: otherChatId,
        message_id: randomUUID(),
        user_id: `unheld-actor-${randomUUID()}`,
      },
      { botId: original.botId },
    );
    expect(await s.legacyHolds.isUpdateHeld(original)).toBe(true);
    expect(await s.legacyHolds.isUpdateHeld(rewritten)).toBe(false);
    // FLAG: Every normalized identity, normalized raw, parser result, saved key and
    // dedup key agrees on an unheld source. The independently sampled original raw
    // must still nominate its held scope before an empty-scope NOT_HELD decision.
    const receipt = await stage(rewritten, { rawPayload: original.raw as Prisma.InputJsonValue });
    expect(receipt.dedupKey).toBe(`${rewritten.botId}:${rewritten.updateId}`);
    expect(receipt.semanticKey).toBe(buildWebhookSemanticEventKey(rewritten));
    expect(receipt.normalizedPayload).toEqual(rewritten);
    await blocked(receipt);
  });

  it.each([
    'channel',
    'string channel',
    'unknown raw',
    'old source',
    'future source',
    'string timestamp',
  ] as const)('refuses unsupported official source: %s', async (fault) => {
    const s = state();
    const source = await owner();
    const certificate = await seal([source]);
    const update = removal(source);
    const raw = update.raw as Record<string, unknown>;
    if (fault === 'channel') {
      raw.is_channel = true;
      update.message!.entityType = 'channel';
    }
    if (fault === 'string channel') raw.is_channel = 'false';
    if (fault === 'unknown raw')
      raw.callback = { callback_id: randomUUID(), payload: 'unexpected' };
    if (fault === 'old source') raw.timestamp = certificate.sealedAt!.getTime() - 1;
    if (fault === 'future source') raw.timestamp = Date.now() + 60_000;
    if (fault === 'string timestamp') raw.timestamp = String(raw.timestamp);
    // Keep ordinary valid normalized times unchanged: raw/normalized disagreement
    // must never become authority through parser coercion or source-clock tolerance.
    await blocked(await stage(update));
    expect(s.effects).toEqual([]);
  });

  it.each([
    'QUEUED',
    'attempted',
    'queued clock',
    'queue name',
    'processed',
    'quarantined',
    'other error',
  ] as const)('retains an existing %s receipt fence', async (fault) => {
    const source = await owner();
    await seal([source]);
    const data: Partial<Prisma.WebhookEventUncheckedCreateInput> =
      fault === 'QUEUED'
        ? { status: 'QUEUED' }
        : fault === 'attempted'
          ? { enqueueAttempts: 1 }
          : fault === 'queued clock'
            ? { queuedAt: new Date() }
            : fault === 'queue name'
              ? { queueName: 'fixture-retained-queue' }
              : fault === 'processed'
                ? { processedAt: new Date() }
                : fault === 'quarantined'
                  ? { timeoutQuarantineExpiresAt: new Date(Date.now() + 30_000) }
                  : { errorMessage: 'Unproved earlier processing failure' };
    await blocked(await stage(removal(source), data));
  });

  it.each(
    ['stored', 'canonical', 'publisher', 'command'].flatMap((key) =>
      ['EXECUTION', 'COMMAND', 'INDEPENDENT_RETAINED_KIND'].map((kind) => ({ key, kind })),
    ),
  )('preserves independent $kind claims for the $key key', async ({ key, kind }) => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const update = removal(source);
    const canonical = buildWebhookSemanticEventKey(update)!;
    const publisher = buildWebhookReceiptSemanticKey(update, update.botId!)!;
    const receipt = await stage(update, { semanticKey: key === 'stored' ? publisher : canonical });
    const semanticKey =
      key === 'stored'
        ? receipt.semanticKey!
        : key === 'publisher'
          ? publisher
          : key === 'command'
            ? buildGroupCommandKey(chatId, update.message!.messageId)
            : canonical;
    const claim = await s.prisma.webhookExecutionClaim.create({ data: { kind, semanticKey } });
    extraClaims.push(claim.id);
    await blocked(receipt);
  });

  it.each(['linked', 'prepared', 'started', 'finished', 'leased', 'saved result'] as const)(
    'preserves %s removal authority rather than manufacturing no-replay settlement',
    async (fault) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const receipt = await stage(removal(source));
      const claim = await s.prisma.webhookExecutionClaim.create({
        data: {
          kind: fault === 'linked' ? 'INDEPENDENT_LINKED_KIND' : 'EXECUTION',
          semanticKey: fault === 'linked' ? randomUUID() : receipt.semanticKey!,
          webhookEventId: receipt.id,
          ...(fault === 'prepared' ? { status: 'READY', preparedAt: new Date() } : {}),
          ...(fault === 'started' ? { businessStartedAt: new Date() } : {}),
          ...(fault === 'finished' ? { status: 'COMPLETED', completedAt: new Date() } : {}),
          ...(fault === 'leased'
            ? { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 30_000) }
            : {}),
          ...(fault === 'saved result' ? { commandResult: { kind: 'EXECUTION_FINISHED' } } : {}),
        },
      });
      extraClaims.push(claim.id);
      await blocked(receipt);
    },
  );

  it.each(['prepared', 'started', 'finished'] as const)(
    'retains a mirror behind an independent %s canonical removal owner',
    async (phase) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const update = removal(source);
      const original = await stage(update);
      const mirror = await stage(
        new WebhookParser().parse(
          {
            ...update.raw,
            update_id: randomUUID(),
          },
          { botId: s.bots[1]!.id },
        ),
      );
      expect(mirror.semanticKey).toBe(original.semanticKey);
      const claim = await s.prisma.webhookExecutionClaim.create({
        data: {
          kind: 'EXECUTION',
          semanticKey: original.semanticKey!,
          webhookEventId: original.id,
          enforced: true,
          preparedAt: new Date(),
          status: phase === 'finished' ? 'COMPLETED' : 'READY',
          ...(phase !== 'prepared' ? { businessStartedAt: new Date() } : {}),
          ...(phase === 'finished'
            ? { completedAt: new Date(), commandResult: { kind: 'EXECUTION_FINISHED' } }
            : {}),
        },
      });
      extraClaims.push(claim.id);
      await blocked(mirror);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: original.id } })).toEqual(
        original,
      );
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toEqual(claim);
    },
  );

  it.each(
    (['removal', 'message', 'share-no-markup'] as const).flatMap((eventKind) =>
      ['canonical', 'command'].map((kind) => ({ eventKind, kind })),
    ),
  )(
    'keeps the $eventKind receipt while a peer owns its $kind fence, then settles after the peer commits',
    async ({ kind, eventKind }) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const update = heldRaceUpdate(source, eventKind);
      const receipt = await stage(update);
      const key =
        kind === 'canonical'
          ? receipt.semanticKey!
          : buildGroupCommandKey(chatId, update.message!.messageId);
      let admitted!: () => void;
      let release!: () => void;
      const peerAdmitted = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const finishPeer = new Promise<void>((resolve) => {
        release = resolve;
      });
      const peer = s.prisma.$transaction(
        async (tx) => {
          expect(await tryLockWebhookSemanticClaimFences(tx, [key])).toBe(true);
          admitted();
          await finishPeer;
        },
        { timeout: 10_000 },
      );
      try {
        await Promise.race([
          peerAdmitted,
          peer.then(() => {
            throw new Error('Peer ended before holding its fence');
          }),
        ]);
        // The real classifier already owns the receipt here. It must try the peer
        // fence without waiting in reverse lock order or manufacturing empty claims.
        await blocked(receipt);
      } finally {
        release();
        await peer;
      }
      expect(await s.legacyHolds.materializeReceipt(receipt.id)).toBe('APPLIED_WITH_PROOF');
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } }),
      ).toMatchObject({ status: 'NO_REPLAY_HELD' });
      expect(s.effects).toEqual([]);
    },
  );

  it.each(['removal', 'message', 'share-no-markup'] as const)(
    'rechecks committed claims for %s after a peer wins the canonical fence',
    async (eventKind) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const receipt = await stage(heldRaceUpdate(source, eventKind));
      let admitted!: () => void;
      let release!: () => void;
      const peerAdmitted = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const finishPeer = new Promise<void>((resolve) => {
        release = resolve;
      });
      const peer = s.prisma.$transaction(
        async (tx) => {
          expect(await tryLockWebhookSemanticClaimFences(tx, [receipt.semanticKey])).toBe(true);
          admitted();
          await finishPeer;
          return tx.webhookExecutionClaim.create({
            data: {
              kind: 'INDEPENDENT_RETAINED_KIND',
              semanticKey: receipt.semanticKey!,
            },
          });
        },
        { timeout: 10_000 },
      );
      let claim: Awaited<typeof peer>;
      try {
        await Promise.race([
          peerAdmitted,
          peer.then(() => {
            throw new Error('Peer ended before holding its fence');
          }),
        ]);
        await blocked(receipt);
      } finally {
        release();
        claim = await peer;
        extraClaims.push(claim.id);
      }
      await blocked(receipt);
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toEqual(claim);
    },
  );

  it.each(['removal', 'message', 'share-no-markup'] as const)(
    'rejects stale EXECUTION admission after the exact %s receipt acquires a no-replay proof',
    async (eventKind) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const receipt = await stage(heldRaceUpdate(source, eventKind));
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      // FLAG: Model an already-read negative hold hint, then pause before the actual
      // SQL admission transaction. Closing the real receipt must defeat this stale
      // caller even when its earlier in-memory status still says RECEIVED.
      const hint = jest.spyOn(s.legacyHolds, 'isUpdateHeld').mockResolvedValueOnce(false);
      const transaction = s.prisma.$transaction.bind(s.prisma);
      let admission!: () => void;
      let resume!: () => void;
      const admissionReached = new Promise<void>((resolve) => {
        admission = resolve;
      });
      const resumeAdmission = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const paused = jest
        .spyOn(s.prisma, '$transaction')
        .mockImplementationOnce(async (...args: unknown[]) => {
          admission();
          await resumeAdmission;
          return transaction(...(args as Parameters<typeof transaction>));
        });
      const preparing = s.ingress.preparePersistedWebhookEvent(receipt.id);
      let closed: WebhookEvent | undefined;
      try {
        await Promise.race([
          admissionReached,
          preparing.then(() => {
            throw new Error('Preparation ended before SQL admission');
          }),
        ]);
        expect(await s.legacyHolds.materializeReceipt(receipt.id)).toBe('APPLIED_WITH_PROOF');
        closed = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } });
        expect(closed.status).toBe('NO_REPLAY_HELD');
      } finally {
        resume();
        await preparing.catch(() => undefined);
        paused.mockRestore();
        hint.mockRestore();
      }
      expect(await preparing).toMatchObject({ canonical: false });
      expect(
        await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: receipt.id } }),
      ).toBe(0);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
        closed,
      );
      expect(handler).not.toHaveBeenCalled();
      expect(s.requests).toEqual([]);
      expect(s.effects).toEqual([]);
    },
  );

  it.each(['observeStart', 'claim'] as const)(
    'refuses stale COMMAND %s against a closed receipt',
    async (method) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const update = removal(source);
      const receipt = await store(update);
      expect(receipt.status).toBe('NO_REPLAY_HELD');
      const staleHint: Pick<WebhookLegacyHoldService, 'isUpdateHeld'> = {
        isUpdateHeld: async () => false,
      };
      const commands = new GroupCommandAuthorityService(s.prisma as never, staleHint as never);
      if (method === 'observeStart')
        await expect(commands.observeStart(update)).resolves.toBeUndefined();
      else await expect(commands.claim(update, update.botId!)).resolves.toBeNull();
      expect(
        await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: receipt.id } }),
      ).toBe(0);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
        receipt,
      );
      expect(s.effects).toEqual([]);
    },
  );

  it('refuses a Publisher removal source fence linked to a closed receipt', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const update = removal(source);
    const receipt = await store(update);
    expect(receipt.status).toBe('NO_REPLAY_HELD');
    const sourceFence = new PublisherAutoReplySourceFenceService(s.prisma as never);
    const identity = {
      publisherBotId: update.botId!,
      chatId,
      sourceMessageId: update.message!.messageId,
    };
    expect(await sourceFence.read(identity)).toBe('missing');
    await expect(
      sourceFence.cancel({ ...identity, sourceWebhookEventId: receipt.id }),
    ).rejects.toBeInstanceOf(PublisherAutoReplySourceReceiptHeldError);
    expect(await sourceFence.read(identity)).toBe('missing');
    expect(
      await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: receipt.id } }),
    ).toBe(0);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
      receipt,
    );
    expect(s.effects).toEqual([]);
  });

  it('keeps a Publisher removal held when an existing completed source tombstone belongs to another receipt', async () => {
    const s = state();
    const source = await owner();
    const prior = await stage(removal(source));
    const sourceFence = new PublisherAutoReplySourceFenceService(s.prisma as never);
    const identity = {
      publisherBotId: prior.botId!,
      chatId,
      sourceMessageId: source.source.messageId,
    };
    await sourceFence.cancel({ ...identity, sourceWebhookEventId: prior.id });
    const tombstone = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: PUBLISHER_AUTO_REPLY_SOURCE_FENCE_TESTING.kind,
        webhookEventId: prior.id,
      },
    });
    expect(tombstone.status).toBe('COMPLETED');
    expect(await sourceFence.read(identity)).toBe('canceled');
    await seal([source]);
    const receipt = await stage(removal(source));
    expect(receipt.id).not.toBe(prior.id);
    expect(tombstone.semanticKey).not.toBe(receipt.semanticKey);
    await blocked(receipt);
    expect(
      await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: tombstone.id } }),
    ).toEqual(tombstone);
  });

  it('keeps a Publisher removal held when an exact legacy delivery journal has no source claim', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const update = removal(source);
    const receipt = await stage(update);
    const delivery = await publisherDelivery(update, source);
    const sourceFence = new PublisherAutoReplySourceFenceService(s.prisma as never);
    expect(
      await sourceFence.read({
        publisherBotId: update.botId!,
        chatId,
        sourceMessageId: update.message!.messageId,
      }),
    ).toBe('missing');
    expect(delivery.sourceWebhookEventId).not.toBe(receipt.id);
    await blocked(receipt);
    expect(
      await s.prisma.publisherAutoReplyDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toEqual(delivery);
  });

  it('refuses a Publisher delivery journal write after receipt closure during a transient source cancellation failure', async () => {
    const s = state();
    const source = await owner();
    await seal([source]);
    const update = removal(source);
    const receipt = await stage(update);
    const sourceFence = new PublisherAutoReplySourceFenceService(s.prisma as never);
    type ProducerDependencies = ConstructorParameters<typeof PublisherAutoReplyProducerService>;
    const unexpectedWork = () => {
      throw new Error('A removal must not match, queue, reserve flood credit or resolve bot users');
    };
    const queue = {
      assertNewDeliveryAdmissionEnabled: unexpectedWork,
      ensureDeliveryJob: unexpectedWork,
    } satisfies Pick<
      ProducerDependencies[1],
      'assertNewDeliveryAdmissionEnabled' | 'ensureDeliveryJob'
    >;
    const registry = { isKnownBotUserId: unexpectedWork } satisfies Pick<
      ProducerDependencies[2],
      'isKnownBotUserId'
    >;
    const floodGate = { replay: unexpectedWork, reserve: unexpectedWork } satisfies Pick<
      ProducerDependencies[3],
      'replay' | 'reserve'
    >;
    const producer = new PublisherAutoReplyProducerService(
      s.prisma as never,
      queue as unknown as ProducerDependencies[1],
      registry as unknown as ProducerDependencies[2],
      floodGate as unknown as ProducerDependencies[3],
      sourceFence,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: update.botId }),
    );
    const transient = new Error('Synthetic source-fence connection loss before persistence');
    let reached!: () => void;
    let resume!: () => void;
    const cancellationReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resumeCancellation = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const cancellation = jest.spyOn(sourceFence, 'cancel').mockImplementationOnce(async () => {
      reached();
      await resumeCancellation;
      throw transient;
    });
    const observing = producer.observeWebhook(update, receipt.id).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    let delivery: Awaited<ReturnType<typeof publisherDelivery>> | undefined;
    let closed: WebhookEvent | undefined;
    let proof:
      | Awaited<ReturnType<typeof s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow>>
      | undefined;
    try {
      await Promise.race([
        cancellationReached,
        observing.then(() => {
          throw new Error('Publisher observation ended before source cancellation');
        }),
      ]);
      expect(
        await s.prisma.publisherAutoReplyDelivery.count({
          where: { chatId, sourceMessageId: update.message!.messageId },
        }),
      ).toBe(0);
      expect(await s.legacyHolds.materializeReceipt(receipt.id)).toBe('APPLIED_WITH_PROOF');
      closed = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } });
      expect(closed.status).toBe('NO_REPLAY_HELD');
      proof = await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: closed.legacyDispositionId! },
      });
      // FLAG: A different original source receipt's late journal commit must not
      // authorize this already-closed removal observer to mutate that journal.
      delivery = await publisherDelivery(update, source);
      expect(delivery.sourceWebhookEventId).not.toBe(receipt.id);
      expect(delivery.status).toBe('PENDING');
    } finally {
      resume();
      await observing;
      cancellation.mockRestore();
    }
    const outcome = await observing;
    expect(outcome.error).toBeInstanceOf(PublisherAutoReplyEnqueuePendingError);
    expect(outcome.error).toMatchObject({ cause: transient });
    expect(
      await s.prisma.publisherAutoReplyDelivery.findUniqueOrThrow({ where: { id: delivery!.id } }),
    ).toEqual(delivery);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
      closed,
    );
    expect(
      await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: proof!.id },
      }),
    ).toEqual(proof);
    expect(
      await s.prisma.webhookExecutionClaim.count({ where: { webhookEventId: receipt.id } }),
    ).toBe(0);
    expect(s.requests).toEqual([]);
    expect(s.effects).toEqual([]);
  });

  it('accepts complete matching scopes from different valid certificates', async () => {
    const s = state();
    const first = await owner();
    const second = await owner(first.source.userId);
    await seal([first]);
    await seal([second]);
    const receipt = await store(removal(first));
    expect(receipt.status).toBe('NO_REPLAY_HELD');
    expect(
      await s.prisma.webhookLegacyReceiptDisposition.count({ where: { receiptId: receipt.id } }),
    ).toBe(1);
    expect(
      await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: first.claim.id } }),
    ).toEqual(first.claim);
    expect(
      await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: second.claim.id } }),
    ).toEqual(second.claim);
  });

  it.each([32, 33])(
    'requires at most 32 global-member rows while the exact chat prefix contains one row (rows=%s)',
    async (count) => {
      const s = state();
      const first = await owner();
      const candidates = [first];
      const otherChatId = (await s.seedCatalog(1, { maxMessageLengthEnabled: false }))[0]!;
      for (let i = 1; i < count; i++)
        candidates.push(await owner(first.source.userId, otherChatId));
      await seal(candidates);
      expect(
        await s.prisma.webhookLegacyRecovery.count({ where: { chatId: first.source.chatId } }),
      ).toBe(1);
      expect(
        await s.prisma.webhookLegacyRecovery.count({ where: { userId: first.source.userId } }),
      ).toBe(count);
      const receipt = await stage(removal(first));
      if (count === 33) await blocked(receipt);
      else {
        expect(await s.legacyHolds.materializeReceipt(receipt.id)).toBe('APPLIED_WITH_PROOF');
        expect(
          await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } }),
        ).toMatchObject({ status: 'NO_REPLAY_HELD' });
      }
    },
  );

  it.each([
    'unsealed secondary',
    'missing secondary authority',
    'mismatched seal',
    'newer seal',
  ] as const)('does not choose one valid scope while ignoring an %s scope', async (fault) => {
    const first = await owner();
    const second = await owner(first.source.userId);
    await seal([first]);
    const other = await seal([second], fault !== 'unsealed secondary');
    if (fault === 'missing secondary authority')
      await corruptFixture((tx) =>
        tx.webhookLegacySealedAuthority.delete({
          where: { certificateId: other.id },
        }),
      );
    if (fault === 'mismatched seal')
      await corruptFixture((tx) =>
        tx.webhookLegacySealedAuthority.update({
          where: { certificateId: other.id },
          data: { attestationDigest: 'd'.repeat(64) },
        }),
      );
    const update = removal(first);
    if (fault === 'newer seal') {
      const beforeLaterSeal = other.sealedAt!.getTime() - 1;
      (update.raw as Record<string, unknown>).timestamp = beforeLaterSeal;
      update.message!.createdAt = new Date(beforeLaterSeal).toISOString();
    }
    await blocked(await stage(update));
  });

  it.each(['receipt', 'proof'] as const)(
    'refuses reuse after the immutable %s changes',
    async (changed) => {
      const s = state();
      const source = await owner();
      await seal([source]);
      const receipt = await store(removal(source));
      expect(receipt.status).toBe('NO_REPLAY_HELD');
      const proofId = receipt.legacyDispositionId!;
      if (changed === 'receipt') {
        await expect(
          s.prisma.webhookEvent.update({
            where: { id: receipt.id },
            data: { errorMessage: 'Changed after proof' },
          }),
        ).rejects.toThrow('immutable');
        await corruptFixture((tx) =>
          tx.webhookEvent.update({
            where: { id: receipt.id },
            data: { errorMessage: 'Changed after proof' },
          }),
        );
      } else {
        await expect(
          s.prisma.webhookLegacyReceiptDisposition.update({
            where: { id: proofId },
            data: { sourceDigest: 'e'.repeat(64) },
          }),
        ).rejects.toThrow('immutable');
        await corruptFixture((tx) =>
          tx.webhookLegacyReceiptDisposition.update({
            where: { id: proofId },
            data: { sourceDigest: 'e'.repeat(64) },
          }),
        );
      }
      const before = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } });
      const proof = await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: proofId },
      });
      expect(await s.legacyHolds.materializeReceipt(receipt.id)).toBe('BLOCKED_UNKNOWN');
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
        before,
      );
      expect(
        await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
          where: { id: proofId },
        }),
      ).toEqual(proof);
      expect(s.effects).toEqual([]);
    },
  );

  it('keeps a pre-seal removal held without treating it as a new pristine observation', async () => {
    const source = await owner();
    const update = removal(source);
    const before = await stage(update);
    await seal([source]);
    await blocked(before);
  });
});
