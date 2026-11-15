import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  buildDuplicateHistoryAuditSql,
  parseDuplicateHistoryArgs,
  buildDuplicateHistoryPrivilegesSql,
  buildDuplicateHistoryReadinessSql,
  duplicateHistoryPrivilegePredicate,
} from './duplicate-history-audit.mjs';

test('requires exact bounded chat scope and keeps outcome output private', () => {
  assert.deepEqual(parseDuplicateHistoryArgs(['-123', '--explain']), {
    chatId: '-123',
    explain: true,
  });
  for (const args of [
    [],
    ['123'],
    ['-1;SELECT 1'],
    ['-1', '--analyze'],
    ['-1', '--explain', 'extra'],
  ])
    assert.throws(() => parseDuplicateHistoryArgs(args));
  const sql = buildDuplicateHistoryAuditSql('-123');
  assert.match(sql, /LIMIT 129/u);
  assert.match(sql, /LIMIT 128/u);
  assert.match(sql, /'complete',false/u);
  assert.doesNotMatch(sql, /json_build_object\([^;]*'(?:chat_id|message_id|last_error|metadata)'/u);
  assert.match(buildDuplicateHistoryPrivilegesSql(true), /IN \(3\)/u);
});

test('projection grants are optional and exact, including effective inherited privileges', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE ROLE maxim_audit; CREATE TABLE duplicate_diagnostics_history(intent_id text, chat_id text, intent_created_at timestamp, private_value text);`,
    );
    const ready = async (required) =>
      (await db.query(`SELECT (${duplicateHistoryPrivilegePredicate(required)}) AS ready`)).rows[0]
        .ready;
    assert.equal(await ready(false), true);
    assert.equal(await ready(true), false);
    await db.exec(
      'GRANT SELECT(intent_id,chat_id,intent_created_at) ON duplicate_diagnostics_history TO maxim_audit',
    );
    assert.equal(await ready(true), true);
    await db.exec('GRANT SELECT(private_value) ON duplicate_diagnostics_history TO PUBLIC');
    assert.equal(await ready(false), false);
    await db.exec(
      'REVOKE SELECT(private_value) ON duplicate_diagnostics_history FROM PUBLIC; GRANT SELECT ON duplicate_diagnostics_history TO maxim_audit',
    );
    assert.equal(await ready(false), false);
  } finally {
    await db.close();
  }
});

const url = process.env.MAXIM_TEST_POSTGRES_URL;
test(
  'native duplicate projection preserves sparse outcomes under unrelated history and bounded work',
  { skip: !url, timeout: 30_000 },
  async () => {
    const parsed = new URL(url);
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
        parsed.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: url });
    const schema = `duplicate_history_${randomUUID().replaceAll('-', '')}`;
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path=${schema},public;
      CREATE TABLE moderation_delete_intents(id text PRIMARY KEY, chat_id text, status text, remote_delete_succeeded_at timestamptz, absence_verified_at timestamptz, last_error_code text);
      CREATE TABLE duplicate_diagnostics_history(intent_id text PRIMARY KEY, chat_id text, intent_created_at timestamptz);
      CREATE INDEX duplicate_diagnostics_history_chat_created_id_idx ON duplicate_diagnostics_history(chat_id,intent_created_at DESC,intent_id DESC);
      INSERT INTO moderation_delete_intents SELECT 'unrelated-'||n,'-999','SUCCEEDED',now(),NULL,NULL FROM generate_series(1,120000) n;
      INSERT INTO duplicate_diagnostics_history SELECT 'old-'||n,'-999',now()-interval '2 days' FROM generate_series(1,120000) n;
      INSERT INTO moderation_delete_intents VALUES ('own','-123','SUCCEEDED',now(),NULL,NULL),('absent','-123','ALREADY_ABSENT',NULL,now(),NULL),('ambiguous','-123','AMBIGUOUS',NULL,NULL,'private error text'),('stale','-123','FAILED_TERMINAL',NULL,NULL,'message_duplicate_original_missing');
      INSERT INTO duplicate_diagnostics_history SELECT id,chat_id,now() FROM moderation_delete_intents WHERE chat_id='-123';
      ANALYZE moderation_delete_intents; ANALYZE duplicate_diagnostics_history;
      SET LOCAL statement_timeout='2500ms'; SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL jit=off;`);
      const readiness = buildDuplicateHistoryReadinessSql()
        .split('\\gset')[0]
        .replaceAll('public.', `${schema}.`);
      assert.equal((await db.query(readiness)).rows[0].duplicate_history_indexes_ready, true);
      const report = (await db.query(buildDuplicateHistoryAuditSql('-123'))).rows[0]
        .json_build_object;
      assert.equal(report.sampled_messages, 4);
      assert.equal(report.sample_saturated, false);
      assert.equal(report.complete, false);
      assert(report.rows.some((row) => row.outcome === 'CONFIRMED_DELETE' && row.messages === 1));
      assert(report.rows.some((row) => row.outcome === 'CONFIRMED_ABSENCE'));
      assert(report.rows.some((row) => row.outcome === 'UNCONFIRMED' && row.reason === 'OTHER'));
      assert(!JSON.stringify(report).includes('private error'));
      const explainSql = buildDuplicateHistoryAuditSql('-123', true);
      const plans = await db.query(explainSql);
      const plan = plans.find((result) => result.rows[0]?.['QUERY PLAN'])?.rows[0]['QUERY PLAN'];
      assert.ok(plan);
      assert.match(JSON.stringify(plan), /duplicate_diagnostics_history_chat_created_id_idx/u);
      assert.match(JSON.stringify(plan), /moderation_delete_intents_pkey/u);
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan|Bitmap Heap Scan|-123/u);
      // FLAG: ANALYZE is confined to this disposable local fixture, never the production CLI.
      const measured = await db.query(
        explainSql.replace('EXPLAIN (FORMAT JSON)', 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)'),
      );
      const measuredPlan = measured.find((result) => result.rows[0]?.['QUERY PLAN'])?.rows[0][
        'QUERY PLAN'
      ];
      const scans = [];
      const collect = (node) => {
        if (node['Index Name']) scans.push(node);
        for (const child of node.Plans ?? []) collect(child);
      };
      collect(measuredPlan[0].Plan);
      const projection = scans.find(
        (node) => node['Index Name'] === 'duplicate_diagnostics_history_chat_created_id_idx',
      );
      const intents = scans.find((node) => node['Index Name'] === 'moderation_delete_intents_pkey');
      assert.ok(projection && intents);
      assert.ok(projection['Actual Rows'] <= 129 && projection['Actual Loops'] === 1);
      assert.ok(intents['Actual Rows'] <= 1 && intents['Actual Loops'] <= 128);
      // Saturation is measured before filtering; older rows cannot disappear from coverage.
      await db.query(
        `INSERT INTO duplicate_diagnostics_history SELECT 'missing-'||n,'-123',now() FROM generate_series(1,140) n`,
      );
      const saturated = (await db.query(buildDuplicateHistoryAuditSql('-123'))).rows[0]
        .json_build_object;
      assert.equal(saturated.sample_saturated, true);
      assert(saturated.missing_intents > 0);
      assert.equal(saturated.complete, false);
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  },
);
