import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {
  buildWebhookCohortAuditSql,
  buildWebhookCohortCommandSql,
  buildWebhookCohortIndexSql,
  buildWebhookFailedWindowAuditSql,
  buildWebhookFailedWindowGuardSql,
  buildWebhookFailedWindowIndexSql,
  parseWebhookCohortArgs,
  validateWebhookFailedWindow,
} from './webhook-cohort-audit.mjs';

const fixture = `SET TIME ZONE 'UTC';
CREATE TYPE "WebhookStatus" AS ENUM (
  'RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED');
CREATE TABLE webhook_events (id text PRIMARY KEY, status "WebhookStatus" NOT NULL,
  created_at timestamp(3) NOT NULL, queued_at timestamp(3), processed_at timestamp(3),
  error_message text, next_enqueue_at timestamp(3), timeout_quarantine_expires_at timestamp(3),
  execution_deadline_at timestamp(3),
  raw_payload jsonb, normalized_payload jsonb);
CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id);`;
const query = buildWebhookCohortAuditSql();
const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim() ?? '';
const local = (() => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(nativeUrl).hostname);
  } catch {
    return false;
  }
})();

test('closed cohort includes all eight statuses and excludes invalid completion clocks from percentiles', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events
    (id,status,created_at,queued_at,processed_at,raw_payload,normalized_payload)
    SELECT 'private-' || status, status, now() - interval '45 seconds',
      now() - interval '44 seconds', now() - interval '43 seconds', '{"secret":1}', '{}'
    FROM unnest(enum_range(NULL::"WebhookStatus")) status;
    INSERT INTO webhook_events(id,status,created_at,processed_at) VALUES
      ('private-clock','PROCESSED',now()-interval '45 seconds',now()-interval '46 seconds'),
      ('private-old','PROCESSED',now()-interval '70 seconds',now()-interval '40 seconds'),
      ('private-current','RECEIVED',now()-interval '10 seconds',NULL),
      ('private-future','RECEIVED',now()+interval '10 seconds',NULL);`);
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.sample_complete, true);
  assert.equal(report.nonempty, true);
  assert.equal(report.remote_effects_proven, false);
  assert.equal(report.rows.length, 8);
  assert.ok(Date.parse(report.from) < Date.parse(report.until));
  assert.ok(Date.parse(report.until) < Date.parse(report.observed_at));
  const byStatus = Object.fromEntries(report.rows.map((r) => [r.status, r]));
  assert.equal(byStatus.PROCESSED.count_lower_bound, 2);
  assert.equal(byStatus.PROCESSED.invalid_processed_clocks, 1);
  assert.equal(byStatus.PROCESSED.processed_only_p95_ms, 2000);
  assert.equal(byStatus.PROCESSED.processed_only_p99_ms, 2000);
  assert.equal(byStatus.PROCESSED.queued_sample_p99_ms, 1000);
  assert.equal(byStatus.RECEIVED.count_lower_bound, 1);
  assert.ok(byStatus.RECEIVED.oldest_pending_age_seconds >= 45);
  for (const status of ['DUPLICATE', 'CANCELLED', 'NO_REPLAY_HELD', 'FAILED', 'QUARANTINED']) {
    assert.equal(byStatus[status].count_lower_bound, 1);
    assert.equal(byStatus[status].processed_only_p95_ms, null);
    assert.equal(byStatus[status].processed_only_p99_ms, null);
  }
  assert.doesNotMatch(JSON.stringify(report), /private-|secret|payload/u);
});

test('tail percentiles use only valid successful receipts and keep queue timing separate', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events(id,status,created_at,queued_at,processed_at) VALUES
    ('fast','PROCESSED',now()-interval '45 seconds',now()-interval '44.9 seconds',now()-interval '44 seconds'),
    ('slow','PROCESSED',now()-interval '45 seconds',now()-interval '44 seconds',now()-interval '36 seconds'),
    ('invalid','PROCESSED',now()-interval '45 seconds',now()+interval '1 second',now()-interval '46 seconds'),
    ('cancelled','CANCELLED',now()-interval '45 seconds',now()-interval '44 seconds',now());`);
  const report = (await db.query(query)).rows[0].json_build_object;
  const processed = report.rows.find((row) => row.status === 'PROCESSED');
  assert.ok(Math.abs(processed.processed_only_p95_ms - 8600) < 0.001);
  assert.ok(Math.abs(processed.processed_only_p99_ms - 8920) < 0.001);
  assert.ok(Math.abs(processed.queued_sample_p99_ms - 991) < 0.001);
  assert.equal(processed.invalid_processed_clocks, 1);
  assert.equal(processed.invalid_queued_clocks, 1);
  assert.equal(report.rows.find((row) => row.status === 'CANCELLED').processed_only_p99_ms, null);
});

test('failed cohorts expose bounded categories and timing separately without trusting embedded errors', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events(id,status,created_at,error_message,
    execution_deadline_at,next_enqueue_at,timeout_quarantine_expires_at) VALUES
    ('private-expired','FAILED',now()-interval '45 seconds',
      'NO_EXECUTABLE_OWNER; deadline=2026-01-01T00:00:00.000Z',now()-interval '50 seconds',NULL,NULL),
    ('private-quarantine','FAILED',now()-interval '45 seconds',
      'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:private-token: private-error',
      now()-interval '40 seconds',now()+interval '1 second',now()-interval '1 second'),
    ('private-embedded','FAILED',now()-interval '45 seconds',
      'private text NO_EXECUTABLE_OWNER; deadline=2026-01-01T00:00:00.000Z',NULL,NULL,NULL),
    ('private-malformed','FAILED',now()-interval '45 seconds',
      'NO_EXECUTABLE_OWNER; deadline=private-error',NULL,NULL,NULL),
    ('private-completion','FAILED',now()-interval '45 seconds',
      'Handler completion claim changed',NULL,NULL,NULL),
    ('private-not-failed','PROCESSED',now()-interval '45 seconds',
      'NO_EXECUTABLE_OWNER; deadline=2026-01-01T00:00:00.000Z',NULL,NULL,NULL);`);
  const report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.schema_version, 4);
  assert.equal(report.failure_classification_authority, 'saved_metadata_only');
  const byFamily = Object.fromEntries(report.failure_families.map((r) => [r.family, r]));
  assert.equal(byFamily.no_executable_owner.count_lower_bound, 1);
  assert.equal(byFamily.no_executable_owner.deadline_elapsed_at_receipt, 1);
  assert.equal(byFamily.no_executable_owner.retry_scheduled, 0);
  assert.equal(byFamily.pending_quarantine_marker.count_lower_bound, 1);
  assert.equal(byFamily.pending_quarantine_marker.quarantine_timestamp_present, 1);
  assert.equal(byFamily.pending_quarantine_marker.retry_scheduled, 1);
  assert.equal(byFamily.pending_quarantine_marker.deadline_elapsed_at_receipt, 0);
  assert.equal(byFamily.pending_quarantine_marker.deadline_elapsed_at_observation, 1);
  assert.equal(byFamily.completion_claim_changed.count_lower_bound, 1);
  assert.equal(byFamily.other.count_lower_bound, 2);
  assert.deepEqual(report.pending_quarantine_families, [
    { family: 'other_pending', count_lower_bound: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /private-|secret|payload|2026-01-01/u);
});

test('quarantine subtype matches exact saved envelopes without mistaking copied text for provenance', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  const prefix = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:';
  const nonce = '11111111-2222-3333-4444-555555555555';
  const markers = [
    ['LEGACY_EXECUTION_UNVERIFIED; exact effects proof required', 'legacy_execution_unverified'],
    [
      'CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required',
      'canonical_business_started',
    ],
    [
      `${nonce}: Webhook user-facing hot path timed out after 10000ms for message_created`,
      'detached_timeout',
    ],
    [
      `${nonce}: Webhook user-facing hot path timed out after 10000ms for message_edited | private-error`,
      'detached_timeout',
    ],
    [
      `${nonce}: detached execution completed without a canonical claim: private-error`,
      'unclaimed_detached_completed',
    ],
    [
      `${nonce}: detached execution failed without a canonical claim: private-error`,
      'unclaimed_detached_failed',
    ],
    ['LEGACY_EXECUTION_UNVERIFIED; exact effects proof required private-error', 'other_pending'],
    [
      `${nonce}: private-error LEGACY_EXECUTION_UNVERIFIED; exact effects proof required`,
      'other_pending',
    ],
    [
      'private-nonce: Webhook user-facing hot path timed out after 10000ms for message_created',
      'other_pending',
    ],
    [
      `${nonce}: Webhook user-facing hot path timed out after 10000ms for message_created_private`,
      'other_pending',
    ],
  ];
  for (const [i, [marker]] of markers.entries()) {
    await db.query(
      `INSERT INTO webhook_events(id,status,created_at,error_message)
      VALUES ($1,'FAILED',now()-interval '45 seconds',$2)`,
      [`private-${i}`, prefix + marker],
    );
  }
  const report = (await db.query(query)).rows[0].json_build_object;
  const expected = new Map();
  for (const [, family] of markers) expected.set(family, (expected.get(family) ?? 0) + 1);
  assert.deepEqual(
    report.pending_quarantine_families,
    [...expected]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, count_lower_bound]) => ({ family, count_lower_bound })),
  );
  assert.equal(report.remote_effects_proven, false);
  assert.equal(report.failure_classification_authority, 'saved_metadata_only');
  assert.doesNotMatch(JSON.stringify(report), /private-|11111111|LEGACY_EXECUTION_UNVERIFIED/u);
});

test('empty and capped cohorts never claim complete processing', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  let report = (await db.query(query)).rows[0].json_build_object;
  assert.equal(report.nonempty, false);
  assert.deepEqual(report.failure_families, []);
  assert.deepEqual(report.pending_quarantine_families, []);
  assert.ok(report.rows.every((r) => r.count_lower_bound === 0));
  await db.exec(`INSERT INTO webhook_events(id,status,created_at)
    SELECT 'private-' || n, 'PROCESSED', now()-interval '45 seconds' FROM generate_series(1,513) n;`);
  report = (await db.query(query)).rows[0].json_build_object;
  const processed = report.rows.find((r) => r.status === 'PROCESSED');
  assert.equal(report.sample_complete, false);
  assert.equal(processed.truncated, true);
  assert.equal(processed.count_lower_bound, 512);
  assert.equal(processed.invalid_processed_clocks, 512);
  assert.equal(processed.processed_only_p95_ms, null);
  assert.equal(processed.processed_only_p99_ms, null);
  const readiness = buildWebhookCohortIndexSql().split('\\gset')[0];
  assert.equal((await db.query(readiness)).rows[0].webhook_cohort_index_ready, true);
  await db.exec('DROP INDEX webhook_events_status_created_at_id_idx');
  assert.equal((await db.query(readiness)).rows[0].webhook_cohort_index_ready, false);
});

test('short cohort reports every status in its own closed window and retains saturation evidence', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixture);
  await db.exec(`INSERT INTO webhook_events(id,status,created_at,processed_at)
    SELECT 'outside-short-' || n, 'PROCESSED', now()-interval '45 seconds',
      now()-interval '44 seconds' FROM generate_series(1,600) n;
    INSERT INTO webhook_events(id,status,created_at,queued_at,processed_at)
    SELECT 'inside-short-' || status, status, now()-interval '32 seconds',
      now()-interval '31.5 seconds', now()-interval '31 seconds'
    FROM unnest(enum_range(NULL::"WebhookStatus")) status;`);
  const standard = (await db.query(query)).rows[0].json_build_object;
  assert.equal(standard.sample_complete, false);
  assert.equal(standard.window_seconds, 30);
  const shortQuery = buildWebhookCohortAuditSql(false, true);
  const short = (await db.query(shortQuery)).rows[0].json_build_object;
  assert.equal(short.window_seconds, 5);
  assert.equal(Date.parse(short.until) - Date.parse(short.from), 5000);
  assert.equal(Date.parse(short.observed_at) - Date.parse(short.until), 30000);
  assert.equal(short.sample_complete, true);
  assert.equal(short.nonempty, true);
  assert.equal(short.remote_effects_proven, false);
  assert.equal(short.rows.length, 8);
  assert.ok(short.rows.every((row) => row.count_lower_bound === 1 && !row.truncated));
  assert.equal(short.rows.find((row) => row.status === 'PROCESSED').processed_only_p99_ms, 1000);
  assert.doesNotMatch(JSON.stringify(short), /inside-short|outside-short/u);
  await db.exec(`INSERT INTO webhook_events(id,status,created_at)
    SELECT 'short-overflow-' || n, 'RECEIVED', now()-interval '32 seconds'
    FROM generate_series(1,512) n;`);
  const saturated = (await db.query(shortQuery)).rows[0].json_build_object;
  assert.equal(saturated.sample_complete, false);
  assert.equal(saturated.rows.find((row) => row.status === 'RECEIVED').truncated, true);
  assert.equal(saturated.rows.find((row) => row.status === 'RECEIVED').count_lower_bound, 512);
});

test(
  'native cohort bounds index scans before metadata even with retained history and tied timestamps',
  { skip: !local },
  async (t) => {
    const db = new pg.Client({ connectionString: nativeUrl, statement_timeout: 5000 });
    await db.connect();
    t.after(async () => {
      await db.query('ROLLBACK').catch(() => {});
      await db.end();
    });
    await db.query(
      'BEGIN; CREATE SCHEMA webhook_cohort_fixture; SET LOCAL search_path TO webhook_cohort_fixture, public;',
    );
    await db.query(fixture);
    await db.query(`INSERT INTO webhook_events(id,status,created_at)
    SELECT 'private-old-' || n, 'PROCESSED', now()-interval '2 days' FROM generate_series(1,60000) n;
    INSERT INTO webhook_events(id,status,created_at)
    SELECT 'private-new-' || n, 'PROCESSED', now()-interval '45 seconds' FROM generate_series(1,1200) n;
    INSERT INTO webhook_events(id,status,created_at,error_message)
    SELECT 'private-failed-' || n, 'FAILED', now()-interval '45 seconds', 'private-error'
      FROM generate_series(1,1200) n;
    INSERT INTO webhook_events(id,status,created_at)
    SELECT 'private-short-' || n, 'PROCESSED', now()-interval '32 seconds' FROM generate_series(1,1200) n;
    INSERT INTO webhook_events(id,status,created_at,error_message)
    SELECT 'private-short-failed-' || n, 'FAILED', now()-interval '32 seconds', 'private-error'
      FROM generate_series(1,1200) n;
    ANALYZE webhook_events; SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off;
    SET LOCAL max_parallel_workers_per_gather=0;`);
    for (const cohortQuery of [query, buildWebhookCohortAuditSql(false, true)]) {
      // FLAG: EXPLAIN ANALYZE is local disposable-fixture evidence only.
      const plan = (await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + cohortQuery))
        .rows[0]['QUERY PLAN'][0].Plan;
      const scans = [];
      const walk = (n) => {
        if (n['Relation Name'] === 'webhook_events') scans.push(n);
        for (const c of n.Plans ?? []) walk(c);
      };
      walk(plan);
      assert.equal(scans.length, 2);
      assert.ok(
        scans.every((n) =>
          ['webhook_events_status_created_at_id_idx', 'webhook_events_pkey'].includes(
            n['Index Name'],
          ),
        ),
      );
      for (const s of scans) {
        assert.equal(s['Rows Removed by Filter'] ?? 0, 0);
        assert.ok(s['Actual Rows'] <= 513);
        assert.ok(s['Actual Loops'] <= 1024);
      }
      const report = (await db.query(cohortQuery)).rows[0].json_build_object;
      assert.equal(report.sample_complete, false);
      assert.equal(report.rows.find((r) => r.status === 'PROCESSED').count_lower_bound, 512);
      assert.deepEqual(
        report.failure_families.map((r) => [r.family, r.count_lower_bound]),
        [['other', 512]],
      );
    }
  },
);

test('cohort CLI accepts only fixed windows and plain EXPLAIN', () => {
  for (const args of [
    ['SELECT 1'],
    ['--apply'],
    ['--explain', 'extra'],
    ['--short', '--short'],
    ['--explain', '--explain'],
    ['--seconds=600'],
  ]) {
    const r = spawnSync(
      process.execPath,
      [new URL('./webhook-cohort-audit.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  }
  assert.match(buildWebhookCohortAuditSql(true), /^EXPLAIN \(FORMAT JSON\)/u);
  assert.throws(() => buildWebhookCohortAuditSql(false, '60'), /fixed boolean flags/u);
  for (const args of [['--short'], ['--short', '--explain'], ['--explain', '--short']]) {
    const result = spawnSync(
      process.execPath,
      [new URL('./webhook-cohort-audit.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /interval '35 seconds'/u);
    assert.match(result.stdout, /interval '30 seconds' AS until_at/u);
    assert.match(result.stdout, /ORDER BY created_at, id LIMIT 513/u);
    assert.equal(result.stdout.includes('EXPLAIN (FORMAT JSON)'), args.includes('--explain'));
  }
});

const failedFrom = '2026-01-01T00:00:00Z';
const failedUntil = '2026-01-01T00:30:00Z';
const closedWindowMarker = 'MAXIM_WEBHOOK_FAILED_WINDOW_NOT_CLOSED';
const failedIndexMarker = 'MAXIM_WEBHOOK_FAILED_WINDOW_INDEX_UNAVAILABLE';

test('failed-window parser validates a canonical bounded range and preserves existing options', () => {
  assert.deepEqual(parseWebhookCohortArgs([]), {
    explain: false,
    short: false,
    failedWindow: null,
  });
  for (const args of [
    ['--short', '--explain'],
    ['--explain', '--short'],
  ]) {
    assert.deepEqual(parseWebhookCohortArgs(args), {
      explain: true,
      short: true,
      failedWindow: null,
    });
  }
  for (const args of [
    ['--failed-window', failedFrom, failedUntil],
    ['--failed-window', failedFrom, failedUntil, '--explain'],
    ['--explain', '--failed-window', failedFrom, failedUntil],
  ]) {
    assert.deepEqual(parseWebhookCohortArgs(args), {
      explain: args.includes('--explain'),
      short: false,
      failedWindow: { from: failedFrom, until: failedUntil },
    });
  }
  assert.deepEqual(validateWebhookFailedWindow(failedFrom, failedUntil), {
    from: failedFrom,
    until: failedUntil,
    windowSeconds: 1800,
  });
  assert.doesNotThrow(() =>
    validateWebhookFailedWindow('2024-02-29T23:59:00Z', '2024-03-01T00:00:00Z'),
  );
  assert.doesNotThrow(() =>
    validateWebhookFailedWindow('0001-01-01T00:00:00Z', '0001-01-01T00:01:00Z'),
  );
  // FLAG: Server time, rather than the caller's clock, owns closed-window admission.
  assert.doesNotThrow(() =>
    validateWebhookFailedWindow('9999-01-01T00:00:00Z', '9999-01-01T00:01:00Z'),
  );

  const invalidBounds = [
    ['', failedUntil],
    [null, failedUntil],
    [failedFrom, undefined],
    ['0000-01-01T00:00:00Z', '0000-01-01T00:01:00Z'],
    ['2026-02-29T00:00:00Z', '2026-02-29T00:01:00Z'],
    ['2026-04-31T00:00:00Z', '2026-04-31T00:01:00Z'],
    ['2026-13-01T00:00:00Z', failedUntil],
    ['2026-01-01T24:00:00Z', failedUntil],
    ['2026-01-01T00:00:60Z', failedUntil],
    ['2026-01-01T00:00:01Z', failedUntil],
    ['2026-01-01T00:00:00.000Z', failedUntil],
    ['2026-01-01T00:00:00+00:00', failedUntil],
    ['2026-01-01T00:00:00z', failedUntil],
    ['2026-01-01 00:00:00Z', failedUntil],
    [' 2026-01-01T00:00:00Z', failedUntil],
    [failedFrom, failedFrom],
    [failedUntil, failedFrom],
    [failedFrom, '2026-01-01T00:31:00Z'],
    ["2026-01-01T00:00:00Z'; SELECT 1; --", failedUntil],
    ['/tmp/private-audit.sql', failedUntil],
  ];
  for (const [from, until] of invalidBounds) {
    assert.throws(() => validateWebhookFailedWindow(from, until));
    assert.throws(() => buildWebhookFailedWindowGuardSql(from, until));
    assert.throws(() => buildWebhookFailedWindowAuditSql(from, until));
  }
  for (const args of [
    ['--failed-window'],
    ['--failed-window', failedFrom],
    ['--failed-window', failedFrom, failedUntil, 'extra'],
    ['--failed-window', failedFrom, failedUntil, '--short'],
    ['--short', '--failed-window', failedFrom, failedUntil],
    ['--explain', '--failed-window', failedFrom, failedUntil, '--explain'],
    ['--failed-window', failedFrom, failedUntil, '--failed-window', failedFrom, failedUntil],
    ['--failed-window', failedFrom, '--explain', failedUntil],
    ['--failed-window', failedFrom, failedUntil, '--analyze'],
    ['--failed-window', failedFrom, failedUntil, '--cap=1024'],
  ]) {
    assert.throws(() => parseWebhookCohortArgs(args));
    assert.throws(() => buildWebhookCohortCommandSql(args));
  }
  assert.throws(() => buildWebhookFailedWindowAuditSql(failedFrom, failedUntil, 'true'));
});

test('failed-window command emits closed-window refusal before both index guards and plain query', () => {
  const guard = buildWebhookFailedWindowGuardSql(failedFrom, failedUntil);
  const indexes = buildWebhookFailedWindowIndexSql();
  assert.match(guard, /statement_timestamp\(\)/u);
  assert.match(guard, /30 seconds/u);
  assert.match(guard, /\\gset/u);
  assert.match(guard, /\\if/u);
  assert.match(guard, /SELECT 1\s*\/\s*0/u);
  assert.match(indexes, /webhook_events_pkey/u);
  assert.match(indexes, /webhook_events_status_created_at_id_idx/u);
  for (const explain of [false, true]) {
    const args = ['--failed-window', failedFrom, failedUntil, ...(explain ? ['--explain'] : [])];
    const script = buildWebhookCohortCommandSql(args);
    assert.ok(script.indexOf(closedWindowMarker) < script.indexOf(failedIndexMarker));
    assert.ok(script.indexOf(failedIndexMarker) < script.indexOf('failed_webhook_window'));
    assert.equal(script.includes('EXPLAIN (FORMAT JSON)'), explain);
    assert.doesNotMatch(script, /EXPLAIN\s*\([^)]*ANALYZE/iu);
    const cli = spawnSync(
      process.execPath,
      [new URL('./webhook-cohort-audit.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, script);
  }
  assert.equal(
    buildWebhookCohortCommandSql([]),
    buildWebhookCohortIndexSql() + buildWebhookCohortAuditSql(),
  );
  assert.equal(
    buildWebhookCohortCommandSql(['--explain', '--short']),
    buildWebhookCohortIndexSql() + buildWebhookCohortAuditSql(true, true),
  );
});

async function withNativeFailedWindow(run) {
  const address = new URL(nativeUrl);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) &&
      address.pathname.includes('race_test'),
    'Native failed-window integration requires disposable local PostgreSQL race_test',
  );
  const schema = `race_test_failed_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const db = new pg.Client({ connectionString: address.href, statement_timeout: 10000 });
  const psqlAddress = new URL(address);
  psqlAddress.searchParams.delete('schema');
  const trustedPath = `pg_catalog,${schema},pg_temp`;
  const rewrite = (sql) => sql.replaceAll('public.', `${schema}.`);
  let connected = false;
  // FLAG: Every fixture write and timed plan belongs to a fresh local schema. The
  // migrated public schema is untouched; rewrites preserve the production path order.
  try {
    await db.connect();
    connected = true;
    assert.match((await db.query('SHOW server_version')).rows[0].server_version, /^16\./u);
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog,pg_temp;`);
    await db.query(fixture);
    await db.query(`SET search_path TO ${trustedPath};`);
    const report = async (from = failedFrom, until = failedUntil) =>
      Object.values(
        (await db.query(rewrite(buildWebhookFailedWindowAuditSql(from, until)))).rows[0],
      )[0];
    const psql = (args, prefix = '', earlierOptions = '') =>
      spawnSync(
        'psql',
        [
          '-X',
          '--no-password',
          '-qAt',
          '-v',
          'ON_ERROR_STOP=1',
          '-v',
          'ECHO=none',
          '-v',
          'VERBOSITY=terse',
          '-v',
          'SHOW_CONTEXT=never',
          '-d',
          psqlAddress.href,
        ],
        {
          input:
            prefix +
            'BEGIN READ ONLY;\n' +
            rewrite(buildWebhookCohortCommandSql(args)) +
            'COMMIT;\n',
          encoding: 'utf8',
          timeout: 8000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PGOPTIONS: `${earlierOptions} -c timezone=UTC -c search_path=${trustedPath} -c statement_timeout=2500ms -c lock_timeout=250ms -c max_parallel_workers_per_gather=0 -c enable_seqscan=off -c enable_bitmapscan=off -c jit=off -c work_mem=1MB`,
          },
        },
      );
    await run({ db, schema, trustedPath, rewrite, report, psql });
  } finally {
    if (connected) {
      await db.query('ROLLBACK').catch(() => {});
      await db.query(`DROP SCHEMA IF EXISTS ${schema}_shadow CASCADE;`).catch(() => {});
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`).catch(() => {});
    }
    await db.end();
  }
}

function assertFailedWindowEnvelope(value) {
  assert.equal(value.schema_version, 1);
  assert.equal(value.audit, 'failed_webhook_window');
  assert.equal(
    Date.parse(value.from.endsWith('Z') ? value.from : value.from + 'Z'),
    Date.parse(failedFrom),
  );
  assert.equal(
    Date.parse(value.until.endsWith('Z') ? value.until : value.until + 'Z'),
    Date.parse(failedUntil),
  );
  assert.equal(value.window_basis, 'receipt_created_at');
  assert.equal(value.status_scope, 'FAILED');
  assert.equal(value.window_seconds, 1800);
  assert.equal(value.cap, 512);
  assert.equal(value.classification_authority, 'saved_metadata_only');
  assert.equal(value.remote_effects_proven, false);
}

test(
  'native failed window preserves exact families, half-open bounds, metadata counts and privacy',
  { skip: !nativeUrl, timeout: 60000 },
  async () => {
    await withNativeFailedWindow(async ({ db, report }) => {
      const nonce = '11111111-2222-3333-4444-555555555555';
      const pending = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:';
      const rows = [
        [null, 'missing', null],
        ['NO_EXECUTABLE_OWNER; deadline=2026-01-01T00:00:00.000Z', 'no_executable_owner', null],
        [
          'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:private-error',
          'terminal_quarantine_marker',
          null,
        ],
        [
          pending + 'LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
          'pending_quarantine_marker',
          'legacy_execution_unverified',
        ],
        [
          pending + 'CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required',
          'pending_quarantine_marker',
          'canonical_business_started',
        ],
        [
          pending +
            nonce +
            ': Webhook user-facing hot path timed out after 10000ms for message_created',
          'pending_quarantine_marker',
          'detached_timeout',
        ],
        [
          pending +
            nonce +
            ': Webhook user-facing hot path timed out after 10000ms for message_edited | private-error',
          'pending_quarantine_marker',
          'detached_timeout',
        ],
        [
          pending +
            nonce +
            ': detached execution completed without a canonical claim: private-error',
          'pending_quarantine_marker',
          'unclaimed_detached_completed',
        ],
        [
          pending + nonce + ': detached execution failed without a canonical claim: private-error',
          'pending_quarantine_marker',
          'unclaimed_detached_failed',
        ],
        [pending + 'private-nonce: private-error', 'pending_quarantine_marker', 'other_pending'],
        ['Canonical webhook claim is not ready for private-owner', 'canonical_not_ready', null],
        [
          'Webhook preparation failed: Canonical webhook claim is not ready for private-owner',
          'canonical_not_ready',
          null,
        ],
        ['Canonical webhook business lease is busy for private-owner', 'business_lease_busy', null],
        [
          'Webhook preparation failed: Canonical webhook business lease is busy for private-owner',
          'business_lease_busy',
          null,
        ],
        ...[
          'before completion',
          'before unfenced timeout settlement',
          'during timeout quarantine',
        ].map((phase) => [
          `Canonical webhook business lease was lost ${phase} for private-owner`,
          'business_lease_lost',
          null,
        ]),
        [
          'Webhook preparation failed: Canonical webhook business lease was lost before completion for private-owner',
          'business_lease_lost',
          null,
        ],
        [
          'Canonical webhook business lease storage is unavailable for private-owner',
          'business_lease_unavailable',
          null,
        ],
        [
          'Webhook preparation failed: Canonical webhook business lease storage is unavailable for private-owner',
          'business_lease_unavailable',
          null,
        ],
        ['Handler completion claim changed', 'completion_claim_changed', null],
        ['timeout exceeded when trying to connect', 'connection_admission_timeout_text', null],
        ['private copied NO_EXECUTABLE_OWNER; deadline=2026-01-01T00:00:00.000Z', 'other', null],
        ['NO_EXECUTABLE_OWNER; deadline=private-error', 'other', null],
        [
          'private copied ' + pending + 'LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
          'other',
          null,
        ],
        ['private-error https://private.invalid/private-secret', 'other', null],
      ];
      for (const [index, [message]] of rows.entries()) {
        await db.query(
          `INSERT INTO webhook_events(id,status,created_at,error_message,
          next_enqueue_at,timeout_quarantine_expires_at,execution_deadline_at)
          VALUES ($1,'FAILED',$2::timestamp + interval '15 seconds',$3,
            CASE WHEN $4 THEN $2::timestamp + interval '1 day' END,
            CASE WHEN $4 THEN $2::timestamp + interval '2 days' END,
            CASE WHEN $4 THEN $2::timestamp - interval '1 second' END)`,
          [`private-case-${index}`, failedFrom, message, index === 1],
        );
      }
      await db.query(
        `INSERT INTO webhook_events(id,status,created_at,error_message) VALUES
        ('private-at-from','FAILED',$1::timestamp,'Handler completion claim changed'),
        ('private-before-until','FAILED',$2::timestamp-interval '1 millisecond','Handler completion claim changed'),
        ('private-before-from','FAILED',$1::timestamp-interval '1 millisecond','private-outside'),
        ('private-at-until','FAILED',$2::timestamp,'private-outside'),
        ('private-other-status','PROCESSED',$1::timestamp+interval '15 seconds','Handler completion claim changed')`,
        [failedFrom, failedUntil],
      );
      const value = await report();
      assertFailedWindowEnvelope(value);
      assert.equal(value.sampled_count, rows.length + 2);
      assert.equal(value.captured_count_lower_bound, rows.length + 2);
      assert.equal(value.nonempty, true);
      assert.equal(value.truncated, false);
      assert.equal(value.sample_complete, true);
      assert.equal(value.inspection_refused_count, 0);
      assert.equal(value.inspection_complete, true);
      assert.equal(value.sample_classification_complete, true);
      assert.equal(value.classification_complete, true);
      const expected = new Map();
      for (const [, family] of rows) expected.set(family, (expected.get(family) ?? 0) + 1);
      expected.set('completion_claim_changed', expected.get('completion_claim_changed') + 2);
      assert.deepEqual(
        value.failure_families.map(({ family, count_lower_bound }) => [family, count_lower_bound]),
        [...expected].sort(([a], [b]) => a.localeCompare(b)),
      );
      const owner = value.failure_families.find((row) => row.family === 'no_executable_owner');
      for (const key of [
        'retry_scheduled',
        'quarantine_timestamp_present',
        'deadline_elapsed_at_receipt',
        'deadline_elapsed_at_observation',
      ]) {
        assert.equal(owner[key], 1);
      }
      for (const family of value.failure_families.filter((row) => row !== owner)) {
        for (const key of [
          'retry_scheduled',
          'quarantine_timestamp_present',
          'deadline_elapsed_at_receipt',
          'deadline_elapsed_at_observation',
        ]) {
          assert.equal(family[key], 0);
        }
      }
      const pendingExpected = new Map();
      for (const [, , family] of rows)
        if (family) pendingExpected.set(family, (pendingExpected.get(family) ?? 0) + 1);
      assert.deepEqual(
        value.pending_quarantine_families.map(({ family, count_lower_bound }) => [
          family,
          count_lower_bound,
        ]),
        [...pendingExpected].sort(([a], [b]) => a.localeCompare(b)),
      );
      assert.doesNotMatch(JSON.stringify(value), /private-|11111111|https:|payload|error_message/u);
    });
  },
);

test(
  'native failed window separates empty, exact-cap and sentinel saturation from inspection completeness',
  { skip: !nativeUrl, timeout: 60000 },
  async () => {
    await withNativeFailedWindow(async ({ db, report }) => {
      for (const count of [0, 512, 513]) {
        await db.query('TRUNCATE webhook_events');
        await db.query(
          `INSERT INTO webhook_events(id,status,created_at)
          SELECT 'private-cap-'||lpad(n::text,4,'0'),'FAILED',$1::timestamp+interval '15 seconds'
          FROM generate_series(1,$2::integer) n`,
          [failedFrom, count],
        );
        const value = await report();
        assertFailedWindowEnvelope(value);
        assert.equal(value.sampled_count, Math.min(count, 512));
        assert.equal(value.captured_count_lower_bound, count);
        assert.equal(value.truncated, count > 512);
        assert.equal(value.sample_complete, count <= 512);
        assert.equal(value.nonempty, count > 0);
        assert.equal(value.inspection_refused_count, 0);
        assert.equal(value.inspection_complete, true);
        assert.equal(value.sample_classification_complete, true);
        assert.equal(value.classification_complete, count <= 512);
        assert.deepEqual(
          value.inspection_families,
          count ? [{ family: 'null', count_lower_bound: Math.min(count, 512) }] : [],
        );
        assert.equal(
          value.failure_families.reduce((sum, row) => sum + row.count_lower_bound, 0),
          Math.min(count, 512),
        );
      }
    });
  },
);

test(
  'native failed window rejects compressed and oversized text before inspection at the actual 8KiB boundary',
  { skip: !nativeUrl, timeout: 60000 },
  async (t) => {
    await withNativeFailedWindow(async ({ db, report }) => {
      await db.query(
        `INSERT INTO webhook_events(id,status,created_at,error_message) VALUES
        ('private-compressed','FAILED',$1::timestamp,repeat('z',262144)),
        ('private-null','FAILED',$1::timestamp,NULL)`,
        [failedFrom],
      );
      const compressed = (
        await db.query(`SELECT pg_column_compression(error_message) AS compression,
        pg_column_size(error_message) AS bytes FROM webhook_events WHERE id='private-compressed'`)
      ).rows[0];
      assert.ok(compressed.compression);
      assert.ok(compressed.bytes < 8192);
      await db.query('ALTER TABLE webhook_events ALTER COLUMN error_message SET STORAGE EXTERNAL');
      for (const bytes of [8191, 8192, 8193, 32768]) {
        await db.query(
          `INSERT INTO webhook_events(id,status,created_at,error_message)
          VALUES ($1,'FAILED',$2::timestamp,repeat('x',$3::integer))`,
          [`private-external-${bytes}`, failedFrom, bytes],
        );
        const storage = (
          await db.query(
            `SELECT pg_column_compression(error_message) AS compression,
          pg_column_size(error_message) AS bytes FROM webhook_events WHERE id=$1`,
            [`private-external-${bytes}`],
          )
        ).rows[0];
        assert.equal(storage.compression, null);
        assert.equal(storage.bytes, bytes);
      }
      const value = await report();
      assert.equal(value.sampled_count, 6);
      assert.equal(value.sample_complete, true);
      assert.equal(value.inspection_refused_count, 3);
      assert.equal(value.inspection_complete, false);
      assert.equal(value.sample_classification_complete, false);
      assert.equal(value.classification_complete, false);
      assert.deepEqual(value.inspection_families, [
        { family: 'bounded', count_lower_bound: 2 },
        { family: 'compressed_not_inspected', count_lower_bound: 1 },
        { family: 'null', count_lower_bound: 1 },
        { family: 'oversized_not_inspected', count_lower_bound: 2 },
      ]);
      assert.deepEqual(
        value.failure_families.map(({ family, count_lower_bound }) => [family, count_lower_bound]),
        [
          ['compressed_not_inspected', 1],
          ['missing', 1],
          ['other', 2],
          ['oversized_not_inspected', 2],
        ],
      );
      assert.doesNotMatch(JSON.stringify(value), /private-|zzzz|xxxx/u);
      t.diagnostic(
        JSON.stringify({
          audit: 'failed-window-native-storage',
          compressed_bytes: compressed.bytes,
          admitted_physical_bytes: [8191, 8192],
          refused_physical_bytes: [8193, 32768],
        }),
      );
    });
  },
);

function walkFailedWindowPlan(node) {
  return [node, ...(node.Plans ?? []).flatMap(walkFailedWindowPlan)];
}

test(
  'native failed window default plan bounds retained FAILED history before one-row PK metadata reads',
  { skip: !nativeUrl, timeout: 90000 },
  async (t) => {
    await withNativeFailedWindow(async ({ db, rewrite, report }) => {
      await db.query(
        `INSERT INTO webhook_events(id,status,created_at)
        SELECT 'private-old-failed-'||n,'FAILED',$1::timestamp-interval '2 days' FROM generate_series(1,60000) n`,
        [failedFrom],
      );
      await db.query(
        `INSERT INTO webhook_events(id,status,created_at)
        SELECT 'private-old-other-'||n,'PROCESSED',$1::timestamp-interval '2 days' FROM generate_series(1,60000) n`,
        [failedFrom],
      );
      await db.query(
        `INSERT INTO webhook_events(id,status,created_at)
        SELECT 'private-current-other-'||n,'PROCESSED',$1::timestamp+interval '15 seconds' FROM generate_series(1,1200) n`,
        [failedFrom],
      );
      await db.query(
        `INSERT INTO webhook_events(id,status,created_at,error_message)
        SELECT 'private-current-failed-'||lpad(n::text,4,'0'),'FAILED',$1::timestamp+interval '15 seconds','private-error'
        FROM generate_series(1,1200) n`,
        [failedFrom],
      );
      await db.query('ANALYZE webhook_events');
      await db.query(`SET enable_seqscan=on; SET enable_bitmapscan=on;
        SET max_parallel_workers_per_gather=0; SET jit=off; SET work_mem='1MB';
        SET temp_file_limit='8MB'; SET statement_timeout=2500; BEGIN READ ONLY;`);
      let document;
      try {
        // FLAG: Timed plans execute only in this disposable local schema. Unlike the
        // old compatibility case, planner scan methods remain at their defaults.
        document = (
          await db.query(
            'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' +
              rewrite(buildWebhookFailedWindowAuditSql(failedFrom, failedUntil)),
          )
        ).rows[0]['QUERY PLAN'][0];
      } finally {
        await db.query('ROLLBACK');
      }
      const nodes = walkFailedWindowPlan(document.Plan);
      const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
      assert.equal(scans.length, 2);
      const head = scans.find(
        (node) => node['Index Name'] === 'webhook_events_status_created_at_id_idx',
      );
      const metadata = scans.find((node) => node['Index Name'] === 'webhook_events_pkey');
      assert.ok(head, JSON.stringify(scans));
      assert.ok(metadata, JSON.stringify(scans));
      assert.match(head['Node Type'], /^Index (Only )?Scan$/u);
      assert.match(head['Index Cond'], /status.*FAILED/u);
      assert.match(head['Index Cond'], /created_at\s*>=/u);
      assert.match(head['Index Cond'], /created_at\s*</u);
      assert.ok(head['Actual Rows'] <= 513);
      assert.equal(head['Actual Loops'], 1);
      assert.match(metadata['Node Type'], /^Index (Only )?Scan$/u);
      assert.match(metadata['Index Cond'], /id\s*=/u);
      assert.ok(metadata['Actual Rows'] <= 1);
      assert.ok(metadata['Actual Loops'] <= 512);
      for (const scan of scans) assert.equal(scan['Rows Removed by Filter'] ?? 0, 0);
      for (const sort of nodes.filter((node) => node['Node Type'] === 'Sort')) {
        assert.ok(
          !walkFailedWindowPlan(sort).some((node) => node['Relation Name'] === 'webhook_events'),
          'No sort over retained table work before the cap',
        );
        assert.notEqual(sort['Sort Space Type'], 'Disk');
        assert.ok(sort['Actual Rows'] <= 513);
      }
      assert.equal((await report()).captured_count_lower_bound, 513);
      t.diagnostic(
        JSON.stringify({
          audit: 'failed-window-native-default-plan',
          execution_ms: document['Execution Time'],
          scans: scans.map((node) => ({
            index: node['Index Name'],
            rows: node['Actual Rows'],
            loops: node['Actual Loops'],
          })),
        }),
      );
    });
  },
);

test(
  'native emitted psql refuses open windows before absent indexes or relation for report and EXPLAIN',
  { skip: !nativeUrl, timeout: 60000 },
  async () => {
    await withNativeFailedWindow(async ({ db, psql }) => {
      // FLAG: Freeze only the observation operand for deterministic predicate boundaries;
      // the emitted psql scripts below still exercise the real server clock.
      const guardSelect = buildWebhookFailedWindowGuardSql(failedFrom, failedUntil)
        .split('\\gset')[0]
        .replaceAll('statement_timestamp()', '$1::timestamptz');
      for (const [observed, expected] of [
        ['2026-01-01T00:30:30.000Z', true],
        ['2026-01-01T00:30:29.999Z', false],
      ]) {
        assert.equal(
          (await db.query(guardSelect, [observed])).rows[0].webhook_failed_window_closed,
          expected,
        );
      }
      const futureFrom = (
        await db.query(`SELECT to_char(
        date_trunc('minute',statement_timestamp() AT TIME ZONE 'UTC') + interval '2 minutes',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS from_at`)
      ).rows[0].from_at;
      const futureUntil = new Date(Date.parse(futureFrom) + 60000)
        .toISOString()
        .replace('.000Z', 'Z');
      for (const absent of ['index', 'relation']) {
        await db.query(
          absent === 'index'
            ? 'DROP INDEX webhook_events_status_created_at_id_idx'
            : 'DROP TABLE webhook_events',
        );
        for (const explain of [false, true]) {
          const result = psql([
            '--failed-window',
            futureFrom,
            futureUntil,
            ...(explain ? ['--explain'] : []),
          ]);
          assert.notEqual(result.status, 0);
          assert.match(result.stdout, new RegExp(closedWindowMarker, 'u'));
          assert.doesNotMatch(
            result.stdout,
            new RegExp(failedIndexMarker + '|failed_webhook_window', 'u'),
          );
          assert.doesNotMatch(result.stderr, /does not exist|private-/u);
          const closed = psql([
            '--failed-window',
            failedFrom,
            failedUntil,
            ...(explain ? ['--explain'] : []),
          ]);
          assert.notEqual(closed.status, 0);
          assert.match(closed.stdout, new RegExp(failedIndexMarker, 'u'));
          assert.doesNotMatch(closed.stdout, /failed_webhook_window/u);
        }
      }
    });
  },
);

test(
  'native emitted psql attests both exact indexes before report or EXPLAIN metadata reads',
  { skip: !nativeUrl, timeout: 90000 },
  async () => {
    await withNativeFailedWindow(async ({ db, psql }) => {
      const cases = [
        ['head', null],
        [
          'head',
          'CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(created_at,status,id)',
        ],
        [
          'head',
          'CREATE UNIQUE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id)',
        ],
        [
          'head',
          'CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id DESC)',
        ],
        [
          'head',
          'CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id text_pattern_ops)',
        ],
        [
          'head',
          'CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id) INCLUDE(error_message)',
        ],
        [
          'head',
          "CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id) WHERE status='FAILED'",
        ],
        ['pk', null],
        ['pk', 'CREATE INDEX webhook_events_pkey ON webhook_events(id)'],
        ['pk', 'CREATE UNIQUE INDEX webhook_events_pkey ON webhook_events(id)'],
        [
          'pk',
          'ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_pkey PRIMARY KEY(id,created_at)',
        ],
        [
          'pk',
          'ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_pkey PRIMARY KEY(id) DEFERRABLE',
        ],
      ];
      for (const [kind, replacement] of cases) {
        await db.query(
          kind === 'head'
            ? 'DROP INDEX webhook_events_status_created_at_id_idx'
            : 'ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_pkey',
        );
        if (replacement) await db.query(replacement);
        for (const explain of [false, true]) {
          const result = psql([
            '--failed-window',
            failedFrom,
            failedUntil,
            ...(explain ? ['--explain'] : []),
          ]);
          assert.notEqual(result.status, 0);
          assert.match(result.stdout, new RegExp(failedIndexMarker, 'u'));
          assert.doesNotMatch(result.stdout, /failed_webhook_window/u);
        }
        if (replacement) {
          await db.query(
            kind === 'head' || replacement.startsWith('CREATE')
              ? `DROP INDEX ${kind === 'head' ? 'webhook_events_status_created_at_id_idx' : 'webhook_events_pkey'}`
              : 'ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_pkey',
          );
        }
        await db.query(
          kind === 'head'
            ? 'CREATE INDEX webhook_events_status_created_at_id_idx ON webhook_events(status,created_at,id)'
            : 'ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_pkey PRIMARY KEY(id)',
        );
      }
      const accepted = psql(['--failed-window', failedFrom, failedUntil]);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(JSON.parse(accepted.stdout).classification_complete, true);
      const explain = psql(['--explain', '--failed-window', failedFrom, failedUntil]);
      assert.equal(explain.status, 0, explain.stderr);
      assert.ok(Array.isArray(JSON.parse(explain.stdout)));
    });
  },
);

test(
  'native emitted psql keeps trusted relation and enum ahead of hostile defaults and TEMP shadows',
  { skip: !nativeUrl, timeout: 60000 },
  async () => {
    await withNativeFailedWindow(async ({ db, schema, psql }) => {
      await db.query(
        `INSERT INTO webhook_events(id,status,created_at,error_message)
        VALUES ('private-trusted','FAILED',$1::timestamp,'Handler completion claim changed')`,
        [failedFrom],
      );
      const hostile = `${schema}_shadow`;
      await db.query(`CREATE SCHEMA ${hostile};
        CREATE TYPE ${hostile}."WebhookStatus" AS ENUM ('FAILED');
        CREATE TABLE ${hostile}.webhook_events(id text,status ${hostile}."WebhookStatus",created_at timestamp);
        INSERT INTO ${hostile}.webhook_events VALUES ('private-hostile','FAILED','2026-01-01');`);
      const prefix = `CREATE TEMP TABLE temp_scope_bootstrap(n integer);
        CREATE TYPE pg_temp."WebhookStatus" AS ENUM ('FAILED');
        CREATE TEMP TABLE webhook_events(id text,status pg_temp."WebhookStatus",created_at timestamp);
        INSERT INTO pg_temp.webhook_events VALUES ('private-temp','FAILED','2026-01-01');\n`;
      for (const explain of [false, true]) {
        const result = psql(
          ['--failed-window', failedFrom, failedUntil, ...(explain ? ['--explain'] : [])],
          prefix,
          `-c search_path=${hostile},pg_catalog,${schema}`,
        );
        assert.equal(result.status, 0, result.stderr);
        const value = JSON.parse(result.stdout);
        if (explain) {
          const scans = walkFailedWindowPlan(value[0].Plan).filter(
            (node) => node['Relation Name'] === 'webhook_events',
          );
          assert.equal(scans.length, 2);
        } else {
          assert.equal(value.sampled_count, 1);
          assert.equal(value.failure_families[0].family, 'completion_claim_changed');
          assert.doesNotMatch(result.stdout, /private-|shadow/u);
        }
      }
    });
  },
);
