#!/usr/bin/env bash

# FLAG: Every supported runtime mutator must use this fixed, persistent inode.
# Before installing flock-v1, separately prove that no incompatible legacy
# operation is running. An absent legacy directory cannot prove that fact.
# Never unlink this file, clean a legacy lock, or unlock an inherited descriptor.
MAXIM_PAIR_RELEASE_HELPER="${BASH_SOURCE[0]%/*}/pair-release-admission.sh"

maxim_pair_release_required() {
  local item actual
  # FLAG: Inherited root/source_dir/PWD values do not establish another product's scope.
  actual="$(pwd -P)" || return 0
  [[ "$actual" != /var/www/svyazka && "$actual" != /var/www/svyazka/* ]] || return 1
  for item in "${BASH_SOURCE[@]}"; do
    actual="$(readlink -e -- "$item" 2>/dev/null)" || continue
    [[ "$actual" != /var/www/svyazka && "$actual" != /var/www/svyazka/* ]] || return 1
  done
  return 0
}

maxim_pair_release_load() {
  maxim_pair_release_required || return 0
  # shellcheck source=infra/scripts/lib/pair-release-admission.sh
  source "$MAXIM_PAIR_RELEASE_HELPER"
}

maxim_pair_release_assert() {
  maxim_pair_release_required || return 0
  maxim_pair_release_load && pair_release_admission_assert || return 1
}

maxim_pair_release_release() {
  maxim_pair_release_required || return 0
  maxim_pair_release_load && pair_release_admission_release
}

maxim_pair_release_mode() {
  local caller
  if [[ "${DEPLOY_MODE:-}" == plan ]]; then
    for caller in "${BASH_SOURCE[@]}"; do
      [[ "${caller##*/}" != vps-pull-build-up.sh ]] || { printf '%s\n' tooling; return; }
    done
  fi
  printf '%s\n' runtime
}

require_pair_release_admission_dispatch() {
  maxim_pair_release_required || return 0
  local target="$1" candidate entry proof_source release_source_floor_sha release_source_floor_path release_source_floor_mode release_source_floor_node
  # FLAG: The root-installed floor survives old rollback clients and every later checkout.
  # Validate executable trust before calling it; candidate bytes are inspected without execution.
  if [[ -e /etc/maxim-release/installed || -L /etc/maxim-release/installed ]]; then
    for release_source_floor_path in /etc /etc/maxim-release /usr /usr/local /usr/local/lib \
      /usr/local/lib/maxim-release /usr/local/lib/maxim-release/infra /usr/local/lib/maxim-release/infra/scripts; do
      [[ -d "$release_source_floor_path" && ! -L "$release_source_floor_path" \
        && "$(stat -c %u -- "$release_source_floor_path")" == 0 ]] || return 1
      release_source_floor_mode="$(stat -c %a -- "$release_source_floor_path")" || return 1
      [[ "$release_source_floor_mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$release_source_floor_mode & 0022) == 0 )) || return 1
    done
    release_source_floor_path=/usr/local/lib/maxim-release/infra/scripts/release-service-source-floor.mjs
    [[ -f "$release_source_floor_path" && ! -L "$release_source_floor_path" \
      && "$(stat -c '%u:%h' -- "$release_source_floor_path")" == 0:1 ]] || return 1
    release_source_floor_mode="$(stat -c %a -- "$release_source_floor_path")" || return 1
    [[ "$release_source_floor_mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$release_source_floor_mode & 0022) == 0 )) || return 1
    release_source_floor_node="$(PATH=/usr/local/bin:/usr/bin:/bin command -v node)" || return 1
    release_source_floor_node="$(readlink -e -- "$release_source_floor_node")" || return 1
    [[ ( "$release_source_floor_node" == /usr/bin/node || "$release_source_floor_node" == /usr/local/bin/node ) \
      && -f "$release_source_floor_node" && "$(stat -c %u -- "$release_source_floor_node")" == 0 ]] || return 1
    release_source_floor_mode="$(stat -c %a -- "$release_source_floor_node")" || return 1
    [[ "$release_source_floor_mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$release_source_floor_mode & 0022) == 0 )) || return 1
    release_source_floor_sha="$(git rev-parse --verify --end-of-options "${target}^{commit}")" || return 1
    /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/var/lib/maxim-release LANG=C.UTF-8 \
      "$release_source_floor_node" /usr/local/lib/maxim-release/infra/scripts/release-service-source-floor.mjs "$release_source_floor_sha" || return 1
  fi
  # FLAG: Older local rollback bootstraps already call this remote boundary before
  # checkout. The installed proof floor must reject a target that would erase it.
  if [[ -e /var/lib/maxim-deploy/eraser-connection-proof-reader-version || -L /var/lib/maxim-deploy/eraser-connection-proof-reader-version ]]; then
    proof_source="$(git rev-parse --verify --end-of-options "${target}^{commit}")" || return 1
    node "${BASH_SOURCE[0]%/*}/../assert-eraser-source.mjs" "$proof_source" --installed-connection-proof-reader tooling || return 1
  fi
  maxim_pair_release_load || return 1
  pair_release_admission_candidate "$target" infra/scripts/lib/pair-release-admission.sh || return 1
  candidate="$(git show "${target}:infra/scripts/lib/deploy-lock.sh")" || return 1
  grep -Eq '^maxim_pair_release_assert\(\)' <<<"$candidate" \
    && grep -Eq '^[[:space:]]*pair_release_admission_acquire major .*\|\| return 1$' <<<"$candidate" \
    && grep -Eq '^[[:space:]]*maxim_pair_release_assert && validate_deploy_lock_path && validate_deploy_lock_descriptor$' <<<"$candidate" || return 1
  for entry in infra/scripts/vps-pull-build-up.sh infra/scripts/vps-runtime-rollback.sh infra/scripts/vps-connect.sh; do
    candidate="$(git show "${target}:${entry}")" || return 1
    grep -Eq '^[[:space:]]*require_pair_release_admission_dispatch "' <<<"$candidate" || return 1
  done
}

deploy_lock_file() {
  printf '%s\n' /var/lib/maxim-deploy/deploy.lock
}

validate_deploy_lock_path() {
  local lock_file directory path metadata owner mode links directory_owner allow_create="${1:-0}"
  lock_file="$(deploy_lock_file)"
  directory="${lock_file%/*}"

  if [[ -n "${MAXIM_DEPLOY_LOCK_DIR:-}" ]]; then
    echo 'MAXIM_DEPLOY_LOCK_DIR is no longer supported; the deploy lock path is fixed.' >&2
    return 1
  fi
  if [[ -e /tmp/maxim-main-deploy.lock || -L /tmp/maxim-main-deploy.lock ]]; then
    echo 'Legacy deploy lock exists; refusing admission without removing or adopting it.' >&2
    return 1
  fi

  for path in /var /var/lib /var/lib/maxim-deploy; do
    if [[ ! -d "$path" || -L "$path" ]]; then
      echo 'Deploy lock requires an existing protected directory without symlinks.' >&2
      return 1
    fi
    metadata="$(stat -c '%u %a' -- "$path")" || return 1
    read -r owner mode <<<"$metadata"
    if [[ ! "$owner" =~ ^[0-9]+$ || ! "$mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$mode & 0022) != 0 )) \
      || (( EUID != 0 && owner != 0 && owner != EUID )); then
      echo 'Deploy lock directory has an unsafe owner or write permissions.' >&2
      return 1
    fi
  done
  directory_owner="$(stat -c '%u' -- "$directory")" || return 1
  if [[ ! -e "$lock_file" && ! -L "$lock_file" ]]; then
    if [[ "$allow_create" != 1 || "$directory_owner" != "$EUID" ]]; then
      echo 'The deploy directory owner must provision the persistent lock file first.' >&2
      return 1
    fi
    # Concurrent first admission may create the same file, but never replaces it.
    (umask 077; set -o noclobber; : >"$lock_file") 2>/dev/null || true
  fi
  if [[ ! -f "$lock_file" || -L "$lock_file" ]]; then
    echo 'Deploy lock must be a regular file without symlinks.' >&2
    return 1
  fi
  metadata="$(stat -c '%u %a %h' -- "$lock_file")" || return 1
  read -r owner mode links <<<"$metadata"
  if [[ "$owner" != "$directory_owner" || "$mode" != 600 || "$links" != 1 ]]; then
    echo 'Deploy lock requires directory ownership, mode 0600 and one hard link.' >&2
    return 1
  fi
}

validate_deploy_lock_descriptor() {
  local owner_pid="$BASHPID" lock_file identity descriptor_identity line locked=0
  if [[ "${MAXIM_DEPLOY_LOCK_VERSION:-}" != flock-v1 \
    || "${MAXIM_DEPLOY_LOCK_OWNER_PID:-}" != "$owner_pid" \
    || ! "${MAXIM_DEPLOY_LOCK_FD:-}" =~ ^[1-9][0-9]{1,5}$ \
    || ! "${MAXIM_DEPLOY_LOCK_IDENTITY:-}" =~ ^[0-9]+:[0-9]+$ ]]; then
    echo 'Invalid or foreign inherited deploy lock ownership.' >&2
    return 1
  fi
  lock_file="$(deploy_lock_file)"
  identity="$(stat -c '%d:%i' -- "$lock_file")" || return 1
  descriptor_identity="$(stat -Lc '%d:%i' -- "/proc/$owner_pid/fd/$MAXIM_DEPLOY_LOCK_FD")" || return 1
  if [[ "$identity" != "$MAXIM_DEPLOY_LOCK_IDENTITY" || "$descriptor_identity" != "$identity" ]]; then
    echo 'Deploy lock descriptor no longer refers to the protected inode.' >&2
    return 1
  fi
  # FLAG: A matching open FD/environment alone is not lock authority. fdinfo
  # positively proves the inherited open description still owns the whole lock.
  while IFS= read -r line; do
    if [[ "$line" =~ ^lock:[[:space:]]+[0-9]+:[[:space:]]+FLOCK[[:space:]]+ADVISORY[[:space:]]+WRITE[[:space:]]+[0-9]+[[:space:]]+[^[:space:]]+[[:space:]]+0[[:space:]]+EOF$ ]]; then
      locked=1
    fi
  done <"/proc/$owner_pid/fdinfo/$MAXIM_DEPLOY_LOCK_FD"
  if ((locked != 1)); then
    echo 'Deploy lock descriptor has no exclusive whole-file flock.' >&2
    return 1
  fi
}

require_deploy_lock() {
  maxim_pair_release_assert && validate_deploy_lock_path && validate_deploy_lock_descriptor
}

major_market_release_trust() {
  local path metadata owner mode links
  # FLAG: Candidate checkouts cannot replace this protected admission reader.
  for path in /etc /etc/maxim-deploy /etc/maxim-deploy/major-market-release; do
    [[ -d "$path" && ! -L "$path" ]] || return 1
    metadata="$(stat -c '%u %a' -- "$path")" || return 1
    read -r owner mode <<<"$metadata"
    [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 )) || return 1
  done
  for path in /etc/maxim-deploy/major-market-release/guard.mjs /etc/maxim-deploy/major-market-release/protocol-v1.json; do
    [[ -f "$path" && ! -L "$path" ]] || return 1
    metadata="$(stat -c '%u %a %h' -- "$path")" || return 1
    read -r owner mode links <<<"$metadata"
    [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ && "$links" == 1 ]] && (( (8#$mode & 0022) == 0 )) || return 1
  done
}

validate_major_market_release_admission() {
  local actual_source actual_owner=major
  if [[ ! -e /etc/maxim-deploy/major-market-release && ! -L /etc/maxim-deploy/major-market-release ]]; then
    [[ -z "${MAJOR_MARKET_RELEASE_EXPECTED_STATE_SHA256:-}${MAJOR_MARKET_RELEASE_EXPECTATION_B64:-}" ]] || {
      echo 'Major/Market coordinated release guard is not installed.' >&2; return 1;
    }
    return 0
  fi
  major_market_release_trust || return 1
  actual_source="$(pwd -P)" || return 1
  if [[ "$actual_source" == /var/www/svyazka || "$actual_source" == /var/www/svyazka/* ]]; then
    actual_owner=market
    actual_source="${source_dir:-}"
  fi
  node /etc/maxim-deploy/major-market-release/guard.mjs admit --owner "$actual_owner" --source "$actual_source" >/dev/null
}

require_major_market_release_dispatch() {
  [[ -e /etc/maxim-deploy/major-market-release || -L /etc/maxim-deploy/major-market-release ]] || return 0
  validate_major_market_release_admission || return 1
  node /etc/maxim-deploy/major-market-release/guard.mjs check-source --owner major --source "$(pwd -P)" --ref "$1" >/dev/null
}

major_market_release_verify() {
  [[ -e /etc/maxim-deploy/major-market-release || -L /etc/maxim-deploy/major-market-release ]] || {
    [[ -z "${MAJOR_MARKET_RELEASE_EXPECTED_STATE_SHA256:-}${MAJOR_MARKET_RELEASE_EXPECTATION_B64:-}" ]]; return;
  }
  major_market_release_trust || return 1
  local selected='' component
  if declare -p DEPLOYED_COMPONENTS >/dev/null 2>&1; then
    for component in "${DEPLOYED_COMPONENTS[@]}"; do selected+="$component,"; done
    selected="$(tr ',' '\n' <<<"$selected" | sed '/^$/d' | sort -u | paste -sd, -)"
  else
    selected=api-shared
  fi
  node /etc/maxim-deploy/major-market-release/guard.mjs verify --owner major --phase "$1" \
    --source "$(pwd -P)" --target-sha "${TARGET_SHA:-${TARGET_FULL_SHA:-}}" --components "$selected" >/dev/null
}

validate_market_statistics_deploy_admission() {
  local market_scope=0 market_path market_metadata market_owner market_mode market_links
  local market_source_dir="${source_dir:-}" market_release="${release:-}"
  if [[ "${root:-}" == /var/www/svyazka || "$market_source_dir" == /var/www/svyazka/* ]]; then
    market_scope=1
  fi
  for market_path in "$PWD" "${BASH_SOURCE[@]}"; do
    if [[ "$market_path" == /var/www/svyazka || "$market_path" == /var/www/svyazka/* ]]; then
      market_scope=1
    fi
  done
  ((market_scope == 1)) || return 0
  # FLAG: Market's installed statistics floor must fence legacy callers too.
  # This root-owned trust chain is separate from deploy-user-writable releases.
  for market_path in /etc /etc/maxim-deploy /etc/maxim-deploy/market-statistics; do
    [[ -d "$market_path" && ! -L "$market_path" ]] || {
      echo 'Market statistics deployment admission is not installed.' >&2; return 1;
    }
    market_metadata="$(stat -c '%u %a' -- "$market_path")" || return 1
    read -r market_owner market_mode <<<"$market_metadata"
    if [[ "$market_owner" != 0 || ! "$market_mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$market_mode & 0022) != 0 )); then
      echo 'Market statistics deployment admission has an unsafe trust directory.' >&2
      return 1
    fi
  done
  market_path=/etc/maxim-deploy/market-statistics/admission.mjs
  [[ -f "$market_path" && ! -L "$market_path" ]] || return 1
  market_metadata="$(stat -c '%u %a %h' -- "$market_path")" || return 1
  read -r market_owner market_mode market_links <<<"$market_metadata"
  if [[ "$market_owner" != 0 || ! "$market_mode" =~ ^[0-7]{3,4}$ || "$market_links" != 1 ]] \
    || (( (8#$market_mode & 0022) != 0 )); then
    echo 'Market statistics deployment admission has an unsafe installed reader.' >&2
    return 1
  fi
  node "$market_path" --admit "$market_source_dir" "$market_release"
}

require_market_statistics_lock_dispatch() {
  # FLAG: This installed cross-project floor survives MAXIM checkout/re-exec and ref rollback.
  # Inspect reviewed Git bytes without executing candidate code or changing the checkout.
  [[ -e /etc/maxim-deploy/market-statistics || -L /etc/maxim-deploy/market-statistics ]] || return 0
  local target="$1" path size candidate
  for path in infra/scripts/lib/deploy-lock.sh infra/scripts/vps-pull-build-up.sh \
    infra/scripts/vps-runtime-rollback.sh infra/scripts/vps-connect.sh; do
    size="$(git cat-file -s "${target}:${path}" 2>/dev/null)" || {
      echo 'Candidate tooling loses the installed Market statistics admission floor.' >&2; return 1;
    }
    [[ "$size" =~ ^[0-9]{1,6}$ ]] && ((size > 0 && size <= 262144)) || return 1
    candidate="$(git show "${target}:${path}")" || return 1
    case "$path" in
      infra/scripts/lib/deploy-lock.sh)
        grep -Eq '^require_market_statistics_lock_dispatch\(\) \{' <<<"$candidate" \
          && grep -Eq '^validate_market_statistics_deploy_admission\(\) \{' <<<"$candidate" \
          && grep -Eq '^[[:space:]]*node "[$]market_path" --admit "[$]market_source_dir" "[$]market_release"$' <<<"$candidate" \
          && grep -Eq '^[[:space:]]*validate_market_statistics_deploy_admission \|\| return 1$' <<<"$candidate" \
          && grep -Eq '^[[:space:]]*if ! validate_market_statistics_deploy_admission; then$' <<<"$candidate" || return 1
        ;;
      infra/scripts/vps-pull-build-up.sh)
        grep -Eq '^[[:space:]]*require_market_statistics_lock_dispatch "origin/[$]BRANCH" \|\| return 2$' <<<"$candidate" \
          && grep -Eq '^[[:space:]]*require_market_statistics_lock_dispatch "refs/heads/[$]BRANCH" \|\| return 2$' <<<"$candidate" || return 1
        ;;
      infra/scripts/vps-runtime-rollback.sh)
        grep -Eq '^[[:space:]]*require_market_statistics_lock_dispatch "[$]TARGET_FULL_SHA" \|\| exit 1$' <<<"$candidate" || return 1
        ;;
      infra/scripts/vps-connect.sh)
        grep -Eq '^[[:space:]]*require_market_statistics_lock_dispatch "[$]expected_tooling_sha" \|\| exit 1$' <<<"$candidate" || return 1
        ;;
    esac
  done
}

acquire_deploy_lock() {
  local lock_file identity admission_status pair_probe_fd pair_probe_path
  export MAXIM_DEPLOY_ADMISSION_REFUSAL=unknown
  if ! command -v flock >/dev/null 2>&1 || ! command -v stat >/dev/null 2>&1; then
    echo 'Linux flock, stat and procfs are required for the deploy lock.' >&2
    return 1
  fi
  if [[ -n "${MAXIM_DEPLOY_LOCK_VERSION:-}${MAXIM_DEPLOY_LOCK_OWNER_PID:-}${MAXIM_DEPLOY_LOCK_FD:-}${MAXIM_DEPLOY_LOCK_IDENTITY:-}" ]]; then
    maxim_pair_release_assert || return 1
    validate_deploy_lock_path || return 1
    validate_deploy_lock_descriptor || return 1
    trap release_deploy_lock EXIT
    validate_market_statistics_deploy_admission || return 1
    validate_major_market_release_admission || return 1
    return 0
  fi

  if maxim_pair_release_required; then
    maxim_pair_release_load || return 1
    # FLAG: The shared helper's historical 75 is ambiguous. Observe only an exact
    # kernel conflict on its validated inode, then close our descriptor before normal
    # admission. A later acquisition race remains unknown; never alter the shared helper.
    if [[ -z "${PAIR_RELEASE_ADMISSION_TOKEN:-}" ]]; then
      _pair_release_paths || return 1
      pair_probe_path="$(pair_release_admission_directory)/state/admission.lock"
      exec {pair_probe_fd}<>"$pair_probe_path" || return 1
      if flock -n -E 75 "$pair_probe_fd"; then
        exec {pair_probe_fd}>&-
      else
        admission_status=$?
        exec {pair_probe_fd}>&-
        if [[ "$admission_status" == 75 ]]; then MAXIM_DEPLOY_ADMISSION_REFUSAL=pair_lock_busy; fi
        return 1
      fi
    fi
    pair_release_admission_acquire major '' "$(maxim_pair_release_mode)" || return 1
  fi
  trap release_deploy_lock EXIT
  validate_deploy_lock_path 1 || { maxim_pair_release_release || true; return 1; }
  lock_file="$(deploy_lock_file)"
  identity="$(stat -c '%d:%i' -- "$lock_file")" || return 1
  exec {MAXIM_DEPLOY_LOCK_FD}<>"$lock_file" || return 1
  if flock -n -E 75 "$MAXIM_DEPLOY_LOCK_FD"; then
    :
  else
    admission_status=$?
    exec {MAXIM_DEPLOY_LOCK_FD}>&-
    unset MAXIM_DEPLOY_LOCK_FD
    if maxim_pair_release_release && [[ "$admission_status" == 75 ]]; then MAXIM_DEPLOY_ADMISSION_REFUSAL=product_lock_busy; fi
    echo 'Another supported deploy, rollback or runtime operation holds the deploy lock.' >&2
    return 1
  fi
  export MAXIM_DEPLOY_LOCK_VERSION=flock-v1
  export MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID"
  export MAXIM_DEPLOY_LOCK_IDENTITY="$identity"
  export MAXIM_DEPLOY_LOCK_FD
  if ! require_deploy_lock; then
    release_deploy_lock || true
    return 1
  fi
  trap release_deploy_lock EXIT
  if ! validate_market_statistics_deploy_admission; then
    release_deploy_lock || true
    return 1
  fi
  if ! validate_major_market_release_admission; then
    release_deploy_lock || true
    return 1
  fi
}

release_deploy_lock() {
  if [[ -z "${MAXIM_DEPLOY_LOCK_VERSION:-}${MAXIM_DEPLOY_LOCK_OWNER_PID:-}${MAXIM_DEPLOY_LOCK_FD:-}${MAXIM_DEPLOY_LOCK_IDENTITY:-}" ]]; then
    maxim_pair_release_release
    return
  fi
  validate_deploy_lock_descriptor || return 1
  # Closing only this process's FD keeps inherited child work fenced. flock -u
  # would release the shared open description while that work is still alive.
  exec {MAXIM_DEPLOY_LOCK_FD}>&-
  unset MAXIM_DEPLOY_LOCK_VERSION MAXIM_DEPLOY_LOCK_OWNER_PID MAXIM_DEPLOY_LOCK_IDENTITY MAXIM_DEPLOY_LOCK_FD
  maxim_pair_release_release
}

_maxim_deploy_controller_start() {
  local raw fields
  IFS= read -r raw <"/proc/$1/stat" || return 1
  read -r -a fields <<<"${raw##*) }"
  [[ "${fields[1]:-}" == "$2" && "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${fields[19]}"
}

_maxim_deploy_signal_controller() {
  local signal="$1" status="$2" observed
  command_signal_count=$((command_signal_count + 1))
  command_signal_status="$status"
  command_pending_signal="$signal"
  [[ -n "$command_pid" && -n "$command_start" ]] || return 0
  observed="$(_maxim_deploy_controller_start "$command_pid" "$command_owner")" || return 0
  if [[ "$observed" == "$command_start" ]]; then
    kill -s "$signal" "$command_pid" 2>/dev/null || true
  fi
}

supervise_deploy_lock_command() {
  local command_pid='' command_start='' command_owner="$BASHPID" command_status=70
  local command_signal_count=0 command_signal_status=0 command_pending_signal='' signal_count_before
  (($# > 0)) || return 2
  require_deploy_lock || return 1
  # FLAG: This terminal supervisor keeps the original admission owner alive. Only
  # an observed normal success may release it; interruption/failure keeps its evidence.
  trap - EXIT
  trap '_maxim_deploy_signal_controller INT 130' INT
  trap '_maxim_deploy_signal_controller TERM 143' TERM
  trap '_maxim_deploy_signal_controller HUP 129' HUP
  "$@" <&0 &
  command_pid=$!
  command_start="$(_maxim_deploy_controller_start "$command_pid" "$command_owner")" || command_start=''
  if [[ -n "$command_pending_signal" ]]; then
    _maxim_deploy_signal_controller "$command_pending_signal" "$command_signal_status"
  fi
  while :; do
    signal_count_before="$command_signal_count"
    if wait "$command_pid"; then
      command_status=0
      break
    else
      command_status=$?
    fi
    # FLAG: A trapped signal can interrupt wait before the child has finished.
    ((command_signal_count > signal_count_before)) || break
  done
  if ((command_signal_count > 0)); then
    ((command_status != 0)) || command_status="$command_signal_status"
  elif ((command_status == 0)); then
    # FLAG: The controller ended normally; finish the exact owner's cleanup.
    trap '' INT TERM HUP
    release_deploy_lock || command_status=70
  fi
  exit "$command_status"
}
