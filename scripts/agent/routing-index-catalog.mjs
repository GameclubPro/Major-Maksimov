import { ROUTING_INDEX_TARGET } from './routing-index-online-target.mjs';
import {
  OUTCOME_COHORT_HISTORICAL_COMPATIBILITY,
  historicalCompatibilityCtes,
  historicalCompatibilityProjection,
} from './outcome-cohort-historical-compatibility.mjs';
import { validateOnlineMigrationReceipts } from './online-migration-receipts.mjs';

const fail = (code) => {
  throw new Error(`ROUTING_INDEX_${code}`);
};
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
// FLAG: Only these verified failed versions can accompany the pinned later successful
// version of the same migration. They never satisfy an applied-migration requirement.
const RECOVERED_PREDECESSORS = new Map([
  [
    '20260621120000_optimize_spammer_review',
    [
      '456919e50cecb0b00a54d65ccb346598f9781498c446179e483ea99cf2e93c95',
      '6e96a71a4c760dd910c5db0718af0747fb4f629395e6a4754cde5e0609dcfb34',
    ],
  ],
  [
    '20260628133000_managed_broadcast_lock_tokens_and_validated_invariants',
    [
      '4534eb15d6901acbbc8b48431c43f2a156bb5db99cf518daa4165687c4a9fa28',
      'a5d45563f971a020aa1882252f34151fb6600a78b402ed0e3dc6246a5c7315d1',
    ],
  ],
  [
    '20260706193000_channel_suggestion_admin_delivery_ledger',
    [
      'e2130f6974440b0dfe2d755ffab65aaa19544655b69208df377d9a9012e62de0',
      '05df7d649aa18455a35c7a57e75818900423a6d82ec6bbe1e2fc75a78dab6aa9',
    ],
  ],
  [
    '20260718100000_add_publication_delivery_content_revision',
    [
      'c0c095a4943c31d34262c589df61d59466d5119a09d7dca8934362ddc53f26ca',
      '4f995d7f4bac9181ed04abed4799d559c2f1e8dc827c45e2a9d8864cce8cb00e',
    ],
  ],
]);

function isRecoveredPredecessor(receipt, sourceChecksum, applied, rollbackCount) {
  const rule = RECOVERED_PREDECESSORS.get(receipt.name);
  return Boolean(
    rule &&
    receipt.checksum === rule[0] &&
    receipt.finished === false &&
    receipt.steps === 0 &&
    sourceChecksum === rule[1] &&
    applied?.checksum === rule[1] &&
    applied.steps === 1 &&
    typeof receipt.started_at === 'string' &&
    typeof applied.started_at === 'string' &&
    Date.parse(receipt.started_at) < Date.parse(applied.started_at) &&
    rollbackCount === 1,
  );
}

// PostgreSQL's deparsed expressions are pinned from the native PostgreSQL 16 fixture.
export const ROUTING_INDEX_EXPRESSION =
  "COALESCE(NULLIF(btrim(((normalized_payload -> 'message'::text) ->> 'chatId'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'chatId'::text)), ''::text))";
export const ROUTING_INDEX_PREDICATE =
  "(((status = ANY (ARRAY['RECEIVED'::\"WebhookStatus\", 'QUEUED'::\"WebhookStatus\"])) OR ((status = 'FAILED'::\"WebhookStatus\") AND ((next_enqueue_at IS NOT NULL) OR (\"left\"(COALESCE(error_message, ''::text), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'::text)))) AND (lower(COALESCE(NULLIF(btrim((normalized_payload ->> 'type'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'update_type'::text)), ''::text))) = ANY (ARRAY['message_created'::text, 'message_edited'::text])))";

export const routingIndexStateSql = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '2500ms';
SET LOCAL lock_timeout = '250ms';
SET LOCAL max_parallel_workers_per_gather = 0;
DO $guard$ BEGIN
  IF to_regclass('public._prisma_migrations') IS NULL
    OR pg_total_relation_size('public._prisma_migrations') > 8388608 THEN
    RAISE EXCEPTION 'ROUTING_INDEX_RECEIPT_METADATA_UNAVAILABLE';
  END IF;
END $guard$;
WITH definition AS MATERIALIZED (
 SELECT relation.oid IS NOT NULL AS present,
  COALESCE(current_setting('server_version_num')::int BETWEEN 160000 AND 169999
    AND relation.relkind = 'i' AND relation.relpersistence = 'p'
    AND relation.reltablespace = 0 AND relation.reloptions IS NULL
    AND parent.relkind = 'r' AND parent.relpersistence = 'p'
    AND parent.reltablespace = 0 AND NOT parent.relhassubclass AND NOT parent.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_inherits inheritance
      WHERE inheritance.inhrelid=parent.oid OR inheritance.inhparent=parent.oid)
    AND state.indrelid = parent.oid AND method.amname = 'btree'
    AND NOT state.indisunique AND NOT state.indisprimary AND NOT state.indisexclusion
    AND state.indimmediate AND state.indisvalid AND state.indisready AND state.indislive
    AND state.indnkeyatts = 4 AND state.indnatts = 4 AND 0 = ALL(state.indoption::smallint[])
    AND pg_get_expr(state.indexprs,state.indrelid,false) = ${quote(ROUTING_INDEX_EXPRESSION)}
    AND pg_get_expr(state.indpred,state.indrelid,false) = ${quote(ROUTING_INDEX_PREDICATE)}
    AND ARRAY(SELECT pg_get_indexdef(relation.oid,k,false) FROM generate_series(2,4) k ORDER BY k)
      = ARRAY['queue_name','created_at','id']
    AND NOT EXISTS (SELECT 1 FROM unnest(state.indclass::oid[]) binding
      JOIN pg_opclass definition ON definition.oid=binding
      WHERE NOT definition.opcdefault OR definition.opcnamespace <> 'pg_catalog'::regnamespace)
    AND ARRAY(SELECT definition.opcname::text FROM unnest(state.indclass::oid[]) WITH ORDINALITY binding(oid,ordinal)
      JOIN pg_opclass definition ON definition.oid=binding.oid ORDER BY binding.ordinal)
      = ARRAY['text_ops','text_ops','timestamp_ops','text_ops']
    AND (state.indcollation::oid[])[0] = (SELECT typcollation FROM pg_type WHERE oid='text'::regtype)
    AND (state.indcollation::oid[])[1] = (SELECT attcollation FROM pg_attribute WHERE attrelid=parent.oid AND attname='queue_name' AND NOT attisdropped)
    AND (state.indcollation::oid[])[2] = (SELECT attcollation FROM pg_attribute WHERE attrelid=parent.oid AND attname='created_at' AND NOT attisdropped)
    AND (state.indcollation::oid[])[3] = (SELECT attcollation FROM pg_attribute WHERE attrelid=parent.oid AND attname='id' AND NOT attisdropped), false) AS exact
 FROM (SELECT to_regclass('public.webhook_events') AS oid) expected
 LEFT JOIN pg_class parent ON parent.oid=expected.oid
 LEFT JOIN pg_class relation ON relation.oid=to_regclass('public.webhook_events_chat_queue_head_idx')
 LEFT JOIN pg_index state ON state.indexrelid=relation.oid
 LEFT JOIN pg_am method ON method.oid=relation.relam
), receipts AS MATERIALIZED (
 SELECT id, migration_name AS name, checksum, started_at, finished_at IS NOT NULL AS finished,
  rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count AS steps
 FROM public._prisma_migrations LIMIT 4097
), artifacts AS MATERIALIZED (
 SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND left(c.relname,least(length('${ROUTING_INDEX_TARGET.index}'),52))=left('${ROUTING_INDEX_TARGET.index}',52)
  AND c.relname ~ '_cc(new|old)[0-9]*$' LIMIT 17
), builders AS MATERIALIZED (
 SELECT progress.pid FROM pg_stat_progress_create_index progress
 WHERE progress.relid=to_regclass('public.webhook_events')
  AND progress.datid=(SELECT oid FROM pg_database WHERE datname=current_database()) LIMIT 17
), ${historicalCompatibilityCtes}
SELECT json_build_object('supportedVersion',current_setting('server_version_num')::int BETWEEN 160000 AND 169999,
 'index',(SELECT row_to_json(definition) FROM definition),
 'receipts',COALESCE((SELECT json_agg(receipts) FROM receipts),'[]'::json),
 'artifacts',COALESCE((SELECT json_agg(relname) FROM artifacts),'[]'::json),
 'builders',COALESCE((SELECT json_agg(builders) FROM builders),'[]'::json),
 'historicalCompatibility',${historicalCompatibilityProjection});
COMMIT;`;

export function verifyRoutingIndexState(snapshot, source) {
  if (
    !snapshot ||
    snapshot.supportedVersion !== true ||
    !Array.isArray(snapshot.receipts) ||
    snapshot.receipts.length > 4096 ||
    !Array.isArray(snapshot.artifacts) ||
    snapshot.artifacts.length ||
    !Array.isArray(snapshot.builders) ||
    snapshot.builders.length ||
    typeof snapshot.index?.present !== 'boolean' ||
    typeof snapshot.index?.exact !== 'boolean' ||
    (snapshot.index.exact && !snapshot.index.present)
  )
    fail('STATE_INVALID');
  const known = new Map(source.map((migration) => [migration.name, migration.checksum]));
  const ids = new Set();
  const rollbackCounts = new Map();
  for (const receipt of snapshot.receipts) {
    if (!receipt) fail('RECEIPT_BLOCKED');
    if (receipt.name === '20261103120000_index_webhook_chat_queue_head') fail('RECEIPT_BLOCKED');
    if (typeof receipt.id !== 'string' || !receipt.id || ids.has(receipt.id))
      fail('RECEIPT_BLOCKED');
    ids.add(receipt.id);
    if (receipt.rolled_back === true && RECOVERED_PREDECESSORS.has(receipt.name))
      rollbackCounts.set(receipt.name, (rollbackCounts.get(receipt.name) ?? 0) + 1);
  }
  const active = validateOnlineMigrationReceipts(snapshot, source, () => fail('RECEIPT_BLOCKED'));
  for (const receipt of snapshot.receipts) {
    if (receipt.rolled_back === true) {
      const historical = OUTCOME_COHORT_HISTORICAL_COMPATIBILITY.some(
        (variant) => variant.name === receipt.name && variant.checksum === receipt.checksum,
      );
      if (
        receipt.name === ROUTING_INDEX_TARGET.migration ||
        (!historical &&
          known.get(receipt.name) !== receipt.checksum &&
          !isRecoveredPredecessor(
            receipt,
            known.get(receipt.name),
            active.get(receipt.name),
            rollbackCounts.get(receipt.name),
          ))
      )
        fail('RECEIPT_BLOCKED');
    }
  }
  for (const migration of source) {
    if (migration.name >= ROUTING_INDEX_TARGET.migration) break;
    if (!active.has(migration.name)) fail('PREREQUISITE_MISSING');
  }
  const applied = active.get(ROUTING_INDEX_TARGET.migration);
  if (applied && applied.steps !== 1) fail('RECEIPT_BLOCKED');
  if (!applied && [...active.keys()].some((name) => name > ROUTING_INDEX_TARGET.migration))
    fail('RECEIPT_BLOCKED');
  if ((applied && !snapshot.index.exact) || (!applied && snapshot.index.present))
    fail('INDEX_BLOCKED');
  return applied
    ? { state: 'already_applied', pending: [] }
    : { state: 'prepare_routing', pending: ['routing'] };
}
