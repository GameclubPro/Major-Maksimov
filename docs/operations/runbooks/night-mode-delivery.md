# Night-mode delivery and recovery

## Product behavior

Night mode restricts new non-administrator messages in chats through moderation. It does not
change MAX's native write permissions. Manual closure and the daily schedule are independent;
lifting one restriction must not announce an open chat while the other still applies.

The owner confirmed on 29 October 2026 that enabled opening notices are independent of closing
notices. A failed, ambiguous or unrecorded closing send, an obsolete Redis session, or a failed
closing-message deletion must not prevent an otherwise authorized opening notice. Preserve the
separate stored notification switches and the two-hour maximum opening catch-up age. Never
retry an uncertain SEND to make a transition appear complete.

## Durable obligations

- An ordinary stale transition persists reconciliation before completing and removing its SQL
  registry row. Retiring both daily jobs must leave a durable path to the next cycle.
- Effective membership eligibility changes enqueue reconciliation in the same database
  transaction. Capability or activation changes must not depend on an in-memory callback.
  Refreshes that preserve eligibility do not create extra requests.
- Versioned recovery payloads in the existing scheduled-job registry retain independent event
  persistence and close-notice cleanup obligations when Redis jobs disappear. Event recovery
  verifies the exact chat/session and accepted send receipt; it never sends another notification.
- Opening and closing keep their existing logical SEND idempotency keys. Only a matching
  successful terminal ledger receipt proves delivery. An absent event or receipt is not proof
  that the message was never sent.
- A future CLOSE authorization uses the later of the application clock and its exact committed
  registry creation time. PostgreSQL timestamp rounding or clock skew must not invalidate a new
  job; both times must still precede the scheduled boundary. Missing or mismatched registry proof
  never grants sticky route authority, and an overdue job cannot acquire it retroactively.
- Cleanup preserves current settings, session, selected executor and lease guards. A new night,
  changed schedule, missing exact message authority or unknown outcome never authorizes deletion
  of an older session's message. A matching persisted closing event with its original bot can
  authorize cleanup when the ledger has expired; it cannot authorize another SEND or reconstruct
  an unproven event. A cleanup failure remains separately recoverable.
- If both the closing receipt and exact closing event are absent, cleanup has no proven target
  and performs no effect. Completing that no-op does not establish that CLOSE was delivered or
  never attempted, and does not create a manual alarm for an opening-only schedule.
- A scheduled opening checks the effective manual restriction immediately before dispatch.
  A manual opening command stores its truthful response from the post-update settings under
  the same command-order lock; it does not disable the night schedule.

## Investigation

Record the exact complaint time, chat, bot, expected transition and relevant component image in
the private incident record. Check settings, route eligibility, durable intent, execution and
accepted SEND separately. Current settings cannot establish historical intent after an edit.

The reviewed `night-mode:audit-notices` command (also available under the older
`night-mode:audit-close-notices` name) runs in `api-admin` without MAX requests or mutations.
Schema v2 covers every enabled night schedule, including opening-only schedules and schedules
whose notification switches are both off. `notices.close` and `notices.open` each show the latest
expected boundary under the current saved schedule and the next boundary. Latest evidence remains
visible after the night or the two-hour opening window ends. Equal start/end means continuously
closed, with no daily boundary; no notice is invented for that state.

Use `--page-size 100 --max-chats 5000 --sample-limit 0 --json` for a bounded aggregate read.
`--max-chats` now limits **all scanned settings rows**, before filtering enabled schedules;
`scan.scannedSettings` counts that work and `scan.scannedChats` counts eligible rows. If
`scan.complete` is false, resume with its exact `scan.nextAfter` using `--after`. A disabled page
still advances the cursor. Each page performs bounded exact-key details, registry and ledger
reads sequentially. The old `coverage.current`/`coverage.next` CLOSE counters retain their
current-close-switch population; new both-notice counters are under `notices`. Latest counters
use `expectationBasis: historical_unknown`: raw `absentRegistryAndLedger` is an observation,
not `missingDurable` work. Completed jobs are normally retired and may never have required a
notification. Only current/future scheduling counters use current eligibility.

Successful exact receipts establish accepted sends even when today's switch is off or today's
route is unavailable. Pristine unattempted SEND intents may be pending; attempted, ambiguous or
incomplete-success records remain unknown. Only a certified refusal before dispatch establishes
`not_sent`. Missing records mean no confirmation, including after the send window expires.
Settings audit rows contain changed key names, not historical values: the current schedule,
notification switches, manual closure or access cannot establish the cause of an older absence.
Scheduling coverage is not notification intent or delivery proof. `sendRouteNow` respects the
fixed moderator independently of legacy per-membership health counters. SQL registry coverage
does not inspect Redis payloads. Historical incidents may predate the current container logs.

The settings screen shows both observations and separately scoped recovery work. Event repair or
closing-message cleanup cannot downgrade a successful opening. Delayed reconciliation and work
requiring intervention have distinct states. Focus, visibility and the next saved boundary
refresh the status without replacing unsaved edits.

## Calendar boundaries

Enforcement, scheduling and diagnostics share absolute intervals. At a repeated local time use
the first occurrence; a nonexistent local time moves forward by the clock-change gap. Merge
overlapping or touching intervals and omit empty intervals so notifications describe the same
restriction as moderation. Russian zones retain their existing boundaries. Calendar caching is
bounded by geometry and an absolute validity interval, never by a cached open/closed boolean.

Persisted v1 session keys and SEND idempotency keys remain valid. Prior member keys of a merged
interval are negative no-send fences for both transitions, never replacement authority or a
reason to rename a receipt. Event-only recovery can restore an exact old accepted receipt;
cleanup accepts supported legacy timestamps but still checks the current restriction and exact
message authority. Both rollback paths require the calendar-aware night recovery reader floor.

Do not repair a missing result by clearing queues, removing manual-review fences, changing bot
assignments or replaying an ambiguous send. Preserve unknown outcomes and report missing evidence.
No diagnostic messages or permission probes belong in customer chats.

## Validation and rollout

Run focused runtime/delivery/processor tests and the native night-mode and GROUP-command suites
through the public wrappers. Native cases must cover both retired jobs, crash after durable
handoff, loss of a Redis job, current-setting changes and independent progress with a fenced
closing effect. Preserve exact PostgreSQL/Redis coverage and skipped cases in the task record.

Deploy the shared API only after exact-SHA Required and CodeQL checks. The normal stopped-worker
deployment boundary installs compatible readers before new recovery work executes. Both API
rollback paths and connector bootstrap require the independent night-mode recovery reader;
turning notifications off does not make an older reader safe. Recheck the selected image across
all API roles and native auxiliaries, strict smokes and the bounded audit after deployment.
