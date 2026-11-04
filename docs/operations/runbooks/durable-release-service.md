# Durable server release operations

The release service accepts a bounded request, saves it durably and executes it independently of
the SSH connection. This boundary prepares operator delivery; automatic release activation remains
a separate stage. A local test or merged change does not establish installation or production
acceptance. Backup installation and restore acceptance are outside this delivery stage; they do
not gate service installation. Existing backup configuration and separate backup runbooks remain
independent of the release service.

## Identities and restricted access

The service runs as the existing deploy user under `maxim-release.service`. A root-owned bundle
at `/usr/local/lib/maxim-release` contains its controller and admission code. It is independent of
the mutable `/var/www/Chat_bot` controller checkout. Do not replace that bundle while the service,
an executor or a protected release operation is active.

The controller uses the canonical repository origin: `https://github.com/GameclubPro/Major-Maksimov.git`
or one of the exact SSH forms admitted by `assertServiceOrigin`. Review and normalize a retained
legacy repository alias before installation; preserve its transport and verify the canonical
repository identity and main ref first. The public repository uses anonymous HTTPS reads when
configured with canonical HTTPS. Preparation preserves that transport and `.git/config`.
The immutable executor clones the local admitted controller and performs no remote Git reads.

The dedicated `maxim-release-gateway` account has one ed25519 forced-command key. Its only accepted
commands are exactly `inventory`, `submit` and `status UUID`. Forwarding, PTY, arbitrary arguments
and shell commands are disabled. The key reaches only `/run/maxim-release/control.sock`; it cannot
resume policy, reconcile a failed operation or manage queues. Never reuse this key for monitoring.

`submit` consumes one UTF-8 JSON request, at most 64 KiB:

```json
{
  "schemaVersion": 1,
  "id": "00000000-0000-4000-8000-000000000001",
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedManifestSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "trigger": "operator",
  "images": []
}
```

Use a fresh UUIDv4 and the current manifest byte hash from `inventory`. `images` contains one
`{record, artifact, verifiedAt}` proof per required CI component, using the
[registry preparation contract](../../development/ci-image-delivery.md). Empty coverage is valid
only when the cumulative component plan proves no application change. `trigger` is descriptive:
an operator value cannot bypass a pause, CI, provenance or recovery gate.

An identical ID and canonical request hash returns the original operation, including its terminal
result. A different request with that ID fails. Keep the ID across network failures; never create
a replacement release just because the SSH response disappeared. Read `status` or `inventory`.
The gateway returns safe summaries without credentials, raw requests, logs or message data.

## Execution and failure boundaries

The daemon serializes work and owns the private operation store. State writes fsync the file and
its directory. Capacity is bounded at 32 pending and 256 total operations; reaching a cap refuses
new work rather than deleting evidence. Preserve state and executor directories until a reviewed
retention procedure can prove them safe to archive.

Preparation proves exact current-main `Required` and CodeQL, matches the receipt artifact to its
successful publication run and verifies OIDC provenance and the SBOM with the pinned GitHub CLI.
The package credential is a separately provisioned private read-only credential at
`/etc/maxim-deploy/ghcr-read.json`. The operator's GitHub control token never goes to this service.
Unknown evidence, missing packages and registry failures stop delivery before runtime.

The canonical checkout synchronizes through the existing guarded plan path. Under the protected
pair and product locks, preparation computes the accumulated component plan and creates the
detached `/var/www/Chat_bot/.release-executors/UUID/source` checkout with independent Git objects
and a private regular `.env` snapshot. The context binds the request, previous manifest, env hash,
component set and verified image proofs. An incomplete or pre-existing directory is retained for
review. A retry never overwrites it.

Image preparation uses `main --auto --image-plan`, matching the executor's cumulative `--auto`
selection. Preserve the mode when changing either caller: bare `main --image-plan` defaults to
the manual full selection and can demand unrelated images. Cover the real argument parser and
image-plan output for no-op, static, shared API and Lastik changes; a fixed plan test double does
not establish agreement between preparation and execution.

Canonical public HTTPS needs no repository credential. For an admitted SSH origin, service Git
uses its fixed installed SSH wrapper, port 443, pinned host keys and a separately provisioned
repository read key. Only that transport requires `/etc/maxim-deploy/git-read-key` and
`/etc/maxim-deploy/git-known-hosts` as private regular files readable by `maximadmin`. Neither the
interactive user's home nor SSH agent is available in the service. The installer proves exact-main
repository access with the configured transport as that user before creating the service. Verify
access again under the installed unit restrictions before activation; the submit key is unrelated
to Git access.

The unit retains the deploy user's existing Docker and sudo authority. `NoNewPrivileges=false`
is required by Lastik's existing fixed protected-store path checks; installation adds no sudo
permissions. Keep `ProtectSystem=full`, `ProtectHome=true` and `RestrictSUIDSGID=true`. Before
accepting Lastik delivery, prove those read-only store checks as the service user under the unit
restrictions. A static or shared-API release does not establish that separate coverage.

The immutable executor skips fetch, checkout, pull, stash and script re-execution. It preserves
installed source/rollback floors, capacity checks, migration restrictions, all-role recreation,
strict smokes and the existing release manifest. Before its first possible environment, inventory,
floor, migration or container mutation it runs the root-installed admission helper. That helper
rechecks main, exact CI/publication identity, manifest/config hashes and image coverage under the
runtime locks.

A private pipe reports `READY`. The daemon first fsyncs `EXECUTING`, then sends the exact correlated
`PROCEED` acknowledgment through a different pipe. Missing, foreign, incomplete or expired
acknowledgment prevents runtime. Both pipes close before mutation. After this boundary the accepted
SHA completes even if a newer main commit appears.

| State                     | Meaning and next action                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `QUEUED`                  | Request saved; runtime has not been admitted.                                          |
| `ADMITTING`               | Preparation or final validation is active; inspect heartbeat and exact child identity. |
| `WAITING_LOCK`            | The exact child positively reported a known lock conflict and exited before mutation.  |
| `REJECTED` / `SUPERSEDED` | Positive refusal before runtime; retain the request and reason.                        |
| `EXECUTING`               | Runtime was authorized. Failure may include replaced containers or applied migrations. |
| `SUCCEEDED`               | Exit, complete manifest, strict-smoke receipt and active role/image readback passed.   |
| `NEEDS_REVIEW`            | Outcome is uncertain; subsequent work is blocked until supported recovery proves it.   |

Only a typed pair/product lock conflict plus the matching child's observed exit permits retry.
Retries are bounded by time and 16 admission attempts. There is no generic deploy retry. Unknown
lock ownership, process disappearance, missing control messages, failure after authorization and
controller restart during an active phase require review. Heartbeats prove observation, not
application progress; a missing/stale heartbeat must be reported as an observation gap.

Zero executor exit alone is insufficient. The result reader reacquires the protected locks,
validates the complete manifest and required strict-smoke records, compares selected image/source
and registry identities, proves inherited components stayed unchanged, and reads back every active
application role and native auxiliary. A no-op preserves the previous manifest exactly.

## Installation and operator controls

Review `infra/scripts/install-release-service.sh --plan` first. The first-install apply path requires
root, a clean canonical exact-green main, the existing shared locks, a complete component manifest,
a separate read-only registry credential and the fixed Git read identity. Registry admission uses
the same bounded opaque-credential reader as ordinary image delivery and runs as the actual
service user. It cannot substitute a GitHub control token or relax the package/provenance checks.

The installer takes `--apply EXACT_MAIN_SHA /private/gateway.pub`. It refuses unknown pre-existing
users/directories instead of adopting them. It exports committed code only, installs the restricted
key and systemd unit, and initializes a paused policy with automatic releases disabled. It neither
starts nor enables the service. Installation upgrades and policy activation require their separate
review; do not rerun first installation over retained state.

The installed SHA is a tooling floor. Every subsequent source dispatch must descend from that
commit and preserve the protected prefixes through the source admission and rollback pause.
Older local connectors source the current remote lock helper, so the canonical controller must
remain at this compatible floor. Changes to those protected infrastructure prefixes require a
reviewed bundle upgrade; commands after the protected boundaries can evolve normally. Image-only
component rollback keeps its existing image/source compatibility checks and can select older
compatible images without downgrading the controller.

The privileged admin socket is separate and mode `0600`. Resume uses an optimistic policy hash
and keeps automatic releases disabled. Component rollback, API runtime rollback and the connector's
older-entrypoint bootstrap durably pause service delivery before changing runtime. Pausing applies
to already queued requests as well. An accepted executor finishes under the existing lock; future
work waits for explicit resume.

For `NEEDS_REVIEW`, preserve the operation, executor identity, private log, context, failed manifest
and all effect/migration evidence. Use the existing
[guarded recovery procedure](../../development/production-operations-reference.md#deploy-and-rollback).
Never clear the store, delete locks, edit a terminal result or relabel an unknown effect as success.
The privileged socket accepts `{"operation":"resolve_review","id":"UUID",
"expectedManifestSha256":"CURRENT_HASH"}`. Its fixed verifier reacquires both fences and ordinary
effect authority, proves that the recorded Linux executor and its detached process group ended,
and reads the frozen context, complete manifest and every active role back. A full final manifest
with matching smoke/provenance records permits `RECOVERED`; a proved no-op with byte-identical
original manifest permits `UNCHANGED`. It saves a private evidence receipt and appends its hash to
the original operation. The original `NEEDS_REVIEW` state and logs remain intact. Policy does not
resume as a side effect, and remote submit clients cannot invoke this control.

An absent context, missing executor identity, stale/invalid manifest, surviving child, queue hold
or partial migration/deploy remains unresolved. Use the named guarded recovery first; this
verifier never repeats runtime work, finalizes a partial manifest or infers unchanged effects from
healthy containers. Until those proofs pass, the queue remains blocked.

## Acceptance

Local cases must cover duplicate/conflicting submits, fragmented/oversized socket requests, SSH
disconnect, occupied/unknown locks, restart quarantine, READY/ACK ordering, child failure before
and after runtime, and immutable executor inputs. Before production acceptance additionally prove
real private-package pull/attestations, exact source, registry digest and Docker image ID, a static-only
release, a shared API release covering all roles, and Lastik separately when affected. Injected
local dependencies do not establish production migration, registry or host behavior.

Automatic delivery remains disabled until operation recovery, service installation, these release cases,
local runner fallback and the explicit automatic-release stage are accepted.
