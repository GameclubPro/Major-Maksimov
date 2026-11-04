import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { summarizeSignalCollection } from './monitor-signal-results.cjs';

const first = {
  schema_version: 2,
  audit: 'recent_webhook_statuses',
  rows: [
    'RECEIVED',
    'QUEUED',
    'PROCESSED',
    'DUPLICATE',
    'FAILED',
    'NO_REPLAY_HELD',
    'CANCELLED',
    'QUARANTINED',
  ].map((status) => ({ status, count_lower_bound: 0, saturated: false, newest_age_seconds: 0 })),
};
const second = { schema_version: 2, audit: 'recent_night_mode_signals', rows: [] };
const lines = (...records) => records.map((record) => JSON.stringify(record)).join('\n');

test('collection completeness requires both fixed reports and the successful command', () => {
  assert.equal(summarizeSignalCollection(lines(first, second), 0).complete, true);
  const partial = summarizeSignalCollection(lines(first), 3);
  assert.equal(partial.complete, false);
  assert.equal(partial.command_exit_code, 3);
  assert.deepEqual(
    partial.stages.map((stage) => stage.status),
    ['collected', 'missing'],
  );
  assert.equal(summarizeSignalCollection(lines(first, second), 3).complete, false);
});

test('missing, duplicate, malformed and oversized reports remain incomplete', () => {
  for (const output of [
    '',
    lines(first),
    lines(first, second, first),
    '{broken',
    lines(first, { ...second, rows: null }),
    lines(first, { ...second, rows: [null] }),
    lines(first, { ...second, rows: ['bad'] }),
    lines(first, { ...second, rows: [{ rule_code: 'unknown', events: 1, chat_sessions: 1 }] }),
    lines({ ...first, rows: first.rows.slice(1) }, second),
    lines({ ...first, rows: first.rows.map(() => first.rows[0]) }, second),
    lines(
      { ...first, rows: first.rows.map((row) => ({ ...row, count_lower_bound: null })) },
      second,
    ),
    lines(first, { ...second, schema_version: 9 }),
    `${lines(first, second)}\nnot-json`,
    'x'.repeat(65537),
  ]) {
    assert.equal(summarizeSignalCollection(output, 0).complete, false);
  }
  assert.equal(summarizeSignalCollection(lines(first, second), null).complete, false);
});

test('CLI preserves explicit failed-command status without leaking partial input', () => {
  const result = spawnSync(
    process.execPath,
    [new URL('./monitor-signal-results.cjs', import.meta.url).pathname, '7'],
    {
      input: lines(first),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.command_exit_code, 7);
  assert.equal(report.complete, false);
  assert.deepEqual(
    report.stages.map((stage) => stage.status),
    ['collected', 'missing'],
  );
});
