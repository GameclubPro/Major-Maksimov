import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  buildPublisherSlotAuditSql,
  buildPublisherSlotIndexSql,
  buildPublisherSlotPrivilegesSql,
  PUBLISHER_SLOT_AUDIT_COLUMNS,
  validatePublisherSlotArgs,
} from './publisher-slot-audit.mjs';
import {
  buildPublisherPublicationPrivilegesSql,
  buildPublisherPublicationsAuditSql,
  PUBLISHER_PUBLICATION_AUDIT_COLUMNS,
} from './publisher-publications-audit.mjs';

const actor = '111222333';
const chat = '-77700011122233';
const minute = '2026-10-19T21:29:00Z';
const statuses = ['SCHEDULED', 'IN_PROGRESS', 'SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED'];
// FLAG: Keep the shared legacy fixture unchanged. This selector fixture uses the
// actual seven enum values and Prisma TIMESTAMP(3), including its indexed clocks.
const fixture =
  readFileSync(resolve(import.meta.dirname, 'test-fixtures/publisher-publications.sql'), 'utf8')
    .replace(
      /CREATE TYPE "PublicationOccurrenceStatus"[^;]+;/u,
      `CREATE TYPE "PublicationOccurrenceStatus" AS ENUM (${statuses.map((value) => `'${value}'`).join(',')});`,
    )
    .replaceAll('TIMESTAMPTZ', 'TIMESTAMP(3)') +
  `
  CREATE UNIQUE INDEX publication_targets_publication_target_key ON publication_targets(publication_id,target_chat_id);
  ALTER TABLE publication_occurrences ADD COLUMN schedule_revision INTEGER DEFAULT 1,
    ADD COLUMN delivery_deadline_at TIMESTAMP(3), ADD COLUMN dispatch_blocked_at TIMESTAMP(3),
    ADD COLUMN retry_authorized_at TIMESTAMP(3), ADD COLUMN retry_expires_at TIMESTAMP(3),
    ADD COLUMN created_at TIMESTAMP(3) DEFAULT now(), ADD COLUMN updated_at TIMESTAMP(3) DEFAULT now();
  ALTER TABLE managed_broadcast_deliveries ADD COLUMN target_chat_id TEXT,
    ADD COLUMN broadcast_id TEXT, ADD COLUMN content_revision_id TEXT,
    ADD COLUMN bot_id TEXT, ADD COLUMN required_bot_id TEXT,
    ADD COLUMN dispatch_profile "PublicationDispatchProfile", ADD COLUMN next_attempt_at TIMESTAMP(3),
    ADD COLUMN wait_reason TEXT, ADD COLUMN dispatch_blocker_code TEXT, ADD COLUMN locked_at TIMESTAMP(3),
    ADD COLUMN lock_token TEXT, ADD COLUMN sent_at TIMESTAMP(3), ADD COLUMN last_error_code TEXT;
  CREATE TABLE managed_broadcasts (id TEXT PRIMARY KEY, publication_occurrence_id TEXT,
    publication_content_revision_id TEXT, status TEXT, next_send_at TIMESTAMP(3),
    locked_at TIMESTAMP(3), lock_token TEXT, dispatch_profile "PublicationDispatchProfile",
    required_bot_id TEXT, text TEXT);
`;
const readiness = (sql) => sql.split('\\gset')[0];
const query = buildPublisherSlotAuditSql(actor, chat, minute);
const report = async (db) => (await db.query(query)).rows[0].json_build_object;
async function setup(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  return db;
}
async function seed(db) {
  await db.exec(`
    INSERT INTO publications VALUES ('private-p','${actor}','ERROR','SNAPSHOT','SELECTED','PUBLIK_V1','private-bot','private-title'),
      ('private-other-actor','999999999','ACTIVE','SNAPSHOT','SELECTED','PUBLIK_V1','private-bot','private-title'),
      ('private-dynamic','${actor}','ACTIVE','DYNAMIC','ALL_CHATS','PUBLIK_V1','private-bot','private-title');
    INSERT INTO publication_schedules VALUES ('private-s','ONCE','ERROR',1,'{"secret":"private-content"}');
    INSERT INTO publication_targets VALUES ('private-p','${chat}','CHANNEL',0),('private-other-actor','${chat}','CHANNEL',0);
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id)
    SELECT 'private-o-'||n,'private-p','private-s',state::"PublicationOccurrenceStatus",
      '${minute}'::timestamptz AT TIME ZONE 'UTC' + n*interval '1 second','PUBLIK_V1','private-bot'
    FROM unnest(ARRAY[${statuses.map((state) => `'${state}'`).join(',')}]) WITH ORDINALITY v(state,n);
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id,dispatch_blocker_code,
      delivery_deadline_at,dispatch_blocked_at,retry_authorized_at,retry_expires_at)
    VALUES ('private-slot-two','private-p','private-s','CANCELED','2026-10-19T21:30:59','PUBLIK_V1','private-bot','PUBLISHER_WINDOW_EXPIRED',
      '2026-10-20T21:30:59','2026-10-19T21:31:00','2026-10-19T21:31:01','2026-10-20T21:31:01'),
      ('private-not-owned','private-other-actor','private-s','SCHEDULED','2026-10-19T21:29:00','PUBLIK_V1','private-bot',NULL,NULL,NULL,NULL,NULL),
      ('private-dynamic-o','private-dynamic','private-s','SCHEDULED','2026-10-19T21:30:10','PUBLIK_V1','private-bot',NULL,NULL,NULL,NULL,NULL),
      ('private-too-old','private-p','private-s','SCHEDULED','2026-10-19T21:28:59.999','PUBLIK_V1','private-bot',NULL,NULL,NULL,NULL,NULL),
      ('private-too-new','private-p','private-s','SCHEDULED','2026-10-19T21:31:00','PUBLIK_V1','private-bot',NULL,NULL,NULL,NULL,NULL),
      ('private-legacy','private-p','private-s','SCHEDULED','2026-10-19T21:29:20','LEGACY_ROUTED','private-bot',NULL,NULL,NULL,NULL,NULL);
    INSERT INTO publisher_entity_bindings(chat_id,publisher_bot_id,status,bot_access_state,bot_access_checked_at)
      VALUES ('${chat}','private-bot','ACTIVE','CONFIRMED_ADMIN','2026-01-01');
    INSERT INTO managed_bot_chat_catalog VALUES ('private-bot','${chat}','ACTIVE','CHANNEL','private-title');
    INSERT INTO managed_entity_access_edges VALUES ('${chat}','${actor}','private-bot','GRANTED','ADMIN','CHANNEL','2026-01-01',NULL,NULL,'private-error');
    INSERT INTO managed_broadcast_deliveries(id,publication_occurrence_id,created_at,status,attempt_count,remote_message_id,target_chat_id,
      bot_id,required_bot_id,dispatch_profile,next_attempt_at,wait_reason,dispatch_blocker_code,locked_at,lock_token,sent_at,last_error_code)
    VALUES ('private-delivery','private-o-1','2026-10-19T21:29:02','AMBIGUOUS',2,'private-remote','${chat}',
      'private-bot','private-bot','PUBLIK_V1','2026-10-19T21:31:00','max_rate_limit','PUBLISHER_AUTH_PAUSED',
      '2026-10-19T21:29:01','private-lock',NULL,'private-unknown-error');
    UPDATE publication_occurrences SET content_revision_id='private-revision';
    UPDATE managed_broadcast_deliveries SET broadcast_id='private-envelope',content_revision_id='private-revision';
    INSERT INTO managed_broadcasts VALUES ('private-envelope','private-o-1','private-revision','ACTIVE',
      '2026-10-19T21:31:00',(statement_timestamp() AT TIME ZONE 'UTC')-interval '2 minutes',
      'private-envelope-lock','PUBLIK_V1','private-bot','private-content');
  `);
}

async function assertUtcMetadataClocks(db) {
  const originalZone = (await db.query("SELECT current_setting('TimeZone') AS zone")).rows[0].zone;
  const cases = [
    ['1 minute', null, 'bot_access_unconfirmed'],
    ['-1 minute', null, 'metadata_ready'],
    ['-2 days', '1 minute', 'route_quarantined'],
    ['-2 days', '-1 minute', 'metadata_ready'],
  ];
  try {
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      await db.query("SELECT set_config('TimeZone',$1,false)", [zone]);
      for (const [checkedOffset, quarantineOffset, expected] of cases) {
        await db.exec(`UPDATE publisher_entity_bindings SET
          bot_access_checked_at=(statement_timestamp() AT TIME ZONE 'UTC')+interval '${checkedOffset}',
          send_route_quarantined_until=${quarantineOffset ? `(statement_timestamp() AT TIME ZONE 'UTC')+interval '${quarantineOffset}'` : 'NULL'};`);
        const result = await report(db);
        assert.equal(result.matched_occurrences, 8, zone);
        assert.deepEqual(
          [...new Set(result.rows.map((row) => row.access_reason))],
          [expected],
          zone,
        );
        assert.equal(result.rows.find((row) => row.slot === 1).scheduled_at, '2026-10-19T21:30:59');
      }
    }
  } finally {
    await db.query("SELECT set_config('TimeZone',$1,false)", [originalZone]);
    await db.exec(
      "UPDATE publisher_entity_bindings SET bot_access_checked_at='2026-01-01',send_route_quarantined_until=NULL;",
    );
  }
}

function assertBoundedMetadataProbe(plan, table, index, keys, tuple = true) {
  const matches = [];
  const visit = (node, parent) => {
    if (node['Relation Name'] === table) matches.push({ node, parent });
    for (const childNode of node.Plans ?? []) visit(childNode, node);
  };
  visit(plan);
  assert.equal(matches.length, 1, table);
  const { node, parent } = matches[0];
  assert.equal(node['Node Type'], 'Index Scan', JSON.stringify(node));
  assert.ok([index].flat().includes(node['Index Name']), JSON.stringify(node));
  assert.equal(parent['Node Type'], 'Limit', JSON.stringify(parent));
  if (tuple) {
    const keyPattern = `ROW\\(${keys.join(', ')}\\)`;
    assert.match(node['Index Cond'], new RegExp(`${keyPattern} >= ROW\\(`, 'u'));
    assert.match(node['Index Cond'], new RegExp(`${keyPattern} <= ROW\\(`, 'u'));
  } else {
    for (const key of keys) assert.match(node['Index Cond'], new RegExp(`\\b${key} = `, 'u'));
  }
  assert.equal(node.Filter, undefined, JSON.stringify(node));
  assert.equal(node['Rows Removed by Filter'] ?? 0, 0, JSON.stringify(node));
  assert.equal(node['Rows Removed by Index Recheck'] ?? 0, 0, JSON.stringify(node));
  assert.ok(node['Actual Loops'] > 0, JSON.stringify(node));
  assert.ok(node['Actual Rows'] <= 1, JSON.stringify(node));
  const buffers = (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0);
  assert.ok(buffers <= 8 * Math.max(1, node['Actual Loops']), JSON.stringify(node));
  return { loops: node['Actual Loops'], rowsPerProbe: node['Actual Rows'], buffers };
}

test('UTC slot and Prisma metadata clocks stay equivalent across session timezones', async (t) => {
  const db = await setup(t);
  await seed(db);
  await assertUtcMetadataClocks(db);
});

test('target-only scope derives each author internally and never reports unrelated author candidates', async (t) => {
  const db = await setup(t);
  await seed(db);
  await db.exec(`
    INSERT INTO publications VALUES ('private-unrelated','888888888','PRIVATE_UNRELATED','SNAPSHOT','SELECTED','PUBLIK_V1','private-bot','private-title');
    INSERT INTO publication_targets VALUES ('private-unrelated','-999999999','CHANNEL',0);
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id)
      VALUES ('private-unrelated-o','private-unrelated','private-s','SCHEDULED','${minute}','PUBLIK_V1','private-bot');
  `);
  const targetQuery = buildPublisherSlotAuditSql(null, chat, minute);
  const targetReport = async () => (await db.query(targetQuery)).rows[0].json_build_object;
  const result = await targetReport();
  assert.equal(result.selection_scope, 'target');
  assert.equal(result.matched_occurrences, 9);
  assert.equal(result.source_complete, true);
  assert.equal(result.actor_candidates, undefined);
  assert.equal(result.actor_matched_occurrences, undefined);
  assert.equal(result.rows.filter((row) => row.access_reason === 'actor_edge_missing').length, 1);
  await db.exec(`INSERT INTO managed_entity_access_edges(chat_id,user_id,bot_id,state,user_role,entity_type)
    VALUES ('${chat}','999999999','private-bot','DENIED','ADMIN','CHANNEL');`);
  const denied = await targetReport();
  assert.equal(denied.rows.filter((row) => row.access_reason === 'actor_denied').length, 1);
  assert.doesNotMatch(
    JSON.stringify(denied),
    /private-|111222333|999999999|888888888|PRIVATE_UNRELATED|scoped_actor|actor_user_id/u,
  );
  assert.equal(denied.client_visibility, 'not_observed');
  const cli = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'publisher-slot-audit.mjs'), '--target', chat, minute],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /'selection_scope','target'/u);
  assert.doesNotMatch(cli.stdout, /'actor_candidates'/u);
});

test('fixed slots include every status, ERROR/cancellation causes and bounded actor candidates without identities', async (t) => {
  const db = await setup(t);
  await seed(db);
  const result = await report(db);
  assert.equal(result.matched_occurrences, 8);
  assert.equal(result.actor_matched_occurrences, 9);
  assert.equal(result.source_complete, true);
  assert.equal(result.deliveries_complete, true);
  assert.equal(result.capabilities_and_activation_checked, false);
  assert.equal(result.client_visibility, 'not_observed');
  assert.equal(result.window_minutes, 2);
  assert.deepEqual([...new Set(result.rows.map((row) => row.status))].sort(), [...statuses].sort());
  assert.equal(result.actor_candidates.filter((row) => !row.has_saved_target).length, 1);
  assert.equal(
    result.actor_candidates.find((row) => !row.has_saved_target).audience_mode,
    'DYNAMIC',
  );
  const canceled = result.rows.find((row) => row.slot === 1);
  assert.equal(canceled.blocker, 'PUBLISHER_WINDOW_EXPIRED');
  assert.equal(canceled.lifecycle, 'ERROR');
  assert.equal(canceled.schedule_status, 'ERROR');
  assert.equal(canceled.current_schedule_revision, true);
  for (const key of [
    'delivery_deadline_at',
    'dispatch_blocked_at',
    'retry_authorized_at',
    'retry_expires_at',
  ])
    assert.ok(canceled[key]);
  const delivery = result.rows.find((row) => row.status === 'SCHEDULED').target_deliveries[0];
  assert.equal(delivery.attempt_count, 2);
  assert.equal(delivery.has_recorded_remote_id, true);
  assert.equal(delivery.has_lock, true);
  assert.equal(delivery.waiting, 'max_rate_limit');
  assert.equal(delivery.saved_reason, 'other');
  assert.equal(delivery.blocker, 'PUBLISHER_AUTH_PAUSED');
  assert.equal(delivery.route_metadata_matches, true);
  assert.equal(delivery.envelope_present, true);
  assert.equal(delivery.envelope_status, 'ACTIVE');
  assert.equal(delivery.envelope_next_send_at, '2026-10-19T21:31:00');
  assert.equal(delivery.envelope_has_lock, true);
  assert.ok(delivery.envelope_lock_age_seconds >= 120);
  for (const key of [
    'envelope_profile_matches',
    'envelope_bot_matches',
    'envelope_occurrence_matches',
    'content_revision_matches',
  ])
    assert.equal(delivery[key], true);
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(`private-|${actor}|${chat}|publication_id|occurrence_id|lock_token`, 'u'),
  );
  await db.exec(
    "UPDATE managed_broadcast_deliveries SET bot_id='private-wrong',required_bot_id='private-wrong',wait_reason='private-wait';",
  );
  const wrong = (await report(db)).rows.find((row) => row.status === 'SCHEDULED')
    .target_deliveries[0];
  assert.equal(wrong.route_metadata_matches, false);
  assert.equal(wrong.waiting, 'other');
  await db.exec('UPDATE managed_entity_access_edges SET user_role=NULL;');
  assert.equal((await report(db)).rows[0].access_reason, 'actor_not_admin');
  await db.exec("UPDATE managed_entity_access_edges SET user_role='ADMIN',state=NULL;");
  assert.equal((await report(db)).rows[0].access_reason, 'actor_denied');
  await db.exec(
    "UPDATE managed_entity_access_edges SET state='GRANTED'; UPDATE publisher_entity_bindings SET bot_access_state=NULL;",
  );
  assert.equal((await report(db)).rows[0].access_reason, 'bot_access_unconfirmed');
});

test('both publication reports distinguish unknown bot roles from confirmed ordinary members', async (t) => {
  const db = await setup(t);
  await seed(db);
  await db.exec(`INSERT INTO chats VALUES ('${chat}','CHANNEL',NULL);
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id,dispatch_blocker_code)
    VALUES ('private-past','private-p','private-s','IN_PROGRESS','1970-01-01','PUBLIK_V1','private-bot','bot_not_admin');
    UPDATE publisher_entity_bindings SET last_webhook_at='1970-01-01',bot_access_checked_at='1970-01-01';`);
  for (const [state, expected] of [
    ['UNKNOWN', 'bot_access_unconfirmed'],
    [null, 'bot_access_unconfirmed'],
    ['CONFIRMED_MEMBER', 'bot_not_admin'],
    ['CONFIRMED_ADMIN', 'metadata_ready'],
  ]) {
    await db.query('UPDATE publisher_entity_bindings SET bot_access_state=$1', [state]);
    const slot = await report(db);
    assert.deepEqual([...new Set(slot.rows.map((row) => row.access_reason))], [expected]);
    const general = (await db.query(buildPublisherPublicationsAuditSql())).rows[0]
      .json_build_object;
    const reasons = general.target_reasons.filter((row) => row.occurrence_status === 'IN_PROGRESS');
    assert.deepEqual([...new Set(reasons.map((row) => row.reason))], [expected]);
    assert.ok(
      general.blockers.some(
        (row) => row.occurrence_status === 'IN_PROGRESS' && row.blocker === 'bot_not_admin',
      ),
    );
  }
});

test('bounded envelope metadata distinguishes missing parent, locks and exact content/bot mismatches', async (t) => {
  const db = await setup(t);
  await seed(db);
  const delivery = async () =>
    (await report(db)).rows.find((row) => row.status === 'SCHEDULED').target_deliveries[0];
  await db.exec(`UPDATE managed_broadcasts SET status='FAILED',publication_content_revision_id='private-changed',
    required_bot_id='private-wrong-bot',dispatch_profile='LEGACY_ROUTED',publication_occurrence_id='private-wrong-occurrence',
    locked_at=NULL;`);
  const mismatched = await delivery();
  assert.equal(mismatched.envelope_status, 'FAILED');
  assert.equal(mismatched.envelope_has_lock, true);
  assert.equal(mismatched.envelope_lock_age_seconds, null);
  for (const key of [
    'envelope_profile_matches',
    'envelope_bot_matches',
    'envelope_occurrence_matches',
    'content_revision_matches',
  ])
    assert.equal(mismatched[key], false);
  await db.exec(
    "UPDATE managed_broadcasts SET publication_content_revision_id='private-revision'; UPDATE managed_broadcast_deliveries SET content_revision_id='private-stale-delivery';",
  );
  assert.equal((await delivery()).content_revision_matches, false);
  await db.exec('DELETE FROM managed_broadcasts;');
  assert.equal((await delivery()).envelope_present, false);
  assert.equal((await delivery()).envelope_status, null);
  assert.doesNotMatch(
    JSON.stringify(await report(db)),
    new RegExp(`private-|${actor}|${chat}|content_revision_id|broadcast_id|lock_token`, 'u'),
  );
});

test('source and delivery sentinels precede actor/target filtering and preserve incomplete zero matches', async (t) => {
  const db = await setup(t);
  await db.exec(`
    INSERT INTO publications VALUES ('p','${actor}','ACTIVE','SNAPSHOT','SELECTED','PUBLIK_V1','bot',NULL),
      ('other','999999999','ACTIVE','SNAPSHOT','SELECTED','PUBLIK_V1','bot',NULL);
    INSERT INTO publication_schedules VALUES ('s','ONCE','ACTIVE',1,'{}');
    INSERT INTO publication_targets VALUES ('p','${chat}','CHANNEL',0);
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id)
      SELECT 'head-'||n,'other','s','SCHEDULED','2026-10-19T21:29:00'::timestamp,'PUBLIK_V1','bot' FROM generate_series(1,6000) n;
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id)
      VALUES ('selected-after-cap','p','s','SCHEDULED','2026-10-19T21:29:59','PUBLIK_V1','bot'),
        ('recipient-cap','p','s','SCHEDULED','2026-10-19T21:30:00','PUBLIK_V1','bot');
    INSERT INTO managed_broadcast_deliveries(id,publication_occurrence_id,created_at,status,attempt_count,target_chat_id)
      SELECT 'd-'||n,'recipient-cap','2026-10-19T21:30:00'::timestamp-n*interval '1 second','PENDING',0,
        CASE WHEN n=9 THEN '${chat}' ELSE '-99999999' END FROM generate_series(1,6000) n;
    ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off;
  `);
  const result = await report(db);
  assert.equal(result.source_complete, false);
  assert.equal(result.deliveries_complete, false);
  assert.equal(result.matched_occurrences, 1);
  assert.equal(result.rows[0].delivery_sampled, 8);
  assert.equal(result.rows[0].deliveries_truncated, true);
  assert.deepEqual(result.rows[0].target_deliveries, []);
  const target = (await db.query(buildPublisherSlotAuditSql(null, chat, minute))).rows[0]
    .json_build_object;
  assert.equal(target.source_complete, false);
  assert.equal(target.deliveries_complete, false);
  assert.equal(target.matched_occurrences, 1);
  assert.deepEqual(target.rows[0].target_deliveries, []);
  await db.exec("DELETE FROM publication_occurrences WHERE id='recipient-cap';");
  const noMatches = await report(db);
  assert.equal(noMatches.matched_occurrences, 0);
  assert.equal(noMatches.source_complete, false);
});

test('slot grants are optional zero-or-complete, require base metadata and deny content', async (t) => {
  const db = await setup(t);
  await seed(db);
  await db.exec('CREATE ROLE maxim_audit; GRANT USAGE ON SCHEMA public TO maxim_audit;');
  const optional = readiness(buildPublisherSlotPrivilegesSql());
  const required = readiness(buildPublisherSlotPrivilegesSql(true));
  assert.equal((await db.query(optional)).rows[0].publisher_slot_privileges_ready, true);
  assert.equal((await db.query(required)).rows[0].publisher_slot_privileges_ready, false);
  await db.exec('GRANT SELECT(schedule_revision) ON publication_occurrences TO maxim_audit;');
  assert.equal((await db.query(optional)).rows[0].publisher_slot_privileges_ready, false);
  for (const columns of [PUBLISHER_PUBLICATION_AUDIT_COLUMNS, PUBLISHER_SLOT_AUDIT_COLUMNS]) {
    for (const [table, fields] of Object.entries(columns))
      await db.exec(`GRANT SELECT(${fields.join(',')}) ON ${table} TO maxim_audit;`);
  }
  await db.exec(`GRANT SELECT(chat_id,publisher_bot_id,status,bot_access_state,bot_access_checked_at,send_route_quarantined_until) ON publisher_entity_bindings TO maxim_audit;
    GRANT SELECT(chat_id,publik_enabled) ON managed_entity_publication_policies TO maxim_audit;`);
  assert.equal((await db.query(required)).rows[0].publisher_slot_privileges_ready, true);
  assert.equal(
    (await db.query(readiness(buildPublisherPublicationPrivilegesSql(true)))).rows[0]
      .publisher_publication_audit_ready,
    true,
  );
  await db.exec('SET SESSION AUTHORIZATION maxim_audit;');
  assert.equal((await report(db)).matched_occurrences, 8);
  for (const sql of [
    'SELECT title FROM publications',
    'SELECT rule FROM publication_schedules',
    'SELECT last_error FROM managed_broadcast_deliveries',
    'SELECT text FROM managed_broadcasts',
    "UPDATE publication_occurrences SET status='SENT'",
  ])
    await assert.rejects(db.query(sql), /permission denied/u);
  await db.exec(
    'SET SESSION AUTHORIZATION postgres; GRANT SELECT(last_error) ON managed_broadcast_deliveries TO PUBLIC;',
  );
  assert.equal(
    (await db.query(readiness(buildPublisherPublicationPrivilegesSql()))).rows[0]
      .publisher_publication_audit_ready,
    false,
  );
});

test('actual provisioner grants only complete slot metadata and rejects partial or excess effective grants', async (t) => {
  const db = await setup(t);
  const source = readFileSync(
    resolve(import.meta.dirname, 'vps-provision-postgres-audit-role.sh'),
    'utf8',
  );
  const grantStart = source.indexOf('DO $publisher_slot_grants$');
  const grantEnd =
    source.indexOf('$publisher_slot_grants$;', grantStart) + '$publisher_slot_grants$;'.length;
  const marker = source.indexOf(
    "RAISE EXCEPTION 'maxim_audit publication metadata privileges are not exact'",
  );
  const assertionStart = source.lastIndexOf('\n  IF (', marker);
  const assertionEnd = source.indexOf('END IF;', marker) + 'END IF;'.length;
  assert.ok(grantStart > 0 && assertionStart > grantEnd);
  const grants = source.slice(grantStart, grantEnd);
  const assertion = `DO $slot_assertion$ BEGIN ${source.slice(assertionStart, assertionEnd)} END $slot_assertion$;`;
  await db.exec('CREATE ROLE maxim_audit;');
  for (const [table, fields] of Object.entries(PUBLISHER_PUBLICATION_AUDIT_COLUMNS))
    await db.exec(`GRANT SELECT(${fields.join(',')}) ON ${table} TO maxim_audit;`);
  await db.exec(assertion); // Old forty-three-column group and zero additive access.
  await db.exec(grants);
  await db.exec(grants); // Provision is idempotent.
  await db.exec(assertion);
  const counts = (
    await db.query(`SELECT count(*)::integer AS count FROM information_schema.role_column_grants
    WHERE grantee='maxim_audit' AND table_schema='public' AND privilege_type='SELECT'`)
  ).rows[0].count;
  assert.equal(counts, 74);
  await db.exec('REVOKE SELECT(schedule_revision) ON publication_occurrences FROM maxim_audit;');
  await assert.rejects(db.exec(assertion), /publication metadata privileges are not exact/u);
  await db.exec(grants);
  await db.exec('GRANT SELECT(last_error) ON managed_broadcast_deliveries TO PUBLIC;');
  await assert.rejects(db.exec(assertion), /publication metadata privileges are not exact/u);
  await db.exec('REVOKE SELECT(last_error) ON managed_broadcast_deliveries FROM PUBLIC;');
  for (const [table, fields] of Object.entries(PUBLISHER_SLOT_AUDIT_COLUMNS))
    await db.exec(`REVOKE SELECT(${fields.join(',')}) ON ${table} FROM maxim_audit;`);
  await db.exec('ALTER TABLE managed_broadcast_deliveries DROP COLUMN last_error_code;');
  await db.exec(grants); // Partial old schema receives none of the complete additive group.
  await db.exec(assertion);
  assert.equal(
    (await db.query(readiness(buildPublisherSlotPrivilegesSql()))).rows[0]
      .publisher_slot_privileges_ready,
    true,
  );
  await db.exec('GRANT SELECT(schedule_revision) ON publication_occurrences TO PUBLIC;');
  await assert.rejects(db.exec(assertion), /publication metadata privileges are not exact/u);
  assert.equal(
    (await db.query(readiness(buildPublisherSlotPrivilegesSql()))).rows[0]
      .publisher_slot_privileges_ready,
    false,
  );
});

test('exact index/type/status attestations reject drift', async (t) => {
  const db = await setup(t);
  const ready = async () =>
    (await db.query(readiness(buildPublisherSlotIndexSql()))).rows[0].publisher_slot_indexes_ready;
  assert.equal(await ready(), true);
  await db.exec(
    'DROP INDEX publication_targets_publication_target_key; CREATE UNIQUE INDEX publication_targets_publication_target_key ON publication_targets(target_chat_id,publication_id);',
  );
  assert.equal(await ready(), false);
  await db.exec(
    'DROP INDEX publication_targets_publication_target_key; CREATE UNIQUE INDEX publication_targets_publication_target_key ON publication_targets(publication_id text_pattern_ops,target_chat_id);',
  );
  assert.equal(await ready(), false);
  await db.exec(
    'DROP INDEX publication_targets_publication_target_key; CREATE UNIQUE INDEX publication_targets_publication_target_key ON publication_targets(publication_id,target_chat_id);',
  );
  assert.equal(await ready(), true);
  await db.exec(`ALTER TYPE "PublicationOccurrenceStatus" ADD VALUE 'FUTURE_UNKNOWN';`);
  assert.equal(await ready(), false);
});

test('CLI rejects injection, nonminute clocks, invalid dates, arbitrary options and excessive arguments', () => {
  const script = resolve(import.meta.dirname, 'publisher-slot-audit.mjs');
  for (const args of [
    ["1' OR true --", chat, minute],
    [actor, '123', minute],
    [actor, chat, '2026-02-30T21:29:00Z'],
    [actor, chat, '2026-10-19T21:29:01Z'],
    [actor, chat, minute, '--analyze'],
    [actor, chat, minute, '--explain', 'extra'],
    ['--target', chat, '2026-02-30T21:29:00Z'],
    ['--target', '123', minute],
    ['--target', chat, minute, '--apply'],
  ]) {
    if (!args[3]) assert.throws(() => validatePublisherSlotArgs(...args.slice(0, 3)), /Expected/u);
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
test(
  'native PostgreSQL bounds every base index visit before filters, hides IDs in plans and honors UTC minutes',
  { skip: !nativeUrl, timeout: 90_000 },
  async (t) => {
    const address = new URL(nativeUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname));
    assert.match(address.pathname, /^\/(?:race_test|maxim_race_test_[a-f0-9]+)$/u);
    const { default: pg } = await import('pg');
    const database = `race_test_publisher_slot_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: address.href });
    const child = new URL(address);
    child.pathname = `/${database}`;
    const db = new pg.Client({
      connectionString: child.href,
      options: '-c timezone=Asia/Tokyo -c statement_timeout=5000 -c lock_timeout=250',
    });
    db.exec = (sql) => db.query(sql);
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    t.after(async () => {
      await db.end();
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin.end();
    });
    await db.connect();
    assert.match((await db.query('SELECT version()')).rows[0].version, /^PostgreSQL 16/u);
    await db.exec(fixture);
    await seed(db);
    await assertUtcMetadataClocks(db);
    await db.exec(`
    CREATE INDEX publication_occurrences_status_scheduled_idx ON publication_occurrences(status,scheduled_at);
    CREATE INDEX publication_occurrences_dispatch_created_idx ON publication_occurrences(dispatch_profile,status,created_at,id);
    CREATE INDEX managed_bot_chat_catalog_chat_status_idx ON managed_bot_chat_catalog(chat_id,status);
    CREATE INDEX managed_entity_access_edges_user_demand_idx ON managed_entity_access_edges(user_id,chat_id,bot_id);
    INSERT INTO managed_bot_chat_catalog(bot_id,chat_id,status,entity_type,title)
      SELECT 'private-other-bot-'||n,'${chat}','ACTIVE','CHANNEL',NULL FROM generate_series(1,20000) n;
    INSERT INTO managed_entity_access_edges(chat_id,user_id,bot_id,state,user_role,entity_type)
      SELECT '${chat}','${actor}','private-other-bot-'||n,'GRANTED','ADMIN','CHANNEL' FROM generate_series(1,20000) n;
    INSERT INTO managed_broadcasts(id,status) SELECT 'private-old-envelope-'||n,'ACTIVE' FROM generate_series(1,20000) n;
    INSERT INTO managed_broadcasts(id,publication_occurrence_id,publication_content_revision_id,status,dispatch_profile,required_bot_id)
      VALUES ('private-native-envelope','private-o-3','private-revision','ACTIVE','PUBLIK_V1','private-bot');
    INSERT INTO managed_broadcast_deliveries(id,publication_occurrence_id,created_at,status,attempt_count,target_chat_id,
      broadcast_id,content_revision_id,bot_id,required_bot_id,dispatch_profile)
      VALUES ('private-native-present','private-o-3','2026-10-19T21:29:30','PENDING',0,'${chat}',
        'private-native-envelope','private-revision','private-bot','private-bot','PUBLIK_V1'),
      ('private-native-absent','private-o-3','2026-10-19T21:29:31','PENDING',0,'${chat}',
        'private-native-missing-envelope','private-revision','private-bot','private-bot','PUBLIK_V1');
    INSERT INTO publications SELECT 'private-history-p-'||n,'999999999','ACTIVE','SNAPSHOT','SELECTED','PUBLIK_V1','private-bot',NULL FROM generate_series(1,50000) n;
    INSERT INTO publication_schedules SELECT 'private-history-s-'||n,'ONCE','ACTIVE',1,'{}' FROM generate_series(1,50000) n;
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id)
      SELECT 'private-history-o-'||n,'private-history-p-'||n,'private-history-s-'||n,'SCHEDULED',
        '2026-10-18'::timestamp-n*interval '1 second','PUBLIK_V1','private-bot' FROM generate_series(1,50000) n;
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id)
      SELECT 'private-tied-'||n,'private-history-p-'||n,'private-history-s-'||n,'SCHEDULED',
        '2026-10-19T21:29:00'::timestamp,'PUBLIK_V1','private-bot' FROM generate_series(1,6000) n;
    INSERT INTO publication_occurrences(id,publication_id,schedule_id,status,scheduled_at,dispatch_profile,required_bot_id)
      SELECT 'private-competing-'||n,'private-history-p-'||n,'private-history-s-'||n,'SCHEDULED',
        '2026-10-19T21:29:00'::timestamp,'LEGACY_ROUTED','private-bot' FROM generate_series(1,20000) n;
    INSERT INTO publication_targets SELECT 'private-p','-900000'||n,'CHANNEL',n FROM generate_series(1,20000) n;
    INSERT INTO managed_broadcast_deliveries(id,publication_occurrence_id,created_at,status,attempt_count,target_chat_id)
      SELECT 'private-audience-'||n,'private-o-2','2026-10-19T21:29:30'::timestamp-n*interval '1 second','PENDING',0,
        CASE WHEN n=9 THEN '${chat}' ELSE '-999999999' END FROM generate_series(1,6000) n;
    ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off; SET max_parallel_workers_per_gather=0;
    SET work_mem='1MB'; SET temp_file_limit='8MB';
  `);
    assert.equal(
      (await db.query(readiness(buildPublisherSlotIndexSql()))).rows[0]
        .publisher_slot_indexes_ready,
      true,
    );
    const result = await report(db);
    assert.equal(result.source_complete, false);
    assert.equal(result.deliveries_complete, false);
    assert.equal(result.rows.find((row) => row.status === 'IN_PROGRESS').delivery_sampled, 8);
    assert.deepEqual(result.rows.find((row) => row.status === 'IN_PROGRESS').target_deliveries, []);
    assert.equal(result.rows.find((row) => row.slot === 1).scheduled_at, '2026-10-19T21:30:59');
    const nativeEnvelopes = result.rows.find((row) => row.status === 'SENT').target_deliveries;
    assert.equal(nativeEnvelopes.length, 2);
    assert.equal(nativeEnvelopes.filter((row) => row.envelope_present).length, 1);
    assert.equal(nativeEnvelopes.filter((row) => !row.envelope_present).length, 1);
    for (const row of nativeEnvelopes.filter((delivery) => delivery.envelope_present)) {
      for (const flag of [
        'envelope_profile_matches',
        'envelope_bot_matches',
        'envelope_occurrence_matches',
        'content_revision_matches',
      ]) {
        assert.equal(row[flag], true);
      }
    }
    const nativePlan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`)).rows[0][
      'QUERY PLAN'
    ][0].Plan;
    const targetQuery = buildPublisherSlotAuditSql(null, chat, minute);
    const nativeTargetPlan = (
      await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${targetQuery}`)
    ).rows[0]['QUERY PLAN'][0].Plan;
    const targetNodes = [];
    const visitTarget = (node) => {
      if (node['Relation Name']) targetNodes.push(node);
      for (const child of node.Plans ?? []) visitTarget(child);
    };
    visitTarget(nativeTargetPlan);
    const targetHeads = targetNodes.filter(
      (node) => node['Relation Name'] === 'publication_occurrences',
    );
    assert.equal(targetHeads.length, 14);
    for (const node of targetNodes) {
      assert.ok(
        ['Index Scan', 'Index Only Scan'].includes(node['Node Type']),
        JSON.stringify(node),
      );
      const source = node['Relation Name'] === 'publication_occurrences';
      const cap = source ? 33 : node['Relation Name'] === 'managed_broadcast_deliveries' ? 9 : 1;
      assert.ok(
        node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) <= cap,
        JSON.stringify(node),
      );
      if (source) {
        assert.equal(node['Index Name'], 'publication_occurrences_dispatch_status_scheduled_idx');
        assert.equal(node['Actual Loops'], 1);
        assert.match(node['Index Cond'], /scheduled_at/u);
      }
    }
    assertBoundedMetadataProbe(
      nativeTargetPlan,
      'managed_entity_access_edges',
      ['managed_entity_access_edges_pkey', 'managed_entity_access_edges_user_demand_idx'],
      ['chat_id', 'user_id', 'bot_id'],
      false,
    );
    const targetReport = (await db.query(targetQuery)).rows[0].json_build_object;
    assert.equal(targetReport.selection_scope, 'target');
    assert.equal(targetReport.source_complete, false);
    assert.equal(targetReport.deliveries_complete, false);
    assert.deepEqual(
      targetReport.rows.find((row) => row.status === 'IN_PROGRESS').target_deliveries,
      [],
    );
    assert.doesNotMatch(
      JSON.stringify(targetReport),
      /private-|111222333|77700011122233|scoped_actor|actor_candidates/u,
    );
    assert.doesNotMatch(
      JSON.stringify(
        (await db.query(buildPublisherSlotAuditSql(null, chat, minute, true))).rows[0][
          'QUERY PLAN'
        ],
      ),
      new RegExp(`${actor}|${chat}`, 'u'),
    );
    const catalogPresent = assertBoundedMetadataProbe(
      nativePlan,
      'managed_bot_chat_catalog',
      'managed_bot_chat_catalog_pkey',
      ['bot_id', 'chat_id'],
    );
    const actorPresent = assertBoundedMetadataProbe(
      nativePlan,
      'managed_entity_access_edges',
      ['managed_entity_access_edges_pkey', 'managed_entity_access_edges_user_demand_idx'],
      ['chat_id', 'user_id', 'bot_id'],
      false,
    );
    const envelopePresent = assertBoundedMetadataProbe(
      nativePlan,
      'managed_broadcasts',
      'managed_broadcasts_pkey',
      ['id'],
      false,
    );
    await db.exec("DELETE FROM managed_broadcasts WHERE id='private-native-envelope';");
    const envelopeAbsent = assertBoundedMetadataProbe(
      (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`)).rows[0]['QUERY PLAN'][0]
        .Plan,
      'managed_broadcasts',
      'managed_broadcasts_pkey',
      ['id'],
      false,
    );
    assert.ok(
      (await report(db)).rows
        .find((row) => row.status === 'SENT')
        .target_deliveries.every((row) => !row.envelope_present),
    );
    const plainPlan = (await db.query(buildPublisherSlotAuditSql(actor, chat, minute, true)))
      .rows[0]['QUERY PLAN'];
    assert.doesNotMatch(JSON.stringify(plainPlan), new RegExp(`${actor}|${chat}`, 'u'));
    const nodes = [];
    const visit = (node) => {
      nodes.push(node);
      for (const childNode of node.Plans ?? []) visit(childNode);
    };
    visit(nativePlan);
    const tables = nodes.filter((node) => node['Relation Name']);
    assert.ok(tables.length > 20);
    assert.ok(
      tables.every(
        (node) => node['Node Type'] === 'Index Scan' || node['Node Type'] === 'Index Only Scan',
      ),
    );
    await db.exec(`INSERT INTO chats VALUES ('${chat}','CHANNEL',NULL);
      UPDATE publication_occurrences SET scheduled_at='2026-01-01' WHERE id='private-o-1';`);
    const generalQuery = buildPublisherPublicationsAuditSql();
    const generalCatalogPresent = assertBoundedMetadataProbe(
      (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${generalQuery}`)).rows[0][
        'QUERY PLAN'
      ][0].Plan,
      'managed_bot_chat_catalog',
      'managed_bot_chat_catalog_pkey',
      ['bot_id', 'chat_id'],
    );
    assert.ok(
      (await db.query(generalQuery)).rows[0].json_build_object.target_reasons.some(
        (row) => row.reason === 'metadata_ready',
      ),
    );
    await db.exec(`DELETE FROM managed_bot_chat_catalog WHERE bot_id='private-bot';`);
    const absentQuery = buildPublisherSlotAuditSql(actor, chat, minute);
    const catalogAbsent = assertBoundedMetadataProbe(
      (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${absentQuery}`)).rows[0][
        'QUERY PLAN'
      ][0].Plan,
      'managed_bot_chat_catalog',
      'managed_bot_chat_catalog_pkey',
      ['bot_id', 'chat_id'],
    );
    assert.ok(
      (await report(db)).rows.every((row) => row.access_reason === 'catalog_missing_or_inactive'),
    );
    const generalCatalogAbsent = assertBoundedMetadataProbe(
      (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${generalQuery}`)).rows[0][
        'QUERY PLAN'
      ][0].Plan,
      'managed_bot_chat_catalog',
      'managed_bot_chat_catalog_pkey',
      ['bot_id', 'chat_id'],
    );
    const generalMissingReasons = (await db.query(generalQuery)).rows[0].json_build_object
      .target_reasons;
    assert.ok(generalMissingReasons.some((row) => row.reason === 'catalog_missing_or_inactive'));
    assert.ok(generalMissingReasons.every((row) => row.reason !== 'metadata_ready'));
    await db.exec(`INSERT INTO managed_bot_chat_catalog VALUES ('private-bot','${chat}','ACTIVE','CHANNEL',NULL);
      DELETE FROM managed_entity_access_edges WHERE chat_id='${chat}' AND user_id='${actor}' AND bot_id='private-bot';`);
    const actorAbsent = assertBoundedMetadataProbe(
      (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${absentQuery}`)).rows[0][
        'QUERY PLAN'
      ][0].Plan,
      'managed_entity_access_edges',
      ['managed_entity_access_edges_pkey', 'managed_entity_access_edges_user_demand_idx'],
      ['chat_id', 'user_id', 'bot_id'],
      false,
    );
    const missingActorRows = (await report(db)).rows;
    assert.ok(missingActorRows.length > 0);
    assert.ok(missingActorRows.every((row) => row.access_reason === 'actor_edge_missing'));
    const source = tables.filter((node) => node['Relation Name'] === 'publication_occurrences');
    assert.equal(source.length, 14);
    for (const node of source) {
      assert.equal(node['Index Name'], 'publication_occurrences_dispatch_status_scheduled_idx');
      assert.ok(
        node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) <= 33,
        JSON.stringify(node),
      );
      assert.equal(node['Actual Loops'], 1);
      assert.match(node['Index Cond'], /scheduled_at/u);
    }
    for (const node of tables.filter(
      (node) => node['Relation Name'] !== 'publication_occurrences',
    )) {
      const cap = node['Relation Name'] === 'managed_broadcast_deliveries' ? 9 : 1;
      assert.ok(
        node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) <= cap,
        JSON.stringify(node),
      );
      assert.ok(
        node['Actual Loops'] <= (node['Relation Name'] === 'managed_broadcasts' ? 448 * 8 : 448),
        JSON.stringify(node),
      );
    }
    assert.ok(
      tables.some((node) => node['Index Name'] === 'publication_targets_publication_target_key'),
    );
    assert.ok(
      tables.some(
        (node) =>
          node['Index Name'] === 'managed_broadcast_deliveries_pub_occurrence_created_id_idx',
      ),
    );
    t.diagnostic(
      JSON.stringify({
        postgres: 16,
        sourceIndexHeads: source.length,
        sourceRowsVisited: source.reduce((n, node) => n + node['Actual Rows'], 0),
        maxSourceRowsPerHead: 33,
        maxDeliveryRowsPerProbe: 9,
        allOtherRowsPerProbe: 1,
        sourceComplete: result.source_complete,
        deliveriesComplete: result.deliveries_complete,
        planIdentifiersExposed: false,
        catalogPresent,
        actorPresent,
        envelopePresent,
        envelopeAbsent,
        actorAbsent,
        catalogAbsent,
        generalCatalogPresent,
        generalCatalogAbsent,
      }),
    );
  },
);
