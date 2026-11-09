import { lockVkSyncLease, VkSyncLeaseLostError, type VkSyncLease } from './vk-sync-lease';
import {
  publishVkParsingPostRequestSchema,
  publishVkParsingPostResultSchema,
  rollbackVkParsingResultSchema,
  retryVkParsingPostResultSchema,
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH,
  VK_PARSING_MAX_LINKS,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_PUBLISH_TEXT_LENGTH,
  type PublishVkParsingPostResult,
  type RollbackVkParsingRequest,
  type RollbackVkParsingResult,
  type RetryVkParsingPostResult,
  type VkParsingDryRunResult,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import {
  EmptyResponseBodyError,
  readBoundedResponseBuffer,
  ResponseByteLimitExceededError,
} from '../common/bounded-response-buffer';
import { fetchPublicHttpsMedia, PublicHttpsMediaError } from '../common/public-https-media';
import {
  MediaByteAdmission,
  MediaByteAdmissionError,
  type MediaBytePermit,
} from '../common/media-byte-admission';
import {
  containsSupportedMarkdownUrl,
  renderSupportedMarkdownAsHtml,
} from '../common/max-markdown.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxAttachmentPayload,
  type MaxApiTrafficClass,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import { MAX_VIDEO_UPLOAD_MAX_BYTES } from '../max/max-video-upload.constants';
import {
  MaxRoutedPublicationService,
  type MaxRoutedPublicationResult,
} from '../max/max-routed-publication.service';
import {
  ChatEntityType,
  Prisma,
  PublicationDispatchProfile,
  VkParsingOwnerProfile,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import { isPublisherManagedEntityActivationRequired } from '../publisher/publisher-entity-connection.util';
import {
  PublisherDispatchHealthService,
  type PublisherFailureClassification,
} from '../publisher/publisher-dispatch-health.service';
import {
  PublisherReadinessService,
  type PublisherReadyRoute,
} from '../publisher/publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import {
  resolveNewPublicationDispatchRoute,
  type PublisherDispatchRoute,
} from '../publisher/publisher-route';
import {
  BackgroundRuntimeGovernorService,
  type BackgroundRuntimeGovernorDecision,
} from '../system/background-runtime-governor.service';
import {
  BROADCAST_VIDEO_SEND_RETRY_DELAYS_MS,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
  CHAT_DIALOG_ACTION_AUTO_ATTACH,
} from './admin.service.support';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { buildVkAutoPublishScheduleFingerprint } from './vk-autopublish-policy';
import {
  buildVkBotReviewFingerprint,
  isVkManualReviewMode,
  VK_BOT_REVIEW_MODE,
  vkBotReviewSnapshotSchema,
  type VkBotReviewSnapshot,
} from './vk-bot-review-protocol';
import {
  getVkAutoPublishLocalDayRange,
  planVkAutoPublishSourceSlots,
  projectVkAutoPublishSourceQuotaSlots,
  resolveNextAllowedVkAutoPublishAt,
  resolveVkAutoPublishSourceSpacingMs,
  VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS,
} from './vk-autopublish-timing';
import {
  PublisherDialogContextService,
  type PublisherPreparedDialogContext,
} from './publisher-dialog-context.service';
import {
  isVkMaxSendAmbiguous,
  isVkMaxSendConfirmedPersistencePending,
  VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
} from './vk-publish-quarantine';
import { parseVkWallPostAttachments } from './vk-parsing-attachments';
import {
  computeVkParsingPostContentHash,
  describeVkParsingSkipReason,
  prepareVkParsingPublishPayload,
  resolveEffectiveVkParsingTextFormat,
  resolveVkParsingPostSkipReason,
  VK_POST_SKIP_REASON_NO_SUPPORTED_CONTENT,
  type PreparedVkPublishPayload,
  type VkParsingSkipReason,
} from './vk-parsing-content';
import {
  classifyVkParsingPublishError,
  formatVkParsingClassifiedErrorMessage,
  formatVkParsingError,
  isMaxAttachmentNotReadyError,
} from './vk-parsing-errors';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import {
  type VkParsingOwnerScope,
  VkParsingOwnershipService,
} from './vk-parsing-ownership.service';
import {
  VK_IMAGE_FETCH_TIMEOUT_MS,
  VK_IMAGE_MAX_BYTES,
  VK_MEDIA_STATUS_FAILED,
  VK_MEDIA_STATUS_READY,
  VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD,
  VkParsingMediaCacheService,
  type VkParsingMediaCacheRow,
} from './vk-parsing-media-cache.service';
import {
  VK_PARSING_PUBLISHER_QUEUE,
  VK_PARSING_PUBLISH_RETRY_POLICY,
  type VkParsingPublishReason,
  type VkParsingPublisherJob,
  type VkParsingPublisherPublishJob,
  type VkParsingPublisherRollbackJob,
} from './vk-parsing.queue';

import { buildVkParsingSourceLink } from '@maxim/contracts/vk-parsing';
import {
  vkAutoDeleteCandidatesQuery,
  vkAutoDeletePostSelect,
  VK_AUTO_DELETE_BATCH_SIZE,
  type VkAutoDeleteCursor,
} from './vk-auto-delete';

type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;

type VkParsingSettingsLike = {
  sourceLinkEnabled: boolean;
  sourceLinkUrl: string;
  deleteAfterMinutes: number | null;
  chatId: string;
  autoPublishEnabled: boolean;
  autoPublishEnabledAt: Date | null;
  autoPublishKillSwitchEnabled: boolean;
  stripLinksEnabled: boolean;
  skipAdsEnabled: boolean;
  appendChannelLinkEnabled: boolean;
  channelLinkText: string;
  schedulerTimezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  workHoursStart: string;
  workHoursEnd: string;
  distributeEvenlyEnabled: boolean;
  roundRobinEnabled: boolean;
  circuitBreakerEnabled: boolean;
  circuitBreakerWindowMinutes: number;
  circuitBreakerPostLimit: number;
  updatedAt: Date | null;
};

type VkParsingMaxMessageText = {
  text: string;
  textFormat: MaxSendMessageOptions['textFormat'];
  engagementText: string;
};

type VkParsingStoredDraft = {
  text: string;
  textFormat: 'plain' | 'markdown';
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
};

type VkParsingPhotoPublishMedia = {
  mediaIdentity: string | null;
  candidateUrls: string[];
};

type VkParsingVideoPublishMedia = {
  mediaIdentity: string | null;
  candidateUrls: string[];
};

type VkPublishJobRecoveryOutcome = 'missing' | 'healthy' | 'retried' | 'conflict' | 'failed';
type VkPublishJobEnqueueOutcome = Exclude<VkPublishJobRecoveryOutcome, 'missing'> | 'created';

type VkPublishRecoveryCursor = {
  publishScheduledAt: Date;
  publishQueuedAt: Date;
  updatedAt: Date;
  id: string;
};

type VkParsingDownloadedMedia = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};

type VkPublishIntentRoute = {
  dispatchProfile: PublicationDispatchProfile;
  requiredBotId: string | null;
  dialogBotId: string | null;
  publishDialogContext: PublisherPreparedDialogContext | null;
  publicationPolicyRevision: number | null;
};

type VkParsingPublisherPublishExecution = Omit<VkParsingPublisherPublishJob, 'kind'> & {
  attemptsMade?: number;
  maxAttempts?: number;
};

type VkParsingPublisherRollbackExecution = Omit<VkParsingPublisherRollbackJob, 'kind'> & {
  attemptsMade?: number;
  maxAttempts?: number;
};

export type VkParsingPublishProcessingResult = {
  deferUntil: Date;
};

type VkConfirmedPublishReceipt = {
  messageId: string;
  botId: string;
  url: string | null;
  publishedAtMax: Date;
  autoPublishedAt: Date | null;
  publishedContentHash: string;
  autoDeleteAt: Date | null;
};

class PublisherVkDispatchBlockedError extends Error {
  constructor(
    readonly blockerCode: string,
    readonly cause: unknown,
  ) {
    super(`Publik dispatch is blocked: ${blockerCode}`, { cause });
    this.name = 'PublisherVkDispatchBlockedError';
  }
}

class VkAutoPublishScheduleUnavailableError extends Error {
  constructor() {
    super('Рабочее время полностью перекрыто паузами публикации.');
    this.name = 'VkAutoPublishScheduleUnavailableError';
  }
}

class VkAutoPublishOccupiedSlotScanBudgetExceededError extends Error {
  constructor() {
    super('VK autopublish occupied-slot scan exceeded its bounded page budget.');
    this.name = 'VkAutoPublishOccupiedSlotScanBudgetExceededError';
  }
}

class VkAutoPublishSourceQuotaScanBudgetExceededError extends Error {
  constructor() {
    super('VK autopublish source quota scan exceeded its bounded page budget.');
    this.name = 'VkAutoPublishSourceQuotaScanBudgetExceededError';
  }
}

class VkConfirmedPublishPersistenceError extends Error {
  constructor(
    readonly persistenceCause: unknown,
    readonly receipt: VkConfirmedPublishReceipt,
  ) {
    super('MAX confirmed the VK publication, but its database persistence failed.');
    this.name = 'VkConfirmedPublishPersistenceError';
  }
}

class VkPublishIntentClaimLostError extends Error {
  constructor() {
    super('VK publish intent changed before the MAX send boundary.');
    this.name = 'VkPublishIntentClaimLostError';
  }
}

class VkPublishAttemptPersistenceError extends Error {
  constructor(readonly persistenceCause: unknown) {
    super('VK publish attempt could not be durably recorded before the MAX send boundary.', {
      cause: persistenceCause,
    });
    this.name = 'VkPublishAttemptPersistenceError';
  }
}

class VkPublishExternalGuardError extends Error {
  constructor(readonly guardCause: unknown) {
    super('VK publisher job guard deferred dispatch.', { cause: guardCause });
    this.name = 'VkPublishExternalGuardError';
  }
}

const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_CHANGED_AFTER_PUBLISH = 'CHANGED_AFTER_PUBLISH';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_PUBLISH_MODE_IMMEDIATE = 'IMMEDIATE';
const VK_SOURCE_PUBLISH_MODE_REVIEW = 'REVIEW';
const VK_PUBLISH_JOB_NAME = 'publish-vk-post';
const SAFETY_DESK_ACTOR_USER_ID = 'safety-desk-owner';
const VK_PARSING_SYSTEM_ACTOR_USER_ID = 'vk-parsing-autopost';
const MAX_SEND_AMBIGUOUS_RETRY_BLOCK_MESSAGE =
  'MAX мог уже принять эту публикацию. Сначала сверьте сообщение в MAX вручную; повторная отправка заблокирована.';
const MAX_SEND_CONFIRMED_PERSISTENCE_RETRY_BLOCK_MESSAGE =
  'MAX уже подтвердил эту публикацию, но результат ещё не сохранён. Повторная отправка заблокирована до восстановления.';
const MAX_SEND_ATTEMPT_IN_PROGRESS_BLOCK_MESSAGE =
  'Предыдущая попытка публикации ещё восстанавливается. Новый ключ отправки пока недоступен.';
const VK_PUBLISH_SCHEDULE_DRIFT_TOLERANCE_MS = 5_000;
const VK_AUTOPUBLISH_PAUSE_RETRY_MS = 60_000;
const VK_AUTOPUBLISH_INVALID_SCHEDULE_RETRY_MS = 60 * 60_000;
const VK_AUTOPUBLISH_REPLAN_BATCH_SIZE = 500;
const VK_AUTOPUBLISH_OCCUPIED_SLOT_PAGE_SIZE = 5_000;
const VK_AUTOPUBLISH_OCCUPIED_SLOT_MAX_PAGES = 20;
// FLAG: One missed daily cycle may catch up; older automatic output stays available for admin review.
const VK_AUTOPUBLISH_RECOVERY_FRESHNESS_HORIZON_MS = 24 * 60 * 60_000;
const VK_VIDEO_MAX_BYTES = MAX_VIDEO_UPLOAD_MAX_BYTES;
const VK_VIDEO_FETCH_TIMEOUT_MS = 60_000;
const VK_VIDEO_UPLOAD_TIMEOUT_MS = 120_000;
const VK_MEDIA_ENCODED_BUFFER_BUDGET_BYTES = 768 * 1_024 * 1_024;
const VK_MEDIA_ADMISSION_WAITERS = 32;
const VK_MEDIA_ADMISSION_WAIT_MS = 15_000;
const VK_MEDIA_ADMISSION_DEFER_MS = 2_000;
const VK_ATTACHMENT_SEND_RETRY_DELAYS_MS = [750, 1_500];
const VK_SUPPORTED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

@Injectable()
export class VkPublishService {
  private autoDeleteCursor: VkAutoDeleteCursor | null = null;
  private readonly logger = new Logger(VkPublishService.name);
  private readonly persistedPublishFailures = new WeakSet<object>();
  private readonly publishSourceFences = new Map<string, Promise<void>>();
  private readonly mediaByteAdmission = new MediaByteAdmission(
    VK_MEDIA_ENCODED_BUFFER_BUDGET_BYTES,
    VK_MEDIA_ADMISSION_WAITERS,
  );
  private readonly queueBatchSize: number;
  private readonly publishLeaseTtlMs: number;
  private readonly mediaConcurrency: number;
  private readonly videoFailedPreflightTtlMs: number;
  private readonly newDispatchRoute: PublisherDispatchRoute | null;
  private readonly publisherDispatchConfigured: boolean;
  private duePublishRecoveryCursorId: string | null = null;
  private futurePublishRecoveryCursor: VkPublishRecoveryCursor | null = null;
  private autoPublishScheduleReconcileCursorId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: VkParsingAccessService,
    private readonly maxClient: MaxClientService,
    private readonly mediaCache: VkParsingMediaCacheService,
    private readonly feedService: VkParsingFeedService,
    private readonly configService: ConfigService,
    private readonly ownership: VkParsingOwnershipService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional()
    private readonly maxRoutedPublicationService?: MaxRoutedPublicationService,
    @Optional()
    @InjectQueue(VK_PARSING_PUBLISHER_QUEUE)
    private readonly publisherQueue?: Queue<VkParsingPublisherJob>,
    @Optional()
    private readonly publisherReadinessService?: PublisherReadinessService,
    @Optional()
    private readonly publisherRuntimeBoundaryService?: PublisherRuntimeBoundaryService,
    @Optional()
    private readonly publisherDispatchHealthService?: PublisherDispatchHealthService,
    @Optional()
    private readonly publisherDialogContextService?: PublisherDialogContextService,
    @Optional()
    private readonly storageRuntimeMetrics?: StorageRuntimeMetricsService,
  ) {
    this.newDispatchRoute = resolveNewPublicationDispatchRoute(configService);
    this.publisherDispatchConfigured = configService.get<boolean>(
      'MAX_PUBLISHER_DISPATCH_ENABLED',
      false,
    );
    this.queueBatchSize = configService.get<number>('VK_PARSING_QUEUE_BATCH_SIZE') ?? 100;
    this.publishLeaseTtlMs =
      configService.get<number>('VK_PARSING_PUBLISH_LEASE_TTL_MS') ??
      configService.get<number>('VK_PARSING_LEASE_TTL_MS') ??
      120_000;
    this.mediaConcurrency = configService.get<number>('VK_PARSING_MEDIA_CONCURRENCY') ?? 3;
    this.videoFailedPreflightTtlMs = Math.min(
      configService.get<number>('VK_PARSING_MEDIA_PREFLIGHT_TTL_MS') ?? 86_400_000,
      configService.get<number>('VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS') ?? 120_000,
    );
    this.storageRuntimeMetrics?.registerVkMediaAdmissionSnapshot(() =>
      this.getMediaByteAdmissionSnapshot(),
    );
  }

  onModuleDestroy(): void {
    this.mediaByteAdmission.close();
  }

  getMediaByteAdmissionSnapshot() {
    return this.mediaByteAdmission.getSnapshot();
  }

  async assertChannelLinkAvailable(
    chatId: string,
    trafficClass: MaxApiTrafficClass = 'interactive',
  ): Promise<void> {
    const publisherBotId = this.newDispatchRoute?.requiredBotId?.trim() ?? '';
    if (!publisherBotId) {
      throw new ServiceUnavailableException('Публик не настроен для получения ссылки канала.');
    }
    await this.resolveChannelLink(chatId, trafficClass, publisherBotId);
  }

  async reconcileAutoPublishSchedules(
    params: { chatId?: string; sourceIds?: readonly string[]; force?: boolean } = {},
  ): Promise<number> {
    if (!this.publisherDispatchConfigured || !this.publisherQueue) {
      return 0;
    }

    const ownerScope = this.getPublisherOwnerScope();
    const now = new Date();
    const sourceIds = [...new Set((params.sourceIds ?? []).map((id) => id.trim()).filter(Boolean))];
    const posts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...ownerScope,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: ownerScope.ownerBotId,
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        publishReason: 'autopublish',
        publishQueuedAt: { not: null },
        publishScheduledAt: { not: null },
        publishIdempotencyKey: { not: null },
        publishLockedAt: null,
        publishAttemptCount: 0,
        source: {
          ...ownerScope,
          status: VK_SOURCE_STATUS_ACTIVE,
          importEnabled: true,
          autoPublishEnabled: true,
          autoPublishPausedAt: null,
          publishMode: { notIn: ['REVIEW', VK_BOT_REVIEW_MODE] },
        },
        ...(params.chatId ? { chatId: params.chatId } : {}),
        ...(sourceIds.length > 0 ? { sourceId: { in: sourceIds } } : {}),
        ...(!params.force && this.autoPublishScheduleReconcileCursorId
          ? { id: { gt: this.autoPublishScheduleReconcileCursorId } }
          : {}),
      },
      include: { source: true },
      orderBy: [{ id: 'asc' }],
      take: VK_AUTOPUBLISH_REPLAN_BATCH_SIZE,
    });
    if (!params.force) {
      this.autoPublishScheduleReconcileCursorId =
        posts.length === VK_AUTOPUBLISH_REPLAN_BATCH_SIZE ? (posts.at(-1)?.id ?? null) : null;
    }
    if (posts.length === 0) {
      if (!params.force) {
        this.autoPublishScheduleReconcileCursorId = null;
      }
      return 0;
    }

    const postsByChat = new Map<string, VkParsingPostWithSource[]>();
    for (const post of posts) {
      const chatPosts = postsByChat.get(post.chatId) ?? [];
      chatPosts.push(post);
      postsByChat.set(post.chatId, chatPosts);
    }

    let reconciled = 0;
    for (const [chatId, chatPosts] of postsByChat) {
      const settings = await this.getSettingsForChat(chatId, ownerScope);
      if (!settings.autoPublishEnabled || !settings.autoPublishEnabledAt) {
        continue;
      }
      const freshPosts: VkParsingPostWithSource[] = [];
      for (const post of chatPosts) {
        if (!this.isBeyondAutoPublishRecoveryFreshnessHorizon(post, now)) {
          freshPosts.push(post);
          continue;
        }
        const idempotencyKey = post.publishIdempotencyKey;
        if (
          idempotencyKey &&
          (await this.clearRecoverableQueuedAutoPublishPost(post.id, idempotencyKey, post))
        ) {
          reconciled += 1;
        }
      }
      const fingerprintBySourceId = new Map<string, string>();
      const stalePosts = freshPosts.filter((post) => {
        let fingerprint = fingerprintBySourceId.get(post.sourceId);
        if (!fingerprint) {
          fingerprint = buildVkAutoPublishScheduleFingerprint(settings, post.source);
          fingerprintBySourceId.set(post.sourceId, fingerprint);
        }
        return post.publishScheduleFingerprint !== fingerprint;
      });
      if (stalePosts.length === 0) {
        continue;
      }
      const replannedIds = new Set(stalePosts.map((post) => post.id));
      const occupiedSlots: Date[] = [];
      const postsBySource = new Map<string, VkParsingPostWithSource[]>();
      for (const post of stalePosts) {
        const sourcePosts = postsBySource.get(post.sourceId) ?? [];
        sourcePosts.push(post);
        postsBySource.set(post.sourceId, sourcePosts);
      }

      const sourceGroups = [...postsBySource.values()].sort((left, right) => {
        const priorityRank = { HIGH: 0, NORMAL: 1, LOW: 2 } as const;
        const leftRank = priorityRank[left[0]?.source.priority as keyof typeof priorityRank] ?? 1;
        const rightRank = priorityRank[right[0]?.source.priority as keyof typeof priorityRank] ?? 1;
        return leftRank - rightRank;
      });
      for (const sourcePosts of sourceGroups) {
        sourcePosts.sort((left, right) => {
          const leftAt = left.publishScheduledAt?.getTime() ?? left.createdAt.getTime();
          const rightAt = right.publishScheduledAt?.getTime() ?? right.createdAt.getTime();
          return leftAt - rightAt || left.createdAt.getTime() - right.createdAt.getTime();
        });
        const source = sourcePosts[0]?.source;
        if (!source) {
          continue;
        }
        const fingerprint = fingerprintBySourceId.get(source.id)!;
        const currentTail =
          source.publishMode === VK_SOURCE_PUBLISH_MODE_IMMEDIATE
            ? null
            : await this.prisma.vkParsingPost.aggregate({
                where: {
                  chatId,
                  sourceId: source.id,
                  ...ownerScope,
                  dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
                  requiredBotId: ownerScope.ownerBotId,
                  status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
                  publishReason: 'autopublish',
                  publishQueuedAt: { not: null },
                  publishScheduledAt: { not: null },
                  AND: [
                    {
                      OR: [
                        { publishScheduleFingerprint: fingerprint },
                        { publishAttemptCount: { gt: 0 } },
                      ],
                    },
                  ],
                  id: { notIn: sourcePosts.map((post) => post.id) },
                },
                _max: { publishScheduledAt: true },
              });
        let slots: Date[];
        try {
          slots = await this.planAutoPublishSourceSlots({
            chatId,
            ownerScope,
            excludedPostIds: [...replannedIds],
            count: sourcePosts.length,
            now,
            lastSourceAt: currentTail?._max.publishScheduledAt ?? source.lastAutoPublishedAt,
            reservedChatSlots: occupiedSlots,
            settings,
            source,
          });
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId,
              sourceId: source.id,
              count: sourcePosts.length,
              err: error instanceof Error ? error.message : String(error),
            },
            'Skipped VK autopublish schedule reconciliation because no valid slot was found',
          );
          continue;
        }
        occupiedSlots.push(...slots);

        for (let index = 0; index < sourcePosts.length; index += 1) {
          const post = sourcePosts[index]!;
          const scheduledAt = slots[index]!;
          const currentKey = post.publishIdempotencyKey;
          if (!currentKey || !post.publishScheduledAt) {
            continue;
          }
          if (Math.abs(post.publishScheduledAt.getTime() - scheduledAt.getTime()) <= 1_000) {
            const stamped = await this.prisma.vkParsingPost.updateMany({
              where: {
                id: post.id,
                publishReason: 'autopublish',
                publishIdempotencyKey: currentKey,
                publishScheduledAt: post.publishScheduledAt,
                publishLockedAt: null,
                publishAttemptCount: 0,
                publishScheduleFingerprint: post.publishScheduleFingerprint,
              },
              data: { publishScheduleFingerprint: fingerprint },
            });
            reconciled += stamped.count;
            continue;
          }

          const nextKey = this.buildPublishIdempotencyKey(post, 'autopublish', scheduledAt);
          const updated = await this.prisma.vkParsingPost.updateMany({
            where: {
              id: post.id,
              publishReason: 'autopublish',
              publishIdempotencyKey: currentKey,
              publishScheduledAt: post.publishScheduledAt,
              publishLockedAt: null,
              publishAttemptCount: 0,
              publishScheduleFingerprint: post.publishScheduleFingerprint,
            },
            data: {
              publishScheduledAt: scheduledAt,
              publishIdempotencyKey: nextKey,
              publishScheduleFingerprint: fingerprint,
            },
          });
          if (updated.count === 0) {
            continue;
          }
          reconciled += 1;
          await this.addPublishJob(post, 'autopublish', nextKey, now, scheduledAt);
          await this.removeSupersededPublishJob(post, currentKey, 'autopublish');
        }
      }
    }

    if (posts.length === VK_AUTOPUBLISH_REPLAN_BATCH_SIZE) {
      this.logger.warn(
        { count: posts.length, force: params.force === true },
        'VK autopublish schedule reconciliation reached its bounded batch limit',
      );
    }
    return reconciled;
  }

  async recoverStalePublishJobs(): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.publishLeaseTtlMs);
    if (!this.publisherDispatchConfigured || !this.publisherQueue) {
      this.duePublishRecoveryCursorId = null;
      this.futurePublishRecoveryCursor = null;
      return 0;
    }
    const publisherRecoveryAllowed = await this.isPublisherRecoveryAllowed();
    const posts = publisherRecoveryAllowed
      ? await this.findRecoverableStalePublishPosts(now, staleLockBefore)
      : await this.findConfirmedPersistenceRecoveryPosts(staleLockBefore);
    if (!publisherRecoveryAllowed) {
      this.duePublishRecoveryCursorId = null;
      this.futurePublishRecoveryCursor = null;
    }
    if (posts.length === 0) {
      return 0;
    }

    const settingsByScope = new Map<string, VkParsingSettingsLike>();
    let recovered = 0;
    let expiredAutoPublishRecoveries = 0;
    for (const post of posts) {
      const idempotencyKey = post.publishIdempotencyKey;
      if (!idempotencyKey) {
        continue;
      }
      // FLAG: Legacy rows without an explicit owner are ambiguous. Recovery must leave them
      // untouched for operator review instead of guessing autopublish and changing ownership.
      if (
        post.publishReason !== 'autopublish' &&
        post.publishReason !== 'manual-retry' &&
        post.publishReason !== 'manual-schedule'
      ) {
        this.logger.warn(
          { postId: post.id, chatId: post.chatId, publishReason: post.publishReason },
          'Quarantined VK publish recovery with ambiguous ownership',
        );
        continue;
      }
      const reason = post.publishReason;
      const recoverablePost = post;
      const confirmedPersistencePending = this.isConfirmedPublishPersistencePending(
        recoverablePost.lastError,
      );

      const ownerScope = this.ownerScopeFromRow(recoverablePost);
      let settings: VkParsingSettingsLike | null = null;
      if (!confirmedPersistencePending) {
        const settingsKey = this.ownerScopeKey(recoverablePost.chatId, ownerScope);
        settings = settingsByScope.get(settingsKey) ?? null;
        if (!settings) {
          settings = await this.getSettingsForChat(recoverablePost.chatId, ownerScope);
          settingsByScope.set(settingsKey, settings);
        }
      }

      if (
        reason === 'autopublish' &&
        !confirmedPersistencePending &&
        recoverablePost.publishAttemptCount === 0 &&
        settings &&
        !this.canAutoPublishPost(recoverablePost, settings)
      ) {
        await this.clearRecoverableQueuedAutoPublishPost(
          recoverablePost.id,
          idempotencyKey,
          recoverablePost,
        );
        continue;
      }
      if (
        reason === 'autopublish' &&
        !confirmedPersistencePending &&
        recoverablePost.publishAttemptCount === 0 &&
        settings &&
        !settings.autoPublishKillSwitchEnabled &&
        this.isBeyondAutoPublishRecoveryFreshnessHorizon(recoverablePost, now)
      ) {
        const cleared = await this.clearRecoverableQueuedAutoPublishPost(
          recoverablePost.id,
          idempotencyKey,
          recoverablePost,
        );
        if (cleared) {
          expiredAutoPublishRecoveries += 1;
        }
        continue;
      }

      const outcome = await this.addPublishJob(
        recoverablePost,
        reason,
        idempotencyKey,
        now,
        recoverablePost.publishScheduledAt,
      );
      if (outcome === 'created' || outcome === 'retried') {
        recovered += 1;
      }
    }

    if (expiredAutoPublishRecoveries > 0) {
      this.logger.warn(
        { count: expiredAutoPublishRecoveries },
        'Cleared VK autopublish recoveries beyond the bounded freshness horizon',
      );
    }

    return recovered;
  }

  async recoverStalePublisherRollbackJobs(): Promise<number> {
    if (!(await this.isPublisherRecoveryAllowed())) {
      return 0;
    }
    const staleLockBefore = new Date(Date.now() - this.publishLeaseTtlMs);
    return this.recoverStalePublisherRollbackJobsBefore(staleLockBefore);
  }

  private isBeyondAutoPublishRecoveryFreshnessHorizon(
    post: Pick<VkParsingPostWithSource, 'publishQueuedAt' | 'publishScheduledAt'>,
    now: Date,
  ): boolean {
    const effectiveDueAt = post.publishScheduledAt ?? post.publishQueuedAt;
    return (
      effectiveDueAt !== null &&
      now.getTime() - effectiveDueAt.getTime() > VK_AUTOPUBLISH_RECOVERY_FRESHNESS_HORIZON_MS
    );
  }

  private isBeyondPausedAutoPublishRetention(
    post: Pick<VkParsingPostWithSource, 'publishQueuedAt'>,
    now: Date,
  ): boolean {
    return (
      post.publishQueuedAt !== null &&
      now.getTime() - post.publishQueuedAt.getTime() > VK_AUTOPUBLISH_RECOVERY_FRESHNESS_HORIZON_MS
    );
  }

  private async findRecoverableStalePublishPosts(
    now: Date,
    staleLockBefore: Date,
  ): Promise<VkParsingPostWithSource[]> {
    const publisherOwnerScope = this.getPublisherOwnerScope();
    const ownershipWhere: Prisma.VkParsingPostWhereInput = {
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      ...publisherOwnerScope,
      requiredBotId: publisherOwnerScope.ownerBotId,
      source: publisherOwnerScope,
    };
    const baseWhere: Prisma.VkParsingPostWhereInput = {
      publishQueuedAt: { not: null },
      publishIdempotencyKey: { not: null },
      OR: [{ publishLockedAt: null }, { publishLockedAt: { lt: staleLockBefore } }],
    };
    const recoverableReasonWhere = {
      OR: [
        {
          publishReason: { in: ['manual-retry', 'manual-schedule'] },
          status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        },
        {
          publishReason: 'autopublish',
          status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        },
      ],
    };
    const duePosts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...baseWhere,
        AND: [
          ownershipWhere,
          recoverableReasonWhere,
          {
            OR: [{ publishScheduledAt: null }, { publishScheduledAt: { lte: now } }],
          },
          ...(this.duePublishRecoveryCursorId
            ? [{ id: { gt: this.duePublishRecoveryCursorId } }]
            : []),
        ],
      },
      include: { source: true },
      orderBy: { id: 'asc' },
      take: this.queueBatchSize,
    });
    this.duePublishRecoveryCursorId =
      duePosts.length === this.queueBatchSize ? (duePosts.at(-1)?.id ?? null) : null;
    if (duePosts.length >= this.queueBatchSize) {
      return duePosts;
    }

    const futurePosts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...baseWhere,
        AND: [
          ownershipWhere,
          recoverableReasonWhere,
          ...(this.futurePublishRecoveryCursor
            ? [this.buildFuturePublishRecoveryCursorWhere(this.futurePublishRecoveryCursor)]
            : []),
        ],
        publishScheduledAt: { gt: now },
      },
      include: { source: true },
      orderBy: [
        { publishScheduledAt: 'asc' },
        { publishQueuedAt: 'asc' },
        { updatedAt: 'asc' },
        { id: 'asc' },
      ],
      take: this.queueBatchSize - duePosts.length,
    });
    this.advanceFuturePublishRecoveryCursor(futurePosts, this.queueBatchSize - duePosts.length);
    if (futurePosts.length === 0) {
      return duePosts;
    }

    return [...duePosts, ...futurePosts];
  }

  private async findConfirmedPersistenceRecoveryPosts(
    staleLockBefore: Date,
  ): Promise<VkParsingPostWithSource[]> {
    const ownerScope = this.getPublisherOwnerScope();
    return this.prisma.vkParsingPost.findMany({
      where: {
        ...ownerScope,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: ownerScope.ownerBotId,
        source: ownerScope,
        publishQueuedAt: { not: null },
        publishIdempotencyKey: { not: null },
        publishReason: { in: ['autopublish', 'manual-retry', 'manual-schedule'] },
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        lastError: { startsWith: VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX },
        OR: [{ publishLockedAt: null }, { publishLockedAt: { lt: staleLockBefore } }],
      },
      include: { source: true },
      orderBy: { id: 'asc' },
      take: this.queueBatchSize,
    });
  }

  private async isPublisherRecoveryAllowed(): Promise<boolean> {
    if (
      !this.publisherDispatchConfigured ||
      !this.publisherQueue ||
      !this.publisherDispatchHealthService
    ) {
      return false;
    }
    try {
      return !(await this.publisherDispatchHealthService.isGloballyPaused());
    } catch (error: unknown) {
      this.logger.warn(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Skipped Publik VK recovery because dispatch pause state is unavailable',
      );
      return false;
    }
  }

  private buildFuturePublishRecoveryCursorWhere(
    cursor: VkPublishRecoveryCursor,
  ): Prisma.VkParsingPostWhereInput {
    return {
      OR: [
        { publishScheduledAt: { gt: cursor.publishScheduledAt } },
        {
          publishScheduledAt: cursor.publishScheduledAt,
          publishQueuedAt: { gt: cursor.publishQueuedAt },
        },
        {
          publishScheduledAt: cursor.publishScheduledAt,
          publishQueuedAt: cursor.publishQueuedAt,
          updatedAt: { gt: cursor.updatedAt },
        },
        {
          publishScheduledAt: cursor.publishScheduledAt,
          publishQueuedAt: cursor.publishQueuedAt,
          updatedAt: cursor.updatedAt,
          id: { gt: cursor.id },
        },
      ],
    };
  }

  private advanceFuturePublishRecoveryCursor(
    posts: readonly VkParsingPostWithSource[],
    requestedCount: number,
  ): void {
    const lastPost = posts.at(-1);
    if (
      posts.length < requestedCount ||
      !lastPost?.publishScheduledAt ||
      !lastPost.publishQueuedAt
    ) {
      this.futurePublishRecoveryCursor = null;
      return;
    }
    this.futurePublishRecoveryCursor = {
      publishScheduledAt: lastPost.publishScheduledAt,
      publishQueuedAt: lastPost.publishQueuedAt,
      updatedAt: lastPost.updatedAt,
      id: lastPost.id,
    };
  }

  async prepareBotReviewSnapshot(postId: string): Promise<VkBotReviewSnapshot> {
    const post = await this.prisma.vkParsingPost.findFirst({
      where: {
        id: postId,
        ...this.getPublisherOwnerScope(),
        source: {
          ...this.getPublisherOwnerScope(),
          publishMode: VK_BOT_REVIEW_MODE,
          status: 'ACTIVE',
        },
      },
      include: { source: true },
    });
    if (!post || !['NEW', 'FAILED'].includes(post.status))
      throw new BadRequestException('VK-пост недоступен для согласования.');
    this.assertNoAmbiguousMaxSendQuarantine(post);
    const settings = await this.getSettingsForChat(post.chatId, this.getPublisherOwnerScope());
    const videoUrls = this.readStringArray(post.videoUrls);
    const payload = {
      text: post.text,
      textFormat: resolveEffectiveVkParsingTextFormat(post),
      photoUrls: videoUrls.length ? [] : this.readStringArray(post.photoUrls),
      videoUrls,
      linkUrls: this.readStringArray(post.linkUrls),
    };
    const preserved = { preserveLinkUrls: this.resolveStripPreservedLinkUrls(post) };
    const skip = resolveVkParsingPostSkipReason(
      {
        ...payload,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
      preserved,
    );
    if (skip) throw new BadRequestException(describeVkParsingSkipReason(skip));
    const prepared = prepareVkParsingPublishPayload(payload, settings, preserved);
    this.assertPreparedPublishPayload(prepared);
    const maxMessage = await this.prepareMaxMessageText(
      post.chatId,
      prepared,
      settings,
      'background',
      post.ownerBotId,
      post.url,
    );
    return vkBotReviewSnapshotSchema.parse({
      version: 1,
      fingerprint: buildVkBotReviewFingerprint(post, settings),
      payload: prepared,
      maxMessage,
    });
  }

  async prepareBotReviewMedia(
    postId: string,
    snapshot: VkBotReviewSnapshot,
  ): Promise<MaxSendMessageOptions> {
    const post = await this.prisma.vkParsingPost.findFirst({
      where: { id: postId, ...this.getPublisherOwnerScope() },
    });
    if (!post) throw new NotFoundException('VK-пост не найден.');
    const request = {
      botId: post.ownerBotId,
      trafficClass: 'background' as const,
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
    };
    const reservationBytes = this.resolveEncodedMediaReservation(snapshot.payload);
    let permit: MediaBytePermit | null = null;
    try {
      if (reservationBytes > 0) {
        try {
          // FLAG: Only metadata is retained while admission waits. No raw media is fetched yet.
          permit = await this.mediaByteAdmission.acquire(reservationBytes, {
            deadlineAtMs: Date.now() + VK_MEDIA_ADMISSION_WAIT_MS,
          });
        } catch (error: unknown) {
          if (error instanceof MediaByteAdmissionError) {
            throw new ServiceUnavailableException('Подготовка медиа занята. Повторите позже.');
          }
          throw error;
        }
      }
      if (snapshot.payload.videoUrls.length) {
        const url = snapshot.payload.videoUrls[0]!;
        const payload = await this.downloadAndUploadVideo(
          url,
          request,
          this.resolveVideoMediaIdentityMap(post).get(url) ?? null,
        );
        return {
          textFormat: snapshot.maxMessage.textFormat,
          attachments: [{ type: 'video', payload }],
        };
      }
      const photos = await this.downloadAndUploadImages(
        snapshot.payload.photoUrls,
        request,
        { allowPartialFailures: false, canPublishWithoutPhotos: false },
        this.resolvePhotoMediaIdentityMap(post),
      );
      return {
        textFormat: snapshot.maxMessage.textFormat,
        attachments: photos.map((payload) => ({ type: 'image' as const, payload })),
      };
    } finally {
      permit?.release();
    }
  }

  async publishBotReviewedPost(reviewId: string): Promise<void> {
    const review = await this.prisma.vkBotReview.findFirst({
      where: { id: reviewId, status: 'APPROVED', post: this.getPublisherOwnerScope() },
      include: { post: { include: { source: true } } },
    });
    if (!review) throw new ConflictException('Решение о публикации не найдено.');
    const post = review.post;
    if (post.status === 'PUBLISHED' || post.publishIdempotencyKey) return;
    if (post.status !== 'NEW')
      throw new ConflictException('Публикация требует проверки состояния.');
    const settings = await this.getSettingsForChat(post.chatId, this.getPublisherOwnerScope());
    await this.assertBotReviewApproved(post, settings);
    await this.enqueuePostPublish(post, 'manual-retry', review.decidedAt ?? new Date(), {
      actorUserId: review.recipientUserId,
      botReviewId: review.id,
    });
  }

  private async assertBotReviewApproved(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
  ): Promise<VkBotReviewSnapshot> {
    if (this.configService.get<boolean>('VK_BOT_REVIEW_ENABLED') === false) {
      throw new PublisherVkDispatchBlockedError(
        'vk_bot_review_disabled',
        new Error('VK bot review disabled'),
      );
    }
    const review = await this.prisma.vkBotReview.findUnique({ where: { postId: post.id } });
    const snapshot = vkBotReviewSnapshotSchema.safeParse(review?.snapshot);
    if (
      post.source.publishMode !== VK_BOT_REVIEW_MODE ||
      post.source.status !== 'ACTIVE' ||
      post.status === 'UNAVAILABLE' ||
      review?.status !== 'APPROVED' ||
      !snapshot.success ||
      review.fingerprint !== buildVkBotReviewFingerprint(post, settings) ||
      review.fingerprint !== snapshot.data.fingerprint ||
      review.decidedByUserId !== review.recipientUserId
    ) {
      throw new ConflictException('Пост или настройки изменились. Требуется новое согласование.');
    }
    return snapshot.data;
  }

  async publishPost(
    chatId: string,
    postId: string,
    actorUserId: string,
    body: unknown,
  ): Promise<PublishVkParsingPostResult> {
    const parsed = publishVkParsingPostRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const ownerScope = this.getPublisherOwnerScope();
    const post = await this.prisma.vkParsingPost.findFirst({
      where: { id: postId, chatId, ...ownerScope, source: ownerScope },
      include: { source: true },
    });
    if (!post) {
      throw new NotFoundException('VK-пост не найден.');
    }
    if (post.status === VK_POST_STATUS_PUBLISHED) {
      throw new BadRequestException('Этот VK-пост уже опубликован.');
    }
    this.assertNoAmbiguousMaxSendQuarantine(post);
    this.assertReviewSourceOwnerAction(post, actorUserId);

    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedVideoUrls = this.readStringArray(post.videoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const photoUrls = this.assertSelectedUrls(parsed.data.photoUrls, storedPhotoUrls, 'фото');
    const videoUrls = this.assertSelectedUrls(parsed.data.videoUrls, storedVideoUrls, 'видео');
    const linkUrls = this.assertSelectedUrls(parsed.data.linkUrls, storedLinkUrls, 'ссылку');
    const settings = await this.getSettingsForChat(chatId, ownerScope);
    const preservedLinkUrls = this.resolveStripPreservedLinkUrls(post);
    const storedDraft: VkParsingStoredDraft = {
      text: parsed.data.text,
      textFormat: parsed.data.textFormat,
      photoUrls,
      videoUrls,
      linkUrls,
    };
    const prepared = prepareVkParsingPublishPayload(
      {
        text: parsed.data.text,
        textFormat: parsed.data.textFormat,
        photoUrls,
        videoUrls,
        linkUrls,
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: parsed.data.text,
        photoUrls,
        videoUrls,
        linkUrls,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    if (skipReason) {
      await this.markPostSkipped(post, skipReason);
      throw new BadRequestException(describeVkParsingSkipReason(skipReason));
    }
    this.assertPreparedPublishPayload(prepared);
    if (!this.newDispatchRoute) {
      throw new ServiceUnavailableException('Publik VK dispatch is not configured.');
    }
    const queued = await this.enqueuePostPublish(post, 'manual-retry', new Date(), {
      actorUserId,
      storedDraft,
    });
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId, ...ownerScope, source: ownerScope },
      include: { source: true },
    });
    return publishVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? { ...post, ...storedDraft }),
      queued,
    });
  }

  async retryPost(
    chatId: string,
    postId: string,
    actorUserId?: string,
  ): Promise<RetryVkParsingPostResult> {
    const ownerScope = this.getPublisherOwnerScope();
    const post = await this.prisma.vkParsingPost.findFirst({
      where: { id: postId, chatId, ...ownerScope, source: ownerScope },
      include: { source: true },
    });
    if (!post) {
      throw new NotFoundException('VK-пост не найден.');
    }
    if (post.status === VK_POST_STATUS_PUBLISHED) {
      throw new BadRequestException('Этот VK-пост уже опубликован.');
    }
    if (post.status === VK_POST_STATUS_UNAVAILABLE) {
      throw new BadRequestException('VK-пост недоступен в исходном источнике.');
    }
    this.assertNoAmbiguousMaxSendQuarantine(post);
    this.assertReviewSourceOwnerAction(post, null);

    const queued = await this.enqueuePostPublish(post, 'manual-retry', new Date(), {
      actorUserId,
    });
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId, ...ownerScope, source: ownerScope },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? post),
      queued,
    });
  }

  async schedulePost(
    chatId: string,
    postId: string,
    scheduledAtIso: string,
    actorUserId: string,
  ): Promise<RetryVkParsingPostResult> {
    const ownerScope = this.getPublisherOwnerScope();
    const post = await this.findSchedulablePost(chatId, postId, ownerScope);
    this.assertNoAmbiguousMaxSendQuarantine(post);
    this.assertReviewSourceOwnerAction(post, actorUserId);
    const scheduledAt = new Date(scheduledAtIso);
    if (!Number.isFinite(scheduledAt.getTime())) {
      throw new BadRequestException('Некорректное время публикации.');
    }
    const queued = await this.enqueuePostPublish(post, 'manual-schedule', scheduledAt, {
      actorUserId,
    });
    await this.writeAuditLog(chatId, actorUserId, 'VK_PARSING_SCHEDULE_POST', {
      ...ownerScope,
      postId,
      sourceId: post.sourceId,
      scheduledAt: scheduledAt.toISOString(),
    });
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId, ...ownerScope, source: ownerScope },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? post),
      queued,
    });
  }

  async cancelScheduledPost(
    chatId: string,
    postId: string,
    actorUserId: string,
  ): Promise<RetryVkParsingPostResult> {
    const ownerScope = this.getPublisherOwnerScope();
    const post = await this.findSchedulablePost(chatId, postId, ownerScope);
    this.assertNoAmbiguousMaxSendQuarantine(post);
    const now = new Date();
    const cancelled = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId,
        ...ownerScope,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        publishScheduledAt: post.publishScheduledAt,
        publishIdempotencyKey: post.publishIdempotencyKey,
        publishAttemptCount: post.publishAttemptCount,
        publishCancelledAt: post.publishCancelledAt,
        publishLockedAt: null,
      },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduleFingerprint: null,
        publishCancelledAt: now,
        publishCancelledByUserId: actorUserId,
      },
    });
    if (cancelled.count === 0) {
      throw new BadRequestException('Этот VK-пост уже нельзя отменить.');
    }
    if (
      post.publishIdempotencyKey &&
      (post.publishReason === 'autopublish' ||
        post.publishReason === 'manual-retry' ||
        post.publishReason === 'manual-schedule')
    ) {
      await this.removeSupersededPublishJob(post, post.publishIdempotencyKey, post.publishReason);
    }
    await this.writeAuditLog(chatId, actorUserId, 'VK_PARSING_CANCEL_POST', {
      ...ownerScope,
      postId,
      sourceId: post.sourceId,
    });
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId, ...ownerScope, source: ownerScope },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? post),
      queued: 0,
    });
  }

  async publishPostNow(
    chatId: string,
    postId: string,
    actorUserId: string,
  ): Promise<RetryVkParsingPostResult> {
    const ownerScope = this.getPublisherOwnerScope();
    const post = await this.findSchedulablePost(chatId, postId, ownerScope);
    this.assertNoAmbiguousMaxSendQuarantine(post);
    this.assertReviewSourceOwnerAction(post, actorUserId);
    const queued = await this.enqueuePostPublish(post, 'manual-retry', new Date(), {
      actorUserId,
    });
    await this.writeAuditLog(chatId, actorUserId, 'VK_PARSING_PUBLISH_NOW', {
      ...ownerScope,
      postId,
      sourceId: post.sourceId,
    });
    const updated = await this.prisma.vkParsingPost.findFirst({
      where: { id: post.id, chatId, ...ownerScope, source: ownerScope },
      include: { source: true },
    });
    return retryVkParsingPostResultSchema.parse({
      post: this.feedService.mapPost(updated ?? post),
      queued,
    });
  }

  async dryRunAutoPublish(chatId: string, query: unknown): Promise<VkParsingDryRunResult> {
    const sourceId =
      this.asRecord(query)?.sourceId && typeof this.asRecord(query)?.sourceId === 'string'
        ? String(this.asRecord(query)?.sourceId).trim()
        : null;
    const now = new Date();
    const ownerScope = this.getPublisherOwnerScope();
    const settings = await this.getSettingsForChat(chatId, ownerScope);
    const sources = await this.prisma.vkParsingSource.findMany({
      where: {
        chatId,
        ...ownerScope,
        status: VK_SOURCE_STATUS_ACTIVE,
        ...(sourceId ? { id: sourceId } : {}),
      },
    });
    if (sourceId && sources.length === 0) {
      throw new NotFoundException('VK-источник не найден.');
    }

    let eligibleNow = 0;
    let latestImportedVkPublishedAt: Date | null = null;
    let sourcesWithoutSuccessfulSync = 0;
    let baselineAt: Date | null = settings.autoPublishEnabledAt;
    if (settings.autoPublishEnabled && !settings.autoPublishKillSwitchEnabled) {
      for (const source of sources) {
        if (!source.lastSuccessAt) {
          sourcesWithoutSuccessfulSync += 1;
        }
        const sourceBaseline = this.resolveAutoPublishBaseline(settings, source);
        if (
          !sourceBaseline ||
          !source.autoPublishEnabled ||
          isVkManualReviewMode(source.publishMode)
        ) {
          continue;
        }
        baselineAt =
          baselineAt && baselineAt.getTime() > sourceBaseline.getTime()
            ? baselineAt
            : sourceBaseline;
        const [count, latest] = await Promise.all([
          this.prisma.vkParsingPost.count({
            where: {
              chatId,
              ...ownerScope,
              sourceId: source.id,
              status: VK_POST_STATUS_NEW,
              publishQueuedAt: null,
              publishScheduledAt: null,
              publishLockedAt: null,
              publishAttemptCount: 0,
              publishIdempotencyKey: null,
              publishReason: null,
              publishCancelledAt: null,
              publishScheduleFingerprint: { not: null },
              vkPublishedAt: { gte: sourceBaseline },
            },
          }),
          this.prisma.vkParsingPost.aggregate({
            where: { chatId, sourceId: source.id, status: VK_POST_STATUS_NEW, ...ownerScope },
            _max: { vkPublishedAt: true },
          }),
        ]);
        eligibleNow += count;
        const latestAt = latest._max.vkPublishedAt;
        if (
          latestAt &&
          (!latestImportedVkPublishedAt ||
            latestAt.getTime() > latestImportedVkPublishedAt.getTime())
        ) {
          latestImportedVkPublishedAt = latestAt;
        }
      }
    }

    return {
      chatId,
      sourceId,
      generatedAt: now.toISOString(),
      globalEnabled: settings.autoPublishEnabled,
      killSwitchEnabled: settings.autoPublishKillSwitchEnabled,
      baselineAt: baselineAt ? baselineAt.toISOString() : null,
      eligibleNow,
      latestImportedVkPublishedAt: latestImportedVkPublishedAt
        ? latestImportedVkPublishedAt.toISOString()
        : null,
      sourcesWithoutSuccessfulSync,
    };
  }

  async rollbackAutoPublished(
    chatId: string,
    actorUserId: string,
    request: RollbackVkParsingRequest,
  ): Promise<RollbackVkParsingResult> {
    const since = new Date(request.since);
    const until = new Date(request.until);
    if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime())) {
      throw new BadRequestException('Некорректный период rollback.');
    }
    if (until.getTime() < since.getTime()) {
      throw new BadRequestException('Конец периода раньше начала.');
    }
    const ownerScope = this.getPublisherOwnerScope();
    const posts = await this.prisma.vkParsingPost.findMany({
      where: {
        chatId,
        ...ownerScope,
        source: ownerScope,
        autoPublishedAt: { gte: since, lte: until },
        ...(request.sourceId ? { sourceId: request.sourceId } : {}),
      },
      include: { source: true },
      orderBy: [{ autoPublishedAt: 'desc' }],
      take: 100,
    });

    const deleted = 0;
    let queued = 0;
    let failed = 0;
    if (request.deleteMessages) {
      for (const post of posts) {
        if (!post.publishedMessageId) {
          failed += 1;
          continue;
        }
        try {
          if (post.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
            failed += 1;
            continue;
          }
          if (await this.enqueuePublisherRollback(post)) {
            queued += 1;
          } else {
            failed += 1;
          }
        } catch (error) {
          failed += 1;
          this.logger.warn({ postId: post.id, chatId, err: error }, 'VK rollback delete failed');
        }
      }
    }

    await this.writeAuditLog(chatId, actorUserId, 'VK_PARSING_ROLLBACK', {
      ...ownerScope,
      since: since.toISOString(),
      until: until.toISOString(),
      sourceId: request.sourceId ?? null,
      deleteMessages: request.deleteMessages,
      matched: posts.length,
      deleted,
      queued,
      failed,
    });

    return rollbackVkParsingResultSchema.parse({
      matched: posts.length,
      deleted,
      queued,
      failed,
      posts: posts.map((post) => this.feedService.mapPost(post)),
    });
  }

  async enqueueDueAutoDeletes(): Promise<number> {
    this.assertPublisherRuntimeBeforeClaim();
    const ownerScope = this.getPublisherOwnerScope();
    const now = new Date();
    const candidates = await this.prisma.$queryRaw<VkAutoDeleteCursor[]>(
      vkAutoDeleteCandidatesQuery(ownerScope.ownerBotId, now, this.autoDeleteCursor),
    );
    let queued = 0;
    for (const candidate of candidates) {
      try {
        const post = await this.prisma.vkParsingPost.findFirst({
          where: { id: candidate.id, ...ownerScope, autoDeleteAt: candidate.autoDeleteAt },
          select: vkAutoDeletePostSelect,
        });
        if (
          post &&
          !post.rollbackQueuedAt &&
          (await this.enqueuePublisherRollback(post, candidate.autoDeleteAt))
        )
          queued += 1;
      } catch (error) {
        this.logger.warn({ postId: candidate.id, err: error }, 'VK auto-delete scheduling failed');
      }
      this.autoDeleteCursor = candidate;
    }
    if (candidates.length < VK_AUTO_DELETE_BATCH_SIZE) this.autoDeleteCursor = null;
    return queued;
  }

  private async enqueuePublisherRollback(
    post: Pick<
      VkParsingPostWithSource,
      | 'id'
      | 'chatId'
      | 'ownerProfile'
      | 'ownerBotId'
      | 'dispatchProfile'
      | 'requiredBotId'
      | 'publishedBotId'
      | 'publishedMessageId'
      | 'publishIdempotencyKey'
      | 'publishLockedAt'
      | 'publishQueuedAt'
      | 'publishReason'
      | 'publishScheduledAt'
      | 'rollbackQueuedAt'
      | 'rollbackLockedAt'
      | 'rollbackIdempotencyKey'
      | 'rollbackDeletedAt'
      | 'status'
    >,
    autoDeleteAt?: Date,
  ): Promise<boolean> {
    if (
      post.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      post.ownerProfile !== VkParsingOwnerProfile.PUBLISHER ||
      post.ownerBotId !== post.requiredBotId ||
      !post.requiredBotId?.trim() ||
      post.publishedBotId !== post.requiredBotId ||
      !post.publishedMessageId?.trim() ||
      ![VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_CHANGED_AFTER_PUBLISH].includes(post.status) ||
      post.rollbackDeletedAt ||
      post.publishIdempotencyKey !== null ||
      post.publishLockedAt !== null ||
      post.publishQueuedAt !== null ||
      post.publishReason !== null ||
      post.publishScheduledAt !== null
    ) {
      return false;
    }
    if (!this.publisherQueue) {
      throw new ServiceUnavailableException('Publik VK queue is unavailable.');
    }

    const idempotencyKey = this.buildPublisherRollbackIdempotencyKey(post);
    const queuedAt = new Date();
    if (post.rollbackIdempotencyKey === idempotencyKey && post.rollbackQueuedAt) {
      return this.ensurePublisherRollbackQueueJob({
        kind: 'rollback-delete',
        postId: post.id,
        chatId: post.chatId,
        messageId: post.publishedMessageId,
        requiredBotId: post.requiredBotId,
        idempotencyKey,
        createdAt: post.rollbackQueuedAt.toISOString(),
      });
    }
    if (post.rollbackIdempotencyKey || post.rollbackLockedAt) {
      return false;
    }
    const armed = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId: post.chatId,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: post.requiredBotId,
        requiredBotId: post.requiredBotId,
        publishedBotId: post.requiredBotId,
        publishedMessageId: post.publishedMessageId,
        status: { in: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_CHANGED_AFTER_PUBLISH] },
        publishIdempotencyKey: null,
        publishLockedAt: null,
        publishQueuedAt: null,
        publishReason: null,
        publishScheduledAt: null,
        rollbackDeletedAt: null,
        rollbackLockedAt: null,
        rollbackIdempotencyKey: null,
        ...(autoDeleteAt ? { autoDeleteAt: { equals: autoDeleteAt, lte: queuedAt } } : {}),
      },
      data: {
        rollbackQueuedAt: queuedAt,
        rollbackLockedAt: null,
        rollbackIdempotencyKey: idempotencyKey,
        rollbackLastError: null,
      },
    });
    if (armed.count === 0) {
      return false;
    }

    return this.ensurePublisherRollbackQueueJob({
      kind: 'rollback-delete',
      postId: post.id,
      chatId: post.chatId,
      messageId: post.publishedMessageId,
      requiredBotId: post.requiredBotId,
      idempotencyKey,
      createdAt: queuedAt.toISOString(),
    });
  }

  async processPublisherRollbackJob(params: VkParsingPublisherRollbackExecution): Promise<void> {
    if (params.requiredBotId !== this.getPublisherOwnerScope().ownerBotId) {
      return;
    }
    if (
      params.idempotencyKey !==
      this.buildPublisherRollbackIdempotencyKey({
        id: params.postId,
        publishedMessageId: params.messageId,
        requiredBotId: params.requiredBotId,
      })
    ) {
      return;
    }
    try {
      this.assertPublisherRuntimeBeforeClaim();
      await this.assertPublisherHealthAllowed();
    } catch (error) {
      if (error instanceof PublisherVkDispatchBlockedError) {
        await this.markPublisherRollbackBlocked(params.postId, params.idempotencyKey, null, error);
        return;
      }
      throw error;
    }

    const lockAt = new Date();
    const staleLockBefore = new Date(lockAt.getTime() - this.publishLeaseTtlMs);
    const locked = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: params.postId,
        chatId: params.chatId,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: params.requiredBotId,
        requiredBotId: params.requiredBotId,
        publishedBotId: params.requiredBotId,
        publishedMessageId: params.messageId,
        status: { in: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_CHANGED_AFTER_PUBLISH] },
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        rollbackIdempotencyKey: params.idempotencyKey,
        rollbackQueuedAt: { not: null },
        rollbackDeletedAt: null,
        OR: [{ rollbackLockedAt: null }, { rollbackLockedAt: { lt: staleLockBefore } }],
      },
      data: {
        rollbackLockedAt: lockAt,
        rollbackAttemptCount: { increment: 1 },
      },
    });
    if (locked.count === 0) {
      return;
    }

    try {
      await this.maxClient.deleteMessage(params.chatId, params.messageId, {
        immediate: true,
        botId: params.requiredBotId,
        idempotencyKey: `vk-parsing:publisher-rollback:${params.idempotencyKey}`,
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        beforeImmediateDeleteMutation: async () => {
          this.assertPublisherRuntimeBeforeClaim();
          await this.assertPublisherHealthAllowed();
        },
      });
      await this.recordPublisherSendSuccessSafely(params.chatId, lockAt);
      await this.prisma.vkParsingPost.updateMany({
        where: {
          id: params.postId,
          publishedBotId: params.requiredBotId,
          publishedMessageId: params.messageId,
          status: { in: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_CHANGED_AFTER_PUBLISH] },
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          rollbackIdempotencyKey: params.idempotencyKey,
          rollbackLockedAt: lockAt,
        },
        data: {
          rollbackQueuedAt: null,
          rollbackLockedAt: null,
          rollbackDeletedAt: new Date(),
          rollbackIdempotencyKey: null,
          rollbackLastError: null,
        },
      });
    } catch (error) {
      if (error instanceof PublisherVkDispatchBlockedError) {
        await this.markPublisherRollbackBlocked(
          params.postId,
          params.idempotencyKey,
          lockAt,
          error,
        );
        return;
      }
      const healthClassification = await this.recordPublisherSendFailureSafely(
        params.chatId,
        error,
        lockAt,
      );
      await this.prisma.vkParsingPost.updateMany({
        where: {
          id: params.postId,
          rollbackIdempotencyKey: params.idempotencyKey,
          rollbackLockedAt: lockAt,
        },
        data: {
          rollbackLockedAt: null,
          rollbackLastError: formatVkParsingError(error),
        },
      });
      if (healthClassification === 'global_paused' || healthClassification === 'setup_required') {
        await this.markPublisherRollbackBlocked(
          params.postId,
          params.idempotencyKey,
          null,
          new PublisherVkDispatchBlockedError(
            healthClassification === 'global_paused'
              ? 'publisher_auth_paused'
              : 'publisher_setup_required',
            error,
          ),
        );
        return;
      }
      throw error;
    }
  }

  private async recoverStalePublisherRollbackJobsBefore(staleLockBefore: Date): Promise<number> {
    if (!this.publisherQueue) {
      return 0;
    }
    const publisherOwnerScope = this.getPublisherOwnerScope();
    const posts = await this.prisma.vkParsingPost.findMany({
      where: {
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        ...publisherOwnerScope,
        requiredBotId: publisherOwnerScope.ownerBotId,
        source: publisherOwnerScope,
        status: { in: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_CHANGED_AFTER_PUBLISH] },
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        rollbackQueuedAt: { not: null },
        rollbackIdempotencyKey: { not: null },
        rollbackDeletedAt: null,
        OR: [{ rollbackLockedAt: null }, { rollbackLockedAt: { lt: staleLockBefore } }],
      },
      orderBy: [{ rollbackQueuedAt: 'asc' }, { id: 'asc' }],
      take: this.queueBatchSize,
    });
    let recovered = 0;
    for (const post of posts) {
      if (
        !post.rollbackQueuedAt ||
        !post.rollbackIdempotencyKey ||
        !post.publishedMessageId ||
        !post.requiredBotId ||
        post.ownerBotId !== post.requiredBotId ||
        post.publishedBotId !== post.requiredBotId ||
        post.rollbackIdempotencyKey !== this.buildPublisherRollbackIdempotencyKey(post)
      ) {
        continue;
      }
      const outcome = await this.addPublisherRollbackJob({
        kind: 'rollback-delete',
        postId: post.id,
        chatId: post.chatId,
        messageId: post.publishedMessageId,
        requiredBotId: post.requiredBotId,
        idempotencyKey: post.rollbackIdempotencyKey,
        createdAt: post.rollbackQueuedAt.toISOString(),
      });
      if (outcome === 'created' || outcome === 'retried') {
        recovered += 1;
      }
    }
    return recovered;
  }

  private async addPublisherRollbackJob(
    job: VkParsingPublisherRollbackJob,
  ): Promise<VkPublishJobEnqueueOutcome> {
    if (!this.publisherQueue) {
      return 'failed';
    }
    const jobId = this.buildPublisherRollbackJobId(job.postId, job.idempotencyKey);
    const existing = await this.publisherQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      const matching =
        existing.data.kind === 'rollback-delete' &&
        existing.data.postId === job.postId &&
        existing.data.chatId === job.chatId &&
        existing.data.messageId === job.messageId &&
        existing.data.requiredBotId === job.requiredBotId &&
        existing.data.idempotencyKey === job.idempotencyKey;
      if (!matching && state === 'active') {
        return 'conflict';
      }
      if (!matching || state === 'unknown') {
        await existing.remove();
      } else if (state === 'failed' || state === 'completed') {
        await (
          existing as unknown as {
            updateData(data: VkParsingPublisherRollbackJob): Promise<void>;
          }
        ).updateData(job);
        await existing.retry(state, {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        return 'retried';
      } else {
        return 'healthy';
      }
    }
    await this.publisherQueue.add('rollback-vk-post', job, {
      jobId,
      ...VK_PARSING_PUBLISH_RETRY_POLICY,
    });
    return 'created';
  }

  private async ensurePublisherRollbackQueueJob(
    job: VkParsingPublisherRollbackJob,
  ): Promise<boolean> {
    try {
      const outcome = await this.addPublisherRollbackJob(job);
      if (outcome === 'conflict') {
        await this.prisma.vkParsingPost.updateMany({
          where: { id: job.postId, rollbackIdempotencyKey: job.idempotencyKey },
          data: { rollbackLastError: 'publisher_queue_ownership_conflict' },
        });
        return false;
      }
      if (outcome === 'failed') {
        await this.prisma.vkParsingPost.updateMany({
          where: { id: job.postId, rollbackIdempotencyKey: job.idempotencyKey },
          data: { rollbackLastError: 'publisher_queue_temporarily_unavailable' },
        });
      }
      return true;
    } catch (error) {
      // The armed database row remains the durable source for bounded recovery.
      await this.prisma.vkParsingPost.updateMany({
        where: { id: job.postId, rollbackIdempotencyKey: job.idempotencyKey },
        data: { rollbackLastError: 'publisher_queue_temporarily_unavailable' },
      });
      this.logger.warn(
        { postId: job.postId, chatId: job.chatId, err: error },
        'Publik VK rollback was armed but its queue add needs recovery',
      );
      return true;
    }
  }

  private async markPublisherRollbackBlocked(
    postId: string,
    idempotencyKey: string,
    expectedLockAt: Date | null,
    error: PublisherVkDispatchBlockedError,
  ): Promise<void> {
    await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        rollbackIdempotencyKey: idempotencyKey,
        rollbackLockedAt: expectedLockAt,
      },
      data: {
        rollbackLockedAt: null,
        rollbackLastError: `[publisher.blocked] ${error.blockerCode}`,
      },
    });
  }

  private buildPublisherRollbackIdempotencyKey(
    post: Pick<VkParsingPostWithSource, 'id' | 'publishedMessageId' | 'requiredBotId'>,
  ): string {
    return createHash('sha256')
      .update(`${post.id}:${post.publishedMessageId}:${post.requiredBotId}`)
      .digest('hex')
      .slice(0, 32);
  }

  private buildPublisherRollbackJobId(postId: string, idempotencyKey: string): string {
    return `vk-parsing-rollback__${postId}__${idempotencyKey}`;
  }

  async processPublishPostJob(
    params: VkParsingPublisherPublishExecution,
    beforeDispatch?: () => Promise<void>,
  ): Promise<VkParsingPublishProcessingResult | undefined> {
    if (params.dispatchProfile !== 'PUBLIK_V1' || !params.requiredBotId?.trim()) {
      throw new Error('Publik VK publish execution requires an exact Publisher route');
    }
    const ownerScope = this.getPublisherOwnerScope();
    if (params.requiredBotId !== ownerScope.ownerBotId) {
      return;
    }
    const row = await this.prisma.vkParsingPost.findFirst({
      where: {
        id: params.postId,
        chatId: params.chatId,
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: params.requiredBotId,
        requiredBotId: params.requiredBotId,
      },
      select: { sourceId: true },
    });
    if (!row) {
      return;
    }

    return this.runWithSourcePublishFence(row.sourceId, () =>
      this.processPublishPostJobUnderSourceFence(params, beforeDispatch),
    );
  }

  private async processPublishPostJobUnderSourceFence(
    params: VkParsingPublisherPublishExecution,
    beforeDispatch?: () => Promise<void>,
  ): Promise<VkParsingPublishProcessingResult | undefined> {
    if (params.dispatchProfile !== 'PUBLIK_V1' || !params.requiredBotId?.trim()) {
      throw new Error('Publik VK publish execution requires an exact Publisher route');
    }
    const expectedDispatchProfile = PublicationDispatchProfile.PUBLIK_V1;
    const expectedOwnerScope = {
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: params.requiredBotId,
    } as const;
    if (params.requiredBotId !== this.getPublisherOwnerScope().ownerBotId) {
      return;
    }
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.publishLeaseTtlMs);
    const locked = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: params.postId,
        chatId: params.chatId,
        publishIdempotencyKey: params.idempotencyKey,
        publishReason: params.reason,
        dispatchProfile: expectedDispatchProfile,
        ...expectedOwnerScope,
        requiredBotId: params.requiredBotId,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        OR: [{ publishLockedAt: null }, { publishLockedAt: { lt: staleLockBefore } }],
      },
      data: {
        publishLockedAt: now,
        publishReason: params.reason,
      },
    });
    if (locked.count === 0) {
      return;
    }

    const post = await this.prisma.vkParsingPost.findFirst({
      where: {
        id: params.postId,
        chatId: params.chatId,
        publishIdempotencyKey: params.idempotencyKey,
        publishReason: params.reason,
        dispatchProfile: expectedDispatchProfile,
        ...expectedOwnerScope,
        requiredBotId: params.requiredBotId,
        source: expectedOwnerScope,
      },
      include: { source: true },
    });
    if (
      !post ||
      !this.isExactOwnerScope(post, expectedOwnerScope) ||
      !this.isExactOwnerScope(post.source, expectedOwnerScope) ||
      post.status === VK_POST_STATUS_PUBLISHED
    ) {
      return;
    }
    let publishAttemptsRecorded = 0;
    let mediaPermit: MediaBytePermit | null = null;
    const confirmedPersistencePending = this.isConfirmedPublishPersistencePending(post.lastError);
    try {
      if (confirmedPersistencePending) {
        await this.finalizeConfirmedPublishPersistence(post, params.idempotencyKey, params.reason);
        return;
      }
      if (beforeDispatch) {
        try {
          await beforeDispatch();
        } catch (error: unknown) {
          await this.releaseExactPublishLock(
            post.id,
            params.idempotencyKey,
            params.reason,
            now,
          ).catch((releaseError: unknown) => {
            this.logger.warn(
              { postId: post.id, err: releaseError },
              'Failed to release VK publish lease after a Publisher job guard deferred dispatch',
            );
          });
          throw new VkPublishExternalGuardError(error);
        }
      }
      this.assertPublisherRuntimeBeforeClaim();
      await this.assertPublisherHealthAllowed();
      const settings = await this.getSettingsForChat(post.chatId, this.ownerScopeFromRow(post));
      if (post.source.publishMode === VK_BOT_REVIEW_MODE) {
        await this.assertBotReviewApproved(post, settings);
      }
      if (params.reason === 'autopublish') {
        if (!this.canAutoPublishPost(post, settings)) {
          if (post.publishAttemptCount > 0) {
            const deferUntil = await this.deferQueuedPost(
              post,
              params.reason,
              params.idempotencyKey,
              new Date(now.getTime() + VK_AUTOPUBLISH_INVALID_SCHEDULE_RETRY_MS),
            );
            return deferUntil ? { deferUntil } : undefined;
          }
          await this.clearQueuedAutoPublishPost(post.id, params.idempotencyKey, post);
          return;
        }
        if (
          post.publishAttemptCount === 0 &&
          this.isBeyondAutoPublishRecoveryFreshnessHorizon(post, now)
        ) {
          const cleared = await this.clearQueuedAutoPublishPost(
            post.id,
            params.idempotencyKey,
            post,
          );
          if (cleared) {
            this.logger.warn(
              { postId: post.id, chatId: post.chatId },
              'Cleared historical VK autopublish at the worker boundary',
            );
          }
          return;
        }
        const scheduleFingerprint = buildVkAutoPublishScheduleFingerprint(settings, post.source);
        if (post.publishScheduleFingerprint !== scheduleFingerprint) {
          let replannedAt: Date;
          let preserveIntentKey = false;
          try {
            replannedAt = await this.resolveInitialAutoPublishAt(
              post,
              settings,
              scheduleFingerprint,
            );
          } catch (error) {
            if (!(error instanceof VkAutoPublishScheduleUnavailableError)) {
              throw error;
            }
            replannedAt = new Date(now.getTime() + VK_AUTOPUBLISH_INVALID_SCHEDULE_RETRY_MS);
            preserveIntentKey = true;
          }
          if (replannedAt.getTime() > now.getTime() + 1_000) {
            const deferUntil = await this.deferQueuedPost(
              post,
              params.reason,
              params.idempotencyKey,
              replannedAt,
              scheduleFingerprint,
              preserveIntentKey,
            );
            return deferUntil ? { deferUntil } : undefined;
          }
          const stamped = await this.prisma.vkParsingPost.updateMany({
            where: {
              id: post.id,
              publishIdempotencyKey: params.idempotencyKey,
              publishReason: params.reason,
              publishLockedAt: now,
              publishAttemptCount: post.publishAttemptCount,
              publishScheduleFingerprint: post.publishScheduleFingerprint,
            },
            data: { publishScheduleFingerprint: scheduleFingerprint },
          });
          if (stamped.count === 0) {
            return;
          }
        }
        if (settings.autoPublishKillSwitchEnabled) {
          if (
            post.publishAttemptCount === 0 &&
            this.isBeyondPausedAutoPublishRetention(post, now)
          ) {
            await this.clearQueuedAutoPublishPost(post.id, params.idempotencyKey, post);
            return;
          }
          const deferUntil = await this.deferQueuedPost(
            post,
            params.reason,
            params.idempotencyKey,
            new Date(now.getTime() + VK_AUTOPUBLISH_PAUSE_RETRY_MS),
          );
          return deferUntil ? { deferUntil } : undefined;
        }
        const governorDecision = await this.decideBackgroundAutoPublish();
        if (governorDecision?.action === 'pause') {
          const deferUntil = await this.deferQueuedPost(
            post,
            params.reason,
            params.idempotencyKey,
            new Date(now.getTime() + governorDecision.retryAfterMs),
          );
          return deferUntil ? { deferUntil } : undefined;
        }
      }

      if (params.reason === 'autopublish') {
        let deferredUntil: Date;
        let preserveIntentKey = false;
        try {
          deferredUntil = await this.resolveDeferredPublishAt(post, settings, now);
        } catch (error) {
          if (!(error instanceof VkAutoPublishScheduleUnavailableError)) {
            throw error;
          }
          deferredUntil = new Date(now.getTime() + VK_AUTOPUBLISH_INVALID_SCHEDULE_RETRY_MS);
          preserveIntentKey = true;
        }
        if (deferredUntil.getTime() > now.getTime() + 1_000) {
          const deferUntil = await this.deferQueuedPost(
            post,
            params.reason,
            params.idempotencyKey,
            deferredUntil,
            buildVkAutoPublishScheduleFingerprint(settings, post.source),
            preserveIntentKey,
          );
          return deferUntil ? { deferUntil } : undefined;
        }
      }
      if (
        params.reason === 'manual-schedule' &&
        post.publishScheduledAt &&
        post.publishScheduledAt.getTime() > now.getTime() + 1_000
      ) {
        const deferUntil = await this.deferQueuedPost(
          post,
          params.reason,
          params.idempotencyKey,
          post.publishScheduledAt,
        );
        return deferUntil ? { deferUntil } : undefined;
      }
      await this.assertPublisherIntentReady(post);
      const reservationBytes = this.resolveEncodedMediaReservation({
        photoUrls: this.readStringArray(post.photoUrls),
        videoUrls: this.readStringArray(post.videoUrls),
      });
      if (reservationBytes > 0) {
        mediaPermit = this.mediaByteAdmission.tryAcquire(reservationBytes);
        if (!mediaPermit) {
          // FLAG: Memory pressure is a pre-dispatch deferral, never a failed attempt.
          // Preserve the exact MAX intent even when no durable send has happened yet.
          const deferUntil = await this.deferQueuedPost(
            post,
            params.reason,
            params.idempotencyKey,
            new Date(Date.now() + VK_MEDIA_ADMISSION_DEFER_MS),
            undefined,
            true,
          );
          return deferUntil ? { deferUntil } : undefined;
        }
      }
      const clearedBlocker = await this.prisma.vkParsingPost.updateMany({
        where: {
          id: post.id,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: post.requiredBotId,
          publishIdempotencyKey: params.idempotencyKey,
          publishReason: params.reason,
          publishLockedAt: post.publishLockedAt,
          publishAttemptCount: post.publishAttemptCount,
          lastError: post.lastError,
        },
        data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
      });
      if (clearedBlocker.count === 0) {
        return;
      }
      return await this.publishQueuedPost(
        post,
        settings,
        params.reason,
        params.idempotencyKey,
        () => {
          publishAttemptsRecorded += 1;
        },
      );
    } catch (error) {
      if (error instanceof VkPublishExternalGuardError) {
        throw error.guardCause;
      }
      if (error instanceof VkPublishIntentClaimLostError) {
        return;
      }
      if (error instanceof VkConfirmedPublishPersistenceError || confirmedPersistencePending) {
        await this.markConfirmedPublishPersistencePending(
          post,
          params.idempotencyKey,
          params.reason,
          error,
        );
        throw error;
      }
      if (error instanceof PublisherVkDispatchBlockedError) {
        await this.markPublisherIntentBlocked(
          post,
          params.idempotencyKey,
          params.reason,
          error.blockerCode,
          post.publishAttemptCount + publishAttemptsRecorded,
        );
        return;
      }
      if (!this.isPublishFailurePersisted(error)) {
        const classified = classifyVkParsingPublishError(
          error instanceof VkPublishAttemptPersistenceError ? error.persistenceCause : error,
        );
        const durableAttemptCount = post.publishAttemptCount + publishAttemptsRecorded;
        const finalAttempt = this.isFinalPublishAttempt(params, durableAttemptCount);
        const preserveIntent =
          error instanceof VkPublishAttemptPersistenceError ||
          (classified.retryable && finalAttempt && durableAttemptCount > 0);
        const deferUntil =
          preserveIntent && finalAttempt
            ? new Date(Date.now() + VK_AUTOPUBLISH_INVALID_SCHEDULE_RETRY_MS)
            : null;
        const persistedDeferUntil = await this.markQueuedPostPublishFailed(post, classified, {
          auto: params.reason === 'autopublish',
          attemptCountUncertain: error instanceof VkPublishAttemptPersistenceError,
          durableAttemptCount,
          finalAttempt,
          idempotencyKey: params.idempotencyKey,
          preserveIntent,
          reason: params.reason,
          deferUntil,
        });
        if (persistedDeferUntil) {
          return { deferUntil: persistedDeferUntil };
        }
      }
      throw error;
    } finally {
      mediaPermit?.release();
    }
  }

  async enqueueAutoPublishImportedPosts(
    chatId: string,
    posts: VkParsingPostWithSource[],
    syncLease?: VkSyncLease,
  ): Promise<void> {
    if (posts.length === 0) {
      return;
    }

    const ownerScope = this.ownerScopeFromRow(posts[0]!);
    const publisherOwnerScope = this.getPublisherOwnerScope();
    if (
      !this.ownership.isExactScope(ownerScope, publisherOwnerScope) ||
      posts.some(
        (post) =>
          post.chatId !== chatId ||
          !this.isExactOwnerScope(post, ownerScope) ||
          !this.isExactOwnerScope(post.source, ownerScope),
      )
    ) {
      throw new Error('VK autopublish candidates cross an ownership scope');
    }
    if (syncLease) {
      if (
        syncLease.chatId !== chatId ||
        !this.isExactOwnerScope(syncLease, ownerScope) ||
        posts.some((post) => post.sourceId !== syncLease.id)
      ) {
        throw new Error('VK sync enqueue lease crosses the candidate scope');
      }
      if (await this.hasPersistedAutoPublishDenial(chatId, ownerScope.ownerBotId)) return;
      await this.enqueueAutoPublishImportedPostsUnderLease(posts, syncLease);
      return;
    }
    if (await this.hasPersistedAutoPublishDenial(chatId, ownerScope.ownerBotId)) return;
    const settings = await this.getSettingsForChat(chatId, ownerScope);

    const circuitPausedSourceIds = new Set<string>();
    for (const post of this.sortAutoPublishCandidates(posts)) {
      if (post.status !== VK_POST_STATUS_NEW) {
        continue;
      }
      if (
        !settings.autoPublishEnabled ||
        !settings.autoPublishEnabledAt ||
        !this.canAutoPublishPost(post, settings)
      ) {
        await this.clearPendingAutoPublishPost(post);
        continue;
      }
      if (isVkManualReviewMode(post.source.publishMode)) {
        await this.clearPendingAutoPublishPost(post);
        continue;
      }
      if (circuitPausedSourceIds.has(post.sourceId)) {
        continue;
      }
      const circuitOpened = await this.pauseSourceAutoPublishForCircuit(post.source);
      if (circuitOpened) {
        circuitPausedSourceIds.add(post.sourceId);
        continue;
      }

      try {
        const scheduleFingerprint = buildVkAutoPublishScheduleFingerprint(settings, post.source);
        const markedForEnqueue = await this.prisma.vkParsingPost.updateMany({
          where: {
            id: post.id,
            chatId: post.chatId,
            ownerProfile: post.ownerProfile,
            ownerBotId: post.ownerBotId,
            status: VK_POST_STATUS_NEW,
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishLockedAt: null,
            publishAttemptCount: 0,
            publishIdempotencyKey: null,
            publishReason: null,
            publishCancelledAt: null,
            publishScheduleFingerprint: post.publishScheduleFingerprint,
          },
          data: { publishScheduleFingerprint: scheduleFingerprint },
        });
        if (markedForEnqueue.count === 0) {
          continue;
        }
        const scheduledAt = await this.resolveInitialAutoPublishAt(
          post,
          settings,
          scheduleFingerprint,
        );
        await this.enqueuePostPublish(post, 'autopublish', scheduledAt, {
          scheduleFingerprint,
        });
      } catch (error) {
        if (this.isExactAutoPublishSetupRefusal(error, chatId)) return;
        this.logger.warn(
          {
            postId: post.id,
            chatId: post.chatId,
            sourceId: post.sourceId,
            err: error,
          },
          'VK post autopublish enqueue failed',
        );
      }
    }
  }

  private async enqueueAutoPublishImportedPostsUnderLease(
    posts: VkParsingPostWithSource[],
    lease: VkSyncLease,
  ): Promise<void> {
    for (const candidate of this.sortAutoPublishCandidates(posts)) {
      try {
        const prepared = await this.runWithVkSyncEnqueueLease(lease, async (tx) => {
          const post = await tx.vkParsingPost.findFirst({
            where: {
              id: candidate.id,
              sourceId: lease.id,
              chatId: lease.chatId,
              ownerProfile: lease.ownerProfile,
              ownerBotId: lease.ownerBotId,
            },
            include: { source: true },
          });
          if (!post || post.status !== VK_POST_STATUS_NEW) return null;
          const settings = await this.getSettingsForChat(
            lease.chatId,
            this.ownerScopeFromRow(post),
            tx,
          );
          if (
            !settings.autoPublishEnabled ||
            !settings.autoPublishEnabledAt ||
            !this.canAutoPublishPost(post, settings) ||
            isVkManualReviewMode(post.source.publishMode)
          ) {
            await this.clearPendingAutoPublishPost(post, tx);
            return null;
          }
          const scheduleFingerprint = buildVkAutoPublishScheduleFingerprint(settings, post.source);
          const marked = await tx.vkParsingPost.updateMany({
            where: {
              id: post.id,
              sourceId: lease.id,
              chatId: lease.chatId,
              ownerProfile: lease.ownerProfile,
              ownerBotId: lease.ownerBotId,
              status: VK_POST_STATUS_NEW,
              publishQueuedAt: null,
              publishScheduledAt: null,
              publishLockedAt: null,
              publishAttemptCount: 0,
              publishIdempotencyKey: null,
              publishReason: null,
              publishCancelledAt: null,
              publishScheduleFingerprint: post.publishScheduleFingerprint,
            },
            data: { publishScheduleFingerprint: scheduleFingerprint },
          });
          return marked.count === 1 ? { post, settings, scheduleFingerprint } : null;
        });
        if (!prepared) continue;
        if (await this.pauseSourceAutoPublishForCircuit(prepared.post.source, lease)) continue;
        const scheduledAt = await this.resolveInitialAutoPublishAt(
          prepared.post,
          prepared.settings,
          prepared.scheduleFingerprint,
        );
        await this.enqueuePostPublish(prepared.post, 'autopublish', scheduledAt, {
          scheduleFingerprint: prepared.scheduleFingerprint,
          syncLease: lease,
        });
      } catch (error) {
        if (error instanceof VkSyncLeaseLostError) throw error;
        if (this.isExactAutoPublishSetupRefusal(error, lease.chatId)) return;
        this.logger.warn(
          { postId: candidate.id, sourceId: lease.id, err: error },
          'VK sync post autopublish enqueue failed',
        );
      }
    }
  }

  private async hasPersistedAutoPublishDenial(
    chatId: string,
    publisherBotId: string,
  ): Promise<boolean> {
    const binding = await this.prisma.publisherEntityBinding.findUnique({
      where: { chatId },
      select: {
        publisherBotId: true,
        status: true,
        botAccessState: true,
        botAccessSource: true,
        permissionsSnapshot: true,
      },
    });
    // FLAG: The exact durable binding is only a refusal gate. New grants still pass
    // route readiness and beforeSend; untouched imports retain their recovery marker.
    return Boolean(
      binding?.publisherBotId === publisherBotId &&
      isPublisherManagedEntityActivationRequired(binding),
    );
  }

  private isExactAutoPublishSetupRefusal(error: unknown, chatId: string): boolean {
    if (
      !(error instanceof PublisherSetupRequiredException) ||
      error.chatIds.length !== 1 ||
      error.chatIds[0] !== chatId
    )
      return false;
    this.logger.warn(
      { blockerCode: error.blockerCode, attempted: false },
      'VK autopublish batch awaits Publisher access',
    );
    return true;
  }

  private runWithVkSyncEnqueueLease<T>(
    lease: VkSyncLease,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const chats = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM chats WHERE id = ${lease.chatId} FOR UPDATE
      `;
      if (chats.length !== 1) throw new VkSyncLeaseLostError();
      await lockVkSyncLease(tx, lease);
      return operation(tx);
    });
  }

  async clearQueuedAutoPublishForChat(
    chatId: string,
    ownerScope: VkParsingOwnerScope = this.getPublisherOwnerScope(),
    prisma: Pick<PrismaService, 'vkParsingPost'> = this.prisma,
  ): Promise<void> {
    await prisma.vkParsingPost.updateMany({
      where: {
        chatId,
        ...ownerScope,
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        publishLockedAt: null,
        publishAttemptCount: 0,
        OR: [
          {
            publishReason: 'autopublish',
            OR: [
              { publishQueuedAt: { not: null } },
              { publishIdempotencyKey: { not: null } },
              { publishScheduledAt: { not: null } },
            ],
          },
          {
            publishScheduleFingerprint: { not: null },
            publishQueuedAt: null,
            publishLockedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduledAt: null,
            publishCancelledAt: null,
            publishCancelledByUserId: null,
            publishActorUserId: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
          },
        ],
      },
      data: {
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduledAt: null,
        publishScheduleFingerprint: null,
      },
    });
  }

  async clearQueuedAutoPublishForSource(
    chatId: string,
    sourceId: string,
    ownerScope: VkParsingOwnerScope = this.getPublisherOwnerScope(),
  ): Promise<void> {
    await this.clearQueuedAutoPublishForSources(chatId, [sourceId], ownerScope);
  }

  async clearQueuedAutoPublishForSources(
    chatId: string,
    sourceIds: string[],
    ownerScope: VkParsingOwnerScope = this.getPublisherOwnerScope(),
    prisma: Pick<PrismaService, 'vkParsingPost'> = this.prisma,
  ): Promise<void> {
    const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))];
    if (uniqueSourceIds.length === 0) {
      return;
    }
    await prisma.vkParsingPost.updateMany({
      where: {
        chatId,
        ...ownerScope,
        sourceId: { in: uniqueSourceIds },
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        publishLockedAt: null,
        publishAttemptCount: 0,
        OR: [
          {
            publishReason: 'autopublish',
            OR: [
              { publishQueuedAt: { not: null } },
              { publishIdempotencyKey: { not: null } },
              { publishScheduledAt: { not: null } },
            ],
          },
          {
            publishScheduleFingerprint: { not: null },
            publishQueuedAt: null,
            publishLockedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduledAt: null,
            publishCancelledAt: null,
            publishCancelledByUserId: null,
            publishActorUserId: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
          },
        ],
      },
      data: {
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduledAt: null,
        publishScheduleFingerprint: null,
      },
    });
  }

  private async publishPreparedPostToMax(
    post: VkParsingPostWithSource,
    payload: PreparedVkPublishPayload,
    maxMessage: VkParsingMaxMessageText,
    params: {
      actorUserId: string;
      trafficClass: MaxApiTrafficClass;
      debugAction: string;
      auto: boolean;
      deleteAfterMinutes: number | null;
      storedDraft?: VkParsingStoredDraft;
      queuedIdempotencyKey?: string;
      queuedPublishReason?: VkParsingPublishReason;
      onPublishAttemptRecorded?: () => void;
    },
  ): Promise<PublishVkParsingPostResult> {
    if (
      post.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      post.ownerProfile !== VkParsingOwnerProfile.PUBLISHER ||
      post.ownerBotId !== post.requiredBotId ||
      post.requiredBotId !== this.getPublisherOwnerScope().ownerBotId
    ) {
      throw new Error('Major-owned or legacy VK publish execution is disabled');
    }
    const publisherBotId = post.requiredBotId;
    const storedPhotoUrls = this.readStringArray(post.photoUrls);
    const storedVideoUrls = this.readStringArray(post.videoUrls);
    const storedLinkUrls = this.readStringArray(post.linkUrls);
    const baseOptions: MaxSendMessageOptions = {
      ...(maxMessage.textFormat ? { textFormat: maxMessage.textFormat } : {}),
      debugContext: {
        screen: 'vk_parsing',
        action: params.debugAction,
      },
    };
    const photoMediaByUrl = this.resolvePhotoMediaIdentityMap({
      attachments: post.attachments,
      raw: post.raw,
      text: post.text,
    });
    const videoMediaByUrl = this.resolveVideoMediaIdentityMap({
      attachments: post.attachments,
      raw: post.raw,
      text: post.text,
    });

    let maxSendAttempted = false;
    let maxSendAttemptStartedAt: Date | null = null;
    try {
      const result = await this.sendMessageWithAttachmentRetry({
        postId: post.id,
        chatId: post.chatId,
        logicalIdempotencyKey: this.buildMaxPublicationIdempotencyKey(post, payload, maxMessage),
        text: maxMessage.text,
        baseOptions,
        trafficClass: params.trafficClass,
        videoAttachment: payload.videoUrls.length > 0,
        publisherExactBotId: publisherBotId,
        beforeSendMutation: async () => {
          await this.assertPublisherIntentReady(post);
          if (post.source.publishMode === VK_BOT_REVIEW_MODE) {
            const current = await this.prisma.vkParsingPost.findFirst({
              where: { id: post.id, ...this.getPublisherOwnerScope() },
              include: { source: true },
            });
            if (!current) throw new VkPublishIntentClaimLostError();
            const settings = await this.getSettingsForChat(
              post.chatId,
              this.getPublisherOwnerScope(),
            );
            await this.assertBotReviewApproved(current, settings);
            const access = (
              await this.maxClient.getChatMembersAccess(post.chatId, [params.actorUserId], {
                botId: publisherBotId,
                trafficClass: 'interactive',
                sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
                bypassCache: true,
              })
            ).get(params.actorUserId);
            if (!access || (!access.isAdmin && !access.isOwner))
              throw new ConflictException('Права согласующего больше не подтверждены.');
          }
          if (params.queuedIdempotencyKey) {
            if (!params.queuedPublishReason || !post.publishLockedAt) {
              throw new VkPublishIntentClaimLostError();
            }
            let recorded: boolean;
            try {
              recorded =
                post.source.publishMode === VK_BOT_REVIEW_MODE
                  ? await this.recordBotReviewPublishAttempt(
                      post,
                      params.queuedPublishReason,
                      params.queuedIdempotencyKey,
                      post.publishLockedAt,
                    )
                  : await this.recordPublishAttempt(
                      post.id,
                      params.queuedPublishReason,
                      params.queuedIdempotencyKey,
                      post.publishLockedAt,
                    );
            } catch (error: unknown) {
              throw new VkPublishAttemptPersistenceError(error);
            }
            if (!recorded) {
              throw new VkPublishIntentClaimLostError();
            }
            params.onPublishAttemptRecorded?.();
          }
          maxSendAttemptStartedAt = new Date();
          maxSendAttempted = true;
        },
        prepareAttempt: async (botId) => {
          const requestOptions = {
            botId,
            trafficClass: params.trafficClass,
            sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
          };
          const options: MaxSendMessageOptions = { ...baseOptions };
          const publisherDialogContext = this.readPublisherDialogContext(
            post.publishDialogContext,
            post.dialogBotId,
          );
          if (!publisherDialogContext) {
            throw new PublisherVkDispatchBlockedError(
              'dialog_context_unavailable',
              new Error('Publik VK intent is missing its Publisher-signed dialog context'),
            );
          }
          if (publisherDialogContext.buttons.length > 0) {
            options.buttons = publisherDialogContext.buttons;
          }

          if (payload.videoUrls.length > 0) {
            const videoPayload = await this.downloadAndUploadVideo(
              payload.videoUrls[0]!,
              requestOptions,
              videoMediaByUrl.get(payload.videoUrls[0]!) ?? null,
            );
            options.attachments = [{ type: 'video', payload: videoPayload }];
          } else {
            const imagePayloads = await this.downloadAndUploadImages(
              payload.photoUrls,
              requestOptions,
              {
                allowPartialFailures: params.auto,
                canPublishWithoutPhotos:
                  maxMessage.text.trim().length > 0 || payload.linkUrls.length > 0,
              },
              photoMediaByUrl,
            );

            if (imagePayloads.length === 1) {
              options.imagePayload = imagePayloads[0];
            } else if (imagePayloads.length > 1) {
              options.attachments = imagePayloads.map(
                (attachmentPayload): MaxAttachmentPayload => ({
                  type: 'image',
                  payload: attachmentPayload,
                }),
              );
            }
          }
          return {
            ...options,
            marketplacePublication: { purpose: 'VK_IMPORT', entityId: post.chatId },
          };
        },
      });
      const publisherDialogContext = this.readPublisherDialogContext(
        post.publishDialogContext,
        post.dialogBotId,
      );
      if (!publisherDialogContext) {
        throw new PublisherVkDispatchBlockedError(
          'dialog_context_unavailable',
          new Error('Publik VK send completed without its persisted dialog context'),
        );
      }
      await this.recordPublisherDialogContextSafely({
        chatId: post.chatId,
        actorUserId: params.actorUserId,
        messageId: result.messageId,
        text: maxMessage.engagementText,
        publishedUrl: result.url,
        context: publisherDialogContext,
        dispatchBotId: result.botId,
      });
      const publishedAtMax = new Date();
      const autoDeleteAt =
        params.deleteAfterMinutes == null
          ? null
          : new Date(publishedAtMax.getTime() + params.deleteAfterMinutes * 60_000);
      if (maxSendAttemptStartedAt) {
        await this.recordPublisherSendSuccessSafely(post.chatId, maxSendAttemptStartedAt);
      }
      const publishedContentHash =
        post.contentHash ||
        computeVkParsingPostContentHash({
          text: post.text,
          photoUrls: storedPhotoUrls,
          videoUrls: storedVideoUrls,
          linkUrls: storedLinkUrls,
        });
      const publishedPost = {
        ...post,
        ...(params.storedDraft ?? {}),
        status: VK_POST_STATUS_PUBLISHED,
        publishedContentHash,
        publishedMessageId: result.messageId,
        publishedBotId: result.botId,
        publishedUrl: result.url,
        publishedAtMax,
        autoDeleteAt,
        autoPublishedAt: params.auto ? publishedAtMax : post.autoPublishedAt,
        autoPublishError: null,
        unavailableAt: null,
        missingSinceAt: null,
        missingSeenCount: 0,
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduleFingerprint: null,
        dispatchBlockerCode: null,
        dispatchBlockedAt: null,
        skippedAt: null,
        skipReason: null,
        lastError: null,
      };
      let updated: { count: number };
      try {
        updated = await this.prisma.$transaction(async (tx) => {
          const persisted = await tx.vkParsingPost.updateMany({
            where: {
              id: post.id,
              status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
              ...(params.queuedIdempotencyKey && params.queuedPublishReason
                ? {
                    publishIdempotencyKey: params.queuedIdempotencyKey,
                    publishReason: params.queuedPublishReason,
                    publishLockedAt: post.publishLockedAt,
                  }
                : {}),
            },
            data: {
              ...(params.storedDraft ?? {}),
              status: VK_POST_STATUS_PUBLISHED,
              publishedContentHash,
              publishedMessageId: result.messageId,
              publishedBotId: result.botId,
              publishedUrl: result.url,
              publishedAtMax,
              autoDeleteAt,
              autoPublishedAt: publishedPost.autoPublishedAt,
              autoPublishError: null,
              unavailableAt: null,
              missingSinceAt: null,
              missingSeenCount: 0,
              publishQueuedAt: null,
              publishScheduledAt: null,
              publishCancelledAt: null,
              publishCancelledByUserId: null,
              publishLockedAt: null,
              publishIdempotencyKey: null,
              publishReason: null,
              publishScheduleFingerprint: null,
              dispatchBlockerCode: null,
              dispatchBlockedAt: null,
              skippedAt: null,
              skipReason: null,
              lastError: null,
            },
          });
          if (persisted.count !== 1) {
            throw new Error('Confirmed VK publication post persistence lost its row claim');
          }
          if (params.auto && persisted.count > 0) {
            await this.advanceSourceLastAutoPublishedAt(
              tx,
              post,
              publishedPost.autoPublishedAt ?? publishedPost.publishedAtMax,
            );
          }
          return persisted;
        });
      } catch (error: unknown) {
        throw new VkConfirmedPublishPersistenceError(error, {
          messageId: result.messageId,
          botId: result.botId,
          url: result.url ?? null,
          publishedAtMax,
          autoDeleteAt,
          autoPublishedAt: publishedPost.autoPublishedAt,
          publishedContentHash,
        });
      }
      if (updated.count === 0) {
        this.logger.warn(
          {
            postId: post.id,
            chatId: post.chatId,
            messageId: result.messageId,
          },
          'VK parsing post disappeared before publish persistence',
        );
      }
      return {
        post: this.feedService.mapPost(publishedPost),
        queued: 0,
        messageId: result.messageId,
        url: result.url,
      };
    } catch (error) {
      if (error instanceof PublisherVkDispatchBlockedError) {
        throw error;
      }
      if (error instanceof VkConfirmedPublishPersistenceError) {
        throw error;
      }
      if (
        error instanceof VkPublishIntentClaimLostError ||
        error instanceof VkPublishAttemptPersistenceError
      ) {
        throw error;
      }
      const healthClassification = await this.recordPublisherSendFailureSafely(
        post.chatId,
        error,
        maxSendAttemptStartedAt ?? new Date(),
      );
      if (healthClassification === 'global_paused' || healthClassification === 'setup_required') {
        throw new PublisherVkDispatchBlockedError(
          healthClassification === 'global_paused'
            ? 'publisher_auth_paused'
            : 'publisher_setup_required',
          error,
        );
      }
      const classified = classifyVkParsingPublishError(error);
      const formattedError = formatVkParsingClassifiedErrorMessage(classified);
      const ambiguousMaxSend = maxSendAttempted && isAmbiguousMaxSendError(error);
      const ambiguousAutopublishSend = params.auto && ambiguousMaxSend;
      const ambiguousSafetyDeskSend =
        params.actorUserId === SAFETY_DESK_ACTOR_USER_ID && ambiguousMaxSend;
      const persistedError = ambiguousMaxSend
        ? `${VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX} ${formattedError}. Delivery may have been accepted by MAX; ${
            ambiguousAutopublishSend
              ? 'autopublish retry is quarantined for manual verification.'
              : ambiguousSafetyDeskSend
                ? 'Safety Desk retry is blocked until manual verification.'
                : 'manual retry requires verification before resending.'
          }`.slice(0, 500)
        : formattedError;
      const queueOwnsOrdinaryFailure = Boolean(params.queuedIdempotencyKey);
      if (!queueOwnsOrdinaryFailure || ambiguousMaxSend) {
        // FLAG: A queued ordinary failure is persisted by the BullMQ boundary, which knows whether
        // this is the final attempt. Ambiguous dispatch is terminal immediately.
        const failed = await this.prisma.vkParsingPost.updateMany({
          where: {
            id: post.id,
            status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
            ...(params.queuedIdempotencyKey && params.queuedPublishReason
              ? {
                  publishIdempotencyKey: params.queuedIdempotencyKey,
                  publishReason: params.queuedPublishReason,
                  publishLockedAt: post.publishLockedAt,
                }
              : {}),
            AND: [
              {
                OR: [
                  { lastError: null },
                  {
                    AND: [
                      { NOT: { lastError: { startsWith: VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX } } },
                      {
                        NOT: {
                          lastError: {
                            startsWith: VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          data: {
            status: VK_POST_STATUS_FAILED,
            publishLockedAt: null,
            lastError: persistedError,
            autoPublishError: params.auto ? persistedError : post.autoPublishError,
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduleFingerprint: null,
          },
        });
        if (failed.count === 0) {
          this.logger.warn(
            { postId: post.id, chatId: post.chatId, err: error },
            'VK parsing post disappeared before publish failure persistence',
          );
        } else if (error !== null && typeof error === 'object') {
          this.persistedPublishFailures.add(error);
        }
      }
      throw error;
    }
  }

  private async recordPublisherDialogContextSafely(params: {
    chatId: string;
    actorUserId: string;
    messageId: string;
    text?: string | null;
    publishedUrl?: string | null;
    context: PublisherPreparedDialogContext;
    dispatchBotId: string;
  }): Promise<void> {
    const reference = params.context.reference;
    if (!reference) {
      return;
    }
    const commonPayload = {
      messageId: params.messageId,
      threadId: reference.threadId,
      source: 'vk_parsing',
      ...(params.text?.trim() ? { text: params.text } : {}),
      ...(params.publishedUrl ? { publishedUrl: params.publishedUrl } : {}),
      botId: params.dispatchBotId,
      dialogBotId: params.context.dialogBotId,
      ...(reference.customButtons.length > 0 ? { customButtons: reference.customButtons } : {}),
      ...(reference.buttonRows ? { buttonRows: reference.buttonRows } : {}),
      ...(reference.commentsButton !== undefined
        ? { commentsButton: reference.commentsButton }
        : {}),
    };
    const payload =
      reference.entityType === 'channel'
        ? {
            ...commonPayload,
            includeCommentsButton: reference.includeCommentsButton,
            includeSuggestButton: reference.includeSuggestButton,
            suggestionEntryMode: reference.suggestionEntryMode,
            ...(reference.suggestButtonText
              ? { suggestButtonText: reference.suggestButtonText }
              : {}),
          }
        : commonPayload;
    try {
      await this.prisma.auditLog.create({
        data: {
          chatId: params.chatId,
          actorUserId: params.actorUserId,
          action:
            reference.entityType === 'channel'
              ? CHANNEL_DIALOG_ACTION_AUTO_ATTACH
              : CHAT_DIALOG_ACTION_AUTO_ATTACH,
          payload,
        },
      });
    } catch (error) {
      this.logger.warn(
        { chatId: params.chatId, messageId: params.messageId, err: error },
        'Failed to persist Publik VK dialog context',
      );
    }
  }

  private async sendMessageWithAttachmentRetry(params: {
    postId: string;
    chatId: string;
    logicalIdempotencyKey: string;
    text: string;
    baseOptions: MaxSendMessageOptions;
    trafficClass: MaxApiTrafficClass;
    videoAttachment: boolean;
    publisherExactBotId: string;
    beforeSendMutation?: () => Promise<void>;
    prepareAttempt: (botId: string) => Promise<MaxSendMessageOptions>;
    onAttempt?: (botId: string) => void;
  }): Promise<MaxRoutedPublicationResult> {
    const publisherExactBotId = params.publisherExactBotId.trim();
    if (publisherExactBotId !== this.getPublisherOwnerScope().ownerBotId) {
      throw new Error('Publik VK send requires the exact Publisher bot');
    }
    if (!this.maxRoutedPublicationService) {
      throw new ServiceUnavailableException(
        'Routed MAX publication service is required for Publik VK publications',
      );
    }
    let lastError: unknown = null;
    const readinessRetryDelaysMs = params.videoAttachment
      ? BROADCAST_VIDEO_SEND_RETRY_DELAYS_MS
      : VK_ATTACHMENT_SEND_RETRY_DELAYS_MS;
    const attempts = readinessRetryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await this.maxRoutedPublicationService.publish({
          entityId: params.chatId,
          logicalIdempotencyKey: params.logicalIdempotencyKey,
          text: params.text || ' ',
          options: params.baseOptions,
          trafficClass: params.trafficClass,
          sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
          publisherExactBotId,
          prepareAttempt: async ({ botId }) => {
            if (botId !== publisherExactBotId) {
              throw new Error('Publik VK route resolved a non-Publisher bot');
            }
            return {
              options: await params.prepareAttempt(botId),
            };
          },
          onDispatchAttempt: ({ botId }) => {
            if (botId !== publisherExactBotId) {
              throw new Error('Publik VK dispatch attempted a non-Publisher bot');
            }
            params.onAttempt?.(botId);
          },
          ...(params.beforeSendMutation
            ? {
                beforeSendMutation: async () => {
                  await params.beforeSendMutation!();
                },
              }
            : {}),
        });
        if (result.botId !== publisherExactBotId) {
          throw new Error('Publik VK result belongs to a non-Publisher bot');
        }
        return result;
      } catch (error) {
        lastError = error;
        if (!isMaxAttachmentNotReadyError(error) || attempt >= attempts) {
          throw error;
        }
        await this.sleep(readinessRetryDelaysMs[attempt - 1]!);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('MAX attachment is not ready.');
  }

  private async lockManualPublishPost(
    postId: string,
    chatId: string,
    storedDraft: VkParsingStoredDraft,
  ): Promise<Date | null> {
    const publishLockAt = new Date();
    const locked = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        chatId,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        publishLockedAt: null,
      },
      data: {
        ...storedDraft,
        manualContentEditedAt: publishLockAt,
        publishLockedAt: publishLockAt,
      },
    });
    return locked.count > 0 ? publishLockAt : null;
  }

  private async releaseManualPublishLock(
    postId: string,
    chatId: string,
    publishLockAt: Date,
    previousPublishReason: string | null,
  ): Promise<void> {
    await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        chatId,
        publishLockedAt: publishLockAt,
      },
      data: {
        publishLockedAt: null,
        publishReason: previousPublishReason,
      },
    });
  }

  private async armManualPublishRecovery(
    post: Pick<
      VkParsingPostWithSource,
      | 'id'
      | 'chatId'
      | 'publishCancelledAt'
      | 'publishIdempotencyKey'
      | 'publishQueuedAt'
      | 'publishReason'
      | 'publishScheduledAt'
    >,
    publishLockAt: Date,
    publishIdempotencyKey: string,
  ): Promise<boolean> {
    // FLAG: Persist the logical MAX send before dispatch. A stale lock with this key is replayed
    // through MaxActionLedger, which recovers the original result instead of duplicating the send.
    const armed = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId: post.chatId,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        publishLockedAt: publishLockAt,
        publishQueuedAt: post.publishQueuedAt,
        publishScheduledAt: post.publishScheduledAt,
        publishIdempotencyKey: post.publishIdempotencyKey,
        publishReason: post.publishReason,
        publishCancelledAt: post.publishCancelledAt,
      },
      data: {
        publishQueuedAt: publishLockAt,
        publishScheduledAt: publishLockAt,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishIdempotencyKey,
        publishReason: 'manual-retry',
      },
    });
    return armed.count > 0;
  }

  private async enqueuePostPublish(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
    scheduledAt: Date = new Date(),
    options: {
      actorUserId?: string;
      storedDraft?: VkParsingStoredDraft;
      scheduleFingerprint?: string;
      botReviewId?: string;
      syncLease?: VkSyncLease;
    } = {},
  ): Promise<number> {
    this.assertNoAmbiguousMaxSendQuarantine(post);
    const route = await this.resolvePublishIntentRoute(post);
    const idempotencyKey = this.buildPublishIdempotencyKey(post, reason, scheduledAt);
    const now = new Date();
    const expectedRoute = this.readPersistedIntentRoute(post);
    const queued = await this.prisma.$transaction(async (tx) => {
      if (options.syncLease) {
        const lease = options.syncLease;
        const chats = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM chats WHERE id = ${lease.chatId} FOR UPDATE
        `;
        if (chats.length !== 1) throw new VkSyncLeaseLostError();
        await lockVkSyncLease(tx, lease);
        const current = await tx.vkParsingPost.findFirst({
          where: {
            id: post.id,
            sourceId: lease.id,
            chatId: lease.chatId,
            ownerProfile: lease.ownerProfile,
            ownerBotId: lease.ownerBotId,
          },
          include: { source: true },
        });
        const settings = await this.getSettingsForChat(
          lease.chatId,
          this.ownerScopeFromRow(lease),
          tx,
        );
        if (
          !current ||
          current.contentHash !== post.contentHash ||
          !settings.autoPublishEnabled ||
          !settings.autoPublishEnabledAt ||
          !this.canAutoPublishPost(current, settings) ||
          isVkManualReviewMode(current.source.publishMode) ||
          buildVkAutoPublishScheduleFingerprint(settings, current.source) !==
            options.scheduleFingerprint
        ) {
          return { count: 0 };
        }
      }
      if (options.botReviewId) {
        await tx.$queryRaw`SELECT id FROM chats WHERE id = ${post.chatId} FOR UPDATE`;
        const review = await tx.vkBotReview.findFirst({
          where: {
            id: options.botReviewId,
            postId: post.id,
            status: 'APPROVED',
            recipientUserId: options.actorUserId,
          },
        });
        const current = await tx.vkParsingPost.findUnique({
          where: { id: post.id },
          include: { source: true },
        });
        const settings = await tx.vkParsingSettings.findUnique({
          where: {
            chatId_ownerProfile_ownerBotId: {
              chatId: post.chatId,
              ...this.getPublisherOwnerScope(),
            },
          },
        });
        if (
          !review ||
          !current ||
          !settings ||
          current.publishIdempotencyKey ||
          current.source.publishMode !== VK_BOT_REVIEW_MODE ||
          review.fingerprint !== buildVkBotReviewFingerprint(current, settings)
        )
          return { count: 0 };
      }
      if (reason !== 'autopublish' && post.publishIdempotencyKey !== null) {
        const released = await tx.vkParsingPost.updateMany({
          where: {
            id: post.id,
            chatId: post.chatId,
            ownerProfile: post.ownerProfile,
            ownerBotId: post.ownerBotId,
            publishLockedAt: null,
            publishQueuedAt: post.publishQueuedAt,
            publishScheduledAt: post.publishScheduledAt,
            publishCancelledAt: post.publishCancelledAt,
            publishIdempotencyKey: post.publishIdempotencyKey,
            publishAttemptCount: 0,
            publishReason: post.publishReason,
            publishActorUserId: post.publishActorUserId,
            publishedMessageId: null,
            rollbackQueuedAt: null,
            rollbackLockedAt: null,
            rollbackDeletedAt: null,
            rollbackIdempotencyKey: null,
            status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
            dispatchProfile: expectedRoute.dispatchProfile,
            requiredBotId: expectedRoute.requiredBotId,
            dialogBotId: expectedRoute.dialogBotId,
            publicationPolicyRevision: expectedRoute.publicationPolicyRevision,
          },
          data: {
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduleFingerprint: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
          },
        });
        if (released.count === 0) {
          return released;
        }
      }

      return tx.vkParsingPost.updateMany({
        where: {
          id: post.id,
          chatId: post.chatId,
          ownerProfile: post.ownerProfile,
          ownerBotId: post.ownerBotId,
          publishLockedAt: null,
          publishQueuedAt: null,
          source: {
            publishMode: options.botReviewId ? VK_BOT_REVIEW_MODE : { not: VK_BOT_REVIEW_MODE },
          },
          publishScheduledAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          ...(reason === 'autopublish'
            ? {
                publishAttemptCount: 0,
                publishScheduleFingerprint: options.scheduleFingerprint ?? null,
              }
            : {}),
          publishCancelledAt: reason === 'autopublish' ? null : post.publishCancelledAt,
          publishActorUserId: post.publishActorUserId,
          publishedMessageId: null,
          rollbackQueuedAt: null,
          rollbackLockedAt: null,
          rollbackDeletedAt: null,
          rollbackIdempotencyKey: null,
          status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
          dispatchProfile: expectedRoute.dispatchProfile,
          requiredBotId: expectedRoute.requiredBotId,
          dialogBotId: expectedRoute.dialogBotId,
          publicationPolicyRevision: expectedRoute.publicationPolicyRevision,
        },
        data: {
          ...(options.storedDraft
            ? {
                ...options.storedDraft,
                manualContentEditedAt: now,
              }
            : {}),
          status: post.status === VK_POST_STATUS_FAILED ? VK_POST_STATUS_NEW : post.status,
          publishAttemptCount: 0,
          publishQueuedAt: now,
          publishScheduledAt: scheduledAt,
          publishCancelledAt: null,
          publishCancelledByUserId: null,
          publishLockedAt: null,
          publishIdempotencyKey: idempotencyKey,
          publishReason: reason,
          publishScheduleFingerprint:
            reason === 'autopublish' ? (options.scheduleFingerprint ?? null) : null,
          dispatchProfile: route.dispatchProfile,
          requiredBotId: route.requiredBotId,
          dialogBotId: route.dialogBotId,
          ...(route.publishDialogContext
            ? {
                publishDialogContext: route.publishDialogContext as Prisma.InputJsonValue,
              }
            : {}),
          publicationPolicyRevision: route.publicationPolicyRevision,
          publishActorUserId:
            options.actorUserId?.trim() ||
            (reason === 'autopublish' ? VK_PARSING_SYSTEM_ACTOR_USER_ID : null),
          dispatchBlockerCode: null,
          dispatchBlockedAt: null,
          lastError: null,
          autoPublishError: reason === 'autopublish' ? null : post.autoPublishError,
        },
      });
    });
    if (queued.count === 0) {
      return 0;
    }

    await this.addPublishJob(post, reason, idempotencyKey, now, scheduledAt, route);
    if (
      post.publishIdempotencyKey &&
      post.publishIdempotencyKey !== idempotencyKey &&
      (post.publishReason === 'autopublish' ||
        post.publishReason === 'manual-retry' ||
        post.publishReason === 'manual-schedule')
    ) {
      await this.removeSupersededPublishJob(post, post.publishIdempotencyKey, post.publishReason);
    }

    return 1;
  }

  private async resolvePublishIntentRoute(
    post: VkParsingPostWithSource,
  ): Promise<VkPublishIntentRoute> {
    const persisted = this.readPersistedIntentRoute(post);
    const hasActiveIntent = Boolean(
      post.publishIdempotencyKey?.trim() || post.publishQueuedAt || post.publishReason?.trim(),
    );
    const ownerScope = this.ownerScopeFromRow(post);
    if (!this.ownership.isExactScope(ownerScope, this.getPublisherOwnerScope())) {
      throw new Error('Major-owned VK publish execution is disabled');
    }
    if (
      !this.newDispatchRoute ||
      ownerScope.ownerBotId !== this.newDispatchRoute.requiredBotId ||
      !this.isExactOwnerScope(post.source, ownerScope)
    ) {
      throw new PublisherSetupRequiredException([post.chatId], 'publisher_bot_changed');
    }
    if (hasActiveIntent) {
      if (
        persisted.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
        persisted.requiredBotId !== ownerScope.ownerBotId
      ) {
        throw new PublisherSetupRequiredException([post.chatId], 'publisher_route_invalid');
      }
      return persisted;
    }
    if (!this.publisherReadinessService) {
      throw new ServiceUnavailableException('Publik readiness service is unavailable.');
    }

    const ready = await this.publisherReadinessService.assertEntityReady(post.chatId, 'vk_publish');
    try {
      if (!this.publisherDispatchHealthService) {
        throw new Error('Publisher dispatch health service is unavailable');
      }
      await this.publisherDispatchHealthService.assertDispatchAllowed();
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'PUBLISHER_DISPATCH_PAUSED') {
        throw new PublisherSetupRequiredException([post.chatId], 'publisher_auth_paused');
      }
      throw new ServiceUnavailableException('Publik dispatch health is unavailable.');
    }
    if (ready.requiredBotId !== this.newDispatchRoute.requiredBotId) {
      throw new PublisherSetupRequiredException([post.chatId], 'publisher_bot_changed');
    }
    const dialogBotId = ready.requiredBotId;
    if (!this.publisherDialogContextService) {
      throw new ServiceUnavailableException('Publik dialog context service is unavailable.');
    }
    const publishDialogContext = await this.publisherDialogContextService.prepare({
      chatId: post.chatId,
      entityType: ready.entityType,
      dialogBotId,
      customButtons: [],
    });
    return {
      dispatchProfile: this.newDispatchRoute.dispatchProfile,
      requiredBotId: ready.requiredBotId,
      dialogBotId,
      publishDialogContext,
      publicationPolicyRevision: ready.policyRevision,
    };
  }

  private readPersistedIntentRoute(
    post: Partial<
      Pick<
        VkParsingPostWithSource,
        | 'dispatchProfile'
        | 'requiredBotId'
        | 'dialogBotId'
        | 'publishDialogContext'
        | 'publicationPolicyRevision'
      >
    >,
  ): VkPublishIntentRoute {
    const dispatchProfile =
      post.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? PublicationDispatchProfile.PUBLIK_V1
        : PublicationDispatchProfile.LEGACY_ROUTED;
    return {
      dispatchProfile,
      requiredBotId:
        dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
          ? post.requiredBotId?.trim() || null
          : null,
      dialogBotId: post.dialogBotId?.trim() || null,
      publishDialogContext: this.readPublisherDialogContext(
        post.publishDialogContext,
        post.dialogBotId,
      ),
      publicationPolicyRevision:
        typeof post.publicationPolicyRevision === 'number' ? post.publicationPolicyRevision : null,
    };
  }

  private readPublisherDialogContext(
    raw: unknown,
    dialogBotId: string | null | undefined,
  ): PublisherPreparedDialogContext | null {
    const expectedDialogBotId = dialogBotId?.trim() ?? '';
    return expectedDialogBotId
      ? (this.publisherDialogContextService?.read(raw, expectedDialogBotId) ?? null)
      : null;
  }

  private assertNoAmbiguousMaxSendQuarantine(
    post: Pick<
      VkParsingPostWithSource,
      'lastError' | 'publishAttemptCount' | 'publishIdempotencyKey'
    >,
  ): void {
    if (isVkMaxSendConfirmedPersistencePending(post.lastError)) {
      throw new BadRequestException(MAX_SEND_CONFIRMED_PERSISTENCE_RETRY_BLOCK_MESSAGE);
    }
    if (isVkMaxSendAmbiguous(post.lastError)) {
      throw new BadRequestException(MAX_SEND_AMBIGUOUS_RETRY_BLOCK_MESSAGE);
    }
    if (post.publishIdempotencyKey && post.publishAttemptCount > 0) {
      throw new BadRequestException(MAX_SEND_ATTEMPT_IN_PROGRESS_BLOCK_MESSAGE);
    }
  }

  private isConfirmedPublishPersistencePending(lastError: string | null | undefined): boolean {
    return isVkMaxSendConfirmedPersistencePending(lastError);
  }

  private async addPublishJob(
    post: Pick<VkParsingPostWithSource, 'id' | 'chatId'> &
      Partial<
        Pick<
          VkParsingPostWithSource,
          | 'dispatchProfile'
          | 'requiredBotId'
          | 'dialogBotId'
          | 'publishDialogContext'
          | 'publicationPolicyRevision'
        >
      >,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    createdAt: Date,
    scheduledAt: Date | null = null,
    route: VkPublishIntentRoute = this.readPersistedIntentRoute(post),
  ): Promise<VkPublishJobEnqueueOutcome> {
    const delay = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;
    const job = this.buildPublishJob(post, reason, idempotencyKey, createdAt, route);
    const jobId = this.buildPublishJobId(post.id, idempotencyKey);
    const queue = this.resolvePublishQueue(route.dispatchProfile);
    const recoveryOutcome = await this.recoverExistingPublishJob(queue, jobId, job, scheduledAt);
    if (recoveryOutcome !== 'missing') {
      return recoveryOutcome;
    }

    try {
      await queue.add(VK_PUBLISH_JOB_NAME, job, {
        jobId,
        delay,
        ...VK_PARSING_PUBLISH_RETRY_POLICY,
      });
      return 'created';
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId,
          postId: job.postId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue VK parsing publish job after persisting its intent',
      );
      return 'failed';
    }
  }

  private buildPublishJob(
    post: Pick<VkParsingPostWithSource, 'id' | 'chatId'>,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    createdAt: Date,
    route: VkPublishIntentRoute,
  ): VkParsingPublisherPublishJob {
    if (route.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
      throw new Error(`Legacy VK publish intent ${post.id} is disabled`);
    }
    if (!route.requiredBotId) {
      throw new Error(`Publik VK intent ${post.id} is missing requiredBotId`);
    }
    return {
      kind: 'publish',
      postId: post.id,
      chatId: post.chatId,
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: route.requiredBotId,
      reason,
      idempotencyKey,
      retryPolicyName: 'vk-parsing-publish',
      createdAt: createdAt.toISOString(),
    };
  }

  private resolvePublishQueue(dispatchProfile: PublicationDispatchProfile): Queue<unknown> {
    if (dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
      throw new Error('Legacy VK publish queue is retired');
    }
    if (!this.publisherQueue) {
      throw new ServiceUnavailableException('Publik VK queue is unavailable.');
    }
    return this.publisherQueue as unknown as Queue<unknown>;
  }

  private async recoverExistingPublishJob(
    queue: Queue<unknown>,
    jobId: string,
    job: VkParsingPublisherPublishJob,
    scheduledAt: Date | null,
  ): Promise<VkPublishJobRecoveryOutcome> {
    try {
      const existingJob = await queue.getJob(jobId);
      if (!existingJob) {
        return 'missing';
      }

      const state = await existingJob.getState();
      if (state === 'unknown') {
        await existingJob.remove();
        this.logger.warn(
          { jobId, postId: job.postId },
          'Removed orphaned VK parsing publish job before recovery',
        );
        return 'missing';
      }
      if (!this.isMatchingPublishJob(existingJob.data as VkParsingPublisherJob, job)) {
        if (state === 'active') {
          this.logger.error(
            { jobId, postId: job.postId, state },
            'Quarantined active VK parsing publish job with mismatched ownership payload',
          );
          return 'conflict';
        }
        await existingJob.remove();
        this.logger.warn(
          { jobId, postId: job.postId, state },
          'Removed inactive VK parsing publish job with mismatched ownership payload',
        );
        return 'missing';
      }
      if (!this.isMatchingPublishJobSchedule(existingJob, state, scheduledAt)) {
        if (state === 'active') {
          this.logger.error(
            { jobId, postId: job.postId, state, scheduledAt },
            'Quarantined active VK parsing publish job with schedule drift',
          );
          return 'conflict';
        }
        await existingJob.remove();
        this.logger.warn(
          { jobId, postId: job.postId, state, scheduledAt },
          'Removed inactive VK parsing publish job with schedule drift',
        );
        return 'missing';
      }
      if (state === 'failed' || state === 'completed') {
        await existingJob.updateData(job);
        await existingJob.retry(state, {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        return 'retried';
      }

      return 'healthy';
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId,
          postId: job.postId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover VK parsing publish job',
      );
      return 'failed';
    }
  }

  private isMatchingPublishJob(
    actual: VkParsingPublisherJob | null | undefined,
    expected: VkParsingPublisherPublishJob,
  ): boolean {
    if (!actual || actual.kind !== 'publish') {
      return false;
    }
    return (
      actual.postId === expected.postId &&
      actual.chatId === expected.chatId &&
      actual.reason === expected.reason &&
      actual.idempotencyKey === expected.idempotencyKey &&
      actual.dispatchProfile === expected.dispatchProfile &&
      actual.requiredBotId === expected.requiredBotId
    );
  }

  private isMatchingPublishJobSchedule(
    existingJob: {
      timestamp?: number;
      delay?: number;
      attemptsMade?: number;
      attemptsStarted?: number;
      processedOn?: number;
    },
    state: string,
    scheduledAt: Date | null,
  ): boolean {
    if (state === 'active') {
      return true;
    }
    const nowMs = Date.now();
    const expectedAtMs = scheduledAt?.getTime() ?? nowMs;
    if (state === 'delayed') {
      if (
        Number(existingJob.attemptsMade) > 0 ||
        Number(existingJob.attemptsStarted) > 0 ||
        (typeof existingJob.processedOn === 'number' && existingJob.processedOn > 0)
      ) {
        return true;
      }
      const timestamp = Number(existingJob.timestamp);
      const delay = Number(existingJob.delay);
      if (!Number.isFinite(timestamp) || !Number.isFinite(delay)) {
        return true;
      }
      return Math.abs(timestamp + delay - expectedAtMs) <= VK_PUBLISH_SCHEDULE_DRIFT_TOLERANCE_MS;
    }
    if (state === 'failed' || state === 'completed') {
      return expectedAtMs <= nowMs + 1_000;
    }
    return true;
  }

  private sortAutoPublishCandidates(posts: VkParsingPostWithSource[]): VkParsingPostWithSource[] {
    const priorityRank = new Map([
      ['HIGH', 0],
      ['NORMAL', 1],
      ['LOW', 2],
    ]);
    return [...posts].sort((left, right) => {
      const byPriority =
        (priorityRank.get(left.source.priority) ?? 1) -
        (priorityRank.get(right.source.priority) ?? 1);
      if (byPriority !== 0) {
        return byPriority;
      }
      const leftTime = left.vkPublishedAt?.getTime() ?? left.createdAt.getTime();
      const rightTime = right.vkPublishedAt?.getTime() ?? right.createdAt.getTime();
      return leftTime - rightTime;
    });
  }

  private canAutoPublishPost(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
  ): boolean {
    if (!settings.autoPublishEnabled || !settings.autoPublishEnabledAt) {
      return false;
    }
    if (
      post.source.status !== VK_SOURCE_STATUS_ACTIVE ||
      post.source.importEnabled === false ||
      post.source.autoPublishEnabled === false ||
      post.source.autoPublishPausedAt !== null ||
      isVkManualReviewMode(post.source.publishMode)
    ) {
      return false;
    }
    const baseline = this.resolveAutoPublishBaseline(settings, post.source);
    return baseline ? this.isPostEligibleForAutoPublish(post, baseline) : false;
  }

  private resolveAutoPublishBaseline(
    settings: VkParsingSettingsLike,
    source: Pick<VkParsingPostWithSource['source'], 'autoPublishEnabledAt'>,
  ): Date | null {
    const globalBaseline = settings.autoPublishEnabledAt;
    const sourceBaseline = source.autoPublishEnabledAt ?? globalBaseline;
    if (!globalBaseline || !sourceBaseline) {
      return null;
    }

    return globalBaseline.getTime() >= sourceBaseline.getTime() ? globalBaseline : sourceBaseline;
  }

  private async countRecentAutoPublishActivity(
    database: Pick<Prisma.TransactionClient, 'vkParsingPost'>,
    post: Pick<VkParsingPostWithSource, 'chatId' | 'sourceId' | 'ownerProfile' | 'ownerBotId'>,
    windowMinutesInput: number,
  ): Promise<number> {
    const windowMinutes = Math.max(1, windowMinutesInput);
    const windowStart = new Date(Date.now() - windowMinutes * 60_000);
    const recent = await database.vkParsingPost.count({
      where: {
        chatId: post.chatId,
        sourceId: post.sourceId,
        ownerProfile: post.ownerProfile,
        ownerBotId: post.ownerBotId,
        OR: [
          { publishQueuedAt: { gte: windowStart }, publishReason: 'autopublish' },
          { autoPublishedAt: { gte: windowStart } },
        ],
      },
    });
    return recent ?? 0;
  }

  private async pauseSourceAutoPublishForCircuit(
    source: VkParsingPostWithSource['source'],
    syncLease?: VkSyncLease,
  ): Promise<boolean> {
    const now = new Date();
    const ownerScope = this.ownerScopeFromRow(source);
    const opened = await this.prisma.$transaction(async (tx) => {
      const lockedChats = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${source.chatId}
        FOR UPDATE OF chat
      `;
      if (lockedChats.length !== 1) {
        return false;
      }
      if (syncLease) await lockVkSyncLease(tx, syncLease);
      const currentSource = await tx.vkParsingSource.findFirst({
        where: { id: source.id, chatId: source.chatId, ...ownerScope },
      });
      const currentSettings = await tx.vkParsingSettings.findUnique({
        where: {
          chatId_ownerProfile_ownerBotId: {
            chatId: source.chatId,
            ...ownerScope,
          },
        },
      });
      if (
        !currentSource ||
        !currentSettings?.autoPublishEnabled ||
        currentSettings.autoPublishKillSwitchEnabled ||
        !currentSettings.circuitBreakerEnabled ||
        currentSource.status !== VK_SOURCE_STATUS_ACTIVE ||
        !currentSource.importEnabled ||
        !currentSource.autoPublishEnabled ||
        currentSource.autoPublishPausedAt !== null ||
        isVkManualReviewMode(currentSource.publishMode)
      ) {
        return false;
      }
      const recent = await this.countRecentAutoPublishActivity(
        tx,
        {
          chatId: currentSource.chatId,
          sourceId: currentSource.id,
          ownerProfile: currentSource.ownerProfile,
          ownerBotId: currentSource.ownerBotId,
        },
        currentSettings.circuitBreakerWindowMinutes,
      );
      if (recent + 1 <= currentSettings.circuitBreakerPostLimit) {
        return false;
      }
      const updated = await tx.vkParsingSource.updateMany({
        where: {
          id: currentSource.id,
          chatId: currentSource.chatId,
          ...ownerScope,
          status: VK_SOURCE_STATUS_ACTIVE,
          importEnabled: true,
          autoPublishEnabled: true,
          autoPublishPausedAt: null,
        },
        data: {
          autoPublishEnabled: false,
          autoPublishEnabledAt: null,
          autoPublishPausedAt: now,
          autoPublishPausedReason: 'circuit_breaker',
        },
      });
      if (updated.count !== 1) {
        return false;
      }
      await this.clearQueuedAutoPublishForSources(source.chatId, [source.id], ownerScope, tx);
      return {
        limit: currentSettings.circuitBreakerPostLimit,
        windowMinutes: currentSettings.circuitBreakerWindowMinutes,
      };
    });
    if (!opened) {
      return false;
    }
    await this.writeAuditLog(
      source.chatId,
      VK_PARSING_SYSTEM_ACTOR_USER_ID,
      'VK_PARSING_CIRCUIT_OPEN',
      {
        ownerProfile: source.ownerProfile,
        ownerBotId: source.ownerBotId,
        sourceId: source.id,
        windowMinutes: opened.windowMinutes,
        limit: opened.limit,
      },
    );
    return true;
  }

  private async resolveInitialAutoPublishAt(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
    scheduleFingerprint: string = buildVkAutoPublishScheduleFingerprint(settings, post.source),
  ): Promise<Date> {
    const now = new Date();
    const latestQueued =
      post.source.publishMode === VK_SOURCE_PUBLISH_MODE_IMMEDIATE
        ? null
        : await this.prisma.vkParsingPost.aggregate({
            where: {
              chatId: post.chatId,
              sourceId: post.sourceId,
              ownerProfile: post.ownerProfile,
              ownerBotId: post.ownerBotId,
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              requiredBotId: post.ownerBotId,
              id: { not: post.id },
              publishReason: 'autopublish',
              publishQueuedAt: { not: null },
              status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
              AND: [
                {
                  OR: [
                    { publishScheduleFingerprint: scheduleFingerprint },
                    { publishAttemptCount: { gt: 0 } },
                  ],
                },
              ],
            },
            _max: { publishScheduledAt: true },
          });
    const sourceLastAt =
      latestQueued?._max?.publishScheduledAt ??
      post.source.lastAutoPublishedAt ??
      post.source.autoPublishEnabledAt;
    return (
      await this.planAutoPublishSourceSlots({
        chatId: post.chatId,
        ownerScope: this.ownerScopeFromRow(post),
        excludedPostIds: [post.id],
        count: 1,
        now,
        lastSourceAt: sourceLastAt,
        settings,
        source: post.source,
      })
    )[0]!;
  }

  private async planAutoPublishSourceSlots(options: {
    chatId: string;
    ownerScope: VkParsingOwnerScope;
    excludedPostIds: readonly string[];
    count: number;
    now: Date;
    lastSourceAt: Date | null;
    reservedChatSlots?: readonly Date[];
    settings: VkParsingSettingsLike;
    source: VkParsingPostWithSource['source'];
  }): Promise<Date[]> {
    const scheduleFingerprint = buildVkAutoPublishScheduleFingerprint(
      options.settings,
      options.source,
    );
    const { start: currentLocalDayStart, end: currentLocalDayEnd } = getVkAutoPublishLocalDayRange(
      options.now,
      options.settings.schedulerTimezone,
    );
    const [currentLocalDayPublishedCount, canonicalSourceQuotaSlots] = await Promise.all([
      this.prisma.vkParsingPost.count({
        where: {
          chatId: options.chatId,
          sourceId: options.source.id,
          ...options.ownerScope,
          autoPublishedAt: { gte: currentLocalDayStart, lt: currentLocalDayEnd },
        },
      }),
      this.loadCanonicalSourceQuotaSlots({
        chatId: options.chatId,
        sourceId: options.source.id,
        ownerScope: options.ownerScope,
        excludedPostIds: options.excludedPostIds,
        scheduleFingerprint,
      }),
    ]);
    const minPublishIntervalMinutes =
      typeof options.source.minPublishIntervalMinutes === 'number' &&
      Number.isFinite(options.source.minPublishIntervalMinutes) &&
      options.source.minPublishIntervalMinutes >= 0
        ? options.source.minPublishIntervalMinutes
        : 30;
    const existingSourceQuotaSlots = this.projectAutoPublishSourceQuotaSlots({
      slots: canonicalSourceQuotaSlots,
      now: options.now,
      lastSourceAt: options.source.lastAutoPublishedAt,
      currentLocalDayPublishedCount,
      currentLocalDayPublishedAt: options.now,
      settings: options.settings,
      source: options.source,
      sourceSpacingMsOverride:
        options.source.publishMode === VK_SOURCE_PUBLISH_MODE_IMMEDIATE
          ? 0
          : minPublishIntervalMinutes * 60_000,
    });
    const projectedSourceTail = existingSourceQuotaSlots.at(-1) ?? null;
    const effectiveLastSourceAt =
      projectedSourceTail &&
      (!options.lastSourceAt || projectedSourceTail.getTime() > options.lastSourceAt.getTime())
        ? projectedSourceTail
        : options.lastSourceAt;
    if (options.source.publishMode === VK_SOURCE_PUBLISH_MODE_IMMEDIATE) {
      return this.planAutoPublishTimingSlots({
        count: options.count,
        now: options.now,
        existingSourceQuotaSlots,
        currentLocalDayPublishedCount,
        currentLocalDayPublishedAt: options.now,
        settings: {
          ...options.settings,
          distributeEvenlyEnabled: false,
          roundRobinEnabled: false,
        },
        source: options.source,
        sourceSpacingMsOverride: 0,
      });
    }
    if (!options.settings.roundRobinEnabled) {
      return this.planAutoPublishTimingSlots({
        count: options.count,
        now: options.now,
        lastSourceAt: effectiveLastSourceAt,
        existingSourceQuotaSlots,
        currentLocalDayPublishedCount,
        currentLocalDayPublishedAt: options.now,
        settings: options.settings,
        source: options.source,
      });
    }

    const excludedPostIds = [...new Set(options.excludedPostIds.filter(Boolean))];
    const reservedChatSlots = [...(options.reservedChatSlots ?? [])];
    const plannedSlots: Date[] = [];
    const sourceSpacingMs = resolveVkAutoPublishSourceSpacingMs(options.settings, options.source);
    const occupiedFrom = new Date(options.now.getTime() - VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS);
    let earliestMs = effectiveLastSourceAt
      ? Math.max(options.now.getTime(), effectiveLastSourceAt.getTime() + sourceSpacingMs)
      : options.now.getTime();
    let occupiedBuffer: Date[] = [];
    let cursor: { publishScheduledAt: Date; id: string } | null = null;
    let loadedThroughMs = Number.NEGATIVE_INFINITY;
    let exhausted = false;
    let loadedPageCount = 0;

    const loadNextPage = async (): Promise<void> => {
      if (loadedPageCount >= VK_AUTOPUBLISH_OCCUPIED_SLOT_MAX_PAGES) {
        throw new VkAutoPublishOccupiedSlotScanBudgetExceededError();
      }
      const page: Array<{ id: string; publishScheduledAt: Date | null }> =
        await this.prisma.vkParsingPost.findMany({
          where: {
            chatId: options.chatId,
            ...options.ownerScope,
            status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
            publishQueuedAt: { not: null },
            publishScheduledAt: { gte: occupiedFrom },
            ...(excludedPostIds.length > 0 ? { id: { notIn: excludedPostIds } } : {}),
            ...(cursor
              ? {
                  OR: [
                    { publishScheduledAt: { gt: cursor.publishScheduledAt } },
                    {
                      publishScheduledAt: cursor.publishScheduledAt,
                      id: { gt: cursor.id },
                    },
                  ],
                }
              : {}),
          },
          select: { id: true, publishScheduledAt: true },
          orderBy: [{ publishScheduledAt: 'asc' }, { id: 'asc' }],
          take: VK_AUTOPUBLISH_OCCUPIED_SLOT_PAGE_SIZE,
        });
      if (page.length === 0) {
        exhausted = true;
        return;
      }
      loadedPageCount += 1;

      const last: { id: string; publishScheduledAt: Date | null } = page.at(-1)!;
      if (!last.publishScheduledAt) {
        throw new Error('Queued VK autopublish slot is missing its schedule.');
      }
      occupiedBuffer.push(
        ...page.flatMap((row) => (row.publishScheduledAt ? [row.publishScheduledAt] : [])),
      );
      cursor = { publishScheduledAt: last.publishScheduledAt, id: last.id };
      loadedThroughMs = last.publishScheduledAt.getTime();
      exhausted = page.length < VK_AUTOPUBLISH_OCCUPIED_SLOT_PAGE_SIZE;
    };

    for (let index = 0; index < options.count; index += 1) {
      let candidateFloorMs = earliestMs;
      while (true) {
        occupiedBuffer = occupiedBuffer.filter(
          (slot) => slot.getTime() > candidateFloorMs - VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS,
        );
        if (
          loadedThroughMs === Number.NEGATIVE_INFINITY ||
          (!exhausted && candidateFloorMs + VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS > loadedThroughMs)
        ) {
          await loadNextPage();
        }

        const slot = this.planAutoPublishTimingSlots({
          count: 1,
          now: new Date(candidateFloorMs),
          existingChatSlots: [...occupiedBuffer, ...reservedChatSlots, ...plannedSlots],
          existingSourceQuotaSlots: [...existingSourceQuotaSlots, ...plannedSlots],
          currentLocalDayPublishedCount,
          currentLocalDayPublishedAt: options.now,
          settings: options.settings,
          source: options.source,
        })[0]!;
        if (
          exhausted ||
          slot.getTime() + VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS <= loadedThroughMs
        ) {
          plannedSlots.push(slot);
          earliestMs = slot.getTime() + sourceSpacingMs;
          break;
        }
        candidateFloorMs = slot.getTime();
      }
    }

    return plannedSlots;
  }

  private async loadCanonicalSourceQuotaSlots(options: {
    chatId: string;
    sourceId: string;
    ownerScope: VkParsingOwnerScope;
    excludedPostIds: readonly string[];
    scheduleFingerprint: string;
  }): Promise<Date[]> {
    const excludedPostIds = [...new Set(options.excludedPostIds.filter(Boolean))];
    const slots: Date[] = [];
    let cursor: { publishScheduledAt: Date; id: string } | null = null;

    for (let pageIndex = 0; pageIndex < VK_AUTOPUBLISH_OCCUPIED_SLOT_MAX_PAGES; pageIndex += 1) {
      const page: Array<{ id: string; publishScheduledAt: Date | null }> =
        await this.prisma.vkParsingPost.findMany({
          where: {
            chatId: options.chatId,
            sourceId: options.sourceId,
            ...options.ownerScope,
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: options.ownerScope.ownerBotId,
            status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
            publishReason: 'autopublish',
            publishQueuedAt: { not: null },
            publishScheduledAt: { not: null },
            ...(excludedPostIds.length > 0 ? { id: { notIn: excludedPostIds } } : {}),
            AND: [
              {
                OR: [
                  { publishScheduleFingerprint: options.scheduleFingerprint },
                  { publishAttemptCount: { gt: 0 } },
                ],
              },
              ...(cursor
                ? [
                    {
                      OR: [
                        { publishScheduledAt: { gt: cursor.publishScheduledAt } },
                        {
                          publishScheduledAt: cursor.publishScheduledAt,
                          id: { gt: cursor.id },
                        },
                      ],
                    },
                  ]
                : []),
            ],
          },
          select: { id: true, publishScheduledAt: true },
          orderBy: [{ publishScheduledAt: 'asc' }, { id: 'asc' }],
          take: VK_AUTOPUBLISH_OCCUPIED_SLOT_PAGE_SIZE,
        });
      if (page.length === 0) {
        return slots;
      }

      for (const row of page) {
        if (!row.publishScheduledAt) {
          throw new Error('Queued VK autopublish quota slot is missing its schedule.');
        }
        slots.push(row.publishScheduledAt);
      }
      if (page.length < VK_AUTOPUBLISH_OCCUPIED_SLOT_PAGE_SIZE) {
        return slots;
      }
      const last: { id: string; publishScheduledAt: Date | null } = page.at(-1)!;
      cursor = { publishScheduledAt: last.publishScheduledAt!, id: last.id };
    }

    throw new VkAutoPublishSourceQuotaScanBudgetExceededError();
  }

  private planAutoPublishTimingSlots(
    options: Parameters<typeof planVkAutoPublishSourceSlots>[0],
  ): Date[] {
    try {
      return planVkAutoPublishSourceSlots(options);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new VkAutoPublishScheduleUnavailableError();
      }
      throw error;
    }
  }

  private projectAutoPublishSourceQuotaSlots(
    options: Parameters<typeof projectVkAutoPublishSourceQuotaSlots>[0],
  ): Date[] {
    try {
      return projectVkAutoPublishSourceQuotaSlots(options);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new VkAutoPublishScheduleUnavailableError();
      }
      throw error;
    }
  }

  private async resolveDeferredPublishAt(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
    now: Date,
  ): Promise<Date> {
    let candidate =
      post.publishScheduledAt && post.publishScheduledAt > now ? post.publishScheduledAt : now;
    const { start: dayStart, end: dayEnd } = getVkAutoPublishLocalDayRange(
      candidate,
      settings.schedulerTimezone,
    );
    const publishedToday = await this.prisma.vkParsingPost.count({
      where: {
        chatId: post.chatId,
        sourceId: post.sourceId,
        ownerProfile: post.ownerProfile,
        ownerBotId: post.ownerBotId,
        autoPublishedAt: { gte: dayStart, lt: dayEnd },
      },
    });
    const dailyLimit =
      typeof post.source.dailyLimit === 'number' && post.source.dailyLimit > 0
        ? post.source.dailyLimit
        : 3;
    if (publishedToday >= dailyLimit) {
      candidate = dayEnd;
    }
    const latestPublished = await this.prisma.vkParsingPost.aggregate({
      where: {
        chatId: post.chatId,
        sourceId: post.sourceId,
        ownerProfile: post.ownerProfile,
        ownerBotId: post.ownerBotId,
        autoPublishedAt: { not: null },
      },
      _max: { autoPublishedAt: true },
    });
    const persistedPostAutoPublishedAt = latestPublished?._max.autoPublishedAt ?? null;
    const lastAutoPublishedAt =
      post.source.lastAutoPublishedAt && persistedPostAutoPublishedAt
        ? post.source.lastAutoPublishedAt > persistedPostAutoPublishedAt
          ? post.source.lastAutoPublishedAt
          : persistedPostAutoPublishedAt
        : (post.source.lastAutoPublishedAt ?? persistedPostAutoPublishedAt);
    if (lastAutoPublishedAt) {
      const minPublishIntervalMinutes =
        typeof post.source.minPublishIntervalMinutes === 'number' &&
        post.source.minPublishIntervalMinutes >= 0
          ? post.source.minPublishIntervalMinutes
          : 30;
      const minNextAt = new Date(
        lastAutoPublishedAt.getTime() + minPublishIntervalMinutes * 60_000,
      );
      if (minNextAt > candidate) {
        candidate = minNextAt;
      }
    }

    return this.resolveAllowedScheduleAt(candidate, settings, post.source);
  }

  private async deferQueuedPost(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
    currentIdempotencyKey: string,
    scheduledAt: Date,
    scheduleFingerprint?: string,
    preserveIntentKey = false,
  ): Promise<Date | null> {
    const nextIdempotencyKey =
      preserveIntentKey || post.publishAttemptCount > 0
        ? currentIdempotencyKey
        : this.buildPublishIdempotencyKey(post, reason, scheduledAt);
    const deferred = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        publishIdempotencyKey: currentIdempotencyKey,
        publishReason: reason,
        publishLockedAt: post.publishLockedAt,
        publishAttemptCount: post.publishAttemptCount,
        lastError: post.lastError,
      },
      data: {
        publishScheduledAt: scheduledAt,
        publishLockedAt: null,
        publishIdempotencyKey: nextIdempotencyKey,
        publishReason: reason,
        ...(scheduleFingerprint ? { publishScheduleFingerprint: scheduleFingerprint } : {}),
      },
    });
    if (deferred.count === 0) {
      return null;
    }
    if (nextIdempotencyKey === currentIdempotencyKey) {
      return scheduledAt;
    }
    await this.addPublishJob(post, reason, nextIdempotencyKey, new Date(), scheduledAt);
    return null;
  }

  private async recordPublishAttempt(
    postId: string,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    publishLockedAt: Date,
  ): Promise<boolean> {
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        publishIdempotencyKey: idempotencyKey,
        publishReason: reason,
        publishLockedAt,
      },
      data: { publishAttemptCount: { increment: 1 } },
    });
    return updated.count > 0;
  }

  private async recordBotReviewPublishAttempt(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
    key: string,
    lockedAt: Date,
  ): Promise<boolean> {
    // FLAG: Approval, the shown revision, and dispatch admission share the source/settings policy lock.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id = ${post.chatId} FOR UPDATE`;
      const current = await tx.vkParsingPost.findFirst({
        where: { id: post.id, ...this.getPublisherOwnerScope() },
        include: { source: true, botReview: true },
      });
      const settings = await tx.vkParsingSettings.findUnique({
        where: {
          chatId_ownerProfile_ownerBotId: { chatId: post.chatId, ...this.getPublisherOwnerScope() },
        },
      });
      if (
        !current ||
        !settings ||
        current.source.publishMode !== VK_BOT_REVIEW_MODE ||
        current.source.status !== 'ACTIVE' ||
        current.status !== 'NEW' ||
        current.botReview?.status !== 'APPROVED' ||
        current.botReview.decidedByUserId !== current.publishActorUserId ||
        settings.botReviewRecipientUserId !== current.publishActorUserId ||
        current.botReview.fingerprint !== buildVkBotReviewFingerprint(current, settings)
      ) {
        const released = await tx.vkParsingPost.updateMany({
          where: {
            id: post.id,
            publishIdempotencyKey: key,
            publishReason: reason,
            publishLockedAt: lockedAt,
            publishAttemptCount: 0,
            publishedMessageId: null,
          },
          data: {
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishLockedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
          },
        });
        if (released.count)
          await tx.vkBotReview.updateMany({
            where: { postId: post.id, status: 'APPROVED' },
            data: {
              status: 'PENDING',
              decidedAt: null,
              decidedByUserId: null,
              nextAttemptAt: new Date(),
            },
          });
        return false;
      }
      const result = await tx.vkParsingPost.updateMany({
        where: {
          id: post.id,
          publishReason: reason,
          publishIdempotencyKey: key,
          publishLockedAt: lockedAt,
        },
        data: { publishAttemptCount: { increment: 1 } },
      });
      return result.count === 1;
    });
  }

  private async releaseExactPublishLock(
    postId: string,
    idempotencyKey: string,
    reason: VkParsingPublishReason,
    publishLockedAt: Date,
  ): Promise<void> {
    await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        publishIdempotencyKey: idempotencyKey,
        publishReason: reason,
        publishLockedAt,
      },
      data: { publishLockedAt: null },
    });
  }

  private resolveAllowedScheduleAt(
    candidate: Date,
    settings: VkParsingSettingsLike,
    source: Pick<VkParsingPostWithSource['source'], 'quietHoursStart' | 'quietHoursEnd'>,
  ): Date {
    const resolved = resolveNextAllowedVkAutoPublishAt(candidate, settings, source);
    if (!resolved) {
      throw new VkAutoPublishScheduleUnavailableError();
    }
    return resolved;
  }

  private async findSchedulablePost(
    chatId: string,
    postId: string,
    ownerScope: VkParsingOwnerScope,
  ): Promise<VkParsingPostWithSource> {
    const post = await this.prisma.vkParsingPost.findFirst({
      where: { id: postId, chatId, ...ownerScope, source: ownerScope },
      include: { source: true },
    });
    if (!post) {
      throw new NotFoundException('VK-пост не найден.');
    }
    if (post.status === VK_POST_STATUS_PUBLISHED) {
      throw new BadRequestException('Этот VK-пост уже опубликован.');
    }
    if (post.status === VK_POST_STATUS_UNAVAILABLE) {
      throw new BadRequestException('VK-пост недоступен в исходном источнике.');
    }
    return post;
  }

  private assertReviewSourceOwnerAction(
    post: VkParsingPostWithSource,
    actorUserId: string | null,
  ): void {
    if (post.source.publishMode === VK_BOT_REVIEW_MODE) {
      throw new BadRequestException('Этот пост согласуется в личке бота.');
    }
    if (
      post.source.publishMode === VK_SOURCE_PUBLISH_MODE_REVIEW &&
      actorUserId !== SAFETY_DESK_ACTOR_USER_ID
    ) {
      throw new BadRequestException(
        'Публикация этого источника доступна только через Safety Desk.',
      );
    }
  }

  private resolvePhotoMediaIdentityMap(post: {
    attachments: Prisma.JsonValue | unknown;
    raw: Prisma.JsonValue | unknown;
    text: string;
  }): Map<string, VkParsingPhotoPublishMedia> {
    const parsed = parseVkWallPostAttachments({
      attachments: this.readAttachments(post.attachments),
      rawPost: this.asRecord(post.raw) ?? {},
      text: post.text,
      maxPhotos: VK_PARSING_MAX_PHOTOS,
      maxLinks: VK_PARSING_MAX_LINKS,
    });
    return new Map(
      parsed.photoMedia.map(({ url, mediaIdentity, candidateUrls }) => [
        url,
        {
          mediaIdentity,
          candidateUrls,
        },
      ]),
    );
  }

  private resolveVideoMediaIdentityMap(post: {
    attachments: Prisma.JsonValue | unknown;
    raw: Prisma.JsonValue | unknown;
    text: string;
  }): Map<string, VkParsingVideoPublishMedia> {
    const parsed = parseVkWallPostAttachments({
      attachments: this.readAttachments(post.attachments),
      rawPost: this.asRecord(post.raw) ?? {},
      text: post.text,
      maxPhotos: VK_PARSING_MAX_PHOTOS,
      maxLinks: VK_PARSING_MAX_LINKS,
    });
    return new Map(
      parsed.videoMedia.map(({ url, mediaIdentity, candidateUrls }) => [
        url,
        {
          mediaIdentity,
          candidateUrls,
        },
      ]),
    );
  }

  private async publishQueuedPost(
    post: VkParsingPostWithSource,
    settings: VkParsingSettingsLike,
    reason: VkParsingPublishReason,
    idempotencyKey: string,
    onPublishAttemptRecorded: () => void,
  ): Promise<VkParsingPublishProcessingResult | undefined> {
    const publisherBotId = post.requiredBotId?.trim() ?? '';
    if (publisherBotId !== this.getPublisherOwnerScope().ownerBotId) {
      throw new Error('Publik VK queued post requires the exact Publisher bot');
    }
    const auto = reason === 'autopublish';
    if (post.source.publishMode === VK_BOT_REVIEW_MODE) {
      const snapshot = await this.assertBotReviewApproved(post, settings);
      await this.publishPreparedPostToMax(
        post,
        snapshot.payload,
        { ...snapshot.maxMessage, textFormat: snapshot.maxMessage.textFormat },
        {
          actorUserId: post.publishActorUserId!,
          trafficClass: 'interactive',
          debugAction: 'bot_review_publish',
          auto: false,
          deleteAfterMinutes: settings.deleteAfterMinutes,
          queuedIdempotencyKey: idempotencyKey,
          queuedPublishReason: reason,
          onPublishAttemptRecorded,
        },
      );
      return;
    }
    const photoUrls = this.readStringArray(post.photoUrls);
    const videoUrls = this.readStringArray(post.videoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const preservedLinkUrls = this.resolveStripPreservedLinkUrls(post);
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: post.text,
        photoUrls,
        videoUrls,
        linkUrls,
        attachments: this.readAttachments(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    if (skipReason) {
      if (post.publishAttemptCount > 0) {
        const deferUntil = await this.deferQueuedPost(
          post,
          reason,
          idempotencyKey,
          new Date(Date.now() + VK_AUTOPUBLISH_INVALID_SCHEDULE_RETRY_MS),
        );
        return deferUntil ? { deferUntil } : undefined;
      }
      await this.markPostSkipped(post, skipReason);
      return;
    }

    const prepared = prepareVkParsingPublishPayload(
      {
        text: post.text,
        textFormat: resolveEffectiveVkParsingTextFormat({
          text: post.text,
          textFormat: post.textFormat,
          manualContentEditedAt: post.manualContentEditedAt,
        }),
        photoUrls,
        videoUrls,
        linkUrls,
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    if (this.isEmptyPublishPayload(prepared)) {
      if (post.publishAttemptCount > 0) {
        const deferUntil = await this.deferQueuedPost(
          post,
          reason,
          idempotencyKey,
          new Date(Date.now() + VK_AUTOPUBLISH_INVALID_SCHEDULE_RETRY_MS),
        );
        return deferUntil ? { deferUntil } : undefined;
      }
      await this.markPostSkipped(post, VK_POST_SKIP_REASON_NO_SUPPORTED_CONTENT);
      return;
    }
    this.assertPreparedPublishPayload(prepared);
    const maxMessage = await this.prepareMaxMessageText(
      post.chatId,
      prepared,
      settings,
      'background',
      publisherBotId,
      post.url,
    );

    await this.publishPreparedPostToMax(post, prepared, maxMessage, {
      actorUserId:
        post.publishActorUserId ??
        (!auto && post.source.publishMode === VK_SOURCE_PUBLISH_MODE_REVIEW
          ? SAFETY_DESK_ACTOR_USER_ID
          : VK_PARSING_SYSTEM_ACTOR_USER_ID),
      trafficClass: 'background',
      debugAction: auto ? 'auto_publish_post' : 'queued_manual_publish_post',
      auto,
      deleteAfterMinutes: settings.deleteAfterMinutes,
      queuedIdempotencyKey: idempotencyKey,
      queuedPublishReason: reason,
      onPublishAttemptRecorded,
    });
  }

  private assertPublisherRuntimeBeforeClaim(): void {
    try {
      if (!this.publisherRuntimeBoundaryService) {
        throw new Error('Publisher runtime boundary is unavailable');
      }
      this.publisherRuntimeBoundaryService.assertDispatchEnabled();
    } catch (error) {
      throw new PublisherVkDispatchBlockedError('publisher_runtime_unavailable', error);
    }
  }

  private async assertPublisherIntentReady(
    post: Pick<
      VkParsingPostWithSource,
      | 'chatId'
      | 'ownerProfile'
      | 'ownerBotId'
      | 'dispatchProfile'
      | 'requiredBotId'
      | 'dialogBotId'
      | 'publishDialogContext'
    >,
  ): Promise<PublisherReadyRoute> {
    this.assertPublisherRuntimeBeforeClaim();
    await this.assertPublisherHealthAllowed();
    if (
      post.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      post.ownerProfile !== VkParsingOwnerProfile.PUBLISHER ||
      post.ownerBotId !== post.requiredBotId ||
      !post.requiredBotId?.trim() ||
      !post.dialogBotId?.trim() ||
      !this.readPublisherDialogContext(post.publishDialogContext, post.dialogBotId)
    ) {
      throw new PublisherVkDispatchBlockedError(
        'publisher_route_invalid',
        new Error('Publik VK intent has an invalid immutable route'),
      );
    }
    if (!this.publisherReadinessService) {
      throw new PublisherVkDispatchBlockedError(
        'publisher_runtime_unavailable',
        new Error('Publisher readiness service is unavailable'),
      );
    }

    let ready: PublisherReadyRoute;
    try {
      ready = await this.publisherReadinessService.assertEntityReady(post.chatId, 'vk_publish');
    } catch (error) {
      throw new PublisherVkDispatchBlockedError(
        error instanceof PublisherSetupRequiredException
          ? error.blockerCode
          : 'publisher_runtime_unavailable',
        error,
      );
    }
    if (ready.requiredBotId !== post.requiredBotId) {
      throw new PublisherVkDispatchBlockedError(
        'publisher_bot_changed',
        new Error('Publik VK intent required bot no longer matches readiness'),
      );
    }
    return ready;
  }

  private async assertPublisherHealthAllowed(): Promise<void> {
    try {
      if (!this.publisherDispatchHealthService) {
        throw new Error('Publisher dispatch health service is unavailable');
      }
      await this.publisherDispatchHealthService.assertDispatchAllowed();
    } catch (error) {
      throw new PublisherVkDispatchBlockedError(
        (error as { code?: unknown } | null)?.code === 'PUBLISHER_DISPATCH_PAUSED'
          ? 'publisher_auth_paused'
          : 'publisher_runtime_unavailable',
        error,
      );
    }
  }

  private async recordPublisherSendFailureSafely(
    chatId: string,
    error: unknown,
    observedAt: Date,
  ): Promise<PublisherFailureClassification> {
    try {
      return (
        (await this.publisherDispatchHealthService?.recordSendFailure(chatId, error, observedAt)) ??
        'transient'
      );
    } catch (healthError) {
      this.logger.warn(
        { chatId, err: healthError },
        'Failed to persist Publik VK dispatch health failure',
      );
      return 'transient';
    }
  }

  private async recordPublisherSendSuccessSafely(chatId: string, attemptedAt: Date): Promise<void> {
    try {
      await this.publisherDispatchHealthService?.recordSendSuccess(chatId, attemptedAt);
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to persist Publik VK dispatch success');
    }
  }

  private async markPublisherIntentBlocked(
    post: Pick<
      VkParsingPostWithSource,
      | 'id'
      | 'dispatchProfile'
      | 'lastError'
      | 'publishAttemptCount'
      | 'publishLockedAt'
      | 'requiredBotId'
    >,
    idempotencyKey: string,
    reason: VkParsingPublishReason,
    blockerCode: string,
    expectedAttemptCount: number,
  ): Promise<void> {
    const requiredBotId = post.requiredBotId?.trim();
    if (!requiredBotId) {
      return;
    }
    const normalizedBlocker = blockerCode.trim().slice(0, 96) || 'publisher_setup_required';
    await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId,
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: requiredBotId,
        publishIdempotencyKey: idempotencyKey,
        publishReason: reason,
        publishLockedAt: post.publishLockedAt,
        publishAttemptCount: expectedAttemptCount,
        lastError: post.lastError,
        status: { not: VK_POST_STATUS_PUBLISHED },
        AND: [
          {
            OR: [
              { lastError: null },
              {
                AND: [
                  { NOT: { lastError: { startsWith: VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX } } },
                  {
                    NOT: {
                      lastError: {
                        startsWith: VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      data: {
        publishLockedAt: null,
        dispatchBlockerCode: normalizedBlocker,
        dispatchBlockedAt: new Date(),
        lastError: `[publisher.blocked] ${normalizedBlocker}`,
      },
    });
  }

  private async decideBackgroundAutoPublish(): Promise<BackgroundRuntimeGovernorDecision | null> {
    if (!this.backgroundRuntimeGovernorService) {
      return null;
    }

    try {
      return await this.backgroundRuntimeGovernorService.decide({
        component: 'vk_parsing_autopublish',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'VK autopublish governor check failed');
      return {
        action: 'pause',
        retryAfterMs: 180_000,
        reason: 'background governor unavailable',
      };
    }
  }

  private async markQueuedPostPublishFailed(
    post: Pick<
      VkParsingPostWithSource,
      'id' | 'autoPublishError' | 'lastError' | 'publishLockedAt'
    >,
    error: ReturnType<typeof classifyVkParsingPublishError>,
    options: {
      auto: boolean;
      attemptCountUncertain: boolean;
      finalAttempt: boolean;
      durableAttemptCount: number;
      idempotencyKey: string;
      preserveIntent: boolean;
      reason: VkParsingPublishReason;
      deferUntil: Date | null;
    },
  ): Promise<Date | null> {
    const message = formatVkParsingClassifiedErrorMessage(error);
    const shouldClearQueue = !options.preserveIntent && (!error.retryable || options.finalAttempt);
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        publishIdempotencyKey: options.idempotencyKey,
        publishReason: options.reason,
        publishLockedAt: post.publishLockedAt,
        ...(!options.attemptCountUncertain
          ? { publishAttemptCount: options.durableAttemptCount }
          : {}),
        lastError: post.lastError,
        status: { notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE] },
        AND: [
          {
            OR: [
              { lastError: null },
              {
                AND: [
                  { NOT: { lastError: { startsWith: VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX } } },
                  {
                    NOT: {
                      lastError: {
                        startsWith: VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      data: {
        status: VK_POST_STATUS_FAILED,
        lastError: message,
        autoPublishError: options.auto ? message : post.autoPublishError,
        publishLockedAt: null,
        ...(options.deferUntil ? { publishScheduledAt: options.deferUntil } : {}),
        ...(shouldClearQueue
          ? {
              publishQueuedAt: null,
              publishScheduledAt: null,
              publishIdempotencyKey: null,
              publishReason: null,
              publishScheduleFingerprint: null,
            }
          : {}),
      },
    });
    if (updated.count === 0) {
      this.logger.warn(
        { postId: post.id, errorClass: error.code },
        'VK parsing queued post disappeared before failure persistence',
      );
      return null;
    }
    return options.deferUntil;
  }

  private async markConfirmedPublishPersistencePending(
    post: Pick<VkParsingPostWithSource, 'id' | 'autoPublishError'>,
    idempotencyKey: string,
    reason: VkParsingPublishReason,
    error: unknown,
  ): Promise<void> {
    const cause =
      error instanceof VkConfirmedPublishPersistenceError ? error.persistenceCause : error;
    const message =
      `${VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX} ${formatVkParsingClassifiedErrorMessage(
        classifyVkParsingPublishError(cause),
      )}`.slice(0, 500);
    const receipt = error instanceof VkConfirmedPublishPersistenceError ? error.receipt : undefined;
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        publishIdempotencyKey: idempotencyKey,
        publishReason: reason,
        status: { not: VK_POST_STATUS_PUBLISHED },
      },
      data: {
        status: VK_POST_STATUS_FAILED,
        ...(receipt
          ? {
              publishedMessageId: receipt.messageId,
              publishedBotId: receipt.botId,
              publishedUrl: receipt.url,
              publishedAtMax: receipt.publishedAtMax,
              autoDeleteAt: receipt.autoDeleteAt,
              autoPublishedAt: receipt.autoPublishedAt,
              publishedContentHash: receipt.publishedContentHash,
            }
          : {}),
        publishLockedAt: null,
        lastError: message,
        autoPublishError: reason === 'autopublish' ? message : post.autoPublishError,
      },
    });
    if (updated.count === 0) {
      this.logger.warn(
        { postId: post.id },
        'Confirmed VK publication could not persist its recovery quarantine',
      );
    }
  }

  private async finalizeConfirmedPublishPersistence(
    post: VkParsingPostWithSource,
    idempotencyKey: string,
    reason: VkParsingPublishReason,
  ): Promise<void> {
    const messageId = post.publishedMessageId?.trim() ?? '';
    const botId = post.publishedBotId?.trim() ?? '';
    const publishedContentHash = post.publishedContentHash?.trim() ?? '';
    if (
      !messageId ||
      !botId ||
      botId !== post.requiredBotId ||
      !publishedContentHash ||
      !post.publishedAtMax
    ) {
      throw new Error('Confirmed VK publication recovery receipt is incomplete');
    }
    const receipt: VkConfirmedPublishReceipt = {
      messageId,
      botId,
      url: post.publishedUrl,
      publishedAtMax: post.publishedAtMax,
      autoDeleteAt: post.autoDeleteAt ?? null,
      autoPublishedAt: post.autoPublishedAt,
      publishedContentHash,
    };
    const finalizedStatus =
      post.contentHash && post.contentHash !== receipt.publishedContentHash
        ? VK_POST_STATUS_CHANGED_AFTER_PUBLISH
        : VK_POST_STATUS_PUBLISHED;
    try {
      await this.prisma.$transaction(async (tx) => {
        const persisted = await tx.vkParsingPost.updateMany({
          where: {
            id: post.id,
            publishIdempotencyKey: idempotencyKey,
            publishReason: reason,
            publishedMessageId: receipt.messageId,
            publishedBotId: receipt.botId,
            publishedAtMax: receipt.publishedAtMax,
            publishedContentHash: receipt.publishedContentHash,
            status: { not: VK_POST_STATUS_PUBLISHED },
          },
          data: {
            status: finalizedStatus,
            autoPublishError: null,
            unavailableAt: null,
            missingSinceAt: null,
            missingSeenCount: 0,
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishCancelledAt: null,
            publishCancelledByUserId: null,
            publishLockedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduleFingerprint: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
            skippedAt: null,
            skipReason: null,
            lastError: null,
          },
        });
        if (persisted.count !== 1) {
          throw new Error('Confirmed VK publication receipt lost its row claim');
        }
        if (reason === 'autopublish') {
          await this.advanceSourceLastAutoPublishedAt(
            tx,
            post,
            receipt.autoPublishedAt ?? receipt.publishedAtMax,
          );
        }
      });
    } catch (error: unknown) {
      throw new VkConfirmedPublishPersistenceError(error, receipt);
    }
  }

  private async advanceSourceLastAutoPublishedAt(
    tx: Pick<Prisma.TransactionClient, 'vkParsingSource'>,
    post: Pick<VkParsingPostWithSource, 'sourceId' | 'chatId' | 'ownerProfile' | 'ownerBotId'>,
    publishedAt: Date,
  ): Promise<void> {
    const sourceWhere = {
      id: post.sourceId,
      chatId: post.chatId,
      ownerProfile: post.ownerProfile,
      ownerBotId: post.ownerBotId,
    } as const;
    const advanced = await tx.vkParsingSource.updateMany({
      where: {
        ...sourceWhere,
        OR: [{ lastAutoPublishedAt: null }, { lastAutoPublishedAt: { lt: publishedAt } }],
      },
      data: { lastAutoPublishedAt: publishedAt },
    });
    if (advanced.count === 1) {
      return;
    }
    const current = await tx.vkParsingSource.findFirst({
      where: sourceWhere,
      select: { lastAutoPublishedAt: true },
    });
    if (!current?.lastAutoPublishedAt || current.lastAutoPublishedAt < publishedAt) {
      throw new Error('Confirmed VK publication source rollup lost its owner scope');
    }
  }

  private isFinalPublishAttempt(
    params: { attemptsMade?: number; maxAttempts?: number },
    durableAttemptCount = 0,
  ): boolean {
    const maxAttempts =
      typeof params.maxAttempts === 'number' && params.maxAttempts > 0
        ? Math.trunc(params.maxAttempts)
        : VK_PARSING_PUBLISH_RETRY_POLICY.attempts;
    const attemptsMade =
      typeof params.attemptsMade === 'number' && params.attemptsMade > 0
        ? Math.trunc(params.attemptsMade)
        : 0;
    return Math.max(attemptsMade + 1, durableAttemptCount) >= maxAttempts;
  }

  private isPublishFailurePersisted(error: unknown): boolean {
    return error !== null && typeof error === 'object' && this.persistedPublishFailures.has(error);
  }

  private isPostEligibleForAutoPublish(
    post: Pick<VkParsingPostWithSource, 'vkPublishedAt'>,
    enabledAt: Date,
  ): boolean {
    if (!post.vkPublishedAt) {
      return false;
    }

    return post.vkPublishedAt.getTime() >= enabledAt.getTime();
  }

  private async clearQueuedAutoPublishPost(
    postId: string,
    idempotencyKey?: string | null,
    expected?: Pick<
      VkParsingPostWithSource,
      'lastError' | 'publishAttemptCount' | 'publishLockedAt' | 'publishScheduledAt' | 'status'
    >,
  ): Promise<boolean> {
    const cleared = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: postId,
        publishReason: 'autopublish',
        ...(idempotencyKey ? { publishIdempotencyKey: idempotencyKey } : {}),
        ...(expected
          ? {
              publishLockedAt: expected.publishLockedAt,
              publishScheduledAt: expected.publishScheduledAt,
              publishAttemptCount: expected.publishAttemptCount,
              lastError: expected.lastError,
              status: expected.status,
            }
          : {}),
      },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduleFingerprint: null,
      },
    });
    return cleared.count > 0;
  }

  private async clearPendingAutoPublishPost(
    post: Pick<
      VkParsingPostWithSource,
      'id' | 'chatId' | 'ownerProfile' | 'ownerBotId' | 'publishScheduleFingerprint'
    >,
    database: Pick<Prisma.TransactionClient, 'vkParsingPost'> = this.prisma,
  ): Promise<boolean> {
    if (!post.publishScheduleFingerprint) {
      return false;
    }
    const cleared = await database.vkParsingPost.updateMany({
      where: {
        id: post.id,
        chatId: post.chatId,
        ownerProfile: post.ownerProfile,
        ownerBotId: post.ownerBotId,
        status: VK_POST_STATUS_NEW,
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishAttemptCount: 0,
        publishIdempotencyKey: null,
        publishReason: null,
        publishCancelledAt: null,
        publishScheduleFingerprint: post.publishScheduleFingerprint,
      },
      data: { publishScheduleFingerprint: null },
    });
    return cleared.count > 0;
  }

  private async clearRecoverableQueuedAutoPublishPost(
    postId: string,
    idempotencyKey: string,
    expected: Pick<
      VkParsingPostWithSource,
      | 'chatId'
      | 'dispatchProfile'
      | 'lastError'
      | 'publishAttemptCount'
      | 'requiredBotId'
      | 'publishLockedAt'
      | 'publishScheduledAt'
      | 'status'
    >,
  ): Promise<boolean> {
    const jobId = this.buildPublishJobId(postId, idempotencyKey);
    try {
      const queue = this.resolvePublishQueue(expected.dispatchProfile);
      const existingJob = await queue.getJob(jobId);
      if (!existingJob) {
        return this.clearQueuedAutoPublishPost(postId, idempotencyKey, expected);
      }
      const expectedJob: VkParsingPublisherPublishJob = {
        kind: 'publish',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: expected.requiredBotId ?? '',
        postId,
        chatId: expected.chatId,
        reason: 'autopublish',
        idempotencyKey,
      };
      if (!this.isMatchingPublishJob(existingJob.data as VkParsingPublisherJob, expectedJob)) {
        this.logger.error(
          { postId, jobId },
          'Skipped VK autopublish ownership cleanup because its queue payload does not match',
        );
        return false;
      }
      if ((await existingJob.getState()) === 'active') {
        this.logger.warn(
          { postId, jobId },
          'Skipped VK autopublish ownership cleanup because its queue job is active',
        );
        return false;
      }
      // BullMQ remove is the execution fence: it fails if a worker acquires the job after getState.
      await existingJob.remove();
    } catch (error: unknown) {
      this.logger.warn(
        {
          postId,
          jobId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Skipped VK autopublish ownership cleanup because its queue job could not be fenced',
      );
      return false;
    }
    return this.clearQueuedAutoPublishPost(postId, idempotencyKey, expected);
  }

  private buildPublishJobId(postId: string, idempotencyKey: string): string {
    return `vk-parsing-publish__${postId}__${idempotencyKey}`;
  }

  private async removeSupersededPublishJob(
    post: VkParsingPostWithSource,
    idempotencyKey: string,
    reason: VkParsingPublishReason,
  ): Promise<void> {
    if (!this.publisherQueue) {
      return;
    }
    const jobId = this.buildPublishJobId(post.id, idempotencyKey);
    try {
      const existingJob = await this.publisherQueue.getJob(jobId);
      if (!existingJob) {
        return;
      }
      const expected = this.buildPublishJob(
        post,
        reason,
        idempotencyKey,
        new Date(),
        this.readPersistedIntentRoute(post),
      );
      if (!this.isMatchingPublishJob(existingJob.data as VkParsingPublisherJob, expected)) {
        this.logger.error(
          { jobId, postId: post.id },
          'Skipped removal of a superseded VK autopublish job with mismatched ownership',
        );
        return;
      }
      if ((await existingJob.getState()) === 'active') {
        return;
      }
      await existingJob.remove();
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId,
          postId: post.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to remove a superseded VK autopublish job; its stale key remains a no-op',
      );
    }
  }

  private buildPublishIdempotencyKey(
    post: VkParsingPostWithSource,
    reason: VkParsingPublishReason,
    scheduledAt: Date,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          postId: post.id,
          chatId: post.chatId,
          contentHash: post.contentHash,
          status: post.status,
          reason,
          scheduledAt: scheduledAt.toISOString(),
          stateUpdatedAt: post.updatedAt.toISOString(),
        }),
      )
      .digest('hex')
      .slice(0, 32);
  }

  private buildMaxPublicationIdempotencyKey(
    post: VkParsingPostWithSource,
    payload: PreparedVkPublishPayload,
    maxMessage: VkParsingMaxMessageText,
  ): string {
    const intentKey =
      post.publishIdempotencyKey?.trim() ||
      this.buildMaxPublicationIntentKey(post.id, payload, maxMessage);
    return `vk-parsing:publish:${post.id}:${intentKey}`;
  }

  private buildMaxPublicationIntentKey(
    postId: string,
    payload: PreparedVkPublishPayload,
    maxMessage: VkParsingMaxMessageText,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          postId,
          text: payload.text,
          textFormat: payload.textFormat,
          maxText: maxMessage.text,
          maxTextFormat: maxMessage.textFormat ?? null,
          photoUrls: payload.photoUrls,
          videoUrls: payload.videoUrls,
          linkUrls: payload.linkUrls,
        }),
      )
      .digest('hex')
      .slice(0, 32);
  }

  private async downloadAndUploadImages(
    photoUrls: string[],
    requestOptions: {
      botId?: string;
      trafficClass: MaxApiTrafficClass;
      sourceTag: string;
    },
    options: {
      allowPartialFailures?: boolean;
      canPublishWithoutPhotos?: boolean;
    } = {},
    photoMediaByUrl: Map<string, VkParsingPhotoPublishMedia> = new Map(),
  ): Promise<Record<string, unknown>[]> {
    const payloads = new Array<Record<string, unknown> | null>(photoUrls.length).fill(null);
    const skippedErrors: string[] = [];
    const uploadConcurrency =
      requestOptions.trafficClass === 'background' ? 1 : this.mediaConcurrency;
    await this.mapWithConcurrency(photoUrls, uploadConcurrency, async (url, index) => {
      try {
        const media = photoMediaByUrl.get(url) ?? null;
        payloads[index] = await this.resolveUploadPayloadForMedia(
          url,
          index,
          requestOptions,
          media,
        );
      } catch (error) {
        const message = `Фото ${index + 1}: ${this.formatError(error)}`;
        if (!options.allowPartialFailures || !this.isSkippablePhotoPublishFailure(message)) {
          throw new BadRequestException(message);
        }
        skippedErrors.push(message);
      }
    });

    const uploadedPayloads = payloads.filter(
      (payload): payload is Record<string, unknown> => payload !== null,
    );
    if (
      photoUrls.length > 0 &&
      uploadedPayloads.length === 0 &&
      skippedErrors.length > 0 &&
      !options.canPublishWithoutPhotos
    ) {
      throw new BadRequestException(skippedErrors[0]);
    }

    return uploadedPayloads;
  }

  private async resolveUploadPayloadForMedia(
    imageUrl: string,
    index: number,
    requestOptions: {
      botId?: string;
      trafficClass: MaxApiTrafficClass;
      sourceTag: string;
    },
    media: VkParsingPhotoPublishMedia | null,
  ): Promise<Record<string, unknown>> {
    const mediaIdentity = media?.mediaIdentity ?? null;
    const candidateUrls = this.resolvePhotoCandidateUrls(imageUrl, media?.candidateUrls ?? []);
    let lastError: unknown = null;

    for (const candidateUrl of candidateUrls) {
      try {
        const cache = await this.assertMediaReadyForPublish(
          candidateUrl,
          index,
          mediaIdentity,
          requestOptions.botId ?? null,
        );
        const cachedPayload = this.readUploadPayload(cache, requestOptions.botId);
        if (cachedPayload) {
          return cachedPayload;
        }

        const image = await this.downloadImage(candidateUrl, index);
        const payload = await this.maxClient.uploadImage(
          image.buffer,
          image.fileName,
          image.mimeType,
          requestOptions,
        );
        await this.mediaCache.writeMediaCache(
          candidateUrl,
          {
            status: VK_MEDIA_STATUS_READY,
            mimeType: image.mimeType,
            contentLength: image.buffer.length,
            lastError: null,
            maxUploadPayload: this.buildCachedUploadPayload(payload, requestOptions.botId),
            maxUploadToken: this.readUploadToken(payload),
            maxUploadedAt: new Date(),
          },
          mediaIdentity,
        );

        return payload;
      } catch (error) {
        lastError = error;
        if (!this.shouldTryNextPhotoCandidate(error)) {
          throw error;
        }
        await this.rememberPhotoCandidateFailure(candidateUrl, mediaIdentity, error);
      }
    }

    throw lastError instanceof Error ? lastError : new BadRequestException('Фото недоступно.');
  }

  private async downloadAndUploadVideo(
    videoUrl: string,
    requestOptions: {
      botId?: string;
      trafficClass: MaxApiTrafficClass;
      sourceTag: string;
    },
    media: VkParsingVideoPublishMedia | null,
  ): Promise<Record<string, unknown>> {
    const mediaIdentity = media?.mediaIdentity ?? null;
    const candidateUrls = this.resolveVideoCandidateUrls(videoUrl, media?.candidateUrls ?? []);
    let lastError: unknown = null;

    for (const candidateUrl of candidateUrls) {
      try {
        const cache = await this.assertVideoReadyForPublish(
          candidateUrl,
          mediaIdentity,
          requestOptions.botId ?? null,
        );
        const cachedPayload = this.readUploadPayload(cache, requestOptions.botId);
        if (cachedPayload) {
          return cachedPayload;
        }

        const video = await this.downloadVideo(candidateUrl);
        const payload = await this.maxClient.uploadVideo(
          video.buffer,
          video.fileName,
          video.mimeType,
          {
            ...requestOptions,
            timeoutMs: VK_VIDEO_UPLOAD_TIMEOUT_MS,
          },
        );
        await this.mediaCache.writeMediaCache(
          candidateUrl,
          {
            status: VK_MEDIA_STATUS_READY,
            mimeType: video.mimeType,
            contentLength: video.buffer.length,
            lastError: null,
            maxUploadPayload: this.buildCachedUploadPayload(payload, requestOptions.botId),
            maxUploadToken: this.readUploadToken(payload),
            maxUploadedAt: new Date(),
          },
          mediaIdentity,
        );

        return payload;
      } catch (error) {
        lastError = error;
        if (!this.shouldTryNextVideoCandidate(error)) {
          throw error;
        }
        await this.rememberVideoCandidateFailure(candidateUrl, mediaIdentity, error);
      }
    }

    throw lastError instanceof Error ? lastError : new BadRequestException('Видео недоступно.');
  }

  private resolveVideoCandidateUrls(primaryUrl: string, candidateUrls: string[]): string[] {
    return [...new Set([primaryUrl, ...candidateUrls].map((url) => url.trim()).filter(Boolean))];
  }

  private shouldTryNextVideoCandidate(error: unknown): boolean {
    return this.isSkippableVideoPublishFailure(this.formatError(error));
  }

  private resolvePhotoCandidateUrls(primaryUrl: string, candidateUrls: string[]): string[] {
    return [...new Set([primaryUrl, ...candidateUrls].map((url) => url.trim()).filter(Boolean))];
  }

  private shouldTryNextPhotoCandidate(error: unknown): boolean {
    return this.isSkippablePhotoPublishFailure(this.formatError(error));
  }

  private async assertMediaReadyForPublish(
    imageUrl: string,
    index: number,
    mediaIdentity: string | null = null,
    botId: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cache = await this.mediaCache.preflightMediaUrl(imageUrl, mediaIdentity, botId);
    if (this.readUploadPayload(cache, botId)) {
      return cache;
    }
    if (cache.status === VK_MEDIA_STATUS_FAILED) {
      throw new BadRequestException(cache.lastError || `Фото ${index + 1} недоступно.`);
    }
    return cache;
  }

  private async assertVideoReadyForPublish(
    videoUrl: string,
    mediaIdentity: string | null = null,
    botId: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cache = await this.preflightVideoUrl(videoUrl, mediaIdentity, botId);
    if (this.readUploadPayload(cache, botId)) {
      return cache;
    }
    if (cache.status === VK_MEDIA_STATUS_FAILED) {
      throw new BadRequestException(cache.lastError || 'Видео VK недоступно.');
    }
    return cache;
  }

  private async preflightVideoUrl(
    videoUrl: string,
    mediaIdentity: string | null,
    botId: string | null,
  ): Promise<VkParsingMediaCacheRow> {
    const cached = await this.mediaCache.findMediaCache(videoUrl, mediaIdentity);
    if (cached?.status === VK_MEDIA_STATUS_READY && this.readUploadPayload(cached, botId)) {
      return cached;
    }
    if (
      cached?.status === VK_MEDIA_STATUS_FAILED &&
      (cached.url === videoUrl || this.readUploadPayload(cached, botId) !== null) &&
      this.canReuseFailedVideoPreflightCache(cached)
    ) {
      return cached;
    }

    let parsed: URL;
    try {
      parsed = new URL(videoUrl);
      if (parsed.protocol !== 'https:') {
        return this.mediaCache.writeMediaCache(
          videoUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            lastError: 'Видео VK должно быть доступно по HTTPS.',
          },
          mediaIdentity,
        );
      }
    } catch {
      return this.mediaCache.writeMediaCache(
        videoUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: 'Некорректная ссылка на видео VK.',
        },
        mediaIdentity,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_VIDEO_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchPublicHttpsMedia(parsed, {
        method: 'HEAD',
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        if (this.isSoftVideoPreflightStatus(response.status)) {
          return this.mediaCache.writeMediaCache(
            videoUrl,
            {
              status: VK_MEDIA_STATUS_READY,
              contentLength: null,
              lastError: null,
            },
            mediaIdentity,
          );
        }
        return this.mediaCache.writeMediaCache(
          videoUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            lastError: `VK вернул статус ${response.status} для видео.`,
          },
          mediaIdentity,
        );
      }

      const headers = response.headers ?? new Headers();
      const contentLength = this.readStrictContentLength(headers);
      if (contentLength !== null && contentLength > VK_VIDEO_MAX_BYTES) {
        return this.mediaCache.writeMediaCache(
          videoUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            contentLength,
            lastError: 'Видео из VK слишком большое. Максимум 250 МБ.',
          },
          mediaIdentity,
        );
      }

      const mimeType = this.normalizeVideoMimeType(headers.get('content-type'));
      if (!mimeType && this.hasExplicitUnsupportedVideoMimeType(headers.get('content-type'))) {
        return this.mediaCache.writeMediaCache(
          videoUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            contentLength,
            lastError: 'VK вернул не видео.',
          },
          mediaIdentity,
        );
      }

      return this.mediaCache.writeMediaCache(
        videoUrl,
        {
          status: VK_MEDIA_STATUS_READY,
          mimeType: mimeType || null,
          contentLength,
          lastError: null,
        },
        mediaIdentity,
      );
    } catch (error) {
      return this.mediaCache.writeMediaCache(
        videoUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError:
            error instanceof Error && error.name === 'AbortError'
              ? 'VK не ответил на проверку видео вовремя.'
              : error instanceof PublicHttpsMediaError
                ? 'Не удалось скачать видео из VK.'
                : formatVkParsingError(error),
        },
        mediaIdentity,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async rememberPhotoCandidateFailure(
    imageUrl: string,
    mediaIdentity: string | null,
    error: unknown,
  ): Promise<void> {
    try {
      await this.mediaCache.writeMediaCache(
        imageUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: this.formatError(error),
        },
        mediaIdentity,
      );
    } catch (cacheError) {
      this.logger.warn(
        { err: cacheError, imageUrl, mediaIdentity },
        'Failed to record stale VK photo candidate',
      );
    }
  }

  private async rememberVideoCandidateFailure(
    videoUrl: string,
    mediaIdentity: string | null,
    error: unknown,
  ): Promise<void> {
    try {
      await this.mediaCache.writeMediaCache(
        videoUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: this.formatError(error),
        },
        mediaIdentity,
      );
    } catch (cacheError) {
      this.logger.warn(
        { err: cacheError, videoUrl, mediaIdentity },
        'Failed to record stale VK video candidate',
      );
    }
  }

  private readUploadPayload(
    cache: VkParsingMediaCacheRow,
    expectedBotId: string | null | undefined,
  ): Record<string, unknown> | null {
    const payload = this.asRecord(cache.maxUploadPayload);
    const cachedBotId = this.readString(payload?.[VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]);
    if (!payload || !expectedBotId?.trim() || cachedBotId !== expectedBotId.trim()) {
      return null;
    }

    const sendPayload = { ...payload };
    delete sendPayload[VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD];
    return Object.keys(sendPayload).length > 0 ? sendPayload : null;
  }

  private buildCachedUploadPayload(
    payload: Record<string, unknown>,
    botId: string | null | undefined,
  ): Record<string, unknown> {
    const normalizedBotId = botId?.trim();
    return normalizedBotId
      ? { ...payload, [VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]: normalizedBotId }
      : payload;
  }

  private readUploadToken(payload: Record<string, unknown>): string | null {
    const token = this.readString(payload.token);
    return token || null;
  }

  private async downloadImage(imageUrl: string, index: number): Promise<VkParsingDownloadedMedia> {
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('Фото VK должно быть доступно по HTTPS.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_IMAGE_FETCH_TIMEOUT_MS);
    let response: Response | undefined;
    try {
      response = await fetchPublicHttpsMedia(parsed, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BadRequestException('Не удалось скачать фото из VK.');
      }

      const headers = response.headers ?? new Headers();
      const contentLength = Number(headers.get('content-length') ?? 0);
      if (contentLength > VK_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото из VK слишком большое.');
      }

      const mimeType = (headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
      if (!mimeType.toLowerCase().startsWith('image/')) {
        throw new BadRequestException('VK вернул не изображение.');
      }

      const buffer = await readBoundedResponseBuffer(
        response,
        VK_IMAGE_MAX_BYTES,
        controller.signal,
      );

      return {
        buffer,
        fileName: this.resolveImageFileName(parsed, index),
        mimeType,
      };
    } catch (error: unknown) {
      if (error instanceof PublicHttpsMediaError) {
        throw new BadRequestException('Не удалось скачать фото из VK.', { cause: error });
      }
      if (error instanceof ResponseByteLimitExceededError) {
        throw new BadRequestException('Фото из VK слишком большое.');
      }
      if (error instanceof EmptyResponseBodyError) {
        throw new BadRequestException('Не удалось скачать фото из VK.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      await response?.body?.cancel().catch(() => undefined);
    }
  }

  private async downloadVideo(videoUrl: string): Promise<VkParsingDownloadedMedia> {
    const parsed = new URL(videoUrl);
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('Видео VK должно быть доступно по HTTPS.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_VIDEO_FETCH_TIMEOUT_MS);
    let response: Response | undefined;
    try {
      response = await fetchPublicHttpsMedia(parsed, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BadRequestException('Не удалось скачать видео из VK.');
      }

      const headers = response.headers ?? new Headers();
      const contentLength = this.readStrictContentLength(headers);
      if (contentLength !== null && contentLength > VK_VIDEO_MAX_BYTES) {
        throw new BadRequestException('Видео из VK слишком большое. Максимум 250 МБ.');
      }

      const contentType = headers.get('content-type');
      const mimeType = this.normalizeVideoMimeType(contentType);
      if (!mimeType && this.hasExplicitUnsupportedVideoMimeType(contentType)) {
        throw new BadRequestException('VK вернул не видео.');
      }
      const resolvedMimeType = mimeType ?? this.resolveVideoMimeTypeFromUrl(parsed);
      if (!resolvedMimeType) {
        throw new BadRequestException('VK вернул не видео.');
      }

      const buffer = await readBoundedResponseBuffer(
        response,
        VK_VIDEO_MAX_BYTES,
        controller.signal,
      );
      if (contentLength !== null && buffer.length !== contentLength) {
        throw new BadRequestException('Размер скачанного видео VK не совпал с Content-Length.');
      }
      if (buffer.length > VK_VIDEO_MAX_BYTES) {
        throw new BadRequestException('Видео из VK слишком большое. Максимум 250 МБ.');
      }

      return {
        buffer,
        fileName: this.resolveVideoFileName(parsed, resolvedMimeType),
        mimeType: resolvedMimeType,
      };
    } catch (error: unknown) {
      if (error instanceof PublicHttpsMediaError) {
        throw new BadRequestException('Не удалось скачать видео из VK.', { cause: error });
      }
      if (error instanceof ResponseByteLimitExceededError) {
        throw new BadRequestException('Видео из VK слишком большое. Максимум 250 МБ.');
      }
      if (error instanceof EmptyResponseBodyError) {
        throw new BadRequestException('Видео из VK оказалось пустым.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      await response?.body?.cancel().catch(() => undefined);
    }
  }

  private resolveImageFileName(url: URL, index: number): string {
    const rawName = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    const safeName = rawName.replace(/[^A-Za-z0-9._-]/gu, '').slice(0, 120);
    if (safeName && /\.[A-Za-z0-9]{2,6}$/u.test(safeName)) {
      return safeName;
    }

    return `vk-photo-${index + 1}.jpg`;
  }

  private resolveVideoFileName(url: URL, mimeType: string): string {
    const rawName = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    const safeName = rawName.replace(/[^A-Za-z0-9._-]/gu, '').slice(0, 120);
    if (safeName && /\.[A-Za-z0-9]{2,6}$/u.test(safeName)) {
      return safeName;
    }

    return mimeType === 'video/webm' ? 'vk-video.webm' : 'vk-video.mp4';
  }

  private resolveVideoMimeTypeFromUrl(url: URL): string | null {
    const path = url.pathname.toLowerCase();
    if (path.endsWith('.webm')) {
      return 'video/webm';
    }
    if (path.endsWith('.mov') || path.endsWith('.qt')) {
      return 'video/quicktime';
    }
    if (path.endsWith('.mp4') || path.endsWith('.m4v')) {
      return 'video/mp4';
    }
    return null;
  }

  private normalizeVideoMimeType(value: string | null): string | null {
    const mimeType = (value ?? '').split(';')[0]!.trim().toLowerCase();
    return VK_SUPPORTED_VIDEO_MIME_TYPES.has(mimeType) ? mimeType : null;
  }

  private hasExplicitUnsupportedVideoMimeType(value: string | null): boolean {
    const mimeType = (value ?? '').split(';')[0]!.trim().toLowerCase();
    return (
      Boolean(mimeType) &&
      mimeType !== 'application/octet-stream' &&
      !mimeType.startsWith('binary/')
    );
  }

  private readStrictContentLength(headers: Headers): number | null {
    const rawContentLength = headers.get('content-length')?.trim();
    if (!rawContentLength || !/^\d+$/u.test(rawContentLength)) {
      return null;
    }
    const contentLength = Number(rawContentLength);
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  }

  private isSoftVideoPreflightStatus(status: number): boolean {
    return status === 403 || status === 405 || status === 501;
  }

  private canReuseFailedVideoPreflightCache(cache: VkParsingMediaCacheRow): boolean {
    if (!cache.lastCheckedAt) {
      return false;
    }
    const ageMs = Date.now() - cache.lastCheckedAt.getTime();
    return ageMs >= 0 && ageMs < this.videoFailedPreflightTtlMs;
  }

  private assertPreparedPublishPayload(payload: PreparedVkPublishPayload): void {
    if (this.isEmptyPublishPayload(payload)) {
      throw new BadRequestException(
        'После фильтрации в посте не осталось текста, фото, видео или ссылок.',
      );
    }
    if (payload.photoUrls.length > 0 && payload.videoUrls.length > 0) {
      throw new BadRequestException('В одном VK-посте можно опубликовать либо фото, либо видео.');
    }
    if (payload.text.length > VK_PARSING_MAX_PUBLISH_TEXT_LENGTH) {
      throw new BadRequestException(
        `Текст публикации слишком длинный. Максимум ${VK_PARSING_MAX_PUBLISH_TEXT_LENGTH} символов.`,
      );
    }
  }

  private async prepareMaxMessageText(
    chatId: string,
    payload: PreparedVkPublishPayload,
    settings: Pick<VkParsingSettingsLike, 'appendChannelLinkEnabled' | 'channelLinkText'> &
      Partial<Pick<VkParsingSettingsLike, 'sourceLinkEnabled' | 'sourceLinkUrl'>>,
    trafficClass: MaxApiTrafficClass,
    publisherBotId: string,
    postUrl = '',
  ): Promise<VkParsingMaxMessageText> {
    if (publisherBotId !== this.getPublisherOwnerScope().ownerBotId) {
      throw new Error('Publik VK message preparation requires the exact Publisher bot');
    }
    const usesRichText = payload.textFormat === 'markdown';
    const renderedText = usesRichText
      ? renderSupportedMarkdownAsHtml(payload.text, { blockMode: 'raw' })
      : payload.text;
    const missingLinkUrls = usesRichText
      ? payload.linkUrls.filter((url) => !containsSupportedMarkdownUrl(payload.text, url))
      : [];
    const renderedLinkHtml = missingLinkUrls.map(
      (url) => `<a href="${escapeMaxHtmlAttribute(url)}">${escapeMaxHtmlText(url)}</a>`,
    );
    let contentHtml = usesRichText
      ? [renderedText.trim(), ...renderedLinkHtml].filter(Boolean).join('\n')
      : renderedText;
    let engagementText = usesRichText
      ? [
          payload.text.trim(),
          ...missingLinkUrls.map((url) => `[${escapeMarkdownLinkLabel(url)}](${url})`),
        ]
          .filter(Boolean)
          .join('\n')
      : payload.text;

    const sourceLink = buildVkParsingSourceLink(postUrl, settings);
    if (sourceLink) {
      contentHtml = [
        usesRichText ? contentHtml.trim() : escapeMaxHtmlText(contentHtml.trim()),
        sourceLink.html,
      ]
        .filter(Boolean)
        .join('\n\n');
      engagementText = [engagementText.trim(), sourceLink.markdown].filter(Boolean).join('\n\n');
    }
    const hasHtml = usesRichText || Boolean(sourceLink);
    if (!settings.appendChannelLinkEnabled) {
      this.assertMaxMessageTextLength(contentHtml);
      return {
        text: contentHtml,
        textFormat: hasHtml ? 'html' : undefined,
        engagementText,
      };
    }

    const linkText = settings.channelLinkText.trim();
    if (!linkText) {
      throw new BadRequestException('Укажите текст ссылки на канал.');
    }
    const channelLink = await this.resolveChannelLink(chatId, trafficClass, publisherBotId);
    const baseHtml = hasHtml ? contentHtml : escapeMaxHtmlText(renderedText);
    const signatureHtml = `<a href="${escapeMaxHtmlAttribute(channelLink)}">${escapeMaxHtmlText(
      linkText,
    )}</a>`;
    const text = [baseHtml.trim(), signatureHtml].filter(Boolean).join('\n\n');
    const engagementTextWithSignature = [
      engagementText.trim(),
      `[${escapeMarkdownLinkLabel(linkText)}](${channelLink})`,
    ]
      .filter(Boolean)
      .join('\n\n');

    this.assertMaxMessageTextLength(text);
    return {
      text,
      textFormat: 'html',
      engagementText: engagementTextWithSignature,
    };
  }

  private assertMaxMessageTextLength(text: string): void {
    if (text.length > VK_PARSING_MAX_PUBLISH_TEXT_LENGTH) {
      throw new BadRequestException(
        `Текст вместе со ссылкой слишком длинный. Максимум ${VK_PARSING_MAX_PUBLISH_TEXT_LENGTH} символов.`,
      );
    }
  }

  private async resolveChannelLink(
    chatId: string,
    trafficClass: MaxApiTrafficClass,
    publisherBotId: string,
  ): Promise<string> {
    const entityType = await this.accessService.resolvePublicationEntityType(chatId);
    if (entityType !== ChatEntityType.CHANNEL) {
      throw new BadRequestException('Ссылка в конце доступна только для канала.');
    }

    if (publisherBotId !== this.getPublisherOwnerScope().ownerBotId) {
      throw new ServiceUnavailableException('Publik bot is required to resolve the channel link.');
    }

    const catalogDelegate = this.prisma.managedBotChatCatalog;
    if (catalogDelegate && typeof catalogDelegate.findFirst === 'function') {
      try {
        const catalogEntry = await catalogDelegate.findFirst({
          where: {
            chatId,
            botId: publisherBotId,
            entityType: ChatEntityType.CHANNEL,
            status: 'ACTIVE',
            link: { not: null },
          },
          orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
          select: { link: true },
        });
        const knownLink = normalizeMaxChannelLink(catalogEntry?.link);
        if (knownLink) {
          return knownLink;
        }
      } catch (error) {
        this.logger.warn({ chatId, err: error }, 'Failed to read cached MAX channel link');
      }
    }

    try {
      if (typeof this.maxClient.getChatSnapshot !== 'function') {
        throw new Error('Publisher bot cannot resolve the MAX channel link');
      }
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        botId: publisherBotId,
        trafficClass,
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      });
      const resolvedLink = normalizeMaxChannelLink(snapshot.link);
      if (snapshot.entityType === 'channel' && resolvedLink) {
        return resolvedLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to resolve MAX channel link for VK parsing');
      throw new ServiceUnavailableException('Не удалось получить ссылку канала. Повторите позже.');
    }

    throw new BadRequestException('У канала нет публичной ссылки MAX.');
  }

  private isEmptyPublishPayload(payload: PreparedVkPublishPayload): boolean {
    return (
      payload.text.trim().length === 0 &&
      payload.photoUrls.length === 0 &&
      payload.videoUrls.length === 0 &&
      payload.linkUrls.length === 0
    );
  }

  private isSkippablePhotoPublishFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    if (
      normalized.includes('rate limit exceeded') ||
      normalized.includes('circuit breaker') ||
      normalized.includes('max api')
    ) {
      return false;
    }

    return (
      normalized.includes('vk вернул статус') ||
      normalized.includes('не удалось скачать фото') ||
      normalized.includes('fetch failed') ||
      normalized.includes('terminated') ||
      normalized.includes('operation was aborted') ||
      normalized.includes('фото vk должно быть доступно по https') ||
      normalized.includes('некорректная ссылка на фото vk') ||
      normalized.includes('фото из vk слишком большое') ||
      normalized.includes('vk вернул не изображение') ||
      normalized.includes('vk не ответил')
    );
  }

  private isSkippableVideoPublishFailure(message: string): boolean {
    const normalized = message.toLowerCase();
    if (
      normalized.includes('rate limit exceeded') ||
      normalized.includes('circuit breaker') ||
      normalized.includes('max api')
    ) {
      return false;
    }

    return (
      normalized.includes('vk вернул статус') ||
      normalized.includes('не удалось скачать видео') ||
      normalized.includes('fetch failed') ||
      normalized.includes('terminated') ||
      normalized.includes('operation was aborted') ||
      normalized.includes('видео vk должно быть доступно по https') ||
      normalized.includes('некорректная ссылка на видео vk') ||
      normalized.includes('видео из vk слишком большое') ||
      normalized.includes('размер скачанного видео vk не совпал') ||
      normalized.includes('vk вернул не видео') ||
      normalized.includes('vk не сообщил размер видео') ||
      normalized.includes('vk не ответил')
    );
  }

  private async markPostSkipped(
    post: Pick<
      VkParsingPostWithSource,
      | 'id'
      | 'lastError'
      | 'publishAttemptCount'
      | 'publishIdempotencyKey'
      | 'publishLockedAt'
      | 'publishReason'
      | 'status'
    >,
    reason: VkParsingSkipReason,
  ): Promise<void> {
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        id: post.id,
        status: post.status,
        publishLockedAt: post.publishLockedAt,
        publishAttemptCount: post.publishAttemptCount,
        publishIdempotencyKey: post.publishIdempotencyKey,
        publishReason: post.publishReason,
        lastError: post.lastError,
        rollbackQueuedAt: null,
        rollbackLockedAt: null,
        rollbackIdempotencyKey: null,
      },
      data: {
        status: VK_POST_STATUS_SKIPPED,
        skippedAt: new Date(),
        skipReason: reason,
        autoPublishError: null,
        lastError: describeVkParsingSkipReason(reason),
        publishLockedAt: null,
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduleFingerprint: null,
      },
    });
    if (updated.count === 0) {
      this.logger.warn(
        { postId: post.id, reason },
        'VK parsing post changed before skip persistence',
      );
    }
  }

  private assertSelectedUrls(selected: string[], stored: string[], label: string): string[] {
    const storedSet = new Set(stored);
    const normalized = [...new Set(selected.map((url) => url.trim()).filter(Boolean))];
    const forbidden = normalized.find((url) => !storedSet.has(url));
    if (forbidden) {
      throw new BadRequestException(`Нельзя опубликовать неизвестную ${label}.`);
    }

    return normalized;
  }

  private async mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;
    let failure: { error: unknown } | null = null;
    // FLAG: Settle already-started siblings before the caller releases its media permit.
    // A failed required photo stops new downloads; permitted partial failures stay in the worker.
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (!failure && nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          try {
            await worker(items[index]!, index);
          } catch (error: unknown) {
            failure ??= { error };
          }
        }
      }),
    );
    if (failure) throw (failure as { error: unknown }).error;
  }

  private resolveEncodedMediaReservation(payload: {
    photoUrls: readonly string[];
    videoUrls: readonly string[];
  }): number {
    // FLAG: Reserve a worst-case bounded reader's chunks plus final copy before fetching.
    // Use all image lanes conservatively even for background's single lane. This is an
    // encoded-buffer reservation only; validator/native raster limits remain independent.
    if (payload.videoUrls.length > 0) return 2 * VK_VIDEO_MAX_BYTES;
    return (
      2 *
      VK_IMAGE_MAX_BYTES *
      Math.min(payload.photoUrls.length, Math.max(1, this.mediaConcurrency))
    );
  }

  private async runWithSourcePublishFence<T>(
    sourceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // FLAG: api-publisher is a singleton; this keeps its two BullMQ workers from passing the
    // same source's daily/minimum-interval checks concurrently without holding a DB transaction.
    const previous = (this.publishSourceFences.get(sourceId) ?? Promise.resolve()).catch(
      () => undefined,
    );
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.publishSourceFences.set(sourceId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.publishSourceFences.get(sourceId) === tail) {
        this.publishSourceFences.delete(sourceId);
      }
    }
  }

  private async writeAuditLog(
    chatId: string,
    actorUserId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.prisma.auditLog?.create) {
      return;
    }
    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action,
        payload: this.toJsonInput(payload),
      },
    });
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private getDefaultSettings(chatId: string): VkParsingSettingsLike {
    return {
      chatId,
      sourceLinkEnabled: false,
      sourceLinkUrl: '',
      deleteAfterMinutes: null,
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      autoPublishKillSwitchEnabled: false,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      appendChannelLinkEnabled: false,
      channelLinkText: VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
      schedulerTimezone: 'Europe/Moscow',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowMinutes: 10,
      circuitBreakerPostLimit: 10,
      updatedAt: null,
    };
  }

  private async getSettingsForChat(
    chatId: string,
    ownerScope: VkParsingOwnerScope,
    database: Pick<Prisma.TransactionClient, 'vkParsingSettings'> = this.prisma,
  ): Promise<VkParsingSettingsLike> {
    const settings = await database.vkParsingSettings.findUnique({
      where: {
        chatId_ownerProfile_ownerBotId: {
          chatId,
          ...ownerScope,
        },
      },
    });
    const defaults = this.getDefaultSettings(chatId);
    const legacySchedulerDefaults =
      settings && !Object.prototype.hasOwnProperty.call(settings, 'workHoursStart')
        ? { workHoursStart: '00:00', workHoursEnd: '00:00' }
        : {};
    return {
      ...defaults,
      ...legacySchedulerDefaults,
      ...(settings ?? {}),
    };
  }

  private getPublisherOwnerScope(): VkParsingOwnerScope {
    return this.ownership.getPublisherScope();
  }

  private ownerScopeFromRow(
    row: Pick<VkParsingPostWithSource, 'ownerProfile' | 'ownerBotId'>,
  ): VkParsingOwnerScope {
    return this.ownership.fromRow(row);
  }

  private isExactOwnerScope(
    row: Pick<VkParsingPostWithSource, 'ownerProfile' | 'ownerBotId'>,
    ownerScope: VkParsingOwnerScope,
  ): boolean {
    return row.ownerProfile === ownerScope.ownerProfile && row.ownerBotId === ownerScope.ownerBotId;
  }

  private ownerScopeKey(chatId: string, ownerScope: VkParsingOwnerScope): string {
    return JSON.stringify([chatId, ownerScope.ownerProfile, ownerScope.ownerBotId]);
  }

  private readStringArray(value: Prisma.JsonValue | unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  private readAttachments(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  private resolveStripPreservedLinkUrls(post: VkParsingPostWithSource): string[] {
    const postUrl = this.readString(post.url);
    if (!postUrl) {
      return [];
    }
    const linkUrls = this.readStringArray(post.linkUrls);
    if (!linkUrls.includes(postUrl)) {
      return [];
    }
    if (
      this.readStringArray(post.photoUrls).length > 0 ||
      this.readStringArray(post.videoUrls).length > 0
    ) {
      return [];
    }
    const hasUnsupportedVideo = this.readUnsupportedAttachments(post.unsupportedAttachments).some(
      (item) => item.type === 'video' || item.type === 'clip',
    );
    return hasUnsupportedVideo ? [postUrl] : [];
  }

  private readUnsupportedAttachments(value: Prisma.JsonValue | unknown): Array<{ type: string }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({ type: this.readString(item.type).toLowerCase() }))
      .filter((item) => item.type.length > 0);
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return formatVkParsingError(error);
  }
}

function normalizeMaxChannelLink(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      (hostname !== 'max.ru' && hostname !== 'www.max.ru') ||
      Boolean(parsed.username || parsed.password || parsed.port) ||
      parsed.pathname === '/'
    ) {
      return null;
    }
    parsed.protocol = 'https:';
    parsed.hostname = 'max.ru';
    parsed.hash = '';
    parsed.search = '';
    const canonical = parsed.toString();
    return escapeMaxHtmlAttribute(canonical).length <= VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function escapeMaxHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeMaxHtmlAttribute(value: string): string {
  return escapeMaxHtmlText(value).replace(/"/gu, '&quot;');
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\[/gu, '\\[').replace(/\]/gu, '\\]');
}
