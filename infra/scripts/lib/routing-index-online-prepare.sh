#!/usr/bin/env bash

maxim_routing_index_release_state() {
  local target_sha="$1"
  local -n routing_release_state_ref="$3"
  local -n routing_release_compose_ref="$2"
  # FLAG: The lock belongs to this shell, not to a command substitution.
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  # The caller reads the variable assigned through this name reference.
  # shellcheck disable=SC2034
  routing_release_state_ref="$(node "$ROOT_DIR/infra/scripts/routing-index-online-state.mjs" release-state "$target_sha" "${routing_release_compose_ref[@]}")" || return
}

maxim_routing_index_preflight() {
  local target_sha="$1" state
  local -n routing_preflight_compose_ref="$2"
  maxim_routing_index_release_state "$target_sha" "$2" state || return
  case "$state" in
    already_applied|compatible_pending|prepare_giveaway_deferral|prepare_publisher_deferral) return 0 ;;
    prepare_spammer_deferral)
      node "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs" preflight-spammer "$target_sha" "${routing_preflight_compose_ref[@]}"
      ;;
    prepare_routing)
      node "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs" preflight "${routing_preflight_compose_ref[@]}"
      ;;
    *) echo "Unsupported routing index state for API deploy: $state" >&2; return 1 ;;
  esac
}

# FLAG: Only the protected deploy owner may prepare this fixed index, after
# image verification and before starting the runtime transition.
maxim_routing_index_prepare() {
  local target_sha="$1" routing_prepare_state
  local -n routing_prepare_out="$2"
  maxim_routing_index_release_state "$target_sha" MIGRATION_COMPOSE_FILES routing_prepare_state || return
  case "$routing_prepare_state" in
    already_applied|compatible_pending)
      # The caller reads the variable assigned through this name reference.
      # shellcheck disable=SC2034
      routing_prepare_out="$routing_prepare_state"
      ;;
    prepare_spammer_deferral)
      ensure_compose_env || return
      maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
      MAXIM_MIGRATION_API_IMAGE="$MAXIM_API_IMAGE" \
        node "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs" prepare-spammer "$target_sha" "${MIGRATION_COMPOSE_FILES[@]}" >&2 || return
      maxim_routing_index_require_release "$target_sha" MIGRATION_COMPOSE_FILES compatible_pending "$2"
      ;;
    prepare_giveaway_deferral|prepare_publisher_deferral)
      local deferral_argument=--giveaway-deferral
      if [[ "$routing_prepare_state" == prepare_publisher_deferral ]]; then deferral_argument=--publisher-deferral; fi
      ensure_compose_env || return
      maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
      # FLAG: Run only the fixed, checksum-pinned additive migrations. Never
      # start the unrestricted Prisma runner while the routing index is deferred.
      MAXIM_MIGRATION_API_IMAGE="$MAXIM_API_IMAGE" \
        docker compose "${MIGRATION_COMPOSE_FILES[@]}" run --rm --no-deps --pull never api-ingress \
        node scripts/agent/routing-index-online-prepare.mjs "$deferral_argument" >&2 || return
      maxim_routing_index_require_release "$target_sha" MIGRATION_COMPOSE_FILES compatible_pending "$2"
      ;;
    prepare_routing)
      ensure_compose_env || return
      MAXIM_MIGRATION_API_IMAGE="$MAXIM_API_IMAGE" \
        node "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs" prepare "${MIGRATION_COMPOSE_FILES[@]}" >&2 || return
      maxim_routing_index_require_release "$target_sha" MIGRATION_COMPOSE_FILES already_applied "$2"
      ;;
    *) echo "Unsupported routing index state for API deploy: $routing_prepare_state" >&2; return 1 ;;
  esac
}

# FLAG: Treat an unreadable, building or incomplete index as incompatible.
# A deployment that defers the index must still prove the same state after the
# other rollout preparations, immediately before replacing API roles.
maxim_routing_index_require_release() {
  local target_sha="$1" expected_state="${3:-}" routing_required_state
  maxim_routing_index_release_state "$target_sha" "$2" routing_required_state || return
  case "$routing_required_state" in
    already_applied|compatible_pending|not_in_target) ;;
    *) echo "Routing index state '$routing_required_state' does not admit API source $target_sha." >&2; return 1 ;;
  esac
  if [[ -n "$expected_state" && "$routing_required_state" != "$expected_state" ]]; then
    echo "Routing index state changed from '$expected_state' to '$routing_required_state'; refusing to replace API roles." >&2
    return 1
  fi
  if [[ -n "${4:-}" ]]; then
    local -n routing_required_out="$4"
    # The caller reads the variable assigned through this name reference.
    # shellcheck disable=SC2034
    routing_required_out="$routing_required_state"
  fi
}
