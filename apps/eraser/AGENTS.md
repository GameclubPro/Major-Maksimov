# Lastik Agent Notes

Root workflow and delivery rules apply. Lastik (`@maxim/eraser`) is an independent
bot, image, webhook receiver and worker with its own PostgreSQL/Redis. It is not a
shared API role and does not use API Prisma migrations.

## Select The Boundary

| Work                                              | Read before editing                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Runtime, policy, deletion, protection or rollback | [Lastik runbook](../../docs/operations/runbooks/eraser-rollout.md)                                                       |
| Activation or pending connection                  | [Atomic proofs](../../docs/operations/runbooks/eraser-rollout.md#atomic-activation-and-connection-proofs)                |
| Store scans or queue wakeups                      | [Due scheduling](../../docs/operations/runbooks/eraser-rollout.md#due-scheduling-and-control-scans)                      |
| Diagnostics or owner UI                           | [Read-only diagnostics](../../docs/operations/runbooks/eraser-rollout.md#reading-diagnostics-without-changing-execution) |
| Major settings/control bridge                     | [API notes](../api/AGENTS.md), [contracts](../../packages/contracts/AGENTS.md) and affected callers                      |
| Deploy, bootstrap, nginx or backups               | [Infrastructure notes](../../infra/AGENTS.md) and the matching Lastik runbook section                                    |

## Preserve Authority And Evidence

- Lastik owns its token, stores, queues and deletion journals. Major uses authenticated
  control and protected publication references; never copy Lastik credentials into API roles.
- An enable is committed with the exact connection generation, current policy/revision
  and unexpired rights proof after database lock waits. Passive rights observations cannot
  clear a known negative fence. Pending requests preserve their original opt-in, expiry
  and cancellation; a replay returns its saved outcome without reactivating anything.
- An exact-message 404 can mean missing or inaccessible. Only positive DELETE acknowledgement
  or an authenticated removal receipt establishes deletion. Preserve uncertain journals;
  diagnostics do not authorize replay. Independent eligible messages may continue through
  fresh policy, rights and protection checks.
- Preserve protected messages, historical/current protection evidence, cursor generations,
  durable cooldowns and the installed ownership/connection/rate-limit reader floors.
  Availability off or empty queues never permit deleting these fences or lowering a floor.
- Health and progress are distinct from successful deletion. Public-group diagnostics and
  permission probes remain prohibited; the root live-test restrictions still apply.

## Validation And Delivery

Unit tests run with `npm test --workspace @maxim/eraser`. For a specific existing file,
use `TZ=UTC node --import tsx --test apps/eraser/test/connection.test.ts`, replacing the
path with the affected test. The generic agent focused runner does not currently
support Eraser test families.
For store behavior, run the public `npm run test:eraser:stores`: it starts disposable
PostgreSQL/Redis and executes `test/*.stores.ts`. The tests own Lastik schema setup;
do not add the API wrapper's `--migrate`. Storage-dependent skips are missing coverage.

The planner and staged commit helper own final `check:eraser` and affected caller checks.
That aggregate contains typecheck, unit tests and build; it does not include native
store tests. Keep migrations additive and inspect their reader compatibility.
After exact-SHA CI, the normal deploy planner selects `eraser` and any changed callers.
Routine releases recreate the application only; bootstrap and store recovery follow
their separate reviewed procedures. Verify the independent component manifest and health.
