import { pathToFileURL } from 'node:url';

export const SOURCE_ENVELOPE_MAX_BYTES = 262144;
export const SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES = 2880;
export const SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES = 1028;
export const SOURCE_ENVELOPE_COMPRESSION_POLICY = 'pg16_valid_storage_ratio_v1';
export const SOURCE_ENVELOPE_COMPRESSION_ASSUMPTION = 'valid_postgresql_compressed_storage';

// FLAG: These are sufficient decoded-binary-datum bounds for coherent PG16 storage,
// not verification of a corrupted raw-size header. For the original table datum S,
// U<=4+91*S (pglz), U<=4+255*S (standard LZ4 block). No value/JSON operation may
// precede this CASE. Preserve the existing uncompressed physical-size path.
const sourcePayloadBounded = `CASE
  WHEN normalized_payload IS NULL THEN false
  WHEN pg_column_compression(normalized_payload) IS NULL
    THEN pg_column_size(normalized_payload) <= ${SOURCE_ENVELOPE_MAX_BYTES}
  WHEN current_setting('server_version_num')::integer / 10000 <> 16 THEN false
  WHEN pg_column_compression(normalized_payload) = 'pglz'
    THEN pg_column_size(normalized_payload) <= ${SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES}
  WHEN pg_column_compression(normalized_payload) = 'lz4'
    THEN pg_column_size(normalized_payload) <= ${SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES}
  ELSE false END`;
const sourcePayloadStorage = `CASE WHEN normalized_payload IS NULL THEN 'absent'
  WHEN pg_column_compression(normalized_payload) IS NULL THEN 'uncompressed'
  WHEN pg_column_compression(normalized_payload) IN ('pglz','lz4')
    THEN pg_column_compression(normalized_payload) ELSE 'other' END`;
export const SOURCE_ENVELOPE_ATTACHMENT_CAP = 10;
export const SOURCE_ENVELOPE_MARKUP_CAP = 32;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const jsWhitespace = String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`;
const kind = (value) => `coalesce(jsonb_typeof(${value}), 'absent')`;
const object = (value) => `jsonb_typeof(${value}) = 'object'`;
const keys = (value, allowed) => `CASE WHEN ${object(value)} THEN
  (${value}) - ARRAY[${allowed.map(literal).join(',')}]::text[] = '{}'::jsonb ELSE false END`;
const safeNumber = (value, limit) => `CASE WHEN jsonb_typeof(${value}) = 'number'
  AND length(${value} #>> '{}') <= 32 THEN
  abs((${value} #>> '{}')::numeric) <= ${limit}
  AND trunc((${value} #>> '{}')::numeric) = (${value} #>> '{}')::numeric ELSE false END`;
const identity = (value) => `CASE WHEN jsonb_typeof(${value}) = 'string' THEN
  length(${value} #>> '{}') > 0 AND btrim(${value} #>> '{}', ${jsWhitespace}) = (${value} #>> '{}')
  ELSE ${safeNumber(value, '9007199254740991')} END`;
const sequence = (value) => `(${value} IS NULL OR ${safeNumber(value, '9223372036854775808')})`;
const senderKeys = [
  'user_id',
  'name',
  'first_name',
  'last_name',
  'username',
  'is_bot',
  'avatar_url',
  'last_activity_time',
];
const bodyKeys = ['mid', 'seq', 'text', 'attachments', 'markup'];
const attachmentTypes = [
  'image',
  'photo',
  'video',
  'audio',
  'file',
  'share',
  'contact',
  'location',
  'sticker',
  'inline_keyboard',
];
const markupTypes = [
  'strong',
  'emphasized',
  'monospaced',
  'strikethrough',
  'underline',
  'link',
  'user_mention',
];
const finiteType = (
  value,
  allowed,
) => `CASE WHEN ${value}->>'type' IN (${allowed.map(literal).join(',')})
  THEN ${value}->>'type' ELSE 'other' END`;

export function validateSourceEnvelopeOwner(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value))
    throw new Error('One bounded opaque owner receipt ID required');
}

// FLAG: Attest the complete exact-key access path, including relation/row-security,
// index options, opclass, ordering and collation. A familiar name alone is not proof.
export const sourceEnvelopeIndexSql = `SELECT EXISTS (
  SELECT 1 FROM pg_index s JOIN pg_class i ON i.oid = s.indexrelid
  JOIN pg_class parent ON parent.oid = s.indrelid JOIN pg_am m ON m.oid = i.relam
  JOIN pg_attribute a ON a.attrelid = s.indrelid AND a.attname = 'id'
  WHERE s.indexrelid = to_regclass('public.webhook_events_pkey')
    AND s.indrelid = to_regclass('public.webhook_events') AND parent.relkind = 'r'
    AND NOT parent.relrowsecurity AND NOT parent.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent.oid OR inhrelid = parent.oid)
    AND i.relkind = 'i' AND i.reltablespace = 0 AND i.reloptions IS NULL
    AND s.indisvalid AND s.indisready AND s.indislive AND s.indisunique AND s.indisprimary
    AND NOT s.indisexclusion AND NOT s.indnullsnotdistinct AND s.indimmediate
    AND m.amname = 'btree' AND s.indnkeyatts = 1 AND s.indnatts = 1
    AND s.indexprs IS NULL AND s.indpred IS NULL AND pg_get_indexdef(i.oid, 1, false) = 'id'
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indoption::smallint[]) v WHERE v <> 0)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indclass::oid[]) c JOIN pg_opclass o ON o.oid = c
      WHERE NOT o.opcdefault OR o.opcnamespace <> 'pg_catalog'::regnamespace)
    AND s.indkey[0] = a.attnum AND s.indcollation[0] = a.attcollation
) AS source_envelope_index_ready;`;

function senderShape(value) {
  return `jsonb_build_object(
    'kind', ${kind(value)}, 'keys_supported', ${keys(value, senderKeys)},
    'user_id_valid', ${identity(`${value}->'user_id'`)},
    'bot_flag_kind', ${kind(`${value}->'is_bot'`)},
    'optional_strings_valid', ${['name', 'first_name', 'last_name', 'username', 'avatar_url']
      .map(
        (key) =>
          `(${value}->'${key}' IS NULL OR ${value}->'${key}' = 'null'::jsonb OR jsonb_typeof(${value}->'${key}') = 'string')`,
      )
      .join(' AND ')},
    'last_activity_valid', (${value}->'last_activity_time' IS NULL OR ${value}->'last_activity_time' = 'null'::jsonb
      OR ${safeNumber(`${value}->'last_activity_time'`, '9007199254740991')}))`;
}

function arrayShape(value, cap, itemShape) {
  // FLAG: Type and complete length admission precede every array expansion. An
  // oversized/malformed collection is uninspected, never an empty valid collection.
  return `jsonb_build_object('kind', ${kind(value)},
    'within_cap', CASE WHEN jsonb_typeof(${value}) = 'array' THEN jsonb_array_length(${value}) <= ${cap} ELSE false END,
    'empty', CASE WHEN jsonb_typeof(${value}) = 'array' THEN jsonb_array_length(${value}) = 0 ELSE false END,
    'items', CASE WHEN jsonb_typeof(${value}) = 'array' THEN
      CASE WHEN jsonb_array_length(${value}) <= ${cap} THEN
        (SELECT coalesce(jsonb_agg(${itemShape} ORDER BY ordinal), '[]'::jsonb)
          FROM jsonb_array_elements(${value}) WITH ORDINALITY items(item, ordinal)) END END)`;
}
function mediaShape(value) {
  return arrayShape(
    value,
    SOURCE_ENVELOPE_ATTACHMENT_CAP,
    `jsonb_build_object(
    'type', ${finiteType('item', attachmentTypes)}, 'kind', ${kind('item')},
    'keys_supported', ${keys('item', ['type', 'payload', 'title', 'thumbnail'])},
    'modern_share_keys_supported', CASE WHEN item->>'type'='share'
      THEN ${keys('item', ['type', 'payload', 'title', 'description', 'image_url'])} END,
    'modern_share_payload_keys_supported', CASE WHEN item->>'type'='share'
      THEN ${keys("item->'payload'", ['url', 'token'])} END,
    'title_kind', ${kind("item->'title'")},
    'description_kind', ${kind("item->'description'")},
    'image_url_kind', ${kind("item->'image_url'")},
    'payload_kind', ${kind("item->'payload'")},
    'payload_keys_supported', ${keys("item->'payload'", ['photo_id', 'video_id', 'audio_id', 'token', 'url'])},
    'photo_id_kind', ${kind("item#>'{payload,photo_id}'")},
    'photo_id_valid', ${identity("item#>'{payload,photo_id}'")},
    'token_kind', ${kind("item#>'{payload,token}'")},
    'url_kind', ${kind("item#>'{payload,url}'")},
    'thumbnail_kind', ${kind("item->'thumbnail'")})`,
  );
}
function markupShape(value) {
  return arrayShape(
    value,
    SOURCE_ENVELOPE_MARKUP_CAP,
    `jsonb_build_object(
    'type', ${finiteType('item', markupTypes)}, 'kind', ${kind('item')},
    'keys_supported', ${keys('item', ['type', 'from', 'length', 'url', 'user_id'])},
    'from_nonnegative_integer', (${safeNumber("item->'from'", '9007199254740991')} AND item->>'from' NOT LIKE '-%'),
    'length_positive_integer', CASE WHEN ${safeNumber("item->'length'", '9007199254740991')}
      THEN (item->>'length')::numeric > 0 ELSE false END,
    'url_kind', ${kind("item->'url'")},
    'user_id_valid', ${identity("item->'user_id'")})`,
  );
}
function bodyShape(value) {
  return `jsonb_build_object('kind', ${kind(value)}, 'keys_supported', ${keys(value, bodyKeys)},
    'mid_valid', ${identity(`${value}->'mid'`)}, 'sequence_valid', ${sequence(`${value}->'seq'`)},
    'text_kind', ${kind(`${value}->'text'`)},
    'attachments', ${mediaShape(`${value}->'attachments'`)},
    'markup', ${markupShape(`${value}->'markup'`)})`;
}

export function buildSourceEnvelopeAuditSql(ownerId, explain = false) {
  validateSourceEnvelopeOwner(ownerId);
  // FLAG: Fetch at most one exact PK. Inspect size/compression on the table value
  // before materializing or applying JSON operators. Only the pinned PG16 method
  // bounds admit compressed storage; no source/effect/replay authority is inferred.
  // No message text, URLs, arbitrary keys or linked identities leave SQL.
  const query = `WITH candidate AS MATERIALIZED (
    SELECT CASE WHEN normalized_payload IS NULL THEN 'absent'
      WHEN ${sourcePayloadBounded} THEN 'bounded'
      WHEN pg_column_compression(normalized_payload) IS NOT NULL THEN 'compressed_not_inspected'
      ELSE 'oversized_not_inspected' END AS payload_admission,
      ${sourcePayloadStorage} AS payload_storage,
      CASE WHEN ${sourcePayloadBounded}
        THEN normalized_payload ELSE NULL END AS normalized
    FROM public.webhook_events WHERE id = ${literal(ownerId)} LIMIT 1
  ), parts AS MATERIALIZED (
    SELECT *, normalized->'raw' AS raw, normalized->'message' AS normalized_message,
      normalized#>'{raw,message}' AS message,
      normalized#>'{raw,message,body}' AS body,
      normalized#>'{raw,message,link}' AS link,
      normalized#>'{raw,message,link,message}' AS linked_body,
      normalized#>'{raw,message,link,sender}' AS linked_sender
    FROM candidate
  ) SELECT jsonb_build_object(
    'schema_version', 2, 'audit', 'webhook_source_envelope',
    'authority', 'DIAGNOSTICS_ONLY', 'read_only', true,
    'replay_authorized', false, 'settlement_authorized', false, 'remote_effects_proven', false,
    'source_validation', 'not_evaluated', 'effect_completeness', 'unknown',
    'observed_at', statement_timestamp() AT TIME ZONE 'UTC',
    'receipt_sample_cap', 1, 'payload_max_bytes', ${SOURCE_ENVELOPE_MAX_BYTES},
    'payload_bound_policy', '${SOURCE_ENVELOPE_COMPRESSION_POLICY}',
    'payload_bound_assumption', '${SOURCE_ENVELOPE_COMPRESSION_ASSUMPTION}',
    'compressed_payload_max_raw_bytes', ${SOURCE_ENVELOPE_MAX_BYTES},
    'compressed_physical_caps', jsonb_build_object('pglz', ${SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES},
      'lz4', ${SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES}),
    'attachment_sample_cap', ${SOURCE_ENVELOPE_ATTACHMENT_CAP}, 'markup_sample_cap', ${SOURCE_ENVELOPE_MARKUP_CAP},
    'found', EXISTS (SELECT 1 FROM candidate),
    'payload_admission', coalesce((SELECT payload_admission FROM candidate), 'missing_receipt'),
    'payload_storage', coalesce((SELECT payload_storage FROM candidate), 'missing_receipt'),
    'shape', (SELECT CASE WHEN payload_admission = 'bounded' THEN jsonb_build_object(
      'normalized_kind', ${kind('normalized')}, 'raw_kind', ${kind('raw')},
      'message_kind', ${kind('message')}, 'normalized_message_kind', ${kind('normalized_message')},
      'normalized_text_kind', ${kind("normalized_message->'text'")},
      'receiver_kind', ${kind("normalized->'botId'")},
      'message_keys_supported', ${keys('message', ['sender', 'recipient', 'timestamp', 'body', 'link'])},
      'link_kind', ${kind('link')}, 'link_keys_supported', ${keys('link', ['type', 'sender', 'chat_id', 'message'])},
      'link_type', CASE WHEN link->>'type' IN ('forward','reply') THEN link->>'type' ELSE 'other' END,
      'linked_chat_id_kind', ${kind("link->'chat_id'")}, 'linked_chat_id_valid', ${identity("link->'chat_id'")},
      'linked_sender_omitted', link->'sender' IS NULL,
      'linked_sender', ${senderShape('linked_sender')},
      'outer_body', ${bodyShape('body')}, 'linked_body', ${bodyShape('linked_body')},
      'parser_text_equivalence', 'not_evaluated', 'command_validation', 'not_evaluated',
      'media_and_markup_runtime_validation', 'not_evaluated') END FROM parts)
  );`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}`;
}

export function emitSourceEnvelopeAuditSql(ownerId, explain = false) {
  return `SET LOCAL search_path TO pg_catalog, public, pg_temp;
${sourceEnvelopeIndexSql.replace(/;$/u, '')} \\gset
\\if :source_envelope_index_ready
${buildSourceEnvelopeAuditSql(ownerId, explain)}
\\else
\\echo MAXIM_SOURCE_ENVELOPE_INDEX_INVALID
SELECT 1 / 0;
\\endif
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [ownerId, option, ...extra] = process.argv.slice(2);
  if (extra.length || (option !== undefined && option !== '--explain'))
    throw new Error('Usage: webhook-source-envelope-audit.mjs <owner-receipt-id> [--explain]');
  process.stdout.write(emitSourceEnvelopeAuditSql(ownerId, option === '--explain'));
}
