import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {
  ACTION_LATENCY_EXTENSION_COLUMNS,
  ACTION_LATENCY_SOURCES,
  actionLatencyIndexesSql,
  buildActionLatencyAuditSql,
  emitActionLatencyAuditSql,
} from './action-latency-audit.mjs';
import { OWNER_PROOF_COLUMNS, emitOwnerProofPrivilegesSql } from './webhook-owner-proof-audit.mjs';

const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const required = process.env.MAXIM_REQUIRE_ACTION_LATENCY_NATIVE === '1';
const native = { skip: !nativeUrl, timeout: 45_000 };
const readBudget =
  '-c statement_timeout=2500 -c lock_timeout=250 -c work_mem=1MB -c temp_file_limit=8MB -c max_parallel_workers_per_gather=0 -c enable_seqscan=off -c enable_bitmapscan=off -c timezone=UTC -c jit=off';
const actions = [
  'DELETE_MESSAGE',
  'SEND_MESSAGE',
  'KICK_MEMBER',
  'BAN_MEMBER',
  'UNBAN_MEMBER',
  'TRY_UNBAN_MEMBER',
  'NOTIFY_MODERATORS',
];
const outcomes = ['SUCCEEDED', 'SKIPPED', 'AMBIGUOUS', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'];
const lanes = ['critical', 'interactive', 'background'];
const clocks = ['ready_to_last_attempt', 'last_attempt_to_terminal', 'ready_to_terminal'];
const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const scoped = (sql, schema) => sql.replaceAll('public.', `${schema}.`);
const indexSql = `CREATE INDEX max_action_ledger_terminal_completed_id_idx
  ON max_action_ledger(terminal,completed_at DESC,id DESC);`;
const ddl = `CREATE TYPE "MaxActionLedgerStatus" AS ENUM
  ('ENQUEUED','IN_PROGRESS',${outcomes.map(sqlLiteral).join(',')});
CREATE TABLE max_action_ledger (
  id text PRIMARY KEY, terminal boolean NOT NULL DEFAULT true, completed_at timestamp(3),
  action_type text, status "MaxActionLedgerStatus", source_tag text, traffic_class text,
  enqueued_at timestamp(3), last_attempt_at timestamp(3), metadata jsonb,
  chat_id text, message_id text, ambiguous boolean, attempt_count integer,
  dispatch_token text, dispatch_started_at timestamp(3), dispatch_bot_id text,
  remote_message_id text, last_error text, private_forbidden text
);
${indexSql}
CREATE TABLE webhook_execution_claims (
  ${OWNER_PROOF_COLUMNS.webhook_execution_claims.map((column) => `${column} text`).join(',')}
);`;

function localAddress() {
  const address = new URL(nativeUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(address.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
  assert.match(address.pathname, /^\/(?:race_test|maxim_race_test_[a-f0-9]+)$/u);
  return address;
}

async function fixture(t) {
  localAddress();
  const client = new pg.Client({
    connectionString: nativeUrl,
    application_name: 'action-latency-native-fixture',
    connectionTimeoutMillis: 5000,
    query_timeout: 8000,
    options: readBudget,
  });
  await client.connect();
  const schema = `action_latency_${randomUUID().replaceAll('-', '')}`;
  t.after(async () => {
    try {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  });
  const version = Number(
    (await client.query('SHOW server_version_num')).rows[0].server_version_num,
  );
  assert.ok(
    version >= 160000 && version < 170000,
    'Use actual PostgreSQL 16 for storage admission',
  );
  assert.equal((await client.query('SHOW temp_file_limit')).rows[0].temp_file_limit, '8MB');
  // FLAG: Only private fixture relations replace public names. The production SQL,
  // timestamps, storage checks, limits and real PostgreSQL planner remain unchanged.
  await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog; ${ddl}`);
  return { client, schema };
}

async function readOnly(client, sql) {
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query(sql);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function report({ client, schema }) {
  const result = await readOnly(client, scoped(buildActionLatencyAuditSql(), schema));
  const value = result.rows[0].json_build_object;
  assert.doesNotMatch(JSON.stringify(value), /private-|secret-token|raw-error|dispatch-secret/u);
  return value;
}

const group = (value, dimension = 'overall', key = 'all') => {
  const matches = value.groups.filter((row) => row.dimension === dimension && row.key === key);
  assert.equal(matches.length, 1, `${dimension}/${key}`);
  return matches[0];
};
const counts = (entries) => Object.fromEntries(entries.map((entry) => [entry.state, entry.count]));
const time = (anchor, offset) => new Date(anchor + offset).toISOString();

async function insert(client, rows) {
  const values = [];
  const tuples = rows.map((row, i) => {
    values.push(
      row.id ?? `private-action-${i}`,
      row.terminal ?? true,
      row.completed,
      row.action ?? 'DELETE_MESSAGE',
      row.outcome ?? 'SUCCEEDED',
      row.source === undefined ? 'moderation_delete' : row.source,
      row.lane === undefined ? 'critical' : row.lane,
      row.enqueued,
      row.attempt,
      row.metadata === undefined ? null : JSON.stringify(row.metadata),
      'private-chat',
      'private-message',
      'dispatch-secret',
      'private-forbidden',
    );
    return `(${Array.from({ length: 14 }, (_, j) => `$${i * 14 + j + 1}`).join(',')})`;
  });
  await client.query(
    `INSERT INTO max_action_ledger
    (id,terminal,completed_at,action_type,status,source_tag,traffic_class,enqueued_at,
      last_attempt_at,metadata,chat_id,message_id,dispatch_token,private_forbidden)
    VALUES ${tuples.join(',')}`,
    values,
  );
}

test(
  'action latency native validation cannot silently skip when explicitly required',
  {
    skip: !required,
  },
  () =>
    assert.ok(nativeUrl, 'MAXIM_REQUIRE_ACTION_LATENCY_NATIVE=1 requires MAXIM_TEST_POSTGRES_URL'),
);

test(
  'native action latency reports empty cohorts and finite action/outcome/lane dimensions',
  native,
  async (t) => {
    const f = await fixture(t);
    const empty = await report(f);
    assert.equal(empty.schema_version, 1);
    assert.equal(empty.audit, 'action_latency');
    assert.equal(empty.basis, 'terminal_outcomes');
    assert.equal(empty.window_basis, 'completed_at');
    assert.equal(empty.action_start_basis, 'max_enqueued_at_scheduled_for');
    assert.equal(Date.parse(empty.window_ended_at) - Date.parse(empty.window_started_at), 900_000);
    assert.equal(empty.sample_count, 0);
    assert.equal(empty.sample_complete, true);
    assert.equal(empty.sampled_from, null);
    for (const clock of clocks) {
      assert.deepEqual(group(empty)[clock], {
        sample_count: 0,
        excluded_count: 0,
        p50_ms: null,
        p95_ms: null,
        p99_ms: null,
      });
    }
    for (const field of ['pending_actions_observed', 'retry_authority', 'remote_effect_proven']) {
      assert.equal(empty[field], false);
    }
    const anchor = Date.now() - 60_000;
    await insert(
      f.client,
      actions.flatMap((action) =>
        outcomes.flatMap((outcome) =>
          lanes.map((lane) => ({
            id: `private-${action}-${outcome}-${lane}`,
            action,
            outcome,
            lane,
            enqueued: time(anchor, -1000),
            attempt: time(anchor, -400),
            completed: time(anchor, 0),
          })),
        ),
      ),
    );
    const value = await report(f);
    assert.equal(value.sample_count, 105);
    assert.equal(value.sample_complete, true);
    assert.deepEqual(
      value.groups
        .filter((row) => row.dimension === 'action')
        .map((row) => row.key)
        .sort(),
      [...actions].sort(),
    );
    assert.deepEqual(
      value.groups
        .filter((row) => row.dimension === 'outcome')
        .map((row) => row.key)
        .sort(),
      [...outcomes].sort(),
    );
    assert.deepEqual(
      value.groups
        .filter((row) => row.dimension === 'traffic_class')
        .map((row) => row.key)
        .sort(),
      [...lanes].sort(),
    );
    for (const action of actions) assert.equal(group(value, 'action', action).row_count, 15);
    for (const outcome of outcomes) assert.equal(group(value, 'outcome', outcome).row_count, 21);
    for (const lane of lanes) assert.equal(group(value, 'traffic_class', lane).row_count, 35);
    for (const [clock, milliseconds] of clocks.map((clock, i) => [clock, [600, 400, 1000][i]])) {
      assert.deepEqual(group(value)[clock], {
        sample_count: 105,
        excluded_count: 0,
        p50_ms: milliseconds,
        p95_ms: milliseconds,
        p99_ms: milliseconds,
      });
    }
  },
);

test(
  'native action latency keeps the three clocks independent and excludes unknown readiness',
  native,
  async (t) => {
    const f = await fixture(t);
    const anchor = Date.now() - 60_000;
    const base = {
      enqueued: time(anchor, -1000),
      attempt: time(anchor, -400),
      completed: time(anchor, 0),
    };
    const cases = [
      ['absent metadata', {}, [600, 400, 1000], 'KNOWN'],
      ['absent schedule', { metadata: {} }, [600, 400, 1000], 'KNOWN'],
      ['null schedule', { metadata: { scheduledFor: null } }, [600, 400, 1000], 'KNOWN'],
      [
        'later schedule',
        { metadata: { scheduledFor: time(anchor, -700) } },
        [300, 400, 700],
        'KNOWN',
      ],
      [
        'earlier schedule',
        { metadata: { scheduledFor: time(anchor, -2000) } },
        [600, 400, 1000],
        'KNOWN',
      ],
      ['array metadata', { metadata: [] }, [null, 400, null], 'UNKNOWN_METADATA'],
      ['json null metadata', { metadata: null }, [null, 400, null], 'UNKNOWN_METADATA'],
      [
        'numeric schedule',
        { metadata: { scheduledFor: 42 } },
        [null, 400, null],
        'UNKNOWN_METADATA',
      ],
      [
        'oversize schedule scalar',
        { metadata: { scheduledFor: '2'.repeat(81) } },
        [null, 400, null],
        'UNKNOWN_METADATA',
      ],
      [
        'invalid calendar date',
        { metadata: { scheduledFor: '2026-02-30T00:00:00.000Z' } },
        [null, 400, null],
        'INVALID_SCHEDULE',
      ],
      [
        'infinite schedule',
        { metadata: { scheduledFor: 'infinity' } },
        [null, 400, null],
        'INVALID_SCHEDULE',
      ],
      [
        'non UTC schedule',
        { metadata: { scheduledFor: '2026-01-01T00:00:00+01:00' } },
        [null, 400, null],
        'INVALID_SCHEDULE',
      ],
      ['missing enqueue', { enqueued: null }, [null, 400, null], 'MISSING_READY_CLOCK'],
      [
        'missing enqueue with schedule',
        { enqueued: null, metadata: { scheduledFor: time(anchor, -700) } },
        [null, 400, null],
        'MISSING_READY_CLOCK',
      ],
      ['infinite enqueue', { enqueued: 'infinity' }, [null, 400, null], 'INVALID_READY_CLOCK'],
      [
        'negative infinite enqueue with schedule',
        { enqueued: '-infinity', metadata: { scheduledFor: time(anchor, -700) } },
        [null, 400, null],
        'INVALID_READY_CLOCK',
      ],
      [
        'enqueue after completion',
        { enqueued: time(anchor, 1) },
        [null, 400, null],
        'INVALID_READY_CLOCK',
      ],
      [
        'schedule after completion',
        { metadata: { scheduledFor: time(anchor, 1) } },
        [null, 400, null],
        'INVALID_READY_CLOCK',
      ],
      ['missing last attempt', { attempt: null }, [null, null, 1000], 'KNOWN'],
      ['attempt before ready', { attempt: time(anchor, -1200) }, [null, 1200, 1000], 'KNOWN'],
      ['attempt after completion', { attempt: time(anchor, 1) }, [null, null, 1000], 'KNOWN'],
      ['infinite last attempt', { attempt: 'infinity' }, [null, null, 1000], 'KNOWN'],
    ];
    for (const [name, overrides, expected, readiness] of cases) {
      await t.test(name, async () => {
        await f.client.query('TRUNCATE max_action_ledger');
        await insert(f.client, [{ ...base, ...overrides, outcome: 'FAILED_RETRYABLE' }]);
        const value = await report(f);
        assert.equal(value.sample_count, 1);
        assert.equal(group(value, 'outcome', 'FAILED_RETRYABLE').row_count, 1);
        assert.deepEqual(counts(value.readiness), { [readiness]: 1 });
        for (const [i, clock] of clocks.entries()) {
          const actual = group(value)[clock];
          assert.equal(actual.sample_count, expected[i] === null ? 0 : 1);
          assert.equal(actual.excluded_count, expected[i] === null ? 1 : 0);
          for (const percentile of ['p50_ms', 'p95_ms', 'p99_ms'])
            assert.equal(actual[percentile], expected[i]);
        }
      });
    }
  },
);

test(
  'native storage admission rejects compressed/oversized metadata and keeps private dimensions finite',
  native,
  async (t) => {
    const f = await fixture(t);
    const anchor = Date.now() - 60_000;
    const base = {
      enqueued: time(anchor, -1000),
      attempt: time(anchor, -400),
      completed: time(anchor, 0),
    };
    await insert(f.client, [
      {
        ...base,
        id: 'private-compressed',
        metadata: { scheduledFor: time(anchor, -700), secret: 'private-padding-'.repeat(4000) },
      },
    ]);
    assert.notEqual(
      (
        await f.client.query(
          "SELECT pg_column_compression(metadata) AS compression FROM max_action_ledger WHERE id='private-compressed'",
        )
      ).rows[0].compression,
      null,
    );
    await f.client.query(
      'ALTER TABLE max_action_ledger ALTER COLUMN metadata SET STORAGE EXTERNAL',
    );
    await insert(f.client, [
      {
        ...base,
        id: 'private-oversize',
        metadata: { scheduledFor: time(anchor, -700), secret: 'private-padding-'.repeat(4000) },
      },
      {
        ...base,
        id: 'private-dimensions',
        action: 'private-action',
        outcome: 'ENQUEUED',
        source: 'private-source-'.repeat(4000),
        lane: 'private-lane',
        metadata: { secret: 'secret-token' },
      },
      {
        ...base,
        id: 'private-null-dimensions',
        source: null,
        lane: null,
        metadata: { secret: 'raw-error' },
      },
    ]);
    await f.client.query(
      "UPDATE max_action_ledger SET last_error=repeat('raw-error-secret-token-',4000)",
    );
    const oversized = (
      await f.client.query(
        "SELECT pg_column_compression(metadata) AS compression,pg_column_size(metadata) AS bytes FROM max_action_ledger WHERE id='private-oversize'",
      )
    ).rows[0];
    assert.equal(oversized.compression, null);
    assert.ok(oversized.bytes > 8192);
    const value = await report(f);
    assert.equal(value.sample_count, 4);
    assert.deepEqual(counts(value.metadata_admission), {
      COMPRESSED_NOT_INSPECTED: 1,
      OVERSIZED_NOT_INSPECTED: 1,
      UNSCHEDULED: 2,
    });
    assert.deepEqual(counts(value.readiness), { KNOWN: 2, UNKNOWN_METADATA: 2 });
    assert.equal(group(value).ready_to_terminal.sample_count, 2);
    assert.equal(group(value).last_attempt_to_terminal.sample_count, 4);
    for (const dimension of ['action', 'outcome', 'source', 'traffic_class']) {
      assert.equal(group(value, dimension, 'OTHER').row_count, 1);
    }
    assert.equal(group(value, 'source', 'MISSING').row_count, 1);
    assert.equal(group(value, 'traffic_class', 'MISSING').row_count, 1);
  },
);

test(
  'native action latency uses nearest-rank percentiles over admitted rows',
  native,
  async (t) => {
    const f = await fixture(t);
    const anchor = Date.now() - 60_000;
    await insert(
      f.client,
      Array.from({ length: 100 }, (_, i) => ({
        id: `private-percentile-${i}`,
        enqueued: time(anchor, -(i + 1) * 10),
        attempt: time(anchor, -(i + 1) * 4),
        completed: time(anchor, 0),
      })),
    );
    const value = await report(f);
    for (const [i, clock] of clocks.entries()) {
      const multiplier = [6, 4, 10][i];
      assert.deepEqual(group(value)[clock], {
        sample_count: 100,
        excluded_count: 0,
        p50_ms: 50 * multiplier,
        p95_ms: 95 * multiplier,
        p99_ms: 99 * multiplier,
      });
    }
  },
);

test(
  'native maximum finite dimension diversity fits the actual 8 MiB temporary-file budget',
  native,
  async (t) => {
    const f = await fixture(t);
    await f.client.query(`INSERT INTO max_action_ledger
    (id,terminal,completed_at,action_type,status,source_tag,traffic_class,enqueued_at,last_attempt_at)
    SELECT 'private-diverse-'||n,true,now()-interval '1 minute',
      (ARRAY[${actions.map(sqlLiteral).join(',')}])[n%${actions.length}+1],
      (ARRAY[${outcomes.map(sqlLiteral).join(',')}]::"MaxActionLedgerStatus"[])[n%${outcomes.length}+1],
      (ARRAY[${ACTION_LATENCY_SOURCES.map(sqlLiteral).join(',')}])[n%${ACTION_LATENCY_SOURCES.length}+1],
      (ARRAY[${lanes.map(sqlLiteral).join(',')}])[n%${lanes.length}+1],
      now()-interval '2 minutes'-n*interval '1 millisecond',
      now()-interval '61 seconds'-n*interval '1 millisecond'
    FROM generate_series(1,5000)n; ANALYZE max_action_ledger;`);
    const value = await report(f);
    assert.equal(value.sample_count, 5000);
    assert.equal(value.sample_complete, true);
    assert.equal(
      value.groups.length,
      1 + actions.length + outcomes.length + ACTION_LATENCY_SOURCES.length + lanes.length,
    );
    for (const [dimension, keys] of [
      ['action', actions],
      ['outcome', outcomes],
      ['source', ACTION_LATENCY_SOURCES],
      ['traffic_class', lanes],
    ]) {
      const selected = value.groups.filter((row) => row.dimension === dimension);
      assert.deepEqual(selected.map((row) => row.key).sort(), [...keys].sort());
      assert.equal(
        selected.reduce((sum, row) => sum + row.row_count, 0),
        5000,
      );
    }
    for (const row of value.groups) {
      for (const clock of clocks) {
        assert.equal(row[clock].sample_count, row.row_count);
        assert.equal(row[clock].excluded_count, 0);
        assert.ok(row[clock].p50_ms <= row[clock].p95_ms);
        assert.ok(row[clock].p95_ms <= row[clock].p99_ms);
      }
    }
    await f.client.query(
      "UPDATE max_action_ledger SET metadata=jsonb_build_object('scheduledFor',repeat('2',80))",
    );
    const maximumSchedule = await report(f);
    assert.equal(maximumSchedule.sample_count, 5000);
    assert.deepEqual(counts(maximumSchedule.metadata_admission), { BOUNDED_SCHEDULE: 5000 });
    assert.deepEqual(counts(maximumSchedule.readiness), { INVALID_SCHEDULE: 5000 });
    assert.equal(group(maximumSchedule).last_attempt_to_terminal.sample_count, 5000);
    assert.equal(group(maximumSchedule).ready_to_last_attempt.sample_count, 0);
    assert.equal(group(maximumSchedule).ready_to_terminal.sample_count, 0);
  },
);

function allNodes(node) {
  return [node, ...(node.Plans ?? []).flatMap(allNodes)];
}

test(
  'native global completion head preserves 5000/5001 saturation before indexed detail reads',
  native,
  async (t) => {
    const f = await fixture(t);
    await f.client.query(`INSERT INTO max_action_ledger
    (id,terminal,completed_at,action_type,status,source_tag,traffic_class,enqueued_at,last_attempt_at,metadata)
    SELECT 'private-current-'||lpad(n::text,5,'0'),true,now()-interval '1 minute',
      'DELETE_MESSAGE','SUCCEEDED','moderation_delete','critical',
      now()-interval '61 seconds',now()-interval '60.4 seconds','{}'::jsonb
    FROM generate_series(1,5000)n;
    INSERT INTO max_action_ledger(id,terminal,completed_at,metadata)
    SELECT 'private-old-'||n,true,now()-interval '2 days',NULL FROM generate_series(1,30000)n;
    INSERT INTO max_action_ledger(id,terminal,completed_at,metadata)
    SELECT 'private-nonterminal-'||n,false,now()-interval '1 second',NULL FROM generate_series(1,30000)n;
    INSERT INTO max_action_ledger(id,terminal,completed_at)
    VALUES('private-future',true,now()+interval '1 day'),('private-infinite',true,'infinity'),
      ('private-negative-infinite',true,'-infinity'),('private-missing-completion',true,NULL);
    ANALYZE max_action_ledger;`);
    const exact = await report(f);
    assert.equal(exact.sample_count, 5000);
    assert.equal(exact.sample_complete, true);
    assert.equal(group(exact, 'action', 'DELETE_MESSAGE').row_count, 5000);
    // FLAG: The rare action ties on completion but sorts after the sampled head by id.
    // It must trip global saturation even though that action is absent from the report.
    await f.client.query(`INSERT INTO max_action_ledger
    (id,terminal,completed_at,action_type,status,source_tag,traffic_class,enqueued_at,last_attempt_at)
    SELECT 'private-current-00000',true,completed_at,'SEND_MESSAGE','SUCCEEDED',
      'moderation_notice','background',enqueued_at,last_attempt_at
    FROM max_action_ledger WHERE id='private-current-00001'; ANALYZE max_action_ledger;`);
    const saturated = await report(f);
    assert.equal(saturated.sample_count, 5000);
    assert.equal(saturated.sample_complete, false);
    assert.equal(group(saturated, 'action', 'DELETE_MESSAGE').row_count, 5000);
    assert.ok(
      !saturated.groups.some((row) => row.dimension === 'action' && row.key === 'SEND_MESSAGE'),
    );
    // FLAG: ANALYZE executes only this disposable fixture's real query. Production
    // diagnostics retain plain EXPLAIN, unchanged budgets and the shared audit lock.
    const plan = (
      await readOnly(
        f.client,
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + scoped(buildActionLatencyAuditSql(), f.schema),
      )
    ).rows[0]['QUERY PLAN'][0].Plan;
    const nodes = allNodes(plan);
    const scans = nodes.filter((node) => node['Relation Name'] === 'max_action_ledger');
    assert.equal(scans.length, 2, JSON.stringify(plan));
    const head = scans.find(
      (node) => node['Index Name'] === 'max_action_ledger_terminal_completed_id_idx',
    );
    const details = scans.find((node) => node['Index Name'] === 'max_action_ledger_pkey');
    assert.ok(head && details, JSON.stringify(plan));
    assert.ok(['Index Scan', 'Index Only Scan'].includes(head['Node Type']));
    assert.equal(head['Actual Loops'], 1);
    assert.equal(head['Actual Rows'], 5001);
    assert.match(head['Index Cond'], /terminal.*completed_at/u);
    assert.equal(head['Rows Removed by Filter'] ?? 0, 0);
    assert.equal(details['Node Type'], 'Index Scan');
    assert.equal(details['Actual Rows'], 1);
    assert.equal(details['Actual Loops'], 5000);
    assert.ok(nodes.some((node) => node['Node Type'] === 'Limit' && node['Actual Rows'] === 5001));
    assert.ok(nodes.some((node) => node['Node Type'] === 'Limit' && node['Actual Rows'] === 5000));
    for (const sort of nodes.filter((node) => node['Node Type'] === 'Sort')) {
      assert.ok(
        sort.Plans.every((child) => child['Actual Rows'] <= 20_000),
        JSON.stringify(sort),
      );
    }
  },
);

test(
  'native action latency refuses drifted indexes, storage relations and clock types',
  native,
  async (t) => {
    const f = await fixture(t);
    const ready = async () =>
      (await f.client.query(scoped(actionLatencyIndexesSql, f.schema))).rows[0]
        .action_latency_indexes_ready;
    assert.equal(await ready(), true);
    const changes = [
      ['missing index', 'DROP INDEX max_action_ledger_terminal_completed_id_idx'],
      [
        'ascending completion',
        'DROP INDEX max_action_ledger_terminal_completed_id_idx; CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at,id)',
      ],
      [
        'included column',
        'DROP INDEX max_action_ledger_terminal_completed_id_idx; CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at DESC,id DESC) INCLUDE(source_tag)',
      ],
      [
        'partial predicate',
        'DROP INDEX max_action_ledger_terminal_completed_id_idx; CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at DESC,id DESC) WHERE terminal',
      ],
      [
        'expression key',
        'DROP INDEX max_action_ledger_terminal_completed_id_idx; CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at DESC,(lower(id)) DESC)',
      ],
      [
        'changed null ordering',
        'DROP INDEX max_action_ledger_terminal_completed_id_idx; CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at DESC NULLS LAST,id DESC)',
      ],
      [
        'nondefault opclass',
        'DROP INDEX max_action_ledger_terminal_completed_id_idx; CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at DESC,id text_pattern_ops DESC)',
      ],
      [
        'changed collation',
        'DROP INDEX max_action_ledger_terminal_completed_id_idx; CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at DESC,id COLLATE "C" DESC)',
      ],
      ['row security', 'ALTER TABLE max_action_ledger ENABLE ROW LEVEL SECURITY'],
      [
        'missing primary key',
        'ALTER TABLE max_action_ledger DROP CONSTRAINT max_action_ledger_pkey',
      ],
      [
        'timezone clock type',
        'ALTER TABLE max_action_ledger ALTER COLUMN enqueued_at TYPE timestamp(3) with time zone',
      ],
      [
        'clock precision',
        'ALTER TABLE max_action_ledger ALTER COLUMN last_attempt_at TYPE timestamp(6)',
      ],
      // FLAG: Each catalog mutation is local, transactional and names only this
      // fixture's private index. Rollback restores its flags before the next case.
      ...['indisvalid', 'indisready', 'indislive'].map((flag) => [
        flag,
        `UPDATE pg_catalog.pg_index SET ${flag}=false WHERE indexrelid='${f.schema}.max_action_ledger_terminal_completed_id_idx'::regclass`,
      ]),
    ];
    for (const [name, change] of changes) {
      await t.test(name, async () => {
        await f.client.query('BEGIN');
        try {
          await f.client.query(change);
          assert.equal(await ready(), false);
        } finally {
          await f.client.query('ROLLBACK');
        }
        assert.equal(await ready(), true);
      });
    }
  },
);

const grants = (table, columns, role) =>
  `GRANT SELECT (${columns.join(',')}) ON ${table} TO ${role};`;

test(
  'real psql refuses partial/effective excess grants and failed indexes before report execution',
  native,
  async (t) => {
    const address = localAddress();
    const cases = [
      ['complete reviewed union', '', true],
      [
        'partial latency extension',
        'REVOKE SELECT (metadata) ON max_action_ledger FROM READER;',
        false,
      ],
      [
        'original group without latency extension',
        `REVOKE SELECT (${ACTION_LATENCY_EXTENSION_COLUMNS.join(',')}) ON max_action_ledger FROM READER;`,
        false,
        'ACTION_LATENCY_PRIVILEGES_INVALID',
      ],
      [
        'latency extension without original group',
        Object.entries(OWNER_PROOF_COLUMNS)
          .map(
            ([table, columns]) => `REVOKE SELECT (${columns.join(',')}) ON ${table} FROM READER;`,
          )
          .join('\n'),
        false,
      ],
      [
        'extension cannot replace original group',
        'REVOKE SELECT (chat_id) ON max_action_ledger FROM READER;',
        false,
      ],
      ['missing required column', 'ALTER TABLE max_action_ledger DROP COLUMN metadata;', false],
      ['table SELECT excess', 'GRANT SELECT ON max_action_ledger TO READER;', false],
      [
        'forbidden column excess',
        'GRANT SELECT (private_forbidden) ON max_action_ledger TO READER;',
        false,
      ],
      [
        'PUBLIC effective excess',
        'GRANT SELECT (private_forbidden) ON max_action_ledger TO PUBLIC;',
        false,
      ],
      [
        'inherited effective excess',
        'CREATE ROLE INHERITED; GRANT SELECT(private_forbidden) ON max_action_ledger TO INHERITED; GRANT INHERITED TO READER;',
        false,
      ],
      ['column write excess', 'GRANT UPDATE(source_tag) ON max_action_ledger TO READER;', false],
      ['index guard', 'DROP INDEX max_action_ledger_terminal_completed_id_idx;', false],
    ];
    for (const [name, change, admitted, expectedRefusal] of cases) {
      await t.test(name, () => {
        const suffix = randomUUID().replaceAll('-', '');
        const schema = `action_cli_${suffix}`;
        const reader = `action_reader_${suffix}`;
        const inherited = `action_inherited_${suffix}`;
        // FLAG: A real psql connection owns and rolls back its own schema and roles.
        // ON_ERROR_STOP must abort before the report/sentinel even on PostgreSQL16.
        const sql = scoped(
          `BEGIN;
CREATE SCHEMA ${schema}; CREATE ROLE ${reader} INHERIT;
SET LOCAL search_path TO ${schema},pg_catalog;
${ddl}
GRANT USAGE ON SCHEMA ${schema} TO ${reader};
${Object.entries(OWNER_PROOF_COLUMNS)
  .map(([table, columns]) => grants(table, columns, reader))
  .join('\n')}
${grants('max_action_ledger', ACTION_LATENCY_EXTENSION_COLUMNS, reader)}
${change.replaceAll('INHERITED', inherited).replaceAll('READER', reader)}
SET LOCAL ROLE ${reader};
${emitOwnerProofPrivilegesSql(false)}
${emitActionLatencyAuditSql()}
SELECT 'action-latency-after-report';
ROLLBACK;`,
          schema,
        );
        const result = spawnSync(
          'psql',
          ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse'],
          {
            input: sql,
            encoding: 'utf8',
            timeout: 8000,
            maxBuffer: 128 * 1024,
            env: {
              ...process.env,
              PGHOST: address.hostname.replace(/^\[|\]$/gu, ''),
              PGPORT: address.port || '5432',
              PGUSER: decodeURIComponent(address.username),
              PGPASSWORD: decodeURIComponent(address.password),
              PGDATABASE: decodeURIComponent(address.pathname.slice(1)),
              PGOPTIONS: readBudget,
            },
          },
        );
        assert.equal(result.error, undefined, name);
        assert.equal(result.signal, null, name);
        assert.equal(result.status, admitted ? 0 : 3, result.stderr);
        assert.equal(
          result.stdout.includes('action-latency-after-report'),
          admitted,
          result.stdout,
        );
        assert.equal(result.stdout.includes('"audit" : "action_latency"'), admitted, result.stdout);
        if (!admitted) {
          assert.match(result.stderr, /division by zero/u);
          assert.match(result.stdout, /(?:PRIVILEGES|INDEXES)_INVALID/u);
          if (expectedRefusal) {
            assert.ok(result.stdout.includes(expectedRefusal), result.stdout);
            assert.doesNotMatch(result.stdout, /WEBHOOK_OWNER_PROOF_PRIVILEGES_INVALID/u);
          }
        }
      });
    }
  },
);
