# Commercial AI pool

The optional pool makes four pinned classifiers independent primary workers:
`server-9b` on the VPS, `pc-a-4b` on the first PC GPU, `pc-b-9b` on the second PC
GPU and `pc-a-cpu-9b` on the first PC CPU. The VPS owns admission, expiring reservations and final moderation
authority. PCs make outbound SSH connections and expose their authenticated model
API only on loopback: GPU workers use `127.0.0.1:18084`, and the independent
first-PC CPU worker uses `127.0.0.1:18085`. They receive no MAX token or direct database access.

This runbook describes the implementation and rollout gates. It does not establish
that the pool has been deployed, that either PC passed an unattended reboot, or
that the models passed independent advertisement-quality acceptance.

## Scheduling and failure boundaries

Each model has one physical inference slot. Primary work first reserves available
9B capacity, then immediately uses 4B when no eligible 9B slot can be reserved.
It never waits for a busy 9B or extends the original source deadline. Within the
9B tier, measured response-time EWMA plus a decaying failure penalty ranks nodes;
exact ties rotate. A faster 4B never outranks an eligible free 9B.
The four bounded measurements live in the background process and reset on its
restart. Atomic reservations prevent two producers from claiming the same slot.
The shared bounded admission mailbox retains at most two pending inputs and four
active sources. Existing per-chat, source-age, three-second admission and original
20-second inference limits remain. These are short-lived work records, not an
unbounded backlog or a historical replay queue. Expiry is an unclassified input.

In the retained `confirm-positive` policy, only a 4B result can request a 9B
consultation. A consultation must immediately
reserve an idle 9B slot after the atomic check for higher-priority primary work.
It never queues behind another model request, retries, or extends the original
deadline. If no 9B is immediately available, the result remains `UNSURE`
and cannot authorize deletion. Ordinary primary work can make at most one retry
on a different available node within the original deadline; obsolete results
cannot replace the current attempt.

The retained `confirm-positive` policy requires consultation for both 4B
`COMMERCIAL` and `UNSURE` results. The owner selected 9B-first processing with
`direct-4b` overflow on 2026-11-07, superseding the earlier requirement to confirm
4B positives before enabling this deployment. In `direct-4b`, every 4B answer is
terminal: a commercial decision may proceed through the existing effect guards,
`NOT_COMMERCIAL` stays negative, and `UNSURE` cannot delete. No answer requests
another model, including personal-sale observations. Explicit personal-sale BLOCK
still requires its existing pinned 9B proof, so a fallback 4B personal-sale answer
does not authorize that special deletion. The source, settings, grants and original
deadline checks remain required. This routing decision does not certify classifier
accuracy. Neither policy treats self-reported confidence as a calibrated probability.

Node leases expire after ten seconds and readiness after six seconds without
renewal. Disconnection prevents new reservations; generation/attempt fences reject
late answers. An interrupted busy PC recycles its owned model process before
advertising readiness again. An idle connection loss can retain its warm model.
The supervisor retries SSH with bounded jitter and re-registers after the connection
and model checks pass. Pool workstation profiles enable the authenticated `/slots`
endpoint on loopback. Before connecting, the supervisor checks its owned model
process and requires one idle slot with `id=0`, `n_ctx=4096` and the exact boolean
`is_processing=false`, alongside the pinned template, alias and slots capability.
Unknown, malformed, oversized or timed-out observations do not establish readiness.
The existing first-PC legacy launcher keeps its own unchanged profile and lifecycle.
The category prompt is server-owned per request. The one reviewed prior prompt pin
is accepted only in worker hello with all other profile fields exact, then echoed.
Server heartbeats, request grammar, observations and effect proofs retain the current
prompt identity; an old result never inherits this transport compatibility. See the
[category contract](../../development/commercial-ads-policy.md#ai-worker-compatibility).
A missing PC reduces total capacity without blocking the other workers. Reduced capacity can still produce admission skips; three machines
do not guarantee zero queues or complete traffic coverage under arbitrary load.

The VPS CPU node uses the same physical lease as the legacy CPU classifier.
VPS CPU handoff requires at least six seconds of the original inference budget, matching
the existing measured CPU p95 admission floor. The client leaves shorter budgets to
available GPU nodes, and the CPU adapter rechecks after headroom and lease-retention
waits before HTTP. A rejected undispatched request releases only its own capacity;
this neither renews a deadline nor releases uncertain work that reached HTTP.

The pinned llama.cpp b11804 `/health` handler ignores `fail_on_no_slot`; health is liveness only.
Readiness uses the bounded `/slots` contract and `/props.endpoint_slots=true`.
The separate guarded CPU capability upgrade is described in the
[local model runbook](commercial-llm-shadow.md); ordinary API deployment alone does
not establish that the existing CPU container supports slots.

An idle slot observation does not acknowledge cancellation of a pending HTTP request.
Immediately before a CPU pool handoff, an owner-checked operation removes the lease's
expiry. A bounded, exact-model terminal envelope (`finish_reason=stop`, one assistant
message, no reasoning, refusal or tools) proves the physical request finished and
releases only its own lease. Decision JSON and classification/reason consistency are
validated separately: an invalid decision still fails, supplies no accepted result or deletion
authority, and does not quarantine completed CPU work. The original twenty-second inference
deadline still ends source classification and expires the pool reservation. After HTTP handoff,
the CPU adapter drains under the existing sixty-second client limit and a separate process-shutdown
signal. A late terminal response releases only its own physical lease; it is never published to
an expired or cancelled source. Shutdown still aborts physical work and retains an uncertain lease.
Wrong model identity, malformed
envelopes, non-stop finishes and ambiguous transport failures retain the lease and
withdraw CPU capacity, including across an API restart while
Redis retains the key. Neither a later idle observation nor the former 120-second
TTL may release that hold. Other nodes remain independently schedulable. Recovery
requires quiescing the CPU dispatcher and proving the captured model generation
stopped before any exact-token release; never manually delete the key to restore
readiness. Redis data loss and independently initiated legacy requests retain their
existing limitations; this lease is not durable across loss of Redis state.

Rejected model decisions may expose only the finite `responseIssue` codes `envelope`,
`finish`, `message`, `content_json` and `decision` alongside the existing failure kind.
They contain no model response or source text. A response-store outage is `UNAVAILABLE`,
not evidence of malformed model output. These diagnostics do not prove eligible-input
coverage or final MAX effects. Existing persistent CPU holds have no saved terminal
proof and remain subject to the recovery protocol below; a new API image cannot
retroactively release them.

### Recovering a quarantined CPU generation

A persistent CPU lease with an idle, correctly identified model still requires
managed recovery. A routine API restart retains the lease. Use the named host
operation after exact controller CI and synchronization through the normal tooling
release; it runs under the protected deploy and shared-project admission locks:

```bash
cpu_recovery_operation="$(node -p 'require("node:crypto").randomUUID()')"
./infra/scripts/vps-connect.sh commercial-llm recover-cpu-quarantine "$cpu_recovery_operation"
read -r -p 'Reviewed preview SHA-256: ' cpu_recovery_preview_sha
./infra/scripts/vps-connect.sh commercial-llm recover-cpu-quarantine "$cpu_recovery_operation" --apply "$cpu_recovery_preview_sha"
```

Review the concrete preview before applying its digest. It binds the source SHA,
CPU model and background dispatcher container IDs, image IDs, start clocks,
restart counts and the persistent lease fingerprint. It exposes no lease token
or model input. The initial preview makes no runtime or journal changes.

Apply persists a separate operation journal before stopping the exact background
dispatcher, then the exact model generation. Only positive readback of both stopped
generations permits an exact-token lease CAS. The CAS atomically records its own
release receipt; a missing lease alone never establishes completion. The original
model container restarts, passes pinned readiness and the closed synthetic smoke,
then the same dispatcher restarts and passes readiness. This background role is
headless: it has neither HTTP readiness nor a Docker healthcheck. Its role check
requires the same attested running process generation across a five-second
stability interval, within the existing three-minute deadline. Useful model work
remains a separate acceptance check. Other roles, stores,
cooldowns, source proofs and uncertain moderation effects retain their identities.
The temporary dispatcher pause reduces AI coverage during this operation.

The streamed lease helper must be a single regular file owned by the deploy user
and must not permit group or other writes. If Git transport creates it with mode
`664`, preview refuses before any process or lease mutation. Verify the exact
committed bytes and ownership, then normalize only that helper to `644` under the
existing protected and shared-project locks; preserve the failed preview. Do not
weaken its reader or change model, journal or lease data to pass that check.

After interruption, resume the same operation UUID, controller source and reviewed
digest. A later preview of an existing journal reports its original plan and phase;
it does not prove that the current generations still match. Foreign generation,
image, start-clock, lease or receipt drift fails closed and needs investigation.
No automatic cleanup or unconditional restart follows a failed phase. A completed
operation is terminal: repeating it never stops processes or removes a lease
acquired by later natural work. Journals and release receipts remain as evidence.
This operation never replays old sources or turns a prior uncertain answer into a
moderation decision.

The controller at `895cc0cbe10bae80a3379348fc98a355699d20d2` incorrectly waited
for a Docker healthcheck on the headless dispatcher. Its interrupted
`starting_dispatcher`, `dispatcher_ready` or `complete` journal can be finished
by a corrected exact-green controller descended from that source, with only the
finite reviewed controller changes. This compatibility path preserves the
original plan source, UUID and digest. It refuses every process start/stop and
lease CAS; an already restored generation must pass the readiness check. Earlier
phases and other old sources have no such allowance. The terminal result reports
both the immutable plan source and the controller that completed it.

After recovery, verify actual CPU pool attempts and completed consultations,
classification outcomes and admission losses in a fresh window. Healthy containers
or a successful release receipt alone do not establish useful classification,
advertisement accuracy or complete traffic coverage. Governor pauses and the
bounded admission policy still apply.

The VPS and its Redis admission service remain the coordination point. A VPS or
Redis outage prevents AI admission; adding PCs does not make that control plane
highly available. Busy, uncertain, stale and failed work cannot delete a message.
The [commercial AI deletion guards](commercial-ai-deletion.md#durable-effects)
and independently enabled moderation rules keep their existing authority.

## Observations in Safety Desk

The owner-only `GET /api/v1/safety-desk/runtime/commercial-ai/pool` reads the four
fixed node registrations independently of the enforcement process. It distinguishes
ready, occupied slot, connected-but-not-ready, missing registration, invalid data
and expired cached observations. An occupied slot does not establish that inference
is progressing; a missing registration does not establish why a PC disconnected.
The atomic bounded reader checks types, byte limits, exact model/session identity
and TTLs before projecting states. It never reads a slot body or returns ownership
tokens, model inputs, responses or source identities. The two-second cache cannot
extend a node's observed TTL. There are no MAX calls or runtime mutations.

The process publishes four bounded attempt summaries and completed/no-capacity/
budget-exhausted consultation counters in its existing status. Attempts include
primaries, consultations and retries; they are not unique message counts or final
moderation decisions. Smoothed response duration is the existing routing EWMA,
shown only after a real completed attempt. Old producers without metrics show
unknown, not zero. Process generation and observation clocks bound the counters;
cached or expired status is explicitly stale. Neither these metrics nor READY
prove advertisement accuracy, traffic coverage or confirmed remote deletion.

New readers accept both the original three-node telemetry and four-node telemetry.
Old open clients may require refresh after the static rollout because they reject
four nodes or an active count of four. Immediate consultation admission in the
retained `confirm-positive` policy, source deadlines and deletion guards remain
enforced; the selected deployment policy is `direct-4b`.

## Flags and first host rollout

All fourteen API roles must agree on these canonical dotenv values:

| Setting                               | Default            | Meaning                                            |
| ------------------------------------- | ------------------ | -------------------------------------------------- |
| `COMMERCIAL_LLM_POOL_WORKERS_ENABLED` | `false`            | Allow pool worker registration and readiness.      |
| `COMMERCIAL_LLM_POOL_ENABLED`         | `false`            | Route eligible enforcement work through the pool.  |
| `COMMERCIAL_LLM_POOL_4B_POLICY`       | `confirm-positive` | Explicit `confirm-positive` or `direct-4b` policy. |

Routing requires worker registration enabled. The separate
`COMMERCIAL_LLM_ENFORCEMENT_ENABLED` flag and per-chat eligibility still control
whether an input may enter commercial AI enforcement. Registration-only mode
does not itself submit production messages or establish classification quality.
Safety Desk reads the configured enforcement status namespace: legacy while routing
is off and pool-v2 while routing is on. Missing pool status never falls back to an
old legacy heartbeat; process generations and freshness retain their existing meaning.
It also starts the server node's readiness checks in the background role while
enforcement is off. The new PC and server can register before routing begins;
the existing 4B worker stays on the legacy path until routing is enabled.
Pool routing applies only to fresh ENFORCE work. Historical SHADOW observations
keep the legacy classifier path and never acquire deletion authority.

Finish the planner-selected local checks and require successful `Required` and
`Analyze JavaScript and TypeScript` on the exact deployment SHA. Use the ordinary
clean release checkout and guarded full API rollout. For the first stage:

```bash
MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED=true \
MAXIM_COMMERCIAL_LLM_POOL_ENABLED=false \
MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY=confirm-positive \
  ./infra/scripts/vps-connect.sh deploy main --auto
```

The three `MAXIM_` values are caller-only deploy overrides, protected from
`.env.vps`. Unspecified values retain the canonical dotenv setting. Any explicit
pool override selects all API roles, even at the same source SHA. Under the
ordinary persistent deploy lock and producer quiescence, the wrapper atomically
persists the complete resolved settings, recreates the API roles, and verifies
Compose and all fourteen runtime environments. Never edit one container's flags
or bypass the normal stopped-worker fence. Stores are not recreated.

The existing first-PC launcher, 4B weights, SSH key and
`commercial-llm workstation-bridge` command stay installed unchanged. When both
pool flags are true, that server-side entrypoint adapts its exact legacy wire
identity to `pc-a-4b` in the pool. It retains the legacy three-second request
ceiling and permits 512 bounded frames per minute. With routing off it selects
the original legacy path. Recreating the background role closes the old SSH
session; the existing supervisor reconnects and takes the selected path. Do not
install a second 4B launcher or replace its authorized key for this migration.

The new host operation is
`commercial-llm workstation-pool-bridge pc-a-4b|pc-b-9b|pc-a-cpu-9b`. It accepts
exactly one allowlisted identity and executes the compiled bridge in the attested
active `api-moderation-background` container. A worker hello cannot choose another
node, executable or container. This is a long-running framed worker transport,
not an interactive diagnostic command.

## Second-PC installation and startup

Use Linux or WSL under the account owning the pinned artifacts and the reviewed
`maxim-vps` SSH identity. Node 24, Python 3, `flock`, a compatible NVIDIA/CUDA
runtime and working strict host-key verification are prerequisites. On the new
9B PC, use a separate key restricted to the exact `pc-b-9b` host bridge and a
dedicated SSH alias. Install only its public key on the VPS through the first
PC's existing administrative connection; never copy the first PC's private key.
Keep the standalone 9B launcher for rollback. After the host registration stage
is ready, stop that exact owned process before starting the pool worker: both
use port 18084 and cannot share the port or GPU memory. This does not change or
stop the existing first-PC 4B worker.

The installer consumes existing files, verifies pinned sizes and SHA-256 values,
and copies them into a private per-node directory. It does not download weights.
The profile names all required GGUF/runtime/support archives in
`infra/scripts/commercial-llm-pool-profile.mjs` and its imported workstation
profile. Prepare only the matching node's verified artifacts. From the reviewed
checkout, for the second PC:

```bash
node infra/scripts/commercial-llm-pool-workstation.mjs install pc-b-9b \
  --artifact-dir /absolute/path/to/verified-artifacts --ssh-alias maxim-ai-pool-vps
~/.local/bin/maxim-llm-pc-b-9b start
~/.local/bin/maxim-llm-pc-b-9b status
```

The new 9B launcher uses an immutable installed script/runtime bundle and a
private local API key. Preserve the existing 4B launcher's lifecycle settings;
its protocol compatibility is provided on the VPS.
The model must pass identity, template and warm-up checks before READY. The PC CPU
worker additionally warms the exact production classifier prompt from a verified
immutable protocol snapshot before connecting. A failed primer does not advertise
capacity; a generic readiness JSON does not establish a warm classifier prefix. A
`started` result only confirms that supervision began; check subsequent local
status and host readiness separately. Neither warm-up nor READY is a labelled
advertisement evaluation.

For Windows, run the startup helper as the same Windows user who owns that WSL
distribution. Replace `Ubuntu` with the actual installed distribution name:

```powershell
.\infra\scripts\commercial-llm-pool-startup.ps1 -Operation Install `
  -NodeId pc-b-9b -Distro Ubuntu -Mode Startup
.\infra\scripts\commercial-llm-pool-startup.ps1 -Operation Status -NodeId pc-b-9b
```

`Startup` uses that owning user's Windows credential through Task Scheduler and
can start before interactive sign-in; its credential prompt must be completed by
that user. `Logon` needs no stored logon credential but starts only after sign-in.
The task runs a foreground WSL watch so Windows can detect and restart a failed
supervisor. Do not register as SYSTEM or point another account at the user's WSL
distribution. Passwords never belong in project files or shell commands.

After an unexpected shutdown, an enabled worker resumes, loads and warms the
model, then reconnects. It cannot be ready instantaneously at power-on. BIOS/UEFI
"restore after AC power loss" is a separate hardware setting; Windows startup
cannot switch on a powered-off PC. Sleep and Internet availability also affect
readiness and must be checked on each machine.

Manual stop is persistent, including across reboot:

```bash
~/.local/bin/maxim-llm-pc-b-9b stop
~/.local/bin/maxim-llm-pc-b-9b start
```

Only explicit `start` re-enables a manually stopped worker. `resume` and the
Windows watch preserve the disabled state. The startup helper's `Remove`
operation stops the exact owned worker and removes only its matching task.

## First-PC CPU installation

The owner requested an additional CPU 9B on 2026-11-07. Its canonical identity is
`pc-a-cpu-9b`. It uses the same pinned Qwen3.5-9B Q5_K_M weights and reviewed
llama.cpp b11804 runtime/support archives as the second PC. CPU execution sets
`--n-gpu-layers 0`, `CUDA_VISIBLE_DEVICES=-1`, six inference/batch threads and
process niceness 10. One 4096-token slot and the original 20-second request budget
remain enforced. These limits bound parallelism; measure actual CPU latency and
memory before claiming additional completed-message capacity.
The PC CPU requires at least 18 seconds of the original budget at reservation.
Closed local fixtures on 2026-11-07 took 2.6–11.0 seconds with prefix reuse and
14.7 seconds for the first classification. The production primer followed by a
2500-character classification under local QA load took 18.2 and 15.5 seconds
respectively; cold 2500-character input without the primer exceeded 20 seconds.
These small samples are not a p95 or sustained-load guarantee. Shorter remaining budgets can still use eligible GPU
nodes. The VPS CPU retains its independent six-second floor.

Install verified artifacts into its private per-node directory and use a new SSH
key restricted to the exact `pc-a-cpu-9b` bridge. Its port, API key, immutable bundle,
supervisor, launcher and Windows task are independent of the existing GPU 4B.
Do not stop or replace that GPU worker to install the CPU model.

```bash
node infra/scripts/commercial-llm-pool-workstation.mjs install pc-a-cpu-9b \
  --artifact-dir /absolute/path/to/verified-artifacts --ssh-alias maxim-ai-cpu9b-vps
~/.local/bin/maxim-llm-pc-a-cpu-9b start
~/.local/bin/maxim-llm-pc-a-cpu-9b status
```

For Windows sign-in startup under the owning user:

```powershell
.\infra\scripts\commercial-llm-pool-startup.ps1 -Operation Install `
  -NodeId pc-a-cpu-9b -Distro Ubuntu-24.04 -Mode Logon
```

`Logon` resumes only after sign-in and preserves manual stop. Installing the task
is not evidence of a tested reboot. Before activation require exact production
reader support, local warm-up, valid closed classification fixtures within the
source deadline, and a fresh GPU 4B availability/latency comparison. After activation
verify CPU registration and useful completed attempts independently. A fourth ready
slot alone does not prove throughput or classifier accuracy.

## Acceptance and routing activation

Before enabling routing, preserve evidence for the new PC and server node's
exact artifact/runtime identity, warm-up, registration and loss/recovery behavior,
and verify the existing 4B through its legacy path. Its pool registration can be
checked only after the routing rollout and automatic SSH reconnect. Exercise disconnect
while idle and busy, duplicate-session rejection, stale-answer rejection, model
failure, manual stop across reboot, and reboot before sign-in if `Startup` is
required. Use closed fixtures without MAX deletion authority. Do not send probes
to user groups or claim a complete reboot test from Task Scheduler registration.

Locally run the focused protocol/mailbox/bridge, real-Redis admission/lease,
workstation lifecycle and rollout tests. The production Compose change also
selects full repository validation through the existing impact planner. A
functional test does not replace independent model-quality evaluation. There is
no operator-facing end-to-end pool smoke command in this change; retain this as
an explicit acceptance gap until a reviewed closed harness is supplied.

After those gates and the exact-SHA release checks, enable routing while retaining
the initial quality policy:

```bash
MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED=true \
MAXIM_COMMERCIAL_LLM_POOL_ENABLED=true \
MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY=confirm-positive \
  ./infra/scripts/vps-connect.sh deploy main --auto
```

If enforcement is currently disabled, its separate guarded rollout switch is
also required; do not assume enabling the pool enables enforcement. Inspect
fresh node readiness and completed classifications separately from accepted
inputs, capacity skips, uncertainty and confirmed MAX delete effects. Record
latency by node and route, eligible coverage, consultation completion/skips and
availability gaps. An outage test must show that healthy nodes continue making
progress; an idle heartbeat alone proves no throughput.

## Downgrade and durable readers

To stop pool routing while keeping registered workers for diagnostics:

```bash
MAXIM_COMMERCIAL_LLM_POOL_ENABLED=false \
  ./infra/scripts/vps-connect.sh deploy main --auto
```

That returns enforcement and the unchanged first-PC bridge to their legacy
routing behavior after automatic reconnect. To disable both registration
and routing, supply both corresponding `MAXIM_` flags as `false` in the same
guarded rollout. Never clear admission keys, intents, proofs or queues to make a
transition look complete.

Pool effects carry durable source version 2 and the explicit policy identity
`commercial-pool-v2`. Both API rollback paths and connector bootstrap require the
legacy version-1 reader **and** the pool version-2 reader in the target source,
in addition to the existing proof/origin/deadline guard. Turning routing or
enforcement off does not remove that floor. Retain a compatible image before
enabling writers; if no retained image has both readers, use a compatible
fix-forward. A static-only rollback keeps its existing component scope.

The fourth-node writer hashes all four pinned profiles. Readers retain the exact
legacy three-profile identity for already issued version-2 and version-3 sources.
A legacy source cannot authorize a `pc-a-cpu-9b` result or proof. Both ordinary
and personal-sale proof guards enforce this capability boundary. The permanent
pool rollback/bootstrap floor requires these wired readers; disabling the fourth
node or routing does not make a pre-fourth-node API image compatible.
