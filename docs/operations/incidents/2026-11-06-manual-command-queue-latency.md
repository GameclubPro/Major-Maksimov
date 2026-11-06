# Manual MUTE/BAN queue delay, 6 November 2026

The user reported delayed manual sanctions. Bounded retained BullMQ jobs and Redis events
confirmed waiting for the shared manual worker before execution. The inspected queue had
concurrency two; commands had priority one, while fanout and cleanup had priority twenty.
Priority cannot interrupt work that is already active.

All times below are UTC on 6 November 2026. The runtime source for these events was
`0bf50d15e26262d4bb6887c23b08738cbaf6d6ba`. The relevant producer, processor, module,
runtime and shutdown sources were unchanged in `322452913e010bbff290a66298dd041dfc0e9d3f`,
accepted at 14:57:42.094. These delays preceded that release.

| Work               | Waiting/start        | Start/finish           | Observation                                                   |
| ------------------ | -------------------- | ---------------------- | ------------------------------------------------------------- |
| BAN fanout         | active 14:20:42.539  | completed 14:21:33.257 | Occupied the first slot for 50.718 seconds                    |
| BAN source cleanup | active 14:21:09.276  | completed 14:21:17.299 | Occupied the second slot for 8.023 seconds                    |
| Manual MUTE        | waiting 14:21:09.526 | active 14:21:17.299    | Waited 7.773 seconds; started exactly when cleanup finished   |
| Manual BAN         | waiting 14:16:07.079 | active 14:16:46.415    | Waited 39.336 seconds; start coincided with fanout completion |

The MUTE handler completed at 14:21:18.427 and the BAN handler at 14:16:48.970, each
after one attempt. Their queue timestamps matched the waiting events, separating consumer
waiting from producer admission. The beginning of one BAN blocker fell outside the bounded
event window; the full two-slot occupancy interval for that BAN was not reconstructed.
No paused/resumed/stalled/failed events appeared in the two inspected windows. A later
empty paused list proves only its sampled current state.

The latest 32 retained completed commands contained 17 BAN and 15 MUTE jobs. Median
issue-to-handler-finish times were 2.163 and 1.320 seconds, with maxima of 41.891 and
8.901 seconds. This was a retained-job sample, not a complete time cohort. Seven commands
after the preceding release had waits of at most 72 ms; that small sample did not remove
the scheduling defect. BullMQ completion does not prove a successful sanction or delivered
notice. Source-sanction and notice timestamps, and ingress-to-enqueue delay, were not measured.

The correction reserves one worker for new `manual_group_moderation_command` jobs in
`admin-manual-commands`, and reduces the retained `admin-manual-fanout` worker to one.
The total manual concurrency remains two. The old worker continues reading every saved
payload kind. Retained deterministic command IDs are checked in the old namespace before
new admission; lookup or enqueue failure cannot authorize an inline sanction. No old job
is moved, cleared or replayed. Existing sanction/ledger/notice authority remains the executor.
Background throughput becomes sequential; the reserved command slot does not bound MAX,
SQL, retries or notice delivery time.

The native Redis regression reproduced the defect before runtime edits: a command could
not start while both legacy background slots were blocked; the retained-command drain
case passed. After the correction all eleven command cases passed, including independent
start, the combined concurrency bound, retained active/completed/failed/delayed jobs,
missing queues and lookup/enqueue failures. Separate native Redis cases verified that
pending and active commands deny lowest-priority retention admission. These tests keep
the external-effect boundary inert; they do not prove a successful real MAX sanction.
The existing shared-member PostgreSQL suite also passed for neighboring atomic claims,
retained uncertainty fences and manual fanout; it is not an exact command-namespace SQL race test.
Both rollback paths require the new reader and the retained old reader. The maintained
[latency regression matrix](../runbooks/webhook-latency-prevention.md#minimum-regression-coverage-by-change)
and [API contract](../../development/api-domain-reference.md) describe these requirements.

The queue addition also changes the cold recovery inventory from 53 to 54. The current
source registry initially failed the existing session reader in a focused regression.
The corrected readers support the new inventory and retained source-pinned 53-queue
journals, keeping their original names, digests and pause states. Both rollback paths
require those readers; the separate 24-queue webhook owner fence remains exact.

Local tests, exact-source CI, deployment, and a fresh two-hour observation of the corrected
version are separate acceptance gates. Earlier monitoring is baseline evidence. Investigation
used bounded read-only collectors; it did not issue test sanctions or diagnostics in user chats.
