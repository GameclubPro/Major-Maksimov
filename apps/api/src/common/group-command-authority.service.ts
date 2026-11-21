import { groupClosureNoticeDeadline } from './group-command-closure-notice';
import { verifyFreshHeldCommandAccess } from '../webhook/webhook-legacy-fresh-command';
import type { MaxClientService } from '../max/max-client.service';
import { buildGroupCommandKey } from './group-command-key';
export { buildGroupCommandKey } from './group-command-key';
import { Injectable, Optional } from '@nestjs/common';
import {
  WebhookLegacyHoldService,
  WebhookLegacyHoldRejectedError,
} from '../webhook/webhook-legacy-hold.service';
import type { MaxUpdate } from '@maxim/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type ChatSettings, type PrismaClient } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import {
  lockWebhookClaimReceiptAdmission,
  lockWebhookSemanticClaimFences,
} from '../webhook/webhook-semantic-claim-fence';
import { normalizeMaxActionIdempotencyKeyPart } from '../max/max-client.service';
import {
  isPendingWebhookTimeoutQuarantineMessage,
  isTerminalWebhookTimeoutQuarantineMessage,
} from '../webhook/webhook-timeout-quarantine';

const COMMAND_LEASE_MS = 90_000;
export type ChatMutationFamily = 'CHAT_CONTROL' | 'RULES';
export type GroupCommandResult = {
  action: string;
  noticeText: string | null;
  applied: boolean;
  outcome?: 'QUEUED';
};
export type GroupCommandPermit = {
  claimId: string;
  semanticKey: string;
  webhookEventId: string;
  executionBotId: string;
  leaseToken: string;
  leaseExpiresAt?: Date;
  executionDeadlineAt?: Date | null;
  chatId: string;
  messageId: string;
  sourceAt: Date;
  result: GroupCommandResult | null;
};
type CommandDatabase = Prisma.TransactionClient | PrismaClient | PrismaService;

type GroupChatControlSettings = Pick<
  ChatSettings,
  'nightModeForceCloseEnabled' | 'nightModeForceCloseForever' | 'nightModeForceCloseUntil'
> &
  Partial<Pick<ChatSettings, 'nightModeForceCloseHours' | 'nightModeForceCloseDays'>>;

export async function applyGroupChatControlCommand(
  prisma: PrismaService,
  command: GroupCommandPermit,
  params: {
    chatId: string;
    actorUserId: string;
    source: string;
    action: 'SILENCE' | 'OPEN_CHAT';
    message: string;
    resolveMessage?: (settings: ChatSettings) => string;
    settings: GroupChatControlSettings;
    auditPayload?: Prisma.InputJsonObject;
  },
): Promise<GroupCommandResult> {
  const authority = new GroupCommandAuthorityService(prisma);
  return prisma.$transaction(async (tx) => {
    const applies = await advanceChatMutationOrder(tx, params.chatId, 'CHAT_CONTROL', command);
    await authority.assertOwned(command, tx);
    const result: GroupCommandResult = {
      action: params.action,
      applied: applies,
      noticeText: applies ? params.message : null,
    };
    if (applies) {
      const settings = await tx.chatSettings.upsert({
        where: { chatId: params.chatId },
        create: { chatId: params.chatId, ...params.settings },
        update: params.settings,
      });
      // FLAG: Derive the durable notice from the committed settings candidate under the
      // same chat order lock; a pre-transaction read can describe a superseded schedule.
      result.noticeText = params.resolveMessage?.(settings) ?? params.message;
      await tx.auditLog.create({
        data: {
          chatId: params.chatId,
          actorUserId: params.actorUserId,
          action: params.action === 'SILENCE' ? 'MANUAL_CHAT_SILENCE' : 'MANUAL_CHAT_OPEN',
          payload: {
            source: params.source,
            ...params.auditPayload,
            commandKey: command.semanticKey,
            result,
          },
        },
      });
    }
    await authority.prepareResult(command, result, tx);
    return result;
  });
}

export class GroupCommandNoticeDeliveryError extends Error {
  constructor(cause: unknown) {
    super('Group command notice delivery remains pending', { cause });
  }
}

export async function runGroupCommandWithAuthority(
  authority: GroupCommandAuthorityService,
  update: MaxUpdate,
  botId: string,
  handlers: {
    resume: (permit: GroupCommandPermit) => Promise<void>;
    execute: (permit: GroupCommandPermit) => Promise<boolean>;
  },
): Promise<boolean> {
  const permit = await authority.claim(update, botId);
  if (!permit) return true;
  try {
    const handled = permit.result
      ? (await handlers.resume(permit), true)
      : await handlers.execute(permit);
    if (!permit.result) {
      const result: GroupCommandResult = { action: 'IGNORED', noticeText: null, applied: false };
      await authority.prepareResult(permit, result);
      permit.result = result;
    }
    await authority.complete(permit);
    return handled;
  } catch (error) {
    await authority.release(permit);
    throw error;
  }
}

export function buildLegacyStartLedgerKey(chatId: string, updateId: string, botId: string): string {
  const parts = [
    'explicit',
    botId,
    'SEND_MESSAGE',
    `managed-handshake-start:${chatId}:${updateId}`,
  ];
  const digest = createHash('sha256').update(parts.join('\u001f')).digest('base64url').slice(0, 24);
  const readable = parts
    .map(normalizeMaxActionIdempotencyKeyPart)
    .filter(Boolean)
    .join('__')
    .slice(0, 160)
    .replace(/_+$/u, '');
  return `max-action__${readable}__${digest}`;
}

// FLAG: Command order is independent of bot observation and queue arrival. API writes use
// database time under the same parent lock; a delayed command cannot undo a newer UI write.
export async function advanceChatMutationOrder(
  tx: Prisma.TransactionClient,
  chatId: string,
  family: ChatMutationFamily,
  command?: GroupCommandPermit,
): Promise<boolean> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new Error('Command chat is missing');
  const at =
    command?.sourceAt ??
    (
      await tx.$queryRaw<Array<{ at: Date }>>`
    SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at
  `
    )[0]!.at;
  const key = command?.semanticKey ?? `api:${randomUUID()}`;
  const changed =
    family === 'CHAT_CONTROL'
      ? await tx.$executeRaw`
        UPDATE chats SET chat_control_order_at = ${at}, chat_control_order_key = ${key}
        WHERE id = ${chatId} AND (chat_control_order_at IS NULL
          OR chat_control_order_at < ${at}
          OR (chat_control_order_at = ${at} AND COALESCE(chat_control_order_key, '') COLLATE "C" < ${key} COLLATE "C"))
      `
      : await tx.$executeRaw`
        UPDATE chats SET rules_order_at = ${at}, rules_order_key = ${key}
        WHERE id = ${chatId} AND (rules_order_at IS NULL OR rules_order_at < ${at}
          OR (rules_order_at = ${at} AND COALESCE(rules_order_key, '') COLLATE "C" < ${key} COLLATE "C"))
      `;
  return changed === 1;
}

@Injectable()
export class GroupCommandAuthorityService {
  private legacyStartCutoff: Promise<Date | null> | null = null;
  private readonly legacyHolds?: WebhookLegacyHoldService;
  constructor(
    private readonly prisma: PrismaService,
    @Optional() legacyHolds?: WebhookLegacyHoldService,
  ) {
    this.legacyHolds = legacyHolds ?? WebhookLegacyHoldService.forPrisma(prisma);
  }

  async isHeldSource(update: MaxUpdate): Promise<boolean> {
    return (await this.legacyHolds?.isUpdateHeld(update)) ?? false;
  }

  async observeStart(update: MaxUpdate): Promise<void> {
    const chatId = update.message?.chatId?.trim() ?? '';
    const messageId = update.message?.messageId?.trim() ?? '';
    const semanticKey = buildGroupCommandKey(chatId, messageId);
    const dedupKey = update.botId ? `${update.botId}:${update.updateId}` : String(update.updateId);
    const receipt = await this.prisma.webhookEvent.findUnique({ where: { dedupKey } });
    if (!receipt) throw new Error('Group Start requires a persisted webhook receipt');
    if (await this.legacyHolds?.isUpdateHeld(update)) {
      const command = await this.legacyHolds!.readFreshCommandReceipt(receipt.id, update);
      if (!command || command.deadlineAt.getTime() <= Date.now()) return;
    }
    await this.prisma.$transaction(async (tx) => {
      // FLAG: Serialize absent command authority before locking its receipt. A stale
      // observer must not create a claim after positive no-replay settlement.
      await lockWebhookSemanticClaimFences(tx, [semanticKey]);
      if (!(await lockWebhookClaimReceiptAdmission(tx, receipt.id))) return;
      // FLAG: Completion locks the claim before its receipt. Read committed identity
      // without locking; an INSERT conflict under the receipt lock reverses that order.
      const existingClaim = await tx.webhookExecutionClaim.findUnique({
        where: { kind_semanticKey: { kind: 'COMMAND', semanticKey } },
        select: { id: true },
      });
      if (existingClaim) return;
      await tx.webhookExecutionClaim.createMany({
        data: [
          {
            kind: 'COMMAND',
            semanticKey,
            webhookEventId: receipt.id,
            enforced: true,
            status: 'PENDING',
            preparedAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });
    });
  }

  async inspectLegacyStart(
    permit: GroupCommandPermit,
    botIds: readonly string[],
  ): Promise<'fresh' | 'recovered' | 'hold'> {
    if (await this.legacyHolds?.isMessageHeld(permit.chatId, permit.messageId)) return 'hold';
    const cutoff = await this.readLegacyStartCutoff();
    const semanticKey = `message:message_created:${permit.chatId}:${permit.messageId}`;
    const execution = await this.prisma.webhookExecutionClaim.findUnique({
      where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey } },
      include: { webhookEvent: true },
    });
    const command = await this.prisma.webhookExecutionClaim.findUnique({
      where: { id: permit.claimId },
    });
    const owner = await this.prisma.webhookEvent.findUnique({
      where: { id: permit.webhookEventId },
    });
    if (!owner || !command?.webhookEventId || (execution && !execution.webhookEvent)) return 'hold';
    const receipts = await this.prisma.webhookEvent.findMany({
      where: { semanticKey },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 65,
    });
    if (receipts.length > 64) return 'hold';
    const originalReceipts = [
      ...receipts,
      owner,
      ...(execution?.webhookEvent ? [execution.webhookEvent] : []),
    ];
    const keys = new Set<string>();
    for (const receipt of originalReceipts) {
      const payload = receipt.normalizedPayload as unknown as MaxUpdate;
      if (
        payload.type !== 'message_created' ||
        payload.message?.chatId !== permit.chatId ||
        payload.message?.messageId !== permit.messageId
      )
        return 'hold';
      for (const botId of new Set([payload.botId, receipt.botId, ...botIds])) {
        if (botId)
          keys.add(buildLegacyStartLedgerKey(permit.chatId, String(payload.updateId), botId));
      }
    }
    const pendingKeys = [...keys];
    let recovered = false;
    while (pendingKeys.length) {
      const ledgers = await this.prisma.maxActionLedgerEntry.findMany({
        where: { jobId: { in: pendingKeys.splice(0, 64) } },
        select: {
          status: true,
          ambiguous: true,
          remoteMessageId: true,
          dispatchStartedAt: true,
          dispatchToken: true,
          firstAttemptAt: true,
          attemptCount: true,
          lastStatusCode: true,
        },
      });
      for (const ledger of ledgers) {
        if (ledger.status === 'SUCCEEDED' && ledger.remoteMessageId && !ledger.ambiguous) {
          recovered = true;
          continue;
        }
        // FLAG: Only a proven rejection can release an old bot-scoped send. Missing
        // dispatch attribution, a crash or an unknown outcome never proves absence.
        const definiteRejection =
          !ledger.ambiguous &&
          !ledger.dispatchToken &&
          !ledger.dispatchStartedAt &&
          ledger.lastStatusCode !== null &&
          ledger.lastStatusCode >= 400 &&
          ledger.lastStatusCode < 500 &&
          ledger.lastStatusCode !== 408;
        if (!definiteRejection) return 'hold';
      }
    }
    if (recovered) return 'recovered';
    // FLAG: Absence of a legacy SEND row proves nothing for a receipt accepted before
    // the quiescent migration cutover. Semantic backfill cannot turn it into new proof.
    if (
      !cutoff ||
      originalReceipts.some(
        (receipt) => receipt.createdAt <= cutoff || receipt.semanticKey !== semanticKey,
      )
    )
      return 'hold';
    if (
      execution?.preparedAt &&
      (!command?.preparedAt || execution.preparedAt < command.preparedAt)
    )
      return 'hold';
    if (
      originalReceipts.some(
        (receipt) =>
          receipt.processedAt && (!command?.preparedAt || receipt.processedAt < command.preparedAt),
      )
    )
      return 'hold';
    return 'fresh';
  }

  async claim(update: MaxUpdate, executionBotId: string): Promise<GroupCommandPermit | null> {
    const chatId = update.message?.chatId?.trim() ?? '';
    const messageId = update.message?.messageId?.trim() ?? '';
    const semanticKey = buildGroupCommandKey(chatId, messageId);
    const dedupKey = update.botId ? `${update.botId}:${update.updateId}` : String(update.updateId);
    const receipt = await this.prisma.webhookEvent.findUnique({ where: { dedupKey } });
    if (!receipt) throw new Error('Group command requires a persisted webhook receipt');
    if (await this.legacyHolds?.isUpdateHeld(update)) {
      const command = await this.legacyHolds!.readFreshCommandReceipt(receipt.id, update);
      if (!command) return null;
    }
    const admitted = await this.prisma.$transaction(async (tx) => {
      // FLAG: Wait for the same semantic fence as receipt disposition, then reread
      // exact receipt admission. Contention is not evidence that a command is closed.
      await lockWebhookSemanticClaimFences(tx, [semanticKey]);
      if (!(await lockWebhookClaimReceiptAdmission(tx, receipt.id))) return false;
      // FLAG: Retain claim-before-receipt completion order when authority already
      // exists; the semantic fence serializes only absent-authority creation.
      const existingClaim = await tx.webhookExecutionClaim.findUnique({
        where: { kind_semanticKey: { kind: 'COMMAND', semanticKey } },
        select: { id: true },
      });
      if (existingClaim) return true;
      await tx.webhookExecutionClaim.createMany({
        data: [
          {
            kind: 'COMMAND',
            semanticKey,
            webhookEventId: receipt.id,
            executionBotId,
            enforced: true,
            status: 'PENDING',
          },
        ],
        skipDuplicates: true,
      });
      return true;
    });
    if (!admitted) return null;
    let claim = await this.prisma.webhookExecutionClaim.findUnique({
      where: { kind_semanticKey: { kind: 'COMMAND', semanticKey } },
      include: { webhookEvent: true },
    });
    if (!claim || claim.status === 'COMPLETED') return null;
    if (!claim.executionBotId) {
      await this.prisma.webhookExecutionClaim.updateMany({
        where: { id: claim.id, executionBotId: null, status: 'PENDING', leaseToken: null },
        data: { executionBotId },
      });
      claim = await this.prisma.webhookExecutionClaim.findUnique({
        where: { id: claim.id },
        include: { webhookEvent: true },
      });
      if (!claim) throw new Error('Group command authority disappeared');
    }
    if (!claim.webhookEventId || !claim.webhookEvent)
      throw new Error('Group command owner receipt is missing');
    const ownerUpdate = claim.webhookEvent.normalizedPayload as unknown as MaxUpdate;
    if (
      ownerUpdate.type !== 'message_created' ||
      ownerUpdate.message?.chatId !== chatId ||
      ownerUpdate.message?.messageId !== messageId ||
      !claim.executionBotId ||
      claim.webhookEvent.timeoutQuarantineExpiresAt ||
      isPendingWebhookTimeoutQuarantineMessage(claim.webhookEvent.errorMessage) ||
      isTerminalWebhookTimeoutQuarantineMessage(claim.webhookEvent.errorMessage) ||
      /ambiguous/iu.test(claim.webhookEvent.errorMessage ?? '')
    ) {
      throw new Error('Group command authority proof is unavailable');
    }
    const leaseToken = randomUUID();
    const now = new Date();
    const acquired = await this.prisma.webhookExecutionClaim.updateMany({
      where: {
        id: claim.id,
        kind: 'COMMAND',
        semanticKey,
        webhookEventId: claim.webhookEventId,
        executionBotId: claim.executionBotId,
        status: { in: ['PENDING', 'READY'] },
        enforced: true,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { leaseToken, leaseExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS) },
    });
    if (acquired.count !== 1) return null;
    const eventAt = readWebhookEventTimestamp(ownerUpdate) ?? claim.webhookEvent.createdAt;
    // FLAG: A future MAX timestamp must never fence later authenticated UI writes.
    // The immutable receipt acceptance time is the causal upper bound for commands.
    const sourceAt = new Date(Math.min(eventAt.getTime(), claim.webhookEvent.createdAt.getTime()));
    return {
      claimId: claim.id,
      semanticKey,
      webhookEventId: claim.webhookEventId,
      executionBotId: claim.executionBotId,
      leaseToken,
      chatId,
      messageId,
      leaseExpiresAt: new Date(now.getTime() + COMMAND_LEASE_MS),
      executionDeadlineAt: claim.webhookEvent.executionDeadlineAt,
      sourceAt,
      result: claim.commandResult as unknown as GroupCommandResult | null,
    };
  }

  async prepareResult(
    permit: GroupCommandPermit,
    result: GroupCommandResult,
    tx: CommandDatabase = this.prisma,
  ): Promise<void> {
    await this.assertPermitAllowed(permit, tx);
    const changed = await tx.webhookExecutionClaim.updateMany({
      where: {
        ...this.ownedWhere(permit),
        status: 'PENDING',
        commandResult: { equals: Prisma.DbNull },
      },
      data: { status: 'READY', commandResult: result, preparedAt: new Date() },
    });
    if (changed.count !== 1) throw new Error('Group command result authority lost');
  }

  closureNoticeDeadline(permit: GroupCommandPermit, tx: CommandDatabase = this.prisma) {
    return groupClosureNoticeDeadline(tx, permit);
  }

  async assertOwned(permit: GroupCommandPermit, tx: CommandDatabase = this.prisma): Promise<void> {
    await this.assertPermitAllowed(permit, tx);
    const leaseExpiresAt = new Date(Date.now() + COMMAND_LEASE_MS);
    const changed = await tx.webhookExecutionClaim.updateMany({
      where: this.ownedWhere(permit),
      data: { leaseExpiresAt },
    });
    if (changed.count !== 1) throw new Error('Group command lease lost');
    permit.leaseExpiresAt = leaseExpiresAt;
  }

  async prepareQueuedResult(permit: GroupCommandPermit, action: 'BAN' | 'MUTE'): Promise<void> {
    // FLAG: Queue acceptance is a durable handoff, not a confirmed remote sanction.
    // SQL failure must propagate outside enqueue catches and retain the whole-engine fence.
    const result: GroupCommandResult = {
      action,
      outcome: 'QUEUED',
      noticeText: null,
      applied: false,
    };
    await this.prepareResult(permit, result);
    permit.result = result;
  }

  async isFreshHeldCommandAccessAllowed(
    permit: GroupCommandPermit,
    max: MaxClientService,
  ): Promise<boolean> {
    if (!this.legacyHolds) return true;
    const event = await this.prisma.webhookEvent.findUnique({
      where: { id: permit.webhookEventId },
    });
    if (!event) throw new Error('Command receipt is missing');
    const update = event.normalizedPayload as unknown as MaxUpdate;
    if (!(await this.legacyHolds.isUpdateHeld(update))) return true;
    const proof = await this.legacyHolds.readFreshCommandReceipt(event.id, update);
    return !!proof && verifyFreshHeldCommandAccess(max, proof, permit.executionBotId);
  }

  async assertFreshHeldCommandAccess(
    permit: GroupCommandPermit,
    max: MaxClientService,
  ): Promise<void> {
    if (!(await this.isFreshHeldCommandAccessAllowed(permit, max)))
      throw new WebhookLegacyHoldRejectedError();
  }

  private async assertPermitAllowed(
    permit: GroupCommandPermit,
    tx: CommandDatabase,
  ): Promise<void> {
    if (!this.legacyHolds) return;
    if (await this.legacyHolds.isMessageHeld(permit.chatId, permit.messageId, tx))
      throw new WebhookLegacyHoldRejectedError();
    const receipt = await tx.webhookEvent.findUnique({
      where: { id: permit.webhookEventId },
      select: { normalizedPayload: true },
    });
    if (!receipt) throw new Error('Group command source receipt is missing');
    const update = receipt.normalizedPayload as unknown as MaxUpdate;
    if (await this.legacyHolds.isUpdateHeld(update, tx)) {
      const command = await this.legacyHolds.readFreshCommandReceipt(
        permit.webhookEventId,
        update,
        tx,
      );
      if (!command) throw new WebhookLegacyHoldRejectedError();
    }
  }

  async complete(permit: GroupCommandPermit, tx: CommandDatabase = this.prisma): Promise<void> {
    const changed = await tx.webhookExecutionClaim.updateMany({
      where: this.ownedWhere(permit),
      data: {
        status: 'COMPLETED',
        preparedAt: new Date(),
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (changed.count !== 1) throw new Error('Group command lease lost before completion');
  }

  async release(permit: GroupCommandPermit): Promise<void> {
    await this.prisma.webhookExecutionClaim.updateMany({
      where: this.ownedWhere(permit),
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }

  private ownedWhere(permit: GroupCommandPermit): Prisma.WebhookExecutionClaimWhereInput {
    return {
      id: permit.claimId,
      kind: 'COMMAND',
      semanticKey: permit.semanticKey,
      webhookEventId: permit.webhookEventId,
      executionBotId: permit.executionBotId,
      enforced: true,
      status: { in: ['PENDING', 'READY'] },
      leaseToken: permit.leaseToken,
      leaseExpiresAt: { gt: new Date() },
    };
  }

  private readLegacyStartCutoff(): Promise<Date | null> {
    this.legacyStartCutoff ??= this.prisma.$queryRaw<Array<{ finishedAt: Date | null }>>`
      SELECT finished_at AS "finishedAt" FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND rolled_back_at IS NULL AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1
    `.then((rows) => rows[0]?.finishedAt ?? null);
    return this.legacyStartCutoff;
  }
}
