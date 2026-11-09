# Major and Karavan release admission

Both products acquire `major-karavan-release-v1` on the same VPS before their existing product
locks. Svyazka is outside this admission. Product CI, attestations, capacity, migration, reader
floors, manifests and strict smokes remain mandatory.

The persistent inode is `/var/lib/major-karavan-release/state/admission.lock`. Root owns the
protocol marker, installed helper and state reporter; the operator owns the private state
directory and lock. Never unlink the lock, use `flock -u`, forge a token or delete owner metadata
to recover a release. Token reentry also verifies the holder's PID, start ticks, boot identity,
cwd digest, lock inode and exclusive descriptor. Unexpected holder loss leaves an unresolved
owner even when the kernel lock becomes free: independent remote work may still be alive.
Normal confirmed cleanup removes that owner. Owner and recovery records use narrow file and
directory fsync; no host-wide synchronization is needed.

Root maintenance, including the system backup units, publishes its temporary owner with the
state directory's operator ownership before atomic publication. The owner assertion keeps the
same strict ownership, mode and link checks for every caller. The bounded Git source reads trust
only the two fixed repository paths per command, so a root systemd process without `SUDO_UID`
still records their exact revisions. This does not change global Git trust or product authority.

## Initial installation and upgrades

Prepare exact committed `main` targets in both local repositories. Major needs exact successful
`Required` and `Analyze JavaScript and TypeScript`; Karavan needs its exact commit attestation.
Use a clean, unchanged Major release checkout containing the new connector. Finish existing
wrappers first; the installer refuses active wrappers, dirty production source or unsupported branches,
non-fast-forward targets, busy locks and application changes. It accepts only the reviewed
tooling/docs/tests slice, including `packages/contracts/test/`, the exact CI workflow
`.github/workflows/ci.yml` and its `scripts/ci/static-coverage.test.mjs` guard, and the named wrappers' admission
cleanup plumbing; runtime changes use normal releases. Major stays on `main`. Karavan may stay
on `main` or in its normal clean detached release mode; detached advancement never moves a branch.

```bash
./infra/scripts/vps-connect.sh install-pair-release-admission \
  "$MAJOR_SHA" "$KARAVAN_REPOSITORY" "$KARAVAN_SHA" maximadmin
./infra/scripts/vps-connect.sh verify-pair-release-admission maximadmin
./infra/scripts/vps-connect.sh pair-release-state
```

The connector verifies local evidence, sends thin Git bundles into a private temporary directory,
then streams the exact selected Major installer's Git bytes over stdin with a 90-second host budget.
Privileged derived files use a separate root-owned private directory, never the operator transport
directory. Verification executes the installed root-owned helper as the ordinary operator. The installer
holds both existing product locks before initial provisioning; an upgrade takes common admission
first. It verifies target source and installed floors, installs the identical helper/reporter,
and advances both clean checkouts without executing target-owned release scripts.
It never builds or changes containers, stores, services or nginx. The installed helper is
independent of the checkouts, so readback works during a tooling transition.

Do not use ordinary deploy to bootstrap an uninstalled mandatory admission. Before installing
authority or advancing source, the installer persists an owner with `mode=bootstrap` and both
exact targets. An interruption after only one checkout advances leaves that owner in place,
blocking runtime admission and installed verification. Only the same selected bootstrap may
resume, with the original process dead, both product locks held, and each clean checkout still
at its original or selected commit and original branch mode. The installer archives its owner
under `state/bootstrapped/` only after both sources and installed files verify. Do not delete
that owner, use runtime reconciliation for it, roll source back or rerun runtime publication.
Shared coordination is active only after verification passes for both source trees and installed files.

## Planning and applying a release

`pair-release-state` reads fixed bounded manifests, checkout heads and `.env` files. JSON contains
Major target/checkout identities and each component's source SHA/image ID, allowlisted completed
smoke labels, Karavan commit/origin commit/delivery mode/smoke, and configuration hashes. It never
returns environment values or raw manifests. Missing observations are `null`; unknown smoke labels
are counted in `major.unreportedSmokeCount`. The report proves recorded state, not a fresh live
health or device acceptance check.

The coordinator passes `PAIR_RELEASE_EXPECTED_STATE_SHA256=<fingerprint>` to a public release
command. Fresh common admission recomputes the fixed projection and rejects drift before either
product lock. Nested calls retain the holder's original admission proof, because the owning
release may legitimately update source/manifests afterward. After publishing the first product,
reconcile its result and retained components/configuration, then bind the fresh fingerprint for
the second step. Two releases are never an atomic transaction.

Major's ref synchronization/rollback gates retain the admission helper and dispatch; Karavan
rejects a rollback worktree that loses the same protocol before dependency installation or
production-env copy, including `--origin-only`. A failed/lost remote operation needs inspection;
admission does not authorize generic process termination, replay or rollback.

## Interrupted owner recovery

An `admission.status` of `unknown` is a gate, not permission to retry. Inspect the retained owner,
the exact target's CI/attestation and publication/configuration evidence first. A live PID with the
same start ticks and boot identity cannot be reconciled, including one that changed cwd or closed
its original descriptor. Both product locks and common admission must be free, and bounded process
observation must find no remaining release/build actor in either product checkout.

```bash
./infra/scripts/vps-connect.sh reconcile-pair-release-admission \
  "$OWNER_SHA256" "$PAIR_STATE_SHA256" "$PRODUCT" "$TARGET_SHA" \
  "$MODE" "${MAJOR_COMPONENTS:-}"
```

The installed entrypoint also works from a Karavan-only task, using the ordinary operator without sudo:

```bash
ssh maxim-vps timeout 12 bash /var/lib/major-karavan-release/admission.sh state
ssh maxim-vps timeout 20 bash /var/lib/major-karavan-release/admission.sh reconcile \
  "$OWNER_SHA256" "$PAIR_STATE_SHA256" "$PRODUCT" "$TARGET_SHA" \
  "$MODE" "${MAJOR_COMPONENTS:-}"
```

The owner pins product, mode and full target. Tooling recovery proves the exact checkout. Major
runtime recovery requires a new sealed manifest with the selected component sources/images and
all required recorded smokes; Karavan requires exact commit/origin and a new passed smoke. The
coordinator separately checks retained components, configuration and exact CI/attestation before
calling this command. Reconciliation archives the original owner plus its proof under
`state/reconciled/<owner-sha256>.*`; it never removes or unlocks the persistent inode. Source/state
drift, incomplete publication or an interrupted standalone maintenance operation without the required
outcome evidence stays blocked for a separately reviewed recovery. Never switch a runtime owner to
tooling mode or invent a manifest to make recovery pass.

### Pinned refusal before cold admission

The source-abandonment check on 9 November stopped before its durable admission artifact.
The supervisor intentionally retained its runtime-mode owner after a nonzero child outcome.
Generic runtime reconciliation cannot prove that outcome from an older release manifest.
Do not substitute tooling mode, remove the owner, or retry the failed operation to bypass it.

`recover-pair-preadmission` is a separate forensic boundary for the exact historical source,
owner and artifact hashes supported by its controller. It proves that the operation did not
cross the source's durable admission barrier. The old host must persist and fsync
`admission.json` before queue control, cold journal admission or any stop/install work, and
never deletes that artifact. Recovery requires the exact two-entry private operation directory,
its fixed historical change time, unchanged old terminal journals, unchanged pair state,
exact runtime identities, released queues and no remaining operation actors or clients.
Missing or changed evidence refuses recovery. This does not establish a recorded child exit,
successful source admission or completion of the interrupted release.

All fourteen API generations and photo native must predate the owner. OCR must retain its
original pre-owner container and exact image, with fresh health and the strict networkless,
secretless isolation profile. Its latest process start and restart count are recorded and
bound to the preview; their causes and full history remain unproved. OCR process continuity
does not establish or invalidate the separate durable admission barrier.

From a clean controller with exact successful `Required` and CodeQL checks, retain the preview:

```bash
./infra/scripts/vps-connect.sh recover-pair-preadmission preview \
  --owner-sha256 "$OWNER_SHA256" --state-sha256 "$PAIR_STATE_SHA256" \
  --source-sha "$HISTORICAL_SOURCE_SHA" --operation-id "$PRIVATE_OPERATION_ID"
```

Review the concrete proof and preserve any refusal. Apply reobserves the same facts under
all three original locks and requires the exact preview proof hash:

```bash
./infra/scripts/vps-connect.sh recover-pair-preadmission apply \
  --owner-sha256 "$OWNER_SHA256" --state-sha256 "$PAIR_STATE_SHA256" \
  --source-sha "$HISTORICAL_SOURCE_SHA" --operation-id "$PRIVATE_OPERATION_ID" \
  --proof-sha256 "$PREVIEW_PROOF_SHA256"
```

The ordinary operator archives durable proof before moving the unchanged original owner into
its private recovery archive. The persistent lock inodes, installed admission helper, runtime
manifest, source, stores, queues and services stay intact. It grants no source abandonment,
replay or fleet-stop authority. Read back shared admission afterward, then resume the separately
verified ordinary release. A new stock readonly preflight follows its corrective release;
this recovery never repeats it. Other failed checks and unknown effects require their own evidence.

### Interrupted backup unit installation

The fixed [3 November installation incident](../incidents/2026-11-03-backup-activation.md)
has a separate recovery boundary. Its completed child failed during an idle systemd
retry after installing unit files. It has no runtime target or new release manifest;
neither generic reconciliation nor the earlier root backup refusal proves its outcome.

From a clean exact controller with successful required CI, retain the preview:

```bash
./infra/scripts/vps-connect.sh recover-pair-backup-activation preview \
  --owner-sha256 "$OWNER_SHA256" --state-sha256 "$PAIR_STATE_SHA256" \
  --source-sha "$DEPLOYED_SOURCE_SHA" --invocation-id "$RETRY_INVOCATION_ID"
```

This command accepts only the reviewed incident identity. It checks source and unit
integrity, the trusted service journal, completed processes, scheduler state and
unchanged configuration under the existing locks. Runtime evidence requires current
manifest image identities and process starts predating the installation. Only the
incident's pinned OCR container may have a later start: it requires a timestamped
native-timeout recycle immediately before that start, the original image and restart
policy, and fresh native health evidence. Changed start/restart evidence requires a
new preview. This exception does not prove complete Docker event history or successful
OCR requests; all other roles and stores retain the pre-installation start check.
There is no earlier complete container inventory to compare. Preview does not
archive the owner or start work. Review its exact proof and preserve any refusal.

```bash
./infra/scripts/vps-connect.sh recover-pair-backup-activation apply \
  --owner-sha256 "$OWNER_SHA256" --state-sha256 "$PAIR_STATE_SHA256" \
  --source-sha "$DEPLOYED_SOURCE_SHA" --invocation-id "$RETRY_INVOCATION_ID" \
  --proof-sha256 "$PREVIEW_PROOF_SHA256"
```

Apply requires the same freshly proved result and archives the unchanged original
owner with durable evidence. It never changes the shared helper, lock inode, release
manifest, units, timers or stores. Any unknown/changed outcome remains blocked.
Afterward, read back admission and continue the separately verified backup activation;
successful reconciliation does not establish recovery coverage or a scheduled backup.

### Known root backup admission refusal

The separate `recover-pair-backup-refusal preview|apply` connector handles only the retained
root-owned, empty-target backup refusal produced by the pinned legacy source supported by its
controller. Run it from a clean controller with exact successful `Required` and CodeQL checks:

```bash
./infra/scripts/vps-connect.sh recover-pair-backup-refusal preview \
  --owner-sha256 "$OWNER_SHA256" --initial-state-sha256 "$INITIAL_STATE_SHA256" \
  --state-sha256 "$PAIR_STATE_SHA256" --source-sha "$LEGACY_SOURCE_SHA" \
  --invocation-id "$BACKUP_INVOCATION_ID"
```

Review that concrete result, then repeat the identical identities with `apply`. The controller
requires the original root-owned owner bytes, exact installed legacy sources, an inactive exact
backup unit, its trusted journal refusal before product admission, a dead original process and
no remaining operation actors. It separately proves current checkout revisions and reconstructs
only the old root reporter's missing checkout fields before comparing the original state hash.
Unknown source, configuration, process, journal or outcome evidence refuses recovery.

Both preview and apply retain all three original kernel lock descriptions. Apply durably records
the proof and atomically archives the unchanged owner under `state/backup-refusal-recoveries/`;
the original owner remains root-owned, and its evidence requires root readback. It never changes
lock inodes, product manifests, stores, queues or containers. A prior matching durable proof may
resume before the owner move; a conflicting proof or existing archive refuses repetition.
After recovery, install the identical corrected helper and reporter through the normal paired
installer before retrying any root maintenance. A refused or skipped backup is never a completed
copy, even when its systemd unit treats exit 75 as successful completion.
