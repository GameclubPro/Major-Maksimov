import { pathToFileURL } from 'node:url';
import {
  readRoutingIndexSource,
  ROUTING_INDEX_TARGET,
} from '../../scripts/agent/routing-index-online-target.mjs';
import {
  OUTCOME_COHORT_HISTORICAL_COMPATIBILITY,
  historicalCompatibilityCtes,
  historicalCompatibilityProjection,
} from '../../scripts/agent/outcome-cohort-historical-compatibility.mjs';
import { validateOnlineMigrationReceipts } from './online-migration-receipts.mjs';
import { runOutcomeCohortCommand } from './outcome-cohort-online-state.mjs';

const fail = (code) => {
  throw new Error(`ROUTING_INDEX_${code}`);
};
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
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
  for (const receipt of snapshot.receipts) {
    if (typeof receipt.id !== 'string' || !receipt.id || ids.has(receipt.id))
      fail('RECEIPT_BLOCKED');
    ids.add(receipt.id);
    if (receipt.rolled_back === true) {
      const historical = OUTCOME_COHORT_HISTORICAL_COMPATIBILITY.some(
        (variant) => variant.name === receipt.name && variant.checksum === receipt.checksum,
      );
      if (
        receipt.name === ROUTING_INDEX_TARGET.migration ||
        (!historical && known.get(receipt.name) !== receipt.checksum)
      )
        fail('RECEIPT_BLOCKED');
    }
  }
  const active = validateOnlineMigrationReceipts(snapshot, source, () => fail('RECEIPT_BLOCKED'));
  for (const migration of source) {
    if (migration.name >= ROUTING_INDEX_TARGET.migration) break;
    if (!active.has(migration.name)) fail('PREREQUISITE_MISSING');
  }
  const applied = active.has(ROUTING_INDEX_TARGET.migration);
  if (!applied && [...active.keys()].some((name) => name > ROUTING_INDEX_TARGET.migration))
    fail('RECEIPT_BLOCKED');
  if ((applied && !snapshot.index.exact) || (!applied && snapshot.index.present))
    fail('INDEX_BLOCKED');
  return applied
    ? { state: 'already_applied', pending: [] }
    : { state: 'prepare_routing', pending: ['routing'] };
}

export async function readRoutingIndexState(
  composeArgs,
  { root = process.cwd(), run = runOutcomeCohortCommand } = {},
) {
  const { validateMultibotComposeArgs } = await import('./multibot-prepare-capacity.mjs');
  validateMultibotComposeArgs(composeArgs);
  const source = readRoutingIndexSource(root);
  try {
    const result = await run(
      'docker',
      [
        'compose',
        ...composeArgs,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'maxim',
        '-d',
        'maxim',
        '-Atq',
      ],
      { input: routingIndexStateSql },
    );
    return verifyRoutingIndexState(JSON.parse(result.stdout.trim()), source);
  } catch (error) {
    if (/^ROUTING_INDEX_[A-Z_]+$/u.test(error?.message ?? '')) throw error;
    fail('STATE_UNAVAILABLE');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode !== 'assert') fail('ARGUMENTS_INVALID');
    const state = await readRoutingIndexState(args);
    if (state.state !== 'already_applied') fail('PREPARATION_INCOMPLETE');
    console.log(JSON.stringify({ stage: 'routing_index_assert', state: state.state }));
  } catch {
    console.error('ROUTING_INDEX_ASSERT_FAILED');
    process.exitCode = 1;
  }
}
