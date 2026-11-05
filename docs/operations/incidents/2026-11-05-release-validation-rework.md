# Release validation rework, November 5, 2026

The Night mode change removed operator diagnostics from the mini app and added opt-in deletion
of the opening announcement after an eligible participant message. Its delivery exposed gaps in
validation order, release compatibility tests, browser time handling and preparation diagnostics.
The feature is in [PR 493](https://github.com/GameclubPro/Major-Maksimov/pull/493); the compatibility
and browser corrections are in [PR 494](https://github.com/GameclubPro/Major-Maksimov/pull/494).

## Confirmed causes and corrections

| Cause                                                                       | Observed result                                                                                                                                                                                              | Permanent correction and coverage                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guarded file size was checked after lint rather than in preflight.          | One local submission failed after 55 seconds on a file exceeding its existing ceiling.                                                                                                                       | Share the size checker with preflight; preserve the same ceiling and full refactor checks. Cover the exact limit, one line above it and side-effect-free import.                                                                                          |
| Scoped verification ran infrastructure before API validation.               | A later submission failed after 8 minutes 45 seconds on TypeScript errors; infrastructure alone had already consumed 368.9 seconds. Focused Jest used isolated modules and did not prove caller type safety. | Run the existing selected API aggregate before infrastructure, keeping its public codegen lock and one typecheck. Preserve selected suites, migration review and full aggregate coverage.                                                                 |
| Protected-prefix fixtures treated current source as the installed baseline. | A new rollback reader was inserted into protected bytes. The installed source guard refused delivery after CI had passed.                                                                                    | Keep the reader after the protected pause and cleanup trap, before rollback effects. Pin all four actual installed prefix digests and test the ordering. See [the source-floor regression](../../../infra/scripts/release-service-source-floor.test.mjs). |
| Browser polling smoke mixed browser and host clocks.                        | CI failed with `Cannot fast-forward to the past` after browser time had already advanced. A browser 30 seconds ahead reproduced the failure.                                                                 | Derive the pause target from browser time and start the ordinary smoke 30 seconds ahead of the host. Focused and full desktop/narrow browser smoke passed with that condition.                                                                            |
| Every executable infrastructure path selected the full application graph.   | PR 494's four-file rollback/docs correction selected all API, PostgreSQL, mini app, admin and Docker lanes despite its files being excluded from image inputs.                                               | Use an exact reviewed host-path set and retain core plus both infrastructure shards. Cover mixed application changes, unknown paths, Docker inclusion drift and frozen-plan tampering.                                                                    |
| Preparation hid captured machine-plan output and lacked phase diagnostics.  | One preparation attempt returned 1 after the visible source-sync plan. The retained log could not identify its exact failing gate.                                                                           | Report fixed preparation phase/status and bounded admission reasons; preserve failure status and prohibit subsequent preload/runtime work. Cover failure contexts and real image-plan selection.                                                          |

The guarded size and API-order changes apply to the demonstrated scoped submission path. The
full aggregate retains the order of its public root script. The host CI exception begins with
three explicit paths; other infrastructure and shared inputs keep the full fallback. PostgreSQL
coverage continues through the selected API/native lanes; Redis infrastructure fixtures alone
do not establish PostgreSQL coverage.

## Release observations and unresolved evidence

All times below are UTC. The first source-admission refusal at 02:51:43 happened before source
switch, image pull, migration or runtime transition. A readback confirmed the preceding component
manifest and API source `524e389929d20b442caa211782e13680da414739`.

The preparation attempt at 04:04:30–04:04:50 synchronized the controller to
`29e00e2918deb0b724ba9c354d6d505893caf8f4`, then returned 1. Its component manifest remained
unchanged and valid. Separate bounded source-plan, machine-plan and actual captured-transport
probes subsequently passed. These observations do not establish the original failure's cause;
a transient admission refusal is only a hypothesis. The failed attempt remains unresolved at
that level of detail.

After those checks, the normal guarded release ran at 04:13:25–04:21:40 and completed with strict
smokes and manifest `release-20261105T041707Z-29e00e2918de`. All four component sources matched
the selected SHA. One identity/availability readback confirmed fourteen API roles, both native
auxiliaries and the static components. Database and Redis checks passed; the store containers
retained their prior generations. Readiness recovered within the existing budget. The later
health sample still described automatic stabilization, so it does not prove a completed recovery
window or all bot functions. No live MAX chat acceptance scenario was performed.

## Costs that remain part of the release contract

The successful original local aggregate took about 19 minutes: API Jest consumed 500.2 seconds
and infrastructure 367.8 seconds. Its API, contracts, Prisma, UI and release changes selected
those suites. The early checks reduce wasted work on invalid inputs while preserving that scope.

The main CodeQL job for `1406b1448212034255580ca0153ab6eb99946158` took 23 minutes 12 seconds.
Its log attributes about 195 seconds to extraction, 57 seconds to finalization and 18 minutes
6 seconds to query execution; result export, upload and processing consumed the short final
phase. The PR job on the same tree took 4 minutes 4 seconds using the cached overlay path.
The default branch refreshed the full overlay base. These are different workloads; the retained
evidence does not justify reducing security scope or removing the exact-SHA gate.

The preventive CI-policy change itself requires full CI and a new compatible main baseline.
Future reviewed host-only changes can omit unrelated application lanes. That selected scope is
testable immediately; a measured total release-time improvement requires a later comparable run.

## Native fixture costs exposed by the preventive checks

The first complete preventive CI run on `642f406c8870c35d4bfa4f96fccef833a33a65bd`
retained both infrastructure shards and all application/native/image lanes. CodeQL and the
other selected jobs passed, but `Required` correctly refused two existing test timeouts:

- The cross-author recompressed-photo Redis scenario exceeded its five-second test budget.
  Its log does not identify the expensive phase. The fixture rendered the same image corpus
  repeatedly and opened Redis/BullMQ objects before asynchronous image preparation completed.
  Prepare the unchanged synthetic bytes once in bounded suite setup, before allocating clients;
  preserve fresh per-case state, real image verification and the five-second scenario budget.
- The PostgreSQL temporal-selection fixture exceeded its 60-second parent setup hook before
  selection assertions began. Preparing 50,000 stale parents and 5000 retained parents took
  4.51 seconds for occurrences and 57.40 seconds for broadcasts. The existing 500-row statement
  batches opened 110 transactions and repeated local planner settings. Execute the same bounded
  statements in one transaction per phase, preserving all rows, triggers, constraints, initial
  statistics and statement/hook/selection budgets. Native multi-statement success and rollback
  cases verify that local planner settings do not escape into selection.

These changes remove demonstrated repeated fixture work. The retained logs do not establish
which operation exhausted the photo budget or why the broadcast phase cost 57 seconds on that
runner. Keep those limits of the diagnosis separate from subsequent local and CI results.

The focused local PostgreSQL 16/Redis 7 run passed all 140 cases in the complete temporal-selection,
duplicate-flow and recompression test files without skips. The 55,000-parent phase completed in
2.47 seconds, including 1.16 seconds for broadcasts; recipient setup took 1.75 seconds and selection
assertions 0.72 seconds. The public runner confirmed owned-store cleanup. These local timings
establish coverage within the retained budgets, not a comparison against a different CI machine.

The next CI run on `f842c23a87c9ff3d8c39d2ddbab5e720f8e06d7c` passed the complete Redis
photo suite, but exposed an omitted boundary in the new batched PostgreSQL fixture: Prisma's
default five-second transaction budget. Three 50,000-row phases rolled back at that boundary;
the existing statement and hook budgets had not expired. Give fixture transactions an explicit
20-second budget within the unchanged hook limits. A real PostgreSQL fixture statement taking
more than five seconds must commit and restore local settings; later failure must still roll
back the full batch. Keep this fixture-only budget separate from production transaction limits.

That run also caught `publication-list.browser.mjs` reading one page immediately after a second
response, where it expected two. Its response helper relied on a fixed 50 ms pause before reading
the DOM. Wait for the exact rendered state instead. The browser harness deliberately delays
query notifications by 100 ms and exposes pending notifications and completed list-cache entries.
The stale-response check waits for the old query to settle and notifications to drain before
asserting that the current filters and cursor remain intact. The editor's negative no-request
window still exceeds its search debounce; the production UI and polling policy stay unchanged.

With that notification precondition, the unchanged old browser script reproduced the same
one-versus-two assertion; the corrected public browser case passed pagination, stale-response and
editor/calendar sections. The complete PostgreSQL file passed 52 native cases without skips;
its same-connection transaction/rollback regression took 5.22 seconds, crossing the old boundary.
