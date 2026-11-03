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

1. Copy `.env.example` to ignored `.env` and configure local values.
2. Install dependencies:

   ```bash
   npm ci
   ```

3. Start Postgres and Redis with local ports:

   ```bash
   docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml up -d postgres redis
   ```

4. Start all development servers:

   ```bash
   npm run dev:all
   ```

Focused servers are `npm run dev:api`, `npm run dev:miniapp`, and `npm run dev:admin`.

The env example supports multiple bots: `MAX_ENTRY_BOT_ID` selects the canonical start/startapp bot,
additional bots live in `MAX_BOTS_JSON`, and `state: "dormant"` keeps a provisioned bot visible in
metadata without webhook/action execution.

## Validation

```bash
npm run typecheck:contracts
npm run test:contracts
npm run check:api
npm run check:prisma
npm run check:miniapp
npm run typecheck:admin
npm run test:admin
```

Use `npm run check` for the broad CI-style pass. API validation scripts serialize contracts/Prisma
codegen; internal `*:unlocked` and `*:source` scripts are not normal parallel entrypoints.

## Submit Changes

Work in a task worktree on a `codex/` branch; keep `main` clean at the verified production SHA.
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
npm run emulator:miniapp -- --device android --route '/chat/preview-chat/settings?focus=broadcast'
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
- Historical plans, audits, and delivery context: [archive index](docs/operations/archive/README.md)

Never commit bot tokens, webhook secrets, production env files, cloud credentials, or Safety Desk
access credentials.
