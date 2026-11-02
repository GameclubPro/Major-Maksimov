# Independent Lastik rollout

Lastik (`eraser`) is a separate image, webhook receiver and worker. Its PostgreSQL,
Redis, queue, policies, compact deletion journals and history cursors belong only to
Lastik. It is not a fifteenth shared API role. Moderation only changes authenticated
settings and delivers protected publication references.

## Prerequisites and bootstrap

Require exact-SHA `Required` and `Analyze JavaScript and TypeScript` success. Inspect
live REG.RU headroom before provisioning: the initial budgets are 1 CPU/512 MiB for
Lastik, 1 CPU/1 GiB and 256 MiB shared memory for its PostgreSQL, and 0.5 CPU/256 MiB
for Redis. These limits do not authorize changing sibling projects or increasing MAX
quotas. Preserve the 10 GiB API rollout disk floor when API changes are included.

The new storage roots are `/mnt/maxim-cold/runtime/eraser/postgres` and
`/mnt/maxim-cold/runtime/eraser/redis`. Bootstrap refuses a missing cold mount. It starts
only these new stores; routine application deployments never recreate them. Lastik's
stores require their own independently replicated backup and restore acceptance before
treating persistent recovery as verified; the shared RAID is not an independent backup.

After synchronizing exact green tooling with the normal `deploy main --plan`, prepare
an owned private `0600` JSON file outside Git containing `sourceSha`, `botId` and
`botToken`. The SHA must match that checkout. Pass its path without exposing contents:

```sh
./infra/scripts/vps-connect.sh eraser-bootstrap /absolute/private/lastik-request.json
```

Bootstrap writes `/var/lib/maxim-secrets/eraser.env` and
`/var/lib/maxim-secrets/eraser-postgres-password`. Only Lastik receives its bot token.
The permanent `/var/lib/maxim-deploy/eraser-reader-version` floor is installed before
any takeover can be enabled; neither disabling availability nor removing a credential
permits an older API reader. The canonical `.env` receives only `ERASER_ENABLED=true`, the internal control URL and
its separate authentication key. Existing chat periods remain available for import;
Lastik policies default off until the human administrator explicitly enables them.
A connection request is a separate explicit administrator action. It retains the selected
period (24 hours, 48 hours or 1 week) while deletion remains disabled, and expires
after its one-hour connection window. Lastik checks its own rights and activates the exact
pending request independently of moderator availability. Ordinary settings writes cancel
the previous pending request; expiry, cancellation and lost responses never imply activation.

The additional permanent `/var/lib/maxim-deploy/eraser-connection-request-version` floor is
`1`. Bootstrap and the normal locked application deploy install and synchronize it before
new API/Lastik writers or `0003-connection-requests.sql` can run. The original ownership
floor stays `1`; neither marker may be removed or lowered when availability is disabled,
the queue is empty, or all connection requests have expired. Unknown, partial or unsafe
marker files fail closed. Both API rollback paths retain the connection-aware contracts,
operation canonicalization and controller tooling. An Eraser-only immutable rollback also
requires the exact target's pending-request, expiry and cancellation reader before startup.
Static-only immutable rollback retains its component scope. Ref synchronization and
rollback tooling bootstrap must preserve this floor before replacing the checkout.
A separate permanent `/var/lib/maxim-deploy/eraser-rate-limit-reader-version` floor is
`1`. A selected Lastik deploy installs it before `0005-durable-rate-limit.sql` and
application startup. Both the worker and webhook-registration client read the exact
bot's PostgreSQL cooldown before MAX admission. An immutable Lastik rollback requires
that reader; API/static image-only rollback retains its scope, while checkout replacement
must preserve the enforcing tooling. Disabling availability never lowers this floor.
A partial installation preserves files and fails closed. `eraser-bootstrap --stores-only`
may finish an interrupted store startup with those same secrets; it does not rotate them.
Credential rotation needs a separately reviewed procedure.

## Deploy and connect

```sh
./infra/scripts/vps-connect.sh deploy main --auto
```

The planner selects the independent `eraser` component. It builds/reuses immutable
`maxim-eraser:<full-sha>`, verifies secret/storage readiness, runs its additive migrations,
recreates only the application, and checks `/health` against the exact component SHA and
both own stores. The ordinary release manifest records the image ID/source SHA. Before
bootstrap, legacy three-component manifests remain valid. Once installed, inherited
Lastik image identity is checked on later partial deployments.

Nginx and subscription tooling may advance without rebuilding Lastik. Both operations
check the installed Lastik source against its component in the complete active release
manifest under the protected deploy lock.

Add Lastik through its patch-only nginx command after synchronizing the exact green
tooling SHA. It inserts only the owned upstream and `/eraser` routes into the current
canonical site; existing host-managed includes, headers, request limits, buffering and
sibling routes retain their exact bytes. Only `POST /eraser/webhook` reaches Lastik on
loopback port 3005. Then register and read back the bot's HTTPS subscription:

```sh
./infra/scripts/vps-connect.sh eraser-nginx
./infra/scripts/vps-connect.sh eraser-nginx --apply
./infra/scripts/vps-connect.sh eraser-webhook
```

Review the preview diff before application. Unknown anchors, conflicting or partially
modified Lastik blocks fail closed; exact installed blocks are idempotent. The fixed
canonical file is `/etc/nginx/sites-available/major-maksimov.ru.conf`, selected by the
unchanged `/etc/nginx/sites-enabled/major-maksimov.ru.conf` symlink. Backups stay under
`/etc/nginx/backups`. The shared protected deploy lock covers live identity checks,
atomic replacement, `nginx -t`, reload and localhost/SNI checks: a wrong-secret POST
must return Lastik's 403, and internal paths must return 404. These probes send no MAX
messages. Reload readiness allows five complete namespace checks with one-second pauses;
each retry rechecks installed bytes and the enabled link. Failed observations retain
bounded private evidence and report the path, assertion, HTTP status and transport exit.
Rollback restores only the invocation's own installed bytes; observed external
changes refuse rollback and preserve its backup and private evidence directory. The
full-site setter remains available for separately reviewed whole-site changes and is
not the Lastik installation path.

This operation sends no chat messages. Add Lastik to a designated group with read-all
and delete/write administrator privileges. The moderator settings retain the switch
and the 24-hour, 48-hour, or 168-hour period. Activation requires the exact Lastik
rights, synchronized protection references, and the persisted legacy ownership fence.
Never bypass a pending old uncertain deletion or send work back to a moderator.

Cold source recovery installers capture the independent control URL and authentication
key from the stopped generation into their existing private environment. Before the
source database commit they require durable Lastik exact-message holds; legacy recovery
also installs global author holds. A shared database fence prevents an earlier final
deletion decision from escaping this check. An unavailable service or matching
dispatching/uncertain journal refuses installation. Additive holds survive that refusal:
reconcile the exact journal before continuing, without deleting holds or blindly
repeating an uncertain operation. The Lastik bot token never enters these clients.

## Reading diagnostics without changing execution

Saved chat ownership selects the diagnostic source even when availability is disabled.
An unavailable owned source is reported separately; it never becomes a legacy snapshot,
zero counters or an empty review. Settings reads use the saved policy and bootstrap only
an explicitly uninitialized policy. Read availability does not authorize execution or writes.

The closed fleet page contains at most 50 chat identities, including unavailable sources.
Review pages contain at most 20 records and carry an opaque continuation tied to the
source, chat, policy revision and activation. Keep the cursor unchanged. A changed identity
requires a fresh page; a manual retry still uses the exact journal timestamp and attempt
count, and its returned snapshot starts at the first page. Missing completeness metadata
from an older runtime means unknown completeness, not an empty or fully checked ledger.
Mixed pages preserve that unknown state when legacy diagnostics are complete. A known
incomplete diagnostic or unavailable source takes precedence; explicit completeness requires
every selected source to report complete diagnostics. Pagination alone does not mean incomplete.

Pending, due-and-retry-ready, and uncertain counts are separate bounded observations.
A capped count is a lower bound. Eligibility does not bypass the final rights, pins or
protection checks. Fresh dispatches are in progress; dispatches whose persisted confirmation
deadline has expired join uncertain journals. `oldestUnknownAt` is the earliest currently
recorded uncertainty time (expired dispatch deadline or uncertain journal update), not
message creation or original dispatch time. Old automatic polling may have refreshed
historic timestamps, so this age can understate the original uncertainty. Unknown DELETE
results receive no automatic recheck or retry. Protected history and incomplete coverage
are reported independently of a known execution stop. `lastCompletedAt` records the last
completed safety scan; a gap prevents treating that timestamp as current full coverage.

The public “Больше нет в чате” counter remains the combined confirmed total. Closed
`confirmationCounts` splits it by the first recorded confirmation: positive DELETE reply,
authenticated removal notification, or the historical total without a known source.
A removal notification does not identify an external actor. A later acknowledgement or
notification cannot count the same message again. Process HTTP metrics have a separate
scope and start timestamp: actual successful DELETE replies may overlap notification-first
confirmations and must not be added to the public total. HTTP 2xx alone is not a valid
DELETE acknowledgement. Network HTTP 429, local cooldown deferrals, failed admission and
rejected final guards are distinct observations. Durable MAX cooldown and process health
remain separate from these counters; missing old telemetry is unknown, not zero.

The owner panel shows the full connection request lifecycle, including activation,
initiator, policy revision, expiry, next connection attempt and an allowlisted error.
Public connection states remain pending, expired or cancelled; activation is represented
by the saved enabled policy. Neither surface exposes lease tokens or raw upstream errors.

The expanded diagnostics retain the lazy-loaded retention panel and add no browser dependency.
The measured complete Safety Desk build with the historical protection report is
462.2 KiB raw / 129.2 KiB gzip JavaScript; its reviewed feature budget is 464 / 130 KiB.
CSS and budget tolerance remain unchanged.

## Historical protection evidence and legacy retirement

The bridge imports exact `PUBLISH_GIVEAWAY` audit references independently of surviving
giveaway entities. Its `(created_at, id)` cursor handles tied timestamps and advances
only in the same transaction as the protected references and historical bot identities.
Each visit reads at most 500 rows through the action-specific partial index. Audit
completion does not prove a complete catalogue of old results or removed publications.
Missing or malformed references never widen the historical interval.

A separate bounded pass hashes the exact message/hold and bot catalogue, 500 rows at
a time, at one protection revision. A source revision change restarts this pass; a
partial hash cannot certify delivery. The `ownership_capture_v1` certificate binds
the chat, revision, conservative ownership start, current protected watermark, catalogue
digest and reference count with SHA-256. It is evidence from the authenticated control
source, not an independent signature or proof that old audit history was exhaustive.
This source never certifies an interval before the saved ownership start. Older
intervals require another reviewed source of complete evidence; do not manufacture a
certificate from an empty audit page or manually lower a timestamp.

Lastik validates certificate identity and checksum before accepting an earlier historical
floor. Its retained `history_anchor` survives an omitted/null floor, so clearing a field
cannot bypass the evidence requirement on the next update. Initial legacy delivery
can establish the same conservative baseline as before; it is not presented as a
verified certificate. Incomplete catalogue pages and source fences retain their existing
protection. The full MAX timestamp boundary remains a coverage gap, never a reason to
skip a millisecond.

The closed per-chat review shows source and delivered revisions, import phases,
catalogue progress, the source and runtime certificates, and the unproved earlier
history. Missing report data is unavailable. A matching checksum alone is insufficient
for the current-version label when the source revision has advanced. These exact-key
detail queries are outside fleet polling, whose fixed page query budget is unchanged.
The public confirmed-removal counter and retention periods are unchanged.

The legacy retention role discovers transferred chats in primary-key pages and visits
at most five due chats per maintenance pass, bounded to two seconds between transactions.
Each transaction selects at most 100 active candidates through the dedicated partial
index, with a 300 ms lock timeout and 1.5 second statement timeout. It locks intents,
quota, policy and candidates in the existing receipt order. Only an ended activation
with proof of no dispatch can become cancelled; admission credit is released exactly
once. Missing/mismatched journals, independent intents, active leases, ambiguous
statuses and mutation evidence stay intact. Positive receipts enter the existing
database-only reconciliation path. No MAX request or queue removal occurs here.

Retirement progress and its cursor commit with the candidate/quota updates. Lock or
consistency failures roll back the page and defer that chat without blocking independent
chats. `scanComplete` means the bounded pass ended, not that all journals were resolved.
The retained-at-scan count is a historical observation, not a live uncertainty count.
New fields and certificates are additive; existing policy states, ownership fences,
receipt readers and all installed rollback floors remain required.

## Due scheduling and control scans

Migration `0006-due-scheduling.sql` stores future arrivals in hourly rows with a
60-bit minute bitmap, without creating a candidate for every young message. Repeated
arrivals within a minute reuse its bit. A known minute becomes due at its end plus the
selected retention period; this batching adds at most one minute before scheduling,
not a bound on queue or MAX delay. An already-due arrival wakes the chat immediately.
Expired hour rows are compacted in bounded batches into a durable live continuation
under the policy lock before removal. A completed page clears only wholly covered
minutes. Partial minutes and a repeated full 100-message timestamp boundary remain
unresolved; they never authorize skipping a millisecond or declaring coverage complete.

Ordinary scheduling takes the nearest candidate deadline, known future minute or
unfinished eligible scan. Candidate eligibility is the later of the current policy's
age threshold and the existing `next_attempt_at` retry/pin deadline. Indexed selection
for each supported period takes at most five candidates per visit, preferring live
work to history. Changing the period does not turn a retry deadline into an age wait
or make an uncertain DELETE eligible. Young, never-issued candidates can return to
compact ranges when their retained deadline permits it. Page completion and visit
completion recheck durable state under the same policy lock used by ingress; an old
visit cannot overwrite a newer webhook wakeup.

Known due work and control scans have independent durable windows and cursors. A new
due message cannot convert an unfinished control scan to the ordinary request budget,
and completing its narrower window cannot certify the broader coverage. A late receipt
inside an open control window invalidates that window's older page; a receipt outside
it preserves the cursor. An ambiguous full control-page boundary retains its gap and
requests another control attempt after six hours, within the same shared budget.

The shared cleanup queue has 64 fixed slots: 62 for ordinary due work and two for
control scans, with the existing global concurrency of eight workers. Control scans
visit only the live window. Their rights and page requests share one aggregate HTTP
request/second across replicas and also consume the total MAX request budget. Scan
continuations keep that purpose; eligible deletions discovered by a control scan use
the ordinary budget and the same final guards. Rights evidence may be reused within
a visit, retaining its original request-start timestamp and 30-second lifetime; pin
evidence still expires after five seconds. Short admission waits remain within a
visit, while a long cooldown releases the worker and preserves a durable retry time.

Completed empty control windows request the next control scan after 15, 30, 60, 120,
240 and then 360 minutes; a nonempty completion resets the desired interval to
15 minutes. These are desired intervals, not coverage guarantees. With 20,000 empty
chats, one rights read plus one page per chat already requires at least 40,000 seconds
(11 hours 6 minutes 40 seconds) at one request/second. Extra pages, retries and other
delays extend that time. The durable `last_live_completed_at` records actual completed
control windows; a missing timestamp means no recorded completion. Ordinary due work,
partial pages and blocked windows do not refresh it. Diagnostics expose it as
`coverage.lastCompletedAt`, with a separate `coverage.gap` flag. Retained gaps outside
a completed window remain separate from its completion time; the timestamp alone
cannot prove current full coverage.

## Acceptance and rollback

Verify availability, deletion and protected exceptions separately using only uniquely
marked agent-created messages in the authorized test group. Keep the production release
SHA/image ID, completed checks and any missing coverage distinct. Do not age or delete
pre-existing messages for a live test. A 100-million-message backlog is a gradual job:
the initial 20 total HTTP requests/second also pays for reads/checks/retries, and each
chat has at most one Lastik deletion/second.

MAX documents an exact-message `404` as either missing or inaccessible. Neither
`not.found` nor `message.not.found` certifies absence. Only a positive DELETE
acknowledgement or an authenticated `message_removed` receipt settles deletion.
Keep uncertain journals across restarts without replaying the DELETE. They cause no
automatic presence reads or scheduled retries; independent eligible messages continue
through fresh rights, pin and policy checks. A diagnostic read cannot settle an unknown
effect. Authentication failures and rate limits stop the current visit.
An issued attempt settles only its exact dispatch ID. Stale pending decisions cannot
reopen, protect or confirm an issued journal; a rejected 429 permits a fresh guarded
attempt only after its deadline. Any failed DELETE ends that visit after recording its
outcome, preventing a cascade of uncertain effects. Final dispatch checks the database
clock after lock waits, and removal ingestion uses the same policy-before-candidate
lock order as dispatch and settlement.

A received 429 stays a known rejection even when Redis cooldown persistence fails.
Its token-wide deadline is also stored in PostgreSQL and survives client restart; failed
durable admission stops new requests. The 200-candidate cap applies to new pending
intake, separately from issued, uncertain and review journals. A late exact rejected
attempt keeps its retry even if it temporarily fills an extra pending slot; further
intake waits for space. A known rejection arriving after its visit restores its own
retry wakeup. Shortening a period recomputes age eligibility while preserving pin,
rate-limit and unknown-effect waits; new age deferrals never replace those deadlines.
An authenticated removal receipt that frees pending capacity recomputes the schedule
so already-due work can resume. Operator retry accepts only the exact never-issued
review intent under its current policy revision and activation, and saves its wakeup
in the same transaction. Preserve the review response's complete timestamp when
submitting that request; truncating its PostgreSQL microseconds fails the identity check.

Startup keeps authenticated webhook ingress available while a known 429 defers
subscription verification. Workers remain stopped and health remains not ready until
identity and subscription checks succeed. Shutdown cancels the wait; other prerequisite
failures remain fatal. A deployment still requires the normal readiness deadline.

`/health` also requires both workers to be ready and running and reports bounded worker
progress diagnostics. Occupied slots older than 120 seconds or an unrecovered worker
error close readiness even when scheduler ticks continue. Healthy idle workers require
no completed job or MAX probe. These observations do not establish successful deletion.

Migration `0004-scan-generation.sql` adds a cursor generation with a constant zero
default; it does not change activation or existing effect journals. A late webhook or
protection rewind invalidates an older page, including an empty response. New messages
outside the due window do not invalidate it. Preserve these rules when changing scans.
The authenticated `/internal/v1/runtime` page includes `diagnostics.lastError`,
`historyBoundaryBlocked`, `awaitingCurrentProtection` and `awaitingHistoricalProtection`.
The closed Safety Desk forwards these optional flags and allowlisted error reasons;
unrecognized errors become `unknown`, and older runtimes keep diagnostics absent
rather than implying clean flags. These fields grant no retry or mutation authority.
They stay outside ordinary settings responses; `blocked` alone is
not a reason to discard protection or replay a DELETE. See the
[27 October audit and regression plan](../plans/2026-10-27-lastik-deletion-audit.md).

Live acceptance records deletion acknowledgements separately from any unavailable
absence readback and preserves its exact operation journal.

An immutable `rollback-release <release-id> eraser` selects only Lastik's recorded
application image. It never restores or recreates either store. API rollback must retain
the installed Lastik ownership reader even when its availability flag is disabled.
The due-scheduling migration is additive and introduces no new reader floor. Native
scheduling writes keep the finite legacy `next_run_at` projection of ordinary and
control-scan deadlines and a conservative `live_floor` covering unfinished work from
both windows. A narrow trigger recognizes older writers that change only `next_run_at`.
It preserves their active cursor and routes unclassified discovery back to the control
scan after a forward upgrade. The transaction-local `eraser.native_schedule` marker
prevents native projection repairs from being mistaken
for legacy work. Preserve this compatibility contract, the original retry deadlines and
all existing ownership, connection-request and rate-limit floors. A compatible older
image can resume its earlier polling and automatic diagnostic reads: the adaptive
schedule and separate one-request/second control-scan budget apply only to images
implementing this stage. Rollback does not establish those efficiency guarantees.
Stopping Lastik blocks new deletions, but an already sent request can finish; preserve
its journal for reconciliation. Do not clear the queue or invent successful receipts.

Maintenance retains seven full days of terminal candidates and webhook receipts;
pending, dispatching, uncertain and review journals are never age-purged. Every
30 seconds a pass starts with one indexed page of 500 candidates and 1,000 receipts,
adapting to at most 16 pages. Pages skip locked tuples and recheck their terminal
predicate. Each statement has a 500 ms timeout and 100 ms lock timeout; admission
to further pages stops at one second. The final in-flight statement may finish after
that admission deadline. Replicas use a nonblocking advisory lock. Failure reduces
the next page budget without stopping dispatch scheduling or causing per-tick retries.
`/health` and bounded progress logs expose maintenance errors, successful-pass time,
deleted rows and the separately timestamped oldest expired heads. A stale head is
not a fresh observation, and a green worker does not imply maintenance caught up.

At the configured maximum, maintenance can admit 23.04 million candidates and
46.08 million receipts per day. These are scheduling ceilings, not measured sustained
throughput. See the [storage measurements and remaining acceptance gates](../plans/2026-10-29-lastik-storage-acceptance.md)
and [Lastik backup profile](postgres-recurring-backups.md#independent-lastik-profile).
