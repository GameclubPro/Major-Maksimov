import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
  const html = renderToStaticMarkup(
    createElement(ObservabilityDesk, { accessCode: 'private-owner-code', refreshToken: 0 }),
  );
  assert.match(html, /aria-label="Боты и очереди"/);
  assert.match(html, /Читаю сохранённые наблюдения/);
  assert.doesNotMatch(html, /aria-label="Результаты обработки событий"|private-owner-code/);
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

test('old action state with scheduled or retried work does not establish delivery latency', () => {
  const snapshot = overviewFixture(now);
  const bot = snapshot.bots[0]!;
  snapshot.bots = [bot];
  bot.unfinishedActions.value = {
    countLowerBound: 1,
    sampleComplete: true,
    oldestAgeMs: 86_400_000,
    ageBasis: 'state_updated_sample',
  };
  snapshot.receipts.value = { ...bot.pendingReceipts.value! };
  snapshot.unfinishedActions.value = { ...bot.unfinishedActions.value };
  assert.equal(overviewBotStatus(bot, now).tone, 'success');
  assert.equal(overviewStatus(snapshot, now, false).tone, 'success');
  const html = render(snapshot);
  assert.match(html, /runtime-tone--neutral"><h3>Незавершённые действия/);
  assert.match(html, /Может включать запланированные действия и повторные попытки/);
  assert.doesNotMatch(html, /runtime-tone--danger|Долгое ожидание|Есть задержка/);
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
  await client.fetchRuntimeOverview('owner-private', controller.signal);
  assert.equal(captured!.url, '/api/v1/safety-desk/runtime/overview');
  assert.equal(captured!.options?.signal, controller.signal);
  assert.equal(captured!.options?.cache, 'no-store');
  assert.equal(captured!.options?.credentials, 'same-origin');
  assert.equal(
    (captured!.options?.headers as Record<string, string>)['X-Admin-Access-Code'],
    'owner-private',
  );
  assert.doesNotMatch(captured!.url, /owner-private|system/);
  const invalid = new SafetyDeskApiClient(
    createAdminApiTransport(
      async () => new Response('{"bots":[]}', { headers: { 'Content-Type': 'application/json' } }),
    ),
  );
  await assert.rejects(() => invalid.fetchRuntimeOverview('owner-private'));
});
