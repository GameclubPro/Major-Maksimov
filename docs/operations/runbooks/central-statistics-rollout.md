# Central statistics rollout

MAXIM owns canonical channel/chat statistics. EXCHANGE sends its own observations
through the authenticated internal API; it retains its independent product store.
No integration settings, provider labels or confirmation screens are exposed.
This procedure never deletes MAXIM history, publishes messages or grants access.

## Installation order

1. Complete both repositories' required checks. Install Market's root-owned
   statistics admission hook with its initial floor41 **before** updating MAXIM's
   shared deploy lock helper. Preserve the fixed deployment lock and its inode.
2. Release the exact green MAXIM main SHA normally, with central statistics still
   disabled. Both central migrations are additive. The exact-view migration adds
   nullable BIGINT shadow counters with no table rewrite or historical backfill;
   its mandatory reader floor applies to both API rollback paths.
3. Release Market's additive migration42 in LEGACY mode using its own guarded
   immutable release procedure. Preserve its original database and volumes.
4. Read the single persistent `statistics_store_control.producer_epoch` from that
   Market database. This nonsecret UUID identifies the producer installation;
   never generate a replacement for a retry. Follow Market's central cutover
   runbook for the bounded read and its source/DB identity checks.
5. Activate MAXIM through a second **normal exact-green-SHA deploy**:

   ```sh
   MAXIM_STATISTICS_CENTRAL_EPOCH="$MARKET_STATISTICS_PRODUCER_EPOCH" \
     ./infra/scripts/vps-connect.sh deploy main --auto
   ```

   The caller-only UUID is captured before `.env.vps` loading. It selects the
   complete shared API component even if the target SHA is unchanged. Under the
   existing deployment lock and stopped-producer/consumer queue fence, the helper
   atomically patches exactly `STATISTICS_CENTRAL_ENABLED=true`,
   `STATISTICS_CENTRAL_MODE=CENTRAL` and `STATISTICS_CENTRAL_EXCHANGE_EPOCH` in the
   canonical dotenv. It preserves unrelated bytes, permissions and credentials.
   A conflicting persisted epoch is refused before runtime transition and again
   before replacement. All fourteen Compose and running container environments
   must match before the queue fence is released. Native auxiliaries receive none
   of these keys. No manual dotenv edits or partial role restarts are required.

6. Run Market's separately reviewed cutover release with a stable cutover UUID.
   Its authenticated preflight requires enabled CENTRAL status, all capabilities,
   retired legacy history and the exact persistent producer epoch. Only Market's
   explicitly approved test history/cache is cleared; MAXIM facts remain intact.
7. Provision the bounded metadata audit with the matching released tooling, then
   verify natural authorized ingest/read and public/frontend identities. See the
   [central audit](central-statistics-audit.md). Actual MAX devices and natural
   24/48-hour observations need independent evidence.

## HTTP action registration

The public internal API uses literal action colons, including `authorities:batch`
and `authorities:resolve`. Fastify interprets an unescaped colon as a route
parameter. The existing statistics `onRoute` hook escapes only the four exact
contract action paths at registration, after selecting their original 128 KiB
authority-batch or 64 KiB other-request limit. Preserve the single-colon wire
URLs, authenticated controller and installed lifecycle source checks.
The real Nest/Fastify bootstrap and injection regressions are in
`apps/api/src/statistics/stats-controller-http.spec.ts`; copied route fixtures
alone cannot prove that the production controller starts. See the
[registration incident](../incidents/2026-10-30-statistics-route-registration.md).

## Failure handling

The change relay publishes at most 500 committed source rows per transaction in
`created_at,id` order. It acquires its advisory lock in a separate first SQL
statement: the subsequent candidate and head reads must see commits completed
while it waited. Do not combine lock acquisition and those reads into one CTE.
One parameterized batch UPDATE assigns exact BIGINT sequence values and the same
transaction timestamp. A full batch uses four publication SQL commands instead
of 503; transaction control and the separate retention statements are excluded.
The candidate read also returns tuple addresses under its row locks. A materialized
assignment list matches both UUID and tuple address, with a scalar address array
for direct TID probes. A VALUES join or UUID IN condition alone can make PostgreSQL
scan retained history. Tuple addresses belong only to that transaction; never persist,
cache or reuse them after its locks are released. Concurrent row updates/deletes and
table rewrites wait for those locks.
The five-second transaction timeout, skipped row locks, cursor semantics and
retention cadence stay unchanged. This reduces database round trips, with one
tuple update per source row. Native regression coverage is in
`apps/api/src/statistics/stats-changes-relay-postgres.spec.ts` and
`apps/api/src/statistics/stats-central-postgres.spec.ts`; retained-history plans
must cover candidate, head and UPDATE target work.

An absent activation variable performs no dotenv or runtime change. `--plan`
never persists activation. A repeated activation with the same epoch is safe;
it must still use current exact-SHA green CI and the normal release fence.
Neither disabling a flag nor a failed rollout permits an old reader or resets the
producer identity. Preserve installed compatibility floors and recovery journals.

An authority keeps its issuer, actor, entity, role, purpose and consumer identity.
Its bot reference may change only with a strictly newer issuer revision, for
example when Market changes from its own bot proof to a current MAXIM binding.
That transition advances the authority epoch and invalidates old read/write
references. Equal-revision changes fail; older revisions cannot replace the
current proof. Native regressions in `stats-central-postgres.spec.ts` cover both
roles, revocation/recovery, return to the original bot and stale references.
Do not recreate stores, lower floors or re-enable retired history exchange.

Authority lifecycle v2 preserves a revoked predecessor when a new exact-scope
authority replaces it. The issuer must supply its exact ID, revision and epoch;
an expired lease alone is not a revocation. A superseded ID is permanently
revoked, including after a later higher-revision attestation. Resolution of the
current scope head is authenticated metadata only and never grants access.

The additive migration `20261029193000_statistics_authority_successors` installs
nullable successor fields and the permanent database tombstone fence. The separate
`20261029193100_index_statistics_authority_heads` builds the partial unique index
concurrently while the old constraint still protects the scope. Only
`20261029193130_index_statistics_current_consumers` separately builds the bounded
entity/id change-feed seek index. `20261029193200_enable_statistics_authority_successors`
then removes the legacy constraint. The feed reads current consumers through
keyset pages and terminal predecessors through an exact primary-key lookup;
retained chains must not become a whole-authority scan.
Use the existing migration recovery procedure if a phase fails; never drop an
invalid index, change a migration receipt or retry schema operations manually.

After this release, normal API deploys and both API rollback paths require
`maxim_topology_require_statistics_authority_lifecycle` on the exact candidate
source. It checks the lifecycle-v2 contract, successor readers/writers and all
three migrations, independently of feature flags or whether any rows have yet
been replaced. The normal deploy verifies candidate controller compatibility
before Git checkout/re-exec; the rollback bootstrap retains the new floor along
with all earlier floors. Static-only immutable rollback retains its offline
path. The existing applied-migration check remains an independent gate. Keep a
compatible API image for recovery; neither restoring an older authority table
nor running a pre-v2 writer is a rollback option.

Native source identity binds the durable access edge's creation, current roles
and bot membership lifecycle, never the timestamp of an unchanged successful
rights check. Current exact actor/bot grants and explicit denial/removal are
still checked on each read. A routine `checked_at` refresh previously hid native
history until the next peer attestation and churned authority epochs, producing
intermittent `NO_DATA` and `READ_RESTART` despite active consumer leases.
The PostgreSQL regression reproduces that loss and covers rechecks before/during
a read, stable renewal epochs, real role denial, lifecycle changes and bot denial.
Existing source fences change once at rollout; allow their normal renewal before
acceptance. Verify repeated audience availability as well as active leases and
successful summary envelopes. No migration, permission mutation or data purge
is needed for this correction.

## Connection access after activation

Central mode still uses the paged membership/access contract for Market-owned
consumer registration. Statistics may reuse the original exact actor/entity/bot/profile
MAX proof for up to 24 hours. Stored `checked_at` remains the MAX observation time;
each successful local access evaluation returns a new peer lease of at most five minutes,
capped by the original proof's 24-hour expiry. Known membership changes, bot lifecycle
changes, negative access evidence and explicit statistics revocation invalidate the cache
immediately. This policy does not extend public profile, publication or moderation authority.

Access reads nominate only missing or nearly expired proofs (within five minutes of expiry).
There is no central fleet-wide binding refresh or missing-binding scan. Active paged exchange
is demand; an idle roster performs no MAX access requests. Initial connection and expired
demand use the existing exact checks. Requests never wait for MAX: unavailable statistics
remain unavailable until their background check succeeds.

The shared Redis mailbox coalesces exact grant revision/entity requests, holds at most 128
outstanding requests including retries, and expires each after five minutes without renewal
by duplicate reads. One serial action-role lane claims at most four per visit, retaining a
minute retry backoff and the existing background MAX governor. Full or unavailable admission
is best effort; a later statistics read can retry. Redis command waits are capped at 100 ms,
with no offline or local application wait queue. Stale grant revisions cannot restore removed
access. Publisher handoff retains its exact identity and background admission.

Archive pulls, reverse-import access and legacy history remain retired in central mode.
Snapshot metadata cleanup remains active. Neither cache reads nor renewal advance
measurement/import-success timestamps. Legacy mode retains its existing five-minute policy.
Its access batch claims one due binding immediately before its sequential check, up to twenty
attempts or ten seconds per visit. It must neither spend twelve shared bot slots on four parallel
checks nor postpone unstarted rows when a previous check exhausts the time budget, fails or
shutdown begins. Native regressions cover those interruptions and independent progress of one
hundred actors.

After both peers have compatible v3 readers, use the guarded v3 rollout flags for
accounts above 100 platforms. Keep the v2 limit unchanged, and verify the complete
paged roster plus fresh MAXIM-only consumer leases after activation. Snapshot
metadata expiry remains active. Native regressions live in
`statistics-exchange-postgres.spec.ts` and
`statistics-exchange-v3-membership-postgres.spec.ts`.

Focused checks: `statistics-authority-rollback.test.mjs`,
`statistics-central-rollout-state.test.mjs`, existing
`statistics-exchange-rollout-state.test.mjs`, Market admission/cutover PostgreSQL
tests and the exact statistics rollback tests. Report local, exact-SHA CI, released,
public acceptance and MAX-device evidence separately.
