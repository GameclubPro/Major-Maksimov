# Safety Desk: bots and queues

The first view in Safety Desk's Observations shows shared runtime evidence through
`GET /api/v1/safety-desk/runtime/overview`. It uses the existing closed owner guard,
forwarded admin host/user and access code. It makes no MAX calls and cannot change
bot assignments, effects, queue state or recovery fences.

## Collection and freshness

Only the admin role collects this overview. Fixed queue counters, worker reports,
subscription observations and the Publisher heartbeat refresh every ten seconds.
SQL observations refresh every thirty seconds. Concurrent collections coalesce;
browser reads use the shared result rather than starting additional SQL work.
The visible screen polls every fifteen seconds. Hidden views stop polling; access
changes abort earlier requests, and a denied session clears its displayed evidence.

Each source retains its own observation time and availability. A new HTTP response
does not refresh an older source observation. Redis failure, invalid clocks,
missing providers/indexes and incomplete samples cannot establish healthy zeros.
Worker reports establish process observation, not successful bot actions. A quiet
bot has no invented activity deadline. Publisher uses its own runtime heartbeat;
the overview does not infer Lastik or Birzhik health from Major's measurements.

The separate `safety-desk:overview:v1:*` Redis namespace contains no message text,
chat/message identifiers, tokens or raw errors. History keeps the latest aggregate
observation in each minute, at most 1,440 points over 24 hours, with a 24-hour TTL.
Failed source observations become gaps, and missing minutes remain gaps. Latency
points describe overlapping fifteen-minute samples; they cannot be averaged into
a daily percentile.

## Reading the numbers

- Queue bars describe the distribution of current jobs. Waiting includes paused
  jobs; prioritized, active and delayed work remain separate. Retained completed
  and failed jobs are labelled separately from sampled action outcomes. Receipt
  counts and BullMQ jobs are distinct measurements and must not be added together.
- Terminal action p50/p95/p99 cover up to 5,000 completed outcomes over fifteen
  minutes. Confirmed, skipped, failed and uncertain outcomes remain separate.
  Missing or invalid timing evidence does not become a zero-duration action.
  Only uncompressed metadata up to 8 KiB reaches scheduled-time inspection;
  rejected metadata keeps its outcome while excluding its unknown latency.
  Timing sample counts therefore remain separate from terminal outcome counts.
- Receipt age accompanies terminal latency. Per-bot `RECEIVED` and `QUEUED`
  probes use 64 rows plus a sentinel per indexed source/status. Legacy null-bot
  receipts belong only to the explicitly configured default bot. The receipt
  summary covers this configured bot catalog; it does not count receipts for
  removed or unknown bot identities. Completeness describes this selected scope.
- Unfinished actions use seven indexed status/terminal heads, each capped at 64
  rows plus a sentinel, then exact primary-key bot projections. Their age measures
  time since the sampled action's last state update, not time since enqueue or
  effective readiness. Per-bot values are lower bounds from this fleet sample;
  saturation makes coverage incomplete even for a bot with zero captured rows.
- A good completed-action percentile does not cancel an old unfinished head.
  Ten- and thirty-second attention thresholds apply to receipt age and completed
  action latency. Time without a state update is a separate neutral measurement:
  scheduled work, retries and uncertain outcomes require their own evidence.
  A stale source is displayed as stale, not as a current recovery or failure confirmation.

There is no completion percentage for a continuous queue. Count, distribution,
backlog change and observed processing pace describe it. Results per minute are
the fifteen-minute average of terminal outcomes, including failures and unknown
outcomes; a capped sample provides a lower bound. Detailed cohort and
outcome views remain available for reviewing evidence; the overview never
authorizes replay, cancellation or removal of uncertain work.

## Validation and release

The unfinished-work reader requires the exact existing receipt and action head
indexes before reading retained history. Its transaction is read-only, with a
two-second statement timeout, 250 ms lock timeout, disabled parallel query and
five-second transaction deadline. The native regression
`apps/api/src/admin/safety-desk-overview-pending-postgres.spec.ts` covers retained
terminal history, tied heads, skew, legacy bot scope, saturation and index drift.
UI regressions include stale/denied states and access-scope polling boundaries.

The overview uses existing components, CSS and inline SVG, with no chart dependency.
Against the same-source pre-overview build, the measured feature adds about 27.5 KiB
of JavaScript (6.8 KiB gzip) and 6.4 KiB of CSS (1.3 KiB gzip). The checked bundle
budgets include these measured additions and retain the existing 320-byte tolerance;
splitting chunks does not bypass their aggregate byte limits.

Validate PostgreSQL/Redis behavior with the public isolated-store wrapper and
focused cases before the staged owner aggregate. Deploy the affected shared API
image to all its roles and the Safety Desk through the existing exact-SHA release
flow. Production acceptance additionally checks observation freshness and bounded
collection cost; successful local fixtures alone do not establish fleet health.
