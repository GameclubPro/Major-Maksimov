# Webhook dependency quarantine

An unknown started handler retains its original FAILED receipt and error evidence.
Classification accepts the existing pending timeout marker, or an exact enforced canonical
claim with a business start and no completion; generic FAILED text alone is insufficient.
A pending timeout retains its existing chat-order barrier; its ordered successors can
enter `QUARANTINED` only while they are positively unstarted. An ordinary terminal FAILED
owner is not a chat-order head: quarantine only its pristine semantic bot copies, allowing
neighboring and subsequently received messages to follow ordinary processing. Their immutable `(receipt_id, blocker_id)` journal records chat, original status,
deadline and time. A second blocker creates another journal entry. No quarantine operation
changes the uncertain original, claims or MAX action evidence.

An exact pristine `message_removed` mirror can reach this isolation directly during
preparation. It uses the typed `SEMANTIC_MIRROR` journal variant and preserves its absent
execution deadline as null. This variant requires the terminal FAILED owner, its exact
enforced prepared and started unfinished claim, reconstructed semantic identity and no
independent or legacy authority for the mirror. It never extends isolation to another
message or imports a legacy hold marker. Existing ordered journals retain `ORDERED` and
their original nonnull deadline. The additive migration does not rewrite existing rows;
both API rollback paths require readers for both variants.

When a different bot's earlier copy is the physical order head, bounded indexed discovery
retains that receipt as `anchor_id` and the real failing owner as `blocker_id`. Pristine
never-activated copies may be parked only with the exact enforced shared owner and no
independent/legacy claims. An activated or independently claimed copy retains its existing
fences. Resolving the owner cannot replay its copies; normal canonical settlement deduplicates
them. Retention also pins the order anchor.

The scheduler handles at most 16 candidates per affected chat task. A separate single owned
reconciliation task reads at most 16 due rows per pass, using the persisted due index and a
60-second recheck interval. It never dispatches MAX actions. Shutdown drains that task before
closing Prisma. An item failure advances only its scheduling hint and leaves its evidence
unchanged, allowing other items to proceed.

Parking stops admitting further transactions after its 500 ms dispatch budget, without
cancelling an in-flight transaction. Mirror discovery rotates at most 64 exact heads and has
a 250 ms pool admission / 500 ms SQL budget. Failed discovery retains the existing fences.

## Rejected handler isolation

The operator decision of 29 October is to prevent one failed operation from indefinitely
holding new independent messages, while retaining its replay prohibition and original cause.
An awaited handler that actually rejected has ended. Its current process can atomically
persist terminal `FAILED`, retain the first error and clear its exact business lease, using
the original committed start snapshot and claim-before-receipt locks. It does not schedule
another whole-handler attempt, claim successful moderation or settle uncertain MAX effects.
Other messages follow ordinary ordering and source checks; semantic copies remain isolated.

Failure persistence retries only the same database finalization once for a recognized
storage failure, within the original lease budget. A lost COMMIT acknowledgement requires
the exact retained failure/owner/source readback. Receipt conflicts roll back lease release;
completed, held, cancelled and quarantined work retains its state. A stale queue delivery
cannot replace an ordinary terminal error with the pending canonical-start marker.

The existing certified `COMMAND_NOTICE_PENDING` handoff is a separate continuation: a
process-local proof is published only after its original guarded transaction commits, and
failure settlement compares the exact saved journal. Only that already authorized unattempted
notice keeps its scheduling. Neither a stored kind string nor an attempted/ambiguous SEND
grants this exception; the notice worker still checks its current authority and deadline.

This rule cannot retrospectively prove that a crashed historical handler ended. Live detached
timeouts, missing completion evidence and existing pending barriers keep their original
recovery boundaries. They require a separately proved continuation or exact authorized recovery.

Structured execution and failure-settlement logs share `eventRef`, a bounded receipt hash.
The first log retains the stage, allowlisted error/HTTP code and known source location;
settlement reports its outcome, continuation and the remaining unknown effects. Original
receipt errors are preserved. Raw error text, source messages, credentials and chat/user IDs
are not diagnostic labels. These are service logs, never bot replies in user groups.

## State and recovery

| Journal state | Receipt scheduling                 | Meaning                                                                                                               |
| ------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| WAITING       | QUARANTINED                        | Exact predecessor has not supplied completion proof                                                                   |
| RELEASED      | RECEIVED, then ordinary processing | Exact clean PROCESSED predecessor and its enforced COMPLETED claim proved completion; original deadline remains valid |
| EXPIRED       | QUARANTINED                        | Unstarted dependent work exceeded its original deadline; no business retry                                            |

`RELEASED` is not proof that a successor executed. It must still pass normal preparation,
ordering, ownership, current policy and business-start checks. The final transition checks
the saved deadline again; it cannot renew the processing window. A parked stale BullMQ job
returns without business execution. A started, completed, leased, ambiguous or independently
claimed successor does not qualify for parking.

Reconciliation also checks the PostgreSQL wall clock in the locked receipt UPDATE, after
completion-proof reads. If those reads cross the original deadline, the journal becomes
`EXPIRED` in the same transaction and the receipt stays `QUARANTINED`; no stale queue handoff
is created. The final business-start deadline check remains required after a valid release.

For `SEMANTIC_MIRROR`, absence of a deadline is retained rather than treated as expiry.
Reconciliation retains quarantine until the exact owner has a clean PROCESSED receipt and
an enforced, unleased COMPLETED claim. It then returns only the pristine mirror to ordinary
canonical deduplication. This does not restart the owner's business handler or claim that
its remote effects succeeded. Failed storage, missing proof or changed identity keeps the
mirror parked.

The scope follows the existing dependency: chat ordering for pending timeouts, exact semantic
identity for terminal FAILED owners. Other chats and nonordered
events retain independent capacity; administrative HTTP/mini app operations remain available.
Ordered group commands behind a pending timeout remain dependent. Releasing them independently
requires a separately proven command-only authority path; do not skip the original fence.

Neither timeout expiry, FAILED/terminal text, an absent root nor an unmatched successful
receipt authorizes release. There is no unconditional retry button or automatic cancellation.
Existing explicit cancellation/recovery procedures retain their own authority and scope;
this feature does not widen a previously approved cutoff.

## Visibility and release gates

When a nonordered removal mirror keeps deferring, inspect `Semantic mirror quarantine refused`
in the enqueue role. Its fixed `reason` identifies the refused guard; `suppressed` counts
omitted repetitions since that reason's previous sample. Each reason is logged at most once
per minute without receipt, chat or message identifiers. These samples explain refusal only;
they never authorize changing a claim, removing a fence or replaying the original handler.

Local readiness includes `checks.queueLag.quarantinedCountLowerBound`,
`quarantineSampleLimitReached` and `oldestQuarantinedAgeSec`. The covered query reads at most
65 retained receipt heads; 65 means **at least** 65. Age is receipt age. These fields describe
retained dependent work separately from active RECEIVED/QUEUED lag; a healthy fleet can have
an unresolved quarantine. They must not be represented as successful moderation.
`postgres-audit webhook-cohort` includes QUARANTINED as its eighth status. The closed cohort
report does not prove remote effects or resolve historical quarantine.

The capacity probe and private archive preserve the same three bounded fields without
an additional database query. `quarantined_receipts` is a warning whenever a valid,
fresh observation is nonzero, independently of active queue lag and readiness.
`monitor-capacity-report.cjs` retains the maximum count lower bound, oldest receipt age,
cap hits and known-sample coverage. A nonzero sample prevents a green report window;
missing, malformed, contradictory or stale-fallback evidence remains unknown. Older
archives have unknown quarantine coverage, not zero. This observer does not alter
runtime readiness, governors, admission, or quarantine records.

These counts include expired retained receipts. They do not count currently broken
chats, establish new failures, or authorize cleanup. Investigate fresh impact with the
closed cohort and exact-minute report below, and retain explicit reviewed exceptions
separately from infrastructure health. Never delete evidence to silence the warning.

To distinguish a newly received dependent copy from a newly failed owner, use
`postgres-audit webhook-quarantine` with the exact UTC minute of receipt creation.
Synchronize exact-green-CI tooling, preview `postgres-audit-provision`, then apply
the reviewed eight journal metadata-column grants. Inspect the plain plan first:

```bash
: "${QUARANTINE_AUDIT_MINUTE:?Set an exact closed UTC minute, ending in :00Z}"
./infra/scripts/vps-connect.sh postgres-audit webhook-quarantine "$QUARANTINE_AUDIT_MINUTE" --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-quarantine "$QUARANTINE_AUDIT_MINUTE"
```

The covered status/time walk captures 65 receipt keys, reports at most 64 and
marks truncation. Each exact receipt-key journal probe captures five blockers and
reports at most four, then reads their metadata by primary key. Both caps affect
`sample_complete`. A future/unclosed window reports `window_closed=false` and no
rows. The report is opt-in and excluded from `all`; wrappers accept no SQL,
file, repair flag or arbitrary range. Keep existing audit role/time budgets.

Schema v2 additionally reads each capped receipt's saved semantic key by primary key
and compares it with its blocker's key. `same_key` and `different_keys` distinguish
the stored relationship; absent, empty or overlong keys remain `unknown`. Keys and
message bodies are never returned, and no payload scan or new grant is required.
This comparison does not revalidate normalized source identity or prove external
effects. A different saved key identifies an ordering dependency to investigate;
it does not authorize removing the predecessor's fence.

This is a snapshot of receipts still in QUARANTINED, not a historical census of
everything quarantined in that minute. Missing journal/blocker evidence stays
explicit. Exact legacy/start markers, coarse timeout categories and saved clocks
describe the recorded blocker, not current external effects. No report result
permits release, cancellation, claim edits or replay. Outputs omit identities,
message content and raw errors. Retain the original window and runtime SHA.

### Bounded owner and checkpoint evidence

When the minute report identifies old started blockers, inspect their saved owner/checkpoint
metadata with the separate opt-in `webhook-quarantine-proof` report. Use reviewed exact-green
tooling and first inspect its plain plan; this report never provisions privileges itself:

```bash
: "${QUARANTINE_AUDIT_MINUTE:?Set an exact closed UTC minute, ending in :00Z}"
./infra/scripts/vps-connect.sh postgres-audit webhook-quarantine-proof "$QUARANTINE_AUDIT_MINUTE" --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-quarantine-proof "$QUARANTINE_AUDIT_MINUTE"
```

The initial walk retains 64 of at most 65 receipts and four of at most five journal links per
receipt. A distinct selection over only those retained links captures 17 blocker keys and
inspects at most 16 **before** reading blocker metadata or claims. Remaining links explicitly
have omitted proof. Per blocker, compare its own unique semantic EXECUTION claim with up to
two directly linked claims; retain both paths and their disagreement. Seeing two linked claims
is a lower bound, not a complete claim census. At most three distinct claim details and their
exact owners are read per blocker; there is no recursive traversal or action-ledger read.

Six complete index definitions are attested, along with the existing eight quarantine column
grants and the existing 25-column owner-proof group. No new grants or indexes are required;
an absent group requires a separate reviewed provision step. READ ONLY, the shared audit lock,
SQL/wall deadlines, memory/temp limits, private error handling and exact-backend cleanup remain
unchanged. The session fixes `search_path` to `pg_catalog, public, pg_temp` before admission so
inherited schema order cannot change the inspected relations. The mode is excluded from `all`
and accepts no SQL, path, range or receipt identity.

The separate `webhook-recovery-key-cohort` audit requires the exact supported public
`WebhookStatus` label set, independent of enum insertion order. Immutable migrations append
`QUEUED` after `FAILED`; do not reorder or rewrite migrations to satisfy a diagnostic guard.
Unknown/missing labels and shadow-schema types must still fail admission.

Before materialization or JSON comparisons, accept only uncompressed `command_result` values
within 32 KiB. Compressed or larger values remain explicitly uninspected; no JSON is unpacked
to decide admission. This can omit a valid historical checkpoint and must not be interpreted
as its absence. Output contains temporary ordinals, finite categories, counts, timestamps and
boolean comparisons, never keys, tokens, command JSON, messages or identifiers.
Journal states, error text, saved semantic keys, executor identities and lease tokens have their own 8 KiB
uncompressed admission before materialization or string operations. An uninspected token or
executor is not an absent value; comparisons remain unproved and the omission is explicit.

`EXECUTION_FINISHED` comparisons establish saved metadata only. Source semantic reconstruction,
finished timestamp validity/order, exact runtime CAS and complete effects remain unverified.
An unexpired lease is a stored clock observation, not proof of a live process; an expired or
absent lease grants no authority. Known finished-handler settlement has its own runtime
validator and must not acquire an invented requirement that the lease first expire.
`replay_authorized`, `settlement_authorized` and `remote_effects_proven` are always false.

As with the minute report, this is a snapshot of still-quarantined receipts, not every historical
transition. `sample_complete` describes only the bounded census. Missing journals, owners or
claims, omitted proof and disagreeing paths stay explicit and never mean healthy operation.
Preserve the runtime/source identity, exact interval, caps and uninspected-marker counts.

For a concrete v2 cancellation preview, the same report accepts `--private-blocker-ids`.
This opt-in adds only each sampled blocker's opaque receipt ID (or null for a missing or
unsupported identity); all selection caps, proof limitations and privileges remain unchanged.
Redirect the output into a private mode-0600 file outside Git. Default reports still omit IDs.
Inspect incomplete samples and missing IDs before preparing a nomination; never silently drop
them or treat the sampled set as a complete fleet census. IDs are inputs to the separate
[read-only v2 preview](webhook-backlog-cancellation.md#exact-nominated-sources-v2), not permission
to cancel or replay. Apply still requires a READY preview and explicit authorization for its
concrete scope and stopped-fleet window.

Local focused validation, including native plan/TOAST bounds:

```bash
node scripts/agent/with-test-stores.mjs -- node --test infra/scripts/webhook-quarantine-proof-audit.test.mjs infra/scripts/vps-postgres-audit.test.mjs
```

Prepare a green exact-SHA compatibility image with writes disabled and retain it on the
host before activation. A healthy installation can deploy this reader release first, then
activate in a subsequent release. For an already degraded installation, use one ordinary
fenced activation deployment: the existing mandatory controller pauses the webhook queues,
stops and verifies enqueue and every moderation role, replaces all non-webhook readers,
replaces moderation, then starts enqueue last. No old worker may survive that fence. Verify
all exact images and both native auxiliaries before releasing queues; strict readiness and
release finalization still happen after activation. Never use an unfenced rolling update or
bypass readiness to record a release. Both rollback wrappers enforce quarantine readers;
use the retained compatible manifest, or `rollback-runtime` to the green writer-disabled
compatibility SHA when that build was preloaded without a production manifest. A writer
downgrade retains parked evidence but does not promise to isolate new failures. The schema is additive, has no history backfill and creates indexes only on a new
empty table. Retention pins both dependent and predecessor evidence via indexed checks/FKs.

Required native regression:

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- 'webhook-dependency-quarantine-postgres|webhook-outbox-postgres|webhook-fleet-admission-postgres|webhook-operational-lag-postgres|webhook-multibot-fullpath|message-duplicate-history.redis-integration'
```

The quarantine suite is mandatory in PostgreSQL Races/Required CI. It covers final independent
execution through real BullMQ and canonical receipts, replay denial, multibot copies, late
success, expiry, restart, repeated incidents, persistence failure, concurrent lease/start,
and bounded due selection across retained history. The Redis suite retains the delayed reply
after commit regression. Run the other affected rows of
[webhook latency prevention](webhook-latency-prevention.md), then the normal impact checks.
After activation observe closed fresh cohorts and the existing continuous 15-minute acceptance
window; preserve failures and quarantine counts rather than declaring success from HTTP 200.
