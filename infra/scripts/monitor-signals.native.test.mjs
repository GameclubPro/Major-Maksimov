import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';

const root = resolve(import.meta.dirname, '../..');
const nativePostgresUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const statuses = [
  'RECEIVED',
  'QUEUED',
  'PROCESSED',
  'DUPLICATE',
  'FAILED',
  'NO_REPLAY_HELD',
  'CANCELLED',
  'QUARANTINED',
];

function emittedReportQueries() {
  const source = readFileSync(resolve(root, 'infra/scripts/vps-postgres-audit.sh'), 'utf8');
  const startMarker = '\nemit_monitor_signals_audit() {\n';
  const endMarker = '\nemit_duplicate_intent_samples() {\n';
  assert.equal(source.split(startMarker).length, 2);
  assert.equal(source.split(endMarker).length, 2);
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start);
  const emitter = source.slice(start + 1, end).trimEnd();
  assert.ok(emitter.startsWith('emit_monitor_signals_audit() {\n  cat <<SQL\n'));
  assert.ok(emitter.endsWith('\nSQL\n}'));
  // FLAG: Execute only the exact production emitter. Sourcing the whole wrapper
  // would acquire its lock and attempt Docker/database operations during setup.
  const rendered = spawnSync('bash', ['-euo', 'pipefail'], {
    input:
      'SIGNAL_WINDOW_MIN=30\nMONITOR_SAMPLE_CAP=2000\n' +
      emitter +
      '\nemit_monitor_signals_audit\n',
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const readyMarker = '\\if :monitor_audit_indexes_ready\n';
  const refusalMarker = '\n\\else\n';
  assert.equal(rendered.stdout.split(readyMarker).length, 2);
  assert.equal(rendered.stdout.split(refusalMarker).length, 2);
  const reports = rendered.stdout.slice(
    rendered.stdout.indexOf(readyMarker) + readyMarker.length,
    rendered.stdout.indexOf(refusalMarker),
  );
  const secondMarker = '\n\nWITH moderation_sample AS MATERIALIZED (';
  assert.equal(reports.split(secondMarker).length, 2);
  const second = reports.indexOf(secondMarker);
  const queries = [reports.slice(0, second).trim(), reports.slice(second + 2).trim()];
  assert.ok(queries[0].startsWith('WITH webhook_statuses(status) AS ('));
  assert.ok(queries[1].startsWith('WITH moderation_sample AS MATERIALIZED ('));
  assert.ok(queries.every((query) => query.endsWith(';') && !query.includes('\\')));
  return queries;
}

const [webhookQuery, nightQuery] = emittedReportQueries();

async function fixture(t) {
  const address = new URL(nativePostgresUrl);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) &&
      address.pathname.includes('race_test'),
    'Monitor SQL tests require the public wrapper disposable local race_test database',
  );
  const client = new pg.Client({
    connectionString: nativePostgresUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 8000,
    options:
      '-c statement_timeout=2500 -c lock_timeout=250 -c work_mem=1MB -c max_parallel_workers_per_gather=0 -c timezone=UTC',
  });
  await client.connect();
  const namespace = 'monitor_signals_' + randomUUID().replaceAll('-', '');
  t.after(async () => {
    try {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
    } finally {
      await client.end();
    }
  });
  assert.match(
    (await client.query('SELECT version() AS version')).rows[0].version,
    /^PostgreSQL /u,
  );
  // FLAG: The report body has unqualified sources, so a private schema
  // exercises its real SQL without changing migrated public tables or audit grants.
  // Public index/session refusal remains covered by vps-postgres-audit.test.mjs.
  await client.query(
    'CREATE SCHEMA ' + namespace + '; SET search_path TO ' + namespace + ',pg_catalog;',
  );
  await client.query(
    [
      'CREATE TYPE "WebhookStatus" AS ENUM (' +
        statuses.map((status) => "'" + status + "'").join(',') +
        ');',
      'CREATE TABLE webhook_events (id text PRIMARY KEY, status "WebhookStatus" NOT NULL, created_at timestamp(3) NOT NULL);',
      'CREATE INDEX webhook_events_status_created_at_idx ON webhook_events(status, created_at);',
      'CREATE TABLE moderation_events (id text PRIMARY KEY, chat_id text, rule_code text NOT NULL, message_id text, metadata jsonb, created_at timestamp(3) NOT NULL);',
      'CREATE INDEX moderation_events_created_at_idx ON moderation_events(created_at);',
      "SET temp_file_limit='8MB'; SET jit=off;",
    ].join('\n'),
  );
  return client;
}

async function readOnlyQuery(client, query) {
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query(query);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function report(client, query) {
  return JSON.parse((await readOnlyQuery(client, query)).rows[0].json_build_object);
}

function assertPrivate(reportValue) {
  assert.doesNotMatch(
    JSON.stringify(reportValue),
    /private-chat|private-message|private-session|private-event|private-padding/u,
  );
}

function allPlanNodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(allPlanNodes)];
}

test(
  'native monitor SQL reports eight statuses including empty rows and exact 2000/2001 bounds',
  {
    skip: !nativePostgresUrl,
    timeout: 30_000,
  },
  async (t) => {
    const client = await fixture(t);
    const empty = await report(client, webhookQuery);
    assert.equal(empty.schema_version, 2);
    assert.deepEqual(empty.rows.map((row) => row.status).sort(), [...statuses].sort());
    assert.ok(
      empty.rows.every(
        (row) => row.count_lower_bound === 0 && !row.saturated && row.newest_age_seconds === 0,
      ),
    );
    assert.ok(
      Date.parse(empty.window_ended_at) - Date.parse(empty.window_started_at) === 30 * 60_000,
    );
    await client.query(
      'INSERT INTO webhook_events SELECT $1 || status, status::"WebhookStatus", now() - interval \'1 second\' FROM unnest($2::text[]) status',
      ['private-event-', statuses],
    );
    const nonempty = await report(client, webhookQuery);
    assert.ok(nonempty.rows.every((row) => row.count_lower_bound === 1 && !row.saturated));
    await client.query('TRUNCATE webhook_events');
    await client.query(
      "INSERT INTO webhook_events SELECT 'private-event-' || value, 'RECEIVED', now() - interval '1 second' FROM generate_series(1,2000) value",
    );
    const exact = await report(client, webhookQuery);
    assert.deepEqual(
      exact.rows.find((row) => row.status === 'RECEIVED'),
      {
        status: 'RECEIVED',
        count_lower_bound: 2000,
        saturated: false,
        newest_age_seconds: exact.rows.find((row) => row.status === 'RECEIVED').newest_age_seconds,
      },
    );
    await client.query(
      "INSERT INTO webhook_events VALUES ('private-sentinel','RECEIVED',now() - interval '1 second'),('private-old','FAILED',now() - interval '31 minutes'),('private-future','QUEUED',now() + interval '1 day')",
    );
    const saturated = await report(client, webhookQuery);
    assert.equal(saturated.rows.find((row) => row.status === 'RECEIVED').count_lower_bound, 2000);
    assert.equal(saturated.rows.find((row) => row.status === 'RECEIVED').saturated, true);
    assert.equal(saturated.rows.find((row) => row.status === 'FAILED').count_lower_bound, 0);
    assert.equal(saturated.rows.find((row) => row.status === 'QUEUED').count_lower_bound, 0);
    assertPrivate(saturated);
  },
);

test(
  'native monitor SQL admits bounded metadata and never treats rejected recovery as negative proof',
  {
    skip: !nativePostgresUrl,
    timeout: 30_000,
  },
  async (t) => {
    const client = await fixture(t);
    const empty = await report(client, nightQuery);
    assert.equal(empty.observed_sample_count, 0);
    assert.equal(empty.oldest_sample_at, null);
    assert.equal(empty.newest_sample_at, null);
    assert.equal(empty.global_cohort_complete, true);
    assert.equal(empty.night_rule_coverage, 'PARTIAL_GLOBAL_COHORT');
    assert.deepEqual(empty.rows, []);
    await client.query(
      [
        "INSERT INTO moderation_events VALUES ('private-event-old','private-chat','NIGHT_MODE_CLOSE_NOTICE','private-message-old','{\"sessionKey\":\"private-session\"}',now() - interval '3 seconds'),",
        "('private-event-new','private-chat','NIGHT_MODE_CLOSE_NOTICE','private-message-new','{\"sessionKey\":\"private-session\"}',now() - interval '2 seconds');",
      ].join('\n'),
    );
    const duplicated = await report(client, nightQuery);
    assert.equal(duplicated.duplicate_groups_in_sample, 1);
    assert.equal(duplicated.duplicate_extra_events_in_sample, 1);
    assert.equal(duplicated.duplicate_classification_complete, true);
    await client.query(
      [
        "INSERT INTO moderation_events VALUES ('private-event-recovery','private-chat','NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE','private-message-old',",
        "jsonb_build_object('originalEventId','private-event-old','private-padding',repeat('x',40000)),now() - interval '1 second');",
      ].join('\n'),
    );
    assert.notEqual(
      (
        await client.query(
          "SELECT pg_column_compression(metadata) AS compression FROM moderation_events WHERE id='private-event-recovery'",
        )
      ).rows[0].compression,
      null,
    );
    const rejected = await report(client, nightQuery);
    assert.equal(rejected.metadata_admission.COMPRESSED_NOT_INSPECTED, 1);
    assert.equal(rejected.duplicate_groups_in_sample, 1);
    assert.equal(rejected.duplicate_classification_complete, false);
    assert.equal(rejected.unavailable_night_proof_count, 1);
    await client.query(
      'UPDATE moderation_events SET metadata=\'{"originalEventId":"private-event-old","sessionKey":"private-session"}\' WHERE id=\'private-event-recovery\'',
    );
    const recovered = await report(client, nightQuery);
    assert.equal(recovered.duplicate_groups_in_sample, 0);
    assert.equal(recovered.duplicate_classification_complete, true);
    await client.query(
      [
        "INSERT INTO moderation_events SELECT 'private-absent','private-chat','NIGHT_MODE_OPEN_NOTICE',NULL,NULL,now() - interval '1 second';",
        "INSERT INTO moderation_events SELECT 'private-scalar-' || value,'private-chat','NIGHT_MODE_OPEN_NOTICE',NULL,value::jsonb,now() - interval '1 second' FROM unnest(ARRAY['null','false','123','[]']) value;",
        'ALTER TABLE moderation_events ALTER COLUMN metadata SET STORAGE EXTERNAL;',
        "INSERT INTO moderation_events VALUES ('private-oversized','private-chat','NIGHT_MODE_OPEN_NOTICE',NULL,jsonb_build_object('sessionKey','private-session','private-padding',repeat('x',40000)),now() - interval '1 second');",
        'ALTER TABLE moderation_events ALTER COLUMN metadata SET STORAGE EXTENDED;',
        "INSERT INTO moderation_events VALUES ('private-compressed','private-chat','NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE',NULL,jsonb_build_object('originalEventId','private-event-old','private-padding',repeat('x',40000)),now() - interval '1 second');",
        "INSERT INTO moderation_events VALUES ('private-long-key','private-chat','NIGHT_MODE_CLOSE_NOTICE',NULL,jsonb_build_object('sessionKey',repeat('x',1024)),now() - interval '1 second'),",
        "('private-invalid-key','private-chat','NIGHT_MODE_CLOSE_NOTICE',NULL,'{\"sessionKey\":123}',now() - interval '1 second'),",
        "('private-invalid-reference','private-chat','NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE',NULL,'{\"originalEventId\":false}',now() - interval '1 second');",
      ].join('\n'),
    );
    assert.equal(
      (
        await client.query(
          "SELECT pg_column_compression(metadata) AS compression FROM moderation_events WHERE id='private-oversized'",
        )
      ).rows[0].compression,
      null,
    );
    const classified = await report(client, nightQuery);
    assert.deepEqual(classified.metadata_admission, {
      ABSENT: 1,
      COMPRESSED_NOT_INSPECTED: 1,
      OVERSIZED_NOT_INSPECTED: 1,
      NON_OBJECT: 4,
      BOUNDED_OBJECT: 6,
    });
    assert.equal(classified.observed_sample_count, 13);
    assert.equal(classified.unavailable_night_proof_count, 10);
    assert.equal(classified.duplicate_classification_complete, false);
    assert.ok(classified.rows.some((row) => row.unavailable_session_keys > 0));
    assertPrivate(classified);
    await client.query(
      "TRUNCATE moderation_events; INSERT INTO moderation_events VALUES ('private-unknown','private-chat','OTHER_RULE',NULL,NULL,now() - interval '1 second')",
    );
    const unknown = await report(client, nightQuery);
    assert.equal(unknown.duplicate_groups_in_sample, 0);
    assert.equal(unknown.duplicate_classification_complete, false);
  },
);

test(
  'native monitor SQL retains indexed bounded walks under retained history and honest all-rule skew',
  {
    skip: !nativePostgresUrl,
    timeout: 30_000,
  },
  async (t) => {
    const client = await fixture(t);
    await client.query(
      [
        "INSERT INTO webhook_events SELECT 'private-retained-' || value, 'FAILED', now() - interval '2 days' - value * interval '1 second' FROM generate_series(1,30000) value;",
        "INSERT INTO webhook_events SELECT 'private-current-' || value, 'RECEIVED', now() - interval '1 second' FROM generate_series(1,30000) value;",
        "INSERT INTO moderation_events SELECT 'private-retained-' || value,'private-chat','OTHER_RULE',NULL,'{}',now() - interval '2 days' - value * interval '1 second' FROM generate_series(1,30000) value;",
        "INSERT INTO moderation_events SELECT 'private-current-' || value,'private-chat','OTHER_RULE',NULL,'{}',now() - interval '1 second' FROM generate_series(1,2000) value;",
        'ANALYZE webhook_events; ANALYZE moderation_events;',
      ].join('\n'),
    );
    const exact = await report(client, nightQuery);
    assert.equal(exact.observed_sample_count, 2000);
    assert.equal(exact.sample_saturated, false);
    assert.equal(exact.global_cohort_complete, true);
    await client.query(
      [
        "INSERT INTO moderation_events SELECT 'private-current-' || value,'private-chat','OTHER_RULE',NULL,'{}',now() - interval '1 second' FROM generate_series(2001,30000) value;",
        "INSERT INTO moderation_events VALUES ('private-sentinel','private-chat','OTHER_RULE',NULL,'{}',now() - interval '1 second'),",
        "('private-hidden-old','private-chat','NIGHT_MODE_CLOSE_NOTICE','private-message-old','{\"sessionKey\":\"private-session\"}',now() - interval '5 minutes'),",
        "('private-hidden-new','private-chat','NIGHT_MODE_CLOSE_NOTICE','private-message-new','{\"sessionKey\":\"private-session\"}',now() - interval '4 minutes');",
        'ANALYZE moderation_events;',
      ].join('\n'),
    );
    const skewed = await report(client, nightQuery);
    assert.equal(skewed.observed_sample_count, 2000);
    assert.equal(skewed.sample_saturated, true);
    assert.equal(skewed.global_cohort_complete, false);
    assert.equal(skewed.duplicate_classification_complete, false);
    assert.equal(skewed.night_rule_coverage, 'PARTIAL_GLOBAL_COHORT');
    assert.deepEqual(skewed.rows, []);
    assert.equal(skewed.duplicate_groups_in_sample, 0);
    assert.ok(Date.parse(skewed.oldest_sample_at) >= Date.now() - 60_000);
    for (const [query, table, expectedIndex] of [
      [webhookQuery, 'webhook_events', 'webhook_events_status_created_at_idx'],
      [nightQuery, 'moderation_events', 'moderation_events_created_at_idx'],
    ]) {
      // FLAG: Actual execution plans are restricted to this disposable native fixture.
      // Production catalog reports keep plain EXPLAIN and their existing envelope.
      const plan = (await readOnlyQuery(client, 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query))
        .rows[0]['QUERY PLAN'][0];
      const scans = allPlanNodes(plan.Plan).filter((node) => node['Relation Name'] === table);
      assert.equal(scans.length, table === 'webhook_events' ? 8 : 1, JSON.stringify(plan));
      for (const scan of scans) {
        assert.ok(
          ['Index Scan', 'Index Only Scan'].includes(scan['Node Type']),
          JSON.stringify(plan),
        );
        assert.equal(scan['Index Name'], expectedIndex);
        assert.match(scan['Index Cond'], /created_at/u);
        assert.ok(scan['Actual Rows'] <= 2001, JSON.stringify(plan));
        assert.equal(scan['Actual Loops'], 1, JSON.stringify(plan));
        assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
      }
      assert.equal(plan.Plan['Temp Written Blocks'], 0);
    }
    assertPrivate(skewed);
  },
);
