#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# FLAG: Refuse quarantined recovery arguments locally before loading credentials,
# invoking GitHub/SSH, or beginning any production transition. No env override exists.
for argument in "$@"; do
  case "$argument" in
    --legacy-order-preview|--legacy-order-preview=*|--legacy-order-apply|--legacy-order-apply=*)
      echo "Legacy cold recovery activation is disabled (cold_activation_disabled)." >&2
      exit 2
      ;;
  esac
done

# shellcheck source=infra/scripts/lib/deploy-git-transport.sh
source "$ROOT_DIR/infra/scripts/lib/deploy-git-transport.sh"

export YC_CLI_INITIALIZATION_SILENCE="${YC_CLI_INITIALIZATION_SILENCE:-true}"

ENV_FILE="${MAXIM_VPS_ENV_FILE:-$ROOT_DIR/.env.vps}"
readonly SCALE_ENV_FILE_FROM_CALLER="${MAXIM_VPS_ENV_FILE:-}"
DATABASE_BREAK_GLASS_FROM_CALLER="${MAXIM_VPS_DATABASE_BREAK_GLASS:-}"
DATABASE_BREAK_GLASS_REASON_FROM_CALLER="${MAXIM_VPS_DATABASE_BREAK_GLASS_REASON:-}"
DEPLOY_DISK_MIN_FREE_BYTES_FROM_CALLER="${MAXIM_DEPLOY_DISK_MIN_FREE_BYTES:-}"
DEPLOY_API_READY_TIMEOUT_SEC_FROM_CALLER="${MAXIM_DEPLOY_API_READY_TIMEOUT_SEC:-}"
PAIR_RELEASE_EXPECTED_STATE_FROM_CALLER="${PAIR_RELEASE_EXPECTED_STATE_SHA256:-}"
readonly MESSAGE_RETENTION_MODE_FROM_CALLER="${MAXIM_MESSAGE_RETENTION_MODE:-}"
readonly COMMERCIAL_AI_FROM_CALLER="${MAXIM_COMMERCIAL_LLM_ENFORCEMENT:-}"
readonly COMMERCIAL_AI_POOL_WORKERS_FROM_CALLER="${MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED:-}"
readonly COMMERCIAL_AI_POOL_FROM_CALLER="${MAXIM_COMMERCIAL_LLM_POOL_ENABLED:-}"
readonly COMMERCIAL_AI_POOL_4B_POLICY_FROM_CALLER="${MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY:-}"
readonly COMMERCIAL_OCR_OFF_FROM_CALLER="${MAXIM_COMMERCIAL_OCR_OFF:-0}"
readonly STATISTICS_EXCHANGE_V3_FROM_CALLER="${STATISTICS_EXCHANGE_V3_ENABLED:-}"
readonly STATISTICS_CENTRAL_EPOCH_FROM_CALLER="${MAXIM_STATISTICS_CENTRAL_EPOCH:-}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

MAXIM_COMMERCIAL_OCR_OFF="$COMMERCIAL_OCR_OFF_FROM_CALLER"
MAXIM_COMMERCIAL_LLM_ENFORCEMENT="$COMMERCIAL_AI_FROM_CALLER"
MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED="$COMMERCIAL_AI_POOL_WORKERS_FROM_CALLER"
MAXIM_COMMERCIAL_LLM_POOL_ENABLED="$COMMERCIAL_AI_POOL_FROM_CALLER"
MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY="$COMMERCIAL_AI_POOL_4B_POLICY_FROM_CALLER"
MAXIM_MESSAGE_RETENTION_MODE="$MESSAGE_RETENTION_MODE_FROM_CALLER"
STATISTICS_EXCHANGE_V3_ENABLED="$STATISTICS_EXCHANGE_V3_FROM_CALLER"
MAXIM_STATISTICS_CENTRAL_EPOCH="$STATISTICS_CENTRAL_EPOCH_FROM_CALLER"
PAIR_RELEASE_EXPECTED_STATE_SHA256="$PAIR_RELEASE_EXPECTED_STATE_FROM_CALLER"

readonly SCALE_SSH_TARGET_FROM_PROFILE="${MAXIM_VPS_SSH_TARGET:-}"
readonly SCALE_REPO_DIR_FROM_PROFILE="${MAXIM_VPS_REPO_DIR:-}"
readonly SCALE_PUBLIC_URL_FROM_PROFILE="${MAXIM_VPS_PUBLIC_URL:-}"
MAXIM_VPS_SSH_TARGET="${MAXIM_VPS_SSH_TARGET:-maxim-vps}"
MAXIM_VPS_REPO_DIR="${MAXIM_VPS_REPO_DIR:-/var/www/Chat_bot}"
MAXIM_VPS_PUBLIC_URL="${MAXIM_VPS_PUBLIC_URL:-https://major-maksimov.ru}"

usage() {
  cat <<'USAGE'
Usage:
  ./infra/scripts/vps-connect.sh <command> [args...]

Commands:
  doctor                      Check local SSH config and remote VPS basics
  shell                       Break-glass interactive shell; requires flag and reason
  exec <command...>           Run a command in the remote repo
  deploy [branch] [services|--plan|--auto|--full]
                              Run or plan a manifest-aware production deploy
  finalize-release-recovery [branch] [--runtime-sha <sha>] [--api-only]
                              Prove an exact runtime and finalize its interrupted manifest
  install-deploy-flock <old-sha>  Install reviewed lock tooling under both protocols
  pair-release-state            Read bounded Major/Karavan release identities and fingerprint
  install-pair-release-admission <major-sha> <karavan-local-repo> <karavan-sha> [operator-user]
                                Provision the shared admission during its reviewed upgrade window
  verify-pair-release-admission [operator-user]
                                Verify installed admission and both synchronized sources
  reconcile-pair-release-admission <owner-hash> <state-hash> <major|karavan> <target-sha> <runtime|tooling> [components]
                                Archive one proved completed, interrupted admission
  recover-pair-backup-refusal preview|apply <reviewed identity flags>
                                Archive the exact unwritten root backup admission refusal
  recover-pair-backup-activation preview|apply <reviewed identity flags>
                                Prove and archive the interrupted backup unit installation
  legacy-cold-recovery <private-request.json>
                              Inspect or apply an exact journal-bound legacy recovery
  source-abandonment <private-request.json>
                              Discard an exact modern source without member-wide holds
  cancel-webhook-backlog <private-request.json>
                              Cancel pre-cutoff processing in one stopped-fleet operation
  preview-webhook-backlog <private-nomination.json>
                              Inspect exact old sources without stopping or changing work
  source-abandonment-corrective <private-envelope.json>
                              Continue reviewed recovery with an exact green controller
  eraser-bootstrap <private-request.json>|--stores-only
  eraser-webhook
  eraser-nginx [--apply]       Preview or apply only Lastik routes in the existing nginx site
  preload-ci-image <component> [git-ref]
                              Pull a proven exact-SHA GHCR image into the VPS
  commercial-llm install|replace|upgrade-slots|enable|disable|stop [--apply]
  commercial-llm recover-cpu-quarantine <operation-uuid> [--apply <preview-sha256>]
  commercial-llm status|smoke|check-client|check-workstation|check-workstation-offline
  commercial-llm workstation-bridge
  commercial-llm workstation-pool-bridge pc-a-4b|pc-b-9b
                              Inspect the model or run closed transport/client probes
  deploy-scale [branch] [...] Run only on an explicitly identified isolated test host.
                              Requires a separate profile file and MAXIM_ALLOW_SCALE_DEPLOY=1.
  rollback-runtime <ref> [...] Rebuild/recreate API roles from a previous git ref
  rollback-release <release-id> [components...]
                              Recreate immutable API/miniapp/admin release images
  allow-ssh-current-ip [sg]  Add current public IP/32 to the Yandex Cloud SSH security group
  ensure-ssh [sg]            Allow current public IP, then run doctor
  health                      Check local-on-VPS and public health endpoints
  support-chat preview        Verify exact test-chat type, assigned bot and access without posting
  monitor-readonly [duration-sec] [interval-sec]
                              Sample health, ps, restarts, public app, and error logs
  postgres-audit [queue|activity|duplicate|publication-schema|storage|all]
  postgres-audit queue [--explain]
  postgres-audit legacy-order-candidates
  postgres-audit moderation-outcomes [--bot <bot-id>] [--explain]
  postgres-audit delete-retry-heads [--explain]
  postgres-audit chat-message-window <chat-id> <UTC-minute> [--slice <0..11>] [--explain]
  postgres-audit webhook-cohort [--short] [--explain]
  postgres-audit webhook-cohort --failed-window <UTC-minute> <UTC-minute> [--explain]
  postgres-audit webhook-recovery-key-cohort <UTC-second> <private-chat-ID-CSV> [--explain]
  postgres-audit webhook-workload [--explain]
  postgres-audit duplicate [--status <STATUS>] [--explain]
  postgres-audit poll-publication <poll-id> [--explain]
  postgres-audit webhook-quarantine <UTC-minute> [--explain]
  postgres-audit webhook-quarantine-proof <UTC-minute> [--explain] [--private-blocker-ids]
  postgres-audit rules-cleanup <chat-id> [--explain]
  postgres-audit publisher-comments <chat-id> [--explain]
  postgres-audit publisher-publications [--explain]
  postgres-audit publisher-slots <actor> <chat> <UTC-minute> [--explain]
  postgres-audit publisher-slots --target <chat> <UTC-minute> [--explain]
  postgres-audit publisher-access-census [--explain]
  postgres-audit storage [--explain]
  postgres-audit multibot-preparation [--explain]
  postgres-audit webhook-owner-proof [--explain]
  postgres-audit webhook-held-receipt [receipt-id] [--explain]
  postgres-audit webhook-source-proof [--explain]
  postgres-audit webhook-source-envelope <owner-receipt-id> [--explain]
  postgres-audit webhook-retry-proof [--explain]
  postgres-audit webhook-queued-proof [--explain]
  postgres-audit commercial-quality [--explain]
  postgres-audit network-statistics <negative-chat-ID-CSV, max 12> [--observations] [--membership=7d|30d] [--explain]
  postgres-audit statistics-exchange <exact-actor-id> [--explain]
  postgres-audit karavan-candidates [--after settings-id] [--limit 1..40] [--explain]
  postgres-audit central-statistics <negative-chat-ID-CSV, max 12> [--explain]
  recover-publication-post-actions-migration [--apply]
  recover-publication-priority-migration [--apply]
  recover-publisher-catalog-migration [--apply]
  recover-message-retention-migration [--apply]
  recover-multibot-preparation <reviewed-attempt-options> [--apply]
  recover-publisher-access-migration [--apply]
  recover-suggestion-subscription-migration [--apply]
                              Run fixed, bounded, privacy-safe PostgreSQL diagnostics
  postgres-audit-provision [--apply]
                              Preview or provision the dedicated PostgreSQL audit role
  commercial-ocr-promote <chat-ids-file> <certification-file> <reviewed-certification-sha256> <none|revision> [--apply]
                              Guarded OCR canary promotion; uploads private inputs via stdin
  commercial-ocr-downgrade <revision> [--apply]
                              Clear OCR runtime authority, then restore shadow ceilings
  commercial-ocr-status       Read privacy-safe OCR runtime-control status
  commercial-ocr-recover-shadow [--apply]
                              Quiesce enforcement and reconcile every API role to shadow
  publisher-dispatch-enable [--apply]
                              Preview or enable Publik dispatch across all shared API roles
  publisher-dispatch-disable [--apply]
                              Preview or fail-closed disable Publik dispatch
  publisher-dispatch-status   Read privacy-safe Publik dispatch rollout status
  publisher-obsolete-retirement [preview [--after-digest <sha256>]]
  publisher-obsolete-retirement apply --reviewed-digest <sha256>
                              Retire reviewed obsolete untouched scheduled deliveries
  publisher-obsolete-retirement stop-preview [--after-digest <sha256>]
  publisher-obsolete-retirement stop-apply --reviewed-digest <sha256>
                              Stop reviewed obsolete dispatch intents; preserve delivery evidence
  publisher-selection-rollout <off|test|5|25|100> [--apply]
  major-networks-rollout <off|test|on> [--apply]
  publisher-rollup-noop-rollout <off|test|5|25|100> [--apply]
                              Preview or change selection stage without changing dispatch
  vk-parsing-retire-legacy-queue [--apply [--reviewed-digest <sha256>]]
                              Preview or remove the retired vk-parsing-publish queue
  fixed-moderator-preservation explain <chat-id>
  fixed-moderator-preservation preview [limit [after]]
  fixed-moderator-preservation apply <private-0600-plan.json> <reviewed-sha256>
  moderation-default-retire-legacy-queue [--apply]
                              Preview or remove the retired unsharded webhook queue
  install-publisher-secrets [token-file]
                              Install initial Publik credentials over SSH stdin
  ps [services...]            Show main production docker compose status
  logs <service> [tail]       Show main production service logs, default tail=200
  yc-shell                    Break-glass Yandex CLI shell; requires flag and reason

Per-device config:
  cp infra/env/vps.env.example .env.vps
  edit .env.vps
  ./infra/scripts/vps-connect.sh doctor
USAGE
}

expand_path() {
  local value="$1"

  case "$value" in
    "~") printf '%s' "$HOME" ;;
    \~/*) printf '%s/%s' "$HOME" "${value#\~/}" ;;
    *) printf '%s' "$value" ;;
  esac
}

shell_quote_args() {
  local arg
  local quoted

  for arg in "$@"; do
    printf -v quoted '%q' "$arg"
    printf '%s ' "$quoted"
  done
}

ssh_args() {
  local args=(
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=3
  )
  local extra_args=()

  if [[ -n "${MAXIM_VPS_SSH_PORT:-}" ]]; then
    args+=(-p "$MAXIM_VPS_SSH_PORT")
  fi

  if [[ -n "${MAXIM_VPS_SSH_KEY:-}" ]]; then
    args+=(-i "$(expand_path "$MAXIM_VPS_SSH_KEY")")
  fi

  if [[ -n "${MAXIM_VPS_SSH_CONFIG:-}" ]]; then
    args+=(-F "$(expand_path "$MAXIM_VPS_SSH_CONFIG")")
  fi

  if [[ -n "${MAXIM_VPS_SSH_EXTRA_ARGS:-}" ]]; then
    # Split simple whitespace-separated extra args. Keep complex SSH options in
    # ~/.ssh/config when quoting is required.
    read -r -a extra_args <<<"$MAXIM_VPS_SSH_EXTRA_ARGS"
    args+=("${extra_args[@]}")
  fi

  printf '%s\0' "${args[@]}"
}

yc_args() {
  local args=()

  if [[ -n "${MAXIM_YC_PROFILE:-}" ]]; then
    args=(--profile "$MAXIM_YC_PROFILE")
  fi

  printf '%s\0' "${args[@]}"
}

detect_public_ipv4() {
  local ip
  local url
  local urls=()

  if [[ -n "${MAXIM_PUBLIC_IP_URL:-}" ]]; then
    urls+=("$MAXIM_PUBLIC_IP_URL")
  fi

  urls+=("https://api.ipify.org" "https://ifconfig.me/ip")

  for url in "${urls[@]}"; do
    ip="$(curl -4 -fsS --connect-timeout 5 --max-time 10 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      printf '%s' "$ip"
      return 0
    fi
  done

  return 1
}

ssh_source_cidr() {
  local ip

  if [[ -n "${MAXIM_YC_SSH_SOURCE_CIDR:-}" ]]; then
    if [[ "$MAXIM_YC_SSH_SOURCE_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
      printf '%s' "$MAXIM_YC_SSH_SOURCE_CIDR"
      return 0
    fi

    echo "MAXIM_YC_SSH_SOURCE_CIDR must be an IPv4 CIDR, for example 203.0.113.7/32." >&2
    return 1
  fi

  ip="$(detect_public_ipv4)" || return 1
  printf '%s/32' "$ip"
}

allow_ssh_current_ip() {
  local sg="${1:-${MAXIM_YC_SSH_SECURITY_GROUP_ID:-${MAXIM_YC_SSH_SECURITY_GROUP_NAME:-}}}"
  local cidr
  local description
  local current_rules
  local timeout_sec="${MAXIM_YC_COMMAND_TIMEOUT_SEC:-30}"
  local args=()

  if ! command -v yc >/dev/null 2>&1; then
    echo "yc not found"
    exit 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found"
    exit 1
  fi

  if [[ -z "$sg" ]]; then
    echo "Set MAXIM_YC_SSH_SECURITY_GROUP_ID or MAXIM_YC_SSH_SECURITY_GROUP_NAME in .env.vps, or pass a security group id/name."
    exit 1
  fi

  cidr="$(ssh_source_cidr)" || {
    echo "Could not resolve SSH source CIDR."
    exit 1
  }

  mapfile -d '' -t args < <(yc_args)

  current_rules="$(timeout "$timeout_sec" yc "${args[@]}" vpc security-group get "$sg")" || {
    echo "Could not read Yandex Cloud security group '$sg'."
    exit 1
  }

  if grep -Fq -- "- $cidr" <<<"$current_rules"; then
    echo "SSH already allowed from $cidr in $sg."
    return 0
  fi

  description="ssh-codex-$(date -u +%Y%m%d)-${cidr//[.\/]/-}"
  timeout "$timeout_sec" yc "${args[@]}" vpc security-group update-rules "$sg" \
    --add-rule "description=$description,direction=ingress,port=22,protocol=tcp,v4-cidrs=$cidr" >/dev/null

  echo "Allowed SSH from $cidr in $sg."
}

maybe_allow_ssh_current_ip() {
  case "${MAXIM_VPS_AUTO_AUTHORIZE_SSH:-0}" in
    1|true|TRUE|yes|YES)
      if ! allow_ssh_current_ip >/dev/null; then
        echo "Warning: could not auto-authorize current SSH source IP; continuing with SSH attempt." >&2
      fi
      ;;
  esac
}

remote_exec() {
  local command="$1"
  local remote_command
  local args=()

  if [[ -n "$PAIR_RELEASE_EXPECTED_STATE_SHA256" && ! "$PAIR_RELEASE_EXPECTED_STATE_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
    echo 'Invalid pair release state fingerprint.' >&2; return 2
  fi
  maybe_allow_ssh_current_ip
  mapfile -d '' -t args < <(ssh_args)
  printf -v remote_command 'cd %q && %s' "$MAXIM_VPS_REPO_DIR" "$command"
  if [[ -n "$PAIR_RELEASE_EXPECTED_STATE_SHA256" ]]; then
    remote_command="export PAIR_RELEASE_EXPECTED_STATE_SHA256=$(printf '%q' "$PAIR_RELEASE_EXPECTED_STATE_SHA256"); $remote_command"
  fi
  # The command is composed and shell-escaped locally before the remote shell parses it.
  # shellcheck disable=SC2029
  ssh "${args[@]}" "$MAXIM_VPS_SSH_TARGET" "bash -lc $(printf '%q' "$remote_command")"
}

install_deploy_flock() {
  if [[ $# != 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'Usage: install-deploy-flock <reviewed-old-sha>' >&2
    return 2
  fi
  local target_sha emergency_reason="${MAXIM_DEPLOY_EMERGENCY_REASON:-}"
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  case "${MAXIM_DEPLOY_EMERGENCY_BYPASS:-0}" in
    0|'') node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" ;;
    1) [[ -n "${emergency_reason//[[:space:]]/}" ]] || return 2 ;;
    *) return 2 ;;
  esac
  remote_exec "$(shell_quote_args bash -s -- "$1" "$target_sha")" <"$ROOT_DIR/infra/scripts/vps-install-deploy-flock.sh"
}

recover_pair_backup_refusal() (
  set -euo pipefail
  local controller_sha recovery_source
  node --input-type=module - "$ROOT_DIR" "$@" <<'NODE'
import { pathToFileURL } from 'node:url';
const [root, ...args] = process.argv.slice(2);
const { parseBackupRefusalRecoveryArgs } = await import(pathToFileURL(`${root}/infra/scripts/pair-release-backup-refusal-recovery.mjs`));
parseBackupRefusalRecoveryArgs(args);
NODE
  [[ -z "$(git status --porcelain)" ]] || { echo 'Backup admission recovery requires a clean exact controller.' >&2; return 2; }
  controller_sha="$(git rev-parse HEAD)"
  node scripts/ci/assert-green.mjs "$controller_sha"
  recovery_source="$(mktemp)"
  trap 'rm -f -- "$recovery_source"' EXIT
  git show "$controller_sha:infra/scripts/pair-release-backup-refusal-recovery.mjs" >"$recovery_source"
  # FLAG: The retained owner blocks normal installation. Stream only the exact green
  # controller; it archives one proved pre-write refusal under all original locks.
  remote_exec "$(shell_quote_args timeout --signal=TERM --kill-after=2 40 sudo -n node --input-type=module - "$@")" <"$recovery_source"
)

recover_pair_backup_activation() (
  set -euo pipefail
  local controller_sha recovery_source
  [[ "$MAXIM_VPS_REPO_DIR" == /var/www/Chat_bot ]] || return 2
  node --input-type=module - "$ROOT_DIR" "$@" <<'NODE'
import { pathToFileURL } from 'node:url';
const [root, ...args] = process.argv.slice(2);
const { parseBackupActivationRecoveryArgs } = await import(pathToFileURL(`${root}/infra/scripts/pair-release-backup-activation-recovery.mjs`));
parseBackupActivationRecoveryArgs(args);
NODE
  [[ -z "$(git status --porcelain)" ]] || { echo 'Backup activation recovery requires a clean exact controller.' >&2; return 2; }
  controller_sha="$(git rev-parse HEAD)"
  node scripts/ci/assert-green.mjs "$controller_sha"
  recovery_source="$(mktemp)"
  trap 'rm -f -- "$recovery_source"' EXIT
  git show "$controller_sha:infra/scripts/pair-release-backup-activation-recovery.mjs" >"$recovery_source"
  # FLAG: This incident owner prevents source synchronization. The exact green controller
  # proves the bounded installation outcome before preserving its owner and recovery proof.
  remote_exec "$(shell_quote_args sudo -n timeout --signal=TERM --kill-after=5s 90s node --input-type=module - "$@")" <"$recovery_source"
)

install_pair_release_admission() (
  set -euo pipefail
  export GIT_NO_REPLACE_OBJECTS=1
  local major_sha="${1:-}" karavan_root="${2:-}" karavan_sha="${3:-}" operator="${4:-maximadmin}"
  local local_stage remote_stage="" remote_heads major_before karavan_before
  local -a heads
  [[ "$#" == 3 || "$#" == 4 ]] && [[ "$major_sha" =~ ^[a-f0-9]{40}$ && "$karavan_sha" =~ ^[a-f0-9]{40}$ && "$operator" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || return 2
  [[ "$MAXIM_VPS_REPO_DIR" == /var/www/Chat_bot && "$karavan_root" == /* && -d "$karavan_root" ]] || return 2
  [[ "$(git rev-parse refs/heads/main)" == "$major_sha" && "$(git -C "$karavan_root" rev-parse refs/heads/main)" == "$karavan_sha" ]] || return 2
  [[ "$(git rev-parse HEAD)" == "$major_sha" && -z "$(git status --porcelain)" \
    && "$(git -C "$karavan_root" rev-parse HEAD)" == "$karavan_sha" && -z "$(git -C "$karavan_root" status --porcelain)" ]] || { echo 'Bootstrap requires clean exact selected local source in both repositories.' >&2; return 2; }
  node scripts/ci/assert-green.mjs "$major_sha"
  (cd "$karavan_root"; node tools/attest-karavan-release.mjs verify --ref "$karavan_sha")
  remote_heads="$(remote_exec 'timeout 10 bash -c '\''git -C /var/www/Chat_bot rev-parse HEAD && git -C /var/www/max-delivery-platform rev-parse HEAD'\''')"
  mapfile -t heads <<<"$remote_heads"
  [[ "${#heads[@]}" == 2 && "${heads[0]}" =~ ^[a-f0-9]{40}$ && "${heads[1]}" =~ ^[a-f0-9]{40}$ ]] || return 1
  major_before="${heads[0]}"; karavan_before="${heads[1]}"
  git merge-base --is-ancestor "$major_before" "$major_sha"
  git -C "$karavan_root" merge-base --is-ancestor "$karavan_before" "$karavan_sha"
  local_stage="$(mktemp -d)"
  git show "$major_sha:infra/scripts/install-pair-release-admission.sh" >"$local_stage/installer.sh"
  # shellcheck disable=SC2317
  cleanup_pair_install() {
    rm -rf -- "$local_stage"
    if [[ "$remote_stage" =~ ^/tmp/major-karavan-admission\.[A-Za-z0-9]{8}$ ]]; then
      remote_exec "$(shell_quote_args timeout 10 rm -rf -- "$remote_stage")" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_pair_install EXIT
  if [[ "$major_sha" != "$major_before" ]]; then git bundle create "$local_stage/major.bundle" refs/heads/main "^$major_before"; fi
  if [[ "$karavan_sha" != "$karavan_before" ]]; then git -C "$karavan_root" bundle create "$local_stage/karavan.bundle" refs/heads/main "^$karavan_before"; fi
  remote_stage="$(remote_exec 'umask 077; mktemp -d /tmp/major-karavan-admission.XXXXXXXX')"
  [[ "$remote_stage" =~ ^/tmp/major-karavan-admission\.[A-Za-z0-9]{8}$ ]] || return 1
  tar -C "$local_stage" -cf - . | remote_exec "$(shell_quote_args timeout 60 tar -C "$remote_stage" -xf -)"
  remote_exec "$(shell_quote_args timeout --signal=TERM --kill-after=5 90 sudo -n bash -s -- install "$operator" "$major_sha" "$karavan_sha" "$remote_stage")" <"$local_stage/installer.sh"
)

validate_backlog_request() {
  node --input-type=module - "$ROOT_DIR" "$1" "$2" "$3" <<'NODE'
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [root, path, sha, mode] = process.argv.slice(2);
let fd;
try {
  if (!['preview', 'apply'].includes(mode) || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error('Invalid mode or controller source');
  const limit = mode === 'preview' ? 16384 : 4096;
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > limit)
    throw new Error('Private bounded cancellation request required');
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  const after = fstatSync(fd);
  if (length !== stat.size || length > limit || ['dev','ino','size','mode','nlink','mtimeMs','ctimeMs'].some(key => stat[key] !== after[key]))
    throw new Error('Cancellation request changed');
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  const candidate = JSON.parse(raw);
  let request;
  if (candidate?.version === 2) {
    const { parseNominationV2, parseApplyV2 } = await import(pathToFileURL(`${root}/infra/scripts/backlog-cancellation-v2-host.mjs`));
    request = mode === 'preview' ? parseNominationV2(raw) : parseApplyV2(raw);
  } else {
    if (mode !== 'apply') throw new Error('Preview requires version 2');
    const { parseBacklogCancellationRequest } = await import(pathToFileURL(`${root}/infra/scripts/backlog-cancellation-host.mjs`));
    request = parseBacklogCancellationRequest(raw);
  }
  if (request.version !== 2 && request.sourceSha !== sha)
    throw new Error('Legacy cancellation request must match local source');
  // The caller retains these validated bounded bytes across the CI/network wait.
  process.stdout.write(raw);
} catch {
  console.error('Private exact-source backlog request refused.');
  process.exitCode = 2;
} finally { if (fd !== undefined) closeSync(fd); }
NODE
}

assert_backlog_controller_source() {
  local expected_sha="$1" observed_sha tree_status
  observed_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)" || return 2
  tree_status="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" || return 2
  if [[ ! "$expected_sha" =~ ^[0-9a-f]{40}$ || "$observed_sha" != "$expected_sha" || -n "$tree_status" ]]; then
    echo 'Cancellation requires clean exact local controller source.' >&2
    return 2
  fi
}

cancel_webhook_backlog() {
  if [[ $# != 1 || ! -f "$1" ]]; then
    echo 'Usage: cancel-webhook-backlog <private-request.json>' >&2
    return 2
  fi
  local request_file="$1" target_sha runtime_sha validated_request
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  validated_request="$(validate_backlog_request "$request_file" "$target_sha" apply)"
  assert_backlog_controller_source "$target_sha"
  # FLAG: Derive runtime identity from the frozen validated bytes, never a second file read.
  runtime_sha="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0).toString("utf8")).sourceSha)' <<<"$validated_request")"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  if [[ "$runtime_sha" != "$target_sha" ]]; then
    node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$runtime_sha"
  fi
  assert_backlog_controller_source "$target_sha"
  printf '%s\n' "$validated_request" | remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" "MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA=$runtime_sha" bash ./infra/scripts/vps-backlog-cancellation.sh)"
}

preview_webhook_backlog() {
  if [[ $# != 1 || ! -f "$1" ]]; then
    echo 'Usage: preview-webhook-backlog <private-nomination.json>' >&2
    return 2
  fi
  local request_file="$1" target_sha runtime_sha validated_request
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  validated_request="$(validate_backlog_request "$request_file" "$target_sha" preview)"
  assert_backlog_controller_source "$target_sha"
  # FLAG: Derive runtime identity from the frozen validated bytes, never a second file read.
  runtime_sha="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0).toString("utf8")).sourceSha)' <<<"$validated_request")"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  if [[ "$runtime_sha" != "$target_sha" ]]; then
    node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$runtime_sha"
  fi
  assert_backlog_controller_source "$target_sha"
  printf '%s\n' "$validated_request" | remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" "MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA=$runtime_sha" bash ./infra/scripts/vps-backlog-cancellation.sh --preview)"
}

legacy_cold_recovery() {
  if [[ $# != 1 ]]; then
    echo 'Usage: legacy-cold-recovery <private-request.json>' >&2
    return 2
  fi
  local request_file="$1" target_sha emergency_reason="${MAXIM_DEPLOY_EMERGENCY_REASON:-}"
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node --input-type=module - "$ROOT_DIR" "$request_file" "$target_sha" <<'NODE'
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [root, path, sha] = process.argv.slice(2);
const { parseLegacyColdHostRequest } = await import(pathToFileURL(join(root, 'infra/scripts/legacy-cold-host.mjs')));
const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 || stat.size > 65536) throw new Error('Private bounded request required');
  const request = parseLegacyColdHostRequest(readFileSync(fd, 'utf8'));
  if (request.operation !== 'status' && request.targetSha !== sha)
    throw new Error('Request must match the exact local source');
} finally { closeSync(fd); }
NODE
  case "${MAXIM_DEPLOY_EMERGENCY_BYPASS:-0}" in
    0|'') node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" ;;
    1)
      if [[ -z "${emergency_reason//[[:space:]]/}" ]]; then
        echo 'A reviewed emergency reason is required.' >&2
        return 2
      fi
      echo "Emergency source admission: $emergency_reason" >&2
      ;;
    *) echo 'Invalid emergency source admission.' >&2; return 2 ;;
  esac
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-legacy-cold-recovery.sh)" <"$request_file"
}

source_abandonment() {
  if [[ $# != 1 ]]; then
    echo 'Usage: source-abandonment <private-request.json>' >&2
    return 2
  fi
  local request_file="$1" target_sha emergency_reason="${MAXIM_DEPLOY_EMERGENCY_REASON:-}"
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node --input-type=module - "$ROOT_DIR" "$request_file" "$target_sha" <<'NODE'
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [root, path, sha] = process.argv.slice(2);
const { parseSourceAbandonmentHostRequest } = await import(pathToFileURL(join(root, 'infra/scripts/source-abandonment-host.mjs')));
const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 || stat.size > 65536) throw new Error('Private bounded request required');
  const request = parseSourceAbandonmentHostRequest(readFileSync(fd, 'utf8'));
  if (request.operation !== 'status' && request.targetSha !== sha)
    throw new Error('Request must match the exact local source');
} finally { closeSync(fd); }
NODE
  case "${MAXIM_DEPLOY_EMERGENCY_BYPASS:-0}" in
    0|'') node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" ;;
    1)
      if [[ -z "${emergency_reason//[[:space:]]/}" ]]; then
        echo 'A reviewed emergency reason is required.' >&2
        return 2
      fi
      echo "Emergency source admission: $emergency_reason" >&2
      ;;
    *) echo 'Invalid emergency source admission.' >&2; return 2 ;;
  esac
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-source-abandonment.sh)" <"$request_file"
}

source_abandonment_corrective() {
  if [[ $# != 1 ]]; then
    echo 'Usage: source-abandonment-corrective <private-envelope.json>' >&2
    return 2
  fi
  local request_file="$1" controller_sha emergency_reason="${MAXIM_DEPLOY_EMERGENCY_REASON:-}"
  controller_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node --input-type=module - "$ROOT_DIR" "$request_file" "$controller_sha" <<'NODE'
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [root, path, sha] = process.argv.slice(2);
let fd;
try {
  const { parseSourceAbandonmentCorrectiveHostRequest } = await import(pathToFileURL(join(root, 'infra/scripts/source-abandonment-corrective-host.mjs')));
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 || stat.size > 65536) throw new Error('Private bounded envelope required');
  const envelope = parseSourceAbandonmentCorrectiveHostRequest(readFileSync(fd, 'utf8'));
  if (envelope.controllerSha !== sha) throw new Error('Controller source mismatch');
} catch {
  process.stderr.write('Private corrective controller envelope refused.\n');
  process.exitCode = 2;
} finally { if (fd !== undefined) closeSync(fd); }
NODE
  # FLAG: An explicit emergency reason may bypass only CI admission. The exact
  # controller identity, private envelope and runtime review hashes still bind.
  case "${MAXIM_DEPLOY_EMERGENCY_BYPASS:-0}" in
    0|'') node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$controller_sha" ;;
    1)
      if [[ -z "${emergency_reason//[[:space:]]/}" ]]; then
        echo 'A reviewed emergency reason is required.' >&2
        return 2
      fi
      echo "Emergency corrective controller admission: $emergency_reason" >&2
      ;;
    *) echo 'Invalid emergency corrective controller admission.' >&2; return 2 ;;
  esac
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_CONTROLLER_SHA=$controller_sha" bash ./infra/scripts/vps-source-abandonment-corrective.sh)" <"$request_file"
}

commercial_llm() {
  local operation="${1:-status}" target_sha
  case "$operation" in
    workstation-pool-bridge)
      if [[ $# -ne 2 || ( "${2:-}" != pc-a-4b && "${2:-}" != pc-b-9b ) ]]; then
        echo 'Usage: commercial-llm workstation-pool-bridge pc-a-4b|pc-b-9b' >&2
        return 2
      fi
      remote_exec "$(shell_quote_args bash ./infra/scripts/vps-commercial-llm.sh "$operation" "$2")"
      ;;
    status|smoke|check-client|workstation-bridge|check-workstation|check-workstation-offline)
      [[ $# -le 1 ]] || { echo 'Unexpected commercial-llm arguments.' >&2; return 2; }
      remote_exec "$(shell_quote_args bash ./infra/scripts/vps-commercial-llm.sh "$operation")"
      ;;
    recover-cpu-quarantine)
      if [[ ! ( $# -eq 2 || ( $# -eq 4 && "${3:-}" == --apply && "${4:-}" =~ ^[0-9a-f]{64}$ ) ) \
        || ! "${2:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
        echo 'Usage: commercial-llm recover-cpu-quarantine <operation-uuid> [--apply <preview-sha256>]' >&2
        return 2
      fi
      target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
      node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
      remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-commercial-llm.sh "$@")"
      ;;
    install|replace|upgrade-slots|stop|enable|disable)
      [[ $# -le 2 && ( $# -eq 1 || "${2:-}" == --apply ) ]] || {
        echo 'Usage: commercial-llm install|replace|upgrade-slots|enable|disable|stop [--apply]' >&2
        return 2
      }
      target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
      node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
      remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-commercial-llm.sh "$@")"
      ;;
    *) echo 'Unknown commercial-llm operation.' >&2; return 2 ;;
  esac
}

support_chat() {
  [[ $# -eq 1 && "$1" == preview ]] || {
    echo 'Usage: support-chat preview' >&2
    return 2
  }
  remote_exec "$(shell_quote_args node ./infra/scripts/support-chat-remote.mjs preview)"
}

remote_from_args() {
  if [[ $# -eq 0 ]]; then
    echo "Missing remote command."
    usage
    exit 1
  fi

  guard_raw_database_exec "$@"

  if [[ $# -eq 1 ]]; then
    remote_exec "$1"
  else
    remote_exec "$(shell_quote_args "$@")"
  fi
}

guard_raw_database_exec() {
  local command_text="$*"
  local docker_postgres_pattern='(^|[[:space:];|&])docker[[:space:]][^;|&]*(exec|run)[[:space:]][^;|&]*postgres[^[:space:];|&]*($|[[:space:];|&])'

  command_text="${command_text//$'\n'/ }"
  if [[ ! "$command_text" =~ (^|[^[:alnum:]_])(psql|pg_dump|pg_restore)($|[^[:alnum:]_]) ]] &&
    [[ ! "$command_text" =~ $docker_postgres_pattern ]]; then
    return 0
  fi

  require_database_break_glass 'Direct production PostgreSQL CLI command' || return
}

require_database_break_glass() {
  local operation="$1"

  if [[ "$DATABASE_BREAK_GLASS_FROM_CALLER" != '1' ]] ||
    [[ -z "${DATABASE_BREAK_GLASS_REASON_FROM_CALLER//[[:space:]]/}" ]]; then
    cat <<'ERROR' >&2
Direct production PostgreSQL CLIs and interactive VPS shells are break-glass operations.
Use `postgres-audit` for routine queue/activity diagnostics. A reviewed operation
requires both MAXIM_VPS_DATABASE_BREAK_GLASS=1 and a non-empty
MAXIM_VPS_DATABASE_BREAK_GLASS_REASON supplied in the invoking process environment.
ERROR
    return 2
  fi

  printf 'WARNING: reviewed break-glass operation accepted (%s); reason supplied locally.\n' \
    "$operation" >&2
}

postgres_audit() {
  local mode="${1:-all}"

  if [[ "$mode" == 'karavan-candidates' ]]; then
    node "$ROOT_DIR/infra/scripts/karavan-candidates-audit.mjs" --validate-scope "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'central-statistics' ]]; then
    node "$ROOT_DIR/infra/scripts/central-statistics-audit.mjs" --validate-scope "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'statistics-exchange' ]]; then
    node "$ROOT_DIR/infra/scripts/statistics-exchange-audit.mjs" --validate-scope "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'network-statistics' ]]; then
    node "$ROOT_DIR/infra/scripts/network-statistics-audit.mjs" "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'publisher-slots' ]]; then
    node "$ROOT_DIR/infra/scripts/publisher-slot-audit.mjs" "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'chat-message-window' ]]; then
    node "$ROOT_DIR/infra/scripts/chat-message-window-audit.mjs" "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'duplicate' && "${2:-}" == '--status' ]]; then
    case "${3:-}" in
      OBSERVED|PENDING|IN_PROGRESS|RETRYABLE|WAITING_CAPABILITY|AMBIGUOUS|SUCCEEDED|ALREADY_ABSENT|EXPIRED|FAILED_TERMINAL) ;;
      *) echo 'Unknown duplicate intent status.' >&2; exit 2 ;;
    esac
    if [[ $# -gt 4 || ( $# -eq 4 && "$4" != '--explain' ) ]]; then
      echo 'Usage: postgres-audit duplicate --status <STATUS> [--explain]' >&2
      exit 2
    fi
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'webhook-recovery-key-cohort' ]]; then
    node "$ROOT_DIR/infra/scripts/webhook-recovery-key-cohort-audit.mjs" "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'webhook-cohort' ]]; then
    node "$ROOT_DIR/infra/scripts/webhook-cohort-audit.mjs" "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'moderation-outcomes' ]]; then
    node "$ROOT_DIR/infra/scripts/moderation-outcomes-audit.mjs" "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'webhook-held-receipt' ]]; then
    node "$ROOT_DIR/infra/scripts/webhook-held-receipt-audit.mjs" --validate-scope "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'webhook-workload' || "$mode" == 'delete-retry-heads' || "$mode" == 'queue' || "$mode" == 'publisher-publications' || "$mode" == 'publisher-access-census' ||
        "$mode" == 'storage' || "$mode" == 'commercial-quality' || "$mode" == 'duplicate' ||
        "$mode" == 'multibot-preparation' || "$mode" == 'webhook-owner-proof' || "$mode" == 'webhook-source-proof' || "$mode" == 'webhook-retry-proof' || "$mode" == 'webhook-queued-proof' || "$mode" == 'legacy-order-window' ||
        "$mode" == 'legacy-semantic-mirrors' ]]; then
    if [[ $# -gt 2 || ( $# -eq 2 && "$2" != '--explain' ) ]]; then
      echo "Usage: postgres-audit $mode [--explain]" >&2
      exit 2
    fi
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'webhook-source-envelope' ]]; then
    if [[ $# -lt 2 || $# -gt 3 || ( $# -eq 3 && "$3" != '--explain' ) ]]; then return 2; fi
    node "$ROOT_DIR/infra/scripts/webhook-source-envelope-audit.mjs" "$2" --explain >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'webhook-quarantine-proof' ]]; then
    node "$ROOT_DIR/infra/scripts/webhook-quarantine-proof-audit.mjs" "${@:2}" >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'webhook-quarantine' ]]; then
    if [[ $# -lt 2 || $# -gt 3 || ( $# -eq 3 && "$3" != '--explain' ) ]]; then return 2; fi
    node "$ROOT_DIR/infra/scripts/webhook-quarantine-audit.mjs" "$2" --explain >/dev/null || return 2
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'poll-publication' ]]; then
    if [[ $# -lt 2 || $# -gt 3 || ! "$2" =~ ^[A-Za-z0-9_-]{1,128}$ ||
          ( $# -eq 3 && "$3" != '--explain' ) ]]; then
      echo 'Usage: postgres-audit poll-publication <poll-id> [--explain]' >&2
      return 2
    fi
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ "$mode" == 'rules-cleanup' || "$mode" == 'publisher-comments' ]]; then
    if [[ $# -lt 2 || $# -gt 3 || ! "$2" =~ ^-[1-9][0-9]{0,19}$ ||
          ( $# -eq 3 && "$3" != '--explain' ) ]]; then
      echo "Usage: postgres-audit $mode <negative-numeric-chat-id> [--explain]" >&2
      exit 2
    fi
    remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    return
  fi

  if [[ $# -gt 1 ]]; then
    echo "Usage: $0 postgres-audit [queue|activity|duplicate|publication-schema|storage|legacy-order-candidates|all]" >&2
    exit 2
  fi

  case "$mode" in
    queue|activity|duplicate|publication-schema|legacy-order-candidates|all)
      ;;
    *)
      echo "Unknown PostgreSQL audit mode: $mode" >&2
      echo "Usage: $0 postgres-audit [queue|activity|duplicate|publication-schema|storage|legacy-order-candidates|all]" >&2
      exit 2
      ;;
  esac

  remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$mode")"
}

recover_publication_post_actions_migration() {
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--apply' ) ]]; then
    echo 'Usage: recover-publication-post-actions-migration [--apply]' >&2
    exit 2
  fi
  local target_sha
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-recover-publication-post-actions-migration.sh "$@")"
}

recover_publication_priority_migration() {
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--apply' ) ]]; then
    echo 'Usage: recover-publication-priority-migration [--apply]' >&2
    exit 2
  fi
  local target_sha
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-recover-publication-priority-migration.sh "$@")"
}

recover_publisher_catalog_migration() {
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--apply' ) ]]; then
    echo 'Usage: recover-publisher-catalog-migration [--apply]' >&2
    exit 2
  fi
  local target_sha
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-recover-publisher-catalog-migration.sh "$@")"
}

recover_message_retention_migration() {
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--apply' ) ]]; then
    echo 'Usage: recover-message-retention-migration [--apply]' >&2
    exit 2
  fi
  local target_sha
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-recover-message-retention-migration.sh "$@")"
}

recover_multibot_preparation() {
  node "$ROOT_DIR/infra/scripts/multibot-preparation-recovery.mjs" --validate-args "$@"
  local target_sha
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-recover-multibot-preparation.sh "$@")"
}

recover_publisher_access_migration() {
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--apply' ) ]]; then
    echo 'Usage: recover-publisher-access-migration [--apply]' >&2
    exit 2
  fi
  local target_sha
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-recover-publisher-access-migration.sh "$@")"
}

recover_suggestion_subscription_migration() {
  if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--apply' ) ]]; then
    echo 'Usage: recover-suggestion-subscription-migration [--apply]' >&2
    exit 2
  fi
  local target_sha
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha"
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-recover-suggestion-subscription-migration.sh "$@")"
}

postgres_audit_provision() {
  if [[ $# -gt 1 ]] || [[ $# -eq 1 && "$1" != '--apply' ]]; then
    echo "Usage: $0 postgres-audit-provision [--apply]" >&2
    exit 2
  fi

  remote_exec "$(shell_quote_args ./infra/scripts/vps-provision-postgres-audit-role.sh "$@")"
}

prepend_webhook_rollout_recovery_env() {
  local command_var="$1"
  local -n command_ref="$command_var"

  case "${MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE:-0}" in
    0|'')
      ;;
    1)
      command_ref="MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1 $command_ref"
      ;;
    *)
      echo "MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE must be 0 or 1." >&2
      return 2
      ;;
  esac
}

prepend_post_release_reclaim_env() {
  local command_var="$1"
  local -n command_ref="$command_var"
  case "${MAXIM_DEPLOY_RECLAIM_OLD_IMAGES:-0}" in
    0|'') ;;
    1) command_ref="MAXIM_DEPLOY_RECLAIM_OLD_IMAGES=1 $command_ref" ;;
    *)
      echo "MAXIM_DEPLOY_RECLAIM_OLD_IMAGES must be 0 or 1." >&2
      return 2
      ;;
  esac
}

prepend_deploy_ready_timeout_env() {
  local command_var="$1"
  local -n command_ref="$command_var"
  local timeout="$DEPLOY_API_READY_TIMEOUT_SEC_FROM_CALLER"
  [[ -n "$timeout" ]] || return 0
  if [[ ! "$timeout" =~ ^[1-9][0-9]{2,3}$ ]] || ((timeout < 180 || timeout > 3600)); then
    echo "MAXIM_DEPLOY_API_READY_TIMEOUT_SEC must be an integer between 180 and 3600." >&2
    return 2
  fi
  command_ref="MAXIM_DEPLOY_API_READY_TIMEOUT_SEC=$(printf '%q' "$timeout") $command_ref"
}

prepend_deploy_disk_floor_env() {
  local command_var="$1"
  local -n command_ref="$command_var"
  local minimum="$DEPLOY_DISK_MIN_FREE_BYTES_FROM_CALLER"
  [[ -n "$minimum" ]] || return 0
  if [[ ! "$minimum" =~ ^[0-9]+$ ]]; then
    echo "MAXIM_DEPLOY_DISK_MIN_FREE_BYTES must be a non-negative integer." >&2
    return 2
  fi
  # FLAG: The remote capacity guard owns the component floor; callers may only raise it.
  command_ref="MAXIM_DEPLOY_DISK_MIN_FREE_BYTES=$(printf '%q' "$minimum") $command_ref"
}

rollback_entrypoint_bootstrap_source() {
  cat <<'BOOTSTRAP'
set -euo pipefail

expected_tooling_sha="$1"
entrypoint="$2"
capability_marker="$3"
shift 3
bootstrap_root="$(pwd -P)"
# FLAG: Bootstrap shares the protected inode with every runtime operation.
# An older checkout must be explicitly upgraded before this entrypoint can run;
# never recreate the retired PID lock or synchronize Git outside the new lock.
if [[ ! -f infra/scripts/lib/deploy-lock.sh ]] ||
   ! grep -Fq 'export MAXIM_DEPLOY_LOCK_VERSION=flock-v1' infra/scripts/lib/deploy-lock.sh; then
  echo 'Reviewed flock tooling must be installed before rollback bootstrap.' >&2
  exit 1
fi
source infra/scripts/lib/deploy-lock.sh
acquire_deploy_lock

# FLAG: An installed durable release service must remain paused after an operator rollback.
# Absence of its root marker retains the legacy path; any present unsafe installation fails closed.
if [[ -e /etc/maxim-release/installed || -L /etc/maxim-release/installed ]]; then
  for release_policy_path in /etc /etc/maxim-release /usr /usr/local /usr/local/lib \
    /usr/local/lib/maxim-release /usr/local/lib/maxim-release/infra /usr/local/lib/maxim-release/infra/scripts; do
    if [[ ! -d "$release_policy_path" || -L "$release_policy_path" ]]; then
      echo 'Unsafe installed release policy directory; rollback refused.' >&2
      exit 1
    fi
    release_policy_owner="$(stat -c %u -- "$release_policy_path")"
    release_policy_mode="$(stat -c %a -- "$release_policy_path")"
    if [[ "$release_policy_owner" != 0 || ! "$release_policy_mode" =~ ^[0-7]{3,4}$ ]] || \
      (( (8#$release_policy_mode & 0022) != 0 )); then
      echo 'Unprotected installed release policy directory; rollback refused.' >&2
      exit 1
    fi
  done
  for release_policy_path in /etc/maxim-release/installed \
    /usr/local/lib/maxim-release/infra/scripts/release-service-policy.mjs \
    /usr/local/lib/maxim-release/infra/scripts/release-service-boundary.mjs; do
    if [[ ! -f "$release_policy_path" || -L "$release_policy_path" || \
      "$(stat -c '%u:%h' -- "$release_policy_path")" != 0:1 ]]; then
      echo 'Unsafe or missing installed release policy helper; rollback refused.' >&2
      exit 1
    fi
    release_policy_mode="$(stat -c %a -- "$release_policy_path")"
    if [[ ! "$release_policy_mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$release_policy_mode & 0022) != 0 )); then
      echo 'Writable installed release policy helper; rollback refused.' >&2
      exit 1
    fi
  done
  if [[ "$(stat -c %s /etc/maxim-release/installed)" != 41 ]] || \
    ! IFS= read -r release_policy_installed_sha < /etc/maxim-release/installed || \
    [[ ! "$release_policy_installed_sha" =~ ^[a-f0-9]{40}$ ]]; then
    echo 'Invalid installed release policy marker; rollback refused.' >&2
    exit 1
  fi
  release_policy_node="$(PATH=/usr/local/bin:/usr/bin:/bin command -v node)"
  release_policy_node="$(readlink -e -- "$release_policy_node")"
  if [[ ( "$release_policy_node" != /usr/bin/node && "$release_policy_node" != /usr/local/bin/node ) || \
    ! -f "$release_policy_node" || "$(stat -c %u -- "$release_policy_node")" != 0 ]]; then
    echo 'Reviewed system Node is unavailable; rollback refused.' >&2
    exit 1
  fi
  release_policy_mode="$(stat -c %a -- "$release_policy_node")"
  if [[ ! "$release_policy_mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$release_policy_mode & 0022) != 0 )); then
    echo 'Reviewed system Node is writable; rollback refused.' >&2
    exit 1
  fi
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/var/lib/maxim-release LANG=C.UTF-8 \
    "$release_policy_node" /usr/local/lib/maxim-release/infra/scripts/release-service-policy.mjs pause-rollback >/dev/null || exit $?
fi
source infra/scripts/lib/legacy-cold-maintenance.sh
maxim_require_ordinary_effect_authority "$bootstrap_root"

# FLAG: Inspect the installed connection floor before trusting any retained entrypoint tooling.
connection_floor_required=1
if [[ "$entrypoint" == ./infra/scripts/vps-release-rollback.sh && $# -gt 1 ]]; then
  connection_floor_required=0
  for component in "${@:2}"; do
    if [[ "$component" == api-shared || "$component" == eraser ]]; then connection_floor_required=1; fi
  done
fi
if [[ "$connection_floor_required" -eq 1 && ( -e /var/lib/maxim-deploy/eraser-connection-request-version || -L /var/lib/maxim-deploy/eraser-connection-request-version ) ]]; then
  source infra/scripts/lib/deploy-topology.sh
  maxim_topology_require_eraser_connection_requests "$(git rev-parse HEAD)" tooling || exit 1
fi

# FLAG: Image-only API/static rollback leaves Lastik and controller files unchanged.
rate_limit_floor_required=1
if [[ "$entrypoint" == ./infra/scripts/vps-release-rollback.sh && $# -gt 1 ]]; then
  rate_limit_floor_required=0
  for component in "${@:2}"; do
    if [[ "$component" == eraser ]]; then rate_limit_floor_required=1; fi
  done
fi
if [[ "$rate_limit_floor_required" -eq 1 && ( -e /var/lib/maxim-deploy/eraser-rate-limit-reader-version || -L /var/lib/maxim-deploy/eraser-rate-limit-reader-version ) ]]; then
  source infra/scripts/lib/deploy-topology.sh
  maxim_topology_require_eraser_rate_limit_reader "$(git rev-parse HEAD)" tooling || exit 1
fi

# FLAG: The same Lastik/source-changing scope applies to generation-bound connection proofs.
if [[ "$rate_limit_floor_required" -eq 1 && ( -e /var/lib/maxim-deploy/eraser-connection-proof-reader-version || -L /var/lib/maxim-deploy/eraser-connection-proof-reader-version ) ]]; then
  source infra/scripts/lib/deploy-topology.sh
  maxim_topology_require_eraser_connection_proof_reader "$(git rev-parse HEAD)" tooling || exit 1
fi

# Routine immutable rollback stays image-only and offline when the checked-out entrypoint is current.
if [[ -x "$entrypoint" ]] && grep -Fq -- "$capability_marker" "$entrypoint"; then
  source "$entrypoint" "$@"
  exit $?
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "VPS worktree has tracked changes; refusing rollback tooling synchronization." >&2
  exit 1
fi
if ! git cat-file -e "${expected_tooling_sha}^{commit}" 2>/dev/null; then
  echo "Reviewed rollback tooling commit is not retained on the VPS." >&2
  exit 1
fi
if [[ "$(git rev-parse --verify refs/heads/main 2>/dev/null || true)" != "$expected_tooling_sha" ]]; then
  echo "Retained VPS main does not match the reviewed rollback tooling SHA." >&2
  exit 1
fi
require_market_statistics_lock_dispatch "$expected_tooling_sha" || exit 1
require_pair_release_admission_dispatch "$expected_tooling_sha" || exit 1
if [[ -e /var/lib/maxim-deploy/eraser-connection-proof-reader-version || -L /var/lib/maxim-deploy/eraser-connection-proof-reader-version ]]; then
  source infra/scripts/lib/deploy-topology.sh
  maxim_topology_require_eraser_connection_proof_reader "$expected_tooling_sha" tooling || exit 1
fi
if [[ -e /var/lib/maxim-deploy/eraser-rate-limit-reader-version || -L /var/lib/maxim-deploy/eraser-rate-limit-reader-version ]]; then
  source infra/scripts/lib/deploy-topology.sh
  maxim_topology_require_eraser_rate_limit_reader "$expected_tooling_sha" tooling || exit 1
fi
if [[ -e /var/lib/maxim-deploy/eraser-reader-version || -L /var/lib/maxim-deploy/eraser-reader-version || \
      -e /var/lib/maxim-deploy/eraser-connection-request-version || -L /var/lib/maxim-deploy/eraser-connection-request-version ]]; then
  source infra/scripts/lib/deploy-topology.sh
  maxim_topology_require_eraser_bridge "$expected_tooling_sha" || exit 1
fi
git checkout main
if [[ "$(git rev-parse HEAD)" != "$expected_tooling_sha" ]]; then
  echo "Synchronized rollback tooling does not match the reviewed SHA." >&2
  exit 1
fi
if [[ ! -x "$entrypoint" ]] || ! grep -Fq -- "$capability_marker" "$entrypoint"; then
  echo "Synchronized rollback entrypoint is unavailable: $entrypoint" >&2
  exit 1
fi

# Source in the bootstrap shell so its EXIT lock cleanup also covers entrypoint preflight failures.
# Once rollback validates the same inherited flock, its cleanup trap takes ownership.
source "$entrypoint" "$@"
BOOTSTRAP
}

build_guarded_rollback_command() {
  local command_var="$1"
  local entrypoint="$2"
  local capability_marker="$3"
  shift 3
  local -n command_ref="$command_var"
  local bootstrap
  local tooling_sha

  # FLAG: Retain the API selector recognized by installed lifecycle controllers,
  # then require the newer local-ban reader at the actual bootstrap boundary.
  if [[ "$capability_marker" == maxim_topology_require_statistics_and_night_mode_recovery ]]; then
    capability_marker=maxim_topology_require_local_chat_ban_reader
  fi
  # FLAG: Promote the retained selector again so old local-ban tooling cannot execute
  # opening-notice cleanup after its policy reader has been rolled back.
  if [[ "$capability_marker" == maxim_topology_require_local_chat_ban_reader ]]; then
    capability_marker=maxim_topology_require_night_open_notice_cleanup_reader
  fi
  # FLAG: Retained opening-cleanup tooling predates selective link-policy readers.
  # API rollback must upgrade it; static-only rollback keeps its independent marker.
  if [[ "$capability_marker" == maxim_topology_require_night_open_notice_cleanup_reader ]]; then
    capability_marker=maxim_topology_require_link_rules_policy_reader
  fi

  if ! tooling_sha="$(git rev-parse --verify --end-of-options 'main^{commit}' 2>/dev/null)"; then
    echo "Cannot resolve local main to the reviewed rollback tooling SHA." >&2
    return 2
  fi
  bootstrap="$(rollback_entrypoint_bootstrap_source)"
  printf -v command_ref 'bash -c %q %q %q %q %q %s' \
    "$bootstrap" \
    maxim-rollback-bootstrap \
    "$tooling_sha" \
    "$entrypoint" \
    "$capability_marker" \
    "$(shell_quote_args "$@")"
}

commercial_ocr_promote() {
  local chat_ids_file="${1:-}"
  local certification_file="${2:-}"
  local reviewed_certification_sha256="${3:-}"
  local expected_revision="${4:-}"
  local apply="${5:-}"
  local remote_command
  local args=()
  local certification_bytes chat_ids_bytes actual_certification_sha256

  if [[ -z "$chat_ids_file" || ! -f "$chat_ids_file" || \
    -z "$certification_file" || ! -f "$certification_file" || \
    -z "$expected_revision" || ! "$reviewed_certification_sha256" =~ ^[a-f0-9]{64}$ ]]; then
    echo "Usage: $0 commercial-ocr-promote <chat-ids-file> <certification-file> <reviewed-certification-sha256> <none|revision> [--apply]" >&2
    exit 2
  fi
  if [[ -n "$apply" && "$apply" != "--apply" ]] || [[ $# -gt 5 ]]; then
    echo "Usage: $0 commercial-ocr-promote <chat-ids-file> <certification-file> <reviewed-certification-sha256> <none|revision> [--apply]" >&2
    exit 2
  fi
  certification_bytes="$(wc -c <"$certification_file")"
  chat_ids_bytes="$(wc -c <"$chat_ids_file")"
  if [[ ! "$certification_bytes" =~ ^[0-9]+$ || "$certification_bytes" -lt 1 || \
    "$certification_bytes" -gt 262144 ]]; then
    echo "Commercial OCR certification input must be between 1 and 262144 bytes." >&2
    exit 2
  fi
  if [[ ! "$chat_ids_bytes" =~ ^[0-9]+$ || "$chat_ids_bytes" -lt 1 || \
    "$chat_ids_bytes" -gt 1048576 ]]; then
    echo "Commercial OCR chat-id input must be between 1 and 1048576 bytes." >&2
    exit 2
  fi
  actual_certification_sha256="$(sha256sum -- "$certification_file")"
  actual_certification_sha256="${actual_certification_sha256%% *}"
  if [[ ! "$actual_certification_sha256" =~ ^[a-f0-9]{64}$ ]]; then
    echo "Could not validate the commercial OCR certification SHA-256." >&2
    exit 2
  fi
  if [[ "$actual_certification_sha256" != "$reviewed_certification_sha256" ]]; then
    echo "Commercial OCR certification does not match the independently reviewed SHA-256." >&2
    exit 2
  fi

  maybe_allow_ssh_current_ip
  mapfile -d '' -t args < <(ssh_args)
  # Keep remote temporary paths literal until bash evaluates the command on the VPS.
  # shellcheck disable=SC2016
  printf -v remote_command \
    'cd %q && bundle_dir="$(mktemp -d)" && certification_file="$bundle_dir/certification.json" && cohort_file="$bundle_dir/cohort.txt" && trap '\''rm -f -- "$certification_file" "$cohort_file"; rmdir -- "$bundle_dir"'\'' EXIT && node ./infra/scripts/commercial-ocr-promotion-bundle.mjs unpack "$certification_file" "$cohort_file" && ./infra/scripts/vps-commercial-ocr-rollout.sh promote --chat-ids-file "$cohort_file" --certification-file "$certification_file" --certification-sha256 %q --expected-revision %q' \
    "$MAXIM_VPS_REPO_DIR" "$reviewed_certification_sha256" "$expected_revision"
  if [[ "$apply" == "--apply" ]]; then
    remote_command+=" --apply"
  fi
  printf 'Commercial OCR certification selected: sha256=%s\n' "$reviewed_certification_sha256"
  # Certification and cohort contents travel only over stdin and never appear in SSH arguments.
  # shellcheck disable=SC2029
  node "$ROOT_DIR/infra/scripts/commercial-ocr-promotion-bundle.mjs" pack \
    "$certification_file" "$chat_ids_file" |
    ssh "${args[@]}" "$MAXIM_VPS_SSH_TARGET" "bash -lc $(printf '%q' "$remote_command")"
}

commercial_ocr_status() {
  if [[ $# -ne 0 ]]; then
    echo "Usage: $0 commercial-ocr-status" >&2
    exit 2
  fi
  remote_exec "$(shell_quote_args ./infra/scripts/vps-commercial-ocr-rollout.sh status)"
}

commercial_ocr_recover_shadow() {
  local apply="${1:-}"
  if [[ -n "$apply" && "$apply" != "--apply" ]] || [[ $# -gt 1 ]]; then
    echo "Usage: $0 commercial-ocr-recover-shadow [--apply]" >&2
    exit 2
  fi
  local remote_args=(./infra/scripts/vps-commercial-ocr-rollout.sh recover-shadow)
  if [[ "$apply" == "--apply" ]]; then
    remote_args+=(--apply)
  fi
  remote_exec "$(shell_quote_args "${remote_args[@]}")"
}

commercial_ocr_downgrade() {
  local expected_revision="${1:-}"
  local apply="${2:-}"
  if [[ -z "$expected_revision" || ( -n "$apply" && "$apply" != "--apply" ) || $# -gt 2 ]]; then
    echo "Usage: $0 commercial-ocr-downgrade <revision> [--apply]" >&2
    exit 2
  fi
  local remote_args=(
    ./infra/scripts/vps-commercial-ocr-rollout.sh
    downgrade
    --expected-revision
    "$expected_revision"
  )
  if [[ "$apply" == "--apply" ]]; then
    remote_args+=(--apply)
  fi
  remote_exec "$(shell_quote_args "${remote_args[@]}")"
}

publisher_dispatch_command() {
  local action="$1"
  shift
  local apply="${1:-}"
  if [[ "$action" == "status" ]]; then
    if [[ $# -ne 0 ]]; then
      echo "Usage: $0 publisher-dispatch-status" >&2
      exit 2
    fi
  elif [[ -n "$apply" && "$apply" != "--apply" ]] || [[ $# -gt 1 ]]; then
    echo "Usage: $0 publisher-dispatch-${action} [--apply]" >&2
    exit 2
  fi
  local remote_args=(./infra/scripts/vps-publisher-dispatch-rollout.sh "$action")
  if [[ "$apply" == "--apply" ]]; then
    remote_args+=(--apply)
  fi
  local remote_command
  remote_command="$(shell_quote_args "${remote_args[@]}")"
  if [[ "$action" == "disable" && "$apply" == "--apply" ]]; then
    # A failed publisher rollout deliberately leaves the webhook owner fence in place.
    # Guarded disable is the fixed recovery path and re-proves the exact image before adoption.
    MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1 \
      prepend_webhook_rollout_recovery_env remote_command
  else
    prepend_webhook_rollout_recovery_env remote_command
  fi
  remote_exec "$remote_command"
}

publisher_reader_mode_command() {
  local operation="${1:-}"
  case "$operation" in
    selection|rollup-noop) ;;
    *) echo 'Unknown Publisher reader mode operation.' >&2; return 2 ;;
  esac
  shift
  local mode="${1:-}" apply="${2:-}"
  if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && "$apply" != --apply ) ]]; then
    echo "Usage: $0 publisher-${operation}-rollout <off|test|5|25|100> [--apply]" >&2
    return 2
  fi
  case "$mode" in
    off|test|5|25|100) ;;
    *) echo 'Publisher reader mode rollout mode must be off, test, 5, 25, or 100.' >&2; return 2 ;;
  esac
  if [[ "${MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE:-0}" != 0 ]]; then
    echo 'Publisher reader mode rollout cannot adopt an interrupted release; recover that operation first.' >&2
    return 2
  fi
  local target_sha remote_command
  local remote_args=(./infra/scripts/vps-publisher-dispatch-rollout.sh "$operation" "$mode")
  [[ "$apply" != --apply ]] || remote_args+=(--apply)
  target_sha="$(git -C "$ROOT_DIR" rev-parse --verify HEAD)" || return
  # FLAG: Reader mode activation has no emergency bypass. Bind the reviewed exact source to
  # the remote manifest/image fence; the setter separately proves the installed consumer.
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" || return
  remote_command="$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" "${remote_args[@]}")"
  remote_exec "$remote_command"
}

publisher_selection_command() {
  publisher_reader_mode_command selection "$@"
}

major_networks_command() {
  local mode="${1:-}" apply="${2:-}"
  if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && "$apply" != --apply ) ]]; then
    echo 'Usage: major-networks-rollout <off|test|on> [--apply]' >&2; return 2
  fi
  case "$mode" in off|test|on) ;; *) echo 'Major networks mode must be off, test or on.' >&2; return 2 ;; esac
  if [[ "${MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE:-0}" != 0 ]]; then
    echo 'Recover the interrupted release before changing Major networks mode.' >&2; return 2
  fi
  local target_sha remote_command
  target_sha="$(git -C "$ROOT_DIR" rev-parse --verify HEAD)" || return
  # FLAG: This mode setter has no CI bypass and only targets the exact active image.
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" || return
  local remote_args=(./infra/scripts/vps-publisher-dispatch-rollout.sh networks "$mode")
  [[ "$apply" != --apply ]] || remote_args+=(--apply)
  remote_command="$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" "${remote_args[@]}")"
  remote_exec "$remote_command"
}

publisher_obsolete_retirement() {
  node --input-type=module - "$@" <<'VALIDATE_RETIREMENT'
import { parseRetirementArgs } from './infra/scripts/publisher-obsolete-retirement-host.mjs';
try { parseRetirementArgs(process.argv.slice(2)); }
catch { process.stderr.write('Invalid Publisher retirement request.\n'); process.exitCode = 2; }
VALIDATE_RETIREMENT
  local target_sha
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  # FLAG: Maintenance cancellation requires exact green tooling and a reviewed
  # private preview. It never enables the new runtime or bypasses effect fences.
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" >&2
  remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-publisher-obsolete-retirement.sh "$@")" </dev/null
}

publisher_rollup_noop_command() {
  publisher_reader_mode_command rollup-noop "$@"
}

vk_parsing_retire_legacy_queue() {
  if [[ $# -ne 0 ]] &&
    ! [[ $# -eq 1 && "$1" == "--apply" ]] &&
    ! [[ $# -eq 3 && "$1" == "--apply" && "$2" == "--reviewed-digest" && "$3" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Usage: $0 vk-parsing-retire-legacy-queue [--apply [--reviewed-digest <sha256>]]" >&2
    exit 2
  fi
  local remote_args=(./infra/scripts/vps-retire-legacy-vk-publish-queue.sh)
  remote_args+=("$@")
  remote_exec "$(shell_quote_args "${remote_args[@]}")"
}

fixed_moderator_preservation() {
  local action="${1:-}" target_sha plan_file digest
  shift || return 2
  target_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  case "$action" in
    explain)
      if [[ $# -ne 1 || ! "$1" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then return 2; fi
      node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" >&2
      remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-fixed-moderator-preservation.sh explain "$1")" </dev/null
      ;;
    preview)
      if [[ $# -gt 2 || ! "${1:-25}" =~ ^([1-9]|[1-9][0-9]|100)$ ||
          ( $# -eq 2 && ! "$2" =~ ^[A-Za-z0-9_-]{1,128}$ ) ]]; then
        echo 'Usage: fixed-moderator-preservation preview [limit [after]]' >&2
        return 2
      fi
      node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" >&2
      remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-fixed-moderator-preservation.sh preview "$@")" </dev/null
      ;;
    apply)
      if [[ $# -ne 2 || ! "$2" =~ ^[a-f0-9]{64}$ ]]; then
        echo 'Usage: fixed-moderator-preservation apply <private-0600-plan.json> <reviewed-sha256>' >&2
        return 2
      fi
      plan_file="$1"
      digest="$2"
      node "$ROOT_DIR/infra/scripts/fixed-moderator-preservation-plan.mjs" "$plan_file" "$target_sha" "$digest" >/dev/null
      node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$target_sha" >&2
      node "$ROOT_DIR/infra/scripts/fixed-moderator-preservation-plan.mjs" "$plan_file" "$target_sha" "$digest" |
        remote_exec "$(shell_quote_args env "MAXIM_EXPECTED_DEPLOY_SHA=$target_sha" bash ./infra/scripts/vps-fixed-moderator-preservation.sh apply "$digest")"
      ;;
    *) echo 'Expected fixed-moderator-preservation preview or apply' >&2; return 2 ;;
  esac
}

moderation_default_retire_legacy_queue() {
  local apply="${1:-}"
  if [[ -n "$apply" && "$apply" != "--apply" ]] || [[ $# -gt 1 ]]; then
    echo "Usage: $0 moderation-default-retire-legacy-queue [--apply]" >&2
    exit 2
  fi
  local remote_args=(./infra/scripts/vps-retire-legacy-default-webhook-queue.sh)
  if [[ "$apply" == "--apply" ]]; then
    remote_args+=(--apply)
  fi
  remote_exec "$(shell_quote_args "${remote_args[@]}")"
}

open_shell() {
  local args=()
  local remote_command

  maybe_allow_ssh_current_ip
  mapfile -d '' -t args < <(ssh_args)
  # Keep the shell lookup literal until the interactive command runs remotely.
  # shellcheck disable=SC2016
  printf -v remote_command 'cd %q && exec "${SHELL:-bash}"' "$MAXIM_VPS_REPO_DIR"
  ssh "${args[@]}" -t "$MAXIM_VPS_SSH_TARGET" "bash -lc $(printf '%q' "$remote_command")"
}

deploy_main() {
  local branch="${1:-main}"
  local expected_sha
  local remote_command
  local pool_flag
  shift || true

  case "${MAXIM_MESSAGE_RETENTION_MODE:-}" in
    ''|on|off) ;;
    *) echo 'MAXIM_MESSAGE_RETENTION_MODE must be on or off when supplied.' >&2; return 2 ;;
  esac
  case "${MAXIM_COMMERCIAL_LLM_ENFORCEMENT:-}" in
    ''|true|false) ;;
    *) echo 'MAXIM_COMMERCIAL_LLM_ENFORCEMENT must be true or false when supplied.' >&2; return 2 ;;
  esac
  for pool_flag in "${MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED:-}" "${MAXIM_COMMERCIAL_LLM_POOL_ENABLED:-}"; do
    case "$pool_flag" in
      ''|true|false) ;;
      *) echo 'Commercial AI pool deploy flags must be true or false when supplied.' >&2; return 2 ;;
    esac
  done
  case "${MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY:-}" in
    ''|confirm-positive|direct-4b) ;;
    *) echo 'MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY must be confirm-positive or direct-4b.' >&2; return 2 ;;
  esac
  case "${STATISTICS_EXCHANGE_V3_ENABLED:-}" in
    ''|true|false) ;;
    *) echo 'STATISTICS_EXCHANGE_V3_ENABLED must be true or false when supplied.' >&2; return 2 ;;
  esac
  if [[ -n "${MAXIM_STATISTICS_CENTRAL_EPOCH:-}" && ! "$MAXIM_STATISTICS_CENTRAL_EPOCH" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo 'MAXIM_STATISTICS_CENTRAL_EPOCH requires a canonical producer UUID.' >&2
    return 2
  fi
  maxim_validate_git_ssh_port "${MAXIM_DEPLOY_GIT_SSH_PORT:-default}"
  if ! expected_sha="$(git rev-parse --verify --end-of-options "${branch}^{commit}" 2>/dev/null)"; then
    echo "Cannot resolve local deploy branch to an exact commit: ${branch}" >&2
    exit 2
  fi

  case "${MAXIM_DEPLOY_EMERGENCY_BYPASS:-0}" in
    1|true|TRUE|yes|YES)
      if [[ -z "${MAXIM_DEPLOY_EMERGENCY_REASON:-}" ]]; then
        echo "MAXIM_DEPLOY_EMERGENCY_REASON is required with MAXIM_DEPLOY_EMERGENCY_BYPASS=1." >&2
        exit 2
      fi
      echo "Initial source gate exception: $MAXIM_DEPLOY_EMERGENCY_REASON. Registry delivery and the final production gate remain required." >&2
      ;;
    *)
      node scripts/ci/assert-green.mjs "$expected_sha" --purpose production || return
      ;;
  esac

  remote_command="$(shell_quote_args ./infra/scripts/vps-pull-build-up.sh "$branch" "$@")"
  remote_command="MAXIM_EXPECTED_DEPLOY_SHA=$(printf '%q' "$expected_sha") $remote_command"
  if [[ -n "${MAXIM_MESSAGE_RETENTION_MODE:-}" ]]; then
    remote_command="MAXIM_MESSAGE_RETENTION_MODE=$(printf '%q' "$MAXIM_MESSAGE_RETENTION_MODE") $remote_command"
  fi
  if [[ -n "${MAXIM_COMMERCIAL_LLM_ENFORCEMENT:-}" ]]; then
    remote_command="MAXIM_COMMERCIAL_LLM_ENFORCEMENT=$(printf '%q' "$MAXIM_COMMERCIAL_LLM_ENFORCEMENT") $remote_command"
  fi
  if [[ -n "${MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED:-}" ]]; then
    remote_command="MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED=$(printf '%q' "$MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED") $remote_command"
  fi
  if [[ -n "${MAXIM_COMMERCIAL_LLM_POOL_ENABLED:-}" ]]; then
    remote_command="MAXIM_COMMERCIAL_LLM_POOL_ENABLED=$(printf '%q' "$MAXIM_COMMERCIAL_LLM_POOL_ENABLED") $remote_command"
  fi
  if [[ -n "${MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY:-}" ]]; then
    remote_command="MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY=$(printf '%q' "$MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY") $remote_command"
  fi
  if [[ -n "${STATISTICS_EXCHANGE_V3_ENABLED:-}" ]]; then
    remote_command="STATISTICS_EXCHANGE_V3_ENABLED=$(printf '%q' "$STATISTICS_EXCHANGE_V3_ENABLED") $remote_command"
  fi
  if [[ -n "${MAXIM_STATISTICS_CENTRAL_EPOCH:-}" ]]; then
    remote_command="MAXIM_STATISTICS_CENTRAL_EPOCH=$(printf '%q' "$MAXIM_STATISTICS_CENTRAL_EPOCH") $remote_command"
  fi
  if [[ -n "${MAXIM_DEPLOY_EMERGENCY_REASON:-}" ]]; then
    remote_command="MAXIM_DEPLOY_EMERGENCY_REASON=$(printf '%q' "$MAXIM_DEPLOY_EMERGENCY_REASON") $remote_command"
  fi
  if [[ "$branch" != "main" ]]; then
    case "${MAXIM_ALLOW_NON_MAIN_DEPLOY:-0}" in
      1|true|TRUE|yes|YES)
        remote_command="MAXIM_ALLOW_NON_MAIN_DEPLOY=1 $remote_command"
        ;;
    esac
  fi
  case "${MAXIM_COMMERCIAL_OCR_BASELINE:-0}:${MAXIM_COMMERCIAL_OCR_OFF:-0}" in
    0:0) ;;
    1:0) remote_command="MAXIM_COMMERCIAL_OCR_BASELINE=1 $remote_command" ;;
    0:1) remote_command="MAXIM_COMMERCIAL_OCR_OFF=1 $remote_command" ;;
    *) echo "OCR baseline/off flags must be 0 or 1 and mutually exclusive." >&2; return 2 ;;
  esac
  prepend_webhook_rollout_recovery_env remote_command
  prepend_post_release_reclaim_env remote_command
  prepend_deploy_disk_floor_env remote_command
  prepend_deploy_ready_timeout_env remote_command
  maxim_prepend_git_ssh_transport remote_command "${MAXIM_DEPLOY_GIT_SSH_PORT:-default}"
  if [[ " $* " != *' --plan '* ]]; then
    prepare_registry_release_images "$branch" "$expected_sha" "$remote_command" || return
    node scripts/ci/assert-green.mjs "$expected_sha" --purpose production || return
  fi
  remote_exec "$remote_command"
}

prepare_registry_release_images() {
  local branch="$1" expected_sha="$2" runtime_command="$3"
  local sync_command plan_output plan_file component preparation_status
  local components=()
  # FLAG: Synchronize through the existing guarded plan/re-exec path before using
  # the new planner. Each SSH command must finish before its checkout may change.
  sync_command="MAXIM_EXPECTED_DEPLOY_SHA=$(printf '%q' "$expected_sha") $(shell_quote_args ./infra/scripts/vps-pull-build-up.sh "$branch" --plan)"
  if [[ "$branch" != main ]]; then
    case "${MAXIM_ALLOW_NON_MAIN_DEPLOY:-0}" in
      1|true|TRUE|yes|YES) sync_command="MAXIM_ALLOW_NON_MAIN_DEPLOY=1 $sync_command" ;;
      *) echo 'Non-main image preparation requires the existing explicit deploy opt-in.' >&2; return 2 ;;
    esac
  fi
  maxim_prepend_git_ssh_transport sync_command "${MAXIM_DEPLOY_GIT_SSH_PORT:-default}"
  # FLAG: Report fixed phase names and exit statuses only. Captured machine output,
  # commands and environment may contain private data and must never enter diagnostics.
  printf 'Release preparation: phase=source-sync status=started\n' >&2
  if remote_exec "$sync_command"; then
    printf 'Release preparation: phase=source-sync status=complete\n' >&2
  else
    preparation_status=$?
    printf 'Release preparation: phase=source-sync status=failed exit=%s\n' "$preparation_status" >&2
    return "$preparation_status"
  fi
  printf 'Release preparation: phase=image-plan status=started\n' >&2
  if plan_output="$(remote_exec "$runtime_command --image-plan")"; then
    printf 'Release preparation: phase=image-plan status=complete\n' >&2
  else
    preparation_status=$?
    printf 'Release preparation: phase=image-plan status=failed exit=%s\n' "$preparation_status" >&2
    return "$preparation_status"
  fi
  printf 'Release preparation: phase=plan-parse status=started\n' >&2
  if plan_file="$(mktemp /tmp/maxim-release-image-plan.XXXXXX)"; then
    :
  else
    preparation_status=$?
    printf 'Release preparation: phase=plan-parse status=failed exit=%s\n' "$preparation_status" >&2
    return "$preparation_status"
  fi
  if printf '%s\n' "$plan_output" | node infra/scripts/registry-preload.mjs plan "$expected_sha" >"$plan_file" &&
    mapfile -t components <"$plan_file"; then
    if rm -f "$plan_file"; then
      printf 'Release preparation: phase=plan-parse status=complete\n' >&2
    else
      preparation_status=$?
      printf 'Release preparation: phase=plan-parse status=failed exit=%s\n' "$preparation_status" >&2
      return "$preparation_status"
    fi
  else
    preparation_status=$?
    rm -f "$plan_file" || true
    printf 'Release preparation: phase=plan-parse status=failed exit=%s\n' "$preparation_status" >&2
    return "$preparation_status"
  fi
  for component in "${components[@]}"; do
    printf 'Release preparation: phase=image-preload status=started component=%s\n' "$component" >&2
    if preload_ci_image "$component" "$expected_sha"; then
      printf 'Release preparation: phase=image-preload status=complete component=%s\n' "$component" >&2
    else
      preparation_status=$?
      printf 'Release preparation: phase=image-preload status=failed exit=%s component=%s\n' "$preparation_status" "$component" >&2
      return "$preparation_status"
    fi
  done
}

finalize_release_recovery() {
  local branch="main"
  local expected_sha
  local runtime_sha=""
  local api_only=0
  local remote_command
  local finalizer_args=()

  if [[ "$#" -gt 0 && "$1" != --* ]]; then
    branch="$1"
    shift
  fi
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --runtime-sha)
        if [[ "$#" -lt 2 || -n "$runtime_sha" || ! "$2" =~ ^[0-9a-f]{40}$ ]]; then
          echo "Recovery finalization requires one exact runtime Git SHA." >&2
          exit 2
        fi
        runtime_sha="$2"
        shift 2
        ;;
      --api-only)
        [[ "$api_only" -eq 0 ]] || { echo "Duplicate API-only recovery option." >&2; exit 2; }
        api_only=1
        shift
        ;;
      *)
        echo "Usage: $0 finalize-release-recovery [branch] [--runtime-sha <sha>] [--api-only]" >&2
        exit 2
        ;;
    esac
  done
  if ! expected_sha="$(git rev-parse --verify --end-of-options "${branch}^{commit}" 2>/dev/null)"; then
    echo "Cannot resolve local recovery branch to an exact commit: $branch" >&2
    exit 2
  fi
  if [[ ! "$expected_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Recovery finalization requires a full lowercase Git SHA." >&2
    exit 2
  fi
  runtime_sha="${runtime_sha:-$expected_sha}"
  if [[ ! "$runtime_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Recovery finalization requires an exact runtime Git SHA." >&2
    exit 2
  fi

  node scripts/ci/assert-green.mjs "$expected_sha" || return
  if [[ "$runtime_sha" != "$expected_sha" ]]; then
    node scripts/ci/assert-green.mjs "$runtime_sha" || return
  fi

  finalizer_args=(./infra/scripts/vps-finalize-release-recovery.sh "$branch")
  if [[ "$api_only" -eq 1 ]]; then
    finalizer_args+=(--api-only)
  fi
  remote_command="$(shell_quote_args "${finalizer_args[@]}")"
  remote_command="MAXIM_FINALIZER_RUNTIME_SHA=$(printf '%q' "$runtime_sha") $remote_command"
  remote_command="MAXIM_EXPECTED_DEPLOY_SHA=$(printf '%q' "$expected_sha") $remote_command"
  if [[ "$branch" != "main" && "${MAXIM_ALLOW_NON_MAIN_DEPLOY:-0}" == "1" ]]; then
    remote_command="MAXIM_ALLOW_NON_MAIN_DEPLOY=1 $remote_command"
  fi
  remote_exec "$remote_command"
}

eraser_bootstrap() {
  local request_file="${1:-}" source_sha
  [[ "$#" -eq 1 ]] || { echo 'Usage: eraser-bootstrap <private-0600-request.json>|--stores-only' >&2; return 2; }
  source_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)" || return
  if [[ "$request_file" != --stores-only ]]; then
    node "$ROOT_DIR/infra/scripts/eraser-bootstrap.mjs" validate "$request_file" || return
  fi
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$source_sha" || return
  if [[ "$request_file" == --stores-only ]]; then
    remote_exec "$(shell_quote_args bash ./infra/scripts/vps-eraser-bootstrap.sh "$source_sha" --stores-only)"
  else
    remote_exec "$(shell_quote_args bash ./infra/scripts/vps-eraser-bootstrap.sh "$source_sha")" <"$request_file"
  fi
}

eraser_webhook() {
  [[ "$#" -eq 0 ]] || { echo 'Usage: eraser-webhook' >&2; return 2; }
  local source_sha
  source_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)" || return
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$source_sha" || return
  remote_exec "$(shell_quote_args bash ./infra/scripts/vps-eraser-webhook.sh "$source_sha")"
}

eraser_nginx() {
  [[ "$#" -eq 0 || ( "$#" -eq 1 && "$1" == --apply ) ]] || { echo 'Usage: eraser-nginx [--apply]' >&2; return 2; }
  local source_sha
  source_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)" || return
  node "$ROOT_DIR/scripts/ci/assert-green.mjs" "$source_sha" || return
  remote_exec "$(shell_quote_args bash ./infra/scripts/vps-eraser-nginx.sh "$source_sha" "$@")"
}

preload_ci_image() (
  local component="${1:-}"
  local ref="${2:-HEAD}"
  local artifact_component
  local exact_sha
  local request_file
  local preload_command
  local remote_script

  case "$component" in
    api|api-shared) artifact_component="api" ;;
    miniapp|miniapp-major-static) artifact_component="miniapp" ;;
    admin|admin-static) artifact_component="admin" ;;
    eraser) artifact_component="eraser" ;;
    *) echo "Component must be one of: api, miniapp, admin, eraser." >&2; exit 2 ;;
  esac
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh not found" >&2
    exit 1
  fi
  if ! exact_sha="$(git rev-parse --verify --end-of-options "${ref}^{commit}" 2>/dev/null)" ||
    [[ ! "$exact_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Cannot resolve registry image ref to an exact commit: $ref" >&2
    exit 2
  fi
  request_file="$(mktemp /tmp/maxim-registry-preload.XXXXXX)" || exit $?
  trap 'rm -f "$request_file"' EXIT
  # FLAG: The caller invokes this function in an OR-list, which disables errexit
  # inside the subshell. Proof and pull failures must explicitly stop delivery.
  node infra/scripts/registry-preload.mjs "$artifact_component" "$exact_sha" --prepare-missing >"$request_file" || exit $?

  remote_script=$(cat <<'REMOTE'
set -euo pipefail
source infra/scripts/lib/deploy-lock.sh
acquire_deploy_lock
require_deploy_lock
if [[ "$(git rev-parse HEAD)" != "$MAXIM_PRELOAD_EXPECTED_SHA" ]] || ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Registry preload needs the clean exact reviewed controller; synchronize it with deploy --plan first.' >&2
  exit 1
fi
node infra/scripts/registry-preload-host.mjs pull "$MAXIM_PRELOAD_COMPONENT" "$MAXIM_PRELOAD_EXPECTED_SHA"
REMOTE
  )
  preload_command="$(shell_quote_args env "MAXIM_PRELOAD_COMPONENT=$artifact_component" "MAXIM_PRELOAD_EXPECTED_SHA=$exact_sha" bash -c "$remote_script")" || exit $?
  remote_exec "$preload_command" <"$request_file" || exit $?
  rm -f "$request_file" || exit $?
  trap - EXIT
)

deploy_scale() {
  local branch="${1:-main}"
  shift || true

  case "${MAXIM_ALLOW_SCALE_DEPLOY:-0}" in
    1|true|TRUE|yes|YES)
      ;;
    *)
      echo "deploy-scale is loadtest-only and can stop the main infra stack. Set MAXIM_ALLOW_SCALE_DEPLOY=1 to continue." >&2
      exit 2
      ;;
  esac

  # shellcheck source=infra/scripts/lib/scale-deploy-profile.sh
  source "$ROOT_DIR/infra/scripts/lib/scale-deploy-profile.sh" || return
  maxim_scale_require_connection_profile \
    "$SCALE_ENV_FILE_FROM_CALLER" "$ROOT_DIR/.env.vps" \
    "$SCALE_SSH_TARGET_FROM_PROFILE" "$SCALE_REPO_DIR_FROM_PROFILE" "$SCALE_PUBLIC_URL_FROM_PROFILE" || return
  local MAXIM_VPS_AUTO_AUTHORIZE_SSH=0
  remote_exec "$(shell_quote_args env \
    MAXIM_ALLOW_SCALE_DEPLOY=1 \
    "MAXIM_SCALE_DEPLOY_PROFILE=$MAXIM_SCALE_DEPLOY_PROFILE" \
    "MAXIM_SCALE_EXPECTED_MACHINE_ID=$MAXIM_SCALE_EXPECTED_MACHINE_ID" \
    "MAXIM_SCALE_EXPECTED_REPO_DIR=$SCALE_REPO_DIR_FROM_PROFILE" \
    "MAXIM_VPS_PUBLIC_URL=$SCALE_PUBLIC_URL_FROM_PROFILE" \
    ./infra/scripts/vps-pull-build-up-scale.sh "$branch" "$@")"
}

rollback_runtime() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: $0 rollback-runtime <git-ref> [services...]"
    exit 1
  fi

  local remote_command
  build_guarded_rollback_command \
    remote_command \
    ./infra/scripts/vps-runtime-rollback.sh \
    maxim_topology_require_statistics_and_night_mode_recovery \
    "$@"
  prepend_webhook_rollout_recovery_env remote_command
  remote_exec "$remote_command"
}

rollback_release() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: $0 rollback-release <release-id> [api-shared] [miniapp-major-static] [admin-static] [eraser]"
    exit 1
  fi

  local remote_command
  local capability_marker=select_release_recovery_base
  local rollback_component
  # FLAG: API rollback retains LOCAL_REJOIN enforcement and local release in addition
  # to statistics successors and independent night-mode recovery,
  # plus maxim_topology_require_commercial_ai_pool_delete_reader and preceding floors.
  # Static-only rollback keeps its existing image-only offline path.
  if [[ $# -eq 1 ]]; then
    capability_marker=maxim_topology_require_statistics_and_night_mode_recovery
  else
    for rollback_component in "${@:2}"; do
      if [[ "$rollback_component" == api-shared ]]; then
        capability_marker=maxim_topology_require_statistics_and_night_mode_recovery
        break
      fi
    done
  fi
  build_guarded_rollback_command \
    remote_command \
    ./infra/scripts/vps-release-rollback.sh \
    "$capability_marker" \
    "$@"
  prepend_webhook_rollout_recovery_env remote_command
  remote_exec "$remote_command"
}

health() {
  remote_exec 'curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/live && printf "\n" && curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/ready && printf "\n" && curl -fsS --max-time 15 http://127.0.0.1:3002/api/health/live && printf "\n" && curl -fsS --max-time 15 http://127.0.0.1:3002/api/health/ready && printf "\n"'
  curl -fsS --max-time 15 "$MAXIM_VPS_PUBLIC_URL/api/health/live"
  printf '\n'
}

install_publisher_secrets() (
  set -euo pipefail
  if [[ $# -gt 1 ]]; then
    echo "Usage: $0 install-publisher-secrets [token-file]" >&2
    exit 2
  fi

  local token_file="${1:-$ROOT_DIR/token}"
  local token_mode
  local bundle_dir
  local remote_command
  local remote_script
  local args=()

  token_file="$(expand_path "$token_file")"
  if [[ ! -f "$token_file" || -L "$token_file" ]]; then
    echo "Publisher token file must be a regular non-symlink file." >&2
    exit 1
  fi
  token_mode="$(stat -c '%a' "$token_file" 2>/dev/null || stat -f '%Lp' "$token_file" 2>/dev/null || true)"
  if [[ "$token_mode" != "600" ]]; then
    echo "Publisher token file must have mode 0600." >&2
    exit 1
  fi

  bundle_dir="$(mktemp -d)"
  trap 'rm -rf -- "$bundle_dir"' EXIT
  node "$ROOT_DIR/infra/scripts/publisher-secret-bundle.mjs" pack \
    "$token_file" \
    "${MAX_PUBLISHER_BOT_ID:-se14088825_bot}" \
    "$bundle_dir/bundle.json"
  cp "$ROOT_DIR/infra/scripts/publisher-secret-bundle.mjs" "$bundle_dir/installer.mjs"
  chmod 0600 "$bundle_dir/installer.mjs"

  read -r -d '' remote_script <<'REMOTE' || true
set -euo pipefail
umask 077
stage="$(mktemp -d)"
target=/var/lib/maxim-secrets
suffix="new.$$"
cleanup() {
  rm -rf -- "$stage"
  rm -f -- "$target/publik-bot-token.$suffix" "$target/publik-webhook.json.$suffix" "$target/publik-init-data-keys.json.$suffix" "$target/publik-dialog-signing-keys.json.$suffix"
}
trap cleanup EXIT
tar -xf - -C "$stage" --no-same-owner --no-same-permissions
node "$stage/installer.mjs" stage "$stage/bundle.json" "$stage/output"
legacy_names=(publik-bot-token publik-webhook.json publik-init-data-keys.json)
dialog_name=publik-dialog-signing-keys.json
names=()
exec 9>/tmp/maxim-publisher-secret-install.lock
flock -n 9 || { echo "Another publisher secret installation is running." >&2; exit 1; }
legacy_count=0
for name in "${legacy_names[@]}"; do
  if sudo -n test -e "$target/$name"; then
    legacy_count=$((legacy_count + 1))
  fi
done
dialog_exists=0
sudo -n test -e "$target/$dialog_name" && dialog_exists=1
if [[ "$legacy_count" -eq 0 && "$dialog_exists" -eq 0 ]]; then
  names=("${legacy_names[@]}" "$dialog_name")
elif [[ "$legacy_count" -eq 3 && "$dialog_exists" -eq 0 ]]; then
  sudo -n cmp -s "$target/publik-bot-token" "$stage/output/publik-bot-token" || {
    echo "Publisher token differs from installed credentials; use a reviewed rotation procedure." >&2
    exit 1
  }
  names=("$dialog_name")
else
  echo "Publisher secrets already exist or are incomplete; use a reviewed rotation procedure." >&2
  exit 1
fi
sudo -n install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$target"
for name in "${names[@]}"; do
  install -m 0600 "$stage/output/$name" "$target/$name.$suffix"
done
for name in "${names[@]}"; do
  mv "$target/$name.$suffix" "$target/$name"
done
printf '%s\n' 'Publisher secrets installed.'
REMOTE
  printf -v remote_command 'cd %q && bash -c %q' "$MAXIM_VPS_REPO_DIR" "$remote_script"
  mapfile -d '' -t args < <(ssh_args)
  # The fully quoted remote command is intentionally expanded by the local wrapper.
  # shellcheck disable=SC2029
  tar -C "$bundle_dir" -cf - installer.mjs bundle.json |
    ssh "${args[@]}" "$MAXIM_VPS_SSH_TARGET" \
      "bash -lc $(printf '%q' "$remote_command")"
)

doctor() {
  local args=()

  if ! command -v ssh >/dev/null 2>&1; then
    echo "ssh not found"
    exit 1
  fi

  maybe_allow_ssh_current_ip
  mapfile -d '' -t args < <(ssh_args)

  echo "Config:"
  echo "  env_file=$ENV_FILE"
  echo "  ssh_target=$MAXIM_VPS_SSH_TARGET"
  echo "  repo_dir=$MAXIM_VPS_REPO_DIR"
  echo "  public_url=$MAXIM_VPS_PUBLIC_URL"
  echo

  ssh "${args[@]}" -o BatchMode=yes -o ConnectTimeout=10 "$MAXIM_VPS_SSH_TARGET" \
    "cd $(printf '%q' "$MAXIM_VPS_REPO_DIR") && printf 'remote_repo=%s\n' \"\$PWD\" && git rev-parse --short HEAD && docker compose version"
}

ensure_ssh() {
  allow_ssh_current_ip "$@"
  doctor
}

yc_shell() {
  local args=(compute ssh --public-address)

  if ! command -v yc >/dev/null 2>&1; then
    echo "yc not found"
    exit 1
  fi

  if [[ -n "${MAXIM_YC_PROFILE:-}" ]]; then
    args=(--profile "$MAXIM_YC_PROFILE" "${args[@]}")
  fi

  if [[ -n "${MAXIM_YC_VM_ID:-}" ]]; then
    args+=(--id "$MAXIM_YC_VM_ID")
  elif [[ -n "${MAXIM_YC_VM_NAME:-}" ]]; then
    args+=(--name "$MAXIM_YC_VM_NAME")
  else
    echo "Set MAXIM_YC_VM_NAME or MAXIM_YC_VM_ID in .env.vps."
    exit 1
  fi

  if [[ -n "${MAXIM_YC_LOGIN:-}" ]]; then
    args+=(--login "$MAXIM_YC_LOGIN")
  fi

  if [[ -n "${MAXIM_YC_IDENTITY_FILE:-}" ]]; then
    args+=(-i "$(expand_path "$MAXIM_YC_IDENTITY_FILE")")
  fi

  yc "${args[@]}"
}

command="${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi

# FLAG: Extend only the exact CPU bridge after the installed protected prefix.
# Preserve legacy dispatch bytes and reject extra arguments before any remote execution.
if [[ "$command" == commercial-llm && "${1:-}" == workstation-pool-bridge && "${2:-}" == pc-a-cpu-9b ]]; then
  if [[ $# -ne 2 ]]; then
    echo 'Usage: commercial-llm workstation-pool-bridge pc-a-cpu-9b' >&2
    exit 2
  fi
  remote_exec "$(shell_quote_args bash ./infra/scripts/vps-commercial-llm.sh workstation-pool-bridge pc-a-cpu-9b)"
  exit $?
fi

case "$command" in
  pair-release-state)
    [[ "$#" == 0 ]] || exit 2
    remote_exec 'timeout 12 bash /var/lib/major-karavan-release/admission.sh state'
    ;;
  reconcile-pair-release-admission)
    [[ "$#" == 5 || "$#" == 6 ]] || exit 2
    remote_exec "$(shell_quote_args timeout 20 bash /var/lib/major-karavan-release/admission.sh reconcile "$@")"
    ;;
  recover-pair-backup-refusal)
    recover_pair_backup_refusal "$@"
    ;;
  recover-pair-backup-activation)
    recover_pair_backup_activation "$@"
    ;;
  install-pair-release-admission)
    install_pair_release_admission "$@"
    ;;
  verify-pair-release-admission)
    [[ "$#" == 0 || "$#" == 1 ]] && [[ "${1:-maximadmin}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || exit 2
    # shellcheck disable=SC2016
    remote_exec "$(shell_quote_args timeout 20 bash -c 'set -euo pipefail; [[ "$(id -un)" == "$1" ]]; bash /var/lib/major-karavan-release/admission.sh verify; cmp -s /var/www/Chat_bot/infra/scripts/lib/pair-release-admission.sh /var/lib/major-karavan-release/admission.sh; cmp -s /var/www/max-delivery-platform/infra/scripts/pair-release-admission.sh /var/lib/major-karavan-release/admission.sh; cmp -s /var/www/Chat_bot/infra/scripts/pair-release-state.mjs /var/lib/major-karavan-release/state.mjs; cmp -s /var/www/max-delivery-platform/infra/scripts/pair-release-state.mjs /var/lib/major-karavan-release/state.mjs; bash /var/lib/major-karavan-release/admission.sh state' verify "${1:-maximadmin}")"
    ;;
  doctor)
    doctor
    ;;
  shell)
    require_database_break_glass 'interactive VPS shell'
    open_shell
    ;;
  exec)
    remote_from_args "$@"
    ;;
  deploy)
    deploy_main "$@"
    ;;
  eraser-bootstrap)
    eraser_bootstrap "$@"
    ;;
  eraser-webhook)
    eraser_webhook "$@"
    ;;
  eraser-nginx)
    eraser_nginx "$@"
    ;;
  preload-ci-image)
    preload_ci_image "$@"
    ;;
  commercial-llm)
    commercial_llm "$@"
    ;;
  support-chat)
    support_chat "$@"
    ;;
  deploy-scale)
    deploy_scale "$@"
    ;;
  finalize-release-recovery)
    finalize_release_recovery "$@"
    ;;
  install-deploy-flock)
    install_deploy_flock "$@"
    ;;
  cancel-webhook-backlog)
    cancel_webhook_backlog "$@"
    ;;
  preview-webhook-backlog)
    preview_webhook_backlog "$@"
    ;;
  legacy-cold-recovery)
    legacy_cold_recovery "$@"
    ;;
  source-abandonment)
    source_abandonment "$@"
    ;;
  source-abandonment-corrective)
    source_abandonment_corrective "$@"
    ;;
  rollback-runtime)
    rollback_runtime "$@"
    ;;
  rollback-release)
    rollback_release "$@"
    ;;
  allow-ssh-current-ip)
    allow_ssh_current_ip "$@"
    ;;
  ensure-ssh)
    ensure_ssh "$@"
    ;;
  health)
    health
    ;;
  monitor-readonly)
    "$ROOT_DIR/infra/scripts/vps-monitor-readonly.sh" "$@"
    ;;
  postgres-audit)
    # FLAG: Extend dispatch after the installed protected prefix. Its immutable
    # source floor must remain intact for existing release and recovery operations.
    if [[ "${1:-}" == 'chat-moderation' ]]; then
      node "$ROOT_DIR/infra/scripts/chat-moderation-audit.mjs" --validate-scope "${@:2}" >/dev/null || exit 2
      remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh "$@")"
    elif [[ "${1:-}" == 'action-latency' ]]; then
      shift
      if [[ "$#" -gt 1 || ( "$#" == 1 && "$1" != '--explain' ) ]]; then
        echo 'Usage: postgres-audit action-latency [--explain]' >&2
        exit 2
      fi
      remote_exec "$(shell_quote_args ./infra/scripts/vps-postgres-audit.sh action-latency "$@")"
    else
      postgres_audit "$@"
    fi
    ;;
  postgres-audit-provision)
    postgres_audit_provision "$@"
    ;;
  recover-publication-post-actions-migration)
    recover_publication_post_actions_migration "$@"
    ;;
  recover-suggestion-subscription-migration)
    recover_suggestion_subscription_migration "$@"
    ;;
  recover-publication-priority-migration)
    recover_publication_priority_migration "$@"
    ;;
  recover-publisher-catalog-migration)
    recover_publisher_catalog_migration "$@"
    ;;
  recover-message-retention-migration)
    recover_message_retention_migration "$@"
    ;;
  recover-multibot-preparation)
    recover_multibot_preparation "$@"
    ;;
  recover-publisher-access-migration)
    recover_publisher_access_migration "$@"
    ;;
  commercial-ocr-promote)
    commercial_ocr_promote "$@"
    ;;
  commercial-ocr-downgrade)
    commercial_ocr_downgrade "$@"
    ;;
  commercial-ocr-status)
    commercial_ocr_status "$@"
    ;;
  commercial-ocr-recover-shadow)
    commercial_ocr_recover_shadow "$@"
    ;;
  publisher-dispatch-enable)
    publisher_dispatch_command enable "$@"
    ;;
  publisher-dispatch-disable)
    publisher_dispatch_command disable "$@"
    ;;
  publisher-dispatch-status)
    publisher_dispatch_command status "$@"
    ;;
  publisher-obsolete-retirement)
    publisher_obsolete_retirement "$@"
    ;;
  publisher-selection-rollout)
    publisher_selection_command "$@"
    ;;
  major-networks-rollout)
    major_networks_command "$@"
    ;;
  publisher-rollup-noop-rollout)
    publisher_rollup_noop_command "$@"
    ;;
  vk-parsing-retire-legacy-queue)
    vk_parsing_retire_legacy_queue "$@"
    ;;
  fixed-moderator-preservation)
    fixed_moderator_preservation "$@"
    ;;
  moderation-default-retire-legacy-queue)
    moderation_default_retire_legacy_queue "$@"
    ;;
  install-publisher-secrets)
    install_publisher_secrets "$@"
    ;;
  ps)
    remote_exec "$(shell_quote_args docker compose --env-file .env -p infra -f infra/docker-compose.yml ps "$@")"
    ;;
  logs)
    if [[ $# -lt 1 ]]; then
      echo "Usage: $0 logs <service> [tail]"
      exit 1
    fi
    service="$1"
    tail="${2:-200}"
    remote_exec "$(shell_quote_args docker compose --env-file .env -p infra -f infra/docker-compose.yml logs --tail "$tail" "$service")"
    ;;
  yc-shell)
    require_database_break_glass 'interactive Yandex VPS shell'
    yc_shell
    ;;
  -h|--help|help|'')
    usage
    echo '  postgres-audit chat-moderation <chat-id> [--explain]'
    echo '  postgres-audit action-latency [--explain]'
    echo '  commercial-llm workstation-pool-bridge pc-a-cpu-9b'
    ;;
  *)
    echo "Unknown command: $command"
    usage
    exit 1
    ;;
esac
