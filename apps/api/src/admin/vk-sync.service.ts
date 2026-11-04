import { VK_PARSING_MAX_LINKS, VK_PARSING_MAX_PHOTOS } from '@maxim/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { VkApiClientService } from './vk-api-client.service';
import { isVkManualReviewMode, VK_BOT_REVIEW_MODE } from './vk-bot-review-protocol';
import {
  parseVkWallPostAttachments,
  type VkParsingPhotoMediaIdentity,
  type VkParsingUnsupportedAttachmentSummary,
  type VkParsingVideoMediaIdentity,
} from './vk-parsing-attachments';
import {
  computeVkParsingPostContentHash,
  resolveEffectiveVkParsingTextFormat,
  type VkParsingTextFormat,
} from './vk-parsing-content';
import {
  classifyVkParsingMediaPreflightError,
  classifyVkParsingSyncError,
  readVkRetryAtMs,
  VkApiRequestError,
} from './vk-parsing-errors';
import { VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT } from './vk-autopublish-policy';
import { VkParsingMediaCacheService } from './vk-parsing-media-cache.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import {
  VkParsingPostImportRepository,
  type ExistingVkPostImportState,
  type PreparedVkPostImport,
  type VkParsingPostImportDatabase,
} from './vk-parsing-post-import.repository';
import { type VkParsingSyncReason } from './vk-parsing.queue';
import { VkPublishService } from './vk-publish.service';
import { lockVkSyncLease, VkSyncLeaseLostError, type VkSyncLease } from './vk-sync-lease';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;
type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{ include: { source: true } }>;

type VkWallGetResponse = {
  count?: number;
  items?: unknown[];
  groups?: unknown[];
};

type VkVideoReference = {
  ownerId: number;
  videoId: number;
  accessKey: string | null;
};

type NormalizedVkPost = {
  vkOwnerId: number;
  vkPostId: number;
  vkPublishedAt: Date | null;
  text: string;
  textFormat: VkParsingTextFormat;
  url: string;
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
  attachments: Array<Record<string, unknown>>;
  attachmentTypes: string[];
  unsupportedAttachments: VkParsingUnsupportedAttachmentSummary[];
  hasUnsupportedAttachments: boolean;
  isAdvertising: boolean;
  advertisingMarkers: string[];
  photoMedia: VkParsingPhotoMediaIdentity[];
  videoMedia: VkParsingVideoMediaIdentity[];
  copyHistoryText: string[];
  raw: Record<string, unknown>;
  contentHash: string;
};

type ImportedPostsBatchResult = {
  imported: number;
  importedPosts: VkParsingPostWithSource[];
  publishCandidates: VkParsingPostWithSource[];
  mediaPreflightPosts: NormalizedVkPost[];
};

const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_SYNC_STATUS_IDLE = 'IDLE';
const VK_SOURCE_SYNC_STATUS_SYNCING = 'SYNCING';
const VK_SOURCE_SYNC_STATUS_BACKOFF = 'BACKOFF';
const VK_SOURCE_SYNC_STATUS_ERROR = 'ERROR';
const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_CHANGED_AFTER_PUBLISH = 'CHANGED_AFTER_PUBLISH';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const VK_PARSING_WARNING_DEDUPE_MS = 60_000;
const VK_AUTOPUBLISH_PENDING_RECOVERY_BATCH_SIZE = 100;
const VK_IMPORT_POLICY_TRANSACTION_MAX_WAIT_MS = 5_000;
const VK_IMPORT_POLICY_TRANSACTION_TIMEOUT_MS = 15_000;

@Injectable()
export class VkSyncService {
  private readonly logger = new Logger(VkSyncService.name);
  private readonly syncIntervalMs: number;
  private readonly minSyncIntervalMs: number;
  private readonly maxSyncIntervalMs: number;
  private readonly fetchCount: number;
  private readonly minFetchPages: number;
  private readonly maxFetchPages: number;
  private readonly missingConfirmationThreshold: number;
  private readonly syncLeaseTtlMs: number;
  private readonly mediaConcurrency: number;
  private readonly sourceCircuitTerminalFailureThreshold: number;
  private readonly warningDedupe = new Map<string, { loggedAtMs: number; suppressed: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly vkApiClient: VkApiClientService,
    private readonly publishService: VkPublishService,
    private readonly mediaCache: VkParsingMediaCacheService,
    private readonly postImportRepository: VkParsingPostImportRepository,
    configService: ConfigService,
    private readonly ownership: VkParsingOwnershipService,
  ) {
    this.syncIntervalMs = configService.get<number>('VK_PARSING_SYNC_INTERVAL_MS') ?? 600_000;
    this.minSyncIntervalMs =
      configService.get<number>('VK_PARSING_MIN_SYNC_INTERVAL_MS') ?? 120_000;
    this.maxSyncIntervalMs =
      configService.get<number>('VK_PARSING_MAX_SYNC_INTERVAL_MS') ?? 3_600_000;
    this.fetchCount = configService.get<number>('VK_PARSING_FETCH_COUNT') ?? 100;
    this.minFetchPages = configService.get<number>('VK_PARSING_MIN_PAGES') ?? 3;
    this.maxFetchPages = Math.max(
      this.minFetchPages,
      configService.get<number>('VK_PARSING_MAX_PAGES') ?? 5,
    );
    this.missingConfirmationThreshold =
      configService.get<number>('VK_PARSING_MISSING_CONFIRMATION_THRESHOLD') ?? 3;
    this.syncLeaseTtlMs = configService.get<number>('VK_PARSING_LEASE_TTL_MS') ?? 120_000;
    this.mediaConcurrency = configService.get<number>('VK_PARSING_MEDIA_CONCURRENCY') ?? 3;
    this.sourceCircuitTerminalFailureThreshold = Math.max(
      1,
      configService.get<number>('VK_PARSING_SOURCE_CIRCUIT_TERMINAL_FAILURE_THRESHOLD') ?? 1,
    );
  }

  getSyncIntervalMs(): number {
    return this.syncIntervalMs;
  }

  getSchedulerIntervalMs(): number {
    return Math.min(this.syncIntervalMs, this.minSyncIntervalMs);
  }

  async processSyncSourceJob(
    sourceId: string,
    reason: VkParsingSyncReason = 'scheduled',
  ): Promise<number> {
    const source = await this.acquireSourceLease(sourceId);
    if (!source) {
      return 0;
    }

    return this.syncSource(source, reason);
  }

  private async syncSource(
    source: VkParsingSourceRow,
    reason: VkParsingSyncReason,
  ): Promise<number> {
    const startedAt = new Date();
    try {
      const wallPages = await this.fetchWallPages(source, reason);
      if (wallPages.leaseLost) {
        return 0;
      }
      const posts = wallPages.posts;

      if (!(await this.recordSourceHeartbeat(source))) {
        return 0;
      }
      const importResult = await this.importPostsWithPolicyFence(source, posts, startedAt, reason);
      await this.postImportRepository.markMissingPostsUnavailable(source, posts, startedAt, {
        missingConfirmationThreshold: this.missingConfirmationThreshold,
        spotCheckMissingPosts: (missingPosts) => this.spotCheckMissingPosts(missingPosts),
        runWithLease: (operation) => this.runWithSourceLease(source, operation),
      });
      if (!(await this.recordSourceHeartbeat(source))) {
        return 0;
      }
      if (importResult.publishCandidates.length > 0) {
        await this.publishService.enqueueAutoPublishImportedPosts(
          source.chatId,
          importResult.publishCandidates,
          source,
        );
      }
      const completedAt = new Date();
      const adaptiveIntervalMs = this.resolveAdaptiveSyncIntervalMs(source, posts, completedAt);
      const newestPost = this.resolveNewestPost(posts);

      const completed = await this.runWithSourceLease(source, (tx) =>
        tx.vkParsingSource.updateMany({
          where: this.buildOwnedSourceLeaseWhere(source),
          data: {
            syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
            nextSyncAt: new Date(completedAt.getTime() + adaptiveIntervalMs),
            lastSyncAt: completedAt,
            lastSuccessAt: completedAt,
            syncStartedAt: null,
            syncLockedAt: null,
            syncLockedBy: null,
            syncLockDeadlineAt: null,
            syncHeartbeatAt: null,
            consecutiveFailures: 0,
            terminalFailureCount: 0,
            circuitOpenedAt: null,
            circuitReasonCode: null,
            circuitReason: null,
            circuitRetryAt: null,
            lastErrorCode: null,
            lastImportedCount: importResult.imported,
            lastFetchedCount: posts.length,
            lastFetchedPages: wallPages.pages,
            lastFetchedOffsets: this.toJsonInput(wallPages.offsets),
            lastVkNewestPostId: newestPost?.vkPostId ?? source.lastVkNewestPostId,
            lastVkNewestPublishedAt: newestPost?.vkPublishedAt ?? source.lastVkNewestPublishedAt,
            adaptiveIntervalMs,
            lastSyncDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
            lastError: null,
          },
        }),
      );
      if (completed.count === 0) {
        return 0;
      }
      if (reason !== 'source-added') {
        void this.preflightPostMediaSafely(source, importResult.mediaPreflightPosts);
      }
      return importResult.imported;
    } catch (error) {
      if (error instanceof VkSyncLeaseLostError) return 0;
      const completedAt = new Date();
      const classified = classifyVkParsingSyncError(error);
      const failureCount = source.consecutiveFailures + 1;
      const isCircuitBreakerFailure = this.isSourceCircuitBreakerFailure(classified);
      const terminalFailureCount = isCircuitBreakerFailure ? source.terminalFailureCount + 1 : 0;
      const openCircuit =
        isCircuitBreakerFailure &&
        terminalFailureCount >= this.sourceCircuitTerminalFailureThreshold;
      const retryTerminalBeforeCircuit = isCircuitBreakerFailure && !openCircuit;
      const backoffMs =
        classified.retryable || retryTerminalBeforeCircuit
          ? this.resolveSyncBackoffMs(failureCount)
          : null;
      const providerRetryAtMs = classified.retryable
        ? readVkRetryAtMs(classified.retryAtMs)
        : undefined;
      const nextRetryAt =
        backoffMs === null
          ? null
          : new Date(Math.max(completedAt.getTime() + backoffMs, providerRetryAtMs ?? 0));
      const failed = await this.runWithSourceLease(source, (tx) =>
        tx.vkParsingSource.updateMany({
          where: this.buildOwnedSourceLeaseWhere(source),
          data: {
            syncStatus:
              backoffMs !== null ? VK_SOURCE_SYNC_STATUS_BACKOFF : VK_SOURCE_SYNC_STATUS_ERROR,
            nextSyncAt: nextRetryAt,
            lastSyncAt: completedAt,
            syncStartedAt: null,
            syncLockedAt: null,
            syncLockedBy: null,
            syncLockDeadlineAt: null,
            syncHeartbeatAt: null,
            consecutiveFailures: failureCount,
            terminalFailureCount,
            circuitOpenedAt: openCircuit ? completedAt : null,
            circuitReasonCode: openCircuit ? classified.code : null,
            circuitReason: openCircuit ? classified.message : null,
            circuitRetryAt: retryTerminalBeforeCircuit ? nextRetryAt : null,
            lastErrorCode: classified.code,
            lastImportedCount: 0,
            lastFetchedCount: 0,
            lastSyncDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
            lastError: classified.message,
          },
        }),
      ).catch((failure: unknown) => {
        if (failure instanceof VkSyncLeaseLostError) return { count: 0 };
        throw failure;
      });
      if (failed.count === 0) {
        return 0;
      }
      this.logDedupedWarning(
        `vk-sync:${source.id}:${classified.code}`,
        {
          sourceId: source.id,
          chatId: source.chatId,
          reason: classified.code,
          retryable: classified.retryable,
          circuitOpen: openCircuit,
          terminalFailureCount,
          err: error,
        },
        'VK sync failed',
      );
      return 0;
    }
  }

  private async fetchWallPages(
    source: VkParsingSourceRow,
    reason: VkParsingSyncReason,
  ): Promise<{
    posts: NormalizedVkPost[];
    pages: number;
    offsets: number[];
    leaseLost: boolean;
  }> {
    const postsByKey = new Map<string, NormalizedVkPost>();
    const offsets: number[] = [];
    const maxPages = this.resolveFetchPageLimit(source, reason);
    const minPages = Math.min(this.minFetchPages, maxPages);

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const offset = pageIndex * this.fetchCount;
      offsets.push(offset);
      const wall = await this.fetchWall({
        ownerId: source.wallOwnerId,
        count: this.fetchCount,
        offset,
      });
      if (!(await this.recordSourceHeartbeat(source))) {
        return { posts: [], pages: offsets.length, offsets, leaseLost: true };
      }
      const enrichedItems = await this.enrichPostsWithVideoFiles(wall.items ?? [], async () => {
        if (!(await this.recordSourceHeartbeat(source))) throw new VkSyncLeaseLostError();
      });
      const pagePosts = enrichedItems
        .map((item) => this.normalizePost(item))
        .filter(
          (post): post is NormalizedVkPost =>
            post !== null && post.vkOwnerId === source.wallOwnerId,
        );
      for (const post of pagePosts) {
        postsByKey.set(this.buildPostKey(post.vkOwnerId, post.vkPostId), post);
      }

      const fetchedPages = pageIndex + 1;
      if (fetchedPages < minPages) {
        if ((wall.items ?? []).length === 0) {
          break;
        }
        continue;
      }
      if ((wall.items ?? []).length < this.fetchCount) {
        break;
      }
      if (
        typeof source.lastVkNewestPostId === 'number' &&
        pagePosts.some((post) => post.vkPostId === source.lastVkNewestPostId)
      ) {
        break;
      }
    }

    return {
      posts: [...postsByKey.values()],
      pages: offsets.length,
      offsets,
      leaseLost: false,
    };
  }

  private resolveFetchPageLimit(source: VkParsingSourceRow, reason: VkParsingSyncReason): number {
    if (reason === 'source-added' || reason === 'manual' || !source.lastSuccessAt) {
      return this.maxFetchPages;
    }
    return Math.max(this.minFetchPages, Math.min(this.maxFetchPages, 3));
  }

  private resolveNewestPost(posts: NormalizedVkPost[]): NormalizedVkPost | null {
    return posts.reduce<NormalizedVkPost | null>((newest, post) => {
      if (!newest) {
        return post;
      }
      const left = post.vkPublishedAt?.getTime() ?? 0;
      const right = newest.vkPublishedAt?.getTime() ?? 0;
      return left > right || (left === right && post.vkPostId > newest.vkPostId) ? post : newest;
    }, null);
  }

  private resolveAdaptiveSyncIntervalMs(
    source: VkParsingSourceRow,
    posts: NormalizedVkPost[],
    now: Date,
  ): number {
    const newestPost = this.resolveNewestPost(posts);
    const newestAgeMs = newestPost?.vkPublishedAt
      ? Math.max(0, now.getTime() - newestPost.vkPublishedAt.getTime())
      : Number.POSITIVE_INFINITY;
    const sourceIntervalMs = this.syncIntervalMs;
    let baseMs = sourceIntervalMs;
    if (newestAgeMs <= 60 * 60_000) {
      baseMs = this.minSyncIntervalMs;
    } else if (newestAgeMs <= 6 * 60 * 60_000) {
      baseMs = Math.max(this.minSyncIntervalMs, Math.floor(sourceIntervalMs / 2));
    } else if (newestAgeMs >= 7 * 24 * 60 * 60_000) {
      baseMs = this.maxSyncIntervalMs;
    } else if (newestAgeMs >= 24 * 60 * 60_000) {
      baseMs = Math.min(this.maxSyncIntervalMs, sourceIntervalMs * 3);
    }

    const bounded = Math.max(this.minSyncIntervalMs, Math.min(this.maxSyncIntervalMs, baseMs));
    return Math.max(this.minSyncIntervalMs, bounded + this.resolveSourceJitterMs(source.id));
  }

  private resolveSourceJitterMs(sourceId: string): number {
    const hash = createHash('sha256').update(sourceId).digest();
    const ratio = hash[0]! / 255;
    return Math.floor((ratio - 0.5) * Math.min(30_000, this.syncIntervalMs * 0.1));
  }

  private async importPostsWithPolicyFence(
    source: VkParsingSourceRow,
    posts: NormalizedVkPost[],
    seenAt: Date,
    reason: VkParsingSyncReason,
  ): Promise<ImportedPostsBatchResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const lockedChats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "chats" AS chat
          WHERE chat."id" = ${source.chatId}
          FOR UPDATE OF chat
        `);
        if (lockedChats.length !== 1) {
          return this.emptyImportedPostsBatchResult();
        }

        await lockVkSyncLease(tx, source);
        const currentSource = await tx.vkParsingSource.findFirst({
          where: {
            id: source.id,
            chatId: source.chatId,
            ownerProfile: source.ownerProfile,
            ownerBotId: source.ownerBotId,
          },
        });
        if (!currentSource) {
          return this.emptyImportedPostsBatchResult();
        }

        const autoPublishImportBaseline = await this.resolveAutoPublishImportBaseline(
          currentSource,
          reason,
          tx,
        );
        const reviewSettings =
          currentSource.publishMode === VK_BOT_REVIEW_MODE &&
          currentSource.status === 'ACTIVE' &&
          currentSource.importEnabled &&
          currentSource.lastSuccessAt &&
          currentSource.botReviewEnabledAt &&
          reason !== 'source-added'
            ? await tx.vkParsingSettings.findUnique({
                where: {
                  chatId_ownerProfile_ownerBotId: {
                    chatId: currentSource.chatId,
                    ownerProfile: currentSource.ownerProfile,
                    ownerBotId: currentSource.ownerBotId,
                  },
                },
              })
            : null;
        return this.upsertPostsBatch(
          currentSource,
          posts,
          seenAt,
          autoPublishImportBaseline,
          tx,
          reviewSettings?.botReviewRecipientUserId && currentSource.botReviewEnabledAt
            ? {
                recipientUserId: reviewSettings.botReviewRecipientUserId,
                baseline: currentSource.botReviewEnabledAt,
              }
            : undefined,
        );
      },
      {
        maxWait: VK_IMPORT_POLICY_TRANSACTION_MAX_WAIT_MS,
        timeout: VK_IMPORT_POLICY_TRANSACTION_TIMEOUT_MS,
      },
    );
  }

  private emptyImportedPostsBatchResult(): ImportedPostsBatchResult {
    return {
      imported: 0,
      importedPosts: [],
      publishCandidates: [],
      mediaPreflightPosts: [],
    };
  }

  private async upsertPostsBatch(
    source: VkParsingSourceRow,
    posts: NormalizedVkPost[],
    seenAt: Date,
    autoPublishImportBaseline: Date | null,
    database: VkParsingPostImportDatabase = this.prisma,
    botReview?: { recipientUserId: string; baseline: Date },
  ): Promise<ImportedPostsBatchResult> {
    const existingRows = await this.postImportRepository.findExistingPosts(source, posts, database);
    const existingByPostKey = new Map(
      existingRows.map((row) => [this.buildPostKey(row.vkOwnerId, row.vkPostId), row]),
    );

    const mediaPreflightPosts: NormalizedVkPost[] = [];
    const preparedPosts = posts.map((post): PreparedVkPostImport => {
      const existing = existingByPostKey.get(this.buildPostKey(post.vkOwnerId, post.vkPostId));
      const status = this.resolveImportedPostStatus(existing ?? null, post);
      if (!existing || existing.contentHash !== post.contentHash) {
        mediaPreflightPosts.push(post);
      }
      return {
        post,
        status,
        publishScheduleFingerprint: existing
          ? (existing.publishScheduleFingerprint ?? null)
          : this.isNewPostEligibleForAutoPublish(post, autoPublishImportBaseline)
            ? VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT
            : null,
      };
    });

    await this.postImportRepository.persistImportedPosts(source, preparedPosts, seenAt, database);

    // FLAG: Only first-seen posts inside the explicit review baseline get a durable inbox item.
    if (botReview) {
      const newIds = posts
        .filter(
          (post) =>
            !existingByPostKey.has(this.buildPostKey(post.vkOwnerId, post.vkPostId)) &&
            post.vkPublishedAt &&
            post.vkPublishedAt >= botReview.baseline,
        )
        .map((post) => post.vkPostId);
      if (newIds.length) {
        const reviewPosts = await database.vkParsingPost.findMany({
          where: {
            sourceId: source.id,
            ownerProfile: source.ownerProfile,
            ownerBotId: source.ownerBotId,
            vkPostId: { in: newIds },
            status: 'NEW',
          },
          select: { id: true },
        });
        await database.vkBotReview.createMany({
          data: reviewPosts.map((post) => ({
            postId: post.id,
            recipientUserId: botReview.recipientUserId,
          })),
          skipDuplicates: true,
        });
      }
    }

    const importedCount = posts.filter(
      (post) => !existingByPostKey.has(this.buildPostKey(post.vkOwnerId, post.vkPostId)),
    ).length;
    const importedPosts = autoPublishImportBaseline
      ? await database.vkParsingPost.findMany({
          where: {
            sourceId: source.id,
            chatId: source.chatId,
            ownerProfile: source.ownerProfile,
            ownerBotId: source.ownerBotId,
            vkOwnerId: source.wallOwnerId,
            status: VK_POST_STATUS_NEW,
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishLockedAt: null,
            publishAttemptCount: 0,
            publishIdempotencyKey: null,
            publishReason: null,
            publishCancelledAt: null,
            publishCancelledByUserId: null,
            publishActorUserId: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
            publishScheduleFingerprint: { not: null },
            vkPublishedAt: { gte: autoPublishImportBaseline },
          },
          include: { source: true },
          orderBy: [{ vkPublishedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          take: VK_AUTOPUBLISH_PENDING_RECOVERY_BATCH_SIZE,
        })
      : [];

    return {
      imported: importedCount,
      importedPosts,
      publishCandidates: importedPosts,
      mediaPreflightPosts,
    };
  }

  private async acquireSourceLease(sourceId: string): Promise<VkParsingSourceRow | null> {
    const now = new Date();
    const attemptToken = randomUUID();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const syncLockDeadlineAt = new Date(now.getTime() + this.syncLeaseTtlMs);
    const ownerScope = this.ownership.getPublisherScope();
    const updated = await this.prisma.vkParsingSource.updateMany({
      where: {
        id: sourceId,
        ...ownerScope,
        status: VK_SOURCE_STATUS_ACTIVE,
        importEnabled: true,
        circuitOpenedAt: null,
        OR: [
          { syncLockedAt: null },
          { syncLockDeadlineAt: { lt: now } },
          {
            syncLockDeadlineAt: null,
            syncLockedAt: { lt: staleLockBefore },
          },
        ],
      },
      data: {
        syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
        syncStartedAt: now,
        syncLockedAt: now,
        syncLockedBy: attemptToken,
        syncLockDeadlineAt,
        syncHeartbeatAt: now,
        syncAttemptCount: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      return null;
    }

    const source = await this.prisma.vkParsingSource.findUnique({
      where: {
        id: sourceId,
        ...ownerScope,
        status: VK_SOURCE_STATUS_ACTIVE,
        importEnabled: true,
        syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
        syncLockedBy: attemptToken,
        syncLockDeadlineAt: { gt: new Date() },
      },
    });
    if (!source || !this.ownership.isExactScope(source, ownerScope)) {
      return null;
    }

    return { ...source, syncLockedBy: attemptToken };
  }

  private async recordSourceHeartbeat(source: VkSyncLease): Promise<boolean> {
    const now = new Date();
    const updated = await this.runWithSourceLease(source, (tx) =>
      tx.vkParsingSource.updateMany({
        where: this.buildOwnedSourceLeaseWhere(source),
        data: {
          syncHeartbeatAt: now,
          syncLockDeadlineAt: new Date(now.getTime() + this.syncLeaseTtlMs),
        },
      }),
    ).catch((error: unknown) => {
      if (error instanceof VkSyncLeaseLostError) return { count: 0 };
      throw error;
    });
    return updated.count > 0;
  }

  private runWithSourceLease<T>(
    source: VkSyncLease,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await lockVkSyncLease(tx, source);
        return operation(tx);
      },
      {
        maxWait: VK_IMPORT_POLICY_TRANSACTION_MAX_WAIT_MS,
        timeout: VK_IMPORT_POLICY_TRANSACTION_TIMEOUT_MS,
      },
    );
  }

  private buildOwnedSourceLeaseWhere(source: VkSyncLease): Prisma.VkParsingSourceWhereInput {
    return {
      id: source.id,
      chatId: source.chatId,
      ownerProfile: source.ownerProfile,
      ownerBotId: source.ownerBotId,
      status: VK_SOURCE_STATUS_ACTIVE,
      importEnabled: true,
      syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
      syncLockedBy: source.syncLockedBy,
      syncAttemptCount: source.syncAttemptCount,
    };
  }

  private resolveImportedPostStatus(
    existing: ExistingVkPostImportState | null,
    post: NormalizedVkPost,
  ): string {
    if (!existing) {
      return VK_POST_STATUS_NEW;
    }

    const publishedHash =
      existing.publishedContentHash ||
      (existing.status === VK_POST_STATUS_PUBLISHED ? existing.contentHash : null);
    if (
      publishedHash &&
      publishedHash !== post.contentHash &&
      (existing.status === VK_POST_STATUS_PUBLISHED ||
        existing.status === VK_POST_STATUS_CHANGED_AFTER_PUBLISH)
    ) {
      return VK_POST_STATUS_CHANGED_AFTER_PUBLISH;
    }

    if (existing.status === VK_POST_STATUS_UNAVAILABLE) {
      return VK_POST_STATUS_NEW;
    }

    if (existing.status === VK_POST_STATUS_SKIPPED && existing.contentHash !== post.contentHash) {
      return VK_POST_STATUS_NEW;
    }

    return existing.status || VK_POST_STATUS_NEW;
  }

  private async spotCheckMissingPosts(
    posts: Array<{ vkOwnerId: number; vkPostId: number }>,
  ): Promise<Set<string> | null> {
    try {
      return await this.fetchWallPostKeySet(posts);
    } catch (error) {
      // FLAG: Auth, captcha and access failures never prove that a post was deleted.
      this.logger.warn({ err: error }, 'VK missing post spot-check failed');
      return null;
    }
  }

  private async resolveAutoPublishImportBaseline(
    source: Pick<
      VkParsingSourceRow,
      | 'chatId'
      | 'ownerProfile'
      | 'ownerBotId'
      | 'status'
      | 'importEnabled'
      | 'autoPublishEnabled'
      | 'autoPublishEnabledAt'
      | 'autoPublishPausedAt'
      | 'publishMode'
      | 'lastSuccessAt'
    >,
    reason: VkParsingSyncReason,
    database: Pick<Prisma.TransactionClient, 'vkParsingSettings'> = this.prisma,
  ): Promise<Date | null> {
    if (
      reason === 'source-added' ||
      !source.lastSuccessAt ||
      source.status !== VK_SOURCE_STATUS_ACTIVE ||
      source.importEnabled !== true ||
      source.autoPublishEnabled !== true ||
      Boolean(source.autoPublishPausedAt) ||
      isVkManualReviewMode(source.publishMode)
    ) {
      return null;
    }

    const settings = await database.vkParsingSettings.findUnique({
      where: {
        chatId_ownerProfile_ownerBotId: {
          chatId: source.chatId,
          ownerProfile: source.ownerProfile,
          ownerBotId: source.ownerBotId,
        },
      },
      select: {
        autoPublishEnabled: true,
        autoPublishEnabledAt: true,
      },
    });
    if (settings?.autoPublishEnabled !== true || !settings.autoPublishEnabledAt) {
      return null;
    }

    const sourceBaseline = source.autoPublishEnabledAt ?? settings.autoPublishEnabledAt;
    return sourceBaseline.getTime() > settings.autoPublishEnabledAt.getTime()
      ? sourceBaseline
      : settings.autoPublishEnabledAt;
  }

  private isNewPostEligibleForAutoPublish(
    post: Pick<NormalizedVkPost, 'vkPublishedAt'>,
    baseline: Date | null,
  ): boolean {
    return Boolean(
      baseline && post.vkPublishedAt && post.vkPublishedAt.getTime() >= baseline.getTime(),
    );
  }

  private resolveSyncBackoffMs(failureCount: number): number {
    const baseMs = 60_000;
    const cappedFailureCount = Math.max(0, Math.min(6, failureCount - 1));
    const jitterMs = Math.floor(Math.random() * 5_000);
    return Math.min(60 * 60_000, baseMs * 2 ** cappedFailureCount + jitterMs);
  }

  private isSourceCircuitBreakerFailure(classified: { code: string; retryable: boolean }): boolean {
    return !classified.retryable && classified.code.startsWith('vk_api.');
  }

  private buildPostKey(ownerId: number, postId: number): string {
    return `${ownerId}:${postId}`;
  }

  private normalizePost(value: unknown): NormalizedVkPost | null {
    const post = this.asRecord(value);
    if (!post) {
      return null;
    }

    const vkOwnerId = this.readNumber(post.owner_id);
    const vkPostId = this.readNumber(post.id);
    if (typeof vkOwnerId !== 'number' || typeof vkPostId !== 'number') {
      return null;
    }

    const attachments = this.readAttachments(post.attachments);
    const text = this.readString(post.text);
    const parsedAttachments = parseVkWallPostAttachments({
      attachments,
      rawPost: post,
      text,
      maxPhotos: VK_PARSING_MAX_PHOTOS,
      maxLinks: VK_PARSING_MAX_LINKS,
    });
    const { videoUrls } = parsedAttachments;
    const photoUrls = videoUrls.length > 0 ? [] : parsedAttachments.photoUrls;
    const photoMedia = videoUrls.length > 0 ? [] : parsedAttachments.photoMedia;
    const fallbackLinkUrls = this.resolveUnsupportedVideoFallbackLinks({
      postUrl: `https://vk.ru/wall${vkOwnerId}_${vkPostId}`,
      text,
      parsedAttachments,
      photoUrls,
      videoUrls,
    });
    const linkUrls = this.uniqueStrings([...parsedAttachments.linkUrls, ...fallbackLinkUrls]).slice(
      0,
      VK_PARSING_MAX_LINKS,
    );
    if (
      !text.trim() &&
      photoUrls.length === 0 &&
      videoUrls.length === 0 &&
      linkUrls.length === 0 &&
      !parsedAttachments.hasUnsupportedAttachments
    ) {
      return null;
    }

    const publishedSeconds = this.readNumber(post.date);
    const vkPublishedAt =
      typeof publishedSeconds === 'number' && publishedSeconds > 0
        ? new Date(publishedSeconds * 1_000)
        : null;

    return {
      vkOwnerId,
      vkPostId,
      vkPublishedAt,
      text,
      textFormat: resolveEffectiveVkParsingTextFormat({ text, textFormat: 'plain' }),
      url: `https://vk.ru/wall${vkOwnerId}_${vkPostId}`,
      photoUrls,
      videoUrls,
      linkUrls,
      attachments,
      attachmentTypes: parsedAttachments.attachmentTypes,
      unsupportedAttachments: parsedAttachments.unsupportedAttachments,
      hasUnsupportedAttachments: parsedAttachments.hasUnsupportedAttachments,
      isAdvertising: parsedAttachments.isAdvertising,
      advertisingMarkers: parsedAttachments.advertisingMarkers,
      photoMedia,
      videoMedia: parsedAttachments.videoMedia,
      copyHistoryText: parsedAttachments.copyHistoryText,
      raw: post,
      contentHash: computeVkParsingPostContentHash({
        text,
        photoUrls,
        videoUrls,
        linkUrls,
        attachmentTypes: parsedAttachments.attachmentTypes,
        unsupportedAttachments: parsedAttachments.unsupportedAttachments,
        copyHistoryText: parsedAttachments.copyHistoryText,
        advertisingMarkers: parsedAttachments.advertisingMarkers,
      }),
    };
  }

  private readAttachments(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  private resolveUnsupportedVideoFallbackLinks(params: {
    postUrl: string;
    text: string;
    parsedAttachments: Pick<
      ReturnType<typeof parseVkWallPostAttachments>,
      'unsupportedAttachments' | 'hasUnsupportedAttachments' | 'linkUrls'
    >;
    photoUrls: string[];
    videoUrls: string[];
  }): string[] {
    if (
      params.text.trim() ||
      params.photoUrls.length > 0 ||
      params.videoUrls.length > 0 ||
      params.parsedAttachments.linkUrls.length > 0
    ) {
      return [];
    }
    const unsupportedVideo = params.parsedAttachments.unsupportedAttachments.some(
      (item) => item.type === 'video' || item.type === 'clip',
    );
    if (!unsupportedVideo) {
      return [];
    }

    return [params.postUrl];
  }

  private async fetchWall(options: {
    domain?: string;
    ownerId?: number;
    count: number;
    offset?: number;
  }): Promise<VkWallGetResponse> {
    const params: Record<string, string> = {
      count: String(Math.max(1, Math.min(options.count, 100))),
      filter: 'owner',
      extended: '1',
    };
    if (options.domain) {
      params.domain = options.domain;
    }
    if (typeof options.ownerId === 'number') {
      params.owner_id = String(options.ownerId);
    }
    if (typeof options.offset === 'number' && options.offset > 0) {
      params.offset = String(Math.max(0, Math.trunc(options.offset)));
    }

    const response = await this.vkApiClient.request('wall.get', params);
    if (!this.asRecord(response) || !Array.isArray(this.asRecord(response)?.items)) {
      throw new VkApiRequestError('VK вернул неполную стену.', 'invalid_response', true);
    }

    return response as VkWallGetResponse;
  }

  private async fetchWallPostKeySet(
    posts: Array<{ vkOwnerId: number; vkPostId: number }>,
  ): Promise<Set<string>> {
    if (posts.length === 0) {
      return new Set();
    }
    const found = new Set<string>();
    for (let offset = 0; offset < posts.length; offset += 100) {
      const requestedKeys = new Set(
        posts.slice(offset, offset + 100).map((post) => `${post.vkOwnerId}_${post.vkPostId}`),
      );
      const response = await this.vkApiClient.request('wall.getById', {
        posts: [...requestedKeys].join(','),
        extended: '0',
      });
      const record = this.asRecord(response);
      const items = Array.isArray(response) ? response : record?.items;
      if (!Array.isArray(items)) {
        throw new VkApiRequestError('VK вернул неполный список постов.', 'invalid_response', true);
      }
      for (const item of items) {
        const post = this.asRecord(item);
        const ownerId = this.readNumber(post?.owner_id);
        const postId = this.readNumber(post?.id);
        if (
          !Number.isSafeInteger(ownerId) ||
          !ownerId ||
          !Number.isSafeInteger(postId) ||
          !postId ||
          postId < 0 ||
          !requestedKeys.has(`${ownerId}_${postId}`)
        ) {
          throw new VkApiRequestError('VK вернул неполный пост.', 'invalid_response', true);
        }
        if (post?.is_deleted !== 1) found.add(this.buildPostKey(ownerId, postId));
      }
    }

    return found;
  }

  private async enrichPostsWithVideoFiles(
    items: unknown[],
    heartbeat?: () => Promise<void>,
  ): Promise<unknown[]> {
    const videoRefs = this.collectVideoReferencesNeedingFiles(items);
    if (videoRefs.length === 0) {
      return items;
    }

    let videosByKey: Map<string, Record<string, unknown>>;
    try {
      videosByKey = await this.fetchVideoDetails(videoRefs, heartbeat);
    } catch (error) {
      if (error instanceof VkSyncLeaseLostError) throw error;
      this.logDedupedWarning(
        'vk-video-details',
        { reason: 'vk_video_details_failed', retryable: true, err: error },
        'VK video details fetch failed',
      );
      return items;
    }

    if (videosByKey.size === 0) {
      return items;
    }

    return items.map((item) => this.enrichPostWithVideoDetails(item, videosByKey));
  }

  private collectVideoReferencesNeedingFiles(items: unknown[]): VkVideoReference[] {
    const refsByKey = new Map<string, VkVideoReference>();
    for (const item of items) {
      this.collectVideoReferencesFromPost(item, refsByKey);
    }
    return [...refsByKey.values()];
  }

  private collectVideoReferencesFromPost(
    value: unknown,
    refsByKey: Map<string, VkVideoReference>,
  ): void {
    const post = this.asRecord(value);
    if (!post) {
      return;
    }

    this.collectVideoReferencesFromAttachments(post.attachments, refsByKey);
    const copyHistory = Array.isArray(post.copy_history) ? post.copy_history : [];
    for (const copy of copyHistory) {
      this.collectVideoReferencesFromPost(copy, refsByKey);
    }
  }

  private collectVideoReferencesFromAttachments(
    attachments: unknown,
    refsByKey: Map<string, VkVideoReference>,
  ): void {
    for (const attachment of this.readAttachments(attachments)) {
      if (this.readString(attachment.type).toLowerCase() !== 'video') {
        continue;
      }
      const video = this.asRecord(attachment.video);
      if (!video || this.hasSupportedVideoFile(video)) {
        continue;
      }

      const ownerId = this.readNumber(video.owner_id);
      const videoId = this.readNumber(video.id);
      if (typeof ownerId !== 'number' || typeof videoId !== 'number') {
        continue;
      }

      const accessKey = this.readString(video.access_key) || null;
      const key = this.buildVideoReferenceKey({ ownerId, videoId, accessKey });
      refsByKey.set(key, { ownerId, videoId, accessKey });
    }
  }

  private async fetchVideoDetails(
    refs: VkVideoReference[],
    heartbeat?: () => Promise<void>,
  ): Promise<Map<string, Record<string, unknown>>> {
    const videosByKey = new Map<string, Record<string, unknown>>();
    const chunkSize = 100;
    for (let index = 0; index < refs.length; index += chunkSize) {
      const chunk = refs.slice(index, index + chunkSize);
      const response = await this.vkApiClient.request('video.get', {
        videos: chunk.map((ref) => this.formatVideoReference(ref)).join(','),
        extended: '0',
      });
      await heartbeat?.();
      const record = this.asRecord(response);
      const items = Array.isArray(record?.items)
        ? record.items
        : Array.isArray(response)
          ? response
          : [];
      for (const item of items) {
        const video = this.asRecord(item);
        if (!video || !this.hasSupportedVideoFile(video)) {
          continue;
        }
        const ownerId = this.readNumber(video.owner_id);
        const videoId = this.readNumber(video.id);
        if (typeof ownerId !== 'number' || typeof videoId !== 'number') {
          continue;
        }
        const accessKey = this.readString(video.access_key) || null;
        videosByKey.set(this.buildVideoReferenceKey({ ownerId, videoId, accessKey }), video);
        videosByKey.set(this.buildVideoReferenceKey({ ownerId, videoId, accessKey: null }), video);
      }
    }
    return videosByKey;
  }

  private enrichPostWithVideoDetails(
    value: unknown,
    videosByKey: Map<string, Record<string, unknown>>,
  ): unknown {
    const post = this.asRecord(value);
    if (!post) {
      return value;
    }

    const enrichedPost: Record<string, unknown> = {
      ...post,
      attachments: this.enrichAttachmentsWithVideoDetails(post.attachments, videosByKey),
    };
    if (Array.isArray(post.copy_history)) {
      enrichedPost.copy_history = post.copy_history.map((copy) =>
        this.enrichPostWithVideoDetails(copy, videosByKey),
      );
    }
    return enrichedPost;
  }

  private enrichAttachmentsWithVideoDetails(
    attachments: unknown,
    videosByKey: Map<string, Record<string, unknown>>,
  ): unknown {
    if (!Array.isArray(attachments)) {
      return attachments;
    }

    return attachments.map((item) => {
      const attachment = this.asRecord(item);
      if (!attachment || this.readString(attachment.type).toLowerCase() !== 'video') {
        return item;
      }
      const video = this.asRecord(attachment.video);
      if (!video || this.hasSupportedVideoFile(video)) {
        return item;
      }

      const ownerId = this.readNumber(video.owner_id);
      const videoId = this.readNumber(video.id);
      if (typeof ownerId !== 'number' || typeof videoId !== 'number') {
        return item;
      }
      const accessKey = this.readString(video.access_key) || null;
      const details =
        videosByKey.get(this.buildVideoReferenceKey({ ownerId, videoId, accessKey })) ??
        videosByKey.get(this.buildVideoReferenceKey({ ownerId, videoId, accessKey: null }));
      if (!details) {
        return item;
      }

      return {
        ...attachment,
        video: {
          ...video,
          ...details,
        },
      };
    });
  }

  private hasSupportedVideoFile(video: Record<string, unknown>): boolean {
    const files = this.asRecord(video.files);
    if (!files) {
      return false;
    }

    return Object.entries(files).some(([key, value]) => {
      if (!/^mp4_\d+$/u.test(key.trim().toLowerCase())) {
        return false;
      }
      const url = this.readString(value);
      return /^https:\/\//iu.test(url);
    });
  }

  private formatVideoReference(ref: VkVideoReference): string {
    const base = `${ref.ownerId}_${ref.videoId}`;
    return ref.accessKey ? `${base}_${ref.accessKey}` : base;
  }

  private buildVideoReferenceKey(ref: VkVideoReference): string {
    return `${ref.ownerId}:${ref.videoId}:${ref.accessKey ?? ''}`;
  }

  private async preflightPostMediaSafely(
    source: Pick<VkParsingSourceRow, 'id' | 'chatId'>,
    posts: NormalizedVkPost[],
  ): Promise<void> {
    const photoUrls = [...new Set(posts.flatMap((post) => post.photoUrls))];
    if (photoUrls.length === 0) {
      return;
    }
    const mediaIdentityByUrl = new Map(
      posts.flatMap((post) =>
        post.photoMedia.map((item) => [item.url, item.mediaIdentity] as const),
      ),
    );

    try {
      await this.mapWithConcurrency(photoUrls, this.mediaConcurrency, async (url) => {
        await this.mediaCache.preflightMediaUrl(url, mediaIdentityByUrl.get(url) ?? null);
      });
    } catch (error) {
      const classified = classifyVkParsingMediaPreflightError(error);
      this.logDedupedWarning(
        `vk-media-preflight:${source.id}:${classified.code}`,
        {
          sourceId: source.id,
          chatId: source.chatId,
          reason: classified.code,
          retryable: classified.retryable,
          err: error,
        },
        'VK media preflight failed unexpectedly after per-url safeguards',
      );
    }
  }

  private async mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          await worker(items[index]!, index);
        }
      }),
    );
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private logDedupedWarning(key: string, context: Record<string, unknown>, message: string): void {
    const now = Date.now();
    const current = this.warningDedupe.get(key);
    if (current && now - current.loggedAtMs < VK_PARSING_WARNING_DEDUPE_MS) {
      current.suppressed += 1;
      return;
    }

    const suppressedSimilarWarnings = current?.suppressed ?? 0;
    this.warningDedupe.set(key, { loggedAtMs: now, suppressed: 0 });
    this.logger.warn(
      {
        ...context,
        ...(suppressedSimilarWarnings > 0 ? { suppressedSimilarWarnings } : {}),
      },
      message,
    );
  }
}
