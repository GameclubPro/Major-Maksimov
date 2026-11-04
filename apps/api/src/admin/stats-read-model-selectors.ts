import type { ModerationFeedFilter } from '@maxim/contracts';
import type { ChannelStatsBucket } from '@maxim/contracts/channel-stats';
import { Prisma, type SanctionAction } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export const EXACT_STATISTICS_ROLLUP_READER_VERSION = 1;

export type ModerationFeedReadModelRow = {
  id: string;
  action: SanctionAction;
  ruleCode: string;
  userId: string;
  createdAt: Date;
  maskedExcerpt: string | null;
  metadata: Prisma.JsonValue | null;
  userDisplayName?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
};

export type ChannelStatsMembershipBucketRow = {
  bucket_start: Date | string;
  joined_users: unknown;
  left_users: unknown;
};

export type ChannelStatsContentBucketRow = {
  bucket_start: Date | string;
  posts: unknown;
  views_delta: unknown;
  reactions: unknown;
};

type SelectModerationFeedRowsParams = {
  chatId: string;
  from: Date;
  to: Date;
  filter: ModerationFeedFilter;
  cursor: {
    createdAt: Date;
    id: string;
  } | null;
  limit: number;
};

type SelectChannelStatsMembershipBucketRowsParams = {
  chatId: string;
  from: Date;
  to: Date;
  bucket: ChannelStatsBucket;
};

type CompleteHourlyRollupWindow = {
  completeFrom: Date;
  completeTo: Date;
  hasCompleteBuckets: boolean;
};

export type ChannelStatsPartialEdgeRange = {
  from: Date;
  to: Date;
  toInclusive: boolean;
};

const ONE_HOUR_MS = 60 * 60 * 1000;

export async function selectModerationFeedReadModelRows(
  prisma: PrismaService,
  params: SelectModerationFeedRowsParams,
): Promise<ModerationFeedReadModelRow[]> {
  const commercial = params.filter === 'COMMERCIAL';
  const filterSql = commercial ? Prisma.empty : buildModerationFeedFilterSql(params.filter);
  const cursorSql = params.cursor
    ? Prisma.sql`
        AND (feed.created_at, feed.id) < (${params.cursor.createdAt}, ${params.cursor.id})
      `
    : Prisma.empty;
  // FLAG: Each commercial rule owns an indexed ordered head before merging. A single IN
  // predicate may scan/sort the entire retained chat window even for a small page.
  const feedSource = commercial
    ? Prisma.sql`(
        SELECT * FROM (
          (SELECT * FROM chat_moderation_feed_items feed
           WHERE feed.chat_id = ${params.chatId}
             AND feed.rule_code = 'COMMERCIAL_AD'
             AND feed.created_at >= ${params.from} AND feed.created_at <= ${params.to}
             ${cursorSql}
           ORDER BY feed.created_at DESC, feed.id DESC LIMIT ${params.limit})
          UNION ALL
          (SELECT * FROM chat_moderation_feed_items feed
           WHERE feed.chat_id = ${params.chatId}
             AND feed.rule_code = 'COMMERCIAL_LLM_DELETE'
             AND feed.created_at >= ${params.from} AND feed.created_at <= ${params.to}
             ${cursorSql}
           ORDER BY feed.created_at DESC, feed.id DESC LIMIT ${params.limit})
        ) commercial_heads
        ORDER BY created_at DESC, id DESC LIMIT ${params.limit}
      )`
    : Prisma.sql`chat_moderation_feed_items`;

  return prisma.$queryRaw<ModerationFeedReadModelRow[]>`
    SELECT
      feed.id,
      feed.action,
      feed.rule_code AS "ruleCode",
      feed.user_id AS "userId",
      feed.created_at AS "createdAt",
      feed.masked_excerpt AS "maskedExcerpt",
      feed.metadata,
      COALESCE(
        NULLIF(BTRIM(feed.user_display_name), ''),
        (
          SELECT snapshot.display_name
          FROM chat_user_display_names AS snapshot
          WHERE snapshot.chat_id = feed.chat_id
            AND snapshot.user_id = feed.user_id
        )
      ) AS "userDisplayName",
      NULL::TEXT AS "avatarUrl",
      NULL::TEXT AS "profileUrl",
      NULL::TEXT AS "profileHandoffUrl"
    FROM ${feedSource} feed
    WHERE feed.chat_id = ${params.chatId}
      AND feed.created_at >= ${params.from}
      AND feed.created_at <= ${params.to}
      ${filterSql}
      ${cursorSql}
    ORDER BY feed.created_at DESC, feed.id DESC
    LIMIT ${params.limit}
  `;
}

export async function selectChannelStatsMembershipBucketRows(
  prisma: PrismaService,
  params: SelectChannelStatsMembershipBucketRowsParams,
): Promise<ChannelStatsMembershipBucketRow[]> {
  const rollupBucketStartSql = buildChannelStatsBucketStartSql(
    params.bucket,
    Prisma.sql`bucket_start`,
  );
  const { completeFrom, completeTo, hasCompleteBuckets } = resolveCompleteHourlyRollupWindow(
    params.from,
    params.to,
  );
  const rollupRowsSql = hasCompleteBuckets
    ? Prisma.sql`
        SELECT
          ${rollupBucketStartSql} AS bucket_start,
          COALESCE(SUM(joined_users), 0) AS joined_users,
          COALESCE(SUM(left_users), 0) AS left_users
        FROM channel_stats_bucket_rollups
        WHERE chat_id = ${params.chatId}
          AND bucket_start >= ${completeFrom}
          AND bucket_start < ${completeTo}
        GROUP BY ${rollupBucketStartSql}
      `
    : Prisma.sql`
        SELECT
          NULL::TIMESTAMP(3) AS bucket_start,
          0::BIGINT AS joined_users,
          0::BIGINT AS left_users
        WHERE FALSE
      `;
  const edgeRowsSql = buildChannelStatsMembershipEdgeRowsSql(
    params.chatId,
    params.from,
    params.to,
    completeFrom,
    completeTo,
    hasCompleteBuckets,
    params.bucket,
  );

  return prisma.$queryRaw<ChannelStatsMembershipBucketRow[]>`
    WITH membership_bucket_rows AS (
      ${rollupRowsSql}

      UNION ALL

      ${edgeRowsSql}
    )
    SELECT
      bucket_start,
      COALESCE(SUM(joined_users), 0) AS joined_users,
      COALESCE(SUM(left_users), 0) AS left_users
    FROM membership_bucket_rows
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `;
}

export async function selectChannelStatsContentBucketRows(
  prisma: PrismaService,
  params: SelectChannelStatsMembershipBucketRowsParams,
): Promise<ChannelStatsContentBucketRow[]> {
  const rollupBucketStartSql = buildChannelStatsBucketStartSql(
    params.bucket,
    Prisma.sql`bucket_start`,
  );
  const { completeFrom, completeTo, hasCompleteBuckets } = resolveCompleteHourlyRollupWindow(
    params.from,
    params.to,
  );
  const rollupRowsSql = hasCompleteBuckets
    ? Prisma.sql`
        SELECT
          ${rollupBucketStartSql} AS bucket_start,
          COALESCE(SUM(posts), 0) AS posts,
          COALESCE(SUM(COALESCE(views_total_exact, views_total::bigint)), 0) AS views_delta,
          COALESCE(SUM(reactions), 0) AS reactions
        FROM channel_stats_bucket_rollups
        WHERE chat_id = ${params.chatId}
          AND bucket_start >= ${completeFrom}
          AND bucket_start < ${completeTo}
        GROUP BY ${rollupBucketStartSql}
      `
    : Prisma.sql`
        SELECT
          NULL::TIMESTAMP(3) AS bucket_start,
          0::BIGINT AS posts,
          0::BIGINT AS views_delta,
          0::BIGINT AS reactions
        WHERE FALSE
      `;
  const edgeRowsSql = buildChannelStatsContentEdgeRowsSql(
    params.chatId,
    params.from,
    params.to,
    completeFrom,
    completeTo,
    hasCompleteBuckets,
    params.bucket,
  );

  return prisma.$queryRaw<ChannelStatsContentBucketRow[]>`
    WITH content_bucket_rows AS (
      ${rollupRowsSql}

      UNION ALL

      ${edgeRowsSql}
    )
    SELECT
      bucket_start,
      COALESCE(SUM(posts), 0) AS posts,
      COALESCE(SUM(views_delta), 0) AS views_delta,
      COALESCE(SUM(reactions), 0) AS reactions
    FROM content_bucket_rows
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `;
}

function buildChannelStatsBucketStartSql(
  bucket: ChannelStatsBucket,
  valueSql: Prisma.Sql,
): Prisma.Sql {
  if (bucket === 'hour') {
    return Prisma.sql`date_trunc('hour', ${valueSql})::TIMESTAMP(3)`;
  }

  return Prisma.sql`
    (date_trunc('day', ${valueSql} + INTERVAL '3 hours') - INTERVAL '3 hours')::TIMESTAMP(3)
  `;
}

function buildChannelStatsMembershipEdgeRowsSql(
  chatId: string,
  from: Date,
  to: Date,
  completeFrom: Date,
  completeTo: Date,
  hasCompleteBuckets: boolean,
  bucket: ChannelStatsBucket,
): Prisma.Sql {
  const edgeRanges = resolveChannelStatsPartialEdgeRanges(
    from,
    to,
    completeFrom,
    completeTo,
    hasCompleteBuckets,
  );

  if (edgeRanges.length === 0) {
    return Prisma.sql`
      SELECT
        NULL::TIMESTAMP(3) AS bucket_start,
        0::BIGINT AS joined_users,
        0::BIGINT AS left_users
      WHERE FALSE
    `;
  }

  return Prisma.join(
    edgeRanges.map((range) => {
      const upperBoundSql = range.toInclusive
        ? Prisma.sql`event_at <= ${range.to}`
        : Prisma.sql`event_at < ${range.to}`;
      const bucketStartSql = buildChannelStatsBucketStartSql(bucket, Prisma.sql`event_at`);

      return Prisma.sql`
        SELECT
          ${bucketStartSql} AS bucket_start,
          COUNT(*) FILTER (WHERE event_type = 'user_added') AS joined_users,
          COUNT(*) FILTER (WHERE event_type = 'user_removed') AS left_users
        FROM chat_membership_activity_feed_items
        WHERE chat_id = ${chatId}
          AND event_type IN ('user_added', 'user_removed')
          AND event_at >= ${range.from}
          AND ${upperBoundSql}
        GROUP BY ${bucketStartSql}
      `;
    }),
    ' UNION ALL ',
  );
}

function buildChannelStatsContentEdgeRowsSql(
  chatId: string,
  from: Date,
  to: Date,
  completeFrom: Date,
  completeTo: Date,
  hasCompleteBuckets: boolean,
  bucket: ChannelStatsBucket,
): Prisma.Sql {
  const edgeRanges = resolveChannelStatsPartialEdgeRanges(
    from,
    to,
    completeFrom,
    completeTo,
    hasCompleteBuckets,
  );

  if (edgeRanges.length === 0) {
    return Prisma.sql`
      SELECT
        NULL::TIMESTAMP(3) AS bucket_start,
        0::BIGINT AS posts,
        0::BIGINT AS views_delta,
        0::BIGINT AS reactions
      WHERE FALSE
    `;
  }

  return Prisma.join(
    edgeRanges.map((range) => {
      const upperBoundSql = range.toInclusive
        ? Prisma.sql`published_at <= ${range.to}`
        : Prisma.sql`published_at < ${range.to}`;
      const bucketStartSql = buildChannelStatsBucketStartSql(bucket, Prisma.sql`published_at`);

      return Prisma.sql`
        SELECT
          ${bucketStartSql} AS bucket_start,
          COUNT(*) AS posts,
          COALESCE(SUM(GREATEST(latest_views, 0)), 0) AS views_delta,
          COALESCE(SUM(GREATEST(latest_reactions_total, 0)), 0) AS reactions
        FROM channel_posts
        WHERE chat_id = ${chatId}
          AND published_at >= ${range.from}
          AND ${upperBoundSql}
        GROUP BY ${bucketStartSql}
      `;
    }),
    ' UNION ALL ',
  );
}

function buildModerationFeedFilterSql(filter: ModerationFeedFilter): Prisma.Sql {
  if (filter === 'ALL') {
    return Prisma.sql`
      AND (
        feed.action IN ('WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN')
        OR (
          feed.action = 'NONE'
          AND feed.rule_code IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN')
        )
      )
    `;
  }

  if (filter === 'UNMUTE') {
    return Prisma.sql`
      AND feed.action = 'NONE'
      AND feed.rule_code = 'MANUAL_UNMUTE'
    `;
  }

  if (filter === 'UNBAN') {
    return Prisma.sql`
      AND feed.action = 'NONE'
      AND feed.rule_code = 'MANUAL_UNBAN'
    `;
  }

  if (filter === 'BAN') {
    return Prisma.sql`AND feed.action IN ('BAN', 'KICK')`;
  }

  return Prisma.sql`AND feed.action = ${filter}::"SanctionAction"`;
}

function resolveCompleteHourlyRollupWindow(from: Date, to: Date): CompleteHourlyRollupWindow {
  const flooredFrom = floorDateToHour(from);
  const completeFrom =
    flooredFrom.getTime() === from.getTime()
      ? flooredFrom
      : new Date(flooredFrom.getTime() + ONE_HOUR_MS);
  const completeTo = floorDateToHour(to);

  return {
    completeFrom,
    completeTo,
    hasCompleteBuckets: completeFrom.getTime() < completeTo.getTime(),
  };
}

export function resolveChannelStatsPartialEdgeRanges(
  from: Date,
  to: Date,
  completeFrom: Date,
  completeTo: Date,
  hasCompleteBuckets: boolean,
): ChannelStatsPartialEdgeRange[] {
  if (!hasCompleteBuckets) {
    return from.getTime() <= to.getTime() ? [{ from, to, toInclusive: true }] : [];
  }

  const ranges: ChannelStatsPartialEdgeRange[] = [];
  if (from.getTime() < completeFrom.getTime()) {
    ranges.push({ from, to: completeFrom, toInclusive: false });
  }
  if (completeTo.getTime() <= to.getTime()) {
    ranges.push({ from: completeTo, to, toInclusive: true });
  }

  return ranges;
}

function floorDateToHour(date: Date): Date {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}
