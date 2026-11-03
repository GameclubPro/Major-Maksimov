# VK-парсинг: аудит и план оптимизации

Дата ревизии: 2026-08-29.

Это исторический аудит. Актуальные исправления надёжности и план проверки описаны
в [ревизии 2026-09-17](../../vk-parsing-reliability-audit.md); разделы о текущем состоянии
ниже относятся к дате исходного документа.

Документ фиксирует состояние VK-парсинга и автопубликации после инцидента, актуальные ограничения официальных VK/MAX API, основные риски и современный план оптимизации.

## Текущее состояние прода

- VK import принадлежит только профилю и боту «Публик». Публичный API использует namespace `/api/v1/publisher/entities/:entityType/:entityId/vk-parsing`; старые Major routes удалены.
- Sync и publish исполняются только `api-publisher`. `api-action` больше не запускает VK runner, sync worker или publish worker.
- `vk-parsing-publish` выведена из эксплуатации и удаляется отдельной fail-closed командой после перехода runtime. Активная очередь публикации — только `vk-parsing-publisher`.
- Scheduler, sync job и DB lease проверяют точный `PUBLISHER` owner scope и bot ID. Сохранённый Major source не может быть синхронизирован или опубликован.

- Аварийные действия уже выполнены: VK-автопубликация отключена для всех managed entities, очередь публикации очищена, publish-маркеры в БД очищены, спам-сообщения MAX, которые успел создать runaway-autoposting, удалены.
- Runtime API уже усилен коммитами `fa68d97b` и `9196e512`:
  - автопубликация имеет явный baseline через `vk_parsing_settings.auto_publish_enabled_at`;
  - посты без реального времени публикации VK не подходят для автопоста;
  - посты до baseline отбрасываются даже если старый publish-job дошёл до worker;
  - отключение автопубликации очищает queued/locked/idempotency publish-маркеры;
  - skipped/unavailable/failed autopublish paths очищают временные publish-маркеры.
- Этот follow-up добавляет ещё один инвариант: у источника уже должен быть успешный sync (`lastSuccessAt`), прежде чем scheduled/manual импорт сможет ставить посты в автопубликацию. Если первичный `source-added` backfill упал, а первый успешный retry позже пришёл как `scheduled`, он всё равно считается первым sync и не автопубликует исторические посты.

## Актуальные факты VK

Официальные источники:

- VK `wall.get`: https://dev.vk.com/ru/method/wall.get
- VK `wall.getById`: https://dev.vk.com/ru/method/wall.getById
- Формат запросов и лимиты VK API: https://dev.vk.com/ru/api/api-requests

Факты, важные для текущей реализации:

- Хост VK API: `api.vk.ru`.
- Токен надо передавать через `Authorization: Bearer <KEY>`.
- `wall.get` может работать с сервисным ключом, поддерживает `filter=owner` и `extended=1`.
- `wall.get` возвращает `count` и `items`; при `extended=1` также возвращает связанные `profiles` и `groups`.
- `wall.getById` принимает comma-separated идентификаторы `ownerId_postId`, максимум 100 ID.
- POST-запросы VK API должны использовать `application/x-www-form-encoded` или `multipart/form-data`; `application/json` сейчас не поддерживается.
- Лимиты VK зависят от типа токена. Для сервисного ключа документированный нижний уровень: 5 rps для приложений меньше 10 000 пользователей, дальше 20 rps и 35 rps. Ошибка `6` означает too many requests per second.
- Помимо rps есть количественные лимиты однотипных методов; при превышении метод может начать требовать captcha или временно ограничиться.

Соответствие кода:

- `VK_API_BASE_URL` по умолчанию `https://api.vk.ru`.
- `VK_API_VERSION` по умолчанию `5.199`.
- `VK_API_RPS` по умолчанию `5`, то есть безопасный нижний лимит сервисного ключа.
- Запросы отправляют `Authorization: Bearer <token>`.
- `VK_PARSING_FETCH_COUNT` ограничен схемой env до `1..100`.
- Retryable VK-коды включают rate/temporary ошибки; terminal-коды включают access/deleted/blocked/content-blocked случаи.

## Актуальные факты MAX

Официальные источники:

- MAX API overview: https://dev.max.ru/docs-api/
- MAX `POST /messages`: https://dev.max.ru/docs-api/methods/POST/messages
- MAX `POST /uploads`: https://dev.max.ru/docs-api/methods/POST/uploads

Факты, важные для текущей реализации:

- Bot token надо передавать как `Authorization: <token>`; query-token transport больше не поддерживается.
- API host: `https://platform-api2.max.ru`.
- MAX указывает потолок 30 rps для `platform-api2.max.ru`, но не уточняет область действия для независимых bot tokens. Реализация ограничивает каждый token отдельно и не добавляет общий потолок 30 rps на весь набор ботов.
- `POST /messages` ограничивает текст 4000 символами и поддерживает attachments + text format.
- Загрузка медиа идёт через `/uploads`; `type=photo` deprecated, нужен `type=image`.
- Media publish многошаговый: получить upload URL, загрузить бинарник, затем отправить token/payload в сообщении.

Соответствие кода:

- MAX client использует header authorization.
- VK-autopublish идёт с `MAX_API_SOURCE_TAGS.VK_PARSING` и background traffic class.
- Текст VK-публикации ограничен shared contract до 4000 символов.
- Background image uploads для VK serialized, чтобы не делать резкий всплеск MAX-запросов.
- `attachment.not.ready`/not-ready send failures ретраятся с коротким backoff.

## Текущая архитектура

- VK-парсинг доступен для Publisher-owned chats и channels. Видимость в mini app идёт через server capability endpoint; backend проверяет exact Publisher entity access.
- Источники лежат в `vk_parsing_sources`.
- Настройки автоматизации лежат в `vk_parsing_settings`.
- Импортированные посты лежат в `vk_parsing_posts`; media preflight/upload cache хранится отдельно.
- Sync источников идёт через BullMQ queue `vk-parsing-sync`.
- Autopublish/manual retry идут только через BullMQ queue `vk-parsing-publisher`.
- Runner и sync processor работают только на точном runtime `api-publisher`; queue job содержит Publisher owner scope.
- Sync/publish processors работают с concurrency `2`.
- DB source leases защищают от конкурентного sync одного источника.
- Publish idempotency опирается на content-derived idempotency key и DB queued/locked поля.

## Корень инцидента

Опасным был не сам scheduled loop: он обязан периодически синхронизировать источники. Ошибка была в том, что старые импортированные VK-посты могли стать eligible для автопоста после включения автоматизации, и worker начал выгребать исторический backlog вместо публикации только новых постов после включения.

Зафиксированный продуктовый инвариант:

- включение автопубликации создаёт baseline timestamp;
- `source-added` backfill никогда не автопубликуется;
- первый успешный sync источника без предыдущего `lastSuccessAt` никогда не автопубликуется, даже если job reason равен `scheduled` или `manual`;
- eligible autopublish требует реальный `vkPublishedAt`;
- eligible autopublish требует `vkPublishedAt >= autoPublishEnabledAt`;
- stale queued autopublish jobs повторно проверяются в publish worker и отбрасываются, если setting/baseline больше не разрешают публикацию;
- отключение автопубликации очищает transient publish state.

## Оставшиеся трудности

- Kill switch: отдельного глобального VK-autopublish kill switch пока нет. Emergency SQL работает, но это слишком ручной путь.
- Circuit breaker: пока нет автоматической остановки, если publish volume резко вырос выше безопасного порога для chat/source/window.
- Dry run: включение автопубликации пока не показывает preview count eligible-постов и точную baseline-семантику.
- Audit trail: изменения настроек не пишутся в полноценный admin audit log с actor, previous value, next value и baseline.
- Manual refresh: ручной sync забирает более широкое окно. Нужно явно закрепить в UI и коде, что manual refresh импортирует старые посты, но не публикует исторический материал без отдельного будущего режима.
- Queue visibility: health summary показывает backlog/lag, но операторам нужен прямой dashboard/runbook по waiting/active/delayed/failed jobs в VK-очередях.
- MAX rollback: удаление уже отправленных MAX-сообщений безопасно только если сохранены message IDs/URLs и delete API позволяет это сделать. Нужна более удобная выборка rollback по incident window.
- VK rate limits: service-token лимиты низкие, а количественные лимиты/captcha могут душить отдельный метод без нормального API-ответа.
- VK access errors: private/deleted/blocked/content-restricted groups должны ясно переводить источник в terminal/backoff состояние и понятно показываться в UI.
- Media reliability: VK media URLs могут истекать или блокировать HEAD/Range. Preflight помогает, но media publish остаётся самой хрупкой частью автопоста.
- Attachment fidelity: сейчас поддерживаются text/photos/links. Reposts, videos, clips, polls, docs, albums, market items и сложные articles импортируются частично или помечаются unsupported.
- Advertising detection: текущая эвристика использует VK flags и текстовые маркеры. Она намеренно консервативна, но возможны false positives/false negatives.
- Publisher routing: публикация обязана использовать точный Publisher bot, Publisher-owned access и background MAX lane; fallback на moderation bot запрещён.

## Roadmap

### P0: safety baseline после инцидента

Статус: выполнено или входит в текущий patch.

- Отключить текущую prod-автопубликацию и удалить incident spam messages.
- Очистить publish queue и DB publish markers.
- Требовать `autoPublishEnabledAt` для автопоста.
- Требовать реальный VK `vkPublishedAt` для автопоста.
- Никогда не автопубликовать `source-added` backfill.
- Никогда не автопубликовать первый успешный sync источника без предыдущего `lastSuccessAt`.
- Повторно проверять eligibility в publish worker.
- Очищать publish-маркеры при disable, skipped, unavailable и failed autopublish outcomes.
- Покрыть всё выше focused Jest tests.

### P1: операторские предохранители

- Добавить global VK autopublish kill switch. Рекомендуемая форма: env default + DB/system setting, где DB setting применяется без deploy.
- Добавить per-chat/source circuit breaker: если за M минут queued/published больше N постов, остановить queueing, auto-disable setting и записать incident event.
- Добавить dry-run preview перед включением автопубликации:
  - текущий baseline timestamp;
  - сколько постов стало бы eligible прямо сейчас;
  - latest imported VK post timestamp;
  - warning, если источник ещё ни разу успешно не синкался.
- Добавить admin audit events для VK setting changes и source changes.
- Развести manual refresh поведение в UI:
  - default: "Refresh/import only";
  - "Publish selected" через текущую ручную публикацию;
  - никакого implicit manual bulk autopublish.
- Добавить alerts:
  - любая включенная автопубликация в production;
  - publish backlog выше threshold;
  - publish rate spike по chat/source;
  - VK API error-rate spike;
  - repeated MAX upload/send failures;
  - queue jobs stuck active/locked дольше lease TTL.

### P2: scheduling и reliability

- Подключить `BackgroundRuntimeGovernorService` к VK scheduled/startup runners, чтобы low-priority VK-work slowed/paused при системном давлении.
- Сделать per-source scheduling более adaptive:
  - fast interval только для recently active источников;
  - slow interval для inactive sources;
  - backoff для repeated empty fetches или terminal-looking errors;
  - достаточно большой jitter, чтобы не создавать synchronized bursts.
- Ввести source health score и показывать last terminal VK code в UI.
- Добавить operator queue dashboard/runbook для `vk-parsing-sync` и `vk-parsing-publisher`; retired `vk-parsing-publish` остаётся только нулевым regression sentinel.
- Добавить stale-lock cleanup task для publish locks, не только opportunistic lock windows.
- Добавить deletion/rollback helper по autopublished window, chat, source и system actor.
- Расширить tests на multi-source/multi-chat idempotency и stale BullMQ jobs после изменения settings.

### P3: media и content fidelity

- Расширять attachment support в таком порядке:
  - repost text rendering с ясной attribution;
  - documents/images where safe;
  - videos/clips как links или native upload, когда стабильно;
  - polls/articles как summarized links;
  - albums/market items как explicit unsupported summaries.
- Добавить retention/refresh rules для media upload tokens и лучшую классификацию MAX upload retry.
- Добавить per-attachment warnings в mini app, чтобы админ видел, что именно не будет зеркалироваться.
- Добавить retention policy для старых imported posts и media cache.
- Добавить dashboards по sync lag, publish lag, media failure ratio и VK/MAX error codes.

## Validation checklist для VK changes

Local:

- `npm test --workspace @maxim/api -- vk-parsing.service.spec.ts`
- `npm run check:api`
- `git diff --check`

Production после API deploy:

- health checks live/ready;
- `vk_parsing_settings.auto_publish_enabled` остаётся disabled, если админ явно не включал;
- `vk_parsing_posts.publish_queued_at`, `publish_locked_at`, `publish_idempotency_key` не имеют неожиданного backlog;
- `vk-parsing-sync` и `vk-parsing-publisher` не имеют неожиданных waiting/active/delayed jobs;
- retired `vk-parsing-publish` отсутствует и не имеет workers;
- нет свежих `auto_published_at` rows, пока автопубликация disabled.

## Emergency runbook

Использовать только при инциденте и после проверки точного scope.

1. Отключить автопубликацию в БД для affected scope или глобально.
2. Очистить queued/locked/idempotency publish-маркеры affected posts.
3. После Publisher-only runtime проверить и удалить retired queue только через `./infra/scripts/vps-connect.sh vk-parsing-retire-legacy-queue --apply`; команда откажет при worker или active job и не использует force.
4. Удалять уже published MAX messages только по записанным incident rows с сохранёнными message IDs/URLs.
5. Проверить DB counts и BullMQ counts.
6. Задеплоить code guard до любого повторного включения automation.
