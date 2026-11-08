import { resolveCommercialAdsPolicy } from '@maxim/contracts/settings';
import { commercialAdsDetectionCategories } from './commercial-ads-runtime-policy.service';
import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  isPreparedDeleteAuthority,
  type DeleteAuthorityPreparation,
} from '../moderation-delete-authority-preparation';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from '../moderation.service.support';
import { CommercialAdDetector } from './commercial-ad.detector';
import { normalizeCommercialRawText } from './commercial-normalization';
import {
  CommercialTextRuntimePolicyService,
  COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
  fingerprintCommercialTextSettingsProfile,
  type CommercialTextAuthority,
} from './commercial-text-runtime-policy.service';
import { isCommercialMessageDeleteEligible } from './commercial-action-policy';
import {
  COMMERCIAL_TEXT_DELETE_RULE_CODE,
  fingerprintCommercialDeleteText,
  isCommercialTextDeleteBindingCurrent,
  readCommercialTextDeleteBinding,
  fingerprintCommercialDeleteReasons,
  type CommercialDeleteSettings,
} from './commercial-delete-binding';

export class CommercialDeleteGuardRejectedError extends Error {
  reasonFingerprint?: string;
  constructor(
    readonly code:
      | 'commercial_text_authority_changed'
      | 'commercial_text_settings_disabled'
      | 'commercial_text_author_immune'
      | 'commercial_text_message_changed'
      | 'commercial_text_binding_invalid'
      | 'commercial_text_binding_stale'
      | 'commercial_text_violation_no_longer_present',
  ) {
    super('Commercial message deletion is no longer authorized');
    this.name = 'CommercialDeleteGuardRejectedError';
  }
}

type GuardInput = {
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  botId?: string;
};
type DecisionEvidence = { reasonKey: string; score: number; metadata: unknown };
type CommercialGuardProof = 'absent' | { kind: 'allowed'; reasonKeys: string[] };
export const COMMERCIAL_TEXT_MAX_INTENT_REASONS = 64;
export type CommercialSanctionPermit = Readonly<{ expiresAtMs: number }>;

@Injectable()
export class CommercialDeleteGuardService {
  private readonly parser = new WebhookParser();
  private readonly detector = new CommercialAdDetector();
  private readonly issuedPermits = new WeakMap<
    CommercialSanctionPermit,
    GuardInput & { evidence: readonly DecisionEvidence[] }
  >();
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLink: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
    @Optional() private readonly textPolicy?: CommercialTextRuntimePolicyService,
    @Optional() private readonly automaticDeleteAuthorAccess?: AutomaticDeleteAuthorAccessService,
  ) {}

  async assertIntentStillActionable(
    params: GuardInput & { intentId: string; ownedReasonsOnly?: boolean },
  ): Promise<CommercialGuardProof | 'not_applicable' | 'missing_reason'> {
    return finalizeDeleteAuthority(await this.prepareForDispatch(params));
  }

  async prepareForDispatch(
    params: Parameters<CommercialDeleteGuardService['assertIntentStillActionable']>[0],
  ): Promise<
    DeleteAuthorityPreparation<
      Awaited<ReturnType<CommercialDeleteGuardService['assertIntentStillActionable']>>
    >
  > {
    const allReasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: {
        intentId: params.intentId,
        ...(params.ownedReasonsOnly ? { ruleCode: COMMERCIAL_TEXT_DELETE_RULE_CODE } : {}),
      },
      select: { ruleCode: true, reasonKey: true, score: true, metadata: true },
      orderBy: { reasonKey: 'asc' },
      take: COMMERCIAL_TEXT_MAX_INTENT_REASONS + 1,
    });
    const reasons = allReasons;
    if (!reasons.length) return params.ownedReasonsOnly ? 'not_applicable' : 'missing_reason';
    // FLAG: Other durable reasons retain their own guards, but never prove commercial sanctions.
    if (reasons.some((reason) => reason.ruleCode !== COMMERCIAL_TEXT_DELETE_RULE_CODE))
      return 'not_applicable';
    if (
      !params.ownedReasonsOnly &&
      reasons.length > COMMERCIAL_TEXT_MAX_INTENT_REASONS &&
      (await this.prisma.moderationDeleteIntentReason.findFirst({
        where: { intentId: params.intentId, ruleCode: { not: COMMERCIAL_TEXT_DELETE_RULE_CODE } },
        select: { id: true },
      }))
    )
      return 'not_applicable';
    try {
      if (reasons.length > COMMERCIAL_TEXT_MAX_INTENT_REASONS)
        throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
      const prepared = await this.prepareMessageForDispatch({ ...params, evidence: reasons });
      if (!isPreparedDeleteAuthority(prepared)) return prepared;
      return prepareDeleteAuthority(async (finalizeNested) => {
        try {
          return await finalizeNested(prepared);
        } catch (error) {
          if (error instanceof CommercialDeleteGuardRejectedError)
            error.reasonFingerprint = fingerprintCommercialDeleteReasons(reasons);
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof CommercialDeleteGuardRejectedError)
        error.reasonFingerprint = fingerprintCommercialDeleteReasons(reasons);
      throw error;
    }
  }

  async assertMessageStillActionable(
    params: GuardInput & { evidence: readonly DecisionEvidence[] },
  ): Promise<'allowed' | 'absent'> {
    const result = await this.verifyMessage(params);
    return result === 'absent' ? result : 'allowed';
  }

  // FLAG: The caller may issue this permit only after this attempt's verified DELETE.
  // It binds a short follow-up to that exact reason; absent/recovered deletes never qualify.
  createSanctionPermit(
    params: GuardInput & {
      evidence: readonly DecisionEvidence[];
      deleted: boolean;
      commercialVerified: boolean;
    },
  ): CommercialSanctionPermit | null {
    if (!params.deleted || !params.commercialVerified || !params.subjectUserId) return null;
    const bindings = params.evidence.map((reason) => {
      const metadata = reason.metadata as Record<string, unknown> | null;
      return readCommercialTextDeleteBinding(metadata?.commercialTextBinding);
    });
    if (!bindings.length || bindings.some((binding) => !binding)) return null;
    const permit = Object.freeze({
      expiresAtMs: Math.min(
        Date.now() + 60_000,
        ...bindings.map((binding) => binding!.deadlineAtMs),
      ),
    });
    this.issuedPermits.set(permit, {
      chatId: params.chatId,
      messageId: params.messageId,
      subjectUserId: params.subjectUserId,
      botId: params.botId,
      evidence: structuredClone(params.evidence),
    });
    return permit;
  }

  async authorizeSanction(
    permit: CommercialSanctionPermit,
    options: { botId?: string; beforeFinalAuthority?: () => Promise<void> } = {},
  ): Promise<boolean> {
    try {
      const proof = this.issuedPermits.get(permit);
      if (!proof || Date.now() >= permit.expiresAtMs) return false;
      const userId = proof.subjectUserId!;
      if (this.maxBotLink.isKnownBotUserId(userId)) return false;
      const settings = await this.loadSettings(proof.chatId, userId);
      const evidence = this.resolveEvidence(proof.evidence, settings);
      await this.assertAuthority(proof.chatId, evidence, settings);
      const access = await this.maxClient.getChatMemberAccess(proof.chatId, userId, {
        botId: options.botId ?? proof.botId,
        bypassCache: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
        ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
        timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000,
      });
      // FLAG: Follow-up sanctions and notices require a current, exact regular-member proof.
      // Departure and unknown privilege flags cannot authorize an irreversible follow-up.
      if (
        !access ||
        access.userId !== userId ||
        access.isAdmin !== false ||
        access.isOwner !== false
      )
        return false;
      if (
        (await this.immunity.consumeForMessage({
          chatId: proof.chatId,
          userId,
          messageId: proof.messageId,
          scope: 'commercial-sanction:v1',
          nightModeTimezone: settings.nightModeTimezone,
        })) === 'granted'
      )
        return false;
      await options.beforeFinalAuthority?.();
      const finalSettings = await this.loadSettings(proof.chatId, userId);
      const finalEvidence = this.resolveEvidence(proof.evidence, finalSettings);
      await this.assertAuthority(proof.chatId, finalEvidence, finalSettings);
      return Date.now() < permit.expiresAtMs;
    } catch (error) {
      // FLAG: Only definite commercial revocation is a clean denial. Preserve local route
      // rejection and uncertain authority reads so safe pre-dispatch recovery can distinguish
      // a demoted executor from a changed policy without reissuing this WeakMap permit.
      if (error instanceof CommercialDeleteGuardRejectedError) return false;
      throw error;
    }
  }

  private async assertAuthority(
    chatId: string,
    evidence: ReturnType<CommercialDeleteGuardService['resolveEvidence']>,
    settings: CommercialDeleteSettings,
  ): Promise<CommercialTextAuthority> {
    const authority = (await this.textPolicy?.authority(
      chatId,
      fingerprintCommercialTextSettingsProfile(settings),
    )) ?? {
      revision: 0,
      baselineAllowed: true,
      promotedPolicyCohorts: COMMERCIAL_TEXT_BASELINE_POLICY_COHORTS,
      mode: 'baseline' as const,
    };
    if (
      !authority.baselineAllowed ||
      evidence.bindings.some(
        (binding) =>
          binding.textRuntimeRevision !== authority.revision ||
          binding.requiredPolicyCohorts.some(
            (cohort) => !authority.promotedPolicyCohorts.includes(cohort),
          ),
      )
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_authority_changed');
    return authority;
  }

  private async verifyMessage(
    params: GuardInput & { evidence: readonly DecisionEvidence[] },
  ): Promise<CommercialGuardProof> {
    return finalizeDeleteAuthority(await this.prepareMessageForDispatch(params));
  }

  private async prepareMessageForDispatch(
    params: GuardInput & { evidence: readonly DecisionEvidence[] },
  ): Promise<DeleteAuthorityPreparation<CommercialGuardProof>> {
    const userId = params.subjectUserId;
    if (!userId) throw new CommercialDeleteGuardRejectedError('commercial_text_message_changed');
    if (this.maxBotLink.isKnownBotUserId(userId))
      throw new CommercialDeleteGuardRejectedError('commercial_text_author_immune');
    const settings = await this.loadSettings(params.chatId, userId);
    const evidence = this.resolveEvidence(params.evidence, settings);
    const authority = await this.assertAuthority(params.chatId, evidence, settings);
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000,
    };
    // FLAG: Automatic DELETE uses the saved complete roster. This proof grants no sanction
    // authority; authorizeSanction keeps its own fresh exact-member check.
    const author = await this.automaticDeleteAuthorAccess?.resolve(params.chatId, userId, options, {
      requireMembership: false,
    });
    const access = author
      ? author.member
      : await this.maxClient.getChatMemberAccess(params.chatId, userId, options);
    if (access && access.userId !== null && access.userId !== userId)
      throw new Error('Commercial author access could not be verified');
    if (author?.isAdmin ?? Boolean(access?.isAdmin || access?.isOwner))
      throw new CommercialDeleteGuardRejectedError('commercial_text_author_immune');

    // FLAG: Read exactly one current message per dispatch attempt; never store or log its text.
    const row = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row) return 'absent';
    let message;
    try {
      message = this.parser.parse({
        type: 'message_created',
        updateId: 'commercial-delete-guard',
        message: row,
      }).message;
    } catch {
      throw new Error('Current commercial message could not be verified');
    }
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== userId ||
      message.entityType === 'channel'
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_message_changed');
    if (
      evidence.binding &&
      evidence.binding.sourceSha256 !== fingerprintCommercialDeleteText(message.text)
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_message_changed');
    this.assertDetection(message.text, settings, evidence, authority, userId);
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'commercial-text-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_author_immune');
    return prepareDeleteAuthority(async () => {
      const finalSettings = await this.loadSettings(params.chatId, userId);
      const finalEvidence = this.resolveEvidence(params.evidence, finalSettings);
      const finalAuthority = await this.assertAuthority(
        params.chatId,
        finalEvidence,
        finalSettings,
      );
      this.assertDetection(message.text, finalSettings, finalEvidence, finalAuthority, userId);
      return { kind: 'allowed', reasonKeys: finalEvidence.reasonKeys };
    });
  }

  private resolveEvidence(
    reasons: readonly DecisionEvidence[],
    settings: CommercialDeleteSettings,
  ) {
    if (
      !reasons.length ||
      reasons.some(
        (reason) => !Number.isFinite(reason.score) || reason.score < 0 || reason.score > 1,
      )
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
    const bindings = reasons.map((reason) => {
      const metadata =
        reason.metadata && typeof reason.metadata === 'object' && !Array.isArray(reason.metadata)
          ? (reason.metadata as Record<string, unknown>)
          : {};
      if (metadata.messageDisposition !== undefined && metadata.messageDisposition !== 'DELETE')
        throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
      if (metadata.commercialTextBinding === undefined) return null;
      const binding = readCommercialTextDeleteBinding(metadata.commercialTextBinding);
      if (!binding) throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
      return binding;
    });
    const bound = bindings.filter((binding) => binding !== null);
    const latestAt = Math.max(...bound.map((binding) => binding.eventTimestampMs));
    const selected = reasons.filter((_, index) =>
      bound.length ? bindings[index]?.eventTimestampMs === latestAt : true,
    );
    const currentBindings = bound.filter((binding) => binding.eventTimestampMs === latestAt);
    const policySnapshot = (binding: (typeof currentBindings)[number]) =>
      JSON.stringify([
        binding.textRuntimeRevision,
        [...new Set(binding.requiredPolicyCohorts)].sort(),
      ]);
    // FLAG: Every selected reason must describe the same source and policy snapshot; an
    // authorized first reason cannot lend its authority to a conflicting later reason.
    if (
      currentBindings.some(
        (binding) =>
          binding.sourceSha256 !== currentBindings[0]!.sourceSha256 ||
          policySnapshot(binding) !== policySnapshot(currentBindings[0]!),
      )
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_binding_invalid');
    if (currentBindings.some((binding) => !isCommercialTextDeleteBindingCurrent(binding, settings)))
      throw new CommercialDeleteGuardRejectedError('commercial_text_binding_stale');
    // FLAG: Legacy decisions may be rechecked, but cannot lend unbound historical campaign evidence.
    return {
      minimumScore: Math.max(...selected.map((reason) => reason.score)),
      binding: currentBindings[0] ?? null,
      bindings: currentBindings,
      reasonKeys: selected.map((reason) => reason.reasonKey),
      campaignContext: currentBindings.every(
        (binding) =>
          JSON.stringify(binding.campaignContext) ===
          JSON.stringify(currentBindings[0]!.campaignContext),
      )
        ? (currentBindings[0]?.campaignContext ?? null)
        : null,
    };
  }

  private assertDetection(
    text: string,
    settings: CommercialDeleteSettings,
    evidence: ReturnType<CommercialDeleteGuardService['resolveEvidence']>,
    authority: CommercialTextAuthority,
    userId: string,
  ) {
    const detection = this.detector.detect({
      normalizedText: '',
      rawLoweredText: normalizeCommercialRawText(text),
      promotedPolicyCohorts: authority.promotedPolicyCohorts,
      settings: settings as import('../../prisma/prisma-client').ChatSettings,
      commercialCampaignContext: evidence.campaignContext,
    });
    const policy = resolveCommercialAdsPolicy({
      policy: settings.commercialAdsPolicy,
      categories: commercialAdsDetectionCategories(detection),
      userId,
    });
    if (
      (policy.decision !== 'LEGACY' && policy.decision !== 'BLOCK') ||
      !detection ||
      detection.confidenceScore / 100 < evidence.minimumScore ||
      !isCommercialMessageDeleteEligible(
        detection.actionBand ?? null,
        detection.actionable === true,
        detection.messageDisposition,
      )
    )
      throw new CommercialDeleteGuardRejectedError('commercial_text_violation_no_longer_present');
  }

  private async loadSettings(chatId: string, userId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        commercialAdsFilterEnabled: true,
        commercialAdsPolicy: true,
        commercialAdsSensitivity: true,
        commercialAdsWarnThreshold: true,
        commercialAdsDeleteThreshold: true,
        nightModeTimezone: true,
        chat: { select: { entityType: true, admins: { select: { userId: true } } } },
        textFiltersWarnEnabled: true,
        textFiltersMuteEnabled: true,
        textFiltersBanEnabled: true,
        textFiltersMuteDurationHours: true,
        textFiltersBotMessageEnabled: true,
      },
    });
    if (!settings?.commercialAdsFilterEnabled || settings.chat.entityType !== 'CHAT')
      throw new CommercialDeleteGuardRejectedError('commercial_text_settings_disabled');
    if (settings.chat.admins.some((admin) => admin.userId === userId))
      throw new CommercialDeleteGuardRejectedError('commercial_text_author_immune');
    return settings;
  }
}
