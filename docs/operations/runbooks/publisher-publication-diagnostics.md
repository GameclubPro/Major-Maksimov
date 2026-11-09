# Publisher Publication Diagnostics

Use the fixed read-only catalog to distinguish missing actor access, missing bot/catalog
evidence, disabled publication policy and attempted/ambiguous deliveries:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-publications --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-publications
```

After synchronizing this catalog, preview and apply the reviewed audit-role provision
step before using it. It grants 43 exact publication/access metadata columns; the
Publisher binding/comment group has 17 columns including census activation source. Identifiers are
used only for exact joins; report output contains fixed categories and aggregate counts,
not identifiers, publication text, media, URLs, token values or raw permission snapshots.
The role has no business-data write privilege and retains the existing one-connection,
read-only, statement, lock, wall-clock, memory and temporary-file limits.

The report samples the oldest 32 due PUBLIK_V1 occurrences for each of SCHEDULED,
IN_PROGRESS, AMBIGUOUS and FAILED. Each selected occurrence contributes at most eight
target slots and eight delivery rows. One extra row detects truncation at each boundary.
Required indexes are attested before the query; `--explain` never executes it.

Counts describe sampled occurrence/target/delivery slots, not unique users or entities.
Repeated schedules can therefore contribute the same recipient more than once. Saturated
or truncated samples are not a complete inventory. The report explicitly declares
`readiness_scope=metadata_only` and `capabilities_and_activation_checked=false`.
`metadata_ready` does not prove MAX write permission or completed activation: raw
permission data and the activation handshake are outside this diagnostic. Positive bot
proofs do not expire; old/null expiry alone is not a blocker. `bot_access_unconfirmed`
means a missing/future confirmation timestamp, and `route_quarantined` is separate.
Report schema v2 treats confirmed ADMIN/OWNER grants as durable, matching runtime
authorization. Older v1 reports can contain `actor_authority_stale` and
`actor_edge_expired`; these historical age labels are not current authorization failures.
The retained `edge_unexpired` field describes a stored timestamp, not effective authority.
`missed_window` identifies a missed scheduled window requiring an author decision; it is separate from `AMBIGUOUS` delivery results.

Interpret all blockers together with lifecycle and schedule status. A disabled policy or
fresh denied actor must never be silently enabled or granted access. Missing bot or actor
evidence may nominate an exact Publisher-owned verification, never authorize a send.
Historical age labels must not trigger a refresh or reset of a confirmed human grant.
Explicit bot denial requires administrator
reconnection; passive verification cannot bypass activation. A remote
message ID or an attempted/AMBIGUOUS delivery must retain its receipt and dispatch fence.
No report outcome authorizes bulk retry or recreating a failed publication as a new send.

This command makes no MAX calls, runs no publication workers and changes no queue or
application state. Use normal product authentication for any separately reviewed action.

## Exact scheduled-minute investigation

For a reported missing post, select one exact numeric actor, one negative chat ID and
the first UTC minute. The scope is always that minute and the following minute:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-slots ACTOR_ID NEGATIVE_CHAT_ID YYYY-MM-DDTHH:MM:00Z --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-slots ACTOR_ID NEGATIVE_CHAT_ID YYYY-MM-DDTHH:MM:00Z
```

First synchronize the reviewed exact green tooling revision through the normal deploy
wrapper's `--plan` path, then review `postgres-audit-provision` preview and apply its
metadata grants. This adds thirty-one exact columns to the existing forty-three-column
publication group. Older schemas retain zero additive grants; a partial group fails
closed. Run the plain plan and report sequentially through the catalog. It retains the
shared audit lock and existing read-only/session/wall/output limits. This tooling-only
change requires no application recreation, migrations or queue changes.

The selector checks all seven occurrence statuses, including SENT, PARTIAL and CANCELED.
Each of fourteen literal status/minute index heads contributes at most 32 rows plus
one truncation sentinel **before** actor and exact-target filters. Parent/schedule/access
lookups use bounded primary-key probes; the target uses its exact unique key. Each
matched occurrence contributes at most eight latest deliveries plus one sentinel,
also **before** the requested target filter. Index definitions, key types, enum values,
ordering, opclasses and collations are checked before execution. Plain `--explain`
uses internal scope parameters so its plan does not expose actor/chat values.

Each sampled delivery probes only its saved broadcast primary key. Schema v2 exposes
the envelope's status, next-send time, lock presence/time/age and exact occurrence,
content revision, profile and bot match flags. The comparison IDs, content and lock
tokens never leave SQL. A pending delivery without attempts or a blocker does not
establish readiness: its envelope can be stopped, locked, not yet due or mismatched.

When the author is unknown, select the exact target without an author filter:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-slots --target NEGATIVE_CHAT_ID YYYY-MM-DDTHH:MM:00Z --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-slots --target NEGATIVE_CHAT_ID YYYY-MM-DDTHH:MM:00Z
```

The target-only mode reports `selection_scope=target` and omits actor-wide candidates.
It retains the same fourteen capped index heads, exact target join, privilege/index
attestation and session limits. It does not enumerate other targets or expose authors.
The eight-delivery cap still applies before the target filter. Inspect both completeness
flags; an unmatched target in an incomplete sample is not proof of absence. Use a
concrete known scheduled minute rather than repeatedly scanning arbitrary history.

`source_complete=false` means more source rows existed than were inspected. A zero
match then proves only that the capped source sample did not contain a match.
`deliveries_complete=false` means the target may be outside the first eight deliveries;
an empty `target_deliveries` list does not prove absence. `actor_candidates` retains
bounded actor-owned slots whose saved target is missing, including DYNAMIC/all-audience
intent. It is not proof of the actual resolved audience. A complete zero actor match
cannot distinguish an unsaved request, draft without an occurrence, a different date,
or a different actor. Such cases require authenticated product evidence.

Rows retain lifecycle, schedule status (including ERROR), cancellation/blocker codes,
revision agreement, saved deadline/retry/lock clocks, attempts and recorded-receipt
presence. Unknown saved reasons become `other`; identifiers, tokens, content and raw
errors are excluded. These are current saved metadata, not historical authority or
execution traces. `access_reason` describes the saved author's access edge; an actor
warning alone does not block an accepted finite entity intent, whose execution authority
is checked separately at dispatch. The action ledger is outside this selector; envelopes are probed only
through sampled deliveries, so zero delivery rows cannot establish whether handoff or
an envelope exists.
`capabilities_and_activation_checked=false` and `client_visibility=not_observed` remain
explicit: a receipt or SENT status does not prove the client saw a post. Neither the
report nor its plan authorizes replay, cancellation, permission repair or another SEND.

For a fresh Publisher identity and webhook-target check, use the built standalone probe:

```bash
./infra/scripts/vps-connect.sh exec 'docker compose -f infra/docker-compose.yml exec -T api-publisher node apps/api/dist/apps/api/src/scripts/attest-publisher-identity.js'
```

Success prints `PUBLISHER_IDENTITY_ATTESTED`. The probe reads `/me` and `/subscriptions`
without starting the application, sending messages or changing subscriptions. It checks
the exact bot and webhook target; it does not verify update-type coverage or publication
delivery. Invoke the built file directly: the runtime image omits the repository-root
package manifest required by a root-level `npm run --workspace` invocation.

For current message-presence evidence, use previously observed exact delivery IDs:

```bash
./infra/scripts/vps-connect.sh exec 'docker compose -f infra/docker-compose.yml exec -T api-publisher node apps/api/dist/apps/api/src/scripts/audit-publication-delivery-verification.js --evidence --delivery-id DELIVERY_ID --json'
```

This separate mode reads only the requested PUBLIK_V1 SENT receipts and performs exact
MAX presence reads with the saved, matching required bot through normal client admission.
It accepts modern verification sources. It refuses `--apply`, range/cursor selection,
unverified/terminal filters and invalid or duplicate IDs, including at the exported
runner boundary before database or MAX access. It never sends a message or updates
delivery verification. Use a small selection while production is healthy; do not turn
the 200-ID ceiling into a routine polling batch.

Retain the private result with the bounded incident evidence. It contains exact join
identities; user-facing reports should give the selected scope and aggregate outcome.
`savedVerificationSource` and `savedVerifiedAt` describe retained observations;
`presence` describes the new MAX read. A saved source label alone does not establish all
stable-verification invariants. A missing/failed exact lookup is not replay authority,
and a successful one does not prove absence of every possible external duplicate.
`scheduledAt` and `publicationCreatedAt` retain the occurrence and original intent clocks.
`scheduleMode` describes the currently linked schedule; use it for latency comparisons
only when `scheduleRevisionMatches=true`. A later schedule edit does not rewrite the
saved occurrence time or prove its original mode.

## Current scheduling and recovery

Before enabling entity execution authority for this incident, use the reviewed
[obsolete-slot retirement](publisher-obsolete-retirement.md). Its fixed cutoff,
private preview and whole-audience zero-effect proof preserve uncertain work.

Deadline dispatch and imminent-publication preflight each have one coalesced coordinator
slot, independent of the serialized recovery slot. The existing MAX limiter, two refresh workers
and SQL send fences retain their quotas and ownership. Publication scheduling is owned by
`api-publisher`; `api-action` no longer scans these schedules. `publisher_background_budget_v1` reports a lane
whose wait or execution exceeds five seconds; this observation never cancels an effect.

Preflight considers the next ten minutes, with at most eight target nominations per
pass and sixteen queued preparation jobs. Two queued urgent jobs suspend speculative
admission. Saved snapshot audiences are materialized in full; a blocked recipient does
not prevent other recipients from preparing. A bounded page prepares each pending
context independently. Version zero is intent only; SQL forbids sending until the
untouched delivery wins the single transition to immutable version one. Every actual
send still rechecks bot, content, policy and schedule authority. Modern accepted finite
intents use saved entity execution authority; legacy indefinite intents retain actor checks.

New schedules persist an explicit late policy: by default recover for 24 hours and,
for recurring schedules, retain the latest due durable occurrence of the same revision.
The author may choose another deadline or all still-current repeats. Existing schedules
without this field retain their five-minute window. New occurrences snapshot `deliveryDeadlineAt`;
new NOW intent expires after 24 hours. New author retries persist a separate 24-hour
`retryExpiresAt`; old grants keep their five-minute authorization. Expiry fails only unsent claimable recipients and
the exact owned pre-HTTP claim; confirmed and uncertain effects retain their evidence.
No policy permits replay of an ambiguous send. Cancellation still consumes a slot in
new recurrence limits, and catch-up materialization is capped at 300 slots per pass.

Confirmed Publisher bot and human ADMIN/OWNER rights do not expire. SQL reads enforce
explicit revocation, exact bot, binding, policy and lifecycle before new effects.
Never clear existing access edges to activate this release. Bare 403/404 and partial
MAX responses are unknown. A valid exact-member nonadmin answer or an explicit trusted
removal can revoke rights; absence from a roster does not revoke a human grant.
There is no periodic all-chat permission scan.

Recipient `nextAttemptAt` persists across restarts. MAX Retry-After is a lower bound;
without it, external 429 backs off 30/60/120/240/300 seconds plus bounded positive jitter.
Local capacity and circuit hints retain their exact available time. External cooldown
is token-scoped in the existing atomic GCRA boundary. Publisher SEND yields immediately
on local rejection; other tokens and ready recipients retain their own progress.
A retry beyond intent expiry wakes the envelope for SQL expiry without an early SEND.

Unknown SEND outcomes retain manual review before any recipient quarantine, including after repeated 429 deferrals. Access-like text and bare 403/404 do not prove permanent loss. Publication FAILED history requires explicit retry authority; automatic recovery never recreates it from error text. Infrastructure SQL deferrals preserve the original content/deadline, and the P2010 adapter envelope alone is not evidence of a transient error.

Stale-date cancellation locks execution envelopes and rechecks untouched evidence before writing. A SENT receipt must remain in history after a schedule revision. The mini app reviews unknown deliveries across all accessible revisions while current execution/retry counters remain revision-scoped. Historical canceled rows are not reactivated by these readers.

The existing Bull wake remains an acceleration hint. SQL occurrences/envelopes are the
durable queue; a lost post-commit wake is repaired by the 15-second Publisher poll.
No separate outbox or second executor is required. Polls coalesce and shutdown waits
for owned work. Automatic fleet MAX degradation permits only bounded SQL preparation;
manual pause, Publisher identity pause and host pressure remain authoritative.

`publication_delivery_v1` separates `max_acknowledgement_observed` from
`receipt_persisted`. The former is the observed wrapper-return time, not a MAX server
timestamp or verified visibility. Keep both clocks separate from claim delay and
post-action completion. Measure fresh due cohorts separately from historical failures,
denials and ambiguous receipts; a healthy queue or an empty sample cannot prove the
publication SLO. Retain release, observation interval, sample size and truncation.

`publication_wait_v1` adds identifier-free diagnostic intervals:

| Stage                                 | Clock and boundary                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeup_queue`                        | Original durable signal creation to processor entry, including queue retries; expired signals remain visible. No extra schedule read: mode/media are unknown.                           |
| `initial_recipient_claim`             | Original NOW intent creation or scheduled occurrence time to a winning recipient claim with zero attempts and zero capacity deferrals.                                                  |
| `recipient_retry_lateness`            | Persisted recipient `nextAttemptAt` to the winning claim; it never replaces the original delivery deadline.                                                                             |
| `capacity_deferral`                   | Committed deferral decision time to its saved retry time, grouped by local capacity, MAX 429 or circuit wait. This is planned waiting, not elapsed dispatch time.                       |
| `observed_acknowledgement_to_receipt` | Observed wrapper return to the successful recipient receipt CAS; excludes earlier HTTP and action-ledger persistence. A recovery without a locally observed acknowledgement is unknown. |

Recipient observations retain schedule mode and text/image/video dimensions from the
existing execution snapshot. Canonical media comes from the exact actor-owned frozen content
revision already loaded for execution, not the intentionally empty envelope or request-media
fields. A proven empty asset list is text (`none`); a compatible retained video token can identify
historical video with a generic MIME type. Unsupported, mixed or contradictory metadata and
opaque binary media stay `unknown`. Recovery before metadata loading also stays unknown.
Legacy requests use their loaded media only when no saved content revision exists. This adds no
asset-byte reads or SQL requests. Historical labels are not repaired and must not be used as a
reliable media breakdown without checking the emitting release.
Missing, invalid or backwards clocks produce null duration,
not zero. These logs are diagnostic samples, not a durable cohort denominator or guaranteed
unique events: crashes, retries and recycled pre-dispatch claims can omit or repeat samples.
Use the persisted journals for accepted-operation counts and terminal outcomes.

`publication_send_v1` adds exact local monotonic SEND observations with fixed mode/media/lane
and outcome labels. `pre_http` includes preparation/admission; `final_admission` isolates the final
request guards, and `http` ends when transport settles, before response validation and logging.
Only a valid remote message ID establishes a local acknowledgement. `ledger_persistence` separates
the winning CAS from exact readback after a lost database acknowledgement or a competing completion.
`acknowledgement_to_ledger`, `acknowledgement_to_recipient` and `ledger_observed_to_recipient` retain
those distinct boundaries. Recovered-only receipts have no fabricated HTTP clock. Failed commits,
missing IDs and unknown effects stay unavailable; observations never authorize another SEND.

The closed Safety Desk publication cohort includes every persisted occurrence status in a fixed
fifteen-minute creation interval ending thirty seconds before observation. Counts are accepted
created runs, not recipient deliveries or later manual retries. Each status is bounded to 512
rows plus sentinel, with explicit incomplete coverage. Pending due/expired/unknown and future
schedules remain separate. Mode/media use only provable saved revisions; unknown is preserved
after latest-content retry or missing history. The observer never enumerates recipients or infers
completion time from a mutable `updatedAt`. Its concurrent index adds no scheduling authority.

The target-preparation migration replaces only the context constraint/trigger, with no
history rewrite or validation scan. Its new constraint checks all new writes. Both API
rollback paths require the current deadline/recipient-wait/durable-authority readers and Publisher scheduling wiring;
use reviewed current wrappers and a compatible forward correction if an older image
fails that source floor.

## Publication Delay Investigation, 2026-09-27

A bounded post-release log sample contained 34 deadline delivery claims with lateness
between 32.7 seconds and 74.4 minutes (median 18.3 minutes). These include historical
catch-up and measure claim time, not MAX-confirmed delivery or a new-publication SLO.
The action role paused preparation during an automatic webhook backlog of roughly
46-48 minutes and also reported host-load pressure. The capped database audit still
found fresh actor-access denials. Those denials must not be overridden to reduce lag.

This historical investigation retained the then-current per-bot budgets, two-connection
Publisher pool, receipt fences, stability window and serialized coordinator. The current
coordinator separation above supersedes only that serialization detail:

- Only publication preparation opts into a bounded slow path for automatic webhook
  backlog. Manual, MAX, mixed/unknown emergency modes and hard CPU/I/O pressure still
  pause it. Slow preparation uses two rows per pass; normal preparation retains its
  existing limits. Actual sending remains Publisher-owned.
- Preparation selects unblocked rows first and reserves a small recovery share for
  previously blocked work. Recovery rotates by last blocked check, with at most two
  reserved slots and no increase to the total batch. Two concurrent indexes support
  the new ordered selections; the migration changes no application data.
- Targeted wakes yield after four passes or a five-second soft budget; global sweeps
  also yield between envelopes. Each Publisher send quantum claims at most four
  recipients. The budget never cancels an in-flight MAX call, so a slow individual
  send can exceed it. Remaining deliveries retain their durable state.
- NOW and scheduled work have independent pending-work timers, with a 250ms overdue
  rearm and sequential database reads. A completed
  NOW wake no longer waits for unrelated scheduled work in the background coordinator.
  The 15-second safety poll remains; pauses and failed sweeps do not spin the timer.
- A PENDING recipient with the exact `PUBLISHER_ACTOR_ACCESS_REQUIRED` marker becomes
  eligible for the pending-work timer only after its persisted 60-second retry delay.
  The worker still verifies current bot/policy and the applicable entity or legacy actor
  authority before claiming and sending.
  A refused recipient renews its delay; other blockers, route quarantine, ambiguous
  effects and fresh in-flight siblings remain excluded. This prevents a recovered large
  audience from draining only four recipients per 15-second safety poll.
- Delivery verification becomes selectable only after its initial delay and persisted
  next-check time. Future verification rows cannot displace currently due verification.
- Scheduled send priority requires one untouched, due recipient in a bounded prefix of
  64 PENDING rows for the exact occurrence. Completed recipients do not occupy that
  prefix. A positive match also works for large and legacy audiences; final legacy
  author checks remain mandatory. Error/ledger/quarantine history and due blockers stay
  in fallback recovery rather than filling the send-priority portion. One tail slot is
  reserved for recovery when ready work exists. This is a selection opportunity: the
  five-second sweep may stop before the tail, and a ready recipient beyond 64 future
  PENDING rows remains in fallback. It is not a recovery latency guarantee under saturation.
  The pending-work timer excludes a future wait only after the separate bounded proof
  of a complete, finite, untouched audience; unknown work retains its previous wake path.

Regression coverage includes a real disposable PostgreSQL fixture with 3,000 old
blocked occurrences, fresh-work priority, rotating recovery, the actual generated
query plans, future verification exclusion, and pending NOW selection. Timer tests
cover nonoverlapping continuation, pause, shutdown, and strict wake failure propagation.
The PostgreSQL suite is part of `test:postgres-races` and requires a local `race_test`
database; it never sends messages to MAX.

After rollout, use the bounded catalog, Publisher dispatch health and existing
`Publik publication deadline delivery claimed` logs. Compare newly due work separately
from catch-up and denied targets. A healthy release alone does not prove delivery of
all historical posts. Investigate a concrete occurrence through authenticated product
access when a user reports a remaining delay; never turn that investigation into a
bulk retry of attempted, failed-with-receipt, or ambiguous deliveries.

Post-rollout diagnostics also identified a separate global governor input: moderation
pre-dispatch lookups counted target-local HTTP 404 responses as user-facing MAX failures.
One sampled 60-second health window contained 26 failures in 1,155 calls, no critical
failures, and zero webhook lag; the bounded failure logs reported `moderation_delete`,
HTTP 404 and `not.found`. This can keep publication preparation paused despite an empty
webhook queue. Moderation pre-dispatch reads now use the same existing 403/404 metric
exclusions as the delete mutation. Errors still propagate and preserve fail-closed
authorization/absence handling; 429, server and network failures remain health signals.

Queued required-subscription notices apply the same 403/404 health exclusion only to
their exact source-message read before SEND. The original lookup error still rejects
dispatch, releases only the untouched SEND claim and proves neither delivery nor deletion.
Member checks and actual sends retain their existing health accounting; 429, 5xx and
transport timeouts from the source read continue to signal MAX pressure.

## Priority Index Migration Recovery

If `20260927160000_index_publication_materialization_priority` stops with a lock
timeout, preserve its immutable SQL and the deploy transition journal. Synchronize
the reviewed, green exact-SHA checkout before using the fixed recovery command:

```bash
./infra/scripts/vps-connect.sh recover-publication-priority-migration
./infra/scripts/vps-connect.sh recover-publication-priority-migration --apply
```

Review the preview before applying. The command validates the checksum and one active
zero-step lock-timeout record, rejects other failed migrations, and checks exact index
parents, keys, sort definitions, methods, predicates and validity. Metadata is capped
at 8 MiB and logs at 64 KiB; the occurrence table must be at most 512 MiB. Unknown
definitions, partitioned parents and concurrent-repair leftovers abort recovery.

Apply holds the deploy lock, requires healthy ingress/admin readiness and normal system
mode, creates absent indexes concurrently or reindexes exact invalid indexes concurrently,
and rechecks each result. Each DDL operation has a 30-second lock timeout, 120-second
statement timeout, zero parallel workers and bounded memory/temp usage. The wrapper has
a 420-second wall deadline and cleans only its own labeled container/backend. Only two
verified valid indexes permit `migrate resolve --applied`; the receipt is checked again.
No application rows, queues or release manifests are changed. A failed step leaves the
migration unresolved; inspect a new preview before considering another apply.

Continue through normal scoped API deployment afterward. An interrupted release journal
requires caller-only `MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1`; the normal deploy must
re-prove the queue fence and exact image inventory before recording the new release.
