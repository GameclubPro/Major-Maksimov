import { readLegacyReceiptClaims } from './webhook-legacy-claims';
import { isPristinePostSealHeldJoin } from './webhook-legacy-held-membership';
import {
  inspectHeldMessageDisposition,
  inspectHeldRemovalDisposition,
  inspectHeldMembershipRemovalDisposition,
} from './webhook-legacy-held-removal';
import type { MaxUpdate } from '@maxim/contracts';
import { buildGroupCommandKey } from '../common/group-command-key';
import { parseAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import { randomUUID } from 'node:crypto';
import { Prisma, type WebhookEvent, type WebhookExecutionClaim } from '../prisma/prisma-client';
import {
  inspectLegacyPostSealTextSource,
  inspectLegacyRecoverySource,
  legacySnapshotDigest,
  type LegacyRecoverySourceRefusal,
} from './webhook-legacy-source';
import { backlogUpdateHeldSql } from './webhook-backlog-cancellation';

export type LegacyReceiptDispositionResult =
  | 'NOT_HELD'
  | 'BLOCKED_UNKNOWN'
  | 'APPLIED_WITH_PROOF'
  | 'ALREADY_APPLIED_SAME_PROOF';
export type LegacyReceiptDispositionRefusal =
  | LegacyRecoverySourceRefusal
  | 'receipt_metadata_unproved'
  | 'receipt_scope_unproved'
  | 'receipt_payload_oversized'
  | 'receipt_missing'
  | 'receipt_pointer_unproved'
  | 'receipt_proof_unproved'
  | 'receipt_message_unproved'
  | 'receipt_authority_missing'
  | 'receipt_authority_unproved'
  | 'receipt_terminal_without_proof'
  | 'receipt_claims_unproved'
  | 'receipt_claim_effects_unproved'
  | 'receipt_owner_snapshot_unproved'
  | 'receipt_post_seal_provenance_unproved'
  | 'receipt_post_seal_source_unproved'
  | 'receipt_post_seal_removal_unproved'
  | 'source_unproved';
type Options = {
  preSeal: true;
  certificateId: string;
  onRefusal?: (reason: LegacyReceiptDispositionRefusal) => void;
};

export type LegacyReceiptScopeMetadata = {
  id: string;
  payloadBytes: number;
  legacyDispositionId: string | null;
  legacyDispositionReceiptId: string | null;
  chatId: string | null;
  messageId: string | null;
  userId: string | null;
  scopeOversize: boolean;
  updateType?: string | null;
};
type RecoveryScope = { chatId: string; messageId: string; userId: string };

// FLAG: The single-receipt classifier and offline page use exactly the same bounded
// metadata. A page caller must hold every returned receipt lock until cursor commit.
export const legacyReceiptScopeMetadataSql = Prisma.sql`"id", normalized_payload->>'type' AS "updateType", octet_length("raw_payload"::text) + octet_length("normalized_payload"::text) AS "payloadBytes",
      legacy_disposition_id AS "legacyDispositionId", legacy_disposition_receipt_id AS "legacyDispositionReceiptId",
      CASE WHEN jsonb_typeof(normalized_payload->'message'->'chatId') = 'string' THEN left(normalized_payload->'message'->>'chatId', 512) END AS "chatId",
      CASE WHEN jsonb_typeof(normalized_payload->'message'->'messageId') = 'string' THEN left(normalized_payload->'message'->>'messageId', 512) END AS "messageId",
      CASE WHEN jsonb_typeof(normalized_payload->'message'->'senderId') = 'string' THEN left(normalized_payload->'message'->>'senderId', 512) END AS "userId",
      COALESCE(octet_length(normalized_payload->'message'->>'chatId') > 512 OR octet_length(normalized_payload->'message'->>'messageId') > 512 OR octet_length(normalized_payload->'message'->>'senderId') > 512, false) AS "scopeOversize"`;

function knownScopeMetadata(meta: LegacyReceiptScopeMetadata): boolean {
  return (
    meta.scopeOversize === false &&
    Number.isSafeInteger(meta.payloadBytes) &&
    meta.payloadBytes >= 0
  );
}

// FLAG: This proves only non-membership in a complete selected-certificate scope set.
// Pointers, malformed scope metadata and held rows must use the full proof classifier.
// Payload size does not grant authority; unrelated oversized receipts stay untouched.
export function isLegacyReceiptOutsideRecoveryScopes(
  meta: LegacyReceiptScopeMetadata,
  scopes: readonly RecoveryScope[],
): boolean {
  return (
    knownScopeMetadata(meta) &&
    meta.legacyDispositionId === null &&
    meta.legacyDispositionReceiptId === null &&
    (meta.chatId === null ||
      !scopes.some(
        (scope) =>
          (scope.chatId === meta.chatId && scope.messageId === (meta.messageId ?? '')) ||
          scope.userId === (meta.userId ?? ''),
      ))
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function legacyReceiptSourceDigest(
  event: WebhookEvent,
  originalStatus = event.status,
): string {
  const original = Object.fromEntries(
    Object.entries(event).filter(
      ([key]) =>
        ![
          'legacyDispositionId',
          'legacyDispositionReceiptId',
          'sourceDispositionId',
          'sourceDispositionReceiptId',
        ].includes(key),
    ),
  );
  return legacySnapshotDigest({ ...original, status: originalStatus });
}

// FLAG: Both passes lock and revalidate the exact pristine source and every claim
// fence. Negative membership/cache work runs BETWEEN transactions; no Redis or MAX
// call may hold these locks. A callback result alone never authorizes closure.
export async function readHeldMembershipRemovalReceipt(
  tx: Prisma.TransactionClient,
  receiptId: string,
): Promise<{ event: WebhookEvent; authorityId: string } | null> {
  const rows = await tx.$queryRaw<LegacyReceiptScopeMetadata[]>(Prisma.sql`
    SELECT ${legacyReceiptScopeMetadataSql}
    FROM webhook_events WHERE id = ${receiptId} FOR UPDATE`);
  const meta = rows[0];
  if (
    rows.length !== 1 ||
    !meta ||
    !knownScopeMetadata(meta) ||
    meta.payloadBytes > 256 * 1024 ||
    meta.updateType !== 'user_removed' ||
    meta.legacyDispositionId ||
    meta.legacyDispositionReceiptId
  )
    return null;
  const event = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
  if (!event || event.sourceDispositionId || event.sourceDispositionReceiptId) return null;
  const update = event.normalizedPayload as unknown as MaxUpdate;
  const result = await inspectHeldMembershipRemovalDisposition(tx, event);
  if (!result || result === 'NOT_HELD') return null;
  // FLAG: A legacy certificate cannot consume an independent modern or exact
  // cancellation hold. Those protocols retain their original settlement authority.
  const conflicts = await tx.$queryRaw<Array<{ held: boolean }>>(Prisma.sql`
    SELECT (${backlogUpdateHeldSql(update)} OR
      EXISTS (SELECT 1 FROM webhook_backlog_receipts WHERE receipt_id = ${receiptId}) OR
      EXISTS (SELECT 1 FROM webhook_source_abandonments
        WHERE chat_id = ${update.message!.chatId} AND message_id = ${update.message!.messageId})) AS held`);
  if (conflicts.length !== 1 || conflicts[0]!.held !== false) return null;
  return { event, authorityId: result.authorityId };
}

export async function finishObservedHeldMembershipRemoval(
  tx: Prisma.TransactionClient,
  receiptId: string,
  originalDigest: string,
): Promise<boolean> {
  const current = await readHeldMembershipRemovalReceipt(tx, receiptId);
  if (!current || legacyReceiptSourceDigest(current.event) !== originalDigest) return false;
  await writeLegacyReceiptDisposition(
    tx,
    current.event,
    current.authorityId,
    [],
    'POST_SEAL_MEMBER',
  );
  return true;
}

// FLAG: Must run inside the receipt transaction. Positive abandonment never changes
// original claim outcomes. Original receipt state remains immutable in the proof; A scope match alone cannot remove a row from ordering.
export async function materializeLegacyReceiptDisposition(
  tx: Prisma.TransactionClient,
  receiptId: string,
  options?: Options,
): Promise<LegacyReceiptDispositionResult> {
  // FLAG: Refusal diagnostics report only a fixed deciding-guard code. They do not
  // change classification or disclose source values, identifiers or error details.
  const refuse = (reason: LegacyReceiptDispositionRefusal): LegacyReceiptDispositionResult => {
    options?.onRefusal?.(reason);
    return 'BLOCKED_UNKNOWN';
  };
  // FLAG: Inspect only bounded scope metadata under the receipt lock. An unrelated
  // oversized payload is NOT_HELD; a held source or existing proof still needs the
  // complete size-bounded receipt and independent positive evidence below.
  const locked = await tx.$queryRaw<LegacyReceiptScopeMetadata[]>(Prisma.sql`
    SELECT ${legacyReceiptScopeMetadataSql}
    FROM "webhook_events" WHERE "id" = ${receiptId} FOR UPDATE`);
  const meta = locked[0];
  if (locked.length !== 1 || !meta || !knownScopeMetadata(meta))
    return refuse('receipt_metadata_unproved');
  const hasProof = Boolean(meta.legacyDispositionId || meta.legacyDispositionReceiptId);
  if (!hasProof && meta.updateType === 'message_removed') {
    if (meta.payloadBytes > 256 * 1024) return refuse('receipt_payload_oversized');
    const event = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
    if (!event) return refuse('receipt_missing');
    if (event.sourceDispositionId || event.sourceDispositionReceiptId)
      return refuse('receipt_pointer_unproved');
    const removal = await inspectHeldRemovalDisposition(tx, event);
    if (removal === 'NOT_HELD') return 'NOT_HELD';
    if (!removal) return refuse('receipt_post_seal_removal_unproved');
    // FLAG: Reuse the compatible v1 abandonment proof, never a successful removal
    // checkpoint. The original error/envelope and all underlying holds survive.
    return writeLegacyReceiptDisposition(tx, event, removal.authorityId, [], 'POST_SEAL_MEMBER');
  }
  let scopes: Array<{ recoveryId: string; authorityId: string | null }> = [];
  if (!hasProof) {
    if (meta.chatId === null)
      return isLegacyReceiptOutsideRecoveryScopes(meta, [])
        ? 'NOT_HELD'
        : refuse('receipt_scope_unproved');
    scopes = await tx.$queryRaw(Prisma.sql`
      SELECT recovery."id" AS "recoveryId", authority."id" AS "authorityId"
      FROM "webhook_legacy_recoveries" recovery
      LEFT JOIN "webhook_legacy_sealed_authorities" authority ON authority."certificate_id" = recovery."certificate_id"
      WHERE (recovery."chat_id" = ${meta.chatId} AND recovery."message_id" = ${meta.messageId ?? ''}
        OR recovery."user_id" = ${meta.userId ?? ''})
        ${options ? Prisma.sql`AND recovery."certificate_id" = ${options.certificateId}` : Prisma.empty}
      ORDER BY (recovery."owner_webhook_event_id" = ${receiptId}) DESC, recovery."id" LIMIT 1`);
    if (!scopes.length)
      return isLegacyReceiptOutsideRecoveryScopes(meta, [])
        ? 'NOT_HELD'
        : refuse('receipt_scope_unproved');
  }
  if (meta.payloadBytes > 256 * 1024) return refuse('receipt_payload_oversized');
  const event = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
  if (!event) return refuse('receipt_missing');
  if (event.sourceDispositionId || event.sourceDispositionReceiptId)
    return refuse('receipt_pointer_unproved');
  if (hasProof) {
    if (!event.legacyDispositionId || event.legacyDispositionReceiptId !== event.id)
      return refuse('receipt_pointer_unproved');
    const proof = await tx.webhookLegacyReceiptDisposition.findUnique({
      where: { id: event.legacyDispositionId },
      include: { authority: true },
    });
    // FLAG: A prior sealed certificate may already have disposed this exact receipt.
    // Validate its immutable proof independently; never replace it or treat a pointer
    // alone as permission to pass the ordered prefix for a different certificate.
    return proof &&
      proof.id === event.legacyDispositionId &&
      proof.receiptId === event.id &&
      proof.sourceDigest === legacyReceiptSourceDigest(event, proof.originalStatus) &&
      proof.reason === 'NO_REPLAY_HELD' &&
      (proof.scopeKind === 'EXACT_OWNER'
        ? proof.originalStatus === 'FAILED' && event.status === 'FAILED'
        : ['PRE_SEAL_SOURCE', 'POST_SEAL_MEMBER'].includes(proof.scopeKind) &&
          proof.originalStatus !== 'NO_REPLAY_HELD' &&
          event.status === 'NO_REPLAY_HELD') &&
      proof.authority?.id === proof.authorityId &&
      proof.authority.authorityVersion === 1
      ? 'ALREADY_APPLIED_SAME_PROOF'
      : refuse('receipt_proof_unproved');
  }
  const update = record(event.normalizedPayload);
  const message = record(update?.message);
  if (!message || typeof message.chatId !== 'string') return refuse('receipt_message_unproved');
  const scope = scopes[0]!;
  if (!scope.authorityId) return refuse('receipt_authority_missing');
  const authority = await tx.webhookLegacySealedAuthority.findUnique({
    where: { id: scope.authorityId },
  });
  const recovery = await tx.webhookLegacyRecovery.findUnique({ where: { id: scope.recoveryId } });
  if (
    !authority ||
    !recovery ||
    authority.authorityVersion !== 1 ||
    recovery.authorityVersion !== 1 ||
    recovery.disposition !== 'NO_REPLAY_ORDER_RELEASED'
  )
    return refuse('receipt_authority_unproved');
  if (['PROCESSED', 'DUPLICATE', 'NO_REPLAY_HELD'].includes(event.status))
    return refuse('receipt_terminal_without_proof');
  const commandKey =
    typeof message.messageId === 'string'
      ? buildGroupCommandKey(message.chatId, message.messageId)
      : '';
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "webhook_execution_claims"
    WHERE "webhook_event_id" = ${event.id} OR ("semantic_key" IN (${event.semanticKey}, ${commandKey}) AND "kind" IN ('EXECUTION', 'COMMAND'))
    ORDER BY "id" FOR UPDATE`);
  const claims = await readLegacyReceiptClaims(tx, event.id, event.semanticKey, commandKey);
  if (!claims) return refuse('receipt_claims_unproved');
  if (
    claims.some(
      (claim) =>
        claim.businessStartedAt ||
        claim.completedAt ||
        claim.status === 'COMPLETED' ||
        claim.leaseToken ||
        claim.leaseExpiresAt ||
        claim.commandResult !== null,
    )
  )
    return refuse('receipt_claim_effects_unproved');
  let scopeKind: 'EXACT_OWNER' | 'PRE_SEAL_SOURCE' | 'POST_SEAL_MEMBER';
  if (event.id === recovery.ownerWebhookEventId) {
    const { rawPayload, normalizedPayload } = event;
    // FLAG: Additive modern pointers must not change previously certified legacy hashes.
    const ownerSnapshot = Object.fromEntries(
      Object.entries(event).filter(
        ([key]) =>
          ![
            'rawPayload',
            'normalizedPayload',
            'sourceDispositionId',
            'sourceDispositionReceiptId',
          ].includes(key),
      ),
    );
    if (
      !options ||
      legacySnapshotDigest(ownerSnapshot) !== legacySnapshotDigest(recovery.ownerSnapshot) ||
      legacySnapshotDigest(rawPayload) !== recovery.rawPayloadDigest ||
      legacySnapshotDigest(normalizedPayload) !== recovery.normalizedPayloadDigest ||
      claims.length !== 1 ||
      claims[0]!.id !== recovery.claimId ||
      legacySnapshotDigest(claims[0]) !== legacySnapshotDigest(recovery.claimSnapshot)
    )
      return refuse('receipt_owner_snapshot_unproved');
    scopeKind = 'EXACT_OWNER';
  } else if (event.createdAt <= authority.sealedAt) {
    // FLAG: The sealed global hold may project a positively validated ordinary source
    // lazily at preparation. Commands and unknown sources retain their order fence.
    const settings = await tx.chatSettings.findUnique({ where: { chatId: message.chatId } });
    let sourceRefusal: LegacyRecoverySourceRefusal | undefined;
    if (
      !inspectLegacyRecoverySource(
        event,
        (reason) => {
          sourceRefusal = reason;
        },
        settings ?? undefined,
      )
    )
      return refuse(sourceRefusal ?? 'source_unproved');
    if (
      parseAdminForwardedModerationCommand(
        (event.normalizedPayload as unknown as MaxUpdate).message!.text,
        settings ?? undefined,
      )
    )
      return refuse('source_command');
    scopeKind = 'PRE_SEAL_SOURCE';
  } else if (
    claims.length === 0 &&
    isPristinePostSealHeldJoin(event, authority.sealedAt, recovery.userId)
  ) {
    // FLAG: A positively identified new join remains suppressed by the existing member hold.
    // Preserve the original envelope/error in its proof; never execute or replay the join.
    scopeKind = 'POST_SEAL_MEMBER';
  } else {
    // FLAG: Original persisted MAX provenance binds member/message identity. Source
    // timestamps never grant authority and may be future-dated. Permanent automatic
    // sanction protection does not grant authority to discard explicit commands.
    const raw = record(update?.raw);
    const rawMessage = record(raw?.message);
    const sender = record(rawMessage?.sender);
    const recipient = record(rawMessage?.recipient);
    const body = record(rawMessage?.body);
    const link = record(rawMessage?.link);
    const linkedBody = record(link?.message);
    const linkedAttachments = linkedBody?.attachments;
    // FLAG: Captionless media, formatted/share forwards and a known hold deferral must
    // not create an endless RECEIVED retry. They require strict original-source, complete
    // sealed-scope and concurrent claim/journal absence proof before closure. A created
    // SHARE without markup must take this same path; its shape grants no disposition.
    if (
      event.errorMessage ===
        'Webhook preparation deferred: Legacy scope installation is not sealed' ||
      body?.text === undefined ||
      body?.text === null ||
      (link?.type === 'forward' &&
        (body?.markup !== undefined ||
          linkedBody?.markup !== undefined ||
          (update?.type === 'message_created' &&
            Array.isArray(linkedAttachments) &&
            linkedAttachments.length <= 10 &&
            linkedAttachments.some((attachment) => record(attachment)?.type === 'share'))))
    ) {
      const heldMessage = await inspectHeldMessageDisposition(tx, event);
      if (!heldMessage || heldMessage === 'NOT_HELD')
        return refuse('receipt_post_seal_source_unproved');
      return writeLegacyReceiptDisposition(
        tx,
        event,
        heldMessage.authorityId,
        [],
        'POST_SEAL_MEMBER',
      );
    }
    if (
      !['message_created', 'message_edited'].includes(String(update?.type)) ||
      raw?.update_type !== update?.type ||
      update?.botId !== event.botId ||
      !event.botId ||
      message.entityType !== 'chat' ||
      recipient?.chat_type !== 'chat' ||
      sender?.is_bot !== false ||
      String(recipient?.chat_id) !== message.chatId ||
      String(sender?.user_id) !== message.senderId ||
      typeof message.messageId !== 'string' ||
      body?.mid !== message.messageId ||
      claims.length !== 0 ||
      event.errorMessage ||
      event.processedAt ||
      event.timeoutQuarantineExpiresAt
    )
      return refuse('receipt_post_seal_provenance_unproved');
    const text = typeof message.text === 'string' ? message.text : '';
    const settings = await tx.chatSettings.findUnique({ where: { chatId: message.chatId } });
    if (
      (rawMessage?.link !== undefined || body?.text !== message.text) &&
      !inspectLegacyPostSealTextSource(event, settings ?? undefined)
    )
      return refuse('receipt_post_seal_source_unproved');
    try {
      if (
        /^[/$]/u.test(text.trim()) ||
        /^старт$/iu.test(text.trim()) ||
        parseAdminForwardedModerationCommand(text) ||
        parseAdminForwardedModerationCommand(text, settings ?? undefined)
      )
        return refuse('source_command');
    } catch {
      // Invalid command arguments still identify a command, never ordinary abandoned work.
      return refuse('source_command_parse_failed');
    }
    scopeKind = 'POST_SEAL_MEMBER';
  }
  return writeLegacyReceiptDisposition(tx, event, authority.id, claims, scopeKind);
}

async function writeLegacyReceiptDisposition(
  tx: Prisma.TransactionClient,
  event: WebhookEvent,
  authorityId: string,
  claims: WebhookExecutionClaim[],
  scopeKind: 'EXACT_OWNER' | 'PRE_SEAL_SOURCE' | 'POST_SEAL_MEMBER',
): Promise<LegacyReceiptDispositionResult> {
  const proof = await tx.webhookLegacyReceiptDisposition.create({
    data: {
      id: randomUUID(),
      receiptId: event.id,
      authorityId,
      sourceDigest: legacyReceiptSourceDigest(event),
      originalStatus: event.status,
      originalSnapshot: JSON.parse(
        JSON.stringify({
          version: 1,
          receipt: Object.fromEntries(
            Object.entries(event).filter(
              ([key]) =>
                ![
                  'rawPayload',
                  'normalizedPayload',
                  'legacyDispositionId',
                  'legacyDispositionReceiptId',
                ].includes(key),
            ),
          ),
          rawPayloadDigest: legacySnapshotDigest(event.rawPayload),
          normalizedPayloadDigest: legacySnapshotDigest(event.normalizedPayload),
          claims,
        }),
      ),
      scopeKind,
    },
  });
  const changed = await tx.webhookEvent.updateMany({
    where: { id: event.id, legacyDispositionId: null, status: event.status },
    data: {
      legacyDispositionId: proof.id,
      legacyDispositionReceiptId: event.id,
      ...(scopeKind === 'EXACT_OWNER' ? {} : { status: 'NO_REPLAY_HELD' as const }),
    },
  });
  if (changed.count !== 1) throw new Error('Legacy disposition CAS did not install exact proof');
  return 'APPLIED_WITH_PROOF';
}
