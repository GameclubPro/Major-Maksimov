#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$PWD"
failure="${1:?missing routing hook scenario}"
exec 3>&1
deploy_owner="$BASHPID"
# The extracted production function uses these local variables and test doubles.
# shellcheck disable=SC2034,SC2317
case "$failure" in
  rollback-ok|rollback-lock|rollback-catalog|rollback-other|rollback-legacy|rollback-complete|rollback-pending|rollback-blocked)
    tmpdir="$(mktemp -d)"
    trap 'rm -rf -- "$tmpdir"' EXIT
    SOURCE_MIGRATIONS_FILE="$tmpdir/source"
    APPLIED_MIGRATIONS_FILE="$tmpdir/applied"
    routing=20261118120000_index_webhook_chat_queue_head
    printf '%s\n' prior >"$APPLIED_MIGRATIONS_FILE"
    case "$failure" in
      rollback-pending|rollback-blocked) ;;
      *) echo "$routing" >>"$APPLIED_MIGRATIONS_FILE" ;;
    esac
    if [[ "$failure" == rollback-other ]]; then echo unknown >>"$APPLIED_MIGRATIONS_FILE"; fi
    git() {
      [[ "$*" == 'ls-tree -r --name-only fixture-sha -- apps/api/prisma/migrations' ]] || return 99
      echo apps/api/prisma/migrations/prior/migration.sql
      case "$failure" in
        rollback-complete|rollback-pending|rollback-blocked) echo "apps/api/prisma/migrations/$routing/migration.sql" ;;
      esac
      if [[ "$failure" == rollback-legacy ]]; then echo apps/api/prisma/migrations/20261103120000_index_webhook_chat_queue_head/migration.sql; fi
    }
    COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml -f fixture-overlay.yml)
    require_deploy_lock() { echo fixture-lock; [[ "$failure" != rollback-lock ]]; }
    maxim_require_ordinary_effect_authority() { [[ "$1" == "$ROOT_DIR" && "$BASHPID" == "$deploy_owner" ]]; }
    node() {
      local operation="$2"
      local -a expected=("$ROOT_DIR/infra/scripts/routing-index-online-state.mjs" "$operation")
      if [[ "$operation" == release-state ]]; then expected+=(fixture-sha); fi
      expected+=("${COMPOSE_FILES[@]}")
      local argument
      [[ "$#" == "${#expected[@]}" ]] || return 99
      for argument in "${expected[@]}"; do [[ "$1" == "$argument" ]] || return 99; shift; done
      case "$operation" in
        assert)
          echo fixture-catalog
          [[ "$failure" != rollback-catalog ]] ;;
        release-state)
          local state
          case "$failure" in
            rollback-complete) state=already_applied ;;
            rollback-pending) state=compatible_pending ;;
            rollback-blocked) state=prepare_routing ;;
            *) state=not_in_target ;;
          esac
          echo "fixture-rollback-state:$state" >&3
          echo "$state" ;;
        *) return 99 ;;
      esac
    }
    # The actual rollback preflight, isolated from Docker and all runtime transitions.
    # shellcheck disable=SC1090
    source <(sed -n '/^  ensure_commit_has_applied_migrations() {$/,/^  }$/p' infra/scripts/vps-release-rollback.sh)
    source infra/scripts/lib/routing-index-online-prepare.sh
    API_SOURCE_SHA=fixture-sha
    # shellcheck disable=SC1090
    source <(sed -n '/^  ensure_commit_has_applied_migrations "/,/^  maxim_routing_index_require_release /p' infra/scripts/vps-release-rollback.sh)
    exit 0 ;;
esac
case "$failure" in
  compatible|changed-before-pause|changed-after-pause|giveaway-stop-refused|applied|lock|authority|prepare|capacity|prepare-incomplete|ref-rollback-*) ;;
  *) exit 99 ;;
esac

source infra/scripts/lib/routing-index-online-prepare.sh
TARGET_SHA=1111111111111111111111111111111111111111
MAXIM_API_IMAGE="maxim-api:$TARGET_SHA"
COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
MIGRATION_COMPOSE_FILES=("${COMPOSE_FILES[@]}" -f infra/docker-compose.runtime-no-build.yml)
tmpdir="$(mktemp -d)"
trap 'rm -rf -- "$tmpdir"' EXIT
phase=preflight

require_deploy_lock() {
  if [[ "$failure" == lock || "$BASHPID" != "$deploy_owner" ]]; then
    echo fixture-lock-refused >&3
    return 1
  fi
}
maxim_require_ordinary_effect_authority() {
  [[ "$#" == 1 && "$1" == "$ROOT_DIR" ]] || return 99
  require_deploy_lock || return
  if [[ "$failure" == authority ]]; then
    echo fixture-authority-refused >&3
    return 1
  fi
}
ensure_compose_env() { :; }
node() {
  local script="$1" operation="$2" arg state
  shift 2
  local -a expected=("${COMPOSE_FILES[@]}")
  if [[ "$phase" == prepare ]]; then expected=("${MIGRATION_COMPOSE_FILES[@]}"); fi
  if [[ "$operation" == release-state ]]; then
    [[ "$1" == "$TARGET_SHA" ]] || return 99
    shift
  fi
  [[ "$#" == "${#expected[@]}" ]] || return 99
  for arg in "${expected[@]}"; do
    [[ "$1" == "$arg" ]] || return 99
    shift
  done
  case "$script:$operation" in
    "$ROOT_DIR/infra/scripts/routing-index-online-state.mjs:release-state")
      case "$failure:$phase" in
        changed-before-pause:rollout|changed-after-pause:post-migration|capacity:*|prepare-incomplete:*)
          state=prepare_routing ;;
        prepare:*)
          if [[ -f "$tmpdir/prepared" ]]; then state=already_applied; else state=prepare_routing; fi ;;
        applied:*|ref-rollback-applied:*) state=already_applied ;;
        ref-rollback-old:*) state=not_in_target ;;
        ref-rollback-blocked:*) state=prepare_routing ;;
        *) state=compatible_pending ;;
      esac
      printf 'fixture-state:%s:%s\n' "$phase" "$state" >&3
      echo "$state" ;;
    "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs:preflight")
      echo fixture-capacity >&3
      [[ "$failure" != capacity ]] ;;
    "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs:prepare")
      [[ "$MAXIM_MIGRATION_API_IMAGE" == "$MAXIM_API_IMAGE" ]] || return 99
      echo fixture-prepare >&3
      touch "$tmpdir/prepared" ;;
    *) return 99 ;;
  esac
}

begin_release_runtime_transition() { echo fixture-journal; }
maxim_webhook_prepare_multibot_before_quiescence() { :; }
maxim_outcome_cohort_prepare() { :; }
maxim_webhook_quiesce_for_api_rollout() { echo fixture-pause; }
maxim_webhook_quiesce_legacy_ingress_for_multibot_cutover() { phase=post-migration; }
run_migrations() { echo fixture-prisma; }
maxim_webhook_assert_multibot_migration_indexes() { :; }
maxim_outcome_cohort_assert() { :; }

# The extracted rollback uses the variables and functions in this block.
# shellcheck disable=SC2034,SC2317
if [[ "$failure" == ref-rollback-* ]]; then
  phase=ref-rollback
  TARGET_FULL_SHA="$TARGET_SHA"
  ROLLBACK_API_IMAGE="maxim-api:runtime-rollback-$TARGET_SHA"
  TARGET_HAS_OCR_NATIVE_SANDBOX=1
  git() {
    [[ "$*" == "switch --detach $TARGET_FULL_SHA" ]] || return 99
    echo fixture-switch
  }
  docker() {
    case "$1" in
      image)
        [[ "$*" == "image inspect --format {{.Id}} $ROLLBACK_API_IMAGE" ]] || return 99
        echo fixture-image-id ;;
      compose)
        [[ "$MAXIM_MIGRATION_API_IMAGE" == "$ROLLBACK_API_IMAGE" ]] || return 99
        [[ "$*" == "compose ${MIGRATION_COMPOSE_FILES[*]} run --rm --no-deps --pull never api-ingress ./node_modules/.bin/prisma migrate deploy --config apps/api/prisma.config.ts" ]] || return 99
        echo fixture-prisma ;;
      *) return 99 ;;
    esac
  }
  maxim_topology_refuse_dirty_api_build_inputs() { :; }
  maxim_topology_build_shared_api_image() { :; }
  maxim_topology_require_ocr_native_sandbox_image_capability() { :; }
  maxim_topology_require_photo_native_image_capability() { :; }
  begin_runtime_rollback_transition() { echo fixture-journal; }
  verify_inherited_static_components() { :; }
  # shellcheck disable=SC1090
  source <(sed -n '/^maxim_routing_index_require_release /,/^maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES$/p' infra/scripts/vps-runtime-rollback.sh)
  exit 0
fi

# Exercise the actual release decisions without accessing Docker or any stores.
controller=infra/scripts/vps-pull-build-up.sh
# The extracted controller function below reads these settings.
# shellcheck disable=SC2034
{
  GIVEAWAY_FIRST_WRITER=0
  if [[ "$failure" == giveaway-stop-refused ]]; then GIVEAWAY_FIRST_WRITER=1; fi
  MAXIM_WEBHOOK_ROLLOUT_STOP_TIMEOUT_SEC=60
}
docker() {
  [[ "$*" == "compose ${COMPOSE_FILES[*]} stop -t 60 api-action api-admin" ]] || return 99
  echo fixture-giveaway-stop
}
maxim_webhook_rollout_verify_services_stopped() {
  [[ "$*" == "COMPOSE_FILES api-action api-admin" ]] || return 99
  echo fixture-giveaway-verify
  [[ "$failure" != giveaway-stop-refused ]]
}
# shellcheck disable=SC1090
source <(sed -n '/^quiesce_giveaway_writer_transition() {$/,/^}$/p' "$controller")
# shellcheck disable=SC1090
source <(sed -n '/^  maxim_routing_index_preflight /p' "$controller")
phase=prepare
# shellcheck disable=SC1090
source <(sed -n '/^  maxim_routing_index_prepare /,/^  begin_release_runtime_transition$/p' "$controller")
phase=rollout
# shellcheck disable=SC1090,SC2016
source <(sed -n '/^  maxim_webhook_prepare_multibot_before_quiescence COMPOSE_FILES$/,/^  if \[\[ "\$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 \]\]; then$/p' "$controller" | sed '$d')
echo fixture-transition
