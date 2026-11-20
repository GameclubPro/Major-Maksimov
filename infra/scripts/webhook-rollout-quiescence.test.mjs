import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function callIndex(script, call, fromIndex = 0) {
  const index = script.indexOf(call, fromIndex);
  assert.notEqual(index, -1, `Missing rollout call: ${call}`);
  return index;
}

test('keeps the shared quiescence helper syntactically valid and fail-closed', () => {
  const libraryPath = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const library = read('infra/scripts/lib/webhook-rollout-quiescence.sh');
  execFileSync('bash', ['-n', libraryPath]);

  assert.match(library, /MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_SEC:-960/u);
  assert.match(library, /MAXIM_WEBHOOK_QUEUES_MAY_BE_PAUSED=1/u);
  assert.match(library, /MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE must be 0 or 1/u);
  assert.match(library, /MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN/u);
  assert.match(library, /run --rm --no-deps --pull never -T/u);
  assert.doesNotMatch(library, /compose[^\n]+exec -T[\s\S]*api-admin node - "\$action"/u);
  assert.match(library, /stop[\s\S]*api-enqueue/u);
  assert.match(library, /wait-drained/u);
  assert.match(library, /maxim_webhook_assert_api_rollout_quiescence/u);
  assert.match(library, /WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:/u);
  assert.match(library, /FROM "webhook_events"/u);
  assert.match(library, /pg_catalog\.pg_attribute/u);
  assert.match(library, /\\if :has_timeout_quarantine_column/u);
  assert.match(library, /"timeout_quarantine_expires_at" IS NOT NULL/u);
  assert.match(
    library,
    /"timeout_quarantine_expires_at" > \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)/u,
  );
  assert.match(library, /"timeout_quarantine_expires_at" IS NULL/u);
  assert.match(
    library,
    /"timeout_quarantine_expires_at" <= \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)/u,
  );
  assert.match(library, /MAXIM_WEBHOOK_STALE_TIMEOUT_QUARANTINES_FENCED/u);
  assert.match(
    library,
    /WHEN EXISTS \([\s\S]*?"timeout_quarantine_expires_at" IS NOT NULL[\s\S]*?"timeout_quarantine_expires_at" > \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)[\s\S]*?\) THEN 1\nWHEN EXISTS \([\s\S]*?"timeout_quarantine_expires_at" IS NOT NULL[\s\S]*?"timeout_quarantine_expires_at" <= \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)[\s\S]*?\) THEN 2\nWHEN EXISTS \([\s\S]*?"timeout_quarantine_expires_at" IS NULL[\s\S]*?\) THEN 2/u,
  );
  assert.match(library, /Active or detached webhook executions did not settle/u);
  assert.match(library, /Could not query pending webhook timeout quarantine state/u);
  assert.match(library, /stop[\s\S]*MAXIM_WEBHOOK_MODERATION_SERVICES/u);
  assert.match(library, /resume[\s\S]*MAXIM_WEBHOOK_QUEUES_MAY_BE_PAUSED=0/u);
  assert.match(library, /Do not resume them until every production API role is verified/u);
});

test('fails closed when the timeout-quarantine Postgres query fails', () => {
  const libraryPath = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const script = `
    ROOT_DIR=${JSON.stringify(root)}
    source ${JSON.stringify(libraryPath)}
    COMPOSE_FILES=()
    timeout() { return 1; }
    maxim_webhook_rollout_has_pending_timeout_quarantine COMPOSE_FILES
  `;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Could not query pending webhook timeout quarantine state\./u);
});

test('maps live, stale, and empty timeout-quarantine query states without ambiguity', () => {
  const libraryPath = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const script = `
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(root)}
    source ${JSON.stringify(libraryPath)}
    COMPOSE_FILES=()
    query_state=0
    timeout() { printf '%s\\n' "$query_state"; }
    statuses=()
    for query_state in 0 1 2; do
      if maxim_webhook_rollout_has_pending_timeout_quarantine COMPOSE_FILES; then
        statuses+=(0)
      else
        statuses+=($?)
      fi
    done
    printf '%s\\n' "${'${statuses[*]}'}"
  `;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1 0 3');
});

test('fails closed when Docker cannot inspect a stopped rollout service', () => {
  const libraryPath = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const script = `
    ROOT_DIR=${JSON.stringify(root)}
    source ${JSON.stringify(libraryPath)}
    COMPOSE_FILES=()
    docker() { return 42; }
    maxim_webhook_rollout_verify_services_stopped COMPOSE_FILES api-enqueue
  `;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not inspect webhook rollout service state: api-enqueue/u);
});

test('requires two stable queue and quarantine observations before continuing', () => {
  const libraryPath = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const script = `
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(root)}
    source ${JSON.stringify(libraryPath)}
    COMPOSE_FILES=()
    control_calls=0
    quarantine_calls=0
    maxim_webhook_rollout_control() { control_calls=$((control_calls + 1)); }
    maxim_webhook_rollout_has_pending_timeout_quarantine() {
      quarantine_calls=$((quarantine_calls + 1))
      return 1
    }
    maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
    printf '%s %s\\n' "$control_calls" "$quarantine_calls"
  `;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '2 2');
});

test('requires stopped moderation owners before accepting expired and pre-lease timeout markers', () => {
  const libraryPath = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const script = `
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(root)}
    source ${JSON.stringify(libraryPath)}
    COMPOSE_FILES=()
    control_calls=0
    quarantine_calls=0
    maxim_webhook_rollout_control() { control_calls=$((control_calls + 1)); }
    maxim_webhook_rollout_has_pending_timeout_quarantine() {
      quarantine_calls=$((quarantine_calls + 1))
      return 3
    }
    if maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES; then
      first_status=0
    else
      first_status=$?
    fi
    MAXIM_WEBHOOK_STALE_TIMEOUT_QUARANTINES_FENCED=1
    maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
    printf '%s %s %s\\n' "$first_status" "$control_calls" "$quarantine_calls"
  `;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '3 4 4');

  const library = read('infra/scripts/lib/webhook-rollout-quiescence.sh');
  const stopped = library.indexOf(
    'maxim_webhook_rollout_verify_services_stopped \\\n    "$compose_args_var" "${MAXIM_WEBHOOK_MODERATION_SERVICES[@]}"',
  );
  const fenced = library.indexOf('MAXIM_WEBHOOK_STALE_TIMEOUT_QUARANTINES_FENCED=1');
  const finalFence = library.indexOf(
    'maxim_webhook_assert_api_rollout_quiescence "$compose_args_var"',
    fenced,
  );
  assert.ok(stopped >= 0 && stopped < fenced);
  assert.ok(fenced < finalFence);
});

test('aborts if the owned queue pause is lost while quarantine settlement is pending', () => {
  const libraryPath = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const script = `
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(root)}
    source ${JSON.stringify(libraryPath)}
    COMPOSE_FILES=()
    control_calls=0
    maxim_webhook_rollout_control() {
      control_calls=$((control_calls + 1))
      if [[ "$control_calls" -eq 2 ]]; then
        printf '%s\\n' 'owned pause lost' >&2
        return 1
      fi
    }
    maxim_webhook_rollout_has_pending_timeout_quarantine() { return 0; }
    sleep() { :; }
    maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  `;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /owned pause lost/u);
});

test('keeps a future timeout lease blocking after stale markers are fenced', () => {
  const libraryPath = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
  const script = `
    set -euo pipefail
    ROOT_DIR=${JSON.stringify(root)}
    source ${JSON.stringify(libraryPath)}
    COMPOSE_FILES=()
    MAXIM_WEBHOOK_ROLLOUT_DRAIN_TIMEOUT_SEC=1
    MAXIM_WEBHOOK_STALE_TIMEOUT_QUARANTINES_FENCED=1
    maxim_webhook_rollout_control() { :; }
    maxim_webhook_rollout_has_pending_timeout_quarantine() { return 0; }
    sleep() { SECONDS=$((SECONDS + 2)); }
    maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES
  `;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Active or detached webhook executions did not settle/u);
});

test('keeps the live quarantine lookup aligned with its partial migration index', () => {
  const library = read('infra/scripts/lib/webhook-rollout-quiescence.sh');
  const migration = read(
    'apps/api/prisma/migrations/20260815124500_add_webhook_timeout_quarantine_lease/migration.sql',
  );

  assert.equal('WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'.length, 37);

  assert.match(
    library,
    /LEFT\(COALESCE\("error_message", ''\), 37\) = '\$\{MAXIM_WEBHOOK_PENDING_TIMEOUT_QUARANTINE_PREFIX\}'/u,
  );
  assert.match(library, /"timeout_quarantine_expires_at" IS NULL/u);
  assert.match(
    library,
    /"timeout_quarantine_expires_at" > \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)/u,
  );
  assert.match(
    library,
    /"timeout_quarantine_expires_at" <= \(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'\)/u,
  );
  assert.match(
    migration,
    /LEFT\(COALESCE\("error_message", ''\), 37\) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'/u,
  );
  for (const source of [library, migration]) {
    assert.match(source, /"status" = 'FAILED'/u);
    assert.match(source, /"timeout_quarantine_expires_at" IS NOT NULL/u);
  }
  assert.match(
    migration,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_live_timeout_quarantine_idx"/u,
  );
});

test('normal deploy resumes only after every API role has the target image', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  execFileSync('bash', ['-n', resolve(root, 'infra/scripts/vps-pull-build-up.sh')]);
  const quiesce = callIndex(deploy, 'maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES');
  const publisherFence = callIndex(deploy, 'quiesce_publisher_album_transition || exit 1', quiesce);
  const actionRecreate = callIndex(
    deploy,
    'recreate_service_wave "action, publisher and retention"',
    quiesce,
  );
  const moderationRecreate = callIndex(
    deploy,
    'recreate_service_wave "moderation"',
    actionRecreate,
  );
  const enqueueRecreate = callIndex(deploy, 'recreate_service_wave "enqueue"', moderationRecreate);
  const imageFence = callIndex(deploy, 'for service in "${API_SERVICES[@]}"; do', enqueueRecreate);
  const resume = callIndex(
    deploy,
    'maxim_webhook_resume_after_api_fence COMPOSE_FILES',
    imageFence,
  );
  const staticRecreate = callIndex(deploy, 'recreate_service_wave "major static"', resume);
  const ingressReady = callIndex(
    deploy,
    'wait_for_url "http://127.0.0.1:3001/api/health/ready" "$API_READY_TIMEOUT_SEC"',
    resume,
  );
  const adminReady = callIndex(
    deploy,
    'wait_for_url "http://127.0.0.1:3002/api/health/ready" "$API_READY_TIMEOUT_SEC"',
    resume,
  );

  assert.ok(quiesce < publisherFence);
  assert.ok(publisherFence < actionRecreate);
  assert.ok(actionRecreate < moderationRecreate);
  assert.ok(moderationRecreate < enqueueRecreate);
  assert.ok(enqueueRecreate < imageFence);
  assert.ok(imageFence < resume);
  assert.ok(resume < staticRecreate);
  assert.ok(resume < ingressReady);
  assert.ok(resume < adminReady);
  assert.ok(
    callIndex(deploy, 'wait_for_url "http://127.0.0.1:3001/api/health/live" 180', imageFence) <
      resume,
  );
  assert.ok(
    callIndex(deploy, 'wait_for_url "http://127.0.0.1:3002/api/health/live" 180', imageFence) <
      resume,
  );
  assert.ok(
    [
      ...deploy
        .slice(quiesce, enqueueRecreate)
        .matchAll(/maxim_webhook_assert_api_rollout_quiescence COMPOSE_FILES/gu),
    ].length >= 6,
  );
  assert.match(deploy, /cleanup\(\) \{\n {2}maxim_webhook_rollout_warn_if_paused/u);
});

test('the first ordered album writer requires a stopped legacy HTTP editor', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const start = callIndex(deploy, 'quiesce_publisher_album_transition() {');
  const end = callIndex(deploy, '\n}', start) + 2;
  for (const [mode, status, output] of [
    ['compatible', 0, 'writer-ready\n'],
    ['legacy', 0, 'stop-admin\nwriter-ready\n'],
    ['drifted', 0, 'stop-admin\nwriter-ready\n'],
    ['stuck', 1, 'stop-admin\n'],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
${deploy.slice(start, end)}
COMPOSE_FILES=(-p infra)
MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC=30
mode="$1"
stopped=0
release_field() {
  case "$2" in
    sourceSha) printf '%040d' 1 ;;
    imageId) printf 'sha256:%064d' 1 ;;
  esac
}
git() { [[ "$mode" == compatible || "$mode" == drifted ]]; }
verify_service_image_id() { [[ "$mode" == compatible ]]; }
docker() {
  [[ "$*" == 'compose -p infra stop -t 30 api-admin' ]] || return 2
  printf 'stop-admin\\n'
  if [[ "$mode" != stuck ]]; then stopped=1; fi
}
maxim_webhook_rollout_verify_services_stopped() {
  [[ "$*" == 'COMPOSE_FILES api-admin' && "$stopped" == 1 ]]
}
quiesce_publisher_album_transition || exit 1
printf 'writer-ready\\n'`,
        'album-rollout-fixture',
        mode,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, status, mode);
    assert.equal(result.stdout, output, mode);
  }
});

test('both API rollback paths use the same exact-version queue fence', () => {
  for (const path of [
    'infra/scripts/vps-release-rollback.sh',
    'infra/scripts/vps-runtime-rollback.sh',
  ]) {
    const script = read(path);
    execFileSync('bash', ['-n', resolve(root, path)]);
    const quiesce = callIndex(script, 'maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES');
    const recreate = callIndex(
      script,
      path.endsWith('vps-release-rollback.sh') ? 'recreate_service "$service"' : '--force-recreate',
      quiesce,
    );
    const imageFence = callIndex(script, 'verify_service_image_id', recreate);
    const resume = callIndex(
      script,
      'maxim_webhook_resume_after_api_fence COMPOSE_FILES',
      imageFence,
    );
    const liveSmoke = callIndex(
      script,
      path.endsWith('vps-release-rollback.sh')
        ? 'wait_for_strict_smoke json-ok http://127.0.0.1:3001/api/health/live'
        : 'wait_for_url "http://127.0.0.1:3001/api/health/live" 180',
      imageFence,
    );

    assert.ok(quiesce < recreate, path);
    assert.ok(recreate < imageFence, path);
    assert.ok(imageFence < resume, path);
    assert.ok(imageFence < liveSmoke, path);
    assert.ok(liveSmoke < resume, `${path} must prove local live health before resume`);
    assert.match(script, /maxim_webhook_rollout_warn_if_paused/u, path);
  }
});

test('ref-based rollback preserves host helpers and crash-safe recovery across its Git switch', () => {
  const rollback = read('infra/scripts/vps-runtime-rollback.sh');
  const copy = callIndex(
    rollback,
    'cp "$MAXIM_WEBHOOK_ROLLOUT_CONTROL_HELPER" "$WEBHOOK_ROLLOUT_HELPER"',
  );
  const gitSwitch = callIndex(rollback, 'git switch --detach "$TARGET_FULL_SHA"', copy);
  const quiesce = callIndex(
    rollback,
    'maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES',
    gitSwitch,
  );
  assert.ok(copy < gitSwitch);
  assert.ok(gitSwitch < quiesce);
  assert.match(rollback, /release-manifest\.mjs" recovery-base/u);
  assert.match(
    rollback,
    /Explicit runtime rollback recovery requires one invalid release manifest/u,
  );
  assert.match(rollback, /--current-manifest-file "\$RECOVERY_BASE_MANIFEST"/u);
  assert.match(rollback, /begin-transition --kind runtime-rollback/u);
  assert.match(rollback, /verify_inherited_static_components/u);
  assert.ok(callIndex(rollback, 'acquire_deploy_lock') < rollback.indexOf('validate-current'));
  assert.ok(
    callIndex(rollback, 'begin_runtime_rollback_transition') <
      rollback.indexOf('./node_modules/.bin/prisma migrate deploy'),
  );
});
