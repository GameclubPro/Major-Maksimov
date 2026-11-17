# Initial subscription check continuation

An initial membership, author or exact-source GET refused by the local MAX quota limiter may retain an exact
`required_subscription_candidates` SQL owner. Registration does not establish a violation,
authorize a sanction, deliver a notice or delete a message. It does not replay a started webhook.
The in-process lookup result must carry the invocation's nominal provenance; shared diagnostics,
copied error codes, JSON copies, unrelated users/bots and late superseded probes cannot nominate it.
Muted-user protection refusals cannot nominate a continuation or bypass their separate budget.

An initial author/source HTTP 429 requires consuming the one-use MaxClient proof of the actual
GET failure, bound to its selected bot and exact chat/user or chat/message lookup. The guard then
binds that invocation to the original source, policy and deadline. A shared diagnostic association,
an error constructor or status/method fields alone cannot authorize registration. Copies, unrelated
lookups, expired proofs, 404s, timeouts and attempted or ambiguous mutations do not qualify.
The initial leader awaits registration and rechecks its lease before completing without effects;
store or lease failure must not become a successful handoff.

Required-subscription membership reads honor the target's current read route before cache use.
A refused route remains unknown: it cannot fall through to the default bot or reuse a retained
negative membership, even when bot-scoped caching is disabled. This matches the queued notice's
final target check and avoids creating work that it must reject. A missing route carries no
local-quota provenance and cannot nominate a new candidate; an existing candidate retains its
original deadline and unavailable-read retry. Independent receipts continue without sanctions.
Coverage includes `required-subscription-routing.spec.ts` and the native restart case below.

The source envelope retains the original event time and absolute five-minute deadline, policy
fingerprint, bot observation, message/author and media scope. It contains a bounded masked excerpt,
never the raw message. Registration conflicts preserve the first source and all existing effects.
Existing historical violations and uncertain effects are not backfilled into this owner. The
existing active-mute path is outside this initial-check continuation; a mute flag alone cannot
authorize a durable candidate or prove an applied sanction.

Only the action role discovers candidates. SQL discovery rotates indexed status pages with a
shared four-row budget; a renewable thirty-second lease fences each attempt. Loss of a process,
timer or wake-up retains the SQL obligation. Shutdown freezes discovery and drains admitted work
before stores close. A lease or store failure is not permission to complete another owner's row.

Before a new decision, the executor rechecks current policy, exact source, author/admin rights,
immunity, holds and required memberships. Unavailable reads retain a bounded retry. Confirmed
membership or revoked authority produces no new effects. The existing media coordinator arbitrates
the package leader before a claim: followers can use exact notice coverage without another strike.

The candidate's own message claim, violation, count and frozen decision commit together. Existing
or legacy claims cannot be adopted. The frozen decision retains action, issued time, deterministic
event ID and mute expiry. Recovery uses the existing sanction journal and shared member-state lock;
a started BAN requires its exact action ledger. A missing ledger is unknown, never proof that
another BAN is safe. SQL settlement honors newer manual releases. Expired started effects may
settle exact receipts but cannot authorize new effects or renew the source deadline.

A successful notice handoff or exact media coverage must precede executable DELETE intent
persistence. Each handoff needs its own matching receipt; a generic boolean, a pre-send refusal
or a revoked delete guard is insufficient. The first DELETE transfer receipt remains immutable
when the same intent's downstream status changes. The normal SEND and DELETE workers retain their
final source, policy, membership, bot capability and uncertainty guards. Candidate completion means
the DELETE obligation transferred; it does not mean remote deletion succeeded.

The migration creates an empty additive owner table. Ordinary rollout uses the shared API image
for every role and both auxiliaries, preserving stores. It needs no historical replay or live
database repair. Existing standard notice/delete jobs keep their established compatible envelopes.
An application rollback leaves candidate rows intact; an image without this worker cannot claim
they were processed. Never drop the table or clear its unknown rows as rollback cleanup.

Regression evidence lives in `required-subscription-candidate-workflow.spec.ts`,
`required-subscription-candidate.service.spec.ts`, `required-subscription-candidate-postgres.spec.ts`
and native `webhook-multibot-subscription-candidate-fullpath.spec.ts`. Also run the subscription
notice recovery and native moderation-guards cases selected by the
[latency regression matrix](webhook-latency-prevention.md#minimum-regression-coverage-by-change).
Native tests must use the public test-store wrapper; mocks do not prove lease/claim races or
durable queue transfers. A quiet production sample does not prove every violating message was
covered or that MAX will never return another 429.
