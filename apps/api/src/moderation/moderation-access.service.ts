import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { Prisma, type ChatSettings } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { MaxClientService } from '../max/max-client.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import type { ChatAdminRosterSnapshot } from '../max/chat-admin-roster-state';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { raceWithTimeout } from '../common/promise-timeout.util';
import {
  CHAT_ADMIN_CACHE_TTL_MS,
  CHAT_ADMIN_LOOKUP_BACKOFF_MS,
  CHAT_ADMIN_LOOKUP_GUARD_SLACK_MS,
  CHAT_ADMIN_LOOKUP_SLOW_LOG_THRESHOLD_MS,
  CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS,
  CHAT_ADMIN_SOFT_LOOKUP_FAILURE_METRIC_STATUSES,
  CHAT_ADMIN_SOFT_TIMEOUT_BACKOFF_MS,
  DEFAULT_CHAT_ADMIN_LOOKUP_TIMEOUT_MS,
  type ChatAdminCheckResult,
  type PendingChatAdminLookupBatch,
  type PendingChatAdminSharedCacheBatch,
  type RemoteChatAdminAccessState,
} from './moderation.service.support';
import {
  extractDirectIncomingMessageText,
  parseAdminForwardedModerationCommand,
} from './admin-forwarded-command.util';
import { resolveChatReadBotId } from './moderation-bot-routing.util';

type ChatContextCacheWithAdminBatch = ChatContextCacheService & {
  getAdminAccessBatch?: (
    chatId: string,
    userIds: readonly string[],
  ) => Promise<Map<string, 'granted' | 'user_denied' | 'bot_denied' | null>>;
};

type RemoteChatAdminAccessProbe = {
  accessStates: Map<string, RemoteChatAdminAccessState>;
  probeStartedAt: Date;
};

@Injectable()
export class ModerationAccessService {
  private readonly logger = new Logger(ModerationAccessService.name);
  private readonly chatAdminAccessCache = new Map<
    string,
    {
      expiresAt: number;
      state: RemoteChatAdminAccessState;
    }
  >();
  private readonly chatAdminSharedCacheReadInFlight = new Map<
    string,
    Promise<RemoteChatAdminAccessState | null>
  >();
  private readonly chatAdminLookupInFlight = new Map<
    string,
    Promise<RemoteChatAdminAccessState | null>
  >();
  private readonly chatAdminLookupBackoffUntilMs = new Map<string, number>();
  private readonly chatAdminChatBackoffUntilMs = new Map<string, number>();
  private readonly pendingChatAdminSharedCacheBatches = new Map<
    string,
    PendingChatAdminSharedCacheBatch
  >();
  private readonly pendingChatAdminLookupBatches = new Map<string, PendingChatAdminLookupBatch>();
  private readonly chatAdminLookupTimeoutMs: number;
  private readonly chatAdminSyncRemoteLookupWhenLocalAdminsKnown: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional() configService?: ConfigService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    @Optional() private readonly adminRosters?: MaxChatAdminRosterSyncService,
  ) {
    this.chatAdminLookupTimeoutMs = this.readPositiveConfigInt(
      configService?.get<number>('CHAT_ADMIN_LOOKUP_TIMEOUT_MS'),
      DEFAULT_CHAT_ADMIN_LOOKUP_TIMEOUT_MS,
      250,
    );
    this.chatAdminSyncRemoteLookupWhenLocalAdminsKnown = this.readBooleanConfig(
      configService?.get<boolean | string>('CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN'),
      false,
    );
  }

  get syncRemoteLookupWhenLocalAdminsKnown(): boolean {
    return this.chatAdminSyncRemoteLookupWhenLocalAdminsKnown;
  }

  async confirmRegularMemberBeforePenalty(
    chatId: string,
    userId: string,
    options: { botId?: string } = {},
  ): Promise<boolean> {
    const normalizedChatId = chatId.trim();
    const normalizedUserId = userId.trim();
    if (!normalizedChatId || !normalizedUserId) return false;
    try {
      const botId =
        options.botId?.trim() ||
        (await resolveChatReadBotId(
          { maxBotLinkService: this.maxBotLinkService },
          normalizedChatId,
        ));
      if (!botId) return false;
      // FLAG: Saved DELETE immunity grants no reputation or episode authority.
      // Only a fresh exact human member may enter the penalty-producing threshold branch.
      const member = await this.maxClient.getChatMemberAccess(normalizedChatId, normalizedUserId, {
        botId,
        bypassCache: true,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'moderation.fanout.penalty.author',
        ignoreFailureMetricStatuses: CHAT_ADMIN_SOFT_LOOKUP_FAILURE_METRIC_STATUSES,
        timeoutMs: this.chatAdminLookupTimeoutMs,
      });
      return (
        member?.userId === normalizedUserId &&
        member.explicitNonPrivilegeEvidence === true &&
        member.isAdmin === false &&
        member.isOwner === false &&
        member.isBot === false
      );
    } catch {
      return false;
    }
  }

  async resolveSenderChatAdminCheck(
    chatId: string,
    localAdminUserIds: string[] | undefined,
    userId: string,
    options?: {
      allowRemoteLookup?: boolean;
      skipRemoteLookupWhenLocalAdminsKnown?: boolean;
      remoteLookupSoftTimeoutMs?: number;
      prefetchRemoteLookupWhenLocalAdminsKnown?: boolean;
      automaticDelete?: {
        roster: ChatAdminRosterSnapshot | null | undefined;
        botId?: string;
        useSavedProtection?: boolean;
      };
    },
  ): Promise<ChatAdminCheckResult> {
    const startedAtMs = Date.now();
    const localIsAdmin = this.isSenderChatAdmin(localAdminUserIds, userId);
    if (options?.automaticDelete) {
      const { roster, botId } = options.automaticDelete;
      void this.adminRosters?.observeActivity(chatId, botId, roster?.completedAt).catch(() => {
        this.logger.warn({ chatId }, 'Active chat administrator refresh could not be scheduled');
      });
      // FLAG: This is DELETE exemption only, never command or sanction authority.
      // A stale shared negative member cache cannot override the saved protection set.
      if (
        options.automaticDelete.useSavedProtection !== false &&
        roster?.completedAt &&
        roster.completeProbeStartedAt
      ) {
        return this.finalizeAdminCheckResult(
          { isAdmin: localIsAdmin, source: 'persisted_roster' },
          'admin-check.persisted-roster',
          startedAtMs,
        );
      }
    }
    const cachedRemoteAdminAccess = await this.getRemoteChatAdminAccess(chatId, userId, {
      allowLookup: false,
    });
    if (cachedRemoteAdminAccess === 'granted') {
      return this.finalizeAdminCheckResult(
        { isAdmin: true, source: 'remote' },
        'admin-check.remote-cache',
        startedAtMs,
      );
    }
    if (cachedRemoteAdminAccess === 'user_denied') {
      return this.finalizeAdminCheckResult(
        { isAdmin: false, source: 'remote' },
        'admin-check.remote-cache',
        startedAtMs,
      );
    }

    const localAdminsKnown = Array.isArray(localAdminUserIds) && localAdminUserIds.length > 0;
    if (options?.allowRemoteLookup === false) {
      return this.finalizeAdminCheckResult(
        { isAdmin: localIsAdmin, source: 'local_fallback' },
        'admin-check.local-fallback',
        startedAtMs,
      );
    }
    if (options?.skipRemoteLookupWhenLocalAdminsKnown && localAdminsKnown && !localIsAdmin) {
      if (options.prefetchRemoteLookupWhenLocalAdminsKnown) {
        void this.prefetchRemoteChatAdminAccess(chatId, userId);
      }
      return this.finalizeAdminCheckResult(
        { isAdmin: localIsAdmin, source: 'local_fallback' },
        'admin-check.local-fallback',
        startedAtMs,
      );
    }

    if (
      typeof options?.remoteLookupSoftTimeoutMs === 'number' &&
      options.remoteLookupSoftTimeoutMs > 0
    ) {
      const remoteAdminAccess = await this.getRemoteChatAdminAccessWithin(chatId, userId, {
        maxWaitMs: options.remoteLookupSoftTimeoutMs,
      });
      if (remoteAdminAccess) {
        if (remoteAdminAccess === 'granted') {
          return this.finalizeAdminCheckResult(
            { isAdmin: true, source: 'remote' },
            'admin-check.remote-soft-timeout',
            startedAtMs,
          );
        }
        return this.finalizeAdminCheckResult(
          { isAdmin: false, source: 'remote' },
          'admin-check.remote-soft-timeout',
          startedAtMs,
        );
      }

      return this.finalizeAdminCheckResult(
        { isAdmin: localIsAdmin, source: 'local_fallback' },
        'admin-check.soft-timeout-fallback',
        startedAtMs,
      );
    }

    const remoteAdminAccess = await this.getRemoteChatAdminAccess(chatId, userId);
    if (remoteAdminAccess) {
      if (remoteAdminAccess === 'granted') {
        return this.finalizeAdminCheckResult(
          { isAdmin: true, source: 'remote' },
          'admin-check.remote',
          startedAtMs,
        );
      }
      return this.finalizeAdminCheckResult(
        { isAdmin: false, source: 'remote' },
        'admin-check.remote',
        startedAtMs,
      );
    }

    return this.finalizeAdminCheckResult(
      {
        isAdmin: localIsAdmin,
        source: 'local_fallback',
      },
      'admin-check.local-fallback',
      startedAtMs,
    );
  }

  async recheckSenderChatAdminBeforeModeration(
    chatId: string,
    localAdminUserIds: string[] | undefined,
    userId: string,
    initialResult: ChatAdminCheckResult,
    options?: {
      maxWaitMs?: number;
    },
  ): Promise<ChatAdminCheckResult> {
    if (initialResult.isAdmin || initialResult.source !== 'local_fallback') {
      return initialResult;
    }

    const localAdminsKnown = Array.isArray(localAdminUserIds) && localAdminUserIds.length > 0;
    if (!localAdminsKnown) {
      return initialResult;
    }

    const startedAtMs = Date.now();
    const cachedRemoteAdminAccess = await this.getRemoteChatAdminAccess(chatId, userId, {
      allowLookup: false,
    });
    if (cachedRemoteAdminAccess === 'granted') {
      return this.finalizeAdminCheckResult(
        { isAdmin: true, source: 'remote+local' },
        'admin-check.violation-cache',
        startedAtMs,
      );
    }
    if (cachedRemoteAdminAccess === 'user_denied') {
      return this.finalizeAdminCheckResult(
        { isAdmin: false, source: 'remote' },
        'admin-check.violation-cache',
        startedAtMs,
      );
    }

    const maxWaitMs = Math.max(
      1,
      Math.ceil(options?.maxWaitMs ?? CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS),
    );
    const remoteAdminAccess = await this.getRemoteChatAdminAccessWithin(chatId, userId, {
      maxWaitMs,
    });
    if (remoteAdminAccess === 'granted') {
      return this.finalizeAdminCheckResult(
        { isAdmin: true, source: 'remote+local' },
        'admin-check.violation-recheck',
        startedAtMs,
      );
    }
    if (remoteAdminAccess === 'user_denied') {
      return this.finalizeAdminCheckResult(
        { isAdmin: false, source: 'remote' },
        'admin-check.violation-recheck',
        startedAtMs,
      );
    }

    return this.finalizeAdminCheckResult(
      initialResult,
      'admin-check.violation-fallback',
      startedAtMs,
    );
  }

  async isOtherBotAdminModerationBypass(params: {
    chatId: string;
    localAdminUserIds: string[] | undefined;
    senderId: string;
    degradeMode: boolean;
    hotChatBackoffActive: boolean;
  }): Promise<boolean> {
    const { chatId, localAdminUserIds, senderId, degradeMode, hotChatBackoffActive } = params;
    const senderAdminCheck = await this.resolveSenderChatAdminCheck(
      chatId,
      localAdminUserIds,
      senderId,
      {
        allowRemoteLookup: !degradeMode && !hotChatBackoffActive,
        skipRemoteLookupWhenLocalAdminsKnown: false,
        remoteLookupSoftTimeoutMs:
          !degradeMode && !hotChatBackoffActive
            ? CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS
            : undefined,
      },
    );
    if (!senderAdminCheck.isAdmin) {
      if (senderAdminCheck.source === 'local_fallback') {
        this.logger.debug(
          {
            chatId,
            userId: senderId,
          },
          'Skipped destructive bot-account moderation because admin access is unresolved',
        );
        return true;
      }
      return false;
    }

    this.logger.debug(
      {
        chatId,
        userId: senderId,
        source: senderAdminCheck.source,
      },
      'Moderation bypassed for admin bot sender',
    );
    return true;
  }

  buildChatAdminAccessLookupKey(chatId: string, userId: string): string {
    const normalizedUserId =
      [...this.buildUserIdVariants(userId)].sort((left, right) => {
        if (left.length !== right.length) {
          return left.length - right.length;
        }
        return left.localeCompare(right);
      })[0] ?? userId.trim().toLowerCase();

    return `${chatId}:${normalizedUserId}`;
  }

  async getRemoteChatAdminAccess(
    chatId: string,
    userId: string,
    options: {
      allowLookup?: boolean;
    } = {},
  ): Promise<RemoteChatAdminAccessState | null> {
    const cacheKey = this.buildChatAdminAccessLookupKey(chatId, userId);
    const now = Date.now();
    const cached = this.chatAdminAccessCache.get(cacheKey);
    const fencedSharedCache = this.supportsFencedSharedAdminAccessCache();
    if (!fencedSharedCache && cached && cached.expiresAt > now) {
      return cached.state;
    }
    // FLAG: Expired human-role evidence cannot become fresh authority after a failed lookup.
    const staleCached = null;

    const cachedFromSharedStore = await this.readChatAdminAccessFromSharedCache(
      chatId,
      userId,
      now,
    );
    if (cachedFromSharedStore) {
      this.chatAdminLookupBackoffUntilMs.delete(cacheKey);
      return cachedFromSharedStore;
    }
    if (fencedSharedCache) {
      this.chatAdminAccessCache.delete(cacheKey);
    }

    const backoffUntilMs = this.chatAdminLookupBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > now) {
      return staleCached;
    }

    const chatBackoffUntilMs = this.chatAdminChatBackoffUntilMs.get(chatId) ?? 0;
    if (chatBackoffUntilMs > now) {
      return staleCached;
    }

    if (options.allowLookup === false) {
      return staleCached;
    }

    const sharedBackoffRemainingMs = await this.getSharedChatAdminLookupBackoffRemainingMs(chatId);
    if (sharedBackoffRemainingMs > 0) {
      const sharedBackoffUntilMs = Date.now() + sharedBackoffRemainingMs;
      this.chatAdminChatBackoffUntilMs.set(chatId, sharedBackoffUntilMs);
      this.chatAdminLookupBackoffUntilMs.set(cacheKey, sharedBackoffUntilMs);
      return staleCached;
    }

    const inFlight = this.chatAdminLookupInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    return this.enqueueChatAdminLookupBatch(chatId, userId, cacheKey, staleCached);
  }

  async getRemoteChatAdminAccessWithin(
    chatId: string,
    userId: string,
    options: {
      maxWaitMs: number;
    },
  ): Promise<RemoteChatAdminAccessState | null> {
    const cacheKey = this.buildChatAdminAccessLookupKey(chatId, userId);
    const lookupPromise = this.getRemoteChatAdminAccess(chatId, userId);
    const maxWaitMs = Math.max(1, Math.ceil(options.maxWaitMs));

    return raceWithTimeout({
      operation: lookupPromise,
      timeoutMs: maxWaitMs,
      onTimeout: () => {
        const softBackoffUntilMs = Date.now() + CHAT_ADMIN_SOFT_TIMEOUT_BACKOFF_MS;
        if ((this.chatAdminChatBackoffUntilMs.get(chatId) ?? 0) < softBackoffUntilMs) {
          this.chatAdminChatBackoffUntilMs.set(chatId, softBackoffUntilMs);
        }
        if ((this.chatAdminLookupBackoffUntilMs.get(cacheKey) ?? 0) < softBackoffUntilMs) {
          this.chatAdminLookupBackoffUntilMs.set(cacheKey, softBackoffUntilMs);
        }
        void this.activateSharedChatAdminLookupBackoff(chatId, CHAT_ADMIN_SOFT_TIMEOUT_BACKOFF_MS);
        return null;
      },
    });
  }

  async loadRemoteChatAdminAccessBatch(
    chatId: string,
    userIds: readonly string[],
    options: {
      trafficClass?: 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<Map<string, RemoteChatAdminAccessState>> {
    return (await this.loadRemoteChatAdminAccessProbeBatch(chatId, userIds, options)).accessStates;
  }

  private async loadRemoteChatAdminAccessProbeBatch(
    chatId: string,
    userIds: readonly string[],
    options: {
      trafficClass?: 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<RemoteChatAdminAccessProbe> {
    const normalizedUserIds = Array.from(
      new Set(userIds.map((userId) => userId.trim()).filter((value) => value.length > 0)),
    );
    const results = new Map<string, RemoteChatAdminAccessState>();
    if (normalizedUserIds.length === 0) {
      return {
        accessStates: results,
        probeStartedAt: new Date(),
      };
    }

    const resolvedBotId = await resolveChatReadBotId(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      chatId,
    );
    const requestOptions = {
      // FLAG: The shared authority cache owns freshness; a new probe needs live MAX evidence.
      bypassCache: true,
      trafficClass: options.trafficClass ?? ('interactive' as const),
      actionHealthLane: 'background' as const,
      ignoreFailureMetricStatuses: CHAT_ADMIN_SOFT_LOOKUP_FAILURE_METRIC_STATUSES,
      timeoutMs: options.timeoutMs ?? this.chatAdminLookupTimeoutMs,
      ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
      ...(resolvedBotId ? { botId: resolvedBotId } : {}),
    };
    const maxClientWithAccess = this.maxClient as Partial<MaxClientService>;

    if (typeof maxClientWithAccess.getChatMembersAccess === 'function') {
      const probeStartedAt = new Date();
      const accessByUserId = await this.executeRemoteChatAdminLookupWithGuard(
        () =>
          maxClientWithAccess.getChatMembersAccess!.call(
            this.maxClient,
            chatId,
            normalizedUserIds,
            requestOptions,
          ),
        {
          chatId,
          userIds: normalizedUserIds,
          botId: resolvedBotId,
        },
      );
      for (const normalizedUserId of normalizedUserIds) {
        const userAccess = accessByUserId.get(normalizedUserId) ?? null;
        const hasUserAccess = userAccess?.isAdmin === true || userAccess?.isOwner === true;
        const accessState: RemoteChatAdminAccessState = hasUserAccess ? 'granted' : 'user_denied';

        results.set(normalizedUserId, accessState);
      }

      return {
        accessStates: results,
        probeStartedAt,
      };
    }

    const getChatAdminIds = maxClientWithAccess.getChatAdminIds;
    if (typeof getChatAdminIds !== 'function') {
      return {
        accessStates: results,
        probeStartedAt: new Date(),
      };
    }

    const probeStartedAt = new Date();
    const rawAdminUserIds = await getChatAdminIds.call(this.maxClient, chatId, requestOptions);
    if (!Array.isArray(rawAdminUserIds)) {
      return {
        accessStates: results,
        probeStartedAt,
      };
    }

    for (const normalizedUserId of normalizedUserIds) {
      results.set(
        normalizedUserId,
        this.isSenderChatAdmin(rawAdminUserIds, normalizedUserId) ? 'granted' : 'user_denied',
      );
    }

    return {
      accessStates: results,
      probeStartedAt,
    };
  }

  shouldForceSynchronousRemoteAdminLookup(
    update: MaxUpdate,
    settings?: Pick<
      ChatSettings,
      | 'adminBanCommandName'
      | 'adminBanAllCommandName'
      | 'adminMuteCommandName'
      | 'adminPermanentMuteCommandName'
      | 'adminRulesCommandName'
      | 'adminSilenceCommandName'
      | 'adminOpenChatCommandName'
    >,
  ): boolean {
    if (this.chatAdminSyncRemoteLookupWhenLocalAdminsKnown) {
      return true;
    }

    const directText = extractDirectIncomingMessageText(update);
    if (!directText.trim()) {
      return false;
    }

    try {
      return parseAdminForwardedModerationCommand(directText, settings) !== null;
    } catch {
      return true;
    }
  }

  prefetchRemoteChatAdminAccess(chatId: string, userId: string): void {
    void this.getRemoteChatAdminAccess(chatId, userId).catch((error: unknown) => {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Background remote chat admin access prefetch failed',
      );
    });
  }

  async executeRemoteChatAdminLookupWithGuard<T>(
    operation: () => Promise<T>,
    context: {
      chatId: string;
      userIds: readonly string[];
      botId?: string | null;
    },
  ): Promise<T> {
    const startedAtMs = Date.now();
    const timeoutMs = this.resolveChatAdminLookupGuardTimeoutMs();
    const operationPromise = operation();

    const result = await raceWithTimeout({
      operation: operationPromise,
      timeoutMs,
      onTimeout: () => {
        throw this.createChatAdminLookupTimeoutError(context, timeoutMs);
      },
    });
    const durationMs = Date.now() - startedAtMs;
    if (durationMs >= CHAT_ADMIN_LOOKUP_SLOW_LOG_THRESHOLD_MS) {
      this.logger.warn(
        {
          chatId: context.chatId,
          userIds: context.userIds,
          botId: context.botId ?? null,
          durationMs,
        },
        'Slow remote chat admin lookup completed close to the hot-path deadline',
      );
    }
    return result;
  }

  async persistRemoteAdminGrant(
    chatId: string,
    userId: string,
    probeStartedAt = new Date(),
  ): Promise<void> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return;
    }

    try {
      const accessStates = new Map<string, RemoteChatAdminAccessState>([
        [normalizedUserId, 'granted'],
      ]);
      const acceptedUserIds = await this.acceptRemoteChatAdminAccessProbe({
        chatId,
        accessStates,
        probeStartedAt,
      });
      if (!acceptedUserIds.has(normalizedUserId)) {
        return;
      }

      await this.publishAcceptedRemoteChatAdminAccess({
        chatId,
        userId: normalizedUserId,
        state: 'granted',
        probeStartedAt,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to publish remotely confirmed chat admin access',
      );
    }
  }

  private async acceptRemoteChatAdminAccessProbe(params: {
    chatId: string;
    accessStates: ReadonlyMap<string, RemoteChatAdminAccessState>;
    probeStartedAt: Date;
  }): Promise<Set<string>> {
    const normalizedEntries = [...params.accessStates.entries()]
      .map(([userId, state]) => [userId.trim(), state] as const)
      .filter(([userId]) => userId.length > 0);
    if (normalizedEntries.length === 0) {
      return new Set<string>();
    }

    if (typeof this.prisma.$transaction !== 'function') {
      return new Set<string>();
    }

    return this.prisma.$transaction(async (tx) => {
      const lockedChats = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${params.chatId}
        FOR UPDATE OF chat
      `);
      if (lockedChats.length !== 1) {
        return new Set<string>();
      }

      const variantToUserIds = new Map<string, Set<string>>();
      for (const [userId] of normalizedEntries) {
        for (const variant of this.buildUserIdVariants(userId)) {
          let mappedUserIds = variantToUserIds.get(variant);
          if (!mappedUserIds) {
            mappedUserIds = new Set<string>();
            variantToUserIds.set(variant, mappedUserIds);
          }
          mappedUserIds.add(userId);
        }
      }

      const userIdVariants = [...variantToUserIds.keys()];
      const supersedingRows = await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
        SELECT activity."user_id" AS "userId"
        FROM "chat_membership_activity_events" AS activity
        WHERE activity."chat_id" = ${params.chatId}
          AND activity."user_id" IN (${Prisma.join(userIdVariants)})
          AND activity."event_type" IN ('user_added', 'user_removed')
          AND activity."event_at" >= ${params.probeStartedAt}
        UNION ALL
        SELECT edge."user_id" AS "userId"
        FROM "managed_entity_access_edges" AS edge
        WHERE edge."chat_id" = ${params.chatId}
          AND edge."user_id" IN (${Prisma.join(userIdVariants)})
          AND edge."checked_at" > ${params.probeStartedAt}
        UNION ALL
        SELECT member."user_id" AS "userId"
        FROM "managed_entity_admin_members" AS member
        WHERE member."chat_id" = ${params.chatId}
          AND member."user_id" IN (${Prisma.join(userIdVariants)})
          AND member."checked_at" > ${params.probeStartedAt}
        UNION ALL
        SELECT admin."user_id" AS "userId"
        FROM "chat_admin_allowlist" AS admin
        WHERE admin."chat_id" = ${params.chatId}
          AND admin."user_id" IN (${Prisma.join(userIdVariants)})
          AND admin."created_at" > ${params.probeStartedAt}
      `);
      const supersededUserIds = new Set<string>();
      for (const row of supersedingRows) {
        for (const userId of variantToUserIds.get(row.userId.trim().toLowerCase()) ?? []) {
          supersededUserIds.add(userId);
        }
      }

      const acceptedUserIds = new Set<string>();
      for (const [userId] of normalizedEntries) {
        if (supersededUserIds.has(userId)) {
          continue;
        }
        acceptedUserIds.add(userId);
      }
      const deniedVariants = [
        ...new Set(
          normalizedEntries
            .filter(([userId, state]) => state === 'user_denied' && acceptedUserIds.has(userId))
            .flatMap(([userId]) => [...this.buildUserIdVariants(userId)]),
        ),
      ];
      if (deniedVariants.length) {
        // FLAG: Prune only the obsolete moderation roster under the parent proof fence.
        // Saved navigation edges remain intact; a timeout never reaches this mutation.
        await tx.$queryRaw(Prisma.sql`
          DELETE FROM "chat_admin_allowlist"
          WHERE "chat_id" = ${params.chatId}
            AND "user_id" IN (${Prisma.join(deniedVariants)})
            AND "created_at" <= ${params.probeStartedAt}
          RETURNING "user_id"
        `);
      }
      return acceptedUserIds;
    });
  }

  private async publishAcceptedRemoteChatAdminAccess(params: {
    chatId: string;
    userId: string;
    state: RemoteChatAdminAccessState;
    probeStartedAt: Date;
  }): Promise<boolean> {
    return this.writeChatAdminAccessToSharedCache(
      params.chatId,
      params.userId,
      params.state,
      params.probeStartedAt,
    );
  }

  private enqueueChatAdminLookupBatch(
    chatId: string,
    userId: string,
    cacheKey: string,
    staleCached: RemoteChatAdminAccessState | null,
  ): Promise<RemoteChatAdminAccessState | null> {
    let batch = this.pendingChatAdminLookupBatches.get(chatId);
    if (!batch) {
      batch = {
        chatId,
        lookups: new Map(),
        scheduled: false,
      };
      this.pendingChatAdminLookupBatches.set(chatId, batch);
    }

    const lookupPromise = new Promise<RemoteChatAdminAccessState | null>((resolve) => {
      batch!.lookups.set(cacheKey, {
        cacheKey,
        userId,
        staleCached,
        resolve,
      });
    });

    const trackedLookupPromise = lookupPromise.finally(() => {
      if (this.chatAdminLookupInFlight.get(cacheKey) === trackedLookupPromise) {
        this.chatAdminLookupInFlight.delete(cacheKey);
      }
    });

    this.chatAdminLookupInFlight.set(cacheKey, trackedLookupPromise);

    if (!batch.scheduled) {
      batch.scheduled = true;
      void Promise.resolve().then(() => this.flushPendingChatAdminLookupBatch(chatId));
    }

    return trackedLookupPromise;
  }

  private async flushPendingChatAdminLookupBatch(chatId: string): Promise<void> {
    const batch = this.pendingChatAdminLookupBatches.get(chatId);
    if (!batch) {
      return;
    }

    this.pendingChatAdminLookupBatches.delete(chatId);
    const lookups = [...batch.lookups.values()];
    if (lookups.length === 0) {
      return;
    }

    const normalizedUserIds = Array.from(
      new Set(lookups.map((lookup) => lookup.userId.trim()).filter((value) => value.length > 0)),
    );
    if (normalizedUserIds.length === 0) {
      for (const lookup of lookups) {
        lookup.resolve('user_denied');
      }
      return;
    }

    try {
      const probe = await this.loadRemoteChatAdminAccessProbeBatch(chatId, normalizedUserIds);
      const acceptedUserIds = await this.acceptRemoteChatAdminAccessProbe({
        chatId,
        accessStates: probe.accessStates,
        probeStartedAt: probe.probeStartedAt,
      });
      this.chatAdminChatBackoffUntilMs.delete(chatId);

      for (const lookup of lookups) {
        const normalizedUserId = lookup.userId.trim();
        const probedAccessState = probe.accessStates.get(normalizedUserId) ?? null;
        if (probedAccessState && !acceptedUserIds.has(normalizedUserId)) {
          this.chatAdminAccessCache.delete(lookup.cacheKey);
          lookup.resolve(null);
          continue;
        }

        const accessState = probedAccessState ?? lookup.staleCached;
        if (!accessState) {
          lookup.resolve(null);
          continue;
        }

        if (
          probedAccessState &&
          !(await this.publishAcceptedRemoteChatAdminAccess({
            chatId,
            userId: lookup.userId,
            state: probedAccessState,
            probeStartedAt: probe.probeStartedAt,
          }))
        ) {
          this.chatAdminAccessCache.delete(lookup.cacheKey);
          lookup.resolve(null);
          continue;
        }

        this.chatAdminAccessCache.set(lookup.cacheKey, {
          expiresAt: Date.now() + CHAT_ADMIN_CACHE_TTL_MS,
          state: accessState,
        });
        this.chatAdminLookupBackoffUntilMs.delete(lookup.cacheKey);

        lookup.resolve(accessState);
      }
    } catch (error: unknown) {
      const transient = this.isTransientMaxApiLookupError(error);
      const denied = this.isDeniedMaxApiLookupError(error);
      const shouldBackoff = transient || denied;
      if (shouldBackoff) {
        const backoffUntilMs = Date.now() + CHAT_ADMIN_LOOKUP_BACKOFF_MS;
        this.chatAdminChatBackoffUntilMs.set(chatId, backoffUntilMs);
        for (const lookup of lookups) {
          this.chatAdminLookupBackoffUntilMs.set(lookup.cacheKey, backoffUntilMs);
        }
        void this.activateSharedChatAdminLookupBackoff(chatId, CHAT_ADMIN_LOOKUP_BACKOFF_MS);
      }

      this.logger.warn(
        {
          chatId,
          userIds: lookups.map((lookup) => lookup.userId),
          backoffMs: shouldBackoff ? CHAT_ADMIN_LOOKUP_BACKOFF_MS : 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to resolve chat admins for moderation bypass',
      );
      for (const lookup of lookups) {
        lookup.resolve(lookup.staleCached);
      }
    }
  }

  private async getSharedChatAdminLookupBackoffRemainingMs(chatId: string): Promise<number> {
    try {
      const remainingMs = await this.chatContextCache?.getAdminLookupBackoffRemainingMs?.(chatId);
      return typeof remainingMs === 'number' && remainingMs > 0 ? remainingMs : 0;
    } catch {
      return 0;
    }
  }

  private async activateSharedChatAdminLookupBackoff(chatId: string, ttlMs: number): Promise<void> {
    try {
      await this.chatContextCache?.activateAdminLookupBackoff?.(
        chatId,
        Math.max(1, Math.ceil(ttlMs / 1_000)),
      );
    } catch {
      return;
    }
  }

  private resolveChatAdminLookupGuardTimeoutMs(): number {
    return this.chatAdminLookupTimeoutMs + CHAT_ADMIN_LOOKUP_GUARD_SLACK_MS;
  }

  private createChatAdminLookupTimeoutError(
    context: {
      chatId: string;
      userIds: readonly string[];
      botId?: string | null;
    },
    timeoutMs: number,
  ): Error {
    const error = new Error(
      `Remote chat admin lookup for ${context.chatId} timed out after ${timeoutMs}ms`,
    ) as Error & { code?: string };
    error.code = 'ECONNABORTED';
    return error;
  }

  private async readChatAdminAccessFromSharedCache(
    chatId: string,
    userId: string,
    nowMs: number,
  ): Promise<RemoteChatAdminAccessState | null> {
    const chatContextCache = this.chatContextCache as ChatContextCacheWithAdminBatch | undefined;
    if (
      typeof chatContextCache?.getAdminAccess !== 'function' &&
      typeof chatContextCache?.getAdminAccessBatch !== 'function'
    ) {
      return null;
    }

    const cacheKey = this.buildChatAdminAccessLookupKey(chatId, userId);
    const inFlight = this.chatAdminSharedCacheReadInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    return this.enqueueChatAdminSharedCacheReadBatch(chatId, userId, cacheKey, nowMs);
  }

  private enqueueChatAdminSharedCacheReadBatch(
    chatId: string,
    userId: string,
    cacheKey: string,
    nowMs: number,
  ): Promise<RemoteChatAdminAccessState | null> {
    let batch = this.pendingChatAdminSharedCacheBatches.get(chatId);
    if (!batch) {
      batch = {
        chatId,
        reads: new Map(),
        scheduled: false,
      };
      this.pendingChatAdminSharedCacheBatches.set(chatId, batch);
    }

    const readPromise = new Promise<RemoteChatAdminAccessState | null>((resolve, reject) => {
      batch!.reads.set(cacheKey, {
        cacheKey,
        userId,
        resolve,
        reject,
      });
    });

    const trackedReadPromise = readPromise.finally(() => {
      if (this.chatAdminSharedCacheReadInFlight.get(cacheKey) === trackedReadPromise) {
        this.chatAdminSharedCacheReadInFlight.delete(cacheKey);
      }
    });

    this.chatAdminSharedCacheReadInFlight.set(cacheKey, trackedReadPromise);

    if (!batch.scheduled) {
      batch.scheduled = true;
      void Promise.resolve().then(() =>
        this.flushPendingChatAdminSharedCacheReadBatch(chatId, nowMs),
      );
    }

    return trackedReadPromise;
  }

  private async flushPendingChatAdminSharedCacheReadBatch(
    chatId: string,
    nowMs: number,
  ): Promise<void> {
    const batch = this.pendingChatAdminSharedCacheBatches.get(chatId);
    if (!batch) {
      return;
    }

    this.pendingChatAdminSharedCacheBatches.delete(chatId);
    const reads = [...batch.reads.values()];
    if (reads.length === 0) {
      return;
    }

    try {
      const accessStates = await this.loadSharedChatAdminAccessBatch(
        chatId,
        reads.map((read) => read.userId),
      );

      for (const read of reads) {
        const normalizedUserId = read.userId.trim();
        const cached = accessStates.get(normalizedUserId) ?? null;
        if (cached === 'granted' || cached === 'user_denied') {
          this.chatAdminAccessCache.set(read.cacheKey, {
            expiresAt: nowMs + CHAT_ADMIN_CACHE_TTL_MS,
            state: cached,
          });
        }
        read.resolve(cached);
      }
    } catch (error: unknown) {
      for (const read of reads) {
        read.reject(error);
      }
    }
  }

  private async loadSharedChatAdminAccessBatch(
    chatId: string,
    userIds: readonly string[],
  ): Promise<Map<string, RemoteChatAdminAccessState>> {
    const chatContextCache = this.chatContextCache as ChatContextCacheWithAdminBatch | undefined;
    const normalizedUserIds = Array.from(
      new Set(userIds.map((userId) => userId.trim()).filter((value) => value.length > 0)),
    );
    const results = new Map<string, RemoteChatAdminAccessState>();
    if (normalizedUserIds.length === 0 || !chatContextCache) {
      return results;
    }

    const userIdVariants = new Map<string, string[]>();
    const normalizedVariantUserIds: string[] = [];
    const variantSeen = new Set<string>();
    for (const normalizedUserId of normalizedUserIds) {
      const variants = [...this.buildUserIdVariants(normalizedUserId)];
      userIdVariants.set(normalizedUserId, variants);
      for (const variant of variants) {
        if (variantSeen.has(variant)) {
          continue;
        }
        variantSeen.add(variant);
        normalizedVariantUserIds.push(variant);
      }
    }

    const variantStates = new Map<string, 'granted' | 'user_denied' | 'bot_denied' | null>();
    if (typeof chatContextCache.getAdminAccessBatch === 'function') {
      const cachedStates = await chatContextCache.getAdminAccessBatch(
        chatId,
        normalizedVariantUserIds,
      );
      for (const variant of normalizedVariantUserIds) {
        variantStates.set(variant, cachedStates.get(variant) ?? null);
      }
    } else if (typeof chatContextCache.getAdminAccess === 'function') {
      const cachedStates = await Promise.all(
        normalizedVariantUserIds.map((variant) =>
          chatContextCache.getAdminAccess!(chatId, variant),
        ),
      );
      normalizedVariantUserIds.forEach((variant, index) => {
        variantStates.set(variant, cachedStates[index] ?? null);
      });
    }

    for (const normalizedUserId of normalizedUserIds) {
      const variants = userIdVariants.get(normalizedUserId) ?? [];
      const cachedStates = variants.map((variant) => variantStates.get(variant));
      const hasGranted = cachedStates.includes('granted');
      const hasUserDenied = cachedStates.includes('user_denied');
      if (hasGranted && !hasUserDenied) {
        results.set(normalizedUserId, 'granted');
      } else if (
        cachedStates.length > 0 &&
        cachedStates.every((state) => state === 'user_denied')
      ) {
        results.set(normalizedUserId, 'user_denied');
      }
    }

    return results;
  }

  private async writeChatAdminAccessToSharedCache(
    chatId: string,
    userId: string,
    state: RemoteChatAdminAccessState,
    probeStartedAt: Date,
  ): Promise<boolean> {
    const chatContextCache = this.chatContextCache as ChatContextCacheWithAdminBatch | undefined;
    if (!chatContextCache || typeof chatContextCache.applyAdminAccessEpochMutation !== 'function') {
      return state !== 'granted';
    }

    const variants = [...this.buildUserIdVariants(userId)];
    try {
      for (const variant of variants) {
        const applied = await chatContextCache.applyAdminAccessEpochMutation({
          chatId,
          userId: variant,
          state,
          eventAt: probeStartedAt,
        });
        if (!applied) {
          return false;
        }
      }
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to write chat admin access to shared cache',
      );
      return false;
    }
  }

  private supportsFencedSharedAdminAccessCache(): boolean {
    const chatContextCache = this.chatContextCache as ChatContextCacheWithAdminBatch | undefined;
    return (
      typeof chatContextCache?.applyAdminAccessEpochMutation === 'function' &&
      (typeof chatContextCache.getAdminAccess === 'function' ||
        typeof chatContextCache.getAdminAccessBatch === 'function')
    );
  }

  isSenderChatAdmin(adminUserIds: string[] | undefined, userId: string): boolean {
    if (!Array.isArray(adminUserIds) || adminUserIds.length === 0) {
      return false;
    }

    const senderVariants = this.buildUserIdVariants(userId);
    if (senderVariants.size === 0) {
      return false;
    }

    for (const adminUserId of adminUserIds) {
      for (const variant of this.buildUserIdVariants(adminUserId)) {
        if (senderVariants.has(variant)) {
          return true;
        }
      }
    }

    return false;
  }

  private buildUserIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return new Set<string>();
    }

    const variants = new Set<string>([normalized]);

    if (normalized.startsWith('id') && normalized.length > 2) {
      variants.add(normalized.slice(2));
    } else {
      variants.add(`id${normalized}`);
    }

    return variants;
  }

  private isTransientMaxApiLookupError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return (
      (status !== null && status >= 500 && status <= 599) ||
      this.isMaxApiThrottleError(error) ||
      this.isMaxApiTimeoutError(error)
    );
  }

  private isDeniedMaxApiLookupError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return status === 403 || status === 404;
  }

  private isMaxApiThrottleError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 429) {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('rate limit exceeded') ||
      message.includes('source limit exceeded') ||
      message.includes('circuit breaker')
    );
  }

  private isMaxApiTimeoutError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && code.trim().toUpperCase() === 'ECONNABORTED') {
      return true;
    }

    return this.extractMaxErrorMessage(error).includes('timeout');
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractMaxErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return responseMessage.trim().toLowerCase();
    }

    return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  }

  private finalizeAdminCheckResult(
    result: ChatAdminCheckResult,
    stage: string,
    startedAtMs: number,
  ): ChatAdminCheckResult {
    this.recordRuntimeStageObservation(stage, Date.now() - startedAtMs);
    return result;
  }

  private recordRuntimeStageObservation(stage: string, elapsedMs: number): void {
    if (!stage.trim()) {
      return;
    }

    void this.runtimeDiagnosticsService?.recordHotPathProfile({
      snapshot: {
        stageDurations: {
          [stage]: Math.max(0, Math.trunc(elapsedMs)),
        },
      },
    });
  }

  private readPositiveConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private readBooleanConfig(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (
        normalized === 'true' ||
        normalized === '1' ||
        normalized === 'yes' ||
        normalized === 'on'
      ) {
        return true;
      }
      if (
        normalized === 'false' ||
        normalized === '0' ||
        normalized === 'no' ||
        normalized === 'off'
      ) {
        return false;
      }
    }
    return fallback;
  }
}
