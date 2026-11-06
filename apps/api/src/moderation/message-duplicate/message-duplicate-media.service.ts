import { isMaxMutationOutcomeAmbiguous } from '../../max/max-mutation-outcome.util';
import { duplicatePublicationTime } from './message-duplicate-publication-time';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { MaxUpdate } from '@maxim/contracts';
import type { DuplicateObservationOutcome } from '@maxim/contracts/settings';
import { z } from 'zod';
import { UnrecoverableError } from 'bullmq';
import { extractHttpStatusCode } from '../../common/http-error.util';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { WebhookPreparationDeferredError } from '../../common/webhook-preparation-deferred.error';
import { MaxBotContextService } from '../../max/max-bot-context.service';
import { MaxExecutionOwnerReadinessService } from '../../max/max-execution-owner-readiness.service';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ChatSettings } from '../../prisma/prisma-client';
import { WebhookParser } from '../../webhook/webhook.parser';
import { WebhookLegacyHoldService } from '../../webhook/webhook-legacy-hold.service';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { resolveTrustedDuplicateStateRevision } from '../duplicate-message-revision';
import { classifyDuplicateEventTime } from '../duplicate-enforcement-safety';
import { RedisCounterService } from '../redis-counter.service';
import { PhotoDuplicateAnalysisService } from '../photo-duplicate/photo-duplicate-analysis.service';
import {
  PhotoDownloadHttpError,
  PhotoDownloadByteLimitExceededError,
  PhotoDownloadFormatRejectedError,
  PhotoDownloadTimeoutError,
  PhotoDownloadSourceRejectedError,
  SecurePhotoDownloader,
  type PhotoDownloadSourceRejectionReason,
} from '../photo-duplicate/secure-photo-downloader';
import {
  PhotoNativeUnavailableError,
  PhotoFingerprintRejectedError,
  type PhotoFingerprintRejectionReason,
} from '../photo-duplicate/photo-fingerprint';
import type { PhotoDuplicateOrderingLease } from '../photo-duplicate/photo-duplicate-ordering.store';
import { DUPLICATE_JOB_MAX_LIFETIME_MS } from '../photo-duplicate/photo-duplicate-ordering.store';
import { PhotoDuplicateSourceNotReadyError } from '../photo-duplicate/photo-duplicate.queue';
import { isPendingWebhookTimeoutQuarantineMessage } from '../../webhook/webhook-timeout-quarantine';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import {
  MessageDuplicateHistoryService,
  type MessageDuplicateHistoryObservation,
} from './message-duplicate-history.service';
import {
  MessageDuplicateEnforcementService,
  duplicateEnforcementObservation,
} from './message-duplicate-enforcement.service';
import {
  digestDuplicateContent,
  canRefreshDuplicatePhotoSources,
  extractDuplicateMessageContent,
  isExactImageContent,
  isDuplicateContentComparable,
  type DuplicateMessageContent,
} from './message-duplicate-content';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
  type MessageDuplicateOriginal,
} from './message-duplicate-state';
import type { MessageDuplicateJob } from './message-duplicate.queue';
import type { ExecuteDuplicateModerationAction } from '../duplicate-moderation.actions';
import {
  MessageDuplicateMetricsService,
  measureDuplicatePhase,
  recordDuplicatePhase,
  type MessageDuplicateMetricCounter,
} from './message-duplicate-metrics.service';
import { isDuplicateScheduleOpen, resolveDuplicateDailyWindow } from './message-duplicate-schedule';
import {
  MessageDuplicateRecompressionIndex,
  type MessageDuplicateRecompressionCandidate,
} from './message-duplicate-recompression-index';
import type { PhotoRecompressionProof } from '../photo-duplicate/photo-recompression-version';

const requireFromHere = createRequire(__filename);
const MAX_UNCACHED_MEDIA_PER_ATTEMPT = 20;
const DIAGNOSTIC_WAIT_LIMIT_MS = 250;

// FLAG: Observational Redis calls may finish later, but never hold moderation through
// client retries. Their markers have no execution authority or source content.
async function boundedDiagnostic<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await raceWithTimeout<T | undefined>({
      operation,
      timeoutMs: DIAGNOSTIC_WAIT_LIMIT_MS,
      onTimeout: () => undefined,
    });
  } catch {
    return undefined;
  }
}
// FLAG: Fixed counters describe rejected download attempts, including refresh/retry;
// they are not exact totals of rejected messages and must never contain source data.
const PHOTO_SOURCE_REJECTION_METRICS = {
  malformed_url: 'media.url_malformed',
  protocol: 'media.url_protocol',
  credentials: 'media.url_credentials',
  port: 'media.url_port',
  host: 'media.url_host',
} as const satisfies Record<PhotoDownloadSourceRejectionReason, MessageDuplicateMetricCounter>;
const pointerSchema = z
  .object({
    webhookEventId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(512),
    eventTimestampMs: z.number().int().positive(),
    recompressionAnchor: z
      .object({
        webhookEventId: z.string().min(1).max(128),
        messageId: z.string().min(1).max(256),
        eventTimestampMs: z.number().int().positive(),
        publishedAtMs: z.number().int().positive(),
        canonicalHash: z.string().regex(/^[a-f0-9]{64}$/),
        recompressionHash: z.string().regex(/^[a-f0-9]{16}$/),
        expiresAtMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
const hashSchema = z
  .object({
    version: z.literal(MESSAGE_DUPLICATE_MEDIA_VERSION),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    recompressionHash: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
  })
  .strict();

export type MessageDuplicateMediaDeferredReason =
  | 'governor_pause'
  | 'governor_slow'
  | 'proof_budget'
  | 'decode_capacity';

export class MessageDuplicateMediaDeferredError extends Error {
  readonly retryAfterMs: number;

  constructor(
    readonly reason: MessageDuplicateMediaDeferredReason = 'proof_budget',
    retryAfterMs?: number,
  ) {
    super(`Message duplicate media deferred: ${reason}`);
    this.name = 'MessageDuplicateMediaDeferredError';
    const delay =
      retryAfterMs ?? (reason === 'governor_pause' || reason === 'governor_slow' ? 60_000 : 5000);
    this.retryAfterMs =
      Number.isFinite(delay) && delay > 0
        ? Math.min(10 * 60_000, Math.max(1000, Math.ceil(delay)))
        : 60_000;
  }
}

export class MessageDuplicateMediaRejectedError extends UnrecoverableError {
  constructor(
    readonly reason:
      | PhotoFingerprintRejectionReason
      | 'format'
      | 'missing_download_url'
      | 'source_unavailable'
      | 'source_changed',
  ) {
    super(`Message media content unverified: ${reason}`);
    this.name = 'MessageDuplicateMediaRejectedError';
  }
}

@Injectable()
export class MessageDuplicateMediaService {
  private readonly logger = new Logger(MessageDuplicateMediaService.name);
  private readonly binary: SecurePhotoDownloader;
  private readonly resourceKey: string;
  private readonly sharedAdmissionEnabled: boolean;
  private readonly recompressionIndex: MessageDuplicateRecompressionIndex;
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisCounterService,
    private readonly photos: PhotoDuplicateAnalysisService,
    private readonly policy: MessageDuplicatePolicyService,
    private readonly history: MessageDuplicateHistoryService,
    private readonly enforcement: MessageDuplicateEnforcementService,
    private readonly bots: MaxBotLinkService,
    private readonly governor: BackgroundRuntimeGovernorService,
    config: ConfigService,
    private readonly max: MaxClientService,
    private readonly botContext: MaxBotContextService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
    @Optional() private readonly executionReadiness?: MaxExecutionOwnerReadinessService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {
    this.recompressionIndex = new MessageDuplicateRecompressionIndex(redis);
    this.sharedAdmissionEnabled =
      config.get('MESSAGE_DUPLICATE_MEDIA_SHARED_ADMISSION_ENABLED') === true;
    const maxBytes = config.get<number>('MESSAGE_DUPLICATE_MAX_BYTES') ?? 8_388_608;
    this.binary = new SecurePhotoDownloader(
      new ConfigService({
        PHOTO_DUPLICATE_ALLOWED_HOSTS:
          config.get('MESSAGE_DUPLICATE_ALLOWED_HOSTS') ?? 'i.oneme.ru,fd.oneme.ru,*.okcdn.ru',
        PHOTO_DUPLICATE_MAX_BYTES: maxBytes,
        PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS: 5000,
      }),
    );
    this.resourceKey = digestDuplicateContent([
      MESSAGE_DUPLICATE_MEDIA_VERSION,
      maxBytes,
      config.get('PHOTO_DUPLICATE_MAX_BYTES'),
      config.get('PHOTO_DUPLICATE_MAX_PIXELS'),
    ]);
  }

  async process(
    job: MessageDuplicateJob,
    lease: PhotoDuplicateOrderingLease,
    executeFullAction?: ExecuteDuplicateModerationAction,
  ): Promise<DuplicateObservationOutcome> {
    let sourceExecutor: { chatId: string; botId: string } | null = null;
    let businessExecutionStarted = false;
    let supported = false;
    let comparedOutcome: DuplicateObservationOutcome | null = null;
    const finish = (outcome: DuplicateObservationOutcome) => {
      try {
        this.metrics?.recordObservation?.(job.chatId, outcome, supported);
      } catch {
        /* FLAG: Telemetry cannot replace the moderation outcome. */
      }
      return outcome;
    };
    try {
      // FLAG: This optional marker measures the first owned head, excluding later retries.
      // It has no action authority; a diagnostic write failure must preserve moderation.
      try {
        const firstHeadWaitMs = Math.max(0, Date.now() - Date.parse(job.createdAt));
        if (
          await boundedDiagnostic(() =>
            this.redis.setStringIfAbsentWithTtl(
              `message-duplicate:first-head:v1:${job.idempotencyKey}`,
              'observed',
              1200,
            ),
          )
        )
          recordDuplicatePhase(this.metrics, 'prehead_wait', firstHeadWaitMs);
      } catch {
        /* FLAG: Diagnostics cannot block the comparison or create a permit. */
      }
      const imageOnly = job.comparison === 'IMAGE';
      const policy = await measureDuplicatePhase(this.metrics, 'policy', () =>
        this.policy.resolve(job.chatId, true),
      );
      if (
        policy.mode === 'off' ||
        policy.revision !== job.controlRevision ||
        job.eventTimestampMs < policy.effectiveAtMs
      ) {
        this.metrics?.record('media.policy_changed');
        return finish('POLICY_CHANGED');
      }
      lease.assertOwned();
      const source = await measureDuplicatePhase(this.metrics, 'source', () =>
        this.loadSource(job.webhookEventId),
      );
      if (!source) {
        this.metrics?.record('media.source_missing');
        return finish('SOURCE_UNAVAILABLE');
      }
      lease.assertOwned();
      sourceExecutor = { chatId: job.chatId, botId: source.botId };
      const message = source.update.message!;
      if (
        message.chatId !== job.chatId ||
        message.messageId !== job.messageId ||
        source.eventTimestampMs !== job.eventTimestampMs ||
        this.bots.isKnownBotUserId(message.senderId)
      ) {
        this.metrics?.record('media.identity_rejected');
        return finish('SOURCE_UNAVAILABLE');
      }
      const settings = await this.prisma.chatSettings.findUnique({
        where: { chatId: job.chatId },
        include: {
          chat: {
            select: {
              entityType: true,
              admins: { select: { userId: true } },
              rules: { select: { publishedUrl: true, publishedMessageId: true } },
            },
          },
        },
      });
      if (
        !settings?.antiDuplicateEnabled ||
        settings.chat.entityType !== 'CHAT' ||
        settings.chat.admins.some((admin) => admin.userId === message.senderId) ||
        settings.duplicatePolicyRevision !== job.policyRevision ||
        (imageOnly
          ? exactImageSettingsDigest(settings)
          : messageDuplicateSettingsDigest(settings)) !== job.settingsDigest
      ) {
        this.metrics?.record('media.settings_rejected');
        return finish('SETTINGS_CHANGED');
      }
      const flow = resolveDuplicateFlowConfig(settings);
      if (!isDuplicateScheduleOpen(settings, job.eventTimestampMs)) {
        this.metrics?.record('media.schedule_closed');
        return finish('SCHEDULE_CLOSED');
      }
      const dailyWindow = resolveDuplicateDailyWindow(settings, job.eventTimestampMs);
      const windowSec = dailyWindow
        ? Math.ceil((dailyWindow.endMs - dailyWindow.startMs) / 1000)
        : flow.windowSec;
      if (
        classifyDuplicateEventTime({
          eventTimestampMs: job.eventTimestampMs,
          windowSec,
        })
      ) {
        this.metrics?.record('media.event_time_rejected');
        return finish('EVENT_TIME_REJECTED');
      }
      const content = extractDuplicateMessageContent(source.update.raw);
      const textOnly = job.comparison === 'TEXT' || (!imageOnly && content.media.length === 0);
      const enforce = async (observation: MessageDuplicateHistoryObservation) => {
        const result = observation.match;
        if (observation.outcome === 'MATCHED') comparedOutcome = 'MATCHED_ACTION_FAILED';
        if (result) {
          if (job.actionEligible !== true || !(await lease.resolveActionEligibility())) {
            this.metrics?.record('media.action_ineligible');
            return finish('MATCHED_INELIGIBLE');
          }
          result.binding.authorization = {
            jobId: job.idempotencyKey,
            eventTimestampMs: job.eventTimestampMs,
            deadlineAtMs: Math.min(
              job.deadlineAtMs,
              result.binding.eventTimestampMs + DUPLICATE_JOB_MAX_LIFETIME_MS,
              textOnly ? Number.MAX_SAFE_INTEGER : (dailyWindow?.endMs ?? Number.MAX_SAFE_INTEGER),
            ),
          };
          const enforcement = await measureDuplicatePhase(this.metrics, 'enforcement', () =>
            this.enforcement.enqueue({
              ...result,
              chatId: job.chatId,
              botId: source.botId,
              readSelectedBotId: () => this.botContext.getActiveBotId() ?? source.botId,
              sourceCreatedAt: message.createdAt,
              text: content.text,
              settings,
              update: source.update,
              executeFullAction: executeFullAction
                ? async (request) => {
                    businessExecutionStarted = true;
                    return this.botContext.runWithBot(source.botId, () =>
                      executeFullAction({
                        ...request,
                        rulesPublishedUrl: settings.chat.rules?.publishedUrl ?? null,
                        rulesPublishedMessageId: settings.chat.rules?.publishedMessageId ?? null,
                      }),
                    );
                  }
                : undefined,
              assertLease: lease.assertOwned,
            }),
          );
          return finish(duplicateEnforcementObservation(enforcement));
        }
        return finish(
          observation.outcome === 'MATCHED' ? 'CONTENT_UNVERIFIED' : observation.outcome,
        );
      };
      if (textOnly) {
        // FLAG: Deferred text qualification reuses the immutable receipt and existing history.
        // It needs no media downloads/candidate cache; final guards still read both MAX sources.
        supported = isDuplicateContentComparable(content, 'TEXT');
        const observation = await measureDuplicatePhase(this.metrics, 'history', () =>
          this.history.observeWithOutcome({
            content,
            comparison: 'TEXT',
            chatId: job.chatId,
            userId: message.senderId,
            messageId: job.messageId,
            eventTimestampMs: job.eventTimestampMs,
            publishedAtMs: duplicatePublicationTime(source.update) ?? 0,
            controlRevision: policy.revision,
            settings,
          }),
        );
        lease.assertOwned();
        return await enforce(observation);
      }
      if (
        !content.complete ||
        content.media.length === 0 ||
        (imageOnly
          ? !isExactImageContent(content)
          : content.media.some((media) => media.kind === 'photo'))
      ) {
        this.metrics?.record('media.content_unverified');
        return finish('CONTENT_UNVERIFIED');
      }
      supported = true;
      const scope = digestDuplicateContent([
        job.chatId,
        imageOnly && settings.duplicatePhotoScope === 'CHAT' ? null : message.senderId,
        job.controlRevision,
        job.settingsDigest,
        dailyWindow?.startMs,
      ]);
      const candidateKeys = this.history
        .candidateKeys(content, settings, imageOnly)
        .map((key) => `message-duplicate:candidate:v1:${scope}:${key}`);
      const ownPointer: z.infer<typeof pointerSchema> = {
        webhookEventId: job.webhookEventId,
        messageId: job.messageId,
        eventTimestampMs: job.eventTimestampMs,
      };
      const predecessors = new Map<string, z.infer<typeof pointerSchema>>();
      let retryingCurrent = false;
      for (const key of candidateKeys) {
        const raw = await this.redis.getString(key);
        const parsed = raw && raw.length < 2048 ? pointerSchema.safeParse(safeJson(raw)) : null;
        if (parsed?.success) {
          const ageMs = job.eventTimestampMs - parsed.data.eventTimestampMs;
          // FLAG: A late older job must not overwrite a newer candidate or create retroactive actions.
          if (ageMs < 0) {
            this.metrics?.record('media.late_event');
            return finish('STALE');
          }
          if (ageMs < windowSec * 1000) {
            if (ageMs === 0 && parsed.data.messageId === job.messageId) retryingCurrent = true;
            else {
              // FLAG: A verified copy retains its accepted original. It must never become
              // the next similarity anchor and accumulate small edits across a chain.
              const anchor = parsed.data.recompressionAnchor ?? parsed.data;
              const previous = predecessors.get(anchor.messageId);
              if (!previous || previous.eventTimestampMs < anchor.eventTimestampMs)
                predecessors.set(anchor.messageId, anchor);
            }
            lease.assertOwned();
            continue;
          }
        }
        lease.assertOwned();
        if (raw !== null) {
          await this.redis.setStringWithTtl(key, JSON.stringify(ownPointer), windowSec);
        }
      }
      const currentCached = await this.readHashes(content, source.update);
      const missingCurrentProof = currentCached.some((hash) => hash === null);
      // FLAG: A candidate pointing at this job may be an unfinished action, not a first occurrence.
      // Rebuild evicted proofs on retry; durable intent/ordering claims still fence repeated actions.
      if (predecessors.size === 0 && !retryingCurrent && missingCurrentProof) {
        for (const key of candidateKeys) {
          lease.assertOwned();
          await this.redis.setStringIfAbsentWithTtl(key, JSON.stringify(ownPointer), windowSec);
        }
        this.metrics?.record('media.first_candidate');
        return finish('MEDIA_CANDIDATE');
      }
      const deadlineAtMs = Math.min(
        Date.now() + 30_000,
        job.deadlineAtMs,
        dailyWindow?.endMs ?? Number.MAX_SAFE_INTEGER,
        policy.expiresAtMs,
      );
      if (Date.now() >= deadlineAtMs) {
        this.metrics?.record('media.deadline_expired');
        return finish('DEADLINE_EXPIRED');
      }
      const baselineSources = new Map<string, Awaited<ReturnType<typeof this.loadSource>>>();
      const baselineHashes = new Map<string, Array<string | null>>();
      let heavyWorkRequired = missingCurrentProof;
      for (const previous of predecessors.values()) {
        const baseline = await measureDuplicatePhase(this.metrics, 'source', () =>
          this.loadSource(previous.webhookEventId),
        );
        baselineSources.set(previous.webhookEventId, baseline);
        if (baseline) {
          const baselineContent = extractDuplicateMessageContent(baseline.update.raw);
          const hashes = await this.readHashes(baselineContent, baseline.update);
          baselineHashes.set(previous.webhookEventId, hashes);
          if (hashes.some((hash) => hash === null)) heavyWorkRequired = true;
        }
      }
      // FLAG: Bypass pressure only after every current/baseline proof is fresh and bound
      // to its exact message/revision/source. The execution still rechecks access/authority.
      if (heavyWorkRequired) await this.admitHeavyWork(job, deadlineAtMs);
      else this.metrics?.record('media.cache_only');
      const budget = { remaining: MAX_UNCACHED_MEDIA_PER_ATTEMPT };
      const refreshedPhotoSources = new Map<string, DuplicateMessageContent | null>();
      let baselineUnverified = false;
      // FLAG: Materialize every distinct predecessor before freezing the current replay count.
      // Proof caches retain progress across bounded deferrals; baseline hits never authorize actions.
      for (const previous of predecessors.values()) {
        lease.assertOwned();
        const rejectedKey = `message-duplicate:baseline-rejected:v1:${this.resourceKey}:${digestDuplicateContent(previous.webhookEventId)}`;
        if ((await this.redis.getString(rejectedKey)) === 'rejected') {
          this.metrics?.record('media.baseline_rejected_cached');
          baselineUnverified = true;
          continue;
        }
        let baselineVerified = false;
        try {
          if (Date.now() >= deadlineAtMs) {
            this.metrics?.record('media.budget_deferred');
            throw new MessageDuplicateMediaDeferredError('proof_budget');
          }
          const baseline = baselineSources.get(previous.webhookEventId) ?? null;
          if (!baseline) this.metrics?.record('media.baseline_missing');
          const baselineMessage = baseline?.update.message;
          if (
            baseline &&
            baselineMessage &&
            baselineMessage.chatId === job.chatId &&
            (baselineMessage.senderId === message.senderId ||
              (imageOnly && settings.duplicatePhotoScope === 'CHAT')) &&
            baselineMessage.messageId === previous.messageId &&
            baseline.eventTimestampMs === previous.eventTimestampMs
          ) {
            const baselineContent = extractDuplicateMessageContent(baseline.update.raw);
            if (
              (imageOnly ? isExactImageContent(baselineContent) : baselineContent.complete) &&
              this.history
                .candidateKeys(baselineContent, settings, imageOnly)
                .some((key) =>
                  candidateKeys.includes(`message-duplicate:candidate:v1:${scope}:${key}`),
                )
            ) {
              const verified = await measureDuplicatePhase(this.metrics, 'media', () =>
                this.hashMedia(
                  baselineContent,
                  baseline.update,
                  windowSec,
                  deadlineAtMs,
                  baseline.botId,
                  baselineHashes.get(previous.webhookEventId),
                  budget,
                  previous.webhookEventId,
                  refreshedPhotoSources,
                ),
              );
              lease.assertOwned();
              await measureDuplicatePhase(this.metrics, 'history', () =>
                this.history.observe({
                  content: verified.content,
                  comparison: 'MESSAGE',
                  chatId: job.chatId,
                  userId: baselineMessage.senderId,
                  messageId: baselineMessage.messageId,
                  eventTimestampMs: baseline.eventTimestampMs,
                  publishedAtMs: duplicatePublicationTime(baseline.update) ?? 0,
                  controlRevision: policy.revision,
                  settings,
                  mediaHashes: verified.hashes,
                  ...(imageOnly ? { imageScope: settings.duplicatePhotoScope } : {}),
                }),
              );
              this.metrics?.record('media.baseline_verified');
              if (imageOnly && verified.hashes.length === 1 && verified.recompressionHash)
                await this.rememberRecompression(
                  scope,
                  previous.webhookEventId,
                  baseline,
                  verified,
                  verified.recompressionHash,
                  windowSec,
                );
              baselineVerified = true;
            }
          }
        } catch (error) {
          // FLAG: A transient baseline failure must retry the pair; acknowledging it would lose
          // the first occurrence and let the first duplicate through without its configured action.
          if (
            !(error instanceof UnrecoverableError) &&
            !(error instanceof PhotoDownloadHttpError && [403, 404, 410].includes(error.statusCode))
          )
            throw error;
          this.recordMediaFailure(error);
          // FLAG: Negative cache entries cannot prove equality. They only prevent a terminal,
          // receipt-scoped baseline from spending every resumed attempt's verification budget.
          lease.assertOwned();
          await this.redis.setStringWithTtl(rejectedKey, 'rejected', windowSec);
          this.metrics?.record('media.baseline_rejected');
          this.logger.debug(
            { chatId: job.chatId },
            'Message duplicate baseline media could not be verified',
          );
        } finally {
          // FLAG: A missing/rejected predecessor is a gap in comparison coverage, never
          // evidence that the current media is unique. It does not change action authority.
          if (!baselineVerified) baselineUnverified = true;
        }
      }
      lease.assertOwned();
      const verified = await measureDuplicatePhase(this.metrics, 'media', () =>
        this.hashMedia(
          content,
          source.update,
          windowSec,
          deadlineAtMs,
          source.botId,
          currentCached,
          budget,
          job.webhookEventId,
          refreshedPhotoSources,
        ),
      );
      if (Date.now() >= deadlineAtMs) throw new MessageDuplicateMediaDeferredError('proof_budget');
      lease.assertOwned();
      const recompression: {
        unverified: boolean;
        anchor?: MessageDuplicateRecompressionCandidate;
        proof?: PhotoRecompressionProof;
        original?: MessageDuplicateOriginal;
      } =
        imageOnly && verified.hashes.length === 1 && verified.recompressionHash
          ? await this.findRecompression({
              scope,
              job,
              source,
              settings,
              verified,
              hash: verified.recompressionHash,
              deadlineAtMs,
              budget,
              lease,
              heavyWorkAdmitted: heavyWorkRequired,
              refreshedPhotoSources,
            })
          : { unverified: false };
      if (recompression.anchor) ownPointer.recompressionAnchor = recompression.anchor;
      if (recompression.unverified) baselineUnverified = true;
      const observation = await measureDuplicatePhase(this.metrics, 'history', () =>
        this.history.observeWithOutcome({
          content: verified.content,
          comparison: 'MESSAGE',
          chatId: job.chatId,
          userId: message.senderId,
          messageId: job.messageId,
          eventTimestampMs: job.eventTimestampMs,
          publishedAtMs: duplicatePublicationTime(source.update) ?? 0,
          controlRevision: policy.revision,
          settings,
          mediaHashes: verified.hashes,
          ...(imageOnly ? { imageScope: settings.duplicatePhotoScope } : {}),
          ...(recompression.proof
            ? { imageRecompression: recompression.proof, imageOriginal: recompression.original }
            : {}),
        }),
      );
      if (
        imageOnly &&
        verified.hashes.length === 1 &&
        verified.recompressionHash &&
        !recompression.anchor
      )
        await this.rememberRecompression(
          scope,
          job.webhookEventId,
          source,
          verified,
          verified.recompressionHash,
          windowSec,
        );
      const result = observation.match;
      if (observation.outcome === 'MATCHED') comparedOutcome = 'MATCHED_ACTION_FAILED';
      if (observation.outcome === 'COMPARED_NO_MATCH' && !baselineUnverified)
        comparedOutcome = 'COMPARED_NO_MATCH';
      for (const key of candidateKeys) {
        lease.assertOwned();
        await this.redis.setStringWithTtl(key, JSON.stringify(ownPointer), windowSec);
      }
      if (result) return await enforce(observation);
      return finish(
        baselineUnverified || observation.outcome === 'MATCHED'
          ? 'CONTENT_UNVERIFIED'
          : observation.outcome,
      );
    } catch (error) {
      let finalError = error;
      // FLAG: Only read/qualification failures before business dispatch can hand off
      // this stage. Never replay an action after an unknown or already successful mutation.
      const status = extractHttpStatusCode(error);
      if (
        !businessExecutionStarted &&
        sourceExecutor &&
        this.executionReadiness &&
        !(error instanceof PhotoDownloadHttpError) &&
        !isMaxMutationOutcomeAmbiguous(error) &&
        (status === 403 || status === 404)
      ) {
        lease.assertOwned();
        try {
          await this.resolveStageExecutor({
            chatId: sourceExecutor.chatId,
            preferredBotId: sourceExecutor.botId,
            force: true,
          });
          lease.assertOwned();
          finalError = new MessageDuplicateMediaDeferredError('proof_budget', 1000);
        } catch (readinessError) {
          finalError = readinessError;
        }
      }
      this.recordMediaFailure(finalError);
      finish(
        finalError instanceof MessageDuplicateMediaDeferredError ||
          finalError instanceof PhotoDuplicateSourceNotReadyError
          ? 'DEFERRED'
          : (comparedOutcome ?? (supported ? 'COMPARISON_FAILED' : 'UNAVAILABLE')),
      );
      throw finalError;
    }
  }

  private async admitHeavyWork(job: MessageDuplicateJob, deadlineAtMs: number): Promise<void> {
    const decision = await measureDuplicatePhase(this.metrics, 'governor_gate', () =>
      this.governor.decide({
        component: 'message-duplicate-media',
        sourceTag: 'message-duplicate',
        allowRecoveryWindowRun: true,
      }),
    );
    // FLAG: Every heavy attempt consults fresh pressure. Prior wait, cache markers and a
    // previously granted budget never override pause or the absolute job/policy deadline.
    if (decision.action === 'pause')
      throw new MessageDuplicateMediaDeferredError('governor_pause', decision.retryAfterMs);
    if (decision.action !== 'slow') return;
    const intervalMs = new MessageDuplicateMediaDeferredError(
      'governor_slow',
      decision.retryAfterMs,
    ).retryAfterMs;
    if (this.sharedAdmissionEnabled) {
      const createdAtMs = Date.parse(job.createdAt);
      if (!Number.isSafeInteger(createdAtMs) || createdAtMs > Date.now() + 60_000)
        throw new Error('Invalid duplicate heavy admission creation time');
      const eligibleAtMs = createdAtMs + intervalMs;
      this.metrics?.record(
        Date.now() >= eligibleAtMs ? 'media.governor_credit_reused' : 'media.governor_credit_new',
      );
      let admission;
      try {
        admission = await this.redis.admitDuplicateHeavyStart({
          eligibleAtMs,
          intervalMs,
          deadlineAtMs,
        });
      } catch {
        this.metrics?.record('media.shared_admission_unavailable');
        throw new MessageDuplicateMediaDeferredError('governor_slow', intervalMs);
      }
      // FLAG: Queue-age credit overlaps pre-head wait. Measure only elapsed time after
      // this job's first shared-gate deferral; the marker is observational, never a permit.
      const waitKey = `message-duplicate:governor-shared-wait:v1:${job.idempotencyKey}`;
      try {
        const waitedSince = await boundedDiagnostic(async () => {
          const value = await this.redis.getString(waitKey);
          if (admission.kind !== 'granted')
            await this.redis.setStringIfAbsentWithTtl(waitKey, String(Date.now()), 600);
          return value;
        });
        if (waitedSince != null && Number.isSafeInteger(Number(waitedSince)))
          recordDuplicatePhase(
            this.metrics,
            'governor_wait',
            Math.max(0, Date.now() - Number(waitedSince)),
          );
      } catch {
        /* FLAG: Diagnostic persistence cannot alter admission or replace its result. */
      }
      if (admission.kind === 'granted') {
        this.metrics?.record('media.shared_admission_granted');
        return;
      }
      this.metrics?.record('media.shared_admission_deferred');
      throw new MessageDuplicateMediaDeferredError(
        'governor_slow',
        admission.kind === 'deferred' ? admission.retryAtMs - Date.now() : intervalMs,
      );
    }
    const slowKey = `message-duplicate:governor-slow:v2:${job.idempotencyKey}`;
    const stored = await this.redis.getString(slowKey);
    const nextAllowedAtMs = stored === null ? Date.now() + intervalMs : Number(stored);
    if (!Number.isSafeInteger(nextAllowedAtMs) || nextAllowedAtMs <= 0)
      throw new Error('Invalid message duplicate governor pacing state');
    this.metrics?.record(
      stored === null ? 'media.governor_credit_new' : 'media.governor_credit_reused',
    );
    if (stored === null) {
      await this.redis.setStringIfAbsentWithTtl(slowKey, String(nextAllowedAtMs), 600);
      await boundedDiagnostic(() =>
        this.redis.setStringIfAbsentWithTtl(`${slowKey}:started`, String(Date.now()), 600),
      );
    } else {
      const started = await boundedDiagnostic(() => this.redis.getString(`${slowKey}:started`));
      if (started != null && Number.isSafeInteger(Number(started)))
        recordDuplicatePhase(
          this.metrics,
          'governor_wait',
          Math.max(0, Date.now() - Number(started)),
        );
    }
    if (Date.now() < nextAllowedAtMs)
      throw new MessageDuplicateMediaDeferredError('governor_slow', nextAllowedAtMs - Date.now());
  }

  private recordMediaFailure(error: unknown): void {
    if (
      error instanceof MessageDuplicateMediaDeferredError ||
      error instanceof PhotoDownloadSourceRejectedError
    )
      return;
    let reason:
      | 'format'
      | 'multiframe'
      | 'bytes'
      | 'pixels'
      | 'album_budget'
      | 'http_4xx'
      | 'http_5xx'
      | 'http_other'
      | 'source_missing'
      | 'source_unavailable'
      | 'source_changed'
      | 'source_timeout'
      | 'native_unavailable'
      | 'decode_deadline'
      | 'decode_capacity'
      | 'other';
    if (
      error instanceof MessageDuplicateMediaRejectedError ||
      error instanceof PhotoFingerprintRejectedError
    ) {
      const reasons = {
        format: 'format',
        missing_download_url: 'source_missing',
        source_unavailable: 'source_unavailable',
        source_changed: 'source_changed',
        unsupported_image: 'format',
        unsupported_multi_frame: 'multiframe',
        image_byte_limit_exceeded: 'bytes',
        image_pixel_limit_exceeded: 'pixels',
        album_decode_budget_exceeded: 'album_budget',
        decode_deadline_exceeded: 'decode_deadline',
        decode_capacity_exceeded: 'decode_capacity',
      } as const;
      reason = reasons[error.reason];
    } else if (error instanceof PhotoDownloadByteLimitExceededError) reason = 'bytes';
    else if (error instanceof PhotoDownloadFormatRejectedError) reason = 'format';
    else if (error instanceof PhotoDownloadTimeoutError) reason = 'source_timeout';
    else if (error instanceof PhotoNativeUnavailableError) reason = 'native_unavailable';
    else if (error instanceof PhotoDownloadHttpError)
      reason =
        error.statusCode >= 500 && error.statusCode <= 599
          ? 'http_5xx'
          : error.statusCode >= 400 && error.statusCode <= 499
            ? 'http_4xx'
            : 'http_other';
    else reason = 'other';
    this.metrics?.record(`media.failure_${reason}`);
  }

  private async loadSource(webhookEventId: string) {
    const row = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
      select: {
        status: true,
        botId: true,
        normalizedPayload: true,
        executionClaims: {
          where: { kind: 'EXECUTION' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { executionBotId: true },
        },
        nextEnqueueAt: true,
        errorMessage: true,
      },
    });
    if (
      !row ||
      row.status === 'DUPLICATE' ||
      ['NO_REPLAY_HELD', 'CANCELLED'].includes(row.status) ||
      (row.status === 'FAILED' &&
        row.nextEnqueueAt === null &&
        !isPendingWebhookTimeoutQuarantineMessage(row.errorMessage))
    )
      return null;
    const update = row.normalizedPayload as unknown as MaxUpdate;
    // FLAG: Permanent holds also cover the unchanged FAILED owner receipt. Settle its
    // media job without retrying, downloading, or creating a new duplicate baseline.
    if (update?.message && (await this.legacyHolds?.isUpdateHeld(update))) return null;
    if (row.status !== 'PROCESSED') throw new PhotoDuplicateSourceNotReadyError(webhookEventId);
    if (!update?.message) return null;
    const revision = resolveTrustedDuplicateStateRevision(
      update.type,
      update.message.createdAt,
      update.eventTimestampSource,
    );
    if (!revision.duplicateStateEventTimestampMs) return null;
    // FLAG: The persisted executor owns fresh source/access checks. Receiving bot
    // provenance is retained in the receipt; it must not override the selected owner.
    const selectedBotId =
      row.executionClaims?.[0]?.executionBotId ??
      row.botId ??
      update.botId ??
      this.bots.getDefaultBotId();
    const executableBotId = this.bots.resolveExecutableBotId(selectedBotId);
    // Never fall back to the default token for a Publisher-only or unknown owner.
    if (!executableBotId) return null;
    const readiness = await this.resolveStageExecutor({
      chatId: update.message.chatId,
      preferredBotId: executableBotId,
    });
    if (this.executionReadiness && !readiness)
      throw new MessageDuplicateMediaDeferredError('proof_budget', 1000);
    // FLAG: The stage executor may change; the completed canonical receipt and job identity do not.
    return {
      update,
      botId: readiness?.botId ?? executableBotId,
      eventTimestampMs: revision.duplicateStateEventTimestampMs,
    };
  }

  private async resolveStageExecutor(params: {
    chatId: string;
    preferredBotId: string;
    force?: boolean;
  }) {
    if (!this.executionReadiness) return null;
    try {
      return await this.executionReadiness.ensureReady({ ...params, purpose: 'delete_message' });
    } catch (error) {
      // FLAG: Unknown/fenced access waits consume the original media deadline, never
      // ordinary failure attempts or a newly created source/revision lifetime.
      if (error instanceof WebhookPreparationDeferredError)
        throw new MessageDuplicateMediaDeferredError('proof_budget', error.retryAfterMs);
      throw error;
    }
  }

  private cacheKey(identity: string, update: MaxUpdate): string {
    // FLAG: Binary proofs are message/revision scoped; an unverified platform id cannot reuse
    // another message's bytes. The inner photo cache also binds its message/revision/source.
    const source = digestDuplicateContent([
      update.message?.chatId,
      update.message?.messageId,
      update.message?.createdAt,
      identity,
    ]);
    return `message-duplicate:media-hash:v1:${this.resourceKey}:${source}`;
  }

  private async readHashes(
    content: DuplicateMessageContent,
    update: MaxUpdate,
  ): Promise<Array<string | null>> {
    const values = await measureDuplicatePhase(this.metrics, 'proof_read', () =>
      this.redis.getStrings(content.media.map((media) => this.cacheKey(media.identity, update))),
    );
    return values.map((raw, index) => {
      const parsed = raw && raw.length < 512 ? hashSchema.safeParse(safeJson(raw)) : null;
      if (parsed?.success)
        this.metrics?.record(
          content.media[index]!.kind === 'photo'
            ? 'media.proof_reused_image'
            : 'media.proof_reused_binary',
        );
      return parsed?.success &&
        (content.media.length !== 1 ||
          content.media[index]!.kind !== 'photo' ||
          parsed.data.recompressionHash)
        ? parsed.data.hash
        : null;
    });
  }

  private async hashMedia(
    content: DuplicateMessageContent,
    update: MaxUpdate,
    ttl: number,
    deadlineAtMs: number,
    botId: string,
    cachedHashes?: readonly (string | null)[],
    budget = { remaining: MAX_UNCACHED_MEDIA_PER_ATTEMPT },
    receiptId = update.updateId,
    refreshedPhotoSources?: Map<string, DuplicateMessageContent | null>,
  ): Promise<{ content: DuplicateMessageContent; hashes: string[]; recompressionHash?: string }> {
    const originalMedia = content.media;
    const hashes = cachedHashes ? [...cachedHashes] : await this.readHashes(content, update);
    const recompressionHashes = new Map<number, string>();
    if (content.media.length === 1 && content.media[0]?.kind === 'photo') {
      const raw = await this.redis.getString(this.cacheKey(content.media[0].identity, update));
      const parsed = raw && raw.length < 2048 ? hashSchema.safeParse(safeJson(raw)) : null;
      if (parsed?.success && parsed.data.recompressionHash)
        recompressionHashes.set(0, parsed.data.recompressionHash);
    }
    const missing = hashes.filter((hash) => hash === null).length;
    if (missing > budget.remaining || Date.now() >= deadlineAtMs) {
      this.metrics?.record('media.budget_deferred');
      throw new MessageDuplicateMediaDeferredError('proof_budget');
    }
    budget.remaining -= missing;
    // FLAG: A partial outer hash cache cannot exempt album members from byte/pixel
    // accounting. Revalidate the whole album through its resumable, cost-bearing proofs.
    const photoIndexes = content.media
      .map((media, index) => (media.kind === 'photo' ? index : -1))
      .filter((index) => index >= 0);
    if (photoIndexes.some((index) => !hashes[index])) {
      const message = update.message!;
      const fingerprint = () =>
        this.photos.fingerprintAlbum(
          {
            receiptId,
            chatId: message.chatId,
            messageId: message.messageId,
            senderId: message.senderId,
            createdAtMs: Date.parse(message.createdAt),
            caption: content.text,
            images: photoIndexes.map((index) => ({
              source: 'direct' as const,
              photoId: content.media[index]!.photoId,
              downloadUrl: content.media[index]!.url,
            })),
          },
          ttl,
          deadlineAtMs,
          content.media.length === 1,
        );
      let result;
      try {
        result = await fingerprint();
      } catch (error) {
        this.recordSourceRejection(error);
        if (
          !(error instanceof PhotoDownloadSourceRejectedError) &&
          (!(error instanceof PhotoDownloadHttpError) ||
            ![403, 404, 410].includes(error.statusCode))
        )
          throw error;
      }
      if (!result || (result.kind === 'incomplete' && result.reason === 'missing_download_url')) {
        refreshedPhotoSources?.set(receiptId, null);
        content = await this.refreshPhotoSources(content, update, botId, deadlineAtMs);
        refreshedPhotoSources?.set(receiptId, content);
        try {
          result = await fingerprint();
        } catch (error) {
          this.recordSourceRejection(error);
          throw error;
        }
      }
      if (result.kind !== 'complete') {
        if (result.reason === 'decode_capacity_exceeded') {
          this.recordMediaFailure(new MessageDuplicateMediaRejectedError(result.reason));
          throw new MessageDuplicateMediaDeferredError('decode_capacity');
        }
        if (result.reason === 'decode_deadline_exceeded') {
          this.recordMediaFailure(new MessageDuplicateMediaRejectedError(result.reason));
          throw new MessageDuplicateMediaDeferredError('proof_budget');
        }
        throw new MessageDuplicateMediaRejectedError(result.reason);
      }
      photoIndexes.forEach((index, position) => {
        hashes[index] = result.fingerprint.images[position]!.canonicalHash;
        const candidateHash = result.fingerprint.images[position]!.recompressionHash;
        if (candidateHash) recompressionHashes.set(index, candidateHash);
      });
    }
    for (let index = 0; index < content.media.length; index += 1) {
      if (Date.now() >= deadlineAtMs) throw new MessageDuplicateMediaDeferredError('proof_budget');
      const media = content.media[index]!;
      if (!hashes[index]) {
        if (!media.url) throw new MessageDuplicateMediaRejectedError('missing_download_url');
        const downloaded = await measureDuplicatePhase(this.metrics, 'download', () =>
          measureDuplicatePhase(this.metrics, 'binary_download', () =>
            this.binary.downloadBinary(media.url!, { deadlineAtMs }),
          ),
        ).catch((error: unknown) => {
          this.recordSourceRejection(error);
          if (error instanceof PhotoDownloadTimeoutError && Date.now() >= deadlineAtMs)
            throw new MessageDuplicateMediaDeferredError('proof_budget');
          throw error;
        });
        if (Date.now() >= deadlineAtMs)
          throw new MessageDuplicateMediaDeferredError('proof_budget');
        await this.verifyBinary(downloaded.bytes, media.kind);
        hashes[index] = createHash('sha256').update(downloaded.bytes).digest('hex');
      }
      // FLAG: Source refresh validates the same photo within this exact message/revision. Keep
      // its proof reachable from the durable webhook's original URL as well as the refreshed URL.
      const cacheKeys = new Set([
        this.cacheKey(originalMedia[index]!.identity, update),
        this.cacheKey(media.identity, update),
      ]);
      for (const key of cacheKeys) {
        await this.redis.setStringWithTtl(
          key,
          JSON.stringify({
            version: MESSAGE_DUPLICATE_MEDIA_VERSION,
            hash: hashes[index],
            ...(recompressionHashes.has(index)
              ? { recompressionHash: recompressionHashes.get(index) }
              : {}),
          }),
          ttl,
        );
      }
    }
    return {
      content,
      hashes: hashes as string[],
      ...(content.media.length === 1 && recompressionHashes.has(0)
        ? { recompressionHash: recompressionHashes.get(0) }
        : {}),
    };
  }

  private async rememberRecompression(
    scope: string,
    webhookEventId: string,
    source: NonNullable<Awaited<ReturnType<MessageDuplicateMediaService['loadSource']>>>,
    verified: { hashes: string[]; content: DuplicateMessageContent },
    hash: string,
    windowSec: number,
  ): Promise<void> {
    const publishedAtMs = duplicatePublicationTime(source.update);
    if (!publishedAtMs || verified.hashes.length !== 1) return;
    // FLAG: Image identity includes its actions. Equal pixels with different buttons
    // establish separate originals, including when either copy is recompressed.
    const imageScope = digestDuplicateContent([scope, verified.content.actions]);
    await this.recompressionIndex.remember(imageScope, {
      webhookEventId,
      messageId: source.update.message!.messageId,
      eventTimestampMs: source.eventTimestampMs,
      publishedAtMs,
      expiresAtMs: publishedAtMs + windowSec * 1000,
      canonicalHash: verified.hashes[0]!,
      recompressionHash: hash,
    });
  }

  private async findRecompression(input: {
    scope: string;
    job: MessageDuplicateJob;
    source: NonNullable<Awaited<ReturnType<MessageDuplicateMediaService['loadSource']>>>;
    settings: ChatSettings;
    verified: { hashes: string[]; content: DuplicateMessageContent };
    hash: string;
    deadlineAtMs: number;
    budget: { remaining: number };
    lease: PhotoDuplicateOrderingLease;
    heavyWorkAdmitted: boolean;
    refreshedPhotoSources: Map<string, DuplicateMessageContent | null>;
  }): Promise<{
    unverified: boolean;
    anchor?: MessageDuplicateRecompressionCandidate;
    proof?: PhotoRecompressionProof;
    original?: MessageDuplicateOriginal;
  }> {
    const imageScope = digestDuplicateContent([input.scope, input.verified.content.actions]);
    const candidates = (
      await this.recompressionIndex.read(imageScope, input.hash, input.job.eventTimestampMs)
    ).filter((candidate) => {
      let distance = BigInt(`0x${candidate.recompressionHash}`) ^ BigInt(`0x${input.hash}`);
      let differentBits = 0;
      while (distance) {
        differentBits += 1;
        distance &= distance - 1n;
      }
      return differentBits <= 6;
    });
    // FLAG: Prefer an exact verified raster before spending the bounded pair attempts.
    // Keep source, accepted-original and lifecycle checks for every selected candidate.
    const orderedCandidates = [
      ...candidates.filter((candidate) => candidate.canonicalHash === input.verified.hashes[0]),
      ...candidates.filter((candidate) => candidate.canonicalHash !== input.verified.hashes[0]),
    ];
    let unverified = candidates.length > 4;
    for (const candidate of orderedCandidates.slice(0, 4)) {
      input.lease.assertOwned();
      if (candidate.messageId === input.job.messageId) continue;
      if (Date.now() >= input.deadlineAtMs)
        throw new MessageDuplicateMediaDeferredError('proof_budget');
      const baseline = await this.loadSource(candidate.webhookEventId);
      const message = baseline?.update.message;
      if (!baseline || !message) {
        unverified = true;
        continue;
      }
      const content = extractDuplicateMessageContent(baseline.update.raw);
      if (
        !isExactImageContent(content) ||
        content.media.length !== 1 ||
        digestDuplicateContent(content.actions) !==
          digestDuplicateContent(input.verified.content.actions) ||
        message.chatId !== input.job.chatId ||
        message.messageId !== candidate.messageId ||
        (input.settings.duplicatePhotoScope !== 'CHAT' &&
          message.senderId !== input.source.update.message!.senderId) ||
        baseline.eventTimestampMs !== candidate.eventTimestampMs ||
        duplicatePublicationTime(baseline.update) !== candidate.publishedAtMs ||
        candidate.expiresAtMs <= input.job.eventTimestampMs
      ) {
        unverified = true;
        continue;
      }
      let proof: PhotoRecompressionProof | undefined;
      if (candidate.canonicalHash !== input.verified.hashes[0]) {
        if (input.budget.remaining < 2)
          throw new MessageDuplicateMediaDeferredError('proof_budget');
        if (
          input.refreshedPhotoSources.get(candidate.webhookEventId) === null ||
          input.refreshedPhotoSources.get(input.job.webhookEventId) === null
        ) {
          unverified = true;
          continue;
        }
        let originalContent = input.refreshedPhotoSources.get(candidate.webhookEventId) ?? content;
        let currentContent =
          input.refreshedPhotoSources.get(input.job.webhookEventId) ?? input.verified.content;
        const assertPairBudget = () => {
          input.lease.assertOwned();
          if (Date.now() >= input.deadlineAtMs || input.budget.remaining < 2)
            throw new MessageDuplicateMediaDeferredError('proof_budget');
        };
        const refreshSource = async (
          receiptId: string,
          source: typeof input.source,
          original: DuplicateMessageContent,
        ) => {
          assertPairBudget();
          if (input.refreshedPhotoSources.has(receiptId)) {
            const refreshed = input.refreshedPhotoSources.get(receiptId);
            if (!refreshed) throw new MessageDuplicateMediaRejectedError('source_unavailable');
            return refreshed;
          }
          // FLAG: Each immutable receipt gets at most one exact source refresh per attempt,
          // including earlier fingerprint work. A failed refresh cannot repeat across candidates.
          input.refreshedPhotoSources.set(receiptId, null);
          const refreshed = await this.refreshPhotoSources(
            original,
            source.update,
            source.botId,
            input.deadlineAtMs,
          );
          assertPairBudget();
          input.refreshedPhotoSources.set(receiptId, refreshed);
          return refreshed;
        };
        let renewed = false;
        let result: PhotoRecompressionProof | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            if (attempt === 1 || !originalContent.media[0]?.url || !currentContent.media[0]?.url) {
              renewed = true;
              originalContent = await refreshSource(candidate.webhookEventId, baseline, content);
              currentContent = await refreshSource(
                input.job.webhookEventId,
                input.source,
                input.verified.content,
              );
            }
            const originalUrl = originalContent.media[0]?.url;
            const currentUrl = currentContent.media[0]?.url;
            if (!originalUrl || !currentUrl) {
              unverified = true;
              break;
            }
            assertPairBudget();
            if (!input.heavyWorkAdmitted) {
              await this.admitHeavyWork(input.job, input.deadlineAtMs);
              input.heavyWorkAdmitted = true;
            }
            assertPairBudget();
            input.budget.remaining -= 2;
            // FLAG: Renewed locators grant no equality. Both downloads must retain the exact
            // canonical hashes proved before renewal; neither the anchor nor its expiry changes.
            result = await this.photos.verifyRecompression({
              originalUrl,
              currentUrl,
              expectedOriginalHash: candidate.canonicalHash,
              expectedCurrentHash: input.verified.hashes[0]!,
              deadlineAtMs: input.deadlineAtMs,
            });
            input.lease.assertOwned();
            if (Date.now() >= input.deadlineAtMs)
              throw new MessageDuplicateMediaDeferredError('proof_budget');
            break;
          } catch (error) {
            this.recordSourceRejection(error);
            const unavailableSource =
              error instanceof PhotoDownloadSourceRejectedError ||
              (error instanceof PhotoDownloadHttpError &&
                [403, 404, 410].includes(error.statusCode));
            if (unavailableSource && !renewed) continue;
            // FLAG: Missing/changed sources and unsupported approximate pairs leave a coverage
            // gap. They cannot authorize deletion or disprove independent exact comparison.
            if (
              unavailableSource ||
              error instanceof MessageDuplicateMediaRejectedError ||
              (error instanceof PhotoFingerprintRejectedError &&
                !['decode_deadline_exceeded', 'decode_capacity_exceeded'].includes(error.reason))
            ) {
              unverified = true;
              break;
            }
            throw error;
          }
        }
        if (!result) continue;
        proof = result;
      }
      // FLAG: Establish the original's own exact history before attaching a verified
      // copy. Its revision/window remains authoritative; a removed source cannot revive.
      const originalInput = {
        content,
        chatId: input.job.chatId,
        userId: message.senderId,
        messageId: message.messageId,
        eventTimestampMs: baseline.eventTimestampMs,
        publishedAtMs: candidate.publishedAtMs,
        controlRevision: input.job.controlRevision,
        settings: input.settings,
        mediaHashes: [candidate.canonicalHash],
        imageScope: input.settings.duplicatePhotoScope,
      };
      const original = await this.history.observeWithOutcome(originalInput);
      if (
        original.outcome === 'STALE' ||
        original.outcome === 'CONTENT_UNVERIFIED' ||
        original.outcome === 'SCHEDULE_CLOSED'
      ) {
        unverified = true;
        continue;
      }
      const accepted = await this.history.findImageOriginal({
        ...originalInput,
        eventTimestampMs: input.job.eventTimestampMs,
      });
      if (
        accepted?.mediaHashes.length !== 1 ||
        accepted.mediaHashes[0] !== candidate.canonicalHash
      ) {
        unverified = true;
        continue;
      }
      return { unverified, anchor: candidate, ...(proof ? { proof, original: accepted } : {}) };
    }
    return { unverified };
  }

  private recordSourceRejection(error: unknown): void {
    if (error instanceof PhotoDownloadSourceRejectedError)
      this.metrics?.record(PHOTO_SOURCE_REJECTION_METRICS[error.reason]);
  }

  private async refreshPhotoSources(
    content: DuplicateMessageContent,
    update: MaxUpdate,
    botId: string,
    deadlineAtMs: number,
  ): Promise<DuplicateMessageContent> {
    const message = update.message!;
    const timeoutMs = Math.min(5000, deadlineAtMs - Date.now());
    if (timeoutMs <= 0) throw new MessageDuplicateMediaDeferredError('proof_budget');
    let raw: Record<string, unknown> | null;
    try {
      raw = await this.max.getExactMessageRow(message.chatId, message.messageId, {
        botId,
        timeoutMs,
        bypassCache: true,
        trafficClass: 'background',
        sourceTag: 'message_duplicate_media',
      });
    } catch (error: unknown) {
      const status = extractHttpStatusCode(error);
      if (isMaxMutationOutcomeAmbiguous(error) || (status !== 403 && status !== 404)) throw error;
      if (this.executionReadiness) {
        await this.resolveStageExecutor({
          chatId: message.chatId,
          preferredBotId: botId,
          force: true,
        });
        // Retry the same source/revision under its existing deadline and ordering claim.
        throw new MessageDuplicateMediaDeferredError('proof_budget', 1000);
      }
      // FLAG: An inaccessible source proves neither absence nor equality. Reject this receipt's
      // evidence so an old baseline cannot block later verified media; never authorize an action.
      throw new MessageDuplicateMediaRejectedError('source_unavailable');
    }
    const current = raw
      ? new WebhookParser().parse({
          type: 'message_created',
          updateId: 'photo-source-refresh',
          message: raw,
        }).message
      : null;
    const fresh = extractDuplicateMessageContent(raw, false);
    if (!current) throw new MessageDuplicateMediaRejectedError('source_unavailable');
    if (
      current.chatId !== message.chatId ||
      current.messageId !== message.messageId ||
      current.senderId !== message.senderId ||
      current.entityType === 'channel' ||
      !canRefreshDuplicatePhotoSources(content, fresh, true)
    ) {
      throw new MessageDuplicateMediaRejectedError('source_changed');
    }
    return fresh;
  }

  protected async verifyBinary(bytes: Buffer, kind: string): Promise<void> {
    const runtime = requireFromHere('file-type/core') as {
      fileTypeFromBuffer(bytes: Uint8Array): Promise<{ mime: string; ext: string } | undefined>;
    };
    const format = await runtime.fileTypeFromBuffer(bytes);
    if (
      !format ||
      (kind === 'video' && !format.mime.startsWith('video/')) ||
      (kind === 'audio' && !format.mime.startsWith('audio/') && format.ext !== 'mp4')
    ) {
      // FLAG: Retrying these same bytes cannot prove their format. A rejected baseline must not
      // prevent the current verifiable message from becoming the next candidate.
      throw new MessageDuplicateMediaRejectedError('format');
    }
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
