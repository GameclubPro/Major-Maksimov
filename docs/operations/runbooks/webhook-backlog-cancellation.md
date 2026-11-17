# Cancel expired webhook backlog

Use this operation when the operator explicitly elects to abandon old processing rather than
finish uncertain actions. It uses one fixed receipt cutoff and one stopped-fleet window.
It preserves connected entities, settings, statistics, publications, execution claims, action
receipts, original webhook bodies and error evidence. Cancellation does not mean successful
processing or proof that a remote action never happened.

The shared API release must include `WebhookStatus.CANCELLED`, the cancellation migration and
the mandatory source/child readers. Deploy all fourteen roles and both native auxiliaries first.
Both rollback paths enforce the reader floor after this release. Never clear Redis wholesale.

Before changing this protocol, read the [latency prevention checklist and regression matrix](webhook-latency-prevention.md).
The [10 October review](../incidents/2026-10-10-webhook-latency-recovery.md) records the terminal-
history scan, JSONB snapshot incompatibility and restart-inventory race. Missing Docker objects
require re-attestation through the identical request; do not infer that an unknown object was
owned or change the journal to pass. Historical direct-host emergency exceptions do not waive
the normal connector's exact-SHA CI gate.

Runtime diagnostics identify the stop, stopped-readback, startup or running-readback stage and
allowlisted command/failure metadata, without Docker arguments, stderr or inventory. A command
failure may occur after containers changed state; re-attest the exact captured generations before
continuing the identical request. These diagnostics neither establish a missing-object race as
the cause nor authorize retries, changed scope or manual journal completion.

## Exact nominated sources: v2

Prefer v2 when the operator elects to cancel a finite list of old started, unfinished
execution owners. Its read-only preview does not authorize stopping the fleet. Complete
the native scope, interruption and representative-history checks, apply the additive
operation-child lookup index and deploy the new client to all fourteen API roles and both
native auxiliaries, then obtain concrete stopped-fleet scope authorization before apply.
Keep one primary recovery stage active.

Queue inspection retains 100-ID pages and the existing 256 KiB per-job and 1 MiB
reply ceilings. A page of individually valid large hashes is read in smaller
chunks after metadata admission; it is not an oversized-job refusal. Individual
oversize, malformed byte identities and incomplete evidence still refuse before
payload inspection. Retained error fields remain part of the original snapshots.

Create a private mode-0600 nomination with exactly `version: 2`, `id`, `cutoff`,
`sourceSha`, `imageId`, and `rootIds`. The latter contains 1–128 sorted, unique receipt
IDs. All v2 JSON uses recursively sorted object keys, UTF-8 and one final newline;
arrays retain their order. Duplicate or unknown fields, noncanonical bytes, future
cutoffs and changed identities refuse. Nomination and apply inputs are bounded to
16 KiB and 4 KiB respectively.

Run `./infra/scripts/vps-connect.sh preview-webhook-backlog /absolute/private/nomination.json`.
The connector requires a clean synchronized controller and exact green CI for both the
controller and the nominated installed API source, checking once when they are identical.
`sourceSha` remains the installed API source, not the current controller checkout. A static
release or reviewed tooling synchronization can legitimately give these different identities.
The host rechecks its clean exact controller after acquiring the shared deploy lock. Its
bounded current manifest must be complete, with no unresolved `current.invalid-*` evidence.
Exact `.json.recovered-<timestamp>-<pid>` and `.json.superseded-<timestamp>-<pid>` archives
produced by the release writer remain retained history; active or unrecognized transition
names still refuse. The API component must match the nominated source, canonical image ref
and image ID.
The manifest's overall target and retained static sources need not match the controller.
The installed
image's client performs read-only PostgreSQL and Redis inspection, without constructing
BullMQ queues. It records the exact roots, stable claim/receipt digests and attributed
queue/job identities in private immutable evidence under
`/var/lib/maxim-deploy/backlog-cancellation-<id>/`. A READY result includes `previewSha256`;
DENY, truncation, missing evidence or a cap is not permission to broaden the scope.

New previews retain private immutable `controller.json` and `controller-ready.json` beside
the existing evidence. They bind the exact controller to the nomination and READY digest
without changing the installed client's request or binding format. Apply and stopped resume
require these identities unchanged before helper execution or fleet mutation; the journal
also retains the controller digest. A changed controller before the first stop requires a
new preview and operation ID. Never replace sidecars or infer provenance for old mixed-source
evidence. Legacy v2 evidence without these files remains supported only with its original
same-source controller. Stopped recovery still uses the captured sixteen generations and
does not require currently running API containers.

Selection uses primary-key root reads and indexed semantic/pending-message families,
not the global pre-cutoff backlog. The pending-message index excludes QUARANTINED;
the preview does not claim to enumerate all quarantined message-family rows. Publications,
future timers and unattributed jobs remain protected. Reply-only links, any-operation
child membership and global holds never nominate children. Locked selected jobs remain
reported and fenced rather than forcibly removed.

The child operation index leads with `cancellation_id`, then `kind, child_key`, so
exact resume can prove the complete owned set without scanning unrelated child history.
Its concurrent additive migration preserves old readers and data. Verify its native
representative plan and valid installed definition; a missing/invalid index refuses.
An interrupted build retains its migration/index evidence and requires the reviewed
migration recovery procedure, never an automatic retry or ad hoc repair SQL.

For an approved READY preview, create the separate private apply input with exactly
`version: 2`, the same `id`, `cutoff`, `sourceSha`, `imageId`, and `previewSha256`, then
run `./infra/scripts/vps-connect.sh cancel-webhook-backlog /absolute/private/apply.json`.
The controller binds the client and all sixteen container generations, rechecks the
roots before stopping, then validates the full exact scope while stopped. New roots,
claims, family members or children require a new preview; only the documented queue
bookkeeping fields and non-root RECEIVED→QUEUED transition may drift. Original
snapshots are captured only after stopped validation. The seal, guarded CANCELLED
projection and exact job retirement preserve unknown effects and existing receipts.

Before any SQL operation write, a refusal can restore the same captured fleet only
after an independent installed-client proof that the operation is absent and no
writer survives. Its lifecycle finishes as `ABORTED_UNWRITTEN` with a nonzero exit,
zero cancellations and retained evidence. A failed restoration keeps STOPPED and
permits only the identical request's restoration branch. After any operation write,
failure retains STOPPED and the immutable scope; resume with the same apply input.
Never use the legacy `--resume-pending` continuation for v2.

Restoration starts the captured native auxiliaries before API consumers and verifies
exact generations and dependency health. Existing automatic queue-only degradation
can remain visible after restoration; COMPLETE does not assert recovered latency.
Record actual preview/apply duration, row/byte budgets, projected/removed/locked
counts and retained uncertainty. Compiled ceilings are safety bounds, not downtime
estimates. Fresh closed cohorts, external action evidence and the sustained acceptance
window below remain separate release gates.

## Legacy broad cancellation: v1

The unchanged v1 protocol selects global pre-cutoff work. It is not an exact-source
substitute for v2. Create a private mode-0600 JSON request with these four fields:

```json
{
  "id": "<new UUID v4>",
  "cutoff": "<fixed UTC ISO timestamp before now>",
  "sourceSha": "<full installed shared API SHA>",
  "imageId": "sha256:<installed shared API image ID>"
}
```

Run `./infra/scripts/vps-connect.sh cancel-webhook-backlog /absolute/private/request.json`.
The connector requires exact green CI and the host requires clean matching source. The host
holds the persistent deploy lock, captures the exact fleet generations, stops them once, and
executes a bounded client with only database/Redis credentials. Static sites and stores stay up.

The client walks at most 500,000 receipts through 200-row indexed pages, preserving raw page
bounds before cutoff and eligibility filtering. It cancels pre-cutoff RECEIVED/QUEUED receipts
and retrying or pending-timeout FAILED message ordering heads. The latter use the existing
ordered-head partial index, including NULL chat keys, so terminal FAILED history is not scanned.
Both page orders retain the chat expression before `(created_at, id)`; for NULL chat it is
constant, but omitting it can make PostgreSQL sort an unbounded queue-prefixed index scan.
Historical nonmessage FAILED receipts are outside this selection. Existing legacy/source dispositions remain untouched.
Permanent exact semantic/message tombstones also stop late copies; they do not grant immunity
to an author or an entire chat. Claims remain immutable, including ambiguous action evidence.

The client captures exact action job exclusions, seals the operation, projects `CANCELLED`
without changing other receipt fields, and removes only selected webhook/action jobs through
BullMQ. Future schedules, publication actions and unattributed delayed cleanup remain intact.
Related source actions are denied at the final transport boundary even if their Redis job is
reintroduced. A still-locked job is retained and reported; its cancelled receipt/child guard
prevents execution after restart. Other moderation continuation queues retain their existing
exact-source guards. This is not a queue namespace reset.

The durable host journal is `/var/lib/maxim-deploy/backlog-cancellation.json`. Failure retains
the journal and stopped fleet; repeat the **same request** to resume. Never edit or delete the
journal, delete claim evidence, or advance the cutoff during recovery. A lost connection may
leave the single labelled helper; resume stops/removes only that exact helper before retrying.
SQL projection and job removal are idempotent. The host restarts only the captured generations.

A separately authorized new cancellation can start after `COMPLETE`: the host preserves the exact
completed journal in a content-addressed mode-0600 archive, then captures fresh runtime generations.
It never reuses an operation ID with a different cutoff or replaces an unfinished journal. Diagnose
and correct newly accumulating failures before a later cancellation; it is not a recurring drain.
The normal client also stores BullMQ snapshots in the lossless Base64 envelope described below.

If the initial `7f16c5f2` runtime exhausts its scan budget on terminal FAILED history, use
`python3 infra/scripts/resume-backlog-pending.py <same-private-request.json>` from the committed
compatible controller. It retains the cutoff, installed image, original snapshots and captured
fleet. Its additional selection walks the existing ordered-head partial index in 200-row pages,
including NULL chat keys, with a 100,000-row bound and a plain plan check. This completes the
already captured backlog plus every pre-cutoff pending message ordering head. Historical
nonmessage failures outside the captured set are not scanned or claimed as cancelled.
The controller may differ only in its five finite tooling/test/document paths. It retains its
source receipt and helper hash, mounts only that helper read-only into the original isolated
image, and uses the same deploy lock and journal. Green exact controller CI is required unless
the existing explicit emergency bypass and nonempty recorded reason are supplied. Never use
the continuation to change runtime code or the frozen request.
Redis job snapshots use an explicit `BULLMQ_JOB_JSON_UTF8_BASE64_V1` envelope when written by
the continuation, preserving the exact serialized JSON even when PostgreSQL rejects a string
in the original job metadata. A reviewed helper correction requires the exact last helper
digest in `MAXIM_BACKLOG_PENDING_PREVIOUS_SHA256`; the journal retains the initial digest and
every subsequent revision rather than replacing the previous evidence.

`COMPLETE` means cancellation and restart finished, not that latency is healthy. Record the
operation ID, cutoff, exact source/image, projected/removed counts and retained locked jobs.
Then sample fresh ingress windows including still-pending receipts, oldest fresh age, SQL
selection/preparation waits and execution outcomes. Finalize an interrupted release only after
the existing strict smokes pass. New backlog requires diagnosis; do not repeatedly move the
cutoff to hide a runtime fault.

Receipt-created measurement windows must have ended before observation. Include all statuses,
pending ages, cap/truncation and excluded-clock counts alongside completed-only percentiles;
an empty or future cohort proves nothing. Apply the sustained acceptance window in
[bot recovery](bot-reliability-recovery.md#capacity-and-acceptance) after fresh progress returns.

Local validation uses real isolated stores:

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- webhook-backlog-cancellation-postgres
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- cancel-webhook-backlog-v2
node --test infra/scripts/backlog-cancellation.test.mjs
node --test infra/scripts/backlog-cancellation-routing.test.mjs infra/scripts/backlog-cancellation-v2-host.test.mjs
```

The API Docker CI job separately runs `smoke-backlog-cancellation-v2-ci.sh` against
the exact built image on a rootful daemon with enforced memory and CPU limits.
It uses disposable fully migrated PostgreSQL/Redis, private data-only mounts,
the installed client and the real native isolation inspector. Both successful
cancellation and an injected pre-writer refusal must restore the same sixteen
container generations, with native auxiliaries first. API processes in this
fixture are idle identity fixtures: the gate does not claim production HTTP or
bot behavior acceptance. A rootless ABI rehearsal cannot replace this gate.
