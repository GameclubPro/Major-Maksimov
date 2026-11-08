import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extractHttpStatusCode } from '../../common/http-error.util';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import {
  MAX_API_SOURCE_TAGS,
  MaxApiInternalRateLimitError,
  MaxClientService,
} from '../../max/max-client.service';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from '../../max/max-mutation-outcome.util';
import { wasMaxMemberMutationAttempted } from '../../max/max-member-error.util';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { WebhookLegacyHoldService } from '../../webhook/webhook-legacy-hold.service';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { resolveDuplicateFlowConfig, resolveDuplicateFlowOutcome } from '../duplicate-flow-policy';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from '../moderation.service.support';
import {
  buildMessageDuplicateIdentity,
  extractDuplicateMessageContent,
  exactImageSourceDigest,
} from './message-duplicate-content';
import {
  duplicateSourceDigest,
  MessageDuplicateHistoryService,
} from './message-duplicate-history.service';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import { isDuplicateScheduleOpen, resolveDuplicateDailyWindow } from './message-duplicate-schedule';
import {
  MESSAGE_DUPLICATE_SOURCE,
  messageDuplicateSettingsDigest,
  messageDuplicateOriginalSchema,
  exactImageSettingsDigest,
  messageDuplicateSanctionSettingsDigest,
  parseMessageDuplicateBinding,
  messageDuplicateEnforcementScope,
  hasValidImageComparisonEvidence,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import { MessageDuplicateAuthorizationService } from './message-duplicate-authorization.service';
import {
  MessageDuplicateGuardRejectedError,
  MessageDuplicateInitialSourceUnavailableError,
  MessageDuplicateQualificationSourceUnavailableError,
} from './message-duplicate-guard.contract';
import type { ModerationDeletePreDispatchPhase } from '../moderation-delete-intent.types';
import {
  recordModerationGuardFailure,
  type ModerationGuardProofFailure,
  type ModerationGuardProofDetail,
} from '../moderation-guard-failure-diagnostic';
import {
  recordDuplicateLookupFailure,
  type DuplicateLookupPhase,
} from './message-duplicate-lookup-diagnostic';
export { MessageDuplicateGuardRejectedError } from './message-duplicate-guard.contract';
import {
  messageDuplicateNoticeSettingsDigest,
  readMessageDuplicateNoticeProof,
  type MessageDuplicateNoticeProof,
} from './message-duplicate-notice-proof';

type MessageDuplicateGuardInput = {
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  botId: string;
  binding: MessageDuplicateBinding;
  sanctionIntentId?: string;
  sanctionPhase?: 'initial_unattempted';
  notice?: MessageDuplicateNoticeProof;
  beforeFinalAuthority?: () => Promise<void>;
  deletePhase?: ModerationDeletePreDispatchPhase;
};

@Injectable()
export class MessageDuplicateDeleteGuardService {
  private readonly parser = new WebhookParser();
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly policy: MessageDuplicatePolicyService,
    private readonly history: MessageDuplicateHistoryService,
    config: ConfigService,
    private readonly authorization: MessageDuplicateAuthorizationService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {
    this.timeoutMs = config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000;
  }

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId: string;
    authorityOnly?: boolean;
  }): Promise<'allowed' | 'absent' | 'not_applicable'> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, reasonKey: true, metadata: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 65,
    });
    if (reasons.length === 0) {
      this.metrics?.recordGuardRejection('message_duplicate_reason_missing');
      throw new MessageDuplicateGuardRejectedError('message_duplicate_reason_missing');
    }
    if (reasons.length > 64) {
      this.metrics?.recordGuardRejection('message_duplicate_reason_limit');
      throw new MessageDuplicateGuardRejectedError('message_duplicate_reason_limit');
    }
    const owned = reasons.filter(
      (reason) =>
        reason.reasonKey.startsWith('MESSAGE_DUPLICATE:') ||
        (reason.metadata as Record<string, unknown> | null)?.duplicateSource ===
          MESSAGE_DUPLICATE_SOURCE,
    );
    if (owned.length === 0) return 'not_applicable';
    // FLAG: Mixed guarded reasons must not mutually bypass their current-content checks.
    const bindings = owned.map((reason) =>
      reason.ruleCode === 'DUPLICATE_DELETE' ? parseMessageDuplicateBinding(reason.metadata) : null,
    );
    if (bindings.some((binding) => !binding)) {
      this.metrics?.recordGuardRejection('message_duplicate_binding_invalid');
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    }
    const binding = (bindings as MessageDuplicateBinding[]).sort(
      (a, b) => b.eventTimestampMs - a.eventTimestampMs,
    )[0]!;
    if (params.authorityOnly) {
      await this.assertQualificationAuthority(params.chatId, binding);
      if (!(await this.history.stillMatches(params.chatId, binding)))
        throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
      await this.assertAuthorization(params.chatId, binding);
      return 'allowed';
    }
    return this.assertMessageStillActionable({ ...params, binding });
  }

  async assertMessageStillActionable(
    params: MessageDuplicateGuardInput,
  ): Promise<'allowed' | 'absent'> {
    return this.assertSourceActionable(params, false);
  }

  private async assertSourceActionable(
    params: MessageDuplicateGuardInput,
    initialQualification: boolean,
  ): Promise<'allowed' | 'absent'> {
    try {
      const result = await this.checkMessage(params, initialQualification);
      this.metrics?.record(result === 'allowed' ? 'guard.allowed' : 'guard.absent');
      return result;
    } catch (error) {
      if (error instanceof MessageDuplicateGuardRejectedError)
        this.metrics?.recordGuardRejection(error.code);
      else this.metrics?.record('guard.unavailable');
      throw error;
    }
  }

  async qualify(params: MessageDuplicateGuardInput): Promise<number | null> {
    await this.assertQualificationAuthority(params.chatId, params.binding);
    // FLAG: Resume the immutable stage after our own deletion; the sanction guard still
    // requires its exact durable receipt. Never reserve another stage on delivery retry.
    const qualified = await this.history.qualified(params.chatId, params.binding);
    if (qualified !== null) {
      if (!(await this.history.stillMatches(params.chatId, params.binding, true)))
        throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
      await this.assertAuthorization(params.chatId, params.binding);
      return qualified;
    }
    // FLAG: A revoked initial proof cannot become actionable through MAX retries. Reject it
    // before external reads; Redis errors still retry and final source/history guards remain.
    if (!(await this.history.stillMatches(params.chatId, params.binding))) {
      this.metrics?.recordGuardRejection('message_duplicate_history_changed');
      throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
    }
    if ((await this.assertSourceActionable(params, true)) !== 'allowed') return null;
    await this.assertAuthorization(params.chatId, params.binding);
    return this.history.qualify(params.chatId, params.binding);
  }

  async assertQualificationAuthority(
    chatId: string,
    binding: MessageDuplicateBinding,
  ): Promise<void> {
    await this.assertAuthorization(chatId, binding);
    await this.assertPolicy(chatId, binding);
    await this.loadSettings(chatId, binding);
  }

  private async assertAuthorization(
    chatId: string,
    binding: MessageDuplicateBinding,
  ): Promise<void> {
    if (
      binding.version !== 3 ||
      !hasValidImageComparisonEvidence(binding) ||
      !binding.lifecycleRevision ||
      !binding.original?.revision ||
      !binding.original.originalId ||
      !binding.authorization
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    await this.assertLegacySourcesAllowed(chatId, binding);
    if (!(await this.authorization.isAllowed(chatId, binding)))
      throw new MessageDuplicateGuardRejectedError('message_duplicate_action_revoked');
  }

  private async assertLegacySourcesAllowed(
    chatId: string,
    binding: MessageDuplicateBinding,
  ): Promise<void> {
    if (!binding.original)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    if (
      await this.legacyHolds?.isAnyMessageSourceHeld(chatId, [
        { messageId: binding.messageId, userId: binding.senderId },
        { messageId: binding.original.messageId, userId: binding.original.senderId },
      ])
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_source_held');
  }

  private async checkMessage(
    params: MessageDuplicateGuardInput,
    initialQualification: boolean,
  ): Promise<'allowed' | 'absent'> {
    const { binding } = params;
    const notice = params.notice;
    const initialSanction = params.sanctionPhase === 'initial_unattempted';
    const canonicalBinding = parseMessageDuplicateBinding({
      duplicateSource: MESSAGE_DUPLICATE_SOURCE,
      messageDuplicate: binding,
    });
    const canonicalNotice = notice ? readMessageDuplicateNoticeProof(notice) : null;
    if (
      notice &&
      (!canonicalNotice ||
        notice.chatId !== params.chatId ||
        JSON.stringify(canonicalNotice.binding) !== JSON.stringify(canonicalBinding) ||
        Date.now() >= notice.deadlineAtMs)
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_notice_invalid');
    const receiptIntentId = notice?.intentId ?? params.sanctionIntentId;
    const lookupPhase: DuplicateLookupPhase = initialQualification
      ? 'qualification'
      : notice
        ? 'notice'
        : params.sanctionIntentId
          ? 'sanction'
          : params.deletePhase === 'initial_unattempted'
            ? 'initial_delete'
            : params.deletePhase === 'recheck'
              ? 'delete_recheck'
              : 'unclassified_recheck';
    const noticeReceipt = notice
      ? await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: notice.intentId },
          select: {
            id: true,
            status: true,
            chatId: true,
            messageId: true,
            subjectUserId: true,
            remoteDeleteSucceededAt: true,
            remoteDeleteSucceededBotId: true,
            succeededBotId: true,
            reasons: {
              where: { reasonKey: notice.reasonKey },
              select: {
                reasonKey: true,
                ruleCode: true,
                userId: true,
                metadata: true,
                createdAt: true,
              },
              take: 1,
            },
          },
        })
      : null;
    if (notice) {
      const reason = noticeReceipt?.reasons[0];
      const recorded = parseMessageDuplicateBinding(reason?.metadata);
      const metadata = reason?.metadata as Record<string, unknown> | null;
      if (
        noticeReceipt?.chatId !== params.chatId ||
        noticeReceipt.messageId !== params.messageId ||
        noticeReceipt.subjectUserId !== binding.senderId ||
        reason?.ruleCode !== 'DUPLICATE_DELETE' ||
        !recorded ||
        JSON.stringify(recorded) !== JSON.stringify(canonicalBinding) ||
        metadata?.count !== notice.stage.repeatCount
      )
        throw new MessageDuplicateGuardRejectedError('message_duplicate_notice_reason_changed');
    }
    await this.assertAuthorization(params.chatId, binding);
    if (!binding.original)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_binding_invalid');
    if (
      params.subjectUserId !== binding.senderId ||
      params.messageId !== binding.messageId ||
      this.bots.isKnownBotUserId(binding.senderId)
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    await this.assertPolicy(params.chatId, binding, Boolean(params.sanctionIntentId));
    const settings = await this.loadSettings(params.chatId, binding, notice);
    const options = {
      botId: params.botId,
      timeoutMs: this.timeoutMs,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
    };
    let access: Awaited<ReturnType<MaxClientService['getChatMemberAccess']>>;
    try {
      access = await this.max.getChatMemberAccess(params.chatId, binding.senderId, options);
    } catch (error) {
      // FLAG: Author lookup provenance changes no refusal, retry or member authority.
      recordDuplicateLookupFailure(error, lookupPhase, 'author');
      throw error;
    }
    // FLAG: Null is a valid uncached response without this member, not an unavailable MAX API.
    // Stop without sanctions; transport errors and malformed/mismatched responses still retry.
    if (!access)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_not_member');
    if (access.userId !== binding.senderId)
      throw new Error('Message duplicate author access unavailable');
    if (access.isAdmin || access.isOwner)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    if (access.isAdmin !== false || access.isOwner !== false)
      throw new Error('Message duplicate author access unavailable');
    let raw: Record<string, unknown> | null;
    let currentReadFailure: unknown = null;
    const sanctionBoundary = initialSanction
      ? 'duplicate_sanction_initial'
      : 'duplicate_sanction_final';
    try {
      raw = await this.lookupMessage(
        'current',
        params.chatId,
        params.messageId,
        options,
        initialQualification,
        !receiptIntentId ? params.deletePhase : undefined,
        lookupPhase,
      );
    } catch (error) {
      if (lookupPhase === 'sanction') recordModerationGuardFailure(error, sanctionBoundary);
      // FLAG: A generic GET 404 proves no absence. Only this follow-up's exact successful
      // DELETE receipt may replace the current-source read for a sanction or queued notice.
      // Returned content, original/author reads and initial deletes remain strict.
      if (
        (lookupPhase !== 'sanction' && lookupPhase !== 'notice') ||
        !isUnprovenMessageLookup404(error)
      )
        throw error;
      currentReadFailure = error;
      raw = null;
    }
    const rejectUnavailableCurrentSource = (
      proofFailure: ModerationGuardProofFailure,
      proofDetail?: ModerationGuardProofDetail,
    ): never => {
      if (lookupPhase === 'sanction')
        recordModerationGuardFailure(
          currentReadFailure,
          sanctionBoundary,
          proofFailure,
          proofDetail,
        );
      // FLAG: Only the initial sanction authorization may decline unavailable evidence
      // before any sanction state or remote mutation. This grants no absence, DELETE
      // receipt, retry or claim reset; final member/notice rechecks retain the failure.
      if (initialSanction)
        throw new MessageDuplicateGuardRejectedError(
          currentReadFailure === null
            ? 'message_duplicate_sanction_delete_unconfirmed'
            : 'message_duplicate_sanction_source_unavailable',
        );
      throw currentReadFailure;
    };
    if (!raw && !receiptIntentId) return 'absent';
    if (!raw || initialSanction) {
      // FLAG: Absence alone cannot authorize a sanction. Require our exact successful DELETE
      // receipt and its immutable binding; an unrelated deletion or an ambiguous send is insufficient.
      // Initial admission also requires this receipt while MAX still returns the source:
      // a concurrent DELETE can disappear before the next guard without a committed receipt.
      // Decline before sanction state, without waiting, resetting claims or replaying the handler.
      const receipt =
        noticeReceipt ??
        (await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: receiptIntentId },
          select: {
            id: true,
            status: true,
            chatId: true,
            messageId: true,
            subjectUserId: true,
            remoteDeleteSucceededAt: true,
            remoteDeleteSucceededBotId: true,
            succeededBotId: true,
            reasons: {
              where: { reasonKey: `MESSAGE_DUPLICATE:v1:${binding.eventTimestampMs}` },
              select: {
                reasonKey: true,
                ruleCode: true,
                userId: true,
                metadata: true,
                createdAt: true,
              },
              take: 1,
            },
          },
        }));
      const recorded = parseMessageDuplicateBinding(receipt?.reasons[0]?.metadata);
      const receiptMetadata = receipt?.reasons[0]?.metadata as Record<string, unknown> | null;
      if (
        !receipt?.remoteDeleteSucceededAt ||
        !receipt.reasons[0] ||
        receipt.reasons[0].createdAt > receipt.remoteDeleteSucceededAt ||
        receipt.chatId !== params.chatId ||
        receipt.messageId !== params.messageId ||
        receipt.subjectUserId !== binding.senderId ||
        receiptMetadata?.moderationDeleteVerified !== true ||
        !recorded ||
        recorded.contentDigest !== binding.contentDigest ||
        recorded.eventTimestampMs !== binding.eventTimestampMs ||
        recorded.controlRevision !== binding.controlRevision ||
        recorded.settingsDigest !== binding.settingsDigest ||
        recorded.version !== binding.version ||
        recorded.enforcementScope !== binding.enforcementScope ||
        recorded.lifecycleRevision !== binding.lifecycleRevision ||
        recorded.policyRevision !== binding.policyRevision ||
        JSON.stringify(recorded.authorization) !== JSON.stringify(binding.authorization) ||
        JSON.stringify(recorded.sanction) !== JSON.stringify(binding.sanction) ||
        JSON.stringify(recorded.original) !==
          JSON.stringify(messageDuplicateOriginalSchema.parse(binding.original))
      ) {
        if (currentReadFailure !== null) {
          // FLAG: Diagnose only the already rejected receipt, with fixed field labels.
          // No evidence values, new reads, retry authority or changed guard outcome.
          const detail = (): ModerationGuardProofDetail => {
            if (!receipt) return 'receipt_missing';
            if (!receipt.remoteDeleteSucceededAt) return 'delete_unconfirmed';
            if (!receipt.reasons[0]) return 'reason_missing';
            if (receipt.reasons[0].createdAt > receipt.remoteDeleteSucceededAt)
              return 'reason_after_delete';
            if (receipt.chatId !== params.chatId) return 'chat_mismatch';
            if (receipt.messageId !== params.messageId) return 'message_mismatch';
            if (receipt.subjectUserId !== binding.senderId) return 'subject_mismatch';
            if (receiptMetadata?.moderationDeleteVerified !== true) return 'reason_unverified';
            if (!recorded) return 'binding_invalid';
            if (recorded.contentDigest !== binding.contentDigest) return 'content_mismatch';
            if (recorded.eventTimestampMs !== binding.eventTimestampMs)
              return 'event_time_mismatch';
            if (recorded.controlRevision !== binding.controlRevision)
              return 'control_revision_mismatch';
            if (recorded.settingsDigest !== binding.settingsDigest) return 'settings_mismatch';
            if (recorded.version !== binding.version) return 'version_mismatch';
            if (recorded.enforcementScope !== binding.enforcementScope) return 'scope_mismatch';
            if (recorded.lifecycleRevision !== binding.lifecycleRevision)
              return 'lifecycle_revision_mismatch';
            if (recorded.policyRevision !== binding.policyRevision)
              return 'policy_revision_mismatch';
            if (JSON.stringify(recorded.authorization) !== JSON.stringify(binding.authorization))
              return 'authorization_mismatch';
            if (JSON.stringify(recorded.sanction) !== JSON.stringify(binding.sanction))
              return 'sanction_mismatch';
            return 'original_mismatch';
          };
          rejectUnavailableCurrentSource('own_delete_binding_unproven', detail());
        }
        if (initialSanction)
          throw new MessageDuplicateGuardRejectedError(
            'message_duplicate_sanction_delete_unconfirmed',
          );
        throw new MessageDuplicateGuardRejectedError('message_duplicate_unproven_absence');
      }
      if (currentReadFailure !== null || initialSanction) {
        // FLAG: Preserve the original failure unless the retained receipt proves this
        // exact v3 binding and its own confirmed executor. A healthy peer may continue;
        // this historical bot identity never grants today's route or mutation authority.
        const reason = receipt.reasons[0];
        const receiptBotId = receipt.remoteDeleteSucceededBotId;
        const succeededAtMs = receipt.remoteDeleteSucceededAt.getTime();
        const detail = (): ModerationGuardProofDetail | undefined => {
          if (canonicalBinding?.version !== 3 || canonicalBinding.enforcementScope !== 'full')
            return 'binding_invalid';
          if (receipt.id !== receiptIntentId) return 'intent_mismatch';
          if (receipt.status !== 'SUCCEEDED') return 'receipt_unfinished';
          if (!receiptBotId) return 'executor_missing';
          if (receipt.succeededBotId !== receiptBotId) return 'executor_mismatch';
          if (!this.bots.isRegisteredModerationBotId(receiptBotId)) return 'executor_unregistered';
          if (reason.reasonKey !== `MESSAGE_DUPLICATE:v1:${binding.eventTimestampMs}`)
            return 'reason_key_mismatch';
          if (reason.ruleCode !== 'DUPLICATE_DELETE') return 'reason_rule_mismatch';
          if (reason.userId !== binding.senderId) return 'reason_user_mismatch';
          if (!Number.isFinite(succeededAtMs)) return 'receipt_clock_invalid';
          if (!Number.isFinite(reason.createdAt.getTime())) return 'reason_clock_invalid';
          if (succeededAtMs > Date.now()) return 'receipt_clock_future';
          if (JSON.stringify(recorded) !== JSON.stringify(canonicalBinding))
            return 'binding_mismatch';
          return undefined;
        };
        const proofDetail = detail();
        if (proofDetail)
          rejectUnavailableCurrentSource('own_delete_sanction_receipt_unproven', proofDetail);
      }
    }
    if (raw) {
      const message = this.parser.parse({
        type: 'message_created',
        updateId: 'message-duplicate-guard',
        message: raw,
      }).message;
      if (
        !message ||
        message.chatId !== params.chatId ||
        message.messageId !== params.messageId ||
        message.senderId !== binding.senderId ||
        message.entityType === 'channel'
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_identity_changed');
      }
      const content = extractDuplicateMessageContent(raw, false);
      if (
        (binding.compareMode === 'MESSAGE' && content.sourceDigest !== binding.sourceDigest) ||
        (binding.compareMode === 'IMAGE' &&
          exactImageSourceDigest(content) !== binding.sourceDigest) ||
        buildMessageDuplicateIdentity(content, binding.compareMode, binding.mediaHashes) !==
          binding.contentDigest
      ) {
        await this.history.invalidateLifecycle({
          chatId: params.chatId,
          messageId: params.messageId,
          content,
        });
        throw new MessageDuplicateGuardRejectedError('message_duplicate_content_changed');
      }
    }
    const originalRaw = await this.lookupMessage(
      'original',
      params.chatId,
      binding.original.messageId,
      options,
      initialQualification,
      !receiptIntentId ? params.deletePhase : undefined,
      lookupPhase,
    );
    if (!originalRaw) {
      await this.history.remove(params.chatId, binding.original.messageId);
      throw new MessageDuplicateGuardRejectedError('message_duplicate_original_missing');
    }
    const originalMessage = this.parser.parse({
      type: 'message_created',
      updateId: 'message-duplicate-original-guard',
      message: originalRaw,
    }).message;
    const originalContent = extractDuplicateMessageContent(originalRaw, false);
    if (
      !originalMessage ||
      originalMessage.chatId !== params.chatId ||
      originalMessage.messageId !== binding.original.messageId ||
      originalMessage.senderId !== binding.original.senderId ||
      originalMessage.entityType === 'channel' ||
      duplicateSourceDigest(originalContent, binding.compareMode) !==
        binding.original.sourceDigest ||
      buildMessageDuplicateIdentity(
        originalContent,
        binding.compareMode,
        binding.original.mediaHashes,
      ) !== binding.original.contentDigest
    ) {
      // FLAG: A missed edit is not proof of removal. Revoke the observed evidence using its
      // actual current content; never manufacture a new publication or penalty from this read.
      await this.history.invalidateLifecycle({
        chatId: params.chatId,
        messageId: binding.original.messageId,
        content: originalContent,
      });
      throw new MessageDuplicateGuardRejectedError('message_duplicate_original_changed');
    }
    if (!(await this.history.stillMatches(params.chatId, binding, Boolean(receiptIntentId)))) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
    }
    await this.assertLegacySourcesAllowed(params.chatId, binding);
    const protection = await this.immunity.consumeForMessage({
      chatId: params.chatId,
      userId: binding.senderId,
      messageId: binding.messageId,
      scope: 'duplicate:v1',
      nightModeTimezone: settings.nightModeTimezone,
    });
    if (protection === 'granted')
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    // FLAG: Re-read policy and settings after external/content checks, including queued intents.
    await params.beforeFinalAuthority?.();
    await this.loadSettings(params.chatId, binding, notice);
    await this.assertPolicy(params.chatId, binding, Boolean(params.sanctionIntentId));
    // FLAG: A reset or lifecycle invalidation during quota waiting revokes the history
    // independently of the ordering grant. Recheck it before the final authorization read.
    if (!(await this.history.stillMatches(params.chatId, binding, Boolean(receiptIntentId))))
      throw new MessageDuplicateGuardRejectedError('message_duplicate_history_changed');
    await this.assertAuthorization(params.chatId, binding);
    if (notice && Date.now() >= notice.deadlineAtMs)
      throw new MessageDuplicateGuardRejectedError('message_duplicate_notice_expired');
    // FLAG: The final SQL/Redis read may consume the original permit. Its success
    // cannot extend a member mutation or immediate sanction notice past either deadline.
    if (Date.now() >= Math.min(binding.authorization!.deadlineAtMs, binding.original.expiresAtMs))
      throw new MessageDuplicateGuardRejectedError('message_duplicate_action_expired');
    return 'allowed';
  }

  private async lookupMessage(
    stage: 'current' | 'original',
    chatId: string,
    messageId: string,
    options: Parameters<MaxClientService['getExactMessageRow']>[2],
    initialQualification: boolean,
    deletePhase?: ModerationDeletePreDispatchPhase,
    lookupPhase: DuplicateLookupPhase = 'unclassified_recheck',
  ): Promise<Record<string, unknown> | null> {
    let row: Record<string, unknown> | null;
    try {
      row = await this.max.getExactMessageRow(chatId, messageId, options);
    } catch (error) {
      recordDuplicateLookupFailure(error, lookupPhase, stage);
      // FLAG: Only a structured message-specific 404 proves absence. An unavailable
      // source preserves evidence: initial qualification requires an unused-claim CAS;
      // the explicit first delete boundary requires a persisted retry before declining
      // only inline effects. Rechecks, sanctions and notices retain the original failure.
      if (!isConfirmedMessageAbsence(error)) {
        this.metrics?.record(
          stage === 'current'
            ? 'guard.current_lookup_unavailable'
            : 'guard.original_lookup_unavailable',
        );
        if (
          (extractHttpStatusCode(error) === 404 || isPreDispatchDuplicateReadRateLimited(error)) &&
          !wasMaxMessageSendAttempted(error) &&
          !wasMaxMemberMutationAttempted(error) &&
          !isMaxMutationOutcomeAmbiguous(error)
        ) {
          if (initialQualification)
            throw new MessageDuplicateQualificationSourceUnavailableError(stage, error);
          if (deletePhase === 'initial_unattempted')
            throw new MessageDuplicateInitialSourceUnavailableError(stage, error);
        }
        throw error;
      }
      row = null;
    }
    if (!row)
      this.metrics?.record(
        stage === 'current'
          ? 'guard.current_lookup_confirmed_absent'
          : 'guard.original_lookup_confirmed_absent',
      );
    return row;
  }

  private async assertPolicy(
    chatId: string,
    binding: MessageDuplicateBinding,
    requireFull = false,
  ): Promise<void> {
    const policy = await this.policy.resolve(chatId, true);
    if (
      (requireFull ? policy.mode !== 'full' : !['delete_only', 'full'].includes(policy.mode)) ||
      binding.version !== 3 ||
      (messageDuplicateEnforcementScope(binding) === 'full' && policy.mode !== 'full') ||
      (requireFull &&
        (messageDuplicateEnforcementScope(binding) !== 'full' || !binding.sanction)) ||
      policy.revision !== binding.controlRevision ||
      binding.eventTimestampMs < policy.effectiveAtMs ||
      !binding.original ||
      Date.now() >= binding.original.expiresAtMs ||
      binding.eventTimestampMs > Date.now() + 60_000
    ) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_policy_changed');
    }
    // FLAG: Retired whole-message photo bindings must not inherit new image-only authority.
    if (
      (binding.hasPhotos && binding.compareMode !== 'IMAGE') ||
      (binding.compareMode === 'IMAGE' &&
        (messageDuplicateEnforcementScope(binding) !== 'full' ||
          !binding.imageScope ||
          !binding.hasPhotos ||
          binding.photoControlRevision !== null))
    ) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_photo_policy_changed');
    }
  }

  private async loadSettings(
    chatId: string,
    binding: MessageDuplicateBinding,
    notice?: MessageDuplicateNoticeProof,
  ) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      include: { chat: { select: { entityType: true, admins: { select: { userId: true } } } } },
    });
    if (
      !settings?.antiDuplicateEnabled ||
      settings.chat.entityType !== 'CHAT' ||
      settings.duplicatePolicyRevision !== binding.policyRevision ||
      (binding.compareMode === 'IMAGE'
        ? exactImageSettingsDigest(settings)
        : messageDuplicateSettingsDigest(settings)) !== binding.settingsDigest ||
      (binding.compareMode === 'IMAGE' && settings.duplicatePhotoScope !== binding.imageScope) ||
      resolveDuplicateFlowConfig(settings).allowedCount + 2 !== binding.requiredCount
    ) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_settings_changed');
    }
    if (notice) {
      const outcome = resolveDuplicateFlowOutcome({
        settings,
        repeatCount: notice.stage.repeatCount,
        hash: binding.fingerprint,
        fingerprintType: 'exact',
      });
      if (
        !settings.duplicateBotMessageEnabled ||
        messageDuplicateNoticeSettingsDigest(settings) !== notice.noticePolicySha256 ||
        (notice.stage.kind === 'hit'
          ? !outcome.hit || !!outcome.decision
          : outcome.decision?.action !== notice.stage.kind ||
            outcome.decision.threshold !== notice.stage.threshold)
      )
        throw new MessageDuplicateGuardRejectedError('message_duplicate_notice_settings_changed');
    }
    if (binding.sanction) {
      const decision = resolveDuplicateFlowOutcome({
        settings,
        repeatCount: binding.sanction.repeatCount,
        hash: binding.fingerprint,
        fingerprintType: 'exact',
      }).decision;
      if (
        messageDuplicateSanctionSettingsDigest(settings, binding.compareMode === 'IMAGE') !==
          binding.sanction.settingsDigest ||
        decision?.action !== binding.sanction.action ||
        decision.threshold !== binding.sanction.threshold
      ) {
        throw new MessageDuplicateGuardRejectedError('message_duplicate_sanction_settings_changed');
      }
    }
    const dailyWindow = resolveDuplicateDailyWindow(settings, binding.eventTimestampMs);
    if (
      !isDuplicateScheduleOpen(settings, binding.eventTimestampMs) ||
      (dailyWindow &&
        (!binding.original ||
          binding.original.publishedAtMs < dailyWindow.startMs ||
          binding.original.expiresAtMs !== dailyWindow.endMs))
    )
      throw new MessageDuplicateGuardRejectedError('message_duplicate_schedule_closed');
    if (settings.chat.admins.some((admin) => admin.userId === binding.senderId)) {
      throw new MessageDuplicateGuardRejectedError('message_duplicate_author_immune');
    }
    const release = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId: binding.senderId,
        ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
        createdAt: {
          gte: new Date(dailyWindow?.startMs ?? Date.now() - binding.windowSeconds * 1000),
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (release) throw new MessageDuplicateGuardRejectedError('message_duplicate_manual_release');
    return settings;
  }
}

// FLAG: This predicate is used only at the exact source GET. Only a concrete local
// refusal before transport can enter the existing unused-claim or persisted-retry handoff.
// HTTP responses, conflicting methods and copied error fields are not that proof.
function isPreDispatchDuplicateReadRateLimited(error: unknown): boolean {
  const evidence = error as { response?: unknown; config?: { method?: unknown } } | null;
  return (
    error instanceof MaxApiInternalRateLimitError &&
    error.preDispatch === true &&
    extractHttpStatusCode(error) === null &&
    evidence?.response == null &&
    (evidence?.config?.method === undefined || evidence.config.method === 'get')
  );
}

function isConfirmedMessageAbsence(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null | undefined)
    ?.response;
  if (
    response?.status !== 404 ||
    wasMaxMessageSendAttempted(error) ||
    wasMaxMemberMutationAttempted(error) ||
    isMaxMutationOutcomeAmbiguous(error)
  )
    return false;
  const body = response.data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const row = body as Record<string, unknown>;
  // FLAG: One message-specific code cannot override a conflicting access/generic code.
  // Unavailable evidence must not remove history or manufacture an absence receipt.
  if (row.error != null && (typeof row.error !== 'object' || Array.isArray(row.error)))
    return false;
  const codes = [row.code, (row.error as Record<string, unknown> | null)?.code].filter(
    (code) => code != null,
  );
  return (
    codes.length > 0 &&
    codes.every(
      (code) =>
        typeof code === 'string' &&
        ['message.not.found', 'message_not_found', 'message.not_found'].includes(
          code.trim().toLowerCase(),
        ),
    )
  );
}

function isUnprovenMessageLookup404(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  if (
    response?.status !== 404 ||
    wasMaxMessageSendAttempted(error) ||
    wasMaxMemberMutationAttempted(error) ||
    isMaxMutationOutcomeAmbiguous(error)
  )
    return false;
  const body = response.data;
  if (!body || typeof body !== 'object') return true;
  if (Array.isArray(body)) return false;
  const row = body as Record<string, unknown>;
  const nested = row.error;
  // FLAG: MAX's generic not.found code proves neither message absence nor lost chat access.
  // It may use only the same exact own-DELETE receipt path as a codeless 404. Explicit access
  // errors, conflicting nested codes and every other coded failure retain their original fence.
  const unprovenCode = (code: unknown) => code == null || code === 'not.found';
  return (
    unprovenCode(row.code) &&
    (nested == null ||
      (typeof nested === 'object' &&
        !Array.isArray(nested) &&
        unprovenCode((nested as Record<string, unknown>).code)))
  );
}
