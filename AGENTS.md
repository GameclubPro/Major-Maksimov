# MAXIM Agent Notes

## Start Here

- Start with the [current documentation](docs/README.md). Verify notes against code and scripts;
  existing behavior is evidence, not proof of intent.
- Use configured `workspace`; preserve repo QA/release gates.
  See [interfaces](docs/development/agent-machine-contract.md).
- Before editing, run `node scripts/agent/context.mjs --path <file>`; include callers.
  Read its scoped notes and relevant references. For behavior changes, follow the
  [evidence procedure](docs/development/behavior-evidence.md).
- Keep one primary implementation/release stage active. Finish its checks and result before
  opening another runtime workstream, except for a prerequisite or urgent production incident.
  Independent read-only monitoring can continue.
- During an incident, name the next user-visible recovery result and its blocking gate. Defer
  unrelated refactoring and diagnostics; use the [incident delivery rules](docs/development-reliability-plan.md#incident-delivery).
- Keep `main` clean at the verified production SHA; use task worktrees and fast-forward
  after release. Preserve inherited work; stage owned paths. Never mutate an active wrapper's checkout.
- Continue authorized reversible work without repeated permission requests. Approval for one
  destructive recovery does not authorize another source or a fleet-wide operation.

## Project And Production

- Node 24 LTS (`.nvmrc`); npm workspaces: NestJS/Fastify API with Prisma/Postgres/BullMQ/Redis,
  React/Vite MAX mini app, closed Safety Desk, and shared Zod contracts. Use `npm ci`.
- Production is REG.RU through `maxim-vps`, checkout `/var/www/Chat_bot`. The shared server has
  12 physical cores / 24 threads and 64 GB RAM; preserve sibling Svyazka and Karavan workloads.
  See [host profile](docs/operations/runbooks/reg-production-profile.md). The retired Yandex host
  is never a deploy or database rollback target.
- One API image serves all 14 API roles and both native auxiliaries. Topology sources are
  `apps/api/src/runtime/runtime-topology.ts`, Compose and `infra/scripts/lib/deploy-topology.sh`.
- The only routine mini app URL is `https://major-maksimov.ru/app/` (`miniapp-major-static`).
  Safety Desk uses `admin-static`. CDN, Object Storage and app2 delivery remain paused.

## Validate And Deliver

1. Inspect the branch, diff and scoped notes. Use `node scripts/agent/doctor.mjs --browser` only
   for environment setup; run `node scripts/agent/preflight.mjs` before expensive checks.
2. For changed methods, find callers and test doubles with `rg` before broad tests. Keep doubles
   typed against the real contract. Run the affected unit and native integration cases first.
3. Select scope with `node scripts/agent/plan.mjs --worktree`. Use focused tests; the commit helper
   owns one final aggregate. No duplicate green suites or subchecks.
   Full runs need planner `full` or a concrete coverage gap. UI needs no unrelated API/native/admin
   suites; local tooling uses core plus affected callers; Markdown uses `check:docs`. See
   [check selection](docs/development-reliability-plan.md#boundaries-and-follow-up).
4. Public API scripts own generator locks. Do not invoke `*:unlocked`, `*:source` or raw Prisma
   generation to bypass them. Native stores: `node scripts/agent/with-test-stores.mjs --migrate --`
   followed by the public validation command. Report store-dependent skips; mocks are not native
   coverage. See [local environment](docs/development/agent-local-environment.md).
5. Run `git diff --check`, stage owned paths, then
   `./infra/scripts/local-commit-push.sh "commit message" branch`. The helper is staged-only;
   use `--all` only intentionally and `--include-agents` for any staged `AGENTS.md`. It refuses
   unstaged executable inputs, partial staging and index drift; use an isolated checkout instead.
6. Before runtime deploy, require successful `Required` and `Analyze JavaScript and TypeScript`
   on the exact selected SHA; local check scope never bypasses CI. Deploy through
   `./infra/scripts/vps-connect.sh deploy main --auto`; read `infra/AGENTS.md`
   first. Verify the synchronized VPS SHA, strict smokes and immutable component manifest.
   Do not use an old green commit's checks for a new release. Emergency bypass needs explicit reason.
7. Unless the user says otherwise, validated runtime changes finish with the affected VPS deploy,
   before independent tooling follow-ups. Recreate all roles for a shared API image, never stores.
   Docs/tests/tooling need no deploy or second main CI wait after green PR merge. Active
   runtime needs one identity/availability readback, no rebuild or unrequested watch.

Contract changes affect API, mini app and admin; align exports, TypeScript paths and Jest mappers. Unknown paths fail closed in the impact planner; renames include old and new scopes.
Prisma changes follow the migration review in API notes. Nginx changes are manual site operations.
See [release details](docs/development-reliability-plan.md).

## Non-Negotiable Boundaries

- No diagnostics, permission probes, tests or fallback error replies in user groups/channels.
  An explicit human-admin `Старт` may produce one successful connection confirmation and mini app
  button after fresh exact bot and human admin checks. Without bot admin rights, stay silent.
  Other public messages require enabled product behavior or an explicit publication request.
  Live test destinations and their verification rules are in `apps/api/AGENTS.md`.
- Preserve current working bot assignments. Never replay uncertain effects, clear queues/Redis,
  remove fences or fabricate completion to make lag disappear. Before webhook scheduling,
  execution handoff or recovery changes, read the
  [latency regression matrix](docs/operations/runbooks/webhook-latency-prevention.md).
- Record exact incident windows and source/image before correction. Distinguish ingress,
  selection, preparation, ordering/retry waits and action outcomes; HTTP 200 or queue age alone
  proves neither cause nor recovery. Use [incident playbook](docs/incident-playbook.md).
- Production SQL uses reviewed bounded audit collectors, sequentially; no ad hoc live SQL,
  whole-table scans or live `EXPLAIN ANALYZE`. Read infrastructure notes before production work.
- Never bypass disk floors, shared deploy locks, effect uncertainty or rollback reader checks.
  Do not run host-wide Docker cleanup on the shared server. Do not touch another project's services.
- No destructive Git commands without explicit authorization. Do not commit secrets, dumps,
  private exports, build output, screenshots or local agent traces. Format only owned files.
- New sensitive-zone comments use `FLAG:`. Read a flagged invariant twice before editing it.
  Import public facades; only thin facade files may import `*.legacy` implementations.

## Evidence And Durable Knowledge

- Keep a private task record: stage, checkout/SHA, next action, evidence and gates. Revalidate live
  state on resume; replace stale status and move completed history to dated records.
- Track long commands by identity, log, start/deadline and exit status. Collectors also need a
  heartbeat and last successful sample. Missing/stale samples are gaps; a launched process is not
  proof that work continues. See [execution discipline](docs/development-reliability-plan.md#long-running-agent-work).
- Report written, locally validated, CI-verified, deployed and production-accepted separately.
  Run the user's final monitoring window only after its other gates are ready. Preserve failures
  and missing coverage; do not claim all bots/functions are green from one healthy sample.
- At task start/end run the [ownership check](docs/development-reliability-plan.md#worktree-ownership-and-completion).
  Preserve inherited changes; finish owned edits before success. Report pending checks/CI/deploy/
  acceptance. Fix defects; update affected notes/runbooks.
- Keep these entry files short. Put detailed invariants in task-selected references and historical
  observations in dated incidents; never put temporary PIDs, release status, secrets or guesses here.
