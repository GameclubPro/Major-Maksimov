import { z } from 'zod';

const count = z.number().int().nonnegative().safe();
const clock = z.iso.datetime().nullable();

export const safetyDeskCommercialAiResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    observedAt: clock,
    mode: z.enum(['OFF', 'OBSERVE', 'DELETE_ONLY']),
    availability: z.enum([
      'DISABLED',
      'OBSERVING',
      'FRESH',
      'STALE',
      'MISSING',
      'INVALID',
      'UNAVAILABLE',
    ]),
    heartbeatAt: clock,
    lastRecordedResultAt: clock,
    observationStartedAt: clock,
    observationProcessId: z.uuid().nullable(),
    active: count.max(4).nullable(),
    admission: z.enum(['UNKNOWN', 'READY', 'GOVERNOR_PAUSED', 'HEADROOM_PAUSED']),
    admissionObservedAt: clock,
    outcomeBasis: z.literal('PROCESS_CUMULATIVE'),
    outcomes: z
      .object({
        kept: count,
        unsure: count,
        deleteRegistered: count,
        deleteNotAdmitted: count,
        registrationUnknown: count,
        capacitySkipped: count,
        unavailableSkipped: count,
        sourceExpired: count,
        pressureSkipped: count,
        dependencyUnavailable: count,
        other: count,
      })
      .strict()
      .nullable(),
    pendingDiscardBasis: z.literal('REDIS_NAMESPACE_CUMULATIVE'),
    pendingDiscards: z
      .object({
        expired: count,
        foreignWorker: count,
        invalidPending: count,
      })
      .strict()
      .nullable(),
    // FLAG: A live worker and registered intent do not prove traffic coverage or a remote DELETE.
    trafficCoverage: z.literal('NOT_ESTABLISHED'),
    confirmedDeletes: z.null(),
  })
  .strict();

export type SafetyDeskCommercialAiResponse = z.infer<typeof safetyDeskCommercialAiResponseSchema>;
