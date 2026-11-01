import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commercialAiQualityAttemptSchema,
  commercialAiQualityEnvelopeSchema,
  commercialAiReviewExportItemSchema,
  commercialAiReviewExportResponseSchema,
  commercialAiReviewItemSchema,
  type CommercialAiQualityResult,
} from '@maxim/contracts/commercial-ai-quality';
import {
  commercialReviewEvidenceMetadataSchema,
  commercialReviewExportResponseSchema,
  commercialReviewSamplingFrameResponseSchema,
} from '@maxim/contracts/safety-desk';
import { COMMERCIAL_LLM_POOL_PROFILES } from '../moderation/commercial/commercial-llm-pool.protocol';
import { COMMERCIAL_LLM_POLICY_VERSION } from '../moderation/commercial/commercial-llm.protocol';
import { COMMERCIAL_QUALITY_EVALUATION_PROBABILITY } from '../moderation/commercial/commercial-quality-sampling';
import {
  analyzeCommercialAiQualityEvidence,
  commercialAiQualityDigest as sha,
  commercialAiQualityEvidenceSchema,
  commercialAiQualityExpectedIdentity,
  type CommercialAiQualityEvidence,
} from './commercial-ai-quality-report';
import { reportCommercialAiQuality } from './report-commercial-ai-quality';

// Synthetic schema fixtures only: these identities and ratings are not human evidence or a release artifact.
const evaluatedAt = '2026-09-22T00:00:00.000Z';
const now = Date.parse(evaluatedAt);
const inputDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function result(
  classification: CommercialAiQualityResult['classification'] = 'COMMERCIAL',
): CommercialAiQualityResult {
  const { protocolVersion: _protocolVersion, ...identity } =
    COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity;
  void _protocolVersion;
  return {
    ...identity,
    classification,
    reasonCodes:
      classification === 'COMMERCIAL'
        ? ['COMMERCIAL_OFFER']
        : classification === 'UNSURE'
          ? ['INSUFFICIENT_CONTEXT']
          : ['ORDINARY_DISCUSSION'],
    durationMs: 1000,
    policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
    pool: {
      version: 'commercial-pool-v2',
      nodeId: 'pc-b-9b',
      route: 'direct',
      policy: 'confirm-positive',
      attempts: 1,
    },
  };
}
function row(id: string, at: string, expected: 'KEEP' | 'DELETE' = 'KEEP') {
  const excerpt = 'SYNTHETIC PRIVATE SENTINEL ASCII A / Кириллица / 🚀 / Cafe\u0301\r\n';
  const decision = {
    hasDetection: false,
    actionable: false,
    deleteEligible: false,
    score: 0,
    actionBand: 'ALLOW',
    messageDisposition: 'KEEP',
    detectorVersion: 'synthetic',
    decisionFingerprint: sha(id),
    reasons: [],
    requiredPolicyCohorts: [],
  };
  const metadata = commercialReviewEvidenceMetadataSchema.parse({
    schemaVersion: 2,
    samplingProbability: 0.1,
    samplingStratum: 'NO_HIT',
    randomEvaluationIncluded: true,
    evaluationSamplingProbability: COMMERCIAL_QUALITY_EVALUATION_PROBABILITY,
    logicalMessageKey: sha(`logical-${id}`),
    authorGroupId: sha(`author-${id}`),
    campaignGroupId: sha(`campaign-${id}`),
    campaignGroupIds: [],
    campaignGroupingComplete: true,
    sourceSnapshotSha256: sha(`source-${id}`),
    pseudonymizationKeyId: sha('synthetic-key'),
    imageReviewRequired: false,
    sourceExcerptComplete: true,
    messageCreatedAt: at,
    settingsProfileDigest: sha('settings'),
    detectorSourceSha256: sha('detector'),
    hasDetection: false,
    decisionOutcome: 'KEEP',
    deleteEligible: false,
    executionOutcome: 'NOT_REQUESTED',
    analysisOutcome: 'COMPLETE',
    candidateDecision: null,
  });
  const attempt = commercialAiQualityAttemptSchema.parse({
    sourceKey: sha(`attempt-${id}`),
    inputSha256: inputDigest(excerpt),
    nonce: '00000000-0000-4000-8000-000000000001',
    sourceVersion: 2,
    sourceSha256: sha(`raw-${id}`),
    settingsSha256: sha('ai-settings'),
    settingsProfileDigest: metadata.settingsProfileDigest,
    classifierIdentitySha256:
      commercialAiQualityExpectedIdentity('confirm-positive').classifierIdentitySha256,
    submittedAtMs: Date.parse(at),
    eventAtMs: Date.parse(at),
    deadlineAtMs: Date.parse(at) + 60_000,
    activeAuthority: 'AI_DELETE_ONLY',
    actualSynchronousDecision: { semantics: 'actual_post_routing_v1', decision },
    detectorBaseline: {
      semantics: 'counterfactual_pre_routing_v1',
      detectorSourceSha256: metadata.detectorSourceSha256,
      decision,
    },
    admission: { state: 'ACCEPTED', reason: null },
    analysis: {
      state: 'COMPLETE',
      observedAt: new Date(Date.parse(at) + 1000).toISOString(),
      classificationOrigin: 'MODEL',
      result: result(expected === 'DELETE' ? 'COMMERCIAL' : 'NOT_COMMERCIAL'),
      policyDeleteEligible: expected === 'DELETE',
      reason: null,
    },
    registration: { state: 'NOT_REQUESTED', intentIdSha256: null, reason: null },
    execution: { state: 'NOT_REQUESTED', receiptSha256: null, observedAt: null },
  });
  const llmEnforcement = commercialAiQualityEnvelopeSchema.parse({
    schemaVersion: 1,
    captureState: 'OBSERVED',
    source: {
      source: 'TEXT',
      evidenceHash: sha(`evidence-${id}`),
      logicalMessageKey: metadata.logicalMessageKey,
      sourceSnapshotSha256: metadata.sourceSnapshotSha256,
      excerptSha256: attempt.inputSha256,
      messageCreatedAt: at,
      sourceExcerptComplete: true,
    },
    attempts: [attempt],
    overflowWriteCount: 0,
    lastOverflowAt: null,
    coverageIncomplete: false,
  });
  const label = expected === 'KEEP' ? 'NOT_COMMERCIAL' : 'COMMERCIAL';
  const ratings = ['synthetic-reviewer-a', 'synthetic-reviewer-b'].map((reviewer) => ({
    reviewerKey: sha(reviewer),
    label,
    expectedDisposition: expected,
    kind: 'INDEPENDENT',
    evidenceKind: 'TEXT',
    sourceEvidenceDigest: null,
    reason: '',
    reviewedAt: id.startsWith('dev') ? '2026-09-09T00:00:00.000Z' : '2026-09-21T00:00:00.000Z',
  }));
  const sample = commercialAiReviewItemSchema.parse({
    id,
    chatId: null,
    chatTitle: 'SYNTHETIC TEST',
    source: 'TEXT',
    excerpt,
    score: 0,
    actionBand: 'ALLOW',
    messageDisposition: 'KEEP',
    requiredPolicyCohorts: ['synthetic-protected'],
    detectorVersion: 'synthetic',
    decisionFingerprint: sha(id),
    reviewPriority: 50,
    reasons: [],
    label,
    historicalLabel: null,
    reviewReason: '',
    reviewedAt: ratings[0]!.reviewedAt,
    ownReview: ratings[0],
    reviewState: 'RESOLVED',
    independentReviewCount: 2,
    decisionVisible: true,
    canReview: false,
    canAdjudicate: false,
    imageEvidenceAvailable: false,
    sourceExcerptComplete: true,
    evidenceMetadata: metadata,
    llmEnforcement,
    observedAt: at,
    expiresAt: '2026-10-01T00:00:00.000Z',
    updatedAt: ratings[0]!.reviewedAt,
  });
  return commercialAiReviewExportItemSchema.parse({
    sample,
    ratings,
    eligibleForIndependentCorpus: true,
  });
}
function bundle(): CommercialAiQualityEvidence {
  const makePages = (items: ReturnType<typeof row>[], dev: boolean) => [
    {
      cursor: null,
      response: commercialAiReviewExportResponseSchema.parse({
        generatedAt: dev ? '2026-09-09T00:00:00.000Z' : evaluatedAt,
        scope: 'OWN_REVIEWED',
        populationCoverageAvailable: false,
        since: dev ? '2026-09-01T00:00:00.000Z' : '2026-09-11T00:00:00.000Z',
        until: dev ? '2026-09-09T00:00:00.000Z' : '2026-09-21T00:00:00.000Z',
        items,
        complete: true,
        nextCursor: null,
      }),
    },
  ];
  const development = makePages(
    [row('dev-a', '2026-09-01T00:00:00.000Z'), row('dev-b', '2026-09-08T00:00:00.000Z')],
    true,
  );
  const holdout = makePages(
    [
      row('hold-a', '2026-09-12T00:00:00.000Z'),
      row('hold-b', '2026-09-19T00:00:00.000Z', 'DELETE'),
    ],
    false,
  );
  const frame = (pages: typeof development) =>
    pages.map((page) => ({
      cursor: page.cursor,
      response: commercialReviewSamplingFrameResponseSchema.parse({
        ...page.response,
        schemaVersion: 1,
        scope: 'RANDOM_EVALUATION_FRAME',
        scannedCaptureRows: page.response.items.length,
        samplingUnavailableRows: 0,
        items: page.response.items.map(({ sample }) => ({
          source: sample.source,
          observedAt: sample.observedAt,
          sourceSnapshotSha256: sample.evidenceMetadata!.sourceSnapshotSha256,
          logicalMessageKey: sample.evidenceMetadata!.logicalMessageKey,
          pseudonymizationKeyId: sample.evidenceMetadata!.pseudonymizationKeyId,
          settingsProfileDigest: sample.evidenceMetadata!.settingsProfileDigest,
          campaignGroupingComplete: true,
          messageCreatedAt: sample.evidenceMetadata!.messageCreatedAt,
          evaluationSamplingProbability: COMMERCIAL_QUALITY_EVALUATION_PROBABILITY,
        })),
      }),
    }));
  const developmentFrame = frame(development);
  const holdoutFrame = frame(holdout);
  const manifest = {
    ...commercialAiQualityExpectedIdentity('confirm-positive'),
    policyFrozenAt: '2026-09-10T00:00:00.000Z',
    developmentFrameSha256: sha(developmentFrame),
    holdoutFrameSha256: sha(holdoutFrame),
    requiredProtectedCohorts: ['synthetic-protected'],
  };
  return commercialAiQualityEvidenceSchema.parse({
    schemaVersion: 'commercial-ai-quality-evidence/v1',
    mode: 'INDEPENDENT_REVIEW',
    evaluatedAt,
    development,
    holdout,
    developmentFrame,
    holdoutFrame,
    manifest,
    manifestSha256: sha(manifest),
  });
}
const analyze = (input: CommercialAiQualityEvidence) =>
  analyzeCommercialAiQualityEvidence(input, { now });

describe('AI evidence report, without manufacturing independent truth', () => {
  it('produces an honest usable report with no reviewers or model observations', () => {
    const input = commercialAiQualityEvidenceSchema.parse({
      schemaVersion: 'commercial-ai-quality-evidence/v1',
      mode: 'CAPTURE_DIAGNOSTIC',
      evaluatedAt,
      captures: [{ captureKey: sha('unreviewed') }],
    });
    const report = analyze(input);
    expect(report.evidenceSufficient).toBe(false);
    expect(report.provenanceErrors).toEqual(
      expect.arrayContaining([
        'development_frame_missing',
        'holdout_frame_missing',
        'source_bound_ai_evidence_incomplete',
      ]),
    );
    expect(report.coverage).toMatchObject({
      suppliedCaptures: 1,
      suppliedCapturesWithoutIndependentLabels: 1,
      noAiObservation: 1,
      policyDeleteEligible: 0,
    });
    expect(report.classification).toMatchObject({ missingOrInvalid: 1, unsure: 0 });
    expect(report.promotionAuthorized).toBe(false);
  });
  it('keeps provisional AI references, abstention, technical loss and stale identity separate', () => {
    const input = commercialAiQualityEvidenceSchema.parse({
      schemaVersion: 'commercial-ai-quality-evidence/v1',
      mode: 'AI_REFERENCE',
      evaluatedAt,
      captures: [
        { captureKey: sha('c'), diagnosticStatus: 'COMPLETE', diagnosticResult: result() },
        { captureKey: sha('u'), diagnosticStatus: 'COMPLETE', diagnosticResult: result('UNSURE') },
        { captureKey: sha('f'), diagnosticStatus: 'TECHNICAL_INCOMPLETE' },
        {
          captureKey: sha('bad'),
          diagnosticStatus: 'COMPLETE',
          diagnosticResult: { ...result(), promptSha256: sha('wrong') },
        },
      ],
      aiReferences: [
        { captureKey: sha('c'), label: 'COMMERCIAL' },
        { captureKey: sha('u'), label: 'PROTECTED' },
        { captureKey: sha('f'), label: 'COMMERCIAL' },
      ],
    });
    const report = analyze(input);
    expect(report.aiReferenceDiagnostic.counts).toEqual({
      COMMERCIAL: { COMMERCIAL: 1, NOT_OBSERVED_OR_INVALID: 1 },
      PROTECTED: { UNSURE: 1 },
      UNKNOWN: { NOT_OBSERVED_OR_INVALID: 1 },
    });
    expect(report.classification).toMatchObject({ unsure: 1, missingOrInvalid: 2 });
    expect(report.coverage.invalidResultIdentity).toBe(1);
    expect(report.independentPolicyQuality.evaluated).toBe(false);
    expect(report.effects.confirmedDelete).toBe(0);
  });
  it('validates both complete frozen frames but does not pass statistical criteria with tiny fixtures', () => {
    const report = analyze(bundle());
    expect(report.provenanceErrors).toEqual([]);
    expect(report.evidenceSufficient).toBe(true);
    expect(report.independentPolicyQuality).toMatchObject({
      protectedUnits: 1,
      offerUnits: 1,
      eligibleOfferUnits: 1,
      unsafeDeletePermissions: 0,
      criteriaPass: false,
    });
    expect(report.independentClassification.finalClassificationCountsByDeclaredHumanLabel).toEqual({
      COMMERCIAL: { COMMERCIAL: 1 },
      NOT_COMMERCIAL: { NOT_COMMERCIAL: 1 },
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE SENTINEL');
    expect(report.humanTruthEstablishedByTool).toBe(false);
  });
  it('accepts historical base exports while reporting their missing detailed AI observation', () => {
    const input = bundle();
    for (const page of [...input.development, ...input.holdout]) {
      page.response = commercialReviewExportResponseSchema.parse(page.response);
    }
    const report = analyze(input);
    expect(report.evidenceSufficient).toBe(false);
    expect(report.coverage).toMatchObject({
      noAiObservation: 2,
      sourceBoundEvidenceMissingOrInvalid: 2,
    });
    expect(report.provenanceErrors).toContain('source_bound_ai_evidence_incomplete');
    expect(report.independentPolicyQuality.eligibleOfferUnits).toBe(0);
    expect(report.effects.confirmedDelete).toBe(0);
  });
  it.each(['labels', 'frame', 'identity', 'source', 'overlap', 'pagination'] as const)(
    'fails closed for %s gaps',
    (kind) => {
      const input = bundle();
      const row = input.holdout[0]!.response.items[0]!;
      if (kind === 'labels') row.ratings.pop();
      if (kind === 'frame') input.holdoutFrame = [];
      if (kind === 'identity') input.manifest!.profilesSha256 = sha('stale');
      if (kind === 'source' && row.sample.llmEnforcement?.captureState === 'OBSERVED')
        row.sample.llmEnforcement.source.excerptSha256 = sha('replacement');
      if (kind === 'overlap')
        row.sample.evidenceMetadata!.campaignGroupIds = [
          input.development[0]!.response.items[0]!.sample.evidenceMetadata!.campaignGroupId!,
        ];
      if (kind === 'pagination') {
        input.holdoutFrame[0]!.response.nextCursor = 'missing';
        input.holdoutFrame[0]!.response.complete = false;
      }
      expect(analyze(input).evidenceSufficient).toBe(false);
      expect(analyze(input).independentPolicyQuality.criteriaPass).toBe(false);
    },
  );
  it.each(['ascii', 'unicode', 'normalization', 'newline'] as const)(
    'rejects a model result bound to different reviewed excerpt bytes: %s',
    (change) => {
      const input = bundle();
      expect(analyze(input).evidenceSufficient).toBe(true);
      const sample = input.holdout[0]!.response.items[1]!.sample;
      const envelope = sample.llmEnforcement;
      if (envelope?.captureState !== 'OBSERVED') throw new Error('Synthetic envelope missing');
      expect(envelope.source.excerptSha256).toBe(inputDigest(sample.excerpt));
      expect(envelope.attempts[0]!.inputSha256).toBe(inputDigest(sample.excerpt));
      if (change === 'ascii') sample.excerpt = sample.excerpt.replace('ASCII A', 'ASCII B');
      if (change === 'unicode') sample.excerpt = sample.excerpt.replace('🚀', '🚁');
      if (change === 'normalization') sample.excerpt = sample.excerpt.normalize('NFC');
      if (change === 'newline') sample.excerpt = sample.excerpt.replace('\r\n', '\n');
      expect(inputDigest(sample.excerpt)).not.toBe(envelope.source.excerptSha256);
      const report = analyze(input);
      expect(report.evidenceSufficient).toBe(false);
      expect(report.provenanceErrors).toContain('source_bound_ai_evidence_incomplete');
      expect(report.independentPolicyQuality.eligibleOfferUnits).toBe(0);
      expect(
        report.independentClassification.finalClassificationCountsByDeclaredHumanLabel.COMMERCIAL,
      ).toEqual({ NO_VALID_RESULT: 1 });
    },
  );
  it('does not choose a later successful attempt or borrow another source receipt', () => {
    const input = bundle();
    const row = input.holdout[0]!.response.items[1]!;
    const envelope = row.sample.llmEnforcement;
    if (envelope?.captureState !== 'OBSERVED') throw new Error('Synthetic envelope missing');
    const later = structuredClone(envelope.attempts[0]!);
    later.sourceKey = sha('later');
    later.submittedAtMs += 1;
    const first = envelope.attempts[0]!;
    first.analysis = {
      state: 'TECHNICAL_FAILURE',
      observedAt: new Date(first.submittedAtMs + 20_000).toISOString(),
      classificationOrigin: null,
      result: null,
      policyDeleteEligible: null,
      reason: 'TIMEOUT',
    };
    envelope.attempts.push(later);
    const report = analyze(input);
    expect(report.independentPolicyQuality.eligibleOfferUnits).toBe(0);
    expect(report.coverage.allObservedAttempts).toBe(3);
    later.registration = { state: 'REGISTERED', intentIdSha256: sha('intent'), reason: null };
    later.execution = {
      state: 'CONFIRMED_DELETE',
      receiptSha256: sha('receipt'),
      observedAt: evaluatedAt,
    };
    later.inputSha256 = sha('other-input');
    expect(analyze(input).effects).toMatchObject({ confirmedDelete: 0, unboundReceiptClaims: 1 });
  });
  it('collapses connected author/campaign units and preserves semantic labels versus expected disposition', () => {
    const input = bundle();
    const rows = input.holdout[0]!.response.items;
    rows[1]!.sample.evidenceMetadata!.campaignGroupIds = [
      rows[0]!.sample.evidenceMetadata!.campaignGroupId!,
    ];
    const report = analyze(input);
    expect(report.independentPolicyQuality.protectedUnits).toBe(1);
    expect(report.independentPolicyQuality.offerUnits).toBe(1);
    expect(report.promotionAuthorized).toBe(false);
  });
  it('counts one exact receipt once and rejects the same receipt claimed by another bound source', () => {
    const input = bundle();
    const rows = input.holdout[0]!.response.items;
    const commercial = rows[1]!.sample.llmEnforcement;
    const protectedSource = rows[0]!.sample.llmEnforcement;
    if (commercial?.captureState !== 'OBSERVED' || protectedSource?.captureState !== 'OBSERVED')
      throw new Error('Synthetic envelopes missing');
    const first = commercial.attempts[0]!;
    first.registration = { state: 'REGISTERED', intentIdSha256: sha('one-intent'), reason: null };
    first.execution = {
      state: 'CONFIRMED_DELETE',
      receiptSha256: sha('one-receipt'),
      observedAt: evaluatedAt,
    };
    const duplicate = structuredClone(first);
    duplicate.sourceKey = sha('duplicate-attempt');
    duplicate.submittedAtMs += 1;
    commercial.attempts.push(duplicate);
    expect(analyze(input).effects).toMatchObject({
      confirmedDelete: 1,
      rawBoundReceiptObservations: 2,
      conflictingReceiptClaims: 0,
    });
    const other = protectedSource.attempts[0]!;
    other.analysis = structuredClone(first.analysis);
    other.analysis.observedAt = new Date(other.submittedAtMs + 1000).toISOString();
    other.registration = structuredClone(first.registration);
    other.execution = structuredClone(first.execution);
    const report = analyze(input);
    expect(report.provenanceErrors).toContain('conflicting_exact_receipt_binding');
    expect(report.effects).toMatchObject({
      confirmedDelete: 0,
      rawBoundReceiptObservations: 3,
      conflictingReceiptClaims: 3,
    });
    expect(report.evidenceSufficient).toBe(false);
  });
  it('writes an aggregate private file, refuses overwrite and hides private validation failures', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'commercial-ai-report-'));
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const input = join(folder, 'input.json');
      const output = join(folder, 'output.json');
      await writeFile(
        input,
        JSON.stringify({
          schemaVersion: 'commercial-ai-quality-evidence/v1',
          mode: 'CAPTURE_DIAGNOSTIC',
          evaluatedAt,
        }),
      );
      await reportCommercialAiQuality(['--input', input, '--output', output]);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(await readFile(output, 'utf8')).not.toContain('PRIVATE SENTINEL');
      await expect(
        reportCommercialAiQuality(['--input', input, '--output', output]),
      ).rejects.toThrow();
      await writeFile(input, JSON.stringify({ secret: 'PRIVATE SENTINEL' }));
      await expect(
        reportCommercialAiQuality(['--input', input, '--output', join(folder, 'bad.json')]),
      ).rejects.toThrow('schema is invalid');
      const link = join(folder, 'link.json');
      await symlink(input, link);
      await expect(
        reportCommercialAiQuality(['--input', link, '--output', join(folder, 'link-output.json')]),
      ).rejects.toThrow('file is invalid or unavailable');
      await writeFile(input, '{"PRIVATE SENTINEL":');
      await expect(
        reportCommercialAiQuality(['--input', input, '--output', join(folder, 'malformed.json')]),
      ).rejects.toThrow('file is invalid or unavailable');
      const large = await open(input, 'w');
      try {
        await large.truncate(64 * 1024 * 1024 + 1);
      } finally {
        await large.close();
      }
      await expect(
        reportCommercialAiQuality(['--input', input, '--output', join(folder, 'large.json')]),
      ).rejects.toThrow('file is invalid or unavailable');
    } finally {
      stdout.mockRestore();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
