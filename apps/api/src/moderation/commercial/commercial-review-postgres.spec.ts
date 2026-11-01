import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPrismaClient, Prisma, type PrismaClient } from '../../prisma/prisma-client';
import { CommercialReviewService, type Candidate } from './commercial-review.service';
import { COMMERCIAL_INTENT_QUALITY_DECISION_VERSION } from './commercial-policy-cohorts';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)('independent commercial review PostgreSQL races', () => {
  let prisma: PrismaClient;
  let service: CommercialReviewService;
  let constraints: Pool;
  const chatId = `commercial-review-${randomUUID()}`;
  const stopSource = createHash('sha256').update(chatId).digest('hex');
  const candidate: Candidate = {
    chatId,
    userId: 'test-user',
    messageId: 'review-message',
    text: 'Продам свой холодильник после переезда',
    score: 50,
    actionBand: 'REVIEW_ONLY',
    source: 'TEXT',
    decisionFingerprint: 'test-fingerprint',
    detectorVersion: 'test-version',
    messageDisposition: 'KEEP',
    requiredPolicyCohorts: [],
    samplingProbability: 0.1,
    samplingStratum: 'NO_HIT',
    logicalMessageKey: 'a'.repeat(64),
    authorGroupId: 'b'.repeat(64),
    sourceSnapshotSha256: 'c'.repeat(64),
    sourceExcerptComplete: true,
    messageCreatedAt: new Date(),
    settingsProfileDigest: 'd'.repeat(64),
    detectorSourceSha256: 'e'.repeat(64),
    hasDetection: false,
    decisionOutcome: 'KEEP',
    deleteEligible: false,
    executionOutcome: 'NOT_REQUESTED',
    analysisOutcome: 'COMPLETE',
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Review races require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 8 });
    constraints = new Pool({ connectionString: databaseUrl, max: 1 });
    await prisma.$connect();
    await prisma.chat.create({
      data: { id: chatId, title: 'Independent commercial review races' },
    });
    service = new CommercialReviewService(prisma as never);
  });
  beforeEach(async () => {
    await prisma.commercialQualityPolicyStop.deleteMany({
      where: { detectorSourceSha256: stopSource },
    });
    await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
    await prisma.auditLog.deleteMany({ where: { chatId } });
    await service.recordCandidate(candidate);
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.commercialQualityPolicyStop.deleteMany({
      where: { detectorSourceSha256: stopSource },
    });
    await prisma.$disconnect();
    await constraints.end();
  });
  async function current() {
    return prisma.commercialReviewSample.findFirstOrThrow({
      where: { chatId },
      include: { ratings: true },
    });
  }
  const insertRating = (sampleId: string, kind: string) =>
    constraints.query(
      `INSERT INTO commercial_review_ratings
      (id, sample_id, reviewer_key, kind, label, expected_disposition, evidence_kind, reason)
      VALUES ($1, $2, $3, $4, 'NOT_COMMERCIAL', 'KEEP', 'TEXT', 'Synthetic constraint case')`,
      [randomUUID(), sampleId, createHash('sha256').update(randomUUID()).digest('hex'), kind],
    );
  it('keeps unknown review kinds rejected by the migrated PostgreSQL constraint', async () => {
    const row = await current();
    await expect(insertRating(row.id, 'UNKNOWN_KIND')).rejects.toMatchObject({ code: '23514' });
    expect((await current()).ratings).toHaveLength(0);
  });
  it.each([
    ['ADJUDICATION', 'SEMANTIC_ADJUDICATION'],
    ['SEMANTIC_ADJUDICATION', 'ADJUDICATION'],
    ['SEMANTIC_ADJUDICATION', 'SEMANTIC_ADJUDICATION'],
  ])(
    'enforces one combined adjudication slot in PostgreSQL: %s followed by %s',
    async (firstKind, nextKind) => {
      const row = await current();
      await insertRating(row.id, firstKind);
      await expect(insertRating(row.id, nextKind)).rejects.toMatchObject({ code: '23505' });
      expect((await current()).ratings).toHaveLength(1);
    },
  );
  const keep = (row: { updatedAt: Date }) => ({
    expectedUpdatedAt: row.updatedAt.toISOString(),
    label: 'NOT_COMMERCIAL',
    expectedDisposition: 'KEEP',
  });
  const experimental: Candidate = {
    ...candidate,
    detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
    detectorSourceSha256: stopSource,
    executionOutcome: 'PENDING',
    decisionOutcome: 'DELETE',
    messageDisposition: 'DELETE',
    deleteEligible: true,
  };
  async function qualityFirstVote() {
    await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
    await service.recordCandidate(experimental);
    const row = await current();
    await service.labelItem(row.id, 'one', keep(row));
    return current();
  }
  it('keeps dedicated AI diagnostic rows out of human queue, export and random frame', async () => {
    const original = await current();
    await prisma.commercialReviewSample.update({
      where: { id: original.id },
      data: {
        qualityMetadata: {
          ...(original.qualityMetadata as Prisma.JsonObject),
          randomEvaluationIncluded: true,
          evaluationSamplingProbability: 0.1,
        },
      },
    });
    const duplicate = await prisma.commercialReviewSample.create({
      data: {
        chatId,
        userId: original.userId,
        messageId: original.messageId,
        source: 'TEXT',
        evidenceHash: createHash('sha256').update(randomUUID()).digest('hex'),
        score: original.score,
        evidence: original.evidence!,
        qualityMetadata: original.qualityMetadata!,
        llmEnforcement: { schemaVersion: 1, captureState: 'INVALID', coverageIncomplete: true },
        expiresAt: original.expiresAt,
      },
    });
    const queue = await service.getQueue({ status: 'ALL', limit: 100 }, 'native-reviewer');
    expect(queue.items.some((item) => item.id === original.id)).toBe(true);
    expect(queue.items.some((item) => item.id === duplicate.id)).toBe(false);
    const window = {
      since: new Date(Date.now() - 60_000).toISOString(),
      until: new Date(Date.now() + 60_000).toISOString(),
      limit: 500,
    };
    const frame = await service.exportSamplingFrame(window, 'native-reviewer');
    expect(
      frame.items.filter((item) => item.logicalMessageKey === candidate.logicalMessageKey),
    ).toHaveLength(1);
    await expect(
      service.labelItem(duplicate.id, 'native-reviewer', keep(duplicate)),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(await prisma.commercialReviewRating.count({ where: { sampleId: duplicate.id } })).toBe(
      0,
    );
    const exported = await service.exportIndependentEvidence(window, 'native-reviewer');
    expect(exported.items.some((item) => item.sample.id === duplicate.id)).toBe(false);
  });
  it('serializes simultaneous first votes, and a fresh second vote resolves without overwriting historical evidence', async () => {
    const row = await current();
    await prisma.commercialReviewSample.update({
      where: { id: row.id },
      data: { label: 'COMMERCIAL' },
    });
    const before = await current();
    const request = {
      expectedUpdatedAt: before.updatedAt.toISOString(),
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
    };
    const results = await Promise.allSettled(
      ['one', 'two'].map((actor) => service.labelItem(before.id, actor, request)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const won = await current();
    expect(won.ratings).toHaveLength(1);
    expect(won.label).toBe('COMMERCIAL');
    expect(won.independentLabel).toBeNull();
    const loser = results[0]?.status === 'rejected' ? 'one' : 'two';
    const blind = await service.getQueue({ status: 'ALL' }, loser);
    expect(blind.items[0]?.decisionVisible).toBe(false);
    await service.labelItem(won.id, loser, {
      ...request,
      expectedUpdatedAt: won.updatedAt.toISOString(),
    });
    const final = await current();
    expect(final.ratings).toHaveLength(2);
    expect(final.reviewState).toBe('RESOLVED');
    expect(final.independentLabel).toBe('NOT_COMMERCIAL');
    expect(final.label).toBe('COMMERCIAL');
  });
  it('allows one append-only vote per trusted reviewer even during a duplicate request race', async () => {
    const before = await current();
    const request = {
      expectedUpdatedAt: before.updatedAt.toISOString(),
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
    };
    const results = await Promise.allSettled([
      service.labelItem(before.id, 'one', request),
      service.labelItem(before.id, 'one', request),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const after = await current();
    await expect(
      service.labelItem(after.id, 'one', {
        ...request,
        expectedUpdatedAt: after.updatedAt.toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(after.ratings).toHaveLength(1);
    expect(
      await prisma.auditLog.count({
        where: { chatId, action: 'SAFETY_DESK_COMMERCIAL_INDEPENDENT_LABEL' },
      }),
    ).toBe(1);
  });
  it('fences expiry changed after reading and keeps both ratings and audit untouched', async () => {
    const before = await current();
    const expiring = new CommercialReviewService({
      commercialReviewSample: prisma.commercialReviewSample,
      $transaction: async (callback: Parameters<PrismaClient['$transaction']>[0]) => {
        await prisma.commercialReviewSample.update({
          where: { id: before.id },
          data: { expiresAt: new Date(0) },
        });
        return prisma.$transaction(callback as never);
      },
    } as never);
    await expect(
      expiring.labelItem(before.id, 'one', {
        expectedUpdatedAt: before.updatedAt.toISOString(),
        label: 'NOT_COMMERCIAL',
        expectedDisposition: 'KEEP',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await current()).ratings).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { chatId } })).toBe(0);
  });
  it('deduplicates mirrored delivery and execution enrichment without conflating edited source snapshots', async () => {
    await Promise.all(Array.from({ length: 6 }, () => service.recordCandidate(candidate)));
    const first = await current();
    await service.labelItem(first.id, 'one', {
      expectedUpdatedAt: first.updatedAt.toISOString(),
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
    });
    await service.recordCandidate({
      ...candidate,
      executionOutcome: 'CONFIRMED_DELETE',
      messageDisposition: 'DELETE',
    });
    await service.recordCandidate({ ...candidate, executionOutcome: 'UNKNOWN' });
    const enriched = await current();
    expect(enriched.ratings).toHaveLength(1);
    expect(enriched.qualityMetadata).toMatchObject({ executionOutcome: 'CONFIRMED_DELETE' });
    await service.recordCandidate({
      ...candidate,
      sourceSnapshotSha256: 'f'.repeat(64),
      text: 'Новое коммерческое предложение',
    });
    expect(await prisma.commercialReviewSample.count({ where: { chatId } })).toBe(2);
    expect(
      (
        await prisma.commercialReviewSample.findUniqueOrThrow({
          where: { id: first.id },
          include: { ratings: true },
        })
      ).ratings,
    ).toHaveLength(1);
  });
  it('recovers a real concurrent insert conflict and retains the losing outcome on the winning row', async () => {
    const seed = await current();
    await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
    const applicationName = `commercial-review-race-${randomUUID()}`;
    const contender = createPrismaClient(databaseUrl, {
      max: 2,
      application_name: applicationName,
      statement_timeout: 8_000,
    });
    const upsert = jest.spyOn(contender.commercialReviewSample, 'upsert');
    let capture: Promise<void> | undefined;
    try {
      await contender.$connect();
      await prisma.$transaction(
        async (tx) => {
          await tx.commercialReviewSample.create({
            data: {
              id: seed.id,
              chatId: seed.chatId,
              userId: seed.userId,
              messageId: seed.messageId,
              source: seed.source,
              score: seed.score,
              evidenceHash: seed.evidenceHash,
              reviewPriority: seed.reviewPriority,
              observedAt: seed.observedAt,
              expiresAt: seed.expiresAt,
              evidence: seed.evidence as Prisma.InputJsonValue,
              qualityMetadata: seed.qualityMetadata as Prisma.InputJsonValue,
              label: 'COMMERCIAL',
            },
          });
          capture = new CommercialReviewService(contender as never).recordCandidate({
            ...candidate,
            executionOutcome: 'CONFIRMED_DELETE',
          });
          // Hold the winning insert until Prisma's losing insert is actually waiting
          // on its unique key; no timing-only sleep or injected database error.
          let blocked = false;
          const deadline = Date.now() + 3_000;
          while (Date.now() < deadline) {
            const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE application_name = ${applicationName}
                AND wait_event_type = 'Lock'
                AND query LIKE 'INSERT INTO "public"."commercial_review_samples"%'
            ) AS blocked
          `);
            if (rows[0]?.blocked) {
              blocked = true;
              break;
            }
            await delay(10);
          }
          expect(blocked).toBe(true);
        },
        { timeout: 10_000 },
      );
      await capture;
      expect(upsert).toHaveBeenCalledTimes(1);
      await expect(upsert.mock.results[0]?.value).rejects.toMatchObject({ code: 'P2002' });
      const winner = await current();
      expect(winner.id).toBe(seed.id);
      expect(winner.label).toBe('COMMERCIAL');
      expect(winner.qualityMetadata).toMatchObject({ executionOutcome: 'CONFIRMED_DELETE' });
      expect(await prisma.commercialReviewSample.count({ where: { chatId } })).toBe(1);
    } finally {
      await capture;
      upsert.mockRestore();
      await contender.$disconnect();
    }
  }, 20_000);
  it('serializes third-reviewer adjudication and rejects either original reviewer adjudicating their own disagreement', async () => {
    let row = await current();
    await service.labelItem(row.id, 'one', {
      expectedUpdatedAt: row.updatedAt.toISOString(),
      label: 'COMMERCIAL',
      expectedDisposition: 'DELETE',
    });
    row = await current();
    await service.labelItem(row.id, 'two', {
      expectedUpdatedAt: row.updatedAt.toISOString(),
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
    });
    row = await current();
    const request = {
      expectedUpdatedAt: row.updatedAt.toISOString(),
      label: 'NOT_COMMERCIAL',
      expectedDisposition: 'KEEP',
    };
    await expect(service.adjudicateItem(row.id, 'one', request)).rejects.toMatchObject({
      status: 409,
    });
    const results = await Promise.allSettled(
      ['three', 'four'].map((actor) => service.adjudicateItem(row.id, actor, request)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const after = await current();
    expect(after.ratings).toHaveLength(3);
    expect(after.independentReviewCount).toBe(2);
    expect(after.reviewState).toBe('RESOLVED');
  });
  it.each([
    {
      version: 1,
      cohorts: ['PERSONAL_SALE'],
      sourceSnapshotSha256: 'f'.repeat(64),
      excerptSha256: 'f'.repeat(64),
    },
    { version: 1, cohorts: ['PERSONAL_SALE', 'PERSONAL_SALE'] },
    { version: 1, cohorts: ['UNTRUSTED_CATEGORY'] },
  ])(
    'rejects client source bindings and invalid semantic annotations without persisting a vote: %j',
    async (semanticAnnotation) => {
      const before = await current();
      await expect(
        service.labelItem(before.id, 'one', {
          ...keep(before),
          semanticAnnotation,
        }),
      ).rejects.toMatchObject({ status: 400 });
      const after = await current();
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.ratings).toHaveLength(0);
      expect(await prisma.auditLog.count({ where: { chatId } })).toBe(0);
    },
  );
  it.each([
    ['COMMERCIAL', 'DELETE', 'RECEIPT_FIRST'],
    ['COMMERCIAL', 'DELETE', 'ADJUDICATION_FIRST'],
    ['UNSURE', null, 'RECEIPT_FIRST'],
    ['UNSURE', null, 'ADJUDICATION_FIRST'],
  ] as const)(
    'retains agreed KEEP authority after a blind %s/%s semantic adjudication: %s',
    async (thirdLabel, thirdDisposition, order) => {
      await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
      await service.recordCandidate(experimental);
      let row = await current();
      await service.labelItem(row.id, 'one', {
        ...keep(row),
        semanticAnnotation: { version: 1, cohorts: ['PERSONAL_SALE'] },
      });
      if (order === 'RECEIPT_FIRST') {
        await service.recordCandidate({ ...experimental, executionOutcome: 'CONFIRMED_DELETE' });
      }
      row = await current();
      await service.labelItem(row.id, 'two', {
        ...keep(row),
        semanticAnnotation: { version: 1, cohorts: ['NONCOMMERCIAL_HELP'] },
      });
      row = await current();
      expect(row.reviewState).toBe('RESOLVED');
      expect(row.independentLabel).toBe('NOT_COMMERCIAL');
      expect(row.semanticReviewState).toBe('DISAGREEMENT');
      expect(row.ratings.map((rating) => rating.expectedDisposition)).toEqual(['KEEP', 'KEEP']);
      const pending = await service.getQueue({ status: 'PENDING' }, 'three');
      expect(pending.items.find((item) => item.id === row.id)).toMatchObject({
        canAdjudicate: true,
        decisionVisible: false,
        ownReview: null,
        evidenceMetadata: null,
      });
      const stop = await prisma.commercialQualityPolicyStop.findUnique({
        where: {
          detectorSourceSha256_decisionVersion: {
            detectorSourceSha256: stopSource,
            decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
          },
        },
      });
      expect(stop !== null).toBe(order === 'RECEIPT_FIRST');
      await expect(
        service.adjudicateItem(row.id, 'one', {
          ...keep(row),
          semanticAnnotation: { version: 1, cohorts: ['PERSONAL_SALE'] },
        }),
      ).rejects.toMatchObject({ status: 409 });
      const adjudicated = await service.adjudicateItem(row.id, 'three', {
        ...keep(row),
        label: thirdLabel,
        expectedDisposition: thirdDisposition,
        semanticAnnotation: { version: 1, cohorts: ['PERSONAL_SALE'] },
      });
      expect(adjudicated).toMatchObject({
        label: 'NOT_COMMERCIAL',
        reviewState: 'RESOLVED',
        ownReview: {
          label: thirdLabel,
          expectedDisposition: thirdDisposition,
          kind: 'SEMANTIC_ADJUDICATION',
        },
      });
      const after = await current();
      expect(after.ratings).toHaveLength(3);
      expect(after.reviewState).toBe('RESOLVED');
      expect(after.independentLabel).toBe('NOT_COMMERCIAL');
      expect(after.semanticReviewState).toBe('RESOLVED');
      const legacyFinal =
        after.ratings.find((rating) => rating.kind === 'ADJUDICATION') ??
        after.ratings.find((rating) => rating.kind === 'INDEPENDENT');
      expect(legacyFinal).toMatchObject({ label: 'NOT_COMMERCIAL', expectedDisposition: 'KEEP' });
      expect(
        after.ratings
          .filter((rating) => rating.kind === 'INDEPENDENT')
          .every(
            (rating) => rating.label === 'NOT_COMMERCIAL' && rating.expectedDisposition === 'KEEP',
          ),
      ).toBe(true);
      expect(after.ratings.find((rating) => rating.kind === 'SEMANTIC_ADJUDICATION')).toMatchObject(
        {
          label: thirdLabel,
          expectedDisposition: thirdDisposition,
        },
      );
      expect(
        await prisma.auditLog.count({
          where: { chatId, actorUserId: 'three', action: 'SAFETY_DESK_COMMERCIAL_ADJUDICATION' },
        }),
      ).toBe(1);
      expect(
        after.ratings.find((rating) => rating.kind === 'SEMANTIC_ADJUDICATION')?.semanticAnnotation,
      ).toMatchObject({
        version: 1,
        cohorts: ['PERSONAL_SALE'],
        sourceSnapshotSha256: candidate.sourceSnapshotSha256,
        excerptSha256: createHash('sha256').update(candidate.text, 'utf8').digest('hex'),
      });
      expect(
        (await service.getQueue({ status: 'PENDING' }, 'four')).items.some(
          (item) => item.id === row.id,
        ),
      ).toBe(false);
      if (order === 'ADJUDICATION_FIRST') {
        expect(
          await prisma.commercialQualityPolicyStop.count({
            where: { detectorSourceSha256: stopSource },
          }),
        ).toBe(0);
        await service.recordCandidate({ ...experimental, executionOutcome: 'CONFIRMED_DELETE' });
      }
      const confirmedStop = await prisma.commercialQualityPolicyStop.findUniqueOrThrow({
        where: {
          detectorSourceSha256_decisionVersion: {
            detectorSourceSha256: stopSource,
            decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
          },
        },
      });
      expect((await current()).independentLabel).toBe('NOT_COMMERCIAL');
      if (stop) expect(confirmedStop.stoppedAt).toEqual(stop.stoppedAt);
      await service.recordCandidate({ ...experimental, executionOutcome: 'CONFIRMED_DELETE' });
      expect(
        (
          await prisma.commercialQualityPolicyStop.findUniqueOrThrow({
            where: {
              detectorSourceSha256_decisionVersion: {
                detectorSourceSha256: stopSource,
                decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
              },
            },
          })
        ).stoppedAt,
      ).toEqual(confirmedStop.stoppedAt);
    },
  );
  it.each(['REVIEW_FIRST', 'RECEIPT_FIRST'] as const)(
    'durably stops a confirmed false deletion regardless of arrival order: %s',
    async (order) => {
      let row = await qualityFirstVote();
      if (order === 'REVIEW_FIRST') {
        await service.labelItem(row.id, 'two', keep(row));
        expect(
          await prisma.commercialQualityPolicyStop.count({
            where: { detectorSourceSha256: stopSource },
          }),
        ).toBe(0);
        await service.recordCandidate({ ...experimental, executionOutcome: 'CONFIRMED_DELETE' });
      } else {
        await service.recordCandidate({ ...experimental, executionOutcome: 'CONFIRMED_DELETE' });
        row = await current();
        await service.labelItem(row.id, 'two', keep(row));
      }
      expect((await current()).reviewState).toBe('RESOLVED');
      const stop = await prisma.commercialQualityPolicyStop.findUnique({
        where: {
          detectorSourceSha256_decisionVersion: {
            detectorSourceSha256: stopSource,
            decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
          },
        },
      });
      expect(stop).not.toBeNull();
      await service.recordCandidate({ ...experimental, executionOutcome: 'CONFIRMED_DELETE' });
      const repeated = await prisma.commercialQualityPolicyStop.findUnique({
        where: {
          detectorSourceSha256_decisionVersion: {
            detectorSourceSha256: stopSource,
            decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
          },
        },
      });
      expect(repeated?.stoppedAt).toEqual(stop?.stoppedAt);
      await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
      expect(
        await prisma.commercialQualityPolicyStop.count({
          where: { detectorSourceSha256: stopSource },
        }),
      ).toBe(1);
    },
  );
  it('serializes a late confirmed receipt racing with the final independent vote without losing the durable stop', async () => {
    const row = await qualityFirstVote();
    const [vote, receipt] = await Promise.allSettled([
      service.labelItem(row.id, 'two', keep(row)),
      service.recordCandidate({ ...experimental, executionOutcome: 'CONFIRMED_DELETE' }),
    ]);
    expect(receipt.status).toBe('fulfilled');
    if (vote.status === 'rejected') {
      expect(vote.reason).toMatchObject({ status: 409 });
      const latest = await current();
      await service.labelItem(latest.id, 'two', keep(latest));
    }
    const final = await current();
    expect(final.ratings).toHaveLength(2);
    expect(final.reviewState).toBe('RESOLVED');
    expect(final.qualityMetadata).toMatchObject({ executionOutcome: 'CONFIRMED_DELETE' });
    expect(
      await prisma.commercialQualityPolicyStop.count({
        where: { detectorSourceSha256: stopSource },
      }),
    ).toBe(1);
  });
  it('does not stop from a historical KEEP label or experimental shadow candidate on a baseline deletion', async () => {
    const row = await current();
    await prisma.commercialReviewSample.update({
      where: { id: row.id },
      data: { label: 'NOT_COMMERCIAL' },
    });
    await service.recordCandidate({
      ...candidate,
      executionOutcome: 'CONFIRMED_DELETE',
      candidateDecision: {
        hasDetection: true,
        actionable: true,
        deleteEligible: true,
        score: 90,
        actionBand: 'DELETE_ONLY',
        messageDisposition: 'DELETE',
        detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
        decisionFingerprint: 'shadow',
        reasons: [],
        requiredPolicyCohorts: [],
      },
    });
    let latest = await current();
    await service.labelItem(latest.id, 'one', keep(latest));
    latest = await current();
    await service.labelItem(latest.id, 'two', keep(latest));
    expect(
      await prisma.commercialQualityPolicyStop.count({
        where: { detectorSourceSha256: candidate.detectorSourceSha256 },
      }),
    ).toBe(0);
  });
});
