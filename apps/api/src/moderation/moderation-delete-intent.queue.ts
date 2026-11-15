import { reserveDeleteSweepAdmission } from './moderation-delete-sweep-admission';
import { ErrorCode, Job, type JobJsonRaw, type Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

export const MODERATION_DELETE_INTENT_QUEUE = 'moderation-delete-intents';

export type ModerationDeleteIntentJob = {
  intentId: string;
  handoffToken?: string;
};

type SweepQueue = Pick<Queue<ModerationDeleteIntentJob>, 'getJob' | 'add'>;
type SweepJobObservation = Job<ModerationDeleteIntentJob> | 'missing' | 'error';
const SWEEP_OBSERVATION_BATCH_SIZE = 100;

export type ModerationDeleteSweepHandoff = {
  insertion: 'inserted' | 'existing' | 'unknown' | 'deferred';
  reused: boolean;
  observationErrors: number;
};

export async function handoffModerationDeleteSweepJob(
  queue: SweepQueue,
  intentId: string,
  priority: number,
): Promise<ModerationDeleteSweepHandoff> {
  const jobId = `mdi-${intentId}`;
  let observation: SweepJobObservation;
  try {
    observation = (await queue.getJob(jobId)) ?? 'missing';
  } catch {
    observation = 'error';
  }
  return handoffObservedModerationDeleteSweepJob(queue, intentId, priority, observation);
}

export async function handoffModerationDeleteSweepJobs(
  queue: Queue<ModerationDeleteIntentJob>,
  intentIds: readonly string[],
  priority: number,
  historicalWindow?: number,
): Promise<Array<PromiseSettledResult<ModerationDeleteSweepHandoff>>> {
  const outcomes: Array<PromiseSettledResult<ModerationDeleteSweepHandoff>> = [];
  for (let offset = 0; offset < intentIds.length; offset += SWEEP_OBSERVATION_BATCH_SIZE) {
    const batch = intentIds.slice(offset, offset + SWEEP_OBSERVATION_BATCH_SIZE);
    const observations = await observeModerationDeleteSweepJobs(queue, batch);
    const missingCount = observations.filter((value) => typeof value === 'string').length;
    let reservation: Awaited<ReturnType<typeof reserveDeleteSweepAdmission>> | undefined;
    let reservationError: unknown;
    if (historicalWindow !== undefined && missingCount) {
      try {
        reservation = await reserveDeleteSweepAdmission(queue, missingCount, historicalWindow);
      } catch (error: unknown) {
        reservationError = error;
      }
    }
    let missingIndex = 0;
    const acknowledgedReservations: number[] = [];
    outcomes.push(
      ...(await Promise.allSettled(
        batch.map(async (intentId, index) => {
          const observation = observations[index]!;
          if (typeof observation !== 'string')
            return handoffObservedModerationDeleteSweepJob(queue, intentId, priority, observation);
          if (reservationError) throw reservationError;
          const slot = missingIndex++;
          if (reservation && slot >= reservation.count)
            return {
              insertion: 'deferred' as const,
              reused: false,
              observationErrors: observation === 'error' ? 1 : 0,
            };
          const result = await handoffObservedModerationDeleteSweepJob(
            queue,
            intentId,
            priority,
            observation,
          );
          if (reservation) acknowledgedReservations.push(slot);
          return result;
        }),
      )),
    );
    // FLAG: A failed add can have reached Redis. Retain its permit until expiry;
    // a failed release also only reduces admission temporarily. SQL remains due.
    // Delayed Redis commands beyond the TTL can overshoot the historical target;
    // queue counts stop subsequent admission, without removing any existing job.
    if (reservation) await reservation.release(acknowledgedReservations).catch(() => undefined);
  }
  return outcomes;
}

async function observeModerationDeleteSweepJobs(
  queue: Queue<ModerationDeleteIntentJob>,
  intentIds: readonly string[],
): Promise<SweepJobObservation[]> {
  let results: unknown;
  try {
    const pipeline = (await queue.client).pipeline();
    for (const intentId of intentIds) pipeline.hgetall(queue.toKey(`mdi-${intentId}`));
    results = await pipeline.exec();
  } catch {
    return intentIds.map(() => 'error');
  }
  if (!Array.isArray(results) || results.length !== intentIds.length)
    return intentIds.map(() => 'error');

  return results.map((entry: unknown, index): SweepJobObservation => {
    if (!Array.isArray(entry) || entry.length !== 2 || entry[0] !== null) return 'error';
    const data: unknown = entry[1];
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'error';
    const raw: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string') return 'error';
      raw[key] = value;
    }
    if (Object.keys(raw).length === 0) return 'missing';
    if (['name', 'data', 'opts', 'delay', 'priority', 'timestamp'].some((key) => !(key in raw)))
      return 'error';
    const jobId = `mdi-${intentIds[index]!}`;
    const encoded: JobJsonRaw = {
      ...raw,
      id: raw.id || jobId,
      name: raw.name!,
      data: raw.data!,
      opts: raw.opts!,
      delay: raw.delay!,
      priority: raw.priority!,
      timestamp: raw.timestamp!,
      progress: raw.progress || '0',
      failedReason: raw.failedReason || '',
      returnvalue: raw.returnvalue || 'null',
    };
    try {
      // FLAG: Match BullMQ getJob's public decoder instead of trusting key presence.
      // Pipeline observations live only for this sweep; the next SQL pass repairs a vanished job.
      return Job.fromJSON<ModerationDeleteIntentJob>(queue, encoded, jobId);
    } catch {
      return 'error';
    }
  });
}

async function handoffObservedModerationDeleteSweepJob(
  queue: SweepQueue,
  intentId: string,
  priority: number,
  observation: SweepJobObservation,
): Promise<ModerationDeleteSweepHandoff> {
  const jobId = `mdi-${intentId}`;
  const observationErrors = observation === 'error' ? 1 : 0;
  if (typeof observation !== 'string') {
    // FLAG: A due SQL reason can precede a previously scheduled Redis wakeup.
    // Only advance its wakeup; the worker still reloads SQL and all effect guards.
    await promoteDueWakeup(observation);
    // If it disappears now, the next DB sweep repairs it; SQL still owns execution.
    return { insertion: 'existing', reused: true, observationErrors };
  }
  // FLAG: An observational failure must not suppress the original deterministic handoff.

  const handoffToken = randomUUID();
  await queue.add(
    'execute-moderation-delete-intent',
    { intentId, handoffToken },
    { jobId, priority, attempts: 1, removeOnComplete: true, removeOnFail: true },
  );
  try {
    const persisted = await queue.getJob(jobId);
    // FLAG: BullMQ returns the caller's Job even for a duplicate ID. Only the
    // token read from persisted data proves our insertion; it grants no effect authority.
    // A different token may be a replacement after our job completed, so it proves neither outcome.
    return {
      insertion: persisted?.data.handoffToken === handoffToken ? 'inserted' : 'unknown',
      reused: false,
      observationErrors,
    };
  } catch {
    // FLAG: Redis already acknowledged add. A failed observation is uncertainty,
    // not a failed handoff and never permission to retry an external effect.
    return { insertion: 'unknown', reused: false, observationErrors: observationErrors + 1 };
  }
}

/** Queue hints only: the worker must re-read the original SQL schedule and authority. */
export async function enqueueModerationDeleteWakeup(
  queue: SweepQueue,
  intentId: string,
  priority: number,
  delay = 0,
): Promise<void> {
  const jobId = `mdi-${intentId}`;
  await queue.add(
    'execute-moderation-delete-intent',
    { intentId },
    { jobId, priority, delay, attempts: 1, removeOnComplete: true, removeOnFail: true },
  );
  // FLAG: Duplicate add returns requested options, not persisted priority/delay.
  // Never postpone an existing wakeup or downgrade its priority. A future earlier
  // SQL reason is recovered by the bounded due sweep once that reason is due.
  const persisted = await queue.getJob(jobId);
  if (!persisted) return;
  if (priority === 1 && persisted.priority > priority) {
    await persisted.changePriority({ priority });
  }
  if (delay === 0) await promoteDueWakeup(persisted);
}

async function promoteDueWakeup(job: Job<ModerationDeleteIntentJob>): Promise<void> {
  if (!(job.delay > 0)) return;
  try {
    await job.promote();
  } catch (error: unknown) {
    // FLAG: A concurrent promotion/completion may consume the delayed membership.
    // Never remove/recreate an active job; a missing job is repaired next SQL sweep.
    if (error instanceof Error && 'code' in error && error.code === ErrorCode.JobNotInState) return;
    throw error;
  }
}
