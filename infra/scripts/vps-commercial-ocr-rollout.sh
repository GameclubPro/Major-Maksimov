#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source "$ROOT_DIR/infra/scripts/lib/legacy-cold-maintenance.sh" || exit $?

COMPOSE_FILES=(--env-file ".env" -p infra -f "infra/docker-compose.yml")
RELEASE_STATE_DIR="${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
STATE_HELPER="$ROOT_DIR/infra/scripts/commercial-ocr-rollout-state.mjs"
INVENTORY_HELPER="$ROOT_DIR/infra/scripts/commercial-ocr-runtime-inventory.mjs"
ADMISSION_DRAIN_PROBE="$ROOT_DIR/infra/scripts/commercial-ocr-admission-drain-probe.cjs"
RUNTIME_CONTROL_SCRIPT="apps/api/dist/apps/api/src/scripts/commercial-ocr-runtime-control.js"
CERTIFICATION_VERIFIER_SCRIPT="apps/api/dist/apps/api/src/scripts/verify-commercial-ocr-certification.js"
MEDIA_SERVICE="$MAXIM_MEDIA_ANALYSIS_SERVICE"
CONTROL_TTL_SEC="${MAXIM_COMMERCIAL_OCR_CONTROL_TTL_SEC:-3600}"
CONTROL_ACTOR="${MAXIM_COMMERCIAL_OCR_CONTROL_ACTOR:-operator:vps-rollout}"
CONTROL_REASON="${MAXIM_COMMERCIAL_OCR_CONTROL_REASON:-bounded commercial OCR canary}"
MIN_CONTROL_TTL_SEC=600
MIN_FINAL_CONTROL_TTL_SEC=300
API_READINESS_TIMEOUT_SEC="${MAXIM_COMMERCIAL_OCR_READINESS_TIMEOUT_SEC:-180}"
API_STABILITY_WINDOW_SEC="${MAXIM_COMMERCIAL_OCR_STABILITY_WINDOW_SEC:-5}"
DRAIN_TIMEOUT_SEC="${MAXIM_COMMERCIAL_OCR_DRAIN_TIMEOUT_SEC:-180}"
MAX_DRAIN_PROBE_TIMEOUT_SEC=5
DRAIN_PROBE_KILL_GRACE_SEC=1
READINESS_COMMAND_MAX_TIMEOUT_SEC=5
READINESS_COMMAND_KILL_GRACE_SEC=1
DOCKER_MUTATION_MAX_TIMEOUT_SEC=30
QUEUE_STATES=(waiting active delayed prioritized paused waiting-children)
NON_MEDIA_SERVICES=(
  "api-enqueue"
  "api-action"
  "api-publisher"
  "api-message-retention"
  "api-moderation"
  "api-moderation-critical"
  "api-moderation-join"
  "api-moderation-realtime-b"
  "api-moderation-realtime-c"
  "api-moderation-realtime-d"
  "api-moderation-background"
  "api-admin"
  "api-ingress"
)
OCR_PRODUCER_SERVICES=(
  "api-moderation"
  "api-moderation-critical"
  "api-moderation-join"
  "api-moderation-realtime-b"
  "api-moderation-realtime-c"
  "api-moderation-realtime-d"
  "api-moderation-background"
)
HTTP_READY_SERVICES=(
  "api-ingress"
  "api-admin"
  "api-media-analysis"
)
RECOVERY_QUIESCE_SERVICES=(
  "api-action"
  "${OCR_PRODUCER_SERVICES[@]}"
)

# Compose interpolation gives the caller's exported environment precedence over --env-file.
# Rollout state must come only from the atomically patched production file.
unset \
  COMMERCIAL_OCR_ROLLOUT_MODE \
  COMMERCIAL_OCR_CANARY_CHAT_IDS \
  COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64 \
  MODERATION_DELETE_INTENT_MODE \
  MODERATION_DELETE_INTENT_CANARY_CHAT_IDS \
  MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS \
  MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED \
  MAXIM_COMPOSE_SERVICE_ENV_FILE
export MAXIM_COMPOSE_SERVICE_ENV_FILE=../.env

COMMAND="${1:-}"
CHAT_IDS_FILE=""
CERTIFICATION_FILE=""
CERTIFICATION_SHA256=""
EXPECTED_REVISION=""
APPLY=0
RECOVERY_ARMED=0
ROLLOUT_COMPLETE=0
RECOVERY_QUIESCENCE_PROVEN=0
COHORT_FILE=""
CONTROL_FILE=""
CONTROL_OUTPUT_FILE=""
CERTIFICATION_VERIFICATION_FILE=""
APPLIED_CONTROL_EXPIRES_AT=""
RUNTIME_INVENTORY_OWNED_UNREVIEWED_IDS=()
RUNTIME_INVENTORY_AMBIGUOUS_COUNT=0
EXPECTED_HAS_OCR_NATIVE_SANDBOX=0

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/vps-commercial-ocr-rollout.sh promote --chat-ids-file <path> --certification-file <path> --certification-sha256 <digest> --expected-revision <none|n> [--apply]
  ./infra/scripts/vps-commercial-ocr-rollout.sh downgrade --expected-revision <n> [--apply]
  ./infra/scripts/vps-commercial-ocr-rollout.sh recover-shadow [--apply]
  ./infra/scripts/vps-commercial-ocr-rollout.sh status

Without --apply, both commands take the shared deploy lock and run a read-only preflight.
Promotion accepts one exact numeric MAX chat id per line and one passing certification envelope.
Their contents and control JSON are never printed. Code deploy and production promotion remain
separate operations.
USAGE
}

fail() {
  printf '%s\n' "$1" >&2
  return 1
}

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 && "$APPLY" -eq 1 && "$RECOVERY_ARMED" -eq 1 && "$ROLLOUT_COMPLETE" -ne 1 ]]; then
    printf '%s\n' "Rollout did not complete; restoring environment ceilings to shadow." >&2
    if recover_shadow; then
      printf '%s\n' "Environment ceilings recovered to shadow; inspect runtime control before retrying." >&2
    elif [[ "$RECOVERY_QUIESCENCE_PROVEN" -eq 1 ]]; then
      printf '%s\n' "CRITICAL: automatic shadow recovery was not proven across all API roles; enforcement-capable roles are quiesced." >&2
    else
      printf '%s\n' "CRITICAL: automatic shadow recovery and enforcement-role quiescence were not proven." >&2
    fi
  fi
  [[ -z "$COHORT_FILE" ]] || rm -f -- "$COHORT_FILE"
  [[ -z "$CONTROL_FILE" ]] || rm -f -- "$CONTROL_FILE"
  [[ -z "$CONTROL_OUTPUT_FILE" ]] || rm -f -- "$CONTROL_OUTPUT_FILE"
  [[ -z "$CERTIFICATION_VERIFICATION_FILE" ]] || rm -f -- "$CERTIFICATION_VERIFICATION_FILE"
  release_deploy_lock || true
  return "$status"
}

parse_args() {
  if [[ "$COMMAND" != "promote" && "$COMMAND" != "downgrade" && \
    "$COMMAND" != "recover-shadow" && "$COMMAND" != "status" ]]; then
    usage
    exit 2
  fi
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --chat-ids-file)
        if [[ $# -lt 2 ]]; then fail "--chat-ids-file requires a path."; fi
        if [[ -n "$CHAT_IDS_FILE" ]]; then fail "--chat-ids-file may be provided only once."; fi
        CHAT_IDS_FILE="$2"
        shift 2
        ;;
      --certification-file)
        if [[ $# -lt 2 ]]; then fail "--certification-file requires a path."; fi
        if [[ -n "$CERTIFICATION_FILE" ]]; then fail "--certification-file may be provided only once."; fi
        CERTIFICATION_FILE="$2"
        shift 2
        ;;
      --certification-sha256)
        if [[ $# -lt 2 ]]; then fail "--certification-sha256 requires a digest."; fi
        if [[ -n "$CERTIFICATION_SHA256" ]]; then fail "--certification-sha256 may be provided only once."; fi
        CERTIFICATION_SHA256="$2"
        shift 2
        ;;
      --expected-revision)
        if [[ $# -lt 2 ]]; then fail "--expected-revision requires none or a positive integer."; fi
        if [[ -n "$EXPECTED_REVISION" ]]; then fail "--expected-revision may be provided only once."; fi
        EXPECTED_REVISION="$2"
        shift 2
        ;;
      --apply)
        if [[ "$APPLY" -ne 0 ]]; then fail "--apply may be provided only once."; fi
        APPLY=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown rollout option."
        return 1
        ;;
    esac
  done
  if [[ "$COMMAND" == "promote" ]]; then
    if [[ -z "$EXPECTED_REVISION" ]]; then fail "--expected-revision is required."; fi
    if [[ -z "$CHAT_IDS_FILE" || ! -f "$CHAT_IDS_FILE" ]]; then
      fail "Promotion requires a readable --chat-ids-file."
    fi
    if [[ -z "$CERTIFICATION_FILE" || ! -f "$CERTIFICATION_FILE" ]]; then
      fail "Promotion requires a readable --certification-file."
    fi
    if [[ ! "$CERTIFICATION_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
      fail "Promotion requires a canonical --certification-sha256 digest."
    fi
    if [[ "$EXPECTED_REVISION" != "none" && ! "$EXPECTED_REVISION" =~ ^[1-9][0-9]*$ ]]; then
      fail "Promotion expected revision must be none or a positive integer."
    fi
  elif [[ "$COMMAND" == "downgrade" ]]; then
    if [[ -z "$EXPECTED_REVISION" ]]; then fail "--expected-revision is required."; fi
    if [[ -n "$CHAT_IDS_FILE" || -n "$CERTIFICATION_FILE" || -n "$CERTIFICATION_SHA256" ]]; then
      fail "Downgrade does not accept promotion inputs."
    fi
    if [[ ! "$EXPECTED_REVISION" =~ ^[1-9][0-9]*$ ]]; then
      fail "Downgrade expected revision must be a positive integer."
    fi
  else
    if [[ -n "$CHAT_IDS_FILE" || -n "$CERTIFICATION_FILE" || \
      -n "$CERTIFICATION_SHA256" || -n "$EXPECTED_REVISION" ]]; then
      fail "Status and shadow recovery do not accept promotion or revision arguments."
    fi
    if [[ "$COMMAND" == "status" && "$APPLY" -ne 0 ]]; then
      fail "Status does not accept --apply."
    fi
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found."
}

require_node_24() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" == "24" ]] || fail "Node 24 is required for commercial OCR rollout."
}

require_operational_limits() {
  local readiness_timeout stability_window drain_timeout
  if [[ ! "$API_READINESS_TIMEOUT_SEC" =~ ^[0-9]{1,3}$ ]]; then
    fail "Commercial OCR readiness timeout must be between 30 and 600 seconds."
  fi
  readiness_timeout=$((10#$API_READINESS_TIMEOUT_SEC))
  if ((readiness_timeout < 30 || readiness_timeout > 600)); then
    fail "Commercial OCR readiness timeout must be between 30 and 600 seconds."
  fi
  if [[ ! "$API_STABILITY_WINDOW_SEC" =~ ^[0-9]{1,3}$ ]]; then
    fail "Commercial OCR stability window must be between 2 and 30 seconds and below the readiness timeout."
  fi
  stability_window=$((10#$API_STABILITY_WINDOW_SEC))
  if ((stability_window < 2 || stability_window > 30 ||
    stability_window >= readiness_timeout)); then
    fail "Commercial OCR stability window must be between 2 and 30 seconds and below the readiness timeout."
  fi
  if [[ ! "$DRAIN_TIMEOUT_SEC" =~ ^[0-9]{1,3}$ ]]; then
    fail "Commercial OCR drain timeout must be between 30 and 600 seconds."
  fi
  drain_timeout=$((10#$DRAIN_TIMEOUT_SEC))
  if ((drain_timeout < 30 || drain_timeout > 600)); then
    fail "Commercial OCR drain timeout must be between 30 and 600 seconds."
  fi
  API_READINESS_TIMEOUT_SEC="$readiness_timeout"
  API_STABILITY_WINDOW_SEC="$stability_window"
  DRAIN_TIMEOUT_SEC="$drain_timeout"
}

expected_app_role_for_service() {
  case "$1" in
    api-ingress) printf '%s' "ingress" ;;
    api-admin) printf '%s' "admin" ;;
    api-enqueue) printf '%s' "enqueue" ;;
    api-action) printf '%s' "action" ;;
    api-publisher) printf '%s' "publisher" ;;
    api-message-retention) printf '%s' "message-retention" ;;
    api-moderation | api-moderation-critical | api-moderation-join | \
      api-moderation-realtime-b | api-moderation-realtime-c | \
      api-moderation-realtime-d | api-moderation-background | api-media-analysis)
      printf '%s' "moderation"
      ;;
    *) return 1 ;;
  esac
}

require_topology() {
  if [[ "${#MAXIM_PRODUCTION_API_SERVICES[@]}" -ne 14 ]]; then
    fail "Commercial OCR rollout requires the reviewed 14-role API topology."
  fi
  if [[ "${#NON_MEDIA_SERVICES[@]}" -ne 13 ]]; then
    fail "Commercial OCR rollout requires exactly 13 non-media API roles."
  fi
  if [[ "${#OCR_PRODUCER_SERVICES[@]}" -ne 7 ]]; then
    fail "Commercial OCR rollout requires exactly seven moderation producer roles."
  fi
  if [[ "${#RECOVERY_QUIESCE_SERVICES[@]}" -ne 8 ]]; then
    fail "Commercial OCR recovery requires action plus seven producer roles."
  fi
  if [[ "${#HTTP_READY_SERVICES[@]}" -ne 3 ]]; then
    fail "Commercial OCR rollout requires exactly three HTTP-ready API roles."
  fi
  if [[ "$MEDIA_SERVICE" != "api-media-analysis" ]]; then
    fail "Commercial OCR rollout requires the reviewed media-analysis role."
  fi
  local service expected_role
  local production_seen=()
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    expected_app_role_for_service "$service" >/dev/null ||
      fail "Commercial OCR rollout contains an unreviewed API role."
    if maxim_topology_contains "$service" "${production_seen[@]}"; then
      fail "Commercial OCR rollout API roles must be unique."
    fi
    production_seen+=("$service")
  done
  local non_media_seen=()
  for service in "${NON_MEDIA_SERVICES[@]}"; do
    maxim_topology_contains "$service" "${MAXIM_PRODUCTION_API_SERVICES[@]}" ||
      fail "Commercial OCR rollout contains an unknown non-media API role."
    [[ "$service" != "$MEDIA_SERVICE" ]] ||
      fail "Commercial OCR rollout media role must not be in the non-media partition."
    if maxim_topology_contains "$service" "${non_media_seen[@]}"; then
      fail "Commercial OCR rollout non-media API roles must be unique."
    fi
    non_media_seen+=("$service")
  done
  local producer_seen=()
  for service in "${OCR_PRODUCER_SERVICES[@]}"; do
    maxim_topology_contains "$service" "${NON_MEDIA_SERVICES[@]}" ||
      fail "Commercial OCR producer role is outside the non-media partition."
    if maxim_topology_contains "$service" "${producer_seen[@]}"; then
      fail "Commercial OCR producer roles must be unique."
    fi
    producer_seen+=("$service")
  done
  local recovery_seen=()
  for service in "${RECOVERY_QUIESCE_SERVICES[@]}"; do
    maxim_topology_contains "$service" "${MAXIM_PRODUCTION_API_SERVICES[@]}" ||
      fail "Commercial OCR recovery contains an unknown API role."
    if maxim_topology_contains "$service" "${recovery_seen[@]}"; then
      fail "Commercial OCR recovery roles must be unique."
    fi
    recovery_seen+=("$service")
  done
  local http_ready_seen=()
  for service in "${HTTP_READY_SERVICES[@]}"; do
    maxim_topology_contains "$service" "${MAXIM_PRODUCTION_API_SERVICES[@]}" ||
      fail "Commercial OCR HTTP readiness contains an unknown API role."
    if maxim_topology_contains "$service" "${http_ready_seen[@]}"; then
      fail "Commercial OCR HTTP-ready API roles must be unique."
    fi
    http_ready_seen+=("$service")
  done
  for service in "api-ingress" "api-admin" "$MEDIA_SERVICE"; do
    maxim_topology_contains "$service" "${HTTP_READY_SERVICES[@]}" ||
      fail "Commercial OCR HTTP readiness topology is incomplete."
  done
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    if [[ "$service" != "$MEDIA_SERVICE" ]] &&
      ! maxim_topology_contains "$service" "${NON_MEDIA_SERVICES[@]}"; then
      fail "Commercial OCR rollout topology is incomplete."
    fi
    expected_role="$(expected_app_role_for_service "$service")"
    if [[ "$expected_role" == "moderation" && "$service" != "$MEDIA_SERVICE" ]]; then
      maxim_topology_contains "$service" "${OCR_PRODUCER_SERVICES[@]}" ||
        fail "Commercial OCR moderation producer partition is incomplete."
    elif maxim_topology_contains "$service" "${OCR_PRODUCER_SERVICES[@]}"; then
      fail "Commercial OCR producer partition contains a non-producer role."
    fi
  done
}

manifest_field() {
  node "$ROOT_DIR/infra/scripts/release-manifest.mjs" field current api-shared "$1" \
    --state-dir "$RELEASE_STATE_DIR"
}

resolve_release_fence() {
  if ! MANIFEST_SOURCE_SHA="$(manifest_field sourceSha)"; then
    fail "Current API release manifest is missing."
    return 1
  fi
  if ! MANIFEST_IMAGE_REF="$(manifest_field imageRef)"; then
    fail "Current API image ref is missing."
    return 1
  fi
  if ! MANIFEST_IMAGE_ID="$(manifest_field imageId)"; then
    fail "Current API image id is missing."
    return 1
  fi
  if ! CHECKOUT_SHA="$(git rev-parse --verify HEAD)"; then
    fail "Current checkout SHA is unavailable."
    return 1
  fi
  if [[ "$MANIFEST_SOURCE_SHA" != "$CHECKOUT_SHA" ]]; then
    fail "Current checkout does not match the active API release source SHA."
    return 1
  fi
  if ! git diff --quiet -- .; then
    fail "Tracked VPS checkout changes block commercial OCR rollout."
    return 1
  fi
  if ! git diff --cached --quiet -- .; then
    fail "Staged VPS checkout changes block commercial OCR rollout."
    return 1
  fi
  if ! EXPECTED_OCR_VERSION="$(maxim_topology_git_commercial_ocr_version "$CHECKOUT_SHA")"; then
    fail "Could not derive the commercial OCR version from the active source."
    return 1
  fi
  maxim_topology_prepare_photo_native_target "$CHECKOUT_SHA" COMPOSE_FILES
  if maxim_topology_git_has_ocr_native_sandbox "$CHECKOUT_SHA"; then
    EXPECTED_HAS_OCR_NATIVE_SANDBOX=1
    maxim_topology_require_ocr_native_sandbox_config COMPOSE_FILES
  else
    local sandbox_status=$?
    if [[ "$sandbox_status" -ne 1 ]]; then
      fail "Could not resolve the active native OCR sandbox topology."
      return 1
    fi
    EXPECTED_HAS_OCR_NATIVE_SANDBOX=0
  fi
  local image_fence deadline
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  if ! image_fence="$(
    run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
      docker image inspect --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.maxim.release-protected"}}' \
      "$MANIFEST_IMAGE_REF" 2>/dev/null
  )"; then
    fail "The active API image is not available locally."
    return 1
  fi
  if [[ "$image_fence" != "${MANIFEST_IMAGE_ID}|${MANIFEST_SOURCE_SHA}|true" ]]; then
    fail "The active API image does not match its manifest and protected revision labels."
    return 1
  fi
  maxim_topology_require_ocr_native_sandbox_image_capability \
    "$MANIFEST_IMAGE_ID" "$EXPECTED_HAS_OCR_NATIVE_SANDBOX"
  maxim_topology_require_photo_native_image_capability "$MANIFEST_IMAGE_ID"
  export MAXIM_API_IMAGE="$MANIFEST_IMAGE_REF"
  export COMMERCIAL_OCR_VERSION="$EXPECTED_OCR_VERSION"
}

container_env_summary() {
  local container_id="$1" deadline="${2:-$((SECONDS + API_READINESS_TIMEOUT_SEC))}"
  run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
    node -e '
      const { readFileSync } = require("node:fs");
      const allowed = new Set([
        "APP_ROLE",
        "APP_SERVICE_NAME",
        "COMMERCIAL_OCR_ROLLOUT_MODE",
        "COMMERCIAL_OCR_CANARY_CHAT_IDS",
        "COMMERCIAL_OCR_VERSION",
      ]);
      const result = {};
      for (const line of readFileSync(0).toString("utf8").split(/\r?\n/u)) {
        const separator = line.indexOf("=");
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        if (!allowed.has(key)) continue;
        if (Object.hasOwn(result, key)) process.exit(3);
        result[key] = line.slice(separator + 1);
      }
      process.stdout.write(JSON.stringify(result));
    '
}

read_running_api_inventory() {
  local deadline="${1:-$((SECONDS + API_READINESS_TIMEOUT_SEC))}"
  local running_ids_raw inventory_json expected_image_id expected_auxiliary inventory_summary
  local running_ids=()
  running_ids_raw="$(
    run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
      docker ps --no-trunc -q
  )" || return 1
  if [[ -n "$running_ids_raw" ]]; then
    mapfile -t running_ids <<<"$running_ids_raw"
  fi
  expected_image_id="${MANIFEST_IMAGE_ID:-none}"
  expected_auxiliary=none
  if [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    expected_auxiliary="$(maxim_topology_ocr_compose_csv COMPOSE_FILES)" || return 1
  fi
  if [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 1 ]]; then
    if [[ "$expected_auxiliary" == none ]]; then
      expected_auxiliary="$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE"
    else
      expected_auxiliary+=",$MAXIM_PHOTO_NATIVE_SANDBOX_SERVICE"
    fi
  fi
  if [[ "${#running_ids[@]}" -eq 0 ]]; then
    inventory_json="$(
      printf '%s\n' '[]' |
        node "$INVENTORY_HELPER" "$expected_image_id" "$expected_auxiliary" \
          "${MAXIM_PRODUCTION_API_SERVICES[@]}"
    )" || return 1
  else
    inventory_json="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker inspect "${running_ids[@]}" |
        node "$INVENTORY_HELPER" "$expected_image_id" "$expected_auxiliary" \
          "${MAXIM_PRODUCTION_API_SERVICES[@]}"
    )" || return 1
  fi
  inventory_summary="$(printf '%s' "$inventory_json" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0).toString("utf8"));
    const owned = value?.ownedUnreviewedIds;
    const ambiguous = value?.ambiguousIds;
    if (
      !Array.isArray(owned) || !Array.isArray(ambiguous) ||
      !Number.isSafeInteger(value?.expectedAuxiliaryCount) ||
      !Number.isSafeInteger(value?.reviewedAuxiliaryCount) ||
      value.reviewedAuxiliaryCount !== value.expectedAuxiliaryCount ||
      [...owned, ...ambiguous].some((id) => typeof id !== "string" || !/^[a-f0-9]{12,64}$/u.test(id))
    ) process.exit(2);
    process.stdout.write(String(ambiguous.length) + "\n" + owned.join("\n"));
  ')" || return 1
  RUNTIME_INVENTORY_OWNED_UNREVIEWED_IDS=()
  RUNTIME_INVENTORY_AMBIGUOUS_COUNT="${inventory_summary%%$'\n'*}"
  [[ "$RUNTIME_INVENTORY_AMBIGUOUS_COUNT" =~ ^[0-9]+$ ]] || return 1
  if [[ "$inventory_summary" == *$'\n'* ]]; then
    local owned_ids_raw="${inventory_summary#*$'\n'}"
    if [[ -n "$owned_ids_raw" ]]; then
      mapfile -t RUNTIME_INVENTORY_OWNED_UNREVIEWED_IDS <<<"$owned_ids_raw"
    fi
  fi
}

verify_no_unreviewed_running_api_containers() {
  local deadline="${1:-$((SECONDS + API_READINESS_TIMEOUT_SEC))}"
  if ! read_running_api_inventory "$deadline"; then
    fail "Could not inspect the running API container inventory."
    return 1
  fi
  if [[ "${#RUNTIME_INVENTORY_OWNED_UNREVIEWED_IDS[@]}" -gt 0 || \
    "$RUNTIME_INVENTORY_AMBIGUOUS_COUNT" -gt 0 ]]; then
    fail "An owned-unreviewed, ambiguous, foreign, orphaned, or duplicate API container is running."
    return 1
  fi
}

reviewed_running_container_id() {
  local service="$1" deadline container_ids_raw image_id env_summary
  local container_ids=()
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  container_ids_raw="$(
    run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
      docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
  )" || return 1
  if [[ -n "$container_ids_raw" ]]; then
    mapfile -t container_ids <<<"$container_ids_raw"
  fi
  [[ "${#container_ids[@]}" -eq 1 ]] || return 1
  image_id="$(
    run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
      docker inspect --format '{{.Image}}' "${container_ids[0]}" 2>/dev/null
  )" || return 1
  [[ "$image_id" == "$MANIFEST_IMAGE_ID" ]] || return 1
  env_summary="$(container_env_summary "${container_ids[0]}" "$deadline")" || return 1
  printf '%s' "$env_summary" |
    node "$STATE_HELPER" verify-runtime-identity "$EXPECTED_OCR_VERSION" "$service" || return 1
  printf '%s' "${container_ids[0]}"
}

verify_control_executor() {
  local container_id
  if ! container_id="$(reviewed_running_container_id api-admin)"; then
    fail "Runtime-control operations require the reviewed running api-admin image and identity."
    return 1
  fi
  if [[ -z "$container_id" ]]; then
    fail "Runtime-control executor is missing."
    return 1
  fi
}

verify_certification() {
  local certification_bytes image_sha256 deadline
  certification_bytes="$(wc -c <"$CERTIFICATION_FILE")"
  if [[ ! "$certification_bytes" =~ ^[0-9]+$ || "$certification_bytes" -lt 1 || \
    "$certification_bytes" -gt 262144 ]]; then
    fail "Commercial OCR certification must be between 1 and 262144 bytes."
    return 1
  fi
  if [[ ! "$MANIFEST_IMAGE_ID" =~ ^sha256:([a-f0-9]{64})$ ]]; then
    fail "The active API manifest image ID is not a canonical SHA-256."
    return 1
  fi
  image_sha256="${BASH_REMATCH[1]}"
  [[ -z "$CERTIFICATION_VERIFICATION_FILE" ]] ||
    rm -f -- "$CERTIFICATION_VERIFICATION_FILE"
  CERTIFICATION_VERIFICATION_FILE="$(mktemp)"
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  if ! run_host_command_before_deadline "$deadline" "$DOCKER_MUTATION_MAX_TIMEOUT_SEC" \
    docker compose "${COMPOSE_FILES[@]}" exec -T api-admin \
    node "$CERTIFICATION_VERIFIER_SCRIPT" \
      --expected-source-sha "$MANIFEST_SOURCE_SHA" \
      --expected-image-sha256 "$image_sha256" \
      --expected-certification-sha256 "$CERTIFICATION_SHA256" \
      <"$CERTIFICATION_FILE" >"$CERTIFICATION_VERIFICATION_FILE"; then
    fail "Commercial OCR certification did not pass the active release verifier."
    return 1
  fi
  if ! node "$STATE_HELPER" validate-certification-verification \
    "$CERTIFICATION_VERIFICATION_FILE" "$CERTIFICATION_SHA256" >/dev/null; then
    fail "Commercial OCR certification verifier output was not the strict trusted envelope."
    return 1
  fi
  printf 'Certification validated: sha256=%s\n' "$CERTIFICATION_SHA256"
}

verify_runtime() {
  local expected_mode="$1"
  local cohort_arg=()
  local service container_id container_ids_raw image_id env_summary deadline
  local container_ids=()
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  if [[ "$expected_mode" == "canary" ]]; then
    [[ -n "$COHORT_FILE" ]] || fail "Canary runtime verification requires a normalized cohort."
    cohort_arg=("$COHORT_FILE")
  fi
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    if ! container_ids_raw="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
    )"; then
      fail "Could not inspect a production API role."
      return 1
    fi
    container_ids=()
    if [[ -n "$container_ids_raw" ]]; then
      mapfile -t container_ids <<<"$container_ids_raw"
    fi
    if [[ "${#container_ids[@]}" -ne 1 ]]; then
      fail "A production API role is missing, stopped, or unexpectedly scaled."
      return 1
    fi
    container_id="${container_ids[0]}"
    if ! image_id="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null
    )"; then
      fail "Could not inspect a production API role image."
      return 1
    fi
    if [[ "$image_id" != "$MANIFEST_IMAGE_ID" ]]; then
      fail "An API role does not run the manifest image."
      return 1
    fi
    if ! env_summary="$(container_env_summary "$container_id" "$deadline")"; then
      fail "Could not inspect an API role rollout environment."
      return 1
    fi
    if ! printf '%s' "$env_summary" |
      node "$STATE_HELPER" verify-runtime-env "$expected_mode" "$EXPECTED_OCR_VERSION" \
        "$service" "${cohort_arg[@]}"; then
      fail "An API role does not match its identity, rollout mode, cohort, or OCR version."
      return 1
    fi
  done
  if [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "$MANIFEST_IMAGE_ID" with-media || return 1
  else
    maxim_topology_require_ocr_native_sandbox_absent COMPOSE_FILES || return 1
  fi
  maxim_topology_verify_photo_native_sandbox_for_image COMPOSE_FILES "$MANIFEST_IMAGE_ID" || return 1
  verify_no_unreviewed_running_api_containers "$deadline" || return 1
}

normalize_cohort() {
  COHORT_FILE="$(mktemp)"
  node "$STATE_HELPER" normalize-chat-ids "$CHAT_IDS_FILE" >"$COHORT_FILE"
  COHORT_COUNT="$(node -e '
    const { readFileSync } = require("node:fs");
    process.stdout.write(String(JSON.parse(readFileSync(process.argv[1], "utf8")).count));
  ' "$COHORT_FILE")"
  printf 'Cohort validated: count=%s\n' "$COHORT_COUNT"
}

validate_control_options() {
  printf '%s\0%s\0' "$CONTROL_ACTOR" "$CONTROL_REASON" |
    node "$STATE_HELPER" validate-control-options "$COHORT_FILE" "$EXPECTED_REVISION" \
      "$CONTROL_TTL_SEC" >/dev/null
  if [[ ! "$CONTROL_TTL_SEC" =~ ^[0-9]+$ ]] || ((CONTROL_TTL_SEC < MIN_CONTROL_TTL_SEC)); then
    fail "Commercial OCR rollout control TTL must be at least ${MIN_CONTROL_TTL_SEC} seconds."
    return 1
  fi
}

runtime_control() {
  local service="$1"
  shift
  local deadline
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  run_host_command_before_deadline "$deadline" "$DOCKER_MUTATION_MAX_TIMEOUT_SEC" \
    docker compose "${COMPOSE_FILES[@]}" exec -T "$service" \
    node "$RUNTIME_CONTROL_SCRIPT" "$@"
}

summarize_control_output() {
  local cohort_arg=()
  [[ -z "$COHORT_FILE" ]] || cohort_arg=("$COHORT_FILE")
  node "$STATE_HELPER" summarize-control "${cohort_arg[@]}"
}

read_control_summary() {
  local control_status=0
  CONTROL_OUTPUT_FILE="$(mktemp)"
  runtime_control api-admin get --json >"$CONTROL_OUTPUT_FILE" || control_status=$?
  if [[ "$control_status" -ne 0 && "$control_status" -ne 2 ]]; then
    return "$control_status"
  fi
  CONTROL_SUMMARY="$(summarize_control_output <"$CONTROL_OUTPUT_FILE")"
  rm -f -- "$CONTROL_OUTPUT_FILE"
  CONTROL_OUTPUT_FILE=""
}

summary_field() {
  printf '%s' "$CONTROL_SUMMARY" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0).toString("utf8"));
    const field = value[process.argv[1]];
    if (field === undefined) process.exit(3);
    process.stdout.write(field === null ? "null" : String(field));
  ' "$1"
}

verify_expected_control_before_promote() {
  read_control_summary
  [[ "$(summary_field kind)" == "missing" ]] ||
    fail "Promotion requires missing runtime control."
  local actual_revision
  actual_revision="$(summary_field revision)"
  if [[ "$EXPECTED_REVISION" == "none" ]]; then
    [[ "$actual_revision" == "null" ]] || fail "Runtime-control revision fence already exists; use its exact revision."
  else
    [[ "$actual_revision" == "$EXPECTED_REVISION" ]] || fail "Runtime-control revision changed before promotion."
  fi
  printf 'Runtime control preflight: kind=missing revision=%s\n' "$actual_revision"
}

verify_expected_control_before_downgrade() {
  read_control_summary
  local control_kind
  control_kind="$(summary_field kind)"
  case "$control_kind" in
    active | expired | missing | invalid) ;;
    *) fail "Downgrade requires a revision-fenced runtime control state." ;;
  esac
  [[ "$(summary_field revision)" == "$EXPECTED_REVISION" ]] ||
    fail "Runtime-control revision changed before downgrade."
  printf 'Runtime control preflight: kind=%s revision=%s mode=%s count=%s\n' \
    "$control_kind" "$(summary_field revision)" "$(summary_field mode)" \
    "$(summary_field chatCount)"
}

queue_and_admission_drained() {
  local probe_timeout_sec="${1:-$MAX_DRAIN_PROBE_TIMEOUT_SEC}"
  local probe_timeout_ms result
  if [[ ! "$probe_timeout_sec" =~ ^[1-9][0-9]*$ ]]; then
    return 1
  fi
  if ((probe_timeout_sec > MAX_DRAIN_PROBE_TIMEOUT_SEC)); then
    probe_timeout_sec="$MAX_DRAIN_PROBE_TIMEOUT_SEC"
  fi
  probe_timeout_ms=$((probe_timeout_sec * 1000 - 500))
  if ((probe_timeout_ms < 250)); then
    probe_timeout_ms=250
  fi
  result="$(
    timeout --foreground --kill-after="${DRAIN_PROBE_KILL_GRACE_SEC}s" \
      "${probe_timeout_sec}s" \
      docker compose "${COMPOSE_FILES[@]}" exec -T \
      -e "MAXIM_COMMERCIAL_OCR_DRAIN_PROBE_TIMEOUT_MS=$probe_timeout_ms" \
      api-admin node - "${QUEUE_STATES[@]}" <"$ADMISSION_DRAIN_PROBE"
  )" || return 1
  printf '%s' "$result" | node -e '
    const { readFileSync } = require("node:fs");
    const value = JSON.parse(readFileSync(0).toString("utf8"));
    const states = process.argv.slice(1);
    const valid =
      Number.isSafeInteger(value.units) && value.units === 0 &&
      value.held === 0 && value.malformed === 0 &&
      states.every((state) => Number.isSafeInteger(value.counts?.[state]) && value.counts[state] === 0);
    process.exit(valid ? 0 : 1);
  ' "${QUEUE_STATES[@]}"
}

require_queue_and_admission_drained() {
  queue_and_admission_drained ||
    fail "Commercial OCR queue or admission reservations are not drained."
  printf '%s\n' "Queue and admission drain verified."
}

wait_for_queue_and_admission_drain() {
  local deadline remaining_sec probe_timeout_sec
  deadline=$((SECONDS + DRAIN_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    remaining_sec=$((deadline - SECONDS))
    if ((remaining_sec <= DRAIN_PROBE_KILL_GRACE_SEC)); then
      break
    fi
    probe_timeout_sec=$((remaining_sec - DRAIN_PROBE_KILL_GRACE_SEC))
    if ((probe_timeout_sec > MAX_DRAIN_PROBE_TIMEOUT_SEC)); then
      probe_timeout_sec="$MAX_DRAIN_PROBE_TIMEOUT_SEC"
    fi
    if queue_and_admission_drained "$probe_timeout_sec"; then
      printf '%s\n' "Queue and admission drain verified after producer quiescence."
      return 0
    fi
    if ((SECONDS < deadline)); then
      sleep 1
    fi
  done
  fail "Commercial OCR queue and admission reservations did not drain after producer quiescence."
}

patch_env_canary() {
  RECOVERY_ARMED=1
  node "$STATE_HELPER" patch-rollout-env .env canary "$COHORT_FILE" >/dev/null
}

patch_env_shadow() {
  node "$STATE_HELPER" patch-rollout-env .env shadow >/dev/null
}

run_host_command_before_deadline() {
  local deadline="$1" maximum_timeout_sec="$2"
  shift 2
  local remaining_sec command_timeout_sec
  remaining_sec=$((deadline - SECONDS))
  if ((remaining_sec <= READINESS_COMMAND_KILL_GRACE_SEC)); then
    return 124
  fi
  command_timeout_sec=$((remaining_sec - READINESS_COMMAND_KILL_GRACE_SEC))
  if ((command_timeout_sec > maximum_timeout_sec)); then
    command_timeout_sec="$maximum_timeout_sec"
  fi
  timeout --foreground --kill-after="${READINESS_COMMAND_KILL_GRACE_SEC}s" \
    "${command_timeout_sec}s" "$@"
}

wait_for_service_running() {
  local service="$1" deadline="${2:-$((SECONDS + API_READINESS_TIMEOUT_SEC))}" container_ids_raw
  local container_ids=()
  while ((SECONDS < deadline)); do
    container_ids_raw="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
    )" || container_ids_raw=""
    container_ids=()
    if [[ -n "$container_ids_raw" ]]; then
      mapfile -t container_ids <<<"$container_ids_raw"
    fi
    if [[ "${#container_ids[@]}" -eq 1 ]]; then
      return 0
    fi
    if ((SECONDS < deadline)); then sleep 1; fi
  done
  fail "An API role failed to become running."
}

recreate_service() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  local service="$1" deadline="${2:-$((SECONDS + API_READINESS_TIMEOUT_SEC))}"
  run_host_command_before_deadline "$deadline" "$DOCKER_MUTATION_MAX_TIMEOUT_SEC" \
    docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate "$service" \
    >/dev/null || return 1
  wait_for_service_running "$service" "$deadline"
}

recreate_all_roles() {
  local service deadline
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  for service in "${NON_MEDIA_SERVICES[@]}"; do
    recreate_service "$service" "$deadline" || return 1
  done
  if [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "$MANIFEST_IMAGE_ID" sandbox-only || return 1
  fi
  recreate_service "$MEDIA_SERVICE" "$deadline" || return 1
  if [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "$MANIFEST_IMAGE_ID" with-media
  fi
}

stop_ocr_producers() {
  local deadline
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  run_host_command_before_deadline "$deadline" "$DOCKER_MUTATION_MAX_TIMEOUT_SEC" \
    docker compose "${COMPOSE_FILES[@]}" stop "${OCR_PRODUCER_SERVICES[@]}" \
    >/dev/null || return 1
  verify_ocr_producers_stopped "$deadline"
}

verify_ocr_producers_stopped() {
  local deadline="${1:-$((SECONDS + API_READINESS_TIMEOUT_SEC))}" service running_ids
  for service in "${OCR_PRODUCER_SERVICES[@]}"; do
    running_ids="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
    )" || return 1
    [[ -z "$running_ids" ]] || fail "A commercial OCR producer role did not stop."
  done
  verify_no_unreviewed_running_api_containers "$deadline"
}

start_ocr_producers() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  local service deadline
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  run_host_command_before_deadline "$deadline" "$DOCKER_MUTATION_MAX_TIMEOUT_SEC" \
    docker compose "${COMPOSE_FILES[@]}" start "${OCR_PRODUCER_SERVICES[@]}" \
    >/dev/null || return 1
  for service in "${OCR_PRODUCER_SERVICES[@]}"; do
    wait_for_service_running "$service" "$deadline" || return 1
  done
}

force_stop_container() {
  local container_id="$1" deadline="${2:-$((SECONDS + API_READINESS_TIMEOUT_SEC))}" running
  run_host_command_before_deadline "$deadline" "$DOCKER_MUTATION_MAX_TIMEOUT_SEC" \
    docker stop --time 10 "$container_id" >/dev/null 2>&1 || true
  if ! running="$(
    run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
      docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null
  )"; then
    return 1
  fi
  if [[ "$running" == "true" ]]; then
    run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
      docker kill "$container_id" >/dev/null 2>&1 || true
    if ! running="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null
    )"; then
      return 1
    fi
  fi
  [[ "$running" == "false" ]]
}

verify_recovery_services_stopped() {
  local deadline="${1:-$((SECONDS + API_READINESS_TIMEOUT_SEC))}" service running_ids
  for service in "${RECOVERY_QUIESCE_SERVICES[@]}"; do
    if ! running_ids="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
    )"; then
      fail "Could not inspect an enforcement-capable API role after quiescence."
      return 1
    fi
    if [[ -n "$running_ids" ]]; then
      fail "An enforcement-capable API role is still running after quiescence."
      return 1
    fi
  done
  verify_no_unreviewed_running_api_containers "$deadline"
}

quiesce_recovery_services() {
  local service running_ids_raw container_id deadline
  local running_ids=()
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  RECOVERY_QUIESCENCE_PROVEN=0
  for service in "${RECOVERY_QUIESCE_SERVICES[@]}"; do
    run_host_command_before_deadline "$deadline" "$DOCKER_MUTATION_MAX_TIMEOUT_SEC" \
      docker compose "${COMPOSE_FILES[@]}" stop "$service" >/dev/null 2>&1 || true
    if ! running_ids_raw="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
    )"; then
      continue
    fi
    running_ids=()
    if [[ -n "$running_ids_raw" ]]; then
      mapfile -t running_ids <<<"$running_ids_raw"
    fi
    for container_id in "${running_ids[@]}"; do
      force_stop_container "$container_id" "$deadline" || true
    done
  done

  # Foreign or ambiguous containers are blockers, never mutation targets on the shared VPS.
  if read_running_api_inventory "$deadline"; then
    for container_id in "${RUNTIME_INVENTORY_OWNED_UNREVIEWED_IDS[@]}"; do
      force_stop_container "$container_id" "$deadline" || true
    done
  fi

  # Individual stop/inspect attempts are best effort; this final inventory is the proof boundary.
  if verify_recovery_services_stopped "$deadline"; then
    RECOVERY_QUIESCENCE_PROVEN=1
    return 0
  fi
  return 1
}

recreate_recovery_service() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  local service="$1" deadline="$2"
  if run_host_command_before_deadline "$deadline" "$DOCKER_MUTATION_MAX_TIMEOUT_SEC" \
    docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate \
    "$service" >/dev/null; then
    return 0
  fi
  if maxim_topology_contains "$service" "${RECOVERY_QUIESCE_SERVICES[@]}"; then
    local running_ids_raw container_id
    local running_ids=()
    running_ids_raw="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
    )" || running_ids_raw=""
    if [[ -n "$running_ids_raw" ]]; then
      mapfile -t running_ids <<<"$running_ids_raw"
    fi
    for container_id in "${running_ids[@]}"; do
      force_stop_container "$container_id" "$deadline" || true
    done
  fi
  return 1
}

recreate_all_roles_best_effort() {
  local service failed=0 deadline
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  for service in "${RECOVERY_QUIESCE_SERVICES[@]}"; do
    recreate_recovery_service "$service" "$deadline" || failed=1
  done
  for service in "${NON_MEDIA_SERVICES[@]}"; do
    if maxim_topology_contains "$service" "${RECOVERY_QUIESCE_SERVICES[@]}"; then
      continue
    fi
    recreate_recovery_service "$service" "$deadline" || failed=1
  done
  if [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "$MANIFEST_IMAGE_ID" sandbox-only || failed=1
  fi
  recreate_recovery_service "$MEDIA_SERVICE" "$deadline" || failed=1
  if [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "$MANIFEST_IMAGE_ID" with-media || failed=1
  fi
  return "$failed"
}

recover_shadow() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  RECOVERY_QUIESCENCE_PROVEN=0
  if ! quiesce_recovery_services; then
    return 1
  fi
  if ! patch_env_shadow; then
    quiesce_recovery_services || true
    return 1
  fi
  RECOVERY_QUIESCENCE_PROVEN=0
  recreate_all_roles_best_effort || true
  local readiness_ok=0 runtime_ok=0
  if wait_for_api_readiness; then readiness_ok=1; fi
  if verify_runtime shadow; then runtime_ok=1; fi
  if [[ "$readiness_ok" -eq 1 && "$runtime_ok" -eq 1 ]]; then
    return 0
  fi
  quiesce_recovery_services || true
  return 1
}

api_role_ready() {
  local service="$1" deadline="$2" container_ids_raw
  local container_ids=()
  container_ids_raw="$(
    run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
      docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
  )" || return 1
  if [[ -n "$container_ids_raw" ]]; then
    mapfile -t container_ids <<<"$container_ids_raw"
  fi
  [[ "${#container_ids[@]}" -eq 1 ]] || return 1
  maxim_topology_contains "$service" "${HTTP_READY_SERVICES[@]}" || return 0
  run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
    docker exec "${container_ids[0]}" node -e \
    'fetch("http://127.0.0.1:3001/api/health/ready", { signal: AbortSignal.timeout(3000) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));' \
    >/dev/null 2>&1
}

all_api_roles_ready() {
  local deadline="$1" service pid failed=0
  local readiness_pids=()
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    api_role_ready "$service" "$deadline" &
    readiness_pids+=("$!")
  done
  for pid in "${readiness_pids[@]}"; do
    if ! wait "$pid"; then failed=1; fi
  done
  if [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]] &&
    ! maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "$MANIFEST_IMAGE_ID" with-media; then
    failed=1
  fi
  return "$failed"
}

api_runtime_signature() {
  local deadline="$1" service container_ids_raw restart_count
  local container_ids=()
  for service in "${MAXIM_PRODUCTION_API_SERVICES[@]}"; do
    container_ids_raw="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker compose "${COMPOSE_FILES[@]}" ps --status running -q "$service" 2>/dev/null
    )" || return 1
    container_ids=()
    if [[ -n "$container_ids_raw" ]]; then
      mapfile -t container_ids <<<"$container_ids_raw"
    fi
    [[ "${#container_ids[@]}" -eq 1 ]] || return 1
    restart_count="$(
      run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
        docker inspect --format '{{.RestartCount}}' "${container_ids[0]}" 2>/dev/null
    )" ||
      return 1
    [[ "$restart_count" =~ ^[0-9]+$ ]] || return 1
    printf '%s|%s|%s\n' "$service" "${container_ids[0]}" "$restart_count"
  done
  if [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    local ocr_members
    ocr_members="$(maxim_topology_ocr_services_for_compose COMPOSE_FILES)" || return 1
    [[ -n "$ocr_members" ]] || return 1
    while IFS= read -r service; do
      container_ids_raw="$(
        run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
          docker compose "${COMPOSE_FILES[@]}" ps --status running -q \
            "$service" 2>/dev/null
      )" || return 1
      container_ids=()
      [[ -z "$container_ids_raw" ]] || mapfile -t container_ids <<<"$container_ids_raw"
      [[ "${#container_ids[@]}" -eq 1 ]] || return 1
      restart_count="$(
        run_host_command_before_deadline "$deadline" "$READINESS_COMMAND_MAX_TIMEOUT_SEC" \
          docker inspect --format '{{.RestartCount}}' "${container_ids[0]}" 2>/dev/null
      )" || return 1
      [[ "$restart_count" =~ ^[0-9]+$ ]] || return 1
      printf '%s|%s|%s\n' "$service" \
        "${container_ids[0]}" "$restart_count"
    done <<<"$ocr_members"
  fi
}

wait_for_api_readiness() {
  local deadline before_signature after_signature
  deadline=$((SECONDS + API_READINESS_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    if all_api_roles_ready "$deadline"; then
      before_signature="$(api_runtime_signature "$deadline")" || before_signature=""
      if [[ -n "$before_signature" && $((SECONDS + API_STABILITY_WINDOW_SEC)) -lt deadline ]]; then
        sleep "$API_STABILITY_WINDOW_SEC"
        if all_api_roles_ready "$deadline"; then
          after_signature="$(api_runtime_signature "$deadline")" || after_signature=""
          if [[ -n "$after_signature" && "$after_signature" == "$before_signature" ]]; then
            return 0
          fi
        fi
      fi
    fi
    if ((SECONDS < deadline)); then sleep 1; fi
  done
  fail "API readiness did not recover after rollout recreation."
}

build_control() {
  [[ -n "$CERTIFICATION_VERIFICATION_FILE" ]] ||
    fail "Runtime control requires the private certification verification result."
  CONTROL_FILE="$(mktemp)"
  printf '%s\0%s\0' "$CONTROL_ACTOR" "$CONTROL_REASON" |
    node "$STATE_HELPER" build-control "$COHORT_FILE" "$EXPECTED_REVISION" \
      "$CONTROL_TTL_SEC" "$CERTIFICATION_VERIFICATION_FILE" \
      "$CERTIFICATION_SHA256" >"$CONTROL_FILE"
}

apply_control() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  RECOVERY_ARMED=1
  CONTROL_OUTPUT_FILE="$(mktemp)"
  runtime_control api-admin set --expected-revision "$EXPECTED_REVISION" \
    --control-stdin --apply --json <"$CONTROL_FILE" >"$CONTROL_OUTPUT_FILE"
  CONTROL_SUMMARY="$(summarize_control_output <"$CONTROL_OUTPUT_FILE")"
  rm -f -- "$CONTROL_OUTPUT_FILE"
  CONTROL_OUTPUT_FILE=""
  [[ "$(summary_field complete)" == "true" && "$(summary_field resultKind)" == "applied" ]] ||
    fail "Runtime control set was not proven complete."
  [[ "$(summary_field kind)" == "active" && "$(summary_field mode)" == "canary" ]] ||
    fail "Runtime control did not become an active canary."
  [[ "$(summary_field matchesCohort)" == "true" ]] ||
    fail "Runtime control cohort does not match both environment allowlists."
  APPLIED_CONTROL_EXPIRES_AT="$(summary_field expiresAt)"
  [[ "$APPLIED_CONTROL_EXPIRES_AT" != "null" ]] ||
    fail "Runtime control did not expose a valid logical expiry."
}

verify_applied_control_still_active() {
  local expected_applied_revision
  expected_applied_revision=1
  if [[ "$EXPECTED_REVISION" != "none" ]]; then
    expected_applied_revision="$((EXPECTED_REVISION + 1))"
  fi
  read_control_summary
  [[ "$(summary_field kind)" == "active" && "$(summary_field mode)" == "canary" ]] ||
    fail "Runtime control was not active after producer restart."
  [[ "$(summary_field revision)" == "$expected_applied_revision" ]] ||
    fail "Runtime-control revision changed after producer restart."
  [[ "$(summary_field matchesCohort)" == "true" ]] ||
    fail "Runtime control cohort changed after producer restart."
  [[ "$(summary_field expiresAt)" == "$APPLIED_CONTROL_EXPIRES_AT" ]] ||
    fail "Runtime-control logical expiry changed after producer restart."
  local remaining_ttl_sec
  remaining_ttl_sec="$(summary_field remainingTtlSec)"
  if [[ ! "$remaining_ttl_sec" =~ ^[0-9]+$ ]] ||
    ((remaining_ttl_sec < MIN_FINAL_CONTROL_TTL_SEC)); then
    fail "Runtime control does not retain the required post-rollout lifetime."
  fi
}

clear_control() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  RECOVERY_ARMED=1
  CONTROL_OUTPUT_FILE="$(mktemp)"
  runtime_control api-admin clear --expected-revision "$EXPECTED_REVISION" --apply --json \
    >"$CONTROL_OUTPUT_FILE"
  CONTROL_SUMMARY="$(summarize_control_output <"$CONTROL_OUTPUT_FILE")"
  rm -f -- "$CONTROL_OUTPUT_FILE"
  CONTROL_OUTPUT_FILE=""
  [[ "$(summary_field complete)" == "true" && "$(summary_field resultKind)" == "cleared" ]] ||
    fail "Runtime control clear was not proven complete."
  [[ "$(summary_field kind)" == "missing" ]] || fail "Runtime control was not cleared."
  [[ "$(summary_field revision)" == "$((EXPECTED_REVISION + 1))" ]] ||
    fail "Runtime-control revision fence was not incremented exactly once."
}

promote() {
  normalize_cohort
  validate_control_options
  resolve_release_fence
  [[ "$EXPECTED_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]] ||
    fail "Commercial OCR promotion requires the reviewed no-network native sandbox."
  verify_runtime shadow
  wait_for_api_readiness
  verify_runtime shadow
  verify_certification
  verify_expected_control_before_promote
  require_queue_and_admission_drained
  if [[ "$APPLY" -ne 1 ]]; then
    printf '%s\n' "Promotion preflight passed; no state changed."
    return
  fi
  patch_env_canary
  recreate_all_roles
  wait_for_api_readiness
  verify_runtime canary
  # Reverify inside the recreated image so a pending trust-anchor rotation cannot
  # authorize a certificate accepted only by the pre-recreation container.
  verify_certification
  stop_ocr_producers
  wait_for_queue_and_admission_drain
  verify_ocr_producers_stopped
  verify_no_unreviewed_running_api_containers
  build_control
  verify_ocr_producers_stopped
  verify_no_unreviewed_running_api_containers
  apply_control
  start_ocr_producers
  wait_for_api_readiness
  verify_runtime canary
  verify_applied_control_still_active
  ROLLOUT_COMPLETE=1
  printf 'Commercial OCR canary promoted: revision=%s count=%s\n' \
    "$(summary_field revision)" "$(summary_field chatCount)"
}

downgrade() {
  resolve_release_fence
  verify_no_unreviewed_running_api_containers
  verify_control_executor
  verify_expected_control_before_downgrade
  if [[ "$APPLY" -ne 1 ]]; then
    printf '%s\n' "Downgrade preflight passed; no state changed."
    return
  fi
  clear_control
  patch_env_shadow
  recreate_all_roles
  wait_for_api_readiness
  verify_runtime shadow
  ROLLOUT_COMPLETE=1
  printf 'Commercial OCR downgraded to shadow: revision=%s\n' "$(summary_field revision)"
}

status() {
  resolve_release_fence
  verify_control_executor
  read_control_summary
  printf 'Commercial OCR runtime control: kind=%s revision=%s mode=%s count=%s expires_at=%s remaining_ttl_sec=%s\n' \
    "$(summary_field kind)" "$(summary_field revision)" "$(summary_field mode)" \
    "$(summary_field chatCount)" "$(summary_field expiresAt)" \
    "$(summary_field remainingTtlSec)"
}

recover_shadow_command() {
  if [[ "$APPLY" -ne 1 ]]; then
    resolve_release_fence
    printf '%s\n' "Shadow recovery preflight passed; no state changed."
    return
  fi
  # Recovery quiesces producers before trusting the release manifest. The sandbox is not an
  # enforcement-capable role, so classify only an exactly isolated current-Compose auxiliary.
  EXPECTED_HAS_OCR_NATIVE_SANDBOX=1
  quiesce_recovery_services || true
  if ! resolve_release_fence; then
    if [[ "$RECOVERY_QUIESCENCE_PROVEN" -eq 1 ]]; then
      fail "Release fencing failed; enforcement-capable roles remain quiesced and no role was recreated."
    else
      fail "Release fencing failed; enforcement-role quiescence was not proven and no role was recreated."
    fi
    return 1
  fi
  if ! recover_shadow; then
    if [[ "$RECOVERY_QUIESCENCE_PROVEN" -eq 1 ]]; then
      fail "Shadow recovery was not proven across all API roles; enforcement-capable roles are quiesced."
    else
      fail "Shadow recovery and enforcement-role quiescence were not proven."
    fi
    return 1
  fi
  ROLLOUT_COMPLETE=1
  printf '%s\n' "Commercial OCR environment ceilings recovered to shadow across all API roles."
}

parse_args "$@"
require_command node
require_command git
require_command docker
require_command timeout
require_node_24
require_operational_limits
require_topology
[[ -s .env ]] || fail "Missing production .env."
acquire_deploy_lock
trap cleanup EXIT
if [[ "$APPLY" -eq 1 ]]; then
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || exit $?
fi

case "$COMMAND" in
  promote) promote ;;
  downgrade) downgrade ;;
  status) status ;;
  recover-shadow) recover_shadow_command ;;
esac
