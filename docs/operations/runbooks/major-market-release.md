# Major / Биржик release boundary

`major-market-release-v1` binds one owner release to the observed Major / Market
state. It uses the existing `/var/lib/maxim-deploy/deploy.lock` inode. Major still
enters its Major / Karavan admission before that host lock; Market remains outside
that older pair. This protocol introduces no additional lock or runtime launcher.

## Install tooling

Initial installation is a separate tooling operation, with exact reviewed sources:

```bash
./infra/scripts/vps-connect.sh install-major-market-release-guard "$MAJOR_TOOLING_SHA" "$MARKET_CANDIDATE_SHA"
./infra/scripts/vps-connect.sh verify-major-market-release-guard
```

The local connector requires exact Major CI and streams the installer from that Git
object. The installer requires clean, unchanged Major source, its reviewed tooling
ancestor, the existing pair / host lock order, and no active incompatible release
wrapper. Only the finite infrastructure / runbook allowlist may differ. A target
containing application changes needs a separate tooling release first.

Market must already have a newly prepared immutable candidate at
`/var/www/svyazka/releases/<sha>` with its `.tar` and `.provenance.json` siblings.
The installer verifies the committed tree, Git ancestry from the current release,
archive digest, every extracted file / mode and the new owner hooks. It never
changes an existing Market archive, `current.json`, database, route or container.

The installer fast-forwards only Major tooling and publishes the complete
root-owned `/etc/maxim-deploy/major-market-release` directory atomically. Files
must be regular, bounded, single-link and protected against group / world writes;
parent symlinks and unsafe ownership refuse. Repeating the same installed guard
is idempotent. Replacing its implementation is a separate reviewed protocol
upgrade; the installer refuses an implicit replacement. Existing statistics /
authority floors and the persistent lock inode are preserved.

The same atomic bundle pins Market's owner collector and provenance verifier under
`market-owner/infra/scripts/{release-readback.mjs,verify-release-source.mjs}` and
`market-owner/scripts/lib/release-provenance.mjs`. Their exact candidate Git blobs
and protected installed hashes are checked. Historical archives are never
overlaid with newer helpers. `marketOwnerSha256` binds this reader closure in the
installed envelope and state floors.

A failure can leave Major tooling advanced, but cannot claim a runtime release.
Reinspect exact source, original wrapper termination and installed marker before
resuming the same targets. Never remove a guard directory or lower an old floor
to unblock installation.

## Observe and bind one step

```bash
./infra/scripts/vps-connect.sh major-market-release-state birzhik-core@1
./infra/scripts/vps-connect.sh major-market-release-state birzhik-core@1,statistics-central@1
```

The result contains `schemaVersion`, `protocol`, sorted `profiles`, `state`,
`stateSha256`, `observedAt` and `installed`. Empty profiles are supported for a
single-owner workspace step. `state` contains fixed host / root / URL identities,
all active Major component source / image identities, Market's current immutable
identity, scoped configuration digests and protected floor digests.

`manifestSha256` hashes the canonical immutable identity projection, excluding
manifest timestamps. The state digest also excludes observation time, controller
checkout SHA, health and worker heartbeat. A tooling synchronization / re-exec
therefore does not invalidate its own running-state expectation. Source capability
and exact selected controller are independent checks. A planning observation made
without the lock is explicitly non-atomic; it must be repeated under the host lock.

The caller passes this strict envelope as base64 JSON in
`MAJOR_MARKET_RELEASE_EXPECTATION_B64`:

```json
{
  "schemaVersion": 1,
  "protocol": "major-market-release-v1",
  "profiles": ["birzhik-core@1"],
  "stateSha256": "<64 lowercase hex>",
  "step": {
    "product": "major",
    "targetSha": "<40 lowercase hex>",
    "components": ["api-shared"],
    "archiveSha256": null,
    "provenanceSha256": null
  },
  "compatibility": {
    "fixtureSha256": "<64 lowercase hex>",
    "proofRefsDigest": "<64 lowercase hex>"
  }
}
```

`MAJOR_MARKET_RELEASE_EXPECTED_STATE_SHA256` is SHA256 of the **whole canonical
expectation**, with recursively sorted object keys. Arrays retain order; profiles
and components must be sorted, unique and known. Market uses `product: market`,
empty components and exact archive / provenance digests. Unknown or missing
fields, targets, profiles or hashes refuse. Compatibility references bind the
workspace's independently validated historical / native proof; a digest alone
does not establish compatibility. Empty profiles still use real digests.

Both variables are caller-only: the Major connector captures them before loading
`.env.vps`, restores them afterward, and forwards them explicitly over SSH.
They survive controller re-exec. The older `PAIR_RELEASE_EXPECTED_STATE_SHA256`
retains its separate meaning.

The installed CLI is:

```text
guard.mjs state --profiles <sorted profiles CSV>
guard.mjs verify-install
guard.mjs admit --owner major|market --source <absolute source>
guard.mjs check-source --owner major|market --source <absolute source> [--ref <Git ref>]
guard.mjs verify --owner major|market --phase before-build|after-image-validation|before-quiesce --source <absolute source> --target-sha <SHA> [--components <sorted CSV>]
guard.mjs readback --expected-sha <SHA> --components <sorted CSV>
guard.mjs market-readback --expected-sha <SHA>
guard.mjs observe-release --owner major|market --expected-sha <SHA> --components <sorted CSV> --profiles <sorted CSV>
```

Use the public connector aliases for state / installation / Major readback: they
validate the protected trust path before executing Node. Owner launchers likewise
prove the trust path, actual parent PID, inherited FD, fixed inode and exclusive
whole-file flock. An environment marker or an unlocked open descriptor is
insufficient. Shared-lock admission checks the caller's source floor even when
reusing a descriptor; explicit phases repeat state and candidate checks before
build and quiescence. Major's own typed transition manifest remains readable
under its positively held lock after `current.json` has been invalidated.

Major dispatch inspects Git bytes before origin / local-ref checkout, rollback
and tooling restoration. The installed reader pins the small lock authority
function bodies and checks executable owner calls / ordering. Comment markers,
removed hooks and changed authority functions do not satisfy that floor. Updating
those authority functions requires a reviewed guard upgrade. A rollback cannot
silently discard the installed protocol.

Configuration is parsed as dotenv data, never executed. Only selected keys feed
domain-separated hashes: profile / integration credentials for both owners, plus
analytics / export credentials and central-statistics switches for the statistics
profile. Unrelated settings do not change the scoped digest. Raw secrets and
whole environment files must never enter workspace evidence.

## Read back an outcome

```bash
./infra/scripts/vps-connect.sh major-market-release-readback --expected-sha "$MAJOR_TARGET_SHA" --components api-shared,miniapp-major-static
```

Major readback requires clean exact controller source and a sealed manifest. It
checks every active component against actual immutable images and containers,
including all fourteen API roles and both native auxiliaries, and preserves
unselected identities. Selected runtime components run the established owner
HTTP / static / native and queue-fence checks. A second inventory, manifest and
state observation must match the first. Empty components verify tooling identity
and unchanged running inventory with `strictSmokes: not-required`.

The owner envelope uses `major-market-owner-readback-v1`, `product: major`, exact
controller / manifest / component identities, `observedAt`, and explicit checks.
Market has its own collector, including app / worker agreement, release-bound
fresh heartbeat, original database / mounts, migration state and loaded assets.
State hashes never substitute for these live owner checks.

For release completion and interrupted-operation reconciliation, use the installed
`observe-release` command. It takes the existing host flock nonblocking, using a
read-only descriptor without creating a lock file, and proves its inode / actual
whole-file flock. It acquires no pair lock and performs no runtime mutation. A
still-running original wrapper (including surviving children with the inherited
descriptor) makes the observation refuse. Both owner acceptance and the before /
after stable state run under this same hold, within a 360-second process-group
budget. A mismatch or missing observation remains unproved. The result is
`{snapshot, acceptance, lock: {status: held-during-observation, identity}}`.
Standalone planning `state` remains non-atomic and cannot replace this result.

After lost SSH / exit 143, outcome remains unknown until the original process is
proved ended and a fresh owner readback resolves it. A runtime success additionally
requires the sealed manifest's `createdAt` to be no earlier than the step start.
After the first owner succeeds, derive the second expectation from that exact
intermediate state. If the second owner fails, preserve the first success and
record a partial release; never replay it automatically.

These readbacks authorize no MAX publications, opt-ins, SQL diagnostics, queue
cleanup or new recovery. Exact CI, historical executable compatibility, real
native / image checks, deployment, device acceptance and any requested sustained
window remain distinct gates.
