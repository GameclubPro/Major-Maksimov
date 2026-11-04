# Infrastructure Agent Notes

Root workflow and safety rules apply. Read the relevant sections of the
[production operations reference](../docs/development/production-operations-reference.md) before
an operation; its detailed guards, recovery protocols and rollback floors remain mandatory.

## Select The Operation

| Work                                               | Required reference                                                                                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host, roles, containers or shared resources        | [Topology](../docs/development/production-operations-reference.md#active-production-topology) and [REG.RU profile](../docs/operations/runbooks/reg-production-profile.md)                     |
| SSH, probes, bounded incidents                     | [VPS access](../docs/development/production-operations-reference.md#vps-access)                                                                                                               |
| Deploy, preload, rollback, release recovery        | [Deploy and rollback](../docs/development/production-operations-reference.md#deploy-and-rollback) and [strict smokes](../docs/development/production-operations-reference.md#required-smokes) |
| Database/Redis, queues, backup, restore, retention | [Postgres and Redis](../docs/development/production-operations-reference.md#postgres-and-redis) and the named procedure's runbook                                                             |
| nginx, domains, TLS, static delivery               | [Nginx](../docs/development/production-operations-reference.md#nginx-and-edge)                                                                                                                |
| Environment files or Git transport                 | [Environment](../docs/development/production-operations-reference.md#environment-and-git-safety) and [VPS access](../docs/development/production-operations-reference.md#vps-access)          |

## Production Identity

- `maxim-vps` is REG.RU `89.108.122.76` as `maximadmin`, checkout `/var/www/Chat_bot`.
  Host: 12 physical cores / 24 threads, 64 GB RAM, NVMe RAID1. Never deploy to or restore from
  the retired Yandex host. Measure actual headroom; other projects share this server.
- `infra/docker-compose.yml` is production; scale topology is for separate load tests. Never
  start both. Svyazka (`/var/www/svyazka`, `/market/`) and Karavan
  (`/var/www/max-delivery-platform`) are independent: preserve their routes, stores and services.
- «Ластик» has its own image, webhook, PostgreSQL and Redis. Keep its token out of API roles;
  preserve takeover fences and follow [its rollout](../docs/operations/runbooks/eraser-rollout.md).
- The shared API image has exactly 14 roles: `api-ingress`, `api-admin`, `api-enqueue`,
  `api-moderation`, `api-moderation-critical`, `api-moderation-join`, `api-moderation-realtime-b`,
  `api-moderation-realtime-c`, `api-moderation-realtime-d`, `api-moderation-background`,
  `api-media-analysis`, `api-action`, `api-publisher`, `api-message-retention`.
- `ocr-native-sandbox` and `photo-native-sandbox` are isolated auxiliaries of that image, not API
  roles. Preserve their no-network/no-secret environment, exact native identity, bounded native
  concurrency and resource budgets. Keep their consumer-stop/replacement/release order.
- Ingress owns public health/webhooks; admin owns `/api/v1/` and closed owner APIs. Keep Publisher
  credentials and dialog signing material in their existing role boundaries.
- Routine mini app: `miniapp-major-static`, `https://major-maksimov.ru/app/`, port 3003.
  Safety Desk: `admin-static`, port 3004, protected `admin.major-maksimov.ru`. Legacy support static
  is not a routine deploy target. CDN/app2/Object Storage app delivery stays paused.

## Execution And Delivery

- Use `./infra/scripts/vps-connect.sh` (`doctor`, `health`, `ps`, `logs`, `monitor-readonly`,
  `postgres-audit`) and `docker compose`. Interactive shell/raw database work is break-glass,
  not the default. Do not print secrets, weaken host-key checks or change persistent SSH identity.
- Keep a long-running wrapper's checkout immutable: Bash may resume reading it after a child
  returns. Deploy from a clean release checkout; keep live monitoring on its unchanged source.
  Track process identity, heartbeat, last successful sample, deadline and exit status; record gaps.
- Commit only owned staged files through `local-commit-push.sh`; include `--include-agents` for
  agent notes. Require exact-SHA `Required` and `Analyze JavaScript and TypeScript` before deploy,
  then verify remote HEAD, component image refs, strict smokes and committed release manifest.
- Use `deploy main --auto` for the planner-selected components. Shared API/contract changes
  recreate every API role and associated auxiliaries; static-only deploys do not run migrations.
  Never recreate Postgres/Redis for an ordinary application release.
- Active component manifests live under `/var/lib/maxim-deploy`; images use full-SHA tags.
  Roll back with `rollback-release release-id` (component-scoped) or the API `rollback-runtime`
  fallback only after reading the procedure. Preserve all installed reader/version floors;
  disabling a feature does not make an old image safe.
- Ordinary deploy prepares and preloads CI-tested GHCR digests before runtime changes; missing
  image proof stops delivery. See [CI image delivery](../docs/development/ci-image-delivery.md).
  Use the configured Git transport. Only a GitHub SSH origin accepts the caller-only
  `MAXIM_DEPLOY_GIT_SSH_PORT=443` override; HTTPS origins keep their normal transport.
  Preserve trusted host keys and the reviewed identity. Do not repeat a partial deploy blindly.
- All production mutations serialize through the persistent protected deploy lock. Backup,
  deploy, preload and recovery must not bypass it. Never unlink/reset the lock or journal.
- Rollout reserves remain 10 GiB for API and 6 GiB for static-only releases; GHCR pull additionally
  requires twice the tested image size. Overrides may raise, never lower. Online migration
  preparation preserves 10 GiB
  on every involved filesystem throughout work. Prefer manifest-aware MAXIM image reclaim,
  capacity expansion or immutable preload; never run host-wide Docker GC.
- A rollout timeout requires inspection of exact runtime, queue fence, progress, DB/host pressure
  and transition journal. Use guarded adoption/finalization only for its proved state. Do not
  extend timeouts, suppress readiness, clear queues or recreate healthy roles to hide the failure.
- Fleet-wide abandonment/stopping requires its concrete preview and separate scope authorization.
  One group's recovery is not fleet permission. Preserve unknown effects, installed holds, original
  journals and exact deadlines. Never downgrade a compatible controller or fabricate completion.

## Stores, Probes And Acceptance

- Production stateful volume paths under `/mnt/maxim-cold/runtime` and their Docker cold-mount
  guard are persistent identity. Do not recreate volumes or accept drift. The cold filesystem is
  on the same RAID failure domain; it is not an independent backup.
- Routine SQL uses only the reviewed `postgres-audit` catalog, sequentially, with fixed budgets,
  indexes and audit grants. No ad hoc SQL, raw psql/dump/restore, broad history aggregates or live
  `EXPLAIN ANALYZE`. Read the matching report/runbook before a new query or grant.
- Keep Redis queues, delayed jobs, locks and snapshots intact. Queue retirement and restore have
  named preview-first protocols; never use FLUSH, force obliteration or manual evidence deletion.
- Preserve the 512 MiB Postgres shared-memory budget and reviewed per-role pool limits. Measure
  query pressure and independent queue progress before increasing concurrency; MAX quotas do
  not grow with the host. The exact settings are in Compose and its production pool tests.
- Backup acceptance requires a complete independently replicated encrypted copy/readback and an
  isolated restore. Timers stay disabled until health evidence passes. Keep guarded live backups
  low-priority, rate/time bounded and cleaned by exact application identity. See
  [recurring backups](../docs/operations/runbooks/postgres-recurring-backups.md).
- For incidents retain exact UTC window, runtime/controller/image identity and capped/missing
  samples. Keep action success, receipt settlement, quarantine and cancellation separate. Inspect
  API restarts separately from required native timeout containment. A healthy queue or HTTP 200
  does not prove all features; run strict role/native/static smokes and fresh closed cohorts.
- User-requested final acceptance starts after deployment and prerequisite gates. Monitoring gaps
  or a corrective release invalidate that window; do not substitute earlier diagnostics.
- nginx changes preserve other projects and exact request/body limits. Keep backups outside
  `sites-enabled`, run `nginx -t` before reload, and use the canonical host.
- Infrastructure changes run `npm run check:infra` including ShellCheck. Update scoped references,
  active runbooks and generated deploy impact/topology mappings when those contracts change.
