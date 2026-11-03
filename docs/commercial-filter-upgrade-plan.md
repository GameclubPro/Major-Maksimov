# Commercial Filter Upgrade Plan

Дата ревизии: 2026-10-01.

Актуальная проверка исходников, воспроизводимые оставшиеся дефекты и приоритетный
план развития: [аудит от 1 октября 2026](commercial-filter-audit-and-plan-2026-10-01.md).
Реализация октября: исправлены покупательские запросы, отрицания, жалобы,
скрытые самостоятельные предложения, смешанная кириллица/латиница и контакты.
Новые правила и временные окна кампаний входят в работающий основной фильтр.
Реклама на фото использует активную строгую проверку: два распознавания,
сильные признаки предложения, повторная проверка сообщения, настроек и прав автора.
Режим наблюдения не является продуктовым режимом этой поставки.

Настройки сохраняются по разделам с защитой от перезаписи чужих изменений.
Объяснения и предупреждения коммерческого фильтра и фильтра мата разделены;
интерфейс показывает фактическое наказание и доступность проверки фото.
Закрытая очередь оценки качества хранится отдельно от репутации участников.

Удаления и наказания привязаны к свежему разрешению; отключение фильтра,
изменение прав/иммунитета или общей политики прекращает ожидающее действие.
Иммунитет учитывается один раз на сообщение, включая фото, повторы и правки.
Добавлены ограниченный кеш полного решения и настоящие скользящие окна Redis.

Доказательства и границы оценки: [контракт качества](commercial-filter-quality-evidence.md).
Независимая разметка нужна для будущего расширения экспериментальных правил;
автоматические метки и локальные примеры не объявляются такой разметкой.
Обучаемая вторая стадия остаётся условным продолжением после доказанного выигрыша
на отдельной выборке, а не обязательной зависимостью работающего фильтра.

Ниже сохранена история реализованных улучшений и прежних исследований.

Актуальный аудит трёх production-срезов 10-11 сентября и следующий план работ:
[проверка реальных данных от 12 сентября 2026](https://github.com/GameclubPro/Major-Maksimov/blob/5876cfcd0987d86badc3c188d62050f12c8674ba/docs/operations/archive/commercial-filter-audit-2026-09-12.md).
Он фиксирует ошибки ownership, дрейф обезличивания и критерии безопасности удаления;
исторические метрики ниже не заменяют независимую оценку текущей версии.

## September 18: Service Intent Corrections

The incumbent deterministic detector advances to `commercial-deterministic-v4`.
Sensitivity thresholds and the second-stage scoring weights are unchanged. The
correction uses assertion-scoped request, testimonial and refusal roles in the
existing local-context resolver, not a whole-message keyword allowlist. Qualified
provider offers, paid rhetorical service cards, recruitment and separate offers
before/after protected speech retain their existing policy.

Bounded offer recognition covers furniture restoration, well maintenance, tool
sharpening, made-to-order cakes and noun-first 3D-printing offers. Each addition
requires independent offer/transaction/contact evidence and retains the existing
WARN cap; WARN still means cleanup eligibility, not a new sanction tier. Local
analysis exposes completeness before quote grouping, so truncated text or an
assertion limit cannot silently certify a safe context.

### Measured Regression Results

Baseline behavior: `f201e032`, with the pending guard implementation but unchanged
v3 detector logic. The 52-case development set was frozen before detector edits:
32 initial examples and 20 paired counterexamples, comprising 29 negatives and
23 explicit offers. At BALANCED 45/65, using the original synthetic phone forms:

| Set                    | Cases | False Cleanup Before | After | Missed Offers Before | After |
| ---------------------- | ----: | -------------------: | ----: | -------------------: | ----: |
| Initial examples       |    32 |                    8 |     0 |                    3 |     0 |
| Paired counterexamples |    20 |                    4 |     0 |                    2 |     0 |
| Total                  |    52 |                   12 |     0 |                    5 |     0 |

The fixtures live in `apps/api/src/moderation/commercial-intent.fixture.ts`, SHA-256
`1fd9311f59748052a9db358ecd3d8c094230b18119e4aab2d9824767c2d8e4aa`.
Tests additionally check STRICT 38/55, phone placeholders, greetings, mixed
statements, campaign repetition and incomplete analysis. These generated variants
are not independent observations and are not counted as extra quality samples.

Historical replay retained all 1,895 action decisions, with the frozen transport
adjudication enabled. Baseline and candidate result JSONL SHA-256 both equal
`7752efe8f922c1f2a9d558966151cff93139ce59b5dde97b1c5869928965bcaa`.
This is regression parity, not proof of perfect historical labels: existing band
comparison remains 741 exact, 205 under, 1 over and 948 unspecified. Band mismatch
is not the same as an incorrect cleanup decision. Historical labels were not
rewritten to make the result look better.

The development set is deliberately targeted, not a representative production
sample or independent holdout. No population-wide precision/recall or measured
"times fewer errors" claim follows from these results. Independent temporal
annotation and any learned-model/global shadow-canary rollout remain separate;
Commercial OCR is not promoted by this release.

Before local TSX corpus replays, regenerate the checked-in detector source identity
with `node scripts/generate-commercial-ocr-detector-source.mjs`; the provenance
records the generated runtime identity. Source identities for the final comparison:
baseline `6cb51f4f4df5541c3a796a3c9d190fb472840449d91dd518e1a38dc0cffbbed4`,
candidate `ed918015ee1b0a6bc166f6fb9c53b29e61d42c149a9e9a0bf64a5556d009d553`.

## September 17: Guarded Deletion

Commercial text now has a mandatory current-message guard in durable dispatch and
immediate legacy compatibility. Each edit receives a versioned reason key bound
to text SHA-256, relevant filter/sanction settings, detector identity, event time
and a five-minute deadline. Older revisions cannot override the latest event.
Legacy reasons are checked without unbound historical campaign counters.

Current author access, exact message identity, participant immunity and final
settings/deadline are verified before each remote DELETE. A confirmed deletion
provides ephemeral proof for specific reason keys; another revision, exact absence,
pending work or recovered success cannot add a commercial strike or reputation
observation. Events are attributed only to the reasons verified by that attempt.
Concurrent/new reasons are fenced against obsolete terminal rejection; fresh bound
revisions can reopen expired work without reviving ambiguous dispatches.

Both API rollback paths now require the commercial text guard capability. See
[the commercial deletion runbook](operations/runbooks/commercial-text-delete-guard.md).
Delayed legacy actions cannot preserve a transport callback and must use the
durable executor. This release changes deletion safety, not classification weights,
sensitivity settings or OCR promotion. Global shadow/canary policy control and
independent holdout collection are still separate follow-up work.

## September 17: Correctness Foundation

This delivery implements the verified correctness prerequisites, not the full
quality/policy rollout. Existing sensitivity thresholds and action bands remain
unchanged; Commercial OCR is not promoted.

- The second-stage cache hashes its complete typed input, including raw assertion
  layout, signals, review context and unrounded numeric values. Cached arrays are
  isolated from caller mutation. Cold/warm and forward/reverse-order regression
  tests cover the positive/negative fixtures under BALANCED and STRICT settings.
- The scorer uses the shared phone parser and counts distinct canonical contacts.
  National/international formatting and line/slash separators must not change
  repeated-contact evidence; repeating one contact does not add that evidence.
- Decisions explicitly expose `messageDisposition: KEEP | DELETE`. Legacy records
  without the field retain existing band semantics, including WARN cleanup.
  Explicit KEEP or an invalid disposition cannot create cleanup, strikes or user
  sanctions and cannot mask another actionable violation. `deleteSuppressed`
  remains legacy band-suppression metadata, not a deletion permission.
- Rule-engine metadata, audit snapshots, cleanup summaries and replay equivalence
  carry the disposition. KEEP-to-DELETE is a material replay difference even with
  an unchanged action band. Replay rejects malformed or inconsistent dispositions.
- Decision/classifier versions advance to `commercial-deterministic-v3` and
  `2026-service-private-v5`; historical fixtures are not relabeled or rewritten.

Remaining release work, deliberately not represented as completed:

1. Collect an independently double-adjudicated temporal holdout, with campaign
   grouping and sampling probabilities. Existing automatic labels and these
   deterministic regression tests do not establish population precision/recall.
2. Assertion-scoped service speech acts and bounded recall corrections are delivered
   above. Evaluate remaining contexts and mixed-language errors on the independent
   holdout before further widening recognition. Do not lower thresholds globally
   to compensate for missing context.
3. Pending-intent binding, current-message guard and compatible rollback floor are
   delivered by Guarded Deletion above. Before activating a new text-policy
   authority, add its shared shadow/canary control and global execution-time kill
   switch; current per-chat settings checks are not that rollout mechanism.
4. Profile real cache misses, normalization and Redis work before further hot-path
   optimization. Evaluate a calibrated local learned second stage offline only
   after the corrected deterministic baseline and independent holdout are frozen.

No new chat settings, external model calls, schema migrations or automatic policy
promotion are introduced by this foundation release.

## September Implementation: Scoped Corrections

The first implementation preserves chat settings, thresholds, the meaning of `WARN`,
and the existing sanctions/delete-intent contracts. It adds:

- shared phone spans and canonical numbers for detection, corpus redaction, and
  campaign contact extraction, including `24/7` and slash-separated contacts;
- protection for transport requests, completed personal service recommendations,
  used household items and individual used vehicle parts;
- bounded construction/PPU and professional crop-procurement recognition, without
  treating a service-quality slogan as a private-sale statement;
- `policyFpRisk` in audit/replay snapshots, with the legacy `fpRisk` fallback;
- phone-placeholder parity for the affected short-service/high-risk cases and an
  independent conservative residual-contact check for quality validation.

Use `--quality-gate` on `moderation:validate-commercial-corpus` to require trusted
manual positive/negative/gray counts using the configured corpus minimums. Automatic
labels cannot satisfy these minimums; unresolved automatic sanitization drift and
residual contact candidates fail this mode. Structural validation without the new
flag remains compatible. This gate is not proof of independent sampling or population
precision; labels, duplicate grouping, and temporal separation still need review.

Pre-release comparison used the same sanitized inputs and settings for both versions:

- July manual overlay: all 1,895 action decisions retained against source
  `749907d0cd38956549ab25770f1f267ba9292fa2`; historical recommendations were not relabeled.
- September 11, 12:00-14:00 UTC: 5,097 events replayed; nine `WARN -> NONE` transitions
  covered four service testimonials, three personal juicer listings, and two transport
  requests. Seventy-nine `NONE -> WARN` transitions concern phone-placeholder service
  recognition, not 79 new production deletions. Four of those taxi events had original
  `REVIEW_ONLY` snapshots; the other 75 already had original `WARN` snapshots.
- September 11, 20:00-22:00 UTC: all 1,348 sanitized replay decisions retained.
- September 11, 18:00-20:00 UTC: 2,963 events replayed; the personal vehicle-part
  listing loses cleanup eligibility, and 13 explicit-offer instances gain it
  (construction, road works, PPU, recurring vehicle buyout, crop procurement).
  Three additional taxi-placeholder transitions include two original `WARN`
  snapshots and one original `REVIEW_ONLY` snapshot.

The benchmark action snapshot changes only for the already-positive construction
brigade fixture: `REVIEW_ONLY -> WARN`. Its original text and label are retained;
negative cases, subtype counts, and high-risk action counts remain unchanged.

These are regression comparisons, not raw-input population quality claims. Original
and sanitized snapshots must remain distinct; no MAX deletion receipt was verified.
Unreviewed language-specific vocabulary and general URL-placeholder parity are not
expanded in this release. Commercial OCR remains under its independent shadow gates.

## September Audit And Runtime Contract

Implementation revision: 2026-09-08. The July measurements below are historical,
not quality claims for the current detector.

- `WARN` is eligible for message cleanup in the moderation runtime. User warnings,
  mutes, and bans follow the separate text-filter escalation ladder. Audit category
  counters named `delete_*` count only `DELETE` and `DELETE_AND_ESCALATE`; use
  `messageDeleteEligible` / `message_delete_eligible` for projected cleanup.
  `executionVerified: false` means the audit did not verify MAX deletion receipts.
- The detector and corpus sanitizer share the bounded phone parser. Phone labels
  and line boundaries separate complete contacts; identifier and long-number
  guards remain in effect. New audit exports preserve assertion layout.
- Corpus rows expose `sanitizationParity` beside original `current` and recomputed
  `sanitizedBaseline` snapshots. Replacement tokens are not semantically identical
  to real contacts. Drifted auto-label rows are excluded from automatic quality
  metrics; new quality runs must use `--require-sanitization-parity` and independently
  review drifted rows. Historical corpora retain their labels and explicit diagnostics.
- The September recall additions require a first-person multi-service catalog with
  contact evidence, or a named bulk crop with tonnage, VAT, dispatch, supplier offer,
  and contact evidence. They do not lower global sensitivity thresholds.
- Do not automatically restore the July warning labels for ambiguous single-vehicle,
  small private inventory, or short resale texts. Review the product context first.
  A `WARN` to `DELETE` category change alone is not a change in message cleanup.
- Keep held-out evaluation temporally separate from development examples and group
  duplicate campaigns together. Manually assess both hit and non-hit samples;
  auto labels and repeated copies cannot establish population precision or recall.
- Run the performance wrapper locally with the explicit CI threshold profile:
  `COMMERCIAL_BENCHMARK_PROFILE=github-hosted npm run test:api:commercial-benchmark:ci`.
  It compares three fresh local processes against CI limits, not GitHub hardware.

For a bounded production audit, split large windows into sequential non-overlapping
time slices, retain the `--page-size 250 --current-only --sample 0` controls, and
check readiness between slices. Do not extend query timeouts to force a full-day
scan to finish. Deduplicate shared inclusive time-boundary events by fingerprint.
Commercial OCR promotion remains outside this text-filter rollout.

Документ описывает практический план дальнейшего апгрейда commercial ad filter после точечных runtime-исправлений по 48h-аудиту. Цель: поднять precision на safe-context сообщениях, сохранить recall по явной коммерции и сделать каждую блокировку объяснимой для аудита.

## Scope

Зона фильтра:

- `apps/api/src/moderation/commercial/`
- `apps/api/src/moderation/commercial-benchmark.spec.ts`
- `apps/api/src/moderation/commercial-corpus-fixture.spec.ts`
- `apps/api/src/scripts/audit-commercial-filter.ts`
- `apps/api/src/scripts/validate-commercial-corpus.ts`
- `apps/api/src/moderation/commercial-corpus.fixture.jsonl`

Ключевые safe-context классы для апгрейда:

- обсуждение рекламы как темы;
- жалобы на спам и мошенников;
- правила чата и модерационные инструкции;
- новости, аналитика, предупреждения, обзоры рынка;
- личные разовые продажи без коммерческого CTA;
- упоминания брендов и маркетплейсов без оффера;
- обычные вакансии, обучение, муниципальная/социальная помощь.

## 48h Audit Loop

1. Выгрузить 48 часов кандидатов на VPS из `api-admin`:

```bash
SINCE="${SINCE:?Set SINCE to the audit window start in ISO-8601}"
UNTIL="${UNTIL:?Set UNTIL to the audit window end in ISO-8601}"
docker compose -p infra -f infra/docker-compose.yml exec -T api-admin \
  node apps/api/dist/apps/api/src/scripts/audit-commercial-filter.js \
  --since "$SINCE" \
  --until "$UNTIL" \
  --limit all \
  --page-size 500 \
  --current-only \
  --sample 0 \
  --export-jsonl /tmp/commercial-audit-48h.jsonl \
  --export-corpus-jsonl /tmp/commercial-corpus-48h.jsonl \
  --export-all-corpus
```

`--limit all` всегда используется вместе с `--page-size`. Обычный production-аудит
запускается с `--current-only`: историческое сопоставление `COMMERCIAL_AD` по
`chat_id/message_id` допускается только после отдельной проверенной миграции с
частичным индексом `(chat_id, message_id, created_at, id)`.

Для shadow-проверки всех чатов, включая те, где фильтр выключен, добавлять
`--shadow-all-chats`. Этот режим только принудительно включает commercial
settings внутри audit pass и не меняет runtime-настройки чатов.

2. Разобрать выборку по `policyCategory`, `segment`, `current.actionBand`, `current.reasonCodes`, `current.matchedSignals`, `current.negativeSignals`.
3. Отдельно разметить buckets:
   - `rules_or_moderation_context`;
   - `spam_complaint_or_fraud_warning`;
   - `news_or_analytics`;
   - `brand_mention_only`;
   - `private_one_off_sale`;
   - `ordinary_recruitment`;
   - `public_training_or_help`;
   - `true_commercial`.
4. Для каждого false-positive кандидата сохранить минимальный sanitized текст, expected action, expected subtype, current signals и желаемый suppressor/threshold.
5. Повторить audit после каждого изменения фильтра на новом 48h окне и на frozen corpus.

## Final July 48h Audit Slice

Frozen window: `2026-07-21T11:20:41Z..2026-07-23T11:20:41Z`.

- sanitized corpus: `49 719` records, SHA-256
  `eaaaac22bc5ae3deaf81f090fda7bfc8717c217f7ea963666333719f5151de80`;
- manual overlay: `1 895` records, SHA-256
  `d7cce5ebe802eb049bddd449e800ef784ce08893f27dd76f1f03b10e1fd5d2b3`;
- transport action adjudication: `121` hashes / `214` instances, SHA-256
  `21fab2ddb0dc3ac0276f97c48d716e01a5821cde52edc0c475c497e5313c020d`.

Every corpus record was replayed. Manual review covered the curated UNDER,
transport, severe-transition, and final action-delta sets; this is not a claim
that all `49 719` message texts were read manually.

Final v12 provenance:

- detector source SHA-256
  `f64de731bf6e6150a13e88f489595ce9b29ba4900528965af28d12d7e86f04be`;
- evaluation result SHA-256
  `fea7b4bf6ddb64521988f5485f4bd9dacb5a198a6e6d693203ca5d7d1296de5c`;
- full replay diff SHA-256
  `432efe4735e890b6d5a1cbce386f7686851d45fd345d5fd64baa51ff3adaa4e6`.

Manual overlay result:

- actions: `NONE 1080`, `REVIEW_ONLY 163`, `WARN 577`, `DELETE 1`,
  `DELETE_AND_ESCALATE 74`;
- recommendation comparison: `exact 748`, `under 199`, `over 0`,
  `unspecified 948`;
- actionable UNDER gate: `153/153` hashes and `374/374` source instances;
- protected conservative/ambiguous gate: `108/108` hashes and `195/195`
  source instances;
- the c31 guard remains `REVIEW_ONLY` for all `6/6` current instances;
- all transport adjudication rows match their reviewed actions exactly.

The remaining `199` UNDER instances are the protected ambiguous/conservative
set plus four additional c31 duplicates. There are no unresolved actionable
misses and no action above a manual recommendation.

Final-slice corrections include:

- safe-context and action-policy separation for rules, warnings, public help,
  ordinary requests, private goods/property, and real commercial offers;
- bounded recall for professional retail, property cards, local services,
  recruitment, transport, tours, groups, and recurring buyout offers;
- removal of false positives from private vehicles, one-property listings,
  furnished rentals, personal goods, aid appeals, scam warnings, and editorial
  text;
- restoration of multi-lot land inventory, structured construction offers,
  appliance repair, professional property cards, and custom-forged goods;
- mandatory conservative caps where the reviewed release policy is `WARN` or
  `REVIEW_ONLY`, without increasing furniture, fragrance, rental, or vacancy
  enforcement severity during this release.

The v10-to-v12 regex-lint and SHA-256 cache-key hardening produced
byte-identical evaluation and replay JSONL outputs. Compared with the reviewed
v6 severe set, v12 adds only the explicitly accepted Rostelecom corporate
offer. The private furnished rental is restored to `REVIEW_ONLY`, and the
turnkey construction campaign is capped at `WARN`.

The final GitHub-hosted benchmark profile passed all three fresh-process runs.
Median timings were hot p95/p99 `5.298/5.602 ms` and adversarial p95/p99
`57.318/58.139 ms`, below the `10.500/10.750 ms` and `127/128 ms` gates.

## Previous June 48h Audit Baseline

Окно `2026-06-19T02:23:02Z..2026-06-21T02:23:02Z`, prod
`api-admin`, `--limit all --sample 0`, enabled-chats scope:

- candidates: `41245`;
- evaluated after bot/admin/service skips: `31694`;
- skipped: `9551`;
- stable hit: `1784`;
- current only: `1963`;
- historical only: `10`;
- dangerous action counters: `delete_false_positive_candidates=0`,
  `gray_delete_candidates=0`, `campaign_only_delete_candidates=0`.

Fresh corrections from this slice:

- structured service+phone rescue for explicit local services stays
  `REVIEW_ONLY`, not delete: yard mowing, stretch ceilings, appliance repair;
- narrow goods-retail recall for honeysuckle/berry price tables, brick rubble
  delivery by KamAZ/application wording, and home broiler price messages;
- property-private suppressor boundary now treats `домашних` as poultry/goods
  wording, not as `дом` real-estate context;
- new audit option `--shadow-all-chats` allows running the same detector across
  chats where the commercial filter is disabled, without changing runtime state;
- ambiguous short service/private-sale leftovers remain intentionally narrow
  until there is product, contact, inventory, campaign, or repeat-context
  evidence.

Local frozen-corpus validation against
`artifacts/commercial-audit/current/commercial-48h-corpus-20260621T022302Z.jsonl`
passed with hard recall `0.9992`, false-positive rate `0`, and subtype accuracy
`1.0`. This validates the exported corpus snapshots; a true recalculation with
the new detector requires running the deployed code against prod data.

## Previous 24h Baseline

Окно `2026-06-14T17:13:57Z..2026-06-15T17:13:57Z`, prod `api-admin`,
`--limit all`, aggregate summary plus sanitized miss extraction:

- candidates: `18655`;
- evaluated after bot/admin/service skips: `13999`;
- stable clear: `11923`;
- stable hit: `910`;
- current only: `1160`;
- historical only: `6`;
- dangerous action counters: `delete_false_positive_candidates=0`,
  `gray_delete_candidates=0`, `campaign_only_delete_candidates=0`.

This slice fixed or pinned regressions for:

- short goods/plant misses: unit-price flowers and herbs are retail candidates,
  while low-quantity private plant giveaways stay allowed;
- new high-risk recall/precision guards: debt-relief leadgen, paid marketplace
  reviews, survey/referral payouts, app directory promo, bulk leadgen, paid
  channel placement, and their discussion/complaint false-positive neighbors;
- historical-only-style misses: bulk material sale, MAX/MAH reply CTA contact,
  service/produce audit cases already covered locally;
- false-positive suppressors: local news subscribe channel, public/library
  master-class signup, currency-rate news;
- private seedling leftovers: small leftover/self-pickup listings stay allowed,
  while structured nursery clearance stock remains commercial;
- second-stage cache key: include sensitivity and rounded strictness.

Second post-deploy audit window
`2026-06-14T17:39:27Z..2026-06-15T17:39:27Z`, prod `api-admin`,
`--limit all --sample 0`, confirmed the main safety gate:

- candidates: `18550`;
- evaluated after skips: `13926`;
- stable clear: `11850`;
- stable hit: `915`;
- current only: `1157`;
- historical only: `4`;
- delete false positives, gray deletes, and campaign-only deletes: all `0`.

Remaining hard cases should stay narrow:

- `400р.кг + phone` must not become a generic unit-price-plus-phone rule until
  a product noun or repeated product context is available.
- Short cargo service and channel self-promo coverage should be pinned with
  regressions before adding duplicate rules.
- Beauty/hair salon ads should require a procedure plus contact/address anchor,
  not a bare `salon` marker.

Third hardening pass after 6-agent review added two safety layers:

- precision guards for civic voting without payment, marketplace buyer
  complaints with support/help links, and training/recap discussions about
  client search;
- narrow recall for structured phone-service ads: print/copy, tool rental,
  locksmith, well drilling, and sewer cleaning. Each requires domain wording
  plus a direct contact/address/price/work anchor and remains review-only under
  soft balanced thresholds;
- paid social-action tasks now include paid votes/likes/reactions, while
  `без оплаты` civic voting stays a hard negative;
- hot-path perf hardening: process-level commercial detector warm-up for known
  expensive service-phone paths and skipping duplicate raw regex passes when raw
  and normalized marker texts are identical.

The remaining productless shorthand `400р.кг + phone` is intentionally pinned as
`null` in regression tests until a product noun or repeated product context is
available.

Do not interpret every `safeContextBucket` hit as a false positive. The 48h
audit showed wide buckets such as `news_or_analytics` and
`private_one_off_sale` can contain true ads because the bucket classifier is a
triage heuristic, not a labeler. Use sanitized samples plus matched signals and
action evidence before adding broad suppressors.

Локальные команды:

```bash
SINCE="${SINCE:?Set SINCE to the audit window start in ISO-8601}"
UNTIL="${UNTIL:?Set UNTIL to the audit window end in ISO-8601}"
npm run moderation:audit-commercial --workspace @maxim/api -- \
  --since "$SINCE" --until "$UNTIL" --limit all --page-size 250 --current-only \
  --export-corpus-jsonl src/moderation/commercial-corpus.next.jsonl \
  --export-all-corpus

npm run moderation:audit-commercial --workspace @maxim/api -- \
  --since "$SINCE" --until "$UNTIL" --limit all --page-size 250 --current-only --shadow-all-chats \
  --export-corpus-jsonl src/moderation/commercial-corpus.shadow.jsonl \
  --export-all-corpus

npm run moderation:validate-commercial-corpus --workspace @maxim/api -- \
  --input src/moderation/commercial-corpus.next.jsonl --require-sanitization-parity
```

## Corpus Gates

Базовые gates уже заданы в `validate-commercial-corpus.ts`:

- positive candidates >= 1000;
- negative candidates >= 5000;
- gray candidates >= 500;
- hard recall >= 0.98;
- false-positive rate <= 0.001;
- subtype accuracy >= 0.93.

Добавить целевые gates для апгрейда:

- delete false positives: `0`;
- hard-negative action must be `ALLOW`, not only non-delete;
- safe-context FP rate by bucket <= `0.001`, and `rules_or_moderation_context` must be `0`;
- campaign-only detections cannot escalate to delete without non-campaign direct-deal evidence;
- `REVIEW_ONLY` is acceptable only for explicitly gray samples, not hard negatives;
- every `DELETE` / `DELETE_AND_ESCALATE` must include direct deal, high-risk, or escalation-grade evidence in reason codes.

Regression coverage:

- Add safe-context cases to `commercial-patterns.regression.spec.ts`.
- Keep broad confusion matrix in `commercial-benchmark.spec.ts`.
- Keep JSONL structure and metric validation in `commercial-corpus-fixture.spec.ts`.
- Snapshot top false-positive signals so new broad patterns are visible in review.

## Suppressor And Threshold Work

Implement suppressors as explicit negative contexts before changing global weights.

P0 suppressors:

- `chat-rules-commercial-ban`: rules copy that enumerates banned ads, prices, phones, casino, jobs, links. Hard-negative when wording includes `правила`, `запрещено`, `удаляем`, `бан`, `модерация`, `жалобы`.
- `spam-complaint`: user complaint about spam, scammers, casino, links, or repeated ads. Hard-negative when speaker asks admins/bot to remove or warns others.
- `news-marketplace-brand`: news or analytics about marketplace discounts, banks, apps, brands, crypto, real estate, jobs, without CTA. Suppress high-risk marketplace/bonus patterns unless there is direct offer language.
- `public-warning`: official/public warning about fraud, benefits, loans, crypto, gambling links. Existing civic/fraud patterns should be widened and tested.
- `public-help-training`: employment center, school, municipal course, free training/help announcements without contact-for-sale or leadgen.
- `ordinary-recruitment-softener`: ordinary local jobs should not delete by default. Keep detection if enabled, but cap to `WARN` unless there is high-risk remote-income, referral, paid-review, registration, deposit, or multi-chat campaign evidence.
- `brand-mention-only`: brand or marketplace mention with complaint/review/question language should not create commercial context by itself.

Threshold ideas:

- Raise delete threshold for `RECRUITMENT` unless evidence includes phone/link plus strong offer marker or high-risk pattern.
- Cap `GOODS` generic subtype to `WARN` / `REVIEW_ONLY` when fpRisk is elevated by `context:*`.
- Require two independent direct-deal anchors for high-risk generic delete when text also matches news/rules/warning context.
- Keep private one-off goods/property suppressors as hard exits unless business, inventory, campaign, or channel-placement evidence overrides them.

## Explainability

Every commercial hit should expose:

- `decisionVersion`;
- `score` and raw `confidenceScore`;
- `actionBand`;
- `primarySubtype` and supporting subtypes;
- `evidenceTier`;
- `fpRisk`;
- `matchedSignals`;
- `negativeSignals`;
- `reasonCodes`;
- classifier probabilities and review reasons when second stage ran.

Upgrade requirements:

- Add reason codes for suppressor classes, even when final action is allow in audit output.
- Split explainability into commercial evidence, safe-context evidence, and action policy.
- In audit JSONL, include `suppressedBy` / `suppressionClass` for current-only false-positive analysis.
- Make docs and admin diagnostics distinguish `commercial candidate`, `review-only`, `warnable`, and `deletable`.

## Rollout And Deploy

Recommended rollout:

1. Land corpus-only additions and benchmark expectations first.
2. Add suppressors and threshold caps behind deterministic tests.
3. Run local validation:

```bash
npm test --workspace @maxim/api -- commercial-patterns.regression.spec.ts
npm test --workspace @maxim/api -- commercial-benchmark.spec.ts
npm test --workspace @maxim/api -- commercial-corpus-fixture.spec.ts
npm run typecheck --workspace @maxim/api
```

4. Export a fresh 24h corpus from prod and validate locally.
5. Deploy API roles only after gates pass.
6. Recreate all shared API image roles because moderation runtime uses the shared API image:
   `api-ingress`, `api-admin`, `api-enqueue`, moderation roles, and `api-action`.
7. After deploy, check live/ready health and run a read-only 24h audit window.

Rollback:

- If delete false positives appear, rollback runtime to the last good git ref.
- If only warn/review drift appears, disable strict settings per affected chat while preparing a follow-up patch.

## Monitoring

Track daily:

- total commercial hits;
- action distribution: `ALLOW`, `REVIEW_ONLY`, `WARN`, `DELETE`, `DELETE_AND_ESCALATE`;
- subtype distribution;
- top matched signals;
- top negative signals;
- top reason codes;
- delete count by subtype and chat;
- false-positive samples by safe-context bucket;
- hard-negative hit rate;
- campaign-only hit/delete rate;
- second-stage probability bands.
- audit detect-time p95/p99 and top slow sanitized records;
- duplicate-precheck timing, because it can run a second commercial spam scan.

Alerts:

- any hard-negative sample with delete action;
- spike in `GOODS` generic delete;
- spike in `RECRUITMENT` delete without high-risk reason;
- spike in `risk:marketplace-seller`, `risk:betting-gambling`, or `transaction:high-risk-offer` paired with rules/news context;
- sudden drop in recall on hard positives.

## Next Architecture

Move from one monolithic deterministic score to a staged decision pipeline:

1. `Normalizer`: text, URLs, phones, handles, markdown/markup.
2. `CommercialSignalExtractor`: positive commercial evidence only.
3. `SafeContextExtractor`: rules, complaints, news, public warnings, private sale, search/help/job-seeking contexts.
4. `SubtypeClassifier`: subtype and required anchors.
5. `EvidenceResolver`: direct deal, campaign, high-risk, structured, safe-context evidence.
6. `ActionPolicy`: action cap/delete decision from explicit evidence tiers and fpRisk.
7. `Explainer`: stable reason codes and audit metadata.

Extraction boundaries should keep current facades:

- public detector entry: `commercial-ad.detector.ts`;
- patterns: `commercial-patterns.ts`;
- suppressor classification: `commercial-suppressors.ts`;
- scoring and second stage: `commercial-scorer.ts`;
- action decision: `commercial-action-policy.ts`;
- explanation metadata: `commercial-explain.ts`.

Longer-term options:

- maintain a small curated safe-context corpus separate from broad production JSONL;
- add a shadow-all-chats daily sample so disabled-chat misses are measured before
  changing defaults or recommending chat-level enablement;
- add perf guards for near-misses around the widest commercial regex patterns
  and keep cold-start/warm-up coverage in `commercial-benchmark.spec.ts`;
- add per-chat calibration profiles only after global suppressors stabilize;
- add offline benchmark reports to CI artifacts;
- consider a learned second-stage model only after deterministic explainability is stable and corpus labels are high quality.

## Done Criteria

- 48h audit loop is repeatable locally and on VPS.
- Corpus gates pass with no delete false positives.
- Safe-context buckets are represented in regression tests.
- Every delete action has understandable direct/high-risk evidence.
- Monitoring can show which pattern or suppressor caused a decision.
- Rollback path is documented and tested through existing runtime rollback wrapper.
