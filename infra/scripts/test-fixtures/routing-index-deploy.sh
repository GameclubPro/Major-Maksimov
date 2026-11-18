#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$PWD"
failure="${1:?missing routing hook scenario}"
# The extracted production function uses these local variables and test doubles.
# shellcheck disable=SC2034,SC2317
case "$failure" in
  rollback-ok|rollback-lock|rollback-catalog|rollback-other|rollback-legacy|rollback-complete)
    tmpdir="$(mktemp -d)"
    trap 'rm -rf -- "$tmpdir"' EXIT
    SOURCE_MIGRATIONS_FILE="$tmpdir/source"
    APPLIED_MIGRATIONS_FILE="$tmpdir/applied"
    routing=20261118120000_index_webhook_chat_queue_head
    printf '%s\n' prior "$routing" >"$APPLIED_MIGRATIONS_FILE"
    if [[ "$failure" == rollback-other ]]; then echo unknown >>"$APPLIED_MIGRATIONS_FILE"; fi
    git() {
      [[ "$*" == 'ls-tree -r --name-only fixture-sha -- apps/api/prisma/migrations' ]] || return 99
      echo apps/api/prisma/migrations/prior/migration.sql
      if [[ "$failure" == rollback-complete ]]; then echo "apps/api/prisma/migrations/$routing/migration.sql"; fi
      if [[ "$failure" == rollback-legacy ]]; then echo apps/api/prisma/migrations/20261103120000_index_webhook_chat_queue_head/migration.sql; fi
    }
    COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml -f fixture-overlay.yml)
    require_deploy_lock() { echo fixture-lock; [[ "$failure" != rollback-lock ]]; }
    node() {
      local -a expected=("$ROOT_DIR/infra/scripts/routing-index-online-state.mjs" assert "${COMPOSE_FILES[@]}")
      local argument
      [[ "$#" == "${#expected[@]}" ]] || return 99
      for argument in "${expected[@]}"; do [[ "$1" == "$argument" ]] || return 99; shift; done
      echo fixture-catalog
      [[ "$failure" != rollback-catalog ]]
    }
    # The actual rollback preflight, isolated from Docker and all runtime transitions.
    # shellcheck disable=SC1090
    source <(sed -n '/^  ensure_commit_has_applied_migrations() {$/,/^  }$/p' infra/scripts/vps-release-rollback.sh)
    ensure_commit_has_applied_migrations fixture-sha fixture-api
    exit 0 ;;
esac
case "$failure" in
  none|lock|authority|prepare|assert) ;;
  *) exit 99 ;;
esac

source infra/scripts/lib/routing-index-online-prepare.sh
MAXIM_API_IMAGE=maxim-api:1111111111111111111111111111111111111111
MIGRATION_COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml -f infra/docker-compose.runtime-no-build.yml)

require_deploy_lock() { echo lock; [[ "$failure" != lock ]]; }
maxim_require_ordinary_effect_authority() {
  [[ "$#" == 1 && "$1" == "$ROOT_DIR" ]] || return 99
  echo authority
  [[ "$failure" != authority ]]
}
ensure_compose_env() { echo env; }
node() {
  local script="$1" operation="$2" arg
  shift 2
  [[ "$#" == "${#MIGRATION_COMPOSE_FILES[@]}" ]] || return 99
  for arg in "${MIGRATION_COMPOSE_FILES[@]}"; do
    [[ "$1" == "$arg" ]] || return 99
    shift
  done
  case "$script:$operation" in
    "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs:prepare")
      [[ "$MAXIM_MIGRATION_API_IMAGE" == "$MAXIM_API_IMAGE" ]] || return 99 ;;
    "$ROOT_DIR/infra/scripts/routing-index-online-state.mjs:assert") ;;
    *) return 99 ;;
  esac
  echo "$operation"
  [[ "$failure" != "$operation" ]]
}

maxim_routing_index_prepare
echo journal-and-pause
