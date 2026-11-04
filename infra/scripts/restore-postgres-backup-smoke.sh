#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=infra/scripts/lib/postgres-backup-profile.sh
source "$ROOT_DIR/infra/scripts/lib/postgres-backup-profile.sh"
BACKUP_DIR="$(maxim_backup_profile_directory "${MAXIM_BACKUP_DIR:-$ROOT_DIR/infra/data/backups}")"
POSTGRES_IMAGE="${MAXIM_BACKUP_POSTGRES_IMAGE:-postgres:16-alpine}"
COMPOSE_FILE="${MAXIM_BACKUP_COMPOSE_FILE:-$ROOT_DIR/infra/docker-compose.yml}"
RESTORE_DATA_ROOT="$(maxim_backup_profile_directory "${MAXIM_RESTORE_SMOKE_DATA_ROOT:-${MAXIM_BACKUP_DIR:-$ROOT_DIR/infra/data/backups}/restore-smoke-data}")"
MIN_FREE_BYTES="${MAXIM_RESTORE_SMOKE_MIN_FREE_BYTES:-2147483648}"
REQUIRED_PERCENT="${MAXIM_RESTORE_SMOKE_REQUIRED_PERCENT:-125}"
REQUIRE_DEDICATED_FILESYSTEM="${MAXIM_RESTORE_SMOKE_REQUIRE_DEDICATED_FILESYSTEM:-1}"
BACKING_FILESYSTEM_PATH="${MAXIM_BACKUP_BACKING_FILESYSTEM_PATH:-$RESTORE_DATA_ROOT}"
MAX_DURATION_SEC="${MAXIM_RESTORE_SMOKE_MAX_DURATION_SEC:-43200}"
READINESS_URL="${MAXIM_BACKUP_READINESS_URL:-http://127.0.0.1:3001/api/health/ready}"
MODE=""
DUMP_PATH=""

for argument in "$@"; do
  case "$argument" in
    --preflight-only)
      MODE="--preflight-only"
      ;;
    *)
      if [[ -n "$DUMP_PATH" ]]; then
        echo "Usage: $0 [dump-path] [--preflight-only]" >&2
        exit 2
      fi
      DUMP_PATH="$argument"
      ;;
  esac
done

if [[ ! "$MAX_DURATION_SEC" =~ ^[0-9]+$ ]] || ((MAX_DURATION_SEC < 1 || MAX_DURATION_SEC > 43200)); then
  echo "Invalid bounded restore duration." >&2
  exit 2
fi
if [[ ! "$MIN_FREE_BYTES" =~ ^[0-9]+$ || ! "$REQUIRED_PERCENT" =~ ^[0-9]+$ ]]; then
  echo "Restore-smoke capacity limits must be non-negative integers." >&2
  exit 2
fi
if ((REQUIRED_PERCENT < 100)); then
  echo "MAXIM_RESTORE_SMOKE_REQUIRED_PERCENT must be at least 100." >&2
  exit 2
fi
if [[ "$REQUIRE_DEDICATED_FILESYSTEM" != "0" && "$REQUIRE_DEDICATED_FILESYSTEM" != "1" ]]; then
  echo "MAXIM_RESTORE_SMOKE_REQUIRE_DEDICATED_FILESYSTEM must be 0 or 1." >&2
  exit 2
fi
# shellcheck source=infra/scripts/lib/postgres-restore-volume.sh
source "$ROOT_DIR/infra/scripts/lib/postgres-restore-volume.sh"
MAXIM_RESTORE_VOLUME_ACTIVE=0

# FLAG: A restore competes for the same disks as production. Serialize it with the
# producer and deployments, and never start without healthy production readiness.
probe_ready() {
  maxim_backup_profile_readiness "$READINESS_URL" 10
}
probe_ready
if [[ "$MODE" != --preflight-only ]]; then
  # shellcheck source=/dev/null
  source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
  acquire_deploy_lock || exit 75
  trap release_deploy_lock EXIT
fi
if [[ -z "$DUMP_PATH" ]]; then
  DUMP_PATH="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${MAXIM_BACKUP_PREFIX}_*.dump" -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d ' ' -f 2-)"
fi

if [[ -z "$DUMP_PATH" || ! -f "$DUMP_PATH" || ! -s "$DUMP_PATH" ]]; then
  echo "No completed PostgreSQL backup was found for restore smoke." >&2
  exit 2
fi

DUMP_DIR="$(cd "$(dirname "$DUMP_PATH")" && pwd)"
DUMP_PATH="$DUMP_DIR/$(basename "$DUMP_PATH")"
[[ "$(basename "$DUMP_PATH")" =~ ^${MAXIM_BACKUP_PREFIX}_[0-9]{8}T[0-9]{6}Z\.dump$ ]]
[[ ! -L "$DUMP_PATH" ]]
CHECKSUM_PATH="$DUMP_PATH.sha256"
if [[ ! -f "$CHECKSUM_PATH" ]]; then
  echo "Backup checksum is missing: $CHECKSUM_PATH" >&2
  exit 2
fi

# FLAG: Check only this exact archive; a sidecar naming another file proves nothing.
[[ -f "$DUMP_PATH.sha256" && ! -L "$DUMP_PATH.sha256" ]]
(( $(stat -c %s "$DUMP_PATH.sha256") <= 256 ))
CHECKSUM_LINE="$(cat "$DUMP_PATH.sha256")"
EXPECTED_SHA="${CHECKSUM_LINE:0:64}"
[[ "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ && "$CHECKSUM_LINE" == "$EXPECTED_SHA  $(basename "$DUMP_PATH")" ]]

(
  cd "$DUMP_DIR"
  sha256sum --check --status "$(basename "$CHECKSUM_PATH")"
)

DATABASE_BYTES="$(
  docker compose -f "$COMPOSE_FILE" exec -T "$MAXIM_BACKUP_SERVICE" \
    psql -U "$MAXIM_BACKUP_DATABASE" -d "$MAXIM_BACKUP_DATABASE" -Atqc 'SELECT pg_database_size(current_database())'
)"
DATABASE_BYTES="${DATABASE_BYTES//[[:space:]]/}"
if [[ "$MAXIM_RESTORE_VOLUME_BYTES" != 0 ]]; then
  maxim_restore_volume_action preflight >/dev/null
  if [[ "$MODE" == --preflight-only ]]; then
    echo 'PostgreSQL restore archive and physical capacity preflight passed; sparse virtual capacity is an estimate until mounted.'
    exit 0
  fi
  # FLAG: This owner keeps the existing protected lock and the only cleanup trap.
  # A missing write-ahead result is retained for review, never automatically adopted.
  cleanup_volume_prepare() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [[ "$MAXIM_RESTORE_VOLUME_ACTIVE" == 1 ]]; then
      maxim_restore_volume_action cleanup >/dev/null || status=1
    fi
    release_deploy_lock || status=1
    exit "$status"
  }
  trap cleanup_volume_prepare EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  MAXIM_RESTORE_VOLUME_ACTIVE=1
  VOLUME_RESULT="$(maxim_restore_volume_action prepare)"
  RESTORE_DATA_ROOT="$(maxim_restore_volume_value "$VOLUME_RESULT" mount)"
  RESTORE_DATA_DIR="$(maxim_restore_volume_value "$VOLUME_RESULT" data)"
else
  mkdir -p "$RESTORE_DATA_ROOT"
fi
if [[ "$REQUIRE_DEDICATED_FILESYSTEM" == "1" ]] && \
  [[ "$(stat -c %d "$RESTORE_DATA_ROOT")" == "$(stat -c %d "$ROOT_DIR")" ]]; then
  echo "Refusing to restore a full PostgreSQL backup on the production application filesystem." >&2
  echo "Mount a separate disposable volume at MAXIM_RESTORE_SMOKE_DATA_ROOT." >&2
  exit 1
fi
AVAILABLE_BYTES="$(df -PB1 "$RESTORE_DATA_ROOT" | awk 'NR == 2 { print $4 }')"
if [[ ! "$DATABASE_BYTES" =~ ^[0-9]+$ || ! "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then
  echo "Could not determine PostgreSQL size or restore filesystem capacity." >&2
  exit 1
fi

REQUIRED_BYTES=$(((DATABASE_BYTES * REQUIRED_PERCENT + 99) / 100 + MIN_FREE_BYTES))
BACKING_AVAILABLE_BYTES="$(df -PB1 "$BACKING_FILESYSTEM_PATH" | awk 'NR == 2 { print $4 }')"
if [[ ! "$BACKING_AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then exit 1; fi
if ((AVAILABLE_BYTES < REQUIRED_BYTES || BACKING_AVAILABLE_BYTES < REQUIRED_BYTES)); then
  echo "Insufficient free space for an isolated PostgreSQL restore smoke." >&2
  echo "Available bytes: $AVAILABLE_BYTES; required bytes: $REQUIRED_BYTES." >&2
  echo "Configure MAXIM_RESTORE_SMOKE_DATA_ROOT on a separate disposable volume." >&2
  exit 1
fi

if [[ "$MODE" == "--preflight-only" ]]; then
  echo "PostgreSQL restore-smoke capacity and archive preflight passed."
  exit 0
fi

CONTAINER_NAME="${MAXIM_BACKUP_UNIT_PREFIX}-restore-smoke-$$-$RANDOM"
if [[ "$MAXIM_RESTORE_VOLUME_BYTES" == 0 ]]; then
  RESTORE_DATA_DIR="$(mktemp -d "$RESTORE_DATA_ROOT/${MAXIM_BACKUP_PREFIX}-restore-smoke.XXXXXX")"
fi
WATCHDOG_PID=""
ABORT_MARKER="$RESTORE_DATA_DIR/.watchdog-aborted"
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$WATCHDOG_PID" ]]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
  fi
  if [[ "$MAXIM_RESTORE_VOLUME_BYTES" != 0 ]]; then
    maxim_restore_volume_action cleanup >/dev/null || status=1
  else
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    rm -rf -- "$RESTORE_DATA_DIR" || status=1
  fi
  release_deploy_lock || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

probe_ready
CONTAINER_LIFECYCLE=(--rm)
if [[ "$MAXIM_RESTORE_VOLUME_BYTES" != 0 ]]; then
  VOLUME_RESULT="$(maxim_restore_volume_action container-starting)"
  CONTAINER_NAME="$(maxim_restore_volume_value "$VOLUME_RESULT" containerName)"
  CONTAINER_CIDFILE="$(maxim_restore_volume_value "$VOLUME_RESULT" cidfile)"
  CONTAINER_LIFECYCLE=(--cidfile "$CONTAINER_CIDFILE" --label "maxim.restore.operation=$MAXIM_RESTORE_VOLUME_OPERATION")
fi
docker run --detach "${CONTAINER_LIFECYCLE[@]}" \
  --name "$CONTAINER_NAME" \
  --network none --cpus 2 --memory 4g --pids-limit 128 --shm-size 256m \
  --env POSTGRES_PASSWORD=restore-smoke-only \
  --mount "type=bind,source=$RESTORE_DATA_DIR,target=/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE" >/dev/null

watch_restore() {
  local failures=0 free backing started=$SECONDS sleeper="" sample_ready
  # FLAG: The watchdog owns its sleep child, which inherits the deploy lock.
  # Reap it on shutdown so completion never leaves a live lock holder behind.
  trap - EXIT
  trap 'if [[ -n "$sleeper" ]]; then kill "$sleeper" 2>/dev/null || true; wait "$sleeper" 2>/dev/null || true; fi; exit 0' TERM INT HUP
  while true; do
    sleep 15 &
    sleeper=$!
    wait "$sleeper" || return
    sleeper=""
    free="$(df -PB1 "$RESTORE_DATA_ROOT" | awk 'NR==2 {print $4}')"
    backing="$(df -PB1 "$BACKING_FILESYSTEM_PATH" | awk 'NR==2 {print $4}')"
    if [[ ! "$free" =~ ^[0-9]+$ || ! "$backing" =~ ^[0-9]+$ ]] ||
      (( free < MIN_FREE_BYTES || backing < BACKING_MIN_FREE_BYTES || SECONDS - started >= MAX_DURATION_SEC )); then
      failures=2
    elif probe_ready; then
      failures=0
    else
      failures=$((failures + 1))
    fi
    if [[ "$MAXIM_RESTORE_VOLUME_BYTES" != 0 ]]; then
      sample_ready=0
      if ((failures == 0)); then sample_ready=1; fi
      maxim_restore_volume_action sample "$sample_ready" "$free" "$backing" >/dev/null || failures=2
    fi
    if (( failures >= 2 )); then
      touch "$ABORT_MARKER"
      docker stop --time 10 "$CONTAINER_NAME" >/dev/null 2>&1 || true
      return
    fi
  done
}
watch_restore &
WATCHDOG_PID=$!

ready=0
# FLAG: The image's temporary init server answers on Unix sockets before stopping.
# Only the final server accepts loopback TCP; keep restore clients on local sockets.
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER_NAME" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Disposable PostgreSQL did not become ready." >&2
  exit 1
fi

docker exec -i "$CONTAINER_NAME" pg_restore --list < "$DUMP_PATH" >/dev/null
docker exec "$CONTAINER_NAME" createdb -U postgres "${MAXIM_BACKUP_PREFIX}_restore_smoke"
timeout --signal=TERM --kill-after=30s "${MAX_DURATION_SEC}s" docker exec -i "$CONTAINER_NAME" pg_restore \
  -U postgres \
  -d "${MAXIM_BACKUP_PREFIX}_restore_smoke" \
  --exit-on-error \
  --no-owner \
  --no-privileges < "$DUMP_PATH"

HAS_MIGRATIONS_TABLE="$(
  docker exec "$CONTAINER_NAME" psql -U postgres -d "${MAXIM_BACKUP_PREFIX}_restore_smoke" -Atqc \
    "SELECT CASE WHEN to_regclass('public.${MAXIM_BACKUP_MIGRATIONS_TABLE}') IS NULL THEN 0 ELSE 1 END"
)"
if [[ "$HAS_MIGRATIONS_TABLE" != 1 ]]; then
  echo "Restore smoke did not find the selected migration table." >&2
  exit 1
fi

SCHEMA_DIGEST=""
if [[ "$MAXIM_BACKUP_PROFILE" == eraser ]]; then
  SCHEMA_DIGEST="$(node "$ROOT_DIR/infra/scripts/eraser-restore-invariants.mjs" --digest)"
  INVARIANTS="$(node "$ROOT_DIR/infra/scripts/eraser-restore-invariants.mjs" --sql |
    docker exec -i "$CONTAINER_NAME" psql -U postgres -d "${MAXIM_BACKUP_PREFIX}_restore_smoke" -XAtq -v ON_ERROR_STOP=1)"
else
# FLAG: These queries run only inside the disposable restored database, never the primary.
INVARIANTS="$(docker exec "$CONTAINER_NAME" psql -U postgres -d "${MAXIM_BACKUP_PREFIX}_restore_smoke" -Atqc "
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM (VALUES ('webhook_events'), ('webhook_execution_claims'),
      ('max_action_ledger'), ('publications'), ('publication_occurrences'),
      ('managed_broadcast_deliveries')) AS critical(name)
    WHERE to_regclass('public.' || name) IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_index WHERE indrelid=to_regclass('public.' || name)
        AND indisprimary AND indisvalid AND indisready
    )
  ) AND NOT EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL)
  THEN 1 ELSE 0 END")"
fi
[[ "$INVARIANTS" == 1 && ! -e "$ABORT_MARKER" ]]
probe_ready
if [[ "$MAXIM_RESTORE_VOLUME_BYTES" != 0 ]]; then
  # FLAG: A schema result cannot publish green evidence while disposable resources leak.
  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
  WATCHDOG_PID=""
  maxim_restore_volume_action cleanup >/dev/null
fi
RECEIPT_TMP="$(mktemp "$DUMP_PATH.restore-verified.XXXXXX.tmp")"
node - "$DUMP_PATH" "$POSTGRES_IMAGE" "$MAXIM_BACKUP_PROFILE" "$MAXIM_BACKUP_RESTORE_VERIFICATION" "$SCHEMA_DIGEST" >"$RECEIPT_TMP" <<'JS'
const fs=require('node:fs');
const [dump, postgresImage, profile, verification, schemaDigest]=process.argv.slice(2);
process.stdout.write(JSON.stringify({ schemaVersion:1, verifiedAt:new Date().toISOString(),
  dump:require('node:path').basename(dump), dumpSha256:fs.readFileSync(dump+'.sha256','utf8').split(/\s+/)[0],
  postgresImage, profile, verification, ...(schemaDigest ? {schemaDigest} : {}), network:'none' })+'\n');
JS
mv "$RECEIPT_TMP" "$DUMP_PATH.restore-verified.json"

echo "PostgreSQL restore smoke passed for $DUMP_PATH"
