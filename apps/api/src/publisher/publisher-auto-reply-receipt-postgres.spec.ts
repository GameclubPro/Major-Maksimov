import { randomUUID } from 'node:crypto';
import { createPrismaClient, type Prisma, type PrismaClient } from '../prisma/prisma-client';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { PublisherAutoReplyDeliveryService } from './publisher-auto-reply-delivery.service';
import { PublisherAutoReplyRecoveryService } from './publisher-auto-reply-recovery.service';
import { PublisherAutoReplyAuthoringRecoveryService } from './publisher-auto-reply-authoring-recovery.service';
import type { PublisherAutoReplyAuthoringQueueService } from './publisher-auto-reply-authoring.queue';
import { PublisherAutoReplySourceFenceService } from './publisher-auto-reply-source-fence.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherPrivateFlowLeaseService } from './publisher-private-flow-lease.service';
import type { PublisherAutoReplyJob } from './publisher-auto-reply.queue';
import { PublisherReadinessService } from './publisher-readiness.service';

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

integration('Publisher auto-reply exact receipt settlement on PostgreSQL', () => {
  let db: PrismaClient;
  let service: PublisherAutoReplyDeliveryService;
  let recovery: PublisherAutoReplyRecoveryService;
  let sourceFence: PublisherAutoReplySourceFenceService;
  let chatId: string;
  let ruleId: string;
  let contentRevisionId: string;
  let deliveryId: string;
  let webhookEventId: string;
  let tableSchema: string;
  let beforeFence: (() => Promise<void>) | undefined;
  let afterFence: (() => Promise<void>) | undefined;
  let observeFenceSql: ((query: Prisma.Sql) => void) | undefined;
  let afterBindingRead: (() => Promise<void>) | undefined;
  const botId = `auto-reply-receipt-${randomUUID()}`;
  const faultSchema = `auto_reply_receipt_${randomUUID().replaceAll('-', '')}`;
  const triggerName = `${faultSchema}_fault`;
  const attempt = { final: false, attemptsMade: 1, maxAttempts: 7 };
  const remoteMessageId = 'synthetic-confirmed-auto-reply';
  const queue = { ensureDeliveryJob: jest.fn().mockResolvedValue(undefined) };
  const health = {
    assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
    recordSendSuccess: jest.fn().mockResolvedValue(undefined),
    recordSendFailure: jest.fn().mockResolvedValue('transient'),
  };
  const remoteSend = jest.fn(async () => ({ messageId: remoteMessageId }));
  const maxClient = {
    sendMessageImmediateWithId: jest.fn(
      async (_chatId: string, _text: string, options: { beforeSend: () => Promise<void> }) => {
        await beforeFence?.();
        await options.beforeSend();
        await afterFence?.();
        return remoteSend();
      },
    ),
    uploadImage: jest.fn(),
  };
  const source = () => ({
    publisherBotId: botId,
    chatId,
    sourceMessageId: 'synthetic-source-message',
    sourceWebhookEventId: webhookEventId,
  });
  const job = (): PublisherAutoReplyJob => ({
    version: 1,
    kind: 'deliver',
    retryPolicyName: 'publisher-auto-reply',
    deliveryId,
  });
  const row = () => db.publisherAutoReplyDelivery.findUniqueOrThrow({ where: { id: deliveryId } });

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    tableSchema = url.searchParams.get('schema')?.trim() || 'public';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tableSchema))
      throw new Error('Test schema must be a plain PostgreSQL identifier');
    db = createPrismaClient(databaseUrl, { max: 5, statement_timeout: 10_000 });
    await db.$connect();
    expect(await db.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone')).toEqual([
      { TimeZone: 'UTC' },
    ]);
    await db.$executeRawUnsafe(`CREATE SCHEMA "${faultSchema}"`);
    await db.$executeRawUnsafe(`CREATE SEQUENCE "${faultSchema}"."receipt_write_attempts"`);
    // FLAG: Inject actual PostgreSQL failures only for the exact disposable delivery's SENT
    // write. Sequence increments survive rollback so the production SQL retry is measurable.
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${faultSchema}"."fail_receipt_write"() RETURNS trigger
      LANGUAGE plpgsql AS $body$
      BEGIN
        IF nextval('"${faultSchema}"."receipt_write_attempts"') <= TG_ARGV[0]::integer THEN
          RAISE EXCEPTION 'Synthetic receipt write conflict' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END
      $body$
    `);
  });

  function createService() {
    const observed = new Proxy(db, {
      get(target, field) {
        if (field !== '$transaction') return Reflect.get(target, field);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(client, key) {
                  if (key === '$queryRaw')
                    return (query: Prisma.Sql) => {
                      observeFenceSql?.(query);
                      return client.$queryRaw(query);
                    };
                  if (key === 'chat')
                    return new Proxy(client.chat, {
                      get(delegate, method) {
                        if (method !== 'findUnique') return Reflect.get(delegate, method);
                        return async (args: Parameters<typeof delegate.findUnique>[0]) => {
                          const result = await delegate.findUnique(args);
                          await afterBindingRead?.();
                          return result;
                        };
                      },
                    });
                  return Reflect.get(client, key);
                },
              }),
            ),
          );
      },
    });
    const readiness = Object.assign(Object.create(PublisherReadinessService.prototype), {
      publisherBotId: botId,
      assertEntityReady: async () => ({ chatId, entityType: 'chat', requiredBotId: botId }),
    });
    return new PublisherAutoReplyDeliveryService(
      observed as never,
      maxClient as never,
      readiness as never,
      health as never,
      sourceFence,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      {
        getBotId: () => botId,
        getRequiredActionToken: () => 'synthetic-never-transmitted-token',
      } as never,
    );
  }

  beforeEach(async () => {
    beforeFence = undefined;
    afterFence = undefined;
    observeFenceSql = undefined;
    afterBindingRead = undefined;
    jest.clearAllMocks();
    chatId = `auto-reply-receipt-chat-${randomUUID()}`;
    deliveryId = `auto-reply-receipt-delivery-${randomUUID()}`;
    const access = buildBotAccessSnapshotPersistence(
      { isAdmin: true, isOwner: false, permissionsKnown: true, permissions: ['write'] },
      { source: 'synthetic-binding-check' },
    );
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Synthetic receipt settlement fixture',
        publisherSettings: {
          create: { autoRepliesEnabled: true, autoReplyConfigRevision: 7, revision: 4 },
        },
        publicationPolicy: { create: { publikEnabled: true, revision: 2 } },
        publisherBinding: {
          create: {
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: access.botAccessState,
            botAccessCheckedAt: access.botAccessCheckedAt,
            botAccessExpiresAt: access.botAccessExpiresAt,
            permissionsSnapshot: access.permissionsSnapshot,
          },
        },
      },
    });
    const rule = await db.publisherAutoReplyRule.create({
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
    ruleId = rule.id;
    contentRevisionId = rule.contentRevisions[0]!.id;
    await db.publisherAutoReplyRule.update({
      where: { id: ruleId },
      data: { currentContentRevisionId: contentRevisionId },
    });
    const event = await db.webhookEvent.create({
      data: {
        dedupKey: `auto-reply-receipt-${randomUUID()}`,
        botId,
        rawPayload: { synthetic: true },
        normalizedPayload: { synthetic: true },
      },
    });
    webhookEventId = event.id;
    sourceFence = new PublisherAutoReplySourceFenceService(db as never);
    expect(await sourceFence.admit(source())).toBe('admitted');
    await db.publisherAutoReplyDelivery.create({
      data: {
        id: deliveryId,
        chatId,
        ruleId,
        contentRevisionId,
        publisherBotId: botId,
        sourceMessageId: source().sourceMessageId,
        sourceUserId: 'synthetic-member',
        sourceWebhookEventId: webhookEventId,
        matchedRuleVersion: 3,
        matchedNormalizedPhrase: 'прайс',
        autoReplyConfigRevision: 7,
        publisherSettingsRevision: 4,
        publicationPolicyRevision: 2,
        dueAt: new Date(Date.now() - 1_000),
      },
    });
    service = createService();
    recovery = new PublisherAutoReplyRecoveryService(
      db as never,
      queue as never,
      { dispatchEnabled: true } as never,
      {} as never,
      {} as never,
      new PublisherBackgroundWorkCoordinatorService(),
    );
  });

  afterEach(async () => {
    await db.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${triggerName}" ON "${tableSchema}"."publisher_auto_reply_deliveries"`,
    );
    await db.publisherAutoReplyDelivery.deleteMany({ where: { chatId } });
    await db.publisherAutoReplyRule.updateMany({
      where: { chatId },
      data: { currentContentRevisionId: null },
    });
    await db.publisherAutoReplyRule.deleteMany({ where: { chatId } });
    await db.chat.deleteMany({ where: { id: chatId } });
    await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId } });
    await db.webhookEvent.deleteMany({ where: { id: webhookEventId } });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${faultSchema}" CASCADE`);
    } finally {
      await db.$disconnect();
    }
  });

  async function failReceiptWrites(count: number) {
    await db.$executeRawUnsafe(
      `ALTER SEQUENCE "${faultSchema}"."receipt_write_attempts" RESTART WITH 1`,
    );
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE UPDATE ON "${tableSchema}"."publisher_auto_reply_deliveries"
      FOR EACH ROW WHEN (NEW.id = '${deliveryId}' AND NEW.status::text = 'SENT')
      EXECUTE FUNCTION "${faultSchema}"."fail_receipt_write"('${count}')
    `);
  }

  async function receiptWriteAttempts() {
    const result = await db.$queryRawUnsafe<Array<{ attempts: number }>>(
      `SELECT last_value::integer AS attempts FROM "${faultSchema}"."receipt_write_attempts"`,
    );
    return result[0]!.attempts;
  }

  async function expectCanceledBeforeSend() {
    expect(await row()).toMatchObject({
      status: 'CANCELED',
      dispatchStartedAt: null,
      remoteMessageId: null,
      failureCode: 'SOURCE_OR_RULE_CHANGED',
      lockToken: null,
    });
    expect(remoteSend).not.toHaveBeenCalled();
    expect(health.recordSendFailure).not.toHaveBeenCalled();
    expect(await db.publisherAutoReplyCooldown.count({ where: { ruleId } })).toBe(0);
  }

  async function changeEpoch(kind: 'module' | 'rule' | 'content' | 'policy') {
    if (kind === 'module') {
      await db.publisherEntitySettings.update({
        where: { chatId },
        data: { autoRepliesEnabled: false, revision: { increment: 1 } },
      });
    } else if (kind === 'rule') {
      await db.publisherAutoReplyRule.update({
        where: { id: ruleId },
        data: { enabled: false, version: { increment: 1 } },
      });
    } else if (kind === 'content') {
      const content = await db.publisherAutoReplyContentRevision.create({
        data: {
          ruleId,
          revision: 2,
          text: 'Synthetic revised auto-reply',
          createdByUserId: 'synthetic-admin',
        },
      });
      await db.publisherAutoReplyRule.update({
        where: { id: ruleId },
        data: { currentContentRevisionId: content.id, version: { increment: 1 } },
      });
    } else {
      await db.managedEntityPublicationPolicy.update({
        where: { chatId },
        data: { publikEnabled: false, revision: { increment: 1 } },
      });
    }
  }

  async function waitForBlockedTransaction(blockerPid: number) {
    const deadline = Date.now() + 3_000;
    do {
      const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
        ) AS blocked
      `;
      if (rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error('Expected an actual PostgreSQL row-lock wait');
  }

  async function changeDuringRowLock(
    kind: 'cooldown' | 'delivery',
    change: () => Promise<unknown>,
    options: { expected?: 'canceled' | 'sent'; cooldownInitiallyActive?: boolean } = {},
  ) {
    const locked = gate();
    const reached = gate();
    const release = gate();
    let holder: Promise<void> | undefined;
    let blockerPid = 0;
    let originalCooldown: Awaited<ReturnType<typeof db.publisherAutoReplyCooldown.create>> | null =
      null;
    beforeFence = async () => {
      if (kind === 'cooldown') {
        originalCooldown = await db.publisherAutoReplyCooldown.create({
          data: {
            ruleId,
            sourceUserId: 'synthetic-member',
            lastSourceMessageId: 'synthetic-previous-message',
            nextAllowedAt: new Date(Date.now() + (options.cooldownInitiallyActive ? 500 : -5_000)),
          },
        });
      }
      holder = db.$transaction(
        async (tx) => {
          const rows =
            kind === 'cooldown'
              ? await tx.$queryRaw<Array<{ pid: number }>>`
                  SELECT pg_backend_pid() AS pid FROM publisher_auto_reply_cooldowns
                  WHERE rule_id = ${ruleId} AND source_user_id = 'synthetic-member'
                  FOR UPDATE
                `
              : await tx.$queryRaw<Array<{ pid: number }>>`
                  SELECT pg_backend_pid() AS pid FROM publisher_auto_reply_deliveries
                  WHERE id = ${deliveryId} FOR UPDATE
                `;
          blockerPid = rows[0]!.pid;
          locked.resolve();
          await release.promise;
        },
        { timeout: 15_000 },
      );
      await Promise.race([
        locked.promise,
        holder.then(() => {
          throw new Error('Row-lock holder completed before acquiring its lock');
        }),
      ]);
    };
    observeFenceSql = (query) => {
      if (
        query.sql.includes(
          kind === 'cooldown'
            ? 'INSERT INTO "publisher_auto_reply_cooldowns"'
            : 'publisher_auto_reply_send_fence_lock',
        )
      )
        reached.resolve();
    };
    const sending = service.process(job(), attempt);
    const settled = expect(sending).resolves.toBeUndefined();
    try {
      await Promise.race([
        reached.promise,
        sending.then(() => {
          throw new Error('Auto-reply completed before reaching its expected lock');
        }),
      ]);
      await waitForBlockedTransaction(blockerPid);
      await change();
    } finally {
      release.resolve();
      await holder;
      await settled;
    }
    if (options.expected === 'sent') {
      expect(await row()).toMatchObject({ status: 'SENT', remoteMessageId });
      expect(remoteSend).toHaveBeenCalledTimes(1);
      return;
    }
    expect(await row()).toMatchObject({
      status: 'CANCELED',
      dispatchStartedAt: null,
      remoteMessageId: null,
      failureCode: 'SOURCE_OR_RULE_CHANGED',
      lockToken: null,
    });
    expect(remoteSend).not.toHaveBeenCalled();
    expect(health.recordSendFailure).not.toHaveBeenCalled();
    if (originalCooldown) {
      expect(
        await db.publisherAutoReplyCooldown.findUnique({
          where: { ruleId_sourceUserId: { ruleId, sourceUserId: 'synthetic-member' } },
        }),
      ).toEqual(originalCooldown);
    } else {
      expect(await db.publisherAutoReplyCooldown.count({ where: { ruleId } })).toBe(0);
    }
  }

  it.each(['cooldown', 'delivery'] as const)(
    'keeps the full short cooldown after a real delayed %s-row lock',
    async (kind) => {
      await db.publisherAutoReplyRule.update({
        where: { id: ruleId },
        data: { cooldownSeconds: 1 },
      });
      await changeDuringRowLock(kind, () => new Promise((resolve) => setTimeout(resolve, 1_100)), {
        expected: 'sent',
        cooldownInitiallyActive: true,
      });
      const first = await row();
      const cooldown = await db.publisherAutoReplyCooldown.findUniqueOrThrow({
        where: { ruleId_sourceUserId: { ruleId, sourceUserId: 'synthetic-member' } },
      });
      expect(
        cooldown.nextAllowedAt.getTime() - first.dispatchStartedAt!.getTime(),
      ).toBeGreaterThanOrEqual(1_000);
      expect(cooldown.lastSourceMessageId).toBe(source().sourceMessageId);
      expect(cooldown.version).toBe(kind === 'cooldown' ? 2 : 1);

      // FLAG: A replay of the confirmed receipt must neither send nor extend its cooldown.
      await createService().process(job(), attempt);
      expect(
        await db.publisherAutoReplyCooldown.findUniqueOrThrow({
          where: { ruleId_sourceUserId: { ruleId, sourceUserId: 'synthetic-member' } },
        }),
      ).toEqual(cooldown);

      const nextSourceMessageId = 'synthetic-next-message';
      await sourceFence.admit({ ...source(), sourceMessageId: nextSourceMessageId });
      const next = await db.publisherAutoReplyDelivery.create({
        data: {
          chatId,
          ruleId,
          contentRevisionId,
          publisherBotId: botId,
          sourceMessageId: nextSourceMessageId,
          sourceUserId: 'synthetic-member',
          sourceWebhookEventId: webhookEventId,
          matchedRuleVersion: first.matchedRuleVersion,
          matchedNormalizedPhrase: first.matchedNormalizedPhrase,
          autoReplyConfigRevision: first.autoReplyConfigRevision,
          publisherSettingsRevision: first.publisherSettingsRevision,
          publicationPolicyRevision: first.publicationPolicyRevision,
          dueAt: new Date(Date.now() - 1_000),
        },
      });
      beforeFence = undefined;
      observeFenceSql = undefined;
      await createService().process({ ...job(), deliveryId: next.id }, attempt);
      expect(
        await db.publisherAutoReplyDelivery.findUniqueOrThrow({ where: { id: next.id } }),
      ).toMatchObject({
        status: 'CANCELED',
        dispatchStartedAt: null,
        failureCode: 'COOLDOWN_ACTIVE',
      });
      expect(remoteSend).toHaveBeenCalledTimes(1);
      expect(
        await db.publisherAutoReplyCooldown.findUniqueOrThrow({
          where: { ruleId_sourceUserId: { ruleId, sourceUserId: 'synthetic-member' } },
        }),
      ).toEqual(cooldown);
    },
  );

  it.each(['module', 'rule', 'content', 'policy'] as const)(
    'cancels a %s epoch change committed during a real cooldown-row wait',
    async (kind) => {
      await changeDuringRowLock('cooldown', () => changeEpoch(kind));
    },
  );

  it.each(['removed', 'reassigned', 'permissions', 'expired'] as const)(
    'rechecks binding %s during a real row wait without treating expiry as revocation',
    async (kind) => {
      await changeDuringRowLock(
        'delivery',
        () =>
          db.publisherEntityBinding.update({
            where: { chatId },
            data:
              kind === 'removed'
                ? { status: 'REMOVED' }
                : kind === 'reassigned'
                  ? { publisherBotId: 'synthetic-other-publisher' }
                  : kind === 'permissions'
                    ? { permissionsSnapshot: { permissionsKnown: true, permissions: [] } }
                    : { botAccessExpiresAt: new Date(Date.now() - 1_000) },
          }),
        { expected: kind === 'expired' ? 'sent' : 'canceled' },
      );
    },
  );

  it.each(['module', 'content'] as const)(
    'rejects a %s epoch superseded after the last binding read',
    async (kind) => {
      // This race targets the final CAS without a newly inserted cooldown's FK lock on rule.
      await db.publisherAutoReplyRule.update({
        where: { id: ruleId },
        data: { cooldownSeconds: 0 },
      });
      afterBindingRead = () => changeEpoch(kind);
      await service.process(job(), attempt);
      await expectCanceledBeforeSend();
    },
  );

  it.each([
    'permissions',
    'shortened',
    'lifecycle',
    'quarantine',
    'older-check',
    'future-check',
  ] as const)('checks binding %s after the last read and ignores legacy expiry', async (kind) => {
    const binding = await db.publisherEntityBinding.findUniqueOrThrow({ where: { chatId } });
    afterBindingRead = async () => {
      await db.publisherEntityBinding.update({
        where: { chatId },
        data:
          kind === 'permissions'
            ? { permissionsSnapshot: { permissionsKnown: true, permissions: [] } }
            : kind === 'shortened'
              ? { botAccessExpiresAt: new Date(Date.now() - 1_000) }
              : kind === 'lifecycle'
                ? { lifecycleEventAt: new Date() }
                : kind === 'quarantine'
                  ? { sendRouteQuarantinedUntil: new Date(Date.now() + 60_000) }
                  : kind === 'future-check'
                    ? buildBotAccessSnapshotPersistence(
                        {
                          isAdmin: true,
                          isOwner: false,
                          permissionsKnown: true,
                          permissions: ['write'],
                        },
                        { source: 'synthetic-future-check', now: new Date(Date.now() + 60_000) },
                      )
                    : {
                        botAccessCheckedAt: new Date(binding.botAccessCheckedAt!.getTime() - 1),
                        botAccessExpiresAt: new Date(Date.now() + 1_000),
                      },
      });
    };
    await service.process(job(), attempt);
    if (kind === 'shortened') {
      expect(await row()).toMatchObject({ status: 'SENT', remoteMessageId });
      expect(remoteSend).toHaveBeenCalledTimes(1);
    } else await expectCanceledBeforeSend();
  });

  it('permits a monotonic renewal of the same authority snapshot after its last read', async () => {
    afterBindingRead = async () => {
      const renewed = buildBotAccessSnapshotPersistence(
        { isAdmin: true, isOwner: false, permissionsKnown: true, permissions: ['write'] },
        {
          source: 'synthetic-binding-renewal',
          now: new Date(),
        },
      );
      await db.publisherEntityBinding.update({
        where: { chatId },
        data: {
          botAccessCheckedAt: renewed.botAccessCheckedAt,
          botAccessExpiresAt: renewed.botAccessExpiresAt,
          permissionsSnapshot: renewed.permissionsSnapshot,
        },
      });
    };
    await service.process(job(), attempt);
    expect(await row()).toMatchObject({ status: 'SENT', remoteMessageId });
    expect(remoteSend).toHaveBeenCalledTimes(1);
  });

  it('retains confirmed bot authority when the legacy expiry passes during the final check', async () => {
    let expiresAt: Date;
    beforeFence = async () => {
      expiresAt = new Date(Date.now() + 1_000);
      await db.publisherEntityBinding.update({
        where: { chatId },
        data: { botAccessExpiresAt: expiresAt },
      });
    };
    afterBindingRead = async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now()) + 10),
      );
    };
    await service.process(job(), attempt);
    expect(await row()).toMatchObject({ status: 'SENT', remoteMessageId });
    expect(remoteSend).toHaveBeenCalledTimes(1);
  });

  it('retries a real failed SQL receipt write without another MAX send', async () => {
    await failReceiptWrites(1);
    await service.process(job(), attempt);
    expect(await receiptWriteAttempts()).toBe(2);
    expect(await row()).toMatchObject({
      status: 'SENT',
      remoteMessageId,
      dispatchStartedAt: expect.any(Date),
      attemptCount: 1,
      lockToken: null,
      failureCode: null,
    });
    await createService().process(job(), attempt);
    await recovery.recoverOnce(new Date(Date.now() + 3 * 60_000));
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(health.recordSendSuccess).toHaveBeenCalledTimes(1);
    expect(health.recordSendFailure).not.toHaveBeenCalled();
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
    expect(await db.publisherAutoReplyCooldown.count({ where: { ruleId } })).toBe(1);
  });

  it('settles a late exact receipt after stale-lease recovery and policy revocation', async () => {
    const crossed = gate();
    const release = gate();
    afterFence = async () => {
      crossed.resolve();
      await release.promise;
    };
    const sending = service.process(job(), attempt);
    const settled = expect(sending).resolves.toBeUndefined();
    try {
      await crossed.promise;
      const fenced = await row();
      expect(fenced.status).toBe('SENDING');
      expect(fenced.dispatchStartedAt).toEqual(expect.any(Date));
      await sourceFence.cancel(source());
      await db.publisherEntitySettings.update({
        where: { chatId },
        data: { autoRepliesEnabled: false, revision: { increment: 1 } },
      });
      await db.publisherAutoReplyRule.update({ where: { id: ruleId }, data: { enabled: false } });
      await expect(
        recovery.recoverOnce(new Date(fenced.lockedAt!.getTime() + 2 * 60_000 + 1)),
      ).resolves.toMatchObject({ ambiguous: 1, enqueued: 0, reset: 0 });
      expect(await row()).toMatchObject({
        status: 'AMBIGUOUS',
        dispatchStartedAt: fenced.dispatchStartedAt,
        remoteMessageId: null,
        failureCode: 'STALE_SEND_FENCE',
      });
      await createService().process(job(), attempt);
      expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    await settled;
    expect(await row()).toMatchObject({
      status: 'SENT',
      remoteMessageId,
      attemptCount: 1,
      failureCode: null,
      lockToken: null,
    });
    await recovery.recoverOnce(new Date(Date.now() + 3 * 60_000));
    await createService().process(job(), attempt);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
    expect(health.recordSendFailure).not.toHaveBeenCalled();
  });

  it('keeps the committed send fence when all three SQL receipt writes fail, without resending', async () => {
    await failReceiptWrites(3);
    await expect(service.process(job(), attempt)).rejects.toThrow();
    expect(await receiptWriteAttempts()).toBe(3);
    const fenced = await row();
    expect(fenced).toMatchObject({
      status: 'SENDING',
      dispatchStartedAt: expect.any(Date),
      remoteMessageId: null,
      attemptCount: 1,
      failureCode: null,
    });
    await createService().process(job(), attempt);
    await recovery.recoverOnce(new Date(Date.now() + 3 * 60_000));
    expect(await row()).toMatchObject({
      status: 'AMBIGUOUS',
      dispatchStartedAt: fenced.dispatchStartedAt,
      remoteMessageId: null,
      attemptCount: 1,
    });
    expect(await receiptWriteAttempts()).toBe(3);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(health.recordSendSuccess).not.toHaveBeenCalled();
    expect(health.recordSendFailure).not.toHaveBeenCalled();
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
  });

  it('cannot attach an old receipt to a different durable dispatch timestamp', async () => {
    const crossed = gate();
    const release = gate();
    afterFence = async () => {
      crossed.resolve();
      await release.promise;
    };
    const sending = service.process(job(), attempt);
    const rejected = expect(sending).rejects.toThrow('could not be persisted');
    let replacementFence: Date;
    try {
      await crossed.promise;
      const fenced = await row();
      replacementFence = new Date(fenced.dispatchStartedAt!.getTime() + 1);
      await db.publisherAutoReplyDelivery.update({
        where: { id: deliveryId },
        data: { dispatchStartedAt: replacementFence, lockToken: 'synthetic-replacement-worker' },
      });
    } finally {
      release.resolve();
    }
    await rejected;
    expect(await row()).toMatchObject({
      status: 'SENDING',
      dispatchStartedAt: replacementFence!,
      lockToken: 'synthetic-replacement-worker',
      remoteMessageId: null,
      attemptCount: 1,
      failureCode: null,
    });
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(health.recordSendFailure).not.toHaveBeenCalled();
  });

  describe('authoring notification recovery ownership', () => {
    let writer: PrismaClient;

    beforeAll(async () => {
      writer = createPrismaClient(databaseUrl, { max: 1, statement_timeout: 10_000 });
      await writer.$connect();
    });

    afterAll(async () => {
      await writer?.$disconnect();
    });

    async function createStaleNotification(now: Date) {
      return db.publisherAutoReplyAuthoringSession.create({
        data: {
          publisherBotId: botId,
          actorUserId: 'synthetic-admin',
          requestId: randomUUID(),
          startToken: randomUUID(),
          targetChatId: chatId,
          privateChatId: 'synthetic-admin',
          ruleId,
          contentRevisionId,
          state: 'REVIEW',
          stageRevision: 3,
          phrase: 'прайс',
          notificationKind: 'ready',
          notificationPending: true,
          notificationRevision: 7,
          notificationClaimRevision: 7,
          notificationLockToken: 'synthetic-old-notification-lock',
          notificationLockedAt: new Date(now.getTime() - 61_000),
          notificationDispatchStartedAt: new Date(now.getTime() - 61_000),
          expiresAt: new Date(now.getTime() + 20 * 60_000),
        },
      });
    }

    function createAuthoringRecovery(afterStaleRead?: () => Promise<void>) {
      const authoringQueue = {
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
      const observed = new Proxy(db, {
        get(target, field) {
          if (field !== 'publisherAutoReplyAuthoringSession') return Reflect.get(target, field);
          return new Proxy(target.publisherAutoReplyAuthoringSession, {
            get(delegate, method) {
              if (method !== 'findMany') return Reflect.get(delegate, method);
              return async (args: Prisma.PublisherAutoReplyAuthoringSessionFindManyArgs) => {
                const rows = await delegate.findMany(args);
                if (args.where?.notificationClaimRevision && afterStaleRead) {
                  const change = afterStaleRead;
                  afterStaleRead = undefined;
                  // FLAG: Keep the actual SQL snapshot while a second committed write changes
                  // its authority. No mock evaluates the production compare-and-swap predicate.
                  await change();
                }
                return rows;
              };
            },
          });
        },
      });
      return {
        queue: authoringQueue,
        recovery: new PublisherAutoReplyAuthoringRecoveryService(
          observed as never,
          authoringQueue as never,
          new PublisherPrivateFlowLeaseService(db as never),
          new PublisherBackgroundWorkCoordinatorService(),
          { dispatchEnabled: true } as never,
        ),
      };
    }

    it('preserves a revision committed after the stale read and recovers it on the next pass', async () => {
      const now = new Date();
      const session = await createStaleNotification(now);
      await db.publisherAutoReplyAuthoringSession.update({
        where: { id: session.id },
        data: {
          state: 'PROCESSING',
          notificationKind: 'processing',
          lockedAt: now,
          lockToken: 'synthetic-content-lock',
        },
      });
      const authoring = createAuthoringRecovery(async () => {
        const completed = await writer.publisherAutoReplyAuthoringSession.updateMany({
          where: { id: session.id, state: 'PROCESSING', lockToken: 'synthetic-content-lock' },
          data: {
            state: 'REVIEW',
            stageRevision: { increment: 1 },
            notificationKind: 'ready',
            notificationPending: true,
            notificationRevision: { increment: 1 },
            lockedAt: null,
            lockToken: null,
          },
        });
        expect(completed.count).toBe(1);
      });

      await authoring.recovery.recoverOnce(now);

      expect(
        await db.publisherAutoReplyAuthoringSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toMatchObject({
        state: 'REVIEW',
        notificationRevision: 8,
        notificationPending: true,
        notificationKind: 'ready',
        notificationClaimRevision: 7,
        notificationLockToken: session.notificationLockToken,
        notificationDispatchStartedAt: session.notificationDispatchStartedAt,
        notificationLastAmbiguousRevision: null,
      });
      expect(authoring.queue.enqueueNotification).not.toHaveBeenCalled();

      const nextPassAt = new Date(now.getTime() + 30_000);
      await authoring.recovery.recoverOnce(nextPassAt);

      expect(
        await db.publisherAutoReplyAuthoringSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toMatchObject({
        notificationRevision: 8,
        notificationPending: true,
        notificationKind: 'ready',
        notificationClaimRevision: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        notificationLastAmbiguousRevision: 7,
      });
      expect(authoring.queue.enqueueNotification).toHaveBeenCalledTimes(1);
      expect(authoring.queue.enqueueNotification).toHaveBeenCalledWith({
        sessionId: session.id,
        notification: 'ready',
        callbackId: null,
        dedupeKey: `recovery-ready-${Math.floor(nextPassAt.getTime() / 30_000)}`,
        requestedAt: nextPassAt,
      });
      expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    });

    it('records an unchanged stale notification as ambiguous without scheduling a replay', async () => {
      const now = new Date();
      const session = await createStaleNotification(now);
      const authoring = createAuthoringRecovery();

      await authoring.recovery.recoverOnce(now);
      await authoring.recovery.recoverOnce(new Date(now.getTime() + 30_000));

      expect(
        await db.publisherAutoReplyAuthoringSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toMatchObject({
        notificationRevision: 7,
        notificationPending: false,
        notificationKind: null,
        notificationClaimRevision: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        notificationLastAmbiguousRevision: 7,
      });
      expect(authoring.queue.enqueueNotification).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    });

    it.each(['token', 'claim'] as const)(
      'preserves a replacement %s acquired after the stale notification read',
      async (replacement) => {
        const now = new Date();
        const session = await createStaleNotification(now);
        const replacementData = {
          notificationLockedAt: now,
          notificationDispatchStartedAt: now,
          ...(replacement === 'token'
            ? { notificationLockToken: 'synthetic-new-notification-lock' }
            : { notificationClaimRevision: 8 }),
        } satisfies Prisma.PublisherAutoReplyAuthoringSessionUpdateInput;
        const authoring = createAuthoringRecovery(async () => {
          await writer.publisherAutoReplyAuthoringSession.update({
            where: { id: session.id },
            data: replacementData,
          });
        });

        await authoring.recovery.recoverOnce(now);

        expect(
          await db.publisherAutoReplyAuthoringSession.findUniqueOrThrow({
            where: { id: session.id },
          }),
        ).toMatchObject({
          notificationRevision: 7,
          notificationPending: true,
          notificationKind: 'ready',
          notificationLastAmbiguousRevision: null,
          notificationLockToken: session.notificationLockToken,
          notificationClaimRevision: session.notificationClaimRevision,
          ...replacementData,
        });
        expect(authoring.queue.enqueueNotification).not.toHaveBeenCalled();
        expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
      },
    );
  });
});
