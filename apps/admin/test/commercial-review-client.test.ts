import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commercialReviewItemSchema,
  type CommercialReviewSemanticAnnotationRequest,
} from '@maxim/contracts/safety-desk';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { createAdminApiTransport } from '../src/admin-request';

const item = commercialReviewItemSchema.parse({
  id: 'sample/1',
  chatId: 'chat-1',
  chatTitle: 'Чат',
  source: 'TEXT',
  excerpt: 'Ремонт',
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
  evidenceMetadata: null,
  reviewReason: '',
  reviewedAt: null,
  observedAt: '2026-10-01T10:00:00.000Z',
  expiresAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});

test('independent and adjudication requests carry only the optional human category selection', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(item);
    }),
  );
  const semanticAnnotation: CommercialReviewSemanticAnnotationRequest = {
    version: 1,
    cohorts: ['BUYER_REQUEST', 'MIXED_CONTENT'],
  };
  await client.labelCommercialReview(
    item,
    'NOT_COMMERCIAL',
    'Нужен мастер',
    'private-code',
    'KEEP',
    semanticAnnotation,
  );
  await client.adjudicateCommercialReview(
    item,
    'NOT_COMMERCIAL',
    'Нужен мастер',
    'private-code',
    'KEEP',
    semanticAnnotation,
  );
  for (const call of calls) {
    assert.deepEqual(JSON.parse(String(call.init?.body)), {
      expectedUpdatedAt: item.updatedAt,
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
      reason: 'Нужен мастер',
      semanticAnnotation,
    });
    assert.equal(call.init?.credentials, 'same-origin');
    assert.equal(call.url.includes('private-code'), false);
  }
  assert.equal(calls[0]?.url, '/api/v1/safety-desk/commercial/review/sample%2F1/label');
  assert.equal(calls[1]?.url, '/api/v1/safety-desk/commercial/review/sample%2F1/adjudicate');
});

test('commercial owner feedback sends the server revision through the closed transport', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify(
          String(url).endsWith('/label') || String(url).endsWith('/adjudicate')
            ? {
                ...item,
                decisionVisible: true,
                label: 'NOT_COMMERCIAL',
                ownReview: {
                  label: 'NOT_COMMERCIAL',
                  expectedDisposition: 'KEEP',
                  reason: 'Частное объявление',
                  reviewedAt: item.updatedAt,
                  kind: String(url).endsWith('/adjudicate') ? 'ADJUDICATION' : 'INDEPENDENT',
                  evidenceKind: 'TEXT',
                },
              }
            : { generatedAt: item.updatedAt, items: [item], nextCursor: null },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
  await client.fetchCommercialReview('private-code', 'page', 'REVIEWED');
  await client.labelCommercialReview(item, 'NOT_COMMERCIAL', 'Частное объявление', 'private-code');
  assert.equal(
    calls[0]?.url,
    '/api/v1/safety-desk/commercial/review?limit=50&status=REVIEWED&cursor=page',
  );
  assert.equal(calls[1]?.url, '/api/v1/safety-desk/commercial/review/sample%2F1/label');
  assert.equal(calls[1]?.init?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    expectedUpdatedAt: item.updatedAt,
    label: 'NOT_COMMERCIAL',
    expectedDisposition: 'KEEP',
    reason: 'Частное объявление',
  });
  await client.adjudicateCommercialReview(
    item,
    'NOT_COMMERCIAL',
    'Частное объявление',
    'private-code',
    'KEEP',
  );
  assert.equal(calls[2]?.url, '/api/v1/safety-desk/commercial/review/sample%2F1/adjudicate');
  assert.deepEqual(
    JSON.parse(String(calls[2]?.init?.body)),
    JSON.parse(String(calls[1]?.init?.body)),
  );
  assert.equal(
    Object.keys(JSON.parse(String(calls[2]?.init?.body))).some((name) =>
      /reviewer|actor/u.test(name),
    ),
    false,
  );
  assert.equal(
    (calls[1]?.init?.headers as Record<string, string>)['X-Admin-Access-Code'],
    'private-code',
  );
});
