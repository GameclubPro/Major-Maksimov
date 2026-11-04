import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(root, 'infra/scripts/lib/deploy-git-transport.sh');
function probe(body, env = {}) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
source "$1"
git() {
  case "$1 $2" in
    'remote get-url') printf '%s' "$TEST_ORIGIN" ;;
    'config --get') printf '%s' "$TEST_SSH_COMMAND" ;;
    *) return 1 ;;
  esac
}
${body}`,
      'transport-test',
      helper,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_SSH_COMMAND: '',
        GIT_SSH: '',
        GIT_SSH_VARIANT: '',
        TEST_ORIGIN: 'git@github.com:example/repo.git',
        TEST_SSH_COMMAND: "ssh -i '/private/deploy identity' -o IdentitiesOnly=yes",
        ...env,
      },
    },
  );
}

test('443 transport preserves the configured deploy identity and enforces noninteractive host verification', () => {
  const result = probe('maxim_configure_git_ssh_transport 443\nprintf "%s" "$GIT_SSH_COMMAND"');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("ssh -i '/private/deploy identity' -o IdentitiesOnly=yes "));
  for (const flag of [
    'HostName=ssh.github.com',
    'HostKeyAlias=github.com',
    '-p 443',
    'ConnectTimeout=10',
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
  ])
    assert.ok(result.stdout.includes(flag), flag);
});

test('caller SSH command takes precedence and default mode is unchanged', () => {
  const env = { GIT_SSH_COMMAND: 'ssh -i /caller/identity' };
  const selected = probe(
    'maxim_configure_git_ssh_transport 22\nprintf "%s" "$GIT_SSH_COMMAND"',
    env,
  );
  assert.equal(selected.status, 0, selected.stderr);
  assert.ok(selected.stdout.startsWith(`${env.GIT_SSH_COMMAND} `));
  assert.match(selected.stdout, /HostName=github\.com.*-p 22/u);
  const unchanged = probe(
    'maxim_configure_git_ssh_transport default\nprintf "%s" "$GIT_SSH_COMMAND"',
    env,
  );
  assert.equal(unchanged.stdout, env.GIT_SSH_COMMAND);
});

test('rejects invalid ports and non-GitHub/non-SSH origins without exposing their contents', () => {
  for (const port of ['444', '443;false']) {
    const result = probe('maxim_configure_git_ssh_transport "$TEST_PORT"', { TEST_PORT: port });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  for (const origin of [
    'https://github.com/example/repo.git',
    'git@elsewhere.invalid:example/repo.git',
  ]) {
    const result = probe('maxim_configure_git_ssh_transport 443', { TEST_ORIGIN: origin });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(origin));
  }
});

test('transport bootstrap works before the VPS has the new helper file', () => {
  const result = probe(`remote_command='printf "%s" "$GIT_SSH_COMMAND"'
maxim_prepend_git_ssh_transport remote_command 443
export -f git
bash -c "$remote_command"`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deploy identity.*HostName=ssh.github.com/u);
});

test('ordinary deploy retains exact-SHA CI before selecting remote transport', () => {
  const wrapper = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const deploy = wrapper.slice(
    wrapper.indexOf('deploy_main() {'),
    wrapper.indexOf('\nprepare_registry_release_images()'),
  );
  assert.ok(
    deploy.indexOf('node scripts/ci/assert-green.mjs') <
      deploy.indexOf('maxim_prepend_git_ssh_transport'),
  );
  assert.match(deploy, /MAXIM_EXPECTED_DEPLOY_SHA/u);
  assert.match(deploy, /assert-green\.mjs "\$expected_sha" --purpose production/u);
  assert.match(deploy, /maxim_prepend_git_ssh_transport remote_command/u);
  assert.ok(
    deploy.indexOf('prepare_registry_release_images "$branch" "$expected_sha" "$remote_command"') <
      deploy.lastIndexOf('remote_exec "$remote_command"'),
  );
  assert.equal(deploy.match(/remote_exec /gu)?.length, 1);
});

function releasePreparationProbe(env = {}) {
  const wrapper = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
  const preparation = wrapper.slice(
    wrapper.indexOf('prepare_registry_release_images() {'),
    wrapper.indexOf('\nfinalize_release_recovery()'),
  );
  const quoteStart = wrapper.indexOf('shell_quote_args() {');
  const quoteEnd = wrapper.indexOf('\n}\n', quoteStart) + 2;
  assert.ok(quoteStart >= 0 && quoteEnd > quoteStart);
  return probe(
    `${wrapper.slice(quoteStart, quoteEnd)}
${preparation}
MAXIM_DEPLOY_GIT_SSH_PORT=443
remote_exec() {
  [[ "$1" == *'maxim_configure_git_ssh_transport 443 &&'* ]] || return 98
  if [[ "$1" == *' --image-plan'* ]]; then
    printf 'SSH|image-plan|443\\n' >&2
    printf 'MAXIM_IMAGE_PLAN={"schemaVersion":1,"sourceSha":"%s","components":["api-shared","admin-static"]}\\n' "$TEST_PLAN_SHA"
  elif [[ "$1" == *' --plan'* ]]; then
    printf 'SSH|sync|443\\n' >&2
  else
    printf 'SSH|runtime|443\\n' >&2
  fi
}
preload_ci_image() {
  [[ "$2" == "$TEST_RELEASE_SHA" ]] || return 97
  printf 'PULL|%s|%s\\n' "$1" "$2" >&2
  [[ "$1" != "$TEST_REJECT_COMPONENT" ]] || return 44
}
runtime_command="MAXIM_EXPECTED_DEPLOY_SHA=$TEST_RELEASE_SHA ./infra/scripts/vps-pull-build-up.sh main --auto"
maxim_prepend_git_ssh_transport runtime_command 443
prepare_registry_release_images main "$TEST_RELEASE_SHA" "$runtime_command"
remote_exec "$runtime_command"`,
    {
      TEST_RELEASE_SHA: 'a'.repeat(40),
      TEST_PLAN_SHA: 'a'.repeat(40),
      TEST_REJECT_COMPONENT: '',
      ...env,
    },
  );
}

test('the selected transport spans synchronized planning, immutable image preload and the final executor in order', () => {
  const result = releasePreparationProbe();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stderr.trim().split('\n'), [
    'SSH|sync|443',
    'SSH|image-plan|443',
    `PULL|api-shared|${'a'.repeat(40)}`,
    `PULL|admin-static|${'a'.repeat(40)}`,
    'SSH|runtime|443',
  ]);
  assert.equal(result.stdout, '');
});

test('a stale image plan or failed preload prevents the final runtime SSH command', () => {
  const stale = releasePreparationProbe({ TEST_PLAN_SHA: 'b'.repeat(40) });
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /source or components differ/u);
  assert.doesNotMatch(stale.stderr, /PULL\||SSH\|runtime/u);
  const failed = releasePreparationProbe({ TEST_REJECT_COMPONENT: 'admin-static' });
  assert.equal(failed.status, 44, failed.stderr);
  assert.match(failed.stderr, /PULL\|admin-static/u);
  assert.doesNotMatch(failed.stderr, /SSH\|runtime/u);
});
