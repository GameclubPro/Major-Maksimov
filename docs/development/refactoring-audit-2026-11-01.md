# Аудит перед безопасным рефакторингом — 1 ноября 2026

Финальная редакция v2. Сверка и целевые локальные проверки: 01.11.2026 01:07 МСК.

Основание: `6eda89cbce40ba5331a5325a63f9175fb9a4c18c`, полученный из `origin/main`.
Рабочая копия изолирована; исходный `main` не изменялся. Исполняемый код, конфигурация,
схема БД и production в рамках этого аудита не менялись.
Порядок работ и проверяемые микроцели находятся в
[плане](../operations/plans/2026-11-01-safe-refactoring-roadmap.md).

Главный резерв — уменьшение количества связей, которые приходится понимать и проверять
при одном изменении. Одно только сокращение файлов не обеспечивает ни надёжность, ни
ускорение. Самые полезные первые изменения: закрыть пробелы выбора native-проверок,
учесть source guards выпуска, разделить общие тестовые стенды и доказать возможность
удаления старых publishing-веток UI. Производительные SQL/очередные изменения идут отдельно.

## Метод и границы

Выполнены инвентаризация tracked-файлов, синтаксический разбор TypeScript/TSX/MJS,
анализ размеров функций/конструкторов, локальных импортов и изменений последних 150
коммитов; затем прочитаны выбранные реализации, callers, fixtures, scoped instructions,
публичные scripts, CI, Compose и защитные проверки выпуска. Backend, frontend/contracts
и tooling/infra дополнительно проверены тремя независимыми агентами только чтением.

Это глубокий статический аудит с целевыми исполняемыми проверками, а не построчная верификация
всех файлов и не доказательство корректности каждого сценария. Импортный граф не заменяет
Nest DI graph, вызовы, SQL и динамическую загрузку. Число тестовых файлов не является
покрытием, а условно пропущенный тест не является native-доказательством.

На этом SHA найдено 5 108 tracked-файлов:

| Область      | Файлов | Что проверялось подробнее                                                                        |
| ------------ | -----: | ------------------------------------------------------------------------------------------------ |
| API          |  2 748 | Legacy/facades, authority, MAX transport, webhook, publisher, delete intents, DI, native harness |
| Mini app     |  1 230 | Settings, dialog, events, drafts, handoff, shop journal, lazy/CSS, browser selection             |
| Safety Desk  |     59 | Mutation guard, bulk identity, отдельная авторизация и частичные refresh                         |
| Lastik       |     47 | Store/runtime ports, dispatch/settlement, health/store tests                                     |
| Contracts    |    173 | Exports/resolvers, schemas/defaults, совместимость consumers                                     |
| Root scripts |     83 | Context/plan/verify/focused, codegen locks, visual tooling                                       |
| Infra        |    485 | CI/deploy/rollback predicates, topology, stores и release evidence                               |
| Документация |    257 | Рабочие инструкции, продуктовые решения, текущие ссылки и исторические планы                     |

Остальные 26 файлов — корневые/служебные файлы вне этих областей. Количества включают
тесты, assets и конфигурацию. Размеры ниже — физические строки на указанном SHA.

| Узел                                  |  Строк | Значение для плана                                                      |
| ------------------------------------- | -----: | ----------------------------------------------------------------------- |
| `admin.service.legacy.ts`             | 22 709 | Много доменов и общий state owner                                       |
| `admin.service.spec.ts`               | 31 616 | Главный кандидат на разделение тестов по доменам                        |
| `moderation.service.legacy.ts`        | 18 672 | 52 параметра конструктора; очень дорогая граница изменений              |
| `max-client.service.ts`               | 10 216 | Чистые payload helpers соседствуют с authority/admission/transport      |
| `max-client.service.spec.ts`          | 18 897 | Разделять вместе с конкретной областью transport                        |
| `moderation-delete-intent.service.ts` |  9 955 | Lease, причины, dispatch и settlement нельзя дробить произвольно        |
| `private-control.service.legacy.ts`   |  9 517 | Остался чистый rules rendering; callback router намного рискованнее     |
| `admin-managed-broadcast-runtime.ts`  |  6 348 | Полные проходы аудитории требуют отдельного SQL-профиля                 |
| `settings-page.legacy.tsx`            |  6 745 | Большое route-owned состояние и остаточные publishing-ветки             |
| `channel-dialog-page.tsx`             |  5 307 | Helpers/presentation можно отделять раньше async orchestration          |
| `channel-settings-page.tsx`           |  4 155 | Второй отдельный кандидат для удаления старых publishing-веток          |
| `events-page.tsx`                     |  4 129 | Feed hooks уже есть; часть dashboard/mutations остаётся в странице      |
| `capture-miniapp-preview.mjs`         |  6 167 | Один lifecycle owner нужен и после декомпозиции                         |
| `deploy-topology.sh`                  |  2 813 | Source predicates связывают форму кода с допуском к выпуску             |
| Contracts `core.ts`                   |  2 079 | Продолжать совместимое выделение leaf schemas, без массовой перестройки |

Повторить ключевые размеры можно через `wc -l` для соответствующих tracked-путей.
Общий порядок величины не определяет приоритет: маленький опасный transport seam важнее
большого редко меняющегося UI-компонента. В последних 150 коммитах, например,
`moderation-delete-intent.service.ts` затронут 8 раз, MAX client — 6, moderation legacy — 7,
Karavan panel — 11. Это сигнал конфликтности, не частота дефектов.

## E01: Native CI

Сопоставлены API `*.spec.ts`, читающие канонические store-env, явный native script и
дополнительные выборки в [CI](../../.github/workflows/ci.yml).

| Статическая классификация                         | Файлов |
| ------------------------------------------------- | -----: |
| Найдено чтение канонических store-env             |    176 |
| В явном `test:postgres-races`                     |    123 |
| Ещё покрываются native selections других CI-шагов |     44 |
| Подходящая native-выборка не найдена              |      9 |

Один из девяти — намеренно отдельный
[statistics benchmark](../operations/runbooks/statistics-analytics-benchmark.md).
В остальных восьми найдены условные настоящие store-проверки:

| Файл внутри `apps/api`                                                       | Условие native-части, строка           |
| ---------------------------------------------------------------------------- | -------------------------------------- |
| `src/moderation/automatic-mute-cleanup-postgres.spec.ts`                     | PostgreSQL + Redis, 15                 |
| `src/publisher/publisher-auto-reply-backlog-quota.redis-integration.spec.ts` | Local Redis, 11                        |
| `src/publisher/publisher-auto-reply-flood-gate.redis-integration.spec.ts`    | Local Redis, 5                         |
| `src/scripts/antiduplicate-corpus.spec.ts`                                   | Условные Redis cases внутри suite, 217 |
| `src/scripts/diagnose-vk-parsing.spec.ts`                                    | Условный PostgreSQL case, 131          |
| `src/admin/publisher-suggestion-admin.redis-integration.spec.ts`             | Redis, 9                               |
| `src/message-retention/message-retention-legacy-holds-postgres.spec.ts`      | PostgreSQL, 15                         |
| `src/chat-context/chat-context-media-cache.redis-integration.spec.ts`        | Local Redis, 5                         |

Обычный API aggregate в CI, строка 126, не получает нужные store-env. Redis step,
строки 130–133, и compatibility selections, строки 212–232, запускают другие явно
выбранные случаи. Новая photo recompression integration уже входит через
`message-duplicate`; Karavan и reports имеют свои selections. Их нельзя ошибочно
объявлять отсутствующими только потому, что их нет в основном списке 123 файлов.

Вывод о выборе восьми ограничен конфигурацией; теперь он дополнен чтением реальных CI
reports и локальным запуском. Все восемь прошли на изолированных PostgreSQL 16/Redis 7:
140 passed, zero skipped, Jest 27,568 с. Это 140 **всех** cases выбранных файлов, включая
unit-части смешанных suites, а не 140 отдельных native races. Native-части исполнились.
Локальный успех не добавляет их в CI selections. Скан по env также не находит автоматически
все косвенно подключённые stores.

### Проверенные CI receipts

Точный source SHA `6eda89cbc` имеет успешные Required и CodeQL, проверенные публичным
`scripts/ci/assert-green.mjs`. В [run 41241075497](https://github.com/GameclubPro/Major-Maksimov/actions/runs/41241075497)
на нём API, PostgreSQL Races, Contracts и Lastik **skipped** по miniapp scope. Required
завершился 1 ноября в 00:07:08 МСК. Это успех выбранного графа, не полный backend прогон.

Последний проверенный main run с native selections —
[41228618922](https://github.com/GameclubPro/Major-Maksimov/actions/runs/41228618922),
SHA `8464cc86362f3771c7b781ead3813d22ace04cc5`, итоговая попытка 2.
API/contracts/Lastik/CI/agent sources между ним и `6eda89cbc` не изменились. Это полезное
историческое свидетельство для тех же inputs, но не exact-SHA native run нового коммита.

| Фаза                             | Passed                              | Skipped                                         | Источник                                   |
| -------------------------------- | ----------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Восемь native shards             | 123 уникальные suites / 2 749 cases | 0 cases                                         | JSON; множество равно explicit native lane |
| API base                         | 863 suites / 21 723 cases           | 171 suites / 3 990 cases                        | CI log                                     |
| API Redis selection              | 38 suites / 1 413 cases             | 7 suites / 113 cases                            | CI log                                     |
| Compatibility statistics/Karavan | 20 suites / 368 cases               | По этой фазе не заявляется zero-skip сверх лога | CI log                                     |
| Compatibility reports            | 3 suites / 61 cases                 | То же ограничение                               | CI log                                     |

Фазы пересекаются: суммы не являются числом уникальных tests. Redis selection законно
находит и PostgreSQL suites с пропущенными PG cases; требование «zero skips везде» неверно.
`PASS` смешанной suite без нужного env не доказывает её native cases. Compatibility/Redis
имеют логи, но не сохранённые per-case JSON artifacts.

Сохранён отрицательный результат: [первый shard 2/8](https://github.com/GameclubPro/Major-Maksimov/actions/runs/41228618922/job/124617971066)
выдал JSON `success:true`, 460 passed, затем job получил `cancelled` с annotation
`The job has exceeded the maximum execution time of 10m0s`. Первый Required упал.
Повтор на том же SHA прошёл; Jest 526,458 → 289,802 с. Причина разброса не установлена.
В артефактах сохранились одинаковые имена разных попыток. Доказательство требует цепочки
SHA → run → attempt → job → phase → report и конечного job/Required status.

Следовательно, расширение native lane требует оценки полного job budget с setup/upload/
cleanup reserve, а не увеличения timeout или молчаливого исключения старых cases.

## E02: Deployment guards

[deploy-topology.sh](../../infra/scripts/lib/deploy-topology.sh) содержит 59 shell-функций
и 567 текстовых вызовов JS `.includes(`. Значительная часть проверяет исходники
выбранного Git SHA. Например, `maxim_topology_require_multibot_authority` со строки 259
читает 12 source-файлов и проверяет effect/reader anchors и порядок операций.

Следствие: перенос правильного метода в новый файл способен сделать target непригодным
для выпуска или rollback. До runtime extraction нужно найти связанные predicates и
negative fixtures. Безопасный перенос checker сохраняет target-SHA reads, отказ на
неподдерживаемом reader, порядок guards и действующие source floors. Объявленный самим
приложением номер версии не заменяет доказательство этих свойств.

Существующие [rollback tests](../../infra/scripts/bot-publisher-reliability-rollback.test.mjs),
[release manifest tests](../../infra/scripts/release-manifest.test.mjs) и domain guard tests
нужно расширять точечно. Shared locks, disk floors, API reader compatibility и все 14
ролей общего image остаются частью проверки. Уменьшение shell-файла само по себе не
доказывает совместимость выпуска.

## E03: Backend boundaries

`admin.service.ts → admin.service.impl.ts → admin.service.legacy.ts` сохраняет публичный
фасад, но основное владение реализацией остаётся в legacy. Аналогично moderation.
Нужно переносить законченный домен со state/authority ownership, а не добавлять новые
прослойки над тем же огромным объектом.

- [Admin module](../../apps/api/src/admin/admin.module.ts), строка 300, связывает legacy
  ports с тем же экземпляром `AdminService`.
  [Provider test](../../apps/api/src/admin/admin-legacy-port.providers.spec.ts), строка 63,
  защищает singleton identity и отсутствие отдельного broadcast runtime. Создание второго
  экземпляра при extraction может разделить caches/fences/lifecycle.
- [Admin test support](../../apps/api/src/admin/admin-service-test-support.ts), строка 112,
  использует `Object.create(AdminService.prototype) as any`. Это обход конструктора/DI;
  его зелёные tests не доказывают правильность provider wiring.
- [Native fullpath support](../../apps/api/src/webhook/webhook-multibot-fullpath.spec-support.ts),
  строки 616–624, вручную соединяет constructors и передаёт `{ } as never` для части
  guards: PhotoDuplicateRuntimePolicyService, CommercialOcrDeleteGuardService и
  ProfanityDeleteGuardService. Другие guards, в том числе duplicate, stopwords, limits,
  closed-chat, state и subscription, действительно строятся. Настоящие stores полезны,
  но не превращают harness в полный production graph для трёх отсутствующих feature paths.
- [Runtime graph test](../../apps/api/src/runtime/runtime-role-graph.spec.ts), строка 32,
  компилирует реальные providers всех service profiles с заменёнными транспортами.
  Он не запускает lifecycle/workers. Эти два вида проверки дополняют друг друга.

Хороший первый доменный кандидат —
[AdminDomainAllowlistRuntime](../../apps/api/src/admin/admin-domain-allowlist-runtime.ts):
522 строки, уже явный context Prisma/cache/`assertChatAdmin`, транзакция, Chat lock,
audit и последующее cache invalidation. Текущий путь всё ещё идёт через
`ManualModerationService → AdminService → runtime`. Кроме controller, private bot
вызывает `AdminService` прямо в legacy-строках 3096, 3104, 3122, 4227, 4250, 5767.
Их обязательно включить в census callers.

[ManualModerationService](../../apps/api/src/admin/manual-moderation.service.ts),
строки 558–667, получает часть сигнатур через `Parameters<AdminService[...]>` и `ReturnType`.
Небольшой доменный port позволит отделить контракт от legacy-класса. Вводить его следует
для конкретного переносимого домена, сохраняя authority semantics и единственного владельца.

## E04: Private control and MAX

Private settings renderer/session normalizer, closed-chat service и несколько moderation
seams уже выделены. Повторять соответствующие пункты ранних планов не требуется.

Следующие меньшие кандидаты подтверждены реализацией:

| Участок                                                             | Почему подходит                                       | Проверка и ограничение                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Private legacy 5943–6212: rules text/items/sanctions/plural helpers | Синхронный вход `ChatSettingsScreenResponse`, без I/O | Private service cases на строках 2328/2521/2972; сохранить текст, порядок и markup limit, Nest adapter отдельно       |
| MAX client 6957–7350: reply/markup/text/attachments                 | Чистое построение payload внутри большого transport   | Existing MAX spec 650–1183 и 2802+; malformed/null/forwarded/unknown attachment corpus; final guard и HTTP не двигать |
| Webhook service 3575–3859: membership projections                   | Можно изолировать parsing/IDs/projection values       | Existing webhook spec 2054/2296/3218/3617; preserve dedupe cross-bot и commit-before-cache                            |

Последний кандидат не полностью независим от времени: `resolveUpdateEventAt`, строка
3829, читает часы при отсутствующей дате. Объединение нескольких вызовов в один timestamp
изменяет семантику; перенос должен сохранить прежние точки чтения либо получить отдельное
обоснование изменения. SQL projection и публикацию cache epoch нельзя разорвать.

Не включать в первую волну `processCallback` примерно на 1 912 строк,
`ModerationService.handleUpdate` примерно на 1 572 строки и delete-intent lifecycle.
Размер не делает доступной безопасную границу. Preparation deferral, failed handler,
completion persistence failure, timeout/quarantine и unknown external effect различаются.

## E05: Frontend state

Текстовый подсчёт вызовов на указанном SHA:

| Страница         | `useState` | `useEffect` | CSS imports |
| ---------------- | ---------: | ----------: | ----------: |
| Settings legacy  |         65 |          16 |          21 |
| Channel settings |         46 |          14 |          19 |
| Channel dialog   |         23 |          13 |           4 |
| Events           |         24 |          16 |           6 |
| Publications     |          4 |           5 |           4 |

Это не profiler и не оценка количества React renders. Publications уже использует
controller hooks: его длина не основание начинать очередную переделку первым.

### Старые publishing-ветки

[App](../../apps/miniapp/src/app.tsx), строки 104–106 и 617–632, оборачивает Major settings
в `MajorSettingsRoute`. [Retired route predicate](../../apps/miniapp/src/lib/retired-publishing-route.ts)
перехватывает старые publishing query до монтирования settings. При этом chat settings
сохраняет mailing state, mutations, restore/persist effects и composer handlers
на строках 447–510, 842–930, 1230–1331, 2402–2800, history queries 3730–3749 и rendering
от 5921. Аналогичные ветки есть в channel settings.

Это кандидат на удаление после доказательства недостижимости, а не доказанный dead code.
Нужны все route/dynamic/fixture callers и реальный App browser case: handoff работает,
защищённые settings/publishing requests отсутствуют, обычные rules/giveaway/polls/shop
сохраняются. Единственные найденные runtime mounts — App:622/630; preload загружает
module, а не монтирует компонент. Fixtures обходят App guard. Разрешённый preload может
загрузить CSS, поэтому отсутствие любого settings chunk/CSS — слишком сильное требование.
Общие composer/button/rules helpers нельзя удалять по имени `Broadcast`.

Уточнение второго прохода: `handoff=1` не означает retired route. Например,
`focus=giveaway&handoff=1` прямо сохранён existing test. Флаг влияет на prefetch, retry
и header; chat settings:3739–3743 вручную refetch-ит broadcast handoff при error retry
даже такого обычного маршрута. Этот путь достижим и не входит автоматически в dead-code
removal. Его возможное исправление требует отдельного reproduction/expected result.

Preview transport обрабатывает `ApiTransport.request` in-process; наблюдатель HTTP
requests без instrumented transport может ложно подтвердить «запросов нет». U02 требует
реального App с HTTP session mocks либо явного счётчика transport, включая ошибки/retry.
Existing direct-page/hook fixtures такой routing proof не заменяют.

### Владение состоянием

- [use-settings-draft](../../apps/miniapp/src/pages/settings/use-settings-draft.ts), строки
  90–149, уже защищает principal/entity scope и устаревшие async results. Required
  subscription, rules и save coordinator тоже уже выделены. Новый общий save hook не нужен.
- [Channel dialog](../../apps/miniapp/src/pages/channel-dialog-page.tsx): pure helpers
  147–667, presentation 668–1218, main component от 1237. Их можно переносить отдельно.
  Query/terminal cancellation, optimistic rollback, attachment preparation и scroll/focus
  имеют разные lifecycle. Existing async-attachments browser case проверяет смену
  пользователя во время подготовки и должен сопровождать extraction.
- Events уже использует feed hooks. Следующие возможные границы — dashboard read state,
  participant mutation authority и review workspace, по одному за срез.
- Karavan command journal/runtime уже сохраняет исходную команду при unknown outcome.
  Универсальный mutation/localStorage hook может разрушить это свойство.
- Safety Desk уже имеет маленький shell, отдельные views и mutation guard. Overlap bulk/single,
  partial refresh, server-authoritative retry и exact visible IDs важнее нового общего UI framework.

### Что действительно запускается

В miniapp найдено 242 `*.test.ts`, из них 67 читают исходный код, и 89 `*.browser.mjs`.
Обычный npm test запускает первую группу; CI дополнительно запускает выбранные browser
сценарии в двух shards, строки 271–361. Это не отсутствие browser CI и не запуск всех 89.
Comments async, ряд shop/marketplace и overview navigation scripts не найдены в явном
списке. Часть поведения может затрагиваться visual smoke; нужна карта сценариев, а не
вывод «маршрут полностью не проверяется». Source assertions полезны для архитектурных
запретов, но не доказывают отправку запроса, отмену или отсутствие внешнего эффекта.

## E06: Contracts and database

В contracts 45 публичных exports. Уже есть guard согласования package exports, root TS
paths и API Jest mappings; он также запрещает generated JS рядом с source. Dev Vite
source aliases применяются только в serve, production продолжает использовать package
exports. Создание ещё одного registry для этих же mappings не обосновано.

Leaf apply-target block в `core.ts`, строки 928–1013, можно выделять с сохранением прежних
root/settings exports и экземпляров schemas. Default `current`, coercion, dedupe, invalid
inputs и форма validation issues — поведение. Большой `chatSettings` содержит refine/transform;
его разрезание по полям намного рискованнее. Type-only root imports сами не раздувают runtime bundle.
Mapping guard проверяет пути/outputs, но не runtime-equivalence перенесённой schema через
built package exports. Для выбранного leaf нужен также built import/parser/identity check.

Miniapp tsconfig включает только `src`, contracts — `src/**/*.ts`. Их зелёный typecheck
не означает типовую проверку tests/fixtures: tsx/Vitest их транспилируют. В выбранном
browser harness нужны typed/schema-parsed builders и отдельная узкая fixture typecheck,
если именно на ней строится доказательство контракта. Массовая миграция fixtures не нужна.

`tsconfig.base.json` включает `strict`; ESLint при этом разрешает explicit `any`.
Важнее типизировать реальные затрагиваемые doubles/ports, чем включить запрет сразу для
всего дерева. HTTP input baseline содержит 36 исключений старых signatures, runtime-context
baseline — ноль. Это существующий контролируемый долг, не доказательство 36 уязвимостей.
Каждый HTTP adapter нужно переводить на `unknown + schema` с сохранением valid/default/error
контракта и отрицательных сценариев, не скрывая изменение требований под типизацией.

Prisma schema: 5 183 строки, 203 модели, 60 enum, 399 объявлений `@@index`, 80 `@@unique`,
379 файлов `migration.sql`. Это структурный масштаб, не анализ применимости индексов.
Prisma в lockfile уже **7.9.0**, TypeScript **5.9.3**. Пункт старого плана «Prisma 7 после
декомпозиции» устарел. Без настоящего workload/plan нельзя рекомендовать удаление индекса,
разделение таблицы или новый connection pool. Существующий
[connection admission adapter](../../apps/api/src/prisma/connection-admission-pool.ts) нельзя
заменять обычным пулом ради уменьшения связности.

В `config/prisma-drift-baseline.json` закреплены 37 diff operations: 6 Prisma-unrepresentable,
30 schema-alignment debt и 1 missing-migration debt. Зелёная drift check означает соответствие
reviewed baseline, не отсутствие долга. Последний пункт — ещё не выполненная вторая фаза
удаления `chat_settings.delete_spammers_require_approval`. Нельзя применять весь предложенный
Prisma diff, убирать INCLUDE indexes/defaults или делать DROP ради нулевого drift.
Сначала нужны writers/defaults/triggers/reader map выбранного домена и совместимый release.

## E07: Agent workflow and tooling

Уже реализованы context navigation, impact planner, JSON verify/focused, staged snapshot,
fail-closed неизвестные пути, typed runtime contexts, generator locks и одноразовые stores.
Дедупликация core/infra проверок уже тестируется. Native CI уже имеет восемь shards и
compatibility group; точный SHA, Required и CodeQL остаются обязательными для runtime.
Новый orchestration framework и повторно используемый «зелёный cache» не нужны.

Подтверждённые локальные улучшения:

1. `focused.mjs`, строки 53–80, поддерживает определённые test families и разбирает native
   membership из длинной npm shell-строки. Классификация native сейчас — объединение
   этого membership и AST-чтений canonical store-env в выбранном файле; inventory-only
   замена сломает mixed suites вне списка 123. Транзитивные helper-only зависимости требуют
   явных metadata, AST source scan не обещает их полноту. Lastik tests/stores, API `test/*.node.ts` и
   browser scripts пока явно не поддерживаются. Это безопасное ограничение; добавлять
   adapters по одному, через публичные wrappers и с проверкой forwarded arguments/env.
2. Карта «фича → entrypoint → state owner → callers → focused/native/browser evidence»
   уменьшит объём ручного поиска. Размещать её рядом с existing scoped references;
   context navigation остаётся навигацией и не обещает полноту.
3. В `capture-miniapp-preview.mjs`, строки 3489–3510, остался отдельный newline Git parser;
   `scripts/agent/git-changes.mjs` уже предоставляет каноническую NUL-обработку rename.
   Переключать после сравнения наборов scenarios, включая unusual paths/overrides.
4. Из capture можно переносить pure geometry и behaviors одного домена. Metadata/config/server
   уже выделены. Browser/context/server lifecycle, clock, failures и report остаются у одного owner.

Исторические планы содержат и выполненные задачи, и временные результаты incident windows.
Нужен один актуальный указатель на программу, сохраняя отдельные authoritative продуктовые
решения и incident history. Ни новый документ, ни его более поздняя дата не отменяют fences,
активные acceptance gates или границы ранее выданного разрешения.

## E08: Operations and secondary runtimes

Lastik значительно меньше backend legacy: `store.ts` — 1 752 строки, runtime — 559,
HTTP — 415. Небольшие кандидаты: pure diagnostics projection от store:394, общий operation
hash вместо дублей :578/:605 и узкий runtime port вместо полного concrete Store.
Проверять побайтовую совместимость hash и typed doubles.

`assertAndMarkDispatch` от :1426 и `settle` от :1508 должны сохранить цельные транзакции,
advisory/policy locks, lease/attempt identity, freshness и uncertainty. Общая с Major
queue/store abstraction не оправдана. Native Sharp/Tesseract auxiliaries сохраняют
no-network/no-secret, kill/reap и исходные deadline budgets. Рефакторинг их lifecycle
не является безопасной косметикой.

Topology уже сверяется между TypeScript, Compose и Bash. Возможная генерация общего
inventory должна начинаться с equivalence check; менять вместе roles, secrets, concurrency
или право на external effect нельзя. Production SQL остаётся только reviewed bounded
collectors, последовательно; аудит не даёт разрешения на живые SQL experiments.

## E09: Measurement and scope

Publisher — потенциально большой runtime-резерв, но пока без нового численного обещания.
Текущий broadcast runtime сохраняет полные initial/repair/finalizer проходы, а recipient
admission фильтрует массив до bounded slice. Малый SEND quantum не доказывает малое чтение.
Исторические synthetic результаты 50k требуют воспроизведения на выбранном SHA.

Порядок: текущий профиль → узкий single-snapshot select → только затем отдельное решение
о двухфазном чтении/continuation. `updatedAt` не сертификат полной неизменности;
гидратация `IN` не задаёт порядок и не выдаёт authority. Настоящие 10k/50k cases должны
сравнить результаты, SQL rows/loops/buffers, heap/RSS/event loop и races stop/revoke/edit/cancel.
Не переносить исторические production-проценты и не увеличивать quotas ради результата.

Для оценки пользы агентам достаточно нескольких одинаковых типовых задач до/после:
время до первого focused результата, число ручных исправлений команды, необходимые
контекстные файлы/байты, количество затронутых доменов, случайные store skips и длительность
проверок. Время и частота отказов фиксируются наблюдением, без выдуманных процентов экономии.

## E10: Authority and persisted protocols

Второй проход отдельно проверил цепочку подпись/session → profile/lifecycle → actor/entity
authority → versioned operation/receipt → final effect/rollback reader. Её нельзя свести к
единому generic auth/retry helper.

| Граница                                              | Подтверждённое свойство                                                                                                                              | Что не доказывает соседняя зелёная проверка                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| InitDataGuard:48–90                                  | Invalid signature не восстанавливается cookie; expired recovery требует того же userId и launchBotId; origin/CSRF относятся и к mutation tunnel      | Auth suite с in-memory Redis не является настоящим Redis session proof                                |
| MiniappProfileGuard:49                               | Principal учитывает актуальный bot lifecycle/profile; test-only guard omission не разрешён в runtime                                                 | Валидная подпись сама не выдаёт actor/entity права                                                    |
| NetworkSettingsService:171; AdminSettingsService:706 | Перед read skip flags выполнена entity authority; skipAdminCheck всё ещё сохраняет managed read access                                               | Нельзя объявить все skip flags полным обходом авторизации                                             |
| Network settings reader v3, lease, receipt           | Unknown reader остаётся unsettled; settings и receipt co-commit; потерянный lease не пишет; exact remote operation reconciled до revision comparison | Native network tests подменяют MAX access checks; это SQL/protocol proof, не end-to-end authorization |
| Karavan authority/proxy                              | Witness связывает principal/command/payload; response loss и malformed/408/5xx сохраняют unknown и исходный command ID                               | Major native cases не доказывают совместимость с текущей live provider version                        |
| Statistics exchange v3                               | Partial page не отзывает отсутствующих; known denial блокирует late proof; fallback только при явно unsupported capability                           | Malformed/auth error нельзя превратить в старый protocol fallback                                     |

Existing native network cases защищают receipt rollback, lease loss, old-writer trigger и
same-timestamp normalization. Floors находятся также в `assert-managed-network-foundation-source.mjs`
и `assert-network-settings-v2-source.mjs`: второй намеренно проверяет v3. Их нужно искать
помимо большого shell-файла. Domain port не должен скрыть DB triggers и receipt order.

### Воспроизведение malformed signed user

В `init-data.service.ts:69–78` JSON приводится к Record без runtime object check, затем
identifier превращается в String. Локальный вызов настоящего service с синтетическим
корректным HMAC показал:

| Signed `user`                                        | Наблюдение                             |
| ---------------------------------------------------- | -------------------------------------- |
| `null`                                               | Необработанный TypeError при чтении id |
| `{ "id": {} }`                                       | userId становится `[object Object]`    |
| `{ "id": ["42"] }`                                   | userId становится `42`                 |
| Строковый/числовой id `42`, совместимый user_id `42` | Сохраняется ожидаемый principal `42`   |

Подпись проверяется **до** decode; это не демонстрация unsigned bypass и не production
инцидент. Подтверждено отсутствие shape boundary и неправильная классификация null.
Перед отдельным исправлением S02 нужно закрепить допустимые ID/object формы и machine
error, сохранив подтверждённые valid cases, rotation, freshness и recovery. Произвольный
запрет всех строковых IDs сломал бы existing compatibility.

## E11: Coverage and remaining decisions

| Область                         | Глубина текущей проверки                                              | Остаточный gate для реализации                                                        |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Auth/session/profile            | Код, callers, focused unit/lifecycle и malformed reproduction         | Typed payload requirement; native session evidence при изменении Redis semantics      |
| Allowlist/network settings      | Код, SQL/trigger/readers, focused native                              | Настоящая permission boundary отдельно от mocked MAX access                           |
| Private rules/DI                | Existing focused corpus и graph/provider compilation                  | Before/after переноса; lifecycle/эффекты graph test не запускает                      |
| Karavan/statistics              | Код и выбранные native consumer cases                                 | Версии consumer/provider pair при protocol change; live provider не проверялся        |
| Settings/dialog/launch          | Callers, selected pure/source tests, browser harnesses                | Новый real-App retirement matrix, включая mixed handoff/error retry                   |
| Contracts                       | Exports/resolver/source/default анализ, public build в API checks     | Built-leaf identity и выбранные fixture types при C02                                 |
| Moderation/duplicates/OCR/photo | Архитектура, selected guards/harness, CI/native selection evidence    | Domain regression matrix и native sandbox proof для затронутого пути                  |
| Publisher/VK/giveaways/polls    | Entry/domain references, callers, размеры и существующие проверки     | Свои focused/race cases перед конкретным переносом; новый throughput baseline не снят |
| Lastik/Safety Desk              | Структура, атомарные границы, existing test contracts и CI selections | Своё focused/native выполнение до их изменения; этот аудит его не заявляет            |
| Infra/releases/stores/edge      | Скрипты, floors, manifests, CI identity и docs                        | VPS identity/strict smokes/reader gates при будущем release; live host не проверялся  |

Launch query principal, late bridge data, очистка старого QueryClient, non-replayable body,
CSRF/session recovery и shop unknown outcome сохраняют разные права на повтор. Для UI
важны topmost focus/native Back, warm CSS, timezone и content-only schedule preservation.
Общий TimeField намеренно поддерживает legacy half-hour и Publisher exact-minute режимы,
включая Asia/Kathmandu. Общие broadcast helpers нельзя удалять по имени.

Нет основания считать исследованными каждую из 203 моделей, каждый внешний API scenario
или производственную нагрузку. Решение, для которого нужная evidence отсутствует,
остаётся explicit gate выбранной микроцели. Это ограничение доказательства, не повод
раздувать ранний runtime этап или обещать полный security/performance audit.

## Выполненные проверки этого аудита

- Node 24.16.0; изолированный `npm ci --no-audit --no-fund` завершился успешно.
- `node scripts/agent/preflight.mjs` прошёл: exports, OCR identity, deploy impact, HTTP inputs.
- `npm run check:refactor-guards` прошёл.
- `npm audit --omit=dev --json` на дату аудита сообщил ноль известных advisories в выбранном
  production dependency scope. Это ответ advisory registry, не полный security audit.

В финализации дополнительно проверено:

| Локальный запуск на checkout b12556ea0, runtime source совпадает с 6eda89cbc | Результат                                                                       | Ограничение                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Восемь CI-gap candidates, PostgreSQL/Redis, public store wrapper             | 8 suites / 140 passed / 0 skipped; Jest 27,568 с                                | Первый запуск сообщил forced worker exit                                                            |
| Только из-за этого warning — public open-handles diagnostic того же набора   | 140 passed / 0 skipped; Jest 39,842 с; штатный exit                             | Warning не повторился в runInBand; причина worker warning не установлена, исправление не заявляется |
| Auth/private rules/DI/network/Karavan/statistics выбранные границы           | 11 suites / 296 passed / 0 skipped; Jest 26,337 с                               | SQL tests и DI graphs имеют описанные выше doubles/lifecycle limits                                 |
| 14 miniapp focused files: auth/transport/routes/drafts/journal/time/schedule | 124 passed / 0 skipped                                                          | Часть tests — source assertions; tests не typechecked production tsconfig                           |
| Settings draft browser entrypoint                                            | Успешно; включает hook harness и импортирует real settings/stop-words scenarios | Direct-page cases не подтверждают App retirement guard                                              |
| Async dialog attachments browser entrypoint                                  | Успешно в Chromium                                                              | Fixture transport и browser shim не являются настоящим MAX WebView                                  |

Суммарно это 436 различных API cases и 124 miniapp cases в указанных выбранных файлах;
повторные 140 диагностического запуска второй раз не суммируются. PostgreSQL/Redis
после всех запусков штатно остановлены и временные stores удалены по результатам wrappers.
Chromium launch прошёл; WebKit и вся mobile/browser matrix не запускались.

План дополнительно прошёл независимое чтение backend, frontend/contracts и tooling/infra.
Проверены 70 уникальных ID (66 рабочих и 4 отложенных), ссылки на prerequisites и отсутствие
циклов даже с условными рёбрами; 27 локальных ссылок/anchors разрешаются. Все четыре
focused-рецепта поддерживаются CLI по dry-run: это проверка выбора команд, не новый test run.
Повторный fetch перед финализацией сохранил `origin/main` на изученном `6eda89cbc`.

Полный runtime suite, новый общий benchmark, live MAX/провайдеры, VPS, deploy и production
acceptance не выполнялись. Для будущего изменения нужны его собственные before/after,
exact-SHA CI и delivery gates. Финальная проверка документации принадлежит commit helper;
нынешняя выборочная evidence не является reusable QA attestation.
