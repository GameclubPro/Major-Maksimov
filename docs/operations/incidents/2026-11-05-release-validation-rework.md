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
| A failed captured machine-plan call lost its stdout and had no phase label. | One preparation attempt returned 1 after the visible source-sync plan. The retained log could not identify its exact failing gate.                                                                           | Report fixed preparation phase/status and bounded admission reasons; preserve failure status and prohibit subsequent preload/runtime work. Cover failure contexts and real image-plan selection.                                                          |

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
