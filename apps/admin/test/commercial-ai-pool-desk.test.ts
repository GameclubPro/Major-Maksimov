import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SafetyDeskCommercialAiPoolResponse } from '@maxim/contracts/safety-desk';
import { CommercialAiPoolSnapshot } from '../src/commercial-ai-pool-desk';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { createAdminApiTransport } from '../src/admin-request';
const snapshot: SafetyDeskCommercialAiPoolResponse = {
  schemaVersion: 1,
  generatedAt: '2026-10-28T12:00:00.000Z',
  observedAt: '2026-10-28T12:00:00.000Z',
  workersEnabled: true,
  routingEnabled: true,
  policy: 'confirm-positive',
  availability: 'FRESH',
  nodes: [
    { nodeId: 'server-9b', state: 'SLOT_OCCUPIED', validUntil: '2026-10-28T12:00:05.000Z' },
    { nodeId: 'pc-a-4b', state: 'READY', validUntil: '2026-10-28T12:00:05.000Z' },
    { nodeId: 'pc-b-9b', state: 'OFFLINE', validUntil: null },
  ],
  metrics: null,
  trafficCoverage: 'NOT_ESTABLISHED',
  confirmedDeletes: null,
};
const fourNodeSnapshot: SafetyDeskCommercialAiPoolResponse = {
  ...snapshot,
  nodes: [
    ...snapshot.nodes!,
    { nodeId: 'pc-a-cpu-9b', state: 'NOT_READY', validUntil: '2026-10-28T12:00:05.000Z' },
  ],
};
test('pool view distinguishes busy from offline and does not invent zero measurements', () => {
  const html = renderToStaticMarkup(createElement(CommercialAiPoolSnapshot, { snapshot }));
  for (const text of [
    'Слот занят',
    'Нет свежей регистрации',
    'Готов принять задание',
    'Статистика попыток моделей пока отсутствует',
  ])
    assert.ok(html.includes(text));
  assert.ok(!html.includes('100%'));
});
test('pool view distinguishes PC-A CPU 9B from the GPU model', () => {
  const html = renderToStaticMarkup(
    createElement(CommercialAiPoolSnapshot, { snapshot: fourNodeSnapshot }),
  );
  for (const text of ['ПК-A · Qwen 4B', 'ПК-A · CPU · Qwen 9B', 'Подключён, не готов'])
    assert.ok(html.includes(text));
});
test('pool view preserves distinct metrics and the observation window', () => {
  const value: SafetyDeskCommercialAiPoolResponse = {
    ...fourNodeSnapshot,
    metrics: {
      availability: 'STALE',
      observedAt: snapshot.observedAt!,
      observationStartedAt: '2026-10-28T11:00:00.000Z',
      observationProcessId: '1348126b-9210-4a0e-88cb-e8c1afbd959e',
      basis: 'PROCESS_MODEL_ATTEMPTS',
      diagnostics: {
        schemaVersion: 1,
        nodes: fourNodeSnapshot.nodes!.map(({ nodeId }) => ({
          nodeId,
          completedAttempts: 0,
          failedAttempts: 0,
          lastCompletedAt: null,
          lastFailureAt: null,
          ewmaDurationMs: null,
        })),
        consultations: { completed: 5, noCapacity: 55, budgetExhausted: 2 },
      },
    },
  };
  const html = renderToStaticMarkup(createElement(CommercialAiPoolSnapshot, { snapshot: value }));
  for (const text of [
    'Счётчики устарели',
    'Нет измерений',
    'Без свободной 9B',
    '55',
    'Число попыток не равно',
  ])
    assert.ok(html.includes(text));
  assert.equal(html.split('ПК-A · CPU · Qwen 9B').length - 1, 2);
  const legacyMetrics: SafetyDeskCommercialAiPoolResponse = {
    ...value,
    metrics: {
      ...value.metrics!,
      diagnostics: {
        ...value.metrics!.diagnostics,
        nodes: value.metrics!.diagnostics.nodes.slice(0, 3),
      },
    },
  };
  const legacyHtml = renderToStaticMarkup(
    createElement(CommercialAiPoolSnapshot, { snapshot: legacyMetrics }),
  );
  assert.equal(legacyHtml.split('ПК-A · CPU · Qwen 9B').length - 1, 1);
});
for (const value of [snapshot, fourNodeSnapshot])
  test(`pool GET accepts ${value.nodes!.length} nodes through its independent endpoint`, async () => {
    let path = '';
    const client = new SafetyDeskApiClient(
      createAdminApiTransport(async (url, init) => {
        path = String(url);
        assert.equal(init?.method ?? 'GET', 'GET');
        assert.equal(init?.body, undefined);
        return Response.json(value);
      }),
    );
    assert.deepEqual(await client.fetchCommercialAiPoolRuntime(), value);
    assert.equal(path, '/api/v1/safety-desk/runtime/commercial-ai/pool');
  });
