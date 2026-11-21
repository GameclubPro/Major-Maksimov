import { performance } from 'node:perf_hooks';
import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { isPrivateDirectChatId } from '../../common/chat-id.util';
import { MaxBotContextService } from '../../max/max-bot-context.service';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MaxClientService } from '../../max/max-client.service';
import {
  ChatEntityType,
  Prisma,
  WebhookStatus,
  type ChatSettings,
} from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { buildWebhookSemanticEventKey } from '../../webhook/webhook-semantic-event-key';
import { WebhookLegacyHoldService } from '../../webhook/webhook-legacy-hold.service';
import { isPendingWebhookTimeoutQuarantineMessage } from '../../webhook/webhook-timeout-quarantine';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { createAllowlistLinkMatcher } from '../rule-engine-link-detector';
import { CommercialReviewService } from '../commercial/commercial-review.service';
import {
  extractLogicalPhotoAlbumResult,
  type LogicalPhotoAlbum,
} from '../photo-duplicate/photo-attachment-extractor';
import { resolveCommercialOcrReservationTtlMs } from './commercial-ocr-admission.config';
import { CommercialOcrAdmissionStore } from './commercial-ocr-admission.store';
import {
  CommercialOcrAnalysisService,
  type CommercialOcrAnalysisRetryReason,
} from './commercial-ocr-analysis.service';
import {
  COMMERCIAL_OCR_DECISION_POLICY_VERSION,
  isCommercialOcrCyrillicOnlyDeleteDecision,
  type CommercialOcrDecision,
} from './commercial-ocr-decision-policy';
import { COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256 } from './commercial-ocr-detector-source.generated';
import {
  buildCommercialOcrDeleteBinding,
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE,
  COMMERCIAL_OCR_PARTICIPANT_IMMUNITY_SCOPE,
  extractCommercialOcrExactMessageSource,
  type CommercialOcrDeleteBinding,
  type CommercialOcrDeleteSource,
  type CommercialOcrExactMessageSource,
} from './commercial-ocr-delete-guard.service';
import {
  isSupportedCommercialOcrJobSchemaVersion,
  COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
  resolveCommercialOcrJobEventTimestamp,
  resolveCommercialOcrJobPurposes,
  type CommercialOcrJob,
} from './commercial-ocr.queue';
import { CommercialOcrMetricsService } from './commercial-ocr-metrics.service';
import {
  CommercialOcrRuntimePolicyService,
  sameCommercialOcrEnforcementAuthority,
  type CommercialOcrEnforcementAuthority,
} from './commercial-ocr-runtime-policy.service';
import { resolveCommercialOcrRuntimePolicy } from './commercial-ocr.runtime';
import { fingerprintCommercialOcrSettingsProfile } from './commercial-ocr-settings-profile';
import { extractCommercialOcrSourceCreatedAt } from './commercial-ocr-source-time';
import type { ImageTextStopListDecision } from './image-text-stop-list-decision';
import {
  buildImageTextStopListBinding,
  fingerprintImageTextStopListPolicy,
  IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX,
  IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE,
  IMAGE_TEXT_STOP_LIST_PARTICIPANT_IMMUNITY_SCOPE,
  type ImageTextStopListBinding,
} from './image-text-stop-list-binding';
import { resolveImageTextStopListOcrRuntimePolicy } from './image-text-stop-list.runtime';
import {
  isStopWordsDecisionConfigured,
  isStopWordsImageScanEnabled,
} from '../stop-words/stop-words.policy';
import {
  commercialOcrCompleted,
  type CommercialOcrTerminalResult,
} from './commercial-ocr-terminal';
import { classifyCommercialOcrSourceFailure } from './commercial-ocr-source-retry';
import { buildCommercialQualitySample } from '../commercial/commercial-quality-sampling';
import { NativeTesseractOcrAdapter } from './native-tesseract-ocr.adapter';

const GOVERNOR_COMPONENT = 'commercial-image-ocr';
const GOVERNOR_SOURCE_TAG = 'commercial_image_ocr';
const ADMIN_LOOKUP_TIMEOUT_MS = 3_000;

export type CommercialOcrJobProcessResult =
  | { kind: 'completed'; terminal?: CommercialOcrTerminalResult }
  | {
      kind: 'retry';
      reason: CommercialOcrAnalysisRetryReason | 'source_unavailable';
      retryAfterMs?: number;
    }
  | {
      kind: 'defer';
      delayMs: number;
      reason:
        | 'source_not_ready'
        | 'governor_pressure'
        | 'admission_pending'
        | 'native_backpressure';
    };

type CommercialOcrJobContext = {
  entityType: ChatEntityType;
  settings: ChatSettings;
  localAdminUserIds: string[];
  domainAllowlist: string[];
};

type SourceEnvelope = {
  update: MaxUpdate;
  album: LogicalPhotoAlbum;
  originBotId: string;
  exactSource: CommercialOcrDeleteSource;
  persistedDownloadUrlFallbackIndexes: readonly number[];
};

type CommercialOcrWebhookSource = {
  botId: string | null;
  status: WebhookStatus;
  processedAt: Date | null;
  nextEnqueueAt: Date | null;
  timeoutQuarantineExpiresAt: Date | null;
  errorMessage: string | null;
  normalizedPayload: Prisma.JsonValue;
  executionClaims: Array<{ executionBotId: string | null }>;
};

@Injectable()
export class CommercialOcrModerationService {
  private nextSlowOcrAtMs = 0;
  private readonly logger = new Logger(CommercialOcrModerationService.name);
  private readonly admissionTombstoneTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: CommercialOcrAnalysisService,
    private readonly admissionStore: CommercialOcrAdmissionStore,
    private readonly governor: BackgroundRuntimeGovernorService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotContextService: MaxBotContextService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly participantImmunity: ParticipantModerationImmunityService,
    private readonly moderationDeleteIntents: ModerationDeleteIntentService,
    private readonly runtimePolicy: CommercialOcrRuntimePolicyService,
    private readonly configService: ConfigService,
    private readonly metrics: CommercialOcrMetricsService,
    @Optional() private readonly nativeOcr?: NativeTesseractOcrAdapter,
    @Optional() private readonly commercialReview?: CommercialReviewService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {
    this.admissionTombstoneTtlMs = resolveCommercialOcrReservationTtlMs(configService);
  }

  async processCommercialOcrJob(
    job: CommercialOcrJob,
    jobId: string,
    deadlineAtMs: number,
  ): Promise<CommercialOcrJobProcessResult> {
    try {
      return await this.processJob(job, jobId, deadlineAtMs);
    } catch (error: unknown) {
      if (!(error instanceof CommercialOcrSourceUnavailableError)) throw error;
      return { kind: 'retry', reason: 'source_unavailable', ...error.retry };
    }
  }

  private async processJob(
    job: CommercialOcrJob,
    jobId: string,
    deadlineAtMs: number,
  ): Promise<CommercialOcrJobProcessResult> {
    if (deadlineExpired(deadlineAtMs)) {
      return commercialOcrCompleted('EXPIRED', 'expired');
    }
    if (!isSupportedCommercialOcrJobSchemaVersion(job.schemaVersion)) {
      return commercialOcrCompleted('TECHNICAL_INCOMPLETE', 'invalid_job');
    }

    const initialAdmission = await this.admissionStore.resolveState(jobId);
    if (initialAdmission.kind !== 'available') {
      return commercialOcrCompleted(
        'TECHNICAL_INCOMPLETE',
        initialAdmission.kind === 'missing' ? 'admission_missing' : 'admission_unavailable',
      );
    }
    const runtime = resolveCommercialOcrRuntimePolicy({
      chatId: job.chatId,
      configService: this.configService,
    });
    const imageTextRuntime = resolveImageTextStopListOcrRuntimePolicy({
      configService: this.configService,
      sandboxBoundaryVerified: false,
    });
    const purposes = resolveCommercialOcrJobPurposes(job);
    if (
      !(purposes.commercial && runtime.process) &&
      !(purposes.imageTextStopList && imageTextRuntime.process)
    ) {
      return { kind: 'completed' };
    }

    const source = await this.loadSource(job, deadlineAtMs);
    if (source.kind !== 'ready') {
      if (initialAdmission.state === 'pending' && source.kind === 'terminal') {
        await this.suppressPendingAdmission(job, jobId);
      }
      return source.kind === 'defer'
        ? { kind: 'defer', delayMs: source.delayMs, reason: 'source_not_ready' }
        : commercialOcrCompleted(
            source.outcome ?? 'LEGITIMATE_SKIP',
            source.reason ?? 'source_receipt_terminal',
          );
    }

    let admissionActionEligible = initialAdmission.state === 'actionable';
    if (initialAdmission.state === 'pending') {
      admissionActionEligible = await this.reconcilePendingAdmission(job, jobId, deadlineAtMs);
      if (!admissionActionEligible) {
        return { kind: 'completed' };
      }
    }

    const execute = () =>
      this.processReadySource(job, jobId, source.value, admissionActionEligible, deadlineAtMs);
    return this.maxBotContextService.runWithBot(source.value.originBotId, execute);
  }

  private async reconcilePendingAdmission(
    job: CommercialOcrJob,
    jobId: string,
    deadlineAtMs: number,
  ): Promise<boolean> {
    if (deadlineExpired(deadlineAtMs)) {
      const suppression = await this.suppressPendingAdmission(job, jobId);
      this.metrics.recordCounter(
        suppression === 'suppressed'
          ? 'admission.reconciliation.suppressed'
          : 'admission.reconciliation.unavailable',
      );
      return false;
    }

    this.metrics.recordCounter('admission.reconciliation.attempted');
    const activation = await this.admissionStore
      .activate({ jobId, tombstoneTtlMs: this.admissionTombstoneTtlMs })
      .catch(() => 'unavailable' as const);

    if (activation === 'unavailable') {
      this.metrics.recordCounter('admission.reconciliation.unavailable');
      // The activation EVAL may commit after its local timeout. Suppression on the same store
      // connection is ordered after it and makes either outcome non-actionable.
      await this.suppressPendingAdmission(job, jobId);
      return false;
    }
    if (activation === 'suppressed' || activation === 'expired' || activation === 'missing') {
      this.metrics.recordCounter('admission.reconciliation.suppressed');
      return false;
    }

    // A webhook producer may win the race after the initial pending read. Both successful outcomes
    // confirm actionability without performing any transition other than pending -> actionable.
    this.metrics.recordCounter('admission.reconciliation.activated');
    if (!deadlineExpired(deadlineAtMs)) {
      return true;
    }

    const suppression = await this.suppressPendingAdmission(job, jobId);
    this.metrics.recordCounter(
      suppression === 'suppressed'
        ? 'admission.reconciliation.suppressed'
        : 'admission.reconciliation.unavailable',
    );
    return false;
  }

  private async suppressPendingAdmission(
    job: CommercialOcrJob,
    jobId: string,
  ): Promise<'suppressed' | 'unavailable'> {
    const suppression = await this.admissionStore
      .suppress({
        jobId,
        chatId: job.chatId,
        imageCount: job.imageCount,
        tombstoneTtlMs: this.admissionTombstoneTtlMs,
      })
      .catch(() => 'unavailable' as const);
    this.metrics.recordCounter(
      suppression === 'suppressed'
        ? 'admission.suppression.suppressed'
        : 'admission.suppression.unavailable',
    );
    return suppression;
  }

  private async processReadySource(
    job: CommercialOcrJob,
    jobId: string,
    source: SourceEnvelope,
    admissionActionEligible: boolean,
    deadlineAtMs: number,
  ): Promise<CommercialOcrJobProcessResult> {
    if (deadlineExpired(deadlineAtMs)) {
      return commercialOcrCompleted('EXPIRED', 'expired');
    }
    if (
      isPrivateDirectChatId(source.album.chatId) ||
      this.maxBotLinkService.isKnownBotUserId(source.album.senderId) ||
      isBotOrServiceAuthored(source.update)
    ) {
      return commercialOcrCompleted('LEGITIMATE_SKIP', 'policy_ineligible');
    }

    const context = await this.loadJobContext(job.chatId);
    const purposes = resolveCommercialOcrJobPurposes(job);
    // FLAG: A retained combined job cannot revive a disabled commercial scan through the
    // independently enabled image stop-list path. Recheck each purpose before analysis.
    const commercialScanEnabled =
      purposes.commercial &&
      context?.settings.commercialAdsFilterEnabled === true &&
      resolveCommercialOcrRuntimePolicy({ chatId: job.chatId, configService: this.configService })
        .process;
    const imageTextStopListEnabled =
      purposes.imageTextStopList &&
      isImageTextStopListEnabled(context?.settings) &&
      resolveImageTextStopListOcrRuntimePolicy({
        configService: this.configService,
        sandboxBoundaryVerified: false,
      }).process;
    if (
      !context ||
      context.entityType !== ChatEntityType.CHAT ||
      (!commercialScanEnabled && !imageTextStopListEnabled) ||
      context.localAdminUserIds.includes(source.album.senderId)
    ) {
      return commercialOcrCompleted('LEGITIMATE_SKIP', 'policy_ineligible');
    }
    const initialSettingsFingerprint = commercialScanEnabled
      ? fingerprintSettingsFailOpen(context.settings)
      : null;
    if (commercialScanEnabled && !initialSettingsFingerprint) {
      return commercialOcrCompleted('LEGITIMATE_SKIP', 'policy_ineligible');
    }
    if (
      !(await this.isFreshNonAdmin(
        job.chatId,
        source.album.senderId,
        source.originBotId,
        deadlineAtMs,
      ))
    ) {
      return commercialOcrCompleted('LEGITIMATE_SKIP', 'policy_ineligible');
    }

    const analysis = await this.analysisService.analyzeAlbum({
      album: source.album,
      caption: source.album.caption,
      settings: context.settings,
      ocrVersion: job.ocrVersion,
      deadlineAtMs,
      authorizeStage: (stage) => this.authorizeHeavyStage(stage),
      commercialScanEnabled,
      imageTextStopListScanEnabled: imageTextStopListEnabled,
      ...(context.domainAllowlist.length > 0
        ? { isLinkAllowlisted: createAllowlistLinkMatcher(context.domainAllowlist) }
        : {}),
    });
    if (analysis.kind === 'defer') {
      this.metrics.recordCounter(`analysis.defer.${analysis.reason}`);
      return {
        kind: 'defer',
        delayMs: analysis.delayMs,
        reason: analysis.reason,
      };
    }
    if (analysis.kind === 'retry') {
      this.metrics.recordCounter(`analysis.retry.${analysis.reason}`);
      return { kind: 'retry', reason: analysis.reason };
    }
    if (
      analysis.kind === 'incomplete' &&
      analysis.reason === 'download_failed' &&
      analysis.imageIndex !== undefined &&
      source.persistedDownloadUrlFallbackIndexes.includes(analysis.imageIndex)
    ) {
      this.metrics.recordCounter('analysis.retry.download_failed');
      return { kind: 'retry', reason: 'download_failed' };
    }
    if (analysis.kind !== 'complete') {
      this.metrics.recordCounter('analysis.terminal.incomplete');
      this.metrics.recordCounter(`analysis.incomplete.${analysis.reason}`);
      this.metrics.recordCounter(`analysis.incomplete.pass.${analysis.pass ?? 'none'}`);
      this.logger.log(
        {
          imageCount: job.imageCount,
          rolloutMode: resolveCommercialOcrRuntimePolicy({
            chatId: job.chatId,
            configService: this.configService,
          }).mode,
          outcome: 'INCOMPLETE',
          reason: analysis.reason,
          ...(analysis.imageIndex === undefined ? {} : { imageIndex: analysis.imageIndex }),
          ...(analysis.pass === undefined ? {} : { pass: analysis.pass }),
        },
        'Commercial OCR analysis incomplete',
      );
      await this.recordReviewObservation(
        job,
        jobId,
        source,
        null,
        context.settings,
        analysis.reason,
      );
      return commercialOcrCompleted(
        analysis.reason === 'job_deadline_exceeded' ? 'EXPIRED' : 'TECHNICAL_INCOMPLETE',
        analysis.reason,
      );
    }

    const completed = commercialOcrCompleted(
      analysis.decision.action === 'DELETE' ||
        (imageTextStopListEnabled && analysis.imageTextStopListDecision?.kind === 'match')
        ? 'COMPLETE_DELETE_CANDIDATE'
        : 'COMPLETE_KEEP',
      'complete',
    );
    this.metrics.recordCounter('analysis.terminal.complete');
    await this.recordReviewObservation(job, jobId, source, analysis.decision, context.settings);

    const imageTextStopListDecision =
      analysis.imageTextStopListDecision ?? ({ kind: 'no_action' } as const);
    if (imageTextStopListEnabled) {
      this.metrics.recordCounter(
        imageTextStopListDecision.kind === 'match'
          ? 'image_text_stop_list.complete.match'
          : 'image_text_stop_list.complete.no_action',
      );
    }
    if (imageTextStopListEnabled && imageTextStopListDecision.kind === 'match') {
      // A confirmed explicit stop-list match owns the single message action. If its stricter
      // authorization is suppressed, the independently completed commercial decision may proceed.
      const actionOwned = await this.processImageTextStopListMatch({
        job,
        jobId,
        source,
        initialContext: context,
        decision: imageTextStopListDecision,
        admissionActionEligible,
        deadlineAtMs,
      });
      if (actionOwned) {
        return completed;
      }
    }

    this.metrics.recordCounter(
      analysis.decision.action === 'DELETE'
        ? 'analysis.complete.delete'
        : 'analysis.complete.no_action',
    );

    this.logger.log(
      {
        imageCount: job.imageCount,
        rolloutMode: resolveCommercialOcrRuntimePolicy({
          chatId: job.chatId,
          configService: this.configService,
        }).mode,
        action: analysis.decision.action,
        reasonCodes: analysis.decision.reasonCodes,
      },
      'Commercial OCR decision completed',
    );
    if (
      !context.settings.commercialAdsFilterEnabled ||
      !initialSettingsFingerprint ||
      analysis.decision.action !== 'DELETE'
    ) {
      return completed;
    }
    if (source.persistedDownloadUrlFallbackIndexes.length > 0) {
      this.metrics.recordCounter('enforcement.suppressed.source_url_fallback');
      return completed;
    }
    if (!admissionActionEligible) {
      this.metrics.recordCounter('enforcement.suppressed.admission');
      return completed;
    }
    if (!isCommercialOcrCyrillicOnlyDeleteDecision(analysis.decision)) {
      this.metrics.recordCounter('enforcement.suppressed.script_guard');
      return completed;
    }
    if (deadlineExpired(deadlineAtMs)) {
      this.metrics.recordCounter('enforcement.suppressed.deadline');
      return completed;
    }

    // FLAG: Re-read explicit baseline/certified authority before MAX lookups and commit. Baseline
    // also needs a verified live sandbox whose native identity matches this exact release.
    const actionRuntime = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: job.chatId,
      settingsFingerprint: initialSettingsFingerprint,
    });
    if (
      !actionRuntime.enforce ||
      !actionRuntime.authority ||
      !this.isLiveBaselineAuthorityVerified(actionRuntime.authority) ||
      deadlineExpired(deadlineAtMs)
    ) {
      this.metrics.recordCounter(
        deadlineExpired(deadlineAtMs)
          ? 'enforcement.suppressed.deadline'
          : 'enforcement.suppressed.runtime_control',
      );
      return completed;
    }

    const authorization = await this.resolveFinalAuthorization({
      job,
      jobId,
      initialContext: context,
      initialSource: source,
      deadlineAtMs,
    });
    if (!authorization) {
      this.metrics.recordCounter('enforcement.suppressed.authorization');
      return completed;
    }

    const preImmunityRuntime = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: job.chatId,
      settingsFingerprint: fingerprintCommercialOcrSettingsProfile(authorization.context.settings),
    });
    if (
      !preImmunityRuntime.enforce ||
      !sameCommercialOcrEnforcementAuthority(
        preImmunityRuntime.authority,
        actionRuntime.authority,
      ) ||
      !this.isLiveBaselineAuthorityVerified(preImmunityRuntime.authority) ||
      deadlineExpired(deadlineAtMs)
    ) {
      this.metrics.recordCounter(
        deadlineExpired(deadlineAtMs)
          ? 'enforcement.suppressed.deadline'
          : 'enforcement.suppressed.runtime_control',
      );
      return completed;
    }

    if (deadlineExpired(deadlineAtMs)) {
      this.metrics.recordCounter('enforcement.suppressed.deadline');
      return completed;
    }
    if (
      await this.consumeParticipantImmunityFailOpen({
        chatId: job.chatId,
        userId: authorization.exactSource.senderId,
        messageId: job.messageId,
        nightModeTimezone: authorization.context.settings.nightModeTimezone,
      })
    ) {
      this.metrics.recordCounter('enforcement.suppressed.immunity');
      return completed;
    }

    if (deadlineExpired(deadlineAtMs)) {
      this.metrics.recordCounter('enforcement.suppressed.deadline');
      return completed;
    }
    const commitContext = await this.loadJobContext(job.chatId);
    if (
      !commitContext ||
      commitContext.entityType !== ChatEntityType.CHAT ||
      !commitContext.settings.commercialAdsFilterEnabled ||
      !sameCommercialPolicy(commitContext.settings, authorization.context.settings) ||
      commitContext.localAdminUserIds.includes(authorization.exactSource.senderId)
    ) {
      this.metrics.recordCounter('enforcement.suppressed.authorization');
      return completed;
    }
    const commitSettingsFingerprint = fingerprintSettingsFailOpen(commitContext.settings);
    if (!commitSettingsFingerprint) {
      this.metrics.recordCounter('enforcement.suppressed.authorization');
      return completed;
    }
    const commitRuntime = await this.runtimePolicy.resolveEffectivePolicy({
      chatId: job.chatId,
      settingsFingerprint: commitSettingsFingerprint,
    });
    const authority = commitRuntime.authority;
    const controlExpiresAtMs =
      authority?.kind === 'CERTIFIED' ? Date.parse(authority.controlExpiresAt) : null;
    const jobDeadlineExceeded = deadlineExpired(deadlineAtMs);
    const runtimeControlExpired =
      controlExpiresAtMs !== null &&
      Number.isFinite(controlExpiresAtMs) &&
      controlExpiresAtMs <= Date.now();
    if (
      !commitRuntime.enforce ||
      !authority ||
      !sameCommercialOcrEnforcementAuthority(authority, actionRuntime.authority) ||
      !this.isLiveBaselineAuthorityVerified(authority) ||
      (controlExpiresAtMs !== null && !Number.isFinite(controlExpiresAtMs)) ||
      runtimeControlExpired ||
      jobDeadlineExceeded
    ) {
      this.metrics.recordCounter(
        jobDeadlineExceeded
          ? 'enforcement.suppressed.deadline'
          : runtimeControlExpired
            ? 'enforcement.suppressed.runtime_control_expired'
            : 'enforcement.suppressed.runtime_control',
      );
      return completed;
    }
    const deleteDeadlineAtMs =
      controlExpiresAtMs === null ? deadlineAtMs : Math.min(deadlineAtMs, controlExpiresAtMs);
    const binding = buildCommercialOcrDeleteBinding({
      ocrVersion: job.ocrVersion,
      senderId: authorization.exactSource.senderId,
      orderedPhotoIds: authorization.exactSource.orderedPhotoIds,
      caption: authorization.exactSource.caption,
      sourceCreatedAt: authorization.exactSource.sourceCreatedAt,
      expectedImageCount: job.imageCount,
      settings: commitContext.settings,
      authority,
      ocrDeadlineAt: new Date(deleteDeadlineAtMs),
    });
    await this.persistDeleteAction({
      job,
      jobId,
      binding,
      senderId: authorization.exactSource.senderId,
      sourceCreatedAt: authorization.exactSource.sourceCreatedAt,
      originBotId: authorization.originBotId,
      deadlineAtMs: deleteDeadlineAtMs,
    });
    this.metrics.recordCounter('enforcement.intent.requested');
    return completed;
  }

  private isLiveBaselineAuthorityVerified(
    authority: CommercialOcrEnforcementAuthority | null,
  ): boolean {
    if (!authority) return false;
    if (authority.kind === 'CERTIFIED') return true;
    const native = this.nativeOcr?.getRuntimeStatus().behaviorIdentity;
    return (
      this.nativeOcr?.isSandboxBoundaryVerified?.() === true &&
      native?.verified === true &&
      native.complete === true &&
      native.fingerprintSha256 === authority.nativeBehaviorIdentitySha256 &&
      native.runtimeFingerprintSha256 === authority.nativeBehaviorIdentitySha256
    );
  }

  async recordTechnicalIncomplete(
    job: CommercialOcrJob,
    jobId: string,
    reason: CommercialOcrTerminalResult['reason'],
  ): Promise<void> {
    if (
      !this.commercialReview ||
      !resolveCommercialOcrJobPurposes(job).commercial ||
      !resolveCommercialOcrRuntimePolicy({ chatId: job.chatId, configService: this.configService })
        .process
    )
      return;
    try {
      // FLAG: Terminal technical samples use only the original webhook caption/photo identity.
      // This local observation performs no MAX reads, grants no authority and stores no OCR text.
      const receipt = await this.prisma.webhookEvent.findUnique({
        where: { id: job.webhookEventId },
        select: { normalizedPayload: true, botId: true },
      });
      if (!receipt) return;
      const update = receipt.normalizedPayload as unknown as MaxUpdate;
      // FLAG: Even technical review sampling must not recreate evidence from an
      // abandoned source through a previously PROCESSED mirror.
      if (await this.legacyHolds?.isUpdateHeld(update)) return;
      const extracted = extractLogicalPhotoAlbumResult(update);
      if (extracted.kind !== 'complete') return;
      const album = extracted.album;
      if (
        album.chatId !== job.chatId ||
        album.messageId !== job.messageId ||
        album.images.length !== job.imageCount ||
        isPrivateDirectChatId(job.chatId) ||
        this.maxBotLinkService.isKnownBotUserId(album.senderId) ||
        isBotOrServiceAuthored(update)
      )
        return;
      const context = await this.loadJobContext(job.chatId);
      if (
        !context ||
        context.entityType !== ChatEntityType.CHAT ||
        !context.settings.commercialAdsFilterEnabled ||
        context.localAdminUserIds.includes(album.senderId)
      )
        return;
      const exact = extractCommercialOcrExactMessageSource(update.raw);
      if (!exact || !sameAlbumSource(album, exact.source, job)) return;
      await this.recordReviewObservation(
        job,
        jobId,
        {
          update,
          album,
          exactSource: exact.source,
          originBotId: receipt.botId ?? this.maxBotLinkService.getDefaultBotId(),
          persistedDownloadUrlFallbackIndexes: [],
        },
        null,
        context.settings,
        reason,
      );
    } catch {
      this.logger.warn('Commercial OCR technical review observation unavailable');
    }
  }

  private async recordReviewObservation(
    job: CommercialOcrJob,
    jobId: string,
    source: SourceEnvelope,
    decision: CommercialOcrDecision | null,
    settings: ChatSettings,
    incompleteReason?: string,
  ): Promise<void> {
    if (
      !this.commercialReview ||
      !resolveCommercialOcrJobPurposes(job).commercial ||
      !settings.commercialAdsFilterEnabled ||
      !resolveCommercialOcrRuntimePolicy({ chatId: job.chatId, configService: this.configService })
        .process
    )
      return;
    const detections = (decision?.images ?? []).flatMap((image) => [
      image.primary.detection,
      image.verification?.detection ?? null,
    ]);
    const candidate = detections
      .filter((detection) => detection !== null)
      .sort((left, right) => right.confidenceScore - left.confidenceScore)[0];
    const sample = buildCommercialQualitySample({
      secret: this.configService.get<string>('MAX_WEBHOOK_SECRET_PATH'),
      chatId: job.chatId,
      userId: source.album.senderId,
      messageId: job.messageId,
      text: source.album.caption,
      messageCreatedAt: job.sourceCreatedAt,
      source: 'OCR',
      hasDetection: Boolean(candidate),
      reviewRecommended: candidate?.reviewRecommended,
      technicalIncomplete: Boolean(incompleteReason),
      sourceIdentity: JSON.stringify(source.exactSource),
    });
    if (!sample) return;
    try {
      // FLAG: OCR-recognized text and contact/critical signatures never enter the review store.
      // A pending observation is KEEP; only fresh confirmed deletion may produce a DELETE sample.
      await this.commercialReview.recordCandidate({
        chatId: job.chatId,
        userId: source.album.senderId,
        messageId: job.messageId,
        text: source.album.caption,
        score: candidate?.confidenceScore ?? 0,
        actionBand: candidate?.actionBand ?? 'NONE',
        source: 'OCR',
        decisionFingerprint: createHash('sha256')
          .update(
            JSON.stringify([
              jobId,
              COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
              decision?.policyVersion ?? 'incomplete',
              decision?.action ?? 'INCOMPLETE',
            ]),
          )
          .digest('hex'),
        detectorVersion: `${job.ocrVersion}:${COMMERCIAL_OCR_DECISION_POLICY_VERSION}`,
        messageDisposition: 'KEEP',
        requiredPolicyCohorts: candidate?.requiredPolicyCohorts ?? [],
        reviewPriority: candidate?.reviewRecommended ? 70 : incompleteReason ? 60 : 50,
        reasons: decision?.reasonCodes ?? [incompleteReason ?? 'no_detection'],
        ...sample,
        settingsProfileDigest: fingerprintCommercialOcrSettingsProfile(settings),
        detectorSourceSha256: COMMERCIAL_OCR_RUNTIME_SOURCE_SHA256,
        hasDetection: Boolean(candidate),
        analysisOutcome: incompleteReason ? 'TECHNICAL_INCOMPLETE' : 'COMPLETE',
        decisionOutcome: decision?.action === 'DELETE' ? 'DELETE' : decision ? 'KEEP' : null,
        deleteEligible: decision ? decision.action === 'DELETE' : null,
        executionOutcome: 'NOT_REQUESTED',
        imageReviewRequired: true,
        sourceExcerptComplete: source.album.caption.length <= 2500,
      });
    } catch {
      this.logger.warn('Commercial OCR review observation unavailable; moderation continues');
    }
  }

  private async loadSource(
    job: CommercialOcrJob,
    deadlineAtMs: number,
  ): Promise<
    | { kind: 'ready'; value: SourceEnvelope }
    | { kind: 'defer'; delayMs: number }
    | {
        kind: 'terminal';
        outcome?: CommercialOcrTerminalResult['outcome'];
        reason?: CommercialOcrTerminalResult['reason'];
      }
  > {
    let receiptUnavailable = false;
    const initialWebhookEvent = await this.prisma.webhookEvent
      .findUnique({
        where: { id: job.webhookEventId },
        select: {
          botId: true,
          status: true,
          processedAt: true,
          nextEnqueueAt: true,
          timeoutQuarantineExpiresAt: true,
          errorMessage: true,
          normalizedPayload: true,
          executionClaims: {
            where: { kind: 'EXECUTION' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { executionBotId: true },
          },
        },
      })
      .catch(() => {
        receiptUnavailable = true;
        this.logger.warn(
          'Commercial OCR webhook source lookup failed; enforcement remains fail-open',
        );
        return null;
      });
    if (!initialWebhookEvent) {
      this.metrics.recordCounter(
        receiptUnavailable ? 'source.receipt.unavailable' : 'source.receipt.missing',
      );
      return {
        kind: 'terminal',
        outcome: receiptUnavailable ? 'TECHNICAL_INCOMPLETE' : 'LEGITIMATE_SKIP',
        reason: receiptUnavailable ? 'source_receipt_unavailable' : 'source_receipt_missing',
      };
    }
    let webhookEvent: CommercialOcrWebhookSource = initialWebhookEvent;
    // FLAG: A retained PROCESSED receipt or completed semantic owner is historical
    // evidence only; exact source holds apply before rebind, MAX reads and OCR work.
    if (
      await this.legacyHolds?.isUpdateHeld(webhookEvent.normalizedPayload as unknown as MaxUpdate)
    ) {
      this.metrics.recordCounter('source.receipt.no_replay_held');
      return { kind: 'terminal' };
    }
    // FLAG: A permanent no-replay disposition is terminal and cannot be rebound
    // through a semantic owner to manufacture new OCR action authority.
    if (['NO_REPLAY_HELD', 'CANCELLED'].includes(String(webhookEvent.status))) {
      this.metrics.recordCounter('source.receipt.no_replay_held');
      return { kind: 'terminal' };
    }
    if (webhookEvent.status === WebhookStatus.DUPLICATE) {
      const owner = await this.loadCompletedSemanticOwner(job, webhookEvent.normalizedPayload);
      if (owner.kind !== 'ready') {
        if (owner.kind === 'terminal') {
          this.metrics.recordCounter('source.receipt.owner_terminal');
        }
        return owner.kind === 'defer' ? { kind: 'defer', delayMs: 5_000 } : { kind: 'terminal' };
      }
      webhookEvent = owner.value;
    }
    if (
      webhookEvent.status === WebhookStatus.FAILED &&
      webhookEvent.nextEnqueueAt === null &&
      !isPendingWebhookTimeoutQuarantineMessage(webhookEvent.errorMessage)
    ) {
      this.metrics.recordCounter('source.receipt.failed');
      return { kind: 'terminal' };
    }
    if (webhookEvent.status !== WebhookStatus.PROCESSED) {
      return { kind: 'defer', delayMs: 5_000 };
    }

    const updateRecord = asRecord(webhookEvent.normalizedPayload);
    if (!updateRecord) {
      this.metrics.recordCounter('source.receipt.invalid');
      return { kind: 'terminal' };
    }
    const update = updateRecord as unknown as MaxUpdate;
    const extraction = extractLogicalPhotoAlbumResult(update);
    if (extraction.kind !== 'complete') {
      this.metrics.recordCounter('source.receipt.invalid');
      return { kind: 'terminal' };
    }
    const album = extraction.album;
    if (
      album.chatId !== job.chatId ||
      album.messageId !== job.messageId ||
      album.createdAtMs !== Date.parse(resolveCommercialOcrJobEventTimestamp(job)) ||
      album.images.length !== job.imageCount
    ) {
      this.metrics.recordCounter('source.identity_mismatch');
      this.logger.warn(
        'Skipped commercial OCR job whose source identity does not match the webhook',
      );
      return { kind: 'terminal' };
    }

    if (
      job.schemaVersion === COMMERCIAL_OCR_JOB_SCHEMA_VERSION &&
      extractCommercialOcrSourceCreatedAt(update.raw) !==
        new Date(job.sourceCreatedAt).toISOString()
    ) {
      this.metrics.recordCounter('source.creation_time_mismatch');
      return { kind: 'terminal' };
    }

    const originBotId =
      readString(webhookEvent.executionClaims[0]?.executionBotId) ??
      readString(webhookEvent.botId) ??
      readString(updateRecord.executionOwnerBotId) ??
      readString(update.botId) ??
      this.maxBotLinkService.getDefaultBotId();
    const exact = await this.loadExactSource(job, originBotId, deadlineAtMs, 'initial');
    if (exact.kind === 'terminal') {
      return { kind: 'terminal', ...exact.terminal };
    }
    const exactValue = exact.value;
    if (exactValue.authorKind !== 'user') {
      this.metrics.recordCounter('source.exact.author_ineligible');
      return { kind: 'terminal', reason: 'source_author_ineligible' };
    }
    if (!sameAlbumSource(album, exactValue.source, job)) {
      this.metrics.recordCounter('source.exact.changed');
      return { kind: 'terminal', reason: 'source_changed' };
    }
    const refreshed = refreshAlbumDownloadUrls(album, exactValue.images);
    if (!refreshed) {
      this.metrics.recordCounter('source.exact.changed');
      return { kind: 'terminal', reason: 'source_changed' };
    }
    this.metrics.recordCounter('source.ready');
    return {
      kind: 'ready',
      value: {
        update,
        album: refreshed.album,
        originBotId,
        exactSource: exactValue.source,
        persistedDownloadUrlFallbackIndexes: refreshed.persistedDownloadUrlFallbackIndexes,
      },
    };
  }

  private async processImageTextStopListMatch(params: {
    job: CommercialOcrJob;
    jobId: string;
    source: SourceEnvelope;
    initialContext: CommercialOcrJobContext;
    decision: Extract<ImageTextStopListDecision, { kind: 'match' }>;
    admissionActionEligible: boolean;
    deadlineAtMs: number;
  }): Promise<boolean> {
    const runtime = resolveImageTextStopListOcrRuntimePolicy({
      configService: this.configService,
      sandboxBoundaryVerified: this.nativeOcr?.isSandboxBoundaryVerified?.() === true,
    });
    if (
      !runtime.enforce ||
      !params.admissionActionEligible ||
      params.source.persistedDownloadUrlFallbackIndexes.includes(params.decision.imageIndex) ||
      deadlineExpired(params.deadlineAtMs)
    ) {
      this.metrics.recordCounter('image_text_stop_list.enforcement.suppressed');
      return false;
    }

    const initialPolicyFingerprint = fingerprintImageTextStopListPolicy({
      settings: params.initialContext.settings,
      domainAllowlist: params.initialContext.domainAllowlist,
    });
    const authorization = await this.resolveFinalImageTextStopListAuthorization({
      ...params,
      initialPolicyFingerprint,
    });
    if (!authorization) {
      this.metrics.recordCounter('image_text_stop_list.enforcement.suppressed');
      return false;
    }

    if (
      await this.consumeImageTextStopListParticipantImmunityFailOpen({
        chatId: params.job.chatId,
        userId: authorization.exactSource.senderId,
        messageId: params.job.messageId,
        nightModeTimezone: authorization.context.settings.nightModeTimezone,
      })
    ) {
      this.metrics.recordCounter('image_text_stop_list.enforcement.suppressed');
      return false;
    }

    const commitContext = await this.loadJobContext(params.job.chatId);
    const commitRuntime = resolveImageTextStopListOcrRuntimePolicy({
      configService: this.configService,
      sandboxBoundaryVerified: this.nativeOcr?.isSandboxBoundaryVerified?.() === true,
    });
    if (
      !commitRuntime.enforce ||
      !commitContext ||
      !isImageTextStopListEnabled(commitContext.settings) ||
      fingerprintImageTextStopListPolicy({
        settings: commitContext.settings,
        domainAllowlist: commitContext.domainAllowlist,
      }) !== initialPolicyFingerprint ||
      commitContext.localAdminUserIds.includes(authorization.exactSource.senderId) ||
      deadlineExpired(params.deadlineAtMs)
    ) {
      this.metrics.recordCounter('image_text_stop_list.enforcement.suppressed');
      return false;
    }
    const nativeBehavior = this.nativeOcr?.getRuntimeStatus().behaviorIdentity;
    if (!nativeBehavior?.verified || !/^[a-f0-9]{64}$/u.test(nativeBehavior.fingerprintSha256)) {
      this.metrics.recordCounter('image_text_stop_list.enforcement.suppressed');
      return false;
    }

    const binding = buildImageTextStopListBinding({
      ...(params.decision.policyVersion ? { policyVersion: params.decision.policyVersion } : {}),
      ocrVersion: params.job.ocrVersion,
      nativeBehaviorFingerprintSha256: nativeBehavior.fingerprintSha256,
      policyFingerprint: initialPolicyFingerprint,
      ruleCode: params.decision.ruleCode,
      value: params.decision.value,
      ...(params.decision.ruleId ? { ruleId: params.decision.ruleId } : {}),
      imageIndex: params.decision.imageIndex,
      primaryConfidencePermille: params.decision.primaryConfidencePermille,
      confirmationConfidencePermille: params.decision.confirmationConfidencePermille,
      senderId: authorization.exactSource.senderId,
      sourceCreatedAt: authorization.exactSource.sourceCreatedAt,
      deleteDeadlineAt: new Date(params.deadlineAtMs).toISOString(),
      orderedPhotoIds: authorization.exactSource.orderedPhotoIds,
      caption: authorization.exactSource.caption,
    });
    const persisted = await this.persistImageTextStopListDeleteAction({
      job: params.job,
      jobId: params.jobId,
      decision: params.decision,
      binding,
      senderId: authorization.exactSource.senderId,
      originBotId: authorization.originBotId,
      deadlineAtMs: params.deadlineAtMs,
    });
    if (!persisted) {
      this.metrics.recordCounter('image_text_stop_list.enforcement.suppressed');
      return false;
    }
    this.metrics.recordCounter('image_text_stop_list.enforcement.intent.requested');
    return true;
  }

  private async resolveFinalImageTextStopListAuthorization(params: {
    job: CommercialOcrJob;
    jobId: string;
    source: SourceEnvelope;
    initialContext: CommercialOcrJobContext;
    decision: Extract<ImageTextStopListDecision, { kind: 'match' }>;
    initialPolicyFingerprint: string;
    deadlineAtMs: number;
  }): Promise<{
    context: CommercialOcrJobContext;
    exactSource: CommercialOcrDeleteSource;
    originBotId: string;
  } | null> {
    if (deadlineExpired(params.deadlineAtMs)) {
      return null;
    }
    const admission = await this.admissionStore.resolveState(params.jobId);
    if (admission.kind !== 'available' || admission.state !== 'actionable') {
      return null;
    }

    const context = await this.loadJobContext(params.job.chatId);
    if (
      !context ||
      context.entityType !== ChatEntityType.CHAT ||
      !isImageTextStopListEnabled(context.settings) ||
      fingerprintImageTextStopListPolicy({
        settings: context.settings,
        domainAllowlist: context.domainAllowlist,
      }) !== params.initialPolicyFingerprint ||
      context.localAdminUserIds.includes(params.source.album.senderId) ||
      !decisionStillConfigured(params.decision, context.settings)
    ) {
      return null;
    }
    if (
      !(await this.isFreshNonAdmin(
        params.job.chatId,
        params.source.album.senderId,
        params.source.originBotId,
        params.deadlineAtMs,
      ))
    ) {
      return null;
    }

    const exactResult = await this.loadExactSource(
      params.job,
      params.source.originBotId,
      params.deadlineAtMs,
      'revalidation',
    );
    const exact = exactResult.kind === 'ready' ? exactResult.value : null;
    if (
      !exact ||
      exact.authorKind !== 'user' ||
      !sameAlbumSource(params.source.album, exact.source, params.job) ||
      !sameExactSource(exact.source, params.source.exactSource)
    ) {
      return null;
    }
    const finalAdmission = await this.admissionStore.resolveState(params.jobId);
    if (
      finalAdmission.kind !== 'available' ||
      finalAdmission.state !== 'actionable' ||
      deadlineExpired(params.deadlineAtMs)
    ) {
      return null;
    }
    return {
      context,
      exactSource: exact.source,
      originBotId: params.source.originBotId,
    };
  }

  private async consumeImageTextStopListParticipantImmunityFailOpen(params: {
    chatId: string;
    userId: string;
    messageId: string;
    nightModeTimezone: string | null;
  }): Promise<boolean> {
    try {
      return (
        (await this.participantImmunity.consumeForMessage({
          ...params,
          scope: IMAGE_TEXT_STOP_LIST_PARTICIPANT_IMMUNITY_SCOPE,
        })) === 'granted'
      );
    } catch {
      this.logger.warn(
        'Image text stop-list participant immunity check failed; enforcement remains fail-open',
      );
      return true;
    }
  }

  private async persistImageTextStopListDeleteAction(params: {
    job: CommercialOcrJob;
    jobId: string;
    decision: Extract<ImageTextStopListDecision, { kind: 'match' }>;
    binding: ImageTextStopListBinding;
    senderId: string;
    originBotId: string;
    deadlineAtMs: number;
  }): Promise<boolean> {
    const deleteRuleCode = COMMERCIAL_OCR_DELETE_RULE_CODE;
    const metadata = {
      source: 'image_text_ocr',
      enforcementScope: 'delete_only',
      matchedRuleCode: params.decision.ruleCode,
      policyVersion: params.binding.policyVersion,
      imageIndex: params.decision.imageIndex,
      ocrVersion: params.job.ocrVersion,
      primaryConfidencePermille: params.decision.primaryConfidencePermille,
      confirmationConfidencePermille: params.decision.confirmationConfidencePermille,
      imageTextStopListBinding: params.binding,
      ...(params.decision.ruleCode === 'MESSAGE_BLOCKED_WORD'
        ? { blockedWord: params.decision.value }
        : { blockedDomain: params.decision.value }),
    } as const;
    const actionDigest = createHash('sha256')
      .update(JSON.stringify([params.jobId, deleteRuleCode, params.binding]))
      .digest('hex');
    const result = await this.moderationDeleteIntents.ensureIntentWithMessageActionClaim({
      claim: {
        dedupeKey: `${IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX}${actionDigest}`,
        messageActionKey: buildMessageScopedModerationActionClaimKey(
          params.job.chatId,
          params.job.messageId,
        ),
        chatId: params.job.chatId,
        userId: params.senderId,
        messageId: params.job.messageId,
        ruleCode: IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE,
        updateType: 'message_action',
      },
      intent: {
        chatId: params.job.chatId,
        messageId: params.job.messageId,
        reasonKey: `image-text-stop-list-delete:${actionDigest}`,
        ruleCode: deleteRuleCode,
        subjectUserId: params.senderId,
        sourceMessageAt: params.job.sourceCreatedAt,
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: params.originBotId,
        routingPolicy: 'delete_capable',
        retryUntilAt: new Date(params.deadlineAtMs),
        commercialOcrDeadlineAt: new Date(params.deadlineAtMs),
        event: {
          userId: params.senderId,
          eventType: 'MESSAGE',
          score:
            Math.min(
              params.decision.primaryConfidencePermille,
              params.decision.confirmationConfidencePermille,
            ) / 1_000,
          metadata,
        },
      },
    });
    return result.claim !== 'blocked' && result.intent?.rollout === 'execute';
  }

  // FLAG: OCR job identity is message-scoped, so BullMQ may retain a mirror receipt in the job
  // envelope. Follow it only through the completed semantic claim and a clean processed owner.
  private async loadCompletedSemanticOwner(
    job: CommercialOcrJob,
    mirrorPayload: unknown,
  ): Promise<
    { kind: 'ready'; value: CommercialOcrWebhookSource } | { kind: 'defer' } | { kind: 'terminal' }
  > {
    const semanticKey = buildWebhookSemanticEventKey(mirrorPayload);
    if (!semanticKey) {
      return { kind: 'terminal' };
    }

    const semanticClaim = await this.prisma.webhookExecutionClaim
      .findUnique({
        where: {
          kind_semanticKey: {
            kind: 'EXECUTION',
            semanticKey,
          },
        },
        select: {
          id: true,
          semanticKey: true,
          webhookEventId: true,
          executionBotId: true,
          enforced: true,
          status: true,
          preparedAt: true,
          completedAt: true,
          leaseToken: true,
          leaseExpiresAt: true,
          webhookEvent: {
            select: {
              botId: true,
              status: true,
              processedAt: true,
              nextEnqueueAt: true,
              timeoutQuarantineExpiresAt: true,
              errorMessage: true,
              normalizedPayload: true,
            },
          },
        },
      })
      .catch(() => null);
    if (!semanticClaim) {
      return { kind: 'defer' };
    }
    if (
      !semanticClaim.id ||
      semanticClaim.semanticKey !== semanticKey ||
      !semanticClaim.webhookEventId ||
      semanticClaim.webhookEventId === job.webhookEventId
    ) {
      return { kind: 'terminal' };
    }
    if (['NO_REPLAY_HELD', 'CANCELLED'].includes(String(semanticClaim.webhookEvent?.status))) {
      return { kind: 'terminal' };
    }
    if (
      semanticClaim.status === 'PENDING' ||
      semanticClaim.status === 'READY' ||
      semanticClaim.enforced === false
    ) {
      return { kind: 'defer' };
    }
    if (
      semanticClaim.enforced !== true ||
      semanticClaim.status !== 'COMPLETED' ||
      !(semanticClaim.preparedAt instanceof Date) ||
      !Number.isFinite(semanticClaim.preparedAt.getTime()) ||
      !(semanticClaim.completedAt instanceof Date) ||
      !Number.isFinite(semanticClaim.completedAt.getTime()) ||
      semanticClaim.leaseToken !== null ||
      semanticClaim.leaseExpiresAt !== null
    ) {
      return { kind: 'terminal' };
    }

    const owner = semanticClaim.webhookEvent;
    // FLAG: A semantic tombstone proves prior completion, but cannot supply the retained
    // exact source/native binding required to authorize a new commercial OCR action.
    if (!owner) return { kind: 'terminal' };
    if (
      owner.status !== WebhookStatus.PROCESSED ||
      !(owner.processedAt instanceof Date) ||
      !Number.isFinite(owner.processedAt.getTime()) ||
      owner.errorMessage !== null ||
      owner.nextEnqueueAt !== null ||
      owner.timeoutQuarantineExpiresAt !== null ||
      buildWebhookSemanticEventKey(owner.normalizedPayload) !== semanticKey
    ) {
      return owner.status === WebhookStatus.DUPLICATE ? { kind: 'terminal' } : { kind: 'defer' };
    }

    return {
      kind: 'ready',
      value: {
        ...owner,
        executionClaims: [{ executionBotId: semanticClaim.executionBotId }],
      },
    };
  }

  private async loadExactSource(
    job: CommercialOcrJob,
    botId: string,
    deadlineAtMs: number,
    phase: 'initial' | 'revalidation',
  ): Promise<
    | { kind: 'ready'; value: CommercialOcrExactMessageSource }
    | { kind: 'terminal'; terminal: CommercialOcrTerminalResult }
  > {
    const timeoutMs = remainingStageTimeoutMs(deadlineAtMs, ADMIN_LOOKUP_TIMEOUT_MS);
    if (timeoutMs === null) {
      return { kind: 'terminal', terminal: { outcome: 'EXPIRED', reason: 'expired' } };
    }
    const sourceStartedAt = performance.now();
    try {
      const row = await this.maxClient.getExactMessageRow(job.chatId, job.messageId, {
        trafficClass: 'background',
        sourceTag: GOVERNOR_SOURCE_TAG,
        botId,
        bypassCache: true,
        timeoutMs,
      });
      if (!row) {
        this.metrics.recordCounter('source.exact.absent');
        return {
          kind: 'terminal',
          terminal: { outcome: 'LEGITIMATE_SKIP', reason: 'source_absent' },
        };
      }
      const source = extractCommercialOcrExactMessageSource(row);
      if (!source) {
        this.metrics.recordCounter('source.exact.invalid');
      }
      return source
        ? { kind: 'ready', value: source }
        : {
            kind: 'terminal',
            terminal: { outcome: 'TECHNICAL_INCOMPLETE', reason: 'source_invalid' },
          };
    } catch (error: unknown) {
      this.metrics.recordCounter('source.exact.unavailable');
      const { kind, retry } = classifyCommercialOcrSourceFailure(error);
      this.metrics.recordCounter(`source.exact.failure.${phase}.${kind}`);
      if (retry) {
        this.metrics.recordCounter('source.exact.retry');
        throw new CommercialOcrSourceUnavailableError(retry);
      }
      // FLAG: A failed source read leaves analysis incomplete; an access/missing HTTP status
      // cannot establish source absence. Preserve terminal fail-open and the original retry policy.
      return {
        kind: 'terminal',
        terminal: {
          outcome: 'TECHNICAL_INCOMPLETE',
          reason: 'source_unavailable',
        },
      };
    } finally {
      this.metrics.recordStageDuration('source', Math.max(0, performance.now() - sourceStartedAt));
    }
  }

  private async resolveFinalAuthorization(params: {
    job: CommercialOcrJob;
    jobId: string;
    initialContext: CommercialOcrJobContext;
    initialSource: SourceEnvelope;
    deadlineAtMs: number;
  }): Promise<{
    context: CommercialOcrJobContext;
    exactSource: CommercialOcrDeleteSource;
    originBotId: string;
  } | null> {
    if (deadlineExpired(params.deadlineAtMs)) {
      return null;
    }
    const admission = await this.admissionStore.resolveState(params.jobId);
    if (admission.kind !== 'available' || admission.state !== 'actionable') {
      return null;
    }
    if (
      this.moderationDeleteIntents.getRolloutForRule(
        params.job.chatId,
        COMMERCIAL_OCR_DELETE_RULE_CODE,
      ) !== 'execute'
    ) {
      return null;
    }

    const context = await this.loadJobContext(params.job.chatId);
    if (
      !context ||
      context.entityType !== ChatEntityType.CHAT ||
      !context.settings.commercialAdsFilterEnabled ||
      !sameCommercialPolicy(context.settings, params.initialContext.settings) ||
      context.localAdminUserIds.includes(params.initialSource.album.senderId)
    ) {
      return null;
    }
    if (
      !(await this.isFreshNonAdmin(
        params.job.chatId,
        params.initialSource.album.senderId,
        params.initialSource.originBotId,
        params.deadlineAtMs,
      ))
    ) {
      return null;
    }

    const exactResult = await this.loadExactSource(
      params.job,
      params.initialSource.originBotId,
      params.deadlineAtMs,
      'revalidation',
    );
    const exact = exactResult.kind === 'ready' ? exactResult.value : null;
    const exactSource = exact?.source ?? null;
    if (
      !exactSource ||
      exact?.authorKind !== 'user' ||
      !sameAlbumSource(params.initialSource.album, exactSource, params.job) ||
      !sameExactSource(exactSource, params.initialSource.exactSource)
    ) {
      return null;
    }

    const finalAdmission = await this.admissionStore.resolveState(params.jobId);
    if (finalAdmission.kind !== 'available' || finalAdmission.state !== 'actionable') {
      return null;
    }
    if (deadlineExpired(params.deadlineAtMs)) {
      return null;
    }
    return { context, exactSource, originBotId: params.initialSource.originBotId };
  }

  private async loadJobContext(chatId: string): Promise<CommercialOcrJobContext | null> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        settings: true,
        admins: { select: { userId: true } },
        domains: {
          where: {
            OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
          },
          select: { domain: true },
        },
      },
    });
    if (!chat?.settings) {
      return null;
    }
    return {
      entityType: chat.entityType,
      settings: chat.settings,
      localAdminUserIds: chat.admins.map((admin) => admin.userId),
      domainAllowlist: chat.domains.map((entry) => entry.domain),
    };
  }

  private async isFreshNonAdmin(
    chatId: string,
    userId: string,
    botId: string,
    deadlineAtMs: number,
  ): Promise<boolean> {
    const timeoutMs = remainingStageTimeoutMs(deadlineAtMs, ADMIN_LOOKUP_TIMEOUT_MS);
    if (timeoutMs === null) {
      return false;
    }
    try {
      const access = await this.maxClient.getChatMemberAccess(chatId, userId, {
        trafficClass: 'background',
        sourceTag: GOVERNOR_SOURCE_TAG,
        botId,
        bypassCache: true,
        timeoutMs,
      });
      return Boolean(
        access &&
        (access.userId === null || access.userId === userId) &&
        !access.isAdmin &&
        !access.isOwner,
      );
    } catch {
      this.logger.warn('Commercial OCR fresh admin check failed; enforcement remains fail-open');
      return false;
    }
  }

  private async authorizeHeavyStage(
    stage: 'download' | 'ocr' | 'ocr_dispatch',
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    try {
      const decision = await this.governor.decide({
        component: GOVERNOR_COMPONENT,
        sourceTag: GOVERNOR_SOURCE_TAG,
        // FLAG: An unrelated webhook backlog may admit one cache-miss pass per slow slot.
        // The governor still checks host pressure; manual and MAX/mixed pauses retain authority.
        allowRecoveryWindowRun: true,
        allowQueueBacklogSlowPath: true,
        ignoredPressureDomains: ['max_api_traffic'],
      });
      const retryAfterMs =
        Number.isSafeInteger(decision.retryAfterMs) && decision.retryAfterMs > 0
          ? Math.min(600_000, decision.retryAfterMs)
          : 30_000;
      if (decision.action === 'run') return { allowed: true, retryAfterMs: 0 };
      if (decision.action !== 'slow') return { allowed: false, retryAfterMs };
      // FLAG: The single OCR consumer may advance one cache-miss pass per slow interval.
      // Downloads and cache hits do not consume that slot; pause always retains authority.
      if (stage !== 'ocr') return { allowed: true, retryAfterMs: 0 };
      const nowMs = performance.now();
      if (nowMs < this.nextSlowOcrAtMs) {
        return {
          allowed: false,
          retryAfterMs: Math.max(1, Math.ceil(this.nextSlowOcrAtMs - nowMs)),
        };
      }
      this.nextSlowOcrAtMs = nowMs + retryAfterMs;
      return { allowed: true, retryAfterMs: 0 };
    } catch {
      return { allowed: false, retryAfterMs: 30_000 };
    }
  }

  private async consumeParticipantImmunityFailOpen(params: {
    chatId: string;
    userId: string;
    messageId: string;
    nightModeTimezone: string | null;
  }): Promise<boolean> {
    try {
      return (
        (await this.participantImmunity.consumeForMessage({
          ...params,
          scope: COMMERCIAL_OCR_PARTICIPANT_IMMUNITY_SCOPE,
        })) === 'granted'
      );
    } catch {
      this.logger.warn(
        'Commercial OCR participant immunity check failed; enforcement remains fail-open',
      );
      return true;
    }
  }

  private async persistDeleteAction(params: {
    job: CommercialOcrJob;
    jobId: string;
    binding: CommercialOcrDeleteBinding;
    senderId: string;
    sourceCreatedAt: string;
    originBotId: string;
    deadlineAtMs: number;
  }): Promise<void> {
    const bindingDigest = createHash('sha256').update(JSON.stringify(params.binding)).digest('hex');
    try {
      await this.moderationDeleteIntents.ensureIntentWithMessageActionClaim({
        claim: {
          dedupeKey: `commercial-ocr-action:v1:${bindingDigest}`,
          messageActionKey: buildMessageScopedModerationActionClaimKey(
            params.job.chatId,
            params.job.messageId,
          ),
          chatId: params.job.chatId,
          userId: params.senderId,
          messageId: params.job.messageId,
          ruleCode: COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE,
          updateType: 'message_action',
        },
        intent: {
          chatId: params.job.chatId,
          messageId: params.job.messageId,
          reasonKey: `commercial-ocr-delete:${params.jobId}`,
          ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
          subjectUserId: params.senderId,
          sourceMessageAt: params.sourceCreatedAt,
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          originBotId: params.originBotId,
          routingPolicy: 'delete_capable',
          retryUntilAt: new Date(params.deadlineAtMs),
          commercialOcrDeadlineAt: new Date(params.deadlineAtMs),
          event: {
            userId: params.senderId,
            eventType: 'MESSAGE',
            score: 1,
            metadata: { commercialOcrBinding: params.binding },
          },
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        'Failed to atomically persist commercial OCR action ownership and delete intent',
      );
      throw error;
    }
  }
}

function sameAlbumSource(
  album: LogicalPhotoAlbum,
  source: CommercialOcrDeleteSource,
  job: CommercialOcrJob,
): boolean {
  const photoIds = album.images.map((image) => image.photoId);
  return (
    source.chatId === job.chatId &&
    source.messageId === job.messageId &&
    source.senderId === album.senderId &&
    (job.schemaVersion === COMMERCIAL_OCR_JOB_SCHEMA_VERSION ||
      source.sourceCreatedAt === new Date(album.createdAtMs).toISOString()) &&
    source.sourceCreatedAt === new Date(job.sourceCreatedAt).toISOString() &&
    source.caption === album.caption &&
    source.orderedPhotoIds.length === job.imageCount &&
    photoIds.length === source.orderedPhotoIds.length &&
    photoIds.every(
      (photoId, index) => photoId !== null && photoId === source.orderedPhotoIds[index],
    )
  );
}

function refreshAlbumDownloadUrls(
  album: LogicalPhotoAlbum,
  exactImages: CommercialOcrExactMessageSource['images'],
): {
  album: LogicalPhotoAlbum;
  persistedDownloadUrlFallbackIndexes: readonly number[];
} | null {
  if (album.images.length !== exactImages.length) {
    return null;
  }
  const persistedDownloadUrlFallbackIndexes: number[] = [];
  const images = album.images.map((image, index) => {
    const exact = exactImages[index];
    if (
      !exact ||
      image.photoId === null ||
      exact.photoId === null ||
      image.photoId !== exact.photoId ||
      image.source !== exact.source
    ) {
      return null;
    }
    if (exact.downloadUrl === null && image.downloadUrl !== null) {
      persistedDownloadUrlFallbackIndexes.push(index);
    }
    return {
      ...image,
      downloadUrl: exact.downloadUrl ?? image.downloadUrl,
    };
  });
  if (images.some((image) => image === null)) {
    return null;
  }
  return {
    album: { ...album, images: images as LogicalPhotoAlbum['images'] },
    persistedDownloadUrlFallbackIndexes,
  };
}

function sameExactSource(
  left: CommercialOcrDeleteSource,
  right: CommercialOcrDeleteSource,
): boolean {
  return (
    left.chatId === right.chatId &&
    left.messageId === right.messageId &&
    left.senderId === right.senderId &&
    left.sourceCreatedAt === right.sourceCreatedAt &&
    left.caption === right.caption &&
    left.orderedPhotoIds.length === right.orderedPhotoIds.length &&
    left.orderedPhotoIds.every((photoId, index) => photoId === right.orderedPhotoIds[index])
  );
}

function fingerprintSettingsFailOpen(settings: ChatSettings): string | null {
  try {
    return fingerprintCommercialOcrSettingsProfile(settings);
  } catch {
    return null;
  }
}

function sameCommercialPolicy(left: ChatSettings, right: ChatSettings): boolean {
  return (
    left.commercialAdsFilterEnabled === right.commercialAdsFilterEnabled &&
    left.commercialAdsSensitivity === right.commercialAdsSensitivity &&
    left.commercialAdsWarnThreshold === right.commercialAdsWarnThreshold &&
    left.commercialAdsDeleteThreshold === right.commercialAdsDeleteThreshold
  );
}

function isImageTextStopListEnabled(settings: ChatSettings | null | undefined): boolean {
  return isStopWordsImageScanEnabled(settings);
}

function decisionStillConfigured(
  decision: Extract<ImageTextStopListDecision, { kind: 'match' }>,
  settings: ChatSettings,
): boolean {
  return isStopWordsDecisionConfigured(settings, decision);
}

function isBotOrServiceAuthored(update: MaxUpdate): boolean {
  const raw = asRecord(update.raw);
  const message = raw ? selectRawMessage(raw) : null;
  for (const sender of [
    asRecord(message?.sender),
    asRecord(message?.from),
    asRecord(raw?.sender),
    asRecord(raw?.from),
  ]) {
    if (!sender) continue;
    const type = readString(sender.type)?.toLowerCase() ?? readString(sender.kind)?.toLowerCase();
    if (
      type === 'bot' ||
      type === 'service' ||
      sender.is_bot === true ||
      sender.isBot === true ||
      sender.bot === true ||
      sender.is_service === true ||
      sender.isService === true
    ) {
      return true;
    }
  }
  return false;
}

function selectRawMessage(raw: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asRecord(raw.message);
  if (direct) return direct;
  for (const key of ['message_created', 'data', 'event']) {
    const envelope = asRecord(raw[key]);
    const nested = asRecord(envelope?.message);
    if (nested) return nested;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function deadlineExpired(deadlineAtMs: number): boolean {
  return !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= Date.now();
}

function remainingStageTimeoutMs(deadlineAtMs: number, stageCeilingMs: number): number | null {
  const remainingMs = deadlineAtMs - Date.now();
  if (
    !Number.isSafeInteger(deadlineAtMs) ||
    !Number.isSafeInteger(stageCeilingMs) ||
    stageCeilingMs <= 0 ||
    remainingMs <= 0
  ) {
    return null;
  }
  return Math.max(1, Math.min(stageCeilingMs, remainingMs));
}

class CommercialOcrSourceUnavailableError extends Error {
  constructor(readonly retry: { retryAfterMs?: number }) {
    super('Commercial OCR exact source temporarily unavailable');
  }
}
