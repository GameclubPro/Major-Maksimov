import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SafetyDeskCommercialAiResponse } from '@maxim/contracts/safety-desk';
import { CommercialAiSnapshot, CommercialAiDesk } from '../src/commercial-ai-desk';
import { ObservabilityDesk } from '../src/observability-desk';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { createAdminApiTransport } from '../src/admin-request';

function snapshot(
  overrides: Partial<SafetyDeskCommercialAiResponse> = {},
): SafetyDeskCommercialAiResponse {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-28T10:00:00.000Z',
    observedAt: '2026-10-28T09:59:50.000Z',
    mode: 'DELETE_ONLY',
    availability: 'FRESH',
    heartbeatAt: '2026-10-28T09:59:50.000Z',
    lastRecordedResultAt: '2026-10-28T09:58:00.000Z',
    observationStartedAt: '2026-10-28T07:00:00.000Z',
    observationProcessId: '1348126b-9210-4a0e-88cb-e8c1afbd959e',
    active: 1,
    admission: 'READY',
    admissionObservedAt: '2026-10-28T09:59:40.000Z',
    outcomeBasis: 'PROCESS_CUMULATIVE',
    outcomes: {
      kept: 12,
      unsure: 3,
      deleteRegistered: 5,
      deleteNotAdmitted: 2,
      registrationUnknown: 1,
      capacitySkipped: 4,
      unavailableSkipped: 6,
      sourceExpired: 7,
      pressureSkipped: 8,
      dependencyUnavailable: 9,
      other: 0,
    },
    pendingDiscardBasis: 'REDIS_NAMESPACE_CUMULATIVE',
    pendingDiscards: { expired: 15, foreignWorker: 16, invalidPending: 17 },
    trafficCoverage: 'NOT_ESTABLISHED',
    confirmedDeletes: null,
    ...overrides,
  };
}

const render = (value: SafetyDeskCommercialAiResponse) =>
  renderToStaticMarkup(createElement(CommercialAiSnapshot, { snapshot: value }));

test('commercial AI reads the closed same-origin GET and validates the observation contract', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot());
    }),
  );
  assert.deepEqual(await client.fetchCommercialAiRuntime(), snapshot());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, '/api/v1/safety-desk/runtime/commercial-ai');
  assert.equal(calls[0]!.init?.method ?? 'GET', 'GET');
  assert.equal(calls[0]!.init?.credentials, 'same-origin');
  assert.equal(calls[0]!.init?.body, undefined);
  assert.equal(calls[0]!.url.includes('test-access-code'), false);
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>)['X-Admin-Access-Code'],
    undefined,
  );
});

test('commercial AI refuses invented deletion evidence, missing coverage basis and invalid counters', async () => {
  for (const payload of [
    { ...snapshot(), confirmedDeletes: 5 },
    { ...snapshot(), trafficCoverage: undefined },
    { ...snapshot(), observationStartedAt: undefined },
    { ...snapshot(), active: 4 },
    { ...snapshot(), outcomes: { ...snapshot().outcomes, kept: -1 } },
  ]) {
    const client = new SafetyDeskApiClient(
      createAdminApiTransport(async () => Response.json(payload)),
    );
    await assert.rejects(() => client.fetchCommercialAiRuntime());
  }
});

test('availability remains distinct from configured mode and model health', () => {
  const cases: Array<{
    availability: SafetyDeskCommercialAiResponse['availability'];
    mode: SafetyDeskCommercialAiResponse['mode'];
    expected: string;
  }> = [
    { availability: 'DISABLED', mode: 'OFF', expected: 'Выключен в настройках' },
    { availability: 'OBSERVING', mode: 'OBSERVE', expected: 'Настроен режим наблюдения' },
    { availability: 'FRESH', mode: 'DELETE_ONLY', expected: 'Сигнал был свежим на момент снимка' },
    { availability: 'STALE', mode: 'DELETE_ONLY', expected: 'Сигнал процесса устарел' },
    { availability: 'MISSING', mode: 'DELETE_ONLY', expected: 'Нет наблюдений' },
    { availability: 'INVALID', mode: 'DELETE_ONLY', expected: 'Некорректные наблюдения' },
    { availability: 'UNAVAILABLE', mode: 'DELETE_ONLY', expected: 'Наблюдения недоступны' },
  ];
  for (const value of cases) {
    const html = render(snapshot(value));
    assert.ok(html.includes(value.expected), value.availability);
    assert.match(html, /Режим в настройках/);
  }
  assert.match(render(snapshot()), /Сигнал процесса не подтверждает доступность модели/);
  assert.match(render(snapshot()), /Снимок сформирован: 28\.10\.2026, 13:00:00 МСК/);
  assert.match(render(snapshot()), /Данные обновляются кнопкой «Обновить»/);
  assert.match(
    render(snapshot()),
    /Последний учтённый результат<\/dt><dd>28\.10\.2026, 12:58:00 МСК/,
  );
  assert.match(
    render(snapshot({ availability: 'OBSERVING', mode: 'OBSERVE' })),
    /Работа модели этим снимком не подтверждается/,
  );
  assert.match(render(snapshot({ availability: 'STALE' })), /Текущая работа не подтверждена/);
});

test('unknown observations stay unknown without zero counts or a fabricated period start', () => {
  const html = render(
    snapshot({
      availability: 'MISSING',
      observedAt: null,
      heartbeatAt: null,
      lastRecordedResultAt: null,
      observationStartedAt: null,
      observationProcessId: null,
      active: null,
      admission: 'UNKNOWN',
      admissionObservedAt: null,
      outcomes: null,
      pendingDiscards: null,
    }),
  );
  assert.match(html, /Начало периода не записано/);
  assert.match(html, /Счётчики результатов отсутствуют/);
  assert.match(html, /Счётчики ожиданий отсутствуют/);
  assert.match(html, /<dd>Нет данных<\/dd>/);
  assert.match(html, /Не записано/);
  assert.doesNotMatch(
    html,
    /<dd>0<\/dd>|<td>0<\/td>|Начало периода: 28\.10\.2026|NaN|Invalid Date/,
  );
});

test('registered intents and pending discards retain different evidence and time boundaries', () => {
  const html = render(snapshot({ availability: 'STALE' }));
  assert.match(html, /Зарегистрировано намерений удаления<\/dt><dd>5<\/dd>/);
  assert.match(html, /Регистрация намерения не подтверждает удаление сообщения/);
  assert.match(
    html,
    /Подтверждённые удаления и доля проверенного трафика в этом снимке не установлены/,
  );
  assert.match(html, /Начало периода: 28\.10\.2026, 10:00:00 МСК/);
  assert.match(html, /Снимок: 28\.10\.2026, 12:59:50 МСК/);
  assert.match(html, /включая предыдущие процессы/);
  assert.match(html, /эти значения не складываются с результатами процесса/);
  assert.doesNotMatch(html, /\d\s*%/);
});

test('admission status carries its own observation time, including pressure pauses', () => {
  for (const admission of ['READY', 'GOVERNOR_PAUSED', 'HEADROOM_PAUSED'] as const) {
    const html = render(snapshot({ admission }));
    assert.match(html, /Последняя проверка допуска на момент снимка:/);
    assert.match(html, /Проверено: 28\.10\.2026, 12:59:40 МСК/);
  }
  assert.match(render(snapshot({ admission: 'GOVERNOR_PAUSED' })), /нагрузки на основные задачи/);
  assert.match(render(snapshot({ admission: 'HEADROOM_PAUSED' })), /нехватки свободных ресурсов/);
});

test('initial loading shows no AI metrics and the panel is absent from the default family', () => {
  const props = { refreshToken: 0 };
  const loading = renderToStaticMarkup(createElement(CommercialAiDesk, props));
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Читаю сохранённые наблюдения/);
  assert.doesNotMatch(loading, /Накопленные результаты процесса/);
  const defaultFamily = renderToStaticMarkup(createElement(ObservabilityDesk, props));
  assert.match(defaultFamily, /Рекламный ИИ<\/button>/);
  assert.doesNotMatch(defaultFamily, /aria-label="Рекламный ИИ"/);
});
