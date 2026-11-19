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
export const GIVEAWAY_DEFERRAL_MIGRATIONS = Object.freeze([
  Object.freeze({
    name: '20261119043000_add_managed_giveaway_draft_revision',
    checksum: '3be3ba6283160de1058aa0a6a4c30282c7ef4d73f1c7c7818c61e67fc6c68136',
  }),
  Object.freeze({
    name: '20261119043001_add_managed_giveaway_results_sync',
    checksum: '4805a6edb067bfdb75e388e8461f315c0022eee1f36c1ef09f7d2c712d387e7c',
  }),
]);

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

// FLAG: These fixed catalog names prove both committed objects and clean absence before replay.
// No giveaway or webhook application rows are read by this check.
const giveawaySchemaCtes = `giveaway_relations AS MATERIALIZED (
  SELECT to_regclass('public.managed_giveaways') AS parent,
    to_regclass('public.managed_giveaway_results_sync') AS sync,
    to_regclass('public.managed_giveaway_results_sync_due_idx') AS due
), giveaway_columns AS MATERIALIZED (
  SELECT expected.rel, expected.name, a.attnum IS NOT NULL AS present,
    COALESCE(format_type(a.atttypid,a.atttypmod)=expected.data_type AND a.attnotnull=expected.required
      AND a.attidentity='' AND a.attgenerated=''
      AND (pg_get_expr(d.adbin,d.adrelid) IS NOT DISTINCT FROM expected.initial),false) AS exact
  FROM giveaway_relations r CROSS JOIN (VALUES
    ('parent','draft_revision','integer',true,'1'),
    ('parent','archived_at','timestamp(3) without time zone',false,NULL),
    ('sync','giveaway_id','text',true,NULL), ('sync','revision','integer',true,'1'),
    ('sync','next_attempt_at','timestamp(3) without time zone',false,NULL),
    ('sync','lease_token','text',false,NULL), ('sync','lease_until','timestamp(3) without time zone',false,NULL),
    ('sync','attempts','integer',true,'0')
  ) AS expected(rel,name,data_type,required,initial)
  LEFT JOIN pg_attribute a ON a.attrelid=CASE WHEN expected.rel='parent' THEN r.parent ELSE r.sync END
    AND a.attname=expected.name AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
), giveaway_schema AS MATERIALIZED (
  SELECT CASE WHEN p.relkind IS DISTINCT FROM 'r' OR p.relpersistence IS DISTINCT FROM 'p' THEN 'drift'
    WHEN NOT draft.present THEN 'absent' WHEN draft.exact THEN 'exact' ELSE 'drift' END AS draft,
    CASE WHEN NOT archive.present AND r.sync IS NULL AND r.due IS NULL THEN 'absent'
      WHEN archive.exact AND t.relkind='r' AND t.relpersistence='p'
      AND (SELECT bool_and(exact) FROM giveaway_columns WHERE rel='sync')
      AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=r.sync AND k.contype='p'
        AND k.convalidated AND k.conkey=ARRAY[gid.attnum])
      AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=r.sync AND k.contype='f'
        AND k.convalidated AND k.confrelid=r.parent AND k.conkey=ARRAY[gid.attnum] AND k.confkey=ARRAY[pid.attnum]
        AND k.confupdtype='c' AND k.confdeltype='c')
      AND i.indrelid=r.sync AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
      AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND am.amname='btree' AND 0=ALL(i.indoption::smallint[])
      AND pg_get_indexdef(r.due,1,false)='next_attempt_at' AND pg_get_indexdef(r.due,2,false)='giveaway_id'
      THEN 'exact' ELSE 'drift' END AS results
  FROM giveaway_relations r
  CROSS JOIN (SELECT present,exact FROM giveaway_columns WHERE name='draft_revision') draft
  CROSS JOIN (SELECT present,exact FROM giveaway_columns WHERE name='archived_at') archive
  LEFT JOIN pg_class p ON p.oid=r.parent
  LEFT JOIN pg_class t ON t.oid=r.sync
  LEFT JOIN pg_attribute gid ON gid.attrelid=r.sync AND gid.attname='giveaway_id' AND NOT gid.attisdropped
  LEFT JOIN pg_attribute pid ON pid.attrelid=r.parent AND pid.attname='id' AND NOT pid.attisdropped
  LEFT JOIN pg_index i ON i.indexrelid=r.due
  LEFT JOIN pg_class idx ON idx.oid=r.due
  LEFT JOIN pg_am am ON am.oid=idx.relam
)`;

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
WITH definitions AS MATERIALIZED (
 SELECT expected.name, relation.oid IS NOT NULL AS present,
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
    AND state.indnkeyatts = cardinality(expected.classes) AND state.indnatts = state.indnkeyatts
    AND 0 = ALL(state.indoption::smallint[])
    AND pg_get_expr(state.indexprs,state.indrelid,false) = ${quote(ROUTING_INDEX_EXPRESSION)}
    AND pg_get_expr(state.indpred,state.indrelid,false) = ${quote(ROUTING_INDEX_PREDICATE)}
    AND ARRAY(SELECT pg_get_indexdef(relation.oid,k,false) FROM generate_series(2,state.indnatts::int) k ORDER BY k)
      = expected.keys
    AND NOT EXISTS (SELECT 1 FROM unnest(state.indclass::oid[]) binding
      JOIN pg_opclass definition ON definition.oid=binding
      WHERE NOT definition.opcdefault OR definition.opcnamespace <> 'pg_catalog'::regnamespace)
    AND ARRAY(SELECT definition.opcname::text FROM unnest(state.indclass::oid[]) WITH ORDINALITY binding(oid,ordinal)
      JOIN pg_opclass definition ON definition.oid=binding.oid ORDER BY binding.ordinal)
      = expected.classes
    AND (state.indcollation::oid[])[0] = (SELECT typcollation FROM pg_type WHERE oid='text'::regtype)
    AND NOT EXISTS (SELECT 1 FROM unnest(expected.keys) WITH ORDINALITY k(attname,position)
      LEFT JOIN pg_attribute a ON a.attrelid=parent.oid AND a.attname=k.attname AND NOT a.attisdropped
      WHERE a.attcollation IS DISTINCT FROM (state.indcollation::oid[])[k.position::int]), false) AS exact
 FROM (VALUES
   ('index', 'webhook_events_chat_queue_head_idx', ARRAY['queue_name','created_at','id'],
    ARRAY['text_ops','text_ops','timestamp_ops','text_ops']),
   ('orderedIndex', 'webhook_events_ordered_chat_head_idx', ARRAY['created_at','id'],
    ARRAY['text_ops','timestamp_ops','text_ops'])
 ) expected(name,relation,keys,classes)
 LEFT JOIN pg_class parent ON parent.oid=to_regclass('public.webhook_events')
 LEFT JOIN pg_class relation ON relation.oid=to_regclass('public.' || expected.relation)
 LEFT JOIN pg_index state ON state.indexrelid=relation.oid
 LEFT JOIN pg_am method ON method.oid=relation.relam
), receipts AS MATERIALIZED (
 SELECT id, migration_name AS name, checksum, started_at, finished_at, finished_at IS NOT NULL AS finished,
  rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count AS steps
 FROM public._prisma_migrations LIMIT 4097
), artifacts AS MATERIALIZED (
 SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname ~ '^webhook_events_(chat_queue|ordered_chat)_head_idx.*_cc(new|old)[0-9]*$' LIMIT 17
), builders AS MATERIALIZED (
 SELECT progress.pid FROM pg_stat_progress_create_index progress
 WHERE progress.relid=to_regclass('public.webhook_events')
  AND progress.datid=(SELECT oid FROM pg_database WHERE datname=current_database()) LIMIT 17
), ${giveawaySchemaCtes}, ${historicalCompatibilityCtes}
SELECT json_build_object('supportedVersion',current_setting('server_version_num')::int BETWEEN 160000 AND 169999,
 'index',(SELECT json_build_object('present',present,'exact',exact) FROM definitions WHERE name='index'),
 'orderedIndex',(SELECT json_build_object('present',present,'exact',exact) FROM definitions WHERE name='orderedIndex'),
 'receipts',COALESCE((SELECT json_agg(receipts) FROM receipts),'[]'::json),
 'artifacts',COALESCE((SELECT json_agg(relname) FROM artifacts),'[]'::json),
 'builders',COALESCE((SELECT json_agg(builders) FROM builders),'[]'::json),
 'giveawaySchema',(SELECT row_to_json(giveaway_schema) FROM giveaway_schema),
 'historicalCompatibility',${historicalCompatibilityProjection});
COMMIT;`;

function readRoutingCatalog(snapshot, source) {
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
  if ((applied && !snapshot.index.exact) || (!applied && snapshot.index.present))
    fail('INDEX_BLOCKED');
  if (!applied && snapshot.receipts.some(({ name }) => name > ROUTING_INDEX_TARGET.migration)) {
    // FLAG: A later receipt can precede the optional index only for the exact reviewed
    // giveaway prefix. A failed or rolled-back attempt never authorizes replay or skipping.
    assertGiveawaySource(source, false);
    if (snapshot.orderedIndex?.present !== true || snapshot.orderedIndex.exact !== true)
      fail('GIVEAWAY_DEFERRAL_ORDERED_INDEX_REQUIRED');
    const permitted = new Set(GIVEAWAY_DEFERRAL_MIGRATIONS.map(({ name }) => name));
    if (
      snapshot.receipts.some(
        (r) =>
          r.name > ROUTING_INDEX_TARGET.migration &&
          (r.rolled_back !== false || !permitted.has(r.name)),
      )
    )
      fail('RECEIPT_BLOCKED');
    let missing = false;
    let lastFinished = -Infinity;
    for (const { name, checksum } of GIVEAWAY_DEFERRAL_MIGRATIONS) {
      const receipt = active.get(name);
      if (!receipt) {
        missing = true;
        continue;
      }
      const start = Date.parse(receipt.started_at);
      const end = Date.parse(receipt.finished_at);
      if (
        missing ||
        receipt.checksum !== checksum ||
        receipt.steps !== 1 ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start > end ||
        start < lastFinished
      )
        fail('RECEIPT_BLOCKED');
      lastFinished = end;
    }
  }
  if (!applied && GIVEAWAY_DEFERRAL_MIGRATIONS.some(({ name }) => active.has(name))) {
    assertGiveawaySchema(snapshot, active);
  }
  return { active, applied };
}

function assertGiveawaySource(source, exactTail) {
  const index = source.findIndex(({ name }) => name === ROUTING_INDEX_TARGET.migration);
  if (
    index < 0 ||
    source[index].checksum !== ROUTING_INDEX_TARGET.checksum ||
    (exactTail && source.length !== index + 1 + GIVEAWAY_DEFERRAL_MIGRATIONS.length) ||
    !GIVEAWAY_DEFERRAL_MIGRATIONS.every(({ name, checksum }, offset) => {
      const found = source[index + 1 + offset];
      return found?.name === name && found.checksum === checksum;
    })
  )
    fail('GIVEAWAY_DEFERRAL_SOURCE_INVALID');
}

function assertGiveawaySchema(snapshot, active) {
  const [draft, results] = GIVEAWAY_DEFERRAL_MIGRATIONS;
  if (
    snapshot.giveawaySchema?.draft !== (active.has(draft.name) ? 'exact' : 'absent') ||
    snapshot.giveawaySchema?.results !== (active.has(results.name) ? 'exact' : 'absent')
  )
    fail('GIVEAWAY_DEFERRAL_SCHEMA_INVALID');
}

export function verifyGiveawayDeferralState(snapshot, source) {
  assertGiveawaySource(source, true);
  const { active, applied } = readRoutingCatalog(snapshot, source);
  if (applied || snapshot.orderedIndex?.present !== true || snapshot.orderedIndex.exact !== true)
    fail('GIVEAWAY_DEFERRAL_STATE_INVALID');
  assertGiveawaySchema(snapshot, active);
  const pending = GIVEAWAY_DEFERRAL_MIGRATIONS.map(({ name }) => name).filter(
    (name) => !active.has(name),
  );
  return { state: pending.length ? 'prepare_giveaway_deferral' : 'compatible_pending', pending };
}

export function verifyRoutingIndexState(snapshot, source) {
  const { applied } = readRoutingCatalog(snapshot, source);
  return applied
    ? { state: 'already_applied', pending: [] }
    : { state: 'prepare_routing', pending: ['routing'] };
}
