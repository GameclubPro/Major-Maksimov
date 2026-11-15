import { DelayedError, ErrorCode, Scripts, UnrecoverableError, type Job, type Queue } from 'bullmq';
import {
  MessageDuplicateEnqueueService,
  MessageDuplicateOrderingStore,
  type MessageDuplicateJob,
} from './message-duplicate.queue';
import { MessageDuplicateProcessor } from './message-duplicate.processor';
import { MessageDuplicateMediaDeferredError } from './message-duplicate-media.service';
import type { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import type { PhotoDuplicateOrderingRunResult } from '../photo-duplicate/photo-duplicate-ordering.store';

function processorMetrics(): jest.Mocked<Pick<MessageDuplicateMetricsService, 'record'>> {
  return { record: jest.fn() };
}

function diagnosticProcessor(
  ordering: jest.Mocked<Pick<MessageDuplicateOrderingStore, 'runInOrder'>> &
    Partial<jest.Mocked<Pick<MessageDuplicateOrderingStore, 'postpone' | 'abandon'>>>,
  metrics: jest.Mocked<Pick<MessageDuplicateMetricsService, 'record'>>,
  queue?: jest.Mocked<Pick<Queue<MessageDuplicateJob>, 'getJob'>>,
): MessageDuplicateProcessor {
  // FLAG: The constructor accepts concrete classes with private state; these paths use only
  // the checked public methods above, so keep the class boundary explicit here.
  return new MessageDuplicateProcessor(
    {} as never,
    ordering as unknown as MessageDuplicateOrderingStore,
    metrics as unknown as MessageDuplicateMetricsService,
    queue as unknown as Queue<MessageDuplicateJob> | undefined,
  );
}

function jobData(): MessageDuplicateJob {
  const now = new Date().toISOString();
  return {
    version: 2,
    webhookEventId: 'receipt',
    chatId: '-123',
    messageId: 'm',
    eventTimestampMs: Date.parse(now),
    sourceCreatedAt: now,
    createdAt: now,
    settingsDigest: 'a'.repeat(64),
    controlRevision: 1,
    policyRevision: 1,
    deadlineAtMs: Date.parse(now) + 600_000,
    actionEligible: true,
    idempotencyKey: `message-duplicate__${'b'.repeat(64)}`,
  };
}
function registered(eligible: boolean) {
  const admittedAtMs = Date.now();
  return {
    kind: 'registered',
    actionEligible: eligible,
    admittedAtMs,
    deadlineAtMs: admittedAtMs + 600_000,
  };
}
function admission() {
  return {
    register: jest.fn().mockResolvedValue({ registration: 'initial', admittedAtMs: Date.now() }),
  };
}
function postponeMock() {
  return jest.fn<
    ReturnType<MessageDuplicateOrderingStore['postpone']>,
    Parameters<MessageDuplicateOrderingStore['postpone']>
  >(async (_identity, nextEligibleAtMs) => nextEligibleAtMs);
}
function workerJob(data: MessageDuplicateJob, attemptsMade = 0) {
  const job = {
    id: data.idempotencyKey,
    data,
    attemptsMade,
    opts: { attempts: 5 },
    moveToDelayed: jest.fn(),
    updateData: jest.fn(async (next: MessageDuplicateJob): Promise<void> => {
      job.data = next;
    }),
  };
  return job;
}
describe('message duplicate queue', () => {
  it('uses one deterministic reference-only job and never upgrades a restrictive replay', async () => {
    const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
    const ordering = {
      announce: jest.fn().mockResolvedValue(registered(false)),
    };
    const service = new MessageDuplicateEnqueueService(
      queue as never,
      ordering as never,
      admission() as never,
    );
    await service.enqueue(jobData());
    expect(queue.add).toHaveBeenCalledWith(
      'message-duplicate-analysis',
      expect.objectContaining({ actionEligible: false }),
      expect.objectContaining({ attempts: 5, delay: expect.any(Number) }),
    );
    const first = queue.add.mock.calls[0]![1].idempotencyKey;
    await service.enqueue({
      ...jobData(),
      sourceCreatedAt: queue.add.mock.calls[0]![1].sourceCreatedAt,
      eventTimestampMs: queue.add.mock.calls[0]![1].eventTimestampMs,
    });
    expect(queue.add.mock.calls[1]![1].idempotencyKey).toBe(first);
    queue.add.mockRejectedValueOnce(new Error('ambiguous enqueue'));
    await expect(service.enqueue(jobData())).rejects.toThrow('ambiguous enqueue');
    expect(ordering.announce).toHaveBeenLastCalledWith(expect.anything(), true, 'retry');
  });
  it.each(['TEXT', 'IMAGE'] as const)(
    'preserves the original settling deadline for a repaired %s job',
    async (comparison) => {
      const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
      const ordering = { announce: jest.fn().mockResolvedValue(registered(true)) };
      const admissionStore = {
        register: jest
          .fn()
          .mockResolvedValue({ registration: 'retry', admittedAtMs: Date.now() - 10_000 }),
      };
      const service = new MessageDuplicateEnqueueService(
        queue as never,
        ordering as never,
        admissionStore as never,
      );
      const input = { ...jobData(), comparison };
      await service.enqueue(input);
      expect(queue.add).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
        expect.objectContaining({
          delay: 0,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
        }),
      );
    },
  );

  it('starts deferred text qualification immediately while preserving fresh image settling', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
      const ordering = { announce: jest.fn().mockResolvedValue(registered(true)) };
      const service = new MessageDuplicateEnqueueService(
        queue as never,
        ordering as never,
        admission() as never,
      );
      await service.enqueue({ ...jobData(), comparison: 'TEXT' });
      expect(queue.add.mock.calls[0]?.[2].delay).toBe(0);
      await service.enqueue({ ...jobData(), comparison: 'IMAGE' });
      expect(queue.add.mock.calls[1]?.[2].delay).toBe(5000);
    } finally {
      clock.mockRestore();
    }
  });

  it('retries unavailable registration without submitting a permanently ineligible job', async () => {
    const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
    const ordering = {
      announce: jest.fn().mockResolvedValue({ kind: 'unavailable' }),
    };
    const service = new MessageDuplicateEnqueueService(
      queue as never,
      ordering as never,
      admission() as never,
    );
    await expect(service.enqueue(jobData())).rejects.toThrow('ordering storage is unavailable');
    expect(queue.add).not.toHaveBeenCalled();
    expect(ordering.announce.mock.calls.every(([, eligible]) => eligible === true)).toBe(true);
    ordering.announce.mockResolvedValue(registered(true));
    await service.enqueue(jobData());
    expect(queue.add).toHaveBeenCalledWith(
      'message-duplicate-analysis',
      expect.objectContaining({ actionEligible: true }),
      expect.anything(),
    );
  });
  it.each([true, false])(
    'preserves eligibility %s after an ambiguous queue add',
    async (eligible) => {
      const queue = {
        add: jest.fn().mockRejectedValueOnce(new Error('lost queue response')),
        getJob: jest.fn().mockResolvedValue(null),
      };
      let stored = true;
      const ordering = {
        announce: jest.fn(async (_identity: unknown, incoming: boolean) => {
          stored = stored && incoming;
          return registered(stored);
        }),
      };
      const service = new MessageDuplicateEnqueueService(
        queue as never,
        ordering as never,
        admission() as never,
      );
      const input = { ...jobData(), actionEligible: eligible };
      await expect(service.enqueue(input)).rejects.toThrow('lost queue response');
      await service.enqueue({ ...input, actionEligible: true });
      expect(stored).toBe(eligible);
      expect(queue.add.mock.calls[1]![1].actionEligible).toBe(eligible);
    },
  );
  it('isolates media ordering from the existing photo queue', async () => {
    const store = Object.create(
      MessageDuplicateOrderingStore.prototype,
    ) as MessageDuplicateOrderingStore;
    const now = Date.now();
    const redis = { eval: jest.fn().mockResolvedValue([1, 'member', '1', now, now + 600_000]) };
    Object.defineProperties(store, {
      redis: { value: redis },
      namespace: { value: 'message-duplicate:ordering:v2' },
    });
    const data = jobData();
    await store.announce(
      { jobId: data.idempotencyKey, chatId: data.chatId, sourceCreatedAt: data.sourceCreatedAt },
      true,
    );
    expect(redis.eval.mock.calls[0]![2]).toMatch(/^message-duplicate:ordering:v2:/);
  });
  it('uses delayed retries without consuming attempts, bounded by an absolute lifetime', async () => {
    const execution = { processMessageDuplicateJob: jest.fn() };
    const ordering = {
      runInOrder: jest.fn().mockRejectedValue(new MessageDuplicateMediaDeferredError()),
      abandon: jest.fn(),
      postpone: postponeMock(),
    };
    const metrics = { record: jest.fn() };
    const intents = { releaseTerminatedMessageDuplicateAction: jest.fn().mockResolvedValue(true) };
    const processor = new MessageDuplicateProcessor(
      execution as never,
      ordering as never,
      metrics as never,
      undefined,
      intents as never,
    );
    const data = jobData();
    const job = workerJob(data);
    await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(ordering.abandon).not.toHaveBeenCalled();
    expect(intents.releaseTerminatedMessageDuplicateAction).not.toHaveBeenCalled();
    expect(metrics.record).toHaveBeenCalledWith('worker.defer_media');
    expect(metrics.record).not.toHaveBeenCalledWith('worker.completed');
    data.createdAt = new Date(Date.now() - 600001).toISOString();
    data.deadlineAtMs = Date.parse(data.createdAt) + 600_000;
    await processor.process(job as never, 'token');
    expect(ordering.abandon).toHaveBeenCalledTimes(1);
    expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(1);
    expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: data.chatId,
        messageId: data.messageId,
        eventTimestampMs: data.eventTimestampMs,
        deadlineAtMs: data.deadlineAtMs,
      }),
    );
    expect(metrics.record).toHaveBeenCalledWith('worker.expired');
  });

  it('honors a governor pause for 180 seconds and records the head wakeup', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const ordering = {
        runInOrder: jest
          .fn()
          .mockRejectedValue(new MessageDuplicateMediaDeferredError('governor_pause', 180_000)),
        abandon: jest.fn(),
        postpone: postponeMock(),
      };
      const intents = {
        releaseTerminatedMessageDuplicateAction: jest.fn().mockResolvedValue(true),
      };
      const processor = new MessageDuplicateProcessor(
        {} as never,
        ordering as never,
        undefined,
        undefined,
        intents as never,
      );
      const data = jobData();
      const job = {
        id: data.idempotencyKey,
        data,
        attemptsMade: 0,
        opts: { attempts: 5 },
        moveToDelayed: jest.fn(),
      };
      await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(now + 180_000, 'token');
      expect(intents.releaseTerminatedMessageDuplicateAction).not.toHaveBeenCalled();
      expect(ordering.postpone).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineAtMs: data.deadlineAtMs }),
        now + 180_000,
        'head',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('expires a job when the next verification cannot fit its original deadline', async () => {
    const ordering = {
      runInOrder: jest
        .fn()
        .mockRejectedValue(new MessageDuplicateMediaDeferredError('governor_pause', 180_000)),
      abandon: jest.fn(),
      postpone: postponeMock(),
    };
    const metrics = { record: jest.fn() };
    const intents = { releaseTerminatedMessageDuplicateAction: jest.fn().mockResolvedValue(true) };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      metrics as never,
      undefined,
      intents as never,
    );
    const data = jobData();
    data.deadlineAtMs = Date.now() + 10_000;
    const job = workerJob(data);
    await processor.process(job as never, 'token');
    expect(ordering.abandon).toHaveBeenCalledTimes(1);
    expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(1);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(metrics.record).toHaveBeenCalledWith('worker.expired');
  });

  it('uses the head wakeup for followers and fails closed for pre-release jobs', async () => {
    const nextEligibleAtMs = Date.now() + 180_000;
    const ordering = {
      runInOrder: jest
        .fn()
        .mockResolvedValue({ kind: 'defer', reason: 'not_head', nextEligibleAtMs }),
      abandon: jest.fn(),
      postpone: postponeMock(),
    };
    const processor = new MessageDuplicateProcessor({} as never, ordering as never);
    const data = jobData();
    const job = {
      id: data.idempotencyKey,
      data,
      attemptsMade: 0,
      opts: { attempts: 5 },
      moveToDelayed: jest.fn(),
    };
    await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(nextEligibleAtMs, 'token');
    expect(ordering.postpone).toHaveBeenCalledWith(expect.anything(), nextEligibleAtMs, 'ordering');
    await expect(
      processor.process({ ...job, data: { ...data, version: 1 } } as never, 'token'),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    ['not_head', 'worker.defer_ordering_not_head'],
    ['busy', 'worker.defer_ordering_busy'],
    ['scheduled', 'worker.defer_ordering_scheduled'],
    ['deadline', 'worker.defer_ordering_deadline'],
    ['expired', 'worker.defer_ordering_expired'],
  ] as const)(
    'distinguishes ordering deferral %s without changing its outcome',
    async (reason, counter) => {
      const nextEligibleAtMs = Date.now() + 30_000;
      const result = {
        kind: 'defer',
        reason,
        nextEligibleAtMs,
      } satisfies PhotoDuplicateOrderingRunResult<unknown>;
      const ordering: jest.Mocked<
        Pick<MessageDuplicateOrderingStore, 'runInOrder' | 'postpone' | 'abandon'>
      > = {
        runInOrder: jest.fn().mockResolvedValue(result),
        postpone: postponeMock(),
        abandon: jest.fn(),
      };
      const metrics = processorMetrics();
      const processor = diagnosticProcessor(ordering, metrics);
      const job = workerJob(jobData());
      if (reason === 'expired') {
        await expect(processor.process(job as never, 'token')).resolves.toBeUndefined();
        expect(ordering.abandon).toHaveBeenCalledTimes(1);
        expect(job.moveToDelayed).not.toHaveBeenCalled();
        expect(metrics.record).toHaveBeenCalledWith('worker.expired');
      } else {
        await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
        expect(job.moveToDelayed).toHaveBeenCalledWith(nextEligibleAtMs, 'token');
        expect(ordering.abandon).not.toHaveBeenCalled();
      }
      expect(metrics.record).toHaveBeenCalledWith('worker.defer_ordering');
      expect(metrics.record).toHaveBeenCalledWith(counter);
    },
  );

  it('uses the promoted head wakeup before expiring an inherited wait', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const ordering = {
        runInOrder: jest.fn().mockResolvedValue({
          kind: 'defer',
          reason: 'not_head',
          nextEligibleAtMs: now + 30_000,
        }),
        postpone: postponeMock().mockResolvedValue(now),
        abandon: jest.fn(),
      };
      const data = jobData();
      data.deadlineAtMs = now + 10_000;
      const job = workerJob(data);
      const processor = new MessageDuplicateProcessor({} as never, ordering as never);
      await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(now, 'token');
      expect(ordering.abandon).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('repairs promotion lost between inherited postponement and moving to delayed', async () => {
    const now = Date.now();
    const nextEligibleAtMs = now + 30_000;
    const ordering = {
      runInOrder: jest.fn().mockResolvedValue({
        kind: 'defer',
        reason: 'not_head',
        nextEligibleAtMs,
      }),
      postpone: postponeMock().mockResolvedValueOnce(nextEligibleAtMs).mockResolvedValueOnce(now),
      abandon: jest.fn(),
    };
    const job = { ...workerJob(jobData()), changeDelay: jest.fn() };
    const processor = new MessageDuplicateProcessor({} as never, ordering as never);
    await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(nextEligibleAtMs, 'token');
    expect(job.changeDelay).toHaveBeenCalledWith(0);
    expect(ordering.abandon).not.toHaveBeenCalled();
  });

  it('preserves committed scheduling when the post-delay wakeup check is unavailable', async () => {
    const nextEligibleAtMs = Date.now() + 30_000;
    const ordering = {
      runInOrder: jest.fn().mockResolvedValue({
        kind: 'defer',
        reason: 'not_head',
        nextEligibleAtMs,
      }),
      postpone: postponeMock()
        .mockResolvedValueOnce(nextEligibleAtMs)
        .mockRejectedValueOnce(new Error('Redis unavailable')),
      abandon: jest.fn(),
    };
    const metrics = { record: jest.fn() };
    const intents = { releaseTerminatedMessageDuplicateAction: jest.fn() };
    const job = { ...workerJob(jobData(), 4), changeDelay: jest.fn() };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      metrics as never,
      undefined,
      intents as never,
    );
    await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(nextEligibleAtMs, 'token');
    expect(job.changeDelay).not.toHaveBeenCalled();
    expect(ordering.abandon).not.toHaveBeenCalled();
    expect(intents.releaseTerminatedMessageDuplicateAction).not.toHaveBeenCalled();
    expect(metrics.record).toHaveBeenCalledWith('worker.wakeup_unavailable');
    expect(metrics.record).toHaveBeenCalledWith('worker.wakeup_recheck_unavailable');
  });

  it('classifies a real BullMQ delayed-state error after the post-delay promotion', async () => {
    const nextEligibleAtMs = Date.now() + 30_000;
    const ordering: jest.Mocked<
      Pick<MessageDuplicateOrderingStore, 'runInOrder' | 'postpone' | 'abandon'>
    > = {
      runInOrder: jest
        .fn()
        .mockResolvedValue({ kind: 'defer', reason: 'not_head', nextEligibleAtMs }),
      postpone: postponeMock()
        .mockResolvedValueOnce(nextEligibleAtMs)
        .mockResolvedValueOnce(Date.now()),
      abandon: jest.fn(),
    };
    const metrics = processorMetrics();
    const error = Scripts.prototype.finishedErrors({
      code: ErrorCode.JobNotInState,
      jobId: 'private-job',
      command: 'changeDelay',
      state: 'delayed',
    });
    const job = { ...workerJob(jobData()), changeDelay: jest.fn().mockRejectedValue(error) };
    const processor = diagnosticProcessor(ordering, metrics);
    await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(ordering.abandon).not.toHaveBeenCalled();
    expect(metrics.record).toHaveBeenCalledWith('worker.wakeup_unavailable');
    expect(metrics.record).toHaveBeenCalledWith('worker.wakeup_not_delayed');
    expect(JSON.stringify(metrics.record.mock.calls)).not.toContain('private');
  });

  it('promotes only the next head while preserving its explicit future wakeup', async () => {
    const nextEligibleAtMs = Date.now() + 180_000;
    const ordering = {
      runInOrder: jest
        .fn()
        .mockResolvedValue({ kind: 'completed', next: { jobId: 'next-job', nextEligibleAtMs } }),
    };
    const nextJob = { changeDelay: jest.fn() };
    const queue = { getJob: jest.fn().mockResolvedValue(nextJob) };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      undefined,
      queue as never,
    );
    const data = jobData();
    await processor.process({ id: data.idempotencyKey, data } as never);
    expect(queue.getJob).toHaveBeenCalledWith('next-job');
    expect(nextJob.changeDelay.mock.calls[0]![0]).toBeGreaterThanOrEqual(179_000);
    expect(nextJob.changeDelay.mock.calls[0]![0]).toBeLessThanOrEqual(180_000);
  });

  it('keeps completion successful if next-head promotion races an active job', async () => {
    const ordering = {
      runInOrder: jest.fn().mockResolvedValue({
        kind: 'completed',
        next: { jobId: 'next-job', nextEligibleAtMs: Date.now() },
      }),
    };
    const queue = {
      getJob: jest
        .fn()
        .mockResolvedValue({ changeDelay: jest.fn().mockRejectedValue(new Error('not delayed')) }),
    };
    const metrics = { record: jest.fn() };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      metrics as never,
      queue as never,
    );
    const data = jobData();
    await processor.process({ id: data.idempotencyKey, data } as never);
    expect(metrics.record).toHaveBeenCalledWith('worker.wakeup_unavailable');
    expect(metrics.record).toHaveBeenCalledWith('worker.completed');
  });

  it.each([
    [
      Scripts.prototype.finishedErrors({
        code: ErrorCode.JobNotInState,
        jobId: 'private-job',
        command: 'changeDelay',
        state: 'delayed',
      }),
      'worker.wakeup_not_delayed',
    ],
    [
      Scripts.prototype.finishedErrors({
        code: ErrorCode.JobNotExist,
        jobId: 'private-job',
        command: 'changeDelay',
      }),
      'worker.wakeup_missing_job',
    ],
    [
      Scripts.prototype.finishedErrors({
        code: ErrorCode.JobLockNotExist,
        jobId: 'private-job',
        command: 'changeDelay',
      }),
      'worker.wakeup_change_delay_unavailable',
    ],
    [
      Object.assign(new Error('private-lookalike'), { code: String(ErrorCode.JobNotInState) }),
      'worker.wakeup_change_delay_unavailable',
    ],
    [
      new Error('Job private-job is not in the delayed state. changeDelay'),
      'worker.wakeup_change_delay_unavailable',
    ],
    [
      { message: 'private-object', code: ErrorCode.JobNotInState },
      'worker.wakeup_change_delay_unavailable',
    ],
    ['private-unknown-throw', 'worker.wakeup_change_delay_unavailable'],
  ] as const)('keeps next-head wakeup failure %p diagnostic only', async (error, counter) => {
    const ordering: jest.Mocked<Pick<MessageDuplicateOrderingStore, 'runInOrder'>> = {
      runInOrder: jest.fn().mockResolvedValue({
        kind: 'completed',
        next: { jobId: 'next-job', nextEligibleAtMs: Date.now() },
      }),
    };
    const nextJob: jest.Mocked<Pick<Job<MessageDuplicateJob>, 'changeDelay'>> = {
      changeDelay: jest.fn().mockRejectedValue(error),
    };
    const queue: jest.Mocked<Pick<Queue<MessageDuplicateJob>, 'getJob'>> = {
      getJob: jest.fn().mockResolvedValue(nextJob),
    };
    const metrics = processorMetrics();
    const processor = diagnosticProcessor(ordering, metrics, queue);
    await expect(processor.process(workerJob(jobData()) as never)).resolves.toBeUndefined();
    expect(metrics.record).toHaveBeenCalledWith('worker.wakeup_unavailable');
    expect(metrics.record).toHaveBeenCalledWith(counter);
    expect(metrics.record).toHaveBeenCalledWith('worker.completed');
    expect(JSON.stringify(metrics.record.mock.calls)).not.toContain('private');
  });

  it.each([
    undefined,
    Scripts.prototype.finishedErrors({
      code: ErrorCode.JobNotInState,
      jobId: 'private-job',
      command: 'getJob',
    }),
  ])(
    'distinguishes an absent next job from a failed lookup without inferring its state',
    async (error) => {
      const ordering: jest.Mocked<Pick<MessageDuplicateOrderingStore, 'runInOrder'>> = {
        runInOrder: jest.fn().mockResolvedValue({
          kind: 'completed',
          next: { jobId: 'next-job', nextEligibleAtMs: Date.now() },
        }),
      };
      const queue: jest.Mocked<Pick<Queue<MessageDuplicateJob>, 'getJob'>> = { getJob: jest.fn() };
      if (error) queue.getJob.mockRejectedValue(error);
      else queue.getJob.mockResolvedValue(undefined);
      const metrics = processorMetrics();
      const processor = diagnosticProcessor(ordering, metrics, queue);
      await expect(processor.process(workerJob(jobData()) as never)).resolves.toBeUndefined();
      expect(metrics.record).toHaveBeenCalledWith(
        error ? 'worker.wakeup_lookup_unavailable' : 'worker.wakeup_lookup_missing',
      );
      expect(
        metrics.record.mock.calls.some(([counter]) => counter === 'worker.wakeup_unavailable'),
      ).toBe(Boolean(error));
      expect(metrics.record).not.toHaveBeenCalledWith('worker.wakeup_not_delayed');
      expect(metrics.record).toHaveBeenCalledWith('worker.completed');
      expect(JSON.stringify(metrics.record.mock.calls)).not.toContain('private');
    },
  );

  it('preserves first-admission timestamps when the same queue job is added again', async () => {
    const first = registered(true);
    const ordering = { announce: jest.fn().mockResolvedValue(first) };
    const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
    const service = new MessageDuplicateEnqueueService(
      queue as never,
      ordering as never,
      admission() as never,
    );
    const input = jobData();
    await service.enqueue(input);
    await service.enqueue(input);
    expect(queue.add.mock.calls[0]![1].createdAt).toBe(new Date(first.admittedAtMs).toISOString());
    expect(queue.add.mock.calls[1]![1].deadlineAtMs).toBe(first.deadlineAtMs);
  });
  it('does not renew the lifetime of an old event when its receipt is readmitted', async () => {
    const ordering = { announce: jest.fn().mockResolvedValue({ kind: 'expired' }) };
    const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
    const service = new MessageDuplicateEnqueueService(
      queue as never,
      ordering as never,
      admission() as never,
    );
    const timestamp = Date.now() - 600_001;
    await service.enqueue({
      ...jobData(),
      eventTimestampMs: timestamp,
      sourceCreatedAt: new Date(timestamp).toISOString(),
    });
    expect(ordering.announce).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineAtMs: timestamp + 600_000 }),
      true,
      'initial',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });
  it('treats a retained BullMQ job as a retry even if durable registration claims initial', async () => {
    const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue({ id: 'retained-job' }) };
    const ordering = { announce: jest.fn().mockResolvedValue(registered(false)) };
    const service = new MessageDuplicateEnqueueService(
      queue as never,
      ordering as never,
      admission() as never,
    );
    await service.enqueue(jobData());
    expect(ordering.announce).toHaveBeenCalledWith(expect.anything(), true, 'retry');
    expect(queue.add.mock.calls[0]![1].actionEligible).toBe(false);
  });

  it('does not mint positive authority after both Redis and retained BullMQ state disappear', async () => {
    const durable = admission();
    durable.register.mockResolvedValue({ registration: 'retry', admittedAtMs: Date.now() - 6000 });
    const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
    const ordering = {
      announce: jest.fn().mockResolvedValue(registered(false)),
      readActionEligibility: jest.fn().mockResolvedValue(false),
    };
    const service = new MessageDuplicateEnqueueService(
      queue as never,
      ordering as never,
      durable as never,
    );
    await service.enqueue(jobData());
    expect(ordering.announce).toHaveBeenCalledWith(expect.anything(), true, 'retry');
    expect(queue.add.mock.calls[0]![1].actionEligible).toBe(false);
  });

  it('lets the first admission finish without a competing retry registering a false head', async () => {
    const durable = admission();
    durable.register.mockResolvedValue({ registration: 'retry', admittedAtMs: Date.now() });
    const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
    const ordering = {
      announce: jest.fn(),
      readActionEligibility: jest.fn().mockResolvedValue(false),
    };
    const service = new MessageDuplicateEnqueueService(
      queue as never,
      ordering as never,
      durable as never,
    );
    await expect(service.enqueue(jobData())).rejects.toThrow('initial admission is incomplete');
    expect(ordering.announce).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
  it.each(['event', 'explicit'] as const)(
    'settles an expired %s deadline on a fresh admission replay without blocking the webhook',
    async (deadlineSource) => {
      const now = Date.now();
      const durable = admission();
      durable.register.mockResolvedValue({ registration: 'retry', admittedAtMs: now });
      const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
      const ordering = {
        announce: jest.fn().mockResolvedValue({ kind: 'expired' }),
        readActionEligibility: jest.fn().mockResolvedValue(false),
      };
      const service = new MessageDuplicateEnqueueService(
        queue as never,
        ordering as never,
        durable as never,
      );
      const input = jobData();
      if (deadlineSource === 'event') {
        input.eventTimestampMs = now - 600_001;
        input.sourceCreatedAt = new Date(input.eventTimestampMs).toISOString();
      } else {
        input.deadlineAtMs = now - 1;
      }

      await expect(service.enqueue(input)).resolves.toBeUndefined();

      expect(ordering.readActionEligibility).not.toHaveBeenCalled();
      expect(ordering.announce).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineAtMs: now - 1 }),
        true,
        'retry',
      );
      expect(queue.add).not.toHaveBeenCalled();
    },
  );
  it('abandons a final processing failure and rejects malformed envelopes', async () => {
    const ordering = {
      runInOrder: jest.fn().mockRejectedValue(new Error('download')),
      abandon: jest.fn(),
    };
    const intents = { releaseTerminatedMessageDuplicateAction: jest.fn().mockResolvedValue(true) };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      undefined,
      undefined,
      intents as never,
    );
    const data = jobData();
    const job = workerJob(data, 4);
    await expect(processor.process(job as never, 'token')).rejects.toThrow('download');
    expect(ordering.abandon).toHaveBeenCalledTimes(1);
    expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(1);
    await expect(
      processor.process({ ...job, data: { ...data, actionEligible: 'true' } } as never),
    ).rejects.toThrow('Invalid message duplicate job');
    expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(1);
  });

  it('preserves a resumable claim after a recoverable processing failure', async () => {
    const ordering = {
      runInOrder: jest.fn().mockRejectedValue(new Error('temporary source unavailable')),
      abandon: jest.fn(),
    };
    const intents = { releaseTerminatedMessageDuplicateAction: jest.fn().mockResolvedValue(true) };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      undefined,
      undefined,
      intents as never,
    );
    const data = jobData();
    await expect(processor.process(workerJob(data) as never, 'token')).rejects.toThrow(
      'temporary source unavailable',
    );
    expect(ordering.abandon).not.toHaveBeenCalled();
    expect(intents.releaseTerminatedMessageDuplicateAction).not.toHaveBeenCalled();
  });

  it('cleans up an irrecoverable processing failure before attempts are exhausted', async () => {
    const ordering = {
      runInOrder: jest.fn().mockRejectedValue(new UnrecoverableError('content unsupported')),
      abandon: jest.fn(),
    };
    const intents = { releaseTerminatedMessageDuplicateAction: jest.fn().mockResolvedValue(true) };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      undefined,
      undefined,
      intents as never,
    );
    const data = jobData();
    await expect(processor.process(workerJob(data) as never, 'token')).rejects.toThrow(
      'content unsupported',
    );
    expect(ordering.abandon).toHaveBeenCalledTimes(1);
    expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'final-failure', 'unrecoverable-failure'] as const)(
    'recovers SQL cleanup after %s without repeating analysis or consuming the final attempt',
    async (cause) => {
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const data = jobData();
        if (cause === 'expired') {
          data.createdAt = new Date(now - 600_001).toISOString();
          data.deadlineAtMs = now - 1;
        }
        const execution = { processMessageDuplicateJob: jest.fn() };
        const originalError =
          cause === 'unrecoverable-failure'
            ? new UnrecoverableError('content unsupported')
            : new Error('final source failure');
        const ordering = {
          runInOrder: jest.fn(
            async (
              _identity: unknown,
              _eligible: boolean,
              operation: (lease: unknown, eligible: boolean) => Promise<unknown>,
            ) => {
              await operation({ assertOwned: jest.fn() }, true);
              throw originalError;
            },
          ),
          abandon: jest.fn().mockResolvedValue({ jobId: 'next-job', nextEligibleAtMs: now }),
        };
        let databaseAvailable = false;
        let successfulReleases = 0;
        const intents = {
          releaseTerminatedMessageDuplicateAction: jest.fn(async () => {
            if (!databaseAvailable) throw new Error('database unavailable');
            successfulReleases += 1;
            return true;
          }),
        };
        const nextJob = { changeDelay: jest.fn() };
        const queue = { getJob: jest.fn().mockResolvedValue(nextJob) };
        const processor = new MessageDuplicateProcessor(
          execution as never,
          ordering as never,
          undefined,
          queue as never,
          intents as never,
        );
        const job = workerJob(data, cause === 'unrecoverable-failure' ? 0 : 4);
        await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
        expect(job.data).toMatchObject({ cleanupOnly: 'terminated', actionEligible: false });
        expect(job.updateData.mock.invocationCallOrder[0]).toBeLessThan(
          ordering.abandon.mock.invocationCallOrder[0]!,
        );
        expect(job.moveToDelayed).toHaveBeenCalledWith(now + 30_000, 'token');
        expect(nextJob.changeDelay).toHaveBeenCalledWith(0);
        databaseAvailable = true;
        clock.mockReturnValue(now + 30_000);
        await processor.process(job as never, 'token');
        expect(successfulReleases).toBe(1);
        expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(2);
        expect(job.updateData).toHaveBeenCalledTimes(1);
        expect(ordering.runInOrder).toHaveBeenCalledTimes(cause === 'expired' ? 0 : 1);
        expect(execution.processMessageDuplicateJob).toHaveBeenCalledTimes(
          cause === 'expired' ? 0 : 1,
        );
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('releases an unused resumed claim after a successful early media rejection', async () => {
    const ordering = {
      runInOrder: jest.fn().mockResolvedValue({ kind: 'completed' }),
      abandon: jest.fn(),
    };
    const intents = { releaseTerminatedMessageDuplicateAction: jest.fn().mockResolvedValue(true) };
    const metrics = {
      record: jest.fn(),
      recordPhase: jest.fn(() => {
        throw new Error('observer unavailable');
      }),
    };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      metrics as never,
      undefined,
      intents as never,
    );
    const data = jobData();
    const job = workerJob(data);
    await processor.process(job as never, 'token');
    expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledWith(data);
    expect(metrics.recordPhase).toHaveBeenCalledWith('ordering_acquire', expect.any(Number));
    expect(metrics.recordPhase).toHaveBeenCalledWith('cleanup', expect.any(Number));
    expect(ordering.abandon).not.toHaveBeenCalled();
    expect(job.updateData).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('preserves a materialized intent permit while retrying cleanup after successful completion', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      let permit = true;
      const execution = { processMessageDuplicateJob: jest.fn() };
      const ordering = {
        runInOrder: jest.fn(
          async (
            _identity: unknown,
            _eligible: boolean,
            operation: (lease: unknown, eligible: boolean) => Promise<unknown>,
          ) => {
            await operation({ assertOwned: jest.fn() }, true);
            return { kind: 'completed', next: { jobId: 'next-job', nextEligibleAtMs: now } };
          },
        ),
        abandon: jest.fn(async () => {
          permit = false;
        }),
      };
      const intents = {
        releaseTerminatedMessageDuplicateAction: jest
          .fn()
          .mockRejectedValueOnce(new Error('database unavailable'))
          .mockResolvedValue(false),
      };
      const nextJob = { changeDelay: jest.fn() };
      const processor = new MessageDuplicateProcessor(
        execution as never,
        ordering as never,
        undefined,
        { getJob: jest.fn().mockResolvedValue(nextJob) } as never,
        intents as never,
      );
      const job = workerJob(jobData(), 4);
      await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
      expect(job.data).toMatchObject({ cleanupOnly: 'completed', actionEligible: false });
      expect(job.moveToDelayed).toHaveBeenCalledWith(now + 30_000, 'token');
      expect(nextJob.changeDelay).toHaveBeenCalledWith(0);
      await processor.process(job as never, 'token');
      expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(2);
      expect(execution.processMessageDuplicateJob).toHaveBeenCalledTimes(1);
      expect(ordering.runInOrder).toHaveBeenCalledTimes(1);
      expect(ordering.abandon).not.toHaveBeenCalled();
      expect(permit).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['completed', 'terminated'] as const)(
    'bounds %s cleanup recovery at the original deadline plus 24 hours',
    async (phase) => {
      const data = { ...jobData(), actionEligible: false, cleanupOnly: phase };
      const cutoff = data.deadlineAtMs + 24 * 60 * 60_000;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(cutoff - 1000);
      try {
        const ordering = { runInOrder: jest.fn(), abandon: jest.fn() };
        const intents = {
          releaseTerminatedMessageDuplicateAction: jest
            .fn()
            .mockRejectedValue(new Error('DB down')),
        };
        const processor = new MessageDuplicateProcessor(
          {} as never,
          ordering as never,
          undefined,
          undefined,
          intents as never,
        );
        const job = workerJob(data, 4);
        await expect(processor.process(job as never, 'token')).rejects.toBeInstanceOf(DelayedError);
        expect(job.moveToDelayed).toHaveBeenCalledWith(cutoff, 'token');
        clock.mockReturnValue(cutoff);
        await expect(processor.process(job as never, 'token')).rejects.toThrow(
          'terminal cleanup unavailable',
        );
        expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
        expect(ordering.runInOrder).not.toHaveBeenCalled();
        expect(job.updateData).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('preserves completed authority if persisting the cleanup marker also fails', async () => {
    const ordering = {
      runInOrder: jest.fn().mockResolvedValue({ kind: 'completed' }),
      abandon: jest.fn(),
    };
    const intents = {
      releaseTerminatedMessageDuplicateAction: jest.fn().mockRejectedValue(new Error('DB down')),
    };
    const processor = new MessageDuplicateProcessor(
      {} as never,
      ordering as never,
      undefined,
      undefined,
      intents as never,
    );
    const job = workerJob(jobData(), 4);
    job.updateData.mockRejectedValue(new Error('Redis unavailable'));
    await expect(processor.process(job as never, 'token')).rejects.toThrow('Redis unavailable');
    expect(ordering.abandon).not.toHaveBeenCalled();
    expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(1);
  });

  it.each([0, 4])(
    'only releases its unused claim on a final delayed-move failure (attempt %s)',
    async (attemptsMade) => {
      const ordering = {
        runInOrder: jest.fn().mockResolvedValue({
          kind: 'defer',
          reason: 'not_head',
          nextEligibleAtMs: Date.now() + 180_000,
        }),
        abandon: jest.fn(),
        postpone: postponeMock(),
      };
      const intents = {
        releaseTerminatedMessageDuplicateAction: jest.fn().mockResolvedValue(true),
      };
      const processor = new MessageDuplicateProcessor(
        {} as never,
        ordering as never,
        undefined,
        undefined,
        intents as never,
      );
      const data = jobData();
      const job = workerJob(data, attemptsMade);
      job.moveToDelayed.mockRejectedValue(new Error('queue unavailable'));
      await expect(processor.process(job as never, 'token')).rejects.toThrow('queue unavailable');
      expect(ordering.abandon).toHaveBeenCalledTimes(attemptsMade === 4 ? 1 : 0);
      expect(intents.releaseTerminatedMessageDuplicateAction).toHaveBeenCalledTimes(
        attemptsMade === 4 ? 1 : 0,
      );
    },
  );
});
