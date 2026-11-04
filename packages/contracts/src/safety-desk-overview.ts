import { z } from 'zod';

export const safetyDeskOverviewAvailabilitySchema = z.enum([
  'FRESH',
  'STALE',
  'UNAVAILABLE',
  'INVALID',
]);
const count = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime();

const observation = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({
      availability: safetyDeskOverviewAvailabilitySchema,
      observedAt: timestamp.nullable(),
      value: value.nullable(),
    })
    .strict()
    .superRefine((row, ctx) => {
      const measurement: unknown = 'value' in row ? row.value : undefined;
      if (
        (row.availability === 'FRESH' || row.availability === 'STALE') &&
        (row.observedAt === null || measurement === null || measurement === undefined)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Observed evidence requires a value and timestamp',
        });
      }
      if (
        (row.availability === 'UNAVAILABLE' || row.availability === 'INVALID') &&
        measurement !== null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Missing evidence cannot carry measurements',
        });
      }
    });

export const safetyDeskOverviewPendingSchema = z
  .object({
    countLowerBound: count,
    sampleComplete: z.boolean(),
    oldestAgeMs: count.nullable(),
    ageBasis: z.enum(['receipt_created', 'state_updated_sample']),
  })
  .strict();

export const safetyDeskOverviewPercentilesSchema = z
  .object({
    sampleCount: count.max(5000),
    p50Ms: count.nullable(),
    p95Ms: count.nullable(),
    p99Ms: count.nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const values = [row.p50Ms, row.p95Ms, row.p99Ms];
    const empty = row.sampleCount === 0;
    if (empty ? values.some((value) => value !== null) : values.some((value) => value === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Percentiles must match their sample count',
      });
    }
    if (
      row.p50Ms !== null &&
      row.p95Ms !== null &&
      row.p99Ms !== null &&
      (row.p50Ms > row.p95Ms || row.p95Ms > row.p99Ms)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Latency percentiles must be monotonic',
      });
    }
  });
const percentiles = safetyDeskOverviewPercentilesSchema;
const pending = safetyDeskOverviewPendingSchema;
const bot = z
  .object({
    botId: z.string().min(1).max(120),
    label: z.string().min(1).max(160),
    kind: z.enum(['moderator', 'publisher']),
    state: z.enum(['active', 'draining', 'dormant', 'disabled', 'configured']),
    subscription: observation(
      z
        .object({
          configured: z.boolean(),
          subscribed: z.boolean(),
          lastIncomingAt: timestamp.nullable(),
        })
        .strict(),
    ),
    publisher: observation(
      z
        .object({
          dispatchEnabled: z.boolean(),
          blocker: z.string().max(120).nullable(),
        })
        .strict(),
    ).nullable(),
    pendingReceipts: observation(pending),
    actionLatency: observation(percentiles),
    unfinishedActions: observation(pending),
    lastTerminalAt: observation(z.object({ at: timestamp.nullable() }).strict()),
    outcomes: observation(
      z.array(z.object({ outcome: z.string().max(80), count }).strict()).max(16),
    ),
  })
  .strict();

export const safetyDeskOverviewHistoryPointSchema = z
  .object({
    at: timestamp,
    waiting: count.nullable(),
    active: count.nullable(),
    delayed: count.nullable(),
    oldestReceiptAgeMs: count.nullable(),
    oldestActionAgeMs: count.nullable(),
    p50Ms: count.nullable(),
    p95Ms: count.nullable(),
    p99Ms: count.nullable(),
  })
  .strict();

export const safetyDeskOverviewResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: timestamp,
    collector: z
      .object({
        availability: safetyDeskOverviewAvailabilitySchema,
        observedAt: timestamp.nullable(),
        lastSuccessfulAt: timestamp.nullable(),
      })
      .strict(),
    queues: observation(
      z
        .object({
          rows: z
            .array(
              z
                .object({
                  name: z.string().min(1).max(160),
                  family: z.enum(['webhook', 'actions', 'auxiliary']),
                  waiting: count,
                  prioritized: count,
                  active: count,
                  delayed: count,
                  failed: count,
                  completed: count,
                })
                .strict(),
            )
            .max(512),
        })
        .strict(),
    ),
    receipts: observation(pending),
    unfinishedActions: observation(pending),
    actions: observation(
      z
        .object({
          windowSec: z.literal(900),
          windowStartedAt: timestamp,
          windowEndedAt: timestamp,
          sampleCount: count.max(5000),
          sampleComplete: z.boolean(),
          latency: percentiles,
          outcomes: z.array(z.object({ outcome: z.string().max(80), count }).strict()).max(16),
        })
        .strict(),
    ),
    workers: observation(
      z
        .object({
          expectedCount: count.max(64),
          freshCount: count.max(64),
          rows: z
            .array(
              z.object({ service: z.string().max(120), observedAt: timestamp.nullable() }).strict(),
            )
            .max(64),
        })
        .strict(),
    ),
    bots: z.array(bot).max(64),
    history: z
      .object({
        availability: safetyDeskOverviewAvailabilitySchema,
        observedAt: timestamp.nullable(),
        windowSec: z.literal(86400),
        bucketSec: z.literal(60),
        retentionPoints: z.literal(1440),
        points: z.array(safetyDeskOverviewHistoryPointSchema).max(1440),
      })
      .strict(),
  })
  .strict();

export type SafetyDeskOverviewResponse = z.infer<typeof safetyDeskOverviewResponseSchema>;
export type SafetyDeskOverviewPending = z.infer<typeof safetyDeskOverviewPendingSchema>;
export type SafetyDeskOverviewPercentiles = z.infer<typeof safetyDeskOverviewPercentilesSchema>;
export type SafetyDeskOverviewHistoryPoint = z.infer<typeof safetyDeskOverviewHistoryPointSchema>;
export type SafetyDeskOverviewObservation<T> = {
  availability: z.infer<typeof safetyDeskOverviewAvailabilitySchema>;
  observedAt: string | null;
  value: T | null;
};
