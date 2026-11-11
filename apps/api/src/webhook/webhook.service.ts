import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { WebhookDependencyQuarantineService } from './webhook-dependency-quarantine.service';
import { withStatsMembershipInvalidation } from '../statistics/stats-native-observation';
import { captureVoiceSourceInput, persistVoiceSource } from '../moderation/voice-webhook-source';
import {
  captureChannelPostDemand,
  persistChannelPostDemand,
} from '../moderation/channel-post-demand';
import {
  applyManagedBotPermissionEvent,
  BOT_PERMISSION_CHANGE_UPDATE,
} from '../max/managed-bot-permission-event';
import { holdUnverifiedLegacyExecution } from './webhook-legacy-authority';
import { settleOperatorDiscardedMirror } from './webhook-operator-discard-mirror';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { WebhookLegacyHoldService } from './webhook-legacy-hold.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import {
  WebhookPreparationAdmission,
  type WebhookPreparationSchedulingState,
} from './webhook-preparation-admission';
import { webhookPreparationScope } from './webhook-preparation-scope';
import { readPrismaPoolConfig } from '../prisma/prisma-client';
import { RuntimeWorkerOwner, type RuntimeWorker } from '../runtime/runtime-worker-shutdown';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSummary, MaxUpdate } from '@maxim/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { SuggestionSubscriptionService } from '../suggestions/suggestion-subscription.service';
import {
  ChatEntityType,
  ManagedEntityAccessState,
  Prisma,
  WebhookExecutionClaimStatus,
  WebhookStatus,
  type WebhookEvent,
} from '../prisma/prisma-client';
import {
  ChatContextCacheService,
  type AdminAccessEpochMutationMetric,
} from '../chat-context/chat-context-cache.service';
import {
  buildChatUserDisplayNameInsertIfAbsent,
  buildChatUserDisplayNameUpsert,
  type ChatUserDisplayNameObservation,
} from '../common/chat-user-display-name-read-model.util';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { isManagedEntityForwardedRecoveryMessage } from '../common/managed-entity-forwarded-recovery.util';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import { resolveMaxUserDisplayName } from '../common/max-user-display-name.util';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import { MaxClientService, type MaxChatMemberAccess } from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { resolveExplicitMembershipAccessDenial } from '../max/max-membership-access-error';
import { MaxExecutionOwnerReadinessService } from '../max/max-execution-owner-readiness.service';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import { ManagedEntityHandshakeService } from '../max/managed-entity-handshake.service';
import { PrismaService } from '../prisma/prisma.service';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import { WebhookIngressMetricsService } from '../system/webhook-ingress-metrics.service';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { PublisherEntityBindingLifecycleService } from '../publisher/publisher-entity-binding-lifecycle.service';
import { PublisherChatCommentProducerService } from '../publisher/publisher-chat-comment-producer.service';
import { PublisherPrivateDialogFlowRouterService } from '../publisher/publisher-private-dialog-flow-router.service';
import { PublisherAutoReplyProducerService } from '../publisher/publisher-auto-reply-producer.service';
import {
  buildWebhookSemanticEventKey,
  readWebhookEventTimestamp,
} from './webhook-semantic-event-key';
import { writeWebhookPayload } from './webhook-payload-write';
import {
  lockWebhookClaimReceiptAdmission,
  tryLockWebhookSemanticClaimFences,
} from './webhook-semantic-claim-fence';
import { settleDormantWebhookObservation } from './webhook-dormant-observation';
import {
  buildWebhookExecutionDeadlineAt,
  hasExpiredWebhookReadinessWait,
  hasWebhookReplayFence,
} from './webhook-execution-deadline';
import {
  MULTIBOT_EXECUTION_AUTHORITY_VERSION,
  isEarlierWebhookReceipt,
} from './webhook-semantic-authority';
import {
  WebhookCanonicalExecutionService,
  type WebhookCanonicalPersistenceClient,
} from '../moderation/webhook-canonical-execution.service';
import { buildMembershipDenialEdgeAdvanceWhere } from './webhook-membership-transition.util';
import {
  normalizeWebhookCanonicalCanaryPercent,
  normalizeWebhookCanonicalExecutionMode,
  shouldEnforceCanonicalWebhookExecution,
  type WebhookCanonicalExecutionMode,
} from './webhook-canonical-execution-mode';
import {
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
  WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';

type WebhookIngestResult = {
  accepted: boolean;
  duplicate: boolean;
};

export type WebhookReceiptResult = WebhookIngestResult & {
  webhookEventId: string | null;
};

export type PreparedWebhookExecution = {
  canonical: boolean;
  prepared: boolean;
  normalizedPayload: unknown;
  executionBotId: string | null;
  enforced: boolean;
  canonicalWebhookEventId?: string;
};

type WebhookExecutionClaimRow = {
  id: string;
  kind: string;
  semanticKey: string;
  webhookEventId: string | null;
  executionBotId: string | null;
  enforced: boolean;
  status: WebhookExecutionClaimStatus;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  preparedAt: Date | null;
  completedAt: Date | null;
  businessStartedAt?: Date | null;
  createdAt?: Date;
  commandResult?: unknown;
};

type WebhookExecutionClaimModel = {
  createMany: (args: {
    data: Array<{
      kind: string;
      semanticKey: string;
      webhookEventId: string;
      enforced?: boolean;
    }>;
    skipDuplicates: boolean;
  }) => Promise<{ count: number }>;
  findUnique: (args: unknown) => Promise<WebhookExecutionClaimRow | null>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
};

type MembershipActivityProjection = {
  id: string;
  dedupeKey: string;
  botId?: string | null;
  chatId: string;
  eventType: string;
  userId?: string | null;
  senderName?: string | null;
  eventAt: Date;
  createdAt: Date;
};

type MembershipActivityEventModel = {
  createMany: (args: {
    data: MembershipActivityProjection[];
    skipDuplicates?: boolean;
  }) => Promise<unknown>;
};

type MembershipTransitionResult = {
  chatId: string;
  eventAt: Date;
  eventType: string;
  deniedUserIds: string[];
};

type MembershipDenialCacheMutationResult = {
  key: string;
  userId: string;
  error: unknown | null;
};

type MembershipDenialCacheMutation = {
  key: string;
  userId: string;
};

type MembershipDenialCacheMutationTask = {
  promise: Promise<MembershipDenialCacheMutationResult>;
  state: 'pending' | 'succeeded';
  retainUntilMs: number | null;
};

type MembershipDenialCachePublicationTask = {
  promise: Promise<readonly MembershipDenialCacheMutationResult[]>;
  state: 'pending' | 'succeeded' | 'failed';
  retainUntilMs: number | null;
  failedMutationKeys: ReadonlySet<string> | null;
  waitBudgetClaimed: boolean;
  waitBudgetExhausted: boolean;
  lateObserverAttached: boolean;
};

type ManagedEntityLocalActivityProjection = {
  userId: string;
  chatId: string;
  entityType: ChatEntityType;
  chatTitle?: string | null;
  sourceEventType: string;
  botId?: string | null;
  lastEventAt: Date;
};

type ManagedEntityLocalActivityRawClient = {
  $executeRaw?: (query: Prisma.Sql) => Promise<unknown>;
};

type ExecutionOwnerFailoverRecheckParams = {
  update: MaxUpdate;
  chatId: string;
  incomingBotId: string | null;
  currentOwnerBotId: string | null;
};

type ChatBotBindingSyncResult = {
  executionOwnerBotId: string | null;
  pendingExecutionOwnerRecheck: ExecutionOwnerFailoverRecheckParams | null;
};

type BotSelfAccessCacheEntry = {
  canHandleUserFacing: boolean;
  checkedAtMs: number | null;
  expiresAtMs: number;
};

type PersistedBotSelfAccessSnapshot = {
  canHandleUserFacing: boolean;
  checkedAtMs: number | null;
};

const BOT_SELF_ACCESS_CACHE_TTL_MS = 5 * 60 * 1_000;
const BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS = 60 * 1_000;
const BOT_SELF_ACCESS_BACKOFF_MS = 30 * 1_000;
const BOT_SELF_ACCESS_TIMEOUT_MS = 900;
const BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1_000;
const EXECUTION_OWNER_ASYNC_RECHECK_BACKOFF_MS = 30 * 1_000;
const BOT_SELF_ACCESS_FAILURE_METRIC_STATUSES = [403, 404] as const;
const MANAGED_ENTITIES_PENDING_BOOTSTRAP_TTL_SEC = 15 * 60;
const MEMBERSHIP_DENIAL_CACHE_WAIT_BUDGET_MS = 100;
const MEMBERSHIP_DENIAL_CACHE_RETRY_MS = 1_000;
const MEMBERSHIP_DENIAL_CACHE_SHUTDOWN_WAIT_MS = 1_000;
const MEMBERSHIP_DENIAL_CACHE_SUCCESS_RETENTION_MS = 30_000;
const MEMBERSHIP_DENIAL_CACHE_MAX_SETTLED_TASKS = 16_384;
const MEMBERSHIP_DENIAL_CACHE_MAX_SETTLED_PUBLICATIONS = 4_096;
const DEFAULT_MEMBERSHIP_DENIAL_CACHE_MAX_IN_FLIGHT = 64;
const BOT_REMOVED_CACHE_PUBLICATION_WAIT_MS = 100;
const WEBHOOK_LEGACY_DEDUP_COMPAT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const WEBHOOK_PREPARATION_LEASE_MS = 30_000;
const EXECUTION_CLAIM_KIND = 'EXECUTION';
const MEMBERSHIP_ACTIVITY_TIMESTAMP_GRANULARITY_MS = 1_000;
const MANAGED_ENTITY_ACTIVITY_UPDATE_TYPES = new Set([
  'message_created',
  'message_edited',
  'message_callback',
  'chat_title_changed',
  'bot_started',
  'bot_added',
  'user_added',
  'user_removed',
]);
const MEMBERSHIP_ACTIVITY_UPDATE_TYPES = new Set(['user_added', 'user_removed']);
// FLAG: bot_added records pending activation only; it cannot require or probe a live executor.
const INLINE_EXECUTION_OWNER_REFRESH_UPDATE_TYPES = new Set([
  'bot_started',
  'chat_title_changed',
  'user_added',
  'user_removed',
]);
const CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES = new Set([
  'bot_started',
  'user_added',
  'user_removed',
]);
const STORED_CHAT_BINDING_REUSE_UPDATE_TYPES = new Set([
  'message_created',
  'message_edited',
  'message_removed',
  'message_callback',
  'user_added',
  'user_removed',
]);
const EXTENDED_TERMINAL_BOT_LIFECYCLE_UPDATE_TYPES = new Set(['bot_stopped', 'dialog_removed']);
const DURABLE_BOT_LIFECYCLE_UPDATE_TYPES = new Set([
  'bot_added',
  'bot_removed',
  ...EXTENDED_TERMINAL_BOT_LIFECYCLE_UPDATE_TYPES,
]);

@Injectable()
export class WebhookService extends RuntimeWorkerOwner implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookService.name);
  private static readonly BOT_ADDED_ADMIN_ROSTER_RETRY_WINDOW_MS = 120_000;
  private readonly rawPayloadSampleRate: number;
  private readonly canonicalExecutionMode: WebhookCanonicalExecutionMode;
  private readonly canonicalExecutionCanaryPercent: number;
  private readonly canonicalExecutionCanaryEntityIds: ReadonlySet<string>;
  private readonly extendedLifecycleMode: WebhookCanonicalExecutionMode;
  private readonly extendedLifecycleCanaryPercent: number;
  private readonly extendedLifecycleCanaryEntityIds: ReadonlySet<string>;
  private readonly botSelfAccessCache = new Map<string, BotSelfAccessCacheEntry>();
  private readonly botSelfAccessBackoffUntilMs = new Map<string, number>();
  private readonly botSelfAccessRecoveryInFlight = new Map<string, Promise<string | null>>();
  private readonly executionOwnerRecheckBackoffUntilMs = new Map<string, number>();
  private readonly membershipDenialCacheMaxInFlight: number;
  private readonly membershipDenialCacheTasks = new Map<
    string,
    MembershipDenialCacheMutationTask
  >();
  private readonly membershipDenialCachePublications = new Map<
    string,
    MembershipDenialCachePublicationTask
  >();
  private readonly membershipDenialCacheMaxPendingPublications: number;
  private membershipDenialCacheInFlightTaskCount = 0;
  private membershipDenialCachePendingPublicationCount = 0;
  private membershipDenialCacheSettledTaskCount = 0;
  private membershipDenialCacheSettledPublicationCount = 0;
  private membershipDenialCacheShuttingDown = false;
  private readonly publisherBotId: string;
  private readonly preparationAdmission: WebhookPreparationAdmission;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
    @Optional() private readonly maxClient?: MaxClientService,
    @Optional()
    private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional() private readonly managedEntityHandshakeService?: ManagedEntityHandshakeService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    private readonly publisherBindingLifecycle?: PublisherEntityBindingLifecycleService,
    @Optional()
    private readonly publisherChatCommentProducer?: PublisherChatCommentProducerService,
    @Optional()
    private readonly publisherPrivateDialogFlows?: PublisherPrivateDialogFlowRouterService,
    @Optional()
    private readonly publisherAutoReplyProducer?: PublisherAutoReplyProducerService,
    @Optional() private readonly webhookIngressMetricsService?: WebhookIngressMetricsService,
    @Optional() private readonly messageRetention?: MessageRetentionStore,
    @Optional() private readonly suggestionSubscriptions?: SuggestionSubscriptionService,
    @Optional() private readonly executionOwnerReadiness?: MaxExecutionOwnerReadinessService,
    @Optional() private readonly runtimeDiagnostics?: RuntimeDiagnosticsService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
    @Optional() private readonly permissionEventRegistry?: MaxBotRegistryService,
    @Optional() private readonly dependencyQuarantine?: WebhookDependencyQuarantineService,
    @Optional() storageRuntimeMetrics?: StorageRuntimeMetricsService,
  ) {
    super();
    this.preparationAdmission = new WebhookPreparationAdmission(
      readPrismaPoolConfig().max ?? 10,
      (metric) => this.logger.log(metric, 'Webhook bounded preparation'),
    );
    storageRuntimeMetrics?.registerWebhookPreparationSnapshot(() =>
      this.preparationAdmission.runtimeSnapshot(),
    );
    const configuredPublisherBotId = configService.get<unknown>('MAX_PUBLISHER_BOT_ID');
    this.publisherBotId = buildPublisherBotDescriptor({
      id: typeof configuredPublisherBotId === 'string' ? configuredPublisherBotId : null,
    }).id;
    this.rawPayloadSampleRate = configService.get<number>('RAW_PAYLOAD_SAMPLE_RATE', 0.01);
    this.canonicalExecutionMode = normalizeWebhookCanonicalExecutionMode(
      configService.get<string>('WEBHOOK_CANONICAL_EXECUTION_MODE', 'shadow'),
    );
    this.canonicalExecutionCanaryPercent = normalizeWebhookCanonicalCanaryPercent(
      configService.get<number>('WEBHOOK_CANONICAL_EXECUTION_CANARY_PERCENT', 1),
    );
    this.canonicalExecutionCanaryEntityIds = this.parseCanaryEntityIds(
      configService.get<string>('WEBHOOK_CANONICAL_EXECUTION_CANARY_ENTITY_IDS', ''),
    );
    this.extendedLifecycleMode = normalizeWebhookCanonicalExecutionMode(
      configService.get<string>('MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE', 'shadow'),
    );
    this.extendedLifecycleCanaryPercent = normalizeWebhookCanonicalCanaryPercent(
      configService.get<number>('MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_PERCENT', 1),
    );
    this.extendedLifecycleCanaryEntityIds = this.parseCanaryEntityIds(
      configService.get<string>('MAX_EXTENDED_WEBHOOK_LIFECYCLE_CANARY_ENTITY_IDS', ''),
    );
    this.membershipDenialCacheMaxInFlight = this.readMembershipDenialCacheMaxInFlight(
      configService.get<unknown>('WEBHOOK_MEMBERSHIP_CACHE_MAX_IN_FLIGHT'),
    );
    this.membershipDenialCacheMaxPendingPublications = this.membershipDenialCacheMaxInFlight;
  }

  // FLAG: Drain preparation before Nest disconnects SQL/Redis; excess work stays in receipts.
  stopWorkerAdmission(): readonly RuntimeWorker[] {
    this.preparationAdmission.stop();
    return [
      {
        name: 'webhook-preparation',
        pause: async () => {
          await this.preparationAdmission.drain();
          await this.onModuleDestroy();
        },
        close: async (force) => {
          if (!force) await this.preparationAdmission.drain();
        },
      },
    ];
  }

  async onModuleDestroy(): Promise<void> {
    this.preparationAdmission.stop();
    this.preparationAdmission.flush();
    this.membershipDenialCacheShuttingDown = true;
    const tasks: Promise<unknown>[] = [
      ...this.membershipDenialCacheTasks.values(),
      ...this.membershipDenialCachePublications.values(),
    ]
      .filter((task) => task.state === 'pending')
      .map((task) => task.promise);
    if (this.preparationAdmission.snapshot().inFlight)
      tasks.push(this.preparationAdmission.drain());
    if (tasks.length === 0) {
      return;
    }

    let timeout: NodeJS.Timeout | null = null;
    const settled = await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), MEMBERSHIP_DENIAL_CACHE_SHUTDOWN_WAIT_MS);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (!settled) {
      this.logger.warn(
        {
          inFlightTaskCount: this.membershipDenialCacheInFlightTaskCount,
          timeoutMs: MEMBERSHIP_DENIAL_CACHE_SHUTDOWN_WAIT_MS,
        },
        'Timed out draining webhook preparation or committed denial cache publication during shutdown',
      );
    }
  }

  async ingest(update: MaxUpdate, sourceIp: string | null) {
    const receipt = await this.storeReceipt(update, sourceIp);
    if (receipt.duplicate) {
      await this.repairDuplicateReceiptReadModels(update);
      return { accepted: true, duplicate: true };
    }

    if (receipt.webhookEventId) {
      await this.preparePersistedWebhookEvent(receipt.webhookEventId, update);
    }
    return { accepted: true, duplicate: false };
  }

  async repairDuplicateReceiptReadModels(update: MaxUpdate): Promise<void> {
    return this.preparationAdmission.run(
      update.botId?.trim() || 'unknown',
      this.preparationClass(update),
      () => this.repairDuplicateReceiptReadModelsCore(update),
    );
  }

  private async repairDuplicateReceiptReadModelsCore(update: MaxUpdate): Promise<void> {
    if (update.type === BOT_PERMISSION_CHANGE_UPDATE) {
      if (!this.permissionEventRegistry) throw new Error('Permission event registry unavailable');
      await applyManagedBotPermissionEvent({
        update,
        prisma: this.prisma,
        registry: this.permissionEventRegistry,
        links: this.maxBotLinkService,
      });
      return;
    }
    if (this.isPublisherUpdate(update)) {
      await this.observePublisherWebhook(update, null, true);
      return;
    }
    await Promise.all([
      this.persistMembershipTransition(update),
      this.persistUserDisplayNameSnapshots(update),
    ]);
  }

  private recordReceiptDiagnostics(update: MaxUpdate): void {
    if (update.message?.chatId && ['message_created', 'message_edited'].includes(update.type)) {
      void this.runtimeDiagnostics?.recordHotChatActivity({
        chatId: update.message.chatId,
        botId: update.botId,
        eventType: update.type,
        stage: 'RECEIPT',
      });
    }
  }

  async storeReceipt(update: MaxUpdate, sourceIp: string | null): Promise<WebhookReceiptResult> {
    const legacyDuplicateResult = await this.handleLegacyDedupKeyDuplicate(update, false);
    if (legacyDuplicateResult) {
      return { ...legacyDuplicateResult, webhookEventId: null };
    }

    const shouldKeepRawPayload = Math.random() <= this.rawPayloadSampleRate;
    const rawPayload = shouldKeepRawPayload ? (update.raw ?? {}) : {};

    try {
      const webhookEventId = await this.persistReceipt(update, sourceIp, rawPayload);
      this.recordReceiptDiagnostics(update);
      return { accepted: true, duplicate: false, webhookEventId };
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        return { accepted: true, duplicate: true, webhookEventId: null };
      }

      if (this.shouldRetryWithSanitizedPayload(error)) {
        const sanitizedUpdate = this.sanitizeForJsonStorage(update) as MaxUpdate;
        const sanitizedRawPayload = this.sanitizeForJsonStorage(rawPayload);
        try {
          const webhookEventId = await this.persistReceipt(
            sanitizedUpdate,
            sourceIp,
            sanitizedRawPayload,
          );
          this.recordReceiptDiagnostics(sanitizedUpdate);
          this.logger.warn(
            {
              dedupKey: this.buildWebhookDedupKey(update),
              reason: this.extractErrorMessage(error),
            },
            'Stored webhook receipt with sanitized payload fallback',
          );
          return { accepted: true, duplicate: false, webhookEventId };
        } catch (retryError: unknown) {
          if (this.isUniqueConstraintError(retryError)) {
            return { accepted: true, duplicate: true, webhookEventId: null };
          }
          throw retryError;
        }
      }

      this.logger.error({ err: error }, 'Failed to store durable webhook receipt');
      throw error;
    }
  }

  canPreparePersistedWebhookEvent(admissionUpdate?: MaxUpdate): boolean {
    return this.webhookPreparationSchedulingState(admissionUpdate) === 'available';
  }

  webhookPreparationSchedulingState(
    admissionUpdate?: MaxUpdate,
  ): WebhookPreparationSchedulingState {
    // FLAG: This is only a scheduling hint. Actual admission and persisted receipt reload
    // remain mandatory; a positive hint grants neither a slot nor execution authority.
    try {
      return this.preparationAdmission.schedulingState(
        admissionUpdate?.botId?.trim() || 'unknown',
        this.preparationClass(admissionUpdate),
      );
    } catch {
      // Let the normal per-receipt preparation/error path handle malformed stored data.
      return 'available';
    }
  }

  nextPreparationCompletion(): Promise<void> | null {
    return this.preparationAdmission.nextCompletion();
  }

  async preparePersistedWebhookEvent(
    webhookEventId: string,
    fallbackUpdate?: MaxUpdate,
    admissionUpdate: MaxUpdate | undefined = fallbackUpdate,
  ): Promise<PreparedWebhookExecution> {
    // FLAG: The outbox snapshot supplies scheduling identity only. It must never become
    // a fallback receipt: execution still reloads the authoritative persisted event.
    return this.preparationAdmission.run(
      admissionUpdate?.botId?.trim() || 'unknown',
      this.preparationClass(admissionUpdate),
      () => this.preparePersistedWebhookEventAdmitted(webhookEventId, fallbackUpdate),
    );
  }

  private preparationClass(update?: MaxUpdate): 'ordinary' | 'interactive' | 'lifecycle' {
    return webhookPreparationScope(update).workClass;
  }

  private async preparePersistedWebhookEventAdmitted(
    webhookEventId: string,
    fallbackUpdate?: MaxUpdate,
  ): Promise<PreparedWebhookExecution> {
    const event = await this.loadWebhookReceipt(webhookEventId, fallbackUpdate);
    if (!event) {
      return {
        canonical: false,
        prepared: false,
        normalizedPayload: fallbackUpdate ?? null,
        executionBotId: null,
        enforced: false,
      };
    }

    const update = event.normalizedPayload as MaxUpdate;
    if (
      event.status === WebhookStatus.QUARANTINED ||
      event.status === WebhookStatus.NO_REPLAY_HELD ||
      event.status === WebhookStatus.CANCELLED
    ) {
      return {
        canonical: false,
        prepared: false,
        normalizedPayload: update,
        executionBotId: null,
        enforced: true,
      };
    }
    const legacyHeld = await this.legacyHolds?.isUpdateHeld(update);
    const freshHeldCommand = legacyHeld
      ? await this.legacyHolds!.readFreshCommandReceipt(event.id, update)
      : null;
    if (legacyHeld && !freshHeldCommand) {
      let settled = false;
      if (update.type === 'user_removed') {
        try {
          const observation = await this.legacyHolds!.readHeldMembershipRemoval(event.id);
          if (observation) {
            const source = observation.update;
            // FLAG: Preserve removal's negative access observation before closing a
            // pristine held notification. No binding activation, ordinary handler,
            // suggestion wake or MAX effect is admitted by this recovery boundary.
            if (!this.chatContextCache || !this.membershipLookupService)
              throw new Error('Membership observation dependencies unavailable');
            await this.persistMembershipTransition(source);
            await this.membershipLookupService.invalidateMemberships(
              source.message!.chatId,
              source.membership!.memberUserIds,
            );
            settled = await this.legacyHolds!.finishObservedMembershipRemoval(
              event.id,
              observation.sourceDigest,
            );
          }
        } catch {
          // FLAG: Keep the finite original preparation marker across SQL/cache
          // failures so a restart can retry observation without relaxing source guards.
          throw new WebhookPreparationDeferredError(
            'Legacy scope installation is not sealed',
            1_000,
          );
        }
      }
      if (!settled && !(await this.legacyHolds!.settleHeldReceipt(event.id, update)))
        throw new WebhookPreparationDeferredError('Legacy scope installation is not sealed', 1_000);
      return {
        canonical: false,
        prepared: false,
        normalizedPayload: update,
        executionBotId: null,
        enforced: true,
      };
    }
    const publisherUpdate = this.isPublisherUpdate(update);
    const persistedSemanticKey = buildWebhookReceiptSemanticKey(update, this.publisherBotId);
    // FLAG: Existing shared-key Publisher history needs reviewed cold recovery. Do not
    // remove a live moderation order anchor or reinterpret historical execution proof.
    if (publisherUpdate && event.semanticKey !== null && event.semanticKey !== persistedSemanticKey)
      throw new WebhookPreparationDeferredError(
        'Publisher receipt semantic namespace requires reviewed recovery',
        1_000,
      );
    if (
      !publisherUpdate &&
      (await settleOperatorDiscardedMirror(this.prisma, { webhookEventId, update }))
    ) {
      return {
        canonical: false,
        prepared: false,
        normalizedPayload: update,
        executionBotId: null,
        enforced: true,
      };
    }
    if (persistedSemanticKey && event.semanticKey !== persistedSemanticKey) {
      const semanticBackfill = await this.prisma.webhookEvent.updateMany({
        where: { id: webhookEventId, semanticKey: null },
        data: { semanticKey: persistedSemanticKey },
      });
      // FLAG: A lost Publisher backfill CAS may leave a shared moderation key. Reload
      // on retry before observing or marking completion under a different identity.
      if (publisherUpdate && event.persistedReceipt && semanticBackfill.count !== 1)
        throw new WebhookPreparationDeferredError(
          'Publisher receipt semantic backfill changed',
          1_000,
        );
    }
    if (!event.executionDeadlineAt) {
      const deadline = buildWebhookExecutionDeadlineAt(update, event.createdAt);
      if (deadline) {
        await this.prisma.webhookEvent.updateMany({
          where: { id: event.id, executionDeadlineAt: null },
          data: { executionDeadlineAt: deadline },
        });
        event.executionDeadlineAt = deadline;
      }
    }
    if (publisherUpdate) {
      await this.observePublisherWebhook(update, webhookEventId, false);
      await this.prisma.webhookEvent.updateMany({
        where: {
          id: webhookEventId,
          status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
        },
        data: {
          normalizedPayload: this.sanitizeForJsonStorage(update),
          status: WebhookStatus.PROCESSED,
          processedAt: new Date(),
          queueName: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          errorMessage: null,
        },
      });
      return {
        canonical: false,
        prepared: true,
        normalizedPayload: update,
        executionBotId: null,
        enforced: true,
      };
    }

    const semanticKey =
      buildWebhookSemanticEventKey(update) ?? `receipt:${event.dedupKey || webhookEventId}`;
    if (
      await settleDormantWebhookObservation(
        this.prisma,
        this.maxBotLinkService,
        webhookEventId,
        update,
        event.errorMessage,
        event.createdAt,
      )
    ) {
      return {
        canonical: false,
        prepared: true,
        normalizedPayload: update,
        executionBotId: null,
        enforced: true,
      };
    }
    // FLAG: Each exact receiving bot may activate from Start before shared semantic
    // preparation. Its independent confirmation authority still permits one publication.
    if (
      isManagedEntityHandshakeStartCommand(update) &&
      (!freshHeldCommand || freshHeldCommand.deadlineAt.getTime() > Date.now())
    )
      await this.completeManagedEntityHandshake(update);
    // FLAG: Rollout modes may compare mirrors, but supported semantic events always have one
    // mutation owner. Disabling telemetry must never reopen full rule/command replay.
    const enforceCanonicalExecution =
      Boolean(persistedSemanticKey && MULTIBOT_EXECUTION_AUTHORITY_VERSION) ||
      shouldEnforceCanonicalWebhookExecution({
        mode: this.resolveEntityScopedCanaryMode(
          this.canonicalExecutionMode,
          this.canonicalExecutionCanaryEntityIds,
          update.message?.chatId,
        ),
        canaryPercent: this.canonicalExecutionCanaryPercent,
        semanticKey,
      });
    const claimModel = this.getWebhookExecutionClaimModel();
    if (!claimModel) {
      if (persistedSemanticKey)
        throw new WebhookPreparationDeferredError(
          'Semantic execution authority storage unavailable',
          1_000,
        );
      const prepared = await this.prepareWebhookEventCore(webhookEventId, update);
      return {
        canonical: true,
        prepared: true,
        normalizedPayload: prepared.update,
        executionBotId: prepared.executionBotId,
        enforced: false,
      };
    }

    if (this.canonicalExecutionMode === 'off' && !enforceCanonicalExecution) {
      const existingClaim = await claimModel.findUnique({
        where: {
          kind_semanticKey: {
            kind: EXECUTION_CLAIM_KIND,
            semanticKey,
          },
        },
      });
      if (
        existingClaim?.webhookEventId === webhookEventId &&
        existingClaim.status === WebhookExecutionClaimStatus.COMPLETED
      ) {
        return this.convergeCompletedWebhookEvent(webhookEventId, update, existingClaim);
      }

      const prepared = await this.prepareWebhookEventCore(webhookEventId, update);
      return {
        canonical: true,
        prepared: true,
        normalizedPayload: prepared.update,
        executionBotId: prepared.executionBotId,
        enforced: false,
      };
    }

    const executionAdmitted = await this.prisma.$transaction(async (tx) => {
      // FLAG: A stale preparation snapshot cannot add semantic authority after
      // receipt closure. Contention retries before business start, never drops work.
      if (!(await tryLockWebhookSemanticClaimFences(tx, [semanticKey])))
        throw new WebhookPreparationDeferredError('Semantic claim admission is busy', 1_000);
      if (!(await lockWebhookClaimReceiptAdmission(tx, webhookEventId))) return false;
      // FLAG: Completion locks an existing claim before settling its receipt. Read its
      // committed identity without a row lock; an INSERT conflict here would invert
      // that order while admission holds the receipt and deadlock the two paths.
      const existingClaim = await tx.webhookExecutionClaim.findUnique({
        where: { kind_semanticKey: { kind: EXECUTION_CLAIM_KIND, semanticKey } },
        select: { id: true },
      });
      if (existingClaim) return true;
      await tx.webhookExecutionClaim.createMany({
        data: [
          {
            kind: EXECUTION_CLAIM_KIND,
            semanticKey,
            webhookEventId,
            enforced: enforceCanonicalExecution,
          },
        ],
        skipDuplicates: true,
      });
      return true;
    });
    if (!executionAdmitted)
      return {
        canonical: false,
        prepared: true,
        normalizedPayload: update,
        executionBotId: null,
        enforced: true,
      };
    let claim = await claimModel.findUnique({
      where: {
        kind_semanticKey: {
          kind: EXECUTION_CLAIM_KIND,
          semanticKey,
        },
      },
    });
    if (!claim) {
      throw new Error(`Webhook execution claim disappeared for ${semanticKey}`);
    }

    if (
      enforceCanonicalExecution &&
      (await holdUnverifiedLegacyExecution(
        this.prisma,
        claim,
        event.persistedReceipt ? event : undefined,
      ))
    ) {
      if (update.message?.chatId)
        await this.runtimeDiagnostics?.recordProblemChat({
          chatId: update.message.chatId,
          botId: claim.executionBotId,
          category: 'canonical_recovery',
          severity: 'warning',
          reason: 'LEGACY_EXECUTION_UNVERIFIED; awaiting exact effects proof',
        });
      throw new WebhookPreparationDeferredError(
        'Legacy semantic execution requires exact proof recovery',
        5_000,
      );
    }
    if (enforceCanonicalExecution && !claim.enforced) {
      const promoted = await claimModel.updateMany({
        where: {
          id: claim.id,
          kind: EXECUTION_CLAIM_KIND,
          semanticKey,
          webhookEventId: claim.webhookEventId,
          status: claim.status,
          enforced: false,
          preparedAt: claim.preparedAt,
          completedAt: claim.completedAt,
          leaseToken: claim.leaseToken,
          leaseExpiresAt: claim.leaseExpiresAt,
        },
        data: { enforced: true },
      });
      if (promoted.count !== 1) {
        throw new WebhookPreparationDeferredError('Semantic execution authority changed', 1_000);
      }
      claim = { ...claim, enforced: true };
    }

    if (claim.webhookEventId === null) {
      const settled = await this.prisma.$transaction((tx) =>
        WebhookCanonicalExecutionService.trySettleCompletedShadowMirrorWithClient(
          tx as unknown as WebhookCanonicalPersistenceClient,
          { webhookEvent: event, update, businessLeaseToken: null },
          {
            id: event.id,
            status: event.status,
            errorMessage: event.errorMessage,
            nextEnqueueAt: event.nextEnqueueAt,
            timeoutQuarantineExpiresAt: null,
          },
        ),
      );
      if (settled !== 'settled')
        throw new WebhookPreparationDeferredError(
          'Ownerless semantic execution proof incomplete',
          1_000,
        );
      return {
        canonical: false,
        prepared: true,
        normalizedPayload: update,
        executionBotId: claim.executionBotId,
        enforced: true,
      };
    }

    let preparationLeaseToken: string | null = null;
    if (claim.webhookEventId !== webhookEventId) {
      const shadowMembershipMirror =
        !claim.enforced && MEMBERSHIP_ACTIVITY_UPDATE_TYPES.has(update.type.trim().toLowerCase());
      if (!shadowMembershipMirror) {
        await this.touchMirroredReceiptMembership(update);
      }
      if (!claim.enforced && !shadowMembershipMirror) {
        const prepared = await this.prepareWebhookEventCore(webhookEventId, update);
        return {
          canonical: true,
          prepared: true,
          normalizedPayload: prepared.update,
          executionBotId: null,
          enforced: false,
        };
      }

      if (!claim.enforced && !claim.preparedAt) {
        const takeover = await this.tryTakeOverTerminalShadowMembershipClaim({
          claimModel,
          claim,
          webhookEventId,
        });
        if (takeover) {
          claim = takeover.claim;
          preparationLeaseToken = takeover.leaseToken;
        } else {
          claim =
            (await claimModel.findUnique({
              where: {
                kind_semanticKey: {
                  kind: EXECUTION_CLAIM_KIND,
                  semanticKey,
                },
              },
            })) ?? claim;
        }
      }

      if (claim.webhookEventId !== webhookEventId) {
        if (claim.enforced) {
          if (shadowMembershipMirror) {
            await this.touchMirroredReceiptMembership(update);
          }
          await this.persistUserDisplayNameSnapshots(update);
          return this.prepareEnforcedMirror(event, update, claim);
        }

        // FLAG: Shadow membership mirrors reuse only a published preparation. A live or
        // ambiguous owner must retain the claim until its lease or timeout fence is settled.
        if (!claim.preparedAt) {
          return {
            canonical: true,
            prepared: false,
            normalizedPayload: update,
            executionBotId: claim.executionBotId,
            enforced: false,
          };
        }

        if (shadowMembershipMirror) {
          await this.touchMirroredReceiptMembership(update);
        }
        this.attachExecutionOwnerBotId(update, claim.executionBotId);
        await this.persistUserDisplayNameSnapshots(update);
        await writeWebhookPayload(this.prisma, webhookEventId, this.sanitizeForJsonStorage(update));
        return {
          canonical: true,
          prepared: true,
          normalizedPayload: update,
          executionBotId: null,
          enforced: false,
        };
      }
    }

    if (claim.status === WebhookExecutionClaimStatus.COMPLETED) {
      return this.convergeCompletedWebhookEvent(webhookEventId, update, claim);
    }

    if (claim.preparedAt) {
      return {
        canonical: true,
        prepared: true,
        normalizedPayload: update,
        executionBotId: claim.executionBotId,
        enforced: claim.enforced,
      };
    }

    const leaseToken = preparationLeaseToken ?? randomUUID();
    if (!preparationLeaseToken) {
      const now = new Date();
      const lease = await claimModel.updateMany({
        where: {
          id: claim.id,
          kind: EXECUTION_CLAIM_KIND,
          semanticKey,
          webhookEventId,
          status: WebhookExecutionClaimStatus.PENDING,
          preparedAt: null,
          completedAt: null,
          OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + WEBHOOK_PREPARATION_LEASE_MS),
        },
      });
      if (lease.count === 0) {
        claim =
          (await claimModel.findUnique({
            where: {
              kind_semanticKey: {
                kind: EXECUTION_CLAIM_KIND,
                semanticKey,
              },
            },
          })) ?? claim;
        return {
          canonical: true,
          prepared: claim.preparedAt !== null,
          normalizedPayload: update,
          executionBotId: claim.executionBotId,
          enforced: claim.enforced,
        };
      }
    }

    try {
      if (
        hasExpiredWebhookReadinessWait(
          claim.commandResult,
          webhookEventId,
          semanticKey,
          event.executionDeadlineAt,
        )
      ) {
        const expired = await this.prisma.$transaction((tx) =>
          WebhookCanonicalExecutionService.tryExpireUnstartedOwnerWithClient(tx, {
            webhookEventId,
            semanticKey,
            claimId: claim.id,
            leaseToken,
          }),
        );
        if (!expired)
          throw new WebhookPreparationDeferredError(
            'Expired executor waiting proof changed',
            1_000,
          );
        await this.runtimeDiagnostics?.recordProblemChat({
          chatId: update.message!.chatId,
          botId: update.botId,
          category: 'executor_readiness',
          severity: 'warning',
          reason: `NO_EXECUTABLE_OWNER; deadline=${event.executionDeadlineAt!.toISOString()}`,
        });
        return {
          canonical: false,
          prepared: true,
          normalizedPayload: update,
          executionBotId: null,
          enforced: true,
        };
      }
      const prepared = await this.prepareWebhookEventCore(webhookEventId, update);
      const published = await this.prisma.$transaction((tx) =>
        WebhookCanonicalExecutionService.transitionLiveUnstartedOwnerWithClient(tx, {
          claimId: claim.id,
          webhookEventId,
          semanticKey,
          leaseToken,
          executionBotId: prepared.executionBotId,
          executionDeadlineAt: event.executionDeadlineAt,
          enforced: claim.enforced || enforceCanonicalExecution,
          phase: 'ready',
          checkFreshHeldCommand: freshHeldCommand !== null,
        }),
      );
      if (published === 'expired') {
        await this.runtimeDiagnostics?.recordProblemChat({
          chatId: update.message!.chatId,
          botId: update.botId,
          category: 'executor_readiness',
          severity: 'warning',
          reason: `NO_EXECUTABLE_OWNER; deadline=${event.executionDeadlineAt!.toISOString()}`,
        });
        return {
          canonical: false,
          prepared: true,
          normalizedPayload: update,
          executionBotId: null,
          enforced: true,
        };
      }
      if (published !== 'transitioned') {
        throw new Error(`Webhook preparation lease was lost before READY for ${webhookEventId}`);
      }
      return {
        canonical: true,
        prepared: true,
        normalizedPayload: prepared.update,
        executionBotId: prepared.executionBotId,
        enforced: claim.enforced || enforceCanonicalExecution,
      };
    } catch (error: unknown) {
      if (error instanceof WebhookExecutionOwnerUnavailableError && event.executionDeadlineAt) {
        await claimModel.updateMany({
          where: {
            id: claim.id,
            webhookEventId,
            leaseToken,
            status: 'PENDING',
            businessStartedAt: null,
          },
          data: {
            commandResult: {
              kind: 'EXECUTION_WAITING',
              authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
              webhookEventId,
              semanticKey,
              deadlineAt: event.executionDeadlineAt.toISOString(),
            },
          },
        });
      }
      if (
        error instanceof WebhookExecutionOwnerUnavailableError &&
        event.executionDeadlineAt &&
        event.executionDeadlineAt.getTime() <= Date.now()
      ) {
        const expired = await this.prisma.$transaction((tx) =>
          WebhookCanonicalExecutionService.tryExpireUnstartedOwnerWithClient(tx, {
            webhookEventId,
            semanticKey,
            claimId: claim.id,
            leaseToken,
          }),
        );
        if (expired) {
          await this.runtimeDiagnostics?.recordProblemChat({
            chatId: update.message!.chatId,
            botId: update.botId,
            category: 'executor_readiness',
            severity: 'warning',
            reason: `NO_EXECUTABLE_OWNER; deadline=${event.executionDeadlineAt.toISOString()}`,
          });
          return {
            canonical: false,
            prepared: true,
            normalizedPayload: update,
            executionBotId: null,
            enforced: true,
          };
        }
      }
      await claimModel.updateMany({
        where: {
          id: claim.id,
          webhookEventId,
          leaseToken,
        },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      throw error;
    }
  }

  private async prepareEnforcedMirror(
    mirror: Pick<
      WebhookEvent,
      | 'id'
      | 'createdAt'
      | 'status'
      | 'errorMessage'
      | 'nextEnqueueAt'
      | 'timeoutQuarantineExpiresAt'
    >,
    update: MaxUpdate,
    initialClaim: WebhookExecutionClaimRow,
  ): Promise<PreparedWebhookExecution> {
    if (update.message?.chatId)
      void this.runtimeDiagnostics?.recordHotChatActivity({
        chatId: update.message.chatId,
        botId: update.botId,
        eventType: update.type,
        stage: 'MIRROR',
      });
    let claim = initialClaim;
    if (!claim.webhookEventId)
      throw new WebhookPreparationDeferredError('Canonical receipt identity missing', 1_000);
    let owner = await this.prisma.webhookEvent.findUnique({ where: { id: claim.webhookEventId } });
    if (
      !owner ||
      buildWebhookSemanticEventKey(owner.normalizedPayload) !== claim.semanticKey ||
      buildWebhookSemanticEventKey(update) !== claim.semanticKey
    )
      throw new WebhookPreparationDeferredError(
        'Canonical owner semantic proof unavailable',
        1_000,
      );
    if (
      owner.timeoutQuarantineExpiresAt !== null ||
      mirror.timeoutQuarantineExpiresAt !== null ||
      [owner.errorMessage, mirror.errorMessage].some(
        (message) =>
          message?.startsWith(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX) ||
          message?.toLowerCase().includes('ambiguous'),
      )
    )
      throw new WebhookPreparationDeferredError(
        'Canonical owner retains timeout replay fence',
        1_000,
      );
    if (owner.status === WebhookStatus.FAILED && owner.nextEnqueueAt === null) {
      // FLAG: Nonordered removals have no ordered-head discovery or execution deadline.
      // Isolate only an exact pristine semantic copy, retaining the uncertain owner and effects.
      if (
        update.type === 'message_removed' &&
        (await this.dependencyQuarantine?.parkSemanticMirror(owner.id, mirror.id))
      )
        return {
          canonical: false,
          prepared: false,
          normalizedPayload: update,
          executionBotId: null,
          enforced: true,
        };
      throw new WebhookPreparationDeferredError(
        'Terminal canonical owner requires proof recovery',
        5_000,
      );
    }
    if (claim.status === WebhookExecutionClaimStatus.PENDING) {
      // FLAG: An older mirror can be the exact chat head. Help only the existing owner prepare,
      // within this admission slot; waiting without this redirect would deadlock its later receipt.
      const preparedOwner = await this.preparePersistedWebhookEventAdmitted(owner.id);
      if (!preparedOwner.prepared)
        throw new WebhookPreparationDeferredError('Canonical preparation lease pending', 1_000);
      claim =
        (await this.getWebhookExecutionClaimModel()!.findUnique({
          where: {
            kind_semanticKey: { kind: EXECUTION_CLAIM_KIND, semanticKey: claim.semanticKey },
          },
        })) ?? claim;
      if (!claim.webhookEventId)
        throw new WebhookPreparationDeferredError(
          'Canonical owner changed during preparation',
          1_000,
        );
      owner = await this.prisma.webhookEvent.findUnique({ where: { id: claim.webhookEventId } });
      if (!owner) throw new WebhookPreparationDeferredError('Canonical owner disappeared', 1_000);
    }
    if (
      claim.status === WebhookExecutionClaimStatus.READY &&
      claim.preparedAt &&
      (await isEarlierWebhookReceipt(this.prisma, mirror, owner))
    ) {
      return {
        canonical: true,
        prepared: true,
        normalizedPayload: owner.normalizedPayload,
        executionBotId: claim.executionBotId,
        enforced: true,
        canonicalWebhookEventId: owner.id,
      };
    }
    const result = await this.prisma.$transaction((tx) =>
      WebhookCanonicalExecutionService.trySettlePreparedMirrorWithClient(
        tx as unknown as WebhookCanonicalPersistenceClient,
        { webhookEvent: mirror, update, businessLeaseToken: null },
        {
          id: mirror.id,
          status: mirror.status,
          errorMessage: mirror.errorMessage,
          nextEnqueueAt: mirror.nextEnqueueAt,
          timeoutQuarantineExpiresAt: null,
        },
      ),
    );
    if (result !== 'settled')
      throw new WebhookPreparationDeferredError('Canonical mirror proof pending', 1_000);
    return {
      canonical: false,
      prepared: true,
      normalizedPayload: update,
      executionBotId: claim.executionBotId,
      enforced: true,
    };
  }

  private async convergeCompletedWebhookEvent(
    webhookEventId: string,
    update: MaxUpdate,
    claim: WebhookExecutionClaimRow,
  ): Promise<PreparedWebhookExecution> {
    // FLAG: An exact owning COMPLETED claim is durable execution authority. Converge the receipt
    // without repeating preparation side effects, including binding and roster scheduling.
    const event = await this.loadWebhookReceipt(webhookEventId);
    if (
      !event ||
      claim.webhookEventId !== webhookEventId ||
      claim.semanticKey !== buildWebhookSemanticEventKey(event.normalizedPayload) ||
      !claim.preparedAt ||
      !Number.isFinite(claim.preparedAt.getTime()) ||
      !claim.completedAt ||
      !Number.isFinite(claim.completedAt.getTime()) ||
      claim.leaseToken !== null ||
      claim.leaseExpiresAt !== null ||
      hasWebhookReplayFence(event)
    )
      throw new WebhookPreparationDeferredError(
        'Completed owning semantic authority proof incomplete',
        1_000,
      );
    await this.prisma.$transaction(async (tx) => {
      const fenced = await tx.webhookExecutionClaim.updateMany({
        where: {
          id: claim.id,
          kind: EXECUTION_CLAIM_KIND,
          semanticKey: claim.semanticKey,
          webhookEventId,
          status: 'COMPLETED',
          preparedAt: claim.preparedAt,
          completedAt: claim.completedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        },
        data: { enforced: true },
      });
      if (fenced.count !== 1)
        throw new WebhookPreparationDeferredError('Completed owning claim changed', 1_000);
      const settled = await tx.webhookEvent.updateMany({
        where: {
          id: webhookEventId,
          status: event.status,
          normalizedPayload: { equals: event.normalizedPayload as Prisma.InputJsonValue },
          errorMessage: event.errorMessage,
          nextEnqueueAt: event.nextEnqueueAt,
          timeoutQuarantineExpiresAt: null,
        },
        data: {
          status: WebhookStatus.PROCESSED,
          processedAt: claim.completedAt,
          queueName: null,
          errorMessage: null,
          nextEnqueueAt: null,
        },
      });
      if (settled.count !== 1)
        throw new WebhookPreparationDeferredError('Completed owning receipt changed', 1_000);
    });
    return {
      canonical: false,
      prepared: true,
      normalizedPayload: update,
      executionBotId: claim.executionBotId,
      enforced: claim.enforced,
    };
  }

  private async invalidateMembershipCacheFromWebhook(update: MaxUpdate): Promise<void> {
    const chatId = update.message?.chatId?.trim() ?? '';
    const memberUserIds =
      update.membership?.memberUserIds ??
      (this.isDirectMembershipChange(update) && update.message?.senderId
        ? [update.message.senderId]
        : []);

    if (!chatId || memberUserIds.length === 0) {
      return;
    }

    try {
      await this.suggestionSubscriptions?.wake(chatId, memberUserIds);
    } catch (error: unknown) {
      throw new WebhookPreparationDeferredError('Suggestion membership wake pending', 1_000, error);
    }

    if (this.membershipLookupService) {
      try {
        await this.membershipLookupService.invalidateMemberships(chatId, memberUserIds);
      } catch (error: unknown) {
        this.logger.warn(
          {
            updateId: update.updateId,
            chatId,
            memberUserIds,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to invalidate MAX membership cache from webhook',
        );
        throw new WebhookPreparationDeferredError(
          'Membership cache invalidation pending',
          1_000,
          error,
        );
      }
    }
  }

  private isDirectMembershipChange(update: MaxUpdate): boolean {
    const normalizedType = update.type.trim().toLowerCase();
    return (
      normalizedType === 'user_added' ||
      normalizedType === 'bot_added' ||
      normalizedType === 'user_removed' ||
      normalizedType === 'bot_removed'
    );
  }

  private async lockChatForUserMembershipFence(
    tx: Prisma.TransactionClient,
    chatId: string,
  ): Promise<boolean> {
    const lockedChats = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT chat."id"
      FROM "chats" AS chat
      WHERE chat."id" = ${chatId}
      FOR UPDATE OF chat
    `;
    return lockedChats.length === 1;
  }

  private async persistReceipt(
    update: MaxUpdate,
    sourceIp: string | null,
    rawPayload: Prisma.InputJsonValue,
  ): Promise<string> {
    const storageRawPayload = this.sanitizeForJsonStorage(rawPayload);
    const storageNormalizedPayload = this.sanitizeForJsonStorage(update);
    const webhookEventId = randomUUID();
    const data: Prisma.WebhookEventCreateManyInput = {
      id: webhookEventId,
      dedupKey: this.buildWebhookDedupKey(update),
      semanticKey: buildWebhookReceiptSemanticKey(update, this.publisherBotId),
      executionDeadlineAt: buildWebhookExecutionDeadlineAt(update, new Date()),
      ...(update.botId ? { botId: update.botId } : {}),
      sourceIp: sourceIp ?? undefined,
      rawPayload: storageRawPayload,
      normalizedPayload: storageNormalizedPayload,
      status: WebhookStatus.RECEIVED,
    };
    const retentionInput = this.messageRetention?.captureInput(update);
    const removedInput = this.retentionRemovedInput(update);
    const voiceSourceInput = captureVoiceSourceInput(update);
    const channelPostDemand = captureChannelPostDemand(update, this.publisherBotId);
    if (
      this.legacyHolds ||
      channelPostDemand ||
      voiceSourceInput ||
      ((retentionInput || removedInput) && this.messageRetention)
    ) {
      const retention = this.messageRetention;
      return this.prisma.$transaction(
        async (tx) => {
          const result = await tx.webhookEvent.createMany({ data: [data], skipDuplicates: true });
          if (!result.count)
            throw Object.assign(new Error('Duplicate webhook receipt'), { code: 'P2002' });
          const held = await this.legacyHolds?.isUpdateHeld(update, tx);
          const disposition = held
            ? await this.legacyHolds!.materializeReceipt(webhookEventId, tx)
            : 'NOT_HELD';
          // FLAG: Revocation is observation only and must survive a held edit/removal.
          // Held creations never acquire voice evidence or bypass the final source holds.
          if (voiceSourceInput && (voiceSourceInput.kind === 'invalidate' || !held))
            await persistVoiceSource(tx, voiceSourceInput, webhookEventId);
          if (disposition !== 'NOT_HELD' && disposition !== undefined) return webhookEventId;
          if (channelPostDemand && !held) await persistChannelPostDemand(tx, channelPostDemand);
          if (retentionInput) await retention!.capture(tx, retentionInput);
          if (removedInput) await retention!.settleRemovedMessage(tx, removedInput);
          return webhookEventId;
        },
        { timeout: 2_000, maxWait: 500 },
      );
    }
    const createMany = (
      this.prisma.webhookEvent as unknown as {
        createMany?: (args: {
          data: Prisma.WebhookEventCreateManyInput[];
          skipDuplicates: boolean;
        }) => Promise<{ count: number }>;
      }
    ).createMany;
    if (typeof createMany === 'function') {
      const result = await createMany.call(this.prisma.webhookEvent, {
        data: [data],
        skipDuplicates: true,
      });
      if (result.count === 0) {
        throw Object.assign(new Error('Duplicate webhook receipt'), { code: 'P2002' });
      }
      return webhookEventId;
    }

    const created = await this.prisma.webhookEvent.create({
      data,
      select: {
        id: true,
      },
    });
    return created.id;
  }

  private retentionRemovedInput(update: MaxUpdate): { chatId: string; messageId: string } | null {
    if (!update.botId || update.type !== 'message_removed' || !update.message) return null;
    const { chatId, messageId } = update.message;
    const raw = update.raw;
    // FLAG: Only the authenticated official exact group-message removal receipt is proof.
    // Top-level user_id is the actor, not the original author. No history or MAX lookup is needed.
    if (
      !/^-[1-9]\d*$/.test(chatId) ||
      !messageId ||
      update.message.postId ||
      update.message.entityType === 'channel' ||
      !raw ||
      raw.update_type !== 'message_removed' ||
      String(raw.chat_id) !== chatId ||
      raw.message_id !== messageId ||
      raw.post_id != null
    )
      return null;
    return { chatId, messageId };
  }

  private async loadWebhookReceipt(
    webhookEventId: string,
    fallbackUpdate?: MaxUpdate,
  ): Promise<{
    persistedReceipt: boolean;
    id: string;
    dedupKey: string;
    botId: string | null;
    status: WebhookStatus;
    normalizedPayload: unknown;
    semanticKey: string | null;
    executionDeadlineAt: Date | null;
    createdAt: Date;
    errorMessage: string | null;
    nextEnqueueAt: Date | null;
    timeoutQuarantineExpiresAt: Date | null;
  } | null> {
    const findUnique = (
      this.prisma.webhookEvent as unknown as {
        findUnique?: (args: unknown) => Promise<{
          id: string;
          dedupKey?: string | null;
          botId?: string | null;
          status?: WebhookStatus;
          normalizedPayload?: unknown;
          semanticKey?: string | null;
          executionDeadlineAt?: Date | null;
          createdAt?: Date;
          errorMessage?: string | null;
          nextEnqueueAt?: Date | null;
          timeoutQuarantineExpiresAt?: Date | null;
        } | null>;
      }
    ).findUnique;
    if (typeof findUnique === 'function') {
      const stored = await findUnique.call(this.prisma.webhookEvent, {
        where: { id: webhookEventId },
        select: {
          id: true,
          dedupKey: true,
          botId: true,
          status: true,
          normalizedPayload: true,
          semanticKey: true,
          executionDeadlineAt: true,
          createdAt: true,
          errorMessage: true,
          nextEnqueueAt: true,
          timeoutQuarantineExpiresAt: true,
        },
      });
      if (stored?.normalizedPayload) {
        return {
          persistedReceipt: true,
          id: stored.id,
          dedupKey: stored.dedupKey ?? '',
          botId: stored.botId ?? null,
          status: stored.status ?? WebhookStatus.RECEIVED,
          normalizedPayload: stored.normalizedPayload,
          semanticKey: stored.semanticKey ?? null,
          executionDeadlineAt: stored.executionDeadlineAt ?? null,
          createdAt: stored.createdAt ?? new Date(0),
          errorMessage: stored.errorMessage ?? null,
          nextEnqueueAt: stored.nextEnqueueAt ?? null,
          timeoutQuarantineExpiresAt: stored.timeoutQuarantineExpiresAt ?? null,
        };
      }
    }

    if (!fallbackUpdate) {
      return null;
    }

    return {
      persistedReceipt: false,
      id: webhookEventId,
      dedupKey: this.buildWebhookDedupKey(fallbackUpdate),
      botId: fallbackUpdate.botId?.trim() || null,
      status: WebhookStatus.RECEIVED,
      normalizedPayload: fallbackUpdate,
      semanticKey: buildWebhookReceiptSemanticKey(fallbackUpdate, this.publisherBotId),
      executionDeadlineAt: null,
      createdAt: new Date(0),
      errorMessage: null,
      nextEnqueueAt: null,
      timeoutQuarantineExpiresAt: null,
    };
  }

  private getWebhookExecutionClaimModel(): WebhookExecutionClaimModel | null {
    const model = (
      this.prisma as PrismaService & {
        webhookExecutionClaim?: {
          createMany?: (args: unknown) => Promise<{ count: number }>;
          findUnique?: (args: unknown) => Promise<WebhookExecutionClaimRow | null>;
          updateMany?: (args: unknown) => Promise<{ count: number }>;
        };
      }
    ).webhookExecutionClaim;
    if (
      typeof model?.createMany !== 'function' ||
      typeof model.findUnique !== 'function' ||
      typeof model.updateMany !== 'function'
    ) {
      return null;
    }

    return {
      createMany: model.createMany.bind(model) as never,
      findUnique: model.findUnique.bind(model),
      updateMany: model.updateMany.bind(model),
    };
  }

  private async tryTakeOverTerminalShadowMembershipClaim(params: {
    claimModel: WebhookExecutionClaimModel;
    claim: WebhookExecutionClaimRow;
    webhookEventId: string;
  }): Promise<{ claim: WebhookExecutionClaimRow; leaseToken: string } | null> {
    const now = new Date();
    const leaseToken = randomUUID();
    const takeoverWhere = {
      id: params.claim.id,
      kind: EXECUTION_CLAIM_KIND,
      semanticKey: params.claim.semanticKey,
      webhookEventId: params.claim.webhookEventId,
      enforced: false,
      status: WebhookExecutionClaimStatus.PENDING,
      preparedAt: null,
      completedAt: null,
      OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
      webhookEvent: {
        is: {
          status: WebhookStatus.FAILED,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          errorMessage: { not: null },
          NOT: [
            {
              errorMessage: {
                startsWith: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
              },
            },
            {
              errorMessage: {
                startsWith: `${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX}:`,
              },
            },
          ],
        },
      },
    } satisfies Prisma.WebhookExecutionClaimWhereInput;
    const takeoverData = {
      webhookEventId: params.webhookEventId,
      executionBotId: null,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + WEBHOOK_PREPARATION_LEASE_MS),
    } satisfies Prisma.WebhookExecutionClaimUncheckedUpdateManyInput;
    const takeover = await params.claimModel.updateMany({
      where: takeoverWhere,
      data: takeoverData,
    });
    if (takeover.count !== 1) {
      return null;
    }

    return {
      claim: {
        ...params.claim,
        webhookEventId: params.webhookEventId,
        executionBotId: null,
        leaseToken,
        leaseExpiresAt: takeoverData.leaseExpiresAt,
      },
      leaseToken,
    };
  }

  private async prepareWebhookEventCore(
    webhookEventId: string,
    update: MaxUpdate,
  ): Promise<{ update: MaxUpdate; executionBotId: string | null }> {
    if (update.type === BOT_PERMISSION_CHANGE_UPDATE) {
      if (!this.permissionEventRegistry) throw new Error('Permission event registry unavailable');
      await applyManagedBotPermissionEvent({
        update,
        prisma: this.prisma,
        registry: this.permissionEventRegistry,
        links: this.maxBotLinkService,
      });
      await writeWebhookPayload(this.prisma, webhookEventId, this.sanitizeForJsonStorage(update));
      return { update, executionBotId: null };
    }
    if (this.isPublisherUpdate(update)) {
      await this.observePublisherWebhook(update, webhookEventId, false);
      await writeWebhookPayload(this.prisma, webhookEventId, this.sanitizeForJsonStorage(update));
      return { update, executionBotId: null };
    }

    await this.persistMembershipTransition(update);
    await this.invalidateMembershipCacheFromWebhook(update);
    const bindingSync = await this.syncChatBotBindingFromWebhook(update);
    this.attachExecutionOwnerBotId(update, bindingSync.executionOwnerBotId);
    // FLAG: The persisted receipt stays unprepared until these idempotent effects settle.
    // No callback escapes admission; a retry retains this receipt's semantic/send identity.
    await this.persistAdminReadModels(update);
    await this.stageManagedEntityPendingBootstrap(update);
    await this.schedulePendingExecutionOwnerFailoverRecheck(
      bindingSync.pendingExecutionOwnerRecheck,
    );
    // FLAG: bot_added only updates access/discovery; never publish onboarding hints to the entity.
    // Only explicit Start may confirm connection after fresh bot AND actor checks.
    const heldForCommand = await this.legacyHolds?.isUpdateHeld(update);
    const heldCommand = heldForCommand
      ? await this.legacyHolds!.readFreshCommandReceipt(webhookEventId, update)
      : null;
    // FLAG: An expired fresh command may settle without effects; preparation must
    // not publish Start before the command-only execution checks its original deadline.
    if (heldForCommand && !heldCommand)
      throw new WebhookPreparationDeferredError('Fresh command source proof changed', 1_000);
    if (
      !isManagedEntityHandshakeStartCommand(update) &&
      (!heldCommand || heldCommand.deadlineAt.getTime() > Date.now())
    )
      await this.completeManagedEntityHandshake(update);

    await writeWebhookPayload(this.prisma, webhookEventId, this.sanitizeForJsonStorage(update));

    return {
      update,
      executionBotId: update.executionOwnerBotId?.trim() ?? bindingSync.executionOwnerBotId ?? null,
    };
  }

  private async markMirroredReceiptDuplicate(webhookEventId: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: { in: [WebhookStatus.RECEIVED, WebhookStatus.FAILED, WebhookStatus.QUEUED] },
      },
      data: {
        status: WebhookStatus.DUPLICATE,
        processedAt: new Date(),
        queueName: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
      },
    });
  }

  private async touchMirroredReceiptMembership(update: MaxUpdate): Promise<void> {
    if (this.isPublisherUpdate(update)) {
      await this.observePublisherWebhook(update, null, true);
      return;
    }
    const chatId = update.message?.chatId?.trim() ?? '';
    const observedBotId = update.botId?.trim() ?? '';
    if (!chatId.startsWith('-') || !observedBotId) {
      return;
    }

    // FLAG: A mirrored heartbeat neither selects an execution owner nor grants membership.
    await this.maxBotLinkService.observeStoredChatBotWebhook({
      chatId,
      botId: observedBotId,
      observedAt: new Date(),
    });
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (error as { code?: string }).code === 'P2002';
  }

  private isPublisherUpdate(update: Pick<MaxUpdate, 'botId'>): boolean {
    return update.botId?.trim() === this.publisherBotId;
  }

  private requirePublisherBindingLifecycle(): PublisherEntityBindingLifecycleService {
    if (!this.publisherBindingLifecycle) {
      throw new Error('Publisher webhook lifecycle boundary is unavailable');
    }
    return this.publisherBindingLifecycle;
  }

  private async observePublisherWebhook(
    update: MaxUpdate,
    webhookEventId: string | null,
    duplicate: boolean,
  ): Promise<void> {
    if (update.type === BOT_PERMISSION_CHANGE_UPDATE) {
      if (!this.permissionEventRegistry) throw new Error('Permission event registry unavailable');
      await applyManagedBotPermissionEvent({
        update,
        prisma: this.prisma,
        registry: this.permissionEventRegistry,
        links: this.maxBotLinkService,
      });
      return;
    }
    if (update.type === 'user_added' || update.type === 'user_removed' || update.membership) {
      await this.invalidateMembershipCacheFromWebhook(update);
    }
    const consumed = await this.publisherPrivateDialogFlows?.observeWebhook(
      update,
      webhookEventId,
      {
        duplicate,
      },
    );
    if (consumed) {
      return;
    }
    await this.requirePublisherBindingLifecycle().observeWebhook(update);
    const autoReplyWebhookEventId =
      duplicate && !webhookEventId
        ? await this.resolveDuplicatePublisherWebhookEventId(update)
        : webhookEventId;
    const autoReply = await this.publisherAutoReplyProducer?.observeWebhook(
      update,
      autoReplyWebhookEventId,
      { duplicateRepair: duplicate },
    );
    if (!autoReply || autoReply.disposition === 'no_match') {
      await this.publisherChatCommentProducer?.observeWebhook(update);
    }
  }

  private async resolveDuplicatePublisherWebhookEventId(update: MaxUpdate): Promise<string | null> {
    const model = (
      this.prisma as PrismaService & {
        webhookEvent?: {
          findUnique?: (args: unknown) => Promise<{ id?: string | null } | null>;
        };
      }
    ).webhookEvent;
    if (typeof model?.findUnique !== 'function') {
      return null;
    }
    const event = await model.findUnique({
      where: { dedupKey: this.buildWebhookDedupKey(update) },
      select: { id: true },
    });
    return event?.id?.trim() || null;
  }

  private async stageManagedEntityPendingBootstrap(update: MaxUpdate): Promise<void> {
    if (!this.chatContextCache) {
      return;
    }

    const normalizedType = update.type.trim().toLowerCase();
    const isPendingBootstrapEvent =
      normalizedType === 'bot_added' || isManagedEntityHandshakeStartCommand(update);
    if (!isPendingBootstrapEvent) {
      return;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    const entityType = this.readWebhookChatEntityType(update);
    if (!chatId || !entityType) {
      return;
    }

    const title =
      update.message?.chatTitle?.trim() ||
      (entityType === ChatEntityType.CHANNEL ? `Channel ${chatId}` : `Chat ${chatId}`);
    const createdAtIso = update.message?.createdAt?.trim() || new Date().toISOString();
    const summary: ChatSummary = {
      id: chatId,
      title,
      createdAt: createdAtIso,
      entityType: entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
      link: null,
      primaryBotId: update.botId?.trim() || null,
      assignedBots: [],
      sharedMode: 'owned',
      channelOverview: null,
    };
    const bootstrapUserId = this.readManagedEntityPendingBootstrapUserId(update);

    try {
      await this.chatContextCache.upsertManagedEntitiesRecentBootstrap(
        summary,
        MANAGED_ENTITIES_PENDING_BOOTSTRAP_TTL_SEC,
        bootstrapUserId,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to stage managed entity pending bootstrap from bot_added webhook',
      );
    }
  }

  private async completeManagedEntityHandshake(update: MaxUpdate): Promise<void> {
    if (!this.managedEntityHandshakeService || isManagedEntityForwardedRecoveryMessage(update))
      return;
    const result = await this.managedEntityHandshakeService.handleWebhookUpdate(update);
    if (result === 'failed') {
      throw new WebhookPreparationDeferredError(
        'Managed entity handshake preparation pending',
        1_000,
      );
    }
  }

  private readManagedEntityPendingBootstrapUserId(update: MaxUpdate): string | null {
    const senderId = update.message?.senderId?.trim() ?? '';
    if (!senderId) {
      return null;
    }

    const botId = update.botId?.trim() ?? '';
    return senderId !== botId ? senderId : null;
  }

  private async syncChatBotBindingFromWebhook(
    update: MaxUpdate,
  ): Promise<ChatBotBindingSyncResult> {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return this.buildChatBotBindingSyncResult(null);
    }

    const entityType = this.readWebhookChatEntityType(update);
    // FLAG: Private dialog ownership is the authenticated receiving bot, not a
    // managed-chat moderation route. Keep lifecycle/read-model handling outside this helper.
    if (entityType !== ChatEntityType.CHANNEL && isPrivateDirectChatId(chatId)) {
      return this.buildChatBotBindingSyncResult(update.botId?.trim() || null);
    }
    const normalizedType = update.type.trim().toLowerCase();
    const trustedLifecycleEventAt = readWebhookEventTimestamp(update);
    if (isManagedEntityHandshakeStartCommand(update)) {
      return this.buildChatBotBindingSyncResult(
        await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, { bypassCache: true }),
      );
    }
    if (
      update.botId &&
      this.maxBotLinkService.resolveDormantReceiptPeer &&
      !this.isBotRemovalUpdate(update)
    ) {
      const route = await this.maxBotLinkService.resolveDormantReceiptPeer(chatId, update.botId);
      if (route.dormant) return this.buildChatBotBindingSyncResult(route.peerBotId);
    }
    let pendingExecutionOwnerRecheck: ExecutionOwnerFailoverRecheckParams | null = null;
    try {
      if (
        EXTENDED_TERMINAL_BOT_LIFECYCLE_UPDATE_TYPES.has(normalizedType) &&
        !this.shouldApplyExtendedLifecycleUpdate(update)
      ) {
        const storedOwnerBotId = await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, {
          bypassCache: true,
        });
        return this.buildChatBotBindingSyncResult(storedOwnerBotId);
      }

      if (this.isBotRemovalUpdate(update)) {
        if (!trustedLifecycleEventAt) {
          const storedOwnerBotId = await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, {
            bypassCache: true,
          });
          this.logger.warn(
            {
              updateId: update.updateId,
              type: normalizedType,
              chatId,
              botId: update.botId ?? null,
            },
            'Skipped terminal bot lifecycle transition without a trusted event timestamp',
          );
          await this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
          return this.buildChatBotBindingSyncResult(storedOwnerBotId);
        }

        const removedBotId = this.resolveRemovedChatBotId(update);
        const nextOwnerBotId = this.managedEntityAccessLossService
          ? ((
              await this.managedEntityAccessLossService.recordManagedEntityAccessLost({
                chatId,
                title: update.message?.chatTitle ?? null,
                entityType,
                botId: removedBotId,
                reason: 'bot_removed',
                source: `webhook_${normalizedType}`,
                lifecycleEventAt: trustedLifecycleEventAt,
                lifecycleEventType: normalizedType,
                lifecycleSource: 'webhook',
                cachePublicationWaitMs: BOT_REMOVED_CACHE_PUBLICATION_WAIT_MS,
              })
            )?.nextOwnerBotId ?? null)
          : await this.maxBotLinkService.markChatBotRemoved({
              chatId,
              title: update.message?.chatTitle ?? null,
              entityType,
              botId: removedBotId,
              lifecycleEventAt: trustedLifecycleEventAt,
              lifecycleEventType: normalizedType,
              lifecycleSource: 'webhook',
            });
        await this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
        return this.buildChatBotBindingSyncResult(nextOwnerBotId);
      }

      if (normalizedType === 'user_removed' || normalizedType === 'message_removed') {
        // FLAG: Passive user/message removals cannot grant or require an execution route.
        // Membership denial is already committed; message removal later revokes local history.
        const storedOwnerBotId = await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, {
          bypassCache: true,
        });
        await this.maxBotLinkService.observeStoredChatBotWebhook({
          chatId,
          primaryBotId: storedOwnerBotId,
          botId: update.botId,
        });
        await this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
        return this.buildChatBotBindingSyncResult(storedOwnerBotId);
      }

      if (STORED_CHAT_BINDING_REUSE_UPDATE_TYPES.has(normalizedType)) {
        const storedOwnerBotId = await this.maxBotLinkService.getStoredChatPrimaryBotId(chatId, {
          bypassCache: true,
        });
        if (storedOwnerBotId) {
          let executionOwnerBotId: string | null = storedOwnerBotId;
          const observedBotId = update.botId?.trim() || null;
          const shouldRefreshExecutionOwner = await this.shouldRefreshExecutionOwnerFromWebhook(
            update,
            storedOwnerBotId,
          );
          if (shouldRefreshExecutionOwner) {
            executionOwnerBotId = await this.maybeFailOverExecutionOwner({
              update,
              chatId,
              incomingBotId: update.botId ?? null,
              currentOwnerBotId: storedOwnerBotId,
              allowLiveCheck: false,
            });
            if (executionOwnerBotId === storedOwnerBotId) {
              pendingExecutionOwnerRecheck = {
                update,
                chatId,
                incomingBotId: update.botId ?? null,
                currentOwnerBotId: storedOwnerBotId,
              };
            }
          }
          if (
            !(
              observedBotId &&
              executionOwnerBotId !== storedOwnerBotId &&
              observedBotId === executionOwnerBotId
            )
          ) {
            await this.maxBotLinkService.observeStoredChatBotWebhook({
              chatId,
              primaryBotId: executionOwnerBotId ?? storedOwnerBotId,
              botId: observedBotId,
            });
          }
          await this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
          return this.buildChatBotBindingSyncResult(
            executionOwnerBotId,
            pendingExecutionOwnerRecheck,
          );
        }
      }

      if (normalizedType !== 'bot_added' || !trustedLifecycleEventAt) {
        if (
          this.executionOwnerReadiness &&
          this.shouldScheduleExecutionOwnerFailoverRecheck(update)
        ) {
          const state = await this.maxBotLinkService.loadChatExecutionOwnerState(chatId);
          if (state?.candidates.length) {
            const proof = await this.executionOwnerReadiness.ensureReady({
              chatId,
              preferredBotId: update.botId,
            });
            if (!proof)
              throw new WebhookExecutionOwnerUnavailableError(
                'No eligible moderation executor',
                5_000,
              );
            await this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
            return this.buildChatBotBindingSyncResult(proof.botId);
          }
        }
        const verifiedBotId = await this.bindIncomingBotAfterLiveProbe(update, chatId, entityType);
        await this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
        return this.buildChatBotBindingSyncResult(verifiedBotId);
      }

      const boundBotId = await this.maxBotLinkService.bindChatToBot({
        chatId,
        title: update.message?.chatTitle ?? null,
        entityType,
        botId: update.botId,
        ...(normalizedType === 'bot_added'
          ? {
              lifecycleEventAt: trustedLifecycleEventAt,
              lifecycleEventType: 'bot_added',
              lifecycleSource: 'webhook',
            }
          : {}),
      });
      let executionOwnerBotId = boundBotId;
      const shouldRefreshExecutionOwner = await this.shouldRefreshExecutionOwnerFromWebhook(
        update,
        boundBotId,
      );
      if (shouldRefreshExecutionOwner) {
        executionOwnerBotId = await this.maybeFailOverExecutionOwner({
          update,
          chatId,
          incomingBotId: update.botId ?? null,
          currentOwnerBotId: boundBotId,
          allowLiveCheck: false,
        });
        if (executionOwnerBotId === boundBotId) {
          pendingExecutionOwnerRecheck = {
            update,
            chatId,
            incomingBotId: update.botId ?? null,
            currentOwnerBotId: boundBotId,
          };
        }
      }
      await this.scheduleChatAdminRosterSyncFromWebhook(update, chatId);
      return this.buildChatBotBindingSyncResult(executionOwnerBotId, pendingExecutionOwnerRecheck);
    } catch (error: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          botId: update.botId ?? null,
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to bind chat to bot during webhook ingest',
      );
      if (
        DURABLE_BOT_LIFECYCLE_UPDATE_TYPES.has(normalizedType) ||
        error instanceof WebhookPreparationDeferredError
      ) {
        throw error;
      }
      return this.buildChatBotBindingSyncResult(null);
    }
  }

  private buildChatBotBindingSyncResult(
    executionOwnerBotId: string | null,
    pendingExecutionOwnerRecheck: ExecutionOwnerFailoverRecheckParams | null = null,
  ): ChatBotBindingSyncResult {
    return {
      executionOwnerBotId,
      pendingExecutionOwnerRecheck,
    };
  }

  private async bindIncomingBotAfterLiveProbe(
    update: MaxUpdate,
    chatId: string,
    entityType: ChatEntityType | null,
  ): Promise<string | null> {
    const incomingBotId = update.botId?.trim() ?? '';
    if (!chatId.startsWith('-') || !incomingBotId || !this.maxClient) {
      return null;
    }

    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, incomingBotId);
    const existingRecovery = this.botSelfAccessRecoveryInFlight.get(cacheKey);
    if (existingRecovery) {
      return existingRecovery;
    }
    if (this.isBotSelfAccessProbeSuppressed(cacheKey)) {
      return null;
    }

    const recovery = this.bindIncomingBotAfterFreshLiveProbe(
      update,
      chatId,
      entityType,
      incomingBotId,
    ).finally(() => {
      if (this.botSelfAccessRecoveryInFlight.get(cacheKey) === recovery) {
        this.botSelfAccessRecoveryInFlight.delete(cacheKey);
      }
    });
    this.botSelfAccessRecoveryInFlight.set(cacheKey, recovery);
    return recovery;
  }

  private async bindIncomingBotAfterFreshLiveProbe(
    update: MaxUpdate,
    chatId: string,
    entityType: ChatEntityType | null,
    incomingBotId: string,
  ): Promise<string | null> {
    await this.maxBotLinkService.ensureChatForAccessProbe({
      chatId,
      title: update.message?.chatTitle ?? null,
      entityType,
    });
    const probeStartedAt = new Date();
    const canHandleUserFacing = await this.getBotSelfModerationAccessState(chatId, incomingBotId, {
      bypassCache: true,
      allowMembershipRecovery: true,
    });
    if (canHandleUserFacing !== true) {
      return null;
    }

    const boundBotId = await this.maxBotLinkService.bindChatToBot({
      chatId,
      title: update.message?.chatTitle ?? null,
      entityType,
      botId: incomingBotId,
      lifecycleEventAt: probeStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    if (!boundBotId) {
      return null;
    }

    // FLAG: Lifecycle reactivation requires access evidence collected after the
    // lifecycle watermark was stored. Do not collapse these two probes.
    const confirmedAfterLifecycle = await this.getBotSelfModerationAccessState(
      chatId,
      incomingBotId,
      { bypassCache: true },
    );
    if (confirmedAfterLifecycle !== true) {
      return null;
    }

    return this.maxBotLinkService.reconcileChatPrimaryByAccess({
      chatId,
      title: update.message?.chatTitle ?? null,
      entityType,
    });
  }

  private async maybeFailOverExecutionOwner(params: {
    update: MaxUpdate;
    chatId: string;
    incomingBotId: string | null;
    currentOwnerBotId: string | null;
    allowLiveCheck: boolean;
  }): Promise<string | null> {
    if (this.executionOwnerReadiness && params.allowLiveCheck && params.chatId.startsWith('-')) {
      const proof = await this.executionOwnerReadiness.ensureReady({
        chatId: params.chatId,
        preferredBotId: params.incomingBotId,
      });
      if (!proof)
        throw new WebhookExecutionOwnerUnavailableError('No eligible moderation executor', 5_000);
      return proof.botId;
    }
    const incomingBotId = params.incomingBotId?.trim() ?? '';
    const currentOwnerBotId = params.currentOwnerBotId?.trim() ?? '';
    if (
      !params.chatId.startsWith('-') ||
      !incomingBotId ||
      !currentOwnerBotId ||
      incomingBotId === currentOwnerBotId
    ) {
      return params.currentOwnerBotId;
    }

    // Cached or persisted access evidence may schedule a probe, but it must never
    // be presented as a successful live probe for lifecycle reactivation.
    if (!params.allowLiveCheck) {
      return params.currentOwnerBotId;
    }

    const currentOwnerCanHandleUserFacing = await this.getBotSelfModerationAccessState(
      params.chatId,
      currentOwnerBotId,
      { bypassCache: true },
    );
    // FLAG: An unknown live result must retain the receipt's required recheck.
    if (currentOwnerCanHandleUserFacing === null) {
      throw new WebhookPreparationDeferredError('Current execution owner probe pending', 1_000);
    }
    if (currentOwnerCanHandleUserFacing !== false) {
      return params.currentOwnerBotId;
    }

    const incomingProbeStartedAt = new Date();
    const incomingBotCanHandleUserFacing = await this.getBotSelfModerationAccessState(
      params.chatId,
      incomingBotId,
      { bypassCache: true, allowMembershipRecovery: true },
    );
    if (incomingBotCanHandleUserFacing === null) {
      throw new WebhookPreparationDeferredError('Incoming execution owner probe pending', 1_000);
    }
    if (incomingBotCanHandleUserFacing !== true) {
      return params.currentOwnerBotId;
    }

    const reassignedBotId = await this.maxBotLinkService.bindChatToBot({
      chatId: params.chatId,
      title: params.update.message?.chatTitle ?? null,
      entityType: this.readWebhookChatEntityType(params.update),
      botId: incomingBotId,
      allowReassign: true,
      lifecycleEventAt: incomingProbeStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });

    if (reassignedBotId === incomingBotId) {
      this.logger.warn(
        {
          chatId: params.chatId,
          updateId: params.update.updateId,
          previousPrimaryBotId: currentOwnerBotId,
          nextPrimaryBotId: incomingBotId,
        },
        'Promoted the incoming bot to primary after detecting stale owner permissions',
      );
    }

    return reassignedBotId ?? params.currentOwnerBotId;
  }

  private shouldPerformInlineExecutionOwnerLiveRefresh(update: MaxUpdate): boolean {
    return (
      INLINE_EXECUTION_OWNER_REFRESH_UPDATE_TYPES.has(update.type.trim().toLowerCase()) ||
      this.isPotentialGroupAdminModerationCommand(update)
    );
  }

  private isPotentialGroupAdminModerationCommand(update: MaxUpdate): boolean {
    if (update.type.trim().toLowerCase() !== 'message_created') {
      return false;
    }

    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId.startsWith('-')) {
      return false;
    }

    const text = this.readTrimmedString(update.message?.text)?.toLowerCase() ?? '';
    if (!text) {
      return false;
    }

    return (
      /^(?:супер[\s-]+бан|super[\s-]+ban)[.!]?$/u.test(text) ||
      /^(?:бан|ban)(?:\s+\d{1,3}(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?)?[.!]?$/u.test(
        text,
      ) ||
      /^(?:мут|мьют|мью|mute)(?:\s+\d{1,3}(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?)?[.!]?$/u.test(
        text,
      ) ||
      (this.hasLinkedAdminCommandMessage(update) && this.isShortAdminCommandText(text))
    );
  }

  private hasLinkedAdminCommandMessage(update: MaxUpdate): boolean {
    const raw = this.asRecord(update.raw);
    const rawMessage = this.asRecord(raw?.message) ?? raw;
    if (!rawMessage) {
      return false;
    }

    const body = this.asRecord(rawMessage.body);
    const content = this.asRecord(rawMessage.content);
    const payload = this.asRecord(rawMessage.payload);
    return [
      rawMessage.link,
      rawMessage.forwarded_message,
      rawMessage.forwarded,
      body?.forwarded_message,
      body?.forwarded,
      body?.reply,
      body?.replied_message,
      content?.forwarded_message,
      content?.reply,
      payload?.forwarded_message,
      payload?.reply,
    ].some((candidate) => this.asRecord(candidate) !== null);
  }

  private isShortAdminCommandText(text: string): boolean {
    const normalized = text.trim();
    return (
      normalized.length > 0 &&
      normalized.length <= 64 &&
      /^[\p{L}\p{N}_ -]+[.!]?$/u.test(normalized)
    );
  }

  private async shouldRefreshExecutionOwnerFromWebhook(
    update: MaxUpdate,
    currentOwnerBotId: string | null,
  ): Promise<boolean> {
    if (this.executionOwnerReadiness && this.shouldScheduleExecutionOwnerFailoverRecheck(update))
      return true;
    if (this.shouldPerformInlineExecutionOwnerLiveRefresh(update)) {
      return true;
    }

    if (!this.shouldScheduleExecutionOwnerFailoverRecheck(update)) {
      return false;
    }

    const incomingBotId = update.botId?.trim() ?? '';
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!incomingBotId || !currentOwnerBotId || !chatId || incomingBotId === currentOwnerBotId) {
      return false;
    }

    return (
      (await this.getCachedOrPersistedBotSelfModerationAccessState(chatId, currentOwnerBotId)) ===
      false
    );
  }

  private async persistAdminReadModels(update: MaxUpdate): Promise<void> {
    const writes: Promise<unknown>[] = [];

    const managedProjection = this.buildManagedEntityLocalActivityProjection(update);
    const rawClient = this.prisma as ManagedEntityLocalActivityRawClient;
    const displayNameSnapshotUpsert = this.buildUserDisplayNameSnapshotUpsert(update);
    if (
      displayNameSnapshotUpsert &&
      this.hasChatUserDisplayNameReadModel() &&
      typeof rawClient.$executeRaw === 'function'
    ) {
      writes.push(rawClient.$executeRaw(displayNameSnapshotUpsert));
    }
    const managedModel = (
      this.prisma as PrismaService & {
        managedEntityLocalActivity?: {
          updateMany?: (args: {
            where: {
              userId: string;
              chatId: string;
              lastEventAt: {
                lt: Date;
              };
            };
            data: {
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
          }) => Promise<{ count: number }>;
          create?: (args: {
            data: {
              userId: string;
              chatId: string;
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
          }) => Promise<unknown>;
          upsert?: (args: {
            where: {
              userId_chatId: {
                userId: string;
                chatId: string;
              };
            };
            create: {
              userId: string;
              chatId: string;
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
            update: {
              entityType: ChatEntityType;
              chatTitle?: string | null;
              sourceEventType: string;
              botId?: string | null;
              lastEventAt: Date;
            };
          }) => Promise<unknown>;
        };
      }
    ).managedEntityLocalActivity;
    if (managedProjection && typeof rawClient.$executeRaw === 'function') {
      writes.push(
        this.upsertManagedEntityLocalActivity(
          rawClient as Required<ManagedEntityLocalActivityRawClient>,
          managedProjection,
        ),
      );
    } else if (
      managedProjection &&
      typeof managedModel?.updateMany === 'function' &&
      typeof managedModel?.create === 'function'
    ) {
      const baseWrite = {
        entityType: managedProjection.entityType,
        sourceEventType: managedProjection.sourceEventType,
        botId: managedProjection.botId ?? null,
        lastEventAt: managedProjection.lastEventAt,
        ...(managedProjection.chatTitle ? { chatTitle: managedProjection.chatTitle } : {}),
      };
      writes.push(
        (async () => {
          const updateResult = await managedModel.updateMany({
            where: {
              userId: managedProjection.userId,
              chatId: managedProjection.chatId,
              lastEventAt: {
                lt: managedProjection.lastEventAt,
              },
            },
            data: baseWrite,
          });
          if (updateResult.count > 0) {
            return;
          }

          try {
            await managedModel.create({
              data: {
                userId: managedProjection.userId,
                chatId: managedProjection.chatId,
                ...baseWrite,
              },
            });
          } catch (error: unknown) {
            if (this.isPrismaKnownError(error, 'P2002')) {
              return;
            }

            throw error;
          }
        })(),
      );
    } else if (managedProjection && typeof managedModel?.upsert === 'function') {
      const baseWrite = {
        entityType: managedProjection.entityType,
        sourceEventType: managedProjection.sourceEventType,
        botId: managedProjection.botId ?? null,
        lastEventAt: managedProjection.lastEventAt,
        ...(managedProjection.chatTitle ? { chatTitle: managedProjection.chatTitle } : {}),
      };
      writes.push(
        managedModel.upsert({
          where: {
            userId_chatId: {
              userId: managedProjection.userId,
              chatId: managedProjection.chatId,
            },
          },
          create: {
            userId: managedProjection.userId,
            chatId: managedProjection.chatId,
            ...baseWrite,
          },
          update: baseWrite,
        }),
      );
    }

    if (writes.length === 0) {
      return;
    }

    const settled = await Promise.allSettled(writes);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        continue;
      }

      this.logger.warn(
        {
          updateId: update.updateId,
          type: update.type,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
        'Failed to persist admin read model during webhook ingest',
      );
    }
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected')
      throw new WebhookPreparationDeferredError(
        'Webhook read model persistence pending',
        1_000,
        failure.reason,
      );
  }

  private async persistUserDisplayNameSnapshots(update: MaxUpdate): Promise<void> {
    const snapshotUpsert = this.buildUserDisplayNameSnapshotUpsert(update);
    const rawClient = this.prisma as ManagedEntityLocalActivityRawClient;
    if (
      !snapshotUpsert ||
      !this.hasChatUserDisplayNameReadModel() ||
      typeof rawClient.$executeRaw !== 'function'
    ) {
      return;
    }

    await rawClient.$executeRaw(snapshotUpsert);
  }

  private hasChatUserDisplayNameReadModel(): boolean {
    return (
      (this.prisma as PrismaService & { chatUserDisplayName?: unknown }).chatUserDisplayName !==
      undefined
    );
  }

  private buildUserDisplayNameSnapshotUpsert(update: MaxUpdate): Prisma.Sql | null {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId || isPrivateDirectChatId(chatId)) {
      return null;
    }

    const trustedObservedAt = readWebhookEventTimestamp(update);
    const observedAt = trustedObservedAt ?? new Date();
    const sourceEventId =
      this.readTrimmedString(update.updateId) ??
      this.readTrimmedString(update.message?.messageId) ??
      `${update.type.trim().toLowerCase() || 'webhook'}:${observedAt.toISOString()}`;
    const normalizedType = update.type.trim().toLowerCase() || 'webhook';
    const sourceKindSuffix = trustedObservedAt ? '' : ':ingress';
    const observations: ChatUserDisplayNameObservation[] = [];
    const senderId = update.message?.senderId?.trim() ?? '';
    const senderName = update.message?.senderName?.trim() ?? '';
    if (senderId && senderName) {
      observations.push({
        chatId,
        userId: senderId,
        displayName: senderName,
        observedAt,
        sourceEventId,
        sourceKind: `${normalizedType}:sender${sourceKindSuffix}`,
      });
    }

    const membershipAction = this.resolveMembershipActivityAction(update);
    if (membershipAction) {
      for (const [userId, displayName] of this.findMembershipMemberDisplayNames(
        update.raw,
        membershipAction,
      )) {
        observations.push({
          chatId,
          userId,
          displayName,
          observedAt,
          sourceEventId,
          sourceKind: `membership:${membershipAction}${sourceKindSuffix}`,
        });
      }
    }

    return trustedObservedAt
      ? buildChatUserDisplayNameUpsert(observations)
      : buildChatUserDisplayNameInsertIfAbsent(observations);
  }

  private getMembershipActivityEventModel(): MembershipActivityEventModel | null {
    const model = (
      this.prisma as PrismaService & {
        chatMembershipActivityEvent?: {
          createMany?: MembershipActivityEventModel['createMany'];
        };
      }
    ).chatMembershipActivityEvent;
    return typeof model?.createMany === 'function'
      ? { createMany: model.createMany.bind(model) }
      : null;
  }

  private async upsertManagedEntityLocalActivity(
    rawClient: Required<ManagedEntityLocalActivityRawClient>,
    projection: ManagedEntityLocalActivityProjection,
  ): Promise<void> {
    await rawClient.$executeRaw(Prisma.sql`
      INSERT INTO managed_entity_local_activities (
        user_id,
        chat_id,
        entity_type,
        chat_title,
        source_event_type,
        bot_id,
        last_event_at,
        created_at,
        updated_at
      )
      VALUES (
        ${projection.userId},
        ${projection.chatId},
        ${projection.entityType}::"ChatEntityType",
        ${projection.chatTitle ?? null},
        ${projection.sourceEventType},
        ${projection.botId ?? null},
        ${projection.lastEventAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (user_id, chat_id) DO UPDATE SET
        entity_type = EXCLUDED.entity_type,
        chat_title = COALESCE(EXCLUDED.chat_title, managed_entity_local_activities.chat_title),
        source_event_type = EXCLUDED.source_event_type,
        bot_id = EXCLUDED.bot_id,
        last_event_at = EXCLUDED.last_event_at,
        updated_at = CURRENT_TIMESTAMP
      WHERE managed_entity_local_activities.last_event_at < EXCLUDED.last_event_at
    `);
  }

  private async persistMembershipTransition(update: MaxUpdate): Promise<void> {
    const projections = this.buildMembershipActivityProjections(update);
    if (projections.length === 0) {
      return;
    }

    if (typeof (this.prisma as { $transaction?: unknown }).$transaction !== 'function') {
      await this.persistMembershipActivityProjections(projections);
      return;
    }

    const transition = await this.prisma.$transaction(async (tx) => {
      const chatId = projections[0].chatId;
      await this.ensureMembershipTransitionChat(tx, update, chatId);
      const chatLocked = await this.lockChatForUserMembershipFence(tx, chatId);

      await this.upsertMembershipActivityProjections(tx, projections);
      if (!chatLocked) {
        return null;
      }

      return {
        chatId,
        eventAt: projections[0].eventAt,
        eventType: projections[0].eventType,
        deniedUserIds: await this.persistMembershipAccessReset(
          tx,
          chatId,
          projections
            .map((projection) => projection.userId?.trim() ?? '')
            .filter((userId): userId is string => userId.length > 0),
          projections[0].eventAt,
          projections[0].eventType,
        ),
      } satisfies MembershipTransitionResult;
    });

    if (transition) {
      await this.applyCommittedMembershipDenials(transition, update);
    }
  }

  private async ensureMembershipTransitionChat(
    tx: Prisma.TransactionClient,
    update: MaxUpdate,
    chatId: string,
  ): Promise<void> {
    const entityType = this.readWebhookChatEntityType(update);
    if (entityType !== ChatEntityType.CHANNEL && isPrivateDirectChatId(chatId)) {
      return;
    }

    await tx.chat.createMany({
      data: {
        id: chatId,
        title:
          update.message?.chatTitle?.trim() ||
          (entityType === ChatEntityType.CHANNEL ? `Channel ${chatId}` : `Chat ${chatId}`),
        ...(entityType ? { entityType } : {}),
      },
      skipDuplicates: true,
    });
  }

  private async persistMembershipAccessReset(
    tx: Prisma.TransactionClient,
    chatId: string,
    userIds: readonly string[],
    transitionEventAt: Date,
    membershipEventType: string,
  ): Promise<string[]> {
    const userIdFamilies = userIds
      .map((userId) => [...this.buildMembershipUserIdVariants(userId)])
      .filter((variants) => variants.length > 0);
    const normalizedUserIds = Array.from(new Set(userIdFamilies.flat()));
    if (normalizedUserIds.length === 0) {
      return [];
    }

    const denialSource = `webhook_${membershipEventType}`;
    const edgeAdvanceStartedAtMs = Date.now();
    const edgeAdvance = await tx.managedEntityAccessEdge.updateMany({
      where: buildMembershipDenialEdgeAdvanceWhere({
        chatId,
        userIds: normalizedUserIds,
        eventAt: transitionEventAt,
        source: denialSource,
      }),
      data: {
        state: ManagedEntityAccessState.USER_DENIED,
        userRole: 'MEMBER',
        botRole: 'UNKNOWN',
        checkedAt: transitionEventAt,
        expiresAt: null,
        deniedReason: denialSource,
        source: denialSource,
      },
    });
    this.recordMembershipAccessEdgeAdvanceMetric({
      durationMs: Date.now() - edgeAdvanceStartedAtMs,
      affectedRows: edgeAdvance.count,
    });
    await tx.managedEntityAdminMember.deleteMany({
      where: {
        chatId,
        userId: { in: normalizedUserIds },
        checkedAt: { lte: transitionEventAt },
      },
    });

    const [newerGrantedEdges, newerAdminMembers] = await Promise.all([
      tx.managedEntityAccessEdge.findMany({
        where: {
          chatId,
          userId: { in: normalizedUserIds },
          state: ManagedEntityAccessState.GRANTED,
          checkedAt: { gt: transitionEventAt },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
      tx.managedEntityAdminMember.findMany({
        where: {
          chatId,
          userId: { in: normalizedUserIds },
          checkedAt: { gt: transitionEventAt },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);
    const usersWithNewerGrant = new Set([
      ...newerGrantedEdges.map(({ userId }) => userId),
      ...newerAdminMembers.map(({ userId }) => userId),
    ]);
    const deniedUserIds = Array.from(
      new Set(
        userIdFamilies
          .filter((variants) => !variants.some((variant) => usersWithNewerGrant.has(variant)))
          .flat(),
      ),
    );
    if (deniedUserIds.length > 0) {
      await tx.chatAdminAllowlist.deleteMany({
        where: {
          chatId,
          userId: { in: deniedUserIds },
        },
      });
    }

    return deniedUserIds;
  }

  private buildMembershipUserIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
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

  private async applyCommittedMembershipDenials(
    transition: MembershipTransitionResult,
    update: Pick<MaxUpdate, 'type'>,
  ): Promise<void> {
    const epochCache = this.chatContextCache;
    if (!epochCache || transition.deniedUserIds.length === 0) {
      return;
    }

    epochCache.invalidateLocal?.(transition.chatId);
    const mutationsByKey = new Map<string, MembershipDenialCacheMutation>();
    for (const userId of transition.deniedUserIds) {
      const key = this.buildMembershipDenialCacheMutationKey(transition, userId);
      if (!mutationsByKey.has(key)) {
        mutationsByKey.set(key, { key, userId });
      }
    }
    const mutations = [...mutationsByKey.values()];
    const publicationKey = this.buildMembershipDenialCachePublicationKey(mutations);
    const existingPublication = this.getMembershipDenialCachePublication(publicationKey);
    const mutationsToPublish =
      existingPublication?.state === 'failed' && existingPublication.failedMutationKeys
        ? mutations.filter(({ key }) => existingPublication.failedMutationKeys?.has(key))
        : mutations;
    const publicationNeedsWork =
      existingPublication === null || existingPublication.state === 'failed';
    const newMutationCount = mutationsToPublish.filter(
      ({ key }) => this.getMembershipDenialCacheMutationTask(key) === null,
    ).length;
    const cannotAdmitNewPublication =
      publicationNeedsWork &&
      (this.membershipDenialCachePendingPublicationCount >=
        this.membershipDenialCacheMaxPendingPublications ||
        (newMutationCount > 0 &&
          (newMutationCount <= this.membershipDenialCacheMaxInFlight
            ? this.membershipDenialCacheInFlightTaskCount + newMutationCount >
              this.membershipDenialCacheMaxInFlight
            : this.membershipDenialCacheInFlightTaskCount > 0)));
    if (this.membershipDenialCacheShuttingDown || cannotAdmitNewPublication) {
      const rejectedCount = this.membershipDenialCacheShuttingDown
        ? mutations.length
        : Math.max(1, newMutationCount);
      this.recordMembershipDenialCacheWorkMetric({
        outcome: 'rejected',
        count: rejectedCount,
        inFlight: this.membershipDenialCacheInFlightTaskCount,
      });
      this.logger.warn(
        {
          type: update.type,
          deniedUserCount: mutations.length,
          newMutationCount,
          inFlightTaskCount: this.membershipDenialCacheInFlightTaskCount,
          maxInFlightTaskCount: this.membershipDenialCacheMaxInFlight,
          pendingPublicationCount: this.membershipDenialCachePendingPublicationCount,
          maxPendingPublicationCount: this.membershipDenialCacheMaxPendingPublications,
          shuttingDown: this.membershipDenialCacheShuttingDown,
        },
        'Rejected committed membership denial cache publication for retry',
      );
      throw new WebhookPreparationDeferredError(
        'Committed membership denial cache publication capacity is unavailable',
        MEMBERSHIP_DENIAL_CACHE_RETRY_MS,
      );
    }

    const recordMutationMetric = this.webhookIngressMetricsService
      ? (metric: AdminAccessEpochMutationMetric) =>
          this.webhookIngressMetricsService?.recordMembershipCacheMutation(metric)
      : undefined;
    const publication =
      existingPublication && existingPublication.state !== 'failed'
        ? existingPublication
        : this.trackMembershipDenialCachePublication(publicationKey, () =>
            this.runMembershipDenialCachePublication(
              transition,
              mutationsToPublish,
              epochCache,
              recordMutationMetric,
            ),
          );
    if (publication.state === 'succeeded') {
      return;
    }
    if (publication.state === 'pending' && publication.waitBudgetClaimed) {
      throw new WebhookPreparationDeferredError(
        publication.waitBudgetExhausted
          ? 'Committed membership denial cache publication exceeded its wait budget'
          : 'Committed membership denial cache publication is already pending',
        MEMBERSHIP_DENIAL_CACHE_RETRY_MS,
      );
    }

    publication.waitBudgetClaimed = true;
    const budgetStartedAtMs = Date.now();
    const completed = publication.promise;
    let budgetTimer: NodeJS.Timeout | null = null;
    const outcome = await Promise.race([
      completed.then((failures) => ({ kind: 'completed' as const, failures })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        budgetTimer = setTimeout(
          () => resolve({ kind: 'timeout' }),
          MEMBERSHIP_DENIAL_CACHE_WAIT_BUDGET_MS,
        );
        budgetTimer.unref();
      }),
    ]);
    if (budgetTimer) {
      clearTimeout(budgetTimer);
    }
    this.recordMembershipCacheBudgetMetric({
      outcome: outcome.kind,
      durationMs: Date.now() - budgetStartedAtMs,
    });

    if (outcome.kind === 'timeout') {
      publication.waitBudgetExhausted = true;
      this.logger.warn(
        {
          type: update.type,
          deniedUserCount: transition.deniedUserIds.length,
          waitBudgetMs: MEMBERSHIP_DENIAL_CACHE_WAIT_BUDGET_MS,
        },
        'Committed membership denial cache publication exceeded its wait budget',
      );
      this.observeMembershipDenialCachePublicationAfterTimeout(publication, completed, update);
      throw new WebhookPreparationDeferredError(
        'Committed membership denial cache publication exceeded its wait budget',
        MEMBERSHIP_DENIAL_CACHE_RETRY_MS,
      );
    }

    this.logMembershipDenialCacheFailures(outcome.failures, update);
    if (outcome.failures.some(({ error }) => error !== null)) {
      throw new WebhookPreparationDeferredError(
        'Committed membership denial cache publication failed',
        MEMBERSHIP_DENIAL_CACHE_RETRY_MS,
      );
    }
  }

  private observeMembershipDenialCachePublicationAfterTimeout(
    publication: MembershipDenialCachePublicationTask,
    completed: Promise<readonly MembershipDenialCacheMutationResult[]>,
    update: Pick<MaxUpdate, 'type'>,
  ): void {
    if (publication.lateObserverAttached) {
      return;
    }
    publication.lateObserverAttached = true;
    void completed.then(
      (failures) => this.logMembershipDenialCacheFailures(failures, update),
      (error: unknown) => {
        this.logger.warn(
          {
            type: update.type,
            err: error instanceof Error ? error.message : String(error),
          },
          'Committed membership denial cache publication failed after its wait budget',
        );
      },
    );
  }

  private async runMembershipDenialCachePublication(
    transition: MembershipTransitionResult,
    mutations: readonly MembershipDenialCacheMutation[],
    epochCache: ChatContextCacheService,
    recordMutationMetric?: (metric: AdminAccessEpochMutationMetric) => void,
  ): Promise<readonly MembershipDenialCacheMutationResult[]> {
    const tasks = new Map<string, Promise<MembershipDenialCacheMutationResult>>();
    let nextMutationIndex = 0;

    while (nextMutationIndex < mutations.length) {
      const mutation = mutations[nextMutationIndex]!;
      const existing = this.getMembershipDenialCacheMutationTask(mutation.key);
      if (existing) {
        tasks.set(mutation.key, existing.promise);
        nextMutationIndex += 1;
        continue;
      }

      if (this.membershipDenialCacheInFlightTaskCount >= this.membershipDenialCacheMaxInFlight) {
        await this.waitForMembershipDenialCacheCapacity();
        continue;
      }

      tasks.set(
        mutation.key,
        this.trackMembershipDenialCacheMutation(
          mutation.key,
          async () => {
            await epochCache.applyAdminAccessEpochMutation(
              {
                chatId: transition.chatId,
                userId: mutation.userId,
                state: 'user_denied',
                eventAt: transition.eventAt,
              },
              {
                precheckSupersededEpoch: true,
                ...(recordMutationMetric ? { recordMetric: recordMutationMetric } : {}),
              },
            );
          },
          mutation.userId,
        ),
      );
      nextMutationIndex += 1;
    }

    return Promise.all(tasks.values());
  }

  private async waitForMembershipDenialCacheCapacity(): Promise<void> {
    const pending = [...this.membershipDenialCacheTasks.values()]
      .filter((task) => task.state === 'pending')
      .map((task) => task.promise);
    if (pending.length === 0) {
      throw new Error('Membership denial cache capacity accounting lost its pending task');
    }
    await Promise.race(pending);
  }

  private trackMembershipDenialCacheMutation(
    key: string,
    operation: () => Promise<void>,
    userId: string,
  ): Promise<MembershipDenialCacheMutationResult> {
    const existing = this.getMembershipDenialCacheMutationTask(key);
    if (existing) {
      return existing.promise;
    }

    let timeout: NodeJS.Timeout | null = null;
    const settled = Promise.resolve()
      .then(operation)
      .then(
        () => ({ key, userId, error: null }),
        (error: unknown) => ({ key, userId, error }),
      );
    const task: MembershipDenialCacheMutationTask = {
      promise: settled,
      state: 'pending',
      retainUntilMs: null,
    };
    const tracked = settled.then((result) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.membershipDenialCacheInFlightTaskCount -= 1;
      if (this.membershipDenialCacheTasks.get(key) === task) {
        if (result.error === null) {
          task.state = 'succeeded';
          task.retainUntilMs = Date.now() + MEMBERSHIP_DENIAL_CACHE_SUCCESS_RETENTION_MS;
          this.membershipDenialCacheSettledTaskCount += 1;
          this.membershipDenialCacheTasks.delete(key);
          this.membershipDenialCacheTasks.set(key, task);
          this.pruneMembershipDenialCacheMutationTasks();
        } else {
          this.deleteMembershipDenialCacheMutationTask(key, task);
        }
      }
      this.recordMembershipDenialCacheWorkMetric({
        outcome: result.error === null ? 'completed' : 'failure',
        inFlight: this.membershipDenialCacheInFlightTaskCount,
      });
      return result;
    });
    task.promise = tracked;
    this.membershipDenialCacheTasks.set(key, task);
    this.membershipDenialCacheInFlightTaskCount += 1;
    this.recordMembershipDenialCacheWorkMetric({
      outcome: null,
      inFlight: this.membershipDenialCacheInFlightTaskCount,
    });
    timeout = setTimeout(() => {
      timeout = null;
      if (this.membershipDenialCacheTasks.get(key) !== task || task.state !== 'pending') {
        return;
      }
      this.recordMembershipDenialCacheWorkMetric({
        outcome: 'timeout',
        inFlight: this.membershipDenialCacheInFlightTaskCount,
      });
    }, MEMBERSHIP_DENIAL_CACHE_WAIT_BUDGET_MS);
    timeout.unref();
    return tracked;
  }

  private getMembershipDenialCacheMutationTask(
    key: string,
  ): MembershipDenialCacheMutationTask | null {
    const task = this.membershipDenialCacheTasks.get(key) ?? null;
    if (
      task?.state === 'succeeded' &&
      task.retainUntilMs !== null &&
      task.retainUntilMs <= Date.now()
    ) {
      this.deleteMembershipDenialCacheMutationTask(key, task);
      return null;
    }
    return task;
  }

  private deleteMembershipDenialCacheMutationTask(
    key: string,
    task: MembershipDenialCacheMutationTask,
  ): void {
    if (this.membershipDenialCacheTasks.get(key) !== task) {
      return;
    }
    this.membershipDenialCacheTasks.delete(key);
    if (task.state === 'succeeded') {
      this.membershipDenialCacheSettledTaskCount -= 1;
    }
  }

  private pruneMembershipDenialCacheMutationTasks(): void {
    while (this.membershipDenialCacheSettledTaskCount > MEMBERSHIP_DENIAL_CACHE_MAX_SETTLED_TASKS) {
      let deleted = false;
      for (const [key, task] of this.membershipDenialCacheTasks) {
        if (task.state !== 'succeeded') {
          continue;
        }
        this.deleteMembershipDenialCacheMutationTask(key, task);
        deleted = true;
        break;
      }
      if (!deleted) {
        return;
      }
    }
  }

  private trackMembershipDenialCachePublication(
    key: string,
    operation: () => Promise<readonly MembershipDenialCacheMutationResult[]>,
  ): MembershipDenialCachePublicationTask {
    const existing = this.getMembershipDenialCachePublication(key);
    if (existing && existing.state !== 'failed') {
      return existing;
    }

    const publication: MembershipDenialCachePublicationTask = existing ?? {
      promise: Promise.resolve([]),
      state: 'pending',
      retainUntilMs: null,
      failedMutationKeys: null,
      waitBudgetClaimed: false,
      waitBudgetExhausted: false,
      lateObserverAttached: false,
    };
    if (existing?.state === 'failed') {
      this.membershipDenialCacheSettledPublicationCount -= 1;
    }
    publication.state = 'pending';
    publication.retainUntilMs = null;
    publication.failedMutationKeys = null;
    publication.waitBudgetClaimed = false;
    publication.waitBudgetExhausted = false;
    publication.lateObserverAttached = false;
    this.membershipDenialCachePublications.set(key, publication);
    this.membershipDenialCachePendingPublicationCount += 1;

    let operationPromise: Promise<readonly MembershipDenialCacheMutationResult[]>;
    try {
      operationPromise = operation();
    } catch (error: unknown) {
      operationPromise = Promise.reject(error);
    }
    const tracked = operationPromise.then(
      (results) => {
        if (this.membershipDenialCachePublications.get(key) === publication) {
          const failedMutationKeys = new Set(
            results
              .filter(({ error }) => error !== null)
              .map(({ key: mutationKey }) => mutationKey),
          );
          publication.state = failedMutationKeys.size === 0 ? 'succeeded' : 'failed';
          publication.retainUntilMs = Date.now() + MEMBERSHIP_DENIAL_CACHE_SUCCESS_RETENTION_MS;
          publication.failedMutationKeys =
            failedMutationKeys.size === 0 ? null : failedMutationKeys;
          publication.promise = Promise.resolve([]);
          this.membershipDenialCachePendingPublicationCount -= 1;
          this.membershipDenialCacheSettledPublicationCount += 1;
          this.membershipDenialCachePublications.delete(key);
          this.membershipDenialCachePublications.set(key, publication);
          this.pruneMembershipDenialCachePublications();
        }
        return results;
      },
      (error: unknown) => {
        this.deleteMembershipDenialCachePublication(key, publication);
        throw error;
      },
    );
    publication.promise = tracked;
    return publication;
  }

  private getMembershipDenialCachePublication(
    key: string,
  ): MembershipDenialCachePublicationTask | null {
    const publication = this.membershipDenialCachePublications.get(key) ?? null;
    if (
      publication !== null &&
      publication.state !== 'pending' &&
      publication.retainUntilMs !== null &&
      publication.retainUntilMs <= Date.now()
    ) {
      this.deleteMembershipDenialCachePublication(key, publication);
      return null;
    }
    return publication;
  }

  private deleteMembershipDenialCachePublication(
    key: string,
    publication: MembershipDenialCachePublicationTask,
  ): void {
    if (this.membershipDenialCachePublications.get(key) !== publication) {
      return;
    }
    this.membershipDenialCachePublications.delete(key);
    if (publication.state === 'pending') {
      this.membershipDenialCachePendingPublicationCount -= 1;
    } else {
      this.membershipDenialCacheSettledPublicationCount -= 1;
    }
  }

  private pruneMembershipDenialCachePublications(): void {
    while (
      this.membershipDenialCacheSettledPublicationCount >
      MEMBERSHIP_DENIAL_CACHE_MAX_SETTLED_PUBLICATIONS
    ) {
      let deleted = false;
      for (const [key, publication] of this.membershipDenialCachePublications) {
        if (publication.state === 'pending') {
          continue;
        }
        this.deleteMembershipDenialCachePublication(key, publication);
        deleted = true;
        break;
      }
      if (!deleted) {
        return;
      }
    }
  }

  private buildMembershipDenialCacheMutationKey(
    transition: MembershipTransitionResult,
    userId: string,
  ): string {
    return JSON.stringify([transition.chatId, userId, transition.eventAt.toISOString()]);
  }

  private buildMembershipDenialCachePublicationKey(
    mutations: readonly MembershipDenialCacheMutation[],
  ): string {
    const digest = createHash('sha256');
    const keys = mutations.map(({ key }) => key).sort();
    for (const key of keys) {
      digest.update(`${key.length}:`);
      digest.update(key);
    }
    return digest.digest('base64url');
  }

  private logMembershipDenialCacheFailures(
    failures: readonly MembershipDenialCacheMutationResult[],
    update: Pick<MaxUpdate, 'type'>,
  ): void {
    const failureCount = failures.filter(({ error }) => error !== null).length;
    if (failureCount === 0) {
      return;
    }
    this.logger.warn(
      {
        type: update.type,
        attemptedMutationCount: failures.length,
        failedMutationCount: failureCount,
      },
      'Failed to publish committed membership denial to cache',
    );
  }

  private recordMembershipCacheBudgetMetric(metric: {
    outcome: 'completed' | 'timeout';
    durationMs: number;
  }): void {
    try {
      this.webhookIngressMetricsService?.recordMembershipCacheBudget(metric);
    } catch {
      // Metrics must never affect committed membership transitions.
    }
  }

  private recordMembershipDenialCacheWorkMetric(metric: {
    outcome: 'completed' | 'timeout' | 'failure' | 'rejected' | null;
    inFlight: number;
    count?: number;
  }): void {
    try {
      this.webhookIngressMetricsService?.recordMembershipCacheDetachedWork?.(metric);
    } catch {
      // Metrics must never affect committed membership transitions.
    }
  }

  private recordMembershipAccessEdgeAdvanceMetric(metric: {
    durationMs: number;
    affectedRows: number;
  }): void {
    try {
      this.webhookIngressMetricsService?.recordMembershipAccessEdgeAdvance(metric);
    } catch {
      // Metrics must never affect membership transition transactions.
    }
  }

  private async persistMembershipActivityProjections(
    projections: readonly MembershipActivityProjection[],
  ): Promise<void> {
    const rawClient = this.prisma as ManagedEntityLocalActivityRawClient;
    if (typeof rawClient.$executeRaw === 'function') {
      await this.upsertMembershipActivityProjections(
        rawClient as Required<ManagedEntityLocalActivityRawClient>,
        projections,
      );
      return;
    }

    const membershipModel = this.getMembershipActivityEventModel();
    if (!membershipModel) {
      return;
    }
    await membershipModel.createMany({
      data: [...projections],
      skipDuplicates: true,
    });
  }

  private async upsertMembershipActivityProjections(
    rawClient: Required<ManagedEntityLocalActivityRawClient>,
    projections: readonly MembershipActivityProjection[],
  ): Promise<void> {
    const statement = Prisma.sql`
      WITH incoming (
        "id",
        "dedupe_key",
        "bot_id",
        "chat_id",
        "event_type",
        "user_id",
        "sender_name",
        "event_at",
        "created_at"
      ) AS (
      VALUES ${Prisma.join(
        projections.map(
          (projection) => Prisma.sql`(
            ${projection.id},
            ${projection.dedupeKey},
            ${projection.botId ?? null},
            ${projection.chatId},
            ${projection.eventType},
            ${projection.userId ?? null},
            ${projection.senderName ?? null},
            ${projection.eventAt}::timestamp(3),
            ${projection.createdAt}::timestamp(3)
          )`,
        ),
      )}
      )
      INSERT INTO "chat_membership_activity_events" AS existing (
        "id",
        "dedupe_key",
        "bot_id",
        "chat_id",
        "event_type",
        "user_id",
        "sender_name",
        "event_at",
        "created_at"
      )
      SELECT
        "id",
        "dedupe_key",
        "bot_id",
        "chat_id",
        "event_type",
        "user_id",
        "sender_name",
        "event_at",
        "created_at"
      FROM incoming
      ON CONFLICT ("dedupe_key") DO UPDATE SET
        "bot_id" = COALESCE(existing."bot_id", EXCLUDED."bot_id"),
        "sender_name" = CASE
          WHEN COALESCE(BTRIM(existing."sender_name"), '') = ''
            THEN EXCLUDED."sender_name"
          ELSE existing."sender_name"
        END,
        "event_at" = GREATEST(existing."event_at", EXCLUDED."event_at")
      WHERE
        (
          existing."bot_id" IS NULL
          AND EXCLUDED."bot_id" IS NOT NULL
        )
        OR (
          COALESCE(BTRIM(existing."sender_name"), '') = ''
          AND COALESCE(BTRIM(EXCLUDED."sender_name"), '') <> ''
        )
        OR existing."event_at" < EXCLUDED."event_at"
    `;
    await rawClient.$executeRaw(withStatsMembershipInvalidation(statement));
  }

  private buildMembershipActivityProjections(update: MaxUpdate): MembershipActivityProjection[] {
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!chatId) {
      return [];
    }

    const eventType = this.resolveMembershipActivityEventType(update);
    if (!eventType) {
      return [];
    }

    const memberUserIds = this.resolveMembershipActivityUserIds(update);
    if (memberUserIds.length === 0) {
      return [];
    }

    const eventAt = this.resolveUpdateEventAt(update);
    const membershipAction = eventType === 'user_removed' ? 'removed' : 'added';
    const memberDisplayNames = this.findMembershipMemberDisplayNames(update.raw, membershipAction);
    return memberUserIds.map((userId, index) => ({
      id: this.buildMembershipActivityProjectionId(
        update.updateId,
        eventType,
        userId,
        memberUserIds.length,
        index,
      ),
      dedupeKey: this.buildMembershipActivityDedupeKey(eventType, chatId, userId, eventAt),
      botId: update.botId?.trim() || null,
      chatId,
      eventType,
      userId,
      senderName: this.resolveMembershipActivitySenderName(update, userId, memberDisplayNames),
      eventAt,
      createdAt: eventAt,
    }));
  }

  private resolveMembershipActivityEventType(update: MaxUpdate): string | null {
    const normalizedType = update.type.trim().toLowerCase();
    const membershipAction = update.membership?.action;
    if (normalizedType === 'message_created' && membershipAction === 'added') {
      return 'user_added';
    }
    if (normalizedType === 'message_created' && membershipAction === 'removed') {
      return 'user_removed';
    }

    return MEMBERSHIP_ACTIVITY_UPDATE_TYPES.has(normalizedType) ? normalizedType : null;
  }

  private resolveMembershipActivityAction(update: MaxUpdate): 'added' | 'removed' | null {
    const eventType = this.resolveMembershipActivityEventType(update);
    if (eventType === 'user_added') {
      return 'added';
    }
    if (eventType === 'user_removed') {
      return 'removed';
    }

    return null;
  }

  private resolveMembershipActivityUserIds(update: MaxUpdate): string[] {
    const memberUserIds = update.membership?.memberUserIds ?? [];
    const normalizedMemberUserIds = Array.from(
      new Set(
        memberUserIds
          .map((userId) => userId.trim())
          .filter((userId): userId is string => userId.length > 0),
      ),
    );
    if (normalizedMemberUserIds.length > 0) {
      return normalizedMemberUserIds;
    }

    const senderId = update.message?.senderId?.trim() ?? '';
    return senderId ? [senderId] : [];
  }

  private buildMembershipActivityProjectionId(
    updateId: string,
    eventType: string,
    userId: string,
    totalUsers: number,
    index: number,
  ): string {
    if (totalUsers === 1) {
      return updateId;
    }

    return `${updateId}:${eventType}:${userId || index}`;
  }

  private resolveMembershipActivitySenderName(
    update: MaxUpdate,
    userId: string,
    memberDisplayNames: ReadonlyMap<string, string>,
  ): string | null {
    const rawName = memberDisplayNames.get(userId);
    if (rawName) {
      return rawName;
    }

    const senderId = update.message?.senderId?.trim() ?? '';
    if (senderId && senderId === userId) {
      return update.message?.senderName?.trim() || null;
    }

    return null;
  }

  private findMembershipMemberDisplayNames(
    node: unknown,
    action: 'added' | 'removed',
  ): Map<string, string> {
    const displayNames = new Map<string, string>();
    this.collectMembershipMemberDisplayNames(node, action, displayNames);
    return displayNames;
  }

  private collectMembershipMemberDisplayNames(
    node: unknown,
    action: 'added' | 'removed',
    displayNames: Map<string, string>,
    depth = 0,
    insideMembershipCollection = false,
  ): void {
    if (depth > 6 || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectMembershipMemberDisplayNames(
          item,
          action,
          displayNames,
          depth + 1,
          insideMembershipCollection,
        );
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    if (insideMembershipCollection) {
      const userId = this.readMembershipMemberUserId(row);
      const displayName = this.readMembershipMemberDisplayName(row);
      if (userId && displayName && !displayNames.has(userId)) {
        displayNames.set(userId, displayName);
      }
      if (userId) {
        return;
      }
    }

    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.trim().toLowerCase();
      this.collectMembershipMemberDisplayNames(
        value,
        action,
        displayNames,
        depth + 1,
        insideMembershipCollection || this.isMembershipCollectionKey(normalizedKey, action),
      );
    }
  }

  private readMembershipMemberUserId(row: Record<string, unknown>): string | null {
    const directUser = this.asRecord(row.user) ?? this.asRecord(row.member);
    return (
      this.readTrimmedString(row.user_id) ??
      this.readTrimmedString(row.userId) ??
      this.readTrimmedString(row.id) ??
      this.readTrimmedString(directUser?.user_id) ??
      this.readTrimmedString(directUser?.userId) ??
      this.readTrimmedString(directUser?.id)
    );
  }

  private readMembershipMemberDisplayName(row: Record<string, unknown>): string | null {
    const directUser = this.asRecord(row.user) ?? this.asRecord(row.member) ?? row;
    return resolveMaxUserDisplayName(directUser);
  }

  private isMembershipCollectionKey(key: string, action: 'added' | 'removed'): boolean {
    if (action === 'added') {
      return (
        key === 'new_members' ||
        key === 'new_member' ||
        key === 'members_added' ||
        key === 'member_added' ||
        key === 'added_members' ||
        key === 'added_member' ||
        key === 'joined_members' ||
        key === 'joined_member' ||
        key === 'invited_members' ||
        key === 'invited_member' ||
        key === 'new_users' ||
        key === 'new_user'
      );
    }

    return (
      key === 'removed_members' ||
      key === 'removed_member' ||
      key === 'members_removed' ||
      key === 'member_removed' ||
      key === 'left_members' ||
      key === 'left_member' ||
      key === 'leaving_members' ||
      key === 'leaving_member' ||
      key === 'departed_members' ||
      key === 'departed_member' ||
      key === 'kicked_members' ||
      key === 'kicked_member'
    );
  }

  private buildManagedEntityLocalActivityProjection(update: MaxUpdate): {
    userId: string;
    chatId: string;
    entityType: ChatEntityType;
    chatTitle?: string | null;
    sourceEventType: string;
    botId?: string | null;
    lastEventAt: Date;
  } | null {
    const normalizedType = update.type.trim().toLowerCase();
    if (!MANAGED_ENTITY_ACTIVITY_UPDATE_TYPES.has(normalizedType)) {
      return null;
    }

    const userId = update.message?.senderId?.trim() ?? '';
    const chatId = update.message?.chatId?.trim() ?? '';
    if (!userId || !chatId) {
      return null;
    }

    return {
      userId,
      chatId,
      entityType: this.readWebhookChatEntityType(update) ?? ChatEntityType.CHAT,
      chatTitle: update.message?.chatTitle?.trim() || null,
      sourceEventType: normalizedType,
      botId: update.botId?.trim() || null,
      lastEventAt: this.resolveUpdateEventAt(update),
    };
  }

  private resolveUpdateEventAt(update: MaxUpdate): Date {
    const createdAtIso = update.message?.createdAt?.trim() ?? '';
    const parsedTimestamp = createdAtIso ? Date.parse(createdAtIso) : Number.NaN;
    if (Number.isFinite(parsedTimestamp)) {
      return new Date(parsedTimestamp);
    }

    return new Date();
  }

  private buildMembershipActivityDedupeKey(
    eventType: string,
    chatId: string,
    userId: string | null,
    eventAt: Date,
  ): string {
    const dedupeEventAt = this.normalizeMembershipActivityDedupeEventAt(eventAt);
    return `membership:${eventType}:${chatId}:${userId ?? ''}:${dedupeEventAt.toISOString()}`;
  }

  private normalizeMembershipActivityDedupeEventAt(eventAt: Date): Date {
    const timestampMs = eventAt.getTime();
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return eventAt;
    }

    return new Date(
      Math.floor(timestampMs / MEMBERSHIP_ACTIVITY_TIMESTAMP_GRANULARITY_MS) *
        MEMBERSHIP_ACTIVITY_TIMESTAMP_GRANULARITY_MS,
    );
  }

  private async getBotSelfModerationAccessState(
    chatId: string,
    botId: string,
    options: { bypassCache?: boolean; allowMembershipRecovery?: boolean } = {},
  ): Promise<boolean | null> {
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    if (options.bypassCache !== true) {
      const cached = this.readCachedBotSelfAccess(cacheKey);
      if (cached !== null) {
        return cached;
      }
    }

    const backoffUntilMs = this.botSelfAccessBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return null;
    }

    if (!this.maxClient) {
      return null;
    }

    const checkedAt = new Date();
    try {
      const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId,
        bypassCache: true,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        timeoutMs: BOT_SELF_ACCESS_TIMEOUT_MS,
        ignoreFailureMetricStatuses: BOT_SELF_ACCESS_FAILURE_METRIC_STATUSES,
      });
      return await this.cacheBotSelfAccess(
        chatId,
        botId,
        access,
        checkedAt,
        options.allowMembershipRecovery === true,
      );
    } catch (error: unknown) {
      if (resolveExplicitMembershipAccessDenial(error) !== null) {
        const result = await this.cacheBotSelfAccess(chatId, botId, null, checkedAt, false);
        if (this.readCachedBotSelfAccess(cacheKey) !== true) {
          this.botSelfAccessBackoffUntilMs.set(
            cacheKey,
            Date.now() + BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS,
          );
        }
        return result;
      }

      this.discardRejectedBotSelfAccessCache(cacheKey, checkedAt.getTime());
      this.botSelfAccessBackoffUntilMs.set(cacheKey, Date.now() + BOT_SELF_ACCESS_BACKOFF_MS);
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh bot self access snapshot during webhook owner failover check',
      );
      return null;
    }
  }

  private async getCachedOrPersistedBotSelfModerationAccessState(
    chatId: string,
    botId: string,
  ): Promise<boolean | null> {
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    const cached = this.readCachedBotSelfAccess(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const persisted = await this.readPersistedBotSelfAccess(chatId, botId);
    if (!persisted) {
      return null;
    }

    this.cacheBotSelfAccessState(cacheKey, persisted.canHandleUserFacing, persisted.checkedAtMs);
    return persisted.canHandleUserFacing;
  }

  private async cacheBotSelfAccess(
    chatId: string,
    botId: string,
    access: MaxChatMemberAccess | null,
    checkedAt: Date,
    allowMembershipRecovery: boolean,
  ): Promise<boolean | null> {
    const canHandleUserFacing = this.canBotHandleUserFacingUpdates(access);
    const cacheKey = this.buildBotSelfAccessCacheKey(chatId, botId);
    const persisted = await this.persistBotSelfAccessSnapshot(
      chatId,
      botId,
      access,
      checkedAt,
      allowMembershipRecovery,
    );
    if (!persisted) {
      this.discardRejectedBotSelfAccessCache(cacheKey, checkedAt.getTime(), canHandleUserFacing);
      return null;
    }

    this.cacheBotSelfAccessState(cacheKey, canHandleUserFacing, checkedAt.getTime());
    this.botSelfAccessBackoffUntilMs.delete(cacheKey);
    return canHandleUserFacing;
  }

  private async persistBotSelfAccessSnapshot(
    chatId: string,
    botId: string,
    access: MaxChatMemberAccess | null,
    checkedAt: Date,
    allowMembershipRecovery: boolean,
  ): Promise<boolean> {
    try {
      return await this.maxBotLinkService.recordBotAccessProbe({
        chatId,
        botId,
        access,
        source: 'webhook_owner_failover',
        checkedAt,
        allowMembershipRecovery,
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist bot self access snapshot during webhook owner failover check',
      );
      return false;
    }
  }

  private buildBotSelfAccessCacheKey(chatId: string, botId: string): string {
    return `${chatId}:${botId}`;
  }

  private isBotSelfAccessProbeSuppressed(cacheKey: string): boolean {
    if (this.readCachedBotSelfAccess(cacheKey) === false) {
      return true;
    }
    return (this.botSelfAccessBackoffUntilMs.get(cacheKey) ?? 0) > Date.now();
  }

  private cacheBotSelfAccessState(
    cacheKey: string,
    canHandleUserFacing: boolean,
    checkedAtMs: number | null = null,
  ): void {
    const now = Date.now();
    const normalizedCheckedAtMs =
      typeof checkedAtMs === 'number' && Number.isFinite(checkedAtMs) ? checkedAtMs : null;
    const existing = this.botSelfAccessCache.get(cacheKey);
    if (
      existing &&
      existing.checkedAtMs !== null &&
      normalizedCheckedAtMs !== null &&
      (existing.checkedAtMs > normalizedCheckedAtMs ||
        (existing.checkedAtMs === normalizedCheckedAtMs &&
          !existing.canHandleUserFacing &&
          canHandleUserFacing))
    ) {
      return;
    }

    const ttlMs = canHandleUserFacing
      ? BOT_SELF_ACCESS_CACHE_TTL_MS
      : BOT_SELF_ACCESS_NEGATIVE_CACHE_TTL_MS;
    const snapshotExpiryMs =
      normalizedCheckedAtMs !== null
        ? normalizedCheckedAtMs + BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS - now
        : null;
    const cappedTtlMs =
      snapshotExpiryMs === null ? ttlMs : Math.max(1, Math.min(ttlMs, snapshotExpiryMs));
    this.botSelfAccessCache.set(cacheKey, {
      canHandleUserFacing,
      checkedAtMs: normalizedCheckedAtMs,
      expiresAtMs: now + cappedTtlMs,
    });
  }

  private discardRejectedBotSelfAccessCache(
    cacheKey: string,
    checkedAtMs: number,
    canHandleUserFacing: boolean | null = null,
  ): void {
    const cached = this.botSelfAccessCache.get(cacheKey);
    if (!cached) {
      return;
    }

    if (cached.checkedAtMs !== null && cached.checkedAtMs > checkedAtMs) {
      return;
    }
    if (
      cached.checkedAtMs === checkedAtMs &&
      cached.canHandleUserFacing === false &&
      canHandleUserFacing === true
    ) {
      return;
    }

    this.botSelfAccessCache.delete(cacheKey);
  }

  private readCachedBotSelfAccess(cacheKey: string): boolean | null {
    const cached = this.botSelfAccessCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAtMs <= Date.now()) {
      this.botSelfAccessCache.delete(cacheKey);
      return null;
    }
    return cached.canHandleUserFacing;
  }

  private async readPersistedBotSelfAccess(
    chatId: string,
    botId: string,
  ): Promise<PersistedBotSelfAccessSnapshot | null> {
    const membershipModel = (
      this.prisma as PrismaService & {
        chatBotMembership?: {
          findUnique?: (args: {
            where: {
              chatId_botId: {
                chatId: string;
                botId: string;
              };
            };
            select: {
              permissionsSnapshot: true;
            };
          }) => Promise<{ permissionsSnapshot: unknown } | null>;
        };
      }
    ).chatBotMembership;
    if (typeof membershipModel?.findUnique !== 'function') {
      return null;
    }

    try {
      const membership = await membershipModel.findUnique({
        where: {
          chatId_botId: {
            chatId,
            botId,
          },
        },
        select: {
          permissionsSnapshot: true,
        },
      });
      return this.normalizePersistedBotSelfAccessSnapshot(membership?.permissionsSnapshot ?? null);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read persisted bot self access snapshot during webhook owner check',
      );
      return null;
    }
  }

  private normalizePersistedBotSelfAccessSnapshot(
    value: unknown,
  ): PersistedBotSelfAccessSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const checkedAtRaw = typeof row.checkedAt === 'string' ? row.checkedAt.trim() : '';
    const checkedAtMs = checkedAtRaw ? Date.parse(checkedAtRaw) : Number.NaN;
    if (!Number.isFinite(checkedAtMs)) {
      return null;
    }
    if (checkedAtMs + BOT_SELF_ACCESS_SNAPSHOT_MAX_AGE_MS <= Date.now()) {
      return null;
    }

    const permissions = Array.isArray(row.permissions)
      ? row.permissions.filter((permission): permission is string => typeof permission === 'string')
      : [];
    return {
      canHandleUserFacing: this.canBotHandleUserFacingFlags({
        isAdmin: row.isAdmin === true,
        isOwner: row.isOwner === true,
        permissions,
      }),
      checkedAtMs: Math.trunc(checkedAtMs),
    };
  }

  private canBotHandleUserFacingUpdates(access: MaxChatMemberAccess | null): boolean {
    return this.canBotHandleUserFacingFlags({
      isAdmin: access?.isAdmin === true,
      isOwner: access?.isOwner === true,
      permissions: access?.permissions ?? [],
    });
  }

  private canBotHandleUserFacingFlags(params: {
    isAdmin: boolean;
    isOwner: boolean;
    permissions: readonly string[];
  }): boolean {
    if (params.isOwner) {
      return true;
    }

    if (!params.isAdmin) {
      return false;
    }

    const permissions = Array.from(
      new Set(
        (params.permissions ?? [])
          .map((permission) =>
            permission
              .trim()
              .toLowerCase()
              .replace(/[-\s]+/gu, '_'),
          )
          .filter((permission) => permission.length > 0),
      ),
    );
    if (permissions.length === 0) {
      // Older MAX payloads may not expose granular permissions for admins.
      return params.isAdmin;
    }

    return permissions.some((permission) => this.isUserFacingModerationPermission(permission));
  }

  private isUserFacingModerationPermission(permission: string): boolean {
    return (
      permission === 'delete' ||
      permission === 'delete_message' ||
      permission === 'delete_messages' ||
      permission === 'can_delete_message' ||
      permission === 'can_delete_messages' ||
      permission === 'post_edit_delete_message' ||
      permission === 'post_edit_delete_messages' ||
      permission === 'can_post_edit_delete_message' ||
      permission === 'can_post_edit_delete_messages' ||
      permission === 'add_remove_members' ||
      permission === 'can_add_remove_members' ||
      permission === 'write' ||
      permission === 'send_messages' ||
      permission === 'can_send_messages' ||
      permission === 'read_all_messages' ||
      permission === 'can_read_all_messages'
    );
  }

  private isBotRemovalUpdate(update: MaxUpdate): boolean {
    const normalizedType = update.type.trim().toLowerCase();
    return (
      normalizedType === 'bot_removed' ||
      (EXTENDED_TERMINAL_BOT_LIFECYCLE_UPDATE_TYPES.has(normalizedType) &&
        this.shouldApplyExtendedLifecycleUpdate(update))
    );
  }

  private shouldApplyExtendedLifecycleUpdate(update: MaxUpdate): boolean {
    const semanticKey =
      buildWebhookSemanticEventKey(update) ??
      `extended-lifecycle:${update.type}:${update.message?.chatId ?? ''}:${update.botId ?? ''}:${update.updateId ?? ''}`;
    return shouldEnforceCanonicalWebhookExecution({
      mode: this.resolveEntityScopedCanaryMode(
        this.extendedLifecycleMode,
        this.extendedLifecycleCanaryEntityIds,
        update.message?.chatId,
      ),
      canaryPercent: this.extendedLifecycleCanaryPercent,
      semanticKey,
    });
  }

  private parseCanaryEntityIds(value: unknown): ReadonlySet<string> {
    const raw = typeof value === 'string' ? value : '';
    return new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  private resolveEntityScopedCanaryMode(
    mode: WebhookCanonicalExecutionMode,
    canaryEntityIds: ReadonlySet<string>,
    entityId: string | null | undefined,
  ): WebhookCanonicalExecutionMode {
    if (mode !== 'canary') {
      return mode;
    }
    const normalizedEntityId = entityId?.trim() ?? '';
    return normalizedEntityId &&
      (canaryEntityIds.has('*') || canaryEntityIds.has(normalizedEntityId))
      ? 'canary'
      : 'shadow';
  }

  private resolveRemovedChatBotId(update: MaxUpdate): string | null {
    return update.botId?.trim() || null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private async scheduleExecutionOwnerFailoverRecheck(params: {
    update: MaxUpdate;
    chatId: string;
    incomingBotId: string | null;
    currentOwnerBotId: string | null;
  }): Promise<void> {
    if (
      this.executionOwnerReadiness &&
      this.shouldScheduleExecutionOwnerFailoverRecheck(params.update)
    ) {
      const proof = await this.executionOwnerReadiness.ensureReady({
        chatId: params.chatId,
        preferredBotId: params.incomingBotId,
      });
      if (!proof)
        throw new WebhookExecutionOwnerUnavailableError('No eligible moderation executor', 5_000);
      this.attachExecutionOwnerBotId(params.update, proof.botId);
      return;
    }
    if (!this.maxClient) {
      return;
    }

    if (!this.shouldScheduleExecutionOwnerFailoverRecheck(params.update)) {
      return;
    }

    const chatId = params.chatId.trim();
    const incomingBotId = params.incomingBotId?.trim() ?? '';
    const currentOwnerBotId = params.currentOwnerBotId?.trim() ?? '';
    if (
      !chatId.startsWith('-') ||
      !incomingBotId ||
      !currentOwnerBotId ||
      (incomingBotId === currentOwnerBotId && !this.executionOwnerReadiness)
    ) {
      return;
    }

    const backoffKey = `${chatId}:${currentOwnerBotId}:${incomingBotId}`;
    const backoffUntilMs = this.executionOwnerRecheckBackoffUntilMs.get(backoffKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return;
    }

    try {
      const owner = await this.maybeFailOverExecutionOwner({
        update: params.update,
        chatId,
        incomingBotId,
        currentOwnerBotId,
        allowLiveCheck: true,
      });
      this.attachExecutionOwnerBotId(params.update, owner);
      this.executionOwnerRecheckBackoffUntilMs.set(
        backoffKey,
        Date.now() + EXECUTION_OWNER_ASYNC_RECHECK_BACKOFF_MS,
      );
    } catch (error: unknown) {
      this.executionOwnerRecheckBackoffUntilMs.delete(backoffKey);
      throw new WebhookPreparationDeferredError('Execution owner recheck pending', 1_000, error);
    }
  }

  private async schedulePendingExecutionOwnerFailoverRecheck(
    params: ExecutionOwnerFailoverRecheckParams | null,
  ): Promise<void> {
    if (!params) {
      return;
    }

    await this.scheduleExecutionOwnerFailoverRecheck(params);
  }

  private shouldScheduleExecutionOwnerFailoverRecheck(update: MaxUpdate): boolean {
    if (
      update.message?.entityType !== 'channel' &&
      isPrivateDirectChatId(update.message?.chatId ?? '')
    )
      return false;
    const normalizedType = update.type.trim().toLowerCase();
    return (
      normalizedType === 'message_created' ||
      normalizedType === 'message_edited' ||
      normalizedType === 'message_callback' ||
      INLINE_EXECUTION_OWNER_REFRESH_UPDATE_TYPES.has(normalizedType) ||
      this.isPotentialGroupAdminModerationCommand(update)
    );
  }

  private async scheduleChatAdminRosterSyncFromWebhook(
    update: MaxUpdate,
    chatId: string,
  ): Promise<void> {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    const normalizedType = update.type.trim().toLowerCase();
    if (
      normalizedType !== 'bot_added' &&
      normalizedType !== 'bot_removed' &&
      normalizedType !== 'chat_title_changed' &&
      !CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES.has(normalizedType)
    ) {
      return;
    }

    const source =
      normalizedType === 'bot_added'
        ? 'webhook_bot_added'
        : normalizedType === 'bot_removed'
          ? 'webhook_bot_removed'
          : normalizedType === 'chat_title_changed'
            ? 'webhook_chat_title_changed'
            : CHAT_ADMIN_ROSTER_MEMBERSHIP_CHURN_UPDATE_TYPES.has(normalizedType)
              ? 'webhook_membership_churn'
              : null;
    const entityType = update.message?.entityType ?? null;
    if (this.isUnsupportedManagedRosterSyncChat(chatId, entityType)) {
      return;
    }

    await this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId,
        botIds: update.botId ? [update.botId] : [],
        title: update.message?.chatTitle ?? null,
        entityType,
        source,
        retryUntilMs:
          normalizedType === 'bot_added'
            ? Date.now() + WebhookService.BOT_ADDED_ADMIN_ROSTER_RETRY_WINDOW_MS
            : null,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId,
            updateId: update.updateId,
            type: normalizedType,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to enqueue chat admin roster sync from webhook',
        );
        throw new WebhookPreparationDeferredError(
          'Chat admin roster handoff pending',
          1_000,
          error,
        );
      });
  }

  private isUnsupportedManagedRosterSyncChat(
    chatId: string,
    entityType: 'chat' | 'channel' | null | undefined,
  ): boolean {
    return entityType !== 'channel' && isPrivateDirectChatId(chatId);
  }

  private attachExecutionOwnerBotId(update: MaxUpdate, botId: string | null): void {
    if (!botId) {
      return;
    }

    update.executionOwnerBotId = botId;
  }

  private readWebhookChatEntityType(update: MaxUpdate): ChatEntityType | null {
    const entityType = update.message?.entityType;
    if (entityType === 'channel') {
      return ChatEntityType.CHANNEL;
    }
    if (entityType === 'chat') {
      return ChatEntityType.CHAT;
    }
    return null;
  }

  private async handleLegacyDedupKeyDuplicate(
    update: MaxUpdate,
    repairProjection = true,
  ): Promise<WebhookIngestResult | null> {
    const updateId = String(update.updateId ?? '').trim();
    const botId = typeof update.botId === 'string' ? update.botId.trim() : '';
    if (!updateId || !botId) {
      return null;
    }

    const findUnique = (
      this.prisma.webhookEvent as unknown as {
        findUnique?: (args: unknown) => Promise<{
          id: string;
          createdAt: Date;
          botId?: string | null;
        } | null>;
      }
    ).findUnique;
    if (typeof findUnique !== 'function') {
      return null;
    }

    const legacyEvent = await findUnique.call(this.prisma.webhookEvent, {
      where: {
        dedupKey: updateId,
      },
      select: {
        id: true,
        createdAt: true,
        botId: true,
      },
    });
    if (
      !legacyEvent ||
      legacyEvent.createdAt.getTime() < Date.now() - WEBHOOK_LEGACY_DEDUP_COMPAT_WINDOW_MS ||
      legacyEvent.botId !== botId
    ) {
      return null;
    }

    this.logger.debug(
      {
        updateId,
        botId,
        dedupKey: this.buildWebhookDedupKey(update),
        legacyDedupKey: updateId,
      },
      'Accepted webhook event as duplicate via legacy unscoped dedup key',
    );
    return repairProjection
      ? this.acceptDuplicateWebhookEvent(update)
      : { accepted: true, duplicate: true };
  }

  private async acceptDuplicateWebhookEvent(update: MaxUpdate): Promise<WebhookIngestResult> {
    try {
      await this.repairDuplicateReceiptReadModels(update);
    } catch (repairError: unknown) {
      this.logger.warn(
        {
          updateId: update.updateId,
          type: update.type,
          err: repairError instanceof Error ? repairError.message : String(repairError),
        },
        'Failed to repair membership activity projection for duplicate webhook event',
      );
      throw repairError;
    }

    return { accepted: true, duplicate: true };
  }

  private buildWebhookDedupKey(update: Pick<MaxUpdate, 'updateId' | 'botId'>): string {
    const updateId = String(update.updateId ?? '').trim();
    const botId = typeof update.botId === 'string' ? update.botId.trim() : '';
    return botId ? `${botId}:${updateId}` : updateId;
  }

  private shouldRetryWithSanitizedPayload(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    if (code === 'P2002') {
      return false;
    }

    const message = this.extractErrorMessage(error);
    return (
      code === 'InvalidArg' ||
      code === 'P2007' ||
      message.includes('hex escape') ||
      message.includes('invalid input syntax for type json') ||
      message.includes('invalid input value') ||
      message.includes('unicode') ||
      message.includes('surrogate') ||
      message.includes('invalid byte sequence') ||
      message.includes('null byte')
    );
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim().toLowerCase();
    }

    const directMessage = (error as { message?: unknown }).message;
    if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
      return directMessage.trim().toLowerCase();
    }

    return String(error).trim().toLowerCase();
  }

  private readMembershipDenialCacheMaxInFlight(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 2
      ? Math.min(1_024, parsed)
      : DEFAULT_MEMBERSHIP_DENIAL_CACHE_MAX_IN_FLIGHT;
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === code;
    }

    return (error as { code?: string } | null)?.code === code;
  }

  private sanitizeForJsonStorage(
    value: unknown,
    seen = new WeakSet<object>(),
  ): Prisma.InputJsonValue {
    const sanitized = this.sanitizeJsonFragment(value, seen);
    return sanitized ?? ({} as Prisma.InputJsonObject);
  }

  private sanitizeJsonFragment(
    value: unknown,
    seen = new WeakSet<object>(),
  ): Prisma.InputJsonValue | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return this.normalizeStorageString(value);
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (Buffer.isBuffer(value)) {
      return value.toString('base64');
    }

    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeJsonFragment(item, seen));
    }

    if (typeof value === 'object') {
      if (seen.has(value)) {
        return null;
      }
      seen.add(value);

      const sanitized: Record<string, Prisma.InputJsonValue | null> = {};
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (
          nestedValue === undefined ||
          typeof nestedValue === 'function' ||
          typeof nestedValue === 'symbol'
        ) {
          continue;
        }
        sanitized[key] = this.sanitizeJsonFragment(nestedValue, seen);
      }

      seen.delete(value);
      return sanitized as Prisma.InputJsonObject;
    }

    return this.normalizeStorageString(String(value));
  }

  private normalizeStorageString(value: string): string {
    let normalized = '';

    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);

      if (codeUnit === 0) {
        continue;
      }

      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          normalized += value[index] + value[index + 1];
          index += 1;
        } else {
          normalized += '\ufffd';
        }
        continue;
      }

      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        normalized += '\ufffd';
        continue;
      }

      normalized += value[index];
    }

    return normalized;
  }
}
