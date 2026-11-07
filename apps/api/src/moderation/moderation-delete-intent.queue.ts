import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

export const MODERATION_DELETE_INTENT_QUEUE = 'moderation-delete-intents';

export type ModerationDeleteIntentJob = {
  intentId: string;
  handoffToken?: string;
};

type SweepQueue = Pick<Queue<ModerationDeleteIntentJob>, 'getJob' | 'add'>;

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
  let observationErrors = 0;
  try {
    if (await queue.getJob(jobId)) {
      // FLAG: Deterministic add would reuse this same job without changing it.
      // If it disappears now, the next DB sweep repairs the wakeup; SQL still owns execution.
      return { insertion: 'existing', reused: true, observationErrors };
    }
  } catch {
    // FLAG: An observational failure must not suppress the original deterministic handoff.
    observationErrors++;
  }

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
