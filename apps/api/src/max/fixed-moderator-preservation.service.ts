import { Injectable, ConflictException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { executionRouteProof, type MaxExecutionOwnerState } from './max-execution-route-proof';
import { requiredFixedModeratorPurposes } from './max-fixed-moderator-assignment.service';
import { readFixedModeratorSettingsPurposes } from './fixed-moderator-capabilities';
import { canExecuteActionsForBotState } from './max-bot-state.util';

const AUTHORITY = 'system:fixed-moderator-preservation';
const ACTIONS = [
  'SEND_MESSAGE',
  'DELETE_MESSAGE',
  'KICK_MEMBER',
  'BAN_MEMBER',
  'UNBAN_MEMBER',
] as const;
const RECEIPT_LIMIT = 64;
const WINDOW_MS = 60 * 60_000;

type Receipt = {
  id: string;
  actionType: string;
  status: string;
  ambiguous: boolean;
  terminal: boolean;
  dispatchBotId: string | null;
  dispatchStartedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};
export function moderatorPreservationReceiptQuery(
  chatId: string,
  actionType: (typeof ACTIONS)[number],
  observedAt: Date,
) {
  return Prisma.sql`SELECT id, action_type AS "actionType", status::text AS status,
    ambiguous, terminal, dispatch_bot_id AS "dispatchBotId", dispatch_started_at AS "dispatchStartedAt",
    completed_at AS "completedAt", updated_at AS "updatedAt"
    FROM "max_action_ledger"
    WHERE chat_id = ${chatId} AND action_type = ${actionType}
      AND updated_at >= ${new Date(observedAt.getTime() - WINDOW_MS)}
    ORDER BY updated_at DESC LIMIT ${RECEIPT_LIMIT + 1}`;
}

export type ModeratorPreservationPreview = {
  chatId: string;
  botId: string | null;
  routingVersion: number;
  observedAt: string;
  digest: string;
  eligible: boolean;
  reason:
    | 'eligible'
    | 'already_fixed'
    | 'no_current'
    | 'membership_limit'
    | 'rights'
    | 'receipt_limit'
    | 'uncertain_effect'
    | 'split_executor'
    | 'no_confirmation';
  receiptCount: number;
};

/** FLAG: Operator preservation is a separate authority from human selection. It can only
 * freeze the existing executor, never activate a bot, redistribute a chat, or replay work. */
@Injectable()
export class FixedModeratorPreservationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async preview(chatId: string, observedAt = new Date()): Promise<ModeratorPreservationPreview> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
        await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '5000ms'`;
        await tx.$executeRaw`SET LOCAL max_parallel_workers_per_gather = 0`;
        return this.inspect(tx, chatId, observedAt);
      },
      { timeout: 5_000 },
    );
  }

  async explain(chatId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
        await tx.$executeRaw`SET LOCAL max_parallel_workers_per_gather = 0`;
        const plans = [];
        for (const actionType of ACTIONS) {
          const query = moderatorPreservationReceiptQuery(chatId, actionType, new Date());
          const rows = await tx.$queryRaw<
            Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
          >(Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`);
          const nodes: Array<Record<string, unknown>> = [];
          const pending = [rows[0]?.['QUERY PLAN'][0]?.Plan];
          while (pending.length) {
            const node = pending.shift();
            if (!node || nodes.length >= 32) throw new Error('Unexpected preservation query plan');
            // FLAG: Exclude predicates and identifiers from the operator output.
            nodes.push(
              Object.fromEntries(
                ['Node Type', 'Index Name', 'Plan Rows', 'Total Cost'].map((key) => [
                  key,
                  node[key],
                ]),
              ),
            );
            if (Array.isArray(node.Plans)) pending.push(...node.Plans);
          }
          plans.push({ actionType, nodes });
        }
        return { protocol: 'PRESERVE_EXISTING_MODERATOR_V1', explainOnly: true, plans };
      },
      { timeout: 8_000 },
    );
  }

  private async inspect(
    tx: Prisma.TransactionClient,
    chatId: string,
    observedAt: Date,
  ): Promise<ModeratorPreservationPreview> {
    const chat = await tx.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        entityType: true,
        primaryBotId: true,
        botId: true,
        fixedModeratorBotId: true,
        routingVersion: true,
        botMemberships: { orderBy: { botId: 'asc' }, take: 65 },
      },
    });
    if (!chat) throw new ConflictException('Community no longer exists');
    const botId = chat.primaryBotId ?? chat.botId;
    const candidates = chat.botMemberships.filter((member) => {
      const bot = this.registry.getBotById(member.botId);
      return bot && canExecuteActionsForBotState(bot.state);
    });
    const state: MaxExecutionOwnerState = {
      chatId,
      entityType: chat.entityType,
      primaryBotId: botId,
      routingVersion: chat.routingVersion,
      candidates,
    };
    const duties = await readFixedModeratorSettingsPurposes(
      tx,
      chatId,
      chat.entityType,
      this.config?.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED') === true,
    );
    const required = [...new Set([...requiredFixedModeratorPurposes(state), ...duties])].sort();
    const receipts: Receipt[] = [];
    let reason: ModeratorPreservationPreview['reason'] = chat.fixedModeratorBotId
      ? 'already_fixed'
      : !botId
        ? 'no_current'
        : chat.botMemberships.length > 64
          ? 'membership_limit'
          : required.some((purpose) => !executionRouteProof(state, botId, purpose))
            ? 'rights'
            : 'eligible';
    if (reason === 'eligible') {
      // FLAG: The existing (chat_id, action_type, updated_at) index bounds each fixed
      // status-independent window before classification. Saturation refuses fixation.
      for (const actionType of ACTIONS) {
        const rows = await tx.$queryRaw<Receipt[]>(
          moderatorPreservationReceiptQuery(chatId, actionType, observedAt),
        );
        if (rows.length > RECEIPT_LIMIT) {
          reason = 'receipt_limit';
          break;
        }
        receipts.push(...rows);
      }
      if (reason === 'eligible') {
        // FLAG: Publisher is independent of moderator assignment. Its exact configured
        // receipts never nominate or block a moderator, and remain untouched.
        const publisherBotId = this.registry.getPublisherBotDescriptor().id;
        const started = receipts.filter(
          (row) =>
            row.dispatchBotId !== publisherBotId &&
            (row.dispatchStartedAt !== null || row.ambiguous),
        );
        const confirmed = started.filter(
          (row) => row.status === 'SUCCEEDED' && row.terminal && !row.ambiguous && row.completedAt,
        );
        if (started.some((row) => row.ambiguous || !row.terminal)) reason = 'uncertain_effect';
        else if (confirmed.some((row) => row.dispatchBotId !== botId)) reason = 'split_executor';
        else if (confirmed.length === 0) reason = 'no_confirmation';
      }
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          chatId,
          botId,
          entityType: chat.entityType,
          routingVersion: chat.routingVersion,
          fixed: chat.fixedModeratorBotId,
          required,
          memberships: candidates.map((member) => ({
            botId: member.botId,
            status: member.status,
            role: member.role,
            access: member.botAccessState,
            checkedAt: member.botAccessCheckedAt,
            source: member.botAccessSource,
            permissions: member.permissionsSnapshot,
            lifecycleEventAt: member.lifecycleEventAt,
          })),
          reason,
        }),
      )
      .digest('hex');
    return {
      chatId,
      botId,
      routingVersion: chat.routingVersion,
      observedAt: observedAt.toISOString(),
      digest,
      eligible: reason === 'eligible',
      reason,
      receiptCount: receipts.length,
    };
  }

  async preserve(request: ModeratorPreservationPreview & { operationId: string }) {
    if (
      !request.eligible ||
      request.reason !== 'eligible' ||
      !request.botId ||
      !/^[a-f0-9]{64}$/u.test(request.digest) ||
      !Number.isFinite(Date.parse(request.observedAt))
    )
      throw new ConflictException('Fresh eligible preservation preview required');
    const botId = request.botId;
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
        await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '5000ms'`;
        await tx.$executeRaw`SET LOCAL max_parallel_workers_per_gather = 0`;
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM chats WHERE id = ${request.chatId} FOR UPDATE
      `);
        if (locked.length !== 1) throw new ConflictException('Community no longer exists');
        const prior = await tx.managedModeratorAssignment.findUnique({
          where: { id: request.operationId },
        });
        if (prior) {
          if (
            prior.actorUserId !== AUTHORITY ||
            prior.chatId !== request.chatId ||
            prior.botId !== botId ||
            prior.expectedRoutingVersion !== request.routingVersion
          )
            throw new ConflictException('Preservation operation identity conflict');
          return prior;
        }
        if (
          Date.parse(request.observedAt) > Date.now() ||
          Date.now() - Date.parse(request.observedAt) > 5 * 60_000
        )
          throw new ConflictException('Fresh eligible preservation preview required');
        await tx.$queryRaw(Prisma.sql`
        SELECT id FROM chat_bot_memberships WHERE chat_id = ${request.chatId} ORDER BY bot_id, id LIMIT 65 FOR UPDATE
      `);
        await tx.$queryRaw(
          Prisma.sql`SELECT chat_id FROM chat_settings WHERE chat_id = ${request.chatId} FOR SHARE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT chat_id FROM channel_settings WHERE chat_id = ${request.chatId} FOR SHARE`,
        );
        const current = await this.inspect(tx, request.chatId, new Date());
        if (!current.eligible || current.digest !== request.digest || current.botId !== botId)
          throw new ConflictException(
            'Existing executor, duties or access changed; preserve legacy routing',
          );
        const revision = request.routingVersion + 1;
        await tx.chat.update({
          where: { id: request.chatId },
          data: {
            fixedModeratorBotId: botId,
            primaryBotId: botId,
            botId: botId,
            routingVersion: revision,
            routingState: 'READY',
          },
        });
        await tx.chatBotMembership.updateMany({
          where: { chatId: request.chatId, role: 'PRIMARY', botId: { not: botId } },
          data: { role: 'STANDBY' },
        });
        await tx.chatBotMembership.update({
          where: { chatId_botId: { chatId: request.chatId, botId: botId } },
          data: { role: 'PRIMARY' },
        });
        const result = await tx.managedModeratorAssignment.create({
          data: {
            id: request.operationId,
            chatId: request.chatId,
            actorUserId: AUTHORITY,
            botId: botId,
            previousBotId: botId,
            expectedRoutingVersion: request.routingVersion,
            routingVersion: revision,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId: request.chatId,
            actorUserId: AUTHORITY,
            action: 'PRESERVE_MODERATOR',
            payload: {
              protocol: 'PRESERVE_EXISTING_MODERATOR_V1',
              operationId: request.operationId,
              digest: request.digest,
              botId: botId,
              routingVersion: revision,
              receiptCount: current.receiptCount,
            },
          },
        });
        return result;
      },
      { timeout: 8_000 },
    );
  }
}
