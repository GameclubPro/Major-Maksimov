import { describe, expect, it } from 'vitest';
import {
  commercialAiQualityAnalysisSchema,
  commercialAiQualityAttemptSchema,
  commercialAiQualityEnvelopeSchema,
  commercialAiQualityExecutionSchema,
  commercialAiQualityProjectionSchema,
  commercialAiQualityResultSchema,
  commercialAiReviewItemSchema,
  commercialAiReviewExportResponseSchema,
  type CommercialAiQualityAttempt,
  type CommercialAiQualityEnvelope,
  type CommercialAiQualityResult,
} from '@maxim/contracts/commercial-ai-quality';
import {
  commercialReviewExportResponseSchema,
  commercialReviewItemSchema,
  commercialReviewSamplingFrameItemSchema,
} from '@maxim/contracts/safety-desk';

// FLAG: Synthetic schema fixtures only; these are not model runs, HUMAN ratings or quality evidence.
const date = '2026-11-01T00:00:00.000Z';
const timestamp = Date.parse(date);
const hex = (digit: string) => digit.repeat(64);
const source = {
  source: 'TEXT' as const,
  evidenceHash: hex('a'),
  logicalMessageKey: hex('b'),
  sourceSnapshotSha256: hex('c'),
  excerptSha256: hex('d'),
  messageCreatedAt: date,
  sourceExcerptComplete: true as const,
};
const snapshot = {
  hasDetection: false,
  actionable: false,
  deleteEligible: false,
  score: 0,
  actionBand: 'KEEP',
  messageDisposition: 'KEEP' as const,
  detectorVersion: 'synthetic-v1',
  decisionFingerprint: 'synthetic-decision',
  reasons: [],
  requiredPolicyCohorts: [],
};
function result(overrides: Partial<CommercialAiQualityResult> = {}): CommercialAiQualityResult {
  return {
    classification: 'NOT_COMMERCIAL',
    reasonCodes: ['ORDINARY_DISCUSSION'],
    modelAlias: 'synthetic-model-9b',
    modelSha256: hex('1'),
    promptSha256: hex('2'),
    chatTemplateSha256: hex('3'),
    runtimeVersion: 'synthetic-runtime',
    runtimeImageSha256: hex('4'),
    policyVersion: 'synthetic-policy',
    durationMs: 1000,
    pool: {
      version: 'commercial-pool-v2',
      nodeId: 'server-9b',
      route: 'direct',
      policy: 'confirm-positive',
      attempts: 1,
    },
    ...overrides,
  };
}
function attempt(overrides: Partial<CommercialAiQualityAttempt> = {}): CommercialAiQualityAttempt {
  return {
    sourceKey: hex('5'),
    inputSha256: hex('6'),
    nonce: '11111111-1111-4111-8111-111111111111',
    sourceVersion: 2,
    sourceSha256: hex('7'),
    settingsSha256: hex('8'),
    settingsProfileDigest: hex('9'),
    classifierIdentitySha256: hex('0'),
    submittedAtMs: timestamp + 100,
    eventAtMs: timestamp,
    deadlineAtMs: timestamp + 60_000,
    activeAuthority: 'AI_DELETE_ONLY',
    actualSynchronousDecision: { semantics: 'actual_post_routing_v1', decision: snapshot },
    detectorBaseline: {
      semantics: 'counterfactual_pre_routing_v1',
      detectorSourceSha256: hex('e'),
      decision: {
        ...snapshot,
        hasDetection: true,
        actionable: true,
        deleteEligible: true,
        score: 99,
        actionBand: 'DELETE_ONLY',
        messageDisposition: 'DELETE',
      },
    },
    admission: { state: 'ACCEPTED', reason: null },
    analysis: {
      state: 'NOT_STARTED',
      classificationOrigin: null,
      result: null,
      policyDeleteEligible: null,
      reason: null,
      observedAt: null,
    },
    registration: { state: 'NOT_REQUESTED', intentIdSha256: null, reason: null },
    execution: { state: 'NOT_REQUESTED', receiptSha256: null, observedAt: null },
    ...overrides,
  };
}
function envelope(attempts = [attempt()]): CommercialAiQualityEnvelope {
  return {
    schemaVersion: 1,
    captureState: 'OBSERVED',
    source,
    attempts,
    overflowWriteCount: 0,
    lastOverflowAt: null,
    coverageIncomplete: false,
  };
}
const completed = (value = result()) => ({
  state: 'COMPLETE' as const,
  classificationOrigin: 'MODEL' as const,
  result: value,
  policyDeleteEligible: false,
  reason: null,
  observedAt: '2026-11-01T00:00:01.000Z',
});

describe('bounded commercial AI quality observation contracts', () => {
  it('preserves actual synchronous KEEP and the separate detector baseline DELETE', () => {
    const parsed = commercialAiQualityEnvelopeSchema.parse(envelope());
    expect(parsed.attempts[0]?.actualSynchronousDecision.decision?.messageDisposition).toBe('KEEP');
    expect(parsed.attempts[0]?.detectorBaseline?.decision.messageDisposition).toBe('DELETE');
    expect(parsed.attempts[0]?.analysis.result).toBeNull();
  });

  it('keeps technical/missing outcomes separate from real model UNSURE', () => {
    const unsure = result({ classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] });
    expect(commercialAiQualityAnalysisSchema.safeParse(completed(unsure)).success).toBe(true);
    for (const invalid of [
      { ...completed(), state: 'TECHNICAL_FAILURE', reason: 'UNAVAILABLE' },
      { ...completed(), result: null },
      { ...completed(), reason: 'TIMEOUT' },
      { ...completed(), reason: 'UNAVAILABLE' },
      { ...completed(), state: 'NOT_STARTED', result: null },
      {
        ...completed(),
        result: null,
        classificationOrigin: null,
        state: 'TECHNICAL_FAILURE',
        policyDeleteEligible: false,
        reason: 'UNAVAILABLE',
      },
    ])
      expect(commercialAiQualityAnalysisSchema.safeParse(invalid).success).toBe(false);
    expect(
      commercialAiQualityAnalysisSchema.safeParse({
        state: 'TECHNICAL_FAILURE',
        result: null,
        classificationOrigin: null,
        policyDeleteEligible: null,
        observedAt: date,
        reason: 'UNAVAILABLE',
      }).success,
    ).toBe(true);
  });

  it('marks a lost 9B consultation as policy abstention rather than model uncertainty', () => {
    const unresolved = result({
      classification: 'UNSURE',
      reasonCodes: ['INSUFFICIENT_CONTEXT'],
      pool: {
        version: 'commercial-pool-v2',
        nodeId: 'pc-a-4b',
        route: 'direct',
        policy: 'confirm-positive',
        attempts: 1,
        primaryNodeId: 'pc-a-4b',
        primaryClassification: 'COMMERCIAL',
        primaryDurationMs: 100,
        consultationOutcome: 'no_capacity',
      },
    });
    const observation = {
      ...completed(unresolved),
      classificationOrigin: 'POLICY_ABSTENTION',
      reason: 'NO_CAPACITY',
    };
    expect(commercialAiQualityAnalysisSchema.safeParse(observation).success).toBe(true);
    for (const reason of [null, 'BUDGET_EXHAUSTED', 'TIMEOUT'])
      expect(commercialAiQualityAnalysisSchema.safeParse({ ...observation, reason }).success).toBe(
        false,
      );
    expect(
      commercialAiQualityAnalysisSchema.safeParse({ ...observation, classificationOrigin: 'MODEL' })
        .success,
    ).toBe(false);
    expect(
      commercialAiQualityAnalysisSchema.safeParse({
        ...observation,
        result: result({ classification: 'UNSURE', reasonCodes: ['INSUFFICIENT_CONTEXT'] }),
      }).success,
    ).toBe(false);
  });

  it('preserves a commercial prediction vetoed by the legacy negative-audit policy', () => {
    const audited = result({
      classification: 'COMMERCIAL',
      reasonCodes: ['COMMERCIAL_OFFER'],
      pool: undefined,
      cascade: {
        version: 'synthetic-cascade',
        route: 'secondary_audit',
        primaryClassification: 'NOT_COMMERCIAL',
        primaryModelSha256: hex('f'),
      },
    });
    expect(commercialAiQualityAnalysisSchema.safeParse(completed(audited)).success).toBe(true);
    expect(
      commercialAiQualityAnalysisSchema.safeParse({
        ...completed(audited),
        policyDeleteEligible: true,
      }).success,
    ).toBe(false);
  });

  it('does not equate an unconfirmed direct 4B positive with permission to delete', () => {
    const positive = result({
      classification: 'COMMERCIAL',
      reasonCodes: ['COMMERCIAL_OFFER'],
      pool: {
        version: 'commercial-pool-v2',
        nodeId: 'pc-a-4b',
        route: 'direct',
        policy: 'confirm-positive',
        attempts: 1,
      },
    });
    expect(commercialAiQualityAnalysisSchema.safeParse(completed(positive)).success).toBe(true);
    expect(
      commercialAiQualityAnalysisSchema.safeParse({
        ...completed(positive),
        policyDeleteEligible: true,
      }).success,
    ).toBe(false);
  });

  it('rejects mixed routes, incompatible reason codes and arbitrary model payloads', () => {
    for (const invalid of [
      result({ classification: 'COMMERCIAL', reasonCodes: ['PERSONAL_SALE'] }),
      result({ reasonCodes: ['ORDINARY_DISCUSSION', 'ORDINARY_DISCUSSION'] }),
      { ...result(), text: 'synthetic private sentinel' },
      result({ cascade: { version: 'synthetic', route: 'primary', primaryModelSha256: hex('a') } }),
      result({
        pool: {
          version: 'commercial-pool-v2',
          nodeId: 'pc-b-9b',
          route: 'consulted',
          policy: 'confirm-positive',
          attempts: 1,
        },
      }),
    ])
      expect(commercialAiQualityResultSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires the exact pending/registered lifecycle and a durable receipt for confirmed effects', () => {
    const positive = result({ classification: 'COMMERCIAL', reasonCodes: ['COMMERCIAL_OFFER'] });
    const registered = attempt({
      analysis: { ...completed(positive), policyDeleteEligible: true },
      registration: { state: 'REGISTERED', intentIdSha256: hex('f'), reason: null },
      execution: { state: 'PENDING', receiptSha256: null, observedAt: date },
    });
    expect(commercialAiQualityAttemptSchema.safeParse(registered).success).toBe(true);
    expect(
      commercialAiQualityAttemptSchema.safeParse({
        ...registered,
        registration: { state: 'NOT_REQUESTED', intentIdSha256: null, reason: null },
      }).success,
    ).toBe(false);
    expect(
      commercialAiQualityExecutionSchema.safeParse({
        state: 'CONFIRMED_DELETE',
        receiptSha256: null,
        observedAt: date,
      }).success,
    ).toBe(false);
    expect(
      commercialAiQualityExecutionSchema.safeParse({
        state: 'ALREADY_ABSENT',
        receiptSha256: hex('e'),
        observedAt: date,
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate attempts, a ninth entry and falsely complete overflow/missing context', () => {
    const eight = Array.from({ length: 8 }, (_, index) =>
      attempt({ sourceKey: index.toString(16).repeat(64) }),
    );
    expect(commercialAiQualityEnvelopeSchema.safeParse(envelope(eight)).success).toBe(true);
    for (const invalid of [
      envelope([attempt(), attempt()]),
      envelope([...eight, attempt()]),
      { ...envelope(), overflowWriteCount: 1, lastOverflowAt: date },
      envelope([attempt({ detectorBaseline: null })]),
      { ...envelope(), certification: 'synthetic' },
    ])
      expect(commercialAiQualityEnvelopeSchema.safeParse(invalid).success).toBe(false);
    expect(
      commercialAiQualityEnvelopeSchema.safeParse({
        ...envelope(),
        overflowWriteCount: 1,
        lastOverflowAt: date,
        coverageIncomplete: true,
      }).success,
    ).toBe(true);
  });

  it('enforces the total UTF-8 envelope byte limit in addition to field/entry bounds', () => {
    const longCodes = Array.from(
      { length: 32 },
      (_, index) => String(index).padStart(3, '0') + 'x'.repeat(117),
    );
    const large = { ...snapshot, reasons: longCodes, requiredPolicyCohorts: longCodes };
    const attempts = Array.from({ length: 8 }, (_, index) =>
      attempt({
        sourceKey: index.toString(16).repeat(64),
        actualSynchronousDecision: { semantics: 'actual_post_routing_v1', decision: large },
        detectorBaseline: {
          semantics: 'counterfactual_pre_routing_v1',
          detectorSourceSha256: hex('e'),
          decision: large,
        },
      }),
    );
    expect(commercialAiQualityEnvelopeSchema.safeParse(envelope(attempts)).success).toBe(false);
  });

  it('keeps invalid capture explicit and prevents AI evidence in blind cards and frame rows', () => {
    const invalid = { schemaVersion: 1, captureState: 'INVALID', coverageIncomplete: true };
    expect(commercialAiQualityProjectionSchema.safeParse(invalid).success).toBe(true);
    const blind = {
      id: 'synthetic',
      chatId: null,
      chatTitle: 'Synthetic',
      source: 'TEXT',
      excerpt: 'Synthetic text',
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
      sourceExcerptComplete: true,
      evidenceMetadata: null,
      observedAt: date,
      expiresAt: date,
      updatedAt: date,
    };
    expect(commercialReviewItemSchema.safeParse(blind).success).toBe(true);
    expect(
      commercialReviewItemSchema.parse({ ...blind, llmEnforcement: envelope() }),
    ).not.toHaveProperty('llmEnforcement');
    expect(commercialAiReviewItemSchema.safeParse(blind).success).toBe(true);
    expect(commercialAiReviewItemSchema.safeParse({ ...blind, llmEnforcement: null }).success).toBe(
      true,
    );
    expect(
      commercialAiReviewItemSchema.safeParse({ ...blind, llmEnforcement: envelope() }).success,
    ).toBe(false);
    expect(
      commercialAiReviewItemSchema.safeParse({ ...blind, llmEnforcement: invalid }).success,
    ).toBe(false);
    const reviewed = { ...blind, decisionVisible: true };
    expect(
      commercialReviewItemSchema.parse({ ...reviewed, llmEnforcement: envelope() }),
    ).not.toHaveProperty('llmEnforcement');
    expect(
      commercialAiReviewItemSchema.safeParse({ ...reviewed, llmEnforcement: envelope() }).success,
    ).toBe(true);
    expect(
      commercialAiReviewItemSchema.safeParse({ ...reviewed, llmEnforcement: invalid }).success,
    ).toBe(true);
    expect(
      commercialAiReviewItemSchema.safeParse({
        ...reviewed,
        llmEnforcement: { ...envelope(), rawText: 'private' },
      }).success,
    ).toBe(false);
    const historical = commercialReviewExportResponseSchema.parse({
      generatedAt: date,
      scope: 'OWN_REVIEWED',
      populationCoverageAvailable: false,
      since: date,
      until: date,
      complete: true,
      nextCursor: null,
      items: [{ sample: reviewed, ratings: [], eligibleForIndependentCorpus: false }],
    });
    expect(
      commercialAiReviewExportResponseSchema.parse(historical).items[0]!.sample.llmEnforcement,
    ).toBeUndefined();
    const detailed = {
      ...historical,
      items: [{ ...historical.items[0]!, sample: { ...reviewed, llmEnforcement: envelope() } }],
    };
    expect(
      commercialAiReviewExportResponseSchema.parse(detailed).items[0]!.sample.llmEnforcement,
    ).toEqual(envelope());
    expect(
      commercialReviewExportResponseSchema.parse(detailed).items[0]!.sample,
    ).not.toHaveProperty('llmEnforcement');
    expect(
      commercialAiReviewExportResponseSchema.safeParse({
        ...detailed,
        items: [{ ...detailed.items[0]!, sample: { ...blind, llmEnforcement: envelope() } }],
      }).success,
    ).toBe(false);
    expect(
      commercialReviewSamplingFrameItemSchema.safeParse({
        source: 'TEXT',
        observedAt: date,
        sourceSnapshotSha256: hex('a'),
        logicalMessageKey: hex('b'),
        pseudonymizationKeyId: hex('c'),
        settingsProfileDigest: hex('d'),
        campaignGroupingComplete: true,
        messageCreatedAt: date,
        evaluationSamplingProbability: 0.1,
        llmEnforcement: envelope(),
      }).success,
    ).toBe(false);
  });
});
