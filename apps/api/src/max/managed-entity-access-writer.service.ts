import { observedManagedEntityTitle } from '../common/managed-entity-title';
import { Injectable } from '@nestjs/common';
import type { ChatSummary, ManagedEntityType } from '@maxim/contracts';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import {
  ChatContextCacheService,
  type ManagedEntityPublishedSnapshotUpsert,
} from '../chat-context/chat-context-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from './max-bot-link.service';
import type { MaxChatMemberAccess } from './max-client.service';
import { hasNewerCompleteAdminRoster } from './chat-admin-roster-state';
import {
  isExplicitManagedEntityActivationCurrent,
  hasMajorActivationCapabilities,
  hasExplicitHumanAdministrator,
  newerManagedEntityActorConflictWhere,
  type ManagedEntityExplicitActivation,
} from './managed-entity-activation.util';

export const MANAGED_ENTITY_HANDSHAKE_SOURCE = 'handshake_start';

const HANDSHAKE_BOOTSTRAP_TTL_SEC = 15 * 60;
const HANDSHAKE_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
const HANDSHAKE_ACCESS_EDGE_GRANTED_TTL_MS = 3 * 24 * 60 * 60 * 1_000;

export type ManagedEntityAccessWriteContext = {
  chatId: string;
  botId: string;
  senderId: string | null;
  title: string;
  link?: string | null;
  avatarUrl?: string | null;
  entityType: ManagedEntityType;
  prismaEntityType: ChatEntityType;
  createdAt: string | null;
};

type ManagedBotChatCatalogClient = {
  managedBotChatCatalog?: Prisma.TransactionClient['managedBotChatCatalog'];
};

@Injectable()
export class ManagedEntityAccessWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly chatContextCache: ChatContextCacheService,
  ) {}

  async bootstrapChat(
    context: ManagedEntityAccessWriteContext,
    botAccess: MaxChatMemberAccess,
    probeStartedAt: Date,
  ): Promise<boolean> {
    await this.ensureChatBinding(context);
    const accessPersisted = await this.maxBotLinkService.recordBotAccessProbe({
      chatId: context.chatId,
      botId: context.botId,
      access: botAccess,
      source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
      checkedAt: probeStartedAt,
      allowMembershipRecovery: true,
    });
    if (!accessPersisted) {
      return false;
    }

    const persisted = await this.prisma.$transaction(async (tx) => {
      if (!(await this.lockCurrentProbe(tx, context, probeStartedAt))) {
        return false;
      }

      await this.upsertManagedBotChatCatalog(
        context,
        tx as ManagedBotChatCatalogClient,
        probeStartedAt,
      );
      return true;
    });
    if (persisted) {
      await this.publishRecentBootstrap(context);
    }
    return persisted;
  }

  private async ensureChatBinding(context: ManagedEntityAccessWriteContext): Promise<void> {
    await this.maxBotLinkService.bindDiscoveredChatBots({
      chatId: context.chatId,
      primaryBotId: context.botId,
      botIds: [context.botId],
      title: observedManagedEntityTitle(context.chatId, context.title),
      entityType: context.prismaEntityType,
    });
  }

  private async upsertManagedBotChatCatalog(
    context: ManagedEntityAccessWriteContext,
    client: ManagedBotChatCatalogClient,
    observedAt: Date,
  ): Promise<void> {
    const catalog = client.managedBotChatCatalog;
    if (typeof catalog?.upsert === 'function') {
      await catalog.upsert({
        where: {
          botId_chatId: {
            botId: context.botId,
            chatId: context.chatId,
          },
        },
        create: {
          botId: context.botId,
          chatId: context.chatId,
          entityType: context.prismaEntityType,
          title: context.title,
          link: context.link ?? null,
          avatarUrl: context.avatarUrl ?? null,
          status: 'ACTIVE',
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          lastSeenAt: observedAt,
        },
        update: {
          entityType: context.prismaEntityType,
          ...(observedManagedEntityTitle(context.chatId, context.title)
            ? { title: context.title }
            : {}),
          ...(context.link !== undefined ? { link: context.link } : {}),
          ...(context.avatarUrl !== undefined ? { avatarUrl: context.avatarUrl } : {}),
          status: 'ACTIVE',
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          lastSeenAt: observedAt,
        },
      });
    }
  }

  private async publishRecentBootstrap(context: ManagedEntityAccessWriteContext): Promise<void> {
    await this.chatContextCache.upsertManagedEntitiesRecentBootstrap(
      this.buildChatSummary(context),
      HANDSHAKE_BOOTSTRAP_TTL_SEC,
      context.senderId,
    );
  }

  async persistGrantedAccess(
    context: ManagedEntityAccessWriteContext & { senderId: string },
    botAccess: MaxChatMemberAccess,
    userAccess: MaxChatMemberAccess,
    probeStartedAt: Date,
    options: {
      explicitActivation?: ManagedEntityExplicitActivation;
      channelReadVerified?: boolean;
    } = {},
  ): Promise<boolean | null> {
    const activation = options.explicitActivation;
    if (activation) {
      // FLAG: Activation belongs to this exact bot and actor, with fresh explicit rights.
      // A channel metadata response supplies read evidence only for this same bot.
      if (
        !isExplicitManagedEntityActivationCurrent(activation, context.chatId, context.botId) ||
        activation.actorUserId !== context.senderId ||
        !hasExplicitHumanAdministrator(userAccess, context.senderId) ||
        !hasMajorActivationCapabilities(
          botAccess,
          context.prismaEntityType,
          options.channelReadVerified,
        )
      )
        return null;
    }
    await this.ensureChatBinding(context);
    const accessPersisted = await this.maxBotLinkService.recordBotAccessProbe({
      chatId: context.chatId,
      botId: context.botId,
      access: botAccess,
      source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
      checkedAt: probeStartedAt,
      allowMembershipRecovery: true,
      channelReadVerified: options.channelReadVerified,
      explicitActivation: activation,
      activationActorAccess: activation ? userAccess : undefined,
    });
    if (!accessPersisted) {
      return null;
    }

    const expiresAt = new Date(probeStartedAt.getTime() + HANDSHAKE_ACCESS_EDGE_GRANTED_TTL_MS);
    const wasConnected = await this.prisma.$transaction(async (tx) => {
      if (!(await this.lockCurrentProbe(tx, context, probeStartedAt))) {
        return null;
      }
      // FLAG: Complete roster exclusion is newer evidence even for a never-saved actor.
      // Keep this positive-grant fence out of shared bot-scoped denial/cleanup checks.
      if (await hasNewerCompleteAdminRoster(tx, context.chatId, probeStartedAt)) return null;

      const existing = await tx.managedEntityAccessEdge.findUnique({
        where: {
          chatId_userId_botId: {
            chatId: context.chatId,
            userId: context.senderId,
            botId: context.botId,
          },
        },
        select: { state: true },
      });

      await this.upsertManagedBotChatCatalog(
        context,
        tx as ManagedBotChatCatalogClient,
        probeStartedAt,
      );
      await tx.chatAdminAllowlist.upsert({
        where: {
          chatId_userId: {
            chatId: context.chatId,
            userId: context.senderId,
          },
        },
        create: {
          chatId: context.chatId,
          userId: context.senderId,
        },
        update: {},
      });
      await tx.managedEntityAdminMember.upsert({
        where: {
          chatId_userId_observedByBotId: {
            chatId: context.chatId,
            userId: context.senderId,
            observedByBotId: context.botId,
          },
        },
        create: {
          chatId: context.chatId,
          userId: context.senderId,
          observedByBotId: context.botId,
          entityType: context.prismaEntityType,
          role: this.toAccessRole(userAccess),
          permissions: this.normalizePermissions(userAccess.permissions),
          checkedAt: probeStartedAt,
          expiresAt,
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
        },
        update: {
          entityType: context.prismaEntityType,
          role: this.toAccessRole(userAccess),
          permissions: this.normalizePermissions(userAccess.permissions),
          checkedAt: probeStartedAt,
          expiresAt,
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
        },
      });
      await tx.managedEntityAccessEdge.upsert({
        where: {
          chatId_userId_botId: {
            chatId: context.chatId,
            userId: context.senderId,
            botId: context.botId,
          },
        },
        create: {
          chatId: context.chatId,
          userId: context.senderId,
          botId: context.botId,
          entityType: context.prismaEntityType,
          state: ManagedEntityAccessState.GRANTED,
          userRole: this.toAccessRole(userAccess),
          botRole: this.toAccessRole(botAccess),
          checkedAt: probeStartedAt,
          expiresAt,
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
        },
        update: {
          entityType: context.prismaEntityType,
          state: ManagedEntityAccessState.GRANTED,
          userRole: this.toAccessRole(userAccess),
          botRole: this.toAccessRole(botAccess),
          checkedAt: probeStartedAt,
          expiresAt,
          deniedReason: null,
          lastMaxErrorCode: null,
          lastMaxErrorMessage: null,
          lastMaxStatusCode: null,
          source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
        },
      });
      await tx.managedEntityLocalActivity.upsert({
        where: {
          userId_chatId: {
            userId: context.senderId,
            chatId: context.chatId,
          },
        },
        create: {
          userId: context.senderId,
          chatId: context.chatId,
          entityType: context.prismaEntityType,
          chatTitle: context.title,
          sourceEventType: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          botId: context.botId,
          lastEventAt: probeStartedAt,
        },
        update: {
          entityType: context.prismaEntityType,
          ...(observedManagedEntityTitle(context.chatId, context.title)
            ? { chatTitle: context.title }
            : {}),
          sourceEventType: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          botId: context.botId,
          lastEventAt: probeStartedAt,
        },
      });

      return existing?.state === ManagedEntityAccessState.GRANTED;
    });
    if (wasConnected === null) {
      return null;
    }

    await this.maxBotLinkService.reconcileChatPrimaryByAccess?.({
      chatId: context.chatId,
      title: observedManagedEntityTitle(context.chatId, context.title),
      entityType: context.prismaEntityType,
    });
    if (!(await this.publishGrantedCaches(context, probeStartedAt))) {
      await this.compensateSupersededGrant(context, probeStartedAt);
      return null;
    }

    return wasConnected;
  }

  private async publishGrantedCaches(
    context: ManagedEntityAccessWriteContext & { senderId: string },
    probeStartedAt: Date,
  ): Promise<boolean> {
    const stillCurrent = await this.prisma.$transaction(async (tx) => {
      if (!(await this.lockCurrentProbe(tx, context, probeStartedAt))) {
        return false;
      }
      return !(await hasNewerCompleteAdminRoster(tx, context.chatId, probeStartedAt));
    });
    if (!stillCurrent) {
      return false;
    }

    return this.chatContextCache.applyAdminAccessEpochMutation(
      {
        chatId: context.chatId,
        userId: context.senderId,
        state: 'granted',
        eventAt: probeStartedAt,
        publishedSummary: this.buildPublishedSnapshotUpsert(context),
        publishedSnapshotTtlSec: HANDSHAKE_PUBLISHED_SNAPSHOT_TTL_SEC,
        recentBootstrapSummary: this.buildChatSummary(context),
        recentBootstrapTtlSec: HANDSHAKE_BOOTSTRAP_TTL_SEC,
      },
      { acceptNewerGrantedEpoch: true },
    );
  }

  private async lockCurrentProbe(
    tx: Prisma.TransactionClient,
    context: ManagedEntityAccessWriteContext,
    probeStartedAt: Date,
  ): Promise<boolean> {
    const lockedChats = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT chat."id"
      FROM "chats" AS chat
      WHERE chat."id" = ${context.chatId}
      FOR UPDATE OF chat
    `;
    if (lockedChats.length !== 1) {
      return false;
    }

    const userIdVariants = this.buildUserIdVariants(context.senderId);
    const userActivityFence =
      userIdVariants.length > 0
        ? Prisma.sql`
            AND NOT EXISTS (
              SELECT 1
              FROM "chat_membership_activity_events" AS activity
              WHERE activity."chat_id" = ${context.chatId}
                AND activity."user_id" IN (${Prisma.join(userIdVariants)})
                AND activity."event_type" IN ('user_added', 'user_removed')
                AND activity."event_at" >= ${probeStartedAt}
            )
          `
        : Prisma.empty;
    // FLAG: Match both MAX id forms; webhook activity stores the exact payload form only.
    const lockedMemberships = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT membership."id"
      FROM "chat_bot_memberships" AS membership
      WHERE membership."chat_id" = ${context.chatId}
        AND membership."bot_id" = ${context.botId}
        AND membership."status"::text = 'ACTIVE'
        AND membership."bot_access_checked_at" = ${probeStartedAt}
        AND membership."bot_access_source" = ${MANAGED_ENTITY_HANDSHAKE_SOURCE}
        AND membership."bot_access_state"::text IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
        AND (
          membership."lifecycle_event_at" IS NULL
          OR membership."lifecycle_event_at" < ${probeStartedAt}
          OR (
            membership."lifecycle_event_at" = ${probeStartedAt}
            AND membership."lifecycle_event_type" = 'live_probe'
            AND membership."lifecycle_source" = 'live_probe'
          )
        )
        ${userActivityFence}
      LIMIT 1
      FOR UPDATE OF membership
    `;
    if (lockedMemberships.length !== 1) {
      return false;
    }

    if (userIdVariants.length === 0) {
      return true;
    }

    // FLAG: Preserve exact-bot and negative/unknown actor fences. A different bot's
    // concurrent verified admin grant does not invalidate this independently checked bot.
    const newerAccessEdge = await tx.managedEntityAccessEdge.findFirst({
      where: newerManagedEntityActorConflictWhere(
        context.chatId,
        userIdVariants,
        context.botId,
        probeStartedAt,
      ),
      select: { checkedAt: true },
    });
    return newerAccessEdge === null;
  }

  private async compensateSupersededGrant(
    context: ManagedEntityAccessWriteContext & { senderId: string },
    probeStartedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // FLAG: Serialize compensation with removal/recovery so no stale cache write can finish last.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${context.chatId}
        FOR UPDATE OF chat
      `;
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT membership."id"
        FROM "chat_bot_memberships" AS membership
        WHERE membership."chat_id" = ${context.chatId}
          AND membership."bot_id" = ${context.botId}
        LIMIT 1
        FOR UPDATE OF membership
      `;
      await Promise.all([
        tx.managedEntityAccessEdge.updateMany({
          where: {
            chatId: context.chatId,
            userId: context.senderId,
            botId: context.botId,
            state: ManagedEntityAccessState.GRANTED,
            checkedAt: probeStartedAt,
          },
          data: {
            state: ManagedEntityAccessState.BOT_DENIED,
            botRole: ManagedEntityAccessRole.MEMBER,
            checkedAt: probeStartedAt,
            expiresAt: null,
            deniedReason: 'bot_access_probe_superseded',
            source: MANAGED_ENTITY_HANDSHAKE_SOURCE,
          },
        }),
        tx.managedEntityAdminMember.deleteMany({
          where: {
            chatId: context.chatId,
            userId: context.senderId,
            observedByBotId: context.botId,
            checkedAt: probeStartedAt,
          },
        }),
      ]);

      const [newerGrant, newerAdmin] = await Promise.all([
        tx.managedEntityAccessEdge.findFirst({
          where: {
            chatId: context.chatId,
            userId: { in: this.buildUserIdVariants(context.senderId) },
            state: ManagedEntityAccessState.GRANTED,
            checkedAt: { gt: probeStartedAt },
          },
          select: { userId: true },
        }),
        tx.managedEntityAdminMember.findFirst({
          where: {
            chatId: context.chatId,
            userId: { in: this.buildUserIdVariants(context.senderId) },
            checkedAt: { gt: probeStartedAt },
          },
          select: { userId: true },
        }),
      ]);
      if (!newerGrant && !newerAdmin) {
        await tx.chatAdminAllowlist.deleteMany({
          where: {
            chatId: context.chatId,
            userId: { in: this.buildUserIdVariants(context.senderId) },
          },
        });
      }
    });
  }

  private buildPublishedSnapshotUpsert(
    context: ManagedEntityAccessWriteContext,
  ): ManagedEntityPublishedSnapshotUpsert {
    return {
      ...this.buildChatSummaryBase(context),
      ...(context.link !== undefined ? { link: context.link } : {}),
      ...(context.avatarUrl !== undefined ? { avatarUrl: context.avatarUrl } : {}),
    };
  }

  private buildChatSummary(context: ManagedEntityAccessWriteContext): ChatSummary {
    return {
      ...this.buildChatSummaryBase(context),
      link: context.link ?? null,
      avatarUrl: context.avatarUrl ?? null,
    };
  }

  private buildChatSummaryBase(
    context: ManagedEntityAccessWriteContext,
  ): Omit<ChatSummary, 'link' | 'avatarUrl'> {
    return {
      id: context.chatId,
      title: context.title,
      createdAt: context.createdAt ?? new Date().toISOString(),
      entityType: context.entityType,
      primaryBotId: context.botId,
      assignedBots: [],
      sharedMode: 'owned',
      channelOverview: null,
    };
  }

  private buildUserIdVariants(value: string | null | undefined): string[] {
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

  private toAccessRole(access: MaxChatMemberAccess): ManagedEntityAccessRole {
    if (access.isOwner) {
      return ManagedEntityAccessRole.OWNER;
    }
    if (access.isAdmin) {
      return ManagedEntityAccessRole.ADMIN;
    }
    return ManagedEntityAccessRole.MEMBER;
  }

  private normalizePermissions(permissions: readonly string[]): string[] {
    return Array.from(
      new Set(
        permissions
          .map((permission) => permission.trim())
          .filter((permission) => permission.length > 0),
      ),
    );
  }
}
