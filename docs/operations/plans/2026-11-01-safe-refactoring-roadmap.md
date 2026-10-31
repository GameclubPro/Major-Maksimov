# MAXIM: безопасный рефакторинг и удобство работы агентов

Дата: 1 ноября 2026. Актуальный проверенный source: `3096266b1f81ab50b82da759293fbcc5483f2ead`.
Статус: **финальная редакция v3 после разбора каждой микроцели; runtime-рефакторинг не начат**.
Перепроверка плана: 01.11.2026 01:48 МСК. Основание и ограничения —
[технический аудит](../../development/refactoring-audit-2026-11-01.md) и
[оценка всех 70 целей](../../development/refactoring-plan-review-2026-11-01.md).
Исполняемые результаты v2 относятся к `6eda89cbc`; дельта `3096266b1` изучена по Git objects
и exact-SHA CI. Нового локального прогона этой дельты данный review не заявляет.
Этот документ задаёт порядок общей программы, сохраняя действующие продуктовые требования,
incident gates и границы разрешений. Он не разрешает destructive recovery или публикации.

Максимальный ожидаемый выигрыш при ограниченном риске дают: достоверные focused/native
проверки; меньшие тестовые стенды; удаление доказанно недостижимых UI-веток; чистые
функции вместо части legacy; независимое владение одним доменом. Изменения SQL selection,
очередей и выполнения внешних действий требуют отдельного измерения и идут позже.
Численных обещаний ускорения без baseline здесь нет. Каталог содержит 66 кандидатов на рабочие микроцели
и четыре отдельно отложенные границы Z01–Z04. Это не обязательство выполнить все строки:
каждый следующий срез выбирается по доказанной пользе и текущей задаче.

## Приоритеты и исполнение

| Очередь  | Результат                                                                       | Почему раньше                                                                         |
| -------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| P0       | Доказуемые проверки и карта ограничений выпуска                                 | Иначе extraction может пройти mocks, пропустить native cases или заблокировать deploy |
| P1       | Меньше общего тестового контекста, чистые helpers, удалённый UI-код после proof | Большой выигрыш навигации с небольшим изменением поведения                            |
| P2       | Один независимый домен за раз; ясные UI controllers/ports                       | Уменьшение реальной связности, а не числа строк                                       |
| P3       | Измеренная стоимость SQL/выпуска/secondary tooling                              | Большой возможный выигрыш, но выше цена доказательства                                |
| Отложено | Перестройка execution/recovery/state machines                                   | Не начинать без отдельного correctness proof                                          |

Одна микроцель — один проверяемый результат. Исследовательский шаг может закончиться
без изменения кода. В один PR допустимы лишь непосредственно связанные шаги одной
границы; нельзя объединять structural move, исправление продукта, SQL optimization и
смену retry policy. Одновременно активен один implementation/release этап;
независимый read-only review разрешён.

```mermaid
flowchart TD
  A[Актуальный SHA, scope и evidence] --> B[Свои native и release guards]
  A --> C[Proof старых UI routes]
  A --> M[Локальный publisher baseline P01]
  B --> D[Чистый helper либо один backend domain]
  C --> E[Retirement либо сохранение ветки]
  A --> H[Одна независимая settings section]
  A --> I[Собственный dialog baseline]
  I --> J[Dialog helpers и controllers]
  B --> F[Узкая SQL projection]
  M --> F
  D --> G[Оценка пользы и выбор следующего этапа]
  H --> G
  J --> G
  F --> G
```

Стрелки обозначают зависимости, а не параллельные runtime workstreams. После первых
P1 результатов нужно пересчитать приоритеты по реальным затратам; не выполнять весь
список автоматически ради завершения программы.

В таблицах запятая означает все перечисленные prerequisites, «либо» — альтернативу,
а текст после точки с запятой — условие для выбранного scope. Общие стрелки диаграммы
не вводят дополнительных зависимостей: P01 и dialog не ждут декомпозиции Admin/settings.

## Размер этапа и цена проверки

Строки — шаблоны срезов. «Один consumer/describe/profile/cluster» означает ровно один
выбранный owner и проверяемый результат; B04 повторяется отдельно для следующего caller.
Если diff требует двух новых state owners, смены persistence mode либо нового protocol,
он перестал быть microgoal и возвращается на разделение. Preparation/review и измерение
могут входить в тот же PR законченного среза; отдельные runtime deploy ради ceiling/CSS
cleanup не обязательны. Обязательные CI/release gates сохраняются для каждого runtime SHA.

До production edit назвать будущую regression matrix и получить baseline. Existing tests
переиспользуются по scope; одинаковый общий helper для нового implementation и expected
result не считается независимой проверкой. При отсутствии нужной evidence срез остаётся
не готов к реализации, даже когда сама формулировка плана завершена.

## Общий критерий безопасности

Для каждой микроцели перед редактированием:

1. Зафиксировать checkout/SHA/ownership и проверить живой diff; вызвать `context.mjs`
   с implementation, callers и doubles. Состояние длительной работы хранить приватно.
2. По [behavior evidence](../../development/behavior-evidence.md) записать ожидаемое
   поведение и источник. Unresolved behavior исследовать; не закреплять дефект snapshot-тестом.
3. Сохранить HTTP/errors/defaults, callback/queue payloads, persisted readers и keys,
   bot assignments, exact authority и порядок SQL/cache/external effects. Отдельно
   проверить clocks, TTL, дедлайны, null/unknown и principal/entity scope.
4. Запустить необходимые focused cases до/после; при storage/lock/race invariant —
   настоящие PostgreSQL/Redis. Проверить executed/skipped cases, а не один exit code.
5. Для переносимого backend-кода найти source predicates выпуска и rollback fixtures.
   Для DI проверить singleton identity и runtime graph; для UI — действия/запросы,
   lazy assets, cold/warm переходы и budgets, когда они затронуты.
6. Выполнить planner scope, owned formatting и `git diff --check`. Финальный aggregate
   выполняет commit helper один раз. Публичные wrappers сохраняют codegen locks.
7. Runtime: exact-SHA Required + CodeQL, штатный scoped deploy, manifest/identity/strict
   smoke, затем применимые acceptance gates. Для общего API image обновляются все
   роли/auxiliaries по действующей topology, stores не пересоздаются.

Документация/тесты/tooling не требуют runtime deploy. Планировочный dry-run не является
проверкой. Не копировать старый CI success на новый SHA и не повторять зелёный aggregate
для заполнения статуса. Точный набор проверок выбирается по реальному diff.

Отмена структурного изменения — обратимый code revert **после** проверки допустимости
reader/rollback target; он не означает откат БД, replay effects или снятие fences.
DDL требует отдельного expand/compatibility решения. После unknown SEND/DELETE rollback
не разрешает повторить действие. При изменении порядка guards, потере identity, новых
необъяснённых skips, несовместимых readers или изменении публичного результата этап
останавливается для разбора, а не «чинится» ослаблением теста/guard/budget.

## P0 — подготовить проверяемые границы

Микроцели описывают следующие изменения. Evidence финализации уже собрана в аудите,
но selectors/decoder/runtime ещё не менялись. Ссылки E01–E11 ведут к разделам аудита.

| ID  | Зависимость                                             | Микроцель и конкретный результат                                                                                                                           | Проверка завершения                                                                                                                                                  |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | —                                                       | Зафиксировать SHA кода, SHA checkout, owned diff и маленькую карту только выбранной границы: требование, owner, callers, doubles, evidence                 | При новом source проверена дельта и актуальность прежних receipts; карта не дублирует context/planner и не требует полного повторного аудита                         |
| A02 | A01                                                     | Для выбранного native-домена сопоставить tests → store-env → текущий CI owner/missing selection; восемь известных gaps использовать как исходные кандидаты | Отделены missing, opt-in и уже покрытые selections; actual executed/skipped известны; добавление selector — только A03, не prerequisite census                       |
| A03 | A02,A12; A11 применяется к результату                   | Добавить один отсутствующий native selection в существующий CI owner без переразбиения всего lane                                                          | Точные case IDs/имена выполнены с нужными stores; новые cases не дублируют другой owner; старое покрытие и бюджет setup/upload/cleanup сохранены                     |
| A04 | A02,A10; только при измеренной цене shell-list          | Вынести literal native membership выбранного baseline в один inventory, сохранив locked public command и shard arguments                                   | Равны множества paths, порядок/аргументы и shard assignments; проверены missing/duplicate/unsupported entries; один production source, без второго runner            |
| A05 | A04                                                     | Подключить inventory к focused, сохранив UNION membership и AST canonical store-env; helper-only native dependency указать явно                            | Mixed suite вне lane не теряет native requirement; env aliases/resources и fail-closed остаются прежними; inventory не заменяет AST                                  |
| A06 | A01                                                     | Составить evidence map одного выбранного UI flow: pure/source/browser/visual, реальный App или fixture, CI/local owner                                     | Указаны запросы, identity/cancellation и terminal cleanup; не требуется сперва каталогизировать все 89 browser files                                                 |
| A07 | A06,A10; только если уже есть два потребителя           | Унифицировать только существующие дублирующие CI/visual browser selections; будущий focused не считать уже существующим consumer                           | Есть два concrete callers и selection-equivalence; public scripts/timeout/retry/cleanup не меняются; если второго consumer нет, шаг откладывается без блокировки V03 |
| A08 | A01; затрагивается runtime/release source boundary      | Найти predicates/rollback readers выбранного переноса; добавить negative fixture лишь для реально непроверенного refusal                                   | Старый/новый target SHA, отсутствующий файл, unsafe reader и guard order проверены; trusted checker не подменён кодом target; не переписываются все guards           |
| A09 | A01; изменился domain entrypoint или найдена stale note | Обновить одну существующую scoped reference и её указатели; сохранить историю отдельно                                                                     | Один актуальный маршрут навигации, нет второй базы задач и дублирования требований; docs/guidance budgets; не блокирует unrelated adapter                            |
| A10 | A01; заявляется выигрыш agent workflow                  | Снять маленький baseline 3–5 повторяемых задач одного scope: контекст, первый focused result, исправления команд и skips                                   | Одинаковая методика/стартовые условия до и после; discovery и execution time различаются; нет процентов экономии или p95 из нескольких наблюдений                    |
| A11 | A02; применяется к выбранному CI result                 | Связать report с SHA/run/attempt/job/phase и ожидаемыми cases; использовать existing exact-SHA assert-green для final check status                         | Cancelled job не становится зелёным от success JSON; duplicate artifacts/allowed skips различимы; это узкий receipt, не новый CI orchestration layer                 |
| A12 | A02; планируется расширение native lane                 | Оценить бюджет затронутого job: setup, tests, upload, teardown и наблюдаемый разброс до нового selector                                                    | Сохранены timeout и same-SHA rerun; есть резерв и ограниченная диагностика причины; два запуска не превращаются в p95 и не оправдывают увеличение deadline           |

A08 выбирает затрагиваемые predicates до backend moves; чисто тестовый перенос не
требует переделывать все 567 predicates. Учитываются также standalone source checkers.
A04 сначала сохраняет выбранное множество; добавления A03 затем согласуются отдельным diff.
Допустимо сначала выпустить A03 как узкий CI fix, затем строить inventory из обновлённого
проверенного списка: новый baseline фиксируется явно. Нельзя смешать сравнение списков
с незаметным исключением старых suites.

## P0/P1 — authority и совместимость сохранённых операций

Эти небольшие карты дополняют existing domain references; новый центральный registry
прав или новая база задач не создаются. S01/S03 выбираются для конкретной переносимой
границы. Они не заставляют изучать все integrations перед переносом pure renderer.

| ID  | Зависимость                                        | Микроцель и конкретный результат                                                                                              | Проверка завершения                                                                                                                                                                                                       |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | A01; переносится authority/auth boundary           | Для выбранной границы связать вход/signature/session/profile с actor/entity authority и разрешённым эффектом                  | Сохраняются invalid vs expired, launchBotId/lifecycle, origin/CSRF/tunnel и skip-option owner; pure renderer не требует обзора всех auth integrations                                                                     |
| S02 | A01,S01 для auth; сначала принят ID/error contract | Отдельным исправлением добавить typed signed-user decoder, не смешивая его с механическим extraction                          | user=null/primitive/array и id=object/array классифицированы; valid string/number/user_id, rotation/freshness/recovery сохранены; regression требуемого machine error; unsigned bypass не заявлен                         |
| S03 | A01; переносится network storage boundary          | Составить map writer → trigger/revision → reader → lease/receipt → rollback; A08 выбрать по своим source floors               | Совместимый v3 работает; unsupported/section-incompatible reader unsettled; receipt co-commit и stale lease no-write; SQL proof отдельно от mocked MAX permission                                                         |
| S04 | A01; меняется конкретный внешний protocol          | Для одной consumer/provider pair закрепить versions, command/hash/witness/receipt и unknown/fallback rules в existing runbook | Reproducible compatibility fixtures точных versions; Karavan сохраняет ID/payload, statistics partial sweep не отзывает absent, malformed/auth не fallback; live acceptance лишь по rollout scope, не ради docs/pure move |

S02 — подтверждённый malformed-input boundary, отдельный от behavior-preserving refactor.
Текущее `null → TypeError` воспроизведено, но production incident и unsigned обход не
установлены. Это не основание менять все accepted IDs или превращать invalid signature
в session recovery. Самостоятельные `S04` изменения протокола не входят в pure extraction.

## P1 — тестовые границы и чистые функции

Основание: [E03](../../development/refactoring-audit-2026-11-01.md#e03-backend-boundaries),
[E04](../../development/refactoring-audit-2026-11-01.md#e04-private-control-and-max).

| ID  | Зависимость                                                    | Микроцель и конкретный результат                                                                                                             | Проверка завершения                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | A01; выбран ограниченный Admin test domain                     | Перенести один небольшой самостоятельный describe, например allowlist normalization, сохранив setup/cleanup и test discovery                 | До/после равны case identity и assertions; соседние cases сохранены; describe на тысячи строк не считается microgoal; expected result не вычисляется тем же новым helper; production-код не меняется                   |
| T02 | A01; выбран затрагиваемый harness                              | Типизировать один double/port против реального контракта; T01 нужен только если помогает его scope                                           | Ловятся signature drift и неожиданный вызов; mutable singleton/lifecycle не потерян; нет all-domain fixture и структурного cast, лишь маскирующего несовпадение                                                        |
| T03 | A01; переносится достижимый feature path                       | Подключить конкретный real guard только для выбранного достижимого OCR/profanity/image path; T02 выполнить при изменении double              | Виден сам guard call и разрешённый/запрещённый observable effect; retired photo policy off доказывает только no-delete drain; active IMAGE идёт через message-duplicate, DI construction не считается feature coverage |
| T04 | A01,A08; свой private corpus                                   | Перенести один чистый rules-rendering cluster с явными входами; Nest/session/callback owner оставить на месте                                | Выбранные из 131 existing private cases плюс необходимые лимит/язык/null edges до/после; точные тексты, markup length и порядок; не запускать весь unrelated Admin suite                                               |
| T05 | A01,A08; свой payload corpus                                   | Вынести один действительно чистый MAX payload cluster; existing keyboard helper переиспользовать, logger warnings оставить в service adapter | Сохранены omitted/null/forwarded/unknown attachments и payload формы, warnings и defaults; диапазон методов целиком не объявлен pure; admission/final guard/HTTP и retry policy не двигаются                           |
| T06 | A01,A08; свой membership corpus                                | Вынести один parsing/projection cluster webhook с прежними clock и dedupe boundaries                                                         | Сохранены duplicate join repair, cross-bot identity и каждый clock read; SQL/cache commit order не переносится; storage proof лишь при затронутом storage call                                                         |
| T07 | T04 либо T05 либо T06; ceiling уже существует для своего scope | Уменьшить существующий ceiling на фактически перенесённые строки в том же завершённом срезе                                                  | У private legacy ceiling есть, у MAX/webhook этого лимита нет: новый не обязателен; нет пустых forwarders, unguarded переноса долга или illegal legacy imports; отдельный deploy ради ceiling не нужен                 |
| T08 | A01; warning воспроизводится или меняется lifecycle            | Разобрать один shutdown/dispose path и наблюдаемый worker warning с bounded open-handles diagnostic                                          | Exit процесса, timers/Redis/pg/queues и cleanup наблюдаемы; clean runInBand не считается исправлением worker-mode; не строится общий lifecycle framework из одного неповторившегося warning                            |

T01 — необязательный для чужих доменов шаблон одного Admin-среза, не разрешение
одновременно разнести все 31 тысячу строк. T04 использует собственный private baseline.
Разделение tests и изменение production implementation должны иметь независимо
объяснимый diff. Полезные existing tests: `admin-domain-allowlist-runtime.spec.ts`,
`admin-domain-allowlist-runtime-context.spec.ts`, `admin-legacy-port.providers.spec.ts`,
`runtime-role-graph.spec.ts`, `private-control.service.spec.ts`, `max-client.service.spec.ts`,
`webhook.service.spec.ts`. Сначала выбрать cases; не запускать весь этот перечень для
каждого изменения.

## P1 — доказать и убрать старые publishing-ветки settings

Основание: [E05](../../development/refactoring-audit-2026-11-01.md#e05-frontend-state).
Возможный выигрыш — уменьшение state/effects/imports и контекста; размер bundle проверяется
отдельно, заранее не обещается.

| ID  | Зависимость                                                          | Микроцель и конкретный результат                                                                                                  | Проверка завершения                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U01 | A01; A06 для выбранного flow                                         | Перечислить mounts, preload, dynamic/fixture callers и retired-link predicates только chat/channel scope                          | У каждой ветки доказан caller или недостижимость; наличие query само по себе не доказывает retired state; полный browser catalog не prerequisite                                                                 |
| U02 | U01; A06 для этого flow                                              | Проверить настоящий App routing matrix с instrumented transport либо HTTP session mocks и положительным ordinary-settings control | Видимый handoff и absent settings editor; positive control регистрирует settings request; retired forbidden effects отсутствуют; warm counters отделяют прежний in-flight request, ordinary mixed-query сохранён |
| U03 | U02 для chat; branch действительно недостижима                       | Удалить одну chat publishing reverse slice: JSX и только её state/effects/queries/handlers, включая внешние overlays              | Mixed effects разделены без смены timing; handoff=1/shared helpers сохранены; draft storage keys не очищаются без отдельного migration решения; visible/import cleanup атомарен                                  |
| U04 | U01,U02 для channel; U03 необязателен                                | Отдельно доказать и удалить одну недостижимую channel publishing branch                                                           | Собственный channel corpus/mount/effects; нет механического копирования chat proof; обычные sections, preview/deep links и shared UI остаются                                                                    |
| U05 | U03 либо U04; свой scope                                             | Imports и existing ceiling очистить с removal; CSS удалять только после bounded selector/consumer census                          | Broadcast-screen используется active rules; composer styles нужны Publications; cascade/cold/warm сохранены; новые ceilings не создаются; keyboard/safe-area matrix по реальному layout scope                    |
| U06 | A01; после выбранного U03 либо U04 и его U05                         | Сравнить production-origin assets и один agent task с baseline, снятым до removal                                                 | Равны env/lockfile/build mode; startup/incremental route budgets не ослаблены; статистическая погрешность и отсутствие bundle gain названы; measurement входит в acceptance самого removal                       |
| U07 | A01; воспроизведён mixed-query error retry и подтверждено требование | Отдельно решить expected result лишнего publishing GET и лишь затем внести узкую correction                                       | Failing regression и neighboring handoff cases; не ждёт полного U02 catalog, не маскируется structural removal и не блокирует независимый U03                                                                    |

### Обязательная матрица U02

Проверять chat/channel, cold entry и warm переход из settings; `focus=broadcast&handoff=1`,
`focus=mailing`, `workspace=autoposts`, наличие даже пустого legacyKind/legacyId; обычные
rules/giveaway/polls/storefront, отдельно `focus=giveaway&handoff=1` и load error → retry.
Launch/startapp/hash варианты проверять при затрагивании соответствующего resolver.
Publisher publications/entity screens остаются собственными runtime routes.

Forbidden endpoint set задаётся явно для retired entries. Для обычного mixed-query
фиксируется текущее поведение; у chat оно включает publishing GET на error retry,
у channel такого ordinary retry GET нет. Его возможное
изменение относится только к U07. Session bootstrap, `/me`, разрешённый favorites
read и module/CSS preload сами не являются нарушением. In-process preview требует
instrumented ApiTransport, HTTP observer один не доказывает no-fetch. Built real App с
session mocks — альтернативный путь; direct page fixture root guard не проверяет.

Если U01/U02 выявят действующего caller, удаление соответствующей ветки прекращается.
Её изолировать можно отдельным решением с подтверждённым поведением. Независимый F01
не ждёт U02/U06; при overlap нужен caller/behavior proof соответствующей ветки.
Удаление U03–U06 не является обязательным. Ранее утверждённые
[продуктовые решения](../../development/miniapp-product-decisions.md) сохраняются.

## P2 — один настоящий backend domain owner

Первый кандидат — allowlist: уже выделенный runtime с явным context, но legacy остаётся
посредником. Цель — не создать ещё один facade поверх всего `AdminService`.

| ID  | Зависимость                                        | Микроцель и конкретный результат                                                                                 | Проверка завершения                                                                                                                                                                                    |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01 | A01; scope-specific S01/S03 по затронутым границам | Составить allowlist census controllers/manual/private/network/cleanup и state/authority/cache/transaction owners | Read-only census не требует заранее A08 fixtures или test-file move; direct private calls, expired/removal options, triggers и receipts включены                                                       |
| B02 | B01; свой typed double при необходимости           | Ввести только domain operation signatures и explicit authority port, реально независимые от AdminService types   | Нет Parameters/ReturnType от legacy в новом контракте, mega-port и циклического context; authority устанавливает конкретный caller; новый alias не объявлен декомпозицией                              |
| B03 | B02; A08 и applicable S01/S03                      | Переключить одного consumer на фасад того же существующего runtime/state owner                                   | Singleton identity по tokens/forwarders и effects order сохранены; runtime graph дополнен relevant behavior/native case; нет второго cache/lifecycle owner                                             |
| B04 | B03; S03 только для network consumer               | Переключить ровно одного следующего manual/private/network caller; повторять отдельным срезом                    | Сохранены options/permission checks; NetworkNavigationAllowlist остаётся своим transaction owner и не направляется через обычную mutation wrapper; native receipt/lease отдельно от permission doubles |
| B05 | Приняты все выбранные B04; applicable A08/S03      | Удалить один действительно неиспользуемый legacy forwarder/provider после census оставшихся calls                | Все затронутые DI profiles, identity и lifecycle owner прежние; negative rollback fixtures сохранены; перенос DI ownership только при доказанной необходимости                                         |
| B06 | Принят B03 либо один B04/B05                       | Оценить выигрыш завершённого среза и выбрать следующий домен либо остановить декомпозицию                        | Снизились обязательный контекст/зависимости, overhead ports не вырос; B05 не обязательная цель любой ценой; один следующий implementation stage                                                        |

Нужные storage доказательства включают existing `network-navigation-allowlist-postgres.spec.ts`
и `network-settings-postgres.spec.ts`, когда меняется wiring/граница их реального вызова.
Если authority невозможно вынести без цикла или разделения state, B05 откладывается:
узкая совместимая граница B03 сама по себе полезна, но не называется полной декомпозицией.

## P2 — settings, dialog и events по границам состояния

| ID  | Зависимость                                                 | Микроцель и конкретный результат                                                                                                              | Проверка завершения                                                                                                                                                                                               |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | A01; concrete remaining cluster и свой A06, U01 при overlap | Выбрать ещё не выделенную presentation model одной settings section либо принять existing helper как достаточный                              | Польза consumer/context доказана; useSettingsDraft revision/conflict прежние; section metadata/shared rendering уже существуют; независимый срез не ждёт U02/U06, допускается no-op                               |
| F02 | A01; свой section census и browser baseline                 | Для allowlist вынести только list/composer presentation с текущими callbacks; draft-editor выбирать лишь для действительно draft-owned секции | Allowlist add/remove/schedule остаются immediate endpoints со своими invalidations; same-call payload/count, errors и focus; перенос mutation controller — отдельное решение после scope-staleness proof          |
| F03 | A01; A06 для dialog, C04 если меняется fixture              | Вынести только immutable merge/update/remove/toggle cluster, сохранив structural sharing без JSX/MAX handlers                                 | Input не мутирует, unrelated message identity сохранена, update idempotent, reaction state корректен; double-toggle сравнивает semantics без требования прежнего sort order; tests не повторяют loop              |
| F07 | A01; свой attachment baseline                               | Вынести только existing CommentMessageAttachments с прежними props/keys/click handlers; F03 не prerequisite                                   | MIME/URL/missing fallback, click propagation и album index; gallery/modal/native Back/download/scroll owners прежние; compose/viewer и lazy-loading не включаются автоматически                                   |
| F04 | A01; свой async attachment corpus                           | Выделить один owner generation/cancel/async preparation; F07 нужен лишь при изменении общего seam                                             | Прежние api/user/profile/entity/chat/dialog/token/capability dependencies; late import/read/edit/unmount, byte limits и partial results; input watchers/DOM/focus остаются parent; object-URL cleanup не теряется |
| F05 | A01; A06 для dialog и свой behavioral corpus                | Сначала выделить только dialog query + terminal-stop ownership; одну mutation family рассматривать отдельным следующим срезом                 | Реальные terminal/poll-stop, unmount/late response и abort cases; moderation и Publisher профили выбираются явно; existing browser не доказывает reaction-failure rollback; focus/scroll/draft owners прежние     |
| F06 | A01; свой A06 и real EventsPage read-state baseline         | Выделить только dashboard query/snapshot/read model; participant mutations и review workspace оставить                                        | Keyed chat/range/include flags, initialDataUpdatedAt=0, delayed hydration и display/current/authoritative identity; cached-only snapshot не разрешает mutation; feed hook tests не заменяют page behavior         |

F03 не зависит от удаления settings-кода и может быть выбран следующим этапом вместо
F01/F02, но не вести оба runtime этапа одновременно. Имеющиеся feed/rules/subscription
hooks, shop journal и Safety Desk guard не переписываются под универсальный async hook.

Для нового source `3096266b1` магазин учитывает независимые границы: daily management
с проверенными access/binding generation не блокируется connection recovery; connection
commands сохраняют original chat/key/request и attempt identity. Retry снова проходит
свой IDB journal fence с тем же command ID. `saveMirroredItem` — best effort, не durable
commit proof; web SDK storage считается недоступным даже при наличии методов. UI removal
и controller extraction должны сохранить эту асимметрию, не делать общий loading/error gate.

## P2 — contracts и входные данные

| ID  | Зависимость                                                | Микроцель и конкретный результат                                                                             | Проверка завершения                                                                                                                                                                                            |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | A01                                                        | Выбрать один действительно ациклический core leaf и составить consumers + defaults/issues corpus             | Учтены runtime/public exports/source/Jest aliases и schema dependencies; initial target/schema leaf не тянет весь core обратно; type-only imports не считаются bundle defect                                   |
| C02 | C01; A08 если source predicates затронуты                  | Перенести выбранный leaf с прежними exports и одной canonical definition без цикла leaf → core               | Root/subpath identity проверяется внутри каждого source/Jest или built mode, не source === build; parse outputs/defaults/coercion/issue paths и все affected consumers прежние                                 |
| C03 | A01; подтверждён accepted HTTP/error contract              | Перевести одну baseline boundary на unknown + existing runtime schema без расширения scope                   | Valid/default/extra-key/coercion/invalid statuses и authority проверены; если схема меняет accepted input — отдельная correction; exception удаляется только после proof                                       |
| C04 | A01; выбранный fixture стал evidence изменяемого контракта | Типизировать один valid builder/harness и включить настоящий либо сгенерированный TSX в узкую test typecheck | Runtime parse и static check различаются; corrupt negative payloads не нормализуются builder; embedded TSX в .mjs не считается typechecked; один объяснённый generic-dispatch cast допустим, blanket casts нет |

Не разрезать большой chatSettings refine/transform без отдельного corpus. Не добавлять
runtime Zod во все UI clients ради одинакового стиля: сначала доказать boundary gap и
учесть route budgets. Prisma models/DDL в этот этап не входят.

## P2 — инструменты агентов и visual tooling

| ID  | Зависимость                                                           | Микроцель и конкретный результат                                                                            | Проверка завершения                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V01 | A01,A10; часто нужен selected Lastik unit file                        | Сначала определить selective public command contract, затем добавить один focused adapter без bypass runner | Existing npm test имеет glob: добавленный path не выдаётся за selection; проверены единственный выбранный file, exact args/UTC/exit; A09 не prerequisite                                                 |
| V02 | A01,A10; выбран native Lastik scope, V01 необязателен                 | Добавить selective Lastik stores route только при реальной потребности, поверх одного public storage owner  | MAXIM_TEST_POSTGRES_URL и MAXIM_TEST_REDIS_URL как в specs, isolated schemas и собственный migrate/cleanup; --migrate generic wrapper относится к API Prisma; no nested stores/no phantom ERASER aliases |
| V06 | A01,A10; измерена потребность API Node-native selection               | Рассмотреть adapter только для existing retention/storage public family, сначала доказав selective dispatch | Fixed-list runner не сужается добавлением пути; exact selected file/args/env/exit и codegen locks; произвольные benchmarks не включаются по одному suffix; whole-family обозначается честно              |
| V03 | A01,A06,A10; A07 только если уже принят                               | Подключить один уже проверенный browser profile к focused с существующим lifecycle/report owner             | Missing browser/strict port/signals/failure/cleanup и exact forwarding; профиль может включать transitive browser imports; inventory не обязательный prerequisite, CI coverage отдельно                  |
| V04 | A01; known selection failure либо measured maintenance cost           | Заменить visual newline Git parser на canonical NUL collector, явно выбрав changed scope                    | Оба rename paths, deletion, staged/unstaged/untracked и unusual names; override precedence и Git errors fail-closed; ordinary selection равен, conservative rename widening назван intended fix          |
| V05 | A01; конкретный ещё не выделенный pure cluster и свой visual baseline | Перенести одну pure geometry/report computation, если навигационная польза выше цены переноса               | Уже выделенный miniapp-smartphone не переделывается; page/evaluate и lifecycle остаются у owner; fractional metrics/tolerance/report fields прежние; V04 не prerequisite                                 |
| V07 | A01; свой selected visual profile, V04 необязателен                   | Перенести behaviors одного домена и проверить registry ↔ metadata в обе стороны                             | Те же IDs/action order, local/Major defaults, faults/cleanup и effects observations; screenshot file сам по себе не является pass                                                                        |

Выбирать V01–V03 и V06 по замерам A10: новый adapter оправдан частым реальным использованием,
а не полнотой каталога. Не вводить второй scheduler поверх plan/verify/focused.

## P3 — runtime performance только после измерения

Основание: [E09](../../development/refactoring-audit-2026-11-01.md#e09-measurement-and-scope)
и действующий domain-specific publisher plan. Эти шаги не возобновляют автоматически
остановленные программы rollout или необратимые операции.

| ID  | Зависимость                                             | Микроцель и конкретный результат                                                                                                        | Проверка завершения                                                                                                                                                                                               |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | A01; конкретный оставшийся full-row/scan bottleneck     | Начать с existing publisher smoke; полный 10k/50k профиль — только для выбранного оставшегося bottleneck в disposable stores            | Изолированы MAX/Redis/heartbeat synthetic effects, все cells/postconditions/cleanup; width/cardinality/actual work различаются; reports/source digests и sample gaps сохранены; не требуется unrelated extraction |
| P02 | P01,A08; новый выигрыш ещё не реализован                | Выбрать один remaining full-row reader, составить field-consumer matrix и только затем single-snapshot projection                       | Existing E4/D15 projections не переделываются как новая optimization; Prisma GetPayload/select, generated SQL и consumed fields совпадают; порядок, repairs, finalizer и final authority прежние                  |
| P03 | P01; свой read-site corpus                              | Определить race/field matrix до production edit P02, затем проверить его baseline/candidate через independent DB connections и barriers | P02/P03 один связанный PR без промежуточного deploy; both sides stop/revoke/edit/cancel/lease/receipt, no selector tautology; existing E4/D15 cases переиспользуются, unrelated suite не повторяется              |
| P04 | P02,P03; измерен выигрыш и resource flags рассмотрены   | Выпустить только прошедший correctness/benefit gate projection и наблюдать применимые production acceptance                             | Exact-SHA Required/CodeQL/deploy/manifest, immutable source; no benefit или необъяснённая memory/CPU regression — no rollout; старые benchmark проценты не переносятся                                            |
| P05 | P04; доказан оставшийся bottleneck и отдельный go/no-go | Только исследовать возможность two-phase read/bounded continuation без включения новой execution authority                              | Version/snapshot/composition/order/final authorization и обе стороны race доказаны; иначе решение no-go; implementation потребует отдельного плана, не расширяет Z03 автоматически                                |
| P06 | P01 либо P04; bottleneck находится в access path        | Исследовать один index/DDL вариант на representative disposable workload; не применять автоматически                                    | Explain rows×loops/buffers, WAL/write cost, concurrent compatibility и rollback class; отсутствие benefit завершает hypothesis; reviewed baseline debt не удаляется full Prisma diff                              |

Не заявлять O(1) из-за `LIMIT`, маленького output или quantum. Не удалять finalizer/repair
из-за «обычно не нужен». Нельзя превращать SQL error/empty SKIP LOCKED в completion.
Старые synthetic цифры и pure-helper benchmarks не являются production latency.

## P3 — инфраструктура и независимый Lastik

| ID  | Зависимость                                              | Микроцель и конкретный результат                                                                                        | Проверка завершения                                                                                                                                                                           |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O01 | A01,A08; runtime move действительно требует checker seam | Выделить один capability checker за прежней shell entrypoint без смены решения о target                                 | Trusted checker provenance/availability после git switch сохранены; target SHA reads, order/floors/reasons и negative fixtures прежние; checker нельзя брать из недоверенного rollback target |
| O02 | A01; concrete residual topology drift                    | Проверить оставшийся TS/Compose/Bash/auxiliary/image drift; генерацию решать лишь если существующих guards недостаточно | Existing runtime-topology.spec и deploy-release-guards уже учитываются; no residual drift — no-op без нового registry/generator; roles/secrets/concurrency не меняются                        |
| O03 | A01; public Lastik runner своего scope                   | Выделить только общую canonical operation-hash function вместо дублей                                                   | Побайтово тот же serialization/order/null/string/number digest на golden corpus; types не объединяют разные protocols; dispatch/settle и database fields прежние                              |
| O05 | A01; public Lastik runner своего scope                   | Перенести только чистую diagnostics projection и её types                                                               | Null/unknown/partial/status/timing fields прежние; нет дополнительных SQL или effect из getter; hash, runtime port и transactions не меняются                                                 |
| O04 | A01; реально мешает concrete Store dependency            | Ввести минимальный Pick/port для используемых runtime Store methods и typed double                                      | Не дублируется весь Store; compile contract + health/recovery/due/rate/retry по scope, native when invariant needs it; advisory/policy locks/leases/attempts/unknown и bridge сохраняются     |

Для O03/O04 adapters V01/V02 необязательны. Existing public Lastik scripts запускают
целое семейство через glob: добавление пути не делает их selective. Если нет отдельного
поддерживаемого selective route, честно использовать whole-family command по своему scope.
Native specs читают `MAXIM_TEST_POSTGRES_URL`/`MAXIM_TEST_REDIS_URL`, сами создают isolated
schemas, вызывают Lastik migrate и очищают их. Generic `with-test-stores.mjs --migrate`
мигрирует API Prisma, не Lastik; runtime `ERASER_*` aliases он не создаёт.

Host-wide cleanup, чужие services, stores recreation и token sharing не входят в программу.
Новые abstraction не должны объединять независимые Major/Lastik state machines.

## Отложенные границы: отдельные решения

| ID  | Участок                                                                     | Условие перед возможной реализацией                                                                                                                   |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Z01 | Moderation webhook handler/timeout settlement                               | Матрица preparation/failure/persist/timeout/detached/quarantine; native fullpath и latency regression matrix; никакого общего retry wrapper без proof |
| Z02 | Delete-intent executor и независимые причины                                | Явная state machine + lease/dispatch/receipt/unknown/fresh authority proofs; целостные транзакции и regression обеих причин                           |
| Z03 | Publisher readiness/seals/new materialization/DDL                           | Актуальный domain plan, сравнительный native correctness proof и writer census; certificate не выдаёт SEND authority                                  |
| Z04 | Native auxiliaries, broad dependency/compiler upgrades, новые microservices | Измеренный bottleneck и отдельный compatibility/lifecycle rollout; no-network/no-secret/kill-reap и бюджеты сохраняются                               |

Массовое переименование файлов, универсальный repository/event bus/mutation hook, рост
quotas/concurrency, очистка Redis/очередей и удаление uncertainty fences не являются
микроцелями этого плана. Снижение числа строк не оправдывает такие изменения.

## Первый практический цикл

1. A01: выбрать одну границу и заморозить source. Для native CI gap — узкие A02/A12,
   один A03 и применимый A11. Восемь кандидатов уже прошли локально на старом baseline;
   selectors ещё не исправлены. Сохранять свежесть receipts по изменившимся inputs.
2. Для agent workflow сначала маленький A10. Из structural runtime кандидатов первым
   рассмотреть T04 либо F03: оба имеют ограниченный pure seam. Если текущая задача UI,
   она не ждёт устранения unrelated backend CI gap. Выбор зависит от нужного домена.
3. S02 выбирать отдельной correction после ID/error contract; U01/U02 → один U03 либо
   U04 — после route proof. Их нельзя объединять с pure extraction в один результат.
4. После первого принятого среза сравнить пользу/цену проверки и выбрать следующий.
   B-domain move, inventory, adapters и P01 запускаются по своему подтверждённому основанию.

Это следующий маршрут выбора, не разрешение начать все ветки. A01/A08/S01/S03 — маленькие
проверочные карточки выбранного scope; не превращать их в четыре новых framework или
повторную инвентаризацию всего проекта. После двух принятых runtime срезов пересмотреть
программу; прекратить кандидатов без измеренной пользы.

## Риск, результат и конечный критерий программы

| Пакет           | Ожидаемый выигрыш                               | Главный риск                                                | Разрешённый первый результат                                                    |
| --------------- | ----------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A02/A03/A11/A12 | Достоверное покрытие и предсказуемый feedback   | False green, пропавший case, job timeout                    | Один native owner с executed cases и полным terminal CI receipt                 |
| T01/T02/C04     | Меньше контекста и обнаружение drift до runtime | Fixture перестала моделировать реальный контракт            | Один typed domain harness с тем же observable corpus                            |
| `S02`           | Корректная signed-input boundary                | Изменение accepted IDs/session semantics                    | Узкий decoder с подтверждёнными valid/invalid cases                             |
| U01–U06         | Меньше state/effects/imports без потери функций | Mixed handoff и shared helpers ошибочно удалены             | Удалена одна доказанно недостижимая ветка; warm/cold реальные flows сохранены   |
| T04–T06         | Изолированная чистая логика                     | Текст/clock/dedupe/guard order изменились                   | Один pure cluster с before/after corpus                                         |
| B/F/S03/S04     | Меньше связности домена                         | Разделён singleton, authority, receipt или principal        | Один законченный owner с native/permission evidence по своим границам           |
| P/O             | Измеренное снижение стоимости                   | Snapshot, reader, lifecycle или effect uncertainty нарушены | Минимальный прошедший correctness gate шаг; отсутствие выигрыша допускает отказ |

У программы нет цели завершить все строки любой ценой. Рабочий этап закончен, когда
его owned diff завершён и проверен, обязательные CI/release/acceptance gates выполнены,
старые readers/fences совместимы, а выбранный показатель улучшен либо гипотеза отвергнута.
Программу пересматривать после первых двух принятых runtime срезов: продолжать только
пакеты с измеренной пользой, отложенные/отвергнутые кандидаты сохранять с причиной.

Карточка каждого будущего этапа в private task record: ID, exact SHA/source digest,
expected/authority, scope/callers, test command + executed/skipped cases, rollback class,
owner state/lifecycle, risk, terminal result и следующий gate. Для persisted/external
изменений отдельно old/new readers/writers и что разрешено после unknown outcome.

Rollback classes: docs/tests/tooling — code revert после проверки inputs; pure runtime —
compatible code/image rollback через штатный wrapper; persisted/reader/DDL — отдельный
compatibility gate, прежний image может быть запрещён; uncertain external effects —
settlement/reconciliation по журналу, никакого нового SEND/DELETE из rollback.

## Проверочные рецепты для следующих срезов

Ниже точные supported команды, а не требование выполнить всё перед каждым Markdown diff.
Preflight выполняется до дорогих запусков; stores используются только для нужного scope.

```bash
node scripts/agent/focused.mjs --test apps/api/src/moderation/private-control.service.spec.ts --json
node scripts/agent/focused.mjs --test apps/api/src/auth/init-data.service.spec.ts --test apps/api/src/auth/init-data.guard.spec.ts --test apps/api/src/auth/miniapp-session-lifecycle.spec.ts --json
node scripts/agent/with-test-stores.mjs --migrate -- node scripts/agent/focused.mjs --test apps/api/src/admin/network-settings-postgres.spec.ts --test apps/api/src/admin/network-settings-supplemental-postgres.spec.ts --json
node scripts/agent/focused.mjs --test apps/miniapp/test/publik-handoff.test.ts --test apps/miniapp/test/launch-route.test.ts --test apps/miniapp/test/auth-query-session.test.ts --test apps/miniapp/test/api-transport.test.ts --json
```

Для Lastik доступны whole-family public commands; это не selective adapter:

```bash
npm run test --workspace @maxim/eraser
node scripts/agent/with-test-stores.mjs -- npm run test:stores --workspace @maxim/eraser
```

Первый script сам задаёт UTC; native specs владеют своими migrations и cleanup.
`focused.mjs` не запускает preflight автоматически — preflight остаётся отдельным шагом.

Browser family пока запускается existing scripts напрямую:

```bash
node apps/miniapp/test/settings-draft.browser.mjs
node apps/miniapp/test/comment-dialog-attachments-async.browser.mjs
```

Первый entrypoint дополнительно импортирует settings-stop-words browser: планировать
его фактическую длительность и всю цепочку cleanup. Он покрывает hook и реальную страницу,
но не новый U02 retirement matrix. Chromium/WebKit и MAX WebView — разные evidence;
`settings-overview-navigation.browser.mjs` требует также WebKit. Built startup profile
требует production-origin build и свободный strict port, не запускается по наличию Chromium.

## Как оценивать результат и передавать работу

После этапа записать baseline/result для выбранных показателей:

- Сколько callers/domains/файлов нужно прочитать для той же типовой задачи; сколько
  общих fixture dependencies и legacy forwarders реально устранено.
- Медиана времени первого focused результата; corrections команд и случайные skips;
  p50/p95 времени нужных suites/shards и peak memory, если это была цель.
- Browser requests/identity/cancellation и startup/incremental assets для UI.
- Runtime latency и SQL/CPU/memory только при измеренном performance scope; отдельно
  от очередного возраста, HTTP 200 и статистики admission.

В handoff указывать: микроцель, SHA, expected behavior, tests и skips, что осталось
неизвестным, written/local/CI/deployed/accepted status и ровно следующий gate.
Проверить ownership до сообщения об окончании. Отсутствующее наблюдение не считается
зелёным; процесс должен иметь identity/log/deadline/exit, collector — ещё heartbeat
и последний успешный sample.

Абсолютной гарантии «ничего не сломается» статический план не даёт. Практический
приоритет — уменьшать blast radius каждого изменения, сохранять подтверждённые
контракты и получать достаточное независимое доказательство перед следующим шагом.
