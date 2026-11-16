import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import audit from './channel-decoration-audit.cjs';

const schema = `CREATE TABLE chats (id text PRIMARY KEY, title text, entity_type text,
  updated_at timestamp NOT NULL, bot_id text, primary_bot_id text, fixed_moderator_bot_id text,
  routing_state text);
CREATE INDEX chats_entity_type_updated_id_idx ON chats (entity_type, updated_at DESC, id);
CREATE TABLE channel_settings (chat_id text UNIQUE, post_signature_enabled boolean,
  post_signature_presentation text, post_signature_text text, post_signature_url text,
  quick_buttons_enabled boolean, comments_enabled boolean, post_suggestions_enabled boolean,
  custom_post_buttons_enabled boolean, custom_post_buttons_since timestamptz,
  custom_post_buttons jsonb, updated_at timestamp);
CREATE TABLE chat_bot_memberships (chat_id text, bot_id text, status text, bot_access_state text,
  bot_access_checked_at timestamp, bot_access_source text, lifecycle_event_at timestamp);
CREATE INDEX chat_bot_memberships_chat_status_lifecycle_idx ON chat_bot_memberships (chat_id, status, lifecycle_event_at DESC);
CREATE TABLE channel_auto_post_attach_markers (chat_id text, message_id text, status text, bot_id text,
  source text, delivery_mode text, link_type text, replacement_message_id text,
  replacement_send_started_at timestamp, original_deleted boolean, last_status_code int,
  last_error text, created_at timestamp, updated_at timestamp);
CREATE INDEX channel_auto_post_attach_markers_chat_updated_idx
  ON channel_auto_post_attach_markers (chat_id, updated_at DESC);
CREATE TABLE audit_logs (chat_id text, action text, payload jsonb, created_at timestamp);
CREATE INDEX audit_logs_chat_id_created_at_idx ON audit_logs (chat_id, created_at);`;

const demandSchema = `SET TIME ZONE 'UTC';
CREATE TABLE channel_post_demand_channels
  (chat_id text PRIMARY KEY, due_at timestamp);
CREATE INDEX channel_post_demand_channels_due_idx ON channel_post_demand_channels (due_at, chat_id);
CREATE TABLE channel_post_demands
  (chat_id text, message_id text, source_at timestamp, expires_at timestamp, due_at timestamp,
   PRIMARY KEY (chat_id, message_id));
CREATE INDEX channel_post_demands_due_idx ON channel_post_demands (chat_id, due_at, message_id);`;

// PGlite's query uses the extended protocol; send fixed multi-statement SET via exec.
function port(db) {
  return { query: (sql, args) => (sql.includes('SET LOCAL') ? db.exec(sql) : db.query(sql, args)) };
}

test('title search is capped before matching, Unicode tolerant and omits other titles', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  await db.exec(`INSERT INTO chats (id,title,entity_type,updated_at)
    SELECT '-' || n, 'private unrelated ' || n, 'CHANNEL', now() - n * interval '1 second'
    FROM generate_series(1, ${audit.CHANNEL_SAMPLE_CAP + 2}) n;
    UPDATE chats SET title = 'Новости/ЧП 28ру+Z🇷🇺' WHERE id = '-1';
    UPDATE chats SET title = 'Новости/ЧП 28ру old' WHERE id = '-2050';
    ANALYZE;`);
  const result = await audit.collect(port(db), audit.parseArgs(['find', 'Новости/ЧП 28ру']));
  assert.equal(result.sampled, 2048);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.matches.map((x) => x.id),
    ['-1'],
  );
  assert.doesNotMatch(JSON.stringify(result), /private unrelated/u);
});

test('exact channel inspection uses bounded indexes and omits raw errors and other channels', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  await db.exec(`INSERT INTO chats (id,title,entity_type,updated_at) VALUES ('-1','Target','CHANNEL',now());
    INSERT INTO chats (id,title,entity_type,updated_at)
      SELECT 'other-' || n, 'private', 'CHAT', now() FROM generate_series(1,5000) n;
    INSERT INTO channel_settings (chat_id,post_signature_enabled,post_signature_url,
      custom_post_buttons_enabled,custom_post_buttons_since,custom_post_buttons)
      VALUES ('-1', true, 'https://private-link', true, now(),
        '[{"text":"private button","url":"https://private-link"},{"text":"second private button"}]');
    INSERT INTO channel_auto_post_attach_markers (chat_id,message_id,status,last_error,updated_at)
      SELECT '-1', 'message-' || n, 'SKIPPED', 'private raw error', now() - n * interval '1 second'
      FROM generate_series(1,52) n;
    INSERT INTO channel_auto_post_attach_markers (chat_id,message_id,updated_at)
      VALUES ('-2','unrelated-message',now());
    INSERT INTO audit_logs VALUES ('-1','UPDATE_CHANNEL_POST_SIGNATURE',
      '{"changed":{"enabled":true},"private":"private raw"}',now()); ANALYZE;`);
  const result = await audit.collect(port(db), audit.parseArgs(['inspect', '-1']));
  assert.equal(result.markers.rows.length, 50);
  assert.equal(result.markers.truncated, true);
  assert.equal(result.settings.rows[0].custom_signature_url, true);
  assert.equal(result.settings.rows[0].custom_post_buttons_enabled, true);
  assert.equal(result.settings.rows[0].custom_post_button_count, 2);
  assert.ok(result.settings.rows[0].custom_post_buttons_since);
  assert.equal(result.remoteEffectsProven, false);
  assert.equal(result.audits.rows[0].changed_enabled, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private raw|private-link|private button|unrelated-message/u,
  );
  assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
});

test('poll provenance accepts only known scheduling paths and leaves old rows unknown', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  for (const schedulingOrigin of ['durable_demand', 'periodic_scan', 'private unknown', null]) {
    await db.query('INSERT INTO audit_logs VALUES ($1,$2,$3,now())', [
      '-1',
      'CHANNEL_AUTO_ATTACH',
      JSON.stringify({ source: 'poll', schedulingOrigin }),
    ]);
  }
  const result = await db.query(audit.INSPECT_SQL.audits, ['-1']);
  assert.deepEqual(result.rows.map((row) => row.scheduling_origin).sort(), [
    'durable_demand',
    null,
    null,
    'periodic_scan',
  ]);
  assert.doesNotMatch(JSON.stringify(result.rows), /private unknown/u);
});

test('missing or incorrectly defined index fails closed before scanning', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  await db.exec(`DROP INDEX chats_entity_type_updated_id_idx;
    CREATE INDEX chats_entity_type_updated_id_idx ON chats (title);`);
  await assert.rejects(
    audit.collect(port(db), { mode: 'find', value: 'Новости' }),
    /index_not_ready/u,
  );
});

test('census counts enabled modules after the cap without exporting channel IDs', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  await db.exec(`INSERT INTO channel_settings (chat_id,post_signature_enabled,comments_enabled)
    SELECT 'private-' || n, true, n % 2 = 0 FROM generate_series(1,2050) n; ANALYZE;`);
  const result = await audit.collect(port(db), audit.parseArgs(['census']));
  assert.equal(result.sampled, 2048);
  assert.equal(result.truncated, true);
  assert.equal(result.enabledAny, 2048);
  assert.equal(result.signatures, 2048);
  assert.equal(result.suggestions, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-/u);
});

test('rejects malformed scope and sequential or missing-index plans', () => {
  for (const args of [[], ['inspect', '-1; DROP'], ['find', 'x'], ['find', 'title', 'extra']]) {
    assert.throws(() => audit.parseArgs(args));
  }
  assert.throws(
    () => audit.assertBoundedPlan({ 'Node Type': 'Seq Scan' }, 'idx'),
    /unbounded_plan/u,
  );
  assert.throws(() => audit.assertBoundedPlan({ 'Node Type': 'Limit' }, 'idx'), /required_index/u);
});

test('impact inspects only the exact validated inventory scope', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(schema);
  await db.exec(`INSERT INTO channel_settings (chat_id,comments_enabled)
    SELECT '-' || n, true FROM generate_series(1,5000) n; ANALYZE;`);
  const result = await audit.collect(port(db), audit.parseArgs(['impact', '-1,-2,-2']));
  assert.equal(result.requestedChats, 2);
  assert.equal(result.sampled, 2);
  assert.equal(result.comments, 2);
  assert.equal(result.truncated, false);
  assert.throws(() =>
    audit.parseArgs(['impact', Array.from({ length: 129 }, (_, n) => `-${n + 1}`).join(',')]),
  );
  assert.throws(() => audit.parseArgs(['impact', '-1,secret']));
});

test('file and stdin entrypoints reject an unintended runtime role before opening stores', () => {
  const script = fileURLToPath(new URL('./channel-decoration-audit.cjs', import.meta.url));
  for (const stdin of [false, true]) {
    const result = spawnSync(process.execPath, [stdin ? '-' : script, 'census'], {
      input: stdin ? readFileSync(script) : undefined,
      env: { APP_ROLE: 'publisher' },
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).reason, 'admin_role_required');
    assert.equal(result.stdout, '');
  }
});

test('demand audit bounds pending posts and due heads before inspecting retained history', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(demandSchema);
  await db.exec(`INSERT INTO channel_post_demand_channels
      SELECT 'private-idle-' || n, NULL FROM generate_series(1,20000) n;
    INSERT INTO channel_post_demand_channels
      SELECT 'private-due-' || n, now() - interval '1 minute' FROM generate_series(1,66) n;
    INSERT INTO channel_post_demand_channels VALUES ('-1',now() + interval '1 minute');
    INSERT INTO channel_post_demands
      SELECT '-1', 'target-' || lpad(n::text,3,'0'), now() - interval '5 minutes',
        now() + interval '1 hour', now() + n * interval '1 second'
      FROM generate_series(1,66) n;
    INSERT INTO channel_post_demands
      SELECT 'private-idle-' || n, 'private-message', now(), now() + interval '1 day', now()
      FROM generate_series(1,20000) n; ANALYZE;`);
  const result = await audit.collect(port(db), audit.parseArgs(['demand', '-1']));
  assert.equal(result.remoteEffectsProven, false);
  assert.equal(result.schedulingOnly, true);
  assert.equal(result.parent.rows.length, 1);
  assert.ok(result.parent.rows[0].due_at > result.parent.rows[0].observed_at);
  assert.equal(result.items.rows.length, 64);
  assert.equal(result.items.truncated, true);
  assert.equal(result.items.rows[0].message_id, 'target-001');
  assert.equal(result.items.rows.at(-1).message_id, 'target-064');
  assert.equal(result.backlog.sampledDueChannels, 64);
  assert.equal(result.backlog.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /private-/u);
  assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');

  // Only the isolated fixture uses ANALYZE: prove the limit bounds actual index work
  // with large idle history and tied due times, not just the returned report size.
  await db.exec('SET enable_seqscan=off; SET enable_bitmapscan=off;');
  for (const [key, sql] of Object.entries(audit.DEMAND_SQL)) {
    const plan = (
      await db.query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
        key === 'backlog' ? undefined : ['-1'],
      )
    ).rows[0]['QUERY PLAN'][0].Plan;
    const nodes = [];
    const visit = (node) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan);
    const scans = nodes.filter((node) => /Scan$/u.test(node['Node Type']));
    assert.equal(scans.length, 1);
    assert.match(scans[0]['Node Type'], /Index/u);
    assert.ok(scans[0]['Actual Rows'] + (scans[0]['Rows Removed by Filter'] ?? 0) <= 65);
  }
});

test('demand audit distinguishes an empty queue and rejects a wrong due index', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(demandSchema);
  const result = await audit.collect(port(db), audit.parseArgs(['demand', '-1']));
  assert.deepEqual(result.parent, { rows: [], truncated: false });
  assert.deepEqual(result.items, { rows: [], truncated: false });
  assert.deepEqual(result.backlog, { sampledDueChannels: 0, truncated: false, oldestDueAt: null });
  await db.exec(`DROP INDEX channel_post_demand_channels_due_idx;
    CREATE INDEX channel_post_demand_channels_due_idx ON channel_post_demand_channels (chat_id, due_at);`);
  await assert.rejects(
    audit.collect(port(db), audit.parseArgs(['demand', '-1'])),
    /index_not_ready/u,
  );
  for (const args of [['demand'], ['demand', '-1; SELECT'], ['demand', '-1', 'extra']])
    assert.throws(() => audit.parseArgs(args));
});
