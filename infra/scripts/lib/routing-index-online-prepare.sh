#!/usr/bin/env bash

maxim_routing_index_preflight() {
  local compose_args_var="$1"
  local -n routing_compose_args_ref="$compose_args_var"
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  node "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs" preflight "${routing_compose_args_ref[@]}"
}

# FLAG: Only the protected deploy owner may prepare this fixed index. The caller
# has verified the immutable image but has not journaled or paused the live fleet.
maxim_routing_index_prepare() {
  require_deploy_lock || return
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  ensure_compose_env
  MAXIM_MIGRATION_API_IMAGE="$MAXIM_API_IMAGE" \
    node "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs" prepare "${MIGRATION_COMPOSE_FILES[@]}" || return
  maxim_routing_index_assert MIGRATION_COMPOSE_FILES
}

maxim_routing_index_assert() {
  local compose_args_var="$1"
  local -n routing_compose_args_ref="$compose_args_var"
  node "$ROOT_DIR/infra/scripts/routing-index-online-state.mjs" assert "${routing_compose_args_ref[@]}"
}
