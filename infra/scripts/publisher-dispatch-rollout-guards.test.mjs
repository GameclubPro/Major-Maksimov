import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { patchPublisherDispatchEnv } from './publisher-dispatch-rollout-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const rollout = readFileSync(
  resolve(root, 'infra/scripts/vps-publisher-dispatch-rollout.sh'),
  'utf8',
);
const connect = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
const compose = readFileSync(resolve(root, 'infra/docker-compose.yml'), 'utf8');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');

const productionServices = [
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
];

function functionBlock(script, name) {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `Missing shell function: ${name}`);
  const end = script.indexOf('\n}', start);
  assert.notEqual(end, -1, `Unterminated shell function: ${name}`);
  return script.slice(start, end + 2);
}

test('ordinary dispatch Compose admission and preview enforce the persisted selection mode', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'publisher-persisted-mode-compose-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const image = `maxim-api:${'a'.repeat(40)}`;
  for (const expected of ['off', 'default-off']) {
    const original = `MAX_PUBLISHER_DISPATCH_ENABLED=false\nUNCHANGED=value\n${expected === 'off' ? 'PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=off\n' : ''}`;
    for (const drift of [false, true]) {
      const config = {
        services: Object.fromEntries(
          productionServices.map((service) => [
            service,
            {
              image,
              environment: {
                APP_SERVICE_NAME: service,
                APP_ROLE:
                  service.startsWith('api-moderation') || service === 'api-media-analysis'
                    ? 'moderation'
                    : service.slice(4),
                MAX_PUBLISHER_DISPATCH_ENABLED: 'false',
                PUBLISHER_TEMPORAL_SELECTION_ROLLOUT:
                  drift && service === 'api-admin' ? 'test' : 'off',
              },
            },
          ]),
        ),
      };
      writeFileSync(resolve(directory, 'compose.json'), JSON.stringify(config));
      writeFileSync(resolve(directory, '.env'), original);
      for (const functionName of ['verify_compose_config', 'verify_preview_compose_config']) {
        const result = spawnSync(
          'bash',
          [
            '-c',
            `set -euo pipefail
${functionBlock(rollout, functionName)}
fail() { printf '%s\\n' "$*" >&2; return 1; }
docker() { cat compose.json; }
STATE_HELPER="$PUBLISHER_TEST_STATE_HELPER"
MODE_OPERATION=''
CURRENT_ENV_CONFIGURED=true
EXPECTED_SELECTION_MODE=${expected}
EXPECTED_ROLLUP_MODE=default-off
MANIFEST_IMAGE_REF=${image}
COMPOSE_FILES=()
PREVIEW_ENV_FILE=''
trap '[[ -z "$PREVIEW_ENV_FILE" ]] || rm -f -- "$PREVIEW_ENV_FILE"' EXIT
${functionName} false
printf 'compose-verified\\n'
`,
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              PUBLISHER_TEST_STATE_HELPER: resolve(
                root,
                'infra/scripts/publisher-dispatch-rollout-state.mjs',
              ),
            },
          },
        );
        assert.equal(result.status, drift ? 1 : 0, `${expected}/${functionName}: ${result.stderr}`);
        assert.equal(readFileSync(resolve(directory, '.env'), 'utf8'), original);
      }
    }
  }
});

test('keeps publisher dispatch false by default and previews mutations unless apply is explicit', () => {
  assert.match(envExample, /^MAX_PUBLISHER_DISPATCH_ENABLED=false$/mu);
  assert.match(
    compose,
    /MAX_PUBLISHER_DISPATCH_ENABLED: \$\{MAX_PUBLISHER_DISPATCH_ENABLED:-false\}/u,
  );
  assert.match(rollout, /APPLY=0/u);
  assert.match(rollout, /if \[\[ "\$APPLY" -ne 1 \]\]; then[\s\S]*no state changed/u);
  assert.match(rollout, /Status does not accept --apply/u);
});

test('allows compatible component status without weakening the mutation source fence', () => {
  const block = functionBlock(rollout, 'verify_checkout_compatibility');
  for (const [command, compatible, expected] of [
    ['status', true, 0],
    ['status', false, 1],
    ['enable', true, 1],
    ['disable', true, 1],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${block}
fail() { return 1; }
git() { return ${compatible ? 0 : 1}; }
MANIFEST_SOURCE_SHA=${'a'.repeat(40)}
COMMAND=${command}
verify_checkout_compatibility ${'b'.repeat(40)}`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, expected, `${command}: ${result.stderr}`);
  }
});

test('renders a private false-to-true preview across all 14 env_file consumers', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'publisher-compose-preview-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const envPath = resolve(directory, '.env');
  const image = `maxim-api:${'a'.repeat(40)}`;
  const render = (contents) => {
    writeFileSync(envPath, contents, { mode: 0o600 });
    const environment = { ...process.env };
    delete environment.MAX_PUBLISHER_DISPATCH_ENABLED;
    environment.MAXIM_COMPOSE_SERVICE_ENV_FILE = envPath;
    environment.MAXIM_API_IMAGE = image;
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--env-file',
        envPath,
        '-p',
        'infra-publisher-preview-test',
        '-f',
        'infra/docker-compose.yml',
        'config',
        '--format',
        'json',
      ],
      { cwd: root, encoding: 'utf8', env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const current = render(envExample);
  const preview = render(patchPublisherDispatchEnv(envExample, true));
  for (const service of productionServices) {
    assert.equal(current.services[service].environment.MAX_PUBLISHER_DISPATCH_ENABLED, 'false');
    assert.equal(preview.services[service].environment.MAX_PUBLISHER_DISPATCH_ENABLED, 'true');
  }
});

test('serializes through the shared deploy lock and fences the exact active 14-role image', () => {
  const entrypoint = rollout.lastIndexOf('parse_args "$@"');
  assert.ok(rollout.indexOf('source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"') >= 0);
  assert.ok(rollout.indexOf('source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"') >= 0);
  assert.ok(rollout.indexOf('acquire_deploy_lock', entrypoint) > entrypoint);
  assert.match(rollout, /MAXIM_PRODUCTION_API_SERVICES\[@\][\s\S]*-eq 14/u);
  assert.match(rollout, /MANIFEST_IMAGE_ID/u);
  assert.match(rollout, /org\.opencontainers\.image\.revision/u);
  assert.match(rollout, /com\.maxim\.release-protected/u);
  assert.match(rollout, /commercial-ocr-runtime-inventory\.mjs/u);
  assert.match(rollout, /maxim_topology_verify_ocr_native_sandbox_runtime/u);
  assert.match(rollout, /reviewedAuxiliaryCount === value\.expectedAuxiliaryCount/u);
  assert.match(rollout, /maxim_topology_ocr_services_for_compose/u);
  for (const service of productionServices) {
    assert.match(rollout, new RegExp(`"${service}"`, 'u'));
  }
});

test('arms the operator pause before dotenv or runtime mutation and leaves it on failure', () => {
  const apply = functionBlock(rollout, 'apply_rollout');
  assert.ok(apply.indexOf('arm_operator_pause') < apply.indexOf('patch_dispatch_env'));
  assert.ok(apply.indexOf('patch_dispatch_env') < apply.indexOf('recreate_all_api_roles'));
  const cleanup = functionBlock(rollout, 'cleanup');
  assert.match(cleanup, /OPERATOR_PAUSE_ARMED/u);
  assert.match(cleanup, /publisher-dispatch-disable --apply/u);
  assert.doesNotMatch(cleanup, /clear_operator_pause|publisher_control clear/u);

  const execution = spawnSync(
    'bash',
    [
      '-c',
      `set +e
${cleanup}
maxim_webhook_rollout_warn_if_paused() { :; }
release_deploy_lock() { :; }
APPLY=1
OPERATOR_PAUSE_ARMED=1
ROLLOUT_COMPLETE=0
false
cleanup`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /operator pause remains armed/u);
  assert.match(execution.stderr, /publisher-dispatch-disable --apply/u);
});

test('re-arms the operator pause from cleanup after a post-clear interruption', () => {
  const cleanup = functionBlock(rollout, 'cleanup');
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `set +e
${cleanup}
rearm_calls=0
best_effort_rearm_operator_pause() {
  rearm_calls=$((rearm_calls + 1))
  OPERATOR_PAUSE_ARMED=1
  return 0
}
maxim_webhook_rollout_warn_if_paused() { :; }
release_deploy_lock() { :; }
APPLY=1
OPERATOR_PAUSE_ARMED=0
POST_CLEAR_REARM_REQUIRED=1
ROLLOUT_COMPLETE=0
false
cleanup
cleanup_status=$?
printf 'status=%s rearm=%s flag=%s armed=%s\n' \
  "$cleanup_status" "$rearm_calls" "$POST_CLEAR_REARM_REQUIRED" "$OPERATOR_PAUSE_ARMED"`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /status=1 rearm=1 flag=0 armed=1/u);
  assert.match(execution.stderr, /operator pause remains armed/u);
});

test('reports an unconfirmed pause when post-clear cleanup cannot re-arm it', () => {
  const cleanup = functionBlock(rollout, 'cleanup');
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `set +e
${cleanup}
best_effort_rearm_operator_pause() { OPERATOR_PAUSE_ARMED=1; return 1; }
maxim_webhook_rollout_warn_if_paused() { :; }
release_deploy_lock() { :; }
APPLY=1
OPERATOR_PAUSE_ARMED=0
POST_CLEAR_REARM_REQUIRED=1
ROLLOUT_COMPLETE=0
false
cleanup`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /operator pause could not be confirmed/u);
  assert.doesNotMatch(execution.stderr, /operator pause remains armed/u);
});

test('reuses webhook quiescence and the reviewed wave order without builds or migrations', () => {
  const recreate = functionBlock(rollout, 'recreate_all_api_roles');
  const calls = [
    'maxim_webhook_quiesce_for_api_rollout',
    '"action and publisher"',
    '"admin"',
    '"ingress"',
    '"media analysis"',
    '"moderation"',
    '"enqueue"',
    'maxim_webhook_assert_api_rollout_quiescence',
  ].map((needle) => recreate.indexOf(needle));
  assert.ok(calls.every((index) => index >= 0));
  assert.deepEqual(
    calls,
    [...calls].sort((left, right) => left - right),
  );
  assert.match(rollout, /up -d --no-deps --no-build --pull never[\s\\]+--force-recreate/u);
  assert.doesNotMatch(rollout, /docker (?:build|buildx)|prisma migrate|migrate deploy/u);
  assert.doesNotMatch(
    rollout,
    /up[^\n]*(?:postgres|redis)|force-recreate[^\n]*(?:postgres|redis)/u,
  );
  assert.doesNotMatch(rollout, /MAX_API_GLOBAL_RPS|30 rps|30 RPS/iu);
  assert.match(rollout, /maxim_topology_verify_api_commercial_ocr_version/u);
  assert.match(rollout, /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u);
});

test('attests fixed-output identity before enabling heartbeat and clears only owned pause', () => {
  const apply = functionBlock(rollout, 'apply_rollout');
  const probe = apply.indexOf('run_publisher_identity_probe');
  const clear = apply.indexOf('clear_operator_pause', probe);
  const enabledHeartbeat = apply.indexOf('wait_for_heartbeat true', clear);
  assert.ok(probe >= 0 && probe < clear && clear < enabledHeartbeat);
  assert.match(rollout, /apps\/api\/dist\/apps\/api\/src\/scripts\/attest-publisher-identity\.js/u);
  assert.match(rollout, /PUBLISHER_IDENTITY_ATTESTED/u);
  assert.match(rollout, /\[\[ "\$output" == "\$PUBLISHER_IDENTITY_PROBE_SUCCESS" \]\]/u);
  assert.match(
    rollout,
    /IDENTITY_PROBE_TIMEOUT_SEC="\$\{MAXIM_PUBLISHER_IDENTITY_PROBE_TIMEOUT_SEC:-20\}"/u,
  );
  const probeBlock = functionBlock(rollout, 'run_publisher_identity_probe');
  assert.match(probeBlock, /"\$\{IDENTITY_PROBE_TIMEOUT_SEC\}s"/u);
  assert.doesNotMatch(probeBlock, /"\$\{COMMAND_TIMEOUT_SEC\}s"/u);
  assert.match(rollout, /wait_for_heartbeat false[\s\S]*maxim_webhook_resume_after_api_fence/u);
});

test('rejects identity probe budgets below both sequential MAX request deadlines', () => {
  const limits = functionBlock(rollout, 'require_operational_limits');
  assert.match(limits, /IDENTITY_PROBE_TIMEOUT_SEC < 20/u);
  assert.match(limits, /IDENTITY_PROBE_TIMEOUT_SEC > 120/u);
  assert.match(limits, /between 20 and 120 seconds/u);
});

test('uses production-safe configurable rollout budgets and rejects the old command timeout', () => {
  assert.match(
    rollout,
    /READINESS_TIMEOUT_SEC="\$\{MAXIM_PUBLISHER_ROLLOUT_READINESS_TIMEOUT_SEC:-600\}"/u,
  );
  assert.match(
    rollout,
    /STABILITY_WINDOW_SEC="\$\{MAXIM_PUBLISHER_ROLLOUT_STABILITY_WINDOW_SEC:-30\}"/u,
  );
  assert.match(
    rollout,
    /COMMAND_TIMEOUT_SEC="\$\{MAXIM_PUBLISHER_ROLLOUT_COMMAND_TIMEOUT_SEC:-30\}"/u,
  );

  const limits = functionBlock(rollout, 'require_operational_limits');
  const execute = (commandTimeout, readinessTimeout = 600) =>
    spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${limits}
fail() { printf '%s\\n' "$1" >&2; return 1; }
READINESS_TIMEOUT_SEC=${readinessTimeout}
STABILITY_WINDOW_SEC=30
COMMAND_TIMEOUT_SEC=${commandTimeout}
IDENTITY_PROBE_TIMEOUT_SEC=20
require_operational_limits
printf '%s|%s|%s\\n' "$READINESS_TIMEOUT_SEC" "$STABILITY_WINDOW_SEC" "$COMMAND_TIMEOUT_SEC"`,
      ],
      { encoding: 'utf8' },
    );

  const accepted = execute(30);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.trim(), '600|30|30');
  const rejected = execute(10);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /control\/docker command timeout must be between 20 and 120/u);
  const tooShort = execute(30, 159);
  assert.notEqual(tooShort.status, 0);
  assert.match(tooShort.stderr, /readiness timeout is too short/u);
});

test('requires continuously green endpoints and an unchanged signature for the whole window', () => {
  const waitForReadiness = functionBlock(rollout, 'wait_for_api_readiness');
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${waitForReadiness}
endpoint_calls=0
diagnostic_calls=0
all_api_readiness_endpoints_ready() {
  endpoint_calls=$((endpoint_calls + 1))
  [[ "$endpoint_calls" -ne 3 ]]
}
api_runtime_signature() { printf '%s\\n' 'api-ingress|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|0'; }
emit_api_readiness_timeout_diagnostics() { diagnostic_calls=$((diagnostic_calls + 1)); }
fail() { printf '%s\\n' "$1" >&2; return 1; }
sleep() { SECONDS=$((SECONDS + $1)); }
READINESS_TIMEOUT_SEC=12
STABILITY_WINDOW_SEC=3
SECONDS=0
wait_for_api_readiness
printf 'endpoint_calls=%s diagnostics=%s\\n' "$endpoint_calls" "$diagnostic_calls"`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 0, execution.stderr);
  const endpointCalls = Number(execution.stdout.match(/endpoint_calls=(\d+)/u)?.[1]);
  assert.ok(endpointCalls >= 5, execution.stdout);
  assert.match(execution.stdout, /diagnostics=0/u);
});

test('emits bounded diagnostics only after the continuous-readiness deadline', () => {
  const waitForReadiness = functionBlock(rollout, 'wait_for_api_readiness');
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${waitForReadiness}
diagnostic_calls=0
all_api_readiness_endpoints_ready() { return 1; }
api_runtime_signature() { return 1; }
emit_api_readiness_timeout_diagnostics() {
  diagnostic_calls=$((diagnostic_calls + 1))
  printf '%s\\n' timeout-diagnostic
}
fail() { printf '%s\\n' "$1" >&2; return 1; }
sleep() { SECONDS=$((SECONDS + $1)); }
READINESS_TIMEOUT_SEC=3
STABILITY_WINDOW_SEC=2
SECONDS=0
set +e
wait_for_api_readiness
status=$?
set -e
printf 'status=%s diagnostics=%s\\n' "$status" "$diagnostic_calls"`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /^timeout-diagnostic$/mu);
  assert.match(execution.stdout, /status=1 diagnostics=1/u);

  const diagnosticsStart = rollout.indexOf('readiness_diagnostic_javascript() {');
  const diagnosticsEnd = rollout.indexOf('\nemit_api_readiness_endpoint_diagnostic() {');
  assert.ok(diagnosticsStart >= 0 && diagnosticsEnd > diagnosticsStart);
  const diagnostics = rollout.slice(diagnosticsStart, diagnosticsEnd);
  assert.match(rollout, /READINESS_DIAGNOSTIC_MAX_BYTES=262144/u);
  assert.match(diagnostics, /httpStatus/u);
  assert.match(diagnostics, /effectiveLagSec/u);
  assert.match(diagnostics, /behaviorIdentity\?\.state/u);
  assert.match(diagnostics, /response\.body\.getReader\(\)/u);
  assert.match(diagnostics, /reader\.cancel\(\)/u);
  assert.doesNotMatch(diagnostics, /response\.text\(\)/u);
  assert.doesNotMatch(diagnostics, /\.bots|oldestQueuedEventId|oldestReceivedEventId/u);
});

test('rejects a green readiness sample that completes after the deadline', () => {
  const waitForReadiness = functionBlock(rollout, 'wait_for_api_readiness');
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${waitForReadiness}
endpoint_calls=0
diagnostic_calls=0
all_api_readiness_endpoints_ready() {
  endpoint_calls=$((endpoint_calls + 1))
  [[ "$endpoint_calls" -eq 1 ]] || SECONDS=$((SECONDS + 3))
  return 0
}
api_runtime_signature() { printf '%s\n' 'api-ingress|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|0'; }
emit_api_readiness_timeout_diagnostics() { diagnostic_calls=$((diagnostic_calls + 1)); }
fail() { return 1; }
sleep() { SECONDS=$((SECONDS + $1)); }
READINESS_TIMEOUT_SEC=3
READINESS_PROBE_MAX_SEC=1
STABILITY_WINDOW_SEC=1
POST_CLEAR_REARM_REQUIRED=0
SECONDS=0
set +e
wait_for_api_readiness
status=$?
set -e
printf 'status=%s endpoints=%s diagnostics=%s\n' \
  "$status" "$endpoint_calls" "$diagnostic_calls"`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /status=1 endpoints=2 diagnostics=1/u);
});

test('skips slow diagnostics until a post-clear caller can re-arm the pause', () => {
  const waitForReadiness = functionBlock(rollout, 'wait_for_api_readiness');
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${waitForReadiness}
diagnostic_calls=0
all_api_readiness_endpoints_ready() { return 1; }
emit_api_readiness_timeout_diagnostics() { diagnostic_calls=$((diagnostic_calls + 1)); }
fail() { return 1; }
sleep() { SECONDS=$((SECONDS + $1)); }
READINESS_TIMEOUT_SEC=2
READINESS_PROBE_MAX_SEC=1
STABILITY_WINDOW_SEC=1
POST_CLEAR_REARM_REQUIRED=1
SECONDS=0
set +e
wait_for_api_readiness
status=$?
set -e
printf 'status=%s diagnostics=%s\n' "$status" "$diagnostic_calls"`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /status=1 diagnostics=0/u);
});

test('re-arms a guarded operator pause when post-enable stability fails', () => {
  const apply = functionBlock(rollout, 'apply_rollout');
  const rearm = functionBlock(rollout, 'best_effort_rearm_operator_pause');
  assert.match(rearm, /publisher_control arm-disable/u);
  assert.match(rearm, /OPERATOR_PAUSE_ARMED=1/u);
  const clear = apply.indexOf('clear_operator_pause');
  const cleanupGuard = apply.indexOf('POST_CLEAR_REARM_REQUIRED=1');
  const heartbeat = apply.indexOf('wait_for_heartbeat true', clear);
  const stability = apply.indexOf('wait_for_api_readiness', heartbeat);
  const finalRuntime = apply.indexOf('verify_runtime "$DESIRED_STATE"', stability);
  const rearmCall = apply.indexOf('best_effort_rearm_operator_pause', finalRuntime);
  assert.ok(
    cleanupGuard >= 0 &&
      cleanupGuard < clear &&
      clear >= 0 &&
      clear < heartbeat &&
      heartbeat < stability &&
      stability < finalRuntime &&
      finalRuntime < rearmCall,
  );

  const execute = (failAt) =>
    spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${apply}
ROOT_DIR=/fixture
maxim_require_ordinary_effect_authority() { return 0; }
events=()
runtime_verifications=0
arm_operator_pause() { events+=(arm); }
patch_dispatch_env() { events+=(patch); }
verify_compose_config() { :; }
maxim_topology_require_api_commercial_ocr_version_config() { :; }
maxim_topology_require_media_analysis_rollout_config() { :; }
recreate_all_api_roles() { events+=(recreate); }
verify_runtime() {
  runtime_verifications=$((runtime_verifications + 1))
  events+=("runtime:$runtime_verifications")
  [[ "$FAIL_AT" != runtime || "$runtime_verifications" -lt 3 ]]
}
wait_for_url() { :; }
wait_for_heartbeat() {
  events+=("heartbeat:$1")
  [[ "$FAIL_AT" != heartbeat || "$1" != true ]]
}
maxim_webhook_resume_after_api_fence() { :; }
run_health_smokes() { events+=(initial-stability); }
maxim_topology_verify_api_commercial_ocr_version() { :; }
maxim_topology_smoke_media_analysis_tesseract() { :; }
run_publisher_identity_probe() { events+=(identity); }
clear_operator_pause() { events+=(clear); }
wait_for_api_readiness() {
  events+=(post-enable-stability)
  [[ "$FAIL_AT" != readiness ]]
}
best_effort_rearm_operator_pause() { events+=(rearm); }
COMMAND=enable
DESIRED_STATE=true
EXPECTED_OCR_VERSION=ocr-v1
RECONCILE_ONLY=0
ROLLOUT_COMPLETE=0
MANIFEST_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
set +e
apply_rollout
status=$?
set -e
printf 'status=%s complete=%s events=%s\\n' "$status" "$ROLLOUT_COMPLETE" "\${events[*]}"`,
      ],
      { encoding: 'utf8', env: { ...process.env, FAIL_AT: failAt } },
    );

  const heartbeatFailure = execute('heartbeat');
  assert.equal(heartbeatFailure.status, 0, heartbeatFailure.stderr);
  assert.match(heartbeatFailure.stdout, /status=1 complete=0/u);
  assert.match(heartbeatFailure.stdout, /identity clear heartbeat:true rearm/u);
  assert.doesNotMatch(heartbeatFailure.stdout, /post-enable-stability/u);

  const readinessFailure = execute('readiness');
  assert.equal(readinessFailure.status, 0, readinessFailure.stderr);
  assert.match(readinessFailure.stdout, /status=1 complete=0/u);
  assert.match(
    readinessFailure.stdout,
    /initial-stability runtime:2 identity clear heartbeat:true post-enable-stability rearm/u,
  );

  const runtimeFailure = execute('runtime');
  assert.equal(runtimeFailure.status, 0, runtimeFailure.stderr);
  assert.match(runtimeFailure.stdout, /status=1 complete=0/u);
  assert.match(
    runtimeFailure.stdout,
    /clear heartbeat:true post-enable-stability runtime:3 rearm/u,
  );
});

test('requires publisher secrets only for enable and exposes guarded wrapper commands', () => {
  const preflight = functionBlock(rollout, 'rollout_preflight');
  assert.match(
    preflight,
    /if \[\[ "\$COMMAND" == "enable" \]\]; then[\s\S]*maxim_topology_require_publisher_secret_files/u,
  );
  assert.match(connect, /publisher-dispatch-enable \[--apply\]/u);
  assert.match(connect, /publisher-dispatch-disable \[--apply\]/u);
  assert.match(connect, /publisher-dispatch-status/u);
  const wrapper = functionBlock(connect, 'publisher_dispatch_command');
  assert.match(wrapper, /vps-publisher-dispatch-rollout\.sh/u);
  assert.match(wrapper, /if \[\[ "\$apply" == "--apply" \]\]/u);
});

test('fixed disable recovery adopts both owned fences and tolerates stopped reviewed workers', () => {
  const wrapper = functionBlock(connect, 'publisher_dispatch_command');
  assert.match(
    wrapper,
    /action" == "disable" && "\$apply" == "--apply"[\s\S]*MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1/u,
  );
  const preflight = functionBlock(rollout, 'rollout_preflight');
  assert.match(
    preflight,
    /MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE[\s\S]*runtime_state_policy=allow-stopped/u,
  );
  const control = functionBlock(rollout, 'publisher_control');
  assert.match(control, /run --rm --no-deps --pull never -T/u);
  assert.match(control, /api-action node -e "\$helper_source" -- "\$action" <\/dev\/null/u);
  assert.match(control, /docker exec -i[\s\S]*"\$admin_id" node - "\$action"/u);
  assert.match(control, /--interactive=false/u);
  assert.match(control, /decodeControlResponse/u);
});

test('reconciles an already exact disabled runtime without recreating API roles', () => {
  const preflight = functionBlock(rollout, 'rollout_preflight');
  assert.match(
    preflight,
    /COMMAND" == "disable"[\s\S]*CURRENT_ENV_STATE" == "false"[\s\S]*verify_runtime false[\s\S]*RECONCILE_ONLY=1/u,
  );

  const apply = functionBlock(rollout, 'apply_rollout');
  const execute = (failAt) =>
    spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${apply}
ROOT_DIR=/fixture
maxim_require_ordinary_effect_authority() { return 0; }
events=()
runtime_calls=0
heartbeat_calls=0
fail() { return 1; }
arm_operator_pause() { events+=(arm); }
patch_dispatch_env() { events+=(patch); }
verify_compose_config() { events+=(compose); }
maxim_topology_require_api_commercial_ocr_version_config() { events+=(ocr-config); }
maxim_topology_require_media_analysis_rollout_config() { events+=(ocr-rollout-config); }
recreate_all_api_roles() { events+=(recreate); }
verify_runtime() {
  runtime_calls=$((runtime_calls + 1))
  events+=("runtime:$runtime_calls")
  [[ "$FAIL_AT" != runtime || "$runtime_calls" -lt 3 ]]
}
wait_for_url() { events+=(live); }
wait_for_heartbeat() {
  heartbeat_calls=$((heartbeat_calls + 1))
  events+=("heartbeat:$heartbeat_calls:$1")
  [[ "$FAIL_AT" != heartbeat || "$heartbeat_calls" -lt 2 ]]
}
maxim_webhook_resume_after_api_fence() { events+=(resume); }
run_health_smokes() { events+=(health); }
maxim_topology_verify_api_commercial_ocr_version() { events+=(ocr-version); }
maxim_topology_smoke_media_analysis_tesseract() { events+=(ocr-smoke); }
clear_operator_pause() { events+=(clear); }
best_effort_rearm_operator_pause() { events+=(rearm); return 0; }
COMMAND=disable
DESIRED_STATE=false
EXPECTED_OCR_VERSION=ocr-v1
RECONCILE_ONLY=1
POST_CLEAR_REARM_REQUIRED=0
ROLLOUT_COMPLETE=0
MANIFEST_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
set +e
apply_rollout
status=$?
set -e
printf 'status=%s complete=%s flag=%s events=%s\n' \
  "$status" "$ROLLOUT_COMPLETE" "$POST_CLEAR_REARM_REQUIRED" "\${events[*]}"`,
      ],
      { encoding: 'utf8', env: { ...process.env, FAIL_AT: failAt } },
    );

  const success = execute('none');
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /status=0 complete=1 flag=0/u);
  assert.match(success.stdout, /reconcile_only=true/u);
  assert.doesNotMatch(success.stdout, /\b(?:patch|recreate|resume|rearm)\b/u);
  assert.match(success.stdout, /arm compose ocr-config ocr-rollout-config runtime:1/u);
  assert.match(
    success.stdout,
    /health runtime:2 ocr-version ocr-smoke clear heartbeat:2:false runtime:3/u,
  );

  for (const failAt of ['heartbeat', 'runtime']) {
    const failure = execute(failAt);
    assert.equal(failure.status, 0, failure.stderr);
    assert.match(failure.stdout, /status=1 complete=0 flag=0/u);
    assert.match(failure.stdout, /clear[\s\S]*rearm/u);
  }
});

test('does not claim stale operator ownership after clear restores an authorization pause', () => {
  const clear = functionBlock(rollout, 'clear_operator_pause');
  const ownershipDrop = clear.indexOf('OPERATOR_PAUSE_ARMED=0');
  const enableValidation = clear.indexOf('if [[ "$COMMAND" == "enable" ]]');
  assert.ok(ownershipDrop >= 0 && ownershipDrop < enableValidation);
});

test('never prints or passes publisher token material through the rollout CLI', () => {
  assert.doesNotMatch(rollout, /MAX_PUBLISHER_BOT_TOKEN(?:_FILE)?/u);
  assert.doesNotMatch(rollout, /(?:^|[/ ])token(?:$|[ ."'])/imu);
  assert.doesNotMatch(
    rollout,
    /publik-bot-token|publik-webhook\.json|publik-init-data-keys\.json|publik-dialog-signing-keys\.json/u,
  );
  assert.doesNotMatch(rollout, /docker inspect[^\n]*Config\.Env[^|\n]*$/mu);
  assert.match(rollout, /container_env_summary/u);
});
