# Bounded webhook shard lookup and online index

This release preserves the routing contract: unfinished same-chat work counts across bot
identities, and the oldest valid default shard wins by `(created_at, id)`. Unknown, legacy and
NULL queue names count as pending but cannot select a default shard. The current event is
excluded. Status, retry, timeout-quarantine and message-type predicates remain unchanged.

The query uses one PostgreSQL statement and snapshot. It first finds the oldest pending row
for the chat. No row means no pending work; a head with a current default queue supplies the
shard immediately. When the oldest row has an unrecognized or NULL queue, the second lookup
uses the same ordered-chat head index to read the rest of that chat in order and stops at the
first current default queue. If none exists, it returns no shard without changing the pending
result. This is one scan of the remaining chat, rather than one scan per default queue. There is
no fixed row cap: a long prefix with unrecognized queues may require reading that entire prefix.
Dead tuples, MVCC visibility and physical I/O are not bounded by LIMIT. Validate custom and
named generic plans with and without the optional index, using retained history and skewed chats.

The optional partial nonunique B-tree is `webhook_events_chat_queue_head_idx` on the existing
chat COALESCE expression, `queue_name`, `created_at`, `id`. Its predicate matches the existing
ordered-chat head index, which remains required for deferral.

## Fixed migration and release order

Migration: `20261118120000_index_webhook_chat_queue_head`.
SHA-256: `c978fd08b956288ee7fe57008a148b775cfcd418fdbfa1238caef7746dc514a7`.
It performs one CREATE INDEX CONCURRENTLY, with no IF NOT EXISTS, destructive changes or
edits to older migrations. The fixed image runner exposes no SQL, target or selector argument.
The immutable release rollback can keep this additive index when it is the sole applied
migration missing from the previous source. It must verify the exact index and successful
receipt from the current controller under the deploy lock before any runtime change. All
existing execution and effect reader checks remain required. The ref-based API rollback
continues to refuse a source missing an applied migration.

The exact-green-SHA deploy uses `routing-index-online-state.mjs release-state <full SHA>` with
the reviewed Compose selectors under the shared protected lock. It may defer the index only if
the target source declares compatibility, the existing ordered-chat index matches exactly, and
the sole pending migration is the pinned optional index. The new index, its receipt and any
build or repair artifacts must all be absent. In this state the deploy skips the index
supervisor and the ordinary Prisma runner, which would otherwise apply the pending index.
The state must still match before queue pause and again before replacing API roles. Other
migrations may not be skipped. The two pinned managed giveaway migrations are a fixed
prerequisite for this state. With the exact ordered-chat index and an absent optional index,
a compatible release may run just those additive migrations from its verified image before
creating the runtime transition journal. Prisma records both unchanged source checksums. If
either receipt is missing, invalid or out of order after the attempt, rollout stops. A verified
readback must show that only the routing index remains pending before the regular fence. The
routing index itself still uses its original limits and supervisor.

The exact release ending at `20261120012500_add_publisher_post_import_inputs` may use a
second fixed deferral. Its sole additional migration has SHA-256
`190f2ae80de68275057346bd98884791d108867e1359c76e44138ca63961d120`.
It adds four columns to the existing Publisher session table with a five-second DDL lock
timeout. Catalog inspection requires the columns to be absent before Prisma records the
migration, then verifies their types, nullability and defaults after commit. The verified
image can apply the two preceding giveaway migrations first if they are still pending.
The successful ordered prefix and both modules' catalogs must match before the release can
continue. Partial objects, failed receipts and an unknown migration tail stop this deferral.
The release ending at `20261121000100_index_spammer_projection_due` adds a third fixed
deferral. It requires the preceding Publisher and giveaway receipts. The verified API image
may apply the nullable `spammer_observations.projection_due_at` column and its concurrent
partial index under the deploy lock while the previous roles serve traffic. The controller
calls `preflight-spammer` to check capacity for the exact release SHA. After image verification
it confirms deploy authority and calls `prepare-spammer`. The supervisor watches the migration
attempt. The projection table, including TOAST, has a 3 GiB admission ceiling. The migration
session caps locks at 5 seconds, statements at 45 seconds and temporary files at 256 MiB.
A fresh PostgreSQL catalog and receipt
read must return `compatible_pending` before the runtime journal opens. Failed or partial
preparation stops the release there. The controller repeats the read before queue pause and
role replacement. The general Prisma runner stays skipped while the routing index is deferred.
A later release containing another migration returns to the normal routing-index admission.

Both API rollback paths refuse a source that cannot read the applied migrations or requires a
missing index. A verified compatible target also skips the ref-based rollback's Prisma runner.
Recovery finalization verifies the API component source against the live state before recording it.

When the index cannot be deferred and still needs preparation, the exact-green-SHA deploy runs
the capacity checks and supervises the build after verifying the immutable API image, while the
old roles and current manifest remain live. A refused or interrupted build cannot advance the
runtime transition journal. The fenced rollout starts only after exact catalog and receipt
verification. For an already applied index, ordinary Prisma processing remains in place.

The reader uses one bounded repeatable-read catalog/receipt snapshot. It attests PostgreSQL 16,
public persistent nonpartitioned B-tree layout, all four expressions/keys, predicate, opclasses,
collations, options, no INCLUDE keys, and valid/ready/live flags. Genuine successful immutable
Prisma prerequisites are required. Duplicate active, unfinished, foreign and checksum-drifted
receipts, competing builders and repair artifacts block the stage. Known historical rolled-back
prerequisite attempts do not replace their required successful receipts; unknown rolled-back
names/checksums and any rolled-back routing target block normal preparation. For the four
verified failed predecessor versions (spammer review, broadcast locking, suggestion delivery and
publication revision), one unfinished zero-step rollback receipt is accepted only alongside the
later successful one-step attempt of the same migration with the exact pinned current source
checksum. Neither version's receipt is modified. A successful
routing receipt must contain the one step recorded by a genuine Prisma deploy; any receipt for
the superseded proposal `20261103120000_index_webhook_chat_queue_head` blocks preparation even if
it was rolled back. The four existing
historical receipt variants retain their exact source/successor/catalog compatibility checks.
No receipt is fabricated or edited by the adapter.

## Admission and limits

| Bound                                             | Fixed value   |
| ------------------------------------------------- | ------------- |
| Initial table scope, including TOAST              | 160 GiB       |
| DDL statement / lock timeout                      | 2700 s / 5 s  |
| Maintenance memory / parallel maintenance workers | 256 MiB / 0   |
| Per-session temporary-file limit                  | 8 GiB         |
| Whole supervised attempt / cleanup reserve        | 3000 s / 60 s |
| Healthy admission before starting                 | 120 s         |
| Free-space floor on every observed device         | 10 GiB        |

Build admission reserves an index estimate equal to at least the retained table bytes or
256 bytes per estimated row, an 8 GiB temporary allowance and WAL allowance of at least twice
the index estimate. Aggregate roles on shared devices above one floor. These are conservative
admission estimates, not proven worst-case index/temp/WAL bounds; max_wal_size is not a WAL cap.
The local synthetic benchmark proves the concurrent mechanism and writer progress on its own
small dataset, not duration or I/O impact on production history. Fresh production catalog sizes,
filesystem identity and available capacity remain required at admission. Account for nested
cold/root filesystems; do not add their free space as independent storage.

The fixed routing path accepts only the public schema and supported pool, timeout and TLS
parameters in DATABASE_URL. It rejects query overrides of the database endpoint, startup
options and PGOPTIONS. Nondefault data/temp tablespaces are refused.
The supervisor samples storage about every 2 seconds and runtime about every 10 seconds.
Missing/stale samples or device drift abort; it preserves the 10 GiB floor throughout sampling.
Admission and completion require ready ingress/admin and lag at most 10 s. Lag above 120 s
immediately, or above 30 s continuously for 90 s, aborts only the owned build. PostgreSQL does
the maintenance: bounding the client container does not bound database CPU/I/O.

Exact completed index and receipt permit later releases to skip one-time build-size admission;
table growth after successful preparation does not force another build. Ordinary deploy never
rebuilds the completed index just to clear lag or repeat acceptance.

## Failure and acceptance

Stop release progression on any refusal. Preserve source/checksum, image, UUID attempt,
last successful samples, child exit, failed receipts, partial indexes and the previous manifest.
Cleanup targets only the created UUID container and its matching PostgreSQL sessions. Prove
cleanup; absence of output is not absence of an owned process. Foreign sessions, live API roles,
queues and sibling services are outside cleanup. Unknown cleanup blocks release.

No automatic retry, DROP, REINDEX, migrate resolve or receipt mutation is permitted. A failed
concurrent build may retain an invalid index and failed receipt. Inspect the fixed read-only
`routing-index-online-state.mjs assert` with the full original Compose selectors, then review a
concrete recovery separately; a blocked assertion does not authorize repair or replay.

Use focused API/native and infrastructure tests before the final aggregate. Native coverage
includes old/new query equivalence, null/invalid queue prefixes, current-ID exclusion, timestamp
ties, aliases, retry/quarantine branches, shared snapshots and actual custom/generic plans.
Controller tests cover genuine Prisma receipts, catalog drift and interruption/refusal. The API
Docker lane exercises the packaged fixed runner, genuine prerequisites, exact receipt and minimal
client isolation. Store-dependent skips do not establish native coverage.

Require exact-SHA Required and Analyze JavaScript and TypeScript before deploy. Then verify all
14 API roles, both native auxiliaries, strict smokes and immutable component manifest. Evaluate
fresh closed all-status receipt cohorts and separate action outcomes. A short healthy sample
confirms its observed scope, not every bot feature or sustained peak throughput. Do not send
production diagnostics to user groups or clear queues, fences or uncertain effects.
