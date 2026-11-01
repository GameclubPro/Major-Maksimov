import { describe, expect, it } from 'vitest';
import { commercialAiReviewExportQuerySchema } from '@maxim/contracts/commercial-ai-quality';
import {
  commercialReviewDecisionRequestSchema,
  commercialReviewOwnReviewSchema,
  resolveCommercialLabelAuthority,
  resolveCommercialSemanticReview,
  commercialReviewItemSchema,
  commercialReviewEvidenceMetadataSchema,
  commercialReviewDecisionSnapshotSchema,
  commercialReviewExportQuerySchema,
  commercialReviewSamplingFrameItemSchema,
} from '@maxim/contracts/safety-desk';

const date = '2026-10-01T10:00:00.000Z';
const blind = {
  id: 'sample-1',
  chatId: 'chat-1',
  chatTitle: 'Чат',
  source: 'TEXT',
  excerpt: 'Сообщение',
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
  reviewReason: '',
  reviewedAt: null,
  ownReview: null,
  reviewState: 'UNREVIEWED',
  independentReviewCount: 0,
  decisionVisible: false,
  canReview: true,
  canAdjudicate: false,
  imageEvidenceAvailable: false,
  sourceExcerptComplete: null,
  evidenceMetadata: null,
  observedAt: date,
  expiresAt: date,
  updatedAt: date,
};

describe('independent commercial review contracts', () => {
  it.each([
    ['COMMERCIAL', 'DELETE'],
    ['UNSURE', null],
  ] as const)(
    'preserves agreed label authority and the semantic adjudicator’s actual %s response',
    (label, expectedDisposition) => {
      const first = {
        reviewerKey: 'first',
        kind: 'INDEPENDENT',
        label: 'NOT_COMMERCIAL',
        expectedDisposition: 'KEEP',
      };
      const second = { ...first, reviewerKey: 'second' };
      const third = {
        reviewerKey: 'third',
        kind: 'SEMANTIC_ADJUDICATION',
        label,
        expectedDisposition,
      };
      const ratings = [first, second, third];
      const original = structuredClone(ratings);
      const authority = resolveCommercialLabelAuthority(ratings);
      expect(authority.finalRating).toBe(first);
      expect(authority.labelRatings).toEqual([first, second]);
      expect(ratings).toEqual(original);
      expect(ratings[2]).toBe(third);
      expect(
        commercialReviewOwnReviewSchema.safeParse({
          ...third,
          reason: 'Собственная независимая оценка',
          reviewedAt: date,
          evidenceKind: 'TEXT',
        }).success,
      ).toBe(true);
    },
  );
  it('keeps genuine label adjudication authoritative and its contributors complete', () => {
    const first = {
      reviewerKey: 'first',
      kind: 'INDEPENDENT',
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
    };
    const second = { ...first, reviewerKey: 'second', label: 'UNSURE', expectedDisposition: null };
    const third = {
      ...first,
      reviewerKey: 'third',
      kind: 'ADJUDICATION',
      label: 'COMMERCIAL',
      expectedDisposition: 'DELETE',
    };
    const ratings = [first, second, third];
    expect(resolveCommercialLabelAuthority(ratings)).toEqual({
      finalRating: third,
      labelRatings: ratings,
    });
    expect(resolveCommercialLabelAuthority(ratings).finalRating).toBe(third);
    expect(resolveCommercialLabelAuthority([first, second]).finalRating).toBe(first);
    expect(
      resolveCommercialLabelAuthority([first, second, { ...third, kind: 'SEMANTIC_ADJUDICATION' }]),
    ).toEqual({ finalRating: null, labelRatings: [] });
  });
  it('refuses malformed, duplicate and unsupported label provenance', () => {
    const first = {
      reviewerKey: 'first',
      kind: 'INDEPENDENT',
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
    };
    const second = { ...first, reviewerKey: 'second' };
    const third = { ...first, reviewerKey: 'third', kind: 'ADJUDICATION' };
    for (const ratings of [
      [],
      [first, { ...second, reviewerKey: first.reviewerKey }],
      [first, second, { ...third, reviewerKey: first.reviewerKey }],
      [first, second, { ...third, reviewerKey: '' }],
      [first, second, { ...third, kind: 'OTHER' }],
      [first, second, { ...third, label: 'UNKNOWN' }],
      [first, second, { ...third, expectedDisposition: 'DELETE' }],
      [first, second, { ...third, label: 'UNSURE' }],
      [first, second, { ...third, expectedDisposition: 'UNKNOWN' }],
      [first, third],
      [first, second, { ...first, reviewerKey: 'third' }],
      [first, second, third, { ...third, reviewerKey: 'fourth' }],
      [first, second, third, { ...third, reviewerKey: 'fourth', kind: 'SEMANTIC_ADJUDICATION' }],
    ])
      expect(resolveCommercialLabelAuthority(ratings)).toEqual({
        finalRating: null,
        labelRatings: [],
      });
  });
  it('accepts independent semantic categories but refuses client-supplied source proofs', () => {
    const request = {
      expectedUpdatedAt: date,
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
      semanticAnnotation: { version: 1, cohorts: ['BUYER_REQUEST'] },
    };
    expect(commercialReviewDecisionRequestSchema.safeParse(request).success).toBe(true);
    for (const annotation of [
      { version: 1, cohorts: ['unreviewed-free-text'] },
      { version: 1, cohorts: [] },
      { version: 2, cohorts: ['BUYER_REQUEST'] },
      { version: 1, cohorts: ['BUYER_REQUEST', 'BUYER_REQUEST'] },
      { version: 1, cohorts: ['BUYER_REQUEST'], sourceSnapshotSha256: 'a'.repeat(64) },
      { version: 1, cohorts: ['BUYER_REQUEST'], excerptSha256: 'b'.repeat(64) },
    ])
      expect(
        commercialReviewDecisionRequestSchema.safeParse({
          ...request,
          semanticAnnotation: annotation,
        }).success,
      ).toBe(false);
  });
  it('resolves only two independent source-bound semantic votes or a distinct adjudicator', () => {
    const binding = { sourceSnapshotSha256: 'a'.repeat(64), excerptSha256: 'b'.repeat(64) };
    const vote = (reviewerKey: string, cohorts = ['BUYER_REQUEST']) => ({
      reviewerKey,
      kind: 'INDEPENDENT',
      semanticAnnotation: { version: 1, cohorts, ...binding },
    });
    const first = vote('first');
    expect(
      resolveCommercialSemanticReview(
        [first, vote('second'), { ...vote('third'), kind: 'OTHER' }],
        binding,
      ).state,
    ).toBe('MISSING');
    const second = vote('second');
    expect(resolveCommercialSemanticReview([first, second], binding)).toEqual({
      state: 'RESOLVED',
      cohorts: ['BUYER_REQUEST'],
    });
    expect(resolveCommercialSemanticReview([first], binding).state).toBe('MISSING');
    expect(resolveCommercialSemanticReview([first, vote('first')], binding).state).toBe('MISSING');
    expect(
      resolveCommercialSemanticReview([first, { ...second, semanticAnnotation: null }], binding)
        .state,
    ).toBe('MISSING');
    expect(
      resolveCommercialSemanticReview([first, second], {
        ...binding,
        excerptSha256: 'c'.repeat(64),
      }).state,
    ).toBe('MISSING');
    const differing = vote('second', ['PERSONAL_SALE']);
    expect(resolveCommercialSemanticReview([first, differing], binding).state).toBe('DISAGREEMENT');
    const third = { ...vote('third', ['PERSONAL_SALE']), kind: 'ADJUDICATION' };
    expect(resolveCommercialSemanticReview([first, differing, third], binding)).toEqual({
      state: 'RESOLVED',
      cohorts: ['PERSONAL_SALE'],
    });
    expect(
      resolveCommercialSemanticReview(
        [first, differing, { ...third, kind: 'SEMANTIC_ADJUDICATION' }],
        binding,
      ),
    ).toEqual({ state: 'RESOLVED', cohorts: ['PERSONAL_SALE'] });
    expect(
      resolveCommercialSemanticReview(
        [
          first,
          differing,
          third,
          { ...third, reviewerKey: 'fourth', kind: 'SEMANTIC_ADJUDICATION' },
        ],
        binding,
      ).state,
    ).toBe('MISSING');
    expect(
      resolveCommercialSemanticReview(
        [first, differing, { ...third, reviewerKey: 'first' }],
        binding,
      ).state,
    ).toBe('MISSING');
    expect(
      resolveCommercialSemanticReview(
        [first, differing, third, { ...third, reviewerKey: 'fourth' }],
        binding,
      ).state,
    ).toBe('MISSING');
  });
  it('requires server-redacted evidence before the reviewer has saved a label', () => {
    expect(commercialReviewItemSchema.safeParse(blind).success).toBe(true);
    for (const exposed of [
      { score: 85 },
      { actionBand: 'DELETE_ONLY' },
      { messageDisposition: 'DELETE' },
      { reviewPriority: 90 },
      { reasons: ['SERVICE_OFFER'] },
      { detectorVersion: 'detector-v1' },
      { requiredPolicyCohorts: ['commercial-text'] },
      { label: 'COMMERCIAL' },
      { historicalLabel: 'NOT_COMMERCIAL' },
      { reviewReason: 'Previous opinion' },
    ])
      expect(commercialReviewItemSchema.safeParse({ ...blind, ...exposed }).success).toBe(false);
  });
  it('rejects reviewer identity supplied in a browser request and contradictory dispositions', () => {
    const request = {
      expectedUpdatedAt: date,
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
      reason: ' Частное объявление ',
    };
    expect(commercialReviewDecisionRequestSchema.parse(request).reason).toBe('Частное объявление');
    for (const invalid of [
      { ...request, reviewerKey: 'browser-actor' },
      { ...request, reviewerId: 'browser-actor' },
      { ...request, expectedDisposition: 'DELETE' },
      { ...request, label: 'UNSURE', expectedDisposition: 'KEEP' },
    ])
      expect(commercialReviewDecisionRequestSchema.safeParse(invalid).success).toBe(false);
    expect(
      commercialReviewDecisionRequestSchema.safeParse({ ...request, label: 'COMMERCIAL' }).success,
    ).toBe(true);
  });
  it('keeps legacy unknown outcomes separate from explicit deletion evidence and strips unknown metadata', () => {
    const input = {
      schemaVersion: 2,
      samplingProbability: null,
      samplingStratum: 'UNKNOWN',
      logicalMessageKey: null,
      authorGroupId: null,
      campaignGroupId: null,
      sourceSnapshotSha256: null,
      imageReviewRequired: false,
      sourceExcerptComplete: null,
      messageCreatedAt: null,
      settingsProfileDigest: null,
      detectorSourceSha256: null,
      hasDetection: null,
      decisionOutcome: null,
      deleteEligible: null,
      executionOutcome: 'UNKNOWN',
      analysisOutcome: 'UNKNOWN',
      candidateDecision: null,
      rawText: 'Do not retain',
    };
    expect(commercialReviewEvidenceMetadataSchema.parse(input)).not.toHaveProperty('rawText');
    expect(
      commercialReviewEvidenceMetadataSchema.safeParse({ ...input, samplingProbability: 1.1 })
        .success,
    ).toBe(false);
    expect(
      commercialReviewEvidenceMetadataSchema.safeParse({
        ...input,
        detectorSourceSha256: 'not-a-digest',
      }).success,
    ).toBe(false);
  });
  it('defaults the private AI export to a bounded fifty-item page', () => {
    const window = { since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z' };
    expect(commercialAiReviewExportQuerySchema.parse(window).limit).toBe(50);
    expect(commercialAiReviewExportQuerySchema.safeParse({ ...window, limit: 51 }).success).toBe(
      false,
    );
  });
  it('bounds export windows to retention and keeps the sampling frame free of labels and decisions', () => {
    expect(
      commercialReviewExportQuerySchema.safeParse({
        since: '2026-10-01T00:00:00.000Z',
        until: '2026-10-15T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      commercialReviewExportQuerySchema.safeParse({
        since: '2026-10-01T00:00:00.000Z',
        until: '2026-10-15T00:00:00.001Z',
      }).success,
    ).toBe(false);
    const frame = {
      source: 'TEXT',
      observedAt: date,
      sourceSnapshotSha256: null,
      logicalMessageKey: null,
      pseudonymizationKeyId: null,
      settingsProfileDigest: null,
      campaignGroupingComplete: null,
      messageCreatedAt: null,
      evaluationSamplingProbability: null,
    };
    expect(commercialReviewSamplingFrameItemSchema.safeParse(frame).success).toBe(true);
    for (const privateField of [
      { score: 85 },
      { label: 'COMMERCIAL' },
      { excerpt: 'private text' },
      { samplingStratum: 'HIT' },
    ])
      expect(
        commercialReviewSamplingFrameItemSchema.safeParse({ ...frame, ...privateField }).success,
      ).toBe(false);
    const snapshot = commercialReviewDecisionSnapshotSchema.parse({
      score: 50,
      actionBand: 'REVIEW_ONLY',
      messageDisposition: 'KEEP',
      detectorVersion: 'v1',
      decisionFingerprint: 'v1',
      reasons: [],
      requiredPolicyCohorts: [],
    });
    expect(snapshot).toMatchObject({ hasDetection: null, actionable: null, deleteEligible: null });
  });
});
