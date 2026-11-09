import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CHAT_MODERATION_AUDIT_COLUMNS,
  buildChatModerationAuditSql,
  buildChatModerationIndexReadinessSql,
  buildChatModerationPrivilegesSql,
  buildChatModerationProvisionSql,
  parseChatModerationAuditArgs,
} from './chat-moderation-audit.mjs';

const chatId = '-78270000000001';
const cli = new URL('./chat-moderation-audit.mjs', import.meta.url).pathname;

test('chat moderation admits only an exact bounded negative chat ID and plain explain', () => {
  assert.deepEqual(parseChatModerationAuditArgs([chatId]), { chatId, explain: false });
  assert.deepEqual(parseChatModerationAuditArgs([chatId, '--explain']), { chatId, explain: true });
  assert.doesNotThrow(() => parseChatModerationAuditArgs([`-${'9'.repeat(20)}`]));
  for (const args of [
    [],
    ['0'],
    ['-0'],
    ['-01'],
    ['1'],
    ['-1,-2'],
    ['-1\n'],
    [`-${'9'.repeat(21)}`],
    ["-1';SELECT private_data"],
    ['/tmp/query.sql'],
    ['-'],
    [chatId, '--file'],
    [chatId, '--explain', 'extra'],
    ['--privileges', '--require-all', 'extra'],
  ]) {
    assert.throws(() => parseChatModerationAuditArgs(args));
    const command = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      input: 'SELECT private_data FROM private_table;',
    });
    assert.equal(command.status, 2);
    assert.equal(command.stdout, '');
    assert.doesNotMatch(command.stderr, /private_data|private_table/u);
  }
  const validation = spawnSync(process.execPath, [cli, '--validate-scope', chatId], {
    encoding: 'utf8',
  });
  assert.equal(validation.status, 0);
  assert.equal(validation.stdout, '');
});

test('exact metadata lookups retain hard row and JSON budgets without private payload output', () => {
  const sql = buildChatModerationAuditSql([chatId]);
  for (const table of [
    'chats',
    'chat_settings',
    'chat_admin_roster_states',
    'chat_bot_memberships',
  ])
    assert.ok(sql.includes(`FROM public.${table} WHERE `));
  assert.match(sql, /WHERE id='-78270000000001' LIMIT 1/u);
  assert.match(sql, /WHERE chat_id='-78270000000001' ORDER BY bot_id LIMIT 9/u);
  assert.match(sql, /FROM membership_probe ORDER BY bot_id LIMIT 8/u);
  assert.match(sql, /'memberships_truncated',\(SELECT count\(\*\) FROM membership_probe\)>8/u);
  assert.match(sql, /pg_column_compression\(link_rules_policy\)/u);
  assert.match(sql, /pg_column_size\(link_rules_policy\)<=65536/u);
  assert.match(sql, /WHEN policy IS NULL THEN 'uninspected_storage'/u);
  assert.match(sql, /coalesce\(s.policy_state,'missing_settings'\)/u);
  assert.match(sql, /ELSE 'runtime_validation_required'/u);
  assert.match(sql, /WHEN chat.id IS NULL OR s.chat_id IS NULL THEN 'unknown'/u);
  assert.doesNotMatch(
    sql,
    /SELECT \*|EXPLAIN ANALYZE|jsonb_array_elements|permissions_snapshot|user_id|title|domain|token|message_id|raw_payload/u,
  );
  const explain = buildChatModerationAuditSql([chatId, '--explain']);
  assert.match(explain, /plan_cache_mode=force_generic_plan/u);
  assert.match(explain, /WHERE chat_id=\$1 ORDER BY bot_id LIMIT 9/u);
  assert.match(explain, /EXPLAIN \(FORMAT JSON\) EXECUTE/u);
});

test('only twelve optional metadata columns are provisioned and exact btree access is attested', () => {
  assert.equal(Object.values(CHAT_MODERATION_AUDIT_COLUMNS).flat().length, 12);
  const provision = buildChatModerationProvisionSql();
  for (const [table, columns] of Object.entries(CHAT_MODERATION_AUDIT_COLUMNS))
    assert.ok(provision.includes(`GRANT SELECT (${columns.join(',')}) ON TABLE public.${table}`));
  assert.doesNotMatch(provision, /GRANT SELECT ON|permissions|capabilities|title|user_id/u);
  assert.match(buildChatModerationPrivilegesSql(), /IN \(0,12\)/u);
  assert.match(buildChatModerationPrivilegesSql(true), /IN \(12\)/u);
  assert.match(buildChatModerationPrivilegesSql(), /has_table_privilege/u);
  const readiness = buildChatModerationIndexReadinessSql();
  for (const name of [
    'chats_pkey',
    'chat_settings_chat_id_key',
    'chat_bot_memberships_chat_id_bot_id_key',
    'chat_admin_roster_states_pkey',
  ])
    assert.ok(readiness.includes(`'${name}'`));
  for (const invariant of [
    'idx.indisvalid',
    'idx.indisready',
    'idx.indislive',
    'idx.indisunique',
    'idx.indimmediate',
    'idx.indpred IS NULL',
    'idx.indexprs IS NULL',
    "method.amname='btree'",
    'parent.relrowsecurity',
    'pg_inherits',
    'op.opcdefault',
    'idx.indoption',
    'idx.indcollation',
    'attribute.attcollation',
    'pg_get_indexdef',
  ])
    assert.ok(readiness.includes(invariant));
  assert.match(readiness, /SELECT 1\/0;/u);
});

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'explicit chat moderation native validation cannot silently skip',
  {
    skip: process.env.MAXIM_REQUIRE_CHAT_MODERATION_NATIVE !== '1',
  },
  () =>
    assert.ok(nativeUrl, 'MAXIM_REQUIRE_CHAT_MODERATION_NATIVE requires MAXIM_TEST_POSTGRES_URL'),
);

test(
  'native exact-chat observations preserve unknowns, privacy, sentinel and index/grant refusals',
  {
    skip: !nativeUrl,
    timeout: 60_000,
  },
  async (t) => {
    const address = new URL(nativeUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname));
    assert.match(address.pathname, /^\/(?:race_test|maxim_race_test_[a-f0-9]+)$/u);
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativeUrl,
      connectionTimeoutMillis: 5000,
      options:
        '-c statement_timeout=2500 -c lock_timeout=250 -c work_mem=1MB -c temp_file_limit=8MB -c max_parallel_workers_per_gather=0 -c enable_seqscan=off -c enable_bitmapscan=off -c jit=off -c timezone=UTC',
    });
    await client.connect();
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `chat_audit_${suffix}`;
    const reader = `chat_reader_${suffix}`;
    const scoped = (sql) =>
      sql
        .replaceAll('public.', `${schema}.`)
        .replaceAll("ns.nspname='public'", `ns.nspname='${schema}'`)
        .replaceAll('maxim_audit', reader);
    const readiness = (sql) => scoped(sql.split('\\gset')[0]);
    let ownsRole = false;
    t.after(async () => {
      try {
        await client.query('ROLLBACK; RESET ROLE');
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        if (ownsRole) await client.query(`DROP ROLE ${reader}`);
      } finally {
        await client.end();
      }
    });
    const version = Number(
      (await client.query('SHOW server_version_num')).rows[0].server_version_num,
    );
    assert.ok(version >= 160000 && version < 170000, 'Physical JSON admission is verified on PG16');
    await client.query(
      `CREATE SCHEMA ${schema}; CREATE ROLE ${reader}; SET search_path TO ${schema},pg_catalog;`,
    );
    ownsRole = true;
    await client.query(`CREATE TABLE chats(id text PRIMARY KEY,entity_type text,title text);
    CREATE TABLE chat_settings(id text,chat_id text NOT NULL,link_policy text,link_rules_policy jsonb,
      link_policy_revision integer,link_policy_effective_at timestamp,russian_profanity_filter_enabled boolean,
      profanity_sensitivity text,updated_at timestamp,private_text text);
    CREATE UNIQUE INDEX chat_settings_chat_id_key ON chat_settings(chat_id);
    CREATE TABLE chat_admin_roster_states(chat_id text PRIMARY KEY,completed_at timestamp,
      complete_probe_started_at timestamp,refresh_requested_at timestamp,private_user text);
    CREATE TABLE chat_bot_memberships(chat_id text,bot_id text,status text,bot_access_state text,
      bot_access_checked_at timestamp,bot_access_source text,lifecycle_event_at timestamp,private_token text);
    CREATE UNIQUE INDEX chat_bot_memberships_chat_id_bot_id_key ON chat_bot_memberships(chat_id,bot_id);
    GRANT USAGE ON SCHEMA ${schema} TO ${reader};
    GRANT SELECT(id,entity_type) ON chats TO ${reader};
    GRANT SELECT(chat_id,bot_id,status,bot_access_state,bot_access_checked_at,bot_access_source,lifecycle_event_at)
      ON chat_bot_memberships TO ${reader};`);
    const privileges = async (all = false) =>
      (await client.query(readiness(buildChatModerationPrivilegesSql(all)))).rows[0]
        .chat_moderation_privileges_ready;
    assert.equal(await privileges(), true);
    assert.equal(await privileges(true), false);
    await client.query(scoped(buildChatModerationProvisionSql()));
    assert.equal(await privileges(true), true);
    assert.equal(
      (await client.query(readiness(buildChatModerationIndexReadinessSql()))).rows[0]
        .chat_moderation_indexes_ready,
      true,
    );
    const report = async () => {
      await client.query(`BEGIN READ ONLY; SET LOCAL ROLE ${reader}`);
      try {
        const result = (await client.query(scoped(buildChatModerationAuditSql([chatId])))).rows[0]
          .json_build_object;
        await client.query('COMMIT');
        assert.doesNotMatch(JSON.stringify(result), /private|secret|https:|forbidden/u);
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    let value = await report();
    assert.equal(value.chat_present, false);
    assert.equal(value.link_filter_configured, 'unknown');
    assert.equal(value.link_policy_state, 'missing_settings');
    assert.equal(value.profanity_filter_enabled, null);
    assert.equal(value.admin_roster_initialized, null);
    await client.query('INSERT INTO chats VALUES($1,$2,$3)', [chatId, 'CHAT', 'private-title']);
    await client.query(
      `INSERT INTO chat_settings VALUES('private-id',$1,'BLOCKLIST_ONLY',NULL,4,NULL,true,'BALANCED',now(),'secret')`,
      [chatId],
    );
    value = await report();
    assert.equal(value.link_policy_state, 'legacy');
    assert.equal(value.link_filter_configured, 'enabled');
    assert.equal(value.profanity_filter_enabled, true);
    const setPolicy = async (policy) =>
      client.query('UPDATE chat_settings SET link_rules_policy=$1 WHERE chat_id=$2', [
        JSON.stringify(policy),
        chatId,
      ]);
    for (const invalid of [
      null,
      [],
      {},
      { version: 2, mode: 'DENY_ALL', rules: [] },
      { version: 1, mode: 'DENY_ALL', rules: null },
      { version: 1, mode: 'ALLOW_ALL', rules: [], extra: true },
      { version: 1, mode: 'DENY_ALL', rules: Array(301).fill({}) },
    ]) {
      await setPolicy(invalid);
      value = await report();
      assert.equal(value.link_policy_state, 'invalid_envelope');
      assert.equal(value.link_filter_configured, 'unknown');
    }
    for (const [mode, configured] of [
      ['ALLOW_ALL', 'disabled'],
      ['DENY_SELECTED', 'disabled'],
      ['ALLOW_SELECTED', 'enabled'],
      ['DENY_ALL', 'enabled'],
    ]) {
      await setPolicy({ version: 1, mode, rules: [] });
      value = await report();
      assert.equal(value.link_policy_state, 'valid_empty_rules');
      assert.equal(value.link_filter_configured, configured);
    }
    await setPolicy({
      version: 1,
      mode: 'DENY_ALL',
      rules: [{ target: 'https://private-forbidden.example' }],
    });
    value = await report();
    assert.equal(value.link_policy_state, 'runtime_validation_required');
    assert.equal(value.link_filter_configured, 'unknown');
    await setPolicy({ version: 1, mode: 'DENY_ALL', rules: [], extra: 'x'.repeat(1_000_000) });
    assert.equal((await report()).link_policy_state, 'uninspected_storage');
    await client.query(
      `INSERT INTO chat_bot_memberships
    SELECT $1,'bot-'||n,'ACTIVE','CONFIRMED_ADMIN',now(),'secret-source',now(),'secret-token'
    FROM generate_series(1,12) n`,
      [chatId],
    );
    await client.query(`INSERT INTO chats SELECT 'unrelated-'||n,'CHAT','private-title'
      FROM generate_series(1,20000) n;
    INSERT INTO chat_settings(chat_id,link_policy) SELECT 'unrelated-'||n,'ALERT_ONLY'
      FROM generate_series(1,20000) n;
    INSERT INTO chat_bot_memberships(chat_id,bot_id,status)
      SELECT 'unrelated-'||n,'bot-1','ACTIVE' FROM generate_series(1,20000) n;
    INSERT INTO chat_admin_roster_states(chat_id) SELECT 'unrelated-'||n
      FROM generate_series(1,20000) n;
    ANALYZE chats; ANALYZE chat_settings; ANALYZE chat_bot_memberships; ANALYZE chat_admin_roster_states;`);
    value = await report();
    assert.equal(value.memberships.length, 8);
    assert.equal(value.memberships_truncated, true);
    await client.query(
      `INSERT INTO chat_admin_roster_states VALUES($1,NULL,NULL,NULL,'private-user')`,
      [chatId],
    );
    assert.equal((await report()).admin_roster_initialized, false);
    await client.query(
      'UPDATE chat_admin_roster_states SET completed_at=now(),complete_probe_started_at=now() WHERE chat_id=$1',
      [chatId],
    );
    assert.equal((await report()).admin_roster_initialized, true);
    await client.query('BEGIN READ ONLY');
    const planResults = await client.query(
      scoped(buildChatModerationAuditSql([chatId, '--explain'])),
    );
    await client.query('COMMIT');
    const plan = planResults.find((result) => result.rows[0]?.['QUERY PLAN'])?.rows[0][
      'QUERY PLAN'
    ];
    assert.ok(plan);
    const planText = JSON.stringify(plan);
    assert.doesNotMatch(planText, /Seq Scan|Bitmap Heap Scan|private|78270000000001/u);
    for (const index of [
      'chats_pkey',
      'chat_settings_chat_id_key',
      'chat_bot_memberships_chat_id_bot_id_key',
      'chat_admin_roster_states_pkey',
    ])
      assert.ok(planText.includes(index), index);
    await client.query("UPDATE chats SET entity_type='CHANNEL' WHERE id=$1", [chatId]);
    value = await report();
    assert.equal(value.chat_moderation_applicable, false);
    assert.equal(value.link_filter_configured, 'not_applicable');
    await client.query(`GRANT SELECT(private_text) ON chat_settings TO ${reader}`);
    assert.equal(await privileges(), false);
    await client.query(`REVOKE SELECT(private_text) ON chat_settings FROM ${reader};
    REVOKE SELECT(link_policy) ON chat_settings FROM ${reader}`);
    assert.equal(await privileges(), false);
    await client.query(scoped(buildChatModerationProvisionSql()));
    assert.equal(await privileges(true), true);
    await client.query(`DROP INDEX chat_settings_chat_id_key;
    CREATE UNIQUE INDEX chat_settings_chat_id_key ON chat_settings(chat_id COLLATE "C")`);
    assert.equal(
      (await client.query(readiness(buildChatModerationIndexReadinessSql()))).rows[0]
        .chat_moderation_indexes_ready,
      false,
      'an index with different collation cannot attest the exact-key lookup',
    );
    await client.query(`DROP INDEX chat_settings_chat_id_key;
    CREATE UNIQUE INDEX chat_settings_chat_id_key ON chat_settings(chat_id)`);
    assert.equal(
      (await client.query(readiness(buildChatModerationIndexReadinessSql()))).rows[0]
        .chat_moderation_indexes_ready,
      true,
    );
    await client.query('DROP INDEX chat_bot_memberships_chat_id_bot_id_key');
    assert.equal(
      (await client.query(readiness(buildChatModerationIndexReadinessSql()))).rows[0]
        .chat_moderation_indexes_ready,
      false,
    );
  },
);
