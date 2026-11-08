import { createManagedEntitiesRefreshState } from './admin-managed-entities-refresh-state';
import { readTrimmedString } from './admin-legacy-utils';
import type {
  ChatSummary,
  ManagedEntitiesListResponse,
  ManagedEntitiesRefreshState,
  ManagedEntitiesResponseDiff,
  ManagedEntityAssignedBot,
  ManagedEntityBotCapability,
  ManagedEntityHeader,
  ManagedEntityType,
} from '@maxim/contracts';
import { managedEntityBotCapabilitySchema } from '@maxim/contracts';
import type { Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  AdminManagedEntitiesRuntimeContext,
  ManagedEntitiesRefreshRunOptions,
} from './admin-managed-entities-runtime-context';
import type { AdminManagedEntitiesRefreshJob } from './admin-managed-entities-refresh.queue';
import { getManagedEntityHeaderValue } from './admin-managed-entity-header';
import {
  listManagedEntitiesValue,
  listManagedEntitiesWithRefreshStateValue,
} from './admin-managed-entities-list';
import type {
  AdminReadBypassOptions,
  AssertChatAdminOptions,
  ManagedEntitiesListOptions,
  ManagedEntitiesListResult,
  ManagedEntitiesRefreshJobOutcome,
  ManagedEntityBotAssignmentsRow,
  ManagedEntityBotProfileSnapshot,
  ManagedEntityTypeFilter,
} from './admin.service.support';

type ManagedEntityBotMeta = {
  id: string;
  label?: string;
  state?: ManagedEntityAssignedBot['lifecycleState'];
  speechPersona?: ManagedEntityAssignedBot['speechPersona'];
  characterName?: string | null;
};

type ManagedEntityBotAssignmentsQueryRow = {
  id: string;
  botId: string | null;
  primaryBotId: string | null;
  botMemberships: ManagedEntityBotAssignmentsRow['botMemberships'];
};

export class AdminManagedEntitiesRuntime {
  constructor(private readonly context: AdminManagedEntitiesRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get logger(): Logger {
    return this.context.logger;
  }

  private get maxBotRegistry(): MaxBotRegistryService | undefined {
    return this.context.maxBotRegistry;
  }

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
    options?: {
      forceRemote?: boolean;
      timeoutMs?: number;
      protectHumanAdministrator?: boolean;
    },
  ): Promise<void> {
    return this.context.assertReadOnlyChatAdmin(chatId, userId, entityType, options);
  }

  private attachManagedEntityFavoriteTypes(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    return this.context.attachManagedEntityFavoriteTypes(userId, items);
  }

  private attachManagedEntityFavoriteTypesToDiff(
    userId: string,
    diff: ManagedEntitiesResponseDiff | null | undefined,
  ): Promise<ManagedEntitiesResponseDiff | null | undefined> {
    return this.context.attachManagedEntityFavoriteTypesToDiff(userId, diff);
  }

  private collectManagedEntitiesForMassAction(
    user: AuthUser,
    entityType: ManagedEntityType,
    options?: {
      discoveryMode?: 'full' | 'cached-first';
    },
  ): Promise<ChatSummary[]> {
    return this.context.collectManagedEntitiesForMassAction(user, entityType, options);
  }

  private ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void> {
    return this.context.ensureEntityType(chatId, userId, expectedEntityType);
  }

  private isManagedEntityRuntimeBotId(botId: string | null | undefined): boolean {
    return this.context.isManagedEntityRuntimeBotId(botId);
  }

  private listManagedEntitiesDetailed(
    user: AuthUser,
    entityType?: ManagedEntityTypeFilter,
    options?: ManagedEntitiesListOptions,
  ): Promise<ManagedEntitiesListResult> {
    return this.context.listManagedEntitiesDetailed(user, entityType, options);
  }

  private resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined> {
    return this.context.resolveBackgroundReadBotAssignment(chatId);
  }

  private runManagedEntitiesBoundedRefreshJob(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options?: ManagedEntitiesRefreshRunOptions,
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    return this.context.runManagedEntitiesBoundedRefreshJob(user, entityType, options);
  }

  private runManagedEntitiesRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options?: ManagedEntitiesRefreshRunOptions,
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    return this.context.runManagedEntitiesRemoteFullRefresh(user, entityType, options);
  }

  listChats(user: AuthUser, options: ManagedEntitiesListOptions = {}): Promise<ChatSummary[]> {
    return this.listManagedEntities(user, 'chat', options);
  }

  listChatsForMassBroadcast(
    user: AuthUser,
    options: {
      discoveryMode?: 'full' | 'cached-first';
    } = {},
  ): Promise<ChatSummary[]> {
    return this.collectManagedEntitiesForMassAction(user, 'chat', {
      discoveryMode: options.discoveryMode ?? 'cached-first',
    });
  }

  listChannels(user: AuthUser, options: ManagedEntitiesListOptions = {}): Promise<ChatSummary[]> {
    return this.listManagedEntities(user, 'channel', options);
  }

  listChatsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return this.listManagedEntitiesWithRefreshStateForType(user, 'chat', options);
  }

  listChannelsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return this.listManagedEntitiesWithRefreshStateForType(user, 'channel', options);
  }

  private listManagedEntitiesWithRefreshStateForType(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return listManagedEntitiesWithRefreshStateValue({
      user,
      entityType,
      options,
      listDetailed: (listUser, listEntityType, listOptions) =>
        this.listManagedEntitiesDetailed(listUser, listEntityType, listOptions),
      attachFavoriteTypes: (userId, items) => this.attachManagedEntityFavoriteTypes(userId, items),
      attachFavoriteTypesToDiff: (userId, diff) =>
        this.attachManagedEntityFavoriteTypesToDiff(userId, diff),
      createIdleRefreshState: () => createManagedEntitiesRefreshState(null, false),
    });
  }

  listManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return listManagedEntitiesValue({
      user,
      entityType,
      options,
      listDetailed: (listUser, listEntityType, listOptions) =>
        this.listManagedEntitiesDetailed(listUser, listEntityType, listOptions),
      attachFavoriteTypes: (userId, items) => this.attachManagedEntityFavoriteTypes(userId, items),
    });
  }

  listManagedEntitiesDetailedForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResult> {
    return this.listManagedEntitiesDetailed(user, entityType, options);
  }

  createIdleManagedEntitiesRefreshStateForManagedEntities(): ManagedEntitiesRefreshState {
    return createManagedEntitiesRefreshState(null, false);
  }

  getChatHeader(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeader(chatId, user, 'chat', options);
  }

  getChannelHeader(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return this.getManagedEntityHeader(chatId, user, 'channel', options);
  }

  processManagedEntitiesRefreshJob(
    job: AdminManagedEntitiesRefreshJob,
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    const user: AuthUser = {
      userId: job.userId,
      username: null,
      displayName: null,
      chatTitle: null,
    };

    return this.runManagedEntitiesBoundedRefreshForManagedEntities(user, job.entityType, {
      bypassRemoteCache: job.bypassRemoteCache,
      resetRefreshCursor: job.resetRefreshCursor,
    });
  }

  runManagedEntitiesBoundedRefreshForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    return this.runManagedEntitiesBoundedRefreshJob(user, entityType, {
      bypassRemoteCache: options.bypassRemoteCache,
      resetRefreshCursor: options.resetRefreshCursor,
    });
  }

  runManagedEntitiesRemoteFullRefreshForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    return this.runManagedEntitiesRemoteFullRefresh(user, entityType, {
      bypassRemoteCache: options.bypassRemoteCache,
      resetRefreshCursor: options.resetRefreshCursor,
    });
  }

  async assertManagedEntityAdminAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void> {
    await this.assertChatAdmin(chatId, userId, entityType, {
      trafficClass: 'interactive',
      allowPersistedFallback: false,
      bypassPositiveCache: true,
      syncPersistedAccess: false,
      protectHumanAdministrator: true,
    });
    await this.ensureEntityType(chatId, userId, entityType);
  }

  async assertManagedEntityReadAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions = {},
  ): Promise<void> {
    if (!options.skipAdminCheck) {
      await this.assertReadOnlyChatAdmin(chatId, userId, entityType, {
        forceRemote: true,
        timeoutMs: options.timeoutMs,
        ...(options.protectHumanAdministrator === true ? { protectHumanAdministrator: true } : {}),
      });
    }
    if (!options.skipEntityCheck) {
      await this.ensureEntityType(chatId, userId, entityType);
    }
  }

  resolveManagedEntityHeaderReadBotId(chatId: string): Promise<string | undefined> {
    return this.resolveBackgroundReadBotAssignment(chatId);
  }

  attachManagedEntityHeaderBotAssignmentsForManagedEntities(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader> {
    return this.attachManagedEntityHeaderBotAssignments(header);
  }

  async attachManagedEntityBotAssignments(chats: ChatSummary[]): Promise<ChatSummary[]> {
    if (chats.length === 0) {
      return chats;
    }

    const assignmentsByChatId = await this.readManagedEntityBotAssignments(
      chats.map((chat) => chat.id),
    );

    return chats.map((chat) => this.applyManagedEntityBotAssignments(chat, assignmentsByChatId));
  }

  async attachManagedEntityHeaderBotAssignments(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader> {
    const assignmentsByChatId = await this.readManagedEntityBotAssignments([header.id]);
    const enrichedHeader = this.applyManagedEntityBotAssignments(header, assignmentsByChatId);
    return this.attachManagedEntityBotProfiles(enrichedHeader);
  }

  private async readManagedEntityBotAssignments(
    chatIds: readonly string[],
  ): Promise<Map<string, ManagedEntityBotAssignmentsRow>> {
    if (typeof this.prisma.chat.findMany !== 'function') {
      return new Map();
    }

    const normalizedChatIds = Array.from(
      new Set(chatIds.map((chatId) => chatId.trim()).filter((chatId) => chatId.length > 0)),
    );
    if (normalizedChatIds.length === 0) {
      return new Map();
    }

    const rows = (await this.prisma.chat.findMany({
      where: {
        id: {
          in: normalizedChatIds,
        },
      },
      select: {
        id: true,
        botId: true,
        primaryBotId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
            capabilities: true,
            permissionsSnapshot: true,
          },
        },
      },
    })) as ManagedEntityBotAssignmentsQueryRow[];

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          botId: row.botId,
          primaryBotId: row.primaryBotId,
          botMemberships: row.botMemberships.map((membership) => ({
            botId: membership.botId,
            role: membership.role,
            status: membership.status,
            capabilities: membership.capabilities,
            permissionsSnapshot: membership.permissionsSnapshot,
          })),
        } satisfies ManagedEntityBotAssignmentsRow,
      ]),
    );
  }

  private applyManagedEntityBotAssignments<T extends ChatSummary | ManagedEntityHeader>(
    entity: T,
    assignmentsByChatId: Map<string, ManagedEntityBotAssignmentsRow>,
  ): T {
    const persisted = assignmentsByChatId.get(entity.id) ?? null;
    const primaryBotId =
      readTrimmedString(persisted?.primaryBotId) ?? readTrimmedString(persisted?.botId) ?? null;
    const botMetaById = new Map<string, ManagedEntityBotMeta>(
      (
        (this.maxBotRegistry?.getAllBots?.() as readonly ManagedEntityBotMeta[] | undefined) ?? []
      ).map((bot) => [bot.id, bot] as const),
    );
    const existingBotProfilesById = new Map(
      (Array.isArray(entity.assignedBots) ? entity.assignedBots : [])
        .map((bot) => {
          const normalizedBotId = readTrimmedString(bot.botId);
          if (!normalizedBotId) {
            return null;
          }

          return [
            normalizedBotId,
            {
              avatarUrl: readTrimmedString(bot.avatarUrl) ?? null,
            } satisfies ManagedEntityBotProfileSnapshot,
          ] as const;
        })
        .filter(
          (entry): entry is readonly [string, ManagedEntityBotProfileSnapshot] => entry !== null,
        ),
    );
    const seenBotIds = new Set<string>();
    const assignedBots: ManagedEntityAssignedBot[] = [];

    for (const membership of persisted?.botMemberships ?? []) {
      const normalizedBotId = readTrimmedString(membership.botId);
      if (!normalizedBotId || seenBotIds.has(normalizedBotId)) {
        continue;
      }

      seenBotIds.add(normalizedBotId);
      const botMeta = botMetaById.get(normalizedBotId);
      const existingProfile = existingBotProfilesById.get(normalizedBotId);
      assignedBots.push({
        botId: normalizedBotId,
        label: botMeta?.label ?? normalizedBotId,
        role: membership.role === 'PRIMARY' ? 'primary' : 'standby',
        membershipStatus: membership.status === 'REMOVED' ? 'removed' : 'active',
        lifecycleState: botMeta?.state ?? 'disabled',
        speechPersona: botMeta?.speechPersona ?? 'male',
        characterName: botMeta?.characterName ?? null,
        avatarUrl: existingProfile?.avatarUrl ?? null,
        capabilities: this.normalizeManagedEntityBotCapabilities(membership.capabilities),
        permissionsSummary: this.readManagedEntityPermissionsSummary(
          membership.permissionsSnapshot,
        ),
      });
    }

    if (primaryBotId && !seenBotIds.has(primaryBotId)) {
      const botMeta = botMetaById.get(primaryBotId);
      const existingProfile = existingBotProfilesById.get(primaryBotId);
      assignedBots.unshift({
        botId: primaryBotId,
        label: botMeta?.label ?? primaryBotId,
        role: 'primary',
        membershipStatus: 'active',
        lifecycleState: botMeta?.state ?? 'disabled',
        speechPersona: botMeta?.speechPersona ?? 'male',
        characterName: botMeta?.characterName ?? null,
        avatarUrl: existingProfile?.avatarUrl ?? null,
        capabilities: [],
        permissionsSummary: null,
      });
    }

    assignedBots.sort((left, right) => {
      if (left.role !== right.role) {
        return left.role === 'primary' ? -1 : 1;
      }
      return left.label.localeCompare(right.label, 'ru');
    });

    const sharedMode = this.resolveManagedEntitySharedMode(assignedBots);

    return {
      ...entity,
      primaryBotId,
      assignedBots,
      sharedMode,
    };
  }

  private normalizeManagedEntityBotCapabilities(value: unknown): ManagedEntityBotCapability[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .flatMap((item) => {
            const parsed = managedEntityBotCapabilitySchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          }),
      ),
    );
  }

  private async attachManagedEntityBotProfiles(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader> {
    if (
      !Array.isArray(header.assignedBots) ||
      header.assignedBots.length === 0 ||
      typeof this.maxClient.getOwnProfile !== 'function'
    ) {
      return header;
    }

    const cachedProfilesByBotId = new Map<string, ManagedEntityBotProfileSnapshot>();
    const missingBotIds: string[] = [];

    for (const bot of header.assignedBots) {
      const normalizedBotId = readTrimmedString(bot.botId);
      if (!normalizedBotId) {
        continue;
      }
      if (!this.isManagedEntityRuntimeBotId(normalizedBotId)) {
        continue;
      }

      const existingAvatarUrl = readTrimmedString(bot.avatarUrl) ?? null;
      if (existingAvatarUrl) {
        cachedProfilesByBotId.set(normalizedBotId, {
          avatarUrl: existingAvatarUrl,
        });
        continue;
      }

      const cachedProfile =
        await this.chatContextCache.getManagedEntityBotProfile?.(normalizedBotId);
      if (cachedProfile) {
        cachedProfilesByBotId.set(normalizedBotId, {
          avatarUrl: readTrimmedString(cachedProfile.avatarUrl) ?? null,
        });
        continue;
      }

      // FLAG: Historical catalog bindings are visible without a configured MAX token.
      // They may reuse saved photos, but must never fall back to another bot's /me.
      if (!this.maxBotRegistry?.getBotById?.(normalizedBotId)) {
        continue;
      }

      missingBotIds.push(normalizedBotId);
    }

    if (missingBotIds.length > 0 && typeof this.maxClient.getOwnProfile === 'function') {
      const results = await Promise.allSettled(
        missingBotIds.map(async (botId) => {
          const profile = await this.maxClient.getOwnProfile({
            botId,
            trafficClass: 'interactive',
            timeoutMs: 2_500,
            sourceTag: MAX_API_SOURCE_TAGS.SETTINGS_BOT_PROFILE,
          });
          const snapshot = {
            avatarUrl: readTrimmedString(profile.avatarUrl) ?? null,
          } satisfies ManagedEntityBotProfileSnapshot;
          cachedProfilesByBotId.set(botId, snapshot);
          await this.chatContextCache.setManagedEntityBotProfile?.(botId, snapshot);
        }),
      );

      const rejectedProfiles = results
        .map((result, index) =>
          result.status === 'rejected'
            ? {
                botId: missingBotIds[index] ?? 'unknown',
                err: result.reason instanceof Error ? result.reason.message : String(result.reason),
              }
            : null,
        )
        .filter((entry): entry is { botId: string; err: string } => entry !== null);
      if (rejectedProfiles.length > 0) {
        this.logger.warn(
          {
            chatId: header.id,
            botIds: rejectedProfiles.map((entry) => entry.botId),
            errors: rejectedProfiles.map((entry) => entry.err),
          },
          'Failed to resolve some managed entity bot avatars from MAX',
        );
      }
    }

    return {
      ...header,
      assignedBots: header.assignedBots.map((bot) => {
        const normalizedBotId = readTrimmedString(bot.botId);
        if (!normalizedBotId) {
          return bot;
        }

        const cachedProfile = cachedProfilesByBotId.get(normalizedBotId);
        return {
          ...bot,
          avatarUrl: cachedProfile?.avatarUrl ?? readTrimmedString(bot.avatarUrl) ?? null,
        };
      }),
    };
  }

  private readManagedEntityPermissionsSummary(
    value: unknown,
  ): ManagedEntityAssignedBot['permissionsSummary'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const checkedAt =
      typeof row.checkedAt === 'string' && row.checkedAt.trim().length > 0 ? row.checkedAt : null;
    const permissions = Array.isArray(row.permissions)
      ? Array.from(
          new Set(
            row.permissions
              .map((item) => (typeof item === 'string' ? item.trim() : ''))
              .filter((item): item is string => item.length > 0),
          ),
        )
      : [];

    return {
      checkedAt,
      isAdmin: row.isAdmin === true,
      isOwner: row.isOwner === true,
      permissions,
    };
  }

  private resolveManagedEntitySharedMode(
    assignedBots: readonly ManagedEntityAssignedBot[],
  ): ChatSummary['sharedMode'] {
    const activeBots = assignedBots.filter((bot) => bot.membershipStatus === 'active');
    if (activeBots.length <= 1) {
      return 'owned';
    }

    const primaryBot = activeBots.find((bot) => bot.role === 'primary') ?? activeBots[0];
    if (activeBots.some((bot) => bot.role === 'standby' && bot.capabilities.length > 0)) {
      return 'shared-assist';
    }

    if (primaryBot?.lifecycleState === 'draining') {
      return 'shared-failover';
    }

    return 'shared-standby';
  }

  private getManagedEntityHeader(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return getManagedEntityHeaderValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      entityType,
      options,
      assertReadAccess: (readOptions) =>
        this.assertManagedEntityReadAccess(chatId, user.userId, entityType, readOptions),
      resolveReadBotId: () => this.resolveManagedEntityHeaderReadBotId(chatId),
      attachBotAssignments: (header) =>
        this.attachManagedEntityHeaderBotAssignmentsForManagedEntities(header),
    });
  }
}
