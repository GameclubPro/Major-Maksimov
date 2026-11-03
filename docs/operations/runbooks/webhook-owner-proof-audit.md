# Webhook owner proof diagnostics

Use this fixed read-only catalog when the oldest received webhook is blocked by an
earlier ordered event and the queue report cannot establish its execution state:

```bash
./infra/scripts/vps-connect.sh postgres-audit webhook-owner-proof --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-owner-proof
```

Synchronize the reviewed tooling and review the audit-role provision preview before
the separate maintenance apply. This mode needs 25 additional column SELECT grants;
it never provisions itself. Run catalogs sequentially under their shared audit lock.
Keep the exact runtime release identity and UTC observation window with the report.
The diagnostic is excluded from `all` and accepts no identifiers, SQL or input files.

Three additional fixed views diagnose a receipt itself when no earlier same-chat predecessor
exists, inspect the next scheduled failed retry, or inspect the oldest QUEUED receipt:

```bash
./infra/scripts/vps-connect.sh postgres-audit webhook-source-proof --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-source-proof
./infra/scripts/vps-connect.sh postgres-audit webhook-retry-proof --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-retry-proof
./infra/scripts/vps-connect.sh postgres-audit webhook-queued-proof --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-queued-proof
```

They retain the same private read-only envelope and existing grants. Source mode selects the
oldest RECEIVED receipt. Retry mode selects one FAILED receipt with non-null `next_enqueue_at`
ordered by `(next_enqueue_at, created_at)` through the existing status/retry index; it never
walks terminal FAILED history. Queued mode selects one QUEUED receipt through `(status, created_at, id)`. All scopes expose
stored execution deadline, enqueue time/count and a finite queue-family label; they never expose
the raw queue name or certify BullMQ job presence. In these receipt scopes the compatibility field `predecessor` describes
the selected receipt itself, as identified by `scope`. Nonmessage lifecycle receipts can also expose their own claim in these modes. Their metadata
remains diagnostic only. Fixed flags distinguish preparation
lease errors, stored semantic matches and an execution-wait marker without exposing raw errors.
The marker alone is not validated readiness authority. Source, receipt, claim and effect evidence
remain unchanged; none of these reports can authorize a retry or settlement.

For a closed minute of still-quarantined receipts, use the separate
[`webhook-quarantine-proof` report](webhook-dependency-quarantine.md#bounded-owner-and-checkpoint-evidence).
It caps distinct blockers before reading claims, retains semantic and linked-claim disagreements,
and bounds journal bytes before JSON inspection. It reuses the existing grant groups, performs
no effect-ledger search and never grants replay or settlement authority.

## Held removal metadata

When the oldest RECEIVED receipt is a `message_removed` with a saved preparation
deferral, inspect its structural hold and seal metadata:

```bash
./infra/scripts/vps-connect.sh postgres-audit webhook-held-receipt --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-held-receipt
```

Synchronize the exact green tooling through `deploy <reviewed-branch> --plan`,
then review the audit-role provisioning preview before its separate maintenance
apply. This opt-in mode needs 28 scalar column SELECT grants across legacy
recoveries, sealed authorities, quiescence certificates, source abandonments and
backlog receipts. It grants no snapshots or attestation JSON. Existing catalogs
accept either the entire new group or none; this mode requires the entire group.
Keep the source SHA, actual API image SHA and observation window separately.
Tooling synchronization does not roll out the API image or restore availability.

Without an ID, the report selects one oldest RECEIVED through
`(status, created_at, id)` before inspecting its type and retains removal-only
scope inspection. For an already nominated receipt, use
`postgres-audit webhook-held-receipt <receipt-id> --explain`, review the plain
plan, then run the same command without `--explain`. The ID is one opaque token
of at most 128 ASCII letters, digits, underscores or hyphens, starting with a
letter or digit. Exact selection uses the primary key regardless of current
status. Missing and no-longer-RECEIVED receipts are explicit; it never substitutes
a newer head. A generic prepared plan keeps the nominated ID out of plan output.

Keyed mode also inspects `message_created` and `message_edited` metadata. Original
normalized payload storage must pass the existing PostgreSQL 16 decoded-size
bound before JSON extraction. Only bounded normalized chat, message and sender
fields guide indexed probes; their values never appear in the report. Schema v2
labels the removal actor separately from the created/edited message's normalized
outer sender. A missing outer sender stays unproved, even if a forwarded linked
sender is present. Neither nomination establishes the original author's identity.
Raw source parsing, canonical key reconstruction and original source clock
validation remain unevaluated.

The legacy message probe first admits at most 16 rows plus one saturation sentinel
from the indexed chat prefix, then filters that materialized prefix by message.
This bounds reads even when PostgreSQL chooses another chat-leading index. The
global-user family independently admits at most 16 matches plus one sentinel.
Neither probe sorts before its limit. Only a complete chat prefix, complete user
family and bounded original metadata permit deduplication and the bounded
owner-first/id ordering used to select a legacy scope. A saturated chat prefix
makes the exact-message family incomplete even if no sampled row matches the
message; zero sampled matches never establishes absence in that case. The report
exposes prefix counts, saturation and completeness separately. Inspect every
physical scan's index condition in the plain plan; the existence of the intended
index alone does not prove a bounded lookup. This mode attests ten complete index
definitions, including both existing chat/message and chat/user access paths.
The selected certificate and authority use exact unique lookups. Scalar binding
and seal comparisons distinguish missing, mismatched and matching records; the
receipt/seal relationship concerns receipt creation time only.
Seal coverage is explicitly `selected_scope_only`; it does not prove that every
matching legacy scope is sealed.

Modern exact-message presence, backlog exact-receipt presence and backlog stored
semantic-key presence are independent metadata observations. They are not a
reconstructed `isUpdateHeld` result. Existing disposition pointers remain explicit.
The unchanged 28-column privilege group cannot read backlog message-family
identities. For created/edited messages, that family stays `not_evaluated`, protocol
coverage is `partial` and `exclusive_protocol_proven=false`. An absent sampled
family cannot establish absence of every hold or identify the runtime refusal.
No claim, effect history, handler or materializer runs. The report retains
`runtime_classifier_evaluated=false`, `settlement_authorized=false`,
`replay_authorized=false` and `effect_completeness=unknown`. In particular,
`legacy_scope_unsealed` is a lossy saved error, not proof that a seal is absent.
A matching seal cannot authorize settlement or replay of an unsupported lifecycle
event. Read the plain plan before execution; retain the shared audit lock, exact
index and privilege attestations, private error handling and existing time limits.

## Selection and limits

The `canonical_owner` section describes the already selected claim owner's status,
retry/quarantine flags and fixed saved-error family. It adds no owner traversal,
payload output or settlement authority. A pending removal mirror can otherwise
obscure an already quarantined owner behind repeated preparation deferrals.

Runtime may propagate the exact pending `LEGACY_EXECUTION_UNVERIFIED` quarantine
to an unqueued `user_removed` mirror only after locking and revalidating the same
unprepared, unstarted, unleased claim and both receipts. Independent claims,
dispositions, attempted queue delivery or different source/error evidence refuse.
Both original payloads and the claim remain unchanged; the mirror remains FAILED
under the pending no-replay marker, protected from terminal retention. This does
not complete the owner, authorize replay or recover historical external effects.

The report selects the oldest `RECEIVED` row using `(status, created_at, id)`, then
exactly its first earlier ordered predecessor through the ordered-chat partial index.
It classifies that row even if its authority is missing or invalid; it never skips to
a later recoverable event. Source metadata without a supported ordered chat returns
`source_unknown`.

The semantic execution claim uses unique `(kind, semantic_key)`. A second lookup by
`(webhook_event_id, kind)` stops at two rows and detects conflicting links. If the
semantic claim is missing, exactly one linked claim can be inspected diagnostically.
The chosen claim and its canonical owner use primary keys. A different canonical
owner stays explicit; no recursive owner or mirror traversal occurs.

An optional exact `(chat_id, action_type='DELETE_MESSAGE', message_id)` ledger probe
reads at most 17 rows. Sixteen is the sample cap and the seventeenth is a saturation
sentinel. Its count is a lower bound; positive observations may include the sentinel.
These observations belong to the predecessor's message, not necessarily its exact
execution or edit version. A missing normalized message key makes the effect source
unavailable. Sends and sanctions are not searched without exact saved action keys.

Both execution and plain `EXPLAIN (FORMAT JSON)` first attest all eight complete index
definitions and effective privileges. Missing, invalid or changed indexes fail closed.
The existing single-session READ ONLY envelope, 2.5-second statement timeout,
250-millisecond lock timeout, eight-second wall ceiling, memory/temp limits and exact
backend cleanup remain in effect. `EXPLAIN ANALYZE` is not supported. Plans must show
index conditions for every application relation; a `LIMIT` alone does not bound work.

## What the result proves

The report exposes finite classifications and boolean checkpoint comparisons, never
source messages, identifiers, semantic keys, lease/dispatch tokens or raw errors.
Database failures return a fixed unavailable message and do not report a healthy result.

`finished_checkpoint_candidate_requires_runtime_validation` means only that the
stored fields match. `semantic_source_rebuild` and `finished_timestamp_validation`
remain `not_evaluated`. In particular, edit identity includes a trusted timestamp and
content digest that this SQL diagnostic does not reconstruct. `settlement_authorized`
is always false and `effect_completeness` is always unknown.

Only the runtime's exact finished-handler validator and fresh transactional receipt/
claim comparisons can authorize SQL-only settlement. A completed claim requiring
receipt reconciliation is distinct from a READY claim with a finished checkpoint.
Individual successful actions do not prove completion of the whole handler. Missing
claims, old age, missing business-start timestamps, absent ledger rows and absent remote
receipts never prove that historical effects did not occur. Preserve quarantine and
send idempotency when evidence remains unknown.

## Exact additional grants

| Table                      | Column SELECT grants                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook_execution_claims` | `id`, `kind`, `semantic_key`, `webhook_event_id`, `execution_bot_id`, `enforced`, `status`, `prepared_at`, `business_started_at`, `completed_at`, `lease_token`, `lease_expires_at`, `command_result` |
| `max_action_ledger`        | `chat_id`, `action_type`, `message_id`, `status`, `ambiguous`, `terminal`, `attempt_count`, `dispatch_token`, `dispatch_started_at`, `dispatch_bot_id`, `remote_message_id`, `completed_at`           |

Keys, tokens and the command journal are compared inside PostgreSQL and never included
in output. Provisioning grants both complete groups or neither on an older schema.
Generic catalogs allow zero or all 25 effective grants. This mode requires all 25;
partial grants, table SELECT, unexpected inherited/PUBLIC access and mutation grants
are rejected. Existing Antiduplicate grants remain a separate unchanged contract.

Local validation including native PostgreSQL plans:

```bash
node scripts/agent/with-test-stores.mjs -- node --test infra/scripts/webhook-owner-proof-audit.test.mjs infra/scripts/vps-postgres-audit.test.mjs
```

The audit role also grants 21 exact intent/reason proof columns for bounded, reviewed
owner-intent diagnostics. Immediate DELETE execution does not create a MAX action ledger
entry: zero DELETE ledger observations never proves that no delete was attempted. Inspect
the exact message intent, dispatch and remote-success markers, and bounded bound reasons
separately. Keep identities, lease tokens and reason metadata out of report output. Neither
report authorizes claim completion, order release or replay.
