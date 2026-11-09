import { resolveMessageLimitsRuleEscalation } from './moderation-rule-escalation';
import { MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS } from './moderation.service.support';
import { RuntimeWorkerOwner, type RuntimeWorker } from '../runtime/runtime-worker-shutdown';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  SanctionAction,
  type ChatSettings,
  type ModerationRuleFollowup,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ModerationRuleSanctionGuardService } from './moderation-rule-sanction-guard.service';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import {
  MODERATION_RULE_FOLLOWUP_EXECUTOR,
  type ModerationRuleFollowupExecutor,
  type ModerationRuleFollowupPlan,
} from './moderation-rule-followup.contract';
import { readRuleFollowupEnvelope } from './moderation-rule-followup-persistence';
import { buildModerationMessageViolationProcessingClaimKey } from './moderation-message-action-claim';
import { buildMessageCountQuotaFollowupClaim } from './moderation-rule-followup-quota-claim';
import { resolveModerationMuteDurationHours } from './moderation-execution-guard-callbacks';
import { readStopWordsPolicy, withStopWordsSanctions } from './stop-words/stop-words.policy';
import {
  RuleFollowupBanOutcomeUnknownError,
  RuleFollowupSanctionInvalidError,
  type RuleFollowupSanctionJournal,
  type RuleFollowupSanctionState,
} from './moderation-rule-followup-sanction';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';

const PAGE_SIZE = 32;
const TERMINAL = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'AMBIGUOUS'];

@Injectable()
export class ModerationRuleFollowupService
  extends RuntimeWorkerOwner
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ModerationRuleFollowupService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopping = false;
  private forcedClosed = false;
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: ModerationRuleSanctionGuardService,
    private readonly bots: MaxBotLinkService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {
    super();
  }

  onModuleInit(): void {
    if (!roleRunsAction(getAppRole())) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopAdmission();
    if (this.forcedClosed) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.drainActive(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  private stopAdmission(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  private async drainActive(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }
  stopWorkerAdmission(): readonly RuntimeWorker[] {
    // FLAG: Signal discovery freezes new SQL pages before runtime drains, while stores
    // remain open. Hard shutdown preserves leases/journals for the next process.
    this.stopAdmission();
    return [
      {
        name: 'moderation-rule-followup',
        pause: async () => {
          await this.drainActive();
        },
        close: async (force?: boolean) => {
          this.forcedClosed = force === true;
          if (!force) await this.drainActive();
        },
      },
    ];
  }
  private async tick(): Promise<void> {
    if (this.inFlight || this.stopping) return;
    this.inFlight = true;
    try {
      await this.sweep();
    } catch (error) {
      this.logger.warn({ err: String(error) }, 'Rule follow-up sweep failed');
    } finally {
      this.inFlight = false;
    }
  }

  async sweep(): Promise<number> {
    if (this.stopping) return 0;
    const task = this.runSweep();
    this.active.add(task);
    try {
      return await task;
    } finally {
      this.active.delete(task);
    }
  }
  private async runSweep(): Promise<number> {
    // FLAG: Separate indexed literal-status pages bound work at fleet scale, including idle.
    // Selection uses one database wall-clock parameter so future rows remain an index
    // range. Claim and external-effect fences still use fresh wall time after locking.
    const sweepClocks = await this.prisma.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`,
    );
    const sweepAt = sweepClocks[0]!.now;
    for (const status of ['WAITING_DELETE', 'READY', 'RETRYABLE']) {
      if (this.stopping) return 0;
      await this.prisma.$executeRaw(Prisma.sql`
        WITH due AS (SELECT "id" FROM "moderation_rule_followups"
          WHERE "status" = ${status} AND "deadline_at" <= ${sweepAt}
            AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
            WHERE held."chat_id" = "moderation_rule_followups"."chat_id"
              AND held."message_id" = "moderation_rule_followups"."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
            WHERE cancelled."chat_id" = "moderation_rule_followups"."chat_id"
              AND cancelled."message_id" = "moderation_rule_followups"."message_id"))
            AND COALESCE("effects"->>'phase', 'UNSTARTED') = 'UNSTARTED'
          ORDER BY "deadline_at", "id" LIMIT ${PAGE_SIZE} FOR UPDATE SKIP LOCKED)
        UPDATE "moderation_rule_followups" row SET "status" = 'EXPIRED', "completed_at" = (clock_timestamp() AT TIME ZONE 'UTC'),
          "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC') FROM due WHERE row."id" = due."id"
      `);
    }
    let handled = 0;
    for (const status of ['READY', 'RETRYABLE', 'IN_PROGRESS']) {
      if (this.stopping) return handled;
      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(
        status === 'IN_PROGRESS'
          ? Prisma.sql`
        SELECT "id" FROM "moderation_rule_followups" WHERE "status" = 'IN_PROGRESS'
          AND "lease_expires_at" <= ${sweepAt}
          AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
            WHERE held."chat_id" = "moderation_rule_followups"."chat_id"
              AND held."message_id" = "moderation_rule_followups"."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
            WHERE cancelled."chat_id" = "moderation_rule_followups"."chat_id"
              AND cancelled."message_id" = "moderation_rule_followups"."message_id"))
          ORDER BY "lease_expires_at", "id" LIMIT ${PAGE_SIZE}
      `
          : Prisma.sql`
        SELECT "id" FROM "moderation_rule_followups" WHERE "status" = ${status}
          AND "next_attempt_at" <= ${sweepAt}
          AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
            WHERE held."chat_id" = "moderation_rule_followups"."chat_id"
              AND held."message_id" = "moderation_rule_followups"."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
            WHERE cancelled."chat_id" = "moderation_rule_followups"."chat_id"
              AND cancelled."message_id" = "moderation_rule_followups"."message_id"))
          ORDER BY "next_attempt_at", "id" LIMIT ${PAGE_SIZE}
      `,
      );
      for (let offset = 0; offset < ids.length; offset += 4) {
        if (this.stopping) return handled;
        const results = await Promise.allSettled(
          ids.slice(offset, offset + 4).map(({ id }) => this.attempt(id)),
        );
        for (const result of results) {
          if (result.status === 'fulfilled') {
            if (result.value) handled += 1;
          } else this.logger.warn({ err: String(result.reason) }, 'Rule follow-up attempt failed');
        }
      }
    }
    // FLAG: Exclude exact held sources before the page cap so retained unknown
    // journals cannot prevent unrelated receipt settlement from being selected.
    const ambiguousIds = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "moderation_rule_followups" WHERE "status" = 'AMBIGUOUS'
        AND "next_attempt_at" <= ${sweepAt}
        AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
          WHERE held."chat_id" = "moderation_rule_followups"."chat_id"
            AND held."message_id" = "moderation_rule_followups"."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
          WHERE cancelled."chat_id" = "moderation_rule_followups"."chat_id"
            AND cancelled."message_id" = "moderation_rule_followups"."message_id"))
        ORDER BY "next_attempt_at", "id" LIMIT ${PAGE_SIZE}
    `);
    const ambiguous = ambiguousIds.length
      ? await this.prisma.moderationRuleFollowup.findMany({
          where: { id: { in: ambiguousIds.map(({ id }) => id) }, status: 'AMBIGUOUS' },
          orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
          take: PAGE_SIZE,
        })
      : [];
    for (const row of ambiguous) {
      if (this.stopping) return handled;
      if (await this.legacyHolds?.isSourceAbandoned?.(row.chatId, row.messageId)) continue;
      // FLAG: Quarantine recovery is database-only. Exact positive member receipts may
      // settle SQL; unknown SENDs and missing member proofs never authorize fresh dispatch.
      const phase = record(row.effects).phase;
      if (
        record(row.actionPlan).action === 'BAN' &&
        ['UNKNOWN', 'BAN_STARTED', 'BAN_CONFIRMED'].includes(String(phase))
      ) {
        if (await this.attempt(row.id, true)) handled += 1;
      } else
        await this.prisma.moderationRuleFollowup.updateMany({
          where: { id: row.id, status: 'AMBIGUOUS' },
          data: { nextAttemptAt: new Date(Date.now() + 60000) },
        });
    }
    return handled;
  }

  async attempt(id: string, receiptOnly = false): Promise<boolean> {
    if (this.stopping) return false;
    const task = this.executeAttempt(id, receiptOnly);
    this.active.add(task);
    try {
      return await task;
    } finally {
      this.active.delete(task);
    }
  }
  private async executeAttempt(id: string, receiptOnly: boolean): Promise<boolean> {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_rule_followups" SET "status" = 'IN_PROGRESS', "lease_token" = ${leaseToken},
        "lease_expires_at" = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '30 seconds', "attempt_count" = "attempt_count" + 1,
        "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${id}
        AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
            WHERE held."chat_id" = "moderation_rule_followups"."chat_id"
              AND held."message_id" = "moderation_rule_followups"."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
            WHERE cancelled."chat_id" = "moderation_rule_followups"."chat_id"
              AND cancelled."message_id" = "moderation_rule_followups"."message_id"))
        AND (
        ("status" IN ('READY', 'RETRYABLE') AND "next_attempt_at" <= (clock_timestamp() AT TIME ZONE 'UTC')) OR
        ("status" = 'IN_PROGRESS' AND "lease_expires_at" <= (clock_timestamp() AT TIME ZONE 'UTC')) OR
        (${receiptOnly} AND "status" = 'AMBIGUOUS' AND "next_attempt_at" <= (clock_timestamp() AT TIME ZONE 'UTC')))
    `);
    if (!claimed) return false;
    let journal = this.journal(id, leaseToken, receiptOnly);
    let executionStarted = false;
    const heartbeat = setInterval(() => void this.renewLease(id, leaseToken).catch(() => {}), 5000);
    heartbeat.unref();
    try {
      const row = await this.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id } });
      if (!readRuleFollowupEnvelope(row.envelope)) throw new ModerationRuleSanctionRejectedError();
      if (
        !receiptOnly &&
        row.deadlineAt.getTime() <= Date.now() &&
        record(row.actionPlan).action === 'BAN' &&
        ['BAN_STARTED', 'BAN_CONFIRMED', 'UNKNOWN', 'SQL_COMMITTED', 'SETTLED'].includes(
          String(record(row.effects).phase),
        )
      ) {
        // FLAG: An expired started BAN may settle only exact receipts. Recovery must not
        // spend remote lookup quota preparing a notice whose original authority expired.
        journal = this.journal(id, leaseToken, true);
      }
      const plan = await this.preparePlan(row, journal);
      if (!plan) {
        await this.finish(id, leaseToken, 'CANCELLED');
        return true;
      }
      const executor = this.moduleRef.get<ModerationRuleFollowupExecutor>(
        MODERATION_RULE_FOLLOWUP_EXECUTOR,
        { strict: false },
      );
      executionStarted = true;
      await executor.executeRuleFollowup(row, plan, journal);
      await this.finish(id, leaseToken, 'COMPLETED');
    } catch (error) {
      let phase: string;
      try {
        phase = (await journal.readState()).phase;
      } catch {
        // FLAG: A lost lease or unavailable store cannot authorize this owner to finish
        // another owner's attempt. The retained lease/checkpoints recover on the next sweep.
        this.logger.warn({ id }, 'Rule follow-up failure retained after lease/store loss');
        return true;
      }
      const status =
        error instanceof RuleFollowupBanOutcomeUnknownError ||
        // FLAG: Preparation performs reads and atomic SQL only. Its failure cannot create a
        // new unknown MAX effect; retained unknown phases still fence earlier execution.
        (executionStarted && isAmbiguousMaxSendError(error)) ||
        ['BAN_STARTED', 'UNKNOWN'].includes(phase)
          ? 'AMBIGUOUS'
          : error instanceof ModerationRuleSanctionRejectedError ||
              error instanceof RuleFollowupSanctionInvalidError
            ? 'CANCELLED'
            : 'RETRYABLE';
      await this.finish(id, leaseToken, status, error);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async renewLease(id: string, token: string): Promise<void> {
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_rule_followups" SET "lease_expires_at" = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '30 seconds'
      WHERE "id" = ${id} AND "status" = 'IN_PROGRESS' AND "lease_token" = ${token}
        AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
    `);
    if (!count) throw new Error('Rule follow-up lease lost');
  }
  private async finish(id: string, token: string, status: string, error?: unknown): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_rule_followups" SET "status" = ${status}, "lease_token" = NULL,
        "lease_expires_at" = NULL, "next_attempt_at" = (clock_timestamp() AT TIME ZONE 'UTC') + ${status === 'AMBIGUOUS' ? 60000 : 1000} * INTERVAL '1 millisecond',
        "last_error" = ${error ? (status === 'AMBIGUOUS' ? 'RULE_FOLLOWUP_EFFECT_UNKNOWN' : status === 'CANCELLED' ? 'RULE_FOLLOWUP_AUTHORITY_REVOKED' : 'RULE_FOLLOWUP_RETRYABLE') : null},
        "completed_at" = ${TERMINAL.includes(status) ? new Date() : null}, "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${id} AND "status" = 'IN_PROGRESS' AND "lease_token" = ${token}
    `);
  }

  private async preparePlan(
    row: ModerationRuleFollowup,
    journal: RuleFollowupSanctionJournal,
  ): Promise<ModerationRuleFollowupPlan | null> {
    if (row.actionPlan) return readPlan(row.actionPlan, row);
    // FLAG: A fresh decision must not spend immunity or access quota before the
    // transaction's durable hold recheck. Existing plans retain receipt recovery.
    if (
      (await this.legacyHolds?.isMessageHeld(row.chatId, row.messageId)) ||
      (await this.legacyHolds?.isMemberHeld(row.chatId, row.userId)) ||
      (await this.legacyHolds?.isGlobalUserHeld(row.userId))
    )
      return null;
    const envelope = readRuleFollowupEnvelope(row.envelope)!;
    const route = await this.bots.resolveBotRoute({ purpose: 'member_access', chatId: row.chatId });
    if (!route.botId) throw new Error('Rule follow-up has no currently capable read route');
    await this.guard.assertAllowed({
      chatId: row.chatId,
      messageId: row.messageId,
      userId: row.userId,
      reasonKey: row.reasonKey,
      ruleCode: row.ruleCode,
      policySha256: row.policySha256,
      deadlineAtMs: row.deadlineAt.getTime(),
      botId: route.botId,
    });
    await journal.assertLease();
    return this.prisma.$transaction(async (tx) => {
      // FLAG: A per-user SQL lock serializes first strike+plan across processes. No Redis/MAX
      // is awaited here. The semantic claim, Violation and frozen plan commit or roll back together.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "moderation_rule_followups" WHERE "id" = ${row.id} FOR UPDATE`,
      );
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([row.chatId, row.userId])}, 8317))`,
      );
      const own = await tx.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } });
      const clocks = await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`,
      );
      let now = clocks[0]!.now;
      if (
        own.leaseToken !== row.leaseToken ||
        own.status !== 'IN_PROGRESS' ||
        !own.leaseExpiresAt ||
        own.leaseExpiresAt <= now
      )
        throw new Error('Rule follow-up plan lease lost');
      if (own.actionPlan) return readPlan(own.actionPlan, own);
      // FLAG: An existing plan may settle exact receipts; a new plan/strike must
      // never consume legacy participant evidence while its durable hold remains.
      if (
        (await this.legacyHolds?.isMessageHeld(row.chatId, row.messageId, tx)) ||
        (await this.legacyHolds?.isMemberHeld(row.chatId, row.userId, tx)) ||
        (await this.legacyHolds?.isGlobalUserHeld(row.userId, tx))
      )
        return null;
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "chats" WHERE "id" = ${row.chatId} FOR SHARE`);
      await tx.$queryRaw(
        Prisma.sql`SELECT "chat_id" FROM "chat_settings" WHERE "chat_id" = ${row.chatId} FOR SHARE`,
      );
      let settings = await tx.chatSettings.findUnique({
        where: { chatId: row.chatId },
        include: {
          chat: {
            select: {
              entityType: true,
              admins: { where: { userId: row.userId }, select: { userId: true } },
            },
          },
        },
      });
      if (
        !settings ||
        settings.chat.entityType !== 'CHAT' ||
        settings.chat.admins.length ||
        now >= row.deadlineAt ||
        fingerprintModerationSettings(settings, row.ruleCode) !== row.policySha256
      )
        return null;
      if (row.ruleCode.includes('MESSAGE_BLOCKED_')) {
        const policy = readStopWordsPolicy(settings);
        if (policy) settings = { ...settings, ...withStopWordsSanctions(settings, policy) };
      }
      const ruleCode = row.ruleCode.replace(/_DELETE$/u, '');
      const reason = await tx.moderationDeleteIntentReason.findUniqueOrThrow({
        where: { intentId_reasonKey: { intentId: row.intentId, reasonKey: row.reasonKey } },
      });
      const intent = await tx.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: row.intentId },
      });
      if (
        intent.status !== 'SUCCEEDED' ||
        intent.chatId !== row.chatId ||
        intent.messageId !== row.messageId ||
        intent.subjectUserId !== row.userId ||
        intent.sourceMessageAt?.getTime() !== row.sourceAt.getTime() ||
        row.sourceAt.getTime() + 300000 !== row.deadlineAt.getTime() ||
        reason.ruleCode !== row.ruleCode ||
        (reason.userId !== null && reason.userId !== row.userId) ||
        record(reason.metadata).moderationDeleteVerified !== true
      )
        throw new ModerationRuleSanctionRejectedError();
      let reasonDeadline = record(reason.metadata).messageLimitDeadlineAtMs;
      const decisionClocks = await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`,
      );
      now = decisionClocks[0]!.now;
      if (!own.leaseExpiresAt || own.leaseExpiresAt <= now || now >= row.deadlineAt)
        throw new ModerationRuleSanctionRejectedError();
      if (
        reasonDeadline !== undefined &&
        (!Number.isSafeInteger(reasonDeadline) || now.getTime() >= Number(reasonDeadline))
      )
        throw new ModerationRuleSanctionRejectedError();
      const quotaClaim =
        ruleCode === 'MESSAGE_COUNT_LIMIT'
          ? buildMessageCountQuotaFollowupClaim({
              chatId: row.chatId,
              userId: row.userId,
              policySha256: row.policySha256,
              metadata: reason.metadata,
              nowMs: now.getTime(),
            })
          : {};
      if (quotaClaim.deadlineAtMs !== undefined)
        reasonDeadline = Math.min(
          Number(reasonDeadline ?? quotaClaim.deadlineAtMs),
          quotaClaim.deadlineAtMs,
        );
      const key = buildModerationMessageViolationProcessingClaimKey({
        chatId: row.chatId,
        userId: row.userId,
        messageId: row.messageId,
        ruleCode,
        updateType: envelope.updateType,
      });
      const dedupeKey = quotaClaim.dedupeKey ?? key.dedupeKey;
      const existing = await tx.moderationViolationMessageClaim.findUnique({
        where: { dedupeKey },
      });
      if (existing) return null; // Existing historical/independent claim cannot be adopted.
      await tx.moderationViolationMessageClaim.create({
        data: {
          id: `${row.id}:claim`,
          dedupeKey,
          chatId: row.chatId,
          userId: row.userId,
          messageId: row.messageId,
          ruleCode,
          updateType: envelope.updateType,
          createdAt: now,
        },
      });
      await tx.violation.create({
        data: {
          id: `${row.id}:violation`,
          chatId: row.chatId,
          userId: row.userId,
          ruleCode,
          score: reason.score,
          createdAt: now,
        },
      });
      const hours = MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS;
      const manual = await tx.moderationEvent.findFirst({
        where: {
          chatId: row.chatId,
          userId: row.userId,
          ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const issuedAtMs = now.getTime();
      const since = new Date(
        Math.max(issuedAtMs - hours * 3600000, manual?.createdAt.getTime() ?? 0),
      );
      const violationCount = await tx.violation.count({
        where: {
          chatId: row.chatId,
          userId: row.userId,
          ruleCode,
          createdAt: { gte: since, lte: new Date(issuedAtMs) },
        },
      });
      const action = resolveAction(ruleCode, violationCount, settings);
      const muteDurationHours = resolveModerationMuteDurationHours(ruleCode, settings);
      const plan: ModerationRuleFollowupPlan = {
        version: 1,
        action,
        violationCount,
        issuedAtMs,
        muteExpiresAtMs: action === 'MUTE' ? issuedAtMs + muteDurationHours * 3600000 : null,
        muteDurationHours,
        eventId: `${row.id}:decision`,
        noticeKey: `${row.id}:sanction-notice`,
      };
      const saved = await tx.$executeRaw(Prisma.sql`
        UPDATE "moderation_rule_followups" SET "action_plan" = ${JSON.stringify(plan)}::jsonb,
          "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = ${row.id} AND "status" = 'IN_PROGRESS' AND "lease_token" = ${row.leaseToken}
          AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
          AND "deadline_at" > (clock_timestamp() AT TIME ZONE 'UTC')
          ${reasonDeadline === undefined ? Prisma.empty : Prisma.sql`AND ${new Date(Number(reasonDeadline))} > (clock_timestamp() AT TIME ZONE 'UTC')`}
      `);
      if (!saved) throw new ModerationRuleSanctionRejectedError();
      return plan;
    });
  }

  private journal(id: string, token: string, receiptOnly: boolean): RuleFollowupSanctionJournal {
    const assertLease = async () => {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "moderation_rule_followups" WHERE "id" = ${id} AND "status" = 'IN_PROGRESS'
          AND "lease_token" = ${token} AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
      `);
      if (!rows.length) throw new Error('Rule follow-up execution lease lost');
    };
    const readState = async (): Promise<RuleFollowupSanctionState> => {
      const rows = await this.prisma.$queryRaw<Array<{ effects: unknown }>>(Prisma.sql`
        SELECT "effects" FROM "moderation_rule_followups" WHERE "id" = ${id} AND "status" = 'IN_PROGRESS'
          AND "lease_token" = ${token} AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
      `);
      if (!rows[0]) throw new Error('Rule follow-up execution lease lost');
      const effects = record(rows[0].effects);
      return {
        ...effects,
        phase: (effects.phase as RuleFollowupSanctionState['phase']) ?? 'UNSTARTED',
      };
    };
    const patch = async (values: Record<string, unknown>, expected?: string) => {
      const count = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "moderation_rule_followups" SET "effects" = "effects" || ${JSON.stringify(values)}::jsonb,
          "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = ${id} AND "status" = 'IN_PROGRESS' AND "lease_token" = ${token}
          AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
          ${expected ? Prisma.sql`AND COALESCE("effects"->>'phase', 'UNSTARTED') = ${expected}` : Prisma.empty}
      `);
      if (!count && !expected) throw new Error('Rule follow-up checkpoint lease lost');
      return count > 0;
    };
    return {
      id,
      receiptOnly,
      assertLease,
      readState,
      beginBan: (actionKey) => patch({ phase: 'BAN_STARTED', actionKey }, 'UNSTARTED'),
      confirmBan: async (banBotId) => {
        await patch({ phase: 'BAN_CONFIRMED', banBotId });
      },
      resetAfterProvenNoEffect: async () => {
        await patch({ phase: 'UNSTARTED' });
      },
      markUnknown: async () => {
        await patch({ phase: 'UNKNOWN' });
      },
      commitSqlEvent: async (eventId) => {
        await patch({ phase: 'SQL_COMMITTED', eventId });
      },
      claimReputation: async () => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "moderation_rule_followups" SET "effects" = "effects" || '{"reputation":"STARTED"}'::jsonb
          WHERE "id" = ${id} AND "status" = 'IN_PROGRESS' AND "lease_token" = ${token}
            AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC') AND "effects"->>'reputation' IS NULL RETURNING "id"
        `);
        if (rows.length) return 'run';
        await assertLease();
        const row = await this.prisma.moderationRuleFollowup.findUniqueOrThrow({
          where: { id },
          select: { effects: true },
        });
        return record(row.effects).reputation === 'DONE' ? 'done' : 'unknown';
      },
      completeReputation: async () => {
        await patch({ reputation: 'DONE' });
      },
      settle: async () => {
        await patch({ phase: 'SETTLED' });
      },
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function readPlan(value: unknown, row: ModerationRuleFollowup): ModerationRuleFollowupPlan {
  const plan = record(value);
  if (
    plan.version !== 1 ||
    !['NONE', 'WARN', 'MUTE', 'BAN'].includes(String(plan.action)) ||
    !Number.isSafeInteger(plan.issuedAtMs) ||
    Number(plan.issuedAtMs) < row.sourceAt.getTime() ||
    Number(plan.issuedAtMs) >= row.deadlineAt.getTime() ||
    !Number.isSafeInteger(plan.violationCount) ||
    Number(plan.violationCount) < 1 ||
    plan.eventId !== `${row.id}:decision` ||
    plan.noticeKey !== `${row.id}:sanction-notice` ||
    typeof plan.muteDurationHours !== 'number' ||
    !Number.isFinite(plan.muteDurationHours) ||
    plan.muteDurationHours < 0 ||
    (plan.action === 'MUTE'
      ? !Number.isSafeInteger(plan.muteExpiresAtMs) ||
        plan.muteDurationHours <= 0 ||
        plan.muteExpiresAtMs !== Number(plan.issuedAtMs) + plan.muteDurationHours * 3600000
      : plan.muteExpiresAtMs !== null)
  )
    throw new RuleFollowupSanctionInvalidError('Invalid frozen rule follow-up plan');
  return plan as ModerationRuleFollowupPlan;
}
function resolveAction(
  rule: string,
  count: number,
  settings: ChatSettings,
): ModerationRuleFollowupPlan['action'] {
  if (rule === 'MESSAGE_RATE_LIMIT') return SanctionAction.BAN;
  return resolveMessageLimitsRuleEscalation(count, {
    banEnabled: settings.messageLimitsBanEnabled,
    muteEnabled: settings.messageLimitsMuteEnabled,
    warnEnabled: settings.messageLimitsWarnEnabled,
  });
}
