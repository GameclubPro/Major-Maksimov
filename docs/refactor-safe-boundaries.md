# Safe refactoring boundaries

The program preserves public API responses, callback payloads, queue envelopes, stored jobs,
authorization and the order of side effects. Runtime slices use reviewed commits, exact-SHA
CI, scoped deployment and rollback-compatible observation windows.

For the source assessment and prioritized future microgoals as of 1 November 2026, see
the [safe refactoring roadmap](operations/plans/2026-11-01-safe-refactoring-roadmap.md)
and its linked audit. The release observations below retain their original scope and dates.

## Starting evidence

The API/UI baseline is `e4c960ad46369a68409b656efe7632f62adeec18`. Both required GitHub
checks passed. A fresh worktree installed the lockfile with Node 24.16.0 and ran
`node scripts/agent/with-test-stores.mjs --migrate -- npm run check` successfully.
The API reported 695 passing suites and 14,965 passing tests, with one skipped suite/test.
The mini app reported 1,451 passing tests and Safety Desk 21. Tooling's two opt-in skips
and the API skip are not claimed as test coverage. Production dependency audit reported
zero advisories. No original-worktree changes were copied into this baseline.

The production-origin mini app build measured these route budgets (gzip KiB, rounded):

| Route                      | JavaScript |  CSS |
| -------------------------- | ---------: | ---: |
| Startup                    |      123.7 | 33.5 |
| Chat settings, incremental |      142.8 | 71.5 |
| Publications, incremental  |      139.4 | 17.3 |

Rebuild with the same `VITE_API_BASE`, lockfile and budget definitions for comparisons.
Queue-lag samples are not HTTP latency measurements.

## Implemented boundaries

- `check:refactor-guards` also checks runtime context factories and legacy compatibility
  ports. All 16 initial unsafe-context exceptions have been removed. New unsafe bridges,
  direct legacy imports and unapproved import cycles fail the existing checks. Never
  regenerate a growing exception baseline.
- Private settings search, summaries and buttons are pure functions. Their rendering corpus
  was captured from the baseline before extraction and passed against that implementation.
  Formatting is separate from Nest-dependent input parsing. The private facade retains
  callback/session orchestration and uses the same pure callback payload builder.

## Release discipline

For each slice, add missing behavior/race tests before moving the boundary; shrink the legacy
guard and relevant context exceptions afterwards. Real-store cases run through the public
validation wrappers. Browser scenarios exercise user actions and request results in addition
to architectural source checks. Retain current release source floors and observe strict
smokes plus at least 10 minutes of runtime health before the next production slice.
The initial 30-minute observation minimum was reduced to 10 minutes at the user's explicit
request during rollout; earlier observations retain their actual duration and findings.

## Recorded production releases

The structural refactors and separate search optimization have completed scoped production
rollout. The ledger covers accepted observations through PR 69, with a final cutoff of
08:05:18 Moscow time on 4 October 2026. Acceptance includes the specific limitations below;
it is finite observation evidence and does not establish continuing error-free operation.
Each listed release passed the exact-commit CI gates and strict smokes. API slices deployed
the shared image to all 14 API roles and the OCR sandbox; standalone UI slices deployed
only `miniapp-major-static`.

| PR / component                                                                                                           | Source commit                                                                                        | Release manifest                        |             Accepted observation | Maximum sampled queue lag |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------: | ------------------------: |
| [54](https://github.com/GameclubPro/MAXIM/pull/54) / API                                                                 | [9fd857f471d6](https://github.com/GameclubPro/MAXIM/commit/9fd857f471d671f6cb41cc1ada42f9e01ecf4625) | `release-20261003T185011Z-9fd857f471d6` |         36m 21s / 73 API samples |                    9.996s |
| [55](https://github.com/GameclubPro/MAXIM/pull/55) / API                                                                 | [22be4400481a](https://github.com/GameclubPro/MAXIM/commit/22be4400481ac0bb967803509e86e5f3982a01e2) | `release-20261003T193110Z-22be4400481a` |         30m 05s / 60 API samples |                    2.570s |
| [56](https://github.com/GameclubPro/MAXIM/pull/56) / API                                                                 | [945075348af9](https://github.com/GameclubPro/MAXIM/commit/945075348af966e410567cb9e8fabb2f95d6a831) | `release-20261003T205936Z-945075348af9` |         31m 47s / 63 API samples |                    2.266s |
| [57](https://github.com/GameclubPro/MAXIM/pull/57) / API                                                                 | [f85449536baf](https://github.com/GameclubPro/MAXIM/commit/f85449536baf81697dce724bab7ba84a2be0dd8a) | `release-20261003T213538Z-f85449536baf` |         30m 29s / 61 API samples |                    1.326s |
| [58](https://github.com/GameclubPro/MAXIM/pull/58) / API                                                                 | [7f3f3c4cc1d1](https://github.com/GameclubPro/MAXIM/commit/7f3f3c4cc1d13e877bfa0f8692a7cd822320e789) | `release-20261003T224143Z-7f3f3c4cc1d1` |         30m 38s / 61 API samples |                   19.498s |
| [59](https://github.com/GameclubPro/MAXIM/pull/59) / API                                                                 | [23c52425a2bb](https://github.com/GameclubPro/MAXIM/commit/23c52425a2bb2cf87be9ba559e1d1bff2dc88a3a) | `release-20261003T233039Z-23c52425a2bb` |         30m 33s / 61 API samples |                    1.169s |
| [60](https://github.com/GameclubPro/MAXIM/pull/60) / API                                                                 | [d0c2988970f5](https://github.com/GameclubPro/MAXIM/commit/d0c2988970f57d9c16565792b2c2e4302bb175d2) | `release-20261004T000442Z-d0c2988970f5` |         35m 05s / 70 API samples |                   19.765s |
| [61](https://github.com/GameclubPro/MAXIM/pull/61) / UI                                                                  | [92bc991cdc07](https://github.com/GameclubPro/MAXIM/commit/92bc991cdc07aa6126f8ac490708dc28265e53da) | `release-20261004T004333Z-92bc991cdc07` | 34m 00s / 68 API + 69 UI samples |                    9.661s |
| [62](https://github.com/GameclubPro/MAXIM/pull/62) / UI                                                                  | [ec781068494a](https://github.com/GameclubPro/MAXIM/commit/ec781068494aabc68e558c70f1955e03d50b5ea5) | `release-20261004T011903Z-ec781068494a` | 15m 17s / 31 API + 31 UI samples |                    1.797s |
| [63](https://github.com/GameclubPro/MAXIM/pull/63) + [71](https://github.com/GameclubPro/MAXIM/pull/71) / API, UI, admin | [bc3f8343c34c](https://github.com/GameclubPro/MAXIM/commit/bc3f8343c34c3b9b90fed9182a967c3e9f02a158) | `release-20261004T022954Z-bc3f8343c34c` | 13m 20s / 27 API + 27 UI samples |                    1.873s |
| [64](https://github.com/GameclubPro/MAXIM/pull/64) / UI                                                                  | [e239e8bc5954](https://github.com/GameclubPro/MAXIM/commit/e239e8bc5954728a037a6e2b19b2b0d8951141dc) | `release-20261004T032226Z-e239e8bc5954` | 10m 22s / 21 API + 21 UI samples |                    1.907s |
| [65](https://github.com/GameclubPro/MAXIM/pull/65) / UI                                                                  | [92f8ed960426](https://github.com/GameclubPro/MAXIM/commit/92f8ed9604263b197d1bf7c7ef56fdd284978c1b) | `release-20261004T033819Z-92f8ed960426` | 10m 26s / 21 API + 21 UI samples |                    1.060s |
| [66](https://github.com/GameclubPro/MAXIM/pull/66) / UI                                                                  | [ef1cd6e6909d](https://github.com/GameclubPro/MAXIM/commit/ef1cd6e6909deb045dfce607e0e2bf6ad8a18b2c) | `release-20261004T035309Z-ef1cd6e6909d` | 15m 37s / 31 API + 31 UI samples |                   27.569s |
| [67](https://github.com/GameclubPro/MAXIM/pull/67) / API                                                                 | [83b2eb3593b0](https://github.com/GameclubPro/MAXIM/commit/83b2eb3593b0022e28983e566888a9e7954d0c1b) | `release-20261004T041113Z-83b2eb3593b0` | 13m 49s / 27 API + 28 UI samples |                   18.485s |
| [69](https://github.com/GameclubPro/MAXIM/pull/69) / API                                                                 | [ff8d3ac868bc](https://github.com/GameclubPro/MAXIM/commit/ff8d3ac868bcdcc5ef5f66d3c3afe7b623b4011a) | `release-20261004T044602Z-ff8d3ac868bc` | 13m 45s / 27 API + 28 UI samples |                    1.476s |

All accepted windows had complete sample coverage and ended in `normal` / `healthy` state.
For PRs 54–62 and 64–67, readiness, fleet topology, queue-fence and critical-lag checks passed
within those windows, and restart counters did not increase. PRs 63 and 69 have the audited
OCR containment exceptions described below. The UI probes for PRs 61–67 and 69 passed page/JavaScript
availability, expected-image and container checks, with one stable asset fingerprint per
release. These probes establish delivery health; user-interaction coverage comes from the
browser scenarios described below.

Observed failures and transient conditions remain part of the release record:

- PRs 54–61 had respectively 23, 1, 9, 10, 11, 10, 33 and 13 stabilization-mode samples
  in their accepted windows. Their aggregate reports were `degraded`; a healthy final
  sample does not make the whole window continuously healthy.
- PR 57 had an earlier readiness HTTP 503 and 30.124s queue lag, followed by the separate
  accepted window shown above. PR 58 had unavailable fleet telemetry, then recovered; this
  was not evidence of a topology mismatch. Its accepted window included one 19.498s lag
  warning and ended with 11 minutes in normal mode.
- PR 60 had one noncritical action failure in its first observed 60-second window, with
  no recurrence in later samples. Two lag warnings, 19.765s and 10.182s, recovered. The
  observation was extended to 35m 05s. Bounded diagnostics did not establish a cause.
- Before PR 62's accepted recovery window, the OCR auxiliary recycled three times for
  `native_timeout` containment. One probe temporarily classified the recovering auxiliary
  outside the expected fleet and reset its aggregate restart count; the later return to
  three was not three additional restarts. The 14 API roles did not restart. An isolated
  action-failure interval coincided with a MAX 404 marker and a private rules-confirmation
  warning; later, two overlapping 60-second samples each reported two critical action
  failures. Overlapping samples cannot be added as distinct failures. Causes and linkage
  to the UI change were not established. The accepted recovery window, 05:03:00–05:18:17
  Moscow time on 4 October, had no failed checks, action failures or additional restarts.
- PR 63's accepted window, 06:07:59.580–06:21:20 Moscow time on 4 October, remained
  `degraded`: seven stabilization-mode samples, one auxiliary topology failure and an
  aggregate restart increase of five. Independent audit established two OCR `recognize`
  containment recycles for `native_timeout`, at 06:13:21.537 and 06:14:25.667. The aggregate
  counter sequence `2 → 3 → 0 → 4` explains the reported increase; it does not represent
  five new restarts. All 14 API roles retained their exact images and had zero restarts;
  readiness, queue-fence, lag, UI and sampled action checks passed. The sandbox recovered
  its required isolation and passed the existing Russian/English raster smoke over its
  Unix socket at 06:20:06. Acceptance was a narrow exception for audited containment
  required by the existing implementation, with verified recovery. It does not permit
  unexplained restarts in other releases. The timeout cause remains unknown and unfixed.
  An earlier PR 63 window had one containment recycle and two overlapping samples with one
  noncritical action failure each, without established causality. The monitor then ended
  normally; the telemetry gap after 06:02:01 until the fresh window is excluded from health
  evidence.
- PR 64's 06:22:58–06:33:20 Moscow-time window had no failed core or UI checks and no
  restarts. It contained one real critical manual-moderation cleanup failure at 06:25:51,
  observed in two overlapping samples. The internal limiter rejected the request before
  MAX dispatch with `max_api_internal_rate_limit` and a 46ms retry-after value. No further
  action failures were observed after 06:26:59. The evidence does not establish an automatic
  retry or completed deletion, and no causal link to the UI-only feed/calendar change was
  established.
- PR 65's 06:38:40–06:49:06 Moscow-time window had no failed core or UI checks and no
  restarts. One critical `ECONNRESET` at 06:43:13.503, tagged `moderation_delete`, appeared
  in two overlapping 60-second samples; all subsequent samples from 06:44:29 had zero
  action errors. That tag covers both a remote guard GET and a DELETE request, so the
  exact operation stage, deletion outcome and retry outcome are unconfirmed. The reset's
  cause is unknown, and no evidence links it to the UI publication-actions extraction.
- PR 66's window extended from the 10-minute minimum to 15m 37s to observe natural recovery
  after queue-lag warnings of 27.569s and 17.018s. The aggregate report remains `degraded`,
  including 24 system-mode warning samples. Readiness, fleet, queue-fence, critical-lag and
  UI checks passed; no action failures or restarts appeared in its samples. The final
  sample was normal and healthy. Causes of the spikes were not established or attributed
  to the UI change. After the accepted cutoff at 07:09:12 Moscow time, the 07:09:29 sample
  reported three critical failures in its preceding 60 seconds. A recovered marker at
  07:09:19.853 establishes one internal-limiter rejection before MAX dispatch; it cannot
  independently explain all three failures or their outcomes. Later replacement of the
  old containers limited the available diagnostics. No retry or deletion recovery is
  established, and the accepted window's counters do not prove error-free operation
  through handoff.
- PR 67's initial observation included two required OCR timeout-containment recycles at
  07:25:16 and 07:27:51 Moscow time, with a brief media-readiness HTTP 503. All 14 API roles
  had zero restarts. The existing isolation and Russian/English Unix-socket smoke passed
  at 07:29:11, followed by an isolation attestation at 07:29:31. These checks establish
  recovery of the sandbox; the timeout cause remains unknown and has not been fixed by
  this refactor. The initial degraded report is retained. The accepted fresh recovery
  window, 07:29:32–07:43:21, lasted 13m 49s with 27 API and 28 UI samples. It had no core or
  UI check failures, action failures or further restarts, and ended normal and healthy.
  One 18.485s lag warning and 11 system-mode warnings recovered; the aggregate recovery
  report also remains `degraded`. Later, during the transition to PR 69, the aggregate
  restart count increased from two to three between 07:45:29 and 07:45:58. The restarted
  role and reason are unconfirmed. This event falls outside PR 67's accepted window and
  is not covered by its stable-window result.
- PR 69's accepted 07:51:33–08:05:18 Moscow-time window lasted 13m 45s, with 27 API and
  28 UI samples. Core, topology and UI checks passed; all 14 API roles kept their exact
  images and had zero restarts. The aggregate report remains `degraded`, with eight initial
  system-mode warnings and one real OCR sandbox restart. At 08:00:29.224, a `recognize`
  `native_timeout` triggered containment required by the existing implementation. This was
  an actual interruption of OCR availability, even though the periodic core samples missed
  the startup transition. Strict isolation and the Russian/English Unix-socket smoke passed
  at 08:03:25, with a healthy isolation attestation at 08:03:45. OCR and infrastructure
  sources were unchanged from PR 67; the timeout cause remains unknown. Acceptance used
  a narrow audited containment exception with verified recovery, without changing generic
  restart gates. The final state was normal and healthy.
  Three distinct real action failures remain recorded: an external HTTP 403 `chat.denied`
  during profile-read enrichment at 07:51:47, and separate critical internal-limiter
  rejections before MAX dispatch during manual cleanup at 07:53:59 and 07:57:40. Six
  overlapping nonzero counter windows are not six distinct events. Later zero counters
  do not prove successful retries, completed deletions or a successful enrichment result.
  Two Redis-timeout warnings triggered in-memory rate-limit fallback at 07:55:52 and
  07:56:30; those markers do not establish a global Redis outage. No causal link from
  these failures to the pure-search optimization, or repair of their causes, is established.

The release IDs identify immutable component manifests for the standard `rollback-release`
workflow. Static-only releases preserved the deployed API image and did not run migrations.

PR 63's rules-editor boundary subsequently reached production together with the independently
authorized [speech-style PR 71](https://github.com/GameclubPro/MAXIM/pull/71), in manifest
`release-20261004T022954Z-bc3f8343c34c` at commit
[bc3f8343c34c](https://github.com/GameclubPro/MAXIM/commit/bc3f8343c34c3b9b90fed9182a967c3e9f02a158).
That combined release updated API, mini app and Safety Desk and passed strict smokes,
including OCR isolation. The attempted standalone PR 63 deployment was refused before
runtime mutation after concurrent advancement of `main`; no separate PR 63 release is
claimed. The accepted observation and its limitations are recorded above.

The test-only [PR 68](https://github.com/GameclubPro/MAXIM/pull/68) merged at
[56dd31fa443f](https://github.com/GameclubPro/MAXIM/commit/56dd31fa443f252a3c17919558c16178b246ea55)
and requires no runtime deployment. Structural runtime observations through PR 67 are
accepted with the limitations above. The final API optimization in PR 69 deployed as
`release-20261004T044602Z-ff8d3ac868bc`, at source
[ff8d3ac868bc](https://github.com/GameclubPro/MAXIM/commit/ff8d3ac868bcdcc5ef5f66d3c3afe7b623b4011a).
All 14 API roles and the OCR sandbox passed strict readiness, isolation and Russian/English
Unix-socket smoke checks. Its final observation ran from 07:51:33 to 08:05:18 Moscow time
and was accepted with the findings above. This runtime matches the locally validated
integrated tree at `31f18c0a7d4f`; only merge ancestry changed, so the full local matrix was
not repeated. This report changes documentation only and requires no additional deployment.

## Implementation footprint and validation

The coordinator sizes and initial validation, bundle and search measurements describe the
refactor implementation before integration of the concurrent
[speech-style change in PR 71](https://github.com/GameclubPro/MAXIM/pull/71). That independent
change touches the settings screen and contract catalog. The integrated validation below
checks both sets of changes and records its measurements separately.

The listed responsibilities now have independent dependencies and behavioral coverage.
The remaining legacy shells still coordinate other domains; their size alone is not a
completion criterion and does not justify a broader rewrite.

| Existing coordinator    | Baseline lines | After extraction |
| ----------------------- | -------------: | ---------------: |
| Admin service           |         23,817 |           22,773 |
| Moderation service      |         18,819 |           18,668 |
| Private control service |          9,841 |            9,555 |
| Chat settings page      |          8,235 |            7,411 |
| Publications page       |          3,019 |            2,007 |

Full local validation with disposable PostgreSQL/Redis after the structural changes passed
705 API suites / 15,133 tests, all 50 retention/storage checks, 1,451 mini app tests and 21
Safety Desk tests. The existing API skip and tooling's two opt-in skips remain exclusions
from coverage. The isolated search optimization also passed the full API verification.
New closed-chat competition/restart cases are explicitly included in the CI PostgreSQL lane.

Browser scenarios cover delayed replies, failed/conflicting saves, draft restoration,
publication request identities, upload cancellation, keyboard visibility and native Back.
Actual page scenarios use the MAX Bridge shim and iPhone/Android viewport emulation in both
themes, plus desktop and compact iPhone layouts. Physical devices were not tested.
MAX sends in regression scenarios use isolated fixtures.

With the same production API origin and unchanged budget configuration, the final structural
build measured these route budgets (gzip KiB, rounded):

| Route                      | JavaScript |  CSS |
| -------------------------- | ---------: | ---: |
| Startup                    |      123.7 | 33.5 |
| Chat settings, incremental |      145.4 | 71.5 |
| Publications, incremental  |      141.1 | 17.2 |

The existing budget checks, including their existing tolerance, passed. No bundle limit,
schema, saved-job format, contract export or dependency lockfile was changed by this program.

## Integrated validation with the speech-style change

The combined runtime at
[31f18c0a7d4f](https://github.com/GameclubPro/MAXIM/commit/31f18c0a7d4fe0dd59b1f07c15b2c51cb5d88598)
includes all refactor slices through the search optimization and PR 71. It was merged into
the report branch as
[18fc9636c720](https://github.com/GameclubPro/MAXIM/commit/18fc9636c72074921ff14a0d71f8aa9017ff0833),
with identical runtime content. One full
`node scripts/agent/with-test-stores.mjs --migrate -- npm run check` passed on Node 24.16.0
with disposable PostgreSQL 16 and Redis 7: 706 API suites / 15,175 tests, 50 retention/storage
checks, 1,457 mini app tests, 21 Safety Desk tests, 696 tooling checks and 579 infrastructure
checks. The existing API skip and two opt-in tooling skips remain excluded from coverage.
Safety Desk browser smokes passed for desktop and narrow layouts. No runtime repair was
needed for this integration.

The integrated production-origin build passed the same bundle budgets and tolerance,
with these measured sizes (gzip KiB, rounded):

| Route                      | JavaScript |  CSS |
| -------------------------- | ---------: | ---: |
| Startup                    |      123.8 | 33.5 |
| Chat settings, incremental |      142.9 | 71.5 |
| Publications, incremental  |      138.4 | 17.2 |

These sizes include the independent speech-style implementation. Their difference from the
structural measurements above cannot be attributed solely to the refactor. Local integrated
validation and production observation provide separate evidence; the accepted release
windows and their limits are recorded above.

## Allowlist and rules dependency boundary

The allowlist and rule-text runtimes now accept explicit capabilities. Their composition in
`AdminService` preserves lazy access to constructor-owned clients, cache identity and method
receivers. Rules no longer expose arbitrary property reads/writes or require `as any` calls;
obsolete forwarding methods and copied unused imports have been removed. The unsafe-context
baseline shrinks from 16 to 14 exceptions. No new cache or persistence format is introduced.

Before changing the boundary, 37 focused tests passed on the old implementation, including
new denial/no-I/O and transaction/audit/cache ordering cases. Runtime tests construct these
components independently of `AdminService`. Release verification remains per PR.

## Participants and statistics state ownership

Participant pages, channel statistics and activity dashboards own their response maps and
pending refreshes inside their runtimes. The assembly supplies typed authorization, profile,
client and cross-domain feed capabilities. Participant details reuse the same runtime as
participant lists; no caller constructs a fresh runtime from a legacy object. Pure date,
number, profile and participant-query helpers no longer call back into `AdminService`.
The unsafe-context baseline shrinks from 14 to 11 exceptions. Cache keys, TTLs, authorization
on cache hits and identity checks before failed-promise eviction are preserved.

Before extraction, the focused service/runtime suite passed 465 tests. Existing behavioral
cases remain; obsolete context-forwarding tests now cover only the remaining capabilities.
Additional independent channel-statistics cases exercise concurrent reads, revoked cached
access, late failure after invalidation, per-channel invalidation and refresh coalescing.

## Managed entities access and snapshot ownership

Discovery snapshots and coalesced allowlist reads now have one owner with two explicit
capabilities: runtime-scope filtering and the existing uncached loader. User/type keys,
TTL boundaries, clone behavior, first-entity-wins ordering, actor-wide invalidation and
late-rejection identity checks remain unchanged. Access denial mutations live with access
pruning and retain the exact Major bot scope. Refresh presentation is a standalone function.
The managed-entities facade port declares independent signatures; unsafe-context exceptions
shrink from 11 to 8. Full discovery orchestration and SQL query policy remain unchanged.

Before transfer, 84 focused tests passed, including seven new snapshot/cache cases. After
transfer, 506 focused tests passed across service, access, discovery and snapshot boundaries.
Independent access-runtime tests cover bot-scope isolation, live capability replacement,
blank identity and best-effort persistence failure. Release verification remains per PR.

## Manual actions and required-subscription capabilities

Manual moderation and required-subscription runtimes now receive explicit capabilities.
Manual notice identity, persisted-result interpretation, error classification and summaries
use independent functions. The group-mute follow-up calls its own runtime directly rather
than round-tripping through a legacy forwarding method. The existing external lease boundary
is unchanged. Delivery-bot capabilities explicitly describe their existing null/undefined
fallback, and ledger views describe the metadata already returned by persistence.

Required-subscription headers reuse the existing equivalent header builder. Catalog merging
accepts an explicit bot-normalization capability and preserves row order, bot scope and
metadata precedence. Neither domain adds a cache or changes queue/ledger/persistence formats.
Unsafe-context exceptions shrink from 8 to 6. The focused suite passed 468 tests; independent
manual-notice cases additionally verify claim/attempt/send/receipt order, duplicate claims,
lost MAX replies and failed receipt commits. Existing independent subscription epoch/race
cases remain active. Full release validation is required for this slice.

## Broadcast and suggestion delivery capability boundary

Broadcast and suggestion-delivery runtimes receive explicit lazy capabilities. Broadcast
throttle timestamps now belong to each runtime; governor and system-mode warnings retain
one shared 60-second suppression interval within that runtime. Suggestion recovery retains
the existing job identifier, eight attempts, exponential backoff and failed/completed-job
retry behavior.

Broadcast button construction has a separate typed dependency boundary. Chat/channel row
ordering, comments/suggestion flags, bot scope and copied persisted button rows are checked
without constructing `AdminService`. The legacy test facade no longer forwards four private
broadcast methods through `any`; existing occurrence and reconciliation scenarios invoke
the owning runtime. Unsafe-context exceptions decrease from six to four. Persisted
publication, delivery, callback and queue formats remain unchanged.

## Dialog and suggestion capability boundary

The remaining dialog mapping, suggestion image and suggestion publication contexts now use
explicit dependencies. Parsing, attachment classification, reactions and stored actor
identity are pure functions; generic value readers are shared without importing the manual
moderation runtime. The dialog facade declares independent signatures using the existing
contract types. All 16 original unsafe-context exceptions have now been removed.

An 89-case corpus captured from the compiled legacy class protects normal and malformed
payload interpretation. Independent tests cover viewer/admin permissions and required
versus legacy image storage. Existing suggestion publication scenarios retain crash,
ambiguous-send and bot-scope coverage. Explicit composition exposed two previously hidden
type mismatches: review synchronization returns a count, and published suggestion text is
always HTML or Markdown. Types now express those existing results; the unreachable plain
fallback is removed without changing generated content or ledger digests.

## Required-subscription UI ownership

The required-subscription controller owns source lookup, refresh state, locally resolved
headers and source-selection actions. The page retains the settings draft; functional
updates preserve unrelated edits. Lookup replies carry chat, generation, request and input
identity, so navigation, unmount and subsequent input invalidate stale effects. Failed
lookup and a full selection reached during lookup preserve the entered link. Server
refreshes no longer discard metadata for unsaved external sources.

The browser suite runs against the extracted controller and real source-input component,
asserting request bodies, delayed success/error, navigation, duplicate clicks, concurrent
draft edits, selection limits and error retention. It also opens the actual settings route
on iPhone/Android in light/dark themes. CI runs this suite in the existing Mini App lane.
Existing mini app tests and production gzip/CSS budgets remain required.

## Settings draft and section-save ownership

`useSettingsDraft` owns the settings draft, hydration baseline, field errors, permission
retry and section conflict state. Section saves retain the source chat and a per-visit
identity, including navigation away and back to the same chat. Cache updates remain scoped
to that source; UI effects require the current visit. The draft present at submission is
kept separately from the normalized request payload, preserving edits made during a save
without discarding prepared stop-word inputs. Saved stop-word buffers clear only if unchanged.

The existing section merge and revision rules, stop-word endpoint and permission rollback
remain in use. Conflict presentation retains the latest draft, including edits made while
waiting. Browser cases cover real PATCH bodies, network failures, version conflicts,
background refresh, late replies, a repeated visit and navigation during conflict refresh.
The existing leave guard receives a setter bound to its originating visit. Speech-style
completion uses the same scoped synchronization. No layout or contract format changes.

## Rules editor ownership

`useSettingsRules` owns the rules draft, validation, image-preparation gate, hydration baseline,
autosave timer, publication mode and reset confirmation. It reuses the existing serialization,
button validation, automatic text generation and save-before-publish comparison. Each network
operation carries its originating visit and chat; stale completion updates/invalidate only
that chat's cache and cannot publish after navigation or show messages on another screen.
Image callbacks and the workspace leave guard use the same scoped draft setter.

Independent browser scenarios cover PUT payloads, edits during autosave, failed-save retry
suppression, navigation between save and publication, late publication results, duplicate
clicks and missing publication links. The real settings route also exercises native image
selection, decoder failure/cancellation, editor closing, save/publish gating, keyboard focus
and native Back across iPhone/Android light/dark and a desktop viewport. These browser suites
run in the existing CI lane; no production chat is used for test publication.

## Publication feed and calendar boundaries

The publication list controller owns URL filters, search debounce, cursor queries, legacy
list presentation and list navigation. Calendar availability has its own target scope,
publication exclusion and daily range refresh. Query keys, limits, polling intervals,
cursor merging and enablement conditions are unchanged; the editor still uses the existing
composer and request identities. A page-size guard prevents the extracted responsibilities
from returning to the page.

Browser scenarios assert server cursors, explicit load-more, filter-specific pagination,
late-query isolation, query suspension while editing, calendar target/exclusion payloads
and filters after editor return. Existing profile-separation and video-upload scenarios
remain required; the new list suite is included in CI.

## Publication action boundaries

The action controller owns cancel/pause/resume, retry-version selection, ambiguous delivery
confirmation and their pending targets. It receives the existing page request-identity owner;
identities survive errors and are cleared only after success, independently per action slot.
Revision conflicts retain the original refresh and feedback behavior. Confirmation sheets
preserve their ordering around publication details, pending guards and native Back handling.
Browser checks exercise actual payloads, duplicate-click prevention, retries after a lost
response, revision conflicts and original/latest content selection through the real API client.

## Publication editor session boundary

The editor session composes the existing local composer and cloud autosave controller. It
owns edit/create/import context, the isolated-edit baseline and saved create draft, close
confirmation, route changes and focus return. The page still owns save/test request identities,
media upload cancellation and submission validation. A successful isolated publication clears
only its matching saved cloud draft before restoring the create draft.

Browser cases cover dirty close/keep/discard, local edits rebased onto a fresh revision,
missing-image restoration, failed opening and local recovery after a failed cloud flush.
The existing direct video-upload browser scenarios retain the real page coverage.

## Closed-chat message moderation boundary

`ClosedChatMessageModerationService` receives explicit intent, semantic claim, guarded-delete,
event and logging capabilities. Chat-only selection, immunity and fresh access checks retain
their positions in the existing event handler. The service preserves intent-before-claim,
execution/event ordering, exact reason keys/metadata and the previous exception boundaries.
Thin legacy delegates keep existing entry-point tests and method interception compatible.

Independent tests cover night/timed/permanent close, storage failures, duplicate claims,
already-absent/unconfirmed outcomes and intent-owned events. The explicit PostgreSQL race
lane also runs the closed-chat suite with real intent persistence, semantic claims and Redis
wakeups, including restarts before/after the claim and execution disabled after persistence.

## Measured static search optimization

Private settings search now precomputes frozen descriptors and aliases for the 113 static
catalog fields. Queries still receive independent mutable result objects, the original
ordering and the same result limit. No user settings, query results or request state are
cached; runtime catalog mutation is not used by this application.

Reproduce the comparison with
`node --import tsx apps/api/src/scripts/benchmark-private-settings-search.ts`.
The benchmark compares the previous algorithm with the current renderer on 352 identical
queries, verifies deep equality and caller-mutation isolation, warms both implementations
for five passes, then alternates nine samples of 7,040 calls. With Node v24.16.0,
after other local builds had finished, the median changed from 1324.182 ms to
113.569 ms per sample (11.66 times faster pure search computation). This is not an API
latency claim. The cost is one process-local static descriptor index, initialized once;
SQL/MAX calls, freshness rules and shared service caches are unchanged. Existing renderer
compatibility and isolation tests remain required. Keep this optimization in its own release
so its rollback does not undo the structural extraction.

The same benchmark was repeated on the integrated runtime at `31f18c0a7d4f`, using Node
24.16.0 and the same 113 fields, 352 queries, warmups and alternating samples. The median
changed from 1363.162 ms to 113.568 ms per sample (12.00 times faster). This repeat confirms
the pure-search computation gain after PR 71 integration; it does not measure API latency.

The heavy publication editor, review, details, drafts and schedule modules already load lazily.
No further frontend split or API read cache is included without a measured benefit.
