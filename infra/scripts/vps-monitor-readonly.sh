#!/usr/bin/env bash
# ShellCheck cannot follow function reachability through the isolated background monitor worker.
# shellcheck disable=SC2317,SC2329
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=infra/scripts/lib/deploy-topology.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-topology.sh"
# shellcheck source=infra/scripts/lib/deploy-disk-capacity.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-disk-capacity.sh"

DURATION_SEC="${1:-${MAXIM_MONITOR_DURATION_SEC:-1800}}"
INTERVAL_SEC="${2:-${MAXIM_MONITOR_INTERVAL_SEC:-300}}"
CAPACITY_INTERVAL_SEC="${MAXIM_MONITOR_CAPACITY_INTERVAL_SEC:-15}"
TAIL_LINES="${MAXIM_MONITOR_LOG_TAIL_LINES:-300}"
FAILED_FRESH_WINDOW_SEC="${MAXIM_MONITOR_FAILED_FRESH_WINDOW_SEC:-300}"
LAST_SERVICE_LOG_SCAN_AT_SEC=0
LAST_STATIC_LOG_SCAN_AT_SEC=0
LAST_BULLMQ_PROBE_AT_MS=0
LOG_FILE="${MAXIM_MONITOR_LOG:-}"
EPHEMERAL_LOG_DIR=""
MONITOR_LOG_FD=""
MONITOR_TEE_PID=""
MONITOR_WORKER_PID=""
CAPACITY_SAMPLE_INDEX=0
SAMPLE_STEP_COUNT=0
SAMPLE_STEP_FAILURES=0
EXPECTED_SAMPLE_STEPS=16
CAPACITY_SAMPLER_PID=""
CAPACITY_SAMPLER_LOCK_FD=""
PUBLIC_URL="${MAXIM_VPS_PUBLIC_URL:-https://major-maksimov.ru}"
ADMIN_PUBLIC_URL="${MAXIM_ADMIN_PUBLIC_URL:-https://admin.major-maksimov.ru}"
SIGNAL_WINDOW_MIN="${MAXIM_MONITOR_SIGNAL_WINDOW_MIN:-30}"
MONITOR_LOCK_FILE="${MAXIM_MONITOR_LOCK_FILE:-${TMPDIR:-/tmp}/maxim-vps-monitor-readonly-${UID}.lock}"
CAPACITY_SAMPLER_LOCK_FILE="${MAXIM_MONITOR_CAPACITY_LOCK_FILE:-${MONITOR_LOCK_FILE}.capacity}"
CAPACITY_BLOCK_DEVICE="${MAXIM_MONITOR_CAPACITY_BLOCK_DEVICE:-md1}"
CAPACITY_PROBE="$ROOT_DIR/infra/scripts/monitor-capacity-probe.cjs"
CAPACITY_ARCHIVER="$ROOT_DIR/infra/scripts/monitor-capacity-archive.cjs"
if [[ -n "${XDG_STATE_HOME:-}" ]]; then
  CAPACITY_STATE_HOME="$XDG_STATE_HOME"
else
  CAPACITY_STATE_HOME="$HOME/.local/state"
fi
CAPACITY_ARCHIVE_DIR="${MAXIM_MONITOR_CAPACITY_ARCHIVE_DIR:-$CAPACITY_STATE_HOME/maxim/capacity-monitor}"
SUCCESSFUL_ACCESS_LOG_PATTERN='" (2[0-9][0-9]|3[0-9][0-9]) [0-9]+'
PUBLIC_URL="${PUBLIC_URL%/}"
ADMIN_PUBLIC_URL="${ADMIN_PUBLIC_URL%/}"

SERVICES=("${MAXIM_PRODUCTION_API_SERVICES[@]}")
STATIC_SERVICES=("miniapp-major-static" "admin-static")
LOG_SERVICES=("${SERVICES[@]}" "${STATIC_SERVICES[@]}")

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

run_step() {
  local label="$1"
  local status
  shift

  echo "--- $label ---"
  echo "monitor_step label=$label phase=start at=$(date -u +%FT%TZ)"
  set +e
  "$@"
  status=$?
  set -e
  SAMPLE_STEP_COUNT=$((SAMPLE_STEP_COUNT + 1))
  if ((status != 0)); then
    SAMPLE_STEP_FAILURES=$((SAMPLE_STEP_FAILURES + 1))
    echo "WARN: $label failed with exit code $status"
    echo "monitor_step label=$label phase=end exit=$status complete=false at=$(date -u +%FT%TZ)"
  else
    echo "monitor_step label=$label phase=end exit=0 complete=true at=$(date -u +%FT%TZ)"
  fi
  return 0
}

summarize_capacity_observability() {
  local archive_status=0
  local probe_status=0
  local snapshot

  snapshot="$(
    ./infra/scripts/vps-connect.sh exec node - "$CAPACITY_BLOCK_DEVICE" "${SERVICES[@]}" \
      <"$CAPACITY_PROBE"
  )" || probe_status=$?
  printf '%s\n' "$snapshot" |
    node "$CAPACITY_ARCHIVER" --archive-dir "$CAPACITY_ARCHIVE_DIR" || archive_status=$?
  if ((archive_status != 0)); then
    return "$archive_status"
  fi
  return "$probe_status"
}

sample_capacity_once() {
  echo "===== capacity sample $CAPACITY_SAMPLE_INDEX $(date -Is) ====="
  run_step capacity-observability summarize_capacity_observability
  CAPACITY_SAMPLE_INDEX=$((CAPACITY_SAMPLE_INDEX + 1))
}

read_capacity_owner_start_ticks() {
  local owner_pid="$1"
  local owner_stat
  local fields
  local -a owner_fields

  if ! is_positive_integer "$owner_pid" ||
    ! owner_stat="$(cat -- "/proc/$owner_pid/stat" 2>/dev/null)"; then
    return 1
  fi
  fields="${owner_stat##*) }"
  if [[ "$fields" == "$owner_stat" || "$owner_stat" != "$owner_pid ("* ]]; then
    return 1
  fi
  read -r -a owner_fields <<<"$fields"
  # FLAG: Field 22 follows the LAST comm delimiter; a reused PID or dead owner
  # cannot authorize further probes after the nominal diagnostic deadline.
  if ((${#owner_fields[@]} < 20)) ||
    [[ "${owner_fields[0]}" == "Z" || "${owner_fields[0]}" == "X" || "${owner_fields[0]}" == "x" ]] ||
    ! is_positive_integer "${owner_fields[19]}"; then
    return 1
  fi
  printf '%s\n' "${owner_fields[19]}"
}

run_capacity_sampler() {
  local monitor_pid="$1"
  local stop_at="$2"
  local lock_fd="$3"
  local owner_start_ticks="${MAXIM_MONITOR_CAPACITY_OWNER_START_TICKS:-}"
  local next_sample_at
  local now
  local sleep_for

  if ! is_positive_integer "$monitor_pid" || ! is_positive_integer "$stop_at" ||
    ! is_positive_integer "$lock_fd" || ! is_positive_integer "$owner_start_ticks" ||
    ! flock -n "$lock_fd"; then
    echo "Capacity sampler received an invalid owner or lock." >&2
    return 2
  fi

  next_sample_at=$(date +%s)
  while kill -0 "$monitor_pid" 2>/dev/null &&
    [[ "$(read_capacity_owner_start_ticks "$monitor_pid")" == "$owner_start_ticks" ]]; do
    now=$(date +%s)
    # FLAG: Diagnostics can outlive the nominal end. Keep sampling until the
    # owning monitor finishes; existing supervision and group cleanup still apply.
    if ((now < next_sample_at)); then
      sleep_for=$((next_sample_at - now))
      sleep "$sleep_for"
      continue
    fi

    sample_capacity_once
    next_sample_at=$((next_sample_at + CAPACITY_INTERVAL_SEC))
    now=$(date +%s)
    if ((next_sample_at <= now)); then
      next_sample_at=$((now + CAPACITY_INTERVAL_SEC))
    fi
  done
}

if [[ "${1:-}" == "--internal-capacity-sampler" ]]; then
  if [[ $# -ne 4 ]]; then
    echo "Capacity sampler invocation is invalid." >&2
    exit 2
  fi
  run_capacity_sampler "$2" "$3" "$4"
  exit $?
fi

cleanup_monitor_log() {
  if [[ -n "$MONITOR_LOG_FD" ]]; then
    exec {MONITOR_LOG_FD}>&-
  fi
  if [[ -n "$EPHEMERAL_LOG_DIR" ]]; then
    if [[ -f "$LOG_FILE" && ! -L "$LOG_FILE" ]]; then
      unlink -- "$LOG_FILE" 2>/dev/null || true
    fi
    rmdir -- "$EPHEMERAL_LOG_DIR" 2>/dev/null || true
  fi
}

cleanup_monitor() {
  local status=$?

  trap - EXIT HUP INT TERM
  if declare -F stop_monitor_worker >/dev/null 2>&1; then
    stop_monitor_worker
  fi
  if declare -F stop_capacity_sampler >/dev/null 2>&1; then
    stop_capacity_sampler
  fi
  if declare -F stop_monitor_output >/dev/null 2>&1; then
    stop_monitor_output || true
  fi
  cleanup_monitor_log
  return "$status"
}

prepare_monitor_log() {
  local created=0
  local log_directory
  local log_directory_mode
  local log_directory_owner
  local temp_root

  if [[ -z "$LOG_FILE" ]]; then
    temp_root="${TMPDIR:-/tmp}"
    if [[ "$temp_root" != /* || "$temp_root" =~ [[:cntrl:]] || ! -d "$temp_root" ]]; then
      echo "TMPDIR must identify an existing absolute directory." >&2
      return 1
    fi
    if ! EPHEMERAL_LOG_DIR="$(
      mktemp -d "$temp_root/maxim-vps-readonly-monitor-${UID}.XXXXXXXX"
    )"; then
      echo "Failed to create a private temporary monitor log directory." >&2
      return 1
    fi
    LOG_FILE="$EPHEMERAL_LOG_DIR/monitor.log"
  else
    if [[ "$LOG_FILE" != /* || "$LOG_FILE" =~ [[:cntrl:]] ]]; then
      echo "MAXIM_MONITOR_LOG must be an absolute path without control characters." >&2
      return 1
    fi
    log_directory="$(dirname -- "$LOG_FILE")"
    if [[ ! -d "$log_directory" || -L "$log_directory" ]]; then
      echo "MAXIM_MONITOR_LOG parent must be a real directory." >&2
      return 1
    fi
    log_directory_owner="$(stat -c '%u' -- "$log_directory" 2>/dev/null || true)"
    log_directory_mode="$(stat -c '%a' -- "$log_directory" 2>/dev/null || true)"
    if [[ "$log_directory_owner" != "$UID" || ! "$log_directory_mode" =~ ^[0-7]*00$ ]]; then
      echo "MAXIM_MONITOR_LOG parent must be owner-private and owned by the operator." >&2
      return 1
    fi
  fi

  # FLAG: The full monitor stream can contain identifiers that must never follow a symlink or be shared.
  set -o noclobber
  if exec {MONITOR_LOG_FD}>"$LOG_FILE"; then
    created=1
  fi
  set +o noclobber
  if ((created == 0)); then
    echo "Monitor log target already exists or cannot be created safely: $LOG_FILE" >&2
    return 1
  fi
}

trap cleanup_monitor EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! is_positive_integer "$DURATION_SEC"; then
  echo "DURATION_SEC must be a positive integer, got: $DURATION_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$INTERVAL_SEC"; then
  echo "INTERVAL_SEC must be a positive integer, got: $INTERVAL_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$CAPACITY_INTERVAL_SEC" ||
  ((CAPACITY_INTERVAL_SEC < 15 || CAPACITY_INTERVAL_SEC > 60)); then
  echo "MAXIM_MONITOR_CAPACITY_INTERVAL_SEC must be an integer between 15 and 60, got: $CAPACITY_INTERVAL_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$TAIL_LINES" || ((TAIL_LINES > 10000)); then
  echo "MAXIM_MONITOR_LOG_TAIL_LINES must be an integer between 1 and 10000, got: $TAIL_LINES" >&2
  exit 2
fi
LOG_REQUEST_LINES=$((TAIL_LINES + 1))

if ! is_positive_integer "$FAILED_FRESH_WINDOW_SEC"; then
  echo "MAXIM_MONITOR_FAILED_FRESH_WINDOW_SEC must be a positive integer, got: $FAILED_FRESH_WINDOW_SEC" >&2
  exit 2
fi

if ! is_positive_integer "$SIGNAL_WINDOW_MIN" || ((SIGNAL_WINDOW_MIN > 1440)); then
  echo "MAXIM_MONITOR_SIGNAL_WINDOW_MIN must be an integer between 1 and 1440, got: $SIGNAL_WINDOW_MIN" >&2
  exit 2
fi

if ! command -v flock >/dev/null 2>&1 || ! command -v setsid >/dev/null 2>&1; then
  echo "flock and setsid are required for readonly production monitoring" >&2
  exit 2
fi

if [[ ! "$CAPACITY_BLOCK_DEVICE" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "MAXIM_MONITOR_CAPACITY_BLOCK_DEVICE is invalid: $CAPACITY_BLOCK_DEVICE" >&2
  exit 2
fi

if [[ -z "$CAPACITY_ARCHIVE_DIR" || "$CAPACITY_ARCHIVE_DIR" != /* ]]; then
  echo "MAXIM_MONITOR_CAPACITY_ARCHIVE_DIR must be an absolute path." >&2
  exit 2
fi

for capacity_helper in "$CAPACITY_PROBE" "$CAPACITY_ARCHIVER"; do
  if [[ ! -r "$capacity_helper" ]]; then
    echo "Capacity observability helper is unavailable: $capacity_helper" >&2
    exit 2
  fi
done

# FLAG: Multiple full-fleet monitors amplify diagnostic load and can distort the system observed.
exec {MONITOR_LOCK_FD}>>"$MONITOR_LOCK_FILE"
if ! flock -n "$MONITOR_LOCK_FD"; then
  echo "Another readonly VPS monitor already holds $MONITOR_LOCK_FILE" >&2
  exit 3
fi

if ! prepare_monitor_log; then
  exit 2
fi

scan_service_logs() {
  local cursor_sec
  local lookback_sec
  local output
  local service_args
  local status
  local remote_command
  local since_at
  local since_epoch_sec

  if ((LAST_SERVICE_LOG_SCAN_AT_SEC > 0)); then
    since_epoch_sec=$((LAST_SERVICE_LOG_SCAN_AT_SEC - 5))
  else
    since_epoch_sec=$(($(date +%s) - INTERVAL_SEC))
  fi
  if ((since_epoch_sec < 0)); then since_epoch_sec=0; fi
  since_at=$(date -u -d "@$since_epoch_sec" '+%Y-%m-%dT%H:%M:%SZ')

  printf -v service_args '%q ' "${LOG_SERVICES[@]}"
  remote_command=$(cat <<REMOTE
scan_cursor_sec=\$(date +%s)
echo "monitor_service_log_cursor_sec=\$scan_cursor_sec"
services=($service_args)
failed=0
for service in "\${services[@]}"; do
  echo "-- \${service} --"
  if ! logs=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml \
    logs --since "$since_at" --tail "$LOG_REQUEST_LINES" "\$service" 2>/dev/null); then
    echo "WARN: could not read logs for \$service"
    failed=1
    continue
  fi
  raw_line_count=0
  if [[ -n "\$logs" ]]; then
    raw_line_count=\$(printf '%s\n' "\$logs" | wc -l | tr -d '[:space:]')
  fi
  if ((raw_line_count > $TAIL_LINES)); then
    echo "WARN: log scan saturated=true service=\$service raw_lines=\$raw_line_count limit=$TAIL_LINES"
  fi
  printf '%s\n' "\$logs" |
    grep -Eav '${SUCCESSFUL_ACCESS_LOG_PATTERN}' |
    grep -Eai '"level":(40|50)|"statusCode":(4[0-9][0-9]|5[0-9][0-9])|(^|[^[:alnum:]_])(error|warn|exception|failed|stalled|rate limit|ECONN|ETIMEDOUT|BullMQ|Redis)([^[:alnum:]_]|$)' |
    sed -E \
      -e "s#(https?://[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" \
      -e "s#((^|[[:space:]\":=])/(app|api)/[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" |
    tail -40 || true
done
exit "\$failed"
REMOTE
)

  if output="$(./infra/scripts/vps-connect.sh exec "$remote_command")"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$output"
  if ((status != 0)); then
    return "$status"
  fi
  cursor_sec="$(printf '%s\n' "$output" |
    sed -n 's/^monitor_service_log_cursor_sec=\([0-9][0-9]*\)$/\1/p' | head -1)"
  [[ "$cursor_sec" =~ ^[0-9]+$ ]] || return 1
  LAST_SERVICE_LOG_SCAN_AT_SEC="$cursor_sec"
  lookback_sec=$((cursor_sec - since_epoch_sec))
  echo "service_log_since=$since_at lookback_sec=$lookback_sec"
}

summarize_static_services() {
  local cursor_sec
  local lookback_sec
  local output
  local service_args
  local status
  local remote_command
  local since_at
  local since_epoch_sec

  if ((LAST_STATIC_LOG_SCAN_AT_SEC > 0)); then
    since_epoch_sec=$((LAST_STATIC_LOG_SCAN_AT_SEC - 5))
  else
    since_epoch_sec=$(($(date +%s) - INTERVAL_SEC))
  fi
  if ((since_epoch_sec < 0)); then since_epoch_sec=0; fi
  since_at=$(date -u -d "@$since_epoch_sec" '+%Y-%m-%dT%H:%M:%SZ')

  printf -v service_args '%q ' "${STATIC_SERVICES[@]}"
  remote_command=$(cat <<REMOTE
scan_cursor_sec=\$(date +%s)
echo "monitor_static_log_cursor_sec=\$scan_cursor_sec"
services=($service_args)
failed=0
for service in "\${services[@]}"; do
  echo "-- \${service} --"
  docker compose --env-file .env -p infra -f infra/docker-compose.yml ps "\$service" || true
  ids=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml ps -q "\$service" 2>/dev/null || true)
  if [[ -z "\$ids" ]]; then
    echo "WARN: no container found for \$service"
    failed=1
    continue
  fi

  if ! docker inspect --format '{{.Name}}\trestarts={{.RestartCount}}\tstatus={{.State.Status}}\tstarted={{.State.StartedAt}}{{if .State.Health}}\thealth={{.State.Health.Status}}{{else}}\thealth=none{{end}}' \$ids; then
    echo "WARN: could not inspect \$service"
    failed=1
    continue
  fi
  if ! logs=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml \
    logs --since "$since_at" --tail "$LOG_REQUEST_LINES" "\$service" 2>/dev/null); then
    echo "WARN: could not read logs for \$service"
    failed=1
    continue
  fi
  raw_line_count=0
  if [[ -n "\$logs" ]]; then
    raw_line_count=\$(printf '%s\n' "\$logs" | wc -l | tr -d '[:space:]')
  fi
  if ((raw_line_count > $TAIL_LINES)); then
    echo "WARN: log scan saturated=true service=\$service raw_lines=\$raw_line_count limit=$TAIL_LINES"
  fi
  printf '%s\n' "\$logs" |
    grep -Eav '${SUCCESSFUL_ACCESS_LOG_PATTERN}' |
    grep -Eai '(^|[^[:alnum:]_])(error|warn|exception|failed|502|503|504|upstream|permission|denied)([^[:alnum:]_]|$)' |
    sed -E \
      -e "s#(https?://[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" \
      -e "s#((^|[[:space:]\":=])/(app|api)/[^\"[:space:]]*)\\?[^\"[:space:]#]*#\\1?[redacted]#g" |
    tail -40 || true
done
exit "\$failed"
REMOTE
)

  if output="$(./infra/scripts/vps-connect.sh exec "$remote_command")"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$output"
  if ((status != 0)); then
    return "$status"
  fi
  cursor_sec="$(printf '%s\n' "$output" |
    sed -n 's/^monitor_static_log_cursor_sec=\([0-9][0-9]*\)$/\1/p' | head -1)"
  [[ "$cursor_sec" =~ ^[0-9]+$ ]] || return 1
  LAST_STATIC_LOG_SCAN_AT_SEC="$cursor_sec"
  lookback_sec=$((cursor_sec - since_epoch_sec))
  echo "static_log_since=$since_at lookback_sec=$lookback_sec"
}

summarize_public_app_assets() {
  local html
  local asset_lines
  local kind
  local url

  html="$(curl -fsSL --max-time 15 "$PUBLIC_URL/app/")"
  asset_lines="$(
    APP_HTML="$html" PUBLIC_URL="$PUBLIC_URL" node <<'NODE'
const html = process.env.APP_HTML ?? '';
const publicUrl = (process.env.PUBLIC_URL ?? 'https://major-maksimov.ru').replace(/\/+$/, '');
const base = new URL('/app/', `${publicUrl}/`);

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2] ?? '';
}

function absolute(value) {
  if (!value) {
    return '';
  }
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

const firstJs = (html.match(/<script\b[^>]*>/gi) ?? [])
  .map((tag) => absolute(attr(tag, 'src')))
  .find(Boolean);
const firstCss = (html.match(/<link\b[^>]*>/gi) ?? [])
  .map((tag) => ({ href: absolute(attr(tag, 'href')), rel: attr(tag, 'rel') }))
  .find((link) => link.href && /\bstylesheet\b/i.test(link.rel))?.href;

if (firstJs) {
  console.log(`js\t${firstJs}`);
} else {
  console.log('WARN\tmissing first JS asset in /app/ HTML');
}
if (firstCss) {
  console.log(`css\t${firstCss}`);
} else {
  console.log('WARN\tmissing first CSS asset in /app/ HTML');
}
NODE
  )"

  while IFS=$'\t' read -r kind url; do
    [[ -n "$kind" ]] || continue
    if [[ "$kind" == "WARN" ]]; then
      echo "WARN: $url"
      continue
    fi

    curl -fsSIL --max-time 15 -o /dev/null \
      -w "$kind %{http_code} %{content_type} %{url_effective}\n" \
      "$url"
  done <<<"$asset_lines"
}

summarize_public_access_guards() {
  local failed=0
  local path
  local status
  local url

  for path in /api/v1/safety-desk /api/v1/support-requests; do
    url="$PUBLIC_URL$path"
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || true)"
    status="${status:-000}"
    echo "public $path status=$status"
    case "$status" in
      401|403|404)
        ;;
      *)
        echo "WARN: public $path is not denied"
        failed=1
        ;;
    esac
  done

  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$ADMIN_PUBLIC_URL/" 2>/dev/null || true)"
  status="${status:-000}"
  echo "admin unauth / status=$status"
  if [[ "$status" != "401" ]]; then
    echo "WARN: admin root without credentials should return 401"
    failed=1
  fi

  return "$failed"
}

summarize_local_ready_health() {
  ./infra/scripts/vps-connect.sh exec 'node -' \
    < "$ROOT_DIR/infra/scripts/monitor-ready-status.cjs"
}

summarize_publisher_runtime() {
  local remote_command

  remote_command=$(cat <<'REMOTE'
set -o pipefail
compose=(docker compose --env-file .env -p infra -f infra/docker-compose.yml)
read_expected() {
  local service="$1"
  "${compose[@]}" exec -T "$service" node -e '
  const value = process.env.MAX_PUBLISHER_DISPATCH_ENABLED ?? "false";
  if (value !== "true" && value !== "false") process.exit(2);
  process.stdout.write(value);
'
}
read_bot_id() {
  local service="$1"
  "${compose[@]}" exec -T "$service" node -e '
  const value = (process.env.MAX_PUBLISHER_BOT_ID ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(value)) process.exit(2);
  process.stdout.write(value);
'
}
admin_expected="$(read_expected api-admin)" || exit 1
publisher_expected="$(read_expected api-publisher)" || exit 1
admin_bot_id="$(read_bot_id api-admin)" || exit 1
publisher_bot_id="$(read_bot_id api-publisher)" || exit 1
bot_id_parity=false
if [[ -n "$admin_bot_id" && "$admin_bot_id" == "$publisher_bot_id" ]]; then
  bot_id_parity=true
fi
control="$("${compose[@]}" exec -T api-admin node - status \
  < infra/scripts/publisher-dispatch-rollout-control.cjs)" || exit 1
printf '%s' "$control" |
  node infra/scripts/monitor-publisher-status.cjs \
    "$admin_expected" "$publisher_expected" "$bot_id_parity"
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_media_analysis_ready() {
  local remote_command
  local service_quoted

  printf -v service_quoted '%q' "$MAXIM_MEDIA_ANALYSIS_SERVICE"
  remote_command=$(cat <<REMOTE
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T \
  $service_quoted node - < infra/scripts/monitor-media-ready.cjs
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_real_chat_signals() {
  local output
  local status=0
  local collection_status=0

  output="$(./infra/scripts/vps-connect.sh exec \
    ./infra/scripts/vps-postgres-audit.sh monitor-signals "$SIGNAL_WINDOW_MIN")" || status=$?
  printf '%s\n' "$output"
  printf '%s\n' "$output" |
    node "$ROOT_DIR/infra/scripts/monitor-signal-results.cjs" "$status" || collection_status=$?
  if ((status != 0)); then
    return "$status"
  fi
  return "$collection_status"
}

summarize_bullmq_state() {
  local cursor_ms
  local output
  local probe_env
  local remote_command
  local status

  remote_command=$(cat <<'REMOTE'
queues=(
  moderation
  moderation-critical
  moderation-join-0
  moderation-join-1
  moderation-join-2
  moderation-join-3
  moderation-default-0
  moderation-default-1
  moderation-default-2
  moderation-default-3
  moderation-default-4
  moderation-default-5
  moderation-default-6
  moderation-default-7
  moderation-default-8
  moderation-default-9
  moderation-default-10
  moderation-default-11
  moderation-default-12
  moderation-default-13
  moderation-default-14
  moderation-default-15
  moderation-background
  moderation-default
  moderation-actions
  max-actions-critical
  max-actions-interactive
  max-actions-background
  night-mode-transitions
  moderation-delete-intents
  message-retention
  global-spammer-denorm
  photo-duplicates
  message-duplicates
  commercial-image-ocr
  admin-managed-entities-refresh
  max-chat-admin-roster-sync
  admin-suggestion-delivery
  admin-manual-fanout
  admin-super-ban
  publisher-binding-refresh
  publisher-chat-comments
  publisher-auto-replies
  publisher-auto-reply-authoring
  publisher-post-import
  publisher-publication-wakeup
  publisher-suggestion-publication
  publisher-suggestion-admin
  publisher-start
  publisher-video-upload
  marketplace-publisher-access
  vk-parsing-sync
  vk-parsing-publish
  vk-parsing-publisher
)
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T redis sh -lc '
minimum_failed_fresh_window_sec="$1"
previous_probe_at_ms="$2"
shift 2
queue_counts_script="
local redisTime = redis.call(\"TIME\")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local failedFreshWindowSec = tonumber(ARGV[1])
local previousProbeAtMs = tonumber(ARGV[2])
if previousProbeAtMs and previousProbeAtMs > 0 and nowMs >= previousProbeAtMs then
  local elapsedWindowSec = math.ceil((nowMs - previousProbeAtMs) / 1000) + 5
  failedFreshWindowSec = math.max(failedFreshWindowSec, elapsedWindowSec)
end
local failedFreshCutoffMs = nowMs - failedFreshWindowSec * 1000
local dueScore = nowMs * 4096 + 4095
local function listCountWithoutMarker(key)
  local count = redis.call(\"LLEN\", key)
  local marker = redis.call(\"LINDEX\", key, -1)
  if marker and string.sub(marker, 1, 2) == \"0:\" then
    return math.max(0, count - 1)
  end
  return count
end
local waiting = listCountWithoutMarker(KEYS[1]) + listCountWithoutMarker(KEYS[2])
local prioritized = redis.call(\"ZCARD\", KEYS[3])
local active = redis.call(\"LLEN\", KEYS[4])
local failed = redis.call(\"ZCARD\", KEYS[5])
local failedFresh = redis.call(\"ZCOUNT\", KEYS[5], failedFreshCutoffMs, nowMs)
local failedFuture = redis.call(\"ZCOUNT\", KEYS[5], \"(\" .. tostring(nowMs), \"+inf\")
local newestFailed = redis.call(\"ZREVRANGE\", KEYS[5], 0, 0, \"WITHSCORES\")
local failedNewestAgeSec = -1
if newestFailed[2] then
  local newestFailedAtMs = tonumber(newestFailed[2])
  if newestFailedAtMs and nowMs then
    failedNewestAgeSec = math.max(0, math.floor((nowMs - newestFailedAtMs) / 1000))
  end
end
local delayed = redis.call(\"ZCARD\", KEYS[6])
local dueNow = redis.call(\"ZCOUNT\", KEYS[6], \"-inf\", dueScore)
return string.format(
  \"observedAtMs=%d\\nwait=%d\\nprioritized=%d\\nactive=%d\\nfailedTotal=%d\\nfailedFresh=%d\\nfailedFreshWindowSec=%d\\nfailedFuture=%d\\nfailedNewestAgeSec=%d\\ndelayed=%d\\ndueNow=%d\",
  nowMs,
  waiting,
  prioritized,
  active,
  failed,
  failedFresh,
  failedFreshWindowSec,
  failedFuture,
  failedNewestAgeSec,
  delayed,
  dueNow
)
"
validate_counts() {
  awk -F= '\''
    BEGIN {
      expected["observedAtMs"] = 1
      expected["wait"] = 1
      expected["prioritized"] = 1
      expected["active"] = 1
      expected["failedTotal"] = 1
      expected["failedFresh"] = 1
      expected["failedFreshWindowSec"] = 1
      expected["failedFuture"] = 1
      expected["failedNewestAgeSec"] = 1
      expected["delayed"] = 1
      expected["dueNow"] = 1
    }
    NF != 2 || !($1 in expected) || seen[$1] { exit 1 }
    $1 == "failedNewestAgeSec" {
      if ($2 !~ /^-?[0-9]+$/) exit 1
      seen[$1] = 1
      next
    }
    $2 !~ /^[0-9]+$/ { exit 1 }
    { seen[$1] = 1 }
    END {
      if (NR != 11) exit 1
      for (key in expected) if (!(key in seen)) exit 1
    }
  '\''
}
failed=0
probe_cursor_ms=""
for q in "$@"; do
  if ! counts="$(redis-cli --raw eval "$queue_counts_script" 6 \
    "bull:$q:wait" \
    "bull:$q:paused" \
    "bull:$q:prioritized" \
    "bull:$q:active" \
    "bull:$q:failed" \
    "bull:$q:delayed" \
    "$minimum_failed_fresh_window_sec" \
    "$previous_probe_at_ms" 2>/dev/null)"; then
    printf "%s counts=unavailable\n" "$q"
    failed=1
    continue
  fi
  if ! printf "%s\n" "$counts" | validate_counts; then
    printf "%s counts=unavailable\n" "$q"
    failed=1
    continue
  fi
  observed_at_ms="$(printf "%s\n" "$counts" | sed -n "s/^observedAtMs=//p")"
  if [ -z "$probe_cursor_ms" ]; then probe_cursor_ms="$observed_at_ms"; fi
  while IFS= read -r count; do
    case "$count" in observedAtMs=*) continue ;; esac
    printf "%s %s\n" "$q" "$count"
  done <<EOF
$counts
EOF
done
if [ "$failed" -ne 0 ] || [ -z "$probe_cursor_ms" ]; then exit 1; fi
printf "monitor_bullmq_cursor_ms=%s\n" "$probe_cursor_ms"
' sh "$minimum_failed_fresh_window_sec" "$previous_probe_at_ms" "${queues[@]}"
REMOTE
)
  printf -v probe_env \
    'minimum_failed_fresh_window_sec=%q\nprevious_probe_at_ms=%q\n' \
    "$FAILED_FRESH_WINDOW_SEC" "$LAST_BULLMQ_PROBE_AT_MS"
  remote_command="$probe_env$remote_command"

  if output="$(./infra/scripts/vps-connect.sh exec "$remote_command")"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$output"
  if ((status != 0)); then
    return "$status"
  fi
  cursor_ms="$(printf '%s\n' "$output" |
    sed -n 's/^monitor_bullmq_cursor_ms=\([0-9][0-9]*\)$/\1/p' | head -1)"
  [[ "$cursor_ms" =~ ^[0-9]+$ ]] || return 1
  LAST_BULLMQ_PROBE_AT_MS="$cursor_ms"
}

summarize_redis_runtime() {
  local remote_command

  remote_command=$(cat <<'REMOTE'
set -o pipefail
docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T redis \
  redis-cli --raw INFO all |
  node infra/scripts/monitor-redis-info.cjs
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_runtime_pressure() {
  local disk_capacity_env
  local remote_command

  printf -v disk_capacity_env 'MAXIM_API_BUILD_HARD_MIN_FREE_BYTES=%q\n' \
    "$MAXIM_API_BUILD_HARD_MIN_FREE_BYTES"
  remote_command=$(cat <<'REMOTE'
echo "uptime"
uptime || true
echo "memory"
free -m || true
echo "disk"
df -h / /var/lib/docker 2>/dev/null || df -h / || true
disk_path="/var/lib/docker"
if [[ ! -d "$disk_path" ]]; then
  disk_path="/"
fi
deploy_disk_hard_minimum_free_bytes="$MAXIM_API_BUILD_HARD_MIN_FREE_BYTES"
disk_stats="$(df -P -B1 "$disk_path" 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $5); print $4, $5 }')"
read -r disk_available_bytes disk_used_percent <<< "$disk_stats"
if [[ "$disk_available_bytes" =~ ^[0-9]+$ && "$disk_used_percent" =~ ^[0-9]+$ ]]; then
  if (( disk_available_bytes < deploy_disk_hard_minimum_free_bytes )); then
    printf "API_BUILD_DISK_BLOCKED path=%s available=%sB minimum-free=%sB\n" \
      "$disk_path" "$disk_available_bytes" "$deploy_disk_hard_minimum_free_bytes"
  fi
  if (( disk_used_percent >= 90 )); then
    printf "DISK_CRITICAL path=%s used=%s%% threshold=90%%\n" "$disk_path" "$disk_used_percent"
  elif (( disk_used_percent >= 80 )); then
    printf "DISK_WARNING path=%s used=%s%% threshold=80%%\n" "$disk_path" "$disk_used_percent"
  else
    printf "DISK_OK path=%s used=%s%% warning=80%% critical=90%%\n" "$disk_path" "$disk_used_percent"
  fi
else
  printf "DISK_UNKNOWN path=%s reason=invalid-df-output\n" "$disk_path"
fi
echo "docker_stats"
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}' 2>/dev/null |
  grep -E '^infra-(api|postgres|redis|miniapp|admin)' |
  sort || true
if command -v iostat >/dev/null 2>&1; then
  echo "iostat"
  iostat -x 1 2 | tail -40 || true
fi
REMOTE
)
  remote_command="$disk_capacity_env$remote_command"

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

summarize_log_signal_counts() {
  local service_args
  local remote_command

  printf -v service_args '%q ' "${LOG_SERVICES[@]}"
  remote_command=$(cat <<REMOTE
services=($service_args)
failed=0
printf "service\\tlevel40_50\\trate_limit\\tskipped_perm\\taccess_loss\\tstatus403\\ttimeout\\tgovernor\\tslow\\tledger\\tpg_warn\\tread_status\\ttruncated\\tsampled_lines\\tcounts_are_lower_bounds\\n"
for service in "\${services[@]}"; do
  if ! logs=\$(docker compose --env-file .env -p infra -f infra/docker-compose.yml logs --since "${SIGNAL_WINDOW_MIN}m" --tail "$((TAIL_LINES + 1))" "\$service" 2>/dev/null); then
    printf '%s\\tunknown\\tunknown\\tunknown\\tunknown\\tunknown\\tunknown\\tunknown\\tunknown\\tunknown\\tunknown\\tread_failed\\tunknown\\tunknown\\tunknown\\n' "\$service"
    failed=1
    continue
  fi
  sampled_lines=0
  if [[ -n "\$logs" ]]; then
    sampled_lines=\$(printf '%s\\n' "\$logs" | wc -l)
  fi
  truncated=false
  if ((sampled_lines > $TAIL_LINES)); then
    truncated=true
    sampled_lines=$TAIL_LINES
    logs=\$(printf '%s\\n' "\$logs" | tail -n "$TAIL_LINES")
  fi
  count() { printf "%s" "\$logs" | grep -Eci "\$1" || true; }
  printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\tcollected\\t%s\\t%s\\t%s\\n" \\
    "\$service" \\
    "\$(count '"level":(40|50)')" \\
    "\$(count 'rate[ _-]?limit|internal limiter|"statusCode":429|HTTP( status)? 429')" \\
    "\$(count 'no active bot has the required MAX permissions|Skipped moderation action')" \\
    "\$(count 'ManagedEntityAccessLossService|chat_not_found|chat.denied|BOT_DENIED|access loss')" \\
    "\$(count 'status code 403|"statusCode":403')" \\
    "\$(count 'ETIMEDOUT|timeout|timed out|ECONN')" \\
    "\$(count 'BackgroundRuntimeGovernor|governor|pause|slow path')" \\
    "\$(count 'slow|Slow')" \\
    "\$(count 'Failed to record successful MAX action ledger outcome|delivery-ledger-risk|ambiguous MAX')" \\
    "\$(count 'client.query\\(\\) on a client that has already been checked out')" \\
    "\$truncated" "\$sampled_lines" "\$truncated"
done
exit "\$failed"
REMOTE
)

  ./infra/scripts/vps-connect.sh exec "$remote_command"
}

sample_once() {
  local sample_index="$1"
  local complete=false

  SAMPLE_STEP_COUNT=0
  SAMPLE_STEP_FAILURES=0

  echo "===== sample $sample_index $(date -Is) ====="
  run_step health ./infra/scripts/vps-connect.sh health
  run_step semantic-health summarize_local_ready_health
  run_step publisher-runtime summarize_publisher_runtime
  run_step media-analysis-ready summarize_media_analysis_ready
  run_step real-chat-signals summarize_real_chat_signals
  run_step bullmq-state summarize_bullmq_state
  run_step redis-runtime summarize_redis_runtime
  run_step runtime-pressure summarize_runtime_pressure
  run_step ps ./infra/scripts/vps-connect.sh ps
  run_step static-services summarize_static_services
  # Command substitutions and $ids are intentionally evaluated by the remote shell.
  # shellcheck disable=SC2016
  run_step restart-counts ./infra/scripts/vps-connect.sh exec \
    'ids=$(docker ps -q --filter label=com.docker.compose.project=infra); docker inspect --format "{{.Name}}\t{{.RestartCount}}\t{{.State.Status}}\t{{.State.StartedAt}}" $ids'
  run_step log-signal-counts summarize_log_signal_counts
  run_step log-scan scan_service_logs
  run_step public-app curl -fsS --max-time 15 -o /dev/null -w 'app %{http_code} %{time_total}\n' \
    "$PUBLIC_URL/app/"
  run_step public-app-assets summarize_public_app_assets
  run_step public-access-guards summarize_public_access_guards
  if ((SAMPLE_STEP_COUNT == EXPECTED_SAMPLE_STEPS && SAMPLE_STEP_FAILURES == 0)); then
    complete=true
  fi
  echo "monitor_sample index=$sample_index steps=$SAMPLE_STEP_COUNT expected_steps=$EXPECTED_SAMPLE_STEPS failed_steps=$SAMPLE_STEP_FAILURES complete=$complete at=$(date -u +%FT%TZ)"
}

run_monitor() {
  local end_at="$1"
  local sample_index=0

  echo "Readonly VPS monitor started at $(date -Is)"
  echo "duration_sec=$DURATION_SEC interval_sec=$INTERVAL_SEC log_tail_lines=$TAIL_LINES"
  echo "capacity_interval_sec=$CAPACITY_INTERVAL_SEC"
  echo "signal_window_min=$SIGNAL_WINDOW_MIN"
  echo "log_file=$LOG_FILE"
  echo "capacity_archive_dir=$CAPACITY_ARCHIVE_DIR retention_days=14"

  while true; do
    sample_once "$sample_index"
    sample_index=$((sample_index + 1))

    local now
    local sleep_for
    now=$(date +%s)
    sleep_for=$((end_at - now))
    if ((sleep_for <= 0)); then
      break
    fi
    if ((sleep_for > INTERVAL_SEC)); then sleep_for=$INTERVAL_SEC; fi
    sleep "$sleep_for"
  done

  echo "Readonly VPS monitor finished at $(date -Is)"
}

start_capacity_sampler() {
  local monitor_pid="$BASHPID"
  local stop_at="$1"
  local owner_start_ticks

  if ! owner_start_ticks="$(read_capacity_owner_start_ticks "$monitor_pid")"; then
    echo "Capacity sampler could not identify its owner generation." >&2
    return 2
  fi
  exec {CAPACITY_SAMPLER_LOCK_FD}>>"$CAPACITY_SAMPLER_LOCK_FILE"
  if ! flock -n "$CAPACITY_SAMPLER_LOCK_FD"; then
    exec {CAPACITY_SAMPLER_LOCK_FD}>&-
    CAPACITY_SAMPLER_LOCK_FD=""
    echo "Another capacity sampler already holds $CAPACITY_SAMPLER_LOCK_FILE" >&2
    return 3
  fi

  (
    # The sampler must not keep the full-monitor lock alive if its owner exits abruptly.
    exec {MONITOR_LOCK_FD}>&-
    MAXIM_MONITOR_CAPACITY_OWNER_START_TICKS="$owner_start_ticks" \
      exec setsid "$ROOT_DIR/infra/scripts/vps-monitor-readonly.sh" \
      --internal-capacity-sampler "$monitor_pid" "$stop_at" "$CAPACITY_SAMPLER_LOCK_FD"
  ) &
  CAPACITY_SAMPLER_PID=$!
}

stop_capacity_sampler() {
  local live_sampler=0
  local sampler_pid="${CAPACITY_SAMPLER_PID:-}"
  local running_pid

  CAPACITY_SAMPLER_PID=""
  if [[ "$sampler_pid" =~ ^[1-9][0-9]*$ && "$sampler_pid" != "$BASHPID" ]]; then
    while IFS= read -r running_pid; do
      if [[ "$running_pid" == "$sampler_pid" ]]; then
        live_sampler=1
        break
      fi
    done < <(jobs -pr)
    if ((live_sampler == 1)); then
      kill -TERM -- "-$sampler_pid" 2>/dev/null || kill -TERM "$sampler_pid" 2>/dev/null || true
    fi
    wait "$sampler_pid" 2>/dev/null || true
  fi
  if [[ -n "${CAPACITY_SAMPLER_LOCK_FD:-}" ]]; then
    exec {CAPACITY_SAMPLER_LOCK_FD}>&-
    CAPACITY_SAMPLER_LOCK_FD=""
  fi
}

start_monitor_worker() {
  local stop_at="$1"

  # Job control gives the diagnostic worker and all of its commands an isolated process group.
  set -m
  (
    trap - EXIT HUP INT TERM
    exec {MONITOR_LOCK_FD}>&-
    if [[ -n "${CAPACITY_SAMPLER_LOCK_FD:-}" ]]; then
      exec {CAPACITY_SAMPLER_LOCK_FD}>&-
    fi
    run_monitor "$stop_at"
  ) &
  MONITOR_WORKER_PID=$!
  set +m
}

stop_monitor_worker() {
  local live_worker=0
  local running_pid
  local worker_pid="${MONITOR_WORKER_PID:-}"

  MONITOR_WORKER_PID=""
  if [[ "$worker_pid" =~ ^[1-9][0-9]*$ && "$worker_pid" != "$BASHPID" ]]; then
    while IFS= read -r running_pid; do
      if [[ "$running_pid" == "$worker_pid" ]]; then
        live_worker=1
        break
      fi
    done < <(jobs -pr)
    if ((live_worker == 1)); then
      kill -TERM -- "-$worker_pid" 2>/dev/null || kill -TERM "$worker_pid" 2>/dev/null || true
    fi
    wait "$worker_pid" 2>/dev/null || true
  fi
}

start_monitor_output() {
  exec > >(
    trap - EXIT HUP INT TERM
    exec {MONITOR_LOCK_FD}>&-
    exec tee -a "/dev/fd/$MONITOR_LOG_FD"
  ) 2>&1
  MONITOR_TEE_PID=$!
}

stop_monitor_output() {
  local status=0
  local tee_pid="${MONITOR_TEE_PID:-}"

  MONITOR_TEE_PID=""
  if [[ "$tee_pid" =~ ^[1-9][0-9]*$ && "$tee_pid" != "$BASHPID" ]]; then
    exec 1>&- 2>&-
    if wait "$tee_pid" 2>/dev/null; then
      status=0
    else
      status=$?
    fi
  fi
  return "$status"
}

run_monitor_with_capacity_sampler() {
  local end_at
  local status

  end_at=$(($(date +%s) + DURATION_SEC))
  if start_capacity_sampler "$end_at"; then
    :
  else
    status=$?
    return "$status"
  fi
  if start_monitor_worker "$end_at"; then
    :
  else
    status=$?
    stop_capacity_sampler
    return "$status"
  fi
  if wait "$MONITOR_WORKER_PID"; then
    status=0
  else
    status=$?
  fi
  MONITOR_WORKER_PID=""
  stop_capacity_sampler
  return "$status"
}

start_monitor_output
if run_monitor_with_capacity_sampler; then
  MONITOR_STATUS=0
else
  MONITOR_STATUS=$?
fi
if stop_monitor_output; then
  :
else
  OUTPUT_STATUS=$?
  if ((MONITOR_STATUS == 0)); then MONITOR_STATUS=$OUTPUT_STATUS; fi
fi
exit "$MONITOR_STATUS"
