# Development And Release Reliability

## Scope

This plan addresses reproducible development and release failures, not unmeasured production
performance. It changes no moderation policy, database schema, or rollout switch. Participant
reports retain their separate [activation and live-smoke requirements](operations/runbooks/participant-reports-rollout.md).

## Implemented Controls

| Failure mode                                                 | Control                                                                                                                                    | Acceptance check                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Contract rebuild removes `dist` while Vite reads it          | Both Vite dev configs resolve exact public exports to existing TypeScript sources; production keeps package exports                        | Alias coverage test, frontend builds, local browser smoke during a contracts rebuild    |
| Visual tests silently reuse an unrelated server              | Default capture/audit allocate an unused local port, start their own Vite with `--strictPort`, and verify its instance header and app HTML | Occupied-port, wrong-identity, stalled-response and explicit-reuse tests                |
| Formatter changes byte-exact generated output                | `.prettierignore` excludes generator-owned output                                                                                          | Prettier file-info test and generator checks                                            |
| Generator drift is found late                                | Read-only preflight checks contracts mappings, OCR identity, deploy mapping and HTTP input signatures                                      | Preflight runs before impact verification and at the start of CI Static                 |
| Raw HTTP input is trusted because of a TypeScript annotation | AST check requires `unknown` for new/changed Nest `Query` and `Body` inputs, except supported validating primitive pipes                   | Alias/namespace, unvalidated union/object, handler-change and baseline tests            |
| Staged verification tests different worktree code            | Reject unstaged/untracked non-Markdown inputs and partially staged selected files; recheck index tree after each verification command      | Temporary-repository tests for partial staging, untracked files and mid-run index edits |
| VPS GitHub SSH port 22 is unavailable                        | Explicit per-deploy transport selection preserves remote SSH identity and host verification                                                | Transport tests cover bootstrap, identity, invalid inputs and CI ordering               |

## Daily Workflow

Native capture also reapplies its frame-only geometry after scenario navigation/reloads and checks
that the preview scaffold is absent before saving. A scenario reload must not produce a framed
emulator image labeled as a native-layout success.

1. Read the scoped notes and inspect the worktree. Keep unrelated changes separate. Use
   `node scripts/agent/context.mjs --path <file>` before editing to locate the relevant guidance.
   For behavior changes, follow the [evidence procedure](development/behavior-evidence.md):
   distinguish confirmed requirements, confirmed defects and unresolved intent before choosing
   test expectations. Existing code or a passing test alone does not prove intended behavior.
   Use `node scripts/agent/doctor.mjs --browser` only when setting up the environment. The
   [local environment guide](development/agent-local-environment.md) includes disposable native
   PostgreSQL/Redis validation when a Docker daemon is unavailable.
2. Run `node scripts/agent/preflight.mjs` before expensive suites. It is an early error check, not
   release approval; it neither builds nor repairs generated files automatically.
3. Use focused tests while editing. Run the indicated generator if preflight reports stale
   output, then inspect the generated diff.
4. Use `node scripts/agent/plan.mjs --worktree` to determine checks, migrations and deployment
   scope. Finish focused regressions before staging only intended paths, with their tests and
   generated output.
5. Submit from the task branch with `./infra/scripts/local-commit-push.sh "commit message"`. Staged verification allows
   unrelated Markdown notes but refuses different executable inputs. This mandatory helper owns
   the final impact aggregate: run it once after the edit stabilizes. If other runtime work must
   remain unstaged, submit from a separate worktree; do not stash someone else's work.
6. Wait for both exact-SHA `Required` and `Analyze JavaScript and TypeScript`. Use the normal
   scoped deploy wrapper, then verify its strict smokes and release manifest.
7. Queue, effect or recovery changes require the affected native fault experiments, including
   final independent execution while an unknown predecessor remains fenced. An admission-only
   test or mock-only pass is insufficient. Keep the quarantine suite in Required CI and the
   delayed Redis reply-after-commit case in the blocking Redis lane. For durable new scheduling
   states install compatible readers before writers and retain a compatible rollback image.
   Evaluate closed all-status cohorts and the sustained observation window after activation;
   report isolated work separately from success. See the
   [quarantine release plan](operations/plans/2026-10-12-webhook-quarantine-isolation.md).

Local screenshots and visual audits start an isolated owned server by default. An explicit
`MINIAPP_SCREENSHOT_BASE_URL` or `MINIAPP_VISUAL_AUDIT_BASE_URLS` keeps its requested port and
fails if that port is occupied. Reuse is deliberate: set `MINIAPP_SCREENSHOT_REUSE_SERVER=1` or
`MINIAPP_VISUAL_AUDIT_REUSE_SERVER=1`. Reuse checks the dev app HTML, but does not attest its
revision. Owned servers use a per-process identity and terminate their own process group;
unrelated servers are never stopped. Arbitrary remote/production audits remain explicitly selected.

When the VPS cannot reach GitHub on port 22, use:

```bash
MAXIM_DEPLOY_GIT_SSH_PORT=443 ./infra/scripts/vps-connect.sh deploy main --auto
```

The transport accepts only `default`, `22`, or `443`, requires a GitHub SSH origin for an override,
and uses the VPS `GIT_SSH_COMMAND`, `core.sshCommand`, or `GIT_SSH` identity in that order. It does
not print/copy keys, modify SSH/Git configuration, accept new host keys, weaken CI/SHA gates, or
retry a partially executed deployment. The wrapper carries its reviewed helper into the remote
shell, including on the first deployment to older tooling. A missing trusted host key requires
operator verification, not disabling host-key checks.

## Feature Review Checklist

- Parse HTTP input with a bounded runtime schema before property access, decoding, pagination,
  or service calls. Test missing, duplicate, array, object and oversized parameters. TypeScript
  annotations alone are not validation. The AST check is not a taint analyzer or a replacement
  for CodeQL; `unknown` still needs a real schema, not a type assertion.
- `scripts/api-http-input-baseline.json` records legacy signatures, not approved security
  exceptions. Its handler digests prevent silently changing those handlers while retaining a
  trusted input type. Migrate a changed handler to `unknown` plus validation and remove its
  exception; do not regenerate a growing baseline. Guards, headers, path parameters and custom
  request objects still need review outside this narrow check.
- Every mutation route needs its intended guard, access checks, mutation-tunnel allowlist where
  applicable, denial tests and frontend transport coverage. Do not infer admin access in the UI.
- Durable asynchronous actions need a recorded decision, execution-time guards, crash recovery,
  idempotent dispatch, truthful partial/ambiguous outcomes, and restart/race tests. Design receipt
  retention separately from temporary dispatch-ledger retention; test expiry and cleanup.
- History scans require bounded indexed keyset pages with fixed time boundaries. Review the
  migration's lock, concurrent-index, timeout and invalid-index recovery behavior on representative
  local data. During a slow production migration, use only the approved read-only audit catalog;
  do not retry deployment or issue repair SQL without establishing its state.
- For hot-path SQL, measure rows, loops and sorting on representative real-store history, including
  nonmatching rows and correlated probes before/after the limit. Keep due work progressing while
  retained recovery pages advance. The [3 October queue review](operations/incidents/2026-10-03-queue-backlog.md)
  records why correct results on small mocked datasets missed expensive plans.
- Include mobile light/dark, safe-area, scroll and keyboard checks for changed UI flows. Run local
  visuals against the worktree before an explicitly selected production-origin smoke.
- New enforcement remains opt-in behind an execution-time switch. Preserve rollback source floors
  for persisted jobs and verify every shared API role when that image changes.

## Long-Running Agent Work

Keep one primary implementation or release stage active, with a concrete result and acceptance
checks. Read-only monitoring may continue independently. Finish the stage before opening another
runtime workstream unless a dependency or production incident requires it. Reuse a suitable clean
checkout; never change a checkout while its validation, deployment or monitor wrapper is running.

### Worktree Ownership And Completion

Before editing, record the checkout's initial changes with
`node scripts/agent/task-worktree.mjs start /absolute/private/task-state.json`. The parent directory
must exist outside the checkout and Git metadata. Use a new path for each editing task/checkout;
the command refuses to overwrite an earlier baseline. It records checkout/branch identity, the
starting revision, changed paths, Git object identities and content hashes, never source contents.
Keep this baseline with the private task record through resumptions, not in Git. Record the actual
implementation checkout; a dirty or stale source folder is not an implementation baseline for a
different worktree. Use a suitable clean isolated checkout when inherited changes overlap the task
or another writer is active. Read-only audits need no editing baseline.

After submitting owned changes and before reporting completion, run
`node scripts/agent/task-worktree.mjs check /absolute/private/task-state.json` from that same
checkout. The check permits byte-identical inherited staged, unstaged and untracked changes, and
new completed commits. It rejects new unfinished files (including Markdown), changes to inherited
content or staging, renamed/deleted inherited files, incorporation of inherited work into a commit,
another checkout or branch, and rewinding/replacing the starting history. It also checks executable
bits and symbolic links. Unsupported non-file entries fail explicitly. The check neither stages
nor repairs anything.

Do not label a file "someone else's" just because it remains dirty. Establish what was present at
the start, what this task changed and what remains unresolved. Missing initial evidence cannot be
reconstructed from a final `git status`; report that gap. Do not reset, stash, delete or bulk commit
unrelated work, or replace the baseline to make the check pass. New concurrent changes also need
reconciliation; their appearance alone does not establish ownership. If the user explicitly asks
for uncommitted edits, report the unfinished paths and requested handoff instead of claiming this
completion gate passed.

A passed ownership check proves preservation and reconciliation of the observed worktree only.
It does not establish authorship, test coverage, push/merge, exact-SHA CI, deployment or production
acceptance. Report those gates separately. A commit helper's successful push does not close them.

### Incident Delivery

An active user-facing incident takes priority over optional refactoring. Record one next recovery
result, the exact blocking gate, its owner and the next executable action in the existing private
task record. Classify additional findings as either required for that action or follow-up work.
Before another diagnostic, state which unresolved gate its result can change. Reuse the reviewed
command, collector and evidence already available; introduce a new adapter only for a demonstrated
gap in that gate. Do not restart planning merely because the context was compacted.

Use the first bounded diagnostic pass to select a minimum safe recovery path and name its remaining
gates. If it cannot establish a path, report the concrete missing evidence and the next bounded
probe. At each completed stage, check whether the next action advances that recovery result.
Elapsed time without a smaller scope, a resolved gate or a deployed correction requires narrowing
the investigation and explaining the blocker, rather than expanding the plan. An observation of
healthy infrastructure does not close a complaint about blocked chats or missing publications.

Before a long validation or commit/push wrapper, verify the actual public command and its argument
forwarding, existence and effective CI selection of new native suites, and fixture cleanup/order
compatibility with the affected existing suites. Run the focused cases through those public entry
points first. A proposed test list or a successful mocked case does not establish native coverage.
After a failure, reproduce and fix its narrow cause before another broad attempt. Do not interrupt
a valid broad run for unrelated improvements; interruption is warranted when its inputs, safety or
required coverage are invalid. Preserve the actual exit and cleanup proof when it is interrupted.

One observer owns each long operation or CI run. It records the latest successful sample, deadline
and terminal outcome in the existing task record; other agents consume that evidence instead of
starting duplicate polling or collectors. When waiting is the only release gate, continue only
independent work that cannot invalidate the selected source or delay the ready release. Status
updates should state new evidence, the remaining blocker and the next action; distinguish an
estimate from a measured duration.

Replace the current status when a stage finishes or the selected SHA changes. Move the completed
chronology out of current fields, keeping its evidence links in a dated record. At handoff there
must be one current stage, one selected revision and no stale RUNNING or old-head CI fields.

Evaluate the next stage by time to the first verified recovery, first-pass validation, repeated
failures of the same cause and diagnostics that resolved a named gate. Aim for one successful
broad pass after focused validation and no repeat of a known failure. These are process targets,
not permission to skip exact-SHA CI/CodeQL, native regressions, required scope authorization,
deploy locks, rollback compatibility or unknown-effect fences. The
[19 October review](development/agent-incident-throughput-review-2026-10-19.md) records the evidence
behind these changes; its historical durations are not release estimates.

`npm run check:docs` checks tracked and nonignored Markdown throughout the repository, including
scoped instructions and historical directories. It validates local Markdown links/images and
heading anchors, executable examples and Compose service names; external URLs are not fetched.
It rejects symlink targets and paths outside the checkout. Keep private/ignored artifacts out of
documentation links. It also enforces this project's guidance budgets: 8 KiB for root entry notes,
16 KiB per scoped entry and 24 KiB across an ancestor chain. These are repository maintenance
limits, not a claim about Codex's configured context limit. Keep domain detail in linked references
selected by a routing table; moving it does not make its safety constraints optional.

Before the expensive validation:

1. Confirm the checkout, branch, source revision, owned diff and required tool versions. Preserve
   unrelated changes and inspect only the instructions and code needed for this stage.
2. Find callers and test doubles of changed methods with `rg`. A changed return value, queue
   acknowledgement or error contract affects integration fixtures as well as unit tests. Type
   shared doubles against the real method, for example with `satisfies Pick<Service, 'method'>`;
   do not silently treat `undefined` as a successful durable handoff.
3. Verify named test files exist and select the affected full-path cases from the relevant
   runbook. Run focused type/static checks and native PostgreSQL/Redis regressions first.
   Keep cold connection/setup budgets separate from short queue-wait assertions; do not raise
   production deadlines to accommodate a test fixture.
4. Let the mandatory commit helper run the final impact-selected aggregate once after the edit
   stabilizes. During editing use the relevant focused cases instead of pre-running that
   aggregate. Run full validation only when the planner selects `full` or a named cross-boundary
   risk or coverage gap requires it; record that reason in the task record. Repeat an aggregate
   only after changed inputs, failure or new missing coverage. This does not reuse a different
   revision's result as exact-SHA CI or weaken public validation wrappers.

Maintain a small private task record outside Git with the current stage, checkout and SHA, next
action, checks and their log paths, production controller/runtime identities, and open acceptance
gates. Update it after each completed stage and revalidate live state when resuming. Retire stale
status entries instead of accumulating conflicting copies. Keep secrets and message content out
of this record.

Every long-running command needs its source revision, process/session identity, log, start time,
deadline and eventual exit status. A recurring collector additionally needs a heartbeat and its
last successful sample time. Check both process identity and sample freshness; a live process with
stale observations is not a healthy monitor. Record gaps explicitly and retain failed evidence.
An unexpected interruption requires inspection of the actual state before retrying; never infer
success from the final log line or kill a process by an unverified reused PID.

Report implementation, local validation, exact-SHA CI, deployment and production acceptance as
separate states. Health checks and settled receipts do not prove every user-facing effect. Start
the requested final observation window only after deployment and the mandatory acceptance gates
are ready; do not count earlier diagnostics or missing samples toward it. Missing test identities,
independent labels or real WebView access remain named gaps, not assumed passes. Resolve work that
does not depend on those inputs while preserving the unfinished objective.

After an avoidable failure, correct the narrow cause and, where appropriate, add an executable
regression or typed boundary. Keep permanent agent notes short; put incident evidence in the dated
record. Track first-pass validation failures, repeated failures of the same cause, time to a
verified release, escaped production regressions and monitoring gaps. More commands or more passed
tests alone do not demonstrate more productive work.

## Boundaries And Follow-Up

Local Markdown-only changes select `check:docs` without runtime, browser or native-store setup. Environment
examples and `infra/env/**` are classified independently; they do not inherit the Markdown-only
path. Run the environment doctor only for setup, and do not repeat it for ordinary edits.

When both repository static and infrastructure checks are selected, `agent:verify` runs lint,
refactor guards and core tooling tests, then `check:infra` owns the infrastructure test inventory
once. Tooling changes without an infrastructure selection use core tooling tests; a changed
infrastructure caller still requires its focused regression. CI Static and public full aggregates
keep the complete inventory. Inventory guards prove core coverage and complete infrastructure
coverage when selected, without duplicate execution. The root `check` uses `check:static:ci`
for core tests, then `check:infra` for infrastructure; the standalone `check:static` remains
the complete tooling aggregate and must not be nested into `check` again. Native PostgreSQL/Redis
cases remain mandatory for the affected invariant; skipped store cases are missing coverage.
Preflight rejects guarded file growth before these checks. Scoped plans run selected contracts
and API validation before infrastructure; the public full aggregate retains its existing order.

Miniapp-only UI changes need no API, Prisma, admin or native-store suites unless a changed boundary
or concrete regression requires them. Do not repeat green suites without changed inputs, failure
or a newly identified coverage gap; included subchecks do not need a separate run.

Deliver the requested runtime change as soon as its required gates pass. An independent tooling
improvement is a follow-up, not a new runtime release prerequisite. For tooling/notes-only work,
finish after the required PR checks and merge; do not wait for a second main CI run or redeploy
the unchanged application. A later runtime deployment still requires its exact selected main SHA
to be green. When the requested source is already active, read back its component identity and
availability once and report that release instead of rebuilding it. Extra monitoring windows
need an explicit request or a concrete runtime risk; routine smoke success ends routine delivery.

CI uses the same impact classifier with [accumulated main coverage](development/ci-image-delivery.md#accumulated-main-coverage):
a trusted main push selects changes since a proven green first-parent ancestor with a compatible
certificate; the PR merge checkout uses its recorded base. Missing baseline evidence selects full
coverage. `Required` reuses the frozen proof rather than selecting a newer baseline.
`Static` stays mandatory; its infrastructure, ShellCheck and workflow-lint
steps run for full plans and the exact reviewed host-tool scope, selected by the frozen
`staticInfra` field. The scheduled run retains full coverage.
Permanent source-abandonment and legacy-disposition rollback floors belong to the mandatory core
test inventory, so API-only changes also check compatibility with the deployed safety readers.
Miniapp changes select all four miniapp browser shards
and its affected Docker image; API changes retain API, Redis, every PostgreSQL shard, the
commercial benchmark and the affected API image. Shared contracts select all their consumers.
Tests alone do not build unrelated runtime images. CodeQL remains a separate exact-SHA gate.

Browser dependency setup uses HTTPS Ubuntu sources, omits package translation indexes and bounds
network retries. Browser and owned Redis setup use the Ubuntu Azure archive over HTTPS instead of
redirecting it to the main archive endpoint; Ubuntu archive signatures remain required. It fails on
incomplete apt updates and has its own three-minute step budget, so
an unavailable mirror cannot silently consume most of the browser test deadline. All miniapp
shards and Safety Desk keep their complete test inventories and existing job budgets. The miniapp
partitions preserve each browser command once, with per-job dependency setup and contract builds;
only the complete Android/iOS shop partition installs WebKit. Keep long settings-draft, shop-format
and publication-editor scenarios in separate jobs. Measure durations before changing assignments.

Workflow, unreviewed shared tooling and infrastructure, root build inputs, unknown files/check
kinds, unproved Git history and manual/scheduled runs select full CI. The exact host paths in
`HOST_RELEASE_TOOLING_PATHS` retain core and both infrastructure shards; a permanent Docker
context guard verifies that they remain excluded from image inputs. The exact local-only entrypoints in
`LOCAL_TOOLING_PATHS` in `scripts/ci/impact.mjs` (context, doctor, focused checks, task ownership
and documentation checks, with their reviewed tests) select Static. Static includes their tests,
lint, refactor guards, dependency audit and documentation validation. New helpers and modified
callers are not implicitly exempt; review callers before extending that list. Renames include
both paths, and mixed changes take the union of required coverage. The `Required`
job independently recomputes the selection and image matrix from Git and the event, requires
success for selected lanes and accepts `skipped` only for lanes proved unrelated. Failed
classification, missing results, cancellation and mismatched outputs block it. Workflow guards
and real Git fixtures cover these boundaries; the weekly scheduled run retains full coverage.

API CI runs the existing Jest inventory in four independent jobs through public `test:ci`,
with one serial worker per job. A fifth job uses public `check:ci:build` for generation,
types, retention storage checks and build, then runs the existing Redis cases. Every part blocks
`Required`; PostgreSQL and benchmark lanes retain their separate complete coverage. See
[local setup and partition inspection](development/agent-local-environment.md#api-ci-partitioning).
CodeQL cancels superseded runs of the same PR, while main and scheduled runs remain uncancelled.

`agent:verify` also avoids repeating included CSS checks. Full verification adds the browser smoke,
which the root `check` script does not include. Focused local selection changes neither exact-SHA
`Required` and `Analyze JavaScript and TypeScript` nor guarded deploy, strict smokes and manifest
verification. Tests pin these aggregate-command assumptions.

The [machine interface](development/agent-machine-contract.md) exposes repo-owned JSON planning,
execution results, task-baseline scope and exact focused test paths. Coordinators use these
interfaces without duplicating impact rules; the commit helper remains the final aggregate owner.

No verification cache is introduced: a green result from different inputs is not reusable release
evidence. The preflight and staged checks shorten feedback and catch mismatches; the exact committed
SHA is still validated by CI after commit hooks. Ignored local configuration and other non-Git inputs
are not a hermetic snapshot. Full builds, integration suites, CodeQL and deployment smokes remain
mandatory according to impact.

Production throughput optimization should start from comparable bounded health/capacity windows,
query plans and queue metrics. This change does not raise concurrency or DB pool sizes, run broad
history scans, relax CI, or claim lower production latency without measurements.
