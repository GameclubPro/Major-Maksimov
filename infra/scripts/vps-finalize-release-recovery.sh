#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source "$ROOT_DIR/infra/scripts/lib/legacy-cold-maintenance.sh" || exit $?
# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/change-impact-components.generated.sh
source "$ROOT_DIR/infra/scripts/lib/change-impact-components.generated.sh"
# shellcheck source=infra/scripts/lib/routing-index-online-prepare.sh
source "$ROOT_DIR/infra/scripts/lib/routing-index-online-prepare.sh"

MAIN_PROJECT_NAME="infra"
COMPOSE_FILES=(--env-file ".env" -p "$MAIN_PROJECT_NAME" -f "infra/docker-compose.yml")
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
EXPECTED_DEPLOY_SHA="${MAXIM_EXPECTED_DEPLOY_SHA:-}"
EXPECTED_RUNTIME_SHA="${MAXIM_FINALIZER_RUNTIME_SHA:-$EXPECTED_DEPLOY_SHA}"
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-${MAXIM_PUBLIC_HEALTH_URL:-https://major-maksimov.ru}}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"
COMMAND_TIMEOUT_SEC="${MAXIM_FINALIZER_COMMAND_TIMEOUT_SEC:-30}"
STABILITY_WINDOW_SEC="${MAXIM_FINALIZER_STABILITY_WINDOW_SEC:-30}"
MAX_MIGRATIONS_FILE_BYTES=1048576
MAX_IMPACT_FILE_BYTES=1048576
WEBHOOK_QUEUE_CONTROL_HELPER="$ROOT_DIR/infra/scripts/webhook-queue-rollout-control.cjs"
RUNTIME_INVENTORY_HELPER="$ROOT_DIR/infra/scripts/commercial-ocr-runtime-inventory.mjs"

BRANCH=""
API_ONLY_RECOVERY=0
RECOVERY_BASE_MANIFEST=""
RECOVERY_BASE_SHA256=""
MIGRATIONS_FILE=""
IMPACT_FILE=""
TARGET_COMMERCIAL_OCR_VERSION=""
TARGET_HAS_MEDIA_ANALYSIS=0
TARGET_HAS_OCR_NATIVE_SANDBOX=0
declare -A COMPONENT_IMAGE_REF=()
declare -A COMPONENT_IMAGE_ID=()
declare -A COMPONENT_SOURCE_SHA=()
declare -A INHERITED_STATIC_IMAGE_ID=()
SMOKE_RESULTS=()

fail() {
  echo "$1" >&2
  return 1
}

finalizer_cleanup() {
  local exit_status=$?

  if [[ -n "$MIGRATIONS_FILE" ]] && ! rm -f -- "$MIGRATIONS_FILE"; then
    echo "Could not remove the recovery finalizer migration snapshot." >&2
  fi
  if [[ -n "$IMPACT_FILE" ]] && ! rm -f -- "$IMPACT_FILE"; then
    echo "Could not remove the recovery finalizer impact snapshot." >&2
  fi
  if ! release_deploy_lock; then
    echo "Could not release the recovery finalizer deploy lock." >&2
  fi
  return "$exit_status"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || { fail "Required recovery finalizer command is missing: $1"; return 1; }
}

validate_positive_int_range() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]] ||
     ((value < minimum || value > maximum)); then
    fail "$name must be an integer between $minimum and $maximum."
    return 1
  fi
}

validate_finalizer_environment() {
  local command_name

  if [[ ! "$EXPECTED_DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    fail "MAXIM_EXPECTED_DEPLOY_SHA must be the reviewed full lowercase Git SHA."
    return 1
  fi
  if [[ ! "$EXPECTED_RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    fail "MAXIM_FINALIZER_RUNTIME_SHA must be the reviewed full lowercase runtime SHA."
    return 1
  fi
  if [[ -z "$BRANCH" || ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
     [[ "$BRANCH" == *..* || "$BRANCH" == *//* || "$BRANCH" == */ ]]; then
    fail "Recovery finalizer branch is invalid."
    return 1
  fi
  if [[ "$BRANCH" != "main" && "${MAXIM_ALLOW_NON_MAIN_DEPLOY:-0}" != "1" ]]; then
    fail "Recovery finalization outside main requires MAXIM_ALLOW_NON_MAIN_DEPLOY=1."
    return 1
  fi
  validate_positive_int_range MAXIM_FINALIZER_COMMAND_TIMEOUT_SEC "$COMMAND_TIMEOUT_SEC" 20 120 || return 1
  validate_positive_int_range MAXIM_FINALIZER_STABILITY_WINDOW_SEC "$STABILITY_WINDOW_SEC" 10 90 || return 1
  for command_name in chmod curl docker git head mktemp node timeout; do
    require_command "$command_name" || return 1
  done
  if [[ "$API_ONLY_RECOVERY" -eq 1 ]]; then
    require_command sha256sum || return 1
    require_command wc || return 1
  fi
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
    fail "Node 24 is required for release recovery finalization."
    return 1
  fi
  if [[ ! -s ".env" ]]; then
    fail "Production .env is required and will not be synthesized by the recovery finalizer."
    return 1
  fi
  for path in \
    "$WEBHOOK_QUEUE_CONTROL_HELPER" \
    "$RUNTIME_INVENTORY_HELPER" \
    "$MAXIM_PHOTO_NATIVE_BOUNDARY_HELPER" \
    "$ROOT_DIR/infra/scripts/recovery-finalizer-identity.mjs" \
    "$ROOT_DIR/infra/scripts/release-manifest.mjs" \
    "$ROOT_DIR/infra/scripts/lib/change-impact-components.generated.sh" \
    "$ROOT_DIR/scripts/smoke-http.mjs"; do
    [[ -s "$path" ]] || { fail "Required recovery finalizer helper is missing: $path"; return 1; }
  done
}

verify_synchronized_checkout() {
  local head_sha
  local remote_sha

  head_sha="$(git rev-parse --verify HEAD)" || { fail "Could not read the synchronized VPS HEAD."; return 1; }
  remote_sha="$(git rev-parse --verify "refs/remotes/origin/$BRANCH")" ||
    { fail "Could not read the synchronized origin/$BRANCH ref."; return 1; }
  [[ "$head_sha" == "$EXPECTED_DEPLOY_SHA" ]] ||
    { fail "VPS HEAD does not match the reviewed recovery finalizer SHA."; return 1; }
  [[ "$remote_sha" == "$EXPECTED_DEPLOY_SHA" ]] ||
    { fail "origin/$BRANCH does not match the reviewed recovery finalizer SHA."; return 1; }
  git diff --quiet -- . || { fail "Tracked VPS changes block release recovery finalization."; return 1; }
  git diff --cached --quiet -- . || { fail "Staged VPS changes block release recovery finalization."; return 1; }
}

verify_controller_runtime_compatibility() {
  # FLAG: Keep the current journal reader while proving the captured runtime's
  # immutable identity. A split is limited to the reviewed controller-only delta.
  node "$ROOT_DIR/infra/scripts/recovery-finalizer-identity.mjs" \
    "$EXPECTED_DEPLOY_SHA" "$EXPECTED_RUNTIME_SHA" "$ROOT_DIR"
}

release_manifest() {
  MAXIM_RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
    node "$ROOT_DIR/infra/scripts/release-manifest.mjs" "$@"
}

require_missing_current_manifest() {
  local status

  if release_manifest validate-current >/dev/null 2>&1; then
    fail "A valid current release already exists; recovery finalization is not applicable."
    return 1
  else
    status=$?
  fi
  [[ "$status" -eq 3 ]] || { fail "Current release inventory is invalid rather than absent; refusing finalization."; return 1; }
}

resolve_recovery_base_manifest() {
  require_missing_current_manifest || return 1
  RECOVERY_BASE_MANIFEST="$(release_manifest recovery-base)" || { fail "Recovery finalization requires exactly one complete typed transition journal."; return 1; }
  [[ -n "$RECOVERY_BASE_MANIFEST" ]] || { fail "Recovery finalization did not resolve a transition journal."; return 1; }
  if [[ "$API_ONLY_RECOVERY" -eq 1 ]]; then
    # FLAG: Inherit statics only from this unchanged, complete deploy journal.
    # A rollback or an arbitrary manifest is not an API-only deployment receipt.
    [[ "${RECOVERY_BASE_MANIFEST##*/}" =~ ^current\.invalid-deploy-[0-9]{8}T[0-9]{6}Z-[0-9]+\.json$ ]] || { fail "API-only finalization requires a typed interrupted deploy journal."; return 1; }
    RECOVERY_BASE_SHA256="$(sha256sum -- "$RECOVERY_BASE_MANIFEST")" || return 1
    RECOVERY_BASE_SHA256="${RECOVERY_BASE_SHA256%% *}"
    [[ "$RECOVERY_BASE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { fail "Could not capture the API-only transition journal digest."; return 1; }
  fi
}

verify_recovery_base_unchanged() {
  local current_recovery_base

  require_missing_current_manifest || return 1
  current_recovery_base="$(release_manifest recovery-base)" || { fail "The recovery transition journal is no longer uniquely valid."; return 1; }
  [[ "$current_recovery_base" == "$RECOVERY_BASE_MANIFEST" ]] || { fail "The recovery transition journal changed during finalization."; return 1; }
  if [[ "$API_ONLY_RECOVERY" -eq 1 ]]; then
    local current_digest
    current_digest="$(sha256sum -- "$RECOVERY_BASE_MANIFEST")" || return 1
    [[ "${current_digest%% *}" == "$RECOVERY_BASE_SHA256" ]] || { fail "The API-only transition journal contents changed during finalization."; return 1; }
  fi
}

expected_component_ref() {
  local component_source="${COMPONENT_SOURCE_SHA[$1]:-$EXPECTED_RUNTIME_SHA}"
  case "$1" in
    api-shared) printf 'maxim-api:%s' "$component_source" ;;
    miniapp-major-static) printf 'maxim-miniapp-major:%s' "$component_source" ;;
    admin-static) printf 'maxim-admin:%s' "$component_source" ;;
    eraser) printf 'maxim-eraser:%s' "$component_source" ;;
    *) fail "Unknown recovery finalizer component: $1" ;;
  esac
}

require_unchanged_static_inputs() {
  local component="$1"
  local source_sha="$2"
  local path
  local selected
  local impact_bytes

  case "$component" in
    miniapp-major-static | admin-static | eraser) ;;
    *) fail "Only static components may inherit deployment inputs."; return 1 ;;
  esac

  # FLAG: Classify every old/new path with the same fail-closed deploy map, including
  # contracts, root lock/config and build inputs. Renames must expose both paths.
  IMPACT_FILE="$(mktemp /tmp/maxim-release-finalizer-impact.XXXXXX)" || return 1
  chmod 0600 "$IMPACT_FILE" || return 1
  if ! timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    git --no-replace-objects diff --no-ext-diff --no-textconv --name-only --no-renames -z \
      "$source_sha" "$EXPECTED_RUNTIME_SHA" -- |
      head -c "$((MAX_IMPACT_FILE_BYTES + 1))" >"$IMPACT_FILE"; then
    fail "Could not classify inherited static component inputs."
    return 1
  fi
  impact_bytes="$(wc -c <"$IMPACT_FILE")" || return 1
  [[ "$impact_bytes" =~ ^[[:space:]]*[0-9]+[[:space:]]*$ ]] || { fail "Invalid impact snapshot size."; return 1; }
  if [[ "$impact_bytes" -gt "$MAX_IMPACT_FILE_BYTES" ]]; then
    fail "Inherited static component changes exceed the bounded impact snapshot."
    return 1
  fi
  while IFS= read -r -d '' path; do
    maxim_impact_classify_path "$path" || return 1
    case "$component" in
      miniapp-major-static) selected="$MAXIM_IMPACT_PATH_MINIAPP_MAJOR_STATIC" ;;
      admin-static) selected="$MAXIM_IMPACT_PATH_ADMIN_STATIC" ;;
      eraser) selected="$MAXIM_IMPACT_PATH_ERASER" ;;
      *) fail "Only static components may inherit deployment inputs."; return 1 ;;
    esac
    if [[ "$selected" -ne 0 ]]; then
      fail "Inherited static component has changed deployment inputs: $component"
      return 1
    fi
  done <"$IMPACT_FILE"
  rm -f -- "$IMPACT_FILE" || return 1
  IMPACT_FILE=""
}

resolve_inherited_static_component() {
  local component="$1"
  local source_sha
  local image_ref
  local image_id

  source_sha="$(release_manifest field current "$component" sourceSha --current-manifest-file "$RECOVERY_BASE_MANIFEST")" || return 1
  image_ref="$(release_manifest field current "$component" imageRef --current-manifest-file "$RECOVERY_BASE_MANIFEST")" || return 1
  image_id="$(release_manifest field current "$component" imageId --current-manifest-file "$RECOVERY_BASE_MANIFEST")" || return 1
  if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ || ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail "Inherited static component has an incomplete identity."
    return 1
  fi
  if ! git --no-replace-objects cat-file -e "${source_sha}^{commit}" ||
     ! git --no-replace-objects merge-base --is-ancestor "$source_sha" "$EXPECTED_RUNTIME_SHA"; then
    fail "Inherited static component source is not a known API runtime ancestor."
    return 1
  fi
  COMPONENT_SOURCE_SHA["$component"]="$source_sha"
  if [[ "$image_ref" != "$(expected_component_ref "$component")" ]]; then
    fail "Inherited static component lacks its exact immutable source ref."
    return 1
  fi
  require_unchanged_static_inputs "$component" "$source_sha" || return 1
  INHERITED_STATIC_IMAGE_ID["$component"]="$image_id"
}

inspect_target_image() {
  local component="$1"
  local image_ref="$2"
  local inspection
  local image_id
  local revision
  local protected
  local extra
  local expected_source="${COMPONENT_SOURCE_SHA[$component]:-$EXPECTED_RUNTIME_SHA}"

  inspection="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker image inspect \
        --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}' \
        "$image_ref" 2>/dev/null
  )" || { fail "Exact recovery image is unavailable: $image_ref"; return 1; }
  IFS='|' read -r image_id revision protected extra <<<"$inspection"
  [[ -z "$extra" && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { fail "Recovery image returned an invalid identity: $image_ref"; return 1; }
  [[ "$protected" == "true" ]] || { fail "Recovery image is missing its release-protected label: $image_ref"; return 1; }
  if [[ "$component" == "api-shared" || "$component" == eraser || "$API_ONLY_RECOVERY" -eq 1 ]]; then
    [[ "$revision" == "$expected_source" ]] || { fail "Recovery image lacks its exact reviewed component revision label."; return 1; }
  elif [[ -n "$revision" && "$revision" != "<no value>" ]]; then
    [[ "$revision" == "$EXPECTED_RUNTIME_SHA" ]] || { fail "Static recovery image has a mismatched revision label: $image_ref"; return 1; }
  fi
  printf '%s' "$image_id"
}

resolve_target_images() {
  local component
  local image_ref

  FINALIZER_COMPONENTS=(api-shared miniapp-major-static admin-static)
  if [[ -s /var/lib/maxim-secrets/eraser.env ]] || release_manifest field current eraser imageId --current-manifest-file "$RECOVERY_BASE_MANIFEST" >/dev/null 2>&1; then
    FINALIZER_COMPONENTS+=(eraser)
  fi
  for component in "${FINALIZER_COMPONENTS[@]}"; do
    COMPONENT_SOURCE_SHA["$component"]="$EXPECTED_RUNTIME_SHA"
    if [[ "$API_ONLY_RECOVERY" -eq 1 && "$component" != "api-shared" ]]; then
      resolve_inherited_static_component "$component" || return 1
    fi
    image_ref="$(expected_component_ref "$component")" || return 1
    COMPONENT_IMAGE_REF["$component"]="$image_ref"
    COMPONENT_IMAGE_ID["$component"]="$(inspect_target_image "$component" "$image_ref")" || return 1
    if [[ "$API_ONLY_RECOVERY" -eq 1 && "$component" != "api-shared" ]]; then
      [[ "${COMPONENT_IMAGE_ID[$component]}" == "${INHERITED_STATIC_IMAGE_ID[$component]}" ]] || { fail "Inherited static image differs from its transition journal: $component"; return 1; }
    fi
  done
  export MAXIM_API_IMAGE="${COMPONENT_IMAGE_REF[api-shared]}"
  export MAXIM_MINIAPP_MAJOR_IMAGE="${COMPONENT_IMAGE_REF[miniapp-major-static]}"
  export MAXIM_ADMIN_IMAGE="${COMPONENT_IMAGE_REF[admin-static]}"
  if [[ -n "${COMPONENT_IMAGE_REF[eraser]:-}" ]]; then
    export MAXIM_ERASER_IMAGE="${COMPONENT_IMAGE_REF[eraser]}"
    export MAXIM_ERASER_SOURCE_SHA="${COMPONENT_SOURCE_SHA[eraser]}"
  fi
}

verify_target_images_unchanged() {
  local component
  local image_ref
  local image_id

  for component in "${FINALIZER_COMPONENTS[@]}"; do
    image_ref="${COMPONENT_IMAGE_REF[$component]}"
    image_id="$(inspect_target_image "$component" "$image_ref")" || return 1
    [[ "$image_id" == "${COMPONENT_IMAGE_ID[$component]}" ]] || { fail "Recovery image id changed during finalization: $component"; return 1; }
  done
}

inspect_service_runtime() {
  local service="$1"
  local expected_ref="$2"
  local expected_id="$3"
  local container_ids_raw
  local inspection
  local container_id
  local running
  local status
  local image_ref
  local image_id
  local restart_count
  local started_at
  local extra
  local container_ids=()

  container_ids_raw="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker compose "${COMPOSE_FILES[@]}" ps -a -q "$service" 2>/dev/null
  )" || { fail "Could not inspect recovery runtime service: $service"; return 1; }
  [[ -z "$container_ids_raw" ]] || mapfile -t container_ids <<<"$container_ids_raw"
  [[ "${#container_ids[@]}" -eq 1 ]] ||
    { fail "Recovery runtime service is missing or unexpectedly scaled: $service"; return 1; }
  inspection="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker inspect \
        --format '{{.Id}}|{{.State.Running}}|{{.State.Status}}|{{.Config.Image}}|{{.Image}}|{{.RestartCount}}|{{.State.StartedAt}}' \
        "${container_ids[0]}" 2>/dev/null
  )" || { fail "Could not inspect recovery runtime identity: $service"; return 1; }
  IFS='|' read -r container_id running status image_ref image_id restart_count started_at extra \
    <<<"$inspection"
  [[ -z "$extra" && "$container_id" =~ ^[0-9a-f]{64}$ ]] ||
    { fail "Recovery runtime returned an invalid container identity: $service"; return 1; }
  [[ "$running" == "true" && "$status" == "running" ]] ||
    { fail "Recovery runtime service is not running: $service"; return 1; }
  [[ "$image_ref" == "$expected_ref" ]] ||
    { fail "Recovery runtime service does not use the exact target ref: $service"; return 1; }
  [[ "$image_id" == "$expected_id" ]] ||
    { fail "Recovery runtime service does not use the exact target image id: $service"; return 1; }
  [[ "$restart_count" =~ ^[0-9]+$ && -n "$started_at" ]] ||
    { fail "Recovery runtime service returned invalid stability metadata: $service"; return 1; }
  printf '%s|%s|%s|%s\n' "$service" "$container_id" "$restart_count" "$started_at"
}

verify_no_unreviewed_running_api_containers() {
  local running_ids_raw
  local inventory
  local expected_auxiliary=none
  local running_ids=()

  if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    expected_auxiliary="$MAXIM_OCR_NATIVE_SANDBOX_SERVICE"
  fi
  if [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 1 ]]; then
    if [[ "$expected_auxiliary" == none ]]; then
      expected_auxiliary="$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE"
    else
      expected_auxiliary+=",$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE"
    fi
  fi

  running_ids_raw="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker ps --no-trunc -q
  )" || { fail "Could not inspect running containers for the API runtime fence."; return 1; }
  [[ -z "$running_ids_raw" ]] || mapfile -t running_ids <<<"$running_ids_raw"
  [[ "${#running_ids[@]}" -gt 0 ]] || { fail "No running containers were found for runtime fencing."; return 1; }
  inventory="$(
    timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
      docker inspect "${running_ids[@]}" |
      node "$RUNTIME_INVENTORY_HELPER" \
        "${COMPONENT_IMAGE_ID[api-shared]}" "$expected_auxiliary" \
        "${MAXIM_PRODUCTION_API_SERVICES[@]}"
  )" || { fail "Could not classify the running API container inventory."; return 1; }
  if ! printf '%s' "$inventory" | node -e '
      const { readFileSync } = require("node:fs");
      const value = JSON.parse(readFileSync(0).toString("utf8"));
      process.exit(
        Array.isArray(value?.ownedUnreviewedIds) && value.ownedUnreviewedIds.length === 0 &&
        Array.isArray(value?.ambiguousIds) && value.ambiguousIds.length === 0 &&
        Number.isSafeInteger(value?.expectedAuxiliaryCount) &&
        Number.isSafeInteger(value?.reviewedAuxiliaryCount) &&
        value.reviewedAuxiliaryCount === value.expectedAuxiliaryCount ? 0 : 1,
      );
    '; then
    fail "An unreviewed, ambiguous, orphaned, or duplicate API container is running."
    return 1
  fi
}

verify_runtime_snapshot() {
  local service

  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    inspect_service_runtime \
      "$service" \
      "${COMPONENT_IMAGE_REF[api-shared]}" \
      "${COMPONENT_IMAGE_ID[api-shared]}" || return 1
  done
  if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    inspect_service_runtime \
      "$MAXIM_OCR_NATIVE_SANDBOX_SERVICE" \
      "${COMPONENT_IMAGE_REF[api-shared]}" \
      "${COMPONENT_IMAGE_ID[api-shared]}" || return 1
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "${COMPONENT_IMAGE_ID[api-shared]}" with-media || return 1
  else
    maxim_topology_require_ocr_native_sandbox_absent COMPOSE_FILES || return 1
  fi
  maxim_topology_verify_photo_native_sandbox_for_image COMPOSE_FILES "${COMPONENT_IMAGE_ID[api-shared]}" || return 1
  if [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 1 ]]; then
    inspect_service_runtime "$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE" \
      "${COMPONENT_IMAGE_REF[api-shared]}" "${COMPONENT_IMAGE_ID[api-shared]}" || return 1
  fi
  inspect_service_runtime \
    miniapp-major-static \
    "${COMPONENT_IMAGE_REF[miniapp-major-static]}" \
    "${COMPONENT_IMAGE_ID[miniapp-major-static]}" || return 1
  inspect_service_runtime \
    admin-static \
    "${COMPONENT_IMAGE_REF[admin-static]}" \
    "${COMPONENT_IMAGE_ID[admin-static]}" || return 1
  if [[ -n "${COMPONENT_IMAGE_ID[eraser]:-}" ]]; then
    inspect_service_runtime eraser "${COMPONENT_IMAGE_REF[eraser]}" "${COMPONENT_IMAGE_ID[eraser]}" || return 1
  fi
  verify_no_unreviewed_running_api_containers || return 1
}

read_webhook_queue_status() {
  timeout --foreground --kill-after=5s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T api-admin node - status \
    <"$WEBHOOK_QUEUE_CONTROL_HELPER"
}

validate_webhook_queue_status() {
  local summary="$1"

  printf '%s' "$summary" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0).toString("utf8"));
    const valid =
      value?.queueCount === 24 &&
      value?.pausedCount === 0 &&
      Number.isSafeInteger(value?.activeCount) &&
      value.activeCount >= 0 &&
      value?.ownerPresent === false;
    process.exit(valid ? 0 : 1);
  '
}

assert_webhook_queue_fence_released() {
  local summary

  summary="$(read_webhook_queue_status)" ||
    { fail "Could not inspect the webhook rollout queue fence."; return 1; }
  validate_webhook_queue_status "$summary" ||
    { fail "Webhook queues remain paused, owned, or topologically incomplete."; return 1; }
}

require_stateful_services_ready() {
  local running
  local service

  running="$(docker compose "${COMPOSE_FILES[@]}" ps --status running --services)" ||
    { fail "Could not inspect stateful runtime dependencies."; return 1; }
  for service in postgres redis; do
    grep -Fxq "$service" <<<"$running" || { fail "$service is not already running."; return 1; }
  done
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
      pg_isready -U maxim -d maxim >/dev/null 2>&1 || { fail "Postgres is not ready."; return 1; }
  timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T redis redis-cli ping 2>/dev/null |
    grep -Fxq PONG || { fail "Redis is not ready."; return 1; }
}

capture_applied_migrations() {
  local pgoptions

  [[ -z "$MIGRATIONS_FILE" ]] || { fail "The Prisma migration snapshot was already captured."; return 1; }
  MIGRATIONS_FILE="$(mktemp /tmp/maxim-release-finalizer-migrations.XXXXXX)" ||
    { fail "Could not create the recovery finalizer migration snapshot."; return 1; }
  chmod 0600 "$MIGRATIONS_FILE" ||
    { fail "Could not restrict the recovery finalizer migration snapshot."; return 1; }

  pgoptions="-c default_transaction_read_only=on -c statement_timeout=5s -c lock_timeout=500ms"
  pgoptions+=" -c idle_in_transaction_session_timeout=5s -c max_parallel_workers_per_gather=0"
  pgoptions+=" -c application_name=maxim_release_finalizer_$$"
  if ! timeout --foreground --kill-after=2s "${COMMAND_TIMEOUT_SEC}s" \
    docker compose "${COMPOSE_FILES[@]}" exec -T -e "PGOPTIONS=$pgoptions" postgres \
      psql -X --no-password -v ON_ERROR_STOP=1 -U maxim -d maxim -Atq \
        -c 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;' \
      | head -c "$((MAX_MIGRATIONS_FILE_BYTES + 1))" >"$MIGRATIONS_FILE"; then
    fail "Could not read the currently applied Prisma migrations."
    return 1
  fi

  if ! node - "$MIGRATIONS_FILE" "$MAX_MIGRATIONS_FILE_BYTES" <<'NODE'
const { readFileSync, statSync } = require('node:fs');

const migrationFile = process.argv[2];
const maxBytes = Number(process.argv[3]);
const size = statSync(migrationFile).size;
if (!Number.isSafeInteger(maxBytes) || size === 0 || size > maxBytes) {
  process.exit(1);
}

const contents = readFileSync(migrationFile, 'utf8');
if (!contents.endsWith('\n')) {
  process.exit(1);
}
const migrations = contents.slice(0, -1).split('\n');
const migrationNamePattern = /^[0-9]{14}_[a-z0-9][a-z0-9_]{0,240}$/u;
const canonical = [...new Set(migrations)].sort();
const valid =
  migrations.length > 0 &&
  migrations.every((migration) => migrationNamePattern.test(migration)) &&
  canonical.length === migrations.length &&
  canonical.every((migration, index) => migration === migrations[index]);
process.exit(valid ? 0 : 1);
NODE
  then
    fail "Applied Prisma migrations returned invalid or excessive output."
    return 1
  fi
}

run_http_smoke() {
  local kind="$1"
  local url="$2"

  timeout --foreground --kill-after=5s 60s \
    node "$ROOT_DIR/scripts/smoke-http.mjs" "$kind" "$url"
}

prepare_target_ocr_runtime() {
  maxim_topology_prepare_commercial_ocr_target \
    "$EXPECTED_RUNTIME_SHA" \
    COMPOSE_FILES \
    TARGET_HAS_MEDIA_ANALYSIS \
    TARGET_COMMERCIAL_OCR_VERSION \
    TARGET_HAS_OCR_NATIVE_SANDBOX || return 1
  maxim_topology_prepare_photo_native_target "${EXPECTED_RUNTIME_SHA}" COMPOSE_FILES || return 1
  # FLAG: Preparation helpers also run under explicit status checks; re-prove their
  # configuration gates so Bash conditional contexts cannot mask an earlier refusal.
  maxim_topology_require_api_commercial_ocr_version_config COMPOSE_FILES "$TARGET_COMMERCIAL_OCR_VERSION" || return 1
  maxim_topology_require_media_analysis_rollout_config COMPOSE_FILES "$EXPECTED_RUNTIME_SHA" || return 1
  maxim_topology_require_ocr_native_sandbox_config COMPOSE_FILES || return 1
  [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]] ||
    { fail "Recovery finalization requires the reviewed media-analysis topology."; return 1; }
  [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]] ||
    { fail "Recovery finalization requires the reviewed native OCR sandbox topology."; return 1; }
  maxim_topology_require_ocr_native_sandbox_image_capability \
    "${COMPONENT_IMAGE_ID[api-shared]}" "$TARGET_HAS_OCR_NATIVE_SANDBOX" || return 1
  maxim_topology_require_photo_native_image_capability "${COMPONENT_IMAGE_ID[api-shared]}" || return 1
}

run_strict_finalizer_smokes() {
  require_stateful_services_ready || return 1
  maxim_topology_verify_api_commercial_ocr_version \
    COMPOSE_FILES \
    "$TARGET_COMMERCIAL_OCR_VERSION" || return 1

  run_http_smoke json-ok http://127.0.0.1:3001/api/health/live || return 1
  run_http_smoke json-ok http://127.0.0.1:3001/api/health/ready || return 1
  run_http_smoke json-ok http://127.0.0.1:3002/api/health/live || return 1
  run_http_smoke json-ok http://127.0.0.1:3002/api/health/ready || return 1
  run_http_smoke json-ok "$PUBLIC_HEALTH_URL/api/health/live" || return 1
  run_http_smoke static http://127.0.0.1:3003/app/ || return 1
  run_http_smoke static "$PUBLIC_HEALTH_URL/app/" || return 1
  run_http_smoke static http://127.0.0.1:3004/ || return 1
  maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required sandbox || return 1
  if [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_smoke_photo_native_sandbox_uds COMPOSE_FILES "${COMPONENT_IMAGE_ID[api-shared]}" || return 1
  fi

  SMOKE_RESULTS=(
    "api-local-live"
    "api-local-ready"
    "api-admin-live"
    "api-admin-ready"
    "api-public-live"
    "api-commercial-ocr-version"
    "api-media-analysis-tesseract-rus-eng"
    "api-media-analysis-shadow"
    "api-media-analysis-native-raster"
    "api-media-analysis-internal-ready"
    "api-ocr-native-sandbox-isolation"
    "api-ocr-native-sandbox-uds"
    "api-ocr-native-sandbox-process-clean"
    "miniapp-major-static-local"
    "miniapp-major-static"
    "admin-static"
    "webhook-queues-released"
    "recovery-finalizer-runtime-stable"
  )
  if [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 1 ]]; then
    SMOKE_RESULTS+=(api-photo-native-sandbox-isolation api-photo-native-sandbox-uds)
  fi
}

wait_for_runtime_stability() {
  local started_at="$1"
  local elapsed=$((SECONDS - started_at))

  if ((elapsed < STABILITY_WINDOW_SEC)); then
    sleep "$((STABILITY_WINDOW_SEC - elapsed))"
  fi
}

commit_recovered_release() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  verify_synchronized_checkout || return
  verify_controller_runtime_compatibility || return
  maxim_routing_index_require_release "${COMPONENT_SOURCE_SHA[api-shared]}" COMPOSE_FILES || return
  local release_id
  local component
  local smoke
  local args

  release_id="release-finalized-$(date -u +%Y%m%dT%H%M%SZ)-${EXPECTED_RUNTIME_SHA:0:12}-$$"
  args=(
    commit
    --release-id "$release_id"
    --target-sha "$EXPECTED_RUNTIME_SHA"
    --current-manifest-file "$RECOVERY_BASE_MANIFEST"
    --migrations-file "$MIGRATIONS_FILE"
  )
  for component in "${FINALIZER_COMPONENTS[@]}"; do
    args+=(
      --component
      "${component}|${COMPONENT_SOURCE_SHA[$component]:-$EXPECTED_RUNTIME_SHA}|${COMPONENT_IMAGE_REF[$component]}|${COMPONENT_IMAGE_ID[$component]}"
    )
  done
  if [[ -n "${COMPONENT_IMAGE_ID[eraser]:-}" ]]; then
    node infra/scripts/eraser-smoke.mjs "${COMPONENT_SOURCE_SHA[eraser]}" || return 1
    SMOKE_RESULTS+=(eraser-exact-source-ready)
  fi
  for smoke in "${SMOKE_RESULTS[@]}"; do
    args+=(--smoke "$smoke")
  done

  release_manifest "${args[@]}" >/dev/null || { fail "Could not commit the recovered exact-SHA release manifest."; return 1; }
  release_manifest archive-transition \
    --current-manifest-file "$RECOVERY_BASE_MANIFEST" \
    --disposition recovered >/dev/null || { fail "Current release was committed, but the recovery journal could not be archived."; return 1; }
  echo "Release recovery finalized without runtime recreation: $release_id"
}

main() {
  local runtime_before
  local runtime_after
  local stability_started_at

  if [[ "$#" -gt 0 && "$1" != --api-only ]]; then
    BRANCH="$1"
    shift
  fi
  BRANCH="${BRANCH:-main}"
  if [[ "$#" -eq 1 && "$1" == --api-only ]]; then
    API_ONLY_RECOVERY=1
  elif [[ "$#" -ne 0 ]]; then
    fail "Usage: $0 [branch] [--api-only]"
    return 2
  fi
  validate_finalizer_environment || return 1
  acquire_deploy_lock || return 1
  trap finalizer_cleanup EXIT
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  verify_synchronized_checkout || return
  verify_controller_runtime_compatibility || return
  resolve_recovery_base_manifest || return 1
  resolve_target_images || return 1
  prepare_target_ocr_runtime || return 1

  stability_started_at=$SECONDS
  runtime_before="$(verify_runtime_snapshot)" || return 1
  assert_webhook_queue_fence_released || return 1
  run_strict_finalizer_smokes || return 1
  wait_for_runtime_stability "$stability_started_at" || return 1

  verify_target_images_unchanged || return 1
  runtime_after="$(verify_runtime_snapshot)" || return 1
  [[ "$runtime_after" == "$runtime_before" ]] ||
    { fail "Recovery runtime changed or restarted during strict finalizer smokes."; return 1; }
  capture_applied_migrations || return 1
  assert_webhook_queue_fence_released || return 1
  verify_recovery_base_unchanged || return 1
  commit_recovered_release || return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
