#!/usr/bin/env bash

MAXIM_RESTORE_VOLUME_BYTES=0
if [[ "$MAXIM_BACKUP_PROFILE" == maxim ]]; then
  MAXIM_RESTORE_VOLUME_BYTES="${MAXIM_RESTORE_SMOKE_MAXIM_LOOP_BYTES:-0}"
else
  MAXIM_RESTORE_VOLUME_BYTES="${MAXIM_RESTORE_SMOKE_ERASER_LOOP_BYTES:-0}"
fi
if [[ ! "$MAXIM_RESTORE_VOLUME_BYTES" =~ ^[0-9]+$ ]]; then
  echo 'Invalid profile restore loop size.' >&2
  exit 2
fi
MAXIM_RESTORE_VOLUME_ROOT="${MAXIM_RESTORE_SMOKE_LOOP_ROOT:-/var/lib/maxim-restore-volumes}"
MAXIM_RESTORE_VOLUME_OPERATION="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
BACKING_MIN_FREE_BYTES="$MIN_FREE_BYTES"
if [[ "$MAXIM_RESTORE_VOLUME_BYTES" != 0 ]]; then
  if ((${#REQUIRED_PERCENT} > 4 || ${#MIN_FREE_BYTES} > 13)); then
    echo 'Restore loop capacity limits exceed safe integer bounds.' >&2
    exit 2
  fi
  REQUIRED_PERCENT=$((10#$REQUIRED_PERCENT))
  MIN_FREE_BYTES=$((10#$MIN_FREE_BYTES))
  if ((REQUIRED_PERCENT < 125)); then REQUIRED_PERCENT=125; fi
  BACKING_MIN_FREE_BYTES="$MIN_FREE_BYTES"
  if ((BACKING_MIN_FREE_BYTES < 42949672960)); then BACKING_MIN_FREE_BYTES=42949672960; fi
fi

maxim_restore_volume_action() {
  node "$ROOT_DIR/infra/scripts/lib/postgres-restore-volume.mjs" "$1" \
    "$MAXIM_BACKUP_PROFILE" "$MAXIM_RESTORE_VOLUME_ROOT" "$MAXIM_RESTORE_VOLUME_OPERATION" \
    "$MAXIM_RESTORE_VOLUME_BYTES" "$DATABASE_BYTES" "$REQUIRED_PERCENT" "$MIN_FREE_BYTES" \
    "$BACKING_FILESYSTEM_PATH" "${2:-}" "${3:-}" "${4:-}"
}

maxim_restore_volume_value() {
  node -e 'const value=JSON.parse(process.argv[1])[process.argv[2]]; if(typeof value!=="string")process.exit(1); process.stdout.write(value)' "$1" "$2"
}
