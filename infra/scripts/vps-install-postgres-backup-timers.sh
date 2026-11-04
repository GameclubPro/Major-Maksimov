#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=infra/scripts/lib/postgres-backup-profile.sh
source "$ROOT_DIR/infra/scripts/lib/postgres-backup-profile.sh"
BACKUP_CALENDAR="*-*-* 03,15:20:00"
RESTORE_CALENDAR="Sun *-*-* 05:30:00"
PROFILE_PRECHECK=""
if [[ "$MAXIM_BACKUP_PROFILE" == eraser ]]; then
  BACKUP_CALENDAR="*-*-* 01,13:20:00"
  RESTORE_CALENDAR="Sun *-*-* 02:30:00"
  # FLAG: Units survive checkout rollbacks. Old tooling ignores ERASER's profile and
  # would select the main database; a missing tracked capability must fail the service.
  PROFILE_PRECHECK="ExecStartPre=/usr/bin/test -f $ROOT_DIR/infra/scripts/lib/postgres-backup-profile.sh"
fi
UNIT_DIR="${MAXIM_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
TEMP_DIR="$(mktemp -d)"
ENABLE_BACKUP_TIMER="${MAXIM_ENABLE_POSTGRES_BACKUP_TIMER:-0}"
ENABLE_RESTORE_TIMER="${MAXIM_ENABLE_POSTGRES_RESTORE_SMOKE_TIMER:-0}"
BACKUP_ENV_FILE="/etc/maxim-postgres-backup.env"

cleanup() {
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT

cat > "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-backup.service" <<EOF
[Unit]
Description=MAXIM validated PostgreSQL backup
Requires=docker.service
After=docker.service
ConditionPathExists=$ROOT_DIR/infra/scripts/backup-postgres.sh

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
EnvironmentFile=-/etc/maxim-postgres-backup.env
$PROFILE_PRECHECK
ExecStartPre=/usr/bin/env MAXIM_BACKUP_PROFILE=$MAXIM_BACKUP_PROFILE node $ROOT_DIR/infra/scripts/postgres-backup-schedule.mjs capability
ExecStart=/usr/bin/env MAXIM_BACKUP_PROFILE=$MAXIM_BACKUP_PROFILE $ROOT_DIR/infra/scripts/postgres-backup-schedule.sh request
SuccessExitStatus=75
TimeoutStartSec=18h20m
TimeoutStopSec=1m
KillSignal=SIGTERM
Restart=no
UMask=0077
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

# The retry service shares the coordinator flock with each scheduled request.
sed 's/postgres-backup-schedule.sh request/postgres-backup-schedule.sh tick/' \
  "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-backup.service" > "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-backup-retry.service"

cat > "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-backup-retry.timer" <<EOF
[Unit]
Description=Retry pending MAXIM PostgreSQL admission within its original budget

[Timer]
OnCalendar=*:0/15
Persistent=true
Unit=${MAXIM_BACKUP_UNIT_PREFIX}-backup-retry.service

[Install]
WantedBy=timers.target
EOF

cat > "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-backup.timer" <<EOF
[Unit]
Description=Request MAXIM PostgreSQL backup twice daily

[Timer]
OnCalendar=$BACKUP_CALENDAR
RandomizedDelaySec=20m
Persistent=true
Unit=${MAXIM_BACKUP_UNIT_PREFIX}-backup.service

[Install]
WantedBy=timers.target
EOF

cat > "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-restore-smoke.service" <<EOF
[Unit]
Description=MAXIM isolated PostgreSQL restore smoke
Requires=docker.service
After=docker.service ${MAXIM_BACKUP_UNIT_PREFIX}-backup.service
ConditionPathExists=$ROOT_DIR/infra/scripts/restore-postgres-backup-smoke.sh

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
EnvironmentFile=-/etc/maxim-postgres-backup.env
$PROFILE_PRECHECK
ExecStartPre=/usr/bin/env MAXIM_BACKUP_PROFILE=$MAXIM_BACKUP_PROFILE node $ROOT_DIR/infra/scripts/postgres-backup-schedule.mjs capability
ExecStart=/usr/bin/env MAXIM_BACKUP_PROFILE=$MAXIM_BACKUP_PROFILE $ROOT_DIR/infra/scripts/restore-postgres-backup-smoke.sh
TimeoutStartSec=12h15m
TimeoutStopSec=1m
KillSignal=SIGTERM
UMask=0077
Nice=15
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

cat > "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-restore-smoke.timer" <<EOF
[Unit]
Description=Verify a MAXIM PostgreSQL backup can be restored weekly

[Timer]
OnCalendar=$RESTORE_CALENDAR
RandomizedDelaySec=30m
Persistent=true
Unit=${MAXIM_BACKUP_UNIT_PREFIX}-restore-smoke.service

[Install]
WantedBy=timers.target
EOF

cat > "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-backup-health.service" <<EOF
[Unit]
Description=MAXIM independent backup and restore freshness
ConditionPathExists=/etc/maxim-postgres-backup.env

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
EnvironmentFile=/etc/maxim-postgres-backup.env
$PROFILE_PRECHECK
ExecStartPre=/usr/bin/env MAXIM_BACKUP_PROFILE=$MAXIM_BACKUP_PROFILE node $ROOT_DIR/infra/scripts/postgres-backup-schedule.mjs capability
ExecStart=/usr/bin/env MAXIM_BACKUP_PROFILE=$MAXIM_BACKUP_PROFILE node $ROOT_DIR/infra/scripts/check-postgres-backup-health.mjs
TimeoutStartSec=30s
UMask=0077
EOF

cat > "$TEMP_DIR/${MAXIM_BACKUP_UNIT_PREFIX}-backup-health.timer" <<EOF
[Unit]
Description=Check MAXIM recovery evidence every hour

[Timer]
OnCalendar=hourly
Persistent=true
Unit="${MAXIM_BACKUP_UNIT_PREFIX}-backup-health.service"

[Install]
WantedBy=timers.target
EOF

for unit in "$TEMP_DIR"/*; do
  sudo install -o root -g root -m 0644 "$unit" "$UNIT_DIR/$(basename "$unit")"
done

sudo systemctl daemon-reload
if [[ "$ENABLE_BACKUP_TIMER" == "1" ]]; then
  if ! sudo test -f "$BACKUP_ENV_FILE"; then
    echo "Refusing to enable backup timer without $BACKUP_ENV_FILE." >&2
    exit 2
  fi
  sudo systemctl start "${MAXIM_BACKUP_UNIT_PREFIX}-backup-health.service"
  sudo systemctl enable --now "${MAXIM_BACKUP_UNIT_PREFIX}-backup.timer" "${MAXIM_BACKUP_UNIT_PREFIX}-backup-retry.timer" "${MAXIM_BACKUP_UNIT_PREFIX}-backup-health.timer"
else
  echo "Backup timer installed but left disabled. Configure $BACKUP_ENV_FILE and a separate backup volume, then run the service once before enabling the timer."
fi

if [[ "$ENABLE_RESTORE_TIMER" == "1" ]]; then
  if ! sudo test -f "$BACKUP_ENV_FILE"; then
    echo "Refusing to enable restore-smoke timer without $BACKUP_ENV_FILE." >&2
    exit 2
  fi
  sudo systemctl start "${MAXIM_BACKUP_UNIT_PREFIX}-backup-health.service"
  sudo systemctl enable --now "${MAXIM_BACKUP_UNIT_PREFIX}-restore-smoke.timer" "${MAXIM_BACKUP_UNIT_PREFIX}-backup-health.timer"
else
  echo "Restore-smoke timer installed but left disabled. Enable it only with a separate disposable volume sized for a full restore."
fi

sudo systemctl list-timers --all \
  "${MAXIM_BACKUP_UNIT_PREFIX}-backup.timer" "${MAXIM_BACKUP_UNIT_PREFIX}-backup-retry.timer" "${MAXIM_BACKUP_UNIT_PREFIX}-restore-smoke.timer" --no-pager
