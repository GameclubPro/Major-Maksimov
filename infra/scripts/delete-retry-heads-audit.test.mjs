import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildDeleteRetryHeadsAuditSql,
  buildDeleteRetryHeadsIndexSql,
} from './delete-retry-heads-audit.mjs';
const fixture = `CREATE TYPE "ModerationDeleteIntentStatus" AS ENUM ('PENDING','RETRYABLE','WAITING_CAPABILITY','AMBIGUOUS','IN_PROGRESS','SUCCEEDED','FAILED_TERMINAL');
CREATE TABLE moderation_delete_intents (id text PRIMARY KEY, status "ModerationDeleteIntentStatus", next_attempt_at timestamp,
 execute_at timestamp, updated_at timestamp, attempt_count int, last_attempt_at timestamp, retry_until_at timestamp,
 delete_dispatch_started_at timestamp, remote_delete_succeeded_at timestamp, remote_delete_succeeded_bot_id text,
 lease_expires_at timestamp, last_status_code int,
 source_message_at timestamp, last_error_code text, last_error text);
CREATE INDEX moderation_delete_intents_due_idx ON moderation_delete_intents(status,next_attempt_at,execute_at);
CREATE INDEX moderation_delete_intents_retention_idx ON moderation_delete_intents(status,updated_at);
CREATE TABLE moderation_delete_intent_reasons (intent_id text,reason_key text,rule_code text);
CREATE UNIQUE INDEX moderation_delete_intent_reasons_intent_reason_key ON moderation_delete_intent_reasons(intent_id,reason_key);
INSERT INTO moderation_delete_intents (id,status,next_attempt_at,attempt_count)
 SELECT 'private-'||n,'RETRYABLE','2026-10-13'::timestamp+n*interval '1 second',1 FROM generate_series(1,40)n;
INSERT INTO moderation_delete_intent_reasons VALUES ('private-1','private-key','VOICE_BLOCKED_DELETE'),('private-2','private-key','private-code');`;
test('bounds retry heads and reasons without exposing identities or asserting execution', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const r = (await db.query(buildDeleteRetryHeadsAuditSql())).rows[0].json_build_object;
  assert.equal(r.sample_truncated, true);
  assert.equal(r.rows.filter((row) => row.sample_kind === 'oldest_retry').length, 32);
  assert.equal(r.rows.filter((row) => row.sample_kind === 'recent_update').length, 32);
  assert.equal(r.policy_checked, false);
  const oldest = r.rows.filter((row) => row.sample_kind === 'oldest_retry');
  assert.deepEqual(oldest[0].reasons, { truncated: false, codes: ['VOICE_BLOCKED_DELETE'] });
  assert.deepEqual(oldest[1].reasons.codes, ['other']);
  assert.doesNotMatch(JSON.stringify(r), /private-/u);
});
test('separates recent link failures and confirmed effects without exposing raw failures', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`UPDATE moderation_delete_intents SET updated_at = next_attempt_at;
    INSERT INTO moderation_delete_intents
      (id,status,next_attempt_at,updated_at,last_error_code,last_error,remote_delete_succeeded_at)
    VALUES
      ('private-link','RETRYABLE','2026-10-13','2026-10-14','delete_pre_dispatch_guard_rejected',
       'MAX direct message lookup returned a response without the requested id',NULL),
      ('private-denied','WAITING_CAPABILITY','2026-10-14','2026-10-14','access_denied','private-error',NULL),
      ('private-terminal','FAILED_TERMINAL','2026-10-14','2026-10-14','moderation_delete_reasons_no_longer_authorized','private-error',NULL),
      ('private-unknown','FAILED_TERMINAL','2026-10-14','2026-10-14','private-code','private-error',NULL),
      ('private-succeeded','SUCCEEDED','2026-10-14','2026-10-14',NULL,NULL,'2026-10-14');
    INSERT INTO moderation_delete_intent_reasons VALUES
      ('private-link','r','LINK_BLOCKED_DELETE'),('private-denied','r','MUTE_ACTIVE_DELETE'),
      ('private-terminal','r','LINK_HISTORY_RECOVERY'),('private-succeeded','r','LINK_BLOCKED_DELETE');`);
  const r = (await db.query(buildDeleteRetryHeadsAuditSql())).rows[0].json_build_object;
  assert.equal(r.schema_version, 4);
  assert.equal(r.failure_classification_authority, 'saved_metadata_only');
  assert.equal(r.remote_effect_proven, false);
  const recent = r.rows.filter((row) => row.sample_kind === 'recent_update');
  assert.ok(
    recent.some(
      (row) =>
        row.reasons.codes.includes('LINK_BLOCKED_DELETE') &&
        row.last_failure_family === 'predispatch_exact_source_missing_id' &&
        !row.remote_success_marker,
    ),
  );
  assert.ok(
    recent.some(
      (row) => row.status === 'WAITING_CAPABILITY' && row.last_failure_family === 'access_denied',
    ),
  );
  assert.ok(
    recent.some((row) => row.status === 'FAILED_TERMINAL' && row.last_failure_family === 'other'),
  );
  assert.ok(recent.some((row) => row.status === 'SUCCEEDED' && row.remote_success_marker));
  assert.ok(recent.some((row) => row.status === 'SUCCEEDED' && !row.remote_success_pair_complete));
  assert.ok(
    recent.some(
      (row) =>
        row.status === 'FAILED_TERMINAL' &&
        row.last_failure_family === 'moderation_delete_reasons_no_longer_authorized',
    ),
  );
  assert.doesNotMatch(JSON.stringify(r), /private-|lookup returned|last_error/u);
});
test('separates typed transport, MAX admission and database failures in bounded SQL', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(
    'DELETE FROM moderation_delete_intent_reasons; DELETE FROM moderation_delete_intents;',
  );
  const cases = [
    ['ECONNABORTED', 'transport_timeout'],
    ['ETIMEDOUT', 'transport_timeout'],
    ['ECONNRESET', 'transport_connection_reset'],
    ['ECONNREFUSED', 'transport_connection_refused'],
    ['EPIPE', 'transport_broken_pipe'],
    ['ENOTFOUND', 'transport_dns_failure'],
    ['EAI_AGAIN', 'transport_dns_failure'],
    ['MAX_API_INTERNAL_RATE_LIMIT', 'max_internal_rate_limit'],
    ['MAX_API_CIRCUIT_OPEN', 'max_circuit_open'],
    ['max_circuit_open', 'max_circuit_open'],
    ['access.denied', 'max_access_rejected'],
    ['chat.denied', 'max_access_rejected'],
    ['permission.denied', 'max_access_rejected'],
    ['chat.not.found', 'max_chat_not_found'],
    ['message.not.found', 'max_message_not_found'],
    ['message_not_found', 'max_message_not_found'],
    ['message.not_found', 'max_message_not_found'],
    ['P1001', 'database_connection_unavailable'],
    ['P1017', 'database_connection_unavailable'],
    ['08006', 'database_connection_unavailable'],
    ['P1002', 'database_connection_timeout'],
    ['P1008', 'database_operation_timeout'],
    ['P2010', 'database_raw_query_error'],
    ['P2024', 'database_pool_timeout'],
    ['P2028', 'database_transaction_error'],
    ['P2034', 'database_write_conflict'],
    ['40001', 'database_serialization_failure'],
    ['40P01', 'database_deadlock'],
    ['55P03', 'database_lock_unavailable'],
    ['57014', 'database_statement_canceled'],
    ['live_link_exact_source_unavailable', 'live_link_exact_source_unavailable'],
  ];
  for (const [ordinal, [code]] of cases.entries()) {
    await db.query(
      `INSERT INTO moderation_delete_intents
        (id,status,next_attempt_at,updated_at,attempt_count,last_error_code,last_error)
       VALUES ($1,'RETRYABLE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,$2,$3,$4)`,
      [
        `private-${ordinal}`,
        ordinal,
        code,
        code === 'P2010'
          ? '{"meta":{"code":"40001"},"message":"private token URL and raw failure text"}'
          : 'private token URL and raw failure text',
      ],
    );
  }
  const report = (await db.query(buildDeleteRetryHeadsAuditSql())).rows[0].json_build_object;
  assert.equal(report.schema_version, 4);
  assert.equal(report.sample_truncated, false);
  const oldest = report.rows.filter((row) => row.sample_kind === 'oldest_retry');
  assert.equal(oldest.length, cases.length);
  for (const row of oldest) assert.equal(row.last_failure_family, cases[row.attempt_count][1]);
  assert.equal(report.failure_classification_authority, 'saved_metadata_only');
  assert.equal(report.policy_checked, false);
  assert.equal(report.remote_effect_proven, false);
  assert.doesNotMatch(
    JSON.stringify(report),
    /private|token|URL|raw failure|last_error|40001|"meta"/u,
  );
});
test('keeps malformed codes and suggestive raw errors unknown without leaking them', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(
    'DELETE FROM moderation_delete_intent_reasons; DELETE FROM moderation_delete_intents;',
  );
  const unknownCodes = [
    null,
    '',
    'ECONNABORTED_suffix',
    'econnaborted',
    ' ETIMEDOUT',
    'ECONNRESET\nprivate-token',
    'MAX_API_INTERNAL_RATE_LIMIT_private',
    'P2010_private',
    'P2034_private',
    'live_link_exact_source_unavailable_private',
    '57014_private',
    'private-token',
  ];
  for (const [ordinal, code] of unknownCodes.entries()) {
    await db.query(
      `INSERT INTO moderation_delete_intents
        (id,status,next_attempt_at,updated_at,last_error_code,last_error)
       VALUES ($1,'RETRYABLE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,$2,$3)`,
      [
        `private-${ordinal}`,
        code,
        'private-token timeout ECONNRESET MAX_API_INTERNAL_RATE_LIMIT P2034 access.denied',
      ],
    );
  }
  const report = (await db.query(buildDeleteRetryHeadsAuditSql())).rows[0].json_build_object;
  assert.equal(report.sample_truncated, false);
  assert.equal(report.rows.length, unknownCodes.length * 2);
  assert.ok(report.rows.every((row) => row.last_failure_family === 'other'));
  assert.doesNotMatch(
    JSON.stringify(report),
    /private|ECONNRESET|MAX_API_INTERNAL_RATE_LIMIT|P2034|last_error/u,
  );
});
test('distinguishes complete acknowledgement pairs without emitting bot identities', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO moderation_delete_intents
    (id,status,next_attempt_at,updated_at,remote_delete_succeeded_at,remote_delete_succeeded_bot_id)
    VALUES
      ('private-paired','AMBIGUOUS',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'private-bot'),
      ('private-blank','AMBIGUOUS',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'  '),
      ('private-future','AMBIGUOUS',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 hour','private-bot'),
      ('private-no-time','AMBIGUOUS',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,'private-bot');`);
  const r = (await db.query(buildDeleteRetryHeadsAuditSql())).rows[0].json_build_object;
  const rows = r.rows.filter(
    (row) => row.sample_kind === 'recent_update' && row.status === 'AMBIGUOUS',
  );
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((row) => row.remote_success_pair_complete).length, 1);
  assert.equal(rows.filter((row) => row.remote_success_marker).length, 3);
  assert.equal(r.remote_effect_proven, false);
  assert.doesNotMatch(JSON.stringify(r), /private-/u);
});
test(
  'native PostgreSQL refuses missing indexes with a failing exit before reading the report',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 30_000 },
  async (t) => {
    const address = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname));
    const db = new pg.Client({ connectionString: address.href });
    await db.connect();
    const schema = `retry_admission_${process.pid}`;
    t.after(async () => {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    });
    for (const missing of [
      null,
      'moderation_delete_intents_due_idx',
      'moderation_delete_intents_retention_idx',
      'moderation_delete_intent_reasons_intent_reason_key',
    ]) {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE;
        CREATE SCHEMA ${schema}; SET search_path TO ${schema}, pg_catalog;
        ${fixture}
        ${missing ? `DROP INDEX ${missing};` : ''}
        RESET search_path;`);
      const result = spawnSync(
        'psql',
        ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse'],
        {
          encoding: 'utf8',
          timeout: 8000,
          env: {
            ...process.env,
            PGHOST: address.hostname,
            PGPORT: address.port || '5432',
            PGUSER: decodeURIComponent(address.username),
            PGPASSWORD: decodeURIComponent(address.password),
            PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
            PGOPTIONS:
              '-c default_transaction_read_only=on -c statement_timeout=2500ms -c lock_timeout=250ms -c idle_in_transaction_session_timeout=4s -c work_mem=1MB',
          },
          input: `BEGIN READ ONLY; SET LOCAL search_path TO ${schema}, pg_catalog;
${buildDeleteRetryHeadsIndexSql().replaceAll('public.moderation_', `${schema}.moderation_`)}
SELECT 'report-index-admission-passed'; ROLLBACK;`,
        },
      );
      assert.equal(result.status, missing ? 3 : 0, result.stderr);
      if (missing) {
        assert.match(result.stdout, /MAXIM_DELETE_RETRY_INDEX_UNAVAILABLE/u);
        assert.doesNotMatch(result.stdout, /report-index-admission-passed/u);
      } else assert.match(result.stdout, /report-index-admission-passed/u);
    }
  },
);
test(
  'native heads stay indexed with retained history and tied clocks',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL },
  async (t) => {
    const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    const db = new pg.Client({ connectionString: url.href });
    await db.connect();
    t.after(async () => {
      await db.query('ROLLBACK');
      await db.end();
    });
    await db.query(`BEGIN;CREATE SCHEMA retry_heads_${process.pid};SET LOCAL search_path TO retry_heads_${process.pid};${fixture}
 INSERT INTO moderation_delete_intents (id,status,next_attempt_at,attempt_count)
 SELECT 'history-'||n,'SUCCEEDED','2026-10-01',2 FROM generate_series(1,20000)n;
 INSERT INTO moderation_delete_intent_reasons SELECT 'history-'||n,'r','private' FROM generate_series(1,20000)n;
 INSERT INTO moderation_delete_intents (id,status,next_attempt_at,updated_at,attempt_count,last_error_code,last_error)
 VALUES ('private-native-code','WAITING_CAPABILITY',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,19,
   'MAX_API_INTERNAL_RATE_LIMIT','private token must not leave the report');
 ANALYZE moderation_delete_intents;ANALYZE moderation_delete_intent_reasons;`);
    const plan = (
      await db.query('EXPLAIN (ANALYZE,FORMAT JSON) ' + buildDeleteRetryHeadsAuditSql())
    ).rows[0]['QUERY PLAN'][0].Plan;
    const nodes = [];
    function walk(n) {
      nodes.push(n);
      for (const c of n.Plans ?? []) walk(c);
    }
    walk(plan);
    for (const n of nodes.filter((n) => n['Relation Name'])) {
      assert.notEqual(n['Node Type'], 'Seq Scan');
      assert.ok(
        (n['Actual Rows'] + (n['Rows Removed by Filter'] ?? 0)) * n['Actual Loops'] <= 4096,
      );
    }
    assert.ok(nodes.some((n) => n['Index Name'] === 'moderation_delete_intents_due_idx'));
    const report = (await db.query(buildDeleteRetryHeadsAuditSql())).rows[0].json_build_object;
    assert.equal(report.schema_version, 4);
    assert.ok(report.rows.some((row) => row.last_failure_family === 'max_internal_rate_limit'));
    assert.doesNotMatch(JSON.stringify(report), /private|MAX_API_INTERNAL_RATE_LIMIT|last_error/u);
  },
);
