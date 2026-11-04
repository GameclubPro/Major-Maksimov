import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
const sha = 'a'.repeat(40);

function shellFunction(name, next) {
  const start = connector.indexOf(`${name}() `);
  const end = connector.indexOf(`\n${next}() `, start);
  assert.ok(start >= 0 && end > start, `Missing connector function ${name}`);
  return connector.slice(start, end);
}

const functions = [
  shellFunction('shell_quote_args', 'ssh_args'),
  shellFunction('deploy_main', 'prepare_registry_release_images'),
  shellFunction('prepare_registry_release_images', 'finalize_release_recovery'),
  shellFunction('preload_ci_image', 'deploy_scale'),
].join('\n');

function runConnector({ proofStatus = 0, pullStatus = 0, context = 'deploy' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-preload-connector-'));
  const invocation = {
    deploy: 'deploy_main main --auto',
    deploy_or: 'deploy_main main --auto || exit "$?"',
    deploy_if: 'if deploy_main main --auto; then exit 0; else exit "$?"; fi',
    or: 'preload_ci_image api "$FIXTURE_SHA" || exit "$?"',
    if: 'if preload_ci_image api "$FIXTURE_SHA"; then exit 0; else exit "$?"; fi',
  }[context];
  assert.ok(invocation);
  try {
    const result = spawnSync(
      'bash',
      [
        '-euo',
        'pipefail',
        '-c',
        `${functions}
unset MAXIM_MESSAGE_RETENTION_MODE MAXIM_COMMERCIAL_LLM_ENFORCEMENT
unset MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED MAXIM_COMMERCIAL_LLM_POOL_ENABLED
unset MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY STATISTICS_EXCHANGE_V3_ENABLED
unset MAXIM_STATISTICS_CENTRAL_EPOCH MAXIM_DEPLOY_EMERGENCY_BYPASS MAXIM_DEPLOY_EMERGENCY_REASON
unset MAXIM_COMMERCIAL_OCR_BASELINE MAXIM_COMMERCIAL_OCR_OFF
gh() { return 0; }
git() { printf '%s\\n' "$FIXTURE_SHA"; }
mktemp() {
  local path
  path="$(command mktemp "$FIXTURE_DIRECTORY/request.XXXXXX")" || return
  printf '%s\\n' "$path" >>"$FIXTURE_DIRECTORY/created"
  printf '%s\\n' "$path"
}
node() {
  case "$1" in
    scripts/ci/assert-green.mjs) return 0 ;;
    infra/scripts/registry-preload.mjs)
      if [[ "$2" == plan ]]; then
        cat >/dev/null
        printf 'api-shared\\n'
        return 0
      fi
      printf 'proof|%s\\n' "$(stat -c %a "$FIXTURE_DIRECTORY"/request.*)" >>"$FIXTURE_DIRECTORY/events"
      printf '{"privateProof":true}\\n'
      return "$FIXTURE_PROOF_STATUS"
      ;;
    *) printf 'Unexpected node invocation\\n' >&2; return 95 ;;
  esac
}
remote_exec() {
  case "$1" in
    *registry-preload-host.mjs*)
      printf 'pull\\n' >>"$FIXTURE_DIRECTORY/events"
      cat >/dev/null
      return "$FIXTURE_PULL_STATUS"
      ;;
    *--image-plan*)
      printf 'plan\\n' >>"$FIXTURE_DIRECTORY/events"
      printf 'MAXIM_IMAGE_PLAN={"schemaVersion":1,"sourceSha":"%s","components":["api-shared"]}\\n' "$FIXTURE_SHA"
      ;;
    *--plan*) printf 'sync\\n' >>"$FIXTURE_DIRECTORY/events" ;;
    *) printf 'runtime\\n' >>"$FIXTURE_DIRECTORY/events" ;;
  esac
}
maxim_validate_git_ssh_port() { :; }
maxim_prepend_git_ssh_transport() { :; }
prepend_webhook_rollout_recovery_env() { :; }
prepend_post_release_reclaim_env() { :; }
prepend_deploy_disk_floor_env() { :; }
prepend_deploy_ready_timeout_env() { :; }
${invocation}
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          FIXTURE_DIRECTORY: directory,
          FIXTURE_SHA: sha,
          FIXTURE_PROOF_STATUS: String(proofStatus),
          FIXTURE_PULL_STATUS: String(pullStatus),
        },
      },
    );
    const files = readdirSync(directory);
    return {
      ...result,
      events: files.includes('events')
        ? readFileSync(join(directory, 'events'), 'utf8').trim().split('\n')
        : [],
      created: files.includes('created')
        ? readFileSync(join(directory, 'created'), 'utf8').trim().split('\n')
        : [],
      remainingRequests: files.filter((name) => name.startsWith('request.')),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const context of ['or', 'if']) {
  test(`failed local image proof stops preload in ${context} context before SSH`, () => {
    const result = runConnector({ context, proofStatus: 41 });
    assert.equal(result.status, 41, result.stderr);
    assert.deepEqual(result.events, ['proof|600']);
    assert.equal(result.created.length, 1);
    assert.deepEqual(result.remainingRequests, []);
  });

  test(`failed remote image pull propagates from ${context} context and removes private proof`, () => {
    const result = runConnector({ context, pullStatus: 42 });
    assert.equal(result.status, 42, result.stderr);
    assert.deepEqual(result.events, ['proof|600', 'pull']);
    assert.equal(result.created.length, 1);
    assert.deepEqual(result.remainingRequests, []);
  });
}

for (const context of ['deploy', 'deploy_or', 'deploy_if']) {
  for (const [failure, statuses, expectedEvents] of [
    ['local proof', { proofStatus: 41 }, ['sync', 'plan', 'proof|600']],
    ['remote pull', { pullStatus: 42 }, ['sync', 'plan', 'proof|600', 'pull']],
  ]) {
    test(`deployment in ${context} stops after a failed ${failure} without launching runtime`, () => {
      const result = runConnector({ ...statuses, context });
      assert.equal(result.status, statuses.proofStatus ?? statuses.pullStatus, result.stderr);
      assert.deepEqual(result.events, expectedEvents);
      assert.deepEqual(result.remainingRequests, []);
    });
  }
}

test('normal deployment launches runtime once after successful private image delivery', () => {
  const result = runConnector();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, ['sync', 'plan', 'proof|600', 'pull', 'runtime']);
  assert.deepEqual(result.remainingRequests, []);
});
