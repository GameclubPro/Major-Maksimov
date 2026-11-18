# Message Retention Rollout

This runbook describes the retained legacy worker. The independent «Ластик» service, historical
cleanup, 168-hour mode and permanent executor handoff follow [the Eraser rollout](eraser-rollout.md).
A transferred chat must never resume this legacy executor, including after disabling Eraser.

## Boundaries

Message retention belongs to Major group chats only. The independent policy API is
`/v1/chats/:chatId/message-retention`; generic settings and bulk apply do not own it.
Policies default off, support 24 or 48 hours, and never backfill chat history.
Changing the interval affects pending candidates. Disabling changes the activation
identity; re-enabling starts a new intake baseline, not a historical catch-up.

Capture accepts authenticated `message_created` envelopes with an exact message ID,
chat ID, explicit human sender and MAX message timestamp. Normalized event timestamps
are not message-age authority. Messages older than seven days at receipt are excluded
to fence replays after completed-state retention. Known administrator messages are
excluded locally; execution rechecks author access, current pin and policy.
Unknown rights/pin responses defer deletion, never authorize it. MAX cannot atomically
combine an external pin/admin update with a conditional DELETE.

## Runtime

`MESSAGE_RETENTION_MODE` defaults to `off`. `shadow` records candidates without MAX
deletion; its candidates remain non-executable after promotion. `canary` requires an
exact comma-separated `MESSAGE_RETENTION_CANARY_CHAT_IDS` cohort; `*` is not an allowlist.
`on` makes the module available to explicitly enabled chat policies, not every chat.
Keep the mode/cohort aligned across ingress, admin and `api-message-retention`.

### Changing production availability

Use the caller-only deploy setting from a clean release checkout whose exact target
SHA has passed the required CI checks. Preview leaves the production dotenv unchanged:

```sh
MAXIM_MESSAGE_RETENTION_MODE=on ./infra/scripts/vps-connect.sh deploy main --plan
MAXIM_MESSAGE_RETENTION_MODE=on ./infra/scripts/vps-connect.sh deploy main --auto
```

Only `on` and `off` are accepted by this workflow; omit the setting to preserve the
current mode. The ordinary deploy takes the shared lock, selects the complete shared
API component even when its source SHA is unchanged, journals the transition and
quiesces webhook producers before atomically replacing only `MESSAGE_RETENTION_MODE`
in the canonical production `.env`. Other dotenv values and file permissions are
preserved. Every API role is recreated through the normal fenced rollout; its exact
mode is verified before queues resume, followed by strict smokes and the component
manifest. An interrupted rollout keeps its normal recovery evidence and queue fence;
do not retry it blindly or manually edit the environment.

`on` opens availability for manual per-chat opt-in. It does not enable any chat,
change retention intervals or backfill history. Opening availability while all
policies are disabled does not demonstrate deletion throughput or replace the
executing-cohort and capacity acceptance gates below. To stop intake and execution,
use the same preview/apply workflow with `MAXIM_MESSAGE_RETENTION_MODE=off`.

`api-message-retention` is a headless shared-image role with a two-connection pool,
0.5 CPU, 512 MiB memory, one worker and a separate `message-retention` queue. The
adaptive scheduler wakes at one-second resolution, backs off while idle, and admits at most 100 outstanding chat wakeups using fixed BullMQ
slot IDs, native per-chat deduplication and global concurrency one. Legacy chat-keyed
jobs drain before slot admission. PostgreSQL owns
candidates and schedules; queue loss is recoverable. Each visit processes at most
five deletions, reduced to two under governor slow pressure. Visited chats return behind ready peers; shadow work is selected independently of previously executable FIFO rows. Pause prevents new
attempts. Database housekeeping continues in bounded batches when dispatch is off
or MAX pressure pauses it. Scheduler/cleanup do not run immediately at startup.

Every retention MAX call uses `background` and source `message_retention`. The
distributed source budget is two requests/second across all tokens and processes,
plus one retention deletion/second per chat and existing shared transport limits.
Reads and retries consume the same budget. This is not 172,800 guaranteed deletions
per day: rights, pin, recovery and absence checks reduce useful throughput.

Cleanup has the lowest priority across all webhook, action and auxiliary queues.
One shared sampler observes a complete current rolling minute, with at most two
seconds between samples. Admission requires at most 300 incoming events and 300
non-retention MAX HTTP attempts per minute, plus stable resource headroom. There
is no daily history or P25 warmup. Queue occupancy blocks each attempt without
resetting independently observed quiet traffic. A short permit and atomic transport
check cover ready, active, prioritized, paused and due delayed work, plus in-flight
ingress/HTTP activity. Missing or stale observations defer cleanup. Every retry and
read uses the same gate; candidate age never raises priority. The 24/48-hour setting
is a minimum age, and deletion may wait until the next quiet period.

The 32 transactional quota shards hold at most 62,500 active candidates each;
per-chat capacity is 50,000. Intake pauses at 80% and resumes below 60% after a stable
ten-minute window. A full shard can conservatively pause before the fleet total is
full. Paused intake is visible, counts skipped arrivals and resumes with a new date;
already accepted candidates remain. Completing/replaying a task releases credit once.
Terminal compact candidates and retention-only intents are purged after seven days
in bounded keyset batches; unresolved receipts retain their candidate and never block
later pages. Cleanup locks owned, non-live intents before candidates, never ordinary
moderation intents. Ordinary moderation history is unchanged.

Opted-in admission uses three SQL statements: indexed eligibility, quota-before-policy
locking, then atomic candidate/quota/audit changes. Inactive, historical and already
recorded messages stop at the first statement. Never add MAX calls or remote awaits
to the receipt transaction. Cached author evidence is discarded before refresh and
both pin and author TTLs start at request dispatch, not response completion.
Remote guard reads run before the DELETE slot is reserved. The final transport guard
only rechecks database authority and unexpired cached evidence; expiry defers the
attempt instead of adding nested MAX requests after reservation.

Retention never appends a reason to an independently owned moderation intent. A
normal moderation writer atomically removes the retention reason and takes ownership.
The critical sweeper excludes retention ownership, and the retention runtime refuses
ordinary intents, including ownership changes between lookup and claim. Unknown
remote outcomes retain durable evidence. Terminal errors without a safe automatic
recovery remain visible and require operator review, not repeated blind deletion.

## Receipts and operator diagnostics

Candidate `outcomeCode` distinguishes protected messages, terminal review, access
blockers and unresolved receipts. Nullable legacy fields are discovered in bounded
completed-time pages; the migration does not backfill rows. Reconciliation uses the
per-chat partial `(chat_id, reconcile_after, message_id)` index. It can finalize a
paired remote-success receipt without MAX while off, or use authorized exact-message
presence reads while executing. It never issues DELETE for an ended activation.
Legacy terminal rows with mutation evidence use the same receipt-only path.
Authenticated exact group `message_removed` receipts settle the candidate, counters
and owned intent in the receipt transaction; duplicate receipts release no extra credit.

The closed Safety Desk `/runtime/retention` page reads at most 50 policies and 32
quota rows, then bounded indexed diagnostics. Its per-chat preview reads at most 20
review/recovery messages without content. An operator retry requires exact activation,
policy revision and intent versions, fresh bot access, a sole owned retention reason,
no dispatch/success evidence and healthy quota. It resets only the scheduling state
and writes one audit in the same transaction. Unknown outcomes must reconcile first.
The ordinary deletion retry endpoint rejects retention-owned intents.

For a bounded admission observation, use `vps-connect.sh exec` to run Node inside
`api-message-retention` and read only the fixed Redis string
`maxapi:retention-priority:status:v1` through `ioredis` using the container's
`REDIS_URL`. Do not print the URL. The JSON includes the collector observation time,
current-window coverage and traffic rates, queue counts, resource ratios and
the admission reason. Require a fresh observation (at most two seconds old); a
missing/stale value is an evidence gap. `current_window_incomplete` during the first minute is an
expected closed gate. No SCAN, SQL or MAX request is needed for this observation.

Completed SQL and MAX HTTP activity leave short Redis receipts for the exact
operation ID. Each kind retains up to 8,192 receipts for at most 60 seconds.
A retry after a lost Redis reply can use that evidence without repeating SQL,
MAX requests or quota reservations. If both the active marker and its valid
receipt are missing, admission stays closed and the first stop reason is kept.

An expired in-flight activity observation closes admission conservatively. A forced
process termination can leave such an observation; this version does not infer
completion from lease expiry or automatically erase it. Inspect the fixed activity
and unavailable keys with bounded cardinality/type reads and preserve uncertainty.
Recovery requires reviewed evidence that the observed work has ended; do not clear
markers or queues merely to reopen cleanup.

Local capacity command (disposable localhost schema only, no MAX; replace the example
URL with your configured local test database, without URL options):

```sh
npm run message-retention:capacity --workspace @maxim/api -- \
  --postgres-url postgresql://localhost:5432/retention_capacity_test \
  --chats 20000 --candidates 2000000 --scenario retry --samples 100
```

Its PostgreSQL latency/storage/plans are measurements; transport figures are an
arithmetic budget model, not sustainable MAX throughput or production certification.
Run uniform/hot/retry/skew/removed scenarios before raising the rollout gate.

## Release Gates

The strict lowest-priority admission, current quiet-window selection
and separate 20,000-chat capacity gates are documented in the
[20 October optimization plan](../plans/2026-10-20-message-retention-low-priority.md).
Opening runtime availability for manual opt-in does not certify fleet capacity or
complete the executing-cohort acceptance below. Preserve disabled chat policies.

1. Keep the runtime off while deploying the additive migration and compatible shared
   image to every role. Deploy the Major mini app and validate the contracts consumers.
2. Run `npm run check`, `node --test scripts/message-retention-migration.test.mjs`, and
   `node apps/miniapp/test/message-retention.browser.mjs` with `MINIAPP_TEST_BASE_URL`
   pointing at an owned local mini app server.
   `npm run test:retention-storage --workspace @maxim/api` executes the production SQL
   on embedded PostgreSQL. With an explicit localhost `MAXIM_TEST_POSTGRES_URL`, the
   same suite uses a disposable schema and concurrent clients; CI runs that variant.
   Set localhost `MAXIM_TEST_REDIS_URL` as well for real fixed-slot/two-producer/queue-loss
   and global-concurrency tests. The wrapper also checks actual Prisma-store row-lock races.
3. Before enabling capture, compare PostgreSQL/Redis load and webhook/moderation
   p95/p99 under matching traffic, including multi-bot mirrors and removal updates.
   Test 10,000/20,000 chats and two million pending records on a representative
   disposable database. The embedded PostgreSQL migration/index check is not a
   replacement for concurrent live-engine or capacity testing.
4. Block promotion on >5% p95/p99 degradation, new critical errors, quota violations,
   growing backlog below the measured admitted capacity, or worker resource overruns.
5. Progress through bounded shadow, the approved test chat, 100 opt-in chats, then
   1,000. Observe each executing stage for at least 72 hours and verify deletion of
   specifically created test content older than 48 hours. Never test on existing
   user messages. Expand only below 60% of measured sustainable cleanup throughput.

Observe the `message_retention` source metrics, auxiliary queue, policy counters,
oldest due time, capacity pauses and core moderation latency. Do not run broad
production aggregates over raw webhook events for this feature.

## Index Migration Recovery

A lock timeout in `20261002020100_index_retention_reconciliation` can
leave a mixture of missing, valid and invalid indexes. Preserve both immutable
migrations and the interrupted release journal. Use the fixed recovery command
from a clean, synchronized checkout with green exact-SHA CI:

```sh
./infra/scripts/vps-connect.sh recover-message-retention-migration
./infra/scripts/vps-connect.sh recover-message-retention-migration --apply
./infra/scripts/vps-connect.sh recover-message-retention-migration
```

Review preview before apply. The helper verifies the preceding additive receipt,
column definitions, migration checksum and all three exact index definitions,
including the reconciliation predicate. Under the shared deploy lock it creates
missing indexes or reindexes invalid ones concurrently, then verifies their
readiness/validity before resolving the fixed receipt as applied. Unexpected DDL,
unrelated failed receipts or concurrent-index artifacts abort. Table size,
statement and total time are bounded; no candidate rows are changed.

Keep `MESSAGE_RETENTION_MODE=off` and the cohort empty. Recovery does not alter
queues or finalize a release. After preview confirms all three indexes healthy,
the receipt applied and no other failures, resume the ordinary release workflow:

```sh
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1 \
  ./infra/scripts/vps-connect.sh deploy main --auto
```

Use adoption only for the reviewed interrupted transition, never persist it in
the production environment. Normal deploy re-proves the queue fence, recreates
the selected components, runs strict smokes, resumes queues and records the new
manifest. The no-recreate release finalizer cannot recover an old runtime.

## Stop And Rollback

Set the runtime mode to `off` through the reviewed runtime-environment/deploy workflow
and recreate the affected roles. This stops new intake/execution, preserving accepted
work. Per-chat disable separately cancels that activation; already dispatched HTTP
requests cannot be undone. Never delete Redis/Postgres data to stop the module.

Both API rollback paths require the receipt-recovery-aware guard and critical-sweeper
exclusion. A pre-feature image may execute persisted retention intents as critical
work and is not a valid rollback target, even when its environment has retention off.
