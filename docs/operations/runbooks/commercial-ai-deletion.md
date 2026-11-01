# Commercial AI deletion

This page describes the legacy workstation/server cascade and shared deletion
guards. The optional three-node pool has separate registration and routing flags,
an explicit 4B policy and durable source version 2; see the
[pool rollout and recovery runbook](commercial-ai-pool.md). With pool routing off,
the legacy cascade below remains selected. Rollback retains both source readers
regardless of flags.

`COMMERCIAL_LLM_ENFORCEMENT_ENABLED=true` replaces only `COMMERCIAL_AD` text-rule
verdicts in opted-in chats. The local workstation 4B model runs first. Commercial
and uncertain answers require the pinned server 9B model; unavailable primary also
falls back to that server within the original budget. Audited disagreement with a
primary negative stays KEEP. AI never bans, mutes, sends notices or increments a
sanction ladder. Commercial image OCR remains removed. Other moderation rules
retain their own authority.

## Admission and failures

The background role advertises readiness through a short Redis worker lease.
Readiness is a worker-generation marker with a 2.5-second TTL, retained when an
offer fills the pending slot. Offers never renew it. Pressure withdrawal, expiry
or a different worker generation prevents further admission; readiness does not
replace the separate pending, active-source or primary-model capacity checks.
The version-3 pending mailbox keeps a FIFO head and at most one additional pending
input. The additional input requires a schema-valid, current head from the same
worker, no running primary, at most one active source and no more than 250 ms of
primary cooldown. Both planned starts must fit their original three-second
admission limits, including polling reserves. A cooldown without a bounded TTL,
an invalid or changed head, or insufficient remaining time refuses the extra input.
This smooths feasible short bursts; it does not add model concurrency or capacity
for sustained overload. There is at most one pending input per chat and at most three
active sources. A chat may retain at most two distinct active messages, allowing
another primary check after its previous primary finishes while confirmation is
still pending. Atomic offer and take checks reject a pending or running primary
from the same chat, repeated message IDs regardless of nonce, and the per-chat
bound. A separate bounded Redis reservation permits only one running or waiting
server confirmation per chat, including negative audits. Exact source and worker
checks survive connection replacement; obsolete cleanup cannot release another
source's reservation or proof. The process separately retains at most one waiting server confirmation;
the shared server lease permits one actual server request. Waiting for confirmation
must not block unrelated primary negatives. Admission is fire-and-forget on a
separate fail-fast Redis connection, with one in-flight admission per producer.
Taking or discarding the FIFO head atomically promotes the exact pending tail,
preserving its submitted time and absolute expiry. New arrivals cannot pass it.
Every take still enforces the original three-second limit; a slow first check may
cause the second input to expire without inference. Expiry remains a discard,
not a completed classification. These buffers are temporary admission state, never historical replay or a second
execution authority. Rejected admission has a finite reason.

Only the pending keys use the version-3 namespace. Worker generation, active-source
authority, primary and secondary reservations, cooldown and discard metrics retain
their shared version-2 keys; issued proofs and status retain version 1. A mixed
reader cannot consume the new pending encoding or reset the shared model fences.
Roll out through the normal producer quiescence and old-worker shutdown/drain;
old pending inputs are not copied or replayed into the new namespace.

The workstation's atomic two-second admission interval and the server's shared
ten-second lease/cooldown remain separate. A primary positive or uncertain answer
requires the pinned server confirmation; a busy server may retain only its bounded
unexpired confirmation work. The primary verdict must not be recomputed to retry
confirmation. Confirmation waiting spends the original inference budget and
reserves six seconds for server work; it never increases model concurrency or
the server rate. Random negative audits use the immediate shared server lease and
never occupy the waiting confirmation slot. If that optional audit alone returns
`BUSY`, the completed primary negative is retained with its original 4B identity
and `auditOutcome=capacity_skipped`, after fresh abort and source-ownership checks.
This is not a completed audit. Other audit errors, cancellation and authority loss
still fail closed; positives and uncertainty still require server confirmation.
The runner permits classification during an automatic stabilization window only
when the governor's fresh queue and host checks allow `run`. Active MAX or mixed
degradation, manual maintenance, queue pressure, CPU/IO pressure and background MAX
traffic pressure still pause admission. Recovery must not require an uninterrupted
normal-mode window before advertising model capacity. Final source-bound deletion
checks remain independent of admission. The governor and 12 GiB headroom guard remain.
Busy, absent,
pressured, stale, oversized, uncertain and failed work cannot authorize deletion.
Actual rates can be lower than the admission limits: this is **partial traffic
coverage**, not a promise to classify every message. Failure leaves that message
to independent moderation rules. Previously queued SHADOW observations never
authorize deletion and the SHADOW runner stops in enforcement mode.

Inputs must be complete text of at most 2,500 characters from an exact active
canonical message source no older than ten seconds. Contacts are sanitized before
inference. Pending work retains its three-second admission/start limit, inference
retains its original 20-second budget, and effects expire 60 seconds after the
original event clock. Moving between buffers never renews those clocks. Pending
work from a different worker generation is discarded without inference. One
successful, exact model/prompt/runtime/cascade result creates a source-bound Redis
proof with the same absolute expiry.

## Triage and quality evidence

`commercial-ai-triage-shadow-v1` always returns `NEEDS_AI` and
`verification=unvalidated`. Existing exact `COMMERCIAL_AD` evidence, a boolean
`reviewRecommended` marker or bounded broad commercial-language matches may mark
the source `suspected_ad`; other sources retain a `normal` hint. Both are shadow
telemetry only and do not change buffer admission or scheduling. The output has
finite fields, without text, contacts or arbitrary reason strings. Buyer requests,
quoted advertisements and ordinary discussion may match too. A missing signal
never proves a safe message and must not bypass AI.

There is no active `VERIFIED_KEEP` shortcut or new model-confidence threshold.
The existing primary-negative audit behavior and its KEEP result on disagreement
remain unchanged. `UNSURE` is an uncertain classification, never a measured
negative or permission to delete. Report uncertainty separately from actual
negative results, capacity skips and technical failures.

The existing review/corpus pipeline supports independently reviewed, complete
sources and a stable random evaluation frame. Its current deterministic snapshots
and SHADOW observations do not establish AI triage accuracy or link every AI effect
to a reviewed sample. Before proposing a KEEP shortcut, collect separate frozen
AI/triage identities, complete source and sampling provenance, independent labels,
and author/campaign/time-separated evaluation. Report missed advertisements,
protected negatives, uncertainty and technical gaps separately. Applicable
acceptance criteria must be reviewed before evaluation; the existing deterministic
promotion thresholds are not an AI approval. See the
[quality collection runbook](commercial-quality-rollout.md). No accuracy gate is
claimed from synthetic examples or unlabelled production results.

## Durable effects

The new `COMMERCIAL_LLM_DELETE` reason enters the existing DELETE journal only
through that proof-bound child handoff. It preserves the original webhook receipt,
receiving/execution bot and event time in `moderation_delete_reason_origins`; it
cannot revive the canonical handler or attribute another target/rule. The ordinary
holds, executor checks and unknown-effect fences remain active. Registration with
an unknown result is reported as `registration_unknown`, never retried as inference.

Every actual DELETE checks the current settings fingerprint, exact current MAX
message/text/author, regular-member access, bot/admin and participant immunity,
proof and absolute deadline. Changed content, disabled settings, missing proof,
uncertain rights and expiry reject AI authority. That rejection permits another
independently verified reason to progress. Final SQL/transport deadline fences
remain active. Exact absence is settlement, not an AI deletion or sanction.

After the remote source read, AI enablement, exact current settings, proof and the
original deadline are checked again before consuming participant protection. An
expired or revoked AI reason cannot spend the daily allowance. The final dispatch
check remains independent and does not repeat remote reads or grant consumption.
AI delete-only settings require message rights; retained inactive commercial
warning/mute/ban settings do not require member-management rights. Other enabled
rules keep their own requirements, including ordinary and bulk settings writes.

## Delivery and rollback

Use `MAXIM_COMMERCIAL_LLM_ENFORCEMENT=true` (or `false`) on the normal exact-green
`./infra/scripts/vps-connect.sh deploy main --auto` invocation. This caller-only
switch selects all fourteen API roles even on the same SHA. Under the shared
lock and durable release journal, all webhook producers quiesce before atomic
canonical `.env` mutation and recreation. The connector verifies Compose and all
fourteen running environments. Stores are never recreated. The UI receives the
configured `DELETE_ONLY`, `OBSERVE` or `OFF` capability; this is not a live health
indicator. Unknown capability retains the existing text-rule controls.

Both API rollback paths and connector bootstrap require the new AI source/proof/
deadline guard, in addition to preceding reader floors. Disabling the flag does
not make an older reader compatible. Use a compatible fix-forward if no retained
image meets the floor. Never clear intents, proof history or other queues.

## Evidence

Real-store tests cover concurrent bounded admission, source lineage, exact guarded
DELETE, changed text/settings/immunity, dependency failure with another reason,
late/foreign-worker results and unknown DELETE fencing. These are functional fault
checks, not model accuracy measurements. The current readiness report has **zero
independently labelled real samples**; synthetic cases and SHADOW outcomes do not
establish precision or recall. Keep that limitation explicit during rollout.

`commercial-ai-admission` schema v3 separates ineligible sources from eligible
admissions: `offered = ineligible + eligible` and
`eligible = accepted + skipped + unavailable + inFlight`.
Disabled chat settings, missing authority, empty/oversized text, invalid/stale
clocks and unsanitized contacts have separate finite reasons.
Producer saturation remains `producer_busy`. Mailbox admission separately reports
`no_worker`, `not_ready`, `buffer_full`, `chat_busy`, `active_limit`, `source_stale`,
`source_expired` and `worker_changed`; success is `accepted`. Pending-discard
counters separately report `pending_expired`, `foreign_worker` and
`invalid_pending`. They persist in the Redis v2 namespace across worker generations;
status marks them `pendingDiscardBasis=redis_namespace_cumulative`, separately
from process outcome totals. `chat_busy` includes a pending/running primary from
the same chat, repeated message IDs and the two-active-source chat bound;
it is not a successful duplicate classification. Admission is not completed
inference or a confirmed MAX effect. Independent random `observationProcessId` and `observationStartedAt` identify
each producer/runner generation without exposing its worker lease. Read producer
counters as deltas from the same process and schema; differing first/last sample windows do not form one
complete fleet denominator. The original offered counter included disabled chats
and cannot establish eligible coverage.

Pool pending payloads retain their original three-second TTL. Two fixed bounded
metadata keys keep only the exact worker, payload digest and original expiry so
natural Redis expiry is counted once even after dispatcher interruption. Atomic
take/discard/promotion settles the matching marker; status reconciles elapsed
markers without deleting payloads or acquiring execution authority. A separate
exact-worker capability advertisement enables tracking only for upgraded
consumers. Mixed-version admissions can remain untracked; cumulative discard
counts do not retrospectively close those coverage gaps. Metadata never renews a
source, model lease or effect deadline and never enables replay.

`commercial-ai-admission-window` closes nonempty minutes selected by
`selectionBasis=offers_or_evaluate_calls` once their offered admissions have settled.
Per-window ineligible and skip reasons use the same finite categories as cumulative
counts. `evaluation` counts only calls reaching `evaluate()` while enforcement is
enabled, with one ordered exclusion (missing message, untrusted event time, protected
author or another rule). It is not an ingress denominator. An exclusion-only minute
can have zero offers; an evaluate call and its offer may cross a minute boundary. Its `settled=true` applies to the offers observed by that
process. `observationStartedAt`, `observedFromAt` and `intakeBoundaryObserved`
make a partial first minute explicit; `fleetCoverage=not_established` prevents a
settled process cohort from claiming complete traffic observation. Missing or zero
traffic minutes are not fabricated. Reconcile all expected process observations
and preserve shutdown, restart or log gaps before reporting fleet coverage.

`commercial-ai` records result, cascade route, primary/secondary duration, heartbeat
and last recorded KEEP/UNSURE/registered-DELETE result without raw message text.
`lastSuccessAt` does not include classified positives whose registration was refused
or uncertain; it is not a complete last-classification clock. A retained primary
negative with `auditOutcome=capacity_skipped` is a 4B classification, not evidence
of a successful 9B audit or independently verified negative. The
`commercial-ai-cumulative` record and Redis status expose process totals with
`outcomeBasis=process_cumulative`; they are not closed result windows.
`commercial-ai-secondary` reports `waiting`, `started`, `buffer_full` and
`budget_exhausted` with wait duration. Record work expiry and model stage separately.
A fresh heartbeat
with an old last recorded result is not proof of current throughput; an offline
primary must be visible even when server fallback succeeds. Capacity skips,
uncertain answers, stale-source rejection and technical failures remain separate.
Redis status expires after 30 seconds; missing status is a coverage gap, not proof
of healthy idleness. Record registered intents separately from confirmed MAX
DELETE outcomes.

The closed Safety Desk **Observations → Advertising AI** reads only the fixed runner
status key, atomically capped at 16 KiB before fetching its value. Reads are coalesced
and cached for two seconds; heartbeat freshness and the last governor/headroom check
expire independently after 30 seconds. This check is an admission observation, not
model readiness. The panel labels its manual-refresh snapshot explicitly. It
separates disabled/observe mode, missing, invalid, unavailable and stale observations;
unknown evidence remains null. `lastRecordedResultAt` maps to the limited
`lastSuccessAt` basis above. Legacy status without generation fields remains readable
with an unknown start. No raw source, worker lease, message text or credentials cross
this endpoint. Process totals and namespace discard counters have separate bases;
traffic coverage and confirmed deletes are deliberately not inferred.
The additional owner panel and validated diagnostics raise the total Safety Desk
JavaScript gzip budget from 120 to 123 KiB (measured 122.7 KiB); raw JS/CSS limits
and the 320-byte tolerance stay unchanged. No new browser dependency is introduced.

The sequential `postgres-audit moderation-outcomes [--bot <configured-bot-id>]`
catalog reports exact `COMMERCIAL_LLM_DELETE` events as `COMMERCIAL_AI`, separately
from text rules and retained OCR history. Review its bounded plain `--explain`
first. `DELETE_REMOTE_CONFIRMED` requires a bot DELETE event with the admitted
boolean `moderationDeleteVerified: true` proof. Registration, model verdicts and
similarly named codes never become confirmed AI deletes. The existing 512-event
cap, per-bot index, metadata limits and sample-coverage caveats still apply; this
report establishes neither classifier precision nor full eligible-input coverage.
