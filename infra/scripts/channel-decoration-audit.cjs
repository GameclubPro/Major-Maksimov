'use strict';

// FLAG: Operator-only metadata collector. No Nest startup, MAX requests, writes,
// unbounded name predicates, webhook payloads, credentials or free-form errors.
const CHANNEL_SAMPLE_CAP = 2048;
const MARKER_SAMPLE_CAP = 50;
const DEMAND_SAMPLE_CAP = 64;
const DEMAND_SQL = {
  parent: `SELECT due_at, statement_timestamp() AT TIME ZONE 'UTC' AS observed_at
    FROM channel_post_demand_channels WHERE chat_id = $1`,
  items: `SELECT message_id, source_at, expires_at, due_at
    FROM channel_post_demands WHERE chat_id = $1
    ORDER BY due_at, message_id LIMIT ${DEMAND_SAMPLE_CAP + 1}`,
  backlog: `SELECT due_at FROM channel_post_demand_channels
    WHERE due_at <= (statement_timestamp() AT TIME ZONE 'UTC')
    ORDER BY due_at, chat_id LIMIT ${DEMAND_SAMPLE_CAP + 1}`,
};
const DEMAND_INDEXES = {
  channel_post_demand_channels_pkey: ['channel_post_demand_channels', ['chat_id']],
  channel_post_demands_due_idx: ['channel_post_demands', ['chat_id', 'due_at', 'message_id']],
  channel_post_demand_channels_due_idx: ['channel_post_demand_channels', ['due_at', 'chat_id']],
};
const FIND_SQL = `SELECT id, title, updated_at FROM chats
  WHERE entity_type = 'CHANNEL'
  ORDER BY updated_at DESC, id LIMIT ${CHANNEL_SAMPLE_CAP + 1}`;
const CENSUS_SQL = `SELECT chat_id, post_signature_enabled, comments_enabled,
  post_suggestions_enabled, quick_buttons_enabled FROM channel_settings
  ORDER BY chat_id LIMIT ${CHANNEL_SAMPLE_CAP + 1}`;
const IMPACT_SQL = `SELECT chat_id, post_signature_enabled, comments_enabled,
  post_suggestions_enabled, quick_buttons_enabled FROM channel_settings
  WHERE chat_id = ANY($1::text[]) ORDER BY chat_id LIMIT 129`;
const INSPECT_SQL = {
  channel: `SELECT id, title, entity_type, bot_id, primary_bot_id, fixed_moderator_bot_id,
    routing_state, updated_at FROM chats WHERE id = $1`,
  settings: `SELECT post_signature_enabled, post_signature_presentation,
    post_signature_text, post_signature_url <> '' AS custom_signature_url,
    quick_buttons_enabled, comments_enabled, post_suggestions_enabled,
    custom_post_buttons_enabled, custom_post_buttons_since,
    CASE WHEN jsonb_typeof(custom_post_buttons) = 'array'
      THEN jsonb_array_length(custom_post_buttons) ELSE NULL END AS custom_post_button_count,
    updated_at
    FROM channel_settings WHERE chat_id = $1`,
  memberships: `SELECT bot_id, status, bot_access_state, bot_access_checked_at,
    bot_access_source, lifecycle_event_at FROM chat_bot_memberships
    WHERE chat_id = $1 ORDER BY status, lifecycle_event_at DESC LIMIT 17`,
  markers: `SELECT message_id, status, bot_id, source, delivery_mode, link_type,
    replacement_message_id, replacement_send_started_at, original_deleted,
    last_status_code, last_error IS NOT NULL AS error_present,
    CASE
      WHEN last_error = 'invalid_button_url' THEN 'invalid_button_url'
      WHEN last_error LIKE '%without the requested id%' THEN 'message_lookup_identity_missing'
      WHEN last_error LIKE '%MAX_API_INTERNAL_RATE_LIMIT%' OR last_error LIKE '%rate limit%'
        OR last_error LIKE '%quota%' THEN 'quota_or_capacity'
      WHEN last_error LIKE '%слишком длинный%' THEN 'signature_text_too_long'
      WHEN last_error LIKE '%Cannot append a signature to a forwarded post%' THEN 'forward_signature'
      WHEN last_error IS NOT NULL THEN 'other' ELSE NULL END AS error_family,
    created_at, updated_at FROM channel_auto_post_attach_markers
    WHERE chat_id = $1 ORDER BY updated_at DESC LIMIT ${MARKER_SAMPLE_CAP + 1}`,
  audits: `SELECT action, created_at,
    CASE WHEN jsonb_typeof(payload->'signatureApplied') = 'boolean'
      THEN (payload->>'signatureApplied')::boolean ELSE NULL END AS signature_applied,
    CASE WHEN payload->>'source' IN ('webhook','poll') THEN payload->>'source' ELSE NULL END AS source,
    CASE WHEN payload->>'schedulingOrigin' IN ('durable_demand','periodic_scan')
      THEN payload->>'schedulingOrigin' ELSE NULL END AS scheduling_origin,
    CASE WHEN length(payload->>'messageId') BETWEEN 1 AND 128 THEN payload->>'messageId' ELSE NULL END AS message_id,
    CASE WHEN jsonb_typeof(payload->'changed'->'enabled') = 'boolean'
      THEN (payload->'changed'->>'enabled')::boolean ELSE NULL END AS changed_enabled
    FROM audit_logs WHERE chat_id = $1 ORDER BY created_at DESC LIMIT ${MARKER_SAMPLE_CAP + 1}`,
};
const INDEXES = {
  chats_entity_type_updated_id_idx: ['chats', ['entity_type', 'updated_at DESC', 'id']],
  chats_pkey: ['chats', ['id']],
  channel_settings_chat_id_key: ['channel_settings', ['chat_id']],
  chat_bot_memberships_chat_status_lifecycle_idx: [
    'chat_bot_memberships',
    ['chat_id', 'status', 'lifecycle_event_at DESC'],
  ],
  channel_auto_post_attach_markers_chat_updated_idx: [
    'channel_auto_post_attach_markers',
    ['chat_id', 'updated_at DESC'],
  ],
  audit_logs_chat_id_created_at_idx: ['audit_logs', ['chat_id', 'created_at']],
};
const INDEX_SQL = `SELECT i.indisvalid AND i.indisready AND i.indislive
    AND i.indpred IS NULL AND i.indexprs IS NULL AS ready,
    c.relname AS table_name, i.indnkeyatts AS key_count,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false) ||
      CASE WHEN (i.indoption[n - 1] & 1) = 1 THEN ' DESC' ELSE '' END
      FROM generate_series(1, i.indnkeyatts) n) AS keys
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
  WHERE i.indexrelid = to_regclass($1)`;

function normalizeTitle(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function parseArgs(args) {
  const [mode, value, ...extra] = args;
  if (mode === 'census' && args.length === 1) return { mode };
  if (mode === 'impact' && typeof value === 'string' && args.length === 2) {
    const chatIds = [...new Set(value.split(','))];
    if (
      chatIds.length < 1 ||
      chatIds.length > 128 ||
      chatIds.some((id) => !/^-[1-9][0-9]{0,19}$/u.test(id))
    ) {
      throw new Error('chat_id_bound');
    }
    return { mode, chatIds };
  }
  if (extra.length || !['find', 'inspect', 'demand'].includes(mode) || typeof value !== 'string') {
    throw new Error('Usage: channel-decoration-audit.cjs find <title> | inspect|demand <chat-id>');
  }
  if (mode === 'find' && (normalizeTitle(value).length < 5 || value.length > 160)) {
    throw new Error('title_bound');
  }
  if (['inspect', 'demand'].includes(mode) && !/^-[1-9][0-9]{0,19}$/u.test(value))
    throw new Error('chat_id');
  return { mode, value };
}

function summarizeFind(rows, title) {
  const needle = normalizeTitle(title);
  return {
    sampled: Math.min(rows.length, CHANNEL_SAMPLE_CAP),
    truncated: rows.length > CHANNEL_SAMPLE_CAP,
    matches: rows
      .slice(0, CHANNEL_SAMPLE_CAP)
      .filter((row) => normalizeTitle(row.title).includes(needle)),
  };
}

function assertBoundedPlan(plan, allowedIndex) {
  let found = false;
  const visit = (node) => {
    if (node['Node Type'] === 'Seq Scan' || node['Node Type'] === 'Bitmap Heap Scan') {
      throw new Error('unbounded_plan');
    }
    if (node['Index Name'] === allowedIndex && /Index.*Scan/u.test(node['Node Type'])) found = true;
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  if (!found) {
    const error = new Error('required_index_plan_missing');
    error.expectedIndex = allowedIndex;
    const actual = [];
    const indexes = (node) => {
      if (node['Index Name']) actual.push(node['Index Name']);
      for (const child of node.Plans ?? []) indexes(child);
    };
    indexes(plan);
    error.actualIndexes = actual;
    throw error;
  }
}

async function collect(client, options) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = '2500ms'; SET LOCAL lock_timeout = '250ms';
      SET LOCAL idle_in_transaction_session_timeout = '4s'; SET LOCAL timezone = 'UTC';
      SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off;
      SET LOCAL max_parallel_workers_per_gather = 0; SET LOCAL jit = off; SET LOCAL work_mem = '1MB'`);
    const names =
      options.mode === 'demand'
        ? Object.keys(DEMAND_INDEXES)
        : options.mode === 'find'
          ? ['chats_entity_type_updated_id_idx']
          : ['census', 'impact'].includes(options.mode)
            ? ['channel_settings_chat_id_key']
            : Object.keys(INDEXES).slice(1);
    for (const name of names) {
      const [expectedTable, expectedKeys] = DEMAND_INDEXES[name] ?? INDEXES[name];
      const row = (await client.query(INDEX_SQL, [`public.${name}`])).rows[0];
      if (
        !row?.ready ||
        row.table_name !== expectedTable ||
        row.key_count !== expectedKeys.length ||
        JSON.stringify(row.keys) !== JSON.stringify(expectedKeys)
      )
        throw new Error('index_not_ready');
    }
    if (options.mode === 'demand') {
      // FLAG: Scheduling timestamps are not ingress/attempt/effect receipts. Inspect
      // one channel and a capped indexed due-head sample; never scan retained history
      // or export unrelated channel identities to infer a complete fleet backlog.
      const report = {
        mode: 'demand',
        chatId: options.value,
        remoteEffectsProven: false,
        schedulingOnly: true,
        sampleCap: DEMAND_SAMPLE_CAP,
      };
      for (const [index, [key, sql]] of Object.entries(DEMAND_SQL).entries()) {
        const params = key === 'backlog' ? undefined : [options.value];
        const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0][
          'QUERY PLAN'
        ][0].Plan;
        assertBoundedPlan(plan, names[index]);
        const rows = (await client.query(sql, params)).rows;
        const cap = key === 'parent' ? 1 : DEMAND_SAMPLE_CAP;
        const sample = rows.slice(0, cap);
        report[key] =
          key === 'backlog'
            ? {
                sampledDueChannels: sample.length,
                truncated: rows.length > cap,
                oldestDueAt: sample[0]?.due_at ?? null,
              }
            : { rows: sample, truncated: rows.length > cap };
      }
      return report;
    }
    if (options.mode === 'find') {
      const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${FIND_SQL}`)).rows[0][
        'QUERY PLAN'
      ][0].Plan;
      assertBoundedPlan(plan, names[0]);
      return { mode: 'find', ...summarizeFind((await client.query(FIND_SQL)).rows, options.value) };
    }
    if (['census', 'impact'].includes(options.mode)) {
      const sql = options.mode === 'impact' ? IMPACT_SQL : CENSUS_SQL;
      const params = options.mode === 'impact' ? [options.chatIds] : undefined;
      const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0][
        'QUERY PLAN'
      ][0].Plan;
      assertBoundedPlan(plan, names[0]);
      const rows = (await client.query(sql, params)).rows;
      const cap = options.mode === 'impact' ? 128 : CHANNEL_SAMPLE_CAP;
      const sample = rows.slice(0, cap);
      const count = (key) => sample.filter((row) => row[key] === true).length;
      return {
        mode: options.mode,
        sampled: sample.length,
        truncated: rows.length > cap,
        ...(options.mode === 'impact' ? { requestedChats: options.chatIds.length } : {}),
        enabledAny: sample.filter((row) =>
          [
            'post_signature_enabled',
            'comments_enabled',
            'post_suggestions_enabled',
            'quick_buttons_enabled',
          ].some((key) => row[key] === true),
        ).length,
        signatures: count('post_signature_enabled'),
        comments: count('comments_enabled'),
        suggestions: count('post_suggestions_enabled'),
        quickButtons: count('quick_buttons_enabled'),
      };
    }
    const report = { mode: 'inspect', chatId: options.value, remoteEffectsProven: false };
    for (const [index, [key, sql]] of Object.entries(INSPECT_SQL).entries()) {
      const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, [options.value])).rows[0][
        'QUERY PLAN'
      ][0].Plan;
      assertBoundedPlan(plan, names[index]);
      const rows = (await client.query(sql, [options.value])).rows;
      const cap = ['markers', 'audits'].includes(key)
        ? MARKER_SAMPLE_CAP
        : key === 'memberships'
          ? 16
          : 1;
      report[key] = { rows: rows.slice(0, cap), truncated: rows.length > cap };
    }
    return report;
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.env.APP_ROLE !== 'admin') throw new Error('admin_role_required');
  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'maxim-channel-decoration-audit',
    connectionTimeoutMillis: 3000,
    query_timeout: 3500,
    options: '-c default_transaction_read_only=on -c statement_timeout=2500ms -c timezone=UTC',
  });
  const deadline = setTimeout(() => {
    process.exitCode = 1;
    client.end().catch(() => {});
  }, 20000);
  try {
    await client.connect();
    console.log(
      JSON.stringify({ observedAt: new Date().toISOString(), ...(await collect(client, options)) }),
    );
  } finally {
    clearTimeout(deadline);
    await client.end();
  }
}

module.exports = {
  CHANNEL_SAMPLE_CAP,
  DEMAND_SAMPLE_CAP,
  DEMAND_SQL,
  DEMAND_INDEXES,
  FIND_SQL,
  CENSUS_SQL,
  IMPACT_SQL,
  INSPECT_SQL,
  INDEXES,
  INDEX_SQL,
  normalizeTitle,
  parseArgs,
  summarizeFind,
  assertBoundedPlan,
  collect,
  main,
};
if (require.main === module || __filename === '[stdin]')
  main().catch((error) => {
    const safe = [
      'admin_role_required',
      'index_not_ready',
      'unbounded_plan',
      'required_index_plan_missing',
    ];
    console.error(
      JSON.stringify({
        incomplete: true,
        reason: safe.includes(error.message) ? error.message : 'probe_failed',
        ...(error.expectedIndex
          ? { expectedIndex: error.expectedIndex, actualIndexes: error.actualIndexes }
          : {}),
        code: /^[A-Z0-9]{5}$/u.test(error.code ?? '') ? error.code : null,
      }),
    );
    process.exitCode = 1;
  });
