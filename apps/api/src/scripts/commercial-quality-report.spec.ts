import type {
  CommercialReviewExportResponse,
  CommercialReviewSamplingFrameResponse,
} from '@maxim/contracts/safety-desk';
import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../moderation/commercial-ocr/commercial-ocr-detector-source.generated';
import { fingerprintCommercialTextSettingsProfile } from '../moderation/commercial/commercial-text-runtime-policy.service';
import {
  analyzeCommercialQualityEvidence,
  type CommercialQualityEvidenceBundle,
} from './commercial-quality-report';
import { COMMERCIAL_QUALITY_EVALUATION_PROBABILITY } from '../moderation/commercial/commercial-quality-sampling';

type Item = CommercialReviewExportResponse['items'][number];
const profile = (strict = false) =>
  fingerprintCommercialTextSettingsProfile({
    commercialAdsSensitivity: strict ? 'STRICT' : 'BALANCED',
    commercialAdsWarnThreshold: strict ? 38 : 45,
    commercialAdsDeleteThreshold: strict ? 55 : 65,
  });
function item(
  id: string,
  expected: 'KEEP' | 'DELETE',
  baseline: boolean,
  candidate: boolean,
  at = '2026-09-12T00:00:00.000Z',
  strict = false,
): Item {
  return {
    eligibleForIndependentCorpus: true,
    ratings: ['a', 'b'].map((reviewerKey) => ({
      reviewerKey,
      label: expected === 'DELETE' ? 'COMMERCIAL' : 'NOT_COMMERCIAL',
      expectedDisposition: expected,
      kind: 'INDEPENDENT',
      evidenceKind: 'TEXT',
      reviewedAt: '2026-09-20T00:00:00.000Z',
    })),
    sample: {
      source: 'TEXT',
      excerpt: 'PRIVATE MESSAGE DO NOT OUTPUT',
      historicalLabel: null,
      label: expected === 'DELETE' ? 'COMMERCIAL' : 'NOT_COMMERCIAL',
      reviewState: 'RESOLVED',
      detectorVersion: 'commercial-deterministic-v5',
      evidenceMetadata: {
        authorGroupId: `author-${id}`,
        campaignGroupId: `campaign-${id}`,
        campaignGroupIds: [],
        campaignGroupingComplete: true,
        logicalMessageKey: `logical-${id}`,
        sourceSnapshotSha256: `snapshot-${id}`,
        messageCreatedAt: at,
        samplingProbability: 0.1,
        sourceExcerptComplete: true,
        pseudonymizationKeyId: 'key-a',
        randomEvaluationIncluded: true,
        evaluationSamplingProbability: COMMERCIAL_QUALITY_EVALUATION_PROBABILITY,
        detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
        settingsProfileDigest: profile(strict),
        hasDetection: baseline,
        deleteEligible: baseline,
        executionOutcome: 'UNKNOWN',
        analysisOutcome: 'COMPLETE',
        candidateDecision: {
          detectorVersion: 'commercial-intent-quality-v1',
          hasDetection: candidate,
          actionable: candidate,
          deleteEligible: candidate,
          actionBand: candidate ? 'WARN' : 'ALLOW',
          messageDisposition: candidate ? 'DELETE' : 'KEEP',
        },
      },
    },
  } as unknown as Item;
}
function bundle(rows: Item[]): CommercialQualityEvidenceBundle {
  const page = (items: Item[]) => [
    {
      cursor: null,
      response: {
        since: '2026-09-01T00:00:00.000Z',
        until: '2026-09-21T00:00:00.000Z',
        complete: true,
        nextCursor: null,
        items,
      } as CommercialReviewExportResponse,
    },
  ];
  const development = [
    item('dev1', 'KEEP', false, false, '2026-09-01T00:00:00.000Z'),
    item('dev2', 'KEEP', false, false, '2026-09-08T00:00:00.000Z'),
  ];
  development.forEach((row) =>
    row.ratings.forEach((rating) => {
      rating.reviewedAt = '2026-09-09T00:00:00.000Z';
    }),
  );
  return {
    schemaVersion: 'commercial-quality-paired/v1',
    frozenAt: '2026-09-10T00:00:00.000Z',
    evaluatedAt: '2026-09-21T00:00:00.000Z',
    detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
    development: page(development),
    holdout: page(rows),
  };
}

describe('independent commercial paired report', () => {
  it.each([
    { label: 'COMMERCIAL' as const, expectedDisposition: 'DELETE' as const },
    { label: 'UNSURE' as const, expectedDisposition: null },
  ])('keeps agreed KEEP authority after a semantic adjudicator records $label', (third) => {
    const baseline = item('protected', 'KEEP', true, false);
    const row = item('protected', 'KEEP', true, false);
    row.ratings.push({
      ...row.ratings[0]!,
      ...third,
      reviewerKey: 'c',
      kind: 'SEMANTIC_ADJUDICATION',
    });
    const report = analyzeCommercialQualityEvidence(bundle([row]));
    const baselineReport = analyzeCommercialQualityEvidence(bundle([baseline]));
    expect(report.inputSha256).not.toBe(baselineReport.inputSha256);
    expect({ ...report, inputSha256: baselineReport.inputSha256 }).toEqual(baselineReport);
    expect(report.coverage).toMatchObject({ independentReviewedRows: 1, uncertainRows: 0 });
    expect(report.profiles[0]).toMatchObject({
      independentProtectedUnits: 1,
      independentOfferUnits: 0,
      falseDeletionPermissions: { baselineErrors: 1, candidateErrors: 0 },
    });
  });

  it.each([
    { label: 'COMMERCIAL' as const, expectedDisposition: 'DELETE' as const },
    { label: 'NOT_COMMERCIAL' as const, expectedDisposition: 'KEEP' as const },
  ])('retains adjudication authority for a real label disagreement resolved as $label', (third) => {
    const row = item('disagreement', 'DELETE', true, true);
    row.ratings[0]!.label = 'NOT_COMMERCIAL';
    row.ratings[0]!.expectedDisposition = 'KEEP';
    row.ratings.push({
      ...row.ratings[1]!,
      ...third,
      reviewerKey: 'c',
      kind: 'ADJUDICATION',
    });
    row.sample.label = third.label;
    const report = analyzeCommercialQualityEvidence(bundle([row]));
    expect(report.coverage.independentReviewedRows).toBe(1);
    expect(report.profiles[0]).toMatchObject({
      independentProtectedUnits: third.expectedDisposition === 'KEEP' ? 1 : 0,
      independentOfferUnits: third.expectedDisposition === 'DELETE' ? 1 : 0,
    });
  });

  it('retains uncertainty exclusion when the actual label disagreement is unresolved', () => {
    const row = item('unsure-disagreement', 'KEEP', false, false);
    row.ratings[1]!.label = 'COMMERCIAL';
    row.ratings[1]!.expectedDisposition = 'DELETE';
    row.ratings.push({
      ...row.ratings[0]!,
      reviewerKey: 'c',
      kind: 'ADJUDICATION',
      label: 'UNSURE',
      expectedDisposition: null,
    });
    row.sample.label = 'UNSURE';
    const report = analyzeCommercialQualityEvidence(bundle([row]));
    expect(report.coverage).toMatchObject({ independentReviewedRows: 0, uncertainRows: 1 });
    expect(report.profiles[0]).toMatchObject({
      independentProtectedUnits: 0,
      independentOfferUnits: 0,
    });
  });

  it.each([
    { reviewedAt: '2026-09-11T00:00:00.000Z' },
    { evidenceKind: 'CAPTION_ONLY' as const },
    { reviewerKey: 'a' },
  ])('validates every semantic adjudicator source, time and identity: %o', (invalid) => {
    const row = item('invalid-third', 'KEEP', false, false);
    row.ratings.push({
      ...row.ratings[0]!,
      reviewerKey: 'c',
      kind: 'SEMANTIC_ADJUDICATION',
      label: 'UNSURE',
      expectedDisposition: null,
      ...invalid,
    });
    const report = analyzeCommercialQualityEvidence(bundle([row]));
    expect(report.coverage.independentReviewedRows).toBe(0);
    expect(report.profiles[0]!.independentProtectedUnits).toBe(0);
  });

  it('preserves the evaluation clock bound for semantic adjudication', () => {
    const row = item('late-third', 'KEEP', false, false);
    row.ratings.push({
      ...row.ratings[0]!,
      reviewerKey: 'c',
      kind: 'SEMANTIC_ADJUDICATION',
      label: 'UNSURE',
      expectedDisposition: null,
      reviewedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(analyzeCommercialQualityEvidence(bundle([row])).provenanceErrors).toContain(
      'source_or_review_after_evaluation',
    );
  });

  it('validates the original-image digest on semantic adjudication as well as the label votes', () => {
    const row = item('image-third', 'KEEP', false, false);
    row.sample.source = 'OCR';
    row.ratings.forEach((rating) => {
      rating.evidenceKind = 'PRIVATE_SOURCE_IMAGE';
      rating.sourceEvidenceDigest = row.sample.evidenceMetadata!.sourceSnapshotSha256!;
    });
    row.ratings.push({
      ...row.ratings[0]!,
      reviewerKey: 'c',
      kind: 'SEMANTIC_ADJUDICATION',
      label: 'UNSURE',
      expectedDisposition: null,
      sourceEvidenceDigest: 'wrong-source-digest',
    });
    expect(analyzeCommercialQualityEvidence(bundle([row])).coverage.independentReviewedRows).toBe(
      0,
    );
  });

  it('keeps raw denominators, WARN deletion semantics, paired corrections and uncertainty', () => {
    const rows = [
      item('p', 'KEEP', true, false),
      item('n', 'DELETE', false, true),
      item('last', 'KEEP', false, false, '2026-09-19T00:00:00.000Z'),
    ];
    const report = analyzeCommercialQualityEvidence(bundle(rows));
    expect(report.profiles[0]).toMatchObject({
      independentProtectedUnits: 2,
      independentOfferUnits: 1,
      falseDeletionPermissions: { baselineErrors: 1, candidateErrors: 0, correctedUnits: 1 },
      cleanupMisses: { baselineErrors: 1, candidateErrors: 0 },
      releasedExecution: { unknownUnits: 1, candidateExecutionEvaluated: false },
    });
    expect(report.textIndependentImprovementProven).toBe(false);
    expect(report.profiles[0]!.candidateFalseDeletionUpper95).toBeGreaterThan(0.1);
    expect(report.promotionAuthorized).toBe(false);
    expect(JSON.stringify(report)).not.toContain('PRIVATE MESSAGE');
  });
  it('collapses connected authors and every campaign key rather than counting repeated deliveries', () => {
    const rows = [
      item('first', 'KEEP', true, false),
      item('second', 'KEEP', false, false, '2026-09-19T00:00:00.000Z'),
    ];
    rows[0]!.sample.evidenceMetadata!.campaignGroupIds = ['shared-second-contact'];
    rows[1]!.sample.evidenceMetadata!.campaignGroupIds = ['shared-second-contact'];
    expect(
      analyzeCommercialQualityEvidence(bundle(rows)).profiles[0]!.independentProtectedUnits,
    ).toBe(1);
    const overlapping = bundle(rows);
    overlapping.development[0]!.response.items[0]!.sample.evidenceMetadata!.campaignGroupIds = [
      'shared-second-contact',
    ];
    expect(analyzeCommercialQualityEvidence(overlapping).provenanceErrors).toContain(
      'author_or_campaign_overlap',
    );
  });
  it('rejects truncated exports and key rotation and never converts historical labels to truth', () => {
    const data = bundle([item('p', 'KEEP', false, false)]);
    data.holdout[0]!.response.nextCursor = 'more';
    data.holdout[0]!.response.complete = false;
    data.holdout[0]!.response.items[0]!.sample.evidenceMetadata!.pseudonymizationKeyId = 'rotated';
    data.holdout[0]!.response.items[0]!.eligibleForIndependentCorpus = false;
    data.holdout[0]!.response.items[0]!.sample.historicalLabel = 'NOT_COMMERCIAL';
    const report = analyzeCommercialQualityEvidence(data);
    expect(report.provenanceErrors).toEqual(
      expect.arrayContaining(['holdout_pagination_truncated', 'pseudonym_key_missing_or_rotated']),
    );
    expect(report.coverage.historicalLabelsIgnored).toBe(1);
    expect(report.coverage.independentReviewedRows).toBe(0);
  });
  it('requires full original-image evidence and reports OCR unevaluated', () => {
    const row = item('image', 'KEEP', false, false);
    row.sample.source = 'OCR';
    row.ratings.forEach((rating) => {
      rating.evidenceKind = 'CAPTION_ONLY';
    });
    const report = analyzeCommercialQualityEvidence(bundle([row]));
    expect(report.coverage.captionOnlyImageRows).toBe(1);
    expect(report.ocr.evaluated).toBe(false);
  });
  it('requires seven days of text sources even when photo clocks extend the export window', () => {
    const photo = item('early-image', 'KEEP', false, false);
    photo.sample.source = 'OCR';
    photo.ratings.forEach((rating) => {
      rating.evidenceKind = 'CAPTION_ONLY';
    });
    const data = bundle([photo, item('text', 'KEEP', false, false, '2026-09-19T00:00:00.000Z')]);
    const devPhoto = item('dev-image', 'KEEP', false, false, '2026-09-01T00:00:00.000Z');
    devPhoto.sample.source = 'OCR';
    devPhoto.ratings = [];
    data.development[0]!.response.items[0] = devPhoto;
    const report = analyzeCommercialQualityEvidence(data);
    expect(report.provenanceErrors).toEqual(
      expect.arrayContaining([
        'development_requires_seven_days_before_freeze',
        'holdout_requires_seven_days_after_24h_gap',
      ]),
    );
    expect(report.provenanceErrors).not.toContain('development_independent_evidence_incomplete');
    expect(report.coverage.captionOnlyImageRows).toBe(1);
  });
  it('passes text evidence only with sufficient independent units and reductions of both error types in both profiles', () => {
    const rows: Item[] = [];
    for (const strict of [false, true]) {
      for (let index = 0; index < 4000; index++)
        rows.push(
          item(
            `neg-${strict}-${index}`,
            'KEEP',
            index < 10,
            false,
            index === 3999 ? '2026-09-19T00:00:00.000Z' : undefined,
            strict,
          ),
        );
      for (let index = 0; index < 500; index++)
        rows.push(item(`pos-${strict}-${index}`, 'DELETE', index >= 25, true, undefined, strict));
    }
    // Unit test pages stay below the real export page cap.
    const data = bundle([]);
    data.holdout = [];
    for (let offset = 0; offset < rows.length; offset += 500) {
      const next = offset + 500 < rows.length ? `cursor-${offset + 500}` : null;
      data.holdout.push({
        cursor: offset ? `cursor-${offset}` : null,
        response: {
          ...data.development[0]!.response,
          items: rows.slice(offset, offset + 500),
          nextCursor: next,
          complete: next === null,
        },
      });
    }
    const report = analyzeCommercialQualityEvidence(data);
    expect(report.provenanceErrors).toEqual([]);
    expect(report.textPairedImprovementInProvidedSample).toBe(true);
    expect(report.textIndependentImprovementProven).toBe(false);
    expect(report.promotionAuthorized).toBe(false);
    data.holdoutFrame = data.holdout.map((page) => ({
      cursor: page.cursor,
      response: {
        schemaVersion: 1,
        scope: 'RANDOM_EVALUATION_FRAME',
        populationCoverageAvailable: false,
        since: page.response.since,
        until: page.response.until,
        scannedCaptureRows: page.response.items.length,
        samplingUnavailableRows: 0,
        complete: page.response.complete,
        nextCursor: page.response.nextCursor,
        items: page.response.items.map((row) => ({
          source: row.sample.source,
          ...row.sample.evidenceMetadata,
        })),
      } as unknown as CommercialReviewSamplingFrameResponse,
    }));
    expect(analyzeCommercialQualityEvidence(data).textIndependentImprovementProven).toBe(true);
    data.holdoutFrame[0]!.response.items.push({
      ...data.holdoutFrame[0]!.response.items[0]!,
      sourceSnapshotSha256: 'unreviewed-source',
      logicalMessageKey: 'unreviewed-logical',
    });
    const partial = analyzeCommercialQualityEvidence(data);
    expect(partial.frameCoverage.missingTextRevisions).toBe(1);
    expect(partial.textIndependentImprovementProven).toBe(false);
    data.holdoutFrame[0]!.response.items.pop();
    data.holdout[0]!.response.items[0]!.sample.evidenceMetadata!.candidateDecision!.messageDisposition =
      'DELETE';
    data.holdout[0]!.response.items[0]!.sample.evidenceMetadata!.candidateDecision!.actionBand =
      'WARN';
    data.holdout[0]!.response.items[0]!.sample.evidenceMetadata!.candidateDecision!.actionable = true;
    data.holdout[0]!.response.items[0]!.sample.evidenceMetadata!.candidateDecision!.deleteEligible = true;
    expect(analyzeCommercialQualityEvidence(data).textIndependentImprovementProven).toBe(false);
  });
  it('refuses inconsistent candidate permission and keeps absence separate from deletion', () => {
    const row = item('offer', 'DELETE', true, true);
    row.sample.evidenceMetadata!.candidateDecision!.actionable = false;
    row.sample.evidenceMetadata!.executionOutcome = 'ALREADY_ABSENT';
    const report = analyzeCommercialQualityEvidence(bundle([row]));
    expect(report.provenanceErrors).toContain('candidate_permission_inconsistent');
    expect(report.profiles[0]!.cleanupMisses.candidateErrors).toBe(1);
    expect(report.profiles[0]!.releasedExecution).toMatchObject({
      confirmedDeletionObservedUnits: 0,
      alreadyAbsentObservedUnits: 1,
      unknownUnits: 0,
    });
  });
});
