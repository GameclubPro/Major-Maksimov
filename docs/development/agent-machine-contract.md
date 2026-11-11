# Agent Machine Interface

Use direct Node entrypoints so npm's own banner does not precede JSON:

```bash
node scripts/agent/context.mjs --path scripts/agent/verify.mjs --json
node scripts/agent/plan.mjs --since HEAD --json
node scripts/agent/verify.mjs --since HEAD --dry-run --json
node scripts/agent/focused.mjs --test scripts/agent/test/verify-cli.test.mjs --json
```

`plan` and `verify` retain worktree, staged and committed-range selection. `--since <ref>`
selects the union of committed changes from the resolved baseline to HEAD and current staged,
unstaged and untracked changes. Paths and selections are deduplicated; both sides of rename chains
remain in scope. Its `source.base` and `source.head` are resolved commit SHAs. Presence of a changed
migration follows the current worktree, and schema review compares baseline with worktree. This
scope cannot be combined with explicit worktree/staged/range modes or `verify --full`.

## Configured Workspace And Ownership

`workspace` is a separately installed local coordinator, not an npm script or a file
in this repository. Inspect `workspace --help` for the installed version's commands.
When it is configured, use one task identity and its returned checkout throughout:

```bash
: "${WORKSPACE_TASK:?Set a new descriptive task id}"
workspace start "$WORKSPACE_TASK" --scope major --goal 'Describe the concrete requested result' --no-install
workspace status "$WORKSPACE_TASK" --json
workspace context "$WORKSPACE_TASK" --json
workspace plan "$WORKSPACE_TASK" --json
```

The coordinator starts from its configured base ref, which may be the production `main`
rather than the newest remote commit. The configured source must be the maintained
primary checkout, not a former task worktree. Compare source HEAD, base SHA and branch
with `workspace inspect`; use `workspace configure` to correct a stale registry after
preserving the intended private local configuration. Do not switch or delete the old
checkout merely to make the registry match. Inspect source/checkout SHAs and fetch before
selecting the task baseline; advance only the idle task branch when appropriate. Keep
production `main` and another task's worktree untouched. `--no-install` is appropriate
for initial read-only/docs discovery; run `workspace prepare` before checks/submission
when this checkout lacks dependencies, including Markdown-only submissions.
Never change checkout inputs while one of its operations is active.

`workspace check` accepts exact `major:path` tests, with `--native` for real stores.
Stage owned files before `workspace submit --repo major --message ...`; it delegates to
the mandatory repository commit helper and accepts `--include-agents` for agent notes.
Do not run the same final aggregate separately. Track returned operation IDs, logs,
heartbeats, deadlines and terminal exits with `workspace operation`/`workspace status`.
A successful submission does not prove PR CI, merge, deployment or acceptance.
If an operation reports changed inputs or an uncertain status after creating a commit,
inspect its terminal helper result and Git/remote identity before retrying. The installed
coordinator's `workspace reconcile-submit` verifies the intended parent/tree and retained
submission evidence. Use that reconciliation for its supported case; do not create a
second commit or repeat a push merely to replace an ambiguous watcher status.

The coordinator records the repository-owned editing baseline. For an independently
created checkout, run `task-worktree.mjs start` before editing and `check` after submission,
as specified by the [ownership procedure](../development-reliability-plan.md#worktree-ownership-and-completion).
Do not create a replacement baseline to hide inherited changes. If the configured
coordinator is unavailable, preserve the task record and use these repository entrypoints
with the same validation/delivery gates; do not invent a replacement external protocol.

## Verification JSON v1

`verify --json` and `--format json` emit one final JSON document on stdout, including failures.
Preflight and child stdout/stderr go to stderr. Exit 0 means planned or passed; exit 2 means failed.
Interrupted processes may leave no result: absence of a document or terminal status is not success.
The default human interface used by the commit helper remains available.

| Field                                               | Contract                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `repo`                             | `1`, `major`.                                                                                                                       |
| `root`, `head`                                      | Absolute Git root and current checkout HEAD; null if resolution failed. Range target refs are separately recorded in `plan.source`. |
| `mode`, `dryRun`                                    | `worktree`, `staged`, `range`, `since` or `full`; mode may be null for invalid arguments.                                           |
| `status`                                            | `planned`, `passed` or `failed`. Planning never establishes validation.                                                             |
| `plan`                                              | Unmodified impact-plan v1, or null for full mode / failure before planning.                                                         |
| `commands`                                          | Ordered selection from `selectVerificationScripts`, after existing aggregate deduplication.                                         |
| `snapshotTree`                                      | Staged tree guarded during this run, otherwise null. This is not a reusable QA attestation.                                         |
| `error`                                             | Null or `{stage, code, message, commandId}`. Migration refusal uses `MIGRATION_REVIEW_REQUIRED`.                                    |
| `requiresSubmissionAggregate`, `requiresExactShaCi` | Both true, even after successful local execution.                                                                                   |

Each command contains `id`, `kind`, `executable`, `args`, `cwd`, `resources`, `status`, `exitCode`
and `signal`. `args` is an argument array, never a shell string. `resources: ["checkout"]` is a
coarse scheduling hint keyed by `cwd`; public generator and deployment locks still own admission.
Command status is `planned`, `not-run`, `passed` or `failed`; exit/signal are null before execution.
A command may pass while overall verification fails its subsequent staged snapshot check.

Dry-run checks script mappings and migration requirements but starts neither preflight nor tests.
An execution runs public npm scripts sequentially and preserves the existing staged guards.
In scoped plans, selected contracts and API validation run before infrastructure checks. The API
aggregate retains its public generator lock and performs code generation and typechecking once.
The full aggregate follows the order of the public `npm run check` script.
These outputs introduce no verification cache and do not replace the commit helper, exact-SHA CI,
guarded deployment, component manifests or production acceptance.

Preflight checks guarded file sizes through the same limits used by `check:refactor-guards`, before
expensive validation begins. The full refactor check continues to verify imports, cycles and its
other invariants during the submission aggregate.

## Focused Checks Before Submission

`focused.mjs` requires repeatable `--test <existing-repository-relative-file>` arguments, with
optional `--repo`, `--dry-run`, `--json` / `--format`. It returns the same result envelope with
`mode: "focused"`, `plan: null`, selected `tests` and grouped commands. Unknown families, missing
files, traversal and links outside the repository fail closed; they never trigger full verification.

| Test family                                                                                                     | Owned execution route                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Root `scripts/*.test.mjs`, `scripts/agent/test/*.test.mjs`, `scripts/ci/*.test.mjs`, `infra/scripts/*.test.mjs` | Node test runner with exact paths.                                                                        |
| `apps/miniapp/test/*.test.ts`, `apps/admin/test/*.test.ts`                                                      | Local workspace tsx through offline npm exec; refuses if the declared runner contract changes.            |
| `apps/api/src/**/*.spec.ts`, `apps/api/test/**/*.spec.ts`                                                       | Public API npm test, retaining codegen and locks; forwards exact Jest paths through all three npm layers. |

Contracts cases under `packages/contracts/test/*.spec.ts` or `*.test.ts` use the public contracts
npm test, retaining its locked build and forwarding selected Vitest paths.

Browser `.browser.mjs` scripts, API storage `.node.ts` cases and Eraser tests are not
accepted by this focused interface. Use their maintained public family entrypoints:
[feature browsers](feature-regressions.md), [API stores](agent-local-environment.md),
and [Lastik](../../apps/eraser/AGENTS.md). Do not rename a test or bypass API generator
locks to force it into a supported family.

Focused checks are not the final aggregate. The commit helper owns final staged verification;
do not run `verify`'s same aggregate in advance merely to populate coordinator status. Native cases
still require the public [test-store wrapper](agent-local-environment.md) and explicit evidence of
the required storage coverage; a runner exit code alone does not establish native coverage.

Focused native selection reports `requiresTestStores: true`, command resources `postgres`/`redis`
and required environment names without values. It uses literal membership of the maintained API
native lane and parsed reads of canonical store environment variables in the selected source;
comments and string examples do not classify a test as native. Execution requires consistent
aliases and the existing local race-environment guard before starting tests. Run such selections
inside `with-test-stores.mjs --migrate --`; this interface never silently starts nested stores.

## Major ↔ Karavan Integration References

Select both repositories when a changed boundary requires it. Ordinary text/UI work stays within
the affected product. Major owns its DTO validation, exact MAX authority and command proxy;
Karavan owns marketplace data, application of commands and the inline buyer admin UI.
Major owns creation, chat connections and publication settings, with `m_`/`ma_` links
into Karavan; retained proxy/recovery code does not define the current editor location. Keep the code map and acceptance profile
aligned with the [maintained integration runbook](../operations/runbooks/karavan-chat-marketplaces.md).

| Boundary                                    | Major owner / relevant evidence                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical commands, authority, payload hash | [Shared schemas](../../packages/contracts/src/karavan-marketplace.ts), [proxy](../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-proxy.service.ts), [management tests](../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-management.spec.ts).                                                                             |
| Current human/bot authority and binding     | [Authority service](../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-authority.service.ts), [binding status](../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-binding-status.service.ts), [native authority tests](../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-authority-postgres.spec.ts). |
| Retained one-time seller/historical handoff | [Handoff service](../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-handoff.service.ts), [integration controller tests](../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-integration.controller.spec.ts).                                                                                                                |
| Current shop entry and uncertain commands | [Compact shop](../../apps/miniapp/test/karavan-shop-simple.browser.mjs), [management link](../../apps/miniapp/test/karavan-shop-management-link.test.ts), [connection/recovery flow](../../apps/miniapp/test/karavan-marketplace.browser.mjs), [chat settings route](../../apps/miniapp/test/karavan-shop-route.browser.mjs).                                                                                                                                                                                                               |

Karavan's matching handlers and release configuration remain documented in its own
`docs/chat-marketplaces-release.md`. Pair configuration checks do not prove protocol or runtime
compatibility; use the relevant consumer/provider cases and selected transitional version pair.
