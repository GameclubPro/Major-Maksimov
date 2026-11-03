#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=infra/scripts/lib/postgres-backup-profile.sh
source "$ROOT_DIR/infra/scripts/lib/postgres-backup-profile.sh"
BACKUP_DIRECTORY="$(maxim_backup_profile_directory "${MAXIM_BACKUP_DIR:?Set MAXIM_BACKUP_DIR}")"
# FLAG: Observation must remain available while the producer inherits descriptor 9.
if [[ "$#" == 1 && "$1" == status ]]; then
  exec node "$ROOT_DIR/infra/scripts/postgres-backup-schedule.mjs" status
fi
mkdir -p -- "$BACKUP_DIRECTORY"
STATE_DIRECTORY="$(node "$ROOT_DIR/infra/scripts/postgres-backup-schedule.mjs" prepare)"
# FLAG: The descriptor survives coordinator/producer exec. Orphaned work keeps the
# coordinator fenced; a stored PID alone never grants recovery or termination authority.
exec 9<>"$STATE_DIRECTORY/lock"
if flock -n -E 75 9; then
  :
else
  LOCK_STATUS=$?
  if [[ "$LOCK_STATUS" == 75 ]]; then exit 75; fi
  exit 1
fi
export MAXIM_BACKUP_SCHEDULE_LOCKED=1
exec node "$ROOT_DIR/infra/scripts/postgres-backup-schedule.mjs" "$@"
