import { pathToFileURL } from 'node:url';

export const HELD_RECEIPT_COLUMNS = Object.freeze({
  webhook_legacy_recoveries: Object.freeze([
    'id',
    'chat_id',
    'message_id',
    'user_id',
    'owner_webhook_event_id',
    'certificate_id',
    'authority_version',
    'disposition',
  ]),
  webhook_legacy_sealed_authorities: Object.freeze([
    'id',
    'certificate_id',
    'authority_version',
    'source_sha',
    'image_id',
    'attestation_digest',
    'preview_sha256',
    'sealed_at',
  ]),
  webhook_legacy_quiescence_certificates: Object.freeze([
    'id',
    'authority_version',
    'source_sha',
    'image_id',
    'attestation_digest',
    'preview_sha256',
    'quiesced_at',
    'sealed_at',
  ]),
  webhook_source_abandonments: Object.freeze(['chat_id', 'message_id']),
  webhook_backlog_receipts: Object.freeze(['receipt_id', 'semantic_key']),
});

const literal = (value) => `'${value.replaceAll("'", "''")}'`;

export function parseHeldReceiptAuditArgs(args) {
  const values = [...args];
  const explain = values.at(-1) === '--explain';
  if (explain) values.pop();
  const receiptId = values[0];
  if (
    values.length > 1 ||
    (receiptId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(receiptId))
  )
    throw new Error('Expected one optional bounded receipt ID and optional --explain');
  return { explain, receiptId };
}
const allowed = Object.entries(HELD_RECEIPT_COLUMNS)
  .flatMap(([table, columns]) => columns.map((column) => `(${literal(table)},${literal(column)})`))
  .join(',\n');

// FLAG: This optional scalar group grants neither snapshots nor mutation authority.
// Effective PUBLIC/inherited excess and partial groups fail the same exact check.
export function heldReceiptPrivilegesSql(requireAll = false) {
  return `WITH allowed(table_name,column_name) AS (VALUES ${allowed}),
relations AS (SELECT DISTINCT table_name,to_regclass('public.'||table_name) AS oid FROM allowed),
attributes AS MATERIALIZED (
  SELECT r.table_name,r.oid,a.attname,
    has_column_privilege(current_user,r.oid,a.attnum,'SELECT') AS readable,
    has_column_privilege(current_user,r.oid,a.attnum,'INSERT,UPDATE,REFERENCES') AS writable
  FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid
  WHERE a.attnum>0 AND NOT a.attisdropped
)
SELECT NOT EXISTS (SELECT 1 FROM relations WHERE oid IS NOT NULL AND
  has_table_privilege(current_user,oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
AND NOT EXISTS (SELECT 1 FROM attributes a WHERE writable OR (readable AND NOT EXISTS (
  SELECT 1 FROM allowed WHERE table_name=a.table_name AND column_name=a.attname)))
AND (SELECT count(*) FROM attributes WHERE readable) ${requireAll ? '= 28' : 'IN (0,28)'}
AS held_receipt_privileges_ready;`;
}

const indexes = [
  ['webhook_events_pkey', 'webhook_events', ['id'], true, true],
  [
    'webhook_events_status_created_at_id_idx',
    'webhook_events',
    ['status', 'created_at', 'id'],
    false,
    false,
  ],
  [
    'webhook_legacy_recoveries_chat_message_idx',
    'webhook_legacy_recoveries',
    ['chat_id', 'message_id'],
    false,
    false,
  ],
  [
    'webhook_legacy_recoveries_chat_user_idx',
    'webhook_legacy_recoveries',
    ['chat_id', 'user_id'],
    false,
    false,
  ],
  [
    'webhook_legacy_recoveries_global_user_idx',
    'webhook_legacy_recoveries',
    ['user_id'],
    false,
    false,
  ],
  [
    'webhook_legacy_sealed_authorities_certificate_id_key',
    'webhook_legacy_sealed_authorities',
    ['certificate_id'],
    true,
    false,
  ],
  [
    'webhook_legacy_quiescence_certificates_pkey',
    'webhook_legacy_quiescence_certificates',
    ['id'],
    true,
    true,
  ],
  [
    'webhook_source_abandonments_chat_message_key',
    'webhook_source_abandonments',
    ['chat_id', 'message_id'],
    true,
    false,
  ],
  ['webhook_backlog_receipts_pkey', 'webhook_backlog_receipts', ['receipt_id'], true, true],
  [
    'webhook_backlog_receipts_semantic_idx',
    'webhook_backlog_receipts',
    ['semantic_key'],
    false,
    false,
  ],
];

// FLAG: Each family is a bounded indexed prefix before its sentinel cap. Attest
// the complete access paths; an index name or a top-level LIMIT is insufficient.
export const heldReceiptIndexesSql = `WITH expected(name,parent,keys,is_unique,is_primary) AS (VALUES
${indexes
  .map(
    ([name, parent, keys, unique, primary]) =>
      `(${literal(name)},${literal(parent)},ARRAY[${keys.map(literal)}],${unique},${primary})`,
  )
  .join(',\n')}
)
SELECT NOT EXISTS (
  SELECT 1 FROM expected e
  LEFT JOIN pg_class i ON i.oid=to_regclass('public.'||e.name)
  LEFT JOIN pg_index s ON s.indexrelid=i.oid
  LEFT JOIN pg_class parent ON parent.oid=s.indrelid
  LEFT JOIN pg_am m ON m.oid=i.relam
  WHERE NOT COALESCE(i.relkind='i' AND i.reltablespace=0 AND i.reloptions IS NULL
    AND s.indrelid=to_regclass('public.'||e.parent)
    AND parent.relkind='r' AND NOT parent.relrowsecurity AND NOT parent.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=parent.oid OR inhrelid=parent.oid)
    AND s.indisvalid AND s.indisready AND s.indislive AND NOT s.indisexclusion
    AND NOT s.indnullsnotdistinct AND s.indimmediate
    AND s.indisunique=e.is_unique AND s.indisprimary=e.is_primary
    AND m.amname='btree' AND s.indnkeyatts=cardinality(e.keys) AND s.indnatts=cardinality(e.keys)
    AND s.indexprs IS NULL AND s.indpred IS NULL
    AND ARRAY(SELECT pg_get_indexdef(i.oid,n,false) FROM generate_series(1,s.indnkeyatts) n)=e.keys
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indoption::smallint[]) v WHERE v<>0)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indclass::oid[]) c JOIN pg_opclass o ON o.oid=c
      WHERE NOT o.opcdefault OR o.opcnamespace<>'pg_catalog'::regnamespace)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indkey::smallint[],s.indcollation::oid[]) k(attnum,collation_oid)
      LEFT JOIN pg_attribute a ON a.attrelid=s.indrelid AND a.attnum=k.attnum
      WHERE k.collation_oid<>a.attcollation),false)
) AS held_receipt_indexes_ready;`;

// FLAG: Inspect the original table datum before any JSON extraction. These are
// the existing PG16 coherent-storage bounds, not a corrupted-header validator.
const payloadBounded = `CASE
  WHEN e.normalized_payload IS NULL THEN false
  WHEN pg_column_compression(e.normalized_payload) IS NULL
    THEN pg_column_size(e.normalized_payload)<=262144
  WHEN current_setting('server_version_num')::integer/10000<>16 THEN false
  WHEN pg_column_compression(e.normalized_payload)='pglz'
    THEN pg_column_size(e.normalized_payload)<=2880
  WHEN pg_column_compression(e.normalized_payload)='lz4'
    THEN pg_column_size(e.normalized_payload)<=1028
  ELSE false END`;
const identity = (key) => `CASE WHEN jsonb_typeof(normalized#>'{message,${key}}')='string'
  AND octet_length(normalized#>>'{message,${key}}') BETWEEN 1 AND 512
  THEN normalized#>>'{message,${key}}' END`;
// FLAG: Binding text is not indexed. Admit its original uncompressed table datum
// before equality; compressed/oversized values are uninspected, never a mismatch.
const scalarBounded = (value, maximum = 1024) =>
  `(pg_column_compression(${value}) IS NULL AND pg_column_size(${value})<=${maximum})`;
const bindingFields = ['source_sha', 'image_id', 'attestation_digest', 'preview_sha256'];
const bindingBounded = (alias) =>
  bindingFields.map((c) => scalarBounded(`${alias}.${c}`)).join(' AND ');
const bindingColumns = (table, alias) =>
  HELD_RECEIPT_COLUMNS[table]
    .map((c) =>
      bindingFields.includes(c)
        ? `CASE WHEN ${scalarBounded(`${alias}.${c}`)} THEN ${alias}.${c} END AS ${c}`
        : `${alias}.${c}`,
    )
    .join(',');
const recoveryTextFields = HELD_RECEIPT_COLUMNS.webhook_legacy_recoveries.filter(
  (c) => c !== 'authority_version',
);
// FLAG: Guard every projected recovery string on its original table datum before
// UNION, ordering or joins. One uninspected matching row blocks the whole winner.
const recoveryColumns =
  HELD_RECEIPT_COLUMNS.webhook_legacy_recoveries
    .map((c) =>
      recoveryTextFields.includes(c)
        ? `CASE WHEN ${scalarBounded(`r.${c}`)} THEN r.${c} END AS ${c}`
        : `r.${c}`,
    )
    .join(',') +
  `,${scalarBounded('r.disposition')} AS disposition_bounded,
    ${recoveryTextFields.map((c) => `COALESCE(${scalarBounded(`r.${c}`)},false)`).join(' AND ')} AS metadata_bounded`;

// FLAG: Materialize the capped chat prefix before testing message_id. PostgreSQL
// may choose chat/user and otherwise discard unbounded history below LIMIT.
export function buildHeldReceiptAuditSql(explain = false, receiptId) {
  if (receiptId !== undefined) parseHeldReceiptAuditArgs([receiptId]);
  const keyed = receiptId !== undefined;
  const selection = keyed
    ? `SELECT id FROM public.webhook_events WHERE id=${explain ? '$1' : literal(receiptId)} LIMIT 1`
    : `SELECT id FROM public.webhook_events WHERE status='RECEIVED'::public."WebhookStatus"
  ORDER BY created_at,id LIMIT 1`;
  const query = `WITH head AS MATERIALIZED (
  ${selection}
), candidate AS MATERIALIZED (
  SELECT e.id,e.status,e.created_at,
    CASE WHEN ${scalarBounded('e.semantic_key', 4096)} THEN e.semantic_key END AS semantic_key,
    CASE WHEN e.semantic_key IS NULL THEN 'absent'
      WHEN ${scalarBounded('e.semantic_key', 4096)} THEN 'bounded' ELSE 'uninspected' END AS semantic_key_admission,
    CASE WHEN e.error_message IS NULL THEN 'absent'
      WHEN ${scalarBounded('e.error_message')} THEN
        CASE WHEN e.error_message='Webhook preparation deferred: Legacy scope installation is not sealed'
          THEN 'legacy_scope_unsealed' ELSE 'other' END
      ELSE 'uninspected' END AS saved_preparation_reason,
    e.enqueue_attempts,e.queued_at,
    e.queue_name,e.processed_at,e.legacy_disposition_id,e.legacy_disposition_receipt_id,
    e.source_disposition_id,e.source_disposition_receipt_id,
    CASE WHEN e.normalized_payload IS NULL THEN 'absent'
      WHEN ${payloadBounded} THEN 'bounded'
      WHEN pg_column_compression(e.normalized_payload) IS NOT NULL THEN 'compressed_not_inspected'
      ELSE 'oversized_not_inspected' END AS payload_admission,
    CASE WHEN ${payloadBounded} THEN e.normalized_payload ELSE NULL END AS normalized
  FROM head JOIN public.webhook_events e ON e.id=head.id
), scope AS MATERIALIZED (
  SELECT *,normalized->>'type'='message_removed' AS is_removal,
    normalized->>'type' IN ('message_created','message_edited') AS is_authored_message,
    normalized->>'type' IN (${keyed ? "'message_removed','message_created','message_edited'" : "'message_removed'"}) AS scope_supported,
    ${identity('chatId')} AS chat_id,${identity('messageId')} AS message_id,
    ${identity('senderId')} AS user_id FROM candidate
), exact_chat_prefix AS MATERIALIZED (
  SELECT r.* FROM scope s CROSS JOIN LATERAL (
    SELECT ${recoveryColumns} FROM public.webhook_legacy_recoveries r
    WHERE s.scope_supported AND s.chat_id IS NOT NULL AND s.message_id IS NOT NULL
      AND r.chat_id=s.chat_id LIMIT 17
  ) r
), exact_scopes AS MATERIALIZED (
  SELECT r.* FROM exact_chat_prefix r CROSS JOIN scope s WHERE r.message_id=s.message_id
), user_scopes AS MATERIALIZED (
  SELECT r.* FROM scope s CROSS JOIN LATERAL (
    SELECT ${recoveryColumns} FROM public.webhook_legacy_recoveries r
    WHERE s.scope_supported AND s.user_id IS NOT NULL AND r.user_id=s.user_id LIMIT 17
  ) r
), coverage AS MATERIALIZED (
  SELECT s.*,(SELECT count(*) FROM exact_chat_prefix) AS exact_chat_prefix_count,
    (SELECT count(*) FROM exact_scopes) AS exact_count,
    (SELECT count(*) FROM user_scopes) AS user_count,
    (SELECT COALESCE(bool_and(metadata_bounded),true) FROM exact_chat_prefix) AS exact_metadata_bounded,
    (SELECT COALESCE(bool_and(metadata_bounded),true) FROM user_scopes) AS user_metadata_bounded,
    s.scope_supported AND s.chat_id IS NOT NULL AND s.message_id IS NOT NULL
      AND s.user_id IS NOT NULL AND (SELECT count(*) FROM exact_chat_prefix)<17
      AND (SELECT count(*) FROM user_scopes)<17
      AND (SELECT COALESCE(bool_and(metadata_bounded),true) FROM exact_chat_prefix)
      AND (SELECT COALESCE(bool_and(metadata_bounded),true) FROM user_scopes) AS scopes_complete
  FROM scope s
), complete_scopes AS MATERIALIZED (
  SELECT e.* FROM exact_scopes e WHERE (SELECT scopes_complete FROM coverage)
  UNION SELECT u.* FROM user_scopes u WHERE (SELECT scopes_complete FROM coverage)
), winner AS MATERIALIZED (
  SELECT r.* FROM complete_scopes r
  ORDER BY (r.owner_webhook_event_id=(SELECT id FROM coverage)) DESC,r.id LIMIT 1
), authority AS MATERIALIZED (
  SELECT a.* FROM winner w CROSS JOIN LATERAL (
    SELECT ${bindingColumns('webhook_legacy_sealed_authorities', 'a')},
      ${bindingBounded('a')} AS binding_metadata_bounded
    FROM public.webhook_legacy_sealed_authorities a WHERE a.certificate_id=w.certificate_id LIMIT 1
  ) a
), certificate AS MATERIALIZED (
  SELECT c.* FROM winner w CROSS JOIN LATERAL (
    SELECT ${bindingColumns('webhook_legacy_quiescence_certificates', 'c')},
      ${bindingBounded('c')} AS binding_metadata_bounded
    FROM public.webhook_legacy_quiescence_certificates c WHERE c.id=w.certificate_id LIMIT 1
  ) c
), seal AS MATERIALIZED (
  SELECT w.id AS recovery_id,a.id AS authority_id,c.id AS certificate_id,
    w.disposition_bounded AND a.binding_metadata_bounded AND c.binding_metadata_bounded
      AS binding_metadata_bounded,
    CASE WHEN w.disposition_bounded THEN w.authority_version=1 AND w.disposition='NO_REPLAY_ORDER_RELEASED'
      END AS recovery_metadata_matches,
    CASE WHEN a.binding_metadata_bounded AND c.binding_metadata_bounded THEN
      a.authority_version=1 AND c.authority_version=1 AND a.certificate_id=c.id
      AND a.source_sha=c.source_sha AND a.image_id=c.image_id
      AND a.attestation_digest=c.attestation_digest AND a.preview_sha256=c.preview_sha256
      AND a.sealed_at=c.sealed_at AND isfinite(a.sealed_at) AND isfinite(c.sealed_at)
      END AS scalar_identity_matches,
    c.sealed_at AS certificate_sealed_at,a.sealed_at AS authority_sealed_at,c.quiesced_at
  FROM winner w LEFT JOIN authority a ON true LEFT JOIN certificate c ON true
), other_holds AS MATERIALIZED (
  SELECT CASE WHEN v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL THEN
    EXISTS (SELECT 1 FROM public.webhook_source_abandonments m
      WHERE m.chat_id=v.chat_id AND m.message_id=v.message_id LIMIT 1) END AS modern_exact,
    CASE WHEN v.scope_supported THEN EXISTS (SELECT 1 FROM public.webhook_backlog_receipts b
      WHERE b.receipt_id=v.id LIMIT 1) END AS backlog_receipt,
    CASE WHEN v.scope_supported AND v.semantic_key IS NOT NULL THEN
      EXISTS (SELECT 1 FROM public.webhook_backlog_receipts b
        WHERE b.semantic_key=v.semantic_key LIMIT 1) END AS backlog_stored_semantic
  FROM coverage v
)
SELECT jsonb_build_object(
  'schema_version',2,'audit','webhook_held_receipt','authority','DIAGNOSTICS_ONLY','diagnostics_only',true,
  'read_only',current_setting('transaction_read_only')='on','sampled_at',statement_timestamp(),
  'runtime_classifier_evaluated',false,'settlement_authorized',false,'replay_authorized',false,
  'effect_completeness','unknown','source_validation','not_evaluated',
  'selection',${literal(keyed ? 'exact_receipt' : 'oldest_received')},
  'classification',CASE
    WHEN v.id IS NULL THEN ${literal(keyed ? 'receipt_missing' : 'no_received')}
    WHEN v.status<>'RECEIVED'::public."WebhookStatus" THEN 'receipt_not_received'
    WHEN v.payload_admission<>'bounded' THEN 'payload_uninspected'
    WHEN v.scope_supported IS NOT TRUE THEN ${literal(keyed ? 'unsupported_event_type' : 'not_message_removed')}
    WHEN v.chat_id IS NULL OR v.message_id IS NULL OR v.user_id IS NULL THEN 'normalized_scope_unproved'
    WHEN v.exact_metadata_bounded IS NOT TRUE OR v.user_metadata_bounded IS NOT TRUE
      THEN 'legacy_scope_metadata_uninspected'
    WHEN NOT v.scopes_complete THEN 'legacy_scope_saturated'
    WHEN z.recovery_id IS NULL THEN 'no_legacy_scope'
    WHEN z.authority_id IS NULL THEN 'legacy_authority_missing'
    WHEN z.certificate_id IS NULL THEN 'legacy_certificate_missing'
    WHEN z.binding_metadata_bounded IS NOT TRUE THEN 'binding_metadata_uninspected'
    WHEN z.scalar_identity_matches IS NOT TRUE OR z.recovery_metadata_matches IS NOT TRUE
      THEN 'legacy_seal_mismatch' ELSE 'legacy_sealed_scope_present' END,
  'receipt',jsonb_build_object('found',v.id IS NOT NULL,'status',v.status::text,
    'still_received',v.status='RECEIVED'::public."WebhookStatus",
    'created_at',CASE WHEN isfinite(v.created_at) THEN v.created_at END,
    'event_type',CASE WHEN v.scope_supported THEN v.normalized->>'type' ELSE 'other_or_uninspected' END,
    'payload_admission',v.payload_admission,'queue_absent',v.queue_name IS NULL AND v.queued_at IS NULL,
    'zero_enqueue_attempts',v.enqueue_attempts=0,'processed',v.processed_at IS NOT NULL,
    'legacy_proof_pointer_present',v.legacy_disposition_id IS NOT NULL OR v.legacy_disposition_receipt_id IS NOT NULL,
    'source_proof_pointer_present',v.source_disposition_id IS NOT NULL OR v.source_disposition_receipt_id IS NOT NULL,
    'saved_preparation_reason',v.saved_preparation_reason,
    'stored_semantic_key_admission',v.semantic_key_admission),
  'scope_metadata',jsonb_build_object('chat_id_valid',v.chat_id IS NOT NULL,
    'message_id_valid',v.message_id IS NOT NULL,
    'normalized_actor_valid',CASE WHEN v.is_removal THEN v.user_id IS NOT NULL END,
    'normalized_author_valid',CASE WHEN v.scope_supported AND v.is_authored_message THEN v.user_id IS NOT NULL END,
    'user_nomination',CASE WHEN v.is_removal THEN 'normalized_removal_actor'
      WHEN v.scope_supported AND v.is_authored_message THEN 'normalized_outer_message_sender' ELSE 'unavailable' END,
    'original_author_proven',false,'scopes_complete',v.scopes_complete,
    'exact_family_available',v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL,
    'exact_chat_prefix_count_lower_bound',CASE WHEN v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL THEN v.exact_chat_prefix_count END,
    'exact_chat_prefix_saturated',CASE WHEN v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL THEN v.exact_chat_prefix_count=17 END,
    'exact_chat_prefix_complete',CASE WHEN v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL THEN v.exact_chat_prefix_count<17 AND v.exact_metadata_bounded END,
    'exact_match_count_lower_bound',CASE WHEN v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL THEN v.exact_count END,
    'exact_saturated',CASE WHEN v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL THEN v.exact_count=17 END,
    'exact_family_metadata_bounded',CASE WHEN v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL THEN v.exact_metadata_bounded END,
    'exact_family_complete',CASE WHEN v.scope_supported AND v.chat_id IS NOT NULL AND v.message_id IS NOT NULL THEN v.exact_chat_prefix_count<17 AND v.exact_metadata_bounded END,
    'global_user_family_available',v.scope_supported AND v.user_id IS NOT NULL,
    'global_user_match_count_lower_bound',CASE WHEN v.scope_supported AND v.user_id IS NOT NULL THEN v.user_count END,
    'global_user_saturated',CASE WHEN v.scope_supported AND v.user_id IS NOT NULL THEN v.user_count=17 END,
    'global_user_family_metadata_bounded',CASE WHEN v.scope_supported AND v.user_id IS NOT NULL THEN v.user_metadata_bounded END,
    'global_user_family_complete',CASE WHEN v.scope_supported AND v.user_id IS NOT NULL THEN v.user_count<17 AND v.user_metadata_bounded END,
    'family_cap',16,'sentinel_cap',17,'scalar_uncompressed_max_bytes',1024),
  'other_hold_metadata',jsonb_build_object('modern_exact_message_present',h.modern_exact,
    'backlog_exact_receipt_present',h.backlog_receipt,'backlog_stored_semantic_present',h.backlog_stored_semantic,
    'backlog_message_family',CASE WHEN v.is_removal THEN 'not_applicable_to_message_removed' ELSE 'not_evaluated' END,
    'protocol_family_coverage','partial','exclusive_protocol_proven',false,
    'canonical_semantic_key_rebuilt',false),
  'legacy_scope',jsonb_build_object('selected',z.recovery_id IS NOT NULL,
    'seal_coverage','selected_scope_only','all_matching_scopes_sealed_proven',false,
    'selection_role',CASE WHEN v.legacy_disposition_id IS NOT NULL OR v.legacy_disposition_receipt_id IS NOT NULL
      OR v.source_disposition_id IS NOT NULL OR v.source_disposition_receipt_id IS NOT NULL
      THEN 'diagnostic_only_existing_pointer' ELSE 'metadata_only' END,
    'owner_is_receipt',(SELECT owner_webhook_event_id=v.id FROM winner),
    'matches_exact_message',(SELECT chat_id=v.chat_id AND message_id=v.message_id FROM winner),
    'matches_global_user',(SELECT user_id=v.user_id FROM winner),
    'recovery_metadata_matches',z.recovery_metadata_matches,'authority_present',z.authority_id IS NOT NULL,
    'certificate_present',z.certificate_id IS NOT NULL,'scalar_identity_matches',z.scalar_identity_matches,
    'binding_metadata_bounded',z.binding_metadata_bounded,'binding_uncompressed_max_bytes',1024,
    'authority_sealed_at',CASE WHEN isfinite(z.authority_sealed_at) THEN z.authority_sealed_at END,
    'certificate_sealed_at',CASE WHEN isfinite(z.certificate_sealed_at) THEN z.certificate_sealed_at END,
    'quiesced_before_seal',CASE WHEN isfinite(z.quiesced_at) AND isfinite(z.certificate_sealed_at)
      THEN z.quiesced_at<=z.certificate_sealed_at END,
    'seal_not_future',CASE WHEN isfinite(z.certificate_sealed_at) THEN z.certificate_sealed_at<=statement_timestamp() END,
    'receipt_created_after_seal',CASE WHEN isfinite(v.created_at) AND isfinite(z.certificate_sealed_at)
      THEN v.created_at>z.certificate_sealed_at END)
) FROM (SELECT 1) singleton LEFT JOIN coverage v ON true LEFT JOIN seal z ON true
  LEFT JOIN other_holds h ON true;`;
  // FLAG: A keyed plain plan must not print the nominated private receipt ID in
  // its index condition. The generic parameter still uses the attested exact PK.
  if (keyed && explain)
    return `SET LOCAL plan_cache_mode='force_generic_plan';
PREPARE maxim_held_receipt_audit(text) AS ${query}
EXPLAIN (FORMAT JSON) EXECUTE maxim_held_receipt_audit(${literal(receiptId)});
DEALLOCATE maxim_held_receipt_audit;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}`;
}

function guard(sql, variable, failure) {
  return `${sql.replace(/;$/u, '')}\n\\gset\n\\if :${variable}\n\\else\n\\echo ${failure}\nSELECT 1 / 0;\n\\endif\n`;
}

export function emitHeldReceiptPrivilegesSql(requireAll = false) {
  return guard(
    heldReceiptPrivilegesSql(requireAll),
    'held_receipt_privileges_ready',
    'WEBHOOK_HELD_RECEIPT_PRIVILEGES_INVALID',
  );
}

export function emitHeldReceiptAuditSql(explain = false, receiptId) {
  return `SET LOCAL search_path TO pg_catalog, public, pg_temp;\nSET LOCAL timezone='UTC';\n${emitHeldReceiptPrivilegesSql(true)}${guard(heldReceiptIndexesSql, 'held_receipt_indexes_ready', 'WEBHOOK_HELD_RECEIPT_INDEXES_INVALID')}${buildHeldReceiptAuditSql(explain, receiptId)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === '--privileges') {
      process.stdout.write(emitHeldReceiptPrivilegesSql());
    } else {
      const validateOnly = args[0] === '--validate-scope';
      const { explain, receiptId } = parseHeldReceiptAuditArgs(validateOnly ? args.slice(1) : args);
      if (!validateOnly) process.stdout.write(emitHeldReceiptAuditSql(explain, receiptId));
    }
  } catch {
    process.stderr.write(
      'Usage: webhook-held-receipt-audit.mjs [receipt-id] [--explain] | --privileges\n',
    );
    process.exitCode = 2;
  }
}
