# Фото-антидубль: план оптимизации и агентских сессий

Исторический аудит от 2026-08-06, релиз `3d5a4647c7e14cb38a62ab74e5bffc0190532f4f`.
На том срезе фото-антидубль находился в global `shadow`; enforcement и advanced allowlist
были пусты. Текущую конфигурацию этот отчёт не подтверждает. Для новой задачи сверяйте выбранный контракт
с кодом, [правилами API](development/api-domain-reference.md#moderation-and-read-models)
и [процедурами выпуска](runbook.md).

## Цель

Довести детерминированный фото-антидубль без AI до контролируемого production-enforcement:

- учитывать точный MAX `photo_id`, нормализованный SHA-256 и perceptual PDQ;
- подтверждать качество на реальных чатах без скрытого удаления сообщений;
- иметь ручную проверку каждой положительной пары;
- ограничивать CPU, native memory, Redis и BullMQ backlog;
- включать действия по одной оси риска и иметь быстрый downgrade до `shadow`/`off`;
- не менять существующую семантику текстового антидубля случайно.

План не разрешает глобальное включение фото-флага, отправку тестовых сообщений в чужие чаты
или повышение rollout-режима без отдельного согласования точных chat IDs.

## Production baseline

Срез на 2026-08-06 после релиза `release-20260805T211801Z-3d5a4647c7e1`:

| Сигнал                  | Значение                                 |
| ----------------------- | ---------------------------------------- |
| API runtime             | 11 ролей на одном SHA, restart count 0   |
| Health                  | normal, DB/Redis ready, queue lag 0      |
| Chat settings           | 8622 записей                             |
| Текстовый антидубль     | включён у 7569 чатов                     |
| Фото-антидубль          | включён у 0 чатов                        |
| `photo-duplicates`      | wait/active/delayed/failed/completed = 0 |
| Фото history/order keys | 0                                        |
| Redis                   | около 453 MiB, evictions 0               |
| VPS disk                | 94%, свободно около 7.1 GiB              |

Индексированная 30-минутная выборка реального трафика дала ориентир около 24 уникальных
фото-jobs в минуту, p95 альбома 2, максимум 10. Самый активный чат дал 25 фото-сообщений
за 30 минут. Это capacity baseline, а не доказательство качества: feature traffic пока равен нулю.

Перед каждой следующей сессией baseline надо снять заново bounded/indexed запросами. Старые числа
нельзя использовать как текущее состояние production.

## Неподвижные инварианты

1. Любая ошибка download/decode/history/metrics/review работает fail-open для пользовательского
   сообщения. При отсутствии доказанного совпадения действие запрещено.
2. Перед delete/warn/mute/ban worker повторно читает chat settings, rollout policy, manual release,
   admin/immunity и action fence.
3. Один логический MAX message остаётся идемпотентным при multi-bot fanout. Все новые keys/rows
   имеют deterministic job/message identity и replay-тест.
4. Фото с конкурирующим нарушением может пополнить duplicate baseline, как текстовая duplicate-state,
   но не получает второй counter/action. Это поведение закрепляется отдельным тестом.
5. Shadow observation не создаёт `ModerationEvent`, `ChatModerationFeedItem` или санкцию: иначе
   пользовательская статистика и лента будут искажены.
6. Метрики имеют только bounded enum labels. Chat/user/message IDs, download URLs, tokens и hashes
   не становятся metric labels и не попадают в обычные логи.
7. Оригинальные изображения и MAX URLs не сохраняются в review storage. Допустим только bounded
   low-resolution evidence для положительных пар с явной retention и quota.
8. Изменение Redis layout или fingerprint policy получает новую версию namespace. Сначала dual-read
   shadow comparison, затем переключение; in-place reinterpretation старых данных запрещена.
9. Enforcement не включается для match kind или action, который нельзя отдельно отключить.
10. Никаких AI-моделей, OCR, распознавания лиц или семантического сравнения в scope этого плана нет.

## Карта сессий

| ID  | Результат                                       | Зависимость                           | Runtime rollout           |
| --- | ----------------------------------------------- | ------------------------------------- | ------------------------- |
| S0  | Production baseline и этот план                 | завершено                             | без изменений             |
| S1  | Телеметрия и закрытая ручная проверка           | исправленный S2 core                  | deploy, `shadow`, 0 чатов |
| S2  | Correctness, retry/deadline и честный UI        | S0                                    | deploy, `shadow`, 0 чатов |
| S3  | Corpus, benchmark, admission, isolation и index | S1 + S2                               | deploy, `shadow`, 0 чатов |
| S4  | Стабильный 7-дневный shadow-canary              | обязательные S3 units + approved IDs  | согласованные чаты        |
| S5  | Exact delete-only cohorts                       | успешный S4                           | allowlist по ступеням     |
| S6  | PDQ/advanced/full                               | успешный S5 и отдельные quality gates | по одной оси риска        |

S1-S3 являются кодовыми campaigns из нескольких releasable units. S4-S6 нельзя склеивать с
кодовым deploy: наблюдение должно происходить на одном неизменном SHA.

На практике S1-S3 являются campaigns, а не одним огромным agent turn. Исполняемые units:

| Unit | Scope одного agent session                                         | Deploy                |
| ---- | ------------------------------------------------------------------ | --------------------- |
| S1-A | lifecycle metrics + closed snapshot + VPS monitor                  | API/infra             |
| S1-B | review models/API/evidence lifecycle                               | Prisma/contracts/API  |
| S1-C | Safety Desk review UI/blob client                                  | contracts/admin       |
| S2-A | immutable observation-only semantics + fences                      | API                   |
| S2-B | replay-safe counter/immunity + typed retry/cache/deadline          | API                   |
| S2-C | effective-mode contract/UI matrix                                  | contracts/API/miniapp |
| S3-A | corpus + benchmark harness, без runtime changes                    | нет                   |
| S3-B | admission/governor/resource guards                                 | API                   |
| S3-C | platform-to-canonical cache, dual-run                              | API                   |
| S3-D | PDQ v2 index, dual-read only                                       | API                   |
| S3-E | отдельный photo consumer/topology, обязательно до real-chat canary | API/infra             |

Один agent session выполняет ровно один unit. Следующий unit начинается новым baseline/impact plan;
агент не продолжает автоматически через deploy, migration или многодневный observation gate.

Рекомендуемая release-последовательность:

1. R1 = S2-A semantics.
2. R2 = S2-B replay-safe counter/immunity + retry/cache/deadline.
3. R3 = S1-A lifecycle metrics/monitor.
4. R4 = S1-B review storage/API.
5. R5 = S1-C Safety Desk review UI.
6. R6 = S2-C settings contract/UI.
7. R7 = S3-A corpus/benchmark, test-only.
8. R8 = S3-B admission/resource guards.
9. R9 = S3-E isolated photo consumer.
10. S4.0 controlled test-chat shadow для capacity/cache/index comparisons.
11. S3-C optional exact-cache dual-run, затем отдельный 24-hour audit на неизменном SHA.
12. S3-D PDQ dual-read, затем отдельный 7-day oracle audit на неизменном SHA.
13. Финальные S4.0-S4.4 на final SHA и только потом S5.

Каждый code/config change обнуляет соответствующее observation window. S3-C можно не реализовывать,
если benchmark не доказывает полезность; S3-D нужен до любого perceptual enforcement.

### File ownership map

Новые файлы создаются рядом с указанными boundaries; точное имя проверяется по local patterns.

| Unit | Основные owned paths                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2-A | `apps/api/src/moderation/moderation.service.legacy.ts`, `photo-duplicate.queue.ts`, `photo-duplicate-moderation.service.ts` и их specs                                                |
| S2-B | `photo-duplicate-moderation.service.ts`, history/immunity idempotency helpers, `secure-photo-downloader.ts`, analysis/fingerprint/decode, processor/order store и specs               |
| S1-A | новый `photo-duplicate-metrics.service.ts`, `apps/api/src/system/`, `infra/scripts/vps-monitor-readonly.sh` и monitor tests                                                           |
| S1-B | `apps/api/prisma/schema.prisma` + migration, новый shared photo review module/service, `safety-desk.controller.ts`, `safety-desk.service.ts`, `packages/contracts/src/safety-desk.ts` |
| S1-C | `apps/admin/src/safety-desk-ui.tsx`, API client/model, focused view/security tests и `styles.css`                                                                                     |
| S2-C | `packages/contracts/src/duplicate-settings.ts`/`core.ts`, `admin-settings.service.ts`, `settings-page.legacy.tsx`, `settings-duplicate-photo-*`, rules/preview tests                  |
| S3-A | новые corpus/benchmark files под `apps/api/src/moderation/photo-duplicate/` и `apps/api/src/scripts/`; package scripts wiring делает root                                             |
| S3-B | `photo-duplicate-enqueue.service.ts`, новый admission store, processor, config schema/spec и metrics call sites                                                                       |
| S3-C | `photo-duplicate-analysis.service.ts`, fingerprint/history cache helpers и oracle specs                                                                                               |
| S3-D | versioned history/index store, `photo-fingerprint.ts` oracle/property tests и config schema                                                                                           |
| S3-E | `app-role.ts`, `runtime-topology.ts`, both Compose files, Prisma pool spec, deploy topology/guards/monitor, scoped notes/runbook                                                      |

Root agent один редактирует shared conflict hotspots `apps/api/src/moderation/moderation.module.ts`,
общий env wiring и package scripts после того, как subagents вернули интерфейсы. Во время одного unit
ownership не расширяется на соседнюю строку таблицы.

## Общий протокол агентской сессии

### Старт

Root agent обязан:

1. Прочитать root и все затрагиваемые scoped `AGENTS.md` полностью.
2. Выполнить:

```bash
git status --short
git rev-parse HEAD
node scripts/agent/plan.mjs --worktree
```

3. Зафиксировать чужие изменения и не брать их в ownership. На baseline-аудите таким изменением был
   `.env.example`; его нельзя автоматически форматировать, stage или откатывать.
4. Проверить production manifest, health, роли, restart counts, rollout mode, allowlists, очередь,
   Redis evictions и свободный диск read-only командами.
5. Создать task plan, где одновременно `in_progress` только один интеграционный этап.

### Делегирование

Использовать root + максимум три subagents. Владение файлами должно быть непересекающимся:

- subagent не коммитит, не пушит, не деплоит и не меняет production;
- root владеет module wiring, shared conflict hotspots, staging, commit, deploy и финальными smokes;
- каждый subagent возвращает список изменённых файлов, assumptions, focused tests и незакрытые риски;
- если два потока требуют один файл, его редактирует root после получения обоих отчётов;
- новая user-инструкция или неожиданный overlapping worktree change имеет приоритет над планом.

### Выход

Каждая кодовая сессия завершается только после:

```bash
git diff --check
node scripts/agent/plan.mjs --worktree
npm run check:refactor-guards
```

Затем выполняются проверки конкретной сессии, staging только owned files, staged impact plan,
exact-SHA CI, guarded deploy и production smokes. Feature flags после deploy не повышаются.

## S1: телеметрия и review surface

### Результат

Для каждого eligible job видно, был ли он поставлен, обработан, пропущен или потерян. Каждое
shadow-совпадение имеет metadata row в закрытом Safety Desk; пара previews гарантируется только для
evidence-eligible/canary cohort. Сбой телеметрии не влияет на moderation, а сбой обязательного audit
evidence, когда его требует match policy, запрещает destructive action.

### Параллельные потоки

| Поток           | Ownership                                                | Не трогает                        |
| --------------- | -------------------------------------------------------- | --------------------------------- |
| S1-A Metrics    | новые photo metrics service/spec, system snapshot        | Prisma, miniapp/admin UI          |
| S1-B Review API | Prisma migration, review service, guarded API, contracts | processor/moderation call sites   |
| S1-C Review UI  | Safety Desk view/blob client/tests                       | API feature implementation, infra |
| Root            | module wiring и instrumentation call sites               | чужие worktree changes            |

### Метрики

Добавить bounded Redis time-bucket service по образцу
`apps/api/src/system/webhook-ingress-metrics.service.ts`.

Обязательная taxonomy:

- eligibility: `eligible`, `disabled`, `policy_off`, `unsupported_update`;
- enqueue: `queued`, `duplicate_job`, `shed`, `failed`;
- job: `started`, `new`, `duplicate`, `out_of_order`, `incomplete`, `unavailable`, `abandoned`,
  `retry`, `final_failure`;
- incomplete/failure code: stable enums без текста URL или exception body;
- cache: per-image `hit`, `miss`, `write_failed`;
- match: `platform_id`, `canonical_sha256`, `pdq`, preset, scope, rollout mode; `platform_id` пока
  зарезервирован и до S3-C должен оставаться 0;
- histograms: queue age, end-to-end, download, decode-gate wait, decode, history lookup и action;
- capacity: candidate count, history truncation, admission rejection и evidence quota rejection.

Snapshot должен быть доступен только через существующую закрытую system/Safety Desk boundary.
Routine VPS monitor обязан явно включать `photo-duplicates`; API queue snapshot уже знает эту очередь.

Метрики попыток и terminal outcomes разделяются. Bull retry не должен выглядеть как новый логический job.
Funnel хранится cohort-based по opaque logical job ID через atomic Lua lifecycle: `eligible -> enqueued ->
started -> terminal`. Повторная запись terminal idempotent, а attempts/retries считаются отдельно. Иначе
sliding buckets могут ложно показать `started > enqueued` на границе окна.

Promotion funnel считается только по matured cohort старше максимального source-ready/retry budget.
Snapshot содержит `available`, `stale`, `lastSuccessAt`, `lastFailureAt`, `terminalCoverage` и
`evidenceCoverage`. Для S4 buckets живут минимум 8 дней либо каждый checkpoint сохраняет immutable
rollup: 24-часовая retention не позволяет доказать семидневный gate.

Предпочтителен отдельный закрытый photo diagnostics endpoint, а не расширение публичного response.
Если всё же меняется shared system/queue contract, agent обязан обновить miniapp parser, preview transport,
contract tests и static consumer deploy.

### Review read model

Не переиспользовать `ModerationEvent`, `ChatModerationFeedItem`, `AuditLog` или VK review queue.
Создать отдельные модели `PhotoDuplicateReviewItem` и `PhotoDuplicateReviewEvidence`.

Минимальные поля item:

- opaque observation/job key с unique constraint; algorithm/policy version сохраняются как данные,
  но смена policy не создаёт вторую row одного логического job;
- chat, current/original message IDs, sender IDs и source timestamps;
- preset, scope, match kind, PDQ distance, image count, rollout mode;
- intended action, actual outcome, incomplete/failure code;
- review verdict: `UNREVIEWED`, `CORRECT_DUPLICATE`, `FALSE_POSITIVE`, `INCONCLUSIVE`;
- reviewed by/at, bounded note, optimistic `updatedAt`, `expiresAt`.

Сохранять 100% positive observations. Operational failures остаются в Redis telemetry, а в review DB
попадает только deterministic bounded diagnostic sample без evidence. Для `new` также разрешён лишь
bounded sample, по умолчанию 0-1%, для false-negative audit. Повтор job делает upsert, а не вторую запись.

Evidence:

- только preview, полученный в уже существующем decode pipeline, без повторного decode;
- максимум 160 px, WebP, максимум 24 KiB на изображение, 160 KiB на сторону альбома и
  320 KiB на review pair;
- originals, EXIF, download URL и bearer/query tokens не сохраняются;
- endpoint same-origin, guarded, `Cache-Control: no-store`, binary bytes не входят в JSON/logs;
- retention default 14 дней, bounded `SKIP LOCKED` cleanup по `(expiresAt, id)`;
- evidence quota и storage forecast обязательны до canary;
- previews считаются персональными moderation data: только opt-in canary allowlist, access audit и
  delete-on-opt-out; вне opt-in thumbnails не создаются.

Нельзя класть previews всех baseline-сообщений в Redis на всё duplicate window. В S1 evidence policy
по умолчанию `off` либо deterministic sample. Полное временное кеширование baseline previews разрешается
только для точного allowlist canary-чатов после memory forecast, с отдельными TTL, global/per-chat byte
quota и метриками. При positive hit пара переносится в bounded Postgres evidence и удаляется по retention.
Shadow matching не зависит от наличия preview.

Baseline cache record содержит только hashed chat/message key, source timestamp/sender и opaque bounded
WebP artifacts. URL/token отсутствуют. TTL, global/per-chat byte quota и evidence memory metrics обязательны;
отсутствующий baseline честно даёт `evidence unavailable`.

Review persistence и guarded controller подключаются через отдельный shared feature module, импортируемый
moderation и admin boundaries; прямой `AdminModule <-> ModerationModule` cycle запрещён. Retention runner
запускается только на одной подходящей runtime role (`roleRunsEnqueue`) и защищён distributed lock.

Review row upsert всегда завершается до consume-immunity/action. Evidence входит в ту же transaction,
когда match policy требует previews. В shadow write failure не меняет moderation; в enforcement отсутствие
review row всегда даёт `audit_unavailable`, а отсутствие evidence блокирует только PDQ/advanced action.
Exact canonical action может иметь явный `evidenceUnavailableReason` после отдельного exact gate. После
вызова void action допустим outcome `DISPATCHED`, но не `COMPLETED`: remote completion разрешён только
при явной связи с delete intent/action ledger. Outcome update является второй идемпотентной фазой и имеет
recovery для зависшего `PLANNED/DISPATCHED`.

List API использует opaque cursor `(createdAt, id)` и bounded limit. Нужны индексы
`(verdict, createdAt, id)`, `(chatId, createdAt, id)`, `(matchKind, createdAt, id)` и `(expiresAt, id)`.
List query никогда не выбирает evidence `bytes`; binary lookup идёт только по evidence primary key.
Verdict mutation передаёт `expectedUpdatedAt`; optimistic `updateMany = 0` возвращает HTTP 409.

### Safety Desk

Добавить отдельный `photo-duplicates` view с фильтрами review status, match kind, rollout и временем.
Карточка/строка показывает пару previews, distance, preset/scope, current/original message IDs,
intended/actual action и кнопки verdict. Никакой moderation action из review UI не выполняется.
Preview загружается authenticated blob request-ом, создаёт object URL и всегда вызывает revoke; прямой
`<img src>` не должен обходить Safety Desk request guard.
Blob request проходит через same-origin Basic Auth и серверный Safety Desk guard; object URL отзывается при replace, unmount
и error. Endpoint возвращает только `image/webp` с `Cache-Control: no-store, private` и не принимает
access token или source URL через query.

### Acceptance S1

- У каждого eligible логического сообщения ровно один terminal outcome, включая `shed`, `abandoned`
  или `final_failure`.
- Multi-bot replay не удваивает observation row и terminal counters.
- Redis/DB/review failure не ломает webhook и не создаёт action.
- В enforcement-mode отсутствие review row всегда приводит к `audit_unavailable`; отсутствие evidence
  блокирует PDQ/advanced action и получает явную reason code.
- В metric labels/bucket fields нет raw chat/user/message IDs, URLs или hashes. Transient lifecycle key
  может содержать только opaque SHA job ID, имеет bounded TTL и удаляется после maturity window.
- Retention удаляет только просроченные review rows и evidence bounded batches.
- Safety Desk не отдаёт binary data/URLs в list response и требует существующую auth boundary.
- `vps-monitor-readonly.sh` показывает `photo-duplicates` даже при нулевых counters.
- Positive structured log заменяет raw `chatId/messageId` на opaque job ID; URLs/tokens не логируются.

Focused tests S1: lifecycle duplicate/retry/window-boundary/Redis failure; positive upsert/replay;
transaction и evidence caps; cursor/filter/no-bytes list; optimistic 409; auth guard и blob revoke;
`SKIP LOCKED` retention; отсутствие raw identifiers/tokens в metrics, logs и API response.

### Validation S1

```bash
npm run check:prisma
npm run typecheck:contracts
npm run test:contracts
npm run check:api
npm run typecheck:admin
npm run test:admin
npm run check:infra
npm run check
git diff --check
```

S1 заканчивается deploy всех выбранных planner-компонентов, smoke и 10-минутным read-only monitor.
После S1 `duplicate_photo_enabled` всё ещё должен быть включён у 0 чатов.

## S2: correctness, resilience и UI truthfulness

### Параллельные потоки

| Поток            | Ownership                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| S2-A Semantics   | moderation enqueue path, photo moderation fences, integration specs                                    |
| S2-B Resilience  | replay-safe counter/immunity, downloader errors, partial cache, deadline, decode/order processor specs |
| S2-C UI contract | settings contract/API matrix, miniapp helper/UI/tests/screenshots                                      |
| Root             | config/module wiring, instrumentation integration, final behavior matrix                               |

### Correctness semantics

Перенести enqueue из ветки `violations.length === 0` в общий eligible
`message_created + photo + antiDuplicateEnabled + duplicatePhotoEnabled` путь до ранних returns.

Job schema получает versioned immutable latch `observationOnly` (`actionEligible=false`), установленный
при competing violation. Его нельзя повысить до actionable после enqueue/retry/replay; новая schema меняет
algorithm/job version. Поздний action fence может только дополнительно понизить eligibility.

При competing violation или занятом action fence:

- анализ и baseline observation разрешены с `commitViolation=false`;
- duplicate counter, delete intent, warning, mute, ban и bot reply запрещены;
- заблокированный fence проверяется после fingerprint/history observation, а не обрывает анализ;
- admin/bot по-прежнему полностью исключены до enqueue;
- participant immunity и manual release не удаляют baseline: они не потребляются в shadow/observation-only
  path и подавляют только action, что отдельно сверяется с текстовым anti-duplicate precedent;
- observation помечается `actionEligible=false` для review и precision breakdown.

Тестовая матрица включает `PHOTO_BLOCKED`, commercial/profanity violation, text duplicate, existing
delete intent, foreign moderation event/claim, admin, immune user, manual release и multi-bot replay.

### Retry и deadline

Ввести typed error taxonomy:

- terminal: host/SSRF/redirect policy rejection, empty/oversized/non-image/unsupported content,
  signature/frame/pixels и definitive 4xx кроме 408/425/429;
- transient: timeout, reset, `EAI_AGAIN`, 408/425/429, 5xx и Redis history unavailable;
- capacity/defer: decode gate, governor или временная очередь переполнены;
- invariant/program error: обычные bounded Bull retries, затем explicit failed outcome.

Terminal error завершает job как `incomplete` без пяти бессмысленных попыток. Transient использует
Bull attempts. Capacity переносит job через `DelayedError` без расхода attempt.

Дополнительно:

- observation-time запреты (`shadow`, initial fence/admin uncertainty, manual release) сохраняются как
  monotonic replay state: сбой ordering completion не может превратить replay в actionable job;
- duplicate counter коммитится отдельным idempotent шагом только после final policy/admin/manual-release
  и late-fence checks; поздний competing action оставляет baseline, но не двигает sanction ladder;
- participant immunity consumption получает deterministic message/job idempotency key: retry после сбоя
  ordering completion не расходует allowance второй раз и не превращает immune outcome в санкцию;
- enqueue на competing moderation path имеет bounded wait и не задерживает основное удаление/санкцию
  при зависшем Redis/BullMQ;
- fingerprint каждого успешно обработанного photo ID кешируется сразу;
- MGET выполняется для позиций с ID, отсутствие ID у одного фото не отключает cache всего альбома;
- абсолютный execution deadline default 30 s, отдельный от 5-minute source-ready wait, проходит как
  `deadlineAtMs` через slot wait, DNS/request/body/decode-start/history;
- `lease.assertOwned()` вызывается непосредственно перед `observeAlbum`;
- ordering defer получает exponential backoff + jitter и не продлевает pending TTL каждым poll;
- download buffer не копируется повторно без необходимости;
- санкционный cluster counter получает timestamp/LRU eviction вместо произвольного `HKEYS` удаления.

### Честный settings UI

Текущий effective mode вычисляется server-side для сохранённых preset/scope. Добавить additive contract
с безопасной matrix `duplicatePhotoModerationModes: { base, advanced }`, где `base` соответствует
`SAME_IMAGE + SAME_AUTHOR`, а `advanced` всем комбинациям с `MINOR_EDITS` или `CHAT`.

Miniapp выбирает mode из draft, а не из старого response value:

- при выключенном фото toggle rollout hint скрыт, статус `Фото выключено`;
- card status не заменяет состояние всего текстового антидубля одним photo badge;
- явно сказано, что window/allowed count общие, а warning/mute/ban применяются к фото только при
  effective `FULL`;
- rules preview строится из draft-effective mode;
- saved response, draft summary и runtime policy покрыты одной table-driven matrix.

### Acceptance S2

- Фото с competing violation наблюдается, но не создаёт второе действие/счётчик.
- `observationOnly=true` переживает retry/replay и никогда не повышается до actionable; поздний fence
  блокирует action, не теряя baseline observation.
- Replay после сбоя ordering completion сохраняет исходный suppression/immunity outcome, не двигает
  counter повторно и не создаёт action; поздний foreign fence не двигает counter вообще.
- Shadow/observation-only path не расходует participant immunity; admin/bot не enqueue-ятся.
- Terminal download failure имеет одну попытку; transient проходит заданное число; capacity не тратит attempt.
- Retry альбома повторно скачивает только неготовые позиции.
- Abortable этапы не превышают общий deadline более чем на 250 ms; Sharp non-abortable участок отдельно
  измеряется и ограничивается decode gate.
- UI до и после save показывает один и тот же effective mode для всех preset/scope/rollout комбинаций.
- `duplicatePhotoEnabled=false` нигде не выглядит как active observe/delete/full.

### Validation S2

```bash
npm test --workspace @maxim/api -- photo-duplicate
npm run check:contracts
npm run check:api
npm run check:miniapp
npm run build:miniapp:production
MINIAPP_SCREENSHOT_SCENARIOS=chat-settings-duplicates-photos \
  MINIAPP_SCREENSHOT_DEVICE=all npm run screenshots:miniapp
npm run typecheck:admin
npm run test:admin
npm run check:infra
npm run check:refactor-guards
npm run check
git diff --check
```

Public API/contracts checks используют repo locks и не запускаются параллельно через `*:unlocked`/`:source`.
S2 также deploy-ится без включения chat flags.

## S3: corpus, benchmark и bounded capacity

### Corpus без AI и production media

Добавить deterministic procedural corpus и manifest с expected outcomes:

- exact bytes, MAX-like re-encode, JPEG quality 95/75/50, resize, EXIF/orientation;
- crop 1/3/5/10%, brightness/saturation/hue, mirror/rotate, text overlay, screenshot-like frame;
- low-information solids/gradients, visually near but distinct и unrelated negatives;
- альбомы 1/2/10, reorder, partial/superset album и duplicate multiplicity;
- malformed, animated, oversized, missing URL, SSRF/redirect-policy и mixed-validity album cases.

Manifest хранит table-driven expected result отдельно для `SAME_IMAGE` и `MINOR_EDITS`; hard negatives
обязаны оставаться non-match в обоих presets, если case явно не маркирован advanced-positive.

CI corpus генерируется локально через Sharp, без сети, AI и пользовательских фото. Отдельный ignored
operator corpus может использовать добровольно размеченные реальные изображения через manifest;
бинарники и production exports в Git не коммитятся.

Benchmark profiles: platform cache hit, fingerprint cache hit, cold 1 image, observed mean album 1.19,
p95 album 2, max album 10, history 50/250/2000. Измерять throughput, p50/p95/p99, event-loop delay,
queue age, heap/RSS/native memory, Redis bytes/job и candidate count.

Нагрузка: 48 jobs/min steady в течение 30 минут и 96 jobs/min burst в течение 10 минут, затем полное
восстановление backlog <= 5 минут. Это 2x и 4x от наблюдаемого production baseline; production webhook
endpoint в benchmark не используется.

S3-A добавляет именованные команды `moderation:validate-photo-duplicate-corpus` и
`test:api:photo-duplicate-benchmark:ci`. Correctness gate выполняется отдельно от timing. Performance
benchmark запускается в свежем процессе минимум три раза, сохраняет reproducible JSON report с SHA,
Node/Sharp/PDQ versions и применяет thresholds к median run. Артефакт не коммитится.

### Admission control

Не вызывать `queue.getJobCounts` на каждом webhook. Использовать atomic Redis admission store:

- reservation по deterministic job ID, чтобы fanout не расходовал квоту повторно;
- global и per-chat outstanding ZSET с expiry cleanup;
- outcomes `admitted`, `duplicate`, `rejected_global`, `rejected_chat`, `rejected_age`;
- release на complete или final abandon;
- worker сверяет dedicated queue age/depth и `BackgroundRuntimeGovernorService` до decode;
- overload всегда fail-open и наблюдаем, никогда не блокирует webhook и не создаёт санкцию;
- admission Redis unavailable не обходит governor: пользовательское сообщение пропускается, но photo job
  не enqueue-ится и получает terminal `shed_admission_unavailable`.

Пороговые значения конфигурируются только после benchmark. Hardcoded thresholds из текущего
traffic sample в production не переносятся.

### Exact platform cache

Не использовать отдельный `platform_id` history counter напрямую: он расколет escalation cluster между
platform/canonical/PDQ paths. Безопасная схема:

1. После полного успешного decode сохранить `platform album hash -> confirmed canonical album fingerprint`.
2. Повтор с теми же photo IDs читает один cache entry.
3. Дальше он проходит через существующий canonical `observeAlbum`, сохраняя единый cluster/counter.
4. До включения cache shortcut выполнять dual-run shadow equality audit.

Cache write после частичного/неуспешного decode запрещён.
Cache hit остаётся provenance metric, а итоговый match kind остаётся `canonical_sha256`; он не становится
доказательством `platform_id`. `platform_id` enforcement запрещён, пока отдельный scoped platform-album
history index не привязан тестами к тому же canonical cluster/counter.
Для этого fast path допустим один ранее закешированный preview и два message IDs: повторный download
только ради Safety Desk не должен уничтожать exact-cache преимущество.

### PDQ index v2

Сначала pure index/oracle tests, потом Redis layout. Требования:

- versioned v2 namespace и dual-read against current linear oracle;
- full `matchPhotoAlbums` после candidate lookup, поэтому index не создаёт false positive;
- для single image: 13 bands гарантируют candidate при distance <= 12, 32 bands при distance <= 31;
- album size входит в key; multi-image сначала остаётся на bounded linear fallback;
- compact opaque candidate records, TTL/time buckets и явная memory model;
- band candidates всегда перепроверяются существующим `matchPhotoAlbums`;
- missing/corrupt/saturated index даёт metric; bounded linear fallback разрешён в shadow, но такой result
  никогда не участвует в enforcement;
- count cap не должен молча обещать полное time window: любое capacity truncation становится метрикой
  и outcome `incomplete_coverage`, запрещающим action/расширение rollout;
- coverage watermark доказывает, что весь configured time window присутствует до разрешения enforcement.

Switch на v2 разрешён только после 0 mismatches с oracle на randomized corpus и shadow traffic.

### Sharp/native resource strategy

Сначала зафиксировать `sharp.concurrency(1)`, bounded/disabled Sharp cache и измерить реальные
pixels/RSS. Pixel ceiling нельзя снижать вслепую без histogram реальных входов.

До real-chat canary создать отдельный `api-photo-duplicate` consumer на том же immutable API image с
CPU/RAM limit; benchmark определяет limits, а не необходимость isolation. Consumer photo queue убирается
из `api-moderation-background`, чтобы один job не обрабатывался двумя ролями. Новый APP_ROLE/service запускает
только photo queue и необходимые dependencies, без webhook/background schedulers.

Это отдельная topology-сессия S3-E: runtime topology, production/local Compose, Prisma pool budget
(ожидаемое изменение общего cap 48 -> 50 проверяется существующим pool test), deploy topology, release
guards, monitor и scoped `AGENTS.md`/runbook updates. Обязательны restart/idempotency/OOM smokes.
Worker threads не считаются полной защитой от native OOM.

### Acceptance S3

- 48 jobs/min steady не создаёт растущий backlog; burst 96 jobs/min возвращается к baseline <= 5 минут.
- p95 queue-to-result < 15 s, p99 < 30 s, final failures < 0.5%, history unavailable < 0.1%.
- Exact cache даёт 0 behavioral mismatches и действительно пропускает повторный download/decode.
- V2 index: 0 false negative/positive против oracle; p95 candidates <= 25 для `SAME_IMAGE`, <= 300
  для `MINOR_EDITS` при 2000 rows; lookup минимум в 3 раза быстрее linear 2000.
- Redis growth имеет документированную bytes/job модель, не растёт после 2x TTL churn и не вызывает eviction.
- До canary документирован forecast `bytes/job * traffic * TTL` отдельно для history, lifecycle metrics,
  review DB и evidence quota; host memory/disk сохраняют операционный headroom.
- Пока consumer общий: `api-moderation-background` RSS <= benchmark baseline + 256 MiB, без монотонного
  роста, restart/OOM = 0; Redis restart/eviction = 0.
- Отдельный consumer: steady RSS < 512 MiB, peak < 700 MiB, его restart не теряет job и не создаёт
  повторное действие; RSS background moderation больше не зависит от photo decode.

## S4: shadow-canary на реальных чатах

Это серия наблюдательных сессий без code changes: S4.0 включает approved settings, а S4.1/S4.2/S4.3/S4.4
снимают checkpoints через 1 h, 24 h, 72 h и 7 d. Агент завершает каждый checkpoint и не держит turn
открытым в ожидании следующего календарного окна.

### Preconditions

- Для initial controlled S4.0 завершены S1, S2, S3-A/B/E. Для final S4 завершены выбранный S3-C и
  обязательный для PDQ S3-D; exact SHA неизменен всё соответствующее окно.
- Global mode `shadow`; enforcement и advanced allowlists пусты.
- Пользователь предоставил exact ID controlled test chat; representative 2-3 chats добавляются только
  в final S4 отдельным frozen manifest.
- Для каждого чата известны владелец, окно наблюдения и канал связи для остановки.
- Review backlog = 0, monitor показывает очередь, disk/Redis headroom согласованы.
- Evidence policy = 100% только для этих exact canary IDs; access audit, opt-out deletion, quota и
  Redis/Postgres headroom проверены.

Включается только `duplicatePhotoEnabled` у согласованных чатов. Агент не отправляет corpus в MAX сам,
если пользователь отдельно не разрешил сообщения и точные targets. Обычный вариант: оператор вручную
отправляет truth-table corpus в controlled chat.

### Truth table

Проверить по отдельности:

- first post, same `photo_id`, re-upload/new ID, recompress и resize;
- crop/color changes только при advanced shadow;
- same author и different author;
- album reorder, partial album, changed multiplicity и 10-photo album;
- out-of-order webhook и multi-bot replay;
- competing text/photo violation, admin, bot, immunity и manual release;
- near-looking negatives и unrelated images.

### Checkpoints

Срезы через 1 h, 24 h, 72 h и 7 d:

```bash
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh ps
./infra/scripts/vps-connect.sh monitor-readonly 300 15
```

Дополнительно только bounded queue/metrics/review queries по canary window. Никаких широких aggregate
по старым moderation tables.

### Gates S4

- denominator: distinct logical eligible messages/idempotency job IDs в закрытом окне, кроме последних
  5 минут; attempts/fanout/retries отдельно и denominator не увеличивают;
- `terminal / eligible >= 99.5%` по matured cohort; нулевой denominator не является pass;
- отдельно показаны `observed / analyzable`, unsupported/incomplete breakdown и `inFlight`;
- final failure < 0.5%, history unavailable < 0.1%;
- p95 end-to-end < 15 s, p99 < 30 s;
- waiting/prioritized oldest < 30 s, due-now delayed = 0, burst backlog исчезает <= 5 минут; штатный
  будущий 5-second ordering delay backlog не считается;
- metrics snapshot `available=true`, `stale=false`, а evidence coverage для enforcement-eligible positives = 100%;
- Redis evictions/restarts = 0, namespace bytes соответствуют forecast;
- текущий `api-moderation-background` RSS <= pre-canary baseline + 256 MiB, без монотонного роста,
  restart/OOM = 0; host memory headroom остаётся в согласованном budget;
- все positive review items размечены; любой false positive для match kind, планируемого к enforcement,
  блокирует повышение;
- controlled truth table и deterministic bounded sample `new` дают recall signal без unexpected outcome.

Любое нарушение gate возвращает chat flags в off и завершает сессию разбором причины. Семь дней
считаются заново после code/config change.

## S5: exact delete-only

До первого удаления нужны два независимых operational controls:

1. Dynamic downgrade-only kill switch, который может немедленно понизить `full -> delete_only -> shadow -> off`
   и проверяется перед action. Его отсутствие/недоступность при enforcement трактуется как `shadow`.
2. Server-side ceilings `allowed match kinds` и `max photo action`, независимые от общей текстовой лестницы.

Это отдельный кодовый подэтап S5-A: controls сначала deploy-ятся при `shadow` и проходят fail-closed
tests/smokes. Только следующая неизменная наблюдательная сессия S5-B меняет allowlist.

S5-A implementation contract:

- env rollout остаётся верхним пределом, dynamic control может только понижать capability;
- shared control хранит mode, exact-ID allowlists, allowed match kinds, max action, version, actor,
  reason, expiry и timestamp;
- отсутствие/ошибка чтения control при потенциальном enforcement даёт effective `shadow`;
- action path перечитывает свежий control/version непосредственно перед side effect;
- closed Safety Desk mutation использует compare-and-set и отдельный durable control audit;
- emergency downgrade применяется первым и не блокируется сбоем audit DB; upgrade, наоборот, запрещён
  без успешной audit row;
- default-empty `PHOTO_DUPLICATE_PERCEPTUAL_ENFORCEMENT_CHAT_IDS` либо эквивалентный allowed-match-kinds
  control отдельно удерживает PDQ в observe-only;
- тест и pre-enforcement drill `match/queued job -> kill switch -> action` обязаны закончиться без действия
  и без recreate containers.

Текущий `SAME_IMAGE` не является exact-only: `matchPhotoAlbums` допускает PDQ distance <= 12, а
production analysis всегда разрешает perceptual lookup. Текущий production path также ещё не выдаёт
`platform_id`. Поэтому `pdq` обязан оставаться observe-only по умолчанию независимо от выбранного preset;
UI label сам по себе не является enforcement guard.

Первый cohort:

- global `delete_only`;
- exact chat ID allowlist, без wildcard;
- `SAME_IMAGE + SAME_AUTHOR`;
- allowed match kinds сначала только `canonical_sha256`; cache provenance допустим, `platform_id` и
  `pdq` запрещены;
- max photo action `DELETE_MESSAGE`;
- один controlled chat на 72 часа.

Exact cohort требует минимум 100 размеченных live/control hits, 0 unexpected actions и 0 false positives;
низкий volume продлевает окно и не считается pass.

Дальше 2-3 low-risk чата ещё на 72 часа, затем 5% -> 25% -> 100% только от согласованной opt-in
когорты, не от всех 8622 чатов.

Каждая ступень является frozen exact-ID manifest с cohort ID/hash, без wildcard и динамического percentage
bucket. Для каждого manifest нужны новое явное разрешение, отдельный unchanged-SHA window и audit session.

Stop немедленный при удалении distinct image, wrong author/scope, admin/bot message, action без review
record, повторном action одного message или любом обходе policy fence. Остальные S4 SLO продолжают действовать.

Point estimate `99.9%` недостаточен. Для автоматического perceptual delete нужен односторонний exact 95%
lower confidence bound precision >= 99.9%. При нуле false positives требуется минимум 2995 размеченных
positive hits; операционный gate округляется до 3000. Меньшая выборка означает continue shadow, не pass.

## S6: PDQ, advanced scope и full ladder

Каждая ось включается отдельным неизменным cohort window:

1. PDQ `SAME_IMAGE + SAME_AUTHOR`, delete-only.
2. `MINOR_EDITS + SAME_AUTHOR`, delete-only.
3. `SAME_IMAGE + CHAT`, delete-only.
4. Только затем комбинация `MINOR_EDITS + CHAT`.
5. `FULL`: сначала delete + warning ceiling, затем mute; ban последним и только после ручного аудита.

Нельзя одновременно менять PDQ threshold, scope, preset, action ceiling и cohort size: иначе false
positive невозможно отнести к одной причине.

## Deploy и rollback

Используйте [действующий регламент](development-reliability-plan.md) и
[deploy/rollback reference](development/production-operations-reference.md#deploy-and-rollback).
Текущие минимумы чистой сборки — 10 GiB для API и 6 GiB для static; проверяйте фактический
запас штатным preflight. Разрешены manifest-aware MAXIM reclaim, расширение диска или
reviewed exact-SHA CI image preload. Host-wide Docker GC и снижение порогов запрещены.

Shared API change обновляет все 14 ролей и обе native-песочницы по штатному порядку;
изменения contracts включают затронутые planner-компоненты. Postgres/Redis не пересоздаются.
Проверяйте точный source/image, manifest и strict smokes. Наблюдение выбирается по текущей
задаче и конкретному rollout-контракту. Deploy сам по себе не меняет feature flags.

Primary rollback canary/enforcement:

1. Dynamic kill switch в `shadow` или `off`.
2. Доказать на queued test job, что свежая policy revision запрещает action.
3. Snapshot и CAS-remove enforcement/advanced IDs.
4. Recreate shared API roles только если менялся static env; иначе оставить текущий image и наблюдать.
5. При code defect выпустить migration-compatible forward-fix image.
6. Проверить policy snapshot, queue, live/ready, DB/Redis, restarts и 900-second monitor.

Не обещать rollback API на release до `3d5a464`: три migration уже применены, и compatibility preflight
может корректно отклонить старый SHA. Кодовый recovery по умолчанию является forward-fix, сохраняющим
все migration files. `rollback-release` допустим только после read-only plan/preflight конкретного target;
Prisma migrations назад не откатываются. Static components можно откатывать отдельно, если их schema/API
contract остаётся совместимым.

До S5-B выполнить rollback drill. Evidence bundle содержит exact SHA и manifest, policy revision,
cohort ID hash, before/after metrics, queued-job result и точную stop reason.

Queued jobs повторно читают policy перед action. После kill switch они могут закончить analysis, но не
должны удалять, предупреждать, мутить или банить.

## Готовый prompt для следующей агентской сессии

Начинать с S2-A, не со всего roadmap сразу:

```text
Работай по docs/photo-duplicate-optimization-plan.md и выполни только unit S2-A.
Сначала перепроверь production baseline read-only и прочитай все scoped AGENTS.md.
Сохрани любые чужие изменения worktree, особенно .env.example, и stage только owned files.
Используй root + до трёх subagents с непересекающимся ownership.
Вынеси photo enqueue из violations.length===0, version job schema и добавь immutable observationOnly latch.
Blocked/foreign action fence должен разрешить baseline observation с commitViolation=false, но запретить
counter и любые actions. Закрепи admin/bot/immunity/manual-release/replay behavior focused tests.
Не реализуй retry/deadline, metrics, review models, UI или capacity work из следующих units.
Не меняй matching thresholds, не включай duplicatePhotoEnabled ни в одном чате и не повышай rollout.
Проведи focused и broad validation, exact-SHA CI, guarded deploy и production smokes по repo rules.
После deploy докажи, что global mode остаётся shadow, allowlists пусты, photo-enabled chats = 0,
а photo queue/history остаются пустыми. Остановись на gate S2-A и дай evidence.
```

## Оценка трудоёмкости

| Сессия | Инженерное время            | Минимальное календарное окно                            |
| ------ | --------------------------- | ------------------------------------------------------- |
| S1     | 5-8 дней                    | 2-4 дня с тремя параллельными потоками                  |
| S2     | 5-8 дней                    | 3-5 дней                                                |
| S3     | 10-16 дней                  | 1-3 недели последовательных units                       |
| S4     | 1-3 дня оператора           | минимум 7 дней на final SHA, окна reset после изменений |
| S5-S6  | 2-6 дней оператора/инженера | 2-8 недель rollout                                      |

Общий ориентир: 23-38 инженерных дней и 6-12 календарных недель. Время наблюдения нельзя безопасно
сократить увеличением числа агентов.
