'use strict';

const EXPECTED_AUDITS = Object.freeze(['recent_webhook_statuses', 'recent_night_mode_signals']);
const WEBHOOK_STATUSES = Object.freeze([
  'RECEIVED',
  'QUEUED',
  'PROCESSED',
  'DUPLICATE',
  'FAILED',
  'NO_REPLAY_HELD',
  'CANCELLED',
  'QUARANTINED',
]);
const NIGHT_RULES = Object.freeze([
  'NIGHT_MODE_CLOSE_NOTICE',
  'NIGHT_MODE_OPEN_NOTICE',
  'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE',
]);
const MAX_BYTES = 64 * 1024;

function validRows(audit, rows) {
  if (
    !Array.isArray(rows) ||
    rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
  )
    return false;
  if (audit === 'recent_webhook_statuses') {
    return (
      rows.length === WEBHOOK_STATUSES.length &&
      new Set(rows.map((row) => row.status)).size === WEBHOOK_STATUSES.length &&
      rows.every(
        (row) =>
          WEBHOOK_STATUSES.includes(row.status) &&
          Number.isSafeInteger(row.count_lower_bound) &&
          row.count_lower_bound >= 0 &&
          row.count_lower_bound <= 2000 &&
          typeof row.saturated === 'boolean' &&
          Number.isSafeInteger(row.newest_age_seconds) &&
          row.newest_age_seconds >= 0,
      )
    );
  }
  return (
    rows.length <= NIGHT_RULES.length &&
    new Set(rows.map((row) => row.rule_code)).size === rows.length &&
    rows.every(
      (row) =>
        NIGHT_RULES.includes(row.rule_code) &&
        Number.isSafeInteger(row.events) &&
        row.events >= 0 &&
        Number.isSafeInteger(row.chat_sessions) &&
        row.chat_sessions >= 0 &&
        row.chat_sessions <= row.events,
    )
  );
}

function summarizeSignalCollection(output, commandExit) {
  const stages = EXPECTED_AUDITS.map((audit) => ({ audit, status: 'missing' }));
  let invalidRecords = 0;
  if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_BYTES) {
    invalidRecords = 1;
  } else {
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        invalidRecords += 1;
        continue;
      }
      const stage = stages.find((item) => item.audit === record?.audit);
      if (!stage) {
        invalidRecords += 1;
      } else if (stage.status !== 'missing') {
        stage.status = 'duplicate';
      } else {
        stage.status =
          record &&
          !Array.isArray(record) &&
          [1, 2].includes(record.schema_version) &&
          validRows(stage.audit, record.rows)
            ? 'collected'
            : 'invalid';
      }
    }
  }
  const commandExitCode =
    Number.isInteger(commandExit) && commandExit >= 0 && commandExit <= 255 ? commandExit : null;
  return {
    schema_version: 1,
    audit: 'monitor_signal_collection',
    complete:
      commandExitCode === 0 &&
      invalidRecords === 0 &&
      stages.every((stage) => stage.status === 'collected'),
    command_exit_code: commandExitCode,
    invalid_records: invalidRecords,
    stages,
  };
}

module.exports = { summarizeSignalCollection };

if (require.main === module) {
  const chunks = [];
  let bytes = 0;
  process.stdin.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_BYTES) chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    const result = summarizeSignalCollection(
      bytes > MAX_BYTES ? null : Buffer.concat(chunks).toString('utf8'),
      /^\d{1,3}$/u.test(process.argv[2] ?? '') ? Number(process.argv[2]) : null,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.complete ? 0 : 1;
  });
}
