import { observedManagedEntityTitle } from '../common/managed-entity-title';
import { probeManagedEntityActor } from './managed-entity-actor-probe';
import { handOffHandshakeRoster } from './handshake-roster-handoff';
import {
  ADMIN_ROSTER_ACTIVE_REFRESH_MS,
  ADMIN_ROSTER_REFRESH_RETRY_MS,
  claimActiveAdminRosterRefresh,
  completeAdminRoster,
  hasNewerCompleteAdminRoster,
  invalidateAdminRosterCompleteness,
} from './chat-admin-roster-state';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type { ChatSummary, ManagedEntityType } from '@maxim/contracts';
import { managedRefreshBackoffMs } from './managed-refresh-backoff';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
  Prisma,
} from '../prisma/prisma-client';
import type { Queue } from 'bullmq';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import type { RosterSyncState } from '../system/optimization-runtime-metrics';
import { MaxApiInternalRateLimitError } from './max-api-internal-rate-limit.error';
import { MAX_API_SOURCE_TAGS, MaxClientService, type MaxBotChat } from './max-client.service';
import { MaxBotLinkService } from './max-bot-link.service';
import { resolveExplicitMembershipAccessDenial } from './max-membership-access-error';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { canDiscoverChatsForBotState } from './max-bot-state.util';
import { ManagedEntityActivationRequiredError } from './managed-entity-activation.util';
import {
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  type MaxChatAdminRosterSyncJob,
} from './max-chat-admin-roster-sync.queue';

const CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS = 2_500;
const CHAT_ADMIN_ROSTER_SYNC_FAST_LANE_TIMEOUT_MS = 1_500;
const CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE = 'background';
const CHAT_ADMIN_ROSTER_DISCOVERY_SCHEDULE_CONCURRENCY = 4;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_ATTEMPTS = 8;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_INITIAL_DELAY_MS = 5_000;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_INITIAL_JITTER_MS = 5_000;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_BACKOFF_DELAY_MS = 5_000;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_RETRY_UNTIL_TOLERANCE_MS = 10_000;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_ATTEMPTS = 6;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_BACKOFF_DELAY_MS = 3_000;
const CHAT_ADMIN_ROSTER_SYNC_DEFAULT_PRIORITY = 10;
const CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_PRIORITY = 1;
const CHAT_ADMIN_ROSTER_SYNC_ACCESS_CRITICAL_PRIORITY = 2;
const CHAT_ADMIN_ROSTER_SYNC_MEMBERSHIP_PREWARM_MAX_PENDING = 64;
const CHAT_ADMIN_ROSTER_SYNC_SOURCE_BACKOFF_MS = 10_000;
const CHAT_ADMIN_ROSTER_SYNC_SOURCE_BACKOFF_JITTER_MS = 5_000;
const CHAT_ADMIN_ROSTER_SYNC_TERMINAL_BOT_BACKOFF_MS = 5 * 60 * 1_000;
const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC = 7 * 24 * 60 * 60;
const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY = 8;
const MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS = 3 * 24 * 60 * 60 * 1_000;
const LOCAL_BACKFILL_MEMBERSHIP_PAGE_SIZE = 500;
const ACTIVE_ROSTER_OBSERVATION_CONCURRENCY = 8;
const ACTIVE_ROSTER_OBSERVATION_MAX_KEYS = 20_000;

type ManagedEntityAccessRoleValue = 'OWNER' | 'ADMIN' | 'MEMBER' | 'UNKNOWN';
type ManagedEntityAccessEdgeClient = {
  upsert?: (args: unknown) => Promise<unknown>;
  updateMany?: (args: unknown) => Promise<unknown>;
};
type RosterPersistenceClient = Pick<
  Prisma.TransactionClient,
  | '$queryRaw'
  | 'chat'
  | 'chatAdminAllowlist'
  | 'chatBotMembership'
  | 'managedEntityAccessEdge'
  | 'managedEntityAdminMember'
>;
type PersistedRosterChanges = {
  adminUserIds: string[];
  removedUserIds: string[];
};
type BotAccessEpoch = {
  botId: string;
  accessState: ChatBotAccessState;
  probeStartedAt: Date;
};
type RosterAccessEpoch = BotAccessEpoch & {
  botRole: ManagedEntityAccessRoleValue;
};
type ResolvedRosterCandidates = {
  botIds: string[];
  completeEnoughForGlobalDeny: boolean;
};

class PendingBotAdminGrantError extends Error {
  constructor(readonly chatId: string) {
    super(`Bot admin access for chat ${chatId} is still propagating`);
  }
}

export class MaxChatAdminRosterSyncSourceBackoffError extends Error {
  constructor(
    readonly chatId: string,
    readonly delayMs: number,
  ) {
    super('MAX API managed_refresh source backoff active');
    this.name = 'MaxChatAdminRosterSyncSourceBackoffError';
  }
}

@Injectable()
export class MaxChatAdminRosterSyncService {
  private readonly logger = new Logger(MaxChatAdminRosterSyncService.name);
  private readonly managedRefreshSourceBackoffUntilMs = new Map<string, number>();
  private readonly terminalBotBackoffUntilMs = new Map<string, number>();
  private readonly nextActiveRosterObservationAt = new Map<string, number>();
  private activeRosterObservations = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly chatContextCache: ChatContextCacheService,
    @Optional()
    @InjectQueue(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE)
    private readonly queue?: Queue<MaxChatAdminRosterSyncJob>,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
    @Optional() private readonly metrics?: StorageRuntimeMetricsService,
  ) {}

  async observeActivity(
    chatId: string,
    botId?: string | null,
    observedCompleteAt?: string | null,
  ): Promise<void> {
    const normalizedChatId = chatId.trim();
    const normalizedBotId = this.resolveDiscoveryBotId(botId);
    if (!this.queue || !normalizedChatId || !normalizedBotId || isPrivateDirectChatId(chatId))
      return;
    const now = Date.now();
    const completedAt = observedCompleteAt ? Date.parse(observedCompleteAt) : Number.NaN;
    this.metrics?.optimization.rosterDemand(
      Number.isFinite(completedAt) ? 'refreshObserved' : 'bootstrapObserved',
    );
    if (
      (Number.isFinite(completedAt) &&
        completedAt <= now &&
        now - completedAt < ADMIN_ROSTER_ACTIVE_REFRESH_MS) ||
      (this.nextActiveRosterObservationAt.get(normalizedChatId) ?? 0) > now ||
      this.activeRosterObservations >= ACTIVE_ROSTER_OBSERVATION_CONCURRENCY
    ) {
      this.metrics?.optimization.rosterDemand('localDeferred');
      return;
    }
    this.nextActiveRosterObservationAt.delete(normalizedChatId);
    this.nextActiveRosterObservationAt.set(normalizedChatId, now + ADMIN_ROSTER_REFRESH_RETRY_MS);
    if (this.nextActiveRosterObservationAt.size > ACTIVE_ROSTER_OBSERVATION_MAX_KEYS) {
      const oldest = this.nextActiveRosterObservationAt.keys().next().value;
      if (oldest !== undefined) this.nextActiveRosterObservationAt.delete(oldest);
    }
    this.activeRosterObservations += 1;
    try {
      // FLAG: One SQL reservation across roles bounds refresh retries even after Redis loss.
      // No roster polling or network permission read runs in the message handler.
      if (!(await claimActiveAdminRosterRefresh(this.prisma, normalizedChatId, new Date(now)))) {
        this.metrics?.optimization.rosterDemand('reservationRefused');
        return;
      }
      const acknowledged = await this.scheduleChatAdminRosterSync({
        chatId: normalizedChatId,
        botIds: [normalizedBotId],
        entityType: 'chat',
        source: 'active_chat',
      });
      this.metrics?.optimization.rosterDemand(acknowledged ? 'acknowledged' : 'notAcknowledged');
    } catch (error: unknown) {
      this.metrics?.optimization.rosterDemand('failed');
      this.logger.debug(
        { chatId: normalizedChatId, err: error instanceof Error ? error.message : String(error) },
        'Active-chat administrator roster refresh deferred',
      );
    } finally {
      this.activeRosterObservations -= 1;
    }
  }

  async scheduleDiscoverySnapshotSync(chats: readonly MaxBotChat[]): Promise<void> {
    await this.mapWithConcurrencyLimit(
      [...chats],
      CHAT_ADMIN_ROSTER_DISCOVERY_SCHEDULE_CONCURRENCY,
      async (chat) =>
        this.scheduleChatAdminRosterSync({
          chatId: chat.chatId,
          botIds: chat.botIds ?? (chat.botId ? [chat.botId] : []),
          title: chat.title,
          entityType: chat.entityType,
          source: 'discovery_snapshot',
        }),
    );
  }

  async scheduleChatAdminRosterSync(params: MaxChatAdminRosterSyncJob): Promise<boolean> {
    // FLAG: Passive fleet snapshots and ordinary membership churn never renew rosters.
    // Explicit connection/recheck and a concrete missing-capability action retain demand.
    if (params.source === 'discovery_snapshot' || params.source === 'webhook_membership_churn')
      return false;
    if (!this.queue) return false;

    let desiredJobData = this.normalizeJobData(params);
    if (!desiredJobData) {
      return false;
    }

    const jobId = this.buildJobId(desiredJobData.chatId);
    const membershipPrewarm = desiredJobData.source === 'webhook_membership_churn';
    let followUp = false;

    try {
      if (desiredJobData.source === 'handshake_start') {
        return await handOffHandshakeRoster(this.queue, desiredJobData, {
          attempts: this.resolveJobAttempts(desiredJobData),
          priority: this.resolveJobPriority(desiredJobData),
          backoff: this.resolveJobBackoff(desiredJobData),
        });
      }
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        const existingData = this.normalizeJobData(existing.data);
        if (state !== 'failed' && state !== 'completed') {
          // FLAG: Optional daily refresh never replaces explicit connection or actor work.
          if (desiredJobData.source === 'active_chat') return true;
          // FLAG: Membership churn is only a best-effort prewarm. Any live exact-chat job is
          // stronger evidence and must never be replaced by this lower-priority refresh.
          if (membershipPrewarm) {
            return true;
          }
          if (state === 'active' && desiredJobData.source === 'webhook_bot_added') {
            // FLAG: A running pre-event probe cannot consume a new bot-added verification.
            followUp = true;
          } else if (existingData && this.areJobDataEqual(existingData, desiredJobData)) {
            return true;
          } else if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
            if (
              existingData?.source === 'webhook_bot_added' &&
              (existingData.retryUntilMs ?? 0) > Date.now()
            ) {
              desiredJobData = {
                ...desiredJobData,
                source: 'webhook_bot_added',
                retryUntilMs: Math.max(
                  existingData.retryUntilMs ?? 0,
                  desiredJobData.retryUntilMs ?? 0,
                ),
                botIds: [
                  ...new Set([...(existingData.botIds ?? []), ...(desiredJobData.botIds ?? [])]),
                ],
              };
            }
            await existing.remove();
          } else {
            return true;
          }
        } else {
          await existing.remove();
        }
      }

      if (
        (membershipPrewarm || desiredJobData.source === 'active_chat') &&
        !(await this.canAdmitMembershipChurnPrewarm())
      ) {
        return false;
      }

      await this.queue.add('sync-chat-admin-roster', desiredJobData, {
        jobId: followUp ? `${jobId}__${randomUUID()}` : jobId,
        ...(followUp
          ? { deduplication: { id: `${jobId}__bot_added`, keepLastIfActive: true } }
          : {}),
        attempts: this.resolveJobAttempts(desiredJobData),
        priority: this.resolveJobPriority(desiredJobData),
        removeOnComplete: true,
        removeOnFail: false,
        delay: this.resolveJobInitialDelayMs(desiredJobData),
        backoff: this.resolveJobBackoff(desiredJobData),
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        desiredJobData.source !== 'handshake_start' &&
        message.toLowerCase().includes('job') &&
        message.toLowerCase().includes('exists')
      ) {
        return true;
      }

      this.logger.warn(
        {
          chatId: desiredJobData.chatId,
          botIds: desiredJobData.botIds,
          err: message,
        },
        'Failed to enqueue chat admin roster sync job',
      );
      return false;
    }
  }

  async scheduleActorProbe(params: {
    chatId: string;
    botId: string;
    userId: string;
    requiredCheckedAfter: Date;
  }): Promise<boolean> {
    if (!this.queue || !this.resolveDiscoveryBotId(params.botId)) return false;
    const jobId = `managed-actor-${createHash('sha256')
      .update(
        JSON.stringify([
          params.chatId,
          params.botId,
          params.userId,
          params.requiredCheckedAfter.toISOString(),
        ]),
      )
      .digest('hex')}`;
    const existing = await this.queue.getJob(jobId);
    if (existing && (await existing.getState()) === 'failed') await existing.remove();
    await this.queue.add(
      'verify-managed-actor',
      {
        chatId: params.chatId,
        botIds: [params.botId],
        targetUserId: params.userId,
        requiredCheckedAfter: params.requiredCheckedAfter.toISOString(),
        source: 'admin_access_validation',
      },
      {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        priority: 2,
        removeOnComplete: true,
        removeOnFail: { age: 300, count: 1000 },
      },
    );
    return true;
  }

  async processJob(job: MaxChatAdminRosterSyncJob): Promise<boolean> {
    if (job.targetUserId) {
      const requiredCheckedAfter = new Date(job.requiredCheckedAfter ?? '');
      if (!Number.isFinite(requiredCheckedAfter.getTime()) || job.botIds?.length !== 1)
        throw new Error('Invalid personal access demand');
      return probeManagedEntityActor({
        prisma: this.prisma,
        maxClient: this.maxClient,
        cache: this.chatContextCache,
        chatId: job.chatId,
        botId: job.botIds[0]!,
        userId: job.targetUserId,
        requiredCheckedAfter,
      });
    }
    if (job.source === 'discovery_snapshot' || job.source === 'webhook_membership_churn')
      return false;
    return this.syncChatAdminRoster(job);
  }

  async backfillManagedEntitiesIndex(
    options: { bypassCache?: boolean; allowRemoteListBotChats?: boolean } = {},
  ): Promise<{
    discoveredChats: number;
    syncedChats: number;
  }> {
    const mergedByChatId =
      options.allowRemoteListBotChats === true
        ? await this.loadRemoteBackfillJobs(options)
        : await this.loadLocalBackfillJobs();

    let syncedChats = 0;
    for (const job of mergedByChatId.values()) {
      if (await this.syncChatAdminRoster(job)) {
        syncedChats += 1;
      }
    }

    return {
      discoveredChats: mergedByChatId.size,
      syncedChats,
    };
  }

  private async loadRemoteBackfillJobs(options: {
    bypassCache?: boolean;
  }): Promise<Map<string, MaxChatAdminRosterSyncJob>> {
    const mergedByChatId = new Map<string, MaxChatAdminRosterSyncJob>();
    for (const bot of this.maxBotRegistry.getDiscoveryBots()) {
      const chats = await this.maxClient.listBotChats({
        trafficClass: 'background',
        actionHealthLane: CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        timeoutMs: CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS,
        ...(options.bypassCache === true ? { bypassCache: true } : {}),
        botId: bot.id,
      });

      for (const chat of chats) {
        const existing = mergedByChatId.get(chat.chatId);
        const nextBotIds = Array.from(
          new Set([
            ...(existing?.botIds ?? []),
            ...(chat.botIds ?? []),
            ...(chat.botId ? [chat.botId] : []),
          ]),
        );
        mergedByChatId.set(chat.chatId, {
          chatId: chat.chatId,
          botIds: nextBotIds,
          title: existing?.title ?? chat.title,
          entityType: existing?.entityType ?? chat.entityType,
        });
      }
    }

    return mergedByChatId;
  }

  private async loadLocalBackfillJobs(): Promise<Map<string, MaxChatAdminRosterSyncJob>> {
    const mergedByChatId = new Map<string, MaxChatAdminRosterSyncJob>();
    let cursor: { chatId: string; botId: string } | null = null;

    while (true) {
      const memberships = await this.prisma.chatBotMembership.findMany({
        where: {
          status: ChatBotMembershipStatus.ACTIVE,
        },
        select: {
          chatId: true,
          botId: true,
          lastSeenAt: true,
          lastWebhookAt: true,
          chat: {
            select: {
              id: true,
              title: true,
              entityType: true,
              primaryBotId: true,
              botId: true,
            },
          },
        },
        orderBy: [{ chatId: 'asc' }, { botId: 'asc' }],
        take: LOCAL_BACKFILL_MEMBERSHIP_PAGE_SIZE,
        ...(cursor
          ? {
              cursor: {
                chatId_botId: cursor,
              },
              skip: 1,
            }
          : {}),
      });

      for (const membership of memberships) {
        const chatId = this.readTrimmedString(membership.chat.id);
        if (!chatId) {
          continue;
        }
        const entityType = this.fromPrismaEntityType(membership.chat.entityType);
        if (this.isUnsupportedManagedRosterSyncChat(chatId, entityType)) {
          continue;
        }

        const existing = mergedByChatId.get(chatId);
        const nextBotIds = Array.from(
          new Set(
            [
              ...(existing?.botIds ?? []),
              membership.botId,
              membership.chat.primaryBotId,
              membership.chat.botId,
            ]
              .map((botId) => this.resolveDiscoveryBotId(botId))
              .filter((botId): botId is string => Boolean(botId)),
          ),
        );
        if (nextBotIds.length === 0) {
          continue;
        }

        mergedByChatId.set(chatId, {
          chatId,
          botIds: nextBotIds,
          title: existing?.title ?? this.readTrimmedString(membership.chat.title),
          entityType: existing?.entityType ?? entityType,
          source: 'discovery_snapshot',
          retryUntilMs: null,
        });
      }

      if (memberships.length < LOCAL_BACKFILL_MEMBERSHIP_PAGE_SIZE) {
        break;
      }

      const lastMembership = memberships.at(-1);
      const lastChatId = this.readTrimmedString(lastMembership?.chatId);
      const lastBotId = this.readTrimmedString(lastMembership?.botId);
      if (!lastChatId || !lastBotId) {
        throw new Error('Managed entity membership backfill page ended without a valid cursor');
      }
      cursor = { chatId: lastChatId, botId: lastBotId };
    }

    return mergedByChatId;
  }

  private async syncChatAdminRoster(job: MaxChatAdminRosterSyncJob): Promise<boolean> {
    if (!this.metrics) return this.syncChatAdminRosterObserved(job);
    let state: RosterSyncState = 'unknown';
    try {
      // FLAG: One exact background-job lookup classifies bootstrap, not a fleet scan.
      // Missing diagnostics must never stop the existing synchronization procedure.
      const [row] = await this.prisma.$queryRaw<{ initialized: boolean }[]>(Prisma.sql`
        SELECT (completed_at IS NOT NULL AND complete_probe_started_at IS NOT NULL) AS initialized
        FROM chat_admin_roster_states WHERE chat_id = ${job.chatId}
      `);
      state = row?.initialized === true ? 'refresh' : 'bootstrap';
    } catch {
      /* Unknown coverage; preserve the job's existing behavior. */
    }
    this.metrics.optimization.rosterSync(state, 'calls');
    try {
      const completed = await this.syncChatAdminRosterObserved(job);
      this.metrics.optimization.rosterSync(state, completed ? 'completed' : 'notSynced');
      return completed;
    } catch (error) {
      this.metrics.optimization.rosterSync(
        state,
        error instanceof MaxChatAdminRosterSyncSourceBackoffError
          ? 'sourceBackoff'
          : error instanceof MaxApiInternalRateLimitError ||
              (error as { response?: { status?: unknown } } | null)?.response?.status === 429
            ? 'rateLimited'
            : 'failed',
      );
      throw error;
    }
  }

  private async syncChatAdminRosterObserved(job: MaxChatAdminRosterSyncJob): Promise<boolean> {
    const normalized = await this.buildMergedJobData(job);
    if (!normalized) {
      return false;
    }

    if (normalized.source !== 'active_chat') await this.persistCatalogBinding(normalized);

    const candidateResolution = await this.resolveCandidateBotIds(normalized);
    const candidateBotIds = candidateResolution.botIds;
    const deniedBotEpochs: BotAccessEpoch[] = [];
    let rosterAccess: {
      botId: string;
      access: { isAdmin: boolean; isOwner: boolean; permissions?: readonly string[] };
      probeStartedAt: Date;
    } | null = null;
    let recoverableError: unknown = null;
    let attemptedCandidate = false;
    let skippedDueToTerminalBackoff = false;
    let activationRequired = false;
    const requestedBotIds = new Set(
      (job.botIds ?? []).map((id) => this.resolveDiscoveryBotId(id)).filter(Boolean),
    );
    const checkedRequestedBotIds = new Set<string>();

    for (const botId of candidateBotIds) {
      // Targeted checks verify requested bots; peers are only a fallback roster reader.
      // A background refresh without explicit bots still renews the complete roster.
      if (
        rosterAccess &&
        requestedBotIds.size > 0 &&
        [...requestedBotIds].every((id) => checkedRequestedBotIds.has(id!))
      )
        break;
      const sourceBackoffDelayMs = await this.resolveManagedRefreshSourceBackoffDelayMs(
        normalized,
        botId,
      );
      if (sourceBackoffDelayMs > 0) {
        recoverableError ??= new MaxChatAdminRosterSyncSourceBackoffError(
          normalized.chatId,
          sourceBackoffDelayMs,
        );
        continue;
      }

      if (
        normalized.source !== 'webhook_bot_added' &&
        normalized.source !== 'handshake_start' &&
        this.isTerminalBotBackoffActive(normalized.chatId, botId)
      ) {
        skippedDueToTerminalBackoff = true;
        continue;
      }

      let accessProbeStartedAt: Date | null = null;
      try {
        attemptedCandidate = true;
        checkedRequestedBotIds.add(botId);
        const requestOptions = this.buildChatAdminRosterReadOptions(normalized, botId);
        accessProbeStartedAt = new Date();
        const access = await this.maxClient.getCurrentChatMemberAccess(
          normalized.chatId,
          requestOptions,
        );
        const persisted = await this.persistBotSelfAccessSnapshot(
          normalized,
          botId,
          access,
          accessProbeStartedAt,
        );
        if (!persisted) {
          recoverableError ??= new Error(
            `Bot access probe was superseded before roster sync persisted it (${botId})`,
          );
          continue;
        }

        if (!access.isAdmin && !access.isOwner) {
          deniedBotEpochs.push({
            botId,
            accessState: ChatBotAccessState.CONFIRMED_MEMBER,
            probeStartedAt: accessProbeStartedAt,
          });
          continue;
        }

        rosterAccess ??= { botId, access, probeStartedAt: accessProbeStartedAt };
      } catch (error: unknown) {
        // FLAG: Passive retries cannot satisfy explicit activation. Preserve the
        // exact bot's dormant state and try healthy peers without granting access,
        // clearing their roster, or treating a missing activation as propagation.
        if (error instanceof ManagedEntityActivationRequiredError) {
          activationRequired = true;
          this.markTerminalBotBackoff(normalized.chatId, botId);
          continue;
        }
        if (resolveExplicitMembershipAccessDenial(error) !== null) {
          if (!accessProbeStartedAt) {
            recoverableError ??= error;
            continue;
          }
          const persisted = await this.persistBotSelfAccessSnapshot(
            normalized,
            botId,
            null,
            accessProbeStartedAt,
          );
          if (!persisted) {
            recoverableError ??= new Error(
              `Bot access denial was superseded before roster sync persisted it (${botId})`,
            );
            continue;
          }
          deniedBotEpochs.push({
            botId,
            accessState: ChatBotAccessState.DENIED,
            probeStartedAt: accessProbeStartedAt,
          });
          this.markTerminalBotBackoff(normalized.chatId, botId);
          continue;
        }

        const backoffMs = managedRefreshBackoffMs(error);
        if (backoffMs !== null) {
          await this.markManagedRefreshSourceBackoff(botId, backoffMs);
          recoverableError ??= new MaxChatAdminRosterSyncSourceBackoffError(
            normalized.chatId,
            await this.resolveManagedRefreshSourceBackoffDelayMs(normalized, botId),
          );
          continue;
        }

        recoverableError ??= error;
      }
    }

    await this.reconcilePrimaryAfterSelfAccessRefresh(normalized);

    if (rosterAccess) {
      const roster = await this.maxClient.getChatAdminAccesses(
        normalized.chatId,
        this.buildChatAdminRosterReadOptions(normalized, rosterAccess.botId),
      );
      if (
        roster.some(
          (member) =>
            !member.userId ||
            typeof member.isBot !== 'boolean' ||
            !(member.isAdmin || member.isOwner) ||
            member.explicitPrivilegeEvidence !== true,
        )
      )
        throw new Error('Incomplete MAX administrator roster');
      const adminUserIds = roster
        .filter(
          (member) =>
            member.isBot === false &&
            member.explicitPrivilegeEvidence === true &&
            (member.isAdmin || member.isOwner),
        )
        .map((member) => member.userId!);
      const rosterPersisted = await this.syncAllowlist(normalized, adminUserIds, {
        botId: rosterAccess.botId,
        botRole: this.resolveManagedEntityAccessRole(rosterAccess.access),
        accessState: rosterAccess.access.isOwner
          ? ChatBotAccessState.CONFIRMED_OWNER
          : ChatBotAccessState.CONFIRMED_ADMIN,
        probeStartedAt: rosterAccess.probeStartedAt,
      });
      if (!rosterPersisted) {
        throw new Error(
          `Admin roster access epoch was superseded before sync completion (${rosterAccess.botId})`,
        );
      }
      await this.reconcileNightModeAfterConfirmedAccess(normalized.chatId, rosterAccess.botId);
    }

    if (recoverableError && !rosterAccess) {
      throw recoverableError;
    }

    if (recoverableError && rosterAccess) {
      this.logger.debug(
        {
          chatId: normalized.chatId,
          rosterBotId: rosterAccess.botId,
          error:
            recoverableError instanceof Error ? recoverableError.message : String(recoverableError),
        },
        'Completed roster sync through a confirmed bot while another bot probe remained recoverable',
      );
    }

    if (rosterAccess) {
      return true;
    }

    if (activationRequired && deniedBotEpochs.length === 0) return false;

    if (!attemptedCandidate && skippedDueToTerminalBackoff) {
      this.logger.debug(
        {
          chatId: normalized.chatId,
          botIds: candidateBotIds,
          source: normalized.source ?? null,
        },
        'Skipped chat admin roster sync because every candidate bot is in terminal backoff',
      );
      return false;
    }

    if (this.shouldRetryPendingAdminGrant(normalized)) {
      this.logger.log(
        {
          chatId: normalized.chatId,
          botIds: normalized.botIds,
          retryUntilMs: normalized.retryUntilMs ?? null,
          source: normalized.source ?? null,
        },
        'Retrying chat admin roster sync while fresh bot_added admin rights propagate',
      );
      throw new PendingBotAdminGrantError(normalized.chatId);
    }

    if (!candidateResolution.completeEnoughForGlobalDeny) {
      await this.recordIncompleteCandidateBotDeny(
        normalized.chatId,
        deniedBotEpochs.map((epoch) => epoch.botId),
      );
      return false;
    }

    const deniedBotIds = new Set(deniedBotEpochs.map((epoch) => epoch.botId));
    if (candidateBotIds.some((botId) => !deniedBotIds.has(botId))) {
      await this.recordIncompleteCandidateBotDeny(normalized.chatId, [...deniedBotIds]);
      return false;
    }

    const cleared = await this.clearAllowlist(normalized.chatId, 'bot_denied', deniedBotEpochs);
    if (!cleared) {
      throw new Error(
        `Bot denial epochs were superseded before roster cleanup (${normalized.chatId})`,
      );
    }
    return false;
  }

  private async buildMergedJobData(
    params: MaxChatAdminRosterSyncJob,
  ): Promise<MaxChatAdminRosterSyncJob | null> {
    const incoming = this.normalizeJobData(params);
    if (!incoming) {
      return null;
    }

    const persisted = await this.prisma.chat.findUnique({
      where: { id: incoming.chatId },
      select: {
        title: true,
        entityType: true,
        primaryBotId: true,
        botId: true,
        botMemberships: {
          where: {
            status: ChatBotMembershipStatus.ACTIVE,
          },
          select: {
            botId: true,
          },
        },
      },
    });

    const mergedBotIds = Array.from(
      new Set(
        [
          ...(incoming.botIds ?? []),
          this.resolveDiscoveryBotId(persisted?.primaryBotId),
          this.resolveDiscoveryBotId(persisted?.botId),
          ...((persisted?.botMemberships ?? []).map((membership) =>
            this.resolveDiscoveryBotId(membership.botId),
          ) as Array<string | null>),
        ].filter((botId): botId is string => Boolean(botId)),
      ),
    );

    return {
      chatId: incoming.chatId,
      botIds: mergedBotIds,
      title:
        observedManagedEntityTitle(incoming.chatId, incoming.title) ??
        this.readTrimmedString(persisted?.title) ??
        null,
      entityType: incoming.entityType ?? this.fromPrismaEntityType(persisted?.entityType),
      source: incoming.source ?? null,
      retryUntilMs: incoming.retryUntilMs ?? null,
    };
  }

  private normalizeJobData(
    params: MaxChatAdminRosterSyncJob | null | undefined,
  ): MaxChatAdminRosterSyncJob | null {
    const chatId = this.readTrimmedString(params?.chatId);
    if (!chatId) {
      return null;
    }

    const botIds = Array.from(
      new Set(
        (params?.botIds ?? [])
          .map((botId) => this.resolveDiscoveryBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const entityType =
      params?.entityType === 'channel' ? 'channel' : params?.entityType === 'chat' ? 'chat' : null;
    const source =
      params?.source === 'webhook_bot_added' ||
      params?.source === 'webhook_bot_removed' ||
      params?.source === 'webhook_chat_title_changed' ||
      params?.source === 'webhook_membership_churn' ||
      params?.source === 'handshake_start' ||
      params?.source === 'moderation_destructive_path' ||
      params?.source === 'admin_access_validation' ||
      params?.source === 'active_chat' ||
      params?.source === 'discovery_snapshot'
        ? params.source
        : null;
    const retryUntilMs =
      typeof params?.retryUntilMs === 'number' && Number.isFinite(params.retryUntilMs)
        ? Math.max(0, Math.trunc(params.retryUntilMs))
        : null;
    if (this.isUnsupportedManagedRosterSyncChat(chatId, entityType)) {
      return null;
    }

    return {
      chatId,
      botIds,
      title: this.readTrimmedString(params?.title) ?? null,
      entityType,
      source,
      retryUntilMs,
    };
  }

  private isUnsupportedManagedRosterSyncChat(
    chatId: string,
    entityType: 'chat' | 'channel' | null,
  ): boolean {
    return entityType !== 'channel' && isPrivateDirectChatId(chatId);
  }

  private areJobDataEqual(
    left: MaxChatAdminRosterSyncJob,
    right: MaxChatAdminRosterSyncJob,
  ): boolean {
    return (
      left.chatId === right.chatId &&
      (left.title ?? null) === (right.title ?? null) &&
      (left.entityType ?? null) === (right.entityType ?? null) &&
      (left.source ?? null) === (right.source ?? null) &&
      this.areRetryUntilMsEquivalent(left, right) &&
      left.botIds?.length === right.botIds?.length &&
      (left.botIds ?? []).every((botId, index) => botId === (right.botIds ?? [])[index])
    );
  }

  private areRetryUntilMsEquivalent(
    left: MaxChatAdminRosterSyncJob,
    right: MaxChatAdminRosterSyncJob,
  ): boolean {
    const leftRetryUntilMs = left.retryUntilMs ?? null;
    const rightRetryUntilMs = right.retryUntilMs ?? null;
    if (leftRetryUntilMs === rightRetryUntilMs) {
      return true;
    }

    if (
      left.source === 'webhook_bot_added' &&
      right.source === 'webhook_bot_added' &&
      typeof leftRetryUntilMs === 'number' &&
      typeof rightRetryUntilMs === 'number'
    ) {
      return (
        Math.abs(leftRetryUntilMs - rightRetryUntilMs) <=
        CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_RETRY_UNTIL_TOLERANCE_MS
      );
    }

    return false;
  }

  private buildJobId(chatId: string): string {
    return `chat-admin-roster-sync__${chatId}`;
  }

  private async resolveCandidateBotIds(
    job: MaxChatAdminRosterSyncJob,
  ): Promise<ResolvedRosterCandidates> {
    const discoveryBotIds = Array.from(
      new Set(
        this.maxBotRegistry
          .getDiscoveryBots()
          .map((bot) => this.resolveDiscoveryBotId(bot.id))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const resolved = new Set(
      (job.botIds ?? [])
        .map((botId) => this.resolveDiscoveryBotId(botId))
        .filter((botId): botId is string => Boolean(botId)),
    );
    let loadedPersistedCandidates = false;

    if (resolved.size === 0) {
      const persisted = await this.prisma.chat.findUnique({
        where: { id: job.chatId },
        select: {
          primaryBotId: true,
          botId: true,
          botMemberships: {
            where: {
              status: ChatBotMembershipStatus.ACTIVE,
            },
            select: {
              botId: true,
            },
          },
        },
      });
      loadedPersistedCandidates = true;

      for (const botId of [
        this.resolveDiscoveryBotId(persisted?.primaryBotId),
        this.resolveDiscoveryBotId(persisted?.botId),
        ...((persisted?.botMemberships ?? []).map((membership) =>
          this.resolveDiscoveryBotId(membership.botId),
        ) as Array<string | null>),
      ]) {
        if (botId) {
          resolved.add(botId);
        }
      }
    }

    if (resolved.size === 0) {
      for (const botId of discoveryBotIds) {
        resolved.add(botId);
      }
    }

    return {
      botIds: [...resolved],
      completeEnoughForGlobalDeny:
        discoveryBotIds.length > 0
          ? discoveryBotIds.every((botId) => resolved.has(botId))
          : loadedPersistedCandidates,
    };
  }

  private async persistCatalogBinding(job: MaxChatAdminRosterSyncJob): Promise<void> {
    const entityType = this.toPrismaEntityType(job.entityType);
    if (!entityType && !this.readTrimmedString(job.title) && (job.botIds?.length ?? 0) === 0) {
      return;
    }

    try {
      await this.maxBotLinkService.bindDiscoveredChatBots({
        chatId: job.chatId,
        primaryBotId: job.botIds?.[0] ?? null,
        botIds: job.botIds ?? [],
        title: job.title ?? null,
        entityType,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: job.chatId,
          botIds: job.botIds,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist discovered chat catalog binding before admin roster sync',
      );
    }
  }

  private async syncAllowlist(
    job: MaxChatAdminRosterSyncJob,
    adminUserIds: readonly string[],
    accessContext: RosterAccessEpoch,
  ): Promise<boolean> {
    const chatId = job.chatId;
    const normalizedAdminUserIds = Array.from(
      new Set(
        adminUserIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const remoteAdminUserIdByIdentity = new Map<string, string>();
    for (const userId of normalizedAdminUserIds) {
      const identityKey = this.buildUserIdIdentityKey(userId);
      if (identityKey && !remoteAdminUserIdByIdentity.has(identityKey)) {
        remoteAdminUserIdByIdentity.set(identityKey, userId);
      }
    }
    const persisted = await this.prisma.$transaction(
      async (tx): Promise<PersistedRosterChanges | null> => {
        const lockedChat = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "chats" AS chat
          WHERE chat."id" = ${chatId}
          FOR UPDATE OF chat
        `);
        if (lockedChat.length !== 1) {
          return null;
        }

        // FLAG: Roster grants are valid only for the exact probe epoch under parent-first locks.
        const lockedMembership = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT membership."id"
          FROM "chat_bot_memberships" AS membership
          WHERE membership."chat_id" = ${chatId}
            AND membership."bot_id" = ${accessContext.botId}
          LIMIT 1
          FOR UPDATE OF membership
        `);
        if (lockedMembership.length !== 1) {
          return null;
        }

        const membership = await tx.chatBotMembership.findUnique({
          where: {
            chatId_botId: {
              chatId,
              botId: accessContext.botId,
            },
          },
          select: {
            status: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessSource: true,
            lifecycleEventAt: true,
            lifecycleEventType: true,
            lifecycleSource: true,
          },
        });
        if (!this.isAcceptedBotAccessEpoch(membership, accessContext)) {
          return null;
        }

        if (await hasNewerCompleteAdminRoster(tx, chatId, accessContext.probeStartedAt)) {
          return null;
        }

        const existingRows = await tx.chatAdminAllowlist.findMany({
          where: { chatId },
          select: { userId: true },
        });
        const existingUserIds = new Set(
          existingRows
            .map((row) => this.readTrimmedString(row.userId))
            .filter((userId): userId is string => Boolean(userId)),
        );
        const existingUserIdByIdentity = new Map<string, string>();
        for (const userId of existingUserIds) {
          const identityKey = this.buildUserIdIdentityKey(userId);
          if (identityKey && !existingUserIdByIdentity.has(identityKey)) {
            existingUserIdByIdentity.set(identityKey, userId);
          }
        }
        const candidateUserIds = Array.from(
          new Set([...normalizedAdminUserIds, ...existingUserIds]),
        );
        const identitiesByVariant = new Map<string, Set<string>>();
        for (const userId of candidateUserIds) {
          const identityKey = this.buildUserIdIdentityKey(userId);
          if (!identityKey) {
            continue;
          }
          for (const variant of this.buildUserIdVariants(userId)) {
            const identities = identitiesByVariant.get(variant) ?? new Set<string>();
            identities.add(identityKey);
            identitiesByVariant.set(variant, identities);
          }
        }
        const variants = [...identitiesByVariant.keys()];
        const accessEvidenceUserIds = Array.from(new Set([...candidateUserIds, ...variants]));
        const [membershipEvents, newerAccessEdges, newerAdminMembers] = await Promise.all([
          variants.length > 0
            ? tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
                SELECT DISTINCT activity."user_id" AS "userId"
                FROM "chat_membership_activity_events" AS activity
                WHERE activity."chat_id" = ${chatId}
                  AND activity."user_id" IN (${Prisma.join(variants)})
                  AND activity."event_type" IN ('user_added', 'user_removed')
                  AND activity."event_at" >= ${accessContext.probeStartedAt}
              `)
            : Promise.resolve([]),
          tx.managedEntityAccessEdge.findMany({
            where: {
              chatId,
              userId: { in: accessEvidenceUserIds },
              botId: { in: this.maxBotRegistry.getDiscoveryBots().map((bot) => bot.id) },
              checkedAt: { gt: accessContext.probeStartedAt },
            },
            select: { userId: true },
          }),
          tx.managedEntityAdminMember.findMany({
            where: {
              chatId,
              userId: { in: accessEvidenceUserIds },
              checkedAt: { gt: accessContext.probeStartedAt },
            },
            select: { userId: true },
          }),
        ]);
        const protectedIdentityKeys = new Set<string>();
        for (const row of [...membershipEvents, ...newerAccessEdges, ...newerAdminMembers]) {
          const normalizedUserId = this.readTrimmedString(row.userId)?.toLowerCase();
          if (!normalizedUserId) {
            continue;
          }
          for (const identityKey of identitiesByVariant.get(normalizedUserId) ?? []) {
            protectedIdentityKeys.add(identityKey);
          }
        }
        const grantCandidates = [...remoteAdminUserIdByIdentity.entries()]
          .filter(([identityKey]) => !protectedIdentityKeys.has(identityKey))
          .map(([identityKey, remoteUserId]) => ({
            identityKey,
            userId: existingUserIdByIdentity.get(identityKey) ?? remoteUserId,
          }));
        const usersToGrant = grantCandidates.map((candidate) => candidate.userId);
        const usersToAdd = grantCandidates
          .filter((candidate) => !existingUserIdByIdentity.has(candidate.identityKey))
          .map((candidate) => candidate.userId);
        const usersToRemove = [...existingUserIds].filter((userId) => {
          const identityKey = this.buildUserIdIdentityKey(userId);
          return Boolean(
            identityKey &&
            !remoteAdminUserIdByIdentity.has(identityKey) &&
            !protectedIdentityKeys.has(identityKey),
          );
        });
        const source = job.source ?? 'admin_roster_sync';

        if (usersToAdd.length > 0) {
          await tx.chatAdminAllowlist.createMany({
            data: usersToAdd.map((userId) => ({ chatId, userId })),
            skipDuplicates: true,
          });
        }
        if (usersToRemove.length > 0) {
          await tx.chatAdminAllowlist.deleteMany({
            where: {
              chatId,
              userId: { in: usersToRemove },
            },
          });
        }

        await this.upsertManagedEntityAccessEdges(
          {
            chatId,
            userIds: usersToGrant,
            botId: accessContext.botId,
            entityType: job.entityType ?? null,
            state: 'GRANTED',
            userRole: 'ADMIN',
            botRole: accessContext.botRole,
            source,
            checkedAt: accessContext.probeStartedAt,
          },
          tx,
        );
        await this.upsertManagedEntityAdminMembers(
          {
            chatId,
            userIds: usersToGrant,
            botId: accessContext.botId,
            entityType: job.entityType ?? null,
            role: 'ADMIN',
            source,
            checkedAt: accessContext.probeStartedAt,
          },
          tx,
        );
        await this.markManagedEntityAccessEdgesDenied(
          {
            chatId,
            userIds: usersToRemove,
            botId: accessContext.botId,
            state: 'USER_DENIED',
            deniedReason: 'user_removed_from_admin_roster',
            source,
            checkedAt: accessContext.probeStartedAt,
          },
          tx,
        );
        await this.expireManagedEntityAdminMembers(
          {
            chatId,
            userIds: usersToRemove,
            botId: accessContext.botId,
            source,
            checkedAt: accessContext.probeStartedAt,
          },
          tx,
        );

        if (!this.isUnsupportedManagedRosterSyncChat(chatId, job.entityType ?? null)) {
          const entityType = job.entityType ? this.toPrismaEntityType(job.entityType) : null;
          await tx.chat.update({
            where: { id: chatId },
            data: {
              catalogKind: ChatCatalogKind.MANAGED,
              ...(entityType ? { entityType } : {}),
            },
          });
        }

        await completeAdminRoster(tx, chatId, accessContext.probeStartedAt);
        return {
          adminUserIds: usersToGrant,
          removedUserIds: usersToRemove,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (!persisted) {
      return false;
    }
    // FLAG: A successful unchanged/empty roster also updates completeness in cached contexts.
    await this.chatContextCache.invalidate(chatId);
    return this.publishRosterCachesForAcceptedEpoch(job, accessContext, persisted);
  }

  private isAcceptedBotAccessEpoch(
    membership: {
      status: ChatBotMembershipStatus;
      botAccessState: ChatBotAccessState;
      botAccessCheckedAt: Date | null;
      botAccessSource: string | null;
      lifecycleEventAt: Date | null;
      lifecycleEventType: string | null;
      lifecycleSource: string | null;
    } | null,
    accessContext: BotAccessEpoch,
  ): boolean {
    if (
      !membership ||
      membership.status !== ChatBotMembershipStatus.ACTIVE ||
      membership.botAccessState !== accessContext.accessState ||
      membership.botAccessCheckedAt?.getTime() !== accessContext.probeStartedAt.getTime() ||
      membership.botAccessSource !== 'admin_roster_sync'
    ) {
      return false;
    }

    const lifecycleEventAt = membership.lifecycleEventAt;
    if (!lifecycleEventAt || lifecycleEventAt.getTime() < accessContext.probeStartedAt.getTime()) {
      return true;
    }
    return (
      lifecycleEventAt.getTime() === accessContext.probeStartedAt.getTime() &&
      membership.lifecycleEventType === 'live_probe' &&
      membership.lifecycleSource === 'live_probe'
    );
  }

  private async publishRosterCachesForAcceptedEpoch(
    job: MaxChatAdminRosterSyncJob,
    accessContext: RosterAccessEpoch,
    persisted: PersistedRosterChanges,
  ): Promise<boolean> {
    const cacheMutationUsers = await this.prisma.$transaction(
      async (tx) => {
        // FLAG: Resolve current cache intent under the parent lock, then release SQL before Redis.
        const lockedChat = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "chats" AS chat
          WHERE chat."id" = ${job.chatId}
          FOR UPDATE OF chat
        `);
        if (lockedChat.length !== 1) {
          return null;
        }
        const lockedMembership = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT membership."id"
          FROM "chat_bot_memberships" AS membership
          WHERE membership."chat_id" = ${job.chatId}
            AND membership."bot_id" = ${accessContext.botId}
          LIMIT 1
          FOR UPDATE OF membership
        `);
        if (lockedMembership.length !== 1) {
          return null;
        }

        const membership = await tx.chatBotMembership.findUnique({
          where: {
            chatId_botId: {
              chatId: job.chatId,
              botId: accessContext.botId,
            },
          },
          select: {
            status: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessSource: true,
            lifecycleEventAt: true,
            lifecycleEventType: true,
            lifecycleSource: true,
          },
        });
        if (!this.isAcceptedBotAccessEpoch(membership, accessContext)) {
          return null;
        }

        const userIds = Array.from(
          new Set([...persisted.adminUserIds, ...persisted.removedUserIds]),
        );
        const [allowlistRows, newerGrantedEdges, newerAdminMembers] = await Promise.all([
          tx.chatAdminAllowlist.findMany({
            where: { chatId: job.chatId, userId: { in: userIds } },
            select: { userId: true },
          }),
          tx.managedEntityAccessEdge.findMany({
            where: {
              chatId: job.chatId,
              userId: { in: persisted.removedUserIds },
              botId: { in: this.maxBotRegistry.getDiscoveryBots().map((bot) => bot.id) },
              state: 'GRANTED',
              checkedAt: { gt: accessContext.probeStartedAt },
            },
            select: { userId: true },
          }),
          tx.managedEntityAdminMember.findMany({
            where: {
              chatId: job.chatId,
              userId: { in: persisted.removedUserIds },
              checkedAt: { gt: accessContext.probeStartedAt },
            },
            select: { userId: true },
          }),
        ]);
        const allowlisted = new Set(allowlistRows.map((row) => row.userId));
        const newerEvidence = new Set([
          ...newerGrantedEdges.map((row) => row.userId),
          ...newerAdminMembers.map((row) => row.userId),
        ]);
        return {
          grantedUserIds: persisted.adminUserIds.filter((userId) => allowlisted.has(userId)),
          deniedUserIds: persisted.removedUserIds.filter(
            (userId) => !allowlisted.has(userId) && !newerEvidence.has(userId),
          ),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 15_000,
      },
    );
    if (!cacheMutationUsers) {
      return false;
    }

    const snapshotChat = await this.loadManagedEntitySnapshotPatchChat(
      job.chatId,
      job.entityType ?? null,
      job.title ?? null,
    );
    const summary = snapshotChat
      ? await this.buildManagedEntitySnapshotPatchSummary(snapshotChat)
      : null;
    await this.mapWithConcurrencyLimit(
      cacheMutationUsers.grantedUserIds,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
      async (userId) => {
        await this.chatContextCache.applyAdminAccessEpochMutation({
          chatId: job.chatId,
          userId,
          state: 'granted',
          eventAt: accessContext.probeStartedAt,
          ...(summary
            ? {
                publishedSummary: summary,
                publishedSnapshotTtlSec: MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
              }
            : {}),
        });
        return null;
      },
    );
    await this.mapWithConcurrencyLimit(
      cacheMutationUsers.deniedUserIds,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
      async (userId) => {
        await this.chatContextCache.applyAdminAccessEpochMutation({
          chatId: job.chatId,
          userId,
          state: 'user_denied',
          eventAt: accessContext.probeStartedAt,
        });
        return null;
      },
    );
    return true;
  }

  private async clearAllowlist(
    chatId: string,
    deniedState: 'user_denied' | 'bot_denied',
    denialEpochs: readonly BotAccessEpoch[],
  ): Promise<boolean> {
    if (denialEpochs.length === 0) {
      return false;
    }

    const denialAt = new Date(
      Math.max(...denialEpochs.map((epoch) => epoch.probeStartedAt.getTime())),
    );
    const deniedUserIds = await this.prisma.$transaction(
      async (tx) => {
        const lockedChat = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "chats" AS chat
          WHERE chat."id" = ${chatId}
          FOR UPDATE OF chat
        `);
        if (lockedChat.length !== 1) {
          return null;
        }

        // FLAG: Global denial is valid only while every candidate denial epoch stays current.
        const lockedMemberships = await tx.$queryRaw<
          Array<{ botId: string; status: ChatBotMembershipStatus }>
        >(Prisma.sql`
          SELECT membership."bot_id" AS "botId", membership."status"
          FROM "chat_bot_memberships" AS membership
          WHERE membership."chat_id" = ${chatId}
          ORDER BY membership."bot_id" ASC, membership."id" ASC
          FOR UPDATE OF membership
        `);
        const deniedBotIds = new Set(denialEpochs.map((epoch) => epoch.botId));
        const lockedBotIds = new Set(lockedMemberships.map((membership) => membership.botId));
        const hasNewActiveCandidate = lockedMemberships.some(
          (membership) =>
            membership.status === ChatBotMembershipStatus.ACTIVE &&
            this.resolveDiscoveryBotId(membership.botId) !== null &&
            !deniedBotIds.has(membership.botId),
        );
        if (denialEpochs.some((epoch) => !lockedBotIds.has(epoch.botId)) || hasNewActiveCandidate) {
          return null;
        }

        for (const denialEpoch of denialEpochs) {
          const membership = await tx.chatBotMembership.findUnique({
            where: {
              chatId_botId: {
                chatId,
                botId: denialEpoch.botId,
              },
            },
            select: {
              status: true,
              botAccessState: true,
              botAccessCheckedAt: true,
              botAccessSource: true,
              lifecycleEventAt: true,
              lifecycleEventType: true,
              lifecycleSource: true,
            },
          });
          if (!this.isAcceptedBotAccessEpoch(membership, denialEpoch)) {
            return null;
          }
        }

        const existingRows = await tx.chatAdminAllowlist.findMany({
          where: { chatId },
          select: { userId: true },
        });
        const existingUserIds = Array.from(
          new Set(
            existingRows
              .map((row) => this.readTrimmedString(row.userId))
              .filter((userId): userId is string => Boolean(userId)),
          ),
        );
        const [newerGrantedEdges, newerAdminMembers] = await Promise.all([
          tx.managedEntityAccessEdge.findMany({
            where: {
              chatId,
              userId: { in: existingUserIds },
              state: 'GRANTED',
              checkedAt: { gt: denialAt },
            },
            select: { userId: true },
          }),
          tx.managedEntityAdminMember.findMany({
            where: {
              chatId,
              userId: { in: existingUserIds },
              checkedAt: { gt: denialAt },
            },
            select: { userId: true },
          }),
        ]);
        const protectedUserIds = new Set([
          ...newerGrantedEdges.map((row) => row.userId),
          ...newerAdminMembers.map((row) => row.userId),
        ]);
        const usersToDeny = existingUserIds.filter((userId) => !protectedUserIds.has(userId));
        if (usersToDeny.length > 0) {
          await tx.chatAdminAllowlist.deleteMany({
            where: {
              chatId,
              userId: { in: usersToDeny },
            },
          });
        }
        await this.markManagedEntityAccessEdgesDenied(
          {
            chatId,
            userIds: usersToDeny,
            state: deniedState === 'user_denied' ? 'USER_DENIED' : 'BOT_DENIED',
            deniedReason: deniedState,
            source: 'admin_roster_sync_clear',
            checkedAt: denialAt,
          },
          tx,
        );
        await this.expireManagedEntityAdminMembers(
          {
            chatId,
            userIds: usersToDeny,
            source: 'admin_roster_sync_clear',
            checkedAt: denialAt,
          },
          tx,
        );

        await invalidateAdminRosterCompleteness(tx, chatId);
        return usersToDeny;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 15_000,
      },
    );
    if (!deniedUserIds) {
      return false;
    }
    await this.chatContextCache.invalidate(chatId);
    await this.mapWithConcurrencyLimit(
      deniedUserIds,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
      async (userId) => {
        await this.chatContextCache.applyAdminAccessEpochMutation({
          chatId,
          userId,
          state: deniedState,
          eventAt: denialAt,
        });
        return null;
      },
    );
    return true;
  }

  private async recordIncompleteCandidateBotDeny(
    chatId: string,
    candidateBotIds: readonly string[],
  ): Promise<void> {
    const botIds = Array.from(
      new Set(
        candidateBotIds
          .map((botId) => this.resolveDiscoveryBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    if (botIds.length === 0) {
      return;
    }

    await this.chatContextCache.clearManagedEntitiesRecentBootstrapForChat?.(chatId, null);
  }

  private shouldRetryPendingAdminGrant(job: MaxChatAdminRosterSyncJob): boolean {
    return (
      job.source === 'webhook_bot_added' &&
      typeof job.retryUntilMs === 'number' &&
      Number.isFinite(job.retryUntilMs) &&
      job.retryUntilMs > Date.now()
    );
  }

  private getManagedEntityAccessEdgeClient(
    persistenceClient: PrismaService | RosterPersistenceClient = this.prisma,
  ): ManagedEntityAccessEdgeClient | null {
    const client = (persistenceClient as unknown as { managedEntityAccessEdge?: unknown })
      .managedEntityAccessEdge;
    if (!client || typeof client !== 'object') {
      return null;
    }

    const candidate = client as ManagedEntityAccessEdgeClient;
    return typeof candidate.upsert === 'function' || typeof candidate.updateMany === 'function'
      ? candidate
      : null;
  }

  private async upsertManagedEntityAdminMembers(
    params: {
      chatId: string;
      userIds: readonly string[];
      botId: string;
      entityType: ManagedEntityType | null;
      role: Exclude<ManagedEntityAccessRoleValue, 'MEMBER' | 'UNKNOWN'>;
      source: string;
      checkedAt?: Date;
    },
    persistenceClient: PrismaService | RosterPersistenceClient = this.prisma,
  ): Promise<void> {
    if (!params.entityType) {
      return;
    }

    const client = (
      persistenceClient as (PrismaService | RosterPersistenceClient) & {
        managedEntityAdminMember?: {
          upsert?: (args: unknown) => Promise<unknown>;
        };
      }
    ).managedEntityAdminMember;
    if (typeof client?.upsert !== 'function') {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const botId =
      this.maxBotRegistry.getBotById(params.botId)?.id ?? this.readTrimmedString(params.botId);
    if (!chatId || !botId) {
      return;
    }

    const userIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const now = params.checkedAt ?? new Date();
    const expiresAt = new Date(now.getTime() + MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS);
    await this.mapWithConcurrencyLimit(
      userIds,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
      async (userId) => {
        await client.upsert?.({
          where: {
            chatId_userId_observedByBotId: {
              chatId,
              userId,
              observedByBotId: botId,
            },
          },
          create: {
            chatId,
            userId,
            observedByBotId: botId,
            entityType: this.toPrismaEntityType(params.entityType),
            role: params.role,
            permissions: [],
            checkedAt: now,
            expiresAt,
            source: params.source,
          },
          update: {
            entityType: this.toPrismaEntityType(params.entityType),
            role: params.role,
            checkedAt: now,
            expiresAt,
            source: params.source,
          },
        });
        return null;
      },
    );
  }

  private async expireManagedEntityAdminMembers(
    params: {
      chatId: string;
      userIds: readonly string[];
      botId?: string | null;
      source: string;
      checkedAt?: Date;
    },
    persistenceClient: PrismaService | RosterPersistenceClient = this.prisma,
  ): Promise<void> {
    const client = (
      persistenceClient as (PrismaService | RosterPersistenceClient) & {
        managedEntityAdminMember?: {
          updateMany?: (args: unknown) => Promise<unknown>;
        };
      }
    ).managedEntityAdminMember;
    if (typeof client?.updateMany !== 'function') {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const userIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    if (!chatId || userIds.length === 0) {
      return;
    }

    const botId = params.botId
      ? (this.maxBotRegistry.getBotById(params.botId)?.id ?? this.readTrimmedString(params.botId))
      : null;
    const checkedAt = params.checkedAt ?? new Date();
    await client.updateMany({
      where: {
        chatId,
        userId: {
          in: userIds,
        },
        ...(botId ? { observedByBotId: botId } : {}),
        checkedAt: { lte: checkedAt },
      },
      data: {
        expiresAt: checkedAt,
        source: params.source,
      },
    });
  }

  private resolveManagedEntityAccessRole(access: {
    isAdmin?: boolean;
    isOwner?: boolean;
  }): ManagedEntityAccessRoleValue {
    if (access.isOwner === true) {
      return 'OWNER';
    }
    if (access.isAdmin === true) {
      return 'ADMIN';
    }
    return 'MEMBER';
  }

  private async upsertManagedEntityAccessEdges(
    params: {
      chatId: string;
      userIds: readonly string[];
      botId: string;
      entityType: ManagedEntityType | null;
      state: 'GRANTED';
      userRole: ManagedEntityAccessRoleValue;
      botRole: ManagedEntityAccessRoleValue;
      source: string;
      checkedAt?: Date;
    },
    persistenceClient: PrismaService | RosterPersistenceClient = this.prisma,
  ): Promise<void> {
    const client = this.getManagedEntityAccessEdgeClient(persistenceClient);
    if (!client?.upsert || !params.entityType) {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const botId =
      this.maxBotRegistry.getBotById(params.botId)?.id ?? this.readTrimmedString(params.botId);
    if (!chatId || !botId) {
      return;
    }

    const userIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const now = params.checkedAt ?? new Date();
    const expiresAt = new Date(now.getTime() + MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS);
    await this.mapWithConcurrencyLimit(
      userIds,
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_PATCH_CONCURRENCY,
      async (userId) => {
        await client.upsert?.({
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
            entityType: this.toPrismaEntityType(params.entityType),
            state: params.state,
            userRole: params.userRole,
            botRole: params.botRole,
            checkedAt: now,
            expiresAt,
            deniedReason: null,
            lastMaxErrorCode: null,
            lastMaxErrorMessage: null,
            lastMaxStatusCode: null,
            source: params.source,
          },
          update: {
            entityType: this.toPrismaEntityType(params.entityType),
            state: params.state,
            userRole: params.userRole,
            botRole: params.botRole,
            checkedAt: now,
            expiresAt,
            deniedReason: null,
            lastMaxErrorCode: null,
            lastMaxErrorMessage: null,
            lastMaxStatusCode: null,
            source: params.source,
          },
        });
        return null;
      },
    );
  }

  private async markManagedEntityAccessEdgesDenied(
    params: {
      chatId: string;
      userIds: readonly string[];
      botId?: string | null;
      state: 'USER_DENIED' | 'BOT_DENIED';
      deniedReason: string;
      source: string;
      checkedAt?: Date;
    },
    persistenceClient: PrismaService | RosterPersistenceClient = this.prisma,
  ): Promise<void> {
    const client = this.getManagedEntityAccessEdgeClient(persistenceClient);
    if (!client?.updateMany) {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const userIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    if (!chatId || userIds.length === 0) {
      return;
    }

    const botId = params.botId
      ? (this.maxBotRegistry.getBotById(params.botId)?.id ?? this.readTrimmedString(params.botId))
      : null;
    const checkedAt = params.checkedAt ?? new Date();
    await client.updateMany({
      where: {
        chatId,
        userId: {
          in: userIds,
        },
        // FLAG: An exhausted moderation roster is not evidence about the Publisher token.
        botId: botId ? botId : { in: this.maxBotRegistry.getDiscoveryBots().map((bot) => bot.id) },
        checkedAt: { lte: checkedAt },
      },
      data: {
        state: params.state,
        userRole: params.state === 'USER_DENIED' ? 'MEMBER' : 'UNKNOWN',
        botRole: params.state === 'BOT_DENIED' ? 'MEMBER' : 'UNKNOWN',
        checkedAt,
        expiresAt: null,
        deniedReason: params.deniedReason,
        source: params.source,
      },
    });
  }

  private resolveJobAttempts(job: MaxChatAdminRosterSyncJob): number {
    if (job.source === 'webhook_bot_added') {
      return CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_ATTEMPTS;
    }

    if (
      job.source === 'webhook_membership_churn' ||
      job.source === 'handshake_start' ||
      job.source === 'moderation_destructive_path' ||
      job.source === 'admin_access_validation'
    ) {
      return CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_ATTEMPTS;
    }

    return 5;
  }

  private resolveJobPriority(job: MaxChatAdminRosterSyncJob): number {
    if (job.source === 'active_chat') return CHAT_ADMIN_ROSTER_SYNC_DEFAULT_PRIORITY + 10;
    if (job.source === 'webhook_bot_added') {
      return CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_PRIORITY;
    }

    if (
      job.source === 'handshake_start' ||
      job.source === 'moderation_destructive_path' ||
      job.source === 'admin_access_validation'
    ) {
      return CHAT_ADMIN_ROSTER_SYNC_ACCESS_CRITICAL_PRIORITY;
    }

    return CHAT_ADMIN_ROSTER_SYNC_DEFAULT_PRIORITY;
  }

  private async canAdmitMembershipChurnPrewarm(): Promise<boolean> {
    if (!this.queue) {
      return false;
    }

    try {
      const counts = await this.queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active');
      const pending = ['waiting', 'prioritized', 'delayed', 'active'].reduce(
        (total, state) => total + (counts[state] ?? 0),
        0,
      );
      return pending < CHAT_ADMIN_ROSTER_SYNC_MEMBERSHIP_PREWARM_MAX_PENDING;
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Unable to inspect chat admin roster prewarm queue depth; dropping optional prewarm',
      );
      return false;
    }
  }

  private resolveJobInitialDelayMs(job: MaxChatAdminRosterSyncJob): number {
    if (job.source !== 'webhook_bot_added') {
      return 0;
    }

    return (
      CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_INITIAL_DELAY_MS +
      this.hashModulo(job.chatId, CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_INITIAL_JITTER_MS + 1)
    );
  }

  private resolveJobBackoff(job: MaxChatAdminRosterSyncJob):
    | {
        type: 'fixed';
        delay: number;
      }
    | {
        type: 'exponential';
        delay: number;
      } {
    if (job.source === 'webhook_bot_added') {
      return {
        type: 'exponential',
        delay: CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_BOT_ADDED_BACKOFF_DELAY_MS,
      };
    }

    if (
      job.source === 'webhook_membership_churn' ||
      job.source === 'handshake_start' ||
      job.source === 'moderation_destructive_path' ||
      job.source === 'admin_access_validation'
    ) {
      return {
        type: 'fixed',
        delay: CHAT_ADMIN_ROSTER_SYNC_WEBHOOK_MEMBERSHIP_CHURN_BACKOFF_DELAY_MS,
      };
    }

    return {
      type: 'exponential',
      delay: 1_000,
    };
  }

  private hashModulo(value: string, modulo: number): number {
    if (modulo <= 1) {
      return 0;
    }

    const digest = createHash('sha256').update(value).digest();
    return digest.readUInt32BE(0) % modulo;
  }

  private buildChatAdminRosterReadOptions(
    job: MaxChatAdminRosterSyncJob,
    botId: string,
  ): {
    botId: string;
    bypassCache: true;
    trafficClass: 'background';
    actionHealthLane: 'background';
    sourceTag: string;
    timeoutMs: number;
  } {
    if (
      job.source === 'webhook_bot_added' ||
      job.source === 'webhook_membership_churn' ||
      job.source === 'handshake_start' ||
      job.source === 'moderation_destructive_path' ||
      job.source === 'admin_access_validation'
    ) {
      return {
        botId,
        bypassCache: true,
        trafficClass: 'background',
        actionHealthLane: CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        timeoutMs: CHAT_ADMIN_ROSTER_SYNC_FAST_LANE_TIMEOUT_MS,
      };
    }

    return {
      botId,
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: CHAT_ADMIN_ROSTER_SYNC_ACTION_HEALTH_LANE,
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      timeoutMs: CHAT_ADMIN_ROSTER_SYNC_TIMEOUT_MS,
    };
  }

  private async loadManagedEntitySnapshotPatchChat(
    chatId: string,
    entityTypeHint: ManagedEntityType | null,
    titleHint: string | null,
  ): Promise<{
    id: string;
    title: string;
    createdAt: string;
    entityType: ManagedEntityType;
    primaryBotId: string | null;
    link: string | null;
    avatarUrl: string | null;
  } | null> {
    const persisted = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        title: true,
        createdAt: true,
        entityType: true,
        primaryBotId: true,
        botId: true,
      },
    });

    const entityType = this.fromPrismaEntityType(persisted?.entityType) ?? entityTypeHint ?? null;
    if (!entityType) {
      return null;
    }

    const cachedHeader = await this.chatContextCache.getManagedEntityHeader(chatId, entityType);
    const title =
      observedManagedEntityTitle(chatId, cachedHeader?.title) ??
      observedManagedEntityTitle(chatId, titleHint) ??
      this.readTrimmedString(persisted?.title) ??
      (entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);

    return {
      id: chatId,
      title,
      createdAt: persisted?.createdAt?.toISOString() ?? new Date().toISOString(),
      entityType,
      primaryBotId:
        this.readTrimmedString(persisted?.primaryBotId) ??
        this.readTrimmedString(persisted?.botId) ??
        null,
      link: this.readTrimmedString(cachedHeader?.link) ?? null,
      avatarUrl: this.readTrimmedString(cachedHeader?.avatarUrl) ?? null,
    };
  }

  private async buildManagedEntitySnapshotPatchSummary(params: {
    id: string;
    title: string;
    createdAt: string;
    entityType: ManagedEntityType;
    primaryBotId: string | null;
    link: string | null;
    avatarUrl: string | null;
  }): Promise<ChatSummary> {
    return {
      id: params.id,
      title: params.title,
      createdAt: params.createdAt,
      entityType: params.entityType,
      link: params.link,
      ...(params.avatarUrl ? { avatarUrl: params.avatarUrl } : {}),
      channelOverview: null,
      primaryBotId: params.primaryBotId,
      assignedBots: [],
      sharedMode: 'owned',
    };
  }

  private async persistBotSelfAccessSnapshot(
    job: Pick<MaxChatAdminRosterSyncJob, 'chatId' | 'title' | 'entityType'>,
    botId: string,
    access: {
      isAdmin: boolean;
      isOwner: boolean;
      permissions?: readonly string[];
    } | null,
    checkedAt: Date,
  ): Promise<boolean> {
    try {
      return await this.maxBotLinkService.recordBotAccessProbe({
        chatId: job.chatId,
        botId,
        access,
        source: 'admin_roster_sync',
        checkedAt,
        allowMembershipRecovery: access !== null,
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: job.chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist bot self access snapshot during chat admin roster sync',
      );
      return false;
    }
  }

  private async reconcilePrimaryAfterSelfAccessRefresh(
    job: Pick<MaxChatAdminRosterSyncJob, 'chatId' | 'title' | 'entityType'>,
  ): Promise<void> {
    try {
      await this.maxBotLinkService.reconcileChatPrimaryByAccess({
        chatId: job.chatId,
        title: job.title ?? null,
        entityType: this.toPrismaEntityType(job.entityType),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: job.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reconcile primary bot after chat self-access refresh',
      );
    }
  }

  private async reconcileNightModeAfterConfirmedAccess(
    chatId: string,
    botId: string,
  ): Promise<void> {
    if (!this.nightModeTransitionScheduler) {
      return;
    }

    try {
      await this.nightModeTransitionScheduler.reconcileChat(chatId);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reconcile night mode jobs after confirmed MAX access',
      );
    }
  }

  private async markManagedRefreshSourceBackoff(
    botId: string,
    backoffMs: number,
    now = Date.now(),
  ): Promise<void> {
    this.managedRefreshSourceBackoffUntilMs.set(
      botId,
      Math.max(this.managedRefreshSourceBackoffUntilMs.get(botId) ?? 0, now + backoffMs),
    );

    try {
      await this.chatContextCache.activateManagedRefreshSourceBackoff(
        Math.ceil(backoffMs / 1_000),
        botId,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to store shared chat admin roster managed_refresh backoff marker',
      );
    }
  }

  private async resolveManagedRefreshSourceBackoffDelayMs(
    job: Pick<MaxChatAdminRosterSyncJob, 'chatId'>,
    botId: string,
    now = Date.now(),
  ): Promise<number> {
    const localRemainingMs = Math.max(
      0,
      (this.managedRefreshSourceBackoffUntilMs.get(botId) ?? 0) - now,
    );
    if (localRemainingMs === 0) this.managedRefreshSourceBackoffUntilMs.delete(botId);
    let sharedRemainingMs = 0;
    try {
      const getRemainingMs = (
        this.chatContextCache as ChatContextCacheService & {
          getManagedRefreshSourceBackoffRemainingMs?: (botId?: string) => Promise<number>;
        }
      ).getManagedRefreshSourceBackoffRemainingMs;
      if (typeof getRemainingMs === 'function') {
        sharedRemainingMs = Math.max(
          await getRemainingMs.call(this.chatContextCache, botId),
          await getRemainingMs.call(this.chatContextCache),
        );
      } else if (
        (await this.chatContextCache.isManagedRefreshSourceBackoffActive(botId)) ||
        (await this.chatContextCache.isManagedRefreshSourceBackoffActive())
      ) {
        sharedRemainingMs = CHAT_ADMIN_ROSTER_SYNC_SOURCE_BACKOFF_MS;
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read shared chat admin roster managed_refresh backoff marker',
      );
    }

    const remainingMs = Math.max(localRemainingMs, sharedRemainingMs);
    return remainingMs > 0 ? remainingMs + this.resolveSourceBackoffJitterMs(job) : 0;
  }

  private resolveSourceBackoffJitterMs(job: Pick<MaxChatAdminRosterSyncJob, 'chatId'>): number {
    return this.hashModulo(job.chatId, CHAT_ADMIN_ROSTER_SYNC_SOURCE_BACKOFF_JITTER_MS + 1);
  }

  private isTerminalBotBackoffActive(chatId: string, botId: string, now = Date.now()): boolean {
    const key = this.buildTerminalBotBackoffKey(chatId, botId);
    const backoffUntilMs = this.terminalBotBackoffUntilMs.get(key) ?? 0;
    if (backoffUntilMs <= now) {
      if (backoffUntilMs > 0) {
        this.terminalBotBackoffUntilMs.delete(key);
      }
      return false;
    }

    return true;
  }

  private markTerminalBotBackoff(chatId: string, botId: string, now = Date.now()): void {
    this.terminalBotBackoffUntilMs.set(
      this.buildTerminalBotBackoffKey(chatId, botId),
      now + CHAT_ADMIN_ROSTER_SYNC_TERMINAL_BOT_BACKOFF_MS,
    );
  }

  private buildTerminalBotBackoffKey(chatId: string, botId: string): string {
    return `${chatId}:${botId}`;
  }

  private toPrismaEntityType(entityType?: 'chat' | 'channel' | null): ChatEntityType | null {
    if (entityType === 'channel') {
      return ChatEntityType.CHANNEL;
    }
    if (entityType === 'chat') {
      return ChatEntityType.CHAT;
    }
    return null;
  }

  private fromPrismaEntityType(
    entityType: ChatEntityType | null | undefined,
  ): 'chat' | 'channel' | null {
    if (entityType === ChatEntityType.CHANNEL) {
      return 'channel';
    }
    if (entityType === ChatEntityType.CHAT) {
      return 'chat';
    }
    return null;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private buildUserIdVariants(value: string): string[] {
    const normalized = value.trim().toLowerCase();
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

  private buildUserIdIdentityKey(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return normalized.startsWith('id') && normalized.length > 2 ? normalized.slice(2) : normalized;
  }

  private resolveDiscoveryBotId(botId: unknown): string | null {
    const bot = this.maxBotRegistry.getBotById(this.readTrimmedString(botId));
    return bot && canDiscoverChatsForBotState(bot.state) ? bot.id : null;
  }

  private async mapWithConcurrencyLimit<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const concurrency = Math.max(1, Math.min(limit, items.length));
    const results: R[] = new Array<R>(items.length);
    let currentIndex = 0;

    const runWorker = async () => {
      while (true) {
        const index = currentIndex;
        currentIndex += 1;
        if (index >= items.length) {
          return;
        }

        results[index] = await worker(items[index]);
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    return results;
  }
}
