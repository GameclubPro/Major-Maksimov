# Recurring PostgreSQL backup verification

The guarded logical producer holds the deployment lock while reading the primary.
Its low-priority, rate-limited stream stops after repeated readiness degradation or
loss of the configured free-space reserve. The cold filesystem and its backing
filesystem are separate admission checks over the same RAID, not independent copies.
After a watchdog abort, retain the exact window, release identity and queue/IO evidence;
do not disable the guard or repeat the same attempt without explaining the change.
Failed readiness probes emit `backup_readiness_v1` with fixed failure categories and
numeric queue age/threshold scalars. HTTP failures remain failures even if their body
claims readiness. The diagnostic excludes event identities and free-form health detail;
retain the service journal because later healthy snapshots cannot reconstruct the abort.

The producer and isolated restore probe can observe one refresh after the exact
`stale-ready-fallback` warning, provided all other strict checks and numeric lag
bounds pass. The second request waits beyond the ordinary two-second readiness
cache and shares the original HTTP deadline. It must pass the unchanged strict
checks and carry a newer, non-future queue sample no older than five seconds.
Persistent fallback, missing evidence, real dependency/lag/HTTP failures and an
exhausted deadline still fail. Both the initial failed sample and any confirmed
refresh are logged without event identities or response bodies. The two-failure
watchdog and storage reserve are unchanged; never count a fallback as healthy.

The API treats the bounded queue-lag refresh as a required dependency, including
when a recent stale sample exists. It uses the same dependency budget as a cold
queue read (1,500 ms by default), within the unchanged 2,500 ms readiness build
deadline; optional dashboard diagnostics retain their separate short budget.
A refresh that completes after 250 ms must not repeatedly lose to that optional
budget on each cache-expired watchdog retry. An unchanged, failed or timed-out
refresh still carries the stale warning, and fresh excessive lag still fails the
strict backup checks. Do not increase cache ages or watchdog thresholds to compensate.

Install `infra/env/postgres-backup.env.example` as `/etc/maxim-postgres-backup.env`
(root, 0600). Use `/mnt/maxim-cold/backups/maxim` and
`/mnt/maxim-cold/restore-smoke/maxim`, and set the backing path to
`/var/lib/migration-storage`. Capacity admission reserves the full current database
size for a dump and 125% for a restore, in addition to the free-space floor. Replication
temporarily needs another dump-sized ciphertext file. Retention preserves the newest
completed dump; two-day local retention does not imply independent S3 retention.

Configure a dedicated MAXIM writer in `/etc/maxim-backup/rclone.conf` (0600) and
public age recipients in `/etc/maxim-backup/recipients.txt`. Never copy the private
decryption key to the producer. Use the existing private MAXIM REG.RU S3 bucket;
do not borrow Karavan/Svyazka credentials or alter their policies. Set
`MAXIM_BACKUP_REPLICATION_REQUIRED=1` only when this configuration is ready.

`replicate-postgres-backup.sh` verifies the original dump checksum, encrypts locally,
uploads to a content-addressed ciphertext object, reads the entire object back and
compares SHA-256. It publishes a small verification receipt only after a matching
readback. An interrupted upload or changed object has no verified receipt. The overall
replication deadline is six hours; transfers default to 16 MiB/s and preserve previous
objects. The temporary encrypted file is removed after completion/failure.
Use a reviewed bucket lifecycle for long-term retention; this helper never deletes
remote backups or historic object versions.

The restore service runs as root so that its exact disposable directory can be cleaned.
Pin `MAXIM_BACKUP_POSTGRES_IMAGE` to the production PostgreSQL image identity. The
disposable container has no network, two CPUs, 4 GiB RAM and a PID limit; no application
or MAX worker runs against it. The service holds the deploy lock, monitors production
readiness and both storage reserves, and has a 12-hour deadline. It restores the
checksum-verified local archive and verifies migration completion plus critical
webhook, authority, action-ledger and publication primary indexes. Its receipt describes
this schema check, not an end-to-end business exercise or a decrypted S3 restore.
Wait for PostgreSQL readiness on `127.0.0.1` inside that container. The image's temporary
initialization server accepts Unix-socket connections before it stops; that socket
must not satisfy the restore admission check. Loopback readiness retains network
isolation and the existing socket authentication used by the restore commands.
An operator should also periodically decrypt a downloaded independent copy with the
off-host key and run a recovery rehearsal from that copy.

### Disposable sparse restore filesystem

When the existing restore filesystem cannot admit a full database, an operator can
opt in to a separate temporary ext4 loop filesystem through the same guarded restore
service. The default remains the existing directory mode for both profiles.
The temporary loop shares its backing RAID failure domain and is not an independent
backup copy. Set
`MAXIM_RESTORE_SMOKE_MAXIM_LOOP_BYTES=700000000000` for the main profile after capacity
review; `MAXIM_RESTORE_SMOKE_ERASER_LOOP_BYTES=0` keeps Lastik on its existing volume.
The value is exact decimal bytes, not GiB. The private root defaults to
`/var/lib/maxim-restore-volumes`; it and every parent must be root-owned, without
symlinks or group/other write access. The private root has mode 0700. Its filesystem
must match `MAXIM_BACKUP_BACKING_FILESYSTEM_PATH`; never place it on nested cold
storage while counting free space on the backing root.

The existing `--preflight-only` still requires a completed checksum-valid dump and
reads the authoritative full `pg_database_size` through the fixed profile. It creates
no large file, filesystem, loop, mount or container. A missing dump or database size
is a refusal, not zero data. Its virtual result is an estimate: the real capacity
check runs again after mounting the new filesystem.

Loop admission uses at least 125% of the full database size. Virtual admission adds
the configured restore reserve; physical admission independently adds the greater
of that reserve and 40 GiB, plus a 1 GiB bound for filesystem metadata. It does not
require the full sparse file size to be physically allocated. Formatting uses
`largefile4`, zero reserved-block percentage and a bounded 128 MiB journal; actual
allocated metadata must fit its 1 GiB allowance. Both budgets are checked after
formatting/mounting. The existing watchdog keeps the configured virtual reserve and
at least 40 GiB on the backing filesystem throughout restoration. Existing readiness,
two-failure, duration, CPU/memory, network isolation and deployment-lock guards remain.

Each operation exclusively creates one private image, formats only that new regular
file, verifies its inode and exact loop association, then mounts ext4 with
`nosuid,nodev,noexec`. No fstab entry or production store is changed. The write-ahead
`<root>/<profile>/active/state.json` records operation and resource identities.
The watchdog records its heartbeat and last successful sample separately; missing
or stale samples do not establish a running restore or healthy production. A gap
during loop attachment or mounting, unknown container identity, changed mount/file,
or busy unmount preserves the resources as `needs_review`; the next run refuses
the existing active directory. Do not remove that directory, reuse an existing file,
force/lazy-unmount, globally detach loops, or bypass the capacity/readiness guard.
Review the exact operation and its missing observations before a separate recovery.

Successful cleanup proves the exact container label/ID/bind and terminal state before
removing its data. It then verifies and removes only that mount, loop and image.
The image deletion releases its physical allocation. The restore verification receipt
is published only after this cleanup succeeds. A bounded `completed.json` retains
the last eight completed operation records; successful weekly invocations allocate
a new image. New restore units require both tracked `postgres-restore-volume.sh` and
`postgres-restore-volume.mjs` capabilities in `ExecStartPre`, so an incompatible source
rollback fails before silently ignoring the mode. Timer enablement still requires
the original independent-copy and restore-health evidence.

The focused filesystem acceptance is opt in and requires root on a disposable Linux
host: `MAXIM_RESTORE_VOLUME_NATIVE=1 node scripts/agent/focused.mjs --test
infra/scripts/postgres-restore-volume.test.mjs`. It creates an 8 GiB sparse ext4 loop
under a unique private `/var/lib` directory, verifies actual mount/capacity/cleanup,
and runs no PostgreSQL or production container. Mock cases separately cover container
identity, uncertain results and refusal paths; this test does not prove a full restore.

After both manual services and independent readback pass:

```bash
sudo systemctl start maxim-postgres-backup-health.service
MAXIM_ENABLE_POSTGRES_BACKUP_TIMER=1 \
MAXIM_ENABLE_POSTGRES_RESTORE_SMOKE_TIMER=1 \
  ./infra/scripts/vps-install-postgres-backup-timers.sh
sudo systemctl list-timers --all 'maxim-postgres-*'
```

The installer checks recovery evidence before enabling timers. Daily backup is at
03:20 (server timezone, with up to 20 minutes jitter); restore is Sunday 05:30 with
up to 30 minutes jitter. Check sibling schedules and actual elapsed times before
enablement: lock contention is not a successful new backup. Observe the first planned
run separately from manual acceptance.

The hourly `maxim-postgres-backup-health.timer` fails when verified independent
evidence exceeds 28 hours, a restore exceeds eight days, receipts are malformed/future,
or its bounded directory census is incomplete. This is an operational freshness gate,
not a promised application RPO/RTO; measure actual copy and restore durations first.
Inspect the failed service and journal through host monitoring. No external alert
destination is configured by this helper.

The receipt check uses bounded metadata reads and never contacts PostgreSQL, Redis,
MAX or S3. A valid historic receipt does not prove current object availability.
Do not enable timers merely because a dump file exists or an upload returned HTTP 200.

## Independent Lastik profile

Use `MAXIM_BACKUP_PROFILE=eraser` with the same producer, replication, restore,
health and timer installer. The default remains `maxim`; other profile names fail
closed. Select the profile per invocation, not in the shared environment file.
The profile fixes the service/user/database to `eraser-postgres`/`eraser`/`eraser`,
appends `/eraser` to the configured backup root, restore root and remote prefix,
and uses only `eraser_*.dump` archives and `maxim-eraser-postgres-*` systemd units.
Do not append the suffix to the base configuration a second time. The readiness
watchdog checks both the shared API and Lastik's live worker health. Both profiles
keep the same protected deploy lock and capacity floors.

Lastik units require the tracked `postgres-backup-profile.sh` capability file in
`ExecStartPre`. A checkout rollback predating profile support must fail each service,
including freshness health, before an old script can silently select the main database.
Keep this file with all profile-aware scripts; do not replace this failure with a
systemd condition that reports a successful skip. An image-only rollback leaves the
compatible host tooling in place.

The eraser restore verifies exact migration names and digests plus critical tables
and indexes, in a network-isolated disposable PostgreSQL container. Its receipt
contains `profile=eraser`, the schema digest and
`verification=isolated_restore_and_eraser_schema`. Main-database receipts never
satisfy Lastik's health gate. A schema restore does not prove application replay
safety, current remote-object availability or recovery from the independent copy.

Install the eraser units with both timer switches left off. After a guarded manual
backup, full encrypted remote readback and isolated restore have succeeded, run
`maxim-eraser-postgres-backup-health.service`. Only then enable this profile's timers
with the existing installer switches. Lastik defaults to daily 01:20 backup and
Sunday 02:30 restore (server timezone, the same jitter as the main profile).
Inspect actual sibling schedules and durations before enabling them. A skipped
locked run is not a fresh backup. The main profile's timer state is independent.

The local rehearsal is reproducible without MAX access:

```bash
node scripts/agent/with-test-stores.mjs -- \
  node --import tsx --test apps/eraser/test/recovery.stores.ts
```

It dumps and restores an isolated synthetic database, preserves unknown dispatch
identities, protections, future scheduling and durable Retry-After, then reconstructs
work in a fresh Redis namespace using a fake MAX transport. It cannot authorize
deletions after restoring an old production snapshot: stop execution, retain the
newer effect journals and reconcile the snapshot gap before admitting any effect.
Never bring a recovery worker online merely because schema checks passed.

## Durable scheduled admission and exact replication recovery

The daily service calls `postgres-backup-schedule.sh request`. Its companion
`backup-retry.timer` calls `tick` every 15 minutes; both use one private coordinator
lock per profile. The installer enables this retry timer only after the same backup
health gate as the daily timer. `Restart=no` remains deliberate: a failed or
interrupted dump must not automatically become a new dump.

The private `.scheduler-v1/state.json` records one operation, its source revision,
attempt identities, original deadline, last process heartbeat and exact archive.
Admission permits at most six attempts over the original twelve-hour window, with
15-minute, 30-minute, one-hour, two-hour and four-hour delays. Only a proved backup,
pair or product lock conflict, or a failed pre-start readiness check, permits a retry.
Pair conflict is observed on its validated kernel lock before normal admission;
a race in the existing shared helper remains an unknown refusal. The shared pair
protocol, helper and lock ordering are unchanged. An unknown refusal, watchdog
abort or started dump failure becomes `needs_review`; new daily requests do not
reset its budget or start another dump. A checkout change also requires review
before any pending producer can run under a different revision.

`status` reports `idle`, `waiting`, `producing`, `replication_pending`, `replicating`,
`needs_review`, `overdue`, `verified` or `closed`, with the last saved process
heartbeat and deadline. It reads one atomic state snapshot without acquiring the
execution lock or starting work, so observation remains available during an active
dump or replication. Deferred admission exits 75 for
systemd without claiming a fresh backup; freshness remains the separate health
service's responsibility. Failed evidence becomes `needs_review`, not an endlessly
running status. These results and failures are local journal/state signals only;
the helper sends no external notifications. A missing or stale process heartbeat
is an observation gap, never proof that a process is still working.

After a reviewed replication failure, use `resume-replication OPERATION_ID` on the
same profile. It validates the exact persisted archive name, byte count, checksum,
destination and complete readback receipt; it never creates another dump. There
are at most three replication attempts per operation, including the first attempt.
A complete archive followed by producer cleanup failure remains available for this
explicit recovery. Retention preserves the pending dump and checksum even when a
newer manual archive exists. Replication uses a private hash-checked snapshot of its
shell and profile helper from the original Git revision, because the deployment
lock is released before remote transfer. It performs one full local checksum pass
inside the existing replication deadline. Existing root-only operation and
immutable-checkout discipline still apply while the producer holds its deploy lock.

Run these commands in a root service with the configured environment file. For
example, this read-only inspection does not start a dump:

```bash
sudo systemd-run --wait --pipe --collect \
  --unit=maxim-postgres-backup-inspect \
  --property=EnvironmentFile=/etc/maxim-postgres-backup.env \
  /usr/bin/env MAXIM_BACKUP_PROFILE=maxim \
  /var/www/Chat_bot/infra/scripts/postgres-backup-schedule.sh status
```

Use `MAXIM_BACKUP_PROFILE=eraser` for Lastik. A reviewed recovery uses the same
invocation with a distinct transient unit name and `resume-replication` followed
by the exact reported operation UUID. `close OPERATION_ID` explicitly acknowledges
an operation in `needs_review` or `overdue`, releases its retention pin and permits
a future daily request. It does not verify, remove or repair any archive. Before
closing, preserve failure evidence and resolve any uncertain primary work or shared
admission owner through the existing incident procedure; never delete scheduler
state or shared lock files to reset a failure.

Both profiles' generated services require the tracked scheduler capability in
`ExecStartPre`, alongside Lastik's existing profile guard. Install compatible units
before first using scheduler state, with timers disabled until recovery evidence
passes. A checkout rollback without that capability fails before running old health
or producer behavior. Do not reinstall an older timer installer over these units;
this host-tooling constraint is separate from application image rollback. Unknown
state versions fail closed. The service limit is 18 hours 20 minutes, covering the
producer and replication outer deadlines plus termination grace; the underlying
12-hour dump, six-hour replication and readiness watchdog limits are unchanged.

Root systemd services read the operator-owned checkout with command-local Git trust
for that exact directory only. This covers the scheduler revision, immutable tool
snapshot and producer source recheck; ordinary-user ownership checks stay unchanged.
Do not configure global or wildcard `safe.directory`. Verify an idle retry through
the actual root service environment after confirming no pending operation: a sudo
shell can retain operator configuration and miss a systemd-only ownership failure.

Root source observations must also preserve the operator's Git index. Set
`GIT_OPTIONAL_LOCKS=0` for read-only Git commands; content comparisons additionally
disable `diff.autoRefreshIndex` for that command. Check Git failures separately from
an empty diff. A timestamp-only change must remain acceptable without rewriting the
index, while a changed tracked backup script must still prevent execution.

Health reports backup data age separately from readback verification age. The
strict archive filename timestamp supplies a conservative generation-start bound,
not an exact PostgreSQL snapshot time. Independent evidence selects the newest
verified archive generation and binds both reported ages to that same receipt;
restore evidence selects the latest exercise and reports that archive's data age.
Independent data older than 28 hours fails health even if re-read today. Existing
28-hour verification and eight-day restore-exercise gates remain. The old
`independentAgeMs` and `restoreAgeMs` fields remain verification-age aliases;
`independentDataAgeMs` and `restoreDataAgeMs` identify the data-age measurements.
