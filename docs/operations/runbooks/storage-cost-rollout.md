# Storage and bot cost rollout

The initial runtime stages reduce delete-lease writes, bound the local chat-context
cache and skip exact repeated VK import observations. They add fixed runtime counters,
trusted-main CI layer reuse, unchanged settings/rollup write guards and sequential
binary Publication media preparation. Historical body/media expiry, receipt deletion,
database rewrites and notice-upload token reuse remain gated. See the
[full plan](../storage-and-bot-cost-optimization-plan-2026-10-01.md).

## Release and observation

Run the scoped checks and require green `Required` and `Analyze JavaScript and
TypeScript` CI checks for the exact source SHA. Deploy through the normal wrapper;
any API role selection expands to all 14 shared-image roles, including Publisher
and message retention. The queue ownership/pause fence, immutable image identity,
OCR sandbox attestation and strict smokes remain mandatory. Do not recreate
PostgreSQL or Redis. If local build capacity is insufficient, use the existing
verified exact-SHA CI image preload; retain the 10 GiB API build floor and 6 GiB
static floor. Required online multibot preparation has its own supervised 10 GiB
filesystem reserve; advisory peak estimates do not replace its live checks.

```bash
./infra/scripts/vps-connect.sh deploy main --plan
./infra/scripts/vps-connect.sh deploy main api-admin
./infra/scripts/vps-connect.sh postgres-audit storage
./infra/scripts/vps-connect.sh exec df -B1 / /mnt/maxim-cold
./infra/scripts/vps-connect.sh exec docker compose -f infra/docker-compose.yml exec -T api-admin node apps/api/dist/apps/api/src/scripts/audit-storage-runtime.js
```

The built `audit-storage-runtime` CLI requires the existing admin role and accepts
no arguments. It reads only the fixed Redis metric keys, starts no Nest workers,
makes no MAX or PostgreSQL calls, and prints allowlisted scalar JSON. The closed
system-admin endpoint is `GET /api/v1/system/metrics/storage-runtime`. Reports
publish every 30 seconds and expire after 90 seconds; collect after the first
publication. Missing, malformed, stale or unavailable reports are missing
coverage, not zero work. Reporting failure must not block bot work.

### Permission and SEND attribution

The additive `optimization` report uses fixed module names and counters only. Its
bounded envelope is 24 KiB per service, with the same 30-second publication and
90-second expiry; old or malformed attribution is `null`. It adds no per-message
Redis writes, SQL history, identities or arbitrary labels.

`authors` counts resolver invocations by rule module. `rosterSkips` is an explicit
skip of the member client call because a complete roster sufficed; `protectedSkips`
is a skip because the saved author was protected. `memberCalls` counts actual client
method invocations, including calls rejected before HTTP. `sharedReads` counts
reuse within one preparation scope, including reuse of a rejected promise.
`missingRoster` and `membershipRequired` overlap these outcomes; neither measures
savings. `errors` includes SQL failures. Calls can still be in flight at a snapshot,
so do not derive skips by subtracting other counters. These are not unique messages
or a measurement of every deletion path; the main handler's early policy is separate.

`demand` counts activity observations with missing versus known cached completeness,
local deferrals, refused SQL reservations and acknowledged/unacknowledged scheduling.
An acknowledgement can reuse an existing job; it proves neither a new job nor a
completed roster. `roster` classifies a background synchronization invocation by an
exact indexed completeness read before it starts: `bootstrap`, `refresh`, or `unknown`
when the diagnostic read failed. Its result separates completion, no sync, source
backoff, rate limits and other errors. Concurrent jobs can both observe bootstrap;
this is not the number of uninitialized chats. Actor-only probes are excluded.

`timings` contains disjoint duration buckets, total/max milliseconds, errors and
unknown clocks. `author` times the resolver. SEND phases are:

- `sendQuota`: the exact transport quota reservation, including rejected waits.
- `sendGuard`: preparation at POST `/messages` minus that quota time. This includes
  route, payload and feature checks, including remote reads performed by a guard.
- `sendHttp`: the HTTP adapter and response validation. A completed HTTP response
  does not prove a recorded message identity or ledger settlement.
- `sendReceipt`: the durable send-receipt completion call, including its exact readback.
- `sendLedger`: the outer dispatch ledger settlement call, which may handle errors internally.
- `sendDispatch`: the complete dispatcher invocation, including preparation and failure handling;
  it overlaps the inner phases and includes receipt recovery without a new send.
- `sendFirstQueue` and `sendRetryQueue`: wall-clock age from the later of enqueue and
  valid schedule to this invocation. Only calls with a supplied enqueue timestamp are
  included. Retry age includes earlier attempts and backoff, not just time in the queue.

All other clocks are monotonic; invalid clocks remain unknown. The phases cover
different populations and overlap as described: do not sum them or infer a cause
from one large bucket. Direct sends can contribute transport without dispatcher
timings. Fixed histograms locate a follow-up investigation; they do not establish
per-message causal traces, daily savings or authorization to increase quotas.

The additive `optimization.ruleStages` histograms retain the fourteen fixed
rule-engine stage names for older readers. `optimization.ruleSharedStages` adds
`stop-words-policy` for the shared legacy/modern word and domain matcher, and
`media-cooldowns` for the combined photo/sticker cooldown work. New engines no longer
attribute shared stop-list work to separate `blocked-words` and `blocked-domains`
clocks. Stage histograms use the existing wall clocks and describe completed
boundaries, including partial progress before a thrown error. They are not
eligible-message counts. Handler totals and inner rule stages overlap.

`optimization.ruleCoverage` has the shape
`{ schema: "rule-engine-coverage-v1", rows: [...] }`. Its rows are a fixed tuple
matrix in `RULE_COVERAGE_FAMILIES` × `RULE_COVERAGE_COUNTERS` order from
`apps/api/src/moderation/rule-engine-observation.ts`. Schema v1 fixes all fourteen
family positions and ten counter positions and meanings; additions or reorderings
require a new schema even when the matrix dimensions match. Readers reject unknown
schemas as unavailable coverage while retaining the other report fields.
Each engine invocation counts
each family at most once per counter, including multiple visible paragraphs and
modern/legacy stop-list matching. Counters distinguish configured and eligible
rules, completed evaluation and detection matches, disabled/content/state skips,
expired deadlines, errors and interrupted later families. A match is detection evidence,
not a sanction or proof of an external effect. An error preserves completed earlier
observations; an abrupt process loss or an operation that never unwinds has no
completed observation. Guards and policy rechecks outside canonical detection are
excluded. Never infer successful non-matches from skipped or unavailable state.

When no paragraph was evaluated, skip priority is `expired`, `state`, `content`,
then `disabled`; a later empty paragraph cannot hide an unavailable result.
`expired` records exhausted message-limit counter wait/write deadlines or a traffic
violation rejected by its enforcement clock window. Traffic state lookup failures
remain `errors` under the existing fail-open behavior. Missing, invalid or stale
revisions, pre-dispatch unavailability, and message-limit events rejected by the
existing old/future admission check remain `skippedState`.

For modern stop lists, `eligible` counts dispatch to a configured family evaluator;
it includes inputs with empty sources or no usable domain links. This is not a
content-admission count. Legacy word/domain detectors observe their existing
content-admission boundaries, so their eligibility rates describe a different
population and must not be compared as equivalent coverage.

`optimization.contextSource` uses monotonic clocks
around each complete SQL-source attempt: `coldLoad` has no retained settings
candidate; `candidateLoad` includes the compact proof and any full fallback.
Errors remain in the same population. Compare these timings with `fullLoads`,
`shellReads`, `reuses` and cache activity, rather than treating every candidate as
a reuse. Older or corrupt additive blocks remain unavailable, preserving the
other optimization counters. These blocks use the existing process report and
add no Redis exchange per observation. Readers predating the 24 KiB bound can
temporarily reject a larger report during a mixed-version rollout.

Keep saved snapshots owner-private. Retain only fixed service names, epochs,
numeric metrics and fixed readiness/condition enums. Full ready responses and
monitor logs may contain identifiers; archive only their allowlisted readiness,
numeric queue lag and fixed state. Do not save env, tokens, message/media payloads,
free-form errors, SQL, chat/user/bot IDs or arbitrary labels. The existing
`monitor-readonly` capacity archive already performs its own stricter sanitization.

Compare runtime counters separately for each service with the same `startedAt`;
any counter decrease invalidates that counter's interval. PostgreSQL restart,
database-statistics reset and WAL-statistics reset have independent boundaries.
Report gaps explicitly and normalize work by comparable traffic. Require at
least one day of comparable coverage before extrapolating capacity or savings;
queue-lag percentiles are not API/action response latency. Cache bytes estimate
retained data, not RSS. VK rows-written counters describe statement activity,
not committed transactions; skipped rows also include publication fences.
Table totals already include indexes and TOAST: never add them twice.

### Fleet stage-one attribution and repeated work

The additive `chatContextCache.activity` separates coalesced loads, Redis reads and
hits, Redis misses/unavailable or rejected payloads, and source loads. An L1 miss
does not establish a PostgreSQL load. Fixed invalidation reasons report both
observed events and actually evicted L1 entries; a local notification echoed over
Pub/Sub can produce multiple events without multiple evictions. Old or unrecognized
reason payloads are `legacy`. Missing activity in an older report is unavailable
coverage. Rights, revision checks and denial replay invalidations remain mandatory.
Concurrent title refreshes skip only an already identical normalized title.

### Verified settings templates

Each process may retain private ChatSettings templates. The default estimated
byte budget is 16 MiB and 2,048 entries. `CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_BYTES`,
`CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_MEDIA_BYTES` and
`CHAT_CONTEXT_SETTINGS_TEMPLATE_MAX_ENTRIES` configure bounded retention; the media
budget must be smaller than the total. Production's four realtime moderation roles
use 72 MiB total, 8 MiB media and 8,192 entries, leaving 64 MiB for compact settings.
Other roles retain the defaults. This cache never establishes freshness. Every
source refresh with a candidate reads the exact settings ID and nullable UUID
revision together with fresh title, bot binding, administrators, active domains
and rules publication fields in one SQL snapshot. An exact match reuses a cloned
settings object. A cold or changed proof loads settings and every mutable shell
relation with one MVCC SELECT. The exhaustive typed scalar projection preserves
native timestamps, arrays and JSON values without serializing the settings row.
Missing settings still use initialization, which does not seed an unverified template.
An unchanged candidate needs one compact SELECT; a changed candidate needs the
compact probe followed by one full SELECT. No database migration is required.

Local full-context reads and writes require an acknowledged invalidation subscription.
Connection errors, closure, reconnect and end clear local contexts, retire in-flight
read generations and clear local bot bindings. Reads during the gap use the existing
Redis revision proof or SQL fallback. Redis `ready` alone is insufficient: a fresh
explicit subscription must acknowledge, then local state is cleared again before
reuse. Delayed replies from retired generations cannot refill local contexts or
bindings. Revision-verified settings templates remain reusable; existing 30-second
local and 60-second Redis deadlines are unchanged. Failed reconnect subscriptions
retry while the connection is ready, and shutdown cancels retries.
The full-context Redis v4 body, 60-second source deadline, 30-second L1 deadline,
revision CAS, access generations and complete-media recovery remain in force.

The default template budget is split into 8 MiB for compact settings and 8 MiB for
shared media. Increasing compact capacity does not increase the media segment.
Templates over 2 MiB of estimated full content or 256 KiB of compact content
bypass retention before evicting unrelated entries. SQL still returns complete
settings. The two configured media fields share immutable values by SHA256 when
their serialized size reaches 64 KiB. Media capacity evicts dependent templates
without evicting ordinary small settings; compact bytes and total entry count
retain their own LRU limits. Releasing the last template releases its shared media.
Capture complete candidates before awaiting SQL so eviction cannot truncate an
in-flight result. Only a successful SQL proof materializes private JSON containers
and dates; immutable base64 strings can be shared. These budgets exclude in-flight
results and do not guarantee total process RSS. Retain regression coverage in
`chat-settings-template-cache.spec.ts` and `chat-context-settings-cache-postgres.spec.ts`.

The realtime expansion addresses observed compact-segment churn; it adds at most
224 MiB of estimated retained capacity across the four processes. Compare matching
process epochs and workload intervals for `capacityEvictions`, `fullLoads`, `reuses`,
compact/media occupancy, heap/RSS and actual action latency. A larger cache or a
synthetic reuse result alone does not prove lower production p95/p99. Reverting the
three overrides restores the defaults without changing persisted data or rights.

The additive metadata table and static trigger advance the UUID on every settings
INSERT or UPDATE, including older runtime and raw SQL writers. Existing unchanged
rows deliberately have no metadata and use their settings ID plus a null revision.
There is no backfill or historical settings rewrite. DELETE cascades metadata;
recreation and source-key changes get a fresh UUID. Application rollback keeps
the table and trigger installed. Restoring a database from before this migration
and reinstalling it requires restarting all API roles that may retain templates:
the old settings ID/null baseline must never survive a different database incarnation.

The optional `chatContextCache.settingsTemplates` report exposes fixed cache
capacity and counters plus `fullLoads`, `shellReads` and `reuses`. A shell mismatch
can count both a shell read and a full load; `sourceLoads` retains its original
meaning. Template `hits` mean a candidate existed, while `reuses` count successful
SQL proofs. Missing or corrupt template reports remain unavailable without
discarding older full-context counters. Bytes estimate retained content, not RSS.
Optional `segments` reports compact/media budgets and bytes, shared blob count,
reuse and media evictions; older writers without that block remain readable and
do not imply zero media usage. Reports contain no chat IDs, hashes or media content.
This optimization reduces heavy SQL transfer on repeated source refreshes; complete
L1/Redis hits do not use it, and changing settings adds a probe before a full read.

The additive `deleteDueSweep.handoffOutcomes` distinguishes `insertedCount`,
`existingCount`, `reusedCount` and `observationErrorCount`. The sweep first reads
the same deterministic BullMQ job that `add` would reuse. An existing job is left
intact, avoiding another duplicate-add write; if it disappears immediately after
observation, the unchanged next sweep repairs its wakeup. A missing job uses the
normal deterministic add with a fresh diagnostic token. Only a matching token read
from the persisted job proves this invocation inserted it. A different token can
also follow completion and replacement of our job, so it cannot prove a duplicate.
A vanished or replaced job, or failed post-add read, increments the existing
`handoffInsertionUnknownCount`. Observation failure never
revokes an acknowledged add or grants execution authority. `reusedCount` is the
subset of existing jobs that avoided `add`; `handoffAcknowledgedCount` includes
these existing-job observations before add as well as acknowledged adds. These counters do
not count distinct intents, pending deletions or completed external actions.
Older reports without `handoffOutcomes` retain unknown coverage for this breakdown.

The due sweep observes existing BullMQ jobs in Redis pipelines of at most 100 job
hashes. Each hash is decoded through BullMQ's public job parser; an empty hash is
missing, while a command error or malformed hash remains an observation failure
and falls back to the original deterministic add for that intent. A batch failure
does not discard independent handoffs. Post-add insertion attribution still requires
the exact diagnostic token read from persisted data. Batching reduces Redis network
exchanges; it does not reduce SQL candidate selection or extend the one-second
repair cadence. Interactive producers retain their ordinary enqueue and promotion.

Publisher recipient-blocker cleanup checks and locks the exact envelope lease with
`SELECT ... FOR NO KEY UPDATE`, preserving transaction serialization without a
synthetic envelope UPDATE. Heartbeats and actual delivery/occurrence changes still
write normally. The native regression checks tuple identity and lease takeover;
this removes two known sources of unnecessary tuple versions without attributing
all observed `managed_broadcasts` updates to them. VK import freshness timestamps
remain required observations; their high write ratio alone does not justify
suppressing them.

Compare same-epoch snapshots under comparable traffic, including misses, errors and
unknown outcomes. A short post-release sample establishes that these instruments
work; a full day covering scheduled publications, media and traffic peaks is still
required before estimating fleet capacity or percentage savings.

The later additive `deleteReconciler` report preserves old reports that lack the
field. Its fixed phase calls, results, error counts and monotonic duration buckets
do not change the one-second recovery cadence or hourly cleanup cadence. A
successful phase's `returnedCount` describes that method's returned scalar; it
is not an idle/pending/committed-work measurement. See the
[consumer and metric semantics matrix](../storage-body-lifecycle-consumer-matrix-2026-10-01.md).

Delete recovery selects an ordered prefix separately for each of its five fixed active
statuses, using the existing `(status, next_attempt_at, execute_at)` index. It then orders
at most five batch prefixes by their within-status position, then due/creation keys,
and retains the original total batch limit. With the standard batch of 100, an older
AMBIGUOUS backlog cannot occupy every slot ahead of PENDING/RETRYABLE work. This avoids a whole-population sort before a mixed-status LIMIT.
Each prefix retains all due, rollout, retry-evidence and retention predicates; only the
in-progress prefix requires an expired lease. `FOR UPDATE SKIP LOCKED` remains inside
each prefix, with at most five batch prefixes locked for the statement's lifetime.
Selection does not claim an execution lease or authorize an external retry.

The sweep's reason `EXISTS` probes retain their intent correlation with `OFFSET 0`.
Without that planner boundary, PostgreSQL can build hashed subplans by scanning the
whole reason inventory repeatedly for each status prefix, even when very few intents
are selected. The predicates and retry-cap evidence checks are unchanged. The real
PostgreSQL fixture checks reason-row visits as well as intent-row visits, with optional
rollout scopes both enabled and disabled; one bounded outer LIMIT alone is insufficient.

This is not a physical scan cap: rejecting eligibility predicates, equal due-time groups
or locked rows can require more index visits. The disposable PostgreSQL regression
compares a 50,000-row mixed-status population, verifies ordered results and concurrent
lock skipping, and checks that selection does not traverse the full eligible fixture.
Use the existing per-stage runtime duration counters to assess the live effect; do not
infer recovery from a single plan or Redis handoff acknowledgement.

The follow-up settings write guard compares JSONB values without depending on
property order, preserves raw-value repair and the existing `updatedAt` CAS, and
omits only unchanged media from the UPDATE. The forward-only rollup migration
preserves legacy arrays, feed/counters and transaction timestamps. It shortcuts
only physically small canonical empty/singleton arrays and exact unchanged
hour timestamps; larger or malformed arrays use the original DISTINCT cleanup.
Neither change rewrites historical rows or promises filesystem reclaim.

Canonical Publication execution selects only metadata for the exact content
revision and author before preparation. It then selects immutable bytes for one
asset at a time under the same revision, author, digest and size predicates, and
passes a Buffer view through the existing byte validator and upload protocol.
Image order, filename normalization, per-bot occurrence cache, progress heartbeat,
retries and pre-send ownership fences stay in place. Media-only posts still use
the normal message builder. Tagged remote video for the exact bot selects no local
bytes; the local video cap remains 24 MB and the scheduled image cap remains
6,000,000 bytes. Public/legacy DTO loaders still support base64. This removes an
internal conversion and multi-image byte preloading; it does not prove a particular
RSS reduction or impose a new admission/defer protocol.

## Release-image reclaim

For a separately reviewed maintenance preview, use the same deploy lock and the
manifest-aware tool with the five-release floor explicitly set. The production
CLI also defaults to five distinct release IDs and refuses a lower value:

```bash
./infra/scripts/vps-connect.sh exec bash -c '
set -euo pipefail
source infra/scripts/lib/deploy-lock.sh
source infra/scripts/lib/legacy-cold-maintenance.sh
acquire_deploy_lock
maxim_require_ordinary_effect_authority "$PWD"
node infra/scripts/release-image-reclaim.mjs reclaim \
  --state-dir /var/lib/maxim-deploy --until 168h \
  --minimum-retained-releases 5 --dry-run
'
```

Review the candidates, then repeat that same locked invocation with only
`--dry-run` removed for apply. The tool rechecks current/retained manifests and
all container references immediately before deletion. It removes only unused
old immutable MAXIM image refs. It preserves all retained releases, containers,
volumes, shared build cache and sibling-project images. Displayed image sizes
do not predict physically reclaimed bytes; compare `df -B1 /var/lib/docker`
before and after.

An interrupted release may have no `current.json`. Reclaim then requires exactly
one complete, verified typed transition as its recovery base; its images, every
retained manifest and every container reference remain protected. Missing,
partial or ambiguous transition evidence refuses cleanup. This does not finalize
the release, relax component history floors, or bypass an incomplete cold-recovery
journal. The maintenance wrapper accepts an explicitly reviewed `--until` cutoff;
the optional deploy hook always keeps its fixed seven-day cutoff.

An optional normal-deploy hook uses that fixed seven-day cutoff and minimum five
distinct retained release IDs:

```bash
MAXIM_DEPLOY_RECLAIM_OLD_IMAGES=1 ./infra/scripts/vps-connect.sh deploy main api-admin
```

It is off by default, runs under the held deploy lock only after a newly committed
successful release and all strict smokes, and reports filesystem bytes. A reclaim
warning leaves the successful release valid; inspect it and rerun preview before
retrying cleanup. Do not retry a deployment solely because optional reclaim failed.

Global release count alone does not provide distinct component versions: static-only
releases can repeatedly inherit the same API image. Manifest pruning additionally
preserves representatives of two known distinct image IDs for each active component.
When that history is missing, it preserves all available manifests; reclaim preview
reports the gap and apply refuses cleanup. This is image availability, not schema
compatibility. An API rollback still requires the selected API source to contain the
live applied migrations and pass every existing source-floor and runtime guard.
In particular, an image predating a newly applied migration is not automatically a
valid rollback target. Artifact expiry also limits recovery: the one-day CI artifact
is not a permanent off-host backup of older releases.

## Gates for later stages

Historical UPDATE/DELETE/DROP, retention activation and physical rewrites require
a fresh encrypted full backup, verified checksum, complete isolated PostgreSQL 16
restore, replay/receipt safety checks and sufficient maintenance capacity. The
[watched backup](watched-postgres-backup.md) is attended and readiness/queue/space
gated; an archive list is not restore proof. Budget a restore outside the production
root filesystem and leave existing verified backups until the new chain passes.
A logical restore measures compact restored size; it does not measure production
bloat. Deletion/ordinary VACUUM does not guarantee filesystem space recovery.

Deferred notice-upload reuse requires both the current send-owner fence and the
exact bot plus immutable asset identity (content digest/version). Invalidate only
the exact rejected token with CAS after a definitive documented media-token 4xx
rejection, then reacquire the upload lease; a concurrent newer token must survive.
Do not reuse tokens across bots or retry an ambiguous send/timeout/5xx as a token
failure. Other 4xx statuses do not automatically authorize reupload. These
requirements describe a future change; this rollout does not activate that cache.
