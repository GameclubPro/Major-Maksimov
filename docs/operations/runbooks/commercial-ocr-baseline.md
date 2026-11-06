# Strict Commercial OCR Baseline

Commercial moderation is now text-only: `commercialAdsFilterEnabled` never schedules
image analysis. The mini app no longer presents commercial photo coverage. The
shared native pipeline remains available exclusively through the separately enabled
image stop-list. The retained commercial policy, metadata and certification readers
support historical evidence and bounded retirement; they are not a product entry point.

The historical baseline deleted strongly confirmed photo advertisements
in opted-in chats. It did not apply OCR-driven warnings,
mutes or bans. Two consistent OCR passes, critical-evidence confidence at least
900/1000, commercial score at least 90, complete album identity, safe-caption/script
vetoes and the immutable source/deadline checks remain mandatory.

## Release

Run local impact checks, real disposable PostgreSQL/Redis checks and exact-SHA CI.
Historical activation used the normal guarded deploy (do not reactivate it for
the text-only product):

```bash
MAXIM_COMMERCIAL_OCR_BASELINE=1 ./infra/scripts/vps-connect.sh deploy main --auto
```

The wrapper verifies the target's v5-capable worker and dispatch guard. The normal
shared-image transition acquires its release journal and globally quiesces webhook
producers, then stops old media analysis before atomically persisting only
`COMMERCIAL_OCR_ROLLOUT_MODE=baseline` and empty canary IDs in production `.env`.
All 14 effective and running API roles must match that authority and source version.
The native sandbox remains isolated, without network or secrets. Exact image and
native identity, language recognition, UDS raster, internal readiness and ordinary
API/static smokes must pass before the release manifest is recorded.

Baseline is an image-owned `BASELINE` authority, not a certificate or a made-up
Redis control. It binds release behavior, attested live native behavior and current
settings. `CERTIFIED` expansion keeps the independent temporal-corpus, trusted
signature and fresh exact-chat control gates. Native health or synthetic examples
cannot be represented as measured population precision.

## Read-only verification

Inside `api-media-analysis`, run the built
`apps/api/dist/apps/api/src/scripts/audit-commercial-ocr-images.js` with an explicit
`--lookback-hours 1..24`. It uses the bounded indexed production receipt scan,
at most 500 receipts and three unique photos, actual opted-in settings and the
native UDS client. Output is aggregate counts/status/latency and native identity;
it sends/deletes nothing and stores no photo URLs, contacts or OCR text.

## Disable and recovery

To disable commercial image analysis globally while retaining the text filter and
the independently configured image stop-list, use the exact-green normal release:

```bash
MAXIM_COMMERCIAL_OCR_OFF=1 ./infra/scripts/vps-connect.sh deploy main --auto
```

This selects all API roles even without a code diff, stops producers and media under
the ordinary release fence, and atomically persists `COMMERCIAL_OCR_ROLLOUT_MODE=off`
with an empty canary scope. Both effective Compose and all fourteen running roles
must agree. The off and baseline request flags are mutually exclusive. Retained
commercial-only jobs skip analysis, combined jobs run only independently enabled
purposes, and pending commercial delete intents lose their authority. No queue or
history is cleared. Native OCR remains available for the separate image stop-list;
`shadow` continues commercial analysis and is not a full disable.

The existing per-chat commercial-filter switch immediately removes both text and
photo authority, including pending commercial-only deletes. For an environment
emergency, `commercial-ocr-recover-shadow [--apply]` remains the guarded bounded
operator recovery. Its applied path stops producers/action before lowering the
environment authority and proves the exact release fence before restarting.

Both API rollback paths reject a target without the strict v5 baseline dispatch,
baseline-capable durable intent executor and live-native worker checks. Only the
commercial OCR intent mode maps `baseline` to execution; other rule modes retain
their own rollout controls. Earlier pending v4 commercial bindings are rejected
without deletion. Use a compatible fix-forward or reviewed compatible manifest;
do not weaken the rollback floor or bypass the webhook fence. Postgres and Redis
remain running throughout application transitions.

## Processing deadlines and diagnostics

Sandbox protocol v2 carries one Linux monotonic deadline for each operation.
Server, client and cheap probe require a bounded, valid `/proc/self/timens_offsets`
with zero monotonic offset before accepting this shared kernel clock.
Waiting and transport consume that budget; the server reserves 1000 ms for native
teardown and the validated response. The original event deadline still caps every
operation and BullMQ defer. An expired waiting request never starts native work or
recycles another request's process. Forced native timeout, active cancellation and
process-group teardown failure still recycle the whole isolated sandbox.

Docker `--probe` uses only the minimal UDS verifier and an image-owned, root-owned
0444 expected-fingerprint artifact generated after full native artifact validation.
It must attest the exact complete native identity and live instance. Server startup
and the media client's native verification remain mandatory; cheap readiness does
not replace either check or measure recognition quality.

The shared API image includes real sandbox queue, operation, pending bytes,
bounded wait/duration samples and fixed rejection counters in full OCR readiness.
Missing or stale queue/busy diagnostics are `null`, never fabricated zeroes.
`request_deadline_exceeded` and `capacity_exhausted` represent bounded backpressure;
they defer without consuming a transport retry or extending the event deadline.
Native execution timeout remains a terminal incomplete analysis. A local response
watchdog expiration is separately `request_timeout` / `ocr_request_timeout`: native
completion is uncertain, so it is terminal and must not become a safe queue retry. Boundary identity
or malformed-response failures remain fail-closed and do not become temporary
preprocessing outages. Recycle logs contain fixed reasons and aggregate values only.
They include the active encoded `payloadBytes`, validated recognition `psm` (6 or 11),
and validated `preprocessPass` (`primary` or `confirmation`); fields belonging to the
other operation are `unavailable`. These values identify the failed native stage,
not the source image, recognition quality or successful completion. Recognition
pass names and raster dimensions are not inferred from PSM or encoded byte count.
The diagnostic remains limited to 512 bytes with a 25 ms flush deadline; required
containment never waits longer for logging. This metadata does not change the UDS
request/response schema or reinterpret historical lifecycle evidence.

There is one production OCR consumer. Under `slow`, it admits at most one cache-miss
pass per governor retry interval; downloads and cache hits do not consume the slot.
Fresh `pause` decisions are checked before preprocessing and native dispatch.
Automatic queue-only degradation uses this bounded slow path after the governor's
host-pressure check, so one unrelated old webhook cannot indefinitely stop every
image analysis. Both Compose topologies explicitly enable
`BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED` for `api-media-analysis`; verify the
effective container flag after rollout. Keep its existing governor intervals and
thresholds when enabling this guard. Manual, MAX-only, mixed and unknown degradation
still pause; hard CPU/IO pressure also refuses the slow path. The original job deadline, single
consumer, native resource limits and final delete guards remain unchanged. A
completed primary pass stays in the exact content/version/profile cache when
confirmation is deferred; resumption still needs a complete confirmed result.
`event_to_terminal` measures event age at terminal completion separately from
per-attempt `end_to_end`. Completed BullMQ jobs alone do not prove complete analysis;
use `analysis.terminal.complete`, `analysis.terminal.incomplete`, native failure
reasons and deadline-exhaustion counters together.

Both preprocess profiles are v4 after enforcing the actual output pixel-area cap.
The grayscale/threshold transforms, two-pass deletion evidence and admission
reserve/authority/tombstones are unchanged. Shared raw raster reuse is deferred:
naive grayscale raw conversion drops alpha and can change 16-bit normalization.
