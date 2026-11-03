# Bounded webhook shard lookup and online index

This release preserves the routing contract: unfinished same-chat work counts across bot
identities, and the oldest valid default shard wins by `(created_at, id)`. Unknown, legacy and
NULL queue names count as pending but cannot select a default shard. The current event is
excluded. Status, retry, timeout-quarantine and message-type predicates remain unchanged.

The query uses one PostgreSQL statement/snapshot: an indexed EXISTS and one LATERAL oldest-row
lookup per configured default queue, followed by sorting at most those queue heads. The new
partial nonunique B-tree is `webhook_events_chat_queue_head_idx` on the existing chat COALESCE
expression, `queue_name`, `created_at`, `id`. Its predicate matches the existing ordered-chat
head index, which remains installed. Dead tuples, MVCC visibility and physical I/O are not
strictly bounded by LIMIT. Local custom and named generic plans must establish actual probe
work on retained history and skewed hot chats.

Each LATERAL lookup uses inclusive bounds for the exact `(chat, queue_name)` pair and orders
by that pair followed by `(created_at, id)`. Equality filters alone can let PostgreSQL choose
the old chat index and filter the entire pending chat once per queue. The local regression
rebuilds a deliberately sparse index inside a rolled-back disposable-store transaction; this
is a planner fixture, not production maintenance. Validate custom and generic plans after
preceding native suites as well as on fresh stores, since index size and statistics affect plans.

## Fixed migration and release order

Migration: `20261103120000_index_webhook_chat_queue_head`.
SHA-256: `c978fd08b956288ee7fe57008a148b775cfcd418fdbfa1238caef7746dc514a7`.
It performs one CREATE INDEX CONCURRENTLY, with no IF NOT EXISTS, destructive changes or
edits to older migrations. The fixed image runner exposes no SQL, target or selector argument.
Application rollback retains the additive index and all existing execution/effect readers.

The normal exact-green-SHA deploy holds the shared protected lock and performs read-only
preflight before building. After immutable API-image verification, it supervises this build
while the old roles and current release manifest remain live, before the first runtime
transition journal or queue pause. A refused or interrupted build cannot advance that journal.
Only after exact catalog and receipt verification does the ordinary fenced rollout continue.
The post-migration assertion repeats before role replacement.

The reader uses one bounded repeatable-read catalog/receipt snapshot. It attests PostgreSQL 16,
public persistent nonpartitioned B-tree layout, all four expressions/keys, predicate, opclasses,
collations, options, no INCLUDE keys, and valid/ready/live flags. Genuine successful immutable
Prisma prerequisites are required. Duplicate active, unfinished, foreign and checksum-drifted
receipts, competing builders and repair artifacts block the stage. Known historical rolled-back
prerequisite attempts do not replace their required successful receipts; unknown rolled-back
names/checksums and any rolled-back routing target block normal preparation. The four existing
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

The fixed routing path rejects DATABASE_URL options and PGOPTIONS which could redirect DDL
or temporary files outside the inspected layout. Nondefault data/temp tablespaces are refused.
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
