import {
  VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
  type VkParsingCapability,
  type VkParsingFeed,
  type VkParsingFeedQuery,
  type VkParsingHealthSummary,
  type VkParsingPost,
  type VkParsingSettings,
  type VkParsingSource,
  vkParsingFeedQuerySchema,
  vkBotReviewSummarySchema,
} from '@maxim/contracts';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveEffectiveVkParsingTextFormat } from './vk-parsing-content';
import { VK_MEDIA_STATUS_FAILED } from './vk-parsing-media-cache.service';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';
import type { VkParsingUnsupportedAttachmentSummary } from './vk-parsing-attachments';
import type { VkParsingOwnerScope } from './vk-parsing-ownership.service';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;
const feedPostOmit = { raw: true, attachments: true, publishDialogContext: true } as const;
type VkParsingPostWithSource = Prisma.VkParsingPostGetPayload<{
  omit: typeof feedPostOmit;
  include: { source: true };
}> & {
  botReview?: { status: string; deliveryState: string; lastError: string | null } | null;
};
type VkParsingSettingsRow = Prisma.VkParsingSettingsGetPayload<Record<string, never>>;
type SourcePostStats = {
  newPostCount: number;
  queuedPostCount: number;
  publishedPostCount: number;
  skippedPostCount: number;
  failedPostCount: number;
};

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

type VkParsingSkipReason = 'AD' | 'EMPTY_AFTER_LINK_FILTER' | 'NO_SUPPORTED_CONTENT';

const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_STATUS_DISABLED = 'DISABLED';
const VK_SOURCE_SYNC_STATUS_QUEUED = 'QUEUED';
const VK_SOURCE_SYNC_STATUS_SYNCING = 'SYNCING';
const VK_SOURCE_SYNC_STATUS_BACKOFF = 'BACKOFF';
const VK_SOURCE_SYNC_STATUS_ERROR = 'ERROR';
const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_CHANGED_AFTER_PUBLISH = 'CHANGED_AFTER_PUBLISH';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const VK_POST_SKIP_REASON_AD: VkParsingSkipReason = 'AD';
const VK_POST_SKIP_REASON_EMPTY_AFTER_LINK_FILTER: VkParsingSkipReason = 'EMPTY_AFTER_LINK_FILTER';
const VK_POST_SKIP_REASON_NO_SUPPORTED_CONTENT: VkParsingSkipReason = 'NO_SUPPORTED_CONTENT';

@Injectable()
export class VkParsingFeedService {
  private readonly maxSyncIntervalMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vkRateLimitService: VkParsingRateLimitService,
    configService: ConfigService,
  ) {
    this.maxSyncIntervalMs =
      configService.get<number>('VK_PARSING_MAX_SYNC_INTERVAL_MS') ?? 3_600_000;
  }

  async buildFeed(
    chatId: string,
    capabilities: VkParsingCapability,
    rawQuery: unknown,
    ownerScope: VkParsingOwnerScope,
  ): Promise<VkParsingFeed> {
    const parsedQuery = vkParsingFeedQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      throw new BadRequestException('Некорректные параметры списка VK-постов.');
    }
    const query: VkParsingFeedQuery = parsedQuery.data;
    const statusWhere =
      query.status === 'ALL'
        ? {}
        : query.status === 'QUEUED'
          ? {
              publishQueuedAt: { not: null },
              status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
            }
          : query.status === 'NEW'
            ? { status: VK_POST_STATUS_NEW, publishQueuedAt: null, publishCancelledAt: null }
            : query.status === 'PUBLISHED'
              ? { status: { in: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_CHANGED_AFTER_PUBLISH] } }
              : { status: query.status };
    const postWhere: Prisma.VkParsingPostWhereInput = {
      chatId,
      ...ownerScope,
      source: { status: VK_SOURCE_STATUS_ACTIVE, ...ownerScope },
      ...statusWhere,
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    };

    const [settings, sources, posts, total, queue, sourceStats] = await Promise.all([
      this.prisma.vkParsingSettings.findUnique({
        where: {
          chatId_ownerProfile_ownerBotId: {
            chatId,
            ...ownerScope,
          },
        },
      }),
      this.prisma.vkParsingSource.findMany({
        where: { chatId, status: VK_SOURCE_STATUS_ACTIVE, ...ownerScope },
        orderBy: [{ createdAt: 'asc' }],
      }),
      this.prisma.vkParsingPost.findMany({
        where: postWhere,
        omit: feedPostOmit,
        include: {
          source: true,
          botReview: { select: { status: true, deliveryState: true, lastError: true } },
        },
        orderBy:
          query.status === 'QUEUED'
            ? [{ publishScheduledAt: 'asc' }, { publishQueuedAt: 'asc' }, { id: 'asc' }]
            : [
                { vkPublishedAt: { sort: 'desc', nulls: 'last' } },
                { createdAt: 'desc' },
                { id: 'desc' },
              ],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.vkParsingPost.count({ where: postWhere }),
      this.prisma.vkParsingPost.findMany({
        where: {
          chatId,
          ...ownerScope,
          publishQueuedAt: { not: null },
          status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
          source: { status: VK_SOURCE_STATUS_ACTIVE, ...ownerScope },
        },
        omit: feedPostOmit,
        include: { source: true },
        orderBy: [{ publishScheduledAt: 'asc' }, { publishQueuedAt: 'asc' }, { id: 'asc' }],
        take: 20,
      }),
      this.loadSourcePostStats(chatId, ownerScope),
    ]);
    const nextOffset = query.offset + query.limit;

    return {
      capabilities,
      settings: this.mapSettings(chatId, settings),
      sources: sources.map((source) => this.mapSource(source, sourceStats.get(source.id))),
      posts: posts.map((post) => this.mapPost(post)),
      queue: queue.map((post) => this.mapPost(post)),
      auditEvents: [],
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: nextOffset < total,
        nextOffset: nextOffset < total ? nextOffset : null,
      },
      // Operational diagnostics are available through /summary, outside the polled feed.
      summary: null,
    };
  }

  async buildHealthSummary(
    chatId: string,
    ownerScope: VkParsingOwnerScope,
  ): Promise<VkParsingHealthSummary> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.maxSyncIntervalMs * 2);
    const [
      sourceCount,
      staleSourceCount,
      latestSeen,
      oldestQueued,
      publishBacklog,
      staleSyncLockCount,
      sourceRuntimeStats,
      mediaTotal,
      mediaFailed,
      vkApiMetrics,
    ] = await Promise.all([
      this.prisma.vkParsingSource.count({
        where: { chatId, status: VK_SOURCE_STATUS_ACTIVE, ...ownerScope },
      }),
      this.prisma.vkParsingSource.count({
        where: {
          chatId,
          ...ownerScope,
          status: VK_SOURCE_STATUS_ACTIVE,
          OR: [
            { syncStatus: VK_SOURCE_SYNC_STATUS_ERROR },
            { lastSuccessAt: null },
            { lastSuccessAt: { lt: staleBefore } },
          ],
        },
      }),
      this.prisma.vkParsingPost.aggregate({
        where: { chatId, lastSeenAt: { not: null }, ...ownerScope },
        _max: { lastSeenAt: true },
      }),
      this.prisma.vkParsingPost.aggregate({
        where: { chatId, publishQueuedAt: { not: null }, ...ownerScope },
        _min: { publishQueuedAt: true },
      }),
      this.prisma.vkParsingPost.count({
        where: {
          chatId,
          ...ownerScope,
          publishQueuedAt: { not: null },
          status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        },
      }),
      this.prisma.vkParsingSource.count({
        where: {
          chatId,
          ...ownerScope,
          status: VK_SOURCE_STATUS_ACTIVE,
          syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
          OR: [
            { syncLockDeadlineAt: { lt: now } },
            {
              syncLockDeadlineAt: null,
              syncLockedAt: { lt: staleBefore },
            },
          ],
        },
      }),
      this.loadSourceRuntimeStats(chatId, ownerScope),
      this.prisma.vkParsingMediaCache.count(),
      this.prisma.vkParsingMediaCache.count({ where: { status: VK_MEDIA_STATUS_FAILED } }),
      this.vkRateLimitService.getRecentVkApiMetrics(300).catch(() => ({
        rps: 0,
        errorRate: 0,
        recentErrors: [],
      })),
    ]);

    const lastSeenAt = latestSeen._max.lastSeenAt;
    const firstQueuedAt = oldestQueued._min.publishQueuedAt;
    const attemptedSources = this.readNumber(sourceRuntimeStats.attemptedSources) ?? 0;
    const successfulSources = this.readNumber(sourceRuntimeStats.successfulSources) ?? 0;
    const p95SyncDurationMs = this.readNumber(sourceRuntimeStats.p95SyncDurationMs) ?? 0;
    const publishLagSeconds = firstQueuedAt
      ? Math.max(0, Math.floor((now.getTime() - firstQueuedAt.getTime()) / 1_000))
      : null;
    return {
      chatId,
      generatedAt: now.toISOString(),
      vkApiRps: vkApiMetrics.rps,
      vkApiErrorRate: vkApiMetrics.errorRate,
      sourceCount,
      staleSourceCount,
      importLagSeconds: lastSeenAt
        ? Math.max(0, Math.floor((now.getTime() - lastSeenAt.getTime()) / 1_000))
        : null,
      publishLagSeconds,
      publishBacklogAgeSeconds: publishLagSeconds,
      publishBacklog,
      staleSyncLockCount,
      circuitOpenSourceCount: this.readNumber(sourceRuntimeStats.circuitOpenSourceCount) ?? 0,
      importSuccessRate:
        attemptedSources > 0 ? Math.min(1, successfulSources / attemptedSources) : 1,
      p95SyncDurationMs: p95SyncDurationMs > 0 ? Math.round(p95SyncDurationMs) : null,
      mediaFailureRatio: mediaTotal > 0 ? Math.min(1, mediaFailed / mediaTotal) : 0,
      recentErrors: vkApiMetrics.recentErrors,
    };
  }

  private async loadSourceRuntimeStats(
    chatId: string,
    ownerScope: VkParsingOwnerScope,
  ): Promise<Record<string, unknown>> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      select
        count(*) filter (where last_sync_at is not null)::int as "attemptedSources",
        count(*) filter (
          where sync_status = 'IDLE'
            and last_error_code is null
            and last_success_at is not null
        )::int as "successfulSources",
        count(*) filter (where circuit_opened_at is not null)::int as "circuitOpenSourceCount",
        percentile_cont(0.95) within group (order by last_sync_duration_ms) filter (
          where last_sync_duration_ms is not null
        ) as "p95SyncDurationMs"
      from vk_parsing_sources
      where chat_id = ${chatId}
        and owner_profile = CAST(${ownerScope.ownerProfile} AS "VkParsingOwnerProfile")
        and owner_bot_id = ${ownerScope.ownerBotId}
        and status = ${VK_SOURCE_STATUS_ACTIVE}
    `;
    return rows[0] ?? {};
  }

  private async loadSourcePostStats(
    chatId: string,
    ownerScope: VkParsingOwnerScope,
  ): Promise<Map<string, SourcePostStats>> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      select
        source_id as "sourceId",
        count(*) filter (
          where status = ${VK_POST_STATUS_NEW}
            and publish_queued_at is null
            and publish_cancelled_at is null
        )::int as "newPostCount",
        count(*) filter (
          where publish_queued_at is not null
            and status in (${VK_POST_STATUS_NEW}, ${VK_POST_STATUS_FAILED})
        )::int as "queuedPostCount",
        count(*) filter (where status in (${VK_POST_STATUS_PUBLISHED}, ${VK_POST_STATUS_CHANGED_AFTER_PUBLISH}))::int as "publishedPostCount",
        count(*) filter (where status = ${VK_POST_STATUS_SKIPPED})::int as "skippedPostCount",
        count(*) filter (where status = ${VK_POST_STATUS_FAILED})::int as "failedPostCount"
      from vk_parsing_posts
      where chat_id = ${chatId}
        and owner_profile = CAST(${ownerScope.ownerProfile} AS "VkParsingOwnerProfile")
        and owner_bot_id = ${ownerScope.ownerBotId}
      group by source_id
    `;
    return new Map(
      rows.map((row) => [
        String(row.sourceId),
        {
          newPostCount: this.readNumber(row.newPostCount) ?? 0,
          queuedPostCount: this.readNumber(row.queuedPostCount) ?? 0,
          publishedPostCount: this.readNumber(row.publishedPostCount) ?? 0,
          skippedPostCount: this.readNumber(row.skippedPostCount) ?? 0,
          failedPostCount: this.readNumber(row.failedPostCount) ?? 0,
        },
      ]),
    );
  }

  mapPost(post: VkParsingPostWithSource): VkParsingPost {
    const status =
      post.status === VK_POST_STATUS_PUBLISHED
        ? 'PUBLISHED'
        : post.status === VK_POST_STATUS_FAILED
          ? 'FAILED'
          : post.status === VK_POST_STATUS_CHANGED_AFTER_PUBLISH
            ? 'CHANGED_AFTER_PUBLISH'
            : post.status === VK_POST_STATUS_UNAVAILABLE
              ? 'UNAVAILABLE'
              : post.status === VK_POST_STATUS_SKIPPED
                ? 'SKIPPED'
                : 'NEW';
    return {
      id: post.id,
      botReview: post.botReview ? vkBotReviewSummarySchema.parse(post.botReview) : null,
      sourceId: post.sourceId,
      chatId: post.chatId,
      sourceTitle: post.source.title,
      sourceUrl: post.source.url,
      sourcePublishMode:
        post.source.publishMode === 'IMMEDIATE' ||
        post.source.publishMode === 'REVIEW' ||
        post.source.publishMode === 'BOT_REVIEW'
          ? post.source.publishMode
          : 'QUEUE',
      vkOwnerId: post.vkOwnerId,
      vkPostId: post.vkPostId,
      vkPublishedAt: post.vkPublishedAt ? post.vkPublishedAt.toISOString() : null,
      text: post.text,
      textFormat: resolveEffectiveVkParsingTextFormat({
        text: post.text,
        textFormat: post.textFormat,
        manualContentEditedAt: post.manualContentEditedAt,
      }),
      url: post.url,
      photoUrls: this.readStringArray(post.photoUrls),
      videoUrls: this.readStringArray(post.videoUrls),
      linkUrls: this.readStringArray(post.linkUrls),
      attachmentTypes: this.readStringArray(post.attachmentTypes),
      unsupportedAttachments: this.readUnsupportedAttachments(post.unsupportedAttachments),
      hasUnsupportedAttachments: Boolean(post.hasUnsupportedAttachments),
      isAdvertising: Boolean(post.isAdvertising),
      advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      status,
      contentHash: post.contentHash,
      publishedContentHash: post.publishedContentHash,
      publishedMessageId: post.publishedMessageId,
      publishedUrl: post.publishedUrl,
      autoDeleteAt: post.autoDeleteAt?.toISOString() ?? null,
      deletedAt: post.rollbackDeletedAt?.toISOString() ?? null,
      publishedAtMax: post.publishedAtMax ? post.publishedAtMax.toISOString() : null,
      autoPublishedAt: post.autoPublishedAt ? post.autoPublishedAt.toISOString() : null,
      autoPublishError: post.autoPublishError,
      skippedAt: post.skippedAt ? post.skippedAt.toISOString() : null,
      skipReason:
        post.skipReason === VK_POST_SKIP_REASON_AD ||
        post.skipReason === VK_POST_SKIP_REASON_EMPTY_AFTER_LINK_FILTER ||
        post.skipReason === VK_POST_SKIP_REASON_NO_SUPPORTED_CONTENT
          ? post.skipReason
          : null,
      lastSeenAt: post.lastSeenAt ? post.lastSeenAt.toISOString() : null,
      missingSinceAt: post.missingSinceAt ? post.missingSinceAt.toISOString() : null,
      missingSeenCount: Math.max(0, post.missingSeenCount ?? 0),
      lastAvailabilityCheckedAt: post.lastAvailabilityCheckedAt
        ? post.lastAvailabilityCheckedAt.toISOString()
        : null,
      unavailableAt: post.unavailableAt ? post.unavailableAt.toISOString() : null,
      publishQueuedAt: post.publishQueuedAt ? post.publishQueuedAt.toISOString() : null,
      publishScheduledAt: post.publishScheduledAt ? post.publishScheduledAt.toISOString() : null,
      publishCancelledAt: post.publishCancelledAt ? post.publishCancelledAt.toISOString() : null,
      publishCancelledByUserId: post.publishCancelledByUserId,
      publishLockedAt: post.publishLockedAt ? post.publishLockedAt.toISOString() : null,
      publishAttemptCount: Math.max(0, post.publishAttemptCount ?? 0),
      lastError: post.lastError,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
    };
  }

  private mapSettings(
    chatId: string,
    settings: VkParsingSettingsRow | VkParsingSettingsLike | null,
  ): VkParsingSettings {
    return {
      chatId,
      sourceLinkEnabled: settings?.sourceLinkEnabled ?? false,
      sourceLinkUrl: settings?.sourceLinkUrl ?? '',
      deleteAfterMinutes: settings?.deleteAfterMinutes ?? null,
      autoPublishEnabled: settings?.autoPublishEnabled ?? false,
      autoPublishEnabledAt: settings?.autoPublishEnabledAt
        ? settings.autoPublishEnabledAt.toISOString()
        : null,
      autoPublishKillSwitchEnabled: settings?.autoPublishKillSwitchEnabled ?? false,
      stripLinksEnabled: settings?.stripLinksEnabled ?? false,
      skipAdsEnabled: settings?.skipAdsEnabled ?? false,
      appendChannelLinkEnabled: settings?.appendChannelLinkEnabled ?? false,
      channelLinkText: settings?.channelLinkText ?? VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT,
      schedulerTimezone: settings?.schedulerTimezone ?? 'Europe/Moscow',
      quietHoursStart: settings?.quietHoursStart ?? null,
      quietHoursEnd: settings?.quietHoursEnd ?? null,
      workHoursStart: settings?.workHoursStart ?? '09:00',
      workHoursEnd: settings?.workHoursEnd ?? '22:00',
      distributeEvenlyEnabled: settings?.distributeEvenlyEnabled ?? true,
      roundRobinEnabled: settings?.roundRobinEnabled ?? true,
      circuitBreakerEnabled: settings?.circuitBreakerEnabled ?? true,
      circuitBreakerWindowMinutes: Math.max(1, settings?.circuitBreakerWindowMinutes ?? 10),
      circuitBreakerPostLimit: Math.max(1, settings?.circuitBreakerPostLimit ?? 10),
      updatedAt: settings?.updatedAt ? settings.updatedAt.toISOString() : null,
    };
  }

  private mapSource(source: VkParsingSourceRow, stats?: SourcePostStats): VkParsingSource {
    const syncStatus = this.mapSourceSyncStatus(source.syncStatus);
    const nextSyncAt = source.nextSyncAt ? source.nextSyncAt.toISOString() : null;
    return {
      id: source.id,
      chatId: source.chatId,
      ownerId: source.ownerId,
      wallOwnerId: source.wallOwnerId,
      screenName: source.screenName,
      title: source.title,
      url: source.url,
      status: source.status === VK_SOURCE_STATUS_DISABLED ? 'DISABLED' : 'ACTIVE',
      importEnabled: source.importEnabled,
      autoPublishEnabled: source.autoPublishEnabled,
      autoPublishEnabledAt: source.autoPublishEnabledAt
        ? source.autoPublishEnabledAt.toISOString()
        : null,
      autoPublishPausedAt: source.autoPublishPausedAt
        ? source.autoPublishPausedAt.toISOString()
        : null,
      autoPublishPausedReason: source.autoPublishPausedReason,
      publishIntervalMinutes: Math.max(5, source.publishIntervalMinutes ?? 60),
      dailyLimit: Math.max(1, source.dailyLimit ?? 3),
      minPublishIntervalMinutes: Math.max(0, source.minPublishIntervalMinutes ?? 30),
      publishMode:
        source.publishMode === 'IMMEDIATE' ||
        source.publishMode === 'REVIEW' ||
        source.publishMode === 'BOT_REVIEW'
          ? source.publishMode
          : 'QUEUE',
      priority:
        source.priority === 'HIGH' || source.priority === 'LOW' ? source.priority : 'NORMAL',
      quietHoursStart: source.quietHoursStart,
      quietHoursEnd: source.quietHoursEnd,
      lastAutoPublishedAt: source.lastAutoPublishedAt
        ? source.lastAutoPublishedAt.toISOString()
        : null,
      newPostCount: stats?.newPostCount ?? 0,
      queuedPostCount: stats?.queuedPostCount ?? 0,
      publishedPostCount: stats?.publishedPostCount ?? 0,
      skippedPostCount: stats?.skippedPostCount ?? 0,
      failedPostCount: stats?.failedPostCount ?? 0,
      syncStatus,
      nextSyncAt,
      nextRetryAt: syncStatus === VK_SOURCE_SYNC_STATUS_BACKOFF ? nextSyncAt : null,
      lastSyncAt: source.lastSyncAt ? source.lastSyncAt.toISOString() : null,
      lastSuccessAt: source.lastSuccessAt ? source.lastSuccessAt.toISOString() : null,
      syncStartedAt: source.syncStartedAt ? source.syncStartedAt.toISOString() : null,
      consecutiveFailures: Math.max(0, source.consecutiveFailures),
      terminalFailureCount: Math.max(0, source.terminalFailureCount ?? 0),
      circuitOpenedAt: source.circuitOpenedAt ? source.circuitOpenedAt.toISOString() : null,
      circuitReasonCode: source.circuitReasonCode,
      circuitReason: source.circuitReason,
      circuitRetryAt: source.circuitRetryAt ? source.circuitRetryAt.toISOString() : null,
      lastErrorCode: source.lastErrorCode,
      lastImportedCount: Math.max(0, source.lastImportedCount),
      lastFetchedCount: Math.max(0, source.lastFetchedCount),
      lastFetchedPages: Math.max(0, source.lastFetchedPages ?? 0),
      lastFetchedOffsets: this.readNumberArray(source.lastFetchedOffsets),
      lastVkNewestPostId: source.lastVkNewestPostId ?? null,
      lastVkNewestPublishedAt: source.lastVkNewestPublishedAt
        ? source.lastVkNewestPublishedAt.toISOString()
        : null,
      adaptiveIntervalMs:
        typeof source.adaptiveIntervalMs === 'number' && source.adaptiveIntervalMs >= 0
          ? source.adaptiveIntervalMs
          : null,
      lastSyncDurationMs:
        typeof source.lastSyncDurationMs === 'number' && source.lastSyncDurationMs >= 0
          ? source.lastSyncDurationMs
          : null,
      lastError: source.lastError,
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    };
  }

  private mapSourceSyncStatus(value: string): VkParsingSource['syncStatus'] {
    return value === VK_SOURCE_SYNC_STATUS_QUEUED
      ? 'QUEUED'
      : value === VK_SOURCE_SYNC_STATUS_SYNCING
        ? 'SYNCING'
        : value === VK_SOURCE_SYNC_STATUS_BACKOFF
          ? 'BACKOFF'
          : value === VK_SOURCE_SYNC_STATUS_ERROR
            ? 'ERROR'
            : 'IDLE';
  }

  private readStringArray(value: Prisma.JsonValue | unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  private readNumberArray(value: Prisma.JsonValue | unknown): number[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0,
    );
  }

  private readUnsupportedAttachments(
    value: Prisma.JsonValue | unknown,
  ): VkParsingUnsupportedAttachmentSummary[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        type: this.readString(item.type) || 'unknown',
        label: this.readString(item.label) || this.readString(item.type) || 'unknown',
        title: this.readString(item.title) || null,
        url: this.normalizeHttpUrl(this.readString(item.url)) ?? null,
        count: Math.max(1, this.readNumber(item.count) ?? 1),
        reason: this.readString(item.reason) || null,
      }));
  }

  private normalizeHttpUrl(value: string): string | null {
    if (!value) {
      return null;
    }
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
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
}
