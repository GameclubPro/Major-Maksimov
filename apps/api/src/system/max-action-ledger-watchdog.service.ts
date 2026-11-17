import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxActionLedgerWatchdogSnapshot } from '@maxim/contracts/system';
import type { Job, JobState, Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { MaxActionLedgerStatus, type Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsAction, roleRunsAdmin } from '../runtime/app-role';
import { RedisCounterService } from '../moderation/redis-counter.service';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_LEGACY_QUEUE,
  resolveMaxActionQueueName,
} from '../max/max-action.queue';
import { isMaxActionChannelSuggestionPublicationLedger } from '../max/max-action-ledger-keys';
import type {
  MaxActionJob,
  MaxActionLedgerContext,
  MaxActionRoutingMetadata,
} from '../max/max-client.service';
import { hasMaxInsufficientRightsMessage } from '../max/max-member-error.util';
import { MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE } from '../max/max-action-pre-dispatch-guard';

const WATCHDOG_LOCK_KEY = 'system:max-action-ledger:watchdog:lock:v1';
const WATCHDOG_STATUS_KEY = 'system:max-action-ledger:watchdog:status:v1';
const WATCHDOG_CURSOR_KEY = 'system:max-action-ledger:watchdog:cursor:v1';
const WATCHDOG_STATUS_TTL_SEC = 7 * 24 * 60 * 60;
const WATCHDOG_STALE_AFTER_MS = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const WATCHDOG_STARTUP_DELAY_MS = 10_000;
const WATCHDOG_LOCK_TTL_MS = 2 * 60_000;
const WATCHDOG_BATCH_SIZE = 100;
const WATCHDOG_MAX_ROWS_PER_RUN = 1_000;
const WATCHDOG_RETRY_RECOVERY_MAX_AGE_MS = 30 * 60_000;
const DEFAULT_MAX_ACTION_FAILED_RETENTION_AGE_SEC = 7 * 24 * 60 * 60;
const DEFAULT_MAX_ACTION_FAILED_RETENTION_COUNT = 1_000;

const LIVE_QUEUE_STATES: ReadonlySet<JobState | 'unknown'> = new Set([
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

const AMBIGUOUS_CAPABLE_ACTION_TYPES: ReadonlySet<string> = new Set([
  'KICK_MEMBER',
  'BAN_MEMBER',
  'TRY_UNBAN_MEMBER',
]);
const RECOVERABLE_MEMBER_ACTION_TYPES = new Set(['KICK_MEMBER', 'BAN_MEMBER', 'UNBAN_MEMBER']);
const RECOVERABLE_PRE_DISPATCH_ERROR_CODES: ReadonlySet<string> = new Set([
  'max_api_circuit_open',
  'max_api_internal_rate_limit',
]);

type RecoverableMemberActionType = 'KICK_MEMBER' | 'BAN_MEMBER' | 'UNBAN_MEMBER';

type WatchdogRunReason = 'startup' | 'scheduled' | 'manual';
type WatchdogRolloutMode = 'off' | 'shadow' | 'canary' | 'on';

type ActionJobObservation = {
  job: Job;
  state: JobState | 'unknown';
};

const LEDGER_CANDIDATE_SELECT = {
  id: true,
  jobId: true,
  chatId: true,
  actionType: true,
  status: true,
  ambiguous: true,
  terminal: true,
  attemptCount: true,
  firstAttemptAt: true,
  lastAttemptAt: true,
  dispatchToken: true,
  dispatchStartedAt: true,
  dispatchBotId: true,
  remoteMessageId: true,
  botId: true,
  messageId: true,
  userId: true,
  sourceTag: true,
  trafficClass: true,
  actionHealthLane: true,
  lastStatusCode: true,
  lastErrorCode: true,
  lastError: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MaxActionLedgerEntrySelect;

type LedgerCandidate = Prisma.MaxActionLedgerEntryGetPayload<{
  select: typeof LEDGER_CANDIDATE_SELECT;
}>;

type WatchdogScanCursor = Pick<LedgerCandidate, 'id' | 'updatedAt'>;

type DeferredBucket = { count: number; oldestAgeSec: number };
type DeferredBreakdown = Record<
  'waitingInQueue' | 'recentlyStarted' | 'ownedByPublication' | 'memberGuardRejected',
  DeferredBucket
>;

type WatchdogDiagnosticSnapshot = MaxActionLedgerWatchdogSnapshot & {
  lastDeferredByReason: DeferredBreakdown | null;
};

type WatchdogPersistentState = {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastRunReason: WatchdogRunReason | null;
  staleCount: number;
  staleEnqueuedCount: number;
  staleInProgressCount: number;
  staleRetryableCount: number;
  oldestStaleAgeSec: number;
  lastScannedCount: number;
  lastReconciledCount: number;
  lastQuarantinedCount: number;
  lastTerminalFailedCount: number;
  lastRecoveredSucceededCount: number;
  lastRequeuedCount: number;
  lastRetryOrphanTerminalizedCount: number;
  lastDeferredCount: number;
  lastDeferredByReason: DeferredBreakdown | null;
  lastConflictCount: number;
  lastShadowClassifiedCount: number;
  lastWouldQuarantineCount: number;
  lastWouldTerminalFailCount: number;
  lastWouldRecoverSucceededCount: number;
  lastWouldRequeueCount: number;
  lastScanTruncated: boolean;
};

type WatchdogRunSummary = Omit<
  WatchdogPersistentState,
  'lastRunAt' | 'lastSuccessAt' | 'lastError' | 'lastRunReason' | 'lastDeferredByReason'
> & { lastDeferredByReason: DeferredBreakdown };

const EMPTY_RUN_SUMMARY: Omit<WatchdogRunSummary, 'lastDeferredByReason'> = {
  staleCount: 0,
  staleEnqueuedCount: 0,
  staleInProgressCount: 0,
  staleRetryableCount: 0,
  oldestStaleAgeSec: 0,
  lastScannedCount: 0,
  lastReconciledCount: 0,
  lastQuarantinedCount: 0,
  lastTerminalFailedCount: 0,
  lastRecoveredSucceededCount: 0,
  lastRequeuedCount: 0,
  lastRetryOrphanTerminalizedCount: 0,
  lastDeferredCount: 0,
  lastConflictCount: 0,
  lastShadowClassifiedCount: 0,
  lastWouldQuarantineCount: 0,
  lastWouldTerminalFailCount: 0,
  lastWouldRecoverSucceededCount: 0,
  lastWouldRequeueCount: 0,
  lastScanTruncated: false,
};

@Injectable()
export class MaxActionLedgerWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxActionLedgerWatchdogService.name);
  private readonly activeOnThisRole = roleRunsAdmin(getAppRole()) || roleRunsAction(getAppRole());
  private readonly rolloutMode: WatchdogRolloutMode;
  private readonly canaryPercent: number;
  private readonly canaryEntityIds: ReadonlySet<string>;
  private readonly actionFailedJobRetention: { age: number; count: number };
  private readonly state: WatchdogPersistentState = {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastRunReason: null,
    ...EMPTY_RUN_SUMMARY,
    lastDeferredByReason: null,
  };
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisCounter: RedisCounterService,
    @Optional() @InjectQueue(MAX_ACTION_LEGACY_QUEUE) private readonly actionQueue?: Queue,
    @Optional()
    @InjectQueue(MAX_ACTION_CRITICAL_QUEUE)
    private readonly criticalActionQueue?: Queue,
    @Optional()
    @InjectQueue(MAX_ACTION_INTERACTIVE_QUEUE)
    private readonly interactiveActionQueue?: Queue,
    @Optional()
    @InjectQueue(MAX_ACTION_BACKGROUND_QUEUE)
    private readonly backgroundActionQueue?: Queue,
    @Optional() configService?: ConfigService,
  ) {
    this.rolloutMode = this.normalizeRolloutMode(
      configService?.get('MAX_ACTION_LEDGER_WATCHDOG_MODE'),
    );
    this.canaryPercent = this.normalizeCanaryPercent(
      configService?.get('MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT'),
    );
    this.canaryEntityIds = this.parseCanaryEntityIds(
      configService?.get('MAX_ACTION_LEDGER_WATCHDOG_CANARY_ENTITY_IDS'),
    );
    this.actionFailedJobRetention = {
      age: this.normalizePositiveInteger(
        configService?.get('MAX_ACTION_FAILED_RETENTION_AGE_SEC'),
        DEFAULT_MAX_ACTION_FAILED_RETENTION_AGE_SEC,
      ),
      count: this.normalizePositiveInteger(
        configService?.get('MAX_ACTION_FAILED_RETENTION_COUNT'),
        DEFAULT_MAX_ACTION_FAILED_RETENTION_COUNT,
      ),
    };
  }

  onModuleInit(): void {
    if (!this.activeOnThisRole || this.rolloutMode === 'off') {
      return;
    }

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.runNow('startup');
    }, WATCHDOG_STARTUP_DELAY_MS);
    this.startupTimer.unref?.();

    this.timer = setInterval(() => {
      void this.runNow('scheduled');
    }, WATCHDOG_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runNow(reason: WatchdogRunReason = 'manual'): Promise<void> {
    if (!this.activeOnThisRole || this.rolloutMode === 'off' || this.inFlight) {
      return;
    }

    if (this.getActionQueues().length === 0) {
      await this.recordRunError(reason, new Error('MAX action queues are unavailable'));
      return;
    }

    let lockToken: string | null = null;
    try {
      lockToken = await this.redisCounter.acquireLock(WATCHDOG_LOCK_KEY, WATCHDOG_LOCK_TTL_MS);
    } catch (error: unknown) {
      await this.recordRunError(reason, error);
      return;
    }
    if (!lockToken) {
      return;
    }

    this.inFlight = true;
    this.state.lastRunAt = new Date().toISOString();
    this.state.lastRunReason = reason;
    try {
      const summary = await this.reconcileStaleEntries(lockToken);
      Object.assign(this.state, summary, {
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
      });
      await this.persistStateBestEffort();

      if (summary.lastReconciledCount > 0 || summary.lastShadowClassifiedCount > 0) {
        this.logger.warn(
          {
            reason,
            rolloutMode: this.rolloutMode,
            stale: summary.staleCount,
            reconciled: summary.lastReconciledCount,
            quarantined: summary.lastQuarantinedCount,
            terminalFailed: summary.lastTerminalFailedCount,
            recoveredSucceeded: summary.lastRecoveredSucceededCount,
            requeued: summary.lastRequeuedCount,
            retryOrphanTerminalized: summary.lastRetryOrphanTerminalizedCount,
            shadowClassified: summary.lastShadowClassifiedCount,
            wouldQuarantine: summary.lastWouldQuarantineCount,
            wouldTerminalFail: summary.lastWouldTerminalFailCount,
            wouldRecoverSucceeded: summary.lastWouldRecoverSucceededCount,
            wouldRequeue: summary.lastWouldRequeueCount,
            deferred: summary.lastDeferredCount,
          },
          summary.lastReconciledCount > 0
            ? 'Reconciled stale MAX action ledger entries without requeueing actions'
            : 'Classified stale MAX action ledger entries in shadow mode without database mutations',
        );
      }
    } catch (error: unknown) {
      await this.recordRunError(reason, error);
    } finally {
      this.inFlight = false;
      await this.redisCounter.releaseLock(WATCHDOG_LOCK_KEY, lockToken).catch((error: unknown) => {
        this.logger.warn(
          { err: this.errorMessage(error) },
          'Failed to release MAX action ledger watchdog lock',
        );
      });
    }
  }

  async getSnapshot(): Promise<WatchdogDiagnosticSnapshot> {
    const persisted = await this.readPersistedStateBestEffort();
    const state = persisted ?? this.state;
    return {
      enabled: this.rolloutMode !== 'off',
      activeOnThisRole: this.activeOnThisRole,
      mode: this.rolloutMode,
      canaryPercent: this.canaryPercent,
      canaryEntityIds: Array.from(this.canaryEntityIds).sort(),
      staleAfterSec: WATCHDOG_STALE_AFTER_MS / 1_000,
      intervalSec: WATCHDOG_INTERVAL_MS / 1_000,
      ...state,
      generatedAt: new Date().toISOString(),
    };
  }

  private async reconcileStaleEntries(lockToken: string): Promise<WatchdogRunSummary> {
    const cutoff = new Date(Date.now() - WATCHDOG_STALE_AFTER_MS);
    const summary: WatchdogRunSummary = {
      ...EMPTY_RUN_SUMMARY,
      lastDeferredByReason: {
        waitingInQueue: { count: 0, oldestAgeSec: 0 },
        recentlyStarted: { count: 0, oldestAgeSec: 0 },
        ownedByPublication: { count: 0, oldestAgeSec: 0 },
        memberGuardRejected: { count: 0, oldestAgeSec: 0 },
      },
    };
    let after = await this.readScanCursor();
    let reachedEnd = false;

    while (summary.lastScannedCount < WATCHDOG_MAX_ROWS_PER_RUN) {
      const take = Math.min(
        WATCHDOG_BATCH_SIZE,
        WATCHDOG_MAX_ROWS_PER_RUN - summary.lastScannedCount,
      );
      const rows: LedgerCandidate[] = await this.prisma.maxActionLedgerEntry.findMany({
        where: {
          terminal: false,
          status: {
            in: [
              MaxActionLedgerStatus.ENQUEUED,
              MaxActionLedgerStatus.IN_PROGRESS,
              MaxActionLedgerStatus.FAILED_RETRYABLE,
            ],
          },
          updatedAt: {
            lte: cutoff,
          },
          ...(after
            ? {
                OR: [
                  { updatedAt: { gt: after.updatedAt, lte: cutoff } },
                  { updatedAt: after.updatedAt, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take,
        select: LEDGER_CANDIDATE_SELECT,
      });
      if (rows.length === 0) {
        reachedEnd = true;
        break;
      }

      for (const row of rows) {
        summary.lastScannedCount += 1;
        await this.reconcileCandidate(row, cutoff, summary);
      }

      const last: LedgerCandidate = rows.at(-1)!;
      after = { id: last.id, updatedAt: last.updatedAt };
      if (rows.length < take) {
        reachedEnd = true;
        break;
      }

      const lockRenewed = await this.redisCounter.renewLock(
        WATCHDOG_LOCK_KEY,
        lockToken,
        WATCHDOG_LOCK_TTL_MS,
      );
      if (!lockRenewed) {
        throw new Error('MAX action ledger watchdog lost its distributed lock');
      }
    }

    summary.lastScanTruncated = summary.lastScannedCount >= WATCHDOG_MAX_ROWS_PER_RUN;
    await this.persistScanCursor(reachedEnd ? null : after);
    return summary;
  }

  private observeStaleCandidate(summary: WatchdogRunSummary, row: LedgerCandidate): void {
    summary.staleCount += 1;
    if (row.status === MaxActionLedgerStatus.ENQUEUED) {
      summary.staleEnqueuedCount += 1;
    } else if (row.status === MaxActionLedgerStatus.IN_PROGRESS) {
      summary.staleInProgressCount += 1;
    } else {
      summary.staleRetryableCount += 1;
    }
    summary.oldestStaleAgeSec = Math.max(
      summary.oldestStaleAgeSec,
      Math.max(0, (Date.now() - row.updatedAt.getTime()) / 1_000),
    );
  }

  private observeDeferredCandidate(
    summary: WatchdogRunSummary,
    row: LedgerCandidate,
    reason: keyof DeferredBreakdown,
  ): void {
    summary.lastDeferredCount += 1;
    const bucket = summary.lastDeferredByReason[reason];
    bucket.count += 1;
    bucket.oldestAgeSec = Math.max(bucket.oldestAgeSec, (Date.now() - row.updatedAt.getTime()) / 1_000);
  }

  private async reconcileCandidate(
    row: LedgerCandidate,
    cutoff: Date,
    summary: WatchdogRunSummary,
  ): Promise<void> {
    const observations = await this.findActionJobObservations(row.jobId);

    if (row.actionType === 'SEND_MESSAGE') {
      await this.reconcileSendCandidate(row, observations, cutoff, summary);
      return;
    }

    if (observations.some(({ state }) => LIVE_QUEUE_STATES.has(state))) {
      this.observeDeferredCandidate(summary, row, 'waitingInQueue');
      return;
    }

    if (
      observations.some(({ job, state }) => state === 'active' && this.jobStartedAfter(job, cutoff))
    ) {
      this.observeDeferredCandidate(summary, row, 'recentlyStarted');
      return;
    }

    if (observations.length > 0 && observations.every(({ state }) => state === 'completed')) {
      this.observeStaleCandidate(summary, row);
      await this.applyOutcome(row, MaxActionLedgerStatus.SUCCEEDED, summary, {
        ambiguous: false,
        errorCode: null,
        error: null,
        outcome: 'succeeded',
      });
      return;
    }

    if (this.shouldDeferFinalMemberGuardFailure(row, observations)) {
      this.observeDeferredCandidate(summary, row, 'memberGuardRejected');
      return;
    }

    this.observeStaleCandidate(summary, row);
    if (row.status === MaxActionLedgerStatus.FAILED_RETRYABLE) {
      if (this.isIntrinsicallyTerminalRetryableFailure(row)) {
        await this.applyOutcome(row, MaxActionLedgerStatus.FAILED_TERMINAL, summary, {
          ambiguous: false,
          errorCode: 'ledger.watchdog.retry_orphan_non_retryable',
          error: `Retryable ${row.actionType} ledger entry has a definitive non-retryable outcome; no action was requeued. Previous error: ${row.lastError ?? 'unknown'}`,
          outcome: 'terminal_failed',
          retryOrphanTerminalized: true,
        });
        return;
      }

      if (this.isRecoverablePreDispatchMemberFailure(row, observations)) {
        if (Date.now() - row.updatedAt.getTime() > WATCHDOG_RETRY_RECOVERY_MAX_AGE_MS) {
          await this.applyOutcome(row, MaxActionLedgerStatus.FAILED_TERMINAL, summary, {
            ambiguous: false,
            errorCode: 'ledger.watchdog.retry_orphan_expired',
            error: `Pre-dispatch ${row.actionType} retry orphan exceeded the bounded recovery horizon and was not requeued.`,
            outcome: 'terminal_failed',
            retryOrphanTerminalized: true,
          });
          return;
        }

        await this.requeueRetryableMemberAction(row, observations, summary);
        return;
      }
    }

    const mayHaveStarted = this.mayHaveStarted(row, observations);
    if (mayHaveStarted && AMBIGUOUS_CAPABLE_ACTION_TYPES.has(row.actionType)) {
      await this.applyOutcome(row, MaxActionLedgerStatus.AMBIGUOUS, summary, {
        ambiguous: true,
        errorCode: 'ledger.watchdog.ambiguous',
        error: `MAX ${row.actionType} outcome is unknown after stale worker dispatch; BullMQ states ${this.formatJobStates(observations)}. Manual review is required before retry.`,
        outcome: 'quarantined',
      });
      return;
    }

    await this.applyOutcome(row, MaxActionLedgerStatus.FAILED_TERMINAL, summary, {
      ambiguous: false,
      errorCode: mayHaveStarted
        ? 'ledger.watchdog.unconfirmed_safe_action'
        : 'ledger.watchdog.pre_dispatch_orphan',
      error: mayHaveStarted
        ? `Stale ${row.actionType} ledger entry has no confirmed BullMQ outcome; no action was requeued.`
        : `Pre-dispatch ${row.actionType} ledger entry has no BullMQ job or attempt markers; no action was requeued.`,
      outcome: 'terminal_failed',
      retryOrphanTerminalized: row.status === MaxActionLedgerStatus.FAILED_RETRYABLE,
    });
  }

  private async reconcileSendCandidate(
    row: LedgerCandidate,
    observations: readonly ActionJobObservation[],
    cutoff: Date,
    summary: WatchdogRunSummary,
  ): Promise<void> {
    if (row.remoteMessageId) {
      this.observeStaleCandidate(summary, row);
      await this.applyOutcome(row, MaxActionLedgerStatus.SUCCEEDED, summary, {
        ambiguous: false,
        errorCode: null,
        error: null,
        outcome: 'succeeded',
      });
      return;
    }

    if (row.dispatchToken || row.dispatchStartedAt || row.dispatchBotId) {
      this.observeStaleCandidate(summary, row);
      await this.applyOutcome(row, MaxActionLedgerStatus.AMBIGUOUS, summary, {
        ambiguous: true,
        errorCode: 'ledger.watchdog.ambiguous',
        error: `MAX SEND_MESSAGE outcome is unknown after a retained dispatch fence; BullMQ states ${this.formatJobStates(observations)}. Manual review is required before retry.`,
        outcome: 'quarantined',
      });
      return;
    }

    if (
      isMaxActionChannelSuggestionPublicationLedger({
        jobId: row.jobId,
        actionType: row.actionType,
        sourceTag: row.sourceTag,
      })
    ) {
      this.observeDeferredCandidate(summary, row, 'ownedByPublication');
      return;
    }

    if (observations.some(({ state }) => LIVE_QUEUE_STATES.has(state))) {
      this.observeDeferredCandidate(summary, row, 'waitingInQueue');
      return;
    }

    if (
      observations.some(({ job, state }) => state === 'active' && this.jobStartedAfter(job, cutoff))
    ) {
      this.observeDeferredCandidate(summary, row, 'recentlyStarted');
      return;
    }

    this.observeStaleCandidate(summary, row);
    const completedWithoutRemoteId =
      observations.length > 0 && observations.every(({ state }) => state === 'completed');
    await this.applyOutcome(row, MaxActionLedgerStatus.FAILED_TERMINAL, summary, {
      ambiguous: false,
      errorCode: completedWithoutRemoteId
        ? 'ledger.watchdog.send_completed_without_remote_id'
        : 'ledger.watchdog.pre_dispatch_orphan',
      error: completedWithoutRemoteId
        ? 'BullMQ completed MAX SEND_MESSAGE without a durable remote message id or dispatch fence; the action was not marked successful and was not requeued.'
        : `Pre-dispatch MAX SEND_MESSAGE ledger entry has no retained dispatch fence; BullMQ states ${this.formatJobStates(observations)}. The action was not requeued.`,
      outcome: 'terminal_failed',
      retryOrphanTerminalized: row.status === MaxActionLedgerStatus.FAILED_RETRYABLE,
    });
  }

  // FLAG: The stable guard code retains the writer's no-dispatch classification, not its cause
  // or current authority. Preserve it without ledger mutation, retry or inferred completion.
  private shouldDeferFinalMemberGuardFailure(
    row: LedgerCandidate,
    observations: readonly ActionJobObservation[],
  ): boolean {
    if (
      (row.actionType !== 'BAN_MEMBER' && row.actionType !== 'KICK_MEMBER') ||
      row.status !== MaxActionLedgerStatus.FAILED_RETRYABLE ||
      row.ambiguous !== false ||
      row.terminal !== false ||
      row.lastErrorCode !== MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE ||
      !row.botId?.trim() ||
      !row.userId?.trim() ||
      !row.chatId.trim() ||
      !row.jobId.trim() ||
      row.dispatchToken !== null ||
      row.dispatchStartedAt !== null ||
      row.dispatchBotId !== null ||
      row.remoteMessageId !== null
    ) {
      return false;
    }
    if (observations.length === 0) return true;
    if (observations.length !== 1) return false;
    const { job, state } = observations[0]!;
    const data = this.asRecord(job.data);
    return (
      state === 'failed' &&
      job.id === row.jobId &&
      data?.actionType === row.actionType &&
      data.chatId === row.chatId &&
      data.userId === row.userId &&
      data.botId === row.botId &&
      data.idempotencyKey === row.jobId
    );
  }

  // FLAG: Recovery is restricted to local pre-dispatch failures that prove MAX was not called.
  private isRecoverablePreDispatchMemberFailure(
    row: LedgerCandidate,
    observations: readonly ActionJobObservation[],
  ): row is LedgerCandidate & { actionType: RecoverableMemberActionType; userId: string } {
    return (
      RECOVERABLE_MEMBER_ACTION_TYPES.has(row.actionType) &&
      Boolean(row.userId?.trim()) &&
      Boolean(row.chatId.trim()) &&
      Boolean(row.jobId.trim()) &&
      (Boolean(row.botId?.trim()) ||
        this.readStringArray(this.asRecord(row.metadata)?.candidateBotIds).length > 0) &&
      RECOVERABLE_PRE_DISPATCH_ERROR_CODES.has(row.lastErrorCode ?? '') &&
      !row.dispatchToken &&
      !row.dispatchStartedAt &&
      !row.dispatchBotId &&
      !row.remoteMessageId &&
      observations.length <= 1 &&
      observations.every(({ state }) => state === 'failed')
    );
  }

  private isIntrinsicallyTerminalRetryableFailure(row: LedgerCandidate): boolean {
    const error = row.lastError?.toLowerCase() ?? '';
    const code = row.lastErrorCode?.toLowerCase() ?? '';
    if (row.lastStatusCode === 404 || code === 'chat.not.found') {
      return true;
    }
    if (
      row.lastStatusCode === 200 &&
      (error.includes('already deleted') ||
        error.includes('already been deleted') ||
        hasMaxInsufficientRightsMessage(error))
    ) {
      return true;
    }
    return row.actionType === 'SEND_MESSAGE' && error.includes('max upload payload is missing');
  }

  private async requeueRetryableMemberAction(
    row: LedgerCandidate & { actionType: RecoverableMemberActionType; userId: string },
    observations: readonly ActionJobObservation[],
    summary: WatchdogRunSummary,
  ): Promise<void> {
    if (observations.length === 1 && !this.retainedJobMatchesCandidate(observations[0]!.job, row)) {
      await this.applyOutcome(row, MaxActionLedgerStatus.FAILED_TERMINAL, summary, {
        ambiguous: false,
        errorCode: 'ledger.watchdog.retry_job_mismatch',
        error: `Retained BullMQ job does not match retryable ${row.actionType} ledger ownership; no action was requeued.`,
        outcome: 'terminal_failed',
        retryOrphanTerminalized: true,
      });
      return;
    }

    if (!this.shouldEnforceOutcome(row)) {
      summary.lastShadowClassifiedCount += 1;
      summary.lastWouldRequeueCount += 1;
      return;
    }

    if (observations.length === 1) {
      const retainedJob = observations[0]!.job;
      await retainedJob.retry();
    } else {
      const queue = this.resolveActionQueue(row);
      if (!queue) {
        throw new Error(`MAX action queue is unavailable for retryable ${row.actionType}`);
      }
      await queue.add('execute-max-action', this.reconstructMemberActionJob(row), {
        jobId: row.jobId,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: this.actionFailedJobRetention,
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
    }

    // FLAG: BullMQ ownership precedes ledger bookkeeping; worker execution is guarded by ledger CAS.
    const requeuedAt = new Date();
    const result = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        id: row.id,
        status: MaxActionLedgerStatus.FAILED_RETRYABLE,
        terminal: false,
        updatedAt: row.updatedAt,
      },
      data: {
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
        enqueuedAt: requeuedAt,
        completedAt: null,
        lastStatusCode: null,
        lastErrorCode: null,
        lastError: null,
      },
    });
    if (result.count === 0) {
      summary.lastConflictCount += 1;
      return;
    }

    summary.lastReconciledCount += 1;
    summary.lastRequeuedCount += 1;
  }

  private retainedJobMatchesCandidate(
    job: Job,
    row: LedgerCandidate & { actionType: RecoverableMemberActionType; userId: string },
  ): boolean {
    const data = this.asRecord(job.data);
    return (
      data?.actionType === row.actionType &&
      data.chatId === row.chatId &&
      data.userId === row.userId &&
      data.idempotencyKey === row.jobId
    );
  }

  private reconstructMemberActionJob(
    row: LedgerCandidate & { actionType: RecoverableMemberActionType; userId: string },
  ): MaxActionJob {
    const metadata = this.asRecord(row.metadata);
    const candidateBotIds = this.readStringArray(metadata?.candidateBotIds);
    const attemptedBotIds = this.readStringArray(metadata?.attemptedBotIds);
    const parsedRouting = this.readRoutingMetadata(metadata?.routing);
    const routing = parsedRouting?.purpose === 'moderation_action' ? parsedRouting : null;
    const ledgerContext = this.asRecord(metadata?.ledgerContext) as MaxActionLedgerContext | null;
    const ignoreFailureMetricStatuses = this.readIntegerArray(
      metadata?.ignoreFailureMetricStatuses,
    );
    const createdAt = this.readString(metadata?.createdAt) ?? row.createdAt.toISOString();
    const scheduledFor = this.readString(metadata?.scheduledFor);

    return {
      actionType: row.actionType,
      chatId: row.chatId,
      userId: row.userId,
      ...(row.botId ? { botId: row.botId } : {}),
      ...(candidateBotIds.length > 0 ? { candidateBotIds } : {}),
      ...(attemptedBotIds.length > 0 ? { attemptedBotIds } : {}),
      ...(routing ? { routing } : {}),
      ...(this.isTrafficClass(row.trafficClass) ? { trafficClass: row.trafficClass } : {}),
      ...(this.isTrafficClass(row.actionHealthLane)
        ? { actionHealthLane: row.actionHealthLane }
        : {}),
      ...(row.sourceTag ? { sourceTag: row.sourceTag } : {}),
      ...(ignoreFailureMetricStatuses.length > 0 ? { ignoreFailureMetricStatuses } : {}),
      ...(ledgerContext ? { ledgerContext } : {}),
      attempt: Math.max(1, row.attemptCount + 1),
      idempotencyKey: row.jobId,
      createdAt,
      ...(scheduledFor ? { scheduledFor } : {}),
    };
  }

  private mayHaveStarted(
    row: LedgerCandidate,
    observations: readonly ActionJobObservation[],
  ): boolean {
    return (
      row.status === MaxActionLedgerStatus.IN_PROGRESS ||
      row.attemptCount > 0 ||
      row.firstAttemptAt !== null ||
      row.lastAttemptAt !== null ||
      observations.some(
        ({ job, state }) =>
          state === 'active' ||
          state === 'failed' ||
          state === 'completed' ||
          (typeof job.processedOn === 'number' && Number.isFinite(job.processedOn)) ||
          (typeof job.attemptsMade === 'number' && job.attemptsMade > 0),
      )
    );
  }

  private jobStartedAfter(job: Job | undefined, cutoff: Date): boolean {
    return (
      typeof job?.processedOn === 'number' &&
      Number.isFinite(job.processedOn) &&
      job.processedOn > cutoff.getTime()
    );
  }

  private getActionQueues(): Queue[] {
    return Array.from(
      new Set(
        [
          this.criticalActionQueue,
          this.interactiveActionQueue,
          this.backgroundActionQueue,
          this.actionQueue,
        ].filter((queue): queue is Queue => Boolean(queue)),
      ),
    );
  }

  private resolveActionQueue(
    row: Pick<LedgerCandidate, 'actionType' | 'trafficClass'>,
  ): Queue<MaxActionJob> | undefined {
    const queueName = resolveMaxActionQueueName(row);
    const laneQueue = (() => {
      switch (queueName) {
        case MAX_ACTION_CRITICAL_QUEUE:
          return this.criticalActionQueue;
        case MAX_ACTION_BACKGROUND_QUEUE:
          return this.backgroundActionQueue;
        case MAX_ACTION_INTERACTIVE_QUEUE:
        default:
          return this.interactiveActionQueue;
      }
    })();
    return (laneQueue ?? this.actionQueue) as Queue<MaxActionJob> | undefined;
  }

  private async findActionJobObservations(jobId: string): Promise<ActionJobObservation[]> {
    const jobs = await Promise.all(this.getActionQueues().map((queue) => queue.getJob(jobId)));
    const existingJobs = jobs.filter((job): job is Job => Boolean(job));
    return Promise.all(
      existingJobs.map(async (job) => ({
        job,
        state: await job.getState(),
      })),
    );
  }

  private formatJobStates(observations: readonly ActionJobObservation[]): string {
    return observations.length > 0
      ? observations
          .map(({ state }) => state)
          .sort()
          .join(',')
      : 'missing';
  }

  private async applyOutcome(
    row: LedgerCandidate,
    status: MaxActionLedgerStatus,
    summary: WatchdogRunSummary,
    options: {
      ambiguous: boolean;
      errorCode: string | null;
      error: string | null;
      outcome: 'succeeded' | 'quarantined' | 'terminal_failed';
      retryOrphanTerminalized?: boolean;
    },
  ): Promise<void> {
    if (!this.shouldEnforceOutcome(row)) {
      summary.lastShadowClassifiedCount += 1;
      if (options.outcome === 'quarantined') {
        summary.lastWouldQuarantineCount += 1;
      } else if (options.outcome === 'terminal_failed') {
        summary.lastWouldTerminalFailCount += 1;
      } else {
        summary.lastWouldRecoverSucceededCount += 1;
      }
      return;
    }

    const result = await this.prisma.maxActionLedgerEntry.updateMany({
      where: {
        id: row.id,
        status: row.status,
        terminal: false,
        updatedAt: row.updatedAt,
      },
      data: {
        status,
        ambiguous: options.ambiguous,
        terminal: true,
        completedAt: new Date(),
        lastErrorCode: options.errorCode,
        lastError: options.error,
      },
    });
    if (result.count === 0) {
      summary.lastConflictCount += 1;
      return;
    }

    summary.lastReconciledCount += 1;
    if (options.outcome === 'quarantined') {
      summary.lastQuarantinedCount += 1;
    } else if (options.outcome === 'terminal_failed') {
      summary.lastTerminalFailedCount += 1;
      if (options.retryOrphanTerminalized) {
        summary.lastRetryOrphanTerminalizedCount += 1;
      }
    } else {
      summary.lastRecoveredSucceededCount += 1;
    }
  }

  private shouldEnforceOutcome(row: LedgerCandidate): boolean {
    if (this.rolloutMode === 'on') {
      return true;
    }
    if (this.rolloutMode !== 'canary' || this.canaryPercent <= 0) {
      return false;
    }

    const explicitlyAllowed =
      this.canaryEntityIds.has('*') ||
      this.canaryEntityIds.has(row.id) ||
      this.canaryEntityIds.has(row.jobId) ||
      this.canaryEntityIds.has(row.chatId);
    if (!explicitlyAllowed) {
      return false;
    }
    if (this.canaryPercent >= 100) {
      return true;
    }

    const bucket =
      createHash('sha256').update(`${row.id}:${row.jobId}:${row.chatId}`).digest().readUInt32BE(0) %
      10_000;
    return bucket < Math.round(this.canaryPercent * 100);
  }

  private normalizeRolloutMode(value: unknown): WatchdogRolloutMode {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return normalized === 'off' ||
      normalized === 'shadow' ||
      normalized === 'canary' ||
      normalized === 'on'
      ? normalized
      : 'shadow';
  }

  private normalizeCanaryPercent(value: unknown): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, Math.min(100, numericValue)) : 1;
  }

  private normalizePositiveInteger(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? Math.trunc(numericValue) : fallback;
  }

  private isTrafficClass(value: unknown): value is 'critical' | 'interactive' | 'background' {
    return value === 'critical' || value === 'interactive' || value === 'background';
  }

  private readRoutingMetadata(value: unknown): MaxActionRoutingMetadata | null {
    const routing = this.asRecord(value);
    if (
      routing?.purpose !== 'send_message' &&
      routing?.purpose !== 'moderation_action' &&
      routing?.purpose !== 'channel_poll'
    ) {
      return null;
    }

    const action =
      routing.action === 'delete_message' || routing.action === 'moderate_member'
        ? routing.action
        : undefined;
    const routingVersion =
      typeof routing.routingVersion === 'number' && Number.isFinite(routing.routingVersion)
        ? Math.trunc(routing.routingVersion)
        : undefined;
    const sendRouteHalfOpenProbe =
      routing.sendRouteHalfOpenProbe === 'publication_exact_verification'
        ? routing.sendRouteHalfOpenProbe
        : undefined;
    return {
      purpose: routing.purpose,
      ...(this.readString(routing.primaryBotId)
        ? { primaryBotId: this.readString(routing.primaryBotId) }
        : {}),
      ...(this.readString(routing.reason) ? { reason: this.readString(routing.reason) } : {}),
      ...(action ? { action } : {}),
      ...(routingVersion !== undefined ? { routingVersion } : {}),
      ...(sendRouteHalfOpenProbe ? { sendRouteHalfOpenProbe } : {}),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private readStringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? Array.from(
          new Set(
            value
              .map((item) => this.readString(item))
              .filter((item): item is string => Boolean(item)),
          ),
        )
      : [];
  }

  private readIntegerArray(value: unknown): number[] {
    return Array.isArray(value)
      ? Array.from(
          new Set(
            value.filter(
              (item): item is number => typeof item === 'number' && Number.isInteger(item),
            ),
          ),
        )
      : [];
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

  private async recordRunError(reason: WatchdogRunReason, error: unknown): Promise<void> {
    this.state.lastRunAt = new Date().toISOString();
    this.state.lastRunReason = reason;
    this.state.lastError = this.truncate(this.errorMessage(error));
    await this.persistStateBestEffort();
    this.logger.warn(
      {
        reason,
        err: this.state.lastError,
      },
      'Failed to reconcile stale MAX action ledger entries',
    );
  }

  private async readPersistedStateBestEffort(): Promise<WatchdogPersistentState | null> {
    try {
      const raw = await this.redisCounter.getString(WATCHDOG_STATUS_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Partial<WatchdogPersistentState>;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return {
        ...this.state,
        ...parsed,
        lastDeferredByReason: parsed.lastDeferredByReason ?? null,
      };
    } catch {
      return null;
    }
  }

  private async readScanCursor(): Promise<WatchdogScanCursor | null> {
    const raw = await this.redisCounter.getString(WATCHDOG_CURSOR_KEY);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as { id?: unknown; updatedAt?: unknown } | null;
      const id = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
      const updatedAt =
        typeof parsed?.updatedAt === 'string' ? new Date(parsed.updatedAt) : new Date(Number.NaN);
      if (!id || !Number.isFinite(updatedAt.getTime())) {
        return null;
      }
      return { id, updatedAt };
    } catch {
      return null;
    }
  }

  private async persistScanCursor(cursor: WatchdogScanCursor | null): Promise<void> {
    await this.redisCounter.setStringWithTtl(
      WATCHDOG_CURSOR_KEY,
      JSON.stringify(
        cursor
          ? {
              id: cursor.id,
              updatedAt: cursor.updatedAt.toISOString(),
            }
          : null,
      ),
      WATCHDOG_STATUS_TTL_SEC,
    );
  }

  private async persistStateBestEffort(): Promise<void> {
    try {
      await this.redisCounter.setStringWithTtl(
        WATCHDOG_STATUS_KEY,
        JSON.stringify(this.state),
        WATCHDOG_STATUS_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.warn(
        { err: this.errorMessage(error) },
        'Failed to persist MAX action ledger watchdog status',
      );
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : String(error).trim();
  }

  private truncate(value: string, maxLength = 2_000): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }
}
