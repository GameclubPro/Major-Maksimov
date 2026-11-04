#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(readlink -e -- "${BASH_SOURCE[0]}")" || exit 2
ROOT_DIR="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd -P)"
cd "$ROOT_DIR"
SCRIPT_REL_PATH="${SCRIPT_PATH#"$ROOT_DIR"/}"
ORIGINAL_ARGS=("$@")
SCALE_CONTINUATION_TARGET="${MAXIM_SCALE_REEXEC_TARGET_SHA:-}"
unset MAXIM_SCALE_REEXEC_TARGET_SHA
SCALE_EXPECTED_SYNC_SHA=""

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/deploy-lock.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
# shellcheck source=infra/scripts/lib/legacy-cold-maintenance.sh
source "$ROOT_DIR/infra/scripts/lib/legacy-cold-maintenance.sh" || exit $?
# shellcheck source=infra/scripts/lib/deploy-disk-capacity.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-disk-capacity.sh"
# shellcheck source=infra/scripts/lib/scale-deploy-profile.sh
source "$ROOT_DIR/infra/scripts/lib/scale-deploy-profile.sh" || exit $?
MAXIM_SCALE_TRUSTED_CONTROLLER_SOURCE="$(maxim_scale_source_bytes "$SCRIPT_PATH")" || exit 2
readonly MAXIM_SCALE_TRUSTED_CONTROLLER_SOURCE

SCALE_PROJECT_NAME="infra-scale"
MAIN_PROJECT_NAME="infra"
COMPOSE_FILES=(-p "$SCALE_PROJECT_NAME" -f "infra/docker-compose.scale.yml")
MIGRATION_COMPOSE_FILES=("${COMPOSE_FILES[@]}" -f "infra/docker-compose.runtime-no-build.yml")
LEGACY_COMPOSE_FILES=(--env-file ".env" -p "$MAIN_PROJECT_NAME" -f "infra/docker-compose.yml")
SCALE_REDIS_VOLUME="${SCALE_PROJECT_NAME}_redis_data"
REDIS_DATA_COPY_IMAGE="${MAXIM_REDIS_VOLUME_COPY_IMAGE:-redis:7-alpine}"
BRANCH="${1:-main}"
PRE_PULL_HEAD=""
PUBLIC_HEALTH_URL="${MAXIM_VPS_PUBLIC_URL:-}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL%/}"

if [[ $# -ge 2 ]]; then
  SERVICES=("${@:2}")
else
  SERVICES=(
    "api-ingress"
    "api-admin"
    "api-enqueue"
    "api-moderation"
    "api-moderation-critical"
    "api-moderation-join"
    "api-moderation-realtime-b"
    "api-moderation-realtime-c"
    "api-moderation-realtime-d"
    "api-moderation-background"
    "api-media-analysis"
    "api-action"
    "api-publisher"
    "miniapp-major-static"
  )
fi

API_SERVICES=("${MAXIM_PRODUCTION_API_SERVICES[@]}")

contains_service() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

has_requested_api_service() {
  local service
  for service in "${API_SERVICES[@]}"; do
    if contains_service "$service" "${SERVICES[@]}"; then
      return 0
    fi
  done
  return 1
}

ensure_service_requested_if_down() {
  local service="$1"

  if contains_service "$service" "${SERVICES[@]}"; then
    return 0
  fi

  if docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx "$service"; then
    return 0
  fi

  echo "$service is not running. Including it in this deploy to restore availability."
  SERVICES+=("$service")
}

warn_legacy_miniapp_static_target() {
  if ! contains_service "miniapp-static" "${SERVICES[@]}"; then
    return 0
  fi

  cat >&2 <<'EOF'
WARNING: miniapp-static serves legacy https://maxim.play-team.ru/app/.
Routine production mini app deploys should target miniapp-major-static for https://major-maksimov.ru/app/.
Continue only if you intentionally need the legacy support static container.
EOF
}

require_scale_deploy_confirmation() {
  case "${MAXIM_ALLOW_SCALE_DEPLOY:-0}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
  esac

  cat >&2 <<'EOF'
Refusing to run infra-scale deploy without explicit confirmation.
This script is loadtest-only, uses the infra-scale compose project, and can stop the main infra stack to free ports.
Set MAXIM_ALLOW_SCALE_DEPLOY=1 only when you intentionally want the split/load-testing stack.
EOF
  exit 2
}

has_pulled_changes() {
  [[ -n "$PRE_PULL_HEAD" ]] && [[ "$PRE_PULL_HEAD" != "$(git rev-parse HEAD)" ]]
}

diff_in_paths() {
  local status=0

  if ! has_pulled_changes; then
    return 1
  fi

  git diff --quiet "$PRE_PULL_HEAD" HEAD -- "$@" >/dev/null 2>&1 || status=$?
  case "$status" in
    0) return 1 ;;
    1) return 0 ;;
    *) return 1 ;;
  esac
}

reexec_if_current_script_changed() {
  if [[ "$(maxim_scale_source_bytes "$SCRIPT_PATH")" == "$MAXIM_SCALE_TRUSTED_CONTROLLER_SOURCE" ]] && ! diff_in_paths \
    "$SCRIPT_REL_PATH" \
    "infra/scripts/lib/deploy-disk-capacity.sh" \
    "infra/scripts/lib/deploy-lock.sh" \
    "infra/scripts/lib/legacy-cold-maintenance.sh" \
    "infra/scripts/lib/scale-deploy-profile.sh" \
    "infra/scripts/lib/deploy-topology.sh"; then
    return 0
  fi

  echo "Deploy script or dependencies changed. Re-executing updated $SCRIPT_REL_PATH..."
  maxim_scale_require_synchronized_source "$ROOT_DIR" "$SCALE_EXPECTED_SYNC_SHA" || exit $?
  export MAXIM_DEPLOY_SCRIPT_REEXECED=1
  export MAXIM_SCALE_REEXEC_TARGET_SHA="$SCALE_EXPECTED_SYNC_SHA"
  exec "$SCRIPT_PATH" "${ORIGINAL_ARGS[@]}"
}

ensure_compose_env() {
  local tmp_env
  local container_name
  local restore_candidates=(
    "infra-scale-api-ingress-1"
    "infra-scale-api-admin-1"
    "infra-scale-api-enqueue-1"
    "infra-scale-api-moderation-1"
    "infra-scale-api-moderation-critical-1"
    "infra-scale-api-moderation-join-1"
    "infra-scale-api-moderation-realtime-b-1"
    "infra-scale-api-moderation-realtime-c-1"
    "infra-scale-api-moderation-realtime-d-1"
    "infra-scale-api-moderation-background-1"
    "infra-scale-api-media-analysis-1"
    "infra-scale-api-action-1"
    "infra-scale-api-1"
    "infra-api-1"
    "infra-api-ingress-1"
    "infra-api-admin-1"
    "infra-api-enqueue-1"
    "infra-api-moderation-1"
    "infra-api-moderation-critical-1"
    "infra-api-moderation-join-1"
    "infra-api-moderation-realtime-b-1"
    "infra-api-moderation-realtime-c-1"
    "infra-api-moderation-realtime-d-1"
    "infra-api-moderation-background-1"
    "infra-api-media-analysis-1"
    "infra-api-action-1"
  )

  if [[ -s .env ]]; then
    return 0
  fi

  for container_name in "${restore_candidates[@]}"; do
    if docker ps --format '{{.Names}}' | grep -qx "$container_name"; then
      echo "Missing .env. Restoring it from $container_name container env..."
      tmp_env="$(mktemp .env.restore.XXXXXX)"
      if docker inspect "$container_name" --format '{{range .Config.Env}}{{println .}}{{end}}' \
        | awk '!/^(PATH|NODE_VERSION|YARN_VERSION)=/' >"$tmp_env" && [[ -s "$tmp_env" ]]; then
        mv "$tmp_env" .env
        return 0
      fi

      rm -f "$tmp_env"
      echo "Failed to restore /var/www/Chat_bot/.env from $container_name container env."
      return 1
    fi
  done

  echo "Missing /var/www/Chat_bot/.env and no running API container is available for restore."
  echo "Create .env manually, then rerun the deploy."
  return 1
}

warn_postgres_password_fallback() {
  if [[ -f .env ]] && grep -Eq '^[[:space:]]*POSTGRES_PASSWORD=.+$' .env; then
    return 0
  fi

  cat >&2 <<'EOF'
WARNING: POSTGRES_PASSWORD is not set in .env; docker compose will use the legacy compatibility fallback.
Set POSTGRES_PASSWORD to the current database password before intentionally recreating postgres.
EOF
}

sync_branch() {
  local stash_name
  local tracked_status
  local target_sha local_sha

  if [[ -n "$SCALE_CONTINUATION_TARGET" ]]; then
    [[ "$SCALE_CONTINUATION_TARGET" =~ ^[0-9a-f]{40}$ ]] || return 2
    target_sha="$(git rev-parse --verify --end-of-options 'HEAD^{commit}')" || return 2
    [[ "$target_sha" == "$SCALE_CONTINUATION_TARGET" ]] || return 2
    maxim_scale_require_candidate_source "$target_sha" || return
    SCALE_EXPECTED_SYNC_SHA="$target_sha"
    PRE_PULL_HEAD="$target_sha"
    return 0
  fi

  git fetch origin "$BRANCH"
  target_sha="$(git rev-parse --verify --end-of-options "origin/${BRANCH}^{commit}")" || return 2
  maxim_scale_require_candidate_source "$target_sha" || return
  SCALE_EXPECTED_SYNC_SHA="$target_sha"
  PRE_PULL_HEAD="$(git rev-parse HEAD)"

  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    local_sha="$(git rev-parse --verify --end-of-options "refs/heads/${BRANCH}^{commit}")" || return 2
    maxim_scale_require_candidate_source "$local_sha" || return
    git checkout "$BRANCH"
  else
    git checkout -b "$BRANCH" "$target_sha"
  fi

  tracked_status="$(git status --porcelain --untracked-files=no)"

  if [[ -n "$tracked_status" ]]; then
    if git diff --quiet "$target_sha" -- && git diff --cached --quiet "$target_sha" --; then
      stash_name="codex-sync-${BRANCH}-$(date +%Y%m%d-%H%M%S)"
      echo "Worktree matches origin/$BRANCH but blocks ff-only pull. Stashing snapshot: $stash_name"
      git stash push -m "$stash_name" >/dev/null
      git merge --ff-only "$target_sha"
      git stash drop "stash@{0}" >/dev/null || true
      return 0
    fi

    echo "VPS worktree has local changes that do not match origin/$BRANCH."
    git status --short
    git diff --stat -- . ':(exclude).env' || true
    return 1
  fi

  git merge --ff-only "$target_sha"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "Health check timeout: $url"
  return 1
}

wait_for_postgres() {
  local attempts="${1:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if docker compose "${COMPOSE_FILES[@]}" exec -T postgres pg_isready -U maxim -d maxim >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Postgres readiness timeout."
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 postgres || true
  return 1
}

wait_for_service_running() {
  local service="$1"
  local attempts="${2:-120}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx "$service"; then
      return 0
    fi
    sleep 1
  done

  echo "Service failed to reach running state: $service"
  docker compose "${COMPOSE_FILES[@]}" ps "$service" || true
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 "$service" || true
  return 1
}

recreate_service_wave() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  local label="$1"
  shift
  local requested_services=()
  local service

  for service in "$@"; do
    if contains_service "$service" "${SERVICES[@]}"; then
      requested_services+=("$service")
    fi
  done

  if [[ "${#requested_services[@]}" -eq 0 ]]; then
    return 0
  fi

  echo "Recreating $label services: ${requested_services[*]}"
  docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate "${requested_services[@]}"

  for service in "${requested_services[@]}"; do
    wait_for_service_running "$service" 180
  done
}

ensure_requested_services_running() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  local excluded_service="${1:-}"
  local service

  for service in "${SERVICES[@]}"; do
    if [[ -n "$excluded_service" && "$service" == "$excluded_service" ]]; then
      continue
    fi
    if docker compose "${COMPOSE_FILES[@]}" ps --status running --services | grep -qx "$service"; then
      continue
    fi

    echo "Requested service $service is not running after deploy waves. Recreating it explicitly..."
    docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --no-build --force-recreate "$service"
    wait_for_service_running "$service" 180
  done
}

find_redis_container_for_project() {
  local project="$1"

  docker ps -a \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=redis" \
    --format '{{.Names}}' \
    | sed -n '1p'
}

read_redis_data_mount_line() {
  local container_name="$1"

  docker inspect "$container_name" \
    --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{printf "%s\t%s\t%s\n" .Type .Name .Source}}{{end}}{{end}}' \
    | sed -n '1p'
}

save_redis_snapshot_if_running() {
  local container_name="$1"
  local running

  running="$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)"
  if [[ "$running" != "true" ]]; then
    return 0
  fi

  echo "Saving Redis snapshot in $container_name before named-volume prep..."
  docker exec "$container_name" redis-cli SAVE >/dev/null
}

copy_redis_data_to_named_volume() {
  local source_container="$1"
  local target_volume="$2"
  local mount_line
  local mount_type
  local mount_name
  local mount_source
  local source_mount=()

  mount_line="$(read_redis_data_mount_line "$source_container")"
  if [[ -z "$mount_line" ]]; then
    echo "Redis container $source_container has no /data mount to copy." >&2
    return 1
  fi

  IFS=$'\t' read -r mount_type mount_name mount_source <<<"$mount_line"
  case "$mount_type" in
    volume)
      if [[ -z "$mount_name" ]]; then
        echo "Redis /data volume mount on $source_container has no volume name." >&2
        return 1
      fi
      source_mount=(--mount "type=volume,src=$mount_name,dst=/from,readonly")
      ;;
    bind)
      if [[ -z "$mount_source" ]]; then
        echo "Redis /data bind mount on $source_container has no source path." >&2
        return 1
      fi
      source_mount=(--mount "type=bind,src=$mount_source,dst=/from,readonly")
      ;;
    *)
      echo "Unsupported Redis /data mount type on $source_container: ${mount_type:-unknown}" >&2
      return 1
      ;;
  esac

  docker volume create "$target_volume" >/dev/null
  if docker run --rm \
    "${source_mount[@]}" \
    --mount "type=volume,src=$target_volume,dst=/to" \
    "$REDIS_DATA_COPY_IMAGE" \
    sh -lc 'set -eu; cd /from; tar cf - . | tar xf - -C /to'; then
    echo "Prepared Redis named volume $target_volume from $source_container /data."
    return 0
  fi

  docker volume rm "$target_volume" >/dev/null 2>&1 || true
  echo "Failed to prepare Redis named volume $target_volume from $source_container /data." >&2
  return 1
}

prepare_scale_redis_named_volume() {
  local target_volume="$SCALE_REDIS_VOLUME"
  local source_container

  if docker volume inspect "$target_volume" >/dev/null 2>&1; then
    echo "Redis named volume already exists: $target_volume"
    return 0
  fi

  source_container="$(find_redis_container_for_project "$SCALE_PROJECT_NAME")"
  if [[ -z "$source_container" ]]; then
    source_container="$(find_redis_container_for_project "$MAIN_PROJECT_NAME")"
  fi

  if [[ -z "$source_container" ]]; then
    case "${MAXIM_ALLOW_EMPTY_SCALE_REDIS_DATA:-0}" in
      1|true|TRUE|yes|YES)
        echo "No Redis container found. Creating empty Redis named volume $target_volume by explicit request."
        docker volume create "$target_volume" >/dev/null
        return 0
        ;;
    esac

    cat >&2 <<EOF
Refusing to stop conflicting stacks before preparing $target_volume.
No existing scale or main Redis container was found as a /data source.
Set MAXIM_ALLOW_EMPTY_SCALE_REDIS_DATA=1 only when an empty scale Redis volume is intentional.
EOF
    return 1
  fi

  save_redis_snapshot_if_running "$source_container"
  copy_redis_data_to_named_volume "$source_container" "$target_volume"
}

stop_conflicting_stacks() {
  docker compose "${LEGACY_COMPOSE_FILES[@]}" down --remove-orphans >/dev/null 2>&1 || true
}

remove_stale_service_containers() {
  local service
  local container_id
  local state
  local container_ids=()

  for service in "$@"; do
    mapfile -t container_ids < <(docker compose "${COMPOSE_FILES[@]}" ps -a -q "$service" 2>/dev/null || true)
    for container_id in "${container_ids[@]}"; do
      [[ -n "$container_id" ]] || continue
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      case "$state" in
        running|restarting|paused)
          continue
          ;;
      esac

      echo "Removing stale $service container: $container_id (state=${state:-unknown})"
      docker rm -f "$container_id" >/dev/null 2>&1 || true
    done
  done
}

run_migrations() {
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || return
  ensure_compose_env
  MAXIM_MIGRATION_API_IMAGE="${SCALE_PROJECT_NAME}-api-ingress:latest" \
    docker compose "${MIGRATION_COMPOSE_FILES[@]}" run --rm --no-deps --pull never api-ingress \
    ./node_modules/.bin/prisma migrate deploy --config apps/api/prisma.config.ts
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found"
  exit 1
fi

# FLAG: Parse the entire admission continuation before sync can replace this file.
{
  require_scale_deploy_confirmation
  maxim_scale_require_server_profile "$ROOT_DIR" || exit $?
  # FLAG: Only a validated inherited protected lock admits an internal re-exec pin.
  if [[ -n "$SCALE_CONTINUATION_TARGET" ]]; then
    require_deploy_lock || exit 2
  fi
  acquire_deploy_lock
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || exit $?
  sync_branch
  maxim_scale_require_server_profile "$ROOT_DIR" || exit $?
  maxim_scale_require_synchronized_source "$ROOT_DIR" "$SCALE_EXPECTED_SYNC_SHA" || exit $?
  reexec_if_current_script_changed
  maxim_scale_require_server_profile "$ROOT_DIR" || exit $?
  maxim_require_ordinary_effect_authority "$ROOT_DIR" || exit $?
}
ensure_compose_env
warn_postgres_password_fallback
warn_legacy_miniapp_static_target
ensure_service_requested_if_down "miniapp-major-static"
if has_requested_api_service; then
  ensure_service_requested_if_down "api-enqueue"
  ensure_service_requested_if_down "api-ingress"
fi

BUILD_API_IMAGE=0
for service in "${API_SERVICES[@]}"; do
  if contains_service "$service" "${SERVICES[@]}"; then
    BUILD_API_IMAGE=1
    break
  fi
done

if [[ "$BUILD_API_IMAGE" -eq 0 ]] && diff_in_paths apps/api packages/contracts package.json package-lock.json tsconfig.base.json; then
  BUILD_API_IMAGE=1
  echo "API-related changes detected."
fi

if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  maxim_topology_expand_api_services SERVICES \
    "Shared API image build or API-related diff detected."
  maxim_topology_refuse_dirty_api_build_inputs
fi
TARGET_SHA="$(git rev-parse HEAD)"
TARGET_HAS_MEDIA_ANALYSIS=0
TARGET_HAS_OCR_NATIVE_SANDBOX=0
TARGET_COMMERCIAL_OCR_VERSION=""
if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  maxim_topology_require_publisher_secret_files
  maxim_topology_prepare_commercial_ocr_target \
    "$TARGET_SHA" \
    COMPOSE_FILES \
    TARGET_HAS_MEDIA_ANALYSIS \
    TARGET_COMMERCIAL_OCR_VERSION \
    TARGET_HAS_OCR_NATIVE_SANDBOX
  maxim_topology_prepare_photo_native_target "${TARGET_SHA}" COMPOSE_FILES
fi

BUILD_STATIC_IMAGE=0
for service in "${SERVICES[@]}"; do
  case "$service" in
    miniapp-static|miniapp-major-static)
      BUILD_STATIC_IMAGE=1
      ;;
  esac
done

if [[ "$BUILD_API_IMAGE" -eq 1 || "$BUILD_STATIC_IMAGE" -eq 1 ]]; then
  maxim_check_deploy_disk_capacity "$BUILD_API_IMAGE" "$BUILD_STATIC_IMAGE"
fi

prepare_scale_redis_named_volume
stop_conflicting_stacks

docker compose "${COMPOSE_FILES[@]}" up -d --no-build postgres redis
wait_for_postgres 180

if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  ensure_compose_env
  maxim_topology_build_shared_api_image "$SCALE_PROJECT_NAME"
  SCALE_API_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${SCALE_PROJECT_NAME}-api-ingress:latest")"
  maxim_topology_require_ocr_native_sandbox_image_capability \
    "$SCALE_API_IMAGE_ID" "$TARGET_HAS_OCR_NATIVE_SANDBOX"
  maxim_topology_require_photo_native_image_capability "${SCALE_API_IMAGE_ID}"
fi

if ! run_migrations; then
  echo "First migration attempt failed. Retrying once in 5 seconds..."
  sleep 5
  run_migrations
fi

SERVICES_TO_BUILD=()
for service in "${SERVICES[@]}"; do
  if [[ "$BUILD_API_IMAGE" -eq 1 ]] && contains_service "$service" "${API_SERVICES[@]}"; then
    continue
  fi
  SERVICES_TO_BUILD+=("$service")
done

if [[ "${#SERVICES_TO_BUILD[@]}" -gt 0 ]]; then
  docker compose "${COMPOSE_FILES[@]}" build "${SERVICES_TO_BUILD[@]}"
fi

ensure_compose_env
remove_stale_service_containers "${SERVICES[@]}"
if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
  maxim_topology_stop_media_analysis_before_api_transition COMPOSE_FILES
fi
recreate_service_wave "support" "api-admin" "miniapp-static"
recreate_service_wave "major static" "miniapp-major-static"
recreate_service_wave "ingress" "api-ingress"
if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
  maxim_topology_recreate_ocr_native_sandbox COMPOSE_FILES "${SCALE_API_IMAGE_ID:-}"
  maxim_topology_smoke_ocr_native_sandbox_uds \
    COMPOSE_FILES "${SCALE_API_IMAGE_ID:-}" prestart
else
  maxim_topology_remove_ocr_native_sandbox_container COMPOSE_FILES
fi
recreate_service_wave "media analysis" "$MAXIM_MEDIA_ANALYSIS_SERVICE"

if [[ "$TARGET_HAS_MEDIA_ANALYSIS" -eq 1 ]]; then
  maxim_topology_verify_api_commercial_ocr_version \
    COMPOSE_FILES \
    "$TARGET_COMMERCIAL_OCR_VERSION"
  if [[ "$TARGET_HAS_OCR_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_verify_ocr_native_sandbox_runtime \
      COMPOSE_FILES "${SCALE_API_IMAGE_ID:-}" with-media
    maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required sandbox
  else
    maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required legacy
  fi
fi

if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  maxim_topology_reconcile_photo_native_sandbox COMPOSE_FILES "$SCALE_API_IMAGE_ID"
fi
recreate_service_wave "worker" \
  "api-enqueue" \
  "api-action" \
  "api-publisher" \
  "api-moderation" \
  "api-moderation-critical" \
  "api-moderation-join" \
  "api-moderation-realtime-b" \
  "api-moderation-realtime-c" \
  "api-moderation-realtime-d" \
  "api-moderation-background"
ensure_requested_services_running "$MAXIM_MEDIA_ANALYSIS_SERVICE"
if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then
  maxim_topology_verify_photo_native_sandbox_for_image COMPOSE_FILES "$SCALE_API_IMAGE_ID"
  if [[ "$MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX" -eq 1 ]]; then
    maxim_topology_smoke_photo_native_sandbox_uds COMPOSE_FILES "$SCALE_API_IMAGE_ID"
  fi
fi

wait_for_url "http://127.0.0.1:3001/api/health/live" 180
wait_for_url "http://127.0.0.1:3001/api/health/ready" 180
if contains_service "api-admin" "${SERVICES[@]}"; then
  wait_for_url "http://127.0.0.1:3002/api/health/live" 180
  wait_for_url "http://127.0.0.1:3002/api/health/ready" 180
fi
wait_for_url "$PUBLIC_HEALTH_URL/api/health/live" 180

curl -i http://127.0.0.1:3001/api/health/live
curl -i http://127.0.0.1:3001/api/health/ready
if contains_service "api-admin" "${SERVICES[@]}"; then
  curl -i http://127.0.0.1:3002/api/health/live
  curl -i http://127.0.0.1:3002/api/health/ready
fi
curl -i "$PUBLIC_HEALTH_URL/api/health/live"

if contains_service "miniapp-static" "${SERVICES[@]}"; then
  curl -i "$PUBLIC_HEALTH_URL/app/"
fi
if contains_service "miniapp-major-static" "${SERVICES[@]}"; then
  curl -i "$PUBLIC_HEALTH_URL/app/"
fi

echo "Done: branch=$BRANCH services=${SERVICES[*]}"
