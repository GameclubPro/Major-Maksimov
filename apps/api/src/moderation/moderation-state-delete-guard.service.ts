import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from './moderation-delete-authority-preparation';
import { isStateVoiceReason, readStateVoiceReasonKeys } from './state-voice-delete-source';
import { AUTOMATIC_MUTE_HISTORY_MS } from './automatic-mute-cleanup';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import { ModerationSanctionStateFenceService } from './moderation-sanction-state-fence.service';
import { resolveModerationSanctionExpiry } from './moderation-sanction-expiry.util';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';

export const MODERATION_STATE_DELETE_RULES = new Set([
  'MUTE_ACTIVE_DELETE',
  'GLOBAL_SPAMMER_MESSAGE_DELETE',
  'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
  'BOT_ACCOUNT_MESSAGE_DELETE',
  'INVITATION_ACCESS_DELETE',
]);
export class ModerationStateDeleteRejectedError extends Error {
  readonly code = 'moderation_state_delete_no_longer_authorized';
}
type Reason = { ruleCode: string; reasonKey: string; metadata: unknown };

@Injectable()
export class ModerationStateDeleteGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly fence: ModerationSanctionStateFenceService,
    private readonly globalPolicy: GlobalSpammerIntelligenceService,
    private readonly config: ConfigService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
    @Optional() private readonly automaticDeleteAuthorAccess?: AutomaticDeleteAuthorAccessService,
  ) {}

  async authorize(params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId?: string;
    reasons: readonly Reason[];
    allowAbsentWithOwnedReceipt?: boolean;
    sourceMessageAt?: Date | null;
    beforeFinalAuthority?: () => Promise<void>;
  }): Promise<
    | 'not_applicable'
    | 'absent'
    | {
        reasonKeys: string[];
        deadlineAtMs: number;
        reasonDeadlines: { reasonKey: string; deadlineAtMs: number }[];
      }
  > {
    return finalizeDeleteAuthority(
      await this.prepareForDispatch(params),
      params.beforeFinalAuthority,
    );
  }

  async prepareForDispatch(
    params: Parameters<ModerationStateDeleteGuardService['authorize']>[0],
  ): Promise<
    DeleteAuthorityPreparation<Awaited<ReturnType<ModerationStateDeleteGuardService['authorize']>>>
  > {
    let reasons = params.reasons.filter((r) => MODERATION_STATE_DELETE_RULES.has(r.ruleCode));
    if (!reasons.length) return 'not_applicable';
    // FLAG: A failed remote read must not keep expired current-message authority retrying.
    // Historical automatic cleanup retains its separately verified source and deadline.
    if (params.sourceMessageAt) {
      const sourceAt = params.sourceMessageAt.getTime();
      if (!Number.isSafeInteger(sourceAt) || sourceAt <= 0 || sourceAt > Date.now()) this.reject();
      if (Date.now() >= sourceAt + 5 * 60_000) {
        reasons = reasons.filter(
          (reason) =>
            reason.ruleCode === 'MUTE_ACTIVE_DELETE' &&
            typeof this.metadata(reason.metadata).automaticMuteCleanupId === 'string',
        );
        if (!reasons.length) this.reject();
      }
    }
    const userId = params.subjectUserId;
    if (!userId || this.bots.isKnownBotUserId(userId)) this.reject();
    if (
      (await this.legacyHolds?.isMessageHeld(params.chatId, params.messageId)) ||
      (await this.legacyHolds?.isMemberHeld(params.chatId, userId))
    )
      this.reject();
    // FLAG: Historical global authority must be rejected before consuming immunity.
    // Independent local reasons retain their own current authorization in this chat.
    if (
      reasons.some((reason) => reason.ruleCode === 'GLOBAL_SPAMMER_MESSAGE_DELETE') &&
      (await this.legacyHolds?.isGlobalUserHeld(userId))
    ) {
      reasons = reasons.filter((reason) => reason.ruleCode !== 'GLOBAL_SPAMMER_MESSAGE_DELETE');
      if (!reasons.length) this.reject();
    }
    const load = async () => {
      const settings = await this.prisma.chatSettings.findUnique({
        where: { chatId: params.chatId },
        include: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
      });
      if (
        !settings ||
        settings.chat.entityType !== 'CHAT' ||
        settings.chat.admins.some((a) => a.userId === userId)
      )
        this.reject();
      return settings;
    };
    await load();
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      // FLAG: A local authority-read refusal still rejects this action. It is not
      // a fleet outage or evidence of absence; transport/429/5xx remain pressure.
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    };
    const author = await this.automaticDeleteAuthorAccess?.resolve(params.chatId, userId, options, {
      requireMembership: true,
      module: 'moderationState',
    });
    const access = author
      ? author.member
      : await this.max.getChatMemberAccess(params.chatId, userId, options);
    if (!access || (author?.isAdmin ?? Boolean(access.isAdmin || access.isOwner))) this.reject();
    if (
      access.userId !== userId ||
      typeof access.isAdmin !== 'boolean' ||
      typeof access.isOwner !== 'boolean'
    )
      throw new Error('State deletion author access unavailable');
    const voiceReasons = reasons.filter(isStateVoiceReason);
    if (voiceReasons.length) {
      const keys = await readStateVoiceReasonKeys(this.prisma, params, voiceReasons);
      reasons = voiceReasons.filter((reason) => keys.includes(reason.reasonKey));
      if (!reasons.length) this.reject();
    }
    const row = voiceReasons.length
      ? null
      : await this.max.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row && !voiceReasons.length && !params.allowAbsentWithOwnedReceipt) return 'absent';
    if (!row && !voiceReasons.length) {
      const current = await load();
      if (
        !current.removeBotsFromGroupEnabled ||
        reasons.length !== 1 ||
        reasons.some((r) => r.ruleCode !== 'BOT_ACCOUNT_MESSAGE_DELETE')
      )
        this.reject();
      // FLAG: Absent-source follow-up uses two unique probes and the requested reason's
      // original source identity. Retained history or another reason cannot lend authority.
      const intent = await this.prisma.moderationDeleteIntent.findUnique({
        where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
        select: { id: true, status: true, subjectUserId: true, sourceMessageAt: true },
      });
      if (
        !intent ||
        intent.status !== 'SUCCEEDED' ||
        intent.subjectUserId !== userId ||
        !params.sourceMessageAt ||
        intent.sourceMessageAt?.getTime() !== params.sourceMessageAt.getTime()
      )
        this.reject();
      const reasonKey = reasons[0]!.reasonKey;
      const receipt = await this.prisma.moderationDeleteIntentReason.findUnique({
        where: { intentId_reasonKey: { intentId: intent.id, reasonKey } },
        select: { ruleCode: true, userId: true, metadata: true },
      });
      const metadata = this.metadata(receipt?.metadata);
      if (
        !receipt ||
        receipt.ruleCode !== 'BOT_ACCOUNT_MESSAGE_DELETE' ||
        (receipt.userId !== null && receipt.userId !== userId) ||
        metadata.moderationDeleteVerified !== true ||
        metadata.botAccountAuthorVerified !== true ||
        this.bots.isKnownBotUserId(userId)
      )
        this.reject();
      if (
        (await this.immunity.consumeForMessage({
          chatId: params.chatId,
          userId,
          messageId: params.messageId,
          scope: 'moderation-state-delete:v1',
          nightModeTimezone: current.nightModeTimezone,
        })) === 'granted'
      )
        this.reject();
      return prepareDeleteAuthority(async () => {
        if (!(await load()).removeBotsFromGroupEnabled) this.reject();
        const deadlineAtMs = (params.sourceMessageAt?.getTime() ?? NaN) + 5 * 60_000;
        if (
          !Number.isSafeInteger(deadlineAtMs) ||
          params.sourceMessageAt!.getTime() <= 0 ||
          params.sourceMessageAt!.getTime() > Date.now() ||
          Date.now() >= deadlineAtMs
        )
          this.reject();
        return {
          reasonKeys: [reasonKey],
          deadlineAtMs,
          reasonDeadlines: [{ reasonKey, deadlineAtMs }],
        };
      });
    }
    let liveSourceAtMs = params.sourceMessageAt?.getTime() ?? NaN;
    if (row) {
      const message = this.parser.parse({
        type: 'message_created',
        updateId: 'moderation-state-delete-guard',
        message: row,
      }).message;
      if (
        !message ||
        message.chatId !== params.chatId ||
        message.messageId !== params.messageId ||
        message.senderId !== userId ||
        message.entityType === 'channel'
      )
        this.reject();
      liveSourceAtMs = Date.parse(message.createdAt);
    }
    // FLAG: A held sanction source cannot consume immunity on unrelated historical targets.
    for (const reason of [...reasons]) {
      const id = this.metadata(reason.metadata).automaticMuteCleanupId;
      if (id === undefined) continue;
      const cleanup =
        typeof id === 'string'
          ? await this.prisma.automaticMuteCleanup.findUnique({
              where: { eventId: id },
              select: { sourceMessageId: true, chatId: true, userId: true },
            })
          : null;
      if (
        !cleanup ||
        cleanup.chatId !== params.chatId ||
        cleanup.userId !== userId ||
        (await this.legacyHolds?.isMessageHeld(params.chatId, cleanup.sourceMessageId)) ||
        (await this.legacyHolds?.isGlobalUserHeld(userId))
      ) {
        reasons = reasons.filter((r) => r !== reason);
      }
    }
    if (!reasons.length) this.reject();
    const current = await load();
    const sourceAtMs = params.sourceMessageAt?.getTime() ?? liveSourceAtMs;
    const sourceDeadlineAtMs = sourceAtMs + 5 * 60_000;
    if (!Number.isSafeInteger(sourceAtMs) || sourceAtMs <= 0 || sourceAtMs > Date.now())
      this.reject();
    const evaluateReasons = async (current: Awaited<ReturnType<typeof load>>) => {
      const reasonDeadlines: { reasonKey: string; deadlineAtMs: number }[] = [];
      for (const reason of reasons) {
        if (
          reason.ruleCode === 'GLOBAL_SPAMMER_MESSAGE_DELETE' &&
          (await this.legacyHolds?.isGlobalUserHeld(userId))
        )
          continue;
        let allowed = false;
        let deadlineAtMs = sourceDeadlineAtMs;
        const historyId = this.metadata(reason.metadata).automaticMuteCleanupId;
        if (historyId === undefined && Date.now() >= sourceDeadlineAtMs) continue;
        if (reason.ruleCode === 'MUTE_ACTIVE_DELETE') {
          const metadata = this.metadata(reason.metadata);
          const latest = await this.prisma.moderationEvent.findFirst({
            where: {
              chatId: params.chatId,
              userId,
              OR: [
                { action: { in: ['MUTE', 'BAN'] } },
                { ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] } },
              ],
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, action: true, createdAt: true, metadata: true },
          });
          if (
            latest &&
            latest.id === metadata.muteEventId &&
            (latest.action === 'MUTE' || latest.action === 'BAN') &&
            (historyId !== undefined || sourceAtMs >= latest.createdAt.getTime())
          ) {
            if (historyId !== undefined) {
              const historyDeadline = await this.automaticCleanupDeadline({
                historyId,
                eventId: latest.id,
                issuedAt: latest.createdAt,
                chatId: params.chatId,
                userId,
                sourceAtMs,
                liveSourceAtMs: liveSourceAtMs,
              });
              if (historyDeadline === null) continue;
              deadlineAtMs = historyDeadline;
            }
            const expiry = resolveModerationSanctionExpiry(
              latest.action,
              latest.metadata,
              latest.createdAt,
              current.muteDurationHours,
            );
            allowed =
              (latest.action === 'MUTE' && expiry.permanent) ||
              !!(expiry.expiresAt && expiry.expiresAt.getTime() > Date.now());
            if (expiry.expiresAt) deadlineAtMs = Math.min(deadlineAtMs, expiry.expiresAt.getTime());
            if (
              allowed &&
              (await this.fence.isSanctionEventInvalidated({
                chatId: params.chatId,
                userId,
                sanctionEventId: latest.id,
                eventCreatedAt: latest.createdAt,
              }))
            )
              allowed = false;
          }
        } else if (reason.ruleCode === 'BOT_ACCOUNT_MESSAGE_DELETE') {
          const sender = this.metadata(this.metadata(row).sender);
          allowed =
            current.removeBotsFromGroupEnabled &&
            sender.is_bot === true &&
            !this.bots.isKnownBotUserId(userId);
        } else if (
          current.deleteSpammersEnabled &&
          (reason.ruleCode === 'GLOBAL_SPAMMER_MESSAGE_DELETE' ||
            reason.ruleCode === 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE')
        ) {
          const decisions = await this.prisma.adminGlobalSpammerExemption.findMany({
            where: {
              adminUserId: { in: current.chat.admins.flatMap((a) => this.variants(a.userId)) },
              userId: { in: this.variants(userId) },
            },
            select: { decision: true },
            take: 129,
          });
          if (decisions.length > 128) throw new Error('Spammer admin decision limit exceeded');
          const localBlock = decisions.some((d) => d.decision === 'BLOCK');
          const localAllow = decisions.some((d) => d.decision !== 'BLOCK');
          if (reason.ruleCode === 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE') allowed = localBlock;
          else if (!localBlock && !localAllow) {
            // FLAG: Bypass cached profile authority. Fresh policy/expiry/suppression reads are
            // shared with detection; a registry row alone cannot authorize this deletion.
            const policy = await this.globalPolicy.evaluatePolicy({
              chatId: params.chatId,
              userId,
              messageId: params.messageId,
              trigger: 'delete-final-guard',
              deleteSpammersEnabled: true,
              recordDecision: false,
              skipRuntimeProfileWrite: true,
              lookupContext: { now: new Date() },
            });
            const expiresAtMs = policy.expiresAt ? Date.parse(policy.expiresAt) : NaN;
            allowed =
              policy.action === 'DELETE_AND_KICK' &&
              Number.isFinite(expiresAtMs) &&
              expiresAtMs > Date.now();
            deadlineAtMs = Math.min(deadlineAtMs, expiresAtMs);
          }
        }
        // FLAG: Invitation access is retired. Historical pending reasons cannot revive it.
        if (allowed) reasonDeadlines.push({ reasonKey: reason.reasonKey, deadlineAtMs });
      }
      return reasonDeadlines;
    };
    const reasonDeadlines = await evaluateReasons(current);
    // FLAG: Only a current actionable reason can spend participant protection. Obsolete
    // mute/disabled-policy work must not consume the allowance before it is rejected.
    if (!reasonDeadlines.some((reason) => Date.now() < reason.deadlineAtMs)) this.reject();
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'moderation-state-delete:v1',
        nightModeTimezone: current.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    return prepareDeleteAuthority(async () => {
      const finalSettings = await load();
      const preparedDeadlines = new Map(reasonDeadlines.map((r) => [r.reasonKey, r.deadlineAtMs]));
      const currentDeadlines = (await evaluateReasons(finalSettings))
        .filter((r) => {
          if (!preparedDeadlines.has(r.reasonKey)) return false;
          const reason = reasons.find((reason) => reason.reasonKey === r.reasonKey)!;
          return (
            reason.ruleCode !== 'MUTE_ACTIVE_DELETE' ||
            finalSettings.muteDurationHours === current.muteDurationHours
          );
        })
        .map((r) => ({
          ...r,
          deadlineAtMs: Math.min(r.deadlineAtMs, preparedDeadlines.get(r.reasonKey)!),
        }));
      if (voiceReasons.length) {
        const keys = await readStateVoiceReasonKeys(this.prisma, params, reasons);
        for (let index = currentDeadlines.length - 1; index >= 0; index--) {
          if (!keys.includes(currentDeadlines[index]!.reasonKey)) currentDeadlines.splice(index, 1);
        }
      }
      const currentReasons = currentDeadlines.filter((r) => Date.now() < r.deadlineAtMs);
      if (!currentReasons.length) this.reject();
      return {
        reasonKeys: currentReasons.map((r) => r.reasonKey),
        deadlineAtMs: Math.max(...currentReasons.map((r) => r.deadlineAtMs)),
        reasonDeadlines: currentReasons,
      };
    });
  }

  private async automaticCleanupDeadline(params: {
    historyId: unknown;
    eventId: string;
    issuedAt: Date;
    chatId: string;
    userId: string;
    sourceAtMs: number;
    liveSourceAtMs: number;
  }): Promise<number | null> {
    if (params.historyId !== params.eventId || params.liveSourceAtMs !== params.sourceAtMs)
      return null;
    const row = await this.prisma.automaticMuteCleanup.findUnique({
      where: { eventId: params.eventId },
      include: { event: true },
    });
    if (
      !row ||
      !['PENDING', 'SCANNED'].includes(row.status) ||
      row.chatId !== params.chatId ||
      row.userId !== params.userId ||
      row.event.chatId !== params.chatId ||
      row.event.userId !== params.userId ||
      row.event.action !== 'MUTE' ||
      row.event.operator !== 'BOT' ||
      this.metadata(row.event.metadata).sanctionApplied !== true ||
      row.sourceMessageId !== row.event.messageId ||
      row.windowEnd.getTime() !== params.issuedAt.getTime() ||
      row.windowStart.getTime() !== params.issuedAt.getTime() - AUTOMATIC_MUTE_HISTORY_MS ||
      row.deadlineAt.getTime() !== params.issuedAt.getTime() + AUTOMATIC_MUTE_HISTORY_MS ||
      params.sourceAtMs < row.windowStart.getTime() ||
      params.sourceAtMs > row.windowEnd.getTime() ||
      Date.now() >= row.deadlineAt.getTime() ||
      (await this.legacyHolds?.isMessageHeld(params.chatId, row.sourceMessageId)) ||
      (await this.legacyHolds?.isGlobalUserHeld(params.userId))
    )
      return null;
    return row.deadlineAt.getTime();
  }

  async assertSpammerMemberAllowed(params: {
    chatId: string;
    userId: string;
    messageId: string;
    botId?: string;
    localBlock: boolean;
    beforeFinalAuthority?: () => Promise<void>;
  }): Promise<void> {
    if (
      (await this.legacyHolds?.isMessageHeld(params.chatId, params.messageId)) ||
      (await this.legacyHolds?.isMemberHeld(params.chatId, params.userId)) ||
      (await this.legacyHolds?.isGlobalUserHeld(params.userId))
    )
      this.reject();
    if (this.bots.isKnownBotUserId(params.userId)) this.reject();
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: params.chatId },
      include: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
    });
    if (
      !settings ||
      settings.chat.entityType !== 'CHAT' ||
      !settings.deleteSpammersEnabled ||
      settings.chat.admins.some((a) => a.userId === params.userId)
    )
      this.reject();
    const access = await this.max.getChatMemberAccess(params.chatId, params.userId, {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    });
    if (!access || access.isAdmin === true || access.isOwner === true) this.reject();
    if (access.userId !== params.userId || access.isAdmin !== false || access.isOwner !== false)
      throw new Error('Spammer member access unavailable');
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        scope: 'moderation-state-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    const decisions = await this.prisma.adminGlobalSpammerExemption.findMany({
      where: {
        adminUserId: { in: settings.chat.admins.flatMap((a) => this.variants(a.userId)) },
        userId: { in: this.variants(params.userId) },
      },
      select: { decision: true },
      take: 129,
    });
    if (decisions.length > 128) throw new Error('Spammer admin decision limit exceeded');
    let policyDeadlineAtMs = Number.POSITIVE_INFINITY;
    const block = decisions.some((d) => d.decision === 'BLOCK');
    if (params.localBlock) {
      if (!block) this.reject();
    } else {
      if (decisions.length) this.reject();
      const policy = await this.globalPolicy.evaluatePolicy({
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        trigger: 'member-final-guard',
        deleteSpammersEnabled: true,
        recordDecision: false,
        skipRuntimeProfileWrite: true,
        lookupContext: { now: new Date() },
      });
      policyDeadlineAtMs = policy.expiresAt ? Date.parse(policy.expiresAt) : NaN;
      if (policy.action !== 'DELETE_AND_KICK' || !Number.isFinite(policyDeadlineAtMs))
        this.reject();
    }
    // FLAG: The selected executor is rechecked after external author/policy work and
    // before the final settings and synchronous expiry permit; no later await is allowed.
    await params.beforeFinalAuthority?.();
    const final = await this.prisma.chatSettings.findUnique({ where: { chatId: params.chatId } });
    if (
      Date.now() >= policyDeadlineAtMs ||
      !final ||
      fingerprintModerationSettings(final) !== fingerprintModerationSettings(settings)
    )
      this.reject();
  }

  private variants(value: string): string[] {
    const normalized = value.trim().toLowerCase();
    return [normalized, normalized.startsWith('id') ? normalized.slice(2) : `id${normalized}`];
  }

  private metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  private reject(): never {
    throw new ModerationStateDeleteRejectedError();
  }
}
