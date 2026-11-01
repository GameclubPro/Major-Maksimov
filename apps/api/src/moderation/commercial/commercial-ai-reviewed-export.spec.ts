import { createHash } from 'node:crypto';
import {
  COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES,
  commercialAiQualityEnvelopeSchema,
  type CommercialAiQualityEnvelope,
} from '@maxim/contracts/commercial-ai-quality';
import {
  commercialReviewEvidenceMetadataSchema,
  commercialReviewItemSchema,
  type CommercialReviewEvidenceMetadata,
  type CommercialReviewExportResponse,
} from '@maxim/contracts/safety-desk';
import {
  projectCommercialAiReviewedExport,
  type CommercialAiReviewedExportRow,
} from './commercial-ai-reviewed-export';
import { COMMERCIAL_LLM_POOL_PROFILES } from './commercial-llm-pool.protocol';
import { COMMERCIAL_LLM_POLICY_VERSION } from './commercial-llm.protocol';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const now = Date.parse('2026-11-01T12:00:00.000Z');
const humanReviewEvidenceHash = sha('synthetic-human-evidence');
const invalid = { schemaVersion: 1, captureState: 'INVALID', coverageIncomplete: true };

function fixture() {
  const excerpt = 'Посоветуйте проверенного мастера по холодильникам.';
  const messageCreatedAt = '2026-11-01T11:00:00.000Z';
  const metadata = commercialReviewEvidenceMetadataSchema.parse({
    schemaVersion: 2,
    samplingProbability: 0.1,
    samplingStratum: 'NO_HIT',
    randomEvaluationIncluded: true,
    evaluationSamplingProbability: 0.1,
    logicalMessageKey: sha('logical'),
    authorGroupId: sha('author'),
    campaignGroupId: sha('campaign'),
    campaignGroupIds: [sha('campaign')],
    campaignGroupingComplete: true,
    sourceSnapshotSha256: sha('original-source'),
    pseudonymizationKeyId: sha('pseudonym-key'),
    imageReviewRequired: false,
    sourceExcerptComplete: true,
    messageCreatedAt,
    settingsProfileDigest: sha('settings-profile'),
    detectorSourceSha256: sha('detector'),
    hasDetection: false,
    decisionOutcome: null,
    deleteEligible: null,
    executionOutcome: 'UNKNOWN',
    analysisOutcome: 'NOT_APPLICABLE',
    candidateDecision: null,
  });
  const ownReview = {
    label: 'NOT_COMMERCIAL',
    expectedDisposition: 'KEEP',
    reason: 'Синтетический пример',
    reviewedAt: '2026-11-01T11:30:00.000Z',
    kind: 'INDEPENDENT',
    evidenceKind: 'TEXT',
  };
  const item: CommercialReviewExportResponse['items'][number] = {
    sample: commercialReviewItemSchema.parse({
      id: 'synthetic-reviewed',
      chatId: 'synthetic-chat',
      chatTitle: 'SYNTHETIC TEST',
      source: 'TEXT',
      excerpt,
      score: 0,
      actionBand: 'NOT_EVALUATED',
      messageDisposition: 'KEEP',
      requiredPolicyCohorts: [],
      detectorVersion: 'commercial-ai-asynchronous-v1',
      decisionFingerprint: sha('decision'),
      reviewPriority: 50,
      reasons: [],
      label: null,
      historicalLabel: null,
      reviewReason: ownReview.reason,
      reviewedAt: ownReview.reviewedAt,
      ownReview,
      reviewState: 'AWAITING_SECOND',
      independentReviewCount: 1,
      decisionVisible: true,
      canReview: false,
      canAdjudicate: false,
      imageEvidenceAvailable: false,
      sourceExcerptComplete: true,
      evidenceMetadata: metadata,
      observedAt: messageCreatedAt,
      expiresAt: '2026-11-02T11:00:00.000Z',
      updatedAt: ownReview.reviewedAt,
    }),
    ratings: [],
    eligibleForIndependentCorpus: false,
  };
  const evidenceHash = sha('dedicated-ai-evidence');
  const envelope = commercialAiQualityEnvelopeSchema.parse({
    schemaVersion: 1,
    captureState: 'OBSERVED',
    source: {
      source: 'TEXT',
      evidenceHash,
      logicalMessageKey: metadata.logicalMessageKey,
      sourceSnapshotSha256: metadata.sourceSnapshotSha256,
      excerptSha256: sha(excerpt),
      messageCreatedAt,
      sourceExcerptComplete: true,
    },
    attempts: [
      {
        sourceKey: sha('source-key'),
        inputSha256: sha(excerpt),
        nonce: '00000000-0000-4000-8000-000000000001',
        sourceVersion: 2,
        sourceSha256: sha('original-text'),
        settingsSha256: sha('settings'),
        settingsProfileDigest: metadata.settingsProfileDigest,
        classifierIdentitySha256: sha('classifier'),
        submittedAtMs: Date.parse(messageCreatedAt),
        eventAtMs: Date.parse(messageCreatedAt),
        deadlineAtMs: Date.parse(messageCreatedAt) + 60_000,
        activeAuthority: 'AI_DELETE_ONLY',
        actualSynchronousDecision: { semantics: 'actual_post_routing_v1', decision: null },
        detectorBaseline: null,
        admission: { state: 'NOT_OBSERVED', reason: null },
        analysis: {
          state: 'NOT_STARTED',
          classificationOrigin: null,
          result: null,
          policyDeleteEligible: null,
          observedAt: null,
          reason: null,
        },
        registration: { state: 'NOT_REQUESTED', intentIdSha256: null, reason: null },
        execution: { state: 'NOT_REQUESTED', receiptSha256: null, observedAt: null },
      },
    ],
    overflowWriteCount: 0,
    lastOverflowAt: null,
    coverageIncomplete: true,
  });
  const row: CommercialAiReviewedExportRow = {
    humanReviewEvidenceHash,
    source: 'TEXT',
    evidenceHash,
    expiresAt: new Date(item.sample.expiresAt),
    excerpt,
    qualityMetadata: structuredClone(metadata),
    llmEnforcement: structuredClone(envelope),
    payloadOversized: false,
  };
  return { item, row, envelope };
}

describe('source-bound AI enrichment after own independent review', () => {
  it('exports the exact retained observation without turning missing inference into KEEP', () => {
    const { item, row, envelope } = fixture();
    const before = structuredClone({ item, row });
    const projection = projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now);
    expect(projection).toEqual(envelope);
    expect(projection).not.toBe(row.llmEnforcement);
    expect(
      projection?.captureState === 'OBSERVED' && projection.attempts[0]?.analysis,
    ).toMatchObject({
      state: 'NOT_STARTED',
      result: null,
    });
    expect({ item, row }).toEqual(before);
    expect(
      projection?.captureState === 'OBSERVED' && projection.attempts[0]?.deadlineAtMs,
    ).toBeLessThan(now);
  });

  it.each(['hidden', 'missing-own-review'] as const)(
    'reveals neither predictions nor their presence while the actor is %s',
    (kind) => {
      const { item, row } = fixture();
      if (kind === 'hidden') item.sample.decisionVisible = false;
      else item.sample.ownReview = null;
      expect(
        projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now),
      ).toBeNull();
      expect(
        projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row, row], now),
      ).toBeNull();
    },
  );

  it('keeps absent observations and expired retained sources unavailable', () => {
    const { item, row } = fixture();
    expect(projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [], now)).toBeNull();
    row.expiresAt = new Date(now);
    expect(projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now)).toBeNull();
    row.expiresAt = new Date(now + 1000);
    item.sample.expiresAt = new Date(now).toISOString();
    expect(projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now)).toBeNull();
  });

  it('refuses ambiguous indexed heads even when only one candidate is live', () => {
    const { item, row } = fixture();
    const expired = { ...row, expiresAt: new Date(now - 1) };
    expect(
      projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row, expired], now),
    ).toEqual(invalid);
    expect(
      projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row, row, row], now),
    ).toEqual(invalid);
  });

  it.each([
    'human-key',
    'evidence-key',
    'source',
    'excerpt',
    'privacy',
    'incomplete-source',
    'oversized-flag',
    'oversized-envelope',
    'oversized-metadata',
    'malformed-envelope',
  ] as const)('returns only an INVALID marker for %s', (kind) => {
    const { item, row } = fixture();
    if (kind === 'human-key') row.humanReviewEvidenceHash = sha('different-human');
    if (kind === 'evidence-key') row.evidenceHash = sha('different-evidence');
    if (kind === 'source') row.source = 'OCR';
    if (kind === 'excerpt') row.excerpt = 'Другой текст';
    if (kind === 'privacy') item.sample.excerpt = row.excerpt = 'Звоните +7 999 123-45-67';
    if (kind === 'incomplete-source') item.sample.sourceExcerptComplete = false;
    if (kind === 'oversized-flag') row.payloadOversized = true;
    if (kind === 'oversized-envelope')
      row.llmEnforcement = { extra: 'x'.repeat(COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES) };
    if (kind === 'oversized-metadata') row.qualityMetadata = { extra: 'x'.repeat(32 * 1024) };
    if (kind === 'malformed-envelope') row.llmEnforcement = { privateError: 'PRIVATE SENTINEL' };
    const projection = projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now);
    expect(projection).toEqual(invalid);
    expect(JSON.stringify(projection)).not.toContain('PRIVATE SENTINEL');
  });

  it.each([
    'logicalMessageKey',
    'sourceSnapshotSha256',
    'settingsProfileDigest',
    'pseudonymizationKeyId',
    'authorGroupId',
    'campaignGroupId',
    'detectorSourceSha256',
    'messageCreatedAt',
    'campaignGroupIds',
    'samplingProbability',
    'evaluationSamplingProbability',
    'randomEvaluationIncluded',
    'campaignGroupingComplete',
    'sourceExcerptComplete',
    'imageReviewRequired',
  ] as const)('retains a gap when dedicated %s differs from the reviewed source', (key) => {
    const { item, row } = fixture();
    const metadata = row.qualityMetadata as CommercialReviewEvidenceMetadata;
    if (key === 'messageCreatedAt') metadata[key] = '2026-11-01T11:00:01.000Z';
    else if (key === 'campaignGroupIds') metadata[key] = [sha('different-campaign')];
    else if (key === 'samplingProbability' || key === 'evaluationSamplingProbability')
      metadata[key] = 0.2;
    else if (key === 'imageReviewRequired') metadata[key] = true;
    else if (
      key === 'randomEvaluationIncluded' ||
      key === 'campaignGroupingComplete' ||
      key === 'sourceExcerptComplete'
    )
      metadata[key] = false;
    else metadata[key] = sha('different-provenance');
    expect(projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now)).toEqual(
      invalid,
    );
  });

  it.each([
    'source-snapshot',
    'source-clock',
    'source-logical',
    'source-excerpt',
    'attempt-excerpt',
    'attempt-settings',
  ] as const)('requires the envelope and each attempt to match the reviewed %s', (kind) => {
    const { item, row } = fixture();
    const envelope = row.llmEnforcement as CommercialAiQualityEnvelope;
    if (kind === 'source-snapshot') envelope.source.sourceSnapshotSha256 = sha('different-source');
    if (kind === 'source-clock') envelope.source.messageCreatedAt = '2026-11-01T11:00:01.000Z';
    if (kind === 'source-logical') envelope.source.logicalMessageKey = sha('different-logical');
    if (kind === 'source-excerpt') envelope.source.excerptSha256 = sha('different-input');
    if (kind === 'attempt-excerpt') envelope.attempts[0]!.inputSha256 = sha('different-input');
    if (kind === 'attempt-settings')
      envelope.attempts[0]!.settingsProfileDigest = sha('different-settings');
    expect(projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now)).toEqual(
      invalid,
    );
  });

  it('preserves technical failure as an observed failure independently of human judgment', () => {
    const { item, row } = fixture();
    const envelope = row.llmEnforcement as CommercialAiQualityEnvelope;
    const attempt = envelope.attempts[0]!;
    attempt.admission = { state: 'ACCEPTED', reason: null };
    attempt.analysis = {
      state: 'TECHNICAL_FAILURE',
      classificationOrigin: null,
      result: null,
      policyDeleteEligible: null,
      observedAt: new Date(attempt.submittedAtMs + 1000).toISOString(),
      reason: 'TIMEOUT',
    };
    const projection = projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now);
    expect(projection?.captureState === 'OBSERVED' && projection.attempts[0]?.analysis).toEqual(
      attempt.analysis,
    );
    expect(item.sample.ownReview?.label).toBe('NOT_COMMERCIAL');
  });

  it('exports disagreement and exact DELETE receipts without turning the human label into a model answer', () => {
    const { item, row } = fixture();
    const envelope = row.llmEnforcement as CommercialAiQualityEnvelope;
    const attempt = envelope.attempts[0]!;
    attempt.admission = { state: 'ACCEPTED', reason: null };
    attempt.analysis = {
      state: 'COMPLETE',
      classificationOrigin: 'MODEL',
      result: {
        ...COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity,
        classification: 'COMMERCIAL',
        reasonCodes: ['COMMERCIAL_OFFER'],
        policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
        durationMs: 1000,
        pool: {
          version: 'commercial-pool-v2',
          nodeId: 'pc-b-9b',
          route: 'direct',
          policy: 'confirm-positive',
          attempts: 1,
        },
      },
      policyDeleteEligible: true,
      observedAt: new Date(attempt.submittedAtMs + 1000).toISOString(),
      reason: null,
    };
    attempt.registration = {
      state: 'REGISTERED',
      intentIdSha256: sha('exact-intent'),
      reason: null,
    };
    attempt.execution = {
      state: 'CONFIRMED_DELETE',
      receiptSha256: sha('exact-receipt'),
      observedAt: new Date(attempt.submittedAtMs + 1100).toISOString(),
    };
    const projection = projectCommercialAiReviewedExport(item, humanReviewEvidenceHash, [row], now);
    expect(projection).toEqual(envelope);
    expect(item.sample.ownReview?.label).toBe('NOT_COMMERCIAL');
    expect(item.eligibleForIndependentCorpus).toBe(false);
  });
});
