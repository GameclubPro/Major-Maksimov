import { Prisma } from '../prisma/prisma-client';

export function buildSafetyDeskOverviewPendingIndexQuery(): Prisma.Sql {
  return Prisma.sql`WITH required(name, relation, columns) AS (VALUES
    ('webhook_events_bot_id_status_created_at_idx', 'webhook_events', ARRAY['bot_id','status','created_at']),
    ('max_action_ledger_status_terminal_updated_idx', 'max_action_ledger', ARRAY['status','terminal','updated_at'])
  ) SELECT bool_and(EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_am am ON am.oid=c.relam
    WHERE i.indexrelid=to_regclass(required.name) AND i.indrelid=to_regclass(required.relation)
      AND i.indisvalid AND i.indisready AND i.indislive AND am.amname='btree'
      AND i.indnkeyatts=3 AND i.indnatts=3 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
        FROM generate_series(1,3) n ORDER BY n)=required.columns
  )) AS ready FROM required`;
}

export function buildSafetyDeskOverviewPendingQuery(
  botIds: readonly string[],
  defaultBotId: string | null,
): Prisma.Sql {
  // FLAG: The index constrains status AND terminal before the global action cap.
  // Filtering bot/terminal after an unbounded retained-history scan is forbidden.
  // Receipt probes are per bot; action groups describe a capped fleet sample.
  return Prisma.sql`WITH bounds AS MATERIALIZED (
    SELECT statement_timestamp() AT TIME ZONE 'UTC' AS observed_at
  ), bots AS MATERIALIZED (
    SELECT unnest(${[...botIds]}::text[]) AS bot_id
  ), receipt_scopes AS MATERIALIZED (
    SELECT bot_id, bot_id AS source_bot_id FROM bots
    UNION ALL SELECT bot_id, NULL::text FROM bots WHERE bot_id=${defaultBotId}::text
  ), receipt_statuses(status) AS (VALUES ('RECEIVED'::"WebhookStatus"), ('QUEUED'::"WebhookStatus")),
  receipt_heads AS MATERIALIZED (
    SELECT scope.bot_id, status.status, head.created_at, head.ordinal
    FROM receipt_scopes scope CROSS JOIN receipt_statuses status
    CROSS JOIN LATERAL (
      SELECT created_at, row_number() OVER () AS ordinal FROM (
        SELECT created_at FROM webhook_events
        WHERE scope.source_bot_id IS NOT NULL AND bot_id=scope.source_bot_id AND status=status.status
        ORDER BY created_at LIMIT 65
      ) covered
      UNION ALL
      SELECT created_at, row_number() OVER () AS ordinal FROM (
        SELECT created_at FROM webhook_events
        WHERE scope.source_bot_id IS NULL AND bot_id IS NULL AND status=status.status
        ORDER BY created_at LIMIT 65
      ) legacy
    ) head
  ), action_statuses(status) AS (VALUES
    ('ENQUEUED'::"MaxActionLedgerStatus"), ('IN_PROGRESS'::"MaxActionLedgerStatus"),
    ('SUCCEEDED'::"MaxActionLedgerStatus"), ('SKIPPED'::"MaxActionLedgerStatus"),
    ('AMBIGUOUS'::"MaxActionLedgerStatus"), ('FAILED_RETRYABLE'::"MaxActionLedgerStatus"),
    ('FAILED_TERMINAL'::"MaxActionLedgerStatus")
  ), action_heads AS MATERIALIZED (
    SELECT state.status, head.id, head.updated_at, head.ordinal
    FROM action_statuses state CROSS JOIN LATERAL (
      SELECT id, updated_at, row_number() OVER () AS ordinal FROM (
        SELECT id, updated_at FROM max_action_ledger
        WHERE status=state.status AND terminal=false ORDER BY updated_at LIMIT 65
      ) covered
    ) head
  ), action_details AS MATERIALIZED (
    SELECT COALESCE(detail.bot_id, ${defaultBotId}::text) AS bot_id, head.updated_at
    FROM action_heads head CROSS JOIN LATERAL (
      SELECT bot_id FROM max_action_ledger WHERE id=head.id OFFSET 0
    ) detail WHERE head.ordinal<=64
  )
  SELECT jsonb_build_object(
    'observedAt', to_char(bounds.observed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'invalidClocks', EXISTS(SELECT 1 FROM receipt_heads WHERE created_at>bounds.observed_at)
      OR EXISTS(SELECT 1 FROM action_heads WHERE updated_at>bounds.observed_at),
    'unfinishedActions', jsonb_build_object(
      'countLowerBound', (SELECT count(*) FROM action_details),
      'truncated', EXISTS(SELECT 1 FROM action_heads WHERE ordinal=65),
      'oldestStateAt', (SELECT to_char(min(updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM action_details)
    ),
    'bots', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'botId', bots.bot_id,
      'received', jsonb_build_object(
        'countLowerBound', (SELECT count(*) FROM receipt_heads h WHERE h.bot_id=bots.bot_id AND h.status='RECEIVED' AND ordinal<=64),
        'truncated', EXISTS(SELECT 1 FROM receipt_heads h WHERE h.bot_id=bots.bot_id AND h.status='RECEIVED' AND ordinal=65),
        'oldestAt', (SELECT to_char(min(created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM receipt_heads h WHERE h.bot_id=bots.bot_id AND h.status='RECEIVED')
      ),
      'queued', jsonb_build_object(
        'countLowerBound', (SELECT count(*) FROM receipt_heads h WHERE h.bot_id=bots.bot_id AND h.status='QUEUED' AND ordinal<=64),
        'truncated', EXISTS(SELECT 1 FROM receipt_heads h WHERE h.bot_id=bots.bot_id AND h.status='QUEUED' AND ordinal=65),
        'oldestAt', (SELECT to_char(min(created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM receipt_heads h WHERE h.bot_id=bots.bot_id AND h.status='QUEUED')
      ),
      'unfinishedActions', jsonb_build_object(
        'countLowerBound', (SELECT count(*) FROM action_details d WHERE d.bot_id=bots.bot_id),
        'truncated', EXISTS(SELECT 1 FROM action_heads WHERE ordinal=65),
        'oldestStateAt', (SELECT to_char(min(updated_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM action_details d WHERE d.bot_id=bots.bot_id)
      )
    ) ORDER BY bots.bot_id), '[]'::jsonb) FROM bots)
  ) AS snapshot FROM bounds`;
}
