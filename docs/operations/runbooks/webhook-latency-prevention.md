# Preventing webhook stalls and unsafe recovery

Read this before changing webhook selection, preparation, execution handoffs, retry/ordering
guards or backlog recovery. It is the durable checklist for the
[October recovery review](../incidents/2026-10-10-webhook-latency-recovery.md), not a reason to run
maintenance on a healthy fleet. Root and scoped `AGENTS.md` remain authoritative for delivery.

The initial fixes are in runtime `629ae6917dd120bcafd67eca729fe15e7ec1d717`; the native
notice expectation is corrected in `dc52b5e4ac45d8980f901b957c234440f517b518`. Subsequent
guarded DELETE handoff and production canary corrections, including their completed release
identity and acceptance limits, are recorded in the
[subscription/membership incident](../incidents/2026-10-10-subscription-membership-handoff.md).
An older checkout may lack these implementations or tests. Reconcile the reviewed source
before editing it; copying these notes does not install a fix or prove the deployed version.

## Invariants that must survive a change

1. **Independent work progresses.** An unresolved head blocks its dependent ordering scope,
   not unrelated chats, bots, shards or fresh administrator commands. Keep one bounded selector,
   bounded work across polls, current eligibility reloads and same-chat exclusion. An unfinished
   operation keeps its slot until it really finishes; a polling timeout cannot release its authority.
   Manual group commands reserve one `admin-manual-commands` worker while the retained
   `admin-manual-fanout` worker handles background work and old commands; total manual concurrency
   stays two. BullMQ priority cannot preempt active fanout or cleanup. Preserve legacy job-ID
   lookup before new-queue admission, both readers and all effect fences. See the
   [manual-command incident](../incidents/2026-11-06-manual-command-queue-latency.md).
   Refill available preparation capacity during selection and drain owned work before closing stores.
   A refused canonical business-lease CAS grants no execution authority. Use the typed
   preparation deferral and the existing locked BullMQ delay, preserving the competing lease,
   source deadline and all start/completion fences on re-entry. Never turn contention into
   a failed job that waits for stale-QUEUED repair. Do not generalize this to arbitrary SQL,
   commit, command recovery or handler failures. The native multibot full-path suite covers
   background removal/edit, join and dynamic workers, independent completion and no replay.
   Unexpected preparation errors retain their original propagation and emit only the closed
   execution diagnostic fields under `stage=preparation`; this stage is not no-effect proof.
   Prepared-mirror settlement and handler-finished checkpoint persistence acquire their
   canonical claim before the owner receipt, matching start and completion. Preserve each
   CAS and the checkpoint transaction's rollback on receipt rejection. The native multibot
   regression races mirror settlement with positive checkpoint recovery and independent
   execution; ordinary ordered-predecessor waits remain quiet typed scheduling events.
2. **Bound database work before expensive predicates.** A result `LIMIT` does not bound scans,
   sorts or correlated probes. Use indexed keyset pages with raw cursors retained before filtering,
   bounded materialization and primary-key payload reads. Keep due work separate from terminal
   FAILED history. Test representative retained history, timestamp ties and planner skew in real
   PostgreSQL; review a plain plan before a new production query. Never run live `EXPLAIN ANALYZE`.
   [Managed giveaway selection](managed-giveaway-due-progress.md) applies the same bounded
   raw-page rule before access, lock and Redis skips, with inspected-prefix continuation.
3. **Keep atomic hot-path writes cheap.** Receipt-only/payload-only changes that fit one SQL
   statement should keep their conditional status/CAS and JSON no-op checks in that statement.
   Do not add BEGIN/COMMIT around a single atomic update. Multi-step invariants still require
   transactions; removing all locks or transactions is not a throughput correction.
   Prisma pool admission may retry pg-pool's exact waiting-list timeout once, before a
   client is returned. The configured pool cap and per-attempt timeout remain unchanged;
   total admission can take two waits (ten seconds with the production five-second timeout).
   Never extend this retry to SQL, transaction callbacks, commits or MAX calls, including
   failures with the same error text. Shutdown must suppress a new acquisition. Native
   `connection-admission-pool-postgres.spec.ts` verifies bounded occupancy, no SQL replay,
   callback release, shutdown and adapter reconnect. This cannot recover a historical
   started handler or prove that a future exhausted pool will become available.
   The no-immunity path probes the exact grant and logical-message receipt unique keys
   before reserving a transaction. Retain full ownership/current-grant validation when
   either exists; never cache absence. Native immunity regressions cover retained-history
   plans, concurrent quota consumption, grant creation and revoked/conflicting receipts.
4. **Distinguish denied dispatch from unknown effects.** For an already persisted required-
   subscription notice/album handoff, only the exact typed rejection produced by that handoff's
   own final `beforeSend` callback may finish without dispatch. Exact source GET 404 is unavailable
   notice authority, not proof of deletion. Preserve the feature/violation evidence, release the
   owned notice lease and record neither delivery coverage nor a deletion. Source 503, member GET
   404, lease loss, attempted/ambiguous mutations and a failure after successful authorization
   remain fenced. Never convert arbitrary errors to PROCESSED or rerun a started whole engine.
   A one-shot public Start confirmation explicitly settles its immediate failure in the action
   ledger because the command retains no SEND continuation. It must not wait for stale-orphan
   repair to acquire a completion timestamp. Default immediate callers keep their existing
   recovery ownership; successful receipts and ambiguous SEND fences remain monotonic.
   Duplicate-sanction notices also settle their one-shot immediate failure explicitly: their
   original source/lease closure cannot be serialized, and the sanction caller consumes the
   notice failure without retaining a SEND continuation. Preserve the original final authority
   callback, no whole-handler/sanction replay and positive/ambiguous receipts. Cover the actual
   helper and moderation sender with `max-immediate-send-ledger-postgres.spec.ts`, including
   source-authority and local quota refusals; unrelated durable callers retain the default.
   Queued moderation notices may defer the same locked BullMQ job after a genuine local SEND
   admission refusal, only after its exact unattempted dispatch fence is safely released.
   Keep the ordinary HTTP retry budget, original job identity, source proof and deadline.
   Respect Retry-After without shortening it to fit the remaining lifetime. Recheck current
   source, policy, holds and rights on every entry. Missing/malformed notice proofs, borrowed
   GET failures, protected moderation budgets and attempted/ambiguous effects cannot nominate
   this deferral; no whole-handler replay or renewed authority is permitted.
   The inline text-rule follow-up with this attempt's own DELETE reason confirmed enters
   `violation-follow-up.authority` before fresh sanction authorization. A failure there occurs
   after deletion; it is neither a failed DELETE nor permission to replay the handler. Pending
   or rejected DELETE and confirmation of an independent reason retain `violation-delete`.
   This diagnostic stage preserves the existing DELETE-stage timeout/backoff behavior; do not
   add it to the follow-up timeout-backoff suppression set.
   After a successful required-subscription notice/coverage handoff, an exact typed unavailable
   membership result or explicitly scoped pre-handoff source-unavailable result may transfer only its DELETE obligation to the durable intent service.
   Require a committed executable intent with its original source, reason and deadline; missing
   persistence, shadow/off, ambiguous state or lost notice ownership still fails. The worker must
   obtain fresh membership and current policy before deletion. This is neither a DELETE receipt
   nor permission to replay the notification, sanction or original webhook handler.
   In production, a successful post-notice authority check also transfers DELETE to that durable
   worker; never immediately attempt the persisted intent inside the original webhook. The final
   worker check can still fail after persistence. Its SQL retry must remain independent of the
   completed handler, with no fabricated deletion and no renewed deadline.
   A typed source GET transport timeout or unavailable fresh membership before notice handoff may defer to the already-guarded
   SEND action only with the exact serialized proof, original deadline and renewed notice lease.
   The handoff must succeed before coverage or DELETE admission; source-read deferral never proves
   delivery or deletion. A post-handoff source transport outage requires a committed executable
   DELETE intent. Keep HTTP errors, attempted mutations, sanction qualification and lost
   leases fenced. At the fresh initial leader boundary, before violation claim or any sanction,
   typed unavailable membership/source transport may finish without effects; retain a fail-open
   diagnostic, prevent active-mute fallthrough and never reuse this exception after effects begin. Test real queue persistence, continued same-chat progress and final worker
   refusal while the source remains unknown or membership/policy/deadline has changed.
   A genuine invocation-owned initial membership/author/source local quota refusal must instead
   retain the exact durable candidate before completing this no-effect handoff. Initial author
   or source HTTP 429 also needs its one-use actual-GET proof from MaxClient, bound to the bot and
   exact lookup, and the guard's source/policy/original-deadline witness. Copied errors, generic
   status fields, protected muted-user budgets and attempted/unknown effects cannot nominate it.
   Registration or lease failure cannot silently complete the transfer. Preserve the original
   five-minute deadline and never replay the started webhook. See
   [initial subscription continuation](required-subscription-continuation.md).
   For legacy inline DELETE, a genuine marked `max_action_executor_proof_rejected` may try
   the next already eligible candidate only before any attempted/ambiguous mutation. Bound the
   candidate pass, preserve the final executor check and report all-refused as unsuccessful
   deletion, with no strike/sanction/notice. Never infer permission loss from proof supersession.
   Keep following same-chat progress and unknown-effect fences in the full-path regressions.
   Direct channel decoration may finish the webhook after a genuine marked executor-proof
   rejection before its first PUT only when an exact live-lease CAS retains the existing
   `IN_PROGRESS`/`edit_message` marker for background recovery. It records no delivery or
   successful edit. Recovery rechecks current channel access, policy, source holds and marker
   ownership. Forwards, quick-button rewrites, failed persistence, lost leases, forged errors
   and attempted/ambiguous edits do not qualify. Historical started handlers never inherit
   this new handoff retroactively. Run channel-button, marker-store and native moderation
   guards full-path suites, including following-channel progress and access-loss/hold refusal.
   A concrete local quota refusal in the initial channel bot-access GET may nominate only
   that exact chat/candidate for a direct webhook edit handoff. Persist the live pure-edit
   marker and release its exact lease before completing the handler. This nomination grants
   no bot rights or successful edit; recovery rechecks current policy, source holds and access.
   Keep forwards, quick buttons, polling callers, forged/HTTP/conflicting-method failures,
   attempted effects, existing foreign leases and failed commits fenced. The existing bounded
   channel recovery cadence remains unchanged; this handoff prevents the next post from being
   blocked but does not prove that button recovery meets a latency target. Run the route-scope,
   channel-button, marker, recovery and native moderation-guards full-path regressions.
   Exact channel-post demand reads cannot revoke channel or administrator grants from a
   message lookup error, including chat-shaped 403/404 responses. Retain the failed hint and
   deadline and verify following-post progress. Native regressions must install the real
   lifecycle writer; an omitted optional dependency cannot prove preservation of access.
   Channel-demand parent scheduling follows the earliest retained child after both success
   and read failure, with a floor at the end of that pass so a hot channel rotates behind
   other due channels without postponing its children. A unique new post may wake it inside the receipt transaction; mirrors
   preserve existing retries. Keep parent-before-child locks, source expiry, exact reservation
   CAS precision, scoped MAX cooldowns and bounded attempts. Old unavailable-source backoff
   cannot settle a receipt or authorize an edit. Run native demand races/plans and moderation
   full-path cases for an old 404 followed by a fresh post, current access/holds and mirrored
   arrivals and a hot backlog competing with quiet channels; a queue-only mock cannot prove
   those boundaries.
   A source-author member GET with explicit GET provenance and HTTP 429 may use only the
   existing initial no-effect, durable SEND or committed DELETE handoff boundaries above.
   A concrete local `MaxApiInternalRateLimitError` from that author GET or exact source GET
   may use the same boundaries only before transport, without an HTTP response, conflicting
   method or mutation evidence. Copied error code/name fields do not qualify.
   Ordinary, transferred and initial duplicate-source DELETE retries retain the maximum
   validated Retry-After hint from headers, body and error causes as a lower bound alongside
   their existing exponential backoff. Malformed and overflowing hints are ignored. A hint beyond
   the original deadline expires an unattempted intent; it never renews authority. Keep the existing
   return/throw and handoff qualification, fresh checks and unknown-effect fences unchanged.
   An ambiguous exact-presence read receiving HTTP 429, a concrete local rate-limit error or
   5xx retains its dispatch marker and schedules a durable retry without access refresh or
   peer-bot probes. These failures prove neither message absence nor lost bot capabilities.
   Timeout reconciliation keeps its existing peer route and uncertainty fence.
   Final workers still require fresh author rights; other HTTP statuses, mutation markers,
   missing GET provenance and non-handoff qualification remain fenced. Run subscription
   guard/notice tests and native moderation guards with real queue persistence.
   If an immediate DELETE omits `executeAt` but retains an already elapsed explicit
   `retryUntilAt`, normalize its schedule to that same deadline and create `EXPIRED`.
   A conflicting existing intent retains its real status, schedule, retention ownership
   and reasons under the unique-row lock; expired incoming authority cannot modify it.
   Never renew the deadline, dispatch an expired action or accept an explicitly inverted
   schedule. Verify native expiry between qualification and persistence, zero effects and
   following same-chat progress.
   Ordinary guarded user-message rules use `DURABLE_USER_DELETE_RULES` independently of the
   legacy base canary. Keep writer, exact-row reason classification and correlated due-sweep
   eligibility aligned; base historical-cleanup recovery and independent OCR/duplicate/retention
   ceilings must not expand with them. A built-in pre-dispatch guard outage may finish the inline
   caller only after exact live-lease retry CAS with no mutation evidence and the original deadline.
   A caller callback failure or failed commit cannot take this path. Unknown DELETE outcomes remain
   fenced durable work, never a successful deletion or sanction receipt. Run the native canary,
   shadow and off timeout/next-event cases, source retry, closed-chat execution and retained-history
   due-plan regressions; on-only fixtures cannot prove production rollout behavior.
5. **Observation is not execution.** A PROCESSED receipt can be a dormant-bot observation.
   Exclude only its exact validated marker with no linked claim; preserve the semantic anchor and
   every independent replay fence. `bot_added` must not demand an ordinary live executor or
   perform passive activation. Keep exact receiving-bot identity and the explicit denylist path.
   Legacy source classification tolerates at most 1,000 ms of MAX clock lead, keeping the
   successful migration cutoff and all source/receipt/deadline values unchanged. Previously
   installed legacy holds cannot become executable through this tolerance. Pristine
   nonordered removal mirrors (`user_removed`, `message_removed`) inherit their exact
   unprepared owner's pending no-replay marker under claim-before-receipt locks, rather
   than retrying forever as RECEIVED. No completion, abandonment or effect receipt is created.
   Run `webhook-legacy-authority.spec.ts`, native `webhook-legacy-membership-mirror-postgres.spec.ts`
   and `webhook-outbox-postgres.spec.ts`; include active lag before/after, stale-CAS refusal,
   competing propagation, independent claims and excessive/old/unknown source timestamps.
6. **Cancellation preserves authority and user data.** Use the
   [backlog cancellation protocol](webhook-backlog-cancellation.md) only for an authorized fixed
   scope, with compatible readers throughout the fleet. Retain connected chats, settings,
   statistics, publications, original receipts/errors, claims and ambiguous actions. CANCELLED
   is abandonment, not success. Never use Redis FLUSH/obliterate, delete claims, expire unknown
   effects or fabricate completion to clear SQL ordering. Existing holds remain in force. Keep object and SQL cancellation readers aligned: message-family
   tombstones apply to created/edited content; exact semantic cancellation covers every type.
   Fresh removal observations and new menu clicks cannot inherit an unrelated message-family
   cancellation. Verify the final READY/start transition as well as early admission.
   Exact v2 recovery requires a separately hashed read-only nomination/preview, installed-client
   identity and full stopped revalidation. Preserve the fixed observed scope and original
   snapshots across interruption. Prove operation absence independently before an unwritten
   abort restores the same fleet; a written operation retains its STOPPED exact-resume fence.
7. **Resume exactly.** An interrupted cancellation retains its UUID, cutoff, source/image and
   journal. Resume the identical request. A new operation requires the previous one COMPLETE and
   its exact completed journal archived privately by the controller. Preserve lossless BullMQ
   snapshot encoding (`BULLMQ_JOB_JSON_UTF8_BASE64_V1`); PostgreSQL JSONB cannot represent every
   JavaScript string. A missing Docker object is failed inventory proof, not evidence of ownership.

## Operational lag and executor waits

Raw receipt age stays visible for both RECEIVED and QUEUED. An exact enforced
`EXECUTION_WAITING` checkpoint may measure lateness from the earlier of its saved
next-enqueue time and original deadline only while the canonical owner is unstarted,
uncompleted and has neither lease field. PENDING is valid only before RECEIVED
preparation; READY also requires a saved preparation timestamp. The receipt, semantic
key, authority version and deadline must match. No health read changes execution authority.

The queued next-enqueue timestamp comes from the outbox's positive delayed-job
reconciliation; it schedules a repair check, not the actual BullMQ retry. Without that
saved schedule the raw age remains. An advancing repair check cannot hide an overdue
original deadline. Unknown proof, unrelated work and ordered successors keep raw
pressure; a timeout, unavailable bot or quarantine is not successful moderation.

Each status is queried only when its oldest receipt has retry/deadline metadata, with
65 indexed heads and an undiscounted sentinel per status (at most 130 total). Keep both
native retained-history plans, malformed/leased/started/expired negative cases, raw
metrics and the real canonical → BullMQ delay → outbox reconciliation regression in
`webhook-operational-lag-postgres.spec.ts`, `queue-metrics.service.spec.ts` and
`webhook-membership-readiness-fullpath.spec.ts`. Also run executor deadline/access
restoration and governor/health regressions before changing this classification.

## Minimum regression coverage by change

Dependency quarantine changes additionally require native
`webhook/webhook-dependency-quarantine-postgres.spec.ts`: final independent completion,
no parked/expired starts, no original replay, claim/start races, exact completion recovery,
restart, repeated blockers and bounded indexed reconciliation. Its required CI lane and
reader-before-writer rollout are described in [the quarantine runbook](webhook-dependency-quarantine.md).

Advisory routing-metrics deadlines also require `webhook-routing.service.spec.ts` and native
`webhook-multibot-fullpath.spec.ts`: persisted shard pinning, independent progress, one underlying
observation after timeout, and no started-handler replay. Saved command-notice waits use only the
typed preparation retry boundary; uncertain SEND failures stay fenced.

These are existing executable regressions, not substitutes for required impact checks or exact-SHA
CI. Paths in the table are relative to `apps/api/src` except the explicit `infra/` path. Run the
rows affected by a change; do not rerun unrelated suites for a documentation-only edit.

DELETE recovery retains the entire existing due head of size `B` on every sweep. When that
head is full, confirmed Redis job reuse funds one additional continuation page: at most `B`
raw keys across five status lanes, sought through `(status, created_at, id)` before current
eligibility and exact-key lock checks. The fixed creation horizon forces each lane to wrap;
small budgets rotate between lanes. No SQL state, deadline, lease or effect authority changes.
Per sweep, pre-observations are at most `2B`, insertion-proof reads at most `B`, and attempted
adds at most `B`, including failed or uncertain adds. Selected-row metrics/return values may
therefore reach `2B`; they never prove execution or successful deletion. A tail add failure
remains durable due work and is revisited after wrap; it cannot freeze independent lanes.
Head job loss still receives the next-sweep repair. Tail progress is conditional on available
confirmed reuse and has a separate cycle bound, not a one-second fleet-wide guarantee.

| Change                                      | Required evidence                                                                                                                                                                                        | Existing regression                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DELETE due recovery continuation            | Missing tail job behind a paused existing head; next-sweep head repair; raw/PK bounds under ties, rejects and locks; finite wrap, tiny budgets and failed handoff isolation                              | `moderation/moderation-delete-due-postgres.spec.ts`, `moderation/moderation-delete-continuation-postgres.spec.ts`, `moderation/moderation-delete-due-selection.spec.ts`, `moderation/moderation-delete-intent.service.spec.ts`, `moderation/moderation-delete-intent-handoff.redis-integration.spec.ts`                                                              |
| Manual command scheduling/queue namespaces  | A command starts while background work is blocked; aggregate manual concurrency stays two; retained old commands drain without duplicate enqueue; lookup/enqueue failure causes no inline sanction       | `admin/admin-manual-command.redis-integration.spec.ts`, `admin/admin-group-command-reliability.spec.ts`, `infra/scripts/bot-publisher-reliability-rollback.test.mjs`                                                                                                                                                                                                 |
| Immediate one-shot SEND settlement          | Failure completes immediately only with explicit one-shot policy; default continuation, exact positive receipts and ambiguous dispatch fences survive                                                    | `max/max-client.service.spec.ts`, `max/managed-entity-handshake.service.spec.ts`, `max/max-immediate-send-ledger-postgres.spec.ts`                                                                                                                                                                                                                                   |
| Queued notice capacity deferral             | Same locked job keeps identity, timestamps and ordinary attempts; independent work proceeds; original proof expiry, current guards and uncertain effects remain fenced                                   | `max/max-action-send-capacity.spec.ts`, `max/max-action-send-capacity-postgres.spec.ts`, `webhook/webhook-multibot-moderation-guards-fullpath.spec.ts`                                                                                                                                                                                                               |
| Notice authority/callback/handoff           | Own pre-dispatch rejection finishes without send/delete/coverage; 503, member 404, lease and attempted-send failures stay fenced                                                                         | `moderation/required-subscription-notice-recovery.spec.ts`                                                                                                                                                                                                                                                                                                           |
| Any change to that notice outcome           | Real persisted source 404 finishes, source 503 stays fenced, evidence survives, next same-chat event progresses, handler never replays                                                                   | `webhook/webhook-multibot-moderation-guards-fullpath.spec.ts`                                                                                                                                                                                                                                                                                                        |
| Initial subscription read continuation      | Membership/author/source quota boundaries, nominal actual-GET 429 proof, durable owner across restart, atomic own decision, original deadline, media leader, no unknown punishment, notice before DELETE | `max/max-client.service.spec.ts`, `moderation/required-subscription-execution-guard.service.spec.ts`, `moderation/required-subscription-candidate-workflow.spec.ts`, `moderation/required-subscription-candidate.service.spec.ts`, `moderation/required-subscription-candidate-postgres.spec.ts`, `webhook/webhook-multibot-subscription-candidate-fullpath.spec.ts` |
| Post-notice membership outage               | Durable DELETE handoff survives queue failure; next same-chat receipt finishes; resumed deletion checks membership/policy and never repeats the notice or handler                                        | `moderation/moderation.service.required-subscription.spec.ts`, `webhook/webhook-multibot-moderation-guards-fullpath.spec.ts`                                                                                                                                                                                                                                         |
| Inline duplicate explanation budget         | Confirmed deletion preserves the remaining explanation budget; critical sanctions stay awaited, and mirrored/following receipts finish without replay while the explanation waits                        | `moderation/moderation-message-duplicate-budget.spec.ts`, `moderation/message-duplicate/message-duplicate-initial-dispatch-postgres.spec.ts`                                                                                                                                                                                                                         |
| Outbox writes, ordering or retention        | One SQL statement per atomic write, one CAS winner, no-op JSON does not rewrite a tuple, no started-engine replay; bounded retained-history work                                                         | `webhook/webhook-outbox-postgres.spec.ts`                                                                                                                                                                                                                                                                                                                            |
| Polling, admission or prior-execution proof | Slow/blocked hot chat does not starve quiet chats; selection refills slots; dormant observations do not suppress valid execution; correlated probes stay indexed                                         | `webhook/webhook-fleet-admission-postgres.spec.ts`                                                                                                                                                                                                                                                                                                                   |
| Preparation capacity/reservations           | Per-bot/class fairness, lifecycle/interactive reservations, rejection without an in-memory waiting backlog and actual shutdown drain                                                                     | `webhook/webhook-preparation-admission.spec.ts`                                                                                                                                                                                                                                                                                                                      |
| Nonordered semantic mirror isolation        | Actual removal preparation parks only pristine exact copies of a started terminal owner; null deadline, effects and claims survive; races and restart never replay the handler                           | `webhook/webhook-nonordered-mirror-quarantine-postgres.spec.ts`, `webhook/webhook-dependency-quarantine-postgres.spec.ts`, `infra/scripts/semantic-mirror-quarantine-rollback-guards.test.mjs`                                                                                                                                                                       |
| Executor readiness deadlines                | Immutable source/receipt bounds; missing title/join deadlines reconstructed; no-business expiry, late access without replay, independent-chat progress and retained execution fences                     | `webhook/webhook-execution-deadline.spec.ts`, `webhook/webhook-membership-readiness-fullpath.spec.ts`, `webhook/webhook-multibot-access-restoration-fullpath.spec.ts`, `webhook/webhook-multibot-fullpath.spec.ts`                                                                                                                                                   |
| Bulk cancellation selection/snapshots       | Terminal FAILED history and tied timestamps remain bounded; Unicode snapshots survive; interruption resumes; uncertainty and publications survive; fresh same-chat work progresses                       | `webhook/webhook-backlog-cancellation-postgres.spec.ts`                                                                                                                                                                                                                                                                                                              |
| Cancellation controller/journal             | Interrupted identity is immutable and a completed journal is archived before a new request                                                                                                               | `infra/scripts/backlog-cancellation.test.mjs`                                                                                                                                                                                                                                                                                                                        |
| Exact cancellation v2                       | Read-only bounded preview, exact family/child attribution, immutable scope, interrupted capture/projection/retirement and same-generation unwritten abort                                                | `scripts/cancel-webhook-backlog-v2-postgres.spec.ts`, `infra/scripts/backlog-cancellation-v2-host.test.mjs`, `infra/scripts/backlog-cancellation-routing.test.mjs`                                                                                                                                                                                                   |

Inline duplicate callbacks retain the caller's in-memory hot-path profile; only confirmed deletion
supplies its success boundary. Background jobs keep their lease and awaited follow-up. Durable
request/job payloads never contain the profile.

For notice/handoff changes, run **both** the focused unit suite and the full-path native suite;
name-matching only `required-subscription` misses the integration expectation that exposed this
incident. Use Node 24 and the public wrappers, sequentially:

```bash
npm test --workspace @maxim/api -- 'required-subscription|moderation-execution-guard-callbacks|moderation-action-executor-recovery'
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- webhook-multibot-moderation-guards-fullpath
```

For selection/admission or cancellation changes, choose the corresponding command:

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- 'webhook-outbox-postgres|webhook-fleet-admission-postgres|webhook-preparation-admission'
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- webhook-backlog-cancellation-postgres
node --test infra/scripts/backlog-cancellation.test.mjs
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- cancel-webhook-backlog-v2
node --test infra/scripts/backlog-cancellation-v2-host.test.mjs infra/scripts/backlog-cancellation-routing.test.mjs
```

The PostgreSQL Races CI lane already includes the native suites above. Report actual passed/skipped
counts and store availability; a mock-only pass is not native-store coverage. Never delete or weaken
a failing fence assertion to obtain green CI. An intentional outcome correction must retain the
negative cases, effects evidence and following-event/no-replay checks.

## Fast incident response and acceptance

- Capture one bounded baseline with exact UTC interval and runtime source/image, then compare ingress,
  SQL selection, preparation, ordering/retry waits and actual action outcomes using the
  [incident playbook](../../incident-playbook.md). A saved error, busy preparation pool or raw oldest
  age alone does not identify a cause. Diagnose changed failure families after a fix separately.
- Correct the reproduced cause and preserve independent capacity. Size concurrency from useful
  throughput and database pressure, not slot saturation alone. Repeated per-chat cold stops are not
  an efficient fleet reset; when abandonment is authorized, use the compatible bounded bulk protocol.
- After one rollout readiness timeout, inspect the current exact fleet, fence and queue trend.
  Do not repeat an unchanged deployment, repeatedly move a cancellation cutoff, lengthen readiness
  just to pass, or kill an unverified process. Preserve the typed journal and shared deploy lock.
- Normal delivery requires green exact-SHA Required and CodeQL through the guarded wrapper. An
  incident's recorded emergency exception is not authorization to bypass the connector next time.
  If the exact fleet already converged, use the guarded recovery finalizer after strict smokes;
  do not recreate healthy roles to apply a test-only fix or merely repair manifest bookkeeping.
- Measure only **closed** receipt-created cohorts: `from < until <= observedAt`. Include every
  status, pending/failed counts and ages, cap/truncation, missing samples and invalid-clock counts.
  Label completed-only percentiles as such; report PROCESSED separately from DUPLICATE/CANCELLED.
  An empty or future window is not success. Measure remote actions separately from receipt settlement.
  When that 30-second window saturates, use `postgres-audit webhook-cohort --short --explain`
  before `postgres-audit webhook-cohort --short`. This fixed five-second window still ends
  30 seconds before observation and preserves every status and all existing query/row limits.
  `window_seconds` identifies its narrower scope; it must independently be nonempty and complete.
  Preserve the saturated report, compare like-duration cohorts, and never extrapolate the
  short sample to the omitted interval or label its successful receipts as remote-effect proof.
  Use `postgres-audit webhook-cohort --explain` before the fixed `postgres-audit webhook-cohort`
  report. Its 30-second interval ends 30 seconds before observation; each of all eight statuses
  has a 512-row cap with a saturation sentinel. It reports invalid completion/enqueue clocks,
  pending age and processed-only latency without returning event identities or payloads.
  Schema v2 also groups the same bounded FAILED samples into fixed saved-error families,
  with retry/quarantine metadata and deadline counts at receipt and observation. These are
  diagnostic markers, never proof of no effects or permission to replay; unknown text stays
  `other`. Failure-family counts inherit the FAILED row's truncation/completeness limit.
  Repeat closed samples across the observation window; one cohort is not sustained acceptance.
- Distinguish future delayed schedules, current retryable DELETE work and retained terminal
  failures from overdue executable backlog. Compare due time, active lock/runtime age and bounded
  movement across snapshots; queue creation age or a nonzero queue count alone is insufficient.
  Do not empty every namespace merely to make a dashboard show zero.
- Adaptive default-shard routing includes BullMQ `prioritized` work in queue and worker pressure.
  Use the snapshot's actual shard owners for pressure, cached-chat counts and rebalance decisions;
  aggregate at most the fixed shard counters, never scan the full chat-assignment cache.
  Persisted outstanding same-chat work still pins its existing shard across ownership handoff.
- Separate API-role stability from native sandbox containment. `probeApiFleet.totalRestartCount`
  includes auxiliaries: classify fixed lifecycle reasons, exact times and OOM/health state before
  drawing conclusions. A mandatory native timeout recycle is not proof of a stalled webhook
  queue or healthy OCR throughput. Preserve a failed zero-restart monitor result; use a separate
  stable runtime observation and the guarded finalizer, never container recreation to reset counts.
- Diagnose a log location against the exact image's built JS or matching source map, not the same
  line number in TypeScript. Distinguish a pre-dispatch limiter rejection from an attempted/unknown
  MAX mutation; neither authorizes whole-handler replay. Record unclassified errors as unresolved.
- `COMPLETE`, HTTP 200 and container uptime are separate from recovery. Require exact images,
  released queues, healthy dependencies, fresh event progress and action outcomes. The prolonged-
  backlog acceptance remains at least 15 continuous minutes with lag below 10 seconds under the
  [recovery runbook](bot-reliability-recovery.md#capacity-and-acceptance). Short healthy samples
  justify a sampled improvement report, not full acceptance or a guarantee for every bot/product.
