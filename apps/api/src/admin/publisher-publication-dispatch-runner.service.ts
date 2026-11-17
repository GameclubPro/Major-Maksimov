import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherBackgroundWorkCoordinatorService } from '../publisher/publisher-background-work-coordinator.service';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublicationScheduleMode } from '../prisma/prisma-client';
import {
  selectNextPendingPublisherPublicationDeadline,
  type PendingPublisherPublicationDeadline,
} from './admin-managed-broadcast-due-selection';
import { ManagedBroadcastService } from './managed-broadcast.service';

const PUBLISHER_PUBLICATION_POLL_INTERVAL_MS = 15_000;
const PUBLISHER_PUBLICATION_OVERDUE_REARM_MS = 250;
const PUBLISHER_PUBLICATION_WAKE_ERROR_LOG_INTERVAL_MS = 60_000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

type PublisherPublicationRunReason =
  | 'startup'
  | 'scheduled'
  | 'deadline_wakeup'
  | 'materialization_wakeup';

type PublisherPublicationVerificationBudget = Awaited<
  ReturnType<ManagedBroadcastService['processDueImmediatePublicationBroadcasts']>
>;

type PublisherPublicationImmediateWakeRequest = {
  publicationId: string;
  occurrenceId?: string;
  resolve: (budget: PublisherPublicationVerificationBudget) => void;
  reject: (error: unknown) => void;
};

type PublisherPublicationDeadlineScope = {
  publicationId: string;
  occurrenceId?: string;
};

type PublicationWakeLane = 'immediate' | 'deadline';
type PublicationWakeTimer = {
  timer: NodeJS.Timeout | null;
  key: string | null;
  atMs: number | null;
};

@Injectable()
export class PublisherPublicationDispatchRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherPublicationDispatchRunnerService.name);
  private readonly enabled = roleRunsPublisher(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private readonly wakeTimers: Record<PublicationWakeLane, PublicationWakeTimer> = {
    immediate: { timer: null, key: null, atMs: null },
    deadline: { timer: null, key: null, atMs: null },
  };
  private deadlineWakeRefreshInFlight: Promise<void> | null = null;
  private deadlineWakeRefreshGeneration = 0;
  private deadlineWakeRefreshCompletedGeneration = 0;
  private deadlineWakeErrorLogAtMs = 0;
  private immediateDrainInFlight: Promise<void> | null = null;
  private immediateGlobalWakeGeneration = 0;
  private immediateGlobalWakeCompletedGeneration = 0;
  private readonly immediateWakeRequests: PublisherPublicationImmediateWakeRequest[] = [];
  private deadlineInFlight: Promise<void> | null = null;
  private destroyed = false;

  constructor(
    private readonly managedBroadcastService: ManagedBroadcastService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled || !this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    this.destroyed = false;
    this.timer = setInterval(() => {
      void this.refreshDeadlineWakeup();
      void this.run('scheduled');
    }, PUBLISHER_PUBLICATION_POLL_INTERVAL_MS);
    this.timer.unref();
    void this.refreshDeadlineWakeup();
    void this.run('startup');
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearDeadlineWakeTimer();
    const shutdownError = new Error('Publisher publication dispatch runner is closing');
    for (const request of this.immediateWakeRequests.splice(0)) {
      request.reject(shutdownError);
    }
    const inFlight = [
      this.immediateDrainInFlight,
      this.deadlineInFlight,
      this.deadlineWakeRefreshInFlight,
    ].filter((run): run is Promise<void> => run !== null);
    await Promise.allSettled(inFlight);
  }

  notifyMaterializedWork(): void {
    if (!this.enabled || !this.runtimeBoundary.dispatchEnabled || this.destroyed) return;
    // FLAG: Scheduling wakes the existing executor; it never creates a second send owner.
    this.immediateGlobalWakeGeneration += 1;
    void this.ensureImmediateDrain('scheduled');
    void this.refreshDeadlineWakeup();
  }

  async wakeAfterPublicationMaterialization(
    publicationId: string,
    occurrenceId?: string,
  ): Promise<void> {
    if (!this.enabled || !this.runtimeBoundary.dispatchEnabled || this.destroyed) {
      return;
    }
    const verificationBudget = await this.enqueueTargetedImmediateWake(publicationId, occurrenceId);
    await this.refreshDeadlineWakeupForWake();
    if (this.destroyed) {
      return;
    }
    const schedule = await this.prisma.publicationSchedule.findUnique({
      where: { publicationId },
      select: { mode: true },
    });
    // FLAG: A NOW command has already completed its durable dispatch quantum. It must not hold
    // the sole wakeup worker while unrelated scheduled work waits for background maintenance.
    if (!schedule || schedule.mode === PublicationScheduleMode.NOW) return;
    while (!this.destroyed) {
      const activeDeadlineRun = this.deadlineInFlight;
      if (activeDeadlineRun) {
        await activeDeadlineRun;
        continue;
      }
      const jobDeadlineRun = this.startDeadlineRun(
        'materialization_wakeup',
        verificationBudget,
        true,
        { publicationId, occurrenceId },
      );
      if (!jobDeadlineRun) {
        continue;
      }
      await jobDeadlineRun;
      return;
    }
  }

  private async run(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.enabled || !this.runtimeBoundary.dispatchEnabled || this.destroyed) {
      return;
    }
    this.immediateGlobalWakeGeneration += 1;
    const existingDrain = this.immediateDrainInFlight;
    const drain = existingDrain ?? this.ensureImmediateDrain(reason);
    await drain;

    const deadlineRun = this.deadlineInFlight;
    if (deadlineRun) {
      // FLAG: The address-specific wake owns its logged failure and BullMQ retry.
      // A background tick observing the same pass only waits for it to settle.
      await Promise.allSettled([deadlineRun]);
    }
  }

  private enqueueTargetedImmediateWake(
    publicationId: string,
    occurrenceId?: string,
  ): Promise<PublisherPublicationVerificationBudget> {
    return new Promise<PublisherPublicationVerificationBudget>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('Publisher publication dispatch runner is closing'));
        return;
      }
      this.immediateWakeRequests.push({ publicationId, occurrenceId, resolve, reject });
      void this.ensureImmediateDrain('scheduled');
    });
  }

  private ensureImmediateDrain(reason: 'startup' | 'scheduled') {
    if (this.immediateDrainInFlight) {
      return this.immediateDrainInFlight;
    }
    const drain = this.drainImmediateRuns(reason).finally(async () => {
      if (this.immediateDrainInFlight === drain) {
        this.immediateDrainInFlight = null;
        if (
          !this.destroyed &&
          (this.immediateWakeRequests.length > 0 ||
            this.immediateGlobalWakeCompletedGeneration < this.immediateGlobalWakeGeneration)
        ) {
          await this.ensureImmediateDrain('scheduled');
        }
      }
    });
    this.immediateDrainInFlight = drain;
    return drain;
  }

  private async drainImmediateRuns(initialReason: 'startup' | 'scheduled'): Promise<void> {
    let reason = initialReason;
    while (
      !this.destroyed &&
      (this.immediateWakeRequests.length > 0 ||
        this.immediateGlobalWakeCompletedGeneration < this.immediateGlobalWakeGeneration)
    ) {
      const request = this.immediateWakeRequests.shift();
      if (request) {
        try {
          this.runtimeBoundary.assertDispatchEnabled();
          await this.identityAttestation.assertAttested();
          await this.dispatchHealth.assertDispatchAllowed();
          request.resolve(
            await this.managedBroadcastService.processTargetedImmediatePublicationBroadcasts(
              request.publicationId,
              request.occurrenceId,
            ),
          );
        } catch (error: unknown) {
          request.reject(error);
        }
        continue;
      }

      const generation = this.immediateGlobalWakeGeneration;
      let verificationBudget:
        | Awaited<ReturnType<ManagedBroadcastService['processDueImmediatePublicationBroadcasts']>>
        | undefined;
      try {
        if (!(await this.dispatchHealth.isGloballyPaused())) {
          await this.identityAttestation.assertAttested();
          verificationBudget =
            await this.managedBroadcastService.processDueImmediatePublicationBroadcasts();
        }
      } catch (error: unknown) {
        this.logFailure(reason, error);
      }

      if (verificationBudget && !this.destroyed) {
        void this.startDeadlineRun(reason, verificationBudget);
        void this.refreshDeadlineWakeup();
      }
      this.immediateGlobalWakeCompletedGeneration = generation;
      reason = 'scheduled';
    }
  }

  private startDeadlineRun(
    reason: PublisherPublicationRunReason,
    verificationBudget?: Awaited<
      ReturnType<ManagedBroadcastService['processDueImmediatePublicationBroadcasts']>
    >,
    propagateFailure = false,
    scope?: PublisherPublicationDeadlineScope,
  ): Promise<void> | null {
    if (this.destroyed || this.deadlineInFlight) {
      return null;
    }
    const run = this.runDeadline(reason, verificationBudget, propagateFailure, scope);
    this.deadlineInFlight = run;
    const clear = () => {
      if (this.deadlineInFlight === run) {
        this.deadlineInFlight = null;
      }
    };
    void run.then(clear, clear);
    return run;
  }

  private async runDeadline(
    reason: PublisherPublicationRunReason,
    verificationBudget?: Awaited<
      ReturnType<ManagedBroadcastService['processDueImmediatePublicationBroadcasts']>
    >,
    propagateFailure = false,
    scope?: PublisherPublicationDeadlineScope,
  ): Promise<void> {
    let completedSweep = false;
    try {
      await this.backgroundWork.runExclusive('publication_deadline', async () => {
        if (propagateFailure) {
          await this.dispatchHealth.assertDispatchAllowed();
        } else if (await this.dispatchHealth.isGloballyPaused()) {
          return;
        }
        await this.identityAttestation.assertAttested();
        if (scope) {
          await this.managedBroadcastService.processTargetedDeadlinePublicationBroadcasts(
            scope.publicationId,
            scope.occurrenceId,
            verificationBudget,
          );
        } else if (verificationBudget) {
          await this.managedBroadcastService.processDueDeadlinePublicationBroadcasts(
            undefined,
            verificationBudget,
          );
        } else {
          await this.managedBroadcastService.processDueDeadlinePublicationBroadcasts();
        }
        completedSweep = true;
      });
    } catch (error: unknown) {
      this.logFailure(reason, error);
      if (propagateFailure) {
        throw error;
      }
    } finally {
      if (completedSweep) {
        void this.refreshDeadlineWakeup();
      }
    }
  }

  private refreshDeadlineWakeup(): Promise<void> {
    if (!this.enabled || !this.runtimeBoundary.dispatchEnabled || this.destroyed) {
      return Promise.resolve();
    }
    this.deadlineWakeRefreshGeneration += 1;
    return this.ensureDeadlineWakeRefresh();
  }

  private async refreshDeadlineWakeupForWake(): Promise<void> {
    while (this.deadlineWakeRefreshInFlight) {
      await this.deadlineWakeRefreshInFlight;
    }
    if (this.destroyed) {
      return;
    }

    const refresh = this.refreshDeadlineWakeupOnce().finally(async () => {
      if (this.deadlineWakeRefreshInFlight === refresh) {
        this.deadlineWakeRefreshInFlight = null;
        if (
          !this.destroyed &&
          this.deadlineWakeRefreshCompletedGeneration < this.deadlineWakeRefreshGeneration
        ) {
          await this.ensureDeadlineWakeRefresh();
        }
      }
    });
    this.deadlineWakeRefreshInFlight = refresh;
    await refresh;
  }

  private ensureDeadlineWakeRefresh(): Promise<void> {
    if (this.deadlineWakeRefreshInFlight) {
      return this.deadlineWakeRefreshInFlight;
    }

    const refresh = this.drainDeadlineWakeRefreshes().finally(async () => {
      if (this.deadlineWakeRefreshInFlight === refresh) {
        this.deadlineWakeRefreshInFlight = null;
        if (
          !this.destroyed &&
          this.deadlineWakeRefreshCompletedGeneration < this.deadlineWakeRefreshGeneration
        ) {
          await this.ensureDeadlineWakeRefresh();
        }
      }
    });
    this.deadlineWakeRefreshInFlight = refresh;
    return refresh;
  }

  private async drainDeadlineWakeRefreshes(): Promise<void> {
    while (
      !this.destroyed &&
      this.deadlineWakeRefreshCompletedGeneration < this.deadlineWakeRefreshGeneration
    ) {
      const generation = this.deadlineWakeRefreshGeneration;
      try {
        await this.refreshDeadlineWakeupOnce();
      } catch (error: unknown) {
        const now = Date.now();
        if (
          now - this.deadlineWakeErrorLogAtMs >=
          PUBLISHER_PUBLICATION_WAKE_ERROR_LOG_INTERVAL_MS
        ) {
          this.deadlineWakeErrorLogAtMs = now;
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            'Failed to refresh the next Publik publication deadline wakeup',
          );
        }
      } finally {
        this.deadlineWakeRefreshCompletedGeneration = generation;
      }
    }
  }

  private async refreshDeadlineWakeupOnce(): Promise<void> {
    // FLAG: A blocked scheduled lane must not hide NOW continuation. Keep the reads
    // sequential on the two-connection pool and arm independent durable-work timers.
    const deadline = await selectNextPendingPublisherPublicationDeadline(this.prisma, new Date(), [
      PublicationScheduleMode.ONCE,
      PublicationScheduleMode.SLOTS,
      PublicationScheduleMode.RECURRENCE,
    ]);
    this.armWakeTimer('deadline', deadline);
    if (this.destroyed) return;
    const immediate = await selectNextPendingPublisherPublicationDeadline(this.prisma, new Date(), [
      PublicationScheduleMode.NOW,
    ]);
    this.armWakeTimer('immediate', immediate);
  }

  private armWakeTimer(
    lane: PublicationWakeLane,
    next: PendingPublisherPublicationDeadline | null,
  ): void {
    if (this.destroyed) {
      return;
    }
    if (!next) {
      this.clearDeadlineWakeTimer(lane);
      return;
    }

    const deadlineAtMs = next.nextSendAt.getTime();
    if (!Number.isFinite(deadlineAtMs)) {
      this.clearDeadlineWakeTimer(lane);
      return;
    }
    const now = Date.now();
    const overdue = deadlineAtMs <= now;
    // FLAG: A future envelope wakes at its persisted deadline. Overdue continuation is bounded so
    // the four-delivery quantum can drain promptly without becoming a database busy loop.
    const wakeAtMs = overdue ? now + PUBLISHER_PUBLICATION_OVERDUE_REARM_MS : deadlineAtMs;
    const wakeKey = `${next.id}:${deadlineAtMs}`;
    const state = this.wakeTimers[lane];
    if (
      state.timer &&
      state.key === wakeKey &&
      (!overdue || (state.atMs ?? Number.POSITIVE_INFINITY) <= wakeAtMs)
    ) {
      return;
    }

    this.clearDeadlineWakeTimer(lane);
    state.key = wakeKey;
    state.atMs = wakeAtMs;
    state.timer = setTimeout(
      () => {
        state.timer = null;
        state.key = null;
        state.atMs = null;
        if (lane === 'immediate') {
          this.immediateGlobalWakeGeneration += 1;
          void this.ensureImmediateDrain('scheduled');
        } else {
          void this.startDeadlineRun('deadline_wakeup');
        }
      },
      Math.max(0, Math.min(MAX_NODE_TIMER_DELAY_MS, wakeAtMs - now)),
    );
    state.timer.unref();
  }

  private clearDeadlineWakeTimer(lane?: PublicationWakeLane): void {
    for (const state of lane ? [this.wakeTimers[lane]] : Object.values(this.wakeTimers)) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.key = null;
      state.atMs = null;
    }
  }

  private logFailure(reason: PublisherPublicationRunReason, error: unknown): void {
    this.logger.warn(
      { reason, err: error instanceof Error ? error.message : String(error) },
      'Failed to process Publik publication envelopes',
    );
  }
}
