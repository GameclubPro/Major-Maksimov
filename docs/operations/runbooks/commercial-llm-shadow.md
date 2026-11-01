# Local commercial-ad model in shadow mode

For the optional three-node enforcement pool, its separate worker registration,
PC migration and unattended startup, see the
[commercial AI pool runbook](commercial-ai-pool.md). The existing first-PC 4B
launcher and key are preserved; its bridge adapts on the server when both pool
flags are enabled. The shadow installation commands below retain their existing
behavior. Pool routing uses its guarded all-API rollout.

The optional `gemma-commercial-shadow` service (a retained internal DNS name) runs the text-only Qwen3.5-9B
Q5_K_M model alongside MAXIM, Svyazka and Karavan. It supplies observations only.
The model never owns a MAX token, database, Redis connection, message deletion or
publication permission. Do not treat successful synthetic JSON as evidence of
Russian advertisement-classification accuracy.

## Isolation and immutable identity

- The official llama.cpp CPU image is pinned by its linux/amd64 manifest digest,
  upstream revision and Docker image ID in
  `infra/scripts/commercial-llm-profiles.mjs`. The production Compose contract and
  focused tests bind the same identity.
  Production Docker 29 uses its containerd image store, where the image ID is
  the pinned OCI manifest digest. The distinct config-blob digest is not a Docker
  image ID on this host. Installation checks the exact descriptor, repository
  digest, platform, upstream revision and version before creating the container.
- Text weights are exactly 6,577,841,376 bytes, SHA-256
  `dc2a39aef291f91a9116ad214058da0d86eb648743a124bd8c333787c4b9c91c`, from
  `unsloth/Qwen3.5-9B-GGUF` revision `3885219b6810b007914f3a7950a8d1b469d598a5`.
  The receipt's model-manifest digest binds the canonical pinned artifact descriptor
  (repository, revision, filename, byte count and checksum). The Apache 2.0 license
  is independently pinned. Vision and draft models are omitted.
- The GGUF's embedded chat template is used with `--jinja`; its 7,816 bytes must hash
  to `7f0e529032c25183bcd66c7f238da2d377f43be754a94e2725a58c4e16d2ed67` at `/props`
  before the installation smoke can succeed. Do not substitute a similar upstream template.
- The runtime has a 6 CPU quota, 6 inference and prompt threads, low CPU shares,
  12 GiB memory including swap, 128 PIDs, one inference slot and a 4096-token
  context. Generation is capped at 128 tokens. Thinking, context shifting, tools
  and the web UI are disabled. New installations enable private slot inspection;
  historical installations retain `--no-slots` until the guarded upgrade below.
  Slot save/restore, metrics and slot debug output remain disabled. Oversized prompts must fail as a
  technical error rather than silently dropping message context. The shared Redis
  lease permits one inference at a time and one admission per 10 seconds; pressure
  shedding remains mandatory. This is at most 8,640 admissions/day, not a throughput SLA.
- The service has no host ports. Its only network is the internal
  `infra_commercial_llm_internal` network; only `api-moderation-background` may
  share it. The API role retains its ordinary network separately. The model
  cannot use this internal network for Internet access.
- The single model mount is read-only. The process runs as UID/GID 1000,
  with a read-only root, a 64 MiB temporary directory, dropped capabilities and
  no new privileges. It receives no project env file or secrets.
- Artifacts and its atomic provenance receipt live under
  `/var/lib/maxim-deploy/commercial-llm`, outside Git and application store
  volumes. The auxiliary has its own receipt; it is not a fifteenth API role or
  a fourth application release component. Normal API releases preserve it.

## First delivery

Finish local checks, push through the standard staged commit helper and require
successful `Required` and `Analyze JavaScript and TypeScript` on the exact selected
SHA. Keep the release checkout unchanged while a wrapper uses it.

Run these operations sequentially from that clean, green checkout:

```bash
./infra/scripts/vps-connect.sh deploy main --plan
./infra/scripts/vps-connect.sh commercial-llm install
./infra/scripts/vps-connect.sh commercial-llm install --apply
./infra/scripts/vps-connect.sh commercial-llm status
./infra/scripts/vps-connect.sh commercial-llm enable --apply
./infra/scripts/vps-connect.sh deploy main --auto
```

The plan synchronizes the reviewed tools without replacing runtime containers.
Installation and flag changes independently require that exact clean remote
checkout and a valid ordinary application release manifest. Each mutation holds
the persistent protected deploy lock and obeys recovery/maintenance gates. The
installation never builds the API or starts, recreates or clears stores.

Installation checks available RAM of at least 32 GiB and free space for all
remaining artifacts plus the unlowerable 10 GiB application floor and a 2 GiB
image reserve on both the model and Docker filesystems. These readings are
admission snapshots, not peak-load acceptance. It downloads through HTTPS with a
16 MiB/s ceiling, a one-hour deadline and a 30-second heartbeat carrying the last
observed file size. An interrupted `.partial` file is retained and resumed only
under the same pinned checksum. Existing complete artifacts are always checked.
Image pulling has a separate 15-minute deadline.

The container must become healthy within three minutes, pass exact identity,
network and containment checks, then return complete constrained JSON for a
closed synthetic greeting. Only then is the immutable model/image/source receipt
written. A failed or missing sample is not a successful install. A different or drifted container, or any present malformed/foreign receipt, is
refused. An interrupted unrecorded singleton may be recovered only after all
pinned artifacts and its exact image, command, resource, network and mount
boundaries are rechecked. Recovery waits for and smokes that same generation
before writing a success receipt; it never fabricates an earlier successful
installation.

`enable` atomically changes only `COMMERCIAL_LLM_SHADOW_ENABLED=true` in the root
dotenv. It preserves other settings and refuses duplicate keys. It requires the
installed healthy model, its matching receipt and the closed synthetic smoke.
It does **not** change running API containers. The subsequent ordinary deploy
delivers the previously unreleased API/Compose change to all 14 roles under the
existing webhook fence and strict application/native smokes. Keep the original
code release pending until after installation and flag staging, so one normal
deployment activates the background consumer.

The model service does not gate ordinary API readiness. Model timeouts, malformed
JSON, full queues or host pressure must shed shadow work and preserve existing
moderation behavior. Observe the independently bounded shadow polling, technical
errors, drop reasons and host impact after deployment. Accuracy acceptance needs
independent human labels and separate false-positive/false-negative measures.

## Replacing the installed Gemma generation

After exact-SHA CI, synchronize this controller with `deploy main --plan`, then run:

```bash
./infra/scripts/vps-connect.sh commercial-llm replace
./infra/scripts/vps-connect.sh commercial-llm replace --apply
./infra/scripts/vps-connect.sh commercial-llm status
./infra/scripts/vps-connect.sh deploy main --auto
./infra/scripts/vps-connect.sh commercial-llm check-client
```

The replacement is finite: only the previously pinned Gemma generation can become
this pinned Qwen generation. Its exact old receipt, container, artifacts and
containment must match. The controller checks capacity and prepares verified new
artifacts before stopping anything. A checksum-verified evaluation download may be
copied from its fixed staging path; otherwise the pinned HTTPS download is used.

`qwen35-9b-transition.json` durably records the old receipt and the target identity.
Only the captured old container is stopped and removed, before creating the new
one. A successful receipt requires the new generation's readiness, embedded
template digest and closed synthetic smoke. Old weights, template, license and
receipt remain available on disk; they consume no running-model resources.

If interrupted, rerun `replace --apply` from the same exact green source. The
controller reconciles the journal and the positively attested singleton, including
interruption after removal, creation or receipt writing. A foreign receipt,
container or changed recorded generation is refused. It never removes another
container or rewrites transition evidence to force success. The prior controller
cannot manage a Qwen receipt; reverting the model requires a separately reviewed
reverse transition, not a raw Compose recreation or receipt edit.

The runtime alias changes to `qwen35-9b-commercial-shadow`. Until the normal API
release finishes, old clients reject that alias and may record bounded technical
failures; they cannot misattribute a Qwen result to Gemma. Inference remains shadow
only throughout. The API deploy preserves the already installed model container.

## Enabling private slot observation on an existing Qwen generation

The pinned llama.cpp b11804 `/health` route reports liveness and ignores
`fail_on_no_slot`. Only `/slots` exposes current slot occupancy. An HTTP 200 from
health cannot prove that a timed-out inference stopped. Keep pool routing disabled
until the corrected API adapter, CPU capability and PC acceptance checks are ready.
Docker health remains a liveness check; a busy model must not become unhealthy.

After exact-SHA CI, synchronize the reviewed controller with `deploy main --plan`:

```bash
./infra/scripts/vps-connect.sh commercial-llm upgrade-slots
./infra/scripts/vps-connect.sh commercial-llm upgrade-slots --apply
./infra/scripts/vps-connect.sh commercial-llm status
```

Preview attests the installed receipt, exact command, containment and singleton
container and reports the captured IDs and command digests. Apply holds the normal
protected deploy lock and checks artifacts, image identity and existing capacity
floors before stopping that captured generation. No model download, store change,
API flag change or additional port is involved. The new generation differs only
in enabling the private slot inspection endpoint.

Confirm the deployed pool routing flag is false before applying. The deploy lock
serializes host operations but does not stop ordinary legacy CPU consultations.
Replacing the optional model can interrupt such a computation; its uncertain
result cannot authorize a new action and its existing lease is preserved. A
concurrent consultation can also make the closed smoke fail. Preserve that failure
and resume the same journal after inspecting admission; do not restart blindly or
claim that an absent lease readback reserved exclusive capacity.

The separate `qwen35-9b-slots-transition-v1.json` binds the exact controller source,
both pinned command digests, original receipt and captured container IDs. The
existing `qwen35-9b-transition.json` is retained; when present it must be complete
and identify the original Qwen generation. Its historical Gemma-to-Qwen `replace`
operation and the base Compose service retain the original no-slots configuration.
Only the named new-install and slots-upgrade operations supply the reviewed command
override. Neither journal is reset or repurposed.

A successful slots receipt includes `runtimeProfile=qwen35-9b-slots-v1` and the
exact command digest. Success requires the same target container throughout
readiness, template verification, `endpoint_slots=true`, the existing closed
synthetic smoke and a bounded single-slot idle observation. Slot responses are
never printed; default slot debug is off. Historical receipts without these new
fields are accepted only with the frozen no-slots command. Unknown or incomplete
capability fields fail closed. Ordinary `install`, `stop`, `status` and `smoke`
understand both pinned configurations; `install` never implicitly upgrades an
existing generation. Only a new installation defaults to slots.

If interrupted, rerun `upgrade-slots --apply` from the same exact green source.
The journal reconciles stopped, removed, created and recorded generations and
refuses foreign IDs, command drift or receipt drift. Repeating a completed upgrade
does not replace the model again. Before removal, the captured old generation and
receipt remain available; after removal, never restore its old receipt because
its container ID no longer exists. This controller has no reverse transition.
Returning to no-slots after replacement requires a separately reviewed transition
with a new receipt and retained journals. A successfully recorded slots generation
can be stopped normally while preserving its evidence and artifacts.

Slot occupancy is a current observation, not proof that an ambiguous HTTP request
cannot still reach the model's task queue. A persistent CPU pool lease after an
uncertain result must remain held. This upgrade does not inspect, expire or clear
Redis leases and is not a pool quarantine recovery operation; recovery needs its
own proved model drain/replacement and exact lease ownership protocol.
The named [CPU quarantine recovery](commercial-ai-pool.md#recovering-a-quarantined-cpu-generation)
provides that separate protocol for the installed slots profile; it preserves the
original receipt and restarts the same captured model and dispatcher containers.

## Readback, stopping and rollback

```bash
./infra/scripts/vps-connect.sh commercial-llm status
./infra/scripts/vps-connect.sh commercial-llm smoke
./infra/scripts/vps-connect.sh commercial-llm check-client
./infra/scripts/vps-connect.sh commercial-llm disable --apply
./infra/scripts/vps-connect.sh commercial-llm stop --apply
```

Status reports only allowlisted provenance, limits, health and restart counts;
it never prints message text, prompts or secrets. Smoke sends only its fixed
synthetic input directly inside the model container and does not contact MAX.
The schema fixes the expected response, so this is a transport/grammar check,
not a semantic model evaluation. `check-client` binds the active shared API image
and the background role, then runs only the compiled standalone
`commercial-llm-shadow-smoke.js` script there. Its two closed synthetic classifier
cases exercise the actual prompt, parser and shared inference admission lease;
it does not contact MAX or write moderation outcomes. Its output is limited to
pass counts, model/prompt hashes and the two known synthetic case classifications
and durations. This is still not a representative accuracy
evaluation.

`check-client` failures emit a bounded JSON diagnostic with `schemaVersion: 1`,
`ok: false`, a finite `stage` and `code`, then exit nonzero. `ADMISSION_BLOCKED`
additionally reports an observation time and lease/cooldown states; the read-only
projection uses only the two fixed admission keys and returns no ownership token.
`HELD_PERSISTENT` identifies an existing physical CPU fence, even when model health
is green. It does not establish the original failure time or permit recovery.
Redis, ownership, model timeout/response and process failures remain distinct;
arbitrary child stderr and model output are never forwarded. Older API images
retain the existing successful result format, while unstructured failures become
`PROCESS_FAILED` without exposing their exception text.

The closed classifier smoke pins its own physical lease before HTTP. Only a
complete validated response or a definite no-HTTP refusal permits its release.
A timed-out or failed HTTP attempt retains the persistent fence and needs the
same named CPU recovery procedure as pool work. Neither diagnostics nor an idle
slot observation clears it. The existing inference and process time budgets are
unchanged.

Disable stages the flag as false for the next ordinary API deployment. Stopping
the model releases its resources immediately and preserves weights, receipts,
queues and the running API. A still-enabled client must fail open and shed its
shadow work. `install --apply` can restart the same attested stopped generation
after a fresh capacity check, artifact checks and smoke. It can also finish an
interrupted unrecorded install under those same exact checks. `stop --apply` may
stop that captured unrecorded generation only after complete containment and
artifact verification, and reports `unrecorded_generation_stopped` without
creating a successful-install receipt. Both paths recheck the container ID and
refuse generation replacement; neither removes a different generation to force
success. Model and license hashing each have a two-minute deadline.

Application rollback stays component-scoped through the normal release wrapper.
The optional inference service is independent; leaving it stopped does not
relax any installed API rollback reader floor. A model/image/template upgrade
needs new immutable pins, capacity admission, focused tests and its own reviewed
install procedure; never replace the pinned files or use a floating image tag.

Do not fine-tune on this shared host. Start with the pinned instruction model,
collect independent labels and consider an externally trained adapter only when
repeatable errors remain after prompt and example improvements.

## Focused validation

```bash
node --test infra/scripts/commercial-llm-runtime.test.mjs
```

The tests exercise the actual rendered Compose network/resource contract, reject
public exposure and containment drift, preserve unrelated dotenv bytes, reject
insufficient independent capacity, validate receipts and reject incomplete or
unexpected synthetic JSON. Run the planner-selected infrastructure checks and
normal exact-SHA CI before production operations.

## Optional GPU workstation first pass

The background shadow consumer can use a PC running the pinned Qwen3.5-4B Q5_K_M
CUDA runtime before the server's 9B. Both remain observations only: the ordinary
commercial filter and MAX actions never wait for either model. No fine-tuning or
change to deletion authority is part of this installation.

The PC initiates strict-key SSH to `maxim-vps`, invoking the reviewed
`commercial-llm workstation-bridge` command. The command attests the active
background API image against the immutable release manifest and starts only its
compiled Redis bridge. It holds no deploy lock during the session, opens no port,
loads no DB/MAX client and ends after 30 minutes or a missing heartbeat. The local
worker reconnects with bounded backoff. No reverse tunnel or sshd change is needed.

A dedicated Redis namespace has one worker lease, a six-second readiness heartbeat
and one request/response slot with a three-second total primary budget. Owner and
request nonce CAS reject stale workers, duplicate and late replies. There is no
BullMQ job or durable backlog. An unavailable PC is skipped immediately; saturation,
timeout or malformed output falls back once to 9B after a fresh governor, memory
and global inference-lease check. Pressure sheds the observation entirely. The
ordinary 10-second global admission, single selector and bounded recent-sample scan
remain in force; faster PC inference does not increase that admission ceiling.

All 4B `COMMERCIAL` and `UNSURE` answers require 9B confirmation. A random 10% of
4B negatives also goes to 9B for disagreement auditing. Other negatives retain the
actual 4B artifact/template/runtime provenance. The pipeline version and full
primary identity bind the sample fingerprint; no local result is labelled as 9B.
Synthetic accuracy does not establish performance on independently labelled live
messages, and model confidence numbers do not control routing.

### Install and operate the PC

`infra/scripts/commercial-llm-workstation-profile.mjs` pins the model, official
llama.cpp b11804 CUDA 12.8 archive and its CUDA support archive. Place those three
artifacts in `~/.local/share/maxim-llm/` before installation. Their filenames, sizes
and SHA-256 checks are mandatory. The model comes from
`unsloth/Qwen3.5-4B-GGUF` revision `e87f176479d0855a907a41277aca2f8ee7a09523`;
the two runtime archives come from the official `ggml-org/llama.cpp` b11804 release.
The local prerequisites are Linux/WSL, Node 24, Python 3, `flock`, `tar`, working
NVIDIA CUDA support and the existing strictly verified `maxim-vps` SSH alias.

```bash
node infra/scripts/commercial-llm-workstation.mjs install
~/.local/bin/maxim-llm start
~/.local/bin/maxim-llm status
~/.local/bin/maxim-llm stop
```

The installer verifies artifacts, extracts an isolated runtime and copies an
immutable script bundle; it never uses the active source checkout for a running
supervisor. Startup verifies installed files and symbolic links and the embedded
chat template. The loopback endpoint `127.0.0.1:18084` requires a private random
API key file. One 4096-token GPU slot, four CPU threads, 128 output tokens and
thinking-off match the measured workstation profile. Model logs are disabled;
status stores only phase, heartbeat, success time, counters and process identity.
No message excerpts or responses are persisted locally.

A failed or timed-out inference ends that SSH session and stops/reaps the exact
owned model before restart. Linux parent-death signals also contain orphaned
children if the supervisor exits unexpectedly. Singleton `flock` and PID start
identity protect start/stop. `stop` disables future automatic resume; `start`
re-enables it. A Windows user-logon entry can call
`wsl.exe -d Ubuntu-24.04 --exec /home/yourname/.local/bin/maxim-llm resume` without
passwords, elevated tasks, forced wake or changed sleep settings. `resume` respects
an explicit stop. A sleeping/offline PC leaves the server fallback available.

Deliver the API and host controller through normal exact-SHA CI/deployment first.
After local start, validate the closed synthetic cascade through:

```bash
./infra/scripts/vps-connect.sh commercial-llm check-workstation
~/.local/bin/maxim-llm stop
./infra/scripts/vps-connect.sh commercial-llm check-workstation-offline
~/.local/bin/maxim-llm start
```

The host checks load the reviewed `commercial-llm-workstation-smoke.cjs` harness
through stdin inside the attested API container. It imports the actual compiled
classifiers and ordinary global lease, waits at most 30 seconds for admission,
and classifies only two built-in synthetic examples. Before each online example
it waits at most two seconds for the PC readiness heartbeat to return. This is a
synthetic-test precondition: two examples share one lease and arrive faster than
the normal ten-second production admission. Production requests still fall back
immediately when the PC is unavailable, and their three-second budget is unchanged. They exercise primary-negative,
secondary-commercial and offline-secondary routes without MAX calls or review-row
writes. Finish with one connected status and fresh content-free shadow observation;
retain any admission/coverage gaps rather than treating an old heartbeat as success.

The SSH bridge allows at most 160 inbound control frames per minute. Thirty primary
starts produce 90 readiness/response frames; periodic readiness contributes 40 and
the initial handshake one. The remaining 29 frames cover delivery timing at the
window boundary. This control-frame budget does not raise inference admission or
the single-request limit. Oversized, malformed and foreign frames still end the
session, and a frame flood still clears only that worker's expiring mailbox state.

Focused native coverage includes `commercial-llm-workstation.redis-integration`,
`commercial-llm-workstation-bridge`, the cascade routing tests and existing
`commercial-llm-shadow-postgres` cases through the public API test commands and
`with-test-stores.mjs`. Local protocol/process tests run with
`node --test infra/scripts/commercial-llm-workstation.test.mjs`.
