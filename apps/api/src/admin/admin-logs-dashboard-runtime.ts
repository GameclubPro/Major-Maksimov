import { readTrimmedString } from './admin-legacy-utils';
import { toIsoString, resolveLogsDashboardFrom } from './admin-statistics-values';
import {
  logsDashboardQuerySchema,
  logsDashboardResponseSchema,
  membershipActivityPageSchema,
  membershipActivityQuerySchema,
  moderationFeedPageSchema,
  moderationFeedQuerySchema,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type LogsDashboardViolation,
  type ManagedEntityType,
  type MembershipActivityPage,
  type MembershipActivityQuery,
  type ModerationFeedPage,
  type ModerationFeedQuery,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Prisma, SanctionAction } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildLogsDashboardResponseCacheKey,
  buildMembershipActivityFeedPageCacheKey,
  buildModerationFeedPageCacheKey,
} from './admin-legacy-utils';
import type { AdminLogsDashboardRuntimeContext } from './admin-logs-dashboard-runtime-context';
import {
  selectLogsDashboardMembershipSummary,
  selectLogsDashboardModerationSummary,
} from './logs-dashboard-rollups';
import { selectModerationFeedReadModelRows } from './stats-read-model-selectors';
import { commercialAdsFeedbackId, COMMERCIAL_AD_FEED_RULE_CODES } from './commercial-ads-feedback';
import {
  EVENTS_FEED_PAGE_CACHE_TTL_MS,
  EVENTS_FEED_HEAD_CACHE_TTL_MS,
  LOGS_DASHBOARD_RESPONSE_CACHE_TTL_MS,
  LOGS_DASHBOARD_VIOLATIONS_LIMIT,
  MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
  SLOW_LOGS_DASHBOARD_THRESHOLD_MS,
  type AssertChatAdminOptions,
  type MembershipEventRow,
  type ModerationFeedCursor,
  type ModerationViolationRow,
  type ResolvedUserProfile,
  type ResolveUserProfilesOptions,
  type TimedPromiseCacheEntry,
} from './admin.service.support';

export class AdminLogsDashboardRuntime {
  constructor(private readonly context: AdminLogsDashboardRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get logger(): AdminLogsDashboardRuntimeContext['logger'] {
    return this.context.logger;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private readonly logsDashboardResponseCache = new Map<
    string,
    TimedPromiseCacheEntry<LogsDashboardResponse>
  >();

  private readonly moderationFeedPageCache = new Map<
    string,
    TimedPromiseCacheEntry<ModerationFeedPage>
  >();

  private readonly membershipActivityFeedPageCache = new Map<
    string,
    TimedPromiseCacheEntry<MembershipActivityPage>
  >();

  private assertChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: AssertChatAdminOptions,
  ): Promise<void> {
    return this.context.assertChatAdmin(chatId, userId, entityType, options);
  }

  private assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: Parameters<AdminLogsDashboardRuntimeContext['assertReadOnlyChatAdmin']>[3],
  ): Promise<void> {
    return this.context.assertReadOnlyChatAdmin(chatId, userId, entityType, options);
  }

  private buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
  ): string | null {
    return this.context.buildProfileMentionHandoffUrl(chatId, entityType, userId, displayName);
  }

  private ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void> {
    return this.context.ensureEntityType(chatId, userId, expectedEntityType);
  }

  private readTrimmedString(value: unknown): string | null {
    return readTrimmedString(value);
  }

  private resolveUserProfiles(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options?: ResolveUserProfilesOptions,
  ): Promise<Map<string, ResolvedUserProfile>> {
    return this.context.resolveUserProfiles(chatId, entityType, userIds, options);
  }

  private toIsoString(value: unknown): string | null {
    return toIsoString(value);
  }

  async getLogsDashboard(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<LogsDashboardResponse> {
    const startedAtMs = Date.now();
    await this.assertReadOnlyChatAdmin(chatId, user.userId, null);
    const adminCheckedAtMs = Date.now();
    const parsed = logsDashboardQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const cacheKey = buildLogsDashboardResponseCacheKey(
      chatId,
      user.userId,
      parsed.data.range,
      parsed.data.includeActivityPreview,
      parsed.data.includeModerationPreview,
    );
    const cached = this.logsDashboardResponseCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      const response = await cached.promise;
      const finishedAtMs = Date.now();
      const totalMs = finishedAtMs - startedAtMs;
      if (totalMs >= SLOW_LOGS_DASHBOARD_THRESHOLD_MS) {
        this.logger.warn(
          {
            chatId,
            userId: user.userId,
            totalMs,
            adminCheckMs: adminCheckedAtMs - startedAtMs,
            responseMs: finishedAtMs - adminCheckedAtMs,
            cacheHit: true,
            range: parsed.data.range,
            includeActivityPreview: parsed.data.includeActivityPreview,
            includeModerationPreview: parsed.data.includeModerationPreview,
          },
          'Slow logs dashboard request completed',
        );
      }
      return response;
    }

    const pending = this.buildLogsDashboardResponse(
      chatId,
      parsed.data.range,
      parsed.data.includeActivityPreview,
      parsed.data.includeModerationPreview,
    ).catch((error: unknown) => {
      const current = this.logsDashboardResponseCache.get(cacheKey);
      if (current?.promise === pending) {
        this.logsDashboardResponseCache.delete(cacheKey);
      }
      throw error;
    });

    this.logsDashboardResponseCache.set(cacheKey, {
      expiresAtMs: Date.now() + LOGS_DASHBOARD_RESPONSE_CACHE_TTL_MS,
      promise: pending,
    });

    const response = await pending;
    const finishedAtMs = Date.now();
    const totalMs = finishedAtMs - startedAtMs;
    if (totalMs >= SLOW_LOGS_DASHBOARD_THRESHOLD_MS) {
      this.logger.warn(
        {
          chatId,
          userId: user.userId,
          totalMs,
          adminCheckMs: adminCheckedAtMs - startedAtMs,
          responseMs: finishedAtMs - adminCheckedAtMs,
          cacheHit: false,
          range: parsed.data.range,
          includeActivityPreview: parsed.data.includeActivityPreview,
          includeModerationPreview: parsed.data.includeModerationPreview,
        },
        'Slow logs dashboard request completed',
      );
    }

    return response;
  }

  async getChannelActivityFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<MembershipActivityPage> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'channel');
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const parsed = membershipActivityQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);
    return this.getCachedMembershipActivityFeedPage(
      chatId,
      user.userId,
      from,
      now,
      parsed.data,
      'channel',
      { allowRemoteLookup: false },
    );
  }

  async getChatActivityFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<MembershipActivityPage> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = membershipActivityQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);
    return this.getCachedMembershipActivityFeedPage(
      chatId,
      user.userId,
      from,
      now,
      parsed.data,
      'chat',
      { allowRemoteLookup: false },
    );
  }

  async getChatModerationFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ModerationFeedPage> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = moderationFeedQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const now = new Date();
    const from = this.resolveLogsDashboardFrom(parsed.data.range, now);
    const page = await this.getCachedModerationFeedPage(
      chatId,
      user.userId,
      from,
      now,
      parsed.data,
      'chat',
      {
        allowRemoteLookup: false,
      },
    );
    const ids = page.items
      .filter((item) => COMMERCIAL_AD_FEED_RULE_CODES.has(item.ruleCode))
      .map((item) => commercialAdsFeedbackId(chatId, user.userId, item.id));
    if (!ids.length) return page;
    // FLAG: Actor-specific acknowledgement stays outside the shared page cache. At most one
    // bounded primary-key batch is read; another administrator's report is never exposed.
    const reports = await this.prisma.auditLog.findMany({
      where: {
        id: { in: ids },
        chatId,
        actorUserId: user.userId,
        action: 'REPORT_COMMERCIAL_AD_ERROR',
      },
      select: { id: true },
    });
    const reported = new Set(reports.map((row) => row.id));
    return {
      ...page,
      items: page.items.map((item) =>
        COMMERCIAL_AD_FEED_RULE_CODES.has(item.ruleCode)
          ? {
              ...item,
              metadata: {
                ...item.metadata,
                commercialFeedbackReported: reported.has(
                  commercialAdsFeedbackId(chatId, user.userId, item.id),
                ),
              },
            }
          : item,
      ),
    };
  }

  resolveLogsDashboardFrom(range: LogsDashboardRange, to: Date): Date {
    return resolveLogsDashboardFrom(range, to);
  }

  async getMembershipActivityFeedPage(
    chatId: string,
    from: Date,
    to: Date,
    query: MembershipActivityQuery,
    entityType: ManagedEntityType = 'chat',
    profileOptions: ResolveUserProfilesOptions = {},
  ): Promise<MembershipActivityPage> {
    const allowRemoteLookup = profileOptions.allowRemoteLookup !== false;
    const limit = Math.max(1, Math.min(100, query.limit));
    const cursor = this.decodeMembershipActivityCursor(query.cursor);
    const eventTypes =
      query.filter === 'joined'
        ? ['user_added']
        : query.filter === 'left'
          ? ['user_removed']
          : ['user_added', 'user_removed'];
    const rows = await this.getMembershipEventRows(chatId, from, to, eventTypes, {
      cursor,
      limit: limit + 1,
      order: 'desc',
    });

    const pageRows = rows.slice(0, limit);
    const userIdsToResolve = pageRows
      .filter((row) => {
        if (allowRemoteLookup) {
          return true;
        }

        const directName = typeof row.sender_name === 'string' ? row.sender_name.trim() : '';
        return !directName;
      })
      .map((row) => (typeof row.user_id === 'string' ? row.user_id.trim() : ''))
      .filter(Boolean);
    const userProfiles = await this.resolveUserProfiles(
      chatId,
      entityType,
      userIdsToResolve,
      profileOptions,
    );
    const items = pageRows
      .map((row) => {
        const createdAt = this.toIsoString(row.created_at);
        if (!createdAt) {
          return null;
        }

        const normalizedUserId =
          typeof row.user_id === 'string' && row.user_id.trim()
            ? row.user_id.trim()
            : `unknown:${row.id}`;
        const eventType = row.event_type === 'user_removed' ? 'left' : 'joined';
        const directName = typeof row.sender_name === 'string' ? row.sender_name.trim() : '';
        const userProfile = userProfiles.get(normalizedUserId);
        const userDisplayName = directName || userProfile?.displayName || 'Участник';

        return {
          id: row.id,
          type: eventType,
          userId: normalizedUserId,
          userDisplayName,
          avatarUrl: userProfile?.avatarUrl ?? null,
          profileUrl: userProfile?.profileUrl ?? null,
          profileHandoffUrl:
            userProfile?.profileHandoffUrl ??
            this.buildProfileMentionHandoffUrl(
              chatId,
              entityType,
              normalizedUserId,
              userDisplayName,
            ),
          createdAt,
        };
      })
      .filter(
        (
          item,
        ): item is {
          id: string;
          type: 'joined' | 'left';
          userId: string;
          userDisplayName: string;
          avatarUrl: string | null;
          profileUrl: string | null;
          profileHandoffUrl: string | null;
          createdAt: string;
        } => item !== null,
      );
    const hasMore = rows.length > limit;
    const lastItem = items[items.length - 1] ?? null;

    return membershipActivityPageSchema.parse({
      items,
      hasMore,
      nextCursor:
        hasMore && lastItem
          ? this.encodeMembershipActivityCursor({
              createdAt: lastItem.createdAt,
              id: lastItem.id,
            })
          : null,
    });
  }

  buildEmptyMembershipActivityPage(): MembershipActivityPage {
    return membershipActivityPageSchema.parse({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  }

  getMembershipEventRows(
    chatId: string,
    from: Date,
    to: Date,
    eventTypes: readonly string[],
    options: {
      cursor?: { createdAt: string; id: string } | null;
      limit?: number;
      order?: 'asc' | 'desc';
    } = {},
  ): Promise<MembershipEventRow[]> {
    const order = options.order === 'asc' ? 'asc' : 'desc';
    const orderDirectionSql = Prisma.raw(order === 'asc' ? 'ASC' : 'DESC');
    const cursor = order === 'desc' ? (options.cursor ?? null) : null;
    const cursorClause = cursor
      ? Prisma.sql`
          AND (
            feed.event_at < ${cursor.createdAt}
            OR (feed.event_at = ${cursor.createdAt} AND feed.source_event_id < ${cursor.id})
          )
        `
      : Prisma.empty;
    const limitClause =
      typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Prisma.sql`LIMIT ${Math.max(1, Math.trunc(options.limit))}`
        : Prisma.empty;

    return this.prisma.$queryRaw<MembershipEventRow[]>`
      SELECT
        feed.source_event_id AS id,
        feed.event_at AS created_at,
        feed.event_type,
        feed.user_id,
        COALESCE(
          NULLIF(BTRIM(feed.sender_name), ''),
          (
            SELECT snapshot.display_name
            FROM chat_user_display_names AS snapshot
            WHERE snapshot.chat_id = feed.chat_id
              AND snapshot.user_id = feed.user_id
          )
        ) AS sender_name
      FROM chat_membership_activity_feed_items AS feed
      WHERE feed.chat_id = ${chatId}
        AND feed.event_type IN (${Prisma.join(eventTypes)})
        AND feed.event_at >= ${from}
        AND feed.event_at <= ${to}
        ${cursorClause}
      ORDER BY feed.event_at ${orderDirectionSql}, feed.source_event_id ${orderDirectionSql}
      ${limitClause}
    `;
  }

  invalidateLogsDashboardResponseCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.logsDashboardResponseCache.keys()) {
      if (key.startsWith(prefix)) {
        this.logsDashboardResponseCache.delete(key);
      }
    }
  }

  invalidateModerationFeedPageCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.moderationFeedPageCache.keys()) {
      if (key.startsWith(prefix)) {
        this.moderationFeedPageCache.delete(key);
      }
    }
  }

  private async buildLogsDashboardResponse(
    chatId: string,
    range: LogsDashboardRange,
    includeActivityPreview = true,
    includeModerationPreview = true,
  ): Promise<LogsDashboardResponse> {
    const startedAtMs = Date.now();
    const now = new Date();
    const from = this.resolveLogsDashboardFrom(range, now);
    const headerPromise =
      this.chatContextCache.getManagedEntityHeader?.(chatId, 'chat') ?? Promise.resolve(null);

    const baseQueriesStartedAtMs = Date.now();
    const [chat, membershipSummary, chatHeader, moderationSummary, moderationFeed] =
      await Promise.all([
        this.prisma.chat.findUnique({
          where: { id: chatId },
          select: { id: true, title: true },
        }),
        includeActivityPreview
          ? selectLogsDashboardMembershipSummary(this.prisma, chatId, from, now)
          : Promise.resolve({ joinedUsers: 0, leftUsers: 0 }),
        headerPromise,
        includeModerationPreview
          ? selectLogsDashboardModerationSummary(this.prisma, chatId, from, now)
          : Promise.resolve({
              warn: 0,
              deleteMessage: 0,
              mute: 0,
              ban: 0,
              unmute: 0,
              unban: 0,
              affectedUsers: 0,
            }),
        includeModerationPreview
          ? this.getModerationFeedPage(
              chatId,
              from,
              now,
              {
                range,
                filter: 'ALL',
                limit: LOGS_DASHBOARD_VIOLATIONS_LIMIT,
              },
              'chat',
              { allowRemoteLookup: false },
            )
          : this.buildEmptyModerationFeedPage(),
      ]);
    const baseQueriesFinishedAtMs = Date.now();

    const joinedUsers = membershipSummary.joinedUsers;
    const leftUsers = membershipSummary.leftUsers;
    const activityFeedStartedAtMs = Date.now();
    const activityFeed = includeActivityPreview
      ? await this.getMembershipActivityFeedPage(
          chatId,
          from,
          now,
          {
            range,
            filter: 'all',
            limit: MEMBERSHIP_ACTIVITY_PAGE_LIMIT,
          },
          'chat',
          { allowRemoteLookup: false },
        )
      : this.buildEmptyMembershipActivityPage();
    const activityFeedFinishedAtMs = Date.now();
    const response: LogsDashboardResponse = {
      chat: {
        id: chatId,
        title: chat?.title?.trim() || 'Чат без названия',
        participantsCount:
          typeof chatHeader?.participantsCount === 'number' &&
          Number.isFinite(chatHeader.participantsCount)
            ? Math.max(0, Math.trunc(chatHeader.participantsCount))
            : null,
        avatarUrl: chatHeader?.avatarUrl?.trim() || null,
      },
      period: {
        range,
        from: from.toISOString(),
        to: now.toISOString(),
      },
      membership: {
        joinedUsers,
        leftUsers,
        netUsers: joinedUsers - leftUsers,
      },
      violationsSummary: {
        warn: moderationSummary.warn,
        deleteMessage: moderationSummary.deleteMessage,
        mute: moderationSummary.mute,
        ban: moderationSummary.ban,
        unmute: moderationSummary.unmute,
        unban: moderationSummary.unban,
        affectedUsers: moderationSummary.affectedUsers,
        total:
          moderationSummary.warn +
          moderationSummary.deleteMessage +
          moderationSummary.mute +
          moderationSummary.ban +
          moderationSummary.unmute +
          moderationSummary.unban,
      },
      violations: moderationFeed.items,
      moderationFeed,
      activityFeed,
    };

    const finishedAtMs = Date.now();
    const totalMs = finishedAtMs - startedAtMs;
    if (totalMs >= SLOW_LOGS_DASHBOARD_THRESHOLD_MS) {
      this.logger.warn(
        {
          chatId,
          totalMs,
          range,
          includeActivityPreview,
          includeModerationPreview,
          baseQueriesMs: baseQueriesFinishedAtMs - baseQueriesStartedAtMs,
          activityFeedMs: activityFeedFinishedAtMs - activityFeedStartedAtMs,
          moderationPreviewCount: moderationFeed.items.length,
          activityPreviewCount: activityFeed.items.length,
        },
        'Slow logs dashboard build completed',
      );
    }

    return logsDashboardResponseSchema.parse(response);
  }

  private async getModerationFeedPage(
    chatId: string,
    from: Date,
    to: Date,
    query: ModerationFeedQuery,
    entityType: ManagedEntityType = 'chat',
    profileOptions: ResolveUserProfilesOptions = {},
  ): Promise<ModerationFeedPage> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const cursor = this.decodeModerationFeedCursor(query.cursor, { chatId, query });
    const rows = await selectModerationFeedReadModelRows(this.prisma, {
      chatId,
      from,
      to,
      filter: query.filter,
      cursor,
      limit: limit + 1,
    });

    const pageRows = rows.slice(0, limit);
    const userIdsToResolve = pageRows
      .filter((row) => !this.readTrimmedString(row.userDisplayName))
      .map((row) => row.userId);
    const userProfiles =
      userIdsToResolve.length > 0
        ? await this.resolveUserProfiles(chatId, entityType, userIdsToResolve, profileOptions)
        : new Map<string, ResolvedUserProfile>();
    const lastRow = pageRows.at(-1);

    return moderationFeedPageSchema.parse({
      items: pageRows.map((row) =>
        this.mapModerationViolationRow(
          chatId,
          entityType,
          row as ModerationViolationRow,
          userProfiles,
        ),
      ),
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && lastRow
          ? this.encodeModerationFeedCursor(
              {
                createdAt: lastRow.createdAt,
                id: lastRow.id,
              },
              { chatId, query },
            )
          : null,
    });
  }

  private async getCachedModerationFeedPage(
    chatId: string,
    userId: string,
    from: Date,
    to: Date,
    query: ModerationFeedQuery,
    entityType: ManagedEntityType,
    profileOptions: ResolveUserProfilesOptions = {},
  ): Promise<ModerationFeedPage> {
    const cacheKey = buildModerationFeedPageCacheKey(
      chatId,
      userId,
      entityType,
      query,
      profileOptions,
    );
    const cached = this.moderationFeedPageCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    const pending = this.getModerationFeedPage(
      chatId,
      from,
      to,
      query,
      entityType,
      profileOptions,
    ).catch((error: unknown) => {
      const current = this.moderationFeedPageCache.get(cacheKey);
      if (current?.promise === pending) {
        this.moderationFeedPageCache.delete(cacheKey);
      }
      throw error;
    });

    this.moderationFeedPageCache.set(cacheKey, {
      expiresAtMs:
        Date.now() + (query.cursor ? EVENTS_FEED_PAGE_CACHE_TTL_MS : EVENTS_FEED_HEAD_CACHE_TTL_MS),
      promise: pending,
    });

    return pending;
  }

  private async getCachedMembershipActivityFeedPage(
    chatId: string,
    userId: string,
    from: Date,
    to: Date,
    query: MembershipActivityQuery,
    entityType: ManagedEntityType,
    profileOptions: ResolveUserProfilesOptions = {},
  ): Promise<MembershipActivityPage> {
    const cacheKey = buildMembershipActivityFeedPageCacheKey(
      chatId,
      userId,
      entityType,
      query,
      profileOptions,
    );
    const cached = this.membershipActivityFeedPageCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    const pending = this.getMembershipActivityFeedPage(
      chatId,
      from,
      to,
      query,
      entityType,
      profileOptions,
    ).catch((error: unknown) => {
      const current = this.membershipActivityFeedPageCache.get(cacheKey);
      if (current?.promise === pending) {
        this.membershipActivityFeedPageCache.delete(cacheKey);
      }
      throw error;
    });

    this.membershipActivityFeedPageCache.set(cacheKey, {
      expiresAtMs:
        Date.now() + (query.cursor ? EVENTS_FEED_PAGE_CACHE_TTL_MS : EVENTS_FEED_HEAD_CACHE_TTL_MS),
      promise: pending,
    });

    return pending;
  }

  buildEmptyModerationFeedPage(): ModerationFeedPage {
    return moderationFeedPageSchema.parse({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  }

  private normalizeModerationViolationMetadata(metadata: unknown): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const normalized = { ...(metadata as Record<string, unknown>) };
    if (
      typeof normalized.muteDurationHours !== 'number' &&
      typeof normalized.banDurationHours === 'number'
    ) {
      normalized.muteDurationHours = normalized.banDurationHours;
    }

    if (typeof normalized.muteExpiresAt !== 'string') {
      if (typeof normalized.banExpiresAt === 'string') {
        normalized.muteExpiresAt = normalized.banExpiresAt;
      } else if (typeof normalized.unbanScheduledAt === 'string') {
        normalized.muteExpiresAt = normalized.unbanScheduledAt;
      }
    }

    return normalized;
  }

  private readStoredModerationTargetDisplayName(
    metadata: Record<string, unknown> | null,
  ): string | null {
    return this.readTrimmedString(metadata?.targetDisplayName) ?? null;
  }

  private normalizeModerationViolationAction(
    action: SanctionAction,
    metadata: Record<string, unknown> | null,
  ): SanctionAction {
    if (action === SanctionAction.KICK) {
      return SanctionAction.BAN;
    }

    if (
      action === SanctionAction.BAN &&
      metadata &&
      (typeof metadata.muteDurationHours === 'number' ||
        typeof metadata.banDurationHours === 'number')
    ) {
      return SanctionAction.MUTE;
    }

    return action;
  }

  private normalizeModerationViolationRuleCode(ruleCode: string, action: SanctionAction): string {
    if (ruleCode === 'MANUAL_KICK') {
      return 'MANUAL_BAN';
    }

    if (ruleCode === 'LOCAL_ADMIN_BLOCK') {
      return ruleCode;
    }

    if (ruleCode === 'BAN_ACTIVE_DELETE') {
      return 'MUTE_ACTIVE_DELETE';
    }

    if (ruleCode === 'GLOBAL_SPAMMER_KICK' || action === SanctionAction.KICK) {
      return 'GLOBAL_SPAMMER_BAN';
    }

    return ruleCode;
  }

  private mapModerationViolationRow(
    chatId: string,
    entityType: ManagedEntityType,
    row: ModerationViolationRow,
    userProfiles: Map<string, ResolvedUserProfile>,
  ): LogsDashboardViolation {
    const metadata = this.normalizeModerationViolationMetadata(row.metadata);
    const userProfile = userProfiles.get(row.userId);
    const action = this.normalizeModerationViolationAction(row.action, metadata);
    const ruleCode = this.normalizeModerationViolationRuleCode(row.ruleCode, row.action);
    const userDisplayName =
      this.readTrimmedString(row.userDisplayName) ??
      this.readStoredModerationTargetDisplayName(metadata) ??
      userProfile?.displayName ??
      null;

    return {
      id: row.id,
      action,
      ruleCode,
      userId: row.userId,
      userDisplayName,
      avatarUrl: row.avatarUrl ?? userProfile?.avatarUrl ?? null,
      profileUrl: row.profileUrl ?? userProfile?.profileUrl ?? null,
      profileHandoffUrl:
        row.profileHandoffUrl ??
        userProfile?.profileHandoffUrl ??
        this.buildProfileMentionHandoffUrl(chatId, entityType, row.userId, userDisplayName),
      createdAt: row.createdAt.toISOString(),
      maskedExcerpt: row.maskedExcerpt,
      metadata,
    };
  }

  private encodeModerationFeedCursor(
    value: ModerationFeedCursor,
    scope: { chatId: string; query: ModerationFeedQuery },
  ): string {
    return Buffer.from(
      JSON.stringify({
        createdAt: value.createdAt.toISOString(),
        id: value.id,
        chatId: scope.chatId,
        range: scope.query.range,
        filter: scope.query.filter,
      }),
      'utf8',
    ).toString('base64url');
  }

  private decodeModerationFeedCursor(
    cursor: string | undefined,
    scope: { chatId: string; query: ModerationFeedQuery },
  ): ModerationFeedCursor | null {
    const normalizedCursor = cursor?.trim() ?? '';
    if (!normalizedCursor) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        Buffer.from(normalizedCursor, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      const createdAtIso = typeof parsed.createdAt === 'string' ? parsed.createdAt.trim() : '';
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
      const createdAt = new Date(createdAtIso);

      // FLAG: A commercial page cannot borrow an unscoped legacy/action cursor. Scoped
      // cursors remain tied to their chat, range and filter across every new page.
      const hasScope = ['chatId', 'range', 'filter'].some((key) => Object.hasOwn(parsed, key));
      if (
        (hasScope || scope.query.filter === 'COMMERCIAL') &&
        (parsed.chatId !== scope.chatId ||
          parsed.range !== scope.query.range ||
          parsed.filter !== scope.query.filter)
      )
        throw new BadRequestException('Обновите журнал перед загрузкой следующей страницы.');

      if (!id || !createdAtIso || !Number.isFinite(createdAt.getTime())) {
        return null;
      }

      return {
        createdAt,
        id,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      return null;
    }
  }

  private encodeMembershipActivityCursor(cursor: { createdAt: string; id: string }): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeMembershipActivityCursor(
    value: string | undefined,
  ): { createdAt: string; id: string } | null {
    if (!value) {
      return null;
    }

    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as { createdAt?: unknown; id?: unknown };
      const createdAt =
        typeof parsed.createdAt === 'string' ? this.toIsoString(parsed.createdAt) : null;
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';

      if (!createdAt || !id) {
        throw new Error('Invalid membership activity cursor');
      }

      return { createdAt, id };
    } catch {
      throw new BadRequestException('Неверный cursor для activity feed.');
    }
  }
}
