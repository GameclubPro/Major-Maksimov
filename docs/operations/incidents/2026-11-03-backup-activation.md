# Backup service activation refusal on 3 November 2026

## Observed boundary

Lastik release `932c81a1b195d2c0464285fc92ecc364cc613779` completed at
10:38:30 UTC with its exact-source readiness smoke and component manifest.
The subsequent backup-unit installation used that unchanged checkout. Both
profiles' units were installed, and Lastik's freshness service succeeded.
At 10:42:07 UTC the first main-profile idle retry failed with Git's
`detected dubious ownership` error. No producer was requested by this operation.

The scheduler reads its source revision before running the schedule state machine.
The observed main scheduler directory contained only its empty coordinator lock;
the Lastik scheduler directory was absent. These observations are not a backup,
restore, or complete proof that every host actor has stopped.

A preceding sudo-shell probe passed because that environment did not reproduce
the root systemd service's Git configuration. A root service reading the
operator-owned repository must use command-local trust for the exact directory.
The correction covers revision reads, immutable replication-tool snapshots and
the producer's final revision/dirty-source checks. It does not install global
Git trust or relax those source checks. Real Git fixtures reproduce the different
owner and clean service environment, including rejection of a wrong revision
and changed scripts after the correction.

## Interrupted installation authority

The terminal operation supervisor preserved its original admission owner after
the failed service check. That record has runtime mode and no selected target.
Ordinary reconciliation requires a selected target and a fresh successful runtime
manifest, so it cannot prove this unit installation. The earlier root backup
admission-refusal recovery is also a different operation and cannot be reused.
Do not change the owner, invent a release manifest or remove an admission lock.

The incident-specific `recover-pair-backup-activation` command uses an exact green
controller without first replacing the blocked host checkout. Its preview binds
the original owner, deployed source, failed service invocation and unchanged pair
state. Apply additionally requires the preview's proof digest and fresh evidence
under the original shared/product locks. It retains the original owner and durable
proof in a separate recovery archive. The shared admission helper and reporter
remain unchanged.

Runtime evidence checks the current manifest's image identities and process starts
predating the installation, with one incident-specific OCR exception. The retained
OCR container later recycled after native timeouts. Its exact container identity and
creation time remain pinned to the saved incident observation. A later start requires
a bounded timestamped timeout-recycle record immediately before that start, unchanged
image and restart policy, and a fresh successful native health probe. Other roles and
stores retain the original process-start check. A changed OCR start or restart count
between preview and apply requires a new preview.

The Docker event history did not retain a complete observation window. The exception
uses the native lifecycle record and current container evidence; it does not claim
complete restart history or successful OCR requests. No earlier complete container
inventory was captured, so this is not a claim of identical historical inventory.

The recovery scope is the interrupted unit installation only. It does not finish
a backup, resume a producer, reset scheduler state, enable a timer or recreate a
container. A missing observation, live actor, different owner/source, changed unit,
new scheduler operation or changed runtime evidence must refuse recovery.
The exact CLI and preview/apply boundary are documented in the
[admission runbook](../runbooks/pair-release-admission.md).

The first live preview refused the repeated `ExecStartPre` properties emitted by
systemd for Lastik's two preparation commands. The collector now preserves both
ordered command records and validates the complete expected sequence. Repeated
scalar properties, unknown fields and extra preparation commands still fail closed.
For command vectors omitted from the text output, the collector requires a typed
D-Bus empty-array response from that exact service; missing text is never evidence
of an absent command.
The regression exercises the collector subprocess with the observed output format;
reconstructed property objects alone did not cover this boundary. This preview
refusal left the original owner and production state unchanged.

## Git index ownership during root observations

The exact installation owner was archived after a successful locked preview and
matching apply. During the subsequent root service probes, `git status` refreshed
the operator-owned checkout's index. The probe's restrictive umask left that file
owned by root with mode `0600`; a later operator source check could no longer read
it. The tracked source remained clean. Recovery changed only the observed index's
ownership under shared admission, preserving its bytes, inode and restrictive mode.

Read-only Git observations must disable optional index updates explicitly, including
when the caller inherited `GIT_OPTIONAL_LOCKS=1`. The producer's source comparison
also needs command-local suppression of automatic diff index refresh. Checking only
the output of a failed Git command is insufficient: retain its exit status and reject
errors separately from an empty content difference. Real Git regressions use changed
file timestamps with unchanged content, then actual source changes, and verify both
the source decision and preservation of index bytes and metadata.

## Follow-up acceptance

After recovery, synchronize the compatible backup scripts through the guarded
source-update path and inspect actual installed units and timer states. Exercise
an idle retry only after proving no pending scheduler operation, using the actual
root service environment. A successful idle retry proves scheduler wiring only.

Lastik needs an actual new-generation copy, full independent encrypted readback
and isolated restore for its updated schema. Main backup and restore timers remain
disabled until their own recovery evidence passes. Local freshness monitoring is
independent of producer enablement and sends no external messages. A future
scheduled success is separate from manual acceptance; follow the
[backup runbook](../runbooks/postgres-recurring-backups.md).
