import { readTrimmedString } from './admin-legacy-utils';
import type { ManagedEntityType } from '@maxim/contracts';
import type { Logger } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { MaxChatMemberAccess } from '../max/max-client.service';
import { hasNewerCompleteAdminRoster } from '../max/chat-admin-roster-state';
import type { PrismaService } from '../prisma/prisma.service';
import { isPrismaKnownError, toPrismaEntityType } from './admin-legacy-utils';
import type { AdminManagedEntityAccessRuntimeContext } from './admin-managed-entity-access-runtime-context';
import {
  MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS,
  type AdminAccessResolution,
  type ManagedEntityAccessStateValue,
} from './admin.service.support';

export type PrunePersistedChatAccessOptions = {
  eventAt?: Date;
  state?: Exclude<ManagedEntityAccessStateValue, 'GRANTED'>;
  cacheAlreadyPublished?: boolean;
};

export class AdminManagedEntityAccessRuntime {
  private readonly pendingPersistedChatAccessPrunes = new Set<string>();
  private persistedChatAccessPruneChain: Promise<void> = Promise.resolve();

  constructor(private readonly context: AdminManagedEntityAccessRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private get logger(): Logger {
    return this.context.logger;
  }

  private forgetManagedEntitiesLastSuccessChat(userId: string, chatId: string): void {
    this.context.forgetManagedEntitiesLastSuccessChat(userId, chatId);
  }

  private invalidateManagedEntitiesAllowlistCache(userId: string): void {
    this.context.invalidateManagedEntitiesAllowlistCache(userId);
  }

  async markManagedEntityAccessEdgesDeniedForUser(params: {
    chatId: string;
    userId: string;
    state: Exclude<ManagedEntityAccessStateValue, 'GRANTED'>;
    deniedReason: string;
    source: string;
  }): Promise<void> {
    const client = this.context.accessEdges;
    if (!client?.updateMany) {
      return;
    }

    const chatId = readTrimmedString(params.chatId);
    const userId = readTrimmedString(params.userId);
    if (!chatId || !userId) {
      return;
    }

    try {
      await client.updateMany({
        where: {
          chatId,
          userId,
          // FLAG: MAX moderation verdicts never mutate the independent Publisher access edge.
          botId: { in: [...this.context.managedEntitiesRuntimeBotIds] },
        },
        data: {
          state: params.state,
          userRole: params.state === 'USER_DENIED' ? 'MEMBER' : 'UNKNOWN',
          botRole: params.state === 'BOT_DENIED' ? 'MEMBER' : 'UNKNOWN',
          checkedAt: new Date(),
          expiresAt: null,
          deniedReason: params.deniedReason,
          source: params.source,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          state: params.state,
          source: params.source,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to mark managed entity access edges denied',
      );
    }
  }

  private normalizeManagedEntityAccessBotId(botId: string | null | undefined): string | null {
    return this.context.normalizeManagedEntityAccessBotId(botId);
  }

  buildAdminAccessUserIdVariants(value: string | null | undefined): string[] {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!normalized) {
      return [];
    }

    return Array.from(
      new Set([
        normalized,
        normalized.startsWith('id') && normalized.length > 2
          ? normalized.slice(2)
          : `id${normalized}`,
      ]),
    );
  }

  readAdminAccessByUserIdVariants(
    accessByUserId: ReadonlyMap<string, MaxChatMemberAccess>,
    userId: string | null | undefined,
  ): MaxChatMemberAccess | null {
    const variants = new Set(this.buildAdminAccessUserIdVariants(userId));
    if (variants.size === 0) {
      return null;
    }

    for (const [candidateUserId, access] of accessByUserId) {
      const normalizedCandidateUserId = readTrimmedString(candidateUserId)?.toLowerCase();
      if (normalizedCandidateUserId && variants.has(normalizedCandidateUserId)) {
        return access;
      }
    }
    return null;
  }

  async lockRemoteAdminAccessProbe(
    tx: Prisma.TransactionClient,
    chatId: string,
    userId: string,
    probeStartedAt: Date,
  ): Promise<boolean> {
    const userIdVariants = this.buildAdminAccessUserIdVariants(userId);
    if (userIdVariants.length === 0) {
      return false;
    }

    // FLAG: Lock first, then read membership activity in a new READ COMMITTED statement. Folding the
    // check into SELECT FOR UPDATE can retain the snapshot taken before a concurrent lock wait.
    const lockedChats = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT chat."id"
      FROM "chats" AS chat
      WHERE chat."id" = ${chatId}
      FOR UPDATE OF chat
    `;
    if (lockedChats.length !== 1) {
      return false;
    }

    const supersedingActivity = await tx.chatMembershipActivityEvent.findFirst({
      where: {
        chatId,
        userId: { in: userIdVariants },
        eventType: { in: ['user_added', 'user_removed'] },
        eventAt: { gte: probeStartedAt },
      },
      select: { id: true },
    });
    return supersedingActivity === null;
  }

  async isRemoteAdminAccessProbeCurrent(
    chatId: string,
    userId: string,
    probeStartedAt: Date,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.lockRemoteAdminAccessProbe(tx, chatId, userId, probeStartedAt),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          probeStartedAt: probeStartedAt.toISOString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to validate remote admin access probe epoch',
      );
      return false;
    }
  }

  async lockRemoteAdminGrant(
    tx: Prisma.TransactionClient,
    chatId: string,
    userId: string,
    probeStartedAt: Date,
  ): Promise<boolean> {
    // FLAG: A delayed discovery grant cannot restore an actor excluded by a newer full roster.
    return (
      (await this.lockRemoteAdminAccessProbe(tx, chatId, userId, probeStartedAt)) &&
      !(await hasNewerCompleteAdminRoster(tx, chatId, probeStartedAt))
    );
  }

  async persistRemoteManagedEntityAccessEdge(params: {
    chatId: string;
    userId: string;
    botId: string | null;
    entityType?: ManagedEntityType;
    resolution: Extract<AdminAccessResolution, { status: 'granted' | 'denied' }>;
    probeStartedAt: Date;
  }): Promise<boolean> {
    const chatId = readTrimmedString(params.chatId);
    const userId = readTrimmedString(params.userId);
    if (!chatId || !userId || !Number.isFinite(params.probeStartedAt.getTime())) {
      return false;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (params.entityType) {
          await tx.chat.upsert({
            where: { id: chatId },
            create: {
              id: chatId,
              title: params.entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`,
              entityType: toPrismaEntityType(params.entityType),
            },
            update: {},
          });
        }

        if (!(await this.lockRemoteAdminAccessProbe(tx, chatId, userId, params.probeStartedAt))) {
          return false;
        }
        if (
          params.resolution.status === 'granted' &&
          (await hasNewerCompleteAdminRoster(tx, chatId, params.probeStartedAt))
        )
          return false;
        const protectHumanAdministrator =
          params.resolution.status === 'granted' &&
          params.resolution.humanAdministratorConfirmed === true;
        if (!params.entityType) {
          return !protectHumanAdministrator;
        }

        const edgeClient = (
          tx as Prisma.TransactionClient & {
            managedEntityAccessEdge?: {
              findUnique?: (args: unknown) => Promise<{ checkedAt: Date } | null>;
              upsert?: (args: unknown) => Promise<unknown>;
            };
          }
        ).managedEntityAccessEdge;
        if (typeof edgeClient?.upsert !== 'function') {
          return !protectHumanAdministrator;
        }
        const botId = this.normalizeManagedEntityAccessBotId(params.botId);
        if (!botId) {
          return false;
        }
        if (protectHumanAdministrator) {
          if (!this.context.managedEntitiesRuntimeBotIds.has(botId)) return false;
          const newerActorEvidence = await tx.managedEntityAccessEdge.findFirst({
            where: {
              chatId,
              userId: { in: this.buildAdminAccessUserIdVariants(userId) },
              botId: { in: [...this.context.managedEntitiesRuntimeBotIds] },
              checkedAt: { gt: params.probeStartedAt },
            },
            select: { userId: true },
          });
          if (newerActorEvidence) return false;
        }
        const existing =
          typeof edgeClient.findUnique === 'function'
            ? await edgeClient.findUnique({
                where: {
                  chatId_userId_botId: {
                    chatId,
                    userId,
                    botId,
                  },
                },
                select: { checkedAt: true },
              })
            : null;
        if (existing?.checkedAt && existing.checkedAt > params.probeStartedAt) {
          return false;
        }

        const granted = params.resolution.status === 'granted';
        const deniedResolution = params.resolution.status === 'denied' ? params.resolution : null;
        const state: ManagedEntityAccessStateValue = granted
          ? 'GRANTED'
          : deniedResolution?.reason === 'user_not_admin'
            ? 'USER_DENIED'
            : 'BOT_DENIED';
        const expiresAt = granted
          ? new Date(params.probeStartedAt.getTime() + MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS)
          : null;
        const data = {
          entityType: toPrismaEntityType(params.entityType),
          state,
          userRole: granted
            ? (params.resolution.userRole ?? 'ADMIN')
            : deniedResolution?.reason === 'user_not_admin'
              ? (deniedResolution.userRole ?? 'MEMBER')
              : 'UNKNOWN',
          botRole: granted
            ? (params.resolution.botRole ?? 'ADMIN')
            : deniedResolution?.reason === 'bot_not_admin'
              ? (deniedResolution.botRole ?? 'MEMBER')
              : 'ADMIN',
          checkedAt: params.probeStartedAt,
          expiresAt,
          deniedReason: deniedResolution?.reason ?? null,
          source: 'remote_admin_access',
        };
        await edgeClient.upsert({
          where: {
            chatId_userId_botId: {
              chatId,
              userId,
              botId,
            },
          },
          create: {
            chatId,
            userId,
            botId,
            ...data,
          },
          update: data,
        });
        if (protectHumanAdministrator) {
          // FLAG: Settings return only after the exact human grant protects the local DELETE
          // reader. Keep the allowlist and edge in this fenced transaction; never activate a bot.
          await tx.chatAdminAllowlist.upsert({
            where: { chatId_userId: { chatId, userId } },
            create: { chatId, userId },
            update: {},
          });
        }
        return true;
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          botId: params.botId,
          status: params.resolution.status,
          probeStartedAt: params.probeStartedAt.toISOString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist fenced remote managed entity access edge',
      );
      return false;
    }
  }

  async prunePersistedChatAccess(
    chatId: string,
    userId: string,
    options: PrunePersistedChatAccessOptions = {},
  ): Promise<boolean> {
    const state = options.state ?? 'USER_DENIED';
    const eventAt = options.eventAt ?? new Date();
    const userIdVariants = this.buildAdminAccessUserIdVariants(userId);
    if (userIdVariants.length === 0) {
      return false;
    }

    const pruned = options.eventAt
      ? await this.prisma.$transaction(async (tx) => {
          const lockedChats = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT chat."id"
            FROM "chats" AS chat
            WHERE chat."id" = ${chatId}
            FOR UPDATE OF chat
          `;
          if (lockedChats.length !== 1) {
            return false;
          }

          const edgeClient = (
            tx as Prisma.TransactionClient & {
              managedEntityAccessEdge?: {
                updateMany?: (args: unknown) => Promise<unknown>;
                findFirst?: (args: unknown) => Promise<{ userId: string } | null>;
              };
              managedEntityAdminMember?: {
                deleteMany?: (args: unknown) => Promise<unknown>;
                findFirst?: (args: unknown) => Promise<{ userId: string } | null>;
              };
            }
          ).managedEntityAccessEdge;
          const adminMemberClient = (
            tx as Prisma.TransactionClient & {
              managedEntityAdminMember?: {
                deleteMany?: (args: unknown) => Promise<unknown>;
                findFirst?: (args: unknown) => Promise<{ userId: string } | null>;
              };
            }
          ).managedEntityAdminMember;
          await edgeClient?.updateMany?.({
            where: {
              chatId,
              userId: { in: userIdVariants },
              // FLAG: A moderation access probe cannot revoke Publisher-owned access.
              botId: { in: [...this.context.managedEntitiesRuntimeBotIds] },
              checkedAt: { lte: eventAt },
            },
            data: {
              state,
              userRole: state === 'USER_DENIED' ? 'MEMBER' : 'UNKNOWN',
              botRole: state === 'BOT_DENIED' ? 'MEMBER' : 'UNKNOWN',
              checkedAt: eventAt,
              expiresAt: null,
              deniedReason: 'persisted_access_pruned',
              source: 'prune_persisted_chat_access',
            },
          });
          if (state === 'USER_DENIED') {
            await adminMemberClient?.deleteMany?.({
              where: {
                chatId,
                userId: { in: userIdVariants },
                checkedAt: { lte: eventAt },
              },
            });
          }

          const [newerGrant, newerAdmin] = await Promise.all([
            edgeClient?.findFirst?.({
              where: {
                chatId,
                userId: { in: userIdVariants },
                state: 'GRANTED',
                botId: { in: [...this.context.managedEntitiesRuntimeBotIds] },
                checkedAt: { gt: eventAt },
              },
              select: { userId: true },
            }) ?? Promise.resolve(null),
            adminMemberClient?.findFirst?.({
              where: {
                chatId,
                userId: { in: userIdVariants },
                checkedAt: { gt: eventAt },
              },
              select: { userId: true },
            }) ?? Promise.resolve(null),
          ]);
          if (newerGrant || newerAdmin) {
            return false;
          }

          await tx.chatAdminAllowlist.deleteMany({
            where: {
              chatId,
              userId: { in: userIdVariants },
            },
          });
          return true;
        })
      : await (async () => {
          await this.markManagedEntityAccessEdgesDeniedForUser({
            chatId,
            userId,
            state,
            deniedReason: 'persisted_access_pruned',
            source: 'prune_persisted_chat_access',
          });
          await this.prisma.chatAdminAllowlist.deleteMany({
            where: {
              chatId,
              userId,
            },
          });
          return true;
        })();
    if (!pruned) {
      return false;
    }

    for (const variant of userIdVariants) {
      this.forgetManagedEntitiesLastSuccessChat(variant, chatId);
      this.invalidateManagedEntitiesAllowlistCache(variant);
    }
    if (options.cacheAlreadyPublished === true) {
      return true;
    }

    try {
      return await this.chatContextCache.applyAdminAccessEpochMutation({
        chatId,
        userId,
        state: state === 'USER_DENIED' ? 'user_denied' : 'bot_denied',
        eventAt,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          state,
          eventAt: eventAt.toISOString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to publish persisted access prune epoch',
      );
      return false;
    }
  }

  async prunePersistedChatAccessBestEffort(
    chatId: string,
    userId: string,
    source: string,
    options: PrunePersistedChatAccessOptions = {},
  ): Promise<boolean> {
    try {
      return await this.prunePersistedChatAccess(chatId, userId, options);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          source,
          code:
            error instanceof Prisma.PrismaClientKnownRequestError
              ? error.code
              : ((error as { code?: string } | null)?.code ?? null),
          err: error instanceof Error ? error.message : String(error),
        },
        isPrismaKnownError(error, 'P2024')
          ? 'Skipped persisted chat access prune because the Prisma pool is saturated'
          : 'Failed to prune persisted chat access',
      );
      return false;
    }
  }

  schedulePersistedChatAccessPrune(
    chatId: string,
    userId: string,
    source: 'bootstrap_recent_bot_added' | 'remote_admin_access',
  ): void {
    const normalizedChatId = readTrimmedString(chatId);
    const normalizedUserId = readTrimmedString(userId);
    if (!normalizedChatId || !normalizedUserId) {
      return;
    }

    const key = `${normalizedChatId}:${normalizedUserId}`;
    if (this.pendingPersistedChatAccessPrunes.has(key)) {
      return;
    }

    this.pendingPersistedChatAccessPrunes.add(key);
    this.persistedChatAccessPruneChain = this.persistedChatAccessPruneChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.prunePersistedChatAccess(normalizedChatId, normalizedUserId);
        } catch (error) {
          this.logger.warn(
            {
              chatId: normalizedChatId,
              userId: normalizedUserId,
              source,
              code:
                error instanceof Prisma.PrismaClientKnownRequestError
                  ? error.code
                  : ((error as { code?: string } | null)?.code ?? null),
              err: error,
            },
            isPrismaKnownError(error, 'P2024')
              ? 'Skipped persisted chat access prune because the Prisma pool is saturated'
              : 'Failed to prune persisted chat access',
          );
        } finally {
          this.pendingPersistedChatAccessPrunes.delete(key);
        }
      });
  }
}
