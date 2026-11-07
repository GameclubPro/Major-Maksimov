# Bounded action latency audit

Use the opt-in `postgres-audit action-latency` catalog to separate saved action-ledger
waiting time from the interval after the last saved attempt. It observes terminal
outcomes completed during the trailing 15 minutes. It does not observe pending actions,
webhook ingress or an entire moderation workflow.

Synchronize the reviewed tooling through the normal release procedure, review the
separate audit-role provisioning preview, and apply the reviewed grant change before
using the report:

```bash
./infra/scripts/vps-connect.sh postgres-audit-provision
./infra/scripts/vps-connect.sh postgres-audit-provision --apply
```

The apply is a separate maintenance mutation; running a report never provisions its
own access. The optional extension grants exactly six ledger columns: `id`,
`source_tag`, `traffic_class`, `enqueued_at`, `last_attempt_at` and `metadata`. It is
admitted only alongside the existing complete 25-column owner-proof group. Older or
partial schemas receive none of the extension. Other catalogs accept the complete
extension or no extension and continue to accept the original schema without it.
Effective PUBLIC/inherited excess, partial groups, table access and mutation grants
fail closed. No bot identity or error columns are added.

Inspect plain EXPLAIN before executing the report, sequentially under the shared
audit lock:

```bash
./infra/scripts/vps-connect.sh postgres-audit action-latency --explain
./infra/scripts/vps-connect.sh postgres-audit action-latency
```

The command accepts only the fixed mode and optional `--explain`. It is excluded from
`all`; no IDs, time ranges, SQL, input files or repair flags are accepted. Retain the
actual source SHA, runtime image identity, exact UTC observation bounds, exit status
and complete report. A failed command or missing report is missing evidence.

## Selection and storage bounds

One transaction timestamp anchors the trailing 15-minute completion window. The
exact btree `(terminal, completed_at DESC, id DESC)` selects at most 5,001 covered
heads globally, before any action/source filtering or detail inspection. The extra
head is the saturation sentinel. The newest 5,000 are materialized, then each uses
one exact primary-key detail lookup. The report attests both complete indexes, the
required column types, ordinary nonpartitioned relation, default comparison
semantics and absent row security before planning either query mode.

`sample_complete=false` means older outcomes in that same interval were omitted.
Do not treat its percentiles as full-window measurements, compare it with complete
windows as if coverage matched, or raise the row/session budgets to hide saturation.
The sample is an ordered prefix, not random sampling. `sampled_from` describes the
oldest included completion, not an independently closed replacement window.

Before every JSON shape check or extraction, metadata must be uncompressed and at
most 8,192 stored bytes. Compressed, oversized and malformed bodies are explicit
admission states. Their readiness stays unknown; enqueue time is never substituted
for an unread schedule. Only `scheduledFor` is inspected, and its string is bounded
to 80 bytes. A schedule must be a real four-digit nonzero-year UTC ISO timestamp
`YYYY-MM-DDTHH:mm:ss[.S|.SS|.SSS]Z`. Offsets, excess fractional precision and other
formats remain unknown even if another parser could accept them. Absent metadata,
an object without `scheduledFor`, and JSON null `scheduledFor` mean unscheduled.
A nonobject metadata body or a nonstring schedule remains unknown.

The existing read-only envelope remains unchanged: one audit connection, 2,500 ms
statement timeout, 250 ms lock timeout, eight-second wall deadline, 1 MiB work memory,
8 MiB temporary-file ceiling, no parallel workers/bitmap/sequence scans or JIT, pinned
`pg_catalog,public,pg_temp` search path, UTC and exact-backend cleanup. SQL errors are
captured privately and replaced with a fixed refusal message. Live `EXPLAIN ANALYZE`
is prohibited; execution-plan tests run only against disposable local PostgreSQL 16.

## Reading the clocks

Every group reports terminal row count separately from each clock's admitted count,
excluded count and nearest-rank p50/p95/p99 in integer milliseconds. Empty timing
sets have null percentiles. The three clocks are:

| Clock                      | Meaning and admission                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready_to_last_attempt`    | From effective readiness to the last saved attempt. Requires finite enqueue/readiness/attempt clocks in readiness ≤ last attempt ≤ completion order.                          |
| `last_attempt_to_terminal` | From the last saved attempt to the terminal ledger completion. Requires finite last attempt ≤ completion. It remains available when readiness metadata is unknown.            |
| `ready_to_terminal`        | From effective readiness to terminal completion. Requires finite enqueue/readiness clocks and readiness ≤ completion. A missing attempt can still leave this total available. |

Effective readiness is `max(enqueued_at, scheduledFor)` for an admitted valid schedule
and enqueue time for an unscheduled action. A missing or nonfinite enqueue always
excludes both readiness clocks, including actions with a valid schedule. A future
schedule therefore does not appear as queue delay. Malformed/unknown metadata,
invalid schedules, missing clocks and invalid clock order are explicit in admission,
readiness and per-clock coverage.

Clock one can include retry waits and earlier attempts. Clock two is a saved ledger
interval, not an HTTP request duration: it may include executor work, verification,
finalization or failure handling. These measurements cannot locate a webhook stage,
prove a SQL bottleneck or establish a successful remote effect.

Groups are fixed overall, action, terminal outcome, reviewed source label and traffic
class. Unknown labels become `OTHER`, missing text dimensions become `MISSING`; raw
labels and identifiers never leave SQL. No per-bot grouping, content, schedule values,
error text, failure codes or tokens are emitted. An unrecognized enum outcome is
`OTHER`. `FAILED_RETRYABLE` with `terminal=true` is a terminal ledger outcome and can
represent an exhausted or deliberately stopped action; it does not count pending
retries. Keep success/failure/skip/ambiguity proportions separate from clock coverage.

Use the report together with closed webhook cohorts, pending/retry reports, bounded
runtime failure classifications and function-specific evidence. Its explicit
`pending_actions_observed=false`, `retry_authority=false` and `remote_effect_proven=false`
prevent using terminal latency as recovery, replay or settlement authority. A single
complete window cannot certify all bots, features or daily peak behavior.
