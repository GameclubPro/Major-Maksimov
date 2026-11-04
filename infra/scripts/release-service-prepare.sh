#!/usr/bin/env bash

maxim_release_prepare_environment() {
  local names name
  names="$(compgen -e)" || return 70
  while IFS= read -r name; do
    case "$name" in
      PATH|HOME|LANG|GIT_NO_REPLACE_OBJECTS|GIT_TERMINAL_PROMPT|PWD|OLDPWD|SHLVL|_) ;;
      *) echo 'Release preparation requires the service environment without overrides.' >&2; return 70 ;;
    esac
  done <<<"$names"
  [[ "${PATH:-}" == /usr/local/bin:/usr/bin:/bin &&
     "${HOME:-}" == /var/lib/maxim-release && "${LANG:-}" == C.UTF-8 &&
     "${GIT_NO_REPLACE_OBJECTS:-}" == 1 && "${GIT_TERMINAL_PROMPT:-}" == 0 ]] || {
    echo 'Release preparation requires the fixed service environment.' >&2; return 70;
  }
}

maxim_release_prepare_finish() {
  local status=$?
  trap - EXIT HUP INT TERM
  if release_deploy_lock; then
    :
  else
    ((status != 0)) || status=70
  fi
  exit "$status"
}

maxim_release_prepare_main() {
  set -euo pipefail
  local action id hash sha status image_plan expected_manifest origin
  local -r bundle=/usr/local/lib/maxim-release
  local -a controller_git_environment=()
  (($# == 4 || $# == 5)) || { echo 'Usage: release-service-prepare.sh prepare|result|reconcile UUID HASH SHA [MANIFEST_HASH]' >&2; return 64; }
  action="$1" id="$2" hash="$3" sha="$4" expected_manifest="${5:-}"
  [[ ( ( ( "$action" == prepare || "$action" == result ) && $# == 4 ) ||
       ( "$action" == reconcile && $# == 5 && "$expected_manifest" =~ ^[a-f0-9]{64}$ ) ) &&
     "$id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ &&
     "$hash" =~ ^[a-f0-9]{64}$ && "$sha" =~ ^[a-f0-9]{40}$ ]] || {
    echo 'Release preparation arguments are invalid.' >&2; return 64;
  }
  maxim_release_prepare_environment || return $?
  if node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
    :
  else
    echo 'Release preparation requires Node 24.' >&2; return 70
  fi
  cd /var/www/Chat_bot || return $?
  [[ "$(pwd -P)" == /var/www/Chat_bot ]] || return 70

  if [[ "$action" == prepare ]]; then
    # FLAG: No canonical source synchronization or plan may run before exact
    # trusted-main/CI admission. The installed reader owns correlated refusals.
    node "$bundle/infra/scripts/release-service-admission.mjs" preflight "$id" "$hash" || return $?
    origin="$(git remote get-url origin)" || return $?
    # FLAG: The public canonical HTTPS origin keeps anonymous HTTPS reads. Only
    # admitted SSH origins use the fixed key/host wrapper, scoped to controller children.
    case "$origin" in
      https://github.com/GameclubPro/Major-Maksimov.git) ;;
      git@github.com:GameclubPro/Major-Maksimov.git|ssh://git@github.com/GameclubPro/Major-Maksimov.git|ssh://git@ssh.github.com:443/GameclubPro/Major-Maksimov.git)
        controller_git_environment=("GIT_SSH_COMMAND=$bundle/infra/scripts/release-service-git-ssh.sh")
        ;;
      *) echo 'Release preparation requires the exact canonical Git origin.' >&2; return 70 ;;
    esac
    env "${controller_git_environment[@]}" MAXIM_EXPECTED_DEPLOY_SHA="$sha" ./infra/scripts/vps-pull-build-up.sh main --plan || return $?
  fi

  # shellcheck source=infra/scripts/lib/deploy-lock.sh
  source "$bundle/infra/scripts/lib/deploy-lock.sh" || return $?
  # shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
  source "$bundle/infra/scripts/lib/legacy-cold-maintenance.sh" || return $?
  if acquire_deploy_lock; then
    :
  else
    status=$?
    if [[ "$action" == prepare ]]; then
      case "${MAXIM_DEPLOY_ADMISSION_REFUSAL:-unknown}" in
        pair_lock_busy|product_lock_busy)
          printf '{"schemaVersion":1,"event":"SAFE_REFUSAL","id":"%s","requestHash":"%s","reasonCode":"LOCK_BUSY"}\n' \
            "$id" "$hash" >&3 || return 70
          return 75
          ;;
      esac
    fi
    return "$status"
  fi
  trap maxim_release_prepare_finish EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [[ "$action" == reconcile ]]; then
    # FLAG: Recovery only observes under the existing fences. It never deploys,
    # synchronizes source, adopts a queue pause or edits release/migration evidence.
    maxim_require_ordinary_effect_authority "$bundle" || return $?
    node "$bundle/infra/scripts/release-service-admission.mjs" reconcile "$id" "$hash" "$expected_manifest" || return $?
    return 0
  fi

  if [[ "$action" == result ]]; then
    node "$bundle/infra/scripts/release-service-admission.mjs" result "$id" "$hash" || return $?
    return 0
  fi

  maxim_require_ordinary_effect_authority "$bundle" || return $?
  # FLAG: Keep this pair owner alive at its original cwd. The child inherits both
  # fences, rebinds only its product-FD owner, and closes only its own descriptors.
  # Capture all stdout; the installed reader validates the single bounded plan.
  # shellcheck disable=SC2016 # BASHPID must be evaluated by the child shell.
  if image_plan="$(env "${controller_git_environment[@]}" MAXIM_EXPECTED_DEPLOY_SHA="$sha" /bin/bash -c '
    export MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID"
    exec ./infra/scripts/vps-pull-build-up.sh main --image-plan
  ')"; then
    :
  else
    status=$?
    return "$status"
  fi
  if printf '%s\n' "$image_plan" | node "$bundle/infra/scripts/release-service-admission.mjs" snapshot "$id" "$hash"; then
    :
  else
    status=$?
    return "$status"
  fi
  printf '{"schemaVersion":1,"event":"PREPARED","id":"%s","requestHash":"%s"}\n' "$id" "$hash" >&3 || return 70
}

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  maxim_release_prepare_main "$@"
fi
