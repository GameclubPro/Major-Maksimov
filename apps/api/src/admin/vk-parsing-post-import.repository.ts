import {
  VK_PARSING_MAX_LINKS,
  VK_PARSING_MAX_PHOTOS,
  VK_PARSING_MAX_VIDEOS,
} from '@maxim/contracts';
import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type VkParsingOwnerProfile } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import type { VkParsingTextFormat } from './vk-parsing-content';
import {
  VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
} from './vk-publish-quarantine';

export type ExistingVkPostImportState = {
  id: string;
  vkOwnerId: number;
  vkPostId: number;
  status: string;
  contentHash: string;
  publishedContentHash: string | null;
  publishQueuedAt: Date | null;
  publishIdempotencyKey: string | null;
  publishReason: string | null;
  publishCancelledAt: Date | null;
  publishScheduleFingerprint: string | null;
};

export type VkParsingPostImportSource = {
  id: string;
  chatId: string;
  wallOwnerId: number;
  ownerProfile: VkParsingOwnerProfile;
  ownerBotId: string;
};

export type VkParsingNormalizedPostForImport = {
  vkOwnerId: number;
  vkPostId: number;
  vkPublishedAt: Date | null;
  text: string;
  textFormat: VkParsingTextFormat;
  url: string;
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
  attachments: unknown[];
  attachmentTypes: string[];
  unsupportedAttachments: unknown[];
  hasUnsupportedAttachments: boolean;
  isAdvertising: boolean;
  advertisingMarkers: string[];
  raw: Record<string, unknown>;
  contentHash: string;
};

export type PreparedVkPostImport = {
  post: VkParsingNormalizedPostForImport;
  status: string;
  publishScheduleFingerprint: string | null;
};

export type VkMissingPostSpotCheck = (
  posts: Array<{ vkOwnerId: number; vkPostId: number }>,
) => Promise<Set<string> | null>;

export type VkMissingPostsLeaseRunner = <T>(
  operation: (database: VkParsingPostImportDatabase) => Promise<T>,
) => Promise<T>;

export type VkParsingPostImportDatabase = Pick<
  Prisma.TransactionClient,
  'vkParsingPost' | 'vkBotReview' | '$executeRaw'
>;

export type VkPostImportPersistenceSnapshot = {
  batches: number;
  postsAttempted: number;
  rowsWritten: number;
  rowsSkippedOrFenced: number;
  failedBatches: number;
  durationBuckets: {
    under100Ms: number;
    under500Ms: number;
    under2000Ms: number;
    atLeast2000Ms: number;
  };
};

const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_CHANGED_AFTER_PUBLISH = 'CHANGED_AFTER_PUBLISH';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const VK_POST_MISSING_RECONCILIATION_STATUSES = [
  VK_POST_STATUS_NEW,
  VK_POST_STATUS_FAILED,
  VK_POST_STATUS_CHANGED_AFTER_PUBLISH,
];
const VK_POST_IMPORT_CHUNK_SIZE = 50;
const VK_POST_IMPORT_JS_WHITESPACE =
  '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

@Injectable()
export class VkParsingPostImportRepository {
  private readonly persistenceSnapshot: VkPostImportPersistenceSnapshot = {
    batches: 0,
    postsAttempted: 0,
    rowsWritten: 0,
    rowsSkippedOrFenced: 0,
    failedBatches: 0,
    durationBuckets: { under100Ms: 0, under500Ms: 0, under2000Ms: 0, atLeast2000Ms: 0 },
  };

  constructor(
    private readonly prisma: PrismaService,
    @Optional() storageMetrics?: StorageRuntimeMetricsService,
  ) {
    storageMetrics?.registerVkPersistenceSnapshot(() => this.getPersistenceSnapshot());
  }

  // FLAG: These are process-lifetime statement counters, not committed transaction totals.
  // A skipped row may also be fenced by an active publication; it is not solely a no-op.
  getPersistenceSnapshot(): VkPostImportPersistenceSnapshot {
    return {
      ...this.persistenceSnapshot,
      durationBuckets: { ...this.persistenceSnapshot.durationBuckets },
    };
  }

  async findExistingPosts(
    source: VkParsingPostImportSource,
    posts: VkParsingNormalizedPostForImport[],
    database: VkParsingPostImportDatabase = this.prisma,
  ): Promise<ExistingVkPostImportState[]> {
    return posts.length
      ? database.vkParsingPost.findMany({
          where: {
            chatId: source.chatId,
            ownerProfile: source.ownerProfile,
            ownerBotId: source.ownerBotId,
            vkOwnerId: source.wallOwnerId,
            vkPostId: { in: posts.map((post) => post.vkPostId) },
          },
          select: {
            id: true,
            vkOwnerId: true,
            vkPostId: true,
            status: true,
            contentHash: true,
            publishedContentHash: true,
            publishQueuedAt: true,
            publishIdempotencyKey: true,
            publishReason: true,
            publishCancelledAt: true,
            publishScheduleFingerprint: true,
          },
        })
      : [];
  }

  async persistImportedPosts(
    source: VkParsingPostImportSource,
    posts: PreparedVkPostImport[],
    seenAt: Date,
    database: VkParsingPostImportDatabase = this.prisma,
  ): Promise<void> {
    for (const chunk of this.chunkItems(posts, VK_POST_IMPORT_CHUNK_SIZE)) {
      const startedAt = Date.now();
      this.persistenceSnapshot.batches += 1;
      this.persistenceSnapshot.postsAttempted += chunk.length;
      try {
        const written = await this.persistImportedPostsChunk(source, chunk, seenAt, database);
        this.persistenceSnapshot.rowsWritten += written;
        this.persistenceSnapshot.rowsSkippedOrFenced += chunk.length - written;
      } catch (error: unknown) {
        this.persistenceSnapshot.failedBatches += 1;
        throw error;
      } finally {
        const elapsed = Math.max(0, Date.now() - startedAt);
        const bucket =
          elapsed < 100
            ? 'under100Ms'
            : elapsed < 500
              ? 'under500Ms'
              : elapsed < 2000
                ? 'under2000Ms'
                : 'atLeast2000Ms';
        this.persistenceSnapshot.durationBuckets[bucket] += 1;
      }
    }
  }

  async markMissingPostsUnavailable(
    source: VkParsingPostImportSource,
    posts: VkParsingNormalizedPostForImport[],
    seenAt: Date,
    params: {
      missingConfirmationThreshold: number;
      spotCheckMissingPosts: VkMissingPostSpotCheck;
      runWithLease: VkMissingPostsLeaseRunner;
    },
  ): Promise<void> {
    if (posts.length === 0) {
      return;
    }

    const oldestFetchedAt = posts.reduce<Date | null>((oldest, post) => {
      if (!post.vkPublishedAt) {
        return oldest;
      }
      return !oldest || post.vkPublishedAt.getTime() < oldest.getTime()
        ? post.vkPublishedAt
        : oldest;
    }, null);
    if (!oldestFetchedAt) {
      return;
    }

    const candidates = await params.runWithLease((database) =>
      database.vkParsingPost.findMany({
        where: {
          sourceId: source.id,
          ownerProfile: source.ownerProfile,
          ownerBotId: source.ownerBotId,
          vkPublishedAt: { gte: oldestFetchedAt },
          vkPostId: { notIn: posts.map((post) => post.vkPostId) },
          status: {
            in: VK_POST_MISSING_RECONCILIATION_STATUSES,
          },
        },
        select: {
          id: true,
          vkOwnerId: true,
          vkPostId: true,
          missingSeenCount: true,
        },
        orderBy: [{ lastAvailabilityCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        take: 100,
      }),
    );
    if (candidates.length === 0) {
      return;
    }

    const belowThreshold = candidates.filter(
      (post) => post.missingSeenCount + 1 < params.missingConfirmationThreshold,
    );
    if (belowThreshold.length > 0) {
      await params.runWithLease((database) =>
        database.vkParsingPost.updateMany({
          where: {
            id: { in: belowThreshold.map((post) => post.id) },
            ownerProfile: source.ownerProfile,
            ownerBotId: source.ownerBotId,
            status: { in: VK_POST_MISSING_RECONCILIATION_STATUSES },
          },
          data: {
            missingSeenCount: { increment: 1 },
            missingSinceAt: seenAt,
            lastAvailabilityCheckedAt: seenAt,
          },
        }),
      );
    }

    const thresholdCandidates = candidates.filter(
      (post) => post.missingSeenCount + 1 >= params.missingConfirmationThreshold,
    );
    if (thresholdCandidates.length === 0) {
      return;
    }

    const foundPostKeys = await params.spotCheckMissingPosts(thresholdCandidates);

    if (foundPostKeys === null) {
      await params.runWithLease((database) =>
        database.vkParsingPost.updateMany({
          where: {
            id: { in: thresholdCandidates.map((post) => post.id) },
            ownerProfile: source.ownerProfile,
            ownerBotId: source.ownerBotId,
            status: { in: VK_POST_MISSING_RECONCILIATION_STATUSES },
          },
          data: {
            missingSeenCount: { increment: 1 },
            missingSinceAt: seenAt,
            lastAvailabilityCheckedAt: seenAt,
          },
        }),
      );
      return;
    }

    const foundIds: string[] = [];
    const missingIds: string[] = [];
    for (const post of thresholdCandidates) {
      const postKey = this.buildPostKey(post.vkOwnerId, post.vkPostId);
      if (foundPostKeys.has(postKey)) {
        foundIds.push(post.id);
      } else {
        missingIds.push(post.id);
      }
    }

    if (foundIds.length > 0) {
      await params.runWithLease((database) =>
        database.vkParsingPost.updateMany({
          where: {
            id: { in: foundIds },
            ownerProfile: source.ownerProfile,
            ownerBotId: source.ownerBotId,
            status: { in: VK_POST_MISSING_RECONCILIATION_STATUSES },
          },
          data: {
            missingSeenCount: 0,
            missingSinceAt: null,
            lastAvailabilityCheckedAt: seenAt,
          },
        }),
      );
    }

    if (missingIds.length > 0) {
      await params.runWithLease((database) =>
        database.vkParsingPost.updateMany({
          where: {
            id: { in: missingIds },
            ownerProfile: source.ownerProfile,
            ownerBotId: source.ownerBotId,
            status: { in: VK_POST_MISSING_RECONCILIATION_STATUSES },
            publishLockedAt: null,
            rollbackQueuedAt: null,
            rollbackLockedAt: null,
            rollbackIdempotencyKey: null,
            AND: [
              {
                OR: [
                  { lastError: null },
                  {
                    AND: [
                      {
                        NOT: {
                          lastError: { startsWith: VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
                        },
                      },
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
              {
                NOT: {
                  publishIdempotencyKey: { not: null },
                  publishAttemptCount: { gt: 0 },
                },
              },
            ],
          },
          data: {
            status: VK_POST_STATUS_UNAVAILABLE,
            missingSeenCount: { increment: 1 },
            missingSinceAt: seenAt,
            lastAvailabilityCheckedAt: seenAt,
            unavailableAt: seenAt,
            publishQueuedAt: null,
            publishLockedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduleFingerprint: null,
          },
        }),
      );
    }
  }

  private async persistImportedPostsChunk(
    source: VkParsingPostImportSource,
    posts: PreparedVkPostImport[],
    seenAt: Date,
    database: VkParsingPostImportDatabase,
  ): Promise<number> {
    if (posts.length === 0) {
      return 0;
    }

    const rows = posts.map(
      ({ post, status, publishScheduleFingerprint }) =>
        Prisma.sql`(
        ${this.createDatabaseId('vkpost')},
        ${source.id},
        ${source.chatId},
        CAST(${source.ownerProfile} AS "VkParsingOwnerProfile"),
        ${source.ownerBotId},
        ${post.vkOwnerId},
        ${post.vkPostId},
        ${post.vkPublishedAt},
        ${post.text},
        ${post.textFormat},
        ${post.url},
        ${this.toJsonbSql(post.photoUrls.slice(0, VK_PARSING_MAX_PHOTOS))},
        ${this.toJsonbSql(post.videoUrls.slice(0, VK_PARSING_MAX_VIDEOS))},
        ${this.toJsonbSql(post.linkUrls.slice(0, VK_PARSING_MAX_LINKS))},
        ${this.toJsonbSql(post.attachments)},
        ${this.toJsonbSql(post.attachmentTypes)},
        ${this.toJsonbSql(post.unsupportedAttachments)},
        ${post.hasUnsupportedAttachments},
        ${post.isAdvertising},
        ${this.toJsonbSql(post.advertisingMarkers)},
        ${this.toJsonbSql(post.raw)},
        ${post.contentHash},
        ${status},
        ${publishScheduleFingerprint},
        ${seenAt},
        ${seenAt},
        ${seenAt}
      )`,
    );

    // FLAG: SEND may settle after the import snapshot but before this conflict write. Classify
    // against the current lifecycle/receipt and preserve both errors if either is quarantined.
    // Match the quarantine helpers' JS trim exactly; SQL's default trim omits tabs/NBSP/FEFF.
    const quarantined = Prisma.sql`(
      starts_with(btrim(COALESCE("vk_parsing_posts"."last_error", ''), ${VK_POST_IMPORT_JS_WHITESPACE}), ${VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX})
      OR starts_with(btrim(COALESCE("vk_parsing_posts"."last_error", ''), ${VK_POST_IMPORT_JS_WHITESPACE}), ${VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX})
      OR starts_with(btrim(COALESCE("vk_parsing_posts"."auto_publish_error", ''), ${VK_POST_IMPORT_JS_WHITESPACE}), ${VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX})
      OR starts_with(btrim(COALESCE("vk_parsing_posts"."auto_publish_error", ''), ${VK_POST_IMPORT_JS_WHITESPACE}), ${VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX})
    )`;
    const publishedHash = Prisma.sql`COALESCE(
      NULLIF("vk_parsing_posts"."published_content_hash", ''),
      CASE WHEN "vk_parsing_posts"."status" = ${VK_POST_STATUS_PUBLISHED}
        THEN NULLIF("vk_parsing_posts"."content_hash", '') END
    )`;
    const resolvedStatus = Prisma.sql`CASE
      WHEN "vk_parsing_posts"."status" IN (${VK_POST_STATUS_PUBLISHED}, ${VK_POST_STATUS_CHANGED_AFTER_PUBLISH})
        AND ${publishedHash} <> EXCLUDED."content_hash"
        THEN ${VK_POST_STATUS_CHANGED_AFTER_PUBLISH}
      WHEN "vk_parsing_posts"."status" = ${VK_POST_STATUS_UNAVAILABLE}
        THEN ${VK_POST_STATUS_NEW}
      WHEN "vk_parsing_posts"."status" = ${VK_POST_STATUS_SKIPPED}
        AND "vk_parsing_posts"."content_hash" <> EXCLUDED."content_hash"
        THEN ${VK_POST_STATUS_NEW}
      ELSE COALESCE(NULLIF("vk_parsing_posts"."status", ''), ${VK_POST_STATUS_NEW})
    END`;
    const effectiveStatus = Prisma.sql`CASE
      WHEN ${quarantined} THEN "vk_parsing_posts"."status"
      ELSE ${resolvedStatus}
    END`;
    const clearOrdinaryErrors = Prisma.sql`(NOT ${quarantined} AND (${resolvedStatus}) = ${VK_POST_STATUS_NEW})`;

    // FLAG: An active intent owns one immutable content revision. Once its key is cleared, a
    // later sync may import a newer VK revision and classify it against the published hash.
    // FLAG: Preserve equal stored JSON values so PostgreSQL can reuse their TOAST pointers.
    // Freshness timestamps still advance on every observation; hash equality alone cannot
    // substitute for JSON equality (CDN URLs and raw counters can change independently).
    return database.$executeRaw(Prisma.sql`
      /* storage:vk_import_upsert */
      INSERT INTO "vk_parsing_posts" (
        "id",
        "source_id",
        "chat_id",
        "owner_profile",
        "owner_bot_id",
        "vk_owner_id",
        "vk_post_id",
        "vk_published_at",
        "text",
        "text_format",
        "url",
        "photo_urls",
        "video_urls",
        "link_urls",
        "attachments",
        "attachment_types",
        "unsupported_attachments",
        "has_unsupported_attachments",
        "is_advertising",
        "advertising_markers",
        "raw",
        "content_hash",
        "status",
        "publish_schedule_fingerprint",
        "last_seen_at",
        "last_availability_checked_at",
        "updated_at"
      )
      VALUES ${Prisma.join(rows)}
      ON CONFLICT (
        "chat_id",
        "owner_profile",
        "owner_bot_id",
        "vk_owner_id",
        "vk_post_id"
      )
      DO UPDATE SET
        "source_id" = EXCLUDED."source_id",
        "vk_published_at" = EXCLUDED."vk_published_at",
        "text" = CASE
          WHEN "vk_parsing_posts"."manual_content_edited_at" IS NOT NULL
            AND "vk_parsing_posts"."content_hash" = EXCLUDED."content_hash"
          THEN "vk_parsing_posts"."text"
          ELSE EXCLUDED."text"
        END,
        "text_format" = CASE
          WHEN "vk_parsing_posts"."manual_content_edited_at" IS NOT NULL
            AND "vk_parsing_posts"."content_hash" = EXCLUDED."content_hash"
          THEN "vk_parsing_posts"."text_format"
          ELSE EXCLUDED."text_format"
        END,
        "manual_content_edited_at" = CASE
          WHEN "vk_parsing_posts"."content_hash" = EXCLUDED."content_hash"
          THEN "vk_parsing_posts"."manual_content_edited_at"
          ELSE NULL
        END,
        "url" = EXCLUDED."url",
        "photo_urls" = CASE
          WHEN "vk_parsing_posts"."manual_content_edited_at" IS NOT NULL
            AND "vk_parsing_posts"."content_hash" = EXCLUDED."content_hash"
          THEN "vk_parsing_posts"."photo_urls"
          WHEN "vk_parsing_posts"."photo_urls" IS NOT DISTINCT FROM EXCLUDED."photo_urls"
          THEN "vk_parsing_posts"."photo_urls"
          ELSE EXCLUDED."photo_urls"
        END,
        "video_urls" = CASE
          WHEN "vk_parsing_posts"."manual_content_edited_at" IS NOT NULL
            AND "vk_parsing_posts"."content_hash" = EXCLUDED."content_hash"
          THEN "vk_parsing_posts"."video_urls"
          WHEN "vk_parsing_posts"."video_urls" IS NOT DISTINCT FROM EXCLUDED."video_urls"
          THEN "vk_parsing_posts"."video_urls"
          ELSE EXCLUDED."video_urls"
        END,
        "link_urls" = CASE
          WHEN "vk_parsing_posts"."manual_content_edited_at" IS NOT NULL
            AND "vk_parsing_posts"."content_hash" = EXCLUDED."content_hash"
          THEN "vk_parsing_posts"."link_urls"
          WHEN "vk_parsing_posts"."link_urls" IS NOT DISTINCT FROM EXCLUDED."link_urls"
          THEN "vk_parsing_posts"."link_urls"
          ELSE EXCLUDED."link_urls"
        END,
        "attachments" = CASE
          WHEN "vk_parsing_posts"."attachments" IS NOT DISTINCT FROM EXCLUDED."attachments"
          THEN "vk_parsing_posts"."attachments"
          ELSE EXCLUDED."attachments"
        END,
        "attachment_types" = CASE
          WHEN "vk_parsing_posts"."attachment_types" IS NOT DISTINCT FROM EXCLUDED."attachment_types"
          THEN "vk_parsing_posts"."attachment_types"
          ELSE EXCLUDED."attachment_types"
        END,
        "unsupported_attachments" = CASE
          WHEN "vk_parsing_posts"."unsupported_attachments" IS NOT DISTINCT FROM EXCLUDED."unsupported_attachments"
          THEN "vk_parsing_posts"."unsupported_attachments"
          ELSE EXCLUDED."unsupported_attachments"
        END,
        "has_unsupported_attachments" = EXCLUDED."has_unsupported_attachments",
        "is_advertising" = EXCLUDED."is_advertising",
        "advertising_markers" = CASE
          WHEN "vk_parsing_posts"."advertising_markers" IS NOT DISTINCT FROM EXCLUDED."advertising_markers"
          THEN "vk_parsing_posts"."advertising_markers"
          ELSE EXCLUDED."advertising_markers"
        END,
        "raw" = CASE
          WHEN "vk_parsing_posts"."raw" IS NOT DISTINCT FROM EXCLUDED."raw"
          THEN "vk_parsing_posts"."raw"
          ELSE EXCLUDED."raw"
        END,
        "content_hash" = EXCLUDED."content_hash",
        "status" = ${effectiveStatus},
        "last_seen_at" = EXCLUDED."last_seen_at",
        "missing_since_at" = NULL,
        "missing_seen_count" = 0,
        "last_availability_checked_at" = EXCLUDED."last_availability_checked_at",
        "unavailable_at" = NULL,
        "skipped_at" = CASE
          WHEN ${clearOrdinaryErrors} THEN NULL
          ELSE "vk_parsing_posts"."skipped_at"
        END,
        "skip_reason" = CASE
          WHEN ${clearOrdinaryErrors} THEN NULL
          ELSE "vk_parsing_posts"."skip_reason"
        END,
        "auto_publish_error" = CASE
          WHEN ${clearOrdinaryErrors} THEN NULL
          ELSE "vk_parsing_posts"."auto_publish_error"
        END,
        "last_error" = CASE
          WHEN ${clearOrdinaryErrors} THEN NULL
          ELSE "vk_parsing_posts"."last_error"
        END,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "vk_parsing_posts"."publish_idempotency_key" IS NULL
        AND (
          -- FLAG: Fresh observations still advance every post's timestamps. Only an exact
          -- replay may skip the heap/index rewrite, after comparing the effective assignments.
          "vk_parsing_posts"."last_seen_at" IS DISTINCT FROM EXCLUDED."last_seen_at"
          OR "vk_parsing_posts"."last_availability_checked_at" IS DISTINCT FROM EXCLUDED."last_availability_checked_at"
          OR ROW(
            "vk_parsing_posts"."source_id", "vk_parsing_posts"."vk_published_at",
            "vk_parsing_posts"."url", "vk_parsing_posts"."content_hash", "vk_parsing_posts"."status",
            "vk_parsing_posts"."has_unsupported_attachments", "vk_parsing_posts"."is_advertising",
            "vk_parsing_posts"."missing_since_at", "vk_parsing_posts"."missing_seen_count", "vk_parsing_posts"."unavailable_at"
          ) IS DISTINCT FROM ROW(
            EXCLUDED."source_id", EXCLUDED."vk_published_at", EXCLUDED."url", EXCLUDED."content_hash", ${effectiveStatus},
            EXCLUDED."has_unsupported_attachments", EXCLUDED."is_advertising", NULL, 0, NULL
          )
          OR (
            (
              "vk_parsing_posts"."manual_content_edited_at" IS NULL
              OR "vk_parsing_posts"."content_hash" IS DISTINCT FROM EXCLUDED."content_hash"
            )
            AND ROW(
              "vk_parsing_posts"."text", "vk_parsing_posts"."text_format",
              "vk_parsing_posts"."photo_urls", "vk_parsing_posts"."video_urls", "vk_parsing_posts"."link_urls"
            ) IS DISTINCT FROM ROW(
              EXCLUDED."text", EXCLUDED."text_format", EXCLUDED."photo_urls", EXCLUDED."video_urls", EXCLUDED."link_urls"
            )
          )
          OR ROW(
            "vk_parsing_posts"."attachments", "vk_parsing_posts"."attachment_types",
            "vk_parsing_posts"."unsupported_attachments", "vk_parsing_posts"."advertising_markers", "vk_parsing_posts"."raw"
          ) IS DISTINCT FROM ROW(
            EXCLUDED."attachments", EXCLUDED."attachment_types", EXCLUDED."unsupported_attachments",
            EXCLUDED."advertising_markers", EXCLUDED."raw"
          )
          OR (
            ${clearOrdinaryErrors}
            AND ROW(
              "vk_parsing_posts"."skipped_at", "vk_parsing_posts"."skip_reason",
              "vk_parsing_posts"."auto_publish_error", "vk_parsing_posts"."last_error"
            ) IS DISTINCT FROM ROW(NULL, NULL, NULL, NULL)
          )
        )
    `);
  }

  private buildPostKey(ownerId: number, postId: number): string {
    return `${ownerId}:${postId}`;
  }

  private toJsonbSql(value: unknown): Prisma.Sql {
    return Prisma.sql`CAST(${JSON.stringify(value ?? null)} AS jsonb)`;
  }

  private createDatabaseId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/gu, '')}`;
  }

  private chunkItems<T>(items: readonly T[], size: number): T[][] {
    const chunkSize = Math.max(1, Math.trunc(size));
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += chunkSize) {
      chunks.push(items.slice(index, index + chunkSize));
    }
    return chunks;
  }
}
