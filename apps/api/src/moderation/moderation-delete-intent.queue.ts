import { Job, type JobJsonRaw, type Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

export const MODERATION_DELETE_INTENT_QUEUE = 'moderation-delete-intents';

export type ModerationDeleteIntentJob = {
  intentId: string;
  handoffToken?: string;
};

type SweepQueue = Pick<Queue<ModerationDeleteIntentJob>, 'getJob' | 'add'>;
type SweepJobObservation = 'existing' | 'missing' | 'error';
const SWEEP_OBSERVATION_BATCH_SIZE = 100;

export type ModerationDeleteSweepHandoff = {
  insertion: 'inserted' | 'existing' | 'unknown';
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
    observation = (await queue.getJob(jobId)) ? 'existing' : 'missing';
  } catch {
    observation = 'error';
  }
  return handoffObservedModerationDeleteSweepJob(queue, intentId, priority, observation);
}

export async function handoffModerationDeleteSweepJobs(
  queue: Queue<ModerationDeleteIntentJob>,
  intentIds: readonly string[],
  priority: number,
): Promise<Array<PromiseSettledResult<ModerationDeleteSweepHandoff>>> {
  const outcomes: Array<PromiseSettledResult<ModerationDeleteSweepHandoff>> = [];
  for (let offset = 0; offset < intentIds.length; offset += SWEEP_OBSERVATION_BATCH_SIZE) {
    const batch = intentIds.slice(offset, offset + SWEEP_OBSERVATION_BATCH_SIZE);
    const observations = await observeModerationDeleteSweepJobs(queue, batch);
    outcomes.push(
      ...(await Promise.allSettled(
        batch.map((intentId, index) =>
          handoffObservedModerationDeleteSweepJob(queue, intentId, priority, observations[index]!),
        ),
      )),
    );
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
      Job.fromJSON<ModerationDeleteIntentJob>(queue, encoded, jobId);
      return 'existing';
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
  if (observation === 'existing') {
    // FLAG: Deterministic add would reuse this same job without changing it.
    // If it disappears now, the next DB sweep repairs the wakeup; SQL still owns execution.
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
