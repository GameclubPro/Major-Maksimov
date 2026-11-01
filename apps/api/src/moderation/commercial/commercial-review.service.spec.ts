import { createHash } from 'node:crypto';
import {
  CommercialReviewService,
  type Candidate,
  buildCommercialReviewExecutionBinding,
  readCommercialReviewExecutionBinding,
} from './commercial-review.service';
import { COMMERCIAL_INTENT_QUALITY_DECISION_VERSION } from './commercial-policy-cohorts';
import { commercialReviewSamplingFrameResponseSchema } from '@maxim/contracts/safety-desk';
import { Prisma } from '../../prisma/prisma-client';

const updatedAt = new Date('2026-10-01T10:00:00.000Z');
const key = (actor: string) =>
  createHash('sha256').update(`commercial-reviewer-v1\0${actor}`).digest('hex');
const quality = {
  schemaVersion: 2,
  samplingProbability: 0.1,
  samplingStratum: 'NO_HIT',
  logicalMessageKey: 'a'.repeat(64),
  authorGroupId: 'b'.repeat(64),
  campaignGroupId: 'c'.repeat(64),
  campaignGroupIds: ['c'.repeat(64)],
  campaignGroupingComplete: true,
  sourceSnapshotSha256: 'd'.repeat(64),
  pseudonymizationKeyId: '9'.repeat(64),
  randomEvaluationIncluded: true,
  evaluationSamplingProbability: 0.1,
  imageReviewRequired: false,
  sourceExcerptComplete: true,
  messageCreatedAt: updatedAt.toISOString(),
  settingsProfileDigest: 'e'.repeat(64),
  detectorSourceSha256: 'f'.repeat(64),
  hasDetection: false,
  decisionOutcome: 'KEEP',
  deleteEligible: false,
  executionOutcome: 'NOT_REQUESTED',
  analysisOutcome: 'COMPLETE',
  candidateDecision: null,
};
function rating(actor = 'owner-one', overrides: Record<string, unknown> = {}) {
  return {
    id: `rating-${actor}`,
    sampleId: 'sample-1',
    reviewerKey: key(actor),
    kind: 'INDEPENDENT',
    label: 'NOT_COMMERCIAL',
    expectedDisposition: 'KEEP',
    evidenceKind: 'TEXT',
    sourceEvidenceDigest: null,
    reason: 'Частное объявление',
    createdAt: updatedAt,
    ...overrides,
  };
}
function createRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sample-1',
    chatId: 'chat-1',
    userId: 'user-1',
    messageId: 'message-1',
    source: 'TEXT',
    score: 0.85,
    evidenceHash: 'hash',
    label: null,
    independentLabel: null,
    independentReviewCount: 0,
    reviewState: 'UNREVIEWED',
    qualityMetadata: quality,
    reviewPriority: 90,
    observedAt: updatedAt,
    updatedAt,
    createdAt: updatedAt,
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    chat: { title: 'Тестовый чат' },
    ratings: [],
    evidence: {
      source: 'TEXT',
      excerpt: 'Услуги ремонта',
      score: 85,
      actionBand: 'DELETE_ONLY',
      messageDisposition: 'KEEP',
      requiredPolicyCohorts: ['commercial-text'],
      detectorVersion: 'v1',
      decisionFingerprint: 'fingerprint',
      reviewPriority: 90,
      reasons: ['SERVICE_OFFER'],
      label: null,
      reviewReason: '',
      reviewedAt: null,
    },
    ...overrides,
  };
}
function createService(rows = [createRow()]) {
  const prisma = {
    commercialReviewSample: {
      upsert: jest.fn().mockResolvedValue(rows[0]),
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn().mockResolvedValue(rows[0] ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: rows.length }),
    },
    commercialReviewRating: {
      create: jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: 'new-rating', sourceEvidenceDigest: null, ...data }),
        ),
    },
    commercialQualityPolicyStop: { upsert: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  return { prisma, service: new CommercialReviewService(prisma as never) };
}
const candidate: Candidate = {
  chatId: 'chat-1',
  userId: 'user-1',
  messageId: 'message-1',
  text: 'Ремонт: +7 999 123-45-67 https://example.com team@example.com',
  score: 85,
  actionBand: 'DELETE_ONLY',
  source: 'TEXT',
  decisionFingerprint: 'fingerprint',
  detectorVersion: 'v1',
  messageDisposition: 'KEEP',
  requiredPolicyCohorts: ['commercial-text'],
};
const request = {
  expectedUpdatedAt: updatedAt.toISOString(),
  label: 'NOT_COMMERCIAL',
  expectedDisposition: 'KEEP',
  reason: 'Личный контакт +7 999 123-45-67',
};

describe('CommercialReviewService independent quality boundary', () => {
  it('sanitizes excerpts and metadata, keeps legacy missing provenance unknown and fixes TTL', async () => {
    const { prisma, service } = createService();
    await service.recordCandidate({
      ...candidate,
      authorGroupId: 'raw-person-id',
      candidateDecision: { rawText: 'secret OCR' },
    });
    const write = prisma.commercialReviewSample.upsert.mock.calls[0]![0];
    expect(write.create.evidence.excerpt).not.toMatch(/999|example\.com|team@/u);
    expect(write.create.expiresAt.getTime() - write.create.observedAt.getTime()).toBe(
      14 * 86400_000,
    );
    expect(write.update).toEqual({});
    expect(write.create.qualityMetadata).toMatchObject({
      samplingProbability: null,
      authorGroupId: null,
      executionOutcome: 'UNKNOWN',
      analysisOutcome: 'UNKNOWN',
      deleteEligible: null,
      candidateDecision: null,
    });
    expect(JSON.stringify(write.create.qualityMetadata)).not.toMatch(
      /secret OCR|raw-person-id|message-1|user-1|example/u,
    );
  });
  it('deduplicates outcomes and repeated delivery but distinguishes content revisions and detector identity', async () => {
    const { prisma, service } = createService();
    await service.recordCandidate(candidate);
    await service.recordCandidate({
      ...candidate,
      messageDisposition: 'DELETE',
      decisionFingerprint: 'different-decision',
      executionOutcome: 'CONFIRMED_DELETE',
    });
    await service.recordCandidate({ ...candidate, text: 'Изменённое сообщение' });
    await service.recordCandidate({ ...candidate, detectorSourceSha256: 'f'.repeat(64) });
    const hashes = prisma.commercialReviewSample.upsert.mock.calls.map(
      ([write]) => write.where.evidenceHash,
    );
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
    expect(hashes[0]).not.toBe(hashes[3]);
    const update = prisma.commercialReviewSample.updateMany.mock.calls[0]![0];
    expect(update.data.qualityMetadata.executionOutcome).toBe('CONFIRMED_DELETE');
    expect(update.data).not.toHaveProperty('label');
    expect(update.data).not.toHaveProperty('independentLabel');
    expect(update.data).not.toHaveProperty('independentReviewCount');
  });
  it('never downgrades confirmed execution or overwrites another revision after a CAS race', async () => {
    const row = createRow({
      qualityMetadata: { ...quality, executionOutcome: 'CONFIRMED_DELETE' },
    });
    const { prisma, service } = createService([row]);
    await service.recordCandidate({ ...candidate, executionOutcome: 'ALREADY_ABSENT' });
    expect(prisma.commercialReviewSample.updateMany).not.toHaveBeenCalled();
    prisma.commercialReviewSample.upsert.mockResolvedValue(createRow());
    prisma.commercialReviewSample.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.commercialReviewSample.findUnique.mockResolvedValue(row);
    await service.recordCandidate({ ...candidate, executionOutcome: 'CONFIRMED_DELETE' });
    expect(prisma.commercialReviewSample.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.commercialReviewSample.findUnique).toHaveBeenCalledWith({
      where: { evidenceHash: expect.any(String) },
      include: { ratings: true },
    });
  });
  it('stays best effort on capture failure without logging upstream data', async () => {
    const { prisma, service } = createService();
    prisma.commercialReviewSample.upsert.mockRejectedValueOnce(
      new Error('sensitive upstream data'),
    );
    await expect(service.recordCandidate(candidate)).resolves.toBeUndefined();
    expect(prisma.commercialReviewSample.findUnique).not.toHaveBeenCalled();
  });
  it('merges the losing insert outcome into the exact winning sample without replacing its labels', async () => {
    const row = createRow({ label: 'COMMERCIAL', ratings: [rating()] });
    const { prisma, service } = createService([row]);
    prisma.commercialReviewSample.upsert.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await service.recordCandidate({ ...candidate, executionOutcome: 'CONFIRMED_DELETE' });
    const hash = prisma.commercialReviewSample.upsert.mock.calls[0]![0].where.evidenceHash;
    expect(prisma.commercialReviewSample.findUnique).toHaveBeenCalledWith({
      where: { evidenceHash: hash },
      include: { ratings: true },
    });
    const write = prisma.commercialReviewSample.updateMany.mock.calls[0]![0];
    expect(write.where).toMatchObject({ id: row.id, updatedAt: row.updatedAt });
    expect(write.data.qualityMetadata.executionOutcome).toBe('CONFIRMED_DELETE');
    for (const field of ['label', 'independentLabel', 'independentReviewCount', 'ratings'])
      expect(write.data).not.toHaveProperty(field);
    expect(prisma.commercialReviewSample.upsert).toHaveBeenCalledTimes(1);
  });
  it('does not recreate or enrich an absent unique-conflict winner', async () => {
    const { prisma, service } = createService();
    prisma.commercialReviewSample.upsert.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.commercialReviewSample.findUnique.mockResolvedValue(null);
    await expect(service.recordCandidate(candidate)).resolves.toBeUndefined();
    expect(prisma.commercialReviewSample.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.commercialReviewSample.updateMany).not.toHaveBeenCalled();
  });
  it('preserves nullable experimental detection and deletion permission without accepting raw payloads', async () => {
    const { prisma, service } = createService();
    await service.recordCandidate({
      ...candidate,
      campaignGroupingComplete: false,
      candidateDecision: {
        hasDetection: true,
        actionable: true,
        deleteEligible: false,
        score: 65,
        actionBand: 'WARN',
        messageDisposition: 'DELETE',
        detectorVersion: 'quality-v1',
        decisionFingerprint: 'quality-fingerprint',
        reasons: ['OWNED_PRODUCTION'],
        requiredPolicyCohorts: [],
        rawText: 'private source',
      },
    });
    const write = prisma.commercialReviewSample.upsert.mock.calls[0]![0];
    expect(write.create.qualityMetadata).toMatchObject({
      campaignGroupingComplete: false,
      candidateDecision: { hasDetection: true, actionable: true, deleteEligible: false },
    });
    expect(write.create.qualityMetadata.candidateDecision).not.toHaveProperty('rawText');
  });
  it('requires a trusted actor for reads and votes; rejects client reviewer identity', async () => {
    const { prisma, service } = createService();
    await expect(service.getQueue({}, null)).rejects.toMatchObject({ status: 403 });
    await expect(service.labelItem('sample-1', ' ', request)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.labelItem('sample-1', 'owner-one', { ...request, reviewerId: 'owner-two' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.commercialReviewSample.findUnique).not.toHaveBeenCalled();
  });
  it('blinds scores, decisions, reasons, policy cohorts, previous labels, comments and technical metadata on the server', async () => {
    const { service } = createService([
      createRow({
        label: 'COMMERCIAL',
        ratings: [rating()],
        independentReviewCount: 1,
        reviewState: 'AWAITING_SECOND',
      }),
    ]);
    const response = await service.getQueue({}, 'owner-two');
    expect(response.items[0]).toMatchObject({
      score: null,
      actionBand: null,
      messageDisposition: null,
      reviewPriority: null,
      reasons: [],
      requiredPolicyCohorts: [],
      label: null,
      historicalLabel: null,
      reviewReason: '',
      ownReview: null,
      evidenceMetadata: null,
      detectorVersion: 'unknown',
      decisionFingerprint: 'unknown',
      decisionVisible: false,
      canReview: true,
      independentReviewCount: 1,
    });
    const own = await service.getQueue({ status: 'ALL' }, 'owner-one');
    expect(own.items[0]).toMatchObject({
      decisionVisible: true,
      score: 85,
      ownReview: { label: 'NOT_COMMERCIAL' },
      historicalLabel: 'COMMERCIAL',
      canReview: false,
    });
  });
  it('uses neutral bounded pagination and per-actor pending status so historical labels still need independent review', async () => {
    const { prisma, service } = createService([createRow(), createRow({ id: 'sample-2' })]);
    const first = await service.getQueue({ limit: 1 }, 'owner-one');
    const write = prisma.commercialReviewSample.findMany.mock.calls[0]![0];
    expect(write).toMatchObject({ take: 2, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }] });
    expect(write.where.AND[0]).toMatchObject({
      ratings: { none: { reviewerKey: key('owner-one') } },
    });
    expect(write.where).not.toHaveProperty('label');
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())).not.toHaveProperty(
      'reviewPriority',
    );
    await service.getQueue({ limit: 1, cursor: first.nextCursor }, 'owner-one');
    expect(prisma.commercialReviewSample.findMany.mock.calls[1]![0].where.AND[1].OR).toHaveLength(
      2,
    );
    await expect(service.getQueue({ limit: 101 }, 'owner-one')).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.getQueue({ cursor: 'bad-cursor' }, 'owner-one')).rejects.toMatchObject({
      status: 400,
    });
  });
  it('rejects stale, expired and losing race writes without appending a rating or audit', async () => {
    const { prisma, service } = createService();
    await expect(
      service.labelItem('sample-1', 'owner-one', {
        ...request,
        expectedUpdatedAt: '2026-10-01T09:00:00.000Z',
      }),
    ).rejects.toMatchObject({ status: 409 });
    prisma.commercialReviewSample.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.labelItem('sample-1', 'owner-one', request)).rejects.toMatchObject({
      status: 409,
    });
    expect(prisma.commercialReviewRating.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    prisma.commercialReviewSample.findUnique.mockResolvedValueOnce(
      createRow({ expiresAt: new Date(0) }),
    );
    await expect(service.labelItem('sample-1', 'owner-one', request)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('appends the first vote atomically while preserving historical labels and revealing decisions only to its actor', async () => {
    const { prisma, service } = createService([createRow({ label: 'COMMERCIAL' })]);
    const item = await service.labelItem('sample-1', 'owner-one', request);
    expect(item).toMatchObject({
      label: null,
      historicalLabel: 'COMMERCIAL',
      ownReview: { label: 'NOT_COMMERCIAL', expectedDisposition: 'KEEP' },
      reviewState: 'AWAITING_SECOND',
      independentReviewCount: 1,
      decisionVisible: true,
    });
    expect(item.reviewReason).not.toContain('999');
    expect(prisma.commercialReviewRating.create.mock.calls[0]![0].data).toMatchObject({
      reviewerKey: key('owner-one'),
      kind: 'INDEPENDENT',
      evidenceKind: 'TEXT',
    });
    expect(prisma.commercialReviewSample.updateMany.mock.calls[0]![0].data).not.toHaveProperty(
      'label',
    );
    expect(prisma.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      actorUserId: 'owner-one',
      action: 'SAFETY_DESK_COMMERCIAL_INDEPENDENT_LABEL',
    });
  });
  it('binds semantic evidence server-side to the complete shown text in the append-only vote', async () => {
    const { service, prisma } = createService();
    const result = await service.labelItem('sample-1', 'owner-one', {
      ...request,
      semanticAnnotation: { version: 1, cohorts: ['BUYER_REQUEST'] },
    });
    const bound = {
      version: 1,
      cohorts: ['BUYER_REQUEST'],
      sourceSnapshotSha256: quality.sourceSnapshotSha256,
      excerptSha256: createHash('sha256').update('Услуги ремонта').digest('hex'),
    };
    expect(result.ownReview?.semanticAnnotation).toEqual(bound);
    expect(prisma.commercialReviewRating.create.mock.calls[0]![0].data.semanticAnnotation).toEqual(
      bound,
    );
    expect(prisma.auditLog.create.mock.calls[0]![0].data.payload.semanticAnnotation).toEqual(bound);
    const incomplete = createService([
      createRow({ qualityMetadata: { ...quality, sourceExcerptComplete: false } }),
    ]);
    await expect(
      incomplete.service.labelItem('sample-1', 'owner-one', {
        ...request,
        label: 'UNSURE',
        expectedDisposition: null,
        semanticAnnotation: { version: 1, cohorts: ['INSUFFICIENT_CONTEXT'] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(incomplete.prisma.commercialReviewRating.create).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'COMMERCIAL', expectedDisposition: 'DELETE' },
    { label: 'UNSURE', expectedDisposition: null },
  ])(
    'stores the actual blind semantic adjudication %p without revealing or replacing the agreed label',
    async (actual) => {
      const bound = {
        version: 1,
        sourceSnapshotSha256: quality.sourceSnapshotSha256,
        excerptSha256: createHash('sha256').update('Услуги ремонта').digest('hex'),
      };
      const row = createRow({
        reviewState: 'RESOLVED',
        independentLabel: 'NOT_COMMERCIAL',
        ratings: [
          rating('owner-one', { semanticAnnotation: { ...bound, cohorts: ['BUYER_REQUEST'] } }),
          rating('owner-two', { semanticAnnotation: { ...bound, cohorts: ['PERSONAL_SALE'] } }),
        ],
      });
      const { service, prisma } = createService([row]);
      const blind = (await service.getQueue({ status: 'ALL' }, 'owner-three')).items[0]!;
      expect(blind).toMatchObject({
        reviewState: 'RESOLVED',
        canAdjudicate: true,
        ownReview: null,
        decisionVisible: false,
      });
      const saved = await service.adjudicateItem('sample-1', 'owner-three', {
        ...request,
        ...actual,
        semanticAnnotation: { version: 1, cohorts: ['BUYER_REQUEST'] },
      });
      expect(saved).toMatchObject({
        reviewState: 'RESOLVED',
        label: 'NOT_COMMERCIAL',
        ownReview: actual,
      });
      expect(prisma.commercialReviewRating.create).toHaveBeenCalledTimes(1);
      expect(prisma.commercialReviewRating.create.mock.calls[0]![0].data).toMatchObject({
        ...actual,
        kind: 'SEMANTIC_ADJUDICATION',
      });
      expect(prisma.commercialReviewSample.updateMany.mock.calls[0]![0].data.independentLabel).toBe(
        'NOT_COMMERCIAL',
      );
    },
  );
  it('bounds AI export and refuses changed human revisions before joining observations', async () => {
    const window = {
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-02T00:00:00.000Z',
      limit: 50,
    };
    const { service, prisma } = createService([createRow({ ratings: [rating()] })]);
    await expect(
      service.exportAiIndependentEvidence({ ...window, limit: 51 }, 'owner-one'),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.commercialReviewSample.findMany).not.toHaveBeenCalled();
    prisma.commercialReviewSample.findUnique.mockResolvedValueOnce(
      createRow({ updatedAt: new Date(updatedAt.getTime() + 1) }),
    );
    await expect(service.exportAiIndependentEvidence(window, 'owner-one')).rejects.toMatchObject({
      status: 409,
    });
  });
  it('rejects a second vote or self-adjudication by the same trusted actor', async () => {
    const { service } = createService([
      createRow({ ratings: [rating()], independentReviewCount: 1, reviewState: 'AWAITING_SECOND' }),
    ]);
    await expect(service.labelItem('sample-1', 'owner-one', request)).rejects.toMatchObject({
      status: 409,
    });
    await expect(service.adjudicateItem('sample-1', 'owner-one', request)).rejects.toMatchObject({
      status: 409,
    });
  });
  it('resolves matching independent labels and sends disposition disagreements to a third distinct reviewer', async () => {
    const { service } = createService([
      createRow({ ratings: [rating()], independentReviewCount: 1, reviewState: 'AWAITING_SECOND' }),
    ]);
    await expect(service.labelItem('sample-1', 'owner-two', request)).resolves.toMatchObject({
      label: 'NOT_COMMERCIAL',
      reviewState: 'RESOLVED',
      independentReviewCount: 2,
    });
    const second = createService([
      createRow({
        ratings: [rating('owner-one', { label: 'COMMERCIAL', expectedDisposition: 'KEEP' })],
        independentReviewCount: 1,
        reviewState: 'AWAITING_SECOND',
      }),
    ]);
    await expect(
      second.service.labelItem('sample-1', 'owner-two', {
        ...request,
        label: 'COMMERCIAL',
        expectedDisposition: 'DELETE',
      }),
    ).resolves.toMatchObject({ label: null, reviewState: 'DISAGREEMENT' });
    const disputed = createService([
      createRow({
        ratings: [
          rating(),
          rating('owner-two', { label: 'COMMERCIAL', expectedDisposition: 'DELETE' }),
        ],
        independentReviewCount: 2,
        reviewState: 'DISAGREEMENT',
      }),
    ]);
    await expect(
      disputed.service.labelItem('sample-1', 'owner-three', request),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      disputed.service.adjudicateItem('sample-1', 'owner-one', request),
    ).rejects.toMatchObject({ status: 409 });
    const final = await disputed.service.adjudicateItem('sample-1', 'owner-three', request);
    expect(final).toMatchObject({
      reviewState: 'RESOLVED',
      label: 'NOT_COMMERCIAL',
      independentReviewCount: 2,
      ownReview: { kind: 'ADJUDICATION' },
    });
  });
  it('refuses photo labels and truncated text labels without actual source evidence', async () => {
    const { service } = createService([createRow({ source: 'OCR' })]);
    await expect(service.labelItem('sample-1', 'owner-one', request)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.labelItem('sample-1', 'owner-one', {
        ...request,
        label: 'UNSURE',
        expectedDisposition: null,
      }),
    ).resolves.toMatchObject({
      ownReview: { label: 'UNSURE', evidenceKind: 'CAPTION_ONLY' },
      imageEvidenceAvailable: false,
    });
    const partial = createService([
      createRow({ qualityMetadata: { ...quality, sourceExcerptComplete: false } }),
    ]);
    await expect(partial.service.labelItem('sample-1', 'owner-one', request)).rejects.toMatchObject(
      { status: 400 },
    );
    const explicit = createService();
    const oldRequest = {
      expectedUpdatedAt: request.expectedUpdatedAt,
      label: request.label,
      reason: request.reason,
    };
    await expect(
      explicit.service.labelItem('sample-1', 'owner-one', oldRequest),
    ).rejects.toMatchObject({ status: 400 });
    const legacy = createService([createRow({ qualityMetadata: null })]);
    await expect(
      legacy.service.labelItem('sample-1', 'owner-one', oldRequest),
    ).resolves.toMatchObject({ ownReview: { expectedDisposition: null } });
  });
  it('exports all own-reviewed evidence in a bounded window without implying population coverage', async () => {
    const row = createRow({
      independentLabel: 'NOT_COMMERCIAL',
      independentReviewCount: 2,
      reviewState: 'RESOLVED',
      ratings: [rating(), rating('owner-two')],
    });
    const { prisma, service } = createService([row]);
    const exported = await service.exportIndependentEvidence(
      { since: '2026-10-01T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z', limit: 20 },
      'owner-one',
    );
    expect(prisma.commercialReviewSample.findMany.mock.calls[0]![0]).toMatchObject({
      take: 21,
      where: { ratings: { some: { reviewerKey: key('owner-one') } } },
    });
    expect(exported).toMatchObject({ scope: 'OWN_REVIEWED', populationCoverageAvailable: false });
    expect(exported.items[0]).toMatchObject({
      eligibleForIndependentCorpus: true,
      ratings: [
        expect.objectContaining({ reviewerKey: key('owner-one') }),
        expect.objectContaining({ reviewerKey: key('owner-two') }),
      ],
    });
    const blind = await service.exportIndependentEvidence(
      { since: '2026-10-01T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z' },
      'owner-three',
    );
    expect(blind.items).toEqual([]);
    prisma.commercialReviewSample.findMany.mockResolvedValue([
      createRow({ ...row, qualityMetadata: null }),
    ]);
    const unknown = await service.exportIndependentEvidence(
      { since: '2026-10-01T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z' },
      'owner-one',
    );
    expect(unknown.items[0]?.eligibleForIndependentCorpus).toBe(false);
    prisma.commercialReviewSample.findMany.mockResolvedValue([
      createRow({
        ratings: [rating('owner-one', { label: 'UNSURE', expectedDisposition: null })],
        independentReviewCount: 1,
        reviewState: 'AWAITING_SECOND',
      }),
    ]);
    const unfinished = await service.exportIndependentEvidence(
      { since: '2026-10-01T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z' },
      'owner-one',
    );
    expect(unfinished.items).toHaveLength(1);
    expect(unfinished.items[0]).toMatchObject({
      eligibleForIndependentCorpus: false,
      sample: { label: null, ownReview: { label: 'UNSURE' } },
    });
    await expect(
      service.exportIndependentEvidence(
        { since: '2026-10-05T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z', limit: 501 },
        'owner-one',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('exports the retained random frame before any label without exposing decisions or contact data', async () => {
    const { prisma, service } = createService();
    const frame = await service.exportSamplingFrame(
      { since: '2026-10-01T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z' },
      'trusted-owner',
    );
    expect(commercialReviewSamplingFrameResponseSchema.safeParse(frame).success).toBe(true);
    expect(frame).toMatchObject({
      complete: true,
      populationCoverageAvailable: false,
      scannedCaptureRows: 1,
      samplingUnavailableRows: 0,
      items: [
        { source: 'TEXT', evaluationSamplingProbability: 0.1, campaignGroupingComplete: true },
      ],
    });
    expect(JSON.stringify(frame)).not.toMatch(
      /sample-1|user-1|message-1|score|COMMERCIAL|KEEP|NO_HIT|Услуги|reasons|ratings|detectorVersion/u,
    );
    const scan = prisma.commercialReviewSample.findMany.mock.calls[0]![0];
    expect(scan).toMatchObject({ take: 101, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }] });
    expect(scan.where).not.toHaveProperty('ratings');
    expect(scan.where).not.toHaveProperty('qualityMetadata');
    expect(scan.select).not.toHaveProperty('evidence');
    prisma.commercialReviewSample.findMany.mockResolvedValue([
      createRow({ qualityMetadata: null }),
      createRow({
        id: 'legacy-flag',
        qualityMetadata: { ...quality, randomEvaluationIncluded: null },
      }),
    ]);
    const historical = await service.exportSamplingFrame(
      { since: '2026-10-01T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z' },
      'trusted-owner',
    );
    expect(historical).toMatchObject({ items: [], complete: true, samplingUnavailableRows: 2 });
    await expect(service.exportSamplingFrame({}, null)).rejects.toMatchObject({ status: 403 });
    await expect(
      service.exportSamplingFrame(
        { since: '2026-09-01T00:00:00.000Z', until: '2026-10-05T00:00:00.000Z' },
        'trusted-owner',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('uses the last scanned capture for frame pagination even when no random item appears on a page', async () => {
    const { prisma, service } = createService([
      createRow({ qualityMetadata: { ...quality, randomEvaluationIncluded: false } }),
      createRow({ id: 'sample-0', source: 'OCR' }),
    ]);
    const window = {
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-05T00:00:00.000Z',
      limit: 1,
    };
    const first = await service.exportSamplingFrame(window, 'trusted-owner');
    expect(first.items).toEqual([]);
    expect(first.complete).toBe(false);
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())).toEqual({
      observedAt: updatedAt.toISOString(),
      id: 'sample-1',
    });
    prisma.commercialReviewSample.findMany.mockResolvedValue([
      createRow({ id: 'sample-0', source: 'OCR' }),
    ]);
    const second = await service.exportSamplingFrame(
      { ...window, cursor: first.nextCursor },
      'trusted-owner',
    );
    expect(second.items[0]?.source).toBe('OCR');
    expect(second.complete).toBe(true);
    expect(prisma.commercialReviewSample.findMany.mock.calls[1]![0].where.OR).toEqual([
      { observedAt: { lt: updatedAt } },
      { observedAt: updatedAt, id: { lt: 'sample-1' } },
    ]);
    await expect(
      service.exportSamplingFrame({ ...window, cursor: 'bad' }, 'trusted-owner'),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('atomically persists an exact policy stop alongside the second independent false-deletion label', async () => {
    const base = createRow();
    const { prisma, service } = createService([
      createRow({
        evidence: { ...base.evidence, detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION },
        qualityMetadata: { ...quality, executionOutcome: 'CONFIRMED_DELETE' },
        ratings: [rating()],
        independentReviewCount: 1,
        reviewState: 'AWAITING_SECOND',
      }),
    ]);
    await expect(service.labelItem('sample-1', 'owner-two', request)).resolves.toMatchObject({
      reviewState: 'RESOLVED',
    });
    expect(prisma.commercialQualityPolicyStop.upsert).toHaveBeenCalledWith({
      where: {
        detectorSourceSha256_decisionVersion: {
          detectorSourceSha256: 'f'.repeat(64),
          decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
        },
      },
      create: {
        detectorSourceSha256: 'f'.repeat(64),
        decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      },
      update: {},
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it.each([
    { detectorVersion: 'baseline', executionOutcome: 'CONFIRMED_DELETE' },
    { detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION, executionOutcome: 'PENDING' },
    {
      detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      executionOutcome: 'ALREADY_ABSENT',
    },
  ])('does not stop from historical, shadow or unconfirmed execution: %p', async (condition) => {
    const base = createRow();
    const { prisma, service } = createService([
      createRow({
        label: 'NOT_COMMERCIAL',
        evidence: { ...base.evidence, detectorVersion: condition.detectorVersion },
        qualityMetadata: { ...quality, executionOutcome: condition.executionOutcome },
        ratings: [rating()],
        independentReviewCount: 1,
        reviewState: 'AWAITING_SECOND',
      }),
    ]);
    await service.labelItem('sample-1', 'owner-two', request);
    expect(prisma.commercialQualityPolicyStop.upsert).not.toHaveBeenCalled();
  });
  it('creates the same durable stop when confirmed execution arrives after independent KEEP resolution', async () => {
    const base = createRow();
    const { prisma, service } = createService([
      createRow({
        evidence: { ...base.evidence, detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION },
        ratings: [rating(), rating('owner-two')],
        independentReviewCount: 2,
        reviewState: 'RESOLVED',
        independentLabel: 'NOT_COMMERCIAL',
      }),
    ]);
    await service.recordCandidate({ ...candidate, executionOutcome: 'CONFIRMED_DELETE' });
    expect(prisma.commercialQualityPolicyStop.upsert).toHaveBeenCalledTimes(1);
    expect(
      prisma.commercialReviewSample.updateMany.mock.calls[0]![0].data.qualityMetadata
        .executionOutcome,
    ).toBe('CONFIRMED_DELETE');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('binds receipt enrichment to the frozen source identity and actual policy version without replaying capture', async () => {
    const frozen = {
      ...candidate,
      detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      sourceSnapshotSha256: quality.sourceSnapshotSha256,
      detectorSourceSha256: quality.detectorSourceSha256,
      logicalMessageKey: quality.logicalMessageKey,
    };
    const binding = buildCommercialReviewExecutionBinding(frozen)!;
    expect(
      readCommercialReviewExecutionBinding({
        commercialReviewBinding: { ...binding, rawText: 'ignored' },
      }),
    ).toEqual(binding);
    expect(buildCommercialReviewExecutionBinding({ ...frozen, source: 'OCR' })).toBeNull();
    expect(
      buildCommercialReviewExecutionBinding({ ...frozen, sourceSnapshotSha256: 'bad' }),
    ).toBeNull();
    const base = createRow();
    const { prisma, service } = createService([
      createRow({
        evidenceHash: binding.evidenceHash,
        evidence: { ...base.evidence, detectorVersion: binding.detectorVersion },
        ratings: [rating(), rating('owner-two')],
        independentReviewCount: 2,
        reviewState: 'RESOLVED',
        independentLabel: 'NOT_COMMERCIAL',
      }),
    ]);
    await expect(
      service.recordExecution({
        chatId: 'chat-1',
        messageId: 'message-1',
        binding,
        executionOutcome: 'CONFIRMED_DELETE',
      }),
    ).resolves.toBe('RECORDED');
    expect(prisma.commercialReviewSample.findUnique).toHaveBeenCalledWith({
      where: { evidenceHash: binding.evidenceHash },
      include: { ratings: true },
    });
    expect(prisma.commercialReviewSample.upsert).not.toHaveBeenCalled();
    expect(prisma.commercialQualityPolicyStop.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.commercialReviewSample.updateMany.mock.calls[0]![0].data).not.toHaveProperty(
      'independentLabel',
    );
    for (const mismatch of [
      { chatId: 'other-chat' },
      { messageId: 'other-message' },
      { binding: { ...binding, sourceSnapshotSha256: '0'.repeat(64) } },
      { binding: { ...binding, detectorVersion: 'baseline' } },
    ])
      await expect(
        service.recordExecution({
          chatId: 'chat-1',
          messageId: 'message-1',
          binding,
          executionOutcome: 'CONFIRMED_DELETE',
          ...mismatch,
        }),
      ).resolves.toBe('SOURCE_MISMATCH');
    expect(prisma.commercialQualityPolicyStop.upsert).toHaveBeenCalledTimes(1);
  });
  it('treats missing and expired receipt sources as omissions and keeps absence separate from a confirmed DELETE', async () => {
    const frozen = {
      ...candidate,
      detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      sourceSnapshotSha256: quality.sourceSnapshotSha256,
      detectorSourceSha256: quality.detectorSourceSha256,
    };
    const binding = buildCommercialReviewExecutionBinding(frozen)!;
    const base = createRow();
    const { prisma, service } = createService([
      createRow({
        evidence: { ...base.evidence, detectorVersion: binding.detectorVersion },
        ratings: [rating(), rating('owner-two')],
        independentReviewCount: 2,
        reviewState: 'RESOLVED',
        independentLabel: 'NOT_COMMERCIAL',
      }),
    ]);
    await expect(
      service.recordExecution({
        chatId: 'chat-1',
        messageId: 'message-1',
        binding,
        executionOutcome: 'ALREADY_ABSENT',
      }),
    ).resolves.toBe('RECORDED');
    expect(prisma.commercialQualityPolicyStop.upsert).not.toHaveBeenCalled();
    prisma.commercialReviewSample.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.recordExecution({
        chatId: 'chat-1',
        messageId: 'message-1',
        binding,
        executionOutcome: 'CONFIRMED_DELETE',
      }),
    ).resolves.toBe('SOURCE_UNAVAILABLE');
    prisma.commercialReviewSample.findUnique.mockResolvedValueOnce(
      createRow({ expiresAt: new Date(0) }),
    );
    await expect(
      service.recordExecution({
        chatId: 'chat-1',
        messageId: 'message-1',
        binding,
        executionOutcome: 'CONFIRMED_DELETE',
      }),
    ).resolves.toBe('SOURCE_UNAVAILABLE');
  });
  it('prunes only a bounded expiry-index batch; ratings are retained until their sample expires', async () => {
    const { prisma, service } = createService([createRow({ expiresAt: new Date(0) })]);
    await expect(service.pruneExpired(25)).resolves.toBe(1);
    expect(prisma.commercialReviewSample.findMany.mock.calls[0]![0]).toMatchObject({
      take: 25,
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    });
  });
});
