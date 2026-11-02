import { isMaxMutationOutcomeAmbiguous } from './max-mutation-outcome.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ManagedEntityType } from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedAutopostRuleStatus,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  ManagedEntityAccessState,
  type Prisma,
} from '../prisma/prisma-client';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { PrismaService } from '../prisma/prisma.service';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import {
  collectActiveManagedEntityBotMembershipIds,
  managedEntityBotMembershipAllowsFreshGrantedEdge,
  managedEntityBotMembershipHasFreshConfirmedAccess,
  MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS,
} from './managed-entity-bot-access.util';
import {
  MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND,
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  type ManagedEntityAccessLossCleanupJob,
  type ManagedEntityAccessLossCleanupReason,
  type MaxChatAdminRosterQueueJob,
} from './max-chat-admin-roster-sync.queue';
import { MaxBotLinkService } from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE } from './managed-entity-access-loss.constants';

const MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_DELAY_MS = 45_000;
const MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_ATTEMPTS = 3;
const MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_BACKOFF_MS = 15_000;
const MANAGED_ENTITY_ACCESS_LOSS_REASONS = new Set<ManagedEntityAccessLossReason>([
  'chat_not_found',
  'bot_denied',
  'bot_removed',
  'chat_inaccessible',
]);
const CONFIRMED_BOT_ACCESS_STATES = [
  ChatBotAccessState.CONFIRMED_ADMIN,
  ChatBotAccessState.CONFIRMED_OWNER,
] as const;

export type ManagedEntityAccessLossReason = ManagedEntityAccessLossCleanupReason;

export type ManagedEntityAccessLossOperation =
  | 'send'
  | 'edit'
  | 'delete'
  | 'read'
  | 'lookup'
  // FLAG: A missing/inaccessible message is not proof that its parent chat is inaccessible.
  | 'message_lookup'
  | 'member_moderation';

export type MaxTerminalChatActionErrorClassification = {
  kind: 'managed_entity_access_lost' | 'message_not_found' | 'terminal_unknown';
  reason?: ManagedEntityAccessLossReason;
  statusCode: number | null;
  code: string | null;
  message: string;
};

export type RecordManagedEntityAccessLostParams = {
  chatId: string;
  botId?: string | null;
  entityType?: ChatEntityType | null;
  title?: string | null;
  reason: ManagedEntityAccessLossReason;
  source: string;
  lastMaxErrorCode?: string | null;
  lastMaxErrorMessage?: string | null;
  lastMaxStatusCode?: number | null;
  lifecycleEventAt?: Date | null;
  lifecycleEventType?: string | null;
  lifecycleSource?: string | null;
  cachePublicationWaitMs?: number | null;
};

export type RecordManagedEntityAccessLostFromErrorParams = Omit<
  RecordManagedEntityAccessLostParams,
  'reason'
> & {
  error: unknown;
  operation: ManagedEntityAccessLossOperation;
};

export type RecordManagedEntityAccessLostResult = {
  chatId: string;
  botId: string | null;
  nextOwnerBotId: string | null;
  updatedAccessEdges: number | null;
  cleanup: ManagedEntityAccessLossCleanupResult;
};

export type RecordManagedEntityAccessLostFromErrorResult = {
  classification: MaxTerminalChatActionErrorClassification;
  reason: ManagedEntityAccessLossReason | null;
  recorded: RecordManagedEntityAccessLostResult | null;
};

export type ManagedEntityAccessLossCleanupResult = {
  nightModeJobsCleared: boolean;
  canceledBroadcasts: number | null;
  canceledBroadcastDeliveries: number | null;
  canceledBroadcastOccurrences: number | null;
  clearedVkPublishPosts: number | null;
  pausedVkSources: number | null;
  removedRosterSyncJobs: number | null;
};

export type ManagedEntityAccessLossDeferredCleanupResult = {
  applied: boolean;
  skippedReason: 'invalid_job' | 'chat_missing' | 'stale_lifecycle' | 'surviving_access' | null;
  cleanup: ManagedEntityAccessLossCleanupResult;
};

type ManagedEntityRuntimeCleanupClient = Pick<
  Prisma.TransactionClient,
  | 'managedAutopostRule'
  | 'managedBroadcast'
  | 'managedBroadcastDelivery'
  | 'managedBroadcastCalendarReservation'
  | 'managedBroadcastOccurrence'
>;

@Injectable()
export class ManagedEntityAccessLossService {
  private readonly logger = new Logger(ManagedEntityAccessLossService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly chatContextCache: ChatContextCacheService,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
    @Optional()
    @InjectQueue(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE)
    private readonly rosterSyncQueue?: Queue<MaxChatAdminRosterQueueJob>,
    @Optional()
    private readonly maxBotRegistry?: MaxBotRegistryService,
  ) {}

  async recordIfManagedEntityAccessLost(
    params: RecordManagedEntityAccessLostFromErrorParams,
  ): Promise<RecordManagedEntityAccessLostFromErrorResult | null> {
    const classification = classifyMaxTerminalChatActionError(params.error);
    if (!classification) {
      return null;
    }

    const reason = resolveManagedEntityAccessLossReason(params.operation, classification);
    if (!reason) {
      return {
        classification,
        reason: null,
        recorded: null,
      };
    }

    return {
      classification,
      reason,
      recorded: await this.recordManagedEntityAccessLost({
        chatId: params.chatId,
        botId: params.botId,
        entityType: params.entityType,
        title: params.title,
        source: params.source,
        reason,
        lastMaxErrorCode: classification.code,
        lastMaxErrorMessage: classification.message,
        lastMaxStatusCode: classification.statusCode,
        lifecycleEventAt: params.lifecycleEventAt,
        lifecycleEventType: params.lifecycleEventType,
        lifecycleSource: params.lifecycleSource,
        cachePublicationWaitMs: params.cachePublicationWaitMs,
      }),
    };
  }

  async recordManagedEntityAccessLost(
    params: RecordManagedEntityAccessLostParams,
  ): Promise<RecordManagedEntityAccessLostResult | null> {
    const chatId = params.chatId.trim();
    const explicitBotId = this.readTrimmedString(params.botId);
    if (!chatId || isPrivateDirectChatId(chatId) || !explicitBotId) {
      return null;
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        title: true,
        entityType: true,
      },
    });
    const botId = await this.resolveBotId(chatId, explicitBotId);
    const title = params.title?.trim() || chat?.title || `Chat ${chatId}`;
    const entityType = params.entityType ?? chat?.entityType ?? null;
    const lifecycleEventAt = this.normalizeDate(params.lifecycleEventAt);
    const lifecycleEventType = this.readTrimmedString(params.lifecycleEventType) ?? 'bot_removed';
    const lifecycleSource = this.readTrimmedString(params.lifecycleSource) ?? 'webhook';
    const nextOwnerBotId = botId
      ? await this.maxBotLinkService.markChatBotRemoved({
          chatId,
          botId,
          title,
          entityType,
          accessLostReason: params.reason,
          accessLostSource: params.source,
          lastMaxErrorCode: params.lastMaxErrorCode,
          lastMaxErrorMessage: params.lastMaxErrorMessage,
          lastMaxStatusCode: params.lastMaxStatusCode,
          ...(lifecycleEventAt
            ? {
                lifecycleEventAt,
                lifecycleEventType,
                lifecycleSource,
              }
            : {}),
        })
      : null;
    const lifecycleFinalization =
      botId && lifecycleEventAt
        ? await this.finalizeLifecycleRemoval({
            chatId,
            botId,
            entityType,
            reason: params.reason,
            source: params.source,
            lifecycleEventAt,
            lifecycleEventType,
            lifecycleSource,
            cachePublicationWaitMs: params.cachePublicationWaitMs,
            lastMaxErrorCode: params.lastMaxErrorCode,
            lastMaxErrorMessage: params.lastMaxErrorMessage,
            lastMaxStatusCode: params.lastMaxStatusCode,
          })
        : null;
    const updatedAccessEdges = lifecycleFinalization
      ? lifecycleFinalization.updatedAccessEdges
      : botId
        ? await this.markAccessEdgesBotDenied({
            chatId,
            botId,
            reason: params.reason,
            source: params.source,
            lastMaxErrorCode: params.lastMaxErrorCode,
            lastMaxErrorMessage: params.lastMaxErrorMessage,
            lastMaxStatusCode: params.lastMaxStatusCode,
          })
        : 0;
    let cleanup = this.createEmptyCleanupResult();
    try {
      if (lifecycleFinalization && botId && lifecycleEventAt) {
        if (lifecycleFinalization.removalStillCurrent) {
          if (this.rosterSyncQueue) {
            await this.enqueueDeferredRuntimeCleanup({
              chatId,
              botId,
              lifecycleEventAt,
              lifecycleEventType,
              lifecycleSource,
              reason: params.reason,
              source: params.source,
            });
          } else {
            // Queue-less construction is retained for isolated tests and one-off tooling only.
            const hasSurvivingBotAccess = await this.hasConfirmedSurvivingBotAccess({
              chatId,
              // A newer grant may reactivate the same bot after lifecycle finalization.
              lostBotId: null,
              preferredBotId: nextOwnerBotId,
            });
            if (!hasSurvivingBotAccess) {
              cleanup = await this.cleanupRuntimeWork({
                chatId,
                reason: params.reason,
                source: params.source,
              });
            }
          }
        }
      } else {
        const hasSurvivingBotAccess = await this.hasConfirmedSurvivingBotAccess({
          chatId,
          lostBotId: botId,
          preferredBotId: nextOwnerBotId,
        });
        if (!hasSurvivingBotAccess) {
          cleanup = await this.cleanupRuntimeWork({
            chatId,
            reason: params.reason,
            source: params.source,
          });
        }
      }
    } finally {
      if (!lifecycleFinalization) {
        await this.awaitCachePublications(
          [
            this.chatContextCache.invalidate(chatId),
            this.chatContextCache.invalidateManagedEntityHeader?.(chatId),
            this.chatContextCache.clearManagedEntitiesRecentBootstrapForChat(
              chatId,
              mapManagedEntityType(entityType),
            ),
          ],
          {
            chatId,
            source: params.source,
            maxWaitMs: params.cachePublicationWaitMs,
          },
        );
      }
    }

    this.logger.warn(
      {
        chatId,
        botId,
        nextOwnerBotId,
        reason: params.reason,
        source: params.source,
        updatedAccessEdges,
        cleanup,
      },
      'Recorded managed entity access lost',
    );

    return {
      chatId,
      botId,
      nextOwnerBotId,
      updatedAccessEdges,
      cleanup,
    };
  }

  private async finalizeLifecycleRemoval(params: {
    chatId: string;
    botId: string;
    entityType: ChatEntityType | null;
    reason: ManagedEntityAccessLossReason;
    source: string;
    lifecycleEventAt: Date;
    lifecycleEventType: string;
    lifecycleSource: string;
    lastMaxErrorCode?: string | null;
    lastMaxErrorMessage?: string | null;
    lastMaxStatusCode?: number | null;
    cachePublicationWaitMs?: number | null;
  }): Promise<{ updatedAccessEdges: number; removalStillCurrent: boolean }> {
    const persisted = await this.prisma.$transaction(async (tx) => {
      // FLAG: Commit lifecycle truth before touching Redis; a cache failure cannot roll back SQL.
      const chats = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${params.chatId}
        FOR UPDATE OF chat
      `;
      if (chats.length !== 1) {
        throw new Error('Managed entity chat disappeared during lifecycle cleanup');
      }

      const memberships = await tx.$queryRaw<
        Array<{
          status: string;
          lifecycleEventAt: Date | null;
          lifecycleEventType: string | null;
          lifecycleSource: string | null;
        }>
      >`
        SELECT
          membership."status"::text AS "status",
          membership."lifecycle_event_at" AS "lifecycleEventAt",
          membership."lifecycle_event_type" AS "lifecycleEventType",
          membership."lifecycle_source" AS "lifecycleSource"
        FROM "chat_bot_memberships" AS membership
        WHERE membership."chat_id" = ${params.chatId}
          AND membership."bot_id" = ${params.botId}
        LIMIT 1
        FOR UPDATE OF membership
      `;
      const membership = memberships[0] ?? null;
      if (!membership) {
        throw new Error('Managed entity membership disappeared during lifecycle cleanup');
      }

      const affectedEdges = await tx.managedEntityAccessEdge.findMany({
        where: {
          chatId: params.chatId,
          botId: params.botId,
          checkedAt: { lte: params.lifecycleEventAt },
        },
        select: { userId: true },
      });
      const affectedUserIds = Array.from(
        new Set(affectedEdges.map((edge) => edge.userId.trim()).filter(Boolean)),
      );
      const updated = await tx.managedEntityAccessEdge.updateMany({
        where: {
          chatId: params.chatId,
          botId: params.botId,
          checkedAt: { lte: params.lifecycleEventAt },
        },
        data: {
          state: ManagedEntityAccessState.BOT_DENIED,
          botRole: 'MEMBER',
          checkedAt: params.lifecycleEventAt,
          expiresAt: null,
          deniedReason: params.reason,
          lastMaxErrorCode: params.lastMaxErrorCode ?? null,
          lastMaxErrorMessage: params.lastMaxErrorMessage ?? null,
          lastMaxStatusCode: params.lastMaxStatusCode ?? null,
          source: params.source,
        } satisfies Prisma.ManagedEntityAccessEdgeUpdateManyMutationInput,
      });
      await Promise.all([
        tx.managedEntityAdminMember.deleteMany({
          where: {
            chatId: params.chatId,
            observedByBotId: params.botId,
            checkedAt: { lte: params.lifecycleEventAt },
          },
        }),
        tx.managedBotChatCatalog.updateMany({
          where: {
            chatId: params.chatId,
            botId: params.botId,
            lastSeenAt: { lte: params.lifecycleEventAt },
          },
          data: {
            status: 'REMOVED',
            source: params.source,
            lastSeenAt: params.lifecycleEventAt,
          },
        }),
      ]);

      const removalStillCurrent =
        membership.status === ChatBotMembershipStatus.REMOVED &&
        membership.lifecycleEventAt?.getTime() === params.lifecycleEventAt.getTime() &&
        membership.lifecycleEventType === params.lifecycleEventType &&
        membership.lifecycleSource === params.lifecycleSource;
      return {
        updatedAccessEdges: updated.count,
        removalStillCurrent,
        affectedUserIds,
      };
    });

    const deniedUserIds = await this.prisma.$transaction(async (tx) => {
      const chats = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${params.chatId}
        FOR UPDATE OF chat
      `;
      if (chats.length !== 1 || persisted.affectedUserIds.length === 0) {
        return [];
      }

      const activeMemberships = await tx.chatBotMembership.findMany({
        where: {
          chatId: params.chatId,
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: { in: [...CONFIRMED_BOT_ACCESS_STATES] },
        },
        select: { botId: true },
      });
      const activeBotIds = activeMemberships.map((membership) => membership.botId);
      if (activeBotIds.length === 0) {
        return persisted.affectedUserIds;
      }
      const survivingEdges = await tx.managedEntityAccessEdge.findMany({
        where: {
          chatId: params.chatId,
          userId: { in: persisted.affectedUserIds },
          botId: { in: activeBotIds },
          state: ManagedEntityAccessState.GRANTED,
        },
        select: { userId: true },
      });
      const survivors = new Set(survivingEdges.map((edge) => edge.userId));
      return persisted.affectedUserIds.filter((userId) => !survivors.has(userId));
    });

    await this.awaitCachePublications(
      [
        this.chatContextCache.invalidate(params.chatId),
        this.chatContextCache.invalidateManagedEntityHeader?.(params.chatId),
        ...deniedUserIds.map((userId) =>
          this.chatContextCache.applyAdminAccessEpochMutation({
            chatId: params.chatId,
            userId,
            state: 'bot_denied',
            eventAt: params.lifecycleEventAt,
          }),
        ),
      ],
      {
        chatId: params.chatId,
        source: params.source,
        maxWaitMs: params.cachePublicationWaitMs,
      },
    );
    return {
      updatedAccessEdges: persisted.updatedAccessEdges,
      removalStillCurrent: persisted.removalStillCurrent,
    };
  }

  async processDeferredRuntimeCleanup(
    job: ManagedEntityAccessLossCleanupJob,
  ): Promise<ManagedEntityAccessLossDeferredCleanupResult> {
    const normalized = this.normalizeDeferredRuntimeCleanupJob(job);
    if (!normalized) {
      this.logger.warn(
        { chatId: job.chatId, botId: job.botId },
        'Skipped malformed deferred managed entity access-loss cleanup job',
      );
      return {
        applied: false,
        skippedReason: 'invalid_job',
        cleanup: this.createEmptyCleanupResult(),
      };
    }

    const actionableBotIds = this.maxBotRegistry
      ? this.maxBotRegistry
          .getActionableBots()
          .map((bot) => this.readTrimmedString(bot.id))
          .filter((botId): botId is string => Boolean(botId))
      : null;
    const result = await this.prisma.$transaction(async (tx) => {
      // FLAG: Access grants and losses serialize on the parent Chat. Keep every destructive SQL
      // mutation in this transaction so a newer grant cannot commit between the fence and cleanup.
      const chats = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${normalized.chatId}
        FOR UPDATE OF chat
      `;
      if (chats.length !== 1) {
        return {
          applied: false,
          skippedReason: 'chat_missing' as const,
          cleanup: this.createEmptyCleanupResult(),
        };
      }

      const memberships = await tx.$queryRaw<
        Array<{
          status: string;
          lifecycleEventAt: Date | null;
          lifecycleEventType: string | null;
          lifecycleSource: string | null;
        }>
      >`
        SELECT
          membership."status"::text AS "status",
          membership."lifecycle_event_at" AS "lifecycleEventAt",
          membership."lifecycle_event_type" AS "lifecycleEventType",
          membership."lifecycle_source" AS "lifecycleSource"
        FROM "chat_bot_memberships" AS membership
        WHERE membership."chat_id" = ${normalized.chatId}
          AND membership."bot_id" = ${normalized.botId}
        LIMIT 1
        FOR UPDATE OF membership
      `;
      const membership = memberships[0] ?? null;
      const lossIsCurrent =
        membership?.status === ChatBotMembershipStatus.REMOVED &&
        membership.lifecycleEventAt?.getTime() === normalized.lifecycleEventAt.getTime() &&
        membership.lifecycleEventType === normalized.lifecycleEventType &&
        membership.lifecycleSource === normalized.lifecycleSource;
      if (!lossIsCurrent) {
        return {
          applied: false,
          skippedReason: 'stale_lifecycle' as const,
          cleanup: this.createEmptyCleanupResult(),
        };
      }

      if (
        await this.hasFreshActionableSurvivorInTransaction(tx, normalized.chatId, actionableBotIds)
      ) {
        return {
          applied: false,
          skippedReason: 'surviving_access' as const,
          cleanup: this.createEmptyCleanupResult(),
        };
      }

      const cleanup = this.createEmptyCleanupResult();
      await this.pauseManagedAutopostRules(normalized, tx);
      await this.cancelManagedBroadcastRuntime(normalized, cleanup, tx);
      return {
        applied: true,
        skippedReason: null,
        cleanup,
      };
    });

    if (result.applied && this.nightModeTransitionScheduler) {
      // FLAG: SQL cleanup commits before Redis reconciliation. The scheduler verifies the durable
      // membership epoch again after queue mutation so a concurrent fresh grant wins convergence.
      const reconciliation = await this.nightModeTransitionScheduler.reconcileChat(
        normalized.chatId,
      );
      result.cleanup.nightModeJobsCleared =
        reconciliation.queueAvailable &&
        reconciliation.scheduleEnabled === false &&
        reconciliation.passes > 0;
    }

    this.logger.log(
      {
        chatId: normalized.chatId,
        botId: normalized.botId,
        lifecycleEventAt: normalized.lifecycleEventAt.toISOString(),
        applied: result.applied,
        skippedReason: result.skippedReason,
        cleanup: result.cleanup,
      },
      'Processed deferred managed entity access-loss runtime cleanup',
    );
    return result;
  }

  private async enqueueDeferredRuntimeCleanup(params: {
    chatId: string;
    botId: string;
    lifecycleEventAt: Date;
    lifecycleEventType: string;
    lifecycleSource: string;
    reason: ManagedEntityAccessLossReason;
    source: string;
  }): Promise<boolean> {
    if (!this.rosterSyncQueue) {
      return false;
    }

    const job: ManagedEntityAccessLossCleanupJob = {
      kind: MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND,
      chatId: params.chatId,
      botId: params.botId,
      lifecycleEventAt: params.lifecycleEventAt.toISOString(),
      lifecycleEventType: params.lifecycleEventType,
      lifecycleSource: params.lifecycleSource,
      reason: params.reason,
      source: params.source,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.rosterSyncQueue.add('cleanup-managed-entity-access-loss', job, {
        jobId: this.buildDeferredRuntimeCleanupJobId(params),
        delay: MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_DELAY_MS,
        attempts: MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_ATTEMPTS,
        backoff: {
          type: 'fixed',
          delay: MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_BACKOFF_MS,
        },
        removeOnComplete: true,
        removeOnFail: false,
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          botId: params.botId,
          lifecycleEventAt: params.lifecycleEventAt.toISOString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue deferred managed entity access-loss runtime cleanup; runtime work was preserved',
      );
      return false;
    }
  }

  private async hasFreshActionableSurvivorInTransaction(
    tx: Prisma.TransactionClient,
    chatId: string,
    actionableBotIds: string[] | null,
  ): Promise<boolean> {
    if (actionableBotIds && actionableBotIds.length === 0) {
      return false;
    }

    const now = new Date();
    const memberships = await tx.chatBotMembership.findMany({
      where: {
        chatId,
        status: ChatBotMembershipStatus.ACTIVE,
        ...(actionableBotIds ? { botId: { in: actionableBotIds } } : {}),
      },
      select: {
        botId: true,
        status: true,
        permissionsSnapshot: true,
        botAccessState: true,
        botAccessExpiresAt: true,
      },
    });
    const activeBotIds = collectActiveManagedEntityBotMembershipIds(memberships, {
      isRuntimeBotId: (botId) => actionableBotIds === null || actionableBotIds.includes(botId),
    });
    const edgeEligibleBotIds = new Set(
      memberships
        .filter((membership) => managedEntityBotMembershipAllowsFreshGrantedEdge(membership))
        .map((membership) => membership.botId)
        .filter((botId) => activeBotIds.has(botId)),
    );
    if (activeBotIds.size === 0) {
      return false;
    }

    const grantedEdge =
      edgeEligibleBotIds.size > 0
        ? await tx.managedEntityAccessEdge.findFirst({
            where: {
              chatId,
              botId: { in: [...edgeEligibleBotIds] },
              state: ManagedEntityAccessState.GRANTED,
              OR: [
                { expiresAt: { gt: now } },
                {
                  expiresAt: null,
                  checkedAt: {
                    gt: new Date(now.getTime() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS),
                  },
                },
              ],
            },
            select: { botId: true },
          })
        : null;
    if (grantedEdge && edgeEligibleBotIds.has(grantedEdge.botId)) {
      return true;
    }

    return memberships.some(
      (membership) =>
        activeBotIds.has(membership.botId) &&
        managedEntityBotMembershipHasFreshConfirmedAccess(membership, { nowMs: now.getTime() }),
    );
  }

  private normalizeDeferredRuntimeCleanupJob(job: ManagedEntityAccessLossCleanupJob): {
    chatId: string;
    botId: string;
    lifecycleEventAt: Date;
    lifecycleEventType: string;
    lifecycleSource: string;
    reason: ManagedEntityAccessLossReason;
    source: string;
  } | null {
    const chatId = this.readTrimmedString(job.chatId);
    const botId = this.readTrimmedString(job.botId);
    const lifecycleEventAtMs = Date.parse(job.lifecycleEventAt);
    const lifecycleEventType = this.readTrimmedString(job.lifecycleEventType);
    const lifecycleSource = this.readTrimmedString(job.lifecycleSource);
    const source = this.readTrimmedString(job.source);
    if (
      !chatId ||
      !botId ||
      !Number.isFinite(lifecycleEventAtMs) ||
      !lifecycleEventType ||
      !lifecycleSource ||
      !source ||
      !MANAGED_ENTITY_ACCESS_LOSS_REASONS.has(job.reason)
    ) {
      return null;
    }

    return {
      chatId,
      botId,
      lifecycleEventAt: new Date(lifecycleEventAtMs),
      lifecycleEventType,
      lifecycleSource,
      reason: job.reason,
      source,
    };
  }

  private buildDeferredRuntimeCleanupJobId(params: {
    chatId: string;
    botId: string;
    lifecycleEventAt: Date;
    lifecycleEventType: string;
    lifecycleSource: string;
    reason: ManagedEntityAccessLossReason;
    source: string;
  }): string {
    const identity = Buffer.from(
      JSON.stringify([
        params.chatId,
        params.botId,
        params.lifecycleEventType,
        params.lifecycleSource,
        params.reason,
        params.source,
      ]),
      'utf8',
    ).toString('base64url');
    return `managed-entity-access-loss-cleanup__${identity}__${params.lifecycleEventAt.getTime()}`;
  }

  private async cleanupRuntimeWork(params: {
    chatId: string;
    reason: ManagedEntityAccessLossReason;
    source: string;
  }): Promise<ManagedEntityAccessLossCleanupResult> {
    const cleanup: ManagedEntityAccessLossCleanupResult = {
      nightModeJobsCleared: false,
      canceledBroadcasts: null,
      canceledBroadcastDeliveries: null,
      canceledBroadcastOccurrences: null,
      clearedVkPublishPosts: null,
      pausedVkSources: null,
      removedRosterSyncJobs: null,
    };

    // Stop rule materializers before canceling their already-created broadcasts.
    await this.pauseManagedAutopostRules(params);
    await Promise.all([
      this.clearNightModeJobs(params.chatId, cleanup),
      this.cancelManagedBroadcastRuntime(params, cleanup),
      this.clearRosterSyncJobs(params.chatId, cleanup),
    ]);

    return cleanup;
  }

  private async pauseManagedAutopostRules(
    params: {
      chatId: string;
      reason: ManagedEntityAccessLossReason;
      source: string;
    },
    db: ManagedEntityRuntimeCleanupClient = this.prisma,
  ): Promise<void> {
    if (typeof db.managedAutopostRule?.updateMany !== 'function') {
      return;
    }

    await db.managedAutopostRule.updateMany({
      where: {
        sourceChatId: params.chatId,
        status: {
          in: [ManagedAutopostRuleStatus.ACTIVE, ManagedAutopostRuleStatus.ERROR],
        },
      },
      data: {
        status: ManagedAutopostRuleStatus.PAUSED,
        nextMaterializeAt: null,
        lockedAt: null,
        lockToken: null,
        lastError: this.buildCleanupReasonMessage(params),
      },
    });
  }

  private createEmptyCleanupResult(): ManagedEntityAccessLossCleanupResult {
    return {
      nightModeJobsCleared: false,
      canceledBroadcasts: null,
      canceledBroadcastDeliveries: null,
      canceledBroadcastOccurrences: null,
      clearedVkPublishPosts: null,
      pausedVkSources: null,
      removedRosterSyncJobs: null,
    };
  }

  private async awaitCachePublications(
    operations: Array<Promise<unknown> | undefined>,
    params: {
      chatId: string;
      source: string;
      maxWaitMs?: number | null;
    },
  ): Promise<void> {
    const pending = Promise.all(
      operations.filter((operation): operation is Promise<unknown> => Boolean(operation)),
    );
    const observed = pending.then(
      () => ({ status: 'completed' as const }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    );
    const configuredWaitMs = params.maxWaitMs;
    if (configuredWaitMs === null || configuredWaitMs === undefined) {
      const outcome = await observed;
      if (outcome.status === 'failed') {
        throw outcome.error;
      }
      return;
    }

    const maxWaitMs = Number.isFinite(configuredWaitMs)
      ? Math.max(0, Math.trunc(configuredWaitMs))
      : 0;
    let timeout: NodeJS.Timeout | null = null;
    const outcome = await Promise.race([
      observed,
      new Promise<{ status: 'timed_out' }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: 'timed_out' }), maxWaitMs);
        timeout.unref();
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (outcome.status === 'completed') {
      return;
    }
    if (outcome.status === 'failed') {
      this.logDeferredCachePublicationFailure(params, outcome.error);
      return;
    }

    this.logger.warn(
      { chatId: params.chatId, source: params.source, maxWaitMs },
      'Managed entity access-loss cache publication exceeded its wait budget',
    );
    void observed.then((deferredOutcome) => {
      if (deferredOutcome.status === 'failed') {
        this.logDeferredCachePublicationFailure(params, deferredOutcome.error);
      }
    });
  }

  private logDeferredCachePublicationFailure(
    params: { chatId: string; source: string },
    error: unknown,
  ): void {
    this.logger.warn(
      {
        chatId: params.chatId,
        source: params.source,
        err: error instanceof Error ? error.message : String(error),
      },
      'Managed entity access-loss cache publication failed after SQL commit',
    );
  }

  private async hasConfirmedReplacementBotAccess(chatId: string, botId: string): Promise<boolean> {
    try {
      const now = new Date();
      const [membership, grantedEdge] = await Promise.all([
        typeof this.prisma.chatBotMembership?.findUnique === 'function'
          ? this.prisma.chatBotMembership.findUnique({
              where: {
                chatId_botId: {
                  chatId,
                  botId,
                },
              },
              select: {
                status: true,
                permissionsSnapshot: true,
                botAccessState: true,
                botAccessExpiresAt: true,
              },
            })
          : Promise.resolve(null),
        typeof this.prisma.managedEntityAccessEdge?.findFirst === 'function'
          ? this.prisma.managedEntityAccessEdge.findFirst({
              where: {
                chatId,
                botId,
                state: ManagedEntityAccessState.GRANTED,
                OR: [
                  { expiresAt: { gt: now } },
                  {
                    expiresAt: null,
                    checkedAt: {
                      gt: new Date(now.getTime() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS),
                    },
                  },
                ],
              },
              select: {
                botId: true,
              },
            })
          : Promise.resolve(null),
      ]);

      if (membership?.status !== ChatBotMembershipStatus.ACTIVE) {
        return false;
      }
      if (grantedEdge && managedEntityBotMembershipAllowsFreshGrantedEdge(membership)) {
        return true;
      }

      return managedEntityBotMembershipHasFreshConfirmedAccess(membership, {
        nowMs: now.getTime(),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to verify replacement bot access after managed entity access loss',
      );
      throw error;
    }
  }

  private async hasConfirmedSurvivingBotAccess(params: {
    chatId: string;
    lostBotId: string | null;
    preferredBotId: string | null;
  }): Promise<boolean> {
    const preferredBotId = this.readTrimmedString(params.preferredBotId);
    if (
      preferredBotId &&
      preferredBotId !== params.lostBotId &&
      this.isActionableRuntimeBotId(preferredBotId) &&
      (await this.hasConfirmedReplacementBotAccess(params.chatId, preferredBotId))
    ) {
      return true;
    }

    return this.hasAnyConfirmedSurvivingBotAccess(params.chatId, params.lostBotId);
  }

  private async hasAnyConfirmedSurvivingBotAccess(
    chatId: string,
    lostBotId: string | null,
  ): Promise<boolean> {
    try {
      const now = new Date();
      const candidateBotIds = this.getSurvivingActionableBotIds(lostBotId);
      if (candidateBotIds && candidateBotIds.length === 0) {
        return false;
      }

      const botIdWhere = candidateBotIds
        ? { in: candidateBotIds }
        : lostBotId
          ? { not: lostBotId }
          : undefined;
      const memberships =
        typeof this.prisma.chatBotMembership?.findMany === 'function'
          ? await this.prisma.chatBotMembership.findMany({
              where: {
                chatId,
                status: ChatBotMembershipStatus.ACTIVE,
                ...(botIdWhere ? { botId: botIdWhere } : {}),
              },
              select: {
                botId: true,
                status: true,
                permissionsSnapshot: true,
                botAccessState: true,
                botAccessExpiresAt: true,
              },
            })
          : [];
      const activeMembershipBotIds = collectActiveManagedEntityBotMembershipIds(memberships, {
        isRuntimeBotId: (botId) => this.isActionableRuntimeBotId(botId),
      });
      const edgeEligibleBotIds = new Set(
        memberships
          .filter((membership) => managedEntityBotMembershipAllowsFreshGrantedEdge(membership))
          .map((membership) => membership.botId)
          .filter((botId) => activeMembershipBotIds.has(botId)),
      );
      const grantedEdge =
        edgeEligibleBotIds.size > 0 &&
        typeof this.prisma.managedEntityAccessEdge?.findFirst === 'function'
          ? await this.prisma.managedEntityAccessEdge.findFirst({
              where: {
                chatId,
                state: ManagedEntityAccessState.GRANTED,
                botId: { in: [...edgeEligibleBotIds] },
                OR: [
                  { expiresAt: { gt: now } },
                  {
                    expiresAt: null,
                    checkedAt: {
                      gt: new Date(now.getTime() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS),
                    },
                  },
                ],
              },
              select: {
                botId: true,
              },
            })
          : null;

      if (grantedEdge && edgeEligibleBotIds.has(grantedEdge.botId)) {
        return true;
      }

      return memberships.some(
        (membership) =>
          activeMembershipBotIds.has(membership.botId) &&
          managedEntityBotMembershipHasFreshConfirmedAccess(membership, {
            nowMs: now.getTime(),
          }),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          lostBotId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to verify surviving bot access after managed entity access loss',
      );
      throw error;
    }
  }

  private getSurvivingActionableBotIds(lostBotId: string | null): string[] | null {
    if (!this.maxBotRegistry) {
      return null;
    }

    return this.maxBotRegistry
      .getActionableBots()
      .map((bot) => bot.id)
      .filter((botId) => botId !== lostBotId);
  }

  private isActionableRuntimeBotId(botId: string | null | undefined): boolean {
    const normalizedBotId = this.readTrimmedString(botId);
    if (!normalizedBotId) {
      return false;
    }
    if (!this.maxBotRegistry) {
      return true;
    }
    return this.maxBotRegistry.getActionableBots().some((bot) => bot.id === normalizedBotId);
  }

  private async clearNightModeJobs(
    chatId: string,
    cleanup: ManagedEntityAccessLossCleanupResult,
  ): Promise<void> {
    if (!this.nightModeTransitionScheduler) {
      return;
    }
    const reconciliation = await this.nightModeTransitionScheduler.reconcileChat(chatId);
    cleanup.nightModeJobsCleared =
      reconciliation.queueAvailable &&
      reconciliation.scheduleEnabled === false &&
      reconciliation.passes > 0;
  }

  private async cancelManagedBroadcastRuntime(
    params: {
      chatId: string;
      reason: ManagedEntityAccessLossReason;
      source: string;
    },
    cleanup: ManagedEntityAccessLossCleanupResult,
    db: ManagedEntityRuntimeCleanupClient = this.prisma,
  ): Promise<void> {
    if (
      typeof db.managedBroadcast?.updateMany !== 'function' ||
      typeof db.managedBroadcastDelivery?.updateMany !== 'function'
    ) {
      return;
    }

    const lastError = this.buildCleanupReasonMessage(params);
    const activeBroadcastStatuses = [
      ManagedBroadcastStatus.ACTIVE,
      ManagedBroadcastStatus.PARTIAL,
      ManagedBroadcastStatus.FAILED,
    ];
    const cancelableDeliveryStatuses = [
      ManagedBroadcastDeliveryStatus.PENDING,
      ManagedBroadcastDeliveryStatus.FAILED,
    ];

    const [broadcasts, deliveries, , occurrences] = await Promise.all([
      db.managedBroadcast.updateMany({
        where: {
          sourceChatId: params.chatId,
          publicationOccurrenceId: null,
          status: { in: activeBroadcastStatuses },
        },
        data: {
          status: ManagedBroadcastStatus.CANCELED,
          nextSendAt: null,
          lockedAt: null,
          lockToken: null,
          lastError,
        },
      }),
      db.managedBroadcastDelivery.updateMany({
        where: {
          targetChatId: params.chatId,
          // FLAG: A concurrent SENDING delivery owns an in-flight MAX result. Its lease owner must
          // persist SENT/FAILED/AMBIGUOUS; canceling it here can discard a successful message ID.
          status: { in: cancelableDeliveryStatuses },
        },
        data: {
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lockedAt: null,
          lockToken: null,
          lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
          lastError,
        },
      }),
      typeof db.managedBroadcastCalendarReservation?.deleteMany === 'function'
        ? db.managedBroadcastCalendarReservation.deleteMany({
            where: {
              OR: [
                { targetChatId: params.chatId },
                {
                  sourceChatId: params.chatId,
                  broadcast: { is: { publicationOccurrenceId: null } },
                },
              ],
            },
          })
        : Promise.resolve(null),
      typeof db.managedBroadcastOccurrence?.updateMany === 'function'
        ? db.managedBroadcastOccurrence.updateMany({
            where: {
              sourceChatId: params.chatId,
              broadcast: { is: { publicationOccurrenceId: null } },
              status: { in: activeBroadcastStatuses },
            },
            data: {
              status: ManagedBroadcastStatus.CANCELED,
            },
          })
        : Promise.resolve(null),
    ]);

    cleanup.canceledBroadcasts = this.readCount(broadcasts);
    cleanup.canceledBroadcastDeliveries = this.readCount(deliveries);
    cleanup.canceledBroadcastOccurrences = this.readCount(occurrences);
  }

  private async clearRosterSyncJobs(
    chatId: string,
    cleanup: ManagedEntityAccessLossCleanupResult,
  ): Promise<void> {
    if (!this.rosterSyncQueue) {
      return;
    }

    try {
      const job = await this.rosterSyncQueue.getJob(this.buildRosterSyncJobId(chatId));
      if (!job) {
        cleanup.removedRosterSyncJobs = 0;
        return;
      }

      const state = await job.getState();
      if (state === 'active') {
        cleanup.removedRosterSyncJobs = 0;
        return;
      }

      await job.remove();
      cleanup.removedRosterSyncJobs = 1;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clear roster sync jobs after managed entity access loss',
      );
    }
  }

  private buildRosterSyncJobId(chatId: string): string {
    return `chat-admin-roster-sync__${chatId}`;
  }

  private async resolveBotId(
    _chatId: string,
    botId: string | null | undefined,
  ): Promise<string | null> {
    const explicit = this.readTrimmedString(botId);
    if (explicit) {
      return explicit;
    }

    return null;
  }

  private async markAccessEdgesBotDenied(params: {
    chatId: string;
    botId: string | null;
    reason: string;
    source: string;
    lastMaxErrorCode?: string | null;
    lastMaxErrorMessage?: string | null;
    lastMaxStatusCode?: number | null;
  }): Promise<number | null> {
    if (typeof this.prisma.managedEntityAccessEdge?.updateMany !== 'function') {
      return null;
    }

    const result = await this.prisma.managedEntityAccessEdge.updateMany({
      where: {
        chatId: params.chatId,
        ...(params.botId ? { botId: params.botId } : {}),
      },
      data: {
        state: ManagedEntityAccessState.BOT_DENIED,
        botRole: 'MEMBER',
        checkedAt: new Date(),
        expiresAt: null,
        deniedReason: params.reason,
        lastMaxErrorCode: params.lastMaxErrorCode ?? null,
        lastMaxErrorMessage: params.lastMaxErrorMessage ?? null,
        lastMaxStatusCode: params.lastMaxStatusCode ?? null,
        source: params.source,
      } satisfies Prisma.ManagedEntityAccessEdgeUpdateManyMutationInput,
    });

    return typeof result.count === 'number' ? result.count : null;
  }

  private readTrimmedString(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private normalizeDate(value: Date | null | undefined): Date | null {
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
  }

  private readCount(value: unknown): number | null {
    const count = (value as { count?: unknown } | null)?.count;
    return typeof count === 'number' ? count : null;
  }

  private buildCleanupReasonMessage(params: {
    reason: ManagedEntityAccessLossReason;
    source: string;
  }): string {
    return `Бот потерял доступ к чату (${params.reason}, ${params.source}); фоновые доставки остановлены.`;
  }
}

export function classifyMaxTerminalChatActionError(
  error: unknown,
): MaxTerminalChatActionErrorClassification | null {
  if (isMaxMutationOutcomeAmbiguous(error)) return null;
  const statusCode = extractMaxErrorStatus(error);
  const code = extractMaxErrorCode(error);
  const message = extractMaxErrorMessage(error);

  if (code === 'message.not.found' || message.includes('message not found')) {
    return {
      kind: 'message_not_found',
      statusCode,
      code,
      message,
    };
  }

  if (code === 'chat.not.found' || message.includes('chat not found')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'chat_not_found',
      statusCode,
      code,
      message,
    };
  }

  if (code === 'chat.denied') {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'bot_denied',
      statusCode,
      code,
      message,
    };
  }

  if (message.includes('bot is not a chat member')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'bot_removed',
      statusCode,
      code,
      message,
    };
  }

  if (message.includes('not accessible')) {
    return {
      kind: 'managed_entity_access_lost',
      reason: 'chat_inaccessible',
      statusCode,
      code,
      message,
    };
  }

  if (statusCode === 403 || statusCode === 404) {
    return {
      kind: 'terminal_unknown',
      statusCode,
      code,
      message,
    };
  }

  return null;
}

export function resolveManagedEntityAccessLossReason(
  _operation: ManagedEntityAccessLossOperation,
  classification: MaxTerminalChatActionErrorClassification,
): ManagedEntityAccessLossReason | null {
  if (classification.kind === 'managed_entity_access_lost') {
    return classification.reason ?? 'chat_inaccessible';
  }

  return null;
}

export function extractMaxErrorStatus(error: unknown): number | null {
  const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
  return typeof maybeStatus === 'number' ? maybeStatus : null;
}

export function extractMaxErrorCode(error: unknown): string | null {
  const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof maybeCode === 'string' && maybeCode.trim().length > 0
    ? maybeCode.trim().toLowerCase()
    : null;
}

export function extractMaxErrorMessage(error: unknown): string {
  const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response?.data
    ?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
    return responseMessage.trim().toLowerCase();
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().toLowerCase();
  }

  return String(error).trim().toLowerCase();
}

function mapManagedEntityType(entityType: ChatEntityType | null): ManagedEntityType | null {
  if (entityType === ChatEntityType.CHAT) {
    return 'chat';
  }
  if (entityType === ChatEntityType.CHANNEL) {
    return 'channel';
  }
  return null;
}
