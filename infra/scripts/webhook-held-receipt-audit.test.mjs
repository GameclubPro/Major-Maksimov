import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  HELD_RECEIPT_COLUMNS,
  heldReceiptPrivilegesSql,
  heldReceiptIndexesSql,
  buildHeldReceiptAuditSql,
  emitHeldReceiptAuditSql,
  parseHeldReceiptAuditArgs,
} from './webhook-held-receipt-audit.mjs';

const privateValue = 'PRIVATE_MESSAGE_IDENTITY_CONTENT_TOKEN';
const receiptId = 'private-receipt';
const receiptAt = '2026-10-27T05:51:36.257';
const sealAt = '2026-10-27T05:00:00.000';
const semanticKey = `message:message_removed:${privateValue}:${privateValue}`;
const fixtureSql = `
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED','QUEUED','PROCESSED','FAILED');
CREATE TABLE webhook_events (
  id text PRIMARY KEY,status "WebhookStatus",created_at timestamp(3),normalized_payload jsonb,
  semantic_key text,error_message text,enqueue_attempts integer DEFAULT 0,queue_name text,
  queued_at timestamp(3),processed_at timestamp(3),legacy_disposition_id text,
  legacy_disposition_receipt_id text,source_disposition_id text,source_disposition_receipt_id text
);
ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET STORAGE EXTERNAL;
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);
CREATE TABLE webhook_legacy_recoveries (
  id text PRIMARY KEY,chat_id text,message_id text,user_id text,owner_webhook_event_id text,
  certificate_id text,authority_version integer DEFAULT 1,disposition text DEFAULT 'NO_REPLAY_ORDER_RELEASED',
  owner_snapshot jsonb,private_content text
);
CREATE INDEX webhook_legacy_recoveries_chat_message_idx ON webhook_legacy_recoveries(chat_id,message_id);
CREATE INDEX webhook_legacy_recoveries_chat_user_idx ON webhook_legacy_recoveries(chat_id,user_id);
CREATE INDEX webhook_legacy_recoveries_global_user_idx ON webhook_legacy_recoveries(user_id);
CREATE TABLE webhook_legacy_sealed_authorities (
  id text PRIMARY KEY,certificate_id text UNIQUE,authority_version integer,source_sha text,image_id text,
  attestation_digest text,preview_sha256 text,sealed_at timestamp(3),private_content text
);
CREATE TABLE webhook_legacy_quiescence_certificates (
  id text PRIMARY KEY,authority_version integer,source_sha text,image_id text,attestation_digest text,
  preview_sha256 text,quiesced_at timestamp(3),sealed_at timestamp(3),attestation jsonb
);
CREATE TABLE webhook_source_abandonments(chat_id text,message_id text,owner_snapshot jsonb);
CREATE UNIQUE INDEX webhook_source_abandonments_chat_message_key ON webhook_source_abandonments(chat_id,message_id);
CREATE TABLE webhook_backlog_receipts(receipt_id text PRIMARY KEY,semantic_key text,original_snapshot jsonb);
CREATE INDEX webhook_backlog_receipts_semantic_idx ON webhook_backlog_receipts(semantic_key);
`;

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixtureSql);
  return db;
}
const source = () => ({
  type: 'message_removed',
  message: {
    chatId: privateValue,
    messageId: privateValue,
    senderId: privateValue,
    text: privateValue,
  },
  raw: { update_type: 'message_removed', user_id: privateValue, token: privateValue },
});
async function seedReceipt(db, payload = source()) {
  await db.query(
    `INSERT INTO webhook_events(id,status,created_at,normalized_payload,semantic_key,error_message)
    VALUES ($1,'RECEIVED',$2,$3,$4,'Webhook preparation deferred: Legacy scope installation is not sealed')
    ON CONFLICT(id) DO UPDATE SET normalized_payload=excluded.normalized_payload`,
    [receiptId, receiptAt, JSON.stringify(payload), semanticKey],
  );
}
async function seedScope(db, id = 'private-scope', cert = 'private-cert', owner = 'private-owner') {
  await db.query(
    `INSERT INTO webhook_legacy_recoveries
    (id,chat_id,message_id,user_id,owner_webhook_event_id,certificate_id)
    VALUES ($1,$2,$2,$2,$3,$4)`,
    [id, privateValue, owner, cert],
  );
}
async function seedSeal(db, cert = 'private-cert', seal = sealAt) {
  await db.query(
    `INSERT INTO webhook_legacy_quiescence_certificates
    (id,authority_version,source_sha,image_id,attestation_digest,preview_sha256,quiesced_at,sealed_at)
    VALUES ($1,1,$2,$3,$4,$5,'2026-10-27T04:59:00',$6)`,
    [cert, 'a'.repeat(40), `sha256:${'b'.repeat(64)}`, 'c'.repeat(64), 'd'.repeat(64), seal],
  );
  await db.query(
    `INSERT INTO webhook_legacy_sealed_authorities
    (id,certificate_id,authority_version,source_sha,image_id,attestation_digest,preview_sha256,sealed_at)
    SELECT 'authority-'||id,id,authority_version,source_sha,image_id,attestation_digest,preview_sha256,sealed_at
    FROM webhook_legacy_quiescence_certificates WHERE id=$1`,
    [cert],
  );
}
async function report(db, targetId) {
  await db.exec('BEGIN READ ONLY');
  try {
    const value = (await db.query(buildHeldReceiptAuditSql(false, targetId))).rows[0]
      .jsonb_build_object;
    assert.equal(value.read_only, true);
    assert.equal(value.diagnostics_only, true);
    assert.equal(value.runtime_classifier_evaluated, false);
    assert.equal(value.settlement_authorized, false);
    assert.equal(value.replay_authorized, false);
    assert.equal(value.effect_completeness, 'unknown');
    assert.equal(value.source_validation, 'not_evaluated');
    assert.equal(value.other_hold_metadata.exclusive_protocol_proven, false);
    assert.equal(value.legacy_scope.all_matching_scopes_sealed_proven, false);
    const output = JSON.stringify(value);
    assert.ok(Buffer.byteLength(output) < 8192);
    assert.doesNotMatch(
      output,
      /PRIVATE_|private-(?:receipt|scope|cert|owner)|sha256:|https?:\/\//u,
    );
    return value;
  } finally {
    await db.exec('ROLLBACK');
  }
}
const grants = (role) =>
  Object.entries(HELD_RECEIPT_COLUMNS)
    .map(([table, columns]) => `GRANT SELECT (${columns.join(',')}) ON ${table} TO ${role};`)
    .join('\n');
const walk = (node) => [node, ...(node.Plans ?? []).flatMap(walk)];

test('CLI emits guarded read-only catalog SQL and refuses arbitrary scopes or repair options', () => {
  assert.equal(Object.values(HELD_RECEIPT_COLUMNS).flat().length, 28);
  for (const explain of [false, true]) {
    const sql = emitHeldReceiptAuditSql(explain);
    assert.ok(
      sql.indexOf('held_receipt_privileges_ready') < sql.indexOf('held_receipt_indexes_ready'),
    );
    assert.ok(
      sql.indexOf('held_receipt_indexes_ready') <
        sql.indexOf(explain ? 'EXPLAIN (FORMAT JSON)' : 'WITH head'),
    );
    assert.doesNotMatch(
      sql,
      /FOR UPDATE|EXPLAIN ANALYZE|\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO|FROM|public\.)/u,
    );
    assert.doesNotMatch(sql, /raw_payload|owner_snapshot|original_snapshot/u);
  }
  for (const args of [
    ['--apply'],
    ['receipt', 'another'],
    ['receipt;SELECT 1'],
    ['x'.repeat(129)],
    ['--explain', receiptId],
    ['--explain', '--explain'],
    ['--privileges', '--explain'],
  ]) {
    const result = spawnSync(process.execPath, [
      'infra/scripts/webhook-held-receipt-audit.mjs',
      ...args,
    ]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout.length, 0);
  }
  const result = spawnSync(process.execPath, [
    'infra/scripts/webhook-held-receipt-audit.mjs',
    '--privileges',
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout.toString(), /IN \(0,28\)/u);
  for (const args of [[], ['--explain'], [receiptId], [receiptId, '--explain']]) {
    const parsed = parseHeldReceiptAuditArgs(args);
    assert.equal(parsed.explain, args.includes('--explain'));
    assert.equal(parsed.receiptId, args.includes(receiptId) ? receiptId : undefined);
    const validated = spawnSync(process.execPath, [
      'infra/scripts/webhook-held-receipt-audit.mjs',
      '--validate-scope',
      ...args,
    ]);
    assert.equal(validated.status, 0);
    assert.equal(validated.stdout.length, 0);
  }
  const keyedPlan = buildHeldReceiptAuditSql(true, receiptId);
  assert.match(keyedPlan, /force_generic_plan/u);
  assert.match(keyedPlan, /WHERE id=\$1 LIMIT 1/u);
  assert.match(keyedPlan, /EXPLAIN \(FORMAT JSON\) EXECUTE maxim_held_receipt_audit/u);
});

test('a keyed receipt never falls back to the moving head, including missing and no-longer-received rows', async (t) => {
  const db = await fixture(t);
  await seedReceipt(db);
  await seedScope(db);
  await seedSeal(db);
  await db.query(
    `INSERT INTO webhook_events(id,status,created_at,normalized_payload)
    VALUES ('older-receipt','RECEIVED','2020-01-01',$1)`,
    [JSON.stringify({ type: 'other' })],
  );
  assert.equal((await report(db)).classification, 'not_message_removed');
  const selected = await report(db, receiptId);
  assert.equal(selected.selection, 'exact_receipt');
  assert.equal(selected.classification, 'legacy_sealed_scope_present');
  assert.equal(selected.receipt.status, 'RECEIVED');
  assert.equal(selected.receipt.still_received, true);
  assert.equal(selected.legacy_scope.seal_coverage, 'selected_scope_only');
  const missing = await report(db, 'missing-receipt');
  assert.equal(missing.classification, 'receipt_missing');
  assert.equal(missing.receipt.found, false);
  assert.equal(missing.receipt.status, null);
  assert.equal(missing.legacy_scope.selected, false);
  for (const status of ['QUEUED', 'PROCESSED', 'FAILED']) {
    await db.query('UPDATE webhook_events SET status=$1 WHERE id=$2', [status, receiptId]);
    const changed = await report(db, receiptId);
    assert.equal(changed.classification, 'receipt_not_received');
    assert.equal(changed.receipt.status, status);
    assert.equal(changed.receipt.still_received, false);
    assert.equal(changed.legacy_scope.scalar_identity_matches, true);
  }
});

test('keyed created and edited metadata nominate the outer author without substituting a linked sender', async (t) => {
  const db = await fixture(t);
  await seedScope(db);
  await seedSeal(db);
  await db.query(
    `INSERT INTO webhook_legacy_recoveries
    (id,chat_id,message_id,user_id,owner_webhook_event_id,certificate_id)
    VALUES ('private-linked-scope','other-chat','other-message','PRIVATE_LINKED_SENDER',$1,'missing-cert')`,
    [receiptId],
  );
  for (const type of ['message_created', 'message_edited']) {
    const payload = {
      ...source(),
      type,
      raw: {
        message: {
          sender: { user_id: privateValue },
          link: { sender: { user_id: 'PRIVATE_LINKED_SENDER' } },
        },
      },
    };
    await seedReceipt(db, payload);
    assert.equal((await report(db)).classification, 'not_message_removed');
    const value = await report(db, receiptId);
    assert.equal(value.classification, 'legacy_sealed_scope_present');
    assert.equal(value.receipt.event_type, type);
    assert.equal(value.scope_metadata.user_nomination, 'normalized_outer_message_sender');
    assert.equal(value.scope_metadata.normalized_author_valid, true);
    assert.equal(value.scope_metadata.normalized_actor_valid, null);
    assert.equal(value.scope_metadata.original_author_proven, false);
    assert.equal(value.scope_metadata.global_user_match_count_lower_bound, 1);
    assert.equal(value.legacy_scope.owner_is_receipt, false);
    assert.equal(value.other_hold_metadata.backlog_message_family, 'not_evaluated');
    assert.equal(value.other_hold_metadata.protocol_family_coverage, 'partial');
    await seedReceipt(db, { ...payload, message: { ...payload.message, senderId: null } });
    const missing = await report(db, receiptId);
    assert.equal(missing.classification, 'normalized_scope_unproved');
    assert.equal(missing.scope_metadata.normalized_author_valid, false);
    assert.equal(missing.scope_metadata.global_user_family_available, false);
    assert.equal(missing.legacy_scope.selected, false);
  }
  await seedReceipt(db);
  const removal = await report(db, receiptId);
  assert.equal(removal.scope_metadata.user_nomination, 'normalized_removal_actor');
  assert.equal(removal.scope_metadata.normalized_author_valid, null);
  assert.equal(removal.scope_metadata.normalized_actor_valid, true);
});

test('keyed message protocol observations retain unknown backlog message coverage and unsupported types', async (t) => {
  const db = await fixture(t);
  await seedReceipt(db, { ...source(), type: 'message_created' });
  await db.query('INSERT INTO webhook_source_abandonments(chat_id,message_id) VALUES ($1,$1)', [
    privateValue,
  ]);
  await db.query('INSERT INTO webhook_backlog_receipts(receipt_id,semantic_key) VALUES ($1,$2)', [
    receiptId,
    semanticKey,
  ]);
  const value = await report(db, receiptId);
  assert.equal(value.classification, 'no_legacy_scope');
  assert.equal(value.other_hold_metadata.modern_exact_message_present, true);
  assert.equal(value.other_hold_metadata.backlog_exact_receipt_present, true);
  assert.equal(value.other_hold_metadata.backlog_stored_semantic_present, true);
  assert.equal(value.other_hold_metadata.backlog_message_family, 'not_evaluated');
  await db.exec('UPDATE webhook_events SET semantic_key=NULL');
  assert.equal(
    (await report(db, receiptId)).other_hold_metadata.backlog_stored_semantic_present,
    null,
  );
  await seedReceipt(db, { ...source(), type: 'user_removed' });
  const unsupported = await report(db, receiptId);
  assert.equal(unsupported.classification, 'unsupported_event_type');
  assert.equal(unsupported.other_hold_metadata.modern_exact_message_present, null);
  assert.equal(unsupported.scope_metadata.exact_family_available, false);
});

test('no head and unsupported oldest type remain explicit without selecting a later removal', async (t) => {
  const db = await fixture(t);
  let value = await report(db);
  assert.equal(value.classification, 'no_received');
  assert.equal(value.scope_metadata.exact_match_count_lower_bound, null);
  assert.equal(value.other_hold_metadata.backlog_message_family, 'not_evaluated');
  await seedReceipt(db);
  await db.query(
    `INSERT INTO webhook_events(id,status,created_at,normalized_payload,error_message)
    VALUES ('a-first','RECEIVED',$1,$2,$3)`,
    [receiptAt, JSON.stringify({ type: privateValue }), privateValue],
  );
  value = await report(db);
  assert.equal(value.classification, 'not_message_removed');
  assert.equal(value.scope_metadata.exact_family_available, false);
  assert.equal(value.scope_metadata.exact_match_count_lower_bound, null);
  assert.equal(value.other_hold_metadata.modern_exact_message_present, null);
  assert.equal(value.other_hold_metadata.backlog_message_family, 'not_evaluated');
});

test('complete deduplicated scope selection uses owner-first ordering and the actual sealed identity', async (t) => {
  const db = await fixture(t);
  await seedReceipt(db);
  await seedScope(db, 'a-lexically-first', 'old-cert');
  await seedScope(db, 'z-owner-winner', 'private-cert', receiptId);
  await seedSeal(db);
  const value = await report(db);
  assert.equal(value.classification, 'legacy_sealed_scope_present');
  assert.equal(value.scope_metadata.exact_match_count_lower_bound, 2);
  assert.equal(value.scope_metadata.global_user_match_count_lower_bound, 2);
  assert.equal(value.scope_metadata.scopes_complete, true);
  assert.equal(value.legacy_scope.owner_is_receipt, true);
  assert.equal(value.legacy_scope.matches_exact_message, true);
  assert.equal(value.legacy_scope.matches_global_user, true);
  assert.equal(value.legacy_scope.scalar_identity_matches, true);
  assert.equal(value.legacy_scope.receipt_created_after_seal, true);
  assert.equal(value.legacy_scope.quiesced_before_seal, true);
  await db.exec(`UPDATE webhook_events SET legacy_disposition_id='private-proof'`);
  assert.equal((await report(db)).legacy_scope.selection_role, 'diagnostic_only_existing_pointer');
});

test('missing authority, certificate and each mismatched binding stay distinct from a matching seal', async (t) => {
  const db = await fixture(t);
  await seedReceipt(db);
  await seedScope(db);
  assert.equal((await report(db)).classification, 'legacy_authority_missing');
  await seedSeal(db);
  for (const [column, changed] of [
    ['source_sha', 'e'.repeat(40)],
    ['image_id', 'changed-image'],
    ['attestation_digest', 'e'.repeat(64)],
    ['preview_sha256', 'e'.repeat(64)],
    ['sealed_at', '2026-10-27T05:00:00.001'],
    ['authority_version', 2],
  ]) {
    await db.exec('BEGIN');
    await db.query(`UPDATE webhook_legacy_sealed_authorities SET ${column}=$1`, [changed]);
    assert.equal(
      (await db.query(buildHeldReceiptAuditSql())).rows[0].jsonb_build_object.classification,
      'legacy_seal_mismatch',
    );
    await db.exec('ROLLBACK');
  }
  await db.exec('DELETE FROM webhook_legacy_quiescence_certificates');
  assert.equal((await report(db)).classification, 'legacy_certificate_missing');
});

test('both legacy family sentinels block winner selection, even when one matching owner is known', async (t) => {
  const db = await fixture(t);
  await seedReceipt(db);
  await seedSeal(db);
  await seedScope(db, 'a-owner', 'private-cert', receiptId);
  await db.query(
    `INSERT INTO webhook_legacy_recoveries
    (id,chat_id,message_id,user_id,owner_webhook_event_id,certificate_id)
    SELECT 'scope-'||n,'other-chat','other-message',$1,'other-owner','private-cert'
    FROM generate_series(1,16) n`,
    [privateValue],
  );
  let value = await report(db);
  assert.equal(value.classification, 'legacy_scope_saturated');
  assert.equal(value.scope_metadata.global_user_match_count_lower_bound, 17);
  assert.equal(value.scope_metadata.global_user_family_complete, false);
  assert.equal(value.legacy_scope.selected, false);
  assert.equal(value.legacy_scope.authority_present, false);
  await db.query(
    `UPDATE webhook_legacy_recoveries SET user_id='other-user',chat_id=$1,message_id=$1 WHERE id<>'a-owner'`,
    [privateValue],
  );
  value = await report(db);
  assert.equal(value.scope_metadata.exact_match_count_lower_bound, 17);
  assert.equal(value.scope_metadata.exact_family_complete, false);
  assert.equal(value.legacy_scope.selected, false);
});

test('scalar-only family probes report stored matches without requiring or claiming runtime source proof', async (t) => {
  const db = await fixture(t);
  await seedReceipt(db);
  await db.query('INSERT INTO webhook_source_abandonments(chat_id,message_id) VALUES ($1,$1)', [
    privateValue,
  ]);
  await db.query('INSERT INTO webhook_backlog_receipts(receipt_id,semantic_key) VALUES ($1,$2)', [
    receiptId,
    semanticKey,
  ]);
  const value = await report(db);
  assert.equal(value.classification, 'no_legacy_scope');
  assert.equal(value.other_hold_metadata.modern_exact_message_present, true);
  assert.equal(value.other_hold_metadata.backlog_exact_receipt_present, true);
  assert.equal(value.other_hold_metadata.backlog_stored_semantic_present, true);
  assert.equal(value.other_hold_metadata.canonical_semantic_key_rebuilt, false);
  await db.exec('UPDATE webhook_events SET semantic_key=NULL');
  assert.equal((await report(db)).other_hold_metadata.backlog_stored_semantic_present, null);
});

test('unadmitted payloads and malformed or oversized identities never manufacture empty complete families', async (t) => {
  const db = await fixture(t);
  await seedReceipt(db);
  await seedScope(db);
  for (const value of [
    null,
    [],
    { type: 'message_removed', message: null },
    { ...source(), message: { ...source().message, senderId: 12 } },
    { ...source(), message: { ...source().message, chatId: 'x'.repeat(513) } },
  ]) {
    await seedReceipt(db, value);
    const observed = await report(db);
    assert.equal(observed.legacy_scope.selected, false);
    assert.notEqual(observed.scope_metadata.scopes_complete, true);
  }
  await seedReceipt(db, { ...source(), private: privateValue.repeat(20000) });
  const value = await report(db);
  assert.equal(value.classification, 'payload_uninspected');
  assert.equal(value.receipt.payload_admission, 'oversized_not_inspected');
  assert.equal(value.scope_metadata.exact_match_count_lower_bound, null);
  assert.equal(value.other_hold_metadata.modern_exact_message_present, null);
});

test('unbounded binding and saved-error text are unavailable, not ordinary mismatches or leaked content', async (t) => {
  const db = await fixture(t);
  await seedReceipt(db);
  await seedScope(db);
  await seedSeal(db);
  await db.query('UPDATE webhook_legacy_sealed_authorities SET source_sha=$1', [
    privateValue.repeat(20000),
  ]);
  let value = await report(db);
  assert.equal(value.classification, 'binding_metadata_uninspected');
  assert.equal(value.legacy_scope.scalar_identity_matches, null);
  await db.query('UPDATE webhook_events SET semantic_key=$1,error_message=$1', [
    privateValue.repeat(20000),
  ]);
  value = await report(db);
  assert.equal(value.receipt.saved_preparation_reason, 'uninspected');
  assert.equal(value.receipt.stored_semantic_key_admission, 'uninspected');
  assert.equal(value.other_hold_metadata.backlog_stored_semantic_present, null);
});

test('exact optional scalar privileges reject partial, inherited, PUBLIC, table and write excess', async (t) => {
  const db = await fixture(t);
  await db.exec(
    'CREATE ROLE held_auditor; GRANT USAGE ON SCHEMA public TO held_auditor; SET ROLE held_auditor',
  );
  const ready = async (all = false) =>
    (await db.query(heldReceiptPrivilegesSql(all))).rows[0].held_receipt_privileges_ready;
  assert.equal(await ready(), true);
  assert.equal(await ready(true), false);
  await db.exec(
    'RESET ROLE; GRANT SELECT(id) ON webhook_legacy_recoveries TO held_auditor; SET ROLE held_auditor',
  );
  assert.equal(await ready(), false);
  await db.exec(`RESET ROLE; ${grants('held_auditor')} SET ROLE held_auditor`);
  assert.equal(await ready(true), true);
  for (const excess of [
    'GRANT SELECT(owner_snapshot) ON webhook_legacy_recoveries TO PUBLIC',
    'GRANT UPDATE(disposition) ON webhook_legacy_recoveries TO held_auditor',
    'GRANT SELECT ON webhook_backlog_receipts TO held_auditor',
    'CREATE ROLE held_extra; GRANT SELECT(attestation) ON webhook_legacy_quiescence_certificates TO held_extra; GRANT held_extra TO held_auditor',
  ]) {
    await db.exec(`RESET ROLE; BEGIN; ${excess}; SET ROLE held_auditor`);
    assert.equal(await ready(true), false);
    await db.exec('ROLLBACK; SET ROLE held_auditor');
  }
});

test('index attestation rejects missing, descending and partial lookups', async (t) => {
  const db = await fixture(t);
  const ready = async () =>
    (await db.query(heldReceiptIndexesSql)).rows[0].held_receipt_indexes_ready;
  assert.equal(await ready(), true);
  await db.exec('DROP INDEX webhook_legacy_recoveries_global_user_idx');
  assert.equal(await ready(), false);
  await db.exec(
    'CREATE INDEX webhook_legacy_recoveries_global_user_idx ON webhook_legacy_recoveries(user_id DESC)',
  );
  assert.equal(await ready(), false);
  await db.exec(`DROP INDEX webhook_legacy_recoveries_global_user_idx;
    CREATE INDEX webhook_legacy_recoveries_global_user_idx ON webhook_legacy_recoveries(user_id) WHERE authority_version=1`);
  assert.equal(await ready(), false);
});

test(
  'native PG16 caps the chat prefix before residual message filtering across competing indexes',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 90000 },
  async () => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const name = `race_test_held_prefix_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: url.href });
    const childUrl = new URL(url);
    childUrl.pathname = `/${name}`;
    const db = new pg.Client({
      connectionString: childUrl.href,
      options: '-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=250',
    });
    db.exec = (sql) => db.query(sql);
    let created = false;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      await db.connect();
      assert.match((await db.query('SHOW server_version')).rows[0].server_version, /^16\./u);
      await db.exec(fixtureSql);
      await seedReceipt(db);
      await seedScope(db, 'private-scope', 'private-cert', receiptId);
      await seedSeal(db);
      await db.query(
        `INSERT INTO webhook_legacy_recoveries
          (id,chat_id,message_id,user_id,owner_webhook_event_id,certificate_id)
        SELECT 'distractor-'||n,$1,'000-message-'||lpad(n::text,6,'0')||repeat('x',256),
          '000-actor-'||lpad(n::text,6,'0'),'other-owner','private-cert'
        FROM generate_series(1,12000) n`,
        [privateValue],
      );
      // FLAG: A low message-cardinality estimate makes the real, narrower chat/user
      // index competitive. The scan budget must hold even when message filtering
      // becomes residual; these statistics affect only this disposable local DB.
      await db.exec(`ALTER TABLE webhook_legacy_recoveries
          ALTER COLUMN message_id SET (n_distinct=1);
        INSERT INTO webhook_events(id,status,created_at)
          SELECT 'retained-'||n,'PROCESSED','2020-01-01' FROM generate_series(1,12000) n;
        ANALYZE;
        SET enable_seqscan=off; SET enable_bitmapscan=off;
        SET max_parallel_workers_per_gather=0; SET jit=off;
        SET work_mem='1MB'; SET temp_file_limit='8MB'; SET statement_timeout=2500;`);
      assert.equal(
        (await db.query(heldReceiptIndexesSql)).rows[0].held_receipt_indexes_ready,
        true,
      );
      const plan = (
        await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${buildHeldReceiptAuditSql()}`)
      ).rows[0]['QUERY PLAN'][0].Plan;
      const scans = walk(plan).filter((node) => node['Relation Name']);
      assert.ok(
        scans.some((node) => node['Index Name'] === 'webhook_legacy_recoveries_chat_user_idx'),
        'The fixture must exercise the competing chat/user access path',
      );
      for (const scan of scans) {
        assert.match(scan['Node Type'], /^Index (Only )?Scan$/u);
        const inspected =
          (scan['Actual Rows'] +
            (scan['Rows Removed by Filter'] ?? 0) +
            (scan['Rows Removed by Index Recheck'] ?? 0)) *
          scan['Actual Loops'];
        assert.ok(
          inspected <= 17,
          JSON.stringify({
            relation: scan['Relation Name'],
            index: scan['Index Name'],
            rows: scan['Actual Rows'],
            removedByFilter: scan['Rows Removed by Filter'] ?? 0,
            removedByRecheck: scan['Rows Removed by Index Recheck'] ?? 0,
            loops: scan['Actual Loops'],
            inspected,
          }),
        );
        assert.ok(
          scan['Index Cond'],
          JSON.stringify({ relation: scan['Relation Name'], index: scan['Index Name'] }),
        );
      }
      const saturated = await report(db);
      assert.equal(saturated.scope_metadata.exact_chat_prefix_count_lower_bound, 17);
      assert.equal(saturated.scope_metadata.exact_chat_prefix_saturated, true);
      assert.equal(saturated.scope_metadata.exact_chat_prefix_complete, false);
      assert.equal(saturated.scope_metadata.exact_match_count_lower_bound, 0);
      assert.equal(saturated.scope_metadata.exact_family_complete, false);
      assert.equal(saturated.scope_metadata.global_user_match_count_lower_bound, 1);
      assert.equal(saturated.scope_metadata.global_user_family_complete, true);
      assert.equal(saturated.scope_metadata.scopes_complete, false);
      assert.equal(saturated.legacy_scope.selected, false);
      assert.equal(saturated.legacy_scope.scalar_identity_matches, null);
      assert.notEqual(saturated.classification, 'no_legacy_scope');
      assert.notEqual(saturated.classification, 'legacy_sealed_scope_present');

      for (const type of ['message_created', 'message_edited']) {
        await seedReceipt(db, { ...source(), type });
        const keyed = await report(db, receiptId);
        assert.equal(keyed.receipt.event_type, type);
        assert.equal(keyed.scope_metadata.user_nomination, 'normalized_outer_message_sender');
        assert.equal(keyed.scope_metadata.exact_chat_prefix_count_lower_bound, 17);
        assert.equal(keyed.scope_metadata.scopes_complete, false);
        assert.equal(keyed.legacy_scope.selected, false);
        const keyedPlan = (
          await db.query(
            `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${buildHeldReceiptAuditSql(false, receiptId)}`,
          )
        ).rows[0]['QUERY PLAN'][0].Plan;
        const keyedScans = walk(keyedPlan).filter((node) => node['Relation Name']);
        const receiptScans = keyedScans.filter(
          (node) => node['Relation Name'] === 'webhook_events',
        );
        assert.equal(receiptScans.length, 2);
        for (const scan of keyedScans) {
          assert.match(scan['Node Type'], /^Index (Only )?Scan$/u);
          assert.ok(scan['Index Cond'], JSON.stringify(scan));
          const inspected =
            (scan['Actual Rows'] +
              (scan['Rows Removed by Filter'] ?? 0) +
              (scan['Rows Removed by Index Recheck'] ?? 0)) *
            scan['Actual Loops'];
          assert.ok(inspected <= 17, JSON.stringify(scan));
        }
        for (const scan of receiptScans) {
          assert.equal(scan['Index Name'], 'webhook_events_pkey');
          assert.ok(scan['Actual Rows'] * scan['Actual Loops'] <= 1);
        }
      }
      await db.exec('BEGIN READ ONLY');
      try {
        const results = await db.query(buildHeldReceiptAuditSql(true, receiptId));
        const generic = results.find((result) => result.command === 'EXPLAIN').rows[0][
          'QUERY PLAN'
        ];
        const serialized = JSON.stringify(generic);
        assert.doesNotMatch(serialized, /private-receipt|PRIVATE_MESSAGE/u);
        assert.match(serialized, /\$1/u);
        assert.ok(
          walk(generic[0].Plan).some((node) => node['Index Name'] === 'webhook_events_pkey'),
        );
      } finally {
        await db.exec('ROLLBACK');
      }
      await seedReceipt(db);

      await db.exec("DELETE FROM webhook_legacy_recoveries WHERE id LIKE 'distractor-%'");
      await db.query(
        `INSERT INTO webhook_legacy_recoveries
          (id,chat_id,message_id,user_id,owner_webhook_event_id,certificate_id)
        VALUES ('small-distractor',$1,'000-other-message','000-other-actor',
          'other-owner','private-cert')`,
        [privateValue],
      );
      await db.exec('ANALYZE webhook_legacy_recoveries');
      const complete = await report(db);
      assert.equal(complete.scope_metadata.exact_chat_prefix_count_lower_bound, 2);
      assert.equal(complete.scope_metadata.exact_chat_prefix_saturated, false);
      assert.equal(complete.scope_metadata.exact_chat_prefix_complete, true);
      assert.equal(complete.scope_metadata.exact_match_count_lower_bound, 1);
      assert.equal(complete.scope_metadata.exact_family_complete, true);
      assert.equal(complete.scope_metadata.global_user_match_count_lower_bound, 1);
      assert.equal(complete.scope_metadata.global_user_family_complete, true);
      assert.equal(complete.scope_metadata.scopes_complete, true);
      assert.equal(complete.legacy_scope.selected, true);
      assert.equal(complete.legacy_scope.owner_is_receipt, true);
      assert.equal(complete.legacy_scope.scalar_identity_matches, true);

      // FLAG: An uninspected row in the bounded chat prefix cannot disappear
      // through a guarded NULL message ID and leave a falsely complete family.
      await db.query(
        "UPDATE webhook_legacy_recoveries SET message_id=$1 WHERE id='small-distractor'",
        ['x'.repeat(12000)],
      );
      assert.notEqual(
        (
          await db.query(`SELECT pg_column_compression(message_id) AS compression
            FROM webhook_legacy_recoveries WHERE id='small-distractor'`)
        ).rows[0].compression,
        null,
      );
      const poisoned = await report(db);
      assert.equal(poisoned.classification, 'legacy_scope_metadata_uninspected');
      assert.equal(poisoned.scope_metadata.exact_chat_prefix_count_lower_bound, 2);
      assert.equal(poisoned.scope_metadata.exact_chat_prefix_saturated, false);
      assert.equal(poisoned.scope_metadata.exact_chat_prefix_complete, false);
      assert.equal(poisoned.scope_metadata.exact_family_metadata_bounded, false);
      assert.equal(poisoned.scope_metadata.exact_match_count_lower_bound, 1);
      assert.equal(poisoned.scope_metadata.exact_family_complete, false);
      assert.equal(poisoned.scope_metadata.global_user_match_count_lower_bound, 1);
      assert.equal(poisoned.scope_metadata.global_user_family_complete, true);
      assert.equal(poisoned.scope_metadata.scopes_complete, false);
      assert.equal(poisoned.legacy_scope.selected, false);
      assert.equal(poisoned.legacy_scope.scalar_identity_matches, null);
    } finally {
      await db.end();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
);

test(
  'native PG16 bounds retained scopes, avoids row locks and inspects no compressed text or oversized source',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 90000 },
  async () => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const name = `race_test_held_receipt_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: url.href });
    const childUrl = new URL(url);
    childUrl.pathname = `/${name}`;
    const auditor = `held_native_${randomUUID().replaceAll('-', '')}`;
    const db = new pg.Client({
      connectionString: childUrl.href,
      options: '-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=250',
    });
    db.exec = (sql) => db.query(sql);
    let created = false;
    // FLAG: DDL, timed plans and fixtures own only this new disposable local DB.
    // The migrated wrapper database and any nonlocal target are never modified.
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      await db.connect();
      assert.match((await db.query('SHOW server_version')).rows[0].server_version, /^16\./u);
      await db.exec(fixtureSql);
      await seedReceipt(db);
      await seedScope(db);
      await seedSeal(db);
      await seedScope(db, 'a-native-tie', 'private-tie-cert');
      await seedSeal(db, 'private-tie-cert', '2026-10-27T05:00:00.001');
      const tied = await report(db);
      assert.equal(tied.scope_metadata.scopes_complete, true);
      assert.equal(tied.scope_metadata.exact_match_count_lower_bound, 2);
      assert.equal(tied.scope_metadata.global_user_match_count_lower_bound, 2);
      assert.equal(tied.legacy_scope.owner_is_receipt, false);
      assert.equal(tied.legacy_scope.scalar_identity_matches, true);
      // FLAG: Distinct actual seal times identify the expected scope winner while
      // the diagnostic continues withholding every receipt/recovery/certificate ID.
      assert.equal(
        Date.parse(tied.legacy_scope.authority_sealed_at + 'Z'),
        Date.parse('2026-10-27T05:00:00.001Z'),
      );
      await db.query(
        "UPDATE webhook_legacy_recoveries SET owner_webhook_event_id=$1 WHERE id='private-scope'",
        [receiptId],
      );
      const owned = await report(db);
      assert.equal(owned.legacy_scope.owner_is_receipt, true);
      assert.equal(owned.legacy_scope.scalar_identity_matches, true);
      assert.equal(
        Date.parse(owned.legacy_scope.authority_sealed_at + 'Z'),
        Date.parse(sealAt + 'Z'),
      );
      await db.exec(`DELETE FROM webhook_legacy_recoveries WHERE id='a-native-tie';
        DELETE FROM webhook_legacy_sealed_authorities WHERE certificate_id='private-tie-cert';
        DELETE FROM webhook_legacy_quiescence_certificates WHERE id='private-tie-cert';
        UPDATE webhook_legacy_recoveries SET owner_webhook_event_id='private-owner' WHERE id='private-scope'`);
      await db.exec(`INSERT INTO webhook_events(id,status,created_at) SELECT 'retained-'||n,'PROCESSED','2020-01-01' FROM generate_series(1,12000) n;
        INSERT INTO webhook_legacy_recoveries(id,chat_id,message_id,user_id,owner_webhook_event_id,certificate_id)
        SELECT 'other-'||n,'other-'||n,'other-'||n,'other-'||n,'other-'||n,'other-'||n FROM generate_series(1,12000) n;
        ANALYZE; SET enable_seqscan=off; SET enable_bitmapscan=off; SET max_parallel_workers_per_gather=0; SET jit=off;
        SET work_mem='1MB'; SET temp_file_limit='8MB'; SET statement_timeout=2500;`);
      assert.equal(
        (await db.query(heldReceiptIndexesSql)).rows[0].held_receipt_indexes_ready,
        true,
      );
      const locker = new pg.Client({ connectionString: childUrl.href });
      await locker.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM webhook_events WHERE id=$1 FOR UPDATE', [receiptId]);
        assert.equal((await report(db)).classification, 'legacy_sealed_scope_present');
        assert.equal((await report(db, receiptId)).classification, 'legacy_sealed_scope_present');
      } finally {
        await locker.query('ROLLBACK');
        await locker.end();
      }
      const plan = (
        await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${buildHeldReceiptAuditSql()}`)
      ).rows[0]['QUERY PLAN'][0].Plan;
      const scans = walk(plan).filter((n) => n['Relation Name']);
      assert.ok(scans.length >= 9);
      for (const scan of scans) {
        assert.match(scan['Node Type'], /^Index (Only )?Scan$/u, JSON.stringify(scan));
        assert.ok(scan['Index Cond'], JSON.stringify(scan));
        assert.ok(scan['Actual Rows'] * scan['Actual Loops'] <= 17, JSON.stringify(scan));
      }
      await db.query(
        `INSERT INTO webhook_legacy_recoveries
        (id,chat_id,message_id,user_id,owner_webhook_event_id,certificate_id)
        SELECT 'matching-'||n,'other-chat-'||n,'other-message-'||n,$1,'other-owner','private-cert'
        FROM generate_series(1,12000) n`,
        [privateValue],
      );
      await db.exec('ANALYZE webhook_legacy_recoveries');
      const saturated = await report(db);
      assert.equal(saturated.classification, 'legacy_scope_saturated');
      assert.equal(saturated.scope_metadata.global_user_match_count_lower_bound, 17);
      assert.equal(saturated.legacy_scope.selected, false);
      const saturatedPlan = (
        await db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${buildHeldReceiptAuditSql()}`)
      ).rows[0]['QUERY PLAN'][0].Plan;
      const familyScan = walk(saturatedPlan).find(
        (n) => n['Index Name'] === 'webhook_legacy_recoveries_global_user_idx',
      );
      assert.ok(familyScan);
      assert.equal(familyScan['Actual Rows'] * familyScan['Actual Loops'], 17);
      await db.exec("DELETE FROM webhook_legacy_recoveries WHERE id LIKE 'matching-%'");
      for (const [column, original] of [
        ['owner_webhook_event_id', 'private-owner'],
        ['certificate_id', 'private-cert'],
      ]) {
        await db.query(
          `UPDATE webhook_legacy_recoveries SET ${column}=$1 WHERE id='private-scope'`,
          [privateValue.repeat(20000)],
        );
        assert.notEqual(
          (
            await db.query(`SELECT pg_column_compression(${column}) AS compression
          FROM webhook_legacy_recoveries WHERE id='private-scope'`)
          ).rows[0].compression,
          null,
        );
        const unavailable = await report(db);
        assert.equal(unavailable.classification, 'legacy_scope_metadata_uninspected');
        assert.equal(unavailable.scope_metadata.exact_family_metadata_bounded, false);
        assert.equal(unavailable.scope_metadata.global_user_family_metadata_bounded, false);
        assert.equal(unavailable.legacy_scope.selected, false);
        assert.equal(unavailable.legacy_scope.scalar_identity_matches, null);
        await db.query(
          `UPDATE webhook_legacy_recoveries SET ${column}=$1 WHERE id='private-scope'`,
          [original],
        );
      }
      await db.exec("UPDATE webhook_legacy_quiescence_certificates SET quiesced_at='infinity'");
      assert.equal((await report(db)).legacy_scope.quiesced_before_seal, null);
      await db.exec(
        "UPDATE webhook_legacy_quiescence_certificates SET quiesced_at='2026-10-27T04:59:00'",
      );
      await db.exec("UPDATE webhook_events SET created_at='infinity' WHERE id='private-receipt'");
      const unboundedClock = await report(db);
      assert.equal(unboundedClock.receipt.created_at, null);
      assert.equal(unboundedClock.legacy_scope.receipt_created_after_seal, null);
      await db.query('UPDATE webhook_events SET created_at=$1 WHERE id=$2', [receiptAt, receiptId]);
      await db.exec(
        "UPDATE webhook_legacy_quiescence_certificates SET sealed_at='infinity'; UPDATE webhook_legacy_sealed_authorities SET sealed_at='infinity'",
      );
      const infiniteSeal = await report(db);
      assert.equal(infiniteSeal.legacy_scope.quiesced_before_seal, null);
      assert.equal(infiniteSeal.legacy_scope.seal_not_future, null);
      assert.equal(infiniteSeal.legacy_scope.receipt_created_after_seal, null);
      await db.query('UPDATE webhook_legacy_quiescence_certificates SET sealed_at=$1', [sealAt]);
      await db.query('UPDATE webhook_legacy_sealed_authorities SET sealed_at=$1', [sealAt]);
      await db.query(`UPDATE webhook_legacy_sealed_authorities SET source_sha=$1`, [
        privateValue.repeat(20000),
      ]);
      assert.notEqual(
        (
          await db.query(
            'SELECT pg_column_compression(source_sha) AS compression FROM webhook_legacy_sealed_authorities',
          )
        ).rows[0].compression,
        null,
      );
      assert.equal((await report(db)).legacy_scope.scalar_identity_matches, null);
      await db.query(
        `UPDATE webhook_legacy_recoveries SET disposition=$1 WHERE id='private-scope'`,
        [privateValue.repeat(20000)],
      );
      assert.equal((await report(db)).classification, 'legacy_scope_metadata_uninspected');
      await db.query(`UPDATE webhook_events SET semantic_key=$1,error_message=$1 WHERE id=$2`, [
        privateValue.repeat(20000),
        receiptId,
      ]);
      const uninspected = await report(db);
      assert.equal(uninspected.receipt.saved_preparation_reason, 'uninspected');
      assert.equal(uninspected.receipt.stored_semantic_key_admission, 'uninspected');
      await db.exec(
        'ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET STORAGE EXTENDED',
      );
      await seedReceipt(db, { ...source(), private: privateValue.repeat(20000) });
      assert.equal((await report(db)).classification, 'payload_uninspected');
      await seedReceipt(db, { ...source(), type: 'message_created' });
      await db.exec(`CREATE ROLE ${auditor}; GRANT USAGE ON SCHEMA public TO ${auditor};
        GRANT SELECT ON webhook_events TO ${auditor}; ${grants(auditor)} SET ROLE ${auditor}`);
      assert.equal(
        (await db.query(heldReceiptPrivilegesSql(true))).rows[0].held_receipt_privileges_ready,
        true,
      );
      await report(db);
      assert.equal((await report(db, receiptId)).receipt.event_type, 'message_created');
      await assert.rejects(
        db.query('SELECT owner_snapshot FROM webhook_legacy_recoveries'),
        /permission denied/u,
      );
      await db.exec(`RESET ROLE; DROP OWNED BY ${auditor}; DROP ROLE ${auditor}`);
    } finally {
      await db.end();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${auditor}`);
      await admin.end();
    }
  },
);
