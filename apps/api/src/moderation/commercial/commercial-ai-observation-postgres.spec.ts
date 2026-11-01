import { randomUUID } from 'node:crypto';
import {
  COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES,
  commercialAiQualityEnvelopeSchema,
  commercialAiQualityResultSchema,
  type CommercialAiQualityAttempt,
  type CommercialAiQualityResult,
} from '@maxim/contracts/commercial-ai-quality';
import { createPrismaClient, type PrismaClient, type Prisma } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
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

    it('preserves ratings, review etags, original evidence and separate shadow observations', async () => {
      const input = seed();
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
      await Promise.all([
        writer.update({ ...binding(input), analysis: analysis(input) }),
        review.labelItem(before.id, 'synthetic-reviewer', {
          expectedUpdatedAt: before.updatedAt.toISOString(),
          label: 'NOT_COMMERCIAL',
          expectedDisposition: 'KEEP',
          reason: 'Синтетический пример',
        }),
      ]);
      const after = await row(input);
      expect(after.ratings).toHaveLength(1);
      expect(after.independentReviewCount).toBe(1);
      expect(after.qualityMetadata).toEqual(before.qualityMetadata);
      expect(after.llmShadow).toEqual(before.llmShadow);
      expect(after.observedAt).toEqual(before.observedAt);
      expect(after.expiresAt).toEqual(before.expiresAt);
      expect((after.evidence as Prisma.JsonObject).excerpt).toEqual(
        (before.evidence as Prisma.JsonObject).excerpt,
      );
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
      expect(
        await writer.update({ ...binding(input), admission: { state: 'ACCEPTED', reason: null } }),
      ).toBe('written');
    });
  },
);
