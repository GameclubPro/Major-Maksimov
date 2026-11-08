// FLAG: Decode only schema DateTime columns. A name ending in _at can be a
// String, including required_subscription_expires_at, whose exact value is evidence.
// The schema regression checks this complete table/column map against Prisma.
export const SOURCE_INVENTORY_DATE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  webhook_events: [
    'execution_deadline_at',
    'queued_at',
    'next_enqueue_at',
    'timeout_quarantine_expires_at',
    'created_at',
    'processed_at',
  ],
  webhook_execution_claims: [
    'business_started_at',
    'lease_expires_at',
    'prepared_at',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  chat_settings: [
    'link_policy_effective_at',
    'traffic_policy_effective_at',
    'created_at',
    'updated_at',
  ],
  moderation_delete_intents: [
    'source_message_at',
    'commercial_ocr_deadline_at',
    'execute_at',
    'next_attempt_at',
    'retry_until_at',
    'delete_dispatch_started_at',
    'remote_delete_succeeded_at',
    'first_attempt_at',
    'last_attempt_at',
    'completed_at',
    'absence_verified_at',
    'lease_expires_at',
    'created_at',
    'updated_at',
  ],
  moderation_delete_intent_reasons: ['created_at', 'updated_at'],
  moderation_rule_followups: [
    'source_at',
    'deadline_at',
    'next_attempt_at',
    'lease_expires_at',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  moderation_events: ['created_at'],
  moderation_violation_message_claims: ['created_at'],
  spammer_observations: [
    'raw_evidence_expires_at',
    'observed_at',
    'expires_at',
    'suppressed_at',
    'created_at',
    'updated_at',
  ],
  max_action_ledger: [
    'dispatch_started_at',
    'enqueued_at',
    'scheduled_for_at',
    'first_attempt_at',
    'last_attempt_at',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  channel_auto_post_attach_markers: [
    'locked_at',
    'replacement_send_started_at',
    'created_at',
    'updated_at',
  ],
};

export class SourceInventoryRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function dateValue(value: unknown): Date | null {
  if (value === null) return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string'
        ? new Date(/[zZ]|[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`)
        : null;
  if (!date || !Number.isFinite(date.getTime()))
    throw new SourceInventoryRefused('sql_date_value_unproved');
  return date;
}

export function sourceInventoryPrismaRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(SOURCE_INVENTORY_DATE_COLUMNS, table))
    throw new SourceInventoryRefused('sql_descriptor_invalid');
  const dates = SOURCE_INVENTORY_DATE_COLUMNS[table];
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      dates.includes(key) ? dateValue(value) : value,
    ]),
  );
}
