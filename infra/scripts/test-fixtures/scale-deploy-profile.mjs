import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../../..');
export const SCALE_MACHINE_ID = 'a'.repeat(32);
export const SCALE_PUBLIC_ORIGIN = 'https://loadtest.example.invalid';

// FLAG: Relocate fixed identity literals only in disposable source copies.
// Production has no fixture path, identity-file override or admission bypass.
export function scaleHostIdentityFixture(directory) {
  const host = join(directory, 'synthetic-host');
  const machine = join(host, 'machine-id');
  const production = join(host, 'production-checkout');
  mkdirSync(host);
  writeFileSync(machine, `${SCALE_MACHINE_ID}\n`, { mode: 0o600 });
  const helper = join(directory, 'infra/scripts/lib/scale-deploy-profile.sh');
  let source = readFileSync(helper, 'utf8');
  for (const [literal, replacement] of [
    ['/etc/machine-id', machine],
    ['/var/www/Chat_bot', production],
  ]) {
    assert.equal(source.split(literal).length, 2, `Expected one fixed ${literal} identity literal`);
    source = source.replaceAll(literal, replacement);
    assert.equal(source.includes(literal), false);
  }
  writeFileSync(helper, source);
  return { machine, production };
}

export function scaleHostEnvironment(directory) {
  return {
    MAXIM_ALLOW_SCALE_DEPLOY: '1',
    MAXIM_SCALE_DEPLOY_PROFILE: 'isolated-loadtest-v1',
    MAXIM_SCALE_EXPECTED_MACHINE_ID: SCALE_MACHINE_ID,
    MAXIM_SCALE_EXPECTED_REPO_DIR: realpathSync(directory),
    MAXIM_VPS_PUBLIC_URL: SCALE_PUBLIC_ORIGIN,
    DOCKER_HOST: '',
    DOCKER_CONTEXT: '',
    SSH_CONNECTION: '198.51.100.10 12345 192.0.2.40 22',
  };
}

function shellValue(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function configureScaleSync(
  directory,
  bin,
  env,
  { identity, reexec = false, mutation = '', mutationPhase = 'post-sync' },
) {
  const scriptPath = 'infra/scripts/vps-pull-build-up-scale.sh';
  const helperPath = 'infra/scripts/lib/scale-deploy-profile.sh';
  const sources = join(directory, 'synthetic-git-sources');
  const candidate = join(directory, 'synthetic-legacy-entrypoint');
  const sha = (number) => String(number).padStart(40, '0');
  assert.ok(
    [
      '',
      'legacy-entrypoint',
      'missing-helper',
      'safe-entrypoint',
      'head-drift',
      'disk-only-noncritical',
    ].includes(mutation),
  );
  assert.ok(['post-sync', 'remote', 'local'].includes(mutationPhase));
  writeFileSync(
    join(directory, 'infra/scripts/lib/legacy-cold-maintenance.sh'),
    `maxim_require_ordinary_effect_authority() {
  printf '%s\\n' authority-checked >>"$SCALE_TEST_LOG"
  SCALE_TEST_AUTHORITY_COUNT=$((\${SCALE_TEST_AUTHORITY_COUNT:-0} + 1))
  export SCALE_TEST_AUTHORITY_COUNT
  if [[ "\${SCALE_TEST_REEXEC_COLD_REFUSAL:-0}" == 1 && "$SCALE_TEST_AUTHORITY_COUNT" -ge 3 && -e "$SCALE_TEST_SYNCED" ]]; then
    printf '%s\\n' 'cold fixture authority refused' >&2
    return 73
  fi
  return 0
}
`,
  );
  writeFileSync(
    candidate,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' legacy-effect >>"$SCALE_TEST_LOG"
exit 97
`,
    { mode: 0o755 },
  );
  for (const number of [1, 2, 3, 4]) {
    for (const path of [scriptPath, helperPath]) {
      const destination = join(sources, sha(number), path);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      cpSync(join(directory, path), destination);
    }
  }
  const mutatedCandidate = join(sources, sha(mutationPhase === 'local' ? 3 : 2));
  if (mutationPhase !== 'post-sync') {
    if (mutation === 'legacy-entrypoint') cpSync(candidate, join(mutatedCandidate, scriptPath));
    else if (mutation === 'missing-helper') rmSync(join(mutatedCandidate, helperPath));
  }
  const safeCandidate = join(directory, 'synthetic-safe-entrypoint');
  if (['safe-entrypoint', 'disk-only-noncritical'].includes(mutation)) {
    const source = readFileSync(join(directory, scriptPath), 'utf8');
    const mainStart = '\nif ! command -v docker >/dev/null 2>&1; then\n';
    assert.equal(source.split(mainStart).length, 2);
    writeFileSync(
      safeCandidate,
      source.replace(
        mainStart,
        `\n${'# Disposable noncritical update changes source byte offsets.\n'.repeat(128)}${mainStart}`,
      ),
    );
    if (mutation === 'safe-entrypoint') cpSync(safeCandidate, join(sources, sha(2), scriptPath));
  }
  Object.assign(env, {
    SCALE_TEST_MACHINE_FILE: identity?.machine ?? '',
    SCALE_TEST_SOURCE_MUTATION: mutation,
    SCALE_TEST_MUTATION_PHASE: mutationPhase,
    SCALE_TEST_LEGACY_ENTRYPOINT: candidate,
    SCALE_TEST_SAFE_ENTRYPOINT: safeCandidate,
    SCALE_TEST_SERVER_SCRIPT: join(directory, scriptPath),
    SCALE_TEST_PROFILE_HELPER: join(directory, helperPath),
    SCALE_TEST_GIT_SOURCES: sources,
    SCALE_TEST_SYNCED: join(directory, 'synthetic-sync-completed'),
    SCALE_TEST_REEXEC: reexec ? '1' : '0',
    SCALE_TEST_REEXEC_COLD_REFUSAL: mutation === 'safe-entrypoint' ? '1' : '0',
  });
  if (!reexec) env.MAXIM_DEPLOY_SCRIPT_REEXECED = '1';
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'git-fixture:%s\\n' "$*" >>"$SCALE_TEST_LOG"
case "$1" in
  fetch|show-ref|checkout|status) exit 0 ;;
  rev-parse)
    case "\${*:2}" in
      *refs/remotes/origin/*|*origin/main*) printf '%040d\\n' 2 ;;
      *refs/heads/*) printf '%040d\\n' 3 ;;
      *HEAD*)
        if [[ ! -e "$SCALE_TEST_SYNCED" ]]; then printf '%040d\\n' 1
        elif [[ "$SCALE_TEST_SOURCE_MUTATION" == head-drift ]]; then printf '%040d\\n' 4
        else printf '%040d\\n' 2; fi ;;
      *) printf '%s\\n' git-prohibited >>"$SCALE_TEST_LOG"; exit 97 ;;
    esac
    exit 0 ;;
  show)
    spec="$2"
    sha="\${spec%%:*}"
    path="\${spec#*:}"
    [[ "$sha" =~ ^0{39}[1234]$ ]] || exit 97
    case "$path" in
      infra/scripts/vps-pull-build-up-scale.sh|infra/scripts/lib/scale-deploy-profile.sh) ;;
      *) printf '%s\\n' git-prohibited >>"$SCALE_TEST_LOG"; exit 97 ;;
    esac
    [[ -f "$SCALE_TEST_GIT_SOURCES/$sha/$path" ]] || exit 128
    cat "$SCALE_TEST_GIT_SOURCES/$sha/$path"
    exit 0 ;;
  merge)
    [[ "$2" == --ff-only && "$3" == 0000000000000000000000000000000000000002 ]] || exit 97
    printf '%s\\n' changed >"$SCALE_TEST_SYNCED"
    if [[ -n "$SCALE_TEST_MACHINE_FILE" ]]; then printf '%032d\\n' 2 >"$SCALE_TEST_MACHINE_FILE"; fi
    if [[ "$SCALE_TEST_MUTATION_PHASE" == post-sync ]]; then
      if [[ "$SCALE_TEST_SOURCE_MUTATION" == legacy-entrypoint ]]; then
        cp "$SCALE_TEST_LEGACY_ENTRYPOINT" "$SCALE_TEST_SERVER_SCRIPT.new"
        mv "$SCALE_TEST_SERVER_SCRIPT.new" "$SCALE_TEST_SERVER_SCRIPT"
      elif [[ "$SCALE_TEST_SOURCE_MUTATION" == missing-helper ]]; then
        rm "$SCALE_TEST_PROFILE_HELPER"
      elif [[ "$SCALE_TEST_SOURCE_MUTATION" == safe-entrypoint ]]; then
        cp "$SCALE_TEST_GIT_SOURCES/0000000000000000000000000000000000000002/infra/scripts/vps-pull-build-up-scale.sh" "$SCALE_TEST_SERVER_SCRIPT"
      elif [[ "$SCALE_TEST_SOURCE_MUTATION" == disk-only-noncritical ]]; then
        cp "$SCALE_TEST_SAFE_ENTRYPOINT" "$SCALE_TEST_SERVER_SCRIPT"
      fi
    fi
    exit 0 ;;
  diff)
    [[ "$SCALE_TEST_REEXEC" == 0 ]]
    exit $? ;;
esac
printf '%s\\n' git-prohibited >>"$SCALE_TEST_LOG"
exit 97
`,
  );
}

// FLAG: Execute disposable copies with rejecting tools. No fixture may connect to
// SSH, a Docker daemon, Git remotes or the real protected host identity files.
export function scaleDeployFixture({ server = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-scale-profile-'));
  const bin = join(directory, 'bin');
  const log = join(directory, 'calls.log');
  const sshArguments = join(directory, 'ssh-arguments');
  const profile = join(directory, 'loadtest.env');
  mkdirSync(bin);
  cpSync(join(root, 'infra/scripts'), join(directory, 'infra/scripts'), { recursive: true });
  const hostIdentity =
    server && existsSync(join(directory, 'infra/scripts/lib/scale-deploy-profile.sh'))
      ? scaleHostIdentityFixture(directory)
      : null;
  writeFileSync(
    join(directory, '.env.vps'),
    'MAXIM_VPS_SSH_TARGET=maxim-vps\nMAXIM_VPS_REPO_DIR=/var/www/Chat_bot\nMAXIM_VPS_PUBLIC_URL=https://major-maksimov.ru\nMAXIM_VPS_AUTO_AUTHORIZE_SSH=0\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(directory, 'infra/scripts/lib/deploy-lock.sh'),
    `acquire_deploy_lock() {
  printf '%s\\n' lock-acquired >>"$SCALE_TEST_LOG"
  exit 97
}
`,
  );
  writeFileSync(
    join(bin, 'ssh'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *' -G '* ]]; then
  printf '%s\\n' ssh-config >>"$SCALE_TEST_LOG"
  printf 'hostname %s\\n' "\${SCALE_TEST_EFFECTIVE_HOST:-scale.invalid}"
  printf '%s\\n' 'user scale' 'port 22'
  exit 0
fi
printf '%s\\n' ssh-remote >>"$SCALE_TEST_LOG"
printf '%s\\0' "$@" >"$SCALE_TEST_SSH_ARGUMENTS"
exit 97
`,
  );
  writeFileSync(
    join(bin, 'hostname'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == -I ]] || exit 97
printf '%s\\n' host-read >>"$SCALE_TEST_LOG"
[[ "\${SCALE_TEST_HOST_READ_FAIL:-0}" == 0 ]] || exit 97
printf '%s\\n' "\${SCALE_TEST_HOST_ADDRESSES-192.0.2.40}"
`,
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'context show')
    printf '%s\\n' docker-context-show >>"$SCALE_TEST_LOG"
    printf '%s\\n' "\${SCALE_TEST_DOCKER_CONTEXT-default}"
    exit 0 ;;
  "context inspect default --format {{.Endpoints.docker.Host}}")
    printf '%s\\n' docker-context-inspect >>"$SCALE_TEST_LOG"
    printf '%s\\n' "\${SCALE_TEST_DOCKER_ENDPOINT-unix:///var/run/docker.sock}"
    exit 0 ;;
esac
printf 'docker-prohibited:%s\\n' "$*" >>"$SCALE_TEST_LOG"
exit 97
`,
  );
  for (const command of ['git', 'node', 'npm', 'yc', 'curl']) {
    writeFileSync(
      join(bin, command),
      `#!/usr/bin/env bash
printf '%s\\n' '${command}-prohibited' >>"$SCALE_TEST_LOG"
exit 97
`,
    );
  }
  for (const command of ['ssh', 'hostname', 'docker', 'git', 'node', 'npm', 'yc', 'curl'])
    chmodSync(join(bin, command), 0o755);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    SCALE_TEST_LOG: log,
    SCALE_TEST_SSH_ARGUMENTS: sshArguments,
    MAXIM_ALLOW_SCALE_DEPLOY: '1',
  };
  return {
    directory,
    bin,
    env,
    log,
    profile,
    writeProfile(patch = {}, path = profile) {
      const values = {
        MAXIM_SCALE_DEPLOY_PROFILE: 'isolated-loadtest-v1',
        MAXIM_SCALE_EXPECTED_MACHINE_ID: SCALE_MACHINE_ID,
        MAXIM_VPS_SSH_TARGET: 'scale-test',
        MAXIM_VPS_REPO_DIR: directory,
        MAXIM_VPS_PUBLIC_URL: SCALE_PUBLIC_ORIGIN,
        MAXIM_VPS_AUTO_AUTHORIZE_SSH: '0',
        ...patch,
      };
      writeFileSync(
        path,
        Object.entries(values)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${shellValue(value)}\n`)
          .join(''),
        { mode: 0o600 },
      );
      return path;
    },
    admitServer() {
      const identity = hostIdentity ?? scaleHostIdentityFixture(directory);
      Object.assign(env, scaleHostEnvironment(directory));
      writeFileSync(
        join(directory, 'infra/scripts/lib/deploy-lock.sh'),
        `acquire_deploy_lock() {
  printf '%s\\n' lock-acquired >>"$SCALE_TEST_LOG"
  export SCALE_TEST_LOCK_HELD=1
  trap 'printf "%s\\n" lock-released >>"$SCALE_TEST_LOG"' EXIT
}
require_deploy_lock() { [[ "\${SCALE_TEST_LOCK_HELD:-0}" == 1 ]]; }
`,
      );
      writeFileSync(
        join(directory, 'infra/scripts/lib/legacy-cold-maintenance.sh'),
        `maxim_require_ordinary_effect_authority() {
  printf '%s\\n' authority-checked >>"$SCALE_TEST_LOG"
  printf '%s\\n' 'cold fixture authority refused' >&2
  return 73
}
`,
      );
      return identity;
    },
    syncThenInvalidate(identity, { reexec = false } = {}) {
      configureScaleSync(directory, bin, env, { identity, reexec });
    },
    syncThenRemoveAdmission(options = {}) {
      configureScaleSync(directory, bin, env, { mutation: 'legacy-entrypoint', ...options });
    },
    syncThenUpdateEntrypoint() {
      configureScaleSync(directory, bin, env, { reexec: true, mutation: 'safe-entrypoint' });
    },
    sshArguments() {
      return readFileSync(sshArguments).toString().split('\0').filter(Boolean);
    },
    run(name, args = [], extra = {}) {
      return spawnSync('bash', [join(directory, 'infra/scripts', name), ...args], {
        cwd: directory,
        env: { ...env, ...extra },
        encoding: 'utf8',
        timeout: 10_000,
      });
    },
    calls() {
      try {
        return readFileSync(log, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
