import { matchesNightModeTransitionFenceAlias } from './night-mode-transition-fence-alias.util';
import {
  matchesNightModeRecoveryBoundaryTime,
  resolveNightModeLegacyRecoveryTime,
} from './night-mode-recovery-time-compat.util';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  buildMaxActionNoExecutableRouteMessage,
  buildMaxActionRouteQuarantinedMessage,
} from '../max/max-action-dispatch-error';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import {
  getNightModeTransitionAccessRecoveryMarker,
  prepareDefinitivelyRejectedNightModeOpenRetry,
  prepareDefinitivelyRejectedNightModeTransitionRetry,
} from '../max/max-action-ledger.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
  MAX_SEND_ROUTE_QUARANTINE_MS,
} from '../max/max-send-route-health';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  MaxActionLedgerStatus,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { moderationBackgroundTasksEnabled } from '../runtime/moderation-runtime';
import {
  hasNightModeTransitionMembershipCandidate,
  NIGHT_MODE_TRANSITION_REFRESHABLE_ACCESS_STATES,
} from './night-mode-transition-eligibility.util';
import {
  buildNightModeRouteVerificationJobId,
  buildNightModeTransitionJobId,
  buildNightModeTransitionRecoveryJobId,
  NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME,
  NIGHT_MODE_ROUTE_VERIFICATION_KIND,
  NIGHT_MODE_STICKY_ROUTE_PROBE_KIND,
  NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
  NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
  NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
  NIGHT_MODE_RECOVERY_UNSAFE_PREFIX,
  NIGHT_MODE_TRANSITION_JOB_NAME,
  NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX,
  NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX,
  NIGHT_MODE_TRANSITION_QUEUE,
  parseNightModeRouteVerification,
  parseNightModeStickyRouteProbe,
  parseNightModeTransitionRecoveryOnly,
  parseNightModeTransitionRecoveryObligation,
  type NightModeRouteVerification,
  type NightModeRouteVerificationProof,
  type NightModeStickyRouteProbe,
  type NightModeTransitionJob,
  type NightModeTransitionRecoveryOnly,
  type NightModeTransitionRecoveryObligation,
  type NightModeTransitionOpenEventRecovery,
} from './night-mode-transition.queue';
import {
  parseNightModeTransitionSessionKey,
  resolveCurrentNightModeCloseOccurrence,
  resolveCurrentNightModeOpenOccurrence,
  resolveNightModeTransitionSessionCloseAt,
  resolveNightModeTransitionSessionOpenAt,
  resolveNextNightModeTransitionOccurrences,
  type NightModeTransitionOccurrence,
  type NightModeTransitionScheduleSettings,
} from './night-mode-transition-time.util';
import { buildNightModeTransitionScheduleFingerprint } from './night-mode-transition-generation.util';
import {
  buildNightModeTransitionStateKey,
  DEFAULT_NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS,
  parseNightModeTransitionState,
} from './moderation.service.support';
import { RedisCounterService } from './redis-counter.service';

const NIGHT_MODE_TRANSITION_JOB_ATTEMPTS = 3;
const NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS = 15_000;
const NIGHT_MODE_ROUTE_VERIFICATION_FIRST_DELAY_MS = 15_000;
const NIGHT_MODE_TRANSITION_RUNTIME_VERSION = 4 as const;
const NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE = 200;
const NIGHT_MODE_TRANSITION_BOOTSTRAP_RETRY_MS = 30_000;
const NIGHT_MODE_TRANSITION_RECONCILE_MAX_PASSES = 3;
const NIGHT_MODE_QUEUE_MUTATION_LOCK_TTL_MS = 120_000;
const NIGHT_MODE_QUEUE_MUTATION_LOCK_HEARTBEAT_MS = 30_000;
const NIGHT_MODE_QUEUE_MUTATION_LOCK_WAIT_MS = 4_000;
const NIGHT_MODE_TRANSITION_SOURCE_TAG = 'night_mode_transition';
const NIGHT_MODE_RECOVERY_LEDGER_PAGE_SIZE = 20;

type NightModeTransitionReconcileSnapshot = {
  signature: string;
  cleanupRequired: boolean;
  scheduleConfigured: boolean;
  settings: (NightModeTransitionScheduleSettings & { chatId: string }) | null;
};

export type NightModeTransitionManualBlockCategory =
  | 'unsafe_prior_dispatch'
  | 'unsafe_prior_provenance'
  | 'no_fresh_access'
  | 'failed_job_unclassified';

export type NightModeTransitionManualReview = {
  category: NightModeTransitionManualBlockCategory;
  reason: string;
  jobId: string;
  ledgerJobId: string | null;
  sessionKey: string;
  fingerprint: string;
};

export type NightModeTransitionReconcileFence = {
  generation: bigint;
  leaseToken: string;
};

type NightModeCurrentCatchUpResolution =
  | { kind: 'enqueue' }
  | { kind: 'skip' }
  | { kind: 'blocked'; manualReview: NightModeTransitionManualReview };

type NightModeCloseRecoveryResolution =
  | { kind: 'none' }
  | { kind: 'needed'; recovery: NightModeTransitionRecoveryOnly }
  | { kind: 'already_complete'; recovery: NightModeTransitionRecoveryOnly }
  | { kind: 'blocked'; manualReview: NightModeTransitionManualReview };

export type NightModeRecoveryOnlyPreflight = 'needed' | 'already_complete' | 'unsafe';

export type NightModeTransitionExecutionDisposition = 'execute' | 'defer' | 'retire' | 'unsafe';

type NightModeRecoveryScheduleResult = {
  jobId: string | null;
  manualReview: NightModeTransitionManualReview | null;
  blocksCurrentCatchUp: boolean;
};

type NightModeManualReviewDisposition =
  | { kind: 'none' }
  | { kind: 'acknowledged'; category: NightModeTransitionManualBlockCategory }
  | { kind: 'blocked'; manualReview: NightModeTransitionManualReview };

type NightModeAccessScheduleExpectation = {
  futureJobIds: string[];
  manualReview: NightModeTransitionManualReview | null;
  recoveryJobId: string | null;
  currentCatchUp: {
    jobId: string;
    sessionKey: string;
    transition: NightModeTransitionOccurrence['transition'];
  } | null;
};

type NightModeEnqueueOccurrencesResult = {
  manualReview: NightModeTransitionManualReview | null;
  skippedCurrentJobIds?: ReadonlySet<string>;
};

type NightModeScheduledJobRegistryRow = {
  chat_id: string;
  job_id: string;
  transition: NightModeTransitionOccurrence['transition'];
  session_key: string;
  scheduled_for: Date;
  schedule_fingerprint: string;
  runtime_version?: number;
  created_at?: Date;
  recovery_payload?: unknown;
};

type NightModeCloseLedgerRow = {
  id?: string;
  jobId?: string;
  updatedAt?: Date;
  actionType: string;
  chatId: string;
  sourceTag: string | null;
  status: MaxActionLedgerStatus;
  ambiguous: boolean;
  terminal: boolean;
  completedAt: Date | null;
  dispatchToken?: string | null;
  dispatchStartedAt?: Date | null;
  dispatchBotId: string | null;
  remoteMessageId: string | null;
};

type NightModeCompletedCloseLedgerRecoveryRow = {
  id: string;
  jobId: string;
  completedAt: Date;
  dispatchBotId: string;
  remoteMessageId: string;
};

type NightModeQueueMutationLockApi = Pick<
  RedisCounterService,
  'acquireLock' | 'releaseLock' | 'renewLock'
>;

class NightModeTransitionJobsActiveError extends Error {
  constructor(jobIds: readonly string[]) {
    super(
      `Night mode transition jobs are active during schedule replacement (${jobIds.join(',')})`,
    );
    this.name = 'NightModeTransitionJobsActiveError';
  }
}

class NightModeTransitionFailedJobSnapshotUnstableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NightModeTransitionFailedJobSnapshotUnstableError';
  }
}

export type NightModeTransitionReconcileResult = {
  queueAvailable: boolean;
  scheduleEnabled: boolean | null;
  passes: number;
  manualReview?: {
    category: NightModeTransitionManualBlockCategory;
    reason: string;
    jobId: string;
    ledgerJobId: string | null;
    sessionKey: string;
    fingerprint: string;
  };
};

@Injectable()
export class NightModeTransitionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NightModeTransitionSchedulerService.name);
  private readonly runtimeStartedAtMs = Date.now();
  private readonly startupDelayMs: number;
  private readonly backgroundTasksEnabled: boolean;
  private startupTimer: NodeJS.Timeout | null = null;
  private bootstrapInFlight = false;
  private bootstrapRetryRequested = false;
  private shuttingDown = false;
  private readonly localQueueMutationChains = new Map<string, Promise<void>>();
  private readonly fallbackScheduledJobRegistry = new Map<
    string,
    NightModeScheduledJobRegistryRow
  >();

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @InjectQueue(NIGHT_MODE_TRANSITION_QUEUE)
    private readonly queue?: Queue<NightModeTransitionJob>,
    @Optional() configService?: ConfigService,
    @Optional() private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly redisCounter?: RedisCounterService,
  ) {
    this.startupDelayMs = this.readNonNegativeConfigInt(
      configService?.get<number>('NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS'),
      DEFAULT_NIGHT_MODE_TRANSITION_STARTUP_DELAY_MS,
    );
    this.backgroundTasksEnabled = moderationBackgroundTasksEnabled(
      configService?.get<boolean | string>('MODERATION_BACKGROUND_TASKS_ENABLED'),
    );
  }

  onModuleInit(): void {
    if (!roleRunsModeration(getAppRole()) || !this.backgroundTasksEnabled) {
      return;
    }

    this.scheduleBootstrap(this.startupDelayMs);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  isRouteVerificationSchedulingAvailable(): boolean {
    return Boolean(this.queue);
  }

  async scheduleRouteVerification(proof: NightModeRouteVerificationProof): Promise<void> {
    if (!this.queue) {
      throw new Error('Night mode route verification queue is unavailable');
    }
    const chatId = proof.chatId.trim();
    const sessionKey = proof.sessionKey.trim();
    const messageId = proof.messageId.trim();
    const botId = proof.botId.trim();
    if (
      !chatId ||
      !sessionKey ||
      !messageId ||
      !botId ||
      !Number.isFinite(proof.sentAt.getTime())
    ) {
      throw new Error('Exact night mode route verification proof is required');
    }

    const halfOpenMembership = await this.prisma.chatBotMembership.findFirst({
      where: {
        chatId,
        botId,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: { gte: 1 },
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        sendRouteLastFailureAt: { lt: proof.sentAt },
        sendRouteQuarantinedUntil: {
          gte: proof.sentAt,
          lte: new Date(proof.sentAt.getTime() + MAX_SEND_ROUTE_QUARANTINE_MS),
        },
      },
      select: { botId: true },
    });
    if (!halfOpenMembership) {
      return;
    }

    const sentAt = proof.sentAt.toISOString();
    const verification: NightModeRouteVerification = {
      kind: NIGHT_MODE_ROUTE_VERIFICATION_KIND,
      version: 1,
      sessionKey,
      messageId,
      botId,
      sentAt,
      attemptCount: 0,
      presentCount: 0,
      absentCount: 0,
    };
    const jobId = buildNightModeRouteVerificationJobId(chatId, verification);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const existingVerification = parseNightModeRouteVerification(
        existing.data?.routeVerification,
      );
      if (
        existing.name !== NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME ||
        existing.data?.chatId !== chatId ||
        existing.data?.transition !== 'close' ||
        existing.data?.scheduledFor !== sentAt ||
        existing.data?.sessionKey !== sessionKey ||
        !existingVerification ||
        existingVerification.sessionKey !== sessionKey ||
        existingVerification.messageId !== messageId ||
        existingVerification.botId !== botId ||
        existingVerification.sentAt !== sentAt
      ) {
        throw new Error(`Night mode route verification job identity is unsafe (${chatId})`);
      }
      if (typeof existing.getState !== 'function') {
        throw new Error(`Night mode route verification job state is unavailable (${chatId})`);
      }
      const state = await existing.getState();
      if (
        state === 'active' ||
        state === 'delayed' ||
        state === 'waiting' ||
        state === 'waiting-children' ||
        state === 'prioritized'
      ) {
        return;
      }
      if ((state !== 'failed' && state !== 'completed') || typeof existing.remove !== 'function') {
        throw new Error(`Night mode route verification job state is unsafe (${chatId})`);
      }
      await existing.remove();
    }
    await this.queue.add(
      NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME,
      {
        chatId,
        transition: 'close',
        scheduledFor: sentAt,
        sessionKey,
        routeVerification: verification,
        createdAt: new Date().toISOString(),
      },
      {
        jobId,
        delay: NIGHT_MODE_ROUTE_VERIFICATION_FIRST_DELAY_MS,
        attempts: NIGHT_MODE_TRANSITION_JOB_ATTEMPTS,
        backoff: { type: 'fixed', delay: NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: 1_000,
      },
    );
  }

  async bootstrapEnabledChats(): Promise<void> {
    if (
      this.bootstrapInFlight ||
      !this.queue ||
      typeof this.prisma.chatSettings?.findMany !== 'function'
    ) {
      return;
    }

    this.bootstrapInFlight = true;
    try {
      let cursor: { chatId: string } | undefined;
      for (;;) {
        const settingsRows = await this.prisma.chatSettings.findMany({
          where: {
            nightModeEnabled: true,
            chat: this.buildActiveBotMembershipFilter(),
          },
          select: {
            chatId: true,
            nightModeEnabled: true,
            nightModeStartTimeMinutes: true,
            nightModeEndTimeMinutes: true,
            nightModeTimezone: true,
          },
          orderBy: {
            chatId: 'asc',
          },
          take: NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE,
          ...(cursor
            ? {
                skip: 1,
                cursor,
              }
            : {}),
        });

        const eligibleSettingsRows = await this.filterEligibleSettingsRows(settingsRows);
        // Startup may inspect the current boundary, but canEnqueueCurrentCatchUp authorizes it only
        // when v4 durable proof shows that this process generation accepted it while still future.
        await this.enqueueChatSettingsRows(eligibleSettingsRows, {
          includeCurrentClose: true,
          includeCurrentOpen: true,
        });

        if (settingsRows.length < NIGHT_MODE_TRANSITION_BOOTSTRAP_BATCH_SIZE) {
          break;
        }
        cursor = { chatId: settingsRows[settingsRows.length - 1]!.chatId };
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to bootstrap night mode transition jobs',
      );
      this.requestBootstrapRetry();
    } finally {
      this.bootstrapInFlight = false;
      if (this.bootstrapRetryRequested) {
        this.bootstrapRetryRequested = false;
        this.scheduleBootstrap(NIGHT_MODE_TRANSITION_BOOTSTRAP_RETRY_MS);
      }
    }
  }

  async reconcileChat(chatId: string): Promise<NightModeTransitionReconcileResult> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return {
        queueAvailable: Boolean(this.queue),
        scheduleEnabled: false,
        passes: 0,
      };
    }
    if (!this.queue) {
      return {
        queueAvailable: false,
        scheduleEnabled: null,
        passes: 0,
      };
    }

    const normalizedChatId = normalizedChatIds[0]!;
    return this.runChatQueueMutationSerialized(normalizedChatId, () =>
      this.replaceChatScheduleFromCurrentSnapshot(normalizedChatId, {
        includeCurrentClose: true,
        includeCurrentOpen: true,
      }),
    );
  }

  async repairAccessSchedule(
    chatId: string,
    reconcileFence?: NightModeTransitionReconcileFence,
  ): Promise<NightModeTransitionReconcileResult> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return {
        queueAvailable: Boolean(this.queue),
        scheduleEnabled: false,
        passes: 0,
      };
    }
    if (!this.queue) {
      return {
        queueAvailable: false,
        scheduleEnabled: null,
        passes: 0,
      };
    }

    const normalizedChatId = normalizedChatIds[0]!;
    return this.runChatQueueMutationSerialized(normalizedChatId, async () => {
      const obligationReview = await this.restoreRecoveryObligations(normalizedChatId);
      let snapshot = await this.readReconcileSnapshot(normalizedChatId);
      // FLAG: Settings and membership writes durably request this repair in PostgreSQL. Eligible
      // schedules only fill missing deterministic jobs so routine refreshes do not churn the queue.
      for (let pass = 1; pass <= NIGHT_MODE_TRANSITION_RECONCILE_MAX_PASSES; pass += 1) {
        const recovery = await this.ensureCloseEventRecoveryJob(normalizedChatId, reconcileFence, {
          scanHistoricalLedger: true,
        });
        const expectation = snapshot.settings
          ? await this.ensureAccessScheduleOccurrences(snapshot.settings, reconcileFence, recovery)
          : null;
        if (!snapshot.settings) {
          await this.clearChatJobsForChatIds(normalizedChatIds, {
            strict: true,
            keepJobIds: recovery.jobId ? new Set([recovery.jobId]) : undefined,
            reconcileFence,
          });
        }

        const verified = await this.readReconcileSnapshot(normalizedChatId);
        if (verified.signature === snapshot.signature) {
          if (verified.settings && expectation) {
            await this.verifyAccessScheduleExpectation(verified.settings, expectation);
          }
          return {
            queueAvailable: true,
            scheduleEnabled: verified.settings !== null,
            passes: pass,
            ...(obligationReview || recovery.manualReview || expectation?.manualReview
              ? {
                  manualReview:
                    obligationReview ?? recovery.manualReview ?? expectation!.manualReview!,
                }
              : {}),
          };
        }
        // FLAG: Any effective state change invalidates jobs observed or created in this pass.
        // Clear them before rebuilding from the newly committed snapshot.
        await this.clearChatJobsForChatIds(normalizedChatIds, {
          strict: true,
          reconcileFence,
        });
        snapshot = verified;
      }

      throw new Error(
        `Night mode transition access state did not stabilize during durable repair (${normalizedChatId})`,
      );
    });
  }

  async shouldProcessChatTransitions(chatId: string): Promise<boolean> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return false;
    }

    return this.hasActionableTransitionCandidate(normalizedChatIds[0]!);
  }

  async inspectTransitionExecution(
    job: NightModeTransitionJob,
    bullJobId?: string | null,
  ): Promise<NightModeTransitionExecutionDisposition> {
    const normalizedChatIds = this.normalizeChatIds([job.chatId]);
    if (normalizedChatIds.length === 0 || typeof this.prisma.chat?.findUnique !== 'function') {
      return 'unsafe';
    }

    const chatId = normalizedChatIds[0]!;
    if (job.transition !== 'close' && job.transition !== 'open') {
      return 'unsafe';
    }
    const scheduledFor = new Date(job.scheduledFor);
    if (!Number.isFinite(scheduledFor.getTime())) {
      return 'unsafe';
    }
    const expectedJobId = buildNightModeTransitionJobId(
      chatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    const actualJobId = bullJobId?.trim() ?? '';
    if (actualJobId !== expectedJobId) {
      return 'unsafe';
    }
    let registry: NightModeScheduledJobRegistryRow | null = null;
    if (job.transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION) {
      const scheduleFingerprint = job.scheduleFingerprint?.trim() ?? '';
      if (!scheduleFingerprint) {
        return 'unsafe';
      }
      registry = await this.findScheduledJobRegistryRow(chatId, actualJobId);
      if (
        !registry ||
        registry.transition !== job.transition ||
        registry.session_key !== job.sessionKey ||
        registry.scheduled_for.getTime() !== scheduledFor.getTime() ||
        registry.schedule_fingerprint !== scheduleFingerprint ||
        registry.runtime_version !== NIGHT_MODE_TRANSITION_RUNTIME_VERSION
      ) {
        return 'unsafe';
      }
    }
    if (!parseNightModeTransitionSessionKey(job.sessionKey)) return 'unsafe';
    const canonical =
      job.transition === 'close'
        ? resolveNightModeTransitionSessionCloseAt(job.sessionKey)
        : resolveNightModeTransitionSessionOpenAt(job.sessionKey);
    if (canonical?.toISOString() !== job.scheduledFor) return 'retire';
    const stickyRouteProbe = parseNightModeStickyRouteProbe(job.stickyRouteProbe);
    if (
      job.stickyRouteProbe !== undefined &&
      (!stickyRouteProbe ||
        job.transitionRuntimeVersion !== NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
        !registry?.created_at ||
        !Number.isFinite(registry.created_at.getTime()) ||
        registry.created_at.getTime() >= scheduledFor.getTime() ||
        registry.created_at.getTime() > Date.parse(stickyRouteProbe.authorizedAt) ||
        job.transition !== 'close' ||
        job.recoveryOnly !== undefined ||
        stickyRouteProbe.scheduledFor !== job.scheduledFor ||
        stickyRouteProbe.sessionKey !== job.sessionKey ||
        stickyRouteProbe.scheduleFingerprint !== job.scheduleFingerprint)
    ) {
      return 'unsafe';
    }

    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        settings: {
          select: {
            nightModeEnabled: true,
            nightModeStartTimeMinutes: true,
            nightModeEndTimeMinutes: true,
            nightModeTimezone: true,
          },
        },
        botMemberships: {
          select: {
            botId: true,
            status: true,
            botAccessState: true,
            botAccessSource: true,
            permissionsSnapshot: true,
          },
        },
      },
    });
    const settings = chat?.settings;
    if (
      chat?.entityType !== ChatEntityType.CHAT ||
      !settings?.nightModeEnabled ||
      this.resolveJobScheduleFingerprint(job) !==
        buildNightModeTransitionScheduleFingerprint(settings)
    ) {
      return 'retire';
    }

    const now = new Date();
    const currentOccurrence =
      job.transition === 'close'
        ? resolveCurrentNightModeCloseOccurrence(settings, now)
        : resolveCurrentNightModeOpenOccurrence(settings, now);
    if (
      !currentOccurrence ||
      currentOccurrence.transition !== job.transition ||
      currentOccurrence.sessionKey !== job.sessionKey ||
      currentOccurrence.dueAt.toISOString() !== job.scheduledFor
    ) {
      return 'retire';
    }

    // FLAG: The exact v4 job and registry row remain the durable occurrence proof while access is
    // unavailable. Access reconciliation removes obsolete jobs, and the current-session check above
    // bounds retries even when terminal membership evidence has not been reconciled yet.
    return this.snapshotHasActionableTransitionCandidate(chat.botMemberships) ? 'execute' : 'defer';
  }

  async inspectRecoveryOnlyTransition(
    job: NightModeTransitionJob,
  ): Promise<NightModeRecoveryOnlyPreflight> {
    if (job.stickyRouteProbe !== undefined) {
      return 'unsafe';
    }
    const recovery = parseNightModeTransitionRecoveryObligation(job.recoveryOnly);
    if (!recovery || job.chatId.trim().length === 0) {
      return 'unsafe';
    }
    if (recovery.kind !== NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY) {
      const jobId = buildNightModeTransitionRecoveryJobId(job.chatId, recovery);
      const registry = await this.findScheduledJobRegistryRow(job.chatId, jobId);
      const stored = parseNightModeTransitionRecoveryObligation(registry?.recovery_payload);
      if (
        !registry ||
        !stored ||
        JSON.stringify(stored) !== JSON.stringify(recovery) ||
        !this.registryRowMatchesTransitionJob(registry, job, jobId)
      )
        return 'unsafe';
      if (recovery.kind === NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY) {
        const ledger = await this.readCloseLedger(job.chatId, recovery.sessionKey);
        if (!ledger) return 'needed'; // Runtime may recover an exact persisted CLOSE event.
        if (
          this.hasNoAcceptedCloseDispatch(ledger, job.chatId) &&
          ledger.terminal &&
          ledger.status === MaxActionLedgerStatus.FAILED_TERMINAL
        )
          return 'already_complete';
        return this.isExactCompletedCloseLedger(ledger, job.chatId) &&
          ledger.remoteMessageId?.trim() &&
          ledger.dispatchBotId?.trim()
          ? 'needed'
          : 'unsafe';
      }
    }
    return this.inspectRecoveryEnvelope(job.chatId.trim(), recovery);
  }

  async scheduleRecoveryObligation(
    chatId: string,
    input: NightModeTransitionRecoveryObligation,
  ): Promise<void> {
    const recovery = parseNightModeTransitionRecoveryObligation(input);
    const normalizedChatId = chatId.trim();
    if (!recovery || !normalizedChatId) throw new Error('Invalid night mode recovery obligation');
    if (typeof this.prisma.$executeRaw !== 'function') {
      throw new Error('Durable night mode recovery storage is unavailable');
    }
    await this.runChatQueueMutationSerialized(normalizedChatId, () =>
      this.persistRecoveryObligation(normalizedChatId, recovery),
    );
  }

  private async persistRecoveryObligation(
    chatId: string,
    recovery: NightModeTransitionRecoveryObligation,
    reconcileFence?: NightModeTransitionReconcileFence,
  ): Promise<void> {
    const existing = await this.findScheduledJobRegistryRow(
      chatId,
      buildNightModeTransitionRecoveryJobId(chatId, recovery),
    );
    const job = this.buildRecoveryObligationJob(chatId, recovery, existing ?? undefined);
    await this.upsertScheduledJobRegistryIntent(
      {
        chat_id: chatId,
        job_id: buildNightModeTransitionRecoveryJobId(chatId, recovery),
        transition: job.transition,
        session_key: job.sessionKey,
        scheduled_for: new Date(job.scheduledFor),
        schedule_fingerprint: job.scheduleFingerprint!,
        runtime_version: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
        recovery_payload: recovery,
      },
      reconcileFence,
    );
    // FLAG: A committed payload is the recovery handoff. Queue unavailability must not
    // make independent OPEN delivery depend on CLOSE cleanup; SQL rematerializes it.
    try {
      await this.enqueueRecoveryObligationJob(job);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          recoveryKind: recovery.kind,
          error: error instanceof Error ? error.message : String(error),
        },
        'Night mode recovery remains durable while queue materialization is unavailable',
      );
    }
  }

  async retireTransition(job: NightModeTransitionJob): Promise<void> {
    await this.retainAcceptedOpenEventRecovery(job);
    await this.requestJobReconcile(job);
  }

  private async retainAcceptedOpenEventRecovery(
    job: NightModeTransitionJob,
    options: {
      queueMutationLocked?: boolean;
      reconcileFence?: NightModeTransitionReconcileFence;
    } = {},
  ): Promise<boolean> {
    // FLAG: Every retirement path, including scheduler cleanup, preserves an accepted OPEN
    // event beyond the send deadline. This receipt-only handoff never authorizes another SEND.
    if (job.transition !== 'open' || job.recoveryOnly) return false;
    const session = parseNightModeTransitionSessionKey(job.sessionKey);
    if (
      !session ||
      !matchesNightModeRecoveryBoundaryTime({
        sessionKey: job.sessionKey,
        transition: 'open',
        scheduledFor: job.scheduledFor,
      })
    )
      return false;
    const ledger = await this.readNoticeLedger(job.chatId, job.sessionKey, 'open');
    if (
      !ledger ||
      !this.isExactCompletedCloseLedger(ledger, job.chatId) ||
      !ledger.remoteMessageId?.trim() ||
      !ledger.dispatchBotId?.trim()
    )
      return false;
    const recovery: NightModeTransitionOpenEventRecovery = {
      kind: NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
      version: 1,
      sessionKey: job.sessionKey,
      messageId: ledger.remoteMessageId.trim(),
      botId: ledger.dispatchBotId.trim(),
      timezone: session.timezone,
      startMinutes: session.startMinutes,
      endMinutes: session.endMinutes,
    };
    const proof = await this.inspectRecoveryEnvelope(job.chatId, recovery, ledger);
    if (proof === 'unsafe') throw new Error('Accepted night mode OPEN event proof is unavailable');
    if (proof === 'needed') {
      if (options.queueMutationLocked) {
        await this.persistRecoveryObligation(job.chatId, recovery, options.reconcileFence);
      } else {
        await this.scheduleRecoveryObligation(job.chatId, recovery);
      }
    }
    return true;
  }

  private buildRecoveryObligationJob(
    chatId: string,
    recovery: NightModeTransitionRecoveryObligation,
    persisted?: Pick<NightModeScheduledJobRegistryRow, 'scheduled_for' | 'runtime_version'>,
  ): NightModeTransitionJob {
    const transition =
      recovery.kind === NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY ? 'close' : 'open';
    // FLAG: Retain the exact persisted recovery time; it is metadata, never SEND authority.
    const dueAt = persisted
      ? persisted.scheduled_for
      : recovery.kind === NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY
        ? new Date(recovery.openScheduledFor)
        : ((transition === 'close'
            ? resolveNightModeTransitionSessionCloseAt(recovery.sessionKey)
            : resolveNightModeTransitionSessionOpenAt(recovery.sessionKey)) ??
          resolveNightModeLegacyRecoveryTime(recovery.sessionKey, transition));
    const fingerprint = this.buildRecoveryScheduleFingerprint(
      recovery.timezone,
      recovery.startMinutes,
      recovery.endMinutes,
    );
    if (
      !dueAt ||
      !matchesNightModeRecoveryBoundaryTime({
        sessionKey: recovery.sessionKey,
        transition,
        scheduledFor: dueAt.toISOString(),
      }) ||
      (recovery.kind === NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY &&
        recovery.scheduleFingerprint !== fingerprint)
    ) {
      throw new Error('Night mode recovery obligation has an inconsistent schedule');
    }
    return {
      chatId,
      transition,
      scheduledFor: dueAt.toISOString(),
      sessionKey: recovery.sessionKey,
      scheduleFingerprint: fingerprint,
      transitionRuntimeVersion: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
      retryPolicyName: 'night-mode-transition',
      recoveryOnly: recovery,
      createdAt: new Date().toISOString(),
    };
  }

  private async enqueueRecoveryObligationJob(job: NightModeTransitionJob): Promise<void> {
    if (!this.queue || !job.recoveryOnly)
      throw new Error('Night mode recovery queue is unavailable');
    const jobId = buildNightModeTransitionRecoveryJobId(job.chatId, job.recoveryOnly);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const stored = parseNightModeTransitionRecoveryObligation(existing.data.recoveryOnly);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(job.recoveryOnly)) {
        throw new Error('Night mode recovery queue identity is inconsistent');
      }
      if (
        (await existing.getState()) === 'failed' &&
        !this.isUnsafeRecoveryFailure(existing.failedReason)
      ) {
        await this.retryFailedTransitionJob(existing, jobId);
      }
      return;
    }
    await this.queue.add(NIGHT_MODE_TRANSITION_JOB_NAME, job, {
      jobId,
      attempts: NIGHT_MODE_TRANSITION_JOB_ATTEMPTS,
      backoff: { type: 'fixed', delay: NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: 1_000,
    });
  }

  private async restoreRecoveryObligations(
    chatId: string,
  ): Promise<NightModeTransitionManualReview | null> {
    let review: NightModeTransitionManualReview | null = null;
    for (const row of await this.listScheduledJobRegistryRows([chatId])) {
      if (row.recovery_payload == null) continue;
      const recovery = parseNightModeTransitionRecoveryObligation(row.recovery_payload);
      if (!recovery || buildNightModeTransitionRecoveryJobId(chatId, recovery) !== row.job_id) {
        review ??= this.recoveryObligationManualReview(
          row,
          'Night mode recovery registry payload is unsafe',
        );
        continue;
      }
      let job: NightModeTransitionJob;
      try {
        job = this.buildRecoveryObligationJob(chatId, recovery, row);
      } catch {
        review ??= this.recoveryObligationManualReview(
          row,
          'Night mode recovery schedule is unsafe',
        );
        continue;
      }
      if (!this.registryRowMatchesTransitionJob(row, job, row.job_id)) {
        review ??= this.recoveryObligationManualReview(
          row,
          'Night mode recovery registry identity is unsafe',
        );
        continue;
      }
      const disposition = await this.findExactManualReviewDisposition({
        chatId,
        jobId: row.job_id,
        sessionKey: row.session_key,
        fingerprint: row.schedule_fingerprint,
      });
      if (disposition.kind === 'acknowledged') continue;
      if (disposition.kind === 'blocked') {
        review ??= disposition.manualReview;
        continue;
      }
      const existing = await this.queue?.getJob(row.job_id);
      if (
        existing &&
        (await existing.getState()) === 'failed' &&
        this.isUnsafeRecoveryFailure(existing.failedReason)
      ) {
        review ??= this.recoveryObligationManualReview(row, existing.failedReason);
        continue;
      }
      await this.enqueueRecoveryObligationJob(job);
    }
    return review;
  }

  private recoveryObligationManualReview(
    row: NightModeScheduledJobRegistryRow,
    reason: string,
  ): NightModeTransitionManualReview {
    return {
      category: 'unsafe_prior_provenance',
      reason,
      jobId: row.job_id,
      ledgerJobId: null,
      sessionKey: row.session_key,
      fingerprint: row.schedule_fingerprint,
    };
  }

  private isUnsafeRecoveryFailure(reason: string | undefined): boolean {
    return (
      reason?.startsWith(NIGHT_MODE_RECOVERY_UNSAFE_PREFIX) === true ||
      reason?.startsWith('Night mode recovery-only proof is no longer valid') === true
    );
  }

  async isTransitionManuallyFenced(
    job: NightModeTransitionJob,
    bullJobId?: string | null,
  ): Promise<boolean> {
    if (job.recoveryOnly) {
      return false;
    }
    const normalizedChatId = job.chatId.trim();
    const fingerprint = this.resolveJobScheduleFingerprint(job);
    if (!normalizedChatId) {
      return false;
    }
    const expectedJobId = buildNightModeTransitionJobId(
      normalizedChatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    const actualJobId = bullJobId?.trim() || expectedJobId;
    if (actualJobId !== expectedJobId) {
      return false;
    }
    if (typeof this.prisma.nightModeTransitionReconcileRequest?.findUnique !== 'function') {
      return false;
    }
    const row = await this.prisma.nightModeTransitionReconcileRequest.findUnique({
      where: { chatId: normalizedChatId },
      select: {
        manualBlockedAt: true,
        manualBlockedCategory: true,
        manualBlockedJobId: true,
        manualBlockedSessionKey: true,
        manualBlockedFingerprint: true,
      },
    });
    return (
      row?.manualBlockedAt instanceof Date &&
      this.isManualBlockCategory(row.manualBlockedCategory) &&
      matchesNightModeTransitionFenceAlias(
        {
          chatId: normalizedChatId,
          transition: job.transition,
          sessionKey: job.sessionKey,
          jobId: actualJobId,
        },
        { sessionKey: row.manualBlockedSessionKey, jobId: row.manualBlockedJobId },
      ) &&
      (fingerprint === null || row.manualBlockedFingerprint === fingerprint)
    );
  }

  private resolveJobScheduleFingerprint(job: NightModeTransitionJob): string | null {
    const persisted = job.scheduleFingerprint?.trim();
    if (persisted) {
      return persisted;
    }
    const parsed = parseNightModeTransitionSessionKey(job.sessionKey);
    return parsed
      ? this.buildRecoveryScheduleFingerprint(
          parsed.timezone,
          parsed.startMinutes,
          parsed.endMinutes,
        )
      : null;
  }

  async requestJobReconcile(job: NightModeTransitionJob): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([job.chatId]);
    if (normalizedChatIds.length === 0) {
      return;
    }
    await this.requestDurableReconcile(normalizedChatIds[0]!);
  }

  async completeScheduledJob(
    job: NightModeTransitionJob,
    completedJobId?: string | null,
  ): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([job.chatId]);
    if (normalizedChatIds.length === 0) {
      return;
    }
    const chatId = normalizedChatIds[0]!;
    const recovery = job.recoveryOnly
      ? parseNightModeTransitionRecoveryObligation(job.recoveryOnly)
      : null;
    const expectedJobId = job.recoveryOnly
      ? recovery
        ? buildNightModeTransitionRecoveryJobId(chatId, recovery)
        : null
      : buildNightModeTransitionJobId(chatId, job.transition, job.scheduledFor, job.sessionKey);
    const jobId = completedJobId?.trim() || expectedJobId;
    if (!expectedJobId || !jobId || jobId !== expectedJobId) {
      await this.requestDurableReconcile(chatId);
      return;
    }

    await this.runChatQueueMutationSerialized(chatId, async () => {
      if (this.queue && typeof this.queue.getJob === 'function') {
        const currentJob = await this.queue.getJob(jobId);
        if (currentJob) {
          const state =
            typeof currentJob.getState === 'function' ? await currentJob.getState() : 'unknown';
          if (state !== 'completed') {
            return;
          }
        }
      }

      const registry = await this.findScheduledJobRegistryRow(chatId, jobId);
      if (!registry) {
        return;
      }
      if (!this.registryRowMatchesTransitionJob(registry, job, jobId)) {
        await this.requestDurableReconcile(chatId);
        return;
      }
      await this.deleteScheduledJobRegistryRow(chatId, jobId);
    });
  }

  async enqueueNextTransitionsForChat(chatId: string): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0 || !this.queue) {
      return;
    }

    const normalizedChatId = normalizedChatIds[0]!;
    await this.runChatQueueMutationSerialized(normalizedChatId, async () => {
      if (typeof this.prisma.chat?.findUnique === 'function') {
        await this.replaceChatScheduleFromCurrentSnapshot(normalizedChatId, {
          deferActiveJobs: true,
        });
        return;
      }

      const settings = await this.findEnabledSettingsForChat(normalizedChatId);
      if (settings) {
        await this.enqueueChatSettingsOccurrences(settings.chatId, settings);
      }
    });
  }

  async reconcileChats(chatIds: readonly string[]): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds(chatIds);
    if (normalizedChatIds.length === 0 || !this.queue) {
      return;
    }

    // FLAG: Each chat owns an independent durable SQL request. A busy or broken chat must not
    // prevent later chats in a bulk settings operation from reconciling immediately.
    for (const chatId of normalizedChatIds) {
      try {
        await this.reconcileChat(chatId);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Deferred night mode transition reconciliation to its durable request',
        );
      }
    }
  }

  async reconcileChatSettings(
    chatId: string,
    settings: NightModeTransitionScheduleSettings,
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return;
    }
    const normalizedChatId = normalizedChatIds[0]!;
    await this.runChatQueueMutationSerialized(normalizedChatId, async () => {
      if (typeof this.prisma.chat?.findUnique === 'function') {
        await this.replaceChatScheduleFromCurrentSnapshot(normalizedChatId, {
          includeCurrentClose: true,
          includeCurrentOpen: true,
          strictCatchUp: false,
        });
        return;
      }

      await this.clearChatJobsForChatIds([normalizedChatId]);
      if (await this.hasActionableTransitionCandidate(normalizedChatId)) {
        await this.enqueueChatSettingsOccurrences(normalizedChatId, settings, {
          includeCurrentClose: true,
          includeCurrentOpen: true,
        });
      }
    });
  }

  async clearChatJobs(chatId: string): Promise<void> {
    const normalizedChatIds = this.normalizeChatIds([chatId]);
    if (normalizedChatIds.length === 0) {
      return;
    }
    const normalizedChatId = normalizedChatIds[0]!;
    await this.runChatQueueMutationSerialized(normalizedChatId, () =>
      this.clearChatJobsForChatIds([normalizedChatId], { strict: true }),
    );
  }

  private async enqueueChatSettingsRows(
    settingsRows: readonly (NightModeTransitionScheduleSettings & { chatId: string })[],
    options: { includeCurrentClose?: boolean; includeCurrentOpen?: boolean } = {},
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    for (const initialSettings of settingsRows) {
      try {
        await this.enqueueBootstrapChatSettings(initialSettings, options);
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: initialSettings.chatId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Deferred failed night mode bootstrap chat to its durable request',
        );
        try {
          await this.requestDurableReconcile(initialSettings.chatId);
        } catch (requestError: unknown) {
          this.logger.error(
            {
              chatId: initialSettings.chatId,
              error: requestError instanceof Error ? requestError.message : String(requestError),
            },
            'Failed to retain a durable night mode bootstrap retry',
          );
          this.requestBootstrapRetry();
        }
      }
    }
  }

  private async enqueueBootstrapChatSettings(
    initialSettings: NightModeTransitionScheduleSettings & { chatId: string },
    options: { includeCurrentClose?: boolean; includeCurrentOpen?: boolean },
  ): Promise<void> {
    await this.runChatQueueMutationSerialized(initialSettings.chatId, async () => {
      if (typeof this.prisma.chat?.findUnique !== 'function') {
        await this.enqueueChatSettingsOccurrences(initialSettings.chatId, initialSettings, options);
        return;
      }

      let snapshot = await this.readReconcileSnapshot(initialSettings.chatId);
      if (!snapshot.settings) {
        await this.clearChatJobsForChatIds([initialSettings.chatId], { strict: true });
        return;
      }
      // FLAG: A stale bootstrap row must not recreate jobs after a concurrent disable/access
      // loss. A changed snapshot clears this pass before retrying under the same per-chat lock.
      for (let pass = 1; pass <= NIGHT_MODE_TRANSITION_RECONCILE_MAX_PASSES; pass += 1) {
        const currentSettings = snapshot.settings;
        if (!currentSettings) {
          return;
        }
        const recovery = await this.ensureCloseEventRecoveryJob(currentSettings.chatId, undefined, {
          scanHistoricalLedger: false,
        });
        const occurrences = this.resolveTransitionOccurrences(currentSettings, options);
        await this.clearChatJobsForChatIds([currentSettings.chatId], {
          strict: true,
          keepJobIds: new Set([
            ...occurrences.map((occurrence) =>
              buildNightModeTransitionJobId(
                currentSettings.chatId,
                occurrence.transition,
                occurrence.dueAt.toISOString(),
                occurrence.sessionKey,
              ),
            ),
            ...(recovery.jobId ? [recovery.jobId] : []),
          ]),
        });
        await this.enqueueChatSettingsOccurrences(currentSettings.chatId, currentSettings, {
          ...options,
          skipCurrentCloseCatchUp: recovery.blocksCurrentCatchUp,
        });
        const verified = await this.readReconcileSnapshot(initialSettings.chatId);
        if (verified.signature === snapshot.signature) {
          return;
        }

        await this.clearChatJobsForChatIds([initialSettings.chatId], { strict: true });
        if (!verified.settings) {
          return;
        }
        snapshot = verified;
      }

      throw new Error(
        `Night mode transition state did not stabilize during bootstrap (${initialSettings.chatId})`,
      );
    });
  }

  private async replaceChatScheduleFromCurrentSnapshot(
    chatId: string,
    options: {
      includeCurrentClose?: boolean;
      includeCurrentOpen?: boolean;
      strictCatchUp?: boolean;
      deferActiveJobs?: boolean;
    } = {},
  ): Promise<NightModeTransitionReconcileResult> {
    let snapshot = await this.readReconcileSnapshot(chatId);
    // FLAG: A writer that commits during queue mutation changes the verified snapshot and forces
    // another exact replacement. A later writer owns its existing post-commit reconciliation.
    for (let pass = 1; pass <= NIGHT_MODE_TRANSITION_RECONCILE_MAX_PASSES; pass += 1) {
      let enqueueResult: NightModeEnqueueOccurrencesResult | null = null;
      const recovery = await this.ensureCloseEventRecoveryJob(chatId, undefined, {
        scanHistoricalLedger: false,
      });
      if (snapshot.settings) {
        const occurrences = this.resolveTransitionOccurrences(snapshot.settings, options);
        await this.clearChatJobsForChatIds([chatId], {
          strict: true,
          throwOnActive: options.deferActiveJobs !== true,
          keepJobIds: new Set([
            ...occurrences.map((occurrence) =>
              buildNightModeTransitionJobId(
                chatId,
                occurrence.transition,
                occurrence.dueAt.toISOString(),
                occurrence.sessionKey,
              ),
            ),
            ...(recovery.jobId ? [recovery.jobId] : []),
          ]),
        });
        enqueueResult = await this.enqueueChatSettingsOccurrences(
          snapshot.settings.chatId,
          snapshot.settings,
          {
            includeCurrentClose: options.includeCurrentClose,
            includeCurrentOpen: options.includeCurrentOpen,
            strict: options.strictCatchUp ?? true,
            skipCurrentCloseCatchUp: recovery.blocksCurrentCatchUp,
          },
        );
      } else {
        await this.clearChatJobsForChatIds([chatId], {
          strict: true,
          throwOnActive: options.deferActiveJobs !== true,
          keepJobIds: recovery.jobId ? new Set([recovery.jobId]) : undefined,
        });
      }

      const verified = await this.readReconcileSnapshot(chatId);
      if (verified.signature === snapshot.signature) {
        return {
          queueAvailable: true,
          scheduleEnabled: verified.settings !== null,
          passes: pass,
          ...(recovery.manualReview || enqueueResult?.manualReview
            ? { manualReview: recovery.manualReview ?? enqueueResult!.manualReview! }
            : {}),
        };
      }
      snapshot = verified;
    }

    throw new Error(
      `Night mode transition access state did not stabilize during reconciliation (${chatId})`,
    );
  }

  private async findEnabledSettingsForChat(
    chatId: string,
  ): Promise<(NightModeTransitionScheduleSettings & { chatId: string }) | null> {
    if (typeof this.prisma.chatSettings?.findFirst === 'function') {
      const settings = await this.prisma.chatSettings.findFirst({
        where: {
          chatId,
          nightModeEnabled: true,
          chat: this.buildActiveBotMembershipFilter(),
        },
        select: {
          chatId: true,
          nightModeEnabled: true,
          nightModeStartTimeMinutes: true,
          nightModeEndTimeMinutes: true,
          nightModeTimezone: true,
        },
      });
      return settings && (await this.hasActionableTransitionCandidate(chatId)) ? settings : null;
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        chatId: true,
        nightModeEnabled: true,
        nightModeStartTimeMinutes: true,
        nightModeEndTimeMinutes: true,
        nightModeTimezone: true,
      },
    });
    if (!settings?.nightModeEnabled || !(await this.hasActionableTransitionCandidate(chatId))) {
      return null;
    }

    return settings;
  }

  private async readReconcileSnapshot(
    chatId: string,
  ): Promise<NightModeTransitionReconcileSnapshot> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        settings: {
          select: {
            chatId: true,
            nightModeEnabled: true,
            nightModeStartTimeMinutes: true,
            nightModeEndTimeMinutes: true,
            nightModeTimezone: true,
          },
        },
        botMemberships: {
          select: {
            botId: true,
            status: true,
            botAccessState: true,
            botAccessSource: true,
            permissionsSnapshot: true,
          },
          orderBy: {
            botId: 'asc',
          },
        },
      },
    });
    if (!chat) {
      return {
        signature: JSON.stringify(['missing']),
        cleanupRequired: true,
        scheduleConfigured: false,
        settings: null,
      };
    }

    const hasActionableTransitionCandidate = this.snapshotHasActionableTransitionCandidate(
      chat.botMemberships,
    );
    const scheduleConfigured =
      chat.entityType === ChatEntityType.CHAT && chat.settings?.nightModeEnabled === true;
    const settings = scheduleConfigured && hasActionableTransitionCandidate ? chat.settings : null;
    const cleanupRequired =
      chat.entityType !== ChatEntityType.CHAT ||
      (scheduleConfigured && !hasActionableTransitionCandidate);
    return {
      // FLAG: Fence only the derived queue state. Evidence refreshes that preserve effective
      // access must not trigger another destructive queue pass.
      signature: JSON.stringify([
        chat.entityType,
        scheduleConfigured,
        cleanupRequired,
        settings
          ? [
              settings.nightModeEnabled,
              settings.nightModeStartTimeMinutes,
              settings.nightModeEndTimeMinutes,
              settings.nightModeTimezone,
            ]
          : null,
        hasActionableTransitionCandidate,
      ]),
      cleanupRequired,
      scheduleConfigured,
      settings,
    };
  }

  private async hasActionableTransitionCandidate(chatId: string): Promise<boolean> {
    if (typeof this.prisma.chat?.findUnique !== 'function') {
      return true;
    }
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        botMemberships: {
          select: {
            botId: true,
            status: true,
            botAccessState: true,
            botAccessSource: true,
            permissionsSnapshot: true,
          },
        },
      },
    });
    if (chat?.entityType !== ChatEntityType.CHAT) {
      return false;
    }
    return this.snapshotHasActionableTransitionCandidate(chat.botMemberships);
  }

  private async filterEligibleSettingsRows<
    T extends NightModeTransitionScheduleSettings & { chatId: string },
  >(settingsRows: readonly T[]): Promise<T[]> {
    if (settingsRows.length === 0 || typeof this.prisma.chat?.findMany !== 'function') {
      return [...settingsRows];
    }

    const chats = await this.prisma.chat.findMany({
      where: {
        id: {
          in: settingsRows.map((settings) => settings.chatId),
        },
      },
      select: {
        id: true,
        entityType: true,
        botMemberships: {
          select: {
            botId: true,
            status: true,
            botAccessState: true,
            botAccessSource: true,
            permissionsSnapshot: true,
          },
        },
      },
    });
    const eligibleChatIds = new Set(
      chats
        .filter(
          (chat) =>
            chat.entityType === ChatEntityType.CHAT &&
            this.snapshotHasActionableTransitionCandidate(chat.botMemberships),
        )
        .map((chat) => chat.id),
    );
    return settingsRows.filter((settings) => eligibleChatIds.has(settings.chatId));
  }

  private snapshotHasActionableTransitionCandidate(
    memberships: Parameters<typeof hasNightModeTransitionMembershipCandidate>[0],
  ): boolean {
    const actionableBotIds = this.getActionableBotIds();
    const actionableBotIdSet = actionableBotIds ? new Set(actionableBotIds) : null;
    return hasNightModeTransitionMembershipCandidate(memberships, {
      ...(actionableBotIdSet
        ? { isActionableBotId: (botId) => actionableBotIdSet.has(botId) }
        : {}),
    });
  }

  private getActionableBotIds(): string[] | null {
    return this.maxBotRegistry?.getActionableBots().map((bot) => bot.id) ?? null;
  }

  private buildActiveBotMembershipFilter() {
    const actionableBotIds = this.getActionableBotIds();
    return {
      entityType: ChatEntityType.CHAT,
      botMemberships: {
        some: {
          status: ChatBotMembershipStatus.ACTIVE,
          botAccessState: {
            in: [...NIGHT_MODE_TRANSITION_REFRESHABLE_ACCESS_STATES],
          },
          ...(actionableBotIds
            ? {
                botId: {
                  in: actionableBotIds,
                },
              }
            : {}),
        },
      },
    };
  }

  private async enqueueChatSettingsOccurrences(
    chatId: string,
    settings: NightModeTransitionScheduleSettings,
    options: {
      includeCurrentClose?: boolean;
      includeCurrentOpen?: boolean;
      includeFuture?: boolean;
      strict?: boolean;
      reconcileFence?: NightModeTransitionReconcileFence;
      skipCurrentCloseCatchUp?: boolean;
    } = {},
  ): Promise<NightModeEnqueueOccurrencesResult> {
    if (!this.queue) {
      return { manualReview: null };
    }

    const occurrences = this.resolveTransitionOccurrences(settings, options);
    if (occurrences.length === 0) {
      return { manualReview: null };
    }

    const nowMs = Date.now();
    const scheduleFingerprint = buildNightModeTransitionScheduleFingerprint(settings);
    let manualReview: NightModeTransitionManualReview | null = null;
    const skippedCurrentJobIds = new Set<string>();
    for (const occurrence of occurrences) {
      const scheduledFor = occurrence.dueAt.toISOString();
      const jobId = buildNightModeTransitionJobId(
        chatId,
        occurrence.transition,
        scheduledFor,
        occurrence.sessionKey,
      );
      const isCurrentCatchUp =
        occurrence.dueAt.getTime() <= nowMs &&
        ((options.includeCurrentOpen === true && occurrence.transition === 'open') ||
          (options.includeCurrentClose === true && occurrence.transition === 'close'));
      if (
        isCurrentCatchUp &&
        occurrence.transition === 'close' &&
        options.skipCurrentCloseCatchUp
      ) {
        continue;
      }
      const catchUpResolution = isCurrentCatchUp
        ? await this.canEnqueueCurrentCatchUp(
            {
              chatId,
              jobId,
              sessionKey: occurrence.sessionKey,
              transition: occurrence.transition,
              scheduledFor,
              fingerprint: scheduleFingerprint,
            },
            { strict: options.strict, reconcileFence: options.reconcileFence },
          )
        : ({ kind: 'enqueue' } satisfies NightModeCurrentCatchUpResolution);
      if (catchUpResolution.kind === 'blocked') {
        manualReview ??= catchUpResolution.manualReview;
        continue;
      }
      if (catchUpResolution.kind === 'skip') {
        skippedCurrentJobIds.add(jobId);
        continue;
      }

      const durableReconcileRetained = await this.upsertScheduledJobRegistryIntent(
        {
          chat_id: chatId,
          job_id: jobId,
          transition: occurrence.transition,
          session_key: occurrence.sessionKey,
          scheduled_for: occurrence.dueAt,
          schedule_fingerprint: scheduleFingerprint,
          runtime_version: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
        },
        options.reconcileFence,
      );
      try {
        const stickyRouteProbe = await this.buildFutureStickyRouteProbe(
          chatId,
          jobId,
          occurrence,
          scheduleFingerprint,
        );
        if (!isCurrentCatchUp) {
          await this.promoteFutureTransitionJob(jobId, scheduleFingerprint, stickyRouteProbe);
        }
        await this.queue.add(
          NIGHT_MODE_TRANSITION_JOB_NAME,
          {
            chatId,
            transition: occurrence.transition,
            scheduledFor,
            sessionKey: occurrence.sessionKey,
            retryPolicyName: 'night-mode-transition',
            transitionRuntimeVersion: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
            scheduleFingerprint,
            ...(stickyRouteProbe ? { stickyRouteProbe } : {}),
            createdAt: new Date().toISOString(),
          },
          {
            jobId,
            delay: Math.max(0, occurrence.dueAt.getTime() - Date.now()),
            attempts: NIGHT_MODE_TRANSITION_JOB_ATTEMPTS,
            backoff: {
              type: 'fixed',
              delay: NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS,
            },
            removeOnComplete: true,
            removeOnFail: 1_000,
          },
        );
      } catch (error: unknown) {
        await this.retainDurableReconcileAfterQueueFailure(
          chatId,
          durableReconcileRetained,
          options.reconcileFence,
        );
        throw error;
      }
    }

    return {
      manualReview,
      ...(skippedCurrentJobIds.size > 0 ? { skippedCurrentJobIds } : {}),
    };
  }

  private async ensureAccessScheduleOccurrences(
    settings: NightModeTransitionScheduleSettings & { chatId: string },
    reconcileFence?: NightModeTransitionReconcileFence,
    recovery: NightModeRecoveryScheduleResult = {
      jobId: null,
      manualReview: null,
      blocksCurrentCatchUp: false,
    },
  ): Promise<NightModeAccessScheduleExpectation> {
    const queue = this.queue;
    if (!queue) {
      return {
        futureJobIds: [],
        currentCatchUp: null,
        manualReview: recovery.manualReview,
        recoveryJobId: recovery.jobId,
      };
    }

    const futureOccurrences = resolveNextNightModeTransitionOccurrences(settings);
    if (futureOccurrences.length === 0) {
      return {
        futureJobIds: [],
        currentCatchUp: null,
        manualReview: recovery.manualReview,
        recoveryJobId: recovery.jobId,
      };
    }

    const futureJobIds = futureOccurrences.map((occurrence) =>
      buildNightModeTransitionJobId(
        settings.chatId,
        occurrence.transition,
        occurrence.dueAt.toISOString(),
        occurrence.sessionKey,
      ),
    );

    const expectedJobs = await Promise.all(futureJobIds.map((jobId) => queue.getJob(jobId)));
    const futureRegistryRows = await this.listScheduledJobRegistryRows([settings.chatId]);
    const futureRegistryByJobId = new Map(futureRegistryRows.map((row) => [row.job_id, row]));
    const futureSchedulePresent = expectedJobs.every(
      (job) =>
        Boolean(job) &&
        (job?.data === undefined ||
          job.data.transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION),
    );
    const futureScheduleComplete = expectedJobs.every((job, index) =>
      this.isCompleteFutureTransitionJob(
        job,
        futureJobIds[index]!,
        buildNightModeTransitionScheduleFingerprint(settings),
        futureRegistryByJobId.get(futureJobIds[index]!),
      ),
    );
    const currentCatchUpRequired =
      recovery.blocksCurrentCatchUp ||
      ((await this.isCurrentCatchUpRequired(settings)) ?? !futureSchedulePresent);
    const currentCandidate =
      resolveCurrentNightModeCloseOccurrence(settings) ??
      resolveCurrentNightModeOpenOccurrence(settings);
    // FLAG: Unsafe CLOSE provenance fences that close effect only. A separately proven
    // current OPEN retains its own ledger, occurrence and durable retry authority.
    const currentOccurrence =
      currentCatchUpRequired &&
      !(recovery.blocksCurrentCatchUp && currentCandidate?.transition === 'close')
        ? currentCandidate
        : null;
    const currentCatchUp = currentOccurrence
      ? {
          jobId: buildNightModeTransitionJobId(
            settings.chatId,
            currentOccurrence.transition,
            currentOccurrence.dueAt.toISOString(),
            currentOccurrence.sessionKey,
          ),
          sessionKey: currentOccurrence.sessionKey,
          transition: currentOccurrence.transition,
        }
      : null;
    await this.clearChatJobsForChatIds([settings.chatId], {
      strict: true,
      keepJobIds: new Set([
        ...futureJobIds,
        ...(currentCatchUp ? [currentCatchUp.jobId] : []),
        ...(recovery.jobId ? [recovery.jobId] : []),
      ]),
      reconcileFence,
    });
    if (futureScheduleComplete && !currentCatchUpRequired) {
      return {
        futureJobIds,
        currentCatchUp,
        manualReview: recovery.manualReview,
        recoveryJobId: recovery.jobId,
      };
    }

    const enqueueResult = await this.enqueueChatSettingsOccurrences(settings.chatId, settings, {
      includeCurrentClose: currentCatchUpRequired,
      includeCurrentOpen: currentCatchUpRequired,
      includeFuture: !futureScheduleComplete,
      strict: true,
      reconcileFence,
      skipCurrentCloseCatchUp: recovery.blocksCurrentCatchUp,
    });
    return {
      futureJobIds,
      currentCatchUp:
        currentCatchUp && enqueueResult.skippedCurrentJobIds?.has(currentCatchUp.jobId)
          ? null
          : currentCatchUp,
      manualReview: recovery.manualReview ?? enqueueResult.manualReview,
      recoveryJobId: recovery.jobId,
    };
  }

  private async verifyAccessScheduleExpectation(
    settings: NightModeTransitionScheduleSettings & { chatId: string },
    expectation: NightModeAccessScheduleExpectation,
  ): Promise<void> {
    const queue = this.queue;
    if (!queue) {
      throw new Error('Night mode transition queue disappeared during durable access repair');
    }

    const futureJobs = await Promise.all(
      expectation.futureJobIds.map((jobId) => queue.getJob(jobId)),
    );
    const futureRegistryRows = await this.listScheduledJobRegistryRows([settings.chatId]);
    const futureRegistryByJobId = new Map(futureRegistryRows.map((row) => [row.job_id, row]));
    for (const [index, jobId] of expectation.futureJobIds.entries()) {
      const job = futureJobs[index];
      if (!job) {
        throw new Error(
          `Night mode transition future job disappeared during durable repair (${jobId})`,
        );
      }
      if (
        !this.isCompleteFutureTransitionJob(
          job,
          jobId,
          buildNightModeTransitionScheduleFingerprint(settings),
          futureRegistryByJobId.get(jobId),
        )
      ) {
        throw new Error(
          `Night mode transition future job proof is incomplete during durable repair (${jobId})`,
        );
      }
      if (typeof job.getState === 'function' && (await job.getState()) === 'failed') {
        throw new Error(
          `Night mode transition future job is failed during durable repair (${jobId})`,
        );
      }
    }

    if (!expectation.currentCatchUp || expectation.manualReview) {
      return;
    }

    const currentJob = await queue.getJob(expectation.currentCatchUp.jobId);
    if (currentJob) {
      if (typeof currentJob.getState === 'function') {
        const currentState = await currentJob.getState();
        if (currentState === 'failed') {
          throw new Error(
            `Night mode transition catch-up failed during durable repair (${expectation.currentCatchUp.jobId})`,
          );
        }
        if (currentState === 'active') {
          throw new Error(
            `Night mode transition catch-up is still active during durable repair (${expectation.currentCatchUp.jobId})`,
          );
        }
      }
      return;
    }

    if ((await this.isCurrentCatchUpRequired(settings)) === false) {
      return;
    }
    throw new Error(
      `Night mode transition catch-up disappeared before state repair (${expectation.currentCatchUp.jobId})`,
    );
  }

  private async isCurrentCatchUpRequired(
    settings: NightModeTransitionScheduleSettings & { chatId: string },
  ): Promise<boolean | null> {
    const currentOccurrence =
      resolveCurrentNightModeCloseOccurrence(settings) ??
      resolveCurrentNightModeOpenOccurrence(settings);
    if (!currentOccurrence) {
      return false;
    }
    const occurrenceIdentity = {
      chatId: settings.chatId,
      jobId: buildNightModeTransitionJobId(
        settings.chatId,
        currentOccurrence.transition,
        currentOccurrence.dueAt.toISOString(),
        currentOccurrence.sessionKey,
      ),
      sessionKey: currentOccurrence.sessionKey,
      fingerprint: buildNightModeTransitionScheduleFingerprint(settings),
    };
    const manualDisposition = await this.findExactManualReviewDisposition(occurrenceIdentity);
    if (manualDisposition.kind === 'blocked') {
      return true;
    }
    if (manualDisposition.kind === 'acknowledged') {
      return true;
    }

    const state = await this.readNightModeTransitionState(settings.chatId);
    if (!this.redisCounter) {
      return null;
    }
    const expectedStatus = currentOccurrence.transition === 'close' ? 'closed' : 'open';
    const closeNoticeRecoveryPending =
      currentOccurrence.transition === 'close' && state?.closeNoticeEventRecovery?.pending === true;
    return (
      closeNoticeRecoveryPending ||
      state?.status !== expectedStatus ||
      state.sessionKey !== currentOccurrence.sessionKey
    );
  }

  private async readNightModeTransitionState(
    chatId: string,
  ): Promise<ReturnType<typeof parseNightModeTransitionState>> {
    if (!this.redisCounter || typeof this.redisCounter.getString !== 'function') {
      return null;
    }
    const rawState = await this.redisCounter.getString(buildNightModeTransitionStateKey(chatId));
    let state: ReturnType<typeof parseNightModeTransitionState> = null;
    if (rawState) {
      try {
        state = parseNightModeTransitionState(JSON.parse(rawState) as unknown);
      } catch {
        state = null;
      }
    }
    return state;
  }

  private async findExactManualReviewDisposition(params: {
    chatId: string;
    jobId: string;
    sessionKey: string;
    fingerprint: string;
    category?: NightModeTransitionManualBlockCategory;
  }): Promise<NightModeManualReviewDisposition> {
    if (typeof this.prisma.nightModeTransitionReconcileRequest?.findUnique !== 'function') {
      return { kind: 'none' };
    }
    const row = await this.prisma.nightModeTransitionReconcileRequest.findUnique({
      where: { chatId: params.chatId },
      select: {
        manualBlockedAt: true,
        manualBlockedReason: true,
        manualBlockedCategory: true,
        manualBlockedJobId: true,
        manualBlockedLedgerJobId: true,
        manualBlockedSessionKey: true,
        manualBlockedFingerprint: true,
        manualAcknowledgedAt: true,
      },
    });
    if (
      !row?.manualBlockedAt ||
      !row.manualBlockedJobId ||
      !row.manualBlockedSessionKey ||
      !this.isManualBlockCategory(row.manualBlockedCategory) ||
      (!(['close', 'open'] as const).some(
        (transition) =>
          params.jobId.includes(`__${transition}__`) &&
          matchesNightModeTransitionFenceAlias(
            { ...params, transition },
            { sessionKey: row.manualBlockedSessionKey, jobId: row.manualBlockedJobId },
          ),
      ) &&
        (row.manualBlockedJobId !== params.jobId ||
          row.manualBlockedSessionKey !== params.sessionKey)) ||
      row.manualBlockedFingerprint !== params.fingerprint ||
      (params.category !== undefined && row.manualBlockedCategory !== params.category)
    ) {
      return { kind: 'none' };
    }
    if (row.manualAcknowledgedAt) {
      return { kind: 'acknowledged', category: row.manualBlockedCategory };
    }
    return {
      kind: 'blocked',
      manualReview: {
        category: row.manualBlockedCategory,
        reason:
          row.manualBlockedReason ?? `Night mode catch-up is manually blocked (${params.jobId})`,
        jobId: row.manualBlockedJobId,
        ledgerJobId: row.manualBlockedLedgerJobId,
        sessionKey: row.manualBlockedSessionKey,
        fingerprint: row.manualBlockedFingerprint,
      },
    };
  }

  private isManualBlockCategory(
    value: string | null,
  ): value is NightModeTransitionManualBlockCategory {
    return (
      value === 'unsafe_prior_dispatch' ||
      value === 'unsafe_prior_provenance' ||
      value === 'no_fresh_access' ||
      value === 'failed_job_unclassified'
    );
  }

  private async ensureCloseEventRecoveryJob(
    chatId: string,
    reconcileFence?: NightModeTransitionReconcileFence,
    options: { scanHistoricalLedger?: boolean } = {},
  ): Promise<NightModeRecoveryScheduleResult> {
    const resolution = await this.resolveChatCloseEventRecovery(chatId, options);
    if (resolution.kind === 'none' || resolution.kind === 'already_complete') {
      return { jobId: null, manualReview: null, blocksCurrentCatchUp: false };
    }
    if (resolution.kind === 'blocked') {
      const disposition = await this.findExactManualReviewDisposition({
        chatId,
        jobId: resolution.manualReview.jobId,
        sessionKey: resolution.manualReview.sessionKey,
        fingerprint: resolution.manualReview.fingerprint,
        category: resolution.manualReview.category,
      });
      if (disposition.kind === 'acknowledged') {
        return { jobId: null, manualReview: null, blocksCurrentCatchUp: false };
      }
      return {
        jobId: null,
        manualReview:
          disposition.kind === 'blocked' ? disposition.manualReview : resolution.manualReview,
        blocksCurrentCatchUp: true,
      };
    }
    if (!this.queue) {
      return { jobId: null, manualReview: null, blocksCurrentCatchUp: true };
    }

    const recovery = resolution.recovery;
    const jobId = buildNightModeTransitionRecoveryJobId(chatId, recovery);
    const fingerprint = this.buildRecoveryScheduleFingerprint(
      recovery.timezone,
      recovery.startMinutes,
      recovery.endMinutes,
    );
    const manualDisposition = await this.findExactManualReviewDisposition({
      chatId,
      jobId,
      sessionKey: recovery.sessionKey,
      fingerprint,
    });
    if (manualDisposition.kind === 'acknowledged') {
      return { jobId: null, manualReview: null, blocksCurrentCatchUp: false };
    }
    if (manualDisposition.kind === 'blocked') {
      return {
        jobId: null,
        manualReview: manualDisposition.manualReview,
        blocksCurrentCatchUp: true,
      };
    }
    const closeAt =
      resolveNightModeTransitionSessionCloseAt(recovery.sessionKey) ??
      resolveNightModeLegacyRecoveryTime(recovery.sessionKey, 'close');
    if (!closeAt) {
      const blocked = this.blockRecovery(
        chatId,
        jobId,
        recovery.sessionKey,
        fingerprint,
        'Night mode recovery envelope has no canonical close time',
      );
      return {
        jobId: null,
        manualReview: blocked.manualReview,
        blocksCurrentCatchUp: true,
      };
    }

    const existing = await this.queue.getJob(jobId);
    if (existing && typeof existing.getState === 'function') {
      const state = await existing.getState();
      const existingRecovery = parseNightModeTransitionRecoveryOnly(existing.data.recoveryOnly);
      if (
        state !== 'failed' &&
        existingRecovery &&
        JSON.stringify(existingRecovery) === JSON.stringify(recovery)
      ) {
        return { jobId, manualReview: null, blocksCurrentCatchUp: true };
      }
      if (state === 'active') {
        throw new NightModeTransitionJobsActiveError([jobId]);
      }
      await existing.remove();
      await this.deleteScheduledJobRegistryRow(chatId, jobId);
    }

    await this.upsertScheduledJobRegistryIntent(
      {
        chat_id: chatId,
        job_id: jobId,
        transition: 'close',
        session_key: recovery.sessionKey,
        scheduled_for: closeAt,
        schedule_fingerprint: fingerprint,
        runtime_version: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
      },
      reconcileFence,
    );
    await this.queue.add(
      NIGHT_MODE_TRANSITION_JOB_NAME,
      {
        chatId,
        transition: 'close',
        scheduledFor: closeAt.toISOString(),
        sessionKey: recovery.sessionKey,
        retryPolicyName: 'night-mode-transition',
        transitionRuntimeVersion: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
        scheduleFingerprint: fingerprint,
        recoveryOnly: recovery,
        createdAt: new Date().toISOString(),
      },
      {
        jobId,
        attempts: NIGHT_MODE_TRANSITION_JOB_ATTEMPTS,
        backoff: { type: 'fixed', delay: NIGHT_MODE_TRANSITION_JOB_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: 1_000,
      },
    );
    return { jobId, manualReview: null, blocksCurrentCatchUp: true };
  }

  private async resolveChatCloseEventRecovery(
    chatId: string,
    options: { scanHistoricalLedger?: boolean } = {},
  ): Promise<NightModeCloseRecoveryResolution> {
    let selectedNeeded: Extract<NightModeCloseRecoveryResolution, { kind: 'needed' }> | null = null;
    let selectedBlocked: Extract<NightModeCloseRecoveryResolution, { kind: 'blocked' }> | null =
      null;
    const seenSessions = new Set<string>();
    const consider = async (resolution: NightModeCloseRecoveryResolution): Promise<void> => {
      if (resolution.kind === 'needed') {
        if (
          !selectedNeeded ||
          this.compareRecoverySessions(
            resolution.recovery.sessionKey,
            selectedNeeded.recovery.sessionKey,
          ) > 0
        ) {
          selectedNeeded = resolution;
        }
        return;
      }
      if (resolution.kind !== 'blocked') {
        return;
      }
      const disposition = await this.findExactManualReviewDisposition({
        chatId,
        jobId: resolution.manualReview.jobId,
        sessionKey: resolution.manualReview.sessionKey,
        fingerprint: resolution.manualReview.fingerprint,
        category: resolution.manualReview.category,
      });
      if (disposition.kind === 'acknowledged') {
        return;
      }
      const candidate =
        disposition.kind === 'blocked'
          ? { kind: 'blocked' as const, manualReview: disposition.manualReview }
          : resolution;
      if (
        !selectedBlocked ||
        this.compareRecoverySessions(
          candidate.manualReview.sessionKey,
          selectedBlocked.manualReview.sessionKey,
        ) > 0
      ) {
        selectedBlocked = candidate;
      }
    };

    const state = await this.readNightModeTransitionState(chatId);
    const marker = state?.closeNoticeEventRecovery;
    if (state && marker?.pending === true) {
      const parsed = parseNightModeTransitionSessionKey(state.sessionKey);
      const messageId = state.closeNoticeMessageId?.trim() ?? '';
      const botId = state.closeNoticeBotId?.trim() ?? '';
      const fingerprint = parsed
        ? this.buildRecoveryScheduleFingerprint(
            parsed.timezone,
            parsed.startMinutes,
            parsed.endMinutes,
          )
        : `sha256:${'0'.repeat(64)}`;
      const fallbackJobId = buildNightModeTransitionJobId(
        chatId,
        'close',
        (
          resolveNightModeTransitionSessionCloseAt(state.sessionKey) ??
          resolveNightModeLegacyRecoveryTime(state.sessionKey, 'close')
        )?.toISOString() ?? state.sessionKey,
        state.sessionKey,
      );
      if (
        state.status !== 'closed' ||
        marker.version !== 2 ||
        !parsed ||
        marker.timezone !== parsed.timezone ||
        marker.startMinutes !== parsed.startMinutes ||
        marker.endMinutes !== parsed.endMinutes ||
        !messageId ||
        !botId
      ) {
        await consider(
          this.blockRecovery(
            chatId,
            fallbackJobId,
            state.sessionKey,
            fingerprint,
            'Night mode close-event recovery marker has no immutable original envelope',
          ),
        );
      } else {
        const resolution = await this.inspectRecoveryCandidate(
          chatId,
          {
            kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
            version: 1,
            sessionKey: state.sessionKey,
            messageId,
            botId,
            timezone: parsed.timezone,
            startMinutes: parsed.startMinutes,
            endMinutes: parsed.endMinutes,
          },
          true,
          fallbackJobId,
          fingerprint,
        );
        await consider(
          resolution.kind === 'already_complete'
            ? { kind: 'needed', recovery: resolution.recovery }
            : resolution,
        );
      }
      seenSessions.add(state.sessionKey);
    }

    if (state && !seenSessions.has(state.sessionKey)) {
      const parsed = parseNightModeTransitionSessionKey(state.sessionKey);
      const closeAt =
        resolveNightModeTransitionSessionCloseAt(state.sessionKey) ??
        resolveNightModeLegacyRecoveryTime(state.sessionKey, 'close');
      if (parsed && closeAt) {
        const stateResolution = await this.inspectMarkerlessRegistryRecovery(chatId, {
          chat_id: chatId,
          job_id: buildNightModeTransitionJobId(
            chatId,
            'close',
            closeAt.toISOString(),
            state.sessionKey,
          ),
          transition: 'close',
          session_key: state.sessionKey,
          scheduled_for: closeAt,
          schedule_fingerprint: this.buildRecoveryScheduleFingerprint(
            parsed.timezone,
            parsed.startMinutes,
            parsed.endMinutes,
          ),
        });
        await consider(stateResolution);
        seenSessions.add(state.sessionKey);
      }
    }

    if (options.scanHistoricalLedger !== false) {
      await this.scanCompletedCloseLedgerRecoveries(chatId, seenSessions, consider);
    }

    const rows = (await this.listScheduledJobRegistryRows([chatId])).filter(
      (row) => row.recovery_payload == null && row.scheduled_for.getTime() <= Date.now(),
    );
    for (const row of rows) {
      if (seenSessions.has(row.session_key)) {
        continue;
      }
      seenSessions.add(row.session_key);
      await consider(await this.inspectMarkerlessRegistryRecovery(chatId, row));
    }
    return selectedNeeded ?? selectedBlocked ?? { kind: 'none' };
  }

  private async scanCompletedCloseLedgerRecoveries(
    chatId: string,
    seenSessions: Set<string>,
    consider: (resolution: NightModeCloseRecoveryResolution) => Promise<void>,
  ): Promise<void> {
    if (typeof this.prisma.maxActionLedgerEntry?.findMany !== 'function') {
      return;
    }
    const jobIdPrefix = buildNightModeNoticeIdempotencyKey('close', chatId, '');
    let cursor: { completedAt: Date; id: string } | null = null;
    while (true) {
      const page = await this.listMissingCloseEventLedgerPage(chatId, jobIdPrefix, cursor);
      for (const row of page) {
        const ledger: NightModeCloseLedgerRow & { id: string; jobId: string } = {
          ...row,
          actionType: 'SEND_MESSAGE',
          chatId,
          sourceTag: NIGHT_MODE_TRANSITION_SOURCE_TAG,
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
        };
        if (!ledger.jobId.startsWith(jobIdPrefix)) {
          continue;
        }
        const sessionKey = ledger.jobId.slice(jobIdPrefix.length);
        if (
          !sessionKey ||
          seenSessions.has(sessionKey) ||
          ledger.jobId !== buildNightModeNoticeIdempotencyKey('close', chatId, sessionKey)
        ) {
          continue;
        }
        seenSessions.add(sessionKey);
        const parsed = parseNightModeTransitionSessionKey(sessionKey);
        const closeAt =
          resolveNightModeTransitionSessionCloseAt(sessionKey) ??
          resolveNightModeLegacyRecoveryTime(sessionKey, 'close');
        const messageId = ledger.remoteMessageId?.trim() ?? '';
        const botId = ledger.dispatchBotId?.trim() ?? '';
        if (!parsed || !closeAt) {
          continue;
        }
        const fingerprint = this.buildRecoveryScheduleFingerprint(
          parsed.timezone,
          parsed.startMinutes,
          parsed.endMinutes,
        );
        const fallbackJobId = buildNightModeTransitionJobId(
          chatId,
          'close',
          closeAt.toISOString(),
          sessionKey,
        );
        if (this.hasNoAcceptedCloseDispatch(ledger, chatId)) {
          continue;
        }
        if (!this.isExactCompletedCloseLedger(ledger, chatId) || !messageId || !botId) {
          continue;
        }
        const resolution = await this.inspectRecoveryCandidate(
          chatId,
          {
            kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
            version: 1,
            sessionKey,
            messageId,
            botId,
            timezone: parsed.timezone,
            startMinutes: parsed.startMinutes,
            endMinutes: parsed.endMinutes,
          },
          false,
          fallbackJobId,
          fingerprint,
          ledger,
        );
        await consider(resolution);
        if (resolution.kind === 'needed') {
          return;
        }
      }
      if (page.length < NIGHT_MODE_RECOVERY_LEDGER_PAGE_SIZE) {
        return;
      }
      const lastRow = page[page.length - 1]!;
      cursor = { completedAt: lastRow.completedAt, id: lastRow.id };
    }
  }

  private async listMissingCloseEventLedgerPage(
    chatId: string,
    jobIdPrefix: string,
    cursor: { completedAt: Date; id: string } | null,
  ): Promise<NightModeCompletedCloseLedgerRecoveryRow[]> {
    if (typeof this.prisma.$queryRaw === 'function') {
      const cursorPredicate = cursor
        ? Prisma.sql`
            AND (ledger."completed_at", ledger."id") < (${cursor.completedAt}, ${cursor.id})
          `
        : Prisma.empty;
      return this.prisma.$queryRaw<NightModeCompletedCloseLedgerRecoveryRow[]>(Prisma.sql`
        SELECT
          ledger."id",
          ledger."job_id" AS "jobId",
          ledger."completed_at" AS "completedAt",
          ledger."dispatch_bot_id" AS "dispatchBotId",
          ledger."remote_message_id" AS "remoteMessageId"
        FROM "max_action_ledger" ledger
        WHERE ledger."chat_id" = ${chatId}
          AND ledger."terminal" = true
          AND ledger."completed_at" IS NOT NULL
          AND ledger."status" = 'SUCCEEDED'
          AND ledger."ambiguous" = false
          AND ledger."action_type" = 'SEND_MESSAGE'
          AND ledger."source_tag" = 'night_mode_transition'
          AND ledger."remote_message_id" IS NOT NULL
          AND BTRIM(ledger."remote_message_id") <> ''
          AND ledger."dispatch_bot_id" IS NOT NULL
          AND BTRIM(ledger."dispatch_bot_id") <> ''
          AND ledger."job_id" LIKE 'night-mode:close:%'
          AND LEFT(ledger."job_id", CHAR_LENGTH(${jobIdPrefix})) = ${jobIdPrefix}
          AND NOT EXISTS (
            SELECT 1
            FROM "moderation_events" event
            WHERE event."chat_id" = ledger."chat_id"
              AND event."message_id" = ledger."remote_message_id"
              AND event."bot_id" = ledger."dispatch_bot_id"
              AND event."rule_code" = 'NIGHT_MODE_CLOSE_NOTICE'
              AND event."metadata" ->> 'sessionKey' = SUBSTRING(
                ledger."job_id" FROM CHAR_LENGTH(${jobIdPrefix}) + 1
              )
          )
          ${cursorPredicate}
        ORDER BY ledger."completed_at" DESC, ledger."id" DESC
        LIMIT ${NIGHT_MODE_RECOVERY_LEDGER_PAGE_SIZE}
      `);
    }

    return (await this.prisma.maxActionLedgerEntry.findMany({
      where: {
        chatId,
        actionType: 'SEND_MESSAGE',
        sourceTag: NIGHT_MODE_TRANSITION_SOURCE_TAG,
        jobId: { startsWith: jobIdPrefix },
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        completedAt: { not: null },
        dispatchBotId: { not: null },
        remoteMessageId: { not: null },
      },
      select: {
        id: true,
        jobId: true,
        completedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: NIGHT_MODE_RECOVERY_LEDGER_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    })) as NightModeCompletedCloseLedgerRecoveryRow[];
  }

  private compareRecoverySessions(leftSessionKey: string, rightSessionKey: string): number {
    const leftAt = (
      resolveNightModeTransitionSessionCloseAt(leftSessionKey) ??
      resolveNightModeLegacyRecoveryTime(leftSessionKey, 'close')
    )?.getTime();
    const rightAt = (
      resolveNightModeTransitionSessionCloseAt(rightSessionKey) ??
      resolveNightModeLegacyRecoveryTime(rightSessionKey, 'close')
    )?.getTime();
    return (leftAt ?? Number.NEGATIVE_INFINITY) - (rightAt ?? Number.NEGATIVE_INFINITY);
  }

  private async inspectMarkerlessRegistryRecovery(
    chatId: string,
    row: NightModeScheduledJobRegistryRow,
  ): Promise<NightModeCloseRecoveryResolution> {
    const ledger = await this.readCloseLedger(chatId, row.session_key);
    if (!ledger || this.hasNoAcceptedCloseDispatch(ledger, chatId)) {
      return { kind: 'none' };
    }
    const parsed = parseNightModeTransitionSessionKey(row.session_key);
    const messageId = ledger.remoteMessageId?.trim() ?? '';
    const botId = ledger.dispatchBotId?.trim() ?? '';
    if (!parsed || !this.isExactCompletedCloseLedger(ledger, chatId) || !messageId || !botId) {
      return this.blockRecovery(
        chatId,
        row.job_id,
        row.session_key,
        row.schedule_fingerprint,
        'Markerless night mode close recovery has unsafe ledger or session metadata',
      );
    }
    return this.inspectRecoveryCandidate(
      chatId,
      {
        kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
        version: 1,
        sessionKey: row.session_key,
        messageId,
        botId,
        timezone: parsed.timezone,
        startMinutes: parsed.startMinutes,
        endMinutes: parsed.endMinutes,
      },
      false,
      row.job_id,
      row.schedule_fingerprint,
      ledger,
    );
  }

  private async inspectRecoveryCandidate(
    chatId: string,
    recovery: NightModeTransitionRecoveryOnly,
    missingIsBlocked: boolean,
    fallbackJobId: string,
    fingerprint: string,
    knownLedger?: NightModeCloseLedgerRow,
  ): Promise<NightModeCloseRecoveryResolution> {
    const ledger = knownLedger ?? (await this.readCloseLedger(chatId, recovery.sessionKey));
    if (!ledger) {
      return missingIsBlocked
        ? this.blockRecovery(
            chatId,
            fallbackJobId,
            recovery.sessionKey,
            fingerprint,
            'Night mode close-event recovery ledger proof is missing',
          )
        : { kind: 'none' };
    }
    if (this.hasNoAcceptedCloseDispatch(ledger, chatId)) {
      return { kind: 'none' };
    }
    if (
      !this.isExactCompletedCloseLedger(ledger, chatId) ||
      ledger.remoteMessageId?.trim() !== recovery.messageId ||
      ledger.dispatchBotId?.trim() !== recovery.botId
    ) {
      return this.blockRecovery(
        chatId,
        fallbackJobId,
        recovery.sessionKey,
        fingerprint,
        'Night mode close-event recovery ledger proof is unsafe',
      );
    }
    const preflight = await this.inspectRecoveryEnvelope(chatId, recovery, ledger);
    return preflight === 'already_complete'
      ? { kind: 'already_complete', recovery }
      : preflight === 'needed'
        ? { kind: 'needed', recovery }
        : this.blockRecovery(
            chatId,
            fallbackJobId,
            recovery.sessionKey,
            fingerprint,
            'Night mode close-event recovery event proof is unavailable',
          );
  }

  private async inspectRecoveryEnvelope(
    chatId: string,
    recovery: NightModeTransitionRecoveryOnly | NightModeTransitionOpenEventRecovery,
    knownLedger?: NightModeCloseLedgerRow,
  ): Promise<NightModeRecoveryOnlyPreflight> {
    const transition =
      recovery.kind === NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY ? 'open' : 'close';
    const ledger =
      knownLedger ?? (await this.readNoticeLedger(chatId, recovery.sessionKey, transition));
    if (
      !ledger ||
      !this.isExactCompletedCloseLedger(ledger, chatId) ||
      ledger.remoteMessageId?.trim() !== recovery.messageId ||
      ledger.dispatchBotId?.trim() !== recovery.botId ||
      typeof this.prisma.moderationEvent?.findFirst !== 'function'
    ) {
      return 'unsafe';
    }
    const event = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        messageId: recovery.messageId,
        botId: recovery.botId,
        ruleCode: transition === 'open' ? 'NIGHT_MODE_OPEN_NOTICE' : 'NIGHT_MODE_CLOSE_NOTICE',
        metadata: {
          path: ['sessionKey'],
          equals: recovery.sessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    return event ? 'already_complete' : 'needed';
  }

  private async readCloseLedger(
    chatId: string,
    sessionKey: string,
  ): Promise<NightModeCloseLedgerRow | null> {
    return this.readNoticeLedger(chatId, sessionKey, 'close');
  }

  private async readNoticeLedger(
    chatId: string,
    sessionKey: string,
    transition: 'close' | 'open',
  ): Promise<NightModeCloseLedgerRow | null> {
    if (typeof this.prisma.maxActionLedgerEntry?.findUnique !== 'function') {
      return null;
    }
    return this.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId: buildNightModeNoticeIdempotencyKey(transition, chatId, sessionKey) },
      select: {
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        completedAt: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
    }) as Promise<NightModeCloseLedgerRow | null>;
  }

  private isExactCompletedCloseLedger(ledger: NightModeCloseLedgerRow, chatId: string): boolean {
    return (
      ledger.actionType === 'SEND_MESSAGE' &&
      ledger.chatId === chatId &&
      ledger.sourceTag === NIGHT_MODE_TRANSITION_SOURCE_TAG &&
      ledger.status === MaxActionLedgerStatus.SUCCEEDED &&
      !ledger.ambiguous &&
      ledger.terminal &&
      ledger.completedAt instanceof Date &&
      Number.isFinite(ledger.completedAt.getTime())
    );
  }

  private hasNoAcceptedCloseDispatch(ledger: NightModeCloseLedgerRow, chatId: string): boolean {
    return (
      ledger.actionType === 'SEND_MESSAGE' &&
      ledger.chatId === chatId &&
      ledger.sourceTag === NIGHT_MODE_TRANSITION_SOURCE_TAG &&
      !ledger.ambiguous &&
      !ledger.dispatchToken &&
      !ledger.dispatchStartedAt &&
      !ledger.dispatchBotId &&
      !ledger.remoteMessageId
    );
  }

  private blockRecovery(
    chatId: string,
    jobId: string,
    sessionKey: string,
    fingerprint: string,
    reason: string,
  ): Extract<NightModeCloseRecoveryResolution, { kind: 'blocked' }> {
    return {
      kind: 'blocked',
      manualReview: {
        category: 'unsafe_prior_provenance',
        reason: `${reason} (${jobId})`,
        jobId,
        ledgerJobId: buildNightModeNoticeIdempotencyKey('close', chatId, sessionKey),
        sessionKey,
        fingerprint,
      },
    };
  }

  private buildRecoveryScheduleFingerprint(
    timezone: string,
    startMinutes: number,
    endMinutes: number,
  ): string {
    return buildNightModeTransitionScheduleFingerprint({
      nightModeEnabled: true,
      nightModeStartTimeMinutes: startMinutes,
      nightModeEndTimeMinutes: endMinutes,
      nightModeTimezone: timezone,
    });
  }

  private async resolveMissingBullCatchUp(
    params: {
      chatId: string;
      jobId: string;
      sessionKey: string;
      transition: NightModeTransitionOccurrence['transition'];
      fingerprint: string;
    },
    options: { durableRegistryProof: boolean },
  ): Promise<NightModeCurrentCatchUpResolution> {
    if (typeof this.prisma.maxActionLedgerEntry?.findUnique !== 'function') {
      if (!options.durableRegistryProof) {
        return { kind: 'skip' };
      }
      return {
        kind: 'blocked',
        manualReview: {
          category: 'failed_job_unclassified',
          reason: `Night mode catch-up ledger is unavailable (${params.jobId})`,
          jobId: params.jobId,
          ledgerJobId: null,
          sessionKey: params.sessionKey,
          fingerprint: params.fingerprint,
        },
      };
    }
    const ledgerJobId = buildNightModeNoticeIdempotencyKey(
      params.transition,
      params.chatId,
      params.sessionKey,
    );
    const ledger = await this.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId: ledgerJobId },
      select: {
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        attemptCount: true,
        completedAt: true,
        lastError: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
    });
    if (!ledger) {
      return options.durableRegistryProof ? { kind: 'enqueue' } : { kind: 'skip' };
    }
    const accessRecoveryMarker = getNightModeTransitionAccessRecoveryMarker(params.transition);
    const exactIdentity =
      ledger.actionType === 'SEND_MESSAGE' &&
      ledger.chatId === params.chatId &&
      ledger.sourceTag === NIGHT_MODE_TRANSITION_SOURCE_TAG;
    const noDispatchFence =
      !ledger.ambiguous &&
      !ledger.dispatchToken &&
      !ledger.dispatchStartedAt &&
      !ledger.dispatchBotId;
    if (
      exactIdentity &&
      ledger.status === MaxActionLedgerStatus.SUCCEEDED &&
      ledger.terminal &&
      !ledger.ambiguous &&
      ledger.completedAt instanceof Date &&
      Boolean(ledger.remoteMessageId?.trim()) &&
      Boolean(ledger.dispatchBotId?.trim())
    ) {
      return options.durableRegistryProof ? { kind: 'enqueue' } : { kind: 'skip' };
    }
    if (
      options.durableRegistryProof &&
      exactIdentity &&
      noDispatchFence &&
      !ledger.remoteMessageId &&
      (ledger.status === MaxActionLedgerStatus.ENQUEUED ||
        ledger.status === MaxActionLedgerStatus.IN_PROGRESS ||
        ledger.status === MaxActionLedgerStatus.FAILED_RETRYABLE) &&
      !ledger.terminal &&
      ledger.completedAt === null &&
      ledger.lastError !== accessRecoveryMarker
    ) {
      return { kind: 'enqueue' };
    }
    const potentiallyRecoverable =
      exactIdentity &&
      noDispatchFence &&
      !ledger.remoteMessageId &&
      ((ledger.status === MaxActionLedgerStatus.FAILED_TERMINAL && ledger.terminal) ||
        (ledger.status === MaxActionLedgerStatus.ENQUEUED &&
          !ledger.terminal &&
          ledger.attemptCount === 0 &&
          ledger.lastError === accessRecoveryMarker));
    if (potentiallyRecoverable) {
      const recovery = await prepareDefinitivelyRejectedNightModeTransitionRetry(this.prisma, {
        chatId: params.chatId,
        sessionKey: params.sessionKey,
        transition: params.transition,
        actionableBotIds: this.getActionableBotIds(),
      });
      if (recovery.kind === 'ready') {
        return { kind: 'enqueue' };
      }
      return {
        kind: 'blocked',
        manualReview: {
          category: recovery.category,
          reason: `Night mode catch-up cannot safely recover terminal ledger state (${recovery.jobId})`,
          jobId: params.jobId,
          ledgerJobId: recovery.jobId,
          sessionKey: params.sessionKey,
          fingerprint: params.fingerprint,
        },
      };
    }
    return {
      kind: 'blocked',
      manualReview: {
        category: 'unsafe_prior_provenance',
        reason: `Night mode catch-up has durable send provenance without a Bull job (${params.jobId})`,
        jobId: params.jobId,
        ledgerJobId,
        sessionKey: params.sessionKey,
        fingerprint: params.fingerprint,
      },
    };
  }

  private async canEnqueueCurrentCatchUp(
    params: {
      chatId: string;
      jobId: string;
      sessionKey: string;
      transition: NightModeTransitionOccurrence['transition'];
      scheduledFor: string;
      fingerprint: string;
    },
    options: {
      strict?: boolean;
      ignoreManualReview?: boolean;
      reconcileFence?: NightModeTransitionReconcileFence;
    } = {},
  ): Promise<NightModeCurrentCatchUpResolution> {
    try {
      if (!options.ignoreManualReview) {
        const manualDisposition = await this.findExactManualReviewDisposition(params);
        if (manualDisposition.kind === 'acknowledged') {
          const currentResolution = await this.canEnqueueCurrentCatchUp(params, {
            ...options,
            ignoreManualReview: true,
          });
          if (
            currentResolution.kind === 'blocked' &&
            currentResolution.manualReview.category !== manualDisposition.category
          ) {
            return currentResolution;
          }
          return { kind: 'skip' };
        }
        if (manualDisposition.kind === 'blocked') {
          return { kind: 'blocked', manualReview: manualDisposition.manualReview };
        }
      }
      if (!this.queue || typeof this.queue.getJob !== 'function') {
        await this.deleteScheduledJobRegistryRow(params.chatId, params.jobId);
        return { kind: 'skip' };
      }
      const existing = await this.queue.getJob(params.jobId);
      if (!existing) {
        const registry = await this.findScheduledJobRegistryRow(params.chatId, params.jobId);
        if (!registry) {
          return this.resolveMissingBullCatchUp(params, { durableRegistryProof: false });
        }
        const currentRuntimeRegistry =
          registry?.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
          Boolean(registry && registry.scheduled_for.getTime() >= this.runtimeStartedAtMs);
        if (!currentRuntimeRegistry) {
          if (registry) {
            await this.deleteScheduledJobRegistryRow(params.chatId, params.jobId);
          }
          return { kind: 'skip' };
        }
        return this.resolveMissingBullCatchUp(params, { durableRegistryProof: true });
      }
      let transitionRuntimeVersion = existing.data?.transitionRuntimeVersion;
      const registry = await this.findScheduledJobRegistryRow(params.chatId, params.jobId);
      const hadExactCurrentV4FailureProof =
        this.isExactCurrentV4BullEnvelope(existing.data, params) &&
        this.isExactCurrentV4Registry(registry, params);
      const existingState =
        typeof existing.getState === 'function' ? await existing.getState() : null;
      let currentRuntimeJob =
        existing.data === undefined ||
        transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
        registry?.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
        (existing.data !== undefined &&
          Number.isFinite(Date.parse(params.scheduledFor)) &&
          Date.parse(params.scheduledFor) >= this.runtimeStartedAtMs);
      if (!currentRuntimeJob) {
        if (existingState !== 'active') {
          if (await this.removeJob(existing, { strict: true })) {
            await this.deleteScheduledJobRegistryRow(params.chatId, params.jobId);
          }
        }
        return { kind: 'skip' };
      }
      if (
        existing.data !== undefined &&
        transitionRuntimeVersion !== NIGHT_MODE_TRANSITION_RUNTIME_VERSION
      ) {
        if (existingState === 'active') {
          return { kind: 'skip' };
        }
        await this.upsertScheduledJobRegistryIntent(
          {
            chat_id: params.chatId,
            job_id: params.jobId,
            transition: params.transition,
            session_key: params.sessionKey,
            scheduled_for: new Date(params.scheduledFor),
            schedule_fingerprint: params.fingerprint,
            runtime_version: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
          },
          options.reconcileFence,
        );
        await this.promoteTransitionJob(existing, params);
        transitionRuntimeVersion = NIGHT_MODE_TRANSITION_RUNTIME_VERSION;
      }
      if (typeof existing.getState !== 'function') {
        return { kind: 'enqueue' };
      }

      if (existingState !== 'failed') {
        return { kind: 'enqueue' };
      }

      const failedJob = await this.queue.getJob(params.jobId);
      if (!failedJob || typeof failedJob.getState !== 'function') {
        throw new NightModeTransitionFailedJobSnapshotUnstableError(
          `Night mode transition failed job disappeared before durable inspection (${params.jobId})`,
        );
      }
      const failedJobState = await failedJob.getState();
      if (
        failedJobState !== 'failed' ||
        typeof failedJob.failedReason !== 'string' ||
        failedJob.failedReason.trim().length === 0
      ) {
        throw new NightModeTransitionFailedJobSnapshotUnstableError(
          `Night mode transition failed job did not stabilize before durable inspection (${params.jobId})`,
        );
      }
      if (
        params.transition === 'open' &&
        (await this.retainAcceptedOpenEventRecovery(
          {
            chatId: params.chatId,
            transition: 'open',
            sessionKey: params.sessionKey,
            scheduledFor: params.scheduledFor,
          },
          { queueMutationLocked: true, reconcileFence: options.reconcileFence },
        ))
      ) {
        await this.removeJob(failedJob, { strict: true });
        await this.deleteScheduledJobRegistryRow(params.chatId, params.jobId);
        return { kind: 'skip' };
      }
      transitionRuntimeVersion = failedJob.data?.transitionRuntimeVersion;
      currentRuntimeJob =
        failedJob.data === undefined ||
        transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
        registry?.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
        (failedJob.data !== undefined &&
          Number.isFinite(Date.parse(params.scheduledFor)) &&
          Date.parse(params.scheduledFor) >= this.runtimeStartedAtMs);
      const failedUnderCurrentV4Runtime =
        hadExactCurrentV4FailureProof &&
        this.isExactCurrentV4BullEnvelope(failedJob.data, params) &&
        this.isExactCurrentV4Registry(registry, params);
      const closeLedgerJobId = buildNightModeNoticeIdempotencyKey(
        'close',
        params.chatId,
        params.sessionKey,
      );
      if (
        this.isDeterministicCloseLedgerProvenanceFailure(failedJob.failedReason, closeLedgerJobId)
      ) {
        return {
          kind: 'blocked',
          manualReview: {
            category: 'unsafe_prior_provenance',
            reason: `Night mode catch-up has unsafe close ledger provenance (${params.jobId})`,
            jobId: params.jobId,
            ledgerJobId: closeLedgerJobId,
            sessionKey: params.sessionKey,
            fingerprint: params.fingerprint,
          },
        };
      }

      const preDispatchLedger = await this.inspectExactRetryablePreDispatchLedger(params);
      // FLAG: v4 records SEND_MESSAGE start before any remote dispatch. Only a pre-existing exact
      // v4 Bull/SQL intent makes a missing ledger definitive pre-dispatch proof.
      if (
        preDispatchLedger === 'retryable' ||
        (preDispatchLedger === 'missing' && failedUnderCurrentV4Runtime)
      ) {
        await this.retryFailedTransitionJob(failedJob, params.jobId);
        return { kind: 'enqueue' };
      }
      const legacyPreDispatchNoRouteFailure =
        failedJob.failedReason ===
        buildMaxActionNoExecutableRouteMessage('SEND_MESSAGE', params.chatId);
      const preDispatchRouteQuarantineFailure =
        failedJob.failedReason ===
        buildMaxActionRouteQuarantinedMessage('SEND_MESSAGE', params.chatId);
      const preDispatchLockContentionFailure =
        failedJob.failedReason ===
        `${NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX} (${params.chatId})`;
      const recoverableLegacyOpenFailure =
        params.transition === 'open' &&
        transitionRuntimeVersion === undefined &&
        this.isRecoverableCurrentOpenFailure(failedJob.failedReason);
      const ledgerJobId = buildNightModeNoticeIdempotencyKey(
        'open',
        params.chatId,
        params.sessionKey,
      );
      const recoverableVersionedLedgerFailure =
        params.transition === 'open' &&
        currentRuntimeJob &&
        (transitionRuntimeVersion === 2 ||
          transitionRuntimeVersion === 3 ||
          transitionRuntimeVersion === 4) &&
        failedJob.failedReason ===
          `MAX SEND_MESSAGE ledger entry ${ledgerJobId} is no longer executable (${MaxActionLedgerStatus.FAILED_TERMINAL})`;
      const retryablePostExecutionCleanupFailure =
        params.transition === 'open' &&
        currentRuntimeJob &&
        (transitionRuntimeVersion === 3 || transitionRuntimeVersion === 4) &&
        failedJob.failedReason.startsWith(
          `${NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX}: `,
        ) === true;
      if (retryablePostExecutionCleanupFailure) {
        const ledgerResolution = await this.resolveMissingBullCatchUp(params, {
          durableRegistryProof: true,
        });
        if (ledgerResolution.kind === 'enqueue') {
          await this.retryFailedTransitionJob(failedJob, params.jobId);
          return ledgerResolution;
        }
        if (ledgerResolution.kind === 'blocked') {
          return ledgerResolution;
        }
      }
      if (recoverableVersionedLedgerFailure) {
        const recovery = await prepareDefinitivelyRejectedNightModeOpenRetry(this.prisma, {
          chatId: params.chatId,
          sessionKey: params.sessionKey,
          actionableBotIds: this.getActionableBotIds(),
        });
        if (recovery.kind === 'blocked') {
          const reason = `Night mode catch-up cannot safely recover terminal ledger state (${recovery.jobId})`;
          this.logger.warn(
            {
              chatId: params.chatId,
              jobId: params.jobId,
              ledgerJobId: recovery.jobId,
              sessionKey: params.sessionKey,
            },
            'Kept night mode catch-up pending because terminal send provenance was unsafe',
          );
          return {
            kind: 'blocked',
            manualReview: {
              category: recovery.category,
              reason,
              jobId: params.jobId,
              ledgerJobId: recovery.jobId,
              sessionKey: params.sessionKey,
              fingerprint: params.fingerprint,
            },
          };
        }
        await this.retryFailedTransitionJob(failedJob, params.jobId);
        return { kind: 'enqueue' };
      }
      if (recoverableLegacyOpenFailure) {
        return {
          kind: 'blocked',
          manualReview: {
            category: 'unsafe_prior_provenance',
            reason: `Night mode catch-up has legacy send provenance (${params.jobId})`,
            jobId: params.jobId,
            ledgerJobId: null,
            sessionKey: params.sessionKey,
            fingerprint: params.fingerprint,
          },
        };
      }
      if (
        !legacyPreDispatchNoRouteFailure &&
        !preDispatchRouteQuarantineFailure &&
        !preDispatchLockContentionFailure
      ) {
        this.logger.warn(
          {
            chatId: params.chatId,
            jobId: params.jobId,
            sessionKey: params.sessionKey,
            transitionRuntimeVersion: transitionRuntimeVersion ?? null,
            failedReason: failedJob.failedReason,
          },
          'Skipped night mode catch-up after an ambiguous or terminal prior failure',
        );
        return {
          kind: 'blocked',
          manualReview: {
            category: 'unsafe_prior_dispatch',
            reason: `Night mode catch-up is blocked by an unsafe prior failure (${params.jobId})`,
            jobId: params.jobId,
            ledgerJobId: null,
            sessionKey: params.sessionKey,
            fingerprint: params.fingerprint,
          },
        };
      }

      await this.retryFailedTransitionJob(failedJob, params.jobId);
      return { kind: 'enqueue' };
    } catch (error: unknown) {
      if (error instanceof NightModeTransitionFailedJobSnapshotUnstableError) {
        throw error;
      }
      if (this.isBullMqMissingJobRemovalError(error, params.jobId)) {
        return { kind: 'enqueue' };
      }
      this.logger.warn(
        {
          chatId: params.chatId,
          jobId: params.jobId,
          sessionKey: params.sessionKey,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not safely inspect a failed night mode opening job for catch-up',
      );
      if (options.strict === true) {
        throw error;
      }
      return {
        kind: 'blocked',
        manualReview: {
          category: 'failed_job_unclassified',
          reason: `Night mode catch-up inspection failed (${params.jobId})`,
          jobId: params.jobId,
          ledgerJobId: null,
          sessionKey: params.sessionKey,
          fingerprint: params.fingerprint,
        },
      };
    }
  }

  private isRecoverableCurrentOpenFailure(failedReason: string | undefined): boolean {
    const normalized = failedReason?.trim().toLowerCase() ?? '';
    return normalized.includes('user.not.admin') || normalized.includes('user is not an admin');
  }

  private isDeterministicCloseLedgerProvenanceFailure(
    failedReason: string | undefined,
    closeLedgerJobId: string,
  ): boolean {
    return (
      failedReason === `Night mode close send ledger provenance is unsafe (${closeLedgerJobId})` ||
      failedReason === `Exact completed night mode close send is not proven (${closeLedgerJobId})`
    );
  }

  private isExactCurrentV4BullEnvelope(
    data: NightModeTransitionJob | undefined,
    params: {
      chatId: string;
      sessionKey: string;
      transition: NightModeTransitionOccurrence['transition'];
      scheduledFor: string;
      fingerprint: string;
    },
  ): boolean {
    return (
      data?.chatId === params.chatId &&
      data.transition === params.transition &&
      data.sessionKey === params.sessionKey &&
      data.scheduledFor === params.scheduledFor &&
      data.scheduleFingerprint === params.fingerprint &&
      data.transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION &&
      data.recoveryOnly === undefined
    );
  }

  private isExactCurrentV4Registry(
    registry: NightModeScheduledJobRegistryRow | null,
    params: {
      chatId: string;
      jobId: string;
      sessionKey: string;
      transition: NightModeTransitionOccurrence['transition'];
      scheduledFor: string;
      fingerprint: string;
    },
  ): boolean {
    const scheduledForMs = Date.parse(params.scheduledFor);
    return (
      registry?.chat_id === params.chatId &&
      registry.job_id === params.jobId &&
      registry.transition === params.transition &&
      registry.session_key === params.sessionKey &&
      registry.scheduled_for instanceof Date &&
      Number.isFinite(scheduledForMs) &&
      registry.scheduled_for.getTime() === scheduledForMs &&
      registry.schedule_fingerprint === params.fingerprint &&
      registry.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION
    );
  }

  private async inspectExactRetryablePreDispatchLedger(params: {
    chatId: string;
    sessionKey: string;
    transition: NightModeTransitionOccurrence['transition'];
  }): Promise<'missing' | 'retryable' | 'unsafe'> {
    if (typeof this.prisma.maxActionLedgerEntry?.findUnique !== 'function') {
      return 'unsafe';
    }
    const ledger = await this.prisma.maxActionLedgerEntry.findUnique({
      where: {
        jobId: buildNightModeNoticeIdempotencyKey(
          params.transition,
          params.chatId,
          params.sessionKey,
        ),
      },
      select: {
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        dispatchToken: true,
        dispatchStartedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
      },
    });
    if (!ledger) {
      return 'missing';
    }
    return ledger.actionType === 'SEND_MESSAGE' &&
      ledger.chatId === params.chatId &&
      ledger.sourceTag === NIGHT_MODE_TRANSITION_SOURCE_TAG &&
      (ledger.status === MaxActionLedgerStatus.ENQUEUED ||
        ledger.status === MaxActionLedgerStatus.IN_PROGRESS ||
        ledger.status === MaxActionLedgerStatus.FAILED_RETRYABLE) &&
      !ledger.ambiguous &&
      !ledger.terminal &&
      !ledger.dispatchToken &&
      !ledger.dispatchStartedAt &&
      !ledger.dispatchBotId &&
      !ledger.remoteMessageId
      ? 'retryable'
      : 'unsafe';
  }

  private resolveTransitionOccurrences(
    settings: NightModeTransitionScheduleSettings,
    options: {
      includeCurrentClose?: boolean;
      includeCurrentOpen?: boolean;
      includeFuture?: boolean;
    },
  ): NightModeTransitionOccurrence[] {
    const occurrences =
      options.includeFuture === false ? [] : resolveNextNightModeTransitionOccurrences(settings);
    if (!options.includeCurrentClose && !options.includeCurrentOpen) {
      return occurrences;
    }

    const currentOccurrences = [
      ...(options.includeCurrentClose ? [resolveCurrentNightModeCloseOccurrence(settings)] : []),
      ...(options.includeCurrentOpen ? [resolveCurrentNightModeOpenOccurrence(settings)] : []),
    ].filter((occurrence): occurrence is NightModeTransitionOccurrence => occurrence !== null);

    if (currentOccurrences.length === 0) {
      return occurrences;
    }

    const currentOccurrenceKeys = new Set(
      currentOccurrences.map((occurrence) => `${occurrence.transition}:${occurrence.sessionKey}`),
    );
    return [
      ...currentOccurrences,
      ...occurrences.filter(
        (occurrence) =>
          !currentOccurrenceKeys.has(`${occurrence.transition}:${occurrence.sessionKey}`),
      ),
    ].sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  }

  private async runChatQueueMutationSerialized<T>(
    chatId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runChatQueueMutationLocally(chatId, async () => {
      const redisLock = this.getQueueMutationLockApi();
      if (!redisLock) {
        return operation();
      }

      const key = `night-mode-transition-queue-mutation:v1:${chatId}`;
      const deadline = Date.now() + NIGHT_MODE_QUEUE_MUTATION_LOCK_WAIT_MS;
      let token: string | null = null;
      do {
        token = await redisLock.acquireLock(key, NIGHT_MODE_QUEUE_MUTATION_LOCK_TTL_MS);
        if (token) {
          break;
        }
        await this.delay(50);
      } while (Date.now() < deadline);
      if (!token) {
        throw new Error(`Night mode queue mutation lock is busy (${chatId})`);
      }

      const lockToken = token;
      let lockHealthy = true;
      let renewalChain = Promise.resolve();
      const heartbeat = setInterval(() => {
        renewalChain = renewalChain
          .then(async () => {
            if (
              !(await redisLock.renewLock(key, lockToken, NIGHT_MODE_QUEUE_MUTATION_LOCK_TTL_MS))
            ) {
              lockHealthy = false;
            }
          })
          .catch((error: unknown) => {
            lockHealthy = false;
            this.logger.warn(
              {
                chatId,
                error: error instanceof Error ? error.message : String(error),
              },
              'Night mode queue mutation lock renewal failed',
            );
          });
      }, NIGHT_MODE_QUEUE_MUTATION_LOCK_HEARTBEAT_MS);
      heartbeat?.unref?.();
      try {
        const result = await operation();
        clearInterval(heartbeat);
        await renewalChain;
        if (
          !lockHealthy ||
          !(await redisLock.renewLock(key, lockToken, NIGHT_MODE_QUEUE_MUTATION_LOCK_TTL_MS))
        ) {
          throw new Error(`Night mode queue mutation lock was lost (${chatId})`);
        }
        return result;
      } finally {
        clearInterval(heartbeat);
        await renewalChain.catch(() => undefined);
        await redisLock.releaseLock(key, lockToken).catch((error: unknown) => {
          this.logger.warn(
            {
              chatId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Night mode queue mutation lock release failed',
          );
        });
      }
    });
  }

  private async runChatQueueMutationLocally<T>(
    chatId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.localQueueMutationChains.get(chatId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.localQueueMutationChains.set(chatId, chain);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.localQueueMutationChains.get(chatId) === chain) {
        this.localQueueMutationChains.delete(chatId);
      }
    }
  }

  private getQueueMutationLockApi(): NightModeQueueMutationLockApi | null {
    const redisCounter = this.redisCounter as Partial<RedisCounterService> | undefined;
    return redisCounter &&
      typeof redisCounter.acquireLock === 'function' &&
      typeof redisCounter.renewLock === 'function' &&
      typeof redisCounter.releaseLock === 'function'
      ? (redisCounter as NightModeQueueMutationLockApi)
      : null;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private scheduleBootstrap(delayMs: number): void {
    if (this.shuttingDown || this.startupTimer) {
      return;
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.bootstrapEnabledChats();
    }, delayMs);
    this.startupTimer.unref();
  }

  private requestBootstrapRetry(): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.bootstrapInFlight) {
      this.bootstrapRetryRequested = true;
      return;
    }
    this.scheduleBootstrap(NIGHT_MODE_TRANSITION_BOOTSTRAP_RETRY_MS);
  }

  private async clearChatJobsForChatIds(
    chatIds: readonly string[],
    options: {
      strict?: boolean;
      throwOnActive?: boolean;
      keepJobIds?: ReadonlySet<string>;
      reconcileFence?: NightModeTransitionReconcileFence;
    } = {},
  ): Promise<void> {
    if (!this.queue) {
      return;
    }

    const normalizedChatIds = this.normalizeChatIds(chatIds);
    if (normalizedChatIds.length === 0) {
      return;
    }

    const rows = await this.listScheduledJobRegistryRows(normalizedChatIds);
    const activeJobIds: string[] = [];
    for (const row of rows) {
      // FLAG: Independent receipt/cleanup obligations outlive ordinary schedule replacement.
      // Only their own exact completion may remove their durable payload.
      if (row.recovery_payload != null) continue;
      if (options.keepJobIds?.has(row.job_id)) {
        continue;
      }
      await this.retainAcceptedOpenEventRecovery(
        {
          chatId: row.chat_id,
          transition: row.transition,
          sessionKey: row.session_key,
          scheduledFor: row.scheduled_for.toISOString(),
        },
        { queueMutationLocked: true, reconcileFence: options.reconcileFence },
      );
      const job = await this.queue.getJob(row.job_id);
      if (!job) {
        await this.deleteScheduledJobRegistryRow(row.chat_id, row.job_id);
        continue;
      }
      if (typeof job.getState === 'function' && (await job.getState()) === 'active') {
        activeJobIds.push(row.job_id);
        // A fenced durable repair already owns a request. Re-enqueueing that same chat here would
        // increment its generation and revoke the lease that is about to report the active job.
        if (!options.reconcileFence) {
          await this.requestDurableReconcile(row.chat_id);
        }
        continue;
      }
      if (await this.removeJob(job, options)) {
        // FLAG: BullMQ removal is authoritative. The SQL intent is deleted only after the external
        // queue no longer contains the obsolete job, so a crash leaves recoverable registry state.
        await this.deleteScheduledJobRegistryRow(row.chat_id, row.job_id);
      }
    }
    if ((options.throwOnActive ?? options.strict === true) && activeJobIds.length > 0) {
      throw new NightModeTransitionJobsActiveError(activeJobIds);
    }
  }

  private async listScheduledJobRegistryRows(
    chatIds: readonly string[],
    jobId?: string,
  ): Promise<NightModeScheduledJobRegistryRow[]> {
    if (typeof this.prisma.$queryRaw === 'function') {
      return this.prisma.$queryRaw<NightModeScheduledJobRegistryRow[]>(Prisma.sql`
        SELECT
          "chat_id",
          "job_id",
          "transition",
          "session_key",
          "scheduled_for",
          "schedule_fingerprint",
          "runtime_version",
          "recovery_payload",
          "created_at"
        FROM "night_mode_transition_scheduled_jobs"
        WHERE "chat_id" IN (${Prisma.join(chatIds)})
          ${jobId === undefined ? Prisma.empty : Prisma.sql`AND "job_id" = ${jobId}`}
        ORDER BY "chat_id" ASC, "scheduled_for" ASC, "job_id" ASC
      `);
    }

    const chatIdSet = new Set(chatIds);
    return Array.from(this.fallbackScheduledJobRegistry.values())
      .filter((row) => chatIdSet.has(row.chat_id) && (jobId === undefined || row.job_id === jobId))
      .sort(
        (left, right) =>
          left.chat_id.localeCompare(right.chat_id) ||
          left.scheduled_for.getTime() - right.scheduled_for.getTime() ||
          left.job_id.localeCompare(right.job_id),
      );
  }

  private async findScheduledJobRegistryRow(
    chatId: string,
    jobId: string,
  ): Promise<NightModeScheduledJobRegistryRow | null> {
    const rows = await this.listScheduledJobRegistryRows([chatId], jobId);
    return rows.find((row) => row.job_id === jobId) ?? null;
  }

  private registryRowMatchesTransitionJob(
    row: NightModeScheduledJobRegistryRow,
    job: NightModeTransitionJob,
    jobId: string,
  ): boolean {
    const scheduledFor = new Date(job.scheduledFor);
    const scheduleFingerprint = this.resolveJobScheduleFingerprint(job);
    return (
      Number.isFinite(scheduledFor.getTime()) &&
      scheduleFingerprint !== null &&
      row.job_id === jobId &&
      row.transition === job.transition &&
      row.session_key === job.sessionKey &&
      row.scheduled_for.getTime() === scheduledFor.getTime() &&
      row.schedule_fingerprint === scheduleFingerprint &&
      (job.transitionRuntimeVersion === undefined ||
        row.runtime_version === job.transitionRuntimeVersion)
    );
  }

  private async upsertScheduledJobRegistryIntent(
    row: NightModeScheduledJobRegistryRow,
    reconcileFence?: NightModeTransitionReconcileFence,
  ): Promise<boolean> {
    if (typeof this.prisma.$executeRaw === 'function') {
      const retained = await this.prisma.$executeRaw(Prisma.sql`
        WITH request_owner AS (
          SELECT
            ${reconcileFence?.generation ?? null}::BIGINT AS "generation",
            ${reconcileFence?.leaseToken ?? null}::TEXT AS "lease_token"
        ), registry_intent AS (
          INSERT INTO "night_mode_transition_scheduled_jobs" (
            "chat_id",
            "job_id",
            "transition",
            "session_key",
            "scheduled_for",
            "schedule_fingerprint",
            "runtime_version",
            "recovery_payload",
            "created_at",
            "updated_at"
          )
          VALUES (
            ${row.chat_id},
            ${row.job_id},
            ${row.transition},
            ${row.session_key},
            ${row.scheduled_for},
            ${row.schedule_fingerprint},
            ${row.runtime_version ?? 3},
            ${row.recovery_payload == null ? null : JSON.stringify(row.recovery_payload)}::JSONB,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT ("chat_id", "job_id") DO UPDATE
          SET
            "transition" = EXCLUDED."transition",
            "session_key" = EXCLUDED."session_key",
            "scheduled_for" = EXCLUDED."scheduled_for",
            "schedule_fingerprint" = EXCLUDED."schedule_fingerprint",
            "runtime_version" = EXCLUDED."runtime_version",
            "recovery_payload" = EXCLUDED."recovery_payload",
            "updated_at" = CURRENT_TIMESTAMP
          WHERE ROW(
            "night_mode_transition_scheduled_jobs"."transition",
            "night_mode_transition_scheduled_jobs"."session_key",
            "night_mode_transition_scheduled_jobs"."scheduled_for",
            "night_mode_transition_scheduled_jobs"."schedule_fingerprint",
            "night_mode_transition_scheduled_jobs"."runtime_version",
            "night_mode_transition_scheduled_jobs"."recovery_payload"
          ) IS DISTINCT FROM ROW(
            EXCLUDED."transition",
            EXCLUDED."session_key",
            EXCLUDED."scheduled_for",
            EXCLUDED."schedule_fingerprint",
            EXCLUDED."runtime_version",
            EXCLUDED."recovery_payload"
          )
          RETURNING "chat_id"
        )
        INSERT INTO "night_mode_transition_reconcile_requests" (
          "chat_id",
          "generation",
          "first_requested_at",
          "requested_at"
        )
        SELECT "chat_id", 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM registry_intent
        ON CONFLICT ("chat_id") DO UPDATE
        SET
          "generation" = "night_mode_transition_reconcile_requests"."generation" + 1,
          "requested_at" = LEAST(
            "night_mode_transition_reconcile_requests"."requested_at",
            EXCLUDED."requested_at"
          ),
          "lease_token" = NULL,
          "lease_expires_at" = NULL
        WHERE NOT EXISTS (
          SELECT 1
          FROM request_owner owner
          WHERE owner."generation" =
              "night_mode_transition_reconcile_requests"."generation"
            AND owner."lease_token" =
              "night_mode_transition_reconcile_requests"."lease_token"
            AND (
              "night_mode_transition_reconcile_requests"."manual_blocked_at" IS NULL
              OR "night_mode_transition_reconcile_requests"."generation" >
                "night_mode_transition_reconcile_requests"."manual_blocked_generation"
            )
        )
      `);
      return retained > 0;
    }

    const registryKey = this.buildScheduledJobRegistryKey(row.chat_id, row.job_id);
    const existingRegistryRow = this.fallbackScheduledJobRegistry.get(registryKey);
    this.fallbackScheduledJobRegistry.set(registryKey, {
      ...row,
      runtime_version: row.runtime_version ?? 3,
      created_at: row.created_at ?? existingRegistryRow?.created_at ?? new Date(),
    });
    return false;
  }

  private async deleteScheduledJobRegistryRow(chatId: string, jobId: string): Promise<void> {
    if (typeof this.prisma.$executeRaw === 'function') {
      await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "night_mode_transition_scheduled_jobs"
        WHERE "chat_id" = ${chatId}
          AND "job_id" = ${jobId}
      `);
      return;
    }

    this.fallbackScheduledJobRegistry.delete(this.buildScheduledJobRegistryKey(chatId, jobId));
  }

  private async requestDurableReconcile(chatId: string): Promise<void> {
    if (typeof this.prisma.$executeRaw !== 'function') {
      return;
    }
    await this.prisma.$executeRaw(Prisma.sql`
      SELECT enqueue_night_mode_transition_reconcile_request(${chatId})
    `);
  }

  private async retainDurableReconcileAfterQueueFailure(
    chatId: string,
    durableReconcileRetained: boolean,
    reconcileFence?: NightModeTransitionReconcileFence,
  ): Promise<void> {
    if (reconcileFence || durableReconcileRetained) {
      return;
    }
    try {
      await this.requestDurableReconcile(chatId);
    } catch (error: unknown) {
      this.logger.error(
        {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to retain durable night mode reconcile after queue mutation failure',
      );
    }
  }

  private buildScheduledJobRegistryKey(chatId: string, jobId: string): string {
    return `${chatId}\u0000${jobId}`;
  }

  private async buildFutureStickyRouteProbe(
    chatId: string,
    jobId: string,
    occurrence: NightModeTransitionOccurrence,
    scheduleFingerprint: string,
  ): Promise<NightModeStickyRouteProbe | undefined> {
    if (occurrence.transition !== 'close' || occurrence.dueAt.getTime() <= Date.now()) {
      return undefined;
    }
    const registry = await this.findScheduledJobRegistryRow(chatId, jobId);
    const scheduledFor = occurrence.dueAt.toISOString();
    if (
      !this.registryMatchesFutureTransition(
        registry,
        {
          chatId,
          transition: occurrence.transition,
          scheduledFor,
          sessionKey: occurrence.sessionKey,
        },
        jobId,
        scheduleFingerprint,
      )
    ) {
      return undefined;
    }
    // FLAG: SQL timestamp rounding or clock skew must not put new-job authorization before its
    // committed intent. Both clocks must still precede the exact future CLOSE boundary.
    const authorizedAt = new Date(Math.max(Date.now(), registry.created_at.getTime()));
    if (occurrence.dueAt.getTime() <= authorizedAt.getTime()) {
      return undefined;
    }
    return {
      kind: NIGHT_MODE_STICKY_ROUTE_PROBE_KIND,
      version: 1,
      authorizedAt: authorizedAt.toISOString(),
      scheduledFor,
      sessionKey: occurrence.sessionKey,
      scheduleFingerprint,
    };
  }

  private async promoteFutureTransitionJob(
    jobId: string,
    fingerprint: string,
    requestedStickyRouteProbe?: NightModeStickyRouteProbe,
  ): Promise<void> {
    if (!this.queue || typeof this.queue.getJob !== 'function') {
      return;
    }
    const existing = await this.queue.getJob(jobId);
    if (!existing || existing.data === undefined) {
      return;
    }
    if (typeof existing.getState === 'function' && (await existing.getState()) === 'active') {
      return;
    }
    const currentStickyRouteProbe = parseNightModeStickyRouteProbe(existing.data.stickyRouteProbe);
    const registry = await this.findScheduledJobRegistryRow(existing.data.chatId, jobId);
    const jobIdentityMatches =
      existing.data.transition === 'close' &&
      buildNightModeTransitionJobId(
        existing.data.chatId,
        existing.data.transition,
        existing.data.scheduledFor,
        existing.data.sessionKey,
      ) === jobId;
    const currentAuthorizationMatches = Boolean(
      currentStickyRouteProbe &&
      jobIdentityMatches &&
      this.registryAuthorizesFutureStickyProbe(
        registry,
        existing.data,
        jobId,
        fingerprint,
        currentStickyRouteProbe,
      ) &&
      currentStickyRouteProbe.scheduledFor === existing.data.scheduledFor &&
      currentStickyRouteProbe.sessionKey === existing.data.sessionKey &&
      currentStickyRouteProbe.scheduleFingerprint === fingerprint,
    );
    const normalizedRequestedStickyRouteProbe =
      requestedStickyRouteProbe &&
      registry?.created_at &&
      registry.created_at.getTime() > Date.parse(requestedStickyRouteProbe.authorizedAt)
        ? { ...requestedStickyRouteProbe, authorizedAt: registry.created_at.toISOString() }
        : requestedStickyRouteProbe;
    const requestedAuthorizationMatches = Boolean(
      normalizedRequestedStickyRouteProbe &&
      parseNightModeStickyRouteProbe(normalizedRequestedStickyRouteProbe) &&
      jobIdentityMatches &&
      this.registryAuthorizesFutureStickyProbe(
        registry,
        existing.data,
        jobId,
        fingerprint,
        normalizedRequestedStickyRouteProbe,
      ) &&
      existing.data.scheduledFor === normalizedRequestedStickyRouteProbe.scheduledFor &&
      existing.data.sessionKey === normalizedRequestedStickyRouteProbe.sessionKey &&
      normalizedRequestedStickyRouteProbe.scheduleFingerprint === fingerprint &&
      Date.parse(existing.data.scheduledFor) > Date.now(),
    );
    const stickyRouteProbe = currentAuthorizationMatches
      ? currentStickyRouteProbe!
      : requestedAuthorizationMatches
        ? normalizedRequestedStickyRouteProbe
        : undefined;
    if (
      existing.data.transitionRuntimeVersion === NIGHT_MODE_TRANSITION_RUNTIME_VERSION &&
      existing.data.scheduleFingerprint === fingerprint &&
      (stickyRouteProbe
        ? currentAuthorizationMatches
        : existing.data.stickyRouteProbe === undefined)
    ) {
      return;
    }
    await this.promoteTransitionJob(existing, { jobId, fingerprint, stickyRouteProbe });
  }

  private isCompleteFutureTransitionJob(
    job: { data?: NightModeTransitionJob } | null | undefined,
    jobId: string,
    scheduleFingerprint: string,
    registry: NightModeScheduledJobRegistryRow | undefined,
  ): boolean {
    const data = job?.data;
    if (
      !data ||
      data.transitionRuntimeVersion !== NIGHT_MODE_TRANSITION_RUNTIME_VERSION ||
      data.scheduleFingerprint !== scheduleFingerprint ||
      data.recoveryOnly !== undefined ||
      data.routeVerification !== undefined ||
      buildNightModeTransitionJobId(
        data.chatId,
        data.transition,
        data.scheduledFor,
        data.sessionKey,
      ) !== jobId
    ) {
      return false;
    }
    if (!this.registryMatchesFutureTransition(registry, data, jobId, scheduleFingerprint)) {
      return false;
    }
    if (data.transition !== 'close') {
      return data.stickyRouteProbe === undefined;
    }
    const marker = parseNightModeStickyRouteProbe(data.stickyRouteProbe);
    return Boolean(
      marker &&
      this.registryAuthorizesFutureStickyProbe(
        registry,
        data,
        jobId,
        scheduleFingerprint,
        marker,
      ) &&
      marker.scheduledFor === data.scheduledFor &&
      marker.sessionKey === data.sessionKey &&
      marker.scheduleFingerprint === scheduleFingerprint,
    );
  }

  private registryMatchesFutureTransition(
    registry: NightModeScheduledJobRegistryRow | null | undefined,
    job: NightModeTransitionJob,
    jobId: string,
    scheduleFingerprint: string,
  ): registry is NightModeScheduledJobRegistryRow & { created_at: Date } {
    const scheduledForMs = Date.parse(job.scheduledFor);
    return Boolean(
      registry &&
      registry.created_at instanceof Date &&
      Number.isFinite(registry.created_at.getTime()) &&
      Number.isFinite(scheduledForMs) &&
      registry.created_at.getTime() < scheduledForMs &&
      registry.job_id === jobId &&
      registry.transition === job.transition &&
      registry.session_key === job.sessionKey &&
      registry.scheduled_for.getTime() === scheduledForMs &&
      registry.schedule_fingerprint === scheduleFingerprint &&
      registry.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
    );
  }

  private registryAuthorizesFutureStickyProbe(
    registry: NightModeScheduledJobRegistryRow | null | undefined,
    job: NightModeTransitionJob,
    jobId: string,
    scheduleFingerprint: string,
    marker: NightModeStickyRouteProbe,
  ): boolean {
    return Boolean(
      this.registryMatchesFutureTransition(registry, job, jobId, scheduleFingerprint) &&
      registry.created_at.getTime() <= Date.parse(marker.authorizedAt),
    );
  }

  private normalizeChatIds(chatIds: readonly string[]): string[] {
    return Array.from(new Set(chatIds.map((item) => item.trim()).filter(Boolean)));
  }

  private async removeJob(
    job: { id?: string; remove(): Promise<void> },
    options: { strict?: boolean } = {},
  ): Promise<boolean> {
    try {
      await job.remove();
      return true;
    } catch (error: unknown) {
      this.logger.debug(
        {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to remove old night mode transition job',
      );
      if (options.strict === true && !this.isBullMqMissingJobRemovalError(error, job.id)) {
        throw error;
      }
      return this.isBullMqMissingJobRemovalError(error, job.id);
    }
  }

  private async retryFailedTransitionJob(
    job: { id?: string; retry?: () => Promise<void> },
    expectedJobId: string,
  ): Promise<void> {
    if (job.id !== expectedJobId || typeof job.retry !== 'function') {
      throw new Error(`Night mode failed job cannot be retried in place (${expectedJobId})`);
    }
    await job.retry();
  }

  private async promoteTransitionJob(
    job: {
      data?: NightModeTransitionJob;
      updateData?: (data: NightModeTransitionJob) => Promise<void>;
    },
    params: {
      jobId: string;
      fingerprint: string;
      stickyRouteProbe?: NightModeStickyRouteProbe;
    },
  ): Promise<void> {
    if (!job.data || typeof job.updateData !== 'function') {
      throw new Error(`Night mode future job cannot be promoted in place (${params.jobId})`);
    }
    const data = { ...job.data };
    delete data.stickyRouteProbe;
    await job.updateData({
      ...data,
      transitionRuntimeVersion: NIGHT_MODE_TRANSITION_RUNTIME_VERSION,
      scheduleFingerprint: params.fingerprint,
      ...(params.stickyRouteProbe ? { stickyRouteProbe: params.stickyRouteProbe } : {}),
    });
  }

  private isBullMqMissingJobRemovalError(error: unknown, jobId: string | undefined): boolean {
    return (
      typeof jobId === 'string' &&
      error instanceof Error &&
      error.message === `Missing key for job ${jobId}. removeJob`
    );
  }

  private readNonNegativeConfigInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= 0) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }
}
