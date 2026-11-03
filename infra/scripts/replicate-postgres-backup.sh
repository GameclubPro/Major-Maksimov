#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=infra/scripts/lib/postgres-backup-profile.sh
source "$ROOT_DIR/infra/scripts/lib/postgres-backup-profile.sh"

# FLAG: Only ciphertext leaves the backup volume. An upload/HEAD is not verification:
# the receipt is published only after a complete independent object readback matches.
DUMP_PATH="${1:?Usage: replicate-postgres-backup.sh /absolute/path/maxim_TIMESTAMP.dump}"
RECIPIENTS="${MAXIM_BACKUP_AGE_RECIPIENTS:?Configure a public age recipients file}"
RCLONE_CONFIG="${MAXIM_BACKUP_RCLONE_CONFIG:?Configure a dedicated MAXIM rclone file}"
REMOTE_PREFIX="${MAXIM_BACKUP_REMOTE_PREFIX:?Configure the MAXIM backup object prefix}"
while [[ "$REMOTE_PREFIX" == */ ]]; do REMOTE_PREFIX="${REMOTE_PREFIX%/}"; done
MIN_FREE_BYTES="${MAXIM_BACKUP_MIN_FREE_BYTES:-17179869184}"
TIMEOUT_SEC="${MAXIM_BACKUP_REPLICATION_TIMEOUT_SEC:-21600}"
BW_LIMIT="${MAXIM_BACKUP_REPLICATION_BYTES_PER_SEC:-16777216}"

[[ "$DUMP_PATH" == /* && -f "$DUMP_PATH" && ! -L "$DUMP_PATH" && -s "$DUMP_PATH" ]]
[[ "$(basename "$DUMP_PATH")" =~ ^${MAXIM_BACKUP_PREFIX}_[0-9]{8}T[0-9]{6}Z\.dump$ ]]
[[ "$REMOTE_PREFIX" =~ ^[a-zA-Z0-9_-]+:[a-zA-Z0-9_/-]+$ ]]
[[ -r "$RECIPIENTS" && -r "$RCLONE_CONFIG" ]]
[[ "$MIN_FREE_BYTES" =~ ^[0-9]+$ && "$TIMEOUT_SEC" =~ ^[0-9]+$ && "$BW_LIMIT" =~ ^[0-9]+$ ]]
(( MIN_FREE_BYTES >= 1048576 && TIMEOUT_SEC >= 1 && TIMEOUT_SEC <= 21600 && BW_LIMIT >= 1 && BW_LIMIT <= 33554432 ))
for command in age rclone sha256sum timeout flock node; do command -v "$command" >/dev/null; done

if [[ "$MAXIM_BACKUP_PROFILE" == eraser ]]; then REMOTE_PREFIX="${REMOTE_PREFIX%/}/eraser"; fi
DEADLINE=$((SECONDS + TIMEOUT_SEC))
run_bounded() {
  local remaining=$((DEADLINE - SECONDS))
  (( remaining > 0 )) || return 124
  timeout --signal=TERM --kill-after=30s "${remaining}s" "$@"
}
BACKUP_DIR="$(dirname "$DUMP_PATH")"
exec {REPLICATION_LOCK_FD}>>"$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}-independent-backup.lock"
flock -n "$REPLICATION_LOCK_FD" || exit 75
# FLAG: Check only this exact archive; a sidecar naming another file proves nothing.
[[ -f "$DUMP_PATH.sha256" && ! -L "$DUMP_PATH.sha256" ]]
(( $(stat -c %s "$DUMP_PATH.sha256") <= 256 ))
CHECKSUM_LINE="$(cat "$DUMP_PATH.sha256")"
EXPECTED_SHA="${CHECKSUM_LINE:0:64}"
# FLAG: Scheduled recovery binds the existing archive to its persisted identity.
# This same deadline-bound checksum pass remains the sole full local verification.
if [[ -n "${MAXIM_BACKUP_EXPECTED_SHA256:-}" ]]; then
  [[ "$MAXIM_BACKUP_EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ && "$EXPECTED_SHA" == "$MAXIM_BACKUP_EXPECTED_SHA256" ]]
fi
[[ "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ && "$CHECKSUM_LINE" == "$EXPECTED_SHA  $(basename "$DUMP_PATH")" ]]
(cd "$BACKUP_DIR" && run_bounded sha256sum --check --status "$(basename "$DUMP_PATH").sha256")
DUMP_BYTES="$(stat -c %s "$DUMP_PATH")"
FREE_BYTES="$(df -PB1 "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
(( FREE_BYTES > DUMP_BYTES + DUMP_BYTES / 100 + MIN_FREE_BYTES ))

CIPHER="$(mktemp "$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}-independent.XXXXXX.age")"
READBACK_HASH="$(mktemp "$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}-independent.XXXXXX.hash")"
RECEIPT="$(mktemp "$BACKUP_DIR/.${MAXIM_BACKUP_PREFIX}-independent.XXXXXX.json")"
cleanup() { rm -f -- "$CIPHER" "$READBACK_HASH" "$RECEIPT"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
run_bounded age --recipients-file "$RECIPIENTS" --output "$CIPHER" "$DUMP_PATH"
CIPHER_SHA="$(run_bounded sha256sum "$CIPHER" | cut -d' ' -f1)"
CIPHER_BYTES="$(stat -c %s "$CIPHER")"
REMOTE_OBJECT="$REMOTE_PREFIX/$(basename "$DUMP_PATH").$CIPHER_SHA.age"
RCLONE_ARGS=(--config "$RCLONE_CONFIG" --bwlimit "${BW_LIMIT}b" --retries 1 --low-level-retries 2 --contimeout 15s --timeout 60s)
run_bounded rclone copyto "$CIPHER" "$REMOTE_OBJECT" --immutable "${RCLONE_ARGS[@]}"
run_bounded rclone cat "$REMOTE_OBJECT" "${RCLONE_ARGS[@]}" | sha256sum >"$READBACK_HASH"
[[ "$(cut -d' ' -f1 "$READBACK_HASH")" == "$CIPHER_SHA" ]]
node - "$DUMP_PATH" "$CIPHER_SHA" "$CIPHER_BYTES" "$REMOTE_OBJECT" "$MAXIM_BACKUP_PROFILE" >"$RECEIPT" <<'JS'
const fs = require('node:fs');
const [dump, cipherSha256, cipherBytes, remoteObject, profile] = process.argv.slice(2);
const dumpSha256 = fs.readFileSync(`${dump}.sha256`, 'utf8').split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(dumpSha256)) throw new Error('Invalid dump checksum');
process.stdout.write(JSON.stringify({ schemaVersion: 1, profile, verifiedAt: new Date().toISOString(),
  dump: require('node:path').basename(dump), dumpSha256, cipherSha256,
  cipherBytes: Number(cipherBytes), remoteObject, verification: 'full_ciphertext_readback' }) + '\n');
JS
run_bounded rclone copyto "$RECEIPT" "$REMOTE_OBJECT.verified.json" --immutable "${RCLONE_ARGS[@]}"
mv "$RECEIPT" "$DUMP_PATH.remote-verified.json"
echo 'Independent encrypted PostgreSQL backup verified by complete readback.'
