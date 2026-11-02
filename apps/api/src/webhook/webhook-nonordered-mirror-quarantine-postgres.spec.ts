import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { buildGroupCommandKey } from '../common/group-command-key';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { WebhookDependencyQuarantineService } from './webhook-dependency-quarantine.service';
import { buildWebhookExecutionDeadlineAt } from './webhook-execution-deadline';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { writeWebhookEnqueueState } from './webhook-receipt-write';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookParser } from './webhook.parser';
import { WebhookService } from './webhook.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
const publisherBotId = 'publisher-nonordered-quarantine-fixture';

// FLAG: Actual preparation uses real PostgreSQL ownership and receipt locks. No MAX
// transport or ordinary business preparation may run while the started owner is uncertain.
native('nonordered semantic mirror quarantine on native PostgreSQL', () => {
  jest.setTimeout(30_000);
  let prisma: PrismaClient;
  let constraints: Pool;
  const ids: string[] = [];
  const actionIds: string[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable loopback PostgreSQL required');
    prisma = createPrismaClient(databaseUrl, { max: 8, statement_timeout: 10_000 });
    constraints = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 10_000 });
    const [identity] = await prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
  });

  afterEach(async () => {
    await prisma.webhookDependencyQuarantine.deleteMany({ where: { receiptId: { in: ids } } });
    await prisma.maxActionLedgerEntry.deleteMany({ where: { id: { in: actionIds.splice(0) } } });
    await prisma.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: ids } } });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: ids.splice(0) } } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await constraints?.end();
  });

  function quarantineService() {
    return new WebhookDependencyQuarantineService(
      prisma as never,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: publisherBotId }),
    );
  }

  function preparationService(quarantine = quarantineService()) {
    const links = {
      observeStoredChatBotWebhook: jest.fn(async () => undefined),
    } satisfies Pick<MaxBotLinkService, 'observeStoredChatBotWebhook'>;
    const ingress = new WebhookService(
      prisma as never,
      new ConfigService({
        WEBHOOK_CANONICAL_EXECUTION_MODE: 'on',
        MAX_PUBLISHER_BOT_ID: publisherBotId,
      }),
      links as never,
    );
    const forbidden = jest.fn(() => {
      throw new Error('Uncertain owner cannot admit business preparation or MAX effects');
    });
    Object.assign(ingress, {
      dependencyQuarantine: quarantine,
      prepareWebhookEventCore: forbidden,
      maxClient: new Proxy({}, { get: () => forbidden }),
    });
    return { ingress, forbidden };
  }

  async function fixture(eventType: 'message_removed' | 'user_removed' = 'message_removed') {
    const at = new Date(Date.now() - 600_000);
    const payload = new WebhookParser().parse(
      {
        update_type: eventType,
        message_id: eventType === 'message_removed' ? randomUUID() : undefined,
        update_id: randomUUID(),
        chat_id: `-fixture-${randomUUID()}`,
        user: { user_id: randomUUID() },
        timestamp: at.getTime(),
      },
      { botId: 'major-removal-owner' },
    );
    const semanticKey = buildWebhookSemanticEventKey(payload)!;
    expect(semanticKey).toBeTruthy();
    expect(buildWebhookExecutionDeadlineAt(payload, at)).toBeNull();
    const owner = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        botId: payload.botId,
        semanticKey,
        normalizedPayload: payload as unknown as Prisma.InputJsonValue,
        rawPayload: payload.raw as Prisma.InputJsonValue,
        createdAt: at,
        status: 'FAILED',
        errorMessage: 'fixture terminal storage failure; effects remain unknown',
      },
    });
    ids.push(owner.id);
    const mirrorPayload = { ...payload, botId: 'major-removal-mirror', updateId: randomUUID() };
    const mirror = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        botId: mirrorPayload.botId,
        semanticKey,
        normalizedPayload: mirrorPayload as unknown as Prisma.InputJsonValue,
        rawPayload: mirrorPayload.raw as Prisma.InputJsonValue,
        createdAt: new Date(at.getTime() + 1),
        errorMessage:
          'Webhook preparation deferred: Terminal canonical owner requires proof recovery',
        nextEnqueueAt: new Date(),
      },
    });
    ids.push(mirror.id);
    const claim = await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: owner.id,
        executionBotId: payload.botId,
        enforced: true,
        status: 'READY',
        preparedAt: at,
        businessStartedAt: at,
      },
    });
    const action = await prisma.maxActionLedgerEntry.create({
      data: {
        jobId: `nonordered-ambiguous-${randomUUID()}`,
        actionType: 'SEND',
        chatId: payload.message!.chatId,
        botId: payload.botId,
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
        dispatchToken: randomUUID(),
        dispatchStartedAt: at,
        dispatchBotId: payload.botId,
        metadata: { webhookEventId: owner.id, evidence: 'unknown original SEND outcome' },
      },
    });
    actionIds.push(action.id);
    return { owner, mirror, claim, action, mirrorPayload };
  }

  async function makeDue(receiptId: string) {
    await prisma.webhookDependencyQuarantine.updateMany({
      where: { receiptId, state: 'WAITING' },
      data: { nextCheckAt: new Date(0) },
    });
  }

  async function completeOwner(ownerId: string) {
    const completedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.webhookExecutionClaim.updateMany({
        where: { webhookEventId: ownerId, kind: 'EXECUTION' },
        data: { status: 'COMPLETED', completedAt, leaseToken: null, leaseExpiresAt: null },
      });
      await tx.webhookEvent.update({
        where: { id: ownerId },
        data: {
          status: 'PROCESSED',
          processedAt: completedAt,
          errorMessage: null,
          timeoutQuarantineExpiresAt: null,
          nextEnqueueAt: null,
        },
      });
    });
  }

  it('isolates an exact pristine message_removed mirror through actual preparation without replay', async () => {
    const { owner, mirror, claim, action, mirrorPayload } = await fixture();
    const metrics = new QueueMetricsService(
      prisma as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    expect((await metrics.getLagSnapshot({ maxAgeMs: 0 })).effectiveLagSec).toBeGreaterThan(590);
    const { ingress, forbidden } = preparationService();
    try {
      await expect(
        ingress.preparePersistedWebhookEvent(mirror.id, undefined, mirrorPayload),
      ).resolves.toMatchObject({ canonical: false, prepared: false, enforced: true });
      expect(forbidden).not.toHaveBeenCalled();
      expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual({
        ...mirror,
        status: 'QUARANTINED',
      });
      expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(owner);
      expect(await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(
        claim,
      );
      expect(await prisma.maxActionLedgerEntry.findUnique({ where: { id: action.id } })).toEqual(
        action,
      );
      expect(
        await prisma.webhookDependencyQuarantine.findUnique({
          where: { receiptId_blockerId: { receiptId: mirror.id, blockerId: owner.id } },
        }),
      ).toMatchObject({
        kind: 'SEMANTIC_MIRROR',
        anchorId: owner.id,
        deadlineAt: null,
        originalStatus: 'RECEIVED',
        state: 'WAITING',
      });
      expect(await metrics.getLagSnapshot({ maxAgeMs: 0 })).toMatchObject({
        effectiveLagSec: 0,
        operationalLagSec: 0,
      });
      expect((await metrics.getLagSnapshot()).quarantinedCountLowerBound).toBeGreaterThanOrEqual(1);
      expect(
        await new WebhookCanonicalExecutionService(prisma as never).prepareExecution(
          mirror.id,
          mirror.botId!,
        ),
      ).toBeNull();
    } finally {
      await ingress.onModuleDestroy();
    }
  });

  it('has one parking winner and refuses a stale preparation deferral after quarantine', async () => {
    const { owner, mirror, claim, action, mirrorPayload } = await fixture();
    const outcomes = await Promise.all([
      quarantineService().parkSemanticMirror(owner.id, mirror.id),
      quarantineService().parkSemanticMirror(owner.id, mirror.id),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(
      await prisma.webhookDependencyQuarantine.count({ where: { receiptId: mirror.id } }),
    ).toBe(1);
    expect(
      await writeWebhookEnqueueState(prisma, mirror, {
        status: 'RECEIVED',
        errorMessage: mirror.errorMessage,
        nextEnqueueAt: new Date(),
        timeoutQuarantineExpiresAt: null,
      }),
    ).toEqual({ count: 0 });
    const { ingress, forbidden } = preparationService();
    try {
      await expect(
        ingress.preparePersistedWebhookEvent(mirror.id, undefined, mirrorPayload),
      ).resolves.toMatchObject({ canonical: false, prepared: false, enforced: true });
      expect(forbidden).not.toHaveBeenCalled();
      expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual({
        ...mirror,
        status: 'QUARANTINED',
      });
      expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(owner);
      expect(await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(
        claim,
      );
      expect(await prisma.maxActionLedgerEntry.findUnique({ where: { id: action.id } })).toEqual(
        action,
      );
    } finally {
      await ingress.onModuleDestroy();
    }
  });

  it.each([
    'queued-status',
    'queue-name',
    'queued-at',
    'enqueue-attempt',
    'independent-claim',
    'semantic-alias',
    'command-alias',
    'mirror-stored-key',
    'mirror-payload-key',
    'owner-stored-key',
    'owner-payload-key',
    'mirror-receiver-drift',
    'owner-receiver-drift',
    'publisher-mirror',
    'publisher-shared-key',
    'publisher-owner',
    'mirror-deadline',
    'owner-deadline',
    'mirror-replay-fence',
    'owner-replay-fence',
    'owner-retrying',
    'owner-unstarted',
    'owner-completed',
    'owner-unenforced',
    'non-message-removal',
  ] as const)('preserves all evidence and refuses %s', async (variant) => {
    const { owner, mirror, claim, action, mirrorPayload } = await fixture(
      variant === 'non-message-removal' ? 'user_removed' : 'message_removed',
    );
    if (variant === 'queued-status' || variant === 'queue-name' || variant === 'queued-at')
      await prisma.webhookEvent.update({
        where: { id: mirror.id },
        data:
          variant === 'queued-status'
            ? { status: 'QUEUED' }
            : variant === 'queue-name'
              ? { queueName: 'fixture-activated-queue' }
              : { queuedAt: new Date() },
      });
    if (variant === 'enqueue-attempt')
      await prisma.webhookEvent.update({
        where: { id: mirror.id },
        data: { enqueueAttempts: 1 },
      });
    if (['independent-claim', 'semantic-alias', 'command-alias'].includes(variant))
      await prisma.webhookExecutionClaim.create({
        data: {
          kind: variant === 'command-alias' ? 'COMMAND' : 'INDEPENDENT_FIXTURE',
          semanticKey:
            variant === 'command-alias'
              ? buildGroupCommandKey(
                  mirrorPayload.message!.chatId,
                  mirrorPayload.message!.messageId!,
                )
              : variant === 'semantic-alias'
                ? owner.semanticKey!
                : randomUUID(),
          webhookEventId: variant === 'independent-claim' ? mirror.id : owner.id,
          businessStartedAt: new Date(),
        },
      });
    if (variant === 'mirror-stored-key' || variant === 'owner-stored-key')
      await prisma.webhookEvent.update({
        where: { id: variant === 'mirror-stored-key' ? mirror.id : owner.id },
        data: { semanticKey: `fixture-wrong-key:${randomUUID()}` },
      });
    if (variant === 'mirror-payload-key' || variant === 'owner-payload-key') {
      const source = variant === 'mirror-payload-key' ? mirror : owner;
      const payload = source.normalizedPayload as unknown as typeof mirrorPayload;
      const altered = {
        ...payload,
        message: { ...payload.message!, messageId: randomUUID() },
      };
      expect(buildWebhookSemanticEventKey(altered)).not.toBe(owner.semanticKey);
      await prisma.webhookEvent.update({
        where: { id: source.id },
        data: { normalizedPayload: altered as unknown as Prisma.InputJsonValue },
      });
    }
    if (variant === 'mirror-receiver-drift' || variant === 'owner-receiver-drift')
      await prisma.webhookEvent.update({
        where: { id: variant === 'mirror-receiver-drift' ? mirror.id : owner.id },
        data: { botId: 'unrelated-receiving-bot' },
      });
    if (['publisher-mirror', 'publisher-shared-key', 'publisher-owner'].includes(variant)) {
      const source = variant === 'publisher-owner' ? owner : mirror;
      const payload = {
        ...(source.normalizedPayload as unknown as typeof mirrorPayload),
        botId: publisherBotId,
      };
      await prisma.webhookEvent.update({
        where: { id: source.id },
        data: {
          botId: publisherBotId,
          normalizedPayload: payload as unknown as Prisma.InputJsonValue,
          ...(variant === 'publisher-mirror'
            ? { semanticKey: buildWebhookReceiptSemanticKey(payload, publisherBotId) }
            : {}),
        },
      });
    }
    if (variant === 'mirror-deadline' || variant === 'owner-deadline')
      await prisma.webhookEvent.update({
        where: { id: variant === 'mirror-deadline' ? mirror.id : owner.id },
        data: { executionDeadlineAt: new Date() },
      });
    if (variant === 'mirror-replay-fence' || variant === 'owner-replay-fence')
      await prisma.webhookEvent.update({
        where: { id: variant === 'mirror-replay-fence' ? mirror.id : owner.id },
        data: { errorMessage: 'ambiguous retained remote outcome' },
      });
    if (variant === 'owner-retrying')
      await prisma.webhookEvent.update({
        where: { id: owner.id },
        data: { nextEnqueueAt: new Date() },
      });
    if (['owner-unstarted', 'owner-completed', 'owner-unenforced'].includes(variant))
      await prisma.webhookExecutionClaim.update({
        where: { id: claim.id },
        data:
          variant === 'owner-unstarted'
            ? { businessStartedAt: null }
            : variant === 'owner-completed'
              ? { status: 'COMPLETED', completedAt: new Date() }
              : { enforced: false },
      });
    const ownerBefore = await prisma.webhookEvent.findUnique({ where: { id: owner.id } });
    const mirrorBefore = await prisma.webhookEvent.findUnique({ where: { id: mirror.id } });
    const claimsBefore = await prisma.webhookExecutionClaim.findMany({
      where: { webhookEventId: { in: [owner.id, mirror.id] } },
      orderBy: { id: 'asc' },
    });

    expect(await quarantineService().parkSemanticMirror(owner.id, mirror.id)).toBe(false);
    expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(ownerBefore);
    expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual(
      mirrorBefore,
    );
    expect(
      await prisma.webhookExecutionClaim.findMany({
        where: { webhookEventId: { in: [owner.id, mirror.id] } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(claimsBefore);
    expect(await prisma.maxActionLedgerEntry.findUnique({ where: { id: action.id } })).toEqual(
      action,
    );
    expect(
      await prisma.webhookDependencyQuarantine.findMany({ where: { receiptId: mirror.id } }),
    ).toEqual([]);
  });

  it('retains an old uncertain mirror after restart and only deduplicates after exact completion proof', async () => {
    const { owner, mirror, claim, action, mirrorPayload } = await fixture();
    expect(await quarantineService().parkSemanticMirror(owner.id, mirror.id)).toBe(true);
    await prisma.webhookDependencyQuarantine.update({
      where: { receiptId_blockerId: { receiptId: mirror.id, blockerId: owner.id } },
      data: { createdAt: new Date(0), nextCheckAt: new Date(0) },
    });
    const restarted = quarantineService();
    expect(await restarted.reconcileDue()).toEqual({ inspected: 1, released: 0, expired: 0 });
    await makeDue(mirror.id);
    expect(await restarted.reconcileDue()).toEqual({ inspected: 1, released: 0, expired: 0 });
    expect(
      await prisma.webhookDependencyQuarantine.findUnique({
        where: { receiptId_blockerId: { receiptId: mirror.id, blockerId: owner.id } },
      }),
    ).toMatchObject({ kind: 'SEMANTIC_MIRROR', deadlineAt: null, state: 'WAITING' });
    expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual({
      ...mirror,
      status: 'QUARANTINED',
    });
    expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(owner);
    expect(await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(
      claim,
    );
    const canonical = new WebhookCanonicalExecutionService(prisma as never);
    expect(await canonical.prepareExecution(mirror.id, mirror.botId!)).toBeNull();
    expect(await canonical.prepareExecution(owner.id, owner.botId!)).toBeNull();

    // FLAG: This is test setup for an independently supplied positive owner proof. The
    // quarantine reconciler itself must neither fabricate it nor settle any MAX journal.
    await completeOwner(owner.id);
    const provenOwner = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: owner.id } });
    const completedClaim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: claim.id },
    });
    await makeDue(mirror.id);
    expect(await restarted.reconcileDue()).toEqual({ inspected: 1, released: 1, expired: 0 });
    expect(
      await prisma.webhookDependencyQuarantine.findUnique({
        where: { receiptId_blockerId: { receiptId: mirror.id, blockerId: owner.id } },
      }),
    ).toMatchObject({ kind: 'SEMANTIC_MIRROR', deadlineAt: null, state: 'RELEASED' });
    expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(provenOwner);
    expect(await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(
      completedClaim,
    );
    expect(await prisma.maxActionLedgerEntry.findUnique({ where: { id: action.id } })).toEqual(
      action,
    );
    const released = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirror.id } });
    expect(released).toEqual({
      ...mirror,
      nextEnqueueAt: expect.any(Date),
    });
    expect(released.executionDeadlineAt).toBeNull();
    const { ingress, forbidden } = preparationService(restarted);
    try {
      await expect(
        ingress.preparePersistedWebhookEvent(mirror.id, undefined, mirrorPayload),
      ).resolves.toMatchObject({ canonical: false, prepared: true, enforced: true });
      expect(forbidden).not.toHaveBeenCalled();
      expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toMatchObject({
        status: 'DUPLICATE',
        executionDeadlineAt: null,
        enqueueAttempts: 0,
        queuedAt: null,
        queueName: null,
      });
      expect(await canonical.prepareExecution(mirror.id, mirror.botId!)).toBeNull();
      expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(
        provenOwner,
      );
      // FLAG: Ordinary completed-owner dedup serializes through its existing claim UPDATE.
      // Prisma may advance updatedAt; every execution-authority field must remain exact.
      const deduplicatedClaim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(deduplicatedClaim).toEqual({ ...completedClaim, updatedAt: expect.any(Date) });
      expect(deduplicatedClaim.updatedAt.getTime()).toBeGreaterThanOrEqual(
        completedClaim.updatedAt.getTime(),
      );
      expect(await prisma.maxActionLedgerEntry.findUnique({ where: { id: action.id } })).toEqual(
        action,
      );
    } finally {
      await ingress.onModuleDestroy();
    }
  });

  it.each(['owner-only', 'claim-only', 'leased', 'owner-error', 'wrong-owner-key'] as const)(
    'does not release on incomplete or conflicting %s proof',
    async (variant) => {
      const { owner, mirror, claim, action } = await fixture();
      const quarantine = quarantineService();
      expect(await quarantine.parkSemanticMirror(owner.id, mirror.id)).toBe(true);
      const proofAt = new Date();
      if (variant !== 'claim-only')
        await prisma.webhookEvent.update({
          where: { id: owner.id },
          data: {
            status: 'PROCESSED',
            processedAt: proofAt,
            errorMessage: variant === 'owner-error' ? owner.errorMessage : null,
            ...(variant === 'wrong-owner-key' ? { semanticKey: randomUUID() } : {}),
          },
        });
      if (variant !== 'owner-only')
        await prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: {
            status: 'COMPLETED',
            completedAt: proofAt,
            ...(variant === 'leased'
              ? { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }
              : {}),
          },
        });
      const ownerBefore = await prisma.webhookEvent.findUnique({ where: { id: owner.id } });
      const claimBefore = await prisma.webhookExecutionClaim.findUnique({
        where: { id: claim.id },
      });
      await makeDue(mirror.id);
      expect(await quarantineService().reconcileDue()).toEqual({
        inspected: 1,
        released: 0,
        expired: 0,
      });
      expect(await prisma.webhookEvent.findUnique({ where: { id: mirror.id } })).toEqual({
        ...mirror,
        status: 'QUARANTINED',
      });
      expect(await prisma.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual(
        ownerBefore,
      );
      expect(await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(
        claimBefore,
      );
      expect(await prisma.maxActionLedgerEntry.findUnique({ where: { id: action.id } })).toEqual(
        action,
      );
    },
  );

  it.each(['ORDERED', 'SEMANTIC_MIRROR'] as const)(
    'rejects an invalid %s deadline pair in PostgreSQL',
    async (kind) => {
      const { owner, mirror, mirrorPayload } = await fixture();
      await expect(
        constraints.query(
          `INSERT INTO webhook_dependency_quarantines
            (receipt_id, blocker_id, anchor_id, chat_id, original_status, kind, deadline_at)
           VALUES ($1, $2, $2, $3, 'RECEIVED', $4::"WebhookDependencyKind", $5)`,
          [
            mirror.id,
            owner.id,
            mirrorPayload.message!.chatId,
            kind,
            kind === 'ORDERED' ? null : new Date(),
          ],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'webhook_dependency_quarantines_kind_deadline_check',
      });
      expect(
        await prisma.webhookDependencyQuarantine.count({ where: { receiptId: mirror.id } }),
      ).toBe(0);
    },
  );

  it('keeps an existing ordered writer on the default kind and exact saved deadline', async () => {
    const { owner, mirror, mirrorPayload } = await fixture();
    const deadlineAt = new Date(Date.now() + 60_000);
    const entry = await prisma.webhookDependencyQuarantine.create({
      data: {
        receiptId: mirror.id,
        blockerId: owner.id,
        anchorId: owner.id,
        chatId: mirrorPayload.message!.chatId,
        originalStatus: 'RECEIVED',
        deadlineAt,
      },
    });
    expect(entry).toMatchObject({ kind: 'ORDERED', deadlineAt });
  });
});
