import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const rollout = readFileSync(resolve(root, 'infra/scripts/vps-commercial-ocr-rollout.sh'), 'utf8');
const admissionDrainProbe = readFileSync(
  resolve(root, 'infra/scripts/commercial-ocr-admission-drain-probe.cjs'),
  'utf8',
);
const connect = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
const topology = readFileSync(resolve(root, 'infra/scripts/lib/deploy-topology.sh'), 'utf8');
const compose = readFileSync(resolve(root, 'infra/docker-compose.yml'), 'utf8');

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
const producerServices = [
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
];
const httpReadyServices = ['api-ingress', 'api-admin', 'api-media-analysis'];

function callIndex(call, from = 0) {
  const index = rollout.indexOf(call, from);
  assert.notEqual(index, -1, `Missing rollout call: ${call}`);
  return index;
}

function readShellArray(source, name) {
  const match = new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, 'mu').exec(source);
  assert.ok(match, `Missing shell array: ${name}`);
  return [...match[1].matchAll(/^\s+"([^"]+)"\s*$/gmu)].map((item) => item[1]);
}

function readComposeServiceBlock(source, name) {
  const marker = `\n  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Missing Compose service: ${name}`);
  const nextService = /\n {2}[a-z0-9][a-z0-9-]*:\n/gu;
  nextService.lastIndex = start + marker.length;
  const next = nextService.exec(source);
  return source.slice(start + 1, next?.index ?? source.length);
}

test('serializes rollout with the shared deploy lock and keeps mutations apply-only', () => {
  const entrypoint = rollout.lastIndexOf('parse_args "$@"');
  assert.ok(
    callIndex('acquire_deploy_lock', entrypoint) < callIndex('  promote) promote', entrypoint),
  );
  assert.ok(
    callIndex('acquire_deploy_lock', entrypoint) < callIndex('trap cleanup EXIT', entrypoint),
  );
  assert.match(rollout, /cleanup\(\) \{[\s\S]*if recover_shadow; then[\s\S]*release_deploy_lock/u);
  assert.match(rollout, /"\$RECOVERY_ARMED" -eq 1 && "\$ROLLOUT_COMPLETE" -ne 1/u);
  assert.match(rollout, /if \[\[ "\$APPLY" -ne 1 \]\]; then[\s\S]*no state changed/u);
  assert.match(
    rollout,
    /docker compose "\$\{COMPOSE_FILES\[@\]\}" up -d --no-deps --no-build --force-recreate/u,
  );
  assert.doesNotMatch(rollout, /up -d postgres redis/u);
  assert.doesNotMatch(rollout, /docker (?:system|image|builder|buildx) prune/u);
});

test('removes inherited rollout interpolation before any Compose operation', () => {
  const unsetIndex = rollout.indexOf('unset \\\n  COMMERCIAL_OCR_ROLLOUT_MODE');
  const firstComposeIndex = rollout.indexOf('docker compose');
  assert.ok(unsetIndex >= 0 && unsetIndex < firstComposeIndex);
  for (const variable of [
    'COMMERCIAL_OCR_ROLLOUT_MODE',
    'COMMERCIAL_OCR_CANARY_CHAT_IDS',
    'COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64',
    'MODERATION_DELETE_INTENT_MODE',
    'MODERATION_DELETE_INTENT_CANARY_CHAT_IDS',
    'MAXIM_COMPOSE_SERVICE_ENV_FILE',
  ]) {
    assert.match(
      rollout.slice(unsetIndex, firstComposeIndex),
      new RegExp(`\\b${variable}\\b`, 'u'),
    );
  }
  assert.match(rollout, /export MAXIM_COMPOSE_SERVICE_ENV_FILE=\.\.\/\.env/u);
});

test('propagates the production certification trust anchor to every API role', () => {
  const sharedEnvironment = compose.slice(0, compose.indexOf('\nservices:'));
  assert.match(
    sharedEnvironment,
    /^ {2}COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64: \$\{COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64:-\}$/mu,
  );
  for (const service of productionServices) {
    assert.match(
      readComposeServiceBlock(compose, service),
      /^ {6}<<: \*spammer-read-model-shadow-env$/mu,
      `${service} must consume the shared certification trust anchor`,
    );
  }
});

test('quiesces every OCR producer before the authoritative drain and control CAS', () => {
  const start = rollout.indexOf('\npromote() {');
  const promoteBlock = rollout.slice(start, rollout.indexOf('\ndowngrade() {', start));
  const patch = promoteBlock.indexOf('patch_env_canary');
  const validate = promoteBlock.indexOf('validate_control_options');
  const recreate = promoteBlock.indexOf('recreate_all_roles', patch);
  const initialReadiness = promoteBlock.indexOf('wait_for_api_readiness', recreate);
  const initialParity = promoteBlock.indexOf('verify_runtime canary', initialReadiness);
  const postRecreateCertification = promoteBlock.indexOf('verify_certification', initialParity);
  const stop = promoteBlock.indexOf('stop_ocr_producers', postRecreateCertification);
  const authoritativeDrain = promoteBlock.indexOf('wait_for_queue_and_admission_drain', stop);
  const apply = promoteBlock.indexOf('apply_control', authoritativeDrain);
  const restart = promoteBlock.indexOf('start_ocr_producers', apply);
  const finalReadiness = promoteBlock.indexOf('wait_for_api_readiness', restart);
  const finalParity = promoteBlock.indexOf('verify_runtime canary', finalReadiness);
  const finalControl = promoteBlock.indexOf('verify_applied_control_still_active', finalParity);

  assert.ok(
    [
      validate,
      patch,
      recreate,
      initialReadiness,
      initialParity,
      postRecreateCertification,
      stop,
      authoritativeDrain,
      apply,
      restart,
    ]
      .concat(finalReadiness, finalParity, finalControl)
      .every((index) => index >= 0),
  );
  assert.ok(validate < patch);
  assert.ok(patch < recreate);
  assert.ok(recreate < initialReadiness);
  assert.ok(initialReadiness < initialParity);
  assert.ok(initialParity < postRecreateCertification);
  assert.ok(postRecreateCertification < stop);
  assert.ok(stop < authoritativeDrain);
  assert.ok(authoritativeDrain < apply);
  assert.ok(apply < restart);
  assert.ok(restart < finalReadiness);
  assert.ok(finalReadiness < finalParity);
  assert.ok(finalParity < finalControl);
  assert.equal((promoteBlock.match(/verify_certification/gmu) ?? []).length, 2);
  assert.match(
    rollout.slice(
      rollout.indexOf('verify_applied_control_still_active() {'),
      rollout.indexOf('\nclear_control() {'),
    ),
    /expiresAt[\s\S]*remainingTtlSec[\s\S]*MIN_FINAL_CONTROL_TTL_SEC/u,
  );

  const recreateBlock = rollout.slice(
    rollout.indexOf('recreate_all_roles() {'),
    rollout.indexOf('\nstop_ocr_producers() {'),
  );
  assert.ok(recreateBlock.indexOf('NON_MEDIA_SERVICES') < recreateBlock.indexOf('MEDIA_SERVICE'));

  const stopBlock = rollout.slice(
    rollout.indexOf('stop_ocr_producers() {'),
    rollout.indexOf('\nstart_ocr_producers() {'),
  );
  const startBlock = rollout.slice(
    rollout.indexOf('start_ocr_producers() {'),
    rollout.indexOf('\nforce_stop_container() {'),
  );
  assert.match(stopBlock, /stop "\$\{OCR_PRODUCER_SERVICES\[@\]\}"/u);
  assert.match(startBlock, /start "\$\{OCR_PRODUCER_SERVICES\[@\]\}"/u);
});

test('routes revision-bearing invalid control through the guarded clear before recreation', () => {
  const start = rollout.indexOf('\ndowngrade() {');
  const downgradeBlock = rollout.slice(start, rollout.indexOf('\nparse_args "$@"', start));
  const preflightBlock = rollout.slice(
    rollout.indexOf('verify_expected_control_before_downgrade() {'),
    rollout.indexOf('\nrequire_queue_and_admission_drained() {'),
  );
  assert.match(preflightBlock, /active \| expired \| missing \| invalid/u);
  assert.doesNotMatch(preflightBlock, /invalid\) fail/u);
  assert.match(preflightBlock, /summary_field revision/u);
  assert.ok(
    downgradeBlock.indexOf('verify_control_executor') <
      downgradeBlock.indexOf('verify_expected_control_before_downgrade'),
  );
  assert.ok(downgradeBlock.indexOf('clear_control') < downgradeBlock.indexOf('patch_env_shadow'));
  assert.ok(
    downgradeBlock.indexOf('patch_env_shadow') < downgradeBlock.indexOf('recreate_all_roles'),
  );
  assert.ok(
    downgradeBlock.indexOf('recreate_all_roles') < downgradeBlock.indexOf('wait_for_api_readiness'),
  );
  assert.ok(
    downgradeBlock.indexOf('wait_for_api_readiness') <
      downgradeBlock.indexOf('verify_runtime shadow'),
  );
});

test('arms full shadow recovery before either potentially dispatched Redis mutation', () => {
  const applyBlock = rollout.slice(
    rollout.indexOf('apply_control() {'),
    rollout.indexOf('\nclear_control() {'),
  );
  const clearBlock = rollout.slice(
    rollout.indexOf('clear_control() {'),
    rollout.indexOf('\npromote() {'),
  );
  for (const block of [applyBlock, clearBlock]) {
    assert.ok(block.indexOf('RECOVERY_ARMED=1') < block.indexOf('runtime_control api-admin'));
  }
  const recoverBlock = rollout.slice(
    rollout.indexOf('recover_shadow() {'),
    rollout.indexOf('\napi_role_ready() {'),
  );
  assert.match(
    recoverBlock,
    /if ! quiesce_recovery_services; then[\s\S]*return 1[\s\S]*patch_env_shadow/u,
  );
  assert.match(recoverBlock, /patch_env_shadow[\s\S]*recreate_all_roles_best_effort/u);
  assert.match(recoverBlock, /wait_for_api_readiness[\s\S]*verify_runtime shadow/u);
  assert.match(recoverBlock, /verify_runtime shadow[\s\S]*quiesce_recovery_services/u);
  const bestEffortBlock = rollout.slice(
    rollout.indexOf('recreate_all_roles_best_effort() {'),
    rollout.indexOf('\nrecover_shadow() {'),
  );
  assert.match(bestEffortBlock, /RECOVERY_QUIESCE_SERVICES/u);
  assert.match(
    bestEffortBlock,
    /recreate_recovery_service "\$service" "\$deadline" \|\| failed=1/u,
  );
});

test('aborts recovery before patch or recreation when initial quiescence is not proven', () => {
  const recoverBlock = rollout.slice(
    rollout.indexOf('recover_shadow() {'),
    rollout.indexOf('\napi_role_ready() {'),
  );
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `
ROOT_DIR=/fixture
maxim_require_ordinary_effect_authority() { return 0; }
RECOVERY_QUIESCENCE_PROVEN=9
events=()
quiesce_recovery_services() { events+=(quiesce); return 1; }
patch_env_shadow() { events+=(patch); return 0; }
recreate_all_roles_best_effort() { events+=(recreate); return 0; }
wait_for_api_readiness() { events+=(readiness); return 0; }
verify_runtime() { events+=(verify); return 0; }
${recoverBlock}
if recover_shadow; then status=0; else status=$?; fi
printf '%s|%s|%s\n' "$status" "$RECOVERY_QUIESCENCE_PROVEN" "\${events[*]}"
`,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, '1|0|quiesce\n');
});

test('proves recovery quiescence from a final fail-closed Docker inventory', () => {
  const forceStopBlock = rollout.slice(
    rollout.indexOf('force_stop_container() {'),
    rollout.indexOf('\nverify_recovery_services_stopped() {'),
  );
  const stoppedBlock = rollout.slice(
    rollout.indexOf('verify_recovery_services_stopped() {'),
    rollout.indexOf('\nquiesce_recovery_services() {'),
  );
  const quiesceBlock = rollout.slice(
    rollout.indexOf('quiesce_recovery_services() {'),
    rollout.indexOf('\nrecreate_recovery_service() {'),
  );

  assert.match(
    forceStopBlock,
    /if ! running="\$\([\s\S]*run_host_command_before_deadline[\s\S]*docker inspect/u,
  );
  assert.doesNotMatch(forceStopBlock, /docker inspect[^\n]*\|\| true/u);
  assert.match(forceStopBlock, /\[\[ "\$running" == "false" \]\]/u);
  assert.match(stoppedBlock, /for service in "\$\{RECOVERY_QUIESCE_SERVICES\[@\]\}"/u);
  assert.match(stoppedBlock, /if ! running_ids="\$\([\s\S]*ps --status running/u);
  assert.match(stoppedBlock, /verify_no_unreviewed_running_api_containers/u);
  assert.match(
    quiesceBlock,
    /RECOVERY_QUIESCENCE_PROVEN=0[\s\S]*if verify_recovery_services_stopped "\$deadline"; then[\s\S]*RECOVERY_QUIESCENCE_PROVEN=1/u,
  );
  assert.match(
    quiesceBlock,
    /for container_id in "\$\{RUNTIME_INVENTORY_OWNED_UNREVIEWED_IDS\[@\]\}"; do[\s\S]*force_stop_container/u,
  );
  assert.doesNotMatch(quiesceBlock, /for container_id in "\$\{RUNTIME_INVENTORY_AMBIGUOUS/u);
  assert.match(
    quiesceBlock,
    /Foreign or ambiguous containers are blockers, never mutation targets/u,
  );
});

test('pins an exact unique 14-role topology and exact seven producer partition', () => {
  const nonMediaServices = readShellArray(rollout, 'NON_MEDIA_SERVICES');
  assert.deepEqual(readShellArray(topology, 'MAXIM_PRODUCTION_API_SERVICES'), productionServices);
  assert.deepEqual(readShellArray(rollout, 'OCR_PRODUCER_SERVICES'), producerServices);
  assert.deepEqual(readShellArray(rollout, 'HTTP_READY_SERVICES'), httpReadyServices);
  assert.equal(new Set(productionServices).size, 14);
  assert.equal(new Set(nonMediaServices).size, 13);
  assert.deepEqual(
    new Set([...nonMediaServices, 'api-media-analysis']),
    new Set(productionServices),
  );
  assert.match(rollout, /Commercial OCR rollout API roles must be unique/u);
  assert.match(rollout, /Commercial OCR moderation producer partition is incomplete/u);
  assert.match(rollout, /recovery requires action plus seven producer roles/u);
  assert.match(rollout, /EXPECTED_HAS_OCR_NATIVE_SANDBOX=0/u);
  assert.match(rollout, /promotion requires the reviewed no-network native sandbox/u);
});

test('checks role-aware readiness, image, service identity, role, and rollout parity', () => {
  const verifyBlock = rollout.slice(
    rollout.indexOf('verify_runtime() {'),
    rollout.indexOf('\nnormalize_cohort() {'),
  );
  const readinessBlock = rollout.slice(
    rollout.indexOf('api_role_ready() {'),
    rollout.indexOf('\nbuild_control() {'),
  );
  assert.match(verifyBlock, /for service in "\$\{MAXIM_PRODUCTION_API_SERVICES\[@\]\}"/u);
  assert.match(verifyBlock, /ps --status running -q "\$service"/u);
  assert.match(verifyBlock, /"\$\{#container_ids\[@\]\}" -ne 1/u);
  assert.match(verifyBlock, /"\$image_id" != "\$MANIFEST_IMAGE_ID"/u);
  assert.match(verifyBlock, /verify-runtime-env[\s\S]*"\$service"/u);
  assert.match(verifyBlock, /verify_no_unreviewed_running_api_containers/u);
  assert.match(verifyBlock, /maxim_topology_verify_ocr_native_sandbox_runtime/u);
  assert.match(rollout, /reviewedAuxiliaryCount !== value\.expectedAuxiliaryCount/u);
  assert.match(rollout, /"APP_ROLE"[\s\S]*"APP_SERVICE_NAME"/u);
  assert.match(readinessBlock, /for service in "\$\{MAXIM_PRODUCTION_API_SERVICES\[@\]\}"/u);
  assert.match(readinessBlock, /api_role_ready "\$service" "\$deadline" &/u);
  assert.match(
    readinessBlock,
    /maxim_topology_contains "\$service" "\$\{HTTP_READY_SERVICES\[@\]\}" \|\| return 0/u,
  );
  assert.match(readinessBlock, /wait "\$pid"/u);
  assert.match(readinessBlock, /api_runtime_signature/u);
  assert.match(readinessBlock, /maxim_topology_ocr_services_for_compose/u);
  assert.match(readinessBlock, /API_STABILITY_WINDOW_SEC/u);
  assert.match(rollout, /docker exec "\$\{container_ids\[0\]\}" node -e/u);
  assert.match(rollout, /'\{\{\.RestartCount\}\}'/u);
  assert.match(
    readinessBlock,
    /run_host_command_before_deadline "\$deadline" "\$READINESS_COMMAND_MAX_TIMEOUT_SEC"[\s\S]*docker compose/u,
  );
  assert.match(
    readinessBlock,
    /run_host_command_before_deadline "\$deadline" "\$READINESS_COMMAND_MAX_TIMEOUT_SEC"[\s\S]*docker exec/u,
  );
  assert.match(
    readinessBlock,
    /run_host_command_before_deadline "\$deadline" "\$READINESS_COMMAND_MAX_TIMEOUT_SEC"[\s\S]*docker inspect/u,
  );
});

test('requires HTTP readiness only from the three roles that run a server', () => {
  const readinessFunction = rollout.slice(
    rollout.indexOf('api_role_ready() {'),
    rollout.indexOf('\nall_api_roles_ready() {'),
  );
  const execution = spawnSync(
    'bash',
    [
      '-c',
      `
COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
READINESS_COMMAND_MAX_TIMEOUT_SEC=5
HTTP_READY_SERVICES=(api-ingress api-admin api-media-analysis)
maxim_topology_contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}
run_host_command_before_deadline() {
  if [[ "$*" == *"ps --status running -q"* ]]; then
    printf '%s\n' container-1
    return 0
  fi
  return 77
}
${readinessFunction}
api_role_ready api-enqueue 100
headless_status=$?
api_role_ready api-ingress 100
http_status=$?
printf '%s|%s\n' "$headless_status" "$http_status"
`,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, '0|77\n');
});

test('bounds and decimal-normalizes readiness limits before arithmetic or sleep', () => {
  const limitsBlock = rollout.slice(
    rollout.indexOf('require_operational_limits() {'),
    rollout.indexOf('\nexpected_app_role_for_service() {'),
  );
  assert.match(limitsBlock, /\^\[0-9\]\{1,3\}\$/u);
  assert.match(limitsBlock, /readiness_timeout=\$\(\(10#\$API_READINESS_TIMEOUT_SEC\)\)/u);
  assert.match(limitsBlock, /stability_window=\$\(\(10#\$API_STABILITY_WINDOW_SEC\)\)/u);
  assert.match(limitsBlock, /API_READINESS_TIMEOUT_SEC="\$readiness_timeout"/u);
  assert.match(limitsBlock, /API_STABILITY_WINDOW_SEC="\$stability_window"/u);
  assert.match(limitsBlock, /drain_timeout=\$\(\(10#\$DRAIN_TIMEOUT_SEC\)\)/u);
  assert.match(limitsBlock, /DRAIN_TIMEOUT_SEC="\$drain_timeout"/u);

  const hostDeadlineBlock = rollout.slice(
    rollout.indexOf('run_host_command_before_deadline() {'),
    rollout.indexOf('\nwait_for_service_running() {'),
  );
  assert.match(hostDeadlineBlock, /remaining_sec=\$\(\(deadline - SECONDS\)\)/u);
  assert.match(
    hostDeadlineBlock,
    /command_timeout_sec=\$\(\(remaining_sec - READINESS_COMMAND_KILL_GRACE_SEC\)\)/u,
  );
  assert.match(
    hostDeadlineBlock,
    /timeout --foreground --kill-after="\$\{READINESS_COMMAND_KILL_GRACE_SEC\}s"/u,
  );
});

test('checks all drain states and never puts control or cohort data in process arguments', () => {
  for (const state of [
    'waiting',
    'active',
    'delayed',
    'prioritized',
    'paused',
    'waiting-children',
  ]) {
    assert.match(rollout, new RegExp(`QUEUE_STATES=\\([^)]*\\b${state}\\b`, 'su'));
  }
  assert.match(admissionDrainProbe, /commercial-ocr:admission:v2:global:units/u);
  assert.match(admissionDrainProbe, /commercial-ocr:admission:v2:global:metadata/u);
  const drainBlock = rollout.slice(
    rollout.indexOf('queue_and_admission_drained() {'),
    rollout.indexOf('\nrequire_queue_and_admission_drained() {'),
  );
  assert.ok(
    admissionDrainProbe.indexOf('queue.waitUntilReady()') <
      admissionDrainProbe.indexOf('queue.getJobCounts'),
  );
  assert.ok(
    admissionDrainProbe.indexOf('redis.connect()') <
      admissionDrainProbe.indexOf('redis.get(ADMISSION_UNITS_KEY)'),
  );
  assert.match(drainBlock, /<"\$ADMISSION_DRAIN_PROBE"/u);
  const waitDrainBlock = rollout.slice(
    rollout.indexOf('wait_for_queue_and_admission_drain() {'),
    rollout.indexOf('\npatch_env_canary() {'),
  );
  assert.match(waitDrainBlock, /deadline=\$\(\(SECONDS \+ DRAIN_TIMEOUT_SEC\)\)/u);
  assert.match(waitDrainBlock, /remaining_sec=\$\(\(deadline - SECONDS\)\)/u);
  assert.match(
    waitDrainBlock,
    /probe_timeout_sec=\$\(\(remaining_sec - DRAIN_PROBE_KILL_GRACE_SEC\)\)/u,
  );
  assert.match(waitDrainBlock, /queue_and_admission_drained "\$probe_timeout_sec"/u);
  assert.doesNotMatch(waitDrainBlock, /attempt <=/u);
  assert.match(
    drainBlock,
    /timeout --foreground --kill-after="\$\{DRAIN_PROBE_KILL_GRACE_SEC\}s"/u,
  );
  assert.match(drainBlock, /MAXIM_COMMERCIAL_OCR_DRAIN_PROBE_TIMEOUT_MS/u);
  assert.match(rollout, /--control-stdin --apply --json <"\$CONTROL_FILE"/u);
  assert.match(rollout, /patch-rollout-env \.env canary "\$COHORT_FILE"/u);
  assert.match(
    rollout,
    /verify-runtime-env "\$expected_mode" "\$EXPECTED_OCR_VERSION"[\s\S]*"\$service"/u,
  );
  assert.doesNotMatch(rollout, /--control-json/u);
  assert.doesNotMatch(rollout, /COHORT_IDS|expected_ids|expectedIds/u);
  assert.doesNotMatch(rollout, /\.ids\.join\(/u);
  assert.doesNotMatch(rollout, /cat "?\$CONTROL/u);

  for (const [start, end] of [
    ['validate_control_options() {', '\nruntime_control() {'],
    ['build_control() {', '\napply_control() {'],
  ]) {
    const controlBuilder = rollout.slice(rollout.indexOf(start), rollout.indexOf(end));
    assert.match(
      controlBuilder,
      /printf '%s\\0%s\\0' "\$CONTROL_ACTOR" "\$CONTROL_REASON" \|[\s\S]*node "\$STATE_HELPER"/u,
    );
    assert.doesNotMatch(controlBuilder, /node "\$STATE_HELPER"[^\n]*CONTROL_(?:ACTOR|REASON)/u);
  }
});

test('scans admission metadata in bounded privacy-safe pages and fails closed on drift', () => {
  assert.doesNotMatch(rollout, /\bHVALS\b|\.hvals\(/iu);
  assert.doesNotMatch(admissionDrainProbe, /\bHVALS\b|\.hvals\(/iu);
  assert.match(admissionDrainProbe, /maxEntries: 50_000/u);
  assert.match(admissionDrainProbe, /maxLogicalBytes: 8 \* 1024 \* 1024/u);
  assert.match(admissionDrainProbe, /maxRedisBytes: 16 \* 1024 \* 1024/u);
  assert.match(admissionDrainProbe, /maxPages: 4_096/u);
  assert.match(admissionDrainProbe, /pageCount: 128/u);
  const boundsScript = admissionDrainProbe.slice(
    admissionDrainProbe.indexOf('const READ_ADMISSION_METADATA_BOUNDS_SCRIPT'),
    admissionDrainProbe.indexOf('// One Redis round-trip'),
  );
  assert.ok(boundsScript.indexOf("redis.call('HLEN'") < boundsScript.indexOf('if entries >'));
  assert.ok(boundsScript.indexOf('if entries >') < boundsScript.indexOf("redis.call('MEMORY'"));
  assert.match(admissionDrainProbe, /await redis\.hlen\(ADMISSION_METADATA_KEY\)/u);
  assert.match(admissionDrainProbe, /redis\.call\('HSCAN'/u);
  assert.match(admissionDrainProbe, /redis\.watch\(ADMISSION_METADATA_KEY\)/u);
  assert.match(
    admissionDrainProbe,
    /redis\.multi\(\[\['hlen', ADMISSION_METADATA_KEY\]\]\)\.exec/u,
  );
  assert.match(
    admissionDrainProbe,
    /const pageResponse = await redis\.eval[\s\S]*now\(\) - startedAt > limits\.timeoutMs[\s\S]*parsePageSummary\(pageResponse\)/u,
  );
  assert.match(admissionDrainProbe, /scannedEntries !== expectedEntries/u);
  assert.match(
    admissionDrainProbe,
    /return \{page\[1\], entries, logical_bytes, held, malformed\}/u,
  );
  assert.doesNotMatch(admissionDrainProbe, /process\.stdout\.write\([^)]*(?:field|metadata)/u);
  assert.doesNotMatch(admissionDrainProbe, /error\.message/u);
});

test('fences recreation to a clean immutable API release and OCR version', () => {
  const fenceBlock = rollout.slice(
    rollout.indexOf('resolve_release_fence() {'),
    rollout.indexOf('\ncontainer_env_summary() {'),
  );
  assert.match(rollout, /git diff --quiet -- \./u);
  assert.match(rollout, /git diff --cached --quiet -- \./u);
  assert.match(rollout, /export MAXIM_API_IMAGE="\$MANIFEST_IMAGE_REF"/u);
  assert.match(rollout, /export COMMERCIAL_OCR_VERSION="\$EXPECTED_OCR_VERSION"/u);
  assert.match(rollout, /verify-runtime-identity "\$EXPECTED_OCR_VERSION" "\$service"/u);
  assert.match(rollout, /commercial-ocr-runtime-inventory\.mjs/u);
  assert.match(
    rollout,
    /owned-unreviewed, ambiguous, foreign, orphaned, or duplicate API container/u,
  );
  assert.match(fenceBlock, /if ! MANIFEST_SOURCE_SHA=/u);
  assert.match(fenceBlock, /if ! image_fence=/u);
  assert.doesNotMatch(fenceBlock, /\|\| fail/u);
  assert.ok((fenceBlock.match(/return 1/gmu) ?? []).length >= 8);
});

test('exposes guarded rollout commands only through the VPS wrapper', () => {
  assert.match(connect, /commercial-ocr-promote/u);
  assert.match(connect, /commercial-ocr-downgrade/u);
  assert.match(connect, /commercial-ocr-status/u);
  assert.match(connect, /commercial-ocr-recover-shadow/u);
  assert.match(connect, /vps-commercial-ocr-rollout\.sh/u);
  assert.match(connect, /commercial-ocr-promotion-bundle\.mjs" pack/u);
  assert.match(connect, /commercial-ocr-promotion-bundle\.mjs unpack/u);
  assert.match(connect, /reviewed_certification_sha256="\$\{3:-\}"/u);
  assert.match(connect, /actual_certification_sha256="\$\(sha256sum --/u);
  assert.match(connect, /"\$actual_certification_sha256" != "\$reviewed_certification_sha256"/u);
  assert.match(connect, /--certification-sha256 %q --expected-revision %q/u);
  assert.match(
    connect,
    /node "\$ROOT_DIR\/infra\/scripts\/commercial-ocr-promotion-bundle\.mjs" pack[\s\S]*\|[\s\S]*ssh/u,
  );
  assert.match(connect, /chat_ids_bytes="\$\(wc -c/u);
  assert.match(connect, /certification_bytes="\$\(wc -c/u);
  assert.doesNotMatch(connect, /head -c/u);
});

test('binds promotion to a passing certification verified by the active API image', () => {
  const certificationBlock = rollout.slice(
    rollout.indexOf('verify_certification() {'),
    rollout.indexOf('\nverify_runtime() {'),
  );
  assert.match(certificationBlock, /CERTIFICATION_VERIFIER_SCRIPT/u);
  assert.match(certificationBlock, /--expected-source-sha "\$MANIFEST_SOURCE_SHA"/u);
  assert.match(certificationBlock, /--expected-image-sha256 "\$image_sha256"/u);
  assert.match(certificationBlock, /--expected-certification-sha256 "\$CERTIFICATION_SHA256"/u);
  assert.match(certificationBlock, /<"\$CERTIFICATION_FILE" >"\$CERTIFICATION_VERIFICATION_FILE"/u);
  assert.match(certificationBlock, /validate-certification-verification/u);
  assert.doesNotMatch(certificationBlock, /cat "?\$CERTIFICATION_FILE/u);
  assert.match(rollout, /Promotion requires a readable --certification-file/u);
  assert.match(rollout, /\^\[a-f0-9\]\{64\}\$/u);
  const buildControlBlock = rollout.slice(
    rollout.indexOf('build_control() {'),
    rollout.indexOf('\napply_control() {'),
  );
  assert.match(buildControlBlock, /CERTIFICATION_VERIFICATION_FILE/u);
  assert.match(buildControlBlock, /CERTIFICATION_SHA256/u);
});

test('provides privacy-safe status and apply-only forced shadow reconciliation', () => {
  const statusBlock = rollout.slice(
    rollout.indexOf('status() {'),
    rollout.indexOf('\nrecover_shadow_command() {'),
  );
  assert.match(statusBlock, /verify_control_executor[\s\S]*read_control_summary/u);
  assert.match(statusBlock, /kind=%s revision=%s mode=%s count=%s expires_at=%s/u);
  assert.doesNotMatch(statusBlock, /enforcementChatIds|CANARY_CHAT_IDS|digest|chatDigest/u);

  const recoveryCommandBlock = rollout.slice(
    rollout.indexOf('recover_shadow_command() {'),
    rollout.indexOf('\nparse_args "$@"'),
  );
  assert.match(recoveryCommandBlock, /"\$APPLY" -ne 1[\s\S]*no state changed/u);
  assert.match(recoveryCommandBlock, /recover_shadow/u);
  const appliedQuiesce = recoveryCommandBlock.indexOf('quiesce_recovery_services');
  const appliedFence = recoveryCommandBlock.indexOf('resolve_release_fence', appliedQuiesce);
  const recovery = recoveryCommandBlock.indexOf('recover_shadow', appliedFence);
  assert.ok(appliedQuiesce >= 0 && appliedQuiesce < appliedFence && appliedFence < recovery);
  assert.match(
    recoveryCommandBlock,
    /if ! resolve_release_fence; then[\s\S]*no role was recreated/u,
  );
  assert.match(recoveryCommandBlock, /RECOVERY_QUIESCENCE_PROVEN/u);
});

test('patches and verifies only OCR rollout ceilings while preserving general delete rollout', () => {
  const envSummaryBlock = rollout.slice(
    rollout.indexOf('container_env_summary() {'),
    rollout.indexOf('\nread_running_api_inventory() {'),
  );
  const patchBlock = rollout.slice(
    rollout.indexOf('patch_env_canary() {'),
    rollout.indexOf('\nwait_for_service_running() {'),
  );

  assert.match(envSummaryBlock, /COMMERCIAL_OCR_ROLLOUT_MODE/u);
  assert.match(envSummaryBlock, /COMMERCIAL_OCR_CANARY_CHAT_IDS/u);
  assert.doesNotMatch(envSummaryBlock, /MODERATION_DELETE_INTENT_(?:MODE|CANARY_CHAT_IDS)/u);
  assert.match(patchBlock, /patch-rollout-env \.env canary/u);
  assert.match(patchBlock, /patch-rollout-env \.env shadow/u);
  assert.doesNotMatch(patchBlock, /MODERATION_DELETE_INTENT_(?:MODE|CANARY_CHAT_IDS)/u);
});

test('does not publish a stable digest of the private OCR cohort', () => {
  const normalizeBlock = rollout.slice(
    rollout.indexOf('normalize_cohort() {'),
    rollout.indexOf('\nvalidate_control_options() {'),
  );
  const downgradePreflightBlock = rollout.slice(
    rollout.indexOf('verify_expected_control_before_downgrade() {'),
    rollout.indexOf('\nqueue_and_admission_drained() {'),
  );
  const promoteBlock = rollout.slice(
    rollout.indexOf('promote() {'),
    rollout.indexOf('\ndowngrade() {'),
  );

  for (const block of [normalizeBlock, downgradePreflightBlock, promoteBlock]) {
    assert.doesNotMatch(block, /COHORT_DIGEST|chatDigest|digest=%s/u);
  }
});

test('promotion preview proves readiness stability and rechecks runtime parity before success', () => {
  const promoteBlock = rollout.slice(
    rollout.indexOf('promote() {'),
    rollout.indexOf('\ndowngrade() {'),
  );
  const firstParity = promoteBlock.indexOf('verify_runtime shadow');
  const readiness = promoteBlock.indexOf('wait_for_api_readiness', firstParity);
  const finalParity = promoteBlock.indexOf('verify_runtime shadow', readiness);
  const certification = promoteBlock.indexOf('verify_certification', finalParity);
  const previewBoundary = promoteBlock.indexOf('if [[ "$APPLY" -ne 1 ]]');
  assert.ok(
    firstParity >= 0 &&
      firstParity < readiness &&
      readiness < finalParity &&
      finalParity < certification &&
      certification < previewBoundary,
  );
});
