import { createHash, randomUUID } from 'node:crypto';
import {
  COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES,
  commercialAiQualityEnvelopeSchema,
  commercialAiQualityResultSchema,
  commercialAiReviewExportResponseSchema,
  type CommercialAiQualityAttempt,
  type CommercialAiQualityResult,
} from '@maxim/contracts/commercial-ai-quality';
import { commercialReviewSemanticAnnotationSchema } from '@maxim/contracts/safety-desk';
import { createPrismaClient, Prisma, type PrismaClient } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  analyzeCommercialAiQualityEvidence,
  commercialAiQualityDigest,
  commercialAiQualityEvidenceSchema,
  commercialAiQualityExpectedIdentity,
} from '../../scripts/commercial-ai-quality-report';
import {
  CommercialAiObservationService,
  COMMERCIAL_AI_OBSERVATION_TTL_MS,
  commercialAiObservationEvidenceHash,
  commercialAiObservationInputSha256,
  type CommercialAiObservationSeed,
} from './commercial-ai-observation.service';
import { CommercialReviewService } from './commercial-review.service';
import { buildCommercialQualitySample } from './commercial-quality-sampling';
import {
  buildCommercialLlmOffer,
  commercialLlmSourceKey,
} from './commercial-llm-enforcement.protocol';
import { COMMERCIAL_LLM_POOL_PROFILES } from './commercial-llm-pool.protocol';
import { COMMERCIAL_LLM_POLICY_VERSION } from './commercial-llm.protocol';

const databaseUrl =
  process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ||
  process.env.MAXIM_TEST_POSTGRES_URL?.trim() ||
  '';
const hex = (digit: string) => digit.repeat(64);
const settings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
  textFiltersWarnEnabled: true,
  textFiltersMuteEnabled: true,
  textFiltersBanEnabled: true,
  textFiltersMuteDurationHours: 1,
  textFiltersBotMessageEnabled: true,
};
const decision: NonNullable<CommercialAiQualityAttempt['actualSynchronousDecision']['decision']> = {
  hasDetection: false,
  actionable: false,
  deleteEligible: false,
  score: 0,
  actionBand: 'ALLOW',
  messageDisposition: 'KEEP',
  detectorVersion: 'synthetic-detector-v1',
  decisionFingerprint: 'synthetic-fingerprint',
  reasons: [],
  requiredPolicyCohorts: [],
};

// FLAG: Disposable PostgreSQL and synthetic evidence only; no MAX/model clients or effects.
(databaseUrl ? describe : describe.skip)(
  'durable active AI observations with native PostgreSQL',
  () => {
    let prisma: PrismaClient;
    let writer: CommercialAiObservationService;
    let review: CommercialReviewService;
    const chatId = `ai-observations-${randomUUID()}`;
    function seed(
      overrides: { text?: string; eventAtMs?: number; messageId?: string } = {},
    ): CommercialAiObservationSeed {
      const now = Date.now();
      const eventAtMs = overrides.eventAtMs ?? now;
      const text = overrides.text ?? 'Соседи, кто знает расписание автобуса?';
      const messageId = overrides.messageId ?? 'synthetic-message';
      const messageCreatedAt = new Date(now - 3600_000).toISOString();
      const offer = buildCommercialLlmOffer(
        {
          chatId,
          messageId,
          userId: 'synthetic-user',
          text,
          eventAt: new Date(eventAtMs).toISOString(),
          originBotId: 'synthetic-bot',
          settings,
          origin: {
            sourceWebhookEventId: 'synthetic-event',
            sourceReceivingBotId: 'synthetic-bot',
            sourceExecutionBotId: 'synthetic-bot',
            sourceEventAtMs: eventAtMs,
            sourceEvidenceVersion: 1,
          },
        },
        now,
        'confirm-positive',
      )!;
      const sample = buildCommercialQualitySample({
        secret: 'synthetic-observation-key-123456789',
        chatId,
        messageId,
        userId: 'synthetic-user',
        text,
        messageCreatedAt,
        source: 'TEXT',
        hasDetection: true,
      })!;
      return {
        candidate: {
          ...sample,
          chatId,
          userId: 'synthetic-user',
          messageId,
          text,
          source: 'TEXT',
          score: 0,
          actionBand: 'NOT_EVALUATED',
          messageDisposition: 'KEEP',
          detectorVersion: 'commercial-ai-asynchronous-v1',
          detectorSourceSha256: hex('a'),
          decisionFingerprint: 'synthetic-observation',
          settingsProfileDigest: hex('b'),
          sourceExcerptComplete: true,
          requiredPolicyCohorts: [],
          reasons: [],
          hasDetection: false,
          deleteEligible: null,
          decisionOutcome: null,
          executionOutcome: 'UNKNOWN',
          analysisOutcome: 'NOT_APPLICABLE',
        },
        request: { ...offer, submittedAtMs: now },
        detectorBaseline: {
          semantics: 'counterfactual_pre_routing_v1',
          detectorSourceSha256: hex('a'),
          decision,
        },
        actualSynchronousDecision: { semantics: 'actual_post_routing_v1', decision },
        activeAuthority: 'AI_DELETE_ONLY',
      };
    }
    const mirror = (input: CommercialAiObservationSeed): CommercialAiObservationSeed => ({
      ...input,
      request: {
        ...input.request,
        source: {
          ...input.request.source,
          nonce: randomUUID(),
          origin: {
            ...input.request.source.origin,
            sourceWebhookEventId: randomUUID(),
            sourceReceivingBotId: 'synthetic-mirror',
          },
        },
      },
    });
    const row = (input: CommercialAiObservationSeed) =>
      prisma.commercialReviewSample.findUniqueOrThrow({
        where: { evidenceHash: commercialAiObservationEvidenceHash(input.request.source) },
        include: { ratings: true },
      });
    const envelope = async (input: CommercialAiObservationSeed) =>
      commercialAiQualityEnvelopeSchema.parse((await row(input)).llmEnforcement);
    const humanRow = (input: CommercialAiObservationSeed) =>
      prisma.commercialReviewSample.findFirstOrThrow({
        where: {
          chatId,
          messageId: input.candidate.messageId,
          llmEnforcement: { equals: Prisma.DbNull },
        },
        include: { ratings: true },
      });
    const exportWindow = () => ({
      since: new Date(Date.now() - 60_000).toISOString(),
      until: new Date(Date.now() + 60_000).toISOString(),
      limit: 50,
    });
    async function reviewedObservation(input: CommercialAiObservationSeed) {
      await review.recordCandidate(input.candidate);
      expect(await writer.seed(input)).toBe('written');
      expect(await writer.update({ ...binding(input), analysis: analysis(input) })).toBe('written');
      for (const actor of ['synthetic-one', 'synthetic-two']) {
        const human = await humanRow(input);
        await review.labelItem(human.id, actor, {
          expectedUpdatedAt: human.updatedAt.toISOString(),
          label: 'NOT_COMMERCIAL',
          expectedDisposition: 'KEEP',
          semanticAnnotation: { version: 1, cohorts: ['BUYER_REQUEST'] },
        });
      }
      return humanRow(input);
    }
    const binding = (input: CommercialAiObservationSeed) => ({
      source: input.request.source,
      inputSha256: commercialAiObservationInputSha256(input.request.excerpt),
    });
    const analysis = (
      input: CommercialAiObservationSeed,
      classification: CommercialAiQualityResult['classification'] = 'NOT_COMMERCIAL',
    ): CommercialAiQualityAttempt['analysis'] => ({
      state: 'COMPLETE',
      classificationOrigin: 'MODEL',
      policyDeleteEligible: classification === 'COMMERCIAL',
      observedAt: new Date(Math.max(Date.now(), input.request.submittedAtMs + 1)).toISOString(),
      reason: null,
      result: {
        ...COMMERCIAL_LLM_POOL_PROFILES['server-9b'].identity,
        classification,
        reasonCodes:
          classification === 'COMMERCIAL'
            ? ['COMMERCIAL_OFFER']
            : classification === 'UNSURE'
              ? ['INSUFFICIENT_CONTEXT']
              : ['ORDINARY_DISCUSSION'],
        policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
        durationMs: 10,
        pool: {
          version: 'commercial-pool-v2',
          nodeId: 'server-9b',
          policy: 'confirm-positive',
          route: 'direct',
          attempts: 1,
        },
      },
    });
    beforeAll(async () => {
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname) ||
        !new URL(databaseUrl).pathname.includes('race_test')
      )
        throw new Error('Disposable race_test PostgreSQL required');
      prisma = createPrismaClient(databaseUrl, { max: 8 });
      await prisma.$connect();
      await prisma.chat.create({ data: { id: chatId, title: 'Synthetic AI observation test' } });
      writer = new CommercialAiObservationService(prisma as unknown as PrismaService);
      review = new CommercialReviewService(prisma as unknown as PrismaService);
    });
    beforeEach(async () => {
      await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
    });
    afterAll(async () => {
      if (!prisma) return;
      await prisma.chat.deleteMany({ where: { id: chatId } });
      await prisma.$disconnect();
    });

    it('serializes concurrent first seeds at one unique row and fixes retention at fourteen days', async () => {
      const input = seed();
      expect((await Promise.all([writer.seed(input), writer.seed(input)])).sort()).toEqual([
        'unchanged',
        'written',
      ]);
      const saved = await row(input);
      expect(saved.expiresAt.getTime() - saved.observedAt.getTime()).toBe(
        COMMERCIAL_AI_OBSERVATION_TTL_MS,
      );
      expect(await prisma.commercialReviewSample.count({ where: { chatId } })).toBe(1);
      expect((await envelope(input)).attempts).toHaveLength(1);
      expect(await writer.seed(input)).toBe('unchanged');
      expect((await row(input)).expiresAt).toEqual(saved.expiresAt);
    });

    it('snapshots score and grouping completeness before asynchronous transaction work', async () => {
      const input = seed();
      input.candidate.score = 35;
      input.candidate.campaignGroupingComplete = true;
      const pending = writer.seed(input);
      input.candidate.score = 99;
      input.candidate.campaignGroupingComplete = false;
      expect(await pending).toBe('written');
      const saved = await row(input);
      expect(saved.score).toBe(0.35);
      expect(saved.evidence).toMatchObject({ score: 35 });
      expect(saved.qualityMetadata).toMatchObject({ campaignGroupingComplete: true });
      expect((await envelope(input)).coverageIncomplete).toBe(false);
    });

    it('groups mirrors while retaining each full source key, but separates edited source revisions', async () => {
      const input = seed();
      const other = mirror(input);
      expect(commercialAiObservationEvidenceHash(other.request.source)).toBe(
        commercialAiObservationEvidenceHash(input.request.source),
      );
      expect(commercialLlmSourceKey(other.request.source)).not.toBe(
        commercialLlmSourceKey(input.request.source),
      );
      await writer.seed(input);
      expect(await writer.seed(other)).toBe('written');
      expect((await envelope(input)).attempts.map((attempt) => attempt.sourceKey)).toEqual([
        commercialLlmSourceKey(input.request.source),
        commercialLlmSourceKey(other.request.source),
      ]);
      const edit = seed({ eventAtMs: input.request.source.eventAtMs + 1 });
      expect(await writer.seed(edit)).toBe('written');
      expect(await prisma.commercialReviewSample.count({ where: { chatId } })).toBe(2);
    });

    it('requires exact original author/text, sanitized input and immutable sampled metadata', async () => {
      const input = seed({ text: 'Кто узнавал номер мастера: +7 999 123-45-67?' });
      expect(input.request.excerpt).not.toBe(input.candidate.text);
      for (const bad of [
        { ...input, candidate: { ...input.candidate, userId: 'different-author' } },
        { ...input, candidate: { ...input.candidate, text: 'Другой исходный текст' } },
        { ...input, request: { ...input.request, excerpt: 'Другой вход модели' } },
        { ...input, candidate: { ...input.candidate, logicalMessageKey: undefined } },
      ])
        expect(await writer.seed(bad)).toBe('invalid');
      expect(await writer.seed(input)).toBe('written');
      expect(
        await writer.seed({
          ...mirror(input),
          candidate: { ...input.candidate, sourceSnapshotSha256: hex('d') },
        }),
      ).toBe('conflict');
      expect((await envelope(input)).attempts).toHaveLength(1);
      expect(JSON.stringify((await row(input)).evidence)).not.toContain('999 123');
    });

    it('never creates or appends attempts from a result or guesses a different input binding', async () => {
      const input = seed();
      expect(await writer.update({ ...binding(input), analysis: analysis(input) })).toBe('missing');
      await writer.seed(input);
      expect(await writer.update({ ...binding(mirror(input)), analysis: analysis(input) })).toBe(
        'missing',
      );
      expect(
        await writer.update({
          ...binding(input),
          inputSha256: hex('d'),
          analysis: analysis(input),
        }),
      ).toBe('missing');
      expect((await envelope(input)).attempts[0]?.analysis.state).toBe('NOT_STARTED');
    });

    it.each(['server-9b', 'pc-a-4b', 'pc-b-9b'] as const)(
      'persists the unmodified actual pool identity from %s including protocol version',
      async (nodeId) => {
        const input = seed({ messageId: `synthetic-${nodeId}` });
        await writer.seed(input);
        const base = analysis(input);
        const result = {
          ...base.result!,
          ...COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity,
          pool: { ...base.result!.pool!, nodeId },
        };
        expect(commercialAiQualityResultSchema.parse(result).protocolVersion).toBe(2);
        expect(
          commercialAiQualityResultSchema.safeParse({ ...result, protocolVersion: 3 }).success,
        ).toBe(false);
        expect(await writer.update({ ...binding(input), analysis: { ...base, result } })).toBe(
          'written',
        );
        expect((await envelope(input)).attempts[0]?.analysis.result?.protocolVersion).toBe(2);
      },
    );

    it('merges actual results with late admission writes without downgrading accepted work', async () => {
      const input = seed();
      await writer.seed(input);
      const complete = analysis(input);
      const results = await Promise.all([
        writer.update({ ...binding(input), analysis: complete }),
        writer.update({
          ...binding(input),
          admission: { state: 'REJECTED', reason: 'DEPENDENCY_UNAVAILABLE' },
        }),
      ]);
      expect(results.every((result) => ['written', 'unchanged'].includes(result))).toBe(true);
      const attempt = (await envelope(input)).attempts[0]!;
      expect(attempt.admission).toEqual({ state: 'ACCEPTED', reason: null });
      expect(attempt.analysis).toEqual(complete);
      expect(
        await writer.update({
          ...binding(input),
          admission: { state: 'REJECTED', reason: 'NOT_ADMITTED' },
        }),
      ).toBe('unchanged');
      expect(await writer.update({ ...binding(input), analysis: analysis(input, 'UNSURE') })).toBe(
        'conflict',
      );
      expect(
        await writer.update({
          ...binding(input),
          analysis: { ...complete, policyDeleteEligible: true },
        }),
      ).toBe('conflict');
    });

    it('preserves human ratings and etags while enriching separate AI and shadow observations', async () => {
      const input = seed();
      await review.recordCandidate(input.candidate);
      await writer.seed(input);
      await prisma.commercialReviewSample.update({
        where: { id: (await row(input)).id },
        data: { llmShadow: { synthetic: true } },
      });
      const before = await row(input);
      expect(
        await writer.update({ ...binding(input), admission: { state: 'ACCEPTED', reason: null } }),
      ).toBe('written');
      expect((await row(input)).updatedAt).toEqual(before.updatedAt);
      const human = await humanRow(input);
      await Promise.all([
        writer.update({ ...binding(input), analysis: analysis(input) }),
        review.labelItem(human.id, 'synthetic-reviewer', {
          expectedUpdatedAt: human.updatedAt.toISOString(),
          label: 'NOT_COMMERCIAL',
          expectedDisposition: 'KEEP',
          reason: 'Синтетический пример',
        }),
      ]);
      const after = await row(input);
      expect(after.ratings).toHaveLength(0);
      expect(after.independentReviewCount).toBe(0);
      expect(after.updatedAt).toEqual(before.updatedAt);
      const reviewed = await humanRow(input);
      expect(reviewed.ratings).toHaveLength(1);
      expect(reviewed.independentReviewCount).toBe(1);
      expect(after.qualityMetadata).toEqual(before.qualityMetadata);
      expect(after.llmShadow).toEqual(before.llmShadow);
      expect(after.observedAt).toEqual(before.observedAt);
      expect(after.expiresAt).toEqual(before.expiresAt);
      expect((after.evidence as Prisma.JsonObject).excerpt).toEqual(
        (before.evidence as Prisma.JsonObject).excerpt,
      );
    });

    it.each(['AGREED', 'COMMERCIAL', 'UNSURE'] as const)(
      'carries exact source-bound human semantics through AI export to the reporter cohort gate after %s blind review',
      async (thirdLabel) => {
        const text = 'Посоветуйте мастера по ремонту холодильника.';
        let input = seed({ text });
        // FLAG: Use actual sampler inclusion; do not fabricate an evaluation-frame flag.
        for (let index = 0; !input.candidate.randomEvaluationIncluded && index < 1000; index += 1) {
          input = seed({ text, messageId: `synthetic-evaluation-${index}` });
        }
        expect(input.candidate.randomEvaluationIncluded).toBe(true);
        await review.recordCandidate(input.candidate);
        expect(await writer.seed(input)).toBe('written');
        expect(await writer.update({ ...binding(input), analysis: analysis(input) })).toBe(
          'written',
        );
        let human = await humanRow(input);
        const observed = await row(input);
        expect(observed.humanReviewEvidenceHash).toBe(human.evidenceHash);
        const blindQueue = await review.getQueue({ status: 'ALL' }, 'synthetic-two');
        expect(blindQueue.items.find((item) => item.id === human.id)).toMatchObject({
          decisionVisible: false,
          evidenceMetadata: null,
          ownReview: null,
        });
        expect(blindQueue.items.some((item) => item.id === observed.id)).toBe(false);
        await expect(
          review.labelItem(observed.id, 'synthetic-one', {
            expectedUpdatedAt: observed.updatedAt.toISOString(),
            label: 'NOT_COMMERCIAL',
            expectedDisposition: 'KEEP',
          }),
        ).rejects.toMatchObject({ status: 404 });
        await review.labelItem(human.id, 'synthetic-one', {
          expectedUpdatedAt: human.updatedAt.toISOString(),
          label: 'NOT_COMMERCIAL',
          expectedDisposition: 'KEEP',
          semanticAnnotation: { version: 1, cohorts: ['BUYER_REQUEST'] },
        });
        expect(
          (await review.exportAiIndependentEvidence(exportWindow(), 'synthetic-two')).items,
        ).toEqual([]);
        human = await humanRow(input);
        await review.labelItem(human.id, 'synthetic-two', {
          expectedUpdatedAt: human.updatedAt.toISOString(),
          label: 'NOT_COMMERCIAL',
          expectedDisposition: 'KEEP',
          semanticAnnotation: {
            version: 1,
            cohorts: [thirdLabel === 'AGREED' ? 'BUYER_REQUEST' : 'NONCOMMERCIAL_HELP'],
          },
        });
        if (thirdLabel !== 'AGREED') {
          human = await humanRow(input);
          const blindThird = (
            await review.getQueue({ status: 'PENDING' }, 'synthetic-three')
          ).items.find((item) => item.id === human.id);
          expect(blindThird).toMatchObject({
            canAdjudicate: true,
            decisionVisible: false,
            label: null,
            ownReview: null,
          });
          expect(
            (await review.exportAiIndependentEvidence(exportWindow(), 'synthetic-three')).items,
          ).toEqual([]);
          const adjudicated = await review.adjudicateItem(human.id, 'synthetic-three', {
            expectedUpdatedAt: human.updatedAt.toISOString(),
            label: thirdLabel,
            expectedDisposition: thirdLabel === 'UNSURE' ? null : 'DELETE',
            semanticAnnotation: { version: 1, cohorts: ['BUYER_REQUEST'] },
          });
          expect(adjudicated).toMatchObject({
            label: 'NOT_COMMERCIAL',
            ownReview: {
              label: thirdLabel,
              expectedDisposition: thirdLabel === 'UNSURE' ? null : 'DELETE',
              kind: 'SEMANTIC_ADJUDICATION',
            },
          });
          expect((await humanRow(input)).semanticReviewState).toBe('RESOLVED');
          expect(
            (await review.getQueue({ status: 'PENDING' }, 'synthetic-four')).items.some(
              (item) => item.id === human.id,
            ),
          ).toBe(false);
        }
        const exported = commercialAiReviewExportResponseSchema.parse(
          await review.exportAiIndependentEvidence(
            exportWindow(),
            thirdLabel === 'AGREED' ? 'synthetic-one' : 'synthetic-three',
          ),
        );
        expect(exported.items).toHaveLength(1);
        const item = exported.items[0]!;
        expect(item.eligibleForIndependentCorpus).toBe(true);
        expect(item.sample.label).toBe('NOT_COMMERCIAL');
        expect(item.sample.id).toBe(human.id);
        expect(item.sample.llmEnforcement).toEqual(await envelope(input));
        const expectedAnnotation = {
          version: 1,
          cohorts: ['BUYER_REQUEST'],
          sourceSnapshotSha256: input.candidate.sourceSnapshotSha256,
          excerptSha256: createHash('sha256').update(item.sample.excerpt, 'utf8').digest('hex'),
        };
        const expectedAnnotations =
          thirdLabel === 'AGREED'
            ? [expectedAnnotation, expectedAnnotation]
            : [
                expectedAnnotation,
                { ...expectedAnnotation, cohorts: ['NONCOMMERCIAL_HELP'] },
                expectedAnnotation,
              ];
        const orderedAnnotations = (values: readonly unknown[]) =>
          values
            .map((value) => commercialReviewSemanticAnnotationSchema.parse(value))
            .sort((left, right) => left.cohorts.join(',').localeCompare(right.cohorts.join(',')));
        expect(orderedAnnotations(item.ratings.map((rating) => rating.semanticAnnotation))).toEqual(
          orderedAnnotations(expectedAnnotations),
        );
        expect(
          orderedAnnotations(
            (await humanRow(input)).ratings.map((rating) => rating.semanticAnnotation),
          ),
        ).toEqual(orderedAnnotations(expectedAnnotations));
        if (thirdLabel !== 'AGREED') {
          expect(
            item.ratings.find((rating) => rating.kind === 'SEMANTIC_ADJUDICATION'),
          ).toMatchObject({
            label: thirdLabel,
            expectedDisposition: thirdLabel === 'UNSURE' ? null : 'DELETE',
          });
        }
        expect((await row(input)).ratings).toHaveLength(0);
        expect(item.sample.requiredPolicyCohorts).toEqual([]);
        // FLAG: Only the reporter's synthetic clock advances past the recorded effect deadline.
        // Persisted timestamps, source facts and the global clock remain unchanged.
        const evaluatedAtMs = Math.max(Date.now(), input.request.source.deadlineAtMs + 1);
        const manifest = {
          ...commercialAiQualityExpectedIdentity('confirm-positive'),
          policyFrozenAt: new Date(evaluatedAtMs - 2 * 86400_000).toISOString(),
          developmentFrameSha256: commercialAiQualityDigest([]),
          holdoutFrameSha256: commercialAiQualityDigest([]),
          requiredProtectedCohorts: ['BUYER_REQUEST'],
        };
        const report = analyzeCommercialAiQualityEvidence(
          commercialAiQualityEvidenceSchema.parse({
            schemaVersion: 'commercial-ai-quality-evidence/v1',
            mode: 'INDEPENDENT_REVIEW',
            evaluatedAt: new Date(evaluatedAtMs).toISOString(),
            holdout: [{ cursor: null, response: exported }],
            manifest,
            manifestSha256: commercialAiQualityDigest(manifest),
          }),
          { now: evaluatedAtMs },
        );
        expect(report.independentPolicyQuality.requiredProtectedCohorts).toMatchObject([
          { cohort: 'BUYER_REQUEST', protectedUnits: 1, unsafePermissions: 0, criteriaPass: false },
        ]);
        expect(report.provenanceErrors).not.toContain(
          'source_bound_semantic_review_missing_or_invalid',
        );
        expect(report.provenanceErrors).not.toContain('required_protected_cohort_evidence_missing');
        expect(report.provenanceErrors).not.toContain('independent_human_review_evidence_missing');
        expect(
          report.independentClassification.finalClassificationCountsByDeclaredHumanLabel,
        ).toEqual({
          COMMERCIAL: {},
          NOT_COMMERCIAL: { NOT_COMMERCIAL: 1 },
        });
        expect(report.independentPolicyQuality.criteriaPass).toBe(false);
        expect(report.promotionAuthorized).toBe(false);
      },
    );

    it.each(['CORRUPT', 'EXPIRED', 'AMBIGUOUS_EXPIRED'] as const)(
      'retains the human review but reports the exact AI linkage gap: %s',
      async (gap) => {
        const input = seed({ text: 'Посоветуйте мастера по ремонту холодильника.' });
        const human = await reviewedObservation(input);
        const observed = await row(input);
        if (gap === 'CORRUPT') {
          await prisma.commercialReviewSample.update({
            where: { id: observed.id },
            data: { llmEnforcement: { schemaVersion: 1, captureState: 'OBSERVED', attempts: [] } },
          });
        } else if (gap === 'EXPIRED') {
          await prisma.commercialReviewSample.update({
            where: { id: observed.id },
            data: { expiresAt: new Date(0) },
          });
        } else {
          await prisma.commercialReviewSample.create({
            data: {
              chatId,
              userId: observed.userId,
              messageId: observed.messageId,
              source: observed.source,
              evidenceHash: createHash('sha256').update(randomUUID()).digest('hex'),
              humanReviewEvidenceHash: human.evidenceHash,
              score: observed.score,
              evidence: observed.evidence as Prisma.InputJsonValue,
              qualityMetadata: observed.qualityMetadata as Prisma.InputJsonValue,
              llmEnforcement: observed.llmEnforcement as Prisma.InputJsonValue,
              expiresAt: new Date(0),
            },
          });
        }
        const exported = await review.exportAiIndependentEvidence(exportWindow(), 'synthetic-one');
        expect(exported.items).toHaveLength(1);
        expect(exported.items[0]?.sample.id).toBe(human.id);
        expect(exported.items[0]?.eligibleForIndependentCorpus).toBe(true);
        expect(exported.items[0]?.sample.llmEnforcement).toEqual(
          gap === 'EXPIRED'
            ? null
            : { schemaVersion: 1, captureState: 'INVALID', coverageIncomplete: true },
        );
      },
    );

    it('does not export expired human evidence even when its linked AI observation remains retained', async () => {
      const input = seed({ text: 'Посоветуйте мастера по ремонту холодильника.' });
      const human = await reviewedObservation(input);
      await prisma.commercialReviewSample.update({
        where: { id: human.id },
        data: { expiresAt: new Date(0) },
      });
      expect((await row(input)).expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(
        (await review.exportAiIndependentEvidence(exportWindow(), 'synthetic-one')).items,
      ).toEqual([]);
    });

    it('retains durable registration/receipt facts across later weaker observations', async () => {
      const input = seed();
      await writer.seed(input);
      expect(
        await writer.update({
          ...binding(input),
          analysis: analysis(input, 'COMMERCIAL'),
          registration: { state: 'REGISTERED', intentIdSha256: hex('c'), reason: null },
          execution: {
            state: 'CONFIRMED_DELETE',
            receiptSha256: hex('d'),
            observedAt: new Date().toISOString(),
          },
        }),
      ).toBe('written');
      expect(
        await writer.update({
          ...binding(input),
          registration: {
            state: 'UNKNOWN',
            intentIdSha256: null,
            reason: 'DEPENDENCY_UNAVAILABLE',
          },
          execution: {
            state: 'UNKNOWN',
            receiptSha256: null,
            observedAt: new Date().toISOString(),
          },
        }),
      ).toBe('unchanged');
      expect(
        await writer.update({
          ...binding(input),
          execution: {
            state: 'CONFIRMED_DELETE',
            receiptSha256: hex('e'),
            observedAt: new Date().toISOString(),
          },
        }),
      ).toBe('conflict');
      expect((await envelope(input)).attempts[0]?.execution.receiptSha256).toBe(hex('d'));
    });

    it('accepts cumulative registration before delayed analysis and admission writes', async () => {
      const input = seed();
      await writer.seed(input);
      const complete = analysis(input, 'COMMERCIAL');
      const registeredAt = new Date().toISOString();
      expect(
        await writer.update({
          ...binding(input),
          analysis: complete,
          registration: { state: 'REGISTERED', intentIdSha256: hex('c'), reason: null },
          execution: { state: 'PENDING', receiptSha256: null, observedAt: registeredAt },
        }),
      ).toBe('written');
      expect(
        await writer.update({
          ...binding(input),
          analysis: {
            ...complete,
            observedAt: new Date(Date.parse(complete.observedAt!) + 1).toISOString(),
          },
        }),
      ).toBe('unchanged');
      expect(
        await writer.update({
          ...binding(input),
          admission: { state: 'REJECTED', reason: 'DEPENDENCY_UNAVAILABLE' },
        }),
      ).toBe('unchanged');
      const saved = (await envelope(input)).attempts[0]!;
      expect(saved.admission).toEqual({ state: 'ACCEPTED', reason: null });
      expect(saved.analysis).toEqual(complete);
      expect(saved.registration.intentIdSha256).toBe(hex('c'));
      expect(saved.execution).toEqual({
        state: 'PENDING',
        receiptSha256: null,
        observedAt: registeredAt,
      });
    });

    it('does not renew expired rows or recreate them when result writes race cleanup', async () => {
      const input = seed();
      await writer.seed(input);
      const initial = await row(input);
      await prisma.commercialReviewSample.update({
        where: { id: initial.id },
        data: { expiresAt: new Date(0) },
      });
      expect(await writer.seed(input)).toBe('expired');
      expect(await writer.update({ ...binding(input), analysis: analysis(input) })).toBe('expired');
      expect((await row(input)).expiresAt.getTime()).toBe(0);
      await Promise.all([
        review.pruneExpired(),
        writer.update({ ...binding(input), analysis: analysis(input) }),
      ]);
      expect(
        await prisma.commercialReviewSample.findUnique({ where: { id: initial.id } }),
      ).toBeNull();
      expect(await writer.update({ ...binding(input), analysis: analysis(input) })).toBe('missing');
    });

    it('caps nonce attempts at eight and records overflow without extending retention', async () => {
      const input = seed();
      await writer.seed(input);
      const before = await row(input);
      for (let i = 1; i < 8; i++) expect(await writer.seed(mirror(input))).toBe('written');
      expect(await writer.seed(mirror(input))).toBe('overflow');
      const saved = await envelope(input);
      expect(saved.attempts).toHaveLength(8);
      expect(saved.overflowWriteCount).toBe(1);
      expect(saved.coverageIncomplete).toBe(true);
      expect(saved.lastOverflowAt).not.toBeNull();
      expect((await row(input)).expiresAt).toEqual(before.expiresAt);
    });

    it('enforces the independent JSON byte cap and marks dropped attempts explicitly', async () => {
      const input = seed();
      const codes = Array.from(
        { length: 32 },
        (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(118)}`,
      );
      const large = { ...decision, reasons: codes, requiredPolicyCohorts: codes };
      input.detectorBaseline = { ...input.detectorBaseline!, decision: large };
      input.actualSynchronousDecision = { ...input.actualSynchronousDecision, decision: large };
      expect(await writer.seed(input)).toBe('written');
      const outcomes = [];
      for (let i = 1; i < 8; i++) outcomes.push(await writer.seed(mirror(input)));
      expect(outcomes).toContain('overflow');
      const saved = await envelope(input);
      expect(saved.attempts.length).toBeLessThan(8);
      expect(Buffer.byteLength(JSON.stringify(saved), 'utf8')).toBeLessThanOrEqual(
        COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES,
      );
      expect(saved.coverageIncomplete).toBe(true);
    });

    it('leaves malformed or mismatched stored bindings untouched', async () => {
      const input = seed();
      await writer.seed(input);
      const saved = await row(input);
      await prisma.commercialReviewSample.update({
        where: { id: saved.id },
        data: {
          qualityMetadata: {
            ...(saved.qualityMetadata as Prisma.JsonObject),
            sourceSnapshotSha256: hex('d'),
          },
        },
      });
      expect(await writer.update({ ...binding(input), analysis: analysis(input) })).toBe(
        'conflict',
      );
      await prisma.commercialReviewSample.update({
        where: { id: saved.id },
        data: { llmEnforcement: { malformed: true } },
      });
      expect(await writer.update({ ...binding(input), analysis: analysis(input) })).toBe('invalid');
      expect((await row(input)).llmEnforcement).toEqual({ malformed: true });
    });

    it('bounds a locked-row write and keeps the unchanged observation for later collection', async () => {
      const input = seed();
      await writer.seed(input);
      const before = await row(input);
      let locked!: () => void, release!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locker = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT id FROM commercial_review_samples WHERE id = ${before.id} FOR UPDATE`;
          locked();
          await gate;
        },
        { timeout: 5000 },
      );
      await acquired;
      const startedAt = Date.now();
      try {
        expect(await writer.update({ ...binding(input), analysis: analysis(input) })).toBe(
          'unavailable',
        );
        expect(Date.now() - startedAt).toBeLessThan(2000);
      } finally {
        release();
        await locker;
      }
      expect((await row(input)).llmEnforcement).toEqual(before.llmEnforcement);
    });

    it('uses the unique evidence index in representative retained history', async () => {
      const input = seed();
      await writer.seed(input);
      await prisma.commercialReviewSample.createMany({
        data: Array.from({ length: 2500 }, (_, i) => ({
          chatId,
          userId: 'synthetic-history',
          messageId: `retained-${i}`,
          source: 'TEXT',
          evidenceHash: `${chatId}-retained-${i}`,
          score: 0,
          evidence: {},
          observedAt: new Date(Date.now() - 86400_000),
          expiresAt: new Date(Date.now() + 86400_000),
        })),
      });
      const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        'EXPLAIN (COSTS OFF) SELECT id FROM commercial_review_samples WHERE evidence_hash = $1 FOR UPDATE',
        commercialAiObservationEvidenceHash(input.request.source),
      );
      expect(plan.map((line) => line['QUERY PLAN']).join('\n')).toContain(
        'commercial_review_samples_evidence_hash_key',
      );
      const linkagePlan = await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`
        EXPLAIN (COSTS OFF)
        WITH linked AS MATERIALIZED (
          SELECT id, evidence, quality_metadata, llm_enforcement
          FROM commercial_review_samples
          WHERE human_review_evidence_hash = ${(await row(input)).humanReviewEvidenceHash}
          ORDER BY observed_at DESC, id DESC LIMIT 2
        ) SELECT evidence ->> 'excerpt' FROM linked
      `);
      const linkagePlanText = linkagePlan.map((line) => line['QUERY PLAN']).join('\n');
      expect(linkagePlanText).toContain('commercial_review_samples_human_evidence_idx');
      expect(linkagePlanText).toContain('Limit');
      expect(linkagePlanText).not.toContain('Seq Scan on commercial_review_samples');
      expect(
        await writer.update({ ...binding(input), admission: { state: 'ACCEPTED', reason: null } }),
      ).toBe('written');
    });
  },
);
