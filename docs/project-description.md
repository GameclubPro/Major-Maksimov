# MAXIM: актуальное устройство проекта

## 1. Назначение

`MAXIM` — production-монорепозиторий ботов и интерфейсов для управления чатами и каналами MAX.
Система принимает webhooks, сохраняет их до асинхронной обработки, выполняет модерацию и действия в
MAX, поддерживает публикации и предоставляет два разных интерфейса управления.

Основные продукты:

- публичное MAX mini app «Майор Максимов» для администраторов управляемых чатов и каналов;
- закрытый Safety Desk для owner-side проверки модерации, обращений и критических действий;
- ролевой API/worker runtime для webhook ingestion, очередей, модерации и исходящих MAX-действий.

## 2. Монорепозиторий

- `apps/api` — NestJS + Fastify + Prisma + BullMQ.
- `apps/miniapp` — React 19 + Vite, публичное MAX mini app.
- `apps/admin` — React + Vite, закрытый Safety Desk; это не MAX mini app.
- `apps/eraser` — независимый бот «Ластик» со своими Postgres/Redis.
- `packages/contracts` — общие Zod-схемы и TypeScript-типы.
- `infra` — Docker Compose, nginx и production-скрипты.
- `scripts` — локальные проверки, emulator и visual tooling.
- `docs` — активные runbooks, ADR и архивный контекст.

Корневой `AGENTS.md` содержит общие правила, а в каталогах приложений, contracts и infra находятся
узкоспециализированные инструкции.

## 3. API Runtime

API собирается в один Docker image, но production запускает его несколькими сервисами. Поведение
задаёт `APP_ROLE`, а точный профиль сервиса/очередей — `APP_SERVICE_NAME` и typed topology в
`apps/api/src/runtime/runtime-topology.ts`.

Production-сервисы:

| Сервис                      | Роль                                        |
| --------------------------- | ------------------------------------------- |
| `api-ingress`               | публичные health/webhook endpoints          |
| `api-admin`                 | `/api/v1/`, mini app и закрытые owner APIs  |
| `api-enqueue`               | materialization/enqueue webhook work        |
| `api-moderation`            | default moderation shard group              |
| `api-moderation-critical`   | critical/legacy moderation queues           |
| `api-moderation-join`       | membership/join queues                      |
| `api-moderation-realtime-b` | realtime shard group B                      |
| `api-moderation-realtime-c` | realtime shard group C                      |
| `api-moderation-realtime-d` | realtime shard group D                      |
| `api-moderation-background` | background moderation and scheduled work    |
| `api-media-analysis`        | OCR queue, downloads, policy and UDS client |
| `ocr-native-sandbox`        | no-network Sharp/Tesseract auxiliary        |
| `photo-native-sandbox`      | изолированное декодирование фото            |
| `api-action`                | durable MAX action dispatch                 |
| `api-message-retention`     | ограниченная очистка истории сообщений      |
| `api-publisher`             | isolated Publik dispatch                    |

Актуальный список ролей и команд локальной отладки находится в
`apps/api/src/runtime/runtime-topology.ts` и `apps/api/package.json`. Production Compose
не использует `all`. Независимый `eraser` запускается из отдельного образа со своими
`eraser-postgres` и `eraser-redis`.

Nginx направляет публичные webhooks/health в `api-ingress`, обычный `/api/v1/` — в `api-admin`.
Публичный ready endpoint намеренно закрыт; локальные ready endpoints доступны на портах 3001 и 3002.

Стоп-лист чата может отдельно проверять текст на фото. Эта opt-in проверка использует два OCR
прохода с уверенностью по каждому совпавшему слову, не сохраняет распознанный текст и применяет
только удаление сообщения; предупреждения, мут и бан остаются политикой текстовых сообщений.

## 4. Поток Webhook И Модерации

Упрощённый поток:

1. MAX отправляет webhook на bot-scoped URL.
2. Ingress проверяет route/header secrets и валидирует payload.
3. Событие записывается в Postgres с bot-scoped dedupe key.
4. Enqueue role материализует BullMQ work.
5. Событие попадает в critical, join, realtime/default или background moderation queue.
6. Moderation runtime читает настройки и локальные read models, применяет правила и создаёт
   долговечные intents/actions.
7. Action runtime выполняет исходящие MAX-действия с rate limits, source lanes, ledger и защитой от
   двусмысленного повторного send.

Удаление сообщений в enforcement/retry-critical путях проходит через durable delete intents.
Произвольный HTTP 404 не считается подтверждением удаления.

Bot-wide `GET /chats` в MAX больше нет. Production discovery использует локальные access edges,
allowlist, published snapshots, недавние события, `bot_added` и точечные access checks.

## 5. API Домены

Крупные домены включают:

- managed entities, memberships, user access edges и multi-bot routing;
- chat/channel settings, правила, allowlists и bot speech;
- moderation, commercial filtering и global spammer intelligence;
- publications, managed broadcasts/autoposts, polls и giveaways;
- channel dialogs, comments и suggestions;
- channel statistics и поддерживаемые feed/read models;
- VK parsing, sync leases, media cache и autopublish;
- webhook subscription reconciliation, health, diagnostics и runtime governance;
- Safety Desk, support requests и moderation delete review.

Исторические большие реализации остаются в `*.legacy`, но новые controllers/processors должны
использовать публичные facades и focused domain services.

## 6. Публичное Mini App

`apps/miniapp` обслуживается под `/app/`. Production URL:
`https://major-maksimov.ru/app/`.

Mini app:

- получает MAX Bridge из `https://st.max.ru/js/max-web-app.js`;
- отправляет подписанный init data в API как `Authorization: InitData <...>`;
- не доверяет `initDataUnsafe` для аутентификации;
- показывает управляемые чаты/каналы из серверного read model;
- содержит settings, publications, events, statistics, dialogs, polls, giveaways и VK parsing;
- использует server-side cursor filtering для больших publication/feed списков;
- имеет публичные legal routes, доступные без init data.

Публикации в `/publications` и VK parsing принадлежат профилю Публика. Старые ссылки
Major на публикации и автопостинг открывают переход в Публик, не монтируя редактор.
Native back, storage, links, sharing, viewport и haptics проходят через общие bridge helpers.

Visual tooling по умолчанию запускает локальный mini app и проверяет текущий working tree. Проверка
production origin включается только явным visual mode.

Интеграция с «Биржиком» открывает рекламную биржу через собственного бота сервиса
из Major и Publisher. Базы и выпуски остаются независимыми; профиль, сделки и
рекламные размещения принадлежат бирже. Доступ администратора, управление владельца
и независимые настройки кнопок описаны в [действующем контракте интеграции](development/marketplace-integration.md).
Внутренний статистический обмен работает по проверенным правам без отдельного
переключателя в интерфейсе и сохраняет явные прежние отказы; см. [контракт v2](maxim-svyazka-statistics-v2.md)
и [ограниченный постраничный обмен v3](maxim-svyazka-statistics-v3.md). Сбор статистики
не выдаёт согласия на рекламные размещения и не публикует профиль.

## 7. Safety Desk

`apps/admin` — отдельный закрытый интерфейс на `https://admin.major-maksimov.ru/`.

- `admin-static` обслуживает UI на локальном порту 3004.
- Nginx Basic Auth защищает сайт и проксирует same-origin `/api/v1/` в `api-admin`.
- API guard проверяет совпадение admin host и forwarded host, `X-Remote-User` от nginx и origin запроса.
- Public Major nginx sites явно запрещают Safety Desk/support endpoints.
- По решению владельца от 4 ноября 2026 года дополнительного кода доступа нет:
  после Basic Auth панель сразу загружает данные. Пароль не передаётся в приложение или Vite bundle.

Safety Desk не использует MAX Bridge или mini app init data.

## 8. Contracts И Данные

`packages/contracts` содержит общие схемы запросов/ответов, settings, publications, polls,
giveaways, dialogs, statistics и managed entities. Для прямых импортов существуют package subpath
exports.

При изменении contracts синхронизируются:

- `packages/contracts/package.json` exports;
- `tsconfig.base.json` paths;
- `apps/api/jest.config.cjs` mappers;
- API/mini app/admin реализации и тесты.

Contract-only tests находятся в `packages/contracts/test` и запускаются Vitest.

Postgres хранит исходные события, settings, memberships/access edges, moderation/action ledgers,
publications, VK parsing state и поддерживаемые feed/statistics read models. Redis хранит BullMQ
queues, delayed jobs, locks и runtime snapshots в named volume `redis_data`.

Prisma Client генерируется в игнорируемый `apps/api/src/generated/prisma`; runtime импортирует его
через локальный wrapper. Изменение model/enum/database mapping требует migration. Удаление колонок
выполняется двумя runtime releases: сначала совместимый client, затем DB drop.

## 9. Локальная Разработка

Требуется Node 24 LTS. Полная последовательность настройки локальных адресов,
API env и миграций находится в [README](../README.md#local-start).
Для UI и disposable PostgreSQL/Redis используйте
[локальное окружение](development/agent-local-environment.md).
Проверки выбираются по [рабочему процессу](development-reliability-plan.md#daily-workflow);
итоговый агрегат выполняет commit helper. API validation/build scripts владеют
блокировками codegen; внутренние `*:unlocked` и `*:source` не запускаются вручную.

## 10. Production И Деплой

Main production stack — `infra/docker-compose.yml`. `infra/docker-compose.scale.yml` используется
для split/load testing и не запускается одновременно с main stack.

`local-commit-push.sh` по умолчанию работает только с уже staged файлами, проверяет staged impact и
push-ит точный получившийся `HEAD`. Широкий staging включается только через `--all`; agent notes
требуют отдельного `--include-agents`.

```bash
./infra/scripts/vps-connect.sh doctor
./infra/scripts/vps-connect.sh deploy main
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh monitor-readonly 300 15
```

Локальный deploy wrapper требует успешный агрегат `Required` для точного выбранного commit SHA, а
VPS после синхронизации проверяет совпадение своего `HEAD` с этим SHA. Active components используют
immutable full-SHA image refs. Манифесты в `/var/lib/maxim-deploy` хранят source SHA, image ref и
image ID для `api-shared`, `miniapp-major-static` и `admin-static`; новый `current.json` записывается
только после проверки image IDs и строгих smoke checks.

Deploy script собирает shared API image один раз и расширяет запрос любого API role до всех
shared-image roles. Prisma migrations запускаются только при выбранном API component; static-only
deploy `miniapp-major-static` или `admin-static` их пропускает.

Routine mini app deploy использует только `miniapp-major-static` и
`https://major-maksimov.ru/app/`. CDN, Object Storage и app2 приостановлены и не являются fallback.

`rollback-release` восстанавливает любой набор active components из сохранённых immutable images,
проверяет image IDs, выполняет строгие smokes и записывает новый rollback manifest без Git switch,
build или запуска migrations. Prisma/Postgres/Redis compatibility требуется только при выборе API;
static-only rollback не зависит от Git и БД. `rollback-runtime` остаётся ref-based API-only fallback:
он не запускает stateful services, сохраняет текущую Compose topology и после строгих smokes
обновляет release inventory. Активная процедура описана в `docs/runbook.md`.
