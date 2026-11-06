# Message Duplicate Rollout

## Scope

Message-v1 extends duplicate checks to nonempty short text, visible forwards and attachment
captions. The registered message service owns duplicate admission in every runtime mode;
OFF/shadow never fall back to the retired rolling text filter. Full mode applies
the chat's configured explanation/WARN/MUTE/BAN ladder, per author and chat. Disabled reactions,
mute duration, allowed repeats and comparison windows are preserved. Missing, expired or invalid
runtime authority cannot authorize new actions. Fleet-wide rollout is an explicit product
operation, never a smoke test; live test mutations remain limited to the designated test entities.

Strict message-duplicate bindings use their own guarded delete-intent execution path, independent
of `MODERATION_DELETE_INTENT_MODE` and its legacy canary IDs. Admission, persisted recovery and
final dispatch must agree on this distinction. Do not widen the base delete rollout to enable
message duplicates: that would also promote unrelated historical moderation work.

The user decision of 2026-11-06 replaces the TEXT/MESSAGE choice with one rule: a confirmed
text repeat is sufficient, and a verified image repeat is an additional independent reason.
New admissions compare text/captions and navigation/actions through explicit TEXT evidence,
regardless of the retained `duplicateCompareMode` value. Different or unavailable pictures do
not cancel a text match. The mini app exposes the common period, allowed repeats, scope and
reaction ladder without a comparison selector or technical recognition details.

Complete photo messages additionally use the explicit IMAGE path: exact canonical image
sets and separately verified recompression of a single photo, independent of captions,
with administrator-selected SAME_AUTHOR or CHAT scope and the same configured reaction ladder.
CHAT counts escalation per author, never across participants. Text enforcement accepted or
durably deferred does not enqueue a second image action; the shared message action claim and
Redis qualification fence prevent two penalties for the same message through different evidence.
Independently verified non-photo media retain their additional MESSAGE comparison path.

Known media without a usable URL/photo identity remain comparable in TEXT, including through
edits; unknown attachments, invalid buttons and split albums remain unverified in every mode.
Media without a retrievable original supply no IMAGE/MESSAGE evidence; filenames, sizes,
previews, platform IDs and download URLs are not equality evidence. Complete attachment arrays
are one logical occurrence. Full mode v3 IMAGE bindings carry imageScope and exact media/source
proof. Old message bindings with photos are rejected; they cannot acquire the new policy.
The separate perceptual/photo-only filter is retired, its authority is permanently OFF and its
queue consumer only abandons old ordering entries. Never infer equality from media IDs or
bypass content verification. Legacy storage fields remain for rollback-safe schema compatibility.

Deferred text qualification now writes `comparison=TEXT` in the existing queue job; its base
job identity and absorbing action eligibility remain unchanged. `comparison=IMAGE` retains
its separate job identity. An absent comparison retains MESSAGE media semantics; the worker
never infers TEXT from an old saved chat selector. Both settings digest envelopes include
`comparisonPolicy=text-or-image-v1`, ignore `duplicateCompareMode` and fence older grants/jobs
without clearing history, queues or durable claims. Existing v14 text normalization and image
algorithm versions remain unchanged. Both rollback paths require the explicit TEXT readers and
writers, the new digest policy and IMAGE availability independent of the old saved selector.

## Single-photo recompression evidence

`native-recompression-v2` adds a bounded comparison of independently downloaded single-photo
sources in the isolated photo sandbox. Candidate dHash bands only locate source pointers;
they never establish equality. The native verifier retains both full-resolution canonical
SHA-256 identities and checks dimensions, alpha and global/local pixel residuals, including
overlapping windows. It uses no OCR. The exact raster hash remains unchanged, and albums still
require exact equality of the whole photo set. Price, phone-number and text changes require
negative regressions; those fixtures do not establish protection against every arbitrarily
small edit or a corpus-wide false-deletion rate.

A supported standard JPEG recipe first attempts to reproduce the original once at the current
quality and sampling. Both independently decoded inputs retain their exact canonical identities.
The generated file must equal the current bytes or its entire decoded raster must equal the
current full raster hash. Exact byte equality avoids a redundant third decode. A refusal still
uses every existing residual guard; rolling window sums preserve all overlapping and clipped
edge windows. This bounded path does not resize images or relax the residual thresholds.

An accepted copy retains its original anchor and cannot become a new approximate anchor.
Source identity, original publication expiry, lifecycle, SAME_AUTHOR/CHAT scope and final
authority remain mandatory. A missing or invalid source/index record supplies no action
authority. Candidate buckets and returned results are capped; saturation can reduce recall.
The read filters candidates to dHash distance at most six and sorts the retained candidates by
distance before the global result and proof caps. Equal distances retain the deterministic
original order. Among returned candidates, exact canonical identities precede approximate
candidates and do not consume native pair budget. Source, lifecycle and accepted-original
checks remain mandatory. Remembering an original never applies this query filter.
Replay never extends the original expiry, and Redis TIME bounds physical retention to 48 hours.
Candidate scopes include the exact button actions; captions remain outside IMAGE equality.
A newer source with the same exact canonical SHA-256 can replace a retired source pointer;
late older deliveries cannot restore it. This pointer replacement never changes the accepted
history original, its publication window or reset fences.

Approximate evidence carries the accepted original through observation. The Redis transaction
pins its member, revision, original identity, epoch, content and live publication window before
any lifecycle or counter write. Removal, reset, edit or expiry during native decoding returns
stale; a previously accepted source cannot recreate a new approximate baseline in that race.

The IMAGE algorithm fence is `image-recompression-fixed-window-v2`, with the explicit native
recompression version alongside the common
`comparisonPolicy=text-or-image-v1` settings fence. A non-exact single-image
binding carries `imageRecompression` with the native version and both exact raster hashes;
schema, history and final dispatch reject unbound or inconsistent evidence. Old IMAGE grants
fail closed while the new history warms from accepted observations. Both rollback routes
require the actual reader/guard bodies, native verification and immutable-original candidate
handling, even if runtime matching is disabled. Do not clear old keys, seed old authority or
replay historical effects. See the [photo contract](exact-photo-duplicate-repair.md).

## Native photo admission near a deadline

The photo sandbox requires at least 1,000 ms remaining at admission: 500 ms for
startup/work and the existing independent 500 ms physical teardown reserve. A
request below that floor returns the existing `decode_deadline_exceeded` outcome
before spawning a child. Its existing bounded media deferral/expiry path keeps the
original job deadline and saved proof checkpoints; admission never renews authority.
This floor is not a promise that every image finishes in 500 ms. A native task that
actually times out or is abandoned still triggers mandatory sandbox recycling.
The 30-second ceiling, single-worker isolation, byte/pixel budgets and exact raster
hash are unchanged. Verify the boundary and next-request usability with
`native-photo-sandbox.spec.ts`, alongside hash, decode-budget and media worker tests.

## Source selection and publication clocks

Duplicate content and original publication time use the same message candidate as webhook
ingress. Diagnostic candidate paths are never interpreted as JSON paths: supported envelopes
can contain arrays or literal dots/brackets in object keys. Exact-message reads compare the
returned message itself, including its `content` body. Ambiguous navigation, incomplete albums,
unknown attachments and malformed actions retain their existing refusal rules.

The selected message's `timestamp`, `createdAt` or `created_at` anchors its publication window.
An edit without that proof stays unverified; neither a forward's date nor the event delivery
clock supplies an original publication date for an edit. Material edits still acquire their
introduction time through the existing lifecycle observation.

History v4 starts fresh positive evidence because v3 could retain an incorrect publication
clock from an enveloped message. Both TEXT/MESSAGE and IMAGE settings digests include the
storage version, rejecting old queued grants. No Redis keys or queues are purged, and old
messages/actions are not replayed. Until new originals are observed, comparison history warms up.
Old positive records expire under their existing bounded TTLs.

Removal/reset fences stay in the v3 namespace. A surviving v3 lifecycle also retains stale,
equal-time conflict and unknown-introduction refusals, including preliminary lifecycle/source
refreshes. It supplies negative reset evidence when no v4 incarnation has been materialized.
An unchanged, unverified or insufficiently dated
old incarnation cannot reappear after reset; a proven later content change can establish a
new one. The old publication clock, match counts and revision never become v4 positive proof.

Persisted webhook semantic keys and readiness deadlines explicitly retain their existing
`webhook_identity_v1` source projection. Improving duplicate parsing must not create another
execution identity or extend an already admitted deadline. Both rollback paths require these
readers and the v4 positive/v3 negative history boundary. See the
[source audit](../incidents/2026-10-29-antiduplicate-source-audit.md) for reproductions.

## Fixed Publication Windows

`dup:window:v1:<chat-hash>:v2:` stores a fixed window per verified fingerprint, anchored to an accepted original's
MAX `Message.timestamp`. Deleted/rejected attempts never become originals or extend the window.
A newly accepted publication after expiry starts a new window. Configured allowed copies and
qualified violations are counted separately; immunity is checked before reserving a reaction stage.
Each message can reserve only one stage, and delivery retries recover that same stage, including
after a confirmed deletion. The final guard still rechecks authority before each action.

Cosmetic edits preserve publication time; an observed material edit starts the clock for its new
content at the edit timestamp, preventing old posts from bypassing matching. Media verification
preserves that introduction time when promoting pending content. Returning an original to a prior
text never revives its earlier revision's evidence. Changed content, conflicting edits with identical
update timestamps and removal events revoke evidence before moderation's early returns. The final
guard also reads the exact original from MAX, so missing removal webhooks cannot authorize deletion
against an absent original. An unavailable MAX lookup retries; it never proves absence.
Manual release advances a per-author Redis cutoff in constant time, fencing prior observations,
bindings and delayed media without deleting another author's shared IMAGE original. Existing
manual-release grace remains in effect.

Each atomic history operation examines at most 16 fingerprints; records and counters expire after
the bounded history retention. Lifecycle tombstones and reset cutoffs cover the maximum supported
window. This logic does not change burst, quota or other rolling counters. The new settings digest
and required original proof reject old queued evidence; no bulk Redis purge is needed.
A deployment changing the digest starts fresh duplicate history.

V3 bindings include lifecycle revisions for both messages, a stable `originalId`, explicit scope,
settings policy revision and bounded authorization. Caption edits and one independently verified
locator refresh preserve the occurrence. An intermediate material version, conflicting timestamp,
incomplete content or lost state never restores an old binding. A fresh MAX read can revoke stale
evidence but cannot manufacture a publication or introduction timestamp.

Migration `20260930180000_add_duplicate_policy_revisions` adds server-owned
`duplicatePolicyRevision` and `duplicateHistoryRevision` with constant-zero defaults. Its row
trigger covers every writer, including private controls and bulk settings copies. Inserts start
at zero; updates cannot choose or rewind either revision. Effective matching, schedule, comparison
window or allowed-repeat changes advance both revisions; reaction-only changes advance action
authority while preserving history. The first enabled reaction selects the effective interval and
threshold, and the allowed-repeat clamp includes the explanation stage and enabled reaction count.
Inactive intervals/thresholds, ignored preset options, unrelated UI fields and retired photo
toggle/preset writes do not advance revisions. Returning changed settings to earlier values still
advances the revision, so old bindings cannot regain authority. DAILY ignores saved interval
durations; INTERVAL ignores saved daily boundaries/timezone. The additive DDL has bounded lock and
statement timeouts and performs no history backfill or index build.

Both API rollback paths require the v3 lifecycle/action-permit reader and this revision trigger.
The former current-content-only guard is insufficient for pending v3 decisions, including after
runtime authority has been disabled. Keep every API role on a compatible exact image before
releasing the deployment queue fence.

## Daily Time Periods

`duplicateWindowMode` defaults to `INTERVAL`, preserving existing behavior. `DAILY` compares only
content published within the same daily `[start, end)` period in `duplicateTimezone`. The start
is included, the end is excluded; an end earlier than the start belongs to the following calendar
day. Equal times are rejected. Outside the period, duplicates are allowed. Each new period starts
with a new original and independent allowance/qualified-violation counts; stored interval hours
are retained when switching modes.

Admission, media candidate keys, history and final action guards share the same period. The original
expires at its end, and delayed jobs/intents cannot cross that boundary or inherit another day's
authority. Settings and timezone changes invalidate pending evidence. Unchanged edits of yesterday's
messages never seed today's history. Daily manual-release grace is limited to the current period.
Time boundaries use calendar days. On DST fallback the earliest start and latest end form one
continuous period; nonexistent spring times advance by the gap, and a collapsed period is skipped.

Migration `20260929120000_add_duplicate_daily_window` adds four columns with static defaults and
bounded DDL timeouts. Existing rows remain in interval mode. Older settings clients preserve omitted
schedule fields; section apply includes both the schedule and comparison mode. No rows are backfilled
with message history. Validate and deploy all shared API roles before testing the new UI live.

## Validation And Delivery

The bounded exact-photo recovery and UI ownership plan is documented in
[Exact Photo Duplicate Repair](exact-photo-duplicate-repair.md).

Run the impact planner, API/contracts/Prisma/miniapp/admin checks and infra checks. Run the
`message-duplicate`, `photo-duplicate-history.redis` and `rule-engine-media-cooldown.redis` specs
with `MAXIM_TEST_REDIS_URL` pointing only to disposable local Redis. The blocking API CI lane
runs all three patterns. The interval audit and rollout semantics are documented in
[Duplicate And Interval Audit](../incidents/2026-09-16-duplicate-interval-audit.md).
Verify the settings screen on mobile, including OFF, OBSERVE, DELETE_ONLY and FULL status.
Deploy the exact green SHA to every shared API role and the affected static components.

The `message-duplicates` BullMQ worker runs in `api-moderation-background`, concurrency two.
Jobs carry durable receipt references, not message text or media URLs. First media candidates
do not download; potential repeats trigger bounded verification. Ordering/source/pressure
deferrals expire after ten minutes. Failed source handling must retry rather than acknowledge
unfinished history work. Monitor queue backlog and failures through the read-only monitor.
Unavailable ordering registration retries before job submission. Ambiguous queue-add recovery
preserves incoming eligibility through the absorbing Redis permit; infrastructure failure alone
must not become a permanent prohibition. Unsupported downloaded binary formats are terminal
evidence failures, so one unsupported baseline cannot block subsequent verifiable candidates.
See [Duplicate Miss Audit](../incidents/2026-09-19-duplicate-miss-audit.md) for regression coverage
and the limits of attributing a reported miss.

Fingerprint admission stays capped at 16, with representation for every enabled kind and stable
value selection under truncation. Media comparison materializes all distinct candidate receipts
before recording the current occurrence. One attempt admits at most 20 uncached media items under
the existing 30-second verification deadline; additional work defers with revision-scoped proof
reuse and the same ten-minute job lifetime. Terminal baseline rejection is cached separately and
never acts as equality evidence. See [Reliability Plan](../../duplicate-reliability-plan-2026-09-20.md).

Job v2 has an absolute deadline capped at ten minutes from its trusted event timestamp, runtime
expiry and the current daily period. Re-add and cosmetic edits never extend the same occurrence's
action lifetime. Per-job permits remain readable after ordering completion and expire physically
after seven days; that retention does not extend authority. A retry with a missing permit stays
ineligible. Early suppression commits an immutable SQL revocation under its own nullable claim key
before mirroring it to Redis, without creating an ordering head or taking another rule's action claim.
The existing indexed claims retention exceeds the bounded action lifetime.

The first media admission has its own immutable SQL dedupe record with a nullable action key.
Webhook replay remains a retry even after both BullMQ and Redis state disappear. Only the first
admission may create a positive permit. A crash before its Redis registration leaves enforcement
unverified; later retries cannot manufacture authority. Concurrent admission briefly defers while
the first registration is incomplete. Neither admission nor revocation takes a competing rule's claim.
That brief wait applies only while the incoming action deadline is still open. An already-expired
replay reaches the existing Redis terminal settlement immediately: it creates no media job, renews
no authority and does not fail the ordered webhook merely because its permit is correctly false.

An authorized action acquires the common SQL claim before reserving its immutable reaction stage.
A foreign owner consumes no stage. An interrupted own claim resumes the same stage; delivery
failures and later revocation do not blindly decrement a valid reservation. The final guard reads
the same SQL denial and Redis permit in `api-action` and before each sanction. Revocation completed
before the last mutation guard blocks the action; an already dispatched MAX request cannot be cancelled.

Terminal qualification rejection, worker expiry and exhausted attempts release only the exact unused
duplicate action key in a serializable transaction. An existing delete intent or moderation event
prevents release; foreign and newer owners are retained. The old unique dedupe tombstone remains and
the exact authorization events are revoked atomically, so another rule can claim the message while
the interrupted old duplicate owner cannot reacquire it. Temporary infrastructure failures preserve
the resumable owner. Cleanup never blindly decrements a reserved reaction stage.

Initial unqualified decisions check retained history before external MAX reads. A proven removal,
edit or reset rejects the obsolete binding immediately, even while MAX is unavailable, so it cannot
hold the photo ordering head through needless source retries. An unreadable history still retries;
the final source/history/policy checks and qualified own-delete continuation remain unchanged.
The existing `guard.message_duplicate_history_changed` counter records this early rejection.

`cleanupOnly` jobs reconcile ownership without analysis or actions. SQL failures retry every
30 seconds even after the final analysis attempt, until the original deadline plus 24 hours.
Completed cleanup preserves the positive permit of a materialized intent; terminated cleanup
revokes it. New preclaims also commit an immutable SQL cleanup obligation in the same transaction;
`api-action` reconciles its due index independently of BullMQ, Redis and feature switches. Intent
handoff removes the obligation atomically. A SQL outage delays this recovery until SQL is available.

Repeated worker stalls can terminalize a `cleanupOnly` job before its processor runs, without a
`worker.cleanup_exhausted` event. The SQL obligation covers this queue-loss case for preclaims made
by the new writer. Do not use `job.retry()` as cleanup recovery: BullMQ retains its deferred-failure
and stalled counters.

Historical preclaims without an obligation are outside this guarantee. The migration creates an
empty table and performs no backfill; the reconciler never scans legacy claims. A surviving worker
can still release an exact unused owner, and an unexpired matching resume through the new writer
can register its obligation. Otherwise the claim remains fail-closed until exact reviewed recovery
or normal retention. An empty cleanup sample does not prove there are no historical orphan claims.

The legacy SQL claim has identity and creation time, but no original absolute action deadline or
exact binding/authorization event timestamps; its hashed keys cannot recover them. Retained webhook
payloads may supply an event timestamp, but do not prove the immutable deadline clipped by runtime
control or the daily period. There is no dedicated bounded orphan-preclaim audit/repair CLI.
`moderation:repair-missed-deletes` requires moderation-event evidence and creates delete intents;
it is not an unused-claim cleanup tool. Historical repair needs a separate bounded read-only preview
with exact owner generation and surviving job/binding evidence, followed by reviewed transactional
checks for intents, events and DELETE receipts plus exact-event revocation. Missing proof must remain
unresolved: never infer a deadline from `createdAt`, clear claims in bulk, or replay moderation.

Governor pause honors its bounded recommended delay; slow pacing permits progress after one delay
per job. Followers wait for the head's next eligible time or bounded crash recovery. Expiry ends work
without treating incomplete proof as a match or successful action. Media retains byte/pixel/decode limits.

## Operational Diagnostics

Duplicate history keeps a 250 ms Redis admission deadline, checked before the Lua mutation,
and a separate one-second client reply budget. A delayed reply may settle the same already
accepted command; it never retries that command or extends duplicate action authority.
Missing replies still fail closed. Execution diagnostics distinguish
`duplicate_history_reply_deadline` from `duplicate_history_admission_deadline`; neither
label authorizes replay or settlement of a previously started webhook.
Each RedisCounterService permits at most 128 unsettled duplicate-window commands, retaining
each slot until its Redis promise settles even if its caller times out. A full local pool refuses
before sending and reports `duplicate_history_local_capacity`; this is not proof that the
surrounding webhook had no earlier effects, and does not authorize replay.

The SQL cleanup reconciler retains its limit of 25 due obligations per 10-second tick. Its
`message_duplicate_cleanup_sample` log reuses that indexed selection: `sampledDue` is a lower
bound at selection time, `sampleLimitReached` means the sample reached 25, and `oldestDueAgeMs`
is the age of the oldest selected deadline. It never performs a total-depth count or another
scan. Logs appear while a due sample exists and once when it becomes empty; a failed read is
reported as unavailable, never zero. `released` counts released owners, while materialized or
locked duties can remain unreleased. Logs contain no owner/chat/message identifiers, and a
diagnostic failure cannot change cleanup or action authority.

API processes emit `message_duplicate_diagnostics` structured summaries with `schemaVersion: 2`,
`windowStartedAt`, `windowEndedAt`, fixed numeric `counters` and `phases`. Each phase has a count,
total/max duration and a histogram aligned with `phaseBucketUpperBoundsMs`. Policy, source,
media proof, history and enforcement timings use a monotonic clock and include failed attempts.
The following fixed phases narrow those aggregate timings; overlapping phases must not be summed:

- `download`: a photo or binary download attempt, including source rejection and failure.
- `decode_wait`: local fingerprint-slot acquisition, including capacity/deadline rejection.
- `native_roundtrip`: sandbox IPC, process startup, decoding and reply; it is not CPU decode time.
  `local_fingerprint` measures the local development fallback, including hashing.
- `ordering_acquire`: one ordering acquisition attempt up to entry into the execution callback,
  or its deferral/error. It excludes execution and durable waits between retries; `worker.age_*`
  remains the total age since enqueue, including all earlier deferrals.
- `qualification`: fresh duplicate qualification; `intent_handoff`: durable intent handoff.
- `delete_dispatch`: duplicate-owned DELETE transport call, including admission and final guards.
  `delete_receipt`: persistence/finalization after a successful response. Neither count proves a
  successful receipt; failures are timed too. These labels exclude unrelated moderation rules.
- `cleanup`: worker terminal-cleanup attempt, including wakeup/retry handling; `cleanup_sweep`:
  an active or failed bounded SQL cleanup sweep. Empty idle sweeps do not emit phase samples.

The native protocol carries no per-stage CPU timing; separating native CPU work from IPC/startup
requires a separately reviewed measurement change. Durable ordering wait across retries likewise
has no exact standalone timer without changing persisted state. Timings remain best-effort attempts.
Emission is at most once per
30 seconds while active, plus a final shutdown flush. Summaries have no message contents,
identifiers, URLs or free-form errors. They are best-effort
process-local attempt counts; retries and baseline verification are included, and a crash can
lose the unflushed interval. Absence of a log record is not proof of zero activity.

Use bounded service-log reads to inspect these summaries, especially in
`api-moderation-background` (media/ordering) and `api-action` (final delete guards).
`history.no_match_or_allowed` includes originals and explicitly permitted repeats;
`history.matched` is detection, not deletion. `enforcement.intent_handoff` is durable handoff,
not a MAX receipt, and `worker.completed` does not imply any action. `worker.age_*` describes age
since original enqueue including retries, not individual request latency. Guard counters separate
changed content/history/settings, immunity, manual release, policy rejection and unavailable
verification. `media.budget_deferred` distinguishes bounded resource deferral from a non-match.
Continue using persisted delete receipts and authenticated per-chat diagnostics for actual outcomes.
Per-chat observation outcomes are separately aggregated in four 15-minute Redis buckets under
`message-duplicate:diagnostics:v1:<chat-digest>:<bucket>`, with a two-hour TTL and fixed fields.
Each process buffers at most 256 buckets plus one bounded flush, and has at most four writes in
flight. Blocked writes retain their slots; moderation never waits for a telemetry write. Every
write has a Redis-time deadline. Overflow, failed writes and a restart may lose observations,
so the API explicitly reports `BEST_EFFORT` and `ATTEMPTS`, never unique-message totals.
`telemetry.buffer_limited` and `telemetry.unavailable` identify observed losses.
The reader performs exactly four point reads with a 250 ms deadline. Missing data produces
`NO_DATA` with null counts/coverage; failure or malformed data produces `UNAVAILABLE`. A real
zero percent requires recorded supported attempts with no completed comparison. Media enqueue
is not a completed comparison and is excluded from the coverage denominator; verified media
attempts and retries are counted at the worker boundary. First candidates, stale revisions,
deferrals and failed comparisons cannot inflate verified coverage. Comparison success does not
prove that an action was handed off or a message deleted. No telemetry is used as action authority.
`worker.cleanup_retry`, `worker.cleanup_completed` and `worker.cleanup_exhausted` describe the
separate ownership recovery, including no-op cleanup, and never count new moderation actions.

`media.url_malformed`, `media.url_protocol`, `media.url_credentials`, `media.url_port` and
`media.url_host` classify rejected download attempts using fixed labels. Initial and refreshed
attempts, worker retries and separate baseline/current proofs can contribute independently.
These process-local counters are best-effort attempts, not exact rejected-message totals; they
emit no URLs, credentials, tokens or host values. A photo source rejection can trigger one exact
MAX message lookup per verification attempt. The same photo/author/chat/message must be confirmed
and the refreshed URL passes the unchanged downloader policy; a second rejection is terminal.

`guard.current_lookup_unavailable` and `guard.original_lookup_unavailable` locate a failed exact
message read while preserving the aggregate `guard.unavailable` counter and retry behavior.
`guard.current_lookup_confirmed_absent` and `guard.original_lookup_confirmed_absent` count exact
lookup absence, including a structured HTTP 404 with a message-specific MAX error code. Bare
HTTP 404, chat errors, free-form text, transport errors and other statuses remain unknown and
cannot remove evidence. Confirmed original absence tombstones that original without inventing
a new publication time. Confirmed current absence alone cannot authorize sanctions: the exact
successful DELETE receipt and every existing binding/policy check remain required. These fixed
labels disclose no message, chat, user, source or error payload.

A generic `not.found` from the exact current-message GET is unavailable evidence, just like a
codeless 404; it is never a message-specific absence receipt. Only a full sanction may replace
that read with its own unchanged, verified, successful DELETE receipt, including exact v3
binding, reason and registered executor identity. Original-message reads, fresh rights,
policy, immunity, source holds and final authority still apply. Without that receipt, only
the explicit initial unattempted sanction may decline; later checks keep the failure fence.
Explicit chat/access errors, conflicting nested codes, other codes and attempted or ambiguous
mutations cannot use this path. Keep both codeless and generic-code cases in the native
PostgreSQL receipt regression; a mock with only an empty 404 body misses MAX's actual envelope.

Initial sanction admission requires that same exact successful own DELETE receipt even if MAX
still returns the current message. A concurrent durable delete may otherwise remove the source
before its receipt commits and turn the final sanction guard into a failed whole handler.
Missing, unfinished or mismatched proof declines the sanction before state changes, without
waiting or starting another retry queue. The existing DELETE intent and its original deadline
remain with the durable worker; the skipped sanction is not replayed after deletion completes.
Returned current content, original evidence, rights, immunity and final guards remain checked.
`guard.message_duplicate_sanction_delete_unconfirmed` counts this visible-source refusal;
`guard.message_duplicate_sanction_source_unavailable` counts the initial unavailable-source refusal.
Strict receipt failures carry fixed executor/reason/clock/binding detail labels without values.
Conflicting top-level/nested MAX codes and mutation-marked errors never prove message absence.
Run `message-duplicate-initial-dispatch-postgres` for competing-owner/same-chat progress and
no replay, plus `message-duplicate-sanction-receipt-postgres` and the mirrored duplicate-notice
full-path suite for persisted proof and final dispatch fences.

The first inline delete check has an explicit `initial_unattempted` phase only when its
durable intent has one lease attempt and no dispatch or remote-success markers. An unavailable
current/original HTTP 404 at this boundary may end the inline action after an exact live-lease
SQL update commits the retry. This returns no DELETE proof and runs no sanction or notice;
the intent, action claim, reasons and original deadline remain intact. Failed persistence,
changed ownership, later checks and previously attempted intents retain the failure fence.
Initial qualification must not discard a detected duplicate merely because an exact current/original
GET returns an unproven 404 or the typed pre-dispatch quota refusal. The inline path first persists
one job in the existing `message-duplicates` queue using its durable canonical receipt, unchanged
settings/control digest and original action deadline. Only successful handoff returns `DEFERRED`;
queue failure still fails the handler and retains its fence. The SQL action claim and cleanup
obligation stay owned. Without a durable source receipt, the existing unused-claim revocation
remains the fallback. No path treats an unstructured 404 as confirmed absence.

The same worker resumes TEXT and plain MESSAGE qualification directly from their retained receipt
and history, without media downloads or candidate-cache work. Media qualification keeps its existing
queue owner on that source-read failure instead of completing and revoking the job. Both use the
existing finite retries and original ten-minute maximum; they never replay the webhook, extend a
window, undo a revocation or reset uncertain effects. Fresh settings, author immunity, source holds,
both message contents and final dispatch guards remain mandatory. Terminal rejection/expiry still
releases only an unused exact claim through the existing cleanup journal. Native initial-dispatch
tests cover mirrored receipts, following same-chat progress, actual BullMQ recovery, a repeated
queued refusal, and disable/edit/revocation/expiry refusal. Other lookup errors retain their existing
failure behavior; this correction is not a guarantee through an indefinite MAX outage. Immediate DELETE does not use the irreversible-action
ledger, so zero DELETE ledger rows alone cannot prove that an intent has never executed.

The closed dashboard reports the active `message-duplicates` queue rather than the retired photo
queue. Missing registration or an unreadable Redis counter fails that snapshot as unavailable;
it must not appear as an empty duplicate backlog. Lightweight readiness and operational governor
snapshots do not add auxiliary queue reads.

Use `./infra/scripts/vps-connect.sh postgres-audit duplicate` for bounded, identifier-free SQL
diagnostics. Re-provision the reviewed audit role after synchronizing this catalog. The current
settings/intent/reason group has 38 column SELECT grants: the original 17 plus 21 bounded
owner-proof metadata columns. It never grants table SELECT on settings or delete intents;
identities, lease tokens and reason metadata are check-only and must not appear in reports.
The `duplicate_settings` schema-v2 report separates `saved_eligibility` (master switch, scope and
valid schedule) from `legacy_compatibility` (retired toggle/presets). Legacy comparison mode does
not control IMAGE eligibility; `text_only_count_lower_bound` remains zero under the unified policy.
`image_eligible_count_lower_bound` describes only the capped settings sample; it does not prove
current DAILY admission, runtime permission or fresh bot capability. SQL reports those runtime
facts as unobserved. Pair it with a separately dated runtime-control `get` and authenticated
capability snapshot; the observations are not atomic. Preserve `sample_saturated`, `complete`
and lower-bound qualifiers when interpreting the report.

If the delete-intent diagnostic times out, use
`./infra/scripts/vps-connect.sh postgres-audit duplicate --explain` after synchronizing the
reviewed catalog. This emits only plain JSON EXPLAIN for the fixed intent query, skips execution
of settings/events reports, and retains the audit-role checks and existing timeouts. Ten literal
status predicates let the planner use status-specific statistics; each ordered source returns at
most 65 candidates including the saturation sentinel, with at most 9 reasons per selected intent.
Inspect that each large status uses the ordered `moderation_delete_intents_retention_idx` scan
directly below its LIMIT. The local regression includes all competing intent indexes and skewed
status populations; a production timeout can still reflect host I/O and does not authorize a
larger timeout, an unbounded scan or a new index without evidence.

## Runtime Control

Run the built operator inside the exact released `api-admin` container through the normal VPS
wrapper. All writes are previews without `--apply`. Inspect `get`, review the explicit CHAT
target through normal managed discovery, then repeat the reviewed command with `--apply`.
Only the designated test chat is a default live smoke target. Preserve administrator immunity;
an administrator's messages cannot prove participant enforcement.

```sh
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js get
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js set --expected-revision 0 --chat-id=-123 --mode delete_only --ttl-hours 24
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js set --expected-revision 1 --all-enabled-chats --mode full --permanent
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js off --expected-revision 2
```

Replace example IDs/revisions with reviewed values. V2 accepts either a bounded lifetime of at
most 24 hours or explicit `--permanent`. Scope is either at most 1000 unique IDs or
`--all-enabled-chats`; global scope requires no fleet enumeration or settings writes. Per-chat
`antiDuplicateEnabled` remains mandatory. Every update, including permanent OFF, advances the
CAS revision. New revisions/settings use separate fingerprint groups, so shadow or
pre-activation history cannot retrospectively escalate sanctions. Status output omits chat IDs
and message contents. Do not change unrelated chat or photo settings.

## Administrator Diagnostics

The mini app displays the first deleted message number, not a zero-based allowance:
stored allowance 0 is message 2, allowance 1 is message 3. The preview uses the same numbering
for every configured reaction; existing saved thresholds are not migrated or reset.

Authenticated chat administrators can read `GET /v1/chats/:chatId/duplicate-diagnostics` and
request `POST /v1/chats/:chatId/duplicate-diagnostics/recheck`. GET uses existing capability
snapshots; POST refreshes this chat through the shared multi-bot planner and its backoff.
Neither endpoint sends messages, deletes content or changes chat policy. A stale/backoff-retained
snapshot cannot confirm a requested live recheck. Saved enablement, runtime mode and permission
proof are separate fields. OFF stops duplicate actions; OBSERVE records matches without acting.

History reads the dedicated `duplicate_diagnostics_history` projection for this exact chat,
ordered by intent creation time and ID within a fixed 24-hour snapshot. `limit` accepts 1–20
entries (default 5); `nextCursor` continues the same snapshot and authorized chat for up to
15 minutes. The query selects at most `limit + 1` projection rows before looking up each
intent's latest duplicate reason and at most five exact-chat/message sanction events.
Unrelated rules and retained history cannot evict duplicate entries. The read query has a
two-second statement deadline and a three-second transaction limit; timeout means unavailable
history, not zero attempts. The mini app shows at most 50 entries and discards delayed page/link
responses after chat/account changes or leaving the screen. Successful duplicate settings saves
invalidate diagnostics for the saved request's chat and account.

The additive migration creates an empty projection and a best-effort server-owned trigger for
new or updated `DUPLICATE_DELETE` reasons; it does not scan old reason tables. Ordinary projection
write errors are isolated, and the function-scoped lock timeout is 25 ms. A whole-operation
cancellation still cancels moderation rather than being hidden by the observer.
`coverage: PROJECTED_ONLY` and `limited: true` explicitly retain the
historical gap, including an empty page. Each entry exposes `registeredAt` to distinguish later
registration from the original intent creation time. Responses omit content, user/bot identities,
hashes and free-form errors. Only a persisted remote deletion receipt is labelled deleted;
verified absence remains a separate outcome. Valid bound evidence exposes target/original message
IDs, publication/repeat-allowed times, comparison type, window and first deleted message number.
Sanctions remain requested until an exact binding and sanction tuple match durable event evidence;
WARN uses its terminal persisted decision, while MUTE/BAN require `sanctionApplied: true`.

`GET /v1/chats/:chatId/duplicate-diagnostics/:intentId/message-link/:role` (`target` or `original`)
rechecks exact-chat admin access, resolves the selected projected intent and then performs a
bounded read of that exact MAX message. It returns an official validated credential-free HTTPS
`max.ru` link or `UNAVAILABLE`; it never fabricates a link or sends a public test message.

Historical projection repair is explicit and bounded. Preview with
`npm run moderation:recover-duplicate-diagnostics --workspace @maxim/api -- --chat-id <chat-id> --until <recent-UTC-ISO> --limit <1..100>`.
Review `previewSha256`, then repeat the same arguments with
`--apply --expected-preview-sha <reviewed-sha>`. A returned cursor continues one recent
chat/status-indexed slice; no whole-history scan or automatic backfill runs. Each transaction
has two-second statement, 500 ms lock and three-second transaction deadlines. Repair rechecks
exact intents/reasons and only inserts missing projection rows; it never updates intent authority,
queues, claims, counters or MAX state. Replays preserve the original registration timestamp.

## Stop And Rollback

Use `off --expected-revision <current>`, preview then apply. Final dispatch rechecks control,
settings, author immunity, current MAX contents and read-only history; a queued intent is not
permanent authority. Full sanctions recheck inside the existing participant sanction lock and
before the actual WARN/MUTE/BAN mutation, with terminal event/ledger idempotency. Absence alone
is not authority: a removed message requires this exact successfully dispatched delete intent
and its matching content/revision binding. `MESSAGE_DUPLICATE_ENABLED=false` is an additional
environment ceiling.

Both API rollback paths require v3 binding, lifecycle and durable/permit authorization source
capabilities, duplicate-only phone evidence v8, mode-aware TEXT lifecycle eligibility,
and near punctuation/symbol positions with the `text-fixed-window-safe-text-v14` / `text-fixed-window-v14` settings fences
and common `text-v14` matching namespace. Shared semantic normalization must preserve case-sensitive
finite quantity units in scalar/dimension/compound expressions and prefix fields (`MB: 100`,
`MΩ = 10`) for fingerprints, source digest and lifecycle identity. Phone evidence uses the same
finite electrical units (`Wh`, `Ah`, `VA`, `var` and `Втч`, `Ач`, `ВА`, `вар`) and
prefix/suffix quantity guards, including a prefix before an explicit phone label. Consumed
compound expressions cannot be rescanned by the outer scanner; the ordered span merge stays linear.
Truncated protective contexts must fail closed, and numeric
colon operands cannot become phones. Shared analysis preserves independent CUSTOM switches.
History storage v4 additionally participates in every settings digest, including exact-only,
CUSTOM-link-only and IMAGE: this transition invalidates all older history, queued jobs and grants.
The new baseline fills from newly accepted originals; the first repeat without such an original
can be accepted. Exact IMAGE raster matching semantics remain unchanged.
Ambiguous numeric identifiers, prices and measurements are never stripped as phones or
used as phone-only duplicate evidence. Phone evidence requires an explicit phone label from a finite
list with word boundaries, a proven labelled list, or conventional complete `+1`/`+7` grouping.
A bare compact international prefix is a signed quantity and remains content without that label.
Other unlabelled grouping remains content. Phone labels cannot match product names or words about bells and mobility through broad
`тел`, `звон` or `мобильн` roots. Both rollback paths require the actual bounded label expression,
so changing only the phone-evidence version cannot admit the old broad classifier.
The raw adjacency guard runs before whitespace or wrapper normalization: Unicode identifier and
email characters next to a numeric candidate, including compact bracket/quote wrappers, remain
content. Compact left-side explicit phone labels are allowed; right-side identifier characters
always reject the candidate. Reserved URI schemes such as `tel:` and `mailto:` remain content.
Raw arithmetic operators, short numeric operands and single-letter variables before a candidate
also reject it unless an actual finite phone label supplies the context. Identifier labels
`номер`, `код`, `идентификатор` and `артикул` retain their finite case/plural forms in both the
adjacent-label and clause guards.
Arithmetic operators include Unicode math symbols and middle-dot multiplication; right-side
operators with an operand reject even explicitly labelled candidates. Long signed numeric
predecessors also remain arithmetic evidence. An independent phone-list exception requires an
actual finite source label and a complete previous/next candidate passing the same conservative
phone proof; a plus and numeric shape alone cannot supply that exception. Currency prefixes/suffixes,
thousands, participant counts and data units remain numeric evidence. Bounded context views ignore
format controls only for these protective checks, preserving original bytes. Strong identifier and
quantity labels remain protected even when followed by a phone noun; only the finite `номер телефона`
phrase is itself a phone label.
Both extraction and stripping exclude candidates overlapping recognized URL ranges and preserve
the complete URL bytes. Content and near-numeric normalization strip phones against the original
source before removing URLs, so separated numeric fragments cannot become fabricated phone evidence.
Explicitly labelled compact international phones and conventional complete grouped phones keep
their positive matching behavior. Country-prefixed 1/7 forms, with or without `+`, require eleven
total digits; national 8/9 forms require eleven/ten. A greedy span with an appended quantity is
rejected whole, preserving every numeric character without guessing a shorter phone segment.
Unknown-length grouped candidates remain whole; dotted candidates require the known
`1/3/3/2/2`, `1/3/3/4` or national `3/3/2/2` digit grouping. Signed decimals and other ambiguous
groups are preserved even with a phone label.
Unprefixed compact numbers require a known-length 1/7 or national 8/9 form even with a phone
label; an arbitrary EAN/document number cannot inherit phone authority from that label.
Model, certificate, barcode, IMEI, EAN and GTIN contexts protect even phone-shaped identifiers.
Both rollback paths require these actual guards and their
order; raising only a version cannot admit a source that omits them. The separate phone-blocking
policy is unchanged. Near may
normalize case and punctuation spacing, but cannot erase or move internal punctuation.
Use the shared API queue fence to stop old producers/workers and recreate every API role
before resuming processing. A mixed old/new fleet is not a supported activation state.
Never roll back to the old Latin/Cyrillic-only near matcher, even with control currently off:
the stored enabled settings and old grants must not regain authority on a later activation.
Pending intents
can survive a control downgrade, so an older unguarded API is not a valid rollback target.
Use a retained compatible immutable release and the normal queue-fenced rollback workflow.
Both rollback paths require the actual v4 positive history namespace, retained v3 reset/removal fences,
Redis-clock-bounded PXAT expiry, replay expiry preservation and the shared 48-hour window cap.
History lives at most 48 hours plus 11 minutes for existing processing/clock budgets;
message/qualification use their own shorter window plus that grace. Replays cannot extend expiry.
Legacy settings above 48 hours are clamped by the resolver and repaired with the existing settings
CAS without overwriting unrelated fields or authored text. Old Redis keys expire naturally;
do not mass-delete history or shorten durable sanction/action fences.
See [Bounded history review](../../antiduplicate-bounded-history-2026-10-05.md).
API images before text-v14/history-v4 do not satisfy this source floor. Recovery
uses the reviewed control OFF path above and a forward compatible release; static-only rollback
is independent. Do not weaken source or applied-migration compatibility checks to reuse an old API.
Older images do not understand the new protocol and are rejected as targets; rollback does not downgrade
full sanctions into unguarded deletes. Inspect runtime status after rollback before re-enabling.
Never remove the shared message action claims or reset counters to replay moderation.
