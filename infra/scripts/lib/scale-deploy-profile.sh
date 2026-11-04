#!/usr/bin/env bash

maxim_scale_source_bytes() {
  cat -- "$1" && printf '\001'
}

MAXIM_SCALE_TRUSTED_HELPER_SOURCE="$(maxim_scale_source_bytes "${BASH_SOURCE[0]}")" || return 2
readonly MAXIM_SCALE_TRUSTED_HELPER_SOURCE

maxim_scale_refuse() {
  printf 'Scale deploy admission refused (%s).\n' "$1" >&2
  return 2
}

maxim_scale_production_root() {
  printf '%s\n' '/var/www/Chat_bot'
}

maxim_scale_require_profile_identity() {
  [[ "${MAXIM_SCALE_DEPLOY_PROFILE:-}" == isolated-loadtest-v1 ]] || {
    maxim_scale_refuse profile_required; return 2;
  }
  [[ "${MAXIM_SCALE_EXPECTED_MACHINE_ID:-}" =~ ^[0-9a-f]{32}$ ]] || {
    maxim_scale_refuse machine_identity_required; return 2;
  }
}

maxim_scale_require_nonproduction_host() {
  local host="${1,,}"
  host="${host##*@}"
  host="${host%.}"
  case "$host" in
    ''|maxim-vps|maxim-vps-yandex-retired|89.108.122.76|*89.108.122.76*)
      maxim_scale_refuse production_or_retired_host; return 2;
      ;;
  esac
}

maxim_scale_require_repo_path() {
  local path="$1"
  local production_root
  production_root="$(maxim_scale_production_root)"
  [[ "$path" =~ ^/[A-Za-z0-9_./-]+$ ]] || {
    maxim_scale_refuse canonical_repo_required; return 2;
  }
  case "$path" in
    *//*|*/./*|*/../*|*/.|*/..|*/)
      maxim_scale_refuse canonical_repo_required; return 2;
      ;;
    "$production_root"|"$production_root"/*|/var/www/svyazka|/var/www/svyazka/*|/var/www/max-delivery-platform|/var/www/max-delivery-platform/*)
      maxim_scale_refuse production_or_sibling_repo; return 2;
      ;;
  esac
}

maxim_scale_require_public_origin() {
  local origin="$1"
  local host
  [[ "$origin" =~ ^https?://([A-Za-z0-9][A-Za-z0-9.-]*)(:([0-9]{1,5}))?/?$ ]] || {
    maxim_scale_refuse explicit_public_origin_required; return 2;
  }
  host="${BASH_REMATCH[1],,}"
  host="${host%.}"
  if [[ -n "${BASH_REMATCH[3]}" ]] && ((10#${BASH_REMATCH[3]} < 1 || 10#${BASH_REMATCH[3]} > 65535)); then
    maxim_scale_refuse invalid_origin_port; return 2
  fi
  case "$host" in
    major-maksimov.ru|*.major-maksimov.ru|maxim.play-team.ru|*.maxim.play-team.ru)
      maxim_scale_refuse production_public_origin; return 2;
      ;;
  esac
  maxim_scale_require_nonproduction_host "$host" || return
}

maxim_scale_require_connection_profile() {
  local selected_file="$1"
  local ordinary_file="$2"
  local explicit_target="$3"
  local explicit_repo="$4"
  local explicit_origin="$5"
  local ssh_config key value remainder effective_host=""
  local args=()

  # FLAG: Ordinary production defaults and an opt-in never establish host isolation.
  # Admit the separate caller-selected file before SSH or optional cloud mutation.
  [[ -n "$selected_file" && -f "$selected_file" && -r "$selected_file" ]] || {
    maxim_scale_refuse separate_connection_file_required; return 2;
  }
  [[ "$selected_file" != "$ordinary_file" && ! "$selected_file" -ef "$ordinary_file" ]] || {
    maxim_scale_refuse ordinary_connection_file; return 2;
  }
  maxim_scale_require_profile_identity || return
  [[ -n "$explicit_target" && -n "$explicit_repo" && -n "$explicit_origin" ]] || {
    maxim_scale_refuse explicit_connection_fields_required; return 2;
  }
  [[ "$explicit_target" =~ ^([A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || {
    maxim_scale_refuse invalid_ssh_target; return 2;
  }
  maxim_scale_require_nonproduction_host "$explicit_target" || return
  maxim_scale_require_repo_path "$explicit_repo" || return
  maxim_scale_require_public_origin "$explicit_origin" || return
  [[ -z "${MAXIM_VPS_SSH_EXTRA_ARGS:-}" ]] || {
    maxim_scale_refuse ssh_extra_args_not_supported; return 2;
  }

  mapfile -d '' -t args < <(ssh_args)
  ssh_config="$(ssh -G "${args[@]}" "$explicit_target" 2>/dev/null)" || {
    maxim_scale_refuse ssh_host_identity_unavailable; return 2;
  }
  while read -r key value remainder; do
    if [[ "$key" == hostname ]]; then
      [[ -z "$effective_host" && -n "$value" && -z "$remainder" ]] || {
        maxim_scale_refuse ssh_host_identity_invalid; return 2;
      }
      effective_host="$value"
    fi
  done <<<"$ssh_config"
  [[ -n "$effective_host" ]] || {
    maxim_scale_refuse ssh_host_identity_unavailable; return 2;
  }
  maxim_scale_require_nonproduction_host "$effective_host" || return
}

maxim_scale_require_server_profile() {
  local actual_root="$1"
  local expected_root="${MAXIM_SCALE_EXPECTED_REPO_DIR:-}"
  local canonical_actual canonical_expected machine_id addresses address marker_parent
  local client_ip client_port server_ip server_port extra
  local docker_context docker_endpoint
  local host_addresses=()
  local machine_id_path="/etc/machine-id"
  local production_root
  production_root="$(maxim_scale_production_root)"

  # FLAG: Check the real host and local Docker endpoint before lock, Git, stores
  # or stack effects; repeat after synchronization. These evidence paths are fixed.
  maxim_scale_require_profile_identity || return
  maxim_scale_require_repo_path "$expected_root" || return
  maxim_scale_require_repo_path "$actual_root" || return
  canonical_actual="$(readlink -e -- "$actual_root")" || {
    maxim_scale_refuse actual_repo_unavailable; return 2;
  }
  canonical_expected="$(readlink -e -- "$expected_root")" || {
    maxim_scale_refuse expected_repo_unavailable; return 2;
  }
  [[ "$actual_root" == "$canonical_actual" && "$expected_root" == "$canonical_expected" && "$canonical_actual" == "$canonical_expected" ]] || {
    maxim_scale_refuse physical_repo_mismatch; return 2;
  }
  maxim_scale_require_repo_path "$canonical_actual" || return
  [[ ! -e "$production_root" && ! -L "$production_root" ]] || {
    maxim_scale_refuse production_checkout_present; return 2;
  }
  marker_parent="${production_root%/*}"
  while [[ ! -e "$marker_parent" && ! -L "$marker_parent" ]]; do
    marker_parent="${marker_parent%/*}"
    marker_parent="${marker_parent:-/}"
  done
  [[ -d "$marker_parent" && -r "$marker_parent" && -x "$marker_parent" ]] || {
    maxim_scale_refuse production_checkout_evidence_unavailable; return 2;
  }
  [[ -f "$machine_id_path" && -r "$machine_id_path" ]] || {
    maxim_scale_refuse actual_machine_identity_unavailable; return 2;
  }
  machine_id="$(<"$machine_id_path")"
  [[ "$machine_id" =~ ^[0-9a-f]{32}$ && "$machine_id" == "$MAXIM_SCALE_EXPECTED_MACHINE_ID" ]] || {
    maxim_scale_refuse actual_machine_identity_mismatch; return 2;
  }
  maxim_scale_require_public_origin "${MAXIM_VPS_PUBLIC_URL:-}" || return

  addresses="$(hostname -I 2>/dev/null)" || {
    maxim_scale_refuse actual_host_addresses_unavailable; return 2;
  }
  [[ -n "${addresses//[[:space:]]/}" ]] || {
    maxim_scale_refuse actual_host_addresses_unavailable; return 2;
  }
  read -r -a host_addresses <<<"${addresses//$'\n'/ }"
  for address in "${host_addresses[@]}"; do
    [[ "$address" =~ ^[0-9A-Fa-f:.]+$ ]] || {
      maxim_scale_refuse actual_host_addresses_invalid; return 2;
    }
    maxim_scale_require_nonproduction_host "$address" || return
  done
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    read -r client_ip client_port server_ip server_port extra <<<"$SSH_CONNECTION"
    [[ "$SSH_CONNECTION" != *$'\n'* && "$client_ip" =~ ^[0-9A-Fa-f:.]+$ && "$client_port" =~ ^[0-9]+$ && "$server_ip" =~ ^[0-9A-Fa-f:.]+$ && "$server_port" =~ ^[0-9]+$ && -z "$extra" ]] || {
      maxim_scale_refuse ssh_server_identity_invalid; return 2;
    }
    maxim_scale_require_nonproduction_host "$server_ip" || return
  fi

  [[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || {
    maxim_scale_refuse docker_routing_override; return 2;
  }
  docker_context="$(docker context show 2>/dev/null)" || {
    maxim_scale_refuse docker_context_unavailable; return 2;
  }
  [[ "$docker_context" == default ]] || {
    maxim_scale_refuse nondefault_docker_context; return 2;
  }
  docker_endpoint="$(docker context inspect default --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || {
    maxim_scale_refuse docker_endpoint_unavailable; return 2;
  }
  [[ "$docker_endpoint" == unix:///var/run/docker.sock ]] || {
    maxim_scale_refuse nonlocal_docker_endpoint; return 2;
  }
}

maxim_scale_source_function() {
  local source="$1"
  local marker=$'\n'"$2() {"$'\n'
  [[ "$source" == *"$marker"* ]] || return 2
  source="${source#*"$marker"}"
  [[ "$source" != *"$marker"* && "$source" == *$'\n}'* ]] || return 2
  printf '%s' "${source%%$'\n}'*}"
}

maxim_scale_require_controller_source() {
  local candidate="$1"
  local trusted="${MAXIM_SCALE_TRUSTED_CONTROLLER_SOURCE:-}"
  local prologue_end=$'\nSCALE_PROJECT_NAME='
  local main_start=$'\nif ! command -v docker >/dev/null 2>&1; then\n'
  local main_end=$'\nensure_compose_env\n'
  local candidate_main trusted_main function_name candidate_body trusted_body
  [[ -n "$trusted" && "$candidate" == *"$prologue_end"* && "$trusted" == *"$prologue_end"* ]] || {
    maxim_scale_refuse controller_source_unavailable; return 2;
  }
  [[ "${candidate%%"$prologue_end"*}" == "${trusted%%"$prologue_end"*}" ]] || {
    maxim_scale_refuse controller_source_wiring_changed; return 2;
  }
  for function_name in sync_branch reexec_if_current_script_changed; do
    trusted_body="$(maxim_scale_source_function "$trusted" "$function_name")" || {
      maxim_scale_refuse trusted_controller_function_unavailable; return 2;
    }
    candidate_body="$(maxim_scale_source_function "$candidate" "$function_name")" || {
      maxim_scale_refuse candidate_controller_function_unavailable; return 2;
    }
    [[ "$candidate_body" == "$trusted_body" ]] || {
      maxim_scale_refuse controller_admission_function_changed; return 2;
    }
  done
  [[ "$candidate" == *"$main_start"* && "$trusted" == *"$main_start"* ]] || {
    maxim_scale_refuse controller_admission_sequence_missing; return 2;
  }
  candidate_main="${candidate#*"$main_start"}"
  trusted_main="${trusted#*"$main_start"}"
  [[ "$candidate_main" == *"$main_end"* && "$trusted_main" == *"$main_end"* && "${candidate_main%%"$main_end"*}" == "${trusted_main%%"$main_end"*}" ]] || {
    maxim_scale_refuse controller_admission_sequence_changed; return 2;
  }
}

maxim_scale_require_candidate_source() {
  local source_sha="$1"
  local candidate_helper candidate_controller
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || {
    maxim_scale_refuse candidate_source_identity_invalid; return 2;
  }
  # FLAG: A scale update cannot install an older or altered admission kernel.
  # Compare trusted loaded bytes; never evaluate candidate source to inspect it.
  candidate_helper="$(git show "${source_sha}:infra/scripts/lib/scale-deploy-profile.sh" && printf '\001')" || {
    maxim_scale_refuse candidate_profile_helper_unavailable; return 2;
  }
  [[ "$candidate_helper" == "$MAXIM_SCALE_TRUSTED_HELPER_SOURCE" ]] || {
    maxim_scale_refuse candidate_profile_helper_changed; return 2;
  }
  candidate_controller="$(git show "${source_sha}:infra/scripts/vps-pull-build-up-scale.sh")" || {
    maxim_scale_refuse candidate_controller_unavailable; return 2;
  }
  maxim_scale_require_controller_source "$candidate_controller" || return
}

maxim_scale_require_synchronized_source() {
  local root="$1"
  local expected_sha="$2"
  local source_sha helper controller candidate_controller
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || {
    maxim_scale_refuse synchronized_target_identity_invalid; return 2;
  }
  source_sha="$(git rev-parse --verify --end-of-options 'HEAD^{commit}')" || {
    maxim_scale_refuse synchronized_source_identity_unavailable; return 2;
  }
  [[ "$source_sha" == "$expected_sha" ]] || {
    maxim_scale_refuse synchronized_target_identity_mismatch; return 2;
  }
  maxim_scale_require_candidate_source "$source_sha" || return
  helper="$root/infra/scripts/lib/scale-deploy-profile.sh"
  controller="$root/infra/scripts/vps-pull-build-up-scale.sh"
  [[ -f "$helper" && ! -L "$helper" && -r "$helper" && -f "$controller" && ! -L "$controller" && -r "$controller" ]] || {
    maxim_scale_refuse synchronized_controller_unavailable; return 2;
  }
  [[ "$(maxim_scale_source_bytes "$helper")" == "$MAXIM_SCALE_TRUSTED_HELPER_SOURCE" ]] || {
    maxim_scale_refuse synchronized_profile_helper_changed; return 2;
  }
  candidate_controller="$(git show "${expected_sha}:infra/scripts/vps-pull-build-up-scale.sh" && printf '\001')" || {
    maxim_scale_refuse synchronized_controller_source_unavailable; return 2;
  }
  [[ "$(maxim_scale_source_bytes "$controller")" == "$candidate_controller" ]] || {
    maxim_scale_refuse synchronized_controller_changed; return 2;
  }
}
