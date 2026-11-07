import { z } from 'zod';

const count = z.number().int().nonnegative().safe();
const clock = z.iso.datetime().nullable();
const nodeOrder = ['server-9b', 'pc-a-4b', 'pc-b-9b', 'pc-a-cpu-9b'] as const;
const nodeId = z.enum(nodeOrder);
const attemptMetrics = z
  .object({
    nodeId,
    completedAttempts: count,
    failedAttempts: count,
    lastCompletedAt: clock,
    lastFailureAt: clock,
    ewmaDurationMs: z.number().finite().min(1).max(20_000).nullable(),
  })
  .strict();

export const commercialAiPoolDiagnosticsSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z
      .array(attemptMetrics)
      .min(3)
      .max(4)
      .refine((nodes) => nodes.every((node, index) => node.nodeId === nodeOrder[index])),
    consultations: z
      .object({
        completed: count,
        noCapacity: count,
        budgetExhausted: count,
      })
      .strict(),
  })
  .strict();

export const safetyDeskCommercialAiPoolResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    observedAt: clock,
    workersEnabled: z.boolean(),
    routingEnabled: z.boolean(),
    policy: z.enum(['confirm-positive', 'direct-4b']),
    availability: z.enum(['DISABLED', 'FRESH', 'STALE', 'INVALID', 'UNAVAILABLE']),
    nodes: z
      .array(
        z
          .object({
            nodeId,
            state: z.enum(['READY', 'SLOT_OCCUPIED', 'NOT_READY', 'OFFLINE', 'INVALID', 'STALE']),
            validUntil: clock,
          })
          .strict(),
      )
      .min(3)
      .max(4)
      .refine((nodes) => nodes.every((node, index) => node.nodeId === nodeOrder[index]))
      .nullable(),
    metrics: z
      .object({
        availability: z.enum(['FRESH', 'STALE']),
        observedAt: z.iso.datetime(),
        observationProcessId: z.uuid(),
        observationStartedAt: z.iso.datetime(),
        basis: z.literal('PROCESS_MODEL_ATTEMPTS'),
        diagnostics: commercialAiPoolDiagnosticsSchema,
      })
      .strict()
      .nullable(),
    // FLAG: Slot occupancy and accepted model responses prove neither traffic coverage nor DELETE.
    trafficCoverage: z.literal('NOT_ESTABLISHED'),
    confirmedDeletes: z.null(),
  })
  .strict();

export type CommercialAiPoolDiagnostics = z.infer<typeof commercialAiPoolDiagnosticsSchema>;
export type SafetyDeskCommercialAiPoolResponse = z.infer<
  typeof safetyDeskCommercialAiPoolResponseSchema
>;
