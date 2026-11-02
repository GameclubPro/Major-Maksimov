import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import {
  Prisma,
  WebhookDependencyKind,
  WebhookStatus,
  type WebhookDependencyQuarantine,
  type WebhookEvent,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { hasWebhookReplayFence } from './webhook-execution-deadline';
import { buildGroupCommandKey } from '../common/group-command-key';
import { readLegacyReceiptClaims } from './webhook-legacy-claims';
import { tryLockWebhookSemanticClaimFences } from './webhook-semantic-claim-fence';
import {
  isPendingWebhookTimeoutQuarantineMessage,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';

// FLAG: Writers require compatible readers. Deploy under the mandatory stopped-worker
// queue fence, with enqueue recreated last; retain the compatible writer-disabled image.
export const WEBHOOK_DEPENDENCY_QUARANTINE_WRITES_ENABLED = true;

// FLAG: Rollback readers must distinguish an exact semantic hold from ordered deadline expiry.
export const WEBHOOK_SEMANTIC_MIRROR_QUARANTINE_READER_VERSION = 1;

export const WEBHOOK_QUARANTINE_BATCH_SIZE = 16;
export const WEBHOOK_QUARANTINE_RECHECK_MS = 60_000;

function orderedChat(event: WebhookEvent): string | null {
  if (
    !event.normalizedPayload ||
    typeof event.normalizedPayload !== 'object' ||
    Array.isArray(event.normalizedPayload)
  )
    return null;
  const payload = event.normalizedPayload as { type?: unknown; message?: { chatId?: unknown } };
  if (payload.type !== 'message_created' && payload.type !== 'message_edited') return null;
  const chatId = payload.message?.chatId;
  return typeof chatId === 'string' && chatId.trim() === chatId && chatId.length > 0
    ? chatId
    : null;
}

function removalChat(event: WebhookEvent): string | null {
  const payload = event.normalizedPayload as Partial<MaxUpdate> | null;
  const chatId = payload?.message?.chatId;
  const messageId = payload?.message?.messageId;
  return payload?.type === 'message_removed' &&
    typeof chatId === 'string' &&
    chatId.length > 0 &&
    chatId.trim() === chatId &&
    typeof messageId === 'string' &&
    messageId.length > 0 &&
    messageId.trim() === messageId
    ? chatId
    : null;
}

function precedes(blocker: WebhookEvent, receipt: WebhookEvent): boolean {
  return (
    blocker.createdAt.getTime() < receipt.createdAt.getTime() ||
    (blocker.createdAt.getTime() === receipt.createdAt.getTime() && blocker.id < receipt.id)
  );
}

@Injectable()
export class WebhookDependencyQuarantineService {
  private mirrorHeadOffset = 0;
  private readonly logger = new Logger(WebhookDependencyQuarantineService.name);
  private readonly writesEnabled = WEBHOOK_DEPENDENCY_QUARANTINE_WRITES_ENABLED;
  private readonly publisherBotId: string;
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: config.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  // FLAG: This is scheduling isolation only. The uncertain source/claim/remote journals
  // remain untouched, and its ordering fence continues to deny dependent business starts.
  async parkSuccessors(
    blockerId: string,
    receiptIds: readonly string[],
    anchorId = blockerId,
  ): Promise<number> {
    if (!this.writesEnabled) return 0;
    let parked = 0;
    const dispatchDeadline = performance.now() + 500;
    for (const receiptId of [...new Set(receiptIds)].slice(0, WEBHOOK_QUARANTINE_BATCH_SIZE)) {
      if (performance.now() >= dispatchDeadline) break;
      if (receiptId === blockerId) continue;
      parked += Number(await this.parkOne(blockerId, receiptId, anchorId));
    }
    return parked;
  }

  private exactRemovalReceipt(event: WebhookEvent, semanticKey: string, chatId: string): boolean {
    const update = event.normalizedPayload as MaxUpdate;
    return (
      removalChat(event) === chatId &&
      event.semanticKey === semanticKey &&
      buildWebhookSemanticEventKey(update) === semanticKey &&
      buildWebhookReceiptSemanticKey(update, this.publisherBotId) === semanticKey &&
      typeof event.botId === 'string' &&
      event.botId.length > 0 &&
      event.botId.trim() === event.botId &&
      update.botId === event.botId &&
      event.botId !== this.publisherBotId &&
      event.executionDeadlineAt === null &&
      event.legacyDispositionId === null &&
      event.legacyDispositionReceiptId === null &&
      event.sourceDispositionId === null &&
      event.sourceDispositionReceiptId === null
    );
  }

  // FLAG: This exact semantic dependency has no ordering lifetime. Retain the uncertain
  // owner, claim, errors and effects; only a never-activated copy stops active scheduling.
  async parkSemanticMirror(ownerId: string, mirrorId: string): Promise<boolean> {
    if (!this.writesEnabled || ownerId === mirrorId) return false;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
          const snapshot = await tx.webhookEvent.findUnique({ where: { id: mirrorId } });
          const chatId = snapshot && removalChat(snapshot);
          if (!snapshot?.semanticKey || !chatId) return false;
          const semanticKey = snapshot.semanticKey;
          const messageId = (snapshot.normalizedPayload as MaxUpdate).message!.messageId;
          // FLAG: Fence independent claim creation before claim-before-receipt locks.
          // Contention preserves the original scheduling state, never infers absence.
          if (
            !(await tryLockWebhookSemanticClaimFences(tx, [
              semanticKey,
              buildGroupCommandKey(chatId, messageId),
            ]))
          )
            return false;
          await tx.$queryRaw(Prisma.sql`
            SELECT id FROM webhook_execution_claims
            WHERE kind = 'EXECUTION' AND semantic_key = ${semanticKey} FOR UPDATE
          `);
          await tx.$queryRaw(Prisma.sql`
            SELECT id FROM webhook_events WHERE id IN (${ownerId}, ${mirrorId})
            ORDER BY id FOR UPDATE
          `);
          const mirror = await this.lockUnstartedReceipt(tx, mirrorId, ownerId);
          const owner = await tx.webhookEvent.findUnique({ where: { id: ownerId } });
          const claim = await tx.webhookExecutionClaim.findUnique({
            where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey } },
          });
          if (
            !mirror ||
            mirror.status !== WebhookStatus.RECEIVED ||
            mirror.queueName !== null ||
            mirror.queuedAt !== null ||
            mirror.enqueueAttempts !== 0 ||
            !this.exactRemovalReceipt(mirror, semanticKey, chatId) ||
            !owner ||
            !this.exactRemovalReceipt(owner, semanticKey, chatId) ||
            owner.status !== WebhookStatus.FAILED ||
            owner.nextEnqueueAt !== null ||
            owner.processedAt !== null ||
            hasWebhookReplayFence(owner) ||
            !claim ||
            claim.kind !== 'EXECUTION' ||
            claim.semanticKey !== semanticKey ||
            claim.webhookEventId !== ownerId ||
            !claim.enforced ||
            claim.status !== 'READY' ||
            !claim.executionBotId ||
            claim.executionBotId.trim() !== claim.executionBotId ||
            claim.executionBotId === this.publisherBotId ||
            !(claim.preparedAt instanceof Date) ||
            !Number.isFinite(claim.preparedAt.getTime()) ||
            !(claim.businessStartedAt instanceof Date) ||
            !Number.isFinite(claim.businessStartedAt.getTime()) ||
            claim.completedAt !== null
          )
            return false;
          const ownerClaims = await readLegacyReceiptClaims(
            tx,
            owner.id,
            semanticKey,
            buildGroupCommandKey(chatId, messageId),
          );
          if (!ownerClaims || ownerClaims.some((row) => row.id !== claim.id)) return false;
          for (const receiptId of [ownerId, mirrorId]) {
            const legacyDisposition = await tx.webhookLegacyReceiptDisposition.findUnique({
              where: { receiptId },
              select: { receiptId: true },
            });
            const sourceDisposition = await tx.webhookSourceReceiptDisposition.findUnique({
              where: { receiptId },
              select: { receiptId: true },
            });
            if (legacyDisposition || sourceDisposition) return false;
          }
          const existing = await tx.webhookDependencyQuarantine.findUnique({
            where: { receiptId_blockerId: { receiptId: mirrorId, blockerId: ownerId } },
          });
          if (existing) return false;
          await tx.webhookDependencyQuarantine.create({
            data: {
              receiptId: mirrorId,
              blockerId: ownerId,
              anchorId: ownerId,
              chatId,
              kind: WebhookDependencyKind.SEMANTIC_MIRROR,
              originalStatus: mirror.status,
              deadlineAt: null,
              nextCheckAt: new Date(Date.now() + WEBHOOK_QUARANTINE_RECHECK_MS),
            },
          });
          const changed = await tx.webhookEvent.updateMany({
            where: { id: mirror.id, status: mirror.status, semanticKey },
            data: { status: WebhookStatus.QUARANTINED },
          });
          if (changed.count !== 1)
            throw new Error('Semantic mirror quarantine receipt CAS changed');
          return true;
        },
        { maxWait: 250, timeout: 2_000 },
      );
    } catch {
      this.logger.warn('Semantic mirror quarantine unavailable');
      return false;
    }
  }

  async findQuarantinedMirrorOwners(headIds: readonly string[]): Promise<Map<string, string>> {
    if (!this.writesEnabled || !headIds.length) return new Map();
    const offset = this.mirrorHeadOffset % headIds.length;
    const selected = [...headIds.slice(offset), ...headIds.slice(0, offset)].slice(0, 64);
    this.mirrorHeadOffset = (offset + selected.length) % headIds.length;
    // FLAG: Exact indexed claim/owner probes follow a bounded physical-head selection.
    // An earlier receiving bot can be the order anchor while another bot owns the failure.
    const rows = await this.prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '500ms'`;
          return tx.$queryRaw<Array<{ headId: string; ownerId: string }>>(Prisma.sql`
      SELECT head.id AS "headId", owner.id AS "ownerId"
      FROM (VALUES ${Prisma.join(selected.map((id) => Prisma.sql`(${id})`))}) selected(id)
      JOIN webhook_events head ON head.id = selected.id
      JOIN webhook_execution_claims claim ON claim.kind = 'EXECUTION'
        AND claim.semantic_key = head.semantic_key AND claim.enforced
        AND claim.webhook_event_id <> head.id
      JOIN webhook_events owner ON owner.id = claim.webhook_event_id
      WHERE owner.status = 'FAILED' AND owner.next_enqueue_at IS NULL
        AND (starts_with(COALESCE(owner.error_message, ''), ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX + ':'})
          OR (claim.business_started_at IS NOT NULL AND claim.completed_at IS NULL
              AND claim.status <> 'COMPLETED'))
      `);
        },
        { maxWait: 250, timeout: 1_000 },
      )
      .catch(() => {
        this.logger.warn('Dependency quarantine mirror discovery unavailable');
        return [];
      });
    return new Map(rows.map((row) => [row.headId, row.ownerId]));
  }

  private async lockUnstartedReceipt(
    tx: Prisma.TransactionClient,
    receiptId: string,
    mirrorOwnerId?: string,
  ) {
    const snapshot = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
    if (!snapshot?.semanticKey) return null;
    // FLAG: Match business-start's claim-before-receipt order. An absent claim may be
    // inserted concurrently, but its final start must lock and reread this receipt.
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "webhook_execution_claims"
      WHERE "kind" = 'EXECUTION' AND "semantic_key" = ${snapshot.semanticKey} FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "webhook_events" WHERE "id" = ${receiptId} FOR UPDATE
    `);
    const receipt = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
    if (
      !receipt ||
      receipt.semanticKey !== snapshot.semanticKey ||
      receipt.semanticKey !==
        buildWebhookReceiptSemanticKey(
          receipt.normalizedPayload as MaxUpdate,
          this.publisherBotId,
        ) ||
      receipt.processedAt !== null ||
      receipt.timeoutQuarantineExpiresAt !== null ||
      hasWebhookReplayFence(receipt)
    )
      return null;
    const claim = await tx.webhookExecutionClaim.findUnique({
      where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: receipt.semanticKey } },
    });
    // FLAG: Publisher observations retain their own receipt namespace. Parking is only
    // scheduling isolation: mismatched receiving identity or any execution claim stays
    // fenced, and no moderation claim is created, completed or borrowed for observation.
    const publisherObservation =
      (receipt.normalizedPayload as MaxUpdate).botId?.trim() === this.publisherBotId;
    if (publisherObservation && (receipt.botId !== this.publisherBotId || claim)) return null;
    // FLAG: A pristine physical mirror is not the started semantic owner. Retain that
    // owner's claim unchanged; require no activation and no independent/legacy claim.
    const pristineMirror = Boolean(
      claim?.enforced &&
      claim.webhookEventId === mirrorOwnerId &&
      claim.webhookEventId !== receipt.id &&
      receipt.queueName === null &&
      receipt.queuedAt === null &&
      receipt.enqueueAttempts === 0 &&
      receipt.legacyDispositionId === null &&
      receipt.sourceDispositionId === null,
    );
    if (pristineMirror) {
      const message = (
        receipt.normalizedPayload as { message?: { chatId?: string; messageId?: string } }
      ).message;
      if (!message?.chatId || !message.messageId) return null;
      const evidence = await readLegacyReceiptClaims(
        tx,
        receipt.id,
        receipt.semanticKey,
        buildGroupCommandKey(message.chatId, message.messageId),
      );
      if (!evidence || evidence.some((row) => row.id !== claim!.id)) return null;
    }
    if (
      claim &&
      !pristineMirror &&
      (!claim.enforced ||
        claim.businessStartedAt !== null ||
        claim.completedAt !== null ||
        claim.status === 'COMPLETED' ||
        claim.leaseToken !== null ||
        claim.leaseExpiresAt !== null)
    )
      return null;
    // FLAG: Independent command/legacy claims are evidence too; do not infer their absence from
    // the canonical semantic claim. This is an indexed exact-receipt probe, not a history scan.
    const otherClaim = await tx.webhookExecutionClaim.findFirst({
      where: { webhookEventId: receipt.id, ...(claim ? { id: { not: claim.id } } : {}) },
      select: { id: true },
    });
    if (otherClaim) return null;
    return receipt;
  }

  private async parkOne(blockerId: string, receiptId: string, anchorId: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        const receipt = await this.lockUnstartedReceipt(tx, receiptId, blockerId);
        if (!receipt || (receipt.status !== 'RECEIVED' && receipt.status !== 'QUEUED'))
          return false;
        const chatId = orderedChat(receipt);
        if (!chatId || !receipt.executionDeadlineAt) return false;
        const blocker = await tx.webhookEvent.findUnique({ where: { id: blockerId } });
        const anchor =
          anchorId === blockerId
            ? blocker
            : await tx.webhookEvent.findUnique({ where: { id: anchorId } });
        if (
          !blocker ||
          blocker.status !== 'FAILED' ||
          blocker.nextEnqueueAt !== null ||
          orderedChat(blocker) !== chatId ||
          !anchor ||
          orderedChat(anchor) !== chatId ||
          anchor.semanticKey !== blocker.semanticKey ||
          buildWebhookSemanticEventKey(anchor.normalizedPayload) !== blocker.semanticKey ||
          (blocker.semanticKey !== receipt.semanticKey && !precedes(anchor, receipt)) ||
          blocker.processedAt !== null ||
          blocker.legacyDispositionId !== null ||
          blocker.sourceDispositionId !== null
        )
          return false;
        if (!isPendingWebhookTimeoutQuarantineMessage(blocker.errorMessage)) {
          // FLAG: A failed started owner can have an arbitrary persistence/transport error.
          // Its exact unfinished authority, never error text alone, fences pristine copies.
          // Ordinary terminal FAILED owners are not chat-order heads. Isolate only their
          // semantic mirrors; do not invent a dependency for neighboring messages.
          if (blocker.semanticKey !== receipt.semanticKey) return false;
          const ownerClaim = await tx.webhookExecutionClaim.findUnique({
            where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: blocker.semanticKey! } },
          });
          if (
            !ownerClaim?.enforced ||
            ownerClaim.webhookEventId !== blocker.id ||
            ownerClaim.businessStartedAt === null ||
            ownerClaim.completedAt !== null ||
            ownerClaim.status === 'COMPLETED'
          )
            return false;
        }
        const existing = await tx.webhookDependencyQuarantine.findUnique({
          where: { receiptId_blockerId: { receiptId, blockerId } },
        });
        // FLAG: A released receipt may encounter another unknown predecessor. Each pair has
        // its own immutable attribution, so a second incident never erases the first.
        if (existing) return false;
        await tx.webhookDependencyQuarantine.create({
          data: {
            receiptId,
            blockerId,
            anchorId,
            chatId,
            kind: WebhookDependencyKind.ORDERED,
            originalStatus: receipt.status,
            deadlineAt: receipt.executionDeadlineAt,
            nextCheckAt: new Date(Date.now() + WEBHOOK_QUARANTINE_RECHECK_MS),
          },
        });
        const changed = await tx.webhookEvent.updateMany({
          where: { id: receipt.id, status: receipt.status, semanticKey: receipt.semanticKey },
          data: { status: WebhookStatus.QUARANTINED },
        });
        if (changed.count !== 1) throw new Error('Dependency quarantine receipt CAS changed');
        return true;
      },
      { timeout: 2_000, maxWait: 1_000 },
    );
  }

  private async reconcileSemanticMirrorWithClient(
    tx: Prisma.TransactionClient,
    entry: WebhookDependencyQuarantine,
    receipt: WebhookEvent,
  ): Promise<'waiting' | 'released'> {
    // FLAG: A semantic mirror cannot expire into a new execution lifetime. Preserve null
    // deadlines and require the same owner to supply positive completion before ordinary dedup.
    if (
      entry.deadlineAt !== null ||
      receipt.executionDeadlineAt !== null ||
      entry.anchorId !== entry.blockerId ||
      !receipt.semanticKey ||
      receipt.queueName !== null ||
      receipt.queuedAt !== null ||
      receipt.enqueueAttempts !== 0 ||
      !this.exactRemovalReceipt(receipt, receipt.semanticKey, entry.chatId)
    )
      return 'waiting';
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM webhook_events WHERE id = ${entry.blockerId} FOR UPDATE
    `);
    const owner = await tx.webhookEvent.findUnique({ where: { id: entry.blockerId } });
    if (
      !owner ||
      !this.exactRemovalReceipt(owner, receipt.semanticKey, entry.chatId) ||
      owner.status !== 'PROCESSED' ||
      !owner.processedAt ||
      owner.errorMessage !== null ||
      owner.nextEnqueueAt !== null ||
      owner.timeoutQuarantineExpiresAt !== null
    )
      return 'waiting';
    const completed = await tx.webhookExecutionClaim.findUnique({
      where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: receipt.semanticKey } },
    });
    if (
      !completed ||
      !completed.enforced ||
      completed.webhookEventId !== owner.id ||
      completed.status !== 'COMPLETED' ||
      !(completed.preparedAt instanceof Date) ||
      !Number.isFinite(completed.preparedAt.getTime()) ||
      !(completed.completedAt instanceof Date) ||
      !Number.isFinite(completed.completedAt.getTime()) ||
      !(completed.businessStartedAt instanceof Date) ||
      !Number.isFinite(completed.businessStartedAt.getTime()) ||
      !completed.executionBotId ||
      completed.executionBotId.trim() !== completed.executionBotId ||
      completed.executionBotId === this.publisherBotId ||
      owner.processedAt.getTime() !== completed.completedAt.getTime() ||
      completed.leaseToken !== null ||
      completed.leaseExpiresAt !== null
    )
      return 'waiting';
    // FLAG: The shared claim and receipts stay locked. Re-admission only lets normal
    // canonical dedup observe completion; this lane never runs business or writes success.
    const [released] = await tx.$queryRaw<Array<{ releasedAt: Date }>>`
      UPDATE webhook_events
      SET status = 'RECEIVED', queue_name = NULL,
          next_enqueue_at = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id = ${receipt.id} AND status = 'QUARANTINED'
        AND execution_deadline_at IS NULL
      RETURNING next_enqueue_at AS "releasedAt"`;
    if (!released) return 'waiting';
    await tx.webhookDependencyQuarantine.update({
      where: { receiptId_blockerId: { receiptId: receipt.id, blockerId: entry.blockerId } },
      data: { state: 'RELEASED', resolvedAt: released.releasedAt },
    });
    return 'released';
  }

  async reconcileDue(): Promise<{ inspected: number; released: number; expired: number }> {
    // FLAG: Rotate unresolved work by a persisted due index. Old unknown outcomes must
    // neither monopolize every pass nor generate a BullMQ retry per dependent message.
    const due = await this.prisma.webhookDependencyQuarantine.findMany({
      where: { state: 'WAITING', nextCheckAt: { lte: new Date() } },
      orderBy: [{ nextCheckAt: 'asc' }, { receiptId: 'asc' }, { blockerId: 'asc' }],
      take: WEBHOOK_QUARANTINE_BATCH_SIZE,
      select: { receiptId: true, blockerId: true, nextCheckAt: true },
    });
    const result = { inspected: due.length, released: 0, expired: 0 };
    for (const item of due) {
      const outcome = await this.prisma
        .$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
            const owned = await tx.webhookDependencyQuarantine.updateMany({
              where: {
                receiptId: item.receiptId,
                blockerId: item.blockerId,
                state: 'WAITING',
                nextCheckAt: item.nextCheckAt,
              },
              data: { nextCheckAt: new Date(Date.now() + WEBHOOK_QUARANTINE_RECHECK_MS) },
            });
            if (owned.count !== 1) return 'waiting';
            const entry = await tx.webhookDependencyQuarantine.findUniqueOrThrow({
              where: {
                receiptId_blockerId: { receiptId: item.receiptId, blockerId: item.blockerId },
              },
            });
            const receipt = await this.lockUnstartedReceipt(tx, item.receiptId, entry.blockerId);
            if (!receipt || receipt.status !== WebhookStatus.QUARANTINED) return 'waiting';
            if (entry.kind === WebhookDependencyKind.SEMANTIC_MIRROR)
              return this.reconcileSemanticMirrorWithClient(tx, entry, receipt);
            if (entry.kind !== WebhookDependencyKind.ORDERED || !entry.deadlineAt) return 'waiting';
            const anchor = await tx.webhookEvent.findUnique({ where: { id: entry.anchorId } });
            const now = new Date();
            if (
              entry.deadlineAt <= now ||
              (receipt.executionDeadlineAt && receipt.executionDeadlineAt <= now)
            ) {
              await tx.webhookDependencyQuarantine.update({
                where: {
                  receiptId_blockerId: { receiptId: receipt.id, blockerId: entry.blockerId },
                },
                data: { state: 'EXPIRED', resolvedAt: now },
              });
              return 'expired';
            }
            const blocker = await tx.webhookEvent.findUnique({ where: { id: entry.blockerId } });
            if (
              !blocker ||
              blocker.status !== 'PROCESSED' ||
              !blocker.processedAt ||
              blocker.errorMessage !== null ||
              blocker.nextEnqueueAt !== null ||
              blocker.timeoutQuarantineExpiresAt !== null ||
              !blocker.semanticKey ||
              blocker.semanticKey !== buildWebhookSemanticEventKey(blocker.normalizedPayload) ||
              orderedChat(blocker) !== entry.chatId ||
              orderedChat(receipt) !== entry.chatId ||
              !anchor ||
              orderedChat(anchor) !== entry.chatId ||
              anchor.semanticKey !== blocker.semanticKey ||
              buildWebhookSemanticEventKey(anchor.normalizedPayload) !== blocker.semanticKey ||
              (receipt.semanticKey !== blocker.semanticKey && !precedes(anchor, receipt)) ||
              !receipt.executionDeadlineAt ||
              receipt.executionDeadlineAt.getTime() !== entry.deadlineAt.getTime()
            )
              return 'waiting';
            const completed = await tx.webhookExecutionClaim.findUnique({
              where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: blocker.semanticKey } },
            });
            if (
              !completed ||
              !completed.enforced ||
              completed.webhookEventId !== blocker.id ||
              completed.status !== 'COMPLETED' ||
              !completed.preparedAt ||
              !completed.completedAt ||
              completed.leaseToken !== null ||
              completed.leaseExpiresAt !== null
            )
              return 'waiting';
            // FLAG: Proof reads can outlive the original deadline. Check the database clock
            // in the locked receipt transition; never enqueue stale work or renew its window.
            const [released] = await tx.$queryRaw<Array<{ releasedAt: Date }>>`
              UPDATE webhook_events
              SET status = 'RECEIVED', queue_name = NULL,
                  next_enqueue_at = clock_timestamp() AT TIME ZONE 'UTC'
              WHERE id = ${receipt.id} AND status = 'QUARANTINED'
                AND execution_deadline_at > clock_timestamp() AT TIME ZONE 'UTC'
              RETURNING next_enqueue_at AS "releasedAt"`;
            await tx.webhookDependencyQuarantine.update({
              where: { receiptId_blockerId: { receiptId: receipt.id, blockerId: entry.blockerId } },
              data: {
                state: released ? 'RELEASED' : 'EXPIRED',
                resolvedAt: released?.releasedAt ?? new Date(),
              },
            });
            return released ? 'released' : 'expired';
          },
          { timeout: 2_000, maxWait: 1_000 },
        )
        .catch(async () => {
          await this.prisma.webhookDependencyQuarantine
            .updateMany({
              where: {
                receiptId: item.receiptId,
                blockerId: item.blockerId,
                state: 'WAITING',
                nextCheckAt: item.nextCheckAt,
              },
              data: { nextCheckAt: new Date(Date.now() + WEBHOOK_QUARANTINE_RECHECK_MS) },
            })
            .catch(() => {
              // FLAG: A failed scheduling hint retains the original due row. It cannot
              // abort this bounded batch or certify that the receipt was recovered.
              this.logger.warn('Dependency quarantine retry hint unavailable');
            });
          this.logger.warn('Dependency quarantine item deferred after persistence failure');
          return 'waiting';
        });
      if (outcome === 'released') result.released += 1;
      if (outcome === 'expired') result.expired += 1;
    }
    return result;
  }
}
