# Agent Workflow Audit — 3 November 2026

## Scope And Evidence

Source: `a281d582e73dbf86d30b3ec2b4fc676c670caab9`. Inspected root and scoped guidance,
documentation routing, public npm validation chains, local impact selection, staged submission,
CI classification/Required, test inventories and recent CI job timings. This is a development
workflow audit, not a claim of exhaustive runtime dead-code or production-state analysis.

Earlier documentation cleanup is already in PRs #442, #444 and #446. Those changes removed
superseded plans and consolidated active requirements; repeating their deletion would add no value.
There were seven instruction entry files and 239 tracked Markdown files at the audited source.

Baseline [CI run 41630609511](https://github.com/GameclubPro/Major-Maksimov/actions/runs/41630609511)
used PR source `da6305f613119e90711fd1a9dec344ff5f8928cb`. Times below are observed job durations,
not additive release time or a future performance guarantee.

| Finding                                                      | Observed evidence                                                                                                                                      | Correction                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Full local checks repeat infrastructure tests                | `check` invokes `check:static` (core plus all infra tests), then `check:infra` (the same infra tests again); 219 infrastructure test files at baseline | Use core static aggregate before infrastructure; inventory guard requires every file once                                |
| Local agent changes select every application and image in CI | Every non-Markdown path under `scripts/` triggers full CI, even context navigation and task ownership                                                  | Exact reviewed local-tool paths select mandatory Static; shared helpers, policy, generators and new paths retain full CI |
| API is the longest sequential CI lane                        | API: 1,108 s; its `check:ci`: 955 s; Redis step: 118 s                                                                                                 | Four ordinary Jest partitions plus one types/build/storage/Redis job; retain public locks and every required phase       |
| Superseded CodeQL runs consume runners                       | CI cancels previous PR runs; CodeQL has no matching concurrency policy                                                                                 | Cancel only superseded runs of the same PR; retain main and scheduled runs                                               |
| Exact focused checks are easy to miss in entry guidance      | The supported adapter is documented in a linked machine contract while root guidance only says “focused tests”                                         | Put the exact repeatable `focused.mjs --test` route in root instructions and README                                      |

Other baseline durations: Static core 127 s, infrastructure partitions 322/379 s, miniapp
partitions 715/802 s, Docker API 446 s. Native PostgreSQL CI already uses eight isolated shards
and a compatibility group. Increasing local process concurrency would not preserve fixture and
generator isolation; this change leaves those limits intact.

## Regression Evidence

Real Git fixtures reproduce the local-tool over-selection, mixed changes and rename boundaries.
The local full-inventory test reproduces duplicate execution. All three failed before correction.
The focused workflow/selection/aggregate tests passed after correction (46 cases).

Actual public `test:ci --listTests --json` selected 1,056 tests. Calling that same public wrapper
with each of the four shards selected 264 tests per shard; their union equals the unpartitioned
selection with no duplicates. This proves selection and argument forwarding, not execution.
CI execution, including native cases, remains the acceptance gate for the new matrix.

## Retained Boundaries And Remaining Limits

- `legacy`, recovery and rollback files are not automatically unused. Current webhook code still
  calls legacy-hold readers, and rollback compatibility protects persisted state. Removing them
  requires the applicable retirement proof; no such proof follows from their names or age.
- No inactive worktrees, private logs, production queues, migrations or rollback floors were
  removed. Their ownership and retained-state obligations are separate from source cleanup.
- Shared-tooling and infrastructure CI remains conservative. Extending the local-only exception
  requires caller/consumer evidence and a regression that retains mixed-change coverage.
- Miniapp browser CI remains substantial. Browser scenario deletion or further splitting needs
  scenario-level duration/isolation evidence; the existing mobile matrices remain complete.
- No reusable green cache, changed-file-only Jest inference or cross-checkout dependency copying
  was introduced. Exact-SHA Required and CodeQL, staged-input guards and native coverage stay
  authoritative. Maintained commands live in the development references, not this dated record.
