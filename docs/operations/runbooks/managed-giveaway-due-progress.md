# Managed giveaway due progress

The runner must reach independent eligible giveaways beyond a prefix of locked,
access-blocked, deferred or backed-off work. Candidate inspection does not prove a
draw, notification, successful action or completion.

## Selection and authority

Four separately indexed families cover scheduled starts, scheduled ends, active
ends and drawing ends. Scheduled rows with no start time remain discoverable by
their end time. Each raw query selects scalar metadata with an ordered
`(due_at, id)` seek before lock, access and Redis checks. The two scheduled families
overlap; an ID is invoked at most once per pass.

Normal passes materialize at most 80 rows in pages of at most 20 and invoke at most
20 processors. Slow passes halve these budgets. Empty families relinquish their
unused budget; at most seven page queries run in one pass. Every nonpaused pass
rotates its first family, even when a prior pass stopped at the invocation limit.
Pause starts no selection and advances no cursor.

Each family retains a fixed cutoff and the last inspected tuple until exhaustion.
Only the inspected prefix advances: a suffix left by a budget stop remains for the
next pass. A fully inspected short or empty page wraps that family for a later
pass, never the same pass. Deleted anchors do not invalidate saved tuple values.
SQL or batch-access failure advances no rows. A row checkpoint precedes its
fallible individual probes; an exception grants no success and the row returns
after wrap. Preserve the existing Redis failure policy.

Cursors are process-local scheduling hints. Restart resets them; the current
reload, activation/draw CAS, send locks, outbox, deadlines and final dispatch
authorization remain authoritative. A denied or removed bot does not block a
source that another confirmed ACTIVE admin/owner bot can serve. Never clear
defer/backoff keys, access denials or ambiguous effects to accelerate traversal.

Finite progress assumes a finite stable population, continuing nonpaused passes
and completing probes. New or changed rows behind the cursor, including due times
after its cutoff, wait for a later sweep. There is no fixed 15-second service SLA;
the runner retains an unfinished invocation across timer ticks.

## Index release and validation

The additive `managed_giveaways_status_starts_at_id_idx` and
`managed_giveaways_status_ends_at_id_idx` indexes retain the old indexes. Their two
immutable migrations each run one `CREATE INDEX CONCURRENTLY`, outside a
transaction, with a five-second lock limit, 90-second statement limit, 64 MiB
maintenance memory, no parallel maintenance workers and a 512 MiB temporary-file
limit. A failed build retains its genuine failed receipt and possible invalid
index; inspect exact state before any recovery. Never use `IF NOT EXISTS`, blind
resolve, drop or replay to manufacture success.

Routine migrations execute after webhook quiescence. Concurrent DDL does not move
these builds before the release fence. Before release, review bounded production
size evidence and populated local build timings against the acceptable pause.
Existing online preparation allowlists do not admit these unrelated indexes.

`managed-giveaway-due-postgres.spec.ts` exercises real PostgreSQL/Redis nomination
and the actual helper SQL on retained history, ties, locked heads and cursor
boundaries. Local analyzed plans must show ordered indexed tuple seeks with bounded
rows/buffers and no retained-history sort; never run production `EXPLAIN ANALYZE`.
`managed-giveaway-due-migration-postgres.spec.ts` uses official Prisma receipts,
concurrent writers and retained cancellation evidence. Its default fixture has
100,000 rows. The explicit local-only test profile
`MAXIM_TEST_GIVEAWAY_MIGRATION_SCALE=large` starts at 1.5 million compact rows,
permits at most two million, and requires measured total storage of at least
898,768,896 bytes with substantial heap data. This conservative size bound is a
fixture acceptance condition, not a measured production row count or build time.
