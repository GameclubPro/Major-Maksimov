# MAX Moderation Bot, Mini App, And Safety Desk

Production monorepo for MAX chat/channel moderation, publishing, the public «Майор Максимов» mini
app, and the closed owner Safety Desk.

## Workspaces

- `apps/api`: NestJS + Fastify + Prisma + BullMQ + Postgres/Redis.
- `apps/miniapp`: React/Vite MAX mini app served under `/app/`.
- `apps/admin`: React/Vite Safety Desk; not a MAX mini app.
- `apps/eraser`: independent «Ластик» bot with its own Postgres/Redis stores.
- `packages/contracts`: shared Zod schemas and TypeScript types.
- `infra`: Docker Compose, nginx, deploy, rollback, backup, and monitoring scripts.

Use Node 24 LTS (`.nvmrc`). Dockerfiles install from `package-lock.json` with `npm ci`.

## Local Start

For browser-only UI work, use `npm ci` and `npm run dev:miniapp` (or
`npm run dev:admin`). The mini app's local preview routes do not require a live API.
Use the [local environment guide](docs/development/agent-local-environment.md) for
browser setup and disposable test stores.

For a local API with persistent development stores:

1. Create the API workspace's ignored env file on first setup:

   ```bash
   cp .env.example apps/api/.env
   ```

   Edit `apps/api/.env` for a dedicated development bot and local values. API npm scripts
   execute in `apps/api`, where Nest and Prisma load `.env`; a root `.env` alone is not
   their configuration. For host-side Node processes, use
   `DATABASE_URL=postgresql://maxim:maxim@127.0.0.1:5432/maxim?schema=public` and
   `REDIS_URL=redis://127.0.0.1:6379`. The example's `postgres`/`redis` hostnames belong
   to the Compose network. Keep the database password consistent with `POSTGRES_PASSWORD`
   (Compose's local default is `maxim`). Do not copy production credentials.

2. Install dependencies:

   ```bash
   npm ci
   ```

3. Start the local stores, then apply migrations to that local database:

   ```bash
   docker compose --env-file apps/api/.env -f infra/docker-compose.yml -f infra/docker-compose.local.yml up -d postgres redis
   npm run prisma:migrate:deploy --workspace @maxim/api
   ```

4. Start the development servers:

   ```bash
   npm run dev:all
   ```

Focused servers are `npm run dev:api`, `npm run dev:miniapp`, and `npm run dev:admin`.
`dev:all` does not start Lastik; its separate workspace follows
[Lastik's instructions](apps/eraser/AGENTS.md). API dev uses the TypeScript contract sources through the shared path mappings and
generates Prisma, but does not apply migrations. Public build/test scripts own any
required contract build.

The env example supports multiple bots: `MAX_ENTRY_BOT_ID` selects the canonical start/startapp bot,
additional bots live in `MAX_BOTS_JSON`, and `state: "dormant"` keeps a provisioned bot visible in
metadata without webhook/action execution.

## Validation

Start with the [agent workflow](AGENTS.md), inspect changed callers, and select the scope:

```bash
node scripts/agent/preflight.mjs
node scripts/agent/plan.mjs --worktree
node scripts/agent/focused.mjs --test scripts/agent/test/verify.test.mjs
```

Run the relevant [focused cases](docs/development/agent-machine-contract.md#focused-checks-before-submission)
while editing. The staged commit helper below owns the final aggregate; do not pre-run
its same aggregate or repeat included subchecks. Markdown-only work selects `check:docs`.
Full validation needs a full impact plan or a concrete coverage gap.

Use repeatable `--test` arguments with exact existing paths; `--dry-run --json` shows the
command without running it. This avoids npm argument-forwarding mistakes that can accidentally
start an entire Jest suite. For final submission, inspect `verify.mjs --staged --dry-run --json`
if needed, then let the commit helper execute that aggregate once.

API validation scripts serialize contracts/Prisma codegen; internal `*:unlocked` and
`*:source` scripts are not normal entrypoints. Native storage coverage needs the
[disposable PostgreSQL/Redis wrapper](docs/development/agent-local-environment.md).

## Submit Changes

Work in a task worktree on a `codex/` branch; keep `main` clean and follow the
[source synchronization rules](AGENTS.md#start-here) after release or a green merged change with
no deployment impact.
`local-commit-push.sh` uses the existing Git index by default: stage the intended paths first, then
run the helper. It validates staged impact, commits, and pushes the exact resulting `HEAD`.

```bash
git add --patch
./infra/scripts/local-commit-push.sh "describe the change"
```

Use `--all` only for an intentional broad commit. All root/scoped `AGENTS.md` files remain excluded
unless `--include-agents` is also passed; staged agent notes are rejected without that flag.

## Mini App Visual Work

```bash
npm run emulator:miniapp
npm run emulator:miniapp:android
npm run emulator:miniapp -- --device android --route '/chat/preview-chat/settings'
npm run screenshots:miniapp
npm run audit:miniapp:visual
```

Emulator, screenshots, and visual audit are local-first and inspect the current working tree. Native
mode installs a safe MAX Bridge shim for BackButton, haptics, share/download, viewport, and storage.

The default screenshot/emulator target is `smartphone`: iOS uses WebKit and Android uses Chromium,
with a WebView sized separately from the phone's system/MAX panels. Captures include both raw
WebView pixels and an approximate phone composition. Existing `smoke`/`moderation` presets keep
their legacy target; set `MINIAPP_SCREENSHOT_TARGET=smartphone` to use the new model with a preset.
See [smartphone capture](docs/miniapp-smartphone-capture.md) for calibration, keyboard models,
failure screenshots, and the limits of desktop emulation.

Use an explicit mode for a deployed-origin audit:

```bash
MINIAPP_SCREENSHOT_MODE=production npm run screenshots:miniapp
MINIAPP_VISUAL_AUDIT_MODE=production npm run audit:miniapp:visual
```

The only routine production mini app URL is `https://major-maksimov.ru/app/`. CDN, Object Storage,
and app2 checks are paused.

## Production Runtime

`infra/docker-compose.yml` runs Postgres, Redis, three static/front-door components, and one shared
API image split into fourteen API roles:

- `api-ingress`: public health and webhooks.
- `api-admin`: `/api/v1/`, mini app, and owner APIs.
- `api-enqueue`: webhook enqueue/materialization.
- `api-moderation`, `api-moderation-realtime-b`, `api-moderation-realtime-c`,
  `api-moderation-realtime-d`: default/realtime shards.
- `api-moderation-critical`: critical/legacy moderation queues.
- `api-moderation-join`: membership/join queues.
- `api-moderation-background`: scheduled/background work.
- `api-media-analysis`: CPU-isolated commercial-image OCR moderation.
- `api-action`: durable MAX action dispatch.
- `api-message-retention`: bounded message-history retention.
- `api-publisher`: publication dispatch.

The same API image also serves `photo-native-sandbox` and `ocr-native-sandbox`. The independent
`eraser` service uses its own image, `eraser-postgres`, and `eraser-redis`.

Static services:

- `miniapp-major-static`: canonical Major mini app.
- `miniapp-static`: legacy play-team support host, not a routine target.
- `admin-static`: closed Safety Desk behind admin nginx Basic Auth.

`infra/docker-compose.scale.yml` is load-testing/split-stack infrastructure and must not run beside
the main production stack.

See `apps/api/src/runtime/runtime-topology.ts` and `apps/api/package.json` for runtime roles and
their development commands, for example `npm run dev:admin --workspace @maxim/api`.

## VPS Access And Deploy

Create ignored per-device access configuration:

```bash
cp infra/env/vps.env.example .env.vps
$EDITOR .env.vps
./infra/scripts/vps-connect.sh doctor
```

Routine commands:

```bash
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh ps
./infra/scripts/vps-connect.sh monitor-readonly 300 15
./infra/scripts/vps-connect.sh postgres-audit all
./infra/scripts/vps-connect.sh deploy main miniapp-major-static
./infra/scripts/vps-connect.sh deploy main admin-static
./infra/scripts/vps-connect.sh deploy main api-ingress
```

Any requested API role expands to all shared-image roles. `npm run vps -- <command>` and
`npm run prod -- <command>` call the same wrapper.

Interactive VPS shells and direct PostgreSQL CLIs are break-glass operations. Routine database
diagnostics use the fixed `postgres-audit` catalog; see `docs/runbook.md` for the reviewed emergency
invocation.

The local deploy wrapper requires successful `Required` and `Analyze JavaScript and TypeScript`
checks from GitHub Actions for the exact selected commit, then requires the synchronized VPS `HEAD` to match that SHA. Active component images use
full-SHA refs and successful strict smokes atomically update component inventory under
`/var/lib/maxim-deploy`. Prisma migrations run only when the shared API component is selected;
static-only mini app and Safety Desk deploys skip them.

Prefer immutable rollback to a retained release manifest. Omit the component to restore API, Major
mini app, and Safety Desk together, or select one component:

```bash
: "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" miniapp-major-static
```

`rollback-release` reuses the recorded image ref and image ID, runs strict smokes, and records a new
current manifest. API rollback also checks Prisma/Postgres/Redis compatibility; static-only rollback
does not require Git or database access. It never switches Git refs, builds images, or runs Prisma
migrations. Ref-based API rollback remains a fallback when no suitable immutable API release exists:

```bash
ROLLBACK_REF="${ROLLBACK_REF:?Set ROLLBACK_REF to a compatible Git ref}"
./infra/scripts/vps-connect.sh rollback-runtime "$ROLLBACK_REF"
```

The ref-based helper rebuilds API only, refuses to start/recreate Postgres or Redis, and records the
resulting API image in release inventory after strict smokes. It cannot restore either static
component. See `docs/runbook.md` before production changes.

## Documentation

- Active production runbook: `docs/runbook.md`
- Incident response: `docs/incident-playbook.md`
- Detailed architecture: `docs/project-description.md`
- Architecture decision: `docs/ADR-001-architecture.md`
- Current references and document status: [documentation index](docs/README.md)

Never commit bot tokens, webhook secrets, production env files, cloud credentials, or Safety Desk
access credentials.
