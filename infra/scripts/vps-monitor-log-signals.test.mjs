import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const monitor = readFileSync(resolve(root, 'infra/scripts/vps-monitor-readonly.sh'), 'utf8');

function readRateLimitPattern() {
  const match = /count '([^']*rate\[[^']+)'/u.exec(monitor);
  assert.ok(match?.[1], 'monitor rate-limit signal pattern is missing');
  return match[1];
}

function readSuccessfulAccessLogPattern() {
  const match = /^SUCCESSFUL_ACCESS_LOG_PATTERN='([^']+)'$/mu.exec(monitor);
  assert.ok(match?.[1], 'monitor successful access-log pattern is missing');
  return match[1];
}

function readRuntimePressureCommand() {
  const functionStart = monitor.indexOf('summarize_runtime_pressure() {');
  assert.notEqual(functionStart, -1, 'runtime pressure function is missing');
  const commandStartMarker = "remote_command=$(cat <<'REMOTE'\n";
  const commandStart = monitor.indexOf(commandStartMarker, functionStart);
  const commandEnd = monitor.indexOf('\nREMOTE\n', commandStart);
  assert.notEqual(commandStart, -1, 'runtime pressure command is missing');
  assert.notEqual(commandEnd, -1, 'runtime pressure command terminator is missing');
  return monitor.slice(commandStart + commandStartMarker.length, commandEnd);
}

function readFunction(name) {
  const match = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, 'mu').exec(monitor);
  assert.ok(match?.[1], `${name} function is missing`);
  return `${name}() {\n${match[1]}}\n`;
}

function countSignals(lines) {
  const result = spawnSync('grep', ['-Eci', readRateLimitPattern()], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return Number.parseInt(result.stdout.trim() || '0', 10);
}

function filterSuccessfulAccessLogs(lines) {
  const result = spawnSync('grep', ['-Eav', readSuccessfulAccessLogPattern()], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n');
}

test('does not count epoch timestamps containing 429 as rate-limit signals', () => {
  assert.equal(
    countSignals([
      '{"level":30,"time":1784429457196,"statusCode":200,"msg":"request completed"}',
      '{"level":30,"time":1784429429000,"statusCode":204,"msg":"request completed"}',
    ]),
    0,
  );
});

test('counts explicit internal, structured, and HTTP 429 rate-limit signals', () => {
  assert.equal(
    countSignals([
      'MAX API internal limiter rejected request before dispatch',
      '{"statusCode":429,"msg":"request completed"}',
      'upstream returned HTTP status 429',
    ]),
    3,
  );
});

test('filters successful static access logs before scanning error-like asset names', () => {
  assert.equal(
    [...monitor.matchAll(/grep -Eav '\$\{SUCCESSFUL_ACCESS_LOG_PATTERN\}'/gu)].length,
    2,
  );
  assert.deepEqual(
    filterSuccessfulAccessLogs([
      'GET /app/assets/api-request-error-hash.js HTTP/1.1" 200 723',
      'GET /app/assets/warn-icon.svg HTTP/1.1" 304 0',
      'GET /app/assets/api-request-error-hash.js HTTP/1.1" 502 157',
      'nginx: [error] upstream prematurely closed connection',
    ]),
    [
      'GET /app/assets/api-request-error-hash.js HTTP/1.1" 502 157',
      'nginx: [error] upstream prematurely closed connection',
    ],
  );
});

test('serializes full-fleet readonly monitors before production sampling', () => {
  const lockIndex = monitor.indexOf('flock -n "$MONITOR_LOCK_FD"');
  const sampleIndex = monitor.lastIndexOf('if run_monitor_with_capacity_sampler; then');

  assert.notEqual(lockIndex, -1, 'monitor process lock is missing');
  assert.notEqual(sampleIndex, -1, 'monitor entrypoint is missing');
  assert.ok(lockIndex < sampleIndex, 'monitor lock must be acquired before the first sample');
  assert.match(monitor, /start_capacity_sampler "\$end_at"[\s\S]*start_monitor_worker "\$end_at"/u);
  assert.match(monitor, /start_monitor_worker "\$end_at"[\s\S]*wait "\$MONITOR_WORKER_PID"/u);
  assert.match(monitor, /MAXIM_MONITOR_LOCK_FILE/u);
  assert.match(monitor, /exec \{MONITOR_LOCK_FD\}>>"\$MONITOR_LOCK_FILE"/u);
  assert.doesNotMatch(monitor, /exec \{MONITOR_LOCK_FD\}>"\$MONITOR_LOCK_FILE"/u);
  assert.match(monitor, /Another readonly VPS monitor already holds/u);
});

test('uses successful remote cursors and reports bounded log saturation', () => {
  assert.match(monitor, /monitor_service_log_cursor_sec=\\\$scan_cursor_sec/u);
  assert.match(monitor, /monitor_static_log_cursor_sec=\\\$scan_cursor_sec/u);
  assert.match(monitor, /LAST_SERVICE_LOG_SCAN_AT_SEC="\$cursor_sec"/u);
  assert.match(monitor, /LAST_STATIC_LOG_SCAN_AT_SEC="\$cursor_sec"/u);
  assert.match(monitor, /logs --since "\$since_at"/u);
  assert.match(monitor, /WARN: could not read logs for \\\$service/u);
  assert.match(monitor, /exit "\\\$failed"/u);
  assert.doesNotMatch(monitor, /logs --since "\$\{INTERVAL_SEC\}s"/u);
  assert.match(monitor, /LOG_REQUEST_LINES=\$\(\(TAIL_LINES \+ 1\)\)/u);
  assert.equal([...monitor.matchAll(/log scan saturated=true service=\\\$service/gu)].length, 2);
  for (const [functionName, cursor] of [
    ['scan_service_logs', 'LAST_SERVICE_LOG_SCAN_AT_SEC'],
    ['summarize_static_services', 'LAST_STATIC_LOG_SCAN_AT_SEC'],
  ]) {
    const source = readFunction(functionName);
    assert.ok(source.indexOf('if ((status != 0))') < source.indexOf(`${cursor}="$cursor_sec"`));
  }
  const bullMqStart = monitor.indexOf('summarize_bullmq_state() {');
  const bullMqEnd = monitor.indexOf('\nsummarize_redis_runtime() {', bullMqStart);
  assert.notEqual(bullMqStart, -1, 'BullMQ monitor function is missing');
  assert.notEqual(bullMqEnd, -1, 'BullMQ monitor function terminator is missing');
  const bullMqSource = monitor.slice(bullMqStart, bullMqEnd);
  assert.match(bullMqSource, /previous_probe_at_ms/u);
  assert.match(bullMqSource, /monitor_bullmq_cursor_ms/u);
  assert.match(bullMqSource, /if ! counts="\$\(redis-cli/u);
  assert.doesNotMatch(bullMqSource, /redis-cli[^\n]+\|\| true/u);
  assert.ok(
    bullMqSource.indexOf('if ((status != 0))') <
      bullMqSource.indexOf('LAST_BULLMQ_PROBE_AT_MS="$cursor_ms"'),
  );
});

test('adds privacy-safe semantic, Publisher, and media-analysis readiness to every sample', () => {
  assert.match(monitor, /run_step semantic-health summarize_local_ready_health/u);
  const semanticHealth = readFunction('summarize_local_ready_health');
  assert.match(semanticHealth, /vps-connect\.sh exec 'node -'/u);
  assert.match(semanticHealth, /< "\$ROOT_DIR\/infra\/scripts\/monitor-ready-status\.cjs"/u);
  assert.doesNotMatch(semanticHealth, /node infra\/scripts\/monitor-ready-status\.cjs/u);
  assert.doesNotMatch(semanticHealth, /curl -f/u);
  assert.match(monitor, /run_step publisher-runtime summarize_publisher_runtime/u);
  assert.match(monitor, /monitor-publisher-status\.cjs/u);
  assert.match(monitor, /read_expected api-admin/u);
  assert.match(monitor, /read_expected api-publisher/u);
  assert.match(monitor, /read_bot_id api-admin/u);
  assert.match(monitor, /read_bot_id api-publisher/u);
  assert.match(monitor, /bot_id_parity/u);
  assert.match(monitor, /admin_bot_id="\$\(read_bot_id api-admin\)" \|\| exit 1/u);
  assert.match(monitor, /publisher_bot_id="\$\(read_bot_id api-publisher\)" \|\| exit 1/u);
  assert.match(
    monitor,
    /\[\[ -n "\$admin_bot_id" && "\$admin_bot_id" == "\$publisher_bot_id" \]\]/u,
  );
  assert.doesNotMatch(monitor, /exec -T -e MAX_PUBLISHER_BOT_ID=/u);
  assert.match(monitor, /run_step media-analysis-ready summarize_media_analysis_ready/u);
  assert.match(monitor, /monitor-media-ready\.cjs/u);
  assert.doesNotMatch(monitor, /fingerprintSha256=/u);
});

test('reports only allowlisted Redis pressure and persistence fields', () => {
  assert.match(monitor, /run_step redis-runtime summarize_redis_runtime/u);
  assert.match(monitor, /redis-cli --raw INFO all/u);
  assert.match(monitor, /set -o pipefail/u);
  assert.match(monitor, /monitor-redis-info\.cjs/u);
  assert.doesNotMatch(monitor, /redis-cli --raw (KEYS|SCAN|HGETALL)/u);
});

test('reports the hard deploy free-space floor independently from percentage warnings', () => {
  const command = readRuntimePressureCommand();

  assert.match(monitor, /source "\$ROOT_DIR\/infra\/scripts\/lib\/deploy-disk-capacity\.sh"/u);
  assert.match(monitor, /printf -v disk_capacity_env 'MAXIM_API_BUILD_HARD_MIN_FREE_BYTES=%q\\n'/u);
  assert.match(monitor, /remote_command="\$disk_capacity_env\$remote_command"/u);
  assert.doesNotMatch(command, /source infra\/scripts\/lib\/deploy-disk-capacity\.sh/u);
  assert.match(
    command,
    /deploy_disk_hard_minimum_free_bytes="\$MAXIM_API_BUILD_HARD_MIN_FREE_BYTES"/u,
  );
  assert.match(command, /df -P -B1/u);
  assert.match(command, /API_BUILD_DISK_BLOCKED/u);
  assert.match(command, /disk_available_bytes < deploy_disk_hard_minimum_free_bytes/u);
  assert.doesNotMatch(command, /MAXIM_ALLOW_CRITICAL_DISK_DEPLOY/u);
});

function summaryFixture(t, dockerSource) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-log-summary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(resolve(directory, 'infra/scripts'), { recursive: true });
  mkdirSync(resolve(directory, 'bin'));
  writeFileSync(
    resolve(directory, 'infra/scripts/vps-connect.sh'),
    '#!/usr/bin/env bash\n[[ "$1" == exec ]] || exit 99\nshift\nexec bash -c "$1"\n',
    { mode: 0o700 },
  );
  writeFileSync(resolve(directory, 'bin/docker'), `#!/usr/bin/env bash\n${dockerSource}\n`, {
    mode: 0o700,
  });
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
LOG_SERVICES=(broken empty healthy capped)
TAIL_LINES=2
SIGNAL_WINDOW_MIN=30
${readFunction('summarize_log_signal_counts')}
summarize_log_signal_counts
`,
    ],
    {
      cwd: directory,
      env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}` },
      encoding: 'utf8',
    },
  );
}

test('log summary distinguishes read failures, empty success and capped observations', (t) => {
  const result = summaryFixture(
    t,
    `case "\${*: -1}" in
  broken) echo 'private error details' >&2; exit 7 ;;
  empty) exit 0 ;;
  healthy) echo '{"level":40,"msg":"internal limiter"}' ;;
  capped) printf '%s\\n' '{"level":40}' '{"level":40}' '{"level":50}' ;;
esac`,
  );
  assert.equal(result.status, 1, result.stderr);
  const [header, ...rows] = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.split('\t'));
  const values = Object.fromEntries(
    rows.map((row) => [row[0], Object.fromEntries(header.map((key, i) => [key, row[i]]))]),
  );
  assert.equal(values.broken.level40_50, 'unknown');
  assert.equal(values.broken.read_status, 'read_failed');
  assert.equal(values.empty.level40_50, '0');
  assert.equal(values.empty.read_status, 'collected');
  assert.equal(values.empty.truncated, 'false');
  assert.equal(values.healthy.rate_limit, '1');
  assert.equal(values.capped.level40_50, '2');
  assert.equal(values.capped.truncated, 'true');
  assert.equal(values.capped.counts_are_lower_bounds, 'true');
  assert.doesNotMatch(result.stdout + result.stderr, /private error details/u);
});

test('full samples retain later steps and explicitly report incomplete collection', () => {
  const functions = [
    'summarize_local_ready_health',
    'summarize_publisher_runtime',
    'summarize_media_analysis_ready',
    'summarize_real_chat_signals',
    'summarize_bullmq_state',
    'summarize_redis_runtime',
    'summarize_runtime_pressure',
    'summarize_static_services',
    'summarize_log_signal_counts',
    'scan_service_logs',
    'summarize_public_app_assets',
    'summarize_public_access_guards',
  ];
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
SAMPLE_STEP_COUNT=0
SAMPLE_STEP_FAILURES=0
EXPECTED_SAMPLE_STEPS=16
PUBLIC_URL=https://example.invalid
${readFunction('run_step')}
${readFunction('sample_once')}
${functions.map((name) => `${name}() { return 0; }`).join('\n')}
function ./infra/scripts/vps-connect.sh { [[ "$1" != health ]]; }
curl() { return 0; }
sample_once 4
`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /monitor_step label=health phase=end exit=1 complete=false/u);
  assert.match(
    result.stdout,
    /monitor_step label=public-access-guards phase=end exit=0 complete=true/u,
  );
  assert.match(
    result.stdout,
    /monitor_sample index=4 steps=16 expected_steps=16 failed_steps=1 complete=false/u,
  );
});

test('actual signal caller preserves partial observations and both command and collection failures', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-signal-collection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(resolve(directory, 'infra/scripts'), { recursive: true });
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
  const outputFile = resolve(directory, 'reports.jsonl');
  writeFileSync(
    resolve(directory, 'infra/scripts/vps-connect.sh'),
    '#!/usr/bin/env bash\ncat "$MOCK_SIGNAL_OUTPUT"\nexit "$MOCK_SIGNAL_EXIT"\n',
    { mode: 0o700 },
  );
  for (const [input, commandExit, expectedExit] of [
    [[first], 7, 7],
    [[first], 0, 1],
    [[first, second], 0, 0],
  ]) {
    writeFileSync(outputFile, input.map((value) => JSON.stringify(value)).join('\n') + '\n');
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
SIGNAL_WINDOW_MIN=30
${readFunction('summarize_real_chat_signals')}
summarize_real_chat_signals
`,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          ROOT_DIR: root,
          MOCK_SIGNAL_OUTPUT: outputFile,
          MOCK_SIGNAL_EXIT: String(commandExit),
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, expectedExit, result.stderr);
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(records.slice(0, -1), input);
    const envelope = records.at(-1);
    assert.equal(envelope.audit, 'monitor_signal_collection');
    assert.equal(envelope.complete, expectedExit === 0);
    assert.equal(envelope.command_exit_code, commandExit);
    assert.deepEqual(
      envelope.stages.map((stage) => stage.status),
      ['collected', input.length === 2 ? 'collected' : 'missing'],
    );
  }
});
