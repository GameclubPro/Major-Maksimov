import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Optional } from '@nestjs/common';
import { DelayedError, ErrorCode, UnrecoverableError, type Job, type Queue } from 'bullmq';
import { z } from 'zod';
import { ModerationExecutionService } from '../moderation-execution.service';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { PhotoDuplicateSourceNotReadyError } from '../photo-duplicate/photo-duplicate.queue';
import { MessageDuplicateMediaDeferredError } from './message-duplicate-media.service';
import {
  MessageDuplicateMetricsService,
  recordDuplicatePhase,
  type MessageDuplicateMetricCounter,
} from './message-duplicate-metrics.service';
import type {
  PhotoDuplicateOrderingNextTurn,
  PhotoDuplicateOrderingRunResult,
} from '../photo-duplicate/photo-duplicate-ordering.store';
import {
  MESSAGE_DUPLICATE_QUEUE,
  MESSAGE_DUPLICATE_JOB_VERSION,
  MessageDuplicateOrderingStore,
  type MessageDuplicateJob,
} from './message-duplicate.queue';

const TERMINAL_CLEANUP_RETRY_MS = 30_000;
const TERMINAL_CLEANUP_RECOVERY_MS = 24 * 60 * 60_000;
const ORDERING_DEFER_COUNTERS = {
  not_head: 'worker.defer_ordering_not_head',
  busy: 'worker.defer_ordering_busy',
  scheduled: 'worker.defer_ordering_scheduled',
  deadline: 'worker.defer_ordering_deadline',
  expired: 'worker.defer_ordering_expired',
} as const satisfies Record<
  Extract<PhotoDuplicateOrderingRunResult<unknown>, { kind: 'defer' }>['reason'],
  MessageDuplicateMetricCounter
>;

export const messageDuplicateJobSchema = z
  .object({
    version: z.literal(MESSAGE_DUPLICATE_JOB_VERSION),
    webhookEventId: z.string().min(1).max(200),
    chatId: z.string().regex(/^-[1-9][0-9]{0,19}$/),
    messageId: z.string().min(1).max(512),
    eventTimestampMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER / 2 - 1),
    controlRevision: z.number().int().positive(),
    policyRevision: z.number().int().nonnegative(),
    settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCreatedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    deadlineAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    actionEligible: z.boolean(),
    cleanupOnly: z.enum(['completed', 'terminated']).optional(),
    comparison: z.enum(['TEXT', 'IMAGE']).optional(),
    idempotencyKey: z.string().regex(/^message-duplicate__[a-f0-9]{64}$/),
  })
  .strict()
  .refine((value) => Date.parse(value.sourceCreatedAt) === value.eventTimestampMs)
  .refine((value) => value.deadlineAtMs <= Date.parse(value.createdAt) + 10 * 60_000)
  .refine((value) => value.deadlineAtMs <= value.eventTimestampMs + 10 * 60_000)
  .refine((value) => !value.cleanupOnly || !value.actionEligible);

@Processor(MESSAGE_DUPLICATE_QUEUE, { concurrency: 2 })
export class MessageDuplicateProcessor extends WorkerHost {
  constructor(
    private readonly execution: ModerationExecutionService,
    private readonly ordering: MessageDuplicateOrderingStore,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
    @Optional()
    @InjectQueue(MESSAGE_DUPLICATE_QUEUE)
    private readonly queue?: Queue<MessageDuplicateJob>,
    @Optional() private readonly intents?: ModerationDeleteIntentService,
  ) {
    super();
  }

  async process(job: Job<MessageDuplicateJob>, token?: string): Promise<void> {
    const parsed = messageDuplicateJobSchema.safeParse(job.data);
    if (!parsed.success || job.id !== parsed.data.idempotencyKey) {
      this.metrics?.record('worker.invalid');
      throw new UnrecoverableError('Invalid message duplicate job');
    }
    const data = Object.freeze(parsed.data);
    this.metrics?.record('worker.started');
    const ageMs = Date.now() - Date.parse(data.createdAt);
    this.metrics?.record(
      ageMs < 10_000
        ? 'worker.age_under_10s'
        : ageMs < 60_000
          ? 'worker.age_10s_to_60s'
          : 'worker.age_over_60s',
    );
    const identity = {
      jobId: data.idempotencyKey,
      chatId: data.chatId,
      sourceCreatedAt: data.sourceCreatedAt,
      deadlineAtMs: data.deadlineAtMs,
    };
    if (data.cleanupOnly) {
      await this.reconcileCleanup(job, data, identity, data.cleanupOnly, token);
      this.metrics?.record('worker.cleanup_completed');
      return;
    }
    // FLAG: Pressure, ordering and source readiness deferrals share an absolute lifetime.
    if (Date.now() >= data.deadlineAtMs || Date.parse(data.createdAt) > Date.now() + 60_000) {
      await this.reconcileCleanup(job, data, identity, 'terminated', token);
      this.metrics?.record('worker.expired');
      return;
    }
    let nextEligibleAtMs = Date.now() + 5000;
    let postponeKind: 'head' | 'ordering' = 'head';
    let result: PhotoDuplicateOrderingRunResult<unknown> | undefined;
    try {
      const orderingStarted = performance.now();
      let entered = false;
      try {
        result = await this.ordering.runInOrder(
          identity,
          data.actionEligible,
          (lease, eligible) => {
            entered = true;
            // FLAG: One acquisition attempt, excluding execution and prior durable queue delays.
            recordDuplicatePhase(
              this.metrics,
              'ordering_acquire',
              performance.now() - orderingStarted,
            );
            return this.execution.processMessageDuplicateJob(
              { ...data, actionEligible: data.actionEligible && eligible === true },
              lease,
            );
          },
        );
      } finally {
        if (!entered)
          recordDuplicatePhase(
            this.metrics,
            'ordering_acquire',
            performance.now() - orderingStarted,
          );
      }
    } catch (error) {
      if (
        !(error instanceof PhotoDuplicateSourceNotReadyError) &&
        !(error instanceof MessageDuplicateMediaDeferredError)
      ) {
        if (
          error instanceof UnrecoverableError ||
          job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
        ) {
          await this.reconcileCleanup(job, data, identity, 'terminated', token);
          this.metrics?.record('worker.terminal');
        } else this.metrics?.record('worker.retry');
        throw error;
      }
      this.metrics?.record(
        error instanceof PhotoDuplicateSourceNotReadyError
          ? 'worker.defer_source'
          : 'worker.defer_media',
      );
      nextEligibleAtMs =
        Date.now() +
        (error instanceof MessageDuplicateMediaDeferredError ? error.retryAfterMs : 5000);
      if (error instanceof MessageDuplicateMediaDeferredError) {
        this.metrics?.record(
          error.reason === 'governor_pause'
            ? 'worker.defer_governor_pause'
            : error.reason === 'governor_slow'
              ? 'worker.defer_governor_slow'
              : error.reason === 'decode_capacity'
                ? 'worker.defer_decode_capacity'
                : 'worker.defer_proof_budget',
        );
      }
    }
    if (result) {
      if (result.kind !== 'defer') {
        await this.reconcileCleanup(job, data, identity, 'completed', token, result.next);
        this.metrics?.record('worker.completed');
        return;
      }
      this.metrics?.record('worker.defer_ordering');
      this.metrics?.record(ORDERING_DEFER_COUNTERS[result.reason]);
      if (result.reason === 'expired') {
        await this.reconcileCleanup(job, data, identity, 'terminated', token);
        this.metrics?.record('worker.expired');
        return;
      }
      nextEligibleAtMs = result.nextEligibleAtMs;
      postponeKind = 'ordering';
    }
    if (
      (postponeKind === 'head' && nextEligibleAtMs >= data.deadlineAtMs) ||
      Date.now() >= data.deadlineAtMs
    ) {
      await this.reconcileCleanup(job, data, identity, 'terminated', token);
      this.metrics?.record('worker.expired');
      return;
    }
    try {
      if (!token) throw new Error('Missing message duplicate worker lock');
      nextEligibleAtMs = await this.ordering.postpone(identity, nextEligibleAtMs, postponeKind);
    } catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1))
        await this.reconcileCleanup(job, data, identity, 'terminated', token);
      throw error;
    }
    if (nextEligibleAtMs >= data.deadlineAtMs || Date.now() >= data.deadlineAtMs) {
      await this.reconcileCleanup(job, data, identity, 'terminated', token);
      this.metrics?.record('worker.expired');
      return;
    }
    try {
      await job.moveToDelayed(nextEligibleAtMs, token);
    } catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1))
        await this.reconcileCleanup(job, data, identity, 'terminated', token);
      throw error;
    }
    if (postponeKind === 'ordering') {
      let wakeupStage: 'recheck' | 'change_delay' = 'recheck';
      try {
        // FLAG: Recheck after the job becomes delayed. A preceding completion before this point
        // cannot changeDelay an active follower; after this point its normal promotion can succeed.
        const effectiveNextEligibleAtMs = await this.ordering.postpone(
          identity,
          nextEligibleAtMs,
          'ordering',
        );
        if (effectiveNextEligibleAtMs < nextEligibleAtMs) {
          wakeupStage = 'change_delay';
          await job.changeDelay(Math.max(0, effectiveNextEligibleAtMs - Date.now()));
        }
      } catch (error) {
        // FLAG: Scheduling already committed. Preserve its bounded retry if promotion races
        // activation or Redis is unavailable; never retry an already delayed job as a failure.
        this.recordWakeupUnavailable(wakeupStage, error);
      }
    }
    throw new DelayedError();
  }

  private async reconcileCleanup(
    job: Job<MessageDuplicateJob>,
    data: MessageDuplicateJob,
    identity: { jobId: string; chatId: string; sourceCreatedAt: string; deadlineAtMs: number },
    phase: 'completed' | 'terminated',
    token?: string,
    nextTurn?: PhotoDuplicateOrderingNextTurn,
  ): Promise<void> {
    let next = nextTurn;
    const cleanupStarted = performance.now();
    try {
      // FLAG: Persist the terminal phase before releasing ordering or SQL ownership. A retry
      // may reconcile only the unused claim; it must never restore analysis or positive authority.
      if (phase === 'terminated') {
        if (!data.cleanupOnly)
          await job.updateData({ ...data, actionEligible: false, cleanupOnly: phase });
        next = await this.ordering.abandon(identity);
      }
      await this.intents?.releaseTerminatedMessageDuplicateAction(data);
    } catch (error) {
      const recoveryDeadlineAtMs = data.deadlineAtMs + TERMINAL_CLEANUP_RECOVERY_MS;
      if (Date.now() >= recoveryDeadlineAtMs) {
        this.metrics?.record('worker.cleanup_exhausted');
        throw new UnrecoverableError('Message duplicate terminal cleanup unavailable');
      }
      // FLAG: Completed ordering already fences analysis. Its cleanup must preserve the permit
      // for a materialized intent, including when SQL is unavailable after completion.
      if (phase === 'completed' && !data.cleanupOnly)
        await job.updateData({ ...data, actionEligible: false, cleanupOnly: phase });
      if (!token) throw error;
      await job.moveToDelayed(
        Math.min(Date.now() + TERMINAL_CLEANUP_RETRY_MS, recoveryDeadlineAtMs),
        token,
      );
      this.metrics?.record('worker.cleanup_retry');
      throw new DelayedError();
    } finally {
      try {
        await this.promoteNext(next);
      } finally {
        recordDuplicatePhase(this.metrics, 'cleanup', performance.now() - cleanupStarted);
      }
    }
  }

  private async promoteNext(next: PhotoDuplicateOrderingNextTurn | undefined): Promise<void> {
    if (!next || !this.queue) return;
    let wakeupStage: 'lookup' | 'change_delay' = 'lookup';
    try {
      const job = await this.queue.getJob(next.jobId);
      if (job) {
        wakeupStage = 'change_delay';
        await job.changeDelay(Math.max(0, next.nextEligibleAtMs - Date.now()));
      } else this.metrics?.record('worker.wakeup_lookup_missing');
    } catch (error) {
      // FLAG: A completed order must stay committed if the bounded wakeup races an active job.
      // Its existing delay and lease recovery remain the fallback after a lost promotion.
      this.recordWakeupUnavailable(wakeupStage, error);
    }
  }

  private recordWakeupUnavailable(
    stage: 'recheck' | 'lookup' | 'change_delay',
    error: unknown,
  ): void {
    this.metrics?.record('worker.wakeup_unavailable');
    if (stage === 'recheck') this.metrics?.record('worker.wakeup_recheck_unavailable');
    else if (stage === 'lookup') this.metrics?.record('worker.wakeup_lookup_unavailable');
    else {
      // FLAG: BullMQ's numeric code proves only the failed delayed-state operation;
      // never infer active/completed state or log the error's private job identity.
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      this.metrics?.record(
        code === ErrorCode.JobNotInState
          ? 'worker.wakeup_not_delayed'
          : code === ErrorCode.JobNotExist
            ? 'worker.wakeup_missing_job'
            : 'worker.wakeup_change_delay_unavailable',
      );
    }
  }
}
