import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  commercialReviewItemSchema,
  type CommercialReviewItem,
} from '@maxim/contracts/safety-desk';
import { CommercialReviewDetail } from '../src/commercial-review-desk';

const item = commercialReviewItemSchema.parse({
  id: 'sample-1',
  chatId: 'chat-1',
  chatTitle: 'Чат проверки',
  source: 'TEXT',
  excerpt: 'Ищу мастера для ремонта',
  score: null,
  actionBand: null,
  messageDisposition: null,
  requiredPolicyCohorts: [],
  detectorVersion: 'unknown',
  decisionFingerprint: 'unknown',
  reviewPriority: null,
  reasons: [],
  label: null,
  historicalLabel: null,
  ownReview: null,
  reviewState: 'UNREVIEWED',
  independentReviewCount: 0,
  decisionVisible: false,
  canReview: true,
  canAdjudicate: false,
  imageEvidenceAvailable: false,
  sourceExcerptComplete: true,
  semanticAnnotationAllowed: true,
  evidenceMetadata: null,
  reviewReason: '',
  reviewedAt: null,
  observedAt: '2026-11-01T10:00:00.000Z',
  expiresAt: '2026-11-15T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
});

function render(overrides: Partial<CommercialReviewItem> = {}) {
  return renderToStaticMarkup(
    createElement(CommercialReviewDetail, {
      item: { ...item, ...overrides },
      busy: false,
      onLabel: async () => {},
    }),
  );
}

test('blind human categories start empty and require an independent selection', () => {
  for (const overrides of [
    {},
    {
      canReview: false,
      canAdjudicate: true,
      reviewState: 'DISAGREEMENT' as const,
      independentReviewCount: 2,
    },
  ]) {
    const html = render(overrides);
    assert.equal((html.match(/type="checkbox"/gu) ?? []).length, 9);
    assert.equal((html.match(/<button[^>]* disabled=""/gu) ?? []).length, 3);
    assert.doesNotMatch(html, /checked=""|Оценка фильтра|Что учитывал фильтр|Итог независимой/);
    assert.match(html, /Результат фильтра и предыдущие оценки скрыты/);
    assert.match(html, /Поиск товара, услуги или исполнителя/);
    assert.match(html, /Не хватает контекста для категории/);
  }
});

test('caption-only and incomplete evidence cannot acquire human text categories', () => {
  for (const overrides of [
    { source: 'OCR' as const, excerpt: '' },
    { sourceExcerptComplete: false },
  ]) {
    const html = render(overrides);
    assert.doesNotMatch(html, /type="checkbox"|Что содержится в сообщении/);
    assert.equal((html.match(/<button[^>]* disabled=""/gu) ?? []).length, 2);
    assert.match(html, /<button[^>]*>Недостаточно данных<\/button>/u);
  }
});

test('legacy text with unknown completeness keeps the compatible rating without annotations', () => {
  const html = render({ sourceExcerptComplete: null, semanticAnnotationAllowed: false });
  assert.doesNotMatch(html, /type="checkbox"|Что содержится в сообщении/);
  assert.equal((html.match(/<button[^>]* disabled=""/gu) ?? []).length, 0);
});

test('complete legacy text without a bound source keeps annotations disabled', () => {
  const html = render({ semanticAnnotationAllowed: false });
  assert.doesNotMatch(html, /type="checkbox"|Что содержится в сообщении/);
  assert.equal((html.match(/<button[^>]* disabled=""/gu) ?? []).length, 0);
});
