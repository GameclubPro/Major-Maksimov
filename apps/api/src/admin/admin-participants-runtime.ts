import { readTrimmedString } from './admin-legacy-utils';
import { hasFormerParticipantHistory } from './former-participant-moderation';
import { toSafeInteger, resolveLogsDashboardFrom } from './admin-statistics-values';
import { buildUserProfileUrl, normalizeMaxProfileUrl } from './admin-profile-links';
import {
  chatParticipantImmunitySchema,
  chatParticipantImmunityUpdateRequestSchema,
  chatParticipantImmunityUpdateResultSchema,
  chatParticipantsPageSchema,
  chatParticipantsQuerySchema,
  chatUnavailableParticipantsCleanupRequestSchema,
  chatUnavailableParticipantsCleanupResultSchema,
  type ChatUnavailableParticipantReason,
  type ChatUnavailableParticipantsCleanupItem,
  type ChatUnavailableParticipantsCleanupResult,
  type ChatParticipantImmunity,
  type ChatParticipantImmunityUpdateResult,
  type ChatParticipantItem,
  type ChatParticipantDetails,
  type ChatParticipantsPage,
  type ChatParticipantsQuery,
  type ManagedEntityType,
} from '@maxim/contracts';
import { chatParticipantDetailsSchema } from '@maxim/contracts/participant-details';
import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  MAX_API_SOURCE_TAGS,
  type MaxClientService,
  type MaxChatMemberAccess,
  type MaxChatMemberRole,
  type MaxChatRosterMember,
  type MaxChatRosterUnavailableReason,
} from '../max/max-client.service';
import { SanctionAction, type Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildChatParticipantsPageCacheKey,
  isMaxApiThrottleError,
  isMaxApiTimeoutError,
} from './admin-legacy-utils';
import type { AdminParticipantsRuntimeContext } from './admin-participants-runtime-context';
import { scanParticipantActivityPage } from './participant-activity-page';
import {
  ADMIN_ACTION_HEALTH_LANE,
  ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
  CHAT_PARTICIPANTS_SEARCH_MAX_API_WAIT_MS,
  CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE,
  DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE,
  EVENTS_FEED_PAGE_CACHE_TTL_MS,
  ONE_HOUR_MS,
  type ChatParticipantsSearchCursor,
  type TimedPromiseCacheEntry,
} from './admin.service.support';

const UNAVAILABLE_PARTICIPANT_CLEANUP_PAGE_LIMIT = 100;
const UNAVAILABLE_PARTICIPANT_CLEANUP_PAGE_SAFETY_CAP = 500;
const CHAT_PARTICIPANTS_TRANSIENT_FAILURE_CACHE_TTL_MS = 5_000;

class ChatParticipantsTemporarilyUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      code: 'MAX_CHAT_PARTICIPANTS_TEMPORARILY_UNAVAILABLE',
      message: 'MAX временно не отвечает. Повторите загрузку участников через несколько секунд.',
      retryable: true,
      retryAfterMs: CHAT_PARTICIPANTS_TRANSIENT_FAILURE_CACHE_TTL_MS,
    });
    this.name = 'ChatParticipantsTemporarilyUnavailableException';
  }
}

export function matchesChatParticipantRoleFilter(
  member: Pick<MaxChatRosterMember, 'isBot' | 'role'>,
  roleFilter: ChatParticipantsQuery['roleFilter'],
): boolean {
  if (roleFilter === 'all') {
    return true;
  }
  if (roleFilter === 'bots') {
    return member.isBot;
  }
  if (member.isBot) {
    return false;
  }
  if (roleFilter === 'admins') {
    return member.role === 'owner' || member.role === 'admin';
  }
  return member.role === 'member';
}

export class AdminParticipantsRuntime {
  constructor(private readonly context: AdminParticipantsRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get logger(): AdminParticipantsRuntimeContext['logger'] {
    return this.context.logger;
  }

  private get managedEntityAccessLossService():
    | AdminParticipantsRuntimeContext['managedEntityAccessLossService']
    | undefined {
    return this.context.managedEntityAccessLossService;
  }

  private readonly chatParticipantsPageCache = new Map<
    string,
    TimedPromiseCacheEntry<ChatParticipantsPage>
  >();

  private assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: Parameters<AdminParticipantsRuntimeContext['assertReadOnlyChatAdmin']>[3],
  ): Promise<void> {
    return this.context.assertReadOnlyChatAdmin(chatId, userId, entityType, options);
  }

  private buildParticipantViolationCountWhere(
    chatId: string,
    userIds: readonly string[],
    from: Date,
    to: Date,
  ): Prisma.ModerationEventWhereInput {
    return {
      chatId,
      userId: {
        in: [...userIds],
      },
      createdAt: { gte: from, lte: to },
      action: {
        in: [
          SanctionAction.WARN,
          SanctionAction.DELETE_MESSAGE,
          SanctionAction.MUTE,
          SanctionAction.KICK,
          SanctionAction.BAN,
        ],
      },
    };
  }

  private buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
    botId?: string | null,
  ): string | null {
    return this.context.buildProfileMentionHandoffUrl(
      chatId,
      entityType,
      userId,
      displayName,
      botId,
    );
  }

  private buildUserProfileUrl(username: string | null): string | null {
    return buildUserProfileUrl(username);
  }

  private ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void> {
    return this.context.ensureEntityType(chatId, userId, expectedEntityType);
  }

  private getManagedEntityHeader(
    ...args: Parameters<AdminParticipantsRuntimeContext['getManagedEntityHeader']>
  ): ReturnType<AdminParticipantsRuntimeContext['getManagedEntityHeader']> {
    return this.context.getManagedEntityHeader(...args);
  }

  private normalizeMaxProfileUrl(value: string | null): string | null {
    return normalizeMaxProfileUrl(value);
  }

  private prepareManualModerationTarget(
    ...args: Parameters<AdminParticipantsRuntimeContext['prepareManualModerationTarget']>
  ): ReturnType<AdminParticipantsRuntimeContext['prepareManualModerationTarget']> {
    return this.context.prepareManualModerationTarget(...args);
  }

  private readTrimmedString(value: unknown): string | null {
    return readTrimmedString(value);
  }

  private resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined> {
    return this.context.resolveBackgroundReadBotAssignment(chatId);
  }

  private resolveParticipantCleanupBotAssignment(chatId: string): Promise<string | undefined> {
    return this.context.resolveParticipantCleanupBotAssignment(chatId);
  }

  private resolveLogsDashboardFrom(range: ChatParticipantsQuery['range'], to: Date): Date {
    return resolveLogsDashboardFrom(range, to);
  }

  private toSafeInteger(value: unknown): number {
    return toSafeInteger(value);
  }

  async getChatParticipantsPage(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ChatParticipantsPage> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = chatParticipantsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    return this.getCachedChatParticipantsPage(chatId, user.userId, parsed.data, 'chat');
  }

  async getChatParticipantDetails(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ChatParticipantDetails> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');
    const parsed = chatParticipantsQuerySchema.pick({ range: true }).safeParse(query);
    const targetUserId = targetUserIdRaw.trim();
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    if (!targetUserId || targetUserId.length > 200) {
      throw new BadRequestException('Неверный участник.');
    }

    const now = new Date();
    const botId = await this.resolveBackgroundReadBotAssignment(chatId);
    const options = {
      botId,
      trafficClass: 'interactive' as const,
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      sourceTag: MAX_API_SOURCE_TAGS.PARTICIPANT_SEARCH,
      timeoutMs: CHAT_PARTICIPANTS_SEARCH_MAX_API_WAIT_MS,
    };
    const [accessResult, profileResult, localName, settings, immunity, violationCount] =
      await Promise.all([
        this.maxClient.getChatMemberAccess(chatId, targetUserId, options).then(
          (access) => ({ known: true, access }),
          () => ({ known: false, access: null }),
        ),
        this.maxClient
          .getChatMemberProfiles(chatId, [targetUserId], options)
          .catch(() => new Map()),
        this.prisma.chatUserDisplayName.findUnique({
          where: { chatId_userId: { chatId, userId: targetUserId } },
          select: { displayName: true },
        }),
        this.prisma.chatSettings.findUnique({
          where: { chatId },
          select: { nightModeTimezone: true },
        }),
        this.prisma.chatParticipantModerationImmunity.findUnique({
          where: { chatId_userId: { chatId, userId: targetUserId } },
        }),
        this.prisma.moderationEvent.count({
          where: this.buildParticipantViolationCountWhere(
            chatId,
            [targetUserId],
            this.resolveLogsDashboardFrom(parsed.data.range, now),
            now,
          ),
        }),
      ]);
    const access = accessResult.access;
    const profile = profileResult.get(targetUserId);
    const role = access ? (access.isOwner ? 'owner' : access.isAdmin ? 'admin' : 'member') : null;
    const username = profile?.username?.replace(/^@+/u, '').trim() || null;
    const displayName =
      profile?.displayName?.trim() || localName?.displayName || username || 'Участник';
    const protectedTarget =
      targetUserId === user.userId || this.context.isKnownRuntimeBotUserId(targetUserId);
    const canManage = !protectedTarget && role === 'member' && access?.isBot === false;
    const canSanction =
      canManage ||
      (!protectedTarget &&
        accessResult.known &&
        !access &&
        (await hasFormerParticipantHistory(this.prisma, chatId, targetUserId)));
    // FLAG: A failed MAX lookup is unknown, not evidence that the participant left the chat.
    return chatParticipantDetailsSchema.parse({
      userId: targetUserId,
      userDisplayName: displayName,
      username,
      avatarUrl: profile?.avatarUrl || null,
      profileUrl:
        this.normalizeMaxProfileUrl(profile?.profileUrl ?? null) ??
        this.buildUserProfileUrl(username),
      profileHandoffUrl: this.buildProfileMentionHandoffUrl(
        chatId,
        'chat',
        targetUserId,
        displayName,
        botId,
      ),
      role,
      isBot: access?.isBot === true,
      membershipStatus: !accessResult.known ? 'unknown' : access ? 'member' : 'left',
      canManage,
      canMute: canSanction,
      canBan: canSanction,
      violationCount,
      immunity: immunity
        ? this.buildChatParticipantImmunitySummary(
            immunity,
            now,
            this.normalizeParticipantImmunityTimezone(settings?.nightModeTimezone),
          )
        : null,
    });
  }

  async updateChatParticipantImmunity(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ChatParticipantImmunityUpdateResult> {
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user);
    const parsed = chatParticipantImmunityUpdateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    if (!parsed.data.enabled) {
      await this.prisma.chatParticipantModerationImmunity.deleteMany({
        where: {
          chatId,
          userId: targetUserId,
        },
      });

      this.invalidateChatParticipantsPageCache(chatId);
      return chatParticipantImmunityUpdateResultSchema.parse({
        immunity: null,
        message: 'Иммунитет снят.',
      });
    }

    const participantLookupBotId = await this.resolveBackgroundReadBotAssignment(chatId);
    await this.assertTargetUserCanReceiveParticipantImmunity(
      chatId,
      targetUserId,
      participantLookupBotId,
    );

    const [settings, now] = await Promise.all([
      this.prisma.chatSettings.findUnique({
        where: { chatId },
        select: { nightModeTimezone: true },
      }),
      Promise.resolve(new Date()),
    ]);
    const timeZone = this.normalizeParticipantImmunityTimezone(settings?.nightModeTimezone ?? null);
    const usageDateKey = this.formatParticipantImmunityDateKey(now, timeZone);
    const immunityMode = parsed.data.mode ?? 'limited';
    const expiresAt =
      immunityMode === 'always'
        ? null
        : new Date(now.getTime() + parsed.data.durationHours! * ONE_HOUR_MS);
    const dailyViolationLimit = immunityMode === 'always' ? null : parsed.data.dailyViolationLimit!;
    const nextUsageDateKey = immunityMode === 'always' ? null : usageDateKey;
    const immunity = await this.prisma.chatParticipantModerationImmunity.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId: targetUserId,
        },
      },
      create: {
        chatId,
        userId: targetUserId,
        expiresAt,
        dailyViolationLimit,
        dailyViolationUsage: 0,
        usageDateKey: nextUsageDateKey,
        createdByUserId: user.userId,
        updatedByUserId: user.userId,
      },
      update: {
        expiresAt,
        dailyViolationLimit,
        dailyViolationUsage: 0,
        usageDateKey: nextUsageDateKey,
        updatedByUserId: user.userId,
      },
    });

    this.invalidateChatParticipantsPageCache(chatId);
    return chatParticipantImmunityUpdateResultSchema.parse({
      immunity: this.buildChatParticipantImmunitySummary(immunity, now, timeZone),
      message: 'Иммунитет обновлён.',
    });
  }

  async cleanupUnavailableChatParticipants(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ChatUnavailableParticipantsCleanupResult> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat', {
      forceRemote: true,
    });
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = chatUnavailableParticipantsCleanupRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const dryRun = parsed.data.dryRun;
    const resolvedBotId = await this.resolveParticipantCleanupBotAssignment(chatId);
    if (!resolvedBotId) {
      throw new ForbiddenException(
        'Не найден бот MAX с подтвержденным правом удалять участников этого чата.',
      );
    }
    await this.assertBotCanCleanupUnavailableParticipants(chatId, resolvedBotId);

    const items: ChatUnavailableParticipantsCleanupItem[] = [];
    let marker: string | null = null;
    let scannedCount = 0;
    let matchedCount = 0;
    let removedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let scanLimitReached = false;

    for (
      let pageIndex = 0;
      pageIndex < UNAVAILABLE_PARTICIPANT_CLEANUP_PAGE_SAFETY_CAP;
      pageIndex += 1
    ) {
      const page = await this.maxClient.getChatMembersPage(
        chatId,
        {
          limit: UNAVAILABLE_PARTICIPANT_CLEANUP_PAGE_LIMIT,
          marker,
        },
        {
          trafficClass: 'interactive',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          sourceTag: MAX_API_SOURCE_TAGS.PARTICIPANT_CLEANUP,
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          botId: resolvedBotId,
        },
      );

      for (const member of page.items) {
        scannedCount += 1;
        if (!member.unavailableReason) {
          continue;
        }

        matchedCount += 1;
        const result = await this.cleanupUnavailableChatParticipantCandidate({
          chatId,
          member,
          actorUserId: user.userId,
          dryRun,
          botId: resolvedBotId,
        });
        items.push(result);

        if (result.status === 'removed') {
          removedCount += 1;
        } else if (result.status === 'failed') {
          failedCount += 1;
        } else if (result.status === 'skipped') {
          skippedCount += 1;
        }
      }

      if (!page.nextMarker) {
        marker = null;
        break;
      }
      marker = page.nextMarker;

      if (pageIndex === UNAVAILABLE_PARTICIPANT_CLEANUP_PAGE_SAFETY_CAP - 1) {
        scanLimitReached = true;
      }
    }

    if (!dryRun && (removedCount > 0 || skippedCount > 0 || failedCount > 0)) {
      this.invalidateChatParticipantsPageCache(chatId);
    }

    return chatUnavailableParticipantsCleanupResultSchema.parse({
      ok: true,
      dryRun,
      scannedCount,
      matchedCount,
      removedCount,
      skippedCount,
      failedCount,
      scanLimitReached,
      items,
      message: this.buildUnavailableParticipantsCleanupMessage({
        dryRun,
        matchedCount,
        removedCount,
        skippedCount,
        failedCount,
        scanLimitReached,
      }),
    });
  }

  invalidateChatParticipantsPageCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.chatParticipantsPageCache.keys()) {
      if (key.startsWith(prefix)) {
        this.chatParticipantsPageCache.delete(key);
      }
    }
  }

  private async assertBotCanCleanupUnavailableParticipants(
    chatId: string,
    botId: string,
  ): Promise<void> {
    const probeStartedAt = new Date();
    let botAccess: MaxChatMemberAccess;
    try {
      botAccess = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        trafficClass: 'critical',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        botId,
      });
    } catch (error: unknown) {
      if (this.isTerminalChatParticipantsRosterAccessError(error)) {
        await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost({
          chatId,
          botId,
          source: 'admin_participants:cleanup_self_probe',
          operation: 'lookup',
          error,
          lifecycleEventAt: probeStartedAt,
          lifecycleEventType: 'live_probe_denied',
          lifecycleSource: 'live_probe',
        });
      }
      throw error;
    }

    if (botAccess.isOwner) {
      return;
    }

    if (!botAccess.isAdmin) {
      throw new ForbiddenException(
        'Бот должен быть администратором этого чата MAX, чтобы удалять участников.',
      );
    }

    if (
      botAccess.permissions.length > 0 &&
      !botAccess.permissions.some((permission) => this.isAddRemoveMembersPermission(permission))
    ) {
      throw new ForbiddenException(
        'У бота нет права MAX add_remove_members, поэтому он не может удалять участников.',
      );
    }
  }

  private async cleanupUnavailableChatParticipantCandidate(params: {
    chatId: string;
    member: MaxChatRosterMember;
    actorUserId: string;
    dryRun: boolean;
    botId?: string;
  }): Promise<ChatUnavailableParticipantsCleanupItem> {
    const { chatId, member, actorUserId, dryRun, botId } = params;
    const reason = this.toChatUnavailableParticipantReason(member.unavailableReason);
    const userDisplayName = this.resolveCleanupParticipantDisplayName(member);

    if (!reason) {
      return {
        userId: member.userId,
        userDisplayName,
        reason: 'deleted',
        status: 'skipped',
        message: 'MAX не вернул явный признак удаленного или заблокированного аккаунта.',
      };
    }

    const base = {
      userId: member.userId,
      userDisplayName,
      reason,
    };

    if (member.userId.trim() === actorUserId.trim()) {
      return {
        ...base,
        status: 'skipped',
        message: 'Нельзя удалить свой аккаунт.',
      };
    }

    if (member.isBot) {
      return {
        ...base,
        status: 'skipped',
        message: 'Боты не удаляются этой операцией.',
      };
    }

    if (member.role !== 'member') {
      return {
        ...base,
        status: 'skipped',
        message: 'Администраторы и владельцы не удаляются этой операцией.',
      };
    }

    let targetAccess: MaxChatMemberAccess | null;
    try {
      targetAccess = await this.maxClient.getChatMemberAccess(chatId, member.userId, {
        trafficClass: 'critical',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        bypassCache: true,
        ...(botId ? { botId } : {}),
      });
    } catch (error: unknown) {
      return {
        ...base,
        status: 'failed',
        message: this.describeUnavailableParticipantCleanupError(error),
      };
    }

    if (!targetAccess) {
      return {
        ...base,
        status: 'skipped',
        message: 'Участник уже отсутствует в чате.',
      };
    }

    if (targetAccess.isOwner || targetAccess.isAdmin) {
      return {
        ...base,
        status: 'skipped',
        message: 'Свежая проверка MAX показала, что это администратор или владелец.',
      };
    }

    if (dryRun) {
      return {
        ...base,
        status: 'candidate',
        message: 'Кандидат подтвержден, удаление не запускалось.',
      };
    }

    try {
      await this.maxClient.kickMember(chatId, member.userId, {
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        sourceTag: MAX_API_SOURCE_TAGS.PARTICIPANT_CLEANUP,
        ...(botId ? { botId } : {}),
      });
      return {
        ...base,
        status: 'removed',
        message: 'Удален из чата.',
      };
    } catch (error: unknown) {
      if (this.isUnavailableParticipantAlreadyGoneError(error)) {
        return {
          ...base,
          status: 'skipped',
          message: 'Участник уже отсутствует в чате.',
        };
      }

      return {
        ...base,
        status: 'failed',
        message: this.describeUnavailableParticipantCleanupError(error),
      };
    }
  }

  private toChatUnavailableParticipantReason(
    value: MaxChatRosterUnavailableReason | null,
  ): ChatUnavailableParticipantReason | null {
    if (
      value === 'deleted' ||
      value === 'blocked' ||
      value === 'deactivated' ||
      value === 'suspended'
    ) {
      return value;
    }

    return null;
  }

  private resolveCleanupParticipantDisplayName(member: MaxChatRosterMember): string {
    const username = member.username?.replace(/^@+/u, '').trim() ?? '';
    return (
      member.displayName?.trim() ||
      (username ? `@${username}` : '') ||
      (member.isBot ? 'Бот MAX' : 'Участник MAX')
    );
  }

  private buildUnavailableParticipantsCleanupMessage(params: {
    dryRun: boolean;
    matchedCount: number;
    removedCount: number;
    skippedCount: number;
    failedCount: number;
    scanLimitReached: boolean;
  }): string {
    if (params.matchedCount === 0) {
      return params.scanLimitReached
        ? 'Безопасных кандидатов не найдено в просканированной части списка.'
        : 'Безопасных кандидатов не найдено.';
    }

    if (params.dryRun) {
      return `Найдено кандидатов: ${params.matchedCount}. Удаление не запускалось.`;
    }

    const parts = [`Удалено: ${params.removedCount}`];
    if (params.skippedCount > 0) {
      parts.push(`пропущено: ${params.skippedCount}`);
    }
    if (params.failedCount > 0) {
      parts.push(`ошибок: ${params.failedCount}`);
    }
    if (params.scanLimitReached) {
      parts.push('достигнут лимит сканирования');
    }

    return `${parts.join(', ')}.`;
  }

  private describeUnavailableParticipantCleanupError(error: unknown): string {
    const apiMessage = this.extractMaxApiErrorMessage(error);
    if (apiMessage) {
      return apiMessage;
    }

    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }

    return 'MAX отклонил удаление участника.';
  }

  private extractMaxApiErrorMessage(error: unknown): string | null {
    const responseData = (error as { response?: { data?: unknown } })?.response?.data;
    if (responseData && typeof responseData === 'object' && !Array.isArray(responseData)) {
      const message = (responseData as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }

    return null;
  }

  private isUnavailableParticipantAlreadyGoneError(error: unknown): boolean {
    const code = this.extractMaxApiErrorCode(error);
    if (code === 'user.not.found' || code === 'member.not.found') {
      return true;
    }

    const message = this.describeUnavailableParticipantCleanupError(error).toLowerCase();
    return (
      message.includes('not found') ||
      message.includes('already') ||
      message.includes('уже отсутств') ||
      message.includes('не состоит')
    );
  }

  private isAddRemoveMembersPermission(permission: string): boolean {
    const normalized = permission
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, '_');
    return (
      normalized === 'add_remove_members' ||
      normalized === 'can_add_remove_members' ||
      normalized === 'remove_members' ||
      normalized === 'can_remove_members' ||
      normalized === 'manage_members' ||
      normalized === 'can_manage_members' ||
      normalized === 'kick_members' ||
      normalized === 'can_kick_members' ||
      normalized === 'ban_members' ||
      normalized === 'can_ban_members' ||
      normalized === 'ban_users' ||
      normalized === 'can_ban_users' ||
      normalized === 'delete_members' ||
      normalized === 'can_delete_members'
    );
  }

  private async buildChatParticipantsPage(
    chatId: string,
    userId: string,
    query: ChatParticipantsQuery,
    entityType: ManagedEntityType = 'chat',
  ): Promise<ChatParticipantsPage> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const search = this.normalizeChatParticipantsSearchText(query.search ?? '');
    const resolvedBotId = (await this.resolveBackgroundReadBotAssignment(chatId)) ?? null;
    const now = new Date();
    const from = this.resolveLogsDashboardFrom(query.range, now);
    let rosterProbeStartedAt: Date | null = null;
    const captureRosterProbeStartedAt = (startedAt: Date) => {
      rosterProbeStartedAt = startedAt;
    };
    const membersPagePromise = (
      query.activityFilter && query.activityFilter !== 'all'
        ? scanParticipantActivityPage({
            chatId,
            userId,
            query,
            maxPages: CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE,
            matches: (member) =>
              this.chatParticipantMatchesSearch(member, search) &&
              matchesChatParticipantRoleFilter(member, query.roleFilter),
            load: (marker) =>
              this.loadChatParticipantsMembersPage(chatId, 100, marker, resolvedBotId, {
                search: true,
                onAttemptStarted: captureRosterProbeStartedAt,
              }),
          })
        : search || query.roleFilter !== 'all'
          ? this.searchChatParticipantsMembersPage(
              chatId,
              query,
              search,
              resolvedBotId,
              captureRosterProbeStartedAt,
            )
          : this.loadChatParticipantsMembersPage(
              chatId,
              limit,
              query.cursor ?? null,
              resolvedBotId,
              {
                onAttemptStarted: captureRosterProbeStartedAt,
              },
            )
    ).catch(async (error: unknown) => {
      if (!this.isTerminalChatParticipantsRosterAccessError(error)) {
        if (!this.isTransientChatParticipantsRosterError(error)) {
          throw error;
        }

        this.logger.warn(
          {
            chatId,
            entityType,
            search: search ? true : undefined,
            statusCode: this.extractHttpStatusCode(error),
            code: this.extractMaxApiErrorCode(error),
          },
          'Participant roster is temporarily unavailable from MAX',
        );
        throw new ChatParticipantsTemporarilyUnavailableException();
      }

      if (rosterProbeStartedAt) {
        await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost({
          chatId,
          botId: resolvedBotId,
          source: 'admin_participants:roster',
          operation: 'lookup',
          error,
          lifecycleEventAt: rosterProbeStartedAt,
          lifecycleEventType: 'live_probe_denied',
          lifecycleSource: 'live_probe',
        });
      }

      this.logger.warn(
        {
          chatId,
          entityType,
          search: search ? true : undefined,
          statusCode: this.extractHttpStatusCode(error),
          code: this.extractMaxApiErrorCode(error),
          err: error instanceof Error ? error.message : String(error),
        },
        'Returning empty participant page after MAX denied roster access',
      );

      return {
        items: [],
        nextMarker: null,
      };
    });
    const [membersPage, header, settings] = await Promise.all([
      membersPagePromise,
      this.getManagedEntityHeader(
        chatId,
        {
          userId,
          username: null,
          displayName: null,
          chatTitle: null,
        },
        entityType,
        { skipAdminCheck: true, skipEntityCheck: true },
      ),
      this.prisma.chatSettings.findUnique({
        where: { chatId },
        select: { nightModeTimezone: true },
      }),
    ]);
    const participantUserIds = Array.from(
      new Set(
        membersPage.items
          .map((member) => member.userId.trim())
          .filter((memberUserId) => memberUserId.length > 0),
      ),
    );
    const timeZone = this.normalizeParticipantImmunityTimezone(settings?.nightModeTimezone ?? null);
    const [violationCountRows, immunityRows] = await Promise.all([
      participantUserIds.length > 0
        ? this.prisma.moderationEvent.groupBy({
            by: ['userId'],
            where: this.buildParticipantViolationCountWhere(chatId, participantUserIds, from, now),
            _count: { _all: true },
          })
        : Promise.resolve([]),
      participantUserIds.length > 0
        ? this.prisma.chatParticipantModerationImmunity.findMany({
            where: {
              chatId,
              userId: { in: participantUserIds },
              OR: [{ expiresAt: { gt: now } }, { expiresAt: null }],
            },
          })
        : Promise.resolve([]),
    ]);
    const violationCountByUserId = new Map<string, number>();
    const immunityByUserId = new Map<string, ChatParticipantImmunity>();

    for (const row of violationCountRows) {
      const normalizedUserId = row.userId.trim();
      if (!normalizedUserId) {
        continue;
      }

      violationCountByUserId.set(normalizedUserId, this.toSafeInteger(row._count._all));
    }

    for (const immunity of immunityRows) {
      const normalizedUserId = immunity.userId.trim();
      if (!normalizedUserId) {
        continue;
      }

      const summary = this.buildChatParticipantImmunitySummary(immunity, now, timeZone);
      if (!summary) {
        continue;
      }

      immunityByUserId.set(normalizedUserId, summary);
    }

    return chatParticipantsPageSchema.parse({
      items: membersPage.items.map((member) => {
        const normalizedUsername = member.username?.replace(/^@+/u, '').trim() ?? '';
        const userDisplayName =
          member.displayName?.trim() ||
          normalizedUsername ||
          (member.isBot ? 'Бот MAX' : 'Участник');

        return {
          userId: member.userId,
          userDisplayName,
          username: normalizedUsername || null,
          avatarUrl: this.readTrimmedString(member.avatarUrl) ?? null,
          profileUrl:
            this.normalizeMaxProfileUrl(this.readTrimmedString(member.profileUrl) ?? null) ??
            this.buildUserProfileUrl(normalizedUsername || null),
          profileHandoffUrl: this.buildProfileMentionHandoffUrl(
            chatId,
            entityType,
            member.userId,
            userDisplayName,
            resolvedBotId,
          ),
          violationCount: violationCountByUserId.get(member.userId.trim()) ?? 0,
          immunity: immunityByUserId.get(member.userId.trim()) ?? null,
          role: this.mapChatMemberRole(member.role),
          isBot: member.isBot,
          lastMaxActivityAt: member.lastMaxActivityAt ?? null,
          activityCheckedAt: member.activityCheckedAt ?? null,
        } satisfies ChatParticipantItem;
      }),
      totalCount:
        typeof header.participantsCount === 'number' && Number.isFinite(header.participantsCount)
          ? Math.max(0, Math.trunc(header.participantsCount))
          : null,
      hasMore: Boolean(membersPage.nextMarker),
      nextCursor: membersPage.nextMarker,
    });
  }

  private loadChatParticipantsMembersPage(
    chatId: string,
    limit: number,
    marker: string | null,
    resolvedBotId: string | null,
    options: {
      search?: boolean;
      onAttemptStarted?: (startedAt: Date) => void;
    } = {},
  ): Promise<{ items: MaxChatRosterMember[]; nextMarker: string | null }> {
    options.onAttemptStarted?.(new Date());
    return this.maxClient.getChatMembersPage(
      chatId,
      {
        limit,
        marker,
      },
      {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ...(options.search
          ? {
              sourceTag: MAX_API_SOURCE_TAGS.PARTICIPANT_SEARCH,
              timeoutMs: CHAT_PARTICIPANTS_SEARCH_MAX_API_WAIT_MS,
            }
          : {}),
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      },
    );
  }

  private isTerminalChatParticipantsRosterAccessError(error: unknown): boolean {
    const code = this.extractMaxApiErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found' || code === 'account.blocked') {
      return true;
    }

    const status = this.extractHttpStatusCode(error);
    return status === 403 || status === 404;
  }

  private extractHttpStatusCode(error: unknown): number | null {
    const status = (error as { response?: { status?: unknown } })?.response?.status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return status;
    }

    const directStatus = (error as { status?: unknown })?.status;
    return typeof directStatus === 'number' && Number.isFinite(directStatus) ? directStatus : null;
  }

  private extractMaxApiErrorCode(error: unknown): string | null {
    const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof code === 'string' && code.trim().length > 0 ? code.trim().toLowerCase() : null;
  }

  private async searchChatParticipantsMembersPage(
    chatId: string,
    query: ChatParticipantsQuery,
    search: string,
    resolvedBotId: string | null,
    onAttemptStarted: (startedAt: Date) => void,
  ): Promise<{ items: MaxChatRosterMember[]; nextMarker: string | null }> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const cursor = this.decodeChatParticipantsSearchCursor(query.cursor, search, query.roleFilter);
    const items: MaxChatRosterMember[] = [];
    let marker = cursor?.marker ?? null;
    let skip = cursor?.skip ?? 0;
    let scannedRemotePages = 0;

    while (true) {
      const currentMarker = marker;
      const membersPage = await this.loadChatParticipantsMembersPage(
        chatId,
        100,
        currentMarker,
        resolvedBotId,
        { search: true, onAttemptStarted },
      );
      scannedRemotePages += 1;
      const matches = membersPage.items.filter(
        (member) =>
          this.chatParticipantMatchesSearch(member, search) &&
          matchesChatParticipantRoleFilter(member, query.roleFilter),
      );
      let matchIndex = 0;

      if (skip > 0) {
        matchIndex = Math.min(skip, matches.length);
        skip -= matchIndex;
      }

      if (skip > 0) {
        if (!membersPage.nextMarker) {
          return {
            items,
            nextMarker: null,
          };
        }

        marker = membersPage.nextMarker;
        if (scannedRemotePages >= CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE) {
          return {
            items,
            nextMarker: this.encodeChatParticipantsSearchCursor({
              marker,
              skip,
              search,
              roleFilter: query.roleFilter,
            }),
          };
        }

        continue;
      }

      for (; matchIndex < matches.length; matchIndex += 1) {
        if (items.length >= limit) {
          return {
            items,
            nextMarker: this.encodeChatParticipantsSearchCursor({
              marker: currentMarker,
              skip: matchIndex,
              search,
              roleFilter: query.roleFilter,
            }),
          };
        }

        items.push(matches[matchIndex]);
      }

      if (items.length >= limit) {
        return {
          items,
          nextMarker: membersPage.nextMarker
            ? this.encodeChatParticipantsSearchCursor({
                marker: membersPage.nextMarker,
                skip: 0,
                search,
                roleFilter: query.roleFilter,
              })
            : null,
        };
      }

      if (!membersPage.nextMarker) {
        return {
          items,
          nextMarker: null,
        };
      }

      marker = membersPage.nextMarker;
      skip = 0;

      if (scannedRemotePages >= CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE) {
        return {
          items,
          nextMarker: this.encodeChatParticipantsSearchCursor({
            marker,
            skip,
            search,
            roleFilter: query.roleFilter,
          }),
        };
      }
    }
  }

  private chatParticipantMatchesSearch(member: MaxChatRosterMember, search: string): boolean {
    if (!search) {
      return true;
    }

    const username = member.username?.replace(/^@+/u, '').trim() ?? '';
    const candidates = [
      member.displayName ?? '',
      username,
      username ? `@${username}` : '',
      member.userId,
    ];

    return candidates.some((candidate) =>
      this.normalizeChatParticipantsSearchText(candidate).includes(search),
    );
  }

  private isTransientChatParticipantsRosterError(error: unknown): boolean {
    const status = this.extractHttpStatusCode(error);
    return (
      (status !== null && status >= 500 && status <= 599) ||
      isMaxApiThrottleError(error) ||
      isMaxApiTimeoutError(error)
    );
  }

  private normalizeChatParticipantsSearchText(value: string): string {
    const normalized = value
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLocaleLowerCase('ru-RU');
    const withoutMentionPrefix = normalized.replace(/^@+/u, '');
    return withoutMentionPrefix || normalized;
  }

  private encodeChatParticipantsSearchCursor(cursor: ChatParticipantsSearchCursor): string {
    return Buffer.from(
      JSON.stringify({
        v: 1,
        marker: cursor.marker,
        skip: cursor.skip,
        search: cursor.search,
        roleFilter: cursor.roleFilter ?? 'all',
      }),
      'utf8',
    ).toString('base64url');
  }

  private decodeChatParticipantsSearchCursor(
    value: string | undefined,
    search: string,
    queryRoleFilter: ChatParticipantsQuery['roleFilter'],
  ): ChatParticipantsSearchCursor | null {
    if (!value) {
      return null;
    }

    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      const marker =
        typeof parsed.marker === 'string' && parsed.marker.trim()
          ? parsed.marker.trim()
          : parsed.marker === null
            ? null
            : null;
      const skip =
        typeof parsed.skip === 'number' && Number.isFinite(parsed.skip)
          ? Math.max(0, Math.trunc(parsed.skip))
          : 0;
      const cursorSearch =
        typeof parsed.search === 'string'
          ? this.normalizeChatParticipantsSearchText(parsed.search)
          : '';
      const cursorRoleFilter =
        parsed.roleFilter === 'admins' ||
        parsed.roleFilter === 'members' ||
        parsed.roleFilter === 'bots'
          ? parsed.roleFilter
          : 'all';

      if (parsed.v !== 1 || cursorSearch !== search || cursorRoleFilter !== queryRoleFilter) {
        throw new Error('Invalid chat participants search cursor');
      }

      return {
        marker,
        skip,
        search,
        roleFilter: queryRoleFilter,
      };
    } catch {
      throw new BadRequestException('Неверный cursor для поиска участников.');
    }
  }

  private async getCachedChatParticipantsPage(
    chatId: string,
    userId: string,
    query: ChatParticipantsQuery,
    entityType: ManagedEntityType,
  ): Promise<ChatParticipantsPage> {
    const cacheKey = buildChatParticipantsPageCacheKey(chatId, userId, entityType, query);
    const cached = this.chatParticipantsPageCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    const pending = this.buildChatParticipantsPage(chatId, userId, query, entityType).catch(
      (error: unknown) => {
        const current = this.chatParticipantsPageCache.get(cacheKey);
        if (current?.promise === pending) {
          if (error instanceof ChatParticipantsTemporarilyUnavailableException) {
            current.expiresAtMs = Date.now() + CHAT_PARTICIPANTS_TRANSIENT_FAILURE_CACHE_TTL_MS;
            const failedPromise = current.promise;
            const evictionTimer = setTimeout(() => {
              if (this.chatParticipantsPageCache.get(cacheKey)?.promise === failedPromise) {
                this.chatParticipantsPageCache.delete(cacheKey);
              }
            }, CHAT_PARTICIPANTS_TRANSIENT_FAILURE_CACHE_TTL_MS);
            evictionTimer.unref?.();
          } else {
            this.chatParticipantsPageCache.delete(cacheKey);
          }
        }
        throw error;
      },
    );

    this.chatParticipantsPageCache.set(cacheKey, {
      expiresAtMs: Date.now() + EVENTS_FEED_PAGE_CACHE_TTL_MS,
      promise: pending,
    });

    return pending;
  }

  private mapChatMemberRole(role: MaxChatMemberRole): ChatParticipantItem['role'] {
    if (role === 'owner' || role === 'admin') {
      return role;
    }

    return 'member';
  }

  private normalizeParticipantImmunityTimezone(value: string | null | undefined): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE;
    }

    try {
      Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(new Date());
      return normalized;
    } catch {
      return DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE;
    }
  }

  private formatParticipantImmunityDateKey(date: Date, timeZone: string): string {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const year = parts.find((item) => item.type === 'year')?.value;
      const month = parts.find((item) => item.type === 'month')?.value;
      const day = parts.find((item) => item.type === 'day')?.value;
      if (!year || !month || !day) {
        return date.toISOString().slice(0, 10);
      }

      return `${year}-${month}-${day}`;
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  private buildChatParticipantImmunitySummary(
    immunity: {
      expiresAt: Date | null;
      dailyViolationLimit: number | null;
      dailyViolationUsage: number;
      usageDateKey: string | null;
    },
    now: Date,
    timeZone: string,
  ): ChatParticipantImmunity | null {
    if (immunity.expiresAt === null && immunity.dailyViolationLimit === null) {
      return chatParticipantImmunitySchema.parse({
        mode: 'always',
        expiresAt: null,
        dailyViolationLimit: null,
        usedViolatingMessagesToday: 0,
        remainingViolatingMessagesToday: null,
      });
    }

    if (immunity.expiresAt === null || immunity.dailyViolationLimit === null) {
      return null;
    }

    if (!(immunity.expiresAt instanceof Date) || !Number.isFinite(immunity.expiresAt.getTime())) {
      return null;
    }

    if (immunity.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    const todayKey = this.formatParticipantImmunityDateKey(now, timeZone);
    const dailyViolationLimit = Math.max(
      1,
      Math.min(10, this.toSafeInteger(immunity.dailyViolationLimit)),
    );
    const usedViolatingMessagesToday =
      immunity.usageDateKey === todayKey ? this.toSafeInteger(immunity.dailyViolationUsage) : 0;

    return chatParticipantImmunitySchema.parse({
      mode: 'limited',
      expiresAt: immunity.expiresAt.toISOString(),
      dailyViolationLimit,
      usedViolatingMessagesToday,
      remainingViolatingMessagesToday: Math.max(
        0,
        dailyViolationLimit - usedViolatingMessagesToday,
      ),
    });
  }

  private async assertTargetUserCanReceiveParticipantImmunity(
    chatId: string,
    targetUserId: string,
    botId?: string,
  ): Promise<void> {
    const maxClientWithMemberAccess = this.maxClient as {
      getChatMemberAccess?: (
        chatId: string,
        userId: string,
        options?: {
          actionHealthLane?: string;
          botId?: string;
          trafficClass?: 'critical' | 'interactive' | 'background';
          timeoutMs?: number;
        },
      ) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return;
    }

    const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(chatId, targetUserId, {
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      ...(botId ? { botId } : {}),
    });
    if (!targetAccess) {
      throw new BadRequestException('Пользователь уже не состоит в этом чате.');
    }

    if (targetAccess.isOwner || targetAccess.isAdmin) {
      throw new BadRequestException('Иммунитет можно выдать только обычному участнику.');
    }
  }
}
