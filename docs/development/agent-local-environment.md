# Local environment for MAXIM agents

Use the repository's Node 24 requirement and lockfile. Install dependencies with `npm ci` in the
checkout being tested; never replace another worktree's dependencies or copy a stale generated
Prisma client. Public API scripts own code generation and its lock.

## One-time setup and routine checks

For environment setup only:

```bash
node scripts/agent/doctor.mjs --browser
```

For an ordinary change, inspect context and callers, then run preflight before expensive
checks and use the impact planner. The staged commit helper owns the final aggregate;
see [check selection](../development-reliability-plan.md#boundaries-and-follow-up).
Markdown-only work needs no browser or native-store setup. `check:docs` uses the Git and
Docker Compose CLIs to inspect documentation and service names, but does not start a
Docker daemon, containers or application services.

The doctor checks local tools, dependency presence and the matching Playwright Chromium binary.
`--browser` also launches an isolated headless page without network access. It does not inspect
credentials or change Codex settings. Dependency presence is not lockfile-integrity validation;
use `npm ci` after dependency changes. A running Docker daemon is optional when native test stores work.

Tools depend on scope: Node 24/npm, Git and the Docker Compose CLI support repository
and documentation checks; GitHub CLI handles delivery. Tooling/infra work additionally uses
ripgrep, Python 3, ShellCheck and jq. Native store work needs PostgreSQL 16 server/client
binaries and Redis 7 server/client. Keep `initdb`, `postgres`, `pg_isready`, `createdb`,
`psql`, `redis-server` and `redis-cli` on PATH. For workflow editing, install the actionlint version
pinned in `.github/workflows/ci.yml` (currently 1.7.7). Compiler/build tools are needed only when
installing a dependency with native compilation. Do not update application dependencies merely
to prepare an agent machine.

On Ubuntu 24.04, an administrator can install the native tools using the distribution packages:

```bash
sudo apt-get update
sudo apt-get install postgresql-16 postgresql-client-16 redis-server redis-tools shellcheck jq ripgrep unzip
```

These packages may enable system services; the disposable runner below does not need them.
Without administrator access, download the same packages using APT with private state/cache
directories, verify package SHA-256 against the authenticated package index, and extract them
with `dpkg-deb -x` into a user-owned prefix. Include runtime libraries and wrap binaries with
that prefix's library path. Do not weaken repository-signature validation or overwrite existing
user wrappers. Record installed versions/checksums locally, outside Git. Refresh stale package
indexes on a download 404 instead of falling back silently to an older server.

Install the browser revision required by this checkout:

```bash
npx playwright install chromium
```

If the browser launch reports missing OS libraries, use the supported Playwright dependency
installer with administrator access. Existing compatible system libraries need no reinstall.
Keep WSL projects, node_modules and temporary databases on the Linux filesystem for I/O efficiency.

## API CI partitioning

API CI has four ordinary Jest partitions and one types/build/storage/Redis job. All five block
`Required`. The existing `test:ci` keeps its generator lock, serial worker and benchmark exclusion;
public `check:ci:build` owns the remaining generation/type/storage/build phases. Local final
`check:ci` still runs the whole API aggregate once. Partitioning CI is not permission to run
concurrent local generators or treat skipped native tests as storage evidence.

To inspect a partition without executing tests:

```bash
npm run test:ci --workspace @maxim/api -- -- -- --shard=1/4 --listTests --json
```

All three separators after the workspace are necessary for this public wrapper. Use
`focused.mjs --test <path>` for ordinary file selection so it owns that forwarding.
CI retains per-part JSON results on success or failure; a missing report is missing evidence.
The [dated audit](../operations/incidents/2026-11-03-agent-workflow-audit.md) records the baseline;
measure the current run before promising a duration.

## Native CI partitioning

The blocking PostgreSQL Races lane runs eight native Jest shards and one compatibility group.
Every matrix job owns independent PostgreSQL/Redis services; suites remain serial within a shard.
The public explicit test list is unchanged. `Required` waits for the entire matrix, and failure in
one shard does not cancel the others. Native JSON reports are retained even after test failure.
Each job has a ten-minute budget; queue time and the other CI lanes are separate from that budget.
Compare observed durations before changing shard count. This is not a ten-minute full-release guarantee.

To inspect one shard without executing tests, pass options through both npm boundaries:

```bash
node scripts/agent/with-test-stores.mjs -- npm run test:postgres-races --workspace @maxim/api -- -- --shard=1/8 --listTests --json
```

## Disposable real-store validation without Docker

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm run test:postgres-races --workspace @maxim/api
node scripts/agent/with-test-stores.mjs --migrate -- npm run test:retention-storage --workspace @maxim/api
node scripts/agent/with-test-stores.mjs -- npm test --workspace @maxim/api -- publisher-access-refresh.redis
```

For a focused SQL regression, preserve the public API lock/codegen wrapper:

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- moderation-delete-due-postgres.spec.ts
```

Jest options need two additional `--` separators because the public wrapper traverses two
nested npm scripts. For example, append `-- -- -- --runTestsByPath src/path.spec.ts
--testNamePattern 'case name'` after `npm test --workspace @maxim/api`. Confirm the final
Jest command retains both options; otherwise npm can consume them and run whole suites.
Keep the public wrapper and its generator locks in place.

The runner requires a non-root Linux/macOS shell (WSL is supported). Each invocation creates a
private directory, randomly named `race_test` database, fresh PostgreSQL credentials and independent loopback
ports. PostgreSQL server and clients use UTC. Redis matches CI's host/port-only fixture contract,
with persistence disabled and its owned process verified through a private Unix socket. Inherited `DATABASE_URL`,
`REDIS_URL`, `CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL`, `MAXIM_TEST_POSTGRES_URL` and
`MAXIM_TEST_REDIS_URL` are replaced only for child processes. URLs are not printed or written into
repository env files. `--migrate` uses the public Prisma deployment script against that empty local
database. It never imports production data or starts application workers.

The local catalog runner also supports `--topology=split --enqueue=production`. Use
`with-test-stores.mjs --profile=split-load --migrate -- ...` for this profile: its ten
separate Node processes retain their per-role SQL pools (56 connections total), so
the disposable PostgreSQL allows 100 connections instead of the ordinary 40. The
runner refuses an undersized store before starting its workers. It uses the 23 static
webhook queues and a shared simulated MAX state; native photo/OCR, dynamic leases,
production governors and the other four API roles are excluded. Its default workload
requires a DELETE for every message and is not the measured production function mix.
Reports include actual receipt arrival rate, producer lateness and process/queue
coverage. A successful synthetic run does not certify production or media capacity.

The command's exit status is preserved. On normal completion, command failure, SIGINT or SIGTERM,
the runner stops only its own process groups and removes its temporary stores. SIGKILL/host loss
cannot run cleanup; inspect exact process identity before manual recovery, never kill a stale PID
or reuse somebody else's database. Run expensive API validation sequentially through public scripts;
separate store ports do not remove the shared code-generation lock.

The runner's integration self-check is opt-in so normal tooling tests do not silently depend on
native binaries:

```bash
MAXIM_AGENT_TEST_STORES=1 node --test scripts/agent/test/test-stores.test.mjs
```

## Choosing the right evidence

For queue/SQL changes, test representative history, skew, nonmatching rows, retries, ordering and
locked rows on real stores. Assert bounded rows/probe loops and results; small mocks and `LIMIT`
alone do not prove bounded work. State store-dependent skips explicitly. A green local suite does
not replace exact-source/main CI, guarded deployment or full production acceptance.

Use the smallest relevant validation while editing, then run the impact plan. Docs and agent-tooling
changes do not need a VPS runtime deploy. Keep incident details in the dated incident record;
AGENTS notes hold stable commands and invariants, not current PIDs, release IDs or unproven causes.
