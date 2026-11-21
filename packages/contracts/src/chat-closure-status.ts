import { z } from 'zod';

export const nightModeNoticeEvidenceReasonSchema = z.enum([
  'successful_receipt',
  'ledger_missing',
  'awaiting_first_attempt',
  'proven_pre_dispatch_failure',
  'ledger_unavailable',
  'identity_mismatch',
  'ambiguous',
  'incomplete_success',
  'attempted_without_receipt',
  'terminal_without_receipt',
  'unrecognized_state',
]);

export const nightModeNoticeDeliveryEvidenceSchema = z.object({
  outcome: z.enum(['sent', 'not_recorded', 'pending', 'not_sent', 'unknown']),
  reason: nightModeNoticeEvidenceReasonSchema,
  sentAt: z.string().datetime().nullable(),
});

export const nightModeNoticeObservationSchema = z.object({
  enabledNow: z.boolean(),
  latest: z
    .object({
      sessionKey: z.string().min(1),
      scheduledFor: z.string().datetime(),
      catchUp: z.object({
        state: z.enum(['within_window', 'expired']),
        endsAt: z.string().datetime(),
      }),
      scheduling: z.enum(['recorded', 'not_recorded', 'mismatch', 'unknown']),
      delivery: nightModeNoticeDeliveryEvidenceSchema,
    })
    .nullable(),
});

export const nightModeNoticeDiagnosticsSchema = z.object({
  expectationBasis: z.literal('current_schedule'),
  boundary: z.enum(['daily', 'continuous', 'unavailable']),
  evidenceScope: z.literal('exact_send_ledger'),
  sendRouteNow: z.enum(['available', 'unavailable', 'unknown']),
  close: nightModeNoticeObservationSchema,
  open: nightModeNoticeObservationSchema,
  recovery: z.object({
    scope: z.literal('latest_occurrences'),
    observation: z.enum(['complete', 'partial', 'unavailable']),
    obligations: z.array(
      z.object({
        kind: z.enum(['close_notice_event', 'open_notice_event', 'close_notice_cleanup']),
        sessionKey: z.string().min(1),
        scheduledFor: z.string().datetime(),
        state: z.enum(['recorded', 'action_required']),
      }),
    ),
  }),
});

export const chatClosureStatusSchema = z.object({
  observedAt: z.string().datetime(),
  scheduleEnabled: z.boolean(),
  restriction: z.enum(['open', 'night', 'manual']),
  timezone: z.string(),
  opensAt: z.string().nullable(),
  deleteRoute: z.enum(['available', 'unavailable', 'unknown']),
  notice: z.enum([
    'disabled',
    'not_expected',
    'not_recorded',
    'pending',
    'delivered',
    'unknown',
    'failed',
  ]),
  recovery: z.enum(['idle', 'waiting', 'delayed', 'action_required', 'unknown']),
  notices: nightModeNoticeDiagnosticsSchema.optional(),
  nextTransitionAt: z.string().datetime().nullable().optional(),
});
export const chatClosureSummarySchema = chatClosureStatusSchema
  .pick({
    observedAt: true,
    scheduleEnabled: true,
    restriction: true,
    timezone: true,
    opensAt: true,
    deleteRoute: true,
  })
  .extend({
    nextTransitionAt: z.string().datetime().nullable(),
    nightActive: z.boolean(),
    manualMode: z.enum(['timed', 'forever']).nullable(),
    notificationsEnabled: z.boolean(),
    sendRoute: z.enum(['available', 'unavailable', 'unknown']),
  });
export type ChatClosureSummary = z.infer<typeof chatClosureSummarySchema>;

export type ChatClosureStatus = z.infer<typeof chatClosureStatusSchema>;
export type NightModeNoticeEvidenceReason = z.infer<typeof nightModeNoticeEvidenceReasonSchema>;
export type NightModeNoticeDeliveryEvidence = z.infer<typeof nightModeNoticeDeliveryEvidenceSchema>;
export type NightModeNoticeObservation = z.infer<typeof nightModeNoticeObservationSchema>;
export type NightModeNoticeDiagnostics = z.infer<typeof nightModeNoticeDiagnosticsSchema>;
