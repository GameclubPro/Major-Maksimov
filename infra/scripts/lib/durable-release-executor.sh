#!/usr/bin/env bash

export MAXIM_DURABLE_RELEASE_EXECUTOR_PROTOCOL=maxim-durable-release-executor-v1

maxim_durable_executor_requested() {
  [[ -n "${MAXIM_DURABLE_RELEASE_OPERATION:-}${MAXIM_DURABLE_RELEASE_REQUEST_HASH:-}" ]]
}

maxim_durable_executor_error() {
  echo "Immutable release executor: $1" >&2
  return 70
}

maxim_durable_executor_validate_identity() {
  [[ "${MAXIM_DURABLE_RELEASE_OPERATION:-}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ &&
     "${MAXIM_DURABLE_RELEASE_REQUEST_HASH:-}" =~ ^[a-f0-9]{64}$ &&
     "${MAXIM_EXPECTED_DEPLOY_SHA:-}" =~ ^[a-f0-9]{40}$ ]] ||
    maxim_durable_executor_error 'invalid operation, request hash or exact source SHA.'
}

maxim_durable_executor_validate() {
  local expected_root path metadata kind mode links owner size branch_status tracked_status option
  maxim_durable_executor_validate_identity || return
  expected_root="/var/www/Chat_bot/.release-executors/$MAXIM_DURABLE_RELEASE_OPERATION/source"
  [[ "$ROOT_DIR" == "$expected_root" && "$(pwd -P)" == "$expected_root" ]] || {
    maxim_durable_executor_error 'source must use the fixed operation checkout.'; return;
  }
  [[ "$BRANCH" == main && "$DEPLOY_MODE" == auto && "$IMAGE_PLAN_ONLY" == 0 && "${#SERVICES[@]}" == 0 ]] || {
    maxim_durable_executor_error 'only the automatic component plan is supported.'; return;
  }
  [[ "$RELEASE_STATE_DIR" == /var/lib/maxim-deploy ]] || {
    maxim_durable_executor_error 'alternate release state is forbidden.'; return;
  }
  # FLAG: Service requests contain source/image identities only. Configuration,
  # recovery adoption, alternate stores and executable overrides require another protocol.
  for option in MAXIM_MESSAGE_RETENTION_MODE MAXIM_COMMERCIAL_LLM_ENFORCEMENT \
    MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED MAXIM_COMMERCIAL_LLM_POOL_ENABLED \
    MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY STATISTICS_EXCHANGE_V3_ENABLED \
    MAXIM_STATISTICS_CENTRAL_EPOCH MAXIM_COMMERCIAL_OCR_BASELINE MAXIM_COMMERCIAL_OCR_OFF \
    MAXIM_COMPOSE_SERVICE_ENV_FILE MAXIM_ERASER_ENV_FILE MAXIM_ERASER_POSTGRES_PASSWORD_FILE \
    MAXIM_DEPLOY_EMERGENCY_BYPASS MAXIM_DEPLOY_EMERGENCY_REASON MAXIM_ALLOW_NON_MAIN_DEPLOY \
    MAXIM_DEPLOY_SCRIPT_REEXECED MAXIM_API_IMAGE MAXIM_MINIAPP_MAJOR_IMAGE MAXIM_ADMIN_IMAGE \
    MAXIM_ERASER_IMAGE MAXIM_ERASER_SOURCE_SHA MAXIM_MIGRATION_API_IMAGE MAXIM_MINIAPP_LEGACY_IMAGE \
    GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
    GIT_COMMON_DIR GIT_NAMESPACE GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL \
    GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM GIT_EXTERNAL_DIFF GIT_DIFF_OPTS GIT_REPLACE_REF_BASE \
    GIT_SSH GIT_SSH_COMMAND NODE_OPTIONS NODE_PATH \
    COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_DISABLE_ENV_FILE \
    DOCKER_HOST DOCKER_CONTEXT; do
    [[ -z "${!option:-}" ]] || {
      maxim_durable_executor_error 'configuration or source overrides are forbidden.'; return;
    }
  done
  [[ "${MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE:-0}" == 0 &&
     -z "${MAXIM_WEBHOOK_ROLLOUT_OWNER_TOKEN:-}" &&
     "$MAXIM_WEBHOOK_ROLLOUT_CONTROL_HELPER" == "$ROOT_DIR/infra/scripts/webhook-queue-rollout-control.cjs" &&
     "$MAXIM_PHOTO_NATIVE_BOUNDARY_HELPER" == "$ROOT_DIR/infra/scripts/photo-native-runtime-boundary.cjs" ]] || {
    maxim_durable_executor_error 'recovery adoption or helper overrides are forbidden.'; return;
  }
  for path in /var /var/www /var/www/Chat_bot /var/www/Chat_bot/.release-executors \
    "/var/www/Chat_bot/.release-executors/$MAXIM_DURABLE_RELEASE_OPERATION" "$expected_root"; do
    [[ "$(stat -c '%F' -- "$path")" == directory ]] || {
      maxim_durable_executor_error 'checkout ancestors must be real directories.'; return;
    }
  done
  metadata="$(stat -c '%F|%a|%h|%u|%s' -- "$ROOT_DIR/.env")" || return
  IFS='|' read -r kind mode links owner size <<<"$metadata"
  [[ "$kind" == 'regular file' && "$mode" == 600 && "$links" == 1 &&
     ( "$owner" == 0 || "$owner" == "$EUID" ) && "$size" =~ ^[1-9][0-9]*$ && "$size" -le 1048576 ]] || {
    maxim_durable_executor_error 'configuration snapshot must be a private regular file.'; return;
  }
  export GIT_NO_REPLACE_OBJECTS=1
  [[ "$(git rev-parse --verify HEAD)" == "$MAXIM_EXPECTED_DEPLOY_SHA" ]] || {
    maxim_durable_executor_error 'checkout SHA differs from the accepted source.'; return;
  }
  if git symbolic-ref -q HEAD >/dev/null 2>&1; then
    maxim_durable_executor_error 'executor HEAD must be detached.'; return;
  else
    branch_status=$?
    [[ "$branch_status" == 1 ]] || return "$branch_status"
  fi
  git diff --quiet -- || return
  git diff --cached --quiet -- || return
  tracked_status="$(git status --porcelain --untracked-files=no)" || return
  [[ -z "$tracked_status" ]] || {
    maxim_durable_executor_error 'tracked executor inputs changed.'; return;
  }
}

maxim_durable_executor_select_source() {
  # FLAG: The selected checkout is never synchronized or re-executed. Preserve
  # every installed source/floor boundary before handing this SHA to runtime.
  require_market_statistics_lock_dispatch "$MAXIM_EXPECTED_DEPLOY_SHA" || return
  require_pair_release_admission_dispatch "$MAXIM_EXPECTED_DEPLOY_SHA" || return
  maxim_topology_require_statistics_authority_lifecycle "$MAXIM_EXPECTED_DEPLOY_SHA" || return
  maxim_topology_require_eraser_bridge "$MAXIM_EXPECTED_DEPLOY_SHA" || return
  maxim_topology_require_eraser_rate_limit_reader "$MAXIM_EXPECTED_DEPLOY_SHA" tooling || return
  maxim_topology_require_eraser_connection_proof_reader "$MAXIM_EXPECTED_DEPLOY_SHA" tooling || return
  verify_expected_deploy_sha
}

maxim_durable_executor_lock_refusal() {
  local failure="${1:-70}"
  case "${MAXIM_DEPLOY_ADMISSION_REFUSAL:-unknown}" in
    pair_lock_busy|product_lock_busy)
      maxim_durable_executor_validate_identity || return
      # FLAG: Only a positively observed conflict on a validated lock inode is retryable.
      # Historical exit codes, missing owners and arbitrary prelaunch errors stay ambiguous.
      printf '{"schemaVersion":1,"event":"SAFE_REFUSAL","id":"%s","requestHash":"%s","reasonCode":"LOCK_BUSY"}\n' \
        "$MAXIM_DURABLE_RELEASE_OPERATION" "$MAXIM_DURABLE_RELEASE_REQUEST_HASH" >&3 || return 70
      return 75
      ;;
    *) return "$failure" ;;
  esac
}

maxim_durable_executor_admit() {
  local plan acknowledgment status path metadata kind owner mode links
  release_manifest validate-current >/dev/null || return
  [[ -z "$RECOVERY_BASE_MANIFEST" ]] || {
    maxim_durable_executor_error 'an interrupted release needs operator recovery.'; return;
  }
  load_current_component_images || return
  plan="$(print_image_preparation_plan)" || return
  for path in /usr /usr/local /usr/local/lib /usr/local/lib/maxim-release \
    /usr/local/lib/maxim-release/infra /usr/local/lib/maxim-release/infra/scripts; do
    metadata="$(stat -c '%F|%u|%a' -- "$path")" || return
    IFS='|' read -r kind owner mode <<<"$metadata"
    [[ "$kind" == directory && "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 8#022)) == 0 ]] || {
      maxim_durable_executor_error 'installed admission directories are unsafe.'; return;
    }
  done
  path=/usr/local/lib/maxim-release/infra/scripts/release-service-admission.mjs
  metadata="$(stat -c '%F|%u|%a|%h' -- "$path")" || return
  IFS='|' read -r kind owner mode links <<<"$metadata"
  [[ "$kind" == 'regular file' && "$owner" == 0 && "$links" == 1 &&
     "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 8#022)) == 0 ]] || {
    maxim_durable_executor_error 'installed admission helper is unsafe.'; return;
  }
  if printf '%s\n' "$plan" | node "$path" admit \
    "$MAXIM_DURABLE_RELEASE_OPERATION" "$MAXIM_DURABLE_RELEASE_REQUEST_HASH" "$ROOT_DIR"; then
    :
  else
    status=$?
    return "$status"
  fi
  # FLAG: READY is evidence only. The daemon must durably save EXECUTING before
  # authorizing any environment, inventory, floor, migration or container change.
  if ! IFS= read -r -t 30 -n 110 acknowledgment <&4; then
    exec 3>&- 4<&-
    maxim_durable_executor_error 'execution authorization is missing or expired.'; return;
  fi
  if [[ "$acknowledgment" != "PROCEED:$MAXIM_DURABLE_RELEASE_OPERATION:$MAXIM_DURABLE_RELEASE_REQUEST_HASH" ]]; then
    exec 3>&- 4<&-
    maxim_durable_executor_error 'execution authorization belongs to another request.'; return;
  fi
  exec 3>&- 4<&-
}
