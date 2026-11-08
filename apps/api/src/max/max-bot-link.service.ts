import { observedManagedEntityTitle } from '../common/managed-entity-title';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { hasPersistedBoundMessage, type MaxBoundObjectReference } from './max-bound-message';
import {
  ChatBotAccessState,
  ChatCatalogKind,
  ChatBotMembershipRole,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  Prisma,
} from '../prisma/prisma-client';
import type { ManagedEntityBotCapability } from '@maxim/contracts';
import { resolveChatCatalogKind } from '../common/chat-catalog-kind.util';
import { isNightModeTransitionMembershipCandidate } from '../moderation/night-mode-transition-eligibility.util';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { PrismaService } from '../prisma/prisma.service';
import { isValidMaxBotStartPayload, isValidMaxMiniappStartPayload } from './max-deep-link.util';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotRegistryService, type MaxBotDefinition } from './max-bot-registry.service';
import {
  isPublisherManagedEntityActivationRequired,
  isPublisherActivationSourceAfterEpoch,
} from '../publisher/publisher-entity-connection.util';
import {
  hasIncompleteManagedEntityPermissionEvidence,
  restrictPassiveManagedEntityAccess,
} from './managed-entity-passive-access.util';
import {
  hasPersistedManagedEntityActivationSource,
  newerManagedEntityActorConflictWhere,
  hasMajorActivationCapabilities,
  hasExplicitHumanAdministrator,
  isExplicitManagedEntityActivationCurrent,
  isManagedEntityActivationRequired,
  isMajorManagedEntityActivationRequired,
  isManagedEntityReceiptAfterActivation,
  MANAGED_ENTITY_DORMANT_ACCESS_STATES,
  MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE,
  ManagedEntityActivationRequiredError,
  type ManagedEntityExplicitActivation,
} from './managed-entity-activation.util';
import {
  executionRouteProof,
  hasExecutionCapability,
  type MaxExecutionAccessEpoch,
  type MaxExecutionOwnerState,
  type MaxExecutionPurpose,
  type MaxExecutionRouteProof,
} from './max-execution-route-proof';
import {
  canAuthenticateInitDataForBotState,
  canDiscoverChatsForBotState,
  canExecuteActionsForBotState,
  isOperationalBotState,
} from './max-bot-state.util';
import {
  membershipExplicitlyLacksAccess,
  isConfirmedMembershipAccessSnapshot,
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
  resolvePreferredPrimaryBotId,
  type MembershipAccessSnapshot,
} from './max-bot-access-policy.util';
import {
  buildBotAccessSnapshotPersistence,
  type BotAccessSnapshotInput,
} from './bot-access-snapshot.util';
import {
  hasConfirmedDeleteMessageAccess,
  hasConfirmedEditMessageAccess,
  resolveDeleteMessageAccessFailure,
  type MaxDeleteMessageAccessFailureReason,
} from './max-delete-message-access.util';
import {
  MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
  MAX_SEND_ROUTE_QUARANTINE_MS,
} from './max-send-route-health';
import {
  ModerationDeleteIntentAccessWakeService,
  type PreviousBotDeleteAccess,
} from './moderation-delete-intent-access-wake.service';

const CHAT_BOT_CACHE_TTL_MS = 10 * 60 * 1_000;
const OBSERVED_WEBHOOK_TOUCH_TTL_MS = 60 * 1_000;
const MAX_OBSERVED_WEBHOOK_TOUCH_CACHE_ENTRIES = 10_000;
const LOCAL_CACHE_SWEEP_INTERVAL_MS = 5_000;
const LOCAL_CACHE_SWEEP_BATCH_SIZE = 256;
const NIGHT_MODE_RECONCILIATION_RETRY_DELAY_MS = 5_000;
const NIGHT_MODE_RECONCILIATION_RETRY_BATCH_SIZE = 50;
const CHAT_MEMBERSHIP_DEADLOCK_MAX_ATTEMPTS = 3;
const CHAT_MEMBERSHIP_DEADLOCK_RETRY_DELAYS_MS = [25, 75] as const;
const SEND_ROUTE_STICKY_DISAPPEARANCE_THRESHOLD = 2;
const SEND_ROUTE_OPEN_CIRCUIT_RECHECK_MS = 15 * 60_000;
const WRITE_MESSAGE_PERMISSION_ALIASES = new Set([
  'write',
  'can_write',
  'post_edit_delete_message',
  'post_edit_delete_messages',
  'can_post_edit_delete_message',
  'can_post_edit_delete_messages',
]);
const READ_ALL_MESSAGES_PERMISSION_ALIASES = new Set([
  'read_all_messages',
  'can_read_all_messages',
]);
const MODERATE_MEMBER_PERMISSION_ALIASES = new Set([
  'add_remove_members',
  'can_add_remove_members',
  'remove_members',
  'can_remove_members',
  'manage_members',
  'can_manage_members',
  'kick_members',
  'can_kick_members',
  'ban_members',
  'can_ban_members',
  'ban_users',
  'can_ban_users',
  'delete_members',
  'can_delete_members',
]);

type ModerationActionPermission = 'delete_message' | 'edit_message' | 'moderate_member';

type ChatBotBindingCacheEntry = {
  botId: string;
  expiresAtMs: number;
};

type BotAccessProbeParams = {
  chatId: string;
  botId: string;
  access: BotAccessSnapshotInput;
  source: string;
  checkedAt: Date;
  lastErrorCode?: string | null;
  allowMembershipRecovery?: boolean;
  channelReadVerified?: boolean;
  explicitActivation?: ManagedEntityExplicitActivation;
  activationActorAccess?: {
    userId?: string | null;
    isAdmin: boolean;
    isOwner: boolean;
    isBot?: boolean | null;
    explicitPrivilegeEvidence?: boolean;
  };
};

export type ChatBotExecutionBinding = {
  chatId: string;
  activeBotId: string | null;
  primaryBotId: string | null;
  activeMembershipStatus: ChatBotMembershipStatus | null;
  assignedBotIds: string[];
  shouldHandleGroupUpdate: boolean;
};

export type ChatRoutingStateReconcileResult = {
  routingState: ChatRoutingState;
  changed: boolean;
};

export type MaxBotRoutePurpose =
  | 'default'
  | 'read'
  | 'send_message'
  | 'member_access'
  | 'moderation_action'
  | 'capability';

export type MaxBotRouteReason =
  | 'explicit'
  | 'chat_cache'
  | 'chat_primary'
  | 'context'
  | 'default'
  | 'primary_confirmed'
  | 'alternate_confirmed'
  | 'primary_soft'
  | 'alternate_soft'
  | 'primary_fallback'
  | 'alternate_fallback';

export type MaxBotRoute =
  | {
      purpose: 'default' | 'read' | 'member_access';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      routingVersion?: number | null;
    }
  | {
      purpose: 'send_message';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      routingVersion?: number | null;
      quarantinedCandidateBotIds?: string[];
      halfOpenCandidateBotIds?: string[];
      retryAt?: Date | null;
    }
  | {
      purpose: 'moderation_action';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      routingVersion?: number | null;
      action: ModerationActionPermission;
    }
  | {
      purpose: 'capability';
      chatId: string | null;
      primaryBotId: string | null;
      botId: string | null;
      candidateBotIds: string[];
      reason: MaxBotRouteReason | null;
      routingVersion?: number | null;
      capability: ManagedEntityBotCapability;
    };

export type MaxBotRouteRequest =
  | {
      purpose: 'default';
      chatId?: string | null;
      botId?: string | null;
    }
  | {
      purpose: 'read' | 'member_access';
      chatId: string;
    }
  | {
      purpose: 'send_message';
      chatId: string;
      fallbackToPrimary?: boolean;
      allowHalfOpenProbe?: boolean;
      stickyHalfOpenProbeFailureBefore?: string;
    }
  | {
      purpose: 'moderation_action';
      chatId: string;
      action: ModerationActionPermission;
      fallbackToPrimary?: boolean;
    }
  | {
      purpose: 'capability';
      chatId: string;
      capability: ManagedEntityBotCapability;
      fallbackToPrimary?: boolean;
    };

export type MaxDeleteMessageCapabilityState =
  | 'confirmed_capable'
  | 'stale_or_unknown'
  | 'explicitly_incapable';

export type MaxDeleteMessageCapabilityReason =
  | MaxDeleteMessageAccessFailureReason
  | 'confirmed'
  | 'chat_not_found'
  | 'no_active_membership'
  | 'snapshot_stale'
  | 'access_state_unconfirmed'
  | 'access_denied'
  | 'bot_not_actionable';

export type MaxDeleteMessageCandidateCapability = {
  botId: string;
  state: MaxDeleteMessageCapabilityState;
  reason: MaxDeleteMessageCapabilityReason;
  checkedAt: string | null;
  expiresAt: string | null;
  routeEligible: boolean;
};

export type MaxDeleteMessageBotRoute = {
  purpose: 'moderation_action';
  action: 'delete_message';
  chatId: string | null;
  entityType: ChatEntityType | null;
  routingState: ChatRoutingState | null;
  routingVersion: number | null;
  primaryBotId: string | null;
  botId: string | null;
  candidateBotIds: string[];
  reason: MaxBotRouteReason | null;
  capabilityState: MaxDeleteMessageCapabilityState;
  capabilityReason: MaxDeleteMessageCapabilityReason;
  checkedAt: string | null;
  expiresAt: string | null;
  candidateCapabilities: MaxDeleteMessageCandidateCapability[];
};

export type MaxStrictModerationCapabilityRoute = {
  botId: string | null;
  capabilityState: MaxDeleteMessageCapabilityState;
  checkedAt: string | null;
};

type ResolvedChatRouteMembership = {
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date | null;
  botAccessExpiresAt: Date | null;
  botAccessSource: string | null;
  lifecycleEventAt: Date | null;
  lifecycleEventType: string | null;
  lifecycleSource: string | null;
  permissionsSnapshot: unknown;
  capabilities: unknown;
  sendRouteFailureCount: number;
  sendRouteQuarantinedUntil: Date | null;
  sendRouteLastFailureAt: Date | null;
  sendRouteLastFailureCode: string | null;
};

export type MaxChatRouteSnapshot = {
  chatId: string;
  title?: string;
  entityType: ChatEntityType | null;
  primaryBotId: string | null;
  fixedModeratorBotId?: string | null;
  botId?: string | null;
  routingState: ChatRoutingState;
  routingVersion: number;
  botMemberships: Array<
    Pick<
      ResolvedChatRouteMembership,
      'botId' | 'role' | 'status' | 'botAccessState' | 'permissionsSnapshot'
    > &
      Partial<ResolvedChatRouteMembership>
  >;
};

type ResolvedChatRouteState = {
  chatId: string;
  title: string;
  entityType: ChatEntityType | null;
  routingState: ChatRoutingState;
  hasStoredBotAssignment: boolean;
  storedPrimaryBotId: string | null;
  storedBotId: string | null;
  primaryBotId: string | null;
  fixedModeratorBotId: string | null;
  routingVersion: number;
  allMemberships: ResolvedChatRouteMembership[];
  memberships: ResolvedChatRouteMembership[];
  activeKnownMemberships: ResolvedChatRouteMembership[];
  activeOperationalMemberships: ResolvedChatRouteMembership[];
  activeActionableMemberships: ResolvedChatRouteMembership[];
};

type ChatBotMembershipUpsertResult = {
  active: boolean;
  lifecycleAdvanced: boolean;
};

type ChatRouteTransactionClient = Pick<
  Prisma.TransactionClient,
  'chat' | 'chatBotMembership' | '$queryRaw'
>;

type LockedChatRouteReconcileResult = {
  primaryBotId: string | null;
  routingState: ChatRoutingState;
  changed: boolean;
};

@Injectable()
export class MaxBotLinkService implements OnModuleDestroy {
  private readonly logger = new Logger(MaxBotLinkService.name);
  private readonly chatBotBindingCache = new Map<string, ChatBotBindingCacheEntry>();
  private readonly observedWebhookTouchCache = new Map<string, number>();
  private readonly observedWebhookTouchesInFlight = new Map<string, Promise<void>>();
  private chatBotBindingSweepIterator: IterableIterator<[string, ChatBotBindingCacheEntry]> | null =
    null;
  private chatBotBindingSweepRemaining = 0;
  private observedWebhookTouchSweepIterator: IterableIterator<[string, number]> | null = null;
  private observedWebhookTouchSweepRemaining = 0;
  private localCacheSweepTimer: NodeJS.Timeout | null = null;
  private readonly pendingNightModeReconciliations = new Set<string>();
  private readonly nightModeReconciliationsInFlight = new Map<string, Promise<boolean>>();
  private nightModeReconciliationRetryTimer: NodeJS.Timeout | null = null;
  private nightModeReconciliationRetryInProgress = false;
  private nightModeReconciliationRetryStopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly botContext: MaxBotContextService,
    private readonly moderationDeleteIntentAccessWake: ModerationDeleteIntentAccessWakeService,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
    @Optional() private readonly routeEpochPublisher?: RedisCounterService,
  ) {}

  onModuleDestroy(): void {
    this.nightModeReconciliationRetryStopped = true;
    if (this.nightModeReconciliationRetryTimer) {
      clearTimeout(this.nightModeReconciliationRetryTimer);
      this.nightModeReconciliationRetryTimer = null;
    }
    if (this.localCacheSweepTimer) {
      clearTimeout(this.localCacheSweepTimer);
      this.localCacheSweepTimer = null;
    }
    this.chatBotBindingSweepIterator = null;
    this.chatBotBindingSweepRemaining = 0;
    this.observedWebhookTouchSweepIterator = null;
    this.observedWebhookTouchSweepRemaining = 0;
    this.chatBotBindingCache.clear();
    this.observedWebhookTouchCache.clear();
    this.pendingNightModeReconciliations.clear();
  }

  private scheduleLocalCacheSweep(delayMs: number): void {
    if (
      this.nightModeReconciliationRetryStopped ||
      this.localCacheSweepTimer ||
      (this.chatBotBindingCache.size === 0 && this.observedWebhookTouchCache.size === 0)
    ) {
      return;
    }
    this.localCacheSweepTimer = setTimeout(() => {
      this.localCacheSweepTimer = null;
      this.sweepLocalCaches();
      this.scheduleLocalCacheSweep(
        this.chatBotBindingSweepIterator || this.observedWebhookTouchSweepIterator
          ? 1
          : LOCAL_CACHE_SWEEP_INTERVAL_MS,
      );
    }, delayMs);
    this.localCacheSweepTimer.unref();
  }

  private sweepLocalCaches(): void {
    const now = Date.now();
    if (!this.chatBotBindingSweepIterator) {
      this.chatBotBindingSweepIterator = this.chatBotBindingCache.entries();
      this.chatBotBindingSweepRemaining = this.chatBotBindingCache.size;
    }
    // FLAG: Synchronous bot resolution falls back on a miss. Preserve every fresh binding and
    // its exact bot scope; capacity eviction is not safe here. Bound each live-iterator pass.
    for (
      let inspected = 0;
      inspected < LOCAL_CACHE_SWEEP_BATCH_SIZE && this.chatBotBindingSweepRemaining > 0;
      inspected++
    ) {
      const next = this.chatBotBindingSweepIterator.next();
      if (next.done) {
        this.chatBotBindingSweepRemaining = 0;
        break;
      }
      this.chatBotBindingSweepRemaining--;
      if (next.value[1].expiresAtMs < now) {
        this.chatBotBindingCache.delete(next.value[0]);
      }
    }
    if (this.chatBotBindingSweepRemaining === 0) {
      this.chatBotBindingSweepIterator = null;
    }

    if (!this.observedWebhookTouchSweepIterator) {
      this.observedWebhookTouchSweepIterator = this.observedWebhookTouchCache.entries();
      this.observedWebhookTouchSweepRemaining = this.observedWebhookTouchCache.size;
    }
    for (
      let inspected = 0;
      inspected < LOCAL_CACHE_SWEEP_BATCH_SIZE && this.observedWebhookTouchSweepRemaining > 0;
      inspected++
    ) {
      const next = this.observedWebhookTouchSweepIterator.next();
      if (next.done) {
        this.observedWebhookTouchSweepRemaining = 0;
        break;
      }
      this.observedWebhookTouchSweepRemaining--;
      if (next.value[1] <= now) {
        this.observedWebhookTouchCache.delete(next.value[0]);
      }
    }
    if (this.observedWebhookTouchSweepRemaining === 0) {
      this.observedWebhookTouchSweepIterator = null;
    }
  }

  getDefaultBotId(): string {
    return this.botRegistry.getDefaultBot().id;
  }

  getEntryBotId(): string {
    return this.botRegistry.getEntryBot().id;
  }

  getContextOrDefaultBotId(): string {
    return this.resolveExecutableBotId(this.botContext.getActiveBotId()) ?? this.getEntryBotId();
  }

  buildBotUrlSync(botId?: string | null): string {
    return `https://max.ru/${encodeURIComponent(this.resolveBotIdSync(botId))}`;
  }

  buildPublisherBotUrlSync(): string {
    // FLAG: Outside api-publisher this identity is descriptor-only. Never use action-route fallback.
    return `https://max.ru/${encodeURIComponent(this.botRegistry.getPublisherBotDescriptor().id)}`;
  }

  buildPublisherBotStartUrlSync(startPayload: string): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) return null;
    const url = new URL(this.buildPublisherBotUrlSync());
    url.searchParams.set('start', startPayload);
    return url.toString();
  }

  buildPublisherMiniappStartUrlSync(startParam: string): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) return null;
    const url = new URL(this.buildPublisherBotUrlSync());
    url.searchParams.set('startapp', startParam);
    return url.toString();
  }

  buildInitDataBotUrlSync(botId: string | null | undefined): string | null {
    const bot = this.botRegistry.getBotById(botId);
    return bot && canAuthenticateInitDataForBotState(bot.state)
      ? `https://max.ru/${encodeURIComponent(bot.id)}`
      : null;
  }

  getResolvedBotSync(botId?: string | null): MaxBotDefinition {
    return (
      this.getOperationalBotById(botId) ??
      this.getOperationalBotById(this.botContext.getActiveBotId()) ??
      this.botRegistry.getEntryBot()
    );
  }

  getBotTokenSync(botId?: string | null): string {
    return this.getResolvedBotSync(botId).token;
  }

  getExecutableBotById(botId: string | null | undefined): MaxBotDefinition | null {
    const bot = this.botRegistry.getBotById(botId);
    return bot && canExecuteActionsForBotState(bot.state) ? bot : null;
  }

  isRegisteredModerationBotId(botId: string): boolean {
    // FLAG: Historical receipts need exact Major identity, independent of today's
    // execution state. User-id aliases and the Publisher descriptor grant no ownership.
    return (
      this.botRegistry.getBotById(botId)?.id === botId &&
      this.botRegistry.getPublisherBotDescriptor().id !== botId
    );
  }

  resolveBotIdFromUserId(userId: string | number | null | undefined): string | null {
    return this.botRegistry.resolveBotIdFromUserId(userId);
  }

  resolveExecutableBotId(botId: string | null | undefined): string | null {
    return this.getExecutableBotById(botId)?.id ?? null;
  }

  resolveBotIdSync(botId?: string | null, chatId?: string | null): string {
    const explicitBot = this.getOperationalBotById(botId);
    if (explicitBot) {
      return explicitBot.id;
    }

    const cachedBotId = this.getCachedChatBotId(chatId);
    if (cachedBotId) {
      return cachedBotId;
    }

    const contextBotId = this.resolveOperationalBotId(this.botContext.getActiveBotId());
    if (contextBotId) {
      return contextBotId;
    }

    return this.getEntryBotId();
  }

  getValidationTokens(botId?: string | null): readonly string[] {
    return botId
      ? this.botRegistry.getValidationTokensForBot(botId)
      : this.botRegistry.getValidationTokens();
  }

  isKnownBotUserId(userId: string | null | undefined): boolean {
    return this.botRegistry.isKnownBotUserId(userId);
  }

  async resolveBotRoute(request: MaxBotRouteRequest): Promise<MaxBotRoute> {
    switch (request.purpose) {
      case 'default':
        return this.resolveDefaultBotRoute(request);
      case 'read':
        return this.resolveReadBotRoute(request.chatId);
      case 'send_message':
        return this.resolveSendMessageBotRoute(
          request.chatId,
          request.fallbackToPrimary,
          request.allowHalfOpenProbe,
          request.stickyHalfOpenProbeFailureBefore,
        );
      case 'member_access':
        return this.resolveMemberAccessBotRoute(request.chatId);
      case 'moderation_action':
        return this.resolveModerationActionBotRoute(
          request.chatId,
          request.action,
          request.fallbackToPrimary,
        );
      case 'capability':
        return this.resolveCapabilityBotRoute(
          request.chatId,
          request.capability,
          request.fallbackToPrimary,
        );
    }
  }

  async resolveBotRoutes(request: MaxBotRouteRequest): Promise<MaxBotRoute> {
    if (request.purpose === 'moderation_action') {
      return this.resolveModerationActionBotRoute(
        request.chatId,
        request.action,
        request.fallbackToPrimary,
      );
    }

    return this.resolveBotRoute(request);
  }

  async claimSendRouteHalfOpen(params: {
    chatId: string;
    botId: string;
    claimedAt?: Date;
    stickyProbeFailureBefore?: string;
  }): Promise<Date | null> {
    const chatId = params.chatId.trim();
    const botId = params.botId.trim();
    if (!chatId || !botId) {
      return null;
    }
    const claimedAt = params.claimedAt ?? new Date();
    const quarantinedUntil = new Date(claimedAt.getTime() + MAX_SEND_ROUTE_QUARANTINE_MS);
    const parsedStickyProbeFailureBefore = this.parseStrictIsoDate(params.stickyProbeFailureBefore);
    const stickyProbeFailureBefore =
      parsedStickyProbeFailureBefore && parsedStickyProbeFailureBefore <= claimedAt
        ? parsedStickyProbeFailureBefore
        : null;
    const claimed = await this.prisma.chatBotMembership.updateMany({
      where: stickyProbeFailureBefore
        ? {
            chatId,
            botId,
            status: ChatBotMembershipStatus.ACTIVE,
            sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
            OR: [
              { sendRouteFailureCount: 1 },
              {
                sendRouteFailureCount: { gte: SEND_ROUTE_STICKY_DISAPPEARANCE_THRESHOLD },
                sendRouteLastFailureAt: { lt: stickyProbeFailureBefore },
              },
            ],
            AND: [
              {
                OR: [
                  { sendRouteQuarantinedUntil: null },
                  { sendRouteQuarantinedUntil: { lte: claimedAt } },
                ],
              },
            ],
          }
        : {
            chatId,
            botId,
            status: ChatBotMembershipStatus.ACTIVE,
            sendRouteFailureCount: 1,
            sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
            OR: [
              { sendRouteQuarantinedUntil: null },
              { sendRouteQuarantinedUntil: { lte: claimedAt } },
            ],
          },
      data: {
        sendRouteQuarantinedUntil: quarantinedUntil,
      },
    });
    return claimed.count === 1 ? quarantinedUntil : null;
  }

  async releaseSendRouteHalfOpen(params: {
    chatId: string;
    botId: string;
    claimedUntil: Date;
    stickyProbeFailureBefore?: string;
  }): Promise<boolean> {
    const chatId = params.chatId.trim();
    const botId = params.botId.trim();
    if (!chatId || !botId) {
      return false;
    }
    const parsedStickyProbeFailureBefore = this.parseStrictIsoDate(params.stickyProbeFailureBefore);
    const stickyProbeFailureBefore =
      parsedStickyProbeFailureBefore && parsedStickyProbeFailureBefore <= params.claimedUntil
        ? parsedStickyProbeFailureBefore
        : null;
    const released = await this.prisma.chatBotMembership.updateMany({
      where: stickyProbeFailureBefore
        ? {
            chatId,
            botId,
            status: ChatBotMembershipStatus.ACTIVE,
            sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
            sendRouteQuarantinedUntil: params.claimedUntil,
            OR: [
              { sendRouteFailureCount: 1 },
              {
                sendRouteFailureCount: { gte: SEND_ROUTE_STICKY_DISAPPEARANCE_THRESHOLD },
                sendRouteLastFailureAt: { lt: stickyProbeFailureBefore },
              },
            ],
          }
        : {
            chatId,
            botId,
            status: ChatBotMembershipStatus.ACTIVE,
            sendRouteFailureCount: 1,
            sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
            sendRouteQuarantinedUntil: params.claimedUntil,
          },
      data: { sendRouteQuarantinedUntil: null },
    });
    return released.count === 1;
  }

  async resolveBotId(
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string> {
    const route = await this.resolveBotRoute({
      purpose: 'default',
      chatId: options.chatId,
      botId: options.botId,
    });
    return route.botId ?? this.getDefaultBotId();
  }

  async resolveBotIdForRead(params: { chatId: string }): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'read',
      chatId: params.chatId,
    });
    return route.botId;
  }

  async resolveBotIdForSend(params: {
    chatId: string;
    fallbackToPrimary?: boolean;
  }): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'send_message',
      chatId: params.chatId,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.botId;
  }

  async resolveBotIdForChannelPoll(params: { chatId: string }): Promise<string | null> {
    return this.resolveBotIdForManagedPoll(params);
  }

  async resolveBotRouteForChannelPoll(params: { chatId: string }): Promise<MaxBotRoute> {
    return this.resolveBotRouteForManagedPoll(params);
  }

  async resolveBotIdForManagedPoll(params: { chatId: string }): Promise<string | null> {
    return (await this.resolveBotRouteForManagedPoll(params)).botId;
  }

  async resolveBotRouteForManagedPoll(params: { chatId: string }): Promise<MaxBotRoute> {
    const normalizedChatId = params.chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'send_message',
        chatId: null,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    if (!state || state.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      return this.buildRoute({
        purpose: 'send_message',
        chatId: normalizedChatId,
        routingVersion: state?.routingVersion ?? null,
      });
    }
    const eligible = state.activeActionableMemberships.filter((membership) => {
      const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
      return (
        this.hasFreshManagedPollAccessSnapshot(membership, snapshot) &&
        this.hasConfirmedManagedPollAccess(snapshot, state.entityType)
      );
    });
    const primaryBotId =
      eligible.find((membership) => membership.botId === state.primaryBotId)?.botId ?? null;
    const candidates = this.orderSendMessageCandidatesByRouteHealth(
      state,
      Array.from(
        new Set([
          ...(primaryBotId ? [primaryBotId] : []),
          ...eligible.map((membership) => membership.botId),
        ]),
      ),
    );
    const selectedBotId = candidates.candidateBotIds[0] ?? null;
    return this.buildRoute({
      purpose: 'send_message',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      botId: selectedBotId,
      candidateBotIds: candidates.candidateBotIds,
      reason:
        selectedBotId === null
          ? null
          : selectedBotId === state.primaryBotId
            ? 'primary_confirmed'
            : 'alternate_confirmed',
      routingVersion: state.routingVersion,
      quarantinedCandidateBotIds: candidates.quarantinedCandidateBotIds,
      halfOpenCandidateBotIds: candidates.halfOpenCandidateBotIds,
      retryAt: candidates.retryAt,
    });
  }

  async getStoredChatPrimaryBotId(
    chatId: string | null | undefined,
    options: { bypassCache?: boolean } = {},
  ): Promise<string | null> {
    const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
    if (!normalizedChatId) {
      return null;
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: normalizedChatId },
      select: { primaryBotId: true, botId: true, routingState: true },
    });
    if (chat?.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      this.forgetChatBotBinding(normalizedChatId);
      return null;
    }

    const resolvedBotId =
      this.resolveOperationalBotId(chat?.primaryBotId ?? chat?.botId ?? null) ?? null;
    if (options.bypassCache !== true) {
      const cachedBotId = this.getCachedChatBotId(normalizedChatId);
      if (cachedBotId === resolvedBotId) {
        return cachedBotId;
      }
    }
    if (resolvedBotId) {
      this.rememberChatBotBinding(normalizedChatId, resolvedBotId);
    } else {
      this.forgetChatBotBinding(normalizedChatId);
    }

    return resolvedBotId;
  }

  async isBotAccessSnapshotStale(params: {
    chatId: string;
    botId: string;
    maxAgeMs: number;
    now?: Date;
  }): Promise<boolean> {
    const chatId = params.chatId.trim();
    const botId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !botId) {
      return true;
    }

    const membership = await this.prisma.chatBotMembership.findUnique({
      where: {
        chatId_botId: {
          chatId,
          botId,
        },
      },
      select: {
        status: true,
        botAccessCheckedAt: true,
        botAccessExpiresAt: true,
        botAccessState: true,
        botAccessSource: true,
        permissionsSnapshot: true,
      },
    });
    if (!membership || membership.status !== ChatBotMembershipStatus.ACTIVE) {
      return true;
    }

    return (
      isManagedEntityActivationRequired(membership) ||
      !isConfirmedMembershipAccessSnapshot(
        normalizeMembershipAccessSnapshot(membership.permissionsSnapshot),
        { nowMs: (params.now ?? new Date()).getTime() },
      )
    );
  }

  async ensureChatForAccessProbe(params: {
    chatId: string;
    title?: string | null;
    entityType?: ChatEntityType | null;
  }): Promise<boolean> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return false;
    }

    const entityType = params.entityType ?? undefined;
    await this.prisma.chat.createMany({
      data: {
        id: chatId,
        title: params.title?.trim() || `Chat ${chatId}`,
        botId: null,
        primaryBotId: null,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        ...(entityType ? { entityType } : {}),
        catalogKind: resolveChatCatalogKind({
          chatId,
          entityType: entityType ?? null,
          contextOnlyHint: true,
        }),
      },
      skipDuplicates: true,
    });
    return true;
  }

  async getChatBotActivationState(chatId: string, botId: string) {
    const select = {
      status: true,
      botAccessState: true,
      botAccessCheckedAt: true,
      botAccessSource: true,
      lifecycleEventAt: true,
      permissionsSnapshot: true,
      chat: { select: { entityType: true } },
    } as const;
    if (botId === this.botRegistry.getPublisherBotDescriptor?.().id) {
      return this.prisma.publisherEntityBinding.findFirst({
        where: { chatId, publisherBotId: botId },
        select,
      });
    }
    return this.prisma.chatBotMembership.findUnique({
      where: { chatId_botId: { chatId, botId } },
      select,
    });
  }

  async isChatBotActivationRequired(
    chatId: string,
    botId: string,
    receiptSourceAt?: Date,
  ): Promise<boolean> {
    const row = await this.getChatBotActivationState(chatId, botId);
    return botId === this.botRegistry.getPublisherBotDescriptor?.().id
      ? isPublisherManagedEntityActivationRequired(row)
      : Boolean(
          receiptSourceAt &&
          (!row ||
            !isManagedEntityReceiptAfterActivation(row.permissionsSnapshot, receiptSourceAt)),
        ) || isMajorManagedEntityActivationRequired(row, row?.chat?.entityType);
  }

  async assertChatBotAccessProbeAllowed(
    chatId: string,
    botId: string,
    activation?: ManagedEntityExplicitActivation,
  ) {
    const current = await this.getChatBotActivationState(chatId, botId);
    const isPublisher = botId === this.botRegistry.getPublisherBotDescriptor?.().id;
    const required = isPublisher
      ? isPublisherManagedEntityActivationRequired(current)
      : isMajorManagedEntityActivationRequired(current, current?.chat?.entityType);
    if (!required && !activation) return current;
    const priorAt = Math.max(
      current?.botAccessCheckedAt?.getTime() ?? 0,
      current?.lifecycleEventAt?.getTime() ?? 0,
    );
    if (
      !isExplicitManagedEntityActivationCurrent(activation, chatId, botId) ||
      (required &&
        (isPublisher
          ? !isPublisherActivationSourceAfterEpoch(current, activation.sourceAt)
          : activation.sourceAt.getTime() <= priorAt)) ||
      // FLAG: Only the exact configured Publisher accepts official forwarded body content.
      // Moderator activation and membership writers retain the strict shared reader.
      !(await (isPublisher
        ? hasPersistedManagedEntityActivationSource(this.prisma, activation, {
            allowOfficialForwardContent: true,
          })
        : hasPersistedManagedEntityActivationSource(this.prisma, activation)))
    )
      throw new ManagedEntityActivationRequiredError();
    return current;
  }

  restrictPassiveBotAccess<T extends NonNullable<BotAccessSnapshotInput>>(
    botId: string,
    access: T,
    current: Awaited<ReturnType<MaxBotLinkService['getChatBotActivationState']>>,
  ): T {
    return botId === this.botRegistry.getPublisherBotDescriptor?.().id
      ? access
      : restrictPassiveManagedEntityAccess(
          access,
          current?.permissionsSnapshot,
          current?.chat?.entityType,
        );
  }

  async recordBotAccessProbe(params: BotAccessProbeParams): Promise<boolean> {
    const chatId = params.chatId.trim();
    const botId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !botId) {
      return false;
    }

    const result = await this.runChatMembershipWriteWithDeadlockRetry(
      () =>
        this.prisma.$transaction(
          async (tx) => {
            // FLAG: Access probes and destructive lifecycle cleanup serialize on the parent Chat.
            // Keep this transaction SQL-only; route reconciliation happens after commit.
            const locked = await tx.$queryRaw<Array<{ id: string; entityType: ChatEntityType }>>(
              Prisma.sql`
          SELECT chat."id", chat."entity_type" AS "entityType"
          FROM "chats" AS chat
          WHERE chat."id" = ${chatId}
          FOR UPDATE OF chat
        `,
            );
            if (locked.length !== 1) {
              return {
                persisted: false,
                wake: null,
                nightModeAccessActivated: false,
                accessChanged: false,
              };
            }

            const previous = await tx.chatBotMembership.findUnique({
              where: { chatId_botId: { chatId, botId } },
              select: {
                status: true,
                botAccessState: true,
                botAccessCheckedAt: true,
                botAccessExpiresAt: true,
                botAccessSource: true,
                permissionsSnapshot: true,
                lifecycleEventAt: true,
              },
            });
            // FLAG: Recheck the locked snapshot: another probe may have committed a
            // complete grant while this partial probe was in flight. Preserve it whole.
            if (
              hasIncompleteManagedEntityPermissionEvidence(
                params.access,
                previous?.permissionsSnapshot,
              )
            )
              return {
                persisted: false,
                wake: null,
                nightModeAccessActivated: false,
                accessChanged: false,
              };
            // FLAG: A terminal denial survives positive background probes and bot_added.
            // Recovery needs a newer authenticated explicit action and both fresh privileges.
            if (
              params.access &&
              (params.access.isAdmin || params.access.isOwner) &&
              (params.explicitActivation ||
                !previous ||
                isMajorManagedEntityActivationRequired(previous, locked[0]!.entityType))
            ) {
              const proof = params.explicitActivation;
              const previousSnapshot = normalizeMembershipAccessSnapshot(
                previous?.permissionsSnapshot,
              );
              const requiresNewerAction =
                isMajorManagedEntityActivationRequired(previous, locked[0]!.entityType) ||
                Boolean(
                  previousSnapshot?.activationCapabilityCeiling &&
                  previousSnapshot.activationCapabilityCeiling.length < 5,
                );
              const priorAt = requiresNewerAction
                ? Math.max(
                    previous?.botAccessCheckedAt?.getTime() ?? 0,
                    previous?.lifecycleEventAt?.getTime() ?? 0,
                  )
                : 0;
              if (
                !isExplicitManagedEntityActivationCurrent(proof, chatId, botId) ||
                proof.sourceAt.getTime() <= priorAt ||
                proof.sourceAt.getTime() > params.checkedAt.getTime() ||
                params.checkedAt.getTime() > Date.now() ||
                params.checkedAt.getTime() + 5 * 60_000 <= Date.now() ||
                !hasMajorActivationCapabilities(
                  params.access,
                  locked[0]!.entityType,
                  params.channelReadVerified,
                ) ||
                !hasExplicitHumanAdministrator(params.activationActorAccess, proof.actorUserId) ||
                !(await hasPersistedManagedEntityActivationSource(tx, proof))
              )
                return {
                  persisted: false,
                  wake: null,
                  nightModeAccessActivated: false,
                  accessChanged: false,
                };
              const actorId = proof.actorUserId.trim();
              const bareActorId = actorId.replace(/^id(?=\d)/iu, '');
              const actorIds = [
                ...new Set([
                  actorId,
                  bareActorId,
                  ...(/^\d+$/u.test(bareActorId) ? [`id${bareActorId}`] : []),
                ]),
              ];
              // FLAG: A user removal/re-add or newer access verdict committed while MAX
              // was being queried invalidates that actor proof before bot activation commits.
              const activity = await tx.chatMembershipActivityEvent.findFirst({
                where: {
                  chatId,
                  userId: { in: actorIds },
                  eventType: { in: ['user_added', 'user_removed'] },
                  eventAt: { gte: params.checkedAt },
                },
                select: { id: true },
              });
              const actorVerdict = await tx.managedEntityAccessEdge.findFirst({
                where: newerManagedEntityActorConflictWhere(
                  chatId,
                  actorIds,
                  botId,
                  params.checkedAt,
                ),
                select: { checkedAt: true },
              });
              if (activity || actorVerdict)
                return {
                  persisted: false,
                  wake: null,
                  nightModeAccessActivated: false,
                  accessChanged: false,
                };
            }
            const previousAccess: PreviousBotDeleteAccess = previous
              ? {
                  status: previous.status,
                  botAccessState: previous.botAccessState,
                  botAccessCheckedAt: previous.botAccessCheckedAt,
                  botAccessExpiresAt: previous.botAccessExpiresAt,
                  permissionsSnapshot: previous.permissionsSnapshot,
                }
              : null;
            const effectiveParams = {
              ...params,
              access:
                params.access && !params.explicitActivation
                  ? restrictPassiveManagedEntityAccess(
                      params.access,
                      previous?.permissionsSnapshot,
                      locked[0]!.entityType,
                    )
                  : params.access,
            };
            const persisted = await this.persistBotAccessProbeInTransaction(
              tx,
              effectiveParams,
              chatId,
              botId,
              // FLAG: Only validated initial activation/reactivation advances the receipt
              // cutline. Passive results and repeated Start on a healthy bot retain it.
              params.explicitActivation &&
                params.access &&
                (params.access.isAdmin || params.access.isOwner) &&
                (!previous ||
                  isMajorManagedEntityActivationRequired(previous, locked[0]!.entityType))
                ? params.explicitActivation.sourceAt.toISOString()
                : normalizeMembershipAccessSnapshot(previous?.permissionsSnapshot)
                    ?.explicitActivationSourceAt,
            );
            const current = persisted
              ? await tx.chatBotMembership.findUnique({
                  where: { chatId_botId: { chatId, botId } },
                  select: {
                    status: true,
                    botAccessState: true,
                    botAccessSource: true,
                    permissionsSnapshot: true,
                  },
                })
              : null;
            const accessChanged = Boolean(
              current &&
              (!previous ||
                previous.status !== current.status ||
                previous.botAccessState !== current.botAccessState ||
                this.accessCapabilityIdentity(previous.permissionsSnapshot) !==
                  this.accessCapabilityIdentity(current.permissionsSnapshot)),
            );
            return {
              persisted,
              accessChanged,
              nightModeAccessActivated:
                persisted &&
                locked[0]!.entityType === ChatEntityType.CHAT &&
                this.getExecutableBotById(botId) !== null &&
                !isNightModeTransitionMembershipCandidate({ ...previous, botId }) &&
                isNightModeTransitionMembershipCandidate({ ...current, botId }),
              // FLAG: A renewed identical capability can restore an expired action proof.
              // The bounded wake helper checks the prior freshness and skips healthy renewals.
              wake: persisted
                ? {
                    chatId,
                    botId,
                    entityType: locked[0]!.entityType,
                    source: params.source,
                    checkedAt: params.checkedAt,
                    access: effectiveParams.access,
                    previousAccess,
                  }
                : null,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        ),
      'recordBotAccessProbe',
    );
    if (result.nightModeAccessActivated && this.nightModeTransitionScheduler) {
      this.pendingNightModeReconciliations.add(chatId);
    }
    if (result.wake) {
      try {
        await this.moderationDeleteIntentAccessWake.wakeAfterCommittedProbe(result.wake);
      } catch (error: unknown) {
        this.logger.warn(
          { chatId, botId, err: error instanceof Error ? error.message : String(error) },
          'Failed to wake moderation delete intents after access recovery; DB sweeper will recover',
        );
      }
    }
    if (result.persisted) this.forgetChatBotBinding(chatId);
    if (result.persisted && result.accessChanged) {
      await this.reconcileChatPrimaryByAccess({ chatId });
      await this.publishCommittedChatRoute(chatId, {
        checkedAt: params.checkedAt,
        source: params.source,
      });
    }
    if (this.nightModeTransitionScheduler && this.pendingNightModeReconciliations.has(chatId)) {
      await this.reconcilePendingNightModeTransition(chatId);
    }
    return result.persisted;
  }

  private accessCapabilityIdentity(value: unknown): string {
    const snapshot = normalizeMembershipAccessSnapshot(value);
    const raw =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { channelReadProof?: { kind?: unknown } })
        : null;
    return JSON.stringify({
      isAdmin: snapshot?.isAdmin === true,
      isOwner: snapshot?.isOwner === true,
      permissionsKnown: snapshot?.permissionsKnown === true,
      permissions: snapshot?.permissions.slice().sort() ?? [],
      activationCapabilityCeiling: snapshot?.activationCapabilityCeiling ?? null,
      channelRead: raw?.channelReadProof?.kind === 'MAX_CHANNEL_GET',
    });
  }

  private async runChatMembershipWriteWithDeadlockRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    // FLAG: Membership writes are idempotent CAS/upsert operations; only a PostgreSQL
    // deadlock may be retried, and never a MAX side effect or an ambiguous mutation.
    for (let attempt = 1; attempt <= CHAT_MEMBERSHIP_DEADLOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (attempt >= CHAT_MEMBERSHIP_DEADLOCK_MAX_ATTEMPTS || !this.isPostgresDeadlock(error)) {
          throw error;
        }

        const delayMs = CHAT_MEMBERSHIP_DEADLOCK_RETRY_DELAYS_MS[attempt - 1] ?? 75;
        this.logger.debug(
          { operation: operationName, attempt, delayMs },
          'Retrying a transient PostgreSQL chat membership deadlock',
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(`Chat membership operation ${operationName} did not complete`);
  }

  private isPostgresDeadlock(error: unknown): boolean {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    if (code === 'P2034' || code === '40P01') {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /(?:40P01|deadlock detected)/iu.test(message);
  }

  private async reconcilePendingNightModeTransition(chatId: string): Promise<void> {
    const existing = this.nightModeReconciliationsInFlight.get(chatId);
    if (existing) {
      const reconciled = await existing;
      if (reconciled && this.pendingNightModeReconciliations.has(chatId)) {
        await this.reconcilePendingNightModeTransition(chatId);
      }
      return;
    }

    const reconciliation = (async (): Promise<boolean> => {
      while (
        this.nightModeTransitionScheduler &&
        this.pendingNightModeReconciliations.delete(chatId)
      ) {
        try {
          await this.nightModeTransitionScheduler.reconcileChat(chatId);
        } catch (error: unknown) {
          if (!this.nightModeReconciliationRetryStopped) {
            this.pendingNightModeReconciliations.add(chatId);
            this.schedulePendingNightModeReconciliationRetry();
          }
          this.logger.warn(
            { chatId, err: error instanceof Error ? error.message : String(error) },
            'Failed to reconcile night mode transitions after access recovery; retry remains pending',
          );
          return false;
        }
      }
      return true;
    })();
    this.nightModeReconciliationsInFlight.set(chatId, reconciliation);
    try {
      const reconciled = await reconciliation;
      if (!reconciled) {
        return;
      }
    } finally {
      this.nightModeReconciliationsInFlight.delete(chatId);
    }
    if (this.pendingNightModeReconciliations.has(chatId)) {
      await this.reconcilePendingNightModeTransition(chatId);
    }
  }

  private schedulePendingNightModeReconciliationRetry(): void {
    if (
      this.nightModeReconciliationRetryStopped ||
      this.nightModeReconciliationRetryTimer ||
      this.nightModeReconciliationRetryInProgress ||
      !this.nightModeTransitionScheduler ||
      this.pendingNightModeReconciliations.size === 0
    ) {
      return;
    }

    this.nightModeReconciliationRetryTimer = setTimeout(() => {
      this.nightModeReconciliationRetryTimer = null;
      void this.retryPendingNightModeReconciliations();
    }, NIGHT_MODE_RECONCILIATION_RETRY_DELAY_MS);
    this.nightModeReconciliationRetryTimer.unref();
  }

  private async retryPendingNightModeReconciliations(): Promise<void> {
    if (this.nightModeReconciliationRetryStopped || this.nightModeReconciliationRetryInProgress) {
      return;
    }

    this.nightModeReconciliationRetryInProgress = true;
    try {
      const chatIds = Array.from(this.pendingNightModeReconciliations).slice(
        0,
        NIGHT_MODE_RECONCILIATION_RETRY_BATCH_SIZE,
      );
      for (const chatId of chatIds) {
        if (this.nightModeReconciliationRetryStopped) {
          return;
        }
        await this.reconcilePendingNightModeTransition(chatId);
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to drain pending night mode transition reconciliations',
      );
    } finally {
      this.nightModeReconciliationRetryInProgress = false;
      this.schedulePendingNightModeReconciliationRetry();
    }
  }

  private async persistBotAccessProbeInTransaction(
    tx: Prisma.TransactionClient,
    params: BotAccessProbeParams,
    chatId: string,
    botId: string,
    explicitActivationSourceAt?: string | null,
  ): Promise<boolean> {
    const checkedAt = params.checkedAt;
    const snapshot = {
      ...buildBotAccessSnapshotPersistence(params.access, {
        source: params.source,
        now: checkedAt,
        lastErrorCode: params.lastErrorCode,
        channelReadVerified: params.channelReadVerified,
        explicitActivationSourceAt,
      }),
      lastSeenAt: checkedAt,
    };
    const accessTimestampFence = params.access
      ? {
          OR: [
            { botAccessCheckedAt: null },
            { botAccessCheckedAt: { lt: checkedAt } },
            {
              botAccessCheckedAt: checkedAt,
              botAccessState: {
                notIn: [
                  ChatBotAccessState.CONFIRMED_MEMBER,
                  ChatBotAccessState.DENIED,
                  ChatBotAccessState.LOST,
                ],
              },
            },
          ],
        }
      : {
          OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lte: checkedAt } }],
        };
    const observationFence = {
      AND: [
        accessTimestampFence,
        {
          OR: [{ lifecycleEventAt: null }, { lifecycleEventAt: { lt: checkedAt } }],
        },
      ],
    };
    const persistActiveSnapshot = () =>
      tx.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
          status: ChatBotMembershipStatus.ACTIVE,
          ...observationFence,
        },
        data: snapshot,
      });

    let result = await persistActiveSnapshot();
    if (result.count > 0) {
      return true;
    }

    if (
      params.allowMembershipRecovery !== true ||
      !params.access ||
      (!params.access.isAdmin && !params.access.isOwner)
    ) {
      if (params.access && (params.access.isAdmin || params.access.isOwner)) {
        return false;
      }
      const removedAccessEvidence: Partial<typeof snapshot> = { ...snapshot };
      delete removedAccessEvidence.permissionsSnapshot;
      delete removedAccessEvidence.permissionsHash;
      const persistedRemoved = await tx.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
          status: ChatBotMembershipStatus.REMOVED,
          ...observationFence,
        },
        data: removedAccessEvidence,
      });
      if (persistedRemoved.count === 0) {
        const created = await tx.chatBotMembership.createMany({
          data: {
            chatId,
            botId,
            role: ChatBotMembershipRole.STANDBY,
            status: ChatBotMembershipStatus.REMOVED,
            ...removedAccessEvidence,
          },
          skipDuplicates: true,
        });
        if (created.count === 0) {
          result = await persistActiveSnapshot();
          if (result.count > 0) {
            return true;
          }
          await tx.chatBotMembership.updateMany({
            where: {
              chatId,
              botId,
              status: ChatBotMembershipStatus.REMOVED,
              ...observationFence,
            },
            data: removedAccessEvidence,
          });
        }
      }
      return false;
    }

    const recoveryFence = {
      AND: [
        accessTimestampFence,
        {
          OR: [{ lifecycleEventAt: null }, { lifecycleEventAt: { lt: checkedAt } }],
        },
      ],
    };
    const recoveryData = {
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      ...snapshot,
      lastWebhookAt: checkedAt,
      lifecycleEventAt: checkedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    };
    const recoverRemovedMembership = () =>
      tx.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
          status: ChatBotMembershipStatus.REMOVED,
          ...recoveryFence,
        },
        data: recoveryData,
      });

    // FLAG: Recovery and access evidence must commit in one CAS fenced by every newer probe/lifecycle.
    result = await recoverRemovedMembership();
    if (result.count === 0) {
      const created = await tx.chatBotMembership.createMany({
        data: {
          chatId,
          botId,
          ...recoveryData,
        },
        skipDuplicates: true,
      });
      if (created.count === 0) {
        result = await persistActiveSnapshot();
        if (result.count === 0) {
          result = await recoverRemovedMembership();
        }
      } else {
        result = created;
      }
    }

    return result.count > 0;
  }

  async reconcileChatRoutingState(params: {
    chatId: string;
    forceVersionBump?: boolean;
  }): Promise<ChatRoutingStateReconcileResult | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const reconciled = await this.reconcileLockedChatRoute({
      chatId,
      forceVersionBump: params.forceVersionBump === true,
    });
    if (!reconciled) {
      return null;
    }

    if (reconciled.primaryBotId) {
      this.rememberChatBotBinding(chatId, reconciled.primaryBotId);
    } else {
      this.forgetChatBotBinding(chatId);
    }
    return {
      routingState: reconciled.routingState,
      changed: reconciled.changed,
    };
  }

  async observeStoredChatBotWebhook(params: {
    chatId: string;
    primaryBotId?: string | null;
    botId?: string | null;
    observedAt?: Date | null;
  }): Promise<void> {
    const chatId = params.chatId.trim();
    const observedBotId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !observedBotId) {
      return;
    }

    const cacheKey = `${chatId}:${observedBotId}`;
    const nowMs = Date.now();
    if ((this.observedWebhookTouchCache.get(cacheKey) ?? 0) > nowMs) {
      return;
    }
    const pending = this.observedWebhookTouchesInFlight.get(cacheKey);
    if (pending) {
      return pending;
    }

    const touch = this.touchObservedMembership(
      chatId,
      observedBotId,
      params.observedAt ?? new Date(nowMs),
      cacheKey,
      nowMs,
    ).finally(() => {
      if (this.observedWebhookTouchesInFlight.get(cacheKey) === touch) {
        this.observedWebhookTouchesInFlight.delete(cacheKey);
      }
    });
    this.observedWebhookTouchesInFlight.set(cacheKey, touch);
    return touch;
  }

  private async touchObservedMembership(
    chatId: string,
    observedBotId: string,
    observedAt: Date,
    cacheKey: string,
    nowMs: number,
  ): Promise<void> {
    // FLAG: Coalescing only reduces heartbeat writes; it must never reactivate membership.
    const touched = await this.prisma.$executeRaw`
      UPDATE chat_bot_memberships
      SET last_seen_at = ${observedAt}, last_webhook_at = ${observedAt},
        updated_at = ${new Date()}
      WHERE chat_id = ${chatId} AND bot_id = ${observedBotId} AND status = 'ACTIVE'
    `;
    if (touched === 0 || this.nightModeReconciliationRetryStopped) {
      return;
    }
    this.observedWebhookTouchCache.delete(cacheKey);
    this.observedWebhookTouchCache.set(cacheKey, nowMs + OBSERVED_WEBHOOK_TOUCH_TTL_MS);
    while (this.observedWebhookTouchCache.size > MAX_OBSERVED_WEBHOOK_TOUCH_CACHE_ENTRIES) {
      const oldestKey = this.observedWebhookTouchCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.observedWebhookTouchCache.delete(oldestKey);
    }
    this.scheduleLocalCacheSweep(LOCAL_CACHE_SWEEP_INTERVAL_MS);
  }

  resolveContactIdSync(botId?: string | null): string | null {
    const bot = this.getResolvedBotSync(botId);
    return bot.contactId;
  }

  buildEntryMiniappStartUrlSync(startParam: string): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.getEntryBotId())}?startapp=${encodeURIComponent(startParam)}`;
  }

  buildEntryBotStartUrlSync(startPayload: string): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.getEntryBotId())}?start=${encodeURIComponent(startPayload)}`;
  }

  buildMiniappStartUrlSync(startParam: string, botId?: string | null): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    const resolvedBotId = this.resolveBotIdSync(botId);
    return `https://max.ru/${encodeURIComponent(resolvedBotId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  buildBotStartUrlSync(startPayload: string, botId?: string | null): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    const resolvedBotId = this.resolveBotIdSync(botId);
    return `https://max.ru/${encodeURIComponent(resolvedBotId)}?start=${encodeURIComponent(startPayload)}`;
  }

  rememberChatBotBinding(chatId: string, botId: string | null | undefined): void {
    const normalizedChatId = chatId.trim();
    const normalizedBotId = this.resolveOperationalBotId(botId);
    if (!normalizedChatId || !normalizedBotId || this.nightModeReconciliationRetryStopped) {
      return;
    }

    this.chatBotBindingCache.set(normalizedChatId, {
      botId: normalizedBotId,
      expiresAtMs: Date.now() + CHAT_BOT_CACHE_TTL_MS,
    });
    this.scheduleLocalCacheSweep(LOCAL_CACHE_SWEEP_INTERVAL_MS);
  }

  forgetChatBotBinding(chatId: string): void {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }
    this.chatBotBindingCache.delete(normalizedChatId);
  }

  forgetAllChatBotBindings(): void {
    this.chatBotBindingCache.clear();
    this.chatBotBindingSweepIterator = null;
    this.chatBotBindingSweepRemaining = 0;
  }

  async resolveContactId(
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'default',
      chatId: options.chatId,
      botId: options.botId,
    });
    return this.resolveContactIdSync(route.botId);
  }

  async buildEntryMiniappStartUrl(startParam: string): Promise<string | null> {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.getEntryBotId())}?startapp=${encodeURIComponent(startParam)}`;
  }

  async buildEntryBotStartUrl(startPayload: string): Promise<string | null> {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    return `https://max.ru/${encodeURIComponent(this.getEntryBotId())}?start=${encodeURIComponent(startPayload)}`;
  }

  async buildMiniappStartUrl(
    startParam: string,
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string | null> {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    const route = await this.resolveBotRoute({
      purpose: 'default',
      chatId: options.chatId,
      botId: options.botId,
    });
    const botId = route.botId ?? this.getDefaultBotId();
    return `https://max.ru/${encodeURIComponent(botId)}?startapp=${encodeURIComponent(startParam)}`;
  }

  async buildBotStartUrl(
    startPayload: string,
    options: { chatId?: string | null; botId?: string | null } = {},
  ): Promise<string | null> {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    const route = await this.resolveBotRoute({
      purpose: 'default',
      chatId: options.chatId,
      botId: options.botId,
    });
    const botId = route.botId ?? this.getDefaultBotId();
    return `https://max.ru/${encodeURIComponent(botId)}?start=${encodeURIComponent(startPayload)}`;
  }

  async bindChatToBot(params: {
    chatId: string;
    title?: string | null;
    entityType?: ChatEntityType | null;
    botId?: string | null;
    allowReassign?: boolean;
    lifecycleEventAt?: Date | null;
    lifecycleEventType?: string | null;
    lifecycleSource?: string | null;
    preserveRemovedMembership?: boolean;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const explicitBotId = this.resolveOperationalBotId(params.botId);
    const defaultRoute = await this.resolveBotRoute({
      purpose: 'default',
      chatId,
      botId: params.botId,
    });
    const botId = explicitBotId ?? defaultRoute.botId ?? this.getDefaultBotId();
    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const catalogKind = resolveChatCatalogKind({
      chatId,
      entityType: entityType ?? null,
      managedHint: true,
    });
    const now = new Date();

    const created = await this.prisma.chat.createMany({
      data: {
        id: chatId,
        title,
        botId,
        primaryBotId: botId,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        ...(entityType ? { entityType } : {}),
        catalogKind,
      },
      skipDuplicates: true,
    });

    if (created.count > 0) {
      const membershipResult = await this.upsertChatBotMembership(chatId, botId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
        lastWebhookAt: explicitBotId ? now : null,
        lifecycleEventAt: params.lifecycleEventAt,
        lifecycleEventType: params.lifecycleEventType,
        lifecycleSource: params.lifecycleSource,
        allowReactivation:
          params.lifecycleEventType === 'bot_added' || params.lifecycleSource === 'live_probe',
        preserveRemovedMembership:
          params.preserveRemovedMembership ??
          (params.lifecycleEventType !== 'bot_added' && params.lifecycleSource !== 'live_probe'),
      });
      if (membershipResult.lifecycleAdvanced && params.lifecycleEventAt) {
        await this.markChatRoutingReadyFromLifecycleProof({
          chatId,
          botId,
          lifecycleEventAt: params.lifecycleEventAt,
          lifecycleEventType: params.lifecycleEventType ?? '',
          lifecycleSource: params.lifecycleSource ?? '',
        });
      }
      if (params.lifecycleEventAt) {
        return this.reconcileChatPrimaryByAccess({
          chatId,
          title,
          entityType,
        });
      }
      return this.reconcileChatPrimaryByAccess({ chatId, title, entityType });
    }

    const existing = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { primaryBotId: true, botId: true },
    });
    const existingPrimaryBotId = this.resolveOperationalBotId(
      existing?.primaryBotId ?? existing?.botId ?? null,
    );
    const nextPrimaryBotId =
      params.allowReassign === true ? botId : (existingPrimaryBotId ?? botId);

    await this.prisma.chat.update({
      where: { id: chatId },
      data: {
        title,
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        ...(entityType ? { entityType } : {}),
        catalogKind,
      },
    });

    const incomingMembershipResult = await this.upsertChatBotMembership(chatId, botId, {
      role:
        nextPrimaryBotId === botId ? ChatBotMembershipRole.PRIMARY : ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.ACTIVE,
      lastSeenAt: now,
      lastWebhookAt: explicitBotId ? now : null,
      lifecycleEventAt: params.lifecycleEventAt,
      lifecycleEventType: params.lifecycleEventType,
      lifecycleSource: params.lifecycleSource,
      allowReactivation:
        params.lifecycleEventType === 'bot_added' || params.lifecycleSource === 'live_probe',
      preserveRemovedMembership:
        params.preserveRemovedMembership ??
        (params.lifecycleEventType !== 'bot_added' && params.lifecycleSource !== 'live_probe'),
    });
    if (incomingMembershipResult.lifecycleAdvanced && params.lifecycleEventAt) {
      await this.markChatRoutingReadyFromLifecycleProof({
        chatId,
        botId,
        lifecycleEventAt: params.lifecycleEventAt,
        lifecycleEventType: params.lifecycleEventType ?? '',
        lifecycleSource: params.lifecycleSource ?? '',
      });
    }

    if (nextPrimaryBotId && nextPrimaryBotId !== botId) {
      await this.upsertChatBotMembership(chatId, nextPrimaryBotId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
        preserveRemovedMembership: true,
      });

      this.logger.debug(
        {
          chatId,
          existingBotId: nextPrimaryBotId,
          incomingBotId: botId,
        },
        'Registered shared chat bot presence without changing the primary bot assignment',
      );
    }

    const resolvedPrimaryBotId = await this.reconcileChatPrimaryByAccess({
      chatId,
      title,
      entityType,
    });
    if (resolvedPrimaryBotId) {
      this.rememberChatBotBinding(chatId, resolvedPrimaryBotId);
    } else {
      this.forgetChatBotBinding(chatId);
    }
    return resolvedPrimaryBotId;
  }

  async getChatExecutionBinding(params: {
    chatId: string;
    activeBotId?: string | null;
  }): Promise<ChatBotExecutionBinding> {
    const chatId = params.chatId.trim();
    const activeBotId = this.resolveOperationalBotId(params.activeBotId);
    if (!chatId) {
      return {
        chatId,
        activeBotId,
        primaryBotId: null,
        activeMembershipStatus: null,
        assignedBotIds: [],
        shouldHandleGroupUpdate: true,
      };
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        routingState: true,
        entityType: true,
        primaryBotId: true,
        fixedModeratorBotId: true,
        botId: true,
        botMemberships: {
          select: {
            botId: true,
            updatedAt: true,
            role: true,
            status: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessSource: true,
            permissionsSnapshot: true,
          },
        },
      },
    });
    const routeClosed = chat?.routingState === ChatRoutingState.NO_ELIGIBLE_BOT;
    const activeKnownMemberships = (chat?.botMemberships ?? []).filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        !isMajorManagedEntityActivationRequired(membership, chat?.entityType) &&
        Boolean(this.resolveOperationalBotId(membership.botId)),
    );
    const activeExecutableMemberships = activeKnownMemberships.filter(
      (membership) =>
        (!chat?.fixedModeratorBotId || membership.botId === chat.fixedModeratorBotId) &&
        Boolean(this.resolveExecutableBotId(membership.botId)) &&
        this.isMembershipRouteAccessEligible(membership),
    );
    const accessEligibleActiveExecutableMemberships = activeExecutableMemberships;
    const accessEligibleActiveKnownMemberships = activeKnownMemberships.filter((membership) =>
      this.isMembershipRouteAccessEligible(membership),
    );
    const rawStoredExecutableBotId =
      this.resolveExecutableBotId(chat?.primaryBotId ?? null) ??
      this.resolveExecutableBotId(chat?.botId ?? null);
    const storedExecutableMembership = rawStoredExecutableBotId
      ? (activeExecutableMemberships.find(
          (membership) => membership.botId === rawStoredExecutableBotId,
        ) ?? null)
      : null;
    const storedExecutableBotId =
      rawStoredExecutableBotId &&
      storedExecutableMembership &&
      this.isMembershipRouteAccessEligible(storedExecutableMembership)
        ? rawStoredExecutableBotId
        : null;
    const storedOperationalBotId = this.resolveOperationalBotId(
      chat?.primaryBotId ?? chat?.botId ?? null,
    );
    const storedOperationalMembership = storedOperationalBotId
      ? (activeKnownMemberships.find((membership) => membership.botId === storedOperationalBotId) ??
        null)
      : null;
    const storedAccessEligibleBotId =
      storedOperationalBotId &&
      storedOperationalMembership &&
      this.isMembershipRouteAccessEligible(storedOperationalMembership)
        ? storedOperationalBotId
        : null;
    const executablePrimaryBotId =
      resolvePreferredPrimaryBotId(storedExecutableBotId, activeExecutableMemberships, {
        requireFreshSnapshotForPromotion: true,
      }) ??
      storedExecutableBotId ??
      accessEligibleActiveExecutableMemberships.find(
        (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
      )?.botId ??
      accessEligibleActiveExecutableMemberships[0]?.botId ??
      null;
    const legacyPrimaryBotId =
      executablePrimaryBotId ??
      resolvePreferredPrimaryBotId(storedAccessEligibleBotId, activeKnownMemberships, {
        requireFreshSnapshotForPromotion: true,
      }) ??
      storedAccessEligibleBotId ??
      accessEligibleActiveKnownMemberships.find(
        (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
      )?.botId ??
      accessEligibleActiveKnownMemberships[0]?.botId ??
      null;
    const primaryBotId = chat?.fixedModeratorBotId
      ? (activeExecutableMemberships.find((row) => row.botId === chat.fixedModeratorBotId)?.botId ??
        null)
      : legacyPrimaryBotId;
    const activeMembership =
      activeBotId && chat?.botMemberships
        ? (chat.botMemberships.find((membership) => membership.botId === activeBotId) ?? null)
        : null;
    const activeMembershipStatus = activeMembership?.status ?? null;
    const assignedBotIds = Array.from(
      new Set(activeKnownMemberships.map((membership) => membership.botId)),
    );
    const shouldHandleGroupUpdate = Boolean(
      !routeClosed &&
      activeBotId &&
      primaryBotId &&
      activeBotId === primaryBotId &&
      activeMembershipStatus === ChatBotMembershipStatus.ACTIVE &&
      Boolean(activeMembership && this.isMembershipRouteAccessEligible(activeMembership)),
    );

    return {
      chatId,
      activeBotId,
      primaryBotId,
      activeMembershipStatus,
      assignedBotIds,
      shouldHandleGroupUpdate,
    };
  }

  async resolveBotIdForMemberAccess(params: { chatId: string }): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'member_access',
      chatId: params.chatId,
    });
    return route.botId;
  }

  async resolveBotIdForModerationAction(params: {
    chatId: string;
    action: ModerationActionPermission;
    fallbackToPrimary?: boolean;
  }): Promise<string | null> {
    const route = await this.resolveBotRoutes({
      purpose: 'moderation_action',
      chatId: params.chatId,
      action: params.action,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.botId;
  }

  async resolveBotIdsForModerationAction(params: {
    chatId: string;
    action: ModerationActionPermission;
    fallbackToPrimary?: boolean;
  }): Promise<string[]> {
    const route = await this.resolveBotRoutes({
      purpose: 'moderation_action',
      chatId: params.chatId,
      action: params.action,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.candidateBotIds;
  }

  async resolveDeleteMessageBotRoute(params: {
    chatId: string;
    expectedEntityType?: ChatEntityType | null;
    requireFreshSnapshot?: boolean;
    existingMessage?: { messageId: string; botId: string };
  }): Promise<MaxDeleteMessageBotRoute> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return this.buildEmptyDeleteMessageBotRoute(null, 'chat_not_found');
    }

    const state = await this.loadChatRouteState(chatId);
    if (!state) {
      return this.buildEmptyDeleteMessageBotRoute(chatId, 'chat_not_found');
    }
    const entityType = params.expectedEntityType ?? state.entityType;
    if (params.expectedEntityType && params.expectedEntityType !== state.entityType) {
      this.logger.warn(
        {
          chatId,
          expectedEntityType: params.expectedEntityType,
          persistedEntityType: state.entityType,
        },
        'Using delete-intent entity type over stale managed chat metadata',
      );
    }

    const requireFreshSnapshot = params.requireFreshSnapshot !== false;
    const actionableBotIds = new Set(
      state.activeActionableMemberships.map((membership) => membership.botId),
    );
    // FLAG: Old bot-authored cleanup keeps its exact persisted executor. This does
    // not widen user-message deletion or permit an alternate bot to take over new work.
    const existing = params.existingMessage;
    if (
      state.fixedModeratorBotId &&
      existing &&
      existing.botId !== state.fixedModeratorBotId &&
      this.resolveExecutableBotId(existing.botId) &&
      executionRouteProof(
        {
          chatId,
          entityType: state.entityType,
          primaryBotId: state.primaryBotId,
          routingVersion: state.routingVersion,
          candidates: state.allMemberships,
        },
        existing.botId,
        'delete_message',
      ) &&
      (await hasPersistedBoundMessage(this.prisma, {
        chatId,
        ...existing,
        purpose: 'delete_message',
      }))
    )
      actionableBotIds.add(existing.botId);
    // FLAG: Keep exact negative epochs in diagnostics so an unattempted DELETE can
    // move to a healthy peer. Dormant evidence never becomes an executable route.
    const candidateCapabilities = state.allMemberships
      .filter(
        (membership) =>
          membership.status === ChatBotMembershipStatus.ACTIVE &&
          Boolean(this.resolveOperationalBotId(membership.botId)),
      )
      .map((membership) =>
        this.assessDeleteMessageCandidateCapability(
          membership,
          entityType,
          actionableBotIds.has(membership.botId),
        ),
      )
      .map((candidate) => ({
        ...candidate,
        routeEligible:
          candidate.routeEligible &&
          (candidate.state === 'confirmed_capable' ||
            (!requireFreshSnapshot && state.routingState === ChatRoutingState.READY)),
      }))
      .sort((left, right) => {
        if (left.botId === state.primaryBotId) {
          return -1;
        }
        if (right.botId === state.primaryBotId) {
          return 1;
        }
        return 0;
      });
    const routeCandidates = candidateCapabilities
      .filter((candidate) => candidate.routeEligible)
      .sort((left, right) => {
        const leftConfirmed = left.state === 'confirmed_capable';
        const rightConfirmed = right.state === 'confirmed_capable';
        if (leftConfirmed !== rightConfirmed) {
          return leftConfirmed ? -1 : 1;
        }
        if (left.botId === state.primaryBotId) {
          return -1;
        }
        if (right.botId === state.primaryBotId) {
          return 1;
        }
        return 0;
      });
    const selected = routeCandidates[0] ?? null;
    const aggregate =
      candidateCapabilities.find((candidate) => candidate.state === 'confirmed_capable') ??
      candidateCapabilities.find((candidate) => candidate.state === 'stale_or_unknown') ??
      candidateCapabilities[0] ??
      null;

    return {
      purpose: 'moderation_action',
      action: 'delete_message',
      chatId,
      entityType,
      routingState: state.routingState,
      routingVersion: state.routingVersion,
      primaryBotId: state.primaryBotId,
      botId: selected?.botId ?? null,
      candidateBotIds: routeCandidates.map((candidate) => candidate.botId),
      reason: selected
        ? selected.botId === state.primaryBotId
          ? selected.state === 'confirmed_capable'
            ? 'primary_confirmed'
            : 'primary_soft'
          : selected.state === 'confirmed_capable'
            ? 'alternate_confirmed'
            : 'alternate_soft'
        : null,
      capabilityState: aggregate?.state ?? 'stale_or_unknown',
      capabilityReason: aggregate?.reason ?? 'no_active_membership',
      checkedAt: aggregate?.checkedAt ?? null,
      expiresAt: aggregate?.expiresAt ?? null,
      candidateCapabilities,
    };
  }

  async resolveStrictMemberModerationBotRoute(params: {
    chatId: string;
  }): Promise<MaxStrictModerationCapabilityRoute> {
    return this.resolveStrictModerationCapabilityRoute(params.chatId, 'member');
  }

  async resolveStrictWriteModerationBotRoute(params: {
    chatId: string;
  }): Promise<MaxStrictModerationCapabilityRoute> {
    return this.resolveStrictModerationCapabilityRoute(params.chatId, 'write');
  }

  private async resolveStrictModerationCapabilityRoute(
    rawChatId: string,
    capability: 'member' | 'write',
  ): Promise<MaxStrictModerationCapabilityRoute> {
    const chatId = rawChatId.trim();
    const state = chatId ? await this.loadChatRouteState(chatId) : null;
    if (!state) {
      return { botId: null, capabilityState: 'stale_or_unknown', checkedAt: null };
    }

    const actionableBotIds = new Set(
      state.activeActionableMemberships.map((membership) => membership.botId),
    );
    const candidates = state.activeKnownMemberships
      .filter((membership) => actionableBotIds.has(membership.botId))
      .map((membership) => {
        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        const checkedAtMs =
          membership.botAccessCheckedAt?.getTime() ??
          (snapshot?.checkedAt ? Date.parse(snapshot.checkedAt) : Number.NaN);
        const checkedAt = Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : null;
        const result = (state: MaxDeleteMessageCapabilityState) => ({
          botId: membership.botId,
          state,
          checkedAt,
        });
        if (
          membership.botAccessState === ChatBotAccessState.DENIED ||
          membership.botAccessState === ChatBotAccessState.LOST
        ) {
          return result('explicitly_incapable');
        }
        if (!snapshot) {
          return result('stale_or_unknown');
        }
        const fresh =
          Number.isFinite(checkedAtMs) &&
          checkedAtMs <= Date.now() &&
          isConfirmedMembershipAccessSnapshot(snapshot);
        if (
          !fresh ||
          (membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
            membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER) ||
          (!snapshot.isOwner && !this.membershipPermissionsAreKnown(membership.permissionsSnapshot))
        ) {
          return result('stale_or_unknown');
        }
        const purpose = capability === 'member' ? 'moderate_member' : 'delete_message';
        const explicitlyCapable =
          (!snapshot.activationCapabilityCeiling ||
            snapshot.activationCapabilityCeiling.includes(purpose)) &&
          (snapshot.isOwner ||
            (snapshot.isAdmin && capability === 'write'
              ? hasConfirmedDeleteMessageAccess(snapshot, ChatEntityType.CHAT)
              : snapshot.isAdmin &&
                snapshot.permissions.some((permission) =>
                  MODERATE_MEMBER_PERMISSION_ALIASES.has(normalizePermissionName(permission)),
                )));
        return result(explicitlyCapable ? 'confirmed_capable' : 'explicitly_incapable');
      });
    const selected =
      candidates.find(
        (candidate) =>
          candidate.botId === state.primaryBotId && candidate.state === 'confirmed_capable',
      ) ?? candidates.find((candidate) => candidate.state === 'confirmed_capable');
    const aggregate =
      selected ??
      candidates.find((candidate) => candidate.state === 'stale_or_unknown') ??
      candidates[0];
    return {
      botId: selected?.botId ?? null,
      capabilityState: aggregate?.state ?? 'stale_or_unknown',
      checkedAt: aggregate?.checkedAt ?? null,
    };
  }

  async resolveBotIdForCapability(params: {
    chatId: string;
    capability: ManagedEntityBotCapability;
    fallbackToPrimary?: boolean;
  }): Promise<string | null> {
    const route = await this.resolveBotRoute({
      purpose: 'capability',
      chatId: params.chatId,
      capability: params.capability,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.botId;
  }

  async resolveBotIdsForCapability(params: {
    chatId: string;
    capability: ManagedEntityBotCapability;
    fallbackToPrimary?: boolean;
  }): Promise<string[]> {
    const route = await this.resolveBotRoute({
      purpose: 'capability',
      chatId: params.chatId,
      capability: params.capability,
      fallbackToPrimary: params.fallbackToPrimary,
    });
    return route.candidateBotIds;
  }

  async markChatBotRemoved(params: {
    chatId: string;
    botId?: string | null;
    title?: string | null;
    entityType?: ChatEntityType | null;
    accessLostReason?: string | null;
    accessLostSource?: string | null;
    lastMaxErrorCode?: string | null;
    lastMaxErrorMessage?: string | null;
    lastMaxStatusCode?: number | null;
    lifecycleEventAt?: Date | null;
    lifecycleEventType?: string | null;
    lifecycleSource?: string | null;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    const botId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !botId) {
      return null;
    }

    const title = params.title?.trim() || `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const now = new Date();
    const lifecycleEventAt = params.lifecycleEventAt ?? now;
    const lifecycleEventType = params.lifecycleEventType?.trim() || 'bot_removed';
    const lifecycleSource = params.lifecycleSource?.trim() || 'webhook';
    const catalogKind = resolveChatCatalogKind({
      chatId,
      entityType: entityType ?? null,
      contextOnlyHint: true,
    });
    const accessLossSnapshot =
      params.accessLostReason ||
      params.accessLostSource ||
      params.lastMaxErrorCode ||
      params.lastMaxErrorMessage ||
      typeof params.lastMaxStatusCode === 'number'
        ? {
            accessLostReason: params.accessLostReason ?? null,
            accessLostSource: params.accessLostSource ?? null,
            lastMaxErrorCode: params.lastMaxErrorCode ?? null,
            lastMaxErrorMessage: params.lastMaxErrorMessage ?? null,
            lastMaxStatusCode: params.lastMaxStatusCode ?? null,
            accessLostAt: now.toISOString(),
          }
        : null;

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        ...(entityType ? { entityType } : {}),
        catalogKind,
      },
      update: {
        title,
        ...(entityType ? { entityType } : {}),
      },
    });
    await this.updateChatCatalogKindUnlessManaged(chatId, catalogKind);

    const removalWhere = {
      chatId,
      botId,
      AND: [
        {
          OR: [
            { lifecycleEventAt: null },
            { lifecycleEventAt: { lt: lifecycleEventAt } },
            {
              lifecycleEventAt,
              status: ChatBotMembershipStatus.ACTIVE,
            },
          ],
        },
        {
          OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lte: lifecycleEventAt } }],
        },
      ],
    };
    const removalData = {
      role: ChatBotMembershipRole.STANDBY,
      status: ChatBotMembershipStatus.REMOVED,
      ...(accessLossSnapshot ? { permissionsSnapshot: accessLossSnapshot } : {}),
      lastSeenAt: lifecycleEventAt,
      lastWebhookAt: lifecycleEventAt,
      lifecycleEventAt,
      lifecycleEventType,
      lifecycleSource,
    };
    let removed = await this.prisma.chatBotMembership.updateMany({
      where: removalWhere,
      data: removalData,
    });

    if (removed.count === 0) {
      const created = await this.runChatMembershipWriteWithDeadlockRetry(
        () =>
          this.prisma.chatBotMembership.createMany({
            data: {
              chatId,
              botId,
              ...removalData,
            },
            skipDuplicates: true,
          }),
        'markChatBotRemoved.membershipCreate',
      );
      if (created.count === 0) {
        removed = await this.prisma.chatBotMembership.updateMany({
          where: removalWhere,
          data: removalData,
        });
      }
    }

    return this.reconcileChatPrimaryByAccess({ chatId, title, entityType });
  }

  async bindDiscoveredChatBots(params: {
    chatId: string;
    primaryBotId?: string | null;
    botIds?: readonly string[] | null;
    title?: string | null;
    entityType?: ChatEntityType | null;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const observedBotIds = Array.from(
      new Set(
        (params.botIds ?? [])
          .map((botId) => this.resolveOperationalBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const normalizedPrimaryBotId =
      this.resolveOperationalBotId(params.primaryBotId) ?? observedBotIds[0] ?? null;
    const observedTitle = observedManagedEntityTitle(chatId, params.title);
    const title = observedTitle ?? `Chat ${chatId}`;
    const entityType = params.entityType ?? undefined;
    const now = new Date();
    const existing = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { primaryBotId: true, botId: true },
    });
    const existingPrimaryBotId = this.resolveOperationalBotId(
      existing?.primaryBotId ?? existing?.botId ?? null,
    );
    const nextPrimaryBotId = existingPrimaryBotId ?? normalizedPrimaryBotId;
    const catalogKind = resolveChatCatalogKind({
      chatId,
      entityType: entityType ?? null,
      contextOnlyHint: true,
    });
    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title,
        botId: nextPrimaryBotId,
        primaryBotId: nextPrimaryBotId,
        routingState: ChatRoutingState.NO_ELIGIBLE_BOT,
        ...(entityType ? { entityType } : {}),
        catalogKind,
      },
      update: {
        ...(observedTitle ? { title: observedTitle } : {}),
        ...(nextPrimaryBotId ? { botId: nextPrimaryBotId, primaryBotId: nextPrimaryBotId } : {}),
        ...(entityType ? { entityType } : {}),
      },
    });
    await this.updateChatCatalogKindUnlessManaged(chatId, catalogKind);

    for (const observedBotId of observedBotIds) {
      await this.upsertChatBotMembership(chatId, observedBotId, {
        role:
          nextPrimaryBotId === observedBotId
            ? ChatBotMembershipRole.PRIMARY
            : ChatBotMembershipRole.STANDBY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
        preserveRemovedMembership: true,
      });
    }

    if (nextPrimaryBotId && !observedBotIds.includes(nextPrimaryBotId)) {
      await this.upsertChatBotMembership(chatId, nextPrimaryBotId, {
        role: ChatBotMembershipRole.PRIMARY,
        status: ChatBotMembershipStatus.ACTIVE,
        lastSeenAt: now,
        preserveRemovedMembership: true,
      });
    }

    return this.reconcileChatPrimaryByAccess({
      chatId,
      title: observedTitle,
      entityType,
    });
  }

  async reconcileChatPrimaryByAccess(params: {
    chatId: string;
    title?: string | null;
    entityType?: ChatEntityType | null;
  }): Promise<string | null> {
    const chatId = params.chatId.trim();
    if (!chatId) {
      return null;
    }

    const reconciled = await this.reconcileLockedChatRoute({
      chatId,
      title: params.title,
      entityType: params.entityType,
    });
    if (reconciled?.primaryBotId) {
      this.rememberChatBotBinding(chatId, reconciled.primaryBotId);
      return reconciled.primaryBotId;
    }

    this.forgetChatBotBinding(chatId);
    return null;
  }

  async selectChatPrimaryBot(params: {
    chatId: string;
    botId: string;
    title?: string | null;
    entityType?: ChatEntityType | null;
    expectedRoutingVersion?: number;
    expectedAccessEpoch?: {
      checkedAt: Date;
      source: string;
    };
    expectedPreviousOwner?: {
      botId: string;
      accessEpoch: MaxExecutionAccessEpoch;
      purpose: MaxExecutionPurpose;
    };
  }): Promise<boolean> {
    const chatId = params.chatId.trim();
    const botId = this.resolveOperationalBotId(params.botId);
    if (!chatId || !botId) {
      return false;
    }

    const reconciled = await this.reconcileLockedChatRoute({
      chatId,
      title: params.title,
      entityType: params.entityType,
      explicitPrimaryBotId: botId,
      expectedRoutingVersion: params.expectedRoutingVersion,
      expectedAccessEpoch: params.expectedAccessEpoch,
      expectedPreviousOwner: params.expectedPreviousOwner,
    });
    if (reconciled?.primaryBotId !== botId) {
      return false;
    }
    this.rememberChatBotBinding(chatId, botId);
    return true;
  }

  private async reconcileLockedChatRoute(params: {
    chatId: string;
    title?: string | null;
    entityType?: ChatEntityType | null;
    forceVersionBump?: boolean;
    explicitPrimaryBotId?: string;
    expectedRoutingVersion?: number;
    expectedAccessEpoch?: {
      checkedAt: Date;
      source: string;
    };
    expectedPreviousOwner?: {
      botId: string;
      accessEpoch: MaxExecutionAccessEpoch;
      purpose: MaxExecutionPurpose;
    };
  }): Promise<LockedChatRouteReconcileResult | null> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT chat."id"
          FROM "chats" AS chat
          WHERE chat."id" = ${params.chatId}
          FOR UPDATE OF chat
        `);
        if (locked.length !== 1) {
          return null;
        }

        // FLAG: Parent-first locking also fences FK-backed inserts; existing rows use one order.
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT membership."id"
          FROM "chat_bot_memberships" AS membership
          WHERE membership."chat_id" = ${params.chatId}
          ORDER BY membership."bot_id" ASC, membership."id" ASC
          FOR UPDATE OF membership
        `);

        const state = await this.loadChatRouteState(params.chatId, tx);
        if (!state) {
          return null;
        }
        // FLAG: Automatic repair and legacy primary APIs cannot replace a fixed choice.
        // Only the dedicated, versioned administrator assignment transaction may do so.
        if (
          state.fixedModeratorBotId &&
          params.explicitPrimaryBotId &&
          params.explicitPrimaryBotId !== state.fixedModeratorBotId
        )
          return null;
        if (
          params.expectedRoutingVersion !== undefined &&
          state.routingVersion !== params.expectedRoutingVersion
        ) {
          return null;
        }

        // FLAG: A newer healthy-owner probe must defeat a delayed failover decision. Route
        // version alone does not change when an access epoch renews without a role change.
        if (params.expectedPreviousOwner) {
          const previous = state.allMemberships.find(
            (membership) => membership.botId === params.expectedPreviousOwner!.botId,
          );
          const previousAccess = normalizeMembershipAccessSnapshot(previous?.permissionsSnapshot);
          if (
            !previous ||
            !previousAccess ||
            (!isMajorManagedEntityActivationRequired(previous, state.entityType) &&
              (previousAccess.isAdmin || previousAccess.isOwner) &&
              previousAccess.permissionsKnown !== true) ||
            previous.botAccessCheckedAt?.getTime() !==
              params.expectedPreviousOwner.accessEpoch.checkedAt.getTime() ||
            previous.botAccessSource !== params.expectedPreviousOwner.accessEpoch.source ||
            (!isMajorManagedEntityActivationRequired(previous, state.entityType) &&
              hasExecutionCapability(
                previous,
                state.entityType,
                params.expectedPreviousOwner.purpose,
              ))
          )
            return null;
        }

        const explicitMembership = params.explicitPrimaryBotId
          ? (state.activeActionableMemberships.find(
              (membership) => membership.botId === params.explicitPrimaryBotId,
            ) ?? null)
          : null;
        if (
          params.explicitPrimaryBotId &&
          (!explicitMembership ||
            !this.membershipMatchesExpectedAccessEpoch(
              explicitMembership,
              params.expectedAccessEpoch,
            ))
        ) {
          return null;
        }

        const nextRoutingState = params.explicitPrimaryBotId
          ? ChatRoutingState.READY
          : this.resolvePersistedRoutingState(state);
        const preferredPrimaryBotId = params.explicitPrimaryBotId
          ? params.explicitPrimaryBotId
          : (resolvePreferredPrimaryBotId(state.primaryBotId, state.activeActionableMemberships, {
              requireFreshSnapshotForPromotion: true,
            }) ?? state.primaryBotId);
        const nextPrimaryBotId =
          nextRoutingState === ChatRoutingState.NO_ELIGIBLE_BOT ? null : preferredPrimaryBotId;
        const selectedMembership = nextPrimaryBotId
          ? (state.activeActionableMemberships.find(
              (membership) => membership.botId === nextPrimaryBotId,
            ) ?? null)
          : null;
        if (nextPrimaryBotId && !selectedMembership) {
          throw new Error(
            `Chat ${params.chatId} selected an ineligible primary during locked reconciliation`,
          );
        }

        const rolesConsistent = state.allMemberships.every((membership) =>
          nextPrimaryBotId &&
          membership.botId === nextPrimaryBotId &&
          membership.status === ChatBotMembershipStatus.ACTIVE
            ? membership.role === ChatBotMembershipRole.PRIMARY
            : membership.role !== ChatBotMembershipRole.PRIMARY,
        );
        const routeFieldsConsistent =
          state.storedPrimaryBotId === nextPrimaryBotId &&
          state.storedBotId === nextPrimaryBotId &&
          state.routingState === nextRoutingState;
        const title = observedManagedEntityTitle(params.chatId, params.title);
        const entityType = params.entityType ?? null;
        const metadataChanged =
          (title !== null && title !== state.title) ||
          (entityType !== null && entityType !== state.entityType);
        const routingEpochChanged =
          params.forceVersionBump === true || !routeFieldsConsistent || !rolesConsistent;

        if (!routingEpochChanged && !metadataChanged) {
          return {
            primaryBotId: nextPrimaryBotId,
            routingState: nextRoutingState,
            changed: false,
          };
        }

        if (routingEpochChanged || metadataChanged) {
          await tx.chat.update({
            where: { id: params.chatId },
            data: {
              ...(title !== null && title !== state.title ? { title } : {}),
              ...(entityType !== null && entityType !== state.entityType ? { entityType } : {}),
              ...(routingEpochChanged
                ? {
                    botId: nextPrimaryBotId,
                    primaryBotId: nextPrimaryBotId,
                    routingState: nextRoutingState,
                    routingVersion: { increment: 1 },
                  }
                : {}),
            },
          });
        }

        if (!rolesConsistent) {
          await tx.chatBotMembership.updateMany({
            where: {
              chatId: params.chatId,
              role: ChatBotMembershipRole.PRIMARY,
              ...(nextPrimaryBotId
                ? {
                    OR: [
                      { botId: { not: nextPrimaryBotId } },
                      { status: { not: ChatBotMembershipStatus.ACTIVE } },
                    ],
                  }
                : {}),
            },
            data: { role: ChatBotMembershipRole.STANDBY },
          });
          if (nextPrimaryBotId) {
            const promoted = await tx.chatBotMembership.updateMany({
              where: {
                chatId: params.chatId,
                botId: nextPrimaryBotId,
                status: ChatBotMembershipStatus.ACTIVE,
                role: { not: ChatBotMembershipRole.PRIMARY },
              },
              data: { role: ChatBotMembershipRole.PRIMARY },
            });
            if (
              selectedMembership?.role !== ChatBotMembershipRole.PRIMARY &&
              promoted.count !== 1
            ) {
              throw new Error(
                `Chat ${params.chatId} primary membership changed during locked reconciliation`,
              );
            }
          }
        }

        const verified = await this.loadChatRouteState(params.chatId, tx);
        const expectedRoutingVersion = state.routingVersion + (routingEpochChanged ? 1 : 0);
        const routeVerified = Boolean(
          verified &&
          verified.routingVersion === expectedRoutingVersion &&
          verified.routingState === nextRoutingState &&
          verified.storedPrimaryBotId === nextPrimaryBotId &&
          verified.storedBotId === nextPrimaryBotId &&
          (nextPrimaryBotId === null || verified.primaryBotId === nextPrimaryBotId) &&
          this.resolvePersistedRoutingState(verified) === nextRoutingState &&
          verified.allMemberships.every((membership) =>
            nextPrimaryBotId &&
            membership.botId === nextPrimaryBotId &&
            membership.status === ChatBotMembershipStatus.ACTIVE
              ? membership.role === ChatBotMembershipRole.PRIMARY
              : membership.role !== ChatBotMembershipRole.PRIMARY,
          ),
        );
        if (!routeVerified) {
          throw new Error(`Chat ${params.chatId} failed locked route verification`);
        }

        return {
          primaryBotId: nextPrimaryBotId,
          routingState: nextRoutingState,
          changed: routingEpochChanged,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (result) await this.publishCommittedChatRoute(params.chatId);
    return result;
  }

  private async publishCommittedChatRoute(
    chatId: string,
    epoch?: { checkedAt: Date; source: string },
  ): Promise<void> {
    if (!this.routeEpochPublisher) return;
    try {
      // FLAG: SQL commits access/route authority first. Cross-role cache invalidation is
      // advisory and must never hold the parent Chat lock or turn a grant into a failure.
      const chat = await this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { primaryBotId: true, routingVersion: true },
      });
      if (chat)
        await this.routeEpochPublisher.publishChatRouteEpoch({
          chatId,
          routingVersion: chat.routingVersion,
          botId: chat.primaryBotId,
          checkedAt: epoch?.checkedAt,
          source: epoch?.source,
        });
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Committed route cache invalidation failed; SQL execution gates remain authoritative',
      );
    }
  }

  private async resolveDefaultBotRoute(params: {
    chatId?: string | null;
    botId?: string | null;
  }): Promise<MaxBotRoute> {
    const chatId = typeof params.chatId === 'string' ? params.chatId.trim() : '';
    const state = chatId ? await this.loadChatRouteState(chatId) : null;
    if (state?.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      this.forgetChatBotBinding(chatId);
      return this.buildRoute({
        purpose: 'default',
        chatId,
        routingVersion: state.routingVersion,
      });
    }

    const explicitBot = this.getOperationalBotById(params.botId);
    if (explicitBot) {
      return this.buildRoute({
        purpose: 'default',
        chatId,
        botId: explicitBot.id,
        candidateBotIds: [explicitBot.id],
        reason: 'explicit',
      });
    }

    if (chatId) {
      if (state?.primaryBotId) {
        this.rememberChatBotBinding(chatId, state.primaryBotId);
        return this.buildRoute({
          purpose: 'default',
          chatId,
          primaryBotId: state.primaryBotId,
          botId: state.primaryBotId,
          candidateBotIds: [state.primaryBotId],
          reason: 'chat_primary',
        });
      }

      const cachedBotId = this.getCachedChatBotId(chatId);
      if (cachedBotId) {
        const cachedMembership =
          state?.activeOperationalMemberships.find(
            (membership) => membership.botId === cachedBotId,
          ) ?? null;
        if (
          cachedMembership &&
          membershipExplicitlyLacksAccess(cachedMembership.permissionsSnapshot)
        ) {
          return this.buildRoute({
            purpose: 'default',
            chatId,
          });
        }
        return this.buildRoute({
          purpose: 'default',
          chatId,
          primaryBotId: cachedBotId,
          botId: cachedBotId,
          candidateBotIds: [cachedBotId],
          reason: 'chat_cache',
        });
      }
    }

    const contextBotId = this.botContext.getActiveBotId();
    if (contextBotId) {
      return this.buildRoute({
        purpose: 'default',
        chatId,
        botId: contextBotId,
        candidateBotIds: [contextBotId],
        reason: 'context',
      });
    }

    const defaultBotId = this.getEntryBotId();
    return this.buildRoute({
      purpose: 'default',
      chatId,
      botId: defaultBotId,
      candidateBotIds: [defaultBotId],
      reason: 'default',
    });
  }

  private async resolveReadBotRoute(chatId: string): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'read',
        chatId: null,
      });
    }

    const memberAccessRoute = await this.resolveMemberAccessBotRoute(normalizedChatId);
    if (memberAccessRoute.botId) {
      return this.buildRoute({
        purpose: 'read',
        chatId: normalizedChatId,
        primaryBotId: memberAccessRoute.primaryBotId,
        botId: memberAccessRoute.botId,
        candidateBotIds: memberAccessRoute.candidateBotIds,
        reason: memberAccessRoute.reason,
        routingVersion: memberAccessRoute.routingVersion ?? null,
      });
    }

    const defaultRoute = await this.resolveDefaultBotRoute({ chatId: normalizedChatId });
    return this.buildRoute({
      purpose: 'read',
      chatId: normalizedChatId,
      primaryBotId: defaultRoute.primaryBotId,
      botId: defaultRoute.botId,
      candidateBotIds: defaultRoute.candidateBotIds,
      reason: defaultRoute.reason,
      routingVersion: defaultRoute.routingVersion ?? null,
    });
  }

  private async resolveMemberAccessBotRoute(chatId: string): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: null,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    if (!state) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
      });
    }
    if (state.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        routingVersion: state.routingVersion,
      });
    }

    const primaryAdminCapableMembership =
      state.primaryBotId !== null
        ? (state.activeOperationalMemberships.find((membership) => {
            if (membership.botId !== state.primaryBotId) {
              return false;
            }

            const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
            return Boolean(snapshot && (snapshot.isAdmin || snapshot.isOwner));
          }) ?? null)
        : null;
    if (primaryAdminCapableMembership) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: primaryAdminCapableMembership.botId,
        candidateBotIds: [primaryAdminCapableMembership.botId],
        reason: 'primary_confirmed',
      });
    }

    const alternateAdminCapableMembership =
      state.activeOperationalMemberships.find((membership) => {
        if (membership.botId === state.primaryBotId) {
          return false;
        }

        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        return Boolean(snapshot && (snapshot.isAdmin || snapshot.isOwner));
      }) ?? null;
    if (alternateAdminCapableMembership) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: alternateAdminCapableMembership.botId,
        candidateBotIds: [alternateAdminCapableMembership.botId],
        reason: 'alternate_confirmed',
      });
    }

    const primaryActiveMembership =
      state.primaryBotId !== null
        ? (state.activeOperationalMemberships.find(
            (membership) => membership.botId === state.primaryBotId,
          ) ?? null)
        : null;
    if (
      primaryActiveMembership &&
      !membershipExplicitlyLacksAccess(primaryActiveMembership.permissionsSnapshot)
    ) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: primaryActiveMembership.botId,
        candidateBotIds: [primaryActiveMembership.botId],
        reason: 'primary_soft',
      });
    }

    const alternateMembership =
      state.activeOperationalMemberships.find(
        (membership) =>
          membership.botId !== state.primaryBotId &&
          !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
      ) ?? null;
    if (alternateMembership) {
      return this.buildRoute({
        purpose: 'member_access',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        botId: alternateMembership.botId,
        candidateBotIds: [alternateMembership.botId],
        reason: 'alternate_soft',
      });
    }

    const fallbackBotId =
      state.activeOperationalMemberships.find(
        (membership) =>
          membership.botId === state.primaryBotId &&
          !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
      )?.botId ??
      state.activeOperationalMemberships.find(
        (membership) => !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
      )?.botId ??
      null;
    return this.buildRoute({
      purpose: 'member_access',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      botId: fallbackBotId,
      candidateBotIds: fallbackBotId ? [fallbackBotId] : [],
      reason:
        fallbackBotId === null
          ? null
          : fallbackBotId === state.primaryBotId
            ? 'primary_fallback'
            : 'alternate_fallback',
    });
  }

  private async resolveSendMessageBotRoute(
    chatId: string,
    fallbackToPrimary?: boolean,
    allowHalfOpenProbe?: boolean,
    stickyHalfOpenProbeFailureBefore?: string,
  ): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'send_message',
        chatId: null,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    if (!state || state.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      return this.buildRoute({
        purpose: 'send_message',
        chatId: normalizedChatId,
        routingVersion: state?.routingVersion ?? null,
      });
    }

    const candidates = this.buildSendMessageCandidateBotIdsFromState(
      state,
      fallbackToPrimary !== false,
      allowHalfOpenProbe === true,
      stickyHalfOpenProbeFailureBefore,
    );
    const selectedBotId = candidates.candidateBotIds[0] ?? null;
    return this.buildRoute({
      purpose: 'send_message',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      botId: selectedBotId,
      candidateBotIds: candidates.candidateBotIds,
      reason: selectedBotId ? this.resolveSendMessageRouteReason(state, selectedBotId) : null,
      routingVersion: state.routingVersion,
      quarantinedCandidateBotIds: candidates.quarantinedCandidateBotIds,
      halfOpenCandidateBotIds: candidates.halfOpenCandidateBotIds,
      retryAt: candidates.retryAt,
    });
  }

  private async resolveModerationActionBotRoute(
    chatId: string,
    action: ModerationActionPermission,
    fallbackToPrimary?: boolean,
  ): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'moderation_action',
        chatId: null,
        action,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    return this.buildModerationActionBotRouteFromState(state, action, fallbackToPrimary !== false);
  }

  private async resolveCapabilityBotRoute(
    chatId: string,
    capability: ManagedEntityBotCapability,
    fallbackToPrimary?: boolean,
  ): Promise<MaxBotRoute> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: null,
        capability,
      });
    }

    const state = await this.loadChatRouteState(normalizedChatId);
    if (!state || state.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: normalizedChatId,
        routingVersion: state?.routingVersion ?? null,
        capability,
      });
    }

    const candidateBotIds = this.buildCapabilityCandidateBotIdsFromState(
      state,
      capability,
      fallbackToPrimary !== false,
    );
    const selectedBotId = candidateBotIds[0] ?? null;
    if (!selectedBotId) {
      return this.buildRoute({
        purpose: 'capability',
        chatId: normalizedChatId,
        primaryBotId: state.primaryBotId,
        routingVersion: state.routingVersion,
        capability,
      });
    }

    return this.buildRoute({
      purpose: 'capability',
      chatId: normalizedChatId,
      primaryBotId: state.primaryBotId,
      routingVersion: state.routingVersion,
      botId: selectedBotId,
      candidateBotIds,
      reason: selectedBotId === state.primaryBotId ? 'primary_fallback' : 'alternate_confirmed',
      capability,
    });
  }

  async loadChatExecutionOwnerState(chatId: string): Promise<MaxExecutionOwnerState | null> {
    const state = await this.loadChatRouteState(chatId);
    if (!state) return null;
    return {
      chatId: state.chatId,
      entityType: state.entityType,
      primaryBotId: state.storedPrimaryBotId ?? state.storedBotId,
      fixedModeratorBotId: state.fixedModeratorBotId,
      routingVersion: state.routingVersion,
      candidates: state.allMemberships.filter(
        (membership) =>
          membership.status === ChatBotMembershipStatus.ACTIVE &&
          Boolean(this.resolveExecutableBotId(membership.botId)),
      ),
    };
  }

  async resolveDormantReceiptPeer(
    chatId: string,
    botId: string,
    client: Pick<Prisma.TransactionClient, 'chat'> = this.prisma,
    receiptSourceAt?: Date,
  ): Promise<{ dormant: boolean; peerBotId: string | null }> {
    const state = await this.loadChatRouteState(chatId, client);
    const membership = state?.allMemberships.find((row) => row.botId === botId);
    const dormant =
      Boolean(
        receiptSourceAt &&
        (!membership ||
          !isManagedEntityReceiptAfterActivation(membership.permissionsSnapshot, receiptSourceAt)),
      ) || isMajorManagedEntityActivationRequired(membership, state?.entityType);
    if (!state || !dormant) return { dormant, peerBotId: null };
    const ownerState: MaxExecutionOwnerState = {
      chatId,
      entityType: state.entityType,
      primaryBotId: state.primaryBotId,
      routingVersion: state.routingVersion,
      candidates: state.activeActionableMemberships,
      fixedModeratorBotId: state.fixedModeratorBotId,
    };
    const peer = [
      state.primaryBotId,
      ...state.activeActionableMemberships.map((row) => row.botId),
    ].find(
      (candidate) =>
        candidate &&
        executionRouteProof(ownerState, candidate) &&
        (!receiptSourceAt ||
          isManagedEntityReceiptAfterActivation(
            state.allMemberships.find((row) => row.botId === candidate)?.permissionsSnapshot,
            receiptSourceAt,
          )),
    );
    return { dormant, peerBotId: peer ?? null };
  }

  async isChatBotExecutionActivationRequired(
    chatId: string,
    botId: string,
    purpose: MaxExecutionPurpose,
  ): Promise<boolean> {
    const state = await this.loadChatExecutionOwnerState(chatId);
    const membership = state?.candidates.find((candidate) => candidate.botId === botId);
    if (!state || !membership) return false;
    if (isMajorManagedEntityActivationRequired(membership, state.entityType)) return true;
    if (purpose === 'moderation' && state.entityType === ChatEntityType.CHANNEL) return false;
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    return Boolean(
      snapshot &&
      ((snapshot.activationCapabilityCeiling &&
        !snapshot.activationCapabilityCeiling.includes(purpose)) ||
        (snapshot.permissionsKnown === true &&
          !hasExecutionCapability(membership, state.entityType, purpose))),
    );
  }

  async getFreshChatBotExecutionProof(params: {
    chatId: string;
    botId: string;
    purpose?: MaxExecutionPurpose;
    maxAgeMs?: number;
    existingMessage?: { messageId: string; object?: MaxBoundObjectReference };
  }): Promise<MaxExecutionRouteProof | null> {
    const state = await this.loadChatExecutionOwnerState(params.chatId);
    if (!state) return null;
    if (
      state.fixedModeratorBotId &&
      state.fixedModeratorBotId !== params.botId &&
      params.existingMessage &&
      (params.purpose === 'edit_message' || params.purpose === 'delete_message') &&
      (await hasPersistedBoundMessage(this.prisma, {
        chatId: params.chatId,
        botId: params.botId,
        purpose: params.purpose,
        ...params.existingMessage,
      }))
    ) {
      return executionRouteProof(
        { ...state, fixedModeratorBotId: null },
        params.botId,
        params.purpose,
        params.maxAgeMs,
      );
    }
    return executionRouteProof(state, params.botId, params.purpose, params.maxAgeMs);
  }

  async verifyChatExecutionProof(params: {
    chatId: string;
    botId: string;
    routingVersion: number;
    accessEpoch: MaxExecutionAccessEpoch;
    purpose?: MaxExecutionPurpose;
    maxAgeMs?: number;
    existingMessage?: { messageId: string; object?: MaxBoundObjectReference };
  }): Promise<boolean> {
    const proof = await this.getFreshChatBotExecutionProof(params);
    return Boolean(
      proof &&
      proof.routingVersion === params.routingVersion &&
      proof.accessEpoch.checkedAt.getTime() === params.accessEpoch.checkedAt.getTime() &&
      proof.accessEpoch.source === params.accessEpoch.source,
    );
  }

  resolveModerationActionBotRouteFromSnapshot(
    snapshot: MaxChatRouteSnapshot,
    action: ModerationActionPermission,
    fallbackToPrimary = true,
  ): MaxBotRoute {
    return this.buildModerationActionBotRouteFromState(
      this.buildChatRouteState(snapshot),
      action,
      fallbackToPrimary,
    );
  }

  private buildModerationActionBotRouteFromState(
    state: ResolvedChatRouteState | null,
    action: ModerationActionPermission,
    fallbackToPrimary = true,
  ): MaxBotRoute {
    const candidateBotIds =
      state?.routingState === ChatRoutingState.READY
        ? this.buildModerationActionCandidateBotIdsFromState(state, action, fallbackToPrimary)
        : [];
    const selectedBotId = candidateBotIds[0] ?? null;
    return this.buildRoute({
      purpose: 'moderation_action',
      chatId: state?.chatId ?? null,
      primaryBotId: state?.primaryBotId ?? null,
      botId: selectedBotId,
      candidateBotIds,
      routingVersion: state?.routingVersion ?? null,
      reason:
        state && selectedBotId
          ? this.resolveModerationActionRouteReason(state, selectedBotId, action)
          : null,
      action,
    });
  }

  private async loadChatRouteState(
    chatId: string,
    client: Pick<ChatRouteTransactionClient, 'chat'> = this.prisma,
  ): Promise<ResolvedChatRouteState | null> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return null;
    }

    const chat = await client.chat.findUnique({
      where: { id: normalizedChatId },
      select: {
        title: true,
        entityType: true,
        routingState: true,
        routingVersion: true,
        primaryBotId: true,
        fixedModeratorBotId: true,
        botId: true,
        botMemberships: {
          select: {
            botId: true,
            role: true,
            status: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessExpiresAt: true,
            botAccessSource: true,
            lifecycleEventAt: true,
            lifecycleEventType: true,
            lifecycleSource: true,
            permissionsSnapshot: true,
            capabilities: true,
            sendRouteFailureCount: true,
            sendRouteQuarantinedUntil: true,
            sendRouteLastFailureAt: true,
            sendRouteLastFailureCode: true,
          },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!chat) {
      return null;
    }

    return this.buildChatRouteState({ ...chat, chatId: normalizedChatId });
  }

  private buildChatRouteState(chat: MaxChatRouteSnapshot): ResolvedChatRouteState {
    const normalizedChatId = chat.chatId.trim();
    const allMemberships: ResolvedChatRouteMembership[] = chat.botMemberships.map((membership) => ({
      botAccessCheckedAt: null,
      botAccessExpiresAt: null,
      botAccessSource: null,
      lifecycleEventAt: null,
      lifecycleEventType: null,
      lifecycleSource: null,
      capabilities: [],
      sendRouteFailureCount: 0,
      sendRouteQuarantinedUntil: null,
      sendRouteLastFailureAt: null,
      sendRouteLastFailureCode: null,
      ...membership,
    }));
    const memberships = allMemberships.filter((membership) =>
      Boolean(this.botRegistry.getBotById(membership.botId)),
    );
    const activeKnownMemberships = memberships.filter(
      (membership) =>
        membership.status === ChatBotMembershipStatus.ACTIVE &&
        !isMajorManagedEntityActivationRequired(membership, chat.entityType) &&
        Boolean(this.resolveOperationalBotId(membership.botId)),
    );
    const activeOperationalMemberships = activeKnownMemberships.filter((membership) => {
      const bot = this.botRegistry.getBotById(membership.botId);
      return Boolean(bot && canDiscoverChatsForBotState(bot.state));
    });
    const activeActionableMemberships = activeKnownMemberships.filter((membership) => {
      const bot = this.botRegistry.getBotById(membership.botId);
      return Boolean(
        bot &&
        (!chat.fixedModeratorBotId || membership.botId === chat.fixedModeratorBotId) &&
        canExecuteActionsForBotState(bot.state) &&
        this.isMembershipRouteAccessEligible(membership),
      );
    });
    const accessEligibleActiveActionableMemberships = activeActionableMemberships;
    const storedPrimaryBotId = chat.primaryBotId ?? null;
    const storedBotId = chat.botId ?? null;
    const rawStoredExecutableBotId =
      this.resolveExecutableBotId(chat.primaryBotId ?? null) ??
      this.resolveExecutableBotId(chat.botId ?? null);
    const storedExecutableMembership = rawStoredExecutableBotId
      ? (activeActionableMemberships.find(
          (membership) => membership.botId === rawStoredExecutableBotId,
        ) ?? null)
      : null;
    const storedExecutableBotId =
      rawStoredExecutableBotId &&
      storedExecutableMembership &&
      this.isMembershipRouteAccessEligible(storedExecutableMembership)
        ? rawStoredExecutableBotId
        : null;
    const preferredPrimaryBotId =
      resolvePreferredPrimaryBotId(storedExecutableBotId, activeActionableMemberships, {
        requireFreshSnapshotForPromotion: true,
      }) ??
      storedExecutableBotId ??
      accessEligibleActiveActionableMemberships.find(
        (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
      )?.botId ??
      accessEligibleActiveActionableMemberships[0]?.botId ??
      null;
    const primaryBotId = preferredPrimaryBotId;
    if (chat.routingState === ChatRoutingState.NO_ELIGIBLE_BOT) {
      // Selection is pure; authorization reads still validate the SQL route version.
    }

    return {
      chatId: normalizedChatId,
      title: chat.title ?? `Chat ${normalizedChatId}`,
      entityType: chat.entityType ?? null,
      routingState: chat.routingState,
      hasStoredBotAssignment: Boolean(chat.primaryBotId || chat.botId),
      storedPrimaryBotId,
      storedBotId,
      primaryBotId,
      fixedModeratorBotId: chat.fixedModeratorBotId ?? null,
      routingVersion: chat.routingVersion,
      allMemberships,
      memberships,
      activeKnownMemberships,
      activeOperationalMemberships,
      activeActionableMemberships,
    };
  }

  private buildModerationActionCandidateBotIdsFromState(
    state: ResolvedChatRouteState,
    action: ModerationActionPermission,
    fallbackToPrimary = true,
  ): string[] {
    const candidateBotIds: string[] = [];
    const pushCandidate = (botId: string | null | undefined) => {
      const normalizedBotId = this.resolveExecutableBotId(botId);
      if (!normalizedBotId || candidateBotIds.includes(normalizedBotId)) {
        return;
      }
      candidateBotIds.push(normalizedBotId);
    };

    pushCandidate(
      state.activeActionableMemberships.find((membership) => {
        if (membership.botId !== state.primaryBotId) {
          return false;
        }

        const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        return this.hasModerationActionPermission(snapshot, action, state.entityType);
      })?.botId ?? null,
    );
    for (const membership of state.activeActionableMemberships) {
      const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
      if (this.hasModerationActionPermission(snapshot, action, state.entityType)) {
        pushCandidate(membership.botId);
      }
    }

    const primaryActiveMembership =
      state.primaryBotId !== null
        ? (state.activeActionableMemberships.find(
            (membership) => membership.botId === state.primaryBotId,
          ) ?? null)
        : null;
    if (
      primaryActiveMembership &&
      !this.membershipExplicitlyLacksModerationAction(
        primaryActiveMembership.permissionsSnapshot,
        action,
        state.entityType,
      )
    ) {
      pushCandidate(primaryActiveMembership.botId);
    }

    for (const membership of state.activeActionableMemberships) {
      if (
        membership.botId === state.primaryBotId ||
        this.membershipExplicitlyLacksModerationAction(
          membership.permissionsSnapshot,
          action,
          state.entityType,
        )
      ) {
        continue;
      }
      pushCandidate(membership.botId);
    }

    if (fallbackToPrimary !== false) {
      const pushFallbackCandidate = (botId: string | null | undefined) => {
        const normalizedBotId = this.resolveExecutableBotId(botId);
        if (!normalizedBotId) {
          return;
        }

        const membership =
          state.activeActionableMemberships.find((item) => item.botId === normalizedBotId) ?? null;
        if (
          membership &&
          (this.membershipExplicitlyLacksModerationAction(
            membership.permissionsSnapshot,
            action,
            state.entityType,
          ) ||
            this.membershipSnapshotMarksActionLimited(
              membership.permissionsSnapshot,
              action,
              state.entityType,
            ))
        ) {
          return;
        }

        pushCandidate(normalizedBotId);
      };

      pushFallbackCandidate(state.primaryBotId);
      pushFallbackCandidate(state.activeActionableMemberships[0]?.botId ?? null);
    }

    return candidateBotIds;
  }

  private orderSendMessageCandidatesByRouteHealth(
    state: ResolvedChatRouteState,
    candidateBotIds: string[],
    allowHalfOpenProbe = false,
    stickyHalfOpenProbeFailureBefore?: string,
  ): {
    candidateBotIds: string[];
    quarantinedCandidateBotIds: string[];
    halfOpenCandidateBotIds: string[];
    retryAt: Date | null;
  } {
    const nowMs = Date.now();
    const stickyFailureBeforeMs =
      this.parseStrictIsoDate(stickyHalfOpenProbeFailureBefore)?.getTime() ?? Number.NaN;
    const membershipsByBotId = new Map(
      state.activeActionableMemberships.map((membership) => [membership.botId, membership]),
    );
    // FLAG: A disappearance quarantine is an execution fence, not a preference. Falling back to
    // the only quarantined bot would repeat a send that MAX accepted but did not retain. The
    // repeated-disappearance circuit stays open after its minimum TTL until a newer stable
    // observation, controlled operator recovery, or an exact newer night session authorizes one
    // verified probe. A first failure gets one half-open attempt after the TTL.
    const executableCandidateBotIds: string[] = [];
    const halfOpenCandidateBotIds: string[] = [];
    const quarantinedCandidateBotIds: string[] = [];
    let retryAtMs = Number.POSITIVE_INFINITY;
    for (const botId of candidateBotIds) {
      const membership = membershipsByBotId.get(botId);
      const quarantinedUntilMs = membership?.sendRouteQuarantinedUntil?.getTime() ?? 0;
      const stickyDisappearance =
        membership?.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
        membership.sendRouteFailureCount >= SEND_ROUTE_STICKY_DISAPPEARANCE_THRESHOLD;
      const stickyHalfOpenDisappearance =
        stickyDisappearance &&
        allowHalfOpenProbe &&
        Number.isFinite(stickyFailureBeforeMs) &&
        stickyFailureBeforeMs <= nowMs &&
        membership?.sendRouteLastFailureAt instanceof Date &&
        membership.sendRouteLastFailureAt.getTime() < stickyFailureBeforeMs &&
        quarantinedUntilMs <= nowMs;
      const halfOpenDisappearance =
        membership?.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
        membership.sendRouteFailureCount === 1 &&
        quarantinedUntilMs <= nowMs;
      const activeTimedQuarantine = quarantinedUntilMs > nowMs;
      if (halfOpenDisappearance || stickyHalfOpenDisappearance) {
        if (allowHalfOpenProbe) {
          halfOpenCandidateBotIds.push(botId);
        } else {
          quarantinedCandidateBotIds.push(botId);
          retryAtMs = Math.min(retryAtMs, nowMs + SEND_ROUTE_OPEN_CIRCUIT_RECHECK_MS);
        }
        continue;
      }
      if (!stickyDisappearance && !activeTimedQuarantine) {
        executableCandidateBotIds.push(botId);
        continue;
      }
      quarantinedCandidateBotIds.push(botId);
      retryAtMs = Math.min(
        retryAtMs,
        stickyDisappearance
          ? Math.max(quarantinedUntilMs, nowMs + MAX_SEND_ROUTE_QUARANTINE_MS)
          : quarantinedUntilMs,
      );
    }
    if (executableCandidateBotIds.length > 0) {
      return {
        candidateBotIds: executableCandidateBotIds,
        quarantinedCandidateBotIds: [...quarantinedCandidateBotIds, ...halfOpenCandidateBotIds],
        halfOpenCandidateBotIds: [],
        retryAt: Number.isFinite(retryAtMs) ? new Date(retryAtMs) : null,
      };
    }
    const halfOpenCandidateBotId = halfOpenCandidateBotIds[0] ?? null;
    return {
      candidateBotIds: halfOpenCandidateBotId ? [halfOpenCandidateBotId] : [],
      quarantinedCandidateBotIds: [
        ...quarantinedCandidateBotIds,
        ...halfOpenCandidateBotIds.slice(1),
      ],
      halfOpenCandidateBotIds: halfOpenCandidateBotId ? [halfOpenCandidateBotId] : [],
      retryAt: Number.isFinite(retryAtMs) ? new Date(retryAtMs) : null,
    };
  }

  private resolvePersistedRoutingState(state: ResolvedChatRouteState): ChatRoutingState {
    if (
      state.activeActionableMemberships.some((membership) =>
        this.isMembershipConfirmedRoutingEligible(membership),
      )
    ) {
      return ChatRoutingState.READY;
    }
    if (state.activeActionableMemberships.length === 0) {
      return ChatRoutingState.NO_ELIGIBLE_BOT;
    }
    return state.routingState;
  }

  private isMembershipConfirmedRoutingEligible(membership: ResolvedChatRouteMembership): boolean {
    if (!this.isMembershipRouteAccessEligible(membership)) {
      return false;
    }
    if (
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
    ) {
      return false;
    }

    return isConfirmedMembershipAccessSnapshot(
      normalizeMembershipAccessSnapshot(membership.permissionsSnapshot),
    );
  }

  private buildSendMessageCandidateBotIdsFromState(
    state: ResolvedChatRouteState,
    fallbackToPrimary = true,
    allowHalfOpenProbe = false,
    stickyHalfOpenProbeFailureBefore?: string,
  ): {
    candidateBotIds: string[];
    quarantinedCandidateBotIds: string[];
    halfOpenCandidateBotIds: string[];
    retryAt: Date | null;
  } {
    const candidateBotIds: string[] = [];
    const pushCandidate = (botId: string | null | undefined) => {
      const normalizedBotId = this.resolveExecutableBotId(botId);
      if (!normalizedBotId || candidateBotIds.includes(normalizedBotId)) {
        return;
      }
      candidateBotIds.push(normalizedBotId);
    };

    const primaryMembership =
      state.primaryBotId !== null
        ? (state.activeActionableMemberships.find(
            (membership) => membership.botId === state.primaryBotId,
          ) ?? null)
        : null;
    const primarySnapshot = normalizeMembershipAccessSnapshot(
      primaryMembership?.permissionsSnapshot,
    );
    if (this.hasConfirmedSendMessageAccess(primarySnapshot, state.entityType)) {
      pushCandidate(primaryMembership?.botId);
    }

    const confirmedAlternates = state.activeActionableMemberships
      .map((membership, index) => ({
        membership,
        index,
        snapshot: normalizeMembershipAccessSnapshot(membership.permissionsSnapshot),
      }))
      .filter(
        (candidate) =>
          candidate.membership.botId !== state.primaryBotId &&
          this.hasConfirmedSendMessageAccess(candidate.snapshot, state.entityType),
      )
      .sort((left, right) => {
        const leftScore = left.snapshot?.isOwner ? 2 : 1;
        const rightScore = right.snapshot?.isOwner ? 2 : 1;
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return left.index - right.index;
      });
    for (const candidate of confirmedAlternates) {
      pushCandidate(candidate.membership.botId);
    }

    if (
      primaryMembership &&
      !this.membershipExplicitlyLacksSendMessageAccess(
        primaryMembership.permissionsSnapshot,
        state.entityType,
      )
    ) {
      pushCandidate(primaryMembership.botId);
    }

    for (const membership of state.activeActionableMemberships) {
      if (
        membership.botId === state.primaryBotId ||
        this.membershipExplicitlyLacksSendMessageAccess(
          membership.permissionsSnapshot,
          state.entityType,
        )
      ) {
        continue;
      }
      pushCandidate(membership.botId);
    }

    if (fallbackToPrimary !== false) {
      const pushFallbackCandidate = (botId: string | null | undefined) => {
        const normalizedBotId = this.resolveExecutableBotId(botId);
        if (!normalizedBotId) {
          return;
        }

        const membership =
          state.activeActionableMemberships.find((item) => item.botId === normalizedBotId) ?? null;
        if (
          membership &&
          this.membershipExplicitlyLacksSendMessageAccess(
            membership.permissionsSnapshot,
            state.entityType,
          )
        ) {
          return;
        }

        pushCandidate(normalizedBotId);
      };

      pushFallbackCandidate(state.primaryBotId);
      pushFallbackCandidate(state.activeActionableMemberships[0]?.botId ?? null);
    }

    return this.orderSendMessageCandidatesByRouteHealth(
      state,
      candidateBotIds,
      allowHalfOpenProbe,
      stickyHalfOpenProbeFailureBefore,
    );
  }

  private parseStrictIsoDate(value: string | undefined): Date | null {
    if (!value) {
      return null;
    }
    const parsedMs = Date.parse(value);
    if (!Number.isFinite(parsedMs)) {
      return null;
    }
    const parsed = new Date(parsedMs);
    return parsed.toISOString() === value ? parsed : null;
  }

  private buildCapabilityCandidateBotIdsFromState(
    state: ResolvedChatRouteState,
    capability: ManagedEntityBotCapability,
    fallbackToPrimary = true,
  ): string[] {
    const candidateBotIds: string[] = [];
    const pushCandidate = (botId: string | null | undefined) => {
      const normalizedBotId = this.resolveExecutableBotId(botId);
      if (!normalizedBotId || candidateBotIds.includes(normalizedBotId)) {
        return;
      }
      candidateBotIds.push(normalizedBotId);
    };

    for (const membership of state.activeActionableMemberships) {
      if (membership.role === ChatBotMembershipRole.PRIMARY) {
        continue;
      }
      if (membershipExplicitlyLacksAccess(membership.permissionsSnapshot)) {
        continue;
      }
      if (!this.normalizeBotCapabilities(membership.capabilities).includes(capability)) {
        continue;
      }
      pushCandidate(membership.botId);
    }

    if (fallbackToPrimary !== false) {
      const primaryMembership =
        state.primaryBotId !== null
          ? (state.activeActionableMemberships.find(
              (membership) => membership.botId === state.primaryBotId,
            ) ?? null)
          : null;
      if (
        !primaryMembership ||
        !membershipExplicitlyLacksAccess(primaryMembership.permissionsSnapshot)
      ) {
        pushCandidate(state.primaryBotId);
      }
    }

    return candidateBotIds;
  }

  private resolveSendMessageRouteReason(
    state: ResolvedChatRouteState,
    botId: string,
  ): MaxBotRouteReason {
    const membership =
      state.activeActionableMemberships.find((item) => item.botId === botId) ?? null;
    const hasConfirmedAccess = this.hasConfirmedSendMessageAccess(
      normalizeMembershipAccessSnapshot(membership?.permissionsSnapshot),
      state.entityType,
    );

    if (botId === state.primaryBotId) {
      return hasConfirmedAccess ? 'primary_confirmed' : 'primary_soft';
    }

    return hasConfirmedAccess ? 'alternate_confirmed' : 'alternate_soft';
  }

  private resolveModerationActionRouteReason(
    state: ResolvedChatRouteState,
    botId: string,
    action: ModerationActionPermission,
  ): MaxBotRouteReason {
    if (botId === state.primaryBotId) {
      const primaryMembership =
        state.activeActionableMemberships.find((membership) => membership.botId === botId) ?? null;
      const primarySnapshot = normalizeMembershipAccessSnapshot(
        primaryMembership?.permissionsSnapshot,
      );
      if (this.hasModerationActionPermission(primarySnapshot, action, state.entityType)) {
        return 'primary_confirmed';
      }
      if (
        primaryMembership &&
        !this.membershipExplicitlyLacksModerationAction(
          primaryMembership.permissionsSnapshot,
          action,
          state.entityType,
        )
      ) {
        return 'primary_soft';
      }
      return 'primary_fallback';
    }

    const selectedMembership =
      state.activeActionableMemberships.find((membership) => membership.botId === botId) ?? null;
    const selectedSnapshot = normalizeMembershipAccessSnapshot(
      selectedMembership?.permissionsSnapshot,
    );
    if (this.hasModerationActionPermission(selectedSnapshot, action, state.entityType)) {
      return 'alternate_confirmed';
    }
    if (
      selectedMembership &&
      !this.membershipExplicitlyLacksModerationAction(
        selectedMembership.permissionsSnapshot,
        action,
        state.entityType,
      )
    ) {
      return 'alternate_soft';
    }
    return 'alternate_fallback';
  }

  private buildRoute(params: {
    purpose: MaxBotRoutePurpose;
    chatId?: string | null;
    primaryBotId?: string | null;
    botId?: string | null;
    candidateBotIds?: Array<string | null | undefined>;
    reason?: MaxBotRouteReason | null;
    routingVersion?: number | null;
    action?: ModerationActionPermission;
    capability?: ManagedEntityBotCapability;
    quarantinedCandidateBotIds?: Array<string | null | undefined>;
    halfOpenCandidateBotIds?: Array<string | null | undefined>;
    retryAt?: Date | null;
  }): MaxBotRoute {
    const normalizedChatId =
      typeof params.chatId === 'string' && params.chatId.trim().length > 0
        ? params.chatId.trim()
        : null;
    const normalizedPrimaryBotId = this.resolveOperationalBotId(params.primaryBotId);
    const normalizeRouteBotId = (botId: string | null | undefined) =>
      this.isExecutableRoutePurpose(params.purpose)
        ? this.resolveExecutableBotId(botId)
        : this.resolveOperationalBotId(botId);
    const normalizedBotId = normalizeRouteBotId(params.botId);
    const normalizedCandidateBotIds = Array.from(
      new Set(
        (params.candidateBotIds ?? [])
          .map((botId) => normalizeRouteBotId(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    const candidateBotIds =
      normalizedBotId && !normalizedCandidateBotIds.includes(normalizedBotId)
        ? [normalizedBotId, ...normalizedCandidateBotIds]
        : normalizedCandidateBotIds;
    const botId = normalizedBotId ?? candidateBotIds[0] ?? null;
    const routeReason = botId ? (params.reason ?? null) : null;
    const baseRoute = {
      purpose: params.purpose,
      chatId: normalizedChatId,
      primaryBotId: normalizedPrimaryBotId,
      botId,
      candidateBotIds,
      reason: routeReason,
      ...(params.routingVersion !== undefined ? { routingVersion: params.routingVersion } : {}),
    };

    if (params.purpose === 'moderation_action') {
      return {
        ...baseRoute,
        purpose: 'moderation_action',
        action: params.action ?? 'delete_message',
      };
    }

    if (params.purpose === 'capability') {
      return {
        ...baseRoute,
        purpose: 'capability',
        capability: params.capability ?? 'access_prewarm',
      };
    }

    if (params.purpose === 'send_message') {
      return {
        ...baseRoute,
        purpose: 'send_message',
        quarantinedCandidateBotIds: Array.from(
          new Set(
            (params.quarantinedCandidateBotIds ?? [])
              .map((botId) => this.resolveExecutableBotId(botId))
              .filter((botId): botId is string => Boolean(botId)),
          ),
        ),
        halfOpenCandidateBotIds: Array.from(
          new Set(
            (params.halfOpenCandidateBotIds ?? [])
              .map((botId) => this.resolveExecutableBotId(botId))
              .filter((botId): botId is string => Boolean(botId)),
          ),
        ),
        retryAt: params.retryAt ?? null,
      };
    }

    return {
      ...baseRoute,
      purpose: params.purpose,
    };
  }

  private isExecutableRoutePurpose(purpose: MaxBotRoutePurpose): boolean {
    return (
      purpose === 'send_message' || purpose === 'moderation_action' || purpose === 'capability'
    );
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === code;
    }

    return (error as { code?: string } | null)?.code === code;
  }

  private getCachedChatBotId(chatId: string | null | undefined): string | null {
    const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
    if (!normalizedChatId) {
      return null;
    }

    const cached = this.chatBotBindingCache.get(normalizedChatId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAtMs < Date.now()) {
      this.chatBotBindingCache.delete(normalizedChatId);
      return null;
    }

    return cached.botId;
  }

  private normalizeBotCapabilities(value: unknown): ManagedEntityBotCapability[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const supported = new Set<ManagedEntityBotCapability>([
      'background_scans',
      'channel_stats',
      'suggestion_delivery',
      'membership_prewarm',
      'access_prewarm',
    ]);

    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item): item is ManagedEntityBotCapability =>
            supported.has(item as ManagedEntityBotCapability),
          ),
      ),
    );
  }

  private hasModerationActionPermission(
    snapshot: MembershipAccessSnapshot | null,
    action: ModerationActionPermission,
    entityType: ChatEntityType | null,
  ): boolean {
    if (!snapshot) {
      return false;
    }

    const purpose =
      action === 'delete_message' || action === 'edit_message' ? action : 'moderate_member';
    if (
      snapshot.activationCapabilityCeiling &&
      !snapshot.activationCapabilityCeiling.includes(purpose)
    )
      return false;

    if (action === 'delete_message') {
      return hasConfirmedDeleteMessageAccess(snapshot, entityType);
    }

    if (action === 'edit_message') {
      return hasConfirmedEditMessageAccess(snapshot, entityType);
    }

    if (snapshot.isOwner) {
      return true;
    }

    if (snapshot.permissions.length === 0) {
      return snapshot.isAdmin;
    }

    return snapshot.permissions.some((permission) =>
      this.isModerationActionPermission(permission, action, entityType),
    );
  }

  private assessDeleteMessageCandidateCapability(
    membership: ResolvedChatRouteMembership,
    entityType: ChatEntityType | null,
    actionable: boolean,
  ): MaxDeleteMessageCandidateCapability {
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    const snapshotCheckedAtMs = snapshot?.checkedAt ? Date.parse(snapshot.checkedAt) : Number.NaN;
    const membershipCheckedAtMs = membership.botAccessCheckedAt?.getTime() ?? Number.NaN;
    const checkedAtMs = Number.isFinite(membershipCheckedAtMs)
      ? membershipCheckedAtMs
      : snapshotCheckedAtMs;
    const expiresAtMs = membership.botAccessExpiresAt?.getTime() ?? Number.NaN;
    const checkedAt = Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : null;
    const expiresAt = Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null;
    const result = (
      state: MaxDeleteMessageCapabilityState,
      reason: MaxDeleteMessageCapabilityReason,
      routeEligible = false,
    ): MaxDeleteMessageCandidateCapability => ({
      botId: membership.botId,
      state,
      reason,
      checkedAt,
      expiresAt,
      routeEligible,
    });

    if (isMajorManagedEntityActivationRequired(membership, entityType)) {
      return result('explicitly_incapable', 'access_denied');
    }
    if (!snapshot) {
      return result('stale_or_unknown', 'snapshot_missing', actionable);
    }

    const nowMs = Date.now();
    const fresh =
      Number.isFinite(checkedAtMs) &&
      checkedAtMs <= nowMs &&
      isConfirmedMembershipAccessSnapshot(snapshot, { nowMs });
    if (!fresh) {
      return result('stale_or_unknown', 'snapshot_stale', actionable);
    }

    const permissionFailure = resolveDeleteMessageAccessFailure(snapshot, entityType);
    if (permissionFailure) {
      if (permissionFailure === 'entity_type_unknown') {
        return result('stale_or_unknown', permissionFailure);
      }
      return result('explicitly_incapable', permissionFailure);
    }
    if (
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER
    ) {
      return result('stale_or_unknown', 'access_state_unconfirmed', actionable);
    }
    if (!actionable) {
      return result('stale_or_unknown', 'bot_not_actionable');
    }

    return result('confirmed_capable', 'confirmed', true);
  }

  private buildEmptyDeleteMessageBotRoute(
    chatId: string | null,
    reason: 'chat_not_found' | 'no_active_membership',
  ): MaxDeleteMessageBotRoute {
    return {
      purpose: 'moderation_action',
      action: 'delete_message',
      chatId,
      entityType: null,
      routingState: null,
      routingVersion: null,
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      reason: null,
      capabilityState: 'stale_or_unknown',
      capabilityReason: reason,
      checkedAt: null,
      expiresAt: null,
      candidateCapabilities: [],
    };
  }

  private hasConfirmedSendMessageAccess(
    snapshot: MembershipAccessSnapshot | null,
    entityType: ChatEntityType | null,
  ): boolean {
    if (
      !snapshot ||
      (snapshot.activationCapabilityCeiling &&
        !snapshot.activationCapabilityCeiling.includes('send_message'))
    ) {
      return false;
    }
    if (snapshot.isOwner) {
      return true;
    }
    if (entityType !== ChatEntityType.CHANNEL) {
      return snapshot.isAdmin;
    }
    return snapshot.permissions.some((permission) =>
      WRITE_MESSAGE_PERMISSION_ALIASES.has(normalizePermissionName(permission)),
    );
  }

  private hasConfirmedManagedPollAccess(
    snapshot: MembershipAccessSnapshot | null,
    entityType: ChatEntityType | null,
  ): boolean {
    if (!this.hasConfirmedSendMessageAccess(snapshot, entityType)) {
      return false;
    }
    if (entityType === ChatEntityType.CHANNEL) {
      if (!this.hasModerationActionPermission(snapshot, 'edit_message', ChatEntityType.CHANNEL)) {
        return false;
      }
      if (snapshot?.isOwner) {
        return true;
      }
    } else if (entityType === ChatEntityType.CHAT) {
      if (snapshot?.isOwner) {
        return true;
      }
      if (
        !snapshot?.permissions.some((permission) =>
          WRITE_MESSAGE_PERMISSION_ALIASES.has(normalizePermissionName(permission)),
        )
      ) {
        return false;
      }
    } else {
      return true;
    }

    return (
      snapshot?.permissions.some((permission) =>
        READ_ALL_MESSAGES_PERMISSION_ALIASES.has(normalizePermissionName(permission)),
      ) ?? false
    );
  }

  private hasFreshManagedPollAccessSnapshot(
    _membership: Pick<ResolvedChatRouteMembership, 'botAccessExpiresAt'>,
    snapshot: MembershipAccessSnapshot | null,
  ): boolean {
    return isConfirmedMembershipAccessSnapshot(snapshot);
  }

  private membershipExplicitlyLacksSendMessageAccess(
    value: unknown,
    entityType: ChatEntityType | null,
  ): boolean {
    const snapshot = normalizeMembershipAccessSnapshot(value);
    if (!snapshot) {
      return false;
    }
    if (
      entityType === ChatEntityType.CHANNEL &&
      snapshot.isAdmin &&
      snapshot.permissions.length === 0 &&
      !this.membershipPermissionsAreKnown(value)
    ) {
      return false;
    }
    return !this.hasConfirmedSendMessageAccess(snapshot, entityType);
  }

  private membershipPermissionsAreKnown(value: unknown): boolean {
    return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).permissionsKnown === true,
    );
  }

  private membershipExplicitlyLacksModerationAction(
    value: unknown,
    action: ModerationActionPermission,
    entityType: ChatEntityType | null,
  ): boolean {
    const snapshot = normalizeMembershipAccessSnapshot(value);
    if (!snapshot) {
      return false;
    }

    return !this.hasModerationActionPermission(snapshot, action, entityType);
  }

  private membershipSnapshotMarksActionLimited(
    value: unknown,
    action: ModerationActionPermission,
    _entityType: ChatEntityType | null,
  ): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const row = value as Record<string, unknown>;
    if (row.health !== 'action_limited') {
      return false;
    }

    const missingActions = Array.isArray(row.missingActions) ? row.missingActions : [];
    return missingActions.some((item) => item === action);
  }

  private isModerationActionPermission(
    permission: string,
    action: ModerationActionPermission,
    _entityType?: ChatEntityType | null,
  ): boolean {
    const normalized = normalizePermissionName(permission);
    if (!normalized) {
      return false;
    }

    if (action === 'delete_message' || action === 'edit_message') {
      return false;
    }

    return MODERATE_MEMBER_PERMISSION_ALIASES.has(normalized);
  }

  private async updateChatCatalogKindUnlessManaged(
    chatId: string,
    catalogKind: ChatCatalogKind,
  ): Promise<void> {
    if (catalogKind === ChatCatalogKind.MANAGED) {
      await this.prisma.chat.update({
        where: { id: chatId },
        data: { catalogKind },
      });
      return;
    }

    // FLAG: A concurrent confirmed roster promotion must win over discovery/removal metadata.
    await this.prisma.chat.updateMany({
      where: {
        id: chatId,
        catalogKind: { not: ChatCatalogKind.MANAGED },
      },
      data: { catalogKind },
    });
  }

  private async upsertChatBotMembership(
    chatId: string,
    botId: string,
    params: {
      role: ChatBotMembershipRole;
      status: ChatBotMembershipStatus;
      lastSeenAt?: Date | null;
      lastWebhookAt?: Date | null;
      lifecycleEventAt?: Date | null;
      lifecycleEventType?: string | null;
      lifecycleSource?: string | null;
      allowReactivation?: boolean;
      preserveRemovedMembership?: boolean;
    },
  ): Promise<ChatBotMembershipUpsertResult> {
    const isActiveOperational =
      params.status === ChatBotMembershipStatus.ACTIVE &&
      Boolean(this.resolveOperationalBotId(botId));
    const nextStatus = isActiveOperational
      ? ChatBotMembershipStatus.ACTIVE
      : params.status === ChatBotMembershipStatus.ACTIVE
        ? ChatBotMembershipStatus.REMOVED
        : params.status;
    const nextRole = isActiveOperational ? params.role : ChatBotMembershipRole.STANDBY;

    const lifecycleEventAt = params.lifecycleEventAt ?? null;
    const lifecycleEventType = params.lifecycleEventType?.trim() || null;
    const lifecycleSource = params.lifecycleSource?.trim() || null;

    if (
      nextStatus === ChatBotMembershipStatus.ACTIVE &&
      lifecycleEventAt &&
      lifecycleEventType &&
      params.allowReactivation === true
    ) {
      const reactivationAccessFence =
        lifecycleSource === 'live_probe'
          ? {
              OR: [
                { botAccessCheckedAt: null },
                { botAccessCheckedAt: { lt: lifecycleEventAt } },
                {
                  botAccessCheckedAt: lifecycleEventAt,
                  botAccessState: {
                    in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
                  },
                },
              ],
            }
          : {
              OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lt: lifecycleEventAt } }],
            };
      const reactivationWhere = {
        chatId,
        botId,
        // FLAG: A lifecycle observation never clears administrator activation intent.
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: { notIn: [...MANAGED_ENTITY_DORMANT_ACCESS_STATES] },
        AND: [
          {
            OR: [{ lifecycleEventAt: null }, { lifecycleEventAt: { lt: lifecycleEventAt } }],
          },
          reactivationAccessFence,
        ],
      };
      const reactivationData = {
        role: nextRole,
        status: ChatBotMembershipStatus.ACTIVE,
        ...(lifecycleSource === 'live_probe'
          ? {}
          : {
              // FLAG: bot_added invalidates freshness, never known loss or the
              // retained purpose ceiling. Only an authenticated action clears those.
              botAccessExpiresAt: lifecycleEventAt,
            }),
        lastSeenAt: params.lastSeenAt ?? lifecycleEventAt,
        lastWebhookAt: params.lastWebhookAt ?? lifecycleEventAt,
        lifecycleEventAt,
        lifecycleEventType,
        lifecycleSource,
      };
      let updated = await this.prisma.chatBotMembership.updateMany({
        where: reactivationWhere,
        data: reactivationData,
      });
      if (updated.count > 0) {
        return { active: true, lifecycleAdvanced: true };
      }

      // FLAG: Creation races retry the timestamp CAS; equal timestamps remain removal-wins.
      const created = await this.runChatMembershipWriteWithDeadlockRetry(
        () =>
          this.prisma.chatBotMembership.createMany({
            data: {
              chatId,
              botId,
              ...reactivationData,
              botAccessSource: MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE,
            },
            skipDuplicates: true,
          }),
        'upsertChatBotMembership.reactivationCreate',
      );
      if (created.count > 0) {
        return { active: true, lifecycleAdvanced: true };
      }

      updated = await this.prisma.chatBotMembership.updateMany({
        where: reactivationWhere,
        data: reactivationData,
      });
      if (updated.count > 0) {
        return { active: true, lifecycleAdvanced: true };
      }

      const membership = await this.prisma.chatBotMembership.findUnique({
        where: { chatId_botId: { chatId, botId } },
        select: { status: true },
      });
      return {
        active: membership?.status === ChatBotMembershipStatus.ACTIVE,
        lifecycleAdvanced: false,
      };
    }

    if (
      nextStatus === ChatBotMembershipStatus.ACTIVE &&
      params.preserveRemovedMembership === true
    ) {
      const touched = await this.prisma.chatBotMembership.updateMany({
        where: {
          chatId,
          botId,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        data: {
          role: nextRole,
          ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
          ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
        },
      });
      if (touched.count > 0) {
        return { active: true, lifecycleAdvanced: false };
      }

      const membership = await this.prisma.chatBotMembership.upsert({
        where: {
          chatId_botId: {
            chatId,
            botId,
          },
        },
        create: {
          chatId,
          botId,
          role: nextRole,
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessSource: MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE,
          ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
          ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
        },
        update: {},
      });
      return {
        active: membership.status === ChatBotMembershipStatus.ACTIVE,
        lifecycleAdvanced: false,
      };
    }

    const membership = await this.prisma.chatBotMembership.upsert({
      where: {
        chatId_botId: {
          chatId,
          botId,
        },
      },
      create: {
        chatId,
        botId,
        role: nextRole,
        status: nextStatus,
        ...(nextStatus === ChatBotMembershipStatus.ACTIVE
          ? { botAccessSource: MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE }
          : {}),
        ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
        ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
        ...(lifecycleEventAt ? { lifecycleEventAt } : {}),
        ...(lifecycleEventType ? { lifecycleEventType } : {}),
        ...(lifecycleSource ? { lifecycleSource } : {}),
      },
      update: {
        role: nextRole,
        status: nextStatus,
        ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
        ...(params.lastWebhookAt ? { lastWebhookAt: params.lastWebhookAt } : {}),
        ...(lifecycleEventAt ? { lifecycleEventAt } : {}),
        ...(lifecycleEventType ? { lifecycleEventType } : {}),
        ...(lifecycleSource ? { lifecycleSource } : {}),
      },
    });
    return {
      active: membership.status === ChatBotMembershipStatus.ACTIVE,
      lifecycleAdvanced: false,
    };
  }

  private async markChatRoutingReadyFromLifecycleProof(params: {
    chatId: string;
    botId: string;
    lifecycleEventAt: Date;
    lifecycleEventType: string;
    lifecycleSource: string;
  }): Promise<void> {
    const liveProbe =
      params.lifecycleEventType === 'live_probe' && params.lifecycleSource === 'live_probe';
    if (!liveProbe && params.lifecycleEventType !== 'bot_added') {
      return;
    }
    const updated = await this.prisma.chat.updateMany({
      where: {
        id: params.chatId,
        routingState: { not: ChatRoutingState.READY },
        botMemberships: {
          some: {
            botId: params.botId,
            status: ChatBotMembershipStatus.ACTIVE,
            OR: [
              { botAccessSource: null },
              { botAccessSource: { not: MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE } },
            ],
            lifecycleEventAt: params.lifecycleEventAt,
            lifecycleEventType: params.lifecycleEventType,
            botAccessState: liveProbe
              ? { in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER] }
              : { notIn: [ChatBotAccessState.DENIED, ChatBotAccessState.LOST] },
            ...(liveProbe
              ? {
                  botAccessCheckedAt: { gte: params.lifecycleEventAt },
                }
              : {}),
          },
        },
      },
      data: {
        routingState: ChatRoutingState.READY,
        routingVersion: { increment: 1 },
      },
    });
    if (updated.count) await this.publishCommittedChatRoute(params.chatId);
  }

  private getOperationalBotById(botId: string | null | undefined): MaxBotDefinition | null {
    const bot = this.botRegistry.getBotById(botId);
    return bot && isOperationalBotState(bot.state) ? bot : null;
  }

  private resolveOperationalBotId(botId: string | null | undefined): string | null {
    return this.getOperationalBotById(botId)?.id ?? null;
  }

  private isMembershipRouteAccessEligible(
    membership: Pick<
      ResolvedChatRouteMembership,
      'botAccessState' | 'botAccessSource' | 'permissionsSnapshot'
    >,
  ): boolean {
    return (
      !isManagedEntityActivationRequired(membership) &&
      !membershipExplicitlyLacksAccess(membership.permissionsSnapshot)
    );
  }

  private membershipMatchesExpectedAccessEpoch(
    membership: ResolvedChatRouteMembership,
    expectedAccessEpoch?: { checkedAt: Date; source: string },
  ): boolean {
    if (
      (membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
        membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER) ||
      !isConfirmedMembershipAccessSnapshot(
        normalizeMembershipAccessSnapshot(membership.permissionsSnapshot),
      )
    ) {
      return false;
    }
    if (!expectedAccessEpoch) {
      return true;
    }
    if (
      membership.botAccessCheckedAt?.getTime() !== expectedAccessEpoch.checkedAt.getTime() ||
      membership.botAccessSource !== expectedAccessEpoch.source
    ) {
      return false;
    }

    const lifecycleEventAt = membership.lifecycleEventAt;
    if (!lifecycleEventAt || lifecycleEventAt.getTime() < expectedAccessEpoch.checkedAt.getTime()) {
      return true;
    }
    return (
      lifecycleEventAt.getTime() === expectedAccessEpoch.checkedAt.getTime() &&
      membership.lifecycleEventType === 'live_probe' &&
      membership.lifecycleSource === 'live_probe'
    );
  }
}
