# Рекламный фильтр и ИИ: аудит и план от 1 ноября 2026

План продолжает [октябрьскую работу](2026-10-28-bot-ai-reliability.md).
Задача — исправить подтверждённые дефекты, измерить полезный охват и получить
независимые доказательства качества до расширения автоматических удалений.
Функциональные тесты, CI, выпуск и production-приёмка являются разными этапами.

## Что проверено

Аудит исходников выполнен на `fc449a644d03de41d443fa087efc5817defe1841`.
На момент проверки VPS checkout и теги образов `api-admin` и
`api-moderation-background` соответствовали этому SHA; оба контейнера использовали
образ `sha256:140abbd6d0c904f5870a8a9a3ae46c0e06945cfec3a91456f3dd3076924b0532`.
Проверка не является аттестацией всех остальных ролей или длительным мониторингом.
Время далее указано в UTC; московское время — UTC+3.

| Проверка                                           | Наблюдение                                                                                                                                                                                                                        | Предел вывода                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Локальные focused cases                            | 17 наборов, 328 тестов прошли; изолированные PostgreSQL 16/Redis 7, пропусков нет                                                                                                                                                 | Модельные ответы в этих тестах контролируемые; точность настоящих моделей ими не измеряется                                                        |
| API и зависимости, 17:27–17:28                     | Health успешен; PostgreSQL/Redis доступны, operational lag около 1,7 с                                                                                                                                                            | Общая готовность не означает качество рекламной классификации                                                                                      |
| Серверная модель, 17:27:32                         | `qwen35-9b-slots-v1`: running/healthy, 0 рестартов; 6 CPU, 12 GiB, context 4096, один slot                                                                                                                                        | Проверена серверная модель; независимое качество и перезапуск каждого ПК не проверялись                                                            |
| Пул, 17:30:02                                      | Все три узла READY; workers/routing включены, policy=`confirm-positive`, heartbeat свежий                                                                                                                                         | Это один снимок, а не доказательство непрерывной доступности                                                                                       |
| Счётчики процесса с 16:48:57 до heartbeat 17:29:57 | Завершённые model attempts: CPU 53, ПК 4B 649, ПК 9B 400; failures 0. Перепроверки: completed 322, noCapacity 38, budgetExhausted 0                                                                                               | Attempts включают первичную работу и консультации; это не 1102 уникальных сообщения                                                                |
| Терминальные исходы того же процесса               | KEEP 452, UNSURE 309, DELETE intent registered 19, pressure skip 1; pending expired 15 в отдельном накопительном namespace                                                                                                        | 19 намерений не означают 19 подтверждённых удалений; pending-счётчик имеет другой период                                                           |
| Bounded moderation audit, конец 17:29:12           | В newest 512 событиях есть 8 строк `COMMERCIAL_AI / DELETE_REMOTE_CONFIRMED`; фактический span 620,819 с                                                                                                                          | Выборка усечена; это строки событий, не проверенная уникальная когорта, точность или охват всех ботов                                              |
| Закрытая diagnostic cohort 17:15–17:30             | 63 retained captures, 34 logical sources, 31 экспортированная ревизия, 29 duplicate bindings; 3 `TEXT_UNAVAILABLE`. Из 29 observed attempts: accepted 24, rejected 4, not observed 1; 24 результата: NOT_COMMERCIAL 14, UNSURE 10 | Retained captures не являются случайной выборкой входного трафика. Остальные 34 captures без AI observation не превращаются в отрицательные ответы |

Diagnostic collector завершился `COMPLETE` за пределами исходного окна; лимиты —
500 raw rows, 8 MiB и штатный deadline 120 с. Сначала рассмотрен plain EXPLAIN
реальных reviewed helper-запросов, затем выполнен collector. Экспорт хранится
приватно вне Git; тексты, идентификаторы, raw linkage и локальные agent traces
в этот план не включаются. В этой когорте нет положительных AI permissions,
receipt lookup не потребовался, подтверждённых собственных удалений — 0.
Это согласуется с другой выборкой, где были 8 событий удаления: источники и
знаменатели различаются. Human labels — 0, `evidenceSufficient=false`,
`promotionAuthorized=false`. `COMPLETE` означает исчерпание выбранного retained
окна, а не полноту проверки рекламного фильтра.

## Недочёты и риски

Приоритет P1 означает первую очередь исправления или измерения; сам по себе он
не устанавливает production-инцидент. Ссылки относятся к проверенному исходному
SHA. Подтверждённое текущее поведение отделено от гипотез и будущих расширений.

| ID / приоритет           | Подтверждение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Последствие и нужная работа                                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 / P1                  | [AI capture](../../../apps/api/src/moderation/commercial/commercial-quality-observation.ts) очищает violation metadata и получает пустые `requiredPolicyCohorts`; [writer](../../../apps/api/src/moderation/commercial/commercial-ai-observation.service.ts) и [review export](../../../apps/api/src/moderation/commercial/commercial-review.service.ts) сохраняют это значение. [AI report](../../../apps/api/src/scripts/commercial-ai-quality-report.ts) ищет protected cohorts именно в нём | Штатная AI-выборка не наполняет обязательные protected-cohort gates. Synthetic fixture с вручную заполненной когортой этого не проверяет. Нужны отдельные blind semantic cohort annotations и сквозная проверка capture→review→export→report; execution cohorts не являются человеческой разметкой   |
| F2 / P1                  | [Phone parser](../../../apps/api/src/moderation/commercial/commercial-phone.ts) на синтетическом `https://example.test/item/79000001042` вернул телефон `79000001042`; URL ranges не исключаются. Международная ветка дополнительно принимает `+`-числа без тех же identifier guards                                                                                                                                                                                                            | Ложные контактные признаки могут попасть в scorer, campaign grouping и качество выборки. Ложное production-удаление этим примером не доказано. Исправить boundary, раздельно проверить moderation evidence и privacy masking                                                                         |
| F3 / P2, до promotion    | [Intent candidate](../../../apps/api/src/moderation/commercial/commercial-intent-quality-policy.ts) считает полноту по сгруппированным assertions, хотя [helper](../../../apps/api/src/moderation/commercial/commercial-local-context.ts) уже обрезал их до 64                                                                                                                                                                                                                                  | Воспроизведено: исходник 1413 символов с защищённым началом, editorial quote и рекламой в хвосте даёт 63 assertions, `fullyInspected=true`, independent offers пусты. Отдельное хвостовое предложение распознаётся. Дефект экспериментального кандидата, не установленный пропуск активного baseline |
| F4 / P1                  | [Enforcement service](../../../apps/api/src/moderation/commercial/commercial-llm-enforcement.service.ts) убирает синхронный `COMMERCIAL_AD` до исхода admission. Возможны oversized/stale/busy/no capacity/Redis failure/timeout                                                                                                                                                                                                                                                                | Это действующая политика безопасного отказа: рекламного действия может не быть. Нужны измеренный полезный охват и явная политика деградации. Автоматический baseline fallback без отдельной оценки недопустим                                                                                        |
| F5 / P1                  | [Status projection](../../../apps/api/src/admin/safety-desk-commercial-ai-pool.service.ts) корректно возвращает `trafficCoverage=NOT_ESTABLISHED`, `confirmedDeletes=null`; runtime outcomes привязаны к процессу                                                                                                                                                                                                                                                                               | Сейчас нельзя получить fleet coverage или recall из dashboard. Нужен входной знаменатель и замкнутое accounting; diagnostic collector уже есть, создавать его заново не нужно                                                                                                                        |
| F6 / P2                  | [Pool client](../../../apps/api/src/moderation/commercial/commercial-llm-pool.client.ts) сразу принимает отрицательный 4B. Предыдущий [cascade](../../../apps/api/src/moderation/commercial/commercial-llm-cascade.client.ts) имел случайный negative audit                                                                                                                                                                                                                                     | Пул лишён этой дополнительной проверки пропусков. Нужен ограниченный независимый shadow audit с известной вероятностью отбора и без нового права удаления; 9B также не является истиной                                                                                                              |
| F7 / P2                  | [Triage](../../../apps/api/src/moderation/commercial/commercial-ai-triage.ts) вычисляет `suspected_ad`, но service не передаёт priority в admission                                                                                                                                                                                                                                                                                                                                             | Это пока диагностический сигнал, а не приоритет обслуживания. Сначала simulation/fairness, затем versioned admission policy; эвристический KEEP shortcut не допущен                                                                                                                                  |
| F8 / P2                  | Rank в pool client учитывает EWMA и failure penalty отдельного узла, но не стоимость последующей консультации. Наблюдались 38 no-capacity consultations                                                                                                                                                                                                                                                                                                                                         | Сравнить полезные завершённые решения при текущей политике с routing, учитывающим консультацию. Нельзя устранять отказы отключением `confirm-positive` или очередью консультаций                                                                                                                     |
| F9 / P2                  | [CPU pool server](../../../apps/api/src/moderation/commercial/commercial-llm-pool-server.ts) сводит held lease, cooldown, отсутствие headroom, busy slot и identity/transport failure к not-ready                                                                                                                                                                                                                                                                                               | Оператор не видит причину недоступности. Нужны конечные reason codes, observedAt и freshness; статус не должен сам снимать quarantine                                                                                                                                                                |
| F10 / P1, восстановление | [CPU lease](../../../apps/api/src/moderation/commercial/commercial-llm-shadow.lease.ts) хранит persistent quarantine в Redis; [Compose](../../../infra/docker-compose.yml) задаёт часовую RDB persistence без AOF                                                                                                                                                                                                                                                                               | Потеря Redis state может уничтожить fence неопределённого inference. Это риск восстановления, не наблюдавшийся сбой в этом аудите. Нужен generation-bound durable fence и boot reconciliation; одно включение AOF проблему не доказывает                                                             |
| F11 / P1, приёмка        | [Pool runbook](../runbooks/commercial-ai-pool.md) прямо фиксирует отсутствие operator end-to-end pool smoke                                                                                                                                                                                                                                                                                                                                                                                     | Unit/native tests и READY не заменяют текущий producer→bridge→реальная модель→parser→source fence harness. Нужен закрытый сценарий без MAX authority                                                                                                                                                 |
| F12 / P2, гипотеза       | [Request protocol](../../../apps/api/src/moderation/commercial/commercial-llm.protocol.ts) ограничивает excerpt 2500 UTF-16 символами, runtime context — 4096 tokens; контекст диалога не передаётся                                                                                                                                                                                                                                                                                            | Символы не гарантируют token fit. Измерить tokenizer exact model, Unicode, смешанные языки, цитаты и длинные сообщения. Факт overflow или prompt injection в production не установлен                                                                                                                |
| F13 / P3                 | Integration reference описывал только начальный shadow mode                                                                                                                                                                                                                                                                                                                                                                                                                                     | В этом documentation change добавлено явное описание текущих modes и границы исторического раздела. Runtime-поведение не меняется                                                                                                                                                                    |

В актуальной форме sensitivity и санкции уже скрыты в `DELETE_ONLY`; это не
дефект интерфейса. Модель получает текст без этих числовых настроек, поэтому
возвращать такие контролы следует только вместе с отдельными проверенными AI
policy profiles. Улучшение UX — краткое свежее состояние работы внутри открытого
модуля: доступен / временно недоступен / неизвестно. Флаг «включён» не является
доказательством обработки; overview не следует перегружать техническими статусами.

## Порядок внедрения

| Этап                | Результат                                                                                                                                   | Условие перехода                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Надёжность          | Актуальная AI authority до расхода дневной защиты; объяснимое истечение pending; права эффективного DELETE_ONLY; безопасная диагностика CPU | Native PostgreSQL/Redis fault tests, совместимость, exact-SHA CI и обычный выпуск       |
| Качество наблюдений | Разделение синхронного detector, асинхронного AI результата и факта удаления; frozen модель/промпт/runtime/source binding для всех исходов  | Нет ложного KEEP из отсутствия результата; независимая выборка с известной вероятностью |
| Оценка политик      | Сравнение действующего пула, готового intent candidate и моделей на одном независимом holdout                                               | Слепая двойная разметка, temporal/author/campaign separation, доверительные границы     |
| Охват               | Измеренная маршрутизация по завершённым решениям, причины потерь admission и перепроверки                                                   | Offline simulation, shadow и отдельный canary без продления сроков                      |
| Устойчивость        | Unicode, цитаты, отрицания, prompt injection, контекст и длинные сообщения                                                                  | Парные adversarial проверки с сохранением защищённых когорт                             |
| Изображения         | Сравнение текущего Tesseract с multilingual OCR/VLM в shadow                                                                                | Полные оригиналы, независимые image labels, native provenance и отдельный допуск        |
| Новые типы          | QR, edits, voice/video с отдельными source/revision и бюджетами                                                                             | Свой opt-in и оценка качества каждого типа                                              |

Этапы runtime выполняются последовательно. Диагностическое наблюдение может
продолжаться независимо; результаты не продвигают политику автоматически.

## Сохраняемые границы

- `confirm-positive` сохраняет обязательную немедленную 9B-перепроверку; занятость
  оставляет UNSURE. Очередь консультаций, direct-4b и KEEP shortcut не включаются
  только ради улучшения статистики.
- Подтверждённый held CPU lease остаётся удержанным до штатной процедуры,
  доказывающей остановку точного поколения. Healthy/idle не снимает uncertainty.
- Детерминированный baseline имеет остаточные ошибки на запросах покупателя,
  отрицаниях и частных продажах. Готовые защиты candidate не являются разрешением
  включить его или сделать baseline автоматическим fallback без независимого gate.
- Рекламный анализ изображений выключен: активный OCR обслуживает явный image
  stop-list. Retained commercial OCR guards нужны для совместимости/drain;
  наличие этих readers не означает активную коммерческую обработку фото.
- Исходные deadlines, exact source/proof/settings, права, immunity, durable DELETE
  и неизвестные effects сохраняются. Приём в очередь и намерение удаления не
  считаются исполнением.

## Независимое качество

Расширять существующую приватную review-систему, сохраняя blind append-only ratings,
известную sampling probability, 14-дневный срок и экспорт до истечения источников.
AI-specific bundle должен связывать source revision, полноту санитизированного
текста, model/prompt/template/runtime/policy, route, все конечные исходы и квитанцию
эффекта. KEEP, UNSURE, технические отказы и потери admission имеют отдельные
знаменатели. Неполный исходник не получает definitive label.

Прежде чем смотреть holdout, фиксируются критерии AI-политики. Ориентиры:
верхняя 95% граница ошибочного удаления защищённых независимых единиц ≤0,1%,
нижняя 95% граница recall независимых offer units ≥95% в поддерживаемом классе.
Действующие deterministic/OCR gates не являются автоматическим AI допуском.
Author/campaign группировка и временной gap не менее 24 часов обязательны;
автоматические метки и синтетика не заменяют независимых рецензентов.

Основные метрики: eligible→accepted→classified/UNSURE/incomplete→authorized→
confirmed DELETE; accounting gap на замкнутой когорте; полная задержка, причины
недоступности и полезные решения узла. Отсутствие свежего наблюдения показывается
явно. Ни self-reported confidence, ни эвристический sigmoid не являются
калиброванной вероятностью правильности.

## Исполнимый backlog

Primary stage — A: реализованы исправления F1–F3 и регрессионные проверки;
выпуск требует exact-SHA CI и штатного deploy. Детали границ данных и экспорта —
в [описании интеграции](../../development/commercial-llm-integration.md#independent-semantic-review-and-ai-export).
Следующие этапы не запускаются как параллельные runtime-релизы. Сбор независимых
данных может идти отдельно от реализации. Условия приёмки B–F и независимые
quality gates остаются обязательными; синтетические тесты их не заменяют.

### A. Исправить границы данных и возможность доказать качество

1. Для F1 ввести versioned semantic cohort annotations в blind review. Два
   рецензента независимо определяют роль автора, offer/buyer/private sale,
   цитату/отрицание, общественное объявление, смешанные утверждения и достаточность
   контекста. Предсказание модели и detector cohorts скрыты до фиксации ratings.
   Отдельный adjudicator разрешает расхождения. Source hashes, reviewer provenance
   и append-only revisions обязательны; старые captures не получают придуманных
   меток. Native full-path test должен довести реальный AI seed до cohort gate.
2. Для F2 извлекать контакты из исходного текста с offsets и исключением
   URL/email/URI overlap; применить identifier/quantity guards ко всем семействам.
   Privacy redaction должна оставаться консервативной отдельной границей.
   Проверить URL path/query, SKU/заказ/ИНН, положительные величины и реальные
   labelled/obfuscated phones. Сохранить доказательство нужных телефонных hits;
   проверить campaign grouping, corpus grouping и model input fingerprints.
3. Для F3 переносить `{assertions, complete}` из исходного bounded scan, не
   восстанавливая полноту из длины изменённого массива. Случаи 63/64/65/66
   assertions, quote grouping, независимое предложение после protected text,
   cold/warm cache и действующие sensitivity должны сохранять ожидаемые результаты.
4. Добавить focused regressions для воспроизведённых случаев до исправления.
   Текущие 328 зелёных тестов не закрывают эти новые контрпримеры. Кандидат остаётся
   экспериментальным до собственного quality gate; его исправление не включает
   новую execution policy.

Приёмка A: требуемые regressions сначала демонстрируют дефект, затем проходят;
реальные PostgreSQL/Redis подтверждают границы writer/export/guard. Если меняются
контракты или source hashes, обновляются все affected readers, imports и rollback
floors. Exact-SHA CI и обычный scoped deploy обязательны для runtime-изменений.

### B. Измерить полезный охват и закончить эксплуатационную приёмку

Один frozen ledger должен связывать логический source revision со всеми исходами:
наблюдённый вход → scope/eligibility → accepted/rejected → complete/UNSURE/error →
policy permission → intent → собственный confirmed DELETE. Denominator входа
сохраняет unsupported/oversized/privacy/incomplete отдельно, чтобы ограничения
не улучшали охват простым исключением неудобных сообщений.

Считать отдельно уникальные сообщения, source revisions, model attempts и
физические удаления. KEEP, UNSURE, admission refusal, pending expiry, technical
failure и unknown effect не взаимозаменяемы. Для закрытой когорты все источники
должны иметь конечный исход или явный accounting gap. Process counters и
Redis-namespace counters не объединяются без границ времени и reset identity.

Добавить freshness и конечные readiness reasons для F9, а для F11 — штатный
закрытый pool harness на синтетических данных без MAX credentials/authority.
Он использует реальные bridge/worker/prompt/parser и finite deadline; проверяет
idle/busy disconnect, delayed answer, duplicate session, source edit и отключение
одного ПК. Timeout сохраняет uncertainty, а не освобождает физический lease.
Перезапуск Windows/автозапуск проверяется отдельно на каждом фактическом ПК.

Приёмка B: воспроизводимый frozen snapshot с полным accounting; event→decision
и event→verified-delete p50/p95/p99; useful completed decisions/s по узлам;
consultation no-capacity, pending expiry и drop reasons по bot/load class.
Сначала получить baseline на обычной и пиковой нагрузке, затем заморозить SLO
до изменения routing. Отсутствие наблюдений и тихие боты остаются отдельными gaps.

### C. Собрать независимую оценку качества

Использовать существующие review, sampling frame, quality reporter и приватный
diagnostic collector. Случайная выборка оценивает распространённость ошибок;
целевая выборка спорных/редких случаев помогает разработке, но не заменяет её.
Для каждого strata хранить вероятность включения; весовые population estimates
не подменяют независимые author/campaign units в текущем gate.

Зафиксировать минимум семь дней development, freeze и временной gap не меньше
24 часов, затем минимум семь дней независимого holdout. Между частями не должно
быть общих авторов, transitive campaign связей, edits, mirrors или near copies.
Соблюдать 14-дневную retention и экспортировать development evidence вовремя;
нельзя ждать окончания holdout и потерять его исходники. При недостатке независимых
единиц календарь продлевается, качество не объявляется по малой выборке.

Текущий AI reporter требует ≥4000 protected independent units, ≥500 offer units,
верхнюю Wilson 95% границу unsafe permission ≤0,1%, нижнюю границу offer eligibility
recall ≥95%; каждая required protected cohort также требует ≥4000 своих units.
До сбора оценить достижимость этого бюджета и заморозить cohort taxonomy.
Изменение статистического протокола — отдельное reviewed решение до просмотра
holdout; нельзя уменьшать требования после неудобного результата.

Добавить ограниченный случайный shadow audit отрицательных 4B (F6) с известной
sampling probability. Несогласие 4B/9B — сигнал для blind review, не автоматическая
истина или право удалить. Считать semantic classification, policy permission и
точный effect отдельно; модельные `UNSURE` сохранять даже при AI_REFERENCE оценке.

### D. Сравнить маршрутизацию и модельные варианты

На измеренных arrivals, model durations, доступности ПК и consultation outcomes
сначала выполнить существующую offline routing simulation. Сравнить текущий
latency rank с стоимостью всего решения, включая вероятность немедленной 9B
консультации. Проверить fairness между ботами, starvation обычных сообщений и
полезность `suspected_ad`. Prediction не становится proof; симуляция не включает
политику в production.

Затем сравнить на одинаковом frozen corpus действующие pinned 4B/9B, исправленный
deterministic candidate и компактный multilingual encoder/reranker. Для LLM
сравнить immutable prompt/model/quantization variants при одинаковой политике.
Выбирать по unsafe permissions, recall, risk/coverage curve, p95/p99, полезным
решениям в секунду и CPU/GPU/RAM cost. Empirical calibration допустима на отдельном
dev split; self-reported confidence не является вероятностью правильности.

Active learning помогает выбирать новые development примеры. Автоматические
labels, псевдоразметка и дообучение не попадают в независимый holdout и не меняют
production policy. LoRA/distillation оправданы только устойчивым классом ошибок;
обучение проводится вне общего production-хоста. Название более новой или более
крупной модели само по себе не доказывает улучшение.

Приёмка D: заранее frozen критерии и paired comparisons на независимых единицах;
shadow без effects, затем отдельный opt-in canary только прошедшего policy variant.
Сохраняются `confirm-positive`, исходные сроки и source/settings/generation guards.

### E. Устойчивость, длинные сообщения и минимальный контекст

Для F10 спроектировать durable generation-bound quarantine и reconciliation после
потери/восстановления Redis. Native fault tests должны моделировать живое старое
model generation, Redis crash и поздний ответ. Исчезнувший ключ не является
доказательством прекращения inference. Store rollout выполняется отдельно от
обычного API deploy и не затрагивает соседние проекты.

Для F12 измерить tokens точным tokenizer закреплённой модели с учётом system
prompt, template и output budget. Сравнить явный отказ и bounded clause windows
для длинных сообщений; нельзя молча обрезать хвост и утверждать полноту анализа.
Проверить mixed scripts, U+2061–U+206F, soft hyphen, combining marks, emoji,
скрытые разделители, цитаты и отрицания, bait «не реклама» и prompt injection.
Metamorphic пары должны сохранять ожидаемый смысл либо явно фиксировать его смену.

Thread/campaign context сначала оценивать в shadow. Передавать только необходимый
минимум, с consent/retention policy, точной revision и источником каждого фрагмента;
не загружать URL из сообщения и не давать модели инструменты. Старый или
отсутствующий контекст сохраняет UNSURE. Любое расширение входа меняет identity
и требует новой оценки privacy, latency, source completeness и качества.

### F. Изображения и другие типы после текстового gate

Commercial OCR остаётся retired/off. Отдельно сравнить Tesseract, multilingual OCR
и VLM на полных оригиналах, включая цены/контакты, image-only объявления, QR и
adversarial изображения. Проверить native isolation, timeout teardown, metadata,
memory и CPU budgets. OCR text не заменяет оригинал при независимой разметке.
Для QR применять локальное декодирование; переход по закодированному URL не нужен.
Photo edits, voice/video требуют своих source revisions, opt-in, полноты
транскрипции и отдельного quality gate. Старые commercial OCR readers не являются
разрешением вернуть прежнюю execution authority.

## Доставка и завершение каждого этапа

Поэтапный результат содержит: конкретный изменённый контракт, focused cases,
нужное native evidence, impact-selected aggregate, exact-SHA `Required` и
`Analyze JavaScript and TypeScript`, обычный affected deploy и один свежий
identity/availability readback. Shared API changes выпускают все роли и auxiliaries;
stores не пересоздаются. Финальное окно качества/мониторинга начинается после
готовности остальных gates и не включает пропущенные наблюдения.

Остановить canary при потере source binding, устаревшем состоянии, необъяснённом
accounting gap или нарушении frozen safety criteria. Откат — совместимая политика
и immutable release по штатному runbook; неизвестные effects, held leases и
действующие bot assignments сохраняются. Очереди, Redis и fences не очищаются.

Реализация этапа A исправляет F1–F3 и расширяет integration reference. Focused
regressions и native PostgreSQL/Redis подтверждают новые границы данных; выпуск
требует итоговых проверок, exact-SHA CI и штатного deploy. Независимая accuracy-приёмка
и следующие этапы остаются открытыми; модель и execution policy не менялись.
