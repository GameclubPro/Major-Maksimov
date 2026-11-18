import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { safetyDeskOverviewResponseSchema } from '../../../packages/contracts/src/safety-desk-overview.ts';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { createAdminApiTransport } from '../src/admin-request';
import { RuntimeOverviewSnapshot, historyChartPath } from '../src/runtime-overview-desk';
import { overviewBotStatus, overviewStatus } from '../src/runtime-overview-state';
import { ObservabilityDesk } from '../src/observability-desk';
import { overviewFixture, overviewTimingGapFixture } from './runtime-overview-fixture';

const now = Date.parse('2026-11-04T03:00:00.000Z');
const render = (snapshot = overviewFixture(now)) =>
  renderToStaticMarkup(createElement(RuntimeOverviewSnapshot, { snapshot, now }));

test('default observations opens the overview and leaves detailed cohorts lazy', () => {
  const html = renderToStaticMarkup(createElement(ObservabilityDesk, { refreshToken: 0 }));
  assert.match(html, /aria-label="Боты и очереди"/);
  assert.match(html, /Читаю сохранённые наблюдения/);
  assert.doesNotMatch(html, /aria-label="Результаты обработки событий"/);
});

test('a good completed p95 cannot hide an old incoming receipt or incomplete coverage', () => {
  const snapshot = overviewFixture(now);
  assert.equal(snapshot.actions.value?.latency.p95Ms, 800);
  assert.equal(overviewStatus(snapshot, now, false).tone, 'danger');
  const html = render(snapshot);
  assert.match(html, /Требует внимания/);
  assert.match(html, /≥ 64/);
  assert.match(html, /Без изменения состояния/);
  assert.match(html, /Нижняя граница: выборка ограничена/);
  assert.match(html, /Исход неизвестен/);
  assert.match(html, /Сохранено: завершено/);
  assert.match(html, /Результатов в минуту/);
  assert.match(html, /Среднее за 15 минут, включая ошибки и неизвестные исходы/);
  assert.match(html, /runtime-distribution__bar/);
  assert.doesNotMatch(html, /role="progressbar"|NaN|Infinity/);
});

test('old unfinished work requires review without being reported as delivery latency', () => {
  const snapshot = overviewFixture(now);
  const bot = snapshot.bots[0]!;
  snapshot.bots = [bot];
  snapshot.receipts.value = { ...bot.pendingReceipts.value! };
  const setUnfinished = (oldestAgeMs: number, sampleComplete = true) => {
    bot.unfinishedActions.value = {
      countLowerBound: 1,
      sampleComplete,
      oldestAgeMs,
      ageBasis: 'state_updated_sample',
    };
    snapshot.unfinishedActions.value = { ...bot.unfinishedActions.value };
  };
  setUnfinished(30_000);
  assert.equal(overviewBotStatus(bot, now).tone, 'success');
  assert.equal(overviewStatus(snapshot, now, false).tone, 'success');

  for (const [age, complete] of [
    [30_001, true],
    [602_000, false],
  ] as const) {
    setUnfinished(age, complete);
    const html = render(safetyDeskOverviewResponseSchema.parse(snapshot));
    assert.match(html, /Проверьте незавершённые действия/);
    assert.match(html, /Требуют внимания: <strong>1 из 1/);
    assert.match(html, /runtime-tone--neutral"><h3>Незавершённые действия/);
    assert.match(html, /Может включать запланированные действия и повторные попытки/);
    assert.doesNotMatch(html, /runtime-tone--danger|Долгое ожидание|Есть задержка/);
  }
  bot.unfinishedActions.value = {
    ...bot.unfinishedActions.value!,
    countLowerBound: 0,
    oldestAgeMs: null,
    sampleComplete: true,
  };
  assert.match(render(snapshot), /Требуют внимания: <strong>0 из 1/);
  assert.equal(overviewStatus(snapshot, now, false).label, 'Проверьте незавершённые действия');
});

test('a fresh measured delay stays visible when unfinished coverage is incomplete', () => {
  const snapshot = overviewFixture(now);
  const bot = snapshot.bots[1]!;
  snapshot.bots = [bot];
  snapshot.queues = { availability: 'UNAVAILABLE', observedAt: null, value: null };
  bot.subscription = { availability: 'UNAVAILABLE', observedAt: null, value: null };
  bot.unfinishedActions.value!.sampleComplete = false;
  assert.equal(overviewBotStatus(bot, now).tone, 'danger');
  assert.equal(overviewStatus(snapshot, now, false).tone, 'danger');

  bot.pendingReceipts.availability = 'STALE';
  snapshot.receipts.availability = 'STALE';
  bot.actionLatency.value = { sampleCount: 13, p50Ms: 5_000, p95Ms: 35_000, p99Ms: 40_000 };
  assert.equal(overviewBotStatus(bot, now).tone, 'danger');
  assert.equal(overviewStatus(snapshot, now, false).tone, 'danger');
});

test('each card preserves its own pending sample even when the fleet and a busy bot saturate', () => {
  const snapshot = overviewFixture(now);
  const [quiet, busy, empty] = snapshot.bots;
  empty!.publisher!.value = { dispatchEnabled: true, blocker: null };
  quiet!.unfinishedActions.value = {
    ...quiet!.unfinishedActions.value!,
    countLowerBound: 1,
    oldestAgeMs: 1_000,
  };
  busy!.unfinishedActions.value = {
    ...busy!.unfinishedActions.value!,
    countLowerBound: 64,
    sampleComplete: false,
  };
  snapshot.unfinishedActions.value = { ...busy!.unfinishedActions.value };
  const html = render(safetyDeskOverviewResponseSchema.parse(snapshot));
  assert.match(html, /Требуют внимания: <strong>1 из 3/);
  assert.match(html, /aria-label="Майор">.*?<dt>Незавершённые действия<\/dt><dd>1<\/dd>/);
  assert.match(html, /aria-label="Майор 2">.*?<dt>Незавершённые действия<\/dt><dd>≥ 64<\/dd>/);
  assert.match(html, /aria-label="Публик">.*?<dt>Незавершённые действия<\/dt><dd>0<\/dd>/);
});

test('each bot card ages its own runtime signal at the server boundary', () => {
  const snapshot = overviewFixture(now);
  const [moderator, , publisher] = snapshot.bots;
  snapshot.bots = [moderator!, publisher!];
  snapshot.receipts.value = { ...moderator!.pendingReceipts.value! };
  snapshot.unfinishedActions.value = { ...moderator!.unfinishedActions.value! };
  publisher!.subscription = { availability: 'UNAVAILABLE', observedAt: null, value: null };
  publisher!.publisher!.value = { dispatchEnabled: true, blocker: null };
  publisher!.publisher!.observedAt = new Date(now - 44_999).toISOString();
  moderator!.subscription.observedAt = new Date(now - 149_999).toISOString();
  const fresh = render(safetyDeskOverviewResponseSchema.parse(snapshot));
  assert.match(fresh, /Требуют внимания: <strong>0 из 2/);
  assert.match(fresh, /Сигнал Публика · Свежее наблюдение/);
  assert.match(fresh, /Подписка модератора · Свежее наблюдение/);
  assert.equal((fresh.match(/Последнее входящее событие/g) ?? []).length, 1);

  publisher!.publisher!.observedAt = new Date(now - 45_000).toISOString();
  moderator!.subscription.observedAt = new Date(now - 150_000).toISOString();
  const stale = render(snapshot);
  assert.match(stale, /Требуют внимания: <strong>2 из 2/);
  assert.match(stale, /Сигнал Публика · Данные устарели/);
  assert.match(stale, /Подписка модератора · Данные устарели/);
  publisher!.publisher = null;
  assert.match(render(snapshot), /Сигнал Публика · Нет наблюдений/);
});

test('a planned Publisher pause requires a current signal and two confirmed empty samples', () => {
  const snapshot = overviewFixture(now);
  const publisher = snapshot.bots[2]!;
  snapshot.bots = [publisher];
  snapshot.receipts.value = { ...publisher.pendingReceipts.value! };
  snapshot.unfinishedActions.value = { ...publisher.unfinishedActions.value! };
  for (const blocker of ['global_paused', 'runtime_disabled']) {
    publisher.publisher!.value = { dispatchEnabled: false, blocker };
    const html = render(safetyDeskOverviewResponseSchema.parse(snapshot));
    assert.match(html, /Плановая пауза отправки/);
    assert.match(html, /Требуют внимания: <strong>0 из 1/);
  }
  publisher.unfinishedActions.value!.sampleComplete = false;
  assert.match(render(snapshot), /Проверьте паузу отправки/);
  assert.match(render(snapshot), /Требуют внимания: <strong>1 из 1/);

  publisher.unfinishedActions.value!.sampleComplete = true;
  publisher.pendingReceipts.value = {
    ...publisher.pendingReceipts.value!,
    countLowerBound: 1,
    oldestAgeMs: 1_000,
  };
  assert.match(render(snapshot), /Проверьте паузу отправки/);
  publisher.pendingReceipts.value = { ...snapshot.receipts.value };
  publisher.publisher!.value = { dispatchEnabled: false, blocker: 'identity_unattested' };
  assert.match(render(snapshot), /Проверьте паузу отправки/);
  publisher.publisher!.value.dispatchEnabled = true;
  assert.match(render(snapshot), /Проверьте отправку/);
});

test('missing action timings retain outcomes without claiming complete latency coverage', () => {
  const snapshot = overviewTimingGapFixture(now);
  const bot = snapshot.bots[0]!;
  assert.equal(overviewBotStatus(bot, now).label, 'Неполные данные задержки');
  assert.equal(overviewStatus(snapshot, now, false).label, 'Неполные данные задержки');
  const html = render(snapshot);
  assert.match(html, /Задержка измерена для 2 из 7 результатов/);
  assert.match(html, /С измеренной задержкой: 2/);
  assert.match(html, /Требуют внимания: <strong>1 из 1/);
  assert.doesNotMatch(html, /Без превышений/);
  bot.outcomes.availability = 'STALE';
  assert.equal(overviewBotStatus(bot, now).label, 'Данные неполные');
});

test('missing source evidence is never rendered as healthy zero counters', () => {
  const snapshot = overviewFixture(now);
  snapshot.bots = [];
  snapshot.queues = { availability: 'UNAVAILABLE', observedAt: null, value: null };
  snapshot.receipts = { availability: 'UNAVAILABLE', observedAt: null, value: null };
  snapshot.unfinishedActions = { availability: 'UNAVAILABLE', observedAt: null, value: null };
  snapshot.actions = { availability: 'UNAVAILABLE', observedAt: null, value: null };
  snapshot.workers = { availability: 'UNAVAILABLE', observedAt: null, value: null };
  const html = render(snapshot);
  assert.equal(overviewStatus(snapshot, now, false).tone, 'neutral');
  assert.match(html, /Наблюдения неполные/);
  assert.match(html, /Состояние очередей недоступно/);
  assert.match(html, /Нет данных/);
  assert.doesNotMatch(html, /runtime-distribution__bar|>0<|Без превышений/);
});

test('quiet bot reports a confirmed subscription and no recorded actions without declaring a failure', () => {
  const snapshot = overviewFixture(now);
  const bot = snapshot.bots[0]!;
  bot.subscription.value!.lastIncomingAt = null;
  bot.lastTerminalAt.value!.at = null;
  bot.actionLatency.value = { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null };
  bot.outcomes.value = [];
  snapshot.bots = [bot];
  assert.equal(overviewBotStatus(bot, now).tone, 'success');
  const html = render(snapshot);
  assert.match(html, /Не записано/);
  assert.match(html, /В выборке нет завершённых действий/);
  assert.doesNotMatch(html, /NaN|Invalid Date/);
});

test('stale collector, missing worker reports, truncation and failed refresh prevent a green overview', () => {
  const healthy = () => {
    const snapshot = overviewFixture(now);
    snapshot.bots = [snapshot.bots[0]!];
    snapshot.receipts.value = { ...snapshot.bots[0]!.pendingReceipts.value! };
    snapshot.unfinishedActions.value = { ...snapshot.bots[0]!.unfinishedActions.value! };
    return snapshot;
  };
  assert.equal(overviewStatus(healthy(), now, false).tone, 'success');
  assert.equal(overviewStatus(healthy(), now + 120_000, false).tone, 'neutral');
  assert.equal(overviewStatus(healthy(), now, true).tone, 'neutral');
  const missing = healthy();
  missing.workers.value!.freshCount = 1;
  assert.equal(overviewStatus(missing, now, false).tone, 'neutral');
  const truncated = healthy();
  truncated.actions.value!.sampleComplete = false;
  assert.equal(overviewStatus(truncated, now, false).tone, 'neutral');
  assert.equal(overviewBotStatus(truncated.bots[0]!, now, false).label, 'Неполная выборка');
});

test('stale critical values and failed refresh remain historical evidence rather than current bot health', () => {
  const snapshot = overviewFixture(now);
  const critical = snapshot.bots[1]!;
  critical.pendingReceipts.availability = 'STALE';
  critical.unfinishedActions.availability = 'STALE';
  assert.equal(overviewBotStatus(critical, now).label, 'Данные неполные');
  assert.equal(overviewStatus(snapshot, now + 120_000, false).tone, 'neutral');
  const html = renderToStaticMarkup(
    createElement(RuntimeOverviewSnapshot, { snapshot, now, failedRefresh: true }),
  );
  assert.match(html, /Данные устарели/);
  assert.match(html, /Данные неполные/);
  assert.doesNotMatch(
    html,
    /Свежее наблюдение|Долгое ожидание|Отправка приостановлена|Без превышений/,
  );
  assert.match(html, /2 мин/);
  assert.match(html, /Нет свежих данных/);
  assert.doesNotMatch(html, /runtime-measure runtime-tone--danger|runtime-text--danger/);
});

test('minute history leaves gaps for missing samples and missing minutes', () => {
  const point = (minute: number, value: number | null) => ({
    at: new Date(now + minute * 60_000).toISOString(),
    value,
  });
  const chart = historyChartPath(
    [point(0, 1), point(1, 2), point(2, null), point(3, 4), point(6, 3)],
    now,
    now + 6 * 60_000,
  );
  assert.equal((chart.match(/M/g) ?? []).length, 3);
  assert.equal((chart.match(/L/g) ?? []).length, 1);
  assert.doesNotMatch(chart, /NaN|Infinity/);
  assert.equal(historyChartPath([point(0, null)], now, now), '');
});

test('overview client uses a schema-validated, cancellable same-origin owner read', async () => {
  const controller = new AbortController();
  let captured: { url: string; options?: RequestInit } | null = null;
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify(overviewFixture(now)), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  await client.fetchRuntimeOverview(controller.signal);
  assert.equal(captured!.url, '/api/v1/safety-desk/runtime/overview');
  assert.equal(captured!.options?.signal, controller.signal);
  assert.equal(captured!.options?.cache, 'no-store');
  assert.equal(captured!.options?.credentials, 'same-origin');
  assert.equal(
    (captured!.options?.headers as Record<string, string>)['X-Admin-Access-Code'],
    undefined,
  );
  assert.doesNotMatch(captured!.url, /owner-private|system/);
  const invalid = new SafetyDeskApiClient(
    createAdminApiTransport(
      async () => new Response('{"bots":[]}', { headers: { 'Content-Type': 'application/json' } }),
    ),
  );
  await assert.rejects(() => invalid.fetchRuntimeOverview());
});
