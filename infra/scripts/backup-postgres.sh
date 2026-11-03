#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=infra/scripts/lib/postgres-backup-profile.sh
source "$ROOT_DIR/infra/scripts/lib/postgres-backup-profile.sh"
BACKUP_DIR="$(maxim_backup_profile_directory "${MAXIM_BACKUP_DIR:-$ROOT_DIR/infra/data/backups}")"
RETENTION_DAYS="${MAXIM_BACKUP_RETENTION_DAYS:-14}"
COMPOSE_FILE="${MAXIM_BACKUP_COMPOSE_FILE:-$ROOT_DIR/infra/docker-compose.yml}"
MIN_FREE_BYTES="${MAXIM_BACKUP_MIN_FREE_BYTES:-2147483648}"
REQUIRE_DEDICATED_FILESYSTEM="${MAXIM_BACKUP_REQUIRE_DEDICATED_FILESYSTEM:-1}"
RATE_LIMIT_BYTES_PER_SEC="${MAXIM_BACKUP_RATE_LIMIT_BYTES_PER_SEC:-1048576}"
MAX_DURATION_SEC="${MAXIM_BACKUP_MAX_DURATION_SEC:-43200}"
READINESS_URL="${MAXIM_BACKUP_READINESS_URL:-http://127.0.0.1:3001/api/health/ready}"
READINESS_TIMEOUT_SEC="${MAXIM_BACKUP_READINESS_TIMEOUT_SEC:-10}"
WATCHDOG_INTERVAL_SEC="${MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC:-30}"
WATCHDOG_FAILURE_THRESHOLD="${MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD:-2}"
LOCK_FILE="${MAXIM_BACKUP_LOCK_FILE:-$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}-postgres-backup.lock}"
RATE_LIMITER="$ROOT_DIR/infra/scripts/rate-limit-stream.mjs"
DEPLOY_LOCK_HELPER="$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
BACKING_FILESYSTEM_PATH="${MAXIM_BACKUP_BACKING_FILESYSTEM_PATH:-$BACKUP_DIR}"
REPLICATION_REQUIRED="${MAXIM_BACKUP_REPLICATION_REQUIRED:-0}"
MODE="${1:-}"
DEPLOY_LOCK_ACQUIRED=0

record_schedule_result() {
  if [[ -n "${MAXIM_BACKUP_OPERATION_ID:-}${MAXIM_BACKUP_RESULT_FILE:-}" ]]; then
    node "$ROOT_DIR/infra/scripts/postgres-backup-schedule.mjs" producer-result "$@"
  fi
}

validate_non_negative_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "$name must be a non-negative integer." >&2
    exit 2
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required for PostgreSQL backups." >&2
    exit 1
  fi
}

validate_non_negative_integer MAXIM_BACKUP_RETENTION_DAYS "$RETENTION_DAYS"
validate_non_negative_integer MAXIM_BACKUP_MIN_FREE_BYTES "$MIN_FREE_BYTES"
validate_non_negative_integer MAXIM_BACKUP_RATE_LIMIT_BYTES_PER_SEC "$RATE_LIMIT_BYTES_PER_SEC"
validate_non_negative_integer MAXIM_BACKUP_MAX_DURATION_SEC "$MAX_DURATION_SEC"
validate_non_negative_integer MAXIM_BACKUP_READINESS_TIMEOUT_SEC "$READINESS_TIMEOUT_SEC"
validate_non_negative_integer MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC "$WATCHDOG_INTERVAL_SEC"
validate_non_negative_integer MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD "$WATCHDOG_FAILURE_THRESHOLD"
if ((RATE_LIMIT_BYTES_PER_SEC < 1 || RATE_LIMIT_BYTES_PER_SEC > 1073741824)); then
  echo "MAXIM_BACKUP_RATE_LIMIT_BYTES_PER_SEC must be between 1 and 1073741824." >&2
  exit 2
fi
if ((MAX_DURATION_SEC < 1 || MAX_DURATION_SEC > 43200)); then
  echo "MAXIM_BACKUP_MAX_DURATION_SEC must be between 1 and 43200." >&2
  exit 2
fi
if ((READINESS_TIMEOUT_SEC < 1 || READINESS_TIMEOUT_SEC > 60)); then
  echo "MAXIM_BACKUP_READINESS_TIMEOUT_SEC must be between 1 and 60." >&2
  exit 2
fi
if ((WATCHDOG_INTERVAL_SEC < 1 || WATCHDOG_INTERVAL_SEC > 3600)); then
  echo "MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC must be between 1 and 3600." >&2
  exit 2
fi
if ((WATCHDOG_FAILURE_THRESHOLD < 1 || WATCHDOG_FAILURE_THRESHOLD > 10)); then
  echo "MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD must be between 1 and 10." >&2
  exit 2
fi
if [[ "$REQUIRE_DEDICATED_FILESYSTEM" != "0" && "$REQUIRE_DEDICATED_FILESYSTEM" != "1" ]]; then
  echo "MAXIM_BACKUP_REQUIRE_DEDICATED_FILESYSTEM must be 0 or 1." >&2
  exit 2
fi
if [[ "$REPLICATION_REQUIRED" != "0" && "$REPLICATION_REQUIRED" != "1" ]]; then
  echo "MAXIM_BACKUP_REPLICATION_REQUIRED must be 0 or 1." >&2
  exit 2
fi
if [[ -z "$LOCK_FILE" ]]; then
  echo "MAXIM_BACKUP_LOCK_FILE must not be empty." >&2
  exit 2
fi
if [[ -n "$MODE" && "$MODE" != "--preflight-only" ]]; then
  echo "Usage: $0 [--preflight-only]" >&2
  exit 2
fi

for required_command in curl docker flock node; do
  require_command "$required_command"
done
if [[ "$MODE" != "--preflight-only" ]]; then
  require_command timeout
  if [[ ! -r "$RATE_LIMITER" ]]; then
    echo "PostgreSQL backup stream rate limiter is missing." >&2
    exit 1
  fi
  if [[ ! -r "$DEPLOY_LOCK_HELPER" ]]; then
    echo "Shared deploy lock helper is missing." >&2
    exit 1
  fi
fi

mkdir -p "$BACKUP_DIR"
record_schedule_result admission
exec {BACKUP_LOCK_FD}>>"$LOCK_FILE"
if flock -n -E 75 "$BACKUP_LOCK_FD"; then
  :
else
  BACKUP_LOCK_STATUS=$?
  echo "Another PostgreSQL backup is already running." >&2
  if [[ "$BACKUP_LOCK_STATUS" == 75 ]]; then record_schedule_result deferred backup_lock_busy; fi
  exit 75
fi

probe_runtime_ready() {
  maxim_backup_profile_readiness "$READINESS_URL" "$READINESS_TIMEOUT_SEC"
}

if ! probe_runtime_ready; then
  echo "Refusing PostgreSQL backup while readiness or raw queue lag is degraded." >&2
  record_schedule_result deferred readiness_not_ready
  exit 75
fi

if [[ "$MODE" != "--preflight-only" ]]; then
  # A logical dump reads the primary for hours, so it must not overlap any deploy,
  # rollback, image preload, or other operation protected by the shared lock.
  # shellcheck source=/dev/null
  source "$DEPLOY_LOCK_HELPER"
  if ! acquire_deploy_lock; then
    echo "Refusing PostgreSQL backup while a deployment or maintenance operation is active." >&2
    case "${MAXIM_DEPLOY_ADMISSION_REFUSAL:-unknown}" in
      pair_lock_busy|product_lock_busy) record_schedule_result deferred "$MAXIM_DEPLOY_ADMISSION_REFUSAL" ;;
    esac
    exit 75
  fi
  DEPLOY_LOCK_ACQUIRED=1
  # FLAG: Admission can outlive a deploy. Refuse source drift before touching the
  # primary; the acquired deploy lock now keeps these checked shell inputs stable.
  if [[ -n "${MAXIM_BACKUP_SOURCE_SHA:-}" ]]; then
    [[ "$MAXIM_BACKUP_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
    # FLAG: Root systemd reads the operator-owned checkout without inherited sudo
    # trust. Scope this exception to each exact-source command, never global config.
    BACKUP_SOURCE_GIT_ARGS=()
    if ((EUID == 0)); then BACKUP_SOURCE_GIT_ARGS=(-c "safe.directory=$ROOT_DIR"); fi
    [[ "$(GIT_OPTIONAL_LOCKS=0 git "${BACKUP_SOURCE_GIT_ARGS[@]}" -C "$ROOT_DIR" rev-parse HEAD)" == "$MAXIM_BACKUP_SOURCE_SHA" ]]
    # FLAG: Source reads must not replace the operator-owned index as root. A quiet
    # diff without auto-refresh can reject stat-only changes; numstat compares content.
    BACKUP_SOURCE_SCRIPT_DIFF="$(GIT_OPTIONAL_LOCKS=0 git "${BACKUP_SOURCE_GIT_ARGS[@]}" \
      -c diff.autoRefreshIndex=false -C "$ROOT_DIR" diff --numstat --no-ext-diff --no-textconv \
      "$MAXIM_BACKUP_SOURCE_SHA" -- infra/scripts)"
    [[ -z "$BACKUP_SOURCE_SCRIPT_DIFF" ]]
  fi
fi

if [[ "$REQUIRE_DEDICATED_FILESYSTEM" == "1" ]] && \
  [[ "$(stat -c %d "$BACKUP_DIR")" == "$(stat -c %d "$ROOT_DIR")" ]]; then
  echo "Refusing to store a PostgreSQL backup on the production application filesystem." >&2
  echo "Mount a separate persistent volume at MAXIM_BACKUP_DIR before retrying." >&2
  exit 1
fi

# Remove expired generations before the capacity check, but preserve the newest completed
# dump/checksum pair until a later run has successfully published its replacement.
# FLAG: Retention cannot remove an exact archive awaiting independent verification,
# including one produced by an interrupted scheduled operation.
PINNED_DUMP="$(MAXIM_BACKUP_DIR="${MAXIM_BACKUP_DIR:-$ROOT_DIR/infra/data/backups}" node "$ROOT_DIR/infra/scripts/postgres-backup-schedule.mjs" retention-pin)"
LATEST_COMPLETED_DUMP=""
shopt -s nullglob
for completed_dump in "$BACKUP_DIR"/"${MAXIM_BACKUP_PREFIX}"_*.dump; do
  if [[ -f "$completed_dump.sha256" ]]; then
    LATEST_COMPLETED_DUMP="$completed_dump"
  fi
done
shopt -u nullglob

if [[ "$MODE" != "--preflight-only" ]]; then
  while IFS= read -r -d '' expired_dump; do
    if [[ "$expired_dump" == "$LATEST_COMPLETED_DUMP" || "$(basename "$expired_dump")" == "$PINNED_DUMP" ]]; then
      continue
    fi
    rm -f -- "$expired_dump" "$expired_dump.sha256"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${MAXIM_BACKUP_PREFIX}_*.dump" -mtime "+$RETENTION_DAYS" -print0)
  while IFS= read -r -d '' expired_checksum; do
    if [[ "$expired_checksum" == "$LATEST_COMPLETED_DUMP.sha256" || "$(basename "$expired_checksum")" == "$PINNED_DUMP.sha256" ]]; then
      continue
    fi
    rm -f -- "$expired_checksum"
  done < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "${MAXIM_BACKUP_PREFIX}_*.dump.sha256" \
      -mtime "+$RETENTION_DAYS" -print0
  )
fi

# Keep the newest verification of each kind even after its local archive ages out.
# This preserves weekly restore evidence while bounding daily receipt accumulation.
if [[ "$MODE" != "--preflight-only" ]]; then
  for receipt_suffix in remote-verified restore-verified; do
    latest_receipt=""
    shopt -s nullglob
    for receipt_file in "$BACKUP_DIR"/"${MAXIM_BACKUP_PREFIX}"_*.dump."$receipt_suffix".json; do latest_receipt="$receipt_file"; done
    shopt -u nullglob
    while IFS= read -r -d '' receipt_file; do
      if [[ "$receipt_file" != "$latest_receipt" ]]; then rm -f -- "$receipt_file"; fi
    done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${MAXIM_BACKUP_PREFIX}_*.dump.$receipt_suffix.json" -mtime +14 -print0)
  done
fi

DATABASE_BYTES="$(
  docker compose -f "$COMPOSE_FILE" exec -T "$MAXIM_BACKUP_SERVICE" \
    psql -U "$MAXIM_BACKUP_DATABASE" -d "$MAXIM_BACKUP_DATABASE" -Atqc 'SELECT pg_database_size(current_database())'
)"
DATABASE_BYTES="${DATABASE_BYTES//[[:space:]]/}"
AVAILABLE_BYTES="$(df -PB1 "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
if [[ ! "$DATABASE_BYTES" =~ ^[0-9]+$ || ! "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then
  echo "Could not determine PostgreSQL size or backup filesystem capacity." >&2
  exit 1
fi

# A custom dump omits physical index pages, but reserving the full database size keeps
# incompressible data from filling the production filesystem mid-stream.
REQUIRED_BYTES=$((DATABASE_BYTES + MIN_FREE_BYTES))
BACKING_AVAILABLE_BYTES="$(df -PB1 "$BACKING_FILESYSTEM_PATH" | awk 'NR == 2 { print $4 }')"
if [[ ! "$BACKING_AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then exit 1; fi
if ((AVAILABLE_BYTES < REQUIRED_BYTES || BACKING_AVAILABLE_BYTES < REQUIRED_BYTES)); then
  echo "Insufficient free space for a fail-safe PostgreSQL backup." >&2
  echo "Available bytes: $AVAILABLE_BYTES; required bytes: $REQUIRED_BYTES." >&2
  echo "Configure MAXIM_BACKUP_DIR on a separate persistent volume before retrying." >&2
  exit 1
fi

if [[ "$MODE" == "--preflight-only" ]]; then
  echo "PostgreSQL backup readiness and capacity preflight passed."
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PG_APP_NAME="${MAXIM_BACKUP_PREFIX}-postgres-backup-${STAMP}-${BASHPID}"
TARGET="$BACKUP_DIR/${MAXIM_BACKUP_PREFIX}_${STAMP}.dump"
CHECKSUM_TARGET="$TARGET.sha256"
if [[ -e "$TARGET" || -e "$CHECKSUM_TARGET" ]]; then
  echo "Refusing to overwrite an existing PostgreSQL backup generation." >&2
  exit 1
fi
record_schedule_result producing "$(basename "$TARGET")"
TEMP_DUMP="$(mktemp "$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}_${STAMP}.XXXXXX.dump.tmp")"
TEMP_CHECKSUM="$(mktemp "$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}_${STAMP}.XXXXXX.sha256.tmp")"
TEMP_PIPE="$(mktemp "$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}_${STAMP}.XXXXXX.pipe.tmp")"
WATCHDOG_ABORT_MARKER="$(mktemp "$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}_${STAMP}.XXXXXX.watchdog.tmp")"
rm -f -- "$TEMP_PIPE"
mkfifo -m 600 "$TEMP_PIPE"
DUMP_STARTED=0
PUBLISH_STARTED=0
DUMP_PROCESS_PID=""
LIMITER_PROCESS_PID=""
WATCHDOG_PROCESS_PID=""

cleanup_backend() {
  docker compose -f "$COMPOSE_FILE" exec -T "$MAXIM_BACKUP_SERVICE" \
    psql -U "$MAXIM_BACKUP_DATABASE" -d "$MAXIM_BACKUP_DATABASE" -Atqc \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '$PG_APP_NAME' AND pid <> pg_backend_pid()" \
    >/dev/null 2>&1 || true
}

terminate_process_group() {
  local pid="$1"
  local process_group
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    return
  fi
  process_group="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$process_group" == "$pid" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

stop_dump_processes() {
  terminate_process_group "$DUMP_PROCESS_PID"
  terminate_process_group "$LIMITER_PROCESS_PID"
  terminate_process_group "$WATCHDOG_PROCESS_PID"
  for pid in "$DUMP_PROCESS_PID" "$LIMITER_PROCESS_PID" "$WATCHDOG_PROCESS_PID"; do
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if ((DUMP_STARTED == 1)); then
    cleanup_backend
    stop_dump_processes
  fi
  rm -f -- "$TEMP_DUMP" "$TEMP_CHECKSUM" "$TEMP_PIPE" "$WATCHDOG_ABORT_MARKER"
  if ((PUBLISH_STARTED == 1)); then
    rm -f -- "$TARGET" "$CHECKSUM_TARGET"
  fi
  if ((DEPLOY_LOCK_ACQUIRED == 1)); then
    release_deploy_lock || true
    DEPLOY_LOCK_ACQUIRED=0
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

watch_dump_health() {
  local consecutive_failures=0 current_free backing_free
  while sleep "$WATCHDOG_INTERVAL_SEC"; do
    if ! kill -0 "$DUMP_PROCESS_PID" 2>/dev/null; then
      return
    fi
    current_free="$(df -PB1 "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
    backing_free="$(df -PB1 "$BACKING_FILESYSTEM_PATH" | awk 'NR == 2 { print $4 }')"
    if [[ ! "$current_free" =~ ^[0-9]+$ || ! "$backing_free" =~ ^[0-9]+$ ]] ||
      (( current_free < MIN_FREE_BYTES || backing_free < MIN_FREE_BYTES )); then
      printf 'capacity_aborted\n' >"$WATCHDOG_ABORT_MARKER"
      cleanup_backend
      terminate_process_group "$DUMP_PROCESS_PID"
      terminate_process_group "$LIMITER_PROCESS_PID"
      return
    fi
    if probe_runtime_ready; then
      consecutive_failures=0
      continue
    fi
    consecutive_failures=$((consecutive_failures + 1))
    echo "PostgreSQL backup watchdog observed degraded readiness or raw queue lag ($consecutive_failures/$WATCHDOG_FAILURE_THRESHOLD)." >&2
    if ((consecutive_failures < WATCHDOG_FAILURE_THRESHOLD)); then
      continue
    fi
    printf 'aborted\n' >"$WATCHDOG_ABORT_MARKER"
    cleanup_backend
    terminate_process_group "$DUMP_PROCESS_PID"
    terminate_process_group "$LIMITER_PROCESS_PID"
    return
  done
}

DUMP_STARTED=1
set -m
# Positional parameters expand inside the container shell.
# shellcheck disable=SC2016
timeout --signal=TERM --kill-after=30s "${MAX_DURATION_SEC}s" \
  docker compose -f "$COMPOSE_FILE" exec -T "$MAXIM_BACKUP_SERVICE" \
    sh -lc 'exec env PGAPPNAME="$3" ionice -c2 -n7 nice -n19 pg_dump \
      --no-password -U "$1" -d "$2" \
      --format=custom --compress=gzip:3 --no-owner --no-privileges \
      --lock-wait-timeout=10s' -- "$MAXIM_BACKUP_DATABASE" "$MAXIM_BACKUP_DATABASE" "$PG_APP_NAME" >"$TEMP_PIPE" &
DUMP_PROCESS_PID=$!
node "$RATE_LIMITER" "$RATE_LIMIT_BYTES_PER_SEC" <"$TEMP_PIPE" >"$TEMP_DUMP" &
LIMITER_PROCESS_PID=$!
watch_dump_health &
WATCHDOG_PROCESS_PID=$!
set +m

set +e
wait -n -p FIRST_COMPLETED_PID "$DUMP_PROCESS_PID" "$LIMITER_PROCESS_PID"
FIRST_COMPLETED_STATUS=$?
set -e
if [[ "$FIRST_COMPLETED_PID" == "$DUMP_PROCESS_PID" ]]; then
  DUMP_STATUS=$FIRST_COMPLETED_STATUS
  set +e
  wait "$LIMITER_PROCESS_PID"
  LIMITER_STATUS=$?
  set -e
else
  LIMITER_STATUS=$FIRST_COMPLETED_STATUS
  if ((LIMITER_STATUS != 0)); then
    cleanup_backend
    terminate_process_group "$DUMP_PROCESS_PID"
  fi
  set +e
  wait "$DUMP_PROCESS_PID"
  DUMP_STATUS=$?
  set -e
fi
terminate_process_group "$WATCHDOG_PROCESS_PID"
wait "$WATCHDOG_PROCESS_PID" 2>/dev/null || true
WATCHDOG_PROCESS_PID=""
cleanup_backend
DUMP_STARTED=0
rm -f -- "$TEMP_PIPE"

if [[ -s "$WATCHDOG_ABORT_MARKER" ]]; then
  echo "PostgreSQL backup aborted after sustained readiness or raw queue lag degradation." >&2
  exit 1
fi
if ((DUMP_STATUS != 0 || LIMITER_STATUS != 0)); then
  echo "PostgreSQL backup did not complete within its bounded resource envelope." >&2
  exit 1
fi

if [[ ! -s "$TEMP_DUMP" ]]; then
  echo "PostgreSQL backup is empty." >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T "$MAXIM_BACKUP_SERVICE" pg_restore --list <"$TEMP_DUMP" >/dev/null

CHECKSUM="$(sha256sum "$TEMP_DUMP" | awk '{print $1}')"
printf '%s  %s\n' "$CHECKSUM" "$(basename "$TARGET")" >"$TEMP_CHECKSUM"

PUBLISH_STARTED=1
mv -- "$TEMP_DUMP" "$TARGET"
mv -- "$TEMP_CHECKSUM" "$CHECKSUM_TARGET"
PUBLISH_STARTED=0
record_schedule_result local_complete "$(basename "$TARGET")" "$CHECKSUM" "$(stat -c %s "$TARGET")"
rm -f -- "$WATCHDOG_ABORT_MARKER"
release_deploy_lock
DEPLOY_LOCK_ACQUIRED=0
trap - EXIT HUP INT TERM

echo "Validated PostgreSQL backup saved to $TARGET"
if [[ "$REPLICATION_REQUIRED" == 1 ]]; then
  "$ROOT_DIR/infra/scripts/replicate-postgres-backup.sh" "$TARGET"
fi
