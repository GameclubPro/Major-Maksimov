# Multibot execution authority rollout

The configured Major fleet has no algorithmic nine-bot limit. One chat keeps one
healthy read executor; action-specific routes may use a different capable member
without promoting that member to primary. Private replies and Publisher exact
bindings have their own authority and must not borrow Major membership.

## Compatibility release

Deploy the shared API image to every API role under the normal queue fence. Use
the impact planner and green Required/CodeQL checks for the exact release SHA.
Without the exact successful effects-cutoff receipt, deploy checks multibot
preparation capacity read-only before image builds and release-transition
journaling, then checks fresh capacity again after all builds before online
preparation.
The deploy builds the immutable images, then prepares the full immutable
migration prefix through `20261005016100_index_multibot_retention_cursor` while
old ingress and workers remain live. The prefix helper uses one official Prisma
deploy against a temporary copy of the original migration bytes. It excludes
the later command-authority cutoff and tombstone relation migrations; it never
rewrites SQL, resolves a failed receipt or retries a failed preparation.

The online prefix adds nullable webhook metadata in
`20261005015900_prepare_multibot_webhook_columns`, builds the semantic order
index in `20261005016000_add_multibot_semantic_order_index`, then builds the
retention cursor and replay-fence indexes in
`20261005016100_index_multibot_retention_cursor`. There is no history backfill.
Both semantic indexes exclude NULL semantic keys; equality lookups retain their
existing coverage. The status/created-at/id retention index covers all statuses.
Online additive DDL has a five-second lock wait and thirty-second statement
limit. Concurrent index builds are serialized, with a five-second lock wait and
1,800-second statement limit per index. The complete prefix invocation has a
5,700-second wall-clock ceiling. These limits bound an attempt; they do not
promise a completion time. Existing index names fail rather than skip a partial
build.

Preparation checks fresh storage metadata and data/temp/WAL/Docker filesystem
capacity. Admission requires at least **10 GiB (10,737,418,240 bytes)** free on
each involved device. The estimated index, temporary-sort, WAL and runtime peak
remains in the report, adding modeled budgets on shared devices rather than
treating their free space independently. That estimate is advisory and does not
raise the admission threshold. Unknown or unsupported storage layouts abort.
`max_wal_size` controls checkpoint pressure and does not cap WAL disk use. A
successful build-image disk check does not replace this preparation gate.

The production path uses `multibot-online-supervisor.mjs` to enforce the reserve
throughout preparation with bounded, non-overlapping filesystem samples and a
final fresh check before accepting success. The supervisor assigns one canonical
UUID-v4 `maxim-online-<uuid>` tag to its migration container and PostgreSQL
`application_name`; never persist this attempt-specific tag in production `.env`.
The Prisma helper clones its environment and retains all other database URL
settings. A conflicting tag or unsupported connection URL aborts before Prisma.
Native PostgreSQL tests verify that the actual Prisma engine preserves its exact
session tag.

If the free reserve falls below 10 GiB, a sample cannot be obtained, the storage
device changes, or the bounded attempt is interrupted/expires (including an SSH
hangup), the supervisor
aborts preparation. Cleanup addresses only its exact tagged database sessions
and migration one-off container. It must not stop old API roles, clear failed
migration receipts, resolve them or retry partial SQL. Unconfirmed cleanup fails
the release; it cannot authorize quiescence or the effects cutoff. Preserve
partial concurrent indexes for reviewed recovery. The sampled reserve does not
guarantee enough space for every possible peak or prevent exhaustion between
checks. Review advisory estimates and observe I/O/queue behavior during the run.

The capacity probe receives the same structured Compose arguments as the deploy:
`--env-file .env -p <project> -f infra/docker-compose.yml`, including any subsequent
`-f` overlays. Preserve their order and values. Removing the environment or project
to pass validation can inspect a different PostgreSQL container. Unknown flags,
missing values, repeated environment/project selectors or missing Compose files
abort before any catalog/filesystem command; multiple file selectors are supported.

Preparation separately probes fixed local ingress/admin readiness every ten seconds.
Both database/Redis checks and fresh queue-sample timestamps must be valid;
missing, malformed, stale or dependency-failed evidence aborts. Admission and final
checks require readiness with at most ten seconds of queue lag. During work,
queue-only pressure above thirty seconds for ninety seconds, or above 120 seconds
immediately, aborts only the exact owned preparation and preserves its partial state.
These runtime gates are independent of the 10 GiB disk reserve.

The launcher creates its exact UUID-named client before sending any start request.
Cancellation waits for that creation to settle, removes the owned object, and
verifies both container and tagged-session absence. A timed-out or ambiguous
creation is unconfirmed cleanup. Killing a Docker client alone does not prove
that the daemon cannot subsequently create or start a database client.
The CLI records the attempt tag and UTC admission start before creation. A closed
SSH output pipe follows the interruption path and waits for owned cleanup.

## Interrupted retention-index preparation

`postgres-audit multibot-preparation [--explain]` is a fixed read-only catalog report
for the five receipts 159/160/161/200/202 and three exact indexes. Provision the
eight reviewed receipt column grants first. The report never reads webhook bodies
or emits raw migration logs, session identities or SQL. It does not authorize repair.

Before the effects cutoff, an operator-cancelled 161 attempt can use
`recover-multibot-preparation` through the normal exact-SHA CI wrapper. Preview is
read-only. Supply the reviewed cancelled source and baseline source, original
UUID-tagged attempt, observed start/abort UTC bounds; apply additionally requires
the exact receipt identity hash and transition-journal hash from the preview.
The transition journal contains the previous release inventory, not the target
source of the cancelled attempt. All fourteen baseline roles must still match it.
API containers without a configured Docker healthcheck must be running on that
exact image; a configured check requires a healthy result. Fresh ingress/admin
readiness and low queue lag are separate mandatory admission checks before any
recovery mutation, not inferred from container state.
The original source's immutable migration checksums must match the reviewed code.
Ambiguous receipts, other builders, repair artifacts, started cutoff, schema drift,
or a missing/changed journal abort without resolution.

Recovery runs only the fixed CREATE or REINDEX INDEX CONCURRENTLY needed for 161,
with one PostgreSQL maintenance backend, 512 MiB maintenance work memory, a 6 GiB
per-backend temporary-file limit and a 3600-second statement limit. The complete
recovery has a 7500-second wall-clock ceiling. A fresh two-minute low-lag window
precedes every operation; the same reserve/runtime supervisor applies during work.
Available host memory is checked again after that window and immediately before
DDL. The PostgreSQL client uses the running PostgreSQL image ID and its attested
Compose network, with no stateful volumes. Its inherited PostgreSQL data volume
is overridden by a 64 KiB read-only tmpfs; the actual Docker CI smoke verifies
that no anonymous or bind-mounted volume is created and checks the backend's
maintenance, temporary-file and parallel-worker settings. Prisma resolution uses the retained
cancelled API image ID, a read-only migration bind and bounded temporary storage;
only the attested local `maxim` database/user and `public` schema are accepted.
Temporary-file limits exclude index/WAL output, and one worker is not an I/O cap.
These budgets allow a measured attempt; they do not certify coexistence with live
traffic. A failed repair preserves any concurrent-repair artifacts for separate review.
Only three fully valid exact indexes permit Prisma resolution; verify the unchanged
original rolled-back receipt and the new applied receipt that Prisma creates.
Then resume normal deploy with explicit transition-journal adoption. This helper
does not change messages, queues, live roles or release manifests.

The storage audit at `2026-10-05T03:08:44.392856Z` estimated 46.85 million webhook
rows, with 87.95 GB of table storage including 17.95 GB of TOAST, and 30.73
million execution claims with 7.87 GB of table storage. Each concurrent webhook
index can still require multiple passes over roughly 70 GB of heap. Excluding
historical NULL keys reduces sorting and index storage, not the heap-read cost.
The recorded 64 MiB `maintenance_work_mem` and 128 MiB `shared_buffers` do not
establish a build throughput. Observe I/O pressure, queue trends and the old
runtime during preparation; the short local catalog benchmark below does not
measure these production index builds. Use the fixed `postgres-audit storage`,
`activity` and `queue` reports and `monitor-readonly`, not application-table scans.

Before pausing consumers, the deploy attests exact key order, predicates, table,
access method, default operator classes/collations and valid/ready/live metadata for
`webhook_events_semantic_order_idx`, `webhook_events_status_created_at_id_idx`, and
`webhook_events_semantic_replay_fence_idx`. Only then pause and stop webhook
consumers and stop/verify legacy ingress: legacy Start processing runs inline
there, so a queue pause alone cannot establish the effects cutoff. The short
`20261005020000_add_multibot_order_fences` migration adds command/business/order
fields and records that cutoff after quiescence. Later releases with the exact
successful cutoff receipt skip the online preparation stage.

The tombstone relation migration uses a three-second lock wait and thirty-second
statement limit. Under both table locks it requires the exact previously
validated CASCADE/CASCADE foreign key on the same child/parent columns, then
atomically makes the relation nullable and replaces it with SET NULL/CASCADE
`NOT VALID`. The old validated relation supplies historical reference proof;
the replacement still enforces new and changed references. This avoids a new
validation scan over tens of millions of claims. A separate future validation
scan requires its own bounded maintenance review; this release does not run it.

If online preparation fails, old ingress and workers remain live. Preserve the
failed migration receipt, partial indexes and release transition journal; a
timeout does not authorize clearing errors or accepting an existing index by
name. Recovery must verify the exact migration checksum and complete catalog
state before resolving its receipt. After the effects cutoff begins, preserve
the queue fence and recover through the exact-image release path; never restart
a legacy producer against that cutoff. New workers start only after migration
and index proof, and the new current manifest is recorded only after strict
runtime smokes.

Semantic business claims and command authority remain mandatory with the
configured canonical diagnostics mode `off` or `shadow`. A completed EXECUTION
claim survives webhook-body deletion as a semantic tombstone. Never delete that
claim simply because the body has reached its retention date. Pending leases,
quarantines, historical command holds and ambiguous MAX outcomes keep their
existing proof pins. A started rule engine may not be replayed to switch bots;
its durable action/delete/media journals own continuation.
Unfinished enforced claims created before the successful command-authority
migration also need exact effects proof: the earlier runtime could release its
lease after partial effects without recording `businessStartedAt`. Quiescing
workers does not certify those historical attempts as unstarted. Unfinished
unenforced semantic claims remain held regardless of their creation time. Receipt-only
diagnostic claims for unsupported/keyless events do not establish semantic authority.
The old `off` path could execute without an EXECUTION claim. A new claim therefore
cannot certify an old receipt or a late mirror as new work. Unstarted shared
semantic authority also requires a post-cutover owner receipt and trusted original
source time. For `message_created`, an old message creation time still holds the
event when the enclosing update time is newer; edits use their own update time.
Missing, invalid, ingress-derived or future source time cannot supply this proof.
Those shared events remain held for exact effects recovery, which intentionally
also holds fresh malformed events. Ordinary MAX timestamps remain supported;
readiness deadline fallback alone never certifies the absence of historical effects.

Rollback through either repository wrapper must retain semantic authority,
command results/order fences, mutation ambiguity handling, final executor proof
checks and tombstones. Environment downgrades do not authorize replay. A release
older than these guards is rejected even if its image still exists.
The reviewed `main` connection wrapper requires the multibot-authority entrypoint
marker before the API rollback's offline path; older minute-reader tooling is
replaced under the shared lock and exact-main checks. Static-only rollback keeps
its existing offline path.

## Capability and deadline checks

Use exact bot membership checks through the existing MAX governors. A role alone
does not prove read-all, send, delete, edit or member-management capability.
Unknown/expired proof triggers bounded targeted refresh with per-chat Redis and
local coalescing. A definite capability rejection can choose a peer from the
whole configured active roster. An attempted SEND/BAN/KICK with an unknown
outcome remains fenced to its original identity; never test a second executor
to discover whether the first attempt succeeded.

Unstarted readiness waits use the original trusted source time (receipt time
for invalid/future timestamps), capped at five minutes for text and ten minutes
for complete IMAGE content. Each rule's shorter deadline still applies. Retries
and mirrors cannot extend any deadline. When no capable executor exists at the
deadline, settle only the exact unstarted owned receipt/claim and report
`NO_EXECUTABLE_OWNER` in closed diagnostics. Keep user groups silent.

## Acceptance and gradual activation

Use real PostgreSQL, Redis and BullMQ locally. The baseline fleet matrix is
1/4/9 and the extension is 3/6/12. Cover demotion/removal, limited rights, missing
lifecycle webhook, old local caches in separate roles, concurrent/late mirrors,
process restart, unknown outcomes, source edits, mixed delete reasons and
sanction-window boundaries. Only the designated test chat/channel from API
notes may receive live test mutations; clean up agent-created content only.

Before activation, record the current manifest, canonical mode/cohort, queue
oldest age, rate, MAX quota waits, SQL preparation/selection timings, authority
holds, telemetry loss and false/duplicate effect counts. Measure uniform/hot
traffic, cold routes and media separately on 10,000/12,000/30,000 chat catalogs.
Cache microbenchmarks cannot establish end-to-end capacity. Record offered rate,
logical message rate, receipt rate, action rate, duration and hardware with each
measurement. Stop increasing offered load when queue age keeps growing.

Semantic execution and command safety are mandatory for the entire compatibility
release. Canonical control modes remain compatible, but their percentage cannot
disable shared execution authority for supported semantic events. Observe
representative cohorts separately; do not describe a percentage change as
gradual activation of the safety implementation.
Expand observation through cohorts of 1%, 10%, 50%, 100%, observing each for at
least 24 real hours before advancing. Require zero false/duplicate sanctions,
preserved rule deadlines and MAX quotas, and no sustained queue growth at the
measured profile. The target diagnostic mode is `on`. Missing evidence, truncated
diagnostics or telemetry losses are not a successful acceptance run. Expand
resources as a separate change only after measuring the limiting stage.
All four 24-hour cohort observation stages remain pending in this release
checklist. The local measurements below do not complete a stage or establish
production acceptance; advancement requires dated production evidence for the
deployed release identity.

The repeatable local catalog driver is:

```sh
node scripts/agent/with-test-stores.mjs --migrate -- npm run loadtest:multibot-catalog --workspace @maxim/api -- --chats=10000,12000,30000 --bots=9 --messages=40 --rate=2 --output=artifacts/multibot-load.json
```

It refuses nonlocal stores, uses simulated MAX transport under the normal token
quotas, and asserts one logical claim/violation/intent/DELETE per source message.
Repeat with other fleet counts and rates. The `media` profile covers attachment
receipt and text/length rules; it does not measure native IMAGE decoding or OCR.
The driver reports its hardware, offered rate, latency and final backlog. Finite
local samples cannot certify a production maximum or replace daily observation.

Use `--profiles=mixed --quota=25 --violations=50` to interleave four hot chats with
quiet events during the same stream. This profile requires at least five chats and
5–10,000 messages. The catalog driver defaults to a 25 rps token quota with no burst;
`--quota=30` is an explicit comparison profile. Existing standalone harness callers
retain their original defaults. Record topology, enqueue mode, quota and offered rate.
For a single-process `--enqueue=production` run, set `PRISMA_PG_POOL_MAX=24` in the
child environment. Split runs use `with-test-stores.mjs --profile=split-load` and
retain their existing per-role pool allocation.

The mixed report includes the expected manifest and its hash before ingress, with
KEEP/DELETE, exact executor, target and cohort expectations. Per-cohort outcome and
confirmed-delete clocks start at logical ingress and require completed ownership,
positive delete/verification evidence and the simulated message state. Missing,
unfinished, quarantined, expired and unknown outcomes remain in the denominator;
incomplete timing sets have no complete-population percentiles. Use `--latency=p95,p99`
to set an explicit millisecond gate. Without it, latency is observational and cannot
be described as a passed speed target. These synthetic labels do not establish
classifier precision on real messages or native OCR/media capacity.

## Local catalog measurements, 2026-10-05

PostgreSQL 16, Redis 7, BullMQ and Node 24.21 ran on Linux with an Intel
Core i5-14600KF, 20 logical CPUs and 31.3 GiB reported host RAM. MAX HTTP responses
were simulated; the production governors remained enabled. Each catalog had nine registered
members per chat and one shared healthy primary token. The fixture used one
webhook queue and one delete queue, each with concurrency four; it does not
measure the production sixteen-shard topology or nine-token aggregate capacity.

The final run was recorded at `2026-10-05T06:02:57.636Z`. At two logical
messages/second (18 physical deliveries/second), each profile submitted 40
messages over 20 seconds. All twelve profiles passed and completed 480 unique
EXECUTION claims, violations, violation message claims, successful intents and
simulated remote deletes from 4,320 receipts. Each profile completed exactly 40
of each logical identity/effect and left zero pending receipts or actions. The
observed logical completion rate including drain rounded to 2.00 messages/second
in every profile.

| Catalog chats | Profile               | Ingress p95 | Receipt completion p95 | Action p95 from intent creation | Drain after input stopped |
| ------------- | --------------------- | ----------- | ---------------------- | ------------------------------- | ------------------------- |
| 10,000        | Uniform               | 21 ms       | 82 ms                  | 38 ms                           | 5 ms                      |
| 10,000        | Hot                   | 11 ms       | 72 ms                  | 33 ms                           | 13 ms                     |
| 10,000        | Cold                  | 11 ms       | 72 ms                  | 32 ms                           | 16 ms                     |
| 10,000        | Media receipt/caption | 10 ms       | 70 ms                  | 32 ms                           | 6 ms                      |
| 12,000        | Uniform               | 12 ms       | 75 ms                  | 34 ms                           | 3 ms                      |
| 12,000        | Hot                   | 10 ms       | 69 ms                  | 33 ms                           | 13 ms                     |
| 12,000        | Cold                  | 10 ms       | 75 ms                  | 32 ms                           | 11 ms                     |
| 12,000        | Media receipt/caption | 12 ms       | 75 ms                  | 31 ms                           | 9 ms                      |
| 30,000        | Uniform               | 14 ms       | 73 ms                  | 33 ms                           | 5 ms                      |
| 30,000        | Hot                   | 10 ms       | 68 ms                  | 33 ms                           | 3 ms                      |
| 30,000        | Cold                  | 10 ms       | 72 ms                  | 33 ms                           | 5 ms                      |
| 30,000        | Media receipt/caption | 10 ms       | 71 ms                  | 32 ms                           | 11 ms                     |

The configured governor limits were 30 requests/second per token, five per
bot/chat, two for managed refresh and two mutations per target. Critical,
interactive and background service lanes were 13/10/7 requests/second. The
actual simulated MAX request count was 123 for each hot profile and 160 for each
other profile. These limits and counts do not represent nine independent tokens
doing concurrent work.

The media values cover attachment ingress and text/length moderation; native
IMAGE decoding, image duplicate analysis and OCR capacity remain unmeasured.
Uniform/cold/media profiles touch a spread sample of forty chats per catalog;
the hot profile touches four chats. The measured catalog cardinality therefore
does not prove simultaneous sustained activity in all catalog chats. Backlog
samples were taken every ten logical submissions, excluding drain peaks. The sampled
receipt peak was nine in every profile, the largest sampled oldest receipt age
was 16 ms, and sampled pending actions were zero. Completion p95 ranged from
68 to 82 ms. These short samples do not establish a sustained trend. Unsampled
peaks and sustained queue behavior over longer windows remain unknown.

The earlier exploratory run, recorded at `2026-10-05T01:58:50.447Z`, used the same
queue fixture with one primary token on 10,000 chats. It offered five logical
messages/second (45 physical deliveries/second), 120 messages per profile over
24 seconds. The SQL due sweeper
ran every second and drain waited for both BullMQ and SQL work. All four profiles
ended with 120 unique successful actions each and zero pending work. The higher
rate grew the queue and therefore does **not** qualify as sustained supported
load. Its eventual successful drain is separate from the final measurement at
two logical messages/second above.

| Profile               | Receipt p95 | Action p95 from intent creation | Drain after input stopped | Completed logical messages/s including drain |
| --------------------- | ----------- | ------------------------------- | ------------------------- | -------------------------------------------- |
| Uniform               | 3,193 ms    | 2,214 ms                        | 6,764 ms                  | 3.90                                         |
| Hot                   | 2,752 ms    | 2,890 ms                        | 3,558 ms                  | 4.35                                         |
| Cold                  | 33,762 ms   | 53 ms                           | 35,417 ms                 | 2.02                                         |
| Media receipt/caption | 2,895 ms    | 2,272 ms                        | 4,186 ms                  | 4.26                                         |

Cold rights refresh reached the existing two-request/second managed-refresh
source budget for the shared primary. Its sampled receipt backlog reached 674
with oldest age 18,407 ms. These measurements identify a quota-bound profile;
they do not establish the production maximum. Warm throughput includes finite
bursts and must not be extrapolated to sustained capacity. Neither CPU additions
nor additional reserve bots alone raise a single primary token's source quota.

## Operations

Use closed runtime diagnostics to distinguish created messages, edits, webhook
deliveries, mirrors and executions. Antiduplicate telemetry flushes at its
bounded buffer capacity and exposes `telemetry.observations_lost`; loss counts
must accompany comparisons. Use the fixed read-only VPS audit catalog and
strict health smokes, never broad ad hoc queries over retained webhook history.

After a lost executor returns, verify that it joins the reserve, the current
healthy executor stays assigned, and no completed identity is replayed. A
readiness expiry is a final outcome; restored rights after the deadline cannot
revive that original message. Quarantined unknown effects require exact proof
recovery through their existing journal, not a new webhook processing attempt.
